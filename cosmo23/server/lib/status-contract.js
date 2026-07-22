const { readHeartbeat, computeHeartbeatAges } = require('../../engine/src/core/heartbeat');

function hasProcess(processStatus, name) {
  return Array.isArray(processStatus?.running)
    && processStatus.running.some((process) => process?.name === name);
}

// Phase 2 (H2): shape a raw .heartbeat payload into the status-contract
// heartbeat block, with staleness math computed against `now`.
// heartbeatAgeMs tracks liveness (ts); cycleProgressAgeMs tracks progress
// (lastCycleEndTs) — wedge detection must use progress, not liveness.
function summarizeHeartbeat(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  const nowMsCandidate = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const nowMs = Number.isFinite(nowMsCandidate) ? nowMsCandidate : Date.now();
  const { heartbeatAgeMs, cycleProgressAgeMs } = computeHeartbeatAges(raw, nowMs);
  return {
    lastHeartbeat: typeof raw.ts === 'string' ? raw.ts : null,
    lastCycleStartTs: typeof raw.lastCycleStartTs === 'string' ? raw.lastCycleStartTs : null,
    lastCycleEndTs: typeof raw.lastCycleEndTs === 'string' ? raw.lastCycleEndTs : null,
    cycle: Number.isFinite(Number(raw.cycle)) ? Number(raw.cycle) : null,
    pid: Number.isFinite(Number(raw.pid)) ? Number(raw.pid) : null,
    phase: typeof raw.phase === 'string' ? raw.phase : null,
    heartbeatAgeMs,
    cycleProgressAgeMs,
  };
}

function buildStatusContract({
  activeContext = null,
  processStatus = { running: [], count: 0 },
  isLaunching = false,
  ports = {},
  runTruth = {},
  sentinel = null,
  park = null,
  intents = null,
  heartbeat = undefined,
  now = new Date(),
  uptimeMs = Math.round(process.uptime() * 1000),
} = {}) {
  const cosmoMainOnline = hasProcess(processStatus, 'cosmo-main');
  const hasActiveContext = !!activeContext;
  const planStatus = String(runTruth?.plan?.status || '').toUpperCase();
  const blockedByPlan = planStatus === 'BLOCKED';
  const blockedByGovernor = runTruth?.commitmentDecision?.shouldStopForBlockedRun === true;
  const blockedRun = blockedByPlan || blockedByGovernor;
  const activeRun = hasActiveContext && cosmoMainOnline && !blockedRun;

  // Phase 2 (H2): heartbeat truth comes from the active run's .heartbeat
  // file. `heartbeat` (raw payload or null) can be injected for tests;
  // undefined means "read from disk at activeContext.runPath".
  const heartbeatRaw = heartbeat !== undefined
    ? heartbeat
    : (activeContext?.runPath ? readHeartbeat(activeContext.runPath) : null);
  const runHeartbeat = summarizeHeartbeat(heartbeatRaw, now);

  let lifecycle = 'idle';
  if (isLaunching) lifecycle = 'launching';
  else if (blockedRun) lifecycle = 'blocked';
  else if (activeRun) lifecycle = 'running';
  else if (hasActiveContext) lifecycle = 'context_without_process';
  else if (cosmoMainOnline) lifecycle = 'process_without_context';

  // Phase 4 (component 4.5): parked/park/intents are additive (Patch 9
  // compat), mirroring the wedged/sentinel pattern — `lifecycle` keeps its
  // original value set. `park` is the normalized park detail of the
  // active-or-last parked run; `parked` is true only when that run is not
  // superseded by a DIFFERENT active run.
  const parkDetail = park && typeof park === 'object' ? park : null;
  const parked = !!parkDetail
    && (!hasActiveContext || parkDetail.runPath === (activeContext?.runPath || null));

  return {
    apiReachable: true,
    lifecycle,
    activeRun,
    processOnline: cosmoMainOnline,
    hasActiveContext,
    isLaunching,
    // Sentinel fields are additive (Patch 9 compat rules): `lifecycle` keeps
    // its original value set; a wedged run is flagged in parallel.
    wedged: sentinel?.escalated === true,
    sentinel: sentinel || null,
    parked,
    park: parkDetail,
    intents: Array.isArray(intents) ? intents : [],
    lastHeartbeat: runHeartbeat?.lastHeartbeat || null,
    heartbeat: runHeartbeat,
    generatedAt: now instanceof Date ? now.toISOString() : String(now),
    uptimeMs,
    process: {
      cosmoMainOnline,
      count: processStatus?.count || 0,
      runningNames: Array.isArray(processStatus?.running)
        ? processStatus.running.map((process) => process?.name).filter(Boolean)
        : [],
    },
    run: activeContext ? {
      runName: activeContext.runName || null,
      brainId: activeContext.brainId || null,
      topic: activeContext.topic || null,
      startedAt: activeContext.startedAt || null,
      runPath: activeContext.runPath || null,
      status: blockedRun ? 'blocked' : (planStatus ? planStatus.toLowerCase() : null),
      blockedReason: runTruth?.plan?.blockedReason || null,
      artifactInventory: runTruth?.artifactInventory || null,
    } : null,
    supervision: {
      shouldStopForBlockedRun: runTruth?.commitmentDecision?.shouldStopForBlockedRun === true,
      reasonCodes: Array.isArray(runTruth?.commitmentDecision?.reasonCodes)
        ? runTruth.commitmentDecision.reasonCodes
        : [],
      appliedActions: Array.isArray(runTruth?.commitmentDecision?.appliedActions)
        ? runTruth.commitmentDecision.appliedActions
        : [],
    },
    ports,
  };
}

module.exports = { buildStatusContract, summarizeHeartbeat };
