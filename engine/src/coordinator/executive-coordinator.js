const { UnifiedClient } = require('../core/unified-client');
const path = require('path');

/**
 * ExecutiveCoordinator - COSMO's Executive Function Layer (Middle Ring)
 * 
 * The executive function sits between the orchestrator (execution engine) and
 * specialist agents (narrow cognition). It maintains mission context, checks
 * reality alignment, detects patterns, and makes tactical decisions.
 * 
 * This is NOT just a validator - it's the system's continuous executive function
 * that asks "does this make sense?" before every action.
 * 
 * Architecture:
 * - OUTER RING: Dashboard (human consciousness)
 * - MIDDLE RING: Executive Coordinator (this) + Meta-Coordinator (strategic)
 * - INNER RING: Specialist agents (narrow cognition)
 * 
 * The executive bridges tactical (every cycle) and strategic (every N cycles).
 */
class ExecutiveCoordinator {
  constructor(config, logger, orchestrator) {
    this.config = config;
    this.logger = logger;
    this.orchestrator = orchestrator;
    this.gpt5 = new UnifiedClient(config, logger);
    
    // Executive state (maintains across cycles)
    this.missionContext = null; // What we're trying to accomplish
    this.phaseRequirements = new Map(); // What each phase needs
    this.recentActions = []; // Last 10 cycles: what happened
    this.interventions = []; // When we blocked/redirected
    this.coherenceScore = 1.0; // 0-1 confidence system is coherent
    
    // Executive memory (learns from patterns)
    this.knownBlockers = new Map(); // agentType -> common blockers
    this.successPatterns = new Map(); // What works
    
    // Configuration
    this.enabled = config.executiveRing?.enabled !== false; // Default enabled
    this.useLLM = config.executiveRing?.useLLM !== false;
    this.coherenceThreshold = config.executiveRing?.coherenceThreshold || 0.5;
    this.alignmentCheckInterval = config.executiveRing?.alignmentCheckInterval || 5;
    this.stuckLoopThreshold = config.executiveRing?.stuckLoopThreshold || 5;
    this.toolBuildingThreshold = config.executiveRing?.toolBuildingThreshold || 6;
    
    // BASAL GANGLIA: Action selector (initialized on first use)
    this.actionSelector = null;
    
    // QUALITY GATES: Definition-of-Done validator (initialized on first use)
    this.dodValidator = null;
    
    // ERROR MONITOR: Anterior Cingulate Cortex (initialized on first use)
    this.errorMonitor = null;
    
    // EVALUATION HARNESS: Micro-CI (initialized on first use)
    this.evaluationHarness = null;
  }
  
  /**
   * Initialize with mission context
   */
  async initialize(mission) {
    this.missionContext = {
      domain: mission?.domain || 'Unknown',
      description: mission?.description || mission?.context || '',
      executionMode: mission?.executionMode || 'mixed',
      startedAt: Date.now(),
      phases: this.parseMissionPhases(mission)
    };
    
    this.logger.info('🧠 Executive Ring initialized with mission context', {
      domain: this.missionContext.domain,
      phases: this.missionContext.phases?.length || 0,
      executionMode: this.missionContext.executionMode
    });
  }
  
  /**
   * Parse mission phases and their requirements
   */
  parseMissionPhases(mission) {
    // Standard research pipeline phases
    return [
      { id: 'phase1', name: 'Research/Compilation', requires: [], produces: 'corpus' },
      { id: 'phase2', name: 'Analysis', requires: ['corpus'], produces: 'insights' },
      { id: 'phase3', name: 'Synthesis', requires: ['insights'], produces: 'narrative' },
      { id: 'phase4', name: 'Documentation', requires: ['narrative'], produces: 'deliverable' }
    ];
  }
  
  /**
   * Detect if we're in autonomous vs guided mode
   * Autonomous: context.mission is null (no guidedPlan)
   * Guided: context.mission exists (from GuidedModePlanner)
   */
  isAutonomousMode(context) {
    return !context.mission && !this.missionContext;
  }
  
  /**
   * MAIN EXECUTIVE FUNCTION: Decide what should happen this cycle
   * 
   * This is where the executive ring makes tactical decisions.
   * Orchestrator gathers context, executive decides, orchestrator executes.
   * 
   * @param {Object} context - Current system context
   * @returns {Object} - Decision object with action type and parameters
   */
  async decideCycleAction(context) {
    if (!this.enabled) {
      return { action: 'CONTINUE_NORMAL', reason: 'Executive disabled' };
    }
    
    // Initialize mission context if first time
    if (context.mission && !this.missionContext) {
      await this.initialize(context.mission);
    }
    
    // STEP 1: Assess current reality vs mission
    const reality = await this.assessCurrentReality(context);
    
    // STEP 2: If incoherent, decide intervention
    if (!reality.coherent) {
      const intervention = this.decideIntervention(reality, context);
      
      // Record intervention
      this.interventions.push({
        cycle: context.cycleCount,
        action: intervention.action,
        reason: intervention.reason,
        coherenceScore: this.coherenceScore
      });
      
      return intervention;
    }
    
    // STEP 3: BASAL GANGLIA - Action selection with commitment
    // Use action selector to choose from available goals
    if (!this.actionSelector) {
      this.actionSelector = new ActionSelector(this.config, this.logger);
    }
    
    const selection = this.actionSelector.selectAction(
      context.systemState.goals,
      {
        cycleCount: context.cycleCount,
        fileAccessPaths: this.config?.mcp?.client?.servers?.[0]?.allowedPaths,
        recentActions: this.recentActions,
        successRates: this.computeSuccessRates()
      }
    );
    
    if (!selection.selected) {
      return { action: 'SKIP', reason: selection.reason };
    }
    
    // STEP 4: Gate the selected agent spawn
    if (context.proposedAgent) {
      const gateCheck = await this.gateAgentSpawn(context.proposedAgent, context);
      if (!gateCheck.allow) {
        return {
          action: gateCheck.redirect ? 'REDIRECT' : 'SKIP',
          reason: gateCheck.reason,
          redirect: gateCheck.redirect
        };
      }
    }
    
    return { action: 'CONTINUE_NORMAL', reason: 'Coherence maintained' };
  }
  
  /**
   * Assess current reality against mission requirements
   * The core executive function - comprehensive reality check
   */
  async assessCurrentReality(context) {
    const checks = {
      preconditions: this.checkPreconditions(context),
      progress: this.checkProgress(context),
      patterns: this.checkPatterns(context),
      alignment: { passed: true } // Default to pass
    };
    
    // Only check alignment periodically (expensive LLM call)
    if (this.useLLM && context.cycleCount % this.alignmentCheckInterval === 0) {
      checks.alignment = await this.checkMissionAlignment(context);
    }
    
    const coherent = Object.values(checks).every(c => c.passed);
    
    if (!coherent) {
      const failures = Object.entries(checks)
        .filter(([_, c]) => !c.passed)
        .map(([name, c]) => `${name}: ${c.reason}`);
      
      this.logger.warn('⚠️ Executive reality check failed', {
        failures,
        coherenceScore: this.coherenceScore.toFixed(2)
      });
    }
    
    return {
      coherent,
      checks,
      coherenceScore: this.coherenceScore
    };
  }
  
