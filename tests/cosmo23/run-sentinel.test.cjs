'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createRunSentinel,
  SENTINEL_STATE_FILENAME,
} = require('../../cosmo23/server/lib/run-sentinel');
const { buildStatusContract } = require('../../cosmo23/server/lib/status-contract');

const MINUTE = 60 * 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeFixture(t, overrides = {}) {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-run-sentinel-'));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));

  const fixture = {
    runPath,
    nowMs: Date.parse('2026-07-22T12:00:00.000Z'),
    activeContext: {
      runName: 'labor23',
      runPath,
      brainId: 'brain-abc123',
      topic: 'labor',
      startedAt: '2026-07-22T11:00:00.000Z', // 60m before nowMs — past grace
    },
    isLaunching: false,
    processRunning: [{ name: 'cosmo-main', pid: 4242, killed: false }],
    heartbeat: {
      ts: '2026-07-22T11:59:50.000Z',
      pid: 4242,
      cycle: 12,
      lastCycleStartTs: '2026-07-22T11:58:00.000Z',
      lastCycleEndTs: '2026-07-22T11:59:00.000Z',
      phase: 'integration',
    },
    watchdog: null,
    stopCalls: [],
    relaunchCalls: [],
    logs: [],
    stopImpl: null,
    relaunchImpl: null,
  };

  const config = {
    checkIntervalMs: MINUTE,
    wedgeThresholdMs: 15 * MINUTE,
    launchGraceMs: 5 * MINUTE,
    maxAttempts: 2,
    breakerStuckMs: 30 * MINUTE,
    ...overrides.config,
  };

  fixture.sentinel = createRunSentinel({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    getProcessStatus: () => ({ running: fixture.processRunning, count: fixture.processRunning.length }),
    readHeartbeat: async () => fixture.heartbeat,
    readWatchdog: async () => fixture.watchdog,
    stopEngine: async (info) => {
      fixture.stopCalls.push(info);
      if (fixture.stopImpl) return fixture.stopImpl(info);
      fixture.activeContext = null;
      fixture.processRunning = [];
      return undefined;
    },
    relaunch: async (info) => {
      fixture.relaunchCalls.push(info);
      if (fixture.relaunchImpl) return fixture.relaunchImpl(info);
      fixture.activeContext = {
        runName: info.runName,
        runPath: info.runPath,
        brainId: info.brainId,
        // Old startedAt keeps subsequent checks outside the launch grace so
        // tests can walk the ladder without simulating a 5-minute wait.
        startedAt: '2026-07-22T11:00:00.000Z',
      };
      fixture.processRunning = [{ name: 'cosmo-main', pid: 4243, killed: false }];
      return { success: true };
    },
    log: (level, message) => fixture.logs.push({ level, message }),
    now: () => fixture.nowMs,
    config,
  });

  fixture.statePath = path.join(runPath, SENTINEL_STATE_FILENAME);
  fixture.readStateFile = async () => JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
  fixture.stateFileExists = async () => {
    try {
      await fs.access(fixture.statePath);
      return true;
    } catch {
      return false;
    }
  };
  return fixture;
}

function wedgeHeartbeat(fixture) {
  // Progress stalled 20 minutes ago; liveness ts stays fresh (hung LLM await).
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleStartTs: new Date(fixture.nowMs - 21 * MINUTE).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 20 * MINUTE).toISOString(),
  };
}

test('healthy run with fresh cycle progress takes no action and writes no state file', async (t) => {
  const fixture = await makeFixture(t);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'healthy');
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
  assert.equal(await fixture.stateFileExists(), false);
});

test('fresh liveness ts alone does not mask a progress wedge (progress, not liveness)', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.reason, 'wedged_no_cycle_progress');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 1);
  assert.deepEqual(
    { brainId: fixture.relaunchCalls[0].brainId, attempt: fixture.relaunchCalls[0].attempt },
    { brainId: 'brain-abc123', attempt: 1 },
  );
  const state = await fixture.readStateFile();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].ok, true);
  assert.equal(state.attempts[0].reason, 'wedged_no_cycle_progress');
  assert.equal(state.escalated, false);
});

