'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRunSentinel,
  createContinuationRelauncher,
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

// PIN SCOPE CHANGE (fix-first follow-up to d7b76f86): this pin originally
// covered EVERY run-ended notification during remediation — including user
// stops, which wrongly let the sentinel resurrect a run jtr had killed. It
// now pins only the NON-user path (cosmo-exit fired by the sentinel's own
// remediation stop must not wipe the ladder). User-initiated stops take the
// force path instead — see the 'user stop during an in-flight remediation'
// test below.
test('run-ended notification (cosmo-exit) during an in-flight remediation does not wipe ladder state', async (t) => {
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

// --- I1/I2 (fix-first follow-up to d7b76f86): user intent is final -----------
// A user /api/stop must never be undone by the sentinel: no zombie
// resurrection mid-remediation, no pending-relaunch retry afterwards, and the
// wedged flag must not outlive the run the user stopped. Evidence is archived
// (.sentinel.json → .sentinel.json.last), never silently deleted.

test('I1: user stop during an in-flight remediation aborts the relaunch and clears state', async (t) => {
  const fixture = await makeFixture(t);
  const stopStarted = deferred();
  const stopGate = deferred();
  fixture.stopImpl = async () => {
    stopStarted.resolve();
    await stopGate.promise;
    fixture.activeContext = null;
    fixture.processRunning = [];
  };

  wedgeHeartbeat(fixture);
  const inFlight = fixture.sentinel.check();
  await stopStarted.promise;

  // jtr hits /api/stop while the sentinel is mid-stopAll. The context is
  // already gone (the sentinel's own stopEngine cleared it), but the stop
  // must still be FINAL.
  const cleaned = await fixture.sentinel.notifyRunEnded({ runPath: fixture.runPath, userInitiated: true });
  assert.equal(cleaned.cleaned, true);

  stopGate.resolve();
  const result = await inFlight;
  assert.equal(result.outcome, 'aborted_user_stop');
  assert.equal(fixture.relaunchCalls.length, 0);
  assert.equal(fixture.sentinel.getPublicState(), null);
  assert.equal(await fixture.stateFileExists(), false);
  // Evidence archived, never silently deleted.
  const archived = JSON.parse(await fs.readFile(`${fixture.statePath}.last`, 'utf8'));
  assert.equal(archived.attempts.length, 1);
});

test('I1: user stop after a failed relaunch cancels the pending retry', async (t) => {
  const fixture = await makeFixture(t);
  fixture.relaunchImpl = async () => {
    fixture.activeContext = null;
    throw new Error('launch refused: provider offline');
  };
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediation_failed');

  // /api/stop sees no active run (not_running branch) so it has no runPath —
  // the sentinel must fall back to its tracked run and stand down anyway.
  const cleaned = await fixture.sentinel.notifyRunEnded({ userInitiated: true });
  assert.equal(cleaned.cleaned, true);

  const next = await fixture.sentinel.check();
  assert.equal(next.outcome, 'idle');
  assert.equal(fixture.relaunchCalls.length, 1); // no retry resurrection
  assert.equal(fixture.sentinel.getPublicState(), null);
});

// Task 7 polish (a): the pre-relaunch epoch check has a blind spot — a stop
// that lands while deps.relaunch() itself is resolving passes the check but
// still resurrects the run. The epoch is re-checked AFTER relaunch resolves;
// a late stop kills the fresh child (stopEngine again, 'aborted_user_stop_late').
test('I1: user stop during the relaunch window kills the fresh run (aborted_user_stop_late)', async (t) => {
  const fixture = await makeFixture(t);
  const relaunchStarted = deferred();
  const relaunchGate = deferred();
  fixture.relaunchImpl = async (info) => {
    relaunchStarted.resolve();
    await relaunchGate.promise;
    fixture.activeContext = {
      runName: info.runName, runPath: info.runPath, brainId: info.brainId,
      startedAt: '2026-07-22T11:00:00.000Z',
    };
    fixture.processRunning = [{ name: 'cosmo-main', pid: 4243, killed: false }];
    return { success: true };
  };

  wedgeHeartbeat(fixture);
  const inFlight = fixture.sentinel.check();
  await relaunchStarted.promise;

  // jtr hits /api/stop after the pre-relaunch check already passed.
  const cleaned = await fixture.sentinel.notifyRunEnded({ runPath: fixture.runPath, userInitiated: true });
  assert.equal(cleaned.cleaned, true);

  relaunchGate.resolve();
  const result = await inFlight;
  assert.equal(result.outcome, 'aborted_user_stop_late');
  assert.equal(fixture.stopCalls.length, 2, 'remediation stop + fresh-run kill');
  assert.equal(fixture.stopCalls[1].reason, 'user_stop_during_relaunch');
  assert.equal(fixture.relaunchCalls.length, 1);
  assert.equal(fixture.sentinel.getPublicState(), null);
  assert.equal(fixture.activeContext, null, 'the resurrected run must be dead');
});

// Task 7 polish (a): /api/stop's ACTIVE branch used to stamp userStopEpoch
// only in its finally (via notifyRunEnded) — AFTER an awaited stopAll. A
// remediation between its own stop and relaunch during that window saw no
// epoch and relaunched. The intent stamp now lands BEFORE stopAll.
test('server /api/stop ACTIVE branch stamps user-stop intent BEFORE stopAll (sub-second race)', () => {
  const src = fsSync.readFileSync(path.resolve(__dirname, '../../cosmo23/server/index.js'), 'utf8');
  const handlerIdx = src.indexOf("app.post('/api/stop'");
  assert.ok(handlerIdx >= 0, '/api/stop handler present');
  const handler = src.slice(handlerIdx, handlerIdx + 2600);
  const stampIdx = handler.indexOf('runSentinel.recordUserStopIntent()');
  const stopAllIdx = handler.indexOf('processManager.stopAll()');
  assert.ok(stampIdx >= 0, 'ACTIVE branch must stamp user-stop intent');
  assert.ok(stopAllIdx >= 0, 'stopAll call present in the handler window');
  assert.ok(stampIdx < stopAllIdx, 'intent stamp must precede stopAll');
});

test('recordUserStopIntent stamps the epoch without touching ladder state', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // ladder has 1 attempt
  fixture.sentinel.recordUserStopIntent();
  assert.equal(fixture.sentinel.userStopEpoch, fixture.nowMs);
  assert.equal(fixture.sentinel.getPublicState().attempts, 1, 'ladder untouched');
  assert.equal(await fixture.stateFileExists(), true, 'state file untouched (finally still archives it)');
});

test('I2: user stop of an escalated (dead) run clears the wedged flag and archives evidence', async (t) => {
  const fixture = await makeFixture(t);
  // Exhaust the ladder → escalated.
  wedgeHeartbeat(fixture);
  await fixture.sentinel.check();
  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  await fixture.sentinel.check();
  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'escalated');
  assert.equal(fixture.sentinel.getPublicState().escalated, true);

  // An escalated run's engine is dead — no cosmo-exit will ever fire for it,
  // so without the user-stop path wedged:true would persist until a server
  // restart. jtr stops the run.
  const cleaned = await fixture.sentinel.notifyRunEnded({
    runPath: fixture.runPath, runName: 'labor23', userInitiated: true,
  });
  assert.equal(cleaned.cleaned, true);
  // Status contract now reports wedged:false / sentinel:null.
  assert.equal(fixture.sentinel.getPublicState(), null);
  assert.equal(await fixture.stateFileExists(), false);
  const archived = JSON.parse(await fs.readFile(`${fixture.statePath}.last`, 'utf8'));
  assert.equal(archived.escalated, true); // evidence preserved
});

