# Phase-1 polish pack: (a) shutdown budget arithmetic, (b) saveStateForShutdown TOCTOU, (c) save-guard cold-path memoization, (d) journal-overlay atomicity — all cosmo23-native

## Target current state

All four gaps verified in the CURRENT tree (drift from the task brief noted where found):

(a) Budget overrun — cosmo23/engine/src/core/graceful-shutdown-handler.js:20 `this.shutdownTimeout = config.shutdownTimeoutMs || 180000;` (hard-kill timer armed at :135-142) and :155 `const maxAgentWait = this.config.agentWaitTimeoutMs || 150000; // 2.5 minutes (allows for container downloads)`. Orchestrator step bounds: cosmo23/engine/src/core/orchestrator.js:9249 `const defaultTimeoutMs = this.config.shutdownSaveTimeoutMs || 60000;`, :9208 `const timeoutMs = this.config.shutdownTelemetryTimeoutMs || 5000;`, :9312 `const timeoutMs = this.config.shutdownBackupTimeoutMs || 10000;`. 150+60+5+10 = 225s > 180s hard-kill: worst case the process is killed mid-save with exit 1. No `shutdownDeadline` exists anywhere in the tree today.

(b) TOCTOU — orchestrator.js:9248-9302 (NOT ~9147 as briefed; the method moved). :9250 `const saveAlreadyInProgress = Boolean(this._saveStatePromise);` then :9268 `const savePromise = this.saveState()`. Between the boolean check (plus the intervening `await this.hasDurableStateArtifact()` at :9255) and the `saveState()` call, the in-flight save can settle and clear the lock slot (saveState() finally-clears `_saveStatePromise`, :8100), silently turning "join in-flight save under 15s grace" into "start a FRESH full save truncated to the 15s grace".

(c) No memoization — orchestrator.js:8158-8160 `let knownGood; try { knownGood = await resolveKnownGoodNodeCount(this.logsDir, statePath); }` runs the full resolution on EVERY save. brain-snapshot.js:132-137: when no snapshot and no manifest exist (legacy runs), resolution streams memory-nodes.jsonl.gz (`countSidecarNodes`) — so a refusal loop re-streams the whole node sidecar every cycle. No `_knownGoodCache` exists anywhere in the tree.

(d) Mixed-provenance journal overlay — orchestrator.js:482-485 (NOT 480-483):
```js
if (Array.isArray(recoveredState.journal) &&
    recoveredState.journal.length > (this.journal?.length || 0)) {
  this.journal = recoveredState.journal;
}
```
gates on LENGTH while cycleCount gates on `checkpointIsFresher` (:473-479). Both the state file (:8112 `journal: this.journal.slice(-100)`) and checkpoints (:526 `journal: this.journal.slice(-100)`) are 100-capped, so length is not a freshness signal: a stale checkpoint with a longer journal overlays a fresher loadState journal (cycleCount from state file + journal from an older boot), and a fresher checkpoint with a shorter 100-capped journal is wrongly ignored.

## CHANGE: cosmo23/engine/src/core/graceful-shutdown-handler.js

(a) Stamp a single shutdown deadline (hard-kill minus margin) on the handler AND the orchestrator at the top of shutdown(), before the hard-kill timer and any waiting. New config knob shutdownDeadlineMarginMs (default 5000) reserves room for marker write + cleanup tasks + exit.

### Anchor
```
    this.isShuttingDown = true;
    this.shutdownStartTime = Date.now();

    this.logger.info('[GracefulShutdown] Starting graceful shutdown', { trigger });
```

### Code
```js
    this.isShuttingDown = true;
    this.shutdownStartTime = Date.now();

    // Budget arithmetic fix: the historical per-step defaults (150s agent
    // wait + 60s save + 5s telemetry + 10s backup) sum past the 180s
    // hard-kill, so a slow shutdown was killed mid-save with exit 1. Derive
    // every bound from ONE deadline instead: each bounded step caps its
    // timeout at the remaining budget (defaults stay ceilings), so the
    // pipeline always finishes — or times out honestly — before the
    // hard-kill timer fires. The margin reserves room for the clean-shutdown
    // marker, cleanup tasks, and process exit after the bounded steps.
    const deadlineMarginMs = this.config.shutdownDeadlineMarginMs || 5000;
    this.shutdownDeadline = this.shutdownStartTime + this.shutdownTimeout - deadlineMarginMs;
    this.orchestrator.shutdownDeadline = this.shutdownDeadline;

    this.logger.info('[GracefulShutdown] Starting graceful shutdown', { trigger });
```

