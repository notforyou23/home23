const { BaseAgent } = require('./base-agent');

/**
 * CompletionAgent - System oversight and completion validation specialist
 *
 * Purpose:
 * - Monitor ongoing operations to prevent runaway execution
 * - Provide human-in-the-loop oversight for critical decisions
 * - Validate completion criteria and goal achievement
 * - Ensure outputs meet quality standards before finalization
 * - Handle checkpoint reviews and approval workflows
 *
 * Philosophy:
 * - "Trust but verify" - Allow autonomy but validate outcomes
 * - "Human wisdom at critical junctures" - Strategic human input when needed
 * - "Graceful escalation" - Flag issues without breaking flow
 * - "Contextual intervention" - Only intervene when truly necessary
 *
 * Integration Points:
 * - Monitors agent execution and progress
 * - Reviews generated outputs (documents, code) before finalization
 * - Can pause operations for human review
 * - Integrates with memory system for context
 * - Works with goal system for completion validation
 */
class CompletionAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.oversightQueue = [];
    this.pendingReviews = new Map();
    this.reviewThresholds = {
      maxExecutionTime: 30 * 60 * 1000, // 30 minutes
      maxOutputSize: 50000, // 50KB output
      criticalKeywords: ['security', 'production', 'deployment', 'critical'],
      highImpactActions: ['delete', 'overwrite', 'publish', 'deploy']
    };
  }

  /**
   * Initialize oversight monitoring
   */
  async onStart() {
    await this.reportProgress(5, 'Initializing oversight and completion monitoring');

    // Load existing oversight requirements from memory
    const oversightContext = await this.queryMemoryForKnowledge(10);

    if (oversightContext.length > 0) {
      this.logger.info('📋 Found existing oversight patterns', {
        patternsFound: oversightContext.length
      });
    }

    await this.reportProgress(15, 'Oversight monitoring active');
  }

  /**
   * Main oversight and completion validation logic
   */
  async execute() {
    this.logger.info('🎯 CompletionAgent: Starting oversight and validation mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    });

    // Parse oversight requirements from mission
    const oversightSpec = await this.parseOversightRequirements();

    await this.reportProgress(25, `Monitoring ${oversightSpec.scope} operations`);

    // Set up monitoring for specified scope
    await this.setupMonitoring(oversightSpec);

    // Monitor and validate ongoing operations
    const validationResults = await this.monitorAndValidate(oversightSpec);

    await this.reportProgress(80, 'Generating oversight recommendations');

    // Generate oversight recommendations
    const recommendations = await this.generateRecommendations(validationResults, oversightSpec);

    // ADDITIVE: Check if mission requires contract-aware output promotion
    if (this.mission.metadata?.contractId || this.mission.metadata?.canonicalOutputLocation) {
      await this.reportProgress(90, 'Validating against contract and promoting outputs');
      
      const promotionResults = await this.validateAndPromoteByContract();
      
      validationResults.contractValidation = promotionResults;
      
      this.logger.info('📦 Contract-aware promotion complete', {
        satisfied: promotionResults.satisfied,
        promoted: promotionResults.promoted
      });
    }

    await this.reportProgress(100, 'Oversight mission completed');

    return {
      success: true,
      oversightResults: validationResults,
      recommendations,
      metadata: {
        scope: oversightSpec.scope,
        monitoringDuration: validationResults.monitoringDuration,
        issuesFound: validationResults.issues.length,
        interventionsRequired: validationResults.interventions.length,
        createdAt: new Date()
      }
    };
  }

  /**
   * Parse oversight requirements from mission
   */
  async parseOversightRequirements() {
    const missionText = this.mission.description.toLowerCase();

    // Determine oversight scope
    let scope = 'system'; // default
    if (missionText.includes('document') || missionText.includes('code')) {
      scope = 'output_validation';
    } else if (missionText.includes('goal') || missionText.includes('objective')) {
      scope = 'goal_completion';
    } else if (missionText.includes('agent') || missionText.includes('execution')) {
      scope = 'agent_monitoring';
    }

    // Determine oversight level
    let level = 'standard';
    if (missionText.includes('strict') || missionText.includes('critical')) {
      level = 'strict';
    } else if (missionText.includes('minimal') || missionText.includes('light')) {
      level = 'minimal';
    }

    // Extract specific requirements
    const requirements = this.extractOversightRequirements(missionText);

    return {
      scope,
      level,
      requirements,
      triggerConditions: this.extractTriggerConditions(missionText)
    };
  }

  /**
   * Extract specific oversight requirements
   */
  extractOversightRequirements(text) {
    const requirements = [];

    if (text.includes('human review') || text.includes('manual approval')) {
      requirements.push('require_human_review');
    }
    if (text.includes('quality check') || text.includes('validation')) {
      requirements.push('quality_validation');
    }
    if (text.includes('checkpoint') || text.includes('milestone')) {
      requirements.push('checkpoint_review');
    }
    if (text.includes('final approval') || text.includes('sign-off')) {
      requirements.push('final_approval');
    }

    return requirements;
  }

  /**
   * Extract trigger conditions for oversight
   */
  extractTriggerConditions(text) {
    const conditions = [];

    if (text.includes('large output') || text.includes('big file')) {
      conditions.push('output_size_threshold');
    }
    if (text.includes('long running') || text.includes('extended execution')) {
      conditions.push('execution_time_threshold');
    }
    if (text.includes('critical') || text.includes('important')) {
      conditions.push('critical_operation');
    }

    return conditions;
  }

  /**
   * Set up monitoring for specified scope
   */
  async setupMonitoring(spec) {
    // Query current system state
    const currentAgents = await this.getActiveAgents();
    const currentGoals = await this.getActiveGoals();

    this.logger.info('🔍 Setting up oversight monitoring', {
      scope: spec.scope,
      level: spec.level,
      activeAgents: currentAgents.length,
      activeGoals: currentGoals.length
    });

    // Set up monitoring based on scope
    switch (spec.scope) {
      case 'output_validation':
        await this.setupOutputValidation(currentAgents);
        break;
      case 'goal_completion':
        await this.setupGoalMonitoring(currentGoals);
        break;
      case 'agent_monitoring':
        await this.setupAgentMonitoring(currentAgents);
        break;
      default:
        await this.setupSystemMonitoring();
    }
  }

  /**
   * Monitor and validate ongoing operations
   */
  async monitorAndValidate(spec) {
    const startTime = new Date();
    const issues = [];
    const interventions = [];

    // Monitor based on scope
    switch (spec.scope) {
      case 'output_validation':
        const outputIssues = await this.validateOutputs(spec);
        issues.push(...outputIssues);
        break;
      case 'goal_completion':
        const goalIssues = await this.validateGoalCompletion(spec);
        issues.push(...goalIssues);
        break;
      case 'agent_monitoring':
        const agentIssues = await this.validateAgentExecution(spec);
        issues.push(...agentIssues);
        break;
    }

    // Check for intervention needs
    for (const issue of issues) {
      if (await this.requiresIntervention(issue, spec)) {
        const intervention = await this.planIntervention(issue, spec);
        interventions.push(intervention);
      }
    }

    const monitoringDuration = new Date() - startTime;

    return {
      monitoringDuration,
      issues,
      interventions,
      scope: spec.scope,
      validated: issues.length === 0
    };
  }

  /**
   * Validate generated outputs before finalization
   */
  async validateOutputs(spec) {
    const issues = [];

    // Get recent outputs from memory
    const recentOutputs = await this.getRecentOutputs();

    for (const output of recentOutputs) {
      // Check size thresholds
      if (output.content && output.content.length > this.reviewThresholds.maxOutputSize) {
        issues.push({
          type: 'output_size_threshold',
          severity: 'medium',
          message: `Large output detected: ${output.fileName || 'unnamed'} (${Math.round(output.content.length / 1024)}KB)`,
          outputId: output.id,
          recommendation: 'Review for completeness and relevance'
        });
      }

      // Check for critical keywords
      if (output.content && this.containsCriticalKeywords(output.content)) {
        issues.push({
          type: 'critical_content',
          severity: 'high',
          message: `Critical content detected in output: ${output.fileName || 'unnamed'}`,
          outputId: output.id,
          recommendation: 'Human review required before finalization'
        });
      }

      // Check for high-impact actions in generated code
      if (output.type === 'code' && this.containsHighImpactActions(output.content)) {
        issues.push({
          type: 'high_impact_code',
          severity: 'high',
          message: `High-impact operations detected in generated code: ${output.fileName}`,
          outputId: output.id,
          recommendation: 'Security and safety review required'
        });
      }
    }

    return issues;
  }

  /**
   * Validate goal completion status
   */
  async validateGoalCompletion(spec) {
    const issues = [];

    // Get current goal status
    const goals = await this.getActiveGoals();

    for (const goal of goals) {
      // Check for stalled goals
      if (goal.progress < 0.1 && goal.age > 10 * 60 * 1000) { // 10 minutes old
        issues.push({
          type: 'stalled_goal',
          severity: 'medium',
          message: `Goal appears stalled: ${goal.description.substring(0, 100)}`,
          goalId: goal.id,
          recommendation: 'Review goal definition or provide additional guidance'
        });
      }

      // Check for goals that should be completed but aren't
      if (goal.progress > 0.9 && !goal.completed) {
        issues.push({
          type: 'completion_stuck',
          severity: 'low',
          message: `Goal near completion but not marked done: ${goal.description.substring(0, 100)}`,
          goalId: goal.id,
          recommendation: 'Review completion criteria'
        });
      }
    }

    return issues;
  }

  /**
   * Validate agent execution health
   */
  async validateAgentExecution(spec) {
    const issues = [];

    // Get agent registry status
    const agentStats = await this.getAgentStats();

    // Check for long-running agents
    for (const agent of agentStats.active) {
      if (agent.duration > this.reviewThresholds.maxExecutionTime) {
        issues.push({
          type: 'long_running_agent',
          severity: 'high',
          message: `Agent running too long: ${agent.type} (${Math.round(agent.duration / 60000)} minutes)`,
          agentId: agent.id,
          recommendation: 'Review agent status and consider intervention'
        });
      }
    }

    // Check for too many active agents
    if (agentStats.active.length > 5) {
      issues.push({
        type: 'too_many_agents',
        severity: 'medium',
        message: `High agent concurrency: ${agentStats.active.length} agents active`,
        recommendation: 'Monitor system performance and consider prioritization'
      });
    }

    return issues;
  }

  /**
   * Generate oversight recommendations
   */
  async generateRecommendations(validationResults, spec) {
    const recommendations = [];

    if (validationResults.issues.length > 0) {
      // Group issues by severity
      const highPriority = validationResults.issues.filter(i => i.severity === 'high');
      const mediumPriority = validationResults.issues.filter(i => i.severity === 'medium');

      if (highPriority.length > 0) {
        recommendations.push({
          type: 'immediate_review',
          priority: 'high',
          message: `Immediate review required for ${highPriority.length} high-priority issues`,
          actions: highPriority.map(i => i.recommendation)
        });
      }

      if (mediumPriority.length > 0) {
        recommendations.push({
          type: 'scheduled_review',
          priority: 'medium',
          message: `Scheduled review recommended for ${mediumPriority.length} medium-priority issues`,
          actions: mediumPriority.map(i => i.recommendation)
        });
      }
    }

    // Generate system health recommendations
    if (spec.scope === 'system_monitoring') {
      const healthRecs = await this.generateSystemHealthRecommendations();
      recommendations.push(...healthRecs);
    }

    return recommendations;
  }

  /**
   * Check if issue requires intervention
   */
  async requiresIntervention(issue, spec) {
    // High severity always requires intervention
    if (issue.severity === 'high') {
      return true;
    }

    // Check if issue matches trigger conditions
    if (spec.triggerConditions.includes('output_size_threshold') && issue.type === 'output_size_threshold') {
      return true;
    }

    if (spec.triggerConditions.includes('execution_time_threshold') && issue.type === 'long_running_agent') {
      return true;
    }

    if (spec.triggerConditions.includes('critical_operation') && issue.type === 'critical_content') {
      return true;
    }

    return false;
  }

  /**
   * Plan appropriate intervention for issue
   */
  async planIntervention(issue, spec) {
    const intervention = {
      issueId: issue.id || Date.now(),
      type: 'pause_for_review',
      target: issue.agentId || issue.goalId || issue.outputId,
      reason: issue.message,
      recommendedActions: [issue.recommendation],
      priority: issue.severity === 'high' ? 'immediate' : 'standard',
      timestamp: new Date()
    };

    // Add to pending reviews
    this.pendingReviews.set(intervention.issueId, intervention);

    // Send intervention request
    await this.requestIntervention(intervention);

    return intervention;
  }

  /**
   * Request human intervention for specific issue
   */
  async requestIntervention(intervention) {
    // Send message to oversight queue
    await this.sendMessage('human_oversight', 'intervention_required', {
      intervention,
      context: await this.gatherInterventionContext(intervention),
      urgency: intervention.priority
    });

    this.logger.info('🚨 Intervention requested', {
      issueId: intervention.issueId,
      type: intervention.type,
      priority: intervention.priority,
      target: intervention.target
    });
  }

  /**
   * Gather context for intervention decision
   */
  async gatherInterventionContext(intervention) {
    const context = {
      systemState: await this.getSystemState(),
      relatedGoals: await this.getRelatedGoals(intervention.target),
      similarIncidents: await this.getSimilarIncidents(intervention),
      memoryContext: await this.getMemoryContext(intervention)
    };

    return context;
  }

  // Helper methods for validation

  containsCriticalKeywords(content) {
    const lowerContent = content.toLowerCase();
    return this.reviewThresholds.criticalKeywords.some(keyword =>
      lowerContent.includes(keyword)
    );
  }

  containsHighImpactActions(content) {
    const lowerContent = content.toLowerCase();
    return this.reviewThresholds.highImpactActions.some(action =>
      lowerContent.includes(action)
    );
  }

  async getActiveAgents() {
    // Get from agent registry via MCP
    if (this.mcp) {
      try {
        return await this.mcp.getActiveAgents();
      } catch (error) {
        this.logger.warn('Failed to get active agents via MCP');
      }
    }
    return [];
  }

  async getActiveGoals() {
    // FIXED: Use correct API - getGoals() not getActiveGoals()
    if (this.goals) {
      return this.goals.getGoals();
    }
    return [];
  }

  async getAgentStats() {
    if (this.registry) {
      return this.registry.getStats();
    }
    return { active: [], completed: 0, failed: 0 };
  }

  async getRecentOutputs() {
    // Query memory for recent outputs
    const recentNodes = await this.memory.query('recent output OR generated OR created', 20);
    return recentNodes.filter(node =>
      node.concept.includes('output') ||
      node.concept.includes('generated') ||
      node.tag?.includes('output')
    );
  }

  async getSystemState() {
    return {
      agents: await this.getAgentStats(),
      goals: await this.getActiveGoals(),
      memory: await this.getMemoryStats(),
      timestamp: new Date()
    };
  }

  async getRelatedGoals(targetId) {
    // FIXED: getGoalsByAgent doesn't exist - filter getGoals() instead
    if (this.goals) {
      const allGoals = this.goals.getGoals();
      // Filter for goals that mention the target agent ID in metadata or description
      return allGoals.filter(goal => 
        goal.metadata?.agentId === targetId ||
        goal.description?.includes(targetId) ||
        goal.assignedTo === targetId
      );
    }
    return [];
  }

  async getSimilarIncidents(intervention) {
    // Find similar issues from memory
    const similarNodes = await this.memory.query(
      `${intervention.type} ${intervention.reason}`,
      5
    );
    return similarNodes.map(node => ({
      type: node.concept,
      timestamp: node.created,
      outcome: node.outcome || 'unknown'
    }));
  }

  async getMemoryContext(intervention) {
    // Get relevant memory context for the intervention
    return await this.memory.query(
      `${intervention.target} context OR background OR history`,
      10
    );
  }

  async getMemoryStats() {
    if (this.memory) {
      return {
        nodes: this.memory.nodes.size,
        clusters: this.memory.clusters?.size || 0,
        recentActivity: await this.getRecentInsights(3600000) // Last hour
      };
    }
    return {};
  }

  async generateSystemHealthRecommendations() {
    const recommendations = [];
    const systemState = await this.getSystemState();

    // Check for system overload
    if (systemState.agents.active.length > 8) {
      recommendations.push({
        type: 'system_overload',
        priority: 'medium',
        message: 'System appears overloaded with too many concurrent agents',
        recommendation: 'Consider prioritizing goals or reducing agent concurrency'
      });
    }

    // Check for memory pressure
    if (systemState.memory.nodes > 50000) {
      recommendations.push({
        type: 'memory_pressure',
        priority: 'low',
        message: 'Large memory footprint detected',
        recommendation: 'Consider memory cleanup or archiving old knowledge'
      });
    }

    return recommendations;
  }

  /**
   * Handle completion validation for generated outputs
   */
  async validateOutputCompletion(output, requirements) {
    const validation = {
      isComplete: true,
      issues: [],
      score: 100
    };

    // Check for basic completeness
    if (!output.content || output.content.length < 100) {
      validation.isComplete = false;
      validation.issues.push('Output appears incomplete or too brief');
      validation.score -= 30;
    }

    // Check for required sections if specified
    if (requirements.includes('include_toc') && !output.content.includes('Table of Contents')) {
      validation.issues.push('Table of contents missing');
      validation.score -= 10;
    }

    if (requirements.includes('include_references') && !output.content.includes('References')) {
      validation.issues.push('References section missing');
      validation.score -= 10;
    }

    // Check for quality indicators
    if (output.content.includes('[Error') || output.content.includes('failed')) {
      validation.isComplete = false;
      validation.issues.push('Output contains error indicators');
      validation.score -= 50;
    }

    return validation;
  }

  /**
   * ADDITIVE: Promote validated outputs to canonical location
   * Called when mission specifies canonicalOutputLocation in metadata
   * @param {string} canonicalPath - Target canonical directory (e.g., "outputs/baseline_v1")
   * @returns {Object} Promotion results
   */
  async promoteToCanonical(canonicalPath) {
    const fs = require('fs').promises;
    const path = require('path');
    
    this.logger.info('📦 Promoting outputs to canonical location', {
      canonical: canonicalPath
    });
    
    // Discover outputs from recently completed agents
    const recentOutputs = await this.discoverFiles({
      agentTypes: ['code_execution', 'code_creation'],
      maxAgeMs: 3600000  // Last hour
    });
    
    if (recentOutputs.length === 0) {
      this.logger.warn('No outputs found to promote');
      return { promoted: 0, errors: [] };
    }
    
    // Create canonical directory
    const fullCanonicalPath = path.join(process.cwd(), canonicalPath);
    await fs.mkdir(fullCanonicalPath, { recursive: true });
    
    const promoted = [];
    const errors = [];
    
    // Copy files to canonical location
    for (const output of recentOutputs) {
      try {
        const sourcePath = path.isAbsolute(output.relativePath) 
          ? output.relativePath 
          : path.join(process.cwd(), output.relativePath);
        
        const targetPath = path.join(fullCanonicalPath, output.filename);
        
        // Read and write (copy) via Capabilities
        if (this.capabilities) {
          // Use binary-safe read/write to avoid corrupting non-text artifacts
          const readResult = await this.capabilities.readFileBinary(
            path.relative(process.cwd(), sourcePath),
            { agentId: this.agentId, agentType: 'completion', missionGoal: this.mission.goalId }
          );
          if (!readResult?.success) {
            throw new Error(readResult?.error || readResult?.reason || 'Binary read failed');
          }
          
          const writeResult = await this.capabilities.writeFile(
            targetPath,  // Use absolute path - pathResolver handles it correctly
            readResult.buffer,
            { agentId: this.agentId, agentType: 'completion', missionGoal: this.mission.goalId }
          );
          if (!writeResult?.success) {
            throw new Error(writeResult?.error || writeResult?.reason || 'Write failed');
          }
        } else {
          const content = await fs.readFile(sourcePath);
          await fs.writeFile(targetPath, content);
        }
        
        promoted.push({
          source: output.relativePath,
          target: path.relative(process.cwd(), targetPath),
          filename: output.filename
        });
        
        this.logger.info('✅ Promoted file to canonical location', {
          filename: output.filename,
          from: output.relativePath,
          to: path.relative(process.cwd(), targetPath)
        });
        
      } catch (error) {
        errors.push({
          filename: output.filename,
          error: error.message
        });
        
        this.logger.error('Failed to promote file', {
          filename: output.filename,
          error: error.message
        });
      }
    }
    
    // Note: Promotion record logged but not saved to memory (filesystem bookkeeping, not knowledge)
    
    return { promoted: promoted.length, errors, files: promoted };
  }

  /**
   * ADDITIVE: Validate and promote outputs using contract
   * This is the contract-aware version of promotion
   * @returns {Object} Validation and promotion results
   */
  async validateAndPromoteByContract() {
    const { getContract, validateAgainstContract } = require('../schemas/output-contracts');
    
    const contractId = this.mission.metadata?.contractId;
    if (!contractId) {
      this.logger.info('No contract specified, using basic promotion');
      return await this.promoteToCanonical(this.mission.metadata?.canonicalOutputLocation);
    }
    
    this.logger.info('📋 Validating outputs against contract', { contractId });
    
    // Get contract
    let contract;
    try {
      contract = getContract(contractId);
    } catch (error) {
      this.logger.error('Failed to load contract', {
        contractId,
        error: error.message
      });
      return {
        satisfied: false,
        promoted: 0,
        error: `Contract not found: ${contractId}`
      };
    }
    
    // Discover actual outputs
    const recentOutputs = await this.discoverFiles({
      agentTypes: ['code_execution', 'code_creation'],
      maxAgeMs: 3600000
    });
    
    // Map to format expected by validator
    const actualArtifacts = recentOutputs.map(f => ({
      filename: f.filename,
      exists: true,
      size: f.size || 0
    }));
    
    // Validate
    const validation = validateAgainstContract(contractId, actualArtifacts);
    
    // Only save contract validation to memory when it reveals missing artifacts (useful knowledge)
    if (!validation.satisfied && validation.missingRequired.length > 0) {
      await this.addFinding(
        `Contract ${contractId} missing required artifacts: ${validation.missingRequired.join(', ')}`,
        'contract_gap'
      );
    }
    
    if (!validation.satisfied) {
      this.logger.error('Contract not satisfied, cannot promote', {
        contractId,
        missingRequired: validation.missingRequired
      });
      
      return {
        satisfied: false,
        promoted: 0,
        validation
      };
    }
    
    // Contract satisfied - promote to canonical
    const canonicalPath = this.mission.metadata?.canonicalOutputLocation;
    if (!canonicalPath) {
      throw new Error('Contract satisfied but no canonical location specified');
    }
    
    const promotionResults = await this.promoteToCanonical(canonicalPath);
    
    return {
      satisfied: true,
      promoted: promotionResults.promoted,
      validation,
      promotionResults
    };
  }

  /**
   * Generate handoff spec for oversight continuation
   */
  generateHandoffSpec() {
    return {
      nextAgent: null, // Completion agent doesn't hand off
      context: {
        pendingReviews: Array.from(this.pendingReviews.keys()),
        oversightScope: this.mission.scope || 'system',
        recommendations: this.results?.recommendations || []
      },
      priority: 'ongoing_monitoring'
    };
  }
}

module.exports = { CompletionAgent };
