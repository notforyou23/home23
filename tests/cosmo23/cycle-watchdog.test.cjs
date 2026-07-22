'use strict';

// Fix 2.2 (contract H3) — cycle watchdog that ACTS + circuit breaker.
//
// Breaker: consecutive cycle failures >= watchdog.tripThreshold open the
// breaker for watchdog.cooloffMs, then exactly one revive probe cycle runs;
// success closes, failure re-trips. Hard timeouts (cycle abandoned at the
// boundary) and sustained-critical stalls (O2) trip IMMEDIATELY. Breaker
// state persists in <logsDir>/.watchdog.json (tmp+rename) so restarts don't
// amnesia an open breaker.
//
// Containment invariant: executeCycle is NEVER invoked while a previous
// invocation is pending — an abandoned cycle's orphan promise blocks new
// cycles; if it is still pending when cooloff expires, the process is wedged
// on an un-abortable await and the orchestrator escalates to a supervisor
// restart (exit code 86, restartRequested persisted first).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CycleWatchdog, WATCHDOG_DEFAULTS } = require('../../cosmo23/engine/src/core/cycle-watchdog');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-watchdog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) { nowMs += ms; }
  };
}

function makeFakeOrchestrator(t, { watchdogConfig = {}, cycleTimeoutMs = 40, logsDir, clock } = {}) {
  const dir = logsDir || makeTmpDir(t);
  const clk = clock || makeClock();
  const wd = new CycleWatchdog({
    logsDir: dir,
    config: { watchdog: watchdogConfig },
    logger: quietLogger,
    now: clk.now
  });
  const fake = {
    config: { timeouts: { cycleTimeoutMs } },
    logger: quietLogger,
    cycleWatchdog: wd,
    cycleCount: 0,
    running: true,
    activeAgents: 0,
    backpressure: { level: 'none', reasons: [] },
    eventLedger: {
      entries: [],
      log(type, data = {}) { this.entries.push({ type, data }); return Promise.resolve(null); }
    },
    heartbeatWriter: {
      stamps: [],
      stamp(patch = {}) { this.stamps.push(patch); return patch; }
    },
    calls: { executeCycle: 0, sleep: 0, escalate: 0, stop: 0 },
    _abandonedCyclePromise: null,
    _lastCycleError: null,
    _watchdogPauseAnnounced: false,
    _criticalStallSince: null,
    async sleep() { this.calls.sleep += 1; },
    async executeCycle() { this.calls.executeCycle += 1; this.cycleCount += 1; },
    async stop() { this.calls.stop += 1; },
    async escalateWatchdogRestart(reason) { this.calls.escalate += 1; this.escalateReason = reason; },
    _getEvents() { return { emitRunStatus() {} }; },
    _emitWatchdogStatus: Orchestrator.prototype._emitWatchdogStatus,
    _announceWatchdogPause: Orchestrator.prototype._announceWatchdogPause,
    _checkCriticalStall: Orchestrator.prototype._checkCriticalStall,
    _recordWatchdogFailure: Orchestrator.prototype._recordWatchdogFailure
  };
  fake.agentExecutor = { registry: { getActiveCount: () => fake.activeAgents } };
  return { fake, wd, clock: clk, logsDir: dir };
}

const runCycle = (fake) => Orchestrator.prototype.runCycleWithWatchdog.call(fake);

const ledgerTypes = (fake) => fake.eventLedger.entries.map((e) => e.type);

// ─── breaker unit tests (fake clock injection, no real waiting) ───

test('breaker trips after tripThreshold consecutive errors and success resets it', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger, now: clock.now });

  wd.recordFailure({ type: 'error', message: 'boom 1', cycle: 1 });
  wd.recordFailure({ type: 'error', message: 'boom 2', cycle: 2 });
  assert.equal(wd.state, 'closed');
  assert.equal(wd.consecutiveFailures, 2);

  wd.recordFailure({ type: 'error', message: 'boom 3', cycle: 3 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.tripCount, 1);
  assert.equal(wd.shouldPause(), true);
  assert.equal(wd.cooloffRemainingMs(), WATCHDOG_DEFAULTS.cooloffMs);
});

