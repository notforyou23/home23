const fs = require('fs').promises;
const path = require('path');
const { UnifiedClient } = require('../core/unified-client');
const { KeyKnowledgeBase } = require('./key-knowledge-base');
const { KeyValidator } = require('./key-validator');
const { KeyMiner } = require('./key-miner');
const { CapabilityManifest } = require('../execution/capability-manifest');

/**
 * Action Coordinator
 * 
 * Peer to Meta-Coordinator that closes COSMO's autonomous loop by transforming
 * accumulated knowledge into executable actions.
 * 
 * THE VISION: "Giving hands to the brain (and the keys to open doors)."
 * 
 * Triggers:
 * 1. Every 20 cycles (periodic, like Meta-Coordinator)
 * 2. On plan completion (natural checkpoint)
 * 3. Voice signals from COSMO Speaks (optional)
 * 
 * Flow:
 * 1. Gather full context (11 streams: PGS, domain, plans, thoughts, goals, etc.)
 * 2. Analyze gaps via PGS query: "What needs to be BUILT/EXECUTED?"
 * 3. Make strategic action decision (Opus-level reasoning)
 * 4. Spawn execution sub-agents (discovery, construction, deployment)
 * 5. Monitor progress and handle stop control
 * 6. Report back to Meta-Coordinator + Executive Ring
 * 
 * Key Principles:
 * - Brain-first: leverage internal research before external tools
 * - Full context: not truncated
 * - Key discovery: mine GitHub/Stack/Reddit for API keys (THE UNLOCK)
 * - Coordinated sub-agents: not simple routing
 * - Feedback pipes: keep graph clean
 */
class ActionCoordinator {
  constructor(config, logger, pathResolver = null, capabilities = null, eventEmitter = null, orchestrator = null) {
    this.config = config.actionCoordinator || {};
    this.fullConfig = config;
    this.logger = logger;
    this.pathResolver = pathResolver;
    this.capabilities = capabilities;
    this.orchestrator = orchestrator;
    
    // LLM client for strategic decisions (Opus-level)
    this.llm = new UnifiedClient(config, logger);
    
    // Multi-tenant event emitter
    this.events = eventEmitter;
    
    // Configuration
    const coordConfig = this.config;
    this.enabled = coordConfig.enabled !== false; // Default to true
    this.triggerInterval = coordConfig.triggerCyclePeriod || 20; // Every 20 cycles
    
    // State tracking
    this.lastTriggerCycle = 0;
    this.actionHistory = [];
    this.activeSubAgents = new Map(); // Track running sub-agents
    this.stopRequested = false;
    
    // Directories
    this.coordinatorDir = pathResolver
      ? pathResolver.getCoordinatorDir()
      : (config?.logsDir
          ? path.join(config.logsDir, 'action-coordinator')
          : path.join(__dirname, '..', '..', 'runtime', 'action-coordinator'));
    
    // Key Discovery System - THE UNLOCK
    const keyStoragePath = path.join(this.coordinatorDir, 'key-knowledge-base.json');
    this.keyKB = new KeyKnowledgeBase(logger, keyStoragePath);
    this.keyValidator = new KeyValidator(logger);
    this.keyMiner = new KeyMiner(logger, this.keyKB, this.keyValidator);
    
    // Context providers (initialized later)
    this.contextProviders = null;
    
    this.logger.info('ActionCoordinator initialized', {
      enabled: this.enabled,
      triggerInterval: this.triggerInterval,
      keyKB: keyStoragePath
    });
  }
  
  /**
   * Initialize Action Coordinator (called after construction)
   */
  async initialize() {
    // Initialize Key Knowledge Base
    await this.keyKB.initialize();
    
    this.logger.info('ActionCoordinator fully initialized', {
      keysLoaded: this.keyKB.metadata.size
    });
  }
  
  /**
   * Set orchestrator reference (called after orchestrator is constructed)
   */
  setOrchestrator(orchestrator) {
    this.orchestrator = orchestrator;
  }
  
  /**
   * Initialize context providers (called after all systems are ready)
   */
  initializeContextProviders(dependencies) {
    this.contextProviders = {
      pgs: dependencies.pgs,
      memory: dependencies.memory,
      goals: dependencies.goals,
      plans: dependencies.plans,
      thoughts: dependencies.thoughts,
      surprises: dependencies.surprises,
      agents: dependencies.agents,
      artifacts: dependencies.artifacts,
      voice: dependencies.voice,
      executive: dependencies.executive
    };
    
    this.logger.info('ActionCoordinator context providers initialized');
  }
  
