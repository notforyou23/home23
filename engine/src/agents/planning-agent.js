const { BaseAgent } = require('./base-agent');
const { parseWithFallback } = require('../core/json-repair');

/**
 * PlanningAgent - Goal decomposition and strategic planning specialist
 * 
 * Purpose:
 * - Breaks complex goals into manageable sub-goals
 * - Generates hierarchical plans with dependencies
 * - Identifies required resources and prerequisites
 * - Sequences tasks for optimal execution
 * 
 * Use Cases:
 * - Decomposing "Improve COSMO architecture" into actionable steps
 * - Planning multi-phase research projects
 * - Generating mission sequences for coordinator
 * - Identifying what needs to happen before what
 */
class PlanningAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.plan = null;
    this.subGoals = [];
  }

  /**
   * Main execution logic - GENERIC planning from memory context
   */
  async execute() {
    this.logger.info('📋 PlanningAgent: Starting planning mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    }, 3);

    await this.reportProgress(5, 'Analyzing goal complexity');

    // STEP 1: Query memory for context about the goal
    const contextKnowledge = await this.memory.query(this.mission.description, 30);
    
    this.logger.info('📚 Context gathered from memory', {
      relevantNodes: contextKnowledge.length,
      topSimilarity: contextKnowledge[0]?.similarity || 0
    });

    // NEW: Explore knowledge domain to understand what's known/unknown
    const domain = await this.getKnowledgeDomain(this.mission.description);
    this.logger.info('🌐 Knowledge domain analysis', {
      clusterId: domain.clusterId,
      knownConcepts: domain.size
    });

    // NEW: Check hot topics to align with current priorities
    const hotTopics = await this.getHotTopics(5);
    this.logger.info('🔥 Current system priorities', {
      topics: hotTopics.map(t => t.concept?.substring(0, 40))
    });

    await this.reportProgress(15, 'Decomposing goal into sub-goals');

    // STEP 2: Decompose goal using LLM reasoning with memory context
    const decomposition = await this.decomposeGoal(contextKnowledge, domain);
    this.subGoals = decomposition.subGoals;

    await this.reportProgress(40, `Identified ${this.subGoals.length} sub-goals`);

    // STEP 3: Identify dependencies between sub-goals
    const dependencies = await this.identifyDependencies(this.subGoals);

    await this.reportProgress(60, 'Building execution sequence');

    // STEP 4: Generate optimal execution sequence
    const sequence = await this.generateExecutionSequence(this.subGoals, dependencies);

    await this.reportProgress(80, 'Identifying resource requirements');

    // STEP 5: Identify resources needed for each sub-goal
    const resources = await this.identifyResources(this.subGoals);

    // STEP 6: Compile final plan
    this.plan = {
      originalGoal: this.mission.description,
      subGoals: this.subGoals,
      dependencies,
      executionSequence: sequence,
      resourceRequirements: resources,
      estimatedDuration: this.estimateDuration(this.subGoals),
      createdAt: new Date()
    };

    // STEP 7: Store plan in memory
    await this.reportProgress(95, 'Storing plan in memory');
    
    await this.addFinding(
      JSON.stringify(this.plan, null, 2),
      'mission_plan'
    );

    // Add each sub-goal as an insight for coordinator to potentially action
    for (let i = 0; i < this.subGoals.length; i++) {
      const subGoal = this.subGoals[i];
      await this.addInsight(
        `Sub-goal ${i + 1}/${this.subGoals.length}: ${subGoal.description} (Priority: ${subGoal.priority}, Est: ${subGoal.estimatedDuration}min)`,
        'sub_goal'
      );
    }

    await this.reportProgress(100, 'Planning complete');

    this.logger.info('✅ PlanningAgent: Mission complete', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      subGoalsGenerated: this.subGoals.length,
      totalEstimatedDuration: this.plan.estimatedDuration
    }, 3);

    return {
      success: true,
      subGoalsGenerated: this.subGoals.length,
      hasSequence: sequence.length > 0,
      estimatedDuration: this.plan.estimatedDuration
    };
  }

  /**
   * Decompose goal into sub-goals using LLM reasoning
   */
  async decomposeGoal(contextKnowledge, domain) {
    const contextSummary = contextKnowledge
      .slice(0, 10)
      .map(n => `- ${n.concept?.substring(0, 100)}`)
      .join('\n');

    const domainSummary = domain.nodes
      .slice(0, 10)
      .map(n => `- ${n.concept?.substring(0, 100)}`)
      .join('\n');

    const prompt = `You are decomposing a complex goal into sub-goals.

GOAL: ${this.mission.description}

SUCCESS CRITERIA:
${this.mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

RELEVANT CONTEXT FROM MEMORY:
${contextSummary || 'No prior context'}

KNOWLEDGE DOMAIN (${domain.size} concepts):
${domainSummary || 'No domain knowledge yet'}

Your task:
1. Break this goal into 3-7 actionable sub-goals
2. Each sub-goal should be:
   - Specific and measurable
   - Independently executable
   - Contributing to success criteria
   - Estimatable (duration in minutes)
3. Assign priority (high/medium/low) to each
4. Identify which agent types would best execute each sub-goal

Respond in JSON format:
{
  "subGoals": [
    {
      "id": "sg_1",
      "description": "Specific sub-goal description...",
      "priority": "high",
      "estimatedDuration": 30,
      "suggestedAgentType": "research",
      "successIndicators": ["indicator 1", "indicator 2"]
    }
  ],
  "rationale": "Why this decomposition makes sense..."
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel || 'gpt-5.2',
        instructions: prompt,
        messages: [{ role: 'user', content: 'Decompose this goal into sub-goals.' }],
        maxTokens: 20000,
        reasoningEffort: 'high' // Planning is complex reasoning
      }, 3);

      const parsed = parseWithFallback(response.content, 'object');
      
      if (parsed && parsed.subGoals && Array.isArray(parsed.subGoals)) {
        this.logger.info('✅ Goal decomposed successfully', {
          subGoals: parsed.subGoals.length,
          rationale: parsed.rationale?.substring(0, 100)
        });
        return parsed;
      }

      // Fallback
      return {
        subGoals: [{
          id: 'sg_1',
          description: this.mission.description,
          priority: 'high',
          estimatedDuration: 60,
          suggestedAgentType: 'analysis',
          successIndicators: this.mission.successCriteria
        }],
        rationale: 'Fallback: Single sub-goal'
      };
    } catch (error) {
      this.logger.error('Goal decomposition failed', { error: error.message });
      return {
        subGoals: [{
          id: 'sg_1',
          description: this.mission.description,
          priority: 'high',
          estimatedDuration: 60,
          suggestedAgentType: 'analysis',
          successIndicators: this.mission.successCriteria
        }],
        rationale: 'Error fallback'
      };
    }
  }

  /**
   * Identify dependencies between sub-goals
   */
  async identifyDependencies(subGoals) {
    const goalsDescription = subGoals
      .map(sg => `${sg.id}: ${sg.description}`)
      .join('\n');

    const prompt = `Identify dependencies between these sub-goals.

SUB-GOALS:
${goalsDescription}

Which sub-goals must be completed before others can start?

Respond in JSON format:
{
  "dependencies": [
    {"from": "sg_1", "to": "sg_2", "reason": "sg_2 needs results from sg_1"},
    {"from": "sg_1", "to": "sg_3", "reason": "sg_3 builds on sg_1"}
  ]
}`;

    try {
      const response = await this.gpt5.generateFast({
        instructions: prompt,
        messages: [{ role: 'user', content: 'Identify dependencies.' }],
        maxTokens: 6000 // Increased from 2000 - plan status needs comprehensive output
      });

      const parsed = parseWithFallback(response.content, 'object');
      return parsed?.dependencies || [];
    } catch (error) {
      this.logger.error('Dependency identification failed', { error: error.message });
      return [];
    }
  }

  /**
   * Generate optimal execution sequence considering dependencies
   */
  async generateExecutionSequence(subGoals, dependencies) {
    // Topological sort based on dependencies
    const graph = new Map();
    const inDegree = new Map();

    // Initialize
    for (const sg of subGoals) {
      graph.set(sg.id, []);
      inDegree.set(sg.id, 0);
    }

    // Build graph
    for (const dep of dependencies) {
      graph.get(dep.from).push(dep.to);
      inDegree.set(dep.to, inDegree.get(dep.to) + 1);
    }

    // Topological sort
    const queue = [];
    const sequence = [];

    for (const [id, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      sequence.push(current);

      for (const neighbor of graph.get(current)) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    // If sequence doesn't contain all sub-goals, add remaining ones
    const remaining = subGoals
      .filter(sg => !sequence.includes(sg.id))
      .map(sg => sg.id);
    sequence.push(...remaining);

    return sequence;
  }

  /**
   * Identify resources needed for sub-goals
   */
  async identifyResources(subGoals) {
    const resources = {};

    for (const sg of subGoals) {
      resources[sg.id] = {
        agentType: sg.suggestedAgentType,
        estimatedDuration: sg.estimatedDuration,
        requiredTools: this.inferRequiredTools(sg.suggestedAgentType)
      };
    }

    return resources;
  }

  /**
   * Infer tools needed based on agent type
   */
  inferRequiredTools(agentType) {
    const toolMap = {
      research: ['web_search', 'mcp_filesystem'],
      analysis: ['memory_query', 'llm_reasoning'],
      code_execution: ['python_container', 'mcp_filesystem'],
      synthesis: ['memory_query', 'llm_reasoning'],
      exploration: ['memory_query', 'spreading_activation'],
      quality_assurance: ['memory_query', 'web_search']
    };

    return toolMap[agentType] || ['memory_query'];
  }

  /**
   * Estimate total duration for all sub-goals
   */
  estimateDuration(subGoals) {
    // Sum of sequential sub-goals (simplified - doesn't account for parallelization)
    return subGoals.reduce((sum, sg) => sum + (sg.estimatedDuration || 30), 0);
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('🎉 PlanningAgent completed successfully', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      subGoalsGenerated: this.subGoals.length
    }, 3);
  }
}

module.exports = { PlanningAgent };

