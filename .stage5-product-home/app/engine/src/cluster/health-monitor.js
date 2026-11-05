/**
 * HealthMonitor
 *
 * L2: Instance Health & Monitoring
 * - Async heartbeat protocol (background thread, independent of main cycle)
 * - Two-step failure detection: miss N beats → warn; ping suspect → mark unhealthy
 * - Graceful degradation: N-1 capacity when instances fail
 * - Recovery join after restart
 *
 * Phase C (shared) + Phase D-R/D-FS
 */

class HealthMonitor {
  constructor(config, stateStore) {
    this.config = config;
    this.stateStore = stateStore;
    this.instanceId = config.instanceId || 'cosmo-1';
    this.healthCheckInterval = config.healthCheckInterval || 3000; // ms
    this.failureThreshold = config.failureThreshold || 3; // missed beats
    this.pingTimeout = config.pingTimeout || 10000; // ms
    this.promotionThreshold = config.promotionThreshold || 30000; // ms

    this.heartbeatTimer = null;
    this.missedBeats = {}; // { instanceId: count }
    this.suspectInstances = new Set();
    this.unhealthyInstances = new Set();
    this.lastHeartbeatTime = {}; // { instanceId: timestamp }
  }

  /**
   * Start async heartbeat background thread.
   * Runs independently; non-blocking.
   */
  async startHeartbeats() {
    this.heartbeatTimer = setInterval(() => {
      this.publishHeartbeat().catch((err) => {
        console.error('[HealthMonitor] Heartbeat publish error:', err.message);
      });
    }, this.healthCheckInterval);

    // Subscribe to heartbeats from peers
    if (this.stateStore && this.stateStore.subscribeHeartbeats) {
      await this.stateStore.subscribeHeartbeats((beacon) => {
        this.handlePeerHeartbeat(beacon);
      });
    }

    console.log('[HealthMonitor] Heartbeat system started');
  }

  /**
   * Stop heartbeat timer.
   */
  stopHeartbeats() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Publish this instance's heartbeat.
   * Beacon = { instanceId, cycle, memoryHash, ramUsage, errorCount, timestamp }
   */
  async publishHeartbeat() {
    const beacon = {
      instanceId: this.instanceId,
      cycle: 0, // Will be filled by orchestrator
      memoryHash: '',
      ramUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
      errorCount: 0,
      timestamp: Date.now()
    };

    if (this.stateStore && this.stateStore.publishHeartbeat) {
      await this.stateStore.publishHeartbeat(beacon);
    }
  }

  /**
   * Handle heartbeat from peer instance
   */
  handlePeerHeartbeat(beacon) {
    const { instanceId } = beacon;
    
    if (instanceId === this.instanceId) {
      return; // Ignore own heartbeat
    }

    // Mark as healthy
    this.markHealthy(instanceId);
  }

  /**
   * Mark an instance as healthy (last heartbeat received).
   * @param {string} instanceId - instance ID
   */
  markHealthy(instanceId) {
    this.missedBeats[instanceId] = 0;
    this.suspectInstances.delete(instanceId);
    this.lastHeartbeatTime[instanceId] = Date.now();
  }

  /**
   * Increment missed beats for instance.
   * If >= failureThreshold, move to suspect set.
   * @param {string} instanceId - instance ID
   */
  missedBeat(instanceId) {
    this.missedBeats[instanceId] = (this.missedBeats[instanceId] || 0) + 1;

    if (this.missedBeats[instanceId] >= this.failureThreshold) {
      this.suspectInstances.add(instanceId);
      console.warn(`[HealthMonitor] Instance ${instanceId} suspected (missed ${this.missedBeats[instanceId]} beats)`);
      // TODO Phase D-R/D-FS: Trigger ping (HTTP or MCP)
    }
  }

  /**
   * Ping suspected instance to confirm health.
   * @param {string} instanceId - instance ID
   * @returns {boolean} - true if ping succeeded
   */
  async pingInstance(instanceId) {
    // TODO Phase D-R/D-FS: HTTP or MCP ping with timeout
    // - If succeeds: markHealthy(instanceId), return true
    // - If fails: mark unhealthy, return false
    return false;
  }

  /**
   * Mark instance as unhealthy.
   * @param {string} instanceId - instance ID
   */
  markUnhealthy(instanceId) {
    this.unhealthyInstances.add(instanceId);
    this.suspectInstances.delete(instanceId);
    console.error(`[HealthMonitor] Instance ${instanceId} marked UNHEALTHY`);
  }

  /**
   * Get current health status.
   * @returns {object} - { healthy: [], suspect: [], unhealthy: [] }
   */
  getHealthStatus() {
    return {
      healthy: [],
      suspect: Array.from(this.suspectInstances),
      unhealthy: Array.from(this.unhealthyInstances),
    };
  }

  /**
   * Check if quorum is healthy.
   * Quorum = ceil(N/2) + 1
   * @param {number} totalInstances - total instances in cluster
   * @returns {boolean} - true if quorum healthy
   */
  isQuorumHealthy(totalInstances) {
    const healthyCount = totalInstances - this.unhealthyInstances.size;
    const quorumSize = Math.ceil(totalInstances / 2) + 1;
    return healthyCount >= quorumSize;
  }

  /**
   * Graceful degradation: continue at N-1 capacity if one instance fails.
   * If 2+ fail, operator decision required.
   * @returns {string} - 'healthy', 'degraded', or 'critical'
   */
  getClusterHealthStatus(totalInstances) {
    const unhealthyCount = this.unhealthyInstances.size;
    if (unhealthyCount === 0) return 'healthy';
    if (unhealthyCount === 1) return 'degraded'; // N-1, can continue
    return 'critical'; // 2+ unhealthy
  }

  /**
   * Attempt recovery join for restarted instance.
   * Wait for next cycle boundary, sync state.
   * @param {object} recoveryState - state from last clean cycle
   * @returns {boolean} - true if recovery succeeded
   */
  async attemptRecoveryJoin(recoveryState) {
    // TODO Phase D-R/D-FS: Sync full state from backend
    // - Fetch memory, goals, journal tail
    // - Resume at cycle N+1
    // - Log recovery with timestamp
    return true;
  }
}

module.exports = HealthMonitor;