test('cooloff → revive probe → success closes; probe failure re-trips', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({
    logsDir: dir,
    config: { watchdog: { tripThreshold: 2, cooloffMs: 10_000 } },
    logger: quietLogger,
    now: clock.now
  });

  wd.recordFailure({ type: 'error', cycle: 1 });
  wd.recordFailure({ type: 'error', cycle: 2 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.canProbe(), false);

  clock.advance(9_999);
  assert.equal(wd.shouldPause(), true);
  clock.advance(1);
  assert.equal(wd.shouldPause(), false);
  assert.equal(wd.canProbe(), true);

  assert.equal(wd.beginProbe(), true);
  assert.equal(wd.state, 'half-open');

  // Probe failure re-trips immediately with a fresh cooloff.
  wd.recordFailure({ type: 'error', cycle: 3 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.tripCount, 2);
  assert.equal(wd.cooloffRemainingMs(), 10_000);

  // Second probe succeeds → closed, streak reset.
  clock.advance(10_000);
  assert.equal(wd.beginProbe(), true);
  wd.recordSuccess();
  assert.equal(wd.state, 'closed');
  assert.equal(wd.consecutiveFailures, 0);
});

test('hard_timeout trips immediately from closed', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger, now: clock.now });
  wd.recordFailure({ type: 'hard_timeout', message: 'abandoned', cycle: 7 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.consecutiveFailures >= wd.tripThreshold, true);
  assert.equal(wd.lastFailure.type, 'hard_timeout');
});

test('critical_stall counts as a hard failure — trips immediately (O2)', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger, now: clock.now });
  wd.recordFailure({ type: 'critical_stall', message: 'critical 10min, zero agents', cycle: 12 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.lastFailure.type, 'critical_stall');
  assert.equal(wd.criticalStallMs, WATCHDOG_DEFAULTS.criticalStallMs, 'criticalStallMs default exposed');
});

test('breaker state persists across restart (no amnesia); mid-probe crash restores as open', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const cfg = { watchdog: { tripThreshold: 1, cooloffMs: 60_000 } };
  const wd = new CycleWatchdog({ logsDir: dir, config: cfg, logger: quietLogger, now: clock.now });
  wd.recordFailure({ type: 'error', cycle: 4 });
  assert.equal(wd.state, 'open');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.watchdog.json'), 'utf8'));
  assert.equal(onDisk.state, 'open');
  assert.equal(onDisk.version, 1);

  // "Restart": a fresh instance on the same dir restores the open breaker.
  const wd2 = new CycleWatchdog({ logsDir: dir, config: cfg, logger: quietLogger, now: clock.now });
  assert.equal(wd2.state, 'open');
  assert.equal(wd2.shouldPause(), true);
  assert.equal(wd2.tripCount, 1);

  // Crash mid-probe: persisted half-open must restore as open (re-probe).
  clock.advance(60_000);
  assert.equal(wd2.beginProbe(), true);
  const wd3 = new CycleWatchdog({ logsDir: dir, config: cfg, logger: quietLogger, now: clock.now });
  assert.equal(wd3.state, 'open');
  assert.equal(wd3.canProbe(), true, 'cooloff already elapsed — restart should re-probe');
});

test('corrupt state file starts closed without throwing', (t) => {
  const dir = makeTmpDir(t);
  fs.writeFileSync(path.join(dir, '.watchdog.json'), '{ not json');
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger });
  assert.equal(wd.state, 'closed');
});

