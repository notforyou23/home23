/**
 * Orchestrator Worker Thread
 *
 * Runs a complete COSMO orchestrator in an isolated worker thread.
 * Each user gets their own worker with:
 * - Separate V8 isolate (memory heap)
 * - Own event loop
 * - True parallel execution
 *
 * Communication with main thread via postMessage:
 * - Receives: start, stop, getStatus commands
 * - Sends: events, status updates, errors
 */

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

// Worker state
let orchestrator = null;
let subsystems = null;
let contextId = null;
let config = null;
let isRunning = false;
let startTime = null;

// Simple logger that prefixes with contextId
const logger = {
  info: (...args) => console.log(`[Worker:${contextId}]`, ...args),
  warn: (...args) => console.warn(`[Worker:${contextId}]`, ...args),
  error: (...args) => console.error(`[Worker:${contextId}]`, ...args),
  debug: (...args) => {} // Suppress debug in workers
};

/**
 * Send message to main thread
 */
function sendToMain(type, data = {}) {
  parentPort.postMessage({ type, contextId, timestamp: Date.now(), ...data });
}

/**
 * Send event to main thread (for WebSocket broadcast)
 */
function emitEvent(eventType, eventData) {
  sendToMain('event', {
    eventType,
    eventData: { ...eventData, contextId }
  });
}

/**
 * Create a proxy event emitter that forwards to main thread
 * Must include ALL methods from COSMOEventEmitter in event-emitter.js
 */
function createProxyEventEmitter() {
  return {
    // Generic emit methods
    emitEvent: (type, data) => emitEvent(type, data),
    emit: (type, data) => emitEvent(type, data),

    // Cycle events
    emitCycleStart: (data) => emitEvent('cycle_start', data),
    emitCycleComplete: (data) => emitEvent('cycle_complete', data),

    // Thought events
    emitThought: (data) => emitEvent('thought_generated', data),

    // Agent events
    emitAgentSpawned: (data) => emitEvent('agent_spawned', data),
    emitAgentCompleted: (data) => emitEvent('agent_completed', data),
    emitAgentFailed: (data) => emitEvent('agent_failed', data),

    // Memory events
    emitNodeCreated: (data) => emitEvent('node_created', data),
    emitEdgeCreated: (data) => emitEvent('edge_created', data),
    emitMemoryConsolidated: (data) => emitEvent('memory_consolidated', data),

    // Sleep/wake events
    emitSleepTriggered: (data) => emitEvent('sleep_triggered', data),
    emitWakeTriggered: (data) => emitEvent('wake_triggered', data),
    emitDreamRewiring: (data) => emitEvent('dream_rewiring', data),

    // Cognitive events
    emitCognitiveStateChanged: (data) => emitEvent('cognitive_state_changed', data),
    emitOscillatorModeChanged: (data) => emitEvent('oscillator_mode_changed', data),

    // Coordinator events
    emitCoordinatorReview: (data) => emitEvent('coordinator_review', data),
    emitExecutiveDecision: (data) => emitEvent('executive_decision', data),

    // Goal events
    emitGoalCreated: (data) => emitEvent('goal_created', data),
    emitGoalCompleted: (data) => emitEvent('goal_completed', data),

    // Direct action events (COSMO Hands)
    emitDirectAction: (data) => emitEvent('direct_action', data),

    // Research/insight events
    emitInsightDetected: (data) => emitEvent('insight_detected', data),
    emitWebSearch: (data) => emitEvent('web_search', data),

    // Run status events
    emitRunStatus: (data) => emitEvent('run_status', data),
    emitResearchComplete: (data) => emitEvent('research_complete', data)
  };
}

/**
 * Initialize and start the orchestrator
 */
