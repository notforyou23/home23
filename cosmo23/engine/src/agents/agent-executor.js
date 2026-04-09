const { AgentRegistry } = require('./agent-registry');
const { AgentResultsQueue } = require('./results-queue');
const { MessageQueue } = require('./message-queue');
const { MCPBridge } = require('./mcp-bridge');
const { ExternalBridge } = require('./external-bridge');
const { FrontierGate } = require('../frontier/frontier-gate');
const { DeliverableManifest } = require('./deliverable-manifest');
const { SpawnGate } = require('../core/spawn-gate');
const path = require('path');

// Real-time event streaming - fallback singleton for CLI mode
// Multi-tenant mode uses injected eventEmitter from phase2bSubsystems
let _singletonEvents = null;
function getSingletonEvents() {
  if (!_singletonEvents) {
    _singletonEvents = require('../realtime/event-emitter').cosmoEvents;
  }
  return _singletonEvents;
}

/**
 * AgentExecutor - Manages specialist agent lifecycle
 * 
 * Responsibilities:
 * - Spawn agents based on Meta-Coordinator missions
 * - Track active agents via registry
 * - Collect results via results queue
 * - Manage inter-agent messaging
 * - Enforce concurrency limits
 * - Integrate results back into Phase 2B systems
 * 
 * Integration Flow:
 * 1. Meta-Coordinator creates mission spec
 * 2. AgentExecutor.spawnAgent(missionSpec)
 * 3. Agent runs asynchronously in background
 * 4. Results added to queue when agent completes
 * 5. Orchestrator calls processCompletedResults() periodically
 * 6. Results integrated into memory/goals
 */
class AgentExecutor {
  constructor(phase2bSubsystems, config, logger, evaluation = null) {
    this.memory = phase2bSubsystems.memory;
    this.goals = phase2bSubsystems.goals;
    this.pathResolver = phase2bSubsystems.pathResolver; // NEW: PathResolver for deliverables
    this.config = config;
    this.logger = logger;
    this.evaluation = evaluation;

    // Multi-tenant event emitter (injected for context isolation)
    this.events = phase2bSubsystems.eventEmitter || null;
    
    // Sub-components
    this.registry = new AgentRegistry(logger);
    this.resultsQueue = new AgentResultsQueue(config.logsDir, logger);
    this.messageQueue = new MessageQueue(logger);
    // Note: clusterStateStore will be injected later via setClusterReviewContext
    // We create MCPBridge without it initially, it gets set when available
    this.mcpBridge = new MCPBridge(config.logsDir, logger, null);  // MCP bridge for system introspection
    this.externalBridge = new ExternalBridge(config, logger);  // External API integrations
    this.frontierGate = new FrontierGate(config, logger);  // FrontierGate for governance
    this.capabilities = null;  // NEW: Capabilities (injected by Orchestrator after ExecutiveRing init)
    this.spawnGate = new SpawnGate({
      memory: this.memory,
      resultsQueue: this.resultsQueue
    }, logger);
    
    // Configuration
    this.maxConcurrent = config.coordinator?.maxConcurrent || 2;
    this.initialized = false;
    
    // Agent type constructors (will be populated when agent types are implemented)
    this.agentTypes = new Map();

    // Cluster review pipeline context (optional)
    this.clusterStateStore = null;
    this.clusterInstanceId = null;
    this.clusterReviewOptions = {};
    
    // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Task state queue for serialization
    this.taskStateQueue = null; // Injected via setClusterReviewContext

    // Execution architecture (injected by Orchestrator after init)
    this.skillRegistry = null;
    this.campaignMemory = null;
  }

  /**
   * Get the event emitter for this agent executor context.
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
   * Set evaluation framework (called after initialization)
   */
  setEvaluationFramework(evaluation) {
    this.evaluation = evaluation;
  }

  /**
   * Initialize executor - Must be called before use
   */
  async initialize() {
    await this.resultsQueue.initialize();
    
    // Initialize FrontierGate if enabled
    if (this.frontierGate.enabled) {
      await this.frontierGate.initialize();
    }
    
    this.initialized = true;
    
    this.logger.info('✅ Agent Executor initialized', {
      maxConcurrent: this.maxConcurrent,
      logsDir: this.config.logsDir,
      frontierEnabled: this.frontierGate.enabled
    }, 3);
  }

  /**
   * Register an agent type
   * @param {string} typeName - Agent type name (e.g., 'research', 'analysis')
   * @param {Class} AgentClass - Agent class constructor
   */
  registerAgentType(typeName, AgentClass) {
    this.agentTypes.set(typeName, AgentClass);
    this.logger.debug('Agent type registered', { typeName }, 3);
  }

  /**
   * Configure cluster review context so agents can update shared artifacts.
   * @param {Object|null} clusterStateStore
   * @param {string|null} instanceId
   * @param {Object} [options]
   */
  setClusterReviewContext(clusterStateStore, instanceId, options = {}) {
    this.clusterStateStore = clusterStateStore || null;
    this.clusterInstanceId = instanceId ? instanceId.toLowerCase() : null;
    this.clusterReviewOptions = options || {};
    
    // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Inject task state queue if provided
    if (options.taskStateQueue) {
      this.taskStateQueue = options.taskStateQueue;
    }
    
    // P3: Inject clusterStateStore into MCPBridge for plan/task queries
    if (this.mcpBridge && clusterStateStore) {
      this.mcpBridge.clusterStateStore = clusterStateStore;
    }

    if (this.spawnGate) {
      this.spawnGate.setClusterStateStore(this.clusterStateStore);
    }
  }

