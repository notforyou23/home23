'use strict';

// Phase 4 (component 4.5) — operator rails: parked-run recognition, derived
// Needs-You intents, and the /api/resume flow. Real-behavior tests: park
// files are real files in mkdtemp run dirs, the sentinel-skips-parked tests
// drive the REAL RunSentinel through its default park reader, and the resume
// tests drive the REAL createContinuationRelauncher metadata replay.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  PARK_STATE_FILENAME,
  PARK_ARCHIVE_SUFFIX,
  PARK_EXIT_CODE,
  readParkFile,
  archiveParkFile,
  restoreParkFile,
  normalizeParkDetail,
  deriveOperatorIntents,
  createParkedRunResolver,
  createResumeHandler,
} = require('../../cosmo23/server/lib/operator-intents');
const { createRunSentinel, createContinuationRelauncher } = require('../../cosmo23/server/lib/run-sentinel');
const { buildStatusContract } = require('../../cosmo23/server/lib/status-contract');

const MINUTE = 60 * 1000;

const SAMPLE_PARK = Object.freeze({
  reason: 'spend_budget_critical',
  lane: 'spend',
  at: '2026-07-22T11:30:00.000Z',
  resumable: true,
});

async function makeRunDir(t, prefix = 'cosmo23-operator-intents-') {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));
  return runPath;
}

async function writePark(runPath, park = SAMPLE_PARK) {
  await fs.writeFile(path.join(runPath, PARK_STATE_FILENAME), JSON.stringify(park, null, 2), 'utf8');
}

function createFakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('park exit code is the R2 contract value', () => {
  assert.equal(PARK_EXIT_CODE, 81);
  assert.equal(PARK_STATE_FILENAME, '.park.json');
});

test('readParkFile: missing and corrupt files read as not parked; archive/restore round-trip', async (t) => {
  const runPath = await makeRunDir(t);
  assert.equal(await readParkFile(runPath), null);
  assert.equal(await archiveParkFile(runPath), false, 'nothing to archive');

  await fs.writeFile(path.join(runPath, PARK_STATE_FILENAME), 'not json{', 'utf8');
  assert.equal(await readParkFile(runPath), null, 'corrupt park file reads as not parked');

  await writePark(runPath);
  const park = await readParkFile(runPath);
  assert.equal(park.reason, 'spend_budget_critical');

  assert.equal(await archiveParkFile(runPath), true);
  assert.equal(await readParkFile(runPath), null, 'archived park no longer reads as parked');
  const archived = JSON.parse(await fs.readFile(
    path.join(runPath, `${PARK_STATE_FILENAME}${PARK_ARCHIVE_SUFFIX}`), 'utf8'));
  assert.equal(archived.lane, 'spend', 'evidence preserved, never deleted');

  assert.equal(await restoreParkFile(runPath), true);
  assert.equal((await readParkFile(runPath)).lane, 'spend');
  assert.equal(await restoreParkFile(runPath), false, 'nothing left to restore');
});

test('deriveOperatorIntents: parked run yields a run_parked action intent', () => {
  const intents = deriveOperatorIntents({
    parked: { runPath: '/runs/labor23', runName: 'labor23', brainId: 'brain-1', park: SAMPLE_PARK },
  });
  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert.equal(intent.type, 'run_parked');
  assert.equal(intent.severity, 'action');
  assert.equal(intent.id, 'run_parked:/runs/labor23');
  assert.equal(intent.runName, 'labor23');
  assert.equal(intent.reason, 'spend_budget_critical');
  assert.equal(intent.lane, 'spend');
  assert.equal(intent.since, '2026-07-22T11:30:00.000Z');
  assert.equal(intent.resumable, true);
  assert.deepEqual(intent.actions, ['resume', 'stop']);
});

test('deriveOperatorIntents: sentinel escalation yields run_wedged_escalated', () => {
  const intents = deriveOperatorIntents({
    sentinel: {
      runPath: '/runs/labor23',
      runName: 'labor23',
      attempts: 2,
      maxAttempts: 2,
      lastReason: 'wedged_no_cycle_progress',
      escalated: true,
      escalatedAt: '2026-07-22T12:00:00.000Z',
    },
  });
  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert.equal(intent.type, 'run_wedged_escalated');
  assert.equal(intent.severity, 'action');
  assert.equal(intent.reason, 'wedged_no_cycle_progress');
  assert.equal(intent.since, '2026-07-22T12:00:00.000Z');
  assert.equal(intent.attempts, 2);
  assert.deepEqual(intent.actions, ['relaunch', 'stop']);
});

