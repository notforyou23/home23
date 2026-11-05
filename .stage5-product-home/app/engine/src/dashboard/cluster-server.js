const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const ClusterStateStore = require('../cluster/cluster-state-store');
const FilesystemStateStore = require('../cluster/backends/filesystem-state-store');
const RedisStateStore = require('../cluster/backends/redis-state-store');

/**
 * COSMO Hive Mind Dashboard Server
 * Aggregates cognitive data from all cluster instances
 */
class ClusterDashboardServer {
  constructor(port = 3350, config = {}) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.fsRoot = config.fsRoot || process.env.CLUSTER_FS_ROOT || '/tmp/cosmo_cluster';
    
    // Cluster configuration
    this.basePort = config.baseDashboardPort || 3343;
    this.instanceCount = config.instanceCount || 3;
    this.refreshInterval = config.refreshInterval || 5000;
    this.backend = (config.backend || process.env.CLUSTER_BACKEND || 'filesystem').toLowerCase();
    this.redisUrl = config.redisUrl || process.env.CLUSTER_REDIS_URL || 'redis://localhost:6379';
    this.stateStoreCompression =
      config.stateStoreCompression ||
      (config.stateStore && config.stateStore.compressionThreshold) ||
      102400;
    this.operatorInstanceId =
      config.instanceId || process.env.CLUSTER_OPERATOR_INSTANCE || 'cluster-dashboard';
    this.coordinatorTimeoutMs = config.coordinatorTimeoutMs || 60000;
    this.coordinatorBarrierTtlMs = config.coordinatorBarrierTtlMs || 600000;
    this.logger = config.logger || console;
    this.stateStore = null;
    this.stateStorePromise = null;
    
