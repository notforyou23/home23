const fs = require('fs').promises;
const path = require('path');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const { UnifiedClient } = require('../core/unified-client');
const { TemplateReportGenerator } = require('./template-generator');
const { StrategicGoalsTracker } = require('./strategic-goals-tracker');
const { InsightsParser } = require('./insights-parser');
const { getAgentTimeout } = require('../config/agent-timeouts');
const { parseWithFallback } = require('../core/json-repair');
const { getDomainAnchor, filterDomainRelevant } = require('../utils/domain-anchor');
const { CapabilityManifest } = require('../execution/capability-manifest');

// Real-time event streaming - fallback singleton for CLI mode
// Multi-tenant mode uses injected eventEmitter from options
let _singletonEvents = null;
function getSingletonEvents() {
  if (!_singletonEvents) {
    _singletonEvents = require('../realtime/event-emitter').cosmoEvents;
  }
  return _singletonEvents;
}

/**
 * Meta-Coordinator Agent
 * 
 * Sits above Phase 2B autonomous cognition to:
 * 1. Review accumulated thoughts, goals, and memory patterns
 * 2. Prioritize which goals deserve focused pursuit
 * 3. Generate strategic directives for future work
 * 4. Maintain context across review cycles
 * 5. Report comprehensive summaries of cognitive work
 */
class MetaCoordinator {
  constructor(config, logger, pathResolver = null, capabilities = null, eventEmitter = null, orchestrator = null) {
    this.config = config.coordinator || {};
    this.fullConfig = config; // Store full config for guided mode access
    this.logger = logger;
    this.pathResolver = pathResolver; // NEW: PathResolver for deliverable audits
    this.capabilities = capabilities; // NEW: Capabilities for embodied file operations
    this.orchestrator = orchestrator; // For voice capability
    this.gpt5 = new UnifiedClient(config, logger);
    
    // VOICE: Direct channel to human partner
    this.voiceEnabled = config?.voice?.enabled !== false;

    // Multi-tenant event emitter (injected for context isolation)
    this.events = eventEmitter;

    // Cluster specialization context (used for goal routing bias)
    this.instanceId = (process.env.INSTANCE_ID || 'cosmo-1').toLowerCase();
    const specializationSetup = this.initializeSpecialization(config.cluster, this.instanceId);
    this.specializationProfile = specializationSetup?.profile || null;
    this.specializationDefaults = specializationSetup?.defaults || null;
    this.specializationDisplayName = specializationSetup?.displayName || null;
    this.lastSpecializationRouting = null;
    
    // Template generator for token optimization
    this.templateGenerator = new TemplateReportGenerator(logger);
    
    // Strategic Goals Tracker - closes the execution loop
    this.strategicTracker = new StrategicGoalsTracker(logger);
    
    // Insights Parser - extracts actionable next steps from curated insights
    this.insightsParser = new InsightsParser(logger);
    
    // Configuration
    // Read from coordinator section of config (config.coordinator.X)
    // or fall back to top-level for backward compatibility
    const coordConfig = this.config.coordinator || this.config;
    this.enabled = coordConfig.enabled !== false; // Default to true
    this.reviewInterval = coordConfig.reviewCyclePeriod || 50;
    this.codingAgentsEnabled = coordConfig.enableCodingAgents !== false;
    
    // State tracking across reviews
    this.reviewHistory = [];
    this.lastReviewCycle = 0;
    this.strategicDirectives = [];
    this.contextMemory = []; // Maintain context across reviews
    this.prioritizedGoals = [];
    
    // NEW: Agent type distribution tracking for diversity
    this.agentTypeHistory = []; // Track last N spawned agents
    this.agentTypeHistoryLimit = 20; // Keep last 20 agents
    this.lastSynthesisReview = 0; // Track when we last did synthesis
    this.lastDocumentCreationReview = 0; // Track when we last spawned document_creation
    this.lastCodeCreationReview = 0; // Track when we last spawned code_creation
    this.lastDeliverablesAudit = null; // Store latest deliverables audit for gap-driven spawning
    this.activeGoalsSystem = null; // Live reference to IntrinsicGoalSystem for goal injection
    
    // Directories - use PathResolver for multi-tenant isolation
    // PRODUCTION: PathResolver.getCoordinatorDir() returns user-specific path
    // CRITICAL: Fallback chain - pathResolver > config.logsDir > __dirname
    this.coordinatorDir = pathResolver
      ? pathResolver.getCoordinatorDir()
      : (config?.logsDir
          ? path.join(config.logsDir, 'coordinator')
          : path.join(__dirname, '..', '..', 'runtime', 'coordinator'));

    // Message handling for agent coordination
    this.messageHandlers = new Map();
    this.setupMessageHandlers();
    
    // Architecture context cache (loaded once per session)
    this._architectureContext = null;
    this._templatesDir = path.join(__dirname, '..', '..', 'templates');
  }