test('I2: a fresh launch gets ladder amnesty — no inherited wedged flag, fresh ladder on a real wedge', async (t) => {
  const fixture = await makeFixture(t);
  // A previous run in the same directory escalated 90 minutes ago (well
  // within attemptTtlMs) and its state file survived — e.g. the server
  // crashed, so neither cosmo-exit cleanup nor a user stop ever ran.
  await fs.writeFile(fixture.statePath, JSON.stringify({
    version: 1,
    runPath: fixture.runPath,
    runName: 'labor23',
    brainId: 'brain-abc123',
    attempts: [
      { at: new Date(fixture.nowMs - 120 * MINUTE).toISOString(), reason: 'wedged_no_cycle_progress', ok: true, error: null },
      { at: new Date(fixture.nowMs - 90 * MINUTE).toISOString(), reason: 'wedged_no_cycle_progress', ok: true, error: null },
    ],
    recoveries: 0,
    escalated: true,
    escalatedAt: new Date(fixture.nowMs - 90 * MINUTE).toISOString(),
  }, null, 2), 'utf8');

  // A NEW launch of the same run, 2 minutes ago (still inside launch grace).
  fixture.activeContext.startedAt = new Date(fixture.nowMs - 2 * MINUTE).toISOString();
  const inGrace = await fixture.sentinel.check();
  assert.equal(inGrace.reason, 'launch_grace');
  // The fresh launch must not wear the old run's wedged flag.
  assert.equal(fixture.sentinel.getPublicState().escalated, false);
  assert.equal(fixture.sentinel.getPublicState().attempts, 0);

  // Past grace, a REAL wedge gets a fresh bounded ladder (attempt 1, not a
  // silent escalated no-op).
  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.attempt, 1);
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

// --- Live-drill fix (2026-07-22): direct-path relaunch, never the catalog ---
// The Phase 2 live wedge drill proved detection, stopAll, ladder bounds and
// escalation — but BOTH relaunch attempts failed with "Brain not found". The
// old wiring replayed metadata through catalog-backed launchResearch
// (ensureLocalBrainForLaunch → resolveCatalogBrainBySelector), and the brain
// catalog only lists completed/queryable brains (Patch 69 lifecycle
// authority: memory-manifest + COMPLETED plan). A young, mid-run, just-killed
// brain — the sentinel's primary clientele — is not in it. The relauncher
// must build the continuation directly from the tracked run directory.

function makeRelauncherFixture() {
  const fx = {
    activeContext: null,
    isLaunching: false,
    preparedCalls: [],
  };
  fx.relauncher = createContinuationRelauncher({
    getActiveContext: () => fx.activeContext,
    getIsLaunching: () => fx.isLaunching,
    setIsLaunching: (value) => { fx.isLaunching = value; },
    launchPreparedResearch: async (brain, payload, req) => {
      fx.preparedCalls.push({ brain, payload, req, isLaunchingDuring: fx.isLaunching });
      fx.activeContext = {
        runName: brain.name,
        runPath: brain.path,
        brainId: brain.id,
        topic: brain.topic,
        startedAt: new Date().toISOString(),
      };
      return { success: true, runName: brain.name };
    },
  });
  return fx;
}

test('direct relauncher continues a non-catalog run from its run directory', async (t) => {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-relaunch-'));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({
    topic: 'vector database indexing strategies compared',
    executionMode: 'agentic',
    cycles: 12,
    enableWebSearch: true,
  }), 'utf8');

  const fx = makeRelauncherFixture();
  const result = await fx.relauncher({
    runPath, runName: path.basename(runPath), brainId: '4ef0f7b02fb77c4b',
  });
  assert.equal(result.success, true);
  assert.equal(fx.preparedCalls.length, 1);
  const { brain, payload, isLaunchingDuring } = fx.preparedCalls[0];
  assert.equal(brain.path, runPath); // exact run dir — no catalog indirection
  assert.equal(brain.name, path.basename(runPath));
  assert.equal(brain.id, '4ef0f7b02fb77c4b');
  assert.equal(brain.hasState, true); // a relaunch is a continuation by definition
  assert.equal(brain.topic, 'vector database indexing strategies compared');
  // metadata.json launch settings replay into the payload
  assert.equal(payload.executionMode, 'agentic');
  assert.equal(payload.cycles, 12);
  assert.equal(payload.enableWebSearch, true);
  assert.equal(payload.brainId, '4ef0f7b02fb77c4b');
  // launchResearch's isLaunching bracket is preserved
  assert.equal(isLaunchingDuring, true);
  assert.equal(fx.isLaunching, false);
});

