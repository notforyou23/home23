# cosmo23 ingestion pending-queue JSONL confirmation (Patch 67) + cosmo23/engine/src single-string ceilings audit (Fix 3.6)

## Target current state

PATCH 67 VERDICT: fully landed in the current tree — with one real gap (test registration), fixed below.

Verified piece by piece against the claim in docs/design/COSMO23-VENDORED-PATCHES.md ("Patch 67 — ingestion pending queue as JSONL (2026-07-18)"):
1. /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/ingestion/ingestion-manifest.js — queue file is `ingestion-pending.jsonl` (line 28); `_savePending()` (471-489) is an atomic streamed rewrite: tmp + one `fs.writeSync` per item + `fsyncSync` + `renameSync`, tmp unlinked on failure — no whole-queue JSON.stringify anywhere; `_loadPending()` (407-436) reads JSONL first via `_readJsonlSync` (438-469), a chunked 8MB `readSync` loop with carry-across-reads, corrupt lines counted and reported via logger.error (never silently lost); legacy `ingestion-pending.json` migrates once (write jsonl → unlink legacy), unreadable legacy preserved as `.unreadable` (427-431); debounced save at 491-494.
2. document-feeder.js:276 — `_processFile` consults exported `isIngestionInternalFile` (ingestion-manifest.js:499-507) which covers all three internal filenames incl. `ingestion-pending.jsonl`.
3. cosmo23/server/index.js:1793-1838 — `/api/feeder/status` counts queue length by streaming the JSONL (createReadStream, counting byte 10), legacy array fallback for pre-patch runs.
4. Donor parity: /Users/jtr/_JTR23_/release/home23/engine/src/ingestion/ingestion-manifest.js is semantically identical on every pending-queue path (same _pendingPath/_legacyPendingPath at 30-31, same _readJsonlSync at 462, same atomic _savePending at 495-508, same ignore-list at 592-593). Patch 67's queue-only scope exactly matches the donor's 2026-07-17 cure scope — the donor also still writes the manifest as one JSON.stringify (donor line 423-429 ≡ cosmo23 line 399-405), see audit notes.

THE GAP: tests/cosmo23/ingestion-pending-jsonl.test.cjs (5 tests, committed with Patch 67 in d1de65c6) passes 5/5 when run directly, but is registered NOWHERE — not in the package.json `test` chain and not in tests/cosmo23/package-test-registration.test.cjs. It has never run in `npm test`. A pin that never runs is not a pin; registering it (plus the new complementary pin file) is the substantive change of this fix.

AUDIT VERDICT (rest of cosmo23/engine/src, 362 JSON.stringify / 356 JSON.parse call sites swept): exactly ONE genuinely growth-unbounded single-string site remains outside the Phase 1/2/3-owned state/checkpoint/ledger program — cognition/latent-projector.js reads the append-only, never-rotated `training/latent-dataset.jsonl` back as ONE utf-8 string on EVERY cycle (shouldAutoTrain, called from orchestrator.js:3646 inside the cycle loop; second site in the autoTrain close-handler). The dataset gains one line per cycle (full latent vector per entry, orchestrator.js:8107-8119), so this is quadratic I/O over run life and hits the ~536MB ceiling with a fail-soft symptom (auto-training silently stops). Minimal streamed-count fix proposed below, validated for exact semantic parity (including ENOENT behavior and torn-tail counting). Everything else classified bounded-by-design, bounded-in-practice metadata, compacted, cluster-only, manual dev tooling that fails closed, or already owned by the Phase 1/2/3 + Fix 3.x (delta compaction) program — full table with file:line and growth analysis in apiNotes.

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register BOTH ingestion pending-queue pin tests in the cosmo23 node:test chain (scripts.test), exactly once each. WARNING: package.json carries foreign uncommitted hunks from other sessions — stage surgically (git add -p), never wholesale. The anchor is mid-way through the single-line `test` script; it occurs exactly once in the file (verified in the current tree). Single spaces between entries; no trailing whitespace involved. Replace the anchor text with the code text.