test('deriveOperatorIntents: non-escalated sentinel yields no wedged intent', () => {
  const intents = deriveOperatorIntents({
    sentinel: { runPath: '/runs/labor23', attempts: 1, escalated: false },
  });
  assert.deepEqual(intents, []);
});

test('deriveOperatorIntents: spend advisory only at/over the warn ratio, honest about level', () => {
  const base = { totals: { tokens: 850 }, budget: { maxTokens: 1000 } };
  const warn = deriveOperatorIntents({ spend: base });
  assert.equal(warn.length, 1);
  assert.equal(warn[0].type, 'spend_warning');
  assert.equal(warn[0].severity, 'advisory');
  assert.equal(warn[0].level, 'warn');
  assert.equal(warn[0].unit, 'tokens');
  assert.equal(warn[0].ratio, 0.85);
  assert.deepEqual(warn[0].actions, []);

  const critical = deriveOperatorIntents({
    spend: { totals: { tokens: 1200, usd: 1 }, budget: { maxTokens: 1000, maxUsd: 100 } },
  });
  assert.equal(critical.length, 1);
  assert.equal(critical[0].level, 'critical', 'over budget reads critical');
  assert.equal(critical[0].unit, 'tokens', 'worst ratio wins');

  assert.deepEqual(
    deriveOperatorIntents({ spend: { totals: { tokens: 500 }, budget: { maxTokens: 1000 } } }),
    [], 'below the warn ratio: no intent');
  assert.deepEqual(
    deriveOperatorIntents({ spend: { totals: { tokens: 999999 } } }),
    [], 'no budget configured: no intent, never an estimate');
  const custom = deriveOperatorIntents({
    spend: { totals: { tokens: 600 }, budget: { maxTokens: 1000 } },
    config: { spendWarnRatio: 0.5 },
  });
  assert.equal(custom.length, 1, 'config.spendWarnRatio is honored');
});

test('deriveOperatorIntents: action intents order before advisories; empty input derives nothing', () => {
  assert.deepEqual(deriveOperatorIntents({}), []);
  assert.deepEqual(deriveOperatorIntents(), []);
  const intents = deriveOperatorIntents({
    parked: { runPath: '/runs/a', runName: 'a', brainId: null, park: SAMPLE_PARK },
    sentinel: { runPath: '/runs/b', escalated: true },
    spend: { totals: { tokens: 900 }, budget: { maxTokens: 1000 } },
  });
  assert.deepEqual(intents.map((intent) => intent.type),
    ['run_parked', 'run_wedged_escalated', 'spend_warning']);
});

test('parked-run resolver: active context first, last park re-verified, newest scan wins, TTL cache', async (t) => {
  const runsPath = await makeRunDir(t, 'cosmo23-runs-');
  const runA = path.join(runsPath, 'run-a');
  const runB = path.join(runsPath, 'run-b');
  await fs.mkdir(runA);
  await fs.mkdir(runB);
  await writePark(runA, { ...SAMPLE_PARK, at: '2026-07-22T10:00:00.000Z' });
  await writePark(runB, { ...SAMPLE_PARK, at: '2026-07-22T11:00:00.000Z', runName: 'named-b' });

  let activeContext = null;
  let lastParked = null;
  let nowMs = Date.parse('2026-07-22T12:00:00.000Z');
  const resolver = createParkedRunResolver({
    getActiveContext: () => activeContext,
    getLastParked: () => lastParked,
    runsPath,
    now: () => nowMs,
    scanTtlMs: 30 * 1000,
  });

  // 3) scan fallback: newest park.at wins, park.runName preferred.
  const scanned = await resolver.resolve();
  assert.equal(scanned.runPath, runB);
  assert.equal(scanned.runName, 'named-b');

  // TTL cache: a park archived underneath is still reported until expiry...
  await archiveParkFile(runB);
  assert.equal((await resolver.resolve()).runPath, runB, 'cached inside TTL');
  nowMs += 31 * 1000;
  const rescanned = await resolver.resolve();
  assert.equal(rescanned.runPath, runA, 'fresh scan after TTL sees the archive');
  // ...and invalidate() busts it immediately.
  await archiveParkFile(runA);
  resolver.invalidate();
  assert.equal(await resolver.resolve(), null, 'nothing parked anywhere');

  // 2) lastParked fast path is re-verified on disk.
  await restoreParkFile(runA);
  lastParked = { runPath: runA, runName: 'run-a', brainId: 'brain-a' };
  resolver.invalidate();
  const viaLast = await resolver.resolve();
  assert.equal(viaLast.runPath, runA);
  assert.equal(viaLast.brainId, 'brain-a');

  // 1) active context park wins over everything.
  await restoreParkFile(runB);
  activeContext = { runPath: runB, runName: 'run-b-active', brainId: 'brain-b' };
  const viaActive = await resolver.resolve();
  assert.equal(viaActive.runPath, runB);
  assert.equal(viaActive.runName, 'run-b-active');
});

