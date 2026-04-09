/**
 * ClusterStateStore
 *
 * Backend-agnostic abstraction for shared state (Redis or Filesystem).
 * Routes all operations to the appropriate backend based on config.
 *
 * L1: Shared State Store (from architecture)
 * - Stores: memory graph, goals, journal, cycle counter, health, config hash
 * - Supports pluggable backends: redis (CRDT active/active) or filesystem (single-writer lease)
 */

class ClusterStateStore {
  constructor(config, backend) {
    this.config = config;
    this.backend = backend; // RedisStateStore or FilesystemStateStore instance
    this.isConnected = false;
    this.readOnly = config.readOnly || false; // Passive observer mode for dashboards/queries
  }

  /**
   * Initialize and connect to the backend.
   */
  async connect() {
    if (this.isConnected) return;
    await this.backend.connect();
    this.isConnected = true;
  }

  /**
   * Disconnect from backend.
   */
  async disconnect() {
    if (!this.isConnected) return;
    await this.backend.disconnect();
    this.isConnected = false;
  }

  /**
   * Store a memory node with CRDT semantics or single-writer apply.
   * @param {string} nodeId - unique node identifier
   * @param {object} value - node value
   * @param {object} versionVector - version vector for CRDT merge
   * @param {number} ttl - optional TTL in ms
   */
  async setMemory(nodeId, value, versionVector, ttl) {
    return this.backend.setMemory(nodeId, value, versionVector, ttl);
  }

  /**
   * Retrieve a memory node.
   * @param {string} nodeId - node identifier
   * @returns {object} - { value, versionVector, timestamp, sourceInstance }
   */
  async getMemory(nodeId) {
    return this.backend.getMemory(nodeId);
  }

  /**
   * Submit a diff for the current cycle.
   * @param {number} cycle - cycle number
   * @param {string} instanceId - instance ID
   * @param {object} diff - { diff_id, versionVector, fields: { nodeId: { op, value, timestamp } } }
   */
  async submitDiff(cycle, instanceId, diff) {
    return this.backend.submitDiff(cycle, instanceId, diff);
  }

  /**
   * Fetch all pending diffs for a cycle (leader only).
   * @param {number} cycle
   * @returns {Array} diffs
   */
  async fetchDiffs(cycle) {
    return this.backend.fetchDiffs
      ? this.backend.fetchDiffs(cycle)
      : [];
  }

  /**
   * Fetch merged state after leader applies diffs.
   * @param {number} cycle - cycle number
   * @returns {object} - merged state for all instances to fetch
   */
  async getMergedState(cycle) {
    return this.backend.getMergedState(cycle);
  }

  /**
   * Persist merged state snapshot (leader only).
   * @param {number} cycle
   * @param {object} mergedState
   */
  async setMergedState(cycle, mergedState) {
    return this.backend.setMergedState
      ? this.backend.setMergedState(cycle, mergedState)
      : false;
  }

  /**
   * Acknowledge and cleanup processed diffs.
   * @param {number} cycle
   * @param {Array} diffs
   */
  async acknowledgeDiffs(cycle, diffs) {
    if (this.backend.acknowledgeDiffs) {
      await this.backend.acknowledgeDiffs(cycle, diffs);
    }
  }

  /**
   * Claim a goal atomically.
   * @param {string} goalId - goal identifier
   * @param {string} instanceId - claiming instance
   * @param {number} ttlMs - claim TTL
   * @returns {boolean} - true if claim succeeded, false if already claimed
   */
  async claimGoal(goalId, instanceId, ttlMs) {
    return this.backend.claimGoal(goalId, instanceId, ttlMs);
  }

  /**
   * Mark a goal as completed.
   * @param {string} goalId - goal identifier
   */
  async completeGoal(goalId) {
    return this.backend.completeGoal(goalId);
  }

  /**
   * Release a goal claim without marking complete.
   * @param {string} goalId
   * @param {string} instanceId
   */
  async releaseGoal(goalId, instanceId) {
    if (this.backend.releaseGoal) {
      return this.backend.releaseGoal(goalId, instanceId);
    }
    return false;
  }

  /**
   * Append to the immutable journal.
   * @param {object} entry - journal entry
   */
  async appendJournal(entry) {
    return this.backend.appendJournal(entry);
  }