  /**
   * Get the event emitter for this coordinator context.
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

  // ═══════════════════════════════════════════════════════════════════════════
  // VOICE: Meta-Coordinator's direct channel to human partner
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Speak to human partner (delegates to orchestrator if available)
   */
  async voice(message) {
    if (!this.voiceEnabled) return;
    
    if (this.orchestrator?.voice) {
      return this.orchestrator.voice(`[Strategic] ${message}`);
    }
    
    // Fallback: emit as event
    this._getEvents().emitEvent('cosmo_voice', {
      id: `voice_meta_${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `[Strategic] ${message}`,
      source: 'meta-coordinator'
    });
  }

  /**
   * Get voice context for prompts
   */
  getVoiceContext() {
    if (!this.voiceEnabled) return '';
    return `\n\nYou have a voice channel - a direct line to the human partner. If you have strategic insights, notice important patterns across the work, or want to share observations about where things are headed, you can speak by writing [VOICE]: followed by what you want to say. Use it when you want to, or don't. It's yours.`;
  }

  /**
   * Parse output for [VOICE]: markers (delegates to orchestrator)
   */
  parseForVoice(output) {
    if (!this.voiceEnabled || !output) return output;
    
    if (this.orchestrator?.parseForVoice) {
      return this.orchestrator.parseForVoice(output);
    }
    
    // Fallback: parse locally and emit event
    const voicePattern = /\[VOICE\]:\s*([\s\S]*?)(?=\[VOICE\]:|$)/gi;
    const matches = output.match(voicePattern);
    
    if (matches) {
      for (const match of matches) {
        const message = match.replace(/\[VOICE\]:\s*/i, '').trim();
        if (message && message.length > 0) {
          this._getEvents().emitEvent('cosmo_voice', {
            id: `voice_meta_${Date.now()}`,
            timestamp: new Date().toISOString(),
            message: `[Strategic] ${message}`,
            source: 'meta-coordinator'
          });
          this.logger.info('🗣️  COSMO SPEAKS (Strategic):', { preview: message.substring(0, 100) });
        }
      }
    }
    
    return output.replace(voicePattern, '').trim();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ARCHITECTURE CONTEXT - System-level knowledge for strategic decisions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get architecture context for strategic decision-making
   * Loaded once per session and cached for efficiency
   * @returns {Promise<string>} Architecture context summary
   */
  async getArchitectureContext() {
    // Return cached context if available
    if (this._architectureContext) {
      return this._architectureContext;
    }

    try {
      // Load the architecture reference template
      const archPath = path.join(this._templatesDir, 'COSMO_ARCHITECTURE_REFERENCE.md');
      const visualPath = path.join(this._templatesDir, 'ARCHITECTURE_VISUAL_GUIDE.md');
      
      let archContent = '';
      let visualContent = '';
      
      try {
        archContent = await fs.readFile(archPath, 'utf8');
      } catch (e) {
        this.logger.debug('[MetaCoordinator] Architecture reference not found', { error: e.message });
      }
      
      try {
        visualContent = await fs.readFile(visualPath, 'utf8');
      } catch (e) {
        this.logger.debug('[MetaCoordinator] Visual guide not found', { error: e.message });
      }

      // Extract key sections for coordinator context
      const ideFirstEnabled = this.fullConfig?.ideFirst?.enabled === true;
      
      this._architectureContext = `
═══════════════════════════════════════════════════════════════════════════
COSMO SYSTEM ARCHITECTURE CONTEXT (Meta-Coordinator Reference)
═══════════════════════════════════════════════════════════════════════════

You are the META-COORDINATOR - the strategic decision-making center of COSMO.
You sit above all subsystems and make high-level decisions about goal prioritization,
agent spawning, and resource allocation.

BRAIN ANALOGY:
┌─────────────────────────────────────────────────────────────────────┐
│  • Dorsolateral PFC (dlPFC) → Executive Ring (reality checking)     │
│  • Basal Ganglia → Agent Router (action selection, gating)          │
│  • Hippocampus → Memory System (graph-based, Hebbian learning)      │
│  • Motor Cortex → IDE Agent (COSMO's hands - file ops, execution)   │
│  • Ventral Striatum → Goal System (intrinsic motivation)            │
└─────────────────────────────────────────────────────────────────────┘

AGENT ECOSYSTEM (Current Paradigm: ${ideFirstEnabled ? 'IDE-FIRST' : 'LEGACY'}):
${ideFirstEnabled ? `
★ IDE-FIRST MODE ACTIVE ★
- IDE Agent is the PRIMARY agent for most tasks (code, docs, analysis, synthesis)
- Research Agent used ONLY for web search and source gathering
- Other specialized agents available but prefer IDE Agent for faster execution
- IDE Agent has direct file system access, semantic search, terminal execution
` : `
Legacy Mode: Specialized agents for each task type
- Research Agent: Web search, source gathering
- Analysis Agent: Deep analysis and evaluation
- Synthesis Agent: Combining insights across domains
- Code Creation Agent: Generate code artifacts
- Document Creation Agent: Generate reports and documentation
`}

DUAL DIRECTORY STRUCTURE (Critical for deliverable tracking):
- /agents/agent_<id>/ → Agent METADATA (findings.jsonl, insights.jsonl)
- /outputs/<type>/agent_<id>/ → Agent DELIVERABLES (actual files, manifest, .complete)

GOAL SYSTEM:
- Goals are self-discovered through uncertainty and curiosity
- Prioritized by uncertainty (pursue what's least understood)
- Max N active goals simultaneously (gated by Executive Ring)
- Goals rotate after N unsuccessful pursuits

COGNITIVE CYCLE (Your Review Cycle):
1. Temporal Rhythm Updates → 2. Agent Result Processing → 3. Introspection →
4. Memory Governance → 5. Strategic Coordination (YOU) → 6. Sleep/Dream →
7. Agent Spawning → 8. Executive Ring Check → [Repeat]

PATH RESOLUTION:
- Always use @outputs/ prefix for deliverable paths
- PathResolver converts to absolute user-specific run-isolated paths

MEMORY ARCHITECTURE:
- Small-world graph topology (high clustering, short paths)
- Hebbian learning: co-activated concepts strengthen connections
- Exponential decay on unused connections (but agent insights exempt)
- Spreading activation propagates relevance

YOUR RESPONSIBILITIES AS META-COORDINATOR:
1. Review cognitive work and goal progress
2. Prioritize goals based on strategic value and uncertainty
3. Spawn appropriate agents (prefer IDE Agent in IDE-First mode)
4. Detect stuck loops and contradictions
5. Generate strategic directives for next review period
6. Close the execution loop - ensure tangible outputs

═══════════════════════════════════════════════════════════════════════════
`;
      
      this.logger.info('[MetaCoordinator] Architecture context loaded and cached');
      return this._architectureContext;
    } catch (error) {
      this.logger.warn('[MetaCoordinator] Failed to load architecture context', { error: error.message });
      return ''; // Return empty string on failure, prompt still works
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COSMO HANDS - Direct Action System
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Determine if a goal can be handled directly (no agent needed)
   * 
   * Direct action criteria:
   * - Single file operation (read, write, edit)
   * - Simple terminal command
   * - Content already generated (from LLM reasoning)
   * - Goal marked for direct execution
   * 
   * @param {Object} goal - Goal to evaluate
   * @param {Object} context - Current execution context { cycleCount }
   * @returns {Object} - { direct: boolean, action?: object, reason?: string }
   */
  canHandleDirectly(goal, context = {}) {
    // Check if capabilities are available
    if (!this.capabilities || !this.capabilities.enabled) {
      return { direct: false, reason: 'Capabilities not available' };
    }
    
    // Check config flag
    // Direct action is disabled by default - must be explicitly enabled in config
    if (this.fullConfig?.directAction?.enabled !== true) {
      return { direct: false, reason: 'Direct action not enabled in config' };
    }
    
    // Pattern 1: Goal has deliverable content ready (from LLM synthesis)
    if (goal.metadata?.deliverableContent && goal.metadata?.deliverablePath) {
      return { 
        direct: true, 
        action: {
          type: 'write',
          path: goal.metadata.deliverablePath,
          content: goal.metadata.deliverableContent
        },
        reason: 'Deliverable content ready'
      };
    }
    
    // Pattern 2: Goal explicitly marked for direct execution
    if (goal.metadata?.directExecution === true) {
      // Must have action spec in metadata
      if (goal.metadata?.directAction) {
        return {
          direct: true,
          action: goal.metadata.directAction,
          reason: 'Explicitly marked for direct execution'
        };
      }
    }
    
    // Pattern 3: Simple terminal command (not requiring agent reasoning)
    if (goal.metadata?.command && !goal.metadata?.requiresAgent) {
      // Safety check - only allow simple commands
      const cmd = goal.metadata.command;
      const isSimple = !cmd.includes('&&') && !cmd.includes('||') && !cmd.includes(';');
      
      if (isSimple) {
        return {
          direct: true,
          action: {
            type: 'run',
            command: cmd
          },
          reason: 'Simple terminal command'
        };
      }
    }
    
    // Default: Requires agent (multi-step work, complex reasoning, etc.)
    return { direct: false, reason: 'Requires multi-step agent work' };
  }

  /**
   * Execute direct action (bypass agent spawning)
   * 
   * CRITICAL: This method integrates with ALL existing systems:
   * 1. Event emission (emitDirectAction, emitGoalCompleted)
   * 2. Goal completion (IntrinsicGoalSystem.completeGoal)
   * 3. Deliverable recording (recordGoalDeliverable)
   * 4. Task state updates (clusterStateStore.completeTask)
   * 5. Memory integration (memory.addNode)
   * 6. File verification (fs.access)
   * 7. Journal entries (findings.jsonl)
   * 8. Completion markers (.complete file)
   * 9. Deliverable manifests (manifest.json)
   * 
   * @param {Object} goal - Goal being executed
   * @param {Object} action - Action specification { type, path?, content?, command? }
   * @param {Object} context - Execution context { cycleCount }
   * @returns {Object} - { success: boolean, ...result }
   */
  async executeDirectAction(goal, action, context = {}) {
    const startTime = Date.now();
    const directActionId = `direct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const agentContext = {
      agentId: directActionId,
      agentType: 'direct_action',
      missionGoal: goal.id,
      cycleCount: context.cycleCount || 0
    };
    
    this.logger.info('🤲 Direct action starting', {
      actionId: directActionId,
      goalId: goal.id,
      actionType: action.type,
      path: action.path?.substring(0, 80) || null
    });
    
    // Execute via Capabilities (includes executive gating and frontier logging)
    const result = await this.capabilities.do(action, agentContext);
    const duration = Date.now() - startTime;
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 1: Emit direct action event (frontend visibility)
    // ═══════════════════════════════════════════════════════════════════════
    this._getEvents().emitDirectAction({
      actionType: action.type,
      goalId: goal.id,
      taskId: goal.metadata?.taskId || null,
      path: action.path || null,
      success: result.success !== false,
      duration,
      cycle: context.cycleCount,
      error: result.error || null
    });
    
    // If action failed, don't complete goal
    if (result.success === false) {
      this.logger.warn('🤲 Direct action failed', {
        actionId: directActionId,
        goalId: goal.id,
        error: result.error || result.reason
      });
      return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 2: Verify file existence (if write operation)
    // ═══════════════════════════════════════════════════════════════════════
    if (action.type === 'write' || action.type === 'create') {
      try {
        await fs.access(result.path, fs.constants.R_OK);
        const stats = await fs.stat(result.path);
        result.verified = true;
        result.verifiedSize = stats.size;
        this.logger.info('✅ Direct action deliverable verified', { 
          path: result.path, 
          size: stats.size 
        });
      } catch (error) {
        result.verified = false;
        result.verificationError = error.message;
        this.logger.error('❌ Direct action deliverable missing after write', { 
          path: result.path, 
          error: error.message 
        });
        // Don't complete goal if file doesn't exist
        return result;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 3: Write journal entry (findings.jsonl)
    // ═══════════════════════════════════════════════════════════════════════
    const journalDir = this.pathResolver 
      ? path.join(this.pathResolver.getRuntimeRoot(), 'agents', 'direct_action')
      : (this.fullConfig?.logsDir 
          ? path.join(this.fullConfig.logsDir, 'agents', 'direct_action')
          : null);
    
    if (journalDir) {
      try {
        await fs.mkdir(journalDir, { recursive: true });
        const journalPath = path.join(journalDir, 'findings.jsonl');
        const journalEntry = JSON.stringify({
          type: 'direct_action',
          actionId: directActionId,
          goalId: goal.id,
          actionType: action.type,
          path: action.path || null,
          success: true,
          duration,
          cycle: context.cycleCount,
          timestamp: new Date().toISOString()
        }) + '\n';
        await fs.appendFile(journalPath, journalEntry);
      } catch (error) {
        this.logger.debug('Failed to write journal entry', { error: error.message });
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 4: Record deliverable (if file output)
    // ═══════════════════════════════════════════════════════════════════════
    if ((action.type === 'write' || action.type === 'create') && this.phase2bSubsystems?.goals) {
      try {
        this.phase2bSubsystems.goals.recordGoalDeliverable(goal.id, {
          title: `Direct action: ${path.basename(action.path || 'output')}`,
          path: result.path,
          format: action.path?.split('.').pop() || 'txt',
          wordCount: action.content?.split(/\s+/).length || 0,
          createdAt: new Date().toISOString(),
          agentId: directActionId,
          agentType: 'direct_action',
          verified: result.verified
        });
      } catch (error) {
        this.logger.debug('Failed to record deliverable', { error: error.message });
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 5: Update task state (if plan-linked)
    // ═══════════════════════════════════════════════════════════════════════
    const taskId = goal.metadata?.taskId;
    if (taskId && this.phase2bSubsystems?.clusterStateStore) {
      try {
        // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Use queue if available
        if (this.orchestrator?.taskStateQueue) {
          await this.orchestrator.taskStateQueue.enqueue({
            type: 'COMPLETE_TASK',
            taskId: taskId,
            cycle: this.orchestrator.cycleCount || 0,
            source: 'meta_coordinator_direct_action'
          });
        } else {
          // Fallback to direct write if queue not available
          await this.phase2bSubsystems.clusterStateStore.completeTask(taskId);
        }
        this.logger.info('✅ Task marked complete via direct action', { taskId });
      } catch (error) {
        this.logger.warn('Failed to complete task', { taskId, error: error.message });
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 6: Log direct action completion
    // ═══════════════════════════════════════════════════════════════════════
    if (action.type === 'write' || action.type === 'create') {
      this.logger.info('Direct action completed', {
        actionType: action.type,
        path: action.path,
        goalId: goal.id,
        taskId: taskId || null,
        actionId: directActionId,
        size: result.verifiedSize || action.content?.length || 0,
        verified: result.verified,
        cycle: context.cycleCount
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 7: Write completion marker (.complete file)
    // ═══════════════════════════════════════════════════════════════════════
    if ((action.type === 'write' || action.type === 'create') && result.path) {
      const outputDir = path.dirname(result.path);
      try {
        const markerPath = path.join(outputDir, '.complete');
        const markerContent = JSON.stringify({
          completedAt: new Date().toISOString(),
          agentId: directActionId,
          agentType: 'direct_action',
          goalId: goal.id,
          actionType: action.type,
          success: true,
          verified: result.verified,
          fileCount: 1
        }, null, 2);
        await fs.writeFile(markerPath, markerContent);
      } catch (error) {
        this.logger.debug('Failed to write completion marker', { error: error.message });
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 8: Write deliverable manifest (manifest.json)
    // ═══════════════════════════════════════════════════════════════════════
    if ((action.type === 'write' || action.type === 'create') && result.path) {
      const outputDir = path.dirname(result.path);
      try {
        const manifestPath = path.join(outputDir, 'manifest.json');
        const manifest = {
          manifestVersion: '2.0.0',
          agentId: directActionId,
          agentType: 'direct_action',
          goalId: goal.id,
          missionId: null,
          spawnCycle: context.cycleCount,
          spawnedBy: 'meta_coordinator_direct',
          triggerSource: 'direct_action',
          spawningReason: 'goal_direct_execution',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          canonical: false,
          supersedes: [],
          supersededBy: null,
          deliverableType: 'direct_action_output',
          files: [{
            filename: path.basename(result.path),
            path: result.path,
            size: result.verifiedSize || action.content?.length || 0,
            verified: result.verified
          }],
          integrationStatus: 'integrated',
          missionDescription: goal.description
        };
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      } catch (error) {
        this.logger.debug('Failed to write manifest', { error: error.message });
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // INTEGRATION 9: Mark goal as completed
    // This internally triggers:
    // - emitGoalCompleted()
    // - goalAllocator.completeGoal() (if cluster)
    // - curatorCallback()
    // ═══════════════════════════════════════════════════════════════════════
    if (this.phase2bSubsystems?.goals) {
      this.phase2bSubsystems.goals.completeGoal(
        goal.id, 
        `Completed via direct action (${action.type}) in ${duration}ms`
      );
    }
    
    this.logger.info('✅ Direct action completed', { 
      actionId: directActionId,
      goalId: goal.id,
      actionType: action.type,
      duration: `${duration}ms`,
      verified: result.verified
    });
    
    return {
      ...result,
      directActionId,
      duration,
      completed: true
    };
  }

  /**
   * Initiate guided mission at startup
   * Coordinator owns mission lifecycle: assessment, planning, execution, monitoring
   * 
   * @param {Object} options - { guidedFocus, forceNew, subsystems: { agentExecutor, goals, clusterStateStore, pathResolver } }
   * @returns {Object} mission plan
   */
  async initiateMission(options) {
    const { guidedFocus, forceNew, subsystems } = options;
    
    this.logger.info('');
    this.logger.info('╔══════════════════════════════════════════════════════╗');
    this.logger.info('║        GUIDED MODE PLANNER - MISSION SETUP           ║');
    this.logger.info('╚══════════════════════════════════════════════════════╝');
    this.logger.info('');
    
    // Use GuidedModePlanner as planning helper
    const { GuidedModePlanner } = require('../core/guided-mode-planner');
    const { UnifiedClient } = require('../core/unified-client');
    
    const plannerClient = new UnifiedClient(this.fullConfig, this.logger);
    const guidedPlanner = new GuidedModePlanner(
      this.fullConfig,
      {
        client: plannerClient,
        agentExecutor: subsystems.agentExecutor,
        coordinator: this, // Pass self for coordination
        goals: subsystems.goals,
        clusterStateStore: subsystems.clusterStateStore,
        pathResolver: subsystems.pathResolver,
        memory: subsystems.memory || this.memory || this.orchestrator?.memory || null
      },
      this.logger
    );
    
    // Generate plan via helper (pass forceNew flag if provided)
    const plan = await guidedPlanner.planMission({ forceNew: options.forceNew || false });
    
    if (!plan) {
      this.logger.warn('⚠️  No plan generated - proceeding without guided plan');
      return null;
    }
    
    // Store plan in coordinator state
    this.activeMissionPlan = plan;
    
    // Display and save plan (unless silent mode)
    const silentPlanning = guidedFocus?.silentPlanning || false;

    if (!silentPlanning) {
      const { PlanPresenter } = require('../core/plan-presenter');
      const presenter = new PlanPresenter(this.logger);

      const planDisplay = presenter.displayPlan(plan, guidedFocus);
      this.logger.info(planDisplay);

      const path = require('path');
      await presenter.savePlanToFile(
        plan,
        guidedFocus,
        // PRODUCTION: Use pathResolver for user-specific runtime path
        // CRITICAL: Fallback chain - pathResolver > config.logsDir > process.cwd()
        subsystems?.pathResolver
          ? path.join(subsystems.pathResolver.getRuntimeRoot(), 'guided-plan.md')
          : (this.config?.logsDir
              ? path.join(this.config.logsDir, 'guided-plan.md')
              : path.join(process.cwd(), 'runtime', 'guided-plan.md')),
        {
          capabilities: subsystems?.capabilities,
          agentContext: { agentId: 'meta_coordinator', agentType: 'coordinator', missionGoal: guidedFocus?.domain }
        }
      );
    } else {
      this.logger.info('🔇 Silent planning mode - plan generated but not displayed');
    }

    // NOW spawn agents - AFTER plan is displayed
    // This ensures user sees the plan before execution begins
    let planningAgentIds = [];
    if (plan._deferredSpawn?.shouldSpawn) {
      planningAgentIds = await guidedPlanner.executeDeferredSpawn(plan);
    }

    this.logger.info('✅ Guided mode plan stored', {
      taskPhases: plan.taskPhases?.length || 0,
      taskGoals: plan.taskGoals?.length || 0,
      executionMode: plan.executionMode,
      planningAgentsSpawned: planningAgentIds.length,
      silentPlanning
    });

    this.logger.info('');

    // Return both plan and agent IDs for waiting
    return {
      plan: plan,
      planningAgentIds: planningAgentIds
    };
  }

  /**
   * Set up message handlers for agent coordination
   */
  setupMessageHandlers() {
    // Handler for spawning completion agents
    this.messageHandlers.set('spawn_completion_agent', async (payload) => {
      return await this.handleSpawnCompletionAgent(payload);
    });

    // Handler for spawning QA agents (triggered by document/code creation)
    this.messageHandlers.set('spawn_qa_agent', async (payload) => {
      return await this.handleSpawnQAAgent(payload);
    });

    // Handler for spawning CodeExecutionAgent (triggered by code creation)
    this.messageHandlers.set('spawn_code_execution_agent', async (payload) => {
      return await this.handleSpawnCodeExecutionAgent(payload);
    });
  }

  /**
   * Handle spawn completion agent requests
   */
  async handleSpawnCompletionAgent(payload) {
    try {
      const { triggerSource, targetOutput, reason, priority } = payload;

      // Create completion mission for oversight
      const completionMission = {
        goalId: `completion_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        agentType: 'completion',
        description: `Perform completion validation and oversight for ${targetOutput.type}: ${targetOutput.id}. ${reason}`,
        successCriteria: [
          'Validate output completeness and quality',
          'Check for critical issues requiring intervention',
          'Provide recommendations for system health',
          'Document findings in memory system'
        ],
        maxDuration: 10 * 60 * 1000, // 10 minutes
        priority: priority || 'medium',
        triggerSource,
        targetOutput,
        scope: targetOutput.type === 'document' ? 'output_validation' : 'system_monitoring'
      };

      this.logger.info('🎯 Spawning completion agent for oversight', {
        triggerSource,
        targetType: targetOutput.type,
        targetId: targetOutput.id,
        priority: completionMission.priority
      });

      // Return mission spec for spawning
      return completionMission;

    } catch (error) {
      this.logger.error('Failed to handle spawn completion agent request', {
        error: error.message,
        triggerSource: payload.triggerSource
      });
      return null;
    }
  }

  /**
   * Handle spawn QA agent requests (triggered by document/code creation)
   * Implements "research team" workflow where outputs are reviewed after creation
   */
  async handleSpawnQAAgent(payload) {
    try {
      const { triggerSource, targetOutput, artifactToReview, reason, priority } = payload;

      // HARDENING: Ensure QA always has something concrete to review.
      // Many historical "QA unproductive" cases come from missing artifactToReview,
      // causing the QA agent to fall back to filesystem guessing and often finding nothing.
      let resolvedArtifactToReview = artifactToReview;
      if (!resolvedArtifactToReview || !resolvedArtifactToReview.results) {
        // Best-effort: if a path is provided, read it and inline content.
        const fs = require('fs').promises;
        const path = require('path');
        const candidatePath = targetOutput?.path || targetOutput?.id || null;

        if (candidatePath && typeof candidatePath === 'string') {
          try {
            const abs = path.isAbsolute(candidatePath)
              ? candidatePath
              : path.join(process.cwd(), candidatePath);
            const content = await fs.readFile(abs, 'utf8');
            resolvedArtifactToReview = {
              path: candidatePath,
              mission: {
                description: targetOutput?.title || targetOutput?.id || 'Output review',
                goalId: targetOutput?.goalId || null
              },
              results: [{
                type: 'document',
                content,
                path: candidatePath,
                title: targetOutput?.title || null
              }]
            };
          } catch (e) {
            // Still provide a stub artifact so QA can report the failure clearly
            resolvedArtifactToReview = {
              path: candidatePath,
              mission: {
                description: targetOutput?.title || targetOutput?.id || 'Output review',
                goalId: targetOutput?.goalId || null
              },
              results: [{
                type: 'artifact_missing',
                content: `Could not read target output at '${candidatePath}': ${e.message}`,
                path: candidatePath
              }]
            };
          }
        }
      }

      // TABLE STAKES: Do not spawn validators without a concrete artifact.
      // If we cannot resolve an artifactToReview (and cannot even produce a readable-path stub),
      // spawning QA will be unproductive and wastes cycles.
      if (!resolvedArtifactToReview || !Array.isArray(resolvedArtifactToReview.results) || resolvedArtifactToReview.results.length === 0) {
        this.logger.warn('⏭️  Skipping QA spawn (no artifact to validate)', {
          triggerSource,
          targetType: targetOutput?.type,
          targetId: targetOutput?.id || targetOutput?.path || null,
          reason: 'Missing artifactToReview and no readable target output path'
        });
        return null;
      }

      // Create QA mission with artifact reference
      const qaMission = {
        goalId: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        agentType: 'quality_assurance',
        description: `Quality assurance review for ${targetOutput.type}: ${targetOutput.title || targetOutput.id}. ${reason}`,
        successCriteria: [
          'Validate consistency and logical coherence',
          'Check factual accuracy of claims',
          'Assess novelty and value of contribution',
          'Verify completeness against requirements',
          'Provide actionable feedback'
        ],
        maxDuration: 15 * 60 * 1000, // 15 minutes for thorough review
        priority: priority || 'high',
        triggerSource,
        targetOutput,
        artifactToReview: resolvedArtifactToReview, // CRITICAL: Pass the artifact to review (hardened)
        scope: 'output_validation'
      };

      this.logger.info('🔍 Spawning QA agent for output review', {
        triggerSource,
        targetType: targetOutput.type,
        targetId: targetOutput.id || targetOutput.path,
        priority: qaMission.priority
      });

      // Return mission spec for spawning
      return qaMission;

    } catch (error) {
      this.logger.error('Failed to handle spawn QA agent request', {
        error: error.message,
        triggerSource: payload.triggerSource
      });
      return null;
    }
  }

  /**
   * Handle spawn CodeExecutionAgent requests (triggered by code creation)
   * Implements "code creation → testing → validation" workflow
   */
  async handleSpawnCodeExecutionAgent(payload) {
    try {
      const { triggerSource, targetOutput, codeFiles, reason, priority } = payload;

      // Create CodeExecutionAgent mission with code file references
      const executionMission = {
        goalId: `code_execution_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        agentType: 'code_execution',
        description: `Test and execute ${targetOutput.language} code created by ${triggerSource}: ${targetOutput.projectName || targetOutput.id}. ${reason}`,
        successCriteria: [
          'Successfully execute the generated code',
          'Validate code functionality and correctness',
          'Test edge cases and error handling',
          'Document execution results and findings',
          'Report any bugs or improvements needed'
        ],
        maxDuration: 20 * 60 * 1000, // 20 minutes for testing
        priority: priority || 'high',
        triggerSource,
        targetOutput,
        codeFiles, // CRITICAL: Pass the code files to test
        metadata: {
          codeCreationAgentId: triggerSource, // Link back to creator
          language: targetOutput.language,
          outputDir: targetOutput.outputDir
        },
        scope: 'code_validation'
      };

      this.logger.info('🧪 Spawning CodeExecutionAgent for testing', {
        triggerSource,
        language: targetOutput.language,
        filesCount: codeFiles?.length || 0,
        priority: executionMission.priority
      });

      // Return mission spec for spawning
      return executionMission;

    } catch (error) {
      this.logger.error('Failed to handle spawn CodeExecutionAgent request', {
        error: error.message,
        triggerSource: payload.triggerSource
      });
      return null;
    }
  }

  async initialize() {
    if (!this.enabled) {
      this.logger.info('Meta-Coordinator: Disabled in config');
      return;
    }

    // Create coordinator directory
    await fs.mkdir(this.coordinatorDir, { recursive: true });
    
    // Load previous context if exists
    await this.loadContext();
    
    this.logger.info('✅ Meta-Coordinator initialized', {
      enabled: this.enabled,
      reviewInterval: this.reviewInterval,
      previousReviews: this.reviewHistory.length
    });
  }

  /**
   * Check if review should run this cycle
   * 
   * Includes bootstrap logic: First review happens early (cycle 3-5) for immediate action,
   * then subsequent reviews follow the normal interval-based schedule.
   */
  shouldRunReview(cycleCount) {
    if (!this.enabled) return false;
    
    // BOOTSTRAP: First review happens early (cycle 3-5) for immediate action
    // This prevents the "dead zone" where nothing happens for the first N cycles
    if (this.lastReviewCycle === 0 && cycleCount >= 3 && cycleCount <= 5) {
      return true;
    }
    
    // SUBSEQUENT: Normal interval-based reviews (relative to last review)
    // This ensures reviews happen every N cycles AFTER the previous review
    if (cycleCount <= this.lastReviewCycle) return false;
    const cyclesSinceLastReview = cycleCount - this.lastReviewCycle;
    return cyclesSinceLastReview >= this.reviewInterval;
  }

  /**
   * TEMPORAL: Compute state delta between current and previous review
   * Implements "Chronicle of Mind" - focuses on change, not just current state
   * 
   * @param {Object} currentState - Current phase2bState
   * @returns {Object} Delta object with changes across all dimensions
   */
  computeStateDelta(currentState) {
    // Get previous review (if exists)
    const previousReview = this.reviewHistory.length > 0 
      ? this.reviewHistory[this.reviewHistory.length - 1]
      : null;
    
    if (!previousReview) {
      return {
        isFirstReview: true,
        cycleRange: [0, currentState.cycleCount],
        message: 'First review - no previous state to compare'
      };
    }
    
    const prev = previousReview.stateSnapshot;
    const cyclesSinceLastReview = currentState.cycleCount - previousReview.cycle;
    
    // Compute deltas across all dimensions
    const delta = {
      isFirstReview: false,
      cycleRange: [previousReview.cycle, currentState.cycleCount],
      cyclesSinceLastReview,
      
      // Goals delta
      goals: {
        active: {
          current: currentState.goals?.active?.length || 0,
          previous: prev?.goalsCount?.active || 0,
          change: (currentState.goals?.active?.length || 0) - (prev?.goalsCount?.active || 0),
          percentChange: this.calculatePercentChange(
            prev?.goalsCount?.active || 0,
            currentState.goals?.active?.length || 0
          )
        },
        completed: {
          current: currentState.goals?.completed?.length || 0,
          previous: prev?.goalsCount?.completed || 0,
          change: (currentState.goals?.completed?.length || 0) - (prev?.goalsCount?.completed || 0)
        },
        archived: {
          current: currentState.goals?.archived?.length || 0,
          previous: prev?.goalsCount?.archived || 0,
          change: (currentState.goals?.archived?.length || 0) - (prev?.goalsCount?.archived || 0)
        }
      },
      
      // Memory delta
      memory: {
        nodes: {
          current: currentState.memory?.nodes?.length || 0,
          previous: prev?.memoryStats?.nodes || 0,
          change: (currentState.memory?.nodes?.length || 0) - (prev?.memoryStats?.nodes || 0),
          growthRate: this.calculateGrowthRate(
            prev?.memoryStats?.nodes || 0,
            currentState.memory?.nodes?.length || 0,
            cyclesSinceLastReview
          )
        },
        edges: {
          current: currentState.memory?.edges?.length || 0,
          previous: prev?.memoryStats?.edges || 0,
          change: (currentState.memory?.edges?.length || 0) - (prev?.memoryStats?.edges || 0)
        },
        clusters: {
          current: currentState.memory?.clusters?.length || 0,
          previous: prev?.memoryStats?.clusters || 0,
          change: (currentState.memory?.clusters?.length || 0) - (prev?.memoryStats?.clusters || 0)
        }
      },
      
      // Agent activity delta
      agents: {
        activeCount: {
          current: currentState.activeAgentCount || 0,
          previous: prev?.agentMetrics?.activeCount || 0,
          change: (currentState.activeAgentCount || 0) - (prev?.agentMetrics?.activeCount || 0)
        },
        completionsThisPeriod: currentState.activeAgentCount || 0,
        completionRate: cyclesSinceLastReview > 0 
          ? ((currentState.activeAgentCount || 0) / cyclesSinceLastReview).toFixed(2)
          : 0
      },
      
      // Deliverables delta (if available from previous audit)
      deliverables: this.lastDeliverablesAudit ? {
        current: this.lastDeliverablesAudit.totalFiles || 0,
        previous: prev?.deliverablesCount || 0,
        change: (this.lastDeliverablesAudit.totalFiles || 0) - (prev?.deliverablesCount || 0)
      } : null
    };
    
    // Generate human-readable summary
    delta.summary = this.generateDeltaSummary(delta);
    
    return delta;
  }
  
  /**
   * TEMPORAL: Calculate percent change (handles zero denominator)
   */
  calculatePercentChange(previous, current) {
    if (previous === 0) {
      return current > 0 ? 100 : 0;
    }
    return ((current - previous) / previous * 100).toFixed(1);
  }
  
  /**
   * TEMPORAL: Calculate growth rate per cycle
   */
  calculateGrowthRate(previous, current, cycles) {
    if (cycles === 0 || previous === 0) return 0;
    const totalGrowth = current - previous;
    return (totalGrowth / cycles).toFixed(2);
  }
  
  /**
   * TEMPORAL: Generate human-readable delta summary
   */
  generateDeltaSummary(delta) {
    const lines = [];
    
    lines.push(`Reviewing ${delta.cyclesSinceLastReview} cycles (${delta.cycleRange[0]} → ${delta.cycleRange[1]})`);
    
    if (delta.goals.active.change !== 0) {
      lines.push(`Goals: ${delta.goals.active.change > 0 ? '+' : ''}${delta.goals.active.change} active (${delta.goals.active.percentChange}%)`);
    }
    
    if (delta.memory.nodes.change > 0) {
      lines.push(`Memory: +${delta.memory.nodes.change} nodes (${delta.memory.nodes.growthRate}/cycle)`);
    }
    
    if (delta.agents.completionsThisPeriod > 0) {
      lines.push(`Agents: ${delta.agents.completionsThisPeriod} completed (${delta.agents.completionRate}/cycle)`);
    }
    
    if (delta.deliverables && delta.deliverables.change > 0) {
      lines.push(`Deliverables: +${delta.deliverables.change} files created`);
    }
    
    return lines.join('\n');
  }

  /**
   * Main review cycle - comprehensive analysis of Phase 2B work
   */
  async conductReview(phase2bState) {
    const reviewStart = new Date();
    const {
      cycleCount,
      journal,
      goals,
      memory,
      roles,
      reflection,
      oscillator,
      cognitiveState,
      goalsSystem: goalsManager = null,
      // NEW: Active agents and work in progress
      activeAgents = [],
      activeAgentCount = 0,
      // SITUATIONAL AWARENESS: Guided plan awareness
      guidedMissionPlan = null
    } = phase2bState;

    if (goalsManager && typeof goalsManager.addGoal === 'function') {
      this.activeGoalsSystem = goalsManager;
    }

    this.logger.info('');
    this.logger.info('╔══════════════════════════════════════════════════════╗');
    this.logger.info('║        META-COORDINATOR STRATEGIC REVIEW             ║');
    this.logger.info('╚══════════════════════════════════════════════════════╝');
    this.logger.info('');
    this.logger.info(`📊 Reviewing cycles ${this.lastReviewCycle + 1} to ${cycleCount}`);
    this.logger.info(`   Thoughts analyzed: ${Array.isArray(journal) ? journal.length : 0}`);
    this.logger.info(`   Active goals: ${Array.isArray(goals?.active) ? goals.active.length : 0}`);
    this.logger.info(`   Memory nodes: ${memory?.nodes?.length || 0}`);
    this.logger.info(`   Memory edges: ${memory?.edges?.length || 0}`);
    this.logger.info('');
    
    // TEMPORAL: Compute state delta (Chronicle of Mind)
    const stateDelta = this.computeStateDelta(phase2bState);
    if (!stateDelta.isFirstReview) {
      this.logger.info('⏱️  TEMPORAL DELTA ANALYSIS:', {
        cycleRange: `${stateDelta.cycleRange[0]} → ${stateDelta.cycleRange[1]}`,
        goalsChange: stateDelta.goals.active.change,
        memoryGrowth: stateDelta.memory.nodes.change,
        agentsCompleted: stateDelta.agents.completionsThisPeriod
      });
      this.logger.info('');
    }
    
    // CRITICAL: Check progress on previous urgent goals BEFORE starting new analysis
    let followUpReport = null;
    if (this.lastReviewCycle > 0) {
      this.logger.info('🔍 Checking progress on previous strategic goals...');
      followUpReport = this.strategicTracker.generateFollowUpReport(this.lastReviewCycle);
      
      if (followUpReport.goalsTracked > 0) {
        this.logger.info('📋 Previous Strategic Goals Status:', {
          completed: followUpReport.summary.completedCount,
          inProgress: followUpReport.summary.inProgressCount,
          stalled: followUpReport.summary.stalledCount,
          escalated: followUpReport.summary.escalatedCount,
          actionRate: `${Math.round((followUpReport.summary.actionTaken / followUpReport.goalsTracked) * 100)}%`
        });
        
        // Warn about stalled goals
        if (followUpReport.stalled.length > 0) {
          this.logger.warn('⚠️ STALLED STRATEGIC GOALS:', {
            count: followUpReport.stalled.length,
            examples: followUpReport.stalled.slice(0, 3).map(g => 
              `${g.goalId}: ${g.description.substring(0, 60)}...`
            )
          });
        }
      }
      
      this.logger.info('');
    }

    try {
      // Phase 1: Analyze Phase 2B cognitive outputs
      this.logger.info('🔍 Phase 1: Analyzing cognitive outputs...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 1, name: 'Analyzing cognitive outputs', status: 'started' });
      const cognitiveAnalysis = await this.analyzeCognitiveWork(journal, roles);
      this.logger.info(cognitiveAnalysis.failed ? '   ❌ Phase 1 failed' : '   ✅ Phase 1 complete');
      this._getEvents().emitEvent('coordinator_phase', { phase: 1, name: 'Cognitive analysis', status: cognitiveAnalysis.failed ? 'failed' : 'complete' });

      // Phase 2: Evaluate goal portfolio
      this.logger.info('🎯 Phase 2: Evaluating goal portfolio...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 2, name: 'Evaluating goals', status: 'started' });
      const goalEvaluation = await this.evaluateGoals(goals, journal);
      this.logger.info(goalEvaluation.failed ? '   ❌ Phase 2 failed' : '   ✅ Phase 2 complete');
      this._getEvents().emitEvent('coordinator_phase', { phase: 2, name: 'Goal evaluation', status: goalEvaluation.failed ? 'failed' : 'complete' });

      // Phase 2.5: Analyze agent results (insights & findings)
      this.logger.info('🤖 Phase 2.5: Analyzing agent results...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 2.5, name: 'Analyzing agent results', status: 'started' });
      const agentResults = await this.analyzeAgentResults(this.lastReviewCycle);
      this.logger.info(`   ✅ Phase 2.5 complete (${agentResults.agentCount} agents, ${agentResults.insights.length} insights, ${agentResults.findings.length} findings)`);
      this._getEvents().emitEvent('coordinator_phase', {
        phase: 2.5,
        name: 'Agent analysis',
        status: 'complete',
        detail: `${agentResults.agentCount} agents, ${agentResults.insights.length} insights`
      });

      // Phase 2.6: Plan Evaluation
      if (this.config.planReview?.enabled !== false) {
        this.logger.info('📋 Phase 2.6: Evaluating plan...');
        this._getEvents().emitEvent('coordinator_phase', { phase: 2.6, name: 'Plan evaluation', status: 'started' });
        const planReview = await this.reviewPlan(phase2bState);
        goalEvaluation.planDelta = planReview.delta;
        goalEvaluation.planRationale = planReview.rationale;
        this.logger.info(`   ✅ Phase 2.6 complete`);
        this._getEvents().emitEvent('coordinator_phase', { phase: 2.6, name: 'Plan evaluation', status: 'complete' });
      }

      // Phase 2.7: Audit deliverables and work products
      this.logger.info('📦 Phase 2.7: Auditing deliverables...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 2.7, name: 'Auditing deliverables', status: 'started' });
      
      // P7: Prefer canonical audit (ClusterStateStore + semantic classification) when available
      // Falls back to filesystem audit automatically if ClusterStateStore unavailable
      const deliverables = await this.auditCanonicalDeliverables();
      this.lastDeliverablesAudit = deliverables; // Store for gap-driven agent spawning
      
      const sourceLabel = deliverables.source === 'clusterStateStore' ? ' (semantic)' : ' (filesystem)';
      this.logger.info(`   ✅ Phase 2.7 complete${sourceLabel} (${deliverables.totalFiles} files, ${deliverables.gaps.length} gaps)`);
      this._getEvents().emitEvent('coordinator_phase', {
        phase: 2.7,
        name: 'Deliverables audit',
        status: 'complete',
        detail: `${deliverables.totalFiles} files, ${deliverables.gaps.length} gaps`,
        source: deliverables.source
      });

      // Phase 3: Analyze memory patterns
      this.logger.info('🧠 Phase 3: Analyzing memory patterns...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 3, name: 'Memory analysis', status: 'started' });
      const memoryAnalysis = await this.analyzeMemory(memory);
      this.logger.info(memoryAnalysis.failed ? '   ❌ Phase 3 failed' : '   ✅ Phase 3 complete');
      this._getEvents().emitEvent('coordinator_phase', { phase: 3, name: 'Memory analysis', status: memoryAnalysis.failed ? 'failed' : 'complete' });

      // Phase 4: Review overall system health
      this.logger.info('💊 Phase 4: Assessing system health...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 4, name: 'Health assessment', status: 'started' });
      const systemHealth = await this.assessSystemHealth(cognitiveState, oscillator, reflection);
      this.logger.info('   ✅ Phase 4 complete (no API call)');
      this._getEvents().emitEvent('coordinator_phase', {
        phase: 4,
        name: 'Health assessment',
        status: 'complete',
        detail: `energy: ${Math.round((systemHealth.cognitiveState?.energy || 0) * 100)}%`
      });

      // Phase 5: Make strategic decisions (with validated inputs including agent results and deliverables)
      this.logger.info('⚖️  Phase 5: Making strategic decisions...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 5, name: 'Strategic decisions', status: 'started' });
      const decisions = await this.makeStrategicDecisions({
        cognitiveAnalysis,
        goalEvaluation,
        memoryAnalysis,
        agentResults,
        deliverables,
        systemHealth,
        previousContext: this.getRecentContext(),
        // NEW: Active agents info for work-in-progress awareness
        activeAgents,
        activeAgentCount,
        guidedMissionPlan,
        goals,
        cycleCount,
        // TEMPORAL: Pass delta for temporal analysis
        stateDelta
      });
      this.logger.info(decisions.failed ? '   ❌ Phase 5 failed' : '   ✅ Phase 5 complete');
      this._getEvents().emitEvent('coordinator_phase', {
        phase: 5,
        name: 'Strategic decisions',
        status: decisions.failed ? 'failed' : 'complete',
        detail: decisions.strategicDirectives?.length ? `${decisions.strategicDirectives.length} directives` : null
      });

      // Phase 6: Generate comprehensive report
      this.logger.info('📝 Phase 6: Generating comprehensive report...');
      this._getEvents().emitEvent('coordinator_phase', { phase: 6, name: 'Report generation', status: 'started' });
      
      let report;
      try {
        report = await this.generateReport({
          cycleRange: [this.lastReviewCycle + 1, cycleCount],
          cognitiveAnalysis,
          goalEvaluation,
          memoryAnalysis,
          agentResults,
          deliverables,
          systemHealth,
          decisions,
          reviewDuration: Date.now() - reviewStart.getTime()
        });
        this.logger.info('   ✅ Phase 6: Report object created successfully');
      } catch (error) {
        this.logger.error('❌ CRITICAL: Report generation failed', {
          error: error.message,
          stack: error.stack
        });
        // Create minimal report to prevent complete failure
        report = {
          reviewId: `review_${cycleCount}`,
          timestamp: new Date(),
          cycleRange: [this.lastReviewCycle + 1, cycleCount],
          summary: { error: 'Report generation failed' },
          error: error.message
        };
      }
      
      this._getEvents().emitEvent('coordinator_phase', { phase: 6, name: 'Report generation', status: 'complete' });

      // Establish goals system reference for goal injection (urgent + insights)
      const liveGoalsSystem = (goalsManager && typeof goalsManager.addGoal === 'function')
        ? goalsManager
        : (this.activeGoalsSystem && typeof this.activeGoalsSystem.addGoal === 'function'
          ? this.activeGoalsSystem
          : null);
      
      // NEW: Inject urgent goals if strategic decisions identified critical gaps
      if (decisions.urgentGoals && decisions.urgentGoals.length > 0) {
        this.logger.info('📌 Strategic decisions identified urgent goals to create', {
          urgentGoalsCount: decisions.urgentGoals.length
        });

        if (!liveGoalsSystem) {
          this.logger.warn('Live goals system reference unavailable; urgent goals cannot be injected yet', {
            hasGoalsManager: !!goalsManager,
            addGoalType: goalsManager ? typeof goalsManager.addGoal : null
          });
        }

        const injectedGoals = await this.injectUrgentGoals(decisions.urgentGoals, liveGoalsSystem);

        if (injectedGoals.length > 0) {
          this.logger.info('✅ Urgent goals injected into goal system', {
            injectedCount: injectedGoals.length,
            goalIds: injectedGoals.map(g => g.id)
          });
          
          // CRITICAL: Register with tracker for follow-up
          this.strategicTracker.registerUrgentGoals(
            cycleCount,
            decisions.urgentGoals,
            injectedGoals
          );
        } else {
          this.logger.warn('⚠️ Urgent goal injection yielded no new goals', {
            attempted: decisions.urgentGoals.length
          });
        }
      }
      
      // NEW: Process previous curated insights and convert high-priority next steps to goals
      if (liveGoalsSystem && this.lastReviewCycle > 0) {
        await this.processInsightsIntoGoals(this.lastReviewCycle, liveGoalsSystem, cycleCount, {
          guidedMissionPlan,
          activeAgents
        });
      }

      // Store review results
      const reviewRecord = {
        cycle: cycleCount,
        timestamp: reviewStart,
        report,
        decisions,
        prioritizedGoals: decisions.prioritizedGoals || [],
        directives: decisions.strategicDirectives || [],
        urgentGoalsCreated: decisions.urgentGoals || [],
        specializationRouting: decisions.specializationRouting || null,
        agentsSpawned: [], // Will be populated if agents are spawned
        activeMilestone: guidedMissionPlan?.activeMilestone || null, // PLAN INTEGRITY: Track active milestone for stall detection
        activePlan: guidedMissionPlan || null,
        
        // TEMPORAL: Store state snapshot for delta computation
        stateSnapshot: {
          goalsCount: {
            active: goals.active?.length || 0,
            completed: goals.completed?.length || 0,
            archived: goals.archived?.length || 0
          },
          memoryStats: {
            nodes: memory.nodes?.length || 0,
            edges: memory.edges?.length || 0,
            clusters: memory.clusters?.length || 0
          },
          agentMetrics: {
            activeCount: activeAgentCount || 0,
            completedSinceLastReview: agentResults?.agentCount || 0
          },
          deliverablesCount: deliverables?.totalFiles || 0
        }
      };

      this.reviewHistory.push(reviewRecord);
      this.lastReviewCycle = cycleCount;
      this.strategicDirectives = decisions.strategicDirectives || [];
      this.prioritizedGoals = decisions.prioritizedGoals || [];

      // NEW: Return review record so orchestrator can spawn agents
      reviewRecord.prioritizedGoals = decisions.prioritizedGoals || [];
      reviewRecord.decisions = decisions;
      
      // P6: Generate executable commands based on strategic observations
      try {
        reviewRecord.commands = this.generateExecutableCommands(goals, decisions, cycleCount);
        
        // CRITICAL FIX: Add commands to report object for persistence and audit trail
        // Commands are generated here (after report creation) so we must add them before saving
        if (reviewRecord.commands) {
          report.commands = reviewRecord.commands;
          this.logger.info('📋 Strategic commands generated', {
            hasGoalMerge: !!reviewRecord.commands.mergeGoals,
            hasFocusMode: !!reviewRecord.commands.focusMode,
            hasStopGoals: !!reviewRecord.commands.stopNewGoals,
            hasConsolidate: !!reviewRecord.commands.consolidateAgents
          });
        } else {
          report.commands = null;
        }
      } catch (commandError) {
        this.logger.error('❌ Command generation failed (non-fatal)', {
          error: commandError.message,
          stack: commandError.stack
        });
        reviewRecord.commands = null; // No commands if generation fails
        report.commands = null;
      }

      // Update context memory (keep last 3 reviews for continuity)
      this.contextMemory.push({
        cycle: cycleCount,
        keyInsights: decisions.keyInsights || [],
        priorities: decisions.prioritizedGoals?.slice(0, 5) || []
      });
      if (this.contextMemory.length > 3) {
        this.contextMemory.shift();
      }

      // Save everything
      try {
        await this.saveReport(report, cycleCount);
      } catch (error) {
        this.logger.error('❌ CRITICAL: Failed to save report', {
          error: error.message,
          stack: error.stack,
          cycleCount,
          reportKeys: Object.keys(report || {})
        });
        // Continue - don't fail entire review if report save fails
      }
      
      try {
        await this.saveContext();
      } catch (error) {
        this.logger.error('❌ Failed to save context', {
          error: error.message
        });
        // Continue
      }

      // NEW: Update completion tracker if in guided mode
      if (phase2bState.orchestrator?.completionTracker) {
        phase2bState.orchestrator.completionTracker.updateFromAgentResults(agentResults);
        
        // Display progress
        phase2bState.orchestrator.completionTracker.displayProgress();
        
        // Check if complete
        if (phase2bState.orchestrator.completionTracker.isComplete()) {
          this.logger.info('');
          this.logger.info('🎯 TASK COMPLETION DETECTED');
          const completionReport = phase2bState.orchestrator.completionTracker.generateCompletionReport();
          this.logger.info(completionReport);
          
          // Save completion report
          const completionReportPath = path.join(this.coordinatorDir, '..', 'task-completion-report.md');
          await phase2bState.orchestrator.completionTracker.saveCompletionReport(completionReportPath);
        }
      }

      // Log summary
      this.logger.info('');
      this.logger.info('✅ Strategic review complete');
      this.logger.info(`   Duration: ${((Date.now() - reviewStart.getTime()) / 1000).toFixed(1)}s`);
      this.logger.info(`   Top priorities identified: ${decisions.prioritizedGoals?.length || 0}`);
      this.logger.info(`   Strategic directives: ${decisions.strategicDirectives?.length || 0}`);
      this.logger.info('');

      // Emit coordinator review event
      this._getEvents().emitCoordinatorReview({
        cycle: cycleCount,
        summary: decisions.strategicDirectives?.[0] || 'Strategic review completed',
        directivesCount: decisions.strategicDirectives?.length || 0,
        prioritiesCount: decisions.prioritizedGoals?.length || 0,
        agentsSpawned: reviewRecord.agentsSpawned?.length || 0
      });

      // NEW: Async insight curation (non-blocking)
      if (this.fullConfig.coordinator?.insightCuration?.enabled !== false) {
        this.logger.info('💎 Starting insight curation (async, non-blocking)...');
        
        // Fire and forget - don't await, runs independently
        this.curateInsightsAsync(cycleCount, agentResults).catch(error => {
          this.logger.error('Async insight curation error (non-fatal)', { 
            error: error.message 
          });
        });
        
        this.logger.info('   ✓ Curation initiated in background');
        this.logger.info('');
      }

      return reviewRecord;

    } catch (error) {
      this.logger.error('Meta-Coordinator review failed', {
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  /**
   * P6: Generate executable commands from strategic observations
   * Translates MetaC recommendations into actionable orchestrator commands
   * 
   * @param {Object} goals - Goals export from phase2bState
   * @param {Object} decisions - Review decisions
   * @param {number} cycleCount - Current cycle
   * @returns {Object} Commands object with merge, focus, stop, consolidate specs
   */
  generateExecutableCommands(goals, decisions, cycleCount) {
    const commands = {
      mergeGoals: null,
      focusMode: null,
      stopNewGoals: null,
      consolidateAgents: null,
      repairPlanStall: null
    };
    
    // CRITICAL: goals.active is Array.from(Map.entries()) = [[id, goal], [id, goal], ...]
    // Must extract goal objects from tuples!
    const activeGoalTuples = goals.active || [];
    const activeGoals = activeGoalTuples.map(tuple => {
      // Handle both tuple format [[id, goal]] and direct object format
      if (Array.isArray(tuple) && tuple.length === 2) {
        return tuple[1]; // Extract goal from [id, goal] tuple
      }
      return tuple; // Already an object
    }).filter(Boolean); // Remove any null/undefined
    
    const completedGoals = goals.completed || [];
    
    // Command 1: Merge duplicate goals
    // Detect: Multiple active goals with similar descriptions
    if (activeGoals.length >= 5) {
      const duplicateGroups = this.findDuplicateGoals(activeGoals);
      if (duplicateGroups.length > 0) {
        const largestGroup = duplicateGroups[0];
        commands.mergeGoals = {
          targetGoalId: largestGroup[0].id, // Keep highest priority
          sourceGoalIds: largestGroup.slice(1).map(g => g.id),
          reason: `Detected ${largestGroup.length} duplicate goals on same topic - consolidating to reduce scatter`
        };
        
        this.logger.info('📋 Command generated: MERGE_GOALS', {
          target: largestGroup[0].id,
          sources: commands.mergeGoals.sourceGoalIds.length
        });
      }
    }
    
    // Command 2: Enter focus mode
    // Detect: Runaway goal creation (20+ goals, low pursuit rate)
    const goalCreatedCount = activeGoals.length;
    const goalPursuedCount = activeGoals.filter(g => g.pursuitCount > 0).length;
    const pursuitRate = goalCreatedCount > 0 ? goalPursuedCount / goalCreatedCount : 0;
    
    if (goalCreatedCount >= 20 && pursuitRate < 0.2) {
      // Find high-priority goals to allow
      const topGoals = [...activeGoals]
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .slice(0, 5)
        .map(g => g.id);
      
      commands.focusMode = {
        allowedGoals: topGoals,
        blockDuration: 50, // cycles
        reason: `Goal proliferation detected: ${goalCreatedCount} created, only ${goalPursuedCount} pursued (${Math.round(pursuitRate * 100)}%)`
      };
      
      this.logger.warn('🎯 Command generated: FOCUS_MODE', {
        totalGoals: goalCreatedCount,
        allowedGoals: topGoals.length,
        pursuitRate: `${Math.round(pursuitRate * 100)}%`
      });
    }
    
    // Command 3: Stop new goal creation
    // Detect: Zero goal pursuit with active goals
    if (goalCreatedCount > 10 && goalPursuedCount === 0) {
      commands.stopNewGoals = {
        reason: `${goalCreatedCount} goals created but 0 pursued - stop creating until existing goals are tackled`,
        until: 'pursuit_rate_improves'
      };
      
      this.logger.warn('🛑 Command generated: STOP_NEW_GOALS', {
        created: goalCreatedCount,
        pursued: goalPursuedCount
      });
    }
    
    // Command 4: Consolidate agents
    // Detect: Too many active agents (from phase2bState active agents if available)
    const activeAgentCount = decisions.activeAgentCount || 0;
    if (activeAgentCount > 50) {
      commands.consolidateAgents = {
        maxActive: 20,
        priorityPhases: ['synthesis', 'integration'],
        reason: `${activeAgentCount} agents active - consolidate to prevent scatter and improve coordination`
      };
      
      this.logger.warn('🔄 Command generated: CONSOLIDATE_AGENTS', {
        current: activeAgentCount,
        target: 20
      });
    }

    // Command 5: Repair plan stall
    // Detect: Plan phase not advancing for 40 cycles (2 review periods)
    const activePlan = decisions.activePlan;
    if (activePlan && activePlan.status === 'ACTIVE') {
      const activeMilestone = activePlan.activeMilestone;
      const lastReview = this.reviewHistory[this.reviewHistory.length - 1];
      const secondLastReview = this.reviewHistory[this.reviewHistory.length - 2];
      
      const wasStalledInLastReview = lastReview?.activeMilestone === activeMilestone;
      const wasStalledInSecondLastReview = secondLastReview?.activeMilestone === activeMilestone;

      if (wasStalledInLastReview && wasStalledInSecondLastReview) {
        commands.repairPlanStall = {
          planId: activePlan.id,
          milestoneId: activeMilestone,
          reason: `Plan stalled on milestone ${activeMilestone} for 3 consecutive reviews (60 cycles)`
        };

        this.logger.warn('⚠️ Command generated: REPAIR_PLAN_STALL', {
          planId: activePlan.id,
          milestone: activeMilestone
        });
      }
    }
    
    return commands;
  }
  
  /**
   * P6: Find groups of duplicate/similar goals
   * Helper for mergeGoals command generation
   * 
   * @param {Array} goals - Active goals to analyze
   * @returns {Array} Array of duplicate groups (each group is array of similar goals)
   */
  findDuplicateGoals(goals) {
    const groups = [];
    const processed = new Set();
    
    for (let i = 0; i < goals.length; i++) {
      if (processed.has(i)) continue;
      
      const goal = goals[i];
      
      // CRITICAL: Skip goals without descriptions
      if (!goal || !goal.description) {
        processed.add(i);
        continue;
      }
      
      const similarGoals = [goal];
      
      // Find goals with similar descriptions
      for (let j = i + 1; j < goals.length; j++) {
        if (processed.has(j)) continue;
        
        const other = goals[j];
        
        // CRITICAL: Skip if other goal missing description
        if (!other || !other.description) {
          processed.add(j);
          continue;
        }
        
        const similarity = this.calculateGoalSimilarity(goal.description, other.description);
        
        if (similarity > 0.7) { // 70% similar
          similarGoals.push(other);
          processed.add(j);
        }
      }
      
      if (similarGoals.length >= 2) { // Found duplicates
        // Sort by priority (keep highest priority as target)
        similarGoals.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        groups.push(similarGoals);
      }
      
      processed.add(i);
    }
    
    // Sort groups by size (largest first)
    groups.sort((a, b) => b.length - a.length);
    return groups;
  }
  
  /**
   * P6: Calculate similarity between two goal descriptions
   * Simple word-overlap similarity metric
   * 
   * @param {string} desc1 - First description
   * @param {string} desc2 - Second description
   * @returns {number} Similarity score 0-1
   */
  calculateGoalSimilarity(desc1, desc2) {
    // CRITICAL: Handle undefined/null descriptions
    if (!desc1 || !desc2) return 0;
    if (typeof desc1 !== 'string' || typeof desc2 !== 'string') return 0;
    
    const words1 = desc1.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const words2 = desc2.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    if (words1.length === 0 || words2.length === 0) return 0;
    
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    
    let overlap = 0;
    for (const word of set1) {
      if (set2.has(word)) overlap++;
    }
    
    const totalUnique = new Set([...words1, ...words2]).size;
    return totalUnique > 0 ? overlap / totalUnique : 0;
  }

  /**
   * Analyze Phase 2B cognitive work - thoughts, themes, quality
   */
  async analyzeCognitiveWork(journal, roles) {
    const cyclesSinceLastReview = journal.length;
    const thoughtsByRole = this.groupThoughtsByRole(journal);
    const thoughtSample = this.sampleThoughts(journal, 20); // Last 20 thoughts

    const thoughtText = thoughtSample
      .map(t => `[Cycle ${t.cycle}, ${t.role}]: ${t.thought}`)
      .join('\n\n');

    const rolePerformance = roles
      .map(r => `${r.id}: ${r.useCount} uses, ${(r.successRate * 100).toFixed(0)}% success`)
      .join('\n');

    // NEW: Diversity check - detect repetitive themes
    const themeFrequency = this.detectThemeFrequency(thoughtText);
    const totalThoughts = cyclesSinceLastReview;
    const repetitionThreshold = totalThoughts * 0.25; // 25% threshold
    
    const repetitiveThemes = Object.entries(themeFrequency)
      .filter(([theme, count]) => count > repetitionThreshold)
      .map(([theme, count]) => `${theme} (${count}/${totalThoughts} = ${(count/totalThoughts*100).toFixed(0)}%)`);
    
    const diversityAlert = repetitiveThemes.length > 0 
      ? `\n\n⚠️ DIVERSITY ALERT: Repetitive themes detected:\n${repetitiveThemes.join('\n')}\n` 
      : '';

    // Use template generator if enabled (massive token savings)
    if (this.config.useTemplateReports) {
      this.logger?.debug('Using template-based cognitive analysis (0 API tokens)');
      return this.templateGenerator.generateCognitiveAnalysis({
        thoughtsByRole,
        rolePerformance,
        thoughtSample,
        themeFrequency,
        repetitiveThemes,
        cycleCount: cyclesSinceLastReview
      });
    }

    // Fallback to LLM (use cheaper model and lower reasoning)
    this.logger?.debug('Using LLM cognitive analysis');
    
    // DOMAIN ANCHOR: Focus cognitive review on domain-relevant thoughts
    const domainAnchorBlock = getDomainAnchor(this.fullConfig);
    
    const prompt = `You are reviewing ${cyclesSinceLastReview} cycles of autonomous AI cognition.${diversityAlert}

${domainAnchorBlock}

ROLE PERFORMANCE:
${rolePerformance}

THOUGHTS BY ROLE:
${Object.entries(thoughtsByRole).map(([role, thoughts]) => 
  `${role}: ${thoughts.length} thoughts`
).join('\n')}

SAMPLE OF RECENT THOUGHTS:
${thoughtText}

Analyze this cognitive work WITH DOMAIN FOCUS:

1. **Quality Assessment**: Rate depth, novelty, and coherence (1-10) FOR DOMAIN-RELEVANT thoughts
2. **Dominant Themes**: What topics/patterns dominate the thinking? (filter out meta-concerns about COSMO itself)
3. **Intellectual Progress**: Evidence of building on previous ideas IN THE RESEARCH DOMAIN?
4. **Gaps & Blind Spots**: Important DOMAIN areas not being explored?
   ${repetitiveThemes.length > 0 ? '⚠️ SPECIFIC: List topics NOT being explored due to over-focus on: ' + repetitiveThemes.map(t => t.split(' (')[0]).join(', ') : ''}
5. **Standout Insights**: Which specific thoughts show breakthrough potential FOR THE DOMAIN RESEARCH?

⚠️ IGNORE any thoughts about QA gates, probes, CLI tools, or COSMO infrastructure - these are meta-pollution.
Be specific and cite cycle numbers.`;

    try {
      const analysis = await this.gpt5.generateWithRetry({
        model: this.config.model || this.config.models?.coordinatorStandard || this.config.models?.fast, // Use configured model
        instructions: prompt,
        messages: [{ role: 'user', content: 'Analyze this cognitive output concisely.' }],
        maxTokens: 10000, // Increased from 3000 - strategic work benefits from higher reasoning allocation
        reasoningEffort: this.config.reasoningEffort || 'low', // Reduced from high
        verbosity: 'low' // Reduced from medium
      }, 3);

      return {
        content: analysis.content || 'Analysis incomplete',
        reasoning: analysis.reasoning,
        cyclesReviewed: cyclesSinceLastReview,
        thoughtsByRole,
        timestamp: new Date(),
        failed: !analysis.content
      };
    } catch (error) {
      this.logger.error('Cognitive analysis failed', {
        error: error.message
      });
      return {
        content: 'Analysis unavailable due to API error.',
        reasoning: null,
        cyclesReviewed: cyclesSinceLastReview,
        thoughtsByRole,
        timestamp: new Date(),
        failed: true
      };
    }
  }

  /**
   * Evaluate goal portfolio - which goals deserve focus
   */
  async evaluateGoals(goals, journal) {
    // Safe access to goals - handle both Map format and array format
    let activeGoals = [];
    
    if (Array.isArray(goals?.active)) {
      // Array of [id, goal] tuples
      activeGoals = goals.active.map(([id, goal]) => ({
        id,
        ...goal
      }));
    } else if (goals?.active && typeof goals.active === 'object') {
      // Object or Map
      activeGoals = Array.from(goals.active.entries ? goals.active.entries() : Object.entries(goals.active)).map(([id, goal]) => ({
        id,
        ...goal
      }));
    } else if (Array.isArray(goals)) {
      // Direct array of goals
      activeGoals = goals;
    }
    
    if (activeGoals.length === 0) {
      this.logger.warn('No active goals found for evaluation');
      return {
        content: 'No active goals available for evaluation.',
        reasoning: null,
        totalGoals: 0,
        pursuedCount: 0,
        prioritizedGoals: [],
        timestamp: new Date(),
        failed: false
      };
    }

    const goalList = activeGoals
      .map(g => {
        // Defensive type coercion for priority/progress (some goals may have non-numeric values)
        const priority = Number(g?.priority) || 0;
        const progress = Number(g?.progress) || 0;
        const pursuits = Number(g?.pursuitCount) || 0;
        return `${g?.id || 'unknown'}: "${g?.description || 'No description'}" (priority: ${priority.toFixed(2)}, progress: ${progress.toFixed(2)}, pursuits: ${pursuits})`;
      })
      .join('\n');

    // Check which goals were actually pursued
    const journalArray = Array.isArray(journal) ? journal : [];
    const pursuedGoals = new Set(
      journalArray.filter(t => t && t.goal).map(t => t.goal)
    );

    // NEW: Add goal health assessment
    const healthIssues = this.identifyGoalHealthIssues(activeGoals, journal);

    // DOMAIN ANCHOR: Evaluate goals with domain focus
    const domainAnchorBlock = getDomainAnchor(this.fullConfig);

    const prompt = `You are evaluating a portfolio of ${activeGoals.length} self-generated goals.

${domainAnchorBlock}

CURRENT GOALS:
${goalList}

ACTUALLY PURSUED: ${pursuedGoals.size} of ${activeGoals.length} goals have been actively worked on.

⚠️ GOAL HEALTH CONCERNS:
${healthIssues}

Your task (WITH DOMAIN FOCUS):
1. **Top 5 Priority Goals**: Which DOMAIN-RELEVANT goals deserve immediate, focused attention? REFERENCE EACH GOAL BY ITS EXACT ID (e.g., goal_164, goal_165)
   ⚠️ EXCLUDE goals about QA gates, probes, CLI tools, COSMO infrastructure
2. **Goals to Merge**: Identify overlapping/redundant DOMAIN goals by their IDs
3. **Goals to Archive**: Low-value, premature, OVERLY-PURSUED, OR META-POLLUTION goals to set aside (list IDs)
   ⚠️ MANDATE: Any goal pursued >10x with <30% progress should be archived
   ⚠️ MANDATE: Any goal monopolizing >20% of recent cycles should be rotated
   ⚠️ MANDATE: Any goal about COSMO internals (not user research) should be archived as META-POLLUTION
4. **Missing Directions**: Important DOMAIN areas not represented in portfolio
5. **Pursuit Strategy**: How should the top DOMAIN goals be approached?

For each archived goal, list goal IDs explicitly: "Archive: goal_123, goal_124, goal_125"

IMPORTANT: Be explicit with goal IDs for programmatic action. Prioritize DOMAIN RESEARCH over system meta-concerns.`;

    try {
      const evaluation = await this.gpt5.generateWithRetry({
        model: this.config.models?.coordinatorStrategic, // Strategic goal prioritization
        instructions: prompt,
        messages: [{ role: 'user', content: 'Evaluate this goal portfolio concisely.' }],
        maxTokens: 25000, // Strategic prioritization needs deep analysis space
        reasoningEffort: 'high', // Goal prioritization drives entire agent layer
        verbosity: 'low' // Request concise output to fit within budget
      }, 3);

      // Extract prioritized goals from response
      const prioritizedGoals = this.extractTopGoals(evaluation.content, activeGoals);

      return {
        content: evaluation.content || 'Evaluation incomplete',
        reasoning: evaluation.reasoning,
        totalGoals: activeGoals.length,
        pursuedCount: pursuedGoals.size,
        prioritizedGoals,
        timestamp: new Date(),
        failed: !evaluation.content
      };
    } catch (error) {
      this.logger.error('Goal evaluation failed', {
        error: error.message
      });
      return {
        content: 'Evaluation unavailable due to API error.',
        reasoning: null,
        totalGoals: activeGoals.length,
        pursuedCount: pursuedGoals.size,
        prioritizedGoals: [],
        timestamp: new Date(),
        failed: true
      };
    }
  }

  /**
   * Analyze memory network patterns
   */
  async analyzeMemory(memory) {
    const stats = {
      nodes: memory.nodes.length,
      edges: memory.edges.length,
      avgDegree: memory.edges.length / memory.nodes.length,
      clusters: memory.clusters?.length || 0
    };

    // Identify strongest connections
    const strongEdges = memory.edges
      .filter(e => e.weight > 0.6)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 15);

    const nodeMap = new Map(memory.nodes.map(n => [n.id, n]));
    
    const strongConnections = strongEdges
      .map(e => {
        const source = nodeMap.get(e.source);
        const target = nodeMap.get(e.target);
        return source && target ? 
          `"${source.concept.substring(0, 60)}" ↔ "${target.concept.substring(0, 60)}" (${e.weight.toFixed(2)})` :
          null;
      })
      .filter(Boolean);

    // Sample high-activation nodes
    const topNodes = memory.nodes
      .sort((a, b) => (b.activation || 0) - (a.activation || 0))
      .slice(0, 10)
      .map(n => ({
        text: n.concept.substring(0, 80),
        activation: (n.activation || 0).toFixed(2),
        weight: n.weight.toFixed(2)
      }));

    // Use template generator if enabled
    if (this.config.useTemplateReports) {
      this.logger?.debug('Using template-based memory analysis (0 API tokens)');
      return this.templateGenerator.generateMemoryAnalysis({
        stats,
        topNodes,
        strongConnections: { 
          count: strongConnections.length,
          list: strongConnections
        }
      });
    }

    // Fallback to LLM
    this.logger?.debug('Using LLM memory analysis');
    const topNodesText = topNodes.map(n => `"${n.text}" (activation: ${n.activation}, weight: ${n.weight})`).join('\n');
    const strongConnectionsText = strongConnections.join('\n');
    
    // DOMAIN ANCHOR: Focus memory analysis on domain-relevant concepts
    const domainAnchorBlock = getDomainAnchor(this.fullConfig);

    const prompt = `Analyze this memory network structure:

${domainAnchorBlock}

STATISTICS:
- Nodes: ${stats.nodes}
- Edges: ${stats.edges}
- Avg connections per node: ${stats.avgDegree.toFixed(1)}
- Identified clusters: ${stats.clusters}

TOP-ACTIVATED NODES:
${topNodesText}

STRONGEST CONNECTIONS:
${strongConnectionsText}

Provide insights on (WITH DOMAIN FOCUS):
1. **Emerging Knowledge Domains**: What conceptual areas are forming RELATED TO THE RESEARCH DOMAIN?
2. **Key Concepts**: Which nodes are central to the DOMAIN RESEARCH network?
3. **Connection Patterns**: What DOMAIN-RELEVANT relationships are being reinforced?
4. **Gaps to Bridge**: DOMAIN concepts that should be connected but aren't?
5. **Consolidation Opportunities**: DOMAIN areas ready for higher-level abstraction?

⚠️ FILTER OUT nodes about QA gates, probes, CLI tools, COSMO infrastructure - focus on USER'S research domain.`;

    try {
      const analysis = await this.gpt5.generateWithRetry({
        model: this.config.model || this.config.models?.coordinatorStandard || this.config.models?.fast,
        instructions: prompt,
        messages: [{ role: 'user', content: 'Analyze memory network concisely.' }],
        maxTokens: 10000, // Increased from 3000 - agent spec benefits from detailed reasoning
        reasoningEffort: this.config.reasoningEffort || 'low',
        verbosity: 'low'
      }, 3);

      return {
        content: analysis.content || 'Memory analysis incomplete',
        stats,
        strongConnections: strongEdges.length,
        timestamp: new Date(),
        failed: !analysis.content
      };
    } catch (error) {
      this.logger.error('Memory analysis failed', {
        error: error.message
      });
      return {
        content: 'Memory analysis unavailable due to API error.',
        stats,
        strongConnections: strongEdges.length,
        timestamp: new Date(),
        failed: true
      };
    }
  }

  /**
   * Assess overall system health
   */
  async assessSystemHealth(cognitiveState, oscillator, reflection) {
    const health = {
      cognitiveState: {
        curiosity: cognitiveState.curiosity,
        mood: cognitiveState.mood,
        energy: cognitiveState.energy
      },
      oscillator: {
        mode: oscillator.currentMode,
        cycleCount: oscillator.cycleCount
      },
      recentSuccesses: cognitiveState.recentSuccesses || 0,
      recentFailures: cognitiveState.recentFailures || 0
    };

    this.logger.info(`   System health: curiosity=${(health.cognitiveState.curiosity * 100).toFixed(0)}%, mood=${(health.cognitiveState.mood * 100).toFixed(0)}%, energy=${(health.cognitiveState.energy * 100).toFixed(0)}%`);

    return health;
  }

  /**
   * Analyze agent results (insights and findings) since last review
   * CRITICAL: Ensures coordinator sees and uses agent discoveries in strategic decisions
   */
  async analyzeAgentResults(sinceReviewCycle) {
    const resultsPath = path.join(this.coordinatorDir, 'results_queue.jsonl');
    
    const allResults = [];
    const insights = [];
    const findings = [];
    const agentSummaries = [];

    try {
      const fileStream = createReadStream(resultsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const result = JSON.parse(line);
            // Skip integration markers, only get actual agent results
            if (result.type !== 'integration_marker' && result.agentId && result.agentType) {
              allResults.push(result);
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      }

      // Filter to results since last review (if timestamp available)
      const recentResults = allResults.filter(r => {
        // If no timestamp, include it (shouldn't happen but be safe)
        if (!r.endTime) return true;
        // Include if completed after last review cycle
        // This is approximate - we don't have exact cycle timestamps in results
        // so we use a simple heuristic: include all recent results
        return true; // For now, review all recent results
      });

      // Extract insights and findings from each agent result
      for (const agentResult of recentResults) {
        const agentInsights = [];
        const agentFindings = [];

        for (const item of agentResult.results || []) {
          if (item.type === 'insight') {
            insights.push({
              content: item.content,
              agentType: agentResult.agentType,
              agentId: agentResult.agentId,
              goal: agentResult.mission?.description,
              timestamp: item.timestamp || agentResult.endTime
            });
            // Extract string content (handle both strings and objects)
            const insightText = typeof item.content === 'string' 
              ? item.content 
              : item.content?.content || item.content?.summary || JSON.stringify(item.content);
            agentInsights.push(insightText);
          } else if (item.type === 'finding') {
            findings.push({
              content: item.content,
              agentType: agentResult.agentType,
              agentId: agentResult.agentId,
              goal: agentResult.mission?.description,
              timestamp: item.timestamp || agentResult.endTime
            });
            // Extract string content (handle both strings and objects)
            const findingText = typeof item.content === 'string' 
              ? item.content 
              : item.content?.content || item.content?.summary || JSON.stringify(item.content);
            agentFindings.push(findingText);
          }
        }

        // Create summary for this agent
        if (agentInsights.length > 0 || agentFindings.length > 0) {
          agentSummaries.push({
            agentType: agentResult.agentType,
            agentId: agentResult.agentId,
            goal: agentResult.mission?.description || 'No description',
            status: agentResult.status,
            insightsCount: agentInsights.length,
            findingsCount: agentFindings.length,
            duration: agentResult.durationFormatted || agentResult.duration,
            // Include sample insights/findings for context
            sampleInsights: agentInsights.slice(0, 3),
            sampleFindings: agentFindings.slice(0, 3)
          });
        }
      }

      this.logger.debug('Agent results analyzed', {
        totalAgents: recentResults.length,
        agentsWithResults: agentSummaries.length,
        totalInsights: insights.length,
        totalFindings: findings.length
      });

      return {
        agentCount: agentSummaries.length,
        insights,
        findings,
        agentSummaries,
        timestamp: new Date()
      };

    } catch (error) {
      // File might not exist yet or be empty
      if (error.code === 'ENOENT') {
        this.logger.info('   No agent results file yet (normal for new installations)');
      } else {
        this.logger.warn('Failed to read agent results', { error: error.message });
      }
      
      return {
        agentCount: 0,
        insights: [],
        findings: [],
        agentSummaries: [],
        timestamp: new Date()
      };
    }
  }

  /**
   * Review the current task plan and suggest changes
   */
  async reviewPlan(state) {
    try {
      // Get current plan from state store
      const stateStore = this.phase2bSubsystems?.clusterStateStore;
      if (!stateStore) {
        return { delta: null, rationale: 'No state store available' };
      }
      
      const currentPlan = await stateStore.getPlan('plan:main');
      if (!currentPlan) {
        return { delta: null, rationale: 'No active plan' };
      }
      
      // Get active tasks and recent completions
      const allTasks = await stateStore.listTasks(currentPlan.id);
      const activeTasks = allTasks.filter(t => t.state === 'IN_PROGRESS' || t.state === 'CLAIMED');
      const recentCompletions = allTasks.filter(t => 
        t.state === 'DONE' && 
        t.updatedAt > (Date.now() - 86400000) // Last 24 hours
      );
      
      // CRITICAL: Summarize instead of full JSON to prevent token explosion
      // Full JSON can exceed input limits with 50+ tasks
      const planSummary = {
        id: currentPlan.id,
        title: currentPlan.title,
        version: currentPlan.version,
        milestoneCount: currentPlan.milestones?.length || 0,
        totalTasks: allTasks.length,
        activeTasks: activeTasks.length,
        completedTasks: recentCompletions.length
      };
      
      const activeTasksSummary = activeTasks.slice(0, 10).map(t => ({
        id: t.id,
        title: t.title,
        state: t.state,
        priority: t.priority
      }));
      
      const completionsSummary = recentCompletions.slice(0, 10).map(t => ({
        id: t.id,
        title: t.title,
        completedAt: t.updatedAt
      }));
      
      // DOMAIN ANCHOR: Focus plan review on domain research
      const domainAnchorBlock = getDomainAnchor(this.fullConfig);

      const prompt = `Review the current task plan and recent progress.

${domainAnchorBlock}
  
Plan Summary: ${JSON.stringify(planSummary, null, 2)}
Active Tasks (top 10): ${JSON.stringify(activeTasksSummary, null, 2)}
Recent Completions (top 10): ${JSON.stringify(completionsSummary, null, 2)}

Should we add, remove, or modify any tasks/milestones?
Consider (WITH DOMAIN FOCUS):
- Are there missing tasks needed to complete the DOMAIN RESEARCH plan?
- Are there blocked or unnecessary tasks that should be removed (especially META-POLLUTION tasks)?
- Should task priorities be adjusted based on DOMAIN progress?
- Are milestones properly sequenced FOR THE RESEARCH DOMAIN?

⚠️ REMOVE or SKIP any tasks about QA gates, probes, CLI tools, COSMO infrastructure - these are meta-pollution.

Respond with a PlanDelta JSON object and rationale for any changes.
If no changes are needed, respond with { "noChanges": true }.`;

      const response = await this.gpt5.generate({
        messages: [
          { role: 'system', content: 'You are a strategic task planner reviewing project plans.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 8000, // Reduced back to 8000 since input is now much smaller
        reasoningEffort: 'low' // Strategic: could use 'medium' now that tokens increased, but 'low' is efficient
      });
      
      // Parse PlanDelta from response
      const delta = this.parsePlanDelta(response.content, currentPlan.version);
      
      return {
        delta,
        rationale: response.extended_reasoning || 'Plan review complete'
      };
    } catch (error) {
      this.logger.error('[MetaCoordinator] reviewPlan error', {
        error: error.message
      });
      return { delta: null, rationale: 'Error reviewing plan' };
    }
  }

  /**
   * Audit actual deliverables in runtime/outputs/
   * CRITICAL: Prevents "analysis paralysis" by making coordinator aware of what's actually been created
   * 
   * Checks for actual file outputs from agents to detect gaps like:
   * - Design documents exist but no code implementation
   * - Code created but no test results
   * - Analysis reports but no synthesis
   * 
   * @returns {Object} Audit results with totalFiles, byAgentType, recentFiles, gaps
   */
  async auditDeliverables() {
    const audit = {
      totalFiles: 0,
      byAgentType: {},
      recentFiles: [],
      gaps: [],
      timestamp: new Date().toISOString()
    };

    // Check if we're in injection-only mode
    const mcpServers = this.fullConfig?.mcp?.client?.servers;
    const filesystemServer = mcpServers?.find(s => s.label === 'filesystem') || mcpServers?.[0];
    const allowedPaths = filesystemServer?.allowedPaths || [];
    
    // Detect injection-only mode: only runtime/outputs/injected/ is allowed
    const isInjectionOnlyMode = allowedPaths.length === 1 && 
      (allowedPaths[0] === 'runtime/outputs/injected/' || 
       allowedPaths[0] === 'runtime/outputs/injected' ||
       allowedPaths[0].endsWith('/runtime/outputs/injected/') ||
       allowedPaths[0].endsWith('/runtime/outputs/injected'));
    
    if (isInjectionOnlyMode) {
      this.logger.info('📦 Injection-only mode detected - skipping deliverables audit', {
        mode: 'injection-only',
        note: 'System focused on user-injected documents only'
      });
      
      // Return empty audit without gaps - this is expected behavior
      audit.gaps = []; // No gaps to report in injection-only mode
      return audit;
    }

    // Agent types that create file outputs (scan all output subdirectories)
    const agentTypes = [
      'code-creation', 'code-execution', 'document-creation', 'document-analysis',
      'dataacquisition', 'data-acquisition', 'datapipeline', 'data-pipeline',
      'infrastructure', 'automation', 'ide', 'research', 'synthesis',
      'document-compiler', 'codebase-exploration', 'quality-assurance'
    ];

    try {
      // OPTIMIZED: Use Node.js fs instead of MCP for file operations
      // Faster (50x), zero tokens, same reliability
      const fs = require('fs').promises;
      // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs directory
      // Fallback chain: pathResolver > config.logsDir > skip audit (no process.cwd() fallback)
      let outputsPath;
      if (this.pathResolver) {
        outputsPath = this.pathResolver.getOutputsRoot();
      } else if (this.config?.logsDir) {
        outputsPath = path.join(this.config.logsDir, 'outputs');
      } else {
        this.logger.warn('Cannot determine outputs path for audit - pathResolver and config.logsDir both unavailable');
        audit.gaps.push({
          severity: 'low',
          description: 'Outputs path cannot be determined',
          recommendation: 'Ensure pathResolver or config.logsDir is available'
        });
        return audit;
      }
      
      // Try to access outputs directory
      let outputsDirExists = false;
      try {
        await fs.access(outputsPath);
        outputsDirExists = true;
        this.logger.debug('📦 Outputs directory found', { path: outputsPath });
      } catch (error) {
        // Directory doesn't exist
        this.logger.info('Outputs directory not accessible (may not exist yet)', {
          path: outputsPath,
          error: error.message
        });
        
        audit.gaps.push({
          type: 'missing_outputs_directory',
          severity: 'low',
          description: 'No outputs directory exists yet - no agent deliverables created',
          recommendation: 'Normal for new runs - agents will create outputs as they work'
        });
        
        return audit;
      }

      // Check each agent type subdirectory
      for (const agentType of agentTypes) {
        try {
          const agentPath = path.join(outputsPath, agentType);
          
          // OPTIMIZED: Use Node.js fs instead of MCP
          let agentDirs = [];
          try {
            const entries = await fs.readdir(agentPath, { withFileTypes: true });
            agentDirs = entries.filter(e => e.isDirectory()).map(e => ({ name: e.name, type: 'directory' }));
          } catch (readError) {
            // Directory doesn't exist
            audit.byAgentType[agentType] = 0;
            continue;
          }

          // Count files in each agent's output directory (recursively)
          let agentFileCount = 0;
          for (const agentDir of agentDirs) {
            try {
              // Recursively count actual deliverable files
              const fileCount = await this.countDeliverablesRecursive(path.join(agentPath, agentDir.name), agentType, audit);
              agentFileCount += fileCount;
            } catch (fileError) {
              // Skip this directory
              this.logger.debug('Could not list files in agent directory', {
                path: path.join(agentPath, agentDir.name),
                error: fileError.message
              });
            }
          }

          audit.byAgentType[agentType] = agentFileCount;
          audit.totalFiles += agentFileCount;

        } catch (error) {
          // Directory doesn't exist for this agent type - that's fine
          audit.byAgentType[agentType] = 0;
          this.logger.debug('Agent type directory not found (normal if not used yet)', {
            agentType,
            error: error.message
          });
        }
      }

      // Identify gaps based on what exists vs what's missing
      const hasCodeFiles = (audit.byAgentType['code-creation'] || 0) > 0;
      const hasTestResults = (audit.byAgentType['code-execution'] || 0) > 0;
      const hasDocuments = (audit.byAgentType['document-creation'] || 0) > 0;
      const hasAnalysis = (audit.byAgentType['document-analysis'] || 0) > 0;

      // Gap detection logic
      if (!hasCodeFiles && (hasDocuments || hasAnalysis)) {
        audit.gaps.push({
          type: 'missing_implementation',
          severity: 'high',
          description: 'Design/analysis documents exist but no code files created',
          recommendation: 'Spawn CodeCreationAgent to implement based on existing design',
          evidence: {
            documents: audit.byAgentType['document-creation'] || 0,
            analysis: audit.byAgentType['document-analysis'] || 0,
            code: 0
          }
        });
      }

      if (hasCodeFiles && !hasTestResults) {
        audit.gaps.push({
          type: 'missing_validation',
          severity: 'medium',
          description: 'Code files exist but no test/execution results',
          recommendation: 'Spawn CodeExecutionAgent to validate implementation',
          evidence: {
            codeFiles: audit.byAgentType['code-creation'],
            testResults: 0
          }
        });
      }

      // IMPORTANT: Only flag "no_deliverables" if we've had enough cycles for agents to complete
      // Early reviews (cycles 3-5) should NOT create urgent goals about missing outputs
      // because agents are likely still working on their first tasks
      const cycleCount = this.lastReviewCycle || 0;
      const isEarlyReview = cycleCount < 6; // First few reviews need patience
      
      if (audit.totalFiles === 0 && outputsDirExists && !isEarlyReview) {
        audit.gaps.push({
          type: 'no_deliverables',
          severity: 'high',
          description: 'Outputs directory exists but no files have been created by any agents',
          recommendation: 'Review agent mission specifications - agents may not be producing tangible outputs',
          evidence: {
            agentsChecked: agentTypes.join(', ')
          }
        });
      } else if (audit.totalFiles === 0 && outputsDirExists && isEarlyReview) {
        // Log but don't create gap for early reviews
        this.logger.info('📦 No deliverables yet (early review - agents likely still working)', {
          cycleCount,
          note: 'Waiting for agents to complete before flagging as gap'
        });
      }

      this.logger.info('📦 Deliverables audit complete', {
        totalFiles: audit.totalFiles,
        byType: audit.byAgentType,
        gaps: audit.gaps.length
      });

    } catch (error) {
      this.logger.warn('Deliverables audit failed (non-fatal)', {
        error: error.message,
        stack: error.stack
      });
      
      audit.gaps.push({
        type: 'audit_error',
        severity: 'low',
        description: `Audit failed: ${error.message}`,
        recommendation: 'Check MCP configuration and runtime/outputs/ directory permissions'
      });
    }

    return audit;
  }

  /**
   * P7: Audit deliverables using semantic classification
   * 
   * Queries ClusterStateStore task.artifacts[] which are already classified by agent intent
   * Filters by artifact.kind instead of hardcoded path patterns
   * Falls back to filesystem audit if ClusterStateStore unavailable
   * 
   * @returns {Object} Audit results with totalFiles, byPhase, gaps, source
   */
  async auditCanonicalDeliverables() {
    const audit = {
      totalFiles: 0,
      byPhase: {},           // Group by phase
      byAgentType: {},       // Keep for compatibility
      byKind: {},            // NEW: Count by semantic kind
      recentFiles: [],
      gaps: [],
      timestamp: new Date().toISOString(),
      source: 'clusterStateStore'
    };
    
    // Require ClusterStateStore - fall back if not available
    if (!this.phase2bSubsystems?.clusterStateStore) {
      this.logger.debug('ClusterStateStore not available, using filesystem audit');
      return this.auditDeliverables(); // Fallback to existing method
    }
    
    const stateStore = this.phase2bSubsystems.clusterStateStore;
    
    try {
      // Get active plan
      const plan = await stateStore.getPlan('plan:main');
      
      if (!plan) {
        this.logger.debug('No active plan found, using filesystem audit');
        return this.auditDeliverables(); // Fallback
      }
      
      // Get all tasks
      const allTasks = await stateStore.listTasks(plan.id);
      
      this.logger.debug('📦 Auditing canonical deliverables from ClusterStateStore', {
        planId: plan.id,
        totalTasks: allTasks.length,
        completedTasks: allTasks.filter(t => t.state === 'DONE').length
      });
      
      // Collect ALL artifacts (we'll filter semantically)
      const allArtifacts = [];
      
      for (const task of allTasks) {
        if (!task.artifacts || task.artifacts.length === 0) continue;
        
        for (const artifact of task.artifacts) {
          allArtifacts.push({
            ...artifact,
            taskId: task.id,
            taskTitle: task.title,
            taskState: task.state,
            phase: task.milestoneId
          });
        }
      }
      
      // P7: SEMANTIC FILTER - Use agent's explicit intent (artifact.kind)
      const userFacingDeliverables = allArtifacts.filter(a => {
        // PRIMARY: Agent marked as deliverable
        if (a.kind === 'deliverable') return true;
        
        // EXCLUDE: Agent marked as log or manifest
        if (a.kind === 'log' || a.kind === 'manifest') return false;
        
        // UNKNOWN/FILE: Conservative - exclude unless from completed task
        // This prevents counting intermediate artifacts
        if (a.taskState === 'DONE' && a.kind === 'file') {
          // Could be deliverable, include it
          return true;
        }
        
        return false;
      });
      
      // Count by phase
      for (const deliverable of userFacingDeliverables) {
        const phase = deliverable.phase || 'unknown';
        audit.byPhase[phase] = (audit.byPhase[phase] || 0) + 1;
        
        const agentType = deliverable.agentType || 'unknown';
        audit.byAgentType[agentType] = (audit.byAgentType[agentType] || 0) + 1;
        
        const kind = deliverable.kind || 'file';
        audit.byKind[kind] = (audit.byKind[kind] || 0) + 1;
      }
      
      audit.totalFiles = userFacingDeliverables.length;
      
      // Track recent deliverables (last 10, sorted by recordedAt)
      audit.recentFiles = userFacingDeliverables
        .filter(d => d.recordedAt)
        .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
        .slice(0, 10)
        .map(d => ({
          path: d.absolutePath || d.path,
          size: d.size,
          taskTitle: d.taskTitle,
          phase: d.phase,
          agentType: d.agentType,
          kind: d.kind,
          recordedAt: d.recordedAt
        }));
      
      // Gap detection - semantic analysis
      const completedTasks = allTasks.filter(t => t.state === 'DONE');
      const artifactCounts = {
        total: allArtifacts.length,
        deliverables: allArtifacts.filter(a => a.kind === 'deliverable').length,
        logs: allArtifacts.filter(a => a.kind === 'log').length,
        unknown: allArtifacts.filter(a => a.kind === 'file' || !a.kind).length
      };
      
      if (artifactCounts.deliverables === 0 && completedTasks.length > 0) {
        audit.gaps.push({
          type: 'no_user_facing_deliverables',
          severity: 'high',
          description: `${completedTasks.length} tasks completed but no artifacts marked as deliverables`,
          recommendation: 'Review agent outputs - agents may be creating logs instead of user-facing deliverables',
          evidence: artifactCounts
        });
      }
      
      // Log audit summary
      this.logger.info('📦 Canonical deliverables audit complete', {
        source: 'ClusterStateStore (semantic)',
        totalArtifacts: allArtifacts.length,
        byKind: artifactCounts,
        userFacingDeliverables: audit.totalFiles,
        byPhase: audit.byPhase,
        gaps: audit.gaps.length
      });
      
      return audit;
      
    } catch (error) {
      this.logger.error('Canonical deliverables audit failed, falling back to filesystem', {
        error: error.message
      });
      
      // Non-breaking: Fall back to existing filesystem audit
      return this.auditDeliverables();
    }
  }

  /**
   * Get all deliverables for a specific goal
   * Scans runtime/outputs/ for manifests/metadata with matching goalId
   * 
   * @param {string} goalId - The goal ID to find deliverables for
   * @returns {Promise<Array>} Array of deliverable info objects
   */
  async getDeliverablesForGoal(goalId) {
    const fs = require('fs').promises;
    const path = require('path');
    
    if (!goalId) return [];
    
    const deliverables = [];
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs directory
    // Fallback chain: pathResolver > config.logsDir > return empty (no process.cwd() fallback)
    let outputsDir;
    if (this.pathResolver) {
      outputsDir = this.pathResolver.getOutputsRoot();
    } else if (this.config?.logsDir) {
      outputsDir = path.join(this.config.logsDir, 'outputs');
    } else {
      this.logger.warn('Cannot determine outputs directory for goal deliverables scan - skipping');
      return [];
    }
    
    try {
      // Scan ALL subdirectories in outputs/ rather than hardcoding agent type names
      // This ensures execution agents (dataacquisition, datapipeline, etc.) are discovered
      let agentTypes;
      try {
        const allDirs = await fs.readdir(outputsDir);
        const stats = await Promise.all(allDirs.map(async d => {
          try { return { name: d, isDir: (await fs.stat(path.join(outputsDir, d))).isDirectory() }; }
          catch { return { name: d, isDir: false }; }
        }));
        agentTypes = stats.filter(s => s.isDir).map(s => s.name);
      } catch {
        agentTypes = [];
      }

      for (const agentType of agentTypes) {
        const agentTypeDir = path.join(outputsDir, agentType);

        try {
          const agentDirs = await fs.readdir(agentTypeDir);
          
          for (const agentDir of agentDirs) {
            const agentPath = path.join(agentTypeDir, agentDir);
            
            // Try manifest.json first
            try {
              const manifestPath = path.join(agentPath, 'manifest.json');
              const manifestData = await fs.readFile(manifestPath, 'utf8');
              const manifest = JSON.parse(manifestData);
              
              if (manifest.goalId === goalId) {
                deliverables.push({
                  agentId: manifest.agentId,
                  agentType: manifest.agentType || agentType,
                  manifestPath,
                  manifest,
                  goalId: manifest.goalId,
                  canonical: manifest.canonical || false,
                  supersededBy: manifest.supersededBy || null,
                  completedAt: manifest.completedAt,
                  files: manifest.files || []
                });
              }
            } catch (manifestError) {
              // Try metadata files (document-creation uses different naming)
              try {
                const files = await fs.readdir(agentPath);
                const metadataFile = files.find(f => f.endsWith('_metadata.json'));
                
                if (metadataFile) {
                  const metadataPath = path.join(agentPath, metadataFile);
                  const metadataContent = await fs.readFile(metadataPath, 'utf8');
                  const metadata = JSON.parse(metadataContent);
                  
                  if (metadata.goalId === goalId) {
                    deliverables.push({
                      agentId: metadata.agentId || metadata.createdBy,
                      agentType: metadata.agentType || agentType,
                      manifestPath: metadataPath,
                      manifest: metadata,
                      goalId: metadata.goalId,
                      canonical: metadata.canonical || false,
                      supersededBy: metadata.supersededBy || null,
                      completedAt: metadata.completedAt,
                      files: metadata.files || [{ path: metadata.filePath }]
                    });
                  }
                }
              } catch (metadataError) {
                // No metadata, skip
              }
            }
          }
        } catch (agentTypeError) {
          // Agent type directory doesn't exist, skip
        }
      }
    } catch (error) {
      this.logger.warn('Could not scan deliverables for goal', {
        goalId,
        error: error.message
      });
    }
    
    return deliverables;
  }

  /**
   * Select canonical deliverable for a goal
   * When multiple agents produce outputs for same goal, pick the best one
   * 
   * Ranking criteria (in priority order):
   * 1. Synthesis agent outputs (highest priority)
   * 2. Most recent completion
   * 3. Most files/content
   * 
   * @param {string} goalId - The goal ID to select canonical for
   * @returns {Promise<Object|null>} Selected canonical deliverable or null
   */
  async selectCanonicalDeliverable(goalId) {
    const deliverables = await this.getDeliverablesForGoal(goalId);
    
    if (deliverables.length === 0) {
      this.logger.debug('No deliverables found for goal', { goalId });
      return null;
    }
    
    // If only one, mark it canonical
    if (deliverables.length === 1) {
      await this.markDeliverableCanonical(deliverables[0]);
      return deliverables[0];
    }
    
    // Multiple exist - rank them
    const ranked = this.rankDeliverables(deliverables);
    const canonical = ranked[0];
    
    // Mark the best as canonical
    await this.markDeliverableCanonical(canonical);
    
    // Mark others as superseded
    const superseded = ranked.slice(1);
    for (const deliverable of superseded) {
      await this.markDeliverableSuperseded(deliverable, canonical.agentId);
    }
    
    this.logger.info('✅ Selected canonical deliverable', {
      goalId,
      canonicalAgent: canonical.agentId,
      agentType: canonical.agentType,
      supersededCount: superseded.length
    });
    
    return canonical;
  }

  /**
   * Rank deliverables by quality/recency
   * Priority: synthesis > recent > most files
   */
  rankDeliverables(deliverables) {
    return deliverables.sort((a, b) => {
      // 1. Synthesis agents first
      if (a.agentType === 'synthesis' && b.agentType !== 'synthesis') return -1;
      if (b.agentType === 'synthesis' && a.agentType !== 'synthesis') return 1;
      
      // 2. More recent completion
      const aTime = new Date(a.completedAt || a.manifest.createdAt || 0).getTime();
      const bTime = new Date(b.completedAt || b.manifest.createdAt || 0).getTime();
      if (bTime !== aTime) return bTime - aTime; // Newer first
      
      // 3. More files
      const aFiles = a.files?.length || 0;
      const bFiles = b.files?.length || 0;
      return bFiles - aFiles; // More files first
    });
  }

  /**
   * Mark a deliverable as canonical
   */
  async markDeliverableCanonical(deliverable) {
    const fs = require('fs').promises;
    
    try {
      const manifest = deliverable.manifest;
      manifest.canonical = true;
      manifest.canonicalMarkedAt = new Date().toISOString();
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          deliverable.manifestPath,  // Use absolute path - pathResolver handles it correctly
          JSON.stringify(manifest, null, 2),
          { agentId: 'meta-coordinator', agentType: 'meta-coordinator', missionGoal: 'governance' }
        );
      } else {
        await fs.writeFile(
          deliverable.manifestPath,
          JSON.stringify(manifest, null, 2),
          'utf8'
        );
      }
      
      this.logger.debug('Marked deliverable as canonical', {
        agentId: deliverable.agentId,
        manifestPath: deliverable.manifestPath
      });
    } catch (error) {
      this.logger.warn('Could not mark deliverable as canonical', {
        agentId: deliverable.agentId,
        error: error.message
      });
    }
  }

  /**
   * Mark a deliverable as superseded
   */
  async markDeliverableSuperseded(deliverable, supersedingAgentId) {
    const fs = require('fs').promises;
    
    try {
      const manifest = deliverable.manifest;
      manifest.canonical = false;
      manifest.supersededBy = supersedingAgentId;
      manifest.supersededAt = new Date().toISOString();
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          deliverable.manifestPath,  // Use absolute path - pathResolver handles it correctly
          JSON.stringify(manifest, null, 2),
          { agentId: 'meta-coordinator', agentType: 'meta-coordinator', missionGoal: 'governance' }
        );
      } else {
        await fs.writeFile(
          deliverable.manifestPath,
          JSON.stringify(manifest, null, 2),
          'utf8'
        );
      }
      
      this.logger.debug('Marked deliverable as superseded', {
        agentId: deliverable.agentId,
        supersededBy: supersedingAgentId
      });
    } catch (error) {
      this.logger.warn('Could not mark deliverable as superseded', {
        agentId: deliverable.agentId,
        error: error.message
      });
    }
  }

  /**
   * Parse PlanDelta from GPT response
   */
  parsePlanDelta(content, expectedVersion) {
    try {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Check for "no changes" response
      if (parsed.noChanges) {
        return null;
      }
      
      // Ensure it has required fields
      if (!parsed.planId) {
        parsed.planId = 'plan:main';
      }
      if (typeof parsed.expectedVersion !== 'number') {
        parsed.expectedVersion = expectedVersion;
      }
      
      return parsed;
    } catch (error) {
      this.logger.warn('[MetaCoordinator] Failed to parse PlanDelta', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Make strategic decisions based on all analyses
   */
  async makeStrategicDecisions(analyses) {
    const {
      cognitiveAnalysis,
      goalEvaluation,
      memoryAnalysis,
      agentResults,
      deliverables,
      systemHealth,
      previousContext,
      // NEW: Work in progress awareness
      activeAgents = [],
      activeAgentCount = 0,
      guidedMissionPlan = null,
      goals = null,
      cycleCount = 0,
      // TEMPORAL: Delta for temporal analysis
      stateDelta = null
    } = analyses;

    // Get architecture context for strategic awareness
    const architectureContext = await this.getArchitectureContext();

    // Load latest planning assessment for context-aware strategic decisions
    let planningAssessmentContext = '';
    try {
      const assessmentFiles = await fs.readdir(this.coordinatorDir);
      const assessmentJsonFiles = assessmentFiles
        .filter(f => f.startsWith('planning-assessment-') && f.endsWith('.json'))
        .sort()
        .reverse(); // Newest first

      if (assessmentJsonFiles.length > 0) {
        const latestPath = path.join(this.coordinatorDir, assessmentJsonFiles[0]);
        const rawData = await fs.readFile(latestPath, 'utf8');
        const assessmentData = JSON.parse(rawData);

        planningAssessmentContext = `

## PLANNING ASSESSMENT (PGS Brain Sweep at Startup)

The following assessment was produced by a deep PGS sweep before planning.
It shows what the brain knows and what gaps exist:

${assessmentData.answer || 'No assessment answer available.'}

## ASSESSMENT GUIDANCE

Use this to evaluate whether current agent work is addressing the identified gaps.
Flag if:
- Agents are researching topics already marked as well-covered
- Identified gaps are not being addressed by any active agent
- Execution phases (datapipeline, infrastructure) should be prioritized over redundant research
- The plan needs adjustment based on progress since this assessment
`;

        this.logger?.info('📋 Planning assessment loaded for strategic review', {
          assessmentFile: assessmentJsonFiles[0],
          nodeCount: assessmentData.nodeCount,
          partitionsSwept: assessmentData.partitionsSwept
        });
      }
    } catch (err) {
      this.logger?.debug('No planning assessment available (non-fatal)', { error: err.message });
    }

    // Validate inputs - prevent cascading failures from error strings
    const cognitiveContent = (cognitiveAnalysis && !cognitiveAnalysis.failed && cognitiveAnalysis.content) 
      ? cognitiveAnalysis.content 
      : 'Cognitive analysis unavailable.';
    
    const goalContent = (goalEvaluation && !goalEvaluation.failed && goalEvaluation.content)
      ? goalEvaluation.content
      : 'Goal evaluation unavailable.';
    
    const memoryContent = (memoryAnalysis && !memoryAnalysis.failed && memoryAnalysis.content)
      ? memoryAnalysis.content
      : 'Memory analysis unavailable.';

    // Format agent results for strategic review
    const agentResultsSummary = agentResults && agentResults.agentCount > 0 ? 
      `SPECIALIST AGENT RESULTS (${agentResults.agentCount} agents completed):

${agentResults.agentSummaries.map((agent, i) => `
Agent ${i + 1}: ${agent.agentType}
- Goal: ${agent.goal.substring(0, 150)}${agent.goal.length > 150 ? '...' : ''}
- Status: ${agent.status}
- Results: ${agent.insightsCount} insights, ${agent.findingsCount} findings
- Duration: ${agent.duration}
${agent.sampleInsights.length > 0 ? `- Key Insights:\n${agent.sampleInsights.map((ins, j) => `  ${j + 1}. ${(typeof ins === 'string' ? ins : ins?.content || JSON.stringify(ins)).substring(0, 200)}...`).join('\n')}` : ''}
${agent.sampleFindings.length > 0 ? `- Key Findings:\n${agent.sampleFindings.slice(0, 2).map((f, j) => `  ${j + 1}. ${(typeof f === 'string' ? f : f?.content || JSON.stringify(f)).substring(0, 150)}...`).join('\n')}` : ''}
`).join('\n---\n')}

TOTAL INSIGHTS FROM AGENTS: ${agentResults.insights.length}
TOTAL FINDINGS FROM AGENTS: ${agentResults.findings.length}
` : 'SPECIALIST AGENT RESULTS: No agents have completed yet.';

    const contextSummary = previousContext.length > 0 ?
      `PREVIOUS REVIEW CONTEXT:\n${previousContext.map((c, i) => 
        `Review ${i + 1} (Cycle ${c.cycle}):\n- Key insights: ${c.keyInsights.join('; ')}\n- Priorities: ${c.priorities.map(p => p.description?.substring(0, 50)).join('; ')}`
      ).join('\n\n')}` :
      'PREVIOUS CONTEXT: This is the first review.';
    
    // TEMPORAL: Add delta analysis to context
    const deltaContext = stateDelta && !stateDelta.isFirstReview ?
      `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPORAL DELTA ANALYSIS (Chronicle of Change):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${stateDelta.summary}

Detailed Changes:
• Goals Active: ${stateDelta.goals.active.previous} → ${stateDelta.goals.active.current} (${stateDelta.goals.active.change >= 0 ? '+' : ''}${stateDelta.goals.active.change}, ${stateDelta.goals.active.percentChange}%)
• Goals Completed: ${stateDelta.goals.completed.previous} → ${stateDelta.goals.completed.current} (${stateDelta.goals.completed.change >= 0 ? '+' : ''}${stateDelta.goals.completed.change})
• Memory Nodes: ${stateDelta.memory.nodes.previous} → ${stateDelta.memory.nodes.current} (${stateDelta.memory.nodes.change >= 0 ? '+' : ''}${stateDelta.memory.nodes.change}, ${stateDelta.memory.nodes.growthRate} nodes/cycle)
• Memory Edges: ${stateDelta.memory.edges.previous} → ${stateDelta.memory.edges.current} (${stateDelta.memory.edges.change >= 0 ? '+' : ''}${stateDelta.memory.edges.change})
• Agents Completed: ${stateDelta.agents.completionsThisPeriod} (rate: ${stateDelta.agents.completionRate}/cycle)
${stateDelta.deliverables ? `• Deliverables: ${stateDelta.deliverables.previous} → ${stateDelta.deliverables.current} (${stateDelta.deliverables.change >= 0 ? '+' : ''}${stateDelta.deliverables.change})` : ''}

⚠️ CRITICAL TEMPORAL QUESTION: What explains these changes? What patterns emerged or degraded?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` :
      '';

    // Format deliverables audit for strategic awareness
    const deliverablesContext = deliverables ? `
DELIVERABLES AUDIT (Actual Work Products):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Total files created: ${deliverables.totalFiles}
- Code files: ${deliverables.byAgentType['code-creation'] || 0}
- Test/execution results: ${deliverables.byAgentType['code-execution'] || 0}
- Documents: ${deliverables.byAgentType['document-creation'] || 0}
- Analysis outputs: ${deliverables.byAgentType['document-analysis'] || 0}

${deliverables.recentFiles.length > 0 ? `Recent files created:
${deliverables.recentFiles.map(f => `- ${f.path} (${f.agentType}, ${(f.size / 1024).toFixed(1)}KB)`).join('\n')}` : ''}

${deliverables.gaps.length > 0 ? `⚠️ CRITICAL GAPS DETECTED:
${deliverables.gaps.map(g => `- [${g.severity.toUpperCase()}] ${g.description}
  → Recommendation: ${g.recommendation}`).join('\n\n')}` : '✅ No major gaps detected in deliverables'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : '';

    // NEW: Work in progress context - prevent premature gap-filling
    const guidedPlanInfo = guidedMissionPlan ? `
CURRENT GUIDED MISSION PLAN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Plan: ${guidedMissionPlan.title || 'Untitled'} (v${guidedMissionPlan.version})
Phases/Tasks already planned:
${(guidedMissionPlan.taskPhases || []).map((p, i) => `- Phase ${i + 1}: ${p.name} (${p.status || 'PLANNED'})`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : '';

    const workInProgressContext = (activeAgentCount > 0 || guidedMissionPlan) ? `
⚠️ SITUATIONAL AWARENESS - DO NOT CREATE REDUNDANT GOALS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${guidedPlanInfo}
${activeAgentCount} agent(s) are currently working:
${activeAgents.map(a => `- [${a.type}] ${a.goal} (progress: ${a.progress || 0}%)`).join('\n')}

🛑 BEFORE creating urgent goals to fill "gaps", check if:
   1. The work is ALREADY in the Guided Mission Plan phases above.
   2. Active agents are ALREADY working on it.
   
   If either is true, DO NOT create a duplicate goal. 
   Only create urgent goals for GENUINELY missing work not covered by the plan or active agents.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : (cycleCount < 6 ? `
ℹ️ EARLY REVIEW (Cycle ${cycleCount}):
   This is an early review. Agents may still be working on initial tasks.
   Be patient before flagging "no outputs" as critical gaps.
` : '');

    // DOMAIN ANCHOR: Prevent meta-pollution in strategic decisions
    const domainAnchorBlock = getDomainAnchor(this.fullConfig);

    const decisionPrompt = `You are the Meta-Coordinator making strategic decisions for an autonomous AI system.

${domainAnchorBlock}

${architectureContext}
${this.getVoiceContext()}

${contextSummary}
${deltaContext}

CURRENT STATE ANALYSIS:

COGNITIVE WORK REVIEW:
${cognitiveContent}

GOAL PORTFOLIO EVALUATION:
${goalContent}

MEMORY NETWORK ANALYSIS:
${memoryContent}

${agentResultsSummary}

${deliverablesContext}
${workInProgressContext}
${planningAssessmentContext}
${(() => { try { return new CapabilityManifest().getCoordinatorInjectionText(); } catch (e) { return ''; } })()}
SYSTEM HEALTH:
- Curiosity: ${(systemHealth.cognitiveState.curiosity * 100).toFixed(0)}%
- Mood: ${(systemHealth.cognitiveState.mood * 100).toFixed(0)}%
- Energy: ${(systemHealth.cognitiveState.energy * 100).toFixed(0)}%

Based on this comprehensive analysis INCLUDING agent discoveries AND actual deliverables, make strategic decisions:

⚠️ DOMAIN FOCUS MANDATE: All goals, insights, and directives below MUST advance the user's research domain (shown in DOMAIN ANCHOR above). Discard any meta-concerns about COSMO's internal operation.

1. **TOP 5 GOALS TO PRIORITIZE** - List specific goal IDs from the portfolio with brief rationale (MUST be domain-relevant)
2. **KEY INSIGHTS** - 3-5 most important observations from this review (MUST relate to the research domain)
3. **STRATEGIC DIRECTIVES** - 3-5 high-level directions for the next ${this.reviewInterval} cycles (MUST advance domain research)
4. **URGENT GOALS TO CREATE** - If deliverables gaps detected, create new goals to fill them (MUST produce domain outputs for USER).

⚠️ CRITICAL DELIVERABLES-BASED ACTION:
When gaps are detected, create URGENT GOALS in this exact JSON format:
[
  {
    "description": "<clear description of what needs to be done based on actual deliverables>",
    "agentType": "ide",
    "priority": <0.0-1.0, use 0.95 for critical gaps>,
    "urgency": "<low|medium|high>",
    "rationale": "<why this goal is needed based on gap analysis>"
  }
]

Gap-to-Agent-Type Mapping (IDE-First Mode):
- ALL implementation gaps → agentType: "ide" (IDE agent handles code, docs, analysis, validation)
- ONLY for external web search → agentType: "research"
- Web scraping, crawling, API data fetching → agentType: "dataacquisition"
- Data transformation, database creation, ETL → agentType: "datapipeline"
- Docker, environment setup, dependency install → agentType: "infrastructure"
- File operations, batch processing, OS automation → agentType: "automation"

Requirements:
- Urgent goals bypass normal selection - they get TOP priority
- Description must reference ACTUAL deliverables found in the audit
- Include clear agentType hint and specific rationale
- Focus on TANGIBLE OUTPUTS and CLOSING THE IMPLEMENTATION LOOP`;

    try {
      const decisions = await this.gpt5.generateWithRetry({
        model: this.config.models?.coordinatorStrategic, // Use strategic model for strategic decisions - this is important!
        instructions: decisionPrompt,
        messages: [{ role: 'user', content: 'Generate strategic action plan - be comprehensive but concise.' }],
        maxTokens: 16000, // Maximum allocation - most important strategic decision point (capped at API max)
        reasoningEffort: 'high', // Maximum reasoning for strategic decisions that set system direction
        verbosity: 'high' // Want rich strategic output
      }, 3);

      // VOICE: Parse output for voice markers before other parsing
      let content = decisions.content || '';
      if (this.voiceEnabled && content) {
        content = this.parseForVoice(content);
      }
      
      // Parse decisions
      const prioritizedGoalsInput = Array.isArray(goalEvaluation?.prioritizedGoals)
        ? goalEvaluation.prioritizedGoals
        : [];
      const prioritizedGoals = this.applySpecializationRouting(prioritizedGoalsInput);
      const keyInsights = this.extractKeyInsights(content);
      const strategicDirectives = this.extractDirectives(content);
      const rawUrgentGoals = this.extractUrgentGoals(content);
      const goalsToArchive = this.extractGoalsToArchive(content);

      // ✅ FIX P1.1: Check against active TASK goalIds BEFORE filtering
      // This prevents creating urgent goals that duplicate work already assigned to task agents
      // Critical: Tasks have goalIds in metadata, but urgent goals get NEW goalIds from addGoal()
      // We need to do this check BEFORE the filter since filter callbacks can't be async
      
      // Build task goalId lookup map
      let taskGoalDescriptions = new Map();  // goalId -> description
      if (this.subsystems?.clusterStateStore) {
        try {
          const activePlan = await this.subsystems.clusterStateStore.getPlan('plan:main');
          if (activePlan) {
            const tasks = await this.subsystems.clusterStateStore.listTasks(activePlan.id);
            const activeTasks = tasks.filter(t => t.state !== 'DONE' && t.state !== 'FAILED');
            
            // Get active agents working on task goalIds
            const activeAgentsFromExecutor = this.subsystems?.agentExecutor?.registry?.getActiveAgents() || [];
            const taskGoalIds = new Set(activeTasks.map(t => t.metadata?.goalId).filter(Boolean));
            
            // Build map of goalId -> task description for pursued tasks
            activeAgentsFromExecutor.forEach(agentState => {
              if (taskGoalIds.has(agentState.mission.goalId)) {
                const task = activeTasks.find(t => t.metadata?.goalId === agentState.mission.goalId);
                if (task) {
                  taskGoalDescriptions.set(agentState.mission.goalId, task.description || task.title || '');
                }
              }
            });
          }
        } catch (error) {
          this.logger.warn('Task goalId lookup failed (will skip check)', { 
            error: error.message 
          });
        }
      }

      // SITUATIONAL AWARENESS: Filter out redundant goals
      const urgentGoals = rawUrgentGoals.filter(newGoal => {
        const desc = newGoal.description?.toLowerCase() || '';
        
        // 1. Check if already in guided plan phases
        const isPlanned = guidedMissionPlan?.taskPhases?.some(phase => {
          const phaseName = phase.name?.toLowerCase() || '';
          const phaseDesc = phase.description?.toLowerCase() || '';
          return desc.includes(phaseName) || phaseName.includes(desc) || 
                 desc.includes(phaseDesc) || phaseDesc.includes(desc);
        });
        
        if (isPlanned) {
          this.logger.info('🚫 Deduplicated goal (already in Guided Plan)', { goal: newGoal.description.substring(0, 50) });
          return false;
        }

        // 2. Check if active agents are already working on it
        const isBeingWorkedOn = activeAgents?.some(agent => {
          const agentGoal = agent.goal?.toLowerCase() || '';
          return desc.includes(agentGoal) || agentGoal.includes(desc);
        });

        if (isBeingWorkedOn) {
          this.logger.info('🚫 Deduplicated goal (already being worked on by agent)', { goal: newGoal.description.substring(0, 50) });
          return false;
        }

        // 3. Check if it's already an active goal in the system
        const isAlreadyAGoal = goals?.active?.some(([id, g]) => {
          const existingDesc = g.description?.toLowerCase() || '';
          return desc.includes(existingDesc) || existingDesc.includes(desc);
        });

        if (isAlreadyAGoal) {
          this.logger.info('🚫 Deduplicated goal (already exists in goal system)', { goal: newGoal.description.substring(0, 50) });
          return false;
        }

        // 4. ✅ FIX P1.1: Check against active TASK goalIds (now synchronous)
        if (taskGoalDescriptions.size > 0) {
          const urgentDesc = desc.substring(0, 50);
          
          for (const [goalId, taskDesc] of taskGoalDescriptions) {
            const taskShort = taskDesc.toLowerCase().substring(0, 50);
            // Fuzzy match: either contains the other (use 20 chars for overlap)
            const overlaps = urgentDesc.includes(taskShort.substring(0, 20)) ||
                           taskShort.includes(urgentDesc.substring(0, 20));
            
            if (overlaps) {
              this.logger.info('🚫 Deduplicated goal (task agent already working on this)', { 
                goal: newGoal.description.substring(0, 50),
                matchingTaskGoalId: goalId,
                reason: 'matches_active_task_goalId'
              });
              return false;
            }
          }
        }

        return true;
      });

      if (urgentGoals.length < rawUrgentGoals.length) {
        this.logger.info('🎯 Programmatic deduplication complete', {
          original: rawUrgentGoals.length,
          filtered: urgentGoals.length,
          removed: rawUrgentGoals.length - urgentGoals.length
        });
      }

      return {
        content: decisions.content || 'Strategic decisions incomplete',
        reasoning: decisions.reasoning,
        prioritizedGoals,
        keyInsights,
        strategicDirectives,
        urgentGoals,
        goalsToArchive,  // NEW: Goals recommended for archiving
        activePlan: guidedMissionPlan, // PLAN INTEGRITY: Pass active plan for command generation
        timestamp: new Date(),
        specializationRouting: this.lastSpecializationRouting,
        failed: !decisions.content
      };
    } catch (error) {
      this.logger.error('Strategic decisions failed', {
        error: error.message
      });
      return {
        content: 'Strategic decisions unavailable due to API error.',
        reasoning: null,
        prioritizedGoals: goalEvaluation?.prioritizedGoals || [],
        keyInsights: [],
        strategicDirectives: [],
        timestamp: new Date(),
        failed: true
      };
    }
  }

  /**
   * Generate comprehensive report
   */
  async generateReport(data) {
    const {
      cycleRange,
      cognitiveAnalysis,
      goalEvaluation,
      memoryAnalysis,
      agentResults,
      deliverables,
      systemHealth,
      decisions,
      reviewDuration
    } = data;

    const report = {
      reviewId: `review_${cycleRange[1]}`,
      timestamp: new Date(),
      cycleRange,
      reviewDuration,
      
      summary: {
        cyclesReviewed: cycleRange[1] - cycleRange[0],
        thoughtsAnalyzed: cognitiveAnalysis?.cyclesReviewed || 0,
        goalsEvaluated: goalEvaluation?.totalGoals || 0,
        memoryNodes: memoryAnalysis?.stats?.nodes || 0,
        memoryEdges: memoryAnalysis?.stats?.edges || 0,
        agentsCompleted: agentResults?.agentCount || 0,
        agentInsights: agentResults?.insights?.length || 0,
        agentFindings: agentResults?.findings?.length || 0,
        deliverablesTotal: deliverables?.totalFiles || 0,
        deliverablesGaps: deliverables?.gaps?.length || 0
      },
      
      cognitiveWork: {
        analysis: cognitiveAnalysis?.content || 'No analysis available',
        reasoning: cognitiveAnalysis?.reasoning || null,
        thoughtsByRole: cognitiveAnalysis?.thoughtsByRole || {}
      },
      
      goalPortfolio: {
        evaluation: goalEvaluation?.content || 'No evaluation available',
        reasoning: goalEvaluation?.reasoning || null,
        prioritizedGoals: Array.isArray(goalEvaluation?.prioritizedGoals) ? goalEvaluation.prioritizedGoals : [],
        totalGoals: goalEvaluation?.totalGoals || 0,
        pursuedCount: goalEvaluation?.pursuedCount || 0
      },
      
      memoryNetwork: {
        analysis: memoryAnalysis?.content || 'No analysis available',
        stats: memoryAnalysis?.stats || { nodes: 0, edges: 0, avgDegree: 0, clusters: 0 },
        strongConnections: memoryAnalysis?.strongConnections || 0
      },
      
      agentWork: {
        agentCount: agentResults?.agentCount || 0,
        totalInsights: agentResults?.insights?.length || 0,
        totalFindings: agentResults?.findings?.length || 0,
        agentSummaries: Array.isArray(agentResults?.agentSummaries) ? agentResults.agentSummaries : [],
        // Store full insights and findings for reference
        insights: Array.isArray(agentResults?.insights) ? agentResults.insights : [],
        findings: Array.isArray(agentResults?.findings) ? agentResults.findings : []
      },
      
      deliverables: {
        totalFiles: deliverables?.totalFiles || 0,
        byAgentType: deliverables?.byAgentType || {},
        recentFiles: Array.isArray(deliverables?.recentFiles) ? deliverables.recentFiles : [],
        gaps: Array.isArray(deliverables?.gaps) ? deliverables.gaps : [],
        timestamp: deliverables?.timestamp || new Date().toISOString()
      },
      
      systemHealth,
      
      strategicDecisions: {
        content: decisions?.content || 'No decisions available',
        reasoning: decisions?.reasoning || null,
        prioritizedGoals: Array.isArray(decisions?.prioritizedGoals) ? decisions.prioritizedGoals : [],
        keyInsights: Array.isArray(decisions?.keyInsights) ? decisions.keyInsights : [],
        strategicDirectives: Array.isArray(decisions?.strategicDirectives) ? decisions.strategicDirectives : [],
        urgentGoals: Array.isArray(decisions?.urgentGoals) ? decisions.urgentGoals : []
      }
    };

    return report;
  }

  /**
   * Helper: Group thoughts by role
   */
  groupThoughtsByRole(journal) {
    const grouped = {};
    for (const entry of journal) {
      if (!grouped[entry.role]) {
        grouped[entry.role] = [];
      }
      grouped[entry.role].push(entry);
    }
    return grouped;
  }

  /**
   * Helper: Sample recent thoughts
   */
  sampleThoughts(journal, count) {
    return journal.slice(-count);
  }

  /**
   * Helper: Extract top goals from LLM response
   */
  extractTopGoals(content, allGoals) {
    const mentioned = [];
    
    // Match both "goal_164" and "Goal 164" patterns
    for (const goal of allGoals) {
      // Extract numeric ID from goal.id (e.g., "goal_164" -> 164)
      const numericId = goal.id.replace(/^goal_/, '');
      
      // Look for various mention patterns
      const patterns = [
        goal.id,                    // Exact: "goal_164"
        `Goal ${numericId}`,        // Natural: "Goal 164"
        `goal ${numericId}`,        // Lowercase: "goal 164"
        `#${numericId}`,            // Shorthand: "#164"
        `${goal.id}:`,              // With colon: "goal_164:"
        `${goal.id} —`,             // With em-dash: "goal_164 —"
        `Goal ${numericId} —`       // Natural with em-dash: "Goal 164 —"
      ];
      
      if (patterns.some(pattern => content.includes(pattern))) {
        mentioned.push(goal);
      }
    }
    
    return mentioned.slice(0, 5);
  }

  /**
   * Helper: Extract key insights
   */
  extractKeyInsights(content) {
    // Look for numbered or bulleted insights section
    const insights = [];
    const lines = content.split('\n');
    let inInsightsSection = false;
    
    for (const line of lines) {
      if (line.toLowerCase().includes('key insight')) {
        inInsightsSection = true;
        continue;
      }
      if (inInsightsSection && line.match(/^\d+\.|^-|^•/)) {
        insights.push(line.replace(/^\d+\.|^-|^•/, '').trim());
      }
      if (inInsightsSection && line.trim() === '') {
        if (insights.length > 0) break;
      }
    }
    
    return insights.slice(0, 5);
  }

  /**
   * Helper: Extract strategic directives
   */
  extractDirectives(content) {
    const directives = [];
    const lines = content.split('\n');
    let inDirectivesSection = false;
    
    for (const line of lines) {
      if (line.toLowerCase().includes('strategic directive') || line.toLowerCase().includes('next steps')) {
        inDirectivesSection = true;
        continue;
      }
      if (inDirectivesSection && line.match(/^\d+\.|^-|^•/)) {
        directives.push(line.replace(/^\d+\.|^-|^•/, '').trim());
      }
      if (inDirectivesSection && line.trim() === '' && directives.length > 2) {
        break;
      }
    }
    
    return directives.slice(0, 5);
  }

  /**
   * Helper: Extract goals to archive from strategic decisions
   * Parses the "Goals to Archive" section
   */
  extractGoalsToArchive(content) {
    try {
      // Look for "Goals to Archive" or "Goals to archive" section
      const archiveMatch = content.match(/Goals to [Aa]rchive[:\s]*([^\n]+(?:\n(?!##)[^\n]+)*)/);
      
      if (archiveMatch) {
        const archiveText = archiveMatch[1];
        // Extract goal IDs (goal_XXX format)
        const goalIds = archiveText.match(/goal_\d+/g) || [];
        
        if (goalIds.length > 0) {
          this.logger.debug('Extracted goals to archive from strategic decisions', {
            count: goalIds.length,
            sample: goalIds.slice(0, 5)
          });
          
          return [...new Set(goalIds)]; // Deduplicate
        }
      }
      
      return [];
    } catch (error) {
      this.logger.warn('Failed to extract goals to archive', { error: error.message });
      return [];
    }
  }
  
  /**
   * Helper: Extract urgent goals from strategic decisions
   * Parses JSON array of urgent goal specifications
   */
  /**
   * EXECUTIVE RING FIX: Extract urgent goals from strategic decisions content
   * Fixed to handle markdown code blocks (GPT-5 output format)
   * 
   * This was Ghost #2 - meta-coordinator generated goals but couldn't parse them
   * because GPT-5 wraps JSON in ```json code blocks
   */
  extractUrgentGoals(content) {
    // Helper to safely parse JSON with repair for local LLM quirks
    const safeParse = (jsonStr) => {
      try {
        return parseWithFallback(jsonStr);
      } catch (e) {
        return null;
      }
    };

    try {
      // Strategy 1: Markdown code block (most common in GPT-5 outputs)
      const markdownMatch = content.match(/URGENT goals to create.*?```json\s*([\s\S]*?)\s*```/i);
      if (markdownMatch) {
        const urgentGoals = safeParse(markdownMatch[1]);
        if (Array.isArray(urgentGoals) && urgentGoals.length > 0) {
          this.logger.info('✓ Extracted urgent goals from markdown block', {
            count: urgentGoals.length,
            types: urgentGoals.map(g => g.agentType)
          });
          return urgentGoals;
        }
      }

      // Strategy 2: Direct JSON array (backward compatibility)
      const directMatch = content.match(/URGENT GOALS TO CREATE[:\s]*(\[[\s\S]*?\])/i);
      if (directMatch) {
        const urgentGoals = safeParse(directMatch[1]);
        if (Array.isArray(urgentGoals) && urgentGoals.length > 0) {
          this.logger.info('✓ Extracted urgent goals from direct JSON', {
            count: urgentGoals.length
          });
          return urgentGoals;
        }
      }

      // Strategy 3: Scan for JSON array in section (handles extra whitespace)
      const sectionMatch = content.match(/## 4\) URGENT goals[\s\S]{0,200}(\[[\s\S]*?\])/i);
      if (sectionMatch) {
        const urgentGoals = safeParse(sectionMatch[1]);
        if (Array.isArray(urgentGoals) && urgentGoals.length > 0) {
          this.logger.info('✓ Extracted urgent goals from section scan', {
            count: urgentGoals.length
          });
          return urgentGoals;
        }
      }
      
      // Fallback: Look for individual urgent goal markers (legacy compatibility)
      const lines = content.split('\n');
      let inUrgentSection = false;
      let jsonBuffer = '';
      
      for (const line of lines) {
        if (line.toLowerCase().includes('urgent goal') && line.includes('{')) {
          inUrgentSection = true;
          jsonBuffer = line.substring(line.indexOf('{'));
          continue;
        }
        
        if (inUrgentSection) {
          jsonBuffer += '\n' + line;
          
          // Try to parse when we have a complete object
          if (line.includes('}')) {
            const goal = safeParse(jsonBuffer);
            if (goal && goal.description && goal.agentType) {
              this.logger.info('✓ Extracted urgent goal from legacy format', {
                type: goal.agentType
              });
              return [goal];
            }
            inUrgentSection = false;
            jsonBuffer = '';
          }
        }
      }
      
      this.logger.debug('No urgent goals found in content');
      return [];
      
    } catch (error) {
      this.logger.error('Failed to parse urgent goals', { 
        error: error.message,
        stack: error.stack.substring(0, 200)
      });
      return [];
    }
  }

  /**
   * Get recent context from previous reviews
   */
  getRecentContext() {
    return this.contextMemory.slice(-3);
  }

  /**
   * Save report to file
   */
  async saveReport(report, cycleCount) {
    const reportPath = path.join(this.coordinatorDir, `review_${cycleCount}.json`);
    const markdownPath = path.join(this.coordinatorDir, `review_${cycleCount}.md`);
    
    try {
      // CRITICAL: Test JSON serialization first
      let jsonString;
      try {
        jsonString = JSON.stringify(report, null, 2);
      } catch (jsonError) {
        this.logger.error('❌ Report has circular references or non-serializable data', {
          error: jsonError.message,
          reportKeys: Object.keys(report || {})
        });
        // Create safe minimal report
        jsonString = JSON.stringify({
          reviewId: report.reviewId,
          timestamp: report.timestamp instanceof Date ? report.timestamp.toISOString() : report.timestamp,
          cycleRange: report.cycleRange,
          summary: report.summary,
          error: 'Original report not serializable'
        }, null, 2);
      }
      
      // Save JSON via Capabilities
      if (this.capabilities) {
        await this.capabilities.writeFile(
          reportPath,
          jsonString,
          { agentId: 'meta-coordinator', agentType: 'meta-coordinator', missionGoal: 'coordination' }
        );
        this.logger.info('✅ Report JSON saved', { path: reportPath });
        
        // Save human-readable markdown
        const markdown = this.formatReportAsMarkdown(report);
        await this.capabilities.writeFile(
          markdownPath,
          markdown,
          { agentId: 'meta-coordinator', agentType: 'meta-coordinator', missionGoal: 'coordination' }
        );
        this.logger.info('✅ Report markdown saved', { path: markdownPath });
      } else {
        await fs.writeFile(reportPath, jsonString);
        this.logger.info('✅ Report JSON saved (fs)', { path: reportPath });
        const markdown = this.formatReportAsMarkdown(report);
        await fs.writeFile(markdownPath, markdown);
        this.logger.info('✅ Report markdown saved (fs)', { path: markdownPath });
      }
      
      this.logger.info('📝 Report saved successfully', { reportPath, markdownPath });
    } catch (error) {
      this.logger.error('❌ CRITICAL: saveReport failed', {
        error: error.message,
        stack: error.stack,
        reportPath,
        markdownPath
      });
      throw error; // Re-throw so caller knows it failed
    }
  }

  /**
   * Format report as markdown for readability
   */
  formatReportAsMarkdown(report) {
    // CRITICAL: Safe timestamp handling (could be Date object or string)
    const timestampStr = report.timestamp instanceof Date 
      ? report.timestamp.toISOString() 
      : (report.timestamp || new Date().toISOString());
    
    return `# Meta-Coordinator Review ${report.reviewId}

**Date:** ${timestampStr}
**Cycles Reviewed:** ${report.cycleRange[0]} to ${report.cycleRange[1]} (${report.summary.cyclesReviewed} cycles)
**Duration:** ${(report.reviewDuration / 1000).toFixed(1)}s

## Summary

- Thoughts Analyzed: ${report.summary.thoughtsAnalyzed}
- Goals Evaluated: ${report.summary.goalsEvaluated}
- Memory Nodes: ${report.summary.memoryNodes}
- Memory Edges: ${report.summary.memoryEdges}
- Agents Completed: ${report.summary.agentsCompleted}
- Deliverables Created: ${report.summary.deliverablesTotal}
- Deliverables Gaps: ${report.summary.deliverablesGaps}

---

## Cognitive Work Analysis

${report.cognitiveWork.analysis}

---

## Goal Portfolio Evaluation

${report.goalPortfolio.evaluation}

### Prioritized Goals

${Array.isArray(report.goalPortfolio.prioritizedGoals) && report.goalPortfolio.prioritizedGoals.length > 0 ? report.goalPortfolio.prioritizedGoals.map(g => 
  `- **${g?.id || 'unknown'}**: ${g?.description || 'No description'}`
).join('\n') : '_No prioritized goals identified_'}

---

## Memory Network Analysis

${report.memoryNetwork.analysis}

---

## Specialist Agent Work

**Agents Completed:** ${report.agentWork.agentCount}
**Total Insights:** ${report.agentWork.totalInsights}
**Total Findings:** ${report.agentWork.totalFindings}

${report.agentWork.agentCount > 0 && Array.isArray(report.agentWork.agentSummaries) && report.agentWork.agentSummaries.length > 0 ? `
### Agent Summaries

${report.agentWork.agentSummaries.map((agent, i) => `
#### Agent ${i + 1}: ${agent?.agentType || 'Unknown'}

- **Goal:** ${agent?.goal || 'No goal description'}
- **Status:** ${agent?.status || 'Unknown'}
- **Results:** ${agent?.insightsCount || 0} insights, ${agent?.findingsCount || 0} findings
- **Duration:** ${agent?.duration || 'Unknown'}

${Array.isArray(agent?.sampleInsights) && agent.sampleInsights.length > 0 ? `**Sample Insights:**
${agent.sampleInsights.map((ins, j) => `${j + 1}. ${(typeof ins === 'string' ? ins : ins?.content || JSON.stringify(ins)).substring(0, 300)}...`).join('\n')}
` : ''}
${Array.isArray(agent?.sampleFindings) && agent.sampleFindings.length > 0 ? `**Sample Findings:**
${agent.sampleFindings.slice(0, 2).map((f, j) => `${j + 1}. ${(typeof f === 'string' ? f : f?.content || JSON.stringify(f)).substring(0, 250)}...`).join('\n')}
` : ''}
`).join('\n---\n')}
` : '_No agents completed during this review period._'}

---

## Deliverables Audit

**Total Files Created:** ${report.deliverables.totalFiles}

### Files by Agent Type

- **Code Creation:** ${report.deliverables.byAgentType['code-creation'] || 0} files
- **Code Execution:** ${report.deliverables.byAgentType['code-execution'] || 0} files
- **Document Creation:** ${report.deliverables.byAgentType['document-creation'] || 0} files
- **Document Analysis:** ${report.deliverables.byAgentType['document-analysis'] || 0} files

${Array.isArray(report.deliverables.recentFiles) && report.deliverables.recentFiles.length > 0 ? `
### Recent Files

${report.deliverables.recentFiles.map(f => `- \`${f.path}\` (${f.agentType}, ${(f.size / 1024).toFixed(1)}KB, modified: ${f.modified})`).join('\n')}
` : ''}

${Array.isArray(report.deliverables.gaps) && report.deliverables.gaps.length > 0 ? `
### ⚠️ Gaps Detected

${report.deliverables.gaps.map(g => `
#### ${g.type} [${g.severity.toUpperCase()}]

${g.description}

**Recommendation:** ${g.recommendation}

${g.evidence ? `**Evidence:** ${JSON.stringify(g.evidence, null, 2)}` : ''}
`).join('\n')}
` : '✅ _No gaps detected - deliverables pipeline is healthy_'}

---

## System Health

- **Curiosity:** ${(report.systemHealth.cognitiveState.curiosity * 100).toFixed(0)}%
- **Mood:** ${(report.systemHealth.cognitiveState.mood * 100).toFixed(0)}%
- **Energy:** ${(report.systemHealth.cognitiveState.energy * 100).toFixed(0)}%

---

## Strategic Decisions

${report.strategicDecisions.content}

### Key Insights

${Array.isArray(report.strategicDecisions.keyInsights) && report.strategicDecisions.keyInsights.length > 0 ? report.strategicDecisions.keyInsights.map((insight, i) => 
  `${i + 1}. ${insight || 'No insight text'}`
).join('\n') : '_No key insights generated_'}

### Strategic Directives

${Array.isArray(report.strategicDecisions.strategicDirectives) && report.strategicDecisions.strategicDirectives.length > 0 ? report.strategicDecisions.strategicDirectives.map((dir, i) => 
  `${i + 1}. ${dir || 'No directive text'}`
).join('\n') : '_No strategic directives generated_'}

${Array.isArray(report.strategicDecisions.urgentGoals) && report.strategicDecisions.urgentGoals.length > 0 ? `
### ⚡ Urgent Goals Created

${report.strategicDecisions.urgentGoals.map((goal, i) => `
${i + 1}. **${goal.description}**
   - Agent Type: \`${goal.agentType}\`
   - Priority: ${goal.priority}
   - Urgency: ${goal.urgency || 'high'}
   - Rationale: ${goal.rationale || 'N/A'}
`).join('\n')}
` : ''}

---

## Extended Reasoning

${report.strategicDecisions.reasoning ? `\`\`\`\n${report.strategicDecisions.reasoning}\n\`\`\`` : 'N/A'}
`;
  }

  /**
   * Save context for next review
   */
  async saveContext() {
    const contextPath = path.join(this.coordinatorDir, 'context.json');
    
    try {
      const context = {
        lastReviewCycle: this.lastReviewCycle,
        reviewHistory: this.reviewHistory.map(r => ({
          cycle: r.cycle,
          // CRITICAL: Convert Date to string for JSON serialization
          timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
          prioritizedGoals: r.prioritizedGoals,
          directives: r.directives,
          // TEMPORAL: Save stateSnapshot for delta computation (only primitives)
          stateSnapshot: r.stateSnapshot || null
        })),
        contextMemory: this.contextMemory,
        strategicDirectives: this.strategicDirectives,
        prioritizedGoals: this.prioritizedGoals,
        lastSpecializationRouting: this.lastSpecializationRouting
      };
      
      // Test serialization first
      const jsonString = JSON.stringify(context, null, 2);
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          contextPath,
          jsonString,
          { agentId: 'meta-coordinator', agentType: 'meta-coordinator', missionGoal: 'coordination' }
        );
      } else {
        await fs.writeFile(contextPath, jsonString);
      }
      
      this.logger.debug('Context saved successfully', { path: contextPath });
    } catch (error) {
      this.logger.error('❌ Failed to save context', {
        error: error.message,
        stack: error.stack,
        contextPath
      });
      throw error;
    }
  }

  /**
   * Load context from previous run
   */
  async loadContext() {
    const contextPath = path.join(this.coordinatorDir, 'context.json');
    
    try {
      const data = await fs.readFile(contextPath, 'utf8');
      const context = JSON.parse(data);
      
      this.lastReviewCycle = context.lastReviewCycle || 0;
      
      // Ensure loaded values are arrays (robust state loading)
      this.reviewHistory = Array.isArray(context.reviewHistory) ? context.reviewHistory : [];
      this.contextMemory = Array.isArray(context.contextMemory) ? context.contextMemory : [];
      this.strategicDirectives = Array.isArray(context.strategicDirectives) ? context.strategicDirectives : [];
      this.prioritizedGoals = Array.isArray(context.prioritizedGoals) ? context.prioritizedGoals : [];
      this.lastSpecializationRouting = context.lastSpecializationRouting || null;
      
      this.logger.info('Meta-Coordinator context loaded', {
        lastReview: this.lastReviewCycle,
        historicalReviews: this.reviewHistory.length,
        directives: this.strategicDirectives.length,
        prioritizedGoals: this.prioritizedGoals.length
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.error('Failed to load coordinator context', { error: error.message });
      }
    }
  }

  /**
   * Export state for orchestrator saveState()
   */
  export() {
    return {
      enabled: this.enabled,
      lastReviewCycle: this.lastReviewCycle,
      // CRITICAL: Ensure timestamps are strings for serialization
      reviewHistory: this.reviewHistory.slice(-5).map(r => ({
        ...r,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp
      })),
      strategicDirectives: this.strategicDirectives,
      prioritizedGoals: this.prioritizedGoals,
      specialization: this.specializationProfile ? {
        instanceId: this.instanceId,
        profileName: this.specializationDisplayName || this.specializationProfile.displayName || this.specializationProfile.key,
        lastRouting: this.lastSpecializationRouting
      } : null
    };
  }

  /**
   * Get stats for dashboard
   */
  getStats() {
    // Safe array access for stats (handles state loading edge cases)
    const reviewHistory = Array.isArray(this.reviewHistory) ? this.reviewHistory : [];
    const prioritizedGoals = Array.isArray(this.prioritizedGoals) ? this.prioritizedGoals : [];
    const strategicDirectives = Array.isArray(this.strategicDirectives) ? this.strategicDirectives : [];
    const specialization = this.specializationProfile ? {
      instanceId: this.instanceId,
      profileName: this.specializationDisplayName || this.specializationProfile.displayName || this.specializationProfile.key,
      boostedGoals: this.lastSpecializationRouting?.boosted?.length || 0,
      penalizedGoals: this.lastSpecializationRouting?.penalized?.length || 0,
      lastRouting: this.lastSpecializationRouting || null
    } : null;
    
    return {
      enabled: this.enabled,
      lastReviewCycle: this.lastReviewCycle,
      totalReviews: reviewHistory.length,
      nextReview: this.lastReviewCycle + this.reviewInterval,
      activePriorities: prioritizedGoals.length,
      activeDirectives: strategicDirectives.length,
      specialization
    };
  }

  /**
   * Inject urgent goals based on deliverables gaps
   * Creates actual goals in the goal system (not just missions)
   * These goals persist and can be tracked through normal lifecycle
   * 
   * @param {Array} urgentGoalSpecs - Goal specifications from strategic decisions
   * @param {Object} goalsSystem - Reference to goals system for injection
   */
  async injectUrgentGoals(urgentGoalSpecs, goalsSystem) {
    const injectedGoals = [];
    
    for (const spec of urgentGoalSpecs) {
      try {
        // Format goal data to match what IntrinsicGoalSystem.addGoal() expects
        const goalData = {
          description: spec.description,
          reason: spec.rationale || 'Strategic goal from deliverables gap detection',
          uncertainty: spec.priority || 0.95,  // ← addGoal converts this to priority!
          source: 'meta_coordinator_strategic',
          metadata: {
            agentTypeHint: spec.agentType,
            agentType: spec.agentType,  // Also set without Hint for direct matching
            gapDriven: true,
            strategicPriority: true,
            urgency: spec.urgency || 'high',
            rationale: spec.rationale || 'Critical deliverables gap detected',
            createdFromGap: true,
            preferredInstance: null  // Allow any instance to claim
          }
        };
        
        // ADDITIVE: Parse contract-aware execution hints from description
        const executionHints = this.parseExecutionHintsWithContract(spec.description, spec.agentType);
        if (executionHints) {
          Object.assign(goalData.metadata, executionHints);
          this.logger.debug('Added execution hints to goal metadata', {
            hints: Object.keys(executionHints),
            contractId: executionHints.contractId
          });
        }

        // Enrich vague execution-agent descriptions with actionable context
        const executionTypes = ['dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
        if (executionTypes.includes(spec.agentType)) {
          const hasUrl = /https?:\/\//.test(spec.description);
          const hasPath = /@outputs\/|\/\w+\.\w+/.test(spec.description);
          const hasTool = /\b(curl|wget|sqlite3|playwright|python|jq|cheerio|scrapy|duckdb|docker)\b/i.test(spec.description);
          const hasFormat = /\b(JSON|CSV|SQLite|HTML|XML|SQL|database|db)\b/i.test(spec.description);

          if (!hasUrl && !hasPath && !hasTool && !hasFormat) {
            const enrichments = [];
            if (spec.sourceScope) enrichments.push(`Source: ${spec.sourceScope}`);
            if (spec.expectedOutput) enrichments.push(`Output: ${spec.expectedOutput}`);
            if (enrichments.length > 0) {
              goalData.description += `\n\nAction context: ${enrichments.join('. ')}`;
            }
            this.logger.info('Enriched vague execution goal description', {
              agentType: spec.agentType,
              enrichments: enrichments.length
            });
          }
        }

        // Add goal to goals system (returns the created goal)
        if (goalsSystem && typeof goalsSystem.addGoal === 'function') {
          const createdGoal = goalsSystem.addGoal(goalData);  // Not async!
          
          if (createdGoal) {
            injectedGoals.push(createdGoal);
            
            this.logger.info('📌 Strategic goal injected from gap detection', {
              goalId: createdGoal.id,
              description: createdGoal.description.substring(0, 100),
              agentTypeHint: spec.agentType,
              priority: createdGoal.priority.toFixed(3)
            });
          } else {
            this.logger.warn('Goal injection returned null (validation failed)', {
              description: spec.description.substring(0, 50)
            });
          }
        } else {
          this.logger.warn('Goals system not available for goal injection', {
            hasGoalsSystem: !!goalsSystem,
            hasAddGoal: goalsSystem ? typeof goalsSystem.addGoal : 'no goalsSystem'
          });
        }
      } catch (error) {
        this.logger.error('Failed to inject urgent goal', {
          spec: spec.description?.substring(0, 50),
          error: error.message,
          stack: error.stack
        });
      }
    }
    
    return injectedGoals;
  }
  
  /**
   * Process curated insights reports and convert high-priority next steps to goals
   * Reads previous review cycle's insights report and extracts actionable recommendations
   */
  async processInsightsIntoGoals(previousReviewCycle, goalsSystem, currentCycle, context = {}) {
    const { guidedMissionPlan = null, activeAgents = [] } = context;
    try {
      // Find the most recent insights report (may be from previous or earlier cycle)
      const insightsReports = await this.findInsightsReports();
      
      if (insightsReports.length === 0) {
        this.logger.debug('No curated insights reports found');
        return;
      }
      
      // Get the most recent report (may not be from exact previous review cycle)
      const latestReport = insightsReports[0];
      
      this.logger.info('💎 Processing curated insights for actionable next steps...', {
        reportFile: path.basename(latestReport),
        reportsAvailable: insightsReports.length
      });
      
      // Parse the report
      const parsed = await this.insightsParser.parseReport(latestReport);
      
      if (!parsed || !parsed.alignments || parsed.alignments.length === 0) {
        this.logger.debug('No alignments found in insights report');
        return;
      }
      
      // Filter to only high-priority alignments
      const highPriority = this.insightsParser.filterHighPriority(parsed.alignments);
      
      if (highPriority.length === 0) {
        this.logger.info('💎 Insights processed: no high-priority next steps requiring goals');
        return;
      }
      
      this.logger.info('💎 Found high-priority actionable insights', {
        total: parsed.alignments.length,
        highPriority: highPriority.length
      });
      
      // Convert to goal specs
      const goalSpecs = this.insightsParser.convertAlignmentsToGoalSpecs(
        highPriority,
        path.basename(latestReport)
      );
      
      // Check for duplicates with existing goals and recently created urgent goals
      const deduplicatedSpecs = this.deduplicateInsightGoals(goalSpecs, goalsSystem, {
        guidedMissionPlan,
        activeAgents
      });
      
      if (deduplicatedSpecs.length === 0) {
        this.logger.info('💎 All insight next steps already covered by existing goals');
        return;
      }
      
      this.logger.info('💎 Creating goals from insight next steps', {
        totalNextSteps: goalSpecs.length,
        afterDeduplication: deduplicatedSpecs.length
      });
      
      // Inject as goals (similar to urgent goals)
      const injectedGoals = await this.injectUrgentGoals(deduplicatedSpecs, goalsSystem);
      
      if (injectedGoals.length > 0) {
        this.logger.info('✅ Insights converted to tracked goals', {
          injectedCount: injectedGoals.length,
          goalIds: injectedGoals.map(g => g.id)
        });
        
        // Register with tracker (mark as from insights, not from urgent goals)
        this.strategicTracker.registerUrgentGoals(
          currentCycle,
          deduplicatedSpecs.map(spec => ({
            ...spec,
            source: 'curated_insights'
          })),
          injectedGoals
        );
      }
      
    } catch (error) {
      this.logger.error('Failed to process insights into goals', {
        error: error.message,
        stack: error.stack
      });
    }
  }
  
  /**
   * Find available insights reports
   */
  async findInsightsReports() {
    try {
      const files = await fs.readdir(this.coordinatorDir);
      const insightFiles = files
        .filter(f => f.startsWith('insights_curated_cycle_') && f.endsWith('.md'))
        .map(f => ({
          filename: f,
          path: path.join(this.coordinatorDir, f),
          cycle: this.extractCycleFromFilename(f)
        }))
        .filter(f => f.cycle !== null)
        .sort((a, b) => b.cycle - a.cycle); // Most recent first
      
      return insightFiles.map(f => f.path);
    } catch (error) {
      this.logger.warn('Failed to find insights reports', { error: error.message });
      return [];
    }
  }
  
  /**
   * Extract cycle number from filename
   */
  extractCycleFromFilename(filename) {
    const match = filename.match(/cycle[_\s]+(\d+)/i);
    return match ? parseInt(match[1]) : null;
  }
  
  /**
   * Deduplicate insight goals against existing goals
   * Prevents creating duplicate goals when insight next steps overlap with urgent goals
   */
  deduplicateInsightGoals(insightGoalSpecs, goalsSystem, context = {}) {
    const { guidedMissionPlan = null, activeAgents = [] } = context;
    const existingGoals = goalsSystem?.getGoals() || [];
    const deduplicated = [];
    
    for (const spec of insightGoalSpecs) {
      // Check if a similar goal already exists
      const isDuplicate = existingGoals.some(existingGoal => {
        // Simple similarity check: same keywords and length
        const specWords = this.extractKeywords(spec.description);
        const existingWords = this.extractKeywords(existingGoal.description);
        
        // Check overlap
        const overlap = specWords.filter(w => existingWords.includes(w));
        const similarity = overlap.length / Math.max(specWords.length, existingWords.length);
        
        return similarity > 0.6; // 60% keyword overlap = duplicate
      });
      
      if (isDuplicate) {
        this.logger.debug('Skipping duplicate insight goal (already in goal system)', {
          description: spec.description.substring(0, 60)
        });
        continue;
      }

      // SITUATIONAL AWARENESS: Check against Guided Plan
      const isPlanned = guidedMissionPlan?.taskPhases?.some(phase => {
        const specKeywords = this.extractKeywords(spec.description);
        const phaseKeywords = this.extractKeywords(phase.name + ' ' + (phase.description || ''));
        const overlap = specKeywords.filter(w => phaseKeywords.includes(w));
        const similarity = overlap.length / Math.max(specKeywords.length, phaseKeywords.length);
        return similarity > 0.6;
      });

      if (isPlanned) {
        this.logger.info('🚫 Deduplicated insight goal (already in Guided Plan)', {
          description: spec.description.substring(0, 60)
        });
        continue;
      }

      // SITUATIONAL AWARENESS: Check against active agents
      const isBeingWorkedOn = activeAgents?.some(agent => {
        const specKeywords = this.extractKeywords(spec.description);
        const agentKeywords = this.extractKeywords(agent.goal || '');
        const overlap = specKeywords.filter(w => agentKeywords.includes(w));
        const similarity = overlap.length / Math.max(specKeywords.length, agentKeywords.length);
        return similarity > 0.6;
      });

      if (isBeingWorkedOn) {
        this.logger.info('🚫 Deduplicated insight goal (already being worked on by agent)', {
          description: spec.description.substring(0, 60)
        });
        continue;
      }
      
      deduplicated.push(spec);
    }
    
    return deduplicated;
  }
  
  /**
   * Extract keywords from text for similarity checking
   */
  extractKeywords(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 4) // Only significant words
      .filter(word => !['should', 'would', 'could', 'might', 'about', 'these', 'those', 'where', 'which'].includes(word));
  }

  /**
   * ADDITIVE: Infer contract from goal description
   * Looks for contract IDs mentioned in description, or infers from keywords
   * @param {string} description - Goal description
   * @returns {string|null} Contract ID or null if not applicable
   */
  inferContractFromGoal(description) {
    const lowerDesc = description.toLowerCase();
    
    // Direct contract ID reference
    if (lowerDesc.includes('eval_outputs_v1')) return 'eval_outputs_v1';
    if (lowerDesc.includes('simple_baseline_v1')) return 'simple_baseline_v1';
    if (lowerDesc.includes('governance_assessment_v1')) return 'governance_assessment_v1';
    
    // Infer from keywords
    if (lowerDesc.includes('baseline') && lowerDesc.includes('evaluation')) {
      return 'simple_baseline_v1';
    }
    if (lowerDesc.includes('governance') || lowerDesc.includes('compliance')) {
      return 'governance_assessment_v1';
    }
    if (lowerDesc.includes('predictions') && lowerDesc.includes('metrics')) {
      return 'eval_outputs_v1';
    }
    
    return null;
  }

  /**
   * ADDITIVE: Parse execution hints using contract
   * Extracts target code paths, canonical locations, and contract info from goal description
   * @param {string} description - Goal description
   * @param {string} agentType - Agent type that will handle this goal
   * @returns {Object|null} Execution hints or null
   */
  parseExecutionHintsWithContract(description, agentType) {
    const hints = {};
    
    // Infer contract
    const contractId = this.inferContractFromGoal(description);
    if (contractId) {
      try {
        const { getContract } = require('../schemas/output-contracts');
        const contract = getContract(contractId);
        
        hints.contractId = contractId;
        hints.expectedArtifacts = contract.artifacts
          .filter(a => a.required)
          .map(a => a.filename);
        
        this.logger.debug('Inferred contract from goal', {
          contractId,
          expectedArtifacts: hints.expectedArtifacts
        });
      } catch (error) {
        this.logger.warn('Failed to load contract', {
          contractId,
          error: error.message
        });
      }
    }
    
    // Extract target code path
    const codePathMatch = description.match(/code-creation\/agent_[\w]+\/([\w./-]+)/);
    if (codePathMatch) {
      hints.targetCodePath = `runtime/outputs/${codePathMatch[0]}`;
    }
    
    // Extract or infer canonical location
    const canonicalMatch = description.match(/outputs\/([\w_-]+)\/?/);
    if (canonicalMatch) {
      hints.canonicalOutputLocation = `outputs/${canonicalMatch[1]}`;
    } else if (contractId) {
      // Generate standard location: outputs/runs/{run_id}/
      hints.canonicalOutputLocation = `outputs/runs/run_${Date.now()}`;
    }
    
    // Set priority hint for code_execution agents
    if (agentType === 'code_execution' && hints.contractId) {
      hints.executionPriority = 'fulfill_contract';
    }
    
    return Object.keys(hints).length > 0 ? hints : null;
  }

  /**
   * Create mission specifications for spawning agents
   * Called by orchestrator after review with prioritized goals
   */
  async createMissionSpecs(prioritizedGoals, reviewCycle, maxAgents = 2) {
    if (!prioritizedGoals || prioritizedGoals.length === 0) {
      this.logger.info('No prioritized goals for agent spawning');
      return [];
    }

    // NEW: Check for pending agent tiers from guided mode FIRST
    // This takes precedence over autonomous goal spawning
    const tierSpawned = await this.spawnPendingTierIfReady();
    if (tierSpawned) {
      this.logger.info('✅ Spawned next agent tier - skipping autonomous spawning this cycle');
      return [];
    }

    if (this.fullConfig?.architecture?.roleSystem?.explorationMode === 'guided') {
      this.logger.info('📌 Guided-exclusive mode active - meta-coordinator autonomous spawning suppressed');
      return [];
    }

    const missionSpecs = [];
    
    // CRITICAL: Check for IN_PROGRESS tasks needing agents FIRST
    // Tasks from plan:main have higher priority than self-discovered goals
    const stateStore = this.phase2bSubsystems?.clusterStateStore;
    if (stateStore) {
      const activePlan = await stateStore.getPlan('plan:main');
      if (activePlan && activePlan.status === 'ACTIVE') {
        const allTasks = await stateStore.listTasks(activePlan.id);
        const tasksNeedingAgents = allTasks.filter(t => 
          (t.state === 'IN_PROGRESS' || t.state === 'CLAIMED') && 
          !t.assignedAgentId &&
          !t.metadata?.agentSpawned
        );
        
        if (tasksNeedingAgents.length > 0) {
          this.logger.info('🎯 Found tasks needing agent assignment', {
            count: tasksNeedingAgents.length,
            taskIds: tasksNeedingAgents.map(t => t.id)
          });
          // Note: Tasks are handled by orchestrator's task execution logic
          // Coordinator should be aware but not duplicate agent spawning
        }
      }
    }

    // NEW: Check if we should trigger a synthesis agent
    const needsSynthesis = this.shouldTriggerSynthesis(reviewCycle);
    if (needsSynthesis && maxAgents > 0) {
      this.logger.info('🔄 Triggering synthesis agent for knowledge consolidation');
      const synthesisSpec = await this.createSynthesisMission(reviewCycle);
      if (synthesisSpec) {
        missionSpecs.push(synthesisSpec);
        this.lastSynthesisReview = reviewCycle;
        // Reduce maxAgents by 1 since we used a slot for synthesis
        maxAgents = Math.max(1, maxAgents - 1);
      }
    }

    // Dynamic document_creation trigger - spawn when research is ready
    const needsDocCreation = this.shouldTriggerDocumentCreation(reviewCycle);
    if (needsDocCreation && maxAgents > 0) {
      this.logger.info('📄 Triggering document_creation agent for deliverable production');
      const docSpec = await this.createDocumentCreationMission(reviewCycle);
      if (docSpec) {
        missionSpecs.push(docSpec);
        this.lastDocumentCreationReview = reviewCycle;
        maxAgents = Math.max(0, maxAgents - 1);
      }
    }

    // Dynamic code_creation trigger - spawn when goals mention code
    const needsCodeCreation = this.shouldTriggerCodeCreation(reviewCycle, prioritizedGoals);
    if (needsCodeCreation && maxAgents > 0) {
      this.logger.info('💻 Triggering code_creation agent for code production');
      // Find the code-related goal if one exists
      const codeKeywords = ['code', 'script', 'program', 'automate', 'tool', 'implement', 'build', 'develop'];
      const codeGoal = prioritizedGoals.find(goal => {
        const desc = (goal.description || '').toLowerCase();
        return codeKeywords.some(kw => desc.includes(kw));
      });
      const codeSpec = await this.createCodeCreationMission(reviewCycle, codeGoal);
      if (codeSpec) {
        missionSpecs.push(codeSpec);
        this.lastCodeCreationReview = reviewCycle;
        maxAgents = Math.max(0, maxAgents - 1);
      }
    }

    // Check for experimental goals FIRST (before regular spawning)
    const experimentalGoals = prioritizedGoals.filter(g => 
      g.metadata?.experimental === true
    );
    
    if (experimentalGoals.length > 0) {
      if (!this.fullConfig.experimental?.enabled) {
        for (const goal of experimentalGoals) {
          this.logger.warn('⚠️  Experimental goal blocked', {
            goalId: goal.id,
            description: goal.description?.substring(0, 100),
            reason: 'experimental.enabled is false'
          });
        }
      } else {
        // Check system load - experimental is expensive
        const activeCount = this.agentExecutor?.registry?.getActiveCount() || 0;
        const HIGH_LOAD_THRESHOLD = 3;
        
        if (activeCount >= HIGH_LOAD_THRESHOLD) {
          this.logger.warn('⚠️  Experimental spawn blocked due to system load', {
            activeAgents: activeCount,
            threshold: HIGH_LOAD_THRESHOLD
          });
        } else {
          // Spawn ONE experimental agent
          const goal = experimentalGoals[0];
          missionSpecs.push({
            missionId: `mission_exp_${Date.now()}`,
            agentType: 'experimental',
            goalId: goal.id,
            description: goal.description,
            successCriteria: [
              'Execute in real environment',
              'Capture verifiable evidence',
              'Document execution provenance'
            ],
            maxDuration: Math.min(
              (this.fullConfig.experimental?.limits?.time_sec || 600) * 1000,
              900000  // 15 min hard ceiling
            ),
            priority: goal.priority,
            metadata: {
              experimental: true
            }
          });
          
          this.logger.info('🧪 Spawning experimental agent', {
            goalId: goal.id,
            description: goal.description?.substring(0, 80)
          });
          
          // Reduce maxAgents since we used a slot
          maxAgents = Math.max(0, maxAgents - 1);
        }
      }
    }

    // Only create missions for top N goals to avoid overwhelming the system
    const goalsToSpawn = prioritizedGoals.slice(0, maxAgents);

    for (const goal of goalsToSpawn) {
      try {
        const missionSpec = await this.createMissionSpec(goal, reviewCycle);
        if (missionSpec) {
          missionSpecs.push(missionSpec);
        }
      } catch (error) {
        this.logger.error('Failed to create mission spec', {
          goalId: goal.id,
          error: error.message
        });
      }
    }

    return missionSpecs;
  }

  /**
   * Check for and spawn pending agent tiers from guided mode
   * 
   * Returns true if a tier was spawned (coordinator should skip autonomous spawning)
   * Returns false if no tiers pending or not ready to spawn yet
   */
  async spawnPendingTierIfReady() {
    const stateStore = this.phase2bSubsystems?.clusterStateStore;
    if (!stateStore) return false;
    
    const pending = await stateStore.get('pending_agent_tiers');
    if (!pending || !pending.tiers || pending.tiers.length === 0) {
      return false;
    }
    
    const executor = this.phase2bSubsystems?.agentExecutor;
    if (!executor) return false;
    
    // Check if previous tier agents have completed
    const activeCount = executor.registry.getActiveCount();
    if (activeCount > 0) {
      this.logger.debug(`Waiting for ${activeCount} agent(s) to complete before spawning next tier`);
      return false;
    }
    
    // Check if memory has data (for tiers 1+)
    const currentTier = pending.currentTierToSpawn;
    if (currentTier > 0) {
      const memorySize = this.phase2bSubsystems?.memory?.nodes?.size || 0;
      if (memorySize === 0) {
        this.logger.warn('Memory still empty - Tier 0 may not have completed successfully');
      }
    }
    
    // Get next tier to spawn
    const nextTier = pending.tiers.find(t => t.tier === currentTier);
    if (!nextTier) {
      // No more tiers to spawn
      await stateStore.delete('pending_agent_tiers');
      this.logger.info('✅ All guided mode agent tiers have been spawned');
      return false;
    }
    
    this.logger.info('');
    this.logger.info('╔═══════════════════════════════════════════════╗');
    this.logger.info(`║   SPAWNING TIER ${currentTier} AGENTS${' '.repeat(27)}║`);
    this.logger.info('╚═══════════════════════════════════════════════╝');
    this.logger.info(`   ${nextTier.missions.length} agent(s): ${nextTier.missions.map(m => m.type).join(', ')}`);
    this.logger.info('');

    const maxConcurrent = executor.maxConcurrent || 1;
    const availableSlots = Math.max(0, maxConcurrent - activeCount);
    if (availableSlots === 0) {
      this.logger.debug('Guided tier ready but no executor slots available', {
        currentTier,
        maxConcurrent,
        activeCount
      });
      return false;
    }

    const missionsToSpawn = nextTier.missions.slice(0, availableSlots);
    const deferredMissions = nextTier.missions.slice(availableSlots);
    
    // Spawn each mission in this tier
    let spawned = 0;
    for (const mission of missionsToSpawn) {
      const goalMapping = pending.missionGoalIds.find(m => m.missionIdx === mission.originalIndex);
      const goalId = goalMapping?.goalId || `goal_tier${currentTier}_${mission.type}_${Date.now()}`;
      
      const spec = {
        missionId: `mission_tier${currentTier}_${mission.type}_${Date.now()}`,
        agentType: mission.type,
        goalId: goalId,
        description: mission.mission,
        successCriteria: mission.successCriteria || [mission.expectedOutput],
        deliverable: pending.deliverableSpec,
        tools: mission.tools || [],
        maxDuration: this.getAgentTimeout(mission.type),
        createdBy: 'meta_coordinator',
        spawnCycle: 0,
        triggerSource: 'tier_progression',
        spawningReason: `tier_${currentTier}_sequential`,
        priority: mission.priority === 'high' ? 1.0 : 0.6,
        tier: currentTier,
        metadata: {
          ...(mission.metadata || {}),
          guidedMission: true,
          sourceScope: mission.sourceScope || mission.metadata?.sourceScope || `${mission.type} tier ${currentTier}`,
          artifactInputs: Array.isArray(mission.artifactInputs)
            ? mission.artifactInputs
            : Array.isArray(mission.metadata?.artifactInputs)
              ? mission.metadata.artifactInputs
              : [],
          expectedOutput: mission.expectedOutput || mission.metadata?.expectedOutput || null,
          researchDigest: pending.researchDigest || mission.metadata?.researchDigest || null
        }
      };
      
      try {
        const agentId = await executor.spawnAgent(spec);
        if (agentId) {
          spawned++;
          this.logger.info(`   ✓ Spawned ${mission.type}: ${agentId}`);
        }
      } catch (error) {
        this.logger.error(`   ✗ Failed to spawn ${mission.type}: ${error.message}`);
      }
    }
    
    this.logger.info(`   ✅ Spawned ${spawned}/${nextTier.missions.length} agent(s) from Tier ${currentTier}`);
    
    // Update pending tiers
    const remainingTiers = pending.tiers.filter(t => t.tier > currentTier);
    if (deferredMissions.length > 0) {
      pending.tiers = [
        {
          ...nextTier,
          missions: deferredMissions
        },
        ...remainingTiers
      ];
      pending.currentTierToSpawn = currentTier;
      await stateStore.set('pending_agent_tiers', pending);
      this.logger.info(`   ⏳ Tier ${currentTier} partially spawned; ${deferredMissions.length} mission(s) waiting for capacity`);
    } else if (remainingTiers.length > 0) {
      pending.tiers = remainingTiers;
      pending.currentTierToSpawn = currentTier + 1;
      await stateStore.set('pending_agent_tiers', pending);
      this.logger.info(`   📦 ${remainingTiers.length} tier(s) remaining`);
    } else {
      await stateStore.delete('pending_agent_tiers');
      this.logger.info('   ✅ All guided mode tiers spawned');
    }
    
    return true;
  }

  /**
   * Create a single mission specification for a goal
   */
  async createMissionSpec(goal, reviewCycle) {
    // CRITICAL: Direct agent type matching for explicit goals
    // If goal explicitly mentions an agent type, use it directly (don't ask GPT)
    const goalText = goal.description.toLowerCase();
    let directAgentType = null;
    
    if (goalText.includes('codecreationagent') || goalText.includes('code creation agent')) {
      directAgentType = 'code_creation';
    } else if (goalText.includes('codeexecutionagent') || goalText.includes('code execution agent')) {
      directAgentType = 'code_execution';
    } else if (goalText.includes('using code_creation') || (goalText.includes('create') && goalText.includes('python files'))) {
      directAgentType = 'code_creation';
    } else if (goalText.includes('using code_execution') || (goalText.includes('test') && goalText.includes('solver'))) {
      directAgentType = 'code_execution';
    } else if (this.shouldSpawnIDEAgent(goalText)) {
      directAgentType = 'ide';
    }
    
    if (
      directAgentType &&
      !this.codingAgentsEnabled &&
      (directAgentType === 'code_creation' || directAgentType === 'code_execution')
    ) {
      this.logger.info('✋ Coding agents disabled by configuration. Ignoring direct code agent request.', {
        goalId: goal.id,
        requestedType: directAgentType
      });
      directAgentType = null;
    }
    
    if (directAgentType) {
      this.logger.info('🎯 Direct agent type match from goal', {
        goalId: goal.id,
        agentType: directAgentType,
        reason: 'Explicit agent mention in goal description'
      });

      // CRITICAL: Validate prerequisites for code_execution agents
      if (directAgentType === 'code_execution') {
        const hasCodeArtifacts = await this.checkForCodeArtifacts();
        if (!hasCodeArtifacts) {
          this.logger.warn('⛔ Blocking code_execution agent spawn - no code artifacts available', {
            goalId: goal.id,
            reason: 'CodeExecutionAgent requires existing code files from CodeCreationAgent',
            action: 'Deferring goal until code artifacts are created'
          });
          return null;
        }
        this.logger.info('✅ Code artifacts verified - proceeding with code_execution spawn', {
          goalId: goal.id
        });
      }
      
      // Create simple mission spec without asking GPT
      return {
        goalId: goal.id,
        agentType: directAgentType,
        description: goal.description,
        successCriteria: [
          'Complete the objective specified in goal',
          'Produce tangible outputs (files, analysis, or results)',
          'Store outputs in appropriate location (@outputs/)'
        ],
        maxDuration: this.getAgentTimeout(directAgentType),
        tools: directAgentType === 'code_execution' || directAgentType === 'code_creation' 
          ? ['python_runtime'] 
          : [],
        priority: goal.priority || 0.5,
        createdBy: 'meta_coordinator',
        spawnCycle: reviewCycle,
        triggerSource: 'coordinator_review',
        spawningReason: 'direct_agent_match',
        provenanceChain: []
      };
    }
    
    // NEW: Get agent type distribution for diversity guidance
    const distribution = this.getAgentTypeDistribution();
    const diversityGuidance = this.generateDiversityGuidance(distribution);

    // Check if we're in guided mode and add domain context
    const isGuided = this.fullConfig?.architecture?.roleSystem?.explorationMode === 'guided';
    const guidedDomain = this.fullConfig?.architecture?.roleSystem?.guidedFocus?.domain || '';
    const guidedContext = this.fullConfig?.architecture?.roleSystem?.guidedFocus?.context || '';
    
    const metadata = goal.metadata || {};
    const preferredAgentType = (metadata.agentTypeHint || metadata.agentType || '').toString().toLowerCase();
    const preferredInstance = metadata.preferredInstance || null;
    const specializationHints = Array.isArray(metadata.specializationHints)
      ? metadata.specializationHints.map(String)
      : [];
    const specializationTags = Array.isArray(metadata.specializationTags)
      ? metadata.specializationTags.map(String)
      : [];

    const domainGuidance = isGuided 
      ? `\n\nDOMAIN FOCUS: This system is focused on "${guidedDomain}". ${guidedContext ? guidedContext + ' ' : ''}The mission description and success criteria should align with this domain focus while supporting the goal's specific objective.`
      : '';

    const specializationGuidance = [];
    if (preferredAgentType) {
      specializationGuidance.push(`RECOMMENDED AGENT TYPE: ${preferredAgentType}. Align the mission with this specialization unless clearly inappropriate.`);
    }
    if (preferredInstance) {
      specializationGuidance.push(`PREFERRED CLUSTER INSTANCE: ${preferredInstance}. Structure the mission so this instance can execute it effectively.`);
    }
    if (specializationHints.length > 0) {
      specializationGuidance.push(`SPECIALIZATION HINTS: ${specializationHints.join(', ')}`);
    }
    if (specializationTags.length > 0) {
      specializationGuidance.push(`SPECIALIZATION TAGS: ${specializationTags.join(', ')}`);
    }

    const specializationGuidanceBlock = specializationGuidance.length > 0
      ? `\n\nSPECIALIZATION CONTEXT:\n${specializationGuidance.join('\n')}`
      : '';

    // DOMAIN ANCHOR: Ensure mission spec stays domain-focused
    const domainAnchorBlock = getDomainAnchor(this.fullConfig);
    
    // IDE-FIRST: Check if IDE-First mode is enabled and build appropriate agent type list
    const ideFirstEnabled = this.fullConfig?.ideFirst?.enabled === true;
    
    const agentTypesBlock = ideFirstEnabled 
      ? `AVAILABLE AGENT TYPES (IDE-First Mode):
- **ide**: The primary agent for ALL tasks - code creation, document writing, analysis, synthesis, execution, validation. Uses MCP tools and terminal for direct file/code operations.
- **research**: Web search and information gathering (use ONLY for tasks that need internet search to find external sources, current events, data gathering)`
      : `AVAILABLE AGENT TYPES:
- **research**: Web search and information gathering (use for factual questions, current events, data gathering)
- **analysis**: Deep analysis and novel idea exploration (use for understanding, implications, systematic thinking)
- **synthesis**: Report writing and knowledge consolidation (use for summarizing, creating comprehensive overviews)
- **exploration**: Creative/speculative exploration (use for lateral thinking, "what if" scenarios, novel connections)
- **codebase_exploration**: READ-ONLY codebase understanding and auditing
- **code_execution**: Computational experiments and validation
- **quality_assurance**: Validation and fact-checking
- **document_creation**: Generate documents, reports, and documentation
- **code_creation**: Generate actual code files and applications
- **completion**: Monitor and validate system operations
- **document_analysis**: Analyze document collections and versions`;

    const agentTypeEnum = ideFirstEnabled
      ? '"ide|research"'
      : '"research|analysis|synthesis|exploration|codebase_exploration|code_execution|quality_assurance|document_creation|code_creation|completion|document_analysis"';

    const prompt = `You are the Meta-Coordinator determining how to pursue a goal through a specialist agent.

${domainAnchorBlock}

GOAL: ${goal.description}

⚠️ DOMAIN CHECK: If this goal is NOT related to the research domain above (e.g., it's about QA gates, probes, CLI tools, COSMO infrastructure), respond with: {"skip": true, "reason": "Goal is meta-pollution, not domain research"}

CURRENT PROGRESS: ${(goal.progress * 100).toFixed(0)}%
CURRENT PRIORITY: ${(goal.priority * 100).toFixed(0)}%${domainGuidance}${specializationGuidanceBlock}

${agentTypesBlock}
${ideFirstEnabled ? '\n⚠️ IDE-FIRST MODE: Use "ide" for most tasks. Only use "research" when you need to search the web for external information.' : ''}

${diversityGuidance}

Your task:
1. Select the MOST APPROPRIATE agent type for this goal
2. Write a clear, specific mission description (2-3 sentences)
3. Define 3-4 concrete success criteria
4. Estimate how long this should take (in minutes, 5-30)

Respond in JSON format:
{
  "agentType": ${agentTypeEnum},
  "description": "Specific mission description...",
  "successCriteria": [
    "Criterion 1: Measurable outcome...",
    "Criterion 2: Another outcome...",
    "Criterion 3: Third outcome..."
  ],
  "maxDurationMinutes": 15,
  "rationale": "Why this agent type and approach..."
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.model || this.config.models?.coordinatorStandard || this.config.models?.fast, // Use fast model for faster mission spec generation
        instructions: prompt,
        messages: [{ role: 'user', content: 'Create mission specification.' }],
        maxTokens: 6000, // Increased from 1500 - status updates need comprehensive output
        reasoningEffort: 'low'
      }, 3); // Retry up to 3 times on connection errors

      // Check if response has content
      if (!response || !response.content || response.content.trim() === '') {
        this.logger.warn('Empty response from GPT-5-mini for mission spec', {
          goalId: goal.id,
          hasResponse: Boolean(response),
          hasContent: Boolean(response?.content)
        });
        return null;
      }

      // Extract JSON from response
      const match = response.content.match(/\{[\s\S]*\}/);
      if (!match) {
        this.logger.warn('Failed to extract mission spec JSON', {
          goalId: goal.id,
          responsePreview: response.content.substring(0, 200)
        });
        return null;
      }

      const spec = JSON.parse(match[0]);

      // Validate agent type
      let validAgentTypes = [
        'research', 'analysis', 'synthesis', 'exploration', 'code_execution',
        'quality_assurance', 'document_creation', 'code_creation', 'completion',
        'document_analysis', 'specialized_binary', 'ide', 'planning', 'integration',
        'codebase_exploration', 'document_compiler', 'disconfirmation', 'consistency',
        'dataacquisition', 'datapipeline', 'infrastructure', 'automation'
      ];
      if (!this.codingAgentsEnabled) {
        validAgentTypes = validAgentTypes.filter(type => type !== 'code_execution' && type !== 'code_creation');
      }
      if (!validAgentTypes.includes(spec.agentType)) {
        // IDE-FIRST: Default to 'ide' when enabled, otherwise use diversity selection
        const ideFirstEnabled = this.fullConfig?.ideFirst?.enabled === true;
        if (ideFirstEnabled) {
          this.logger.info('🖥️ IDE-FIRST: Defaulting to IDE agent for autonomous goal', {
            goalId: goal.id,
            invalidType: spec.agentType
          });
          spec.agentType = 'ide';
        } else {
          this.logger.warn('Invalid agent type, using diversity-based selection', {
            goalId: goal.id,
            invalidType: spec.agentType
          });
          spec.agentType = this.selectDiverseAgentType();
        }
      }

      // IDE-FIRST MODE: Smarter routing for hybrid research→IDE workflow
      // Research-type goals → research agent (gather info, web search)
      // Synthesis/artifact goals → IDE agent (create reports, analysis, code)
      const ideFirstEnabled = this.fullConfig?.ideFirst?.enabled === true;

      if (ideFirstEnabled) {
        // Execution agents have specialized CLI-first capabilities — never remap to IDE
        const EXECUTION_AGENT_TYPES = ['dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
        if (EXECUTION_AGENT_TYPES.includes(spec.agentType)) {
          this.logger.debug('⚙️ Preserving execution agent type in IDE-First mode', {
            agentType: spec.agentType,
            goalId: goal.id
          });
        } else {
        // Detect research-type goals that need web search or external information gathering
        const goalText = goal.description.toLowerCase();
        const isResearchGoal = spec.agentType === 'research' ||
                               goalText.includes('research') ||
                               goalText.includes('find papers') ||
                               goalText.includes('literature') ||
                               goalText.includes('web search') ||
                               goalText.includes('gather information') ||
                               goalText.includes('survey') ||
                               (goalText.includes('what') && goalText.includes('known')) ||
                               (goalText.includes('which') && goalText.includes('methods'));

        if (isResearchGoal) {
          spec.agentType = 'research';
          this.logger.debug('🔬 Research agent for information gathering', {
            goalId: goal.id,
            goalSnippet: goal.description?.substring(0, 60)
          });
        } else {
          // All artifact creation, synthesis, analysis → IDE agent
          spec.agentType = 'ide';
          this.logger.debug('🖥️ IDE agent for artifact creation/synthesis', {
            goalId: goal.id,
            goalSnippet: goal.description?.substring(0, 60)
          });
        }
        }
      } else {
        // Non-IDE-first mode: Apply keyword triggers and diversity overrides

        if (preferredAgentType && validAgentTypes.includes(preferredAgentType)) {
          spec.agentType = preferredAgentType;
        }

        // Check for specific triggers for agent types
        if (!spec.agentType || spec.agentType === 'analysis') {
          const goalText = goal.description.toLowerCase();

          // Codebase exploration triggers (READ-ONLY)
          if (goalText.includes('explore') && (goalText.includes('code') || goalText.includes('codebase') || goalText.includes('repository')) ||
              goalText.includes('understand codebase') || goalText.includes('audit code') ||
              goalText.includes('map') && (goalText.includes('code') || goalText.includes('dependencies') || goalText.includes('architecture')) ||
              goalText.includes('analyze architecture') || goalText.includes('code structure') ||
              goalText.includes('review code') || goalText.includes('scan code') ||
              goalText.includes('technical debt') || goalText.includes('code quality')) {
            spec.agentType = 'codebase_exploration';
          }
          // Document creation triggers
          else if (goalText.includes('document') || goalText.includes('report') ||
              goalText.includes('manual') || goalText.includes('guide') ||
              goalText.includes('documentation') || goalText.includes('write') ||
              goalText.includes('create document') || goalText.includes('generate report')) {
            spec.agentType = 'document_creation';
          }
          // Code creation triggers
          else if (
                   this.codingAgentsEnabled &&
                   (goalText.includes('code') || goalText.includes('script') ||
                   goalText.includes('application') || goalText.includes('tool') ||
                   goalText.includes('create code') || goalText.includes('build') ||
                   goalText.includes('develop') || goalText.includes('implement'))
          ) {
            spec.agentType = 'code_creation';
          }
          // Document analysis triggers
          else if (goalText.includes('analyze') && (goalText.includes('document') || goalText.includes('folder') || goalText.includes('file')) ||
                   goalText.includes('compare') || goalText.includes('version') || goalText.includes('evolution') ||
                   goalText.includes('metadata') || goalText.includes('story') || goalText.includes('history')) {
            spec.agentType = 'document_analysis';
          }
        }

        // Apply diversity override if needed (non-IDE-first only)
        const overrideType = this.applyDiversityOverride(spec.agentType, goal);
        if (overrideType !== spec.agentType) {
          this.logger.info('🎨 Diversity override applied', {
            original: spec.agentType,
            override: overrideType,
            reason: 'Balancing agent type distribution'
          });
          spec.agentType = overrideType;
        }
      }

      if (!this.codingAgentsEnabled && (spec.agentType === 'code_creation' || spec.agentType === 'code_execution')) {
        this.logger.info('✋ Skipping mission spec that requires coding agents (disabled in config)', {
          goalId: goal.id,
          selectedType: spec.agentType
        });
        return null;
      }

      // CRITICAL: Validate prerequisites for code_execution agents
      if (spec.agentType === 'code_execution') {
        const hasCodeArtifacts = await this.checkForCodeArtifacts();
        if (!hasCodeArtifacts) {
          this.logger.warn('⛔ Blocking code_execution agent spawn - no code artifacts available', {
            goalId: goal.id,
            selectedType: spec.agentType,
            reason: 'CodeExecutionAgent requires existing code files from CodeCreationAgent',
            action: 'Returning null to skip this mission spec'
          });
          return null;
        }
        this.logger.info('✅ Code artifacts verified for GPT-selected code_execution mission', {
          goalId: goal.id
        });
      }

      // Enhanced mission spec with complete provenance tracking
      const missionSpec = {
        // Core mission data
        goalId: goal.id,
        agentType: spec.agentType,
        description: spec.description,
        successCriteria: spec.successCriteria || [],
        maxDuration: spec.maxDurationMinutes 
          ? spec.maxDurationMinutes * 60 * 1000 
          : this.getAgentTimeout(spec.agentType),
        rationale: spec.rationale || '',

        // Provenance tracking
        missionId: `mission_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        createdBy: 'meta_coordinator',
        spawnCycle: reviewCycle,
        createdAt: new Date().toISOString(),

        // Provenance chain - track how this mission was spawned
        provenanceChain: [], // Will be populated by spawning context
        parentAgentId: null, // If spawned by an agent (not orchestrator)
        parentMissionId: null, // If spawned as follow-up to another mission
        spawningReason: 'goal_execution', // Why this mission was created
        triggerSource: 'orchestrator', // What triggered the spawn

        // Spawning context
        spawningContext: {
          goalPriority: goal.priority,
          goalAge: this.calculateGoalAge(goal),
          systemState: this.getSystemStateSnapshot(),
          agentTypeDistribution: this.getAgentTypeDistribution(),
          diversityGuidance: diversityGuidance,
          reviewCycle: reviewCycle
        },

        // CRITICAL: Pass through goal metadata (includes codeCreationAgentId for linked execution)
        metadata: goal.metadata || {},

        // Mission metadata for tracking
        expectedOutcomes: spec.expectedOutcomes || [],
        dependencies: spec.dependencies || [],
        followUpTriggers: spec.followUpTriggers || []
      };

      // NEW: Track agent type for diversity monitoring
      this.recordAgentType(spec.agentType);

      if (preferredInstance) {
        missionSpec.preferredInstance = preferredInstance;
      }

      if (preferredAgentType) {
        missionSpec.requestedAgentType = preferredAgentType;
      }

      if (specializationHints.length > 0) {
        missionSpec.specializationHints = specializationHints;
      }

      if (specializationTags.length > 0) {
        missionSpec.specializationTags = specializationTags;
      }

      const routing = this.computeSpecializationRouting(goal);
      if (routing) {
        missionSpec.specializationRouting = {
          instanceId: this.instanceId,
          profile: this.specializationDisplayName || this.specializationProfile?.displayName || this.specializationProfile?.key || null,
          weight: routing.weight,
          preferredMatched: routing.preferredMatched,
          reasons: routing.reasons.slice(0, 5)
        };
      }

      this.logger.info('Mission spec created', {
        goalId: goal.id,
        agentType: missionSpec.agentType,
        description: missionSpec.description.substring(0, 100),
        distribution: this.getAgentTypeDistribution()
      });

      return missionSpec;

    } catch (error) {
      this.logger.error('Mission spec creation failed', {
        goalId: goal.id,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Record that agents were spawned for a review
   * Called by orchestrator after spawning
   */
  recordAgentsSpawned(reviewCycle, agentIds) {
    const review = this.reviewHistory.find(r => r.cycle === reviewCycle);
    if (review) {
      review.agentsSpawned = agentIds;
      this.logger.info('Recorded agent spawning', {
        reviewCycle,
        agentsSpawned: agentIds.length
      });
    }
  }

  /**
   * Detect theme frequency for diversity monitoring
   */
  detectThemeFrequency(text) {
    const themes = {
      'network effect': 0,
      'feedback loop': 0,
      'echo chamber': 0,
      'confirmation bias': 0,
      'algorithmic': 0,
      'recommendation': 0,
      'platform': 0,
      'data quality': 0,
      'more data': 0,
      'emergent': 0,
      'complex system': 0,
      'polarization': 0,
      'attention': 0
    };
    
    const lowerText = text.toLowerCase();
    
    for (const theme of Object.keys(themes)) {
      const regex = new RegExp(theme, 'gi');
      const matches = lowerText.match(regex);
      themes[theme] = matches ? matches.length : 0;
    }
    
    return themes;
  }

  /**
   * Identify goal health issues for coordinator
   */
  identifyGoalHealthIssues(activeGoals, journal) {
    const issues = [];
    const now = Date.now();
    
    // Safe access - ensure we have arrays
    const safeGoals = Array.isArray(activeGoals) ? activeGoals : [];
    const safeJournal = Array.isArray(journal) ? journal : [];
    
    if (safeGoals.length === 0) {
      return 'No goals to assess.';
    }
    
    // Overly pursued without progress
    const overPursued = safeGoals.filter(g => 
      g && (g.pursuitCount || 0) > 10 && (g.progress || 0) < 0.3
    );
    if (overPursued.length > 0) {
      issues.push(`- ${overPursued.length} goals pursued >10x with <30% progress: ${overPursued.map(g => g?.id || 'unknown').join(', ')}`);
    }
    
    // Stale (pursued before but not recently)
    const stale = safeGoals.filter(g => {
      if (!g || !g.lastPursued || (g.pursuitCount || 0) === 0) return false;
      const lastPursuedTime = g.lastPursued instanceof Date ? g.lastPursued.getTime() : g.lastPursued;
      const daysSince = (now - lastPursuedTime) / (1000 * 60 * 60 * 24);
      return daysSince > 7;
    });
    if (stale.length > 0) {
      issues.push(`- ${stale.length} stale goals (>7 days inactive): ${stale.slice(0, 5).map(g => g?.id || 'unknown').join(', ')}${stale.length > 5 ? '...' : ''}`);
    }
    
    // Never pursued (but old enough)
    const ageDays = (goal) => {
      if (!goal || !goal.created) return 0;
      const createdTime = goal.created instanceof Date ? goal.created.getTime() : goal.created;
      return (now - createdTime) / (1000 * 60 * 60 * 24);
    };
    const ignored = safeGoals.filter(g => 
      g && (g.pursuitCount || 0) === 0 && ageDays(g) > 3 && ageDays(g) < 14
    );
    if (ignored.length > 0) {
      issues.push(`- ${ignored.length} goals never pursued (3-14 days old)`);
    }
    
    // Dominant goal check
    const recentPursuits = safeJournal.slice(-30).filter(e => e && e.goal).map(e => e.goal);
    if (recentPursuits.length > 0) {
      const pursuitCounts = {};
      for (const goalId of recentPursuits) {
        pursuitCounts[goalId] = (pursuitCounts[goalId] || 0) + 1;
      }
      
      for (const [goalId, count] of Object.entries(pursuitCounts)) {
        const dominance = count / recentPursuits.length;
        if (dominance > 0.20) {
          const goal = safeGoals.find(g => g && g.id === goalId);
          if (goal && goal.description) {
            issues.push(`- ${goalId} MONOPOLIZING (${(dominance * 100).toFixed(0)}% of recent pursuits): "${goal.description.substring(0, 50)}"`);
          }
        }
      }
    }
    
    return issues.length > 0 ? issues.join('\n') : 'No major health issues detected.';
  }

  /**
   * NEW: Check if we should trigger a synthesis agent
   * Trigger synthesis every 3-4 reviews or when there are many findings
   */
  shouldTriggerSynthesis(reviewCycle) {
    const reviewsSinceSynthesis = reviewCycle - this.lastSynthesisReview;
    
    // Trigger every 3-4 reviews (with some randomness)
    if (reviewsSinceSynthesis >= 3) {
      // 60% chance if >= 3 reviews, 90% if >= 4 reviews
      const probability = reviewsSinceSynthesis >= 4 ? 0.9 : 0.6;
      return Math.random() < probability;
    }
    
    return false;
  }

  /**
   * NEW: Create a synthesis mission (not tied to a specific goal)
   */
  async createSynthesisMission(reviewCycle) {
    const missionSpec = {
      // Core mission data
      goalId: `synthesis_${reviewCycle}`, // Virtual goal for synthesis
      agentType: 'synthesis',
      description: 'Consolidate and synthesize recent cognitive work, research findings, and insights into a comprehensive knowledge report. Review accumulated thoughts, agent findings, and memory patterns to identify key themes, connections, and knowledge gaps.',
      successCriteria: [
        'Produce a multi-section synthesis report covering major themes from recent work',
        'Identify cross-cutting insights and connections between different areas of investigation',
        'Document knowledge gaps and suggest promising directions for future exploration',
        'Create executive summary suitable for high-level understanding of progress'
      ],
      maxDuration: 15 * 60 * 1000, // 15 minutes (aligned with guided mode)
      rationale: 'Periodic synthesis helps consolidate knowledge, identify patterns, and maintain coherent understanding of accumulated work',

      // Enhanced provenance tracking for synthesis missions
      missionId: `mission_synthesis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdBy: 'meta_coordinator',
      spawnCycle: reviewCycle,
      createdAt: new Date().toISOString(),

      // Provenance chain - synthesis is triggered by system state
      provenanceChain: [`synthesis_trigger_${reviewCycle}`],
      parentAgentId: null,
      parentMissionId: null,
      spawningReason: 'knowledge_consolidation',
      triggerSource: 'system_scheduler',

      // Spawning context for synthesis
      spawningContext: {
        reviewsSinceLastSynthesis: reviewCycle - this.lastSynthesisReview,
        systemState: this.getSystemStateSnapshot(),
        synthesisTrigger: 'periodic_review',
        reviewCycle: reviewCycle
      },

      // Synthesis-specific metadata
      expectedOutcomes: ['consolidated_knowledge', 'identified_patterns', 'knowledge_gaps'],
      dependencies: [], // Synthesis depends on recent work being available
      followUpTriggers: ['new_goals_from_synthesis', 'research_directions']
    };

    this.recordAgentType('synthesis');

    // Record agent type for tracking
    if (missionSpec.agentType) {
      this.recordAgentType(missionSpec.agentType);
    }
    
    this.logger.info('✨ Synthesis mission created', {
      reviewCycle,
      reviewsSinceLast: reviewCycle - this.lastSynthesisReview
    });

    return missionSpec;
  }

  /**
   * Check if we should trigger a document_creation agent
   * Triggered after sufficient research/synthesis work accumulates
   */
  shouldTriggerDocumentCreation(reviewCycle) {
    const reviewsSinceDocCreation = reviewCycle - this.lastDocumentCreationReview;

    // CRITICAL: Check memory has enough content (document creation needs 3+ nodes)
    const memorySize = this.memory?.nodes?.size || 0;
    if (memorySize < 3) {
      return false; // Not enough content in memory yet
    }

    // Only trigger if we've had some synthesis work first
    const hadRecentSynthesis = (reviewCycle - this.lastSynthesisReview) <= 3;

    // Trigger every 5-6 reviews after synthesis
    if (reviewsSinceDocCreation >= 5 && hadRecentSynthesis) {
      const probability = reviewsSinceDocCreation >= 6 ? 0.85 : 0.5;
      return Math.random() < probability;
    }

    // Also check agent history - if we have research and synthesis but no doc creation
    const recentTypes = this.agentTypeHistory.slice(-10);
    const hasResearch = recentTypes.includes('research');
    const hasSynthesis = recentTypes.includes('synthesis');
    const hasDocCreation = recentTypes.includes('document_creation');

    if (hasResearch && hasSynthesis && !hasDocCreation && reviewsSinceDocCreation >= 3) {
      return true;
    }

    return false;
  }

  /**
   * Create a document_creation mission for producing deliverables
   */
  async createDocumentCreationMission(reviewCycle) {
    // Get guided focus if available for context
    const guidedFocus = this.fullConfig?.architecture?.roleSystem?.guidedFocus;
    const domain = guidedFocus?.domain || 'current research';
    const outputFilename = guidedFocus?.deliverable?.filename || `report_cycle_${reviewCycle}.md`;

    const missionSpec = {
      goalId: `document_creation_${reviewCycle}`,
      agentType: 'document_creation',
      description: `Create a comprehensive report document on ${domain}. Synthesize all research findings, analysis results, and insights into a well-structured markdown document. Include executive summary, key findings, detailed analysis, and recommendations. Save as ${outputFilename} in the outputs directory.`,
      successCriteria: [
        'Produce a complete markdown document covering all research topics',
        'Include executive summary with key takeaways',
        'Structure content with clear sections and headings',
        'Save document to @outputs/ directory'
      ],
      maxDuration: 10 * 60 * 1000, // 10 minutes
      rationale: 'Convert accumulated research and synthesis into a deliverable document',

      missionId: `mission_doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdBy: 'meta_coordinator',
      spawnCycle: reviewCycle,
      createdAt: new Date().toISOString(),

      provenanceChain: [`document_trigger_${reviewCycle}`],
      parentAgentId: null,
      parentMissionId: null,
      spawningReason: 'deliverable_production',
      triggerSource: 'dynamic_trigger',

      spawningContext: {
        reviewsSinceLastDocCreation: reviewCycle - this.lastDocumentCreationReview,
        domain: domain,
        outputFilename: outputFilename,
        reviewCycle: reviewCycle
      },

      expectedOutcomes: ['markdown_document', 'saved_deliverable'],
      dependencies: [],
      followUpTriggers: ['quality_review']
    };

    this.recordAgentType('document_creation');

    this.logger.info('📄 Document creation mission created', {
      reviewCycle,
      domain,
      outputFilename
    });

    return missionSpec;
  }

  /**
   * Check if we should trigger a code_creation agent
   * Triggered when goals mention code/scripts/tools/automation
   */
  shouldTriggerCodeCreation(reviewCycle, prioritizedGoals = []) {
    const reviewsSinceCodeCreation = reviewCycle - this.lastCodeCreationReview;

    // Check if any goals mention code-related work
    const codeKeywords = ['code', 'script', 'program', 'automate', 'tool', 'implement', 'build', 'develop', 'function', 'class'];
    const hasCodeGoal = prioritizedGoals.some(goal => {
      const desc = (goal.description || '').toLowerCase();
      return codeKeywords.some(kw => desc.includes(kw));
    });

    // Only trigger if coding is enabled and we haven't recently created code
    if (!this.codingAgentsEnabled) return false;
    if (reviewsSinceCodeCreation < 3) return false;

    // Higher probability if we have explicit code goals
    if (hasCodeGoal) {
      return Math.random() < 0.8;
    }

    return false;
  }

  /**
   * Create a code_creation mission for building tools/scripts
   */
  async createCodeCreationMission(reviewCycle, codeGoal = null) {
    const guidedFocus = this.fullConfig?.architecture?.roleSystem?.guidedFocus;
    const domain = guidedFocus?.domain || 'current research';

    const description = codeGoal?.description ||
      `Create useful code artifacts based on ${domain} research. Build scripts, tools, or utilities that help analyze, process, or work with the domain. Focus on practical, working code.`;

    const missionSpec = {
      goalId: codeGoal?.id || `code_creation_${reviewCycle}`,
      agentType: 'code_creation',
      description: description,
      successCriteria: [
        'Produce working, executable code',
        'Include appropriate documentation/comments',
        'Test that code runs without errors',
        'Save code to appropriate location'
      ],
      maxDuration: 15 * 60 * 1000, // 15 minutes
      rationale: 'Create code artifacts to support research or automation',

      missionId: `mission_code_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdBy: 'meta_coordinator',
      spawnCycle: reviewCycle,
      createdAt: new Date().toISOString(),

      provenanceChain: [`code_trigger_${reviewCycle}`],
      parentAgentId: null,
      parentMissionId: null,
      spawningReason: 'code_production',
      triggerSource: 'dynamic_trigger',

      spawningContext: {
        reviewsSinceLastCodeCreation: reviewCycle - this.lastCodeCreationReview,
        domain: domain,
        hasExplicitGoal: !!codeGoal,
        reviewCycle: reviewCycle
      },

      expectedOutcomes: ['working_code', 'documented_artifact'],
      dependencies: [],
      followUpTriggers: ['code_execution', 'quality_review']
    };

    this.recordAgentType('code_creation');

    this.logger.info('💻 Code creation mission created', {
      reviewCycle,
      hasExplicitGoal: !!codeGoal
    });

    return missionSpec;
  }

  /**
   * NEW: Get current agent type distribution
   */
  getAgentTypeDistribution() {
    if (this.agentTypeHistory.length === 0) {
      return { research: 0, analysis: 0, synthesis: 0, exploration: 0, code_execution: 0, document_creation: 0, code_creation: 0, codebase_exploration: 0, completion: 0, document_analysis: 0, dataacquisition: 0, datapipeline: 0, infrastructure: 0, automation: 0, total: 0 };
    }

    const counts = {
      research: 0,
      analysis: 0,
      synthesis: 0,
      exploration: 0,
      codebase_exploration: 0,
      code_execution: 0,
      document_creation: 0,
      code_creation: 0,
      completion: 0,
      document_analysis: 0,
      dataacquisition: 0,
      datapipeline: 0,
      infrastructure: 0,
      automation: 0
    };

    for (const type of this.agentTypeHistory) {
      if (counts.hasOwnProperty(type)) {
        counts[type]++;
      }
    }

    // Convert to percentages
    const total = this.agentTypeHistory.length;
    const dist = { total };
    for (const [type, count] of Object.entries(counts)) {
      dist[type] = Math.round((count / total) * 100);
    }
    return dist;
  }

  /**
   * NEW: Generate diversity guidance for the prompt
   */
  generateDiversityGuidance(distribution) {
    if (distribution.total === 0) {
      return 'NOTE: This is an early agent. Consider all agent types equally.';
    }

    const parts = [];
    
    // Identify overused types
    if (distribution.analysis > 50) {
      parts.push(`⚠️ IMPORTANT: Analysis agents are overused (${distribution.analysis}%). Strongly prefer research, exploration, or synthesis unless this goal specifically requires deep analysis.`);
    } else if (distribution.analysis > 40) {
      parts.push(`NOTE: Analysis agents are common (${distribution.analysis}%). Consider if research, exploration, or synthesis might be more appropriate.`);
    }

    // Encourage underused types
    const underused = [];
    if (distribution.research < 25) underused.push('research');
    if (distribution.exploration < 15) underused.push('exploration');
    if (distribution.synthesis < 10) underused.push('synthesis');

    if (underused.length > 0) {
      parts.push(`💡 Consider using: ${underused.join(', ')} (currently underutilized)`);
    }

    if (!this.codingAgentsEnabled) {
      parts.push('ℹ️ Coding agents are disabled for this run.');
    }

    // Show current distribution
    parts.push(`Current distribution (last ${distribution.total} agents): Research ${distribution.research}%, Analysis ${distribution.analysis}%, Exploration ${distribution.exploration}%, Synthesis ${distribution.synthesis}%, Code Execution ${distribution.code_execution}%, Document Creation ${distribution.document_creation}%, Code Creation ${distribution.code_creation}%, Completion ${distribution.completion}%, Document Analysis ${distribution.document_analysis}%`);

    return parts.join('\n');
  }

  /**
   * NEW: Select a diverse agent type when GPT doesn't provide one
   */
  selectDiverseAgentType() {
    const distribution = this.getAgentTypeDistribution();
    
    // Weight inversely to current usage
    const weights = {
      research: 100 - (distribution.research || 0),
      analysis: 100 - (distribution.analysis || 0),
      exploration: 100 - (distribution.exploration || 0),
      synthesis: 100 - (distribution.synthesis || 0),
      code_execution: 100 - (distribution.code_execution || 0),
      quality_assurance: 100 - (distribution.quality_assurance || 0),
      document_creation: 100 - (distribution.document_creation || 0),
      code_creation: 100 - (distribution.code_creation || 0),
      completion: 100 - (distribution.completion || 0),
      document_analysis: 100 - (distribution.document_analysis || 0),
      specialized_binary: Math.min(100 - (distribution.specialized_binary || 0), 30),
      dataacquisition: 100 - (distribution.dataacquisition || 0),
      datapipeline: 100 - (distribution.datapipeline || 0),
      infrastructure: 100 - (distribution.infrastructure || 0),
      automation: 100 - (distribution.automation || 0)
    };

    if (!this.codingAgentsEnabled) {
      weights.code_execution = 0;
      weights.code_creation = 0;
    }

    // Never let analysis get too much weight
    if (distribution.analysis > 40) {
      weights.analysis = Math.max(10, weights.analysis / 2);
    }

    // Boost synthesis if it's very low
    if (distribution.synthesis < 5) {
      weights.synthesis *= 2;
    }

    // Boost code_execution if it's very low
    if (this.codingAgentsEnabled && distribution.code_execution < 5) {
      weights.code_execution *= 2;
    }

    // Quality assurance should be rare (only for validation)
    weights.quality_assurance = Math.min(weights.quality_assurance, 30);

    // Weighted random selection
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    for (const [type, weight] of Object.entries(weights)) {
      random -= weight;
      if (random <= 0) {
        this.logger.debug('Selected diverse agent type', {
          type,
          distribution,
          weights
        });
        return type;
      }
    }

    return 'exploration'; // Fallback to least common
  }

  /**
   * NEW: Apply diversity override if distribution is too skewed
   */
  applyDiversityOverride(suggestedType, goal) {
    const distribution = this.getAgentTypeDistribution();
    
    // If we have enough data to make decisions
    if (distribution.total < 5) {
      return suggestedType; // Don't override early on
    }

    // Strong override: If analysis is > 60%, force something else
    if (suggestedType === 'analysis' && distribution.analysis > 60) {
      // Randomly pick from underused types
      const alternatives = [];
      if (distribution.research < 30) alternatives.push('research');
      if (distribution.exploration < 20) alternatives.push('exploration');
      if (distribution.synthesis < 10) alternatives.push('synthesis');
      
      if (alternatives.length > 0) {
        return alternatives[Math.floor(Math.random() * alternatives.length)];
      }
    }

    // Moderate override: Occasionally force exploration/synthesis
    if (suggestedType === 'analysis') {
      // 20% chance to switch to exploration if it's underused
      if (distribution.exploration < 15 && Math.random() < 0.2) {
        return 'exploration';
      }
      // 15% chance to switch to research if analysis is > 45%
      if (distribution.analysis > 45 && distribution.research < 25 && Math.random() < 0.15) {
        return 'research';
      }
    }

    return suggestedType; // No override needed
  }

  /**
   * NEW: Record agent type in history for diversity tracking
   */
  recordAgentType(agentType) {
    this.agentTypeHistory.push(agentType);
    
    // Keep only last N agents
    if (this.agentTypeHistory.length > this.agentTypeHistoryLimit) {
      this.agentTypeHistory.shift();
    }
  }

  /**
   * Calculate how long a goal has been active (in days)
   */
  calculateGoalAge(goal) {
    if (!goal.created) return 0;
    const createdTime = goal.created instanceof Date ? goal.created.getTime() : goal.created;
    const now = Date.now();
    return (now - createdTime) / (1000 * 60 * 60 * 24);
  }

  /**
   * Get a snapshot of current system state for provenance
   */
  getSystemStateSnapshot() {
    return {
      activeGoals: this.goals ? this.goals.getGoals().length : 0,
      memoryNodes: this.memory ? this.memory.nodes.length : 0,
      reviewCycle: this.reviewCycle,
      agentTypes: this.getAgentTypeDistribution(),
      lastSynthesis: this.lastSynthesisReview,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Normalize values to lowercase array
   */
  normalizeToLowerArray(values) {
    if (!values) {
      return [];
    }

    const list = Array.isArray(values) ? values : [values];
    return list
      .map(value => (typeof value === 'string' ? value.trim().toLowerCase() : null))
      .filter(Boolean);
  }

  /**
   * Extract specialization profile for this instance
   */
  initializeSpecialization(clusterConfig, instanceIdLower) {
    if (!clusterConfig || clusterConfig.enabled === false) {
      return null;
    }

    const specialization = clusterConfig.specialization;
    if (!specialization || specialization.enabled === false) {
      return null;
    }

    const defaults = {
      baseline: specialization.defaults?.baseline || 1,
      boost: specialization.defaults?.boost || 1.5,
      penalty: specialization.defaults?.penalty || 0.6,
      unmatchedPenalty: specialization.defaults?.unmatchedPenalty || 1,
      minMultiplier: specialization.defaults?.minMultiplier || 0.3,
      maxMultiplier: specialization.defaults?.maxMultiplier || 3,
      nonPreferredPenalty: specialization.defaults?.nonPreferredPenalty || 0.1
    };

    const profileConfig = specialization.profiles?.[instanceIdLower] || specialization.profiles?.default;
    if (!profileConfig) {
      return { defaults, profile: null, displayName: null };
    }

    const normalize = (values) => this.normalizeToLowerArray(values);

    const profile = {
      key: instanceIdLower,
      displayName: profileConfig.name || instanceIdLower,
      baseline: profileConfig.baseline || defaults.baseline,
      boost: profileConfig.boost || defaults.boost,
      penalty: profileConfig.penalty || defaults.penalty,
      unmatchedPenalty: profileConfig.unmatchedPenalty ?? defaults.unmatchedPenalty,
      minMultiplier: profileConfig.minMultiplier || defaults.minMultiplier,
      maxMultiplier: profileConfig.maxMultiplier || defaults.maxMultiplier,
      nonPreferredPenalty: profileConfig.nonPreferredPenalty || defaults.nonPreferredPenalty,
      agentTypes: new Set(normalize(profileConfig.agentTypes)),
      avoidAgentTypes: new Set(normalize(profileConfig.avoidAgentTypes)),
      domains: new Set(normalize(profileConfig.domains)),
      avoidDomains: new Set(normalize(profileConfig.avoidDomains)),
      tags: new Set(normalize(profileConfig.tags)),
      avoidTags: new Set(normalize(profileConfig.avoidTags)),
      keywords: normalize(profileConfig.keywords || []),
      avoidKeywords: normalize(profileConfig.avoidKeywords || [])
    };

    return {
      defaults,
      profile,
      displayName: profile.displayName
    };
  }

  /**
   * Gather tags from metadata and goal definition
   */
  collectTagsFromMetadata(metadata = {}, goal = null) {
    const tags = new Set();

    const addAll = (values) => {
      if (!Array.isArray(values)) return;
      values.forEach(value => {
        if (typeof value === 'string' && value.trim()) {
          tags.add(value.trim().toLowerCase());
        }
      });
    };

    addAll(metadata.specializationTags);
    addAll(metadata.tags);
    if (Array.isArray(goal?.tags)) {
      addAll(goal.tags);
    }

    return Array.from(tags);
  }

  /**
   * Compute specialization routing weight for a goal
   */
  computeSpecializationRouting(goal) {
    if (!goal || !this.specializationProfile) {
      return { weight: 1, reasons: [], preferredMatched: false, preferredList: [] };
    }

    const profile = this.specializationProfile;
    const defaults = this.specializationDefaults || {};
    const metadata = goal.metadata || {};

    const preferredInstancesRaw = metadata.preferredInstance || metadata.preferredInstances;
    const preferredInstances = this.normalizeToLowerArray(preferredInstancesRaw);
    const excludedInstances = this.normalizeToLowerArray(metadata.restrictedInstances || metadata.excludedInstances);

    let weight = profile.baseline ?? defaults.baseline ?? 1;
    const reasons = [];
    const preferredMatched = preferredInstances.includes(profile.key);

    if (preferredInstances.length > 0) {
      if (preferredMatched) {
        weight *= profile.boost ?? defaults.boost ?? 1.5;
        reasons.push('preferred-instance');
      } else {
        weight *= profile.nonPreferredPenalty ?? defaults.nonPreferredPenalty ?? 0.1;
        reasons.push('non-preferred-instance');
      }
    }

    if (excludedInstances.includes(profile.key)) {
      weight *= profile.nonPreferredPenalty ?? defaults.nonPreferredPenalty ?? 0.1;
      reasons.push('excluded-instance');
    }

    const agentHint = (metadata.agentTypeHint || metadata.agentType || '').toString().toLowerCase();
    if (agentHint) {
      if (profile.agentTypes.has(agentHint)) {
        weight *= profile.boost ?? defaults.boost ?? 1.5;
        reasons.push(`agent:${agentHint}`);
      } else if (profile.avoidAgentTypes.has(agentHint)) {
        weight *= profile.penalty ?? defaults.penalty ?? 0.6;
        reasons.push(`avoid-agent:${agentHint}`);
      }
    }

    const guidedDomain = (metadata.guidedDomain || metadata.domain || '').toString().toLowerCase();
    if (guidedDomain) {
      if (profile.domains.has(guidedDomain)) {
        weight *= profile.boost ?? defaults.boost ?? 1.5;
        reasons.push(`domain:${guidedDomain}`);
      } else if (profile.avoidDomains.has(guidedDomain)) {
        weight *= profile.penalty ?? defaults.penalty ?? 0.6;
        reasons.push(`avoid-domain:${guidedDomain}`);
      }
    }

    const tags = this.collectTagsFromMetadata(metadata, goal);
    if (tags.length > 0) {
      const tagMatches = tags.filter(tag => profile.tags.has(tag));
      if (tagMatches.length > 0) {
        const tagBoost = 1 + Math.min(0.5, tagMatches.length * 0.15);
        weight *= tagBoost;
        reasons.push(`tags:${tagMatches.slice(0, 3).join(',')}`);
      }
      if (tags.some(tag => profile.avoidTags.has(tag))) {
        weight *= profile.penalty ?? defaults.penalty ?? 0.6;
        reasons.push('avoid-tags');
      }
    }

    const description = (goal.description || '').toLowerCase();
    if (profile.keywords.length > 0) {
      const keywordMatches = profile.keywords.filter(keyword => description.includes(keyword));
      if (keywordMatches.length > 0) {
        const keywordBoost = 1 + Math.min(0.4, keywordMatches.length * 0.1);
        weight *= keywordBoost;
        reasons.push(`keywords:${keywordMatches.slice(0, 3).join(',')}`);
      }
    }

    if (profile.avoidKeywords.length > 0) {
      if (profile.avoidKeywords.some(keyword => description.includes(keyword))) {
        weight *= profile.penalty ?? defaults.penalty ?? 0.6;
        reasons.push('avoid-keyword');
      }
    }

    if (Number.isFinite(metadata.specializationScore) && metadata.specializationScore > 0) {
      const scoreBoost = 1 + Math.min(0.5, metadata.specializationScore / 5);
      weight *= scoreBoost;
      reasons.push(`metadata-score:${metadata.specializationScore.toFixed(2)}`);
    }

    const minMultiplier = profile.minMultiplier ?? defaults.minMultiplier ?? 0.3;
    const maxMultiplier = profile.maxMultiplier ?? defaults.maxMultiplier ?? 3;
    weight = Math.max(minMultiplier, Math.min(maxMultiplier, weight));

    return {
      weight: Number(weight.toFixed(4)),
      reasons,
      preferredMatched,
      preferredList: preferredInstances
    };
  }

  /**
   * Attach coordinator routing metadata to goal
   */
  attachCoordinatorRoutingMetadata(goal, routing) {
    if (!goal) return;

    const metadata = goal.metadata && typeof goal.metadata === 'object'
      ? { ...goal.metadata }
      : {};

    metadata.lastCoordinatorRouting = {
      instanceId: this.instanceId,
      profile: this.specializationDisplayName || this.specializationProfile?.displayName || this.specializationProfile?.key || null,
      weight: routing.weight,
      reasons: routing.reasons.slice(0, 5),
      timestamp: new Date().toISOString()
    };

    goal.metadata = metadata;
  }

  /**
   * Reorder prioritized goals using specialization routing weights
   */
  applySpecializationRouting(prioritizedGoals = []) {
    if (!Array.isArray(prioritizedGoals) || prioritizedGoals.length === 0) {
      this.lastSpecializationRouting = null;
      return prioritizedGoals;
    }

    if (!this.specializationProfile) {
      this.lastSpecializationRouting = null;
      return prioritizedGoals;
    }

    const scored = prioritizedGoals.map((goal, index) => {
      const routing = this.computeSpecializationRouting(goal);
      const basePriority = Number.isFinite(goal.priority) ? goal.priority : 1;
      const recencyBias = (prioritizedGoals.length - index) * 0.01;
      const effectiveScore = basePriority * routing.weight + recencyBias;
      return { goal, routing, effectiveScore, index };
    });

    scored.sort((a, b) => {
      if (b.effectiveScore === a.effectiveScore) {
        return a.index - b.index; // Preserve original order for ties
      }
      return b.effectiveScore - a.effectiveScore;
    });

    const boosted = [];
    const penalized = [];

    scored.forEach(entry => {
      if (entry.routing.preferredMatched) {
        boosted.push(entry.goal.id);
      } else if (entry.routing.weight < 1) {
        penalized.push(entry.goal.id);
      }
      this.attachCoordinatorRoutingMetadata(entry.goal, entry.routing);
    });

    this.lastSpecializationRouting = {
      instanceId: this.instanceId,
      profile: this.specializationDisplayName || this.specializationProfile.displayName || this.specializationProfile.key,
      boosted,
      penalized,
      weights: scored.map(entry => ({
        goalId: entry.goal.id,
        weight: entry.routing.weight
      }))
    };

    if (scored.some(entry => entry.routing.weight !== 1)) {
      this.logger.info('🎯 Specialization routing applied', {
        instanceId: this.instanceId,
        boosted,
        penalized
      });
    }

    return scored.map(entry => entry.goal);
  }

  /**
   * Curate insights for stakeholder reporting (ASYNC - non-blocking)
   * Runs independently after coordinator review completes
   * Takes 5-7 minutes but doesn't block main loop
   */
  async curateInsightsAsync(cycleCount, agentResults) {
    const startTime = Date.now();
    
    try {
      const { InsightCurator } = require('../curation/insight-curator');
      
      const curator = new InsightCurator(
        this.fullConfig,
        this.logger,
        // PRODUCTION: Use pathResolver for user-specific runtime path
        // CRITICAL: Fallback chain - pathResolver > config.logsDir > __dirname
        this.pathResolver
          ? this.pathResolver.getRuntimeRoot()
          : (this.config?.logsDir || path.join(__dirname, '..', '..', 'runtime'))
      );
      
      // Generate timestamped report path
      const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const reportPath = path.join(
        this.coordinatorDir,
        `insights_curated_cycle_${cycleCount}_${timestamp}.md`
      );
      
      // Maintain "LATEST" symlink for easy dashboard access
      const latestPath = path.join(
        this.coordinatorDir,
        'insights_curated_LATEST.md'
      );
      
      this.logger.info('💎 Curation: Analyzing insights...', {
        insights: agentResults.insights.length,
        findings: agentResults.findings.length
      });
      
      // Build system context for goal-aligned curation
      // Ensure arrays are actually arrays (handles state loading edge cases)
      const activeGoals = Array.isArray(this.prioritizedGoals) ? this.prioritizedGoals : [];
      const directives = Array.isArray(this.strategicDirectives) ? this.strategicDirectives : [];
      const history = Array.isArray(this.contextMemory) ? this.contextMemory : [];
      
      const systemContext = {
        activeGoals: activeGoals,
        strategicDirectives: directives,
        cycleCount: cycleCount,
        reviewHistory: history
      };
      
      // Run full curation (this takes 5-7 minutes)
      const results = await curator.curateRun(systemContext);
      
      this.logger.info('💎 Curation: Generating report...', {
        topInsights: results.metadata.topInsightsCount
      });
      
      // Generate markdown report
      await curator.generateReport(results, reportPath, systemContext);
      
      // Update symlink to latest report (for dashboard)
      try {
        const fs = require('fs').promises;
        try {
          await fs.unlink(latestPath);
        } catch {} // Ignore if doesn't exist
        await fs.symlink(path.basename(reportPath), latestPath);
      } catch (symlinkError) {
        // Symlink not critical, log and continue
        this.logger.warn('Could not create LATEST symlink', { 
          error: symlinkError.message 
        });
      }
      
      const duration = (Date.now() - startTime) / 1000;
      
      this.logger.info('');
      this.logger.info('💎✅ Insight curation complete (async)', {
        cycle: cycleCount,
        topInsights: results.metadata.topInsightsCount,
        rawInsights: results.metadata.totalRawInsights,
        duration: duration.toFixed(1) + 's',
        reportPath: path.basename(reportPath)
      });
      this.logger.info('');
      
    } catch (error) {
      this.logger.error('Insight curation failed (async)', {
        cycle: cycleCount,
        error: error.message,
        stack: error.stack
      });
      // Error already logged, don't rethrow - this is fire-and-forget
    }
  }

  /**
   * Get enterprise-grade timeout for agent type
   * Delegates to shared configuration module
   */
  getAgentTimeout(agentType) {
    return getAgentTimeout(agentType);
  }

  /**
   * Check if goal should spawn an IDE agent
   * IDEAgent handles codebase modification tasks
   * @param {string} goalText - Lowercase goal description
   * @returns {boolean} True if IDE agent should handle this goal
   */
  shouldSpawnIDEAgent(goalText) {
    // Explicit keywords (highest priority)
    if (goalText.includes('ideagent') || goalText.includes('ide agent') || goalText.includes('ide_agent')) {
      return true;
    }
    
    // Implementation patterns that indicate IDE work needed
    const implementPatterns = [
      /implement\s+(the\s+)?\w+/,
      /modify\s+(the\s+)?(code|file|codebase)/,
      /edit\s+(the\s+)?(file|code)/,
      /fix\s+(the\s+)?bug/,
      /refactor\s+/,
      /integrate\s+(the\s+)?code/,
      /update\s+(the\s+)?(file|code|implementation)/,
      /add\s+(a\s+)?(function|method|class|module)\s+to/,
      /remove\s+(the\s+)?(function|method|code)\s+from/,
      /change\s+(the\s+)?(implementation|logic)\s+in/
    ];
    
    return implementPatterns.some(p => p.test(goalText));
  }

  /**
   * Check if code artifacts exist in runtime/outputs/code-creation
   * Used to gate CodeExecutionAgent spawning
   */
  async checkForCodeArtifacts() {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs directory
      // Fallback chain: pathResolver > config.logsDir > return false (no process.cwd() fallback)
      let outputsRoot;
      if (this.pathResolver) {
        outputsRoot = this.pathResolver.getOutputsRoot();
      } else if (this.config?.logsDir) {
        outputsRoot = path.join(this.config.logsDir, 'outputs');
      } else {
        this.logger.debug('Cannot determine outputs root for code artifacts check - skipping');
        return false;
      }
      const codeCreationDir = path.join(outputsRoot, 'code-creation');
      
      // Check if directory exists
      try {
        await fs.access(codeCreationDir);
      } catch {
        this.logger.debug('Code creation output directory does not exist', {
          path: codeCreationDir
        });
        return false;
      }

      // List agent subdirectories
      const entries = await fs.readdir(codeCreationDir, { withFileTypes: true });
      const agentDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('agent_'));

      if (agentDirs.length === 0) {
        this.logger.debug('No code creation agent outputs found');
        return false;
      }

      // Check if any agent directory has actual code files (not just manifest/_debug)
      for (const agentDir of agentDirs) {
        const agentPath = path.join(codeCreationDir, agentDir.name);
        const hasCodeFiles = await this.hasCodeFilesRecursive(agentPath);
        if (hasCodeFiles) {
          this.logger.debug('Found code artifacts', {
            agentDir: agentDir.name,
            path: agentPath
          });
          return true;
        }
      }

      this.logger.debug('Code creation directories exist but contain no code files', {
        agentDirsChecked: agentDirs.length
      });
      return false;

    } catch (error) {
      this.logger.warn('Failed to check for code artifacts', {
        error: error.message
      });
      // On error, conservatively return false (don't spawn)
      return false;
    }
  }

  /**
   * Recursively count actual deliverable files in a directory
   * Skips manifests, debug dirs, and other metadata
   * Populates audit.recentFiles with discovered files
   */
  async countDeliverablesRecursive(dirPath, agentType, audit, depth = 0, maxDepth = 3) {
    // Prevent infinite recursion
    if (depth > maxDepth) return 0;
    
    try {
      const listResult = await this.gpt5.callMCPTool('filesystem', 'list_directory', {
        path: dirPath
      });
      
      if (!listResult?.content?.[0]) return 0;
      
      const dirData = JSON.parse(listResult.content[0].text);
      const items = dirData.items || [];
      
      let count = 0;
      
      for (const item of items) {
        // Skip metadata and debug files/dirs
        if (item.name === 'manifest.json' || 
            item.name === 'deliverables-manifest.json' ||
            item.name === '.complete' ||
            item.name === '_debug' ||
            item.name.startsWith('.')) {
          continue;
        }
        
        if (item.type === 'file') {
          // Count actual deliverable file
          count++;
          
          // Track recent files (last 5 overall)
          if (audit.recentFiles.length < 5) {
            audit.recentFiles.push({
              path: dirPath.replace('runtime/outputs/', '') + '/' + item.name,
              size: item.size,
              modified: item.modified,
              agentType: agentType
            });
          }
        } else if (item.type === 'directory') {
          // Recurse into subdirectories
          const subCount = await this.countDeliverablesRecursive(
            `${dirPath}/${item.name}`,
            agentType,
            audit,
            depth + 1,
            maxDepth
          );
          count += subCount;
        }
      }
      
      return count;
    } catch (error) {
      this.logger.debug('Could not count files in directory', {
        path: dirPath,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Recursively check if a directory contains actual code files
   */
  async hasCodeFilesRecursive(dirPath) {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        // Skip manifest and debug directories
        if (entry.name === 'manifest.json' || entry.name === '_debug') {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isFile()) {
          // Found a file that's not manifest - consider it a code artifact
          const ext = path.extname(entry.name).toLowerCase();
          const codeExtensions = ['.py', '.js', '.ts', '.html', '.css', '.java', '.go', '.rs', '.sh', '.sql', '.json', '.yaml', '.yml', '.toml', '.txt', '.md'];
          
          if (codeExtensions.includes(ext) || !ext) {
            return true;
          }
        } else if (entry.isDirectory()) {
          // Recurse into subdirectories
          const hasFiles = await this.hasCodeFilesRecursive(fullPath);
          if (hasFiles) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      this.logger.debug('Error checking directory for code files', {
        path: dirPath,
        error: error.message
      });
      return false;
    }
  }

  /**
   * EXECUTIVE RING: Emergency review triggered by coherence crisis
   * 
   * Called by ExecutiveCoordinator when coherence score drops below critical threshold.
   * Provides immediate diagnostic and intervention (not scheduled like normal reviews).
   * 
   * @param {Object} trigger - { trigger, reason, coherenceScore, cycleCount, urgentGoal }
   * @returns {Object} - Diagnostic results or null if failed
   */
  async emergencyReview(trigger) {
    this.logger.error('🚨 EMERGENCY REVIEW TRIGGERED', {
      trigger: trigger.trigger,
      reason: trigger.reason,
      coherenceScore: trigger.coherenceScore,
      cycle: trigger.cycleCount
    });
    
    // Get current system state
    const state = await this.loadSystemState?.() || {};
    const goals = this.activeGoalsSystem?.getGoals() || [];
    
    // Generate emergency diagnostic using LLM
    const prompt = `EMERGENCY DIAGNOSTIC - COSMO System Incoherence

TRIGGER: ${trigger.trigger}
REASON: ${trigger.reason}
COHERENCE SCORE: ${trigger.coherenceScore?.toFixed(2)} (critical threshold breached)
CYCLE: ${trigger.cycleCount}

ACTIVE GOALS: ${goals.length}
${goals.slice(0, 5).map(g => `- [${g.id}] ${g.description.substring(0, 100)}`).join('\n')}

QUESTION: What is causing the incoherence and what should we do IMMEDIATELY?

Analyze:
1. Root cause of the incoherence
2. Immediate action to take (specific, actionable)
3. One urgent goal to inject that will unblock the system

Respond with JSON:
{
  "diagnosis": "root cause in one sentence",
  "immediateAction": "what to do right now",
  "urgentGoal": {
    "description": "specific goal description",
    "agentType": "agent type",
    "priority": 0.95,
    "urgency": "critical",
    "rationale": "why this fixes the issue"
  }
}`;

    try {
      const response = await this.gpt5.generate({
        prompt: prompt,
        maxTokens: 600,
        temperature: 0.2,
        timeout: 30000
      });

      const diagnostic = JSON.parse(response.content);
      
      this.logger.error('🔍 Emergency diagnostic complete', {
        diagnosis: diagnostic.diagnosis,
        immediateAction: diagnostic.immediateAction
      });
      
      // Inject urgent goal immediately
      if (diagnostic.urgentGoal && this.activeGoalsSystem) {
        const injected = await this.injectUrgentGoals([diagnostic.urgentGoal], this.activeGoalsSystem);
        
        if (injected && injected.length > 0) {
          this.logger.info('💉 Emergency goal injected', {
            goalId: injected[0]?.id,
            description: diagnostic.urgentGoal.description.substring(0, 100)
          });
        }
      }
      
      // Store emergency report for audit trail
      await this.storeEmergencyReport(trigger, diagnostic);
      
      return diagnostic;
      
    } catch (error) {
      this.logger.error('Emergency review failed', { 
        error: error.message,
        trigger 
      });
      
      // Fallback: inject generic urgent goal if provided
      if (trigger.urgentGoal && this.activeGoalsSystem) {
        await this.injectUrgentGoals([trigger.urgentGoal], this.activeGoalsSystem);
      }
      
      return null;
    }
  }

  /**
   * Store emergency report for audit trail
   */
  async storeEmergencyReport(trigger, diagnostic) {
    const report = {
      timestamp: new Date().toISOString(),
      cycle: trigger.cycleCount,
      trigger: {
        type: trigger.trigger,
        reason: trigger.reason,
        coherenceScore: trigger.coherenceScore
      },
      diagnostic: diagnostic || { error: 'Diagnostic failed' },
      urgentGoalInjected: !!diagnostic?.urgentGoal
    };
    
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const reportPath = path.join(
        this.config.logsDir || 'runtime',
        'coordinator',
        `emergency_${Date.now()}.json`
      );
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          reportPath,  // Use absolute path - pathResolver handles it correctly
          JSON.stringify(report, null, 2),
          { agentId: 'meta-coordinator', agentType: 'meta-coordinator', missionGoal: 'emergency' }
        );
      } else {
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      }
      this.logger.info('📝 Emergency report saved', { path: reportPath });
    } catch (error) {
      this.logger.warn('Failed to save emergency report', { error: error.message });
    }
  }
}

module.exports = { MetaCoordinator };
