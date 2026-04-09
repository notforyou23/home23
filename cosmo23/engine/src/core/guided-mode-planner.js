/**
 * Guided Mode Planner
 * 
 * Runs ONCE at startup when explorationMode: guided
 * 
 * Purpose:
 * - Understand the guided task (domain + context)
 * - Identify required resources (MCP files, web search, code execution)
 * - Create initial agent missions
 * - Spawn agents in dependency order (tier-based)
 * - Set up cognitive loop with appropriate context
 * 
 * Agent Tier System:
 * - Tier 0: Data collectors (can work with empty memory)
 * - Tier 1: Processors (need source data)
 * - Tier 2: Creators (need processed results)
 * - Tier 3: Validators (need created outputs)
 * 
 * Only Tier 0 spawns immediately; subsequent tiers spawn via coordinator as dependencies complete.
 */

const fs = require('fs').promises;
const path = require('path');
const { getAgentTimeout } = require('../config/agent-timeouts');
const { getDomainAnchor, filterDomainRelevant } = require('../utils/domain-anchor');
const {
  GUIDED_EFFECTIVE_MODE,
  normalizeExecutionMode
} = require('../../../lib/execution-mode');
const { CampaignMemory } = require('../execution/campaign-memory');
const { CapabilityManifest } = require('../execution/capability-manifest');
const { PGSEngine } = require('../../../lib/pgs-engine');
const { QueryEngine } = require('../../../lib/query-engine');

class GuidedModePlanner {
  constructor(config, subsystems, logger) {
    this.config = config;
    this.subsystems = subsystems;
    this.logger = logger;
    this.client = subsystems.client; // UnifiedClient with MCP access
  }