### Anchor
```
tests/cosmo23/bounded-json.test.cjs tests/cosmo23/state-compression-atomicity.test.cjs
```

### Code
```js
tests/cosmo23/bounded-json.test.cjs tests/cosmo23/ingestion-pending-jsonl.test.cjs tests/cosmo23/ingestion-pending-queue-pin.test.cjs tests/cosmo23/state-compression-atomicity.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Add both ingestion pin tests to the exactly-once registration pin list so the suite enforces their registration forever. WARNING: this file also carries a foreign uncommitted hunk — stage surgically. Anchor line occurs exactly once (4-space indent, no trailing whitespace). Insert the two new lines AFTER the anchor line, same 4-space indent.

### Anchor
```
    'tests/cosmo23/bounded-json.test.cjs',
```

### Code
```js
    'tests/cosmo23/bounded-json.test.cjs',
    'tests/cosmo23/ingestion-pending-jsonl.test.cjs',
    'tests/cosmo23/ingestion-pending-queue-pin.test.cjs',
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/cognition/latent-projector.js

OPTIONAL BUT RECOMMENDED — apply parts 3, 4, 5, 6, 7, 8 together or not at all. Part 3 of 3-5: insert the streamed non-blank line counter `_countDatasetSamples()` immediately BEFORE the shouldAutoTrain jsdoc block. This is the audit's one genuine unbounded-site fix: the latent training dataset is append-only JSONL with no rotation, appended every cycle (orchestrator.js:8118) and re-read as ONE utf-8 string every cycle by shouldAutoTrain (orchestrator.js:3646). Counting semantics are byte-for-byte equivalent to content.split('\n').filter(l => l.trim().length > 0).length for space/tab/CR whitespace (the only whitespace the JSONL writer can produce), verified against 9 fixtures including torn tails, CRLF, and interior blanks; missing file rejects with code ENOENT so both existing catch paths behave identically. No brain save/load path is touched (G1-safe); no config gate needed — zero behavior change, strictly removes the string materialization. Anchor is the full jsdoc + signature (grep-unique in this file, no trailing whitespace). Replace anchor with code (code re-includes the anchor text at the end).

### Anchor
```
  /**
   * Check if auto-training should be triggered
   * Returns true if we have enough new samples since last training
   */
  async shouldAutoTrain() {
```

### Code
```js
  /**
   * Count non-blank dataset lines without materializing the file as one
   * string. The training dataset is append-only JSONL with no rotation, so a
   * whole-file readFile(utf-8) re-introduces V8's ~536MB single-string
   * ceiling (the failure class Patch 67 removed from the ingestion pending
   * queue) and costs O(file) heap on every per-cycle auto-train check.
   * Semantics match content.split('\n').filter(l => l.trim().length > 0):
   * blank/whitespace-only lines are ignored, an unterminated non-blank tail
   * counts as one line, and a missing file rejects with code ENOENT so
   * existing catch paths behave exactly as before.
   */
  _countDatasetSamples() {
    const { createReadStream } = require('fs');
    return new Promise((resolve, reject) => {
      let count = 0;
      let tailHasContent = false;
      const stream = createReadStream(this.datasetPath);
      stream.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i += 1) {
          const byte = chunk[i];
          if (byte === 10) {
            if (tailHasContent) count += 1;
            tailHasContent = false;
          } else if (byte !== 13 && byte !== 32 && byte !== 9) {
            tailHasContent = true;
          }
        }
      });
      stream.on('end', () => resolve(tailHasContent ? count + 1 : count));
      stream.on('error', reject);
    });
  }

  /**
   * Check if auto-training should be triggered
   * Returns true if we have enough new samples since last training
   */
  async shouldAutoTrain() {
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/cognition/latent-projector.js

Part 4 of 3-5: replace the whole-file read in shouldAutoTrain() with the streamed counter. Anchor is unique by its 6-space indentation plus the `const currentCount` line (the near-twin at the second site is 12-space indented and assigns lastTrainingSampleCount). No trailing whitespace on any anchor line. After this edit shouldAutoTrain no longer references `fs` — the removed require was its only use.

### Anchor
```
      const fs = require('fs').promises;
      const content = await fs.readFile(this.datasetPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      const currentCount = lines.length;
```

### Code
```js
      const currentCount = await this._countDatasetSamples();
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/cognition/latent-projector.js

Part 5 of 3-5: replace the second whole-file read (autoTrain close-handler, updates lastTrainingSampleCount after a successful training run). Anchor unique by 12-space indentation + the lastTrainingSampleCount line. No trailing whitespace. The surrounding try/catch already warns on failure — rejection behavior is unchanged.

### Anchor
```
            const fs = require('fs').promises;
            const content = await fs.readFile(this.datasetPath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim().length > 0);
            this.lastTrainingSampleCount = lines.length;
```

### Code
```js
            this.lastTrainingSampleCount = await this._countDatasetSamples();
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/latent-dataset-streamed-count.test.cjs

Part 6 of the latent-projector group: NEW paired pin test (create file with this exact content). Real-behavior via Object.create(LatentProjector.prototype) — no env mutation, no constructor side effects. Pins streamed-vs-legacy counting parity across 7 fixtures, ENOENT quietness, and unchanged shouldAutoTrain threshold behavior. Validated 3/3 green against a scratchpad copy of latent-projector.js with parts 3-5 applied. NOTE: this test FAILS if parts 3-5 are not applied (it calls _countDatasetSamples) — that is intentional; do not register it without them.

### Code
```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LatentProjector } = require('../../cosmo23/engine/src/cognition/latent-projector.js');

