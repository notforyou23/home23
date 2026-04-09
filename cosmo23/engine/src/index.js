#!/usr/bin/env node
/**
 * Phase 2B Self-Propelled AI - GPT-5.2 Version
 * Uses GPT-5.2 Responses API with extended reasoning, web search, and tools
 */

const path = require('path');

// Load environment variables from COSMO's .env only (don't search parent dirs)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ConfigLoader } = require('./core/config-loader');
const { ConfigValidator } = require('./core/config-validator');
const { PathResolver } = require('./core/path-resolver');
const { NetworkMemory } = require('./memory/network-memory');
const { MemorySummarizer } = require('./memory/summarizer');
const { DynamicRoleSystem } = require('./cognition/dynamic-roles');
const { QuantumReasoner } = require('./cognition/quantum-reasoner');
const { CognitiveStateModulator } = require('./cognition/state-modulator');
const { ThermodynamicController } = require('./cognition/thermodynamic');
const { ChaoticEngine } = require('./creativity/chaotic-engine');
const { IntrinsicGoalSystem } = require('./goals/intrinsic-goals');
const { GoalCaptureSystem } = require('./goals/goal-capture');
const { ReflectionAnalyzer } = require('./reflection/analyzer');
const { EnvironmentInterface } = require('./environment/interface');
const { TemporalRhythms } = require('./temporal/rhythms');
const { FocusExplorationOscillator } = require('./temporal/oscillator');
const { MetaCoordinator } = require('./coordinator/meta-coordinator');
const { ActionCoordinator } = require('./coordinator/action-coordinator');
const { AgentExecutor } = require('./agents/agent-executor');
const { ResearchAgent } = require('./agents/research-agent');
const { AnalysisAgent } = require('./agents/analysis-agent');
const { SynthesisAgent } = require('./agents/synthesis-agent');
const { ExplorationAgent } = require('./agents/exploration-agent');
const { CodebaseExplorationAgent } = require('./agents/codebase-exploration-agent');
const { CodeExecutionAgent } = require('./agents/code-execution-agent');
const { QualityAssuranceAgent } = require('./agents/quality-assurance-agent');
const { PlanningAgent } = require('./agents/planning-agent');
const { IntegrationAgent } = require('./agents/integration-agent');
const { DocumentCreationAgent } = require('./agents/document-creation-agent');
const { CodeCreationAgent } = require('./agents/code-creation-agent');
const { CompletionAgent } = require('./agents/completion-agent');
const { DocumentAnalysisAgent } = require('./agents/document-analysis-agent');
const { ConsistencyAgent } = require('./agents/consistency-agent');
const { SpecializedBinaryAgent } = require('./agents/specialized-binary-agent');
const { DocumentCompilerAgent } = require('./agents/document-compiler-agent');
const { IDEAgent } = require('./agents/ide-agent');
const { AutomationAgent } = require('./agents/automation-agent');
const { DataAcquisitionAgent } = require('./agents/data-acquisition-agent');
const { DataPipelineAgent } = require('./agents/data-pipeline-agent');
const { InfrastructureAgent } = require('./agents/infrastructure-agent');
const { TrajectoryForkSystem } = require('./cognition/trajectory-fork');
const { TopicQueueSystem } = require('./goals/topic-queue');
const { Orchestrator } = require('./core/orchestrator');
const { GuidedModePlanner } = require('./core/guided-mode-planner');
const { UnifiedClient } = require('./core/unified-client');
const { SimpleLogger } = require('../lib/simple-logger');
const { GoalAllocator } = require('./cluster/goal-allocator');

// Clustering support
const { ClusterAwareMemory } = require('./cluster/cluster-aware-memory');
const ClusterStateStore = require('./cluster/cluster-state-store');
const RedisStateStore = require('./cluster/backends/redis-state-store');
const FilesystemStateStore = require('./cluster/backends/filesystem-state-store');
const { RedisClusterOrchestrator } = require('./cluster/orchestrators/redis-cluster-orchestrator');
const { FilesystemClusterOrchestrator } = require('./cluster/orchestrators/filesystem-cluster-orchestrator');
const { ClusterCoordinator } = require('./cluster/cluster-coordinator');

const logger = new SimpleLogger('info');

// Optional: Initialize split-screen TUI dashboard
let tuiDashboard = null;
if (process.env.COSMO_TUI !== 'false' && process.env.COSMO_TUI_SPLIT === 'true') {
  try {
    const { TUIDashboard } = require('../lib/tui-dashboard');
    tuiDashboard = new TUIDashboard(logger);
    logger.attachDashboard(tuiDashboard);

    // Dashboard is now active - it will handle all output
    // Skip the startup banner as dashboard will show it
  } catch (e) {
    // Graceful fallback if dashboard initialization fails
    console.error('TUI Dashboard failed to initialize, falling back to enhanced logs:', e.message);
    tuiDashboard = null;
  }
}

/**
 * Wait for specific planning agents to complete before starting cognitive loop
 */