function makeSentinelFixture(t, runPath) {
  const fixture = {
    runPath,
    nowMs: Date.parse('2026-07-22T12:00:00.000Z'),
    activeContext: {
      runName: 'labor23',
      runPath,
      brainId: 'brain-abc123',
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
    stopCalls: [],
    relaunchCalls: [],
    logs: [],
    relaunchImpl: null,
  };
  fixture.sentinel = createRunSentinel({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    getProcessStatus: () => ({ running: fixture.processRunning, count: fixture.processRunning.length }),
    readHeartbeat: async () => fixture.heartbeat,
    readWatchdog: async () => null,
    // NOTE: no readParkFile injection — these tests exercise the DEFAULT
    // reader against real .park.json files in the run dir.
    stopEngine: async (info) => {
      fixture.stopCalls.push(info);
      fixture.activeContext = null;
      fixture.processRunning = [];
    },
    relaunch: async (info) => {
      fixture.relaunchCalls.push(info);
      if (fixture.relaunchImpl) return fixture.relaunchImpl(info);
      fixture.activeContext = {
        runName: info.runName,
        runPath: info.runPath,
        brainId: info.brainId,
        startedAt: '2026-07-22T11:00:00.000Z',
      };
      fixture.processRunning = [{ name: 'cosmo-main', pid: 4243, killed: false }];
      return { success: true };
    },
    log: (level, message) => fixture.logs.push({ level, message }),
    now: () => fixture.nowMs,
    config: {
      checkIntervalMs: MINUTE,
      wedgeThresholdMs: 15 * MINUTE,
      launchGraceMs: 5 * MINUTE,
      maxAttempts: 2,
      breakerStuckMs: 30 * MINUTE,
    },
  });
  return fixture;
}

test('sentinel skips a parked run instead of remediating engine death', async (t) => {
  const runPath = await makeRunDir(t);
  const fixture = makeSentinelFixture(t, runPath);
  fixture.processRunning = []; // engine exited (park exit) — context still set
  await writePark(runPath);

  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'parked');
  assert.equal(result.reason, 'run_parked');
  assert.equal(fixture.stopCalls.length, 0, 'no stop for a parked run');
  assert.equal(fixture.relaunchCalls.length, 0, 'no relaunch for a parked run');
  assert.match(fixture.logs.map((entry) => entry.message).join('\n'), /is parked/);

  // Repeat checks stay quiet (log-once) and still stand down.
  const logCount = fixture.logs.length;
  assert.equal((await fixture.sentinel.check()).outcome, 'parked');
  assert.equal(fixture.logs.length, logCount, 'parked skip logs once');

  // Control: with the park file archived (resume path), the SAME state is a
  // real death and remediation proceeds.
  await archiveParkFile(runPath);
  const remediated = await fixture.sentinel.check();
  assert.equal(remediated.outcome, 'remediated');
  assert.equal(fixture.relaunchCalls.length, 1);
});

test('sentinel skips a parked run instead of remediating a progress-stale wedge', async (t) => {
  const runPath = await makeRunDir(t);
  const fixture = makeSentinelFixture(t, runPath);
  // Progress stalled 20 minutes ago; liveness ts fresh (park save in flight).
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleStartTs: new Date(fixture.nowMs - 21 * MINUTE).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 20 * MINUTE).toISOString(),
  };
  await writePark(runPath, { reason: 'progress_stalled_park', lane: 'progress', at: '2026-07-22T11:40:00.000Z', resumable: true });

  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'parked');
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);

  await archiveParkFile(runPath);
  const remediated = await fixture.sentinel.check();
  assert.equal(remediated.outcome, 'remediated', 'control: same wedge remediates once unparked');
});

