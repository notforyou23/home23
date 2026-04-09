// src/system/recursive-planner.js
/**
 * RecursivePlanner v1 - Meta-cognitive evaluation
 * 
 * Purpose:
 * - Evaluates COSMO's progress at meta-review points
 * - Decides whether to continue or halt
 * - Generates high-level follow-up goals
 * - Detects stagnation and convergence
 * 
 * Design:
 * - Bounded by maxMetaIterations
 * - Stagnation detection (no progress = halt)
 * - Non-invasive (doesn't spawn agents)
 * - Advisory (suggests goals, doesn't force them)
 * 
 * Safety:
 * - Cannot cause infinite loops
 * - Respects existing cycle limits
 * - Graceful halt conditions
 */
class RecursivePlanner {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    const cfg = config.recursiveMode || {};
    this.enabled = cfg.enabled || false;
    this.maxMetaIterations = cfg.maxMetaIterations || 8;
    this.minCyclesPerReview = cfg.minCyclesPerReview || 30;
    this.stagnationTolerance = cfg.stagnationTolerance || 3;
    
    this.state = {
      metaIterations: 0,
      lastReviewCycle: 0,
      stagnationCount: 0,
      lastDriftScore: null,
      lastAlertCount: null
    };
  }

  /**
   * Evaluate current state and decide next action
   * @param {Object} realitySnapshot - From RealityLayer
   * @param {Object} routingHints - From IntrospectionRouter
   * @param {number} cycleCount - Current cycle
   * @returns {Object} Decision object
   */
  evaluate(realitySnapshot, routingHints, cycleCount) {
    if (!this.enabled) {
      return { 
        continue: true, 
        newHighLevelGoals: [], 
        haltReason: 'disabled' 
      };
    }

    const { metaIterations, lastReviewCycle } = this.state;
    
    // Don't evaluate too frequently
    if (cycleCount - lastReviewCycle < this.minCyclesPerReview) {
      return { continue: true, newHighLevelGoals: [] };
    }

    // Hard cap on meta-iterations
    if (metaIterations >= this.maxMetaIterations) {
      this.logger.info('🧠 RecursivePlanner: max meta-iterations reached', {
        iterations: metaIterations,
        maxAllowed: this.maxMetaIterations
      }, 3);
      return { 
        continue: false, 
        newHighLevelGoals: [], 
        haltReason: 'max_meta_iterations' 
      };
    }

    // Compute progress indicators
    const driftScore = this._extractDriftScore(realitySnapshot);
    const alertCount = (realitySnapshot?.alerts || []).length;
    const deltas = this._computeDeltas(driftScore, alertCount);
    
    const madeProgress = deltas.driftImproved || deltas.alertsReduced;

    if (!madeProgress) {
      this.state.stagnationCount += 1;
    } else {
      this.state.stagnationCount = 0;
    }

    // Update state
    this.state.metaIterations += 1;
    this.state.lastReviewCycle = cycleCount;
    this.state.lastDriftScore = driftScore;
    this.state.lastAlertCount = alertCount;

    // Check for stagnation
    if (this.state.stagnationCount >= this.stagnationTolerance) {
      this.logger.info('🧠 RecursivePlanner: stagnation detected', {
        stagnationCount: this.state.stagnationCount,
        tolerance: this.stagnationTolerance,
        driftScore,
        alertCount
      }, 3);
      return {
        continue: false,
        newHighLevelGoals: [],
        haltReason: 'stagnation'
      };
    }

    // Build high-level goals from routing hints
    const newGoals = this._buildHighLevelGoals(routingHints, realitySnapshot);
    
    this.logger.info('🧠 RecursivePlanner: evaluation complete', {
      metaIteration: this.state.metaIterations,
      continue: true,
      newGoals: newGoals.length,
      stagnation: this.state.stagnationCount,
      progress: madeProgress ? 'yes' : 'no'
    }, 3);

    return {
      continue: true,
      newHighLevelGoals: newGoals
    };
  }

  _extractDriftScore(snapshot) {
    if (!snapshot?.drift) return null;
    return snapshot.drift.percentartifactschanged ?? null;
  }

  _computeDeltas(currDrift, currAlerts) {
    const prevDrift = this.state.lastDriftScore;
    const prevAlerts = this.state.lastAlertCount;

    const driftImproved =
      prevDrift != null &&
      currDrift != null &&
      currDrift < prevDrift;

    const alertsReduced =
      typeof prevAlerts === 'number' &&
      typeof currAlerts === 'number' &&
      currAlerts < prevAlerts;

    return { driftImproved, alertsReduced };
  }

  _buildHighLevelGoals(routingHints, snapshot) {
    const goals = [];
    
    if (!routingHints) return goals;

    if (routingHints.critic && routingHints.critic.length > 0) {
      goals.push('Resolve contradictions and errors in recent outputs');
    }

    if (routingHints.reuse && routingHints.reuse.length > 0) {
      goals.push('Extract and modularize reusable code patterns');
    }

    if (routingHints.synthesis && routingHints.synthesis.length > 0) {
      goals.push('Synthesize cross-file themes into unified understanding');
    }

    if (routingHints.research && routingHints.research.length > 0) {
      goals.push('Investigate open questions from recent work');
    }

    // If no routing hints but high drift, add stabilization goal
    const drift = this._extractDriftScore(snapshot);
    if (goals.length === 0 && drift != null && drift > 5) {
      goals.push('Stabilize substrate and reduce artifact drift');
    }

    return goals;
  }
}

module.exports = { RecursivePlanner };