async function startOrchestrator(startConfig) {
  if (isRunning) {
    sendToMain('error', { error: 'Orchestrator already running' });
    return;
  }

  try {
    config = startConfig;
    contextId = config.contextId;

    logger.info('Starting orchestrator...', {
      runName: config.runName,
      runtimePath: config.runtimePath
    });

    // Set runtime path for this worker
    process.env.COSMO_RUNTIME_PATH = config.runtimePath;

    // Import engine components (done here to ensure correct runtime path)
    const enginePath = path.join(__dirname, '..');

    // Core components
    const { ConfigLoader } = require(path.join(enginePath, 'core/config-loader'));
    const { ConfigValidator } = require(path.join(enginePath, 'core/config-validator'));
    const { PathResolver } = require(path.join(enginePath, 'core/path-resolver'));
    const { Orchestrator } = require(path.join(enginePath, 'core/orchestrator'));

    // Subsystems - paths match engine/src/index.js exactly
    const { NetworkMemory } = require(path.join(enginePath, 'memory/network-memory'));
    const { ClusterAwareMemory } = require(path.join(enginePath, 'cluster/cluster-aware-memory'));
    const { MemorySummarizer } = require(path.join(enginePath, 'memory/summarizer'));
    const { DynamicRoleSystem } = require(path.join(enginePath, 'cognition/dynamic-roles'));
    const { QuantumReasoner } = require(path.join(enginePath, 'cognition/quantum-reasoner'));
    const { CognitiveStateModulator } = require(path.join(enginePath, 'cognition/state-modulator'));
    const { ThermodynamicController } = require(path.join(enginePath, 'cognition/thermodynamic'));
    const { ChaoticEngine } = require(path.join(enginePath, 'creativity/chaotic-engine'));
    const { IntrinsicGoalSystem } = require(path.join(enginePath, 'goals/intrinsic-goals'));
    const { GoalCaptureSystem } = require(path.join(enginePath, 'goals/goal-capture'));
    const { ReflectionAnalyzer } = require(path.join(enginePath, 'reflection/analyzer'));
    const { EnvironmentInterface } = require(path.join(enginePath, 'environment/interface'));
    const { TemporalRhythms } = require(path.join(enginePath, 'temporal/rhythms'));
    const { FocusExplorationOscillator } = require(path.join(enginePath, 'temporal/oscillator'));
    const { TrajectoryForkSystem } = require(path.join(enginePath, 'cognition/trajectory-fork'));
    const { TopicQueueSystem } = require(path.join(enginePath, 'goals/topic-queue'));
    const { MetaCoordinator } = require(path.join(enginePath, 'coordinator/meta-coordinator'));
    const { AgentExecutor } = require(path.join(enginePath, 'agents/agent-executor'));

    // Agent types
    const { ResearchAgent } = require(path.join(enginePath, 'agents/research-agent'));
    const { AnalysisAgent } = require(path.join(enginePath, 'agents/analysis-agent'));
    const { SynthesisAgent } = require(path.join(enginePath, 'agents/synthesis-agent'));
    const { ExplorationAgent } = require(path.join(enginePath, 'agents/exploration-agent'));
    const { CodebaseExplorationAgent } = require(path.join(enginePath, 'agents/codebase-exploration-agent'));
    const { CodeExecutionAgent } = require(path.join(enginePath, 'agents/code-execution-agent'));
    const { QualityAssuranceAgent } = require(path.join(enginePath, 'agents/quality-assurance-agent'));
    const { PlanningAgent } = require(path.join(enginePath, 'agents/planning-agent'));
    const { IntegrationAgent } = require(path.join(enginePath, 'agents/integration-agent'));
    const { DocumentCreationAgent } = require(path.join(enginePath, 'agents/document-creation-agent'));
    const { CodeCreationAgent } = require(path.join(enginePath, 'agents/code-creation-agent'));
    const { CompletionAgent } = require(path.join(enginePath, 'agents/completion-agent'));
    const { DocumentAnalysisAgent } = require(path.join(enginePath, 'agents/document-analysis-agent'));
    const { ConsistencyAgent } = require(path.join(enginePath, 'agents/consistency-agent'));
    const { SpecializedBinaryAgent } = require(path.join(enginePath, 'agents/specialized-binary-agent'));
    const { DocumentCompilerAgent } = require(path.join(enginePath, 'agents/document-compiler-agent'));
    const { IDEAgent } = require(path.join(enginePath, 'agents/ide-agent'));
    const { AutomationAgent } = require(path.join(enginePath, 'agents/automation-agent'));
    const { DataAcquisitionAgent } = require(path.join(enginePath, 'agents/data-acquisition-agent'));
    const { DataPipelineAgent } = require(path.join(enginePath, 'agents/data-pipeline-agent'));
    const { InfrastructureAgent } = require(path.join(enginePath, 'agents/infrastructure-agent'));

    // Cluster state store for plan persistence (even in single-node mode)
    const ClusterStateStore = require(path.join(enginePath, 'cluster/cluster-state-store'));
    const FilesystemStateStore = require(path.join(enginePath, 'cluster/backends/filesystem-state-store'));

    // Load and merge configuration
    const configLoader = new ConfigLoader();
    const baseConfig = configLoader.load();
    const mergedConfig = {
      ...baseConfig,
      ...config.engineConfig,
      runtimeRoot: config.runtimePath,
      logsDir: config.runtimePath,
      contextId: contextId
    };

    // Validate configuration
    const validator = new ConfigValidator(mergedConfig, logger);
    const validation = validator.validate();
    if (!validation.valid) {
      throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
    }

    // Initialize path resolver
    const pathResolver = new PathResolver(mergedConfig, logger);

    // Create proxy event emitter for forwarding events to main thread
    const eventEmitter = createProxyEventEmitter();

    // Initialize memory subsystems
    const baseMemory = new NetworkMemory(mergedConfig.architecture.memory, logger, eventEmitter);
    const clusterMemoryManager = new ClusterAwareMemory(baseMemory, {
      config: mergedConfig,
      logger,
      instanceId: contextId,
      clusterEnabled: false
    });
    const memory = clusterMemoryManager.getInterface();

    // Initialize other subsystems (passing eventEmitter where needed)
    const summarizer = new MemorySummarizer(mergedConfig.architecture, logger, mergedConfig);
    const roles = new DynamicRoleSystem(mergedConfig.architecture, logger, mergedConfig);
    const quantum = new QuantumReasoner(mergedConfig.architecture, logger, mergedConfig);
    const stateModulator = new CognitiveStateModulator(mergedConfig.architecture, logger, eventEmitter);
    const thermodynamic = new ThermodynamicController(mergedConfig.architecture, logger);
    const chaotic = new ChaoticEngine(mergedConfig.architecture, logger);
    const goals = new IntrinsicGoalSystem(mergedConfig.architecture, logger, eventEmitter);
    const goalCapture = new GoalCaptureSystem(logger);
    const reflection = new ReflectionAnalyzer(mergedConfig.architecture, logger);
    const environment = new EnvironmentInterface(mergedConfig.architecture, logger);
    const temporal = new TemporalRhythms(mergedConfig.architecture, logger, eventEmitter);
    const oscillator = new FocusExplorationOscillator(mergedConfig, logger, eventEmitter);
    const forkSystem = new TrajectoryForkSystem(mergedConfig, { memory, quantum, goals }, logger);
    const topicQueue = new TopicQueueSystem(mergedConfig.architecture, goals, logger);

    // Initialize cluster state store for plan persistence (single-node filesystem mode)
    // This enables structured plans with phases/milestones/tasks even without Redis
    let clusterStateStore = null;
    try {
      const fsStateStoreConfig = {
        fsRoot: config.runtimePath, // Use the brain's runtime path
        instanceId: contextId,
        readOnly: false
      };
      logger.info('📦 Initializing ClusterStateStore...', { fsRoot: config.runtimePath });
      const fsBackend = new FilesystemStateStore(fsStateStoreConfig, logger);
      await fsBackend.connect();
      clusterStateStore = new ClusterStateStore(fsStateStoreConfig, fsBackend);
      await clusterStateStore.connect();
      logger.info('📦 ClusterStateStore initialized (filesystem backend)', { fsRoot: config.runtimePath });
    } catch (stateStoreError) {
      logger.error('⚠️ ClusterStateStore initialization failed (non-fatal)', { 
        error: stateStoreError.message,
        stack: stateStoreError.stack?.split('\n').slice(0, 3).join('\n')
      });
      // Continue without state store - structured plans won't be persisted
    }

    // Initialize coordinator with event emitter
    const coordinator = new MetaCoordinator(mergedConfig, logger, pathResolver, null, eventEmitter);

    // Initialize agent executor with event emitter
    const agentExecutor = new AgentExecutor(
      { memory, goals, pathResolver, eventEmitter },
      mergedConfig,
      logger
    );

    // Register agent types
    agentExecutor.registerAgentType('research', ResearchAgent);
    agentExecutor.registerAgentType('analysis', AnalysisAgent);
    agentExecutor.registerAgentType('synthesis', SynthesisAgent);
    agentExecutor.registerAgentType('exploration', ExplorationAgent);
    agentExecutor.registerAgentType('codebase_exploration', CodebaseExplorationAgent);
    agentExecutor.registerAgentType('code_execution', CodeExecutionAgent);
    agentExecutor.registerAgentType('quality_assurance', QualityAssuranceAgent);
    agentExecutor.registerAgentType('planning', PlanningAgent);
    agentExecutor.registerAgentType('integration', IntegrationAgent);
    agentExecutor.registerAgentType('document_creation', DocumentCreationAgent);
    agentExecutor.registerAgentType('code_creation', CodeCreationAgent);
    agentExecutor.registerAgentType('completion', CompletionAgent);
    agentExecutor.registerAgentType('document_analysis', DocumentAnalysisAgent);
    agentExecutor.registerAgentType('consistency', ConsistencyAgent);
    agentExecutor.registerAgentType('specialized_binary', SpecializedBinaryAgent);
    agentExecutor.registerAgentType('document_compiler', DocumentCompilerAgent);
    agentExecutor.registerAgentType('ide', IDEAgent);

    // Disconfirmation agent - challenges assumptions and tests counter-hypotheses
    const { DisconfirmationAgent } = require('../agents/disconfirmation-agent');
    agentExecutor.registerAgentType('disconfirmation', DisconfirmationAgent);

    // Execution agents — CLI-first, tool-composing agents
    agentExecutor.registerAgentType('automation', AutomationAgent);
    agentExecutor.registerAgentType('dataacquisition', DataAcquisitionAgent);
    agentExecutor.registerAgentType('datapipeline', DataPipelineAgent);
    agentExecutor.registerAgentType('infrastructure', InfrastructureAgent);

    // CRITICAL FIX: Wire ClusterStateStore to AgentExecutor for artifact registration
    // This enables registerTaskArtifactsFromAgentRun() to work properly
    if (clusterStateStore && agentExecutor?.setClusterReviewContext) {
      agentExecutor.setClusterReviewContext(clusterStateStore, contextId);
      logger.info('✅ AgentExecutor cluster context configured', { contextId });
    }

    // Wire coordinator subsystems
    coordinator.phase2bSubsystems = {
      memory,
      agentExecutor,
      clusterStateStore, // Now properly initialized
      goals,
      eventEmitter
    };

    // Build subsystems object
    subsystems = {
      memory,
      summarizer,
      roles,
      quantum,
      stateModulator,
      thermodynamic,
      chaotic,
      goals,
      goalCapture,
      reflection,
      environment,
      temporal,
      oscillator,
      pathResolver,
      coordinator,
      agentExecutor,
      forkSystem,
      topicQueue,
      clusterStateStore, // Now properly initialized for plan persistence
      clusterOrchestrator: null,
      goalAllocator: null,
      clusterCoordinator: null,
      eventEmitter
    };

    // Create and initialize orchestrator
    orchestrator = new Orchestrator(mergedConfig, subsystems, logger);
    await orchestrator.initialize();

    // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Wire task state queue to AgentExecutor
    // This must happen AFTER orchestrator.initialize() creates the queue
    if (orchestrator.taskStateQueue && agentExecutor) {
      agentExecutor.taskStateQueue = orchestrator.taskStateQueue;
      logger.info('✅ Task state queue wired to AgentExecutor');
    }

    // Initiate guided mission if in guided mode - NON-BLOCKING
    if (mergedConfig.architecture?.roleSystem?.explorationMode === 'guided') {
      if (orchestrator.guidedMissionPlan) {
        // Plan restored from state - continue mode
        logger.info('📋 Guided mission plan restored from state (Continue mode)');
        if (!orchestrator.completionTracker && orchestrator.guidedMissionPlan) {
          const { CompletionTracker } = require('../core/completion-tracker');
          orchestrator.completionTracker = new CompletionTracker(orchestrator.guidedMissionPlan, logger);
        }
      } else {
        // Fresh run - generate mission plan in background (don't block worker startup)
        logger.info('🎯 Generating guided mission plan (background)...');
        subsystems.coordinator.initiateMission({
          guidedFocus: mergedConfig.architecture.roleSystem.guidedFocus,
          subsystems: {
            agentExecutor: subsystems.agentExecutor,
            goals: subsystems.goals,
            clusterStateStore: orchestrator.clusterStateStore,
            pathResolver: subsystems.pathResolver
          }
        }).then(result => {
          const plan = result?.plan || result;
          if (plan) {
            const { CompletionTracker } = require('../core/completion-tracker');
            orchestrator.completionTracker = new CompletionTracker(plan, logger);
            orchestrator.guidedMissionPlan = plan;
            logger.info('✅ Guided mission plan generated');
          }
        }).catch(err => {
          logger.warn('⚠️ Failed to generate guided plan:', err.message);
        });
      }
    }

    isRunning = true;
    startTime = Date.now();

    logger.info('Orchestrator initialized, starting research...');
    sendToMain('started', {
      runName: config.runName,
      runtimePath: config.runtimePath
    });

    // Start research (non-blocking) - method is 'start()' not 'startResearch()'
    orchestrator.start().then(() => {
      logger.info('Research completed');
      sendToMain('completed', { runName: config.runName });
    }).catch(err => {
      logger.error('Research failed:', err.message);
      sendToMain('error', { error: err.message });
    });

  } catch (error) {
    logger.error('Failed to start orchestrator:', error.message);
    sendToMain('error', { error: error.message, stack: error.stack });
    isRunning = false;
  }
}