test('a park cancels a pending sentinel relaunch retry', async (t) => {
  const runPath = await makeRunDir(t);
  const fixture = makeSentinelFixture(t, runPath);
  fixture.processRunning = [];
  fixture.relaunchImpl = async () => {
    throw new Error('relaunch transport failed');
  };

  const failed = await fixture.sentinel.check();
  assert.equal(failed.outcome, 'remediation_failed');
  assert.equal(fixture.sentinel.getPublicState().pendingRelaunch, true, 'retry owed');

  // The engine parked (e.g. governance landed the park during the window).
  fixture.activeContext = null;
  await writePark(runPath);
  const parked = await fixture.sentinel.check();
  assert.equal(parked.outcome, 'parked');
  assert.equal(fixture.sentinel.getPublicState().pendingRelaunch, false, 'retry cancelled');
  assert.equal(fixture.relaunchCalls.length, 1, 'no second relaunch attempt');
});

function makeResumeFixture(t, parkedRun) {
  const fixture = {
    activeContext: null,
    isLaunching: false,
    launchCalls: [],
    resumedCalls: [],
    logs: [],
    launchImpl: null,
  };
  const relauncher = createContinuationRelauncher({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    setIsLaunching: (value) => { fixture.isLaunching = value; },
    launchPreparedResearch: async (brain, payload, req) => {
      fixture.launchCalls.push({ brain, payload, req });
      if (fixture.launchImpl) return fixture.launchImpl(brain, payload, req);
      fixture.activeContext = { runName: brain.name, runPath: brain.path, brainId: brain.id };
      return {
        success: true,
        runName: brain.name,
        brainId: brain.id,
        brainPath: brain.path,
        brainSourceType: brain.sourceType,
        isContinuation: brain.hasState,
      };
    },
  });
  fixture.handler = createResumeHandler({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    resolveParkedRun: async () => (typeof parkedRun === 'function' ? parkedRun() : parkedRun),
    relaunch: relauncher,
    onResumed: (resumed) => fixture.resumedCalls.push(resumed),
    log: (level, message) => fixture.logs.push({ level, message }),
  });
  return fixture;
}

test('POST /api/resume: archives the park file and relaunches via the metadata replay continuation', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath);
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({
    topic: 'labor parity',
    maxCycles: 42,
    explorationMode: 'guided',
  }), 'utf8');

  const parkedRun = { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK };
  const fixture = makeResumeFixture(t, parkedRun);
  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.resumed, true);
  assert.equal(res.body.runName, 'labor23');
  assert.equal(res.body.park.reason, 'spend_budget_critical');
  assert.equal(res.body.brainPath, undefined, 'internal paths stripped like /api/launch');
  assert.equal(res.body.brainSourceType, undefined);

  // Park file archived BEFORE the relaunch, evidence preserved.
  assert.equal(await readParkFile(runPath), null);
  const archived = JSON.parse(await fs.readFile(
    path.join(runPath, `${PARK_STATE_FILENAME}${PARK_ARCHIVE_SUFFIX}`), 'utf8'));
  assert.equal(archived.reason, 'spend_budget_critical');

  // The REAL continuation relauncher replayed metadata.json (Patch 71 path).
  assert.equal(fixture.launchCalls.length, 1);
  const { brain, payload } = fixture.launchCalls[0];
  assert.equal(brain.path, runPath);
  assert.equal(brain.name, 'labor23');
  assert.equal(brain.hasState, true, 'resume is a continuation');
  assert.match(brain.id, /^[0-9a-f]{16}$/, 'sha1 run-path id convention');
  assert.equal(payload.topic, 'labor parity');
  assert.equal(payload.maxCycles, 42);
  assert.equal(payload.brainId, brain.id);
  assert.equal(fixture.resumedCalls.length, 1);
});

test('POST /api/resume: 409 not_parked when nothing is parked', async (t) => {
  const fixture = makeResumeFixture(t, null);
  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_parked');
  assert.equal(fixture.launchCalls.length, 0);
});

test('POST /api/resume: 409 not_parked when the park file vanished after resolve (concurrent resume)', async (t) => {
  const runPath = await makeRunDir(t);
  // Resolver claims parked, but no .park.json exists on disk — the archive
  // step loses the race and must 409 instead of relaunching.
  const fixture = makeResumeFixture(t, { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK });
  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_parked');
  assert.equal(fixture.launchCalls.length, 0, 'no relaunch without winning the archive');
});