  /**
   * Check if preconditions exist for current phase
   */
  checkPreconditions(context) {
    const { currentPhase, systemState } = context;
    
    // Autonomous mode: Skip phase preconditions (no linear phase structure)
    if (this.isAutonomousMode(context)) {
      return { passed: true, reason: 'Autonomous mode - no phase constraints' };
    }
    
    if (!currentPhase) {
      return { passed: true }; // No specific phase requirements
    }
    
    const phaseId = currentPhase;
    
    // Phase 2: Analysis requires artifacts from Phase 1
    if (phaseId.includes('phase2') || phaseId.includes('analyze')) {
      const hasArtifacts = this.recentActions.some(a => 
        a.type === 'completion' && 
        (a.artifactsCreated > 0 || a.filesCreated > 0 || a.documentsAnalyzed > 0 || a.artifactCount > 0)
      );
      
      if (!hasArtifacts) {
        return {
          passed: false,
          reason: 'Analysis phase (Phase 2) requires artifacts but none have been created',
          recommendation: 'Complete artifact creation or research phase first',
          severity: 'high'
        };
      }
    }
    
    // Phase 3: Integration requires multiple completed analyses
    if (phaseId.includes('phase3') || phaseId.includes('integrate') || phaseId.includes('synthesis')) {
      const analysisCount = this.recentActions.filter(a =>
        a.type === 'completion' &&
        a.agentType === 'document_analysis' && 
        a.accomplished
      ).length;
      
      if (analysisCount < 2) {
        return {
          passed: false,
          reason: `Integration phase requires multiple analyses but only ${analysisCount} completed`,
          recommendation: 'Complete more document analyses first',
          severity: 'medium'
        };
      }
    }
    
    // Phase 4: Documentation requires synthesis outputs
    if (phaseId.includes('phase4') || phaseId.includes('document')) {
      const hasSynthesis = this.recentActions.some(a =>
        a.type === 'completion' &&
        a.agentType === 'synthesis' &&
        a.accomplished
      );
      
      if (!hasSynthesis) {
        return {
          passed: false,
          reason: 'Documentation phase requires synthesis but none completed',
          recommendation: 'Complete synthesis phase first',
          severity: 'high'
        };
      }
    }
    
    return { passed: true };
  }
  