  /**
   * Spawn an agent from mission specification
   * @param {Object} missionSpec - Mission specification from Meta-Coordinator
   * @returns {string|null} Agent ID if spawned, null if unable
   */
  async spawnAgent(missionSpec) {
    if (!this.initialized) {
      this.logger.error('AgentExecutor not initialized');
      return null;
    }

    // CRITICAL: Strategic/urgent goals bypass maxConcurrent limit
    // These are system-critical fixes that shouldn't wait
    const isStrategic = missionSpec.metadata?.urgentGoal === true || 
                       missionSpec.metadata?.strategicPriority === true ||
                       missionSpec.triggerSource === 'urgent_goal';
    
    // Check concurrency limit (but skip for strategic goals)
    if (!isStrategic && !this.registry.canSpawnMore(this.maxConcurrent)) {
      this.logger.warn('❌ Max concurrent agents reached, cannot spawn', {
        limit: this.maxConcurrent,
        active: this.registry.getActiveCount(),
        missionGoal: missionSpec.goalId
      }, 3);
      return null;
    }
    
    // Log if bypassing limit for strategic goal
    if (isStrategic && this.registry.getActiveCount() >= this.maxConcurrent) {
      this.logger.info('🚨 Spawning strategic agent (bypassing maxConcurrent limit)', {
        active: this.registry.getActiveCount(),
        limit: this.maxConcurrent,
        missionGoal: missionSpec.goalId,
        reason: 'strategic_priority'
      }, 3);
    }

    // Check if goal is already being pursued
    if (this.registry.isGoalBeingPursued(missionSpec.goalId)) {
      this.logger.warn('❌ Goal already being pursued by another agent', {
        goalId: missionSpec.goalId
      }, 3);
      return null;
    }

    const gateDecision = await this.spawnGate.evaluate(missionSpec);
    if (!gateDecision.allowed) {
      await this.handleSpawnGateBlock(missionSpec, gateDecision);
      return null;
    }

    // SpawnGate says "differentiate" — enrich mission with prior work context
    if (gateDecision.action === 'differentiate' && gateDecision.differentiationContext) {
      missionSpec.metadata = missionSpec.metadata || {};
      missionSpec.metadata.differentiationContext = gateDecision.differentiationContext;
      missionSpec.metadata.priorWork = gateDecision.priorWork;
      missionSpec.description = `${missionSpec.description}\n\n--- PRIOR WORK CONTEXT ---\n${gateDecision.differentiationContext}`;
      this.logger.info('🔀 SpawnGate differentiated mission with prior work context', {
        agentType: missionSpec.agentType,
        priorAgents: gateDecision.priorWork?.length || 0
      });
    }

    // Extended timeouts for execution agents (data acquisition, pipelines, etc.)
    const EXECUTION_AGENT_TYPES = ['dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
    if (EXECUTION_AGENT_TYPES.includes(missionSpec.agentType)) {
      missionSpec.maxDuration = Math.max(missionSpec.maxDuration || 0, 1800000); // 30 min minimum
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // IDE-FIRST PARADIGM - The IDE agent is the primary execution vehicle
    // ═══════════════════════════════════════════════════════════════════════════
    // The IDE agent can handle EVERYTHING via MCP tools:
    // - Code creation, execution, analysis
    // - Document creation, analysis, synthesis
    // - Quality assurance, exploration, validation
    // Only 'research' stays separate (specialized for web search with external APIs)
    // This is the machine's primary way of DOING - executing autonomous thoughts
    // ═══════════════════════════════════════════════════════════════════════════
    let effectiveAgentType = missionSpec.agentType;

    if (this.config?.ideFirst?.enabled) {
      // In IDE-first mode, ONLY research agents stay separate
      // Everything else becomes IDE - the universal executor
      // Execution agents have their own specialized capabilities — never remap to IDE
      const preservedTypes = ['research', 'consistency', 'dataacquisition', 'datapipeline', 'infrastructure', 'automation'];

      if (!preservedTypes.includes(missionSpec.agentType) && missionSpec.agentType !== 'ide') {
        this.logger.info('🖥️ IDE-FIRST: Routing to IDE agent (autonomous execution)', {
          original: missionSpec.agentType,
          remapped: 'ide',
          goalId: missionSpec.goalId,
          reason: 'IDE agent is the primary executor for autonomous goals'
        });
        effectiveAgentType = 'ide';
        // Preserve original type so the IDE agent knows the intent
        missionSpec.metadata = missionSpec.metadata || {};
        missionSpec.metadata.originalAgentType = missionSpec.agentType;
        missionSpec.metadata.ideFirstRouted = true;
      }
    }

    // Get agent class for this type
    const AgentClass = this.agentTypes.get(effectiveAgentType);
    if (!AgentClass) {
      this.logger.error('❌ Unknown agent type', { 
        type: effectiveAgentType,
        originalType: missionSpec.agentType,
        registeredTypes: Array.from(this.agentTypes.keys())
      }, 3);
      return null;
    }

    try {
      // NEW: Enrich mission with predecessor artifacts before creating agent
      // This discovers files from completed prerequisite tasks and prepares them for upload
      await this.enrichMissionWithArtifacts(missionSpec);

      // Inject capability context for capability-aware planning
      if (this.toolRegistry && this.skillRegistry && this.pluginRegistry) {
        const { buildCapabilitySnapshot } = require('../execution/schemas');
        missionSpec.metadata = missionSpec.metadata || {};
        missionSpec.metadata.capabilityContext = buildCapabilitySnapshot(
          this.toolRegistry, this.skillRegistry, this.pluginRegistry
        );
      }

      // Create agent instance
      const agent = new AgentClass(missionSpec, this.config, this.logger);
      
      // Inject shared resources
      agent.memory = this.memory;
      agent.goals = this.goals;
      agent.messageQueue = this.messageQueue;
      agent.mcp = this.mcpBridge;  // Inject MCP bridge for system introspection
      agent.external = this.externalBridge;  // Inject external API bridge
      agent.pathResolver = this.pathResolver;  // Inject PathResolver for deliverable paths
      agent.frontierGate = this.frontierGate.enabled ? this.frontierGate : null;  // Inject FrontierGate if enabled
      agent.capabilities = this.capabilities;  // NEW: Inject Capabilities for embodied cognition
      agent.clusterStateStore = this.clusterStateStore;  // P1: Inject ClusterStateStore for coordination

      // Enhanced lineage tracking for provenance
      const lineageInfo = {
        spawnedBy: missionSpec.createdBy || 'meta_coordinator',
        spawnCycle: missionSpec.spawnCycle,
        parentAgentId: missionSpec.parentAgentId || null, // Which agent spawned this
        parentMissionId: missionSpec.parentMissionId || null, // Which mission spawned this
        spawningReason: missionSpec.spawningReason || 'goal_execution', // Why this was spawned
        provenanceChain: [...(missionSpec.provenanceChain || []), missionSpec.missionId], // Chain of missions leading here
        spawnTimestamp: new Date().toISOString(),
        triggerSource: missionSpec.triggerSource || 'orchestrator' // What triggered the spawn
      };

      // Register agent with enhanced lineage
      this.registry.register(agent, lineageInfo);
      
      // Track agent spawn in evaluation framework
      if (this.evaluation) {
        this.evaluation.trackAgentSpawned(agent.agentId, effectiveAgentType, missionSpec.goalId);
      }

      // Emit real-time agent spawned event (use effectiveAgentType for IDE-First consolidation)
      this._getEvents().emitAgentSpawned({
        agentId: agent.agentId,
        agentType: effectiveAgentType,
        originalAgentType: missionSpec.agentType !== effectiveAgentType ? missionSpec.agentType : undefined,
        goalId: missionSpec.goalId,
        description: missionSpec.description,
        cycle: missionSpec.spawnCycle,
        triggerSource: lineageInfo.triggerSource
      });

      // CRITICAL: Update goal pursuit tracking (fixes "0 pursued" metrics bug)
      if (missionSpec.goalId && this.goals) {
        const goal = this.goals.upsertExternalGoal(
          missionSpec.goalId,
          missionSpec.description,
          {
            source: missionSpec.triggerSource || missionSpec.spawnedBy || 'external',
            uncertainty: missionSpec.priority ?? 0.5,
            executionContext: missionSpec.executionContext,
            metadata: missionSpec.metadata
          }
        );

        if (goal) {
          goal.lastPursued = Date.now();
          goal.pursuitCount = (goal.pursuitCount || 0) + 1;

          this.logger.debug('Goal pursuit tracked', {
            goalId: goal.id,
            pursuitCount: goal.pursuitCount,
            agentId: agent.agentId
          });
        } else {
          this.logger.warn('⚠️  Could not track goal pursuit (goal missing and upsert failed)', {
            goalId: missionSpec.goalId,
            agentId: agent.agentId
          });
        }
      }

      // Execute agent asynchronously (don't await)
      this.executeAgentAsync(agent);

      this.logger.info('🚀 Agent spawned', {
        agentId: agent.agentId,
        type: effectiveAgentType,
        originalType: missionSpec.agentType !== effectiveAgentType ? missionSpec.agentType : undefined,
        goal: missionSpec.goalId,
        description: missionSpec.description.substring(0, 100)
      }, 3);

      return agent.agentId;
      
    } catch (error) {
      this.logger.error('❌ Failed to spawn agent', {
        type: effectiveAgentType,
        originalType: missionSpec.agentType,
        error: error.message
      }, 3);
      return null;
    }
  }

  async handleSpawnGateBlock(missionSpec, gateDecision) {
    const reason = gateDecision?.reason || 'duplicate_work_detected';
    const evidence = gateDecision?.evidence || {};
    missionSpec.metadata = missionSpec.metadata || {};
    missionSpec.metadata.spawnGateBlocked = true;
    missionSpec.metadata.spawnGateReason = reason;
    missionSpec.metadata.spawnGateEvidence = evidence;

    this.logger.info('🚫 SpawnGate blocked agent spawn', {
      goalId: missionSpec.goalId || null,
      taskId: missionSpec.taskId || null,
      agentType: missionSpec.agentType,
      reason,
      memoryMatches: evidence.memoryMatches?.length || 0,
      resultMatches: evidence.resultMatches?.length || 0
    });

    if (missionSpec.taskId) {
      await this.spawnGate.annotateBlockedTask(missionSpec.taskId, reason, evidence);
    } else if (missionSpec.goalId) {
      this.spawnGate.archiveBlockedGoal(this.goals, missionSpec.goalId, reason, evidence);
    }
  }

  /**
   * Execute agent in background, queue results when done
   * @param {BaseAgent} agent - Agent instance to execute
   */
  async executeAgentAsync(agent) {
    try {
      const results = await agent.run();
      await this.resultsQueue.enqueue(results);
      
      // Track agent completion in evaluation framework
      if (this.evaluation) {
        this.evaluation.trackAgentCompleted(
          agent.agentId,
          results,
          results.qaScore || null
        );
      }
      
      // Emit real-time agent completed event
      this._getEvents().emitAgentCompleted({
        agentId: agent.agentId,
        agentType: agent.agentType,
        status: results.status,
        duration: results.duration || 0,
        artifacts: results.results.filter(r => r.type === 'deliverable').map(d => d.path),
        nodesCreated: results.results.filter(r => r.type === 'finding').length,
        edgesCreated: 0,
        goalId: agent.mission?.goalId || null
      });

      this.logger.info('✅ Agent execution complete, results queued', {
        agentId: agent.agentId,
        status: results.status,
        duration: results.durationFormatted,
        resultsCount: results.results.length
      }, 3);
    } catch (error) {
      // Track agent failure in evaluation framework
      if (this.evaluation) {
        this.evaluation.trackAgentFailed(agent.agentId, error.message);
      }

      // Emit real-time agent failed event
      this._getEvents().emitAgentFailed({
        agentId: agent.agentId,
        agentType: agent.agentType,
        error: error.message,
        cycle: agent.mission?.spawnCycle || null
      });

      this.logger.error('❌ Agent execution failed catastrophically', {
        agentId: agent.agentId,
        error: error.message,
        stack: error.stack
      }, 3);
      
      // Try to queue partial results
      try {
        const partialResults = agent.buildFinalResults();
        partialResults.status = 'failed';
        partialResults.errors.push({
          error: error.message,
          stack: error.stack,
          timestamp: new Date()
        }, 3);
        await this.resultsQueue.enqueue(partialResults);
      } catch (queueError) {
        this.logger.error('Failed to queue partial results', {
          agentId: agent.agentId,
          error: queueError.message
        }, 3);
      }
    }
  }

  /**
   * Process completed agent results
   * Called periodically by orchestrator (every cycle or every N cycles)
   */
  async processCompletedResults() {
    const pending = this.resultsQueue.getPending();
    
    if (pending.length === 0) {
      return { processed: 0, integrated: 0 };
    }

    this.logger.info('📊 Processing agent results', { 
      pendingCount: pending.length 
    }, 3);

    let processed = 0;
    let integrated = 0;

    const newlyIntegrated = [];

    for (const result of pending) {
      try {
        // Ensure goal pursuit is tracked even if spawn-time missed it
        if (result.goalId && this.goals) {
          const goal = this.goals.upsertExternalGoal(
            result.goalId,
            result.missionDescription || result.mission?.description || result.agentType || 'Auto-tracked goal',
            {
              source: result.spawnedBy || 'integration',
              uncertainty: result.priority ?? 0.5,
              executionContext: result.executionContext,
              metadata: result.metadata
            }
          );
          if (goal) {
            if (!goal.lastPursued) {
              goal.lastPursued = Date.now();
            }
            if (!goal.pursuitCount || goal.pursuitCount < 1) {
              goal.pursuitCount = 1;
            }
          }
        }

        // NEW: Quality assurance gate ("Measure Twice, Cut Once")
        const qaDecision = await this.qualityAssuranceCheck(result);
        
        if (qaDecision.shouldIntegrate) {
          await this.integrateResults(result, qaDecision.qaMetadata);
          await this.resultsQueue.markIntegrated(result.agentId);
          newlyIntegrated.push(result);
          integrated++;

          // === EXECUTION AGENT LEARNING ===
          // Feed successful execution agent results to SkillRegistry and CampaignMemory
          // so patterns are learned and reused across runs.
          const EXEC_AGENT_TYPES = ['dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
          const normalizedAgentType = (result.agentType || '')
            .replace(/Agent$/i, '').toLowerCase();

          if (EXEC_AGENT_TYPES.includes(normalizedAgentType) && result.status === 'completed') {
            try {
              // 1. Feed to SkillRegistry if available
              if (this.skillRegistry) {
                const auditEntries = result.agentSpecificData?.auditLog || [];
                const executionResult = {
                  code: auditEntries.map(e => e.operation + ': ' + JSON.stringify(e.args)).join('\n') || '',
                  stdout: result.agentSpecificData?.manifest
                    ? JSON.stringify(result.agentSpecificData.manifest)
                    : '',
                  exitCode: 0,
                  success: true
                };
                const agentContext = {
                  runId: this.config?.runId,
                  agentId: result.agentId,
                  domain: normalizedAgentType,
                  cycle: result.agentSpecificData?.cycle
                };
                await this.skillRegistry.learnSkill(executionResult, agentContext, null);
              }

              // 2. Record to CampaignMemory if available
              if (this.campaignMemory) {
                const findings = result.results?.filter(r => r.type === 'finding') || [];
                const artifacts = result.agentSpecificData?.metadata?.filesCreated || 0;
                const auditOps = (result.agentSpecificData?.auditLog || [])
                  .map(e => e.operation).filter(Boolean);
                const uniqueTools = [...new Set(auditOps)];
                this.campaignMemory.recordDomainInsight(normalizedAgentType,
                  `Execution agent ${result.agentId} completed: ${uniqueTools.length > 0 ? uniqueTools.join(', ') + ' tools used' : 'no tool ops recorded'}. ` +
                  `${findings.length} findings, ${artifacts} artifacts.`
                );
              }
            } catch (err) {
              this.logger.warn('Execution agent learning failed (non-fatal)', { error: err.message });
            }
          }
        } else {
          this.logger.warn('❌ Result rejected by quality assurance', {
            agentId: result.agentId,
            agentType: result.agentType,
            reason: qaDecision.reason,
            confidence: qaDecision.confidence
          });
          await this.resultsQueue.markIntegrated(result.agentId); // Mark processed
        }
        processed++;
      } catch (error) {
        this.logger.error('Failed to integrate agent results', {
          agentId: result.agentId,
          error: error.message
        }, 3);
        processed++;
        // Mark as processed but not integrated - will retry later
      }
    }

    this.logger.info('✅ Agent results processing complete', {
      processed,
      integrated,
      failed: processed - integrated
    }, 3);

    return { processed, integrated, results: newlyIntegrated };
  }

  /**
   * Quality assurance check before integration ("Measure Twice, Cut Once")
   * @param {Object} agentResults - Results from agent.run()
   * @returns {Object} Decision on whether to integrate
   */
  async qualityAssuranceCheck(agentResults) {
    // Enforce QA on by default (fail-closed)
    const qaConfig = {
      enabled: true,
      mode: 'strict',
      minConfidence: 0.7,
      autoRejectThreshold: 0.7,
      ...(this.config.coordinator?.qualityAssurance || {})
    };

    const { agentId, agentType, mission, results, status } = agentResults;

    // Skip QA for failed agents (already handled)
    if (status === 'failed' || status === 'timeout') {
      return { shouldIntegrate: false, reason: `Agent ${status}`, confidence: 0 };
    }

    // Skip QA for QA agents themselves (avoid recursion)
    const normalizedType = this.normalizeAgentTypeDir(agentType);
    if (normalizedType === 'quality-assurance') {
      return { shouldIntegrate: true, confidence: 1.0, qaMetadata: null };
    }

    // Skip QA for execution agents — their accomplishment is measured by
    // files created, commands run, and bytes written, not by finding quality.
    // The cerebral-focused QA scoring (numbers, "specifically", "for example")
    // systematically rejects valid execution output.
    const EXECUTION_AGENT_TYPES = ['dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
    if (EXECUTION_AGENT_TYPES.includes(agentType)) {
      const accomplished = agentResults.accomplishment?.accomplished !== false;
      return {
        shouldIntegrate: accomplished,
        confidence: accomplished ? 0.9 : 0.3,
        qaMetadata: { validation: 'execution_agent_bypass', accomplished }
      };
    }

    // Quick pre-checks without spawning QA agent
    const hasFindings = results.filter(r => r.type === 'finding' || r.type === 'insight').length > 0;
    
    if (!hasFindings) {
      this.logger.info('⚠️  No findings to QA check', { agentId });
      return { shouldIntegrate: true, confidence: 0.8, qaMetadata: { reason: 'no_findings' } };
    }

    // Decide if we need full QA agent validation
    const needsFullValidation = this.shouldRunFullQA(agentResults, qaConfig);
    
    if (!needsFullValidation) {
      // Simple heuristics passed
      return { 
        shouldIntegrate: true, 
        confidence: 0.9, 
        qaMetadata: { validation: 'heuristic_pass' }
      };
    }

    // Full QA validation needed - spawn QA agent
    this.logger.info('🔍 Running full QA validation', { agentId, agentType });
    
    try {
      const qaConfidence = await this.runFullQAValidation(agentResults, qaConfig);

      // Fail-closed: require minimum confidence to integrate
      const threshold = qaConfig.minConfidence ?? qaConfig.autoRejectThreshold ?? 0.7;
      const shouldIntegrate = qaConfidence >= threshold;

      return {
        shouldIntegrate,
        confidence: qaConfidence,
        reason: shouldIntegrate ? 'QA passed' : 'QA rejected',
        qaMetadata: {
          validation: 'full_qa',
          confidence: qaConfidence
        }
      };
    } catch (error) {
      this.logger.error('QA validation failed', { error: error.message });
      // Fail closed on QA execution errors
      return {
        shouldIntegrate: false,
        confidence: 0,
        qaMetadata: { validation: 'qa_error', error: error.message }
      };
    }
  }

  /**
   * Determine if full QA agent validation is needed
   */
  shouldRunFullQA(agentResults, qaConfig) {
    const { results, mission } = agentResults;
    
    // Critical findings need validation
    const findingsCount = results.filter(r => r.type === 'finding').length;
    if (findingsCount >= 3) return true;
    
    // Complex missions need validation
    if (mission.successCriteria && mission.successCriteria.length >= 3) return true;
    
    // Research with many sources needs fact-checking
    if (results.some(r => r.type === 'finding' && r.content.length > 500)) return true;
    
    // Otherwise, simple heuristics sufficient
    return false;
  }

  /**
   * Run full QA validation (quick inline checks, not full agent spawn)
   */
  async runFullQAValidation(agentResults, qaConfig) {
    const { results } = agentResults;
    
    let totalScore = 0;
    let checksRun = 0;

    // Check 1: Has substantive content
    const findings = results.filter(r => r.type === 'finding' || r.type === 'insight');
    const avgLength = findings.reduce((sum, f) => sum + (f.content?.length || 0), 0) / findings.length;
    if (avgLength > 100) {
      totalScore += 0.3;
    }
    checksRun++;

    // Check 2: Has specific details (numbers, examples)
    const hasSpecifics = findings.some(f => 
      f.content?.match(/\d+/) || f.content?.match(/\b(specifically|for example|such as)\b/i)
    );
    if (hasSpecifics) {
      totalScore += 0.3;
    }
    checksRun++;

    // Check 3: Non-empty results
    if (findings.length >= 2) {
      totalScore += 0.2;
    }
    checksRun++;

    // Check 4: Meets basic completeness
    if (findings.length >= 1) {
      totalScore += 0.2;
    }
    checksRun++;

    const confidence = checksRun > 0 ? totalScore : 0.5;
    
    this.logger.debug('QA inline checks', {
      confidence,
      findings: findings.length,
      avgLength: Math.round(avgLength),
      hasSpecifics
    }, 3);

    return confidence;
  }

  /**
   * Integrate agent results into Phase 2B systems
   * @param {Object} agentResults - Results from agent.run()
   * @param {Object} qaMetadata - Optional QA metadata
   */
  async integrateResults(agentResults, qaMetadata = null) {
    const { agentId, agentType, mission, results, status, handoffSpec } = agentResults;

    this.logger.info('🔄 Integrating agent results', {
      agentId,
      agentType,
      goal: mission.goalId,
      status,
      findingsCount: results.filter(r => r.type === 'finding').length
    }, 3);

    // 1. Findings are already added to memory during agent execution
    //    (via agent.addFinding() calls) - just log confirmation
    const findingsAdded = results.filter(r => r.type === 'finding').length;
    if (findingsAdded > 0) {
      this.logger.debug('Findings already in memory', {
        count: findingsAdded
      }, 3);
    }

    // 2. Update goal progress significantly for completed agents
    const isReviewPipeline = Boolean(mission.reviewPipeline);

    if (mission.goalId && status === 'completed' && !isReviewPipeline) {
      try {
        this.goals.updateGoalProgress(
          mission.goalId,
          0.5, // Substantial progress for completed mission
          `Agent ${agentType} completed mission`
        );
        this.logger.info('Goal progress updated', {
          goalId: mission.goalId,
          progressAdded: 0.5
        }, 3);

        // CRITICAL: For CodeCreationAgent, store output directory in goal metadata
        // This enables CodeExecutionAgent to target the specific artifacts
        const normalizedType = this.normalizeAgentTypeDir(agentType);
        if (normalizedType === 'code-creation') {
          // FIX: Use pathResolver for multi-tenant isolation
          const outputDir = this.pathResolver 
            ? path.join(this.pathResolver.getOutputsRoot(), 'code-creation', agentId)
            : path.join(this.config.logsDir || process.cwd(), 'outputs', 'code-creation', agentId);
          try {
            const allGoals = this.goals.getGoals();
            const goal = allGoals.find(g => g.id === mission.goalId);
            if (goal) {
              goal.metadata = goal.metadata || {};
              goal.metadata.codeCreationAgentId = agentId;
              goal.metadata.codeCreationOutputDir = outputDir;
              goal.metadata.codeCreationCompletedAt = new Date().toISOString();
              
              this.logger.info('📂 Linked code creation output to goal', {
                goalId: mission.goalId,
                agentId,
                outputDir
              }, 3);
            } else {
              this.logger.debug('Goal not found for linkage (may have completed already)', {
                goalId: mission.goalId
              }, 4);
            }
          } catch (error) {
            this.logger.warn('Failed to link code output directory to goal', {
              goalId: mission.goalId,
              error: error.message
            }, 3);
          }
        }
      } catch (error) {
        this.logger.warn('Failed to update goal progress', {
          goalId: mission.goalId,
          error: error.message
        }, 3);
      }
    }

    // 3. Handle handoff requests
    if (handoffSpec && handoffSpec.type === 'HANDOFF') {
      await this.messageQueue.push({
        from: agentId,
        to: 'meta_coordinator',
        type: 'HANDOFF_REQUEST',
        payload: {
          ...handoffSpec,
          sourceAgent: agentId,
          sourceAgentType: agentType,
          originalGoal: mission.goalId
        },
        timestamp: new Date()
      }, 3);
      
      this.logger.info('📨 Handoff request queued', {
        from: agentId,
        toAgentType: handoffSpec.toAgentType,
        reason: handoffSpec.reason
      }, 3);
    }

    // 4. Log agent insights as separate messages
    for (const result of results) {
      if (result.type === 'insight') {
        await this.messageQueue.push({
          from: agentId,
          to: 'ALL',
          type: 'INSIGHT',
          payload: {
            insight: result.content,
            goal: mission.goalId,
            agentType
          },
          timestamp: new Date()
        }, 3);
      }
    }

    // 5. Record deliverables so the system can reference them
    const deliverableResults = results.filter(r => r && r.type === 'deliverable');
    if (deliverableResults.length > 0) {
      await this.handleDeliverableResults(deliverableResults, mission, agentId, agentType);
    }

    // 5b. CRITICAL: Canonical artifact registration for plan tasks
    // Close the "ghost artifacts" gap by ensuring task.artifacts is always populated
    // with the agent's output files (best-effort, non-fatal).
    await this.registerTaskArtifactsFromAgentRun(agentResults).catch((error) => {
      this.logger.warn('Task artifact registration failed (non-fatal)', {
        agentId,
        taskId: mission?.taskId,
        error: error.message
      }, 3);
    });
    
    // TEMPORAL: Create semantic edges for task/agent/deliverable relationships
    await this.createSemanticRelationships(agentResults, status).catch((error) => {
      this.logger.debug('Semantic edge creation failed (non-fatal)', {
        agentId,
        error: error.message
      });
    });

    // 6. Generate follow-up goals from follow-up directions
    await this.indexProcessedSourceUrls(agentResults);
    await this.createFollowUpGoals(results, agentId, mission);

    this.logger.info('✅ Agent results integrated', {
      agentId,
      goal: mission.goalId,
      findingsAdded,
      goalProgressUpdated: status === 'completed',
      handoffGenerated: !!handoffSpec
    }, 3);

    await this.updateReviewPipelineArtifacts(agentResults, qaMetadata).catch((error) => {
      this.logger.warn('Review pipeline artifact update failed', {
        agentId,
        error: error.message
      });
    });
  }

  async handleDeliverableResults(deliverables, mission, agentId, agentType) {
    const goalId = mission.goalId || null;
    const fs = require('fs').promises;

    for (const deliverable of deliverables) {
      const info = {
        title: deliverable.title || deliverable.label || mission.description?.substring(0, 100) || 'Untitled Deliverable',
        path: deliverable.path || null,
        metadataPath: deliverable.metadataPath || null,
        format: deliverable.format || null,
        wordCount: deliverable.wordCount || null,
        createdAt: deliverable.createdAt || new Date().toISOString(),
        cycle: mission.spawnCycle ?? null,
        agentId,
        agentType
      };
      
      // NEW: Verify deliverable exists at expected path
      if (info.path) {
        try {
          await fs.access(info.path, fs.constants.R_OK);
          info.verified = true;
          
          // Get file stats for additional validation
          const stats = await fs.stat(info.path);
          info.verifiedSize = stats.size;
          
          this.logger.info('✅ Deliverable verified', {
            path: info.path,
            size: stats.size,
            agentId
          }, 3);
        } catch (error) {
          info.verified = false;
          info.verificationError = error.message;
          
          this.logger.error('❌ Deliverable missing or inaccessible', {
            path: info.path,
            agentId,
            agentType,
            error: error.message
          }, 3);
          
          // Flag for coordinator attention
          if (this.messageQueue) {
            await this.messageQueue.push({
              from: agentId,
              to: 'meta_coordinator',
              type: 'DELIVERABLE_MISSING',
              payload: {
                expectedPath: info.path,
                agentId,
                agentType,
                goalId,
                error: error.message
              },
              timestamp: new Date()
            }, 3);
          }
        }
      }

      this.logger.info('📦 Deliverable created', {
        goalId,
        path: info.path,
        format: info.format,
        agentId,
        verified: info.verified
      }, 3);

      if (this.messageQueue && info.path) {
        await this.messageQueue.push({
          from: agentId,
          to: 'ALL',
          type: 'DELIVERABLE_CREATED',
          payload: {
            goalId,
            ...info
          },
          timestamp: new Date()
        }, 3);
      }

      if (this.goals && goalId) {
        try {
          this.goals.recordGoalDeliverable(goalId, info);
        } catch (error) {
          this.logger.warn('Failed to record goal deliverable', {
            goalId,
            error: error.message
          }, 3);
        }
      }
    }
  }

  // ============================================================================
  // CANONICAL ARTIFACT REGISTRATION (plan tasks)
  // ============================================================================

  normalizeAgentTypeDir(agentType) {
    if (!agentType) return 'misc';
    
    // Normalize string
    const t = String(agentType).toLowerCase()
      .replace(/agent$/i, '')
      .replace(/_/g, '-')
      .replace(/--+/g, '-')
      .trim();
      
    // Handle specific mappings for consistency
    const mapping = {
      'codecreation': 'code-creation',
      'codeexecution': 'code-execution',
      'documentcreation': 'document-creation',
      'documentanalysis': 'document-analysis',
      'qualityassurance': 'quality-assurance',
      'codebaseexploration': 'codebase-exploration'
    };
    
    return mapping[t.replace(/-/g, '')] || t;
  }

  getDefaultAgentOutputDir(agentId, agentType) {
    const path = require('path');
    const agentDir = this.normalizeAgentTypeDir(agentType);
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs directory
    // runtime/outputs/<agent-type>/<agentId>
    // Fallback chain: pathResolver > config.logsDir > error (no process.cwd() fallback)
    let outputsRoot;
    if (this.pathResolver) {
      outputsRoot = this.pathResolver.getOutputsRoot();
    } else if (this.config?.logsDir) {
      outputsRoot = path.join(this.config.logsDir, 'outputs');
    } else {
      this.logger.error('Cannot determine outputs root: no pathResolver or config.logsDir');
      throw new Error('Outputs root cannot be determined - pathResolver and config.logsDir both unavailable');
    }
    return path.join(outputsRoot, agentDir, String(agentId));
  }

  async safePathExists(fs, p) {
    try {
      await fs.access(p);
      return true;
    } catch (_) {
      return false;
    }
  }

  async safeReadJson(fs, p) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async listFilesShallow(fs, dir, maxFiles = 200) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (!entry.isFile()) continue;
        files.push(entry.name);
      }
      return files;
    } catch (_) {
      return [];
    }
  }

  async ensureManifestAndCompletion(outputDir, { agentId, agentType, mission, taskId } = {}) {
    const fs = require('fs').promises;
    const path = require('path');

    if (!(await this.safePathExists(fs, outputDir))) return;

    const manifestPath = path.join(outputDir, 'manifest.json');
    const completePath = path.join(outputDir, '.complete');

    // Build file listing (shallow; directory should be per-agent)
    const fileNames = await this.listFilesShallow(fs, outputDir, 500);
    const files = [];
    for (const name of fileNames) {
      if (name === '.complete') continue;
      const abs = path.join(outputDir, name);
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) continue;
        files.push({
          path: name,
          absolutePath: abs,
          size: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString()
        });
      } catch (_) {}
    }

