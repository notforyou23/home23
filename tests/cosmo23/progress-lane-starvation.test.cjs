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