/**
 * Stop the orchestrator gracefully
 */
async function stopOrchestrator() {
  if (!isRunning || !orchestrator) {
    sendToMain('stopped', { wasRunning: false });
    return;
  }

  logger.info('Stopping orchestrator...');

  try {
    // Signal orchestrator to stop
    orchestrator.running = false;

    // Give it time to finish current cycle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get final state info
    let finalCycleCount = 0;
    try {
      const statePath = path.join(config.runtimePath, 'state.json.gz');
      if (fs.existsSync(statePath)) {
        const zlib = require('zlib');
        const stateData = zlib.gunzipSync(fs.readFileSync(statePath));
        const state = JSON.parse(stateData.toString());
        finalCycleCount = state.cycleCount || 0;
      }
    } catch (e) {
      // Ignore state read errors
    }

    isRunning = false;
    const runDuration = Date.now() - startTime;

    logger.info('Orchestrator stopped', {
      runName: config.runName,
      cycleCount: finalCycleCount,
      durationMs: runDuration
    });

    sendToMain('stopped', {
      wasRunning: true,
      runName: config.runName,
      cycleCount: finalCycleCount,
      durationMs: runDuration
    });

  } catch (error) {
    logger.error('Error stopping orchestrator:', error.message);
    sendToMain('error', { error: error.message });
  }
}