// Fix 3.6: the latent training dataset is append-only JSONL (one line per
// cycle, no rotation) and shouldAutoTrain() runs every cycle. Reading the
// whole file back as one utf-8 string re-introduced V8's ~536MB single-string
// ceiling. These pins hold _countDatasetSamples() to the exact legacy
// split('\n').filter(l => l.trim().length > 0) semantics, streamed.

function makeProjector(datasetPath, config = {}) {
  const projector = Object.create(LatentProjector.prototype);
  projector.logger = { info() {}, warn() {}, error() {}, debug() {} };
  projector.config = {
    autoTrain: true,
    autoTrainThreshold: 3,
    autoTrainInterval: 2,
    ...config,
  };
  projector.datasetPath = datasetPath;
  projector.trainingInProgress = false;
  projector.lastTrainingSampleCount = 0;
  return projector;
}

const legacyCount = (content) => content.split('\n').filter((line) => line.trim().length > 0).length;

test('Fix 3.6: streamed sample count matches legacy split/filter semantics exactly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-latent-count-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fixtures = [
    ['empty file', ''],
    ['single entry, trailing newline', '{"cycle":1,"reward":0.5}\n'],
    ['three entries', '{"a":1}\n{"b":2}\n{"c":3}\n'],
    ['torn tail from a crash mid-append', '{"a":1}\n{"b":2}'],
    ['interior blank line', '{"a":1}\n\n{"b":2}\n'],
    ['CRLF endings', '{"a":1}\r\n{"b":2}\r\n'],
    ['whitespace-only lines', '   \n\t\n{"a":1}\n'],
  ];

  for (let i = 0; i < fixtures.length; i += 1) {
    const [name, content] = fixtures[i];
    const datasetPath = path.join(dir, `dataset-${i}.jsonl`);
    fs.writeFileSync(datasetPath, content);
    const projector = makeProjector(datasetPath);
    assert.equal(await projector._countDatasetSamples(), legacyCount(content), name);
  }
});

test('Fix 3.6: a missing dataset rejects with ENOENT so shouldAutoTrain stays quiet', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-latent-enoent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const projector = makeProjector(path.join(dir, 'missing.jsonl'));
  await assert.rejects(projector._countDatasetSamples(), (err) => err.code === 'ENOENT');

  const warnings = [];
  projector.logger = { info() {}, warn: (...args) => warnings.push(args), error() {}, debug() {} };
  assert.equal(await projector.shouldAutoTrain(), false, 'no dataset means no training');
  assert.equal(warnings.length, 0, 'ENOENT is expected on fresh runs — never warned about');
});