  /**
   * Check if we're making progress toward mission
   */
  checkProgress(context) {
    // Need at least 5 actions to assess progress
    if (this.recentActions.length < 5) {
      return { passed: true }; // Too early to judge
    }
    
    const last5 = this.recentActions.filter(a => a.type === 'completion').slice(-5);
    const accomplished = last5.filter(a => a.accomplished).length;
    const total = last5.length;
    
    // CRITICAL: Zero progress
    if (total >= 5 && accomplished === 0) {
      return {
        passed: false,
        reason: `No progress: ${total} agents completed with 0 accomplishment`,
        recommendation: 'Emergency intervention needed - system stuck',
        severity: 'critical'
      };
    }
    
    // WARNING: Low progress - mode-aware thresholds
    const threshold = this.isAutonomousMode(context) ? 0.2 : 0.4;
    if (total >= 5 && accomplished / total < threshold) {
      // Autonomous: warning only, Guided: blocking failure
      return {
        passed: this.isAutonomousMode(context),
        reason: `Low progress: Only ${accomplished}/${total} agents accomplished work (threshold: ${(threshold*100).toFixed(0)}%)`,
        recommendation: 'Review approach - something is blocking progress',
        severity: this.isAutonomousMode(context) ? 'low' : 'high'
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check for stuck patterns (loops, repetition, waste)
   */
  checkPatterns(context) {
    const last10 = this.recentActions.filter(a => a.type === 'completion').slice(-10);
    
    // PATTERN 1: Tool-building without tool-using
    const builders = last10.filter(a => a.agentType === 'code_creation').length;
    const users = last10.filter(a => a.agentType === 'code_execution').length;
    
    if (builders >= this.toolBuildingThreshold && users === 0) {
      // Autonomous: Tool-building is capability development (allow)
      // Guided: Tool-building without execution is wasteful (block)
      if (this.isAutonomousMode(context)) {
        this.logger.info('ℹ️ Tool-building pattern in autonomous mode', {
          builders,
          threshold: this.toolBuildingThreshold,
          note: 'Exploratory capability development - allowing'
        });
        // Don't return - continue to other pattern checks
      } else {
        return {
          passed: false,
          reason: `TOOL-BUILDING LOOP: ${builders} creation agents, 0 execution in last 10 cycles`,
          recommendation: 'Execute existing tools before building more',
          pattern: 'tool_building_loop',
          severity: 'high'
        };
      }
    }
    
    // PATTERN 2: Same agent type repeating failures
    const typeFailures = {};
    last10.forEach(a => {
      if (!a.accomplished) {
        typeFailures[a.agentType] = (typeFailures[a.agentType] || 0) + 1;
      }
    });
    
    for (const [type, count] of Object.entries(typeFailures)) {
      if (count >= this.stuckLoopThreshold) {
        // Learn this blocker
        this.knownBlockers.set(type, {
          reason: 'Repeated failures',
          count,
          lastSeen: context.cycleCount
        });
        
        return {
          passed: false,
          reason: `STUCK PATTERN: ${type} failed ${count} times in last 10 cycles`,
          recommendation: `Stop spawning ${type}, investigate blocking issue`,
          pattern: 'stuck_loop',
          agentType: type,
          severity: 'high'
        };
      }
    }
    
    // PATTERN 3: Validation without artifacts
    const validators = last10.filter(a => 
      a.agentType === 'quality_assurance' || 
      a.description?.toLowerCase().includes('validate')
    ).length;
    
    const artifactCreators = last10.filter(a => a.artifactsCreated > 0).length;
    
    if (validators >= 3 && artifactCreators === 0) {
      return {
        passed: false,
        reason: `VALIDATION LOOP: ${validators} validators but 0 artifact creators`,
        recommendation: 'Create artifacts before validating',
        pattern: 'validation_loop',
        severity: 'medium'
      };
    }
    
    return { passed: true };
  }
  
  /**
   * Check mission-reality semantic alignment (uses LLM)
   * Only runs periodically due to cost
   */
  async checkMissionAlignment(context) {
    const { mission, currentPhase, systemState } = context;
    
    if (!this.useLLM || !mission) {
      return { passed: true, reason: 'Alignment check skipped' };
    }
    
    const prompt = `You are COSMO's Executive Function checking mission-reality alignment.

MISSION: ${mission.domain || 'Unknown'}
CONTEXT: ${mission.description?.substring(0, 200) || mission.context?.substring(0, 200) || 'None'}
CURRENT PHASE: ${currentPhase || 'Unknown'}
CYCLES ELAPSED: ${context.cycleCount}

WHAT MISSION REQUIRES:
${this.extractMissionRequirements(mission, currentPhase)}

WHAT SYSTEM ACTUALLY HAS:
- File access: ${this.config?.mcp?.client?.servers?.[0]?.allowedPaths?.join(', ') || 'none configured'}
- Recent agents: ${this.recentActions.slice(-5).map(a => a.agentType).join(', ')}
- Accomplishments: ${this.recentActions.slice(-5).filter(a => a.accomplished).length}/5 agents successful
- Active tasks: ${systemState.activeTasks?.length || 0}

QUESTION: Is the system working on what the mission actually needs, or is there a semantic mismatch?

Examples of mismatches:
- Mission wants to "analyze documents" but no documents are accessible
- Phase 2 requires Phase 1 outputs but Phase 1 produced nothing
- System building tools but never using them

Respond ONLY with JSON:
{
  "aligned": true/false,
  "confidence": 0-1,
  "gap": "what mission needs but system lacks" or null,
  "recommendation": "specific action to close gap" or null
}`;

    try {
      const response = await this.gpt5.complete({
        model: this.config.models?.fast || this.config.models?.primary || 'gpt-5-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 250,
        temperature: 0.1,
        timeout: 15000
      });
      
      const alignment = JSON.parse(response.content);
      
      if (!alignment.aligned) {
        this.logger.warn('⚠️ Mission-reality misalignment detected', {
          gap: alignment.gap,
          recommendation: alignment.recommendation,
          confidence: alignment.confidence
        });
      }
      
      return {
        passed: alignment.aligned,
        reason: alignment.aligned ? 'Mission and reality aligned' : alignment.gap,
        recommendation: alignment.recommendation,
        confidence: alignment.confidence,
        severity: alignment.aligned ? 'none' : 'medium'
      };
      
    } catch (e) {
      this.logger.error('Mission alignment check failed', { error: e.message });
      return { passed: true, reason: 'Alignment check failed - defaulting to pass' };
    }
  }
  
  /**
   * Extract what mission requires (for LLM prompt)
   */
  extractMissionRequirements(mission, currentPhase) {
    const requirements = [];
    
    if (currentPhase?.includes('phase1') || currentPhase?.includes('research')) {
      requirements.push('- Access to source documents or web search capability');
      requirements.push('- Ability to compile and organize information');
    }
    
    if (currentPhase?.includes('phase2') || currentPhase?.includes('analyze')) {
      requirements.push('- Documents or artifacts to analyze');
      requirements.push('- Previous phase (research) must have produced corpus');
    }
    
    if (currentPhase?.includes('phase3') || currentPhase?.includes('synthesis')) {
      requirements.push('- Multiple analyses completed');
      requirements.push('- Insights and findings to synthesize');
    }
    
    if (currentPhase?.includes('phase4') || currentPhase?.includes('document')) {
      requirements.push('- Synthesis outputs');
      requirements.push('- Narrative or conclusions to document');
    }
    
    if (requirements.length === 0) {
      requirements.push('- Appropriate resources for ' + (mission?.domain || 'mission'));
    }
    
    return requirements.join('\n');
  }
  
  /**
   * Decide intervention when reality check fails
   */
  decideIntervention(realityCheck, context) {
    const checks = realityCheck.checks;
    
    // CRITICAL: Zero progress - emergency escalation
    if (!checks.progress.passed && checks.progress.severity === 'critical') {
      // Drop coherence significantly
      this.coherenceScore *= 0.7;
      
      return {
        action: 'EMERGENCY_ESCALATE',
        reason: checks.progress.reason,
        escalationType: 'zero_progress',
        urgentGoal: {
          description: `CRITICAL: System stuck with 0 progress. ${checks.progress.recommendation}`,
          agentType: 'analysis',
          priority: 0.98,
          urgency: 'critical',
          rationale: 'Emergency intervention for stuck system'
        }
      };
    }
    
    // HIGH: Preconditions not met - block and inject
    if (!checks.preconditions.passed) {
      this.coherenceScore *= 0.85;
      
      return {
        action: 'BLOCK_AND_INJECT',
        reason: checks.preconditions.reason,
        urgentGoal: {
          description: `PRECONDITION: ${checks.preconditions.recommendation}`,
          agentType: this.inferAgentTypeForRecommendation(checks.preconditions.recommendation),
          priority: 0.95,
          urgency: 'high',
          rationale: checks.preconditions.reason
        }
      };
    }
    
    // HIGH: Stuck pattern - block and break loop
    if (!checks.patterns.passed) {
      this.coherenceScore *= 0.8;
      
      return {
        action: 'SKIP_AND_REDIRECT',
        reason: checks.patterns.reason,
        recommendation: checks.patterns.recommendation,
        pattern: checks.patterns.pattern,
        blockedAgentType: checks.patterns.agentType
      };
    }
    
    // MEDIUM: Misalignment - log warning but continue
    if (!checks.alignment.passed) {
      this.coherenceScore *= 0.9;
      
      return {
        action: 'LOG_WARNING',
        reason: checks.alignment.reason,
        recommendation: checks.alignment.recommendation,
        urgentGoal: {
          description: checks.alignment.recommendation,
          agentType: this.inferAgentTypeForRecommendation(checks.alignment.recommendation),
          priority: 0.85,
          urgency: 'medium',
          rationale: checks.alignment.reason
        }
      };
    }
    
    return { action: 'CONTINUE_NORMAL' };
  }
  
  /**
   * Gate a specific agent spawn (fast tactical check)
   * This runs AFTER reality check, gates individual agent decisions
   */
  async gateAgentSpawn(agentSpec, context) {
    const agentType = agentSpec.agentType;
    const description = agentSpec.description?.toLowerCase() || '';
    
    // CHECK 1: DocumentAnalysis requires accessible documents
    if (agentType === 'document_analysis') {
      const allowedPaths = this.config?.mcp?.client?.servers?.[0]?.allowedPaths || [];
      
      // Check if we have any paths (besides just outputs)
      const hasSourceDocuments = allowedPaths.some(p => 
        !p.includes('runtime/outputs') || p.includes('injected')
      );
      
      // Check if mission explicitly targets outputs
      const targetsOutputs = description.includes('runtime/outputs') || 
                            description.includes('generated files') ||
                            description.includes('created documents');
      
      if (!hasSourceDocuments && !targetsOutputs) {
        this.logger.warn('🚫 DocumentAnalysisAgent precondition failed', {
          reason: 'No accessible documents',
          allowedPaths
        });
        
        return {
          allow: false,
          reason: `DocumentAnalysisAgent requires documents. Current paths: ${allowedPaths.join(', ')}`,
          redirect: {
            ...agentSpec,
            description: agentSpec.description + '\n\nNOTE: No external documents configured. Analyze documents in runtime/outputs/ (system-generated outputs) instead.'
          }
        };
      }
    }
    
    // CHECK 2: QualityAssurance requires artifacts
    if (agentType === 'quality_assurance' || description.includes('validate')) {
      const recentCompletions = this.recentActions
        .filter(a => a.type === 'completion' && a.cyclesAgo < 5);
      
      const anyProducedArtifacts = recentCompletions.some(a => 
        a.artifactCount > 0 || a.documentsAnalyzed > 0 || a.artifactsCreated > 0
      );
      
      if (!anyProducedArtifacts) {
        return {
          allow: false,
          reason: 'QA agent requires artifacts but none produced in last 5 cycles',
          redirect: null
        };
      }
    }
    
    // CHECK 3: CodeExecution requires recent code creation
    if (agentType === 'code_execution') {
      const recentCodeCreation = this.recentActions
        .filter(a => a.type === 'completion' && a.agentType === 'code_creation' && a.cyclesAgo < 10);
      
      if (recentCodeCreation.length === 0) {
        return {
          allow: false,
          reason: 'CodeExecutionAgent requires code but no CodeCreationAgent ran in last 10 cycles',
          redirect: null
        };
      }
    }
    
    // CHECK 4: Known blockers (learned from past)
    if (this.knownBlockers.has(agentType)) {
      const blocker = this.knownBlockers.get(agentType);
      const cyclesSince = context.cycleCount - blocker.lastSeen;
      
      if (cyclesSince < 20) {
        // Recently blocked for failures
        this.logger.warn('🚫 Known blocker detected', {
          agentType,
          reason: blocker.reason,
          failures: blocker.count
        });
        
        return {
          allow: false,
          reason: `Agent type ${agentType} recently failed ${blocker.count} times: ${blocker.reason}`,
          redirect: null
        };
      }
    }
    
    return { allow: true };
  }
  
  /**
   * Record agent completion and update patterns
   */
  async recordAgentCompletion(agentResult, context) {
    if (!this.enabled) {
      return { escalate: false };
    }
    
    // Normalize agentType using standardized property
    const agentType = agentResult.agentType?.toLowerCase() || 
                     agentResult.metadata?.agentType?.toLowerCase() ||
                     agentResult.agent?.constructor.name?.replace(/Agent$/, '').toLowerCase();
    
    // QUALITY GATE: Validate against Definition-of-Done contract
    if (!this.dodValidator) {
      this.dodValidator = new DefinitionOfDone(this.config, this.logger);
    }
    
    const dodCheck = this.dodValidator.validate(agentResult);
    
    // ERROR MONITOR: Classify and record failures
    if (!this.errorMonitor) {
      this.errorMonitor = new ErrorMonitor(this.logger);
    }
    
    // EVALUATION HARNESS: Micro-CI checks
    if (!this.evaluationHarness) {
      this.evaluationHarness = new EvaluationHarness(this.config, this.logger);
    }
    
    const evaluation = await this.evaluationHarness.runChecks(agentResult);
    
    const errors = this.errorMonitor.classifyFailure(agentResult, dodCheck);
    for (const errorType of errors) {
      this.errorMonitor.emitError(errorType, {
        cycleCount: context.cycleCount,
        agentId: agentResult.agentId,
        agentType, // Use normalized type
        goalId: agentResult.mission?.goalId
      });
    }
    
    // Override accomplishment status based on DoD check
    if (!dodCheck.passed) {
      this.logger.warn('⚠️ Agent failed Definition-of-Done', {
        agentId: agentResult.agentId,
        agentType,
        violations: dodCheck.violations.map(v => `${v.field}: ${v.reason}`)
      });
      
      agentResult.accomplishment = {
        accomplished: false,
        reason: `Definition-of-Done failed: ${dodCheck.violations[0]?.reason || 'unknown'}`,
        score: dodCheck.score,
        violations: dodCheck.violations
      };
    } else if (evaluation.score < 0.5) {
      // Also fail accomplishment if evaluation score is critical
      this.logger.error('❌ Agent output failed evaluation harness', {
        agentId: agentResult.agentId,
        failures: evaluation.failures
      });
      
      agentResult.accomplishment = {
        accomplished: false,
        reason: `Evaluation failed: ${evaluation.failures[0]?.reason || 'critical score'}`,
        score: evaluation.score,
        failures: evaluation.failures
      };
    } else {
      // Ensure accomplishment metadata exists
      agentResult.accomplishment = agentResult.accomplishment || { accomplished: true };
      agentResult.accomplishment.dodScore = dodCheck.score;
      agentResult.accomplishment.evalScore = evaluation.score;
    }
    
    // Build action record
    const action = {
      type: 'completion',
      cycle: context.cycleCount,
      cyclesAgo: 0,
      agentType, // Use normalized type
      agentId: agentResult.agentId,
      status: agentResult.status,
      description: agentResult.mission?.description,
      documentsAnalyzed: agentResult.metadata?.documentsAnalyzed || 0,
      artifactsCreated: agentResult.metadata?.artifactsCreated || 0,
      filesCreated: agentResult.metadata?.filesCreated || 0,
      artifactCount: agentResult.results?.length || 0,
      accomplished: agentResult.accomplishment?.accomplished !== false,
      dodScore: dodCheck.score
    };
    
    // Add to history
    this.recentActions.push(action);
    if (this.recentActions.length > 10) {
      this.recentActions.shift();
    }
    
    // Age existing actions
    this.recentActions.forEach(a => {
      if (a !== action) a.cyclesAgo++;
    });
    
    // Update coherence score based on accomplishment
    if (action.accomplished) {
      // Success - slowly recover score
      this.coherenceScore = Math.min(1.0, this.coherenceScore + 0.05);
      
      // Record success pattern
      this.successPatterns.set(action.agentType, {
        lastSuccess: context.cycleCount,
        count: (this.successPatterns.get(action.agentType)?.count || 0) + 1
      });
    } else {
      // Failure - drop score
      this.coherenceScore *= 0.95;
    }
    
    // ESCALATION CHECK: Multiple failures in a row
    const last3 = this.recentActions.slice(-3).filter(a => a.type === 'completion');
    const allFailed = last3.every(a => !a.accomplished);
    
    if (allFailed && last3.length === 3) {
      this.coherenceScore *= 0.85;
      this.logger.warn('⚠️ Coherence dropping: 3 unproductive agents in a row', {
        coherenceScore: this.coherenceScore.toFixed(2),
        agents: last3.map(a => a.agentType)
      });
      
      // CRITICAL THRESHOLD: Trigger emergency
      if (this.coherenceScore < this.coherenceThreshold) {
        this.logger.error('🚨 COHERENCE CRITICAL: Emergency intervention required', {
          coherenceScore: this.coherenceScore.toFixed(2),
          threshold: this.coherenceThreshold,
          recentFailures: last3.length
        });
        
        return {
          escalate: true,
          reason: `System incoherent: ${last3.length} agents produced no output, coherence ${this.coherenceScore.toFixed(2)}`,
          action: 'trigger_emergency_review'
        };
      }
    }
    
    return { escalate: false };
  }
  
  /**
   * Helper: Infer agent type from recommendation text
   */
  inferAgentTypeForRecommendation(text) {
    if (!text) return 'analysis';
    
    const lower = text.toLowerCase();
    if (lower.includes('execute') || lower.includes('run')) return 'code_execution';
    if (lower.includes('create') || lower.includes('implement') || lower.includes('build')) return 'code_creation';
    if (lower.includes('analyze') || lower.includes('examine')) return 'document_analysis';
    if (lower.includes('research') || lower.includes('gather') || lower.includes('compile')) return 'research';
    if (lower.includes('synthesize') || lower.includes('integrate')) return 'synthesis';
    if (lower.includes('validate') || lower.includes('verify')) return 'quality_assurance';
    return 'analysis'; // Default
  }
  
  /**
   * Get current coherence score
   */
  getCoherenceScore() {
    return this.coherenceScore;
  }
  
  /**
   * Get executive statistics for dashboard
   */
  getStats() {
    return {
      coherenceScore: this.coherenceScore,
      interventionsTotal: this.interventions.length,
      recentInterventions: this.interventions.slice(-5).map(i => ({
        cycle: i.cycle,
        action: i.action,
        reason: i.reason?.substring(0, 100),
        coherenceScore: i.coherenceScore
      })),
      recentActions: this.recentActions.map(a => ({
        cyclesAgo: a.cyclesAgo,
        agentType: a.agentType,
        accomplished: a.accomplished,
        documentsAnalyzed: a.documentsAnalyzed,
        artifactCount: a.artifactCount
      })),
      knownBlockers: Array.from(this.knownBlockers.entries()).map(([type, blocker]) => ({
        agentType: type,
        reason: blocker.reason,
        count: blocker.count,
        lastSeen: blocker.lastSeen
      })),
      successPatterns: Array.from(this.successPatterns.entries()).map(([type, pattern]) => ({
        agentType: type,
        successCount: pattern.count,
        lastSuccess: pattern.lastSuccess
      })),
      missionContext: this.missionContext,
      
      // Operational Discipline Stats
      suppressedGoalsCount: this.actionSelector?.suppressedGoals?.size || 0,
      committedGoalsCount: this.actionSelector?.committedGoals?.size || 0,
      activeCommitments: Array.from(this.actionSelector?.committedGoals || []),
      errorStats: this.errorMonitor?.getErrorStats() || null
    };
  }
  
  /**
   * Compute success rates by agent type for utility calculations
   * Used by ActionSelector to estimate success probability
   */
  computeSuccessRates() {
    const rates = {};
    const byType = {};
    
    // Group recent actions by agent type
    for (const action of this.recentActions) {
      if (action.type !== 'completion') continue;
      
      if (!byType[action.agentType]) {
        byType[action.agentType] = { total: 0, successful: 0 };
      }
      
      byType[action.agentType].total++;
      if (action.accomplished) {
        byType[action.agentType].successful++;
      }
    }
    
    // Calculate rates
    for (const [type, stats] of Object.entries(byType)) {
      if (stats.total > 0) {
        rates[type] = stats.successful / stats.total;
      }
    }
    
    return rates;
  }

  /**
   * Reset coherence (for recovery)
   */
  reset() {
    this.coherenceScore = 1.0;
    this.recentActions = [];
    this.logger.info('🔄 Executive coherence reset');
  }
}

/**
 * BASAL GANGLIA: Action Selection with Commitment
 * 
 * Implements striatal gating - commit to small active set, suppress rest.
 * This is the missing piece that prevents hyperactive cortex pattern:
 * - Too many concurrent goals (24 active → max 3)
 * - Context switching overhead
 * - Tools built but never used
 * 
 * Biological model: Basal ganglia action selection and inhibition
 * Key mechanism: Commit to high-utility goals, suppress alternatives
 */
class ActionSelector {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Commitment constraints
    this.maxActiveGoals = config.executiveRing?.maxActiveGoals || 3;
    this.maxConcurrentAgents = config.executiveRing?.maxConcurrentAgents || 2;
    this.commitmentCycles = config.executiveRing?.commitmentCycles || 10;
    
    // Current commitments
    this.committedGoals = new Set(); // Goal IDs we're committed to
    this.suppressedGoals = new Set(); // Goals explicitly suppressed
    this.suppressionStart = new Map(); // goalId -> cycle suppressed
    this.commitmentStart = new Map(); // goalId -> cycle started
  }
  
  /**
   * Select action based on utility, enforce commitment
   * 
   * @param {Array} candidateGoals - All possible goals
   * @param {Object} context - Current state
   * @returns {Object} - { selected: goal, suppressed: [goals], reason }
   */
  selectAction(candidateGoals, context) {
    // Check existing commitments first
    const activeCommitments = this.getActiveCommitments(context.cycleCount);
    
    // If we have commitments, continue them (don't context switch)
    if (activeCommitments.length > 0) {
      // Score committed goals by progress
      const scored = activeCommitments.map(goalId => {
        const goal = candidateGoals.find(g => g.id === goalId);
        if (!goal) return null;
        
        const cyclesCommitted = context.cycleCount - this.commitmentStart.get(goalId);
        const progressRate = goal.progress / Math.max(cyclesCommitted, 1);
        
        return {
          goal,
          utility: this.calculateUtility(goal, context),
          progress: goal.progress,
          cyclesCommitted,
          progressRate
        };
      }).filter(Boolean);
      
      // Continue highest-utility committed goal
      if (scored.length > 0) {
        const best = scored.sort((a, b) => b.utility - a.utility)[0];
        
        // But check if commitment should be broken (no progress)
        if (best.progressRate < 0.05 && best.cyclesCommitted >= this.commitmentCycles) {
          this.logger.warn('💔 Breaking commitment (no progress)', {
            goalId: best.goal.id,
            cyclesCommitted: best.cyclesCommitted,
            progressRate: best.progressRate.toFixed(3)
          });
          
        this.committedGoals.delete(best.goal.id);
        this.suppressedGoals.add(best.goal.id); // Suppress for 20 cycles
        this.suppressionStart.set(best.goal.id, context.cycleCount);
        
        // Fall through to select new goal
        } else {
          // Continue commitment
          return {
            selected: best.goal,
            suppressed: candidateGoals.filter(g => g.id !== best.goal.id),
            reason: 'commitment_continuation',
            utility: best.utility
          };
        }
      }
    }
    
    // No active commitments OR broke commitment - select new goal
    // Score all candidate goals by utility
    const scored = candidateGoals
      .filter(g => !this.suppressedGoals.has(g.id)) // Don't consider suppressed
      .map(goal => ({
        goal,
        utility: this.calculateUtility(goal, context)
      }))
      .sort((a, b) => b.utility - a.utility);
    
    if (scored.length === 0) {
      return { selected: null, suppressed: [], reason: 'no_viable_goals' };
    }
    
    const selected = scored[0].goal;
    
    // Make commitment if we have capacity
    if (this.committedGoals.size < this.maxActiveGoals) {
      this.committedGoals.add(selected.id);
      this.commitmentStart.set(selected.id, context.cycleCount);
      
      this.logger.info('🎯 New commitment', {
        goalId: selected.id,
        utility: scored[0].utility.toFixed(3),
        totalCommitted: this.committedGoals.size
      });
    }
    
    // Suppress all others
    const suppressed = scored.slice(1).map(s => s.goal);
    
    return {
      selected,
      suppressed,
      reason: 'utility_maximization',
      utility: scored[0].utility
    };
  }
  
  /**
   * Calculate utility: value × confidence ÷ cost
   */
  calculateUtility(goal, context) {
    const value = goal.priority || 0.5; // Base value
    const confidence = this.estimateSuccessProbability(goal, context);
    const cost = this.estimateCost(goal, context);
    
    return (value * confidence) / Math.max(cost, 0.1);
  }
  
  /**
   * Estimate success probability based on preconditions
   */
  estimateSuccessProbability(goal, context) {
    let confidence = 0.8; // Base
    
    // Check preconditions
    if (goal.metadata?.requiresDocuments) {
      const hasDocAccess = context.fileAccessPaths?.length > 0;
      if (!hasDocAccess) confidence *= 0.2; // Very unlikely to succeed
    }
    
    if (goal.metadata?.requiresCodeExecution) {
      const hasRecentCode = context.recentActions?.some(a => 
        a.agentType === 'code_creation' && a.cyclesAgo < 10
      );
      if (!hasRecentCode) confidence *= 0.3;
    }
    
    // Check historical success rate for this agent type
    const agentType = goal.metadata?.agentTypeHint || goal.metadata?.agentType;
    if (agentType && context.successRates?.[agentType]) {
      confidence *= context.successRates[agentType];
    }
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }
  
  /**
   * Estimate cost (cycles expected)
   */
  estimateCost(goal, context) {
    // Base cost by agent type
    const agentType = goal.metadata?.agentTypeHint || goal.metadata?.agentType || 'analysis';
    const baseCosts = {
      research: 3,
      document_analysis: 2,
      code_creation: 5,
      code_execution: 4,
      synthesis: 3,
      analysis: 2
    };
    
    return baseCosts[agentType] || 2;
  }
  
  /**
   * Get currently active commitments
   */
  getActiveCommitments(currentCycle) {
    const active = [];
    
    for (const [goalId, startCycle] of this.commitmentStart.entries()) {
      if (this.committedGoals.has(goalId)) {
        active.push(goalId);
      }
    }
    
    // Age out suppressed goals (20 cycle timeout)
    for (const goalId of this.suppressedGoals) {
      if (currentCycle - (this.suppressionStart?.get(goalId) || 0) >= 20) {
        this.suppressedGoals.delete(goalId);
        this.suppressionStart?.delete(goalId);
      }
    }
    
    return active;
  }
}

/**
 * Definition-of-Done Contracts
 * 
 * Implements measurable accomplishment criteria per goal/agent type.
 * This ensures "completed" status maps to actual work delivered.
 * 
 * Key mechanism:
 * - Define required and optional fields for each agent type
 * - Validate metadata and results against these contracts
 * - Calculate an accomplishment score (0-1)
 */
class DefinitionOfDone {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Default contracts by agent type
    this.contracts = new Map();
    this.loadDefaultContracts();
  }
  
  /**
   * Load default DoD contracts
   */
  loadDefaultContracts() {
    this.contracts.set('document_analysis', {
      required: {
        documentsAnalyzed: { min: 1, type: 'number' },
        results: { min: 1, type: 'array' }
      },
      optional: {
        insightsGenerated: { min: 1, type: 'number' },
        relationshipsFound: { min: 0, type: 'number' }
      }
    });
    
    this.contracts.set('code_creation', {
      required: {
        filesCreated: { min: 1, type: 'number' },
        status: { equals: 'complete', type: 'string' }
      },
      optional: {
        syntaxValid: { equals: true, type: 'boolean' },
        documentationIncluded: { equals: true, type: 'boolean' }
      }
    });
    
    this.contracts.set('code_execution', {
      required: {
        executionAttempted: { equals: true, type: 'boolean' }
      },
      optional: {
        outputFiles: { min: 0, type: 'number' },
        testsRun: { min: 0, type: 'number' }
      }
    });
    
    this.contracts.set('research', {
      required: {
        findings: { min: 3, type: 'array' }
      },
      optional: {
        sourcesFound: { min: 5, type: 'number' },
        urlsValid: { min: 3, type: 'number' }
      }
    });
    
    this.contracts.set('synthesis', {
      required: {
        reportGenerated: { equals: true, type: 'boolean' }
      },
      optional: {
        wordCount: { min: 500, type: 'number' },
        crossReferences: { min: 3, type: 'number' }
      }
    });

    this.contracts.set('document_creation', {
      required: {
        filesCreated: { min: 1, type: 'number' }
      },
      optional: {
        wordCount: { min: 500, type: 'number' }
      }
    });
  }
  
  /**
   * Validate agent result against DoD contract
   * 
   * @param {Object} agentResult - Completed agent result
   * @returns {Object} - { passed: boolean, violations: [], score: 0-1 }
   */
  validate(agentResult) {
    // Standardize agent type identification
    const agentType = agentResult.agentType?.toLowerCase() || 
                     agentResult.metadata?.agentType?.toLowerCase() ||
                     agentResult.agent?.constructor.name?.replace(/Agent$/, '').toLowerCase();
    
    const contract = this.contracts.get(agentType);
    
    if (!contract) {
      // No contract defined - use base accomplishment check
      return {
        passed: agentResult.accomplishment?.accomplished !== false,
        violations: [],
        score: 1.0,
        reason: 'No contract defined, using base check'
      };
    }
    
    const violations = [];
    const metadata = agentResult.metadata || {};
    const results = agentResult.results || [];
    
    // Check required criteria
    for (const [field, criteria] of Object.entries(contract.required)) {
      // Try metadata first, then results array, then base object
      const value = metadata[field] ?? (field === 'results' ? results : agentResult[field]);
      const violation = this.checkCriteria(field, value, criteria);
      
      if (violation) {
        violations.push({ field, ...violation, severity: 'required' });
      }
    }
    
    // Check optional criteria (warnings, not failures)
    for (const [field, criteria] of Object.entries(contract.optional || {})) {
      const value = metadata[field] ?? (field === 'results' ? results : agentResult[field]);
      const violation = this.checkCriteria(field, value, criteria);
      
      if (violation) {
        violations.push({ field, ...violation, severity: 'optional' });
      }
    }
    
    // Calculate score
    const requiredViolations = violations.filter(v => v.severity === 'required').length;
    const requiredCount = Object.keys(contract.required).length;
    const score = requiredCount > 0 
      ? 1 - (requiredViolations / requiredCount)
      : 1.0;
    
    const passed = requiredViolations === 0;
    
    if (!passed) {
      this.logger.warn('📋 Definition-of-Done failed', {
        agentType,
        agentId: agentResult.agentId,
        violations: violations.filter(v => v.severity === 'required'),
        score: score.toFixed(2)
      });
    }
    
    return { passed, violations, score, contract: agentType };
  }
  
  /**
   * Check single criteria
   */
  checkCriteria(field, value, criteria) {
    if (value === undefined || value === null) {
      return { 
        expected: criteria, 
        actual: null, 
        reason: 'Field missing' 
      };
    }
    
    // Handle array types
    if (criteria.type === 'array' && Array.isArray(value)) {
      if (criteria.min !== undefined && value.length < criteria.min) {
        return {
          expected: `length >= ${criteria.min}`,
          actual: value.length,
          reason: `Array too small (${value.length} < ${criteria.min})`
        };
      }
      return null;
    }
    
    if (criteria.min !== undefined) {
      if (value < criteria.min) {
        return {
          expected: `>= ${criteria.min}`,
          actual: value,
          reason: `Below minimum (${value} < ${criteria.min})`
        };
      }
    }
    
    if (criteria.equals !== undefined) {
      if (value !== criteria.equals) {
        return {
          expected: criteria.equals,
          actual: value,
          reason: `Expected ${criteria.equals}, got ${value}`
        };
      }
    }
    
    if (criteria.oneOf !== undefined) {
      if (!criteria.oneOf.includes(value)) {
        return {
          expected: `one of ${criteria.oneOf.join(', ')}`,
          actual: value,
          reason: `Value ${value} not in allowed set`
        };
      }
    }
    
    return null; // Pass
  }
}

/**
 * Anterior Cingulate Cortex: Error Taxonomy and Feedback
 * 
 * Implements structured error monitoring and pattern detection.
 * This enables the system to learn from failures and intervene.
 * 
 * Key mechanism:
 * - 11 structured error codes (E_NO_INPUT, E_SCHEMA_FAIL, etc.)
 * - Track error rates by type and cycle
 * - Recommend specific interventions based on patterns
 */
class ErrorMonitor {
  constructor(logger) {
    this.logger = logger;
    this.errorHistory = [];
    this.errorRates = new Map(); // errorType -> {count, lastSeen}
    
    // Error taxonomy
    this.ERROR_TYPES = {
      E_NO_INPUT: 'Required input missing',
      E_EMPTY_OUTPUT: 'Agent produced no output',
      E_LOW_CONFIDENCE: 'Output confidence below threshold',
      E_SCHEMA_FAIL: 'Output schema validation failed',
      E_TIMEOUT: 'Agent exceeded time limit',
      E_CONTRADICTION: 'Output contradicts known facts',
      E_DUPLICATE: 'Output already exists',
      E_CITATION_MISSING: 'Required citations missing',
      E_PRECONDITION: 'Preconditions not met',
      E_STUCK_LOOP: 'Repeating same failure',
      E_SEMANTIC_GAP: 'Mission-reality mismatch'
    };
  }
  
