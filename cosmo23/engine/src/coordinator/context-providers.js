/**
 * Context Providers for Action Coordinator
 * 
 * Lightweight adapters that expose COSMO's existing systems
 * in a format Action Coordinator can consume.
 */

/**
 * Goals Context Provider
 * Provides access to COSMO's goal system
 */
class GoalsContextProvider {
  constructor(goalsSystem) {
    this.goals = goalsSystem;
  }
  
  async getState() {
    const allGoals = this.goals.getGoals();
    
    return {
      activeGoals: allGoals.filter(g => g.status === 'active'),
      completedGoals: allGoals.filter(g => g.status === 'completed'),
      totalGoals: allGoals.length,
      timestamp: Date.now()
    };
  }
}

/**
 * Memory Context Provider
 * Provides access to COSMO's network memory
 */
class MemoryContextProvider {
  constructor(memorySystem) {
    this.memory = memorySystem;
  }
  
  async getState() {
    return {
      nodeCount: this.memory.nodes?.size || 0,
      edgeCount: this.memory.edges?.length || 0,
      recentNodes: this.getRecentNodes(10),
      timestamp: Date.now()
    };
  }
  
  getRecentNodes(limit = 10) {
    if (!this.memory.nodes) return [];
    
    const nodes = Array.from(this.memory.nodes.values());
    return nodes
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, limit)
      .map(n => ({
        id: n.id,
        content: n.content?.substring(0, 100),
        created: n.created
      }));
  }
}

/**
 * Plans Context Provider
 * Provides access to current and past plans
 */
class PlansContextProvider {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }
  
  async getAll() {
    return {
      currentPlan: this.orchestrator.guidedMissionPlan || null,
      planId: this.orchestrator.currentPlanId || null,
      domain: this.orchestrator.guidedDomain || null,
      timestamp: Date.now()
    };
  }
}

/**
 * Thoughts Context Provider
 * Provides access to recent autonomous thinking
 */
class ThoughtsContextProvider {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }
  
  async getRecent(limit = 50) {
    // Get recent journal entries (COSMO's thought stream)
    const journal = this.orchestrator.journal || [];
    return journal.slice(-limit).map(entry => ({
      cycle: entry.cycle,
      content: entry.thought || entry.content,
      timestamp: entry.timestamp
    }));
  }
}

/**
 * Surprises Context Provider
 * Provides access to anomalies and surprises
 */
class SurprisesContextProvider {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }
  
  async getRecent() {
    // COSMO's surprise detection (from quantum reasoner)
    const surprises = this.orchestrator.quantum?.surprises || [];
    return surprises.slice(-10);
  }
}

/**
 * Agents Context Provider
 * Provides access to active agent information
 */
class AgentsContextProvider {
  constructor(agentExecutor) {
    this.agentExecutor = agentExecutor;
  }
  
  async getActivity() {
    const activeAgents = this.agentExecutor?.registry?.getActiveAgents() || [];
    
    return {
      active: activeAgents.map(agent => ({
        agentId: agent.agentId,
        type: agent.agentType || 'unknown',
        status: agent.status || 'working',
        goal: agent.mission?.description?.substring(0, 100),
        startTime: agent.startTime
      })),
      count: activeAgents.length,
      timestamp: Date.now()
    };
  }
}

/**
 * Artifacts Context Provider
 * Leverages existing systems (results queue + memory network)
 */
class ArtifactsContextProvider {
  constructor(memory, agentExecutor) {
    this.memory = memory;
    this.agentExecutor = agentExecutor;
  }
  
  async buildIndex() {
    // Option C: Leverage existing infrastructure
    const artifactNodes = this.getArtifactNodes();
    const agentResults = this.getAgentResults();
    
    return {
      memoryArtifacts: artifactNodes,
      agentOutputs: agentResults,
      totalCount: artifactNodes.length + agentResults.length,
      timestamp: Date.now()
    };
  }
  