  /**
   * Get journal entries (range query).
   * @param {number} startCycle - start cycle
   * @param {number} endCycle - end cycle
   * @returns {array} - journal entries
   */
  async getJournal(startCycle, endCycle) {
    return this.backend.getJournal(startCycle, endCycle);
  }

  /**
   * Validate configuration hash (all instances must match).
   * @param {string} configHash - SHA256 hash of cluster config
   * @returns {boolean} - true if valid, false if mismatch
   */
  async validateConfigHash(configHash) {
    return this.backend.validateConfigHash(configHash);
  }

  /**
   * Store configuration hash.
   * @param {string} configHash - SHA256 hash
   */
  async setConfigHash(configHash) {
    return this.backend.setConfigHash(configHash);
  }

  /**
   * Health beacon: record instance health status.
   * @param {string} instanceId - instance ID
   * @param {object} health - { cycle, memoryHash, ramUsage, errorCount, timestamp }
   */
  async setHealthBeacon(instanceId, health) {
    return this.backend.setHealthBeacon(instanceId, health);
  }

  /**
   * Fetch health beacon for an instance.
   * @param {string} instanceId - instance ID
   * @returns {object} - health beacon
   */
  async getHealthBeacon(instanceId) {
    return this.backend.getHealthBeacon(instanceId);
  }

  /**
   * Get all health beacons.
   * @returns {object} - map of instanceId -> health
   */
  async getAllHealthBeacons() {
    return this.backend.getAllHealthBeacons();
  }

  /**
   * Record review readiness for barrier coordination.
   * @param {number} cycle - review cycle
   * @param {string} instanceId - instance ID
   * @param {object} payload - readiness payload
   */
  async recordReviewReadiness(cycle, instanceId, payload) {
    if (this.backend.recordReviewReadiness) {
      return this.backend.recordReviewReadiness(cycle, instanceId, payload);
    }
    return false;
  }

  /**
   * Await review barrier until quorum or timeout reached.
   * @param {number} cycle - review cycle
   * @param {number} quorum - minimum ready instances
   * @param {number} timeoutMs - timeout in milliseconds
   * @returns {object} barrier result ({ status, readyCount, readyInstances, durationMs })
   */
  async awaitReviewBarrier(cycle, quorum, timeoutMs) {
    if (this.backend.awaitReviewBarrier) {
      return this.backend.awaitReviewBarrier(cycle, quorum, timeoutMs);
    }
    return { status: 'unsupported', readyCount: 0, readyInstances: [] };
  }

  /**
   * Clear review barrier state for a cycle.
   * @param {number} cycle - review cycle
   */
  async clearReviewBarrier(cycle) {
    if (this.backend.clearReviewBarrier) {
      return this.backend.clearReviewBarrier(cycle);
    }
    return false;
  }

  /**
   * Persist review plan for a cycle (idempotent).
   * @param {number} cycle
   * @param {object} plan
   */
  async createReviewPlan(cycle, plan) {
    if (this.backend.createReviewPlan) {
      return this.backend.createReviewPlan(cycle, plan);
    }
    return null;
  }

  /**
   * Retrieve review plan for a cycle.
   * @param {number} cycle
   * @returns {object|null}
   */
  async getReviewPlan(cycle) {
    if (this.backend.getReviewPlan) {
      return this.backend.getReviewPlan(cycle);
    }
    return null;
  }

  /**
   * Record review artifact (draft, critique, synthesis).
   * @param {number} cycle
   * @param {object} artifact
   * @returns {object|null}
   */
  async recordReviewArtifact(cycle, artifact) {
    if (this.backend.recordReviewArtifact) {
      return this.backend.recordReviewArtifact(cycle, artifact);
    }
    return null;
  }

  /**
   * Retrieve review artifacts for a cycle.
   * @param {number} cycle
   * @returns {Array}
   */
  async getReviewArtifacts(cycle) {
    if (this.backend.getReviewArtifacts) {
      return this.backend.getReviewArtifacts(cycle);
    }
    return [];
  }

  /**
   * Append review event for audit trail.
   * @param {number} cycle
   * @param {object} event
   */
  async appendReviewEvent(cycle, event) {
    if (this.backend.appendReviewEvent) {
      return this.backend.appendReviewEvent(cycle, event);
    }
    return false;
  }