test('no action during launch grace period even with a stale heartbeat', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.activeContext.startedAt = new Date(fixture.nowMs - 2 * MINUTE).toISOString();
  const result = await fixture.sentinel.check();
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'skipped', reason: 'launch_grace' });
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
});

test('no action while a launch is in flight', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.isLaunching = true;
  const result = await fixture.sentinel.check();
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'skipped', reason: 'launching' });
  assert.equal(fixture.stopCalls.length, 0);
});

test('missing heartbeat file is a no-signal skip, never a remediation', async (t) => {
  const fixture = await makeFixture(t);
  fixture.heartbeat = null;
  const result = await fixture.sentinel.check();
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'skipped', reason: 'no_heartbeat' });
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
});

test('idle server (no active run) does nothing', async (t) => {
  const fixture = await makeFixture(t);
  fixture.activeContext = null;
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'idle');
});

test('dead engine child with active context runs the same ladder', async (t) => {
  const fixture = await makeFixture(t);
  fixture.processRunning = []; // context_without_process
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.reason, 'engine_process_died');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 1);
});

test('ladder is bounded: maxAttempts remediations then escalation, then silence', async (t) => {
  const fixture = await makeFixture(t);

  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // attempt 1

  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // attempt 2

  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  const escalation = await fixture.sentinel.check();
  assert.equal(escalation.outcome, 'escalated');
  assert.equal(fixture.stopCalls.length, 2);
  assert.equal(fixture.relaunchCalls.length, 2);

  const state = await fixture.readStateFile();
  assert.equal(state.escalated, true);
  assert.equal(typeof state.escalatedAt, 'string');
  assert.equal(fixture.sentinel.getPublicState().escalated, true);
  assert.ok(fixture.logs.some((entry) => entry.level === 'error' && entry.message.includes('SENTINEL ESCALATION')));

  // Escalated: no further remediation, no fresh escalation logs.
  const logCount = fixture.logs.length;
  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'escalated');
  assert.equal(fixture.stopCalls.length, 2);
  assert.equal(fixture.relaunchCalls.length, 2);
  assert.equal(fixture.logs.length, logCount);
});

test('failed relaunch continues the ladder on later ticks without a second engine stop', async (t) => {
  const fixture = await makeFixture(t);
  fixture.relaunchImpl = async () => {
    fixture.activeContext = null;
    throw new Error('launch refused: provider offline');
  };

  wedgeHeartbeat(fixture);
  const first = await fixture.sentinel.check(); // attempt 1: stop + failed relaunch
  assert.equal(first.outcome, 'remediation_failed');
  assert.equal(fixture.stopCalls.length, 1);

  const second = await fixture.sentinel.check(); // attempt 2: relaunch retry only
  assert.equal(second.outcome, 'remediation_failed');
  assert.equal(second.reason, 'relaunch_retry');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 2);

  const third = await fixture.sentinel.check(); // attempts exhausted → escalate
  assert.equal(third.outcome, 'escalated');
  assert.equal(fixture.relaunchCalls.length, 2);
  const state = await fixture.readStateFile();
  assert.equal(state.escalated, true);
  assert.equal(state.attempts.filter((attempt) => !attempt.ok).length, 2);
});

test('a completed cycle after remediation resets the ladder', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated');

  fixture.nowMs += 10 * MINUTE;
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleStartTs: new Date(fixture.nowMs - 3 * MINUTE).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 2 * MINUTE).toISOString(),
  };
  assert.equal((await fixture.sentinel.check()).outcome, 'healthy');

  const state = await fixture.readStateFile();
  assert.equal(state.attempts.length, 0);
  assert.equal(state.recoveries, 1);
  assert.equal(state.escalated, false);
  assert.equal(fixture.sentinel.getPublicState().attempts, 0);
});

test('run completion cleans up sentinel state', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  await fixture.sentinel.check();
  assert.equal(await fixture.stateFileExists(), true);

  const cleaned = await fixture.sentinel.notifyRunEnded({ runPath: fixture.runPath, runName: 'labor23' });
  assert.equal(cleaned.cleaned, true);
  assert.equal(await fixture.stateFileExists(), false);
  assert.equal(fixture.sentinel.getPublicState(), null);
});