  getArtifactNodes() {
    if (!this.memory.nodes) return [];
    
    // Find nodes marked as artifacts
    return Array.from(this.memory.nodes.values())
      .filter(n => n.type === 'artifact' || n.tags?.includes('artifact'))
      .map(n => ({
        id: n.id,
        content: n.content?.substring(0, 100),
        created: n.created
      }));
  }
  
  getAgentResults() {
    // Get recent agent deliverables
    const results = this.agentExecutor?.resultsQueue || [];
    return results.slice(-20).map(r => ({
      agentId: r.agentId,
      type: r.type,
      output: r.output?.substring(0, 100),
      timestamp: r.timestamp
    }));
  }
}

/**
 * Voice Context Provider
 * Provides access to COSMO Speaks voice signals
 */
class VoiceContextProvider {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.voiceLogPath = null; // Will be set if voice.jsonl exists
  }
  
  async getRecent(limit = 20) {
    // TODO: Read voice.jsonl if it exists
    // For now, return empty (COSMO Speaks integration is optional)
    return [];
  }
}

/**
 * Executive Context Provider
 * Provides access to Executive Ring (dlPFC) state
 */
class ExecutiveContextProvider {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }
  
  async getState() {
    const executive = this.orchestrator.executiveCoordinator;
    
    if (!executive) {
      return { available: false };
    }
    
    return {
      available: true,
      recentDecisions: executive.recentDecisions || [],
      timestamp: Date.now()
    };
  }
}

/**
 * PGS Context Provider
 * Provides access to Partitioned Graph Synthesis queries
 */
class PGSContextProvider {
  constructor(orchestrator, logger) {
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.memory = orchestrator.memory;
  }
  
  async query(queryText) {
    this.logger.info('PGS query (simplified)', { query: queryText });
    
    // Simplified implementation: analyze memory network for gaps
    const gaps = this.analyzeMemoryGaps();
    const tools = this.findResearchedTools();
    
    return {
      query: queryText,
      gaps: gaps.length > 0 ? gaps : ['No obvious gaps detected'],
      solutions: this.memory ? `${this.memory.nodes.size} nodes available for analysis` : 'Memory not available',
      tools: tools.length > 0 ? tools : ['No tools identified yet'],
      timestamp: Date.now(),
      mode: 'simplified' // Indicates this is not full PGS yet
    };
  }
  
  analyzeMemoryGaps() {
    // Simple heuristic: look for low-connectivity nodes or isolated clusters
    if (!this.memory || !this.memory.nodes) return [];
    
    const gaps = [];
    const nodeCount = this.memory.nodes.size;
    
    // If memory is very sparse, that's a gap
    if (nodeCount < 10) {
      gaps.push('Memory network is sparse - limited knowledge accumulated');
    }
    
    // Check for recent goals that aren't connected to many nodes
    const goals = this.orchestrator.goals?.getGoals() || [];
    const unrealizedGoals = goals.filter(g => 
      g.status === 'active' && g.satisfaction < 0.3
    );
    
    if (unrealizedGoals.length > 0) {
      gaps.push(`${unrealizedGoals.length} active goals with low satisfaction`);
    }
    
    return gaps;
  }
  
  findResearchedTools() {
    // Simple: look for nodes tagged as tools/integrations
    if (!this.memory || !this.memory.nodes) return [];
    
    const tools = [];
    for (const node of this.memory.nodes.values()) {
      if (node.tags?.includes('tool') || node.tags?.includes('integration') ||
          node.content?.toLowerCase().includes('api')) {
        tools.push(node.content?.substring(0, 50));
      }
    }
    
    return tools.slice(0, 5); // Return up to 5
  }
}

module.exports = {
  GoalsContextProvider,
  MemoryContextProvider,
  PlansContextProvider,
  ThoughtsContextProvider,
  SurprisesContextProvider,
  AgentsContextProvider,
  ArtifactsContextProvider,
  VoiceContextProvider,
  ExecutiveContextProvider,
  PGSContextProvider
};