test('POST /api/resume: 409 already_running while a run is active or launching', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath);
  const fixture = makeResumeFixture(t, { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK });

  fixture.activeContext = { runName: 'other', runPath: '/elsewhere' };
  const resActive = createFakeRes();
  await fixture.handler({ body: {} }, resActive);
  assert.equal(resActive.statusCode, 409);
  assert.equal(resActive.body.code, 'already_running');

  fixture.activeContext = null;
  fixture.isLaunching = true;
  const resLaunching = createFakeRes();
  await fixture.handler({ body: {} }, resLaunching);
  assert.equal(resLaunching.statusCode, 409);
  assert.equal(resLaunching.body.code, 'already_running');
  assert.equal(await readParkFile(runPath) !== null, true, 'park file untouched');
});

test('POST /api/resume: a failed relaunch restores the park file so the run stays parked', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath);
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({ topic: 'labor' }), 'utf8');
  const fixture = makeResumeFixture(t, { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK });
  fixture.launchImpl = async () => {
    throw new Error('provider exploded');
  };

  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /provider exploded/);
  assert.equal(fixture.resumedCalls.length, 0);
  const restored = await readParkFile(runPath);
  assert.equal(restored.reason, 'spend_budget_critical', 'park state restored');
  assert.equal(fixture.isLaunching, false, 'relauncher cleared its launching bracket');
});

test('POST /api/resume: explicit body.runPath resumes that run dir directly', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath, { ...SAMPLE_PARK, runName: 'named-in-park' });
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({ topic: 'x' }), 'utf8');
  const fixture = makeResumeFixture(t, null); // resolver sees nothing
  const res = createFakeRes();
  await fixture.handler({ body: { runPath } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.runName, 'named-in-park');
  assert.equal(fixture.launchCalls[0].brain.path, runPath);
});

test('status contract: parked/park/intents are additive and default-compatible', () => {
  const processStatus = { running: [], count: 0 };

  const before = buildStatusContract({ activeContext: null, processStatus, heartbeat: null });
  assert.equal(before.parked, false);
  assert.equal(before.park, null);
  assert.deepEqual(before.intents, [], 'absent inputs keep compat defaults');

  const park = {
    runPath: '/runs/labor23', runName: 'labor23', brainId: null,
    reason: 'spend_budget_critical', lane: 'spend', at: SAMPLE_PARK.at, resumable: true,
  };
  const intents = deriveOperatorIntents({
    parked: { runPath: '/runs/labor23', runName: 'labor23', brainId: null, park: SAMPLE_PARK },
  });

  const idleParked = buildStatusContract({ activeContext: null, processStatus, park, intents, heartbeat: null });
  assert.equal(idleParked.parked, true, 'no active run + park detail = parked');
  assert.equal(idleParked.park.reason, 'spend_budget_critical');
  assert.equal(idleParked.intents.length, 1);
  assert.equal(idleParked.lifecycle, 'idle', 'lifecycle value set unchanged (additive rule)');

  const otherRunActive = buildStatusContract({
    activeContext: { runName: 'other', runPath: '/runs/other', startedAt: SAMPLE_PARK.at },
    processStatus: { running: [{ name: 'cosmo-main', pid: 1 }], count: 1 },
    park,
    intents,
    heartbeat: null,
  });
  assert.equal(otherRunActive.parked, false, 'a DIFFERENT active run supersedes the parked flag');
  assert.equal(otherRunActive.intents.length, 1, 'but the Needs-You intent persists');

  const parkingActiveRun = buildStatusContract({
    activeContext: { runName: 'labor23', runPath: '/runs/labor23', startedAt: SAMPLE_PARK.at },
    processStatus,
    park,
    intents,
    heartbeat: null,
  });
  assert.equal(parkingActiveRun.parked, true, 'park of the tracked run itself reads parked');
});

test('normalizeParkDetail tolerates sparse park payloads', () => {
  assert.equal(normalizeParkDetail(null), null);
  assert.equal(normalizeParkDetail({}), null);
  const detail = normalizeParkDetail({ runPath: '/runs/x', park: {} });
  assert.equal(detail.runName, 'x', 'falls back to the dir basename');
  assert.equal(detail.reason, null);
  assert.equal(detail.resumable, true, 'resumable defaults true per R2');
});