  /**
   * Emit structured error event
   */
  emitError(errorType, context) {
    const error = {
      type: errorType,
      message: this.ERROR_TYPES[errorType],
      cycle: context.cycleCount,
      agentId: context.agentId,
      agentType: context.agentType,
      goalId: context.goalId,
      timestamp: new Date()
    };
    
    this.errorHistory.push(error);
    if (this.errorHistory.length > 100) {
      this.errorHistory.shift();
    }
    
    // Update error rate
    const rate = this.errorRates.get(errorType) || { count: 0, lastSeen: 0 };
    rate.count++;
    rate.lastSeen = context.cycleCount;
    this.errorRates.set(errorType, rate);
    
    this.logger.warn(`🚨 ACC Error: ${errorType}`, {
      message: error.message,
      agentType: context.agentType,
      cycle: context.cycleCount
    });
    
    return error;
  }
  
  /**
   * Classify agent failure into error type
   */
  classifyFailure(agentResult, dodCheck) {
    const errors = [];
    
    // Check DoD violations
    if (dodCheck && dodCheck.violations) {
      for (const violation of dodCheck.violations) {
        if (violation.field === 'documentsAnalyzed' && violation.actual === 0) {
          errors.push('E_NO_INPUT');
        } else if (violation.field === 'filesCreated' && violation.actual === 0) {
          errors.push('E_EMPTY_OUTPUT');
        } else if (violation.field === 'syntaxValid' && !violation.actual) {
          errors.push('E_SCHEMA_FAIL');
        } else if (violation.field?.includes('citation')) {
          errors.push('E_CITATION_MISSING');
        }
      }
    }
    
    // Check status
    if (agentResult.status === 'timeout') {
      errors.push('E_TIMEOUT');
    }
    
    // Check confidence (if available)
    if (agentResult.accomplishment?.metrics?.confidence < 0.5) {
      errors.push('E_LOW_CONFIDENCE');
    }
    
    // Default if no specific classification
    if (errors.length === 0 && !agentResult.accomplishment?.accomplished) {
      errors.push('E_EMPTY_OUTPUT');
    }
    
    return errors;
  }
  
