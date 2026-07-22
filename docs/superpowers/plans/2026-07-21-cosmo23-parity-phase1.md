# COSMO23 Parity — Phase 1: Persistence Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close cosmo23's restart data-loss race and port the six battle-tested Home23 persistence fixes (spec: `docs/superpowers/specs/2026-07-21-cosmo23-parity-program-design.md`, Phase 1) before the next research run launches.

**Architecture:** cosmo23's save path already commits manifest/sidecar generations (`persistResearchState`), but its load, crash-recovery, and shutdown paths are pre-fix ancestors. We fix bottom-up: the state-file writer first (atomicity), then the save guard, then shutdown honesty, then crash recovery, then load-side hydration, then backups. Every fix returns/consumes the same structured save result and the same `brain-snapshot.json` sidecar, so order matters and is encoded in the task sequence.

**Tech Stack:** Node.js CommonJS (cosmo23 engine), `node:test` + `assert/strict` suites at repo root (`tests/cosmo23/*.test.cjs`, registered in package.json's `test` chain), mocha suites inside `cosmo23/engine/` for the vendored engine's own tests.

---

## How to read this plan

Four tasks apply change-specs that live as **appendices** in `docs/superpowers/plans/2026-07-21-cosmo23-parity-phase1/`. Each appendix contains, verbatim: the verified buggy current state, every change as `file` + `### Anchor` (exact existing text) + `### Code` (exact replacement/insertion), a complete test file, and API notes. Apply changes **by exact anchor text, never by line number** (several anchor regions contain trailing-whitespace-only lines — the appendices call each one out). Appendices A4 and A5 were **execution-verified** by their authors (applied to the real tree, tests run green, then reverted); A2 and A3 were source-verified only — TDD order below will surface any fake/fixture mismatches, fix the test fixture if its stub is missing a property the real code path touches, never weaken an assertion.

**Shared contracts every task must preserve:**
1. `saveState()` returns `{ saved: boolean, reason: string|null, currentNodes: number, existingNodes: number|null }`; guard refusals return `reason: 'catastrophic_node_drop'` and never throw.
2. `brain-snapshot.json` lives next to `state.json.gz` (the orchestrator's `logsDir`), shape `{ nodes, edges, savedAt, generation }` + `nodeCount`/`edgeCount` compatibility aliases.
3. Load-side hydration goes through `cosmo23/lib/memory-sidecar.js` streaming readers — never a single-string JSON parse of sidecars.
4. Snapshot/manifest says nodes > 0 but loaded graph has 0 → throw `BRAIN_LOAD_EMPTY`, engine halts.
5. `markCleanShutdown()` only when a save result is `saved === true`.
6. Checkpoints are scalar overlays — never a memory source.
7. Every new `tests/cosmo23/*.test.cjs` file is registered in package.json's `test` chain AND in the enforcement list in `tests/cosmo23/package-test-registration.test.cjs` (each exactly once).

**Sacred rule (extended to cosmo23 by the approved spec):** after any task that touches save/load code, do NOT restart any live engine without the standalone load test in Task 9. cosmo23 must remain idle (`curl -s localhost:43210/api/status` → `activeRun: false`) for the whole plan; check before starting.

**Commit style:** one commit per task, message given in the task. cosmo23 is first-class editable per the approved spec — these commits need NO new `HOME23 PATCH` entries (Task 8 updates the doctrine docs instead).

---

### Task 0: Preflight baseline

**Files:** none modified.

- [ ] **Step 0.1: Confirm cosmo23 idle and worktree expectations**

```bash
curl -s --max-time 5 http://localhost:43210/api/status | python3 -c "import sys,json; h=json.load(sys.stdin).get('health',{}); print('lifecycle:',h.get('lifecycle'),'activeRun:',h.get('activeRun'))"
```
Expected: `lifecycle: idle activeRun: False`. If a run is active, STOP — do not proceed; ask jtr.

```bash
git status --porcelain
```
Expected pre-existing entries (leave them alone — foreign session work): `M docs/superpowers/plans/2026-07-21-shakedown-jerry-worker-runtime.md`, `M engine/src/realtime/websocket-server.js`, `M src/home.ts`, untracked `.merge-backup-os-kernel-20260717-184529/`, `.verification/`, `docs/receipts/...`. Expected Phase-1 pre-staged files (Task 5 consumes them): untracked `cosmo23/engine/src/core/state-hydration.js` and `tests/cosmo23/state-hydration.test.cjs`.

- [ ] **Step 0.2: Baseline the two test worlds**

```bash
npm test 2>&1 | tail -5
```
Expected: full suite green (~2,800+ pass, 0 fail). Record the pass count.

```bash
cd cosmo23/engine && npx mocha tests/unit/crash-recovery-manager.test.js tests/unit/graceful-shutdown-handler.test.js tests/unit/timeout-manager.test.js --timeout 10000 2>&1 | tail -3; cd ../..
```
Expected: all pass. Record counts — Task 7 re-runs these.

---

### Task 1: Atomic state writes + corrupt-gzip salvage (StateCompression)

**Appendix:** `spec-A5-atomic-state-writes.md` (execution-verified: 9/9).

**Files:**
- Modify: `cosmo23/engine/src/core/state-compression.js` (full-file replacement — appendix "CHANGE" section contains the complete new file)
- Create: `tests/cosmo23/state-compression-atomicity.test.cjs` (appendix "TEST FILE" section, complete content)
- Modify: `package.json` (test registration — appendix anchor)
- Modify: `tests/cosmo23/package-test-registration.test.cjs` (enforcement list — appendix anchor)

- [ ] **Step 1.1:** Create `tests/cosmo23/state-compression-atomicity.test.cjs` with the appendix's complete test file content, and apply both registration edits (package.json + enforcement list) from the appendix.
- [ ] **Step 1.2:** Run the new suite — it must FAIL against the current module (the in-place write and missing salvage are the bugs):

```bash
node --test --test-concurrency=1 tests/cosmo23/state-compression-atomicity.test.cjs
```
Expected: multiple failures (e.g. "must never write the final .gz in place", salvage test throws).

- [ ] **Step 1.3:** Replace `cosmo23/engine/src/core/state-compression.js` with the appendix's complete new module (atomic `_writeAtomic` temp+rename, `salvageFirstGzipMember` RFC-1952 walk + `inflateRawSync`, structured empty-state fallback; public API unchanged, exports gain `uniqueTmpPath` + `salvageFirstGzipMember`).
- [ ] **Step 1.4:** Run the new suite again:

```bash
node --test --test-concurrency=1 tests/cosmo23/state-compression-atomicity.test.cjs tests/cosmo23/package-test-registration.test.cjs
```
Expected: PASS (9 + 1 tests).

- [ ] **Step 1.5:** Regression check on direct consumers (14 call sites listed in appendix API notes — all destructure `{ StateCompression }`):

```bash
node --test --test-concurrency=1 tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/cluster-aware-memory-persistence.test.cjs
```
Expected: PASS.

- [ ] **Step 1.6: Commit**

```bash
git add cosmo23/engine/src/core/state-compression.js tests/cosmo23/state-compression-atomicity.test.cjs package.json tests/cosmo23/package-test-registration.test.cjs
git commit -m "fix(cosmo23): atomic state writes + first-gzip-member salvage in StateCompression

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: brain-snapshot sidecar + every-cycle save-safety guard

**Appendix:** `spec-A2-brain-snapshot-save-guard.md`.

**Files:**
- Create: `cosmo23/engine/src/core/brain-snapshot.js` (appendix CHANGE 1, complete file)
- Modify: `cosmo23/engine/src/core/orchestrator.js` (appendix CHANGE 2: import line; CHANGE 3: full replacement of the saveState body from `const statePath = ...` through the method's closing brace — deletes the dead cycles-0-1 guard, adds every-cycle guard + snapshot stamping + structured results)
- Create: `tests/cosmo23/brain-snapshot-guard.test.cjs` (appendix TEST FILE)
- Modify: `package.json`, `tests/cosmo23/package-test-registration.test.cjs` (appendix anchors)

**Anchor gotcha (from appendix):** the saveState anchor block contains two whitespace-only lines carrying 6 trailing spaces (original lines 8113/8139). If the exact-match edit fails, edit those two lines individually first, or split the replacement at those lines.

- [ ] **Step 2.1:** Create the test file + both registration edits.
- [ ] **Step 2.2:** Run it — module doesn't exist yet:

```bash
node --test --test-concurrency=1 tests/cosmo23/brain-snapshot-guard.test.cjs
```
Expected: FAIL — `Cannot find module '.../brain-snapshot'`.

- [ ] **Step 2.3:** Create `cosmo23/engine/src/core/brain-snapshot.js` (appendix, complete). Run again — the module-level tests pass; the `real saveState` integration test still FAILS (saveState not yet wired: no structured result, no snapshot stamp, drop-at-cycle-50 not refused).
- [ ] **Step 2.4:** Apply the two orchestrator changes (import + saveState body replacement) exactly per appendix.
- [ ] **Step 2.5:** Run the suite plus the existing saveState-driving suite:

```bash
node --test --test-concurrency=1 tests/cosmo23/brain-snapshot-guard.test.cjs tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/package-test-registration.test.cjs
```
Expected: ALL PASS (appendix API note 10 explains why research-memory-manifest is unaffected: fresh dirs resolve known-good=0 and always pass).

- [ ] **Step 2.6: Commit**

```bash
git add cosmo23/engine/src/core/brain-snapshot.js cosmo23/engine/src/core/orchestrator.js tests/cosmo23/brain-snapshot-guard.test.cjs package.json tests/cosmo23/package-test-registration.test.cjs
git commit -m "fix(cosmo23): every-cycle save-safety guard + brain-snapshot sidecar

Replaces the dead cycles-0-1 guard that read uncompressed state.json while
saves write state.json.gz. saveState now returns a structured result.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Graceful-shutdown honesty (lock, bounded save, conditional clean marker)

**Appendix:** `spec-A3-shutdown-honesty.md`.

**MERGE NOTE — two appendix changes are SUPERSEDED by Task 2 and must be SKIPPED:**
- A3's CHANGE "(a) Guard refusal returns the structured result" targets the old dead-guard text — Task 2 already deleted it. **Skip.**
- A3's CHANGE "(a) Success and error paths return structured results" (anchor: the rotateBackups block + old bare catch) — Task 2's replacement already returns structured results with better `existingNodes`. **Skip.**

**Apply these A3 changes, in order:**
1. saveState re-entrancy lock (rename body to `_saveStateUnlocked`, new `saveState()` wrapper) — anchor is the method opening (`async saveState() { // Save evaluation metrics...`), untouched by Task 2.
2. The bounded-shutdown trio inserted before `async stop()`: `cleanupTelemetryForShutdown`, `hasDurableStateArtifact`, `saveStateForShutdown`.
3. `stop()` shutdown-branch replacement (single bounded save, `shutdownStateHandled`/`shutdownStateResult`/`shutdownCleanMarked`, clean marker only on `saved === true`, bounded telemetry AFTER the marker decision).
4. `graceful-shutdown-handler.js` Steps 2–3 replacement (skip double save, dirty-on-unconfirmed).
5. `graceful-shutdown-handler.js` `dumpState()` replacement (returns the structured result).
6. Registration edits (package.json + enforcement list).

**Files:**
- Modify: `cosmo23/engine/src/core/orchestrator.js`, `cosmo23/engine/src/core/graceful-shutdown-handler.js`
- Create: `tests/cosmo23/graceful-shutdown-honesty.test.cjs` (appendix TEST FILE)
- Modify: `package.json`, `tests/cosmo23/package-test-registration.test.cjs`

- [ ] **Step 3.1:** Create the test file + registrations. Run it:

```bash
node --test --test-concurrency=1 tests/cosmo23/graceful-shutdown-honesty.test.cjs
```
Expected: FAIL — "refused save must leave shutdown dirty" (current handler marks clean unconditionally), and the coalescing test fails (`_saveStateUnlocked` doesn't exist). If a failure is instead a fixture/constructor mismatch (A3 was not execution-verified), fix the FIXTURE to match the real constructor signature (`new GracefulShutdownHandler(orchestrator, logger, options)` — verify in the file), never the assertion.

- [ ] **Step 3.2:** Apply changes 1–5 above per appendix anchors.
- [ ] **Step 3.3:** Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs tests/cosmo23/package-test-registration.test.cjs
```
Expected: ALL PASS (brain-snapshot-guard drives `Orchestrator.prototype.saveState.call(fake)` — after the lock rename this hits the wrapper; the appendix fakes set `_saveStatePromise` implicitly undefined, which the wrapper handles; if a fake breaks, add `_saveStatePromise: null` to the fake).

- [ ] **Step 3.4:** cosmo23's own mocha suite for the handler:

```bash
cd cosmo23/engine && npx mocha tests/unit/graceful-shutdown-handler.test.js --timeout 10000; cd ../..
```
Expected: if any test asserts the OLD behavior (markCleanShutdown after a failed save, double-save), update that mocha test to the new honest contract — assert dirty-on-unconfirmed instead. Record which tests changed for the Task 8 doc update.

- [ ] **Step 3.5: Commit**

```bash
git add cosmo23/engine/src/core/orchestrator.js cosmo23/engine/src/core/graceful-shutdown-handler.js tests/cosmo23/graceful-shutdown-honesty.test.cjs package.json tests/cosmo23/package-test-registration.test.cjs cosmo23/engine/tests
git commit -m "fix(cosmo23): honest shutdown — clean marker only on confirmed save, save lock, bounded shutdown save

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Crash-recovery overhaul (gz detection, loadState-always, scalar checkpoints)

**Appendix:** `spec-A4-crash-recovery.md` (execution-verified: 9/9 new tests + cosmo23 mocha crash-recovery suites 13+8 green).

**Files:**
- Modify: `cosmo23/engine/src/core/crash-recovery-manager.js` (both-artifact detection; audit-artifact memorySummary fallback)
- Modify: `cosmo23/engine/src/core/orchestrator.js` (insert `restoreFromPersistence()` + `buildCheckpointState()` before `async initialize()`; replace the initialize() recovery branch with `await this.restoreFromPersistence();`; replace the executeCycle checkpoint assembly with `const checkpointState = this.buildCheckpointState();`)
- Create: `tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs` (appendix TEST FILE)
- Modify: `package.json`, `tests/cosmo23/package-test-registration.test.cjs`

**Wiring constraint (tests assert at source level):** keep the exact lines `await this.restoreFromPersistence();` and `const checkpointState = this.buildCheckpointState();` verbatim.

- [ ] **Step 4.1:** Create test file + registrations. Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs
```
Expected: FAIL — gz-only crash classified as first run; `restoreFromPersistence` undefined.

- [ ] **Step 4.2:** Apply all appendix changes (anchors are grep-unique comment lines; blank lines 453/456 carry 4 trailing spaces — anchor from the comment line as the appendix instructs).
- [ ] **Step 4.3:** Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs tests/cosmo23/package-test-registration.test.cjs
```
Expected: PASS (9 + 1).

- [ ] **Step 4.4:** cosmo23 engine mocha suites (appendix author verified green; confirm):

```bash
cd cosmo23/engine && npx mocha tests/unit/crash-recovery-manager.test.js tests/single-instance/crash-recovery.test.js --timeout 30000; cd ../..
```
Expected: PASS (13 + 8).

- [ ] **Step 4.5: Commit**

```bash
git add cosmo23/engine/src/core/crash-recovery-manager.js cosmo23/engine/src/core/orchestrator.js tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs package.json tests/cosmo23/package-test-registration.test.cjs
git commit -m "fix(cosmo23): crash recovery detects gz state, always runs loadState, scalar-only checkpoints

Checkpoint recovery previously skipped loadState entirely (memory=0 bug class)
and serialized the full graph + embeddings through one JSON.stringify every
5 cycles.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Deploy caveat (from appendix):** the first restart after upgrade may still JSON.parse a legacy multi-hundred-MB checkpoint inside `recover()`. cosmo23 research brains are small today, so no action needed; if a jerry-scale brain ever runs under cosmo23, delete `<logsDir>/checkpoints/checkpoint-*.json` once at deploy.

---

### Task 5: loadState manifest hydration + BRAIN_LOAD_EMPTY fail-loud guard

The module and its test suite already exist on disk, pre-staged and reviewed (they were authored against the real `hydrateStateMemory` API and include edge-endpoint string normalization so hydrated edges survive the orchestrator's node-existence filter):
- `cosmo23/engine/src/core/state-hydration.js` (untracked, 170 lines, complete)
- `tests/cosmo23/state-hydration.test.cjs` (untracked, 231 lines, complete — includes two integration tests driving `Orchestrator.prototype.loadState.call(fake)`)

This task registers them and adds the orchestrator wiring the tests demand.

**Files:**
- Existing: the two files above (review, do not rewrite)
- Modify: `cosmo23/engine/src/core/orchestrator.js` (import + loadState wiring + catch rethrow)
- Modify: `package.json`, `tests/cosmo23/package-test-registration.test.cjs`

- [ ] **Step 5.1:** Register the test. In `package.json` `scripts.test`, the anchor below occurs exactly once:

Anchor:
```
tests/cosmo23/mcp-memory-tools.test.cjs tests/cosmo23/research-memory-manifest.test.cjs
```
Replace with:
```
tests/cosmo23/mcp-memory-tools.test.cjs tests/cosmo23/state-hydration.test.cjs tests/cosmo23/research-memory-manifest.test.cjs
```

In `tests/cosmo23/package-test-registration.test.cjs`, after the line `'tests/cosmo23/research-memory-manifest.test.cjs',` add:
```js
    'tests/cosmo23/state-hydration.test.cjs',
```

- [ ] **Step 5.2:** Run the suite — module tests pass, the two `Orchestrator.loadState` integration tests FAIL (wiring absent):

```bash
node --test --test-concurrency=1 tests/cosmo23/state-hydration.test.cjs
```
Expected: 4 pass, 2 fail — "restart after a manifest-path save must boot the real nodes" (loads 0) and "must propagate the fail-loud guard" (resolves instead of rejecting).

- [ ] **Step 5.3:** Wire the orchestrator. Three edits to `cosmo23/engine/src/core/orchestrator.js`:

**(a) Import** — anchor (after Task 2's edit this block reads):
```js
const { persistResearchState } = require('../../../lib/memory-sidecar');
const { writeSnapshot, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
```
Replace with:
```js
const { persistResearchState } = require('../../../lib/memory-sidecar');
const { writeSnapshot, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
const { hydrateOrchestratorState } = require('./state-hydration');
```

**(b) Hydration call in loadState** — anchor (unique in file):
```js
      // Load state (handles both compressed and uncompressed)
      const state = await StateCompression.loadCompressed(statePath);
```
Replace with:
```js
      // Load state (handles both compressed and uncompressed)
      let state = await StateCompression.loadCompressed(statePath);

      // Manifest-backed saves store an EMPTY memory shell in state.json.gz —
      // hydrate the real graph back through the streaming reader before any
      // import below. Throws BRAIN_LOAD_EMPTY when the snapshot/manifest
      // expect nodes but hydration produced none (fail-loud contract).
      const hydration = await hydrateOrchestratorState(this.logsDir, state, { logger: this.logger });
      state = hydration.state;
      if (hydration.hydrated) {
        this.logger.info('🧠 Memory hydrated from manifest sidecars', {
          source: hydration.source,
          nodes: hydration.nodes,
          edges: hydration.edges,
          expectedNodes: hydration.expectedNodes
        });
      }
```

**(c) Catch rethrow** — loadState's catch currently swallows all non-ENOENT errors ("Don't throw - let the run continue"). Anchor (unique):
```js
    } catch (error) {
      // CRITICAL FIX: Don't silently swallow state loading errors!
      // This was causing merged brains to start with empty memory
      if (error.code === 'ENOENT') {
```
Replace with:
```js
    } catch (error) {
      // Fail-loud contract: a brain that should have nodes but loaded empty
      // must HALT the engine, never continue as a fresh brain.
      if (String(error.message || '').startsWith('BRAIN_LOAD_EMPTY')) {
        this.logger.error('🛑 BRAIN_LOAD_EMPTY — refusing to continue with an empty brain', {
          error: error.message,
          path: this.logsDir
        });
        throw error;
      }
      // CRITICAL FIX: Don't silently swallow state loading errors!
      // This was causing merged brains to start with empty memory
      if (error.code === 'ENOENT') {
```

- [ ] **Step 5.4:** Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/state-hydration.test.cjs tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs tests/cosmo23/package-test-registration.test.cjs
```
Expected: ALL PASS. (crash-recovery suite re-run because `restoreFromPersistence` awaits `loadState()` — the BRAIN_LOAD_EMPTY throw now propagates out of `initialize()`, which is the designed composition.) If an integration-test fake is missing a property the real loadState body touches, extend the FAKE (the state fixtures carry only `cycleCount`/`journal`/`memory`, so guarded import blocks skip — see test file comments), never weaken assertions.

- [ ] **Step 5.5: Commit**

```bash
git add cosmo23/engine/src/core/state-hydration.js cosmo23/engine/src/core/orchestrator.js tests/cosmo23/state-hydration.test.cjs package.json tests/cosmo23/package-test-registration.test.cjs
git commit -m "fix(cosmo23): loadState hydrates manifest sidecars + BRAIN_LOAD_EMPTY fail-loud guard

Closes the restart data-loss race: saveState has written manifest-backed
empty shells since the Patch 49-70 arc, but loadState only imported inline
arrays — first restart booted 0 nodes and the next save clobbered the brain.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Routine interval-gated brain backups

Design deviation from the spec, recorded here deliberately: the Home23 donor (`engine/src/core/brain-backups.js`) uses coordinator pins, whose orphan-pin leak is a known open incident (2026-07-16). cosmo23 full-rewrites its base on every save, so holding the **memory-source write lock** during the copy gives the same internal consistency with none of the pin machinery. Free-disk floor kept from the donor (disk exhaustion is lived history).

**Files:**
- Create: `cosmo23/engine/src/core/brain-backups.js`
- Modify: `cosmo23/engine/src/core/orchestrator.js` (import + replace the dead rotateBackups block in `_saveStateUnlocked`)
- Create: `tests/cosmo23/brain-backups.test.cjs`
- Modify: `package.json`, `tests/cosmo23/package-test-registration.test.cjs`

- [ ] **Step 6.1:** Create `tests/cosmo23/brain-backups.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { maybeBackupBrain, listBackups } = require('../../cosmo23/engine/src/core/brain-backups');
const { persistResearchState } = require('../../cosmo23/lib/memory-sidecar');

const silentLogger = { info() {}, warn() {}, error() {} };
const HOUR = 60 * 60 * 1000;

async function makeFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo23-brain-backups-'));
  const runDir = path.join(root, 'run');
  const lockRoot = path.join(root, 'locks');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(lockRoot, { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // Persist a real manifest generation so the backup set includes the
  // active base sidecars the manifest references.
  const graph = {
    nodes: [{ id: 1, concept: 'backup me', embedding: [0.1, 0.9], weight: 1 }],
    edges: [],
    clusters: [],
    nextNodeId: 2,
    nextClusterId: 1,
  };
  const statePath = path.join(runDir, 'state.json');
  const outcome = await persistResearchState(runDir, { cycleCount: 3, memory: graph }, {
    lockRoot,
    saveState: async (captured) => {
      await fsp.writeFile(`${statePath}.gz`, zlib.gzipSync(JSON.stringify(captured)));
      return { compressed: true, size: 1 };
    },
  });
  assert.equal(outcome.degraded, false, 'fixture manifest commit must succeed');
  await fsp.writeFile(path.join(runDir, 'brain-snapshot.json'), JSON.stringify({
    nodes: 1, edges: 0, savedAt: new Date().toISOString(), generation: outcome.revision,
    nodeCount: 1, edgeCount: 0,
  }));
  return { runDir, lockRoot };
}

test('first backup copies the coherent artifact set into a timestamped dir', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const result = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: Date.now() });

  assert.equal(result.created, true);
  const backups = listBackups(runDir);
  assert.equal(backups.length, 1);
  const contents = fs.readdirSync(backups[0].path, { recursive: true }).map(String);
  assert.equal(contents.includes('state.json.gz'), true);
  assert.equal(contents.includes('memory-manifest.json'), true);
  assert.equal(contents.includes('brain-snapshot.json'), true);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'memory-manifest.json'), 'utf8'));
  const baseNodesFile = manifest.activeBase.nodes.file;
  assert.equal(
    fs.existsSync(path.join(backups[0].path, baseNodesFile)), true,
    `active base nodes file ${baseNodesFile} must be in the backup`,
  );
  assert.equal(fs.existsSync(backups[0].path + '.tmp'), false, 'tmp staging dir must be renamed away');
});

test('a second backup within the interval is skipped', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const now = Date.now();
  const first = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now });
  assert.equal(first.created, true);

  const second = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: now + HOUR });
  assert.equal(second.created, false);
  assert.equal(second.skipped, 'interval');
  assert.equal(listBackups(runDir).length, 1);
});