## CHANGE: cosmo23/engine/src/core/graceful-shutdown-handler.js

(a) Cap the agent wait at the remaining shutdown budget. WARNING: anchor on this exact single line only — the blank lines directly above and below it in the current file carry trailing spaces (8 spaces) and will not match a whitespace-trimmed anchor.

### Anchor
```
        const maxAgentWait = this.config.agentWaitTimeoutMs || 150000; // 2.5 minutes (allows for container downloads)
```

### Code
```js
        // Configured wait (default 2.5 minutes, allows for container
        // downloads) capped at the remaining shutdown budget so the wait can
        // never starve the final save of its slice before the hard kill.
        const configuredAgentWait = this.config.agentWaitTimeoutMs || 150000;
        const maxAgentWait = Math.min(configuredAgentWait, Math.max(1000, this.shutdownDeadline - Date.now()));
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a) Add a module-level shutdownBudgetMs(deadline, defaultMs) helper and export it. Module-level function (not an instance method) so every existing Orchestrator.prototype.<helper>.call(fake) test keeps working without wiring anything onto the fakes: an unset/non-finite deadline returns the default unchanged. Function declarations hoist, so class methods above can call it.

### Anchor
```
module.exports = { Orchestrator };
```

### Code
```js
/**
 * Cap a shutdown step's timeout at the remaining shutdown budget.
 *
 * The graceful-shutdown handler stamps orchestrator.shutdownDeadline
 * (hard-kill instant minus a cleanup margin) at the start of shutdown; each
 * bounded step derives its timeout as min(configured default, max(1s,
 * deadline - now)). Without this, the per-step defaults (150s agent wait +
 * 60s save + 5s telemetry + 10s backup) sum past the 180s hard-kill and a
 * slow shutdown dies mid-save with exit 1. When no deadline is set (direct
 * stop() without the handler, tests), the configured default applies
 * unchanged — defaults are ceilings, never raised.
 */
function shutdownBudgetMs(deadline, defaultMs) {
  const numericDeadline = Number(deadline);
  if (!Number.isFinite(numericDeadline)) return defaultMs;
  return Math.min(defaultMs, Math.max(1000, numericDeadline - Date.now()));
}

module.exports = { Orchestrator, shutdownBudgetMs };
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a) Telemetry cleanup bound derives from the remaining budget (inside cleanupTelemetryForShutdown, line 9208).

### Anchor
```
    const timeoutMs = this.config.shutdownTelemetryTimeoutMs || 5000;
```

### Code
```js
    const timeoutMs = shutdownBudgetMs(this.shutdownDeadline, this.config.shutdownTelemetryTimeoutMs || 5000);
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a) Pending-backup wait bound derives from the remaining budget (inside awaitPendingBackupForShutdown, line 9312).

### Anchor
```
    const timeoutMs = this.config.shutdownBackupTimeoutMs || 10000;
```

### Code
```js
    const timeoutMs = shutdownBudgetMs(this.shutdownDeadline, this.config.shutdownBackupTimeoutMs || 10000);
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a)+(b) Replace the ENTIRE saveStateForShutdown() method (current lines 9248-9302, from `async saveStateForShutdown() {` through its closing `  }` immediately before the awaitPendingBackupForShutdown doc comment). Budget-caps the save bound AND fixes the TOCTOU: the in-flight promise is captured exactly once; the joined path races THAT reference under the grace; a fresh save only runs on the non-joined path under the full remaining budget. Promise.resolve() wraps the race source because the captured promise may already be settled.

