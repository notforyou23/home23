/**
 * PlanScheduler - Task selection and scheduling for plan-driven execution
 * 
 * Selects runnable tasks from active plans based on:
 * - Task priority
 * - Specialization matching
 * - Dependency satisfaction
 * - TTL-based work stealing
 */

class PlanScheduler {
  constructor(stateStore, instanceId, config, logger) {
    this.stateStore = stateStore;
    this.instanceId = instanceId;
    this.config = config || {};
    this.logger = logger;
    
    // Configuration
    this.claimTtlMs = config.planning?.scheduler?.claimTtlMs || 600000; // 10 minutes
    this.stealThresholdMs = config.planning?.scheduler?.stealThresholdMs || 60000; // 1 minute before expiry
    this.specializationEnabled = config.planning?.scheduler?.specializationEnabled !== false;
    
    // Specialization profile (if provided)
    this.specializationProfile = null;
  }

  /**
   * Get the next runnable task for this instance
   * 
   * @param {object} profile - Specialization profile
   * @returns {object|null} - Claimed task or null
   */
  async nextRunnableTask(profile) {
    try {
      // Update specialization profile
      if (profile && this.specializationEnabled) {
        this.specializationProfile = profile;
      }
      
      // Get active plan from state store
      const activePlan = await this.stateStore.getPlan('plan:main');
      if (!activePlan || activePlan.status !== 'ACTIVE') {
        this.logger?.debug('[PlanScheduler] No active plan found');
        return null;
      }
      
      // NEW: Check if we already have an active task in progress
      // This ensures the orchestrator continues to work on and validate
      // the task it has already claimed.
      const inProgressTasks = await this.stateStore.listTasks(activePlan.id, { 
        state: 'IN_PROGRESS', 
        claimedBy: this.instanceId 
      });
      
      if (inProgressTasks.length > 0) {
        this.logger?.debug('[PlanScheduler] Continuing existing in-progress task', {
          taskId: inProgressTasks[0].id
        });
        return inProgressTasks[0];
      }
      
      // Get runnable tasks
      const runnableTasks = await this.stateStore.listRunnableTasks(activePlan.id);
      
      if (runnableTasks.length === 0) {
        // PLAN INTEGRITY (Jan 20, 2026): If plan is blocked, try to unblock by retrying failed tasks
        const unblockedTask = await this.handleBlockedPlan(activePlan.id);
        if (unblockedTask) {
          // Re-attempt claim on the now-pending task
          const claimed = await this.stateStore.claimTask(unblockedTask.id, this.instanceId, this.claimTtlMs);
          if (claimed) return unblockedTask;
        }

        this.logger?.debug('[PlanScheduler] No runnable tasks available');
        return null;
      }
      
      // Score and sort tasks
      const scoredTasks = runnableTasks.map(task => {
        const basePriority = task.priority || 1;
        const specializationWeight = this.getSpecializationWeight(task);
        const urgencyMultiplier = this.calculateUrgencyMultiplier(task);
        
        return {
          ...task,
          basePriority,
          specializationWeight,
          urgencyMultiplier,
          effectiveScore: basePriority * specializationWeight * urgencyMultiplier
        };
      });
      
      // Sort by effective score descending
      scoredTasks.sort((a, b) => b.effectiveScore - a.effectiveScore);
      
      // Iterate and attempt to claim until success
      for (const task of scoredTasks) {
        const claimed = await this.stateStore.claimTask(
          task.id,
          this.instanceId,
          this.claimTtlMs
        );
        
        if (claimed) {
          this.logger?.info('[PlanScheduler] Task claimed', {
            taskId: task.id,
            title: task.title,
            score: task.effectiveScore
          });
          return task;
        }
      }
      
      // No tasks claimed, try work stealing
      const allTasks = await this.stateStore.listTasks(activePlan.id);
      const stealableTasks = this.findStealableTasks(allTasks);
      
      if (stealableTasks.length > 0) {
        return await this.attemptWorkStealing(stealableTasks);
      }
      
      return null;
    } catch (error) {
      this.logger?.error('[PlanScheduler] nextRunnableTask error', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Handle a blocked plan by checking for failed tasks that can be retried
   * 
   * @param {string} planId
   * @returns {object|null} - Retried task or null
   */
  async handleBlockedPlan(planId) {
    try {
      // Get all tasks for this plan
      const allTasks = await this.stateStore.listTasks(planId);
      
      // Find tasks that are FAILED or BLOCKED and belonging to the active milestone
      const failedTasks = allTasks.filter(t => t.state === 'FAILED' || t.state === 'BLOCKED');
      
      if (failedTasks.length === 0) return null;

      // Find the first blocked task (lowest ID or phase)
      // Sort by phase number in ID (e.g. task:phase2 < task:phase3)
      failedTasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

      for (const task of failedTasks) {
        const retryCount = task.metadata?.retryCount || 0;
        
        // Safety limit: 3 retries
        if (retryCount < 3) {
          this.logger?.info('[PlanScheduler] Detected blocked plan, attempting auto-retry', {
            taskId: task.id,
            retryCount: retryCount + 1,
            lastFailure: task.failureReason
          });

          const success = await this.stateStore.retryTask(task.id, 'auto_retry_blocked_plan');
          if (success) {
            // Return the task object (state will be updated to PENDING by retryTask)
            return await this.stateStore.getTask(task.id);
          }
        } else {
          this.logger?.warn('[PlanScheduler] Task has reached max retries, cannot auto-unblock plan', {
            taskId: task.id,
            retryCount
          });
        }
      }

      return null;
    } catch (error) {
      this.logger?.error('[PlanScheduler] handleBlockedPlan error', { error: error.message });
      return null;
    }
  }

  /**
   * Get specialization weight for a task (reuse GoalAllocator pattern)
   * 
   * @param {object} task - Task to evaluate
   * @returns {number} - Specialization weight (higher = better match)
   */
  getSpecializationWeight(task) {
    if (!this.specializationProfile || !this.specializationEnabled) {
      return 1;
    }
    
    if (!task || typeof task !== 'object') {
      return 1;
    }
    
    const tags = task.tags || [];
    let modifier = this.specializationProfile.baseline || 1;
    let matched = false;
    
    const applyBoost = () => {
      modifier *= this.specializationProfile.boost || 2;
      matched = true;
    };
    
    const applyPenalty = () => {
      modifier *= this.specializationProfile.penalty || 0.5;
    };
    
    // Check tags against specialization domains
    if (this.specializationProfile.domains) {
      for (const tag of tags) {
        const tagLower = tag.toLowerCase();
        if (this.specializationProfile.domains.has(tagLower)) {
          applyBoost();
        } else if (this.specializationProfile.avoidDomains?.has(tagLower)) {
          applyPenalty();
        }
      }
    }
    
    // Check tags against agent types
    if (this.specializationProfile.agentTypes) {
      for (const tag of tags) {
        const tagLower = tag.toLowerCase();
        if (this.specializationProfile.agentTypes.has(tagLower)) {
          applyBoost();
        } else if (this.specializationProfile.avoidAgentTypes?.has(tagLower)) {
          applyPenalty();
        }
      }
    }
    
    // If no match but has specialization, apply non-preferred penalty
    if (!matched && this.specializationProfile.nonPreferredPenalty) {
      return this.specializationProfile.nonPreferredPenalty;
    }
    
    return modifier;
  }

  /**
   * Calculate urgency multiplier based on due date or other factors
   * 
   * @param {object} task - Task to evaluate
   * @returns {number} - Urgency multiplier (higher = more urgent)
   */
  calculateUrgencyMultiplier(task) {
    // Default urgency
    let urgency = 1;
    
    // If task has a due date, increase urgency as it approaches
    if (task.dueDate) {
      const now = Date.now();
      const timeUntilDue = task.dueDate - now;
      
      if (timeUntilDue < 0) {
        // Past due - highest urgency
        urgency = 3;
      } else if (timeUntilDue < 86400000) {
        // Due within 24 hours
        urgency = 2;
      } else if (timeUntilDue < 604800000) {
        // Due within 7 days
        urgency = 1.5;
      }
    }
    
    // Tasks in the active milestone get higher urgency
    // (This would require checking against plan.activeMilestone, but we'll keep it simple)
    
    return urgency;
  }

  /**
   * Find tasks that can be stolen (expired or expiring claims)
   * 
   * @param {array} allTasks - All tasks in the plan
   * @returns {array} - Stealable tasks
   */
  findStealableTasks(allTasks) {
    const now = Date.now();
    const stealable = [];
    
    for (const task of allTasks) {
      // Only consider claimed or in-progress tasks
      if (task.state !== 'CLAIMED' && task.state !== 'IN_PROGRESS') {
        continue;
      }
      
      if (!task.claimedBy || task.claimedBy === this.instanceId) {
        continue; // Not claimed by another instance
      }
      
      // Check specialization
      if (this.specializationProfile) {
        const weight = this.getSpecializationWeight(task);
        if (weight <= (this.specializationProfile.nonPreferredPenalty || 0.1) * 1.1) {
          continue; // Not a good match for us
        }
      }
      
      const claimExpires = task.claimExpires || 0;
      const timeUntilExpiry = claimExpires - now;
      
      // If claim expires within threshold, it's stealable
      if (timeUntilExpiry > 0 && timeUntilExpiry <= this.stealThresholdMs) {
        stealable.push({
          ...task,
          timeUntilExpiry,
          canStealAt: claimExpires
        });
      }
      
      // If claim already expired, definitely stealable
      if (claimExpires <= now) {
        stealable.push({
          ...task,
          timeUntilExpiry: 0,
          canStealAt: now
        });
      }
    }
    
    // Sort by expiry (steal most expired first)
    stealable.sort((a, b) => a.canStealAt - b.canStealAt);
    
    return stealable;
  }

  /**
   * Attempt to steal work from expiring/expired claims
   * 
   * @param {array} stealableTasks - Tasks that can be stolen
   * @returns {object|null} - Stolen task or null
   */
  async attemptWorkStealing(stealableTasks) {
    const now = Date.now();
    
    for (const task of stealableTasks) {
      // Check specialization again
      if (this.specializationProfile) {
        const weight = this.getSpecializationWeight(task);
        if (weight <= (this.specializationProfile.nonPreferredPenalty || 0.1) * 1.1) {
          continue;
        }
      }
      
      // Wait if not yet expired
      if (task.canStealAt > now) {
        const waitMs = task.canStealAt - now;
        if (waitMs > 1000) continue; // Don't wait more than 1s
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      
      // Release the task first
      const released = await this.stateStore.releaseTask(task.id, task.claimedBy);
      
      if (!released) {
        continue; // Couldn't release, move to next
      }
      
      // Attempt to claim
      const claimed = await this.stateStore.claimTask(
        task.id,
        this.instanceId,
        this.claimTtlMs
      );
      
      if (claimed) {
        this.logger?.info('[PlanScheduler] Task stolen from expired claim', {
          taskId: task.id,
          title: task.title,
          previousOwner: task.claimedBy
        });
        return task;
      }
    }
    
    return null;
  }
}

module.exports = PlanScheduler;