test('409 race: a user launch that wins the stop→relaunch gap fails the relaunch without clobbering isLaunching', async () => {
  const fx = makeRelauncherFixture();
  fx.activeContext = { runName: 'user-run', runPath: '/tmp/user-run', startedAt: new Date().toISOString() };
  await assert.rejects(
    fx.relauncher({ runPath: '/tmp/old-run', runName: 'old-run', brainId: 'abc' }),
    (error) => error.statusCode === 409,
  );
  assert.equal(fx.preparedCalls.length, 0);

  fx.activeContext = null;
  fx.isLaunching = true; // user launch mid-preparation
  await assert.rejects(
    fx.relauncher({ runPath: '/tmp/old-run', runName: 'old-run', brainId: 'abc' }),
    (error) => error.statusCode === 409,
  );
  assert.equal(fx.preparedCalls.length, 0);
  assert.equal(fx.isLaunching, true); // the user's flag must NOT be reset by the loser
});

test('missing metadata.json: relaunch still proceeds with a brainId-only payload and name fallbacks', async (t) => {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-relaunch-'));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));

  const fx = makeRelauncherFixture();
  const result = await fx.relauncher({ runPath, runName: 'labor23', brainId: 'brain-abc123' });
  assert.equal(result.success, true);
  const { brain, payload } = fx.preparedCalls[0];
  assert.equal(brain.path, runPath);
  assert.equal(brain.name, 'labor23');
  assert.equal(brain.topic, 'labor23'); // falls back to the run name
  assert.deepEqual(payload, { brainId: 'brain-abc123' });
});

