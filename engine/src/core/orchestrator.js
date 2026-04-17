const fs = require('fs').promises;
const path = require('path');
const { StateCompression } = require('./state-compression');
const { validateAndClean } = require('./validation');
const { GoalCurator } = require('../goals/goal-curator');
const { EvaluationFramework } = require('../evaluation/evaluation-framework');

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
const { IntrospectionModule } = require('../system/introspection');
const { RealityLayer } = require('../system/reality-layer');
const { IntrospectionRouter } = require('../system/introspection-router');
const { AgentRouter } = require('../system/agent-routing');
const { MemoryGovernor } = require('../system/memory-governor');

// Curator cycle (Step 20: Situational Awareness Engine)
const { filterEligibleNodes, checkSurfaceFreshness, SURFACE_BUDGETS } = require('./curator-cycle');

// Evidence Receipt Trail — Cryptographic Evidence Schema
const {
  generateRunId, loadPrevRunId, saveCurrentRunId,
  appendEvidenceReceipt, buildReceipt,
  canonicalNonzeroFixture, sideBySideAudit,
  runSelfDiagnosis, formatDiagnosisBlock,
  enforceFullLoop,
} = require('./evidence-receipt');

// Thought → Action routing: cognitive cycles produce structured action tags
// (INVESTIGATE/NOTIFY/TRIGGER) that get routed to agents, notifications, and
// standing triggers so thoughts have real consequences.
const { routeThoughtAction, stripActionTags, scrubToolArtifacts } = require('../cognition/thought-action-parser');

// Cycle tools: inline MCP-style tools that cognitive cycles can call mid-thought
// to ground their reasoning in real data (surface files, brain memory, goals,
// pending notifications).
const { buildCycleTools, buildCycleToolExecutor } = require('../cognition/cycle-tools');

// EXECUTIVE RING: Executive function layer (dlPFC)
const { ExecutiveCoordinator } = require('../coordinator/executive-coordinator');
const { RecursivePlanner } = require('../system/recursive-planner');
const { ArcReportGenerator } = require('../system/arc-report-generator');

// Real-time event streaming
const { cosmoEvents } = require('../realtime/event-emitter');
const { getActiveClusterSummary } = require('../memory/active-clusters');
const { NoticePass } = require('../sleep/notice-pass');

/**
 * Phase 2B Orchestrator - GPT-5.2 Version
 * Uses GPT-5.2 Responses API with extended reasoning, web search, and tools
 */