### Anchor
```
  async saveStateForShutdown() {
    const defaultTimeoutMs = this.config.shutdownSaveTimeoutMs || 60000;
    const saveAlreadyInProgress = Boolean(this._saveStatePromise);
```

### Code
```js
  async saveStateForShutdown() {
    const defaultTimeoutMs = this.config.shutdownSaveTimeoutMs || 60000;
    // Cap the bound at the remaining shutdown budget (handler-stamped
    // deadline). Default stays the ceiling; without a deadline it applies
    // unchanged.
    const budgetMs = shutdownBudgetMs(this.shutdownDeadline, defaultTimeoutMs);

    // TOCTOU guard: capture the in-flight save promise EXACTLY ONCE. The
    // lock slot (this._saveStatePromise) clears the moment the in-flight
    // save settles, so re-reading it later can silently turn "join the
    // in-flight save under the short grace" into "start a fresh full save
    // under the short grace" — a fresh save truncated to 15s. When we decide
    // to join, we race THIS captured reference; a fresh save only runs on
    // the non-joined path, under the full remaining budget.
    const inflight = this._saveStatePromise;
    let durableStateBeforeWait = false;
    let joinedInflight = false;
    let timeoutMs = budgetMs;

    if (inflight) {
      durableStateBeforeWait = await this.hasDurableStateArtifact();
      if (durableStateBeforeWait) {
        const inProgressTimeoutMs = Number(this.config.shutdownInProgressSaveTimeoutMs ?? 15000);
        timeoutMs = Math.min(budgetMs, Math.max(1, inProgressTimeoutMs));
        joinedInflight = true;
        this.logger.warn('💾 Shutdown joining in-progress state save with bounded grace', {
          timeoutMs,
          defaultTimeoutMs,
          hasDurableState: true,
        });
      }
    }

    let timeoutId = null;
    const savePromise = Promise.resolve(joinedInflight ? inflight : this.saveState())
      .then(result => ({ status: 'ok', result }))
      .catch(error => ({ status: 'error', error }));

    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });

    const outcome = await Promise.race([savePromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    if (outcome.status === 'ok') {
      return outcome.result || { saved: true, reason: null, currentNodes: null, existingNodes: null };
    }

    if (outcome.status === 'error') {
      this.logger.error('❌ Shutdown state save failed', {
        error: outcome.error?.message || String(outcome.error),
      });
      return { saved: false, reason: 'shutdown_save_failed', currentNodes: null, existingNodes: null };
    }

    const hasDurableState = durableStateBeforeWait || await this.hasDurableStateArtifact();
    this.logger.warn('⚠️ Shutdown state save timed out', {
      timeoutMs,
      hasDurableState,
      saveAlreadyInProgress: Boolean(inflight),
      joinedInflight,
    });
    savePromise.catch(() => {});

    if (hasDurableState) {
      return { saved: 'existing', reason: 'shutdown_save_timeout_existing_state', currentNodes: null, existingNodes: null };
    }
    return { saved: false, reason: 'shutdown_save_timeout_no_state', currentNodes: null, existingNodes: null };
  }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(c) Import readSnapshot + snapshotNodeCount for the fast snapshot-tier read (line 30).

### Anchor
```
const { writeSnapshot, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
```

### Code
```js
const { writeSnapshot, readSnapshot, snapshotNodeCount, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(c) Memoize the cold-path baseline in _saveStateUnlocked (lines 8158-8161). DELIBERATE deviation from a contract-literal memo: brain-snapshot.json (tier 1, tiny file) is re-read EVERY save because it is the documented operator escape hatch (editing its counts down approves a legitimate >50% prune); only the expensive tiers (manifest read / sidecar streaming / legacy inline state load) are memoized. A guard-resolution throw still fails closed and does NOT populate the cache.

### Anchor
```
    let knownGood;
    try {
      knownGood = await resolveKnownGoodNodeCount(this.logsDir, statePath);
    } catch (error) {
```

### Code
```js
    let knownGood;
    try {
      // Tier 1 (brain-snapshot.json) is a tiny always-parseable file and is
      // re-read on EVERY save: it is the documented operator escape hatch —
      // editing its counts down approves a legitimate >50% prune without a
      // process restart, so it must never be hidden behind a memo. Only the
      // expensive cold-path tiers (manifest read, streaming the node
      // sidecar, legacy inline state load) are memoized on
      // this._knownGoodCache: a legacy run with no snapshot would otherwise
      // re-stream memory-nodes.jsonl.gz on every refused save, every cycle.
      // The cache refreshes on each successful save (new truth) and is
      // reused as-is by refused saves.
      const snapshotCount = snapshotNodeCount(readSnapshot(this.logsDir));
      if (snapshotCount !== null) {
        knownGood = { count: snapshotCount, source: 'snapshot' };
        this._knownGoodCache = knownGood;
      } else if (this._knownGoodCache) {
        knownGood = this._knownGoodCache;
      } else {
        knownGood = await resolveKnownGoodNodeCount(this.logsDir, statePath);
        this._knownGoodCache = knownGood;
      }
    } catch (error) {
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(c) Successful save refreshes the memoized baseline to the just-saved counts (success path of _saveStateUnlocked, lines 8276-8282 — the ONLY multi-line `saved: true` result block; the string `saved: true,` alone appears twice in the file, so use the full block as the anchor).

### Anchor
```
      this.lastSaveResult = {
        saved: true,
        reason: null,
        currentNodes: totalNodes,
        existingNodes: knownGood.count
      };
      return this.lastSaveResult;
```

### Code
```js
      // Successful save is the ONLY event that refreshes the memoized
      // baseline: the just-saved counts are the new known-good truth
      // (mirrors the brain-snapshot.json stamp above).
      this._knownGoodCache = { count: totalNodes, source: 'snapshot' };

      this.lastSaveResult = {
        saved: true,
        reason: null,
        currentNodes: totalNodes,
        existingNodes: knownGood.count
      };
      return this.lastSaveResult;
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(d) Gate the journal overlay in restoreFromPersistence (lines 482-485) on the SAME checkpointIsFresher predicate as cycleCount. Length dropped as a signal (both sides are 100-capped); an empty checkpoint journal never clobbers the loaded one. lastSummarization (486-489) is left as-is — its monotonic numeric comparison is already a valid freshness predicate.

### Anchor
```
    if (Array.isArray(recoveredState.journal) &&
        recoveredState.journal.length > (this.journal?.length || 0)) {
      this.journal = recoveredState.journal;
    }
```

### Code
```js
    // The journal rides the SAME freshness predicate as cycleCount. Both the
    // state file and checkpoints cap the journal at the last 100 entries
    // (saveState / buildCheckpointState `.slice(-100)`), so length is NOT a
    // freshness signal: a stale checkpoint can carry a LONGER journal than a
    // fresher state file (and a fresher checkpoint a SHORTER one). Overlaying
    // by length produced a mixed-provenance head — cycleCount from the state
    // file, journal from an older boot. Empty checkpoint journals never
    // clobber a loaded journal.
    if (checkpointIsFresher &&
        Array.isArray(recoveredState.journal) &&
        recoveredState.journal.length > 0) {
      this.journal = recoveredState.journal;
    }
```

## CHANGE: tests/cosmo23/brain-snapshot-guard.test.cjs

(c) Append three tests after the last existing test (anchor is the unique tail of 'real saveState refuses with persistence_guard_failed...'). Failing-first: the memo test fails on current code (second save re-resolves a now-empty dir and passes); the refresh test fails (no _knownGoodCache exists); the escape-hatch test is a deliberate pin that also passes today and guards against a contract-literal memo regression.

### Anchor
```
  assert.equal(fs.existsSync(path.join(runDir, 'memory-manifest.json')), false,
    'refused save must not create sidecar artifacts');
  assert.equal(readSnapshot(runDir), null, 'refused save must not stamp a snapshot');
});
```

### Code
```js
  assert.equal(fs.existsSync(path.join(runDir, 'memory-manifest.json')), false,
    'refused save must not create sidecar artifacts');
  assert.equal(readSnapshot(runDir), null, 'refused save must not stamp a snapshot');
});

// --- Phase-1 polish (c): save-guard cold-path memoization -------------------
// A legacy run with no brain-snapshot.json resolves its baseline by streaming
// memory-nodes.jsonl.gz. Without the memo, EVERY refused save re-streams the
// sidecar every cycle. The memo caches the cold-path resolution on the
// orchestrator; refused saves reuse it, and only a successful save refreshes
// it. brain-snapshot.json itself stays un-memoized — it is the operator
// escape hatch and must be re-read every save.

test('refused saves reuse the memoized cold-path baseline instead of re-resolving sidecars', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-memo-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'memo-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  // Legacy shape: sidecars only — NO snapshot, NO manifest, NO state file.
  writeJsonlGz(
    path.join(runDir, 'memory-nodes.jsonl.gz'),
    Array.from({ length: 200 }, (_, i) => ({ id: `n${i + 1}`, concept: `c${i + 1}` })),
  );
  writeJsonlGz(path.join(runDir, 'memory-edges.jsonl.gz'), []);

  // ONE orchestrator instance across both saves — the memo lives on `this`.
  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('shrunk', 20), 50, logs);

  const first = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(first.saved, false);
  assert.equal(first.reason, 'catastrophic_node_drop');
  assert.equal(first.existingNodes, 200);
  assert.equal(first.safeguardSource, 'memory-sidecar', 'cold path streamed the sidecar once');
  assert.deepEqual(fake._knownGoodCache, { count: 200, source: 'memory-sidecar' },
    'cold-path resolution must be memoized on the orchestrator');

  // Remove the sidecars. If the second refused save re-resolved from disk it
  // would now see a fresh dir (count 0, guard passes) and bless the shrunken
  // overwrite — so a still-refused second save proves the memo was used.
  fs.rmSync(path.join(runDir, 'memory-nodes.jsonl.gz'));
  fs.rmSync(path.join(runDir, 'memory-edges.jsonl.gz'));

  const second = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(second.saved, false, 'refused save must reuse the memoized baseline, not re-stream');
  assert.equal(second.reason, 'catastrophic_node_drop');
  assert.equal(second.existingNodes, 200);
});

test('a successful save refreshes the memoized baseline to the just-saved counts', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-memo-refresh-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'memo-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('grow', 200), 2, logs);
  const result = await Orchestrator.prototype.saveState.call(fake);

  assert.equal(result.saved, true);
  assert.deepEqual(fake._knownGoodCache, { count: 200, source: 'snapshot' },
    'successful save must set the cache to the new truth (mirrors the snapshot stamp)');
});

test('operator escape hatch survives memoization: editing brain-snapshot.json down is honored without a restart', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-hatch-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'hatch-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  // ONE long-lived orchestrator instance: warm cache, then a legitimate prune.
  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('big', 200), 2, logs);
  const grow = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(grow.saved, true);

  // Legitimate prune to 60 nodes: refused every cycle (60 < 50% of 200).
  fake.cycleCount = 50;
  fake.memory = { exportGraph: () => memoryGraph('pruned', 60) };
  const refused = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(refused.saved, false);
  assert.equal(refused.reason, 'catastrophic_node_drop');
  assert.equal(refused.existingNodes, 200);

  // Documented intervention: the operator edits the snapshot counts down.
  // The snapshot tier must be re-read every save — a memo that hides it
  // would dead-end the escape hatch until a process restart.
  writeSnapshot(runDir, {
    nodes: 60, edges: 59, savedAt: new Date().toISOString(), generation: null,
    nodeCount: 60, edgeCount: 59,
  });

  fake.cycleCount = 51;
  const approved = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(approved.saved, true,
    'edited snapshot must take effect on the very next save, no restart');
  assert.equal(approved.existingNodes, 60, 'baseline comes from the operator-edited snapshot');
});
```

## CHANGE: tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs

(d) Insert two helpers + three tests immediately BEFORE the final wiring test (anchor line is unique). Failing-first: the stale-longer-journal and fresher-shorter-journal tests both fail on current code; the empty-journal test is a pin. The two pre-existing journal assertions (3>1 overlay, 3>4 no-overlay) keep passing under the new predicate — verified.

### Anchor
```
test('orchestrator wiring uses restoreFromPersistence and buildCheckpointState', () => {
```

### Code
```js
// --- Phase-1 polish (d): journal overlay rides the checkpoint freshness
// predicate. Both the state file and checkpoints cap the journal at
// slice(-100), so LENGTH is not a freshness signal — the overlay must gate on
// the same cycleCount comparison as the other scalars, or recovery builds a
// mixed-provenance head (cycleCount from the state file, journal from an
// older boot).

async function writeScalarCheckpoint(dir, cycle, state) {
  const checkpointsDir = path.join(dir, 'checkpoints');
  await fsp.mkdir(checkpointsDir, { recursive: true });
  await fsp.writeFile(
    path.join(checkpointsDir, `checkpoint-${cycle}.json`),
    JSON.stringify({ cycle, timestamp: new Date().toISOString(), state }),
  );
}

function makeOverlayStub(manager, loaded) {
  return {
    crashRecovery: manager,
    logger: silentLogger,
    cycleCount: 0,
    journal: [],
    lastSummarization: 0,
    guidedMissionPlan: null,
    completionTracker: null,
    memory: { nodes: new Map(), edges: new Map(), clusters: new Map() },
    loadStateCalls: 0,
    async loadState() {
      this.loadStateCalls += 1;
      this.cycleCount = loaded.cycleCount;
      this.journal = loaded.journal.slice();
      this.lastSummarization = loaded.lastSummarization;
    },
  };
}

test('a stale checkpoint with a LONGER journal must not overlay the fresher loadState journal', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 40 });
  // Stale checkpoint (cycle 15) carrying MORE journal entries than the state
  // file restored — e.g. the state file's journal was recently summarized and
  // trimmed. Length says overlay; provenance says never.
  await writeScalarCheckpoint(dir, 15, {
    cycleCount: 15,
    journal: Array.from({ length: 10 }, (_, i) => ({ cycle: 6 + i, thought: `stale ${i}` })),
    lastSummarization: 5,
  });

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();
  assert.equal(manager.crashDetected, true);

  const freshJournal = [
    { cycle: 38, thought: 'fresh a' },
    { cycle: 39, thought: 'fresh b' },
    { cycle: 40, thought: 'fresh c' },
  ];
  const stub = makeOverlayStub(manager, { cycleCount: 40, journal: freshJournal, lastSummarization: 35 });

  await Orchestrator.prototype.restoreFromPersistence.call(stub);

  assert.equal(stub.loadStateCalls, 1);
  assert.equal(stub.cycleCount, 40, 'stale checkpoint must not roll the cycle counter back');
  assert.deepEqual(stub.journal, freshJournal,
    'stale checkpoint journal must not produce a mixed-provenance head');
});

test('a fresher checkpoint journal overlays even when 100-capped SHORTER than the loaded journal', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 10 });
  // Fresher checkpoint (cycle 50) whose slice(-100) journal happens to be
  // SHORTER than what loadState restored. It is the later slice — it wins.
  const checkpointJournal = [
    { cycle: 49, thought: 'later x' },
    { cycle: 50, thought: 'later y' },
  ];
  await writeScalarCheckpoint(dir, 50, {
    cycleCount: 50,
    journal: checkpointJournal,
    lastSummarization: 45,
  });

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();
  assert.equal(manager.crashDetected, true);

  const stub = makeOverlayStub(manager, {
    cycleCount: 10,
    journal: [
      { cycle: 7, thought: 'old a' },
      { cycle: 8, thought: 'old b' },
      { cycle: 9, thought: 'old c' },
      { cycle: 10, thought: 'old d' },
    ],
    lastSummarization: 8,
  });

  await Orchestrator.prototype.restoreFromPersistence.call(stub);

  assert.equal(stub.cycleCount, 50);
  assert.deepEqual(stub.journal, checkpointJournal,
    'fresher checkpoint journal must overlay regardless of length (both sides are 100-capped)');
});

test('a fresher checkpoint with an EMPTY journal never clobbers the loaded journal', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 10 });
  await writeScalarCheckpoint(dir, 50, {
    cycleCount: 50,
    journal: [],
    lastSummarization: 45,
  });

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();
  assert.equal(manager.crashDetected, true);

  const loadedJournal = [{ cycle: 10, thought: 'keep me' }];
  const stub = makeOverlayStub(manager, { cycleCount: 10, journal: loadedJournal, lastSummarization: 8 });

  await Orchestrator.prototype.restoreFromPersistence.call(stub);

  assert.equal(stub.cycleCount, 50, 'fresher scalars still overlay');
  assert.deepEqual(stub.journal, loadedJournal, 'an empty checkpoint journal is never an overlay');
});

test('orchestrator wiring uses restoreFromPersistence and buildCheckpointState', () => {
```

## CHANGE: tests/cosmo23/brain-backups.test.cjs

(a) Append one budget-cap test after the existing hung-backup block (anchor is the unique tail of the last test). Uses the suite's existing silentLogger (defined at line 14). Failing-first: takes 4s and fails on current code, ~1s and passes with the fix.

### Anchor
```
  const started = Date.now();
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(hung);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `bounded wait must not hang (took ${elapsed}ms)`);
});
```

### Code
```js
  const started = Date.now();
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(hung);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `bounded wait must not hang (took ${elapsed}ms)`);
});

test('awaitPendingBackupForShutdown caps its bound at the remaining shutdown budget', async () => {
  // Phase-1 polish (a): with a handler-stamped deadline nearly exhausted,
  // the backup wait shrinks to the 1s floor instead of its 4s config —
  // the sum of shutdown steps must stay inside the hard-kill budget.
  const hung = {
    logger: silentLogger,
    config: { shutdownBackupTimeoutMs: 4000 },
    shutdownDeadline: Date.now() + 50, // almost no budget left → 1s floor
    _backupPromise: new Promise(() => {}),
  };
  const started = Date.now();
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(hung);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500,
    `deadline-capped wait must fire near the 1s floor, not the 4s config (took ${elapsed}ms)`);
});
```

## TEST FILE: tests/cosmo23/graceful-shutdown-honesty.test.cjs

```js
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
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, {
    shutdownTimeoutMs: 5000,
    shutdownDeadlineMarginMs: 1000,
  });

  const before = Date.now();
  await handler.shutdown('test');
  const after = Date.now();

  assert.ok(Number.isFinite(orchestrator.shutdownDeadline),
    'handler must pass the deadline via orchestrator.shutdownDeadline');
  assert.ok(orchestrator.shutdownDeadline >= before + 4000 - 50,
    'deadline = start + shutdownTimeoutMs - margin');
  assert.ok(orchestrator.shutdownDeadline <= after + 4000);
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
    shutdownTimeoutMs: 10000,
    shutdownDeadlineMarginMs: 8000, // deadline at +2s
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

```

## API NOTES

VALIDATION (temporary application, FULLY REVERTED): I applied every proposed change in the working tree, ran the four suites (node --test from repo root): 58/58 pass patched (45 pre-existing + 13 new). Failing-first proof: with ONLY the test additions on original source, exactly 10/13 new tests fail (the 3 that pass are deliberate pins: operator escape hatch, empty-journal no-clobber, fresh-save-full-budget). cosmo23 engine mocha also green against the patched source: graceful-shutdown-handler + crash-recovery-manager (25 passing), orchestrator-consolidation-honesty + orchestrator-guided-continuation (13 passing). All six touched files were then restored from byte-exact backups and verified with cmp — the tree is exactly as I found it; git status shows only other sessions' pre-existing modifications, none of these files.

TASK-BRIEF DRIFT verified against the CURRENT tree: saveStateForShutdown is at orchestrator.js:9248-9302 (brief said ~9147-9159); the journal overlay is at :482-485 (brief said ~480-483); graceful-shutdown-handler.js:20/:155 match the brief.

DESIGN DECISIONS:
1. (a) shutdownBudgetMs is a module-level EXPORTED function (`module.exports = { Orchestrator, shutdownBudgetMs }`), not an instance method — deliberately, so the suite's Orchestrator.prototype.<helper>.call(fake) pattern keeps working: fakes never need to wire a method, and an unset/non-finite this.shutdownDeadline means "no deadline → default unchanged". Formula: min(defaultMs, max(1000, deadline - now)) — defaults are ceilings, 1s floor. The handler inlines the same formula for the agent wait rather than requiring orchestrator.js (avoids a require cycle; orchestrator-side code paths require the handler). New config knob: shutdownDeadlineMarginMs (default 5000) on the HANDLER config. Post-fix worst-case default arithmetic: 150s wait + min(60s, ~25s remaining) save + 1s telemetry floor + 1s backup floor + 5s margin ≤ 180s hard-kill. Semantic tradeoff (intended): a save that cannot finish in its remaining slice now times out honestly (dirty marker, crash recovery re-hydrates from sidecars) instead of being hard-killed mid-save with exit 1.
2. (b) Joined path races the CAPTURED reference (Promise.resolve-wrapped — it may already be settled); the non-joined path still calls this.saveState(), which itself joins any still-running save, under the full remaining budget. When the in-flight save settled in the TOCTOU window, its result IS the shutdown result (join semantics per the Task 3 design) — previously a fresh save silently started under the 15s grace. The timed-out log keeps saveAlreadyInProgress and adds joinedInflight.
3. (c) DELIBERATE deviation from a contract-literal memo, flagged for review: brain-snapshot.json (tier 1) is re-read on EVERY save because it is the documented operator escape hatch (core CLAUDE.md: a legitimate >50% prune is refused every cycle and the intended intervention is editing the snapshot's counts down — a memo hiding tier 1 would dead-end the hatch until process restart). Only the expensive tiers (manifest read, memory-nodes.jsonl.gz streaming, legacy inline state load) are memoized on this._knownGoodCache; that is precisely where the every-cycle re-streaming cost lived (streaming only ever runs when no snapshot exists). Successful save sets the cache to {count: totalNodes, source: 'snapshot'} exactly per contract. A guard-resolution throw does NOT populate the cache — persistence_guard_failed stays fail-closed and is retried next save. The escape-hatch pin test enforces this against future "simplification" to a contract-literal memo.
4. (d) Journal overlays iff checkpointIsFresher && non-empty. Length dropped as a signal (both sides slice(-100); the fresher checkpoint's slice wins even when shorter — the 100-cap case is documented in the code comment). Empty checkpoint journal never clobbers. lastSummarization left untouched: its monotonic numeric > comparison is already a per-scalar freshness predicate. Both pre-existing journal assertions in the suite still pass under the new predicate (verified).

DONOR NOTE (H6): no Home23 donor API was assumed; brain-snapshot.js is already the in-tree port and readSnapshot/snapshotNodeCount signatures were read directly. All engine changes are cosmo23-native; no patch-log entry needed (no integration boundary touched).

IMPLEMENTATION WARNINGS: (1) In graceful-shutdown-handler.js the blank lines directly above AND below the `const maxAgentWait ...` anchor line carry trailing spaces (8 spaces each) — anchor on the single code line exactly as given. (2) `saved: true,` appears twice in orchestrator.js — use the full 7-line lastSaveResult block anchor as given. (3) All other anchors grep-verified unique in the current tree. (4) The saveStateForShutdown change replaces the whole method; its anchor is the method's first three lines and the replacement ends at the method's closing brace (the next line after it in the file is the /** doc comment for awaitPendingBackupForShutdown). (5) No package.json / package-test-registration changes: all 13 tests land in suites already registered exactly once. (6) The new timing tests add ~2.3s green wall time (agent-wait test ~3s due to the loop's 1s poll granularity); red-state runs of the failing-first timing tests take 4-8s each by design. (7) testFile is the complete replacement content for the EXISTING suite tests/cosmo23/graceful-shutdown-honesty.test.cjs (per the polish-pack instruction to extend existing suites — it is not a new file); the other three suites' additions are in proposedChanges with exact anchors.
