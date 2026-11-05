# cosmo23 Phase 4 Component 4.4 — consolidation by policy instead of fixed cadence (governance.sleepPolicy, orchestrator Phase 11)

## Target current state

FIRST STOP — RunCommitmentGovernor (/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/run-commitment-governor.js, required at orchestrator.js:29, constructed at :104): a PURE run-level decision unit — evaluate(snapshot) turns {cycleCount, activeAgents, goals, artifactAudit, synthesisCommit, providerErrors, plan} into a bounded decision {spawnAllowed, rateLimited, requiresArtifactCommitment, shouldStopForCompletion, reasonCodes, nextActions} with buildDecision() defaults and toNumber/toNullableNumber normalizers. It governs SPAWN/STOP posture only; it is consulted in the meta-coordinator review path (orchestrator.js:4450, cached as lastCommitmentDecision, receipt via writeCommitmentReceipt). It has NO sleep/consolidation concern — Component 4.4 builds WITH it by adding a sibling pure decision unit (SleepPolicy) in the identical shape (config normalization incl. snake_case, evaluate(snapshot)→bounded decision, orchestrator owns acting + receipts), wired at a different decision point (Phase 11). No overlap, same family.

Phase 11 today (orchestrator.js executeCycle ~2025-2208): cognitiveState = stateModulator.getState(); shouldSleepCognitive = mode==='sleeping'; shouldSleepTemporal = rhythmState.state==='sleeping' (rhythmState captured at :1707); dreamMode force-syncs both systems; entry condition is `if (shouldSleepCognitive || shouldSleepTemporal || this.config.execution?.dreamMode)`. Inside: session init (sleepSession {active,startCycle,consolidationRun,minimumCycles:12} from constructor :186), emitSleepTriggered with reason ternary, cross-system sync, consolidation ONCE per session via performDeepSleepConsolidation() (deferred→wake early), energy recovery updateState({type:'sleep_cycle'},{skipModeCheck}), wake when (minimumCycles met AND energy>=0.8) OR 50-cycle safety net (MAX_SLEEP_CYCLES=50 at :2142), active-plan override (ACTIVE plan:main processes tasks during sleep instead of returning). performDeepSleepConsolidation (:3908) has its own time rate limit: temporal.lastConsolidationTime / temporal.minConsolidationInterval (1h default, temporal/rhythms.js:34); consolidationMode (execution.consolidationMode) is the PERPETUAL mode — checked at Phase 0 (:1589, early return per cycle) and at init (:928, forces all systems asleep, minimumCycles 999999) — it never reaches Phase 11 and is untouched by this component. Launch settings consolidationCycles/consolidationDreamsPerCycle (launcher/config-generator.js:1021-1022, server/index.js:842-843) only feed that perpetual mode — also untouched.

Signal visibility verified: (1) agent spawns all funnel through AgentRegistry.register() (agents/agent-registry.js:25) but NO monotonic counter exists — agents/completedAgents/failedAgents maps are all pruned by cleanupOldAgents (:481-501), so map sizes cannot serve as activity counters → a monotonic totalRegistered counter must be added; (2) task completions are visible as the return of agentExecutor.processCompletedResults() ({processed, integrated, results}) called exactly once per cycle at orchestrator.js:1724 (skipped in dreamMode — harmless, dreamMode takes the legacy path), plus PlanExecutor tick actions; (3) milestone completion is visible as planAction.action === 'PHASE_ADVANCED' (plan-executor.js advancePhase, phase=milestone marked COMPLETED + next activated) or 'PLAN_COMPLETED' (:1422, final milestone); planAction is declared with `let` at executeCycle top level (:1767) and IS in scope at Phase 11 — verified. NO lane/regulator machinery exists in the repo yet (grep for lane/regulator/governance in engine/src/core is empty except research-contract.js Patch 28 comment) — sibling Components 4.1-4.3 are parallel proposals, so lane reads must be defensive.

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/sleep-policy.js

NEW FILE. SleepPolicy pure decision unit (RunCommitmentGovernor family): mode 'legacy' (default, policy never consulted) vs 'policy' (idle streak of idleCycles quiet cycles OR post-milestone trigger; suppressed by any critical governance lane, then by minGapCycles rate limit). Stamps lastConsolidationCycle at decision time (prevents enter/wake thrash when the downstream 1h temporal rate limit defers). Per-process state, intentionally unpersisted — consistent with the per-process spawn counter it diffs. Write the file exactly as given; no trailing whitespace anywhere.

### Code
```js
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

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 1/8 (require). REPLACE the exact anchor line with the code (adds the SleepPolicy require directly below RunCommitmentGovernor's — same family, adjacent). Anchor is grep-unique (1 occurrence).

### Anchor
```
const { RunCommitmentGovernor } = require('./run-commitment-governor');
```

### Code
```js
const { RunCommitmentGovernor } = require('./run-commitment-governor');
const { SleepPolicy } = require('./sleep-policy');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 2/8 (constructor wiring, ~line 104). REPLACE the exact 2-line anchor with the code — constructs SleepPolicy from config.governance?.sleepPolicy (optional section; ConfigValidator is non-breaking) beside the commitment governor, plus the two per-cycle signal slots. Anchor grep-unique.

