/**
 * SleepPolicy
 *
 * Component 4.4 of native research governance: consolidation by policy
 * instead of fixed cadence.
 *
 * Pure decision unit in the RunCommitmentGovernor family. It turns per-cycle
 * activity signals into a bounded decision about whether the engine should
 * START a consolidation (sleep) session this cycle. It never mutates
 * orchestrator state, never deletes data, and never expands its own budget;
 * the orchestrator owns acting on the decision and writing the durable
 * ledger receipt.
 *
 * Modes (config governance.sleepPolicy.mode):
 *   'legacy' (default) — isPolicyMode() returns false and the orchestrator
 *     keeps the historical dual-system trigger (cognitive fatigue OR
 *     temporal rhythm OR dream mode) bit-identical. evaluate() is never
 *     consulted on that path.
 *   'policy' — a NEW sleep session starts only when:
 *     (a) idle: at least idleCycles consecutive evaluated cycles saw zero
 *         new agent spawns AND zero task completions, or
 *     (b) post-milestone: a plan milestone completed this cycle
 *         (consolidate-after-achievement),
 *     AND the trigger survives two suppressions:
 *       - any governance lane at level 'critical' suppresses (never sleep
 *         while parking/starved),
 *       - rate limit: at least minGapCycles cycles since the last
 *         policy-triggered consolidation.
 *
 * State is per-process and intentionally NOT persisted: the spawn counter it
 * diffs against (AgentRegistry.totalRegistered) is also per-process, so a
 * restart resets both sides consistently. performDeepSleepConsolidation()'s
 * own time-based rate limit (temporal.minConsolidationInterval, default 1h)
 * remains a second, independent guard downstream.
 */
class SleepPolicy {
  constructor(config = {}, logger = console) {
    const raw = config || {};
    const mode = String(raw.mode ?? 'legacy').toLowerCase();
    this.config = {
      mode: mode === 'policy' ? 'policy' : 'legacy',
      idleCycles: toPositiveInt(raw.idleCycles ?? raw.idle_cycles, 10),
      minGapCycles: toPositiveInt(raw.minGapCycles ?? raw.min_gap_cycles, 30)
    };
    this.logger = logger;

    // Computed per-process state (see header note about restarts).
    this.idleStreak = 0;
    this.lastSpawnSample = null;
    this.lastEvaluatedCycle = null;
    this.lastConsolidationCycle = null;
    this.lastDecision = null;
  }

  isPolicyMode() {
    return this.config.mode === 'policy';
  }

  /**
   * Evaluate whether a consolidation session should start this cycle.
   *
   * @param {Object} snapshot
   * @param {number} snapshot.cycleCount - current orchestrator cycle
   * @param {number|null} snapshot.totalAgentsSpawned - monotonic per-process
   *   spawn counter (AgentRegistry.totalRegistered); null when unavailable.
   *   A null counter is conservative: the cycle never counts as idle.
   * @param {number} snapshot.tasksCompletedThisCycle - completions visible
   *   this cycle (agent results processed + plan task completions)
   * @param {boolean} snapshot.milestoneCompletedThisCycle - PlanExecutor
   *   reported PHASE_ADVANCED or PLAN_COMPLETED this cycle
   * @param {string[]} snapshot.criticalLanes - names of governance lanes at
   *   level 'critical' (empty when no regulator is wired)
   * @returns {Object} bounded decision (never mutates engine state)
   */
  evaluate(snapshot = {}) {
    const cycleCount = toNumber(snapshot.cycleCount, 0);
    const spawnSample = toNullableNumber(snapshot.totalAgentsSpawned);
    const tasksCompleted = toNumber(snapshot.tasksCompletedThisCycle, 0);
    const milestoneCompleted = snapshot.milestoneCompletedThisCycle === true;
    const criticalLanes = Array.isArray(snapshot.criticalLanes)
      ? snapshot.criticalLanes.filter(Boolean).map(String)
      : [];

    // Spawn delta from the monotonic counter. First sample (or counter
    // unavailable) is conservative: the cycle does NOT count as idle.
    let spawnsThisCycle = null;
    if (spawnSample !== null && this.lastSpawnSample !== null) {
      spawnsThisCycle = Math.max(0, spawnSample - this.lastSpawnSample);
    }
    if (spawnSample !== null) {
      this.lastSpawnSample = spawnSample;
    }

    // Advance the idle streak at most once per distinct cycle so replayed
    // evaluations (same cycleCount) cannot double-count.
    if (this.lastEvaluatedCycle === null || cycleCount > this.lastEvaluatedCycle) {
      const idleThisCycle = spawnsThisCycle === 0 && tasksCompleted === 0;
      this.idleStreak = idleThisCycle ? this.idleStreak + 1 : 0;
      this.lastEvaluatedCycle = cycleCount;
    }
    const idleStreakNow = this.idleStreak;

    let trigger = null;
    if (milestoneCompleted) {
      trigger = 'post_milestone';
    } else if (idleStreakNow >= this.config.idleCycles) {
      trigger = 'idle';
    }

    const cyclesSinceLastConsolidation = this.lastConsolidationCycle === null
      ? null
      : cycleCount - this.lastConsolidationCycle;
    const rateLimited = cyclesSinceLastConsolidation !== null &&
      cyclesSinceLastConsolidation < this.config.minGapCycles;
    const laneSuppressed = criticalLanes.length > 0;

    let consolidate = false;
    let suppressed = false;
    let reason = 'no_trigger';
    if (trigger) {
      if (laneSuppressed) {
        suppressed = true;
        reason = 'critical_lane_suppression';
      } else if (rateLimited) {
        suppressed = true;
        reason = 'rate_limited';
      } else {
        consolidate = true;
        reason = trigger;
        // Stamp at decision time so a downstream deferral (temporal
        // rate limit inside performDeepSleepConsolidation) cannot cause
        // an enter/wake thrash loop.
        this.lastConsolidationCycle = cycleCount;
        this.idleStreak = 0;
      }
    }

    const decision = {
      consolidate,
      suppressed,
      trigger,
      reason,
      idleStreak: idleStreakNow,
      idleCyclesRequired: this.config.idleCycles,
      minGapCycles: this.config.minGapCycles,
      cyclesSinceLastConsolidation,
      criticalLanes,
      cycleCount
    };
    this.lastDecision = decision;
    return decision;
  }

  getStats() {
    return {
      mode: this.config.mode,
      idleCycles: this.config.idleCycles,
      minGapCycles: this.config.minGapCycles,
      idleStreak: this.idleStreak,
      lastConsolidationCycle: this.lastConsolidationCycle,
      lastDecision: this.lastDecision
    };
  }
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.floor(parsed);
  return int >= 1 ? int : fallback;
}

module.exports = { SleepPolicy };

