/**
 * FilesystemStateStore
 *
 * Filesystem backend for COSMO clustering (zero-infra, air-gapped, or HA NAS deployment).
 * - Single-writer lease model (O_EXCL, temp+rename+fsync atomics)
 * - Term-gated commits for deterministic ordering
 * - Epoch transitions for coordination
 * - Deterministic replay from snapshot + event log
 *
 * Phase B-FS: Filesystem State Store + Single-Writer Apply
 *
 * FS Tree Structure:
 *   ${fsRoot}/
 *     control/
 *       leader.lock           # O_CREAT|O_EXCL, {leaderId, leaseExpiry, term, seqHi}
 *       CURRENT_EPOCH         # term counter
 *       CURRENT_SEQ           # sequence number (monotonic)
 *     epochs/E<N>/
 *       snapshot.tar.gz       # state snapshot
 *       offset.txt            # last log offset
 *     logs/
 *       events.log.YYYYMMDD   # append-only WAL
 *     goals/
 *       pending/, assigned/, acks/, complete/, revoked/
 *     instances/
 *       cosmo-*/heartbeat
 *     applied/                # diff_id and assign_id dedup markers
 */

class FilesystemStateStore {
  constructor(config) {
    this.config = config;
    this.fsRoot = config.fsRoot || '/cosmo_cluster';
    this.instanceId = config.instanceId || 'cosmo-1';
    this.currentEpoch = 0;
    this.currentSeq = 0;
    this.goalStore = new Map(); // goalId -> metadata snapshot
    this.governanceEvents = [];
  }

  /**
   * Initialize filesystem backend.
   */
  async connect() {
    // TODO Phase B-FS: Initialize FS tree
    // - Create control/, epochs/, logs/, goals/, instances/, applied/ directories
    // - Load current CURRENT_EPOCH and CURRENT_SEQ
    // - Setup file watchers (inotify) for goals/assigned/inst_*
  }

  /**
   * Disconnect filesystem backend.
   */
  async disconnect() {
    // TODO Phase B-FS: Cleanup file watchers
  }

  /**
   * Store memory node (single-writer apply, term-gated).
   * @param {string} nodeId - node identifier
   * @param {object} value - node value
   * @param {object} versionVector - version vector (for replay validation)
   * @param {number} ttl - optional TTL
   */
  async setMemory(nodeId, value, versionVector, ttl) {
    // TODO Phase B-FS: Single-writer apply
    // - Check current term/seq
    // - Write to memory store
    // - Track in applied/* for idempotency
  }

  /**
   * Retrieve memory node.
   * @param {string} nodeId - node identifier
   * @returns {object} - { value, versionVector, timestamp, sourceInstance }
   */
  async getMemory(nodeId) {
    // TODO Phase B-FS: Fetch from memory store (either current or snapshot)
  }

  /**
   * Submit diff for cycle.
   * @param {number} cycle - cycle number
   * @param {string} instanceId - instance ID
   * @param {object} diff - { diff_id, versionVector, fields }
   */
  async submitDiff(cycle, instanceId, diff) {
    // TODO Phase B-FS: Write diff to tmp/, rename to epochs/E<N>/diffs/
    // - Check idempotency (applied/diff_id)
    // - Append entry to events.log
  }

  /**
   * Get merged state after leader applies diffs.
   * @param {number} cycle - cycle number
   * @returns {object} - merged state snapshot
   */
  async getMergedState(cycle) {
    // TODO Phase B-FS: Fetch snapshot from epochs/E<N>/snapshot.tar.gz (or current)
  }

