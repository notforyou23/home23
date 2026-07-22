'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { GracefulShutdownHandler } = require('../../cosmo23/engine/src/core/graceful-shutdown-handler');
const { Orchestrator, shutdownBudgetMs } = require('../../cosmo23/engine/src/core/orchestrator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function stubProcessExit(t) {
  const original = process.exit;
  const codes = [];
  process.exit = (code) => { codes.push(code ?? 0); };
  t.after(() => { process.exit = original; });
  return codes;
}

function makeFakeOrchestrator(saveResult) {
  const calls = { saveState: 0, markCleanShutdown: 0, stop: 0 };
  return {
    calls,
    async stop() { calls.stop += 1; },
    async saveState() {
      calls.saveState += 1;
      return saveResult;
    },
    crashRecovery: {
      async markCleanShutdown() { calls.markCleanShutdown += 1; },
    },
  };
}

test('shutdown does NOT mark clean when saveState reports saved:false', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({
    saved: false,
    reason: 'catastrophic_node_drop',
    currentNodes: 0,
    existingNodes: 65000,
  });
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 1);
  assert.equal(orchestrator.calls.markCleanShutdown, 0, 'refused save must leave shutdown dirty');
  assert.deepEqual(exitCodes, [0]);
  assert.equal(handler.shutdownComplete, true);
});

test('shutdown DOES mark clean when saveState reports saved:true', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({
    saved: true,
    reason: null,
    currentNodes: 65000,
    existingNodes: null,
  });
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 1);
  assert.equal(orchestrator.calls.markCleanShutdown, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown does not save again or mark clean when stop() already handled a refused save', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.stop = async function stop() {
    orchestrator.calls.stop += 1;
    orchestrator.shutdownStateHandled = true;
    orchestrator.shutdownStateResult = { saved: false, reason: 'shutdown_save_timeout_no_state' };
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.stop, 1);
  assert.equal(orchestrator.calls.saveState, 0, 'handler must not save a second time after stop() handled state');
  assert.equal(orchestrator.calls.markCleanShutdown, 0);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown does not re-mark clean when stop() already marked it', async (t) => {
  stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.stop = async function stop() {
    orchestrator.calls.stop += 1;
    orchestrator.calls.markCleanShutdown += 1; // stop() wrote the marker itself
    orchestrator.shutdownStateHandled = true;
    orchestrator.shutdownStateResult = { saved: true, reason: null };
    orchestrator.shutdownCleanMarked = true;
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 0);
  assert.equal(orchestrator.calls.markCleanShutdown, 1, 'clean marker written exactly once');
});

test('concurrent saveState calls coalesce into one underlying save', async () => {
  let underlyingSaves = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = {
    logger: quietLogger,
    _saveStatePromise: null,
    async _saveStateUnlocked() {
      underlyingSaves += 1;
      await gate;
      return { saved: true, reason: null, currentNodes: 42, existingNodes: null };
    },
  };

  const first = Orchestrator.prototype.saveState.call(fake);
  const second = Orchestrator.prototype.saveState.call(fake);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(underlyingSaves, 1, 'two concurrent saveState calls must produce one underlying save');
  assert.equal(a, b, 'joined save returns the same result object');
  assert.equal(a.saved, true);

  const third = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(underlyingSaves, 2, 'lock releases after the save completes');
  assert.equal(third.saved, true);
});

test('saveStateForShutdown bounds a hung in-progress save and never fakes saved:true', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-shutdown-save-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'state.json.gz'), 'durable');

  const fake = {
    logger: quietLogger,
    logsDir: dir,
    config: { shutdownSaveTimeoutMs: 60000, shutdownInProgressSaveTimeoutMs: 40 },
    _saveStatePromise: new Promise(() => {}),
    saveState: () => new Promise(() => {}),
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, 'existing');
  assert.equal(result.reason, 'shutdown_save_timeout_existing_state');
  assert.notEqual(result.saved, true, 'timeout with durable state must not report a confirmed save');
});

test('saveStateForShutdown timeout with no durable artifact reports shutdown_save_timeout_no_state', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-shutdown-nostate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Deliberately NO state.json / state.json.gz in dir.

  const fake = {
    logger: quietLogger,
    logsDir: dir,
    config: { shutdownSaveTimeoutMs: 40 },
    _saveStatePromise: null,
    saveState: () => new Promise(() => {}), // hangs past the timeout
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, false,
    'timeout with no durable artifact must not claim any form of saved state');
  assert.equal(result.reason, 'shutdown_save_timeout_no_state');
});

test('saveStateForShutdown surfaces save errors as saved:false', async () => {
  const fake = {
    logger: quietLogger,
    logsDir: path.join(os.tmpdir(), 'cosmo23-shutdown-missing-' + process.pid),
    config: {},
    _saveStatePromise: null,
    saveState: async () => { throw new Error('disk full'); },
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, false);
  assert.equal(result.reason, 'shutdown_save_failed');
});