### Anchor
```
    this.commitmentGovernor = new RunCommitmentGovernor(this.config.commitmentGovernor || {}, this.logger);
    this.lastCommitmentDecision = null;
```

### Code
```js
    this.commitmentGovernor = new RunCommitmentGovernor(this.config.commitmentGovernor || {}, this.logger);
    this.lastCommitmentDecision = null;
    // GOVERNANCE (Component 4.4): consolidation-by-policy decision unit.
    // mode 'legacy' (default) keeps Phase 11 sleep triggering bit-identical.
    this.sleepPolicy = new SleepPolicy(this.config.governance?.sleepPolicy || {}, this.logger);
    this._sleepPolicySignals = null;
    this._sleepPolicyEntryReason = null;
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 3/8 (Phase 2 completion signal, ~line 1724). REPLACE the exact anchor line with the code — stamps the per-cycle completion count (return of processCompletedResults) cycle-tagged so stale stamps self-invalidate; no reset bookkeeping needed. WARNING: the ORIGINAL line immediately AFTER this anchor is a pre-existing whitespace-only line (8 spaces) — leave it untouched, do not strip it. Anchor grep-unique.

### Anchor
```
        const processed = await this.agentExecutor.processCompletedResults();
```

### Code
```js
        const processed = await this.agentExecutor.processCompletedResults();

        // GOVERNANCE (Component 4.4): cycle-stamped completion signal for the
        // sleep policy; stale stamps self-invalidate on the next cycle.
        this._sleepPolicySignals = {
          cycle: this.cycleCount,
          tasksCompleted: Number.isFinite(processed?.processed) ? processed.processed : 0
        };
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 4/8 (Phase 11 decision point, ~line 2038). REPLACE the exact 2-line anchor (comment + if-condition) with the code. Legacy mode: sleepDecision.triggered equals the original expression exactly (pinned by tests). Policy mode: NEW sessions gate on _resolveSleepTrigger; on a policy trigger both systems are synchronized to 'sleeping' BEFORE the block so the existing session machinery (consolidate-once, energy recovery, wake, 50-cycle safety net, active-plan override) flows unchanged. planAction is in scope here (declared with let at executeCycle top level, ~line 1767). Anchor grep-unique.

### Anchor
```
      // Sleep if EITHER system triggers (intentional dual-system design)
      if (shouldSleepCognitive || shouldSleepTemporal || this.config.execution?.dreamMode) {
```

### Code
```js
      // GOVERNANCE SLEEP POLICY (Component 4.4): in 'policy' mode, NEW sleep
      // sessions start only on idle / post-milestone policy decisions
      // (rate-limited, suppressed while any governance lane is critical).
      // 'legacy' mode (default) keeps the dual-system trigger bit-identical.
      // Dream mode and already-active sessions always take the legacy path.
      const sleepDecision = this._resolveSleepTrigger({
        shouldSleepCognitive,
        shouldSleepTemporal,
        dreamMode: Boolean(this.config.execution?.dreamMode),
        planAction
      });
      if (sleepDecision.source === 'policy' && sleepDecision.triggered) {
        this.logger.info('🌙 Sleep policy triggering consolidation', {
          trigger: sleepDecision.policyDecision.trigger,
          idleStreak: sleepDecision.policyDecision.idleStreak,
          cycle: this.cycleCount
        });
        this._sleepPolicyEntryReason = 'sleep_policy_' + sleepDecision.policyDecision.trigger;
        // Synchronize BOTH systems so the existing session machinery
        // (consolidate-once, energy recovery, wake, safety net) flows
        // unchanged from here.
        if (this.stateModulator.getState().mode !== 'sleeping') {
          this.stateModulator.transitionToMode('sleeping');
        }
        if (this.temporal.getState().state !== 'sleeping') {
          this.temporal.enterSleep();
        }
      }

      // Sleep if EITHER system triggers (intentional dual-system design)
      if (sleepDecision.triggered) {
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 5/8 (session-entry telemetry reason, ~line 2053). REPLACE the exact anchor line with the code — policy-started sessions emit reason 'sleep_policy_idle' / 'sleep_policy_post_milestone'; in legacy mode _sleepPolicyEntryReason is always null so the emitted value is byte-identical to today. Anchor grep-unique.

### Anchor
```
            reason: shouldSleepCognitive ? 'cognitive_fatigue' : 'temporal_rhythm',
```

### Code
```js
            reason: this._sleepPolicyEntryReason || (shouldSleepCognitive ? 'cognitive_fatigue' : 'temporal_rhythm'),
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 6/8 (clear entry reason after the emit). Apply AFTER EDIT 5. REPLACE the exact 3-line anchor (tail of the emitSleepTriggered call inside the session-init block) with the code — clears the transient reason immediately so a later legacy session can never inherit it. Anchor grep-unique via its first line.

