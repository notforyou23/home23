/**
 * RedisStateStore
 *
 * Redis backend for COSMO clustering.
 * - Active/active CRDT merges (LWW, OR-Set, PN-Counter)
 * - Idempotent diff application via diff_id tracking
 * - Fencing tokens for leader election
 * - Atomic goal claiming with Lua scripts
 *
 * Phase B-R: Redis State Store + CRDT Merge
 */

class RedisStateStore {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.instanceId = config.instanceId || 'cosmo-1';
    this.goalStore = new Map(); // goalId -> metadata snapshot
    this.governanceEvents = [];
  }

  /**
   * Connect to Redis backend.
   * TLS and ACL support ready.
   */
  async connect() {
    // TODO Phase B-R: Initialize Redis client with TLS/ACL
    // - URL from config.stateStore.url
    // - TLS certificates from env
    // - ACL credentials from config
    // - Fallback to file backend if connection fails
  }

  /**
   * Disconnect from Redis.
   */
  async disconnect() {
    // TODO Phase B-R: Close Redis connection
  }

  /**
   * Store memory node with LWW (Last-Writer-Wins) CRDT.
   * @param {string} nodeId - node identifier
   * @param {object} value - node value
   * @param {object} versionVector - { instanceId: clock }
   * @param {number} ttl - optional TTL in ms
   */
  async setMemory(nodeId, value, versionVector, ttl) {
    // TODO Phase B-R: CRDT merge on conflict
    // - Compare version vectors
    // - Apply LWW rule: (timestamp, then instanceId as tiebreaker)
    // - Store with TTL if provided
    // - Return merged value
  }

  /**
   * Retrieve memory node.
   * @param {string} nodeId - node identifier
   * @returns {object} - { value, versionVector, timestamp, sourceInstance }
   */
  async getMemory(nodeId) {
    // TODO Phase B-R: Fetch node from Redis
  }

  /**
   * Submit diff for cycle.
   * @param {number} cycle - cycle number
   * @param {string} instanceId - instance ID
   * @param {object} diff - { diff_id, versionVector, fields }
   */
  async submitDiff(cycle, instanceId, diff) {
    // TODO Phase B-R: Store diff under diff:{cycle}:{instanceId}
    // - Serialize with MessagePack
    // - Compress with gzip if >compressionThreshold
    // - Check idempotency: if diff_id already applied, reject
  }

  /**
   * Get merged state after leader applies diffs.
   * @param {number} cycle - cycle number
   * @returns {object} - merged state snapshot
   */
  async getMergedState(cycle) {
    // TODO Phase B-R: Fetch merged memory state
    // - Leader calls apply_merge.lua in previous cycle
    // - All instances fetch snapshot after cycle barrier
  }

  /**
   * Claim goal atomically using Lua script.
   * @param {string} goalId - goal identifier
   * @param {string} instanceId - claiming instance
   * @param {number} ttlMs - claim TTL
   * @returns {boolean} - true if claim succeeded
   */
  async claimGoal(goalId, instanceId, ttlMs) {
    const now = Date.now();
    const existing = this.goalStore.get(goalId);

    if (existing?.completed) {
      return false; // Completed goals are no longer claimable
    }

    if (existing?.claimedBy && existing.claimExpires && existing.claimExpires > now && existing.claimedBy !== instanceId) {
      return false; // Another instance still owns the claim
    }

    const claimCount = (existing?.claimCount || 0) + 1;
    const nextExpiry = now + ttlMs;

    const updated = {
      ...(existing || {}),
      goalId,
      claimedBy: instanceId,
      claimExpires: nextExpiry,
      lastClaimedAt: now,
      claimCount,
      completed: false,
      completedAt: existing?.completed ? existing.completedAt : null,
      completedBy: existing?.completed ? existing.completedBy : null
    };

    this.goalStore.set(goalId, updated);
    return true;
  }

  /**
   * Mark goal completed.
   * @param {string} goalId - goal identifier
   */
  async completeGoal(goalId) {
    const now = Date.now();
    const existing = this.goalStore.get(goalId) || { goalId };

    const updated = {
      ...existing,
      completed: true,
      completedAt: now,
      completedBy: this.instanceId,
      claimedBy: null,
      claimExpires: null,
      lastClaimedAt: existing.lastClaimedAt || now
    };

    this.goalStore.set(goalId, updated);
    return true;
  }

  async releaseGoal(goalId, instanceId) {
    const existing = this.goalStore.get(goalId);
    if (!existing) {
      return true; // Nothing to release
    }

    if (existing.claimedBy && instanceId && existing.claimedBy !== instanceId) {
      return false; // Prevent releasing another instance's claim
    }

    const updated = {
      ...existing,
      claimedBy: null,
      claimExpires: null,
      lastReleasedAt: Date.now()
    };

    this.goalStore.set(goalId, updated);
    return true;
  }

  /**
   * Append to immutable journal (Redis Stream).
   * @param {object} entry - journal entry
   */
  async appendJournal(entry) {
    // TODO Phase B-R: XADD to Redis Stream (partitioned by day)
    // - Entry tagged with sourceInstance, trace_id, cycle
    // - Immutable append-only
  }

  /**
   * Get journal entries (range query).
   * @param {number} startCycle - start cycle
   * @param {number} endCycle - end cycle
   * @returns {array} - journal entries
   */
  async getJournal(startCycle, endCycle) {
    // TODO Phase B-R: Query Redis Streams for cycle range
  }

  /**
   * Validate configuration hash.
   * @param {string} configHash - SHA256 hash
   * @returns {boolean} - true if matches stored hash
   */
  async validateConfigHash(configHash) {
    // TODO Phase B-R: Compare configHash with stored value
    // - Mismatch = reject join
  }

  /**
   * Store configuration hash.
   * @param {string} configHash - SHA256 hash
   */
  async setConfigHash(configHash) {
    // TODO Phase B-R: Store config:hash
  }

  /**
   * Set instance health beacon.
   * @param {string} instanceId - instance ID
   * @param {object} health - { cycle, memoryHash, ramUsage, errorCount, timestamp }
   */
  async setHealthBeacon(instanceId, health) {
    // TODO Phase D-R: Store health:{instanceId} hash with TTL
  }

  /**
   * Get instance health beacon.
   * @param {string} instanceId - instance ID
   * @returns {object} - health beacon
   */
  async getHealthBeacon(instanceId) {
    // TODO Phase D-R: Fetch health:{instanceId}
  }

  /**
   * Get all health beacons.
   * @returns {object} - map of instanceId -> health
   */
  async getAllHealthBeacons() {
    // TODO Phase D-R: Fetch all health:* keys
  }

  /**
   * Acquire leader token (fencing).
   * @returns {number} - leader epoch token
   */
  async acquireLeadership() {
    // TODO Phase D-R: SET cosmo:leader:holder NX PX leaseMs
    // - INCR cosmo:leader:epoch
    // - Store token alongside holder
    // - Return token
  }

  /**
   * Renew leadership lease (via Lua script).
   * @param {number} token - leader token
   * @returns {boolean} - true if renewal succeeded
   */
  async renewLeadership(token) {
    // TODO Phase D-R: Call leader_renew.lua script
    // - Check token matches
    // - Extend lease TTL
  }

  /**
   * Release leadership.
   */
  async releaseLeadership() {
    // TODO Phase D-R: DEL cosmo:leader:holder
  }

  /**
   * Mark instance as ready for cycle barrier.
   * @param {number} cycle - cycle number
   * @param {string} instanceId - instance ID
   */
  async markReady(cycle, instanceId) {
    // TODO Phase D-R: SADD cosmo:ready:{cycle} instanceId
    // - Set TTL on ready set
  }

  /**
   * Get ready count for cycle barrier.
   * @param {number} cycle - cycle number
   * @returns {number} - count of ready instances
   */
  async getReadyCount(cycle) {
    // TODO Phase D-R: SCARD cosmo:ready:{cycle}
  }

  /**
   * Publish sync signal (cycle proceed).
   * @param {number} cycle - cycle number
   */
  async publishSyncSignal(cycle) {
    // TODO Phase D-R: PUBLISH cosmo:cluster:sync "Cycle N+1 proceed"
  }

  /**
   * Subscribe to sync signals.
   * @param {function} callback - called with signal
   */
  async subscribeSyncSignal(callback) {
    // TODO Phase D-R: SUBSCRIBE cosmo:cluster:sync
    // - Async, non-blocking
  }

  /**
   * Publish heartbeat.
   * @param {object} beacon - heartbeat payload
   */
  async publishHeartbeat(beacon) {
    // TODO Phase D-R: PUBLISH cosmo:cluster:heartbeats (MessagePack)
  }

  /**
   * Subscribe to heartbeats.
   * @param {function} callback - called with beacon
   */
  async subscribeHeartbeats(callback) {
    // TODO Phase D-R: SUBSCRIBE cosmo:cluster:heartbeats
  }

  async recordGovernanceSnapshot(snapshot) {
    this.governanceSnapshot = {
      timestamp: new Date().toISOString(),
      ...snapshot
    };
    return this.governanceSnapshot;
  }

  async getGovernanceSnapshot() {
    return this.governanceSnapshot || null;
  }

  async setGovernanceOverride(override) {
    if (!override) {
      this.governanceOverride = null;
      return true;
    }

    this.governanceOverride = {
      updatedAt: new Date().toISOString(),
      ...override
    };
    return this.governanceOverride;
  }

  async getGovernanceOverride() {
    return this.governanceOverride || null;
  }

  async clearGovernanceOverride() {
    this.governanceOverride = null;
    return true;
  }

  async appendGovernanceEvent(event) {
    this.governanceEvents.push({
      timestamp: new Date().toISOString(),
      ...event
    });
    return true;
  }

  async getGovernanceEvents(limit = 50) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    return this.governanceEvents.slice(-safeLimit);
  }
}

module.exports = RedisStateStore;
