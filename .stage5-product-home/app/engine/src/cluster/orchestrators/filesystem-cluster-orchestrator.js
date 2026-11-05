/**
 * FilesystemClusterOrchestrator
 *
 * L3: Cluster Orchestrator for Filesystem backend
 * - Leader election via O_EXCL file locks (delegated to LeaderElection)
 * - Cycle barriers via filesystem check files
 * - Health monitoring via filesystem beacons
 * - Term-based fencing for split-brain prevention
 *
 * Phase I: Production Rollout (Filesystem Orchestrator)
 */

const fs = require('fs').promises;
const path = require('path');
const { MemoryDiffMerger } = require('../memory-merger');

class FilesystemClusterOrchestrator {
  constructor(config, filesystemStateStore, logger) {
    this.config = config;
    this.stateStore = filesystemStateStore;
    this.logger = logger;
    this.instanceId = config.instanceId || 'cosmo-1';
    this.fsRoot = config.fsRoot || '/tmp/cosmo_cluster';

    // Leader state (delegated to LeaderElection in stateStore)
    this.isLeader = false;
    this.currentTerm = 0;
    this.leaseCheckInterval = 5000; // Check leader status every 5s
    this.leaseTimer = null;

    // Health monitoring
    this.instanceCount = config.instanceCount || 3;
    this.healthyInstances = new Set();
    this.unhealthyInstances = new Set();
    this.healthCheckInterval = 10000; // Check health every 10s
    this.healthTimer = null;
    this.maxHealthAge = 30000; // 30s

    // Cycle synchronization
    this.currentCycle = 0;
    this.syncTimeout = config.syncTimeout || 60000; // Default 60s
    
    // Paths
    this.controlDir = path.join(this.fsRoot, 'control');
    this.barrierDir = path.join(this.fsRoot, 'barriers');
    this.healthDir = path.join(this.fsRoot, 'health');

    // Stats
    this.cyclesCompleted = 0;
    this.failoverCount = 0;
    this.mergesApplied = 0;
  }

  /**
   * Initialize orchestrator
   */
  async initialize() {
    this.logger.info('[FilesystemClusterOrchestrator] Initializing', {
      instanceId: this.instanceId,
      instanceCount: this.instanceCount,
      fsRoot: this.fsRoot
    });

    // Create directories
    await fs.mkdir(this.barrierDir, { recursive: true });
    await fs.mkdir(this.healthDir, { recursive: true });

    // Start periodic leader check
    this.startLeaderCheck();

    // Start periodic health monitoring
    this.startHealthMonitoring();

    this.logger.info('[FilesystemClusterOrchestrator] Initialized');
  }

  /**
   * Start periodic leader status check
   */
  startLeaderCheck() {
    this.leaseTimer = setInterval(async () => {
      try {
        const wasLeader = this.isLeader;
        this.isLeader = await this.stateStore.leaderElection.isCurrentLeader();
        this.currentTerm = this.stateStore.leaderElection.currentTerm;

        if (this.isLeader && !wasLeader) {
          this.logger.info('[FilesystemClusterOrchestrator] Became leader', {
            instanceId: this.instanceId,
            term: this.currentTerm
          });
          this.failoverCount++;
        } else if (!this.isLeader && wasLeader) {
          this.logger.warn('[FilesystemClusterOrchestrator] Lost leadership', {
            instanceId: this.instanceId,
            term: this.currentTerm
          });
        }
      } catch (error) {
        this.logger.error('[FilesystemClusterOrchestrator] Leader check error', {
          error: error.message
        });
      }
    }, this.leaseCheckInterval);
  }

  /**
   * Stop leader check timer
   */
  stopLeaderCheck() {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
  }

  /**
   * Start periodic health monitoring
   */
  startHealthMonitoring() {
    this.healthTimer = setInterval(async () => {
      try {
        await this.checkClusterHealth();
      } catch (error) {
        this.logger.error('[FilesystemClusterOrchestrator] Health check error', {
          error: error.message
        });
      }
    }, this.healthCheckInterval);
  }

