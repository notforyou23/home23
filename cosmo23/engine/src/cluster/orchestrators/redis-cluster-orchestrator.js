/**
 * RedisClusterOrchestrator
 *
 * L3: Cluster Orchestrator for Redis backend
 * - Leader election with fencing tokens (epoch counter)
 * - Cycle barriers (ready-sets with TTL)
 * - Peer promotion on leader failure
 * - Adaptive sync timeouts
 * - Two-step failure detection (heartbeats + ping)
 *
 * Phase D-R: Redis Leader Election + Fencing
 */

const { HealthMonitor } = require('../health-monitor');
const { MemoryDiffMerger } = require('../memory-merger');

class RedisClusterOrchestrator {
  constructor(config, redisStateStore, logger) {
    this.config = config;
    this.stateStore = redisStateStore;
    this.logger = logger;
    this.instanceId = config.instanceId || 'cosmo-1';

    // Leader state
    this.isLeader = false;
    this.leaderToken = null;
    this.leaderLeaseMs = config.orchestrator?.leaderLeaseMs || 15000;
    this.renewIntervalMs = config.orchestrator?.renewIntervalMs || 5000;
    this.renewalTimer = null;

    // Health monitoring
    this.healthMonitor = new HealthMonitor(config, redisStateStore);
    this.instanceCount = config.instanceCount || 3;

    // Cycle synchronization
    this.currentCycle = 0;
    this.syncTimeout = config.syncTimeout || 60000; // Default 60s
    this.p95CycleTime = 5000; // Initial estimate

    // Stats
    this.cyclesCompleted = 0;
    this.mergesApplied = 0;
    this.failoverCount = 0;
    this.peerPromotions = 0;

    // Sync signal coordination
    this.syncWaiters = new Map();
  }

  /**
   * Initialize orchestrator
   */
  async initialize() {
    this.logger.info('[RedisClusterOrchestrator] Initializing', {
      instanceId: this.instanceId,
      instanceCount: this.instanceCount
    });

    // Start health monitoring
    await this.healthMonitor.startHeartbeats();

    // Subscribe to heartbeats from peers
    await this.stateStore.subscribeHeartbeats((beacon) => {
      this.handleHeartbeat(beacon);
    });

    // Subscribe to sync signals
    await this.stateStore.subscribeSyncSignal((signal) => {
      this.handleSyncSignal(signal);
    });

    this.logger.info('[RedisClusterOrchestrator] Initialized');
  }

