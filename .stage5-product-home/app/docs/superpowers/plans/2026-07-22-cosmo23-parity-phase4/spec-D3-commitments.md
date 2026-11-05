# Phase 4 Component 4.3 — commitments + starvation detection feeding the progress lane (cosmo23 native research governance)

## Target current state

FIRST STOP — RunCommitmentGovernor (/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/run-commitment-governor.js, 225 lines): a pure, instantaneous-state decision unit. evaluate(snapshot) consumes {cycleCount, guidedRun, activeAgents, goals, plan, providerErrors, artifactAudit, synthesisCommit} and decides spawnAllowed / rateLimited (429-burst circuit over rateLimitWindowCycles) / requiresArtifactCommitment (outputs exist with zero committed artifacts) / shouldStopForCompletion (plan DONE|COMPLETED + synthesis commit + committed artifacts + no gaps) / shouldStopForBlockedRun + spawn budgets. Wiring: orchestrator.js line 29 require, line 104 construction from config.commitmentGovernor, collectCommitmentSnapshot() (~4429) feeds it plan:main from clusterStateStore plus getArtifactAuditSummary() (a DISK-WALK of outputs/+exports/ via artifacts/artifact-audit.js — evaluated only on spawn paths at ~2371 and ~4695, not every cycle), decisions receipted to commitment-governor-receipts.jsonl. VERDICT: 4.3 is NOT partially built inside it — the governor has no trailing-window concept, no progress deltas, no node-growth signal; it answers "may we spawn / should we stop given current state", never "has anything moved in the last N cycles". I build WITH it: the progress lane is a separate computed signal for the regulator; the governor remains the spawn/stop authority, untouched. Plan structures (guided-mode-planner.js persistence + plan-executor.js): one Plan 'plan:main' (status ACTIVE|BLOCKED|COMPLETED|ARCHIVED), Milestones ms:phaseN (LOCKED|ACTIVE|COMPLETED|ARCHIVED), Tasks with state PENDING|CLAIMED|IN_PROGRESS|DONE|FAILED|ARCHIVED. Real completion events: PlanExecutor.completeTask() (~line 572, via taskStateQueue or stateStore.completeTask) and advancePhase() (~319) — both also call recordPlanEvent() which orchestrator (~8765) buffers into planProgressEvents (capped 50). PlanExecutor.getStatus() (~1516) exposes completedTasks (state==='DONE' count) and completedPhases (status==='COMPLETED' count) from state synced every tick — restart-safe absolute counters; PlanExecutor is only constructed when clusterStateStore && agentExecutor exist (orchestrator ~659), so null-safe access is mandatory. completionTracker (core/completion-tracker.js): keyword-heuristic text matching of success criteria against agent-result prose — NOT a real completion event source; deliberately excluded. Artifact recording: AgentExecutor owns ArtifactRegistry (agents/agent-executor.js:163, registerArtifact at 1780 during result integration); registry.records is an in-memory Map persisted to coordinator/artifact_registry.json, records upserted never removed → records.size is a cumulative artifacts-written counter with no disk scan. Node growth: NetworkMemory.addNode() ALWAYS assigns ids from this.nextNodeId++ (network-memory.js ~784-797, both id formats), merge jumps it forward (~1368) — a monotone created-counter immune to decay/prune shrinking nodes.size (getStats().nodes is current size only, unusable for "added"). Cycle end: saveState() at ~3660 then eventLedger cycle_complete at ~3669 (grep-unique) — the sampling hook point. getStats() at ~10476 — the additive exposure point (R3). Donor VERIFIED: /Users/jtr/_JTR23_/release/home23/engine/src/publish/publish-ledger.js exists (74 lines) — PublishLedger with starvationFloor: "starving = no publish within maxQuietMs per target"; pattern adapted from wall-clock per-target floors to cycle-window per-signal deltas. Config: orchestrator reads arbitrary this.config.* keys (ConfigLoader permissive, validator non-throwing) so governance.starvation.windowCycles needs no loader change; config namespace 'governance.*' confirmed free and already being adopted by the concurrent 4.4 component (governance.sleepPolicy). CONCURRENT-TREE OBSERVATIONS: mid-session, component 4.4 (SleepPolicy) applied-then-reverted byte-exact on orchestrator.js — its diff adds a sleepPolicy key in getStats using MY SAME clusterCoordinator anchor line (both edits preserve the anchor; any application order works), and consumes lanes via this.researchRegulator/this.governanceRegulator._governanceCriticalLanes() checking level==='critical'. brain-snapshot.js and state-compression.js carry other sessions' modifications — untouched. All 5 orchestrator anchors re-verified grep-unique AFTER the tree moved. Validation receipt: all edits applied to a temp copy (.tmp-4p3-progress-lane-validate.cjs), node --check passed, 20/20 node:test pass, temp copy deleted, core/ tree byte-identical to its pre-existing state.

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/progress-lane.js