test('Fix 3.6: shouldAutoTrain threshold behavior is unchanged through the streamed counter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-latent-threshold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const datasetPath = path.join(dir, 'latent-dataset.jsonl');
  const entry = (i) => `${JSON.stringify({ cycle: i, reward: 0.1, vector: [0.1, 0.2] })}\n`;

  // Below threshold: 2 samples < autoTrainThreshold 3.
  fs.writeFileSync(datasetPath, entry(1) + entry(2));
  const projector = makeProjector(datasetPath);
  assert.equal(await projector.shouldAutoTrain(), false, 'below threshold');

  // At threshold with 3 new samples >= autoTrainInterval 2.
  fs.appendFileSync(datasetPath, entry(3));
  assert.equal(await projector.shouldAutoTrain(), true, 'threshold and interval reached');

  // After training, fewer than autoTrainInterval new samples: quiet again.
  projector.lastTrainingSampleCount = 3;
  fs.appendFileSync(datasetPath, entry(4));
  assert.equal(await projector.shouldAutoTrain(), false, 'only 1 new sample since training');

  assert.equal(await projector.shouldAutoTrain.call(
    { ...projector, config: { ...projector.config, autoTrain: false } },
  ), false, 'autoTrain: false is still an absolute off switch');
});

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Part 7 (latent group registration, package.json). APPLY ONLY AFTER change 1 (its anchor exists only once change 1 has landed) and only together with parts 3-6. Replace anchor with code — inserts the latent test between the queue-pin test and state-compression-atomicity, exactly once.

### Anchor
```
tests/cosmo23/ingestion-pending-queue-pin.test.cjs tests/cosmo23/state-compression-atomicity.test.cjs
```

### Code
```js
tests/cosmo23/ingestion-pending-queue-pin.test.cjs tests/cosmo23/latent-dataset-streamed-count.test.cjs tests/cosmo23/state-compression-atomicity.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Part 8 (latent group registration, pin list). APPLY ONLY AFTER change 2 and only together with parts 3-7. Insert the new line after the anchor line, same 4-space indent.

### Anchor
```
    'tests/cosmo23/ingestion-pending-queue-pin.test.cjs',
```

### Code
```js
    'tests/cosmo23/ingestion-pending-queue-pin.test.cjs',
    'tests/cosmo23/latent-dataset-streamed-count.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/ingestion-pending-queue-pin.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  IngestionManifest,
} = require('../../cosmo23/engine/src/ingestion/ingestion-manifest.js');

// Fix 3.6 (Phase 3): confirmation pins for the Patch 67 pending-queue JSONL
// port, complementing tests/cosmo23/ingestion-pending-jsonl.test.cjs. These
// cover the paths that file does not: the chunked reader's carry across the
// 8MB read-buffer boundary (the actual mechanism that removes V8's ~536MB
// single-string ceiling), preservation of an unreadable legacy queue, the
// real enqueue() upsert + debounced JSONL persistence, and shutdown()
// persisting a queue whose items could not embed — the exact restart window
// where Home23 lost queued chunks on 2026-07-16.

function makeManifest(runPath, overrides = {}) {
  return new IngestionManifest({
    runPath,
    memory: {},
    embeddingFn: async () => null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...overrides,
  });
}