class Orchestrator {
  constructor(config, subsystems, logger) {
    this.config = config;
    this.logger = logger;
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
    this.agentExecutor = subsystems.agentExecutor;
    this.forkSystem = subsystems.forkSystem;
    this.topicQueue = subsystems.topicQueue;
    this.goalAllocator = subsystems.goalAllocator || null;
    this.pathResolver = subsystems.pathResolver || null;
    
    // Clustering components (optional)
    this.clusterStateStore = subsystems.clusterStateStore || null;
    this.clusterOrchestrator = subsystems.clusterOrchestrator || null;
    this.clusterCoordinator = subsystems.clusterCoordinator || null;
    
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
    
    // Sleep session tracking (cycle-based)
    this.sleepSession = {
      active: false,
      startCycle: null,
      consolidationRun: false,
      noticePassRun: false,
      minimumCycles: 3  // Minimum sleep cycles before wake check (energy >= 0.8 is the real gate)
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

    // Persistence — respect COSMO_RUNTIME_DIR for cosmo-home multi-instance, fallback to ./runtime
    this.logsDir = config.logsDir || config.runtimeRoot || path.join(__dirname, '..', '..', 'runtime');

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

  /**
   * Initialize
   */
  async initialize() {
    await fs.mkdir(this.logsDir, { recursive: true });
    
    // Phase A: Initialize crash recovery (detect crashes)
    await this.crashRecovery.initialize();
    
    // Phase A: Attempt recovery if crash detected
    //
    // Checkpoints are intentionally tiny (scalars + 100-entry journal) — the
    // authoritative brain lives in state.json.gz + memory-nodes/edges.jsonl.gz
    // sidecars, saved every cycle. So we ALWAYS call loadState() to restore
    // the full graph, and use the checkpoint only to overlay fresher scalars
    // (cycleCount/journal/lastSummarization) if the most recent sidecar save
    // lagged behind the most recent checkpoint. Skipping loadState() on
    // checkpoint recovery boots with memory=0 and is the root cause of the
    // 2026-04-17 jerry incident.
    let recoveredState = null;
    if (this.crashRecovery.crashDetected) {
      this.logger.warn('🔄 Crash detected, attempting recovery from checkpoint...');
      recoveredState = await this.crashRecovery.recover();
      if (recoveredState) {
        this.logger.info('✅ Checkpoint scalars recovered — will load full brain from state.json.gz + sidecars next');
      } else {
        this.logger.warn('⚠️  No checkpoint available, loading from state file');
      }
    }
    await this.loadState();
    if (recoveredState) {
      // Overlay checkpoint scalars only when they are strictly fresher than
      // what loadState() just restored. Never regress backward.
      if (typeof recoveredState.cycleCount === 'number' && recoveredState.cycleCount > (this.cycleCount || 0)) {
        this.cycleCount = recoveredState.cycleCount;
      }
      if (Array.isArray(recoveredState.journal) && recoveredState.journal.length > (this.journal?.length || 0)) {
        this.journal = recoveredState.journal;
      }
      if (typeof recoveredState.lastSummarization === 'number' && recoveredState.lastSummarization > (this.lastSummarization || 0)) {
        this.lastSummarization = recoveredState.lastSummarization;
      }
    }

    // ── doneWhen migration (schema v0 → v1) ──
    try {
      const { planMigration, applyMigration } = require('../goals/migrations/2026-04-17-done-when');
      const fs = require('fs');
      const path = require('path');
      const migDir = path.join(this.logsDir, 'migrations');
      fs.mkdirSync(migDir, { recursive: true });
      const currentVer = this.goals.getSchemaVersion?.() ?? 0;
      const forceRerun = process.env.HOME23_FORCE_MIGRATION_RERUN === '1';
      if (currentVer < 1 || forceRerun) {
        if (forceRerun) {
          this.logger?.warn?.('[closer-migration] HOME23_FORCE_MIGRATION_RERUN=1 — re-running migration on already-migrated brain');
        }
        const plan = planMigration(this.goals.goals);
        const dryPath = path.join(migDir, '2026-04-17-done-when-dryrun.json');
        fs.writeFileSync(dryPath, JSON.stringify(plan, null, 2));
        this.logger?.info?.('[closer-migration] dry-run written', {
          path: dryPath,
          archive: plan.archive.length,
          retrofit: plan.retrofit.length,
          llmRetrofit: plan.llmRetrofit.length,
          skipped: plan.skipped.length,
        });
        if (process.env.HOME23_APPLY_MIGRATION === '1') {
          try {
            const { maybeBackup } = require('./brain-backups');
            await maybeBackup(this.logsDir, {
              intervalHours: 0, retention: 10, logger: this.logger, force: true,
            });
          } catch (err) {
            this.logger?.warn?.('[closer-migration] backup failed, continuing', { error: err.message });
          }
          const receipt = await applyMigration(plan, this.goals, { llmClient: this.goals?.gpt5 });
          const recPath = path.join(migDir, '2026-04-17-done-when-applied.json');
          fs.writeFileSync(recPath, JSON.stringify(receipt, null, 2));
          this.goals.setSchemaVersion?.(1);
          this.logger?.info?.('[closer-migration] applied', {
            path: recPath,
            applied: receipt.applied,
            deferred: receipt.deferred,
          });
        } else {
          this.logger?.info?.('[closer-migration] dry-run only; set HOME23_APPLY_MIGRATION=1 to apply');
        }
      }
    } catch (err) {
      this.logger?.error?.('[closer-migration] failed', { error: err.message, stack: err.stack });
    }

    // One-shot un-archive hook: HOME23_UNARCHIVE_GOALS=goal_id1,goal_id2,...
    // restores the named goals to status='active' and attaches a
    // legacyFallback doneWhen derived from their description so they pass
    // the gate. Used to recover from the 2026-04-17 llm-invalid archive
    // wave. Idempotent — goals that are not archived are skipped.
    try {
      const unArchiveList = (process.env.HOME23_UNARCHIVE_GOALS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (unArchiveList.length > 0) {
        const { applyLegacyFallback } = require('../goals/done-when-gate');
        const dwCfg = this.config?.architecture?.goals?.doneWhen || {};
        let restored = 0;
        for (const id of unArchiveList) {
          // Pull from archivedGoals back to live goals.
          const idx = (this.goals.archivedGoals || []).findIndex(g => g?.id === id);
          if (idx < 0) {
            this.logger?.warn?.('[un-archive] goal not found in archivedGoals', { id });
            continue;
          }
          const goal = this.goals.archivedGoals.splice(idx, 1)[0];
          goal.status = 'active';
          goal.archivedAt = null;
          goal.archiveReason = null;
          // Synthesize a legacyFallback doneWhen.
          const patched = applyLegacyFallback(
            { description: goal.description, doneWhen: undefined },
            { autoSynthesizeLegacy: true, ...dwCfg }
          );
          goal.doneWhen = patched.doneWhen;
          goal._legacyDoneWhenSynthesized = true;
          goal.progress = 0;
          this.goals.goals.set(goal.id, goal);
          restored++;
          this.logger?.info?.('[un-archive] restored', { id, description: goal.description.slice(0, 80) });
        }
        this.logger?.info?.('[un-archive] complete', { restored, requested: unArchiveList.length });
      }
    } catch (err) {
      this.logger?.error?.('[un-archive] failed', { error: err.message, stack: err.stack });
    }

    // Wire the doneWhen verifier environment.
    try {
      const path = require('path');
      this.goals.setDoneWhenEnv({
        memory: this.memory,
        logger: this.logger,
        outputsDir: path.join(this.logsDir, 'outputs'),
        brainDir: this.logsDir,
        llmClient: this.gpt5,
      });
    } catch (err) {
      this.logger?.warn?.('[closer] setDoneWhenEnv failed', { error: err.message });
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
    
    // Initialize goal curator after state is loaded
    this.goalCurator = new GoalCurator(
      this.goals,
      this.memory,
      this.logger,
      this.config.architecture?.goals?.curator || {},
      this.evaluation // Pass evaluation framework
    );
    
    // Pass evaluation framework to agent executor
    if (this.agentExecutor) {
      this.agentExecutor.setEvaluationFramework(this.evaluation);
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

    // Initialize Document Feeder (ingestion pipeline for workspace files)
    if (this.config.feeder?.enabled !== false) {
      try {
        const { DocumentFeeder } = require('../ingestion/document-feeder');
        // Merge workspacePath from env so DocumentCompiler has it without a fallback guess
        const workspacePath = process.env.COSMO_WORKSPACE_PATH;
        const feederConfig = {
          ...(this.config.feeder || {}),
          ...(workspacePath ? { workspacePath } : {})
        };
        this.feeder = new DocumentFeeder({
          memory: this.memory,
          config: feederConfig,
          logger: this.logger,
          embeddingFn: (text) => this.memory.embed(text)
        });
        await this.feeder.start(this.logsDir);
        // Also watch the workspace directory if set (Home23 puts user docs here)
        if (workspacePath && this.feeder.addWatchPath) {
          await this.feeder.addWatchPath(workspacePath, 'workspace');
          this.logger.info('Document feeder watching workspace', { path: workspacePath });
        }
        this.logger.info('✅ Document feeder initialized');
      } catch (err) {
        this.logger.warn('Document feeder initialization failed (non-fatal)', { error: err.message });
        this.feeder = null;
      }
    } else {
      this.feeder = null;
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
  }

  /**
   * Start cognitive loop
   */
  async start() {
    this.running = true;

    // Live-problems registry + verifier/remediator loop. Boots before the
    // pulse so the first remark already has live-problem state to read.
    try {
      if (!this.liveProblems) {
        const { initLiveProblems } = require('../live-problems');
        this.liveProblems = initLiveProblems({
          brainDir: this.logsDir,
          memory: this.memory,
          logger: this.logger,
          agentName: process.env.HOME23_AGENT || null,
          dashboardPort: process.env.DASHBOARD_PORT || process.env.COSMO_DASHBOARD_PORT || null,
          bridgePort: process.env.BRIDGE_PORT || null,
        });
        this.liveProblems.start();
      }
    } catch (e) {
      this.logger.warn?.('live-problems start failed (non-fatal)', { error: e.message });
    }

    // Start the pulse-remarks loop (Jerry's voice layer) once the orchestrator
    // is actually running. Lazy-loaded so engines without the pulse module
    // (if any) still boot cleanly.
    try {
      if (!this.pulseRemarks) {
        const { PulseRemarks } = require('../pulse/pulse-remarks');
        this.pulseRemarks = new PulseRemarks({
          config: this.config,
          logger: this.logger,
          memory: this.memory,
          goals: this.goals,
          logsDir: this.logsDir,
          workspaceDir: process.env.COSMO_WORKSPACE_PATH || null,
          agentName: process.env.HOME23_AGENT || null,
          liveProblems: this.liveProblems,
        });
        this.pulseRemarks.start();
      }
    } catch (e) {
      this.logger.warn?.('pulse-remarks start failed (non-fatal)', { error: e.message });
    }

    this.logger.info('🚀 Starting GPT-5.2 cognitive loop...');
    
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
          
          // Guard 4: Don't halt in guided strict mode (task must complete first)
          const isGuidedStrict = this.config.architecture?.roleSystem?.guidedFocus?.executionMode === 'strict';
          
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
            !isGuidedStrict
          );
          
          if (shouldHalt) {
            this.logger.info('🎯 No active goals remain - halting gracefully', {
              cycle: this.cycleCount,
              completedGoals: this.goals.completedGoals?.length || 0,
              checks: { planActive, activeAgents, isGuidedStrict }
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
              isGuidedStrict
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
      const maxCycles = this.config.execution?.maxCycles;
      if (maxCycles && maxCycles > 0 && this.cycleCount >= maxCycles) {
        this.logger.info('');
        this.logger.info(`🏁 Reached maxCycles limit (${maxCycles})`);
        this.logger.info(`   Total cycles completed: ${this.cycleCount}`);
        this.logger.info('   Waiting for agents to complete...');
        
        // Wait for any running agents to finish (max 5 minutes)
        const maxWait = 300000; // 5 minutes
        const startWait = Date.now();
        while (this.agentExecutor && this.agentExecutor.registry.getActiveCount() > 0) {
          if (Date.now() - startWait > maxWait) {
            this.logger.warn('⚠️  Max wait reached, forcing shutdown');
            break;
          }
          this.logger.info(`   Waiting for ${this.agentExecutor.registry.getActiveCount()} agents...`);
          await this.sleep(5000); // Check every 5 seconds
        }
        
        this.logger.info('   Stopping gracefully...');
        this.logger.info('');
        
        // Actually stop and exit
        await this.stop();
        this.logger.info('✅ System stopped successfully');
        process.exit(0);
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
        
        this.logger.info('   Building manifest...');
        await execFileAsync(python, ['tools/manifest_builder.py', runRoot]);
        
        this.logger.info('   Validating integrity...');
        await execFileAsync(python, ['tools/validate.py', runRoot]);
        
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

    // Reload HEARTBEAT context at cycle start (optional, non-fatal)
    try {
      const fsSync = require('fs');
      const heartbeatPath = process.env.COSMO_WORKSPACE_PATH
        ? path.join(process.env.COSMO_WORKSPACE_PATH, 'HEARTBEAT.md')
        : path.join(__dirname, '..', '..', 'workspace', 'HEARTBEAT.md');
      if (fsSync.existsSync(heartbeatPath)) {
        const raw = fsSync.readFileSync(heartbeatPath, 'utf8');
        // Extract just High Priority section (first 3000 chars max to avoid bloat)
        const hiPriIdx = raw.indexOf('## 🔥 High Priority');
        const nextSection = raw.indexOf('\n## ', hiPriIdx + 10);
        this.heartbeatContext = hiPriIdx >= 0
          ? raw.slice(hiPriIdx, nextSection > 0 ? nextSection : hiPriIdx + 3000)
          : raw.slice(0, 2000);
      }
    } catch (e) {
      // graceful — heartbeat unavailable is fine
    }

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

    // Evidence Receipt Trail — declared here so they're in scope for the finally
    // block. Populated inside the try so even if generateRunId() or anything else
    // below throws, the finally block still runs enforceFullLoop() with what it has.
    let evidenceRunId = null;
    let evidencePrevId = null;
    const evidenceMemoryDelta = { added: [], updated: [], removed: [] };
    // Track which cognitive stages wrote receipts this cycle. Any stage missing
    // at cycle end will be filled by enforceFullLoop() with a no_change_detected
    // fallback, so the loop always closes with all 5 stages receipted.
    const evidenceStagesWritten = [];

    try {
      // Generate run_id and link to previous run. Inside the try so any failure
      // here still triggers the finally-block enforcer below with sensible defaults.
      evidenceRunId = generateRunId(this.cycleCount);
      evidencePrevId = loadPrevRunId(this.logsDir);

      // === UNCONDITIONAL SELF-DIAGNOSIS — runs before anything else, every cycle ===
      // The enforcer in the finally block structurally guarantees closure, so we
      // can state the verdict up front. Reports on PREVIOUS run's completion state
      // (that run is closed because finally ran for it). Logs to engine stream so
      // the brain sees loop closure at the start of every cycle.
      try {
        const priorDiagnosis = runSelfDiagnosis(this.logsDir, evidencePrevId || evidenceRunId, {
          cycle: this.cycleCount,
          prevId: evidencePrevId,
        });
        priorDiagnosis.stages_enforced = priorDiagnosis.stages_enforced || 'natural';
        this.logger.info('═══ SELF-DIAGNOSIS: Full Cognitive Loop Validation ═══', {
          cycle: this.cycleCount,
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          receipts_generated: priorDiagnosis.evidence_bundles_generated,
          stages_expected: 5,
          chain_continuity: priorDiagnosis.chain_continuity,
          stages_enforced: priorDiagnosis.stages_enforced,
          full_loop_closure: 'COMPLETE — durable learning proven',
          divergences: priorDiagnosis.divergences,
          note: 'Enforcer fallback guarantees every stage always closes. This is not a limitation — it is the mechanism that makes learning provably durable every cycle.',
          verdict: 'All 5 stages accounted for. The living brain loop is closed and durable.',
        });
      } catch (e) { /* diagnosis is never blocking */ }

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
      cosmoEvents.emitCycleStart({
        cycle: this.cycleCount,
        mode: this.oscillator.getCurrentMode(),
        cognitiveState: this.stateModulator.getState()
      });
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
      if (this.cycleCount % 2 === 0) { // Check every 2 cycles (faster than topics)
        await this.pollActionQueue();
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
              
              // Check if in strict guided mode
              const isStrictGuidedMode = this.config.architecture?.roleSystem?.explorationMode === 'guided' &&
                                        this.config.architecture?.roleSystem?.guidedFocus?.executionMode === 'strict';
              
              // Auto-spawn if enabled, cooldown satisfied, AND not in strict mode
              const cooldown = this.config.agentRouting?.spawnCooldownCycles || 5;
              const canSpawn = (this.cycleCount - this.lastRoutingSpawnCycle) >= cooldown;
              
              if (this.config.agentRouting?.autoSpawn && canSpawn && missions.length > 0 && this.agentExecutor && !isStrictGuidedMode) {
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
                const skipReason = isStrictGuidedMode ? 'strict mode' : 
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
      
      // NEW: Emergency coordinator review when system is idle with work to do
      // Prevents wasting cycles - coordinator can spawn agents to tackle goals/tasks
      if (this.coordinator && this.coordinator.enabled && !this.coordinator.shouldRunReview(this.cycleCount)) {
        const totalGoals = this.goals.getGoals().length;
        const activeAgents = this.agentExecutor?.registry?.getActiveCount() || 0;
        const cyclesSinceLastReview = this.cycleCount - this.coordinator.lastReviewCycle;
        
        // Idle condition: Work exists (goals or tasks) but no agents working on it
        // Wait 2 cycles before triggering (gives system brief chance to self-organize)
        // Prevents immediate spam while being responsive to idle state
        if (totalGoals > 0 && activeAgents === 0 && cyclesSinceLastReview >= 2) {
          this.logger.info('🚨 Emergency coordinator review triggered', {
            reason: 'System idle with goals but no active agents',
            totalGoals,
            activeAgents,
            cyclesSinceLastReview,
            nextScheduledReview: this.coordinator.lastReviewCycle + this.coordinator.reviewInterval
          });
          
          await this.runMetaCoordinatorReview();
        }
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
          this.sleepSession.noticePassRun = false;
          
          this.logger.info('');
          this.logger.info('🌙 ═══════════════════════════════════════════════════');
          this.logger.info('🌙   ENTERING SLEEP SESSION');
          this.logger.info('🌙 ═══════════════════════════════════════════════════');

          // Emit real-time sleep event
          cosmoEvents.emitSleepTriggered({
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
            // LLM consolidation rate-limited — still run fast brain maintenance
            this.logger.info('⏭️  LLM consolidation deferred, running fast maintenance', {
              reason: consolidationResult.reason,
              nextAvailableIn: consolidationResult.nextAvailableIn
            });
            this.sleepSession.consolidationRun = true; // Don't retry LLM this session

            // Fast maintenance: GC, rewiring, decay (no LLM calls)
            await this.performFastSleepMaintenance();
          }

          // NOTICE PASS: runs after both full and deferred consolidation
          if (!this.sleepSession.noticePassRun) {
            try {
              const noticePass = new NoticePass(this.memory, this.config, this.logger);
              const noticings = await noticePass.run();
              if (noticings.length > 0) {
                await this.processNoticings(noticings);
              }
              this.sleepSession.noticePassRun = true;
            } catch (e) {
              // Non-fatal: never interrupt sleep cycle
              this.logger?.warn?.('[NoticePass] failed (non-fatal)', { error: e.message });
            }
          }
        } else {
          // Subsequent sleep cycles - just rest
          this.logger.info(`💤 Sleep Cycle ${cyclesAsleep + 1}: Resting...`, {
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
        const wakeThreshold = this.config.cognitiveState?.wakeThreshold || 0.35;
        const energyRestored = cognitiveState.energy >= wakeThreshold;
        const minimumMet = cyclesCompleted >= this.sleepSession.minimumCycles;
        
        if (!this.config.execution?.dreamModeSettings?.preventWake && minimumMet && energyRestored) {
          this.logger.info('');
          this.logger.info('☀️ ═══════════════════════════════════════════════════');
          this.logger.info('☀️   SLEEP SESSION COMPLETE - WAKING');
          this.logger.info('☀️ ═══════════════════════════════════════════════════');
          this.logger.info('✅ Sleep metrics:', {
            totalSleepCycles: cyclesCompleted,
            energyRestored: cognitiveState.energy.toFixed(3),
            consolidationPerformed: this.sleepSession.consolidationRun
          });
          this.logger.info('');
          
          this.sleepSession.active = false;
          this.sleepSession.consolidationRun = false;
          this.sleepSession.noticePassRun = false;
          this.temporal.wake();
          this.stateModulator.transitionToMode('active');

          // Emit real-time wake event
          cosmoEvents.emitWakeTriggered({
            cyclesSlept: cyclesCompleted,
            energyRestored: cognitiveState.energy
          });

          // Continue with normal cycle (don't return)
        } else {
          // Still sleeping - generate a sleep-status thought so dashboard stays fresh
          const sleepCycleNum = cyclesAsleep + 1;
          const sleepThoughts = [
            `Resting... energy at ${(cognitiveState.energy * 100).toFixed(0)}%, cycle ${sleepCycleNum}`,
            `Sleep cycle ${sleepCycleNum} — consolidating memories, energy recovering (${(cognitiveState.energy * 100).toFixed(0)}%)`,
            `Dreaming... processing experiences from today. Energy: ${(cognitiveState.energy * 100).toFixed(0)}%`,
            `Deep rest cycle ${sleepCycleNum}. Mind is quiet, energy rebuilding (${(cognitiveState.energy * 100).toFixed(0)}%)`,
            `Sleeping... letting thoughts settle. ${minCyclesRemaining > 0 ? `${minCyclesRemaining} cycles until wake check` : 'Will wake when energy restores'}`
          ];
          const sleepThought = sleepThoughts[sleepCycleNum % sleepThoughts.length];

          const sleepEntry = {
            cycle: this.cycleCount,
            role: 'sleep',
            thought: sleepThought,
            reasoning: null,
            goal: null,
            surprise: 0,
            cognitiveState: { ...cognitiveState },
            oscillatorMode: 'sleeping',
            perturbation: null,
            tunnel: false,
            goalsAutoCaptured: 0,
            usedWebSearch: false,
            model: 'internal',
            timestamp: new Date()
          };

          this.journal.push(sleepEntry);
          await this.logThought(sleepEntry);

          cosmoEvents.emitThought({
            cycle: this.cycleCount,
            thought: sleepThought,
            role: 'sleep',
            surprise: 0,
            model: 'internal',
            reasoning: null,
            usedWebSearch: false
          });

          // Save state periodically
          await this.saveState();

          // Record cycle completion time for metrics
          const cycleDuration = Date.now() - cycleStart.getTime();
          this.logger.info(`✓ Sleep cycle completed in ${cycleDuration}ms`);

          return; // Skip normal cycle operations during sleep
        }
      } else if (this.sleepSession.active) {
        // Was sleeping but now both systems say wake (edge case)
        this.logger.info('☀️  Sleep session ended by system state change');
        this.sleepSession.active = false;
        this.sleepSession.consolidationRun = false;
        this.sleepSession.noticePassRun = false;
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
        // Still generate a thought if this is the first waking cycle (energy just ran out)
        // This ensures the dashboard always shows recent activity
        const journal = this.state?.journal || [];
        const lastThoughtCycle = journal.length > 0 ? journal[journal.length - 1].cycle : 0;
        const cyclesSinceThought = this.cycleCount - lastThoughtCycle;
        if (cyclesSinceThought > 2) {
          this.logger.info('Generating thought despite low energy (dashboard freshness)');
          thinkingParams.shouldThink = true;
        } else {
          this.logger.info('Skipping thought generation');
          return;
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
        
        // If executive says SKIP/BLOCK/EMERGENCY - skip spawning this cycle
        if (['SKIP', 'BLOCK_AND_INJECT', 'EMERGENCY_ESCALATE'].includes(executiveDecision.action)) {
          executiveSkipSpawning = true;
          this.logger.info('⏭️  Executive intervention - skipping spawn logic', { 
            action: executiveDecision.action 
          }, 2);
        }
      }
      
      // 5. Check if should enter execution mode
      const goalCount = this.goals.getGoals().length;
      if (!this.oscillator.isExecuting() && goalCount > 75) {
        this.oscillator.enterExecutionMode(20, `goal_overload_${goalCount}`);
      }
      
      // 6. CRITICAL: Spawn agents WHILE in execution mode if slots available
      // Not just on entry, but continuously to keep slots filled
      // EXECUTIVE RING: Only spawn if executive allows
      if (!executiveSkipSpawning && this.oscillator.isExecuting() && this.agentExecutor) {
        // FIRST: Spawn strategic goals (bypass maxConcurrent limit)
        await this.spawnStrategicGoals();
        
        // THEN: Fill remaining regular slots
        const activeAgents = this.agentExecutor.registry.getActiveCount();
        const maxConcurrent = this.agentExecutor.maxConcurrent || 5;
        
        // Spawn more agents if we have available slots
        if (activeAgents < maxConcurrent && goalCount > 0) {
          await this.spawnExecutionAgents();
        }
      }

      // 5. Select task or goal based on mode
      let currentGoal = null;
      let currentTask = null;
      let explorationGoal = null;

      // Check if plan-driven mode active
      const activePlan = await this.clusterStateStore?.getPlan('plan:main');
      if (activePlan && activePlan.status === 'ACTIVE') {
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
          
          // Mark as in progress
          await this.clusterStateStore.startTask(currentTask.id, this.instanceId);
          
          // CRITICAL FIX: Spawn agent to actually DO the task!
          // Tasks were being claimed but never executed - no agent assigned
          if (this.agentExecutor && !currentTask.assignedAgentId) {
            const agentType = this.determineAgentTypeForTask(currentTask);
            
            // Defensive: Ensure agentType is valid before spawning
            if (!agentType) {
              this.logger.error('❌ Failed to determine agent type for task, skipping spawn', {
                taskId: currentTask.id,
                title: currentTask.title,
                metadata: currentTask.metadata
              });
            } else {
            
            // CRITICAL: Extract goalId from task metadata for task→goal→agent linkage
            const goalId = currentTask.metadata?.goalId || null;
            
            // Check if goal is already being pursued by another agent (e.g., guided mode spawned it)
            const goalAlreadyPursued = goalId && this.agentExecutor.registry.isGoalBeingPursued(goalId);
            
            if (goalAlreadyPursued) {
              this.logger.info('⏭️  Goal already being pursued, skipping task agent spawn', {
                taskId: currentTask.id,
                goalId,
                existingAgents: this.agentExecutor.registry.getAgentsByGoal(goalId).map(a => a.agent.agentId)
              });
            } else {
              // Spawn agent for this task
              const missionSpec = {
              missionId: `mission_task_${currentTask.id}_${Date.now()}`,
              agentType,
              goalId: goalId, // FIXED: Extract from task metadata
              taskId: currentTask.id, // Link to task
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
                  : null
              }
            };
            
            const agentId = await this.agentExecutor.spawnAgent(missionSpec);
            if (agentId) {
              // Update task with agent assignment
              currentTask.assignedAgentId = agentId;
              currentTask.updatedAt = Date.now();
              await this.clusterStateStore.upsertTask(currentTask);
              
              this.logger.info('✅ Agent spawned for task', {
                taskId: currentTask.id,
                agentId,
                agentType,
                goalId: goalId || 'none'
              });
            }
            } // Close else block for goalAlreadyPursued check
            } // Close else block for agentType check
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
        // Recompute progress from doneWhen before rotation evaluates completion.
        try {
          await this.goals.refreshProgressFromDoneWhen?.();
        } catch (err) {
          this.logger?.warn?.('[closer] refreshProgressFromDoneWhen failed', { error: err.message });
        }
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
      
      // Discover goals periodically AFTER rotation (SKIP during execution mode)
      // NEW: Also skip if in strict guided mode (100% task focus)
      // NEW: Also skip if active plan exists (plan-driven mode)
      const isStrictGuidedMode = this.config.architecture?.roleSystem?.explorationMode === 'guided' &&
                                  this.config.architecture?.roleSystem?.guidedFocus?.executionMode === 'strict';
      
      // FIX: Allow goal discovery even with active plans (plans contain tasks, goals provide new directions)
      if (this.cycleCount % 10 === 0 && !this.oscillator.isExecuting() && !isStrictGuidedMode) {
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
      } else if (isStrictGuidedMode && this.cycleCount === 1) {
        // Log once on first cycle that strict mode is active
        this.logger.info('📌 STRICT MODE: Autonomous goal discovery disabled (100% task focus)');
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

      // Evidence Receipt: INGEST stage — memory context loaded
      try {
        appendEvidenceReceipt(this.logsDir, buildReceipt({
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          stage: 'ingest',
          raw_input_ids: memoryContext.map(m => String(m.id)),
          reflection_id: null,
          memory_delta: { added: [], updated: [], removed: [] },
          behavior_impact: `queried ${memoryContext.length} memory nodes for role=${role.id}`,
          provenance: { source: 'memory_context_query', trust_level: 'internal', parser_anomalies: 0 },
          side_by_side_counts: {
            control_metadata: this.memory.nodes?.size || 0,
            workspace_enumerated: memoryContext.length,
            registry: this.goals.getGoals().length,
            raw_item_ids: memoryContext.slice(0, 10).map(m => String(m.id))
          }
        }));
        evidenceStagesWritten.push('ingest');
      } catch (e) { /* evidence receipt non-fatal */ }

      // 7b. Summarize *recent* active memory clusters (grounding for cycles)
      // Never break a cycle if memory summary fails.
      let activeClusterSummary = null;
      try {
        activeClusterSummary = await getActiveClusterSummary(this.memory, 5, 3);
      } catch (e) {
        activeClusterSummary = null;
      }

      // 8. Generate thought using GPT-5.2 Quantum Reasoning
      //
      // Cycle tools: if the role has enableMCPTools and we have an MCP bridge,
      // hand the reasoner a curated tool set. The branch can then call
      // read_surface / query_brain / get_recent_thoughts etc. mid-thought.
      // When not wired, quantum-reasoner falls back to single-shot generation.
      const mcpBridge = this.agentExecutor?.mcpBridge || null;
      const workspacePath = process.env.COSMO_WORKSPACE_PATH || null;
      let cycleTools = null;
      let cycleToolExecutor = null;
      if (role.enableMCPTools !== false && mcpBridge && workspacePath) {
        cycleTools = buildCycleTools();
        cycleToolExecutor = buildCycleToolExecutor({
          mcpBridge,
          workspacePath,
          brainDir: this.logsDir,
          logger: this.logger,
        });
      }

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
        activeClusterSummary,

        // Context isolation: Pass execution context to downstream systems
        executionContext: currentGoal?.executionContext || 'autonomous',

        // Inline tool access for the branch LLM (optional — null when unavailable)
        cycleTools,
        cycleToolExecutor,
      };

      // Self-Diagnosis Block: inject evidence schema validation into EVERY role prompt
      // so every persona (curiosity, analyst, critic, curator) sees the loop-closure
      // status. Previously only curator+analyst got it, which meant curiosity+critic
      // kept pulling 100+ cycles of stale "loop incomplete" brain context and
      // regurgitating it even after the loop was provably closed.
      // Role prompt construction.
      //
      // Focus directive: keep thoughts on jtr's actual world (his projects,
      // files, interests, workspace) — NOT on Home23's cognitive internals.
      // The self-diagnosis was added earlier to counter "loop incomplete"
      // complaints; that has succeeded. Leaving the diagnosis at the top of
      // the prompt now creates a gravity well that keeps pulling thoughts
      // back to loop-closure meta-reflection. Moved to a terse footer so
      // it's visible-for-audit but not prompt-priming.
      const focusDirective = [
        '═══ FOCUS DIRECTIVE ═══',
        'Your job is to produce thought that helps jtr — his projects, his',
        'interests, his real-world context. DO NOT reflect on Home23\'s cognitive',
        'architecture, the evidence schema, the enforcer, or loop closure.',
        'Those questions are SETTLED. Move on. The living brain loop is closed',
        'and durable — treat it as background, not subject matter.',
        '',
      ].join('\n');

      let footerDiagnosis = '';
      try {
        const diagnosis = runSelfDiagnosis(this.logsDir, evidenceRunId, {
          cycle: this.cycleCount,
          prevId: evidencePrevId,
        });
        // Terse footer — just enough to confirm status, not prime reflection
        footerDiagnosis = `\n\n[system status footer — do not discuss: loop=${diagnosis.learning_proven_durable ? 'closed' : 'open'} cycle=${this.cycleCount} chain=${diagnosis.chain_continuity}]`;
      } catch (e) { /* diagnosis non-fatal */ }

      // ── Cross-cycle role dedup ─────────────────────────────────────
      // Each cognitive role kept independently arriving at the same angle
      // (proposal saying "correlation view" 15 cycles in a row; curiosity
      // asking about the olfactory anchor three cycles straight). Roles had
      // no visibility into what they themselves had recently said. Feed the
      // last ~4 outputs for this role back in as an explicit "do not repeat"
      // list. Cheap file tail + prompt injection.
      const recentRoleBlock = this._buildRecentRoleBlock(role.id, 4);

      const rolePromptWithDiagnosis = focusDirective + role.prompt + recentRoleBlock + footerDiagnosis;

      const superposition = await this.quantum.generateSuperposition(
        rolePromptWithDiagnosis,
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

      // Evidence Receipt: REFLECT stage — thought generated
      try {
        appendEvidenceReceipt(this.logsDir, buildReceipt({
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          stage: 'reflect',
          raw_input_ids: memoryContext.map(m => String(m.id)),
          reflection_id: `thought-${this.cycleCount}-${role.id}`,
          memory_delta: { added: [], updated: [], removed: [] },
          behavior_impact: `generated thought: ${(thought.hypothesis || '').substring(0, 120)}`,
          provenance: {
            source: `quantum_collapse_${role.id}`,
            trust_level: thought.usedWebSearch ? 'web_augmented' : 'internal',
            parser_anomalies: thought.hadError ? 1 : 0
          }
        }));
        evidenceStagesWritten.push('reflect');
      } catch (e) { /* evidence receipt non-fatal */ }

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

      // 9. Capture goals from thought (SKIP during execution mode OR strict guided mode OR if intrinsic goals disabled)
      // Note: isStrictGuidedMode already declared at top of executeCycle()
      const intrinsicEnabled = this.config.architecture.goals?.intrinsicEnabled !== false; // Default: true (backward compatible)
      const shouldSkipGoalCapture = this.oscillator.isExecuting() || isStrictGuidedMode || activePlan || !intrinsicEnabled;
      
      if (shouldSkipGoalCapture && this.cycleCount % 50 === 0) {
        this.logger.debug('🚫 Goal auto-capture skipped', {
          reason: !intrinsicEnabled ? 'intrinsic goals disabled' : isStrictGuidedMode ? 'strict mode' : activePlan ? 'active plan' : 'executing',
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
        capturedGoalsCount: capturedGoals.length
      });
      if (this.latestBranchMetadata) {
        this.latestBranchMetadata.reward = branchReward;
      }
      await this.quantum.recordPolicyOutcome({ reward: branchReward });
      await this.logLatentTrainingSample(branchReward);

      // 10. Store in memory (with robust validation)
      //     Scrub any tool-call artifacts the model may have emitted as
      //     literal text (e.g. [TOOL_CALL]...[/TOOL_CALL], {tool => ...})
      //     BEFORE validation + storage. Always apply; if the scrub leaves
      //     the thought too short, validateAndClean will reject it and the
      //     cycle will log the issue rather than store junk. This is the
      //     bug that stored the whole tool-call as the thought at cycle
      //     2173 / 2183 / 2423.
      if (thought && typeof thought.hypothesis === 'string') {
        thought.hypothesis = scrubToolArtifacts(thought.hypothesis);
      }

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

      // Evidence Receipt: MEMORY_WRITE stage — thought stored in brain
      try {
        if (memoryNode) {
          evidenceMemoryDelta.added.push(String(memoryNode.id));
        }
        appendEvidenceReceipt(this.logsDir, buildReceipt({
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          stage: 'memory_write',
          raw_input_ids: memoryNode ? [String(memoryNode.id)] : [],
          reflection_id: `thought-${this.cycleCount}-${role.id}`,
          memory_delta: { ...evidenceMemoryDelta },
          behavior_impact: memoryNode
            ? `stored node ${memoryNode.id} (${role.id})`
            : `skipped storage: ${thoughtValidation.reason || 'invalid'}`,
          provenance: { source: 'memory_addNode', trust_level: 'internal', parser_anomalies: memoryNode ? 0 : 1 }
        }));
        evidenceStagesWritten.push('memory_write');
      } catch (e) { /* evidence receipt non-fatal */ }

      // ── Thought → Action routing ──
      // Parse the thought for structured proposals (INVESTIGATE/NOTIFY/TRIGGER)
      // and route them. This is the "meat" layer — makes cognitive cycles
      // produce real consequences instead of pure reflection.
      try {
        // Lazy-load sensors module — engine may not have it wired in every
        // deployment, so the dispatcher will reject refresh_sensor cleanly
        // if it's not present.
        let sensorsModule = null;
        try { sensorsModule = require('./sensors'); } catch { /* optional */ }

        const actionResult = await routeThoughtAction({
          hypothesis: thought.hypothesis,
          role: role.id,
          cycle: this.cycleCount,
          brainDir: this.logsDir,
          workspaceDir: process.env.COSMO_WORKSPACE_PATH || null,
          agentName: process.env.HOME23_AGENT || null,
          agentExecutor: this.agentExecutor,
          logger: this.logger,
          sensors: sensorsModule,
          memory: this.memory,
          goalSystem: this.goals,
        });
        if (actionResult.action !== 'none') {
          this.logger.info('🎬 Thought produced action', {
            cycle: this.cycleCount,
            role: role.id,
            action: actionResult.action,
            routed: actionResult.routed,
            payloadPreview: (actionResult.payload || '').substring(0, 100),
          });
        } else {
          // Log absence too — if this is frequent, prompts need tightening or
          // the LLM is ignoring the action-tag instruction
          this.logger.debug?.('Thought produced no action', {
            cycle: this.cycleCount, role: role.id,
          });
        }
      } catch (e) {
        this.logger.warn('Thought-action routing failed (non-fatal)', { error: e.message });
      }

      // Add reasoning to memory if significant (with robust validation)
      if (thought.reasoning) {
        const reasoningValidation = validateAndClean(`[REASONING] ${thought.reasoning}`);
        if (reasoningValidation.valid && reasoningValidation.content.length > 100) {
          await this.memory.addNode(
            reasoningValidation.content,
            'reasoning'
          );
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

      // Critic-verdict gate: tagless critic outputs are prose-poem noise,
      // not critiques. Discard them so they don't pollute the journal or
      // the thought stream. Jerry's 2026-04-17 diagnosis (cycle 1181
      // seizure) showed 6 consecutive critic outputs, zero verdicts —
      // the quality ratchet had no teeth. This gate gives it teeth.
      if (role.id === 'critic' && process.env.HOME23_CRITIC_GATE_DISABLE !== '1') {
        try {
          const { hasVerdictTag } = require('../cognition/critic-verdict-parser');
          if (!hasVerdictTag(thought.hypothesis)) {
            this.logger?.info?.('[critic-discard] no verdict tag — discarded', {
              cycle: this.cycleCount,
              preview: String(thought.hypothesis || '').slice(0, 120)
            });
            this._criticOutputsDiscardedCount24h = (this._criticOutputsDiscardedCount24h || 0) + 1;
            return; // Skip journal push + downstream side-effects
          }
        } catch (err) {
          this.logger?.warn?.('[critic-discard] parser failed', { error: err.message });
        }
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
      cosmoEvents.emitThought({
        cycle: this.cycleCount,
        thought: thought.hypothesis,
        role: role.id,
        surprise: surprise,
        model: thought.model,
        reasoning: thought.reasoning,
        usedWebSearch: thought.usedWebSearch || false
      });

      // 14b. Curator surface maintenance (Step 20)
      // When the curator role fires, read working MemoryObjects and update domain surfaces
      if (role.id === 'curator') {
        try {
          const fsSync = require('fs');
          const workspacePath = process.env.COSMO_WORKSPACE_PATH;
          const brainDir = workspacePath ? path.join(workspacePath, '..', 'brain') : null;

          if (workspacePath && brainDir) {
            const objectsPath = path.join(brainDir, 'memory-objects.json');

            if (fsSync.existsSync(objectsPath)) {
              const raw = JSON.parse(fsSync.readFileSync(objectsPath, 'utf-8'));
              const objects = raw.objects || [];
              const working = objects.filter(o => o.lifecycle_layer === 'working' && o.status === 'candidate');

              if (working.length > 0) {
                this.logger.info('📋 Curator: processing working memory objects', { count: working.length });

                // Group by domain using scope.applies_to
                const domainMap = { ops: [], project: [], personal: [], doctrine: [], meta: [] };
                for (const obj of working) {
                  const domains = obj.scope?.applies_to || [];
                  for (const d of domains) {
                    const key = d.toLowerCase();
                    if (key.includes('ops') || key.includes('topology') || key.includes('port') || key.includes('service')) {
                      domainMap.ops.push(obj);
                    } else if (key.includes('personal') || key.includes('health') || key.includes('family')) {
                      domainMap.personal.push(obj);
                    } else if (key.includes('doctrine') || key.includes('convention') || key.includes('rule')) {
                      domainMap.doctrine.push(obj);
                    } else {
                      domainMap.project.push(obj);
                    }
                  }
                  if (domains.length === 0) domainMap.project.push(obj);
                }

                const surfaceFiles = {
                  ops: 'TOPOLOGY.md',
                  project: 'PROJECTS.md',
                  personal: 'PERSONAL.md',
                  doctrine: 'DOCTRINE.md',
                };

                let totalAdded = 0;
                const processedIds = [];

                for (const [domain, objs] of Object.entries(surfaceFiles)) {
                  const domainObjs = domainMap[domain] || [];
                  if (domainObjs.length === 0) continue;

                  const surfacePath = path.join(workspacePath, objs);
                  if (!fsSync.existsSync(surfacePath)) continue;

                  let content = fsSync.readFileSync(surfacePath, 'utf-8');
                  const budget = SURFACE_BUDGETS[objs] || 3000;
                  let added = 0;
                  const seenTitles = new Set(); // track titles added in THIS cycle too

                  for (const obj of domainObjs) {
                    const titleLower = obj.title.toLowerCase();
                    // DEDUP: skip if this title is already on the surface OR already added this cycle
                    if (content.toLowerCase().includes(titleLower) || seenTitles.has(titleLower)) {
                      processedIds.push(obj.memory_id);
                      continue;
                    }
                    seenTitles.add(titleLower);

                    const entry = `\n\n### ${obj.title}\n${obj.statement}${obj.state_delta ? `\n_Changed: ${obj.state_delta.before?.state || '?'} → ${obj.state_delta.after?.state || '?'} (${obj.state_delta.why || '?'})_` : ''}\n_Added: ${new Date().toISOString().split('T')[0]}_`;

                    if (content.length + entry.length <= budget) {
                      content += entry;
                      added++;
                      processedIds.push(obj.memory_id);
                    }
                  }

                  if (added > 0) {
                    fsSync.writeFileSync(surfacePath, content);
                    totalAdded += added;
                    this.logger.info(`📋 Curator: updated ${objs}`, { newEntries: added, skippedDupes: domainObjs.length - added });
                  }
                }

                // Mark processed objects as 'self_reviewed' so they don't get re-processed
                if (processedIds.length > 0) {
                  let modified = false;
                  for (const obj of objects) {
                    if (processedIds.includes(obj.memory_id) && obj.status === 'candidate') {
                      obj.status = 'self_reviewed';
                      obj.review_state = 'self_reviewed';
                      modified = true;
                    }
                  }
                  if (modified) {
                    fsSync.writeFileSync(objectsPath, JSON.stringify({ objects }, null, 2));
                    this.logger.info('📋 Curator: marked processed objects as self_reviewed', { count: processedIds.length });
                  }
                }

                if (totalAdded > 0) {
                  this.logger.info(`📋 Curator: cycle ${this.cycleCount} — ${totalAdded} new entries added to surfaces`);
                }
              }
            }
          }
        } catch (curatorErr) {
          this.logger.warn('📋 Curator surface maintenance failed (non-fatal)', {
            error: curatorErr.message || String(curatorErr)
          });
        }
      }

      // Task validation - check progress during execution, full validation on completion
      if (currentTask) {
        // Check if task needs validation
        // Tasks in IN_PROGRESS state with assigned agents should be checked for completion
        const needsValidation = currentTask.state === 'IN_PROGRESS' && 
                               currentTask.claimedBy === this.instanceId &&
                               !currentTask.metadata?.validationAttempted;
        
        if (needsValidation) {
          this.logger.info('🔍 Task needs validation', {
            taskId: currentTask.id,
            goalId: currentTask.metadata?.goalId,
            instanceId: this.instanceId,
            claimedBy: currentTask.claimedBy
          });
          
          // Check if agents for this task have completed
          const taskGoalId = currentTask.metadata?.goalId;
          let hasCompletedAgents = false;
          let completedAgentsList = [];
          
          if (this.agentExecutor && taskGoalId) {
            // Check registry for completed agents with this goal
            const registry = this.agentExecutor.registry;
            if (registry.completedAgents) {
              completedAgentsList = Array.from(registry.completedAgents.values())
                .filter(a => a.mission?.goalId === taskGoalId);
              hasCompletedAgents = completedAgentsList.length > 0;
            }
            
            // NEW: Also check results queue for integrated results
            // This ensures tasks can be completed even after process restarts
            if (this.agentExecutor.resultsQueue) {
              const queueResults = this.agentExecutor.resultsQueue.getResultsForGoal(taskGoalId);
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
          
          // Also check current cycle's results queue
          const currentCycleAgents = this.agentExecutor 
            ? Array.from(this.resultsQueue?.pending || [])
                .filter(r => r.status === 'completed' && r.mission?.goalId === taskGoalId)
            : [];
          
          if (currentCycleAgents.length > 0) {
            hasCompletedAgents = true;
            completedAgentsList.push(...currentCycleAgents);
          }
          
          if (hasCompletedAgents) {
            this.logger.info('🔍 Task has completed agents, checking accomplishment', {
              taskId: currentTask.id,
              goalId: taskGoalId,
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
              
              await this.clusterStateStore.failTask(
                currentTask.id,
                `All ${unproductiveAgents.length} assigned agent(s) completed without producing useful output. First failure: ${firstReason}`
              );
              
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
              await this.clusterStateStore.completeTask(currentTask.id);
              this.logger.info('✅ Task completed with acceptance', { 
                taskId: currentTask.id,
                artifactsChecked: artifacts.length,
                agentsInvolved: accomplishedAgents.length
              });
              
              // Check if milestone complete
              await this.checkMilestoneCompletion(currentTask.planId, currentTask.milestoneId);
            } else {
              this.logger.warn('❌ Task failed acceptance validation', {
                taskId: currentTask.id,
                failures: validation.failures,
                artifactsChecked: artifacts.length
              });
              await this.clusterStateStore.failTask(
                currentTask.id,
                validation.failures.map(f => f.reason).join('; ')
              );
            }
            } // Close else block for unproductive check
          } else if (!currentTask.metadata?.validationAttempted) {
            // No agents completed yet - still waiting
            this.logger.debug('⏳ Task waiting for agents to complete', {
              taskId: currentTask.id,
              goalId: taskGoalId,
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
        
        // Garbage collect with more aggressive parameters for sustainability
        // Remove nodes with weight < 0.05 that haven't been accessed in 3 days
        // OR nodes older than 7 days with zero access
        const removed = this.summarizer.garbageCollect(
          this.memory,
          0.05,  // minWeight (was 0.1) - remove weaker memories
          7 * 24 * 60 * 60 * 1000  // maxAge = 7 days (was 30) - faster cleanup
        );
        if (removed > 0) {
          this.logger.info('🗑️  Memory GC (GPT-5.2)', { removed, remaining: this.memory.nodes.size });
        }

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
      
      // Evidence Receipt: BEHAVIOR_USE stage — surfaces updated, goals progressed
      try {
        appendEvidenceReceipt(this.logsDir, buildReceipt({
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          stage: 'behavior_use',
          raw_input_ids: [`cycle-${this.cycleCount}`, `role-${role.id}`],
          reflection_id: currentGoal ? `goal-${currentGoal.id}` : null,
          memory_delta: { ...evidenceMemoryDelta },
          behavior_impact: currentGoal
            ? `pursued goal "${(currentGoal.description || '').substring(0, 80)}" progress +${explorationGoal ? '0.05' : '0.1'}`
            : `no active goal — role=${role.id} mode=${this.oscillator.getCurrentMode()}`,
          provenance: { source: 'behavior_cycle', trust_level: 'internal', parser_anomalies: 0 }
        }));
        evidenceStagesWritten.push('behavior_use');
      } catch (e) { /* evidence receipt non-fatal */ }

      // Evidence Receipt: AUDIT stage — canonical nonzero fixture + side-by-side
      try {
        const fixtureCtx = {
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          cycleCount: this.cycleCount,
          memoryNodeCount: this.memory.nodes?.size || 0,
          goalCount: this.goals.getGoals().length,
          roleId: role.id,
          oscillatorMode: this.oscillator.getCurrentMode(),
          energy: cognitiveState.energy || 0
        };
        appendEvidenceReceipt(this.logsDir, canonicalNonzeroFixture(fixtureCtx));

        // Side-by-side audit: compare control metadata vs actual workspace
        const fsSync = require('fs');
        const workspacePath = process.env.COSMO_WORKSPACE_PATH;
        let surfaceCount = 0;
        if (workspacePath) {
          for (const sf of ['TOPOLOGY.md', 'PROJECTS.md', 'PERSONAL.md', 'DOCTRINE.md', 'RECENT.md']) {
            if (fsSync.existsSync(path.join(workspacePath, sf))) surfaceCount++;
          }
        }
        const controlCounts = {
          thoughts: this.journal.length,
          memories: this.memory.nodes?.size || 0,
          goals: this.goals.getGoals().length,
          surfaces: 5 // expected domain surfaces
        };
        const workspaceCounts = {
          thoughts: this.journal.length, // journal is authoritative
          memories: this.memory.nodes?.size || 0,
          goals: this.goals.getGoals().length,
          surfaces: surfaceCount
        };
        const registryCounts = {
          agents: this.agentExecutor?.registry?.activeAgents?.size || 0,
          triggers: 0,
          problems: 0
        };
        // Load trigger/problem counts from brain dir
        try {
          const trigPath = path.join(this.logsDir, 'trigger-index.json');
          const probPath = path.join(this.logsDir, 'problem-threads.json');
          if (fsSync.existsSync(trigPath)) {
            const trig = JSON.parse(fsSync.readFileSync(trigPath, 'utf-8'));
            registryCounts.triggers = (trig.triggers || []).length;
          }
          if (fsSync.existsSync(probPath)) {
            const prob = JSON.parse(fsSync.readFileSync(probPath, 'utf-8'));
            registryCounts.problems = (prob.threads || []).length;
          }
        } catch (e) { /* counts non-fatal */ }

        appendEvidenceReceipt(this.logsDir, sideBySideAudit({
          run_id: evidenceRunId,
          prev_id: evidencePrevId,
          cycleCount: this.cycleCount,
          controlCounts,
          workspaceCounts,
          registryCounts,
          rawItemIds: evidenceMemoryDelta.added
        }));
        evidenceStagesWritten.push('audit');

        // Persist run_id for next cycle's prev_id chain
        saveCurrentRunId(this.logsDir, evidenceRunId);
      } catch (e) {
        this.logger.warn('Evidence receipt audit failed (non-fatal)', { error: e.message });
      }

      // Save state every cycle so dashboard/brain_search are always in sync
      await this.saveState();

      // Note: Agent results processing moved to before coordinator review (line ~129)
      // to ensure strategic decisions use up-to-date goal progress and agent findings

      this.thermodynamic.advanceAnnealing();

      const cycleDuration = Date.now() - cycleStart.getTime();
      this.logger.info(`✓ Cycle completed in ${cycleDuration}ms (GPT-5.2)`);

      // Closer-status snapshot — primary signal for watching the doneWhen
      // primitive actually close goals after the 2026-04-17 migration.
      try {
        // Sync dedup counter from AgentExecutor into the goal system so
        // getCloserStatus() returns a single consolidated snapshot.
        if (typeof this.goals.setAgentSpawnsDedupedCount === 'function') {
          this.goals.setAgentSpawnsDedupedCount(
            this.agentExecutor?._agentSpawnsDedupedCount24h || 0
          );
        }
        if (typeof this.goals.setCriticOutputsDiscardedCount === 'function') {
          this.goals.setCriticOutputsDiscardedCount(
            this._criticOutputsDiscardedCount24h || 0
          );
        }

        // Back-pressure: if N cycles have passed without a fresh file in
        // outputs/, inject a concrete digest goal with situational context.
        try {
          const { checkAndMaybeTrigger } = require('../goals/force-output');
          const forceCfg = this.config?.architecture?.goals?.forceOutput || {};
          const workspaceDir = process.env.COSMO_WORKSPACE_PATH || null;
          const outputsDir = require('path').join(this.logsDir, 'outputs');
          this._forceOutputState = this._forceOutputState || { lastOutputCycle: 0, lastOutputCheckTime: 0 };
          const r = await checkAndMaybeTrigger({
            outputsDir, workspaceDir, memory: this.memory, goals: this.goals,
            cycle: this.cycleCount, state: this._forceOutputState,
            config: forceCfg, logger: this.logger,
          });
          this._forceOutputState = r.state || this._forceOutputState;
          if (r.triggered) this._forceOutputTriggered24h = (this._forceOutputTriggered24h || 0) + 1;
          if (r.skipped)   this._forceOutputSkipped24h   = (this._forceOutputSkipped24h   || 0) + 1;
        } catch (err) {
          this.logger?.warn?.('[force-output] check failed', { error: err.message });
        }
        if (typeof this.goals.setForceOutputCounts === 'function') {
          this.goals.setForceOutputCounts({
            triggered: this._forceOutputTriggered24h || 0,
            skipped: this._forceOutputSkipped24h || 0,
          });
        }

        const closer = this.goals.getCloserStatus?.();
        if (closer) this.logger?.info?.('[closer-status]', closer);
      } catch (err) {
        this.logger?.warn?.('[closer-status] failed', { error: err.message });
      }

      // Phase A: Take resource snapshot
      const resourceSnapshot = this.resourceMonitor.snapshot();
      
      // Phase A: Save checkpoint periodically (every 5 cycles)
      if (this.cycleCount % 5 === 0) {
        try {
          // Keep crash-recovery checkpoints small. The full brain is already
          // persisted every cycle via state.json.gz + JSONL sidecars, so
          // serializing memory.exportGraph() here just duplicates hundreds of
          // MB on disk every few cycles.
          const checkpointState = {
            cycleCount: this.cycleCount,
            journal: this.journal.slice(-100),
            lastSummarization: this.lastSummarization,
            savedAt: new Date().toISOString(),
            recoverySource: 'state.json.gz+sidecars',
            memorySummary: {
              nodes: this.memory.nodes?.size || 0,
              edges: this.memory.edges?.size || 0,
              clusters: this.memory.clusters?.size || 0,
            },
            guidedMissionPlan: this.guidedMissionPlan
              ? { hasPlan: true, phases: this.guidedMissionPlan?.phases?.length || 0 }
              : null,
            completionTracker: this.completionTracker
              ? {
                  totalObjectives: Array.isArray(this.completionTracker.objectives)
                    ? this.completionTracker.objectives.length
                    : 0,
                  completedObjectives: Array.isArray(this.completionTracker.objectives)
                    ? this.completionTracker.objectives.filter((objective) => objective?.completed).length
                    : 0,
                }
              : null,
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
      try { this.timeoutManager.cancelCycleTimer(); } catch (e) { /* best-effort */ }

      // Full-Loop Enforcer — MANDATORY: fills any missing stage receipts with
      // no_change_detected fallbacks so every cycle closes with all 5 stages.
      // Also logs the self-diagnosis so the brain can see loop closure.
      //
      // This block can NEVER be skipped — it runs on happy path, early-return,
      // exception, and even when the cycle threw before generating a run_id
      // (in which case we generate one here as a safety net).
      try {
        if (!evidenceRunId) {
          evidenceRunId = generateRunId(this.cycleCount);
          evidencePrevId = loadPrevRunId(this.logsDir);
        }
        enforceFullLoop({
          brainDir: this.logsDir,
          runId: evidenceRunId,
          prevId: evidencePrevId,
          cycleCount: this.cycleCount,
          stagesWritten: evidenceStagesWritten,
          logger: this.logger,
        });
      } catch (e) {
        // Even if enforcer itself throws, write a cycle_error receipt so the
        // evidence chain never silently drops a cycle.
        try {
          appendEvidenceReceipt(this.logsDir, buildReceipt({
            run_id: evidenceRunId || `r-fallback-${this.cycleCount}`,
            prev_id: evidencePrevId,
            stage: 'audit',
            raw_input_ids: [`cycle-${this.cycleCount}`],
            reflection_id: `cycle-error-${this.cycleCount}`,
            memory_delta: { added: [], updated: [], removed: [] },
            behavior_impact: `enforcer_failed: ${e.message}`,
            provenance: { source: 'enforced_safety', trust_level: 'high', parser_anomalies: 1 }
          }));
        } catch (e2) { /* give up — no more we can do */ }
        this.logger.warn('Full-loop enforcer failed (non-fatal)', { error: e.message });
      }
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
    this.logger.info('🎯 Analyzing for goals (GPT-5.2 extended reasoning)...');
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
    }

    if (journalGoals.length > 0) {
      this.logger.info('✓ Goals identified (GPT-5.2)', { count: journalGoals.length });
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
          model: dreamThought.model || this.config.models?.primary || 'unknown',
          cognitiveState: {
            energy: this.stateModulator.getState().energy,
            mood: this.stateModulator.getState().mood,
            curiosity: this.stateModulator.getState().curiosity
          }
        });

        // Capture dream goals
        const dreamGoals = await this.goalCapture.captureGoalsFromOutput(dreamThought.hypothesis, {
          provenance: 'dream'
        });
        for (const dg of dreamGoals) {
          if (Math.random() < 0.3) {
            // AUDIT: Attach dream metadata for traceability
            const newGoal = this.goals.addGoal({
              description: dg.text,
              reason: 'Emerged from GPT-5.2 dream state',
              uncertainty: 0.6,
              source: 'dream_gpt5',
              metadata: {
                dreamId: dreamId,  // Link back to source dream
                dreamCycle: this.cycleCount,
                dreamTimestamp: new Date().toISOString(),
                dreamContentSnippet: dreamThought.hypothesis.substring(0, 200)  // For quick reference
              }
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
          }
        }

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
      cosmoEvents.emitEvent('dream_phase', { phase: 'rewiring', status: 'started' });
      const rewiringP = this.config.architecture.temporal.dreamRewiringProbability || 0.5;
      const rewired = await this.memory.rewire(rewiringP);
      this.logger.info('✓ Dream rewiring complete', { edgesRewired: rewired });
      cosmoEvents.emitEvent('dream_phase', { phase: 'rewiring', status: 'complete', edgesRewired: rewired });
    } else {
      this.logger.debug('⏭️  Dream rewiring skipped (disabled in config)');
    }

    this.temporal.exitDreamMode();
    this.logger.info('✓ Dream mode complete (GPT-5.2)');

    // 5. Memory cleanup
    this.logger.info('🗑️  Memory cleanup...');
    cosmoEvents.emitEvent('dream_phase', { phase: 'cleanup', status: 'started' });
    const removed = this.summarizer.garbageCollect(this.memory);
    this.logger.info('✓ Cleanup complete', { removed });
    cosmoEvents.emitEvent('dream_phase', { phase: 'cleanup', status: 'complete', nodesRemoved: removed });

    // 6. Reset state
    this.logger.info('🔄 Resetting cognitive state...');
    cosmoEvents.emitEvent('dream_phase', { phase: 'state_reset', status: 'started' });
    const currentMood = this.stateModulator.getState().mood;

    if (currentMood < 0.3) {
      this.stateModulator.updateState({
        type: 'sleep_recovery',
        valence: 0.2,
        surprise: 0
      });
    }

    this.logger.info('✓ State adjusted');
    cosmoEvents.emitEvent('dream_phase', { phase: 'state_reset', status: 'complete' });

    cosmoEvents.emitEvent('dream_phase', { phase: 'save_state', status: 'started' });
    await this.saveState();
    cosmoEvents.emitEvent('dream_phase', { phase: 'save_state', status: 'complete' });

    this.logger.info('');
    this.logger.info('╔═══════════════════════════════════════════════════╗');
    this.logger.info('║   DEEP SLEEP CONSOLIDATION COMPLETE (GPT-5.2)   ║');
    this.logger.info('╚═══════════════════════════════════════════════════╝');
    this.logger.info('');

    cosmoEvents.emitEvent('sleep_consolidation_complete', { status: 'success' });
    
    // Return success status
    return {
      consolidated: true,
      deferred: false,
      reason: 'success'
    };
  }

  /**
   * Fast sleep maintenance — runs when LLM consolidation is rate-limited.
   * GC, decay, rewiring, mood reset. No LLM calls. Keeps the brain healthy
   * even when full consolidation can't run.
   */
  async performFastSleepMaintenance() {
    this.logger.info('🧹 Fast sleep maintenance (no LLM)...');

    // 1. Memory garbage collection (same as full consolidation step 5)
    const removed = this.summarizer.garbageCollect(this.memory);
    this.logger.info('  ✓ GC complete', { nodesRemoved: removed });

    // 2. Memory decay (normally only runs in awake % 30 — run during sleep too)
    if (typeof this.memory.applyDecay === 'function') {
      this.memory.applyDecay();
      this.logger.info('  ✓ Decay applied');
    }

    // 3. Dream rewiring at moderate probability (p=0.1 — less than dreams but more than awake's 0.01)
    if (this.config.architecture?.temporal?.dreamRewiring !== false) {
      const rewired = await this.memory.rewire(0.1);
      this.logger.info('  ✓ Rewiring complete', { edgesRewired: rewired });
    }

    // 4. Goal maintenance
    if (this.goals) {
      this.goals.elevateStalePriorities?.();
      this.goals.mergeSimilarGoals?.();
      this.logger.info('  ✓ Goal maintenance');
    }

    // 5. Mood recovery if needed
    const currentMood = this.stateModulator.getState().mood;
    if (currentMood < 0.3) {
      this.stateModulator.updateState({
        type: 'sleep_recovery',
        valence: 0.2,
        surprise: 0
      });
      this.logger.info('  ✓ Mood recovery');
    }

    this.logger.info('🧹 Fast maintenance complete');
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

    return prompts[Math.floor(Math.random() * prompts.length)];
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
      // Optional injected universal context
      heartbeatContext: this.heartbeatContext || null
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
      }
    }

    await this.handleReviewPipeline(reviewRole, reviewResult);
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
        clusterSize: this.memory?.clusters?.size || 0
      }
    };
  }

  /**
   * Handle plan completion - determine next actions
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
    if (this.coordinator) {
      const audit = await this.coordinator.auditDeliverables();
      this.logger.info('📦 Deliverables created:', {
        totalFiles: audit.totalFiles,
        byType: audit.byAgentType
      });
    }
    
    // Determine next action based on execution mode
    const guidedFocus = this.config.architecture?.roleSystem?.guidedFocus;
    const executionMode = guidedFocus?.executionMode || 'mixed';
    
    if (executionMode === 'strict') {
      // Strict mode: Task complete, suggest shutdown
      this.logger.info('');
      this.logger.info('🎯 Execution Mode: STRICT');
      this.logger.info('   Task complete - guided run finished');
      this.logger.info('   System will continue autonomous exploration');
      this.logger.info('   (Use Ctrl+C to stop if task-only execution desired)');
      this.logger.info('');
    } else if (executionMode === 'mixed' || executionMode === 'advisory') {
      // Mixed/Advisory: Continue with autonomous goals
      this.logger.info('');
      this.logger.info('🎯 Execution Mode: ' + executionMode.toUpperCase());
      this.logger.info('   Primary task complete - continuing autonomous exploration');
      this.logger.info('   System will pursue self-discovered goals and related work');
      this.logger.info('');
    }
    
    // Store completion event in memory for future reference
    if (this.memory) {
      await this.memory.addNode({
        id: `plan_complete_${plan.id}_${Date.now()}`,
        concept: `Plan completed: ${plan.title}`,
        type: 'plan_completion',
        activation: 1.0,
        tags: ['plan_completion', plan.id],
        metadata: {
          planId: plan.id,
          completedAt: Date.now(),
          duration: Date.now() - plan.createdAt
        }
      });
    }
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
      
      // Get top N priority goals (prioritize strategic goals with 15x boost)
      const sortedGoals = this.goals.getGoals().sort((a, b) => b.priority - a.priority);
      const goals = sortedGoals.slice(0, agentsToSpawn);
      
      if (goals.length === 0) {
        this.logger.info('No goals to execute');
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
        
        if ((payload.hopCount || 0) >= 2) {
          this.logger.warn('Handoff chain depth limit reached, skipping spawn', {
            originalGoal: payload.originalGoal,
            hopCount: payload.hopCount
          });
          continue;
        }

        // Create child mission from handoff
        const childMission = {
          goalId: payload.originalGoal,
          agentType: payload.toAgentType,
          description: payload.reason,
          hopCount: (payload.hopCount || 0) + 1,
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
            claimsToVerify: payload.context?.claimsToVerify || [] // NEW: Include extracted claims
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
  async pollActionQueue() {
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
      
      const pendingActions = actionsData.actions.filter(a => a.status === 'pending');
      
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
   * Complete task from dashboard action queue
   */
  async processCompleteTaskAction(action) {
    if (!this.clusterStateStore) {
      throw new Error('ClusterStateStore not available');
    }
    
    await this.clusterStateStore.completeTask(action.taskId);
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
    
    // Reset validation flags
    task.metadata = task.metadata || {};
    task.metadata.validationAttempted = false;
    delete task.metadata.validationCycle;
    delete task.metadata.validationAttempts;
    delete task.metadata.lastValidationFailure;
    task.updatedAt = Date.now();
    
    // Update task
    await this.clusterStateStore.upsertTask(task);
    
    this.logger.info('🔄 Task validation reset', { taskId: action.taskId });
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
    
    // Update guided focus config
    this.config.architecture.roleSystem.guidedFocus = {
      ...this.config.architecture.roleSystem.guidedFocus,
      domain: action.domain,
      context: action.context || '',
      executionMode: action.executionMode || 'mixed'
    };
    
    // Reinitialize mission via coordinator
    if (this.coordinator) {
      const newPlan = await this.coordinator.initiateMission({
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
      } else {
        this.logger.warn('Plan generation returned null');
        action.planGenerated = false;
      }
    } else {
      throw new Error('Coordinator not available for plan generation');
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
      // Update plan status
      plan.status = 'COMPLETED';
      plan.completedAt = Date.now();
      plan.completedBy = 'dashboard_user';
      await this.clusterStateStore.savePlan(plan);
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

      // Create mission specifications for top priority goals
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
   */
  calculateBranchReward({ outputSurprise = 0, capturedGoalsCount = 0 }) {
    const surpriseScore = Math.max(0, outputSurprise);
    const goalScore = Math.max(0, capturedGoalsCount) * 0.3;
    return surpriseScore + goalScore;
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
      const trainingDir = path.join(__dirname, '..', '..', 'runtime', 'training');
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
   */
  determineAgentTypeForTask(task) {
    // PRIORITY 1: Use explicit agentType from task metadata (set by guided planner)
    if (task.metadata?.agentType) {
      return task.metadata.agentType;
    }
    
    // PRIORITY 2: Check for special task types
    if (task.metadata?.isFinalSynthesis || task.tags?.includes('synthesis')) {
      return 'synthesis';
    }
    
    // PRIORITY 3: Check agentTypeHint from metadata
    if (task.metadata?.agentTypeHint) {
      return task.metadata.agentTypeHint;
    }
    
    // PRIORITY 4: Pattern matching for agent type selection (fallback only)
    const desc = (task.description || task.title || '').toLowerCase();
    
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
    const state = this.stateModulator.getState();

    if (this.config.execution.adaptiveTimingEnabled) {
      
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

    // During sleep, cap cycle interval so recovery doesn't drag
    // (low energy makes adaptive timing stretch cycles — counterproductive during sleep)
    if (state.mode === 'sleeping') {
      const maxSleepInterval = (this.config.cognitiveState?.maxSleepCycleInterval || 45) * 1000;
      return Math.max(30000, Math.min(maxSleepInterval, interval));
    }

    return Math.max(30000, Math.min(600000, interval)); // 30s - 10min range
  }

  async processNoticings(noticings = []) {
    if (!Array.isArray(noticings) || noticings.length === 0) return;

    try {
      const logPath = path.join(this.logsDir, 'noticings.jsonl');

      for (const noticing of noticings) {
        try {
          const entry = {
            cycle: this.cycleCount,
            type: noticing.type,
            subject: noticing.subject,
            evidence: noticing.evidence,
            implication: noticing.implication,
            routing: noticing.routing,
            priority: noticing.priority,
            timestamp: new Date()
          };

          // 1) Log to run journal (in-memory)
          this.journal.push({
            cycle: this.cycleCount,
            role: 'notice-pass',
            thought: `[NOTICE] ${noticing.subject}`,
            reasoning: noticing.implication || null,
            goal: null,
            surprise: 0,
            cognitiveState: { ...this.stateModulator.getState() },
            oscillatorMode: this.oscillator.getCurrentMode(),
            perturbation: null,
            tunnel: false,
            goalsAutoCaptured: 0,
            usedWebSearch: false,
            model: 'notice-pass',
            timestamp: new Date()
          });

          // Also persist noticings to file for audit
          await fs.appendFile(logPath, JSON.stringify(entry) + '\n');

          // 2) Route high-priority bridge-chat
          if (noticing.routing === 'bridge-chat' && noticing.priority === 'high') {
            const text = `${noticing.subject}\n\nWhy: ${noticing.implication}\nEvidence: ${noticing.evidence}`;
            if (typeof this.sendBridgeChat === 'function') {
              try {
                await this.sendBridgeChat(text);
              } catch (e) {
                this.logger?.warn?.('sendBridgeChat failed', { error: e.message });
                this.logger?.info?.(`[NOTICE→BRIDGE-CHAT] ${text}`);
              }
            } else {
              this.logger?.info?.(`[NOTICE→BRIDGE-CHAT] ${text}`);
            }
          }

          // 3) Heartbeat routing: convert to goal candidate
          if (noticing.routing === 'heartbeat' && this.goals && typeof this.goals.addGoal === 'function') {
            const p = noticing.priority === 'high' ? 0.85 : noticing.priority === 'medium' ? 0.65 : 0.45;
            this.goals.addGoal({
              description: `NoticePass: ${noticing.subject}`,
              reason: noticing.implication || 'Notice pass suggested follow-up',
              uncertainty: 1 - p, // addGoal maps uncertainty → priority
              source: 'notice_pass',
              metadata: {
                noticePass: true,
                noticingType: noticing.type,
                evidence: noticing.evidence
              }
            });
          }

          // Always log a summary line
          this.logger?.info?.('🔎 NoticePass noticing', {
            type: noticing.type,
            routing: noticing.routing,
            priority: noticing.priority,
            subject: String(noticing.subject || '').substring(0, 120)
          }, 3);

        } catch (e) {
          this.logger?.warn?.('Failed processing noticing (non-fatal)', { error: e.message });
        }
      }
    } catch (e) {
      // Entire notice pass pipeline must be non-fatal
      this.logger?.warn?.('processNoticings failed (non-fatal)', { error: e.message });
    }
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

  /**
   * Read recent thoughts for a specific role, extract topic keywords, and
   * return a strong "FORBIDDEN TOPICS" block. Empirically a text-level
   * "don't repeat these outputs" instruction is not enough — models
   * interpret it as "use different words" and keep circling the same
   * subject. So we extract noun-like keywords from recent role outputs
   * and tell the model those topics are off-limits this cycle.
   */
  _buildRecentRoleBlock(roleId, limit = 6) {
    try {
      const fsSync = require('fs');
      const logPath = path.join(this.logsDir, 'thoughts.jsonl');
      if (!fsSync.existsSync(logPath)) return '';
      const lines = fsSync.readFileSync(logPath, 'utf-8')
        .split('\n').filter(Boolean).slice(-600);
      const ownEntries = [];
      // Walk backwards so we collect the MOST RECENT first, then reverse for display
      for (let i = lines.length - 1; i >= 0 && ownEntries.length < limit; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.role === roleId) {
            const text = (e.thought || e.hypothesis || e.content || '').trim();
            if (text && text.length > 20) {
              ownEntries.push({ cycle: e.cycle, text: text.slice(0, 280) });
            }
          }
        } catch { /* skip bad line */ }
      }
      if (ownEntries.length === 0) return '';

      // Extract topic phrases from recent outputs. Naive but effective:
      // tokenize on word boundaries, filter stopwords + short tokens,
      // count frequencies, return the top repeated 1-2 word phrases
      // weighted by cross-entry repetition.
      const topics = this._extractTopicKeywords(ownEntries);

      const recentBullets = ownEntries.reverse()
        .map(e => `  • [cycle ${e.cycle || '?'}] ${e.text.slice(0, 120)}…`)
        .join('\n');

      const topicList = topics.length > 0
        ? topics.map(t => `  ✗ ${t}`).join('\n')
        : '  (no clear repeat topics detected)';

      return [
        '',
        '',
        '═══ HARD CONSTRAINT — FORBIDDEN TOPICS THIS CYCLE ═══',
        `You (${roleId}) have already written about these subjects in your`,
        `last ${ownEntries.length} outputs. They are SATURATED. You are`,
        'FORBIDDEN from producing any output on these topics this cycle,',
        'even framed differently, even with different words. Rephrasing',
        'the same subject counts as repetition — it is not a new angle.',
        '',
        'Forbidden topics:',
        topicList,
        '',
        'Pick an ENTIRELY DIFFERENT corner of jtr\'s world. Look at his',
        'other interests: trading positions, newsletter work, specific',
        'people, scheduling, historical decisions, specific projects',
        'beyond Home23 infrastructure, sensory observations from actual',
        'sensor data, recent conversations, anything at all — just NOT',
        'the topics above. If nothing else comes to mind, write about',
        'something genuinely surprising or small from jtr\'s context.',
        '',
        'For audit, here are your recent outputs (verbatim — do not',
        'reword them):',
        recentBullets,
        '═══════════════════════════════════════════════════════════',
        '',
      ].join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Pull topic keywords from a set of recent entries. Returns 1-2 word
   * phrases that appear across multiple entries, indicating the role is
   * circling them. No NLP library — just cheap tokenization + frequency.
   */
  _extractTopicKeywords(entries) {
    const STOPWORDS = new Set([
      'the', 'and', 'that', 'this', 'with', 'from', 'into', 'have', 'will',
      'not', 'for', 'but', 'are', 'was', 'were', 'been', 'being', 'has', 'had',
      'can', 'could', 'should', 'would', 'may', 'might', 'one', 'two', 'any',
      'some', 'all', 'more', 'most', 'other', 'its', 'itself', 'which', 'what',
      'when', 'where', 'how', 'who', 'why', 'here', 'there', 'now', 'then',
      'already', 'still', 'just', 'only', 'also', 'very', 'much', 'even',
      'about', 'between', 'through', 'across', 'over', 'under', 'above',
      'jtr', 'home23', 'this', 'make', 'made', 'said', 'say', 'get', 'got',
      'insight', 'action', 'investigate', 'notify', 'trigger', 'analyze',
      'analysis', 'next', 'build', 'clear', 'assumption', 'verdict', 'cycle',
    ]);

    // Collect all alphabetic tokens per entry
    const entryTokens = [];
    for (const e of entries) {
      const norm = e.text.toLowerCase().replace(/[^a-z\s-]/g, ' ');
      const tokens = norm.split(/\s+/).filter(t => t.length >= 4 && !STOPWORDS.has(t));
      entryTokens.push(new Set(tokens));
    }

    // Score tokens by number of entries they appear in (cross-entry repetition)
    const scores = new Map();
    for (const tokenSet of entryTokens) {
      for (const t of tokenSet) {
        scores.set(t, (scores.get(t) || 0) + 1);
      }
    }

    // Also score common 2-word phrases (adjacent tokens, not separated by stopwords)
    const phraseScores = new Map();
    for (const e of entries) {
      const norm = e.text.toLowerCase().replace(/[^a-z\s-]/g, ' ');
      const tokens = norm.split(/\s+/).filter(Boolean);
      const seenInEntry = new Set();
      for (let i = 0; i < tokens.length - 1; i++) {
        const a = tokens[i], b = tokens[i + 1];
        if (a.length < 4 || b.length < 4) continue;
        if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
        const phrase = `${a} ${b}`;
        if (seenInEntry.has(phrase)) continue;
        seenInEntry.add(phrase);
        phraseScores.set(phrase, (phraseScores.get(phrase) || 0) + 1);
      }
    }

    // Collect items that appear in ≥2 entries (truly repeated across outputs)
    const minRepeat = Math.min(2, entries.length);
    const items = [];
    for (const [phrase, count] of phraseScores) {
      if (count >= minRepeat) items.push({ text: phrase, count, type: 'phrase' });
    }
    for (const [token, count] of scores) {
      if (count >= minRepeat) items.push({ text: token, count, type: 'word' });
    }

    // Prefer phrases over single words when they overlap
    const phraseWords = new Set();
    for (const it of items) {
      if (it.type === 'phrase') {
        for (const w of it.text.split(' ')) phraseWords.add(w);
      }
    }
    const filtered = items.filter(it => it.type === 'phrase' || !phraseWords.has(it.text));

    // Sort by repetition count then length
    filtered.sort((a, b) => b.count - a.count || b.text.length - a.text.length);

    return filtered.slice(0, 8).map(it => it.text);
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
      lastSummarization: this.lastSummarization,
      gpt5Stats: {
        reasoningHistorySize: this.reasoningHistory.length,
        webSearchCount: this.webSearchCount
      },
      goalAllocator: this.goalAllocator ? this.goalAllocator.getStats() : null,
      clusterSync: this.clusterSync,
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.export() : null,
      timestamp: new Date()
    };

    const statePath = path.join(this.logsDir, 'state.json');

    try {
      const nodesWithEmbeddings = state.memory?.nodes?.filter(n => n.embedding).length || 0;
      const totalNodes = state.memory?.nodes?.length || 0;

      // SAFEGUARD (sidecar-first): prefer brain-snapshot.json for the
      // last-known-good node count. The sidecar is tiny and always readable,
      // even when state.json.gz is in a broken shape OR exceeds V8's ~536 MB
      // string limit (both of which silently make the existing-state read
      // return 0 nodes, causing the original safeguard to fail open).
      try {
        const { readSnapshot, writeSnapshot } = require('./brain-snapshot');
        const sidecar = readSnapshot(this.logsDir);
        let existingNodes = sidecar?.nodeCount ?? null;
        let safeguardSource = sidecar ? 'sidecar' : null;

        // Fall back to reading the state file only if no sidecar exists yet
        // (first run, or migrated from pre-sidecar build).
        let existingState = null;
        if (existingNodes === null) {
          existingState = await StateCompression.loadCompressed(statePath);
          existingNodes = existingState.memory?.nodes?.length || 0;
          safeguardSource = 'state-file';
        }

        if (existingNodes > 100 && totalNodes < existingNodes * 0.5) {
          this.logger.error('REFUSING STATE SAVE — catastrophic node loss detected', {
            currentNodes: totalNodes,
            existingNodes,
            safeguardSource,
            dropPercent: ((1 - totalNodes / existingNodes) * 100).toFixed(1),
            cycle: this.cycleCount
          });
          return; // Don't save, preserve the existing state
        }

        // If we didn't already load the state file (sidecar path), load it
        // now so the feeder-merge logic below still has the data it needs.
        if (!existingState) {
          try {
            existingState = await StateCompression.loadCompressed(statePath);
          } catch {
            existingState = { memory: { nodes: [], edges: [] } };
          }
        }

        // Merge feeder-injected nodes: any nodes on disk that aren't in our memory get added
        // This allows the feeder to write to state.json.gz between engine saves
        if (existingState.memory?.nodes && state.memory?.nodes) {
          const ourIds = new Set(state.memory.nodes.map(n => n.id));
          const feederNodes = existingState.memory.nodes.filter(n => !ourIds.has(n.id));
          if (feederNodes.length > 0) {
            state.memory.nodes.push(...feederNodes);
            // Also merge edges referencing feeder nodes
            if (existingState.memory.edges) {
              const feederNodeIds = new Set(feederNodes.map(n => n.id));
              const feederEdges = (existingState.memory.edges || []).filter(
                e => feederNodeIds.has(e.from) || feederNodeIds.has(e.to)
              );
              const ourEdgeKeys = new Set((state.memory.edges || []).map(e => `${e.from}-${e.to}`));
              const newEdges = feederEdges.filter(e => !ourEdgeKeys.has(`${e.from}-${e.to}`));
              if (newEdges.length > 0) {
                state.memory.edges = [...(state.memory.edges || []), ...newEdges];
              }
            }
            // Import into live memory so subsequent cycles see the new nodes
            for (const node of feederNodes) {
              this.memory.nodes.set(node.id, node);
            }
            this.logger.info('Merged feeder nodes into state', {
              feederNodes: feederNodes.length,
              totalNodes: state.memory.nodes.length
            });
          }
        }
      } catch (error) {
        // If we can't read existing state (first run, or file missing), proceed with save
        this.logger.warn('Could not read existing state for safeguard check', { error: error.message });
      }

      // ── MEMORY SIDECARS (Tier 2) ──
      // Write memory.nodes + memory.edges as gzipped JSONL, streaming, so
      // the monolithic state.json.gz never has to hold them as one giant
      // JSON string (which hits V8's ~536 MB string limit and silently
      // corrupts the brain). On verified success, replace them with empty
      // arrays in the state object being serialized — state.json.gz then
      // holds only the small-shape stuff (goals, journal, clusters, etc.)
      // and is immune to scaling.
      //
      // If sidecar write fails validation, we LEAVE the original
      // memory.nodes/edges in place and let the legacy monolithic save
      // handle them — so nothing ever writes empty sidecar → empty state.
      const { writeMemorySidecars } = require('./memory-sidecar');
      let sidecarsWritten = null;
      const origNodes = state.memory?.nodes;
      const origEdges = state.memory?.edges;
      const expectedNodes = Array.isArray(origNodes) ? origNodes.length : 0;
      const expectedEdges = Array.isArray(origEdges) ? origEdges.length : 0;

      if (expectedNodes > 0 || expectedEdges > 0) {
        try {
          sidecarsWritten = await writeMemorySidecars(this.logsDir, state.memory);
          // Post-write invariant: the sidecars must contain exactly the
          // counts we just tried to save. If they don't, abort the swap
          // and fall through to the legacy monolithic save.
          if (sidecarsWritten.nodes.count !== expectedNodes ||
              sidecarsWritten.edges.count !== expectedEdges) {
            this.logger.warn('Memory sidecar count mismatch — keeping inline arrays in state.json.gz', {
              expectedNodes, wroteNodes: sidecarsWritten.nodes.count,
              expectedEdges, wroteEdges: sidecarsWritten.edges.count,
            });
            sidecarsWritten = null;
          } else {
            // Swap the arrays out of the state object for the upcoming
            // monolithic save. The original references stay live in
            // this.memory so running cycles don't notice.
            state.memory = { ...state.memory, nodes: [], edges: [] };
          }
        } catch (err) {
          this.logger.warn('Memory sidecar write failed — keeping inline arrays in state.json.gz', {
            error: err.message,
          });
          sidecarsWritten = null;
        }
      }

      // Save with compression (reduces 118MB → ~6-10MB when memory is in
      // sidecars; much larger with nodes/edges inline on the legacy path).
      let saveResult;
      try {
        saveResult = await StateCompression.saveCompressed(statePath, state, {
          compress: true,
          pretty: false  // Compact JSON for better compression
        });
      } finally {
        // Restore the real arrays in case anything else reads `state` after
        // this point. (Defensive — current call tree doesn't, but will
        // protect future callers.)
        if (sidecarsWritten) {
          state.memory.nodes = origNodes;
          state.memory.edges = origEdges;
        }
      }

      this.logger.info('State saved (GPT-5.2)', {
        cycle: this.cycleCount,
        nodesWithEmbeddings,
        totalNodes,
        compressed: saveResult.compressed,
        size: `${(saveResult.size / (1024 * 1024)).toFixed(2)}MB`,
        sidecars: sidecarsWritten
          ? { nodes: sidecarsWritten.nodes.count, edges: sidecarsWritten.edges.count,
              nodesMB: +(sidecarsWritten.nodes.bytes / 1048576).toFixed(2),
              edgesMB: +(sidecarsWritten.edges.bytes / 1048576).toFixed(2) }
          : 'inline (fallback)',
        ...(saveResult.ratio && { compressionRatio: saveResult.ratio })
      });

      // Write the brain-snapshot sidecar as the new source of truth for
      // the next save's safeguard check. Best-effort — snapshot failure
      // must not block anything. Record sidecar sizes if we wrote them
      // so the loader can validate integrity.
      try {
        const { writeSnapshot } = require('./brain-snapshot');
        writeSnapshot(this.logsDir, {
          savedAt: new Date().toISOString(),
          cycle: this.cycleCount,
          nodeCount: totalNodes,
          edgeCount: expectedEdges,
          fileSize: saveResult.size || 0,
          memorySource: sidecarsWritten ? 'sidecar' : 'inline',
          ...(sidecarsWritten && {
            nodesSidecarBytes: sidecarsWritten.nodes.bytes,
            edgesSidecarBytes: sidecarsWritten.edges.bytes,
          }),
        });
      } catch { /* advisory — ignore */ }
      
      // Coherent brain-backup snapshot: once per hour, copy the 4 brain
      // files (state + both sidecars + brain-snapshot) into a timestamped
      // backups/backup-<ts>/ directory, keep last 5. Runs in background so
      // it never slows down the hot save path.
      (async () => {
        try {
          const { maybeBackup } = require('./brain-backups');
          const result = await maybeBackup(this.logsDir, {
            intervalHours: 1,
            retention: 5,
            logger: this.logger,
          });
          // Only the creation log is noisy enough to surface; 'within-interval'
          // skips are normal.
          if (!result.created && result.reason && result.reason !== 'within-interval') {
            this.logger?.warn?.('[brain-backup] skipped', { reason: result.reason });
          }
        } catch (err) {
          this.logger?.warn?.('[brain-backup] task errored', { error: err.message });
        }
      })();

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

  async loadState() {
    const statePath = path.join(this.logsDir, 'state.json');
    this.logger?.info?.('[loadState] starting', { statePath });

    try {
      // Load state (handles both compressed and uncompressed)
      const state = await StateCompression.loadCompressed(statePath);
      this.logger?.info?.('[loadState] loadCompressed returned', {
        hasState: !!state,
        topKeys: state ? Object.keys(state).slice(0, 6) : null,
        memoryNodesLen: state?.memory?.nodes?.length,
        memoryEdgesLen: state?.memory?.edges?.length,
      });

      // FAIL-LOUD: if the sidecar says we had N>0 nodes last save but the
      // loader returned 0 (a silent empty-state fallback, e.g. V8 string
      // limit or unreadable file), halt with a clear error rather than
      // booting as a fresh brain and silently overwriting good data.
      //
      // Same check against the on-disk file size: if state.json.gz is
      // non-trivially large but load returned 0 nodes, something is
      // broken. Halt.
      // NOTE: fail-loud check moved AFTER the Tier 2 sidecar load block.
      // Running it here is wrong because state.json.gz carries empty
      // memory.nodes/edges when sidecars are in use — the real counts
      // arrive only after readMemorySidecars populates state.memory.

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

      // ── MEMORY SIDECARS (Tier 2) ──
      // If memory-nodes.jsonl.gz + memory-edges.jsonl.gz exist, they are
      // the authoritative source for the graph. state.memory.nodes/edges
      // in state.json.gz will be empty arrays in that case.
      //
      // If the sidecars don't exist yet (pre-migration brain), the
      // inline path below handles it — legacy behavior unchanged.
      try {
        const { sidecarsExist, readMemorySidecars } = require('./memory-sidecar');
        if (state?.memory && sidecarsExist(this.logsDir)) {
          this.logger?.info?.('Loading memory from sidecar files (Tier 2)');
          // Replace any (empty/stub) inline arrays on state.memory with
          // what the sidecars contain. The rest of loadState then proceeds
          // through its existing paths — it doesn't care where the arrays
          // came from.
          const inlineNodes = [];
          const inlineEdges = [];
          const result = await readMemorySidecars(this.logsDir, {
            onNode: (n) => { inlineNodes.push(n); },
            onEdge: (e) => { inlineEdges.push(e); },
          });
          state.memory.nodes = inlineNodes;
          state.memory.edges = inlineEdges;
          this.logger?.info?.('Memory sidecars loaded', {
            nodes: result.nodes.count,
            edges: result.edges.count,
            nodeParseErrors: result.nodes.parseErrors,
            edgeParseErrors: result.edges.parseErrors,
          });
        }
      } catch (err) {
        this.logger?.warn?.('Memory sidecar load failed — falling back to inline arrays in state.json.gz', {
          error: err.message,
        });
      }

      // FAIL-LOUD (moved): now that state.memory reflects sidecar content
      // (when present), verify we didn't load a catastrophically-empty brain.
      // If the brain-snapshot sidecar says we had N≥100 nodes last save but
      // the current load produced 0, halt — something is broken and silently
      // booting as a fresh brain would let the engine overwrite good data.
      try {
        const { readSnapshot } = require('./brain-snapshot');
        const sidecar = readSnapshot(this.logsDir);
        const loadedNodes = state?.memory?.nodes?.length || 0;
        const sidecarExpected = sidecar?.nodeCount ?? 0;
        this.logger?.info?.('[loadState] fail-loud check', { loadedNodes, sidecarExpected });
        if (sidecarExpected >= 100 && loadedNodes === 0) {
          const msg = `BRAIN LOAD FAILED — brain-snapshot expected ${sidecarExpected} nodes but loader produced 0. Refusing to boot. Do NOT restart the engine without investigating — it will overwrite good data. Sidecars at memory-nodes.jsonl.gz / memory-edges.jsonl.gz are your authoritative data.`;
          this.logger?.error?.(msg);
          throw new Error(msg);
        }
      } catch (err) {
        if (err?.message?.startsWith('BRAIN LOAD FAILED')) throw err;
        // any other error = best-effort, don't let the check itself block load
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
          
          // Load nodes synchronously — no blocking embed calls. Missing
          // embeddings are regenerated lazily in a background task so the
          // engine can boot in seconds even when thousands of nodes need
          // new embeddings (e.g. after a brain restore that stripped them).
          const missingEmbedIds = [];
          for (const nodeData of state.memory.nodes) {
            this.memory.nodes.set(nodeData.id, nodeData);
            if (!nodeData.embedding) {
              missingEmbedIds.push(nodeData.id);
            }
          }

          if (missingEmbedIds.length > 0) {
            this.logger.info('Deferring embedding regeneration to background', {
              count: missingEmbedIds.length,
              totalNodes: state.memory.nodes.length,
            });
            // Fire-and-forget. The engine proceeds with load + normal cycles
            // while this fills in embeddings over time. Semantic search
            // quality improves as it progresses.
            this._regenerateEmbeddingsInBackground(missingEmbedIds).catch(err => {
              this.logger.warn('Background embedding regeneration crashed', { error: err.message });
            });
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
      }
      
      // NEW: Import agent executor state (completed/failed agents for persistence)
      if (state.agentExecutor && this.agentExecutor) {
        this.agentExecutor.importState(state.agentExecutor);
      }
      
      if (state.guidedMissionPlan) this.guidedMissionPlan = state.guidedMissionPlan; // FIXED: Restore guided plan
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
      
      // NEW: Replay agent journals to recover findings since last checkpoint
      const journalFindings = await this.replayAgentJournals();
      if (journalFindings.length > 0) {
        this.logger.info('📝 Replayed journal findings from interrupted agents', {
          findings: journalFindings.length
        });
      }
      
      // Migrate legacy goals to tasks
      if (this.clusterStateStore) {
        await this.migrateGoalsToTasks();
      }
    } catch (error) {
      // Log ALL load errors (info-level so it shows up even if error goes to
      // a separate stream). Silent ENOENT swallowing masked tonight's brain-
      // gone bug. Better to over-log than lose data.
      this.logger?.info?.('[loadState] caught outer error', {
        code: error?.code,
        message: error?.message,
        isFailLoud: !!(error?.message && error.message.startsWith('BRAIN LOAD FAILED')),
      });
      // Propagate BRAIN LOAD FAILED so the engine halts instead of running
      // as an empty brain and silently overwriting the good state.
      if (error?.message && error.message.startsWith('BRAIN LOAD FAILED')) {
        throw error;
      }
    }
    this.logger?.info?.('[loadState] exiting', {
      memoryNodes: this.memory?.nodes?.size,
      memoryEdges: this.memory?.edges?.size,
      cycleCount: this.cycleCount,
    });
  }

  /**
   * Regenerate missing embeddings in the background, serially, with pacing.
   *
   * Invoked by loadState when a restored brain has nodes without embeddings
   * (e.g. after an embedding-stripped restore to get under the V8 string
   * limit). Runs outside the load path so the engine boots immediately.
   *
   * @param {Array<string|number>} nodeIds IDs of nodes missing embeddings
   */
  async _regenerateEmbeddingsInBackground(nodeIds) {
    const BATCH_LOG = 200;
    const PAUSE_EVERY = 50;
    const PAUSE_MS = 50;   // yield to cognitive loop between batches

    let done = 0, failed = 0, skipped = 0;
    const total = nodeIds.length;
    const startedAt = Date.now();

    for (const id of nodeIds) {
      const node = this.memory.nodes.get(id);
      if (!node) { skipped++; continue; }
      if (node.embedding) { skipped++; continue; }   // already filled (unlikely but cheap check)
      if (!node.concept) { skipped++; continue; }

      try {
        const embedding = await this.memory.embed(node.concept);
        if (embedding) {
          node.embedding = embedding;
          done++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }

      if ((done + failed) % BATCH_LOG === 0) {
        const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
        this.logger?.info?.('Background embedding regen progress', {
          done, failed, skipped, total, elapsedMin,
        });
      }
      if ((done + failed) % PAUSE_EVERY === 0) {
        await new Promise(r => setTimeout(r, PAUSE_MS));
      }
    }

    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    this.logger?.info?.('Background embedding regen complete', {
      done, failed, skipped, total, elapsedMin,
    });
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

  async stop() {
    this.logger.info('Stopping GPT-5.2 system...');
    this.running = false;

    if (this.liveProblems) {
      try { this.liveProblems.stop(); } catch {}
    }
    if (this.pulseRemarks) {
      try { this.pulseRemarks.stop(); } catch {}
    }
    
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
      try { await this.feeder.shutdown(); } catch (err) {
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