test('backups past the interval rotate down to the retention count', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const now = Date.now();

  const r1 = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now });
  const r2 = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: now + 7 * HOUR });
  const r3 = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: now + 14 * HOUR });
  assert.equal(r1.created && r2.created && r3.created, true, 'interval-passed backups must all be created');
  assert.equal(r3.rotated, 1, 'third backup must rotate the oldest out');

  const names = listBackups(runDir).map(({ name }) => name);
  assert.equal(names.length, 2, 'retention default keeps 2');
  assert.equal(names.includes(path.basename(r1.path)), false, 'oldest backup must be gone');
});

test('low free disk skips the backup instead of filling the volume', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const result = await maybeBackupBrain(runDir, {
    lockRoot, logger: silentLogger, now: Date.now(),
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.created, false);
  assert.equal(result.skipped, 'low_disk');
  assert.equal(listBackups(runDir).length, 0);
});

test('a dir with no state artifacts fails cleanly with no tmp leftovers', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo23-brain-backups-empty-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const lockRoot = path.join(root, 'locks');
  await fsp.mkdir(lockRoot, { recursive: true });

  const result = await maybeBackupBrain(root, { lockRoot, logger: silentLogger, now: Date.now() });
  assert.equal(result.created, false);
  assert.match(result.error, /no state artifacts/);
  const leftovers = fs.readdirSync(path.join(root, 'backups')).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'failed backup must clean its tmp staging dir');
});
```

- [ ] **Step 6.2:** Register it. package.json anchor (occurs exactly once):
```
tests/cosmo23/pgs-cancellation.test.cjs tests/cosmo23/pgs-engine.test.cjs
```
→
```
tests/cosmo23/pgs-cancellation.test.cjs tests/cosmo23/brain-backups.test.cjs tests/cosmo23/pgs-engine.test.cjs
```
Enforcement list: after `'tests/cosmo23/pgs-cancellation.test.cjs',` add `'tests/cosmo23/brain-backups.test.cjs',`.

- [ ] **Step 6.3:** Run — must fail with module not found:

```bash
node --test --test-concurrency=1 tests/cosmo23/brain-backups.test.cjs
```

- [ ] **Step 6.4:** Create `cosmo23/engine/src/core/brain-backups.js`:

```js
/**
 * Routine interval-gated brain backups for cosmo23 research runs.
 *
 * cosmo23 rotated backups after every save but never created one — rotation
 * governed files that did not exist. This module owns the whole lifecycle:
 * an interval-gated (default 6h) copy of the coherent brain artifact set
 * into <logsDir>/backups/backup-<stamp>/, with retention rotation and a
 * free-disk floor (disk exhaustion is lived Home23 history).
 *
 * Consistency: the copy runs under the SAME memory-source write lock the
 * save path uses (persistResearchState), so a backup can never observe a
 * half-rewritten base. Deliberate deviation from the Home23 donor: no
 * coordinator pins (their orphan-pin leak is a known open incident, and
 * cosmo23 full-rewrites its base every save, so the lock suffices).
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { withMemorySourceLock } = require('../../../../shared/memory-source');

const BACKUPS_DIR = 'backups';
const DEFAULT_RETENTION = 2;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_FREE_BYTES = 4 * 1024 ** 3;

// Fixed-name artifacts; manifest-referenced base/delta files are added
// per-backup by readManifestFiles(). Legacy sidecar names included for
// pre-manifest run dirs; ENOENT on any individual file is fine.
const CANDIDATE_FILES = [
  'state.json.gz',
  'state.json',
  'brain-snapshot.json',
  'memory-manifest.json',
  'memory-nodes.jsonl.gz',
  'memory-edges.jsonl.gz',
  'memory-delta.jsonl',
];

function backupsRoot(logsDir) {
  return path.join(logsDir, BACKUPS_DIR);
}

function listBackups(logsDir) {
  const root = backupsRoot(logsDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.startsWith('backup-') && !name.endsWith('.tmp'))
    .map((name) => ({ name, path: path.join(root, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mostRecentBackupTime(logsDir) {
  const list = listBackups(logsDir);
  if (list.length === 0) return 0;
  try {
    return fs.statSync(list[list.length - 1].path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Files the current manifest generation references (relative to logsDir).
 * Read fresh inside the lock so the set matches the bases being copied.
 */
