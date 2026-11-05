// src/system/agent-routing.js
/**
 * AgentRouter v1 - Follow-up mission planner
 * 
 * Purpose:
 * - Takes routing hints from IntrospectionRouter
 * - Builds follow-up mission specifications
 * - Does NOT spawn agents directly (returns mission objects)
 * - Orchestrator decides whether to auto-spawn
 * 
 * Design:
 * - Advisory by default (just plans missions)
 * - Configurable auto-spawn (opt-in)
 * - Bounded mission generation
 * - Priority-based categorization
 */
class AgentRouter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    const cfg = config.agentRouting || {};
    this.enabled = cfg.enabled || false;
    this.maxMissionsPerCycle = cfg.maxMissionsPerCycle || 4;
    
    // Feature toggles (all default true)
    this.criticOnContradiction = cfg.criticOnContradiction !== false;
    this.synthesisOnAnalysis = cfg.synthesisOnAnalysis !== false;
    this.reuseOnCode = cfg.reuseOnCode !== false;
    this.researchOnQuestions = cfg.researchOnQuestions !== false;
  }

  /**
   * Build follow-up missions from routing hints
   * @param {Object} hints - From IntrospectionRouter.buildHints()
   * @returns {Array} Mission specifications
   */
  buildMissionsFromHints(hints) {
    if (!this.enabled || !hints) return [];

    const missions = [];

    // Critical issues → Critic agent
    if (this.criticOnContradiction && hints.critic && hints.critic.length > 0) {
      missions.push({
        agentType: 'quality_assurance',  // Use registered agent type
        goalId: `routing_critic_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        description: `Investigate contradictions and errors in recent outputs: ${hints.critic.map(c => c.file).join(', ')}`,
        successCriteria: ['Identify contradictions', 'Propose resolutions'],
        maxDuration: 300000, // 5 minutes
        inputs: hints.critic.slice(0, 3),
        priority: 'high',
        createdBy: 'agent_router',
        spawningReason: 'contradiction_detected'
      });
    }

    // Analysis ready → Synthesis agent
    if (this.synthesisOnAnalysis && hints.synthesis && hints.synthesis.length > 0) {
      missions.push({
        agentType: 'synthesis',
        goalId: `routing_synthesis_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        description: `Synthesize cross-file themes from recent analyses: ${hints.synthesis.map(s => s.file).join(', ')}`,
        successCriteria: ['Synthesize key themes', 'Identify patterns'],
        maxDuration: 300000, // 5 minutes
        inputs: hints.synthesis.slice(0, 3),
        priority: 'medium',
        createdBy: 'agent_router',
        spawningReason: 'analysis_ready_for_synthesis'
      });
    }

    // Reusable code → Code refactoring
    if (this.reuseOnCode && hints.reuse && hints.reuse.length > 0) {
      missions.push({
        agentType: 'code_creation',
        goalId: `routing_code_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        description: `Refactor and modularize reusable code artifacts: ${hints.reuse.map(r => r.file).join(', ')}`,
        successCriteria: ['Modularize code', 'Create reusable components'],
        maxDuration: 600000, // 10 minutes
        inputs: hints.reuse.slice(0, 3),
        priority: 'low',  // Lower priority for refactoring
        createdBy: 'agent_router',
        spawningReason: 'code_reuse_opportunity'
      });
    }

    // Research questions → Research agent
    if (this.researchOnQuestions && hints.research && hints.research.length > 0) {
      missions.push({
        agentType: 'research',
        goalId: `routing_research_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        description: `Investigate open questions and future work items: ${hints.research.map(r => r.file).join(', ')}`,
        successCriteria: ['Research questions', 'Provide answers'],
        maxDuration: 300000, // 5 minutes
        inputs: hints.research.slice(0, 3),
        priority: 'low',
        createdBy: 'agent_router',
        spawningReason: 'research_question_identified'
      });
    }

    return missions.slice(0, this.maxMissionsPerCycle);
  }

  /**
   * Classify user query to determine appropriate agent type
   * NEW: Added codebase_exploration routing
   * 
   * @param {string} query - User's query text
   * @returns {string} Agent type ('codebase_exploration', 'research', 'analysis', etc.)
   */
  classifyQuery(query) {
    const queryLower = query.toLowerCase();

    // Codebase exploration patterns (READ-ONLY intent)
    const codebasePatterns = [
      /explore.*codebase/i,
      /understand.*codebase/i,
      /audit.*code/i,
      /analyze.*code.*structure/i,
      /map.*dependencies/i,
      /read.*files/i,
      /scan.*project/i,
      /review.*code/i,
      /what.*does.*this.*code/i,
      /understand.*project/i,
      /technical.*debt/i,
      /architecture.*overview/i
    ];

    if (codebasePatterns.some(pattern => pattern.test(query))) {
      return 'codebase_exploration';
    }

    // Research patterns (web search)
    const researchPatterns = [
      /research/i,
      /investigate/i,
      /find.*information/i,
      /what.*is/i,
      /how.*does/i,
      /search.*for/i
    ];

    if (researchPatterns.some(pattern => pattern.test(query))) {
      return 'research';
    }

    // Analysis patterns (deep thinking)
    const analysisPatterns = [
      /analyze/i,
      /deep.*dive/i,
      /implications/i,
      /what.*if/i,
      /consequences/i
    ];

    if (analysisPatterns.some(pattern => pattern.test(query))) {
      return 'analysis';
    }

    // Default to research for general questions
    return 'research';
  }
}

module.exports = { AgentRouter };