NEW FILE (cosmo23 engine is CJS — no type:module in cosmo23/engine/package.json). Pure starvation detector (evaluateProgressWindow) + in-memory ring tracker (ProgressLaneTracker). Commitments = the guided plan's own milestones/tasks; NO new commitment store. Detector: over trailing governance.starvation.windowCycles (default 20, clamped 1..5000), zero of {tasksCompleted, milestonesAdvanced, artifactsWritten, nodesAdded} -> critical 'starved'; partial progress -> warn tiers ('activity_without_commitment_progress' for plan-bearing runs, 'outputs_without_brain_growth' for plan-less); primary progress -> ok ('commitments_advancing' / 'brain_growing'). Plan-less runs (autonomous, or guided pre-plan) judged on nodes+artifacts only. Honesty guards: unfilled window -> ok 'window_filling' (never a cold-start false critical), plan COMPLETED/DONE -> ok 'plan_completed' (wind-down is not starvation), no meterable signals -> ok 'no_signals_available' (never critical on blindness), negative deltas (plan regeneration) clamp to 0 with counterReset flag. R1/R3 bounded: never writes engine state, never deletes data, holds only a scalar sample ring (window + 8 slack + 1 cap). Write file exactly as given.

### Code
```js
/**
 * ProgressLane — Phase 4 component 4.3: commitments + starvation detection.
 *
 * Commitments are the guided plan's own milestones/tasks (plan:main via
 * PlanExecutor.getStatus()) — there is NO separate commitment store. This
 * module turns per-cycle samples of cumulative progress counters into a
 * computed progress lane { level: ok|warn|critical, evidence } for run
 * governance (R3: lanes are computed, never stored authority).
 *
 * Counter sources (real completion events, no per-cycle disk scans):
 * - tasksDone / milestonesDone: PlanExecutor.getStatus().completedTasks /
 *   .completedPhases — plan state persisted in the cluster state store,
 *   advanced only by the PlanExecutor completion path (completeTask /
 *   advancePhase). null when the run has no plan.
 * - artifactsRegistered: ArtifactRegistry in-memory record count — appended
 *   by registerArtifact() at agent result integration time; records are
 *   upserted, never removed, so the count is cumulative.
 * - nodesCreated: NetworkMemory.nextNodeId — monotone id counter advanced by
 *   every addNode() (and jumped forward on merge), immune to decay/pruning
 *   shrinking nodes.size.
 *
 * Starvation rule (config governance.starvation.windowCycles, default 20):
 * over the trailing window, ZERO of {tasks completed, milestones advanced,
 * artifacts written, nodes added} -> critical (starved). Partial progress ->
 * warn tiers. Runs without a plan (autonomous, or guided before plan
 * generation) are judged on nodes-added + artifacts-written only.
 *
 * Donor pattern: home23 engine/src/publish/publish-ledger.js starvationFloor
 * ("starving = no publish within the floor window"), adapted from wall-clock
 * per-target floors to cycle-window per-signal deltas.
 *
 * Bounded (R1/R3): this module never writes engine state, never deletes
 * data, and holds only an in-memory ring of scalar samples. Acting on the
 * lane is the governance regulator's job, not this module's.
 */

const PROGRESS_LANE_DEFAULTS = {
  windowCycles: 20,
  minWindowCycles: 1,
  maxWindowCycles: 5000,
  ringSlackSamples: 8
};

const SIGNAL_KEYS = ['tasksCompleted', 'milestonesAdvanced', 'artifactsWritten', 'nodesAdded'];

const COUNTER_FOR_SIGNAL = {
  tasksCompleted: 'tasksDone',
  milestonesAdvanced: 'milestonesDone',
  artifactsWritten: 'artifactsRegistered',
  nodesAdded: 'nodesCreated'
};

function toFiniteOrNull(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeWindowCycles(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return PROGRESS_LANE_DEFAULTS.windowCycles;
  return Math.min(
    PROGRESS_LANE_DEFAULTS.maxWindowCycles,
    Math.max(PROGRESS_LANE_DEFAULTS.minWindowCycles, parsed)
  );
}

function normalizeSample(input = {}) {
  const cycle = toFiniteOrNull(input.cycle);
  if (cycle === null) return null;
  return {
    cycle,
    guided: input.guided === true,
    planStatus: typeof input.planStatus === 'string' ? input.planStatus : null,
    tasksDone: toFiniteOrNull(input.tasksDone),
    milestonesDone: toFiniteOrNull(input.milestonesDone),
    artifactsRegistered: toFiniteOrNull(input.artifactsRegistered),
    nodesCreated: toFiniteOrNull(input.nodesCreated)
  };
}

function buildEvidence(overrides = {}) {
  return {
    window: PROGRESS_LANE_DEFAULTS.windowCycles,
    windowFilled: false,
    cycles: null,
    tasksCompleted: null,
    milestonesAdvanced: null,
    artifactsWritten: null,
    nodesAdded: null,
    mode: 'autonomous',
    planStatus: null,
    signalsAvailable: [],
    counterReset: false,
    reason: 'no_samples',
    ...overrides
  };
}

/**
 * Pure starvation detector.
 *
 * input.samples      — cumulative counter samples ({ cycle, guided,
 *                      planStatus, tasksDone, milestonesDone,
 *                      artifactsRegistered, nodesCreated }); order-agnostic.
 * input.windowCycles — trailing window size in cycles (default 20).
 *
 * Returns { level: 'ok'|'warn'|'critical', evidence }.
 */
function evaluateProgressWindow({ samples, windowCycles } = {}) {
  const window = sanitizeWindowCycles(windowCycles);
  const ring = (Array.isArray(samples) ? samples : [])
    .map(normalizeSample)
    .filter(Boolean)
    .sort((a, b) => a.cycle - b.cycle);

  if (ring.length === 0) {
    return { level: 'ok', evidence: buildEvidence({ window, reason: 'no_samples' }) };
  }

  const latest = ring[ring.length - 1];
  const mode = latest.guided ? 'guided' : 'autonomous';

  if (ring.length < 2) {
    return {
      level: 'ok',
      evidence: buildEvidence({
        window,
        mode,
        planStatus: latest.planStatus,
        cycles: { from: latest.cycle, to: latest.cycle, span: 0 },
        reason: 'window_filling'
      })
    };
  }

  // Baseline: the newest sample at least windowCycles older than the latest,
  // or the oldest retained sample when the window has not filled yet.
  let baseline = ring[0];
  for (const sample of ring) {
    if (sample.cycle <= latest.cycle - window) baseline = sample;
    else break;
  }

  const span = latest.cycle - baseline.cycle;
  const windowFilled = span >= window;

  // Deltas: a signal is available when the latest counter is numeric; a
  // missing baseline counter reads as 0 (counter born inside the window —
  // e.g. a plan generated mid-run starts its completion counts at zero).
  // Negative raw deltas (plan regeneration re-zeroes counts) clamp to 0 and
  // flag counterReset instead of poisoning the window.
  const deltas = {};
  const signalsAvailable = [];
  let counterReset = false;
  for (const signal of SIGNAL_KEYS) {
    const counter = COUNTER_FOR_SIGNAL[signal];
    const latestValue = latest[counter];
    if (latestValue === null) {
      deltas[signal] = null;
      continue;
    }
    const baseValue = baseline[counter] === null ? 0 : baseline[counter];
    const rawDelta = latestValue - baseValue;
    if (rawDelta < 0) counterReset = true;
    deltas[signal] = Math.max(0, rawDelta);
    signalsAvailable.push(signal);
  }

  const evidence = buildEvidence({
    window,
    windowFilled,
    cycles: { from: baseline.cycle, to: latest.cycle, span },
    tasksCompleted: deltas.tasksCompleted,
    milestonesAdvanced: deltas.milestonesAdvanced,
    artifactsWritten: deltas.artifactsWritten,
    nodesAdded: deltas.nodesAdded,
    mode,
    planStatus: latest.planStatus,
    signalsAvailable,
    counterReset,
    reason: 'ok'
  });

  // A finished plan is wind-down, not starvation.
  const planDone = ['COMPLETED', 'DONE'].includes(String(latest.planStatus || '').toUpperCase());
  if (planDone) {
    evidence.reason = 'plan_completed';
    return { level: 'ok', evidence };
  }

  // Never cry starvation on blindness: with no meterable signal at all the
  // lane stays ok and says so honestly.
  if (signalsAvailable.length === 0) {
    evidence.reason = 'no_signals_available';
    return { level: 'ok', evidence };
  }

  if (!windowFilled) {
    evidence.reason = 'window_filling';
    return { level: 'ok', evidence };
  }

  const planSignals = deltas.tasksCompleted !== null || deltas.milestonesAdvanced !== null;
  const primaryProgress = planSignals
    ? ((deltas.tasksCompleted !== null && deltas.tasksCompleted > 0) ||
       (deltas.milestonesAdvanced !== null && deltas.milestonesAdvanced > 0))
    : (deltas.nodesAdded !== null && deltas.nodesAdded > 0);
  const anyProgress = SIGNAL_KEYS.some(signal => deltas[signal] !== null && deltas[signal] > 0);

  if (primaryProgress) {
    evidence.reason = planSignals ? 'commitments_advancing' : 'brain_growing';
    return { level: 'ok', evidence };
  }
  if (anyProgress) {
    evidence.reason = planSignals
      ? 'activity_without_commitment_progress'
      : 'outputs_without_brain_growth';
    return { level: 'warn', evidence };
  }
  evidence.reason = 'starved';
  return { level: 'critical', evidence };
}

/**
 * ProgressLaneTracker — in-memory ring of per-cycle cumulative counter
 * samples plus the last computed lane. One sample() per completed cycle;
 * re-sampling the same cycle replaces the sample (idempotent), out-of-order
 * cycles are ignored. Restart behavior: the ring is in-memory only, so after
 * a restart the window refills before any starvation verdict — never a
 * false critical from a cold start.
 */
class ProgressLaneTracker {
  constructor(config = {}, logger = console) {
    this.config = {
      enabled: config.enabled !== false,
      windowCycles: sanitizeWindowCycles(config.windowCycles ?? config.window_cycles)
    };
    this.logger = logger;
    this.samples = [];
    this.lastLane = null;
  }

  sample(counters = {}) {
    if (!this.config.enabled) return this.getLane();
    const normalized = normalizeSample(counters);
    if (!normalized) return this.getLane();

    const last = this.samples[this.samples.length - 1];
    if (last && normalized.cycle === last.cycle) {
      this.samples[this.samples.length - 1] = normalized;
    } else if (last && normalized.cycle < last.cycle) {
      return this.getLane();
    } else {
      this.samples.push(normalized);
    }

    this.trim(normalized.cycle);
    this.lastLane = {
      ...evaluateProgressWindow({
        samples: this.samples,
        windowCycles: this.config.windowCycles
      }),
      updatedAtCycle: normalized.cycle,
      updatedAt: new Date().toISOString()
    };
    return this.lastLane;
  }

  trim(latestCycle) {
    const boundary = latestCycle - this.config.windowCycles;
    let baselineIndex = -1;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].cycle <= boundary) baselineIndex = i;
      else break;
    }
    if (baselineIndex > 0) {
      this.samples = this.samples.slice(baselineIndex);
    }
    const cap = this.config.windowCycles + PROGRESS_LANE_DEFAULTS.ringSlackSamples + 1;
    if (this.samples.length > cap) {
      this.samples = this.samples.slice(this.samples.length - cap);
    }
  }

  getLane() {
    if (this.lastLane) return this.lastLane;
    return {
      level: 'ok',
      evidence: buildEvidence({ window: this.config.windowCycles, reason: 'no_samples' }),
      updatedAtCycle: null,
      updatedAt: null
    };
  }
}

module.exports = { ProgressLaneTracker, evaluateProgressWindow, PROGRESS_LANE_DEFAULTS };

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT A — require. Replace the grep-unique anchor line (near line 29) with the code block (anchor line preserved plus one new require). Concurrent note: component 4.4 inserts its SleepPolicy require after this same line; both edits preserve the anchor, apply in any order.

### Anchor
```
const { RunCommitmentGovernor } = require('./run-commitment-governor');
```

### Code
```js
const { RunCommitmentGovernor } = require('./run-commitment-governor');
const { ProgressLaneTracker } = require('./progress-lane');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT B — constructor init. Replace the grep-unique two-line anchor pair (lines ~104-105, 4-space indented) with the code block. WARNING: do NOT widen the anchor downward — three lines below it sits a blank line containing trailing spaces (after this.unregisterProviderErrorHandler) that will break exact matching.

