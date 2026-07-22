'use strict';

// Fix 2.1 (contracts H1 + H2) — engine heartbeat + server status exposure.
//
// H1: <logsDir>/.heartbeat, tmp+rename JSON { ts, pid, cycle,
//     lastCycleStartTs, lastCycleEndTs, phase }, stamped by an unref'd
//     interval (default 15s) plus at cycle start/end.
//     Liveness = ts freshness. Progress = lastCycleEndTs freshness.
//     A hung LLM await keeps ts fresh but lastCycleEndTs stale — wedge
//     detection must use progress, not liveness.
// H2: buildStatusContract reads the active run's .heartbeat and exposes
//     { lastHeartbeat, lastCycleEndTs, cycle, heartbeatAgeMs,
//       cycleProgressAgeMs } — lastHeartbeat is no longer permanently null.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HEARTBEAT_FILENAME,
  DEFAULT_INTERVAL_MS,
  HeartbeatWriter,
  heartbeatPath,
  writeHeartbeatFile,
  readHeartbeat,
  computeHeartbeatAges,
} = require('../../cosmo23/engine/src/core/heartbeat');
const { buildStatusContract } = require('../../cosmo23/server/lib/status-contract');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const ORCHESTRATOR_SOURCE = fsSync.readFileSync(
  require.resolve('../../cosmo23/engine/src/core/orchestrator.js'),
  'utf8'
);

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function makeTmpRunDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-heartbeat-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('heartbeat writer/reader round-trip preserves the H1 payload shape', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { pid: 4242 });
  t.after(() => writer.stop());

  const payload = writer.stamp({
    cycle: 7,
    lastCycleStartTs: '2026-07-22T10:00:00.000Z',
    phase: 'cycle_start',
  });
  assert.ok(payload, 'stamp returns the written payload');

  const readBack = readHeartbeat(dir);
  assert.ok(readBack, 'heartbeat file readable');
  assert.equal(readBack.pid, 4242);
  assert.equal(readBack.cycle, 7);
  assert.equal(readBack.lastCycleStartTs, '2026-07-22T10:00:00.000Z');
  assert.equal(readBack.lastCycleEndTs, null);
  assert.equal(readBack.phase, 'cycle_start');
  assert.ok(Number.isFinite(Date.parse(readBack.ts)), 'ts is a parseable ISO timestamp');

  // tmp+rename must not leave staging files behind
  const leftovers = (await fs.readdir(dir)).filter((name) => name !== HEARTBEAT_FILENAME);
  assert.deepEqual(leftovers, [], 'no .heartbeat.tmp-* staging files left');
});

test('heartbeat stamp merges patches — cycle-end stamp preserves cycle-start fields', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { pid: 1 });
  t.after(() => writer.stop());

  writer.stamp({ cycle: 3, lastCycleStartTs: '2026-07-22T10:00:00.000Z', phase: 'cycle_start' });
  writer.stamp({ lastCycleEndTs: '2026-07-22T10:00:09.000Z', phase: 'cycle_end' });

  const readBack = readHeartbeat(dir);
  assert.equal(readBack.cycle, 3, 'cycle survives the end-of-cycle stamp');
  assert.equal(readBack.lastCycleStartTs, '2026-07-22T10:00:00.000Z');
  assert.equal(readBack.lastCycleEndTs, '2026-07-22T10:00:09.000Z');
  assert.equal(readBack.phase, 'cycle_end');
});

test('staleness math distinguishes liveness (ts) from progress (lastCycleEndTs)', () => {
  const nowMs = Date.parse('2026-07-22T10:10:00.000Z');

  // The wedge signature: fresh ts (interval timer alive during a hung LLM
  // await) but stale lastCycleEndTs (no cycle completing).
  const wedged = computeHeartbeatAges({
    ts: '2026-07-22T10:09:55.000Z',
    lastCycleEndTs: '2026-07-22T09:40:00.000Z',
  }, nowMs);
  assert.equal(wedged.heartbeatAgeMs, 5000);
  assert.equal(wedged.cycleProgressAgeMs, 30 * 60 * 1000);
  assert.ok(
    wedged.cycleProgressAgeMs > wedged.heartbeatAgeMs,
    'wedge detection must key off progress, not liveness'
  );

  // Missing fields yield null, not fake freshness.
  assert.deepEqual(
    computeHeartbeatAges({ ts: '2026-07-22T10:09:55.000Z' }, nowMs),
    { heartbeatAgeMs: 5000, cycleProgressAgeMs: null }
  );
  assert.deepEqual(
    computeHeartbeatAges({ ts: 'not-a-date', lastCycleEndTs: 'garbage' }, nowMs),
    { heartbeatAgeMs: null, cycleProgressAgeMs: null }
  );
  assert.deepEqual(
    computeHeartbeatAges(null, nowMs),
    { heartbeatAgeMs: null, cycleProgressAgeMs: null }
  );

  // Minor clock skew (future ts) clamps to 0, never negative.
  const skewed = computeHeartbeatAges({ ts: '2026-07-22T10:10:01.000Z' }, nowMs);
  assert.equal(skewed.heartbeatAgeMs, 0);
});

