/**
 * RedisStateStore - Full Implementation
 *
 * Redis backend for COSMO clustering with CRDT support.
 * Phase B-R: Redis State Store + CRDT Merge
 */

const Redis = require('ioredis');
const { pack, unpack } = require('msgpackr');
const zlib = require('zlib');
const { promisify } = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { CRDTMerger } = require('./crdt-merger');
const { IdempotencyTracker } = require('../idempotency-tracker');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class RedisStateStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.instanceId = config.instanceId || 'cosmo-1';
    
    // Redis client
    this.client = null;
    this.subscriber = null; // For pub/sub
    
    // CRDT merger
    this.crdtMerger = new CRDTMerger(logger);
    
    // Idempotency
    this.idempotency = new IdempotencyTracker(logger);
    
    // Lua scripts (loaded on connect)
    this.luaScripts = {
      applyMerge: null,
      goalClaim: null,
      leaderRenew: null
    };
    
    // Config
    this.compressionThreshold = config.stateStore?.compressionThreshold || 102400; // 100KB
    this.configHash = null;
  }

  /**
   * Connect to Redis backend
   */
  async connect() {
    try {
      const stateStoreConfig = this.config.stateStore || {};
      const url = stateStoreConfig.url || 'redis://localhost:6379';
      
      // Parse Redis options
      const redisOptions = {
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.error('[RedisStateStore] Max retry attempts reached');
            return null; // Stop retrying
          }
          return Math.min(times * 100, 3000); // Exponential backoff, max 3s
        }
      };
      
      // TLS support
      if (url.startsWith('rediss://')) {
        redisOptions.tls = {};
      }
      
      // Create Redis client
      this.client = new Redis(url, redisOptions);
      
      // Error handling
      this.client.on('error', (error) => {
        this.logger.error('[RedisStateStore] Redis error', { error: error.message });
      });
      
      this.client.on('connect', () => {
        this.logger.info('[RedisStateStore] Connected to Redis');
      });
      
      this.client.on('ready', () => {
        this.logger.info('[RedisStateStore] Redis ready');
      });
      
      // Connect
      await this.client.connect();
      
      // Load Lua scripts
      await this.loadLuaScripts();
      
      // Create subscriber client for pub/sub
      this.subscriber = this.client.duplicate();
      await this.subscriber.connect();
      
      this.logger.info('[RedisStateStore] Connection established', {
        url: url.replace(/\/\/.*@/, '//<credentials>@') // Hide credentials
      });
      
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] Connection failed', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Load Lua scripts into Redis
   */
  async loadLuaScripts() {
    try {
      const luaDir = path.join(__dirname, '../lua');
      
      // Load apply_merge.lua
      const applyMergeScript = await fs.readFile(
        path.join(luaDir, 'apply_merge.lua'),
        'utf8'
      );
      this.luaScripts.applyMerge = await this.client.script('LOAD', applyMergeScript);
      
      // Load goal_claim.lua
      const goalClaimScript = await fs.readFile(
        path.join(luaDir, 'goal_claim.lua'),
        'utf8'
      );
      this.luaScripts.goalClaim = await this.client.script('LOAD', goalClaimScript);
      
      // Load leader_renew.lua
      const leaderRenewScript = await fs.readFile(
        path.join(luaDir, 'leader_renew.lua'),
        'utf8'
      );
      this.luaScripts.leaderRenew = await this.client.script('LOAD', leaderRenewScript);
      
      this.logger.info('[RedisStateStore] Lua scripts loaded', {
        applyMerge: this.luaScripts.applyMerge,
        goalClaim: this.luaScripts.goalClaim,
        leaderRenew: this.luaScripts.leaderRenew
      });
    } catch (error) {
      this.logger.error('[RedisStateStore] Failed to load Lua scripts', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    this.logger.info('[RedisStateStore] Disconnected');
  }

  /**
   * Store memory node with LWW CRDT
   */
  async setMemory(nodeId, value, versionVector, ttl) {
    const key = `cosmo:memory:${nodeId}`;
    
    try {
      // Get existing value (if any)
      const existing = await this.getMemory(nodeId);
      
      // Prepare new value with metadata
      const newValue = {
        value,
        versionVector,
        timestamp: Date.now(),
        sourceInstance: this.instanceId
      };
      
      // CRDT merge if existing
      let merged = newValue;
      if (existing) {
        merged = this.crdtMerger.mergeLWW(existing, newValue);
      }
      
      // Serialize with MessagePack
      let serialized = pack(merged);
      
      // Compress if over threshold
      if (serialized.length > this.compressionThreshold) {
        serialized = await gzip(serialized);
        merged._compressed = true;
      }
      
      // Store in Redis
      if (ttl) {
        await this.client.setex(key, Math.floor(ttl / 1000), serialized);
      } else {
        await this.client.set(key, serialized);
      }
      
      return merged;
    } catch (error) {
      this.logger.error('[RedisStateStore] setMemory error', {
        nodeId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Retrieve memory node
   */
  async getMemory(nodeId) {
    const key = `cosmo:memory:${nodeId}`;
    
    try {
      const data = await this.client.getBuffer(key);
      if (!data) return null;
      
      // Try to unpack (might be compressed)
      try {
        const unpacked = unpack(data);
        return unpacked;
      } catch (error) {
        // Might be compressed, try gunzip first
        const uncompressed = await gunzip(data);
        const unpacked = unpack(uncompressed);
        return unpacked;
      }
    } catch (error) {
      if (error.message.includes('not found')) {
        return null;
      }
      this.logger.error('[RedisStateStore] getMemory error', {
        nodeId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Submit diff for cycle
   */
  async submitDiff(cycle, instanceId, diff) {
    const key = `cosmo:diff:${cycle}:${instanceId}`;

    try {
      // Ensure diff has diff_id
      if (!diff.diff_id) {
        diff.diff_id = this.idempotency.generateDiffId(instanceId, cycle);
      }
      
      // Check if already applied (idempotency)
      if (this.idempotency.isApplied(diff.diff_id)) {
        this.logger.warn('[RedisStateStore] Diff already applied', {
          diff_id: diff.diff_id
        });
        return false;
      }
      
      // Serialize
      let serialized = pack(diff);
      
      // Compress if large
      if (serialized.length > this.compressionThreshold) {
        serialized = await gzip(serialized);
        diff._compressed = true;
      }
      
      // Store diff as hash
      await this.client.hmset(key, {
        diff_id: diff.diff_id,
        instanceId: instanceId,
        cycle: cycle.toString(),
        data: serialized,
        timestamp: Date.now().toString()
      });
      
      // Set TTL (cleanup after cycle completes)
      await this.client.expire(key, 3600); // 1 hour
      
      this.logger.info('[RedisStateStore] Diff submitted', {
        cycle,
        instanceId,
        diff_id: diff.diff_id,
        size: serialized.length
      });

      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] submitDiff error', {
        cycle,
        instanceId,
        error: error.message
      });
      throw error;
    }
  }

  async fetchDiffs(cycle) {
    const pattern = `cosmo:diff:${cycle}:*`;
    const diffKeys = await this.scanKeys(pattern);
    const diffs = [];

    for (const key of diffKeys) {
      try {
        const [instanceId, diffId, timestampStr] = await this.client.hmget(
          key,
          'instanceId',
          'diff_id',
          'timestamp'
        );
        const dataBuffer = await this.client.hgetBuffer(key, 'data');
        if (!dataBuffer) {
          continue;
        }

        let diff;
        try {
          diff = unpack(dataBuffer);
        } catch (error) {
          try {
            const uncompressed = await gunzip(dataBuffer);
            diff = unpack(uncompressed);
          } catch (unpackError) {
            this.logger.error('[RedisStateStore] Diff unpack failed', {
              key,
              error: unpackError.message
            });
            continue;
          }
        }

        diffs.push({
          key,
          diff,
          diffId: diff?.diff_id || diffId,
          instanceId,
          timestamp: Number(timestampStr) || Date.now()
        });
      } catch (error) {
        this.logger.error('[RedisStateStore] fetchDiffs error', {
          key,
          error: error.message
        });
      }
    }

    return diffs;
  }

  async setMergedState(cycle, mergedState) {
    const key = `cosmo:merged:${cycle}`;

    try {
      let serialized = pack(mergedState);

      if (serialized.length > this.compressionThreshold) {
        serialized = await gzip(serialized);
      }

      // Store merged snapshot with TTL (1 hour)
      await this.client.set(key, serialized, 'EX', 3600);
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] setMergedState error', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  async acknowledgeDiffs(cycle, diffs) {
    for (const entry of diffs) {
      const diffId = entry.diffId || entry.diff?.diff_id;
      if (diffId) {
        this.idempotency.markApplied(diffId, {
          cycle,
          instanceId: entry.instanceId,
          timestamp: entry.timestamp
        });
      }

      if (entry.key) {
        try {
          await this.client.del(entry.key);
        } catch (error) {
          this.logger.error('[RedisStateStore] acknowledgeDiffs delete error', {
            key: entry.key,
            error: error.message
          });
        }
      }
    }
  }

  /**
   * Get merged state after leader applies diffs
   */
  async getMergedState(cycle) {
    const key = `cosmo:merged:${cycle}`;
    
    try {
      const data = await this.client.getBuffer(key);
      if (!data) return null;
      
      // Deserialize (handle compression)
      try {
        return unpack(data);
      } catch (error) {
        const uncompressed = await gunzip(data);
        return unpack(uncompressed);
      }
    } catch (error) {
      this.logger.error('[RedisStateStore] getMergedState error', {
        cycle,
        error: error.message
      });
      return null;
    }
  }

  async scanKeys(pattern) {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, results] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (Array.isArray(results) && results.length > 0) {
        keys.push(...results);
      }
    } while (cursor !== '0');
    return keys;
  }

  /**
   * Claim goal atomically using Lua script
   */
  async claimGoal(goalId, instanceId, ttlMs) {
    const key = `cosmo:goal:${goalId}`;
    
    try {
      const result = await this.client.evalsha(
        this.luaScripts.goalClaim,
        1, // number of keys
        key, // KEYS[1]
        instanceId, // ARGV[1]
        ttlMs.toString(), // ARGV[2]
        Date.now().toString() // ARGV[3]
      );
      
      return result === 1;
    } catch (error) {
      this.logger.error('[RedisStateStore] claimGoal error', {
        goalId,
        instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Mark goal completed
   */
  async completeGoal(goalId) {
    const key = `cosmo:goal:${goalId}`;
    
    try {
      await this.client.hmset(key, {
        completed: 'true',
        completed_at: Date.now().toString(),
        completed_by: this.instanceId
      });
      
      this.logger.info('[RedisStateStore] Goal completed', { goalId });
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] completeGoal error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  async releaseGoal(goalId, instanceId) {
    const key = `cosmo:goal:${goalId}`;

    try {
      const claimedBy = await this.client.hget(key, 'claimed_by');
      if (claimedBy && instanceId && claimedBy !== instanceId) {
        this.logger.warn('[RedisStateStore] releaseGoal denied (owner mismatch)', {
          goalId,
          requestedBy: instanceId,
          claimedBy
        });
        return false;
      }

      await this.client.hdel(key, 'claimed_by', 'claim_expires', 'last_claimed_at');
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] releaseGoal error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Append to immutable journal (Redis Stream)
   */
  async appendJournal(entry) {
    try {
      // Add to Redis Stream (partitioned by day)
      const streamKey = `cosmo:journal:${this.getDateKey()}`;
      
      const entryWithMetadata = {
        ...entry,
        sourceInstance: this.instanceId,
        timestamp: Date.now().toString()
      };
      
      await this.client.xadd(
        streamKey,
        '*', // Auto-generate ID
        ...this.flattenObject(entryWithMetadata)
      );
      
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] appendJournal error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get journal entries (range query)
   */
  async getJournal(startCycle, endCycle) {
    try {
      // Query might span multiple days
      const entries = [];
      
      // For now, query current day's stream
      const streamKey = `cosmo:journal:${this.getDateKey()}`;
      
      const results = await this.client.xrange(streamKey, '-', '+');
      
      // Filter by cycle range
      for (const [id, fields] of results) {
        const entry = this.unflattenObject(fields);
        const cycle = parseInt(entry.cycle || '0');
        if (cycle >= startCycle && cycle <= endCycle) {
          entries.push({ id, ...entry });
        }
      }
      
      return entries;
    } catch (error) {
      this.logger.error('[RedisStateStore] getJournal error', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Validate configuration hash
   */
  async validateConfigHash(configHash) {
    try {
      const stored = await this.client.get('cosmo:config:hash');
      
      if (!stored) {
        // First instance: store hash
        await this.setConfigHash(configHash);
        return true;
      }
      
      // Compare hashes
      if (stored !== configHash) {
        this.logger.error('[RedisStateStore] Config hash mismatch', {
          expected: stored,
          provided: configHash
        });
        return false;
      }
      
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] validateConfigHash error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Store configuration hash
   */
  async setConfigHash(configHash) {
    try {
      await this.client.set('cosmo:config:hash', configHash);
      this.configHash = configHash;
      this.logger.info('[RedisStateStore] Config hash stored', { hash: configHash.substring(0, 16) });
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] setConfigHash error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Set instance health beacon
   */
  async setHealthBeacon(instanceId, health) {
    const key = `cosmo:health:${instanceId}`;
    
    try {
      await this.client.hmset(key, {
        cycle: health.cycle?.toString() || '0',
        memoryHash: health.memoryHash || '',
        ramUsage: health.ramUsage?.toString() || '0',
        errorCount: health.errorCount?.toString() || '0',
        timestamp: Date.now().toString()
      });
      
      // Set TTL (2x failure timeout)
      const ttl = (this.config.failureThreshold || 3) * (this.config.healthCheckInterval || 3000) * 2 / 1000;
      await this.client.expire(key, Math.ceil(ttl));
      
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] setHealthBeacon error', {
        instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get instance health beacon
   */
  async getHealthBeacon(instanceId) {
    const key = `cosmo:health:${instanceId}`;
    
    try {
      const health = await this.client.hgetall(key);
      if (!health || Object.keys(health).length === 0) {
        return null;
      }
      
      return {
        cycle: parseInt(health.cycle || '0'),
        memoryHash: health.memoryHash,
        ramUsage: parseFloat(health.ramUsage || '0'),
        errorCount: parseInt(health.errorCount || '0'),
        timestamp: parseInt(health.timestamp || '0')
      };
    } catch (error) {
      this.logger.error('[RedisStateStore] getHealthBeacon error', {
        instanceId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get all health beacons
   */
  async getAllHealthBeacons() {
    try {
      const keys = await this.client.keys('cosmo:health:*');
      const beacons = {};
      
      for (const key of keys) {
        const instanceId = key.replace('cosmo:health:', '');
        beacons[instanceId] = await this.getHealthBeacon(instanceId);
      }
      
      return beacons;
    } catch (error) {
      this.logger.error('[RedisStateStore] getAllHealthBeacons error', {
        error: error.message
      });
      return {};
    }
  }

  /**
   * Acquire leadership (fencing token model)
   */
  async acquireLeadership() {
    try {
      const leaseMs = this.config.orchestrator?.leaderLeaseMs || 15000;
      
      // Increment epoch (monotonic counter = fencing token)
      const token = await this.client.incr('cosmo:leader:epoch');
      
      // Try to acquire leader lock
      const acquired = await this.client.set(
        'cosmo:leader:holder',
        this.instanceId,
        'PX',
        leaseMs,
        'NX' // Only set if not exists
      );
      
      if (acquired) {
        // Store token
        await this.client.set('cosmo:leader:token', token.toString(), 'PX', leaseMs);
        
        this.logger.info('[RedisStateStore] Leadership acquired', {
          instanceId: this.instanceId,
          token,
          leaseMs
        });
        
        return token;
      }
      
      return null;
    } catch (error) {
      this.logger.error('[RedisStateStore] acquireLeadership error', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Renew leadership lease (via Lua script for atomicity)
   */
  async renewLeadership(token) {
    try {
      const leaseMs = this.config.orchestrator?.leaderLeaseMs || 15000;
      
      const result = await this.client.evalsha(
        this.luaScripts.leaderRenew,
        0, // no keys
        token.toString(),
        leaseMs.toString(),
        Date.now().toString()
      );
      
      if (result === 1) {
        this.logger.debug('[RedisStateStore] Leadership renewed', { token });
        return true;
      }
      
      this.logger.warn('[RedisStateStore] Leadership renewal failed (token mismatch)', { token });
      return false;
    } catch (error) {
      this.logger.error('[RedisStateStore] renewLeadership error', {
        token,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Release leadership
   */
  async releaseLeadership() {
    try {
      await this.client.del('cosmo:leader:holder', 'cosmo:leader:token');
      this.logger.info('[RedisStateStore] Leadership released');
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] releaseLeadership error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Mark instance as ready for cycle barrier
   */
  async markReady(cycle, instanceId) {
    const key = `cosmo:ready:${cycle}`;
    
    try {
      await this.client.sadd(key, instanceId);
      
      // Set TTL on ready set
      const syncTimeout = this.config.syncTimeout || 60000;
      await this.client.expire(key, Math.ceil((syncTimeout + 30000) / 1000));
      
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] markReady error', {
        cycle,
        instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get ready count for cycle barrier
   */
  async getReadyCount(cycle) {
    const key = `cosmo:ready:${cycle}`;
    
    try {
      return await this.client.scard(key);
    } catch (error) {
      this.logger.error('[RedisStateStore] getReadyCount error', {
        cycle,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Publish sync signal (cycle proceed)
   */
  async publishSyncSignal(cycle) {
    try {
      await this.client.publish('cosmo:cluster:sync', JSON.stringify({
        cycle,
        timestamp: Date.now(),
        leader: this.instanceId
      }));
      
      this.logger.info('[RedisStateStore] Sync signal published', { cycle });
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] publishSyncSignal error', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Subscribe to sync signals
   */
  async subscribeSyncSignal(callback) {
    try {
      await this.subscriber.subscribe('cosmo:cluster:sync');
      
      this.subscriber.on('message', (channel, message) => {
        if (channel === 'cosmo:cluster:sync') {
          try {
            const signal = JSON.parse(message);
            callback(signal);
          } catch (error) {
            this.logger.error('[RedisStateStore] Sync signal parse error', {
              error: error.message
            });
          }
        }
      });
      
      this.logger.info('[RedisStateStore] Subscribed to sync signals');
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] subscribeSyncSignal error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Publish heartbeat
   */
  async publishHeartbeat(beacon) {
    try {
      const serialized = pack(beacon);
      await this.client.publish('cosmo:cluster:heartbeats', serialized);
      return true;
    } catch (error) {
      // Don't log every heartbeat error (too noisy)
      return false;
    }
  }

  /**
   * Subscribe to heartbeats
   */
  async subscribeHeartbeats(callback) {
    try {
      await this.subscriber.subscribe('cosmo:cluster:heartbeats');
      
      this.subscriber.on('message', (channel, message) => {
        if (channel === 'cosmo:cluster:heartbeats') {
          try {
            const beacon = unpack(Buffer.from(message, 'binary'));
            callback(beacon);
          } catch (error) {
            this.logger.error('[RedisStateStore] Heartbeat parse error', {
              error: error.message
            });
          }
        }
      });
      
      this.logger.info('[RedisStateStore] Subscribed to heartbeats');
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] subscribeHeartbeats error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Helper: Get date key for journal partitioning
   */
  getDateKey() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  }

  /**
   * Helper: Flatten object for Redis XADD
   */
  flattenObject(obj) {
    const flattened = [];
    for (const [key, value] of Object.entries(obj)) {
      flattened.push(key);
      flattened.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return flattened;
  }

  /**
   * Helper: Unflatten object from Redis XRANGE
   */
  unflattenObject(fields) {
    const obj = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      let value = fields[i + 1];
      
      // Try to parse JSON
      try {
        value = JSON.parse(value);
      } catch (error) {
        // Keep as string
      }
      
      obj[key] = value;
    }
    return obj;
  }

  /**
   * Calculate SHA256 hash
   */
  calculateConfigHash(config) {
    const configString = JSON.stringify(config, Object.keys(config).sort());
    return crypto.createHash('sha256').update(configString).digest('hex');
  }

  /**
   * Record review readiness for this instance.
   */
  async recordReviewReadiness(cycle, instanceId, payload) {
    const readyKey = `cosmo:reviews:cycle:${cycle}:ready`;
    try {
      const record = {
        instanceId,
        timestamp: Date.now(),
        payload
      };
      await this.client.hset(readyKey, instanceId, JSON.stringify(record));
      const ttlMs = Math.max(
        (this.config.coordinator?.barrierTtlMs) || 600000,
        (this.config.coordinator?.timeoutMs) || 60000
      );
      await this.client.pexpire(readyKey, ttlMs);
      return record;
    } catch (error) {
      this.logger.error('[RedisStateStore] recordReviewReadiness error', {
        cycle,
        instanceId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Await readiness quorum or timeout.
   */
  async awaitReviewBarrier(cycle, quorum, timeoutMs) {
    const readyKey = `cosmo:reviews:cycle:${cycle}:ready`;
    const pollInterval = 500;
    const start = Date.now();
    let readyInstances = [];

    while (true) {
      try {
        const entries = await this.client.hgetall(readyKey);
        readyInstances = [];

        for (const [key, value] of Object.entries(entries || {})) {
          try {
            const parsed = JSON.parse(value);
            readyInstances.push({
              instanceId: parsed.instanceId || key,
              timestamp: parsed.timestamp || Date.now()
            });
          } catch (err) {
            readyInstances.push({
              instanceId: key,
              timestamp: Date.now()
            });
          }
        }

        const readyCount = readyInstances.length;
        const durationMs = Date.now() - start;

        if (readyCount >= quorum) {
          return {
            status: 'proceed',
            readyCount,
            quorum,
            readyInstances: [...readyInstances],
            durationMs
          };
        }

        if (durationMs >= timeoutMs) {
          return {
            status: 'timeout',
            readyCount,
            quorum,
            readyInstances: [...readyInstances],
            durationMs
          };
        }
      } catch (error) {
        this.logger.error('[RedisStateStore] awaitReviewBarrier error', {
          cycle,
          error: error.message
        });
        return {
          status: 'error',
          readyCount: readyInstances.length,
          quorum,
          readyInstances: [...readyInstances],
          durationMs: Date.now() - start,
          error: error.message
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Persist review plan (idempotent).
   */
  async createReviewPlan(cycle, plan) {
    const planKey = `cosmo:reviews:cycle:${cycle}:plan`;
    const ttlMs = Math.max(
      (this.config.coordinator?.barrierTtlMs) || 600000,
      (this.config.coordinator?.timeoutMs) || 60000
    );

    try {
      const existing = await this.client.get(planKey);
      if (existing) {
        return JSON.parse(existing);
      }

      const record = {
        ...plan,
        persistedAt: new Date().toISOString(),
        persistedBy: this.instanceId
      };

      const result = await this.client.set(
        planKey,
        JSON.stringify(record),
        'PX',
        ttlMs,
        'NX'
      );

      if (result !== 'OK') {
        const fallback = await this.client.get(planKey);
        return fallback ? JSON.parse(fallback) : record;
      }

      return record;
    } catch (error) {
      this.logger.error('[RedisStateStore] createReviewPlan error', {
        cycle,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Retrieve review plan for cycle.
   */
  async getReviewPlan(cycle) {
    const planKey = `cosmo:reviews:cycle:${cycle}:plan`;
    try {
      const data = await this.client.get(planKey);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error('[RedisStateStore] getReviewPlan error', {
        cycle,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Append review event to stream/list.
   */
  async appendReviewEvent(cycle, event) {
    const eventKey = `cosmo:reviews:cycle:${cycle}:events`;
    const ttlMs = Math.max(
      (this.config.coordinator?.barrierTtlMs) || 600000,
      (this.config.coordinator?.timeoutMs) || 60000
    );

    try {
      await this.client.rpush(eventKey, JSON.stringify({
        cycle,
        ...event
      }));
      await this.client.pexpire(eventKey, ttlMs);
      return true;
    } catch (error) {
      this.logger.warn('[RedisStateStore] appendReviewEvent error', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  async recordGovernanceSnapshot(snapshot) {
    const key = 'cosmo:governance:snapshot';
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        ...snapshot
      };
      await this.client.set(key, JSON.stringify(payload));
      return payload;
    } catch (error) {
      this.logger.error('[RedisStateStore] recordGovernanceSnapshot error', {
        error: error.message
      });
      throw error;
    }
  }

  async getGovernanceSnapshot() {
    const key = 'cosmo:governance:snapshot';
    try {
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.warn('[RedisStateStore] getGovernanceSnapshot error', {
        error: error.message
      });
      return null;
    }
  }

  async setGovernanceOverride(override) {
    const key = 'cosmo:governance:override';
    try {
      if (!override) {
        await this.client.del(key);
        return true;
      }

      const payload = {
        updatedAt: new Date().toISOString(),
        ...override
      };

      await this.client.set(key, JSON.stringify(payload));

      if (payload.expiresAt) {
        const expiresAt = new Date(payload.expiresAt).getTime();
        const ttlMs = expiresAt - Date.now();
        if (ttlMs > 0) {
          await this.client.pexpire(key, ttlMs);
        }
      } else {
        await this.client.pexpire(key, 24 * 60 * 60 * 1000);
      }

      return payload;
    } catch (error) {
      this.logger.error('[RedisStateStore] setGovernanceOverride error', {
        error: error.message
      });
      throw error;
    }
  }

  async getGovernanceOverride() {
    const key = 'cosmo:governance:override';
    try {
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.warn('[RedisStateStore] getGovernanceOverride error', {
        error: error.message
      });
      return null;
    }
  }

  async clearGovernanceOverride() {
    const key = 'cosmo:governance:override';
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      this.logger.warn('[RedisStateStore] clearGovernanceOverride error', {
        error: error.message
      });
      return false;
    }
  }

  async appendGovernanceEvent(event) {
    const key = 'cosmo:governance:events';
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        ...event
      };

      await this.client.multi()
        .rpush(key, JSON.stringify(payload))
        .ltrim(key, -500, -1)
        .exec();

      return true;
    } catch (error) {
      this.logger.warn('[RedisStateStore] appendGovernanceEvent error', {
        error: error.message
      });
      return false;
    }
  }

  async getGovernanceEvents(limit = 50) {
    const key = 'cosmo:governance:events';
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    try {
      const entries = await this.client.lrange(key, -safeLimit, -1);
      return entries.map((entry) => {
        try {
          return JSON.parse(entry);
        } catch (error) {
          this.logger.warn('[RedisStateStore] Failed to parse governance event', {
            error: error.message
          });
          return { raw: entry, parseError: true };
        }
      });
    } catch (error) {
      this.logger.warn('[RedisStateStore] getGovernanceEvents error', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Record review artifact (draft/critique/synthesis).
   */
  async recordReviewArtifact(cycle, artifact) {
    const artifactKey = `cosmo:reviews:cycle:${cycle}:artifacts`;
    const ttlMs = Math.max(
      (this.config.coordinator?.barrierTtlMs) || 600000,
      (this.config.coordinator?.timeoutMs) || 60000
    );

    const sanitize = (value, fallback) => {
      if (!value) return fallback;
      return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9\-]+/g, '-')
        .replace(/^-+|-+$/g, '') || fallback;
    };

    const type = sanitize(artifact.artifactType || artifact.phase || 'artifact', 'artifact');
    const instanceId = sanitize(artifact.instanceId || 'unknown', 'unknown');
    const artifactId = sanitize(
      artifact.artifactId || `${type}_${instanceId}`,
      `${type}_${instanceId}`
    );

    const record = {
      ...artifact,
      artifactId,
      artifactType: artifact.artifactType || type,
      cycle,
      persistedAt: new Date().toISOString(),
      persistedBy: this.instanceId
    };

    try {
      await this.client.hset(artifactKey, artifactId, JSON.stringify(record));
      await this.client.pexpire(artifactKey, ttlMs);
      return record;
    } catch (error) {
      this.logger.error('[RedisStateStore] recordReviewArtifact error', {
        cycle,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Retrieve stored review artifacts.
   */
  async getReviewArtifacts(cycle) {
    const artifactKey = `cosmo:reviews:cycle:${cycle}:artifacts`;
    try {
      const entries = await this.client.hgetall(artifactKey);
      if (!entries) return [];

      return Object.values(entries).map((value) => {
        try {
          return JSON.parse(value);
        } catch (parseError) {
          this.logger.warn('[RedisStateStore] getReviewArtifacts parse error', {
            cycle,
            error: parseError.message
          });
          return null;
        }
      }).filter(Boolean);
    } catch (error) {
      this.logger.error('[RedisStateStore] getReviewArtifacts error', {
        cycle,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Clear review readiness state.
   */
  async clearReviewBarrier(cycle) {
    const readyKey = `cosmo:reviews:cycle:${cycle}:ready`;
    try {
      await this.client.del(readyKey);
      return true;
    } catch (error) {
      this.logger.warn('[RedisStateStore] clearReviewBarrier error', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  // ============================================================
  // Plan/Task/Milestone Operations (Phase 2 - Task Storage)
  // Redis Implementation - Using hashes and sorted sets
  // ============================================================

  /**
   * Create a new Plan
   */
  async createPlan(plan) {
    try {
      const key = `cosmo:plan:${plan.id}`;
      await this.client.hset(key, 'data', JSON.stringify(plan));
      await this.client.sadd('cosmo:plans:all', plan.id);
      return plan;
    } catch (error) {
      this.logger.error('[RedisStateStore] createPlan error', { planId: plan.id, error: error.message });
      throw error;
    }
  }

  /**
   * Get a Plan by ID
   */
  async getPlan(planId) {
    try {
      const key = `cosmo:plan:${planId}`;
      const data = await this.client.hget(key, 'data');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error('[RedisStateStore] getPlan error', { planId, error: error.message });
      return null;
    }
  }

  /**
   * Update an existing Plan
   */
  async updatePlan(planId, updates) {
    try {
      const plan = await this.getPlan(planId);
      if (!plan) throw new Error(`Plan ${planId} not found`);
      
      const updated = { ...plan, ...updates, updatedAt: Date.now() };
      await this.createPlan(updated);
      return updated;
    } catch (error) {
      this.logger.error('[RedisStateStore] updatePlan error', { planId, error: error.message });
      throw error;
    }
  }

  /**
   * List all Plans
   */
  async listPlans() {
    try {
      const planIds = await this.client.smembers('cosmo:plans:all');
      const plans = await Promise.all(planIds.map(id => this.getPlan(id)));
      return plans.filter(p => p !== null);
    } catch (error) {
      this.logger.error('[RedisStateStore] listPlans error', { error: error.message });
      return [];
    }
  }

  /**
   * Create or update a Milestone
   */
  async upsertMilestone(milestone) {
    try {
      const key = `cosmo:milestone:${milestone.id}`;
      await this.client.hset(key, 'data', JSON.stringify(milestone));
      await this.client.sadd(`cosmo:plan:${milestone.planId}:milestones`, milestone.id);
      return milestone;
    } catch (error) {
      this.logger.error('[RedisStateStore] upsertMilestone error', { milestoneId: milestone.id, error: error.message });
      throw error;
    }
  }

  /**
   * Get a Milestone by ID
   */
  async getMilestone(milestoneId) {
    try {
      const key = `cosmo:milestone:${milestoneId}`;
      const data = await this.client.hget(key, 'data');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error('[RedisStateStore] getMilestone error', { milestoneId, error: error.message });
      return null;
    }
  }

  /**
   * List Milestones for a Plan
   */
  async listMilestones(planId) {
    try {
      const milestoneIds = await this.client.smembers(`cosmo:plan:${planId}:milestones`);
      const milestones = await Promise.all(milestoneIds.map(id => this.getMilestone(id)));
      return milestones.filter(m => m !== null).sort((a, b) => a.order - b.order);
    } catch (error) {
      this.logger.error('[RedisStateStore] listMilestones error', { planId, error: error.message });
      return [];
    }
  }

  /**
   * Advance to next Milestone
   */
  async advanceMilestone(planId, currentMilestoneId) {
    try {
      const plan = await this.getPlan(planId);
      const milestones = await this.listMilestones(planId);
      
      const currentIdx = milestones.findIndex(m => m.id === currentMilestoneId);
      if (currentIdx === -1 || currentIdx === milestones.length - 1) {
        return false; // No next milestone
      }
      
      const nextMilestone = milestones[currentIdx + 1];
      await this.upsertMilestone({ ...milestones[currentIdx], status: 'COMPLETED', updatedAt: Date.now() });
      await this.upsertMilestone({ ...nextMilestone, status: 'ACTIVE', updatedAt: Date.now() });
      await this.updatePlan(planId, { activeMilestone: nextMilestone.id });
      
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] advanceMilestone error', { planId, currentMilestoneId, error: error.message });
      throw error;
    }
  }

  /**
   * Create or update a Task
   */
  async upsertTask(task) {
    try {
      const key = `cosmo:task:${task.id}`;
      await this.client.hset(key, 'data', JSON.stringify(task));
      await this.client.zadd(`cosmo:tasks:${task.state}`, task.priority || 5, task.id);
      await this.client.sadd(`cosmo:plan:${task.planId}:tasks`, task.id);
      return task;
    } catch (error) {
      this.logger.error('[RedisStateStore] upsertTask error', { taskId: task.id, error: error.message });
      throw error;
    }
  }

  /**
   * Get a Task by ID
   */
  async getTask(taskId) {
    try {
      const key = `cosmo:task:${taskId}`;
      const data = await this.client.hget(key, 'data');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error('[RedisStateStore] getTask error', { taskId, error: error.message });
      return null;
    }
  }

  /**
   * List Tasks with filters
   */
  async listTasks(planId, filters = {}) {
    try {
      const taskIds = await this.client.smembers(`cosmo:plan:${planId}:tasks`);
      let tasks = await Promise.all(taskIds.map(id => this.getTask(id)));
      tasks = tasks.filter(t => t !== null);
      
      if (filters.state) tasks = tasks.filter(t => t.state === filters.state);
      if (filters.milestoneId) tasks = tasks.filter(t => t.milestoneId === filters.milestoneId);
      if (filters.assignedTo) tasks = tasks.filter(t => t.assignedTo === filters.assignedTo);
      if (filters.claimedBy) tasks = tasks.filter(t => t.claimedBy === filters.claimedBy);
      
      return tasks;
    } catch (error) {
      this.logger.error('[RedisStateStore] listTasks error', { planId, error: error.message });
      return [];
    }
  }

  /**
   * Claim a Task (atomic operation)
   */
  async claimTask(taskId, instanceId, ttlMs) {
    try {
      const task = await this.getTask(taskId);
      if (!task || task.state !== 'PENDING') return false;
      
      task.state = 'CLAIMED';
      task.claimedBy = instanceId;
      task.claimedAt = Date.now();
      task.claimExpiry = Date.now() + ttlMs;
      task.updatedAt = Date.now();
      
      await this.upsertTask(task);
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] claimTask error', { taskId, instanceId, error: error.message });
      return false;
    }
  }

  /**
   * Release a claimed Task
   */
  async releaseTask(taskId, instanceId) {
    try {
      const task = await this.getTask(taskId);
      if (!task || task.claimedBy !== instanceId) {
        throw new Error('Task not claimed by this instance');
      }
      
      task.state = 'PENDING';
      task.claimedBy = null;
      task.claimedAt = null;
      task.claimExpiry = null;
      task.updatedAt = Date.now();
      
      await this.upsertTask(task);
    } catch (error) {
      this.logger.error('[RedisStateStore] releaseTask error', { taskId, instanceId, error: error.message });
      throw error;
    }
  }

  /**
   * Start a Task (mark IN_PROGRESS)
   */
  async startTask(taskId, instanceId) {
    try {
      const task = await this.getTask(taskId);
      if (!task) throw new Error('Task not found');
      
      task.state = 'IN_PROGRESS';
      task.startedBy = instanceId;
      task.startedAt = Date.now();
      task.updatedAt = Date.now();
      
      await this.upsertTask(task);
    } catch (error) {
      this.logger.error('[RedisStateStore] startTask error', { taskId, instanceId, error: error.message });
      throw error;
    }
  }

  /**
   * Complete a Task (mark DONE)
   */
  async completeTask(taskId) {
    try {
      const task = await this.getTask(taskId);
      if (!task) throw new Error('Task not found');
      
      task.state = 'DONE';
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      
      await this.upsertTask(task);
    } catch (error) {
      this.logger.error('[RedisStateStore] completeTask error', { taskId, error: error.message });
      throw error;
    }
  }

  /**
   * Fail a Task (mark FAILED)
   */
  async failTask(taskId, reason) {
    try {
      const task = await this.getTask(taskId);
      if (!task) throw new Error('Task not found');
      
      task.state = 'FAILED';
      task.failureReason = reason;
      task.failedAt = Date.now();
      task.updatedAt = Date.now();
      
      await this.upsertTask(task);
    } catch (error) {
      this.logger.error('[RedisStateStore] failTask error', { taskId, error: error.message });
      throw error;
    }
  }

  /**
   * List runnable Tasks for a Plan
   */
  async listRunnableTasks(planId) {
    try {
      const plan = await this.getPlan(planId);
      if (!plan) return [];
      
      const tasks = await this.listTasks(planId, { state: 'PENDING' });
      const activeMilestone = plan.activeMilestone;
      
      // Filter by active milestone and check dependencies
      const runnable = [];
      for (const task of tasks) {
        if (task.milestoneId !== activeMilestone) continue;
        
        // Check dependencies
        if (task.deps && task.deps.length > 0) {
          const depTasks = await Promise.all(task.deps.map(id => this.getTask(id)));
          const allDepsDone = depTasks.every(t => t && t.state === 'DONE');
          if (!allDepsDone) continue;
        }
        
        runnable.push(task);
      }
      
      return runnable.sort((a, b) => (b.priority || 5) - (a.priority || 5));
    } catch (error) {
      this.logger.error('[RedisStateStore] listRunnableTasks error', { planId, error: error.message });
      return [];
    }
  }

  /**
   * Apply a PlanDelta atomically
   */
  async applyPlanDelta(delta) {
    try {
      const plan = await this.getPlan(delta.planId);
      if (!plan) throw new Error(`Plan ${delta.planId} not found`);
      if (plan.version !== delta.expectedVersion) {
        throw new Error(`Version mismatch: expected ${delta.expectedVersion}, got ${plan.version}`);
      }
      
      // Apply operations
      for (const op of delta.operations) {
        if (op.type === 'addTask') {
          await this.upsertTask(op.task);
        } else if (op.type === 'updateTask') {
          const task = await this.getTask(op.taskId);
          if (task) {
            await this.upsertTask({ ...task, ...op.updates, updatedAt: Date.now() });
          }
        } else if (op.type === 'removeTask') {
          const key = `cosmo:task:${op.taskId}`;
          await this.client.del(key);
        } else if (op.type === 'addMilestone') {
          await this.upsertMilestone(op.milestone);
        } else if (op.type === 'updateMilestone') {
          const milestone = await this.getMilestone(op.milestoneId);
          if (milestone) {
            await this.upsertMilestone({ ...milestone, ...op.updates, updatedAt: Date.now() });
          }
        }
      }
      
      // Increment plan version
      await this.updatePlan(delta.planId, { version: plan.version + 1 });
      return true;
    } catch (error) {
      this.logger.error('[RedisStateStore] applyPlanDelta error', { planId: delta.planId, error: error.message });
      return false;
    }
  }
}

module.exports = RedisStateStore;