function readManifestFiles(logsDir) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(logsDir, 'memory-manifest.json'), 'utf8'),
    );
    const files = [];
    for (const side of ['nodes', 'edges']) {
      const file = manifest?.activeBase?.[side]?.file;
      if (typeof file === 'string' && file) files.push(file);
    }
    const deltas = Array.isArray(manifest?.deltas) ? manifest.deltas : [];
    for (const delta of deltas) {
      if (typeof delta?.file === 'string' && delta.file) files.push(delta.file);
    }
    if (typeof manifest?.activeDelta?.file === 'string' && manifest.activeDelta.file) {
      files.push(manifest.activeDelta.file);
    }
    return files;
  } catch {
    return [];
  }
}

async function freeBytes(logsDir) {
  try {
    const stat = await fsp.statfs(logsDir);
    return stat.bavail * stat.bsize;
  } catch {
    return null; // statfs unavailable — do not block backups on it
  }
}

/**
 * Create a backup if one is due. Never throws — returns a structured result:
 *   { created: true, path, rotated }
 *   { created: false, skipped: 'interval' | 'low_disk', ... }
 *   { created: false, error }
 */
async function maybeBackupBrain(logsDir, options = {}) {
  const logger = options.logger || console;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retention = options.retention ?? DEFAULT_RETENTION;
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const now = options.now ?? Date.now();

  try {
    const last = mostRecentBackupTime(logsDir);
    if (last && now - last < intervalMs) {
      return { created: false, skipped: 'interval', lastBackupAt: last };
    }

    const free = await freeBytes(logsDir);
    if (free !== null && free < minFreeBytes) {
      logger.warn?.('⚠️ Skipping brain backup — free disk below floor', {
        freeBytes: free,
        minFreeBytes,
        logsDir,
      });
      return { created: false, skipped: 'low_disk', freeBytes: free };
    }

    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsRoot(logsDir), `backup-${stamp}`);
    const tmp = `${dest}.tmp`;

    try {
      await withMemorySourceLock(logsDir, { lockRoot: options.lockRoot }, async () => {
        const files = new Set([...CANDIDATE_FILES, ...readManifestFiles(logsDir)]);
        await fsp.mkdir(tmp, { recursive: true });
        let copied = 0;
        for (const name of files) {
          const src = path.join(logsDir, name);
          const target = path.join(tmp, name);
          try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(src, target);
            copied += 1;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        if (copied === 0) {
          throw new Error(`no state artifacts found to back up in ${logsDir}`);
        }
        await fsp.rename(tmp, dest);
      });
    } catch (error) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      logger.warn?.('⚠️ Brain backup failed (non-fatal)', { error: error.message, logsDir });
      return { created: false, error: error.message };
    }

    const all = listBackups(logsDir);
    const excess = all.slice(0, Math.max(0, all.length - retention));
    for (const old of excess) {
      await fsp.rm(old.path, { recursive: true, force: true }).catch(() => {});
    }

    return { created: true, path: dest, rotated: excess.length };
  } catch (error) {
    logger.warn?.('⚠️ Brain backup errored (non-fatal)', { error: error.message, logsDir });
    return { created: false, error: error.message };
  }
}