function chunk(index, totalChunks, text) {
  return { index, totalChunks, text, heading: null, depth: 0 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Fix 3.6: a queue item larger than the 8MB read buffer round-trips intact (chunked-reader carry)', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-bigitem-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  // One item whose single JSONL line exceeds _readJsonlSync's 8MB buffer, so
  // loading it MUST exercise the carry-across-reads path. A regression to
  // whole-file readFileSync would still pass small-item tests; this one pins
  // the streaming semantics themselves.
  const bigContent = 'x'.repeat(9 * 1024 * 1024);
  const first = makeManifest(runPath);
  first._pending = [{
    filePath: '/docs/big.md',
    chunkIndex: 0,
    totalChunks: 1,
    content: bigContent,
    hash: 'h-big',
  }];
  first._savePending();

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  const size = fs.statSync(jsonlPath).size;
  assert.ok(size > 8 * 1024 * 1024,
    `fixture must exceed the 8MB read buffer to prove the carry path (size=${size})`);

  const second = makeManifest(runPath);
  assert.equal(second._pending.length, 1, 'the oversized item survives a fresh load');
  assert.equal(second._pending[0].filePath, '/docs/big.md');
  assert.equal(second._pending[0].content.length, bigContent.length, 'content length intact');
  assert.equal(second._pending[0].content, bigContent, 'content bytes intact across the buffer boundary');
});

test('Fix 3.6: an unreadable legacy queue is preserved as .unreadable, never silently dropped', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-unreadable-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  const legacyPath = path.join(runPath, 'ingestion-pending.json');
  const garbage = '{"this is": not valid json [';
  fs.writeFileSync(legacyPath, garbage);

  const errors = [];
  const m = makeManifest(runPath, {
    logger: { info() {}, warn() {}, error: (...args) => errors.push(args), debug() {} },
  });

  assert.equal(m._pending.length, 0, 'no items invented from garbage');
  assert.equal(fs.existsSync(legacyPath), false, 'unreadable legacy file is moved, not left in place');
  const preservedPath = `${legacyPath}.unreadable`;
  assert.ok(fs.existsSync(preservedPath), 'unreadable legacy queue preserved for inspection');
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), garbage, 'preserved bytes are the original bytes');
  assert.ok(errors.length >= 1, 'the failure is reported loudly');
});

test('Fix 3.6: enqueue() upserts per file and the debounced save lands as JSONL on disk', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-upsert-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  const m = makeManifest(runPath);
  await m.enqueue('/docs/report.md', 'docs', 'hash-v1',
    [chunk(0, 2, 'first version chunk 0'), chunk(1, 2, 'first version chunk 1')], []);
  await m.enqueue('/docs/report.md', 'docs', 'hash-v2',
    [chunk(0, 1, 'second version sole chunk')], []);

  assert.equal(m.getStats().pendingCount, 1, 're-enqueue replaces prior chunks for the same file');

  // _debouncedSavePending fires 100ms after the last enqueue.
  await sleep(300);

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  assert.ok(fs.existsSync(jsonlPath), 'debounced save persisted the queue without an explicit flush');
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, 'exactly the upserted item on disk');
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.content, 'second version sole chunk');
  assert.equal(persisted.hash, 'hash-v2', 'the second enqueue won the upsert');
});

test('Fix 3.6: shutdown() persists queued items that could not embed — a restart cannot lose them', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-shutdown-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  // embeddingFn yields null (provider down): flush('shutdown') must keep the
  // items queued and write them to disk instead of dropping them. memory is
  // an empty object on purpose — with zero embeddable items the flush must
  // never touch NetworkMemory at all.
  const m = makeManifest(runPath);
  await m.enqueue('/docs/a.md', 'docs', 'hash-a', [chunk(0, 1, 'alpha content')], []);
  await m.enqueue('/docs/b.md', 'docs', 'hash-b', [chunk(0, 1, 'beta content')], []);
  await m.shutdown();

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  assert.equal(fs.existsSync(`${jsonlPath}.tmp`), false, 'atomic rewrite leaves no tmp file behind');

  const rebooted = makeManifest(runPath);
  assert.equal(rebooted._pending.length, 2, 'both unembeddable items survive the restart');
  assert.deepEqual(
    rebooted._pending.map((p) => p.filePath).sort(),
    ['/docs/a.md', '/docs/b.md'],
  );
});