    // Ensure manifest.json exists (do not overwrite if present)
    if (!(await this.safePathExists(fs, manifestPath))) {
      const base = DeliverableManifest.create({
        agentId: String(agentId),
        agentType: this.normalizeAgentTypeDir(agentType),
        mission: mission || {},
        spawnCycle: mission?.spawnCycle ?? null,
        coordinatorReview: mission?.spawnCycle ?? null
      });
      base.completedAt = new Date().toISOString();
      base.deliverableType = this.normalizeAgentTypeDir(agentType);
      base.files = files.map(f => ({
        path: f.path,
        size: f.size,
        modifiedAt: f.modifiedAt
      }));
      base.taskId = taskId || mission?.taskId || null;

      await DeliverableManifest.save(base, manifestPath, {
        capabilities: this.capabilities || null,
        agentContext: {
          agentId: String(agentId),
          agentType: this.normalizeAgentTypeDir(agentType),
          missionGoal: mission?.goalId || null,
          taskId: taskId || mission?.taskId || null
        }
      });
    }

    // Ensure completion marker exists (do not overwrite if present)
    if (!(await this.safePathExists(fs, completePath))) {
      const temp = `${completePath}.tmp.${process.pid}.${Date.now()}`;
      const payload = {
        completedAt: new Date().toISOString(),
        agentId: String(agentId),
        agentType: this.normalizeAgentTypeDir(agentType),
        goalId: mission?.goalId || null,
        taskId: taskId || mission?.taskId || null,
        fileCount: files.length,
        totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0)
      };
      await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(temp, completePath);
    }
  }

  /**
   * TEMPORAL: Create semantic edges for task/agent/deliverable relationships
   * Enables causal/relationship modeling in memory graph
   * Non-breaking: Fails gracefully if memory unavailable
   * 
   * @param {Object} agentResults - Complete agent results
   * @param {string} status - Agent completion status
   */
  async createSemanticRelationships(agentResults, status) {
    if (!this.memory) return;
    
    const mission = agentResults.mission || {};
    const agentId = agentResults.agentId;
    const results = agentResults.results || [];
    
    // Create semantic edges based on agent activity
    try {
      // 1. Task → Agent (EXECUTED_BY)
      if (mission.taskId && mission.goalId) {
        // Find task and agent nodes in memory (may not exist if not added as nodes)
        // Non-blocking: Just try to create edge if both nodes exist
        const taskNode = await this.findMemoryNodeByTag(`task_${mission.taskId}`);
        const agentNode = await this.findMemoryNodeByTag(`agent_${agentId}`);
        
        if (taskNode && agentNode) {
          const NetworkMemory = require('../memory/network-memory').NetworkMemory;
          this.memory.addEdge(
            taskNode.id,
            agentNode.id,
            0.8,
            NetworkMemory.EDGE_TYPES.EXECUTED_BY
          );
        }
      }
      
      // 2. Agent → Deliverable (PRODUCED)
      const deliverables = results.filter(r => r.type === 'deliverable');
      for (const deliverable of deliverables) {
        if (deliverable.nodeId) {
          const agentNode = await this.findMemoryNodeByTag(`agent_${agentId}`);
          if (agentNode) {
            const NetworkMemory = require('../memory/network-memory').NetworkMemory;
            this.memory.addEdge(
              agentNode.id,
              deliverable.nodeId,
              0.9,
              NetworkMemory.EDGE_TYPES.PRODUCED
            );
          }
        }
      }
      
      // 3. Log agent failure cause
      if (status === 'failed' && agentResults.error) {
        const causeText = agentResults.error.message || agentResults.error;
        this.logger.error('Agent failure cause', {
          agentId,
          cause: causeText
        });
      }
      
    } catch (error) {
      // Non-breaking: Semantic edges are enhancement, not critical
      this.logger.debug('Semantic edge creation skipped', {
        agentId,
        error: error.message
      });
    }
  }
  
  /**
   * TEMPORAL: Find memory node by tag (helper for semantic edges)
   * Returns first matching node or null
   * 
   * @param {string} tag - Tag to search for
   * @returns {Object|null} Memory node or null
   */
  async findMemoryNodeByTag(tag) {
    if (!this.memory || !this.memory.nodes) return null;
    
    for (const node of this.memory.nodes.values()) {
      if (node.tag === tag) {
        return node;
      }
    }
    
    return null;
  }

  /**
   * P7: Classify artifact kind based on semantic intent
   * 
   * Uses agent's explicit type markers (from results[]) as primary source
   * Falls back to filename heuristics only when intent is unknown
   * 
   * @param {string} filePath - Absolute path to file
   * @param {Set} deliverablePaths - Paths explicitly marked as deliverables by agent
   * @returns {string} - 'deliverable', 'log', 'manifest', or 'file' (unknown)
   */
  classifyArtifactKind(filePath, deliverablePaths) {
    const path = require('path');
    
    // PRIMARY: Agent explicitly marked this as deliverable
    if (deliverablePaths.has(filePath)) {
      return 'deliverable';
    }
    
    // SECONDARY: Semantic filename analysis (known internal files)
    const fileName = path.basename(filePath);
    
    // Known log files (agent state tracking)
    const knownLogs = new Set([
      'findings.jsonl',
      'audit-log.json',
      'operations.jsonl',
      'progress.json',
      'status.json',
      '.complete'
    ]);
    
    if (knownLogs.has(fileName)) {
      return 'log';
    }
    
    // Known manifest files (metadata)
    if (fileName === 'manifest.json' || fileName === 'deliverables-manifest.json') {
      return 'manifest';
    }
    
    // TERTIARY: Unknown - conservative default
    // We don't know agent's intent, so mark as generic 'file'
    // Downstream filters can decide how to handle these
    return 'file';
  }

  async registerTaskArtifactsFromAgentRun(agentResults) {
    if (!this.clusterStateStore) return;
    const mission = agentResults?.mission || {};
    const taskId = mission.taskId || null;
    if (!taskId) return;

    const fs = require('fs').promises;
    const path = require('path');

    const task = await this.clusterStateStore.getTask(taskId).catch(() => null);
    if (!task) return;

    const agentId = agentResults.agentId;
    const agentType = mission.agentType || agentResults.agentType;
    const goalId = mission.goalId || null;

    // Candidate output directories:
    // - conventional per-agent output dir
    // - deliverable paths' parent dirs (if any deliverables were emitted)
    // - CRITICAL FIX (Jan 20): shared workspace if using coordination context
    const dirs = new Set();
    dirs.add(this.getDefaultAgentOutputDir(agentId, agentType));
    
    // CRITICAL FIX (Jan 20): If agent used shared workspace for collaboration, check there too
    const sharedWorkspace = mission?.metadata?.coordinationContext?.sharedWorkspace;
    if (sharedWorkspace) {
      dirs.add(sharedWorkspace);
      this.logger.debug('[AgentExecutor] Including shared workspace in artifact scan', {
        taskId,
        agentId,
        sharedWorkspace
      });
    }

    // P7: Extract deliverable paths from agent results for semantic classification
    // These are explicitly marked by agents as user-facing deliverables
    const deliverables = Array.isArray(agentResults.results)
      ? agentResults.results.filter(r => r && r.type === 'deliverable' && r.path)
      : [];
    
    const deliverablePaths = new Set();
    for (const d of deliverables) {
      try {
        const abs = path.isAbsolute(d.path) ? d.path : path.join(process.cwd(), d.path);
        deliverablePaths.add(abs); // P7: Track for semantic classification
        dirs.add(path.dirname(abs));
      } catch (_) {}
    }

    const artifacts = [];

    this.logger.debug('[AgentExecutor] Starting artifact collection', {
      taskId,
      agentId,
      dirsToScan: Array.from(dirs)
    });

    for (const dir of dirs) {
      if (!(await this.safePathExists(fs, dir))) {
        this.logger.debug('[AgentExecutor] Directory does not exist, skipping', { dir });
        continue;
      }

      // Ensure manifest and completion marker are present for discoverability
      await this.ensureManifestAndCompletion(dir, { agentId, agentType, mission, taskId });

      // Prefer deliverables-manifest.json, then manifest.json, then raw dir scan
      const deliverablesManifestPath = path.join(dir, 'deliverables-manifest.json');
      const manifestPath = path.join(dir, 'manifest.json');

      const deliverablesManifest = await this.safeReadJson(fs, deliverablesManifestPath);
      if (deliverablesManifest && Array.isArray(deliverablesManifest.deliverables)) {
        for (const f of deliverablesManifest.deliverables) {
          // PRODUCTION: Use pathResolver for correct outputs root (run-isolated)
          // Fallback chain: pathResolver > config.logsDir > skip (no process.cwd() fallback)
          let outputsRoot;
          if (this.pathResolver) {
            outputsRoot = this.pathResolver.getOutputsRoot();
          } else if (this.config?.logsDir) {
            outputsRoot = path.join(this.config.logsDir, 'outputs');
          } else {
            this.logger.warn('Cannot determine outputs root for artifact collection - skipping entry');
            continue;
          }
          
          const absolutePath = f.absolutePath || path.join(dir, f.path || '');
          
          const relativeWithinOutputs = path.join(path.relative(outputsRoot, dir), f.path || '').split(path.sep).join('/');
          artifacts.push({
            path: relativeWithinOutputs,
            workspacePath: path.join('outputs', relativeWithinOutputs).split(path.sep).join('/'),
            absolutePath,
            size: f.size || null,
            checksum: f.checksum || null,
            agentId,
            agentType: this.normalizeAgentTypeDir(agentType),
            goalId,
            taskId,
            recordedAt: new Date().toISOString(),
            kind: this.classifyArtifactKind(absolutePath, deliverablePaths) // P7: Semantic classification
          });
        }
        continue;
      }

      const manifest = await this.safeReadJson(fs, manifestPath);
      if (manifest && Array.isArray(manifest.files)) {
        for (const f of manifest.files) {
          // PRODUCTION: Use pathResolver for correct outputs root (run-isolated)
          // Fallback chain: pathResolver > config.logsDir > skip (no process.cwd() fallback)
          let outputsRoot;
          if (this.pathResolver) {
            outputsRoot = this.pathResolver.getOutputsRoot();
          } else if (this.config?.logsDir) {
            outputsRoot = path.join(this.config.logsDir, 'outputs');
          } else {
            this.logger.warn('Cannot determine outputs root for artifact collection - skipping entry');
            continue;
          }

          // Support both absolute path and filename in manifest
          const filePath = f.path || f.filename || '';
          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(dir, filePath);

          const relativeWithinOutputs = path.join(path.relative(outputsRoot, dir), f.filename || path.basename(filePath) || '').split(path.sep).join('/');
          artifacts.push({
            path: relativeWithinOutputs,
            workspacePath: path.join('outputs', relativeWithinOutputs).split(path.sep).join('/'),
            absolutePath,
            size: f.size || null,
            checksum: f.checksum || null,
            agentId,
            agentType: this.normalizeAgentTypeDir(agentType),
            goalId,
            taskId,
            recordedAt: new Date().toISOString(),
            kind: this.classifyArtifactKind(absolutePath, deliverablePaths) // P7: Semantic classification
          });
        }
        continue;
      }

      // Fallback: shallow scan
      const names = await this.listFilesShallow(fs, dir, 500);
      for (const name of names) {
        if (name === '.complete') continue;
        const abs = path.join(dir, name);
        try {
          const st = await fs.stat(abs);
          if (!st.isFile()) continue;
          // PRODUCTION: Use pathResolver for correct outputs root (run-isolated)
          // Fallback chain: pathResolver > config.logsDir > skip (no process.cwd() fallback)
          let outputsRoot;
          if (this.pathResolver) {
            outputsRoot = this.pathResolver.getOutputsRoot();
          } else if (this.config?.logsDir) {
            outputsRoot = path.join(this.config.logsDir, 'outputs');
          } else {
            this.logger.warn('Cannot determine outputs root for artifact collection - skipping entry');
            continue;
          }
          const relativeWithinOutputs = path.join(path.relative(outputsRoot, dir), name).split(path.sep).join('/');
          artifacts.push({
            path: relativeWithinOutputs,
            workspacePath: path.join('outputs', relativeWithinOutputs).split(path.sep).join('/'),
            absolutePath: abs,
            size: st.size,
            checksum: null,
            agentId,
            agentType: this.normalizeAgentTypeDir(agentType),
            goalId,
            taskId,
            recordedAt: new Date().toISOString(),
            kind: this.classifyArtifactKind(abs, deliverablePaths) // P7: Semantic classification
          });
        } catch (_) {}
      }
    }

    if (artifacts.length === 0) {
      this.logger.debug('[AgentExecutor] No artifacts found for task', {
        taskId,
        agentId,
        dirsScanned: dirs.size,
        reason: 'artifacts_array_empty'
      });
      return;
    }

    this.logger.info('[AgentExecutor] Registering artifacts for task', {
      taskId,
      agentId,
      artifactsFound: artifacts.length,
      dirsScanned: dirs.size
    });

    // Merge into task.artifacts (dedupe by absolutePath + agentId)
    const existing = Array.isArray(task.artifacts) ? task.artifacts : [];
    const existingKey = new Set(existing.map(a => `${a.absolutePath || a.path}::${a.agentId || ''}`));

    const merged = [...existing];
    for (const a of artifacts) {
      const key = `${a.absolutePath || a.path}::${a.agentId || ''}`;
      if (existingKey.has(key)) continue;
      merged.push({
        ...a,
        // P7: Preserve semantic kind from classification (default to 'file' for backward compat)
        kind: a.kind || 'file'
      });
      existingKey.add(key);
    }

    task.artifacts = merged;
    task.updatedAt = Date.now();
    task.metadata = task.metadata || {};
    if (!task.metadata.goalId && goalId) task.metadata.goalId = goalId;
    if (!task.metadata.agentType && agentType) task.metadata.agentType = this.normalizeAgentTypeDir(agentType);

    // UNIFIED QUEUE ARCHITECTURE (Jan 20, 2026): Enqueue task update instead of direct write
    // This prevents race conditions when orchestrator also validates/updates task in same cycle
    if (this.taskStateQueue) {
      await this.taskStateQueue.enqueue({
        type: 'UPDATE_TASK',
        taskId: task.id,
        task: task,
        source: 'artifact_registration',
        cycle: this.cycleCount || 0
      });
    } else {
      // Fallback to direct write if queue not available (backward compatibility)
      await this.clusterStateStore.upsertTask(task);
    }
  }

  async updateReviewPipelineArtifacts(agentResults, qaMetadata = null) {
    if (!this.clusterStateStore) {
      return;
    }

    const mission = agentResults?.mission || {};
    const pipeline = mission.reviewPipeline || null;
    if (!pipeline || !pipeline.artifactId) {
      return;
    }

    const cycle = mission.spawnCycle ?? pipeline.cycle ?? null;
    if (cycle === null || cycle === undefined) {
      this.logger.warn('Review pipeline update skipped (missing cycle)', {
        agentId: agentResults.agentId,
        artifactId: pipeline.artifactId
      }, 3);
      return;
    }

    const artifactType = this.getReviewArtifactType(pipeline.role);
    const normalizedResults = Array.isArray(agentResults.results)
      ? agentResults.results.filter(Boolean)
      : [];

    const summary = this.buildReviewSummary(normalizedResults, qaMetadata);

    let existing = null;
    try {
      const artifacts = await this.clusterStateStore.getReviewArtifacts(cycle);
      existing = artifacts.find((artifact) => artifact.artifactId === pipeline.artifactId) || null;
    } catch (error) {
      this.logger.warn('Failed to load existing review artifact', {
        cycle,
        artifactId: pipeline.artifactId,
        error: error.message
      }, 3);
    }

    const now = new Date().toISOString();
    const record = {
      artifactId: pipeline.artifactId,
      artifactType,
      status: agentResults.status === 'completed' ? 'complete' : agentResults.status,
      instanceId: this.clusterInstanceId || (existing && existing.instanceId) || 'unknown',
      planId: pipeline.planId || existing?.planId || null,
      cycle,
      role: pipeline.role || existing?.role || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      draftArtifactId: existing?.draftArtifactId || pipeline.draftArtifactId || null,
      critiqueArtifacts: existing?.critiqueArtifacts || pipeline.critiqueArtifactIds || [],
      mission: {
        missionId: mission.missionId || existing?.mission?.missionId || null,
        agentType: mission.agentType || agentResults.agentType,
        agentId: agentResults.agentId,
        spawnedAt: existing?.mission?.spawnedAt || mission.spawnedAt || null,
        completedAt: now,
        durationMs: agentResults.duration,
        status: agentResults.status
      },
      summary: {
        ...existing?.summary,
        ...summary
      }
    };

    await this.clusterStateStore.recordReviewArtifact(cycle, record);
    await this.clusterStateStore.appendReviewEvent(cycle, {
      event: 'review_artifact_updated',
      artifactId: record.artifactId,
      artifactType: record.artifactType,
      instanceId: record.instanceId,
      agentId: agentResults.agentId,
      status: record.status
    }).catch(() => {});
  }

  getReviewArtifactType(role = '') {
    const normalized = role.toLowerCase();
    if (normalized === 'critic') return 'critique';
    if (normalized === 'synthesizer' || normalized === 'author_synthesizer') return 'synthesis';
    if (normalized === 'author') return 'draft';
    return 'artifact';
  }

  buildReviewSummary(results = [], qaMetadata = null) {
    const keyFindings = [];
    const recommendations = [];

    results.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      if (typeof item.content === 'string' && item.content.trim()) {
        keyFindings.push(item.content.trim());
      }
      if (Array.isArray(item.recommendations)) {
        item.recommendations.forEach((rec) => {
          if (typeof rec === 'string' && rec.trim()) {
            recommendations.push(rec.trim());
          }
        });
      }
    });

    return {
      keyFindings: keyFindings.slice(0, 5),
      recommendations: recommendations.slice(0, 5),
      qa: qaMetadata || null,
      metrics: {
        totalResults: results.length,
        timestamp: new Date().toISOString()
      }
    };
  }

  async indexProcessedSourceUrls(agentResults) {
    if (!this.clusterStateStore) {
      return;
    }

    const sourceUrls = new Set();
    const resultList = Array.isArray(agentResults?.results) ? agentResults.results : [];
    const agentSpecificSources = Array.isArray(agentResults?.agentSpecificData?.sources)
      ? agentResults.agentSpecificData.sources
      : [];
    const handoffSources = Array.isArray(agentResults?.handoffSpec?.sourceUrls)
      ? agentResults.handoffSpec.sourceUrls
      : [];

    for (const url of [...agentSpecificSources, ...handoffSources]) {
      if (typeof url === 'string' && url.trim()) {
        sourceUrls.add(url.trim());
      }
    }

    for (const result of resultList) {
      if (Array.isArray(result?.sources)) {
        for (const url of result.sources) {
          if (typeof url === 'string' && url.trim()) {
            sourceUrls.add(url.trim());
          }
        }
      }
    }

    if (sourceUrls.size === 0) {
      return;
    }

    try {
      const existing = await this.clusterStateStore.get('research_source_index').catch(() => null);
      const urls = Array.isArray(existing?.urls) ? new Set(existing.urls) : new Set();

      for (const url of sourceUrls) {
        urls.add(url);
      }

      await this.clusterStateStore.set('research_source_index', {
        urls: Array.from(urls),
        updatedAt: new Date().toISOString(),
        updatedBy: agentResults.agentId,
        lastGoalId: agentResults.mission?.goalId || null
      });
    } catch (error) {
      this.logger.warn('Failed to index processed source URLs', {
        agentId: agentResults?.agentId,
        error: error.message
      });
    }
  }

  /**
   * Create follow-up goals from agent results
   * @param {Array} results - Agent results array
   * @param {string} agentId - Source agent ID
   */
  async createFollowUpGoals(results, agentId, mission = {}) {
    if (!results || results.length === 0) {
      return;
    }

    const followUpDirections = [];
    
    // Extract follow-up directions from all results
    for (const result of results) {
      if (result.type === 'synthesis' && result.followUp && Array.isArray(result.followUp)) {
        followUpDirections.push(...result.followUp);
      }
      if (result.type === 'exploration_report' && result.promisingDirections && Array.isArray(result.promisingDirections)) {
        followUpDirections.push(...result.promisingDirections);
      }
    }
    
    if (followUpDirections.length === 0) {
      return;
    }

    // Create goals from follow-up directions (max 3 to avoid spam)
    const directionsToCreate = followUpDirections.slice(0, 3);
    const isGuidedFollowUp =
      mission?.metadata?.guidedMission === true ||
      this.config?.architecture?.roleSystem?.explorationMode === 'guided';
    const followUpPriority = isGuidedFollowUp ? 0.8 : 0.5;
    
    const operationalNoise = /stack trace|runtime error|exception|qa gate|probe|cli tool|cosmo infrastructure|operational issue/i;

    for (const direction of directionsToCreate) {
      if (typeof direction === 'string' && direction.length > 20 && !operationalNoise.test(direction)) {
        try {
          const newGoalId = await this.goals.addGoal({
            description: direction,
            priority: followUpPriority,
            source: isGuidedFollowUp ? `guided_follow_up_from_${agentId}` : `follow_up_from_${agentId}`,
            parentAgent: agentId,
            created: new Date(),
            metadata: {
              guidedFollowUp: isGuidedFollowUp,
              originatingGoalId: mission?.goalId || null,
              originatingTaskId: mission?.taskId || null
            }
          });
          
          this.logger.info('📌 Created follow-up goal from agent', {
            agentId,
            goalId: newGoalId,
            priority: followUpPriority,
            direction: direction.substring(0, 80) + (direction.length > 80 ? '...' : '')
          });
        } catch (error) {
          this.logger.warn('Failed to create follow-up goal', {
            agentId,
            direction: direction.substring(0, 50),
            error: error.message
          });
        }
      } else if (typeof direction === 'string' && operationalNoise.test(direction)) {
        this.logger.info('⏭️ Skipping operational follow-up topic', {
          agentId,
          direction: direction.substring(0, 80)
        });
      }
    }
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    return {
      registry: this.registry.getStats(),
      resultsQueue: this.resultsQueue.getStats(),
      messageQueue: this.messageQueue.getStats(),
      maxConcurrent: this.maxConcurrent,
      registeredAgentTypes: Array.from(this.agentTypes.keys())
    };
  }

  /**
   * Get current state for dashboard/monitoring
   */
  exportState() {
    return {
      initialized: this.initialized,
      maxConcurrent: this.maxConcurrent,
      // Use registry's enhanced export
      registry: this.registry.exportState(),
      resultsQueue: this.resultsQueue.exportState(),
      messageQueue: this.messageQueue.exportState(),
      stats: this.getStats()
    };
  }

  /**
   * NEW: Import state from persistence
   */
  importState(state) {
    if (!state) return;
    
    if (state.registry) {
      this.registry.importState(state.registry);
    }
    
    this.logger.info('🤖 Agent executor state imported', {
      completedAgents: this.registry.completedAgents.size
    }, 3);
  }

  /**
   * Cleanup old data
   */
  async cleanup() {
    this.registry.cleanupOldAgents(3600000); // 1 hour
    await this.resultsQueue.cleanupOldResults(86400000); // 24 hours
    this.messageQueue.cleanup(3600000); // 1 hour
    
    this.logger.debug('Agent executor cleanup complete');
  }

  /**
   * Check health status
   * @returns {Object}
   */
  checkHealth() {
    const stats = this.getStats();
    const health = {
      healthy: true,
      issues: []
    };

    // Check if too many agents are failing
    if (stats.registry.failed > 5) {
      health.healthy = false;
      health.issues.push(`High failure rate: ${stats.registry.failed} failed agents`);
    }

    // Check if results queue is backing up
    if (stats.resultsQueue.pending > 10) {
      health.healthy = false;
      health.issues.push(`Results queue backed up: ${stats.resultsQueue.pending} pending`);
    }

    // Check if message queue is growing too large
    if (stats.messageQueue.total > 400) {
      health.issues.push(`Message queue large: ${stats.messageQueue.total} messages`);
    }

    return health;
  }

  /**
   * Gather artifacts from predecessor agents in task dependency chain
   * 
   * Discovers files created by agents that completed prerequisite tasks.
   * Supports recursive dependencies with cycle detection.
   * 
   * Decision points (from design):
   * - Upload ALL predecessor files (within reasonable limits: 50 files / 100MB)
   * - Continue with partial uploads if some fail
   * - Preserve directory structure for imports
   * - Add to mission context so LLM knows what's available
   * 
   * @param {Object} mission - Agent mission spec
   * @returns {Promise<Array>} Array of artifact references with metadata
   */
  async gatherPredecessorArtifacts(mission) {
    const artifacts = [];
    const visitedTasks = new Set();
    const MAX_RECURSION_DEPTH = 3;
    const MAX_ARTIFACTS = 50;
    const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB
    
    let totalSize = 0;
    
    // Helper to discover files from a specific agent
    const discoverFilesFromAgent = async (agentId, goalId) => {
      try {
        // Use the memory system's file discovery
        // This already handles goal-scoped filtering to prevent cross-contamination
        const files = [];
        
        // Query memory for file metadata from this agent
        const tags = [
          'code_creation_output_files',
          'code_execution_output_files', 
          'document_metadata',
          'document_contents_for_analysis'
        ];
        
        for (const tag of tags) {
          if (!this.memory || !this.memory.nodes) continue;
          
          for (const [nodeId, node] of this.memory.nodes) {
            if (node.tag === tag) {
              // Extract JSON payload
              let data = null;
              try {
                const jsonMatch = node.concept.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                  data = JSON.parse(jsonMatch[1]);
                } else if (node.concept.startsWith('{')) {
                  data = JSON.parse(node.concept);
                }
              } catch (e) {
                continue;
              }
              
              if (!data || data.agentId !== agentId) continue;
              
              // Filter by goal to prevent cross-goal contamination
              if (goalId && data.goalId && data.goalId !== goalId) continue;
              
              // Extract files
              if (data.files && Array.isArray(data.files)) {
                files.push(...data.files.map(f => ({
                  ...f,
                  sourceAgentId: agentId,
                  goalId: data.goalId,
                  tag: tag
                })));
              } else if (data.filePath) {
                // Document format
                files.push({
                  filename: data.title || 'document',
                  relativePath: data.filePath,
                  size: data.wordCount || 0,
                  sourceAgentId: agentId,
                  goalId: data.goalId,
                  tag: tag
                });
              }
            }
          }
        }
        
        return files;
      } catch (error) {
        this.logger.warn('Failed to discover files from agent', {
          agentId,
          error: error.message
        });
        return [];
      }
    };
    
    // Recursive function to gather from task and its dependencies
    const gatherRecursive = async (taskId, depth = 0) => {
      // Limit recursion depth
      if (depth > MAX_RECURSION_DEPTH) {
        this.logger.debug('Max recursion depth reached', { taskId, depth });
        return;
      }
      
      // Prevent cycles
      if (visitedTasks.has(taskId)) {
        return;
      }
      visitedTasks.add(taskId);
      
      // Stop if we've hit the artifact limit
      if (artifacts.length >= MAX_ARTIFACTS || totalSize >= MAX_TOTAL_SIZE) {
        this.logger.info('Artifact limit reached', {
          count: artifacts.length,
          size: totalSize,
          limits: { MAX_ARTIFACTS, MAX_TOTAL_SIZE }
        });
        return;
      }
      
      try {
        // Get task from state store
        const task = this.clusterStateStore 
          ? await this.clusterStateStore.getTask(taskId)
          : null;
        
        if (!task) {
          this.logger.debug('Task not found in state store', { taskId });
          return;
        }
        
        // If task has an assigned agent, gather its artifacts
        if (task.assignedAgentId) {
          this.logger.debug('Gathering artifacts from task agent', {
            taskId,
            agentId: task.assignedAgentId,
            taskState: task.state
          });
          
          const files = await discoverFilesFromAgent(
            task.assignedAgentId,
            mission.goalId // Use current mission's goalId for filtering
          );
          
          for (const file of files) {
            // Skip if we've hit limits
            if (artifacts.length >= MAX_ARTIFACTS || totalSize >= MAX_TOTAL_SIZE) {
              break;
            }
            
            // Track size
            const fileSize = file.size || 0;
            if (totalSize + fileSize > MAX_TOTAL_SIZE) {
              this.logger.warn('Skipping file - would exceed size limit', {
                file: file.filename,
                size: fileSize,
                currentTotal: totalSize
              });
              continue;
            }
            
            totalSize += fileSize;
            artifacts.push({
              ...file,
              sourceTaskId: taskId,
              depth: depth
            });
          }
        }
        
        // Recurse to dependencies
        if (task.deps && Array.isArray(task.deps)) {
          for (const depTaskId of task.deps) {
            await gatherRecursive(depTaskId, depth + 1);
          }
        }
      } catch (error) {
        this.logger.warn('Error gathering artifacts from task', {
          taskId,
          error: error.message
        });
      }
    };
    
    // Strategy 1: From task dependencies
    if (mission.taskId && this.clusterStateStore) {
      await gatherRecursive(mission.taskId, 0);
    }
    
    // Strategy 2: From goal metadata (code_creation → code_execution linkage)
    // This is the existing pattern for code agents
    if (mission.metadata?.codeCreationAgentId) {
      this.logger.debug('Found linked code creation agent', {
        linkedAgent: mission.metadata.codeCreationAgentId
      });
      
      const files = await discoverFilesFromAgent(
        mission.metadata.codeCreationAgentId,
        mission.goalId
      );
      
      // Add files that aren't already in artifacts
      for (const file of files) {
        if (artifacts.length >= MAX_ARTIFACTS || totalSize >= MAX_TOTAL_SIZE) {
          break;
        }
        
        // Check for duplicates
        const isDuplicate = artifacts.some(a => 
          a.relativePath === file.relativePath && 
          a.sourceAgentId === file.sourceAgentId
        );
        
        if (!isDuplicate) {
          const fileSize = file.size || 0;
          if (totalSize + fileSize <= MAX_TOTAL_SIZE) {
            totalSize += fileSize;
            artifacts.push({
              ...file,
              sourceTaskId: null,
              depth: 0
            });
          }
        }
      }
    }
    
    if (artifacts.length > 0) {
      this.logger.info('Gathered predecessor artifacts', {
        count: artifacts.length,
        totalSize: totalSize,
        sources: [...new Set(artifacts.map(a => a.sourceAgentId))],
        visitedTasks: visitedTasks.size
      });
    }
    
    return artifacts;
  }

  /**
   * Enrich mission with predecessor artifacts before spawning agent
   * 
   * This is the main integration point - called from spawnAgent() to
   * automatically gather and attach artifacts to the mission.
   * 
   * @param {Object} mission - Mission spec to enrich
   * @returns {Promise<void>}
   */
  async enrichMissionWithArtifacts(mission) {
    try {
      // Check if this agent type benefits from predecessor artifacts
      const artifactAwareTypes = [
        'ide',
        'code_execution',
        'document_analysis',
        'document_creation',
        'synthesis',
        'quality_assurance',
        'research',
        'dataacquisition',
        'datapipeline',
        'infrastructure',
        'automation'
      ];
      
      if (!artifactAwareTypes.includes(mission.agentType)) {
        return; // Agent type doesn't need artifacts
      }

      const explicitArtifactRefs = Array.isArray(mission.metadata?.artifactInputs)
        ? mission.metadata.artifactInputs
            .filter(item => item && (item.path || item.absolutePath))
            .map(item => {
              const absolutePath = item.absolutePath || item.path;
              const workspacePath = this.getWorkspaceArtifactPath(item);
              return {
                absolutePath,
                relativePath: workspacePath || item.relativePath || absolutePath,
                workspacePath,
                path: workspacePath || item.relativePath || absolutePath,
                filename: item.label || path.basename(absolutePath),
                size: item.size || null,
                sourceAgentId: item.sourceAgentId || 'explicit_handoff',
                sourceTaskId: item.sourceTaskId || null,
                depth: 0
              };
            })
        : [];

      // Gather artifacts from predecessors when explicit refs are absent.
      const predecessorArtifacts = explicitArtifactRefs.length === 0
        ? await this.gatherPredecessorArtifacts(mission)
        : [];
      const artifacts = [...explicitArtifactRefs, ...predecessorArtifacts];
      
      if (artifacts.length > 0) {
        // Add artifacts to mission
        mission.artifactsToUpload = artifacts;
        
        // Enhance mission context with artifact information
        mission.artifactContext = this.buildArtifactContext(artifacts);
        
        this.logger.info('Mission enriched with predecessor artifacts', {
          missionId: mission.missionId,
          agentType: mission.agentType,
          artifactCount: artifacts.length,
          explicitArtifacts: explicitArtifactRefs.length,
          sources: [...new Set(artifacts.map(a => a.sourceAgentId))]
        });
      }
    } catch (error) {
      this.logger.warn('Failed to enrich mission with artifacts (non-fatal)', {
        missionId: mission.missionId,
        error: error.message
      });
      // Continue without artifacts rather than failing the mission
    }
  }

  /**
   * Build human-readable context about available artifacts
   * This gets added to the agent's mission so the LLM knows what files exist
   * 
   * @param {Array} artifacts - Artifact references
   * @returns {string} Formatted artifact context
   */
  buildArtifactContext(artifacts) {
    if (!artifacts || artifacts.length === 0) {
      return '';
    }
    
    // Group by source agent
    const bySource = {};
    for (const artifact of artifacts) {
      const source = artifact.sourceAgentId || 'unknown';
      if (!bySource[source]) {
        bySource[source] = [];
      }
      bySource[source].push(artifact);
    }
    
    let context = '\n\n## Available Predecessor Artifacts\n\n';
    context += 'The following files from previous agents are available in your execution environment:\n\n';
    
    for (const [sourceAgentId, files] of Object.entries(bySource)) {
      const sourceAgent = sourceAgentId.split('_')[1] || 'agent'; // Extract type from agent_timestamp_id
      context += `### From ${sourceAgent} (${sourceAgentId}):\n`;
      
      for (const file of files) {
        const size = file.size ? ` (${Math.round(file.size / 1024)}KB)` : '';
        context += `- \`${this.getWorkspaceArtifactPath(file)}\`${size}\n`;
      }
      context += '\n';
    }
    
    context += 'Use the exact relative paths shown above when reading these files. Do not strip directory prefixes.\n';
    
    return context;
  }

  getWorkspaceArtifactPath(file) {
    const candidate = file?.workspacePath || file?.relativePath || file?.path || file?.absolutePath || '';
    if (!candidate) {
      return '';
    }

    const normalized = String(candidate).replace(/\\/g, '/');
    const outputsIndex = normalized.lastIndexOf('/outputs/');
    if (outputsIndex >= 0) {
      return normalized.slice(outputsIndex + 1);
    }

    if (normalized.startsWith('@outputs/')) {
      return normalized.slice(1);
    }

    if (normalized.startsWith('outputs/')) {
      return normalized;
    }

    if (/^(research|ide|code|document|analysis|synthesis|quality|completion)\//.test(normalized)) {
      return `outputs/${normalized}`;
    }

    return normalized;
  }
}

module.exports = { AgentExecutor };
