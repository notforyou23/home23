/**
 * PlanExecutor - The TRUE Plan Authority (Rebuilt Jan 21, 2026)
 * 
 * SINGLE RESPONSIBILITY: Execute plans correctly and completely.
 * 
 * This is THE authority for plan execution. The orchestrator delegates
 * all plan-related decisions to this component.
 * 
 * Key Principles:
 * 1. Uses taskId (not goalId) for agent correlation
 * 2. Checks both active AND completed agents
 * 3. Has robust validation with artifact verification
 * 4. Records events to progress spine
 * 5. Handles all edge cases (retries, failures, phase advancement)
 * 
 * Authority:
 * - Activate/advance phases
 * - Start/complete/fail tasks
 * - Assign agents to tasks
 * - Detect agent completion via taskId
 * - Validate task output
 * - Handle retries and failures
 * - Complete plans and start queued plans
 */

const fs = require('fs').promises;
const path = require('path');

class PlanExecutor {
  constructor(stateStore, agentExecutor, logger, options = {}) {
    this.stateStore = stateStore;
    this.agentExecutor = agentExecutor;
    this.logger = logger;
    this.pathResolver = options.pathResolver || null;
    this.taskStateQueue = options.taskStateQueue || null;
    
    // Record plan events callback (for progress spine)
    this.recordPlanEvent = options.recordPlanEvent || (() => {});
    
    // Complete plan state (synced every tick)
    this.plan = null;
    this.phases = [];           // All phases/milestones
    this.tasks = [];            // All tasks
    this.activePhase = null;    // Currently active phase
    this.activeTask = null;     // Currently active task (IN_PROGRESS or CLAIMED)
    this.taskAgent = null;      // Agent working on active task (if any)
    
    // Queue of plans waiting to execute
    this.planQueue = [];
    
    // Execution history (for debugging/learning)
    this.history = [];
    
    // Tracking
    this.lastSync = 0;
    this.cycleCount = 0;
    
    // Configuration
    this.maxRetries = options.maxRetries || 3;
    this.agentTimeout = options.agentTimeout || 720000; // 12 minutes
  }

  // ═══════════════════════════════════════════════════════════════
  // AWARENESS - Know everything about the plan
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sync ALL plan state from storage
   * This is THE source of truth about plan status
   */
  async sync() {
    this.lastSync = Date.now();
    
    // Get the main plan
    this.plan = await this.stateStore.getPlan('plan:main');
    
    if (!this.plan) {
      // No active plan - check queue
      await this.checkPlanQueue();
      return;
    }
    
    // Get ALL phases (milestones)
    this.phases = await this.stateStore.listMilestones(this.plan.id);
    this.phases.sort((a, b) => a.order - b.order);
    
    // Get ALL tasks
    this.tasks = await this.stateStore.listTasks(this.plan.id);
    
    // Identify active phase
    this.activePhase = this.phases.find(p => p.status === 'ACTIVE');
    
    // Identify active task (IN_PROGRESS or CLAIMED)
    this.activeTask = this.tasks.find(t => 
      t.state === 'IN_PROGRESS' || t.state === 'CLAIMED'
    );
    
    // Get agent for active task - USE TASKID, check ALL agents (including completed)
    this.taskAgent = null;
    if (this.activeTask) {
      const registry = this.agentExecutor?.registry;
      if (registry) {
        // First: Check by assignedAgentId (if we know which agent)
        if (this.activeTask.assignedAgentId && 
            this.activeTask.assignedAgentId !== 'PENDING_SPAWN') {
          // Use new method that checks completed agents too
          this.taskAgent = registry.getAgentIncludingCompleted(
            this.activeTask.assignedAgentId
          );
        }
        
        // Fallback: Check by taskId (finds any agent working on this task)
        if (!this.taskAgent) {
          const taskStatus = registry.getTaskAgentStatus(this.activeTask.id);
          if (taskStatus.hasActiveAgent) {
            this.taskAgent = taskStatus.activeAgent;
          } else if (taskStatus.hasCompletedWork) {
            // Agent completed! Get the most recent one
            this.taskAgent = taskStatus.allCompleted[taskStatus.allCompleted.length - 1];
          }
        }
      }
    }
    
    // Log awareness level (debug only)
    this.logger.debug('📋 PlanExecutor synced', {
      plan: this.plan?.id,
      status: this.plan?.status,
      phases: `${this.phases.filter(p => p.status === 'COMPLETED').length}/${this.phases.length}`,
      tasks: `${this.tasks.filter(t => t.state === 'DONE').length}/${this.tasks.length}`,
      activePhase: this.activePhase?.title,
      activeTask: this.activeTask?.title,
      taskAgent: this.taskAgent?.agent?.agentId || this.taskAgent?.agentId || null,
      taskAgentStatus: this.taskAgent?.status
    }, 4);
  }