async function waitForPlanningAgents(agentExecutor, agentIds, options = {}) {
  const { timeoutMs = 300000, logger } = options;
  const startTime = Date.now();

  logger.info(`⏳ Waiting for ${agentIds.length} planning agents to complete...`, {
    agentIds: agentIds.slice(0, 3), // Log first 3 for debugging
    timeoutMs
  });

  // Emit waiting event
  if (global.eventEmitter) {
    global.eventEmitter.emit('planning_wait_started', {
      agentIds,
      timeoutMs,
      timestamp: new Date().toISOString()
    });
  }

  while (agentIds.length > 0 && (Date.now() - startTime) < timeoutMs) {
    // Process any completed results to update the queue
    await agentExecutor.processCompletedResults();

    // Check if our agents have completed
    const pendingResults = agentExecutor.resultsQueue.getPending();
    const completedIds = pendingResults
      .filter(result => agentIds.includes(result.agentId))
      .map(result => result.agentId);

    // Remove completed agents from wait list
    const remainingBefore = agentIds.length;
    agentIds = agentIds.filter(id => !completedIds.includes(id));
    const completedCount = remainingBefore - agentIds.length;

    if (completedCount > 0) {
      logger.info(`✅ ${completedCount} planning agents completed, ${agentIds.length} remaining`, {
        completedThisCheck: completedCount,
        remaining: agentIds.length
      });
    }

    if (agentIds.length > 0) {
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const elapsed = Date.now() - startTime;
  if (agentIds.length > 0) {
    logger.warn(`⚠️ Timeout waiting for ${agentIds.length} planning agents after ${elapsed}ms`, {
      remainingAgentIds: agentIds.slice(0, 5), // Log first 5 remaining
      timeoutMs
    });

    // Emit timeout event
    if (global.eventEmitter) {
      global.eventEmitter.emit('planning_wait_timeout', {
        remainingAgentIds: agentIds,
        elapsedMs: elapsed,
        timeoutMs,
        timestamp: new Date().toISOString()
      });
    }
  } else {
    logger.info(`✅ All planning agents completed in ${elapsed}ms`);

    // Emit completion event
    if (global.eventEmitter) {
      global.eventEmitter.emit('planning_wait_completed', {
        elapsedMs: elapsed,
        timestamp: new Date().toISOString()
      });
    }
  }
}

async function main() {
  // Only show banner if not using split-screen dashboard
  if (!tuiDashboard) {
    logger.info('╔══════════════════════════════════════════════════╗');
    logger.info('║   COSMO - The Autonomous Brain                  ║');
    logger.info('║   Portable AI Research System                   ║');
    logger.info('╚══════════════════════════════════════════════════╝');
    logger.info('');
  }
  logger.info('System Capabilities:');
  logger.info('  • GPT-5.2 Multi-Tier Reasoning (xhigh/high/medium/low/none)');
  logger.info('  • Goal Curator (campaigns & synthesis)');
  logger.info('  • Quality Assurance (validation gate)');
  logger.info('  • MCP Bridge (agent system awareness)');
  logger.info('  • Web Search (autonomous research)');
  logger.info('  • Multi-Agent System (see below for details)');
  logger.info('');
  
  // Load configuration
  logger.info('Loading configuration...');
  const configLoader = new ConfigLoader();
  const config = configLoader.load();
  
  // Validate configuration at startup
  const validator = new ConfigValidator(config, logger);
  const validation = validator.validate();
  
  if (!validation.valid) {
    logger.error('Configuration validation failed. Please fix errors before starting.');
    process.exit(1);
  }
  
  // Read clustering environment variables
  const instanceId = process.env.INSTANCE_ID || 'cosmo-1';
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || config.dashboard?.port || 3344);
  const mcpPort = parseInt(process.env.MCP_PORT || process.env.MCP_HTTP_PORT || config.mcp?.server?.port || 3347);
  
  // Override ports in config if environment vars provided
  if (!config.dashboard) config.dashboard = {};
  if (!config.mcp) config.mcp = {};
  if (!config.mcp.server) config.mcp.server = {};
  config.dashboard.port = dashboardPort;
  config.mcp.server.port = mcpPort;
  
  // Update MCP client URL to use correct port
  if (config.mcp.client && config.mcp.client.servers) {
    config.mcp.client.servers.forEach(server => {
      if (server.url && server.url.includes('localhost:3347')) {
        server.url = `http://localhost:${mcpPort}/mcp`;
      }
    });
  }
  
  // Display exploration mode
  const explorationMode = config.architecture.roleSystem.explorationMode || 'autonomous';
  const guidedDomain = config.architecture.roleSystem.guidedFocus?.domain || 'N/A';
  
  logger.info('Configuration loaded', {
    instanceId,
    ports: { dashboard: dashboardPort, mcp: mcpPort },
    clusterEnabled: config.cluster?.enabled || false,
    clusterBackend: config.cluster?.backend || 'N/A',
    models: {
      primary: config.models.primary,
      fast: config.models.fast,
      nano: config.models.nano
    },
    webSearch: config.models.enableWebSearch,
    extendedReasoning: config.models.enableExtendedReasoning
  });
  
  logger.info('');
  logger.info('🧠 Exploration Mode: ' + explorationMode.toUpperCase());
  if (explorationMode === 'guided') {
    logger.info('   Domain Focus: ' + guidedDomain);
    logger.info('   (Edit phase2/config.yaml to change)');
  } else {
    logger.info('   (Open-ended autonomous exploration)');
  }
  logger.info('');
  
  // Initialize all subsystems
  logger.info('');
  logger.info('Initializing subsystems...');
  
  // Initialize PathResolver FIRST - all other subsystems may need it
  // PRODUCTION: Runtime path set by unified server per user/run (COSMO_RUNTIME_PATH)
  // FALLBACK: Use engine/runtime symlink for local development
  const runtimeRoot = process.env.COSMO_RUNTIME_PATH || 
                      path.resolve(__dirname, '..', 'runtime');
  
  // Log which mode we're in for debugging
  if (process.env.COSMO_RUNTIME_PATH) {
    logger.info('🔒 Runtime path from environment (multi-tenant):', process.env.COSMO_RUNTIME_PATH);
  } else {
    logger.info('🔗 Runtime path from symlink (local dev):', runtimeRoot);
  }
  
  // Ensure MCP allowed paths are absolute and match what we'll use
  // PRODUCTION: Resolve relative to runtimeRoot (user-specific path)
  // Extract from correct config structure: mcp.client.servers[0].allowedPaths
  if (config.mcp?.client?.servers) {
    config.mcp.client.servers.forEach(server => {
      if (server.allowedPaths && Array.isArray(server.allowedPaths)) {
        server.allowedPaths = server.allowedPaths.map(p => {
          if (path.isAbsolute(p)) return p;
          // Resolve relative paths against runtimeRoot (not engine root)
          // This ensures MCP sees user-specific outputs/exports
          if (p.startsWith('runtime/')) {
            return path.join(runtimeRoot, p.replace('runtime/', ''));
          }
          return path.resolve(runtimeRoot, p);
        });
      }
    });
  }
  
  // Set runtime root in config for all subsystems
  config.runtimeRoot = runtimeRoot;
  config.logsDir = runtimeRoot; // Ensure consistency
  
  const pathResolver = new PathResolver(config, logger);
  logger.info('✅ Path resolver initialized', pathResolver.getDiagnostics());
  
  const baseMemory = new NetworkMemory(config.architecture.memory, logger);
  logger.info('✅ Network memory graph initialized');

  const clusterMemoryManager = new ClusterAwareMemory(baseMemory, {
    config,
    logger,
    instanceId,
    clusterEnabled: config.cluster?.enabled === true
  });
  const memory = clusterMemoryManager.getInterface();
  logger.info(`✅ Cluster-aware memory wrapper initialized (${clusterMemoryManager.isClusterEnabled() ? 'cluster mode' : 'local mode'})`);
  
  const summarizer = new MemorySummarizer(config.architecture, logger, config);
  logger.info('✅ Memory summarizer (GPT-5.2) initialized');
  
  const roles = new DynamicRoleSystem(config.architecture, logger, config);
  logger.info('✅ Dynamic role system (GPT-5.2) initialized');
  
  const quantum = new QuantumReasoner(config.architecture, logger, config);
  logger.info('✅ Quantum reasoner (GPT-5.2) initialized');
  
  const stateModulator = new CognitiveStateModulator(config.architecture, logger);
  logger.info('✅ Cognitive state modulator initialized');
  
  const thermodynamic = new ThermodynamicController(config.architecture, logger);
  logger.info('✅ Thermodynamic controller initialized');
  
  const chaotic = new ChaoticEngine(config.architecture, logger);
  logger.info('✅ Chaotic creativity engine initialized');
  
  const goals = new IntrinsicGoalSystem(config.architecture, logger);
  logger.info('✅ Intrinsic goal system initialized');
  
  const goalCapture = new GoalCaptureSystem(logger);
  logger.info('✅ Goal capture system (GPT-5.2) initialized');
  
  const reflection = new ReflectionAnalyzer(config.architecture, logger);
  logger.info('✅ Reflection analyzer (GPT-5.2) initialized');
  
  const environment = new EnvironmentInterface(config.architecture, logger);
  logger.info('✅ Environment interface initialized');
  
  const temporal = new TemporalRhythms(config.architecture, logger);
  logger.info('✅ Temporal rhythms initialized');
  
  const oscillator = new FocusExplorationOscillator(config.architecture, logger);
  logger.info('✅ Focus/Exploration oscillator initialized');
  
  const coordinator = new MetaCoordinator(config, logger, pathResolver);
  await coordinator.initialize();
  
  const actionCoordinator = new ActionCoordinator(config, logger, pathResolver);
  await actionCoordinator.initialize();
  logger.info('✅ Action Coordinator initialized');
  
  // Initialize Agent Executor
  const agentExecutor = new AgentExecutor(
    { memory, goals, pathResolver },
    config,
    logger
  );
  await agentExecutor.initialize();
  
  // Register specialist agent types
  const codingAgentsEnabled = config.coordinator?.enableCodingAgents !== false;

  agentExecutor.registerAgentType('research', ResearchAgent);
  agentExecutor.registerAgentType('analysis', AnalysisAgent);
  agentExecutor.registerAgentType('synthesis', SynthesisAgent);
  agentExecutor.registerAgentType('exploration', ExplorationAgent);
  agentExecutor.registerAgentType('codebase_exploration', CodebaseExplorationAgent);
  agentExecutor.registerAgentType('quality_assurance', QualityAssuranceAgent);
  agentExecutor.registerAgentType('planning', PlanningAgent);
  agentExecutor.registerAgentType('integration', IntegrationAgent);
  agentExecutor.registerAgentType('document_creation', DocumentCreationAgent);
  agentExecutor.registerAgentType('completion', CompletionAgent);
  agentExecutor.registerAgentType('document_analysis', DocumentAnalysisAgent);
  agentExecutor.registerAgentType('consistency', ConsistencyAgent);
  agentExecutor.registerAgentType('specialized_binary', SpecializedBinaryAgent);
  agentExecutor.registerAgentType('document_compiler', DocumentCompilerAgent);

  // Disconfirmation agent - challenges assumptions and tests counter-hypotheses
  const { DisconfirmationAgent } = require('./agents/disconfirmation-agent');
  agentExecutor.registerAgentType('disconfirmation', DisconfirmationAgent);

  if (codingAgentsEnabled) {
    agentExecutor.registerAgentType('code_execution', CodeExecutionAgent);
    agentExecutor.registerAgentType('code_creation', CodeCreationAgent);
  } else {
    logger.info('🔒 Coding agents disabled via configuration');
  }
  
  // IDE Agent - codebase modification specialist
  if (config.ide?.enabled !== false) {
    agentExecutor.registerAgentType('ide', IDEAgent);
    logger.info('✅ IDE agent registered');
  }
  
  // Experimental agents (local OS autonomy) - requires explicit enable
  if (config.experimental?.enabled) {
    logger.info('🧪 Experimental mode enabled - validating requirements...');
    
    // Validate that experimental agent can be initialized
    try {
      const { ExperimentalAgent } = require('./agents/experimental-agent');
      agentExecutor.registerAgentType('experimental', ExperimentalAgent);
      
      logger.info('✅ Experimental agent registered', {
        requiresApproval: config.experimental.approval?.required !== false,
        maxTime: Math.min(config.experimental.limits?.time_sec || 600, 900),
        maxActions: Math.min(config.experimental.limits?.actions || 50, 200),
        allowedDomains: (config.experimental.network?.allow || ['localhost']).join(', ')
      });
    } catch (error) {
      logger.error('╔════════════════════════════════════════════════════╗');
      logger.error('║  EXPERIMENTAL AGENT INITIALIZATION FAILED         ║');
      logger.error('╚════════════════════════════════════════════════════╝');
      logger.error('');
      logger.error('Error:', error.message);
      logger.error('');
      logger.error('Required dependencies:');
      logger.error('  npm install @nut-tree-fork/nut-js screenshot-desktop');
      logger.error('');
      logger.error('Continuing without experimental agent...');
      logger.error('');
    }
  } else {
    logger.debug('Experimental agents disabled (experimental.enabled not set)');
  }

  // Automation agent — general-purpose OS automation (successor to ExperimentalAgent)
  agentExecutor.registerAgentType('automation', AutomationAgent);

  // Data acquisition agent — web scraping, API consumption, file downloading
  agentExecutor.registerAgentType('dataacquisition', DataAcquisitionAgent);

  // Data pipeline agent — ETL, database creation, validation, export
  agentExecutor.registerAgentType('datapipeline', DataPipelineAgent);

  // Infrastructure agent — container management, service setup, environment provisioning
  agentExecutor.registerAgentType('infrastructure', InfrastructureAgent);

  logger.info('✅ Specialist agents registered', {
    types: Array.from(agentExecutor.agentTypes.keys()),
    count: agentExecutor.agentTypes.size
  });
  
  // Initialize Trajectory Fork System
  const forkConfig = {
    ...config,
    forking: {
      maxConcurrent: 3,
      maxDepth: 2,
      cycleLimit: 5,
      surpriseThreshold: 0.35, // Achievable threshold (max surprise is ~0.5)
      uncertaintyThreshold: 0.6
    }
  };
  const forkSystem = new TrajectoryForkSystem(
    forkConfig,
    { memory, quantum, goals },
    logger
  );
  logger.info('✅ Trajectory fork system initialized');
  
  // Initialize Topic Queue System
  const topicQueue = new TopicQueueSystem(
    { ...config, logsDir: runtimeRoot }, // Use runtimeRoot (user-specific path)
    goals,
    logger
  );
  await topicQueue.initialize();
  logger.info('✅ Topic queue system initialized');
  
  // Initialize clustering if enabled
  let clusterStateStore = null;
  let clusterOrchestrator = null;
  let goalAllocator = null;
  let clusterCoordinator = null;
  
  // Always initialize FilesystemStateStore (even in single-instance mode for Plan/Task storage)
  if (!config.cluster || !config.cluster.enabled) {
    // Single-instance mode: use local FilesystemStateStore
    logger.info('');
    logger.info('📦 Initializing local state store (single-instance mode)...');
    
    try {
      const fsConfig = {
        instanceId: config.instanceId || 'cosmo-1',
        instanceCount: 1,
        fsRoot: runtimeRoot, // Use runtimeRoot (user-specific path from environment)
        stateStore: {
          compressionThreshold: 102400
        }
      };
      
      const fsBackend = new FilesystemStateStore(fsConfig, logger);
      clusterStateStore = new ClusterStateStore(fsConfig, fsBackend);
      await clusterStateStore.connect();
      
      logger.info('✅ Local state store initialized', {
        fsRoot: fsConfig.fsRoot,
        instanceId: fsConfig.instanceId
      });
    } catch (error) {
      logger.error('❌ Failed to initialize local state store', {
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Local state store initialization failed: ${error.message}`);
    }
  } else if (config.cluster && config.cluster.enabled) {
    logger.info('');
    logger.info('🌐 Initializing cluster backend...');
    
    const backend = config.cluster.backend || 'redis';
    const clusterConfig = {
      ...config.cluster,
      instanceId,
      instanceCount: config.cluster.instanceCount || 3,
      stateStore: {
        url: backend === 'redis' ? (config.cluster.redis?.url || 'redis://localhost:6379') : null,
        compressionThreshold: config.cluster.stateStore?.compressionThreshold || 102400
      },
      fsRoot: config.cluster.filesystem?.root || '/tmp/cosmo_cluster',
      orchestrator: {
        leaderLeaseMs: 15000,
        renewIntervalMs: 5000
      }
    };
    
    try {
      if (backend === 'redis') {
        logger.info('  Backend: Redis (active/active CRDT)');
        const redisBackend = new RedisStateStore(clusterConfig, logger);
        clusterStateStore = new ClusterStateStore(clusterConfig, redisBackend);
        await clusterStateStore.connect();
        
        // Create Redis orchestrator
        clusterOrchestrator = new RedisClusterOrchestrator(clusterConfig, redisBackend, logger);
        await clusterOrchestrator.initialize();

        // Wire cluster-aware memory to backend
        clusterMemoryManager.attachStateStore(clusterStateStore);
        clusterMemoryManager.setClusterEnabled(true);
        
        // Try to acquire leadership
        await clusterOrchestrator.tryAcquireLeadership();
        
        logger.info('✅ Redis cluster initialized', {
          instanceId,
          isLeader: clusterOrchestrator.isLeader
        });

        goalAllocator = new GoalAllocator(config, clusterStateStore, instanceId, logger);
      } else if (backend === 'filesystem') {
        logger.info('  Backend: Filesystem (single-writer lease)');
        const fsBackend = new FilesystemStateStore(clusterConfig, logger);
        clusterStateStore = new ClusterStateStore(clusterConfig, fsBackend);
        await clusterStateStore.connect();
        
        // Create Filesystem orchestrator
        clusterOrchestrator = new FilesystemClusterOrchestrator(clusterConfig, fsBackend, logger);
        await clusterOrchestrator.initialize();

        // Wire cluster-aware memory to backend
        clusterMemoryManager.attachStateStore(clusterStateStore);
        clusterMemoryManager.setClusterEnabled(true);
        
        // Try to acquire leadership
        await clusterOrchestrator.tryAcquireLeadership();
        
        logger.info('✅ Filesystem cluster initialized', {
          instanceId,
          fsRoot: clusterConfig.fsRoot,
          isLeader: clusterOrchestrator.isLeader
        });

        goalAllocator = new GoalAllocator(config, clusterStateStore, instanceId, logger);
      } else {
        throw new Error(`Unknown cluster backend: ${backend}`);
      }
    } catch (error) {
      logger.error('❌ Cluster initialization failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  if (goalAllocator) {
    goals.setGoalAllocator(goalAllocator);
  } else {
    goals.setGoalAllocator(null);
  }

  if (clusterStateStore) {
    clusterCoordinator = new ClusterCoordinator({
      stateStore: clusterStateStore,
      instanceId,
      clusterSize: config.cluster?.instanceCount || 1,
      config: config.cluster,
      logger
    });
    await clusterCoordinator.initialize();
    logger.info('✅ Cluster coordinator initialized', {
      instanceId,
      clusterSize: clusterCoordinator.clusterSize || config.cluster?.instanceCount || 1
    });

    if (agentExecutor?.setClusterReviewContext) {
      agentExecutor.setClusterReviewContext(clusterStateStore, instanceId);
    }
  }
  
  // Inject phase2b subsystems into coordinator for full system awareness
  // Fixes existing bug where coordinator references this.phase2bSubsystems but it's never set
  coordinator.phase2bSubsystems = {
    memory: memory,
    agentExecutor: agentExecutor,
    clusterStateStore: clusterStateStore,
    goals: goals
  };
  logger.info('✅ Meta-Coordinator subsystems connected', {
    hasMemory: true,
    hasAgentExecutor: true,
    hasStateStore: !!clusterStateStore,
    hasGoals: true
  });
  
  // Create GPT-5.2 orchestrator
  logger.info('');
  logger.info('Creating GPT-5.2 orchestrator...');
  
  const orchestrator = new Orchestrator(
    config,
    {
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
      clusterStateStore,      // Pass cluster state store
      clusterOrchestrator,    // Pass cluster orchestrator
      goalAllocator,
      clusterCoordinator
    },
    logger
  );
  
  await orchestrator.initialize();
  
  // VOICE: Wire orchestrator to coordinator for voice capability
  if (coordinator) {
    coordinator.orchestrator = orchestrator;
  }
  
  // Store cluster components for shutdown
  orchestrator.clusterStateStore = clusterStateStore;
  orchestrator.clusterOrchestrator = clusterOrchestrator;
  orchestrator.goalAllocator = goalAllocator;
  orchestrator.clusterCoordinator = clusterCoordinator;
  
  // Register orchestrator globally so dashboard can access it
  global.cosmOrchestrator = orchestrator;
  logger.info('✅ Orchestrator registered globally for dashboard access');
  
  // Wire evaluation framework to dashboard
  if (orchestrator.evaluation) {
    if (global.dashboardServer) {
      global.dashboardServer.setEvaluationFramework(orchestrator.evaluation);
      logger.info('✅ Evaluation framework wired to dashboard');
    }
  }
  
  // Wire orchestrator to dashboard for query command center
  if (global.dashboardServer) {
    global.dashboardServer.setOrchestrator(orchestrator);
    logger.info('✅ Query Command Center: Actions enabled');

    // Wire logger to dashboard server (enables console streaming)
    logger.attachWebDashboard(global.dashboardServer);
    logger.info('✅ Console streaming to web dashboard enabled');
  }

  // Start real-time WebSocket server for Watch Panel
  const realtimePort = parseInt(process.env.REALTIME_PORT || config.realtime?.port || 3400);
  try {
    const { RealtimeServer } = require('./realtime/websocket-server');
    const realtimeServer = new RealtimeServer(realtimePort, logger);
    await realtimeServer.start();
    global.realtimeServer = realtimeServer;
    orchestrator.realtimeServer = realtimeServer;
  } catch (error) {
    logger.warn('⚠️  Realtime WebSocket server failed to start (non-fatal)', {
      port: realtimePort,
      error: error.message
    });
  }

  // Initiate guided mission if in guided mode
  // Coordinator owns mission lifecycle from startup
  // CRITICAL: Skip if guidedMissionPlan was already restored from state (Continue flow)
  if (config.architecture?.roleSystem?.explorationMode === 'guided') {
    if (orchestrator.guidedMissionPlan) {
      // Plan was restored from state.json.gz - this is a CONTINUE, not a new run
      // Check if the user changed context/direction on continue
      const currentContext = (config.architecture?.roleSystem?.guidedFocus?.context || '').trim();
      const currentDomain = (config.architecture?.roleSystem?.guidedFocus?.domain || '').trim();
      const plan = orchestrator.guidedMissionPlan;
      const planContext = (plan._sourceContext || plan.context || plan.researchContext || '').trim();
      const planDomain = (plan._sourceDomain || plan.title || '').trim();
      const contextChanged = currentContext !== planContext;
      const domainChanged = currentDomain !== planDomain;

      if (contextChanged || domainChanged) {
        logger.info('');
        logger.info('🔄 Research direction changed on continue — regenerating plan');
        logger.info(`   Old: ${planDomain.substring(0, 60)} / ${planContext.substring(0, 60)}`);
        logger.info(`   New: ${currentDomain.substring(0, 60)} / ${currentContext.substring(0, 60)}`);
        logger.info('');
        // Clear restored plan so initiateMission() runs and the planner regenerates
        orchestrator.guidedMissionPlan = null;
      } else {
        logger.info('');
        logger.info('📋 Guided mission plan restored from state (Continue mode)');
        logger.info('   Skipping mission generation - resuming existing plan');
        logger.info('');

        // Restore completion tracker if needed
        if (!orchestrator.completionTracker) {
          const { CompletionTracker } = require('./core/completion-tracker');
          orchestrator.completionTracker = new CompletionTracker(orchestrator.guidedMissionPlan, logger);
        }
      }
    }

    if (!orchestrator.guidedMissionPlan) {
      // No existing plan - this is a NEW run, generate mission plan

      // MERGED BRAIN FIX (Jan 23, 2026): Clear stale planProgressEvents before generating new plan
      // When merging brains or starting fresh, old plan events should not pollute new plan's progress
      if (orchestrator.planProgressEvents?.length > 0) {
        logger.info('🧹 Clearing stale planProgressEvents for new guided plan', {
          staleEventCount: orchestrator.planProgressEvents.length
        });
        orchestrator.planProgressEvents = [];
      }

      const result = await coordinator.initiateMission({
        guidedFocus: config.architecture.roleSystem.guidedFocus,
        subsystems: {
          agentExecutor,
          goals,
          clusterStateStore: orchestrator.clusterStateStore,
          pathResolver
        }
      });

      const plan = result?.plan || result;
      const planningAgentIds = result?.planningAgentIds || [];

      // Wait for planning agents to complete before starting orchestrator
      if (planningAgentIds && planningAgentIds.length > 0) {
        await waitForPlanningAgents(agentExecutor, planningAgentIds, {
          timeoutMs: 300000, // 5 minutes
          logger
        });
      }

      // Store plan in orchestrator for reference
      if (plan) {
        // Create completion tracker
        const { CompletionTracker } = require('./core/completion-tracker');
        orchestrator.completionTracker = new CompletionTracker(plan, logger);

        orchestrator.guidedMissionPlan = plan;
      }
    }
  }
  
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║   Phase 2B GPT-5.2 System Ready                 ║');
  logger.info('╚══════════════════════════════════════════════════╝');
  logger.info('');
  logger.info('GPT-5.2 Enhanced Features:');
  logger.info('');
  logger.info('CORE PHASE 2B:');
  logger.info('  • Network Memory (spreading activation, Hebbian)');
  logger.info('  • Dynamic Roles (self-spawning, evolving)');
  logger.info('  • Quantum Reasoning (5 parallel branches)');
  logger.info('  • Chaotic Creativity (edge-of-chaos RNN)');
  logger.info('  • Intrinsic Goals (self-discovered)');
  logger.info('  • Cognitive State (mood, curiosity, energy)');
  logger.info('  • Memory Summarization & Consolidation');
  logger.info('  • Automatic Goal Capture');
  logger.info('  • Focus/Exploration Oscillations');
  logger.info('  • Deep Sleep with Dreams');
  logger.info('');
  logger.info('GPT-5.2 ENHANCEMENTS:');
  logger.info('  ⭐ Extended Reasoning (see AI thinking process)');
  logger.info('  🌐 Web Search (curiosity role + quantum branches)');
  logger.info('  ⚡ Optimized Models (right model for each task)');
  logger.info('  🔧 Responses API (modern format with tools)');
  logger.info('');
  logger.info('STRATEGIC COORDINATION:');
  const reviewPeriod = config.coordinator?.reviewCyclePeriod || 50;
  const curatorPeriod = config.curator?.curationCyclePeriod || 20;
  const maxConcurrent = config.coordinator?.maxConcurrent || 5;
  const agentTypes = Array.from(agentExecutor.agentTypes.keys());
  logger.info(`  🎯 Meta-Coordinator (reviews every ${reviewPeriod} cycles)`);
  logger.info(`  🎨 Goal Curator (campaigns & synthesis every ${curatorPeriod} cycles)`);
  logger.info(`  🤖 Specialist Agent Swarm (${agentTypes.length} types, ${maxConcurrent} concurrent)`);
  agentTypes.forEach(type => {
    logger.info(`    - ${type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ')} Agent`);
  });
  logger.info('  🌐 MCP Bridge (all agents system-aware via MCP tools)');
  logger.info('');
  logger.info('ADVANCED FEATURES:');
  logger.info('  🔱 Trajectory Forking (spawn sub-explorations)');
  logger.info('  📥 Topic Queue (inject exploration topics)');
  logger.info('');
  logger.info('Logs directory: runtime/');
  logger.info('Topic queue file: runtime/topics-queue.json');
  logger.info('');
  logger.info('Starting cognitive loop...');
  logger.info('');
  
  // Pass TUI dashboard to orchestrator (if active)
  if (tuiDashboard) {
    orchestrator.tuiDashboard = tuiDashboard;
  }
  
  // Graceful shutdown
  // REMOVED: Graceful shutdown handlers are now managed by GracefulShutdownHandler
  // Do NOT add duplicate process.on('SIGINT'/'SIGTERM') handlers here
  // This was causing duplicate shutdown execution (state saved twice, etc)
  // GracefulShutdownHandler is registered in orchestrator.initialize() at line 162
  // and handles all signal-based shutdown with proper idempotency
  // Start
  await orchestrator.start();
}

// Only auto-run main() if this is the entry point (not imported)
if (require.main === module) {
  main().catch(error => {
    console.error('Phase 2B GPT-5.2 initialization failed:', error);
    console.error(error.stack);
    process.exit(1);
  });
}

/**
 * Factory function for creating isolated orchestrator contexts.
 * Used by OrchestratorManager for multi-tenant operation.
 *
 * @param {Object} options - Context options
 * @param {string} options.contextId - Unique context identifier
 * @param {string} options.runtimePath - Path for this context's files
 * @param {Object} options.ports - Port allocation { realtime, dashboard, mcp, mcpDashboard }
 * @param {Object} options.config - Config overrides (merged with base config)
 * @returns {Promise<{ orchestrator, subsystems, realtimeServer, eventEmitter }>}
 */
async function createOrchestratorContext(options) {
  const { contextId, runtimePath, ports, config: configOverrides } = options;

  // Create context-specific logger
  const contextLogger = new SimpleLogger('info');
  contextLogger.info(`[Context ${contextId}] Initializing orchestrator context...`);

  // Load base configuration
  const configLoader = new ConfigLoader();
  const baseConfig = configLoader.load();

  // Apply overrides
  const config = {
    ...baseConfig,
    ...configOverrides,
    runtimeRoot: runtimePath,
    logsDir: runtimePath
  };

  // Override ports if provided
  if (ports) {
    if (!config.dashboard) config.dashboard = {};
    if (!config.mcp) config.mcp = {};
    if (!config.mcp.server) config.mcp.server = {};
    if (!config.realtime) config.realtime = {};

    config.dashboard.port = ports.dashboard;
    config.mcp.server.port = ports.mcp;
    config.realtime.port = ports.realtime;
  }

  // Validate configuration
  const validator = new ConfigValidator(config, contextLogger);
  const validation = validator.validate();
  if (!validation.valid) {
    throw new Error(`Configuration validation failed for context ${contextId}`);
  }

  // Initialize PathResolver with context-specific runtime path
  const pathResolver = new PathResolver(config, contextLogger);
  contextLogger.info(`[Context ${contextId}] Path resolver initialized`, pathResolver.getDiagnostics());

  // Initialize memory subsystems
  const baseMemory = new NetworkMemory(config.architecture.memory, contextLogger);
  const clusterMemoryManager = new ClusterAwareMemory(baseMemory, {
    config,
    logger: contextLogger,
    instanceId: contextId,
    clusterEnabled: false // Single-context mode
  });
  const memory = clusterMemoryManager.getInterface();

  // Initialize other subsystems
  const summarizer = new MemorySummarizer(config.architecture, contextLogger, config);
  const roles = new DynamicRoleSystem(config.architecture, contextLogger, config);
  const quantum = new QuantumReasoner(config.architecture, contextLogger, config);
  const stateModulator = new CognitiveStateModulator(config.architecture, contextLogger);
  const thermodynamic = new ThermodynamicController(config.architecture, contextLogger);
  const chaotic = new ChaoticEngine(config.architecture, contextLogger);
  const goals = new IntrinsicGoalSystem(config.architecture, contextLogger);
  const goalCapture = new GoalCaptureSystem(contextLogger);
  const reflection = new ReflectionAnalyzer(config.architecture, contextLogger);
  const environment = new EnvironmentInterface(config.architecture, contextLogger);
  const temporal = new TemporalRhythms(config.architecture, contextLogger);
  const oscillator = new FocusExplorationOscillator(config, contextLogger);
  const forkSystem = new TrajectoryForkSystem(config, { memory, quantum, goals }, contextLogger);
  const topicQueue = new TopicQueueSystem(config.architecture, goals, contextLogger);

  // Initialize cluster state store for plan persistence (filesystem backend)
  // This enables structured plans with phases/milestones/tasks for guided mode
  // CRITICAL FIX: Multi-tenant contexts need this for task assignment and deliverable tracking
  let clusterStateStore = null;
  try {
    const fsStateStoreConfig = {
      fsRoot: runtimePath, // Use the context's runtime path
      instanceId: contextId,
      readOnly: false
    };
    contextLogger.info(`[Context ${contextId}] 📦 Initializing ClusterStateStore...`, { fsRoot: runtimePath });
    const { FilesystemStateStore } = require('./cluster/backends/filesystem-state-store');
    const { ClusterStateStore } = require('./cluster/cluster-state-store');
    const fsBackend = new FilesystemStateStore(fsStateStoreConfig, contextLogger);
    await fsBackend.connect();
    clusterStateStore = new ClusterStateStore(fsStateStoreConfig, fsBackend);
    await clusterStateStore.connect();
    contextLogger.info(`[Context ${contextId}] ✅ ClusterStateStore initialized (filesystem backend)`, { fsRoot: runtimePath });
  } catch (stateStoreError) {
    contextLogger.error(`[Context ${contextId}] ⚠️ ClusterStateStore initialization failed (non-fatal)`, { 
      error: stateStoreError.message,
      stack: stateStoreError.stack?.split('\n').slice(0, 3).join('\n')
    });
    // Continue without state store - structured plans won't be persisted
  }

  // Get context-aware event emitter FIRST - before coordinator and agentExecutor
  // This is critical for multi-tenant event isolation
  let eventEmitter = null;
  try {
    const { contextEventRegistry } = require('./realtime/context-events');
    eventEmitter = contextEventRegistry.getEmitter(contextId);
    contextLogger.info(`[Context ${contextId}] Context-aware event emitter created`);
  } catch (e) {
    contextLogger.warn(`[Context ${contextId}] Context events not available, using singleton`);
  }

  // Initialize coordinator with eventEmitter
  const coordinator = new MetaCoordinator(config, contextLogger, pathResolver, null, eventEmitter);
  
  const actionCoordinator = new ActionCoordinator(config, contextLogger, pathResolver, null, eventEmitter);
  await actionCoordinator.initialize();
  contextLogger.info(`[Context ${contextId}] ✅ Action Coordinator initialized`);

  // Initialize agent executor with eventEmitter in phase2bSubsystems
  const agentExecutor = new AgentExecutor(
    { memory, goals, pathResolver, eventEmitter },
    config,
    contextLogger
  );
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
  const { DisconfirmationAgent: DisconfirmationAgentMT } = require('./agents/disconfirmation-agent');
  agentExecutor.registerAgentType('disconfirmation', DisconfirmationAgentMT);

  // Automation agent — general-purpose OS automation
  agentExecutor.registerAgentType('automation', AutomationAgent);

  // Data acquisition agent — web scraping, API consumption, file downloading
  agentExecutor.registerAgentType('dataacquisition', DataAcquisitionAgent);

  // Data pipeline agent — ETL, database creation, validation, export
  agentExecutor.registerAgentType('datapipeline', DataPipelineAgent);

  // Infrastructure agent — container management, service setup, environment provisioning
  agentExecutor.registerAgentType('infrastructure', InfrastructureAgent);

  // CRITICAL FIX: Wire ClusterStateStore to AgentExecutor for artifact registration
  // This enables registerTaskArtifactsFromAgentRun() to work properly
  if (clusterStateStore && agentExecutor?.setClusterReviewContext) {
    agentExecutor.setClusterReviewContext(clusterStateStore, contextId);
    contextLogger.info(`[Context ${contextId}] ✅ AgentExecutor cluster context configured`);
  }

  // Wire coordinator subsystems (including eventEmitter and clusterStateStore)
  coordinator.phase2bSubsystems = {
    memory,
    agentExecutor,
    clusterStateStore, // Now properly initialized (not null)
    goals,
    eventEmitter
  };

  // Create subsystems object (includes eventEmitter and clusterStateStore for multi-tenant support)
  const subsystems = {
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
    actionCoordinator,
    agentExecutor,
    forkSystem,
    topicQueue,
    clusterStateStore, // Now properly initialized (not null)
    clusterOrchestrator: null,
    goalAllocator: null,
    clusterCoordinator: null,
    eventEmitter  // Multi-tenant event emitter
  };

  // Add contextId to config for orchestrator access
  config.contextId = contextId;

  // Create orchestrator with injected eventEmitter
  const orchestrator = new Orchestrator(config, subsystems, contextLogger);
  await orchestrator.initialize();

  // VOICE: Wire orchestrator to coordinator for voice capability
  if (coordinator) {
    coordinator.orchestrator = orchestrator;
  }

  // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Wire task state queue to AgentExecutor
  // This must happen AFTER orchestrator.initialize() creates the queue
  if (orchestrator.taskStateQueue && agentExecutor) {
    agentExecutor.taskStateQueue = orchestrator.taskStateQueue;
    contextLogger.info(`[Context ${contextId}] ✅ Task state queue wired to AgentExecutor`);
  }

  contextLogger.info(`[Context ${contextId}] Orchestrator initialized`);

  // Start realtime server if ports provided
  let realtimeServer = null;
  if (ports && ports.realtime) {
    try {
      const { RealtimeServer } = require('./realtime/websocket-server');
      realtimeServer = new RealtimeServer(ports.realtime, contextLogger, {
        contextId,
        legacyMode: false
      });
      await realtimeServer.start();
      orchestrator.realtimeServer = realtimeServer;
      contextLogger.info(`[Context ${contextId}] Realtime server started on port ${ports.realtime}`);
    } catch (error) {
      contextLogger.warn(`[Context ${contextId}] Realtime server failed to start:`, error.message);
    }
  }

  return {
    orchestrator,
    subsystems,
    realtimeServer,
    eventEmitter,
    logger: contextLogger,
    contextId,
    config
  };
}

/**
 * Stop an orchestrator context gracefully
 * @param {Object} context - Context returned by createOrchestratorContext
 */
async function stopOrchestratorContext(context) {
  const { orchestrator, realtimeServer, contextId, logger: contextLogger } = context;

  contextLogger.info(`[Context ${contextId}] Stopping orchestrator context...`);

  // Stop orchestrator
  if (orchestrator) {
    orchestrator.running = false;
    // Give it a moment to finish current cycle
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Stop realtime server
  if (realtimeServer) {
    await realtimeServer.stop();
  }

  // Clean up event emitter
  try {
    const { contextEventRegistry } = require('./realtime/context-events');
    contextEventRegistry.removeEmitter(contextId);
  } catch (e) {
    // Ignore if not available
  }

  contextLogger.info(`[Context ${contextId}] Orchestrator context stopped`);
}

// Export for multi-tenant use
module.exports = {
  createOrchestratorContext,
  stopOrchestratorContext,
  // Export classes for custom usage
  Orchestrator,
  ConfigLoader,
  ConfigValidator,
  PathResolver,
  SimpleLogger
};