  /**
   * Stop health monitoring timer
   */
  stopHealthMonitoring() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Check health of all instances
   */
  async checkClusterHealth() {
    const now = Date.now();
    this.healthyInstances.clear();
    this.unhealthyInstances.clear();

    // Write own health beacon
    const ownBeaconPath = path.join(this.healthDir, `${this.instanceId}.json`);
    await fs.writeFile(ownBeaconPath, JSON.stringify({
      instanceId: this.instanceId,
      timestamp: now,
      cycle: this.currentCycle,
      isLeader: this.isLeader,
      term: this.currentTerm
    }), 'utf8');

    // Check all instance health beacons
    try {
      const files = await fs.readdir(this.healthDir);
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const beaconPath = path.join(this.healthDir, file);
        try {
          const stats = await fs.stat(beaconPath);
          const age = now - stats.mtimeMs;
          
          if (age < this.maxHealthAge) {
            const data = await fs.readFile(beaconPath, 'utf8');
            const beacon = JSON.parse(data);
            this.healthyInstances.add(beacon.instanceId);
          } else {
            // Beacon is stale
            const instanceId = file.replace('.json', '');
            this.unhealthyInstances.add(instanceId);
          }
        } catch (error) {
          this.logger.debug('[FilesystemClusterOrchestrator] Error reading beacon', {
            file,
            error: error.message
          });
        }
      }
    } catch (error) {
      this.logger.error('[FilesystemClusterOrchestrator] Health directory read error', {
        error: error.message
      });
    }

