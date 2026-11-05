/**
 * Strategic Goals Tracker
 * 
 * Tracks urgent goals created by Meta-Coordinator and ensures they are:
 * 1. Prioritized for execution
 * 2. Monitored for progress
 * 3. Reported back to Meta-Coordinator
 * 4. Escalated if ignored
 * 
 * This closes the loop between strategic planning and execution.
 */
class StrategicGoalsTracker {
  constructor(logger) {
    this.logger = logger;
    
    // Tracking data structures
    this.strategicGoals = new Map(); // goalId -> tracking data
    this.reviewCycles = new Map(); // reviewCycle -> Set of goalIds
    this.executionHistory = []; // Audit trail
    
    // Configuration
    this.escalationThreshold = 3; // Cycles before escalation
    this.maxAge = 10; // Cycles before marking stale
    
    // Stats
    this.stats = {
      totalCreated: 0,
      totalCompleted: 0,
      totalEscalated: 0,
      totalStale: 0,
      activeCount: 0
    };
  }
  
  /**
   * Register urgent goals created during a review
   */
  registerUrgentGoals(reviewCycle, urgentGoalSpecs, createdGoals) {
    const cycleGoals = new Set();
    
    for (let i = 0; i < createdGoals.length; i++) {
      const goal = createdGoals[i];
      const spec = urgentGoalSpecs[i];
      
      const tracking = {
        goalId: goal.id,
        reviewCycle,
        createdAt: Date.now(),
        spec: {
          description: spec.description,
          agentType: spec.agentType,
          priority: spec.priority,
          urgency: spec.urgency,
          rationale: spec.rationale
        },
        status: 'pending', // pending, in_progress, completed, stale, escalated
        progress: 0,
        lastChecked: Date.now(),
        cyclesIgnored: 0,
        escalationLevel: 0,
        completedAt: null,
        completionEvidence: null
      };
      
      this.strategicGoals.set(goal.id, tracking);
      cycleGoals.add(goal.id);
      this.stats.totalCreated++;
      this.stats.activeCount++;
    }
    
    this.reviewCycles.set(reviewCycle, cycleGoals);
    
    this.logger.info('📌 Registered strategic goals for tracking', {
      reviewCycle,
      count: createdGoals.length,
      activeTracked: this.stats.activeCount
    });
  }
  
  /**
   * Update status of a strategic goal
   */
  updateGoalStatus(goalId, status, progress = null, evidence = null) {
    const tracking = this.strategicGoals.get(goalId);
    if (!tracking) return;
    
    const previousStatus = tracking.status;
    tracking.status = status;
    tracking.lastChecked = Date.now();
    
    if (progress !== null) {
      tracking.progress = progress;
    }
    
    if (status === 'completed') {
      tracking.completedAt = Date.now();
      tracking.completionEvidence = evidence;
      this.stats.activeCount--;
      this.stats.totalCompleted++;
      
      this.logger.info('✅ Strategic goal completed', {
        goalId,
        cyclesToComplete: this.getCurrentCycle() - tracking.reviewCycle,
        evidence: evidence?.substring(0, 100)
      });
    }
    
    // Record status change
    this.executionHistory.push({
      timestamp: Date.now(),
      goalId,
      previousStatus,
      newStatus: status,
      progress,
      evidence: evidence?.substring(0, 200)
    });
  }
  