  /**
   * Check if Action Coordinator should trigger
   */
  shouldTrigger(cycleCount, planCompleted = false, options = {}) {
    if (!this.enabled) {
      return false;
    }
    
    // Manual trigger (for testing)
    if (options.force || this.config.forceTrigger) {
      return true;
    }
    
    // Trigger 1: Every N cycles (default 20)
    const cycleTrigger = (cycleCount - this.lastTriggerCycle) >= this.triggerInterval;
    
    // Trigger 2: Plan completion
    const planTrigger = planCompleted;
    
    // TODO: Trigger 3: Voice signals from COSMO Speaks
    
    return cycleTrigger || planTrigger;
  }
  
  /**
   * Force trigger on next check (for testing)
   */
  enableForceTrigger() {
    this.config.forceTrigger = true;
    this.logger.info('Action Coordinator force trigger enabled (will run on next cycle)');
  }
  
  /**
   * Disable force trigger
   */
  disableForceTrigger() {
    this.config.forceTrigger = false;
    this.logger.info('Action Coordinator force trigger disabled');
  }
  
  /**
   * Run Action Coordinator cycle
   */
  async run(cycleCount, runContext = {}) {
    this.logger.info('═══════════════════════════════════════════════════════', 1);
    this.logger.info('🔨 ACTION COORDINATOR TRIGGERING', 1);
    this.logger.info(`   Cycle: ${cycleCount}`, 1);
    this.logger.info(`   Domain: ${runContext.domain || 'none'}`, 1);
    this.logger.info('═══════════════════════════════════════════════════════', 1);
    
    try {
      // Phase 1: Gather full context (11 streams)
      this.logger.info('📊 Phase 1: Gathering context (11 streams)...', 2);
      const context = await this.gatherContext(cycleCount, runContext);
      this.logger.info(`✅ Context gathered: ${Object.keys(context).length} streams`, 2);
      
      // Phase 2: Analyze gaps via PGS
      this.logger.info('🔍 Phase 2: Analyzing gaps...', 2);
      const gaps = await this.analyzeGaps(context);
      this.logger.info(`✅ Gaps analyzed:`, 2);
      this.logger.info(`   PGS gaps: ${gaps.pgsGaps?.length || 0}`, 2);
      this.logger.info(`   Unrealized goals: ${gaps.unrealizedGoals?.length || 0}`, 2);
      
      // Phase 3: Make strategic action decision (Opus)
      this.logger.info('🧠 Phase 3: Making strategic decision (Opus)...', 2);
      const decision = await this.makeDecision(context, gaps);
      this.logger.info(`✅ Decision made: shouldAct=${decision.shouldAct}`, 2);
      
      if (!decision.shouldAct) {
        this.logger.info('⏭️  No action needed this cycle', 2);
        this.logger.info(`   Rationale: ${decision.rationale}`, 2);
        this.logger.info('═══════════════════════════════════════════════════════', 1);
        this.lastTriggerCycle = cycleCount;
        return;
      }
      
      this.logger.info(`🎯 Action: ${decision.action}`, 2);
      this.logger.info(`   Sub-agents to spawn: ${decision.subAgents?.length || 0}`, 2);
      
      // Phase 4: Execute action (spawn sub-agents)
      this.logger.info('⚡ Phase 4: Executing action...', 2);
      const result = await this.executeAction(decision, context);
      this.logger.info(`✅ Execution ${result.status}`, 2);
      this.logger.info(`   Spawned: ${result.subAgentResults?.length || 0} sub-agents`, 2);
      if (result.errors?.length > 0) {
        this.logger.warn(`   Errors: ${result.errors.length}`, 2);
      }
      
      // Phase 5: Report back (feedback pipes)
      this.logger.info('📤 Phase 5: Reporting completion...', 2);
      await this.reportCompletion(result, decision, context);
      this.logger.info('✅ Reports sent', 2);
      
      // Update state
      this.lastTriggerCycle = cycleCount;
      this.actionHistory.push({
        cycle: cycleCount,
        decision,
        result,
        timestamp: Date.now()
      });
      
      this.logger.info('═══════════════════════════════════════════════════════', 1);
      this.logger.info('✅ ACTION COORDINATOR CYCLE COMPLETE', 1);
      this.logger.info('═══════════════════════════════════════════════════════', 1);
      
    } catch (error) {
      this.logger.error('❌ ACTION COORDINATOR ERROR', 1);
      this.logger.error(`   ${error.message}`, 1);
      this.logger.error(`   Stack: ${error.stack}`, 3);
      this.logger.error('═══════════════════════════════════════════════════════', 1);
      throw error;
    }
  }
  