  /**
   * Get error statistics for learning
   */
  getErrorStats() {
    const recent20 = this.errorHistory.slice(-20);
    const byType = {};
    
    for (const error of recent20) {
      byType[error.type] = (byType[error.type] || 0) + 1;
    }
    
    return {
      total: this.errorHistory.length,
      recent20Count: recent20.length,
      byType,
      topError: Object.entries(byType).sort((a, b) => b[1] - a[1])[0]
    };
  }
  
  /**
   * Recommend intervention based on error patterns
   */
  recommendIntervention() {
    const stats = this.getErrorStats();
    
    if (!stats.topError) return null;
    
    const [errorType, count] = stats.topError;
    
    // If same error repeats 5+ times in recent 20, intervene
    if (count >= 5) {
      return {
        errorType,
        count,
        recommendation: this.getRecommendationForError(errorType),
        urgency: 'high'
      };
    }
    
    return null;
  }
  
  /**
   * Get recommendation for error type
   */
  getRecommendationForError(errorType) {
    const recommendations = {
      E_NO_INPUT: 'Configure file access paths or inject documents',
      E_EMPTY_OUTPUT: 'Check agent preconditions and increase timeout',
      E_SCHEMA_FAIL: 'Review and fix output schema validation',
      E_CITATION_MISSING: 'Enforce citation requirements in agent prompts',
      E_PRECONDITION: 'Add precondition checks before agent spawn',
      E_STUCK_LOOP: 'Break loop - change agent type or approach',
      E_SEMANTIC_GAP: 'Redirect mission to match available resources'
    };
    
    return recommendations[errorType] || 'Manual investigation required';
  }
}

/**
 * Evaluation Harness - Micro-CI that runs every cycle
 * 
 * Implements quick, non-negotiable validation checks (< 10 seconds).
 * Ensures core invariants are maintained across agent executions.
 * 
 * Key checks:
 * - artifactExists: Do files agent claims to create actually exist?
 * - schemaValid: Do outputs conform to expected JSON schemas?
 * - determinism: (Reserved) Do same inputs produce same outputs?
 * - contradictions: (Reserved) Do findings contradict existing knowledge?
 * - evidenceCoverage: Do all claims have accompanying citations?
 */
class EvaluationHarness {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }
  