test('hardDeadlineMs = max(multiplier * cycleTimeout, floor)', (t) => {
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger });
  assert.equal(wd.hardDeadlineMs(60_000), WATCHDOG_DEFAULTS.minHardTimeoutMs);
  assert.equal(wd.hardDeadlineMs(600_000), 1_800_000);

  const pure = new CycleWatchdog({
    logsDir: dir,
    config: { watchdog: { minHardTimeoutMs: 0 } },
    logger: quietLogger
  });
  assert.equal(pure.hardDeadlineMs(60_000), 180_000);
});

// Task 7 polish (b): exit codes wrap mod 256 at the OS — 300 exits as 44,
// and 256 aliases 0 (success), fooling the supervisor.
test('restartExitCode is clamped to 1..255 (exit codes wrap mod 256 at the OS)', (t) => {
  const dir = makeTmpDir(t);
  const clamped = new CycleWatchdog({
    logsDir: dir, config: { watchdog: { restartExitCode: 300 } }, logger: quietLogger
  });
  assert.equal(clamped.restartExitCode, 255);
  const zero = new CycleWatchdog({
    logsDir: dir, config: { watchdog: { restartExitCode: 0 } }, logger: quietLogger
  });
  assert.equal(zero.restartExitCode, WATCHDOG_DEFAULTS.restartExitCode); // 0 is not positive → default
  assert.equal(new CycleWatchdog({
    logsDir: dir, config: { watchdog: { restartExitCode: 86 } }, logger: quietLogger
  }).restartExitCode, 86);
});

// Task 7 polish (c): freeze the constructor sanitizers — garbage watchdog.*
// values must land on the documented defaults, never NaN/negative state.
test('constructor sanitizers survive garbage watchdog.* config values', (t) => {
  const wd = new CycleWatchdog({
    logsDir: makeTmpDir(t),
    config: {
      watchdog: {
        tripThreshold: 'banana', cooloffMs: -5, hardMultiplier: null,
        minHardTimeoutMs: 'NaN', countSoftTimeouts: 'yes', criticalStallMs: {},
        pauseSleepMs: 0, restartExitCode: 'nope', restartStopTimeoutMs: -1, stateFile: 42
      }
    },
    logger: quietLogger
  });
  assert.deepEqual(
    {
      tripThreshold: wd.tripThreshold, cooloffMs: wd.cooloffMs, hardMultiplier: wd.hardMultiplier,
      minHardTimeoutMs: wd.minHardTimeoutMs, countSoftTimeouts: wd.countSoftTimeouts,
      criticalStallMs: wd.criticalStallMs, pauseSleepMs: wd.pauseSleepMs,
      restartExitCode: wd.restartExitCode, restartStopTimeoutMs: wd.restartStopTimeoutMs
    },
    {
      tripThreshold: WATCHDOG_DEFAULTS.tripThreshold, cooloffMs: WATCHDOG_DEFAULTS.cooloffMs,
      hardMultiplier: WATCHDOG_DEFAULTS.hardMultiplier, minHardTimeoutMs: WATCHDOG_DEFAULTS.minHardTimeoutMs,
      countSoftTimeouts: false, criticalStallMs: WATCHDOG_DEFAULTS.criticalStallMs,
      pauseSleepMs: WATCHDOG_DEFAULTS.pauseSleepMs, restartExitCode: WATCHDOG_DEFAULTS.restartExitCode,
      restartStopTimeoutMs: WATCHDOG_DEFAULTS.restartStopTimeoutMs
    }
  );
  assert.ok(wd.statePath.endsWith('.watchdog.json'), 'non-string stateFile falls back to the default');
});

// ─── orchestrator wiring (real behavior via Orchestrator.prototype.<method>.call(fake)) ───