/**
 * Get current status
 */
function getStatus() {
  let cycleCount = 0;
  let nodeCount = 0;
  let edgeCount = 0;

  if (isRunning && config?.runtimePath) {
    try {
      const statePath = path.join(config.runtimePath, 'state.json.gz');
      if (fs.existsSync(statePath)) {
        const zlib = require('zlib');
        const stateData = zlib.gunzipSync(fs.readFileSync(statePath));
        const state = JSON.parse(stateData.toString());
        cycleCount = state.cycleCount || 0;
        nodeCount = state.memory?.nodes?.length || 0;
        edgeCount = state.memory?.edges?.length || 0;
      }
    } catch (e) {
      // Ignore state read errors
    }
  }

  sendToMain('status', {
    isRunning,
    contextId,
    runName: config?.runName,
    runtimePath: config?.runtimePath,
    cycleCount,
    nodeCount,
    edgeCount,
    uptimeMs: isRunning ? Date.now() - startTime : 0
  });
}

/**
 * Handle messages from main thread
 */
parentPort.on('message', async (message) => {
  const { type, ...data } = message;

  switch (type) {
    case 'start':
      await startOrchestrator(data.config);
      break;

    case 'stop':
      await stopOrchestrator();
      break;

    case 'getStatus':
      getStatus();
      break;

    case 'ping':
      sendToMain('pong');
      break;

    default:
      logger.warn('Unknown message type:', type);
  }
});

// Handle uncaught errors in worker
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in worker:', error.message);
  sendToMain('error', { error: error.message, fatal: true });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection in worker:', reason);
  sendToMain('error', { error: String(reason), fatal: false });
});

// Signal that worker is ready
sendToMain('ready', { workerId: workerData?.workerId });