### Anchor
```
            fatigue: rhythmState.fatigue || 0,
            cycle: this.cycleCount
          });
```

### Code
```js
            fatigue: rhythmState.fatigue || 0,
            cycle: this.cycleCount
          });
          this._sleepPolicyEntryReason = null;
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 7/8 (decision helpers, ~line 3908). REPLACE the exact anchor line (the performDeepSleepConsolidation method signature — 1 occurrence, call sites all use 'this.' prefix) with the code, which inserts three prototype methods ABOVE it and keeps the signature. _resolveSleepTrigger is the testable Phase 11 decision point (legacy pin lives here); _sleepPolicyCompletionsThisCycle folds the cycle-stamped Phase 2 count with PlanExecutor TASK_COMPLETED/PLAN_COMPLETED; _governanceCriticalLanes reads lane levels defensively from a future 4.1-4.3 regulator (absent regulator = no suppression).

### Anchor
```
  async performDeepSleepConsolidation() {
```

### Code
```js
  /**
   * GOVERNANCE SLEEP POLICY (Component 4.4) — resolve whether Phase 11
   * (sleep management) should run the sleep/consolidation block this cycle.
   *
   * 'legacy' mode (default) reproduces the historical dual-system trigger
   * EXACTLY: cognitive fatigue OR temporal rhythm OR dream mode. 'policy'
   * mode gates NEW sleep sessions on the SleepPolicy decision (idle /
   * post-milestone, rate-limited, critical-lane suppressed); an already
   * active sleep session and dream mode always take the legacy path so the
   * wake machinery (consolidate-once, energy recovery, minimumCycles,
   * 50-cycle safety net, active-plan override) is untouched in both modes.
   *
   * Pure with respect to engine state except for one bounded action: a
   * consolidate:true decision writes the durable ledger receipt
   * ('sleep_policy_consolidation', fire-and-forget, never awaited).
   */
  _resolveSleepTrigger(inputs = {}) {
    const dreamMode = Boolean(inputs.dreamMode);
    const legacyTrigger = Boolean(inputs.shouldSleepCognitive || inputs.shouldSleepTemporal || dreamMode);
    if (!this.sleepPolicy || !this.sleepPolicy.isPolicyMode() || dreamMode) {
      return { triggered: legacyTrigger, source: 'legacy', policyDecision: null };
    }
    if (this.sleepSession?.active) {
      return { triggered: true, source: 'active_session', policyDecision: null };
    }
    const planAction = inputs.planAction || null;
    const policyDecision = this.sleepPolicy.evaluate({
      cycleCount: this.cycleCount,
      totalAgentsSpawned: this.agentExecutor?.registry?.totalRegistered ?? null,
      tasksCompletedThisCycle: this._sleepPolicyCompletionsThisCycle(planAction),
      milestoneCompletedThisCycle: Boolean(planAction &&
        (planAction.action === 'PHASE_ADVANCED' || planAction.action === 'PLAN_COMPLETED')),
      criticalLanes: this._governanceCriticalLanes()
    });
    if (policyDecision.consolidate) {
      // Durable governance receipt (bounded autonomy) — never awaited.
      this.eventLedger?.log('sleep_policy_consolidation', {
        cycle: this.cycleCount,
        trigger: policyDecision.trigger,
        idleStreak: policyDecision.idleStreak,
        cyclesSinceLastConsolidation: policyDecision.cyclesSinceLastConsolidation
      });
      return { triggered: true, source: 'policy', policyDecision };
    }
    if (policyDecision.suppressed) {
      this.logger.info('⏭️  Sleep policy suppressing consolidation', {
        reason: policyDecision.reason,
        trigger: policyDecision.trigger,
        criticalLanes: policyDecision.criticalLanes,
        cycle: this.cycleCount
      });
    }
    return { triggered: false, source: 'policy', policyDecision };
  }

  /**
   * GOVERNANCE (Component 4.4): task completions visible this cycle — the
   * per-cycle stamp recorded when agent results were processed (Phase 2),
   * cycle-stamped so stale values self-invalidate, plus PlanExecutor task
   * completion actions from this cycle's tick.
   */
  _sleepPolicyCompletionsThisCycle(planAction) {
    const stamped = (this._sleepPolicySignals && this._sleepPolicySignals.cycle === this.cycleCount)
      ? this._sleepPolicySignals.tasksCompleted
      : 0;
    const planCompletion = planAction &&
      (planAction.action === 'TASK_COMPLETED' || planAction.action === 'PLAN_COMPLETED') ? 1 : 0;
    return stamped + planCompletion;
  }

  /**
   * GOVERNANCE (Component 4.4): names of governance lanes currently at level
   * 'critical'. Lanes are COMPUTED by the research governance regulator
   * (Components 4.1-4.3) when one is wired onto the orchestrator; absent
   * regulator means no suppression (empty list). This reads lane levels and
   * nothing else.
   */
  _governanceCriticalLanes() {
    for (const source of [this.researchRegulator, this.governanceRegulator]) {
      if (!source) continue;
      let lanes = null;
      if (typeof source.getLaneStates === 'function') {
        lanes = source.getLaneStates();
      } else if (typeof source.getLanes === 'function') {
        lanes = source.getLanes();
      }
      if (!lanes || typeof lanes !== 'object') continue;
      return Object.entries(lanes)
        .filter(([, lane]) => lane && String(lane.level).toLowerCase() === 'critical')
        .map(([name]) => name);
    }
    return [];
  }

  async performDeepSleepConsolidation() {
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT 8/8 (additive status exposure, getStats() ~line 10491). REPLACE the exact anchor line with the code — exposes the policy's computed state {mode, idleCycles, minGapCycles, idleStreak, lastConsolidationCycle, lastDecision} additively (R3). Anchor grep-unique (the saveState state-builder uses different lines).

### Anchor
```
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
```

### Code
```js
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
      sleepPolicy: this.sleepPolicy ? this.sleepPolicy.getStats() : null,
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/agents/agent-registry.js

EDIT 1/3 (constructor, ~line 17). REPLACE the exact anchor line with the code — adds the monotonic per-process spawn counter. Required because cleanupOldAgents (~line 481) prunes agents/completedAgents/failedAgents, so no existing map size is monotonic. Anchor grep-unique.

### Anchor
```
    this.failedAgents = new Map(); // agentId -> failedAgentState
```

### Code
```js
    this.failedAgents = new Map(); // agentId -> failedAgentState
    // GOVERNANCE (Component 4.4): monotonic per-process spawn counter for the
    // sleep policy's idle signal. Never decremented — cleanupOldAgents prunes
    // the maps above, so their sizes cannot serve as activity counters.
    this.totalRegistered = 0;
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/agents/agent-registry.js

EDIT 2/3 (register(), ~line 36). REPLACE the exact 2-line anchor with the code — increments the counter at the single funnel every spawn path goes through (AgentExecutor.spawnAgent → registry.register). Anchor grep-unique ('this.activeAgents.add(agent.agentId);' occurs once).

### Anchor
```
    this.agents.set(agent.agentId, agentState);
    this.activeAgents.add(agent.agentId);
```

### Code
```js
    this.agents.set(agent.agentId, agentState);
    this.activeAgents.add(agent.agentId);
    this.totalRegistered += 1;
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/agents/agent-registry.js

EDIT 3/3 (getStats(), ~line 424). REPLACE the exact anchor line with the code — additive stats field. getStats() feeds persisted registry snapshots; a new additive field is safe. Anchor grep-unique.

### Anchor
```
      total: this.agents.size,
```

### Code
```js
      total: this.agents.size,
      totalRegistered: this.totalRegistered,
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/CLAUDE.md

DOC (config-knob truth, per repo convention of documenting new knobs). REPLACE the exact anchor table row with the code — adds the three governance.sleepPolicy rows to the Key Config Fields table. Anchor grep-unique.

### Anchor
```
| `planning.maxRetries` | PlanExecutor task retry limit, default 3 |
```

### Code
```js
| `planning.maxRetries` | PlanExecutor task retry limit, default 3 |
| `governance.sleepPolicy.mode` | Consolidation trigger authority: `legacy` (default — dual-system fatigue/rhythm trigger, bit-identical) or `policy` (idle / post-milestone triggers, Component 4.4) |
| `governance.sleepPolicy.idleCycles` | Policy mode: consecutive cycles with zero new agent spawns AND zero task completions before idle-triggered consolidation, default 10 |
| `governance.sleepPolicy.minGapCycles` | Policy mode: minimum cycles between policy-triggered consolidations, default 30 |
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

TEST REGISTRATION (exactly-once). In the scripts.test command's cosmo23 'node --test' segment, REPLACE the exact anchor substring (note the TRAILING SPACE in both anchor and code — it is part of the match) with the code, registering the new suite immediately after cycle-watchdog. Anchor substring occurs exactly once in package.json. NOTE: package.json is currently dirty in the shared worktree — re-verify uniqueness at apply time.

### Anchor
```
tests/cosmo23/cycle-watchdog.test.cjs 
```

### Code
```js
tests/cosmo23/cycle-watchdog.test.cjs tests/cosmo23/sleep-policy.test.cjs 
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

TEST REGISTRATION PIN. REPLACE the exact anchor line with the code — adds the new suite to the exactly-once registration list. Anchor grep-unique.

### Anchor
```
    'tests/cosmo23/run-sentinel.test.cjs',
```

### Code
```js
    'tests/cosmo23/run-sentinel.test.cjs',
    'tests/cosmo23/sleep-policy.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/sleep-policy.test.cjs

```js
'use strict';

// Component 4.4 (native research governance) — consolidation by policy
// instead of fixed cadence.
//
// governance.sleepPolicy.mode:
//   'legacy' (default) — the Phase 11 sleep trigger is BIT-IDENTICAL to the
//     historical dual-system behavior (pinned here for the full input matrix,
//     including a hydrated instance with no sleepPolicy at all).
//   'policy' — NEW sleep sessions start only on (a) an idle streak (zero new
//     agent spawns AND zero task completions for idleCycles consecutive
//     cycles, default 10) or (b) a milestone completed this cycle
//     (PHASE_ADVANCED / PLAN_COMPLETED); both rate-limited by minGapCycles
//     (default 30) and suppressed while any governance lane is critical
//     (never sleep while parking/starved). Dream mode and already-active
//     sessions always take the legacy path, so the wake machinery
//     (consolidate-once, energy recovery, minimumCycles, 50-cycle safety
//     net, active-plan override) is untouched in both modes.
//
// A consolidate decision writes a durable 'sleep_policy_consolidation'
// ledger receipt (fire-and-forget, never awaited) at the orchestrator
// decision point (_resolveSleepTrigger).

const test = require('node:test');
const assert = require('node:assert/strict');

const { SleepPolicy } = require('../../cosmo23/engine/src/core/sleep-policy');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');
const { AgentRegistry } = require('../../cosmo23/engine/src/agents/agent-registry');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function policyAt(overrides = {}) {
  return new SleepPolicy({ mode: 'policy', idleCycles: 3, minGapCycles: 5, ...overrides }, quietLogger);
}

function idleSnapshot(cycle, extra = {}) {
  return {
    cycleCount: cycle,
    totalAgentsSpawned: 7,
    tasksCompletedThisCycle: 0,
    milestoneCompletedThisCycle: false,
    criticalLanes: [],
    ...extra
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SleepPolicy — pure decision unit
// ═══════════════════════════════════════════════════════════════════════════

test('defaults: legacy mode, idleCycles 10, minGapCycles 30; junk falls back; snake_case accepted', () => {
  const dflt = new SleepPolicy({}, quietLogger);
  assert.equal(dflt.isPolicyMode(), false);
  assert.deepEqual(
    { mode: dflt.config.mode, idleCycles: dflt.config.idleCycles, minGapCycles: dflt.config.minGapCycles },
    { mode: 'legacy', idleCycles: 10, minGapCycles: 30 }
  );
  const junk = new SleepPolicy({ mode: 'POLICY', idle_cycles: '4', min_gap_cycles: -2 }, quietLogger);
  assert.equal(junk.isPolicyMode(), true);
  assert.equal(junk.config.idleCycles, 4);
  assert.equal(junk.config.minGapCycles, 30);
  const unknown = new SleepPolicy({ mode: 'aggressive' }, quietLogger);
  assert.equal(unknown.isPolicyMode(), false);
});

test('policy mode: idleCycles consecutive quiet cycles trigger consolidation', () => {
  const policy = policyAt();
  // Cycle 1 establishes the spawn-counter baseline — conservative, not idle.
  assert.equal(policy.evaluate(idleSnapshot(1)).consolidate, false);
  assert.equal(policy.evaluate(idleSnapshot(2)).consolidate, false);
  assert.equal(policy.evaluate(idleSnapshot(3)).consolidate, false);
  const decision = policy.evaluate(idleSnapshot(4));
  assert.equal(decision.consolidate, true);
  assert.equal(decision.trigger, 'idle');
  assert.equal(decision.reason, 'idle');
  assert.equal(decision.idleStreak, 3);
});

test('policy mode: a spawn or a completion resets the idle streak', () => {
  const policy = policyAt();
  policy.evaluate(idleSnapshot(1));
  policy.evaluate(idleSnapshot(2));
  policy.evaluate(idleSnapshot(3));
  // Spawn counter moved → streak resets on the cycle that would have fired.
  assert.equal(policy.evaluate(idleSnapshot(4, { totalAgentsSpawned: 8 })).consolidate, false);
  assert.equal(policy.idleStreak, 0);
  policy.evaluate(idleSnapshot(5));
  // A task completion also resets.
  policy.evaluate(idleSnapshot(6, { tasksCompletedThisCycle: 2 }));
  assert.equal(policy.idleStreak, 0);
  policy.evaluate(idleSnapshot(7));
  policy.evaluate(idleSnapshot(8));
  assert.equal(policy.evaluate(idleSnapshot(9)).consolidate, true);
});

test('policy mode: milestone completion triggers immediately (consolidate-after-achievement)', () => {
  const policy = policyAt();
  const decision = policy.evaluate(idleSnapshot(1, {
    tasksCompletedThisCycle: 3,
    milestoneCompletedThisCycle: true
  }));
  assert.equal(decision.consolidate, true);
  assert.equal(decision.trigger, 'post_milestone');
  assert.equal(decision.reason, 'post_milestone');
});

test('policy mode: minGapCycles rate-limits successive policy consolidations', () => {
  const policy = policyAt();
  assert.equal(policy.evaluate(idleSnapshot(10, { milestoneCompletedThisCycle: true })).consolidate, true);
  const inGap = policy.evaluate(idleSnapshot(13, { milestoneCompletedThisCycle: true }));
  assert.equal(inGap.consolidate, false);
  assert.equal(inGap.suppressed, true);
  assert.equal(inGap.reason, 'rate_limited');
  const afterGap = policy.evaluate(idleSnapshot(15, { milestoneCompletedThisCycle: true }));
  assert.equal(afterGap.consolidate, true);
});

test('policy mode: any critical lane suppresses (never sleep while parking/starved)', () => {
  const policy = policyAt();
  const decision = policy.evaluate(idleSnapshot(1, {
    milestoneCompletedThisCycle: true,
    criticalLanes: ['spend']
  }));
  assert.equal(decision.consolidate, false);
  assert.equal(decision.suppressed, true);
  assert.equal(decision.reason, 'critical_lane_suppression');
  assert.deepEqual(decision.criticalLanes, ['spend']);
  // Suppression does NOT burn the rate-limit gap: once the lane clears the
  // same trigger consolidates.
  const cleared = policy.evaluate(idleSnapshot(2, { milestoneCompletedThisCycle: true }));
  assert.equal(cleared.consolidate, true);
});

test('policy mode: re-evaluating the same cycle does not double-advance the idle streak', () => {
  const policy = policyAt();
  policy.evaluate(idleSnapshot(1));
  policy.evaluate(idleSnapshot(2));
  policy.evaluate(idleSnapshot(2));
  policy.evaluate(idleSnapshot(2));
  assert.equal(policy.idleStreak, 1);
});

test('policy mode: an unavailable spawn counter never counts as idle (conservative)', () => {
  const policy = policyAt();
  for (let cycle = 1; cycle <= 10; cycle++) {
    assert.equal(policy.evaluate(idleSnapshot(cycle, { totalAgentsSpawned: null })).consolidate, false);
  }
  assert.equal(policy.idleStreak, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator decision point — prototype-driven fakes
// ═══════════════════════════════════════════════════════════════════════════

function makeFakeOrchestrator(overrides = {}) {
  return {
    config: { execution: {} },
    logger: quietLogger,
    cycleCount: 1,
    sleepSession: { active: false },
    sleepPolicy: new SleepPolicy({}, quietLogger),
    agentExecutor: { registry: { totalRegistered: 0 } },
    researchRegulator: null,
    governanceRegulator: null,
    _sleepPolicySignals: null,
    _sleepPolicyEntryReason: null,
    eventLedger: {
      entries: [],
      log(type, data = {}) { this.entries.push({ type, data }); return Promise.resolve(null); }
    },
    _resolveSleepTrigger: Orchestrator.prototype._resolveSleepTrigger,
    _sleepPolicyCompletionsThisCycle: Orchestrator.prototype._sleepPolicyCompletionsThisCycle,
    _governanceCriticalLanes: Orchestrator.prototype._governanceCriticalLanes,
    ...overrides
  };
}

test('LEGACY PIN: trigger decision identical to the dual-system expression for the full matrix', () => {
  const legacyVariants = [
    new SleepPolicy({}, quietLogger),
    new SleepPolicy({ mode: 'legacy' }, quietLogger),
    undefined // hydrated instance without a sleepPolicy at all
  ];
  for (const sleepPolicy of legacyVariants) {
    for (const shouldSleepCognitive of [false, true]) {
      for (const shouldSleepTemporal of [false, true]) {
        for (const dreamMode of [false, true]) {
          const fake = makeFakeOrchestrator({ sleepPolicy });
          const decision = fake._resolveSleepTrigger({
            shouldSleepCognitive,
            shouldSleepTemporal,
            dreamMode,
            planAction: { action: 'ON_TRACK' }
          });
          assert.equal(
            decision.triggered,
            Boolean(shouldSleepCognitive || shouldSleepTemporal || dreamMode),
            `matrix c=${shouldSleepCognitive} t=${shouldSleepTemporal} d=${dreamMode}`
          );
          assert.equal(decision.source, 'legacy');
          assert.equal(decision.policyDecision, null);
          assert.equal(fake.eventLedger.entries.length, 0);
        }
      }
    }
  }
});

test('policy mode: dream mode always takes the legacy path (forced sleep preserved)', () => {
  const fake = makeFakeOrchestrator({ sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger) });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: true,
    planAction: null
  });
  assert.deepEqual(
    { triggered: decision.triggered, source: decision.source },
    { triggered: true, source: 'legacy' }
  );
});

test('policy mode: an active sleep session keeps cycling through the existing wake machinery', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger),
    sleepSession: { active: true }
  });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: false,
    planAction: null
  });
  assert.deepEqual(
    { triggered: decision.triggered, source: decision.source },
    { triggered: true, source: 'active_session' }
  );
});