  /**
   * Attempt to acquire leadership
   */
  async tryAcquireLeadership() {
    try {
      const token = await this.stateStore.acquireLeadership();
      
      if (token) {
        this.isLeader = true;
        this.leaderToken = token;
        
        this.logger.info('[RedisClusterOrchestrator] Leadership acquired', {
          instanceId: this.instanceId,
          token: this.leaderToken
        });

        // Start automatic lease renewal
        this.startLeaseRenewal();
        
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('[RedisClusterOrchestrator] Failed to acquire leadership', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Start automatic lease renewal timer
   */
  startLeaseRenewal() {
    this.stopLeaseRenewal(); // Clear any existing timer

    this.renewalTimer = setInterval(async () => {
      try {
        const renewed = await this.stateStore.renewLeadership(this.leaderToken);
        
        if (!renewed) {
          this.logger.error('[RedisClusterOrchestrator] Lease renewal failed (lost leadership)', {
            token: this.leaderToken
          });
          this.isLeader = false;
          this.stopLeaseRenewal();
          
          // Attempt to reacquire
          setTimeout(() => {
            this.tryAcquireLeadership().catch(err => {
              this.logger.error('[RedisClusterOrchestrator] Reacquisition failed', {
                error: err.message
              });
            });
          }, 1000);
        } else {
          this.logger.debug('[RedisClusterOrchestrator] Lease renewed', {
            token: this.leaderToken
          });
        }
      } catch (error) {
        this.logger.error('[RedisClusterOrchestrator] Renewal error', {
          error: error.message
        });
      }
    }, this.renewIntervalMs);

    this.logger.debug('[RedisClusterOrchestrator] Lease renewal timer started', {
      renewIntervalMs: this.renewIntervalMs
    });
  }

  /**
   * Stop lease renewal timer
   */
  stopLeaseRenewal() {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  /**
   * Release leadership
   */
  async releaseLeadership() {
    this.stopLeaseRenewal();
    
    if (this.isLeader) {
      await this.stateStore.releaseLeadership();
      this.isLeader = false;
      this.leaderToken = null;
      
      this.logger.info('[RedisClusterOrchestrator] Leadership released', {
        instanceId: this.instanceId
      });
    }
  }

  /**
   * Wait for cycle barrier (all instances ready)
   * @param {number} cycle - cycle number
   * @returns {boolean} - true if all ready, false if timeout
   */
  async waitForCycleBarrier(cycle) {
    const timeout = this.calculateAdaptiveTimeout();
    const startTime = Date.now();

    this.logger.debug('[RedisClusterOrchestrator] Waiting for cycle barrier', {
      cycle,
      timeout
    });

    while (Date.now() - startTime < timeout) {
      const readyCount = await this.stateStore.getReadyCount(cycle);
      const healthyCount = this.instanceCount - this.healthMonitor.unhealthyInstances.size;

      if (readyCount >= healthyCount) {
        this.logger.info('[RedisClusterOrchestrator] Cycle barrier reached', {
          cycle,
          readyCount,
          healthyCount,
          elapsedMs: Date.now() - startTime
        });
        return true;
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Timeout
    const readyCount = await this.stateStore.getReadyCount(cycle);
    this.logger.warn('[RedisClusterOrchestrator] Cycle barrier timeout', {
      cycle,
      readyCount,
      expectedCount: this.instanceCount - this.healthMonitor.unhealthyInstances.size,
      timeoutMs: timeout
    });

    return false;
  }

  /**
   * Mark this instance as ready for cycle
   */
  async markReady(cycle) {
    await this.stateStore.markReady(cycle, this.instanceId);
    
    this.logger.debug('[RedisClusterOrchestrator] Marked ready', {
      cycle,
      instanceId: this.instanceId
    });
  }

  /**
   * Publish cycle proceed signal (leader only)
   */
  async publishCycleProceed(cycle) {
    if (!this.isLeader) {
      this.logger.warn('[RedisClusterOrchestrator] Not leader, cannot publish proceed', {
        cycle
      });
      return false;
    }

    await this.stateStore.publishSyncSignal(cycle);
    
    this.logger.info('[RedisClusterOrchestrator] Published cycle proceed signal', {
      cycle
    });

    return true;
  }

  /**
   * Calculate adaptive timeout based on p95 cycle time
   */
  calculateAdaptiveTimeout() {
    return Math.max(3 * this.p95CycleTime, 60000);
  }

  /**
   * Update p95 cycle time (for adaptive timeout)
   */
  updateP95CycleTime(cycleTime) {
    // Simple exponential moving average
    this.p95CycleTime = 0.9 * this.p95CycleTime + 0.1 * cycleTime;
  }

  /**
   * Handle heartbeat from peer
   */
  handleHeartbeat(beacon) {
    const { instanceId, cycle, timestamp } = beacon;
    
    if (instanceId === this.instanceId) {
      return; // Ignore own heartbeat
    }

    this.healthMonitor.markHealthy(instanceId);
    
    this.logger.debug('[RedisClusterOrchestrator] Heartbeat received', {
      from: instanceId,
      cycle,
      age: Date.now() - timestamp
    });
  }

  /**
   * Handle sync signal from leader
   */
  handleSyncSignal(signal) {
    const { cycle, leader } = signal;

    this.logger.info('[RedisClusterOrchestrator] Sync signal received', {
      cycle,
      leader
    });

    this.currentCycle = cycle;
    this.cyclesCompleted++;

    const waiters = this.syncWaiters.get(cycle);
    if (waiters) {
      for (const resolve of waiters) {
        resolve(true);
      }
      this.syncWaiters.delete(cycle);
    }
  }

  /**
   * Check cluster health
   */
  getClusterHealth() {
    const healthStatus = this.healthMonitor.getClusterHealthStatus(this.instanceCount);
    const quorumHealthy = this.healthMonitor.isQuorumHealthy(this.instanceCount);

    return {
      status: healthStatus,
      quorumHealthy,
      healthy: this.instanceCount - this.healthMonitor.unhealthyInstances.size,
      suspect: this.healthMonitor.suspectInstances.size,
      unhealthy: this.healthMonitor.unhealthyInstances.size,
      total: this.instanceCount
    };
  }

  /**
   * Get orchestrator stats
   */
  getStats() {
    return {
      instanceId: this.instanceId,
      isLeader: this.isLeader,
      leaderToken: this.leaderToken,
      currentCycle: this.currentCycle,
      cyclesCompleted: this.cyclesCompleted,
      mergesApplied: this.mergesApplied,
      failoverCount: this.failoverCount,
      peerPromotions: this.peerPromotions,
      p95CycleTime: this.p95CycleTime,
      adaptiveTimeout: this.calculateAdaptiveTimeout(),
      clusterHealth: this.getClusterHealth()
    };
  }

  /**
   * Cleanup (stop timers, release leadership)
   */
  async cleanup() {
    this.stopLeaseRenewal();
    this.healthMonitor.stopHeartbeats();
    
    if (this.isLeader) {
      await this.releaseLeadership();
    }

    this.logger.info('[RedisClusterOrchestrator] Cleanup complete');
  }

  async waitForProceed(cycle, timeout = this.syncTimeout) {
    if (this.isLeader) {
      return true;
    }

    if (this.currentCycle >= cycle) {
      return true;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.syncWaiters.delete(cycle);
        this.logger.warn('[RedisClusterOrchestrator] Wait for proceed timed out', {
          cycle,
          timeoutMs: timeout
        });
        resolve(false);
      }, timeout);

      const resolver = (value) => {
        clearTimeout(timer);
        resolve(value);
      };

      const waiters = this.syncWaiters.get(cycle) || [];
      waiters.push(resolver);
      this.syncWaiters.set(cycle, waiters);
    });
  }

  async mergeCycleState(cycle) {
    const diffs = await this.stateStore.fetchDiffs(cycle);
    const merger = new MemoryDiffMerger(this.logger);

    for (const entry of diffs) {
      merger.applyDiff(entry.diff, entry.instanceId || 'unknown');
    }

    const mergedState = merger.build(cycle);

    await this.stateStore.setMergedState(cycle, mergedState);
    await this.stateStore.acknowledgeDiffs(cycle, diffs);

    this.mergesApplied++;

    const metadata = mergedState.metadata || {};
    const summary = {
      diffCount: diffs.length,
      nodesSet: metadata.nodesSet || 0,
      nodesDeleted: metadata.nodesDeleted || 0,
      edgesSet: metadata.edgesSet || 0,
      edgesDeleted: metadata.edgesDeleted || 0,
      clustersSet: metadata.clustersSet || 0,
      clustersDeleted: metadata.clustersDeleted || 0
    };

    this.logger.info('[RedisClusterOrchestrator] Merged cycle diffs', {
      cycle,
      ...summary
    });

    return summary;
  }

  async completeCycleSync(cycle, { diffSubmitted } = {}) {
    try {
      await this.markReady(cycle);
    } catch (error) {
      this.logger.error('[RedisClusterOrchestrator] markReady failed', {
        cycle,
        error: error.message
      });
    }

    const barrierStart = Date.now();
    const barrierReached = await this.waitForCycleBarrier(cycle);
    const waitDuration = Date.now() - barrierStart;
    if (!barrierReached) {
      return {
        success: false,
        metrics: {
          role: this.isLeader ? 'leader' : 'follower',
          diffSubmitted,
          barrier: { reached: false, waitedMs: waitDuration },
          timestamp: Date.now()
        }
      };
    }

    if (this.isLeader) {
      const mergeSummary = await this.mergeCycleState(cycle);
      const proceedStart = Date.now();
      await this.publishCycleProceed(cycle);
      return {
        success: true,
        metrics: {
          role: 'leader',
          diffSubmitted,
          barrier: { reached: true, waitedMs: waitDuration },
          merge: mergeSummary,
          proceedBroadcastMs: Date.now() - proceedStart,
          timestamp: Date.now()
        }
      };
    }

    const proceedStart = Date.now();
    const proceed = await this.waitForProceed(cycle);
    if (!proceed) {
      this.logger.warn('[RedisClusterOrchestrator] Proceed signal missing', {
        cycle
      });
    }
    return {
      success: proceed,
      metrics: {
        role: 'follower',
        diffSubmitted,
        barrier: { reached: true, waitedMs: waitDuration },
        proceedWaitMs: Date.now() - proceedStart,
        timestamp: Date.now()
      }
    };
  }
}

module.exports = { RedisClusterOrchestrator };
