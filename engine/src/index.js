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

  if (Array.isArray(config._instanceOverridesApplied) && config._instanceOverridesApplied.length) {
    logger.info('Applied instance engine model overrides:');
    for (const line of config._instanceOverridesApplied) logger.info('  ' + line);
  }

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
  // COSMO_RUNTIME_DIR env var allows per-instance runtime isolation (cosmo-home multi-family)
  const runtimeRoot = process.env.COSMO_RUNTIME_DIR
    ? path.resolve(process.env.COSMO_RUNTIME_DIR)
    : path.resolve(__dirname, '..', 'runtime');
  
  // Ensure MCP allowed paths are absolute and match what we'll use
  // Extract from correct config structure: mcp.client.servers[0].allowedPaths
  if (config.mcp?.client?.servers) {
    config.mcp.client.servers.forEach(server => {
      if (server.allowedPaths && Array.isArray(server.allowedPaths)) {
        server.allowedPaths = server.allowedPaths.map(p => {
          if (path.isAbsolute(p)) return p;
          return path.resolve(__dirname, '..', p);
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

  if (codingAgentsEnabled) {
    agentExecutor.registerAgentType('code_execution', CodeExecutionAgent);
    agentExecutor.registerAgentType('code_creation', CodeCreationAgent);
  } else {
    logger.info('🔒 Coding agents disabled via configuration');
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
      surpriseThreshold: 0.7,
      uncertaintyThreshold: 0.8
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
    { ...config, logsDir: config.runtimeRoot || path.join(__dirname, '..', 'runtime') },
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
        fsRoot: config.runtimeRoot || path.join(__dirname, '..', 'runtime'),
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

    // Engine events flow to dashboard via WebSocket (port 5001)
    // Dashboard JS connects directly to engine's realtime WebSocket
  }

  // Start real-time WebSocket server for Watch Panel
  const realtimePort = parseInt(process.env.REALTIME_PORT || config.realtime?.port || 3400);
  try {
    const { RealtimeServer } = require('./realtime/websocket-server');
    const realtimeServer = new RealtimeServer(realtimePort, logger);
    await realtimeServer.start();
    global.realtimeServer = realtimeServer;
    orchestrator.realtimeServer = realtimeServer;
    // Wire orchestrator so /admin/feeder/* routes can reach the live feeder
    realtimeServer.setOrchestrator(orchestrator);
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
      logger.info('');
      logger.info('📋 Guided mission plan restored from state (Continue mode)');
      logger.info('   Skipping mission generation - resuming existing plan');
      logger.info('');

      // Restore completion tracker if needed
      if (!orchestrator.completionTracker && orchestrator.guidedMissionPlan) {
        const { CompletionTracker } = require('./core/completion-tracker');
        orchestrator.completionTracker = new CompletionTracker(orchestrator.guidedMissionPlan, logger);
      }
    } else {
      // No existing plan - this is a NEW run, generate mission plan
      // Timeout after 30s so the cognitive loop isn't blocked on a slow/failing LLM
      let plan = null;
      try {
        const missionPromise = coordinator.initiateMission({
          guidedFocus: config.architecture.roleSystem.guidedFocus,
          subsystems: {
            agentExecutor,
            goals,
            clusterStateStore: orchestrator.clusterStateStore,
            pathResolver
          }
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Mission generation timed out after 30s')), 30000)
        );
        plan = await Promise.race([missionPromise, timeoutPromise]);
      } catch (err) {
        logger.warn('⚠️  Mission plan generation failed or timed out, starting without plan', { error: err.message });
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

  // Step 24 — OS-engine channel bus + cognition scaffolds.
  // Phase 0: construct but register no channels. Subsequent phases opt-in
  // via config.osEngine.channels.<class>.enabled. See docs/design/STEP24.
  let channelBus = null;
  let closer = null;
  let decayWorker = null;
  try {
    // Step 24 config lives in config/home.yaml under `osEngine` — the engine
    // ConfigLoader reads its own engine YAML and only touches home.yaml for
    // provider catalog fallback, so osEngine must be loaded directly here.
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const os = require('node:os');
    const home23RepoRoot = path.resolve(__dirname, '..', '..');
    const homeYamlPath = path.join(home23RepoRoot, 'config', 'home.yaml');
    const expandHome = (p) => (typeof p === 'string' && p.startsWith('~')) ? path.join(os.homedir(), p.slice(1)) : p;
    const deepMerge = (a, b) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return b;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
      const out = { ...a };
      for (const k of Object.keys(b)) {
        out[k] = (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) ? deepMerge(a[k], b[k]) : b[k];
      }
      return out;
    };
    let osEngineCfg = {};
    try {
      const raw = yaml.load(fs.readFileSync(homeYamlPath, 'utf8')) || {};
      osEngineCfg = raw.osEngine || {};
      // Overlay per-agent instance config.yaml if present.
      const agentName = process.env.HOME23_AGENT || config.agent?.name;
      if (agentName) {
        const instancePath = path.join(home23RepoRoot, 'instances', agentName, 'config.yaml');
        if (fs.existsSync(instancePath)) {
          try {
            const inst = yaml.load(fs.readFileSync(instancePath, 'utf8')) || {};
            if (inst.osEngine) {
              osEngineCfg = deepMerge(osEngineCfg, inst.osEngine);
            }
          } catch (err) {
            logger.warn?.(`[channels] instance osEngine overlay failed: ${err?.message || err}`);
          }
        }
      }
    } catch (err) {
      logger.warn?.(`[channels] failed to load osEngine from ${homeYamlPath}: ${err?.message || err}`);
    }
    // Mirror onto the engine config so downstream code can reach it.
    config.osEngine = osEngineCfg;

    const { ChannelBus } = await import('./channels/bus.js');
    const { Closer } = await import('./cognition/closer.js');
    const { DecayWorker } = await import('./cognition/decay-worker.js');
    const { NotifyChannel } = await import('./channels/notify/notify-channel.js');
    const channelsDir = path.join(runtimeRoot, 'channels');
    channelBus = new ChannelBus({ persistenceDir: channelsDir, logger });
    closer = new Closer({
      memory,
      goals,
      logger,
      enabled: config.osEngine?.closer?.terminationContractRequired === true,
    });
    // Phase 5: DecayWorker enabled, backed by MemoryIngest (MemoryIngest
    // implements applyDecay against memory-objects.json with file-locking).
    // The 'memory' backend here is a minimal adapter — MemoryIngest is
    // constructed below and re-passed after.
    decayWorker = null;  // will be constructed after memoryIngest below
    // Phase 1: NotifyChannel is always on as the first bus consumer, mirroring
    // the cognition NOTIFY stream into the bus. The harness-side PromoterWorker
    // continues to tail the same file in parallel — this is idempotent.
    const notifyPath = path.join(runtimeRoot, 'notifications.jsonl');
    channelBus.register(new NotifyChannel({ path: notifyPath }));

    // Phase 2: wire bus crystallize events into the memory-objects.json store.
    // MemoryIngest writes with proper-lockfile so the harness MemoryObjectStore
    // can coexist as a reader/writer on the same file.
    const { MemoryIngest } = require('./channels/memory-ingest.js');
    const memoryIngest = new MemoryIngest({ brainDir: runtimeRoot, logger });
    channelBus.on('crystallize', async ({ observation, draft }) => {
      try { await memoryIngest.writeFromObservation(observation, draft); }
      catch (err) { logger.warn?.('[memory-ingest] write failed from bus:', err?.message || err); }
    });

    // Phase 5: activate DecayWorker against MemoryIngest.
    const parseDurMs = (s, fallbackMs) => {
      if (!s) return fallbackMs;
      const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(s).trim());
      if (!m) return fallbackMs;
      const n = parseInt(m[1], 10);
      return n * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[m[2].toLowerCase()];
    };
    decayWorker = new DecayWorker({
      memory: memoryIngest,
      logger,
      enabled: true,
      cadenceMs: parseDurMs(osEngineCfg?.decay?.worker?.cadence, 30 * 60_000),
      halfLife: {
        warning_node:            parseDurMs(osEngineCfg?.decay?.halfLife?.warning_node, 48 * 3600_000),
        surreal_transform:       parseDurMs(osEngineCfg?.decay?.halfLife?.surreal_transform, 24 * 3600_000),
        unfinished_goal_review:  parseDurMs(osEngineCfg?.decay?.halfLife?.unfinished_goal_review, 72 * 3600_000),
      },
    });
    decayWorker.start();
    logger.info(`[decay] worker started (cadence=${Math.round(decayWorker.cadenceMs / 60_000)}m)`);

    // Phase 2: register build + work channels per osEngine config.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const conversationsDir = path.resolve(runtimeRoot, '..', 'conversations');
    const buildCfg = config.osEngine?.channels?.build;
    const workCfg  = config.osEngine?.channels?.work;
    const registered = ['notify.cognition'];

    if (buildCfg?.enabled) {
      const { GitChannel }     = await import('./channels/build/git-channel.js');
      const { GhChannel }      = await import('./channels/build/gh-channel.js');
      const { FsWatchChannel } = await import('./channels/build/fswatch-channel.js');
      channelBus.register(new GitChannel({ repoPath: repoRoot, intervalMs: 60 * 1000 }));
      channelBus.register(new GhChannel({ intervalMs: 5 * 60 * 1000, repo: buildCfg?.gh?.repo }));
      channelBus.register(new FsWatchChannel({ paths: [
        path.join(repoRoot, 'docs', 'design'),
        path.join(repoRoot, 'config'),
        path.join(repoRoot, 'engine', 'src'),
        path.join(repoRoot, 'src'),
      ]}));
      registered.push('build.git', 'build.gh', 'build.fswatch');
    }

    if (workCfg?.enabled) {
      const { AgendaChannel }        = await import('./channels/work/agenda-channel.js');
      const { LiveProblemsChannel }  = await import('./channels/work/live-problems-channel.js');
      const { GoalsChannel }         = await import('./channels/work/goals-channel.js');
      const { CronsChannel }         = await import('./channels/work/crons-channel.js');
      const { HeartbeatChannel }     = await import('./channels/work/heartbeat-channel.js');
      channelBus.register(new AgendaChannel({ path: path.join(runtimeRoot, 'agenda.jsonl') }));
      channelBus.register(new LiveProblemsChannel({ path: path.join(runtimeRoot, 'live-problems.json'), intervalMs: 30 * 1000 }));
      channelBus.register(new GoalsChannel({ goalsDir: path.join(runtimeRoot, 'goals') }));
      channelBus.register(new CronsChannel({ path: path.join(conversationsDir, 'cron-jobs.json'), intervalMs: 60 * 1000 }));
      channelBus.register(new HeartbeatChannel({
        getEngineState: () => ({ at: new Date().toISOString() }),
        intervalMs: 60 * 1000,
      }));
      registered.push('work.agenda', 'work.live-problems', 'work.goals', 'work.crons', 'work.heartbeat');
    }

    // Phase 4: machine + OS channels (opt-in per config).
    const machineCfg = osEngineCfg?.channels?.machine;
    if (machineCfg?.enabled) {
      const { CpuChannel }    = await import('./channels/machine/cpu-channel.js');
      const { MemoryChannel } = await import('./channels/machine/memory-channel.js');
      const { DiskChannel }   = await import('./channels/machine/disk-channel.js');
      channelBus.register(new CpuChannel({ intervalMs: 30 * 1000 }));
      channelBus.register(new MemoryChannel({ intervalMs: 30 * 1000 }));
      channelBus.register(new DiskChannel({ intervalMs: 5 * 60 * 1000 }));
      registered.push('machine.cpu', 'machine.memory', 'machine.disk');
    }
    const osCfg = osEngineCfg?.channels?.os;
    if (osCfg?.enabled) {
      const { Pm2Channel }            = await import('./channels/os/pm2-channel.js');
      const { CronChannel }           = await import('./channels/os/cron-channel.js');
      const { FsWatchHome23Channel }  = await import('./channels/os/fswatch-home23-channel.js');
      channelBus.register(new Pm2Channel({ intervalMs: 30 * 1000 }));
      channelBus.register(new CronChannel({ intervalMs: 5 * 60 * 1000 }));
      channelBus.register(new FsWatchHome23Channel({ repoPath: repoRoot }));
      registered.push('os.pm2', 'os.cron', 'os.fswatch-home23');
    }

    // Phase 3: domain channels (pressure, health, sauna, weather).
    // Enable per-agent via osEngine.channels.domain.readers in home.yaml
    // or instance config.yaml.
    const domainCfg = osEngineCfg?.channels?.domain;
    if (domainCfg?.enabled) {
      const readers = domainCfg.readers || {};
      const { PressureChannel } = await import('./channels/domain/pressure-channel.js');
      const { HealthChannel }   = await import('./channels/domain/health-channel.js');
      const { SaunaChannel }    = await import('./channels/domain/sauna-channel.js');
      const { WeatherChannel }  = await import('./channels/domain/weather-channel.js');
      if (readers.pressure?.path) {
        channelBus.register(new PressureChannel({ path: expandHome(readers.pressure.path) }));
        registered.push('domain.pressure');
      }
      if (readers.health?.path) {
        channelBus.register(new HealthChannel({ path: expandHome(readers.health.path) }));
        registered.push('domain.health');
      }
      if (readers.sauna?.path) {
        channelBus.register(new SaunaChannel({ path: expandHome(readers.sauna.path) }));
        registered.push('domain.sauna');
      }
      if (readers.weather?.enabled) {
        // Weather fetcher is agent-specific; default to no-op until plumbed.
        channelBus.register(new WeatherChannel({ intervalMs: 5 * 60 * 1000 }));
        registered.push('domain.weather');
      }
    }

    await channelBus.start();
    logger.info(`[channels] bus started with ${registered.length} channels: ${registered.join(', ')}`);
    logger.info('[channels] memory-ingest wired to crystallize events');
    // Expose on config so subsystems can access later without threading refs.
    config._osEngine = { channelBus, closer, decayWorker, memoryIngest };
  } catch (err) {
    logger.warn?.('[channels] bus initialization failed — engine continues without it:', err?.message || err);
  }

  // Start
  await orchestrator.start();
}

main().catch(error => {
  console.error('Phase 2B GPT-5.2 initialization failed:', error);
  console.error(error.stack);
  process.exit(1);
});