  /**
   * Check progress of strategic goals (called each cycle)
   */
  checkProgress(currentCycle, goalsSystem, activeAgents) {
    const updates = {
      progressing: [],
      stalled: [],
      needsEscalation: [],
      completed: []
    };
    
    for (const [goalId, tracking] of this.strategicGoals.entries()) {
      // Skip if already completed or stale
      if (tracking.status === 'completed' || tracking.status === 'stale') {
        continue;
      }
      
      const goal = goalsSystem?.getGoals()?.find(g => g.id === goalId);
      
      if (!goal) {
        // Goal was pruned/archived - mark as stale
        tracking.status = 'stale';
        tracking.lastChecked = Date.now();
        this.stats.activeCount--;
        this.stats.totalStale++;
        updates.stalled.push({
          goalId,
          reason: 'goal_pruned',
          tracking
        });
        continue;
      }
      
      // Check if goal is being pursued by an active agent
      const agentWorkingOnIt = activeAgents?.some(agentState => {
        // agentState has: agent, mission, status, startTime
        const agent = agentState?.agent || agentState;
        const mission = agentState?.mission || agent?.mission;
        return mission?.goalId === goalId || mission?.goal?.id === goalId;
      });
      
      // Update status based on activity
      if (agentWorkingOnIt) {
        tracking.status = 'in_progress';
        tracking.cyclesIgnored = 0;
        tracking.lastChecked = Date.now();
        updates.progressing.push({ goalId, tracking });
      } else if (goal.pursuitCount > 0) {
        // Has been pursued, but not currently active
        tracking.status = 'in_progress';
        tracking.progress = goal.progress || 0;
        tracking.lastChecked = Date.now();
      } else {
        // Not being worked on
        tracking.cyclesIgnored++;
        tracking.lastChecked = Date.now();
        
        // Check age
        const age = currentCycle - tracking.reviewCycle;
        if (age > this.maxAge) {
          tracking.status = 'stale';
          this.stats.activeCount--;
          this.stats.totalStale++;
          updates.stalled.push({
            goalId,
            reason: 'exceeded_max_age',
            age,
            tracking
          });
        } else if (tracking.cyclesIgnored >= this.escalationThreshold) {
          // Progress-gated escalation (Jerry's "what surprises you"
          // 2026-04-17 fix). Pure-ignore goals that accumulate
          // cyclesIgnored with ZERO progress signal are the immortal-18
          // pattern: the escalator boosts priority, protecting them from
          // low-priority archive, which is how they survived 1,145 goal
          // creations. Only escalate when there's an actual hint that
          // the goal has any traction — either doneWhen partial
          // satisfaction (progress > 0) or a memory breadcrumb attached.
          const hasProgressSignal =
            Number(goal?.progress || 0) > 0 ||
            Boolean(goal?.dedupedTo) ||
            (goal?.pursuitCount || 0) > 0;
          if (hasProgressSignal) {
            updates.needsEscalation.push({
              goalId,
              cyclesIgnored: tracking.cyclesIgnored,
              tracking
            });
          } else {
            // No traction at all. Stay stalled; let auto-archive handle it.
            updates.stalled.push({
              goalId,
              reason: 'no-progress-signal',
              cyclesIgnored: tracking.cyclesIgnored,
              tracking,
              suppressedEscalation: true
            });
          }
        } else {
          updates.stalled.push({
            goalId,
            reason: 'not_pursued',
            cyclesIgnored: tracking.cyclesIgnored,
            tracking
          });
        }
      }
    }
    
    return updates;
  }
  
  /**
   * Escalate urgent goals that are being ignored
   */
  escalateIgnoredGoals(updates, goalsSystem) {
    const escalated = [];
    
    for (const item of updates.needsEscalation) {
      const { goalId, tracking } = item;
      const goal = goalsSystem?.getGoals()?.find(g => g.id === goalId);
      
      if (!goal) continue;
      
      tracking.escalationLevel++;
      tracking.status = 'escalated';
      this.stats.totalEscalated++;
      
      // Boost priority significantly
      const newPriority = Math.min(0.99, goal.priority + 0.15);
      goalsSystem.updateGoalPriority?.(goalId, newPriority);
      
      // CRITICAL: Mark goal as escalated in metadata so it bypasses maxConcurrent
      if (goal.metadata) {
        goal.metadata.escalated = true;
        goal.metadata.strategicPriority = true;
      }
      
      this.logger.warn('🚨 ESCALATING IGNORED STRATEGIC GOAL', {
        goalId,
        description: goal.description.substring(0, 100),
        cyclesIgnored: tracking.cyclesIgnored,
        escalationLevel: tracking.escalationLevel,
        newPriority,
        agentType: tracking.spec.agentType,
        rationale: tracking.spec.rationale.substring(0, 150)
      });
      
      escalated.push({
        goalId,
        goal,
        tracking,
        newPriority
      });
    }
    
    return escalated;
  }
  