### Anchor
```
    this.commitmentGovernor = new RunCommitmentGovernor(this.config.commitmentGovernor || {}, this.logger);
    this.lastCommitmentDecision = null;
```

### Code
```js
    this.commitmentGovernor = new RunCommitmentGovernor(this.config.commitmentGovernor || {}, this.logger);
    this.lastCommitmentDecision = null;
    // Phase 4 (4.3): computed progress lane — commitments + starvation
    // detection over a trailing cycle window. Config under
    // governance.starvation (windowCycles default 20). Never writes state.
    this.progressLane = new ProgressLaneTracker(this.config.governance?.starvation || {}, this.logger);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT C — end-of-cycle sampler in executeCycle (after saveState, ~line 3669). Replace the grep-unique single anchor line with the code block. Level transitions write a durable, never-awaited ledger receipt (R1); the lane changes no engine behavior. WARNING: the line immediately AFTER the anchor in the current file is a 'blank' line carrying 6 trailing spaces — anchor on the single ledger line only.

### Anchor
```
      this.eventLedger?.log('cycle_complete', { cycle: this.cycleCount, durationMs: cycleDuration });
```

### Code
```js
      this.eventLedger?.log('cycle_complete', { cycle: this.cycleCount, durationMs: cycleDuration });

      // Phase 4 (4.3): sample cumulative progress counters and recompute the
      // progress lane. Level transitions get a durable ledger receipt (R1,
      // never awaited); the lane itself changes no engine behavior — acting
      // on it is the governance regulator's job.
      try {
        const previousProgressLevel = this.progressLane.getLane().level;
        const progressLaneState = this.progressLane.sample(this.collectProgressCounters());
        if (progressLaneState.level !== previousProgressLevel) {
          this.eventLedger?.log('progress_lane_transition', {
            cycle: this.cycleCount,
            from: previousProgressLevel,
            to: progressLaneState.level,
            reason: progressLaneState.evidence?.reason || null,
            evidence: progressLaneState.evidence || null
          });
          this.logger.info(`[ProgressLane] ${previousProgressLevel} -> ${progressLaneState.level}`, {
            reason: progressLaneState.evidence?.reason || null,
            window: progressLaneState.evidence?.window || null
          });
        }
      } catch (error) {
        this.logger.debug('[ProgressLane] sample skipped', { error: error.message });
      }
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT D — new collectProgressCounters() method inserted immediately BEFORE getCommitmentDecisionForCycle (~line 4550). Replace the grep-unique anchor line (2-space indented method signature) with the code block (new method + preserved anchor). Sources are real completion events only: PlanExecutor plan state (null-safe — PlanExecutor only exists when clusterStateStore && agentExecutor do; plan-less runs report null plan counters), ArtifactRegistry in-memory Map size, NetworkMemory.nextNodeId.