test('heartbeat reader and writer never throw on bad input', async (t) => {
  const dir = await makeTmpRunDir(t);

  // Corrupt file -> null, no throw.
  await fs.writeFile(heartbeatPath(dir), '{ torn json');
  assert.equal(readHeartbeat(dir), null);

  // Non-object JSON -> null.
  await fs.writeFile(heartbeatPath(dir), '[1,2,3]');
  assert.equal(readHeartbeat(dir), null);

  // Missing dir -> null.
  assert.equal(readHeartbeat(path.join(dir, 'nope')), null);
  assert.equal(readHeartbeat(null), null);

  // Writer pointed at a nonexistent dir: stamp is best-effort — returns
  // null, never throws into the cycle. Warns exactly once.
  const warns = [];
  const writer = new HeartbeatWriter(path.join(dir, 'missing', 'nested'), {
    logger: { warn: (msg) => warns.push(msg) },
  });
  assert.equal(writer.stamp({ cycle: 1 }), null);
  assert.equal(writer.stamp({ cycle: 2 }), null);
  assert.equal(warns.length, 1, 'warns exactly once');
  writer.stop();
});

test('interval timer stamps liveness, is unref\'d, and stop() clears it', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { intervalMs: 20, pid: 99 });
  t.after(() => writer.stop());

  writer.start({ cycle: 1, phase: 'loop_start' });
  assert.ok(writer.timer, 'interval timer exists');
  assert.equal(writer.timer.hasRef(), false, 'timer must be unref\'d (cannot hold process open)');

  const first = readHeartbeat(dir);
  assert.equal(first.phase, 'loop_start');

  // The interval refreshes ts without any explicit stamp() call.
  const advanced = await waitFor(() => {
    const current = readHeartbeat(dir);
    return current && current.ts !== first.ts;
  });
  assert.ok(advanced, 'interval timer refreshed ts');

  // start() is idempotent — no second timer.
  const timerBefore = writer.timer;
  writer.start();
  assert.equal(writer.timer, timerBefore);

  writer.stop();
  assert.equal(writer.timer, null, 'stop() clears the interval');
  const stopped = readHeartbeat(dir);
  assert.equal(stopped.phase, 'stopped');

  // No further writes after stop.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(readHeartbeat(dir).ts, stopped.ts, 'no stamps after stop()');
});

test('default interval is 15s per H1 and config override wins', () => {
  const writer = new HeartbeatWriter('/tmp/unused');
  assert.equal(writer.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(DEFAULT_INTERVAL_MS, 15000);
  assert.equal(new HeartbeatWriter('/tmp/unused', { intervalMs: 250 }).intervalMs, 250);
  assert.equal(new HeartbeatWriter('/tmp/unused', { intervalMs: 'bogus' }).intervalMs, 15000);
  assert.equal(new HeartbeatWriter('/tmp/unused', { intervalMs: -5 }).intervalMs, 15000);
});

test('a never-started writer does not create a heartbeat file on stop()', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir);
  writer.stop();
  assert.equal(readHeartbeat(dir), null, 'no file written by stop() alone');
});

test('buildStatusContract reads the active run\'s .heartbeat from disk (H2)', async (t) => {
  const dir = await makeTmpRunDir(t);
  writeHeartbeatFile(dir, {
    ts: '2026-07-22T10:00:00.000Z',
    pid: 777,
    cycle: 42,
    lastCycleStartTs: '2026-07-22T09:59:30.000Z',
    lastCycleEndTs: '2026-07-22T09:50:00.000Z',
    phase: 'cycle_start',
  });

  const status = buildStatusContract({
    activeContext: { runName: 'run-hb', runPath: dir },
    processStatus: { running: [{ name: 'cosmo-main', pid: 777, killed: false }], count: 1 },
    ports: { app: 43210 },
    now: new Date('2026-07-22T10:00:05.000Z'),
  });

  assert.equal(status.lastHeartbeat, '2026-07-22T10:00:00.000Z',
    'lastHeartbeat no longer permanently null (Patch 9 gap closed)');
  assert.equal(status.heartbeat.cycle, 42);
  assert.equal(status.heartbeat.pid, 777);
  assert.equal(status.heartbeat.phase, 'cycle_start');
  assert.equal(status.heartbeat.lastCycleStartTs, '2026-07-22T09:59:30.000Z');
  assert.equal(status.heartbeat.lastCycleEndTs, '2026-07-22T09:50:00.000Z');
  assert.equal(status.heartbeat.heartbeatAgeMs, 5000);
  assert.equal(status.heartbeat.cycleProgressAgeMs, 605000);
});