test('run-ended notification during an in-flight remediation does not wipe ladder state', async (t) => {
  const fixture = await makeFixture(t);
  const stopStarted = deferred();
  const stopGate = deferred();
  fixture.stopImpl = async () => {
    stopStarted.resolve();
    await stopGate.promise;
    fixture.activeContext = null;
  };

  wedgeHeartbeat(fixture);
  const inFlight = fixture.sentinel.check();
  await stopStarted.promise;

  // cosmo-exit fires while the sentinel is stopping the engine itself.
  const cleaned = await fixture.sentinel.notifyRunEnded({ runPath: fixture.runPath });
  assert.equal(cleaned.cleaned, false);
  assert.equal(cleaned.reason, 'remediation_in_flight');
  assert.equal(await fixture.stateFileExists(), true);

  stopGate.resolve();
  await inFlight;
  assert.equal(await fixture.stateFileExists(), true);
});

test('persisted ladder survives a server restart (no attempt amnesia)', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // attempt 1

  // "Restart": a brand new sentinel over the same run directory.
  const restarted = await makeFixture(t);
  await fs.rm(restarted.runPath, { recursive: true, force: true });
  restarted.runPath = fixture.runPath;
  restarted.statePath = fixture.statePath;
  restarted.activeContext.runPath = fixture.runPath;
  restarted.nowMs = fixture.nowMs + 30 * MINUTE;
  wedgeHeartbeat(restarted);

  const result = await restarted.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.attempt, 2);
  const state = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
  assert.equal(state.attempts.length, 2);
});

test('stale attempts beyond the TTL are pruned on load', async (t) => {
  const fixture = await makeFixture(t);
  await fs.writeFile(fixture.statePath, JSON.stringify({
    version: 1,
    runPath: fixture.runPath,
    runName: 'labor23',
    brainId: 'brain-abc123',
    attempts: [
      { at: '2026-07-20T12:00:00.000Z', reason: 'wedged_no_cycle_progress', ok: false, error: 'old incident' },
      { at: '2026-07-20T13:00:00.000Z', reason: 'wedged_no_cycle_progress', ok: false, error: 'old incident' },
    ],
    recoveries: 0,
    escalated: true,
    escalatedAt: '2026-07-20T13:00:00.000Z',
  }, null, 2), 'utf8');

  wedgeHeartbeat(fixture);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.attempt, 1);
  const state = await fixture.readStateFile();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.escalated, false);
});

// --- S1: watchdog hand-off contract -----------------------------------------
// The engine watchdog's persisted restartRequested flag SURVIVES boot and
// stays true through a relaunch's residual cooloff (cleared only by the first
// successful cycle). The sentinel must key on live signals only — a healthy
// run with a stale restartRequested flag gets no action.

test('S1: persisted restartRequested with a healthy, progressing run triggers no action', async (t) => {
  const fixture = await makeFixture(t);
  fixture.watchdog = {
    version: 1,
    state: 'closed',
    consecutiveFailures: 0,
    cooloffUntil: null,
    restartRequested: true, // survives boot until the first successful cycle
    restartReason: 'orphaned_cycle_unsettled',
  };
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'healthy');
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
});

// --- S3: heartbeat phase awareness -------------------------------------------
// Phases 'breaker_cooloff' / 'revive_probe' mean the engine is deliberately
// not cycling — cooloff time is not wedge time.

test('S3: breaker_cooloff phase with stale progress is skipped, not remediated', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.heartbeat.phase = 'breaker_cooloff';
  fixture.watchdog = {
    state: 'open',
    cooloffUntil: fixture.nowMs + 10 * MINUTE, // cooloff still running
    restartRequested: false,
  };
  const result = await fixture.sentinel.check();
  assert.deepEqual(
    { outcome: result.outcome, reason: result.reason },
    { outcome: 'skipped', reason: 'watchdog_phase' },
  );
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
});

test('S3: revive_probe phase with stale progress is skipped, not remediated', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.heartbeat.phase = 'revive_probe';
  fixture.watchdog = { state: 'half-open', cooloffUntil: fixture.nowMs - MINUTE, restartRequested: false };
  const result = await fixture.sentinel.check();
  assert.deepEqual(
    { outcome: result.outcome, reason: result.reason },
    { outcome: 'skipped', reason: 'watchdog_phase' },
  );
  assert.equal(fixture.stopCalls.length, 0);
});