  /**
   * Generate follow-up report for Meta-Coordinator
   */
  generateFollowUpReport(previousReviewCycle) {
    const goalIds = this.reviewCycles.get(previousReviewCycle);
    if (!goalIds) {
      return {
        reviewCycle: previousReviewCycle,
        goalsTracked: 0,
        status: 'no_goals_from_previous_review'
      };
    }
    
    const report = {
      reviewCycle: previousReviewCycle,
      goalsTracked: goalIds.size,
      completed: [],
      inProgress: [],
      stalled: [],
      escalated: [],
      summary: {
        completedCount: 0,
        inProgressCount: 0,
        stalledCount: 0,
        escalatedCount: 0,
        actionTaken: 0
      }
    };
    
    for (const goalId of goalIds) {
      const tracking = this.strategicGoals.get(goalId);
      if (!tracking) continue;
      
      const item = {
        goalId,
        description: tracking.spec.description.substring(0, 120),
        agentType: tracking.spec.agentType,
        status: tracking.status,
        progress: tracking.progress,
        cyclesActive: this.getCurrentCycle() - tracking.reviewCycle
      };
      
      switch (tracking.status) {
        case 'completed':
          report.completed.push({
            ...item,
            completedAt: tracking.completedAt,
            evidence: tracking.completionEvidence?.substring(0, 200)
          });
          report.summary.completedCount++;
          report.summary.actionTaken++;
          break;
          
        case 'in_progress':
          report.inProgress.push({
            ...item,
            progress: tracking.progress
          });
          report.summary.inProgressCount++;
          report.summary.actionTaken++;
          break;
          
        case 'escalated':
          report.escalated.push({
            ...item,
            escalationLevel: tracking.escalationLevel,
            cyclesIgnored: tracking.cyclesIgnored
          });
          report.summary.escalatedCount++;
          break;
          
        case 'pending':
        case 'stale':
          report.stalled.push({
            ...item,
            cyclesIgnored: tracking.cyclesIgnored,
            reason: tracking.status === 'stale' ? 'goal_pruned_or_aged' : 'not_yet_pursued'
          });
          report.summary.stalledCount++;
          break;
      }
    }
    
    return report;
  }
  
  /**
   * Get current cycle (helper)
   */
  getCurrentCycle() {
    // This will be injected by orchestrator
    return this._currentCycle || 0;
  }
  
  setCurrentCycle(cycle) {
    this._currentCycle = cycle;
  }
  
  /**
   * Get stats for dashboard
   */
  getStats() {
    return {
      ...this.stats,
      activeGoals: Array.from(this.strategicGoals.values())
        .filter(t => t.status !== 'completed' && t.status !== 'stale')
        .map(t => ({
          goalId: t.goalId,
          description: t.spec.description.substring(0, 80),
          status: t.status,
          progress: t.progress,
          age: this.getCurrentCycle() - t.reviewCycle,
          escalationLevel: t.escalationLevel
        }))
    };
  }
  
  /**
   * Export state for persistence
   */
  export() {
    return {
      strategicGoals: Array.from(this.strategicGoals.entries()),
      reviewCycles: Array.from(this.reviewCycles.entries()).map(([cycle, goals]) => 
        [cycle, Array.from(goals)]
      ),
      stats: this.stats,
      executionHistory: this.executionHistory.slice(-100) // Keep last 100 events
    };
  }
  
  /**
   * Import state from persistence
   */
  import(state) {
    if (!state) return;
    
    if (state.strategicGoals) {
      this.strategicGoals = new Map(state.strategicGoals);
    }
    
    if (state.reviewCycles) {
      this.reviewCycles = new Map(
        state.reviewCycles.map(([cycle, goals]) => [cycle, new Set(goals)])
      );
    }
    
    if (state.stats) {
      this.stats = { ...this.stats, ...state.stats };
    }
    
    if (state.executionHistory) {
      this.executionHistory = state.executionHistory;
    }
  }
}

module.exports = { StrategicGoalsTracker };