test('hard-timeout path: hung executeCycle is abandoned at the boundary and trips the breaker', async (t) => {
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { hardMultiplier: 1, minHardTimeoutMs: 0, cooloffMs: 60_000 },
    cycleTimeoutMs: 40
  });
  fake.executeCycle = function hang() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
    return new Promise(() => {}); // never settles
  };

  const cycled = await runCycle(fake);

  assert.equal(cycled, false, 'abandoned iteration must report no settled cycle');
  assert.equal(fake.calls.executeCycle, 1);
  assert.notEqual(fake._abandonedCyclePromise, null, 'orphan must be contained');
  assert.equal(wd.state, 'open');
  assert.equal(wd.lastFailure.type, 'hard_timeout');

  // Durable trail: hard timeout + trip land in the event ledger.
  assert.deepEqual(
    ledgerTypes(fake).filter((type) => type.startsWith('watchdog')),
    ['watchdog_hard_timeout', 'watchdog_trip']
  );

  // While cooling off with the orphan pending: no new cycle may start.
  assert.equal(await runCycle(fake), false);
  assert.equal(fake.calls.executeCycle, 1, 'no concurrent cycle while orphan pending');
  assert.equal(fake.calls.sleep, 1);

  // H1 composition: the cooloff window is visible in the heartbeat phase.
  assert.ok(
    fake.heartbeatWriter.stamps.some((s) => s.phase === 'breaker_cooloff'),
    'pause announcement stamps phase breaker_cooloff'
  );
});

test('orphan still pending after full cooloff → restart escalation', async (t) => {
  const clock = makeClock();
  const { fake } = makeFakeOrchestrator(t, {
    watchdogConfig: { hardMultiplier: 1, minHardTimeoutMs: 0, cooloffMs: 60_000 },
    cycleTimeoutMs: 40,
    clock
  });
  fake.executeCycle = function hang() {
    this.calls.executeCycle += 1;
    return new Promise(() => {});
  };

  await runCycle(fake); // abandons + trips
  clock.advance(60_001); // cooloff expired, orphan still pending
  await runCycle(fake);

  assert.equal(fake.calls.escalate, 1);
  assert.equal(fake.escalateReason, 'abandoned_cycle_never_settled');
  assert.equal(fake.calls.executeCycle, 1, 'escalation path must not start a cycle');
});

test('orphan settles during cooloff → in-process revive probe, success closes breaker', async (t) => {
  const clock = makeClock();
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { hardMultiplier: 1, minHardTimeoutMs: 0, cooloffMs: 60_000 },
    cycleTimeoutMs: 40,
    clock
  });
  let releaseOrphan;
  fake.executeCycle = function hangOnce() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
    return new Promise((resolve) => { releaseOrphan = resolve; });
  };

  await runCycle(fake); // abandoned + tripped
  assert.notEqual(fake._abandonedCyclePromise, null);

  releaseOrphan(); // the slow LLM call finally finished
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake._abandonedCyclePromise, null, 'settled orphan must clear containment');

  clock.advance(60_001);
  fake.executeCycle = async function healthy() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
  };
  assert.equal(await runCycle(fake), true); // revive probe succeeds

  assert.equal(fake.calls.executeCycle, 2);
  assert.equal(fake.calls.escalate, 0);
  assert.equal(wd.state, 'closed', 'probe success closes the breaker');

  // Durable trail + heartbeat phase for the probe path.
  const types = ledgerTypes(fake);
  assert.ok(types.includes('watchdog_cooloff_end'), 'cooloff end logged to the ledger');
  assert.ok(types.includes('watchdog_revive_success'), 'revive success logged to the ledger');
  assert.ok(
    fake.heartbeatWriter.stamps.some((s) => s.phase === 'revive_probe'),
    'probe iteration stamps phase revive_probe'
  );
});