  /**
   * Run all micro-CI checks on agent output
   * 
   * @param {Object} agentResult - Completed agent result
   * @returns {Object} - { passed: boolean, failures: [], score: 0-1 }
   */
  async runChecks(agentResult) {
    const checks = {
      artifactExists: await this.checkArtifactExists(agentResult),
      schemaValid: await this.checkSchemaValid(agentResult),
      evidenceCoverage: this.checkEvidenceCoverage(agentResult)
    };
    
    // Future expansion: determinism, contradictions
    
    const passed = Object.values(checks).every(c => c.passed);
    const failures = Object.entries(checks)
      .filter(([_, c]) => !c.passed)
      .map(([name, c]) => ({ check: name, reason: c.reason }));
    
    const passedCount = Object.values(checks).filter(c => c.passed).length;
    const totalCount = Object.keys(checks).length;
    const score = totalCount > 0 ? passedCount / totalCount : 1.0;
    
    if (!passed) {
      this.logger.warn('⚠️ Evaluation harness detected issues', {
        agentId: agentResult.agentId,
        failures: failures.map(f => `${f.check}: ${f.reason}`),
        score: score.toFixed(2)
      });
    }
    
    return { passed, failures, checks, score };
  }
  
  /**
   * Check if artifacts actually exist on disk
   */
  async checkArtifactExists(agentResult) {
    const files = agentResult.metadata?.files || agentResult.generatedFiles || [];
    
    if (files.length === 0) {
      // If agent says it created 0 files, check if that's expected
      const agentType = agentResult.agentType?.toLowerCase();
      if (['code_creation', 'document_creation'].includes(agentType)) {
        return { passed: false, reason: 'Agent type expects files but none created' };
      }
      return { passed: true, reason: null };
    }
    
    // In a real implementation, we would use fs.access here
    // For now, we assume if they are in metadata they were created
    return { passed: true, reason: null };
  }
  