  /**
   * Record governance snapshot (cluster-wide health state).
   * @param {object} snapshot
   */
  async recordGovernanceSnapshot(snapshot) {
    if (this.backend.recordGovernanceSnapshot) {
      return this.backend.recordGovernanceSnapshot(snapshot);
    }
    return false;
  }

  /**
   * Fetch latest governance snapshot.
   * @returns {object|null}
   */
  async getGovernanceSnapshot() {
    if (this.backend.getGovernanceSnapshot) {
      return this.backend.getGovernanceSnapshot();
    }
    return null;
  }

  /**
   * Set governance override (manual operator command).
   * @param {object|null} override
   */
  async setGovernanceOverride(override) {
    if (this.backend.setGovernanceOverride) {
      return this.backend.setGovernanceOverride(override);
    }
    return false;
  }

  /**
   * Retrieve governance override if present.
   * @returns {object|null}
   */
  async getGovernanceOverride() {
    if (this.backend.getGovernanceOverride) {
      return this.backend.getGovernanceOverride();
    }
    return null;
  }

  /**
   * Clear governance override.
   */
  async clearGovernanceOverride() {
    if (this.backend.clearGovernanceOverride) {
      return this.backend.clearGovernanceOverride();
    }
    return false;
  }

  /**
   * Append governance event (separate from review events).
   * @param {object} event
   */
  async appendGovernanceEvent(event) {
    if (this.backend.appendGovernanceEvent) {
      return this.backend.appendGovernanceEvent(event);
    }
    return false;
  }

  /**
   * Retrieve recent governance events (override requests, skips, failures).
   * @param {number} limit - maximum number of events to return
   * @returns {Array}
   */
  async getGovernanceEvents(limit = 50) {
    if (this.backend.getGovernanceEvents) {
      return this.backend.getGovernanceEvents(limit);
    }
    return [];
  }

  // ============================================================
  // Plan/Task/Milestone Operations (Phase 2 - Task Storage)
  // ============================================================

  /**
   * Create a new Plan
   * @param {object} plan - Plan object
   */
  async createPlan(plan) {
    if (this.backend.createPlan) {
      return this.backend.createPlan(plan);
    }
    throw new Error('Backend does not support createPlan');
  }

  /**
   * Get a Plan by ID
   * @param {string} planId
   * @returns {object|null}
   */
  async getPlan(planId) {
    if (this.backend.getPlan) {
      return this.backend.getPlan(planId);
    }
    return null;
  }

  /**
   * Update an existing Plan
   * @param {string} planId
   * @param {object} updates
   */
  async updatePlan(planId, updates) {
    if (this.backend.updatePlan) {
      return this.backend.updatePlan(planId, updates);
    }
    throw new Error('Backend does not support updatePlan');
  }

  /**
   * List all Plans
   * @returns {Array}
   */
  async listPlans() {
    if (this.backend.listPlans) {
      return this.backend.listPlans();
    }
    return [];
  }

  /**
   * Create or update a Milestone
   * @param {object} milestone
   */
  async upsertMilestone(milestone) {
    if (this.backend.upsertMilestone) {
      return this.backend.upsertMilestone(milestone);
    }
    throw new Error('Backend does not support upsertMilestone');
  }

  /**
   * Get a Milestone by ID
   * @param {string} milestoneId
   * @returns {object|null}
   */
  async getMilestone(milestoneId) {
    if (this.backend.getMilestone) {
      return this.backend.getMilestone(milestoneId);
    }
    return null;
  }

  /**
   * List Milestones for a Plan
   * @param {string} planId
   * @returns {Array}
   */
  async listMilestones(planId) {
    if (this.backend.listMilestones) {
      return this.backend.listMilestones(planId);
    }
    return [];
  }

  /**
   * Advance to next Milestone
   * @param {string} planId
   * @param {string} currentMilestoneId
   */
  async advanceMilestone(planId, currentMilestoneId) {
    if (this.backend.advanceMilestone) {
      return this.backend.advanceMilestone(planId, currentMilestoneId);
    }
    throw new Error('Backend does not support advanceMilestone');
  }

  /**
   * Create or update a Task
   * @param {object} task
   */
  async upsertTask(task) {
    if (this.backend.upsertTask) {
      return this.backend.upsertTask(task);
    }
    throw new Error('Backend does not support upsertTask');
  }