test('consecutive swallowed cycle errors trip breaker; pause skips cycles; probe resets', async (t) => {
  const clock = makeClock();
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { tripThreshold: 3, cooloffMs: 60_000, minHardTimeoutMs: 0, hardMultiplier: 100 },
    cycleTimeoutMs: 1_000,
    clock
  });
  // Simulate executeCycle's internal catch: swallow the error, flag it.
  fake.executeCycle = async function failing() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
    this._lastCycleError = { message: 'LLM exploded', cycle: this.cycleCount, at: Date.now() };
  };

  assert.equal(await runCycle(fake), true, 'an errored-but-settled cycle still counts as cycled');
  await runCycle(fake);
  assert.equal(wd.state, 'closed');
  await runCycle(fake);
  assert.equal(wd.state, 'open', 'third consecutive failure trips');
  assert.ok(ledgerTypes(fake).includes('watchdog_trip'), 'error-streak trip logged to the ledger');

  assert.equal(await runCycle(fake), false); // cooling off
  assert.equal(fake.calls.executeCycle, 3, 'no cycle during cooloff');

  clock.advance(60_001);
  fake.executeCycle = async function healthy() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
  };
  await runCycle(fake); // revive probe
  assert.equal(fake.calls.executeCycle, 4);
  assert.equal(wd.state, 'closed');
  assert.equal(wd.consecutiveFailures, 0);
});

// Task 7 polish (f): the soft-timeout comparison reads timeouts.cycleTimeoutMs
// raw from config. A garbage negative value made EVERY settled cycle read as
// a soft timeout (durationMs > -5), silently tripping the breaker when
// countSoftTimeouts is on. The read is now sanitized like hardDeadlineMs.
test('garbage timeouts.cycleTimeoutMs cannot arm false soft timeouts (sanitized like hardDeadlineMs)', async (t) => {
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { countSoftTimeouts: true },
    cycleTimeoutMs: -5
  });
  assert.equal(await runCycle(fake), true);
  assert.equal(wd.consecutiveFailures, 0, 'negative config must not turn every cycle into a soft timeout');
  assert.equal(wd.state, 'closed');
  assert.equal(wd.lastFailure, null);
});

test('open breaker restored from disk pauses a fresh orchestrator (restart honors cooloff)', async (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const first = makeFakeOrchestrator(t, {
    watchdogConfig: { tripThreshold: 1, cooloffMs: 60_000 },
    logsDir: dir,
    clock
  });
  first.wd.recordFailure({ type: 'error', cycle: 9 });
  assert.equal(first.wd.state, 'open');

  // "Restarted" orchestrator: new watchdog instance, same logsDir + clock.
  const second = makeFakeOrchestrator(t, {
    watchdogConfig: { tripThreshold: 1, cooloffMs: 60_000 },
    logsDir: dir,
    clock
  });
  assert.equal(await runCycle(second.fake), false);
  assert.equal(second.fake.calls.executeCycle, 0, 'restored open breaker must pause cycling');
  assert.equal(second.fake.calls.sleep, 1);
});

// ─── O2: sustained-critical wedge detection ───

test('sustained critical backpressure with zero active agents trips after criticalStallMs', async (t) => {
  const clock = makeClock();
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { criticalStallMs: 10_000, cooloffMs: 60_000, minHardTimeoutMs: 0, hardMultiplier: 100 },
    cycleTimeoutMs: 1_000,
    clock
  });
  fake.backpressure.level = 'critical';

  assert.equal(await runCycle(fake), true, 'first critical observation starts the clock, cycle still runs');
  clock.advance(10_000);
  assert.equal(await runCycle(fake), false, 'matured stall trips without running a cycle');
  assert.equal(fake.calls.executeCycle, 1);
  assert.equal(wd.state, 'open');
  assert.equal(wd.lastFailure.type, 'critical_stall');

  const types = ledgerTypes(fake);
  assert.ok(types.includes('watchdog_critical_stall'), 'distinct ledger event emitted');
  assert.ok(types.includes('watchdog_trip'), 'stall counts as a hard failure → trip logged');
});