test('buildStatusContract heartbeat is null with no run, no file, or explicit null', async (t) => {
  const dir = await makeTmpRunDir(t);

  const noRun = buildStatusContract({ activeContext: null, now: new Date() });
  assert.equal(noRun.lastHeartbeat, null);
  assert.equal(noRun.heartbeat, null);

  const noFile = buildStatusContract({
    activeContext: { runName: 'r', runPath: dir },
    now: new Date(),
  });
  assert.equal(noFile.lastHeartbeat, null);
  assert.equal(noFile.heartbeat, null);

  const injectedNull = buildStatusContract({
    activeContext: { runName: 'r', runPath: dir },
    heartbeat: null,
    now: new Date(),
  });
  assert.equal(injectedNull.heartbeat, null);
});

test('Orchestrator.prototype.stop clears the heartbeat interval and stamps a final phase', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { intervalMs: 20 });
  t.after(() => writer.stop());
  writer.start({ cycle: 5, phase: 'cycle_start' });
  assert.ok(writer.timer, 'precondition: interval running');

  // Minimal fake covering everything stop() touches (verified against the
  // real prototype: no shutdownHandler -> falls through to saveState()).
  const fake = {
    logger: quietLogger,
    running: true,
    stopImmediateActionPoller() {},
    stopGuardianControlPoller() {},
    // H4 (Fix 2.3): stop() now stops the backpressure interval too
    resourceMonitor: { stopBackpressureMonitor() {} },
    clusterOrchestrator: null,
    clusterStateStore: null,
    feeder: null,
    shutdownHandler: null,
    async saveState() { return { saved: true }; },
    heartbeatWriter: writer,
  };

  await Orchestrator.prototype.stop.call(fake);

  assert.equal(writer.timer, null, 'stop() must clear the unref\'d interval');
  assert.equal(readHeartbeat(dir).phase, 'stopped');
});

test('orchestrator cycle loop is wired to the heartbeat at start, cycle start/end, and stop', () => {
  // Source pins for wiring points that cannot be exercised without a full
  // subsystem stack (start() enters the while-loop; executeCycle needs
  // dozens of subsystems). These pin the exact proposed call sites.
  assert.ok(
    ORCHESTRATOR_SOURCE.includes("const { HeartbeatWriter } = require('./heartbeat');"),
    'orchestrator requires the heartbeat module'
  );
  assert.ok(
    ORCHESTRATOR_SOURCE.includes('this.heartbeatWriter = new HeartbeatWriter(this.logsDir'),
    'constructor builds the writer on logsDir'
  );
  assert.ok(
    ORCHESTRATOR_SOURCE.includes("this.heartbeatWriter?.start({ cycle: this.cycleCount, phase: 'loop_start' });"),
    'start() stamps and starts the unref\'d interval'
  );
  assert.ok(
    ORCHESTRATOR_SOURCE.includes('lastCycleStartTs: cycleStart.toISOString(),'),
    'executeCycle stamps cycle start'
  );

  const endStamp = "this.heartbeatWriter?.stamp({ lastCycleEndTs: new Date().toISOString(), phase: 'cycle_end' });";
  assert.equal(
    countOccurrences(ORCHESTRATOR_SOURCE, endStamp),
    2,
    'cycle end stamped exactly twice: consolidation-mode return + main finally'
  );

  // The finally-block stamp must sit with cancelCycleTimer so every exit
  // from the cycle body (success, early return, handled error) stamps.
  const finallyIdx = ORCHESTRATOR_SOURCE.indexOf('this.timeoutManager.cancelCycleTimer();');
  assert.ok(finallyIdx > -1, 'cycle finally block present');
  const window = ORCHESTRATOR_SOURCE.slice(finallyIdx, finallyIdx + 500);
  assert.ok(window.includes(endStamp), 'finally block stamps lastCycleEndTs');

  assert.ok(
    ORCHESTRATOR_SOURCE.includes("this.heartbeatWriter?.stop('stopped');"),
    'stop() clears the interval and stamps a final phase'
  );
});