  /**
   * Claim goal atomically (single-writer assigns).
   * @param {string} goalId - goal identifier
   * @param {string} instanceId - claiming instance
   * @param {number} ttlMs - claim TTL
   * @returns {boolean} - true if claim succeeded
   */
  async claimGoal(goalId, instanceId, ttlMs) {
    const now = Date.now();
    const existing = this.goalStore.get(goalId);

    if (existing?.completed) {
      return false; // Completed goals should no longer be claimed
    }

    if (existing?.claimedBy && existing.claimExpires && existing.claimExpires > now && existing.claimedBy !== instanceId) {
      return false; // Another instance retains ownership
    }

    const claimCount = (existing?.claimCount || 0) + 1;
    const updated = {
      ...(existing || {}),
      goalId,
      claimedBy: instanceId,
      claimExpires: now + ttlMs,
      claimCount,
      lastClaimedAt: now,
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
      return true;
    }

    if (existing.claimedBy && instanceId && existing.claimedBy !== instanceId) {
      return false;
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
   * Append to immutable journal.
   * @param {object} entry - journal entry
   */
  async appendJournal(entry) {
    // TODO Phase B-FS: O_APPEND|O_DSYNC write to logs/events.log.YYYYMMDD
    // - Entry includes sourceInstance, trace_id, cycle
  }

  /**
   * Get journal entries (range query).
   * @param {number} startCycle - start cycle
   * @param {number} endCycle - end cycle
   * @returns {array} - journal entries
   */
  async getJournal(startCycle, endCycle) {
    // TODO Phase B-FS: Query logs/ for cycle range
  }

  /**
   * Validate configuration hash.
   * @param {string} configHash - SHA256 hash
   * @returns {boolean} - true if matches
   */
  async validateConfigHash(configHash) {
    // TODO Phase B-FS: Compare configHash with control/config.hash
    // - Mismatch = reject join
  }

  /**
   * Store configuration hash.
   * @param {string} configHash - SHA256 hash
   */
  async setConfigHash(configHash) {
    // TODO Phase B-FS: Write to control/config.hash (temp+rename+fsync)
  }

  /**
   * Set instance health beacon.
   * @param {string} instanceId - instance ID
   * @param {object} health - { cycle, memoryHash, ramUsage, errorCount, timestamp }
   */
  async setHealthBeacon(instanceId, health) {
    // TODO Phase B-FS: Write to instances/<instanceId>/heartbeat (temp+rename+fsync)
  }

  /**
   * Get instance health beacon.
   * @param {string} instanceId - instance ID
   * @returns {object} - health beacon
   */
  async getHealthBeacon(instanceId) {
    // TODO Phase B-FS: Read from instances/<instanceId>/heartbeat
  }

  /**
   * Get all health beacons.
   * @returns {object} - map of instanceId -> health
   */
  async getAllHealthBeacons() {
    // TODO Phase B-FS: Read all instances/*/heartbeat
  }

  /**
   * Acquire leadership via O_CREAT|O_EXCL lock.
   * @returns {boolean} - true if acquired
   */
  async acquireLeadership() {
    // TODO Phase D-FS: O_CREAT|O_EXCL create control/leader.lock
    // - Write { leaderId, leaseExpiry, term, seqHi }
    // - fsync(parent_dir)
    // - Return success
  }

  /**
   * Renew leadership lease via temp+rename+fsync(parent).
   * @returns {boolean} - true if renewal succeeded
   */
  async renewLeadership() {
    // TODO Phase D-FS: Temp file, rename to control/leader.lock, fsync(parent_dir)
    // - Must match term
    // - Extend leaseExpiry
  }

  /**
   * Release leadership.
   */
  async releaseLeadership() {
    // TODO Phase D-FS: Remove control/leader.lock
  }

  /**
   * Get current leader.
   * @returns {object} - { leaderId, leaseExpiry, term, seqHi }
   */
  async getCurrentLeader() {
    // TODO Phase D-FS: Read control/leader.lock (may not exist if leader down)
  }

  /**
   * Transition to new epoch (atomic flip).
   * @returns {number} - new epoch number
   */
  async transitionEpoch() {
    // TODO Phase D-FS: Stage under epochs/E<N>/, then
    // - Temp write to control/CURRENT_EPOCH
    // - rename() to control/CURRENT_EPOCH (atomic)
    // - fsync(parent_dir)
    // - Return new epoch
  }

  /**
   * Get current epoch.
   * @returns {number} - epoch number
   */
  async getCurrentEpoch() {
    // TODO Phase D-FS: Read control/CURRENT_EPOCH
    return this.currentEpoch;
  }

  /**
   * Submit goal assignment (leader only).
   * @param {array} assignments - list of { goalId, instanceId, assignId, ttl }
   */
  async submitAssignments(assignments) {
    // TODO Phase D-FS: For each assignment:
    // - Write to tmp/assign_<assignId>.json
    // - fsync(tmp)
    // - rename() to goals/assigned/inst_*/
    // - fsync(parent_dir)
    // - Append to events.log
  }

  /**
   * Fetch pending assignments for an instance (file watcher or poll).
   * @param {string} instanceId - instance ID
   * @returns {array} - pending assignments
   */
  async fetchPendingAssignments(instanceId) {
    // TODO Phase D-FS: Watch/poll goals/assigned/inst_<id>/
    // - Return list of assignments not yet ACKed
  }

  /**
   * Mark assignment done.
   * @param {string} assignId - assignment ID
   */
  async markAssignmentDone(assignId) {
    // TODO Phase D-FS: Write to goals/complete/<assignId>.done
  }

  /**
   * Revoke assignment (leader).
   * @param {string} assignId - assignment ID
   */
  async revokeAssignment(assignId) {
    // TODO Phase D-FS: Write to goals/revoked/<assignId>.rev
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

  /**
   * Get recovery SBOM (state for rejoining instance).
   * @returns {object} - { lastEpoch, lastSeq, snapshot, logOffset }
   */
  async getRecoverySBOM() {
    // TODO Phase B-FS: Return state needed for recovery join
    // - Last complete epoch
    // - Last log offset
    // - Snapshot reference
  }

  /**
   * Deterministic replay from snapshot + log.
   * @param {string} snapshotPath - path to snapshot
   * @param {string} logPath - path to event log
   * @returns {object} - replayed state (byte-for-byte match)
   */
  deterministicReplay(snapshotPath, logPath) {
    // TODO Phase B-FS: Load snapshot, replay log, verify byte-for-byte match
    // - Used for validation and recovery
  }
}

module.exports = FilesystemStateStore;