// --- S2: stuck-breaker belt-and-braces ---------------------------------------
// The engine's own breaker normally handles fast-fail loops and escalates via
// exit 86. If the breaker sits 'open' with its cooloff long past and no cycle
// progress since, the engine's self-management failed — treat as wedge.

test('S2: open breaker with cooloff long past and no progress since is remediated', async (t) => {
  const fixture = await makeFixture(t);
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(), // liveness fresh
    lastCycleEndTs: new Date(fixture.nowMs - 60 * MINUTE).toISOString(), // before cooloffUntil
    phase: 'breaker_cooloff',
  };
  fixture.watchdog = {
    state: 'open',
    cooloffUntil: fixture.nowMs - 45 * MINUTE, // 45m past > breakerStuckMs (30m)
    restartRequested: false,
  };
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.reason, 'watchdog_breaker_stuck');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 1);
});

test('S2: open breaker with cooloff recently expired is left to the engine', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.heartbeat.phase = 'breaker_cooloff';
  fixture.watchdog = {
    state: 'open',
    cooloffUntil: fixture.nowMs - 5 * MINUTE, // past, but < breakerStuckMs
    restartRequested: false,
  };
  const result = await fixture.sentinel.check();
  assert.deepEqual(
    { outcome: result.outcome, reason: result.reason },
    { outcome: 'skipped', reason: 'watchdog_phase' },
  );
  assert.equal(fixture.stopCalls.length, 0);
});

test('S2: cycle progress after cooloff expiry defeats the stuck-breaker path', async (t) => {
  const fixture = await makeFixture(t);
  // Progress happened AFTER cooloffUntil (engine probed/cycled) but is stale
  // by the wedge threshold — the NORMAL wedge path must fire, not the
  // stuck-breaker path (a stale .watchdog.json must not steal the reason).
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 20 * MINUTE).toISOString(),
    phase: 'integration',
  };
  fixture.watchdog = {
    state: 'open',
    cooloffUntil: fixture.nowMs - 45 * MINUTE,
    restartRequested: true,
  };
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.reason, 'wedged_no_cycle_progress');
});

test('status contract exposes wedged and sentinel as additive fields', () => {
  const ports = { app: 43210, websocket: 43240, dashboard: 43244, mcpHttp: 43247 };
  const activeContext = {
    runName: 'labor23', brainId: 'brain-abc123', topic: 'labor',
    startedAt: '2026-07-22T11:00:00.000Z', runPath: '/tmp/labor23',
  };
  const processStatus = { running: [{ name: 'cosmo-main', pid: 4242, killed: false }], count: 1 };

  const escalatedStatus = buildStatusContract({
    activeContext,
    processStatus,
    heartbeat: null,
    sentinel: {
      runPath: '/tmp/labor23', runName: 'labor23', attempts: 2, maxAttempts: 2,
      lastAttemptAt: '2026-07-22T12:30:00.000Z', lastReason: 'wedged_no_cycle_progress',
      escalated: true, escalatedAt: '2026-07-22T13:00:00.000Z',
      recoveries: 0, pendingRelaunch: false, lastCheckAt: null, lastOutcome: 'escalated',
    },
    ports,
    now: new Date('2026-07-22T13:01:00.000Z'),
  });
  assert.equal(escalatedStatus.wedged, true);
  assert.equal(escalatedStatus.sentinel.escalated, true);
  // Additive only: lifecycle keeps its Patch 9 value set.
  assert.equal(escalatedStatus.lifecycle, 'running');
  assert.equal(escalatedStatus.activeRun, true);

  const plainStatus = buildStatusContract({
    activeContext: null,
    processStatus: { running: [], count: 0 },
    heartbeat: null,
    ports,
    now: new Date('2026-07-22T13:01:00.000Z'),
  });
  assert.equal(plainStatus.wedged, false);
  assert.equal(plainStatus.sentinel, null);
  assert.equal(plainStatus.lifecycle, 'idle');
});
