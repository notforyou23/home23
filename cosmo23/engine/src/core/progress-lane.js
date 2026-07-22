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