test('missing brainId: relaunch derives the id from the run path (server sha1 convention)', async (t) => {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-relaunch-'));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));

  const fx = makeRelauncherFixture();
  await fx.relauncher({ runPath, runName: 'labor23', brainId: null });
  const { brain, payload } = fx.preparedCalls[0];
  assert.match(brain.id, /^[0-9a-f]{16}$/);
  assert.equal(brain.routeKey, brain.id);
  assert.equal(payload.brainId, brain.id);
});

test('sentinel end-to-end: a wedged non-catalog run relaunches via the direct path', async (t) => {
  const fixture = await makeFixture(t);
  const prepared = [];
  const relauncher = createContinuationRelauncher({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    setIsLaunching: (value) => { fixture.isLaunching = value; },
    launchPreparedResearch: async (brain, payload) => {
      prepared.push({ brain, payload });
      fixture.activeContext = {
        runName: brain.name, runPath: brain.path, brainId: brain.id,
        startedAt: '2026-07-22T11:00:00.000Z',
      };
      fixture.processRunning = [{ name: 'cosmo-main', pid: 4243, killed: false }];
      return { success: true };
    },
  });
  fixture.relaunchImpl = (info) => relauncher(info);

  wedgeHeartbeat(fixture);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].brain.path, fixture.runPath);
  assert.equal(prepared[0].payload.brainId, 'brain-abc123');
});

test('index.js wires the sentinel relaunch through the direct-path relauncher, not catalog resolution', async () => {
  const src = await fs.readFile(path.resolve(__dirname, '../../cosmo23/server/index.js'), 'utf8');
  // Live-drill regression pin: catalog-backed launchResearch throws
  // "Brain not found" for young mid-run brains (ensureLocalBrainForLaunch →
  // resolveCatalogBrainBySelector only sees completed/queryable brains). The
  // relaunch leg must go straight to launchPreparedResearch from the tracked
  // run directory. Phase 4 (component 4.5) hoisted the relauncher so the
  // sentinel and POST /api/resume share the SAME instance and cannot drift.
  const relauncherStart = src.indexOf('const continuationRelauncher = createContinuationRelauncher({');
  assert.notEqual(relauncherStart, -1, 'hoisted direct-path relauncher present');
  const relauncherEnd = src.indexOf('\n});', relauncherStart);
  assert.notEqual(relauncherEnd, -1, 'relauncher block closed');
  const relauncherBlock = src.slice(relauncherStart, relauncherEnd);
  assert.ok(relauncherBlock.includes('launchPreparedResearch'),
    'relauncher must replay through launchPreparedResearch');
  assert.ok(!relauncherBlock.includes('launchResearch('),
    'relauncher must not route through catalog-backed launchResearch');
  const start = src.indexOf('const runSentinel = createRunSentinel({');
  assert.notEqual(start, -1, 'sentinel wiring block present');
  const end = src.indexOf('\n});', start);
  assert.notEqual(end, -1, 'sentinel wiring block closed');
  const block = src.slice(start, end);
  assert.ok(block.includes('relaunch: continuationRelauncher'),
    'sentinel relaunch must be the shared direct-path relauncher');
  assert.ok(!block.includes('launchResearch('),
    'relaunch must not route through catalog-backed launchResearch');
  const resumeStart = src.indexOf("app.post('/api/resume', createResumeHandler({");
  assert.notEqual(resumeStart, -1, 'resume endpoint present');
  const resumeEnd = src.indexOf('}));', resumeStart);
  assert.notEqual(resumeEnd, -1, 'resume wiring block closed');
  const resumeBlock = src.slice(resumeStart, resumeEnd);
  assert.ok(resumeBlock.includes('continuationRelauncher(info)'),
    'resume must relaunch through the shared direct-path relauncher');
});
