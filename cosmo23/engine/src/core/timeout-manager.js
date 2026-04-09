/**
 * TimeoutManager
 *
 * Phase A: Timeout enforcement and hanging operation detection
 * - Cycle timeout enforcement
 * - Operation-level timeouts
 * - Promise cleanup on timeout
 * - Timeout metrics and logging
 */

class TimeoutManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Timeout settings
    this.defaultCycleTimeout = config.timeouts?.cycleTimeoutMs || 60000; // 60s default
    this.defaultOperationTimeout = config.timeouts?.operationTimeoutMs || 30000; // 30s default
    
    // Active timeouts tracking
    this.cycleTimer = null;
    this.currentCycle = null;
    this.activeOperationTimeouts = new Map(); // operationId -> { timer, startTime }
    
    // Stats
    this.cycleTimeouts = 0;
    this.operationTimeouts = 0; // Count of operations that timed out
    this.totalCycles = 0;
    this.totalOperations = 0;
  }

  /**
   * Start cycle timeout timer
   * @param {number} cycle - cycle number
   * @param {number} timeoutMs - timeout in milliseconds (optional)
   * @param {function} onTimeout - callback to call on timeout
   * @returns {object} - { cycle, timeoutMs, startTime }
   */
  startCycleTimer(cycle, timeoutMs = null, onTimeout = null) {
    // Cancel any existing cycle timer
    this.cancelCycleTimer();

    const timeout = timeoutMs || this.defaultCycleTimeout;
    const startTime = Date.now();

    this.currentCycle = cycle;
    this.totalCycles++;

    this.cycleTimer = setTimeout(() => {
      this.cycleTimeouts++;
      const elapsed = Date.now() - startTime;
      
      this.logger.error('[TimeoutManager] Cycle timeout exceeded', {
        cycle,
        timeoutMs: timeout,
        elapsedMs: elapsed
      });

      // Call custom timeout handler if provided
      if (onTimeout && typeof onTimeout === 'function') {
        try {
          onTimeout(cycle, elapsed);
        } catch (error) {
          this.logger.error('[TimeoutManager] Error in timeout callback', { error: error.message });
        }
      }

      // Clear cycle timer reference
      this.cycleTimer = null;
      this.currentCycle = null;
    }, timeout);

    this.logger.debug('[TimeoutManager] Cycle timer started', {
      cycle,
      timeoutMs: timeout
    });

    return { cycle, timeoutMs: timeout, startTime };
  }

  /**
   * Cancel cycle timeout timer
   * Call this when cycle completes successfully
   */
  cancelCycleTimer() {
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
      
      if (this.currentCycle !== null) {
        this.logger.debug('[TimeoutManager] Cycle timer cancelled', {
          cycle: this.currentCycle
        });
        this.currentCycle = null;
      }
    }
  }

  /**
   * Wrap a promise with timeout
   * @param {Promise} promise - promise to wrap
   * @param {number} timeoutMs - timeout in milliseconds
   * @param {string} operationId - operation identifier (for tracking)
   * @returns {Promise} - wrapped promise that rejects on timeout
   */
  wrapWithTimeout(promise, timeoutMs = null, operationId = null) {
    const timeout = timeoutMs || this.defaultOperationTimeout;
    const opId = operationId || `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    this.totalOperations++;

    return new Promise((resolve, reject) => {
      // Create timeout timer
      const timer = setTimeout(() => {
        this.operationTimeouts++;
        const elapsed = Date.now() - startTime;
        
        this.logger.warn('[TimeoutManager] Operation timeout', {
          operationId: opId,
          timeoutMs: timeout,
          elapsedMs: elapsed
        });

        // Remove from tracking
        this.activeOperationTimeouts.delete(opId);

        // Reject with timeout error
        const error = new Error(`Operation timeout after ${elapsed}ms`);
        error.code = 'OPERATION_TIMEOUT';
        error.operationId = opId;
        error.timeoutMs = timeout;
        error.elapsedMs = elapsed;
        reject(error);
      }, timeout);

      // Track timeout
      this.activeOperationTimeouts.set(opId, { timer, startTime, operationId: opId });

      // Wrap original promise
      promise
        .then((result) => {
          // Clear timeout on success
          clearTimeout(timer);
          this.activeOperationTimeouts.delete(opId);
          resolve(result);
        })
        .catch((error) => {
          // Clear timeout on error
          clearTimeout(timer);
          this.activeOperationTimeouts.delete(opId);
          reject(error);
        });
    });
  }

  /**
   * Cancel an operation timeout
   * @param {string} operationId - operation identifier
   */
  cancelOperationTimeout(operationId) {
    const timeout = this.activeOperationTimeouts.get(operationId);
    if (timeout) {
      clearTimeout(timeout.timer);
      this.activeOperationTimeouts.delete(operationId);
      this.logger.debug('[TimeoutManager] Operation timeout cancelled', { operationId });
    }
  }

  /**
   * Cancel all operation timeouts
   * Call this on shutdown
   */
  cancelAllOperationTimeouts() {
    for (const [opId, timeout] of this.activeOperationTimeouts.entries()) {
      clearTimeout(timeout.timer);
      this.logger.debug('[TimeoutManager] Cancelled operation timeout', { operationId: opId });
    }
    this.activeOperationTimeouts.clear();
  }

  /**
   * Check if cycle is currently timing out
   */
  isCycleActive() {
    return this.cycleTimer !== null;
  }

  /**
   * Get active operation count
   */
  getActiveOperationCount() {
    return this.activeOperationTimeouts.size;
  }

  /**
   * Get stats
   */
  getStats() {
    const activeOps = [];
    const now = Date.now();
    
    for (const [opId, timeout] of this.activeOperationTimeouts.entries()) {
      activeOps.push({
        operationId: opId,
        elapsedMs: now - timeout.startTime
      });
    }

    return {
      cycleTimeouts: this.cycleTimeouts,
      operationTimeouts: this.operationTimeouts,
      totalCycles: this.totalCycles,
      totalOperations: this.totalOperations,
      cycleTimeoutRate: this.totalCycles > 0 ? (this.cycleTimeouts / this.totalCycles * 100).toFixed(2) + '%' : '0%',
      operationTimeoutRate: this.totalOperations > 0 ? (this.operationTimeouts / this.totalOperations * 100).toFixed(2) + '%' : '0%',
      currentCycle: this.currentCycle,
      activeOperations: this.activeOperationTimeouts.size,
      activeOperationsList: activeOps
    };
  }

  /**
   * Get timeout metrics for baseline capture
   */
  getBaselineMetrics() {
    return {
      cycleTimeouts: this.cycleTimeouts,
      operationTimeouts: this.operationTimeouts,
      totalCycles: this.totalCycles,
      totalOperations: this.totalOperations,
      cycleTimeoutRate: this.totalCycles > 0 ? this.cycleTimeouts / this.totalCycles : 0,
      operationTimeoutRate: this.totalOperations > 0 ? this.operationTimeouts / this.totalOperations : 0
    };
  }

  /**
   * Cleanup all timeouts
   * Call this on shutdown
   */
  cleanup() {
    this.cancelCycleTimer();
    this.cancelAllOperationTimeouts();
    this.logger.info('[TimeoutManager] Cleanup complete');
  }

  /**
   * Reset stats (for testing)
   */
  reset() {
    this.cleanup();
    this.cycleTimeouts = 0;
    this.operationTimeouts = 0;
    this.totalCycles = 0;
    this.totalOperations = 0;
  }
}

module.exports = { TimeoutManager };