  /**
   * Get complete snapshot of plan state (for API/debugging)
   */
  getSnapshot() {
    return {
      plan: {
        id: this.plan?.id,
        title: this.plan?.title,
        status: this.plan?.status
      },
      phases: this.phases.map(p => ({
        id: p.id,
        title: p.title,
        order: p.order,
        status: p.status,
        taskCount: this.tasks.filter(t => t.milestoneId === p.id).length,
        doneCount: this.tasks.filter(t => t.milestoneId === p.id && t.state === 'DONE').length
      })),
      activePhase: this.activePhase?.title,
      activeTask: this.activeTask ? {
        id: this.activeTask.id,
        title: this.activeTask.title,
        state: this.activeTask.state,
        agentId: this.taskAgent?.agent?.agentId || this.taskAgent?.agentId
      } : null,
      progress: this.calculateProgress(),
      queuedPlans: this.planQueue.length
    };
  }

  calculateProgress() {
    if (!this.tasks.length) return 0;
    const done = this.tasks.filter(t => t.state === 'DONE').length;
    return Math.round((done / this.tasks.length) * 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN EXECUTION TICK - Called every cycle
  // ═══════════════════════════════════════════════════════════════

  /**
   * Main execution tick - THE authority for plan execution
   * @param {number} cycleCount - Current orchestrator cycle
   */
  async tick(cycleCount = 0) {
    this.cycleCount = cycleCount;
    await this.sync();
    
    // No active plan
    if (!this.plan) {
      return this.record({ action: 'NO_PLAN', checked: 'planQueue' });
    }
    
    // Plan already complete
    if (this.plan.status === 'COMPLETED') {
      return await this.handlePlanComplete();
    }
    
    // === PHASE MANAGEMENT ===
    const phaseAction = await this.checkPhase();
    if (phaseAction) return phaseAction;
    
    // === TASK MANAGEMENT ===
    const taskAction = await this.checkTask();
    if (taskAction) return taskAction;
    
    // === AGENT MANAGEMENT ===
    const agentAction = await this.checkAgent();
    if (agentAction) return agentAction;
    
    // Everything on track
    return this.record({
      action: 'ON_TRACK',
      phase: this.activePhase?.title,
      task: this.activeTask?.title,
      agent: this.taskAgent?.agent?.agentId || this.taskAgent?.agentId,
      agentStatus: this.taskAgent?.status,
      progress: this.calculateProgress()
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async checkPhase() {
    // No active phase - need to activate one
    if (!this.activePhase) {
      const nextPhase = this.phases.find(p => p.status === 'LOCKED');
      if (nextPhase) {
        return await this.activatePhase(nextPhase);
      }
      // All phases done or no phases - check if plan complete
      const allDone = this.phases.length > 0 && 
                     this.phases.every(p => p.status === 'COMPLETED');
      if (allDone) {
        return await this.completePlan();
      }
      return null;
    }
    
    // Check if active phase is complete
    const phaseTasks = this.tasks.filter(t => t.milestoneId === this.activePhase.id);
    const allDone = phaseTasks.length > 0 && phaseTasks.every(t => t.state === 'DONE');
    
    if (allDone) {
      return await this.advancePhase();
    }
    
    // Check for blocked phase (all remaining tasks failed)
    const pendingOrProgress = phaseTasks.filter(t => 
      t.state === 'PENDING' || t.state === 'IN_PROGRESS' || t.state === 'CLAIMED'
    );
    const failedTasks = phaseTasks.filter(t => t.state === 'FAILED');
    
    if (pendingOrProgress.length === 0 && failedTasks.length > 0) {
      // All tasks either DONE or FAILED, but not all DONE
      return await this.handlePhaseBlocked(failedTasks);
    }
    
    return null; // Phase is progressing normally
  }

  async activatePhase(phase) {
    this.logger.info(`🚀 PlanExecutor: ACTIVATING PHASE: ${phase.title}`, {
      order: phase.order,
      totalPhases: this.phases.length
    });
    
    await this.stateStore.upsertMilestone({
      ...phase,
      status: 'ACTIVE',
      activatedAt: Date.now()
    });
    
    // Record to progress spine
    this.recordPlanEvent('phase_activated', {
      phaseNumber: phase.order,
      phaseName: phase.title,
      description: `Phase ${phase.order} activated: ${phase.title}`
    });
    
    return this.record({
      action: 'PHASE_ACTIVATED',
      phase: phase.title,
      order: phase.order
    });
  }

  async advancePhase() {
    const completedTaskCount = this.tasks.filter(
      t => t.milestoneId === this.activePhase.id && t.state === 'DONE'
    ).length;
    
    this.logger.info(`✅ PlanExecutor: PHASE COMPLETE: ${this.activePhase.title}`, {
      tasksCompleted: completedTaskCount
    });
    
    // Mark current phase complete
    await this.stateStore.upsertMilestone({
      ...this.activePhase,
      status: 'COMPLETED',
      completedAt: Date.now()
    });
    
    // Record to progress spine
    this.recordPlanEvent('phase_completed', {
      phaseNumber: this.activePhase.order,
      phaseName: this.activePhase.title,
      description: `Phase ${this.activePhase.order} complete: ${this.activePhase.title}`,
      tasksCompleted: completedTaskCount
    });
    
    // Find and activate next phase
    const nextPhase = this.phases.find(p => 
      p.order > this.activePhase.order && p.status === 'LOCKED'
    );
    
    if (nextPhase) {
      await this.stateStore.upsertMilestone({
        ...nextPhase,
        status: 'ACTIVE',
        activatedAt: Date.now()
      });
      
      return this.record({
        action: 'PHASE_ADVANCED',
        completed: this.activePhase.title,
        next: nextPhase.title
      });
    }
    
    // No more phases - plan complete
    return await this.completePlan();
  }

  async handlePhaseBlocked(failedTasks) {
    // Check if any can be retried
    for (const task of failedTasks) {
      const retryCount = task.metadata?.retryCount || 0;
      if (retryCount < this.maxRetries) {
        return await this.retryTask(task);
      }
    }
    
    // All retries exhausted
    this.logger.error('🚨 PlanExecutor: PHASE BLOCKED - All tasks failed', {
      phase: this.activePhase?.title,
      failedTasks: failedTasks.map(t => t.title)
    });
    
    this.recordPlanEvent('phase_blocked', {
      phaseNumber: this.activePhase?.order,
      phaseName: this.activePhase?.title,
      description: `Phase ${this.activePhase?.order} blocked: All tasks failed after max retries`,
      failedTasks: failedTasks.map(t => t.title)
    });
    
    return this.record({
      action: 'PHASE_BLOCKED',
      phase: this.activePhase?.title,
      failedTasks: failedTasks.map(t => t.id)
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TASK MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async checkTask() {
    // No active task - need to start one
    if (!this.activeTask) {
      const nextTask = await this.findNextTask();
      if (nextTask) {
        return await this.startTask(nextTask);
      }
      return null; // No tasks ready (deps not met)
    }
    
    // Active task has no agent - assign one
    if (!this.taskAgent && !this.activeTask.assignedAgentId) {
      return await this.assignAgent();
    }
    
    return null; // Task is being worked on
  }

  async findNextTask() {
    if (!this.activePhase) return null;
    
    const phaseTasks = this.tasks.filter(t => 
      t.milestoneId === this.activePhase.id && t.state === 'PENDING'
    );
    
    // Check dependencies for each
    for (const task of phaseTasks.sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
      const depsOk = await this.checkDeps(task);
      if (depsOk) {
        return task;
      }
    }
    
    return null;
  }

  async checkDeps(task) {
    if (!task.deps || task.deps.length === 0) return true;
    
    for (const depId of task.deps) {
      const dep = this.tasks.find(t => t.id === depId);
      if (!dep || dep.state !== 'DONE') {
        return false;
      }
    }
    return true;
  }

  async startTask(task) {
    this.logger.info(`📌 PlanExecutor: STARTING TASK: ${task.title}`, {
      taskId: task.id,
      phase: this.activePhase?.title,
      priority: task.priority
    });
    
    await this.stateStore.startTask(task.id, 'plan_executor');
    
    // Record to progress spine
    const phaseNum = task.id.match(/phase(\d+)/)?.[1] || '?';
    this.recordPlanEvent('task_started', {
      taskId: task.id,
      phaseNumber: phaseNum,
      phaseName: task.title,
      description: `Task started: ${task.title}`
    });
    
    return this.record({
      action: 'TASK_STARTED',
      taskId: task.id,
      title: task.title,
      phase: this.activePhase?.title
    });
  }

  async completeTask(task, artifacts = []) {
    this.logger.info(`✅ PlanExecutor: COMPLETING TASK: ${task.title}`, {
      taskId: task.id,
      artifacts: artifacts.length
    });
    
    // Use queue if available for consistency
    if (this.taskStateQueue) {
      await this.taskStateQueue.enqueue({
        type: 'COMPLETE_TASK',
        taskId: task.id,
        cycle: this.cycleCount,
        phaseName: task.title,
        artifactCount: artifacts.length,
        source: 'plan_executor'
      });
    } else {
      await this.stateStore.completeTask(task.id, {
        completedAt: Date.now(),
        artifacts
      });
    }
    
    // Record to progress spine
    const phaseNum = task.id.match(/phase(\d+)/)?.[1] || '?';
    this.recordPlanEvent('phase_completed', {
      phaseNumber: phaseNum,
      phaseName: task.title,
      description: `Phase ${phaseNum} complete: ${task.title}`,
      artifacts: artifacts.length
    });
    
    return this.record({
      action: 'TASK_COMPLETED',
      taskId: task.id,
      title: task.title,
      artifacts: artifacts.length
    });
  }

  async failTask(task, reason) {
    // FIX (Jan 21, 2026): FINAL CHECK - scan disk for artifacts before failing
    // This is the last line of defense - goal agents might have created files
    this.logger.info('[PlanExecutor] FINAL CHECK: Scanning disk for artifacts before fail...');
    const finalValidation = await this.validateTaskOutput([]);

    if (finalValidation.passed && finalValidation.artifacts.length > 0) {
      this.logger.info(`🎉 PlanExecutor: RESCUE! Artifacts found on final disk scan - NOT failing task`, {
        taskId: task.id,
        artifactsFound: finalValidation.artifacts.length,
        originalReason: reason
      });
      return await this.completeTask(task, finalValidation.artifacts);
    }

    this.logger.warn(`❌ PlanExecutor: FAILING TASK: ${task.title}`, {
      taskId: task.id,
      reason,
      finalArtifactCheck: finalValidation.artifacts?.length || 0
    });

    // Use queue if available
    if (this.taskStateQueue) {
      await this.taskStateQueue.enqueue({
        type: 'FAIL_TASK',
        taskId: task.id,
        cycle: this.cycleCount,
        phaseName: task.title,
        reason,
        source: 'plan_executor'
      });
    } else {
      await this.stateStore.failTask(task.id, reason);
    }
    
    // Record to progress spine
    const phaseNum = task.id.match(/phase(\d+)/)?.[1] || '?';
    const retryCount = (task.metadata?.retryCount || 0) + 1;
    this.recordPlanEvent('phase_failed', {
      phaseNumber: phaseNum,
      phaseName: task.title,
      description: `Phase ${phaseNum} failed (attempt ${retryCount}): ${reason}`,
      reason
    });
    
    return this.record({
      action: 'TASK_FAILED',
      taskId: task.id,
      title: task.title,
      reason
    });
  }

  async retryTask(task) {
    const newRetryCount = (task.metadata?.retryCount || 0) + 1;
    
    this.logger.info(`🔄 PlanExecutor: RETRYING TASK: ${task.title}`, {
      taskId: task.id,
      attempt: newRetryCount,
      maxRetries: this.maxRetries
    });
    
    // Update metadata and reset to PENDING
    const updatedTask = {
      ...task,
      state: 'PENDING',
      assignedAgentId: null,
      metadata: {
        ...task.metadata,
        retryCount: newRetryCount,
        lastRetryAt: Date.now(),
        lastFailureReason: task.failureReason
      }
    };
    
    await this.stateStore.upsertTask(updatedTask);
    
    this.recordPlanEvent('task_retrying', {
      taskId: task.id,
      phaseName: task.title,
      description: `Retrying task (attempt ${newRetryCount}/${this.maxRetries}): ${task.title}`,
      attempt: newRetryCount
    });
    
    return this.record({
      action: 'TASK_RETRIED',
      taskId: task.id,
      title: task.title,
      attempt: newRetryCount
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // AGENT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async checkAgent() {
    if (!this.activeTask) return null;
    
    // Get comprehensive status from registry (using taskId!)
    const registry = this.agentExecutor?.registry;
    if (!registry) return null;
    
    const taskStatus = registry.getTaskAgentStatus(this.activeTask.id);

    // CRITICAL LOGGING (Jan 21, 2026): Track task agent status for plan execution debugging
    this.logger.info('[PlanExecutor] checkAgent - task status', {
      taskId: this.activeTask.id,
      taskTitle: this.activeTask.title,
      hasAccomplishedWork: taskStatus.hasAccomplishedWork,
      hasActiveAgent: taskStatus.hasActiveAgent,
      hasCompletedWork: taskStatus.hasCompletedWork,
      completedCount: taskStatus.completedCount,
      accomplishedCount: taskStatus.accomplishedCount
    }, 3);

    // === CASE 1: Agent completed with accomplishment ===
    if (taskStatus.hasAccomplishedWork && !taskStatus.hasActiveAgent) {
      this.logger.info('[PlanExecutor] Task completing via accomplishment!', {
        taskId: this.activeTask.id,
        taskTitle: this.activeTask.title,
        accomplishedAgents: taskStatus.allAccomplished.map(a => (a.agent || a).agentId)
      }, 2);
      return await this.handleAgentComplete(taskStatus.allAccomplished);
    }
    
    // === CASE 2: Agent completed but NOT accomplished (produced no output) ===
    if (taskStatus.hasCompletedWork && !taskStatus.hasAccomplishedWork && !taskStatus.hasActiveAgent) {
      const unaccomplished = taskStatus.allCompleted.filter(a => {
        const agent = a.agent || a;
        return agent.accomplishment?.accomplished !== true;
      });
      
      if (unaccomplished.length > 0) {
        return await this.handleAgentUnaccomplished(unaccomplished);
      }
    }
    
    // === CASE 3: Agent is still active - check for timeout ===
    if (taskStatus.hasActiveAgent) {
      const agent = taskStatus.activeAgent.agent || taskStatus.activeAgent;
      const runtime = Date.now() - (agent.startTime || Date.now());
      
      if (runtime > this.agentTimeout) {
        return await this.handleAgentTimeout(taskStatus.activeAgent);
      }
      
      // Agent working normally
      return null;
    }
    
    // === CASE 4: No agent at all - need to assign one ===
    if (!this.activeTask.assignedAgentId || 
        this.activeTask.assignedAgentId === 'PENDING_SPAWN') {
      return await this.assignAgent();
    }
    
    // === CASE 5: Agent failed ===
    if (taskStatus.allFailed && taskStatus.allFailed.length > 0) {
      const failedAgent = taskStatus.allFailed[taskStatus.allFailed.length - 1];
      if (failedAgent) {
        return await this.handleAgentFailed(failedAgent);
      }
    }
    
    return null;
  }

  async assignAgent() {
    const agentType = this.determineAgentType(this.activeTask);
    
    this.logger.info(`🤖 PlanExecutor: ASSIGNING ${agentType.toUpperCase()} AGENT`, {
      task: this.activeTask.title,
      taskId: this.activeTask.id,
      phase: this.activePhase?.title
    });
    
    // Build comprehensive mission spec
    const missionSpec = {
      missionId: `plan_${this.activeTask.id}_${Date.now()}`,
      agentType,
      goalId: null, // Tasks use taskId, not goalId
      taskId: this.activeTask.id, // THE key correlation field
      planId: this.plan.id,
      milestoneId: this.activePhase?.id,
      description: this.activeTask.description || this.activeTask.title,
      // FIX (Jan 21, 2026): Don't pass strict acceptance criteria as success criteria
      // The rubrics like "Minimum 1500 words" and ">=50 sources" made agents too conservative
      // Keep acceptance criteria for VALIDATION only, not as agent instructions
      // Instead, give agents encouraging, goal-oriented criteria
      successCriteria: [
        `Complete the task: ${this.activeTask.title}`,
        'Produce comprehensive, substantive outputs',
        'Create all relevant artifacts and documentation'
      ],
      // Store acceptance criteria separately for post-completion validation
      acceptanceCriteria: this.activeTask.acceptanceCriteria || [],
      deliverable: this.activeTask.deliverable || null,
      maxDuration: this.agentTimeout,
      createdBy: 'plan_executor',
      triggerSource: 'plan_execution',
      spawningReason: 'task_assigned',
      priority: this.activeTask.priority || 1.0,
      spawnCycle: this.cycleCount,
      metadata: {
        planTitle: this.plan.title,
        phaseTitle: this.activePhase?.title,
        phaseNumber: this.activePhase?.order,
        taskTitle: this.activeTask.title,
        isPlanTask: true,
        guidedMission: true,
        sourceScope: this.activeTask.metadata?.sourceScope || null,
        artifactInputs: this.activeTask.metadata?.artifactInputs || [],
        expectedOutput: this.activeTask.metadata?.expectedOutput || null,
        researchDigest: this.activeTask.metadata?.researchDigest || null,
        // Minimal coordination context
        coordinationContext: {
          taskId: this.activeTask.id,
          taskTitle: this.activeTask.title,
          planId: this.plan.id,
          planTitle: this.plan.title,
          phaseNumber: this.activePhase?.order,
          phaseTitle: this.activePhase?.title
        }
      }
    };

    // Promote action-oriented fields for agent visibility
    missionSpec.sourceScope = this.activeTask.metadata?.sourceScope || null;
    missionSpec.expectedOutput = this.activeTask.metadata?.expectedOutput || null;
    missionSpec.artifactInputs = this.activeTask.metadata?.artifactInputs || [];

    const agentId = await this.agentExecutor.spawnAgent(missionSpec);
    
    if (agentId) {
      // Update task with agent assignment
      const updatedTask = {
        ...this.activeTask,
        assignedAgentId: agentId,
        agentAssignedAt: Date.now()
      };
      
      await this.stateStore.upsertTask(updatedTask);
      
      return this.record({
        action: 'AGENT_ASSIGNED',
        agentId,
        agentType,
        taskId: this.activeTask.id,
        taskTitle: this.activeTask.title
      });
    } else {
      if (missionSpec.metadata?.spawnGateBlocked) {
        this.logger.warn('🚫 PlanExecutor: task spawn blocked by SpawnGate', {
          taskId: this.activeTask.id,
          reason: missionSpec.metadata.spawnGateReason
        });

        const blockedTask = {
          ...this.activeTask,
          state: 'BLOCKED',
          failureReason: missionSpec.metadata.spawnGateReason,
          metadata: {
            ...(this.activeTask.metadata || {}),
            spawnGateBlocked: true,
            spawnGateReason: missionSpec.metadata.spawnGateReason,
            spawnGateEvidence: missionSpec.metadata.spawnGateEvidence || null,
            retryCount: Math.max(3, this.activeTask.metadata?.retryCount || 0)
          },
          updatedAt: Date.now()
        };

        await this.stateStore.upsertTask(blockedTask);

        return this.record({
          action: 'TASK_BLOCKED_BY_SPAWN_GATE',
          taskId: this.activeTask.id,
          agentType,
          reason: missionSpec.metadata.spawnGateReason
        });
      }

      this.logger.error('❌ PlanExecutor: Failed to spawn agent', {
        task: this.activeTask.title,
        agentType
      });
      
      // Release task back to PENDING so it can be retried
      await this.stateStore.releaseTask(this.activeTask.id, 'plan_executor');
      
      return this.record({
        action: 'AGENT_SPAWN_FAILED',
        taskId: this.activeTask.id,
        agentType
      });
    }
  }

  /**
   * Determine agent type based on metadata, keyword detection, or defaults.
   * Supports all registered agent types including execution agents.
   */
  determineAgentType(task) {
    const VALID_AGENT_TYPES = [
      'research', 'ide',
      'dataacquisition', 'datapipeline', 'infrastructure', 'automation',
      'analysis', 'synthesis', 'exploration', 'planning',
      'code_execution', 'code_creation', 'document_creation',
      'document_analysis', 'document_compiler', 'codebase_exploration',
      'quality_assurance', 'completion', 'consistency', 'disconfirmation',
      'integration', 'specialized_binary'
    ];

    const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();

    // Honor explicit metadata if set to any valid agent type
    if (task.metadata?.agentType && VALID_AGENT_TYPES.includes(task.metadata.agentType)) {
      return task.metadata.agentType;
    }

    // Execution agent detection (before research detection)
    const needsDataAcquisition = text.includes('scrape') || text.includes('crawl') ||
      text.includes('download data') || text.includes('fetch data') || text.includes('ingest data') ||
      text.includes('collect from') || text.includes('gather from') ||
      text.includes('extract from website') || text.includes('extract from web') ||
      text.includes('api call') || text.includes('web data') ||
      text.includes('pull data from') || text.includes('get data from') ||
      text.includes('harvest') || text.includes('retrieve from');
    const needsDataPipeline = (text.includes('database') && (text.includes('create') || text.includes('build') || text.includes('load'))) ||
      text.includes('transform data') || text.includes('etl') || text.includes('load into') ||
      text.includes('sqlite') || text.includes('duckdb') ||
      text.includes('csv to') || text.includes('json to database') ||
      text.includes('normalize data') || text.includes('clean data') ||
      text.includes('import data') || text.includes('data processing') ||
      text.includes('data transformation') || text.includes('create table') ||
      text.includes('load records') || text.includes('schema');
    const needsInfrastructure = text.includes('container') || text.includes('docker') ||
      text.includes('provision') || text.includes('service setup') ||
      text.includes('environment') || text.includes('install dependencies') ||
      text.includes('setup environment') || text.includes('configure service');
    const needsAutomation = text.includes('automate') || text.includes('organize files') ||
      text.includes('batch process') || text.includes('rename files') ||
      text.includes('file operations') || text.includes('convert files') ||
      text.includes('bulk rename') || text.includes('process files') ||
      text.includes('zip') || text.includes('archive') || text.includes('cleanup');

    if (needsDataAcquisition) return 'dataacquisition';
    if (needsDataPipeline) return 'datapipeline';
    if (needsInfrastructure) return 'infrastructure';
    if (needsAutomation) return 'automation';

    // Explicit web research indicators
    const needsWeb =
      (text.includes('research') &&
       !text.includes('research the code') &&
       !text.includes('research codebase') &&
       !text.includes('research existing')) ||
      text.includes('find sources') ||
      text.includes('gather sources') ||
      text.includes('search online') ||
      text.includes('web search') ||
      text.includes('look up online') ||
      text.includes('current information') ||
      text.includes('latest information') ||
      text.includes('external sources') ||
      text.includes('find information about') ||
      task.tags?.includes('research') ||
      task.tags?.includes('web_search') ||
      task.metadata?.agentType === 'research';

    return needsWeb ? 'research' : 'ide';
  }

  async handleAgentComplete(accomplishedAgents) {
    this.logger.info(`✅ PlanExecutor: AGENT(S) COMPLETED WITH OUTPUT`, {
      taskId: this.activeTask.id,
      accomplishedCount: accomplishedAgents.length
    });
    
    // Validate the task output
    const validation = await this.validateTaskOutput(accomplishedAgents);
    
    if (validation.passed) {
      return await this.completeTask(this.activeTask, validation.artifacts);
    } else {
      // Output didn't meet criteria - retry
      this.logger.warn('⚠️  PlanExecutor: Task output incomplete, retrying', {
        task: this.activeTask.title,
        reason: validation.reason
      });
      return await this.retryTask(this.activeTask);
    }
  }

  async handleAgentUnaccomplished(unaccomplishedAgents) {
    const firstAgent = unaccomplishedAgents[0];
    const agent = firstAgent.agent || firstAgent;
    const reason = agent.accomplishment?.reason || 'Agent completed without producing useful output';

    this.logger.warn(`⚠️  PlanExecutor: AGENT UNACCOMPLISHED`, {
      taskId: this.activeTask.id,
      agentId: agent.agentId,
      reason
    });

    // FIX (Jan 21, 2026): Before retrying/failing, check if artifacts exist on disk
    // A goal agent or previous attempt might have already created the required files
    // This is crucial because goal-based work should count toward task completion
    this.logger.info('[PlanExecutor] Checking disk for artifacts before retry/fail...');
    const validation = await this.validateTaskOutput(unaccomplishedAgents);

    if (validation.passed && validation.artifacts.length > 0) {
      this.logger.info(`✅ PlanExecutor: ARTIFACTS FOUND ON DISK - completing task despite agent not accomplishing`, {
        taskId: this.activeTask.id,
        artifactsFound: validation.artifacts.length,
        sources: [...new Set(validation.artifacts.map(a => a.source))]
      });
      return await this.completeTask(this.activeTask, validation.artifacts);
    }

    this.logger.info('[PlanExecutor] No artifacts found on disk, proceeding with retry/fail', {
      artifactsChecked: validation.artifacts?.length || 0,
      passed: validation.passed
    });

    const retryCount = this.activeTask.metadata?.retryCount || 0;
    if (retryCount < this.maxRetries) {
      return await this.retryTask(this.activeTask);
    } else {
      return await this.failTask(this.activeTask, reason);
    }
  }

  async handleAgentFailed(failedAgentState) {
    // Safety check: ensure we have a valid agent state
    if (!failedAgentState) {
      this.logger.error(`💀 PlanExecutor: handleAgentFailed called with undefined agent state`);
      return await this.failTask(this.activeTask, 'Agent state undefined');
    }

    const agent = failedAgentState.agent || failedAgentState;
    const error = failedAgentState.error || agent?.error;

    this.logger.warn(`💀 PlanExecutor: AGENT FAILED`, {
      agentId: agent?.agentId || 'unknown',
      task: this.activeTask?.title,
      error: error?.message || 'Unknown error'
    });

    // FIX (Jan 21, 2026): Check for existing artifacts before retrying
    // Goal agents or previous attempts might have created the required files
    this.logger.info('[PlanExecutor] Checking disk for artifacts before retry...');
    const validation = await this.validateTaskOutput([failedAgentState]);

    if (validation.passed && validation.artifacts.length > 0) {
      this.logger.info(`✅ PlanExecutor: ARTIFACTS FOUND ON DISK - completing task despite agent failure`, {
        taskId: this.activeTask?.id,
        artifactsFound: validation.artifacts.length
      });
      return await this.completeTask(this.activeTask, validation.artifacts);
    }

    // Retry if possible
    return await this.retryTask(this.activeTask);
  }

  async handleAgentTimeout(activeAgentState) {
    const agent = activeAgentState.agent || activeAgentState;
    
    this.logger.warn(`⏰ PlanExecutor: AGENT TIMEOUT`, {
      agentId: agent.agentId,
      task: this.activeTask?.title,
      runtime: Math.round((Date.now() - agent.startTime) / 1000) + 's'
    });
    
    // Stop the agent
    if (agent.requestStop) {
      await agent.requestStop('timeout');
    }
    
    // Retry the task
    return await this.retryTask(this.activeTask);
  }

  // ═══════════════════════════════════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════════════════════════════════

  async validateTaskOutput(accomplishedAgents) {
    const criteria = this.activeTask.acceptanceCriteria || [];
    
    // Gather artifacts from agents
    const artifacts = [];
    for (const agentState of accomplishedAgents) {
      const agent = agentState.agent || agentState;
      const results = agent.results || [];
      
      for (const result of results) {
        artifacts.push({
          type: result.type || 'finding',
          content: result.content || result.text || result.summary,
          path: result.path,
          metadata: result.metadata,
          source: agent.agentId,
          timestamp: new Date()
        });
      }
    }
    
    // Also check task.artifacts (registered by AgentExecutor)
    if (this.activeTask.artifacts && Array.isArray(this.activeTask.artifacts)) {
      for (const taskArtifact of this.activeTask.artifacts) {
        artifacts.push({
          type: 'file',
          path: taskArtifact.path,
          absolutePath: taskArtifact.absolutePath,
          size: taskArtifact.size,
          source: taskArtifact.agentId,
          timestamp: new Date(taskArtifact.recordedAt || Date.now())
        });
      }
    }
    
    // Check for files on disk if we have a path resolver
    // FIX (Jan 21, 2026): Add logging and improve disk scan robustness
    if (this.pathResolver) {
      const outputDir = this.pathResolver.getPhaseOutputDir?.(this.activePhase?.id) ||
                       this.pathResolver.resolve?.('@outputs');

      this.logger.debug('[PlanExecutor] Disk scan for artifacts', {
        hasPathResolver: true,
        outputDir,
        phaseId: this.activePhase?.id
      });

      if (outputDir) {
        try {
          const files = await fs.readdir(outputDir);
          let filesFoundOnDisk = 0;

          for (const file of files) {
            // Skip directories and hidden files
            if (file.startsWith('.')) continue;

            const filePath = path.join(outputDir, file);
            const stat = await fs.stat(filePath);

            if (stat.isFile() && !artifacts.some(a => a.path?.includes(file))) {
              artifacts.push({
                type: 'file',
                path: file,
                absolutePath: filePath,
                size: stat.size,
                source: 'disk_scan'
              });
              filesFoundOnDisk++;
            }
          }

          this.logger.info('[PlanExecutor] Disk scan complete', {
            outputDir,
            totalFiles: files.length,
            artifactsFound: filesFoundOnDisk,
            totalArtifacts: artifacts.length
          });
        } catch (e) {
          // Log the error instead of silently swallowing it
          this.logger.warn('[PlanExecutor] Disk scan failed', {
            outputDir,
            error: e.message
          });
        }
      } else {
        this.logger.warn('[PlanExecutor] No output directory resolved for disk scan');
      }
    } else {
      this.logger.debug('[PlanExecutor] No pathResolver available for disk scan');
    }
    
    // No criteria = auto-pass if there are any artifacts
    if (criteria.length === 0) {
      return {
        passed: artifacts.length > 0,
        artifacts,
        reason: artifacts.length > 0 ? null : 'No artifacts produced'
      };
    }
    
    // Basic validation: has results
    if (artifacts.length === 0) {
      return {
        passed: false,
        artifacts: [],
        reason: 'No artifacts produced despite acceptance criteria'
      };
    }
    
    // For now, accept if we have artifacts
    // Future: More sophisticated criteria matching
    return {
      passed: true,
      artifacts,
      reason: null
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PLAN LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  async completePlan() {
    this.logger.info('🎉 PlanExecutor: PLAN COMPLETE!', {
      planId: this.plan.id,
      title: this.plan.title,
      phasesCompleted: this.phases.filter(p => p.status === 'COMPLETED').length,
      tasksCompleted: this.tasks.filter(t => t.state === 'DONE').length
    });
    
    await this.stateStore.updatePlan(this.plan.id, {
      status: 'COMPLETED',
      completedAt: Date.now()
    });
    
    this.recordPlanEvent('plan_completed', {
      planId: this.plan.id,
      planTitle: this.plan.title,
      description: `Plan complete: ${this.plan.title}`,
      phases: this.phases.length,
      tasks: this.tasks.length
    });
    
    // Check for next plan in queue
    const nextPlan = this.planQueue.shift();
    
    return this.record({
      action: 'PLAN_COMPLETED',
      planId: this.plan.id,
      title: this.plan.title,
      nextPlan: nextPlan?.id || null
    });
  }

  async handlePlanComplete() {
    // Check queue for next plan
    if (this.planQueue.length > 0) {
      return await this.startNextPlan();
    }
    
    return this.record({
      action: 'IDLE',
      reason: 'Plan complete, no queued plans'
    });
  }

  async startNextPlan() {
    const nextPlan = this.planQueue.shift();
    
    this.logger.info(`📋 PlanExecutor: STARTING NEXT PLAN: ${nextPlan.title}`);
    
    // Activate the queued plan
    await this.stateStore.createPlan({
      ...nextPlan,
      id: 'plan:main',
      status: 'ACTIVE'
    });
    
    return this.record({
      action: 'NEXT_PLAN_STARTED',
      planId: nextPlan.id,
      title: nextPlan.title
    });
  }

  /**
   * Queue a plan for execution after current plan completes
   */
  queuePlan(plan) {
    this.planQueue.push(plan);
    this.logger.info(`📥 PlanExecutor: PLAN QUEUED: ${plan.title}`, {
      queueSize: this.planQueue.length
    });
  }

  async checkPlanQueue() {
    if (this.planQueue.length > 0) {
      return await this.startNextPlan();
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTORY & STATUS
  // ═══════════════════════════════════════════════════════════════

  record(event) {
    const entry = {
      ...event,
      timestamp: Date.now(),
      cycle: this.cycleCount,
      planProgress: this.calculateProgress()
    };
    
    this.history.push(entry);
    
    // Keep last 100 events
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }
    
    return entry;
  }

  getHistory() {
    return this.history;
  }

  /**
   * Get comprehensive status for API/dashboard
   */
  getStatus() {
    return {
      planId: this.plan?.id,
      planTitle: this.plan?.title,
      planStatus: this.plan?.status,
      progress: this.calculateProgress(),
      currentPhase: this.activePhase?.title,
      phaseNumber: this.activePhase?.order,
      totalPhases: this.phases.length,
      completedPhases: this.phases.filter(p => p.status === 'COMPLETED').length,
      currentTask: this.activeTask?.title,
      taskId: this.activeTask?.id,
      taskState: this.activeTask?.state,
      assignedAgent: this.taskAgent?.agent?.agentId || this.taskAgent?.agentId,
      agentStatus: this.taskAgent?.status,
      totalTasks: this.tasks.length,
      completedTasks: this.tasks.filter(t => t.state === 'DONE').length,
      failedTasks: this.tasks.filter(t => t.state === 'FAILED').length,
      queuedPlans: this.planQueue.length,
      lastSync: this.lastSync
    };
  }
}

module.exports = { PlanExecutor };