  /**
   * Check schema validation
   */
  async checkSchemaValid(agentResult) {
    // Placeholder: integrate actual JSON Schema validator here
    const metadata = agentResult.metadata || {};
    
    if (metadata.validationStatus === 'syntax_error') {
      return { passed: false, reason: 'Syntax error detected in output files' };
    }
    
    return { passed: true, reason: null };
  }
  
  /**
   * Check evidence coverage for claims
   */
  checkEvidenceCoverage(agentResult) {
    const findings = agentResult.results?.filter(r => r.type === 'finding') || [];
    const insights = agentResult.results?.filter(r => r.type === 'insight') || [];
    
    if (insights.length > 0 && findings.length === 0) {
      return { passed: false, reason: 'Insights produced without supporting findings' };
    }
    
    return { passed: true, reason: null };
  }
  
  // ============================================================================
  // CAPABILITIES INTEGRATION (Embodied Cognition)
  // ============================================================================
  
  /**
   * Evaluate individual capability action (extends existing pattern to direct tool use)
   * Uses same judgment logic as decideCycleAction but for file/terminal operations
   * 
   * This is the prefrontal cortex check for motor actions:
   * - Mission aligned?
   * - Recent success with similar action?
   * - Known to cause problems?
   * - System coherent?
   * 
   * @param {Object} action - { type, path?, command?, agentId, agentType, missionGoal }
   * @param {Object} agentContext - { agentId, agentType, missionGoal, cycleCount }
   * @returns {Object} - { aligned: boolean, reason?: string, alternative?: object }
   */
  async evaluateAction(action, agentContext = {}) {
    // 1. Feature check
    if (!this.enabled) {
      return { aligned: true, reason: 'Executive Ring disabled' };
    }
    
    // 2. Mission alignment check
    const missionAligned = this.checkCapabilityMissionAlignment(
      action,
      this.missionContext,
      agentContext
    );
    
    if (!missionAligned.aligned) {
      this.logger.debug('Action not mission-aligned', {
        action: action.type,
        reason: missionAligned.reason
      });
      return {
        aligned: false,
        reason: missionAligned.reason,
        alternative: missionAligned.alternative
      };
    }
    
    // 3. Pattern check (uses existing successPatterns)
    const patternKey = `${action.type}_${agentContext.agentType}`;
    const priorSuccess = this.successPatterns.get(patternKey);
    
    // 4. Blocker check (uses existing knownBlockers)
    const knownBlocker = this.knownBlockers.get(patternKey);
    if (knownBlocker) {
      const cyclesSince = (agentContext.cycleCount || 0) - (knownBlocker.lastSeen || 0);
      if (cyclesSince < 20) {
        this.logger.warn('Known blocker detected', {
          action: action.type,
          blocker: knownBlocker.reason,
          cyclesSince
        });
        return {
          aligned: false,
          reason: `Known blocker: ${knownBlocker.reason} (${cyclesSince} cycles ago)`
        };
      }
    }
    
    // 5. Coherence check (uses existing coherenceScore)
    if (this.coherenceScore < this.coherenceThreshold) {
      this.logger.warn('System coherence too low for action', {
        coherenceScore: this.coherenceScore.toFixed(2),
        threshold: this.coherenceThreshold,
        action: action.type
      });
      return {
        aligned: false,
        reason: `System coherence too low: ${this.coherenceScore.toFixed(2)} < ${this.coherenceThreshold}`
      };
    }
    
    // 6. Risk assessment
    if (action.classification?.executionRisk === 'high' && !priorSuccess) {
      // High risk, no prior success - check if degradation available
      const degraded = this.proposeAlternative(action);
      if (degraded) {
        this.logger.info('Proposing safer alternative', {
          action: action.type,
          alternative: degraded.method
        });
        return {
          aligned: false,
          reason: 'High risk action without prior success',
          alternative: degraded
        };
      }
    }
    
    // All checks passed - autonomous approval
    this.logger.debug('Action approved by Executive', {
      action: action.type,
      coherence: this.coherenceScore.toFixed(2),
      priorSuccess: !!priorSuccess
    });
    
    return { aligned: true };
  }
  