test('policy mode: organic fatigue alone does not start a session; policy is the authority', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy', idleCycles: 3, minGapCycles: 5 }, quietLogger)
  });
  fake.agentExecutor.registry.totalRegistered = 5;
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: true,
    shouldSleepTemporal: true,
    dreamMode: false,
    planAction: null
  });
  assert.equal(decision.triggered, false);
  assert.equal(decision.source, 'policy');
  assert.equal(fake.eventLedger.entries.length, 0);
});

test('policy mode: idle streak triggers at the decision point and writes the ledger receipt', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy', idleCycles: 3, minGapCycles: 5 }, quietLogger)
  });
  fake.agentExecutor.registry.totalRegistered = 5;
  let decision = null;
  for (let cycle = 1; cycle <= 4; cycle++) {
    fake.cycleCount = cycle;
    decision = fake._resolveSleepTrigger({
      shouldSleepCognitive: false,
      shouldSleepTemporal: false,
      dreamMode: false,
      planAction: { action: 'ON_TRACK' }
    });
    if (cycle < 4) assert.equal(decision.triggered, false, `cycle ${cycle} must not trigger yet`);
  }
  assert.equal(decision.triggered, true);
  assert.equal(decision.source, 'policy');
  assert.equal(decision.policyDecision.trigger, 'idle');
  assert.equal(fake.eventLedger.entries.length, 1);
  assert.equal(fake.eventLedger.entries[0].type, 'sleep_policy_consolidation');
  assert.equal(fake.eventLedger.entries[0].data.trigger, 'idle');
  assert.equal(fake.eventLedger.entries[0].data.cycle, 4);
});