// --- Phase-1 polish (a): shutdown budget arithmetic ------------------------
// The per-step defaults (150s agent wait + 60s save + 5s telemetry + 10s
// backup) sum past the 180s hard-kill. The handler stamps a single deadline
// on the orchestrator; every bounded step caps its timeout at the remaining
// budget, with the configured default as the ceiling.

test('shutdownBudgetMs keeps defaults as ceilings and floors the remaining budget at 1s', () => {
  assert.equal(shutdownBudgetMs(undefined, 60000), 60000, 'no deadline: default applies unchanged');
  assert.equal(shutdownBudgetMs(NaN, 5000), 5000, 'non-finite deadline: default applies unchanged');
  assert.equal(shutdownBudgetMs(Date.now() + 3600000, 10000), 10000, 'far deadline: default stays the ceiling');
  const capped = shutdownBudgetMs(Date.now() + 30000, 60000);
  assert.ok(capped > 28000 && capped <= 30000, `near deadline caps the bound (got ${capped})`);
  assert.equal(shutdownBudgetMs(Date.now() - 5000, 60000), 1000, 'expired deadline floors at 1s');
  assert.equal(shutdownBudgetMs(Date.now() - 5000, 500), 500, 'default stays the ceiling even under the floor');
});

test('shutdown stamps a hard-kill-derived deadline on the orchestrator before any waiting', async (t) => {
  stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  // Clamp-neutral values: margin 6000 is above the 5s floor and below
  // timeout/2, so deadline = start + shutdownTimeoutMs - margin exactly.
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, {
    shutdownTimeoutMs: 60000,
    shutdownDeadlineMarginMs: 6000,
  });

  const before = Date.now();
  await handler.shutdown('test');
  const after = Date.now();

  assert.ok(Number.isFinite(orchestrator.shutdownDeadline),
    'handler must pass the deadline via orchestrator.shutdownDeadline');
  assert.ok(orchestrator.shutdownDeadline >= before + 54000 - 50,
    'deadline = start + shutdownTimeoutMs - margin');
  assert.ok(orchestrator.shutdownDeadline <= after + 54000);
});

test('shutdownDeadlineMarginMs is clamped to [5s, timeout/2]', async (t) => {
  stubProcessExit(t);

  // Negative margin would push the deadline BEYOND the hard-kill instant —
  // the pre-fix 225s overrun arithmetic returns. Clamp floors it at 5s.
  const negOrch = makeFakeOrchestrator({ saved: true, reason: null });
  const negHandler = new GracefulShutdownHandler(negOrch, quietLogger, {
    shutdownTimeoutMs: 60000,
    shutdownDeadlineMarginMs: -600000,
  });
  const negBefore = Date.now();
  await negHandler.shutdown('test');
  const negAfter = Date.now();
  assert.ok(negOrch.shutdownDeadline <= negAfter + 55000,
    'negative margin must clamp to the 5s floor, never extend the deadline past the hard-kill');
  assert.ok(negOrch.shutdownDeadline >= negBefore + 55000 - 50);

  // Margin at/above the whole timeout would leave every bounded step at its
  // 1s floor forever — save-less shutdowns. Clamp caps it at timeout/2.
  const bigOrch = makeFakeOrchestrator({ saved: true, reason: null });
  const bigHandler = new GracefulShutdownHandler(bigOrch, quietLogger, {
    shutdownTimeoutMs: 60000,
    shutdownDeadlineMarginMs: 59000,
  });
  const bigBefore = Date.now();
  await bigHandler.shutdown('test');
  const bigAfter = Date.now();
  assert.ok(bigOrch.shutdownDeadline >= bigBefore + 30000 - 50,
    'margin must cap at timeout/2 so bounded steps keep a real budget');
  assert.ok(bigOrch.shutdownDeadline <= bigAfter + 30000);
});

test('agent wait is capped by the remaining shutdown budget, save still gets its slice', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.agentExecutor = {
    registry: {
      getActiveCount: () => 1, // never drains — worst case
      getActiveAgents: () => [],
    },
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, {
    shutdownTimeoutMs: 4000,
    shutdownDeadlineMarginMs: 2000, // clamped to timeout/2 = 2000 → deadline at +2s
    agentWaitTimeoutMs: 7000,       // configured wait would blow past the deadline
  });

  const started = Date.now();
  await handler.shutdown('test');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 6000,
    `agent wait must break at the deadline, not run its configured 7s (took ${elapsed}ms)`);
  assert.equal(orchestrator.calls.saveState, 1, 'final save still runs after the capped wait');
  assert.deepEqual(exitCodes, [0]);
});