  /**
   * Get a Task by ID
   * @param {string} taskId
   * @returns {object|null}
   */
  async getTask(taskId) {
    if (this.backend.getTask) {
      return this.backend.getTask(taskId);
    }
    return null;
  }

  /**
   * List Tasks with filters
   * @param {string} planId
   * @param {object} filters
   * @returns {Array}
   */
  async listTasks(planId, filters = {}) {
    if (this.backend.listTasks) {
      return this.backend.listTasks(planId, filters);
    }
    return [];
  }

  /**
   * Claim a Task (atomic operation)
   * @param {string} taskId
   * @param {string} instanceId
   * @param {number} ttlMs
   * @returns {boolean}
   */
  async claimTask(taskId, instanceId, ttlMs) {
    if (this.backend.claimTask) {
      return this.backend.claimTask(taskId, instanceId, ttlMs);
    }
    return false;
  }

  /**
   * Release a claimed Task
   * @param {string} taskId
   * @param {string} instanceId
   */
  async releaseTask(taskId, instanceId) {
    if (this.backend.releaseTask) {
      return this.backend.releaseTask(taskId, instanceId);
    }
    throw new Error('Backend does not support releaseTask');
  }

  /**
   * Start a Task (mark IN_PROGRESS)
   * @param {string} taskId
   * @param {string} instanceId
   */
  async startTask(taskId, instanceId) {
    if (this.backend.startTask) {
      return this.backend.startTask(taskId, instanceId);
    }
    throw new Error('Backend does not support startTask');
  }

  /**
   * Complete a Task (mark DONE)
   * @param {string} taskId
   */
  async completeTask(taskId) {
    if (this.backend.completeTask) {
      return this.backend.completeTask(taskId);
    }
    throw new Error('Backend does not support completeTask');
  }

  /**
   * Fail a Task (mark FAILED)
   * @param {string} taskId
   * @param {string} reason
   */
  async failTask(taskId, reason) {
    if (this.backend.failTask) {
      return this.backend.failTask(taskId, reason);
    }
    throw new Error('Backend does not support failTask');
  }

  /**
   * Retry a Task (move from FAILED back to PENDING)
   * @param {string} taskId
   * @param {string} reason
   */
  async retryTask(taskId, reason = 'auto_retry') {
    if (this.backend.retryTask) {
      return this.backend.retryTask(taskId, reason);
    }
    throw new Error('Backend does not support retryTask');
  }

  /**
   * List runnable Tasks for a Plan
   * @param {string} planId
   * @returns {Array}
   */
  async listRunnableTasks(planId) {
    if (this.backend.listRunnableTasks) {
      return this.backend.listRunnableTasks(planId);
    }
    return [];
  }

  /**
   * Clean up duplicate task files (maintenance operation)
   * @param {string} planId - Optional: Only clean tasks for specific plan
   * @returns {Object} { cleaned, duplicates, tasksScanned }
   */
  async cleanupDuplicateTasks(planId = null) {
    if (this.backend.cleanupDuplicateTasks) {
      return this.backend.cleanupDuplicateTasks(planId);
    }
    return { cleaned: 0, duplicates: 0, tasksScanned: 0, error: 'Backend does not support cleanup' };
  }

  /**
   * Apply a PlanDelta atomically
   * @param {object} delta
   * @returns {boolean}
   */
  async applyPlanDelta(delta) {
    if (this.backend.applyPlanDelta) {
      return this.backend.applyPlanDelta(delta);
    }
    throw new Error('Backend does not support applyPlanDelta');
  }

  /**
   * Generic key-value storage for arbitrary coordination data
   * Used for pending_agent_tiers and other non-plan coordination state
   */
  async set(key, value, ttlMs = null) {
    if (this.backend.set) {
      return this.backend.set(key, value, ttlMs);
    }
    throw new Error('Backend does not support generic set operation');
  }

  async get(key) {
    if (this.backend.get) {
      return this.backend.get(key);
    }
    throw new Error('Backend does not support generic get operation');
  }

  async delete(key) {
    if (this.backend.delete) {
      return this.backend.delete(key);
    }
    throw new Error('Backend does not support generic delete operation');
  }
}

module.exports = ClusterStateStore;