### Anchor
```
  async getCommitmentDecisionForCycle() {
```

### Code
```js
  /**
   * Phase 4 (4.3): cumulative progress counters for the progress lane.
   *
   * Real completion events only — no per-cycle disk scans:
   * - tasksDone / milestonesDone: PlanExecutor plan state (cluster state
   *   store authority, advanced by the completeTask/advancePhase path).
   *   null when the run has no plan (autonomous, or guided pre-plan).
   * - artifactsRegistered: graph-native ArtifactRegistry in-memory record
   *   count (registerArtifact upserts at agent result integration; records
   *   are never removed).
   * - nodesCreated: NetworkMemory.nextNodeId — monotone id counter, immune
   *   to decay/prune shrinking nodes.size.
   */
  collectProgressCounters() {
    const planStatus = this.planExecutor?.plan ? this.planExecutor.getStatus() : null;
    const registryRecords = this.agentExecutor?.artifactRegistry?.records;
    const nextNodeId = Number(this.memory?.nextNodeId);
    return {
      cycle: this.cycleCount,
      guided: this.isGuidedExclusiveRun?.() || false,
      planStatus: planStatus?.planStatus || null,
      tasksDone: planStatus ? (Number(planStatus.completedTasks) || 0) : null,
      milestonesDone: planStatus ? (Number(planStatus.completedPhases) || 0) : null,
      artifactsRegistered: registryRecords instanceof Map ? registryRecords.size : null,
      nodesCreated: Number.isFinite(nextNodeId) ? nextNodeId : null
    };
  }

  async getCommitmentDecisionForCycle() {
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

EDIT E — additive getStats() exposure (R3), ~line 10491. Replace the grep-unique anchor line with the code block (anchor preserved + governance.lanes.progress). Concurrent note: component 4.4 adds a sleepPolicy key using this SAME anchor line; both replacements keep the anchor intact so they apply in either order — if 4.4 landed first the anchor line is unchanged and this edit still matches; resulting key order between governance and sleepPolicy is irrelevant (additive JSON).

### Anchor
```
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
```

### Code
```js
      clusterCoordinator: this.clusterCoordinator ? this.clusterCoordinator.getStats() : null,
      governance: {
        lanes: {
          progress: this.progressLane ? this.progressLane.getLane() : null
        }
      },
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