    this.logger.debug('[FilesystemClusterOrchestrator] Health check complete', {
      healthy: this.healthyInstances.size,
      unhealthy: this.unhealthyInstances.size,
      instances: Array.from(this.healthyInstances)
    });
  }

  /**
   * Attempt to acquire leadership
   */
  async tryAcquireLeadership() {
    try {
      await this.stateStore.leaderElection.tryAcquireLeadership();
      this.isLeader = this.stateStore.leaderElection.isLeader;
      this.currentTerm = this.stateStore.leaderElection.currentTerm;

      if (this.isLeader) {
        this.logger.info('[FilesystemClusterOrchestrator] Leadership acquired', {
          instanceId: this.instanceId,
          term: this.currentTerm
        });
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('[FilesystemClusterOrchestrator] Failed to acquire leadership', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Release leadership
   */
  async releaseLeadership() {
    if (this.isLeader) {
      await this.stateStore.leaderElection.releaseLeadership();
      this.isLeader = false;
      
      this.logger.info('[FilesystemClusterOrchestrator] Leadership released', {
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
    const startTime = Date.now();
    const barrierCycleDir = path.join(this.barrierDir, `cycle_${cycle}`);

    this.logger.debug('[FilesystemClusterOrchestrator] Waiting for cycle barrier', {
      cycle,
      timeout: this.syncTimeout
    });

    // Create barrier directory
    await fs.mkdir(barrierCycleDir, { recursive: true });

    while (Date.now() - startTime < this.syncTimeout) {
      try {
        const files = await fs.readdir(barrierCycleDir);
        const readyCount = files.filter(f => f.endsWith('.ready')).length;
        const quorum = Math.ceil(this.instanceCount / 2);

        // Use quorum instead of all instances (allow stragglers)
        if (readyCount >= quorum) {
          this.logger.info('[FilesystemClusterOrchestrator] Cycle barrier reached', {
            cycle,
            readyCount,
            quorum,
            elapsedMs: Date.now() - startTime
          });
          return true;
        }
      } catch (error) {
        this.logger.debug('[FilesystemClusterOrchestrator] Barrier check error', {
          error: error.message
        });
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Timeout
    const files = await fs.readdir(barrierCycleDir).catch(() => []);
    const readyCount = files.filter(f => f.endsWith('.ready')).length;
    
    this.logger.warn('[FilesystemClusterOrchestrator] Cycle barrier timeout', {
      cycle,
      readyCount,
      expectedQuorum: Math.ceil(this.instanceCount / 2),
      timeoutMs: this.syncTimeout
    });

    return false;
  }

  /**
   * Mark this instance as ready for cycle
   */
  async markReady(cycle) {
    const barrierCycleDir = path.join(this.barrierDir, `cycle_${cycle}`);
    await fs.mkdir(barrierCycleDir, { recursive: true });
    
    const readyFile = path.join(barrierCycleDir, `${this.instanceId}.ready`);
    await fs.writeFile(readyFile, JSON.stringify({
      instanceId: this.instanceId,
      timestamp: Date.now(),
      term: this.currentTerm
    }), 'utf8');
    
    this.logger.debug('[FilesystemClusterOrchestrator] Marked ready', {
      cycle,
      instanceId: this.instanceId
    });
  }

  /**
   * Clean up old barrier files
   */
  async cleanupOldBarriers(currentCycle) {
    try {
      const files = await fs.readdir(this.barrierDir);
      
      for (const file of files) {
        if (!file.startsWith('cycle_')) continue;
        
        const cycleNum = parseInt(file.replace('cycle_', ''));
        if (cycleNum < currentCycle - 5) {
          // Remove barriers older than 5 cycles
          const oldBarrierDir = path.join(this.barrierDir, file);
          await fs.rm(oldBarrierDir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      this.logger.debug('[FilesystemClusterOrchestrator] Barrier cleanup error', {
        error: error.message
      });
    }
  }

  async publishCycleProceed(cycle) {
    const barrierCycleDir = path.join(this.barrierDir, `cycle_${cycle}`);
    await fs.mkdir(barrierCycleDir, { recursive: true });
    const proceedPath = path.join(barrierCycleDir, 'proceed.signal');
    await fs.writeFile(proceedPath, JSON.stringify({
      cycle,
      leader: this.instanceId,
      timestamp: Date.now()
    }), 'utf8');

    this.logger.info('[FilesystemClusterOrchestrator] Published cycle proceed signal', {
      cycle
    });
  }

  async waitForProceed(cycle) {
    if (this.isLeader) {
      return true;
    }

    const barrierCycleDir = path.join(this.barrierDir, `cycle_${cycle}`);
    const proceedPath = path.join(barrierCycleDir, 'proceed.signal');
    const start = Date.now();

    while (Date.now() - start < this.syncTimeout) {
      try {
        await fs.access(proceedPath);
        return true;
      } catch (error) {
        // Ignore until available
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    this.logger.warn('[FilesystemClusterOrchestrator] Proceed wait timed out', {
      cycle,
      timeoutMs: this.syncTimeout
    });

    return false;
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

    this.logger.info('[FilesystemClusterOrchestrator] Merged cycle diffs', {
      cycle,
      ...summary
    });

    return summary;
  }

  async completeCycleSync(cycle, { diffSubmitted } = {}) {
    try {
      await this.markReady(cycle);
    } catch (error) {
      this.logger.error('[FilesystemClusterOrchestrator] markReady failed', {
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

    let metrics;
    if (this.isLeader) {
      const mergeSummary = await this.mergeCycleState(cycle);
      const broadcastStart = Date.now();
      await this.publishCycleProceed(cycle);
      metrics = {
        role: 'leader',
        diffSubmitted,
        barrier: { reached: true, waitedMs: waitDuration },
        merge: mergeSummary,
        proceedBroadcastMs: Date.now() - broadcastStart,
        timestamp: Date.now()
      };
    } else {
      const waitStart = Date.now();
      const proceed = await this.waitForProceed(cycle);
      if (!proceed) {
        return {
          success: false,
          metrics: {
            role: 'follower',
            diffSubmitted,
            barrier: { reached: true, waitedMs: waitDuration },
            proceedWaitMs: Date.now() - waitStart,
            timestamp: Date.now()
          }
        };
      }
      metrics = {
        role: 'follower',
        diffSubmitted,
        barrier: { reached: true, waitedMs: waitDuration },
        proceedWaitMs: Date.now() - waitStart,
        timestamp: Date.now()
      };
    }

    this.currentCycle = cycle;
    this.cyclesCompleted++;
    await this.cleanupOldBarriers(cycle);

    return {
      success: true,
      metrics
    };
  }

  /**
   * Check cluster health status
   */
  getClusterHealth() {
    const healthy = this.healthyInstances.size;
    const unhealthy = this.unhealthyInstances.size;
    const total = this.instanceCount;
    const quorumHealthy = healthy >= Math.ceil(total / 2);

    return {
      status: quorumHealthy ? 'healthy' : 'degraded',
      quorumHealthy,
      healthy,
      unhealthy,
      total,
      instances: Array.from(this.healthyInstances)
    };
  }

  /**
   * Get orchestrator stats
   */
  getStats() {
    return {
      instanceId: this.instanceId,
      isLeader: this.isLeader,
      currentTerm: this.currentTerm,
      currentCycle: this.currentCycle,
      cyclesCompleted: this.cyclesCompleted,
      failoverCount: this.failoverCount,
      clusterHealth: this.getClusterHealth()
    };
  }

  /**
   * Cleanup (stop timers, release leadership)
   */
  async cleanup() {
    this.stopLeaderCheck();
    this.stopHealthMonitoring();
    
    if (this.isLeader) {
      await this.releaseLeadership();
    }

    this.logger.info('[FilesystemClusterOrchestrator] Cleanup complete');
  }
}

module.exports = { FilesystemClusterOrchestrator };