test('critical-stall clock resets when agents are active or the level drops', async (t) => {
  const clock = makeClock();
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { criticalStallMs: 10_000, cooloffMs: 60_000, minHardTimeoutMs: 0, hardMultiplier: 100 },
    cycleTimeoutMs: 1_000,
    clock
  });

  // Critical but agents are working → not a stall, clock must not start.
  fake.backpressure.level = 'critical';
  fake.activeAgents = 2;
  await runCycle(fake);
  clock.advance(60_000);
  await runCycle(fake);
  assert.equal(wd.state, 'closed', 'critical with active agents never trips');

  // Agents drain → clock starts; level recovers before maturity → clock resets.
  fake.activeAgents = 0;
  await runCycle(fake); // clock starts
  clock.advance(9_999);
  fake.backpressure.level = 'elevated';
  await runCycle(fake); // reset
  fake.backpressure.level = 'critical';
  clock.advance(9_999);
  await runCycle(fake); // critical again → fresh clock starts on this iteration
  clock.advance(9_999);
  await runCycle(fake); // 9,999ms elapsed on the fresh clock — still under threshold
  assert.equal(wd.state, 'closed', 'reset clock must demand a fresh continuous window');

  clock.advance(1);
  assert.equal(await runCycle(fake), false, 'continuous window matured → trip');
  assert.equal(wd.state, 'open');
});

// ─── restart escalation (real method, stubbed process.exit) ───

test('escalateWatchdogRestart persists restartRequested, does bounded stop, exits 86', async (t) => {
  const dir = makeTmpDir(t);
  const { fake } = makeFakeOrchestrator(t, {
    // Huge stop budget: the unref'd backstop timer must never fire inside
    // the test process (the stubbed exit is restored after this test).
    watchdogConfig: { restartStopTimeoutMs: 3_600_000 },
    logsDir: dir
  });

  const exits = [];
  const originalExit = process.exit;
  process.exit = (code) => { exits.push(code ?? 0); };
  t.after(() => { process.exit = originalExit; });

  await Orchestrator.prototype.escalateWatchdogRestart.call(fake, 'abandoned_cycle_never_settled');

  assert.deepEqual(exits, [86], 'exits with the supervisor-restart code');
  assert.equal(fake.calls.stop, 1, 'bounded stop() ran (guarded shutdown save path)');
  assert.equal(fake.running, false);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.watchdog.json'), 'utf8'));
  assert.equal(onDisk.restartRequested, true, 'restartRequested persisted BEFORE exiting');
  assert.equal(onDisk.restartReason, 'abandoned_cycle_never_settled');

  assert.ok(ledgerTypes(fake).includes('watchdog_restart_escalation'), 'escalation logged to the ledger');
});

test('escalation source wires an unref\'d exit backstop around stop()', () => {
  const escalateSrc = String(Orchestrator.prototype.escalateWatchdogRestart);
  assert.ok(escalateSrc.includes("setTimeout(() => process.exit(exitCode), stopBudgetMs)"),
    'backstop timer exits with the escalation code if stop() wedges');
  assert.ok(escalateSrc.includes('backstop.unref'),
    'backstop must be unref\'d so it cannot hold a healthy process open');
});

// ─── wiring pins ───

test('orchestrator wiring: start() routes through the watchdog and executeCycle flags failures', () => {
  assert.equal(typeof Orchestrator.prototype.runCycleWithWatchdog, 'function');
  assert.equal(typeof Orchestrator.prototype.escalateWatchdogRestart, 'function');
  const startSrc = String(Orchestrator.prototype.start);
  assert.equal(startSrc.includes('this.runCycleWithWatchdog()'), true, 'start() loop must call runCycleWithWatchdog');
  assert.equal(startSrc.includes('await this.executeCycle()'), false, 'start() must not call executeCycle directly anymore');
  const cycleSrc = String(Orchestrator.prototype.executeCycle);
  assert.equal(cycleSrc.includes('_lastCycleError'), true, 'executeCycle catch must flag failures for the watchdog');
  assert.equal(
    cycleSrc.split('this._lastCycleError = {').length - 1,
    2,
    'both the main catch AND the consolidation catch flag failures'
  );
});
