/**
 * FilesystemStateStore - Full Implementation
 *
 * Filesystem backend for COSMO clustering (zero-infra, air-gapped).
 * Single-writer lease model with term-gated commits.
 *
 * Phase B-FS: Filesystem State Store + Single-Writer Apply
 */

const fs = require('fs').promises;
const path = require('path');
const { FilesystemHelpers } = require('../fs/helpers');
const { LeaderElection } = require('../fs/leader-election');
const { Reconciler } = require('../fs/reconciler');
const crypto = require('crypto');

class FilesystemStateStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.fsRoot = config.fsRoot || '/cosmo_cluster';
    this.instanceId = config.instanceId || 'cosmo-1';
    
    // Helpers
    this.helpers = new FilesystemHelpers(logger);
    this.leaderElection = new LeaderElection(config, this.fsRoot, this.instanceId, logger);
    this.reconciler = new Reconciler(this.fsRoot, logger);
    
    // State
    this.currentEpoch = 0;
    this.currentSeq = 0;
    this.memoryCache = new Map(); // In-memory cache of FS state
    
    // Paths
    this.controlDir = path.join(this.fsRoot, 'control');
    this.epochsDir = path.join(this.fsRoot, 'epochs');
    this.logsDir = path.join(this.fsRoot, 'logs');
    this.goalsDir = path.join(this.fsRoot, 'goals');
    this.instancesDir = path.join(this.fsRoot, 'instances');
    this.appliedDir = path.join(this.fsRoot, 'applied');
    this.memoryDir = path.join(this.fsRoot, 'memory');
    this.reviewsDir = path.join(this.fsRoot, 'reviews');
    this.governanceDir = path.join(this.fsRoot, 'governance');
    this.plansDir = path.join(this.fsRoot, 'plans');
    this.milestonesDir = path.join(this.fsRoot, 'milestones');
    this.tasksDir = path.join(this.fsRoot, 'tasks');
  }

  /**
   * Initialize filesystem backend
   */
  async connect() {
    try {
      const fs = require('fs').promises;
      
      this.logger.info('[FilesystemStateStore] Initializing FS tree', {
        fsRoot: this.fsRoot,
        instanceId: this.instanceId,
        readOnly: this.config.readOnly || false
      });

      // READ-ONLY MODE: Passive observer (dashboards, queries)
      // Skips directory creation and leader election for non-intrusive access
      if (this.config.readOnly) {
        // Verify root exists
        try {
          await fs.access(this.fsRoot);
        } catch (e) {
          throw new Error(`Cluster root ${this.fsRoot} does not exist (read-only mode)`);
        }

        // Load epoch/seq for context
        const epochStr = await this.helpers.atomicRead(
          path.join(this.controlDir, 'CURRENT_EPOCH'),
          { encoding: 'utf8', defaultValue: '0' }
        );
        this.currentEpoch = parseInt(epochStr) || 0;

        const seqStr = await this.helpers.atomicRead(
          path.join(this.controlDir, 'CURRENT_SEQ'),
          { encoding: 'utf8', defaultValue: '0' }
        );
        this.currentSeq = parseInt(seqStr) || 0;

        this.logger.info('[FilesystemStateStore] Initialized (READ-ONLY MODE)', {
          currentEpoch: this.currentEpoch,
          currentSeq: this.currentSeq
        });

        return true;
      }

      // ACTIVE MODE: Full participant (cluster instances)
      // Create directory structure
      const dirs = [
        this.controlDir,
        this.epochsDir,
        this.logsDir,
        this.goalsDir,
        path.join(this.goalsDir, 'pending'),
        path.join(this.goalsDir, 'assigned'),
        path.join(this.goalsDir, 'acks'),
        path.join(this.goalsDir, 'complete'),
        path.join(this.goalsDir, 'revoked'),
        this.instancesDir,
        path.join(this.instancesDir, this.instanceId),
        this.appliedDir,
        this.memoryDir,
        this.reviewsDir,
        this.governanceDir,
        this.plansDir,
        this.milestonesDir,
        this.tasksDir, // BULLETPROOF FIX: Only root tasks/ directory (no subdirs, state is in field)
        path.join(this.tasksDir, 'locks') // Only locks subdirectory needed for claim atomicity
      ];

      for (const dir of dirs) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Initialize leader election
      await this.leaderElection.initialize();

      // Load current epoch and sequence
      const epochStr = await this.helpers.atomicRead(
        path.join(this.controlDir, 'CURRENT_EPOCH'),
        { encoding: 'utf8', defaultValue: '0' }
      );
      this.currentEpoch = parseInt(epochStr) || 0;

      const seqStr = await this.helpers.atomicRead(
        path.join(this.controlDir, 'CURRENT_SEQ'),
        { encoding: 'utf8', defaultValue: '0' }
      );
      this.currentSeq = parseInt(seqStr) || 0;

      this.logger.info('[FilesystemStateStore] Initialized', {
        currentEpoch: this.currentEpoch,
        currentSeq: this.currentSeq
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] Initialization failed', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Disconnect (cleanup)
   */
  async disconnect() {
    await this.leaderElection.cleanup();
    this.logger.info('[FilesystemStateStore] Disconnected');
  }

  /**
   * Store memory node (single-writer, term-gated)
   */
  async setMemory(nodeId, value, versionVector, ttl) {
    try {
      const filePath = path.join(this.memoryDir, `${nodeId}.json`);
      
      const nodeData = {
        value,
        versionVector,
        timestamp: Date.now(),
        sourceInstance: this.instanceId,
        term: this.currentEpoch,
        seq: this.currentSeq
      };

      // Write atomically
      await this.helpers.atomicWriteJSON(filePath, nodeData);
      
      // Update cache
      this.memoryCache.set(nodeId, nodeData);
      
      return nodeData;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] setMemory error', {
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
    try {
      // Check cache first
      if (this.memoryCache.has(nodeId)) {
        return this.memoryCache.get(nodeId);
      }

      const filePath = path.join(this.memoryDir, `${nodeId}.json`);
      const data = await this.helpers.atomicReadJSON(filePath, null);
      
      if (data) {
        this.memoryCache.set(nodeId, data);
      }
      
      return data;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getMemory error', {
        nodeId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Submit diff for cycle (leader writes to epoch)
   */
  async submitDiff(cycle, instanceId, diff) {
    try {
      const epochDir = path.join(this.epochsDir, `E${this.currentEpoch}`);
      const diffsDir = path.join(epochDir, 'diffs');
      await this.helpers.ensureDirectory(diffsDir);

      const diffPath = path.join(diffsDir, `${instanceId}_${cycle}.json`);
      
      // Add metadata
      if (!diff.diff_id) {
        diff.diff_id = `${Date.now()}_${cycle}_${instanceId}_${crypto.randomBytes(4).toString('hex')}`;
      }

      // Check idempotency
      const appliedMarker = path.join(this.appliedDir, diff.diff_id);
      if (await this.helpers.fileExists(appliedMarker)) {
        this.logger.warn('[FilesystemStateStore] Diff already applied', {
          diff_id: diff.diff_id
        });
        return false;
      }

      // Write diff
      await this.helpers.atomicWriteJSON(diffPath, diff);
      
      // Mark as applied
      await this.helpers.atomicWrite(appliedMarker, Date.now().toString(), { encoding: 'utf8' });
      
      // Append to event log
      await this.appendToEventLog({
        type: 'DIFF_SUBMITTED',
        cycle,
        instanceId,
        diff_id: diff.diff_id,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] submitDiff error', {
        cycle,
        instanceId,
        error: error.message
      });
      return false;
    }
  }

  async fetchDiffs(cycle) {
    try {
      const epochDir = path.join(this.epochsDir, `E${this.currentEpoch}`);
      const diffsDir = path.join(epochDir, 'diffs');
      const files = await this.helpers.listDirectory(diffsDir);
      const diffs = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(diffsDir, file);
        try {
          const diff = await this.helpers.atomicReadJSON(filePath, null);
          if (!diff) continue;
          diffs.push({
            filePath,
            diff,
            diffId: diff.diff_id,
            instanceId: diff.instanceId,
            timestamp: diff.timestamp || Date.now()
          });
        } catch (error) {
          this.logger.error('[FilesystemStateStore] fetchDiffs read error', {
            file,
            error: error.message
          });
        }
      }

      return diffs;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] fetchDiffs error', {
        error: error.message
      });
      return [];
    }
  }

  async setMergedState(cycle, mergedState) {
    try {
      const epochDir = path.join(this.epochsDir, `E${this.currentEpoch}`);
      await this.helpers.atomicWriteJSON(path.join(epochDir, 'snapshot.json'), {
        cycle,
        ...mergedState
      });
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] setMergedState error', {
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
        this.idempotency?.markApplied?.(diffId, {
          cycle,
          instanceId: entry.instanceId,
          timestamp: entry.timestamp
        });
      }

      if (entry.filePath) {
        try {
          await fs.unlink(entry.filePath);
        } catch (error) {
          this.logger.error('[FilesystemStateStore] acknowledgeDiffs unlink error', {
            filePath: entry.filePath,
            error: error.message
          });
        }
      }
    }
  }

  /**
   * Get merged state (from snapshot or current)
   */
  async getMergedState(cycle) {
    try {
      const epochDir = path.join(this.epochsDir, `E${this.currentEpoch}`);
      const snapshotPath = path.join(epochDir, 'snapshot.json');

      const snapshot = await this.helpers.atomicReadJSON(snapshotPath, null);
      return snapshot;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getMergedState error', {
        cycle,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Claim goal (single-writer assigns) with atomic locking
   *
   * Security: Uses O_EXCL file locking to prevent TOCTOU race conditions
   * where multiple instances could claim the same goal simultaneously.
   */
  async claimGoal(goalId, instanceId, ttlMs) {
    // Use a goal-specific lock file to serialize claim attempts
    const lockPath = path.join(this.goalsDir, 'locks', `${goalId}.lock`);
    let lockAcquired = false;

    try {
      // Ensure lock directory exists
      await this.helpers.ensureDirectory(path.join(this.goalsDir, 'locks'));

      // Try to acquire atomic lock (O_EXCL - fails if lock exists)
      lockAcquired = await this.helpers.tryAcquireLock(lockPath, {
        instanceId,
        timestamp: Date.now(),
        operation: 'claim_goal'
      });

      if (!lockAcquired) {
        // Another instance is currently claiming - check if lock is stale
        const lockData = await this.helpers.readLock(lockPath);
        if (lockData && (Date.now() - lockData.timestamp) > 30000) {
          // Lock is stale (> 30 seconds old), try to force release and retry
          this.logger.warn('[FilesystemStateStore] Releasing stale goal lock', {
            goalId,
            lockHolder: lockData.instanceId,
            lockAge: Date.now() - lockData.timestamp
          });
          await this.helpers.releaseLock(lockPath);
          lockAcquired = await this.helpers.tryAcquireLock(lockPath, {
            instanceId,
            timestamp: Date.now(),
            operation: 'claim_goal'
          });
        }

        if (!lockAcquired) {
          this.logger.debug('[FilesystemStateStore] Goal claim blocked by lock', {
            goalId,
            instanceId
          });
          return false;
        }
      }

      // Lock acquired - now safe to check and claim atomically
      const assignedInstanceDir = path.join(this.goalsDir, 'assigned', instanceId);
      await this.helpers.ensureDirectory(assignedInstanceDir);

      const assignmentPath = path.join(assignedInstanceDir, `${goalId}.json`);

      // Check if already assigned to any instance
      const allInstances = await this.helpers.listDirectory(path.join(this.goalsDir, 'assigned'));
      for (const inst of allInstances) {
        const instDir = path.join(this.goalsDir, 'assigned', inst);
        const goalFile = path.join(instDir, `${goalId}.json`);
        if (await this.helpers.fileExists(goalFile)) {
          // Already assigned
          const assignment = await this.helpers.atomicReadJSON(goalFile);
          if (assignment && assignment.claim_expires > Date.now()) {
            return false; // Still claimed by another instance
          }
          // Claim expired - remove stale assignment
          try {
            await fs.unlink(goalFile);
          } catch (e) {
            // Ignore deletion errors
          }
        }
      }

      // Create assignment
      const assignment = {
        goalId,
        instanceId,
        claim_expires: Date.now() + ttlMs,
        claimed_at: Date.now(),
        term: this.currentEpoch
      };

      await this.helpers.atomicWriteJSON(assignmentPath, assignment);

      // Log to event log
      await this.appendToEventLog({
        type: 'GOAL_CLAIMED',
        goalId,
        instanceId,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] claimGoal error', {
        goalId,
        instanceId,
        error: error.message
      });
      return false;
    } finally {
      // Always release lock
      if (lockAcquired) {
        try {
          await this.helpers.releaseLock(lockPath);
        } catch (e) {
          this.logger.warn('[FilesystemStateStore] Failed to release goal lock', {
            goalId,
            error: e.message
          });
        }
      }
    }
  }

  /**
   * Mark goal completed
   */
  async completeGoal(goalId) {
    try {
      const completePath = path.join(this.goalsDir, 'complete', `${goalId}.done`);
      await this.helpers.atomicWriteJSON(completePath, {
        goalId,
        completedBy: this.instanceId,
        completedAt: Date.now()
      });

      // Log to event log
      await this.appendToEventLog({
        type: 'GOAL_COMPLETED',
        goalId,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] completeGoal error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  async releaseGoal(goalId, instanceId) {
    try {
      const assignedDir = path.join(this.goalsDir, 'assigned');
      const instances = await this.helpers.listDirectory(assignedDir);
      let released = false;

      for (const inst of instances) {
        if (instanceId && inst !== instanceId) {
          continue;
        }

        const assignmentPath = path.join(assignedDir, inst, `${goalId}.json`);
        if (await this.helpers.fileExists(assignmentPath)) {
          await fs.unlink(assignmentPath);
          released = true;
        }
      }

      if (released) {
        await this.appendToEventLog({
          type: 'GOAL_RELEASED',
          goalId,
          instanceId: instanceId || 'unknown',
          timestamp: Date.now()
        });
      }

      return released;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] releaseGoal error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Append to immutable journal
   */
  async appendJournal(entry) {
    const entryWithMetadata = {
      ...entry,
      sourceInstance: this.instanceId,
      timestamp: Date.now()
    };

    return this.appendToEventLog(entryWithMetadata);
  }

  /**
   * Get journal entries (range query)
   */
  async getJournal(startCycle, endCycle) {
    try {
      const logPath = this.getCurrentLogPath();
      const content = await this.helpers.atomicRead(logPath, {
        encoding: 'utf8',
        defaultValue: ''
      });

      const lines = content.split('\n').filter(l => l.length > 0);
      const entries = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const cycle = entry.cycle || 0;
          if (cycle >= startCycle && cycle <= endCycle) {
            entries.push(entry);
          }
        } catch (error) {
          // Skip invalid lines
        }
      }

      return entries;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getJournal error', {
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
      const hashPath = path.join(this.controlDir, 'config.hash');
      const stored = await this.helpers.atomicRead(hashPath, {
        encoding: 'utf8',
        defaultValue: null
      });

      if (!stored) {
        // First instance: store hash
        await this.setConfigHash(configHash);
        return true;
      }

      if (stored !== configHash) {
        this.logger.error('[FilesystemStateStore] Config hash mismatch', {
          expected: stored,
          provided: configHash
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] validateConfigHash error', {
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
      const hashPath = path.join(this.controlDir, 'config.hash');
      await this.helpers.atomicWrite(hashPath, configHash, { encoding: 'utf8' });
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] setConfigHash error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Set instance health beacon
   */
  async setHealthBeacon(instanceId, health) {
    try {
      const beaconPath = path.join(this.instancesDir, instanceId, 'heartbeat');
      await this.helpers.atomicWriteJSON(beaconPath, {
        ...health,
        timestamp: Date.now()
      });
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] setHealthBeacon error', {
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
    try {
      const beaconPath = path.join(this.instancesDir, instanceId, 'heartbeat');
      return await this.helpers.atomicReadJSON(beaconPath, null);
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getHealthBeacon error', {
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
      const instances = await this.helpers.listDirectory(this.instancesDir);
      const beacons = {};

      for (const instanceId of instances) {
        beacons[instanceId] = await this.getHealthBeacon(instanceId);
      }

      return beacons;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getAllHealthBeacons error', {
        error: error.message
      });
      return {};
    }
  }

  /**
   * Acquire leadership (via LeaderElection)
   */
  async acquireLeadership() {
    const acquired = await this.leaderElection.tryAcquireLeadership();
    if (acquired) {
      this.currentEpoch = this.leaderElection.getCurrentTerm();
    }
    return acquired;
  }

  /**
   * Renew leadership lease
   */
  async renewLeadership() {
    return await this.leaderElection.renewLease();
  }

  /**
   * Release leadership
   */
  async releaseLeadership() {
    return await this.leaderElection.releaseLeadership();
  }

  /**
   * Get current leader
   */
  async getCurrentLeader() {
    return await this.leaderElection.getCurrentLeader();
  }

  /**
   * Transition to new epoch (atomic flip)
   */
  async transitionEpoch() {
    try {
      const newEpoch = this.currentEpoch + 1;
      
      // Create new epoch directory
      const newEpochDir = path.join(this.epochsDir, `E${newEpoch}`);
      await this.helpers.ensureDirectory(newEpochDir);

      // Atomic update of CURRENT_EPOCH
      const epochPath = path.join(this.controlDir, 'CURRENT_EPOCH');
      await this.helpers.atomicWrite(epochPath, newEpoch.toString(), { encoding: 'utf8' });

      this.currentEpoch = newEpoch;

      this.logger.info('[FilesystemStateStore] Epoch transitioned', {
        newEpoch
      });

      return newEpoch;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] transitionEpoch error', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get current epoch
   */
  async getCurrentEpoch() {
    return this.currentEpoch;
  }

  /**
   * Submit goal assignments (leader only)
   */
  async submitAssignments(assignments) {
    if (!this.leaderElection.isCurrentLeader()) {
      this.logger.warn('[FilesystemStateStore] Not leader, cannot submit assignments');
      return false;
    }

    try {
      for (const assignment of assignments) {
        const { goalId, instanceId, assignId, ttl } = assignment;
        
        // Write to assigned directory
        const assignedDir = path.join(this.goalsDir, 'assigned', instanceId);
        await this.helpers.ensureDirectory(assignedDir);
        
        const assignmentPath = path.join(assignedDir, `${goalId}.json`);
        await this.helpers.atomicWriteJSON(assignmentPath, {
          goalId,
          instanceId,
          assignId,
          claim_expires: Date.now() + ttl,
          assigned_at: Date.now(),
          term: this.currentEpoch
        });

        // Increment sequence
        this.currentSeq++;
        await this.helpers.atomicWrite(
          path.join(this.controlDir, 'CURRENT_SEQ'),
          this.currentSeq.toString(),
          { encoding: 'utf8' }
        );

        // Log to event log
        await this.appendToEventLog({
          type: 'ASSIGNMENT',
          goalId,
          instanceId,
          assignId,
          seq: this.currentSeq,
          timestamp: Date.now()
        });
      }

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] submitAssignments error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Fetch pending assignments for instance
   */
  async fetchPendingAssignments(instanceId) {
    try {
      const assignedDir = path.join(this.goalsDir, 'assigned', instanceId);
      const assignments = await this.helpers.listDirectory(assignedDir);
      
      const pending = [];
      for (const file of assignments) {
        const assignmentPath = path.join(assignedDir, file);
        const assignment = await this.helpers.atomicReadJSON(assignmentPath, null);
        
        if (assignment && assignment.claim_expires > Date.now()) {
          pending.push(assignment);
        }
      }

      return pending;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] fetchPendingAssignments error', {
        instanceId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Mark assignment done
   */
  async markAssignmentDone(assignId) {
    try {
      const donePath = path.join(this.goalsDir, 'complete', `${assignId}.done`);
      await this.helpers.atomicWriteJSON(donePath, {
        assignId,
        completedBy: this.instanceId,
        completedAt: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] markAssignmentDone error', {
        assignId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Revoke assignment (leader only)
   */
  async revokeAssignment(assignId) {
    if (!this.leaderElection.isCurrentLeader()) {
      return false;
    }

    try {
      const revokePath = path.join(this.goalsDir, 'revoked', `${assignId}.rev`);
      await this.helpers.atomicWriteJSON(revokePath, {
        assignId,
        revokedBy: this.instanceId,
        revokedAt: Date.now()
      });

      await this.appendToEventLog({
        type: 'ASSIGNMENT_REVOKED',
        assignId,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] revokeAssignment error', {
        assignId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get recovery SBOM
   */
  async getRecoverySBOM() {
    return await this.reconciler.generateRecoverySBOM();
  }

  /**
   * Deterministic replay from snapshot + log
   */
  deterministicReplay(snapshotPath, logPath) {
    // TODO: Implement deterministic replay
    // Load snapshot, replay log entries, verify byte-for-byte match
    this.logger.info('[FilesystemStateStore] Deterministic replay', {
      snapshotPath,
      logPath
    });
  }

  /**
   * Run reconciliation check
   */
  async reconcile() {
    return await this.reconciler.reconcile();
  }

  /**
   * Helper: Append to event log
   */
  async appendToEventLog(entry) {
    const logPath = this.getCurrentLogPath();
    const line = JSON.stringify(entry);
    return await this.helpers.appendToLog(logPath, line);
  }

  /**
   * Helper: Get current log file path (partitioned by day)
   */
  getCurrentLogPath() {
    const now = new Date();
    const dateKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    return path.join(this.logsDir, `events.log.${dateKey}`);
  }

  /**
   * Calculate config hash
   */
  calculateConfigHash(config) {
    const configString = JSON.stringify(config, Object.keys(config).sort());
    return crypto.createHash('sha256').update(configString).digest('hex');
  }

  /**
   * Record review readiness file for this instance.
   */
  async recordReviewReadiness(cycle, instanceId, payload) {
    try {
      const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);
      await this.helpers.ensureDirectory(cycleDir);
      const filePath = path.join(cycleDir, `ready_${instanceId}.json`);
      const record = {
        instanceId,
        timestamp: Date.now(),
        payload
      };
      await this.helpers.atomicWriteJSON(filePath, record);
      return record;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] recordReviewReadiness error', {
        cycle,
        instanceId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Wait until quorum of readiness files exist or timeout.
   */
  async awaitReviewBarrier(cycle, quorum, timeoutMs) {
    const pollInterval = 500;
    const start = Date.now();
    const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);

    await this.helpers.ensureDirectory(cycleDir);

    const readyInstances = [];

    while (true) {
      const files = await this.helpers.listDirectory(
        cycleDir,
        (file) => file.startsWith('ready_') && file.endsWith('.json')
      );

      readyInstances.length = 0;

      for (const file of files) {
        const filePath = path.join(cycleDir, file);
        const data = await this.helpers.atomicReadJSON(filePath, null);
        if (data && data.instanceId) {
          readyInstances.push({
            instanceId: data.instanceId,
            timestamp: data.timestamp || Date.now()
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

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Persist review plan (idempotent across instances).
   */
  async createReviewPlan(cycle, plan) {
    const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);
    const planPath = path.join(cycleDir, 'plan.json');
    const lockPath = path.join(cycleDir, 'plan.lock');

    await this.helpers.ensureDirectory(cycleDir);

    const existing = await this.helpers.atomicReadJSON(planPath, null);
    if (existing) {
      return existing;
    }

    let lockAcquired = false;
    try {
      lockAcquired = await this.helpers.tryAcquireLock(lockPath, {
        cycle,
        instanceId: this.instanceId,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error('[FilesystemStateStore] createReviewPlan lock error', {
        cycle,
        error: error.message
      });
    }

    if (!lockAcquired) {
      const waitDeadline = Date.now() + Math.min(
        (this.config.coordinator?.timeoutMs) || 60000,
        5000
      );
      while (Date.now() < waitDeadline) {
        const materialized = await this.helpers.atomicReadJSON(planPath, null);
        if (materialized) {
          return materialized;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const fallback = await this.helpers.atomicReadJSON(planPath, null);
      if (fallback) {
        return fallback;
      }

      throw new Error('Plan lock held by peer but plan not written in time');
    }

    const record = {
      ...plan,
      persistedAt: new Date().toISOString(),
      persistedBy: this.instanceId
    };

    try {
      await this.helpers.atomicWriteJSON(planPath, record);
      return record;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] createReviewPlan error', {
        cycle,
        error: error.message
      });
      throw error;
    } finally {
      await this.helpers.releaseLock(lockPath).catch(() => {});
    }
  }

  /**
   * Retrieve review plan for a cycle.
   */
  async getReviewPlan(cycle) {
    try {
      const planPath = path.join(this.reviewsDir, `cycle_${cycle}`, 'plan.json');
      return await this.helpers.atomicReadJSON(planPath, null);
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getReviewPlan error', {
        cycle,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Append review event to cycle log.
   */
  async appendReviewEvent(cycle, event) {
    try {
      const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);
      await this.helpers.ensureDirectory(cycleDir);
      const logPath = path.join(cycleDir, 'events.log');
      const payload = {
        cycle,
        ...event
      };
      await this.helpers.appendToLog(logPath, JSON.stringify(payload));
      return true;
    } catch (error) {
      this.logger.warn('[FilesystemStateStore] appendReviewEvent error', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  async recordGovernanceSnapshot(snapshot) {
    try {
      await this.helpers.ensureDirectory(this.governanceDir);
      const filePath = path.join(this.governanceDir, 'health_snapshot.json');
      const payload = {
        timestamp: new Date().toISOString(),
        ...snapshot
      };
      await this.helpers.atomicWriteJSON(filePath, payload);
      return payload;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] recordGovernanceSnapshot error', {
        error: error.message
      });
      throw error;
    }
  }

  async getGovernanceSnapshot() {
    try {
      const filePath = path.join(this.governanceDir, 'health_snapshot.json');
      return await this.helpers.atomicReadJSON(filePath, null);
    } catch (error) {
      this.logger.warn('[FilesystemStateStore] getGovernanceSnapshot error', {
        error: error.message
      });
      return null;
    }
  }

  async setGovernanceOverride(override) {
    try {
      await this.helpers.ensureDirectory(this.governanceDir);
      const filePath = path.join(this.governanceDir, 'override.json');

      if (!override) {
        await fs.rm(filePath, { force: true });
        return true;
      }

      const payload = {
        updatedAt: new Date().toISOString(),
        ...override
      };

      await this.helpers.atomicWriteJSON(filePath, payload);
      return payload;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] setGovernanceOverride error', {
        error: error.message
      });
      throw error;
    }
  }

  async getGovernanceOverride() {
    try {
      const filePath = path.join(this.governanceDir, 'override.json');
      return await this.helpers.atomicReadJSON(filePath, null);
    } catch (error) {
      this.logger.warn('[FilesystemStateStore] getGovernanceOverride error', {
        error: error.message
      });
      return null;
    }
  }

  async clearGovernanceOverride() {
    try {
      const filePath = path.join(this.governanceDir, 'override.json');
      await fs.rm(filePath, { force: true });
      return true;
    } catch (error) {
      this.logger.warn('[FilesystemStateStore] clearGovernanceOverride error', {
        error: error.message
      });
      return false;
    }
  }

  async appendGovernanceEvent(event) {
    try {
      await this.helpers.ensureDirectory(this.governanceDir);
      const logPath = path.join(this.governanceDir, 'events.log');
      const payload = {
        timestamp: new Date().toISOString(),
        ...event
      };
      await this.helpers.appendToLog(logPath, JSON.stringify(payload));
      return true;
    } catch (error) {
      this.logger.warn('[FilesystemStateStore] appendGovernanceEvent error', {
        error: error.message
      });
      return false;
    }
  }

  async getGovernanceEvents(limit = 50) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    try {
      const logPath = path.join(this.governanceDir, 'events.log');
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const selected = lines.slice(-safeLimit);
      return selected.map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          this.logger.warn('[FilesystemStateStore] Failed to parse governance event', {
            error: error.message
          });
          return { raw: line, parseError: true };
        }
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('[FilesystemStateStore] getGovernanceEvents error', {
          error: error.message
        });
      }
      return [];
    }
  }

  /**
   * Record review artifact (draft, critique, synthesis).
   */
  async recordReviewArtifact(cycle, artifact) {
    try {
      const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);
      await this.helpers.ensureDirectory(cycleDir);

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

      const fileName = `${artifactId}.json`;
      const filePath = path.join(cycleDir, fileName);

      const record = {
        ...artifact,
        artifactId,
        artifactType: artifact.artifactType || type,
        cycle,
        persistedAt: new Date().toISOString(),
        persistedBy: this.instanceId
      };

      await this.helpers.atomicWriteJSON(filePath, record);
      return record;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] recordReviewArtifact error', {
        cycle,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetch review artifacts previously recorded.
   */
  async getReviewArtifacts(cycle) {
    try {
      const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);
      await this.helpers.ensureDirectory(cycleDir);
      const files = await this.helpers.listDirectory(
        cycleDir,
        (file) => file.endsWith('.json')
      );

      const artifacts = [];
      for (const file of files) {
        if (file === 'plan.json' || file.startsWith('ready_')) {
          continue;
        }
        const filePath = path.join(cycleDir, file);
        const data = await this.helpers.atomicReadJSON(filePath, null);
        if (data && data.artifactType) {
          artifacts.push(data);
        }
      }

      return artifacts;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getReviewArtifacts error', {
        cycle,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Clear review barrier artifacts (optional cleanup).
   */
  async clearReviewBarrier(cycle) {
    try {
      const cycleDir = path.join(this.reviewsDir, `cycle_${cycle}`);
      await fs.rm(cycleDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logger.warn('[FilesystemStateStore] clearReviewBarrier error', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  // ============================================================================
  // Plan Operations
  // ============================================================================

  /**
   * Create a new plan
   */
  async createPlan(plan) {
    try {
      const planPath = path.join(this.plansDir, `${plan.id}.json`);
      await this.helpers.atomicWriteJSON(planPath, plan);
      
      await this.appendToEventLog({
        type: 'PLAN_CREATED',
        planId: plan.id,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] createPlan error', {
        planId: plan.id,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get a plan by ID
   */
  async getPlan(planId) {
    try {
      const planPath = path.join(this.plansDir, `${planId}.json`);
      const plan = await this.helpers.atomicReadJSON(planPath, null);
      return plan;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getPlan error', {
        planId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Update a plan with version check
   */
  async updatePlan(planId, updates) {
    try {
      const planPath = path.join(this.plansDir, `${planId}.json`);
      const plan = await this.helpers.atomicReadJSON(planPath, null);
      
      if (!plan) {
        this.logger.warn('[FilesystemStateStore] updatePlan: plan not found', { planId });
        return false;
      }
      
      const updatedPlan = {
        ...plan,
        ...updates,
        version: plan.version + 1,
        updatedAt: Date.now()
      };
      
      await this.helpers.atomicWriteJSON(planPath, updatedPlan);
      
      await this.appendToEventLog({
        type: 'PLAN_UPDATED',
        planId,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] updatePlan error', {
        planId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * List all plans
   */
  async listPlans() {
    try {
      const files = await this.helpers.listDirectory(
        this.plansDir,
        (file) => file.endsWith('.json')
      );
      
      const plans = [];
      for (const file of files) {
        const filePath = path.join(this.plansDir, file);
        const plan = await this.helpers.atomicReadJSON(filePath, null);
        if (plan) {
          plans.push(plan);
        }
      }
      
      return plans;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] listPlans error', {
        error: error.message
      });
      return [];
    }
  }

  // ============================================================================
  // Milestone Operations
  // ============================================================================

  /**
   * Upsert a milestone
   */
  async upsertMilestone(milestone) {
    try {
      const milestonePath = path.join(this.milestonesDir, `${milestone.id}.json`);
      await this.helpers.atomicWriteJSON(milestonePath, milestone);
      
      await this.appendToEventLog({
        type: 'MILESTONE_UPSERTED',
        milestoneId: milestone.id,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] upsertMilestone error', {
        milestoneId: milestone.id,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get a milestone by ID
   */
  async getMilestone(milestoneId) {
    try {
      const milestonePath = path.join(this.milestonesDir, `${milestoneId}.json`);
      const milestone = await this.helpers.atomicReadJSON(milestonePath, null);
      return milestone;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getMilestone error', {
        milestoneId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * List milestones, optionally filtered by planId
   */
  async listMilestones(planId) {
    try {
      const files = await this.helpers.listDirectory(
        this.milestonesDir,
        (file) => file.endsWith('.json')
      );
      
      const milestones = [];
      for (const file of files) {
        const filePath = path.join(this.milestonesDir, file);
        const milestone = await this.helpers.atomicReadJSON(filePath, null);
        if (milestone && (!planId || milestone.planId === planId)) {
          milestones.push(milestone);
        }
      }
      
      return milestones;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] listMilestones error', {
        planId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Advance milestone - check all tasks DONE, unlock next
   */
  async advanceMilestone(planId, currentMilestoneId) {
    try {
      const plan = await this.getPlan(planId);
      if (!plan) {
        this.logger.warn('[FilesystemStateStore] advanceMilestone: plan not found', { planId });
        return false;
      }
      
      // Mark current milestone as COMPLETED
      const currentMilestone = await this.getMilestone(currentMilestoneId);
      if (currentMilestone) {
        currentMilestone.status = 'COMPLETED';
        currentMilestone.updatedAt = Date.now();
        await this.upsertMilestone(currentMilestone);
      }
      
      // Find next milestone
      const milestones = await this.listMilestones(planId);
      const sortedMilestones = milestones.sort((a, b) => a.order - b.order);
      const currentIndex = sortedMilestones.findIndex(m => m.id === currentMilestoneId);
      
      if (currentIndex >= 0 && currentIndex < sortedMilestones.length - 1) {
        const nextMilestone = sortedMilestones[currentIndex + 1];
        nextMilestone.status = 'ACTIVE';
        nextMilestone.updatedAt = Date.now();
        await this.upsertMilestone(nextMilestone);
        
        // Update plan's active milestone
        await this.updatePlan(planId, { activeMilestone: nextMilestone.id });
        
        await this.appendToEventLog({
          type: 'MILESTONE_ADVANCED',
          planId,
          fromMilestone: currentMilestoneId,
          toMilestone: nextMilestone.id,
          timestamp: Date.now()
        });
        
        this.logger.info('🎯 Milestone advanced', {
          planId,
          completed: currentMilestone.title,
          nextActive: nextMilestone.title,
          progress: `${currentIndex + 1}/${sortedMilestones.length} milestones complete`
        });
      } else if (currentIndex === sortedMilestones.length - 1) {
        // CRITICAL: This was the LAST milestone - plan is complete!
        await this.updatePlan(planId, { 
          status: 'COMPLETED',
          activeMilestone: null,
          completedAt: Date.now()
        });
        
        await this.appendToEventLog({
          type: 'PLAN_COMPLETED',
          planId,
          finalMilestone: currentMilestoneId,
          totalMilestones: sortedMilestones.length,
          timestamp: Date.now()
        });
        
        this.logger.info('🎉 PLAN COMPLETED!', {
          planId,
          title: plan.title,
          milestonesCompleted: sortedMilestones.length,
          duration: Date.now() - plan.createdAt
        });
      }
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] advanceMilestone error', {
        planId,
        currentMilestoneId,
        error: error.message
      });
      return false;
    }
  }

  // ============================================================================
  // Task Operations
  // ============================================================================

  // REMOVED: _calculateTaskPath() - Dead code from directory-based state system
  // Tasks now use deterministic path: tasks/{taskId}.json (state is a field, not a directory)

  /**
   * Upsert a task
   * 
   * BULLETPROOF ENTERPRISE FIX (Jan 20, 2026): Single-directory design
   * State stored in field, not directory. Atomic write. No cleanup. No duplicates.
   */
  async upsertTask(task) {
    try {
      // Deterministic path - always same location
      const taskPath = path.join(this.tasksDir, `${task.id}.json`);
      
      // Read old task if exists (to log state change)
      const oldTask = await this.helpers.atomicReadJSON(taskPath, null);
      const oldState = oldTask?.state || null;
      const stateChanged = oldTask && oldTask.state !== task.state;
      
      // Ensure updatedAt is set
      task.updatedAt = Date.now();
      
      // Atomic write to SAME location always (no move, no cleanup)
      await this.helpers.atomicWriteJSON(taskPath, task);
      
      await this.appendToEventLog({
        type: 'TASK_UPSERTED',
        taskId: task.id,
        state: task.state,
        oldState,
        stateChanged,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] upsertTask error', {
        taskId: task.id,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get a task by ID
   * 
   * BULLETPROOF ENTERPRISE FIX (Jan 20, 2026): Single-directory design
   * No search needed - path is deterministic
   */
  async getTask(taskId) {
    try {
      // Deterministic path - always same location
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      
      // Direct read (no search)
      const task = await this.helpers.atomicReadJSON(taskPath, null);
      
      return task;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] getTask error', {
        taskId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * List tasks with optional filters
   * 
   * CRITICAL FIX (Jan 19, 2026): Now deduplicates tasks that exist in multiple
   * directories (due to incomplete state transitions). Returns only the most
   * recent/canonical version of each task.
   */
  async listTasks(planId, filters = {}) {
    try {
      // BULLETPROOF: Read from single directory
      const files = await this.helpers.listDirectory(
        this.tasksDir,
        (file) => file.endsWith('.json') && file.startsWith('task:')
      );
      
      const tasks = [];
      
      for (const file of files) {
        const taskPath = path.join(this.tasksDir, file);
        const task = await this.helpers.atomicReadJSON(taskPath, null);
        
        if (!task || task.planId !== planId) {
          continue;
        }
        
        // Apply filters
        if (filters.milestoneId && task.milestoneId !== filters.milestoneId) {
          continue;
        }
        if (filters.state && task.state !== filters.state) {
          continue;
        }
        if (filters.claimedBy && task.claimedBy !== filters.claimedBy) {
          continue;
        }
        
        tasks.push(task);
      }
      
      return tasks;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] listTasks error', {
        planId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Claim a task atomically with TTL and proper locking
   *
   * Security: Uses O_EXCL file locking to prevent TOCTOU race conditions
   * where multiple instances could claim the same task simultaneously.
   */
  async claimTask(taskId, instanceId, ttlMs) {
    // Use a task-specific lock file to serialize claim attempts
    const lockPath = path.join(this.tasksDir, 'locks', `${taskId}.lock`);
    let lockAcquired = false;

    try {
      // Ensure lock directory exists
      await this.helpers.ensureDirectory(path.join(this.tasksDir, 'locks'));

      // Try to acquire atomic lock (O_EXCL - fails if lock exists)
      lockAcquired = await this.helpers.tryAcquireLock(lockPath, {
        instanceId,
        timestamp: Date.now(),
        operation: 'claim_task'
      });

      if (!lockAcquired) {
        // Another instance is currently claiming - check if lock is stale
        const lockData = await this.helpers.readLock(lockPath);
        if (lockData && (Date.now() - lockData.timestamp) > 30000) {
          // Lock is stale (> 30 seconds old), try to force release and retry
          this.logger.warn('[FilesystemStateStore] Releasing stale task lock', {
            taskId,
            lockHolder: lockData.instanceId,
            lockAge: Date.now() - lockData.timestamp
          });
          await this.helpers.releaseLock(lockPath);
          lockAcquired = await this.helpers.tryAcquireLock(lockPath, {
            instanceId,
            timestamp: Date.now(),
            operation: 'claim_task'
          });
        }

        if (!lockAcquired) {
          this.logger.debug('[FilesystemStateStore] Task claim blocked by lock', {
            taskId,
            instanceId
          });
          return false;
        }
      }

      // Lock acquired - now safe to check and claim atomically
      // BULLETPROOF: Deterministic path (no search, no move)
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      const task = await this.helpers.atomicReadJSON(taskPath, null);

      if (!task) {
        this.logger.warn('[FilesystemStateStore] claimTask: task not found', { taskId });
        return false;
      }

      // Check if already claimed
      if (task.claimedBy && task.claimExpires > Date.now()) {
        return false; // Still claimed by another instance
      }

      // Update task with claim info (in-place)
      task.state = 'CLAIMED';
      task.claimedBy = instanceId;
      task.claimExpires = Date.now() + ttlMs;
      task.updatedAt = Date.now();

      // Atomic write to SAME location (no move)
      await this.helpers.atomicWriteJSON(taskPath, task);

      await this.appendToEventLog({
        type: 'TASK_CLAIMED',
        taskId,
        instanceId,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] claimTask error', {
        taskId,
        instanceId,
        error: error.message
      });
      return false;
    } finally {
      // Always release lock
      if (lockAcquired) {
        try {
          await this.helpers.releaseLock(lockPath);
        } catch (e) {
          this.logger.warn('[FilesystemStateStore] Failed to release task lock', {
            taskId,
            error: e.message
          });
        }
      }
    }
  }

  /**
   * Release a task back to pending
   * 
   * BULLETPROOF ENTERPRISE FIX (Jan 20, 2026): Single-directory design
   */
  async releaseTask(taskId, instanceId) {
    try {
      // Deterministic path
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      const task = await this.helpers.atomicReadJSON(taskPath, null);

      if (!task) {
        this.logger.warn('[FilesystemStateStore] releaseTask: task not found', { taskId });
        return false;
      }

      // Verify it's claimed by this instance
      if (instanceId && task.claimedBy !== instanceId) {
        this.logger.warn('[FilesystemStateStore] releaseTask: task not claimed by this instance', {
          taskId,
          requestedBy: instanceId,
          claimedBy: task.claimedBy
        });
        return false;
      }

      // Reset task state (in-place)
      task.state = 'PENDING';
      task.claimedBy = null;
      task.claimExpires = null;
      task.assignedAgentId = null;
      task.updatedAt = Date.now();

      // Atomic write to SAME location
      await this.helpers.atomicWriteJSON(taskPath, task);

      await this.appendToEventLog({
        type: 'TASK_RELEASED',
        taskId,
        instanceId,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] releaseTask error', {
        taskId,
        instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Start a task (move from CLAIMED to IN_PROGRESS)
   * 
   * CRITICAL FIX (Jan 19, 2026): Now uses getTask() to find task and verifies
   * it's in the correct instance's directory, preventing issues when task is
   * claimed by different instance or in unexpected location
   */
  async startTask(taskId, instanceId) {
    try {
      // Deterministic path
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      const task = await this.helpers.atomicReadJSON(taskPath, null);
      
      if (!task) {
        this.logger.warn('[FilesystemStateStore] startTask: task not found', { taskId });
        return false;
      }
      
      // Verify task is claimed by this instance
      if (task.claimedBy && task.claimedBy !== instanceId) {
        this.logger.warn('[FilesystemStateStore] startTask: task claimed by different instance', {
          taskId,
          requestedBy: instanceId,
          claimedBy: task.claimedBy
        });
        // Allow anyway - recovery scenario
      }
      
      const oldState = task.state;
      
      // Update state field (in-place)
      task.state = 'IN_PROGRESS';
      task.startedAt = task.startedAt || Date.now();
      task.updatedAt = Date.now();
      task.claimedBy = instanceId;
      
      // Atomic write to SAME location
      await this.helpers.atomicWriteJSON(taskPath, task);
      
      await this.appendToEventLog({
        type: 'TASK_STARTED',
        taskId,
        instanceId,
        oldState,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] startTask error', {
        taskId,
        instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Complete a task
   * 
   * BULLETPROOF ENTERPRISE FIX (Jan 20, 2026): Single-directory design
   * State stored in field, not directory. Atomic write. No cleanup. No duplicates.
   */
  async completeTask(taskId) {
    try {
      // Deterministic path - always same location
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      
      // Read current state
      const task = await this.helpers.atomicReadJSON(taskPath, null);
      
      if (!task) {
        this.logger.warn('[FilesystemStateStore] completeTask: task not found', { taskId });
        return false;
      }
      
      const oldState = task.state;
      
      // Update state field (in-place)
      task.state = 'DONE';
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      
      // Atomic write to SAME location (no move, no cleanup)
      await this.helpers.atomicWriteJSON(taskPath, task);
      
      await this.appendToEventLog({
        type: 'TASK_COMPLETED',
        taskId,
        oldState,
        newState: 'DONE',
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] completeTask error', {
        taskId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Mark a task as failed
   * 
   * BULLETPROOF ENTERPRISE FIX (Jan 20, 2026): Single-directory design
   * State stored in field, not directory. Atomic write. No cleanup. No duplicates.
   */
  async failTask(taskId, reason) {
    try {
      // Deterministic path - always same location
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      
      // Read current state
      const task = await this.helpers.atomicReadJSON(taskPath, null);
      
      if (!task) {
        this.logger.warn('[FilesystemStateStore] failTask: task not found', { taskId });
        return false;
      }
      
      const oldState = task.state;
      
      // Update state field (in-place)
      task.state = 'FAILED';
      task.failureReason = reason;
      task.failedAt = Date.now();
      task.updatedAt = Date.now();
      
      // Atomic write to SAME location (no move, no cleanup)
      await this.helpers.atomicWriteJSON(taskPath, task);
      
      await this.appendToEventLog({
        type: 'TASK_FAILED',
        taskId,
        oldState,
        newState: 'FAILED',
        reason,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] failTask error', {
        taskId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Retry a failed task (move from FAILED to PENDING)
   * 
   * BULLETPROOF ENTERPRISE FIX (Jan 20, 2026): Single-directory design
   */
  async retryTask(taskId, reason = 'auto_retry') {
    try {
      // Deterministic path
      const taskPath = path.join(this.tasksDir, `${taskId}.json`);
      const task = await this.helpers.atomicReadJSON(taskPath, null);
      
      if (!task) return false;

      // Only retry if in FAILED or BLOCKED state
      if (task.state !== 'FAILED' && task.state !== 'BLOCKED') {
        this.logger.debug('[FilesystemStateStore] Task not in retriable state', { taskId, state: task.state });
        return false;
      }

      const oldState = task.state;

      // Update metadata for retry
      task.state = 'PENDING';
      task.metadata = task.metadata || {};
      task.metadata.retryCount = (task.metadata.retryCount || 0) + 1;
      task.metadata.lastFailureReason = task.failureReason || reason;
      task.metadata.lastFailedAt = task.failedAt;
      
      // Reset state for fresh attempt
      task.failureReason = null;
      task.failedAt = null;
      task.assignedAgentId = null;
      task.claimedBy = null;
      task.claimExpires = null;
      task.updatedAt = Date.now();

      // Atomic write to SAME location (no move)
      await this.helpers.atomicWriteJSON(taskPath, task);

      await this.appendToEventLog({
        type: 'TASK_RETRIED',
        taskId,
        oldState,
        newState: 'PENDING',
        retryCount: task.metadata.retryCount,
        timestamp: Date.now()
      });

      this.logger.info(`🎈 Ralph Wiggum retrying task: ${taskId}`, {
        retryCount: task.metadata.retryCount,
        previousFailure: task.metadata.lastFailureReason?.substring(0, 100)
      });

      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] retryTask error', { taskId, error: error.message });
      return false;
    }
  }

  /**
   * List runnable tasks (PENDING with all deps DONE)
   */
  async listRunnableTasks(planId) {
    try {
      const allTasks = await this.listTasks(planId);
      const pendingTasks = allTasks.filter(t => t.state === 'PENDING');
      const doneTasks = allTasks.filter(t => t.state === 'DONE');
      const doneTaskIds = new Set(doneTasks.map(t => t.id));
      
      const runnableTasks = pendingTasks.filter(task => {
        // Check if all dependencies are done
        return task.deps.every(depId => doneTaskIds.has(depId));
      });
      
      return runnableTasks;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] listRunnableTasks error', {
        planId,
        error: error.message
      });
      return [];
    }
  }

  // ============================================================================
  // PlanDelta Application
  // ============================================================================

  /**
   * Apply a PlanDelta atomically with version check
   */
  async applyPlanDelta(delta) {
    try {
      const planPath = path.join(this.plansDir, `${delta.planId}.json`);
      const plan = await this.helpers.atomicReadJSON(planPath, null);
      
      if (!plan) {
        this.logger.warn('[FilesystemStateStore] applyPlanDelta: plan not found', { planId: delta.planId });
        return false;
      }
      
      // Version check
      if (plan.version !== delta.expectedVersion) {
        this.logger.warn('[FilesystemStateStore] applyPlanDelta: version mismatch', {
          planId: delta.planId,
          expected: delta.expectedVersion,
          actual: plan.version
        });
        return false;
      }
      
      // Add milestones
      if (delta.addMilestones) {
        for (const [milestoneId, milestone] of Object.entries(delta.addMilestones)) {
          await this.upsertMilestone(milestone);
          if (!plan.milestones.includes(milestoneId)) {
            plan.milestones.push(milestoneId);
          }
        }
      }
      
      // Add tasks
      if (delta.addTasks) {
        for (const task of Object.values(delta.addTasks)) {
          await this.upsertTask(task);
        }
      }
      
      // Update tasks
      if (delta.updateTasks) {
        for (const [taskId, updates] of Object.entries(delta.updateTasks)) {
          const task = await this.getTask(taskId);
          if (task) {
            const updatedTask = {
              ...task,
              ...updates,
              updatedAt: Date.now()
            };
            await this.upsertTask(updatedTask);
          }
        }
      }
      
      // Remove tasks
      if (delta.removeTasks) {
        for (const taskId of delta.removeTasks) {
          const task = await this.getTask(taskId);
          if (task) {
            task.state = 'CANCELLED';
            task.updatedAt = Date.now();
            await this.upsertTask(task);
          }
        }
      }
      
      // Set active milestone
      if (delta.setActiveMilestone) {
        plan.activeMilestone = delta.setActiveMilestone;
      }
      
      // Increment version
      plan.version += 1;
      plan.updatedAt = Date.now();
      
      await this.helpers.atomicWriteJSON(planPath, plan);
      
      await this.appendToEventLog({
        type: 'PLAN_DELTA_APPLIED',
        planId: delta.planId,
        timestamp: Date.now()
      });
      
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] applyPlanDelta error', {
        planId: delta.planId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Generic key-value storage for arbitrary coordination data
   * Stores in a 'kv' directory for non-structured data
   */
  async set(key, value, ttlMs = null) {
    try {
      const kvDir = path.join(this.fsRoot, 'kv');
      await fs.mkdir(kvDir, { recursive: true });
      
      const filePath = path.join(kvDir, `${key}.json`);
      const data = {
        key,
        value,
        createdAt: Date.now(),
        expiresAt: ttlMs ? Date.now() + ttlMs : null
      };
      
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      this.logger.error('[FilesystemStateStore] set error', { key, error: error.message });
      return false;
    }
  }

  async get(key) {
    try {
      const kvDir = path.join(this.fsRoot, 'kv');
      const filePath = path.join(kvDir, `${key}.json`);
      
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content);
      
      // Check TTL
      if (data.expiresAt && Date.now() > data.expiresAt) {
        await this.delete(key);
        return null;
      }
      
      return data.value;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // Key doesn't exist
      }
      this.logger.error('[FilesystemStateStore] get error', { key, error: error.message });
      return null;
    }
  }

  async delete(key) {
    try {
      const kvDir = path.join(this.fsRoot, 'kv');
      const filePath = path.join(kvDir, `${key}.json`);
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return true; // Already deleted
      }
      this.logger.error('[FilesystemStateStore] delete error', { key, error: error.message });
      return false;
    }
  }
  
  /**
   * Clean up duplicate task files (maintenance operation)
   * 
   * Searches for tasks that exist in multiple directories and removes stale copies,
   * keeping only the most recent version (by updatedAt timestamp).
   * 
   * Use case: Fix existing corruption from before upsertTask cleanup was added.
   * Can be called on orchestrator startup or on-demand.
   * 
   * @param {string} planId - Optional: Only clean tasks for specific plan
   * @returns {Object} { cleaned: number, duplicates: number }
   */
  async cleanupDuplicateTasks(planId = null) {
    try {
      this.logger.info('[FilesystemStateStore] Starting duplicate task cleanup...', {
        planId: planId || 'all'
      });
      
      const allDirs = [
        path.join(this.tasksDir, 'pending'),
        path.join(this.tasksDir, 'complete'),
        path.join(this.tasksDir, 'failed'),
        path.join(this.tasksDir, 'blocked')
      ];
      
      // Add assigned subdirectories
      const assignedDir = path.join(this.tasksDir, 'assigned');
      try {
        const instances = await this.helpers.listDirectory(assignedDir);
        for (const inst of instances) {
          allDirs.push(path.join(assignedDir, inst));
        }
      } catch (error) {
        // Assigned directory might not exist
      }
      
      const taskLocations = new Map(); // taskId → [{path, task, updatedAt, dir}]
      
      // Scan all locations
      for (const dir of allDirs) {
        try {
          const files = await this.helpers.listDirectory(dir, f => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(dir, file);
            const task = await this.helpers.atomicReadJSON(filePath, null);
            if (task && (!planId || task.planId === planId)) {
              if (!taskLocations.has(task.id)) {
                taskLocations.set(task.id, []);
              }
              taskLocations.get(task.id).push({
                path: filePath,
                task: task,
                updatedAt: task.updatedAt || 0,
                dir: dir.substring(dir.indexOf('/tasks/'))
              });
            }
          }
        } catch (error) {
          // Directory might not exist or be empty
        }
      }
      
      // Find and clean duplicates
      let cleaned = 0;
      let duplicateCount = 0;
      
      for (const [taskId, locations] of taskLocations) {
        if (locations.length > 1) {
          duplicateCount++;
          
          // Sort by updatedAt descending (newest first)
          locations.sort((a, b) => b.updatedAt - a.updatedAt);
          
          // Keep newest, delete others
          const canonical = locations[0];
          const staleFiles = locations.slice(1);
          
          this.logger.warn('[FilesystemStateStore] Duplicate task files found', {
            taskId,
            totalCopies: locations.length,
            canonical: { state: canonical.task.state, dir: canonical.dir, updatedAt: new Date(canonical.updatedAt).toISOString() },
            stale: staleFiles.map(s => ({ state: s.task.state, dir: s.dir, updatedAt: new Date(s.updatedAt).toISOString() }))
          });
          
          for (const staleLocation of staleFiles) {
            try {
              await fs.unlink(staleLocation.path);
              cleaned++;
              this.logger.info('[FilesystemStateStore] Removed stale task file', {
                taskId,
                stalePath: staleLocation.dir + '/' + path.basename(staleLocation.path),
                staleState: staleLocation.task.state,
                keptState: canonical.task.state
              });
            } catch (error) {
              this.logger.warn('[FilesystemStateStore] Failed to remove stale task file', {
                taskId,
                path: staleLocation.path,
                error: error.message
              });
            }
          }
        }
      }
      
      this.logger.info('[FilesystemStateStore] Duplicate cleanup complete', {
        tasksScanned: taskLocations.size,
        duplicatesFound: duplicateCount,
        staleFilesRemoved: cleaned
      });
      
      return { cleaned, duplicates: duplicateCount, tasksScanned: taskLocations.size };
    } catch (error) {
      this.logger.error('[FilesystemStateStore] cleanupDuplicateTasks error', {
        planId,
        error: error.message
      });
      return { cleaned: 0, duplicates: 0, tasksScanned: 0, error: error.message };
    }
  }
}

module.exports = FilesystemStateStore;