EDIT F — register the new suite exactly once in the root scripts.test command (the second node --test segment, alongside the other tests/cosmo23 suites). scripts.test is one very long single-line string: replace the exact anchor substring (verified to occur exactly once) with the code, inserting the new file between run-sentinel and research-run-operation-adapter. Concurrent note: other Phase 4 components will also insert suites into this command — anchors differ, but re-verify substring uniqueness at apply time.

### Anchor
```
tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/progress-lane-starvation.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

EDIT G — pin the new suite in the registration exactly-once list (R6 convention). Replace the grep-unique anchor line (4-space indented, single-quoted, trailing comma) with the code block (anchor preserved + new entry).

### Anchor
```
    'tests/cosmo23/run-sentinel.test.cjs',
```

### Code
```js
    'tests/cosmo23/run-sentinel.test.cjs',
    'tests/cosmo23/progress-lane-starvation.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/progress-lane-starvation.test.cjs

```js
'use strict';

// Phase 4 (4.3) — commitments + starvation detection feeding the progress lane.
//
// Commitments ARE the guided plan's own milestones/tasks (plan:main) — no new
// commitment store. The detector is a pure function over per-cycle samples of
// cumulative counters: over a trailing window (governance.starvation
// .windowCycles, default 20), ZERO of {tasks completed, milestones advanced,
// artifacts written, nodes added} -> progress lane critical (starved);
// partial progress -> warn tiers; plan-less runs (autonomous, or guided
// before plan generation) are judged on nodes-added + artifacts-written only.
// The lane never writes engine state — it is computed evidence for the run
// governance regulator (R3). Counter sources are real completion events:
// PlanExecutor plan state, the graph-native ArtifactRegistry record count,
// and NetworkMemory's monotone nextNodeId — never per-cycle disk scans.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProgressLaneTracker,
  evaluateProgressWindow,
  PROGRESS_LANE_DEFAULTS
} = require('../../cosmo23/engine/src/core/progress-lane');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

const FLAT_GUIDED_BASE = Object.freeze({
  tasksDone: 2,
  milestonesDone: 1,
  artifactsRegistered: 3,
  nodesCreated: 500
});

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// Cumulative-counter sample builder. `growth` maps a counter name to a
// per-cycle increment; counters absent from base and growth stay null
// (unmetered), matching the sampler's honesty contract.
function makeSamples({ cycles, base = {}, growth = {}, guided = true, planStatus = 'ACTIVE' }) {
  const totals = {
    tasksDone: base.tasksDone ?? null,
    milestonesDone: base.milestonesDone ?? null,
    artifactsRegistered: base.artifactsRegistered ?? null,
    nodesCreated: base.nodesCreated ?? null
  };
  const samples = [];
  for (const cycle of cycles) {
    for (const key of Object.keys(growth)) {
      totals[key] = (totals[key] ?? 0) + growth[key];
    }
    samples.push({ cycle, guided, planStatus, ...totals });
  }
  return samples;
}

test('starvation window defaults to 20 cycles', () => {
  assert.equal(PROGRESS_LANE_DEFAULTS.windowCycles, 20);
  const { evidence } = evaluateProgressWindow({ samples: [], windowCycles: 'garbage' });
  assert.equal(evidence.window, 20);
});

test('guided run with zero progress across a full window is critical (starved)', () => {
  const samples = makeSamples({ cycles: range(1, 21), base: FLAT_GUIDED_BASE });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'critical');
  assert.equal(evidence.reason, 'starved');
  assert.equal(evidence.windowFilled, true);
  assert.equal(evidence.mode, 'guided');
  assert.deepEqual(
    [evidence.tasksCompleted, evidence.milestonesAdvanced, evidence.artifactsWritten, evidence.nodesAdded],
    [0, 0, 0, 0]
  );
});

test('guided run with only brain growth is warn (activity without commitment progress)', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    base: FLAT_GUIDED_BASE,
    growth: { nodesCreated: 4 }
  });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'warn');
  assert.equal(evidence.reason, 'activity_without_commitment_progress');
  assert.ok(evidence.nodesAdded > 0);
  assert.equal(evidence.tasksCompleted, 0);
  assert.equal(evidence.milestonesAdvanced, 0);
});

test('guided run completing a task inside the window is ok', () => {
  const samples = makeSamples({ cycles: range(1, 21), base: FLAT_GUIDED_BASE });
  for (const sample of samples) {
    if (sample.cycle >= 15) sample.tasksDone += 1;
  }
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'ok');
  assert.equal(evidence.reason, 'commitments_advancing');
  assert.equal(evidence.tasksCompleted, 1);
});

test('guided run advancing a milestone alone is ok', () => {
  const samples = makeSamples({ cycles: range(1, 21), base: FLAT_GUIDED_BASE });
  for (const sample of samples) {
    if (sample.cycle >= 18) sample.milestonesDone += 1;
  }
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'ok');
  assert.equal(evidence.reason, 'commitments_advancing');
  assert.equal(evidence.milestonesAdvanced, 1);
});

test('autonomous run adding nodes is ok (brain growing)', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    guided: false,
    planStatus: null,
    base: { artifactsRegistered: 0, nodesCreated: 100 },
    growth: { nodesCreated: 2 }
  });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'ok');
  assert.equal(evidence.reason, 'brain_growing');
  assert.equal(evidence.mode, 'autonomous');
  assert.equal(evidence.tasksCompleted, null);
  assert.equal(evidence.milestonesAdvanced, null);
  assert.deepEqual(evidence.signalsAvailable, ['artifactsWritten', 'nodesAdded']);
});

test('autonomous run flat on nodes and artifacts across a full window is critical', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    guided: false,
    planStatus: null,
    base: { artifactsRegistered: 5, nodesCreated: 300 }
  });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'critical');
  assert.equal(evidence.reason, 'starved');
  assert.equal(evidence.mode, 'autonomous');
});

test('autonomous run writing outputs without brain growth is warn', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    guided: false,
    planStatus: null,
    base: { artifactsRegistered: 0, nodesCreated: 300 },
    growth: { artifactsRegistered: 1 }
  });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'warn');
  assert.equal(evidence.reason, 'outputs_without_brain_growth');
  assert.ok(evidence.artifactsWritten > 0);
  assert.equal(evidence.nodesAdded, 0);
});

test('an unfilled window never reports starvation', () => {
  const samples = makeSamples({ cycles: range(1, 6), base: FLAT_GUIDED_BASE });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'ok');
  assert.equal(evidence.reason, 'window_filling');
  assert.equal(evidence.windowFilled, false);
});

test('a completed plan reads ok — wind-down is not starvation', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    base: FLAT_GUIDED_BASE,
    planStatus: 'COMPLETED'
  });
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'ok');
  assert.equal(evidence.reason, 'plan_completed');
});

test('plan regeneration (counters drop) clamps deltas and flags counterReset', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    base: { tasksDone: 5, milestonesDone: 2, artifactsRegistered: 3, nodesCreated: 500 }
  });
  for (const sample of samples) {
    if (sample.cycle >= 11) {
      sample.tasksDone = 0;
      sample.milestonesDone = 0;
    }
  }
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'critical');
  assert.equal(evidence.counterReset, true);
  assert.equal(evidence.tasksCompleted, 0);
  assert.equal(evidence.milestonesAdvanced, 0);
});

test('lane evidence carries the R3 contract shape', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    base: FLAT_GUIDED_BASE,
    growth: { nodesCreated: 1 }
  });
  const { evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.deepEqual(Object.keys(evidence).sort(), [
    'artifactsWritten',
    'counterReset',
    'cycles',
    'milestonesAdvanced',
    'mode',
    'nodesAdded',
    'planStatus',
    'reason',
    'signalsAvailable',
    'tasksCompleted',
    'window',
    'windowFilled'
  ]);
  assert.deepEqual(evidence.cycles, { from: 1, to: 21, span: 20 });
  assert.equal(evidence.window, 20);
});

test('a run with no meterable signals stays ok and says so', () => {
  const samples = [{ cycle: 0 }, { cycle: 21 }];
  const { level, evidence } = evaluateProgressWindow({ samples, windowCycles: 20 });
  assert.equal(level, 'ok');
  assert.equal(evidence.reason, 'no_signals_available');
  assert.deepEqual(evidence.signalsAvailable, []);
});

test('detector is pure and order-agnostic', () => {
  const samples = makeSamples({
    cycles: range(1, 21),
    base: FLAT_GUIDED_BASE,
    growth: { nodesCreated: 3 }
  });
  const reversed = [...samples].reverse();
  const fromSorted = evaluateProgressWindow({ samples, windowCycles: 20 });
  const fromReversed = evaluateProgressWindow({ samples: reversed, windowCycles: 20 });
  assert.deepEqual(fromSorted, fromReversed);
  assert.equal(reversed[0].cycle, 21, 'caller array must not be re-sorted in place');
});

test('tracker replaces same-cycle samples, ignores regressions, and bounds the ring', () => {
  const tracker = new ProgressLaneTracker({ windowCycles: 20 }, quietLogger);
  assert.equal(tracker.getLane().level, 'ok');
  assert.equal(tracker.getLane().evidence.reason, 'no_samples');

  for (let cycle = 1; cycle <= 60; cycle++) {
    tracker.sample({ cycle, guided: false, nodesCreated: 100, artifactsRegistered: 0 });
  }
  assert.ok(tracker.samples.length <= 20 + PROGRESS_LANE_DEFAULTS.ringSlackSamples + 1);
  assert.equal(tracker.samples[0].cycle, 40, 'baseline candidate at the window boundary is retained');
  let lane = tracker.getLane();
  assert.equal(lane.level, 'critical');
  assert.equal(lane.evidence.reason, 'starved');
  assert.equal(lane.updatedAtCycle, 60);

  tracker.sample({ cycle: 60, guided: false, nodesCreated: 150, artifactsRegistered: 0 });
  lane = tracker.getLane();
  assert.equal(lane.level, 'ok');
  assert.equal(lane.evidence.reason, 'brain_growing');

  const lengthBefore = tracker.samples.length;
  tracker.sample({ cycle: 3, guided: false, nodesCreated: 1 });
  assert.equal(tracker.samples.length, lengthBefore, 'out-of-order sample is ignored');
});

test('a cold tracker never reports starvation before its window refills', () => {
  const tracker = new ProgressLaneTracker({ windowCycles: 20 }, quietLogger);
  for (let cycle = 500; cycle <= 510; cycle++) {
    tracker.sample({
      cycle,
      guided: true,
      planStatus: 'ACTIVE',
      tasksDone: 4,
      milestonesDone: 2,
      artifactsRegistered: 9,
      nodesCreated: 900
    });
  }
  const lane = tracker.getLane();
  assert.equal(lane.level, 'ok');
  assert.equal(lane.evidence.reason, 'window_filling');
});

test('disabled tracker samples nothing and stays ok', () => {
  const tracker = new ProgressLaneTracker({ enabled: false, windowCycles: 20 }, quietLogger);
  for (let cycle = 1; cycle <= 30; cycle++) {
    tracker.sample({ cycle, guided: false, nodesCreated: 100 });
  }
  assert.equal(tracker.samples.length, 0);
  assert.equal(tracker.getLane().level, 'ok');
});

test('orchestrator counter sampler reads plan state, artifact registry, and node id counter', () => {
  const fakeThis = {
    cycleCount: 42,
    isGuidedExclusiveRun() { return true; },
    planExecutor: {
      plan: { id: 'plan:main' },
      getStatus() {
        return { planStatus: 'ACTIVE', completedTasks: 3, completedPhases: 1 };
      }
    },
    agentExecutor: { artifactRegistry: { records: new Map([['a', {}], ['b', {}]]) } },
    memory: { nextNodeId: 512 }
  };
  const counters = Orchestrator.prototype.collectProgressCounters.call(fakeThis);
  assert.deepEqual(counters, {
    cycle: 42,
    guided: true,
    planStatus: 'ACTIVE',
    tasksDone: 3,
    milestonesDone: 1,
    artifactsRegistered: 2,
    nodesCreated: 512
  });
});

test('orchestrator counter sampler is honest about missing sources', () => {
  const counters = Orchestrator.prototype.collectProgressCounters.call({
    cycleCount: 7,
    isGuidedExclusiveRun() { return false; }
  });
  assert.deepEqual(counters, {
    cycle: 7,
    guided: false,
    planStatus: null,
    tasksDone: null,
    milestonesDone: null,
    artifactsRegistered: null,
    nodesCreated: null
  });
});

test('getStats exposes the progress lane additively under governance.lanes', () => {
  const stub = () => ({ getStats: () => ({}) });
  const fakeThis = {
    cycleCount: 3,
    running: true,
    lastCycleTime: new Date(),
    oscillator: stub(),
    memory: stub(),
    roles: stub(),
    goals: stub(),
    stateModulator: stub(),
    thermodynamic: stub(),
    chaotic: stub(),
    reflection: stub(),
    temporal: stub(),
    summarizer: stub(),
    coordinator: null,
    forkSystem: null,
    topicQueue: null,
    clusterCoordinator: null,
    environment: null,
    reasoningHistory: [],
    webSearchCount: 0,
    journal: [],
    progressLane: new ProgressLaneTracker({}, quietLogger)
  };
  const stats = Orchestrator.prototype.getStats.call(fakeThis);
  assert.equal(stats.governance.lanes.progress.level, 'ok');
  assert.equal(stats.governance.lanes.progress.evidence.reason, 'no_samples');
});

```