test('policy mode: PHASE_ADVANCED plan action triggers post-milestone consolidation', () => {
  const fake = makeFakeOrchestrator({ sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger) });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: false,
    planAction: { action: 'PHASE_ADVANCED', completed: 'Phase 1', next: 'Phase 2' }
  });
  assert.equal(decision.triggered, true);
  assert.equal(decision.policyDecision.trigger, 'post_milestone');
  assert.equal(fake.eventLedger.entries[0].type, 'sleep_policy_consolidation');
});

test('policy mode: critical governance lane suppresses the trigger at the decision point', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger),
    researchRegulator: {
      getLaneStates() {
        return {
          progress: { level: 'ok', evidence: {} },
          spend: { level: 'critical', evidence: { reason: 'budget_exhausted' } },
          health: { level: 'warn', evidence: {} }
        };
      }
    }
  });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: false,
    planAction: { action: 'PLAN_COMPLETED' }
  });
  assert.equal(decision.triggered, false);
  assert.equal(decision.policyDecision.suppressed, true);
  assert.equal(decision.policyDecision.reason, 'critical_lane_suppression');
  assert.deepEqual(decision.policyDecision.criticalLanes, ['spend']);
  assert.equal(fake.eventLedger.entries.length, 0);
});

test('completion signals: cycle-stamped Phase 2 counts self-invalidate; plan completions add in', () => {
  const fake = makeFakeOrchestrator({});
  fake.cycleCount = 7;
  fake._sleepPolicySignals = { cycle: 7, tasksCompleted: 2 };
  assert.equal(fake._sleepPolicyCompletionsThisCycle({ action: 'TASK_COMPLETED' }), 3);
  fake.cycleCount = 8; // stale stamp from cycle 7 no longer counts
  assert.equal(fake._sleepPolicyCompletionsThisCycle(null), 0);
});

