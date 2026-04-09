/**
 * SyncGate
 *
 * Cycle synchronization barrier.
 * Blocks each instance at cycle boundary until:
 * - All healthy instances report ready, OR
 * - Timeout expires (adaptive based on p95 cycle time)
 *
 * Phase E: Cluster-Aware Routing
 */

const EventEmitter = require('events');

class SyncGate extends EventEmitter {
  constructor(config, stateStore) {
    super();
    this.config = config;
    this.stateStore = stateStore;
    this.currentCycle = 0;
    this.syncTimeout = config.syncTimeout || 60000; // ms
  }

  /**
   * Wait for cycle sync gate to open.
   * Blocks until all instances ready or timeout.
   * @param {number} cycle - cycle number
   * @param {number} timeoutMs - max wait time
   * @returns {boolean} - true if gate opened, false if timeout
   */
  async waitForSync(cycle, timeoutMs = null) {
    if (!this.stateStore) {
      // Clustering disabled; return immediately
      return true;
    }

    const timeout = timeoutMs || this.syncTimeout;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener(`sync:${cycle}`, handler);
        resolve(false);
      }, timeout);

      const handler = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.once(`sync:${cycle}`, handler);
    });
  }

  /**
   * Signal that this instance is ready for cycle.
   * @param {number} cycle - cycle number
   */
  async markReady(cycle) {
    if (!this.stateStore) {
      return;
    }

    const instanceId = this.config.instanceId || 'cosmo-1';
    await this.stateStore.markReady(cycle, instanceId);
  }

  /**
   * Publish cycle proceed signal (leader only).
   * @param {number} cycle - cycle number
   */
  async publishProceed(cycle) {
    if (!this.stateStore) {
      return;
    }

    await this.stateStore.publishSyncSignal(cycle);
    this.emit(`sync:${cycle}`);
  }

  /**
   * Handle sync signal from backend
   */
  handleSyncSignal(signal) {
    const { cycle } = signal;
    this.emit(`sync:${cycle}`);
  }

  /**
   * Set adaptive timeout based on p95 cycle time.
   * @param {number} p95CycleTimeMs - p95 cycle time
   */
  setAdaptiveTimeout(p95CycleTimeMs) {
    this.syncTimeout = Math.max(3 * p95CycleTimeMs, 60000);
  }

  /**
   * Graceful shutdown.
   */
  shutdown() {
    this.removeAllListeners();
  }
}

module.exports = SyncGate;