module.exports = {
  BACKUPS_DIR,
  DEFAULT_RETENTION,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MIN_FREE_BYTES,
  backupsRoot,
  listBackups,
  mostRecentBackupTime,
  maybeBackupBrain,
};
```

- [ ] **Step 6.5:** Run the suite:

```bash
node --test --test-concurrency=1 tests/cosmo23/brain-backups.test.cjs
```
Expected: PASS (5). If `withMemorySourceLock(logsDir, {...}, cb)` rejects because the run dir needs canonicalization, wrap `logsDir` with `fs.realpathSync` at the top of `maybeBackupBrain` — signature verified as `withMemorySourceLock(canonicalRoot, options = {}, callback)` in `shared/memory-source/pins.cjs:1570`.

- [ ] **Step 6.6:** Wire into saveState. Two edits to `cosmo23/engine/src/core/orchestrator.js`:

**(a) Import** — anchor (after Task 5):
```js
const { writeSnapshot, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
const { hydrateOrchestratorState } = require('./state-hydration');
```
→
```js
const { writeSnapshot, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
const { hydrateOrchestratorState } = require('./state-hydration');
const { maybeBackupBrain } = require('./brain-backups');
```

**(b) Replace the dead rotation block** inside `_saveStateUnlocked` (Task 2's replacement kept it) — anchor:
```js
      // Rotate old backups (keep last 5)
      // Run in background to not slow down save
      StateCompression.rotateBackups(this.logsDir, 'state.backup', 5)
        .then(result => {
          if (result.removed > 0) {
            this.logger.info('Rotated old backups', result);
          }
        })
        .catch(error => {
          this.logger.warn('Backup rotation failed', { error: error.message });
        });
```
→
```js
      // Periodic coherent backup (interval-gated, default 6h). Replaces the
      // legacy rotateBackups call that governed backups nothing ever created.
      // Fire-and-forget: a backup failure must never fail a save.
      maybeBackupBrain(this.logsDir, {
        lockRoot: this.config?.memorySource?.lockRoot,
        logger: this.logger,
        intervalMs: this.config?.backups?.intervalMs,
        retention: this.config?.backups?.retention,
        minFreeBytes: this.config?.backups?.minFreeBytes,
      })
        .then(result => {
          if (result.created) {
            this.logger.info('🗄️ Brain backup created', {
              path: result.path,
              rotated: result.rotated
            });
          }
        })
        .catch(error => {
          this.logger.warn('Backup failed (non-fatal)', { error: error.message });
        });
```

- [ ] **Step 6.7:** Full-composition check:

```bash
node --test --test-concurrency=1 tests/cosmo23/brain-backups.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/package-test-registration.test.cjs
```
Expected: ALL PASS. (The saveState fakes in brain-snapshot-guard use fresh tmpdirs — the fire-and-forget backup resolves `created:true` on first save there; it is `.catch`-guarded and the tests do not assert on it. If a test's tmpdir cleanup races the async backup, add `await new Promise(r => setTimeout(r, 50))` before that test's end — do not remove the backup wiring.)

- [ ] **Step 6.8: Commit**

```bash
git add cosmo23/engine/src/core/brain-backups.js cosmo23/engine/src/core/orchestrator.js tests/cosmo23/brain-backups.test.cjs package.json tests/cosmo23/package-test-registration.test.cjs
git commit -m "feat(cosmo23): routine interval-gated brain backups under the memory-source lock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: cosmo23 engine mocha sweep

**Files:** possibly modify `cosmo23/engine/tests/**` (only where a test asserts pre-fix behavior).

- [ ] **Step 7.1:**

```bash
cd cosmo23/engine && npm run test:unit 2>&1 | tail -10; cd ../..
```
Expected: green, or failures ONLY in tests asserting old dishonest behavior (unconditional clean marker, full-graph checkpoints, in-place writes). Update those assertions to the new contracts (dirty-on-unconfirmed, scalar checkpoints with `memorySummary`, temp+rename). Task 4's appendix already verified the two crash-recovery suites green — expect at most graceful-shutdown/orchestrator-adjacent updates.

- [ ] **Step 7.2:**

```bash
cd cosmo23/engine && npm run test:single-instance 2>&1 | tail -5; cd ../..
```
Expected: green (appendix A4 verified `tests/single-instance/crash-recovery.test.js` 8/8).

- [ ] **Step 7.3: Commit** (only if tests were updated)

```bash
git add cosmo23/engine/tests && git commit -m "test(cosmo23): update engine suites to honest persistence contracts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Doctrine + documentation truth

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md` (preamble only)
- Modify: `cosmo23/engine/src/core/CLAUDE.md` (stale invariants)
- Modify: `CLAUDE.local.md` (stale "Patch 20 is current" note)

- [ ] **Step 8.1:** In `docs/design/COSMO23-VENDORED-PATCHES.md`, insert after the opening paragraph (anchor: the line `These patches are tracked here for reference when pulling upstream changes into the bundle.`):

```markdown

> **Doctrine change (2026-07-21, approved by jtr):** cosmo23/ is now a
> first-class editable engine — the same transition engine/ made on
> 2026-07-15. Structural engine improvements land as normal code with normal
> tests and are NOT logged here. This log remains authoritative ONLY for
> integration-boundary changes: config plumbing, OAuth, env-var contracts,
> and server API surfaces that Home23/agents consume. Upstream resync is
> retired — cosmo23 updates only via `home23 update`. The Home23 sacred
> persistence rules (standalone load test before restart after
> persistence-adjacent changes; node-count verification after) apply to
> cosmo23 in full. See docs/superpowers/specs/2026-07-21-cosmo23-parity-program-design.md.
```

- [ ] **Step 8.2:** In `cosmo23/engine/src/core/CLAUDE.md`, update the stale claims to the new truth:
  - "Critical Invariants" #7: replace `**State save guard at cycle <= 1** prevents merged-brain overwrite.` with `**Save-safety guard runs on EVERY save** — brain-snapshot.json is the known-good baseline; a save dropping a >100-node brain below 50% is refused with a structured result (brain-snapshot.js).`
  - "Graceful Shutdown" sequence: after step 4 (`Mark clean shutdown`), append ` — ONLY when the final save result is saved === true; otherwise the marker stays dirty and the next boot runs crash recovery.`
  - "Crash Recovery" paragraph: append `Detection covers both state.json.gz and state.json. Recovery ALWAYS runs loadState(); a recovered checkpoint is applied strictly as a scalar overlay (cycleCount, journal, lastSummarization, guidedMissionPlan, completionTracker) — never as a memory source. Checkpoints are scalar-only (memorySummary counts, no graph).`
  - "State Files" table: add a row `| brain-snapshot.json | Last known-good node/edge counts (save guard + fail-loud load baseline) |` and a row `| backups/backup-<stamp>/ | Interval-gated coherent brain backups (6h default, retention 2) |`
  - "Common Pitfalls" #3 stays true (cycle timeouts remain monitoring-only until Phase 2) — leave it.

- [ ] **Step 8.3:** In `CLAUDE.local.md`, replace the stale sentence `COSMO23 Query/PGS Patch 20 is current:` (in "Current Checkout State") with `COSMO23 patch log runs through Patch 70+; the log now covers integration boundaries only (cosmo23 is first-class editable as of 2026-07-21). Historical note — Patch 20 was the Query/PGS small-run fallback:` (keep the rest of the sentence).

- [ ] **Step 8.4: Commit**

```bash
git add docs/design/COSMO23-VENDORED-PATCHES.md cosmo23/engine/src/core/CLAUDE.md CLAUDE.local.md
git commit -m "docs(cosmo23): first-class-editable doctrine + persistence invariants updated

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Full-suite verification + standalone load test

- [ ] **Step 9.1:**

```bash
npm test 2>&1 | tail -5
```
Expected: pass count ≥ Task 0 baseline + 6 new suites, 0 fail.

- [ ] **Step 9.2: Standalone load test** (sacred rule — proves the load path against a real persisted brain without any engine process). Pick the newest local completed run brain (e.g. from `cosmo23/runs/`, `trail-running` or `labor23`):

```bash
node -e "
const path = require('path');
const dir = process.argv[1];
const { hydrateOrchestratorState } = require('/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/state-hydration');
const { StateCompression } = require('/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/state-compression');
(async () => {
  const state = await StateCompression.loadCompressed(path.join(dir, 'state.json'));
  const report = await hydrateOrchestratorState(dir, state, { logger: console });
  console.log(JSON.stringify({ hydrated: report.hydrated, source: report.source, nodes: report.nodes, edges: report.edges, expectedNodes: report.expectedNodes }));
})().catch(err => { console.error('LOAD TEST FAILED:', err.message); process.exit(1); });
" "$(ls -dt /Users/jtr/_JTR23_/release/home23/cosmo23/runs/*/ | head -1)"
```
Expected: JSON with `nodes` > 0 matching the run's known counts (legacy inline runs report `hydrated:false, source:'inline'` with real node counts — also a pass). LOAD TEST FAILED or `nodes: 0` on a brain known to have nodes = STOP, do not restart anything, investigate.

- [ ] **Step 9.3: Mutation spot-checks** (house style — prove key guards can fail). Three one-line manual mutations, each: apply → run named suite → confirm FAIL → revert:
  1. In `brain-snapshot.js` `evaluateSaveSafety`, change `existingNodes > 100` to `existingNodes > 100000` → `brain-snapshot-guard.test.cjs` must FAIL (drop test).
  2. In `graceful-shutdown-handler.js`, revert the Step-3 condition to unconditional `markCleanShutdown()` → `graceful-shutdown-honesty.test.cjs` must FAIL.
  3. In `state-hydration.js`, change `if (expectedNodes > 0 && loadedNodes === 0)` to `if (false && ...)` → `state-hydration.test.cjs` must FAIL (BRAIN_LOAD_EMPTY tests).
Expected after each revert: suite green again. `git diff --stat` must be empty of mutation leftovers at the end.

---

### Task 10: Live proof — kill -9 mid-run, restart, verify

This is the phase gate. Requires providers configured (they are, on this machine) and cosmo23 idle.

- [ ] **Step 10.1:** Launch a tiny run (5 cycles — models per the managed defaults from Patch 11):

```bash
curl -s -X POST http://localhost:43210/api/launch -H 'content-type: application/json' -d '{
  "topic": "phase1 persistence integrity live proof - cosine similarity overview",
  "explorationMode": "guided",
  "cycles": 5,
  "maxConcurrent": 4,
  "primaryModel": "MiniMax-M3", "primaryProvider": "minimax",
  "fastModel": "nemotron-3-nano:30b", "fastProvider": "ollama-cloud",
  "strategicModel": "kimi-k2.6", "strategicProvider": "ollama-cloud"
}'
```
(If a provider/model pair 4xxes, read `/api/models` and substitute the current managed defaults — the topic and cycle count are what matter.)

- [ ] **Step 10.2:** Wait for ≥2 completed cycles (watch `/api/watch/logs` for `Cycle completed` and at least one `State saved` with `memorySource: 'manifest'`). Record the run dir and its node count from the log line.

- [ ] **Step 10.3: Kill mid-run** (engine child only — NEVER `pm2 kill`, never the cosmo23 server). The engine child's argv is just `node src/index.js` (spawned with cwd `cosmo23/engine` — see `launcher/process-manager.js:279`), so identify it by cwd, verify, THEN kill:

```bash
ENGINE_PID=$(for pid in $(pgrep -x node); do lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | grep -q "cosmo23/engine$" && echo "$pid"; done | head -1)
echo "engine child: ${ENGINE_PID:?no engine child found - STOP}"; ps -p "$ENGINE_PID" -o pid,command
```
Expected: exactly one PID, command `node src/index.js`. If empty or more than one candidate, STOP and identify manually — do not kill on a guess.

```bash
kill -9 "$ENGINE_PID"
```

- [ ] **Step 10.4:** Verify the artifacts of an honest crash: in the run dir — no `.clean_shutdown` marker; `brain-snapshot.json` exists with the recorded node count; `memory-manifest.json` + base sidecars present; `state.json.gz` is a shell (`memory.nodes: []`, `memory.nodeCount` > 0).

- [ ] **Step 10.5: Restart/continue the run.** There is no `/api/continue` — continuation is `POST /api/launch` with `brainId` set to the interrupted run's id (verified: `server/index.js:1955` accepts guided launches with `brainId` in place of `topic`; `resolveCatalogBrainBySelector` resumes the existing brain):

```bash
curl -s -X POST http://localhost:43210/api/launch -H 'content-type: application/json' -d '{
  "brainId": "<run name from Step 10.2>",
  "explorationMode": "guided",
  "cycles": 3,
  "maxConcurrent": 4,
  "primaryModel": "MiniMax-M3", "primaryProvider": "minimax",
  "fastModel": "nemotron-3-nano:30b", "fastProvider": "ollama-cloud",
  "strategicModel": "kimi-k2.6", "strategicProvider": "ollama-cloud"
}'
```
Watch startup logs (`/api/watch/logs`) for, in order: `🔄 Crash detected`, `Checkpoint scalars recovered — loading full brain from state file next` (or the no-checkpoint variant), `🧠 Memory hydrated from manifest sidecars` with nodes matching Step 10.2, and NO `Fresh brain` / NO `BRAIN_LOAD_EMPTY`.

- [ ] **Step 10.6:** Let the run finish its 5 cycles; verify `✅ System stopped successfully`, a final `State saved`, `.clean_shutdown` present (honest: the final save succeeded), and `backups/` containing one `backup-*/` dir with the artifact set.

- [ ] **Step 10.7:** Query the finished brain end-to-end (proves read-side unchanged):

```bash
curl -s http://localhost:43210/api/brains | python3 -m json.tool | grep -A2 "phase1"
```
Expected: the run listed with real node counts.

- [ ] **Step 10.8: Record the receipt** — write `docs/receipts/2026-07-21-cosmo23-phase1-live-proof.md` with: run name, node counts before kill / after restart, the exact log lines proving hydration, and the backup dir listing. Commit:

```bash
git add docs/receipts/2026-07-21-cosmo23-phase1-live-proof.md
git commit -m "docs(cosmo23): phase 1 live proof receipt — kill -9 restart hydrates brain intact

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (tracked elsewhere)

- Home23 donor's broken gzip salvage (`inflateSync` bug) — spawned as its own task chip.
- cosmo23 dashboard shadowed-require TypeError (`/api/operations/force-wake`) — spawned as its own task chip.
- Phases 2–4 of the parity program — each gets its own plan at its phase boundary per the spec.