test('governance lanes: absent regulator or non-critical lanes yield no suppression input', () => {
  const none = makeFakeOrchestrator({});
  assert.deepEqual(none._governanceCriticalLanes(), []);
  const okLanes = makeFakeOrchestrator({
    governanceRegulator: {
      getLanes() { return { progress: { level: 'ok' }, health: { level: 'warn' } }; }
    }
  });
  assert.deepEqual(okLanes._governanceCriticalLanes(), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// AgentRegistry.totalRegistered — the idle signal's spawn counter
// ═══════════════════════════════════════════════════════════════════════════

function makeFakeAgent(id) {
  return {
    agentId: id,
    mission: { goalId: 'goal-' + id },
    status: 'running',
    startTime: new Date(),
    results: [],
    on() {}
  };
}

test('AgentRegistry.totalRegistered is monotonic and survives cleanupOldAgents', () => {
  const registry = new AgentRegistry(quietLogger);
  registry.register(makeFakeAgent('a1'), { spawnCycle: 1 });
  registry.register(makeFakeAgent('a2'), { spawnCycle: 2 });
  assert.equal(registry.totalRegistered, 2);
  assert.equal(registry.getStats().totalRegistered, 2);
  for (const id of ['a1', 'a2']) {
    const state = registry.agents.get(id);
    state.status = 'completed';
    state.endTime = new Date(Date.now() - 7200000);
    registry.activeAgents.delete(id);
    registry.completedAgents.set(id, state);
  }
  registry.cleanupOldAgents(3600000);
  assert.equal(registry.agents.size, 0);
  assert.equal(registry.totalRegistered, 2);
  assert.equal(registry.getStats().totalRegistered, 2);
});

```

## API NOTES

VALIDATION EVIDENCE (patch applied to the live tree, then reverted byte-exact): node --check clean on all three JS files; new suite 18/18 green (node --test tests/cosmo23/sleep-policy.test.cjs); existing orchestrator-coupled suites cycle-watchdog + graceful-shutdown-honesty + crash-recovery-scalar-checkpoints + engine-heartbeat + agent-executor-memory-context 68/68 green. Revert verified: cmp byte-exact against pre-patch baselines (which themselves matched `git show HEAD:` for both files), new files removed, `git status --porcelain` clean for all four paths. One real bug was caught and fixed during validation: Number(null)===0, so SleepPolicy's toNullableNumber explicitly returns null for null/undefined (deliberately DIFFERENT from run-commitment-governor's helper) — otherwise an absent spawn counter reads as a constant 0 and idle-triggers falsely; the shipped code + test pin this.

CONTRACTS: R1 — the only governance action is starting a consolidation session; it writes the durable receipt `sleep_policy_consolidation` {cycle, trigger, idleStreak, cyclesSinceLastConsolidation} via this.eventLedger?.log (fire-and-forget, never awaited) and changes cycling behavior only through the EXISTING sleep-session machinery (heartbeat/cycle phases unchanged — sessions already stamp through executeCycle). Nothing is deleted; no budget is touched. R2 — not this component (park is 4.2); note for the integrator: policy-mode consolidation never fights parking because critical lanes suppress it. R3 — sleepPolicy state exposed additively in Orchestrator.getStats(); lanes are READ-only via _governanceCriticalLanes(), which probes this.researchRegulator then this.governanceRegulator, methods getLaneStates() then getLanes(), expecting {laneName: {level, evidence}} per the shared lane contract. INTEGRATION ALIGNMENT REQUIRED: whichever handle/method Components 4.1/4.3 actually land, align it in this ONE helper (single edit point, its doc comment says so); absent regulator = empty list = no suppression (honest: governance not wired ≈ legacy exposure). R4 — not this component. R5 — NO server surface changes here, so 4.4 needs no patch-log entry (parked/spend/status server fields belong to 4.1-4.3's entry). R6 — node:test .test.cjs, prototype-driven fakes (Orchestrator.prototype methods bound to minimal fakes, same pattern as cycle-watchdog.test.cjs), registered exactly once (package.json cosmo23 segment + package-test-registration pin list — both edits included).

BEHAVIOR SEMANTICS (document, do not 'fix'): (1) Policy mode is the authority for STARTING sessions only — wake machinery, dream mode, and perpetual execution.consolidationMode (Phase 0 early-return; never reaches Phase 11) are untouched in both modes. (2) In policy mode, organic fatigue/rhythm 'sleeping' states no longer start sessions; the idle trigger typically fires soon after real work stops (a fatigued run spawns nothing). (3) performDeepSleepConsolidation's temporal rate limit (1h) remains a downstream guard; if it defers, the existing wake-early path runs — SleepPolicy stamps lastConsolidationCycle at DECISION time precisely so that deferral cannot thrash enter/wake. (4) Policy state and AgentRegistry.totalRegistered are both per-process and reset together on restart (consistent); after a restart the first evaluate is a conservative baseline sample. (5) Policy-started sessions emit emitSleepTriggered reason 'sleep_policy_idle'/'sleep_policy_post_milestone' via the transient _sleepPolicyEntryReason (cleared immediately after the emit); legacy emissions are byte-identical (the transient is always null in legacy mode). (6) TASK_COMPLETED/PLAN_COMPLETED from PlanExecutor and processed agent results may in principle both count the same completion — harmless: the idle signal only cares zero vs nonzero.

APPLY NOTES FOR IMPLEMENTER: apply edits as exact-text replacements (anchor → code); all anchors verified grep-unique at proposal time but the worktree is shared and moving (package.json is already dirty) — re-verify each anchor count is exactly 1 before applying. Edits 5 and 6 to orchestrator.js overlap textually if applied out of order: apply EDIT 5 (reason line) BEFORE EDIT 6 (the 3-line emit tail). TRAILING-WHITESPACE WARNINGS: orchestrator.js contains PRE-EXISTING whitespace-only lines adjacent to two edit sites — the line immediately after the processCompletedResults anchor is 8 spaces, and the line between `const shouldSleepTemporal ...` and the dream-mode comment (just above the Phase 11 anchor) is 6 spaces; leave both untouched, and none of the proposed code blocks contain trailing whitespace of their own. `planAction` is in scope at the Phase 11 anchor (declared with `let` at executeCycle top level ~line 1767) — do not re-declare it. Sacred persistence rules: this change never touches saveState/loadState paths, but the standing doctrine still applies to any engine restart after landing (standalone load test first, node-count verification after).