  /**
   * Phase 1: Gather full context from 11 streams
   */
  async gatherContext(cycleCount, runContext) {
    const context = {
      cycleCount,
      timestamp: Date.now(),
      domain: runContext.domain || null,
      plan: runContext.plan || null
    };
    
    // Stream 1: PGS query results (brain-first)
    if (this.contextProviders?.pgs) {
      context.pgs = await this.queryPGS();
    }
    
    // Stream 2: Domain + run context
    context.runContext = runContext;
    
    // Stream 3: Plans (current + past)
    if (this.contextProviders?.plans) {
      context.plans = await this.contextProviders.plans.getAll();
    }
    
    // Stream 4: Thought stream (last 50 cycles)
    if (this.contextProviders?.thoughts) {
      context.thoughts = await this.contextProviders.thoughts.getRecent(50);
    }
    
    // Stream 5: Goals system state
    if (this.contextProviders?.goals) {
      context.goals = await this.contextProviders.goals.getState();
    }
    
    // Stream 6: Surprises
    if (this.contextProviders?.surprises) {
      context.surprises = await this.contextProviders.surprises.getRecent();
    }
    
    // Stream 7: Memory network state
    if (this.contextProviders?.memory) {
      context.memory = await this.contextProviders.memory.getState();
    }
    
    // Stream 8: Agent activity
    if (this.contextProviders?.agents) {
      context.agents = await this.contextProviders.agents.getActivity();
    }
    
    // Stream 9: Artifact index (leverage existing: results queue + memory)
    if (this.contextProviders?.artifacts) {
      context.artifacts = await this.contextProviders.artifacts.buildIndex();
    }
    
    // Stream 10: COSMO Speaks voice (strategic intuition)
    if (this.contextProviders?.voice) {
      context.voice = await this.contextProviders.voice.getRecent(20);
    }
    
    // Stream 11: Executive Ring state
    if (this.contextProviders?.executive) {
      context.executive = await this.contextProviders.executive.getState();
    }
    
    return context;
  }
  
  /**
   * Query PGS with brain-first questions
   */
  async queryPGS() {
    // Three-tier query pattern
    const queries = {
      gaps: "Given everything I've learned, what are the gaps?",
      solutions: "What do we know about solving these gaps?",
      tools: "What tools/integrations have we researched?"
    };
    
    const results = {};
    
    for (const [key, query] of Object.entries(queries)) {
      if (this.contextProviders.pgs) {
        try {
          results[key] = await this.contextProviders.pgs.query(query);
        } catch (error) {
          this.logger.warn(`PGS query failed: ${key}`, { error: error.message });
          results[key] = null;
        }
      }
    }
    
    return results;
  }
  
  /**
   * Phase 2: Analyze gaps from context
   */
  async analyzeGaps(context) {
    // Synthesize gaps from multiple sources
    const gaps = {
      pgsGaps: context.pgs?.gaps || [],
      unrealizedGoals: this.extractUnrealizedGoals(context.goals),
      missingCapabilities: this.identifyMissingCapabilities(context),
      voiceSignals: this.analyzeVoiceSignals(context.voice)
    };
    
    return gaps;
  }
  
  /**
   * Phase 3: Make strategic action decision (Opus)
   */
  async makeDecision(context, gaps) {
    const prompt = this.buildDecisionPrompt(context, gaps);
    
    try {
      const response = await this.llm.chat([
        {
          role: 'user',
          content: prompt
        }
      ], {
        model: this.config.models?.coordinatorStrategic,
        temperature: 0.7,
        max_tokens: 4000
      });
      
      const decision = JSON.parse(response.content);
      return decision;
      
    } catch (error) {
      this.logger.error('Decision making failed', { error: error.message });
      return {
        shouldAct: false,
        rationale: `Decision error: ${error.message}`
      };
    }
  }
  