    this.setupRoutes();
  }

  setupRoutes() {
    // Main hive mind dashboard
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'hive-mind.html'));
    });
    
    // Alternative cluster view (simpler)
    this.app.get('/simple', (req, res) => {
      res.sendFile(path.join(__dirname, 'cluster.html'));
    });
    
    // Aggregate thoughts from all instances
    this.app.get('/api/cluster/thoughts', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 20;
        const thoughts = await this.aggregateThoughts(limit);
        res.json(thoughts);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Aggregate goals from all instances
    this.app.get('/api/cluster/goals', async (req, res) => {
      try {
        const goals = await this.aggregateGoals();
        res.json(goals);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Aggregate memory stats
    this.app.get('/api/cluster/memory', async (req, res) => {
      try {
        const memory = await this.aggregateMemory();
        res.json(memory);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Aggregate agent activity
    this.app.get('/api/cluster/agents', async (req, res) => {
      try {
        const agents = await this.aggregateAgents();
        res.json(agents);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Aggregate stats
    this.app.get('/api/cluster/stats', async (req, res) => {
      try {
        const stats = await this.aggregateStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Cluster overview
    this.app.get('/api/cluster/overview', async (req, res) => {
      try {
        const overview = await this.getClusterOverview();
        res.json(overview);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Filesystem backend status
    this.app.get('/api/cluster/filesystem', async (req, res) => {
      try {
        const fsStatus = await this.getFilesystemStatus();
        res.json(fsStatus);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/cluster/governance/override', async (req, res) => {
      try {
        const stateStore = await this.ensureStateStore();
        const [override, snapshot] = await Promise.all([
          stateStore.getGovernanceOverride(),
          typeof stateStore.getGovernanceSnapshot === 'function'
            ? stateStore.getGovernanceSnapshot()
            : null
        ]);
        res.json({ override, snapshot });
      } catch (error) {
        this.logger.error('[ClusterDashboardServer] Failed to fetch governance override', {
          error: error.message
        });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/cluster/governance/override', async (req, res) => {
      try {
        const payload = req.body || {};
        const mode = typeof payload.mode === 'string' ? payload.mode.toLowerCase() : null;
        if (!mode || !['force_skip', 'force_proceed'].includes(mode)) {
          return res.status(400).json({ error: 'mode must be force_skip or force_proceed' });
        }

        const ttlMinutes = Number(payload.ttlMinutes);
        const requestedBy = payload.requestedBy || 'dashboard';
        const override = {
          mode,
          reason: payload.reason || null,
          requestedBy,
          requestedAt: new Date().toISOString(),
          applyOnce:
            payload.sticky === true
              ? false
              : payload.applyOnce !== undefined
              ? Boolean(payload.applyOnce)
              : true
        };

        if (Number.isFinite(ttlMinutes) && ttlMinutes > 0) {
          override.expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
        }

        const stateStore = await this.ensureStateStore();
        await stateStore.setGovernanceOverride(override);
        await stateStore.appendGovernanceEvent({
          event: 'override_set',
          mode: override.mode,
          reason: override.reason || null,
          requestedBy: override.requestedBy,
          expiresAt: override.expiresAt || null
        });

        res.json({ override });
      } catch (error) {
        this.logger.error('[ClusterDashboardServer] Failed to set governance override', {
          error: error.message
        });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/api/cluster/governance/override', async (req, res) => {
      try {
        const stateStore = await this.ensureStateStore();
        await stateStore.clearGovernanceOverride();
        await stateStore.appendGovernanceEvent({
          event: 'override_cleared',
          requestedBy: 'dashboard'
        });
        res.json({ cleared: true });
      } catch (error) {
        this.logger.error('[ClusterDashboardServer] Failed to clear governance override', {
          error: error.message
        });
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/cluster/governance/events', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit, 10);
        const stateStore = await this.ensureStateStore();
        const events = await stateStore.getGovernanceEvents(
          Number.isFinite(limit) && limit > 0 ? limit : 50
        );
        res.json({ events });
      } catch (error) {
        this.logger.error('[ClusterDashboardServer] Failed to fetch governance events', {
          error: error.message
        });
        res.status(500).json({ error: error.message });
      }
    });
  }

  async ensureStateStore() {
    if (this.stateStore) {
      return this.stateStore;
    }

    if (!this.stateStorePromise) {
      this.stateStorePromise = (async () => {
        const storeConfig = {
          instanceId: this.operatorInstanceId,
          instanceCount: this.instanceCount,
          fsRoot: this.fsRoot,
          stateStore: {
            url: this.redisUrl,
            compressionThreshold: this.stateStoreCompression
          },
          coordinator: {
            timeoutMs: this.coordinatorTimeoutMs,
            barrierTtlMs: this.coordinatorBarrierTtlMs
          }
        };

        let backend;
        if (this.backend === 'redis') {
          backend = new RedisStateStore(storeConfig, this.logger);
        } else {
          backend = new FilesystemStateStore(storeConfig, this.logger);
        }

        try {
          const stateStore = new ClusterStateStore(storeConfig, backend);
          await stateStore.connect();
          this.stateStore = stateStore;
          return stateStore;
        } catch (error) {
          this.logger.error('[ClusterDashboardServer] Failed to connect to state store', {
            error: error.message
          });
          this.stateStore = null;
          throw error;
        }
      })().finally(() => {
        this.stateStorePromise = null;
      });
    }

    return this.stateStorePromise;
  }

  /**
   * Fetch data from instance endpoint
   */
  async fetchFromInstance(port, endpoint) {
    const timeout = 3000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(`http://localhost:${port}${endpoint}`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      clearTimeout(timeoutId);
      return null;
    }
  }

  /**
   * Aggregate thoughts from all instances
   */
  async aggregateThoughts(limit = 20) {
    const allThoughts = [];
    
    for (let i = 1; i <= this.instanceCount; i++) {
      const port = this.basePort + i - 1;
      const thoughts = await this.fetchFromInstance(port, `/api/thoughts?limit=${limit}`);
      
      if (thoughts && Array.isArray(thoughts)) {
        thoughts.forEach(thought => {
          allThoughts.push({
            ...thought,
            instanceId: `cosmo-${i}`,
            instancePort: port
          });
        });
      }
    }
    
    // Sort by timestamp (most recent first)
    allThoughts.sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeB - timeA;
    });
    
    return allThoughts.slice(0, limit);
  }

  /**
   * Aggregate goals from all instances
   */
  async aggregateGoals() {
    const allGoals = {
      active: [],
      completed: [],
      archived: [],
      byInstance: {},
      claimSummary: {
        totalActive: 0,
        claimed: 0,
        unclaimed: 0,
        byInstance: {}
      },
      specialization: {
        totalAnnotated: 0,
        preferredCounts: {},
        matchCounts: {},
        mismatchCounts: {},
        unclaimedCounts: {},
        activeClaimedMatches: 0,
        activeClaimedMismatches: 0
      }
    };
    
    for (let i = 1; i <= this.instanceCount; i++) {
      const port = this.basePort + i - 1;
      const instanceId = `cosmo-${i}`;
      const goals = await this.fetchFromInstance(port, '/api/goals');
      
      if (goals) {
        allGoals.byInstance[instanceId] = {
          active: goals.active?.length || 0,
          completed: goals.completed?.length || 0,
          archived: goals.archived?.length || 0
        };
        
        // Add to combined lists with instance tagging
        if (goals.active) {
          goals.active.forEach(goal => {
            const claimedBy = goal.claimedBy || goal.claimed_by || null;
            if (claimedBy) {
              allGoals.claimSummary.claimed++;
              allGoals.claimSummary.byInstance[claimedBy] = (allGoals.claimSummary.byInstance[claimedBy] || 0) + 1;
            }

            const metadata = goal.metadata || {};
            const preferredInstanceRaw = metadata.preferredInstance || metadata.preferredInstances;
            const preferredList = Array.isArray(preferredInstanceRaw)
              ? preferredInstanceRaw
              : [preferredInstanceRaw];

            preferredList
              .map(value => (value || '').toString().toLowerCase())
              .filter(Boolean)
              .forEach(preferredInstance => {
                allGoals.specialization.totalAnnotated++;
                allGoals.specialization.preferredCounts[preferredInstance] = (allGoals.specialization.preferredCounts[preferredInstance] || 0) + 1;

                if (claimedBy) {
                  const claimedNormalized = claimedBy.toString().toLowerCase();
                  if (claimedNormalized === preferredInstance) {
                    allGoals.specialization.matchCounts[preferredInstance] = (allGoals.specialization.matchCounts[preferredInstance] || 0) + 1;
                    allGoals.specialization.activeClaimedMatches++;
                  } else {
                    allGoals.specialization.mismatchCounts[preferredInstance] = (allGoals.specialization.mismatchCounts[preferredInstance] || 0) + 1;
                    allGoals.specialization.activeClaimedMismatches++;
                  }
                } else {
                  allGoals.specialization.unclaimedCounts[preferredInstance] = (allGoals.specialization.unclaimedCounts[preferredInstance] || 0) + 1;
                }
              });

            allGoals.active.push({
              ...goal,
              claimedBy,
              instanceId,
              port
            });
          });
        }
        if (goals.completed) {
          goals.completed.forEach(goal => {
            allGoals.completed.push({ ...goal, instanceId, port });
          });
        }
        if (goals.archived) {
          goals.archived.forEach(goal => {
            allGoals.archived.push({ ...goal, instanceId, port });
          });
        }
      }
    }

    allGoals.claimSummary.totalActive = allGoals.active.length;
    allGoals.claimSummary.claimed = allGoals.claimSummary.claimed || 0;
    allGoals.claimSummary.unclaimed = Math.max(0, allGoals.claimSummary.totalActive - allGoals.claimSummary.claimed);

    return allGoals;
  }

  /**
   * Aggregate memory statistics and graphs
   */
  async aggregateMemory() {
    const aggregated = {
      totalNodes: 0,
      totalEdges: 0,
      byInstance: {},
      clusterDistribution: []
    };
    
    for (let i = 1; i <= this.instanceCount; i++) {
      const port = this.basePort + i - 1;
      const instanceId = `cosmo-${i}`;
      const memory = await this.fetchFromInstance(port, '/api/memory');
      
      if (memory) {
        const nodeCount = memory.nodes?.length || 0;
        const edgeCount = memory.edges?.length || 0;
        
        aggregated.totalNodes += nodeCount;
        aggregated.totalEdges += edgeCount;
        
        // Store full graph data for merging
        aggregated.byInstance[instanceId] = {
          nodes: memory.nodes || [],
          edges: memory.edges || [],
          clusters: memory.clusters || [],
          nodeCount,
          edgeCount
        };
        
        aggregated.clusterDistribution.push({
          instanceId,
          nodes: nodeCount,
          edges: edgeCount
        });
      }
    }
    
    return aggregated;
  }

  /**
   * Aggregate agent activity
   */
  async aggregateAgents() {
    const aggregated = {
      totalActive: 0,
      totalCompleted: 0,
      byInstance: {},
      byType: {},
      recentActivity: []
    };
    
    for (let i = 1; i <= this.instanceCount; i++) {
      const port = this.basePort + i - 1;
      const instanceId = `cosmo-${i}`;
      const agents = await this.fetchFromInstance(port, '/api/agents');
      
      if (agents && agents.stats) {
        const active = agents.activeAgents?.length || 0;
        const completed = agents.stats.completedCount || 0;
        
        aggregated.totalActive += active;
        aggregated.totalCompleted += completed;
        
        aggregated.byInstance[instanceId] = {
          active,
          completed,
          agents: agents.activeAgents || []
        };
        
        // Aggregate by type
        if (agents.stats.byType) {
          Object.entries(agents.stats.byType).forEach(([type, count]) => {
            aggregated.byType[type] = (aggregated.byType[type] || 0) + count;
          });
        }
        
        // Add recent activity
        if (agents.activeAgents) {
          agents.activeAgents.forEach(agent => {
            aggregated.recentActivity.push({
              ...agent,
              instanceId,
              port
            });
          });
        }
      }
    }
    
    return aggregated;
  }

  /**
   * Aggregate stats from all instances
   */
  async aggregateStats() {
    const aggregated = {
      totalCycles: 0,
      totalWebSearches: 0,
      instances: [],
      clusterHealth: 'unknown',
      leaderInstance: null,
      syncMetrics: [],
      specializationSignals: []
    };
    
    let healthyCount = 0;
    
    for (let i = 1; i <= this.instanceCount; i++) {
      const port = this.basePort + i - 1;
      const instanceId = `cosmo-${i}`;
      const stats = await this.fetchFromInstance(port, '/api/stats');
      
      if (stats) {
        healthyCount++;
        
        aggregated.totalCycles += stats.cycleCount || 0;
        aggregated.totalWebSearches += stats.webSearchCount || 0;
        
        const instanceRecord = {
          instanceId,
          port,
          cycles: stats.cycleCount || 0,
          goals: stats.goalCount || 0,
          memory: stats.memoryNodeCount || 0,
          webSearches: stats.webSearchCount || 0,
          status: 'healthy',
          clusterSync: stats.clusterSync || null,
          coordinator: stats.coordinator || null,
          reviewPlan: stats.clusterSync?.reviewPlan || null,
          reviewPlanRole: stats.clusterSync?.reviewPlanRole || null
        };

        if (stats.goalAllocator) {
          instanceRecord.goalAllocator = stats.goalAllocator;
        }
        
        aggregated.instances.push(instanceRecord);
        
        if (stats.clusterSync) {
          aggregated.syncMetrics.push({
            instanceId,
            ...stats.clusterSync
          });
        }

        if (stats.coordinator?.specialization) {
          aggregated.specializationSignals.push({
            instanceId,
            ...stats.coordinator.specialization
          });
        }
        
        // Simple leader heuristic: first healthy instance
        if (!aggregated.leaderInstance) {
          aggregated.leaderInstance = instanceId;
        }
      } else {
        aggregated.instances.push({
          instanceId,
          port,
          status: 'unreachable'
        });
      }
    }
    
    const quorum = Math.ceil(this.instanceCount / 2);
    aggregated.clusterHealth = healthyCount >= quorum ? 'healthy' : 'degraded';
    aggregated.clusterSyncSummary = this.computeSyncSummary(aggregated.syncMetrics);

    const allocatorStats = aggregated.instances
      .filter(inst => inst.goalAllocator)
      .map(inst => ({ instanceId: inst.instanceId, ...inst.goalAllocator }));

    if (allocatorStats.length > 0) {
      const totals = allocatorStats.reduce((acc, stats) => {
        const specStats = stats.specializationStats || {};
        if (!acc.claimsByPreferredInstance) {
          acc.claimsByPreferredInstance = new Map();
        }

        if (specStats.claimsByPreferredInstance) {
          Object.entries(specStats.claimsByPreferredInstance).forEach(([key, value]) => {
            const normalizedKey = key.toLowerCase();
            const current = acc.claimsByPreferredInstance.get(normalizedKey) || 0;
            acc.claimsByPreferredInstance.set(normalizedKey, current + (value || 0));
          });
        }

        return {
          attempts: acc.attempts + (stats.claimAttempts || 0),
          successes: acc.successes + (stats.claimSuccesses || 0),
          failures: acc.failures + (stats.claimFailures || 0),
          completions: acc.completions + (stats.completions || 0),
          releases: acc.releases + (stats.releases || 0),
          steals: acc.steals + (stats.workSteals || 0),
          preferredMatches: acc.preferredMatches + (specStats.preferredMatches || 0),
          preferredMismatches: acc.preferredMismatches + (specStats.preferredMismatches || 0),
          annotatedClaims: acc.annotatedClaims + (specStats.annotatedClaims || 0),
          unannotatedClaims: acc.unannotatedClaims + (specStats.unannotatedClaims || 0),
          totalWeight: acc.totalWeight + (specStats.totalWeight || 0),
          weightSamples: acc.weightSamples + (specStats.totalClaims || 0),
          claimsByPreferredInstance: acc.claimsByPreferredInstance
        };
      }, {
        attempts: 0,
        successes: 0,
        failures: 0,
        completions: 0,
        releases: 0,
        steals: 0,
        preferredMatches: 0,
        preferredMismatches: 0,
        annotatedClaims: 0,
        unannotatedClaims: 0,
        totalWeight: 0,
        weightSamples: 0,
        claimsByPreferredInstance: new Map()
      });

      const claimsByPreferredInstance = Object.fromEntries(totals.claimsByPreferredInstance);
      const avgWeight = totals.weightSamples > 0
        ? totals.totalWeight / totals.weightSamples
        : 1;

      aggregated.goalAllocatorSummary = {
        totalAttempts: totals.attempts,
        totalClaims: totals.successes,
        totalSuccesses: totals.successes,
        totalFailures: totals.failures,
        totalCompletions: totals.completions,
        totalReleases: totals.releases,
        totalSteals: totals.steals,
        successRate: totals.attempts > 0 ? totals.successes / totals.attempts : 0,
        duplicateRate: totals.attempts > 0 ? totals.failures / totals.attempts : 0,
        preferredMatches: totals.preferredMatches,
        preferredMismatches: totals.preferredMismatches,
        annotatedClaims: totals.annotatedClaims,
        unannotatedClaims: totals.unannotatedClaims,
        avgSpecializationWeight: Number.isFinite(avgWeight) ? avgWeight : 1,
        claimsByPreferredInstance,
        instances: allocatorStats.map(stats => {
          const rate = typeof stats.successRate === 'string'
            ? parseFloat(stats.successRate) / 100
            : 0;
          const attempts = stats.claimAttempts || 0;
          const failures = stats.claimFailures || 0;
          return {
            instanceId: stats.instanceId,
            claimAttempts: attempts,
            claimSuccesses: stats.claimSuccesses || 0,
            claimFailures: stats.claimFailures || 0,
            successRate: Number.isFinite(rate) ? rate : 0,
            duplicateRate: attempts > 0 ? failures / attempts : 0,
            completions: stats.completions || 0,
            releases: stats.releases || 0,
            workSteals: stats.workSteals || 0,
            specializationStats: stats.specializationStats || null
          };
        })
      };
    } else {
      aggregated.goalAllocatorSummary = null;
    }

    const barrierSnapshots = aggregated.instances
      .map(inst => inst.coordinator?.lastBarrier)
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    aggregated.barrier = barrierSnapshots.length > 0 ? barrierSnapshots[0] : null;

    return aggregated;
  }

  /**
   * Get cluster overview
   */
  async getClusterOverview() {
    const [stats, goals, memory, agents, review] = await Promise.all([
      this.aggregateStats(),
      this.aggregateGoals(),
      this.aggregateMemory(),
      this.aggregateAgents(),
      this.getReviewPipelineStatus()
    ]);

    const specializationAlignment = this.computeSpecializationAlignment(
      goals.specialization,
      stats.goalAllocatorSummary,
      goals.claimSummary,
      stats.specializationSignals
    );
    
    let governanceSummary = this.selectGovernanceState(stats.instances, review);
    let governanceOverride = null;
    let governanceSnapshot = null;
    let governanceEvents = [];

    try {
      const stateStore = await this.ensureStateStore();
      if (stateStore) {
        const [override, snapshot, events] = await Promise.all([
          stateStore.getGovernanceOverride(),
          typeof stateStore.getGovernanceSnapshot === 'function'
            ? stateStore.getGovernanceSnapshot()
            : null,
          stateStore.getGovernanceEvents(25)
        ]);

        governanceOverride = override || null;
        governanceSnapshot = snapshot || null;
        governanceEvents = Array.isArray(events) ? events : [];

        if (!governanceSummary && snapshot) {
          governanceSummary = snapshot;
        }
      }
    } catch (error) {
      this.logger.warn('[ClusterDashboardServer] Failed to load governance state store data', {
        error: error.message
      });
    }

    return {
      health: stats.clusterHealth,
      leader: stats.leaderInstance,
      instances: stats.instances,
      cognitive: {
        totalCycles: stats.totalCycles,
        totalGoals: goals.active.length,
        totalMemoryNodes: memory.totalNodes,
        totalActiveAgents: agents.totalActive,
        claimedGoals: goals.claimSummary.claimed,
        unclaimedGoals: goals.claimSummary.unclaimed
      },
      sync: stats.clusterSyncSummary,
      goalClaims: goals.claimSummary,
      goalAllocator: stats.goalAllocatorSummary,
      specialization: specializationAlignment,
      barrier: stats.barrier,
      review,
      governance: {
        summary: governanceSummary || null,
        snapshot: governanceSnapshot || null,
        override: governanceOverride,
        events: governanceEvents
      },
      timestamp: Date.now()
    };
  }

  selectGovernanceState(instances, review) {
    const fromInstances = (instances || [])
      .map(inst => inst.coordinator?.lastGovernance)
      .find(Boolean);
    if (fromInstances) {
      return fromInstances;
    }
    if (review && review.plan && review.plan.governance) {
      return review.plan.governance;
    }
    return review?.governance || null;
  }

  async safeReadJSON(filePath, defaultValue = null) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return defaultValue;
    }
  }

  summarizeArtifact(artifact) {
    if (!artifact) return null;

    const summary = {
      artifactId: artifact.artifactId || null,
      artifactType: artifact.artifactType || null,
      status: artifact.status || 'unknown',
      instanceId: artifact.instanceId || null,
      role: artifact.role || null,
      createdAt: artifact.createdAt || null,
      updatedAt: artifact.updatedAt || null,
      planId: artifact.planId || null,
      summary: artifact.summary || null
    };

    if (artifact.draftArtifactId) {
      summary.draftArtifactId = artifact.draftArtifactId;
    }
    if (Array.isArray(artifact.critiqueArtifacts)) {
      summary.critiqueArtifacts = artifact.critiqueArtifacts;
    }
    if (artifact.mission) {
      summary.mission = {
        missionId: artifact.mission.missionId || null,
        goalId: artifact.mission.goalId || null,
        agentType: artifact.mission.agentType || null,
        agentId: artifact.mission.agentId || null,
        spawnedAt: artifact.mission.spawnedAt || null,
        completedAt: artifact.mission.completedAt || null,
        status: artifact.mission.status || null
      };
    }

    return summary;
  }

  async getReviewPipelineStatus() {
    const fsRoot = this.fsRoot;
    const reviewsDir = path.join(fsRoot, 'reviews');

    try {
      await fs.stat(reviewsDir);
    } catch (error) {
      return null;
    }

    try {
      const entries = await fs.readdir(reviewsDir);
      const cycles = entries
        .map((name) => {
          const match = name.match(/^cycle_(\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => b - a);

      if (cycles.length === 0) {
        return null;
      }

      const latestCycle = cycles[0];
      const cycleDir = path.join(reviewsDir, `cycle_${latestCycle}`);
      const plan = await this.safeReadJSON(path.join(cycleDir, 'plan.json'), null);

      const files = await fs.readdir(cycleDir);
      const artifacts = [];

      for (const file of files) {
        if (file === 'plan.json' || !file.endsWith('.json') || file.startsWith('ready_')) {
          continue;
        }
        const artifact = await this.safeReadJSON(path.join(cycleDir, file), null);
        if (artifact) {
          artifacts.push(artifact);
        }
      }

      const draft = artifacts.find((artifact) => artifact.artifactType === 'draft') || null;
      const critiques = artifacts.filter((artifact) => artifact.artifactType === 'critique');
      const synthesis = artifacts.filter((artifact) => artifact.artifactType === 'synthesis');

      const planSummary = plan
        ? {
            planId: plan.planId || null,
            status: plan.status || 'assigned',
            createdAt: plan.createdAt || null,
            createdBy: plan.createdBy || null,
            assignments: {
              authors: plan.assignments?.authors || [],
              critics: plan.assignments?.critics || [],
              synthesizer: plan.assignments?.synthesizer || null
            },
            warnings: plan.warnings || [],
            rosterSize: Array.isArray(plan.roster) ? plan.roster.length : 0,
            readyCount: plan.readyCount || 0,
            pipeline: Array.isArray(plan.pipeline) ? plan.pipeline : [],
            governance: plan.governance || null
          }
        : null;

      return {
        cycle: latestCycle,
        plan: planSummary,
        governance: planSummary?.governance || null,
        artifacts: {
          draft: this.summarizeArtifact(draft),
          critiques: critiques.map((artifact) => this.summarizeArtifact(artifact)),
          synthesis: synthesis.map((artifact) => this.summarizeArtifact(artifact))
        }
      };
    } catch (error) {
      return null;
    }
  }

  computeSpecializationAlignment(specializationSummary, allocatorSummary, claimSummary, routingSignals = []) {
    if (!specializationSummary || specializationSummary.totalAnnotated === 0) {
      return null;
    }

    const totalAnnotated = specializationSummary.totalAnnotated;

    const expectedDistribution = {};
    Object.entries(specializationSummary.preferredCounts || {}).forEach(([instanceId, count]) => {
      expectedDistribution[instanceId] = count / totalAnnotated;
    });

    const claimDistribution = {};
    if (allocatorSummary?.instances?.length) {
      const totalClaims = allocatorSummary.instances.reduce((sum, inst) => sum + (inst.claimSuccesses || 0), 0);
      if (totalClaims > 0) {
        allocatorSummary.instances.forEach(inst => {
          const fraction = inst.claimSuccesses / totalClaims;
          claimDistribution[inst.instanceId.toLowerCase()] = fraction;
        });
      }
    }

    const activeClaimDistribution = {};
    const activeClaims = claimSummary?.byInstance || {};
    const totalActiveClaims = Object.values(activeClaims).reduce((sum, value) => sum + value, 0);
    if (totalActiveClaims > 0) {
      Object.entries(activeClaims).forEach(([instanceId, value]) => {
        activeClaimDistribution[instanceId.toLowerCase()] = value / totalActiveClaims;
      });
    }

    const alignmentInstances = new Set([
      ...Object.keys(expectedDistribution),
      ...Object.keys(claimDistribution)
    ]);

    let divergence = 0;
    const claimDelta = {};
    alignmentInstances.forEach(instanceId => {
      const expected = expectedDistribution[instanceId] || 0;
      const actual = claimDistribution[instanceId] || 0;
      divergence += Math.abs(expected - actual);
      claimDelta[instanceId] = actual - expected;
    });
    divergence = Math.min(divergence, 2); // Safety clamp
    const alignmentScore = 1 - (divergence / 2);

    const matchAttempts = specializationSummary.activeClaimedMatches + specializationSummary.activeClaimedMismatches;
    const matchRate = matchAttempts > 0
      ? specializationSummary.activeClaimedMatches / matchAttempts
      : null;

    const activeClaimDelta = {};
    Object.keys(activeClaimDistribution).forEach(instanceId => {
      const expected = expectedDistribution[instanceId] || 0;
      const activeActual = activeClaimDistribution[instanceId] || 0;
      activeClaimDelta[instanceId] = activeActual - expected;
    });

    const routingByInstance = {};
    routingSignals
      .filter(Boolean)
      .forEach(signal => {
        const key = (signal.instanceId || '').toLowerCase();
        if (!key) return;

        const routing = signal.lastRouting || null;
        const weights = Array.isArray(routing?.weights) ? routing.weights : [];
        const totalWeight = weights.reduce((sum, entry) => sum + (entry.weight || 0), 0);

        routingByInstance[key] = {
          instanceId: signal.instanceId,
          profileName: signal.profileName || signal.instanceId,
          boostedGoals: signal.boostedGoals || routing?.boosted?.length || 0,
          penalizedGoals: signal.penalizedGoals || routing?.penalized?.length || 0,
          averageWeight: weights.length > 0 ? totalWeight / weights.length : null,
          lastRouting: routing
        };
      });

    return {
      totalAnnotated,
      expectedDistribution,
      claimDistribution,
      activeClaimDistribution,
      alignmentScore,
      matchRate,
      matches: specializationSummary.activeClaimedMatches,
      mismatches: specializationSummary.activeClaimedMismatches,
      annotatedClaims: allocatorSummary?.annotatedClaims || 0,
      claimsByPreferredInstance: allocatorSummary?.claimsByPreferredInstance || {},
      claimDelta,
      activeClaimDelta,
      routingSignals: routingByInstance
    };
  }

  computeSyncSummary(syncMetrics) {
    if (!syncMetrics || syncMetrics.length === 0) {
      return null;
    }

    const latest = syncMetrics.reduce((current, entry) => {
      if (!current) return entry;
      const currentCycle = current.lastCycle || 0;
      const entryCycle = entry.lastCycle || 0;
      if (entryCycle > currentCycle) {
        return entry;
      }
      if (entryCycle === currentCycle) {
        if ((entry.lastRole || '').toLowerCase() === 'leader' && (current.lastRole || '').toLowerCase() !== 'leader') {
          return entry;
        }
      }
      return current;
    }, null);

    const avgBarrier = syncMetrics.reduce((sum, entry) => {
      return sum + (entry.barrier?.waitedMs || 0);
    }, 0) / syncMetrics.length;

    const successRate = syncMetrics.length > 0
      ? syncMetrics.filter(entry => entry.success !== false).length / syncMetrics.length
      : 0;

    return {
      latestCycle: latest?.lastCycle || 0,
      avgBarrierMs: Number.isFinite(avgBarrier) ? Math.round(avgBarrier) : 0,
      lastDiffCount: latest?.merge?.diffCount || 0,
      lastRole: latest?.lastRole || 'unknown',
      successRate: Number.isFinite(successRate) ? successRate : 0,
      lastUpdated: latest?.lastUpdated || null
    };
  }

  /**
   * Get filesystem backend status
   */
  async getFilesystemStatus() {
    const fsRoot = this.fsRoot;
    
    try {
      await fs.stat(fsRoot);
      
      let beaconCount = 0;
      let barrierCount = 0;
      let leaderLock = null;
      
      try {
        const beacons = await fs.readdir(path.join(fsRoot, 'health'));
        beaconCount = beacons.filter(f => f.endsWith('.json')).length;
      } catch (e) {}
      
      try {
        const barriers = await fs.readdir(path.join(fsRoot, 'barriers'));
        barrierCount = barriers.filter(f => f.startsWith('cycle_')).length;
      } catch (e) {}
      
      try {
        leaderLock = await fs.readFile(path.join(fsRoot, 'control', 'LEADER'), 'utf8');
        leaderLock = leaderLock.trim();
      } catch (e) {}
      
      return {
        fsRoot,
        exists: true,
        beaconCount,
        barrierCount,
        leaderLock,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        fsRoot,
        exists: false,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`🌐 COSMO Hive Mind Dashboard: http://localhost:${this.port}`);
      console.log(`   Aggregating cognitive data from ${this.instanceCount} instances`);
    });
    
    return this.server;
  }

  stop() {
    if (this.server) {
      const serverInstance = this.server;
      this.server = null;
      serverInstance.close();
    }
    if (this.stateStore && typeof this.stateStore.disconnect === 'function') {
      this.stateStore.disconnect().catch(() => {});
    }
    this.stateStore = null;
    this.stateStorePromise = null;
  }
}

// Standalone server mode
if (require.main === module) {
  const port = parseInt(process.env.CLUSTER_DASHBOARD_PORT || '3350');
  const instanceCount = parseInt(process.env.INSTANCE_COUNT || '3');
  const basePort = parseInt(process.env.BASE_DASHBOARD_PORT || '3343');
  const backend = process.env.CLUSTER_BACKEND || 'filesystem';
  const fsRoot = process.env.CLUSTER_FS_ROOT;
  const redisUrl = process.env.CLUSTER_REDIS_URL;
  const operatorInstance = process.env.CLUSTER_OPERATOR_INSTANCE;
  
  const server = new ClusterDashboardServer(port, {
    instanceCount,
    baseDashboardPort: basePort,
    backend,
    fsRoot,
    redisUrl,
    instanceId: operatorInstance
  });
  
  server.start();
  
  process.on('SIGINT', () => {
    console.log('\n🛑 Stopping cluster dashboard...');
    server.stop();
    process.exit(0);
  });
}

module.exports = { ClusterDashboardServer };
