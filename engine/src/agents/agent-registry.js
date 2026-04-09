/**
 * AgentRegistry - Tracks all spawned agents and their status
 * 
 * Responsibilities:
 * - Register new agents when spawned
 * - Track active/completed/failed agents
 * - Listen to agent lifecycle events
 * - Provide statistics and status queries
 * - Enforce concurrency limits
 */
class AgentRegistry {
  constructor(logger) {
    this.logger = logger;
    this.agents = new Map(); // agentId -> agentState
    this.activeAgents = new Set(); // Set of active agent IDs
    this.completedAgents = new Map(); // agentId -> completedAgentState
    this.failedAgents = new Map(); // agentId -> failedAgentState
  }

  /**
   * Register a new agent
   * @param {BaseAgent} agent - The agent instance to register
   * @param {Object} metadata - Additional metadata (spawnedBy, spawnCycle, etc.)
   */
  register(agent, metadata = {}) {
    const agentState = {
      agent,
      mission: agent.mission,
      status: agent.status,
      startTime: agent.startTime,
      spawnedBy: metadata.spawnedBy || 'meta_coordinator',
      spawnCycle: metadata.spawnCycle || null,
      registeredAt: new Date()
    };

    this.agents.set(agent.agentId, agentState);
    this.activeAgents.add(agent.agentId);

    // Listen to agent lifecycle events
    agent.on('complete', () => this.onAgentComplete(agent));
    agent.on('error', (data) => this.onAgentError(agent, data.error));
    agent.on('timeout', () => this.onAgentTimeout(agent));
    agent.on('progress', (data) => this.onAgentProgress(agent, data));

    this.logger.info('✅ Agent registered', {
      agentId: agent.agentId,
      type: agent.constructor.name,
      goal: agent.mission.goalId,
      spawnedBy: agentState.spawnedBy
    }, 3);

    return agentState;
  }

  /**
   * Handle agent completion
   */
  onAgentComplete(agent) {
    this.activeAgents.delete(agent.agentId);
    
    const agentState = this.agents.get(agent.agentId);
    if (agentState) {
      agentState.status = 'completed';
      agentState.endTime = agent.endTime;
      agentState.duration = agent.endTime - agent.startTime;
      this.completedAgents.set(agent.agentId, agentState);
    }
    
    this.logger.info('✅ Agent completed', {
      agentId: agent.agentId,
      type: agent.constructor.name,
      duration: agentState?.duration ? `${(agentState.duration / 1000).toFixed(1)}s` : 'unknown',
      resultsCount: agent.results.length
    }, 3);
  }

  /**
   * Handle agent error
   */
  onAgentError(agent, error) {
    this.activeAgents.delete(agent.agentId);
    
    const agentState = this.agents.get(agent.agentId);
    if (agentState) {
      agentState.status = 'failed';
      agentState.endTime = new Date();
      agentState.error = error;
      this.failedAgents.set(agent.agentId, agentState);
    }
    
    this.logger.error('❌ Agent failed', {
      agentId: agent.agentId,
      type: agent.constructor.name,
      error: error?.message || 'Unknown error',
      errorsCount: agent.errors.length
    }, 3);
  }

  /**
   * Handle agent timeout
   */
  onAgentTimeout(agent) {
    this.activeAgents.delete(agent.agentId);
    
    const agentState = this.agents.get(agent.agentId);
    if (agentState) {
      agentState.status = 'timeout';
      agentState.endTime = new Date();
      this.failedAgents.set(agent.agentId, agentState);
    }
    
    this.logger.warn('⏱️  Agent timeout', {
      agentId: agent.agentId,
      type: agent.constructor.name,
      mission: agent.mission.description,
      maxDuration: agent.mission.maxDuration
    }, 3);
  }

  /**
   * Handle agent progress updates
   */
  onAgentProgress(agent, data) {
    this.logger.debug('Agent progress update', {
      agentId: agent.agentId,
      percent: data.percent,
      message: data.message
    }, 3);
  }

  /**
   * Get current count of active agents
   */
  getActiveCount() {
    return this.activeAgents.size;
  }

  /**
   * Check if we can spawn more agents given a concurrency limit
   * @param {number} maxConcurrent - Maximum allowed concurrent agents
   * @returns {boolean}
   */
  canSpawnMore(maxConcurrent) {
    return this.activeAgents.size < maxConcurrent;
  }

  /**
   * Get agent by ID
   * @param {string} agentId
   * @returns {Object|null}
   */
  getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  /**
   * Get all active agents
   * @returns {Array}
   */
  getActiveAgents() {
    return Array.from(this.activeAgents)
      .map(id => this.agents.get(id))
      .filter(a => a !== undefined);
  }

  /**
   * Get agents by status
   * @param {string} status - 'initialized', 'running', 'completed', 'failed', 'timeout'
   * @returns {Array}
   */
  getAgentsByStatus(status) {
    return Array.from(this.agents.values())
      .filter(a => a.status === status);
  }

  /**
   * Get agents working on a specific goal
   * @param {string} goalId
   * @returns {Array}
   */
  getAgentsByGoal(goalId) {
    return Array.from(this.agents.values())
      .filter(a => a.mission.goalId === goalId);
  }

  /**
   * Check if a goal is already being pursued by an active agent
   * @param {string} goalId
   * @returns {boolean}
   */
  isGoalBeingPursued(goalId) {
    return this.getActiveAgents()
      .some(a => a.mission.goalId === goalId);
  }