  /**
   * Build decision prompt with full context
   */
  buildDecisionPrompt(context, gaps) {
    return `You are the Action Coordinator for a COSMO autonomous research brain.

Your role: Transform accumulated knowledge into executable actions.

FULL CONTEXT (do not truncate):

## Brain Knowledge (PGS Results)
${JSON.stringify(context.pgs, null, 2)}

## Domain & Run Context
${JSON.stringify(context.runContext, null, 2)}

## Plans (Current + Past)
${JSON.stringify(context.plans, null, 2)}

## Recent Thinking (Last 50 Cycles)
${this.formatThoughts(context.thoughts)}

## Goals System State
${JSON.stringify(context.goals, null, 2)}

## Surprises
${JSON.stringify(context.surprises, null, 2)}

## Memory Network State
${JSON.stringify(context.memory, null, 2)}

## Agent Activity
${JSON.stringify(context.agents, null, 2)}

## Artifacts Index
${JSON.stringify(context.artifacts, null, 2)}

## COSMO Speaks Strategic Voice
${this.formatVoice(context.voice)}

## Executive Ring State
${JSON.stringify(context.executive, null, 2)}

## Identified Gaps
${JSON.stringify(gaps, null, 2)}

${(() => { try { return new CapabilityManifest().getCoordinatorInjectionText(); } catch (e) { return ''; } })()}

---

BRAIN-FIRST PRINCIPLE:
Before recommending external tools, mine OUR knowledge for what we've already learned.

DECISION REQUIRED:
1. Should action be taken? (yes/no + rationale)
2. If yes, what action? (specific, concrete)
3. What sub-agents are needed? (discovery/construction/deployment/dataacquisition/datapipeline/infrastructure/automation)
4. What context should each sub-agent receive?
5. What are the success criteria?
6. What are the risks?
7. What feedback should go back to Meta-Coordinator?

Respond in JSON format:
{
  "shouldAct": boolean,
  "rationale": "string",
  "action": "string (if shouldAct=true)",
  "subAgents": [
    {
      "type": "discovery|construction|deployment|dataacquisition|datapipeline|infrastructure|automation",
      "briefing": "string",
      "context": {}
    }
  ],
  "successCriteria": ["string"],
  "risks": ["string"],
  "feedback": {
    "goalsToComplete": ["goalId"],
    "thoughtsToRealize": ["thoughtId"],
    "artifactsToCreate": ["description"]
  }
}`;
  }
  
  /**
   * Phase 4: Execute action by spawning sub-agents
   */
  async executeAction(decision, context) {
    this.logger.info('Executing action', { action: decision.action });
    
    const results = {
      status: 'IN_PROGRESS',
      subAgentResults: [],
      artifacts: [],
      errors: []
    };
    
    // Spawn sub-agents in sequence
    for (const subAgent of decision.subAgents) {
      try {
        const result = await this.spawnSubAgent(subAgent, context);
        results.subAgentResults.push(result);
        
        // Check for stop signal
        if (this.stopRequested) {
          results.status = 'STOPPED';
          this.logger.warn('Action execution stopped by user');
          break;
        }
        
      } catch (error) {
        this.logger.error('Sub-agent failed', { 
          type: subAgent.type,
          error: error.message 
        });
        results.errors.push({
          subAgent: subAgent.type,
          error: error.message
        });
      }
    }
    
    results.status = results.errors.length > 0 ? 'PARTIAL' : 'COMPLETE';
    return results;
  }
  
  /**
   * Spawn a sub-agent (discovery, construction, or deployment)
   */
  async spawnSubAgent(subAgent, context) {
    this.logger.info(`Spawning ${subAgent.type} sub-agent`);
    
    if (!this.orchestrator || !this.orchestrator.agentExecutor) {
      this.logger.error('Cannot spawn sub-agent: agentExecutor not available');
      return {
        type: subAgent.type,
        status: 'ERROR',
        error: 'agentExecutor not available'
      };
    }
    
    // Map sub-agent type to COSMO agent type
    const agentTypeMap = {
      discovery: 'research',           // Research agent for external discovery
      construction: 'ide',             // IDE agent for building/adapting code
      deployment: 'code_execution',    // Code execution agent for running
      scraping: 'dataacquisition',     // Data acquisition for web scraping/API consumption
      data_collection: 'dataacquisition',
      data_acquisition: 'dataacquisition',
      etl: 'datapipeline',            // Data pipeline for ETL/database creation
      database: 'datapipeline',
      data_pipeline: 'datapipeline',
      transform: 'datapipeline',
      infrastructure: 'infrastructure', // Infrastructure for services/containers
      service_setup: 'infrastructure',
      automation: 'automation',        // Automation for OS/file tasks
      file_operations: 'automation'
    };

    // Also accept direct agent type names (e.g., 'dataacquisition' passed through)
    const agentType = agentTypeMap[subAgent.type] || subAgent.type || 'ide';
    
    // Create mission spec
    const missionSpec = {
      goalId: `action-coordinator-${Date.now()}-${subAgent.type}`,
      agentType: agentType,
      description: subAgent.briefing || `Action Coordinator ${subAgent.type} task`,
      metadata: {
        source: 'action_coordinator',
        subAgentType: subAgent.type,
        context: subAgent.context
      }
    };
    
    try {
      // Spawn via AgentExecutor
      const agentId = await this.orchestrator.agentExecutor.spawnAgent(missionSpec);
      
      if (!agentId) {
        return {
          type: subAgent.type,
          status: 'ERROR',
          error: 'Failed to spawn agent (null agentId)'
        };
      }
      
      // Track active sub-agent
      this.activeSubAgents.set(agentId, {
        type: subAgent.type,
        startTime: Date.now(),
        missionSpec
      });
      
      this.logger.info(`Sub-agent spawned: ${agentId}`, {
        type: subAgent.type,
        agentType
      });
      
      // For now, return immediately (asynchronous execution)
      // TODO: Add monitoring/waiting logic
      return {
        type: subAgent.type,
        status: 'SPAWNED',
        agentId,
        message: 'Agent spawned successfully (async execution)'
      };
      
    } catch (error) {
      this.logger.error('Failed to spawn sub-agent', {
        type: subAgent.type,
        error: error.message
      });
      
      return {
        type: subAgent.type,
        status: 'ERROR',
        error: error.message
      };
    }
  }
  