// O3 (Fix 2.2 review obligation): the constructor sanitizes shutdownTimeout —
// a non-finite or <= 0 configured value would arm the hard-kill setTimeout
// with NaN/0 and force-exit ~immediately, killing the final save mid-write.
test('constructor sanitizes a garbage shutdownTimeoutMs to the 180s default', () => {
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  for (const garbage of ['3m', NaN, 0, -5000, Infinity, 'soon']) {
    const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: garbage });
    assert.equal(handler.shutdownTimeout, 180000,
      `garbage shutdownTimeoutMs (${String(garbage)}) must fall back to 180000`);
  }
  const valid = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });
  assert.equal(valid.shutdownTimeout, 5000, 'a finite positive value passes through unchanged');
  const absent = new GracefulShutdownHandler(orchestrator, quietLogger, {});
  assert.equal(absent.shutdownTimeout, 180000, 'absent config uses the default');
});

test('a garbage shutdown timeout cannot NaN-poison the agent-wait cap and starve the save', async (t) => {
  // Since O3 the constructor sanitizes '3m' → 180000, so the deadline is
  // finite and the budget cap applies; the non-finite-deadline fallback
  // below it stays as defense in depth. Either way the assertions hold:
  // the wait breaks at the configured cap and the save still runs.
  stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  const drainAt = Date.now() + 5000; // agents drain on their own only after 5s
  orchestrator.agentExecutor = {
    registry: {
      getActiveCount: () => (Date.now() < drainAt ? 1 : 0),
      getActiveAgents: () => [],
    },
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, {
    shutdownTimeoutMs: '3m',   // garbage config → NaN shutdownDeadline
    agentWaitTimeoutMs: 1200,  // the pre-fix fallback cap — must still apply
  });

  const started = Date.now();
  await handler.shutdown('test');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3500,
    `non-finite deadline must fall back to the configured agent wait, not a never-true NaN cap (took ${elapsed}ms)`);
  assert.equal(orchestrator.calls.saveState, 1,
    'the final save must still be attempted after the capped wait');
});

test('saveStateForShutdown caps its bound at the remaining shutdown budget', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-shutdown-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Deliberately NO durable artifact — timeout resolves fast either way.

  const fake = {
    logger: quietLogger,
    logsDir: dir,
    config: { shutdownSaveTimeoutMs: 8000 },
    shutdownDeadline: Date.now() + 1200, // ~1.2s of budget left
    _saveStatePromise: null,
    saveState: () => new Promise(() => {}), // hangs
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const started = Date.now();
  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);
  const elapsed = Date.now() - started;

  assert.equal(result.saved, false);
  assert.equal(result.reason, 'shutdown_save_timeout_no_state');
  assert.ok(elapsed < 5000,
    `budget-capped bound must fire near the deadline, not the 8s default (took ${elapsed}ms)`);
});

test('cleanupTelemetryForShutdown caps its bound at the remaining shutdown budget', async () => {
  // Pin (mirrors the backup-budget test): with a handler-stamped deadline
  // nearly exhausted, a hung telemetry cleanup shrinks to the 1s floor
  // instead of its 4s config — the step sum stays inside the hard-kill.
  const hung = {
    logger: quietLogger,
    config: { shutdownTelemetryTimeoutMs: 4000 },
    shutdownDeadline: Date.now() + 50, // almost no budget left → 1s floor
    telemetry: { cleanup: () => new Promise(() => {}) },
  };

  const started = Date.now();
  await Orchestrator.prototype.cleanupTelemetryForShutdown.call(hung);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2500,
    `deadline-capped telemetry cleanup must fire near the 1s floor, not the 4s config (took ${elapsed}ms)`);
});

// --- Phase-1 polish (b): saveStateForShutdown TOCTOU -----------------------

test('saveStateForShutdown races the CAPTURED in-flight save, never a fresh save under the grace', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-shutdown-toctou-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'state.json.gz'), 'durable');

  // The in-flight save has ALREADY settled by the time the race is set up —
  // exactly the TOCTOU window: the lock slot would be null on a re-read, and
  // the old code started a FRESH full save truncated to the 15s grace.
  const inflightResult = { saved: true, reason: null, currentNodes: 500, existingNodes: 400 };
  let freshSaves = 0;
  const fake = {
    logger: quietLogger,
    logsDir: dir,
    config: { shutdownSaveTimeoutMs: 60000, shutdownInProgressSaveTimeoutMs: 60 },
    _saveStatePromise: Promise.resolve(inflightResult),
    saveState() {
      freshSaves += 1;
      return new Promise(() => {}); // a fresh save here would hang out the grace
    },
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(freshSaves, 0,
    'joined path must race the captured in-flight reference, never start a fresh save');
  assert.deepEqual(result, inflightResult,
    'the in-flight save result is the shutdown save result');
});

test('saveStateForShutdown without an in-flight save runs a fresh save under the full budget', async () => {
  let freshSaves = 0;
  const fake = {
    logger: quietLogger,
    logsDir: path.join(os.tmpdir(), 'cosmo23-shutdown-fresh-' + process.pid),
    config: { shutdownSaveTimeoutMs: 60000 },
    _saveStatePromise: null,
    saveState: async () => {
      freshSaves += 1;
      return { saved: true, reason: null, currentNodes: 7, existingNodes: 7 };
    },
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(freshSaves, 1);
  assert.equal(result.saved, true);
});