  /**
   * Get comprehensive statistics
   * @returns {Object}
   */
  getStats() {
    const all = Array.from(this.agents.values());
    
    return {
      total: this.agents.size,
      active: this.activeAgents.size,
      completed: this.completedAgents.size,
      failed: this.failedAgents.size,
      byStatus: {
        initialized: all.filter(a => a.status === 'initialized').length,
        running: all.filter(a => a.status === 'running').length,
        completed: all.filter(a => a.status === 'completed').length,
        failed: all.filter(a => a.status === 'failed').length,
        timeout: all.filter(a => a.status === 'timeout').length
      },
      byType: this.getTypeDistribution()
    };
  }

  /**
   * Get distribution of agent types
   */
  getTypeDistribution() {
    const distribution = {};
    
    for (const agentState of this.agents.values()) {
      const type = agentState.agent.constructor.name;
      distribution[type] = (distribution[type] || 0) + 1;
    }
    
    return distribution;
  }

  /**
   * Get recent activity summary
   * @param {number} limit - Number of recent agents to include
   * @returns {Array}
   */
  getRecentActivity(limit = 10) {
    return Array.from(this.agents.values())
      .sort((a, b) => {
        const aTime = a.endTime || a.startTime || a.registeredAt;
        const bTime = b.endTime || b.startTime || b.registeredAt;
        return bTime - aTime;
      })
      .slice(0, limit)
      .map(a => ({
        agentId: a.agent.agentId,
        type: a.agent.constructor.name,
        status: a.status,
        goal: a.mission.goalId,
        startTime: a.startTime,
        endTime: a.endTime,
        duration: a.duration
      }));
  }

  /**
   * Clear completed agents older than specified time
   * @param {number} maxAge - Max age in milliseconds (default: 1 hour)
   */
  cleanupOldAgents(maxAge = 3600000) {
    const cutoff = Date.now() - maxAge;
    const toRemove = [];

    for (const [agentId, agentState] of this.agents.entries()) {
      // Only remove completed/failed agents, not active ones
      if (agentState.status === 'completed' || 
          agentState.status === 'failed' || 
          agentState.status === 'timeout') {
        
        const endTime = agentState.endTime?.getTime() || 0;
        if (endTime > 0 && endTime < cutoff) {
          toRemove.push(agentId);
        }
      }
    }

    for (const agentId of toRemove) {
      this.agents.delete(agentId);
      this.completedAgents.delete(agentId);
      this.failedAgents.delete(agentId);
    }

    if (toRemove.length > 0) {
      this.logger.info('Cleaned up old agents', {
        removed: toRemove.length,
        remaining: this.agents.size
      }, 3);
    }
  }

  /**
   * Export registry state for persistence
   * @returns {Object}
   */
  exportState() {
    return {
      totalAgents: this.agents.size,
      active: Array.from(this.activeAgents),
      stats: this.getStats(),
      recentActivity: this.getRecentActivity(20),
      // NEW: Persist completed and failed agents (minimal state for hydration)
      // This ensures progress survives restarts
      completedAgents: Array.from(this.completedAgents.entries()).map(([id, state]) => ({
        id,
        agentId: id,
        agentType: state.agentType || state.agent?.constructor.name || null,
        mission: state.mission,
        metadata: state.metadata || state.agent?.metadata || null,
        status: state.status,
        startTime: state.startTime,
        endTime: state.endTime,
        duration: state.duration,
        resultsCount: state.agent?.results?.length || state.resultsCount || 0,
        accomplishment: state.agent?.accomplishment || state.accomplishment || null
      })),
      failedAgents: Array.from(this.failedAgents.entries()).map(([id, state]) => ({
        id,
        agentId: id,
        agentType: state.agentType || state.agent?.constructor.name || null,
        mission: state.mission,
        metadata: state.metadata || state.agent?.metadata || null,
        status: state.status,
        startTime: state.startTime,
        endTime: state.endTime,
        error: state.error
      }))
    };
  }

  /**
   * NEW: Import registry state from persistence
   * Hydrates completed/failed maps to ensure continuous validation
   */
  importState(state) {
    if (!state) return;
    
    if (state.completedAgents && Array.isArray(state.completedAgents)) {
      for (const agentData of state.completedAgents) {
        const id = agentData.id || agentData.agentId;
        // Create a minimal wrapper that behaves like an agent state
        const hydratedState = {
          ...agentData,
          agent: { 
            agentId: id,
            agentType: agentData.agentType,
            mission: agentData.mission,
            // Minimal mock of results for validation loop
            results: Array(agentData.resultsCount || 0).fill({ type: 'finding' }),
            accomplishment: agentData.accomplishment
          }
        };
        this.completedAgents.set(id, hydratedState);
        this.agents.set(id, hydratedState);
      }
    }
    
    if (state.failedAgents && Array.isArray(state.failedAgents)) {
      for (const agentData of state.failedAgents) {
        const id = agentData.id || agentData.agentId;
        const hydratedState = {
          ...agentData,
          agent: { 
            agentId: id,
            mission: agentData.mission
          }
        };
        this.failedAgents.set(id, hydratedState);
        this.agents.set(id, hydratedState);
      }
    }
    
    if (state.completedAgents || state.failedAgents) {
      this.logger.info('📋 Agent registry hydrated from state', {
        completed: this.completedAgents.size,
        failed: this.failedAgents.size,
        total: this.agents.size
      }, 3);
    }
  }
}

module.exports = { AgentRegistry };