```

## API NOTES

VALIDATION RECEIPTS (everything applied was reverted byte-exact):
- tests/cosmo23/ingestion-pending-queue-pin.test.cjs (the testFile) was written at its real path, run with `node --test` → 4/4 pass in 565ms, then DELETED — tree restored byte-exact; `git status tests/cosmo23/` afterwards shows only the pre-existing foreign entries. The existing tests/cosmo23/ingestion-pending-jsonl.test.cjs was run in place → 5/5 pass (no changes made to it).
- The three latent-projector.js edits were applied to a SCRATCHPAD COPY only (never the repo file); the paired test (change part 6) ran 3/3 green against that copy, and a 9-fixture + ENOENT parity harness confirmed streamed counting ≡ legacy split/filter semantics. Repo file untouched.
- NO repo file was modified by this session. NEVER git stash was honored. Foreign uncommitted hunks exist in BOTH registration targets (package.json, tests/cosmo23/package-test-registration.test.cjs) and elsewhere (dashboard servers, state-compression, merge-engine, seed.js, home.ts, etc.) — implementer MUST stage surgically.

VERIFY COMMANDS (after applying changes 1-2 + testFile): `node --test tests/cosmo23/ingestion-pending-jsonl.test.cjs tests/cosmo23/ingestion-pending-queue-pin.test.cjs tests/cosmo23/package-test-registration.test.cjs` (expect 5+4 passes + registration pin green). After the latent group (3-8): add `node --test tests/cosmo23/latent-dataset-streamed-count.test.cjs` (3 passes). The cosmo23 block runs with --test-concurrency=1; all new tests use isolated tmpdirs.

FULL AUDIT TABLE — remaining JSON.stringify/JSON.parse sites on cosmo23/engine/src growth-relevant data (file:line → classification → growth analysis). FIXED-HERE: cognition/latent-projector.js:191 and :269 (whole-file utf-8 read of training/latent-dataset.jsonl to count lines; writer orchestrator.js:8118 appends one entry incl. full latent vector per cycle, no rotation; read runs EVERY cycle via orchestrator.js:3646 → quadratic I/O + ~536MB ceiling; fail-soft today: ERR_STRING_TOO_LONG → caught → auto-train silently stops).
OWNED BY PHASE 1/2/3 + Fix 3.x (delta compaction, G3) — no action in 3.6: core/state-compression.js:142-143 (whole-state JSON.stringify pre-gzip) and :286,291,305 (whole-parse post-gunzip) — THE state path; its ceiling answer is the manifest writer + delta chain in cosmo23/shared/memory-source (writer.cjs has zero direct stringify — rides jsonl.cjs) per G3; orchestrator.js:8503→8620 saveState→StateCompression.saveCompressed and :8950 loadCompressed. Checkpoints: core/crash-recovery-manager.js:116 writes SCALARS ONLY — verified in code (orchestrator.js:3672-3683 buildCheckpointState + explicit comment naming the old multi-hundred-MB bug) and pinned by tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs. Ledger: core/event-ledger.js:254 per-line append, :290 createReadStream, :356 whole-read as BUFFER (not string) on a ROTATED (bounded) file — fine.
DEAD-IN-PRODUCTION: memory/network-memory.js:2514 (NetworkMemory.save → whole-graph stringify) and :2639 (load → whole read+parse) have ZERO production callers in engine/src, server, lib, shared — only tests/cosmo23/cluster-aware-memory-persistence.test.cjs exercises them (Phase 3 parity pins). Production graph flow is exportGraph() → StateCompression (only two exportGraph call sites: orchestrator.js:4607 which goes IN-MEMORY to coordinator.conductReview — meta-coordinator stringifies only slices/samples with substring truncation, verified — and :8503 saveState). Do not delete (test-pinned legacy API); do not add callers.
GENUINELY UNBOUNDED BUT DOCUMENTED-ONLY (YAGNI for 3.6, flag for Phase 4): agents/results-queue.js:189 loadQueue whole-reads results-queue JSONL on restart; persistResult/persistIntegrationMarker (:155/:175) append FOREVER — no compaction ever, and loadQueue keeps ALL integrated results in this.history (heap too). Restart-only read, fail-soft (file preserved, queue starts empty = unintegrated results stall). A correct fix needs compact-on-integration (the pattern exists next door in cluster/task-state-queue.js persistQueueSnapshot) + a chunked reader, and it touches integration-marker replay semantics — too big for a verification fix; do NOT bolt on here.
CLUSTER-ONLY (multi-instance mode, off in default cosmo23 runs): cluster/task-state-queue.js:418 whole-read + :385-390 persistQueueSnapshot single-string join of retained events (has compaction, but `retained = processed + queue` — processed retention is the bound to watch); cluster/backends/filesystem-state-store.js:2369 generic KV set() — small coordination values, bounded.
BOUNDED-IN-PRACTICE METADATA (no content payloads; documented, no action): ingestion-manifest.js:401 _saveManifest + :30/:388 whole-load — per-file metadata + nodeIds only (the 221MB Home23 incident was the CONTENT-bearing queue; manifest is ~1-2KB/file, needs ~1M ingested files to matter) and the DONOR (engine/src/ingestion/ingestion-manifest.js:423) has the identical single-string manifest — twin parity intact, widening scope here would diverge from donor; execution/campaign-memory.js:345/356 (~/.cosmo2.3 cross-run patterns — keyed + consolidated with occurrence counters, metadata-scale); execution/tool-registry.js:513/536 (tool cache), skill-registry.js:117/572 (one file per skill), plugin-registry.js:124; artifacts/artifact-registry.js:25/49 (atomic temp+rename, metadata per artifact); cognition/branch-policy.js:58/318 (small policy state); core/telemetry-collector.js:229 (metrics counter map; logs/events are per-line JSONL appends at :202/:214); core/brain-snapshot.js:49 + core/heartbeat.js:37 + core/cycle-watchdog.js:257 (Phase 1/2 scalar sidecars); agents/ide-agent.js:1213 auditLog + document-analysis/specialized-binary registries + actions-queue writes (orchestrator.js:5788/6561/6578, guided-mode-planner.js:2126) — agent/task-scoped or consumed working sets; launcher + run-manager + meta-coordinator manifests/reports — one-shot or per-deliverable metadata.
WRITE-SIDE JSONL APPENDS (line-scale, no read-back found in engine/src; safe): orchestrator.js:4580 decisions, :8380 dreams.jsonl, :8421 voice.jsonl, meta-coordinator.js:492 per-agent findings.jsonl (dashboard reads per-agent files at dashboard/server.js:3029/3036 — bounded per agent).
MANUAL DEV TOOLS, LEGACY PATHS, FAIL-CLOSED (document only; do NOT run against modern brains): tools/cleanup-memory.js:20/91 and tools/inspector.js:21 — hardcoded engine/runtime/state.json (pre-gz legacy location), whole read→rewrite; on a ceiling-sized file the READ throws before any write (fail-closed, no corruption window), and modern brains live at runs/<name>/state.json.gz + manifest sidecars which these tools cannot see. Candidates for deletion or StateCompression routing in a hygiene pass, not 3.6.
OUT OF STATED SCOPE, NOTED: cosmo23/engine/scripts/train-latent-projector.js:53 whole-reads the same latent dataset (fail-soft: training exits nonzero, logged); dashboard/server.js:5179 queries.jsonl whole-read per HTTP request (slow growth — one line per user query) and its legacy twin server-before-filesystem.js (both files carry foreign uncommitted hunks — do not touch in this fix); orchestrator this.voiceLog (:8416) is an uncapped in-memory array — heap growth, not a string ceiling.
GATE NOTES (G1-G4): nothing here touches saveState/loadState, decay, or protected execution_result/execution_failure nodes; no destructive hygiene actions are introduced (registration + a read-path counter swap + tests only), so no config gates or ledger events are required; fresh runs and production brains are bit-for-bit unaffected — the latent change alters only HOW a line count is computed, pinned by parity tests. If the latent group is skipped, changes 1-2 + testFile stand alone and complete Fix 3.6's confirmation mandate.