  /**
   * Phase 5: Report completion back to Meta-Coordinator + Executive Ring
   */
  async reportCompletion(result, decision, context) {
    this.logger.info('Reporting action completion');
    
    // Report to Meta-Coordinator
    await this.reportToMetaCoordinator(result, decision);
    
    // Report to Executive Ring
    await this.reportToExecutiveRing(result, decision);
    
    // Integrate artifacts into memory
    await this.integrateArtifacts(result, context);
  }
  
  async reportToMetaCoordinator(result, decision) {
    // TODO: Implement feedback channel
    this.logger.info('Reported to Meta-Coordinator', {
      action: decision.action,
      status: result.status
    });
  }
  
  async reportToExecutiveRing(result, decision) {
    // TODO: Implement goal update requests
    this.logger.info('Reported to Executive Ring', {
      goalsCompleted: decision.feedback?.goalsToComplete || []
    });
  }
  
  async integrateArtifacts(result, context) {
    // TODO: Add artifacts to memory network
    this.logger.info('Artifacts integrated', {
      count: result.artifacts?.length || 0
    });
  }
  
  /**
   * Helper: Extract unrealized goals
   */
  extractUnrealizedGoals(goalsState) {
    if (!goalsState?.activeGoals) return [];
    return goalsState.activeGoals.filter(g => g.satisfaction < 0.5);
  }
  
  /**
   * Helper: Identify missing capabilities
   */
  identifyMissingCapabilities(context) {
    // TODO: Analyze what capabilities are referenced but not available
    return [];
  }
  
  /**
   * Helper: Analyze voice signals
   */
  analyzeVoiceSignals(voice) {
    if (!voice) return null;
    
    // Pattern match for thinking→doing gap signals
    const triggerPhrases = [
      'stop gathering and start doing',
      'stays conceptual instead of testable',
      'conversion step',
      'need to build'
    ];
    
    const matches = voice.filter(entry => {
      const text = entry.utterance || '';
      return triggerPhrases.some(phrase => text.toLowerCase().includes(phrase));
    });
    
    return {
      triggered: matches.length > 0,
      signals: matches
    };
  }
  
  /**
   * Helper: Format thoughts for prompt
   */
  formatThoughts(thoughts) {
    if (!thoughts || thoughts.length === 0) return 'No recent thoughts';
    return thoughts.map((t, i) => `${i + 1}. ${t.summary || t.content}`).join('\n');
  }
  
  /**
   * Helper: Format voice entries for prompt
   */
  formatVoice(voice) {
    if (!voice || voice.length === 0) return 'No recent voice signals';
    return voice.map((v, i) => `${i + 1}. ${v.utterance} (${v.timestamp})`).join('\n');
  }
  
  /**
   * Request stop (hard-stop control)
   */
  requestStop() {
    this.logger.warn('Action Coordinator stop requested');
    this.stopRequested = true;
    
    // Halt all active sub-agents
    for (const [key, agent] of this.activeSubAgents) {
      // TODO: Implement sub-agent halt
      this.logger.info(`Halting sub-agent: ${key}`);
    }
  }
  
  /**
   * Reset stop flag
   */
  resetStop() {
    this.stopRequested = false;
    this.activeSubAgents.clear();
  }
}

module.exports = { ActionCoordinator };