  /**
   * Main entry point: Plan and initialize guided mode
   * 
   * @param {Object} options - { forceNew: boolean }
   * @returns {Object} - Initial setup including agent missions AND task goals
   */
  async planMission(options = {}) {
    const { forceNew = false } = options;
    
    if (this.config.architecture?.roleSystem?.explorationMode !== 'guided') {
      this.logger?.debug('Not in guided mode, skipping planner');
      return null;
    }

    const guidedFocus = this.config.architecture?.roleSystem?.guidedFocus;
    if (!guidedFocus) {
      this.logger?.warn('Guided mode enabled but no guidedFocus config');
      return null;
    }

    const executionModeInfo = normalizeExecutionMode('guided', guidedFocus.executionMode);
    const executionMode = executionModeInfo.effectiveMode;

    this.logger?.info('');
    this.logger?.info('╔══════════════════════════════════════════════════════╗');
    this.logger?.info('║        GUIDED MODE PLANNER - MISSION SETUP           ║');
    this.logger?.info('╚══════════════════════════════════════════════════════╝');
    this.logger?.info('');
    this.logger?.info(`📋 Domain: ${guidedFocus.domain}`);
    this.logger?.info(`📋 Depth: ${guidedFocus.depth || 'normal'}`);
    this.logger?.info(`📋 Execution Mode: ${executionMode.toUpperCase()}`);
    this.logger?.info(`📋 Requested Legacy Mode: ${(executionModeInfo.requestedMode || 'strict').toUpperCase()}`);
    this.logger?.info('   Guided runs now execute through the exclusive planner path.');
    this.logger?.info('');

    // NEW: Check for existing plan FIRST (for resume support)
    // But skip if forceNew is true (when injecting a new plan)
    const stateStore = this.subsystems.clusterStateStore;
    const existingPlan = (!forceNew && stateStore) ? await stateStore.getPlan('plan:main') : null;
    
    // CRITICAL FIX (Jan 19, 2026): Check for active tasks using STATE STORE, not plan.tasks
    // Plan object doesn't include tasks array - tasks are stored separately in ClusterStateStore!
    let hasActiveTasks = false;
    let allTasks = [];
    let planIsComplete = false;
    
    if (existingPlan && stateStore) {
      try {
        // Query all tasks for this plan from state store
        allTasks = await stateStore.listTasks(existingPlan.id);
        
        // Check if any tasks are in active states
        hasActiveTasks = allTasks.some(t => 
          t.state === 'IN_PROGRESS' || 
          t.state === 'PENDING' || 
          t.state === 'CLAIMED' ||
          t.state === 'FAILED' ||   // PLAN INTEGRITY: Failed tasks are still active work (need retry)
          t.state === 'BLOCKED'     // PLAN INTEGRITY: Blocked tasks are still active work
        );
        
        // Check if plan is actually complete (all tasks DONE)
        const allTasksDone = allTasks.length > 0 && allTasks.every(t => t.state === 'DONE');
        
        // Check milestone completion
        let allMilestonesComplete = false;
        try {
          const allMilestones = await stateStore.listMilestones(existingPlan.id);
          allMilestonesComplete = allMilestones.length > 0 && 
            allMilestones.every(m => m.status === 'COMPLETED');
        } catch (error) {
          // Milestones might not exist yet
        }
        
        planIsComplete = allTasksDone && allMilestonesComplete;
        
        // If plan is complete but not marked, update it
        if (planIsComplete && existingPlan.status !== 'COMPLETED') {
          this.logger?.info('✅ Plan completion detected - updating status', {
            planId: existingPlan.id,
            tasksCompleted: allTasks.length
          });
          await stateStore.updatePlan(existingPlan.id, { 
            status: 'COMPLETED',
            completedAt: Date.now()
          });
          existingPlan.status = 'COMPLETED';
        }
      } catch (error) {
        this.logger?.warn('Failed to check plan/task status (will regenerate)', { 
          error: error.message 
        });
        // If we can't check status, safer to regenerate
        hasActiveTasks = false;
      }
    }
    
    const hasActiveAgents = this.subsystems?.agentExecutor?.registry?.getActiveCount() > 0;

    // Detect context/direction change (for continue with new focus)
    let contextRedirect = false;
    if (existingPlan && !forceNew) {
      const currentContext = (guidedFocus.context || '').trim();
      const planContext = (existingPlan._sourceContext || existingPlan.context || existingPlan.researchContext || '').trim();
      const currentDomain = (guidedFocus.domain || '').trim();
      const planDomain = (existingPlan._sourceDomain || existingPlan.title || '').trim();

      // Tier 1: Domain check (exact) — topic change is always a real direction change
      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      // Tier 2: Context check (semantic) — only if domain is same
      let contextChanged = false;
      if (!domainChanged && currentContext !== planContext) {
        contextChanged = await this._isContextDirectionChanged(planContext, currentContext, currentDomain);
      }

      if (domainChanged || contextChanged) {
        contextRedirect = true;
        this.logger?.info('🔄 Research direction changed on continue — will archive old plan and regenerate', {
          domainChanged,
          contextChanged,
          semantic: !domainChanged && contextChanged,
          oldDomain: planDomain.substring(0, 60),
          newDomain: currentDomain.substring(0, 60)
        });
      } else if (currentContext !== planContext) {
        this.logger?.info('📝 Context reworded but same direction — resuming existing plan', {
          oldContext: planContext.substring(0, 80),
          newContext: currentContext.substring(0, 80)
        });
      }
    }

    // Decision tree for resume vs regenerate vs complete
    if (existingPlan && existingPlan.status === 'ARCHIVED') {
      this.logger?.info('📋 Found archived plan - will generate new plan', {
        planId: existingPlan.id,
        archivedReason: existingPlan.archivedReason || 'unknown'
      });
      // Fall through to generate new plan
    } else if (existingPlan && (planIsComplete || existingPlan.status === 'COMPLETED') && !contextRedirect) {
      this.logger?.info('✅ Plan already completed - no new plan needed', {
        planId: existingPlan.id,
        tasksCompleted: allTasks.filter(t => t.state === 'DONE').length,
        totalTasks: allTasks.length
      });
      this.logger?.info('');
      this.logger?.info('✅ Guided mode planning complete (plan already finished)');
      this.logger?.info('');

      // Return indication that plan is complete
      return {
        taskPhases: [],
        executionMode,
        spawnAgents: false,
        planComplete: true
      };
    } else if (contextRedirect && existingPlan) {
      // Context/direction changed — archive old plan and regenerate with brain-informed context
      this.logger?.info('🔄 Archiving old plan to regenerate with new direction');
      await this._archiveExistingPlan(existingPlan, allTasks, stateStore, 'context_redirect');
      // Fall through to generate new plan (buildPlanningContext will query brain memory for new direction)
    } else if (existingPlan && existingPlan.status === 'ACTIVE' && (hasActiveTasks || hasActiveAgents)) {
      // PLAN INTEGRITY (Jan 20, 2026): Perform state-to-reality audit on resume
      await this.performStateAudit(existingPlan, allTasks, stateStore);

      this.logger?.info('📋 Resuming existing plan', {
        planId: existingPlan.id,
        title: existingPlan.title,
        version: existingPlan.version,
        milestones: existingPlan.milestones?.length || 0,
        activeTasks: allTasks.filter(t => ['PENDING', 'CLAIMED', 'IN_PROGRESS', 'FAILED', 'BLOCKED'].includes(t.state)).length,
        completedTasks: allTasks.filter(t => t.state === 'DONE').length,
        activeAgents: hasActiveAgents
      });
      this.logger?.info('⏭️  Skipping mission generation (continuing saved plan)');
      this.logger?.info('');
      this.logger?.info('✅ Guided mode planning complete (resumed)');
      this.logger?.info('');

      // Return minimal plan object for orchestrator
      return {
        taskPhases: [],
        executionMode,
        spawnAgents: false  // Don't spawn agents on resume
      };
    } else if (existingPlan && !hasActiveTasks && !hasActiveAgents) {
      this.logger?.warn('📋 Found plan with no active work - will regenerate', {
        planId: existingPlan.id,
        status: existingPlan.status,
        tasksFound: allTasks.length,
        completedTasks: allTasks.filter(t => t.state === 'DONE').length,
        reason: 'No PENDING/IN_PROGRESS/CLAIMED tasks and no active agents'
      });
      await this._archiveExistingPlan(existingPlan, allTasks, stateStore, 'no_active_work_regenerating');
      
      // Fall through to generate new plan
    }
    
    // Only generate plan if this is a NEW run
    this.logger?.info('📋 Generating new mission plan...');
    this.logger?.info('');

    // Analyze what resources are available
    const resources = await this.analyzeAvailableResources();
    
    // NEW: Parse structured task phases from context
    const taskPhases = this.parseTaskPhases(guidedFocus.context);
    
    if (taskPhases.length > 0) {
      this.logger?.info(`📋 Detected ${taskPhases.length} structured task phases`);
      taskPhases.forEach((phase, i) => {
        this.logger?.info(`   Phase ${i + 1}: ${phase.name}`);
      });
      this.logger?.info('');
    }
    
    // If task mentions specific files to read, read them via MCP before planning
    let filesRead = [];
    if (resources.mcp.tools.includes('read_file')) {
      filesRead = await this.readFilesIfNeeded(guidedFocus);
    }
    
    const planningContext = await this.buildPlanningContext(guidedFocus, { contextRedirect });
    // If context changed, override hasContext so the planner treats this as fresh
    if (contextRedirect) {
      planningContext.contextRedirect = true;
    }

    if (planningContext.threadAnchor) {
      this.logger?.info('🧵 Resuming research thread anchor', {
        source: planningContext.threadAnchor.source,
        similarity: planningContext.threadAnchor.similarity?.toFixed(2),
        title: planningContext.threadAnchor.title
      });
    }

    // Run PGS knowledge assessment for brain-aware planning (with timeout)
    const runPath = this.getLogsDir();
    let knowledgeAssessment = null;
    const assessmentTimeoutMs = 10 * 60 * 1000; // 10 minutes
    try {
      knowledgeAssessment = await Promise.race([
        this.assessKnowledgeState(guidedFocus, runPath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`PGS assessment timed out after ${assessmentTimeoutMs / 60000} minutes`)), assessmentTimeoutMs)
        )
      ]);
    } catch (err) {
      this.logger?.warn('Knowledge assessment failed (non-fatal)', { error: err.message });
    }

    // Attach to planning context for downstream use
    if (knowledgeAssessment) {
      planningContext.knowledgeAssessment = knowledgeAssessment;
      planningContext.assessmentPath = knowledgeAssessment.jsonPath;
    }

    if (planningContext.hasContext) {
      this.logger?.info('🧠 Brain-informed planning context loaded', {
        memoryMatches: planningContext.memoryMatches.length,
        completedTasks: planningContext.completedTasks.length,
        reviewGaps: planningContext.reviewGaps.length,
        processedSources: planningContext.processedSourceUrls.length
      });
    }

    let plan;
    try {
      // Generate mission plan (with file content if files were read)
      plan = await this.generateMissionPlan(guidedFocus, resources, filesRead, taskPhases, planningContext);
      await this.clearPlanningFailure();
    } catch (error) {
      await this.persistPlanningFailure('initial_plan', error, {
        domain: guidedFocus.domain,
        hasPlanningContext: planningContext.hasContext
      });
      throw error;
    }

    plan.executionMode = executionMode;
    plan.effectiveExecutionMode = executionMode;
    plan.requestedExecutionMode = executionModeInfo.requestedMode;
    plan.researchDigest = planningContext.researchDigest;

    if (knowledgeAssessment) {
      plan._planningAssessment = {
        path: knowledgeAssessment.jsonPath,
        timestamp: knowledgeAssessment.data.timestamp,
        nodeCount: knowledgeAssessment.data.nodeCount,
        partitionsSwept: knowledgeAssessment.data.partitionsSwept
      };
    }

    // Create Plan from task phases OR generated agent missions
    // (We already checked for existing plan above, so this is only for NEW runs)
    const phasesToUse = taskPhases.length > 0 ? taskPhases : 
      (plan.agentMissions || []).map((mission, idx) => {
        const desc = mission.description || mission.mission || mission.instructions || 'Generated mission';
        return {
          name: desc.substring(0, 100),
          description: desc,
          deliverables: mission.expectedOutput ? [mission.expectedOutput] : []
        };
      });
    
    // Mission→goalId mapping for task→goal→agent linkage.
    // IMPORTANT: This must be consistent between:
    // - tasks persisted in the plan (metadata.goalId)
    // - agents spawned by GuidedModePlanner (missionSpec.goalId)
    // If these diverge, PlanScheduler cannot detect "goal already pursued" and will spawn duplicates.
    let missionGoalIds = null;

    // DEBUG: Log why structured plan might not be saved
    this.logger?.info(`📋 Structured plan check: phasesToUse=${phasesToUse.length}, stateStore=${!!stateStore}`);
    if (phasesToUse.length === 0) {
      this.logger?.warn('⚠️  No phases to persist - structured plan will NOT be saved!');
    }
    if (!stateStore) {
      this.logger?.warn('⚠️  No state store available - structured plan will NOT be saved!');
    }

    if (phasesToUse.length > 0 && stateStore) {
      this.logger?.info(`📋 Creating Plan from ${phasesToUse.length} ${taskPhases.length > 0 ? 'explicit phases' : 'generated missions'}`);
      
      // Create Plan
      const guidedPlan = {
        id: 'plan:main',  // Use plan:main so orchestrator picks it up
        title: guidedFocus.domain,
        context: guidedFocus.context || '',
        researchDomain: planningContext.threadAnchor?.title || guidedFocus.researchDomain || guidedFocus.domain,
        researchContext: guidedFocus.researchContext || guidedFocus.context || '',
        // Stamp source context/domain for continuation context-change detection
        _sourceContext: (guidedFocus?.context || '').trim(),
        _sourceDomain: (guidedFocus?.domain || '').trim(),
        version: 1,
        status: 'ACTIVE',
        milestones: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      
      // Create Milestones
      const milestones = phasesToUse.map((phase, idx) => ({
        id: `ms:phase${idx + 1}`,
        planId: guidedPlan.id,
        title: phase.name,
        order: idx + 1,
        status: idx === 0 ? 'ACTIVE' : 'LOCKED',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }));
      
      guidedPlan.milestones = milestones.map(m => m.id);
      guidedPlan.activeMilestone = milestones[0].id;
      
      // Create Tasks
      // Store mission→goalId mapping for later
      const baseTimestamp = Date.now();
      missionGoalIds = (plan.agentMissions || []).map((mission, idx) => ({
        missionIdx: idx,
        missionType: mission.type,
        goalId: `goal_guided_${mission.type}_${baseTimestamp + idx}`
      }));
      
      const tasks = phasesToUse.map((phase, idx) => {
        const correspondingMission = Array.isArray(plan.agentMissions) ? plan.agentMissions[idx] : null;

        // AGENT TYPE DETERMINATION (Mar 22, 2026)
        // Trust the LLM-generated mission type when it's a known agent type.
        // Fall back to keyword-based inference only when no valid type is specified.
        const VALID_AGENT_TYPES = [
          'research', 'ide', 'dataacquisition', 'datapipeline', 'infrastructure', 'automation',
          'analysis', 'synthesis', 'exploration', 'planning', 'code_execution', 'code_creation',
          'document_creation', 'document_analysis', 'document_compiler', 'codebase_exploration',
          'quality_assurance', 'completion', 'consistency', 'disconfirmation', 'integration',
          'specialized_binary'
        ];
        const missionType = correspondingMission?.type || correspondingMission?.agentType;
        const agentType = (missionType && VALID_AGENT_TYPES.includes(missionType))
          ? missionType
          : this.determineAgentTypeForPhase(phase);
        
        return {
          id: `task:phase${idx + 1}`,
          planId: guidedPlan.id,
          milestoneId: milestones[idx].id,
          title: phase.name,
          description: phase.description || guidedFocus.context,
          tags: [guidedFocus.domain, 'guided', 'sequential'],
          deps: idx > 0 ? [`task:phase${idx}`] : [], // Sequential dependency
          priority: 10, // High priority for guided tasks
          state: 'PENDING',
          acceptanceCriteria: this.generateAcceptanceCriteria(phase),
          artifacts: [],
          metadata: {
            // NO goalId - tasks execute directly via taskId
            agentType: agentType,
            spawningSource: 'guided_mode',
            baseTimestamp: baseTimestamp,
            phaseNumber: idx + 1,  // Store phase number for logging
            guidedMission: true,
            sourceScope: correspondingMission?.sourceScope || correspondingMission?.metadata?.sourceScope || null,
            artifactInputs: correspondingMission?.artifactInputs || correspondingMission?.metadata?.artifactInputs || [],
            expectedOutput: correspondingMission?.expectedOutput || correspondingMission?.metadata?.expectedOutput || null,
            researchDigest: plan.researchDigest || null
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      });
      
      // NEW: Add synthesis task if deliverable requires assembly
      const needsSynthesis = this.deliverableRequiresSynthesis(plan.deliverable, phasesToUse);
      
      // ✅ FIX P1.3: Check if synthesis task already exists before creating
      // Prevents synthesis loop when plans are re-injected
      let shouldCreateSynthesis = needsSynthesis;
      
      if (needsSynthesis && stateStore) {
        try {
          const existingSynthesis = await stateStore.getTask('task:synthesis_final');
          
          if (existingSynthesis) {
            const taskState = existingSynthesis.state;
            const isActive = ['PENDING', 'CLAIMED', 'IN_PROGRESS'].includes(taskState);
            const isDone = taskState === 'DONE';
            const isFailed = taskState === 'FAILED';
            
            if (isActive) {
              // Task exists and is actively being worked on - don't recreate
              this.logger?.info('⏭️  Synthesis task already active, skipping creation', {
                taskId: 'task:synthesis_final',
                state: taskState,
                assignedAgent: existingSynthesis.assignedAgentId
              });
              shouldCreateSynthesis = false;
            } else if (isDone) {
              // Task completed - don't recreate
              this.logger?.info('✅ Synthesis task already completed, skipping creation', {
                taskId: 'task:synthesis_final',
                completedAt: existingSynthesis.updatedAt
              });
              shouldCreateSynthesis = false;
            } else if (isFailed) {
              // Task failed - allow recreation with potential fixes
              this.logger?.warn('🔄 Synthesis task failed previously, will recreate with fresh attempt', {
                taskId: 'task:synthesis_final',
                failureReason: existingSynthesis.failureReason,
                failedAt: existingSynthesis.updatedAt
              });
              
              // Archive the failed attempt before recreating
              existingSynthesis.state = 'ARCHIVED';
              existingSynthesis.archivedReason = 'failed_synthesis_recreated';
              existingSynthesis.archivedAt = Date.now();
              await stateStore.upsertTask(existingSynthesis);
              
              shouldCreateSynthesis = true;  // Allow recreation
            }
          } else {
            // Task doesn't exist - safe to create
            shouldCreateSynthesis = true;
          }
        } catch (error) {
          // Task doesn't exist or error reading - safe to create
          this.logger?.debug('Synthesis task check failed, will create', { 
            error: error.message 
          });
          shouldCreateSynthesis = true;
        }
      }
      
      if (shouldCreateSynthesis) {
        const synthesisTask = {
          id: `task:synthesis_final`,
          planId: guidedPlan.id,
          milestoneId: milestones[milestones.length - 1].id, // Same milestone as last phase
          title: 'Assemble Final Deliverable',
          description: `Combine all phase outputs into final ${plan.deliverable.type || 'document'} deliverable: ${plan.deliverable.filename || 'output'}. Required sections: ${plan.deliverable.requiredSections?.join(', ') || 'all phase outputs'}. ${plan.deliverable.minimumContent || ''}`,
          tags: [guidedFocus.domain, 'guided', 'synthesis', 'final_deliverable'],
          deps: tasks.map(t => t.id), // Depends on ALL previous tasks
          priority: 11, // Higher than phase tasks to ensure it runs last
          state: 'PENDING',
          acceptanceCriteria: [{
            type: 'qa',
            rubric: `Final deliverable exists at ${plan.deliverable.location || 'runtime/outputs/'}${plan.deliverable.filename || 'output'} and contains all required sections with minimum content requirements met`,
            threshold: 0.9
          }],
          artifacts: [],
          metadata: {
            isFinalSynthesis: true,
            inputTasks: tasks.map(t => t.id),
            deliverableSpec: plan.deliverable
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        
        tasks.push(synthesisTask);
        
        this.logger?.info('📦 Final synthesis task added to plan', {
          taskId: synthesisTask.id,
          dependsOn: synthesisTask.deps.length,
          deliverableType: plan.deliverable.type
        });
      }  // Close shouldCreateSynthesis block
      
      // Persist to state store
      await stateStore.createPlan(guidedPlan);
      for (const milestone of milestones) {
        await stateStore.upsertMilestone(milestone);
      }
      for (const task of tasks) {
        await stateStore.upsertTask(task);
      }
      
      this.logger?.info('✅ Plan initialized from guided mode', {
        tasks: tasks.length,
        milestones: milestones.length,
        source: taskPhases.length > 0 ? 'explicit_phases' : 'generated_missions'
      });
    }
    
    this.logger?.info('');
    this.logger?.info('✅ Guided mode planning complete');
    this.logger?.info(`   Task phases: ${taskPhases.length}`);
    this.logger?.info(`   Execution mode: ${executionMode}`);
    this.logger?.info('');

    // Prepare missionGoalIds for deferred spawning (after plan is displayed)
    const missionGoalIdsToUse = missionGoalIds || (plan.agentMissions || []).map((mission, idx) => ({
      missionIdx: idx,
      missionType: mission.type,
      goalId: `goal_guided_${mission.type}_${Date.now() + idx}`
    }));

    // Store for deferred spawning - agents will be spawned AFTER plan is displayed
    plan._deferredSpawn = {
      shouldSpawn: plan.spawnAgents && plan.agentMissions?.length > 0,
      missionGoalIds: missionGoalIdsToUse
    };

    return {
      ...plan,
      taskPhases,
      executionMode,
      planningContext
    };
  }

  /**
   * Run a deep PGS sweep to assess what the brain already knows.
   * Used to generate delta plans that skip well-covered topics.
   * This can take 2-5 minutes for large brains — runs during startup, not in cycle loop.
   *
   * @param {Object} guidedFocus - { domain, context }
   * @param {string} runPath - Path to the run directory (state.json.gz, coordinator/, etc.)
   * @returns {Promise<Object|null>} Assessment result { answer, data, jsonPath, mdPath }, or null on failure
   */
  async assessKnowledgeState(guidedFocus, runPath) {
    this.logger?.info('');
    this.logger?.info('🧠 Assessing brain knowledge state via PGS deep sweep...');
    this.logger?.info('   This may take a few minutes for large brains.');
    this.logger?.info('');

    try {
      // Construct simple assessment query from domain + context
      const contextSummary = (guidedFocus.context || '').substring(0, 200);
      const query = `Comprehensive knowledge assessment for "${guidedFocus.domain}": ` +
        `What do we know? What topics are well-covered? What's missing or shallow? ` +
        `What deliverables (databases, reports, files) exist? ` +
        (contextSummary ? `Research context: ${contextSummary}` : '');

      // Instantiate PGS engine
      const openaiKey = process.env.OPENAI_API_KEY || null;
      const queryEngine = new QueryEngine(runPath, openaiKey);
      const pgsEngine = new PGSEngine(queryEngine);

      // Configure for routed sweep (relevance-filtered, not full coverage)
      const sweepModel = this.config.models?.fast || this.config.models?.primary;
      const synthesisModel = this.config.models?.strategicModel || this.config.models?.primary;

      // Execute PGS sweep — routed partitions only (not full sweep)
      // Full sweep on large brains (100+ partitions) can take 15+ minutes.
      // Routed sweep covers the most relevant partitions, which is sufficient
      // for delta planning (identifying what's known vs. what's missing).
      const assessment = await pgsEngine.execute(query, {
        model: synthesisModel,
        pgsFullSweep: false,
        pgsSweepModel: sweepModel,
        enableSynthesis: true,
        includeCoordinatorInsights: true,
        onChunk: (event) => {
          if (event.type === 'progress') {
            this.logger?.info(`   📊 PGS: ${event.message}`);
          } else if (event.type === 'pgs_phase') {
            this.logger?.info(`   📊 PGS Phase: ${event.message}`);
          }
        }
      });

      if (!assessment || !assessment.answer) {
        this.logger?.warn('PGS assessment returned empty result');
        return null;
      }

      this.logger?.info('✅ PGS knowledge assessment complete');

      // Save assessment artifacts
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const coordinatorDir = path.join(runPath, 'coordinator');
      await fs.mkdir(coordinatorDir, { recursive: true });

      // Save JSON (structured data)
      const assessmentData = {
        timestamp: new Date().toISOString(),
        query,
        domain: guidedFocus.domain,
        context: guidedFocus.context,
        nodeCount: assessment.metadata?.totalNodes || 0,
        partitionsSwept: assessment.metadata?.partitionsSwept || 0,
        answer: assessment.answer,
        sweepResults: assessment.sweepResults || [],
        metadata: assessment.metadata || {}
      };
      const jsonPath = path.join(coordinatorDir, `planning-assessment-${timestamp}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(assessmentData, null, 2), 'utf8');

      // Save Markdown (human-readable)
      const mdContent = `# Planning Assessment — ${guidedFocus.domain}\n\n` +
        `**Generated:** ${new Date().toISOString()}\n` +
        `**Query:** ${query}\n` +
        `**Nodes:** ${assessmentData.nodeCount} | **Partitions Swept:** ${assessmentData.partitionsSwept}\n\n` +
        `---\n\n${assessment.answer}`;
      const mdPath = path.join(coordinatorDir, `planning-assessment-${timestamp}.md`);
      await fs.writeFile(mdPath, mdContent, 'utf8');

      this.logger?.info(`   📄 Assessment saved: ${path.basename(jsonPath)}`);

      // Store as memory node if memory system available
      if (this.subsystems?.memory) {
        try {
          await this.subsystems.memory.addNode(
            `[PLANNING ASSESSMENT] ${(assessment.answer || '').substring(0, 500)}`,
            'planning_assessment'
          );
        } catch (memErr) {
          this.logger?.debug('Failed to store assessment in memory (non-fatal)', { error: memErr.message });
        }
      }

      return {
        answer: assessment.answer,
        data: assessmentData,
        jsonPath,
        mdPath
      };
    } catch (err) {
      this.logger?.warn('⚠️ PGS knowledge assessment failed (will plan without it)', {
        error: err.message
      });
      return null;
    }
  }

  /**
   * Execute deferred agent spawning after plan is displayed
   * Called from index.js AFTER plan presentation
   *
   * @param {Object} plan - The plan with _deferredSpawn data
   */
  async executeDeferredSpawn(plan) {
    if (!plan?._deferredSpawn?.shouldSpawn) {
      this.logger?.info('ℹ️  No agents to spawn (plan did not request agent spawning)');
      return []; // Return empty array for consistency
    }

    this.logger?.info('');
    this.logger?.info('🚀 Spawning agents as per plan...');
    const agentIds = await this.spawnInitialAgents(plan, plan._deferredSpawn.missionGoalIds);
    this.logger?.info('');

    // Emit planning agents spawned event
    if (this.subsystems.eventEmitter) {
      this.subsystems.eventEmitter.emit('planning_agents_spawned', {
        agentIds: agentIds,
        planId: plan.id,
        timestamp: new Date().toISOString()
      });
    }

    return agentIds; // Return agent IDs for waiting
  }

  /**
   * Determine agent type for a phase/task
   * Simple logic - research agent for web research, IDE agent for everything else
   * 
   * This matches the PlanExecutor's determineAgentType logic for consistency
   * 
   * @param {Object} phase - Phase object with name and description
   * @returns {string} - 'research' or 'ide'
   */
  determineAgentTypeForPhase(phase) {
    const text = `${phase.name} ${phase.description || ''}`.toLowerCase();

    // Execution agent type detection (before research/ide fallback)
    const needsDataAcquisition = text.includes('scrape') || text.includes('crawl') || text.includes('download data');
    const needsDataPipeline = (text.includes('database') && (text.includes('create') || text.includes('build'))) || text.includes('etl');
    const needsInfrastructure = text.includes('container') || text.includes('docker') || text.includes('provision');
    const needsAutomation = text.includes('automate') || text.includes('batch process');

    if (needsDataAcquisition) return 'dataacquisition';
    if (needsDataPipeline) return 'datapipeline';
    if (needsInfrastructure) return 'infrastructure';
    if (needsAutomation) return 'automation';

    // Explicit web research indicators
    const needsWeb =
      (text.includes('research') && !text.includes('research the codebase') && !text.includes('research code')) ||
      text.includes('find sources') ||
      text.includes('gather sources') ||
      text.includes('search online') ||
      text.includes('web search') ||
      text.includes('look up online') ||
      text.includes('current information') ||
      text.includes('latest information') ||
      text.includes('external sources') ||
      text.includes('find information about') ||
      text.includes('bibliography') ||
      text.includes('literature review');

    const agentType = needsWeb ? 'research' : 'ide';

    this.logger?.debug(`GuidedModePlanner: Phase "${phase.name}" → ${agentType} agent`, {
      needsWeb,
      reason: needsWeb ? 'Web research keywords' : 'Filesystem/code work'
    }, 3);

    return agentType;
  }

  /**
   * Determine if deliverable requires synthesis of multiple artifacts
   * 
   * @param {Object} deliverableSpec - Deliverable specification from plan
   * @param {Array} phases - Task phases
   * @returns {boolean} - True if synthesis task should be added
   */
  deliverableRequiresSynthesis(deliverableSpec, phases) {
    if (!deliverableSpec) return false;
    
    // If deliverable has required sections AND multiple phases generate separate outputs
    if (deliverableSpec.requiredSections && 
        deliverableSpec.requiredSections.length > 1 && 
        phases.length > 1) {
      return true;
    }
    
    // If deliverable explicitly mentions combining/assembling
    const description = (deliverableSpec.minimumContent || '').toLowerCase();
    if (description.includes('combine') || 
        description.includes('assemble') || 
        description.includes('integrate') ||
        description.includes('synthesize')) {
      return true;
    }
    
    // If minimum content suggests narrative across phases
    if (deliverableSpec.minimumContent && 
        deliverableSpec.minimumContent.includes('words') && 
        phases.length > 2) {
      return true;
    }
    
    return false;
  }

  /**
   * Generate acceptance criteria for a phase
   * 
   * Creates requirements for:
   * - Specific file formats (with flexibility)
   * - Quality checks via QA agent
   * - Completeness metrics
   */
  generateAcceptanceCriteria(phase) {
    const criteria = [];
    
    // Extract deliverable requirements from description
    const desc = (phase.description || phase.name || '').toLowerCase();
    const deliverables = phase.deliverables || [];
    const fullText = desc + ' ' + deliverables.join(' ');
    
    // Check for common deliverable patterns
    if (fullText.includes('bibliography') || fullText.includes('sources') || fullText.includes('literature')) {
      criteria.push({
        type: 'qa',
        rubric: 'Contains a curated bibliography or literature corpus with >=50 sources, including metadata (title, authors, year, DOI/URL). Format can be CSV, JSON, or structured markdown table.',
        threshold: 0.7
      });
    }
    
    if (fullText.includes('taxonomy') || fullText.includes('classification') || fullText.includes('catalog')) {
      criteria.push({
        type: 'qa',
        rubric: 'Provides a structured taxonomy or classification system with clear categories, definitions, and examples. Format can be JSON, CSV, or markdown with clear structure.',
        threshold: 0.7
      });
    }
    
    if (fullText.includes('code') || fullText.includes('simulation') || fullText.includes('model') || fullText.includes('notebook')) {
      criteria.push({
        type: 'qa',
        rubric: 'Includes executable code (Python script or Jupyter notebook) with clear documentation, parameters, and example outputs. Code should be runnable and produce expected results.',
        threshold: 0.8
      });
    }
    
    if (fullText.includes('report') || fullText.includes('document') || fullText.includes('synthesis')) {
      criteria.push({
        type: 'qa',
        rubric: 'Provides a comprehensive report document (markdown) with required sections, citations, and analysis. Minimum 1500 words with substantive content.',
        threshold: 0.7
      });
    }
    
    if (fullText.includes('visualization') || fullText.includes('plot') || fullText.includes('figure')) {
      criteria.push({
        type: 'qa',
        rubric: 'Includes data visualizations or figures (PNG, SVG, or described in detail) that effectively communicate findings.',
        threshold: 0.7
      });
    }
    
    // If no specific patterns detected, use general completion check
    if (criteria.length === 0) {
      criteria.push({
        type: 'qa',
        rubric: `Phase "${phase.name}" objectives completed with evidence of substantive work and deliverables`,
        threshold: 0.8
      });
    }
    
    return criteria;
  }

  /**
   * Perform a state-to-reality audit to unblock plans
   * 
   * PLAN INTEGRITY (Jan 20, 2026):
   * 1. Reads cosmo-progress.md to see what the human thinks is done
   * 2. Scans @outputs for actual deliverables
   * 3. Repairs task states to match reality
   */

  /**
   * Determine if the research direction has meaningfully changed.
   * Uses semantic LLM check instead of exact string comparison.
   * @param {string} oldContext - Previous plan's context
   * @param {string} newContext - Current launch context
   * @param {string} domain - Research domain
   * @returns {Promise<boolean>} true if direction actually changed
   */
  async _isContextDirectionChanged(oldContext, newContext, domain) {
    // Fast path: identical strings = no change
    if (oldContext === newContext) return false;

    // Fast path: one is empty = changed
    if (!oldContext || !newContext) return true;

    try {
      const response = await this.client.generate({
        component: 'planner',
        purpose: 'context_comparison',
        model: this.config.models?.fast,
        instructions: 'You compare research directions. Answer ONLY "same" or "different". No explanation.',
        messages: [{
          role: 'user',
          content: `Domain: ${domain}\n\nPrevious direction: ${oldContext.substring(0, 500)}\nCurrent direction: ${newContext.substring(0, 500)}\n\nIs this a meaningfully DIFFERENT research direction, or just a rewording/refinement of the same work?\nAnswer ONLY "same" or "different".`
        }],
        maxTokens: 10,
        reasoningEffort: 'low'
      });

      const answer = (response.content || '').trim().toLowerCase();
      return answer.includes('different');
    } catch (err) {
      this.logger?.warn('Semantic context comparison failed, falling back to exact match', {
        error: err.message
      });
      // Fallback: exact string comparison (current behavior)
      return oldContext !== newContext;
    }
  }

  async _archiveExistingPlan(existingPlan, allTasks, stateStore, reason = 'context_redirect') {
    if (!stateStore) return;

    try {
      // Archive all tasks
      for (const task of allTasks) {
        try {
          await stateStore.upsertTask({
            ...task,
            state: 'ARCHIVED',
            archivedAt: Date.now(),
            archivedReason: reason
          });
        } catch (taskError) {
          this.logger?.warn('Failed to archive task', { taskId: task.id, error: taskError.message });
        }
      }

      // Archive all milestones
      try {
        const milestones = await stateStore.listMilestones(existingPlan.id);
        for (const milestone of milestones) {
          await stateStore.upsertMilestone({
            ...milestone,
            status: 'ARCHIVED',
            archivedAt: Date.now(),
            archivedReason: reason
          });
        }
      } catch (milestoneError) {
        this.logger?.warn('Failed to archive milestones', { error: milestoneError.message });
      }

      // Archive the plan
      await stateStore.updatePlan(existingPlan.id, {
        status: 'ARCHIVED',
        archivedAt: Date.now(),
        archivedReason: reason
      });

      this.logger?.info('📦 Archived existing plan and tasks', {
        planId: existingPlan.id,
        title: existingPlan.title,
        reason,
        tasksArchived: allTasks.length
      });
    } catch (error) {
      this.logger?.warn('Failed to archive old plan', { error: error.message });
    }
  }

  async performStateAudit(plan, tasks, stateStore) {
    this.logger?.info('🔍 Performing state-to-reality audit...');
    
    try {
      const runtimePath = this.config.runtimePath;
      if (!runtimePath) return;

      // 1. Audit Progress Log
      const progressPath = path.join(runtimePath, 'cosmo-progress.md');
      let progressContent = '';
      try {
        progressContent = await fs.readFile(progressPath, 'utf8');
      } catch (e) { /* no progress file yet */ }

      // 2. Audit Outputs
      const outputsDir = path.join(runtimePath, 'outputs');
      let outputs = [];
      try {
        outputs = await fs.readdir(outputsDir, { recursive: true });
      } catch (e) { /* no outputs yet */ }

      let repairs = 0;

      for (const task of tasks) {
        if (task.state === 'DONE') continue;

        // Check if task deliverables exist in outputs
        const criteria = task.acceptanceCriteria || [];
        const fileCriteria = criteria.filter(c => c.type === 'qa' && c.rubric.match(/exists at (?:@outputs\/)?([a-z0-9_\-\./]+)/i));
        
        let filesFound = false;
        for (const criterion of fileCriteria) {
          const match = criterion.rubric.match(/exists at (?:@outputs\/)?([a-z0-9_\-\./]+)/i);
          if (match && match[1]) {
            const filename = match[1];
            if (outputs.some(o => o.includes(filename))) {
              filesFound = true;
              break;
            }
          }
        }

        // Check if progress log mentions completion
        const phaseNumber = task.id.match(/phase(\d+)/)?.[1];
        const isPhaseDoneInLog = phaseNumber && progressContent.includes(`Phase ${phaseNumber} complete`);
        
        // REPAIR: If reality says it's done but state doesn't, mark it DONE
        if (filesFound || isPhaseDoneInLog) {
          this.logger?.info(`🔧 Audit found completed work for ${task.id} - repairing state to DONE`, {
            filesFound,
            isPhaseDoneInLog
          });
          await stateStore.completeTask(task.id);
          task.state = 'DONE'; // Update local copy
          repairs++;
        }
      }

      if (repairs > 0) {
        this.logger?.info(`✅ Audit complete: ${repairs} state repairs performed`);
      } else {
        this.logger?.info('✅ Audit complete: state matches reality');
      }
    } catch (error) {
      this.logger?.error('❌ Audit failed (non-fatal)', { error: error.message });
    }
  }

  getLogsDir() {
    return this.config.logsDir || this.config.runtimeRoot || this.config.runtimePath || path.join(process.cwd(), 'runtime');
  }

  summarizeText(text, maxLength = 220) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }

    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3)}...`
      : normalized;
  }

  normalizeThreadText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  calculateThreadSimilarity(a, b) {
    const aTokens = new Set(this.normalizeThreadText(a).split(' ').filter(token => token.length >= 3));
    const bTokens = new Set(this.normalizeThreadText(b).split(' ').filter(token => token.length >= 3));

    if (aTokens.size === 0 || bTokens.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const token of aTokens) {
      if (bTokens.has(token)) {
        intersection += 1;
      }
    }

    const union = new Set([...aTokens, ...bTokens]).size;
    return union === 0 ? 0 : intersection / union;
  }

  async readJsonIfExists(filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      return null;
    }
  }

  async persistPlanningFailure(stage, error, context = {}) {
    const payload = {
      status: 'error',
      stage,
      error: error?.message || String(error),
      details: context,
      timestamp: new Date().toISOString()
    };

    const stateStore = this.subsystems.clusterStateStore;
    if (stateStore) {
      await stateStore.set('guided_planner_status', payload).catch(() => {});
    }

    const metadataDir = path.join(this.getLogsDir(), 'metadata');
    await fs.mkdir(metadataDir, { recursive: true }).catch(() => {});
    await fs.writeFile(
      path.join(metadataDir, 'guided-planner-status.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    ).catch(() => {});

    this.logger?.error('❌ Guided planner failure persisted', {
      stage,
      error: payload.error
    });
  }

  async clearPlanningFailure() {
    const stateStore = this.subsystems.clusterStateStore;
    if (stateStore) {
      await stateStore.set('guided_planner_status', {
        status: 'ok',
        clearedAt: new Date().toISOString()
      }).catch(() => {});
    }
  }

  extractReviewSignals(reviewContent, limit = 8) {
    const lines = String(reviewContent || '')
      .split('\n')
      .map(line => this.summarizeText(line, 220))
      .filter(Boolean);

    const gapPatterns = [
      /open question/i,
      /unresolved/i,
      /uncertain/i,
      /\bgap\b/i,
      /needs (more|further|additional)/i,
      /future work/i,
      /next step/i,
      /missing/i,
      /contradict/i
    ];

    const filtered = filterDomainRelevant(lines);
    return [...new Set(filtered.filter(line => gapPatterns.some(pattern => pattern.test(line))))].slice(0, limit);
  }

  async readArchivedPlans() {
    const plansDir = path.join(this.getLogsDir(), 'plans');

    try {
      const entries = await fs.readdir(plansDir);
      const archivedFiles = entries
        .filter(name => /^plan:main(?:_file)?_archived_\d+\.json$/.test(name))
        .sort((a, b) => {
          const aNum = Number(a.match(/_(\d+)\.json$/)?.[1] || 0);
          const bNum = Number(b.match(/_(\d+)\.json$/)?.[1] || 0);
          return bNum - aNum;
        });

      const plans = [];
      for (const file of archivedFiles) {
        const plan = await this.readJsonIfExists(path.join(plansDir, file));
        if (plan) {
          plans.push({ ...plan, _sourceFile: file });
        }
      }

      return plans;
    } catch (error) {
      return [];
    }
  }

  async findMatchingThreadAnchor(guidedFocus) {
    const stateStore = this.subsystems.clusterStateStore;
    const requestedThread = `${guidedFocus.domain || ''} ${guidedFocus.context || ''}`.trim();
    const candidates = [];

    if (stateStore) {
      const currentPlan = await stateStore.getPlan('plan:main').catch(() => null);
      if (currentPlan) {
        candidates.push({
          source: 'active_plan',
          title: currentPlan.title,
          context: currentPlan.context || '',
          status: currentPlan.status
        });
      }
    }

    const archivedPlans = await this.readArchivedPlans();
    for (const plan of archivedPlans.slice(0, 10)) {
      candidates.push({
        source: `archived:${plan._sourceFile}`,
        title: plan.title,
        context: plan.context || '',
        status: plan.status
      });
    }

    const runtimeMetadata = await this.readJsonIfExists(path.join(this.getLogsDir(), 'run-metadata.json'));
    if (runtimeMetadata?.researchDomain || runtimeMetadata?.researchContext) {
      candidates.push({
        source: 'run_metadata',
        title: runtimeMetadata.researchDomain || runtimeMetadata.domain,
        context: runtimeMetadata.researchContext || runtimeMetadata.context || '',
        status: 'metadata'
      });
    }

    const scored = candidates
      .map(candidate => ({
        ...candidate,
        similarity: this.calculateThreadSimilarity(
          requestedThread,
          `${candidate.title || ''} ${candidate.context || ''}`.trim()
        )
      }))
      .sort((a, b) => b.similarity - a.similarity);

    return scored[0]?.similarity >= 0.45 ? scored[0] : null;
  }

  collectResultHistory() {
    const resultsQueue = this.subsystems.agentExecutor?.resultsQueue;
    if (!resultsQueue) {
      return [];
    }

    const queue = Array.isArray(resultsQueue.queue) ? resultsQueue.queue : [];
    const history = Array.isArray(resultsQueue.history) ? resultsQueue.history : [];
    const processed = Array.isArray(resultsQueue.processed) ? resultsQueue.processed : [];

    return [...history, ...processed, ...queue];
  }

  async collectCompletedTaskSummaries(planId = 'plan:main') {
    const stateStore = this.subsystems.clusterStateStore;
    if (!stateStore) {
      return [];
    }

    try {
      const tasks = await stateStore.listTasks(planId);
      return tasks
        .filter(task => task.state === 'DONE')
        .map(task => ({
          taskId: task.id,
          summary: this.summarizeText(`${task.title}: ${task.description || ''}`, 180),
          artifacts: Array.isArray(task.artifacts) ? task.artifacts.slice(0, 8) : []
        }));
    } catch (error) {
      return [];
    }
  }

  collectRecentFindings(limit = 12) {
    const memoryNodes = this.subsystems.memory?.nodes instanceof Map
      ? Array.from(this.subsystems.memory.nodes.values())
      : [];

    return filterDomainRelevant(
      memoryNodes
        .filter(node => node?.concept)
        .sort((a, b) => (
          (b.updated || b.accessed || b.created || 0) -
          (a.updated || a.accessed || a.created || 0)
        ))
        .map(node => this.summarizeText(node.concept, 180))
    ).slice(0, limit);
  }

  collectActiveGoals(limit = 8) {
    const goalList = Array.isArray(this.subsystems.goals?.getGoals?.())
      ? this.subsystems.goals.getGoals()
      : [];

    return filterDomainRelevant(
      goalList
        .filter(goal => goal && goal.description)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .map(goal => `${this.summarizeText(goal.description, 160)} (priority ${(goal.priority || 0).toFixed(2)})`)
    ).slice(0, limit);
  }

  async collectLatestCoordinatorReview() {
    const coordinatorDir = path.join(this.getLogsDir(), 'coordinator');
    const latestPath = path.join(coordinatorDir, 'insights_curated_LATEST.md');
    const reviewFiles = [];

    try {
      const latestContent = await fs.readFile(latestPath, 'utf8');
      reviewFiles.push({
        source: 'insights_curated_LATEST.md',
        content: latestContent
      });
    } catch (error) {
      try {
        const files = await fs.readdir(coordinatorDir);
        const matches = files
          .filter(file => /^insights_curated_cycle_\d+_.*\.md$/.test(file))
          .sort()
          .reverse()
          .slice(0, 1);
        for (const file of matches) {
          reviewFiles.push({
            source: file,
            content: await fs.readFile(path.join(coordinatorDir, file), 'utf8')
          });
        }
      } catch (_) {}
    }

    const latest = reviewFiles[0] || null;
    return latest
      ? {
          ...latest,
          gaps: this.extractReviewSignals(latest.content)
        }
      : null;
  }

  async collectProcessedSourceUrls() {
    const stateStore = this.subsystems.clusterStateStore;
    if (!stateStore) {
      return [];
    }

    const sourceIndex = await stateStore.get('research_source_index').catch(() => null);
    return Array.isArray(sourceIndex?.urls) ? sourceIndex.urls.slice(0, 50) : [];
  }

  buildResearchDigest(planningContext = {}) {
    const topFindings = [
      ...(planningContext.memoryMatches || []).map(match => match.summary),
      ...(planningContext.recentFindings || [])
    ]
      .filter(Boolean)
      .slice(0, 50);

    const completedMissions = (planningContext.completedTasks || []).map(task => task.summary).slice(0, 20);
    const taskArtifactRefs = (planningContext.completedTasks || [])
      .flatMap(task => Array.isArray(task.artifacts) ? task.artifacts : [])
      .filter(Boolean);
    const handoffArtifactRefs = (planningContext.handoffArtifactRefs || []).filter(Boolean);
    const artifactRefs = [...taskArtifactRefs, ...handoffArtifactRefs].slice(0, 50);

    return {
      topFindings,
      completedMissions,
      priorityGaps: planningContext.reviewGaps || [],
      artifactRefs,
      processedSourceUrls: planningContext.processedSourceUrls || []
    };
  }

  async buildPlanningContext(guidedFocus, options = {}) {
    const threadAnchor = await this.findMatchingThreadAnchor(guidedFocus);
    const memoryMatches = this.subsystems.memory?.query
      ? await this.subsystems.memory.query(`${guidedFocus.domain || ''} ${guidedFocus.context || ''}`.trim(), 12).catch(() => [])
      : [];
    const completedTasks = await this.collectCompletedTaskSummaries('plan:main');
    const latestReview = await this.collectLatestCoordinatorReview();
    const recentFindings = this.collectRecentFindings();
    const activeGoals = this.collectActiveGoals();
    const processedSourceUrls = await this.collectProcessedSourceUrls();
    const resultHistory = this.collectResultHistory()
      .filter(item => item?.status && String(item.status).startsWith('completed'))
      .slice(-12);

    const planningContext = {
      threadAnchor,
      memoryMatches: (memoryMatches || []).map(match => ({
        similarity: match.similarity || 0,
        summary: this.summarizeText(match.content || match.concept || match.label || '', 180)
      })),
      completedTasks,
      latestReview,
      reviewGaps: latestReview?.gaps || [],
      recentFindings,
      activeGoals,
      processedSourceUrls,
      priorMissionSummaries: resultHistory
        .map(item => this.summarizeText(item.mission?.description || '', 180))
        .filter(Boolean),
      handoffArtifactRefs: resultHistory
        .flatMap(item => Array.isArray(item.handoffSpec?.artifactRefs) ? item.handoffSpec.artifactRefs : [])
    };

    planningContext.researchDigest = this.buildResearchDigest(planningContext);

    // Campaign memory — cross-run learning
    let campaignContext = null;
    try {
      const campaign = new CampaignMemory({}, this.logger);
      await campaign.load();
      const domain = guidedFocus?.domain || '';
      const topic = guidedFocus?.context || '';
      campaignContext = campaign.buildPlanningContext(domain, topic);
      // Only keep if there's actual data
      if (!campaignContext.priorCampaigns.length &&
          !campaignContext.sensitivityPatterns.length &&
          !campaignContext.effectiveSkills.length &&
          !campaignContext.domainInsights.length) {
        campaignContext = null;
      }
    } catch (e) { /* campaign memory not available */ }
    planningContext.campaignContext = campaignContext;

    planningContext.hasContext = Boolean(
      planningContext.threadAnchor ||
      planningContext.memoryMatches.length > 0 ||
      planningContext.completedTasks.length > 0 ||
      planningContext.reviewGaps.length > 0 ||
      planningContext.recentFindings.length > 0 ||
      planningContext.processedSourceUrls.length > 0 ||
      planningContext.campaignContext
    );

    this.logger?.info?.('\u{1F9E0} Planning context gathered', {
      hasContext: planningContext.hasContext,
      memoryMatches: memoryMatches.length,
      threadAnchor: threadAnchor?.title?.substring(0, 80) || null,
      completedTasks: completedTasks.length,
      recentFindings: recentFindings.length,
      activeGoals: activeGoals.length,
      campaignContext: campaignContext?.summary || null
    });

    return planningContext;
  }

  async queueNextPlanAction(nextPlanSpec, completedPlan, anchor, options = {}) {
    const {
      source = 'auto_completion',
      requestedBy = 'guided_planner',
      extraMetadata = {}
    } = options;

    const actionsQueuePath = path.join(this.getLogsDir(), 'actions-queue.json');
    let actionsData = { actions: [] };

    try {
      actionsData = JSON.parse(await fs.readFile(actionsQueuePath, 'utf8'));
    } catch (error) {
      actionsData = { actions: [] };
    }

    const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const injectAction = {
      actionId,
      type: 'inject_plan',
      domain: this.summarizeText(nextPlanSpec.domain || anchor.researchDomain, 80),
      context: String(nextPlanSpec.context || '').trim(),
      executionMode: 'strict',
      requestedAt: new Date().toISOString(),
      source,
      status: 'pending',
      metadata: {
        archiveCurrentPlan: true,
        requestedBy,
        continuation: true,
        researchDomain: anchor.researchDomain,
        researchContext: anchor.researchContext,
        effectiveExecutionMode: GUIDED_EFFECTIVE_MODE,
        previousPlan: completedPlan.title,
        ...extraMetadata
      }
    };

    actionsData.actions = Array.isArray(actionsData.actions) ? actionsData.actions : [];
    actionsData.actions.unshift(injectAction);
    await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf8');

    return injectAction;
  }

  async generateContinuationPlanSpec(completedPlan, auditResult = null) {
    const guidedFocus = this.config.architecture?.roleSystem?.guidedFocus || {};
    const planningContext = await this.buildPlanningContext(guidedFocus, { completedPlan, auditResult });
    const anchor = {
      researchDomain: planningContext.threadAnchor?.title || guidedFocus.researchDomain || guidedFocus.domain || completedPlan.title,
      researchContext: guidedFocus.researchContext || guidedFocus.context || '',
      anchorSource: planningContext.threadAnchor?.source || 'guided_focus'
    };

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

    const prompt = `You are generating the next guided continuation plan for an ongoing COSMO research thread.

${domainAnchorBlock}

COMPLETED PLAN:
- Title: ${completedPlan.title}
- Deliverables created: ${auditResult?.totalFiles || 0}
- Top recent mission summaries:
${planningContext.priorMissionSummaries.length > 0 ? planningContext.priorMissionSummaries.map(item => `- ${item}`).join('\n') : '- None recorded'}

PRIORITY GAPS:
${planningContext.reviewGaps.length > 0 ? planningContext.reviewGaps.map(item => `- ${item}`).join('\n') : '- No explicit gaps found'}

RECENT FINDINGS:
${planningContext.recentFindings.length > 0 ? planningContext.recentFindings.map(item => `- ${item}`).join('\n') : '- No recent findings found'}

PROCESSED SOURCE URLS:
${planningContext.processedSourceUrls.length > 0 ? planningContext.processedSourceUrls.map(item => `- ${item}`).join('\n') : '- None recorded'}

Return JSON only:
{
  "reasoning": "Why this is the correct continuation",
  "domain": "Concise continuation title within the same research thread",
  "context": "Detailed continuation brief that advances the existing thread without repeating completed work",
  "expectedAnchor": "What prior work this continuation is anchored to"
}`;

    const response = await this.client.generate({
      model: this.config.coordinator?.model || this.config.models?.plannerModel || this.config.models?.primary,
      reasoningEffort: 'medium',
      maxTokens: 2400,
      messages: [
        { role: 'system', content: 'Return valid JSON only.' },
        { role: 'user', content: prompt }
      ]
    });

    const nextPlanSpec = this.parsePlanFromResponse(response.content || response.message?.content || '', null, { continuation: true });
    if (!nextPlanSpec?.domain || !nextPlanSpec?.context) {
      throw new Error('Continuation planner returned an invalid anchored plan');
    }

    return { nextPlanSpec, anchor, planningContext };
  }

  async queueContinuationPlan(completedPlan, auditResult = null) {
    try {
      const { nextPlanSpec, anchor, planningContext } = await this.generateContinuationPlanSpec(completedPlan, auditResult);
      const action = await this.queueNextPlanAction(nextPlanSpec, completedPlan, anchor, {
        source: 'guided_planner_continuation',
        requestedBy: 'guided_planner',
        extraMetadata: {
          reasoning: nextPlanSpec.reasoning || null,
          continuationAnchor: nextPlanSpec.expectedAnchor || null,
          researchDigest: planningContext.researchDigest
        }
      });

      await this.clearPlanningFailure();
      this.logger?.info('📋 Guided continuation plan queued', {
        actionId: action.actionId,
        domain: action.domain,
        anchor: anchor.researchDomain
      });

      return action;
    } catch (error) {
      await this.persistPlanningFailure('continuation', error, {
        completedPlan: completedPlan?.title || null
      });
      throw error;
    }
  }

  /**
   * Analyze what resources/tools are available
   */
  async analyzeAvailableResources() {
    const resources = {
      mcp: {
        available: false,
        servers: [],
        tools: []
      },
      webSearch: this.config.models?.enableWebSearch || false,
      codeExecution: this.config.coordinator?.codeExecution?.enabled || false,
      agentTypes: []
    };

    // Check MCP tools
    if (this.config.mcp?.client?.enabled) {
      try {
        const mcpTools = await this.client.getMCPTools?.() || [];
        resources.mcp.available = mcpTools.length > 0;
        resources.mcp.tools = mcpTools.map(t => t.name);
        
        const servers = this.config.mcp.client.servers?.filter(s => s.enabled) || [];
        resources.mcp.servers = servers.map(s => ({
          label: s.label,
          url: s.url,
          tools: s.allowedTools || []
        }));
        
        this.logger?.info(`✓ MCP Resources: ${resources.mcp.servers.length} servers, ${resources.mcp.tools.length} tools`);
      } catch (error) {
        this.logger?.warn('Failed to query MCP tools', { error: error.message });
      }
    }

    // Check agent types
    const agentWeights = this.config.coordinator?.agentTypeWeights || {};
    let availableTypes = Object.keys(agentWeights).filter(type => agentWeights[type] > 0);

    // Execution agents are always available (not gated by agentTypeWeights)
    const EXECUTION_AGENT_TYPES = ['dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
    for (const execType of EXECUTION_AGENT_TYPES) {
      if (!availableTypes.includes(execType)) {
        availableTypes.push(execType);
      }
    }

    // IDE-FIRST PARADIGM: When enabled, limit cerebral agent types to ide + research
    // Execution agents are always preserved (they have specialized CLI-first capabilities)
    if (this.config?.ideFirst?.enabled) {
      availableTypes = availableTypes.filter(type =>
        type === 'ide' || type === 'research' || EXECUTION_AGENT_TYPES.includes(type)
      );
      // Ensure ide is first in the list (higher priority)
      availableTypes = ['ide', ...availableTypes.filter(t => t !== 'ide')];
      this.logger?.info('🖥️ IDE-First mode: Limiting cerebral agents to ide + research (execution agents preserved)');
    }
    
    resources.agentTypes = availableTypes;
    this.logger?.info(`✓ Available agent types: ${resources.agentTypes.join(', ')}`);

    if (resources.webSearch) {
      this.logger?.info('✓ Web search: enabled');
    }
    if (resources.codeExecution) {
      this.logger?.info('✓ Code execution: enabled');
    }

    return resources;
  }

  /**
   * Read files if the task context mentions specific filenames OR requests discovery
   * Supports both explicit filenames and directory scanning
   */
  async readFilesIfNeeded(guidedFocus) {
    const context = guidedFocus.context || '';
    const filesRead = [];
    
    // Check if context asks for discovery/scanning
    const shouldDiscover = context.toLowerCase().includes('discover') ||
                          context.toLowerCase().includes('scan') ||
                          context.toLowerCase().includes('all .md files') ||
                          context.toLowerCase().includes('list_directory');
    
    let filesToRead = new Set();
    
    if (shouldDiscover) {
      // Use list_directory to discover files
      this.logger?.info('🔍 Discovering files via list_directory...');
      
      // Get directories from config allowedPaths OR extract from context
      const dirsToScan = this.getDirectoriesToScan(guidedFocus);
      
      for (const dir of dirsToScan) {
        try {
          const result = await this.client.callMCPTool('filesystem', 'list_directory', {
            path: dir
          });
          
          if (result.content && result.content[0]) {
            const data = JSON.parse(result.content[0].text);
            const items = data.items || [];
            
            // Filter for .md files (or .js if context mentions code analysis)
            const mdFiles = items.filter(item => 
              item.type === 'file' && item.name.endsWith('.md')
            );
            
            mdFiles.forEach(file => {
              const fullPath = dir === '.' ? file.name : `${dir}/${file.name}`;
              filesToRead.add(fullPath);
            });
            
            this.logger?.info(`   Found ${mdFiles.length} .md files in ${dir}`);
          }
        } catch (error) {
          this.logger?.warn(`   Failed to scan ${dir}: ${error.message}`);
        }
      }
      
      this.logger?.info(`✅ Discovered ${filesToRead.size} total files`);
    } else {
      // Look for specific file patterns in context
      const filePatterns = [
        /insights_curated_cycle_\d+[^"'\s]*/g,
        /[\w\-]+\.md/g,
        /[\w\-]+\.json/g
      ];
      
      for (const pattern of filePatterns) {
        const matches = context.match(pattern);
        if (matches) {
          matches.forEach(match => {
            // Add full path if not already there
            if (!match.includes('/')) {
              filesToRead.add(`runtime/coordinator/${match}`);
            } else {
              filesToRead.add(match);
            }
          });
        }
      }
    }
    
    if (filesToRead.size === 0) {
      return [];
    }
    
    this.logger?.info('');
    this.logger?.info(`📁 Reading ${filesToRead.size} files via MCP...`);
    
    for (const filePath of filesToRead) {
      try {
        const result = await this.client.callMCPTool('filesystem', 'read_file', {
          path: filePath
        });
        
        if (result.content && result.content[0]) {
          const data = JSON.parse(result.content[0].text);
          filesRead.push({
            path: filePath,
            filename: filePath.split('/').pop(),
            content: data.content,
            size: data.size,
            preview: data.content.substring(0, 500)
          });
          this.logger?.info(`   ✓ Read: ${filePath.split('/').pop()} (${data.size} bytes)`);
        }
      } catch (error) {
        this.logger?.warn(`   ✗ Failed to read: ${filePath} - ${error.message}`);
      }
    }
    
    if (filesRead.length > 0) {
      this.logger?.info(`✅ Read ${filesRead.length} files via MCP`);
    }
    
    return filesRead;
  }

  /**
   * Generate mission plan using a three-tier cascade.
   * Model-agnostic: capable models hit Tier 1, weaker models fall to Tier 2,
   * and if both fail, Tier 3 generates domain-based defaults with no LLM call.
   */
  async generateMissionPlan(guidedFocus, resources, filesRead = [], taskPhases = [], planningContext = {}) {
    this.logger?.info('');
    this.logger?.info('🎯 Generating mission plan...');

    // Tier 1: Full prompt (rich context, complex JSON output)
    try {
      const plan = await this._attemptPlanGeneration(
        this.buildPlanningPrompt(guidedFocus, resources, filesRead, taskPhases, planningContext),
        'You are a mission planner for a guided research task. Output structured JSON plans.',
        { maxTokens: 8000, reasoningEffort: 'medium' },
        guidedFocus, planningContext
      );
      if (plan.agentMissions?.length > 0) {
        this.logger?.info('✅ Mission plan generated (Tier 1: full prompt)');
        this.logger?.info(`   Strategy: ${plan.strategy || 'unknown'}`);
        this.logger?.info(`   Agent missions: ${plan.agentMissions.length}`);
        this.logger?.info(`   Initial goals: ${plan.initialGoals?.length || 0}`);
        return plan;
      }
      this.logger?.warn('⚠️ Tier 1 produced zero missions, trying simplified prompt...');
    } catch (e) {
      this.logger?.warn('⚠️ Tier 1 planning failed, trying simplified prompt...', { error: e.message });
    }

    // Tier 2: Simplified prompt (shorter, clearer, more reliable JSON)
    try {
      const plan = await this._attemptPlanGeneration(
        this.buildSimplePlanningPrompt(guidedFocus, resources, planningContext),
        'You are a research planner. Output valid JSON only. No markdown, no explanation.',
        { maxTokens: 2200, reasoningEffort: 'low' },
        guidedFocus, planningContext
      );
      if (plan.agentMissions?.length > 0) {
        this.logger?.info('✅ Mission plan generated (Tier 2: simplified prompt)');
        this.logger?.info(`   Strategy: ${plan.strategy || 'unknown'}`);
        this.logger?.info(`   Agent missions: ${plan.agentMissions.length}`);
        this.logger?.info(`   Initial goals: ${plan.initialGoals?.length || 0}`);
        return plan;
      }
      this.logger?.warn('⚠️ Tier 2 produced zero missions, using domain-based defaults...');
    } catch (e) {
      this.logger?.warn('⚠️ Tier 2 planning failed, using domain-based defaults...', { error: e.message });
    }

    // Tier 3: Domain-based defaults (no LLM needed — always works)
    // normalizePlan with empty missions triggers the fresh-run fallback
    this.logger?.warn('⚠️ Using Tier 3: generating domain-based plan from topic and context');
    const plan = this.normalizePlan({ agentMissions: [] }, guidedFocus, planningContext);
    this.logger?.info(`✅ Domain-based plan generated (Tier 3)`);
    this.logger?.info(`   Strategy: ${plan.strategy}`);
    this.logger?.info(`   Agent missions: ${plan.agentMissions.length}`);
    return plan;
  }

  /**
   * Attempt a single plan generation with given prompt and LLM params.
   * @private
   */
  async _attemptPlanGeneration(prompt, systemMessage, llmOptions, guidedFocus, planningContext) {
    const response = await this.client.generate({
      model: this.config.coordinator?.model || this.config.models?.plannerModel || this.config.models?.primary,
      reasoningEffort: llmOptions.reasoningEffort,
      maxTokens: llmOptions.maxTokens,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: prompt }
      ]
    });
    const content = response.content || response.message?.content || '';
    return this.parsePlanFromResponse(content, guidedFocus, { planningContext });
  }

  /**
   * Build a SIMPLE planning prompt for local LLMs
   * Shorter, clearer, more likely to produce valid JSON
   */
  buildSimplePlanningPrompt(guidedFocus, resources, planningContext = {}) {
    const domain = guidedFocus.domain || 'research';
    const context = guidedFocus.context || '';
    const agentTypes = resources.agentTypes.join(', ');
    const continuationMode = planningContext.hasContext === true;
    
    // IDE-First: Use ide for non-research tasks
    const ideFirst = this.config?.ideFirst?.enabled;
    const exampleMissions = ideFirst
      ? `[
    {"type": "dataacquisition", "mission": "Use curl to fetch listings from example.com/data. Extract name, date, and category from each page. Save raw HTML to raw/pages/ and structured JSON to extracted/records.json with schema {name, date, category}. Respect robots.txt, 2s between requests.", "tools": ["curl", "jq"], "priority": "high", "sourceScope": "example.com primary listings", "artifactInputs": [], "expectedOutput": "extracted/records.json with all structured records", "metadata": {"sourceScope": "example.com primary listings", "artifactInputs": [], "expectedOutput": "extracted/records.json"}},
    {"type": "ide", "mission": "Read extracted/records.json. Synthesize into a comprehensive report with timeline, categories, and analysis. Save to @outputs/report.md", "tools": [], "priority": "high", "sourceScope": "prior artifacts from acquisition phase", "artifactInputs": [{"path": "extracted/records.json", "label": "structured data from acquisition"}], "expectedOutput": "@outputs/report.md", "metadata": {"sourceScope": "prior artifacts from acquisition phase", "artifactInputs": [{"path": "extracted/records.json"}], "expectedOutput": "@outputs/report.md"}}
  ]`
      : `[
    {"type": "dataacquisition", "mission": "Use curl to fetch listings from example.com/data. Extract name, date, and category from each page. Save raw HTML to raw/pages/ and structured JSON to extracted/records.json with schema {name, date, category}. Respect robots.txt, 2s between requests.", "tools": ["curl", "jq"], "priority": "high", "sourceScope": "example.com primary listings", "artifactInputs": [], "expectedOutput": "extracted/records.json with all structured records", "metadata": {"sourceScope": "example.com primary listings", "artifactInputs": [], "expectedOutput": "extracted/records.json"}},
    {"type": "datapipeline", "mission": "Read extracted/records.json. Create SQLite database at data/records.db with tables: items(id, name, date, category). Load all records. Validate: SELECT COUNT(*) matches source file record count.", "tools": ["sqlite3", "jq"], "priority": "high", "sourceScope": "extracted/records.json from prior acquisition", "artifactInputs": [{"path": "extracted/records.json", "label": "structured data from acquisition"}], "expectedOutput": "data/records.db with validated records", "metadata": {"sourceScope": "extracted/records.json from prior acquisition", "artifactInputs": [{"path": "extracted/records.json"}], "expectedOutput": "data/records.db"}}
  ]`;

    return `Create a ${continuationMode ? 'continuation' : 'guided'} research plan for: "${domain}"
Context: ${context}
${continuationMode ? `Existing thread context:
- completed tasks: ${(planningContext.completedTasks || []).length}
- review gaps: ${(planningContext.reviewGaps || []).length}
- processed sources: ${(planningContext.processedSourceUrls || []).length}
- instruction: advance the existing research thread without repeating completed work
` : ''}

Available agent types: ${agentTypes}
${ideFirst ? 'NOTE: Use "research" only for web search. Use "ide" for analysis, writing, code.\n' : ''}Available tools: web_search

Return ONLY this JSON (no other text):
{
  "strategy": "brief description",
  "agentMissions": ${exampleMissions},
  "initialGoals": ["goal 1", "goal 2"]
}`;
  }

  /**
   * Build the planning prompt
   */
  buildPlanningPrompt(guidedFocus, resources, filesRead = [], taskPhases = [], planningContext = {}) {
    // NEW: If task phases detected, include them in prompt
    const phasesInfo = taskPhases.length > 0
      ? `\n\nSTRUCTURED TASK PHASES DETECTED (${taskPhases.length} phases):\n` +
        taskPhases.map(p => `Phase ${p.number} - ${p.name}:\n${p.description}`).join('\n\n') +
        `\n\nNOTE: Goals have been generated for each phase. Your agent missions should align with these phases.`
      : '';
    // Skip continuation context when direction has changed — plan fresh from new context
    const useContinuation = planningContext.hasContext && !planningContext.contextRedirect;
    const continuationInfo = useContinuation
      ? `\n\nEXISTING RESEARCH THREAD CONTEXT:
- Thread anchor: ${planningContext.threadAnchor?.title || guidedFocus.domain}
- Completed tasks:\n${(planningContext.completedTasks || []).map(task => `  - ${task.summary}`).join('\n') || '  - none'}
- Latest review gaps:\n${(planningContext.reviewGaps || []).map(item => `  - ${item}`).join('\n') || '  - none'}
- Recent findings:\n${(planningContext.recentFindings || []).map(item => `  - ${item}`).join('\n') || '  - none'}
- Processed source URLs:\n${(planningContext.processedSourceUrls || []).map(item => `  - ${item}`).join('\n') || '  - none'}

IMPORTANT: This is not a fresh topic. Advance the existing research thread without repeating completed work.`
      : '';
    const campaignInfo = planningContext.campaignContext
      ? `\n\nCROSS-RUN LEARNING (from prior research campaigns):
- Prior campaigns in this domain: ${planningContext.campaignContext.priorCampaigns?.length || 0}${planningContext.campaignContext.priorCampaigns?.length ? '\n' + planningContext.campaignContext.priorCampaigns.map(c => `  - ${c.topic || c.domain || 'untitled'} (${c.cycleCount} cycles, ${c.nodeCount} nodes)`).join('\n') : ''}
- Assumption-sensitivity patterns: ${planningContext.campaignContext.sensitivityPatterns?.length || 0}${planningContext.campaignContext.sensitivityPatterns?.length ? '\n' + planningContext.campaignContext.sensitivityPatterns.slice(0, 5).map(p => `  - "${p.assumption}" (sensitivity: ${p.sensitivity})`).join('\n') : ''}
- Effective skills: ${planningContext.campaignContext.effectiveSkills?.length || 0}${planningContext.campaignContext.effectiveSkills?.length ? '\n' + planningContext.campaignContext.effectiveSkills.slice(0, 5).map(s => `  - ${s.skillId} (${s.successes}/${s.uses} success rate)`).join('\n') : ''}
- Domain insights: ${planningContext.campaignContext.domainInsights?.length || 0}${planningContext.campaignContext.domainInsights?.length ? '\n' + planningContext.campaignContext.domainInsights.slice(0, 5).map(i => `  - ${i.insight}`).join('\n') : ''}
- Summary: ${planningContext.campaignContext.summary || 'No prior campaign data available.'}

Use this prior knowledge to avoid repeating mistakes, leverage effective strategies, and test known sensitivity patterns.`
      : '';
    // PGS Knowledge Assessment injection
    let assessmentBlock = '';
    if (planningContext.knowledgeAssessment?.answer) {
      assessmentBlock = `

## BRAIN KNOWLEDGE ASSESSMENT (PGS Deep Sweep)

The following is a comprehensive analysis of what this brain already knows,
produced by a deep sweep of the entire knowledge graph:

${planningContext.knowledgeAssessment.answer}

## PLANNING INSTRUCTION

Based on the assessment above:
- DO NOT create research phases for topics shown as well-covered
- Create research phases ONLY for specific gaps identified as missing or shallow
- If research is sufficient, start directly with data processing, database creation, or synthesis phases
- Start the plan from the first phase that requires genuinely NEW work
`;
    }
    const mcpToolsList = resources.mcp.tools.length > 0 
      ? `\n  MCP tools available: ${resources.mcp.tools.join(', ')}`
      : '\n  MCP tools: None';
    
    // If many files read, provide comprehensive structure for all agents
    const filesInfo = filesRead.length > 0
      ? `\n\nFILES DISCOVERED VIA MCP (${filesRead.length} files, ${filesRead.reduce((sum, f) => sum + (f.size || 0), 0)} bytes total):\n\n` +
        `COMPLETE FILE INVENTORY:\n${filesRead.map(f => `${f.path} (${f.size}b)`).join('\n')}\n\n` +
        `AGENT FILES FOUND:\n${filesRead.filter(f => f.path.includes('agents/') && f.path.endsWith('.js')).map(f => `- ${f.filename}`).join('\n')}\n\n` +
        `DOCUMENTATION FILES:\n${filesRead.filter(f => f.path.endsWith('.md')).map(f => `- ${f.path}`).join('\n')}\n\n` +
        `KEY CONTENT SAMPLES:\n${filesRead.filter(f => f.filename.match(/README|ARCHITECTURE|config\.yaml/i)).slice(0, 3).map(f => 
          `${f.filename} (${f.size}b):\n${f.content ? f.content.substring(0, 500) : f.preview}...`
        ).join('\n\n')}\n\n` +
        `CRITICAL FOR AGENT MISSIONS:\n` +
        `- Research agents: Use this file list to know what exists\n` +
        `- Code execution agents: Analyze THIS data (file counts, names) - do NOT access local filesystem\n` +
        `- Analysis/Synthesis agents: Reference these files in your work\n` +
        `All file contents are available via the planning context above.`
      : '';

    return `You are planning a guided research mission.${filesInfo}${phasesInfo}${continuationInfo}${campaignInfo}${assessmentBlock}

TASK DEFINITION:
Domain: ${guidedFocus.domain}
Context: ${guidedFocus.context || 'None provided'}
Depth: ${guidedFocus.depth || 'normal'}

AVAILABLE RESOURCES:${mcpToolsList}
Web search: ${resources.webSearch ? 'Yes' : 'No'}
Code execution: ${resources.codeExecution ? 'Yes' : 'No'}
Agent types: ${resources.agentTypes.join(', ')}
${this.config?.ideFirst?.enabled ? `
AGENT SELECTION GUIDANCE (IDE-First Mode):
- Use "research" ONLY for tasks that need web search to find sources
- Use "ide" for ALL other tasks: analysis, synthesis, document creation, code creation, etc.
- The IDE agent is a powerful generalist that can read/write files, analyze, create, and execute
` : ''}
WEB SEARCH: Available via MCP web_search tool (free, no API key needed)

YOUR JOB:
1. Understand what this task requires
2. ${useContinuation ? 'Advance the existing research thread without repeating completed work' : 'Plan execution missions that produce concrete deliverables'}
3. Create 2-4 specific agent missions with clear, non-overlapping objectives
4. Partition missions by source family, evidence window, or artifact responsibility so duplicate waves cannot be produced
5. Define what success looks like — name the files, databases, or artifacts each mission produces
6. Suggest initial goals for the cognitive loop

MISSION SPEC QUALITY — BAD vs GOOD:

BAD mission: "Research Jerry Garcia performances outside the Grateful Dead"
GOOD mission: "Use curl to fetch performance listings from jerrybase.com/shows. For each show page, extract date, venue, city, band name, and setlist. Save raw HTML to raw/jerrybase/ and structured JSON to extracted/shows.json with schema {date, venue, city, band, songs[]}. Target: all shows 1963-1995. Respect robots.txt, 2s between requests."

BAD mission: "Create a database of performances"
GOOD mission: "Read extracted/shows.json from prior acquisition. Create SQLite database at data/shows.db with tables: shows(id, date, venue, city, band), setlists(show_id, position, song). Load all records. Validate: SELECT COUNT(*) matches source records."

BAD mission: "Find information about climate change impacts"
GOOD mission: "Use web_search to find IPCC AR6 data tables on observed temperature anomalies, sea level rise, and extreme weather frequency. For each dataset found, record: source URL, date range, geographic scope, key metric, and value. Save structured findings to extracted/climate-metrics.json with schema {source_url, date_range, region, metric_name, value, unit}."

MISSION FORMAT REQUIREMENTS:
- "mission": MUST contain specific URLs/paths, tool names, output format, and data schema where applicable
- "expectedOutput": MUST name the specific file(s) this agent will produce (e.g., "extracted/shows.json", "data/shows.db", "@outputs/report.md")
- "sourceScope": Non-overlapping evidence slice or data source — no two agents should hit the same source
- If specific URLs are unknown, describe the concrete search strategy to find them (search terms, expected source types, how to identify the right pages)
- Every mission must be self-contained: an agent reading only this mission spec should know exactly what to do, what tools to use, and what files to produce

OUTPUT FORMAT (JSON):
{
  "strategy": "one sentence description of approach",
  "requiredResources": ["web_search"],
  "spawnAgents": true/false,
  "agentMissions": [
    {
      "type": "${resources.agentTypes.join('|')}",
      "mission": "action-spec with URLs/paths, tool names, output format, data schema",
      "tools": ["tool_name"],
      "priority": "high|medium|low",
      "sourceScope": "non-overlapping evidence slice or data source",
      "artifactInputs": [{"path": "@outputs/...", "label": "prior artifact if needed"}],
      "expectedOutput": "specific filename(s) this agent will produce",
      "metadata": {
        "sourceScope": "same value as sourceScope",
        "artifactInputs": [],
        "expectedOutput": "same value as expectedOutput"
      }
    }
  ],
  "initialGoals": [
    "specific goal 1",
    "specific goal 2"
  ],
  "successCriteria": [
    "All documents in folder X read and analyzed",
    "Timeline document created with chronological order",
    "At least N major changes documented",
    "Output saved to @outputs/filename.md"
  ],
  "deliverable": {
    "type": "markdown|html|json|pdf-style-md",
    "filename": "specific_output_filename.md",
    "location": "@outputs/",
    "accessibility": "mcp-required",
    "requiredSections": ["Executive Summary", "Analysis", "Conclusions"],
    "minimumContent": "Comprehensive report with at least 1000 words, including evidence and examples"
  }
}

Be specific and actionable. Every mission must read like an execution spec, not a wish list.

${(() => {
  try {
    const manifest = new CapabilityManifest();
    return manifest.getPlannerInjectionText([]);
  } catch (e) { return ''; }
})()}

AGENT TYPE SELECTION:
- Prefer execution agents (dataacquisition, datapipeline) over research when the task involves acquiring or processing specific data from known sources. Research agents discover; execution agents produce artifacts.
- Use "research" agent ONLY when you need web_search to discover sources whose URLs/locations are not yet known
- Use "dataacquisition" for web scraping, API consumption, file downloads — whenever you know (or can describe how to find) the target URLs/endpoints
- Use "datapipeline" for data transformation, database creation, ETL, validation — takes prior artifacts as input and produces structured output
${this.config?.ideFirst?.enabled
  ? `- Use "ide" agent for analysis, synthesis, document creation, code — the generalist for non-acquisition/non-pipeline work
- The IDE agent is the primary tool for processing, writing, and producing deliverables
- Do NOT use "document_creation", "analysis", "synthesis", or "code_creation" - use "ide" instead`
  : `- Use "analysis" or "synthesis" for processing and combining information
- Use "document_creation" for producing final reports and deliverables`}
- Use "infrastructure" for Docker, environment setup, dependency installation
- Use "automation" for file operations, batch processing, OS automation
ONLY use agent types from the available list above.`;
  }

  /**
   * Repair common JSON issues from local LLMs
   */
  repairJSON(jsonStr) {
    let repaired = jsonStr;

    // Remove trailing commas before ] or }
    repaired = repaired.replace(/,\s*]/g, ']');
    repaired = repaired.replace(/,\s*}/g, '}');

    // Fix unquoted keys (common LLM error)
    repaired = repaired.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // Fix single quotes to double quotes
    repaired = repaired.replace(/'/g, '"');

    // Remove control characters
    repaired = repaired.replace(/[\x00-\x1F\x7F]/g, ' ');

    // Fix common "true/false" issues - unquoted booleans are fine in JSON
    // But fix things like True/False (Python style)
    repaired = repaired.replace(/:\s*True\b/gi, ': true');
    repaired = repaired.replace(/:\s*False\b/gi, ': false');
    repaired = repaired.replace(/:\s*None\b/gi, ': null');

    return repaired;
  }

  /**
   * Parse plan from GPT response
   */
  parsePlanFromResponse(content, guidedFocus = null, options = {}) {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
                     content.match(/(\{[\s\S]*\})/);

    if (jsonMatch) {
      let jsonStr = jsonMatch[1];

      // Try parsing as-is first
      try {
        const plan = JSON.parse(jsonStr);
        return options.continuation
          ? plan
          : this.normalizePlan(plan, guidedFocus, options.planningContext);
      } catch (e1) {
        // Try with JSON repair
        try {
          const repaired = this.repairJSON(jsonStr);
          this.logger?.debug('Attempting JSON repair', { original: jsonStr.substring(0, 100), repaired: repaired.substring(0, 100) });
          const plan = JSON.parse(repaired);
          this.logger?.info('✅ JSON repair successful');
          return options.continuation
            ? plan
            : this.normalizePlan(plan, guidedFocus, options.planningContext);
        } catch (e2) {
          this.logger?.error('Failed to parse plan JSON even after repair', {
            error: e2.message,
            jsonPreview: jsonStr.substring(0, 200)
          });
        }
      }
    }

    throw new Error('Planner returned invalid JSON');
  }

  /**
   * Normalize plan object with defaults
   * Ensures required agent types are present for complete execution
   */
  normalizePlan(plan, guidedFocus, planningContext = {}) {
    const missions = plan.agentMissions || [];
    const ideFirstEnabled = this.config?.ideFirst?.enabled;
    const researchDigest = planningContext.researchDigest || this.buildResearchDigest(planningContext);

    // FRESH RUN FALLBACK: If LLM returned zero missions, generate domain-based defaults
    // This handles cases where the planner model fails to produce valid missions
    // (e.g., local/cloud models returning minimal or malformed JSON)
    if (missions.length === 0) {
      const domain = guidedFocus?.domain || 'the research topic';
      const context = guidedFocus?.context || '';
      const deliverableType = ideFirstEnabled ? 'ide' : 'document_creation';

      this.logger?.warn(`⚠️ Planner produced zero agent missions — generating domain-based defaults for "${domain}"`);

      missions.push({
        type: 'research',
        mission: `Conduct comprehensive web research on ${domain}. ${context ? `Focus areas: ${context.substring(0, 200)}` : 'Gather primary sources, key facts, timeline, and notable findings.'}`,
        tools: ['web_search'],
        priority: 'high',
        sourceScope: 'primary external sources and authoritative references',
        artifactInputs: [],
        expectedOutput: 'Comprehensive research findings with source citations'
      });

      missions.push({
        type: 'research',
        mission: `Find deeper and secondary sources on ${domain}. Look for perspectives, analysis, and details not covered by mainstream sources. ${context ? context.substring(0, 150) : ''}`,
        tools: ['web_search'],
        priority: 'medium',
        sourceScope: 'secondary sources, forums, expert analysis, lesser-known accounts',
        artifactInputs: [],
        expectedOutput: 'Secondary research findings filling gaps from primary research'
      });

      missions.push({
        type: deliverableType,
        mission: `Create a comprehensive research report on ${domain}. Synthesize all gathered research into a well-structured document with sections, evidence, and analysis. Save to @outputs/guided_output.md`,
        tools: ideFirstEnabled ? ['read_file', 'write_file'] : ['mcp_filesystem'],
        priority: 'high',
        sourceScope: 'final synthesis and deliverable assembly',
        artifactInputs: [],
        expectedOutput: 'Complete markdown research report'
      });
    }

    // Ensure a deliverable-producing agent is present
    // IDE-First: Use 'ide' agent; Legacy: Use 'document_creation'
    const deliverableAgentType = ideFirstEnabled ? 'ide' : 'document_creation';
    const hasDeliverableAgent = missions.some(m => 
      m.type === 'document_creation' || m.type === 'ide'
    );
    
    if (!hasDeliverableAgent && missions.length > 0) {
      const domain = guidedFocus?.domain || plan.strategy || 'the research topic';
      const deliverable = plan.deliverable || {};
      const filename = deliverable.filename || 'guided_output.md';

      this.logger?.info(`📝 Adding ${deliverableAgentType} agent (required for deliverables)`);
      missions.push({
        type: deliverableAgentType,
        mission: `Create a comprehensive report document on ${domain}. Synthesize all research findings into a well-structured markdown document with clear sections. Save as ${filename} in the outputs directory.`,
        tools: ideFirstEnabled ? ['read_file', 'write_file'] : ['mcp_filesystem'],
        priority: 'high',
        sourceScope: 'final synthesis and deliverable assembly',
        artifactInputs: (researchDigest.artifactRefs || []).slice(0, 12),
        expectedOutput: 'Complete markdown report document'
      });
    }

    const normalizedMissions = missions.map((mission, index) => {
      const sourceScope = mission.sourceScope || mission.metadata?.sourceScope || `${mission.type} evidence slice ${index + 1}`;
      const artifactInputs = Array.isArray(mission.artifactInputs)
        ? mission.artifactInputs
        : Array.isArray(mission.metadata?.artifactInputs)
          ? mission.metadata.artifactInputs
          : (mission.type === 'research' ? [] : (researchDigest.artifactRefs || []).slice(0, 12));
      const expectedOutput = mission.expectedOutput || mission.metadata?.expectedOutput || `${mission.type} output`;

      return {
        ...mission,
        sourceScope,
        artifactInputs,
        expectedOutput,
        metadata: {
          ...(mission.metadata || {}),
          sourceScope,
          artifactInputs,
          expectedOutput,
          researchDigest,
          guidedMission: true,
          effectiveExecutionMode: GUIDED_EFFECTIVE_MODE
        }
      };
    });

    const domain = guidedFocus?.domain || 'the research topic';
    return {
      strategy: plan.strategy || `Deep research investigation into ${domain}`,
      // Stamp source context/domain so we can detect changes on continue
      _sourceContext: (guidedFocus?.context || '').trim(),
      _sourceDomain: (guidedFocus?.domain || '').trim(),
      requiredResources: plan.requiredResources || ['web_search'],
      spawnAgents: plan.spawnAgents !== false, // Default true
      agentMissions: normalizedMissions,
      initialGoals: plan.initialGoals?.length > 0
        ? plan.initialGoals
        : [`Gather comprehensive information on ${domain}`, `Identify key findings, patterns, and gaps in the research`],
      successCriteria: plan.successCriteria || [],
      deliverable: plan.deliverable || {
        type: 'markdown',
        filename: 'guided_output.md',
        location: '@outputs/',
        accessibility: 'mcp-required',
        requiredSections: [],
        minimumContent: 'Task completion report'
      },
      researchDigest
    };
  }

  /**
   * Spawn initial agents based on missions
   * @param {Object} plan - The mission plan
   * @param {Array} missionGoalIds - Pre-generated goalIds for task→goal correlation
   */
  async spawnInitialAgents(plan, missionGoalIds = []) {
    if (!this.subsystems.agentExecutor) {
      this.logger?.warn('Agent executor not available, cannot spawn agents');
      return;
    }

    const agentMissions = plan.agentMissions || [];
    if (agentMissions.length === 0) {
      this.logger?.warn('No agent missions to spawn');
      return;
    }

    const deliverableSpec = plan.deliverable;
    const researchDigest = plan.researchDigest || this.buildResearchDigest(plan.planningContext || {});

    this.logger?.info('');
    this.logger?.info('🤖 Organizing agents by dependency tiers...');
    
    // Classify missions by dependency tier
    const classified = this.classifyMissionsByTier(agentMissions);
    
    // Log tier organization
    this.logger?.info(`   Tier 0 (Data Collectors): ${classified.tier0.length} agents`);
    this.logger?.info(`   Tier 1 (Processors): ${classified.tier1.length} agents`);
    this.logger?.info(`   Tier 2 (Creators): ${classified.tier2.length} agents`);
    this.logger?.info(`   Tier 3 (Validators): ${classified.tier3.length} agents`);
    
    // Spawn ONLY Tier 0 initially
    this.logger?.info('');
    this.logger?.info(`🚀 Spawning Tier 0: ${classified.tier0.length} agent(s) with no dependencies`);
    const tier0AgentIds = await this.spawnMissions(classified.tier0, deliverableSpec, missionGoalIds, 0, researchDigest);

    this.logger?.info(`   ✅ Spawned ${tier0AgentIds.length} Tier 0 agent(s)`);

    // Emit planning agents spawned event
    if (this.subsystems.eventEmitter) {
      this.subsystems.eventEmitter.emit('planning_agents_spawned', {
        agentIds: tier0AgentIds,
        tier: 0,
        timestamp: new Date().toISOString()
      });
    }
    
    // Store remaining tiers for sequential spawning via coordinator
    const pendingTiers = [];
    if (classified.tier1.length > 0) pendingTiers.push({ tier: 1, missions: classified.tier1 });
    if (classified.tier2.length > 0) pendingTiers.push({ tier: 2, missions: classified.tier2 });
    if (classified.tier3.length > 0) pendingTiers.push({ tier: 3, missions: classified.tier3 });
    
    if (pendingTiers.length > 0 && this.subsystems.clusterStateStore) {
      await this.subsystems.clusterStateStore.set('pending_agent_tiers', {
        tiers: pendingTiers,
        deliverableSpec: deliverableSpec,
        missionGoalIds: missionGoalIds,
        researchDigest,
        currentTierToSpawn: 1,
        createdAt: new Date().toISOString()
      });
      
      this.logger?.info(`   📦 ${pendingTiers.length} tier(s) queued for sequential spawning`);
      this.logger?.info('   ℹ️  Meta-coordinator will spawn subsequent tiers as dependencies complete');
    } else if (pendingTiers.length > 0) {
      this.logger?.warn('   ⚠️  No state store available - cannot persist pending tiers');
      this.logger?.warn('   ⚠️  All agents will spawn immediately (no tier ordering)');
      
      // Fallback: spawn all remaining tiers now
      for (const tierData of pendingTiers) {
        const additionalIds = await this.spawnMissions(tierData.missions, deliverableSpec, missionGoalIds, tierData.tier, researchDigest);
        tier0AgentIds.push(...additionalIds); // Collect all agent IDs
      }
    }

    return tier0AgentIds; // Return all spawned agent IDs
  }

  /**
   * Classify agent missions by dependency tier
   * 
   * Tier 0: Data collectors - can work with empty memory
   * Tier 1: Processors - need source data in memory
   * Tier 2: Creators - need processed results
   * Tier 3: Validators - need created outputs
   */
  classifyMissionsByTier(missions) {
    const tiers = { tier0: [], tier1: [], tier2: [], tier3: [] };
    
    for (let i = 0; i < missions.length; i++) {
      const mission = missions[i];
      const type = mission.type;
      
      // Store original index for goal mapping
      const missionWithIndex = { ...mission, originalIndex: i };
      
      // Tier 0: Can work with empty memory (gather external data, provision environment)
      if (['research', 'planning', 'exploration', 'dataacquisition', 'infrastructure'].includes(type)) {
        tiers.tier0.push(missionWithIndex);
      }
      // Tier 1: Need source data in memory (processors, generalists)
      else if (['analysis', 'synthesis', 'document_analysis', 'code_execution', 'ide', 'datapipeline', 'automation'].includes(type)) {
        tiers.tier1.push(missionWithIndex);
      }
      // Tier 2: Need processed results
      else if (['document_creation', 'code_creation'].includes(type)) {
        tiers.tier2.push(missionWithIndex);
      }
      // Tier 3: Need created outputs
      else if (['integration', 'completion', 'quality_assurance', 'consistency', 'disconfirmation'].includes(type)) {
        tiers.tier3.push(missionWithIndex);
      }
      // Unknown types default to Tier 1 (safe middle ground)
      else {
        this.logger?.warn(`Unknown agent type ${type}, assigning to Tier 1`);
        tiers.tier1.push(missionWithIndex);
      }
    }
    
    return tiers;
  }

  /**
   * Spawn all agents in a specific tier
   */
  async spawnMissions(missions, deliverableSpec, missionGoalIds, tierNumber, researchDigest = null) {
    const agentWeights = this.config.coordinator?.agentTypeWeights || {};
    const spawnedAgentIds = []; // Track agent IDs for waiting

    for (const mission of missions) {
      // Check if type is explicitly disabled in configuration (weight === 0)
      // Missing weights are treated as enabled — the LLM planner chose this type for a reason
      if (mission.type in agentWeights && !(agentWeights[mission.type] > 0)) {
        this.logger?.warn(`   ⏭️  Skipping ${mission.type} (disabled in config, weight=0)`);
        continue;
      }

      // Find pre-generated goalId for this mission
      const goalMapping = missionGoalIds.find(m => m.missionIdx === mission.originalIndex);
      const goalId = goalMapping?.goalId || `goal_guided_${mission.type}_${Date.now()}`;

      // CRITICAL FIX (Jan 20, 2026): Include taskId for artifact registration
      // Calculate taskId from mission index (same logic as task creation at line 1396)
      const associatedTaskId = Number.isInteger(mission.originalIndex) 
        ? `task:phase${mission.originalIndex + 1}`
        : null;

      const missionSpec = {
        missionId: `mission_tier${tierNumber}_${mission.type}_${Date.now()}`,
        agentType: mission.type,
        goalId: goalId,
        taskId: associatedTaskId, // CRITICAL: Link to task for artifact registration
        description: mission.mission,
        successCriteria: mission.successCriteria || [mission.expectedOutput || 'Complete successfully'],
        deliverable: deliverableSpec,
        tools: mission.tools || [],
        maxDuration: getAgentTimeout(mission.type),
        createdBy: 'guided_mode_planner',
        spawnCycle: 0,
        triggerSource: 'guided_planner',
        spawningReason: `tier_${tierNumber}_setup`,
        priority: mission.priority === 'high' ? 1.0 : mission.priority === 'low' ? 0.3 : 0.6,
        provenanceChain: [],
        tier: tierNumber,
        metadata: {
          ...(mission.metadata || {}),
          guidedMission: true,
          sourceScope: mission.sourceScope || mission.metadata?.sourceScope || `${mission.type} tier ${tierNumber}`,
          artifactInputs: Array.isArray(mission.artifactInputs)
            ? mission.artifactInputs
            : Array.isArray(mission.metadata?.artifactInputs)
              ? mission.metadata.artifactInputs
              : [],
          expectedOutput: mission.expectedOutput || mission.metadata?.expectedOutput || null,
          researchDigest: researchDigest || mission.metadata?.researchDigest || null
        }
      };

      try {
        // ✅ FIX P1.2: PRE-ASSIGN pattern to eliminate race condition
        // Mark task as "spawn in progress" BEFORE spawning agent
        // This prevents PlanScheduler from spawning duplicate during the spawn window
        const stateStore = this.subsystems.clusterStateStore;
        let task = null;
        
        if (stateStore && Number.isInteger(mission.originalIndex)) {
          const taskId = `task:phase${mission.originalIndex + 1}`;
          try {
            task = await stateStore.getTask(taskId);
            if (task && !task.assignedAgentId) {
              // Mark as "being assigned" to prevent race condition
              task.assignedAgentId = 'PENDING_SPAWN';
              task.metadata = task.metadata || {};
              task.metadata.spawnInProgress = true;
              task.metadata.spawnStarted = Date.now();
              task.metadata.goalId = missionSpec.goalId;  // Ensure consistent goalId
              task.updatedAt = Date.now();
              await stateStore.upsertTask(task);
              
              this.logger?.debug('📌 Task pre-assigned before spawn', {
                taskId,
                goalId: missionSpec.goalId,
                marker: 'PENDING_SPAWN'
              });
            }
          } catch (e) {
            this.logger?.warn('Could not pre-assign task', { 
              taskId,
              error: e.message 
            });
            // Continue - spawn will proceed even if pre-assignment fails
          }
        }
        
        // NOW spawn agent (with task pre-marked)
        this.logger?.info(`   Spawning: ${mission.type} - ${mission.mission.substring(0, 60)}...`);
        const agentId = await this.subsystems.agentExecutor.spawnAgent(missionSpec);
        
        if (agentId) {
          spawnedAgentIds.push(agentId); // Track for waiting
          this.logger?.info(`      ✓ ${agentId}`);

          // Update task with REAL agentId (replacing PENDING_SPAWN marker)
          if (task && stateStore) {
            try {
              task.assignedAgentId = agentId;  // Replace marker with real ID
              delete task.metadata.spawnInProgress;
              task.metadata.spawnCompleted = Date.now();
              task.metadata.spawnDurationMs = Date.now() - task.metadata.spawnStarted;
              task.updatedAt = Date.now();
              await stateStore.upsertTask(task);
              
              this.logger?.debug('✅ Task updated with real agentId', {
                taskId: task.id,
                agentId,
                spawnDurationMs: task.metadata.spawnDurationMs
              });
            } catch (e) {
              this.logger?.warn('Could not update task with agentId', {
                taskId: task.id,
                error: e.message
              });
              // Non-fatal - agent is spawned, bookkeeping can be repaired later
            }
          }
        } else {
          // Spawn failed - clear pending marker
          if (task && stateStore) {
            try {
              task.assignedAgentId = null;  // Clear marker
              delete task.metadata.spawnInProgress;
              task.metadata.spawnFailed = Date.now();
              task.metadata.spawnFailureReason = 'executor_returned_null';
              task.updatedAt = Date.now();
              await stateStore.upsertTask(task);
              
              this.logger?.warn('⚠️  Cleared pre-assignment (spawn failed)', {
                taskId: task.id
              });
            } catch (e) {
              // Best-effort cleanup
            }
          }
        }
      } catch (error) {
        this.logger?.error(`      ✗ Failed: ${error.message}`);
        
        // Clear pending marker on error
        if (task && stateStore) {
          try {
            task.assignedAgentId = null;
            delete task.metadata.spawnInProgress;
            task.metadata.spawnError = error.message;
            await stateStore.upsertTask(task);
          } catch (e) {
            // Best-effort cleanup
          }
        }
      }
    }

    return spawnedAgentIds; // Return agent IDs instead of count
  }

  /**
   * Parse structured task phases from guided context
   * Looks for patterns like:
   * "PHASE 1 - Discovery: Do X"
   * "PHASE 1 - Name:" (with description on next lines)
   * "═══ PHASE 3 - Synthesis ═══"
   * 
   * @param {string} context - The guided focus context
   * @returns {Array} Array of phase objects
   */
  parseTaskPhases(context) {
    if (!context) {
      return [];
    }

    const phases = [];

    // First try explicit PHASE markers
    const explicitPhases = this.parseExplicitPhases(context);

    // Then try natural language sequential patterns
    const sequentialPhases = this.parseSequentialPatterns(context);

    // Combine and deduplicate
    const allPhases = [...explicitPhases, ...sequentialPhases];
    const uniquePhases = this.deduplicatePhases(allPhases);

    // Build dependency chains
    const phasesWithDeps = this.buildDependencyChains(uniquePhases, context);

    this.logger?.info(`Parsed ${phasesWithDeps.length} task phases with dependencies`, {
      explicitPhases: explicitPhases.length,
      sequentialPhases: sequentialPhases.length,
      phases: phasesWithDeps.map(p => `Phase ${p.number}: ${p.name} (deps: ${p.dependencies?.length || 0})`)
    });

    return phasesWithDeps.sort((a, b) => a.number - b.number);
  }

  /**
   * Parse explicit PHASE markers (existing functionality)
   */
  parseExplicitPhases(context) {
    const phases = [];
    const lines = context.split('\n');
    let currentPhase = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Match: "PHASE 1 - Name:" or "PHASE 1: Name"
      const phaseMatch = line.match(/(?:═+\s*)?PHASE\s+(\d+)\s*[-:]\s*([^:]+):\s*$/i);

      if (phaseMatch) {
        // Save previous phase if exists
        if (currentPhase) {
          phases.push(currentPhase);
        }

        // Start new phase
        currentPhase = {
          number: parseInt(phaseMatch[1]),
          name: phaseMatch[2].trim(),
          description: '',
          lines: [],
          source: 'explicit_phase'
        };
      } else if (currentPhase && line && !line.match(/^[═\-#]+$/)) {
        // Add to current phase description
        currentPhase.lines.push(line);
      }
    }

    // Don't forget last phase
    if (currentPhase) {
      phases.push(currentPhase);
    }

    // Format descriptions
    phases.forEach(phase => {
      phase.description = phase.lines
        .slice(0, 5)
        .join(' ')
        .substring(0, 300);
      phase.rawText = phase.lines.join('\n').substring(0, 1000);
    });

    return phases;
  }

  /**
   * Parse natural language sequential patterns
   * Detects patterns like: "first research X, then document Y, then create Z"
   */
  parseSequentialPatterns(context) {
    const phases = [];

    // Pattern 1: "first X, then Y, then Z"
    const firstThenPattern = /(?:^|\.)\s*first(?:ly)?\s+([^,]+?),\s*then\s+([^,]+?)(?:,\s*then\s+([^,]+?))?(?:\s*\.|\s*$)/gi;
    let match;

    while ((match = firstThenPattern.exec(context)) !== null) {
      const [, first, second, third] = match;

      if (first) phases.push(this.createPhaseFromText(first.trim(), 1, 'first'));
      if (second) phases.push(this.createPhaseFromText(second.trim(), 2, 'then'));
      if (third) phases.push(this.createPhaseFromText(third.trim(), 3, 'then'));
    }

    // Pattern 2: "X and then Y"
    const andThenPattern = /(?:^|\.)\s*([^,]+?)\s+and\s+then\s+([^,]+?)(?:\s*\.|\s*$)/gi;

    while ((match = andThenPattern.exec(context)) !== null) {
      const [, first, second] = match;

      // Check if this overlaps with previous patterns
      const existingPhase = phases.find(p =>
        p.description.toLowerCase().includes(first.toLowerCase().substring(0, 50))
      );

      if (!existingPhase) {
        phases.push(this.createPhaseFromText(first.trim(), phases.length + 1, 'and_then'));
        phases.push(this.createPhaseFromText(second.trim(), phases.length + 2, 'and_then'));
      }
    }

    // Pattern 3: "after X, Y" or "following X, Y"
    const afterPattern = /(?:^|\.)\s*(?:after|following)\s+([^,]+?),\s*([^,]+?)(?:\s*\.|\s*$)/gi;

    while ((match = afterPattern.exec(context)) !== null) {
      const [, prerequisite, task] = match;

      phases.push(this.createPhaseFromText(prerequisite.trim(), phases.length + 1, 'prerequisite'));
      phases.push(this.createPhaseFromText(task.trim(), phases.length + 2, 'after'));
    }

    return phases;
  }

  /**
   * Create a phase object from text description
   */
  createPhaseFromText(text, number, pattern) {
    // Extract agent type hints from text
    const agentType = this.inferAgentType(text);

    return {
      number,
      name: this.extractPhaseName(text),
      description: text.substring(0, 300),
      rawText: text.substring(0, 1000),
      source: pattern,
      agentTypeHint: agentType,
      inferredDependencies: this.inferDependencies(text, pattern)
    };
  }

  /**
   * Extract a meaningful name from phase text
   */
  extractPhaseName(text) {
    // Look for action words or key phrases
    const nameMatch = text.match(/(?:create|build|generate|research|analyze|document|write|develop)\s+([^,\.;]+?)(?:\s|$)/i);
    if (nameMatch) {
      return nameMatch[1].trim();
    }

    // Fallback to first few words
    return text.split(/\s+/).slice(0, 3).join(' ').substring(0, 50);
  }

  /**
   * Infer agent type from phase description
   * 
   * IDE-FIRST PARADIGM: When ideFirst.enabled, default to 'ide' instead of null
   * Only use 'research' for explicit web search/investigation tasks
   */
  inferAgentType(text) {
    const lowerText = text.toLowerCase();

    // Research agent for web search tasks (specialized for multi-query, source triangulation)
    if (lowerText.includes('research') || lowerText.includes('investigate sources') ||
        lowerText.includes('web search') || lowerText.includes('gather sources')) {
      return 'research';
    }
    
    // IDE-FIRST MODE: Default to IDEAgent for everything else
    if (this.config?.ideFirst?.enabled) {
      return 'ide';
    }
    
    // LEGACY MODE: Pattern matching
    if (lowerText.includes('document') || lowerText.includes('write') || lowerText.includes('create') && lowerText.includes('documentation')) {
      return 'document_creation';
    }
    if (lowerText.includes('code') || lowerText.includes('script') || lowerText.includes('application') || lowerText.includes('tool')) {
      return 'code_creation';
    }
    if (lowerText.includes('analyze') || lowerText.includes('examine') || lowerText.includes('study')) {
      return 'analysis';
    }

    return null; // No specific hint
  }

  /**
   * Infer dependencies from phase text and pattern
   */
  inferDependencies(text, pattern) {
    const dependencies = [];

    // Sequential patterns imply dependency on previous phase
    if (pattern === 'then' || pattern === 'after') {
      dependencies.push('previous');
    }

    // Look for prerequisite language
    if (text.toLowerCase().includes('based on') || text.toLowerCase().includes('using')) {
      dependencies.push('context_required');
    }

    return dependencies;
  }

  /**
   * Deduplicate phases and merge information
   */
  deduplicatePhases(phases) {
    const unique = [];

    for (const phase of phases) {
      // Check if we already have a similar phase
      const existing = unique.find(p =>
        p.description.toLowerCase().includes(phase.description.toLowerCase().substring(0, 50))
      );

      if (existing) {
        // Merge information
        if (phase.agentTypeHint && !existing.agentTypeHint) {
          existing.agentTypeHint = phase.agentTypeHint;
        }
        if (phase.inferredDependencies?.length && !existing.inferredDependencies?.length) {
          existing.inferredDependencies = phase.inferredDependencies;
        }
      } else {
        unique.push(phase);
      }
    }

    return unique;
  }

  /**
   * Build dependency chains between phases
   */
  buildDependencyChains(phases, originalContext) {
    // Assign sequential numbers and build dependencies
    return phases.map((phase, index) => {
      const sequentialNumber = index + 1;

      // Build dependency information
      const dependencies = [];

      // Sequential dependencies
      if (sequentialNumber > 1) {
        dependencies.push(`phase_${sequentialNumber - 1}`);
      }

      // Context dependencies
      if (phase.inferredDependencies?.includes('context_required')) {
        dependencies.push('context_available');
      }

      // Agent type dependencies
      if (phase.agentTypeHint === 'document_creation') {
        // Document creation typically needs research results
        dependencies.push('research_complete');
      }

      if (phase.agentTypeHint === 'code_creation') {
        // Code creation might need documentation or research
        dependencies.push('documentation_available');
      }

      return {
        ...phase,
        number: sequentialNumber,
        dependencies,
        dependencyType: this.determineDependencyType(phase, originalContext)
      };
    });
  }

  /**
   * Determine the type of dependency for a phase
   */
  determineDependencyType(phase, context) {
    if (phase.source === 'explicit_phase') {
      return 'explicit';
    }
    if (phase.source === 'first' || phase.source === 'then') {
      return 'sequential';
    }
    if (phase.source === 'after' || phase.source === 'prerequisite') {
      return 'prerequisite';
    }
    return 'contextual';
  }

  /**
   * Get directories to scan based on config allowedPaths
   * ALWAYS uses configuration from launch script - never extracts from text
   */
  getDirectoriesToScan(guidedFocus) {
    // PRIMARY METHOD: Use configured allowedPaths from launch script
    // This is what the user explicitly selected during setup
    const mcpServers = this.config?.mcp?.client?.servers;
    const allowedPaths = mcpServers?.[0]?.allowedPaths;
    
    if (allowedPaths && allowedPaths.length > 0) {
      this.logger?.info('📁 Using file access paths from launch configuration', { paths: allowedPaths });
      return allowedPaths.map(p => p.replace(/\/$/, '')); // Remove trailing slashes
    }

    // If no paths configured, system should not attempt file access
    // This indicates user selected "No file access" in launch script
    this.logger?.warn('⚠️ No file access paths configured');
    this.logger?.warn('💡 Use launch script and select "Custom directories" to configure file access');
    this.logger?.warn('💡 Falling back to external research only (no file reading)');
    
    return []; // Return empty array - don't access any files
  }

  /**
   * Generate high-priority goals from task phases
   * These goals will be injected with maximum priority
   * 
   * @param {Array} taskPhases - Parsed phases
   * @param {Object} guidedFocus - Guided focus config
   * @returns {Array} Goal objects ready for injection
   */
  generateTaskGoalsFromPhases(taskPhases, guidedFocus) {
    if (taskPhases.length === 0) {
      return [];
    }

    const executionMode = normalizeExecutionMode('guided', guidedFocus.executionMode).effectiveMode;
    const taskPriority = guidedFocus.taskPriority || 1.0;

    return taskPhases.map((phase, index) => {
      // Create a goal for each phase with dependency information
      const goal = {
        description: `[TASK PHASE ${phase.number}] ${phase.name}: ${phase.description}`,
        source: 'guided_task_phase',
        priority: taskPriority,  // Maximum priority (default 1.0)
        isTaskGoal: true,
        phaseNumber: phase.number,
        totalPhases: taskPhases.length,
        executionMode,
        createdBy: 'guided_mode_planner',
        createdAt: new Date(),

        // NEW: Sequential workflow metadata
        sequentialDependencies: phase.dependencies || [],
        dependencyType: phase.dependencyType || 'contextual',
        agentTypeHint: phase.agentTypeHint,
        phaseSource: phase.source,

        // NEW: Execution control
        canExecuteAutonomously: this.canExecuteAutonomously(phase, taskPhases),
        requiresContextFrom: this.getRequiredContext(phase, taskPhases),

        // NEW: Progress tracking
        expectedDuration: this.estimatePhaseDuration(phase),
        checkpointRequirements: this.getCheckpointRequirements(phase)
      };

      return goal;
    });
  }

  /**
   * Determine if a phase can execute autonomously or needs dependencies
   */
  canExecuteAutonomously(phase, allPhases) {
    // First phase can always execute
    if (phase.number === 1) {
      return true;
    }

    // Check if dependencies are met
    if (phase.dependencies?.length > 0) {
      // If it has sequential dependencies, it needs previous phases to complete
      if (phase.dependencies.some(dep => dep.startsWith('phase_'))) {
        return false;
      }

      // If it has context dependencies, it can execute but will query for context
      if (phase.dependencies.includes('context_available')) {
        return true;
      }
    }

    return true;
  }

  /**
   * Get what context this phase requires from previous phases
   */
  getRequiredContext(phase, allPhases) {
    const requiredContext = [];

    if (phase.agentTypeHint === 'document_creation') {
      // Document creation needs research results
      const researchPhases = allPhases.filter(p =>
        p.agentTypeHint === 'research' && p.number < phase.number
      );
      if (researchPhases.length > 0) {
        requiredContext.push('research_findings');
      }
    }

    if (phase.agentTypeHint === 'code_creation') {
      // Code creation might need documentation or research
      const docPhases = allPhases.filter(p =>
        p.agentTypeHint === 'document_creation' && p.number < phase.number
      );
      if (docPhases.length > 0) {
        requiredContext.push('documentation_content');
      }

      const researchPhases = allPhases.filter(p =>
        p.agentTypeHint === 'research' && p.number < phase.number
      );
      if (researchPhases.length > 0) {
        requiredContext.push('research_specifications');
      }
    }

    return requiredContext;
  }

  /**
   * Estimate duration for a phase based on its characteristics
   */
  estimatePhaseDuration(phase) {
    const baseDuration = 10; // 10 minutes base

    // Adjust based on agent type
    switch (phase.agentTypeHint) {
      case 'research':
        return baseDuration + 5; // Research takes longer
      case 'document_creation':
        return baseDuration + 8; // Documentation takes time
      case 'code_creation':
        return baseDuration + 12; // Code creation can be complex
      case 'analysis':
        return baseDuration + 6; // Analysis is moderate
      default:
        return baseDuration;
    }
  }

  /**
   * Get checkpoint requirements for a phase
   */
  getCheckpointRequirements(phase) {
    const checkpoints = [];

    // All phases should have basic completion validation
    checkpoints.push('completion_validation');

    // High-impact phases need additional review
    if (phase.agentTypeHint === 'code_creation' && phase.description.toLowerCase().includes('deploy')) {
      checkpoints.push('deployment_review');
    }

    if (phase.dependencies?.includes('research_complete')) {
      checkpoints.push('research_validation');
    }

    return checkpoints;
  }

  /**
   * Inject task goals into goal system with guided-exclusive priority.
   * 
   * @param {Array} taskGoals - Goals generated from phases
   * @param {string} executionMode - guided-exclusive
   */
  async injectTaskGoals(taskGoals, executionMode, guidedFocus) {
    this.logger?.info('');
    this.logger?.info('🎯 Injecting task goals into goal system...');
    
    for (const taskGoal of taskGoals) {
      try {
        // Use the addGoal method from intrinsic goal system
        const specializationTags = new Set();
        if (taskGoal.agentTypeHint) {
          specializationTags.add(String(taskGoal.agentTypeHint));
        }
        if (guidedFocus?.domain) {
          specializationTags.add(String(guidedFocus.domain));
        }

        const added = await this.subsystems.goals.addGoal({
          description: taskGoal.description,
          discoveredFrom: taskGoal.source,
          priority: taskGoal.priority,
          metadata: {
            isTaskGoal: true,
            phaseNumber: taskGoal.phaseNumber,
            totalPhases: taskGoal.totalPhases,
            executionMode: taskGoal.executionMode,
            injectedAt: new Date(),
            agentTypeHint: taskGoal.agentTypeHint || null,
            dependencyType: taskGoal.dependencyType || null,
            sequentialDependencies: Array.isArray(taskGoal.sequentialDependencies)
              ? [...taskGoal.sequentialDependencies]
              : [],
            requiresContextFrom: Array.isArray(taskGoal.requiresContextFrom)
              ? [...taskGoal.requiresContextFrom]
              : [],
            expectedDuration: taskGoal.expectedDuration || null,
            checkpointRequirements: Array.isArray(taskGoal.checkpointRequirements)
              ? [...taskGoal.checkpointRequirements]
              : [],
            guidedDomain: guidedFocus?.domain || null,
            guidedContextSnippet: guidedFocus?.context
              ? String(guidedFocus.context).slice(0, 240)
              : null,
            specializationTags: Array.from(specializationTags)
          }
        });
        
        if (added) {
          this.logger?.info(`   ✓ Task goal ${taskGoal.phaseNumber}/${taskGoal.totalPhases} injected with priority ${taskGoal.priority}`);
        }
      } catch (error) {
        this.logger?.warn(`Failed to inject task goal: ${error.message}`);
      }
    }
    
    this.logger?.info('   📌 GUIDED-EXCLUSIVE MODE: task goals remain the only active execution path');
    
    this.logger?.info('✅ Task goals injected successfully');
  }
}

module.exports = { GuidedModePlanner };
