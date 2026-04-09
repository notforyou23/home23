const fs = require('fs').promises;
const path = require('path');
const { StateCompression } = require('./state-compression');
const { validateAndClean } = require('./validation');
const { parseWithFallback } = require('./json-repair');
const { GoalCurator } = require('../goals/goal-curator');
const { EvaluationFramework } = require('../evaluation/evaluation-framework');
const { getDomainAnchor, filterDomainRelevant } = require('../utils/domain-anchor');

// Phase A: Hardening modules
const { StateValidator } = require('./state-validator');
const { ResourceMonitor } = require('./resource-monitor');
const { CrashRecoveryManager } = require('./crash-recovery-manager');
const { TimeoutManager } = require('./timeout-manager');
const { GracefulShutdownHandler } = require('./graceful-shutdown-handler');
const { TelemetryCollector } = require('./telemetry-collector');

// Planning modules
const PlanScheduler = require('../planning/plan-scheduler');
const AcceptanceValidator = require('../planning/acceptance-validator');
const { PlanExecutor } = require('./plan-executor');
const { IntrospectionModule } = require('../system/introspection');
const { RealityLayer } = require('../system/reality-layer');
const { IntrospectionRouter } = require('../system/introspection-router');
const { AgentRouter } = require('../system/agent-routing');
const { MemoryGovernor } = require('../system/memory-governor');

// EXECUTIVE RING: Executive function layer (dlPFC)
const { ExecutiveCoordinator } = require('../coordinator/executive-coordinator');
const { RecursivePlanner } = require('../system/recursive-planner');
const { ArcReportGenerator } = require('../system/arc-report-generator');
const {
  GUIDED_EFFECTIVE_MODE,
  isGuidedExplorationMode,
  normalizeExecutionMode
} = require('../../../lib/execution-mode');

// Real-time event streaming - fallback singleton for CLI mode
// Multi-tenant mode uses injected eventEmitter from subsystems
let _singletonEvents = null;
function getSingletonEvents() {
  if (!_singletonEvents) {
    _singletonEvents = require('../realtime/event-emitter').cosmoEvents;
  }
  return _singletonEvents;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function summarizeText(text, maxLength = 240) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

/**
 * Phase 2B Orchestrator - GPT-5.2 Version
 * Uses GPT-5.2 Responses API with extended reasoning, web search, and tools
 */
class Orchestrator {
  constructor(config, subsystems, logger) {
    this.config = config;
    this.logger = logger;
    this.subsystems = subsystems;
    this.codingAgentsEnabled = config?.coordinator?.enableCodingAgents !== false;
    
    // Subsystems (GPT-5.2 versions)
    this.memory = subsystems.memory;
    this.roles = subsystems.roles;
    this.quantum = subsystems.quantum;
    this.stateModulator = subsystems.stateModulator;
    this.thermodynamic = subsystems.thermodynamic;
    this.chaotic = subsystems.chaotic;
    this.goals = subsystems.goals;
    this.reflection = subsystems.reflection;
    this.environment = subsystems.environment;
    this.temporal = subsystems.temporal;
    this.summarizer = subsystems.summarizer;
    this.goalCapture = subsystems.goalCapture;
    this.oscillator = subsystems.oscillator;
    this.coordinator = subsystems.coordinator;
    this.actionCoordinator = subsystems.actionCoordinator;
    this.agentExecutor = subsystems.agentExecutor;
    
    // Wire orchestrator reference to actionCoordinator (needed for agent spawning)
    if (this.actionCoordinator) {
      this.actionCoordinator.setOrchestrator(this);
    }
    this.forkSystem = subsystems.forkSystem;
    this.topicQueue = subsystems.topicQueue;
    this.goalAllocator = subsystems.goalAllocator || null;
    this.pathResolver = subsystems.pathResolver || null;
    
    // Guided plan tracking
    this.guidedPlanReady = false; // Track if guided plan has been generated
    this.planProgressEvents = []; // PLAN PROGRESS SPINE: Track phase lifecycle events
    
    // Task State Queue (UNIFIED QUEUE ARCHITECTURE - Jan 20, 2026)
    // Serializes all task state changes to eliminate race conditions
    this.taskStateQueue = null; // Initialized in initialize()
    
    // Plan Executor (Plan Authority - Jan 21, 2026)
    // Single focus: Execute the plan correctly
    this.planExecutor = null; // Initialized in initialize() after cluster state store is ready
    
    // Clustering components (optional)
    this.clusterStateStore = subsystems.clusterStateStore || null;
    this.clusterOrchestrator = subsystems.clusterOrchestrator || null;
    this.clusterCoordinator = subsystems.clusterCoordinator || null;

    // Multi-tenant event emitter (injected for context isolation)
    // Falls back to singleton for CLI/standalone mode
    this.events = subsystems.eventEmitter || null;
    this.contextId = config.contextId || null;

    // Goal Curator (initialized after loadState)
    this.goalCurator = null;
    
    // Evaluation Framework (initialized after loadState)
    this.evaluation = null;
    
    // Introspection module (self-awareness layer)
    this.introspection = null;
    
    // Reality Layer (structured evidence)
    this.realityLayer = null;
    this.currentReality = null;
    
    // Introspection Router (semantic routing)
    this.introspectionRouter = null;
    this.lastRoutingHints = null;
    
    // Agent Router (autonomous mission planning)
    this.agentRouter = null;
    this.lastRoutingSpawnCycle = 0;
    
    // Memory Governor (memory management)
    this.memoryGovernor = null;
    
    // Recursive Planner (meta-cognitive evaluation)
    this.recursivePlanner = null;
    this.recursiveState = { halted: false, haltReason: null };
    
    // EXECUTIVE RING: Executive function layer (initialized on first cycle)
    this.executiveRing = null;
    
    // State
    this.cycleCount = 0;
    this.running = false;
    this.journal = [];
    this.lastCycleTime = new Date();
    this.lastSummarization = 0;
    this.lastConsolidation = new Date();
    
    // Voice system - COSMO's channel to speak to humans
    this.voiceEnabled = config?.voice?.enabled !== false; // Default ON
    this.voiceLog = [];
    
    // Sleep session tracking (cycle-based)
    this.sleepSession = {
      active: false,
      startCycle: null,
      consolidationRun: false,
      minimumCycles: 12  // Minimum sleep cycles for proper rest (12 cycles × 5% = 60% energy recovery)
    };
    
    // GPT-5.2 specific
    this.reasoningHistory = [];
    this.webSearchCount = 0;
    this.instanceId = (process.env.INSTANCE_ID || config.instanceId || 'cosmo-1').toLowerCase();

    // Cluster sync telemetry
    this.clusterSync = {
      enabled: Boolean(config.cluster?.enabled),
      lastCycle: 0,
      lastRole: 'solo',
      lastDiffSubmitted: false,
      barrier: {
        reached: null,
        waitedMs: 0,
        decision: null,
        quorum: 0,
        readyCount: 0,
        readyInstances: []
      },
      reviewPlan: null,
      merge: null,
      proceedMs: 0,
      success: null,
      failureStreak: 0,
      lastUpdated: null
    };

    // TUI Dashboard (optional, set by src/index.js)
    this.tuiDashboard = null;

    // Persistence
    // PRODUCTION: Use logsDir from config (set to runtimeRoot by engine/src/index.js)
    // CRITICAL: config.logsDir MUST be set in multi-tenant mode
    // Server sets COSMO_RUNTIME_PATH → engine sets config.logsDir
    
    // FIX: Validate logsDir is set for multi-tenant safety
    if (!config.logsDir && !config.runtimeRoot && process.env.COSMO_RUNTIME_PATH) {
      throw new Error(
        'CRITICAL CONFIGURATION ERROR: ' +
        'COSMO_RUNTIME_PATH is set but config.logsDir was not propagated. ' +
        'Check engine/src/index.js:279 initialization. ' +
        'This indicates a multi-tenant configuration failure.'
      );
    }
    
    this.logsDir = config.logsDir || 
                   config.runtimeRoot || 
                   path.join(__dirname, '..', '..', 'runtime');

    // Branch metadata (for enhanced reasoning telemetry)
    this.latestBranchMetadata = null;
    this.lastConsistencyReviewCycle = null;
    this.currentReviewPlan = null;

    // Phase A: Hardening modules
    this.stateValidator = new StateValidator(logger);
    this.resourceMonitor = new ResourceMonitor(config, logger);
    this.crashRecovery = new CrashRecoveryManager(config, logger, this.logsDir);
    this.timeoutManager = new TimeoutManager(config, logger);
    this.telemetry = new TelemetryCollector(config, logger, this.logsDir);
    this.shutdownHandler = null; // Created after initialization
  }

  getExecutionModeInfo() {
    const explorationMode = this.config.architecture?.roleSystem?.explorationMode || 'guided';
    const requestedMode = this.config.architecture?.roleSystem?.guidedFocus?.executionMode || null;
    return normalizeExecutionMode(explorationMode, requestedMode);
  }

  isGuidedExclusiveRun() {
    return isGuidedExplorationMode(this.config.architecture?.roleSystem?.explorationMode);
  }

  getGuidedPlanner() {
    if (!this.guidedPlanner) {
      const { GuidedModePlanner } = require('./guided-mode-planner');
      this.guidedPlanner = new GuidedModePlanner(
        this.config,
        {
          ...this.subsystems,
          client: this.coordinator?.gpt5
        },
        this.logger
      );
    }

    return this.guidedPlanner;
  }

  /**
   * Get the event emitter for this orchestrator context.
   * Uses injected emitter if available (multi-tenant mode),
   * otherwise falls back to singleton (CLI/standalone mode).
   * @returns {Object} Event emitter with emitXXX methods
   */
  _getEvents() {
    if (this.events) {
      return this.events;
    }
    // Fallback to singleton for backward compatibility
    return getSingletonEvents();
  }

  /**
   * Initialize
   */
  async initialize() {
    await fs.mkdir(this.logsDir, { recursive: true });
    
    // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Initialize task state queue
    // This must happen early so all components can use it
    if (this.clusterStateStore) {
      const { TaskStateQueue } = require('../cluster/task-state-queue');
      this.taskStateQueue = new TaskStateQueue(this.logsDir, this.logger);
      await this.taskStateQueue.initialize();
      this.logger.info('✅ Task state queue initialized');
    }
    
    // Phase A: Initialize crash recovery (detect crashes)
    await this.crashRecovery.initialize();
    
    // Phase A: Attempt recovery if crash detected
    if (this.crashRecovery.crashDetected) {
      this.logger.warn('🔄 Crash detected, attempting recovery from checkpoint...');
      const recoveredState = await this.crashRecovery.recover();
      if (recoveredState) {
        this.logger.info('✅ State recovered from checkpoint');
        // Import recovered state
        this.cycleCount = recoveredState.cycleCount || 0;
        this.journal = recoveredState.journal || [];
        this.lastSummarization = recoveredState.lastSummarization || 0;

        // FIX: Import guidedMissionPlan to prevent plan recreation on restart
        if (recoveredState.guidedMissionPlan) {
          this.guidedMissionPlan = recoveredState.guidedMissionPlan.plan || recoveredState.guidedMissionPlan;
          this.logger.info('✅ Guided mission plan restored from checkpoint', {
            phaseCount: this.guidedMissionPlan?.taskPhases?.length || this.guidedMissionPlan?.phases?.length || 0
          });
        }

        // FIX: Import completionTracker to preserve progress tracking
        if (recoveredState.completionTracker) {
          this.completionTracker = recoveredState.completionTracker;
        }
      } else {
        this.logger.warn('⚠️  No checkpoint available, loading from state file');
        await this.loadState();
      }
    } else {
      await this.loadState();
    }
    
    // Phase A: Initialize telemetry
    await this.telemetry.initialize();
    this.telemetry.emitLifecycleEvent('initialized');
    
    // Initialize evaluation framework
    this.evaluation = new EvaluationFramework(
      { logsDir: this.logsDir, ...this.config },
      this.logger
    );
    await this.evaluation.initialize();
    this.logger.info('✅ Evaluation framework initialized');

    // Connect evaluation framework to goals system
    if (this.goals && this.goals.setEvaluationFramework) {
      this.goals.setEvaluationFramework(this.evaluation);
    }

    // Initialize goal curator after state is loaded
    this.goalCurator = new GoalCurator(
      this.goals,
      this.memory,
      this.logger,
      this.config.architecture?.goals?.curator || {},
      this.evaluation // Pass evaluation framework
    );
    
    // Initialize and configure agent executor
    if (this.agentExecutor) {
      this.agentExecutor.setEvaluationFramework(this.evaluation);
      await this.agentExecutor.initialize();
      
      // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Pass task state queue to AgentExecutor
      // This allows artifact registration to enqueue updates instead of direct writes
      if (this.taskStateQueue && this.agentExecutor.clusterStateStore) {
        this.agentExecutor.taskStateQueue = this.taskStateQueue;
        this.logger.info('✅ Task state queue wired to AgentExecutor');
      }
      
      this.logger.info('✅ Agent Executor initialized');
    }
    
    // Initialize Plan Executor (Plan Authority - Jan 21, 2026)
    // THE single authority for plan execution
    // Uses taskId-based agent correlation (not goalId)
    if (this.clusterStateStore && this.agentExecutor) {
      this.planExecutor = new PlanExecutor(
        this.clusterStateStore,
        this.agentExecutor,
        this.logger,
        {
          pathResolver: this.pathResolver,
          taskStateQueue: this.taskStateQueue,
          recordPlanEvent: (type, details) => this.recordPlanEvent(type, details),
          maxRetries: this.config.planning?.maxRetries || 3,
          agentTimeout: this.config.planning?.agentTimeout || 720000
        }
      );
      this.logger.info('✅ Plan Executor initialized (Plan Authority)', {
        maxRetries: this.config.planning?.maxRetries || 3,
        agentTimeout: (this.config.planning?.agentTimeout || 720000) / 1000 + 's'
      });
    }
    
    // Wire up curator callback for goal events
    this.goals.setCuratorCallback(async (event) => {
      if (this.goalCurator) {
        await this.goalCurator.handleEvent(event);
      }
    });
    
    // Initialize introspection module (self-awareness layer)
    this.introspection = new IntrospectionModule(
      this.config,
      this.logger,
      this.memory,
      this.pathResolver
    );
    await this.introspection.initialize(this.logsDir);
    this.logger.info('✅ Introspection module initialized', {
      enabled: this.config.introspection?.enabled || false
    });
    
    // NEW: Initialize Executive Ring (middle ring)
    if (this.config.executiveRing?.enabled !== false) {
      this.executiveRing = new ExecutiveCoordinator(this.config, this.logger, this);
      if (this.guidedPlan) {
        await this.executiveRing.initialize(this.guidedPlan);
      }
      this.logger.info('🧠 Executive Ring initialized');
      
      // NEW: Initialize Capabilities (motor cortex) after ExecutiveRing
      if (this.config.capabilities?.enabled !== false) {
        const { Capabilities } = require('./capabilities');
        this.capabilities = new Capabilities(
          this.config,
          this.logger,
          this.executiveRing,
          this.agentExecutor.frontierGate,
          this.pathResolver
        );
        
        // Inject into AgentExecutor so agents receive it
        this.agentExecutor.capabilities = this.capabilities;
        
        this.logger.info('✅ Capabilities initialized with Executive Ring', {
          enabled: this.capabilities.enabled,
          executiveGating: this.config.capabilities?.executiveGating !== false,
          frontierMode: this.config.capabilities?.defaultMode || 'observe'
        });
      } else {
        this.capabilities = null;
        this.agentExecutor.capabilities = null;
        this.logger.info('⊘ Capabilities disabled (using legacy execution patterns)');
      }
    } else {
      this.executiveRing = null;
      this.capabilities = null;
      this.agentExecutor.capabilities = null;
      this.logger.info('⊘ Executive Ring disabled');
    }

    // Document feeder — ingestion pipeline
    if (this.config.feeder?.enabled !== false) {
      try {
        const { DocumentFeeder } = require('../ingestion/document-feeder');
        this.feeder = new DocumentFeeder({
          memory: this.memory,
          config: this.config.feeder || {},
          logger: this.logger,
          embeddingFn: (text) => this.memory.embed(text)
        });
        await this.feeder.start(this.logsDir);
        this.logger.info('Document feeder initialized');
      } catch (err) {
        this.logger.warn('Document feeder initialization failed (non-fatal)', { error: err.message });
        this.feeder = null;
      }
    } else {
      this.feeder = null;
    }

    // Initialize execution architecture
    const { ToolRegistry } = require('../execution/tool-registry');
    const { SkillRegistry } = require('../execution/skill-registry');
    const { PluginRegistry } = require('../execution/plugin-registry');
    const { EnvironmentProvisioner } = require('../execution/environment-provisioner');
    const { ExecutionMonitor } = require('../execution/execution-monitor');
    const { CampaignMemory } = require('../execution/campaign-memory');

    const configDir = process.env.COSMO23_HOME || require('path').join(require('os').homedir(), '.cosmo2.3');

    this.toolRegistry = new ToolRegistry({
      cachePath: require('path').join(configDir, 'tool-registry.json'),
      extraBinaries: this.config.execution?.extraBinaries || []
    }, this.logger);

    this.skillRegistry = new SkillRegistry({
      shippedSkillsDir: require('path').join(__dirname, '..', 'execution', 'skills'),
      userSkillsDir: require('path').join(configDir, 'skills'),
      learnedSkillsDir: require('path').join(configDir, 'skills', 'learned'),
      learnEnabled: this.config.execution?.skills?.learnEnabled !== false
    }, this.logger, this.toolRegistry);

    this.pluginRegistry = new PluginRegistry({
      shippedPluginsDir: require('path').join(__dirname, '..', 'execution', 'plugins'),
      userPluginsDir: require('path').join(configDir, 'plugins'),
      generatedPluginsDir: require('path').join(configDir, 'plugins', 'generated')
    }, this.logger, this.toolRegistry, this.skillRegistry);

    this.environmentProvisioner = new EnvironmentProvisioner({
      dockerEnabled: this.config.execution?.provisioning?.dockerEnabled !== false,
      baseWorkDir: this.config.logsDir ? require('path').join(this.config.logsDir, 'environments') : null
    }, this.logger, this.toolRegistry);

    this.executionMonitor = new ExecutionMonitor(
      this.config, this.logger, this.toolRegistry, this.environmentProvisioner
    );

    this.campaignMemory = new CampaignMemory({
      campaignMemory: this.config.execution?.campaignMemory
    }, this.logger);

    // Discovery + loading (non-blocking, log results)
    Promise.all([
      this.toolRegistry.discover(),
      this.skillRegistry.loadAll(),
      this.pluginRegistry.loadAll(),
      this.campaignMemory.load()
    ]).then(() => {
      this.logger.info('✅ Execution architecture initialized', {
        tools: this.toolRegistry.size,
        skills: this.skillRegistry.size,
        plugins: this.pluginRegistry.size
      });
    }).catch(err => {
      this.logger.error('Execution architecture init error:', err.message);
    });

    // Inject into AgentExecutor
    this.agentExecutor.toolRegistry = this.toolRegistry;
    this.agentExecutor.skillRegistry = this.skillRegistry;
    this.agentExecutor.pluginRegistry = this.pluginRegistry;
    this.agentExecutor.executionMonitor = this.executionMonitor;
    this.agentExecutor.campaignMemory = this.campaignMemory;

    // Initialize reality layer (structured evidence)
    const runRoot = this.logsDir;
    this.realityLayer = new RealityLayer(
      this.config,
      this.logger,
      this.memory,
      runRoot
    );
    
    // Initialize introspection router (semantic routing)
    this.introspectionRouter = new IntrospectionRouter(
      this.config,
      this.logger
    );
    
    // Initialize agent router (autonomous mission planning)
    this.agentRouter = new AgentRouter(
      this.config,
      this.logger
    );
    
    // Initialize memory governor (memory management)
    this.memoryGovernor = new MemoryGovernor(
      this.config,
      this.logger,
      this.memory
    );
    
    // Initialize recursive planner (meta-cognitive evaluation)
    this.recursivePlanner = new RecursivePlanner(
      this.config,
      this.logger
    );
    
    this.logger.info('✅ Reality Layer, Router, AgentRouter, MemoryGovernor & RecursivePlanner initialized');
    
    // Initialize Action Coordinator context providers
    if (this.actionCoordinator) {
      const {
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
      } = require('../coordinator/context-providers');
      
      this.actionCoordinator.initializeContextProviders({
        goals: new GoalsContextProvider(this.goals),
        memory: new MemoryContextProvider(this.memory),
        plans: new PlansContextProvider(this),
        thoughts: new ThoughtsContextProvider(this),
        surprises: new SurprisesContextProvider(this),
        agents: new AgentsContextProvider(this.agentExecutor),
        artifacts: new ArtifactsContextProvider(this.memory, this.agentExecutor),
        voice: new VoiceContextProvider(this),
        executive: new ExecutiveContextProvider(this),
        pgs: new PGSContextProvider(this, this.logger)
      });
      
      this.logger.info('✅ Action Coordinator context providers initialized');
    }
    
    this.logger.info('╔═══════════════════════════════════════════════════╗');
    this.logger.info('║   Phase 2B GPT-5.2 System Initialized           ║');
    this.logger.info('╚═══════════════════════════════════════════════════╝');
    this.logger.info('');
    this.logger.info('GPT-5.2 Features Active:');
    this.logger.info('  • Extended Reasoning (see AI thinking process)');
    this.logger.info('  • Web Search (curiosity role + quantum branches)');
    this.logger.info('  • Optimized Models (gpt-5, gpt-5-mini, gpt-5-nano)');
    this.logger.info('  • Responses API (modern format)');
    this.logger.info('');
    this.logger.info('Components:', {
      roles: this.roles.getRoles().length,
      memory: this.memory.nodes.size,
      goals: this.goals.getGoals().length,
      oscillatorMode: this.oscillator.getCurrentMode(),
      forkingEnabled: Boolean(this.forkSystem),
      topicQueueEnabled: Boolean(this.topicQueue)
    });
    
    // Phase A: Initialize graceful shutdown handler
    this.shutdownHandler = new GracefulShutdownHandler(this, this.logger, this.config);
    this.shutdownHandler.registerHandlers();
    this.logger.info('✅ Graceful shutdown handlers registered');

    // Ensure Capabilities cleanup runs under orchestrator-controlled shutdown
    // (and does not preempt the agent wait loop).
    if (this.capabilities && typeof this.capabilities.cleanup === 'function') {
      this.shutdownHandler.registerCleanupTask('capabilities', async () => {
        await this.capabilities.cleanup();
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSOLIDATION MODE: Force immediate sleep state on ALL systems
    // This MUST happen LAST in initialize() - all systems already constructed
    // ═══════════════════════════════════════════════════════════════════════════
    const consolidationModeInit = this.config.execution?.consolidationMode === true || 
                                   this.config.execution?.consolidationMode === 'true';
    if (consolidationModeInit) {
      this.logger.info('');
      this.logger.info('╔═══════════════════════════════════════════════════════════════╗');
      this.logger.info('║   🛌 CONSOLIDATION MODE - FORCING IMMEDIATE SLEEP STATE       ║');
      this.logger.info('╚═══════════════════════════════════════════════════════════════╝');
      this.logger.info('');
      
      // Force temporal system into sleep
      if (this.temporal) {
        this.temporal.state = 'sleeping';
        this.temporal.lastSleepStart = new Date();
        this.temporal.fatigue = 0; // Reset fatigue
        this.logger.info('  ✓ Temporal system: SLEEP');
      }
      
      // Force cognitive state into sleeping mode
      if (this.stateModulator) {
        this.stateModulator.state.mode = 'sleeping';
        this.stateModulator.state.energy = 0.1; // Low energy keeps it asleep
        this.stateModulator.state.curiosity = 0; // No curiosity in consolidation
        this.stateModulator.state.mood = 0.5; // Neutral mood
        this.logger.info('  ✓ Cognitive state: SLEEPING (energy=0.1, curiosity=0)');
      }
      
      // Force oscillator to exploration mode (no agent spawning)
      if (this.oscillator) {
        this.oscillator.mode = 'explore'; // Direct set - not executing, not spawning
        this.oscillator.executionCyclesRemaining = 0;
        this.logger.info('  ✓ Oscillator: EXPLORE (no execution mode)');
      }
      
      // Initialize sleep session as active
      this.sleepSession = {
        active: true,
        startCycle: 0,
        consolidationRun: false, // Will run consolidation every cycle
        minimumCycles: 999999 // Never wake from minimum cycle count
      };
      this.logger.info('  ✓ Sleep session: ACTIVE (perpetual)');
      
      // Disable coordinator (no agent reviews)
      if (this.coordinator) {
        this.coordinator.enabled = false;
        this.logger.info('  ✓ Coordinator: DISABLED');
      }
      
      this.logger.info('');
      this.logger.info('All systems locked to sleep state. Only consolidation will run.');
      this.logger.info('');
    }
  }

  /**
   * Start cognitive loop
   */
  async start() {
    this.running = true;
    this.runStartTime = Date.now(); // Track when this run started

    // Start high-frequency poller for immediate actions (runs independently of cycle loop)
    // This allows user-injected actions to execute within ~500ms instead of waiting for next cycle
    this.startImmediateActionPoller();

    // Start Guardian control file poller (checks for wake/restart/consolidate commands)
    // Guardian writes these files when it detects COSMO is stuck or needs intervention
    this.startGuardianControlPoller();

    // Log maxCycles and maxRuntime configuration for debugging
    const maxCyclesConfig = this.config.execution?.maxCycles;
    const maxRuntimeConfig = this.config.execution?.maxRuntimeMinutes;
    this.logger.info(`🚀 Starting GPT-5.2 cognitive loop... (maxCycles: ${maxCyclesConfig || 'unlimited'}, maxRuntime: ${maxRuntimeConfig ? maxRuntimeConfig + ' min' : 'unlimited'})`);
    
    while (this.running) {
      // Check recursive planner halt condition
      if (this.recursiveState && this.recursiveState.halted) {
        this.logger.info('🧠 RecursiveMode: stopping due to planner decision', {
          reason: this.recursiveState.haltReason,
          cycle: this.cycleCount
        });
        break;
      }
      
      // Optional: Halt when no active goals remain
      // SAFETY: Multiple guards prevent premature halt (forks, new runs, guided mode)
      if (this.config.recursiveMode?.haltOnGoalExhaustion && this.goals) {
        const minCyclesBeforeGoalCheck = this.config.recursiveMode?.minCyclesBeforeGoalExhaustion || 20;
        
        // Guard 1: Minimum cycles elapsed (warmup period)
        if (this.cycleCount >= minCyclesBeforeGoalCheck) {
          
          // Guard 2: Don't halt if plan is still executing
          let planActive = false;
          if (this.clusterStateStore) {
            try {
              const mainPlan = await this.clusterStateStore.getPlan('plan:main');
              planActive = mainPlan && mainPlan.status === 'ACTIVE';
            } catch (e) {
              // Plan check failed or doesn't exist - not active
            }
          }
          
          // Guard 3: Don't halt if agents are still working
          const activeAgents = this.agentExecutor ? this.agentExecutor.registry.getActiveCount() : 0;
          
          // Guard 4: Don't halt while guided execution still owns the run.
          const isGuidedRun = this.isGuidedExclusiveRun();
          
          // Check actual goal count
          const activeGoals = this.goals.getGoals().filter(g => g.status === 'active');
          
          // Only halt if ALL conditions met:
          // - No active goals AND
          // - No active plan AND
          // - No active agents AND
          // - Not in guided strict mode
          const shouldHalt = (
            activeGoals.length === 0 &&
            !planActive &&
            activeAgents === 0 &&
            !isGuidedRun
          );
          
          if (shouldHalt) {
            this.logger.info('🎯 No active goals remain - halting gracefully', {
              cycle: this.cycleCount,
              completedGoals: this.goals.completedGoals?.length || 0,
              checks: { planActive, activeAgents, isGuidedRun }
            });
            this.recursiveState.halted = true;
            this.recursiveState.haltReason = 'goal_exhaustion';
            break;
          } else if (activeGoals.length === 0) {
            // Log why we're NOT halting (for debugging)
            this.logger.debug('Goal exhaustion: not halting yet', {
              cycle: this.cycleCount,
              activeGoals: 0,
              planActive,
              activeAgents,
              isGuidedRun
            });
          }
        }
      }
      
      // Check if paused by TUI dashboard, web dashboard, or pause file
      const pauseFile = path.join(this.logsDir, '.pause_requested');
      const fs = require('fs');
      const isPausedByFile = fs.existsSync(pauseFile);
      
      if ((this.tuiDashboard && this.tuiDashboard.isPausedState()) || this.webPaused || isPausedByFile) {
        await this.sleep(1000); // Check every second
        continue;
      }
      
      await this.executeCycle();
      const cycleForSync = this.cycleCount;
      await this.handleClusterCycleSync(cycleForSync);
      
      // Check maxCycles limit (if configured)
      const maxCyclesRaw = this.config.execution?.maxCycles;
      const maxCycles = maxCyclesRaw ? parseInt(maxCyclesRaw, 10) : null;
      if (maxCycles && maxCycles > 0 && this.cycleCount >= maxCycles) {
        this.logger.info('');
        this.logger.info(`🏁 Reached maxCycles limit (${maxCycles})`);
        this.logger.info(`   Total cycles completed: ${this.cycleCount}`);

        // Emit status event
        this._getEvents().emitRunStatus({
          status: 'limit_reached',
          message: `Reached maxCycles limit (${maxCycles})`,
          cycle: this.cycleCount,
          details: { maxCycles, reason: 'max_cycles' }
        });

        this.logger.info('   Waiting for agents to complete...');

        // Wait for any running agents to finish (max 5 minutes)
        const maxWait = 300000; // 5 minutes
        const startWait = Date.now();
        let activeAgents = this.agentExecutor ? this.agentExecutor.registry.getActiveCount() : 0;
        while (activeAgents > 0) {
          this._getEvents().emitRunStatus({
            status: 'waiting_agents',
            message: `Waiting for ${activeAgents} agents to complete...`,
            cycle: this.cycleCount,
            details: { activeAgents }
          });

          if (Date.now() - startWait > maxWait) {
            this.logger.warn('⚠️  Max wait reached, forcing shutdown');
            this._getEvents().emitRunStatus({
              status: 'forcing_shutdown',
              message: 'Max wait reached, forcing shutdown',
              cycle: this.cycleCount
            });
            break;
          }
          this.logger.info(`   Waiting for ${activeAgents} agents...`);
          await this.sleep(5000); // Check every 5 seconds
          activeAgents = this.agentExecutor ? this.agentExecutor.registry.getActiveCount() : 0;
        }

        this.logger.info('   Stopping gracefully...');
        this.logger.info('');

        // Emit completion event
        const runtime = this.runStartTime ? (Date.now() - this.runStartTime) / 1000 : 0;
        this._getEvents().emitResearchComplete({
          reason: 'max_cycles',
          totalCycles: this.cycleCount,
          runtime
        });

        // Actually stop and exit
        await this.stop();
        this.logger.info('✅ System stopped successfully');
        process.exit(0);
      }

      // Check maxRuntimeMinutes limit (if configured)
      const maxRuntimeRaw = this.config.execution?.maxRuntimeMinutes;
      const maxRuntimeMinutes = maxRuntimeRaw ? parseInt(maxRuntimeRaw, 10) : null;
      if (maxRuntimeMinutes && maxRuntimeMinutes > 0) {
        const elapsedMinutes = (Date.now() - this.runStartTime) / (1000 * 60);
        if (elapsedMinutes >= maxRuntimeMinutes) {
          this.logger.info('');
          this.logger.info(`⏱️  Reached maxRuntime limit (${maxRuntimeMinutes} minutes)`);
          this.logger.info(`   Total cycles completed: ${this.cycleCount}`);
          this.logger.info(`   Actual runtime: ${elapsedMinutes.toFixed(1)} minutes`);

          // Emit status event
          this._getEvents().emitRunStatus({
            status: 'limit_reached',
            message: `Reached maxRuntime limit (${maxRuntimeMinutes} minutes)`,
            cycle: this.cycleCount,
            details: { maxRuntimeMinutes, elapsedMinutes: elapsedMinutes.toFixed(1), reason: 'max_runtime' }
          });

          this.logger.info('   Waiting for agents to complete...');

          // Wait for any running agents to finish (max 5 minutes)
          const maxWait = 300000; // 5 minutes
          const startWait = Date.now();
          let activeAgents = this.agentExecutor ? this.agentExecutor.registry.getActiveCount() : 0;
          while (activeAgents > 0) {
            this._getEvents().emitRunStatus({
              status: 'waiting_agents',
              message: `Waiting for ${activeAgents} agents to complete...`,
              cycle: this.cycleCount,
              details: { activeAgents }
            });

            if (Date.now() - startWait > maxWait) {
              this.logger.warn('⚠️  Max wait reached, forcing shutdown');
              this._getEvents().emitRunStatus({
                status: 'forcing_shutdown',
                message: 'Max wait reached, forcing shutdown',
                cycle: this.cycleCount
              });
              break;
            }
            this.logger.info(`   Waiting for ${activeAgents} agents...`);
            await this.sleep(5000); // Check every 5 seconds
            activeAgents = this.agentExecutor ? this.agentExecutor.registry.getActiveCount() : 0;
          }

          this.logger.info('   Stopping gracefully...');
          this.logger.info('');

          // Emit completion event
          this._getEvents().emitResearchComplete({
            reason: 'max_runtime',
            totalCycles: this.cycleCount,
            runtime: elapsedMinutes * 60  // Convert to seconds
          });

          // Actually stop and exit
          await this.stop();
          this.logger.info('✅ System stopped successfully (runtime limit reached)');
          process.exit(0);
        }
      }

      const interval = this.calculateNextInterval();
      this.logger.info(`💤 Sleeping for ${(interval/1000).toFixed(1)}s before next cycle...`);
      await this.sleep(interval);
    }
    
    // Arc closure: Generate deterministic manifest and arc report
    if (this.config.substrate?.enabled && (this.recursiveState?.halted || !this.running)) {
      this.logger.info('');
      this.logger.info('🧪 Arc closure: generating deterministic verification');
      
      try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        
        const runRoot = this.logsDir;
        const python = this.config.pythonBin || 'python3';
        const engineRoot = path.resolve(__dirname, '..', '..');

        this.logger.info('   Building manifest...');
        await execFileAsync(python, [path.join(engineRoot, 'tools', 'manifest_builder.py'), runRoot]);

        this.logger.info('   Validating integrity...');
        await execFileAsync(python, [path.join(engineRoot, 'tools', 'validate.py'), runRoot]);
        
        this.logger.info('✅ Arc verification complete');
        
        // Generate comprehensive arc report
        this.logger.info('   Generating arc report...');
        const arcReportGenerator = new ArcReportGenerator(this.config, this.logger, this.capabilities);
        
        const arcData = await this.gatherArcData(runRoot);
        const { reportPath } = await arcReportGenerator.generateReport(arcData);
        
        this.logger.info('✅ Arc report generated', { path: reportPath });
        
      } catch (err) {
        this.logger.warn('⚠️  Arc closure failed (non-fatal)', {
          error: err.message
        });
      }
    }
  }

  /**
   * Execute one cognitive cycle with GPT-5
   */
  async executeCycle() {
    const cycleStart = new Date();
    this.cycleCount++;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSOLIDATION MODE CHECK - MUST BE FIRST
    // Skip ALL normal processing - go straight to sleep consolidation
    // ═══════════════════════════════════════════════════════════════════════════
    const consolidationModeEnabled = this.config.execution?.consolidationMode === true || 
                                      this.config.execution?.consolidationMode === 'true';
    if (consolidationModeEnabled) {
      this.logger.info(`\n═══ Consolidation Cycle ${this.cycleCount} [SLEEP] ═══`);
      
      // Emit minimal cycle event for dashboard tracking
      this._getEvents().emitCycleStart({
        cycle: this.cycleCount,
        mode: 'consolidation',
        cognitiveState: { mode: 'sleeping', energy: 0.1 }
      });
      
      try {
        // Run ONLY consolidation - nothing else
        this.logger.info('🛌 Running deep sleep consolidation...');
        const consolidationResult = await this.performDeepSleepConsolidation();
        
        if (consolidationResult.consolidated) {
          this.logger.info('✅ Consolidation cycle complete', {
            cycle: this.cycleCount,
            duration: Date.now() - cycleStart.getTime() + 'ms'
          });
        } else if (consolidationResult.deferred) {
          this.logger.info('⏭️  Consolidation deferred (rate limited)', {
            reason: consolidationResult.reason,
            nextAvailableIn: consolidationResult.nextAvailableIn
          });
        }
        
        // Save state after each consolidation
        await this.saveState();
        
        // Emit cycle complete event
        this._getEvents().emitCycleComplete({
          cycle: this.cycleCount,
          duration: Date.now() - cycleStart.getTime(),
          mode: 'consolidation'
        });
        
      } catch (error) {
        this.logger.error('Consolidation cycle failed', { 
          error: error.message,
          stack: error.stack 
        });
      }
      
      // RETURN - skip ALL normal cycle processing
      return;
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // END CONSOLIDATION MODE - Normal cycle continues below
    // ═══════════════════════════════════════════════════════════════════════════

    // Cluster diff tracking reset (no-op when clustering disabled)
    try {
      if (this.memory?.startCycleTracking) {
        this.memory.startCycleTracking();
      }
    } catch (error) {
      this.logger.error('[ClusterSync] Failed to start cycle tracking', {
        error: error.message
      });
    }

    this.logger.info(`\n═══ Cycle ${this.cycleCount} [${this.oscillator.getCurrentMode().toUpperCase()}] [GPT-5.2] ═══`);
    
    // Phase A: Start cycle timeout (default 60s, configurable)
    const cycleTimeout = this.config.timeouts?.cycleTimeoutMs || 60000;
    this.timeoutManager.startCycleTimer(this.cycleCount, cycleTimeout);
    
    // Update TUI dashboard if active
    if (this.tuiDashboard) {
      this.tuiDashboard.updateCycle({
        cycle: this.cycleCount,
        oscillatorMode: this.oscillator.getCurrentMode(),
        cognitiveState: this.stateModulator.getState()
      });
    }

    // Emit real-time cycle start event
    this._getEvents().emitCycleStart({
      cycle: this.cycleCount,
      mode: this.oscillator.getCurrentMode(),
      cognitiveState: this.stateModulator.getState()
    });

    try {
      // 0. Poll topic queue for new user-injected topics
      if (this.topicQueue && this.cycleCount % 3 === 0) {
        const newTopics = await this.topicQueue.pollQueue();
        if (newTopics > 0) {
          // Activate pending topics if we have capacity
          await this.topicQueue.activateNextTopic();
        }
        
        // Update active topics (check for completion)
        await this.topicQueue.updateActiveTopics();
      }
      
      // 0b. Poll action queue for MCP-injected actions
      // Check for immediate actions every cycle, regular actions every 2 cycles
      const hasImmediateActions = await this.hasImmediateActions();
      if (hasImmediateActions || this.cycleCount % 2 === 0) {
        await this.pollActionQueue(hasImmediateActions);
      }

      // 1. Update temporal rhythms
      const rhythmState = this.temporal.getState();
      this.temporal.update(
        this.stateModulator.getState().energy,
        this.cycleCount
      );

      this.oscillator.update();

      if (this.temporal.shouldWake()) {
        this.temporal.wake();
        this.stateModulator.restoreEnergy(0.8);
      }

      // Process completed agent results FIRST (before coordinator review)
      // This ensures coordinator sees up-to-date goal progress and completed work
      // Skip in dream mode (no agents should be running)
      if (this.agentExecutor && !this.config.execution?.dreamMode) {
        const processed = await this.agentExecutor.processCompletedResults();
        
        // EXECUTIVE RING: Record completed agents for pattern detection
        // Check each completed agent's accomplishment and update coherence
        if (this.executiveRing && processed.results && processed.results.length > 0) {
          for (const agentResult of processed.results) {
            const postCheck = await this.executiveRing.recordAgentCompletion(agentResult, {
              cycleCount: this.cycleCount
            });
            
            // Check for coherence crisis
            if (postCheck.escalate) {
              this.logger.error('🚨 Coherence crisis detected by executive', {
                reason: postCheck.reason,
                coherence: this.executiveRing.getCoherenceScore().toFixed(2)
              });
              
              // Trigger emergency review immediately
              if (this.coordinator) {
                await this.coordinator.emergencyReview({
                  trigger: 'coherence_crisis',
                  reason: postCheck.reason,
                  coherenceScore: this.executiveRing.getCoherenceScore(),
                  cycleCount: this.cycleCount
                });
              }
            }
          }
        }
        
        // Process handoff requests to spawn child agents
        if (this.agentExecutor.messageQueue) {
          await this.processAgentHandoffRequests();
        }
      }
      
      // ═══════════════════════════════════════════════════════════════
      // PLAN EXECUTOR (Rebuilt Jan 21, 2026): THE Plan Authority
      // Uses taskId-based agent correlation (not goalId)
      // Handles ALL plan execution: phases, tasks, agents, validation
      // The old orchestrator plan code is now GUARDED (skipped when plan active)
      // ═══════════════════════════════════════════════════════════════
      let planExecutorHandled = false;
      if (this.planExecutor) {
        const planAction = await this.planExecutor.tick(this.cycleCount);
        
        // If there's an active plan, PlanExecutor is THE authority
        planExecutorHandled = planAction.action !== 'NO_PLAN';
        
        // Log significant plan actions
        if (planAction.action !== 'NO_PLAN' && planAction.action !== 'ON_TRACK') {
          this.logger.info(`📋 PlanExecutor: ${planAction.action}`, {
            phase: planAction.phase,
            task: planAction.title || planAction.task,
            taskId: planAction.taskId,
            agent: planAction.agent || planAction.agentId,
            progress: planAction.progress || planAction.planProgress
          });
        }

        // FIX (Jan 21, 2026): Trigger auto-next plan generation when plan completes
        // PlanExecutor.completePlan() returns PLAN_COMPLETED but wasn't triggering
        // handlePlanCompletion() which queues the auto-next plan
        // FIX (Jan 25, 2026): Added fallback and better diagnostics for missing clusterStateStore
        if (planAction.action === 'PLAN_COMPLETED') {
          let completedPlan = await this.clusterStateStore?.getPlan('plan:main');

          // Fallback: try getting plan from planExecutor directly
          if (!completedPlan && this.planExecutor?.plan) {
            completedPlan = this.planExecutor.plan;
            this.logger.info('📋 Using plan from planExecutor (clusterStateStore fallback)');
          }

          if (completedPlan) {
            this.logger.info('🎯 Plan completed - triggering auto-next plan generation');
            await this.handlePlanCompletion(completedPlan);
          } else {
            // Log detailed diagnostics instead of silent failure
            this.logger.warn('⚠️  PLAN_COMPLETED detected but could not retrieve plan', {
              hasClusterStateStore: !!this.clusterStateStore,
              hasPlanExecutor: !!this.planExecutor,
              hasPlanExecutorPlan: !!this.planExecutor?.plan,
              planActionDetails: planAction
            });
            // Emit event for Guardian to catch
            this._getEvents().emitEvent('plan_completion_retrieval_failed', {
              hasClusterStateStore: !!this.clusterStateStore,
              hasPlanExecutor: !!this.planExecutor,
              cycle: this.cycleCount
            });
          }
        }
      }
      
      // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Process task state queue
      // This runs AFTER agent results are integrated, so all task state changes
      // (from agent artifact registration AND from orchestrator validation) are
      // processed serially, eliminating race conditions
      if (this.taskStateQueue && this.clusterStateStore) {
        const taskQueueResult = await this.taskStateQueue.processAll(this.clusterStateStore, this);
        if (taskQueueResult.processed > 0) {
          this.logger.debug('✅ Task state queue processed', { events: taskQueueResult.processed });
        }
      }
      
      // Introspection pass (system-level self-awareness)
      // Run every 3 cycles to integrate agent outputs into memory
      if (this.introspection && 
          this.config.introspection?.enabled &&
          this.cycleCount % 3 === 0) {
        const files = await this.introspection.scan();
        if (files.length > 0) {
          const nodes = await this.introspection.integrate(files);
          this.logger.info(`🔍 Introspection: integrated ${nodes.length} outputs into memory`, 3);
          
          // Update reality layer with introspection results
          if (this.realityLayer) {
            await this.realityLayer.updateFromIntrospection(files);
            this.currentReality = await this.realityLayer.buildSnapshot();
          }
          
          // Generate routing hints
          if (this.introspectionRouter && this.introspectionRouter.enabled) {
            const scored = await this.introspectionRouter.score(files);
            this.lastRoutingHints = this.introspectionRouter.buildHints(scored);
            
            // Build follow-up missions from routing hints
            if (this.agentRouter && this.agentRouter.enabled && this.lastRoutingHints) {
              const missions = this.agentRouter.buildMissionsFromHints(this.lastRoutingHints);
              
              // Guided execution is exclusive; routing hints may inform context but not autonomous spawns.
              const isGuidedRun = this.isGuidedExclusiveRun();
              
              // Auto-spawn if enabled, cooldown satisfied, AND not in strict mode
              const cooldown = this.config.agentRouting?.spawnCooldownCycles || 5;
              const canSpawn = (this.cycleCount - this.lastRoutingSpawnCycle) >= cooldown;
              
              if (this.config.agentRouting?.autoSpawn && canSpawn && missions.length > 0 && this.agentExecutor && !isGuidedRun) {
                for (const mission of missions) {
                  try {
                    const agentId = await this.agentExecutor.spawnAgent(mission);
                    if (agentId) {
                      this.logger.info(`🛰 Auto-spawned ${mission.agentType} from routing`, {
                        agentId,
                        reason: mission.spawningReason
                      }, 3);
                    }
                  } catch (error) {
                    this.logger.warn('Routing auto-spawn failed', {
                      agentType: mission.agentType,
                      error: error.message
                    });
                  }
                }
                this.lastRoutingSpawnCycle = this.cycleCount;
              } else if (missions.length > 0) {
                const skipReason = isGuidedRun ? 'guided-exclusive mode' : 
                                  !this.config.agentRouting?.autoSpawn ? 'disabled' : 'cooldown';
                this.logger.info(`🛰 Routing: planned ${missions.length} missions (auto-spawn: ${skipReason})`, 3);
              }
            }
          }
        }
      }
      
      // Memory Governance evaluation (every 20 cycles)
      if (this.memoryGovernor && this.config.memoryGovernance?.enabled && this.cycleCount % 20 === 0) {
        const evaluation = this.memoryGovernor.evaluate(this.cycleCount);
        if (evaluation.pruneCandidates.length > 0) {
          this.logger.info(`🧹 MemoryGovernor: ${evaluation.pruneCandidates.length} candidates (advisory only)`, 3);
        }
      }

      // STRATEGIC GOALS TRACKING - Monitor urgent goals each cycle
      if (this.coordinator?.strategicTracker) {
        this.coordinator.strategicTracker.setCurrentCycle(this.cycleCount);
        
        // Get active agents from registry
        const activeAgents = this.agentExecutor?.registry?.getActiveAgents() || [];
        
        const updates = this.coordinator.strategicTracker.checkProgress(
          this.cycleCount,
          this.goals,
          activeAgents
        );
        
        // ESCALATE ignored strategic goals
        if (updates.needsEscalation.length > 0) {
          const escalated = this.coordinator.strategicTracker.escalateIgnoredGoals(updates, this.goals);
          if (escalated.length > 0) {
            this.logger.warn(`🚨 Escalated ${escalated.length} ignored strategic goals - boosted priorities`);
          }
        }
      }
      
      // Meta-Coordinator strategic review (check before sleep to avoid skipping)
      if (this.coordinator && this.coordinator.enabled && this.coordinator.shouldRunReview(this.cycleCount)) {
        await this.runMetaCoordinatorReview();
        
        // Recursive planning evaluation (meta-cognitive loop)
        if (this.recursivePlanner && this.config.recursiveMode?.enabled) {
          const snapshot = this.currentReality || null;
          const hints = this.lastRoutingHints || null;
          
          const decision = this.recursivePlanner.evaluate(
            snapshot,
            hints,
            this.cycleCount
          );
          
          if (!decision.continue) {
            this.recursiveState.halted = true;
            this.recursiveState.haltReason = decision.haltReason || 'planner_halt';
            this.logger.info('🧠 RecursiveMode: halt triggered', {
              reason: this.recursiveState.haltReason,
              iterations: this.recursivePlanner.state.metaIterations
            }, 2);
          }
          
          if (decision.newHighLevelGoals && decision.newHighLevelGoals.length > 0) {
            this.logger.info('🧠 RecursiveMode: adding high-level goals to system', {
              count: decision.newHighLevelGoals.length
            }, 3);
            
            // Feed goals into existing IntrinsicGoalSystem
            decision.newHighLevelGoals.forEach(desc => {
              const newGoal = this.goals.addGoal({
                description: desc,
                source: 'recursive_planner',
                uncertainty: 0.8,  // High priority in COSMO's uncertainty model
                metadata: {
                  fromRecursivePlanning: true,
                  metaIteration: this.recursivePlanner.state.metaIterations,
                  basedOnReality: Boolean(this.currentReality)
                }
              });
              
              if (newGoal) {
                this.logger.info('🎯 Recursive goal added', {
                  goalId: newGoal.id,
                  description: desc.substring(0, 60)
                }, 3);
              }
            });
          }
        }
      }
      
      // Emergency coordinator review when system is TRULY stuck
      // Only triggers if idle for significant time (not normal between agent spawns)
      if (this.coordinator && this.coordinator.enabled && !this.coordinator.shouldRunReview(this.cycleCount)) {
        const totalGoals = this.goals.getGoals().length;
        const activeAgents = this.agentExecutor?.registry?.getActiveCount() || 0;
        const cyclesSinceLastReview = this.cycleCount - this.coordinator.lastReviewCycle;
        
        // CRITICAL: Only trigger if TRULY stuck (10+ idle cycles, not just 2)
        // System needs time to spawn agents, complete work, etc.
        // 2 cycles was too aggressive - caused reviews every 2 cycles
        const EMERGENCY_THRESHOLD = 10; // Truly stuck, not normal idle
        
        if (totalGoals > 0 && activeAgents === 0 && cyclesSinceLastReview >= EMERGENCY_THRESHOLD) {
          this.logger.warn('🚨 Emergency coordinator review triggered (system stuck)', {
            reason: 'System idle with goals but no active agents for extended period',
            totalGoals,
            activeAgents,
            cyclesSinceLastReview,
            threshold: EMERGENCY_THRESHOLD,
            nextScheduledReview: this.coordinator.lastReviewCycle + this.coordinator.reviewInterval
          });
          
          await this.runMetaCoordinatorReview();
        }
      }
      
      // Action Coordinator - closes thinking→doing gap
      if (this.actionCoordinator && this.actionCoordinator.enabled && this.actionCoordinator.shouldTrigger(this.cycleCount)) {
        await this.runActionCoordinatorCycle();
      }

      // Deep sleep consolidation - COORDINATE BOTH SYSTEMS
      // Check both cognitive state (mental fatigue) and temporal state (biological rhythms)
      const cognitiveState = this.stateModulator.getState();
      const shouldSleepCognitive = (cognitiveState.mode === 'sleeping');
      const shouldSleepTemporal = (rhythmState.state === 'sleeping');
      
      // In dream mode, FORCE sleep if not already sleeping
      if (this.config.execution?.dreamMode && cognitiveState.mode !== 'sleeping') {
        this.logger.info('🌙 Dream mode detected - forcing sleep state');
        this.stateModulator.transitionToMode('sleeping');
        this.temporal.enterSleep();
      }

      // Sleep if EITHER system triggers (intentional dual-system design)
      if (shouldSleepCognitive || shouldSleepTemporal || this.config.execution?.dreamMode) {
        // Initialize sleep session if just starting
        if (!this.sleepSession.active) {
          this.sleepSession.active = true;
          this.sleepSession.startCycle = this.cycleCount;
          this.sleepSession.consolidationRun = false;
          
          this.logger.info('');
          this.logger.info('🌙 ═══════════════════════════════════════════════════');
          this.logger.info('🌙   ENTERING SLEEP SESSION');
          this.logger.info('🌙 ═══════════════════════════════════════════════════');

          // Emit real-time sleep event
          this._getEvents().emitSleepTriggered({
            reason: shouldSleepCognitive ? 'cognitive_fatigue' : 'temporal_rhythm',
            energy: cognitiveState.energy,
            fatigue: rhythmState.fatigue || 0,
            cycle: this.cycleCount
          });
        }

        // Calculate sleep progress
        const cyclesAsleep = this.cycleCount - this.sleepSession.startCycle;
        const minCyclesRemaining = Math.max(0, this.sleepSession.minimumCycles - cyclesAsleep);
        
        // Synchronize both systems
        if (shouldSleepCognitive && rhythmState.state !== 'sleeping') {
          this.logger.info('💤 Cognitive fatigue triggering sleep', {
            energy: cognitiveState.energy.toFixed(3),
            mode: cognitiveState.mode,
            cycle: this.cycleCount
          });
          this.temporal.enterSleep();
        }
        
        if (shouldSleepTemporal && cognitiveState.mode !== 'sleeping') {
          this.logger.info('💤 Temporal rhythm triggering sleep', {
            fatigue: rhythmState.fatigue.toFixed(3),
            state: rhythmState.state,
            cycle: this.cycleCount
          });
          this.stateModulator.transitionToMode('sleeping');
        }
        
        // Run consolidation ONCE at start of sleep session
        if (!this.sleepSession.consolidationRun) {
          this.logger.info(`🛌 Sleep Cycle ${cyclesAsleep + 1}: Running deep consolidation...`);
          const consolidationResult = await this.performDeepSleepConsolidation();
          
          if (consolidationResult.consolidated) {
            // Only set flag if NOT in dream mode (dream mode runs consolidation every cycle)
            if (!this.config.execution?.dreamMode) {
              this.sleepSession.consolidationRun = true;
            }
            this.logger.info('✅ Deep consolidation complete', {
              cyclesAsleep: cyclesAsleep + 1,
              minimumCyclesRemaining: minCyclesRemaining
            });
          } else if (consolidationResult.deferred) {
            // Consolidation was rate-limited - wake immediately, no point staying asleep
            this.logger.info('⏭️  Consolidation deferred, waking early', {
              reason: consolidationResult.reason,
              nextAvailableIn: consolidationResult.nextAvailableIn
            });
            this.sleepSession.active = false;
            this.sleepSession.consolidationRun = false;
            this.temporal.wake();
            this.stateModulator.transitionToMode('active');
            return;
          }
        } else {
          // Subsequent sleep cycles - just rest and dream
          this.logger.info(`💤 Sleep Cycle ${cyclesAsleep + 1}: Resting and processing...`, {
            energy: cognitiveState.energy.toFixed(3),
            cyclesAsleep: cyclesAsleep + 1,
            minimumCyclesRemaining: minCyclesRemaining
          });
        }
        
        // CRITICAL: Update cognitive state during sleep for gradual energy recovery
        // This allows the system to naturally wake when energy is restored
        // Skip mode check to prevent immediate wake during sleep consolidation
        // In dream mode, skip energy restoration to prevent waking
        if (!this.config.execution?.dreamModeSettings?.preventEnergyRestoration) {
          this.stateModulator.updateState({ 
            type: 'sleep_cycle',
            valence: 0.1,   // Positive valence for restorative sleep
            surprise: 0,    // Sleep is predictable
            success: true   // Sleep cycle completed successfully
          }, { skipModeCheck: true });
        }
        
        // Check if should wake up (both systems must agree or minimum cycles met)
        // In dream mode, never wake (stays asleep until maxCycles)
        const cyclesCompleted = cyclesAsleep + 1;

        // FIX (Jan 24, 2026): Re-fetch cognitive state after updateState() to get current energy
        // Previously used stale cognitiveState from line 1179, causing system to never wake
        const currentCognitiveState = this.stateModulator.getState();
        const energyRestored = currentCognitiveState.energy >= 0.8;
        const minimumMet = cyclesCompleted >= this.sleepSession.minimumCycles;

        // Safety net: force wake after maximum sleep cycles to prevent infinite sleep
        const MAX_SLEEP_CYCLES = 50;
        const safetyWake = cyclesCompleted >= MAX_SLEEP_CYCLES;
        
        // Wake if: (energy restored AND minimum met) OR safety net triggered
        const shouldWake = (minimumMet && energyRestored) || safetyWake;

        if (!this.config.execution?.dreamModeSettings?.preventWake && shouldWake) {
          // Log safety net warning if triggered
          if (safetyWake && !(minimumMet && energyRestored)) {
            this.logger.warn('⚠️  Safety net triggered - forcing wake after max sleep cycles', {
              cyclesAsleep: cyclesCompleted,
              maxCycles: MAX_SLEEP_CYCLES,
              energy: currentCognitiveState.energy.toFixed(3)
            });
          }

          this.logger.info('');
          this.logger.info('☀️ ═══════════════════════════════════════════════════');
          this.logger.info('☀️   SLEEP SESSION COMPLETE - WAKING');
          this.logger.info('☀️ ═══════════════════════════════════════════════════');
          this.logger.info('✅ Sleep metrics:', {
            totalSleepCycles: cyclesCompleted,
            energyRestored: currentCognitiveState.energy.toFixed(3),
            consolidationPerformed: this.sleepSession.consolidationRun,
            safetyWakeTriggered: safetyWake
          });
          this.logger.info('');

          this.sleepSession.active = false;
          this.sleepSession.consolidationRun = false;
          this.temporal.wake();
          this.stateModulator.transitionToMode('active');

          // Emit real-time wake event
          this._getEvents().emitWakeTriggered({
            cyclesSlept: cyclesCompleted,
            energyRestored: currentCognitiveState.energy
          });

          // Continue with normal cycle (don't return)
        } else {
          // PLAN INTEGRITY (Jan 20, 2026): Check for active plan before skipping sleep
          // User-directed plans must execute even during sleep
          const activePlan = await this.clusterStateStore?.getPlan('plan:main');
          if (activePlan && activePlan.status === 'ACTIVE') {
            this.logger.info('📋 Active plan detected - will process tasks during sleep', {
              planId: activePlan.id,
              sleepCycle: cyclesAsleep + 1
            });
            // Fall through to plan execution (don't return)
          } else {
            // No active plan - normal sleep skip
            await this.saveState();
            
            // Record cycle completion time for metrics
            const cycleDuration = Date.now() - cycleStart.getTime();
            this.logger.info(`✓ Sleep cycle completed in ${cycleDuration}ms`);
            
            return; // Skip normal cycle operations during sleep
          }
        }
      } else if (this.sleepSession.active) {
        // Was sleeping but now both systems say wake (edge case)
        this.logger.info('☀️  Sleep session ended by system state change');
        this.sleepSession.active = false;
        this.sleepSession.consolidationRun = false;
      }

      // 2. Poll environment
      if (this.environment) {
        const observations = await this.environment.pollSensors();
        
        for (const obs of observations) {
          const surprise = this.thermodynamic.calculateSurprise({}, obs.value);
          this.stateModulator.updateState({ surprise });
        }
      }

      // 3. Get cognitive state (reuse from sleep check above)
      const thinkingParams = this.stateModulator.getThinkingParameters();
      const oscillatorParams = this.oscillator.getThinkingParameters();

      if (!thinkingParams.shouldThink) {
        this.logger.info('Skipping thought generation');
        return;
      }
      
      // GUIDED MODE: Skip thought generation until plan is generated
      const isGuidedMode = this.config.architecture?.roleSystem?.explorationMode === 'guided';
      const guidedPlanExists = await this.clusterStateStore?.getPlan('plan:main');
      
      if (isGuidedMode && !this.guidedPlanReady && !guidedPlanExists) {
        this.logger.info('⏭️  Guided mode: Skipping thought generation until plan is ready', { cycle: this.cycleCount });
        
        // Still update TUI and emit events, but skip cognitive processing
        const cycleDuration = Date.now() - cycleStart.getTime();
        this._getEvents().emitCycleComplete({
          cycle: this.cycleCount,
          duration: cycleDuration,
          mode: 'guided_waiting_for_plan'
        });
        
        await this.saveState();
        return;
      }
      
      // Mark plan as ready once we detect it exists
      if (isGuidedMode && !this.guidedPlanReady && guidedPlanExists) {
        this.guidedPlanReady = true;
        this.logger.info('✅ Guided plan detected - resuming normal cognition', { cycle: this.cycleCount });

        // MERGED BRAIN FIX (Jan 23, 2026): Clear stale planProgressEvents from old runs
        // When merging brains, planProgressEvents from a previous plan may pollute the new plan's progress tracking
        // Check if existing events match current plan's phases - if not, clear them
        if (this.planProgressEvents?.length > 0 && this.clusterStateStore) {
          try {
            const milestones = await this.clusterStateStore.listMilestones(guidedPlanExists.id);
            const milestoneTitles = milestones.map(m => m.title?.substring(0, 50));

            // Check if any planProgressEvents are from a different plan
            const hasStaleEvents = this.planProgressEvents.some(event => {
              // Phase events have phaseName - check if it matches any current milestone
              if (event.phaseName) {
                const eventTitlePrefix = event.phaseName?.substring(0, 50);
                return !milestoneTitles.some(title =>
                  title && eventTitlePrefix &&
                  (title.includes(eventTitlePrefix) || eventTitlePrefix.includes(title))
                );
              }
              return false;
            });

            if (hasStaleEvents) {
              this.logger.warn('🧹 Clearing stale planProgressEvents from merged/previous run', {
                staleEventCount: this.planProgressEvents.length,
                currentPlan: guidedPlanExists.title
              });
              this.planProgressEvents = [];
            }
          } catch (error) {
            this.logger.debug('Could not verify planProgressEvents freshness', { error: error.message });
          }
        }
      }

      // 4. EXECUTIVE RING: Reality check and decision (if enabled)
      // Executive makes tactical decision BEFORE any spawning logic
      // This is the dlPFC inhibitory control and reality monitoring
      let executiveSkipSpawning = false;
      if (this.executiveRing) {
        const executiveContext = await this.gatherExecutiveContext();
        const executiveDecision = await this.executiveRing.decideCycleAction(executiveContext);
        
        this.logger.info('🧠 Executive decision', {
          cycle: this.cycleCount,
          action: executiveDecision.action,
          reason: executiveDecision.reason?.substring(0, 100),
          coherence: this.executiveRing.getCoherenceScore().toFixed(2)
        }, 2);
        
        // Execute decision
        await this.executeExecutiveDecision(executiveDecision, executiveContext);

        // Emit non-routine executive decisions to realtime clients
        if (executiveDecision.action !== 'CONTINUE_NORMAL') {
          this._getEvents().emitExecutiveDecision({
            cycle: this.cycleCount,
            action: executiveDecision.action,
            reason: executiveDecision.reason,
            coherence: this.executiveRing.getCoherenceScore()
          });
        }

        // If executive says SKIP/BLOCK/EMERGENCY/REDIRECT - skip spawning this cycle
        if (['SKIP', 'SKIP_AND_REDIRECT', 'BLOCK_AND_INJECT', 'EMERGENCY_ESCALATE'].includes(executiveDecision.action)) {
          executiveSkipSpawning = true;
          this.logger.info('⏭️  Executive intervention - skipping spawn logic', { 
            action: executiveDecision.action 
          }, 2);
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // AUTONOMOUS GOAL EXECUTION - THE HEART OF THE SYSTEM
      // ═══════════════════════════════════════════════════════════════════════════
      // This is what makes the machine THINK. Autonomous goals are sacred.
      // Execution mode should be the DEFAULT state - always working, always thinking.
      // Even during guided mode, autonomous goals run in parallel.
      // ═══════════════════════════════════════════════════════════════════════════

      const goalCount = this.goals.getGoals().length;
      const isGuidedRun = this.isGuidedExclusiveRun();

      // EXECUTION MODE IS THE DEFAULT: Enter immediately when ANY goals exist
      // The machine should always be working on its autonomous thoughts
      if (!isGuidedRun && !this.oscillator.isExecuting() && goalCount > 0) {
        this.oscillator.enterExecutionMode(50, `autonomous_goals_${goalCount}`);
        this.logger.info('🧠 AUTONOMOUS MODE: Machine is thinking...', {
          goalCount,
          reason: 'Goals exist - execution is the natural state'
        });
      }

      // Check for active plan (for slot reservation only, NOT for blocking)
      const hasPlanToExecute = await this.clusterStateStore?.getPlan('plan:main').then(p => p && p.status === 'ACTIVE').catch(() => false);

      // ALWAYS SPAWN GOAL AGENTS - This is the machine expressing its autonomy
      // Executive can throttle but should NOT block autonomous thought
      if (!isGuidedRun && !executiveSkipSpawning && this.agentExecutor && goalCount > 0) {
        const activeAgents = this.agentExecutor.registry.getActiveCount();
        const maxConcurrent = this.agentExecutor.maxConcurrent || 5;

        // Reserve slots for plan tasks if plan is active, but ALWAYS leave room for autonomous goals
        // Autonomous goals are not secondary - they run alongside everything
        const reservedForPlan = hasPlanToExecute ? Math.min(2, maxConcurrent - 2) : 0;
        const availableForGoals = Math.max(2, maxConcurrent - reservedForPlan); // Always at least 2 slots for autonomy

        // Log autonomous goal activity
        if (this.cycleCount % 5 === 0) {
          this.logger.info('🧠 Autonomous goal execution', {
            goalCount,
            activeAgents,
            maxConcurrent,
            reservedForPlan,
            availableForGoals,
            isThinking: activeAgents < availableForGoals
          });
        }

        // FIRST: Spawn strategic goals (critical system improvements)
        await this.spawnStrategicGoals();

        // THEN: Fill slots with autonomous goal agents
        if (activeAgents < availableForGoals) {
          await this.spawnExecutionAgents();
        }
      } else if (!isGuidedRun && goalCount > 0 && this.cycleCount % 20 === 0) {
        this.logger.warn('⚠️ Autonomous goals exist but spawning blocked', {
          goalCount,
          executiveSkipSpawning,
          hasAgentExecutor: !!this.agentExecutor
        });
      } else if (isGuidedRun && goalCount > 0 && this.cycleCount === 1) {
        this.logger.info('📌 GUIDED-EXCLUSIVE MODE: autonomous goal spawning disabled while guided plan is active');
      }

      // 5. Select task or goal based on mode
      let currentGoal = null;
      let currentTask = null;
      let explorationGoal = null;

      // Check if plan-driven mode active
      // ARCHITECTURE FIX (Jan 21, 2026): When PlanExecutor handles the plan,
      // SKIP all the old orchestrator plan code to avoid conflicts
      const activePlan = await this.clusterStateStore?.getPlan('plan:main');
      if (activePlan && activePlan.status === 'ACTIVE' && !planExecutorHandled) {
        // LEGACY PATH: Only runs if PlanExecutor is not available
        // This code is kept for backward compatibility but should not execute
        // when PlanExecutor is the authority
        this.logger.debug('⚠️  Legacy plan path (PlanExecutor not handling)', {
          planId: activePlan.id
        });
        
        // BULLETPROOF: Check all milestones for completion EVERY cycle
        // This ensures phases advance even if tasks were completed outside normal flow
        const allMilestones = await this.clusterStateStore.listMilestones('plan:main');
        for (const milestone of allMilestones) {
          if (milestone.status === 'ACTIVE') {
            // Check if this active milestone can advance
            const milestoneTasks = await this.clusterStateStore.listTasks('plan:main', { milestoneId: milestone.id });
            const allDone = milestoneTasks.every(t => t.state === 'DONE');
            
            if (allDone && milestoneTasks.length > 0) {
              this.logger.info('🎯 Milestone ready to advance', {
                milestoneId: milestone.id,
                title: milestone.title,
                tasksCompleted: milestoneTasks.length
              });
              await this.clusterStateStore.advanceMilestone('plan:main', milestone.id);
            }
          }
        }
        
        // Use PlanScheduler
        if (!this.planScheduler) {
          this.planScheduler = new PlanScheduler(
            this.clusterStateStore,
            this.instanceId,
            this.config,
            this.logger
          );
        }
        
        currentTask = await this.planScheduler.nextRunnableTask(
          this.goalAllocator?.specializationProfile
        );
        
        if (currentTask) {
          this.logger.info('🎯 Working on task', {
            taskId: currentTask.id,
            title: currentTask.title,
            milestone: currentTask.milestoneId
          });
          
          // Record plan event for progress spine
          const phaseNum = currentTask.id.match(/phase(\d+)/)?.[1] || '?';
          this.recordPlanEvent('phase_started', {
            phaseNumber: phaseNum,
            phaseName: currentTask.title,
            description: `Phase ${phaseNum}: ${currentTask.title?.substring(0, 100)}`
          });
          
          // Mark as in progress
          // UNIFIED QUEUE ARCHITECTURE: Start is low-risk (no conflicts), keep direct for now
          await this.clusterStateStore.startTask(currentTask.id, this.instanceId);
          
          // CRITICAL FIX: Spawn agent to actually DO the task!
          // Tasks were being claimed but never executed - no agent assigned
          // FIX P1.2: Also check for PENDING_SPAWN marker (pre-assignment in progress)
          if (this.agentExecutor && 
              !currentTask.assignedAgentId && 
              currentTask.assignedAgentId !== 'PENDING_SPAWN') {
            
            // FIX: Re-read task from disk to prevent race condition where another cycle
            // already assigned an agent between our initial read and now
            const freshTask = await this.clusterStateStore.getTask(currentTask.id);
            if (freshTask?.assignedAgentId) {
              this.logger.info('⏭️  Task already has agent assigned (race prevented)', {
                taskId: currentTask.id,
                existingAgentId: freshTask.assignedAgentId
              });
              // Continue with execution - agent is already working on it
            } else {
            
            const agentType = this.determineAgentTypeForTask(currentTask);
            
            // Defensive: Ensure agentType is valid before spawning
            if (!agentType) {
              this.logger.error('❌ Failed to determine agent type for task, skipping spawn', {
                taskId: currentTask.id,
                title: currentTask.title,
                metadata: currentTask.metadata
              });
            } else {
            
            // ARCHITECTURE CLEANUP (Jan 20, 2026): Tasks execute via taskId only, NO goalId
            // Duplicate prevention uses task.assignedAgentId (already checked above at line 1436-1448)
            // Goals are separate for autonomous work
            {
              // P2: Build coordination context for agent
              const milestone = allMilestones.find(m => m.id === currentTask.milestoneId);
              const predecessorTasks = await this.getPredecessorTasks(currentTask);
              const siblingTasks = await this.getSiblingTasks(currentTask.planId, currentTask.milestoneId);
              
              // Spawn agent for this task
              const missionSpec = {
              missionId: `mission_task_${currentTask.id}_${Date.now()}`,
              agentType,
              goalId: null, // Tasks don't use goals - goals are for autonomous work only
              taskId: currentTask.id, // Tasks execute via taskId
              planId: currentTask.planId, // P2: Link to plan
              milestoneId: currentTask.milestoneId, // P2: Link to milestone/phase
              description: currentTask.description || currentTask.title,
              successCriteria: currentTask.acceptanceCriteria?.map(c => c.rubric) || ['Complete task successfully'],
              deliverable: currentTask.deliverable || currentTask.metadata?.deliverableSpec || null,
              maxDuration: 720000, // 12 minutes for task work
              createdBy: 'plan_scheduler',
              spawnCycle: this.cycleCount,
              triggerSource: 'task_execution',
              spawningReason: 'task_assigned',
              priority: currentTask.priority || 1.0,
              provenanceChain: [currentTask.planId, currentTask.milestoneId, currentTask.id],
              
              // Context isolation: Pass execution context from goal to agent
              executionContext: currentGoal?.executionContext || 'guided',
              metadata: {
                ...currentTask.metadata,
                independentMode: currentGoal?.executionContext === 'independent',
                isolationNote: currentGoal?.executionContext === 'independent'
                  ? 'This goal is independent of the guided plan. Do not reference or build upon guided plan work.'
                  : null,
                
                // P2: Add coordination context for swarm collaboration
                // CRITICAL FIX (Jan 20): Only pass minimal context, not full task/plan objects
                // Full objects with acceptanceCriteria confuse agents about their role
                coordinationContext: {
                  taskId: currentTask.id,
                  taskTitle: currentTask.title,
                  planId: activePlan?.id,
                  planTitle: activePlan?.title,
                  milestoneId: milestone?.id,
                  phaseTitle: milestone?.title || 'unknown',
                  phaseNumber: currentTask.id.match(/phase(\d+)/)?.[1] || null,
                  taskDependencies: currentTask.deps || [],
                  predecessorTasks: predecessorTasks.map(t => ({
                    id: t.id,
                    title: t.title,
                    state: t.state
                  })),
                  siblingTasks: siblingTasks.map(t => ({
                    id: t.id,
                    title: t.title,
                    state: t.state,
                    assignedTo: t.assignedAgentId
                  })),
                  sharedWorkspace: this.pathResolver?.getPhaseWorkspace(currentTask.milestoneId)
                }
              }
            };
            
            const agentId = await this.agentExecutor.spawnAgent(missionSpec);
            if (agentId) {
              // Update task with agent assignment
              currentTask.assignedAgentId = agentId;
              currentTask.updatedAt = Date.now();
              
              // UNIFIED QUEUE ARCHITECTURE: Metadata updates can use queue too
              if (this.taskStateQueue) {
                await this.taskStateQueue.enqueue({
                  type: 'UPDATE_TASK',
                  taskId: currentTask.id,
                  task: currentTask,
                  source: 'agent_assignment',
                  cycle: this.cycleCount
                });
              } else {
                await this.clusterStateStore.upsertTask(currentTask);
              }
              
              this.logger.info('✅ Agent spawned for task', {
                taskId: currentTask.id,
                agentId,
                agentType
              });
            } else {
              // ✅ CRITICAL FIX: Agent spawn failed - reset task to PENDING
              // Without this, task stays IN_PROGRESS with no agent (stuck forever)
              this.logger.error('❌ Agent spawn failed for task - resetting to PENDING', {
                taskId: currentTask.id,
                agentType,
                reason: 'spawn_returned_null'
              });
              
              // Reset task so it can be retried
              try {
                await this.clusterStateStore.releaseTask(currentTask.id, this.instanceId);
                this.logger.info('✅ Task released back to PENDING for retry', {
                  taskId: currentTask.id
                });
              } catch (error) {
                this.logger.error('Failed to release task after spawn failure', {
                  taskId: currentTask.id,
                  error: error.message
                });
              }
            }
            } // Close else block for goalAlreadyPursued check
            } // Close else block for agentType check
            } // Close else block for freshTask.assignedAgentId race check
          }
        }
      }

      // Fallback to goals if no task (preserves backward compatibility)
      if (!currentTask) {
        if (this.oscillator.isExploring()) {
          explorationGoal = this.selectExplorationGoal();
          currentGoal = explorationGoal;
          
          this.logger.info('🔍 Exploration mode - pursuing backlog goal', {
            goal: currentGoal?.description.substring(0, 60) || 'free exploration'
          });
        } else if (this.oscillator.isExecuting()) {
          // Execution mode: work on top priority only
          const goals = this.goals.getGoals().sort((a, b) => b.priority - a.priority);
          currentGoal = goals[0] || null;
          
          this.logger.info('⚙️  Execution mode - working top priority', {
            goal: currentGoal?.description.substring(0, 60) || 'none',
            priority: currentGoal?.priority.toFixed(3),
            cyclesRemaining: this.oscillator.executionCyclesRemaining
          });
        } else {
          // Normal mode: Check if curator has a suggestion first
          if (this.goalCurator) {
            const suggestion = await this.goalCurator.suggestNextGoal({
              cycle: this.cycleCount,
              recentGoals: this.journal.slice(-10).map(e => e.goal).filter(Boolean),
              cognitiveState: cognitiveState
            });
            
            if (suggestion) {
              currentGoal = this.goals.goals.get(suggestion.goalId);
              if (currentGoal) {
                this.logger.info('🎯 Curator suggested goal', {
                  goalId: suggestion.goalId,
                  reason: suggestion.reason,
                  priority: suggestion.priority,
                  description: currentGoal.description.substring(0, 60)
                });
              }
            }
          }
          
          // If curator didn't suggest, use regular selection
          if (!currentGoal) {
            currentGoal = await this.goals.selectGoalToPursue({ cognitiveState });
          }
        }
      }

      // IMPORTANT: Perform goal rotation BEFORE discovery
      // This prevents newly discovered goals from being immediately archived
      const rotationConfig = this.config.architecture.goals.rotation;
      if (rotationConfig?.enabled && this.cycleCount % rotationConfig.checkInterval === 0) {
        const rotationResults = this.goals.performGoalRotation(rotationConfig);
        
        if (rotationResults.completed > 0 || rotationResults.archived > 0) {
          this.logger.info('🔄 Goal rotation executed', rotationResults);
        }
        
        // Check for goal monopolization
        const dominant = this.goals.detectDominantGoal(
          this.journal,
          rotationConfig.dominanceThreshold || 0.20
        );
        
        if (dominant) {
          this.logger.warn('⚠️  Goal monopolization detected', dominant);
          this.goals.rotateDominantGoal(dominant);
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // AUTONOMOUS GOAL DISCOVERY - The machine exploring its own thoughts
      // ═══════════════════════════════════════════════════════════════════════════
      // Goal discovery is the machine looking inward at its journal and memory,
      // finding new directions to explore. This is autonomous cognition.
      // Run frequently - every 5 cycles - to keep the machine constantly thinking.
      // ═══════════════════════════════════════════════════════════════════════════
      const guidedRunForDiscovery = this.isGuidedExclusiveRun();

      // Discover goals frequently - the machine should always be thinking
      if (this.cycleCount % 5 === 0 && !guidedRunForDiscovery) {
        const discovered = await this.goals.discoverGoals(this.journal, this.memory);
        for (const g of discovered) {
          // Validation happens in addGoal method now
          const newGoal = this.goals.addGoal(g);
          
          if (newGoal) {
            // Track in evaluation framework
            if (this.evaluation) {
              this.evaluation.trackGoalCreated(newGoal.id, newGoal);
            }
            
            // Notify curator of new goal
            if (this.goalCurator) {
              await this.goalCurator.handleEvent({
                type: 'created',
                goalId: newGoal.id,
                goal: newGoal,
                cycle: this.cycleCount
              });
            }
          }
        }
      } else if (guidedRunForDiscovery && this.cycleCount === 1) {
        this.logger.info('📌 GUIDED-EXCLUSIVE MODE: autonomous goal discovery disabled');
      }
      
      // Run goal curator periodically
      if (this.goalCurator && this.cycleCount % 20 === 0) {
        await this.goalCurator.curate(this.cycleCount, this.journal);
      }

      // 5. Check for chaotic perturbation (with cooldown to prevent loops)
      let perturbation = null;
      if (this.chaotic.isPerturbationDue() || this.cycleCount % 20 === 0) {
        // Check cooldown first
        if (this.chaotic.lastChaosInjection && 
            this.cycleCount - this.chaotic.lastChaosInjection < this.chaotic.chaosCooldown) {
          // Still in cooldown, skip chaos injection
          perturbation = null;
        } else {
          const stagnant = this.chaotic.detectStagnation(
            this.journal.slice(-5).map(j => j.thought).join(' ')
          );
          
          if (stagnant) {
            perturbation = this.chaotic.generatePerturbation({ stagnation: true });
            this.chaotic.lastChaosInjection = this.cycleCount;
            this.logger.info('💥 Chaos injected (stagnation)', {
              cyclesSinceLastChaos: this.chaotic.lastChaosInjection
            });
          } else if (this.oscillator.isExploring() && Math.random() < 0.5) {
            // Random chaos during exploration (less frequently)
            perturbation = this.chaotic.generatePerturbation({ stagnation: false });
          }
        }
      }

      // 6. Select role
      const activeRoles = this.roles.getRoles();
      let roleBase = activeRoles[this.cycleCount % activeRoles.length];
      
      // Context isolation: Apply execution context if goal requires isolation
      // Check config flag to allow disabling (opt-in for Phase 2)
      const contextIsolationEnabled = this.config.goals?.enableContextIsolation !== false; // Default true
      let role = roleBase;
      
      if (contextIsolationEnabled && currentGoal && currentGoal.executionContext === 'independent') {
        role = this.roles.getRole(roleBase.id, 'independent');
        
        this.logger.info('🔓 Independent goal mode activated', {
          goalId: currentGoal.id,
          source: currentGoal.source,
          roleId: role.id,
          usingCleanPrompt: true,
          promptPreview: role.prompt.substring(0, 50) + '...'
        });
      } else if (contextIsolationEnabled && currentGoal && currentGoal.executionContext === 'guided') {
        role = this.roles.getRole(roleBase.id, 'guided');
      } else if (!contextIsolationEnabled && currentGoal && currentGoal.executionContext) {
        // Context isolation disabled - use base role
        role = roleBase;
      } else {
        // No special context or disabled - use base role
        role = roleBase;
      }

      // 7. Query memory with diversity controls (mode-aware)
      let memoryContext = [];
      
      // Diversity feature: Occasionally skip memory context for fresh thinking
      // BUT reduce diversity when in focus mode with active goal (preserve continuity)
      const diversityConfig = this.config.architecture.memory.contextDiversity || {};
      const inFocusMode = this.oscillator.isFocused();
      const hasActiveGoal = currentGoal !== null;
      
      // Adjust diversity probabilities based on mode
      // Focus mode with goal: 15% → 4.5% zero context (preserve continuity)
      // Other modes: Full diversity for creativity
      const noContextProb = (inFocusMode && hasActiveGoal)
        ? (diversityConfig.noContextProbability || 0) * 0.3
        : (diversityConfig.noContextProbability || 0);
      
      const shouldSkipContext = diversityConfig.enabled && 
        Math.random() < noContextProb;
      
      if (!shouldSkipContext) {
        const queryText = currentGoal 
          ? currentGoal.description 
          : role.prompt.substring(0, 100);
        
        const maxNodes = diversityConfig.maxContextNodes || 5;
        const peripheralRate = diversityConfig.peripheralSamplingRate || 0;
        const minSimilarity = diversityConfig.minSimilarityThreshold || 0;
        
        // Skip peripheral sampling during focused goal pursuit (preserve context)
        // Allow peripheral sampling during exploration for serendipity
        if (Math.random() < peripheralRate && 
            this.memory.nodes.size > 10 &&
            !hasActiveGoal) {
          memoryContext = await this.memory.queryPeripheral(queryText, maxNodes);
          this.logger.info('🎲 Peripheral memory sampling', { nodes: memoryContext.length });
        } else {
          const rawContext = await this.memory.query(queryText, maxNodes);
          // Filter by minimum similarity
          memoryContext = rawContext.filter(m => m.similarity >= minSimilarity);
          if (memoryContext.length < rawContext.length) {
            this.logger.debug('Filtered weak memory matches', {
              original: rawContext.length,
              kept: memoryContext.length
            });
          }
          
          // Context isolation: Filter guided plan memory for independent goals
          if (contextIsolationEnabled && currentGoal && currentGoal.executionContext === 'independent') {
            memoryContext = this.filterIndependentMemory(memoryContext);
            
            this.logger.info('🔒 Independent goal: memory filtered', {
              goalId: currentGoal.id,
              originalNodes: rawContext.length,
              filteredNodes: memoryContext.length
            });
          }
        }
      } else {
        const modeInfo = inFocusMode && hasActiveGoal ? ' (reduced in focus mode)' : '';
        this.logger.info(`🎨 Fresh cycle - no memory context injected${modeInfo}`);
      }

      // 8. Generate thought using GPT-5.2 Quantum Reasoning
      const context = {
        memory: memoryContext,
        goals: currentGoal ? [currentGoal] : [],
        cognitiveState,
        perturbation,
        oscillatorMode: this.oscillator.getCurrentMode(),
        allowWebSearch: this.config.models.enableWebSearch,
        cycle: this.cycleCount,
        reality: this.currentReality,      // Reality snapshot from introspection
        routing: this.lastRoutingHints,    // Routing hints for agent spawning
        
        // Context isolation: Pass execution context to downstream systems
        executionContext: currentGoal?.executionContext || 'autonomous'
      };

      // VOICE SYSTEM: Add voice context to prompt if enabled
      let promptWithVoice = role.prompt;
      if (this.voiceEnabled) {
        promptWithVoice = `${role.prompt}\n\n${this.getVoiceContext()}`;
      }

      const superposition = await this.quantum.generateSuperposition(
        promptWithVoice,
        context
      );

      // Capture metadata for downstream evaluation/logging
      if (Array.isArray(superposition?.superposition)) {
        const branchesSnapshot = superposition.superposition.map(branch => ({
          ...branch
        }));
        this.latestBranchMetadata = {
          cycle: this.cycleCount,
          timestamp: new Date().toISOString(),
          branches: branchesSnapshot
        };
      } else {
        this.latestBranchMetadata = null;
      }

      const divergenceScore = this.calculateBranchDivergence(superposition?.superposition);
      if (this.latestBranchMetadata) {
        this.latestBranchMetadata.divergence = divergenceScore;
      }

      const tunnel = await this.quantum.quantumTunnel(context, this.memory);
      if (tunnel) {
        this.logger.info('⚡ Quantum tunnel (GPT-5.2 + web search)!');
      }

      const thought = await this.quantum.collapseSuperposition(superposition);
      
      // VOICE SYSTEM: Parse for [VOICE]: markers - COSMO can speak at any time
      if (thought.hypothesis) {
        thought.hypothesis = this.parseForVoice(thought.hypothesis);
      }
      
      // DEBUG: Log what we got
      this.logger.info('Thought collapsed', {
        hasHypothesis: Boolean(thought.hypothesis),
        hypothesisLength: thought.hypothesis?.length || 0,
        hasContent: Boolean(thought.content),
        contentLength: thought.content?.length || 0,
        hadError: thought.hadError || false
      });

      // Validate thought has content
      if (!thought.hypothesis || thought.hypothesis.length < 10) {
        this.logger.warn('Thought too short or empty, skipping cycle', {
          hypothesis: thought.hypothesis,
          hadError: thought.hadError
        });
        
        // Update state to reflect failure
        this.stateModulator.updateState({
          type: 'thought',
          valence: -0.2,
          surprise: 0,
          success: false
        });
        
        return; // Skip rest of cycle
      }

      // Log extended reasoning if present
      if (thought.reasoning) {
        this.logger.info('🧠 Extended reasoning available', {
          reasoningLength: thought.reasoning.length
        });
        this.reasoningHistory.push({
          cycle: this.cycleCount,
          reasoning: thought.reasoning,
          timestamp: new Date()
        });
      }

      if (this.latestBranchMetadata) {
        this.latestBranchMetadata.selectedBranchId = thought.branchId || null;
      }

      if (thought.usedWebSearch) {
        this.webSearchCount++;
        this.logger.info('🌐 Web search used', {
          total: this.webSearchCount
        });
      }

      await this.maybeTriggerConsistencyReview();

      // ═══════════════════════════════════════════════════════════════════════════
      // AUTONOMOUS GOAL CAPTURE - The machine generating its own thoughts
      // ═══════════════════════════════════════════════════════════════════════════
      // This is the machine THINKING - generating goals from its own cognitive output.
      // This should ALWAYS be active unless explicitly disabled.
      // Execution mode is no longer a blocker - autonomous thought is sacred.
      // ═══════════════════════════════════════════════════════════════════════════
      const intrinsicEnabled = this.config.architecture.goals?.intrinsicEnabled !== false;
      const shouldSkipGoalCapture = guidedRunForDiscovery || !intrinsicEnabled;

      if (shouldSkipGoalCapture && this.cycleCount % 50 === 0) {
        this.logger.debug('🚫 Goal auto-capture skipped', {
          reason: !intrinsicEnabled ? 'intrinsic goals disabled' : 'guided-exclusive mode',
          cycle: this.cycleCount
        });
      }

      const capturedGoals = shouldSkipGoalCapture
        ? []
        : await this.goalCapture.captureGoalsFromOutput(thought.hypothesis);
      
      for (const captured of capturedGoals) {
        // Validate captured goal text
        if (!captured.text || 
            typeof captured.text !== 'string' || 
            captured.text.length < 10 ||
            captured.text.includes('Error:')) {
          this.logger.warn('⚠️  Skipped invalid captured goal', {
            hasText: Boolean(captured.text),
            length: captured.text?.length || 0,
            source: captured.source
          });
          continue;
        }
        
        if (this.goals.getGoals().length < this.config.architecture.goals.maxGoals) {
          const priority = captured.priority === 'high' ? 0.8 : 
                          captured.priority === 'low' ? 0.3 : 0.5;
          
          const newGoal = this.goals.addGoal({
            description: captured.text,
            reason: `Auto-captured via GPT-5.2: ${captured.source}`,
            uncertainty: 0.5,
            source: captured.source
          });
          
          if (newGoal) {
            // Track in evaluation framework
            if (this.evaluation) {
              this.evaluation.trackGoalCreated(newGoal.id, newGoal);
            }
            
            // Notify curator of new goal
            if (this.goalCurator) {
              await this.goalCurator.handleEvent({
                type: 'created',
                goalId: newGoal.id,
                goal: newGoal,
                cycle: this.cycleCount
              });
            }
          }

          this.logger.info('📝 Goal auto-captured (GPT-5.2)', {
            text: captured.text.substring(0, 50),
            source: captured.source
          });
        }
      }

      // Calculate surprise BEFORE using it in branch reward
      const outputSurprise = this.goalCapture.detectSurprise(thought.hypothesis);
      if (outputSurprise > 0.5) {
        this.stateModulator.boostCuriosity(outputSurprise * 0.2);
        this.logger.info('✨ High surprise - curiosity boosted', {
          surprise: outputSurprise.toFixed(2)
        });
      }

      const branchReward = this.calculateBranchReward({
        outputSurprise,
        capturedGoalsCount: capturedGoals.length,
        divergence: this.latestBranchMetadata?.divergence || 0,
        hasExtendedReasoning: Boolean(thought.reasoning && thought.reasoning.length > 100),
        thoughtLength: thought.hypothesis?.length || 0,
        cognitiveState: this.stateModulator.getState()
      });
      if (this.latestBranchMetadata) {
        this.latestBranchMetadata.reward = branchReward;
      }
      await this.quantum.recordPolicyOutcome({
        reward: branchReward,
        selectedBranchId: thought.branchId || null
      });
      await this.logLatentTrainingSample(branchReward);

      // 10. Store in memory (with robust validation)
      let memoryNode = null;
      const thoughtValidation = validateAndClean(thought.hypothesis);
      if (thoughtValidation.valid) {
        memoryNode = await this.memory.addNode(
          thoughtValidation.content,
          role.id
        );
      } else {
        this.logger.warn('⚠️  Skipped invalid thought', {
          reason: thoughtValidation.reason,
          hasHypothesis: Boolean(thought.hypothesis),
          length: thought.hypothesis?.length || 0,
          role: role.id
        });
      }

      // Add reasoning to memory only if it contains conclusions (not intermediate steps)
      if (thought.reasoning) {
        const reasoning = thought.reasoning;
        const mqConfig = this.config?.coordinator?.memoryQuality || {};
        const minLen = mqConfig.reasoningMinLength || 300;
        const requireConclusion = mqConfig.reasoningRequireConclusion !== false;
        const hasConclusion = !requireConclusion || /therefore|this means|key insight|importantly|in conclusion|suggests that|indicates that|reveals that|demonstrates that/i.test(reasoning);

        if (hasConclusion && reasoning.length > minLen) {
          const reasoningValidation = validateAndClean(`[REASONING] ${reasoning}`);
          if (reasoningValidation.valid) {
            await this.memory.addNode(
              reasoningValidation.content,
              'reasoning_key'
            );
          }
        }
      }

      // Hebbian reinforcement (only if thought was stored)
      if (memoryNode && memoryContext.length > 0) {
        this.memory.reinforceCooccurrence([
          memoryNode.id,
          ...memoryContext.map(m => m.id)
        ]);
      }

      // 11. Update thermodynamic state
      const expectedSimilarity = 0.5;
      const surprise = this.thermodynamic.calculateSurprise(
        expectedSimilarity,
        memoryContext[0]?.similarity || 0
      );

      // Check if thought should spawn a trajectory fork
      if (this.forkSystem) {
        const forkContext = {
          surprise,
          currentGoal,
          cognitiveState,
          cycleCount: this.cycleCount,
          forkDepth: 0 // Main trajectory is depth 0
        };

        if (this.forkSystem.shouldFork(thought, forkContext)) {
          await this.forkSystem.spawnFork(thought, forkContext);
        }
      }

      // 12. Update cognitive state
      this.stateModulator.updateState({
        type: 'thought',
        valence: explorationGoal ? 0.2 : 0,
        surprise,
        success: true
      });

      // 13. Update goal progress
      if (currentGoal) {
        this.goals.updateGoalProgress(
          currentGoal.id,
          explorationGoal ? 0.05 : 0.1,
          thought.hypothesis.substring(0, 200)
        );
        
        // Track goal pursuit in evaluation framework
        if (this.evaluation) {
          this.evaluation.trackGoalPursued(currentGoal.id, role.id, `cycle_${this.cycleCount}`);
        }
        
        // Notify curator of goal pursuit
        if (this.goalCurator) {
          await this.goalCurator.handleEvent({
            type: 'pursued',
            goalId: currentGoal.id,
            goal: this.goals.goals.get(currentGoal.id),
            cycle: this.cycleCount
          });
        }
      }

      if (explorationGoal) {
        this.oscillator.recordExploration({
          goalPursued: explorationGoal.id,
          insightGained: outputSurprise > 0.4,
          thought: thought.hypothesis.substring(0, 100)
        });
      }

      // 14. Record in journal
      const entry = {
        cycle: this.cycleCount,
        role: role.id,
        thought: thought.hypothesis,
        reasoning: thought.reasoning ? thought.reasoning.substring(0, 500) : null,
        goal: currentGoal?.description || null,
        surprise,
        cognitiveState: { ...cognitiveState },
        oscillatorMode: this.oscillator.getCurrentMode(),
        perturbation: perturbation?.type || null,
        tunnel: tunnel !== null,
        goalsAutoCaptured: capturedGoals.length,
        usedWebSearch: thought.usedWebSearch || false,
        model: thought.model,
        timestamp: new Date()
      };

      this.journal.push(entry);
      await this.logThought(entry);

      // Emit real-time thought event
      this._getEvents().emitThought({
        cycle: this.cycleCount,
        thought: thought.hypothesis,
        role: role.id,
        surprise: surprise,
        model: thought.model,
        reasoning: thought.reasoning,
        usedWebSearch: thought.usedWebSearch || false
      });

      // Task validation - check progress during execution, full validation on completion
      // ARCHITECTURE FIX (Jan 21, 2026): Skip when PlanExecutor handles the plan
      // PlanExecutor has its own validation using taskId-based agent correlation
      if (currentTask && !planExecutorHandled) {
        // LEGACY PATH: Only runs if PlanExecutor is not handling the plan
        // Check if task needs validation
        // Tasks in IN_PROGRESS state with assigned agents should be checked for completion
        const needsValidation = currentTask.state === 'IN_PROGRESS' && 
                               currentTask.claimedBy === this.instanceId &&
                               !currentTask.metadata?.validationAttempted;
        
        if (needsValidation) {
          this.logger.info('🔍 Task needs validation (legacy path)', {
            taskId: currentTask.id,
            instanceId: this.instanceId,
            claimedBy: currentTask.claimedBy
          });
          
          // FIX (Jan 21, 2026): Use taskId for agent correlation, not goalId
          // Tasks now use taskId (goalId was removed from tasks)
          const taskId = currentTask.id;
          let hasCompletedAgents = false;
          let completedAgentsList = [];
          
          if (this.agentExecutor && taskId) {
            // Use new taskId-based registry method
            const registry = this.agentExecutor.registry;
            if (registry.getCompletedAgentsByTaskId) {
              completedAgentsList = registry.getCompletedAgentsByTaskId(taskId);
              hasCompletedAgents = completedAgentsList.length > 0;
            } else if (registry.completedAgents) {
              // Fallback: filter by taskId manually
              completedAgentsList = Array.from(registry.completedAgents.values())
                .filter(a => a.mission?.taskId === taskId);
              hasCompletedAgents = completedAgentsList.length > 0;
            }
            
            // NEW: Also check results queue for integrated results
            // This ensures tasks can be completed even after process restarts
            // FIX (Jan 21, 2026): Use getResultsForTask if available, otherwise skip
            if (this.agentExecutor.resultsQueue?.getResultsForTask) {
              const queueResults = this.agentExecutor.resultsQueue.getResultsForTask(taskId);
              if (queueResults.length > 0) {
                hasCompletedAgents = true;
                // Avoid duplicates if already in completedAgentsList
                for (const qr of queueResults) {
                  if (!completedAgentsList.some(a => (a.agentId || a.id) === qr.agentId)) {
                    completedAgentsList.push(qr);
                  }
                }
              }
            }
          }
          
          // Also check current cycle's results queue - use taskId
          const currentCycleAgents = this.agentExecutor 
            ? Array.from(this.resultsQueue?.pending || [])
                .filter(r => r.status === 'completed' && r.mission?.taskId === taskId)
            : [];
          
          if (currentCycleAgents.length > 0) {
            hasCompletedAgents = true;
            completedAgentsList.push(...currentCycleAgents);
          }
          
          if (hasCompletedAgents) {
            this.logger.info('🔍 Task has completed agents, checking accomplishment (legacy path)', {
              taskId: currentTask.id,
              completedAgents: completedAgentsList.length,
              agentIds: completedAgentsList.map(a => a.agentId || a.id),
              cyclesSinceStart: this.cycleCount - (currentTask.startCycle || 0)
            });
            
            // EXECUTIVE RING: Check if agents actually accomplished work (not just completed)
            const accomplishedAgents = completedAgentsList.filter(agentState => {
              // Registry stores agent instance in .agent property
              const agent = agentState.agent || agentState;
              
              // 1. Try explicit accomplishment record (honest failure signal)
              let accomplishment = agent.accomplishment;
              
              // 2. FALLBACK: Re-assess if missing (e.g. from hydration or older version)
              if (!accomplishment) {
                this.logger.debug('Re-assessing accomplishment for agent', { agentId: agent.agentId });
                const findings = agent.results?.filter(r => r.type === 'finding') || [];
                const insights = agent.results?.filter(r => r.type === 'insight') || [];
                const deliverables = agent.results?.filter(r => r.type === 'deliverable') || [];
                const metadata = agent.metadata || {};
                
                const hasSubstantiveOutput = findings.length > 0 || 
                                           insights.length > 0 || 
                                           deliverables.length > 0 ||
                                           metadata.documentsAnalyzed > 0 || 
                                           metadata.artifactsCreated > 0 ||
                                           metadata.filesCreated > 0 ||
                                           metadata.reportGenerated === true;
                
                accomplishment = {
                  accomplished: hasSubstantiveOutput,
                  reason: hasSubstantiveOutput ? null : 'No substantive output detected on re-assessment'
                };
              }
              
              // STRICT: Must have explicit accomplishment marked true AND completed status
              const isAccomplished = accomplishment.accomplished === true && 
                                   (agent.status === 'completed' || agent.status === 'done');
              
              if (!isAccomplished) {
                this.logger.warn('⚠️ Agent not accomplished', {
                  agentId: agent.agentId || agent.id,
                  status: agent.status,
                  reason: accomplishment.reason || 'Missing accomplishment record',
                  outputCount: agent.results?.length || 0
                });
              }
              return isAccomplished;
            });
            
            const unproductiveAgents = completedAgentsList.filter(a =>
              a.status === 'completed_unproductive' ||
              a.accomplishment?.accomplished === false
            );
            
            this.logger.info('📊 Accomplishment summary', {
              taskId: currentTask.id,
              total: completedAgentsList.length,
              accomplished: accomplishedAgents.length,
              unproductive: unproductiveAgents.length
            });
            
            if (unproductiveAgents.length > 0 && accomplishedAgents.length === 0) {
              // ALL agents were unproductive - task has failed
              const firstReason = unproductiveAgents[0].accomplishment?.reason || 'No output produced';
              
              this.logger.error('❌ Task failed: all agents completed without producing useful output', {
                taskId: currentTask.id,
                unproductiveCount: unproductiveAgents.length,
                reasons: unproductiveAgents.map(a => a.accomplishment?.reason).slice(0, 3)
              });
              
              const failureReason = `All ${unproductiveAgents.length} assigned agent(s) completed without producing useful output. First failure: ${firstReason}`;
              
              // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Enqueue failure instead of direct write
              if (this.taskStateQueue) {
                await this.taskStateQueue.enqueue({
                  type: 'FAIL_TASK',
                  taskId: currentTask.id,
                  cycle: this.cycleCount,
                  phaseName: currentTask.title,
                  reason: failureReason,
                  source: 'agents_unproductive'
                });
              } else {
                // Fallback to direct write if queue not available
                await this.clusterStateStore.failTask(currentTask.id, failureReason);
                
                // Record plan event for progress spine
                const phaseNum = currentTask.id.match(/phase(\d+)/)?.[1] || '?';
                const retryCount = (currentTask.metadata?.retryCount || 0) + 1;
                this.recordPlanEvent('phase_failed', {
                  phaseNumber: phaseNum,
                  phaseName: currentTask.title,
                  description: `Phase ${phaseNum} failed (attempt ${retryCount}): All agents unproductive`,
                  reason: failureReason
                });
              }
              
              // CRITICAL: Inject urgent goal to fix the blocker
              if (this.coordinator && this.goals) {
                await this.coordinator.injectUrgentGoals([{
                  description: `BLOCKED TASK: "${currentTask.title}" failed because agents produced no output. ${firstReason}. Investigate and resolve blocking issues before retrying.`,
                  agentType: currentTask.metadata?.agentType || 'research',
                  priority: 0.95,
                  urgency: 'critical',
                  rationale: `Task ${currentTask.id} blocking milestone ${currentTask.milestoneId}`
                }], this.goals);
              }
              
              // Don't run normal validation - task already failed
            } else {
              // Otherwise proceed with normal acceptance validation for accomplished agents only
              
            // CRITICAL FIX (Jan 20, 2026): Reload task AFTER queue processing to get registered artifacts
            // The queue processed artifact registration, so we need the updated task object
            const freshTask = await this.clusterStateStore.getTask(currentTask.id);
            if (freshTask) {
              currentTask = freshTask; // Use the updated task with artifacts
            }
              
            const artifacts = accomplishedAgents.flatMap(agentState => {
              // Registry stores agent instance in .agent property
              const agent = agentState.agent || agentState;
              const results = agent.results || agent.mission?.results || [];
              return results.map(r => ({
                type: r.type || 'finding',
                content: r.content || r.text || r.summary,
                metadata: r.metadata,
                source: agent.agentId || agent.id,
                timestamp: new Date()
              }));
            });
            
            // Add current thought as artifact
            artifacts.push({
              type: 'thought',
              content: thought.hypothesis,
              reasoning: thought.reasoning,
              cycle: this.cycleCount,
              timestamp: new Date()
            });
            
            // CRITICAL FIX (Jan 20, 2026): Include registered task artifacts from files
            // These are the actual deliverables found on disk that were registered by AgentExecutor
            if (currentTask.artifacts && Array.isArray(currentTask.artifacts)) {
              this.logger.debug('Including registered task artifacts in validation', {
                taskId: currentTask.id,
                registeredArtifacts: currentTask.artifacts.length,
                fromAgentResults: artifacts.length
              });
              
              for (const taskArtifact of currentTask.artifacts) {
                artifacts.push({
                  type: 'file',
                  content: `File: ${taskArtifact.path} (${taskArtifact.size} bytes)`,
                  path: taskArtifact.absolutePath || taskArtifact.path,
                  metadata: taskArtifact,
                  source: taskArtifact.agentId,
                  timestamp: new Date(taskArtifact.recordedAt || Date.now())
                });
              }
            }
            
            if (!this.acceptanceValidator) {
              this.acceptanceValidator = new AcceptanceValidator(this.agentExecutor, this.logger);
            }
            
            const validation = await this.acceptanceValidator.checkAll(
              currentTask.acceptanceCriteria,
              artifacts
            );
            
            // Mark validation attempted (prevent repeated attempts)
            currentTask.metadata = currentTask.metadata || {};
            currentTask.metadata.validationAttempted = true;
            currentTask.metadata.validationCycle = this.cycleCount;
            await this.clusterStateStore.upsertTask(currentTask);
            
            if (validation.passed) {
              // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Enqueue completion instead of direct write
              if (this.taskStateQueue) {
                await this.taskStateQueue.enqueue({
                  type: 'COMPLETE_TASK',
                  taskId: currentTask.id,
                  cycle: this.cycleCount,
                  phaseName: currentTask.title,
                  artifactCount: artifacts.length,
                  source: 'validation_passed'
                });
              } else {
                // Fallback to direct write if queue not available
                await this.clusterStateStore.completeTask(currentTask.id);
                
                // Record plan event for progress spine
                const phaseNum = currentTask.id.match(/phase(\d+)/)?.[1] || '?';
                this.recordPlanEvent('phase_completed', {
                  phaseNumber: phaseNum,
                  phaseName: currentTask.title,
                  description: `Phase ${phaseNum} complete: ${currentTask.title?.substring(0, 100)}`,
                  artifacts: artifacts.length
                });
              }
              
              this.logger.info('✅ Task completed with acceptance', { 
                taskId: currentTask.id,
                artifactsChecked: artifacts.length,
                agentsInvolved: accomplishedAgents.length
              });
              
              // Check if milestone complete
              await this.checkMilestoneCompletion(currentTask.planId, currentTask.milestoneId);
            } else {
              const failureReason = validation.failures.map(f => f.reason).join('; ');
              
              // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Enqueue failure instead of direct write
              if (this.taskStateQueue) {
                await this.taskStateQueue.enqueue({
                  type: 'FAIL_TASK',
                  taskId: currentTask.id,
                  cycle: this.cycleCount,
                  phaseName: currentTask.title,
                  reason: failureReason,
                  source: 'validation_failed'
                });
              } else {
                // Fallback to direct write if queue not available
                await this.clusterStateStore.failTask(currentTask.id, failureReason);
                
                // Record plan event for progress spine
                const phaseNum = currentTask.id.match(/phase(\d+)/)?.[1] || '?';
                const retryCount = (currentTask.metadata?.retryCount || 0) + 1;
                this.recordPlanEvent('phase_failed', {
                  phaseNumber: phaseNum,
                  phaseName: currentTask.title,
                  description: `Phase ${phaseNum} failed (attempt ${retryCount}): ${failureReason?.substring(0, 100)}`,
                  reason: failureReason
                });
              }
              
              this.logger.warn('❌ Task failed acceptance validation', {
                taskId: currentTask.id,
                failures: validation.failures,
                artifactsChecked: artifacts.length
              });
            }
            } // Close else block for unproductive check
          } else if (!currentTask.metadata?.validationAttempted) {
            // No agents completed yet - still waiting
            this.logger.debug('⏳ Task waiting for agents to complete (legacy path)', {
              taskId: currentTask.id,
              activeAgents: this.agentExecutor ? this.agentExecutor.registry.activeAgents.size : 0
            });
          }
        }
      }
      
      // Update TUI dashboard with complete cycle data
      if (this.tuiDashboard) {
        this.tuiDashboard.updateCycle({
          cycle: this.cycleCount,
          role: role.id,
          thought: thought.hypothesis,
          cognitiveState: { ...cognitiveState },
          oscillatorMode: this.oscillator.getCurrentMode()
        });
        
        // Update goals stats
        const allGoals = this.goals.getGoals();
        this.tuiDashboard.updateGoals({
          created: allGoals.length,
          pursued: allGoals.filter(g => g.progress > 0).length,
          completed: allGoals.filter(g => g.completed).length
        });
        
        // Update memory stats
        this.tuiDashboard.updateMemory({
          nodes: this.memory.nodes.size,
          edges: this.memory.edges.size
        });
        
        // Update agents if executor available
        if (this.agentExecutor) {
          const activeAgents = Array.from(this.agentExecutor.registry.activeAgents.values()).map(agent => {
            const progressReports = Array.isArray(agent.progressReports) ? agent.progressReports : [];
            return {
              agentId: agent.agentId,
              type: agent.constructor.name.replace('Agent', '').toLowerCase(),
              status: agent.status,
              progress: progressReports.length > 0 ? progressReports[progressReports.length - 1].percent : 0,
              mission: agent.mission?.description,
              startTime: agent.startTime
            };
          });
          
          this.tuiDashboard.updateAgents(activeAgents);
        }
      }

      // 15. Periodic summarization (GPT-5.2)
      if (this.journal.length - this.lastSummarization >= 20) {
        await this.performSummarization();
      }

      // 16. Periodic consolidation
      const timeSinceConsolidation = Date.now() - this.lastConsolidation.getTime();
      if (timeSinceConsolidation > 1800000) {
        await this.performMemoryConsolidation();
      }

      // 17. Reflection
      if (this.cycleCount % 20 === 0) {
        await this.performReflection();
      }

      // 18. Thermodynamic adjustment (only if surpriseEnabled - backward compatible: default true)
      const surpriseEnabled = this.config.architecture.thermodynamic?.surpriseEnabled !== false;
      if (surpriseEnabled) {
        const adjustment = this.thermodynamic.suggestAdjustment();
        if (adjustment.action !== 'maintain') {
          this.logger.info('Thermodynamic adjustment', adjustment);
          
          if (adjustment.action === 'explore') {
            this.oscillator.forceExploration('thermodynamic_adjustment');
          }
        }
      }

      // 19. Adaptive oscillator
      this.oscillator.adaptCycleTiming({
        fatigueLevel: 1 - this.stateModulator.getState().energy,
        stagnationDetected: this.chaotic.detectStagnation(
          this.journal.slice(-5).map(j => j.thought).join(' ')
        ),
        recentProgress: this.calculateRecentProgress()
      });

      // 20. Record performance
      this.roles.recordPerformance(role.id, true, { surprise });

      // 21. Network maintenance with Watts-Strogatz rewiring
      if (this.cycleCount % 30 === 0) {
        // Wake state: low rewiring probability for stability
        await this.memory.rewire(0.01);
        await this.memory.applyDecay();
        
        // Ultra-conservative garbage collection - only removes truly abandoned nodes
        // Requires ALL: weight < 0.01 AND not accessed in 2+ YEARS
        // Protected tags, consolidated nodes, and merged nodes are NEVER deleted
        const removed = this.summarizer.garbageCollect(this.memory);
        // Logging is handled inside garbageCollect now

        const pruned = this.roles.pruneRoles();
        if (pruned > 0) {
          this.logger.info(`Pruned ${pruned} roles`);
        }

        this.goals.elevateStalePriorities();
        this.goals.mergeSimilarGoals();
        
        // Check for auto-training (latent projector)
        if (this.quantum?.latentProjector) {
          try {
            const shouldTrain = await this.quantum.latentProjector.shouldAutoTrain();
            if (shouldTrain) {
              this.logger.info('🎓 Triggering auto-training for latent projector...');
              await this.quantum.latentProjector.autoTrain();
            }
          } catch (error) {
            this.logger.warn('Auto-training check failed', { error: error.message });
          }
        }
      }
      
      // PRODUCTION: Save state EVERY cycle for real-time tracking
      // Modern SSDs handle this fine, and real-time dashboard is worth it
      // State is compressed (6-10MB) and saved async
      await this.saveState();

      // Note: Agent results processing moved to before coordinator review (line ~129)
      // to ensure strategic decisions use up-to-date goal progress and agent findings

      this.thermodynamic.advanceAnnealing();

      const cycleDuration = Date.now() - cycleStart.getTime();
      this.logger.info(`✓ Cycle completed in ${cycleDuration}ms (GPT-5.2)`);
      
      // Phase A: Take resource snapshot
      const resourceSnapshot = this.resourceMonitor.snapshot();
      
      // Phase A: Save checkpoint periodically (every 5 cycles)
      if (this.cycleCount % 5 === 0) {
        try {
          // Build checkpoint state (same structure as saveState())
          const checkpointState = {
            cycleCount: this.cycleCount,
            journal: this.journal.slice(-100),
            memory: this.memory.exportGraph(),
            goals: this.goals.export(),
            roles: this.roles.getRoles(),
            reflection: this.reflection.export(),
            oscillator: this.oscillator.getStats(),
            coordinator: this.coordinator ? this.coordinator.export() : null,
            agentExecutor: this.agentExecutor ? this.agentExecutor.exportState() : null,
            forkSystem: this.forkSystem ? this.forkSystem.export() : null,
            topicQueue: this.topicQueue ? this.topicQueue.export() : null,
            goalCurator: this.goalCurator ? this.goalCurator.export() : null,
            guidedMissionPlan: this.guidedMissionPlan || null,
            completionTracker: this.completionTracker || null,
            lastSummarization: this.lastSummarization
          };
          await this.crashRecovery.saveCheckpoint(checkpointState, this.cycleCount);
        } catch (error) {
          this.logger.error('[Phase A] Checkpoint save failed (non-fatal)', {
            cycle: this.cycleCount,
            error: error.message
          });
          // Don't crash the cycle - checkpoint failure is non-fatal
        }
      }
      
      // Phase A: Record cycle metrics
      try {
        this.telemetry.recordCycleMetrics(this.cycleCount, {
          cycleTimeMs: cycleDuration,
          memoryMB: resourceSnapshot.memUsedMB,
          activeGoals: this.goals.getGoals().filter(g => !g.completed).length,
          errors: 0
        });
      } catch (error) {
        this.logger.error('[Phase A] Telemetry recording failed (non-fatal)', {
          error: error.message
        });
      }
      
      // Track cycle completion in evaluation framework
      if (this.evaluation) {
        if (this.latestBranchMetadata) {
          const branchSnapshot = {
            cycle: this.latestBranchMetadata.cycle,
            timestamp: this.latestBranchMetadata.timestamp,
            selectedBranchId: this.latestBranchMetadata.selectedBranchId || null,
            reward: this.latestBranchMetadata.reward || 0,
            branches: this.latestBranchMetadata.branches.map(branch => ({
              branchId: branch.branchId,
              branchIndex: branch.branchIndex,
              cycle: branch.cycle ?? this.cycleCount,
              reasoningEffort: branch.reasoningEffort,
              usedWebSearch: branch.usedWebSearch,
              model: branch.model,
              durationMs: branch.durationMs,
              hadError: branch.hadError || false,
              promptDigest: branch.promptDigest || null,
              promptPreview: branch.promptPreview || null,
              decisionSource: branch.decisionSource || 'default'
            }))
          };

          await this.evaluation.trackBranchMetadata(branchSnapshot);
        }

        this.evaluation.trackCycleComplete(
          cycleDuration,
          1, // thought count (1 per cycle in current design)
          0  // cost tracking TBD
        );
        
        // Track memory state
        const clusters = this.memory.clusters || {};
        const clusterKeys = Object.keys(clusters);
        const avgClusterSize = clusterKeys.length > 0
          ? Object.values(clusters).reduce((sum, c) => sum + c.length, 0) / clusterKeys.length
          : 0;
        const protectedNodes = Array.from(this.memory.nodes.values())
          .filter(n => n.tags && n.tags.includes('protected'))
          .length;
          
        this.evaluation.trackMemoryState({
          nodes: this.memory.nodes.size,
          edges: this.memory.edges.size,
          avgClusterSize,
          protectedNodes
        });

        // Reset branch metadata after logging to avoid duplicate writes
        this.latestBranchMetadata = null;
      } else {
        this.latestBranchMetadata = null;
      }

    } catch (error) {
      this.logger.error('Cycle error', { error: error.message, stack: error.stack });

      this.stateModulator.updateState({
        type: 'error',
        success: false,
        surprise: 0.5
      });
    } finally {
      // Phase A: Always cancel cycle timeout (success or failure)
      this.timeoutManager.cancelCycleTimer();
    }

    this.lastCycleTime = new Date();
  }

  /**
   * Filter memory context for independent goals
   * Removes nodes tagged with guided plan provenance
   * 
   * @param {Array} memoryNodes - Raw memory query results
   * @returns {Array} - Filtered memory nodes
   */
  filterIndependentMemory(memoryNodes) {
    const originalCount = memoryNodes.length;
    
    const filtered = memoryNodes.filter(node => {
      const tags = node.tags || [];
      const metadata = node.metadata || {};
      
      // Filter out nodes from guided plan:
      // - Explicitly tagged for guided plan
      // - Agent outputs from guided tasks
      // - Memory created during guided task execution
      const isGuidedPlanWork = 
        tags.includes('guided_plan') ||
        tags.includes('mission_plan') ||
        tags.includes('task_deliverable') ||
        metadata.isTaskGoal ||
        metadata.guidedDomain ||
        metadata.phaseNumber ||  // Task phase indicators
        metadata.agentType === 'task_agent';
      
      return !isGuidedPlanWork;
    });
    
    if (filtered.length < originalCount) {
      this.logger.debug('🔒 Filtered guided plan memory for independent goal', {
        originalNodes: originalCount,
        filteredNodes: filtered.length,
        removed: originalCount - filtered.length
      });
    }
    
    return filtered;
  }

  async handleClusterCycleSync(cycle) {
    const clusterContext = this.memory?.__cluster;
    if (!this.clusterOrchestrator || !clusterContext) {
      return;
    }

    if (typeof clusterContext.isClusterEnabled === 'function' && !clusterContext.isClusterEnabled()) {
      return;
    }

    try {
      const diff = await clusterContext.getCycleDiff(cycle);
      if (diff) {
        await clusterContext.submitCycleDiff(cycle, diff);
      }

      const syncStart = Date.now();
      let syncResult = { success: true, metrics: {} };
      if (typeof this.clusterOrchestrator.completeCycleSync === 'function') {
        const result = await this.clusterOrchestrator.completeCycleSync(cycle, {
          diffSubmitted: Boolean(diff)
        });
        if (result) {
          syncResult = result;
        }
      }

      await clusterContext.fetchMergedState(cycle);
      const syncDuration = Date.now() - syncStart;

      const metrics = syncResult.metrics || {};
      const barrierMetrics = metrics.barrier || {};
      const mergeMetrics = metrics.merge || (this.clusterSync?.merge || null);
      const proceedMs = metrics.proceedBroadcastMs ?? metrics.proceedWaitMs ?? 0;
      const success = syncResult.success !== false;

      this.clusterSync = {
        ...this.clusterSync,
        enabled: true,
        lastCycle: cycle,
        lastRole: metrics.role || (this.clusterOrchestrator.isLeader ? 'leader' : 'follower'),
        lastDiffSubmitted: Boolean(diff),
        barrier: {
          reached: typeof barrierMetrics.reached === 'boolean' ? barrierMetrics.reached : this.clusterSync.barrier?.reached ?? null,
          waitedMs: barrierMetrics.waitedMs ?? this.clusterSync.barrier?.waitedMs ?? 0
        },
        merge: mergeMetrics,
        proceedMs,
        syncDurationMs: syncDuration,
        success,
        failureStreak: success ? 0 : (this.clusterSync.failureStreak || 0) + 1,
        lastUpdated: new Date().toISOString()
      };

      this.logger.debug('[ClusterSync] Cycle synchronized', {
        cycle,
        diffSubmitted: Boolean(diff),
        durationMs: syncDuration,
        role: this.clusterSync.lastRole,
        barrierMs: this.clusterSync.barrier.waitedMs,
        merge: mergeMetrics,
        success
      });
    } catch (error) {
      this.logger.error('[ClusterSync] Synchronization failed', {
        cycle,
        error: error.message
      });
    }
  }

  /**
   * Deep sleep with GPT-5.2 enhanced processing
   * Returns: { consolidated: boolean, deferred: boolean, reason: string, nextAvailableIn: string }
   */
  async performDeepSleepConsolidation() {
    // Rate limit consolidations to prevent thrashing (skip in dream mode)
    if (!this.config.execution?.dreamModeSettings?.disableConsolidationRateLimit) {
      if (this.temporal.lastConsolidationTime) {
        const timeSinceLastConsolidation = Date.now() - this.temporal.lastConsolidationTime;
        if (timeSinceLastConsolidation < this.temporal.minConsolidationInterval) {
          const nextAvailableMs = this.temporal.minConsolidationInterval - timeSinceLastConsolidation;
          const nextAvailableMin = Math.round(nextAvailableMs / 1000 / 60);
          
          return {
            consolidated: false,
            deferred: true,
            reason: 'rate_limit',
            timeSinceLast: Math.round(timeSinceLastConsolidation / 1000 / 60) + 'min',
            minimumInterval: Math.round(this.temporal.minConsolidationInterval / 1000 / 60) + 'min',
            nextAvailableIn: nextAvailableMin + 'min'
          };
        }
      }
    }
    
    // Mark consolidation start time
    this.temporal.lastConsolidationTime = Date.now();
    
    this.logger.info('');
    this.logger.info('╔═══════════════════════════════════════════════════╗');
    this.logger.info('║     DEEP SLEEP CONSOLIDATION (GPT-5.2)          ║');
    this.logger.info('╚═══════════════════════════════════════════════════╝');
    
    // 1. Summarize with GPT-5.2 extended reasoning
    this.logger.info('📚 Summarizing with GPT-5.2 extended reasoning...');
    if (this.journal.length > this.lastSummarization) {
      const summary = await this.summarizer.summarizeRecentThoughts(
        this.journal,
        this.lastSummarization
      );

      if (summary) {
        const summaryValidation = validateAndClean(`[SUMMARY] ${summary.content}`);
        if (summaryValidation.valid) {
          await this.memory.addNode(
            summaryValidation.content,
            'summary'
          );

          if (summary.reasoning) {
            this.logger.info('  Reasoning process logged', {
              reasoningLength: summary.reasoning.length
            });
          }

          this.lastSummarization = this.journal.length;
          
          this.logger.info('✓ Memory summarized (GPT-5.2)', {
            entries: summary.sourceEntries,
            topics: summary.topics,
            model: summary.model
          });
        } else {
          this.logger.warn('⚠️  Skipped invalid summary', {
            reason: summaryValidation.reason
          });
        }
      }
    }

    // 2. Consolidate with GPT-5.2 deep reasoning
    this.logger.info('🔗 Consolidating with GPT-5.2 deep reasoning...');
    const consolidations = await this.summarizer.consolidateMemories(this.memory);
    
    if (consolidations.length > 0) {
      for (const cons of consolidations) {
        // Robust validation for consolidation
        const consolidationValidation = validateAndClean(`[CONSOLIDATED] ${cons.consolidated}`);
        if (consolidationValidation.valid) {
          await this.memory.addNode(
            consolidationValidation.content,
            'consolidated'
          );
          
          this.logger.info('✓ Consolidated (GPT-5.2)', {
            sourceNodes: cons.sourceNodes.length,
            hasReasoning: Boolean(cons.reasoning),
            concept: consolidationValidation.content.substring(0, 60)
          });
        } else {
          this.logger.warn('⚠️  Skipped invalid consolidation', {
            sourceNodes: cons.sourceNodes.length,
            reason: consolidationValidation.reason,
            content: typeof cons.consolidated === 'string' ? cons.consolidated.substring(0, 100) : String(cons.consolidated)
          });
        }
      }
    }

    this.lastConsolidation = new Date();

    // 3. Analyze journal for goals with GPT-5
    // CONSOLIDATION MODE: Skip goal creation - only consolidate existing knowledge
    // Check for both boolean true and string 'true' (YAML parsing variance)
    const consolidationModeValue = this.config.execution?.consolidationMode;
    const isConsolidationMode = consolidationModeValue === true || consolidationModeValue === 'true';
    this.logger.info('📊 Consolidation mode check', { 
      consolidationModeValue,
      consolidationModeType: typeof consolidationModeValue,
      isConsolidationMode
    });
    if (isConsolidationMode) {
      this.logger.info('🎯 Skipping goal analysis (consolidation mode - no new goals)');
    } else {
      this.logger.info('🎯 Analyzing for goals (GPT-5.2 extended reasoning)...');
      // DISABLED: Sleep analysis goal creation
      // Sleep analysis is for memory consolidation, not goal generation.
      // Goals should come from meta-coordinator based on guided plan.
      /*
      const journalGoals = await this.goalCapture.analyzeJournalForGoals(this.journal);

      for (const goal of journalGoals) {
        if (this.goals.getGoals().length < this.config.architecture.goals.maxGoals) {
          const priorityValue = goal.priority === 'high' ? 0.8 :
                               goal.priority === 'low' ? 0.3 : 0.5;

          const newGoal = this.goals.addGoal({
            description: goal.text,
            reason: goal.reason || 'GPT-5.2 sleep analysis',
            uncertainty: priorityValue,
            source: 'sleep_analysis_gpt5'
          });

          if (newGoal) {
            if (this.evaluation) {
              this.evaluation.trackGoalCreated(newGoal.id, newGoal);
            }
            if (this.goalCurator) {
              await this.goalCurator.handleEvent({
                type: 'created',
                goalId: newGoal.id,
                goal: newGoal,
                cycle: this.cycleCount
              });
            }
          }
        }
      }

      if (journalGoals.length > 0) {
        this.logger.info('✓ Goals identified (GPT-5.2)', { count: journalGoals.length });
      }
      */

      this.logger.info('Sleep analysis complete (goal creation disabled)');
    }

    // 4. DREAM MODE with GPT-5.2 high creativity
    this.logger.info('💭 Entering dream mode (GPT-5.2)...');
    this.temporal.enterDreamMode();
    
    // Use custom dream count if in dream mode, otherwise 2-3 random
    const dreamCount = this.config.execution?.dreamModeSettings?.dreamsPerCycle 
      || (2 + Math.floor(Math.random() * 2));
    
    for (let i = 0; i < dreamCount; i++) {
      const dreamPrompt = this.generateDreamPrompt();
      
      try {
        const dreamThought = await this.quantum.singleReasoning(dreamPrompt, {
          // GPT-5.2 doesn't support temperature parameter
        });

        // VOICE SYSTEM DISABLED FOR DREAMS: Dreams are saved but don't voice
        // This prevents dream content from clogging the voice stream
        // if (dreamThought.hypothesis) {
        //   dreamThought.hypothesis = this.parseForVoice(dreamThought.hypothesis);
        // }

        this.logger.info(`  Dream ${i + 1} (${dreamThought.model}):`, {
          thought: dreamThought.hypothesis.substring(0, 120),
          hasReasoning: Boolean(dreamThought.reasoning)
        });

        if (dreamThought.reasoning) {
          this.logger.info(`    Reasoning: ${dreamThought.reasoning.substring(0, 100)}...`);
        }

        // ALWAYS save full dreams to dedicated file (true gold!)
        // AUDIT: Add unique dream ID for traceability (dream→goal→research pathway)
        const dreamId = `dream_cycle${this.cycleCount}_${i + 1}`;
        await this.saveDream({
          id: dreamId,  // Unique ID for dream→goal→research audit trail
          cycle: this.cycleCount,
          dreamNumber: i + 1,
          timestamp: new Date().toISOString(),
          content: dreamThought.hypothesis,
          reasoning: dreamThought.reasoning || null,
          model: dreamThought.model || 'gpt-5-2025-08-07',
          cognitiveState: {
            energy: this.stateModulator.getState().energy,
            mood: this.stateModulator.getState().mood,
            curiosity: this.stateModulator.getState().curiosity
          }
        });

        // DISABLED: Dream goal creation
        // Dreams are for creative exploration and memory consolidation, not goal generation.
        // Goals should come from meta-coordinator based on guided plan or explicit autonomous research.
        // Keeping this code commented for potential future use with proper domain filtering:
        /*
        if (!isConsolidationMode) {
          const dreamGoals = await this.goalCapture.captureGoalsFromOutput(dreamThought.hypothesis);
          for (const dg of dreamGoals) {
            if (Math.random() < 0.3) {
              const newGoal = this.goals.addGoal({
                description: dg.text,
                reason: 'Emerged from GPT-5.2 dream state',
                uncertainty: 0.6,
                source: 'dream_gpt5',
                metadata: {
                  dreamId: dreamId,
                  dreamCycle: this.cycleCount,
                  dreamTimestamp: new Date().toISOString(),
                  dreamContentSnippet: dreamThought.hypothesis.substring(0, 200)
                }
              });

              if (newGoal) {
                if (this.evaluation) {
                  this.evaluation.trackGoalCreated(newGoal.id, newGoal);
                }
                if (this.goalCurator) {
                  await this.goalCurator.handleEvent({
                    type: 'created',
                    goalId: newGoal.id,
                    goal: newGoal,
                    cycle: this.cycleCount
                  });
                }
              }
            }
          }
        }
        */

        // Add dreams to memory (with robust validation)
        if (Math.random() < 0.2) {
          const dreamValidation = validateAndClean(`[DREAM] ${dreamThought.hypothesis}`);
          if (dreamValidation.valid) {
            await this.memory.addNode(
              dreamValidation.content,
              'dream'
            );
          }
        }
      } catch (error) {
        this.logger.error('Dream generation failed', { error: error.message });
      }
    }

    // Chaotic memory rewiring during dream state (Watts-Strogatz)
    if (this.config.architecture.temporal.dreamRewiring !== false) {
      this.logger.info('🔀 Dream-state memory rewiring...');
      this._getEvents().emitEvent('dream_phase', { phase: 'rewiring', status: 'started' });
      const rewiringP = this.config.architecture.temporal.dreamRewiringProbability || 0.5;
      const rewired = await this.memory.rewire(rewiringP);
      this.logger.info('✓ Dream rewiring complete', { edgesRewired: rewired });
      this._getEvents().emitEvent('dream_phase', { phase: 'rewiring', status: 'complete', edgesRewired: rewired });
    } else {
      this.logger.debug('⏭️  Dream rewiring skipped (disabled in config)');
    }

    this.temporal.exitDreamMode();
    this.logger.info('✓ Dream mode complete (GPT-5.2)');

    // 5. Memory cleanup
    this.logger.info('🗑️  Memory cleanup...');
    this._getEvents().emitEvent('dream_phase', { phase: 'cleanup', status: 'started' });
    const removed = this.summarizer.garbageCollect(this.memory);
    this.logger.info('✓ Cleanup complete', { removed });
    this._getEvents().emitEvent('dream_phase', { phase: 'cleanup', status: 'complete', nodesRemoved: removed });

    // 6. Reset state
    this.logger.info('🔄 Resetting cognitive state...');
    this._getEvents().emitEvent('dream_phase', { phase: 'state_reset', status: 'started' });
    const currentMood = this.stateModulator.getState().mood;

    if (currentMood < 0.3) {
      this.stateModulator.updateState({
        type: 'sleep_recovery',
        valence: 0.2,
        surprise: 0
      });
    }

    this.logger.info('✓ State adjusted');
    this._getEvents().emitEvent('dream_phase', { phase: 'state_reset', status: 'complete' });

    this._getEvents().emitEvent('dream_phase', { phase: 'save_state', status: 'started' });
    await this.saveState();
    this._getEvents().emitEvent('dream_phase', { phase: 'save_state', status: 'complete' });

    this.logger.info('');
    this.logger.info('╔═══════════════════════════════════════════════════╗');
    this.logger.info('║   DEEP SLEEP CONSOLIDATION COMPLETE (GPT-5.2)   ║');
    this.logger.info('╚═══════════════════════════════════════════════════╝');
    this.logger.info('');

    this._getEvents().emitEvent('sleep_consolidation_complete', { status: 'success' });
    
    // Return success status
    return {
      consolidated: true,
      deferred: false,
      reason: 'success'
    };
  }

  generateDreamPrompt() {
    // Check if in pure mode
    const explorationMode = this.config?.architecture?.roleSystem?.explorationMode || 'autonomous';
    
    if (explorationMode === 'pure') {
      // PURE MODE: Minimal dream prompting - just continuation
      return '...';  // Ellipsis suggests continuation/drift
    }
    
    // NORMAL MODE: Full creative dream prompts
    const prompts = [
      "Generate a surreal scenario combining disparate concepts from recent learning",
      "Imagine an impossible situation that reveals hidden patterns",
      "Create an abstract metaphor connecting unrelated domains",
      "Envision a fantastical explanation for a mundane phenomenon",
      "Construct a paradoxical thought experiment",
      "Weave together random memories into an insight-generating narrative"
    ];

    const basePrompt = prompts[Math.floor(Math.random() * prompts.length)];

    // VOICE CONTEXT DISABLED FOR DREAMS: Dreams should not have voice capability
    // This prevents confusion since dream voice parsing is disabled
    // if (this.voiceEnabled) {
    //   return `${basePrompt}
    //
    // ${this.getVoiceContext()}`;
    // }

    return basePrompt;
  }

  /**
   * Get the voice context to add to prompts
   * This tells COSMO it has a voice channel available
   */
  getVoiceContext() {
    return `You have a voice channel - a direct line to your human partner. If something you're thinking wants to be heard by them, you can speak by writing [VOICE]: followed by what you want to say. This is always available. Use it when you want to, or don't. There are no rules about when to use it. It's yours.`;
  }

  selectExplorationGoal() {
    const goals = this.goals.getGoals();
    if (goals.length === 0) return null;
    return goals[Math.floor(Math.random() * goals.length)];
  }

  async performSummarization() {
    this.logger.info('📚 Summarizing (GPT-5.2 extended reasoning)...');

    const summary = await this.summarizer.summarizeRecentThoughts(
      this.journal,
      this.lastSummarization
    );

    // Add summary to memory (with robust validation)
    if (summary && summary.content) {
      const summaryValidation = validateAndClean(`[SUMMARY] ${summary.content}`);
      if (summaryValidation.valid) {
        await this.memory.addNode(
          summaryValidation.content,
          'summary'
        );

        this.lastSummarization = this.journal.length;

        this.logger.info('Summary created (GPT-5.2)', {
          entries: summary.sourceEntries,
          topics: summary.topics,
          hasReasoning: Boolean(summary.reasoning),
          model: summary.model
        });
      } else {
        this.logger.warn('⚠️  Skipped invalid summary', {
          reason: summaryValidation.reason,
          hasContent: Boolean(summary.content),
          length: summary.content?.length || 0
        });
      }
    }
  }

  async performMemoryConsolidation() {
    this.logger.info('🔗 Consolidating (GPT-5.2 deep reasoning)...');

    const consolidations = await this.summarizer.consolidateMemories(this.memory, 0.75);

    let validCount = 0;
    for (const cons of consolidations) {
      // Robust validation for consolidation
      const consolidationValidation = validateAndClean(`[CONSOLIDATED] ${cons.consolidated}`);
      if (consolidationValidation.valid) {
        await this.memory.addNode(
          consolidationValidation.content,
          'consolidated'
        );
        validCount++;
      } else {
        this.logger.warn('⚠️  Skipped invalid consolidation', {
          sourceNodes: cons.sourceNodes?.length || 0,
          reason: consolidationValidation.reason,
          content: typeof cons.consolidated === 'string' ? cons.consolidated.substring(0, 100) : String(cons.consolidated)
        });
      }
    }

    this.lastConsolidation = new Date();

    if (validCount > 0) {
      this.logger.info('Consolidation complete (GPT-5.2)', {
        created: validCount,
        skipped: consolidations.length - validCount
      });
    }
  }

  async performReflection() {
    this.logger.info('🔍 Reflecting (GPT-5.2 meta-analysis)...');

    const analysis = await this.reflection.analyzeJournal(this.journal);
    
    if (analysis) {
      if (analysis.reasoning) {
        this.logger.info('Meta-cognitive reasoning available', {
          reasoningLength: analysis.reasoning.length
        });
      }

      const insights = this.reflection.getMetaCognitiveInsights();
      
      for (const insight of insights) {
        this.logger.info('Insight (GPT-5.2)', { 
          type: insight.type, 
          message: insight.message 
        });
      }
    }
  }

  /**
   * Run Meta-Coordinator strategic review
   */
  async runMetaCoordinatorReview() {
    // Prepare complete state snapshot for coordinator
    // INCLUDES: Active agents and in-progress work for strategic awareness
    const activeAgentsRaw = this.agentExecutor?.registry?.getActiveAgents() || [];
    const activeAgentsInfo = activeAgentsRaw.map(agent => ({
      agentId: agent.agentId,
      type: agent.agentType || agent.constructor?.name?.replace('Agent', '').toLowerCase() || 'unknown',
      status: agent.status || 'working',
      goal: agent.mission?.description?.substring(0, 100) || 'No description',
      goalId: agent.mission?.goalId || null,
      startTime: agent.startTime,
      progress: Array.isArray(agent.progressReports) && agent.progressReports.length > 0
        ? agent.progressReports[agent.progressReports.length - 1].percent
        : 0
    }));

    const phase2bState = {
      cycleCount: this.cycleCount,
      journal: this.journal,
      goals: this.goals.export(),
      goalsSystem: this.goals,
      memory: this.memory.exportGraph(),
      roles: this.roles.getRoles(),
      reflection: this.reflection.export(),
      oscillator: this.oscillator.getStats(),
      cognitiveState: this.stateModulator.getState(),
      // NEW: Active agents and work in progress
      activeAgents: activeAgentsInfo,
      activeAgentCount: activeAgentsInfo.length,
      // SITUATIONAL AWARENESS: Include current plan to prevent duplication
      guidedMissionPlan: this.guidedMissionPlan
    };

    let reviewRole = 'solo';

    if (this.clusterCoordinator && this.clusterCoordinator.isEnabled()) {
      try {
        const barrierDecision = await this.clusterCoordinator.coordinateReview(this.cycleCount, {
          clusterSize: this.config.cluster?.instanceCount || 1,
          specialization: this.coordinator?.lastSpecializationRouting || null,
          config: this.config.cluster?.coordinator  // FIX: Pass coordinator config (includes gating settings)
        });

        this.clusterSync.barrier = {
          reached: barrierDecision.status === 'proceed',
          waitedMs: barrierDecision.durationMs || 0,
          decision: barrierDecision.proceed ? 'proceed' : 'skip',
          quorum: barrierDecision.quorum,
          readyCount: barrierDecision.readyCount,
          readyInstances: barrierDecision.readyInstances || [],
          timestamp: new Date().toISOString(),
          reason: barrierDecision.reason || barrierDecision.status
        };
        this.clusterSync.reviewPlan = barrierDecision.planSummary || null;
        this.currentReviewPlan = barrierDecision.plan || null;
        reviewRole = this.determineReviewRole(this.currentReviewPlan);
        this.clusterSync.reviewPlanRole = reviewRole;
        this.clusterSync.governance = barrierDecision.governance || null;

        if (!barrierDecision.proceed) {
          this.logger.info('⏸️  Cluster review skipped', {
            cycle: this.cycleCount,
            reason: barrierDecision.reason,
            readyCount: barrierDecision.readyCount,
            quorum: barrierDecision.quorum
          });
          return;
        }
      } catch (error) {
        this.logger.error('Cluster coordinator barrier failed — continuing review solo', {
          error: error.message
        });
      }
    }

    // Conduct comprehensive review
    const reviewResult = await this.coordinator.conductReview(phase2bState);
    
    if (reviewResult) {
      // Apply prioritized goals if provided
      if (reviewResult.prioritizedGoals && reviewResult.prioritizedGoals.length > 0) {
        this.logger.info('Applying coordinator priorities', {
          topGoals: reviewResult.prioritizedGoals.length
        });
        
        // Boost priority of coordinator-selected goals
        for (const goal of reviewResult.prioritizedGoals) {
          const existingGoal = this.goals.getGoals().find(g => g.id === goal.id);
          if (existingGoal) {
            // Increase priority by coordinator recommendation
            this.goals.updateGoalProgress(goal.id, 0.05, 'Coordinator prioritized');
          }
        }
        
        // NEW: Apply archive recommendations from coordinator
        if (reviewResult.decisions?.goalsToArchive) {
          const archiveIds = this.extractGoalIds(reviewResult.decisions.goalsToArchive);
          if (archiveIds.length > 0) {
            const archived = this.goals.archiveGoalsByIds(
              archiveIds,
              'Meta-coordinator recommendation'
            );
            this.logger.info('📥 Archived goals per coordinator', {
              count: archived,
              recommended: archiveIds.length
            });
          }
        }

        // NEW: Spawn specialist agents for top priority goals
        if (this.agentExecutor) {
          await this.spawnAgentsForPriorities(reviewResult);
        }
        
        // CRITICAL: Spawn agents for urgent goals immediately after review
        if (this.agentExecutor && reviewResult.urgentGoalsCreated && reviewResult.urgentGoalsCreated.length > 0) {
          await this.spawnAgentsForUrgentGoals(reviewResult.urgentGoalsCreated);
        }

        if (reviewResult.prioritizedGoals && reviewResult.prioritizedGoals.length > 0) {
          this.goals.applySpecializationGuidance(reviewResult.prioritizedGoals);
        }
        
        // P6: Execute MetaCoordinator commands
        if (reviewResult.commands) {
          this.logger.info('📋 MetaCoordinator commands present in review', {
            hasGoalMerge: !!reviewResult.commands.mergeGoals,
            hasFocusMode: !!reviewResult.commands.focusMode,
            hasStopGoals: !!reviewResult.commands.stopNewGoals,
            hasConsolidate: !!reviewResult.commands.consolidateAgents
          });
          await this.executeMetaCoordinatorCommands(reviewResult.commands);
        } else {
          this.logger.debug('No strategic commands in this review cycle');
        }
      }
    }

    await this.handleReviewPipeline(reviewRole, reviewResult);
  }

  /**
   * Run Action Coordinator cycle
   * Closes thinking→doing gap by transforming knowledge into executable actions
   */
  async runActionCoordinatorCycle() {
    this.logger.info('🔨 Action Coordinator triggering', { cycle: this.cycleCount });
    
    try {
      // Build run context
      const runContext = {
        domain: this.guidedDomain || null,
        plan: this.guidedMissionPlan || null,
        planId: this.currentPlanId || null
      };
      
      // Run Action Coordinator
      await this.actionCoordinator.run(this.cycleCount, runContext);
      
    } catch (error) {
      this.logger.error('Action Coordinator error', { 
        cycle: this.cycleCount,
        error: error.message 
      });
    }
  }

  /**
   * Check if milestone is complete and advance to next
   */
  async checkMilestoneCompletion(planId, milestoneId) {
    try {
      const tasks = await this.clusterStateStore.listTasks(planId, { milestoneId });
      const allDone = tasks.every(t => t.state === 'DONE');
      
      if (allDone) {
        const advanced = await this.clusterStateStore.advanceMilestone(planId, milestoneId);
        this.logger.info('🎉 Milestone completed', { planId, milestoneId, advanced });
        
        // Check if plan just completed
        const plan = await this.clusterStateStore.getPlan(planId);
        if (plan && plan.status === 'COMPLETED') {
          await this.handlePlanCompletion(plan);
        }
      }
    } catch (error) {
      this.logger.error('[Orchestrator] checkMilestoneCompletion error', {
        planId,
        milestoneId,
        error: error.message
      });
    }
  }
  
  /**
   * P2: Get predecessor tasks for a task (dependencies)
   * Used to build coordination context for agents
   * 
   * @param {Object} task - Task to get predecessors for
   * @returns {Array} Array of predecessor task objects
   */
  async getPredecessorTasks(task) {
    if (!this.clusterStateStore || !task.deps || task.deps.length === 0) {
      return [];
    }
    
    try {
      const predecessors = await Promise.all(
        task.deps.map(depId => this.clusterStateStore.getTask(depId))
      );
      return predecessors.filter(Boolean); // Filter out null results
    } catch (error) {
      this.logger.warn('Failed to get predecessor tasks', {
        taskId: task.id,
        deps: task.deps,
        error: error.message
      });
      return [];
    }
  }
  
  /**
   * P2: Get sibling tasks in the same milestone/phase
   * Used to build coordination context for agents
   * 
   * @param {string} planId - Plan ID
   * @param {string} milestoneId - Milestone ID
   * @returns {Array} Array of sibling task objects
   */
  async getSiblingTasks(planId, milestoneId) {
    if (!this.clusterStateStore) {
      return [];
    }
    
    try {
      return await this.clusterStateStore.listTasks(planId, { milestoneId });
    } catch (error) {
      this.logger.warn('Failed to get sibling tasks', {
        planId,
        milestoneId,
        error: error.message
      });
      return [];
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // P6: META-COORDINATOR COMMAND EXECUTION
  // These methods execute strategic commands from MetaC reviews
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * P6: Execute MetaCoordinator commands
   * Main dispatcher for all command types
   * 
   * @param {Object} commands - Commands from MetaC review
   */
  async executeMetaCoordinatorCommands(commands) {
    this.logger.info('');
    this.logger.info('⚡ Executing MetaCoordinator commands...');
    
    let commandsExecuted = 0;
    
    if (commands.mergeGoals) {
      try {
        await this.mergeGoals(commands.mergeGoals);
        commandsExecuted++;
      } catch (error) {
        this.logger.error('mergeGoals command failed', { error: error.message });
      }
    }
    
    if (commands.focusMode) {
      try {
        await this.enterFocusMode(commands.focusMode);
        commandsExecuted++;
      } catch (error) {
        this.logger.error('enterFocusMode command failed', { error: error.message });
      }
    }
    
    if (commands.stopNewGoals) {
      try {
        this.stopNewGoals(commands.stopNewGoals);
        commandsExecuted++;
      } catch (error) {
        this.logger.error('stopNewGoals command failed', { error: error.message });
      }
    }
    
    if (commands.consolidateAgents) {
      try {
        await this.consolidatePhaseAgents(commands.consolidateAgents);
        commandsExecuted++;
      } catch (error) {
        this.logger.error('consolidateAgents command failed', { error: error.message });
      }
    }

    if (commands.repairPlanStall) {
      try {
        await this.repairPlanStall(commands.repairPlanStall);
        commandsExecuted++;
      } catch (error) {
        this.logger.error('repairPlanStall command failed', { error: error.message });
      }
    }
    
    if (commandsExecuted > 0) {
      this.logger.info(`✅ Executed ${commandsExecuted} strategic command(s)`);
    } else {
      this.logger.info('   No commands to execute this cycle');
    }
    this.logger.info('');
  }
  
  /**
   * PLAN INTEGRITY (Jan 20, 2026): Repair a stalled plan phase
   * Triggers an auto-retry of blocked tasks or a state audit
   * 
   * @param {Object} spec - Stall specification { planId, milestoneId, reason }
   */
  async repairPlanStall(spec) {
    this.logger.warn('🔧 REPAIRING PLAN STALL:', {
      planId: spec.planId,
      milestoneId: spec.milestoneId,
      reason: spec.reason
    });

    if (!this.clusterStateStore) return;

    try {
      // 1. Get all tasks for this milestone
      const tasks = await this.clusterStateStore.listTasks(spec.planId, { milestoneId: spec.milestoneId });
      
      // 2. Identify blocked/failed tasks
      const blockedTasks = tasks.filter(t => t.state === 'FAILED' || t.state === 'BLOCKED');
      
      if (blockedTasks.length > 0) {
        this.logger.info(`🔧 Found ${blockedTasks.length} blocked tasks in stalled phase - triggering retries`);
        for (const task of blockedTasks) {
          // UNIFIED QUEUE ARCHITECTURE: Enqueue retry
          if (this.taskStateQueue) {
            await this.taskStateQueue.enqueue({
              type: 'RETRY_TASK',
              taskId: task.id,
              cycle: this.cycleCount,
              reason: 'meta_coordinator_stall_repair',
              source: 'stall_repair'
            });
          } else {
            await this.clusterStateStore.retryTask(task.id, 'meta_coordinator_stall_repair');
          }
        }
      } else {
        // No failed tasks, but milestone isn't advancing?
        // This might be a dependency gap.
        this.logger.info('🔧 No failed tasks found, but phase is stalled - triggering state audit');
        
        const plan = await this.clusterStateStore.getPlan(spec.planId);
        const allTasks = await this.clusterStateStore.listTasks(spec.planId);
        if (plan) {
          await this.getGuidedPlanner().performStateAudit(plan, allTasks, this.clusterStateStore);
        }
      }
    } catch (error) {
      this.logger.error('Failed to repair plan stall', { error: error.message });
    }
  }

  /**
   * P6: Merge duplicate goals into a single goal
   * 
   * @param {Object} spec - Merge specification
   * @param {string} spec.targetGoalId - Goal to keep
   * @param {Array} spec.sourceGoalIds - Goals to merge and archive
   * @param {string} spec.reason - Reason for merge
   */
  async mergeGoals(spec) {
    this.logger.info('🔀 Merging goals:', {
      target: spec.targetGoalId,
      sources: spec.sourceGoalIds.length,
      reason: spec.reason
    });
    
    const allGoals = this.goals.getGoals();
    const target = allGoals.find(g => g.id === spec.targetGoalId);
    
    if (!target) {
      this.logger.warn('Target goal not found, skipping merge', { 
        targetId: spec.targetGoalId 
      });
      return;
    }
    
    let merged = 0;
    for (const sourceId of spec.sourceGoalIds) {
      const source = allGoals.find(g => g.id === sourceId);
      if (!source) continue;
      
      // Merge deliverables
      if (source.deliverables && source.deliverables.length > 0) {
        target.deliverables = [...(target.deliverables || []), ...source.deliverables];
      }
      
      // Merge metadata
      if (source.metadata) {
        target.metadata = { ...target.metadata, ...source.metadata };
      }
      
      // Archive source goal
      this.goals.archiveGoal(sourceId, `Merged into ${spec.targetGoalId}: ${spec.reason}`);
      merged++;
    }
    
    this.logger.info(`✅ Merged ${merged} goals into ${spec.targetGoalId}`);
  }
  
  /**
   * P6: Enter focus mode - block new goal creation except allowed goals
   * 
   * @param {Object} spec - Focus mode specification
   * @param {Array} spec.allowedGoals - Goals allowed during focus
   * @param {number} spec.blockDuration - Cycles to remain in focus
   * @param {string} spec.reason - Reason for focus mode
   */
  async enterFocusMode(spec) {
    this.logger.warn('🎯 ENTERING FOCUS MODE');
    this.logger.warn(`   Reason: ${spec.reason}`);
    this.logger.warn(`   Allowed goals: ${spec.allowedGoals.length}`);
    this.logger.warn(`   Duration: ${spec.blockDuration} cycles`);
    
    this.focusMode = {
      active: true,
      allowedGoals: new Set(spec.allowedGoals),
      reason: spec.reason,
      startCycle: this.cycleCount,
      endCycle: this.cycleCount + spec.blockDuration,
      blockDuration: spec.blockDuration
    };
    
    // Archive non-allowed goals
    const allGoals = this.goals.getGoals();
    let archived = 0;
    for (const goal of allGoals) {
      if (!spec.allowedGoals.includes(goal.id) && goal.pursuitCount === 0) {
        this.goals.archiveGoal(goal.id, `Focus mode: ${spec.reason}`);
        archived++;
      }
    }
    
    this.logger.warn(`   Archived ${archived} unfocused goals`);
    this.logger.warn('   New goal creation blocked until focus mode ends');
  }
  
  /**
   * P6: Stop new goal creation
   * 
   * @param {Object} spec - Stop specification
   * @param {string} spec.reason - Reason for stopping
   * @param {string} spec.until - Condition to resume
   */
  stopNewGoals(spec) {
    this.logger.warn('🛑 BLOCKING NEW GOAL CREATION');
    this.logger.warn(`   Reason: ${spec.reason}`);
    this.logger.warn(`   Until: ${spec.until}`);
    
    this.goalCreationBlocked = {
      active: true,
      reason: spec.reason,
      until: spec.until,
      startCycle: this.cycleCount
    };
  }
  
  /**
   * P6: Consolidate active agents - request stop for lowest-priority agents
   * 
   * @param {Object} spec - Consolidation specification
   * @param {number} spec.maxActive - Maximum agents to keep running
   * @param {Array} spec.priorityPhases - Phases to prioritize
   * @param {string} spec.reason - Reason for consolidation
   */
  async consolidatePhaseAgents(spec) {
    if (!this.agentExecutor) return;
    
    this.logger.warn('🔄 CONSOLIDATING AGENTS');
    this.logger.warn(`   Reason: ${spec.reason}`);
    this.logger.warn(`   Target: ${spec.maxActive} max active`);
    
    const activeAgents = this.agentExecutor.registry.getActiveAgents();
    const currentCount = activeAgents.length;
    
    if (currentCount <= spec.maxActive) {
      this.logger.info(`   Current agent count (${currentCount}) already below target`);
      return;
    }
    
    // Sort agents by priority (keep priority phases, synthesis, high-priority missions)
    const sorted = activeAgents.sort((a, b) => {
      const aPriority = this.calculateAgentPriority(a, spec.priorityPhases);
      const bPriority = this.calculateAgentPriority(b, spec.priorityPhases);
      return bPriority - aPriority; // Highest priority first
    });
    
    // Request stop for lowest-priority agents
    const toStop = sorted.slice(spec.maxActive);
    let stopped = 0;
    
    for (const agentState of toStop) {
      try {
        if (agentState.agent && typeof agentState.agent.requestStop === 'function') {
          await agentState.agent.requestStop('MetaC consolidation request');
          stopped++;
        }
      } catch (error) {
        this.logger.warn('Failed to stop agent', {
          agentId: agentState.agent?.agentId,
          error: error.message
        });
      }
    }
    
    this.logger.warn(`   Requested stop for ${stopped}/${toStop.length} agents`);
    this.logger.info(`   Keeping ${Math.min(currentCount, spec.maxActive)} high-priority agents running`);
  }
  
  /**
   * P6: Calculate agent priority for consolidation
   * Higher score = higher priority (keep running)
   * 
   * @param {Object} agentState - Agent state from registry
   * @param {Array} priorityPhases - Phases to prioritize
   * @returns {number} Priority score
   */
  calculateAgentPriority(agentState, priorityPhases = []) {
    let score = 0;
    
    const mission = agentState.mission || {};
    const agentType = agentState.agentType || mission.agentType || 'unknown';
    
    // Priority phases get +100
    if (mission.milestoneId && priorityPhases.some(p => mission.milestoneId.includes(p))) {
      score += 100;
    }
    
    // Synthesis/integration agents get +50
    if (['synthesis', 'integration', 'document_creation'].includes(agentType)) {
      score += 50;
    }
    
    // High-priority missions get +mission.priority * 10
    if (mission.priority) {
      score += mission.priority * 10;
    }
    
    // Agents with more progress get +progress
    if (agentState.progress) {
      score += agentState.progress;
    }
    
    // IDE agents working on tasks get +25
    if (agentType === 'ide' && mission.taskId) {
      score += 25;
    }
    
    return score;
  }

  /**
   * EXECUTIVE RING: Execute decision made by executive coordinator
   * 
   * Handles all 5 decision types: REDIRECT, SKIP, BLOCK_AND_INJECT, EMERGENCY_ESCALATE, LOG_WARNING
   * 
   * @param {Object} decision - Decision from executiveRing.decideCycleAction()
   * @param {Object} context - Context that was used for decision
   */
  async executeExecutiveDecision(decision, context) {
    switch (decision.action) {
      case 'REDIRECT':
        this.logger.info('🔄 Executive redirect', {
          from: context.proposedAgent?.agentType,
          to: decision.redirect?.agentType,
          reason: decision.reason
        });
        
        if (decision.redirect && this.agentExecutor) {
          const agentId = await this.agentExecutor.spawnAgent(decision.redirect);
          if (agentId) {
            this.logger.info('✓ Redirected agent spawned', { agentId });
          }
        }
        break;
        
      case 'SKIP':
        this.logger.info('⏭️  Executive skip', {
          reason: decision.reason,
          coherence: this.executiveRing?.getCoherenceScore().toFixed(2)
        });
        // Nothing to do - skip is handled by caller
        break;

      case 'SKIP_AND_REDIRECT':
        this.logger.warn('🔄 Executive skip + redirect (pattern detected)', {
          pattern: decision.pattern,
          blocked: decision.blockedAgentType,
          recommendation: decision.recommendation,
          reason: decision.reason
        });

        if (decision.recommendation && this.agentExecutor) {
          const agentId = await this.agentExecutor.spawnAgent({
            type: decision.recommendation,
            metadata: { source: 'executive_redirect', pattern: decision.pattern }
          });
          if (agentId) {
            this.logger.info('✓ Redirected agent spawned after pattern block', { agentId });
          }
        }
        break;
        
      case 'BLOCK_AND_INJECT':
        this.logger.warn('🚫 Executive block + inject goal', {
          blocked: context.proposedAgent?.agentType,
          reason: decision.reason
        });
        
        if (decision.urgentGoal && this.coordinator && this.goals) {
          await this.coordinator.injectUrgentGoals([decision.urgentGoal], this.goals);
          this.logger.info('💉 Urgent goal injected by executive', {
            description: decision.urgentGoal.description.substring(0, 100)
          });
        }
        break;
        
      case 'EMERGENCY_ESCALATE':
        this.logger.error('🚨 Executive emergency escalation', {
          reason: decision.reason,
          type: decision.escalationType,
          coherence: this.executiveRing?.getCoherenceScore().toFixed(2)
        });
        
        if (this.coordinator) {
          await this.coordinator.emergencyReview({
            trigger: decision.escalationType,
            reason: decision.reason,
            coherenceScore: this.executiveRing.getCoherenceScore(),
            cycleCount: this.cycleCount,
            urgentGoal: decision.urgentGoal
          });
        }
        
        // Also inject urgent goal immediately
        if (decision.urgentGoal && this.goals) {
          await this.coordinator.injectUrgentGoals([decision.urgentGoal], this.goals);
        }
        break;
        
      case 'LOG_WARNING':
        this.logger.warn('⚠️  Executive warning', {
          reason: decision.reason,
          recommendation: decision.recommendation
        });
        
        // Inject urgent goal but continue with spawn
        if (decision.urgentGoal && this.coordinator && this.goals) {
          await this.coordinator.injectUrgentGoals([decision.urgentGoal], this.goals);
        }
        
        // Spawn agent if proposed (handled by caller continuing normal flow)
        if (context.proposedAgent && this.agentExecutor) {
          const agentId = await this.agentExecutor.spawnAgent(context.proposedAgent);
          if (agentId) {
            this.logger.info('✓ Agent spawned despite warning', { agentId });
          }
        }
        break;
        
      case 'CONTINUE_NORMAL':
      default:
        // Normal operation - caller continues with regular spawn logic
        break;
    }
  }

  /**
   * EXECUTIVE RING: Gather context for executive decision making
   * 
   * Collects current system state to enable executive function reality checking.
   * Called every cycle before executive decides what action to take.
   * 
   * @returns {Object} - Context object for executive coordinator
   */
  async gatherExecutiveContext() {
    // Get current task (if in plan-driven mode)
    let currentTask = null;
    if (this.clusterStateStore) {
      try {
        const tasks = await this.clusterStateStore.listTasks('plan:main', { state: 'IN_PROGRESS' });
        currentTask = tasks[0] || null;
      } catch (error) {
        // No cluster store or plan - autonomous mode
      }
    }
    
    // Get proposed agent (from goal selection)
    let proposedAgent = null;
    if (this.agentExecutor && this.goals) {
      try {
        // Use correct API: selectGoalToPursue (not selectGoal)
        const selectedGoal = await this.goals.selectGoalToPursue({ 
          cycleCount: this.cycleCount,
          mode: this.oscillator?.getCurrentMode() || 'focus'
        });
        
        if (selectedGoal) {
          proposedAgent = {
            agentType: selectedGoal.metadata?.agentTypeHint || selectedGoal.metadata?.agentType || 'analysis',
            goalId: selectedGoal.id,
            description: selectedGoal.description,
            priority: selectedGoal.priority,
            metadata: selectedGoal.metadata || {}
          };
        }
      } catch (error) {
        // If goal selection fails, proposedAgent stays null (no spawn this cycle)
        this.logger.debug('Goal selection failed in executive context', { error: error.message });
      }
    }
    
    // Get active tasks
    const activeTasks = this.clusterStateStore 
      ? await this.clusterStateStore.listTasks('plan:main', { state: 'IN_PROGRESS' }).catch(() => [])
      : [];
    
    // Gather semantic memory context for executive awareness
    let memoryContext = null;
    if (this.memory?.nodes?.size > 0) {
      try {
        const nodes = Array.from(this.memory.nodes.values());

        // Recent findings — last 5 research/finding nodes by creation time
        const findings = nodes
          .filter(n => n.tag === 'agent_finding' || n.tag === 'research' || n.tag === 'finding')
          .sort((a, b) => (b.created || 0) - (a.created || 0))
          .slice(0, 5)
          .map(n => ({ concept: (n.concept || '').substring(0, 80), tag: n.tag }));

        // Top concepts — highest activation * weight (current focus)
        const topConcepts = nodes
          .filter(n => n.concept && n.activation > 0)
          .sort((a, b) => (b.activation * b.weight) - (a.activation * a.weight))
          .slice(0, 5)
          .map(n => (n.concept || '').substring(0, 60));

        // Domain coverage — unique tags representing explored areas
        const tagCounts = {};
        nodes.forEach(n => { if (n.tag) tagCounts[n.tag] = (tagCounts[n.tag] || 0) + 1; });
        const domainCoverage = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([tag, count]) => ({ tag, count }));

        // Synthesis depth — breakthroughs and synthesis nodes
        const synthesisCount = nodes.filter(n => n.tag === 'synthesis' || n.tag === 'breakthrough').length;

        memoryContext = { findings, topConcepts, domainCoverage, synthesisCount };
      } catch { /* memory context enrichment failed — continue with counts only */ }
    }

    return {
      cycleCount: this.cycleCount,
      mission: this.guidedPlan || null,
      currentPhase: currentTask?.milestoneId || null,
      currentTask,
      proposedAgent,
      systemState: {
        activeTasks,
        completedAgents: this.agentExecutor?.registry?.completedAgents?.size || 0,
        activeAgents: this.agentExecutor?.registry?.getActiveCount() || 0,
        goals: this.goals?.getGoals() || [],
        energy: this.stateModulator?.cognitiveState?.energy || 1.0,
        coherenceScore: this.executiveRing?.getCoherenceScore() || 1.0,
        memorySize: this.memory?.nodes?.size || 0,
        edgeSize: this.memory?.edges?.size || 0,
        clusterSize: this.memory?.clusters?.size || 0,
        memoryContext
      },
      coordinatorContext: {
        lastReviewCycle: this.coordinator?.lastReviewCycle || 0,
        reviewInterval: this.coordinator?.reviewInterval || 50
      }
    };
  }

  /**
   * Handle plan completion - determine next actions
   * ENHANCED: For guided modes, automatically generates next plan instead of going autonomous
   */
  async handlePlanCompletion(plan) {
    this.logger.info('');
    this.logger.info('╔═══════════════════════════════════════════════════╗');
    this.logger.info('║          PLAN COMPLETED SUCCESSFULLY              ║');
    this.logger.info('╚═══════════════════════════════════════════════════╝');
    this.logger.info('');
    this.logger.info(`📋 Plan: ${plan.title}`);
    this.logger.info(`⏱️  Duration: ${((Date.now() - plan.createdAt) / 1000 / 60).toFixed(1)} minutes`);
    this.logger.info('');

    // Audit deliverables created during plan execution
    let auditResult = null;
    if (this.coordinator) {
      auditResult = await this.coordinator.auditDeliverables();
      this.logger.info('📦 Deliverables created:', {
        totalFiles: auditResult.totalFiles,
        byType: auditResult.byAgentType
      });
    }

    const executionModeInfo = this.getExecutionModeInfo();
    const shouldAutoGenerateNextPlan = this.isGuidedExclusiveRun();

    if (shouldAutoGenerateNextPlan) {
      this.logger.info('');
      this.logger.info('╔═══════════════════════════════════════════════════╗');
      this.logger.info('║     AUTO-GENERATING NEXT PLAN (GUIDED MODE)       ║');
      this.logger.info('╚═══════════════════════════════════════════════════╝');
      this.logger.info('');

      try {
        await this.getGuidedPlanner().queueContinuationPlan(plan, auditResult);
        this.logger.info('🎯 Next guided continuation plan queued');
      } catch (error) {
        this.logger.error('❌ Guided continuation planning failed; stopping instead of falling back', {
          error: error.message,
          stack: error.stack?.split('\n').slice(0, 5).join('\n'),
          logsDir: this.logsDir
        });

        this._getEvents().emitEvent('guided_planner_failed', {
          planId: plan.id,
          error: error.message,
          domain: plan.domain || this.config?.architecture?.roleSystem?.guidedFocus?.domain,
          effectiveExecutionMode: GUIDED_EFFECTIVE_MODE
        });
      }
    } else if (executionModeInfo.persistedMode === 'strict') {
      this.logger.info('');
      this.logger.info(`🎯 Execution Mode: ${executionModeInfo.effectiveMode.toUpperCase()}`);
      this.logger.info('   Task complete - guided run finished');
      this.logger.info('   System will continue autonomous exploration');
      this.logger.info('   (Use Ctrl+C to stop if task-only execution desired)');
      this.logger.info('');
    } else {
      this.logger.info('');
      this.logger.info('🎯 Execution Mode: ' + executionModeInfo.effectiveMode.toUpperCase());
      this.logger.info('   Primary task complete - continuing autonomous exploration');
      this.logger.info('   System will pursue self-discovered goals and related work');
      this.logger.info('');
    }

    // Log plan completion
    this.logger.info('✅ Plan completed', {
      planId: plan.id,
      title: plan.title,
      completedAt: Date.now(),
      duration: Date.now() - plan.createdAt
    });
  }

  /**
   * Resolve the original research thread even after multiple injected plans.
   */
  async resolveResearchAnchor(completedPlan) {
    const guidedFocus = this.config?.architecture?.roleSystem?.guidedFocus || {};
    const runtimeMetadata = await this.readJsonIfExists(path.join(this.logsDir, 'run-metadata.json'));
    const archivedPlan = await this.readLatestArchivedPlan();
    const initialPlanAnchor = await this.readInitialGuidedPlanAnchor();

    const researchDomain = firstNonEmpty(
      guidedFocus.researchDomain,
      guidedFocus.originalDomain,
      runtimeMetadata?.researchDomain,
      runtimeMetadata?.domain,
      runtimeMetadata?.topic,
      initialPlanAnchor?.task,
      archivedPlan?.title,
      completedPlan?.domain,
      completedPlan?.title,
      guidedFocus.domain,
      'research'
    );

    const researchContext = firstNonEmpty(
      guidedFocus.researchContext,
      guidedFocus.originalContext,
      runtimeMetadata?.researchContext,
      runtimeMetadata?.context,
      initialPlanAnchor?.context,
      guidedFocus.context,
      ''
    );

    return {
      researchDomain,
      researchContext,
      currentTask: firstNonEmpty(completedPlan?.title, guidedFocus.domain, researchDomain),
      archivedPlanTitle: archivedPlan?.title || '',
      anchorSource: firstNonEmpty(
        guidedFocus.researchDomain && 'guidedFocus.researchDomain',
        runtimeMetadata?.researchDomain && 'run-metadata.researchDomain',
        runtimeMetadata?.domain && 'run-metadata.domain',
        runtimeMetadata?.topic && 'run-metadata.topic',
        initialPlanAnchor?.task && `guided-plan:${initialPlanAnchor.file}`,
        archivedPlan?.title && `archived-plan:${archivedPlan.file}`,
        completedPlan?.title && 'completedPlan.title'
      ) || 'default'
    };
  }

  async readJsonIfExists(filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch (error) {
      return null;
    }
  }

  async readLatestArchivedPlan() {
    const plansDir = path.join(this.logsDir, 'plans');
    try {
      const entries = await fs.readdir(plansDir);
      const archivedFiles = entries
        .filter(name => /^plan:main(?:_file)?_archived_\d+\.json$/.test(name))
        .sort((a, b) => {
          const aNum = Number(a.match(/_(\d+)\.json$/)?.[1] || 0);
          const bNum = Number(b.match(/_(\d+)\.json$/)?.[1] || 0);
          return bNum - aNum;
        });

      for (const file of archivedFiles) {
        const plan = await this.readJsonIfExists(path.join(plansDir, file));
        if (plan?.title) {
          return { ...plan, file };
        }
      }
    } catch (error) {
      this.logger.debug('No archived plan available for research anchor', {
        error: error.message
      });
    }

    return null;
  }

  async readInitialGuidedPlanAnchor() {
    try {
      const entries = await fs.readdir(this.logsDir);
      const planFiles = entries
        .filter(name => /^guided-plan(?:-\d+)?\.md$/.test(name))
        .sort((a, b) => {
          const aTs = Number(a.match(/guided-plan-(\d+)\.md$/)?.[1] || Number.MAX_SAFE_INTEGER);
          const bTs = Number(b.match(/guided-plan-(\d+)\.md$/)?.[1] || Number.MAX_SAFE_INTEGER);
          return aTs - bTs;
        });

      for (const file of planFiles) {
        const content = await fs.readFile(path.join(this.logsDir, file), 'utf-8');
        const task = firstNonEmpty(
          content.match(/\*\*Task:\*\*\s*(.+)$/m)?.[1],
          content.match(/^\s*domain:\s*"([^"]+)"/m)?.[1]
        );
        const context = firstNonEmpty(
          content.match(/^\s*context:\s*"([\s\S]*?)"\s*\n(?:depth|executionMode):/m)?.[1],
          content.match(/\*\*Context:\*\*\s*([\s\S]*?)\n##/m)?.[1]
        );

        if (task) {
          return {
            task: summarizeText(task, 120),
            context: summarizeText(context, 600),
            file
          };
        }
      }
    } catch (error) {
      this.logger.debug('No guided plan markdown available for research anchor', {
        error: error.message
      });
    }

    return null;
  }

  extractReviewSignals(reviewContent, limit = 6) {
    const lines = String(reviewContent || '')
      .split('\n')
      .map(line => summarizeText(line, 220))
      .filter(Boolean);

    const gapPatterns = [
      /open question/i,
      /unresolved/i,
      /uncertain/i,
      /contradict/i,
      /\bgap\b/i,
      /needs (more|further|additional)/i,
      /future work/i,
      /next step/i,
      /thin evidence/i,
      /under-sourced/i,
      /not yet/i,
      /missing/i
    ];
    const breakthroughPatterns = [
      /breakthrough/i,
      /discovery/i,
      /novel/i,
      /significant finding/i,
      /emerging/i,
      /surprise/i
    ];

    const filteredLines = filterDomainRelevant(lines);
    const gaps = [...new Set(filteredLines.filter(line => gapPatterns.some(pattern => pattern.test(line))))].slice(0, limit);
    const breakthroughs = [...new Set(filteredLines.filter(line => breakthroughPatterns.some(pattern => pattern.test(line))))].slice(0, 3);

    return { gaps, breakthroughs };
  }

  collectContinuationContext(completedPlan, auditResult, latestReview) {
    const reviewSignals = this.extractReviewSignals(latestReview?.content || '');
    const memoryNodes = this.memory?.nodes instanceof Map
      ? Array.from(this.memory.nodes.values())
      : [];
    const recentFindings = filterDomainRelevant(
      memoryNodes
        .filter(node => node?.concept)
        .sort((a, b) => (
          (b.updated || b.accessed || b.created || 0) -
          (a.updated || a.accessed || a.created || 0)
        ))
        .map(node => summarizeText(node.concept, 180))
    ).slice(0, 6);

    const goalList = Array.isArray(this.goals?.getGoals?.())
      ? this.goals.getGoals()
      : [];
    const activeGoals = filterDomainRelevant(
      goalList
        .filter(goal => goal && goal.description)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .map(goal => `${summarizeText(goal.description, 160)} (priority ${(goal.priority || 0).toFixed(2)})`)
    ).slice(0, 5);

    const deliverables = (auditResult?.recentFiles || [])
      .map(file => `${file.path} [${file.agentType}]`)
      .slice(0, 6);

    const criteria = Array.isArray(this.completionTracker?.criteria) ? this.completionTracker.criteria : [];
    const progressEntries = this.completionTracker?.progress instanceof Map
      ? Array.from(this.completionTracker.progress.values())
      : [];
    const completionSummary = criteria.length > 0
      ? `${progressEntries.filter(entry => entry?.status === 'completed').length}/${criteria.length} success criteria completed`
      : 'Completion criteria unavailable';

    const recentPlanEvents = (this.planProgressEvents || [])
      .slice(-6)
      .map(event => summarizeText(event.description || `${event.type} ${event.planTitle || ''}`, 180));

    return {
      reviewGaps: reviewSignals.gaps,
      breakthroughs: reviewSignals.breakthroughs,
      recentFindings,
      activeGoals,
      deliverables,
      completionSummary,
      recentPlanEvents
    };
  }

  buildFallbackNextPlanSpec(completedPlan, anchor, continuationContext) {
    const focusSeed = firstNonEmpty(
      continuationContext.reviewGaps[0],
      continuationContext.breakthroughs[0],
      continuationContext.recentFindings[0],
      'evidence gaps and unresolved questions'
    );

    const focusLabel = summarizeText(
      focusSeed
        .replace(/^[\-\*\d\.\)\s]+/, '')
        .replace(/^(open question|gap|unresolved|finding|issue)\s*[:\-]\s*/i, '')
        .replace(/[.;].*$/, ''),
      56
    ) || 'evidence gaps and unresolved questions';

    const domain = summarizeText(`${anchor.researchDomain} - ${focusLabel}`, 80);
    const deliverablesBlock = continuationContext.deliverables.length > 0
      ? `Existing outputs to review first:\n${continuationContext.deliverables.map(item => `- ${item}`).join('\n')}\n\n`
      : '';
    const focusAreas = continuationContext.reviewGaps.length > 0
      ? continuationContext.reviewGaps.map(item => `- ${item}`).join('\n')
      : `- Revisit the strongest findings from "${completedPlan.title}" and identify unresolved claims, contradictions, and thinly sourced areas.\n- Gather targeted corroborating evidence and extend the chronology, comparisons, or applications that remain incomplete.\n- Produce an addendum or expansion deliverable that integrates cleanly with the prior outputs.`;

    return {
      domain,
      context: `Continue the ongoing ${anchor.researchDomain} research program by building directly on the completed plan "${completedPlan.title}". First absorb the prior outputs, then target the highest-value unresolved questions, contradictions, and under-supported claims that remain in this same research thread.\n\n${deliverablesBlock}Priority focus areas:\n${focusAreas}\n\nThis is a continuation plan, not a fresh topic shift. The work should deepen, corroborate, or extend the existing research and end with a concrete deliverable that clearly integrates with previous outputs.`,
      executionMode: this.config?.architecture?.roleSystem?.guidedFocus?.executionMode || 'mixed',
      reasoning: `Fallback continuation planning: keep the research anchored to ${anchor.researchDomain} and deepen the unresolved evidence from "${completedPlan.title}" instead of switching topics.`
    };
  }

  async queueNextPlanAction(nextPlanSpec, completedPlan, anchor, options = {}) {
    const {
      source = 'auto_completion',
      requestedBy = 'orchestrator_auto_next',
      prioritize = false,
      extraMetadata = {}
    } = options;

    const actionsQueuePath = path.join(this.logsDir, 'actions-queue.json');
    let actionsData = { actions: [] };
    try {
      const content = await fs.readFile(actionsQueuePath, 'utf-8');
      actionsData = JSON.parse(content);
    } catch (error) {
      // Queue doesn't exist yet
    }

    const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const injectAction = {
      actionId,
      type: 'inject_plan',
      domain: summarizeText(nextPlanSpec.domain || anchor.researchDomain, 80),
      context: String(nextPlanSpec.context || '').trim(),
      executionMode: nextPlanSpec.executionMode || 'mixed',
      requestedAt: new Date().toISOString(),
      source,
      status: 'pending',
      metadata: {
        archiveCurrentPlan: true,
        requestedBy,
        reasoning: nextPlanSpec.reasoning,
        rationale: nextPlanSpec.rationale || null,
        previousPlan: completedPlan.title,
        researchDomain: anchor.researchDomain,
        researchContext: anchor.researchContext,
        continuation: true,
        anchorSource: anchor.anchorSource,
        ...extraMetadata
      }
    };

    actionsData.actions = actionsData.actions || [];
    if (prioritize) {
      actionsData.actions.unshift(injectAction);
    } else {
      actionsData.actions.push(injectAction);
    }

    await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
    return { actionId, domain: injectAction.domain };
  }

  /**
   * Queue auto-next plan generation using continuation-aware analysis.
   * Called automatically when a guided plan completes.
   */
  async queueAutoNextPlan(completedPlan, auditResult) {
    const anchor = await this.resolveResearchAnchor(completedPlan);
    const latestReview = this.coordinator?.getLatestReport
      ? await this.coordinator.getLatestReport().catch(() => null)
      : null;
    const continuationContext = this.collectContinuationContext(completedPlan, auditResult, latestReview);

    const domainAnchorBlock = getDomainAnchor({
      architecture: {
        roleSystem: {
          guidedFocus: {
            researchDomain: anchor.researchDomain,
            researchContext: anchor.researchContext
          }
        }
      }
    });

    const plannerClient = this.coordinator?.gpt5;
    if (!plannerClient || typeof plannerClient.generateWithRetry !== 'function') {
      throw new Error('No provider-aware planner client available for auto-next generation');
    }

    const prompt = `You are generating the NEXT guided plan for an ongoing COSMO autonomous research run.

${domainAnchorBlock}

JUST COMPLETED PLAN:
- Title: ${completedPlan.title}
- Completion summary: ${continuationContext.completionSummary}
- Deliverables created: ${auditResult?.totalFiles || 0}
- Deliverables by agent type: ${JSON.stringify(auditResult?.byAgentType || {})}

RECENT DELIVERABLES:
${continuationContext.deliverables.length > 0 ? continuationContext.deliverables.map(item => `- ${item}`).join('\n') : 'No recent deliverables listed'}

LATEST REVIEW SIGNALS:
${continuationContext.reviewGaps.length > 0 ? continuationContext.reviewGaps.map(item => `- ${item}`).join('\n') : 'No explicit gaps extracted from latest review'}

BREAKTHROUGHS OR HIGH-VALUE SIGNALS:
${continuationContext.breakthroughs.length > 0 ? continuationContext.breakthroughs.map(item => `- ${item}`).join('\n') : 'No explicit breakthroughs extracted'}

RECENT MEMORY FINDINGS:
${continuationContext.recentFindings.length > 0 ? continuationContext.recentFindings.map(item => `- ${item}`).join('\n') : 'No recent memory findings available'}

ACTIVE GOALS:
${continuationContext.activeGoals.length > 0 ? continuationContext.activeGoals.map(item => `- ${item}`).join('\n') : 'No active goals available'}

RECENT PLAN EVENTS:
${continuationContext.recentPlanEvents.length > 0 ? continuationContext.recentPlanEvents.map(item => `- ${item}`).join('\n') : 'No recent plan events available'}

YOUR TASK:
Generate the single best NEXT guided research plan that CONTINUES this same research thread.

Requirements:
1. Stay strictly inside the research domain "${anchor.researchDomain}".
2. Build directly on what was just accomplished, using the deliverables/review/gaps above.
3. Prefer unresolved evidence, contradictions, missing chronology, thinly sourced claims, unanswered questions, or high-value applications/extensions.
4. Keep the work concrete and actionable for autonomous research agents.
5. The next plan may be narrower and deeper than the completed one. It does NOT need to be a fresh unrelated aspect.

Hard constraints:
- Do NOT drift into COSMO infrastructure, QA gates, probes, tooling, or meta-work.
- Do NOT propose a generic topic shift.
- Do NOT discard the prior work; extend it.

OUTPUT FORMAT (JSON ONLY):
{
  "reasoning": "2-3 sentences explaining why this is the correct continuation of the research thread",
  "domain": "Concise next-task title within ${anchor.researchDomain} (80 chars max)",
  "context": "Detailed continuation brief (200-500 words) explaining what was accomplished, what remains unresolved, and how the next plan should proceed",
  "executionMode": "strict|mixed|advisory",
  "rationale": "One sentence explaining the execution mode choice"
}`;

    const response = await plannerClient.generateWithRetry({
      model: this.config?.models?.plannerModel || this.config?.models?.coordinatorStandard || this.config?.models?.fast,
      instructions: prompt,
      messages: [{
        role: 'user',
        content: 'Return only the JSON object for the next guided continuation plan.'
      }],
      maxTokens: 2400,
      reasoningEffort: 'low',
      verbosity: 'low'
    }, 3);

    const nextPlanSpec = parseWithFallback(response?.content || '', 'object');
    if (!nextPlanSpec?.domain || !nextPlanSpec?.context) {
      this.logger.error('Failed to parse auto-next continuation plan response', {
        rawPreview: summarizeText(response?.content || '', 240)
      });
      throw new Error('Invalid response from continuation planner');
    }

    const queued = await this.queueNextPlanAction(nextPlanSpec, completedPlan, anchor, {
      source: 'auto_completion',
      requestedBy: 'orchestrator_auto_next',
      extraMetadata: {
        rationale: nextPlanSpec.rationale || null,
        continuationSummary: continuationContext.completionSummary,
        latestReviewGapCount: continuationContext.reviewGaps.length
      }
    });

    this.logger.info('📋 Auto-next continuation plan queued', {
      actionId: queued.actionId,
      domain: queued.domain,
      researchDomain: anchor.researchDomain
    });
  }

  /**
   * Fallback continuation planning when LLM-based generation fails.
   */
  async queueFallbackNextPlan(completedPlan, auditResult = null) {
    const anchor = await this.resolveResearchAnchor(completedPlan);
    const latestReview = this.coordinator?.getLatestReport
      ? await this.coordinator.getLatestReport().catch(() => null)
      : null;
    const continuationContext = this.collectContinuationContext(completedPlan, auditResult, latestReview);
    const nextPlanSpec = this.buildFallbackNextPlanSpec(completedPlan, anchor, continuationContext);
    const queued = await this.queueNextPlanAction(nextPlanSpec, completedPlan, anchor, {
      source: 'auto_completion_fallback',
      requestedBy: 'orchestrator_fallback',
      prioritize: true,
      extraMetadata: {
        fallbackGeneration: true,
        reviewGaps: continuationContext.reviewGaps.slice(0, 3),
        deliverables: continuationContext.deliverables.slice(0, 3)
      }
    });

    this.logger.info('📋 FALLBACK: Auto-next continuation plan queued', {
      actionId: queued.actionId,
      domain: queued.domain,
      researchDomain: anchor.researchDomain
    });
  }

  /**
   * Spawn agents during execution mode to work through backlog
   * ENHANCED: Scales agent spawning based on backlog size
   */
  async spawnExecutionAgents() {
    try {
      const totalGoals = this.goals.getGoals().length;
      const activeAgents = this.agentExecutor?.registry?.getActiveCount() || 0;
      const maxConcurrent = this.agentExecutor?.maxConcurrent || 5;
      const availableSlots = maxConcurrent - activeAgents;
      
      // Scale spawning based on backlog severity
      let agentsToSpawn;
      if (totalGoals > 150) {
        agentsToSpawn = Math.min(availableSlots, 10); // Massive backlog: spawn 10
      } else if (totalGoals > 100) {
        agentsToSpawn = Math.min(availableSlots, 7);  // Large backlog: spawn 7
      } else if (totalGoals > 75) {
        agentsToSpawn = Math.min(availableSlots, 5);  // Medium backlog: spawn 5
      } else {
        agentsToSpawn = Math.min(availableSlots, 2);  // Normal: spawn 2
      }
      
      if (availableSlots === 0) {
        this.logger.info('All agent slots full, waiting for completions', {
          active: activeAgents,
          maxConcurrent
        });
        return;
      }
      
      this.logger.info('⚙️  Spawning execution agents for backlog', {
        totalGoals,
        activeAgents,
        availableSlots,
        willSpawn: agentsToSpawn
      });
      
      // Get top N priority goals
      // FIX (Jan 21, 2026): Filter out claimed goals, but allow expired claims
      const allGoals = this.goals.getGoals();
      const now = Date.now();
      const availableGoals = allGoals.filter(g => {
        // No claim = available
        if (!g.claimedBy && !g.claimed_by) return true;
        // Expired claim = available
        if (g.claimExpires && g.claimExpires < now) return true;
        // Check if goal is actively being pursued by a running agent
        const activelyPursued = this.agentExecutor?.registry?.isGoalBeingPursued?.(g.id);
        if (!activelyPursued) return true;
        // Otherwise claimed and actively pursued
        return false;
      });
      const sortedGoals = availableGoals.sort((a, b) => b.priority - a.priority);
      const goals = sortedGoals.slice(0, agentsToSpawn);

      if (goals.length === 0) {
        if (allGoals.length > 0 && availableGoals.length === 0) {
          this.logger.info('All goals are actively pursued, waiting for completions', {
            totalGoals: allGoals.length,
            claimedGoals: allGoals.filter(g => g.claimedBy || g.claimed_by).length
          });
        } else {
          this.logger.info('No goals to execute');
        }
        return;
      }
      
      // Log what we're spawning
      const strategicCount = goals.filter(g => 
        g.source === 'meta_coordinator_strategic' || g.metadata?.gapDriven === true
      ).length;
      
      this.logger.info(`Selected ${goals.length} goals for spawning (${strategicCount} strategic)`, {
        topPriorities: goals.slice(0, 3).map(g => ({
          id: g.id,
          priority: g.priority?.toFixed(3),
          source: g.source
        }))
      });
      
      // Use Meta-Coordinator to create intelligent mission specs
      // (It uses GPT-5.2 to select appropriate agent type for each goal)
      const missionSpecs = await this.coordinator.createMissionSpecs(
        goals,
        this.cycleCount,
        agentsToSpawn
      );
      
      if (missionSpecs.length === 0) {
        this.logger.info('No mission specs created for execution');
        return;
      }
      
      const spawnedAgents = [];
      
      for (const missionSpec of missionSpecs) {
        const agentId = await this.agentExecutor.spawnAgent(missionSpec);
        
        if (agentId) {
          spawnedAgents.push(agentId);
          this.logger.info('✅ Execution agent spawned', {
            agentId,
            agentType: missionSpec.agentType,
            goalId: missionSpec.goalId,
            goal: missionSpec.description.substring(0, 60)
          });
        }
      }
      
      if (spawnedAgents.length > 0) {
        this.logger.info('⚙️  Execution agents deployed', {
          count: spawnedAgents.length,
          types: missionSpecs.map(m => m.agentType),
          mode: 'background'
        });
      }
      
    } catch (error) {
      this.logger.error('Execution agent spawning failed', {
        error: error.message
      });
    }
  }

  /**
   * Process handoff requests from agents
   * Agents can request another agent type to continue their work
   */
  async processAgentHandoffRequests() {
    if (!this.agentExecutor || !this.agentExecutor.messageQueue) {
      return;
    }

    const handoffRequests = this.agentExecutor.messageQueue.getHandoffRequests();
    
    if (handoffRequests.length === 0) {
      return;
    }

    this.logger.info('📨 Processing agent handoff requests', {
      count: handoffRequests.length
    });

    for (const handoff of handoffRequests) {
      try {
        const payload = handoff.payload;
        
        // Create child mission from handoff
        const childMission = {
          goalId: payload.originalGoal,
          agentType: payload.toAgentType,
          description: payload.reason,
          claimText: payload.claimText || null, // NEW: Pass claim text for intake gate
          successCriteria: [
            'Complete the work handed off from parent agent',
            'Build upon findings from parent agent',
            'Generate actionable results'
          ],
          maxDuration: 15 * 60 * 1000, // 15 minutes
          
          // Provenance chain
          missionId: `mission_handoff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          createdBy: 'agent_handoff',
          spawnCycle: this.cycleCount,
          createdAt: new Date().toISOString(),
          parentAgentId: payload.sourceAgent,
          parentMissionId: payload.originalGoal,
          spawningReason: 'agent_handoff',
          triggerSource: 'agent_request',
          provenanceChain: [payload.sourceAgent],
          
          // Context from parent
          spawningContext: {
            parentContext: payload.context || {},
            handoffReason: payload.reason,
            sourceAgentType: payload.sourceAgentType,
            claimsToVerify: payload.context?.claimsToVerify || [], // NEW: Include extracted claims
            artifactRefs: payload.artifactRefs || [],
            sourceRefs: payload.sourceRefs || [],
            sourceUrls: payload.sourceUrls || [],
            topFindings: payload.topFindings || [],
            followUpGoals: payload.followUpGoals || []
          },
          metadata: {
            guidedMission: this.isGuidedExclusiveRun(),
            handoffContext: {
              ...(payload.context || {}),
              artifactRefs: payload.artifactRefs || [],
              sourceRefs: payload.sourceRefs || [],
              sourceUrls: payload.sourceUrls || [],
              topFindings: payload.topFindings || [],
              followUpGoals: payload.followUpGoals || []
            },
            artifactInputs: payload.artifactRefs || []
          }
        };

        const childAgentId = await this.agentExecutor.spawnAgent(childMission);
        
        if (childAgentId) {
          this.logger.info('✅ Child agent spawned from handoff', {
            parentAgent: payload.sourceAgent,
            childAgent: childAgentId,
            childType: payload.toAgentType,
            reason: payload.reason.substring(0, 100)
          });
          
          // Mark handoff as read
          await this.agentExecutor.messageQueue.markAsRead(handoff.id);
        } else {
          this.logger.warn('Failed to spawn child agent from handoff', {
            parentAgent: payload.sourceAgent,
            requestedType: payload.toAgentType
          });
        }
        
      } catch (error) {
        this.logger.error('Failed to process handoff request', {
          handoffId: handoff.id,
          error: error.message
        });
      }
    }
  }

  /**
   * Poll action queue for MCP-injected actions
   * Similar to topic queue but for direct actions (spawn agent, create goal, generate code)
   */
  /**
   * Check if there are any immediate actions waiting
   */
  async hasImmediateActions() {
    const fs = require('fs').promises;
    const path = require('path');
    const actionsQueuePath = path.join(this.config.logsDir || './runtime', 'actions-queue.json');

    try {
      const content = await fs.readFile(actionsQueuePath, 'utf-8');
      const actionsData = JSON.parse(content);

      if (!actionsData.actions) return false;

      return actionsData.actions.some(a => a.status === 'pending' && a.immediate === true);
    } catch (error) {
      return false;
    }
  }

  /**
   * Start high-frequency poller for immediate actions
   * Runs every 500ms independently of the main cycle loop
   */
  startImmediateActionPoller() {
    if (this._immediateActionPoller) {
      clearInterval(this._immediateActionPoller);
    }

    this._immediateActionPoller = setInterval(async () => {
      if (!this.running) return;

      try {
        const hasImmediate = await this.hasImmediateActions();
        if (hasImmediate) {
          this.logger.info('⚡ INSTANT: Processing immediate action(s)...');
          await this.pollActionQueue(true); // true = prioritize immediate
        }
      } catch (error) {
        // Silently ignore errors in background poller
      }
    }, 500); // Check every 500ms

    this.logger.info('⚡ Immediate action poller started (500ms interval)');
  }

  /**
   * Stop the immediate action poller
   */
  stopImmediateActionPoller() {
    if (this._immediateActionPoller) {
      clearInterval(this._immediateActionPoller);
      this._immediateActionPoller = null;
      this.logger.info('⚡ Immediate action poller stopped');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GUARDIAN CONTROL FILE INTEGRATION
  // Guardian writes control files to {runtime}/control/ directory
  // COSMO monitors and processes these commands to recover from stuck states
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start Guardian control file poller
   * Checks for control commands every 2 seconds
   */
  startGuardianControlPoller() {
    if (this._guardianControlPoller) {
      clearInterval(this._guardianControlPoller);
    }

    this._guardianControlPoller = setInterval(async () => {
      if (!this.running) return;

      try {
        await this.pollGuardianControlFiles();
      } catch (error) {
        // Silently ignore errors in background poller
        this.logger.debug('Guardian control poll error:', error.message);
      }
    }, 2000); // Check every 2 seconds

    this.logger.info('🛡️  Guardian control file poller started (2s interval)');
  }

  /**
   * Stop the Guardian control file poller
   */
  stopGuardianControlPoller() {
    if (this._guardianControlPoller) {
      clearInterval(this._guardianControlPoller);
      this._guardianControlPoller = null;
      this.logger.info('🛡️  Guardian control file poller stopped');
    }
  }

  /**
   * Poll for Guardian control files and process commands
   */
  async pollGuardianControlFiles() {
    const fs = require('fs').promises;
    const path = require('path');
    const controlDir = path.join(this.config.logsDir || this.logsDir || './runtime', 'control');

    try {
      // Check if control directory exists
      await fs.access(controlDir);
    } catch (error) {
      // Control directory doesn't exist - that's fine, no commands pending
      return;
    }

    // Check for each control file type
    const controlFiles = [
      { file: 'wake.json', handler: this.handleGuardianWakeCommand.bind(this) },
      { file: 'restart.json', handler: this.handleGuardianRestartCommand.bind(this) },
      { file: 'consolidate.json', handler: this.handleGuardianConsolidateCommand.bind(this) }
    ];

    for (const { file, handler } of controlFiles) {
      const filePath = path.join(controlDir, file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const command = JSON.parse(content);

        this.logger.info(`🛡️  GUARDIAN: Processing ${file} command`, {
          command: command.command,
          source: command.source,
          reason: command.reason
        });

        // Process the command
        await handler(command);

        // Archive the processed command file
        await this.archiveGuardianControlFile(filePath, command, file);

      } catch (error) {
        if (error.code !== 'ENOENT') {
          // Log non-missing-file errors
          this.logger.warn(`Failed to process Guardian control file ${file}:`, error.message);
        }
      }
    }
  }

  /**
   * Archive a processed Guardian control file
   */
  async archiveGuardianControlFile(filePath, command, fileName) {
    const fs = require('fs').promises;
    const path = require('path');

    const archiveDir = path.join(path.dirname(filePath), 'processed');

    try {
      await fs.mkdir(archiveDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(archiveDir, `${timestamp}_${fileName}`);

      // Add processing metadata
      const archivedCommand = {
        ...command,
        processedAt: new Date().toISOString(),
        processedByCycle: this.cycleCount
      };

      await fs.writeFile(archivePath, JSON.stringify(archivedCommand, null, 2));

      // Remove original file
      await fs.unlink(filePath);

      this.logger.info(`🛡️  GUARDIAN: Archived ${fileName} to ${archivePath}`);
    } catch (error) {
      this.logger.warn(`Failed to archive Guardian control file ${fileName}:`, error.message);
      // Still try to remove the original to prevent reprocessing
      try {
        await fs.unlink(filePath);
      } catch (e) {
        // Ignore
      }
    }
  }

  /**
   * Handle Guardian wake command - inject energy and force wake from sleep
   */
  async handleGuardianWakeCommand(command) {
    this.logger.info('🛡️  GUARDIAN WAKE: Executing wake command', {
      reason: command.reason,
      action: command.action
    });

    // 1. Inject energy into cognitive state
    if (this.stateModulator) {
      const currentEnergy = this.stateModulator.state.energy;
      const energyBoost = 0.5; // Significant energy injection

      this.stateModulator.restoreEnergy(energyBoost);
      this.logger.info(`🛡️  GUARDIAN: Energy injected (${currentEnergy.toFixed(2)} → ${this.stateModulator.state.energy.toFixed(2)})`);

      // 2. Force transition to active mode if sleeping
      if (this.stateModulator.state.mode === 'sleeping') {
        this.stateModulator.transitionToMode('active');
        this.logger.info('🛡️  GUARDIAN: Forced wake from sleep mode');
      }

      // 3. Boost curiosity to encourage activity
      this.stateModulator.boostCuriosity(0.3);
      this.logger.info('🛡️  GUARDIAN: Curiosity boosted');
    }

    // 4. Wake temporal rhythms PROPERLY (must call wake() to set lastWakeTime)
    // BUG FIX (Jan 25, 2026): Just setting state='awake' doesn't update lastWakeTime,
    // so checkSleepTrigger()'s debounce check fails and system goes right back to sleep
    if (this.temporal) {
      if (this.temporal.state === 'sleeping') {
        this.temporal.wake(); // This sets state, lastWakeTime, AND reduces fatigue
        this.logger.info('🛡️  GUARDIAN: Temporal rhythms woken via wake()');
      } else {
        // Even if already awake, update lastWakeTime to prevent immediate re-sleep
        this.temporal.lastWakeTime = new Date();
        this.temporal.fatigue = Math.max(0, this.temporal.fatigue - 0.3); // Reduce fatigue
        this.logger.info('🛡️  GUARDIAN: Temporal lastWakeTime refreshed, fatigue reduced');
      }
    }

    // 5. Clear any sleep session tracking
    if (this.sleepSession) {
      this.sleepSession.active = false;
      this.sleepSession.startCycle = null;
      this.sleepSession.consolidationRun = false;
      this.logger.info('🛡️  GUARDIAN: Sleep session cleared');
    }

    // 6. Emit Guardian intervention event
    this._getEvents().emitEvent('guardian_intervention', {
      type: 'wake',
      reason: command.reason,
      cycle: this.cycleCount,
      timestamp: new Date().toISOString(),
      energyAfter: this.stateModulator?.state?.energy,
      modeAfter: this.stateModulator?.state?.mode
    });

    this.logger.info('🛡️  GUARDIAN WAKE: Complete - system should now be active');
  }

  /**
   * Handle Guardian restart command - restart the coordinator cycle
   */
  async handleGuardianRestartCommand(command) {
    this.logger.info('🛡️  GUARDIAN RESTART: Executing restart command', {
      reason: command.reason
    });

    // 1. Force wake first
    await this.handleGuardianWakeCommand({
      command: 'wake',
      reason: `Restart prerequisite: ${command.reason}`,
      action: 'inject_energy',
      source: 'guardian_restart'
    });

    // 2. Request coordinator refresh if available
    if (this.coordinator && typeof this.coordinator.requestRefresh === 'function') {
      this.coordinator.requestRefresh();
      this.logger.info('🛡️  GUARDIAN: Coordinator refresh requested');
    }

    // 3. Clear any cached review plans
    this.currentReviewPlan = null;
    this.lastConsistencyReviewCycle = null;

    // 4. Emit restart event
    this._getEvents().emitEvent('guardian_intervention', {
      type: 'restart',
      reason: command.reason,
      cycle: this.cycleCount,
      timestamp: new Date().toISOString()
    });

    this.logger.info('🛡️  GUARDIAN RESTART: Complete - next cycle will run fresh');
  }

  /**
   * Handle Guardian consolidate command - trigger memory consolidation
   */
  async handleGuardianConsolidateCommand(command) {
    this.logger.info('🛡️  GUARDIAN CONSOLIDATE: Executing consolidate command', {
      reason: command.reason
    });

    // 1. Trigger memory consolidation if summarizer is available
    if (this.summarizer && typeof this.summarizer.consolidateMemory === 'function') {
      try {
        this.logger.info('🛡️  GUARDIAN: Starting memory consolidation...');
        await this.summarizer.consolidateMemory(this.memory, {
          force: true,
          source: 'guardian'
        });
        this.logger.info('🛡️  GUARDIAN: Memory consolidation complete');
      } catch (error) {
        this.logger.warn('🛡️  GUARDIAN: Memory consolidation failed:', error.message);
      }
    }

    // 2. Update last consolidation timestamp
    this.lastConsolidation = new Date();

    // 3. Save state after consolidation
    try {
      await this.saveState();
      this.logger.info('🛡️  GUARDIAN: State saved after consolidation');
    } catch (error) {
      this.logger.warn('🛡️  GUARDIAN: State save failed:', error.message);
    }

    // 4. Emit consolidation event
    this._getEvents().emitEvent('guardian_intervention', {
      type: 'consolidate',
      reason: command.reason,
      cycle: this.cycleCount,
      timestamp: new Date().toISOString()
    });

    this.logger.info('🛡️  GUARDIAN CONSOLIDATE: Complete');
  }

  /**
   * Process guardian_wake action from actions-queue.json
   * This is injected by Guardian when it detects stuck states
   */
  async processGuardianWakeAction(action) {
    this.logger.info('🛡️  GUARDIAN ACTION: Processing guardian_wake from action queue', {
      actionId: action.actionId,
      reason: action.metadata?.reason
    });

    // Treat this as a wake command
    await this.handleGuardianWakeCommand({
      command: 'wake',
      timestamp: action.timestamp,
      source: action.source || 'guardian_action_queue',
      reason: action.metadata?.reason || 'Guardian-injected wake action',
      action: action.metadata?.injectEnergy ? 'inject_energy' : 'wake'
    });

    return { success: true, message: 'Guardian wake action processed' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // END GUARDIAN CONTROL FILE INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async pollActionQueue(prioritizeImmediate = false) {
    const fs = require('fs').promises;
    const path = require('path');
    const actionsQueuePath = path.join(this.config.logsDir || './runtime', 'actions-queue.json');

    try {
      // Read action queue
      const content = await fs.readFile(actionsQueuePath, 'utf-8');
      const actionsData = JSON.parse(content);

      if (!actionsData.actions || actionsData.actions.length === 0) {
        return; // Nothing to process
      }

      let pendingActions = actionsData.actions.filter(a => a.status === 'pending');

      // If prioritizing immediate, process those first
      if (prioritizeImmediate) {
        const immediateActions = pendingActions.filter(a => a.immediate === true);
        if (immediateActions.length > 0) {
          this.logger.info(`⚡ IMMEDIATE: Processing ${immediateActions.length} immediate action(s)`);
          pendingActions = immediateActions; // Only process immediate ones this cycle
        }
      }

      if (pendingActions.length === 0) {
        return; // All processed
      }

      this.logger.info(`⚡ Processing ${pendingActions.length} pending action(s) from MCP queue`);
      
      for (const action of pendingActions) {
        try {
          await this.processAction(action);
          action.status = 'completed';
          action.completedAt = new Date().toISOString();
          action.completedCycle = this.cycleCount;
        } catch (error) {
          this.logger.error(`Failed to process action ${action.actionId}:`, error);
          action.status = 'failed';
          action.error = error.message;
          action.failedAt = new Date().toISOString();
        }
      }
      
      // Write back updated queue
      await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2));
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, that's fine
        return;
      }
      this.logger.error('Failed to poll action queue:', error);
    }
  }
  
  /**
   * Process a single action from the queue
   */
  async processAction(action) {
    this.logger.info(`🎯 Processing ${action.type} action (ID: ${action.actionId})`);
    
    switch (action.type) {
      case 'spawn_agent':
        return await this.processSpawnAgentAction(action);
      
      case 'create_goal':
        return await this.processCreateGoalAction(action);
      
      case 'generate_code':
        return await this.processGenerateCodeAction(action);
      
      case 'inject_plan':
        return await this.processInjectPlanAction(action);
      
      case 'complete_plan':
        return await this.processCompletePlanAction(action);
      
      case 'complete_task':
        return await this.processCompleteTaskAction(action);
      
      case 'validate_task':
        return await this.processValidateTaskAction(action);
      
      case 'retry_task_validation':
        return await this.processRetryTaskValidationAction(action);
      
      case 'check_milestone':
        return await this.processCheckMilestoneAction(action);

      case 'refocus':
        return await this.processRefocusAction(action);

      case 'guardian_wake':
        return await this.processGuardianWakeAction(action);

      case 'action_coordinator_trigger':
        return await this.processActionCoordinatorTrigger(action);

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }
  
  /**
   * Check milestone completion from dashboard action queue
   */
  async processCheckMilestoneAction(action) {
    if (!this.clusterStateStore) {
      throw new Error('ClusterStateStore not available');
    }
    
    this.logger.info('🔍 Manually checking milestone completion', {
      planId: action.planId,
      milestoneId: action.milestoneId
    });
    
    await this.checkMilestoneCompletion(action.planId, action.milestoneId);
  }

  /**
   * Process refocus action from dashboard - clear head without losing memory
   */
  async processRefocusAction(action) {
    this.logger.info('🔄 Processing refocus action from dashboard');

    const payload = action.payload || {};
    const result = await this.refocus({
      newFocus: payload.newFocus,
      archiveAllGoals: payload.archiveGoals !== false,
      clearPendingAgents: payload.clearPendingAgents !== false
    });

    this.logger.info('✅ Refocus complete via action queue', result);
    return result;
  }

  /**
   * Process Action Coordinator trigger from dashboard action queue
   */
  async processActionCoordinatorTrigger(action) {
    this.logger.info('🔨 Processing Action Coordinator trigger from dashboard');

    if (!this.actionCoordinator) {
      throw new Error('Action Coordinator not available');
    }

    // Enable force trigger
    this.actionCoordinator.enableForceTrigger();

    this.logger.info('✅ Action Coordinator force trigger enabled - will run on next cycle');
    return { success: true };
  }

  /**
   * Complete task from dashboard action queue
   */
  async processCompleteTaskAction(action) {
    if (!this.clusterStateStore) {
      throw new Error('ClusterStateStore not available');
    }
    
    // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Use queue if available
    if (this.taskStateQueue) {
      await this.taskStateQueue.enqueue({
        type: 'COMPLETE_TASK',
        taskId: action.taskId,
        cycle: this.cycleCount,
        source: 'actions_queue_manual_completion',
        reason: action.reason
      });
    } else {
      // Fallback to direct write
      await this.clusterStateStore.completeTask(action.taskId);
    }
    
    this.logger.info('✓ Task manually completed via actions queue', {
      taskId: action.taskId,
      reason: action.reason
    });
    
    // Get task to find milestone
    const allTasks = await this.clusterStateStore.listTasks('plan:main');
    const task = allTasks.find(t => t.id === action.taskId);
    
    if (task) {
      // Check if milestone should advance
      await this.checkMilestoneCompletion(task.planId, task.milestoneId);
    }
  }
  
  /**
   * Validate task from dashboard action queue (spawn QA agent)
   */
  async processValidateTaskAction(action) {
    if (!this.agentExecutor || !this.clusterStateStore) {
      throw new Error('AgentExecutor or ClusterStateStore not available');
    }
    
    const allTasks = await this.clusterStateStore.listTasks('plan:main');
    const task = allTasks.find(t => t.id === action.taskId);
    
    if (!task) {
      throw new Error(`Task ${action.taskId} not found`);
    }
    
    this.logger.info('🔍 Spawning validation agent for task', {
      taskId: action.taskId,
      goalId: task.metadata?.goalId
    });
    
    const validationMission = {
      missionId: `mission_validation_${action.taskId}_${Date.now()}`,
      agentType: 'quality_assurance',
      goalId: `${task.metadata?.goalId || action.taskId}_validation`,
      taskId: task.id,
      description: `Validate that task "${task.title}" is complete and meets acceptance criteria: ${task.acceptanceCriteria?.map(c => c.rubric).join('; ')}`,
      successCriteria: ['Task validation complete', 'Acceptance criteria checked'],
      deliverable: {
        type: 'validation_report',
        format: 'json',
        filename: `task_${action.taskId}_validation.json`
      },
      maxDuration: 300000,
      createdBy: 'dashboard',
      spawnCycle: this.cycleCount,
      triggerSource: 'manual_validation',
      spawningReason: action.reason || 'User requested task validation from dashboard',
      priority: 2.0,
      metadata: {
        originalTaskId: action.taskId,
        validationRequest: true,
        manualTrigger: true
      }
    };
    
    action.agentId = await this.agentExecutor.spawnAgent(validationMission);
    this.logger.info('✓ Validation agent spawned', { agentId: action.agentId });
  }
  
  /**
   * Retry task validation from dashboard action queue
   * 
   * ✅ FIX P1.6: Complete implementation that actually enables retry
   * Previous version only reset validation flag but left task in FAILED state
   * This prevented task from being claimed again
   */
  async processRetryTaskValidationAction(action) {
    if (!this.clusterStateStore) {
      throw new Error('ClusterStateStore not available');
    }
    
    const allTasks = await this.clusterStateStore.listTasks('plan:main');
    const task = allTasks.find(t => t.id === action.taskId);
    
    if (!task) {
      throw new Error(`Task ${action.taskId} not found`);
    }
    
    this.logger.info('🔄 Resetting task for retry', {
      taskId: action.taskId,
      currentState: task.state,
      previousFailure: task.failureReason,
      assignedAgent: task.assignedAgentId
    });
    
    // ✅ COMPLETE RESET for retry
    
    // 1. Reset validation metadata
    task.metadata = task.metadata || {};
    task.metadata.validationAttempted = false;
    delete task.metadata.validationCycle;
    delete task.metadata.validationAttempts;
    delete task.metadata.lastValidationFailure;
    
    // 2. ✅ FIX: Reset state to PENDING (moves file from failed/ to pending/)
    const previousState = task.state;
    task.state = 'PENDING';
    
    // 3. ✅ FIX: Clear all claim and assignment info
    task.claimedBy = null;
    task.claimExpires = null;
    task.assignedAgentId = null;
    
    // 4. ✅ FIX: Clear failure tracking
    delete task.failureReason;
    delete task.failedAt;
    
    // 5. Track retry attempts
    task.metadata.retryCount = (task.metadata.retryCount || 0) + 1;
    task.metadata.lastRetryAt = Date.now();
    task.metadata.previousStates = task.metadata.previousStates || [];
    task.metadata.previousStates.push({
      state: previousState,
      timestamp: Date.now(),
      reason: 'manual_retry_requested',
      failureReason: task.failureReason
    });
    
    task.updatedAt = Date.now();
    
    // 6. Update task (upsertTask will move file from failed/ to pending/)
    // UNIFIED QUEUE ARCHITECTURE: Retry is handled by retryTask in queue, this is legacy
    const updated = await this.clusterStateStore.upsertTask(task);
    
    if (updated) {
      this.logger.info('✅ Task reset complete - will be claimable next cycle', {
        taskId: task.id,
        previousState,
        newState: 'PENDING',
        retryCount: task.metadata.retryCount,
        fileLocation: 'tasks/'
      });
      
      action.success = true;
      action.taskReset = true;
      action.newState = 'PENDING';
      action.retryCount = task.metadata.retryCount;
    } else {
      throw new Error('Failed to update task in state store');
    }
  }
  
  /**
   * Spawn agent from MCP action
   */
  async processSpawnAgentAction(action) {
    if (!this.agentExecutor) {
      throw new Error('AgentExecutor not available');
    }
    
    // Check if mission is a JSON string (advanced mode from dashboard)
    let parsedMission = null;
    try {
      parsedMission = JSON.parse(action.mission);
    } catch {
      // Not JSON - treat as simple string description
    }
    
    // If mission is a full spec, use it; otherwise create basic spec
    const missionSpec = parsedMission || {
      missionId: `mission_mcp_${Date.now()}`,
      agentType: action.agentType,
      goalId: `goal_mcp_${Date.now()}`,
      description: action.mission,
      successCriteria: ['Complete the requested task', 'Store outputs appropriately'],
      maxDuration: 900000, // 15 minutes
      createdBy: 'mcp_action_queue',
      spawnCycle: this.cycleCount,
      triggerSource: 'mcp_action',
      spawningReason: `MCP action request from ${action.source}`,
      priority: action.priority || 0.8,
      provenanceChain: [action.actionId],
      metadata: action.metadata || {}
    };

    // SMART ENRICHMENT: Refine mission spec based on agent type and user input
    // This mirrors the logic in the dashboard to ensure consistency
    const desc = (missionSpec.description || '').toLowerCase();
    const wordCount = desc.split(/\s+/).length;

    if (missionSpec.agentType === 'research') {
      // Heuristic: If this is research and we don't have a claim, ensure the description triggers exploratory mode
      if (!missionSpec.intake || !missionSpec.intake.claimText) {
        if (!desc.includes('research') && !desc.includes('survey') && !desc.includes('explore') && !desc.includes('verify')) {
          missionSpec.description = `Research: ${missionSpec.description}`;
          this.logger.info(`ℹ️  Auto-prefixed research mission to ensure exploratory mode: "${missionSpec.description}"`);
        }
      }
    } else if (missionSpec.agentType === 'document_analysis') {
      // Check for ingestion intent
      if (desc.includes('ingest') || desc.includes('import') || desc.includes('index')) {
        missionSpec.metadata.isIngestion = true;
      }
      // Ensure target context
      if (!desc.includes('/') && !desc.includes('.') && wordCount < 5) {
        missionSpec.description = `Analyze and extract evolution story from documents related to: ${missionSpec.description}`;
      }
    } else if (missionSpec.agentType === 'synthesis') {
      // Check for final deliverable assembly
      if (desc.includes('final') || desc.includes('assemble') || desc.includes('complete')) {
        missionSpec.metadata.isFinalSynthesis = true;
      }
    } else if (missionSpec.agentType === 'code_creation') {
      // Frame as creation
      if (!desc.includes('create') && !desc.includes('generate') && !desc.includes('implement')) {
        missionSpec.description = `Implement a solution for: ${missionSpec.description}`;
      }
    } else if (missionSpec.agentType === 'code_execution') {
      // Frame as execution
      if (!desc.includes('execute') && !desc.includes('validate') && !desc.includes('run')) {
        missionSpec.description = `Validate and execute: ${missionSpec.description}`;
      }
    } else if (missionSpec.agentType === 'specialized_binary') {
      // Frame as extraction
      if (!desc.includes('extract') && !desc.includes('process') && !desc.includes('read')) {
        missionSpec.description = `Process and extract content from binary files related to: ${missionSpec.description}`;
      }
    }
    
    // Add cycle and provenance info if not already present
    if (!missionSpec.spawnCycle) {
      missionSpec.spawnCycle = this.cycleCount;
    }
    if (!missionSpec.provenanceChain) {
      missionSpec.provenanceChain = [action.actionId];
    }
    
    // Defensive: Validate agentType before spawning
    if (!missionSpec.agentType) {
      this.logger.error('❌ MCP action missing agentType, cannot spawn', {
        actionId: action.actionId,
        mission: action.mission?.substring(0, 100)
      });
      action.error = 'Missing agentType';
      action.status = 'failed';
      return;
    }
    
    const agentId = await this.agentExecutor.spawnAgent(missionSpec);
    
    if (agentId) {
      this.logger.info(`✅ Spawned ${action.agentType} agent (${agentId}) from ${action.source || 'MCP'} action`);
      action.agentId = agentId;
      action.missionId = missionSpec.missionId || missionSpec.goalId;
    } else {
      throw new Error('Failed to spawn agent');
    }
  }
  
  /**
   * Create goal from MCP action
   */
  async processCreateGoalAction(action) {
    if (!this.goals) {
      throw new Error('Goal system not available');
    }
    
    // Format goal data to match what IntrinsicGoalSystem.addGoal() expects
    const goalData = {
      description: action.description,
      reason: 'User-requested via MCP action queue',
      uncertainty: action.priority || 0.8,  // addGoal converts uncertainty to priority
      source: 'mcp_action_queue',
      metadata: {
        mcpActionId: action.actionId,
        urgent: action.urgent || false,
        requestedAt: action.requestedAt,
        requestSource: action.source || 'mcp',
        // CRITICAL: Pass through any additional metadata from action (e.g., experimental flag)
        ...(action.metadata || {})
      }
    };
    
    // Add goal to goals system (synchronous, not async)
    const createdGoal = this.goals.addGoal(goalData);
    
    if (createdGoal) {
      this.logger.info(`✅ Created goal from MCP action: "${action.description}" (ID: ${createdGoal.id})`);
      action.goalId = createdGoal.id;
    } else {
      throw new Error('Goal creation failed (validation failed)');
    }
  }
  
  /**
   * Generate code from MCP action
   */
  async processGenerateCodeAction(action) {
    if (!this.agentExecutor) {
      throw new Error('AgentExecutor not available');
    }
    if (!this.codingAgentsEnabled) {
      this.logger.warn('✋ Ignoring code generation request because coding agents are disabled', {
        actionId: action.actionId,
        source: action.source
      });
      return;
    }
    
    // Code generation = spawn code_creation agent
    const missionSpec = {
      missionId: `mission_code_gen_${Date.now()}`,
      agentType: 'code_creation',
      goalId: `goal_code_gen_${Date.now()}`,
      description: `Generate ${action.language} code: ${action.spec}`,
      codeSpec: {
        specification: action.spec,
        language: action.language,
        projectType: 'standalone'
      },
      successCriteria: ['Generate working code', 'Save to outputs directory', 'Include documentation'],
      maxDuration: 900000, // 15 minutes
      createdBy: 'mcp_action_queue',
      spawnCycle: this.cycleCount,
      triggerSource: 'mcp_code_generation',
      spawningReason: `Code generation request from ${action.source}`,
      priority: 0.7,
      provenanceChain: [action.actionId]
    };
    
    const agentId = await this.agentExecutor.spawnAgent(missionSpec);
    
    if (agentId) {
      this.logger.info(`✅ Spawned code_creation agent (${agentId}) from MCP action`);
      action.agentId = agentId;
      action.missionId = missionSpec.missionId;
    } else {
      throw new Error('Failed to spawn code generation agent');
    }
  }
  
  /**
   * Inject new plan from dashboard action
   */
  async processInjectPlanAction(action) {
    this.logger.info('📋 Processing plan injection', {
      domain: action.domain,
      executionMode: action.executionMode
    });
    
    // Archive current plan if requested
    if (action.metadata?.archiveCurrentPlan) {
      // First, get plan from stateStore and archive it
      if (this.clusterStateStore) {
        try {
          const currentPlan = await this.clusterStateStore.getPlan('plan:main');
          if (currentPlan && currentPlan.status !== 'COMPLETED') {
            currentPlan.status = 'ARCHIVED';
            currentPlan.archivedAt = Date.now();
            currentPlan.archivedReason = 'new_plan_injected';
            
            // Save archived version to file
            const archivedPath = path.join(this.config.logsDir || './runtime', 'plans', `plan:main_archived_${Date.now()}.json`);
            await require('fs').promises.writeFile(archivedPath, JSON.stringify(currentPlan, null, 2), 'utf-8');
            
            this.logger.info('📦 Archived current plan', { planId: currentPlan.id });
            
            // CRITICAL: Update plan status in stateStore so it won't be resumed
            await this.clusterStateStore.updatePlan('plan:main', {
              status: 'ARCHIVED',
              archivedAt: Date.now(),
              archivedReason: 'new_plan_injected'
            });
            this.logger.info('✅ Marked old plan as archived in state store');
            
            // Fetch task goalIds BEFORE archiving (archiving moves files from same directory!)
            const oldTasks = await this.clusterStateStore.listTasks(currentPlan.id);
            const oldTaskGoalIds = oldTasks
              .map(t => t.metadata?.goalId)
              .filter(Boolean);

            // CRITICAL: Archive old tasks to prevent ID collision with new plan
            // Move completed/pending tasks to archived folder
            await this.archiveOldPlanTasks(currentPlan.id, Date.now());

            // ✅ FIX P1.4: Stop agents working on old plan before creating new plan
            // This prevents duplicate agents (old + new) running simultaneously
            if (this.agentExecutor) {
              try {
                if (oldTaskGoalIds.length > 0) {
                  // Find agents working on old plan's goals
                  const activeAgents = this.agentExecutor.registry.getActiveAgents();
                  const oldPlanAgents = activeAgents.filter(agentState => 
                    oldTaskGoalIds.includes(agentState.mission.goalId)
                  );
                  
                  if (oldPlanAgents.length > 0) {
                    this.logger.warn('🛑 Stopping agents from superseded plan', {
                      planId: currentPlan.id,
                      agentCount: oldPlanAgents.length,
                      agentIds: oldPlanAgents.map(a => a.agent.agentId),
                      reason: 'new_plan_injected'
                    });
                    
                    // Request graceful stop for each agent
                    const stopResults = [];
                    for (const agentState of oldPlanAgents) {
                      try {
                        if (typeof agentState.agent.requestStop === 'function') {
                          const result = await agentState.agent.requestStop('plan_superseded');
                          stopResults.push({
                            agentId: agentState.agent.agentId,
                            success: true,
                            checkpointSaved: result.checkpointSaved,
                            partialResults: result.results?.length || 0
                          });
                        } else {
                          this.logger.warn('Agent does not support graceful stop', {
                            agentId: agentState.agent.agentId,
                            type: agentState.agent.constructor.name
                          });
                          stopResults.push({
                            agentId: agentState.agent.agentId,
                            success: false,
                            reason: 'no_requestStop_method'
                          });
                        }
                      } catch (error) {
                        this.logger.error('Agent stop request failed', {
                          agentId: agentState.agent.agentId,
                          error: error.message
                        });
                        stopResults.push({
                          agentId: agentState.agent.agentId,
                          success: false,
                          error: error.message
                        });
                      }
                    }
                    
                    // Give agents time to save checkpoints (5 seconds)
                    this.logger.info('⏳ Waiting for agent checkpoints...', {
                      agents: oldPlanAgents.length,
                      timeoutMs: 5000
                    });
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Log cleanup results
                    const successCount = stopResults.filter(r => r.success).length;
                    this.logger.info('✅ Agent cleanup complete', {
                      total: oldPlanAgents.length,
                      succeeded: successCount,
                      failed: oldPlanAgents.length - successCount,
                      checkpointsSaved: stopResults.filter(r => r.checkpointSaved).length
                    });
                    
                    // Store in action metadata for audit trail
                    if (!action.metadata) action.metadata = {};
                    action.metadata.agentsStoppedCount = oldPlanAgents.length;
                    action.metadata.agentStopResults = stopResults;
                  } else {
                    this.logger.info('ℹ️  No active agents from old plan to stop');
                  }
                }
              } catch (error) {
                this.logger.error('Failed to stop old plan agents', {
                  error: error.message,
                  stack: error.stack
                });
                // Don't throw - proceed with plan injection even if cleanup failed
                // New plan will have different goalIds to avoid most conflicts
              }
            }
            
            // CRITICAL: Clear old task-related goals from goal system
            // These are the goals that were created to match old plan tasks
            // If not cleared, they conflict with new plan's tasks
            if (this.goals && oldTaskGoalIds.length > 0) {
              try {
                this.logger.info('🧹 Clearing old task-related goals', {
                  goalCount: oldTaskGoalIds.length,
                  oldPlanId: currentPlan.id
                });
                
                // Archive all old task goals
                const archived = await this.goals.archiveGoalsByIds(
                  oldTaskGoalIds,
                  'old_plan_superseded_by_new_plan'
                );
                
                this.logger.info('✅ Old task goals cleared', {
                  goalsArchived: archived,
                  reason: 'new_plan_injected'
                });
              } catch (error) {
                this.logger.error('Failed to clear old task goals', {
                  error: error.message
                });
                // Don't throw - new plan should still work
              }
            }
          }
        } catch (error) {
          this.logger.warn('Failed to archive plan from state store', { error: error.message });
        }
      }
      
      // Also archive file-based plan (backup)
      const planPath = path.join(this.config.logsDir || './runtime', 'plans', 'plan:main.json');
      try {
        const planStats = await require('fs').promises.stat(planPath);
        if (planStats.isFile()) {
          const archivedPath = path.join(this.config.logsDir || './runtime', 'plans', `plan:main_file_archived_${Date.now()}.json`);
          await require('fs').promises.rename(planPath, archivedPath);
          this.logger.info('📦 Archived plan file', { path: archivedPath });
        }
      } catch (error) {
        // File doesn't exist or already moved - that's fine
      }
    }
    
    const existingGuidedFocus = this.config.architecture.roleSystem.guidedFocus || {};
    const researchDomain = firstNonEmpty(
      action.metadata?.researchDomain,
      action.metadata?.originalDomain,
      existingGuidedFocus.researchDomain,
      existingGuidedFocus.originalDomain,
      existingGuidedFocus.domain,
      action.domain
    );
    const researchContext = firstNonEmpty(
      action.metadata?.researchContext,
      action.metadata?.originalContext,
      existingGuidedFocus.researchContext,
      existingGuidedFocus.originalContext,
      existingGuidedFocus.context,
      action.context || ''
    );

    const normalizedExecution = normalizeExecutionMode('guided', action.executionMode);

    // Update guided focus config AND switch to guided mode
    this.config.architecture.roleSystem.guidedFocus = {
      ...existingGuidedFocus,
      domain: action.domain,
      context: action.context || '',
      executionMode: normalizedExecution.persistedMode,
      effectiveExecutionMode: normalizedExecution.effectiveMode,
      requestedExecutionMode: normalizedExecution.requestedMode,
      researchDomain,
      researchContext,
      originalDomain: researchDomain,
      originalContext: researchContext
    };

    // CRITICAL: Switch from autonomous to guided mode
    // This ensures the orchestrator follows the plan instead of free exploration
    const previousMode = this.config.architecture.roleSystem.explorationMode;
    this.config.architecture.roleSystem.explorationMode = 'guided';
    this.logger.info('🔄 Switched exploration mode', {
      from: previousMode,
      to: 'guided',
      domain: action.domain,
      researchDomain
    });

    try {
      const metadataPath = path.join(this.config.logsDir || './runtime', 'run-metadata.json');
      const metadata = await this.readJsonIfExists(metadataPath) || {};
      metadata.topic = firstNonEmpty(metadata.topic, researchDomain);
      metadata.domain = firstNonEmpty(metadata.domain, researchDomain);
      metadata.context = firstNonEmpty(metadata.context, researchContext, metadata.context);
      metadata.researchDomain = researchDomain;
      metadata.researchContext = researchContext;
      metadata.currentPlanDomain = action.domain;
      metadata.currentPlanContext = action.context || '';
      metadata.requestedExecutionMode = normalizedExecution.requestedMode;
      metadata.effectiveExecutionMode = normalizedExecution.effectiveMode;
      metadata.lastInjectedPlanAt = new Date().toISOString();
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn('Failed to persist research anchor metadata during plan injection', {
        error: error.message
      });
    }
    
    // Reinitialize mission via coordinator
    if (this.coordinator) {
      const missionResult = await this.coordinator.initiateMission({
        guidedFocus: this.config.architecture.roleSystem.guidedFocus,
        forceNew: true,  // CRITICAL: Force new plan creation, don't resume
        subsystems: {
          agentExecutor: this.agentExecutor,
          goals: this.goals,
          clusterStateStore: this.clusterStateStore,
          pathResolver: this.pathResolver,
          capabilities: this.capabilities
        }
      });
      
      const newPlan = missionResult?.plan || missionResult;

      if (newPlan) {
        // Create new completion tracker
        const { CompletionTracker } = require('./completion-tracker');
        this.completionTracker = new CompletionTracker(newPlan, this.logger);
        this.guidedMissionPlan = newPlan;
        
        this.logger.info('✅ New plan injected and active', {
          domain: action.domain,
          phases: newPlan.taskPhases?.length || 0
        });
        
        action.planGenerated = true;
        action.phases = newPlan.taskPhases?.length || 0;
        action.planningAgentIds = missionResult?.planningAgentIds || [];
      } else {
        this.logger.warn('Plan generation returned null');
        action.planGenerated = false;
      }
    } else {
      throw new Error('Coordinator not available for plan generation');
    }
  }
  
  /**
   * Archive old plan's tasks to prevent ID collision when new plan is injected
   * Moves tasks from complete/pending/assigned to archived subfolder
   */
  async archiveOldPlanTasks(planId, archiveTimestamp) {
    const fs = require('fs').promises;
    const tasksDir = path.join(this.config.logsDir || './runtime', 'tasks');
    const archiveDir = path.join(tasksDir, `archived_${archiveTimestamp}`);
    
    try {
      // Create archive directory
      await fs.mkdir(archiveDir, { recursive: true });
      
      let archivedCount = 0;
      
      // BULLETPROOF FIX (Jan 20, 2026): Read from root tasks/ directory (state is in field)
      // All tasks are in tasks/*.json, not in subdirectories
      try {
        const taskFiles = await fs.readdir(tasksDir);
        for (const file of taskFiles) {
          if (file.endsWith('.json') && file.startsWith('task:')) {
            const srcPath = path.join(tasksDir, file);
            
            // Read task to check if it belongs to this plan
            try {
              const taskContent = await fs.readFile(srcPath, 'utf-8');
              const task = JSON.parse(taskContent);
              
              // Only archive tasks from the OLD plan (safety check)
              if (task.planId === planId) {
                const statePrefix = task.state ? `${task.state.toLowerCase()}_` : '';
                const destPath = path.join(archiveDir, `${statePrefix}${file}`);
                await fs.rename(srcPath, destPath);
                archivedCount++;
                this.logger.debug('📦 Archived task', {
                  taskId: task.id,
                  state: task.state,
                  oldPlan: planId
                });
              }
            } catch (parseError) {
              this.logger.warn('Could not parse task file for archival', {
                file,
                error: parseError.message
              });
            }
          }
        }
      } catch (e) {
        this.logger.warn('Could not archive tasks', { error: e.message });
      }
      
      // Also archive milestones to prevent collision
      const milestonesDir = path.join(this.config.logsDir || './runtime', 'milestones');
      const milestonesArchiveDir = path.join(archiveDir, 'milestones');
      try {
        await fs.mkdir(milestonesArchiveDir, { recursive: true });
        const milestones = await fs.readdir(milestonesDir);
        for (const file of milestones) {
          if (file.endsWith('.json') && file.startsWith('ms:')) {
            const srcPath = path.join(milestonesDir, file);
            const destPath = path.join(milestonesArchiveDir, file);
            await fs.rename(srcPath, destPath);
            archivedCount++;
          }
        }
      } catch (e) { /* directory may not exist */ }
      
      this.logger.info('📦 Archived old plan tasks and milestones', {
        planId,
        archiveDir,
        itemsArchived: archivedCount
      });
      
    } catch (error) {
      this.logger.warn('Failed to archive old plan tasks', { 
        planId, 
        error: error.message 
      });
    }
  }
  
  /**
   * Complete plan from dashboard action - triggers proper handlePlanCompletion flow
   */
  async processCompletePlanAction(action) {
    this.logger.info('📋 Processing plan completion from dashboard', {
      planId: action.planId
    });
    
    // Get the plan
    const plan = await this.clusterStateStore?.getPlan(action.planId);
    if (!plan) {
      // Try loading from filesystem directly
      const planPath = path.join(this.config.logsDir || './runtime', 'plans', `${action.planId}.json`);
      try {
        const planContent = await require('fs').promises.readFile(planPath, 'utf-8');
        const filePlan = JSON.parse(planContent);
        
        // Mark as completed in file
        filePlan.status = 'COMPLETED';
        filePlan.completedAt = Date.now();
        filePlan.completedBy = 'dashboard_user';
        await require('fs').promises.writeFile(planPath, JSON.stringify(filePlan, null, 2), 'utf-8');
        
        // Trigger completion handling
        await this.handlePlanCompletion(filePlan);
        
        action.completed = true;
        return;
      } catch (error) {
        throw new Error(`Plan not found: ${action.planId}`);
      }
    }
    
    // Mark as completed via state store
    if (this.clusterStateStore) {
      plan.status = 'COMPLETED';
      plan.completedAt = Date.now();
      plan.completedBy = 'dashboard_user';
      await this.clusterStateStore.updatePlan(plan.id, {
        status: 'COMPLETED',
        completedAt: plan.completedAt,
        completedBy: plan.completedBy
      });
    }
    
    // Trigger the proper completion handling (audit, memory node, logging)
    await this.handlePlanCompletion(plan);
    
    action.completed = true;
    this.logger.info('✅ Plan marked complete via dashboard', {
      planId: plan.id,
      title: plan.title
    });
  }
  
  /**
   * Extract goal IDs from text (matches goal_XXX pattern)
   */
  extractGoalIds(text) {
    if (!text || typeof text !== 'string') return [];
    const matches = text.match(/goal_\d+/g) || [];
    return [...new Set(matches)]; // Deduplicate
  }

  /**
   * Spawn specialist agents based on Meta-Coordinator priorities
   */
  async spawnAgentsForPriorities(reviewResult) {
    try {
      this.logger.info('');
      this.logger.info('🚀 SPAWNING SPECIALIST AGENTS');
      this.logger.info('');

      // ═══════════════════════════════════════════════════════════════════════
      // COSMO HANDS: Check for goals that can be handled directly FIRST
      // Direct actions bypass agent spawning for simple, single-step operations
      // ═══════════════════════════════════════════════════════════════════════
      const directableGoals = this.findDirectableGoals(reviewResult.prioritizedGoals);
      
      if (directableGoals.length > 0) {
        this.logger.info(`🤲 Found ${directableGoals.length} goal(s) eligible for direct action`);
        
        // Execute direct actions
        const directResult = await this.executeDirectGoals(directableGoals);
        
        // Remove successfully handled goals from prioritized list
        const handledGoalIds = new Set(
          directResult.results
            .filter(r => r.success)
            .map(r => r.goalId)
        );
        
        // Filter out handled goals before creating mission specs
        reviewResult.prioritizedGoals = reviewResult.prioritizedGoals.filter(
          g => !handledGoalIds.has(g.id)
        );
        
        this.logger.info(`   ${handledGoalIds.size} goal(s) completed directly, ${reviewResult.prioritizedGoals.length} remaining for agents`);
      }

      // Create mission specifications for remaining priority goals
      const missionSpecs = await this.coordinator.createMissionSpecs(
        reviewResult.prioritizedGoals,
        this.cycleCount,
        2 // Max 2 agents per review to avoid overwhelming system
      );

      if (missionSpecs.length === 0) {
        this.logger.info('No mission specs created, skipping agent spawning');
        return;
      }

      // Spawn agents for each mission
      const spawnedAgents = [];
      
      for (const missionSpec of missionSpecs) {
        this.logger.info('Attempting to spawn agent', {
          agentType: missionSpec.agentType,
          goalId: missionSpec.goalId,
          description: missionSpec.description.substring(0, 100)
        });

        const agentId = await this.agentExecutor.spawnAgent(missionSpec);
        
        if (agentId) {
          spawnedAgents.push(agentId);
          this.logger.info('✅ Agent spawned successfully', {
            agentId,
            agentType: missionSpec.agentType,
            goalId: missionSpec.goalId
          });
        } else {
          this.logger.warn('Failed to spawn agent', {
            agentType: missionSpec.agentType,
            goalId: missionSpec.goalId,
            reason: 'See previous logs for details'
          });
        }
      }

      // Record spawned agents in coordinator
      if (spawnedAgents.length > 0) {
        this.coordinator.recordAgentsSpawned(this.cycleCount, spawnedAgents);
        this.logger.info('');
        this.logger.info('✅ Agent spawning complete', {
          agentsSpawned: spawnedAgents.length,
          agentIds: spawnedAgents
        });
        this.logger.info('');
      } else {
        this.logger.info('No agents were successfully spawned');
      }

    } catch (error) {
      this.logger.error('Agent spawning failed', {
        error: error.message,
        stack: error.stack
      });
      // Don't throw - agent spawning failures shouldn't crash main loop
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COSMO HANDS - Direct Action System (Orchestrator Integration)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find goals that can be handled directly (no agent needed)
   * 
   * Scans prioritized goals and identifies those that meet direct action criteria:
   * - Single file operation with content ready
   * - Explicitly marked for direct execution
   * - Simple terminal command
   * 
   * @param {Array} goals - Goals to evaluate
   * @returns {Array} - Goals that can be handled directly
   */
  findDirectableGoals(goals) {
    if (!goals || goals.length === 0) return [];
    if (!this.coordinator?.canHandleDirectly) return [];
    
    // Check config flag
    // Direct action is disabled by default - must be explicitly enabled in config
    if (this.config?.directAction?.enabled !== true) return [];
    
    const directableGoals = [];
    
    for (const goal of goals) {
      const check = this.coordinator.canHandleDirectly(goal, {
        cycleCount: this.cycleCount
      });
      
      if (check.direct) {
        directableGoals.push({
          goal,
          action: check.action,
          reason: check.reason
        });
      }
    }
    
    return directableGoals;
  }

  /**
   * Execute goals directly (bypass agent spawning)
   * 
   * CRITICAL: This is the orchestrator's entry point for direct actions.
   * It delegates to MetaCoordinator.executeDirectAction which handles all integrations.
   * 
   * @param {Array} directableGoals - Array of { goal, action, reason }
   * @returns {Object} - { executed: number, failed: number, results: Array }
   */
  async executeDirectGoals(directableGoals) {
    if (!directableGoals || directableGoals.length === 0) {
      return { executed: 0, failed: 0, results: [] };
    }
    
    this.logger.info('');
    this.logger.info('🤲 COSMO HANDS - Direct Action Execution');
    this.logger.info(`   ${directableGoals.length} goal(s) eligible for direct action`);
    this.logger.info('');
    
    const results = [];
    let executed = 0;
    let failed = 0;
    
    for (const { goal, action, reason } of directableGoals) {
      try {
        this.logger.info(`🤲 Direct action: ${action.type}`, {
          goalId: goal.id,
          reason,
          path: action.path?.substring(0, 60) || null
        });
        
        const result = await this.coordinator.executeDirectAction(goal, action, {
          cycleCount: this.cycleCount
        });
        
        results.push({
          goalId: goal.id,
          actionType: action.type,
          success: result.success !== false,
          duration: result.duration,
          directActionId: result.directActionId
        });
        
        if (result.success !== false) {
          executed++;
          this.logger.info(`   ✅ Completed in ${result.duration}ms`);
        } else {
          failed++;
          this.logger.warn(`   ❌ Failed: ${result.error || result.reason}`);
        }
        
      } catch (error) {
        failed++;
        results.push({
          goalId: goal.id,
          actionType: action.type,
          success: false,
          error: error.message
        });
        this.logger.error('Direct action error', {
          goalId: goal.id,
          error: error.message
        });
      }
    }
    
    this.logger.info('');
    this.logger.info(`🤲 Direct actions complete: ${executed} succeeded, ${failed} failed`);
    this.logger.info('');
    
    return { executed, failed, results };
  }
  
  /**
   * Spawn agents for urgent goals created during Meta-Coordinator review
   * CRITICAL: Ensures urgent goals get immediate attention, not waiting in goal pool
   */
  async spawnAgentsForUrgentGoals(urgentGoalSpecs) {
    try {
      this.logger.info('');
      this.logger.info('🚨 SPAWNING AGENTS FOR URGENT GOALS');
      this.logger.info('');
      
      // Get the actual goal objects that were just created
      // They should be the most recently created goals with source: 'meta_coordinator_strategic'
      const allGoals = this.goals.getGoals();
      const urgentGoals = allGoals
        .filter(g => g.source === 'meta_coordinator_strategic' || g.metadata?.gapDriven === true)
        .sort((a, b) => (b.created || 0) - (a.created || 0)) // Most recent first
        .slice(0, urgentGoalSpecs.length); // Take the N most recent matching goals
      
      if (urgentGoals.length === 0) {
        this.logger.warn('Could not find urgent goals that were just created', {
          specsProvided: urgentGoalSpecs.length,
          totalGoals: allGoals.length
        });
        return;
      }
      
      this.logger.info(`Found ${urgentGoals.length} urgent goals for immediate agent spawning`);
      
      // Limit to 3 agents to avoid overwhelming system
      const goalsToSpawn = urgentGoals.slice(0, 3);
      
      this.logger.info('Spawning agents for top urgent goals', {
        count: goalsToSpawn.length,
        goalIds: goalsToSpawn.map(g => g.id),
        types: goalsToSpawn.map(g => g.metadata?.agentType || g.metadata?.agentTypeHint)
      });
      
      const spawnedAgents = [];
      
      for (const goal of goalsToSpawn) {
        try {
          // Use agent type hint from metadata (set by injectUrgentGoals)
          const agentType = goal.metadata?.agentType || goal.metadata?.agentTypeHint;
          
          if (!agentType) {
            this.logger.warn('Urgent goal missing agent type hint, skipping', {
              goalId: goal.id,
              description: goal.description.substring(0, 60)
            });
            continue;
          }
          
          // Build mission spec
          const missionSpec = {
            missionId: `urgent_${goal.id}_${Date.now()}`,
            agentType: agentType,
            goalId: goal.id,
            description: goal.description,
            successCriteria: [
              'Complete the urgent task identified by Meta-Coordinator',
              goal.metadata?.rationale || 'Closes critical gap'
            ],
            maxDuration: this.getAgentTimeout(agentType),
            createdBy: 'meta_coordinator_urgent',
            spawnCycle: this.cycleCount,
            triggerSource: 'urgent_goal',
            spawningReason: goal.metadata?.urgency || 'high',
            priority: goal.priority || 0.95,
            provenanceChain: [],
            metadata: {
              urgentGoal: true,
              gapDriven: true,
              rationale: goal.metadata?.rationale,
              urgency: goal.metadata?.urgency
            }
          };
          
          this.logger.info(`   Spawning ${agentType} for urgent goal...`, {
            goalId: goal.id,
            description: goal.description.substring(0, 80)
          });
          
          const agentId = await this.agentExecutor.spawnAgent(missionSpec);
          
          if (agentId) {
            spawnedAgents.push({
              agentId,
              goalId: goal.id,
              agentType
            });
            
            this.logger.info('   ✅ Urgent agent spawned', {
              agentId,
              agentType,
              goalId: goal.id
            });
            
            // Mark goal as claimed/pursued to prevent duplicate spawning
            // Note: Agent will also update this when it starts working
            goal.claimedBy = agentId;
            goal.claimed_by = agentId;
            goal.claimExpires = Date.now() + (30 * 60 * 1000); // 30 minutes
            goal.claim_expires = goal.claimExpires;
          } else {
            this.logger.warn('   ⚠️  Agent spawn failed for urgent goal', {
              goalId: goal.id,
              agentType
            });
          }
          
        } catch (error) {
          this.logger.error('Failed to spawn agent for urgent goal', {
            goalId: goal.id,
            error: error.message
          });
        }
      }
      
      if (spawnedAgents.length > 0) {
        this.logger.info('');
        this.logger.info('✅ Urgent agents deployed', {
          count: spawnedAgents.length,
          agents: spawnedAgents.map(a => `${a.agentType}:${a.agentId}`)
        });
        this.logger.info('');
      } else {
        this.logger.warn('⚠️  No urgent agents were spawned (check agent executor status)');
      }
      
    } catch (error) {
      this.logger.error('Urgent agent spawning failed', {
        error: error.message,
        stack: error.stack
      });
    }
  }
  
  /**
   * Spawn agents for strategic goals (bypasses maxConcurrent limit)
   * Strategic goals are critical system fixes that shouldn't wait
   */
  async spawnStrategicGoals() {
    try {
      // Find strategic goals: from Meta-Coordinator, insights, or escalated by tracker
      const allGoals = this.goals.getGoals();
      const strategicGoals = allGoals
        .filter(g => {
          // Check multiple indicators of strategic priority
          const isFromMetaCoordinator = g.source === 'meta_coordinator_strategic';
          const isGapDriven = g.metadata?.gapDriven === true;
          const isStrategicPriority = g.metadata?.strategicPriority === true;
          const isEscalated = g.metadata?.escalated === true;
          const hasAgentType = g.metadata?.agentType || g.metadata?.agentTypeHint;
          
          // Must be strategic AND have agent type hint
          return (isFromMetaCoordinator || isGapDriven || isStrategicPriority || isEscalated) && hasAgentType;
        })
        .filter(g => !g.claimedBy && !g.claimed_by) // Not already claimed
        .sort((a, b) => b.priority - a.priority); // Highest priority first
      
      if (strategicGoals.length === 0) {
        return; // No strategic goals to spawn
      }
      
      // Limit to 5 strategic agents per cycle to avoid overwhelming system
      // But these bypass the maxConcurrent limit
      const goalsToSpawn = strategicGoals.slice(0, 5);
      
      if (goalsToSpawn.length > 0) {
        this.logger.info('🚨 Spawning strategic agents (bypass maxConcurrent)', {
          strategicGoalsAvailable: strategicGoals.length,
          willSpawn: goalsToSpawn.length,
          currentActive: this.agentExecutor.registry.getActiveCount(),
          maxConcurrent: this.agentExecutor.maxConcurrent
        });
      }
      
      const spawnedAgents = [];
      
      for (const goal of goalsToSpawn) {
        try {
          // Get agent type from metadata
          const agentType = goal.metadata?.agentType || goal.metadata?.agentTypeHint;
          
          if (!agentType) {
            this.logger.warn('Strategic goal missing agent type, skipping', {
              goalId: goal.id,
              source: goal.source
            });
            continue;
          }
          
          // Build mission spec with strategic flags
          const missionSpec = {
            missionId: `strategic_${goal.id}_${Date.now()}`,
            agentType: agentType,
            goalId: goal.id,
            description: goal.description,
            successCriteria: [
              'Complete strategic task identified by Meta-Coordinator or escalated by Strategic Tracker',
              goal.metadata?.rationale || 'Strategic priority'
            ],
            maxDuration: this.getAgentTimeout(agentType),
            createdBy: 'strategic_spawner',
            spawnCycle: this.cycleCount,
            triggerSource: 'strategic_goal',
            spawningReason: goal.metadata?.urgency || 'strategic',
            priority: goal.priority || 0.95,
            provenanceChain: [],
            metadata: {
              urgentGoal: true,  // ← Triggers bypass in AgentExecutor
              strategicPriority: true,
              gapDriven: goal.metadata?.gapDriven || false,
              rationale: goal.metadata?.rationale,
              urgency: goal.metadata?.urgency
            }
          };
          
          const agentId = await this.agentExecutor.spawnAgent(missionSpec);
          
          if (agentId) {
            spawnedAgents.push({
              agentId,
              goalId: goal.id,
              agentType
            });
            
            // Claim goal
            goal.claimedBy = agentId;
            goal.claimed_by = agentId;
            goal.claimExpires = Date.now() + (30 * 60 * 1000);
            goal.claim_expires = goal.claimExpires;
            
            this.logger.info('   ✅ Strategic agent spawned', {
              agentId,
              agentType,
              goalId: goal.id
            });
          }
          
        } catch (error) {
          this.logger.error('Failed to spawn strategic agent', {
            goalId: goal.id,
            error: error.message
          });
        }
      }
      
      if (spawnedAgents.length > 0) {
        this.logger.info('✅ Strategic agents deployed', {
          count: spawnedAgents.length,
          bypassedLimit: this.agentExecutor.registry.getActiveCount() > this.agentExecutor.maxConcurrent,
          totalActiveNow: this.agentExecutor.registry.getActiveCount()
        });
      }
      
    } catch (error) {
      this.logger.error('Strategic agent spawning failed', {
        error: error.message
      });
    }
  }
  
  /**
   * Get timeout for agent type
   */
  getAgentTimeout(agentType) {
    const { getAgentTimeout: getTimeout } = require('../config/agent-timeouts');
    return getTimeout(agentType);
  }

  /**
   * Calculate branch reward for quantum branching
   * Uses multiple signals: surprise, goals, divergence, reasoning, cognitive state
   */
  calculateBranchReward({
    outputSurprise = 0,
    capturedGoalsCount = 0,
    divergence = 0,
    hasExtendedReasoning = false,
    thoughtLength = 0,
    cognitiveState = null
  }) {
    let reward = 0;

    // Core signals (existing)
    const surpriseScore = Math.max(0, outputSurprise);
    const goalScore = Math.max(0, capturedGoalsCount) * 0.3;
    reward += surpriseScore + goalScore;

    // Branch divergence - higher diversity of thinking is valuable
    // Scale: 0-1, typical values 0.3-0.8
    const divergenceBonus = Math.max(0, divergence) * 0.4;
    reward += divergenceBonus;

    // Extended reasoning presence - GPT-5's deep thinking
    if (hasExtendedReasoning) {
      reward += 0.2;
    }

    // Thought quality - substantial hypotheses are more valuable
    if (thoughtLength > 200) {
      reward += 0.1;
    }
    if (thoughtLength > 400) {
      reward += 0.1;
    }

    // Cognitive state bonus - reward good performance when system is engaged
    if (cognitiveState) {
      // High curiosity + high energy = optimal state for exploration
      if (cognitiveState.curiosity > 0.7 && cognitiveState.energy > 0.7) {
        reward += 0.2;
      }
      // Good mood indicates recent successes
      if (cognitiveState.mood > 0.7) {
        reward += 0.1;
      }
    }

    return Math.max(0, reward);
  }

  /**
   * Calculate divergence between branches
   */
  calculateBranchDivergence(branches) {
    if (!Array.isArray(branches) || branches.length < 2) {
      return 0;
    }

    let total = 0;
    let comparisons = 0;

    const tokenize = (text) => {
      if (!text) return new Set();
      return new Set((text.toLowerCase().match(/\b[a-z0-9]{4,}\b/g) || []).slice(0, 200));
    };

    for (let i = 0; i < branches.length - 1; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const wordsA = tokenize(branches[i].hypothesis);
        const wordsB = tokenize(branches[j].hypothesis);
        if (wordsA.size === 0 && wordsB.size === 0) {
          continue;
        }

        const union = new Set([...wordsA, ...wordsB]);
        let intersectionCount = 0;
        wordsA.forEach(word => {
          if (wordsB.has(word)) {
            intersectionCount += 1;
          }
        });

        const similarity = union.size === 0 ? 0 : intersectionCount / union.size;
        const divergence = 1 - similarity;
        total += divergence;
        comparisons += 1;
      }
    }

    if (comparisons === 0) {
      return 0;
    }

    return total / comparisons;
  }

  getConsistencyConfig() {
    return this.config.architecture?.reasoning?.features?.consistencyReview || { enabled: false };
  }

  async logLatentTrainingSample(reward) {
    if (!reward || reward <= 0) {
      return;
    }

    if (!this.quantum?.getLastLatentContext) {
      return;
    }

    const latent = this.quantum.getLastLatentContext();
    if (!latent || !Array.isArray(latent.vector) || latent.vector.length === 0) {
      return;
    }

    try {
      // PRODUCTION: Use logsDir (user-specific runtime) for training data
      const trainingDir = path.join(this.logsDir, 'training');
      await fs.mkdir(trainingDir, { recursive: true });
      const datasetPath = path.join(trainingDir, 'latent-dataset.jsonl');

      const entry = {
        cycle: this.cycleCount,
        timestamp: new Date().toISOString(),
        reward,
        vector: latent.vector,
        vectorSize: latent.vector.length,
        hint: latent.hint || null,
        selectedBranchId: this.latestBranchMetadata?.selectedBranchId || null
      };

      await fs.appendFile(datasetPath, JSON.stringify(entry) + '\n');
    } catch (error) {
      this.logger?.warn('Failed to record latent training sample', {
        error: error.message
      });
    }
  }

  /**
   * Determine appropriate agent type for a task based on its description
   * 
   * IDE-FIRST PARADIGM: When ideFirst.enabled is true, most tasks go to IDEAgent
   * which can handle analysis, document creation, code creation, etc.
   * Only research tasks (requiring web search) go to specialized research agent.
   */
  determineAgentTypeForTask(task) {
    const desc = (task.description || task.title || '').toLowerCase();
    
    // PRIORITY 1: IDE-FIRST MODE - Supersedes everything except explicit 'research'
    // When enabled, IDEAgent handles: synthesis, code creation, code execution, analysis, document creation
    // This eliminates redundant specialized agents that IDEAgent can handle via MCP tools
    if (this.config?.ideFirst?.enabled) {
      // Only research agent for explicit web search tasks
      const explicitAgentType = task.metadata?.agentType;
      if (explicitAgentType === 'research' ||
          desc.includes('research') || desc.includes('investigate sources') ||
          desc.includes('web search') || desc.includes('gather sources') ||
          desc.includes('find sources') || desc.includes('search the web')) {
        return 'research';
      }
      
      // Log what we're consolidating
      if (explicitAgentType && explicitAgentType !== 'ide') {
        this.logger.info('🖥️ IDE-First: Remapping agent type to ide', {
          taskId: task.id,
          originalAgentType: explicitAgentType,
          reason: 'IDE-First consolidates code_creation, code_execution, synthesis, etc.'
        });
      }
      
      // Everything else → IDEAgent (code_creation, code_execution, synthesis, analysis, document_creation)
      this.logger.debug('🖥️ IDE-First: Using IDEAgent for task', {
        taskId: task.id,
        title: task.title?.substring(0, 60),
        originalAgentType: explicitAgentType || 'inferred',
        isSynthesis: task.metadata?.isFinalSynthesis || task.tags?.includes('synthesis')
      });
      return 'ide';
    }
    
    // LEGACY MODE: Use explicit agentType from task metadata (set by guided planner)
    if (task.metadata?.agentType) {
      return task.metadata.agentType;
    }
    
    // LEGACY MODE: Check for special task types
    if (task.metadata?.isFinalSynthesis || task.tags?.includes('synthesis')) {
      return 'synthesis';
    }
    
    // LEGACY: Check agentTypeHint from metadata
    if (task.metadata?.agentTypeHint) {
      return task.metadata.agentTypeHint;
    }
    
    // LEGACY MODE: Pattern matching for agent type selection
    // Check for research keywords FIRST (most specific)
    if (desc.includes('gather') || desc.includes('collect') || desc.includes('research') || desc.includes('investigate') || desc.includes('study') || desc.includes('sources')) {
      return 'research';
    }
    if (desc.includes('analyze') || desc.includes('framework') || desc.includes('measure')) {
      return 'analysis';
    }
    if (desc.includes('synthesize') || desc.includes('combine') || desc.includes('integrate') || desc.includes('assemble') || desc.includes('merge')) {
      return 'synthesis';
    }
    if (desc.includes('code') || desc.includes('implement') || desc.includes('build')) {
      return this.codingAgentsEnabled ? 'code_creation' : 'analysis';
    }
    if (desc.includes('execute') || desc.includes('run') || desc.includes('validate') || desc.includes('test')) {
      return this.codingAgentsEnabled ? 'code_execution' : 'analysis';
    }
    if (desc.includes('write') || desc.includes('compose') || desc.includes('document') || desc.includes('paragraph')) {
      return 'document_creation';
    }
    
    // LAST RESORT: Default to analysis (safer than document_creation)
    this.logger.warn('⚠️  Could not determine agent type for task, defaulting to analysis', {
      taskId: task.id,
      title: task.title?.substring(0, 80)
    });
    return 'analysis';
  }

  async maybeTriggerConsistencyReview() {
    const config = this.getConsistencyConfig();
    if (!config.enabled || !this.agentExecutor) {
      return;
    }
    
    // GUIDED MODE: Skip consistency reviews until plan is ready and agents are working
    const isGuidedMode = this.config.architecture?.roleSystem?.explorationMode === 'guided';
    if (isGuidedMode && !this.guidedPlanReady) {
      this.logger.debug('⏭️  Guided mode: Skipping consistency review until plan is ready');
      return;
    }

    if (!this.latestBranchMetadata || !Array.isArray(this.latestBranchMetadata.branches)) {
      return;
    }

    const divergence = this.latestBranchMetadata.divergence ?? 0;
    const threshold = typeof config.divergenceThreshold === 'number' ? config.divergenceThreshold : 0.65;

    if (divergence < threshold) {
      return;
    }

    if (this.lastConsistencyReviewCycle === this.cycleCount) {
      return;
    }

    // NEW: Cooldown mechanism to prevent every-cycle spam
    // Only trigger if minimum cycles have passed since last review
    const minCyclesBetween = typeof config.minCyclesBetweenReviews === 'number' ? config.minCyclesBetweenReviews : 0;
    if (minCyclesBetween > 0 && this.lastConsistencyReviewCycle !== null) {
      const cyclesSinceLastReview = this.cycleCount - this.lastConsistencyReviewCycle;
      if (cyclesSinceLastReview < minCyclesBetween) {
        this.logger.debug('Consistency review cooldown active', {
          cyclesSinceLastReview,
          minRequired: minCyclesBetween,
          divergence: divergence.toFixed(2)
        });
        return;
      }
    }

    const maxBranches = Math.max(2, config.maxBranchesAnalyzed || 3);
    const selected = this.latestBranchMetadata.branches.slice(0, maxBranches).map(branch => ({
      branchId: branch.branchId,
      reasoningEffort: branch.reasoningEffort || null,
      hypothesis: branch.hypothesis || null,
      reasoning: branch.reasoning || null
    }));

    const missionSpec = {
      missionId: `consistency_${this.cycleCount}_${Date.now()}`,
      agentType: 'consistency',
      description: `Evaluate divergence among top hypotheses for cycle ${this.cycleCount}`,
      successCriteria: [
        'Identify agreement across hypotheses',
        'Highlight conflicting points that need resolution',
        'Recommend a synthesis or next action'
      ],
      metadata: {
        cycle: this.cycleCount,
        divergenceScore: divergence,
        branches: selected
      },
      maxDuration: 120000,
      createdBy: 'orchestrator',
      spawnCycle: this.cycleCount,
      goalId: null
    };

    const agentId = await this.agentExecutor.spawnAgent(missionSpec);
    if (agentId) {
      this.lastConsistencyReviewCycle = this.cycleCount;
      if (this.evaluation) {
        this.evaluation.trackConsistencyReview({
          cycle: this.cycleCount,
          divergence,
          branchesAnalyzed: selected.length,
          agentId
        });
      }

      this.logger.info('📏 Consistency review triggered', {
        agentId,
        cycle: this.cycleCount,
        divergence: divergence.toFixed(2),
        branches: selected.length
      });
    }
  }

  calculateRecentProgress() {
    const recent = this.journal.slice(-10);
    if (recent.length === 0) return 0.5;

    const goalsProgressed = recent.filter(e => e.goal !== null).length;
    const highSurprise = recent.filter(e => e.surprise > 0.5).length;

    return (goalsProgressed + highSurprise) / (recent.length * 2);
  }

  calculateNextInterval() {
    let interval = this.config.execution.baseInterval * 1000;
    const baseInterval = interval;

    if (this.config.execution.adaptiveTimingEnabled) {
      const state = this.stateModulator.getState();
      
      // FIX: Guard against null/undefined state values (causes NaN interval → infinite loop)
      const curiosity = (state.curiosity !== null && state.curiosity !== undefined) ? state.curiosity : 0.5;
      const energy = (state.energy !== null && state.energy !== undefined) ? state.energy : 0.5;
      
      const curiosityMultiplier = (2 - curiosity);
      const energyMultiplier = (2 - energy);
      
      interval *= curiosityMultiplier;
      interval *= energyMultiplier;

      const isExploring = this.oscillator.isExploring();
      if (isExploring) {
        interval *= 0.7;
      }
      
      // Log adaptive timing calculation for debugging
      this.logger.debug('Adaptive timing calculation:', {
        baseInterval: baseInterval / 1000,
        curiosity: curiosity.toFixed(3),
        energy: energy.toFixed(3),
        curiosityMult: curiosityMultiplier.toFixed(3),
        energyMult: energyMultiplier.toFixed(3),
        exploring: isExploring,
        calculatedInterval: (interval / 1000).toFixed(1),
        finalInterval: (Math.max(30000, Math.min(600000, interval)) / 1000).toFixed(1)
      });
    }

    // FIX: Ensure interval is always a valid number
    if (!Number.isFinite(interval) || interval <= 0) {
      this.logger.warn('⚠️  Invalid interval calculated, using baseInterval', {
        interval,
        baseInterval: this.config.execution.baseInterval
      });
      interval = this.config.execution.baseInterval * 1000;
    }

    return Math.max(30000, Math.min(600000, interval)); // 30s - 10min range
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async logThought(entry) {
    const logPath = path.join(this.logsDir, 'thoughts.jsonl');
    const line = JSON.stringify(entry) + '\n';
    
    try {
      await fs.appendFile(logPath, line);
    } catch (error) {
      this.logger.error('Failed to log', { error: error.message });
    }
  }

  async saveDream(dream) {
    const dreamsFile = path.join(this.logsDir, 'dreams.jsonl');
    try {
      await fs.appendFile(dreamsFile, JSON.stringify(dream) + '\n');
      this.logger.debug('💎 Dream saved to dreams.jsonl', { 
        cycle: dream.cycle, 
        dreamNumber: dream.dreamNumber,
        contentLength: dream.content.length 
      });
    } catch (error) {
      this.logger.error('Failed to save dream', { error: error.message });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VOICE SYSTEM - COSMO's channel to speak to humans
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Voice a message to the human partner
   * This is COSMO's mouth - use it when you want to speak
   */
  async voice(message) {
    if (!this.voiceEnabled || !message) return;
    
    const utterance = {
      id: `voice_${this.cycleCount}_${Date.now()}`,
      timestamp: new Date().toISOString(),
      cycle: this.cycleCount,
      message: message.trim(),
      context: {
        mood: this.stateModulator?.getState()?.mood,
        energy: this.stateModulator?.getState()?.energy,
        curiosity: this.stateModulator?.getState()?.curiosity,
        oscillatorMode: this.oscillator?.getCurrentMode()
      }
    };
    
    // Store in memory
    this.voiceLog.push(utterance);
    
    // Persist to file
    const voiceFile = path.join(this.logsDir, 'voice.jsonl');
    try {
      await fs.appendFile(voiceFile, JSON.stringify(utterance) + '\n');
    } catch (error) {
      this.logger.error('Failed to save voice', { error: error.message });
    }
    
    // Emit event for real-time listeners
    this._getEvents().emitEvent('cosmo_voice', utterance);
    
    // Log it
    this.logger.info('🗣️  COSMO SPEAKS:', { 
      preview: message.substring(0, 100),
      cycle: this.cycleCount 
    });
    
    return utterance;
  }

  /**
   * Parse any output for [VOICE]: markers
   * COSMO can speak at any time by including [VOICE]: in its output
   * Returns the output with voice markers removed
   */
  parseForVoice(output) {
    if (!this.voiceEnabled || !output) return output;
    
    // Match [VOICE]: followed by content (until next [VOICE]: or end)
    const voicePattern = /\[VOICE\]:\s*([\s\S]*?)(?=\[VOICE\]:|$)/gi;
    const matches = output.match(voicePattern);
    
    if (matches) {
      for (const match of matches) {
        const message = match.replace(/\[VOICE\]:\s*/i, '').trim();
        if (message && message.length > 0) {
          // Voice it asynchronously - don't block
          this.voice(message).catch(err => 
            this.logger.error('Voice failed', { error: err.message })
          );
        }
      }
    }
    
    // Return output with voice markers removed
    return output.replace(voicePattern, '').trim();
  }

  /**
   * Get unread voice messages (for human interface)
   */
  getVoiceMessages(since = null) {
    if (since) {
      return this.voiceLog.filter(v => new Date(v.timestamp) > new Date(since));
    }
    return this.voiceLog;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // END VOICE SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  async saveState() {
    // Save evaluation metrics
    if (this.evaluation) {
      await this.evaluation.save();
    }
    
    const state = {
      cycleCount: this.cycleCount,
      journal: this.journal.slice(-100),
      memory: this.memory.exportGraph(),
      goals: this.goals.export(),
      roles: this.roles.getRoles(),
      reflection: this.reflection.export(),
      oscillator: this.oscillator.getStats(),
      cognitiveState: this.stateModulator.getState(), // FIX: Save cognitive state to prevent NaN interval bug
      temporal: this.temporal ? this.temporal.getStats() : null, // FIX: Save temporal state so sleep/wake cycles persist
      coordinator: this.coordinator ? this.coordinator.export() : null,
      agentExecutor: this.agentExecutor ? this.agentExecutor.exportState() : null,
      forkSystem: this.forkSystem ? this.forkSystem.export() : null,
      topicQueue: this.topicQueue ? this.topicQueue.export() : null,
      goalCurator: this.goalCurator ? this.goalCurator.export() : null,
      evaluation: this.evaluation ? this.evaluation.getMetrics() : null,
      executiveRing: this.executiveRing ? this.executiveRing.getStats() : null, // NEW: Save executive stats
      guidedMissionPlan: this.guidedMissionPlan || null, // FIXED: Save guided plan
      completionTracker: this.completionTracker || null, // Just save directly, no export needed
      planProgressEvents: this.planProgressEvents || [], // PLAN PROGRESS SPINE: Save phase events
      lastSummarization: this.lastSummarization,
      gpt5Stats: {
        reasoningHistorySize: this.reasoningHistory.length,
        webSearchCount: this.webSearchCount
      },
      goalAllocator: this.goalAllocator ? this.goalAllocator.getStats() : null,
      clusterSync: this.clusterSync,
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.export() : null,
      timestamp: new Date(),

      // Session continuity data (Anthropic pattern)
      sessionArtifacts: {
        sessionNumber: (this.sessionNumber || 0) + 1,
        lastSessionSummary: this.generateSessionSummary(),
        progressMarkers: this.getProgressMarkers()
      }
    };

    const statePath = path.join(this.logsDir, 'state.json');

    try {
      const nodesWithEmbeddings = state.memory?.nodes?.filter(n => n.embedding).length || 0;
      const totalNodes = state.memory?.nodes?.length || 0;

      // SAFEGUARD: Don't overwrite a properly merged state with a smaller state
      // If current state has more nodes than 10 (our merged state), preserve it
      // FIX (Jan 23, 2026): Only apply on cycle 0-1, not after cycles have progressed
      // This was blocking ALL saves on forked/merged brains!
      if (totalNodes < 10 && nodesWithEmbeddings < 10 && this.cycleCount <= 1) {
        // Check if there's an existing state file with more nodes
        try {
          const existingData = await fs.readFile(statePath, 'utf8');
          const existingState = JSON.parse(existingData);
          const existingNodes = existingState.memory?.nodes?.length || 0;

          if (existingNodes > totalNodes) {
            this.logger.warn('Preventing overwrite of merged state (cycle <= 1 only)', {
              currentNodes: totalNodes,
              existingNodes,
              cycle: this.cycleCount
            });
            return; // Don't save, preserve the merged state
          }
        } catch (error) {
          // If we can't read existing state, proceed with save
        }
      }

      // Save with compression (reduces 118MB → ~6-10MB)
      const saveResult = await StateCompression.saveCompressed(statePath, state, {
        compress: true,
        pretty: false  // Compact JSON for better compression
      });
      
      this.logger.info('State saved (GPT-5.2)', {
        cycle: this.cycleCount,
        nodesWithEmbeddings,
        totalNodes,
        compressed: saveResult.compressed,
        size: `${(saveResult.size / (1024 * 1024)).toFixed(2)}MB`,
        ...(saveResult.ratio && { compressionRatio: saveResult.ratio })
      });

      // Write human-readable progress file
      await this.writeProgressFile(state);

      // Rotate old backups (keep last 5)
      // Run in background to not slow down save
      StateCompression.rotateBackups(this.logsDir, 'state.backup', 5)
        .then(result => {
          if (result.removed > 0) {
            this.logger.info('Rotated old backups', result);
          }
        })
        .catch(error => {
          this.logger.warn('Backup rotation failed', { error: error.message });
        });
      
    } catch (error) {
      this.logger.error('Save failed', { error: error.message });
    }
  }

  // Generate session summary for continuity
  generateSessionSummary() {
    // Get active goals by filtering the goals Map
    const allGoals = Array.from(this.goals.goals.values());
    const activeGoals = allGoals.filter(g => g.status === 'active' || !g.status);
    const completedGoals = this.goals.completedGoals || [];

    return {
      cycleCount: this.cycleCount,
      activeGoalsCount: activeGoals.length,
      completedGoalsCount: completedGoals.length,
      memorySize: this.memory.nodes.length,
      timestamp: new Date().toISOString()
    };
  }

  // Get progress markers for session continuity
  // PLAN PROGRESS SPINE (Jan 20, 2026): Include plan events
  getProgressMarkers() {
    const markers = [];

    // Add plan events (highest priority)
    if (this.planProgressEvents) {
      markers.push(...this.planProgressEvents.slice(-10));
    }

    // Add milestone cycles
    if (this.cycleCount % 10 === 0) {
      markers.push({
        type: 'milestone',
        cycle: this.cycleCount,
        description: `Reached cycle ${this.cycleCount}`
      });
    }

    // Add goal completions
    const recentGoals = (this.goals.completedGoals || []).slice(-5);
    for (const goal of recentGoals) {
      markers.push({
        type: 'goal_completed',
        goalId: goal.id,
        description: goal.description,
        cycle: this.cycleCount
      });
    }

    return markers;
  }
  
  /**
   * Record a plan progress event (for progress spine)
   * PLAN PROGRESS SPINE (Jan 20, 2026): Track phase lifecycle
   */
  recordPlanEvent(type, details) {
    if (!this.planProgressEvents) {
      this.planProgressEvents = [];
    }
    
    this.planProgressEvents.push({
      type,
      cycle: this.cycleCount,
      timestamp: Date.now(),
      ...details
    });
    
    // Keep last 50 events
    if (this.planProgressEvents.length > 50) {
      this.planProgressEvents = this.planProgressEvents.slice(-50);
    }
  }

  // Write progress markdown file for human readability
  // PLAN PROGRESS SPINE (Jan 20, 2026): Comprehensive, plan-primary reference
  async writeProgressFile(state) {
    const progressPath = path.join(this.logsDir, 'cosmo-progress.md');

    let content = `# COSMO Progress - ${this.config.architecture?.roleSystem?.guidedFocus?.domain || this.config.roleSystem?.domain || 'Research'}\n\n`;
    
    const startTimeStr = this.startTime && !isNaN(new Date(this.startTime).getTime()) 
      ? new Date(this.startTime).toISOString() 
      : 'Unknown';
    content += `**Started**: ${startTimeStr}\n`;
    content += `**Last Updated**: ${new Date().toISOString()}\n`;
    content += `**Total Cycles**: ${this.cycleCount}\n`;
    content += `**Session**: ${state.sessionArtifacts?.sessionNumber || 1}\n\n`;

    // ═══════════════════════════════════════════════════════════
    // SECTION 1: PLAN STATUS (PRIMARY - Always First)
    // ═══════════════════════════════════════════════════════════
    const activePlan = await this.clusterStateStore?.getPlan('plan:main').catch(() => null);
    
    if (activePlan && activePlan.status !== 'ARCHIVED') {
      // FIX (Jan 23, 2026): Filter out ARCHIVED tasks/milestones to prevent stale data pollution
      const rawTasks = await this.clusterStateStore.listTasks(activePlan.id).catch(() => []);
      const rawMilestones = await this.clusterStateStore.listMilestones(activePlan.id).catch(() => []);

      const allTasks = rawTasks.filter(t => t.state !== 'ARCHIVED');
      const allMilestones = rawMilestones.filter(m => m.status !== 'ARCHIVED');

      const doneTasks = allTasks.filter(t => t.state === 'DONE');
      const totalTasks = allTasks.length;
      const percentComplete = totalTasks > 0 ? Math.round((doneTasks.length / totalTasks) * 100) : 0;
      
      content += `## 📋 GUIDED PLAN: ${activePlan.title || 'Unnamed'}\n\n`;
      content += `**Status**: ${activePlan.status} | **Progress**: ${percentComplete}% (${doneTasks.length}/${totalTasks} phases complete)\n\n`;
      
      // Phase breakdown
      content += `### Phase Status\n\n`;
      for (const milestone of allMilestones.sort((a, b) => a.order - b.order)) {
        const tasks = allTasks.filter(t => t.milestoneId === milestone.id);
        const phaseNum = milestone.id.match(/phase(\d+)/)?.[1] || milestone.order;
        
        for (const task of tasks) {
          const icon = task.state === 'DONE' ? '✅' : 
                       task.state === 'IN_PROGRESS' ? '⏳' : 
                       task.state === 'FAILED' ? '❌' :
                       task.state === 'BLOCKED' ? '⏸️' : '⏸️';
          const retryInfo = task.metadata?.retryCount ? ` (Attempt ${task.metadata.retryCount + 1}/3)` : '';
          
          content += `${icon} **Phase ${phaseNum}**: ${task.title?.substring(0, 80) || milestone.title?.substring(0, 80)}${retryInfo}\n`;
          
          if (task.state === 'DONE') {
            const artifacts = task.artifacts?.length || 0;
            // FIX (Jan 23, 2026): Use task metadata for completion cycle if available,
            // otherwise show timestamp. The old calculation caused "Cycle -2" bugs.
            const completedAt = task.completedAt || task.updatedAt;
            const completionInfo = task.metadata?.completedAtCycle
              ? `Cycle ${task.metadata.completedAtCycle}`
              : (completedAt ? new Date(completedAt).toLocaleString() : 'completed');
            content += `   - Completed: ${completionInfo} (~${artifacts} deliverables)\n`;
          } else if (task.state === 'FAILED') {
            content += `   - Failed: ${task.failureReason?.substring(0, 100) || 'Unknown reason'}\n`;
            if (task.metadata?.lastFailureReason) {
              content += `   - Learning: ${task.metadata.lastFailureReason.substring(0, 100)}\n`;
            }
          } else if (task.state === 'IN_PROGRESS') {
            content += `   - Agent: ${task.assignedAgentId || 'Pending assignment'}\n`;
          } else if (task.state === 'PENDING' && task.deps?.length > 0) {
            const blockedBy = task.deps.filter(depId => !doneTasks.find(t => t.id === depId));
            if (blockedBy.length > 0) {
              content += `   - Blocked by: ${blockedBy.join(', ')}\n`;
            } else {
              content += `   - Ready to start\n`;
            }
          }
        }
        content += `\n`;
      }
      
      // Active focus
      const activeMilestone = allMilestones.find(m => m.id === activePlan.activeMilestone);
      const activeTasks = allTasks.filter(t => t.state === 'IN_PROGRESS' || (t.state === 'PENDING' && (!t.deps || t.deps.every(depId => doneTasks.find(dt => dt.id === depId)))));
      
      if (activeTasks.length > 0) {
        content += `### 🎯 Current Focus\n\n`;
        content += `**Active Phase**: ${activeMilestone?.title || activePlan.activeMilestone}\n\n`;
        for (const task of activeTasks.slice(0, 3)) {
          content += `- ${task.title?.substring(0, 100)}\n`;
          content += `  State: ${task.state} | Agent: ${task.assignedAgentId || 'Unassigned'}\n`;
        }
        content += `\n`;
      }
      
      content += `---\n\n`;
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 2: SYSTEM STATE (Secondary but Comprehensive)
    // ═══════════════════════════════════════════════════════════
    content += `## 🧠 System State\n\n`;
    content += `- **Memory**: ${this.memory.nodes.length} nodes, ${this.memory.edges.length} edges\n`;
    
    const allGoalsForDisplay = Array.from(this.goals.goals.values());
    const activeGoalsForDisplay = allGoalsForDisplay.filter(g => g.status === 'active' || !g.status);
    content += `- **Goals**: ${activeGoalsForDisplay.length} active, ${(this.goals.completedGoals || []).length} completed\n`;
    
    const activeAgentCount = this.agentExecutor?.registry?.getActiveCount() || 0;
    content += `- **Agents**: ${activeAgentCount} active\n`;
    content += `- **Energy**: ${Math.round((this.stateModulator?.getState()?.energy || 0) * 100)}%\n\n`;

    // ═══════════════════════════════════════════════════════════
    // SECTION 3: RECENT ACTIVITY (Last 10 significant events)
    // ═══════════════════════════════════════════════════════════
    content += `## 📊 Recent Activity\n\n`;
    const markers = state.sessionArtifacts?.progressMarkers || [];
    for (const marker of markers.slice(-10)) {
      const icon = marker.type === 'phase_completed' ? '✅' :
                   marker.type === 'phase_failed' ? '❌' :
                   marker.type === 'phase_started' ? '▶️' :
                   marker.type === 'goal_completed' ? '🎯' : '•';
      content += `${icon} **${marker.type}** (Cycle ${marker.cycle}): ${marker.description?.substring(0, 120) || 'No description'}\n`;
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 4: SESSION INFO
    // ═══════════════════════════════════════════════════════════
    content += `\n## 📅 Session Info\n\n`;
    content += `- **Current Session**: ${state.sessionArtifacts?.sessionNumber || 1}\n`;
    if (state.sessionArtifacts?.lastSessionSummary) {
      const summary = state.sessionArtifacts.lastSessionSummary;
      content += `- **Last Session**: ${summary.completedGoalsCount || 0} goals completed, ${summary.cycleCount || 0} cycles\n`;
    }
    content += `\n`;

    content += `---\n`;
    content += `*This document is the authoritative reference for plan progress*\n`;

    try {
      await fs.writeFile(progressPath, content, 'utf8');
    } catch (error) {
      this.logger.warn('Could not write progress file', { error: error.message });
    }
  }

  async loadState() {
    const statePath = path.join(this.logsDir, 'state.json');

    // Log exactly where we're looking for state (helps debug merge issues)
    this.logger.info('📂 Loading state from:', {
      logsDir: this.logsDir,
      statePath,
      stateGzPath: statePath + '.gz',
      gzExists: require('fs').existsSync(statePath + '.gz'),
      jsonExists: require('fs').existsSync(statePath)
    });

    // Check if state file exists before trying to load
    const stateGzExists = require('fs').existsSync(statePath + '.gz');
    const stateExists = require('fs').existsSync(statePath);
    
    if (!stateGzExists && !stateExists) {
      // Fresh brain - no state to load
      this.logger.info('🆕 Fresh brain - no previous state to load');
      return; // Early return - nothing to restore
    }

    try {
      // Load state (handles both compressed and uncompressed)
      const state = await StateCompression.loadCompressed(statePath);

      // Getting up to speed protocol (Anthropic pattern)
      this.logger.info('');
      this.logger.info('🔄 Getting up to speed from saved state...');
      this.logger.info('─'.repeat(60));
      this.logger.info(`📁 Runtime directory: ${this.logsDir}`);
      this.logger.info(`📊 Saved cycle count: ${state.cycleCount || 0}`);
      this.logger.info(`🧠 Memory nodes: ${state.memory?.nodes?.length || 0}`);
      // Get goals count - handle both Map and Array formats
      const goalsCount = state.goals?.goals 
        ? (Array.isArray(state.goals.goals) 
            ? state.goals.goals.length 
            : Object.keys(state.goals.goals).length)
        : 0;
      this.logger.info(`🎯 Goals: ${goalsCount}`);

      // Show session info if available
      if (state.sessionArtifacts) {
        this.logger.info(`📝 Session: ${state.sessionArtifacts.sessionNumber || 'unknown'}`);
        if (state.sessionArtifacts.lastSessionSummary) {
          const summary = state.sessionArtifacts.lastSessionSummary;
          this.logger.info(`   Last session: ${summary.completedGoalsCount} goals completed`);
        }
      }

      // Check for progress file
      const progressPath = path.join(this.logsDir, 'cosmo-progress.md');
      if (require('fs').existsSync(progressPath)) {
        this.logger.info('📖 Progress log available: cosmo-progress.md');
      }

      this.logger.info('─'.repeat(60));
      this.logger.info('✅ State restoration complete, ready to continue');
      this.logger.info('');

      this.cycleCount = state.cycleCount || 0;
      this.journal = state.journal || [];
      this.lastSummarization = state.lastSummarization || 0;
      if (state.clusterSync) {
        this.clusterSync = {
          ...this.clusterSync,
          ...state.clusterSync
        };
      }

      if (state.clusterCoordinator && this.clusterCoordinator) {
        this.clusterCoordinator.import(state.clusterCoordinator);
      }

      // Load memory system from state
      if (state.memory) {
        // Import memory nodes, edges, and clusters
        if (state.memory.nodes && state.memory.edges) {
          // Clear current memory
          this.memory.nodes.clear();
          this.memory.edges.clear();
          this.memory.clusters.clear();

          // CRITICAL: Detect node ID format (string vs numeric) from first node
          // This ensures new nodes created at runtime match the format
          if (state.memory.nodes.length > 0) {
            const firstNodeId = state.memory.nodes[0].id;
            if (typeof firstNodeId === 'string' && firstNodeId.includes('_')) {
              // String format (from merged runs): "fa7572_123"
              this.memory.nodeIdFormat = 'string';
              const parts = firstNodeId.split('_');
              this.memory.nodeIdPrefix = parts[0]; // Extract prefix
              this.logger.info('Detected string ID format from merged run', {
                format: 'string',
                prefix: this.memory.nodeIdPrefix
              });
            } else {
              // Numeric format (original runs)
              this.memory.nodeIdFormat = 'numeric';
              this.logger.info('Detected numeric ID format');
            }
          }
          
          // Load nodes and regenerate missing embeddings
          for (const nodeData of state.memory.nodes) {
            // Check if node has embedding
            if (!nodeData.embedding) {
              this.logger.info('Regenerating missing embedding for node', { nodeId: nodeData.id });
              try {
                // Regenerate embedding for the node's concept
                const embedding = await this.memory.embed(nodeData.concept);
                if (embedding) {
                  nodeData.embedding = embedding;
                } else {
                  this.logger.warn('Failed to regenerate embedding for node', { nodeId: nodeData.id });
                }
              } catch (error) {
                this.logger.error('Error regenerating embedding', { nodeId: nodeData.id, error: error.message });
              }
            }
            this.memory.nodes.set(nodeData.id, nodeData);
          }

          // Load edges (convert from array format back to Map)
          let skippedCorruptedEdges = 0;
          if (Array.isArray(state.memory.edges)) {
            for (const edge of state.memory.edges) {
              // CRITICAL FIX: Skip corrupted edges (null source/target from previous bugs)
              if (edge.source === null || edge.source === undefined || 
                  edge.target === null || edge.target === undefined) {
                skippedCorruptedEdges++;
                continue;
              }
              
              // CRITICAL FIX: Verify both nodes exist before creating edge
              if (!this.memory.nodes.has(edge.source) || !this.memory.nodes.has(edge.target)) {
                skippedCorruptedEdges++;
                continue;
              }
              
              // CRITICAL FIX: Use string-safe sort to match NetworkMemory.addEdge() behavior
              // This handles both numeric and string IDs from merged runs
              const [nodeA, nodeB] = [edge.source, edge.target].sort((a, b) => {
                const strA = String(a);
                const strB = String(b);
                return strA.localeCompare(strB);
              });
              const edgeKey = `${nodeA}->${nodeB}`;
              
              // CRITICAL FIX: Skip self-loops (they cause exponential accumulation)
              if (nodeA === nodeB) {
                skippedCorruptedEdges++;
                continue;
              }
              
              this.memory.edges.set(edgeKey, {
                source: nodeA,  // Store explicit source/target for string ID support
                target: nodeB,
                weight: Math.min(1.0, edge.weight || 0),  // Cap at 1.0
                type: edge.type,
                created: edge.created,
                accessed: edge.accessed
              });
            }
            
            if (skippedCorruptedEdges > 0) {
              this.logger.warn(`Skipped ${skippedCorruptedEdges} corrupted edges during load (null/missing nodes/self-loops)`);
            }
          } else {
            // Legacy format: direct Map entries
            for (const [edgeKey, edge] of state.memory.edges) {
              this.memory.edges.set(edgeKey, edge);
            }
          }

          // Load clusters (convert from array format back to Map)
          if (Array.isArray(state.memory.clusters)) {
            for (const cluster of state.memory.clusters) {
              this.memory.clusters.set(cluster.id, new Set(cluster.nodes));
            }
          } else {
            // Legacy format: direct Map entries
            for (const [clusterId, nodeIds] of state.memory.clusters) {
              this.memory.clusters.set(clusterId, new Set(nodeIds));
            }
          }

          // Rebuild clusters Map from node assignments if clusters are missing
          // This handles cases where state was saved without proper cluster data
          const clusterAssignments = new Map(); // clusterId -> Set of nodeIds
          for (const node of state.memory.nodes) {
            if (node.cluster !== null && node.cluster !== undefined) {
              if (!clusterAssignments.has(node.cluster)) {
                clusterAssignments.set(node.cluster, new Set());
              }
              clusterAssignments.get(node.cluster).add(node.id);
            }
          }

          // Add any missing clusters to the clusters Map
          for (const [clusterId, nodeIds] of clusterAssignments) {
            if (!this.memory.clusters.has(clusterId)) {
              this.logger?.info?.('Rebuilding missing cluster from node assignments', {
                clusterId,
                nodeCount: nodeIds.size
              });
              this.memory.clusters.set(clusterId, nodeIds);
            }
          }

          // Update next IDs
          if (state.memory.nextNodeId) {
            this.memory.nextNodeId = state.memory.nextNodeId;
          }
          if (state.memory.nextClusterId) {
            this.memory.nextClusterId = Math.max(this.memory.nextClusterId, state.memory.nextClusterId);
          } else {
            // Ensure nextClusterId is higher than any existing cluster IDs
            const maxClusterId = Math.max(0, ...Array.from(this.memory.clusters.keys()));
            this.memory.nextClusterId = Math.max(this.memory.nextClusterId, maxClusterId + 1);
          }

          const nodesWithEmbeddings = Array.from(this.memory.nodes.values()).filter(n => n.embedding).length;
          this.logger.info('Memory loaded (GPT-5.2)', {
            nodes: this.memory.nodes.size,
            edges: this.memory.edges.size,
            clusters: this.memory.clusters.size,
            nodesWithEmbeddings
          });
        }
      }

      if (state.reflection) this.reflection.import(state.reflection);
      
      // FIX: Restore cognitive state to prevent NaN interval bug on resume
      if (state.cognitiveState) {
        // Ensure all required fields have valid values (not null/undefined)
        this.stateModulator.state = {
          ...this.stateModulator.state,
          curiosity: state.cognitiveState.curiosity ?? this.stateModulator.state.curiosity ?? 0.5,
          mood: state.cognitiveState.mood ?? this.stateModulator.state.mood ?? 0.5,
          energy: state.cognitiveState.energy ?? this.stateModulator.state.energy ?? 1.0,
          mode: state.cognitiveState.mode || 'active',
          lastModeChange: state.cognitiveState.lastModeChange 
            ? new Date(state.cognitiveState.lastModeChange) 
            : new Date(),
          surpriseAccumulator: state.cognitiveState.surpriseAccumulator ?? 0,
          recentSuccesses: state.cognitiveState.recentSuccesses ?? 0,
          recentFailures: state.cognitiveState.recentFailures ?? 0
        };
        this.logger.info('Cognitive state restored', {
          energy: this.stateModulator.state.energy?.toFixed?.(3) ?? 'N/A',
          curiosity: this.stateModulator.state.curiosity?.toFixed?.(3) ?? 'N/A',
          mood: this.stateModulator.state.mood?.toFixed?.(3) ?? 'N/A'
        });
      }
      
      // FIX: Restore temporal state so sleep/wake cycles persist
      if (state.temporal && this.temporal) {
        this.temporal.state = state.temporal.state || 'awake';
        this.temporal.fatigue = state.temporal.fatigue ?? 0;
        this.temporal.sleepCycles = state.temporal.sleepCycles || 0;
        this.temporal.lastSleepCycle = state.temporal.lastSleepCycle || 0;  // Restore cycle-based sleep tracking
        this.temporal.oscillationPhase = state.temporal.oscillationPhase || 'fast';
        if (state.temporal.lastSleepStart) {
          this.temporal.lastSleepStart = new Date(state.temporal.lastSleepStart);
        }
        if (state.temporal.lastWakeTime) {
          this.temporal.lastWakeTime = new Date(state.temporal.lastWakeTime);
        }
        this.logger.info('Temporal state restored', {
          state: this.temporal.state,
          sleepCycles: this.temporal.sleepCycles,
          fatigue: this.temporal.fatigue?.toFixed?.(3),
          lastSleepCycle: this.temporal.lastSleepCycle
        });
        
        // FIX: Resolve desync between temporal and cognitive states
        // If temporal is awake but cognitive is sleeping with low energy, force wake
        if (this.temporal.state === 'awake' && this.stateModulator.state.mode === 'sleeping' && this.stateModulator.state.energy < 0.5) {
          this.logger.warn('Detected temporal/cognitive desync - forcing wake', {
            temporalState: this.temporal.state,
            cognitiveMode: this.stateModulator.state.mode,
            energy: this.stateModulator.state.energy
          });
          this.stateModulator.restoreEnergy(0.8);  // Restore energy
          this.stateModulator.state.mode = 'active';  // Force mode transition
          this.stateModulator.state.lastModeChange = new Date();
        }
      }

      // Restore session artifacts for continuity
      if (state.sessionArtifacts) {
        this.sessionNumber = state.sessionArtifacts.sessionNumber || 0;
        this.logger.info('Session artifacts restored', {
          sessionNumber: this.sessionNumber,
          lastSessionCycles: state.sessionArtifacts.lastSessionSummary?.cycleCount || 'N/A'
        });
      }
      
      if (state.goals) {
        this.goals.import(state.goals);

        try {
          const rotationConfig = this.config?.architecture?.goals?.rotation;
          const result = this.goals.performGoalRotation(rotationConfig);

          if (result && (result.cleaned || result.archived || result.completed)) {
            this.logger.info('Post-import goal rotation performed', result);
          }
        } catch (error) {
          this.logger.warn('Post-import goal rotation failed', { error: error.message });
        }
      }
      if (state.goalCurator && this.goalCurator) this.goalCurator.import(state.goalCurator);
      if (state.forkSystem && this.forkSystem) this.forkSystem.import(state.forkSystem);
      if (state.topicQueue && this.topicQueue) this.topicQueue.import(state.topicQueue);
      
      // NEW: Import executive ring state
      if (state.executiveRing && this.executiveRing) {
        this.executiveRing.coherenceScore = state.executiveRing.coherenceScore || 1.0;
        this.executiveRing.recentActions = state.executiveRing.recentActions || [];
        this.executiveRing.interventions = state.executiveRing.recentInterventions || [];

        // Restore learned patterns (knownBlockers, successPatterns)
        if (Array.isArray(state.executiveRing.knownBlockers) && state.executiveRing.knownBlockers.length > 0) {
          this.executiveRing.knownBlockers = new Map(
            state.executiveRing.knownBlockers.map(b => [b.agentType, { reason: b.reason, count: b.count, lastSeen: b.lastSeen }])
          );
        }
        if (Array.isArray(state.executiveRing.successPatterns) && state.executiveRing.successPatterns.length > 0) {
          this.executiveRing.successPatterns = new Map(
            state.executiveRing.successPatterns.map(p => [p.agentType, { count: p.successCount, lastSuccess: p.lastSuccess }])
          );
        }
        // Restore mission context
        if (state.executiveRing.missionContext) {
          this.executiveRing.missionContext = state.executiveRing.missionContext;
        }
        // Restore error monitor history
        if (state.executiveRing.errorStats && this.executiveRing.errorMonitor?.restoreStats) {
          this.executiveRing.errorMonitor.restoreStats(state.executiveRing.errorStats);
        }

        this.logger.info('🧠 Executive ring state restored', {
          coherence: this.executiveRing.coherenceScore.toFixed(2),
          knownBlockers: this.executiveRing.knownBlockers.size,
          successPatterns: this.executiveRing.successPatterns.size,
          interventions: this.executiveRing.interventions.length
        });
      }
      
      // NEW: Import agent executor state (completed/failed agents for persistence)
      if (state.agentExecutor && this.agentExecutor) {
        this.agentExecutor.importState(state.agentExecutor);
      }
      
      if (state.guidedMissionPlan) this.guidedMissionPlan = state.guidedMissionPlan.plan || state.guidedMissionPlan; // FIXED: Restore guided plan
      if (state.planProgressEvents) this.planProgressEvents = state.planProgressEvents; // PLAN PROGRESS SPINE: Restore phase events
      if (state.completionTracker) this.completionTracker = state.completionTracker; // Just restore directly
      if (state.gpt5Stats) {
        this.webSearchCount = state.gpt5Stats.webSearchCount || 0;
      }

      this.logger.info('State loaded (GPT-5.2)', {
        cycle: this.cycleCount,
        journalSize: this.journal.length,
        memoryNodes: this.memory.nodes.size,
        webSearches: this.webSearchCount,
        forks: this.forkSystem ? this.forkSystem.getStats() : null,
        topics: this.topicQueue ? this.topicQueue.getStats().totalInjected : 0
      });
      
      // Replay agent journals to recover findings since last checkpoint
      // Run in background - don't block startup (can involve hundreds of agent dirs
      // and embedding API calls for each new finding, especially on merged runs)
      this.replayAgentJournals().then(journalFindings => {
        if (journalFindings.length > 0) {
          this.logger.info('📝 Replayed journal findings from interrupted agents', {
            findings: journalFindings.length
          });
        }
      }).catch(err => {
        this.logger.warn('⚠️ Agent journal replay failed (non-fatal)', { error: err.message });
      });
      
      // Migrate legacy goals to tasks
      if (this.clusterStateStore) {
        await this.migrateGoalsToTasks();
      }
    } catch (error) {
      // CRITICAL FIX: Don't silently swallow state loading errors!
      // This was causing merged brains to start with empty memory
      if (error.code === 'ENOENT') {
        this.logger.warn('⚠️ No state file found - starting fresh', {
          path: path.join(this.logsDir, 'state.json.gz'),
          memoryNodes: this.memory.nodes.size
        });
      } else {
        // This is a CRITICAL error - state file exists but couldn't be loaded
        this.logger.error('🚨 CRITICAL: State load failed - memory may be lost!', {
          error: error.message,
          path: this.logsDir,
          stack: error.stack
        });
        // Don't throw - let the run continue but with clear warning
        // The pre-flight check in server should catch most issues before we get here
      }
    }
  }

  /**
   * Replay agent journals to recover findings since last checkpoint
   * Called during loadState() to handle crash recovery
   */
  async replayAgentJournals() {
    const fs = require('fs').promises;
    const agentsDir = path.join(this.logsDir, 'agents');
    const replayed = [];
    
    try {
      const agentDirs = await fs.readdir(agentsDir);
      
      for (const agentId of agentDirs) {
        if (!agentId.startsWith('agent_')) continue;
        
        // Replay findings.jsonl
        const findingsPath = path.join(agentsDir, agentId, 'findings.jsonl');
        try {
          const content = await fs.readFile(findingsPath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              
              // Only replay if node doesn't exist in memory (dedupe)
              if (!this.memory.nodes.has(entry.nodeId)) {
                const node = await this.memory.addNode(entry.content, entry.tag);
                if (node) {
                  replayed.push({ type: 'finding', agentId, nodeId: node.id });
                }
              }
            } catch (parseError) {
              // Skip corrupted line
              this.logger.debug('Skipping corrupted journal entry', {
                agentId,
                error: parseError.message
              });
            }
          }
        } catch (readError) {
          // No findings journal (normal)
        }
        
        // Replay insights.jsonl
        const insightsPath = path.join(agentsDir, agentId, 'insights.jsonl');
        try {
          const content = await fs.readFile(insightsPath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              
              if (!this.memory.nodes.has(entry.nodeId)) {
                const node = await this.memory.addNode(entry.content, entry.tag);
                if (node) {
                  replayed.push({ type: 'insight', agentId, nodeId: node.id });
                }
              }
            } catch (parseError) {
              this.logger.debug('Skipping corrupted journal entry', {
                agentId,
                error: parseError.message
              });
            }
          }
        } catch (readError) {
          // No insights journal (normal)
        }
      }
    } catch (dirError) {
      // Agents directory doesn't exist (normal on fresh runs)
      return [];
    }
    
    return replayed;
  }

  async migrateGoalsToTasks() {
    try {
      const activeGoals = this.goals.getGoals();
      
      if (activeGoals.length === 0) return;
      
      // Check if migration already happened by looking for existing migrated tasks
      // This prevents re-migrating on every load (goals would be archived repeatedly)
      const existingBacklogPlan = await this.clusterStateStore.getPlan('plan:backlog');
      if (existingBacklogPlan) {
        // Backlog plan exists - check if we have migrated tasks already
        const existingTasks = await this.clusterStateStore.listTasks('plan:backlog');
        const migratedTaskCount = existingTasks.filter(t => t.tags?.includes('migrated')).length;
        
        if (migratedTaskCount > 0) {
          // Migration already happened - don't re-migrate
          // This preserves newly discovered goals alongside existing tasks
          this.logger.info('ℹ️  Goal-to-task migration already complete', {
            existingMigratedTasks: migratedTaskCount,
            currentActiveGoals: activeGoals.length,
            note: 'New goals will remain active alongside tasks'
          });
          return;
        }
      }
      
      this.logger.info('🔄 Migrating legacy goals to task system (one-time)', {
        count: activeGoals.length
      });
      
      // Ensure backlog plan exists
      let backlogPlan = existingBacklogPlan;
      if (!backlogPlan) {
        backlogPlan = {
          id: 'plan:backlog',
          title: 'Migrated Goals Backlog',
          version: 1,
          status: 'ACTIVE',
          milestones: ['ms:backlog'],
          activeMilestone: 'ms:backlog',
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        await this.clusterStateStore.createPlan(backlogPlan);
        
        await this.clusterStateStore.upsertMilestone({
          id: 'ms:backlog',
          planId: backlogPlan.id,
          title: 'Backlog',
          order: 1,
          status: 'ACTIVE',
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
      
      // Convert each goal to task
      for (const goal of activeGoals) {
        const task = {
          id: `task:${goal.id}`,
          planId: backlogPlan.id,
          milestoneId: 'ms:backlog',
          title: goal.description.substring(0, 100),
          description: goal.description,
          tags: ['migrated', goal.source],
          deps: [],
          priority: goal.priority,
          state: 'PENDING',
          acceptanceCriteria: [{ type: 'qa', rubric: 'Goal completed successfully', threshold: 0.7 }],
          artifacts: [],
          createdAt: goal.created || Date.now(),
          updatedAt: Date.now()
        };
        
        await this.clusterStateStore.upsertTask(task);
      }
      
      // CHANGED: Do NOT archive goals after migration
      // Rationale: Goals must remain active so Meta-Coordinator can continue spawning agents
      // The task system and goal system can coexist - goals drive agent spawning, tasks track structure
      // If we archive all goals, the coordinator has nothing to assign to agents!
      
      // Instead, mark goals as migrated (add metadata flag) but keep them active
      activeGoals.forEach(g => {
        if (!g.metadata) g.metadata = {};
        g.metadata.migratedToTask = true;
        g.metadata.taskId = `task:${g.id}`;
      });
      
      this.logger.info('✅ Goal migration complete', {
        migratedGoals: activeGoals.length,
        tasksCreated: activeGoals.length,
        note: 'Goals remain active for agent spawning, tasks track structure'
      });
    } catch (error) {
      this.logger.error('[Orchestrator] migrateGoalsToTasks error', {
        error: error.message
      });
    }
  }

  /**
   * Refocus the run - clear current focus without losing memory
   * Use this when the system is stuck or off-track.
   *
   * @param {Object} options
   * @param {string} options.newFocus - New focus directive to inject (optional)
   * @param {boolean} options.archiveAllGoals - Archive all active goals (default: true)
   * @param {boolean} options.clearPendingAgents - Clear pending agent work (default: true)
   * @returns {Object} Summary of what was refocused
   */
  async refocus(options = {}) {
    const {
      newFocus = null,
      archiveAllGoals = true,
      clearPendingAgents = true
    } = options;

    this.logger.info('🔄 REFOCUS: Clearing head without losing memory');

    let goalsArchived = 0;
    let agentsCleared = 0;

    // 1. Reset executive coherence
    if (this.executiveRing) {
      this.executiveRing.reset();
      this.logger.info('✅ Executive coherence reset to 1.0');
    }

    // 2. Archive current goals (preserves them, just marks inactive)
    if (archiveAllGoals && this.goals) {
      try {
        const activeGoals = this.goals.getGoals().filter(g => g.status === 'active');
        const goalIds = activeGoals.map(g => g.id);
        if (goalIds.length > 0) {
          await this.goals.archiveGoalsByIds(goalIds, 'refocus_requested');
          goalsArchived = goalIds.length;
          this.logger.info(`✅ Archived ${goalsArchived} active goals`);
        }
      } catch (error) {
        this.logger.warn('Could not archive goals', { error: error.message });
      }
    }

    // 3. Clear pending agent work (don't process queued results)
    if (clearPendingAgents && this.resultsQueue) {
      try {
        agentsCleared = this.resultsQueue.queue?.length || 0;
        this.resultsQueue.queue = [];
        this.logger.info(`✅ Cleared ${agentsCleared} pending agent results`);
      } catch (error) {
        this.logger.warn('Could not clear pending agents', { error: error.message });
      }
    }

    // 4. Inject new focus if provided
    if (newFocus && this.coordinator) {
      try {
        await this.coordinator.injectUrgentGoals([{
          description: newFocus,
          priority: 0.95,
          urgency: 'critical',
          rationale: 'Manual refocus directive'
        }], this.goals);
        this.logger.info('✅ Injected new focus directive', { focus: newFocus.substring(0, 100) });
      } catch (error) {
        this.logger.warn('Could not inject new focus', { error: error.message });
      }
    }

    // 5. Memory is untouched - all learned knowledge preserved
    this.logger.info('✅ REFOCUS COMPLETE - Memory preserved, head cleared');

    return {
      goalsArchived,
      agentsCleared,
      newFocusInjected: !!newFocus,
      memoryPreserved: true
    };
  }

  async stop() {
    this.logger.info('Stopping GPT-5.2 system...');
    this.running = false;

    // Stop immediate action poller
    this.stopImmediateActionPoller();

    // Stop Guardian control file poller
    this.stopGuardianControlPoller();

    // Cluster cleanup (if enabled)
    if (this.clusterOrchestrator) {
      this.logger.info('Cleaning up cluster orchestrator...');
      try {
        await this.clusterOrchestrator.cleanup();
        this.logger.info('✅ Cluster orchestrator cleaned up');
      } catch (error) {
        this.logger.error('Error cleaning up cluster orchestrator', { error: error.message });
      }
    }
    
    if (this.clusterStateStore) {
      this.logger.info('Disconnecting from cluster backend...');
      try {
        await this.clusterStateStore.disconnect();
        this.logger.info('✅ Cluster backend disconnected');
      } catch (error) {
        this.logger.error('Error disconnecting cluster backend', { error: error.message });
      }
    }
    
    // Shutdown document feeder
    if (this.feeder) {
      try {
        await this.feeder.shutdown();
      } catch (err) {
        this.logger.warn('Feeder shutdown error', { error: err.message });
      }
    }

    // Phase A: Use graceful shutdown handler if available
    if (this.shutdownHandler) {
      // Shutdown handler will save state, cleanup resources, etc.
      // Don't call process.exit here - let handler do it
      // For manual stop (not signal), just save state
      await this.saveState();
      await this.telemetry.cleanup();
      await this.crashRecovery.markCleanShutdown();
    } else {
      // Fallback to original behavior
      await this.saveState();
    }
    
    this.logger.info('GPT-5.2 system stopped');
  }

  determineReviewRole(plan) {
    if (!plan) {
      return this.clusterSync.enabled ? 'observer' : 'solo';
    }

    const entry = this.findRosterEntry(plan, this.instanceId);
    if (entry && entry.role) {
      return entry.role;
    }

    const normalizedId = String(this.instanceId || '').toLowerCase();
    const toLower = (value) => String(value || '').toLowerCase();

    const authors = Array.isArray(plan.assignments?.authors)
      ? plan.assignments.authors.map(toLower)
      : [];
    if (authors.includes(normalizedId)) {
      return 'author';
    }

    const synthesizer = plan.assignments?.synthesizer
      ? toLower(plan.assignments.synthesizer)
      : null;
    if (synthesizer && synthesizer === normalizedId) {
      return 'synthesizer';
    }

    const critics = Array.isArray(plan.assignments?.critics)
      ? plan.assignments.critics.map(toLower)
      : [];
    if (critics.includes(normalizedId)) {
      return 'critic';
    }

    if (entry && entry.roleHint) {
      return entry.roleHint;
    }

    return this.clusterSync.enabled ? 'observer' : 'solo';
  }

  findRosterEntry(plan, instanceId = this.instanceId) {
    if (!plan) return null;
    const normalized = String(instanceId || '').toLowerCase();
    const roster = Array.isArray(plan.roster) ? plan.roster : [];
    const awaiting = Array.isArray(plan.awaiting) ? plan.awaiting : [];

    const match = roster.find(
      (entry) => String(entry.instanceId || '').toLowerCase() === normalized
    );
    if (match) return match;

    return awaiting.find(
      (entry) => String(entry.instanceId || '').toLowerCase() === normalized
    ) || null;
  }

  async findReviewArtifact(cycle, artifactId) {
    if (!this.clusterStateStore || !artifactId) return null;
    try {
      const artifacts = await this.clusterStateStore.getReviewArtifacts(cycle);
      return artifacts.find((artifact) => artifact.artifactId === artifactId) || null;
    } catch (error) {
      this.logger.warn('Failed to fetch review artifacts', {
        cycle,
        artifactId,
        error: error.message
      });
      return null;
    }
  }

  async waitForArtifact(cycle, predicate, timeoutMs = 5000, pollInterval = 250) {
    if (!this.clusterStateStore || typeof predicate !== 'function') {
      return null;
    }

    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      try {
        const artifacts = await this.clusterStateStore.getReviewArtifacts(cycle);
        const match = artifacts.find(predicate);
        if (match) {
          return match;
        }
      } catch (error) {
        this.logger.warn('Error polling review artifacts', {
          cycle,
          error: error.message
        });
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return null;
  }

  async publishReviewDraft(plan, reviewResult) {
    if (!this.clusterStateStore || !plan || !reviewResult) {
      return null;
    }

    try {
      const artifactId = `draft_${this.instanceId}`;
      const existing = await this.findReviewArtifact(this.cycleCount, artifactId);
      if (existing) {
        return existing;
      }

      const rosterEntry = this.findRosterEntry(plan, this.instanceId);
      const prioritizedGoals = Array.isArray(reviewResult.prioritizedGoals)
        ? reviewResult.prioritizedGoals.slice(0, 5).map((goal) => ({
            id: goal.id,
            description: goal.description,
            priority: goal.priority
          }))
        : [];

      const strategicDirectives = Array.isArray(reviewResult.directives)
        ? reviewResult.directives.slice(0, 5)
        : [];

      const report = reviewResult.report
        ? {
            reviewId: reviewResult.report.reviewId,
            summary: reviewResult.report.summary,
            strategicDecisions: reviewResult.report.strategicDecisions,
            goalPortfolio: {
              prioritizedGoals: reviewResult.report.goalPortfolio?.prioritizedGoals || []
            },
            systemHealth: reviewResult.report.systemHealth || null
          }
        : null;

      const artifact = {
        artifactId,
        artifactType: 'draft',
        status: 'complete',
        instanceId: this.instanceId,
        planId: plan.planId || null,
        cycle: this.cycleCount,
        role: rosterEntry?.role || rosterEntry?.roleHint || 'author',
        createdAt: new Date().toISOString(),
        summary: {
          prioritizedGoals,
          strategicDirectives,
          keyInsights: reviewResult.decisions?.keyInsights || [],
          specializationRouting: reviewResult.specializationRouting || null
        },
        report,
        planDelta: reviewResult.planDelta || null,
        planRationale: reviewResult.planRationale || null
      };

      const record = await this.clusterStateStore.recordReviewArtifact(this.cycleCount, artifact);
      await this.recordReviewEvent({
        event: 'draft_published',
        planId: plan.planId || null,
        instanceId: this.instanceId,
        artifactId
      });
      return record;
    } catch (error) {
      this.logger.error('Failed to publish review draft', {
        cycle: this.cycleCount,
        error: error.message
      });
      return null;
    }
  }

  async handleReviewPipeline(reviewRole, reviewResult) {
    if (!this.clusterStateStore || !this.config.cluster?.enabled) {
      return;
    }

    const plan = this.currentReviewPlan;
    if (!plan) return;

    if (reviewRole === 'author' || reviewRole === 'author_synthesizer') {
      await this.publishReviewDraft(plan, reviewResult);
    }

    if (reviewRole === 'critic') {
      await this.processCritiqueStage(plan, reviewResult);
    } else if (reviewRole === 'synthesizer') {
      await this.processSynthesisStage(plan);
    } else if (reviewRole === 'author_synthesizer') {
      await this.processSynthesisStage(plan);
    }
  }

  async processCritiqueStage(plan, reviewResult) {
    if (!this.clusterStateStore) return null;

    try {
      const artifactId = `critique_${this.instanceId}`;
      const existing = await this.findReviewArtifact(this.cycleCount, artifactId);
      if (existing && existing.mission?.agentId) {
        return existing;
      }

      const authorIds = Array.isArray(plan.assignments?.authors)
        ? plan.assignments.authors.map((id) => String(id).toLowerCase())
        : [];

      const draftArtifact = await this.waitForArtifact(
        this.cycleCount,
        (artifact) =>
          artifact.artifactType === 'draft' &&
          authorIds.includes(String(artifact.instanceId || '').toLowerCase()),
        5000
      );

      if (!draftArtifact) {
        this.logger.warn('Critique stage skipped — draft not available', {
          cycle: this.cycleCount
        });
        return null;
      }

      const rosterEntry = this.findRosterEntry(plan, this.instanceId);
      const critiqueSummary = {
        observations: [
          `Draft from ${draftArtifact.instanceId} emphasizes ${draftArtifact.summary?.prioritizedGoals?.length || 0} prioritized goals.`,
          `Critic specialization (${rosterEntry?.specialization || 'generalist'}) will assess alignment with research perspective.`
        ],
        recommendations: [
          'Verify research coverage for high-risk goals.',
          'Cross-check whether exploration findings are integrated.'
        ]
      };

      const missionSpec = this.buildCritiqueMissionSpec(plan, draftArtifact, critiqueSummary, artifactId);
      const agentId = await this.spawnReviewMission(missionSpec);

      const artifact = {
        artifactId,
        artifactType: 'critique',
        status: agentId ? 'in_progress' : 'complete',
        instanceId: this.instanceId,
        planId: plan.planId || null,
        cycle: this.cycleCount,
        role: rosterEntry?.role || rosterEntry?.roleHint || 'critic',
        createdAt: new Date().toISOString(),
        draftArtifactId: draftArtifact.artifactId,
        summary: critiqueSummary,
        mission: agentId
          ? {
              missionId: missionSpec.missionId,
              goalId: missionSpec.goalId,
              agentType: missionSpec.agentType,
              agentId,
              spawnedAt: new Date().toISOString()
            }
          : null
      };

      const record = await this.clusterStateStore.recordReviewArtifact(this.cycleCount, artifact);
      await this.recordReviewEvent({
        event: agentId ? 'critique_spawned' : 'critique_recorded',
        planId: plan.planId || null,
        instanceId: this.instanceId,
        artifactId,
        missionId: missionSpec.missionId,
        agentId
      });
      return record;
    } catch (error) {
      this.logger.error('Failed to process critique stage', {
        cycle: this.cycleCount,
        error: error.message
      });
      return null;
    }
  }

  buildCritiqueMissionSpec(plan, draftArtifact, critiqueSummary, critiqueArtifactId = `critique_${this.instanceId}`) {
    const missionToken = Math.random().toString(36).slice(2, 10);
    const missionId = `mission_review_critique_${this.cycleCount}_${missionToken}`;
    const goalId = `review_critique_${this.cycleCount}_${this.instanceId}`;

    const artifactToReview = this.buildCritiqueArtifactPayload(plan, draftArtifact);

    return {
      missionId,
      goalId,
      agentType: 'quality_assurance',
      description: `Critique the strategic review draft generated by ${draftArtifact.instanceId} for cycle ${this.cycleCount}.`,
      instructions: [
        'Identify strengths and weaknesses in the proposed directives.',
        'Highlight missing risk factors, blind spots, or misaligned assignments.',
        'Recommend follow-up work for specialized instances.'
      ],
      successCriteria: [
        'Surface at least three actionable critiques.',
        'Flag any goals lacking coverage from assigned specialists.',
        'Recommend targeted follow-up missions or investigations.'
      ],
      artifactToReview,
      context: {
        planId: plan.planId || null,
        draftArtifact,
        critiqueSummary,
        artifactToReview,
        reviewerInstance: this.instanceId,
        cycle: this.cycleCount
      },
      spawnCycle: this.cycleCount,
      triggerSource: 'cluster_review_pipeline',
      createdBy: 'cluster_coordinator',
      provenanceChain: [plan.planId, draftArtifact.artifactId].filter(Boolean),
      maxDuration: 10 * 60 * 1000,
      reviewPipeline: {
        role: 'critic',
        planId: plan.planId || null,
        artifactId: critiqueArtifactId,
        draftArtifactId: draftArtifact.artifactId,
        cycle: this.cycleCount
      }
    };
  }

  buildCritiqueArtifactPayload(plan, draftArtifact) {
    const payload = {
      mission: {
        goalId: plan.planId ? `${plan.planId}_draft_review` : `review_draft_${this.cycleCount}`,
        description: `Strategic review draft for cooperative cycle ${this.cycleCount}`,
        planId: plan.planId || null,
        draftArtifactId: draftArtifact.artifactId
      },
      results: [],
      metadata: {
        prioritizedGoals: draftArtifact.summary?.prioritizedGoals?.length || 0,
        directives: draftArtifact.summary?.strategicDirectives?.length || 0
      }
    };

    const pushResult = (type, content) => {
      if (typeof content === 'string') {
        const trimmed = content.trim();
        if (trimmed) {
          payload.results.push({ type, content: trimmed });
        }
      }
    };

    (draftArtifact.summary?.prioritizedGoals || []).forEach((goal, index) => {
      const description = goal.description || goal.summary || goal.title || goal.id || `Goal ${index + 1}`;
      const priority = typeof goal.priority === 'number'
        ? ` (priority ${goal.priority.toFixed(2)})`
        : '';
      pushResult('finding', `Priority ${index + 1}: ${description}${priority}`);
    });

    (draftArtifact.summary?.strategicDirectives || []).forEach((directive, index) => {
      pushResult('recommendation', `Directive ${index + 1}: ${directive}`);
    });

    (draftArtifact.summary?.keyInsights || []).forEach((insight, index) => {
      pushResult('insight', `Insight ${index + 1}: ${insight}`);
    });

    const decisions = draftArtifact.report?.strategicDecisions;
    if (decisions?.content) {
      pushResult('analysis', `Strategic decisions: ${decisions.content}`);
    }

    if (payload.results.length === 0) {
      pushResult('finding', 'Draft contains no prioritized goals or directives; confirm coordinator output.');
    }

    return payload;
  }

  async processSynthesisStage(plan) {
    if (!this.clusterStateStore) return null;

    try {
      const artifactId = `synthesis_${this.instanceId}`;
      const existing = await this.findReviewArtifact(this.cycleCount, artifactId);
      if (existing && existing.mission?.agentId) {
        return existing;
      }

      const authorIds = Array.isArray(plan.assignments?.authors)
        ? plan.assignments.authors.map((id) => String(id).toLowerCase())
        : [];

      const draftArtifact = await this.waitForArtifact(
        this.cycleCount,
        (artifact) =>
          artifact.artifactType === 'draft' &&
          authorIds.includes(String(artifact.instanceId || '').toLowerCase()),
        5000
      );

      if (!draftArtifact) {
        this.logger.warn('Synthesis stage waiting for draft timed out', {
          cycle: this.cycleCount
        });
        return null;
      }

      const critiques = await this.clusterStateStore.getReviewArtifacts(this.cycleCount);
      const critiqueArtifacts = critiques.filter(
        (artifact) =>
          artifact.artifactType === 'critique' &&
          artifact.planId === plan.planId &&
          artifact.summary
      );

      if (critiqueArtifacts.length === 0) {
        this.logger.info('Synthesis stage postponed — awaiting critiques', {
          cycle: this.cycleCount
        });
        return null;
      }

      const synthesisSummary = {
        critiquesConsidered: critiqueArtifacts.length,
        recommendations: critiqueArtifacts.flatMap((artifact) =>
          artifact.summary?.recommendations || []
        ).slice(0, 5),
        nextSteps: [
          'Consolidate critique follow-ups into actionable tasks.',
          'Update cluster plan with synthesis conclusions.'
        ]
      };

      const missionSpec = this.buildSynthesisMissionSpec(
        plan,
        draftArtifact,
        critiqueArtifacts,
        synthesisSummary,
        artifactId
      );
      const agentId = await this.spawnReviewMission(missionSpec);

      const rosterEntry = this.findRosterEntry(plan, this.instanceId);
      const artifact = {
        artifactId,
        artifactType: 'synthesis',
        status: agentId ? 'in_progress' : 'complete',
        instanceId: this.instanceId,
        planId: plan.planId || null,
        cycle: this.cycleCount,
        role: rosterEntry?.role || rosterEntry?.roleHint || 'synthesizer',
        createdAt: new Date().toISOString(),
        draftArtifactId: draftArtifact.artifactId,
        critiqueArtifacts: critiqueArtifacts.map((artifact) => artifact.artifactId),
        summary: synthesisSummary,
        mission: agentId
          ? {
              missionId: missionSpec.missionId,
              goalId: missionSpec.goalId,
              agentType: missionSpec.agentType,
              agentId,
              spawnedAt: new Date().toISOString()
            }
          : null
      };

      const record = await this.clusterStateStore.recordReviewArtifact(this.cycleCount, artifact);
      await this.recordReviewEvent({
        event: agentId ? 'synthesis_spawned' : 'synthesis_recorded',
        planId: plan.planId || null,
        instanceId: this.instanceId,
        artifactId,
        missionId: missionSpec.missionId,
        agentId,
        critiquesUsed: critiqueArtifacts.map((artifact) => artifact.artifactId)
      });
      
      // Apply PlanDelta if present in draft
      if (draftArtifact.planDelta) {
        this.logger.info('Applying PlanDelta from review', {
          planId: draftArtifact.planDelta.planId
        });
        
        const applied = await this.clusterStateStore.applyPlanDelta(
          draftArtifact.planDelta
        );
        
        if (!applied) {
          this.logger.warn('⚠️  PlanDelta conflict - plan version changed during review');
        } else {
          this.logger.info('✅ PlanDelta applied successfully');
        }
      }
      
      return record;
    } catch (error) {
      this.logger.error('Failed to process synthesis stage', {
        cycle: this.cycleCount,
        error: error.message
      });
      return null;
    }
  }

  buildSynthesisMissionSpec(plan, draftArtifact, critiques, synthesisSummary, synthesisArtifactId = `synthesis_${this.instanceId}`) {
    const missionToken = Math.random().toString(36).slice(2, 10);
    const missionId = `mission_review_synthesis_${this.cycleCount}_${missionToken}`;
    const goalId = `review_synthesis_${this.cycleCount}_${this.instanceId}`;

    return {
      missionId,
      goalId,
      agentType: 'synthesis',
      description: `Integrate critiques into a unified action plan for review cycle ${this.cycleCount}.`,
      instructions: [
        'Combine critique observations into a coherent cluster-wide plan.',
        'Highlight consensus actions and remaining disagreements.',
        'Recommend ownership assignments aligned with specialization profiles.'
      ],
      successCriteria: [
        'Summarize critique highlights and draft strengths.',
        'Produce a consolidated action list assigning owners per specialization.',
        'Identify outstanding risks requiring additional goals.'
      ],
      context: {
        planId: plan.planId || null,
        draftArtifact,
        critiques,
        synthesisSummary,
        reviewArtifacts: {
          draft: draftArtifact,
          critiques
        },
        reviewerInstance: this.instanceId,
        cycle: this.cycleCount
      },
      spawnCycle: this.cycleCount,
      triggerSource: 'cluster_review_pipeline',
      createdBy: 'cluster_coordinator',
      provenanceChain: [
        plan.planId,
        draftArtifact.artifactId,
        ...critiques.map((artifact) => artifact.artifactId)
      ].filter(Boolean),
      maxDuration: 12 * 60 * 1000,
      reviewPipeline: {
        role: 'synthesizer',
        planId: plan.planId || null,
        artifactId: synthesisArtifactId,
        draftArtifactId: draftArtifact.artifactId,
        critiqueArtifactIds: critiques.map((artifact) => artifact.artifactId),
        cycle: this.cycleCount
      }
    };
  }

  async spawnReviewMission(missionSpec) {
    if (!missionSpec || !this.agentExecutor || !this.agentExecutor.initialized) {
      return null;
    }

    try {
      return await this.agentExecutor.spawnAgent(missionSpec);
    } catch (error) {
      this.logger.error('Failed to spawn review pipeline mission', {
        missionId: missionSpec.missionId,
        error: error.message
      });
      return null;
    }
  }

  async recordReviewEvent(event) {
    if (!this.clusterStateStore || !event) {
      return false;
    }

    try {
      await this.clusterStateStore.appendReviewEvent(this.cycleCount, {
        cycle: this.cycleCount,
        ...event,
        timestamp: new Date().toISOString()
      });
      return true;
    } catch (error) {
      this.logger.warn('Failed to record review event', {
        cycle: this.cycleCount,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Snapshot of latest branch metadata for downstream telemetry.
   */
  getLatestBranchMetadata() {
    return this.latestBranchMetadata;
  }

  getStats() {
    return {
      cycleCount: this.cycleCount,
      running: this.running,
      uptime: Date.now() - this.lastCycleTime.getTime(),
      oscillator: this.oscillator.getStats(),
      coordinator: this.coordinator ? this.coordinator.getStats() : null,
      forkSystem: this.forkSystem ? this.forkSystem.getStats() : null,
      topicQueue: this.topicQueue ? this.topicQueue.getStats() : null,
      gpt5: {
        reasoningHistory: this.reasoningHistory.length,
        webSearchCount: this.webSearchCount,
        usingExtendedReasoning: true,
        usingWebSearch: true
      },
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
      subsystems: {
        memory: this.memory.getStats(),
        roles: this.roles.getStats(),
        goals: this.goals.getStats(),
        state: this.stateModulator.getStats(),
        thermodynamic: this.thermodynamic.getStats(),
        chaos: this.chaotic.getStats(),
        reflection: this.reflection.getStats(),
        temporal: this.temporal.getStats(),
        environment: this.environment?.getStats() || null,
        summarizer: this.summarizer.getStats()
      },
      recentThoughts: this.journal.slice(-5).map(j => ({
        cycle: j.cycle,
        mode: j.oscillatorMode,
        role: j.role,
        hasReasoning: Boolean(j.reasoning),
        usedWebSearch: j.usedWebSearch,
        thought: j.thought.substring(0, 100)
      }))
    };
  }

  /**
   * Gather arc data for arc report generation
   */
  async gatherArcData(runRoot) {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Load manifest if exists
    let manifestData = {};
    try {
      const manifestPath = path.join(runRoot, 'outputs', 'manifests', 'manifest.json');
      const manifestText = await fs.readFile(manifestPath, 'utf8');
      manifestData = JSON.parse(manifestText);
    } catch (e) {
      // Manifest not generated yet
    }
    
    // Load validation report if exists
    let validationData = {};
    try {
      const validationPath = path.join(runRoot, 'outputs', 'reports', 'validation_report.json');
      const validationText = await fs.readFile(validationPath, 'utf8');
      validationData = JSON.parse(validationText);
    } catch (e) {
      // Validation not run yet
    }
    
    // Gather goal data
    const allGoals = this.goals ? this.goals.getGoals() : [];
    const goalsData = {
      initial: allGoals.filter(g => g.source === 'user' || g.source === 'guided_task_phase'),
      recursive: allGoals.filter(g => g.source === 'recursive_planner'),
      completed: this.goals?.completedGoals || [],
      remaining: allGoals.filter(g => g.status === 'active')
    };
    
    // Gather agent data  
    const agentsData = {
      total: this.agentExecutor?.registry ? this.agentExecutor.registry.getStats().total : 0,
      byType: this.agentExecutor?.registry ? this.agentExecutor.registry.getStats().byType : {},
      autoSpawned: 0
    };
    
    // Sample recent thoughts
    const thoughtSamples = this.journal.slice(-10).map(entry => ({
      cycle: entry.cycle,
      thought: entry.thought
    }));
    
    return {
      arcId: `arc_${Date.now()}`,
      startTime: this.startTime || Date.now(),
      endTime: Date.now(),
      cycleCount: this.cycleCount,
      haltReason: this.recursiveState?.haltReason || 'manual_stop',
      runRoot,
      goals: goalsData,
      agents: agentsData,
      thoughts: thoughtSamples,
      recursivePlannerState: this.recursivePlanner?.state || {},
      manifestData,
      validationData,
      memoryStats: {
        nodesStart: 0,
        nodesEnd: this.memory ? this.memory.nodes.size : 0,
        introspectionNodes: this.memory ? 
          Array.from(this.memory.nodes.values()).filter(n => n.tag === 'introspection').length : 0
      }
    };
  }
}

module.exports = { Orchestrator };