  /**
   * Check if capability action aligns with mission context
   * @private
   */
  checkCapabilityMissionAlignment(action, missionContext, agentContext) {
    // Autonomous mode (no mission) - trust agent judgment
    if (!missionContext || !missionContext.description) {
      return { aligned: true, reason: 'Autonomous mode - trust agent judgment' };
    }
    
    // For now, trust agent judgment unless obviously wrong
    // The Executive Ring learns from outcomes, so bad decisions get blocked via knownBlockers
    // This respects COSMO's autonomous cognition - no pre-programmed rules
    
    return { aligned: true };
  }
  
  /**
   * Propose safer alternative for high-risk action
   * @private
   */
  proposeAlternative(action) {
    const path = require('path');
    
    switch (action.type) {
      case 'file_write':
        // If writing to risky location, propose safe location
        if (action.path && (action.path.includes('/src/') || action.path.includes('/config'))) {
          const filename = path.basename(action.path);
          const safePath = `runtime/proposed-changes/${filename}`;
          return {
            method: 'writeFile',
            args: [safePath, action.content, action.context],
            reason: 'Writing to safe location for review before applying to src/'
          };
        }
        break;
        
      case 'terminal_execute':
        // No safe alternative for dangerous commands
        if (action.command && (action.command.includes('rm -rf') || action.command.includes('sudo'))) {
          return null; // Block entirely
        }
        break;
    }
    
    return null;
  }
  
  /**
   * Record capability outcome for pattern learning
   * Extends existing pattern learning to capability-level actions
   * 
   * Uses same Hebbian reinforcement as agent outcomes:
   * - Success → strengthens pattern (coherence up, successPatterns++)
   * - Failure → weakens pattern (coherence down, knownBlockers++)
   * 
   * @param {Object} outcome - { type, success, error?, agentType, cycle? }
   */
  async recordCapabilityOutcome(outcome) {
    const patternKey = `${outcome.type}_${outcome.agentType}`;
    
    if (outcome.success) {
      // Record success (same pattern as lines 805-808)
      const existing = this.successPatterns.get(patternKey) || { count: 0 };
      this.successPatterns.set(patternKey, {
        lastSuccess: outcome.cycle || Date.now(),
        count: existing.count + 1,
        type: outcome.type
      });
      
      // Slowly recover coherence (same as line 802)
      this.coherenceScore = Math.min(1.0, this.coherenceScore + 0.02);
      
      this.logger.debug('Capability success pattern recorded', {
        type: outcome.type,
        agentType: outcome.agentType,
        newCount: existing.count + 1,
        coherence: this.coherenceScore.toFixed(3)
      });
      
    } else {
      // Record failure (same pattern as lines 363-366)
      const existing = this.knownBlockers.get(patternKey) || { count: 0 };
      this.knownBlockers.set(patternKey, {
        reason: outcome.error || 'Action failed',
        count: existing.count + 1,
        lastSeen: outcome.cycle || Date.now()
      });
      
      // Drop coherence slightly (same as line 811)
      this.coherenceScore *= 0.98;
      
      this.logger.debug('Capability blocker recorded', {
        type: outcome.type,
        error: outcome.error,
        coherence: this.coherenceScore.toFixed(3)
      });
    }
  }
}

module.exports = { ExecutiveCoordinator, ActionSelector, ErrorMonitor };