## API NOTES

CONTRACTS. Config (additive, no loader change needed — ConfigLoader passes unknown keys through): governance.starvation.{enabled: true, windowCycles: 20} (snake_case window_cycles accepted; clamped 1..5000; garbage falls back to 20). Lane contract (R3): orchestrator.progressLane.getLane() and getStats().governance.lanes.progress return {level: 'ok'|'warn'|'critical', evidence: {window, windowFilled, cycles:{from,to,span}, tasksCompleted, milestonesAdvanced, artifactsWritten, nodesAdded, mode:'guided'|'autonomous', planStatus, signalsAvailable[], counterReset, reason}, updatedAtCycle, updatedAt}. Reasons: no_samples | window_filling | plan_completed | no_signals_available | commitments_advancing | brain_growing (ok); activity_without_commitment_progress | outputs_without_brain_growth (warn); starved (critical). Null evidence values mean 'unmetered', never zero (R4 honesty); the lane NEVER reads critical from missing signals, an unfilled window, or a completed plan. Ledger receipts: 'progress_lane_transition' events via this.eventLedger?.log (fire-and-forget, never awaited) on level changes only. REGULATOR INTEGRATION (components 4.1/4.2): consume orchestrator.progressLane.getLane() and surface it under lane name 'progress'; I observed component 4.4 mid-flight (applied-then-reverted byte-exact) polling lanes via this.researchRegulator/this.governanceRegulator._governanceCriticalLanes() checking level==='critical' — this lane's shape composes with that; 4.4 also uses the SAME getStats anchor line for its sleepPolicy key and the same governance.* config family (governance.sleepPolicy) — both getStats edits preserve the anchor line and apply in either order. R5: this component adds NO server endpoints; when the regulator work exposes lanes in the server status contract, that belongs in the shared Phase 4 patch-log entry (next free number — Patch 71 exists). DESIGN DECISIONS: (1) commitments computed from plan state, no new store — PlanExecutor.getStatus().completedTasks/.completedPhases are the DONE/COMPLETED authority synced from the cluster state store every tick; (2) core/completion-tracker.js rejected as a counter source (keyword-heuristic text matching, not real events); (3) artifacts metered from ArtifactRegistry.records.size (in-memory Map, upsert-only, persisted to coordinator/artifact_registry.json and reloaded on boot) — NOT from getArtifactAuditSummary(), whose outputs/exports disk walk is too heavy per-cycle and mtime-scan-crude; unregistered stray files are deliberately not counted (they are the artifact-loop GAP the commitment governor flags); (4) nodes metered from memory.nextNodeId (monotone; every addNode() consumes an id in both id formats; merge jumps forward) — nodes.size is decay-distorted; (5) restart honesty: the ring is in-memory, so post-restart the window refills before any verdict; plan regeneration mid-window produces negative raw deltas which clamp to 0 with counterReset:true; (6) milestone activations are not counted — only completions — because activation without any task completion across a full window IS commitment starvation. VERIFICATION RECEIPT: all 5 orchestrator anchors asserted exactly-once programmatically, edits applied to a scratch copy (.tmp-4p3-progress-lane-validate.cjs), node --check passed, full proposed test file ran 20/20 green (node --test, node:test runner), temp copy deleted and cosmo23/engine/src/core restored to its pre-existing state; anchors re-verified unique AFTER the concurrent 4.4 apply/revert cycle moved the tree. Implementer warnings: orchestrator.js has trailing-whitespace 'blank' lines adjacent to EDIT B (the line after this.unregisterProviderErrorHandler) and EDIT C (the line right after the cycle_complete ledger line, 6 spaces) — use the anchors exactly as given, do not widen them; package.json scripts.test is a single long line (replace the exact substring); other Phase 4 agents will insert suites into the same scripts.test string, so re-verify substring uniqueness at apply time; run the suite from the repo root: node --test --test-concurrency=1 tests/cosmo23/progress-lane-starvation.test.cjs (root package.json is type:module — the .cjs extension is required, and the new engine module stays .js because cosmo23/engine has no type field, i.e. CJS).
