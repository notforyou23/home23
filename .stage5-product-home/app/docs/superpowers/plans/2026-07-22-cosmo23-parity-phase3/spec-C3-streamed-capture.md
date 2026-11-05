# cosmo23 memory persistence — Fix 3.3: streamed state capture in cosmo23/lib/memory-sidecar.js (kill the jsonCapture single-string round-trip)

## Target current state

CURRENT TREE (verified 2026-07-22, /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js, 383 lines, sha256 7b4122f251ff918bb2f588f39ff8afa59659641ad16f4e4db8220a4375e7df2c):

`persistResearchState(runDir, state, options)` (lines 181-233) begins with `captureResearchState(state)` (66-73), which calls `jsonCapture(state)` (27-35): `JSON.stringify` of the ENTIRE state — graph, embeddings, everything — as ONE V8 string (with a typed-array→plain-array replacer), then `JSON.parse`. It then calls `normalizeResearchGraph(captured.memory)` (53-64) which runs `jsonCapture(graph)` AGAIN on the already-copied graph. So every cycle save builds TWO graph-sized strings before the manifest writer ever runs — the exact single-string ceiling the sidecars were built to avoid, surviving at capture time. Only after that does `persistCapturedResearchMemory` (139-164) hand plain arrays to `rewriteMemoryBase`, and the success path passes `memoryShell()` (small) to `options.saveState`.

Callers of persistResearchState: orchestrator `_saveStateUnlocked` (cosmo23/engine/src/core/orchestrator.js:8617 — state.memory is `this.memory.exportGraph()`, already-materialized plain arrays; saveState callback = StateCompression.saveCompressed) and merge-engine `saveMergedRun` (cosmo23/engine/src/merge/merge-engine.js:1974 — plain {nodes,edges,clusters,nextNodeId,nextClusterId}). `persistResearchMemoryRevision` (171-174) shares `normalizeResearchGraph` (single graph-sized string) and is used by brain-backups/state-hydration paths.

Writer reality (shared/memory-source/writer.cjs): `rewriteMemoryBase(brainDir, capturedView, options)` requires `capturedView.nodes`/`edges` to be ARRAYS (`normalizeCapturedView`, 361-377, rejects anything else), deep-clones each record individually via per-row `cloneJson` (`JSON.parse(JSON.stringify(row))` — small strings), and `writeJsonlGzAtomic` (shared/memory-source/jsonl.cjs:1093) serializes per record into a streaming gzip with a 16MB/record cap. The writer never builds a graph-sized string; the capture layer is the only place one exists.

Existing pins that must stay green (tests/cosmo23/research-memory-manifest.test.cjs — NOTE this file carries foreign uncommitted hunks): pre-await capture freeze across a blocked writer, degraded-path `deepEqual(savedState.memory, graph)` + immutable-copy assertion, shell scalar carryover (nextNodeId/nextClusterId), manifest-before-shell ordering. Also tests/cosmo23/state-hydration.test.cjs, brain-backups.test.cjs, merge-engine-state-io.test.cjs (untracked, registered via foreign hunks), memory-sidecar.test.cjs (committed but NOT in the package.json chain — historical), brain-snapshot-guard.test.cjs.

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js

Replace the jsonCapture function with the shared replacer extracted as typedArrayToPlain, plus a new per-record capture helper jsonCaptureRecord. The anchor is the entire current jsonCapture function (lines 27-35), grep-unique, no trailing whitespace. jsonCapture keeps identical semantics for shell-sized captures; jsonCaptureRecord reproduces whole-array JSON.stringify element semantics (undefined/function/symbol slot -> null) at per-record granularity.

### Anchor
```
function jsonCapture(value) {
  const encoded = JSON.stringify(value, (_key, candidate) => (
    ArrayBuffer.isView(candidate) && !(candidate instanceof DataView)
      ? Array.from(candidate)
      : candidate
  ));
  if (encoded === undefined) throw new TypeError('research state must be JSON serializable');
  return JSON.parse(encoded);
}
```

### Code
```js
function typedArrayToPlain(_key, candidate) {
  return ArrayBuffer.isView(candidate) && !(candidate instanceof DataView)
    ? Array.from(candidate)
    : candidate;
}

function jsonCapture(value) {
  const encoded = JSON.stringify(value, typedArrayToPlain);
  if (encoded === undefined) throw new TypeError('research state must be JSON serializable');
  return JSON.parse(encoded);
}

/**
 * Capture ONE record with the exact semantics the legacy whole-graph
 * JSON.stringify round-trip gave array elements: undefined / function /
 * symbol slots become null, typed arrays become plain arrays, toJSON
 * applies, and the result shares no references with the live record.
 * Keeping the round-trip per record bounds peak single-string size by the
 * largest record instead of the whole graph.
 */
function jsonCaptureRecord(record) {
  const encoded = JSON.stringify(record, typedArrayToPlain);
  return encoded === undefined ? null : JSON.parse(encoded);
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js

Replace normalizeResearchGraph and captureResearchState (currently contiguous, lines 53-73) with streamed versions: graph records are captured one at a time (Array.from so sparse holes become null exactly like whole-array stringify), only the scalar shells (graph minus nodes/edges/clusters; state minus memory) round-trip as whole objects. Null placeholders preserve original key order so persisted shells and degraded inline saves serialize byte-identically. Everything stays synchronous (pre-await freeze preserved) and deep-frozen. Anchor is the two current functions verbatim, grep-unique, no trailing whitespace. All other functions in the file (memoryShell, persistCapturedResearchMemory, persistResearchMemoryRevision, persistResearchState, hydration, exports) are UNCHANGED.

### Anchor
```
function normalizeResearchGraph(memory) {
  const graph = typeof memory?.exportGraph === 'function' ? memory.exportGraph() : memory;
  const captured = jsonCapture(graph);
  if (!captured || !Array.isArray(captured.nodes) || !Array.isArray(captured.edges)) {
    throw new TypeError('research memory must contain node and edge arrays');
  }
  if (captured.clusters !== undefined && !Array.isArray(captured.clusters)) {
    throw new TypeError('research memory clusters must be an array when present');
  }
  if (!Array.isArray(captured.clusters)) captured.clusters = [];
  return deepFreeze(captured);
}

function captureResearchState(state) {
  const captured = jsonCapture(state);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new TypeError('research state object required');
  }
  captured.memory = normalizeResearchGraph(captured.memory);
  return deepFreeze(captured);
}
```

### Code
```js
/**
 * Capture a research graph without ever serializing it as ONE string.
 *
 * The legacy implementation JSON.stringify'd the entire graph (nodes +
 * edges + embeddings) as a single V8 string — the exact ceiling the
 * sidecars were built to avoid, surviving at capture time. Records are now
 * round-tripped one at a time (identical normalization semantics) and only
 * the graph's scalar shell is captured whole, so peak single-string size is
 * bounded by the largest record, never the graph.
 *
 * The capture stays fully synchronous and still returns a deep-frozen,
 * plain-JSON copy that shares NO references with the live graph. Passing
 * exportGraph() output through uncopied is not safe: its records share
 * nested references (embeddings) with live nodes, so mutation during async
 * writes would bleed into the committed generation, deepFreeze would freeze
 * live engine internals (Object.freeze throws on a non-empty typed array),
 * and the manifest writer's own per-record clone lacks the typed-array
 * replacer (a Float32Array embedding would corrupt to {"0":...}).
 */
function normalizeResearchGraph(memory) {
  const graph = typeof memory?.exportGraph === 'function' ? memory.exportGraph() : memory;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)
      || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('research memory must contain node and edge arrays');
  }
  if (graph.clusters !== undefined && !Array.isArray(graph.clusters)) {
    throw new TypeError('research memory clusters must be an array when present');
  }
  // Scalar shell first — null placeholders keep the original key order so
  // a degraded inline save serializes byte-identically to the legacy
  // capture — then the three record arrays, one record at a time.
  // Array.from (not .map) so sparse-array holes become null exactly like a
  // whole-array JSON.stringify emitted them.
  const shell = Object.create(null);
  for (const [key, value] of Object.entries(graph)) {
    shell[key] = (key === 'nodes' || key === 'edges' || key === 'clusters') ? null : value;
  }
  const captured = jsonCapture(shell);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new TypeError('research memory must contain node and edge arrays');
  }
  captured.nodes = Array.from(graph.nodes, jsonCaptureRecord);
  captured.edges = Array.from(graph.edges, jsonCaptureRecord);
  captured.clusters = Array.isArray(graph.clusters)
    ? Array.from(graph.clusters, jsonCaptureRecord)
    : [];
  return deepFreeze(captured);
}

/**
 * Capture one research state generation without a full-state stringify.
 * The non-memory fields (cycle counters, journal tail, goal/coordinator
 * exports) are small and still round-trip as one object; the memory graph
 * streams through per-record capture. Peak single-string size during a
 * save is therefore bounded by the SHELL, not the graph.
 */
function captureResearchState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('research state object required');
  }
  // Null placeholder keeps `memory` at its original key position so the
  // persisted shell's key order matches the legacy full capture.
  const rest = Object.create(null);
  for (const [key, value] of Object.entries(state)) {
    rest[key] = key === 'memory' ? null : value;
  }
  const captured = jsonCapture(rest);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new TypeError('research state object required');
  }
  captured.memory = normalizeResearchGraph(state.memory);
  return deepFreeze(captured);
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new suite in the default test chain (scripts.test), inserted immediately after research-memory-manifest. The anchor is a mid-line substring of the long scripts.test value, grep-unique in package.json (verified count 1), single-space separated, no trailing whitespace concerns. WARNING: package.json carries FOREIGN uncommitted hunks (another session registered merge-engine-state-io and possibly more since) — apply this as a surgical string edit against the CURRENT file and stage surgically (git add -p); never wholesale-revert or reformat. If the neighboring entries have changed by implementation time, the invariant is: the exact token `tests/cosmo23/memory-sidecar-streamed-capture.test.cjs` appears EXACTLY ONCE inside the second node --test block (the cosmo23 block), space-separated.

### Anchor
```
tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs
```

### Code
```js
tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/memory-sidecar-streamed-capture.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list, directly under the research-memory-manifest entry (currently line 50). Anchor is that full line including its 4-space indent and trailing comma, grep-unique (verified count 1), no trailing whitespace. WARNING: this file also carries FOREIGN uncommitted hunks — surgical staging only.

### Anchor
```
    'tests/cosmo23/research-memory-manifest.test.cjs',
```

### Code
```js
    'tests/cosmo23/research-memory-manifest.test.cjs',
    'tests/cosmo23/memory-sidecar-streamed-capture.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/memory-sidecar-streamed-capture.test.cjs

```js
'use strict';

// Fix 3.3 — streamed state capture. persistResearchState used to
// JSON.stringify the ENTIRE research state (graph + embeddings) as one V8
// string before committing the manifest — the exact single-string ceiling
// the sidecars were built to avoid, surviving at capture time. These tests
// pin the streamed replacement: peak single-string size during a save is
// bounded by the SHELL (non-memory state) and the largest individual
// record, never the graph; capture semantics (pre-await freeze, typed-array
// normalization, undefined handling, key order, deep-frozen output) are
// byte-identical to the legacy round-trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  persistResearchState,
  persistResearchMemoryRevision,
  hydrateStateMemory,
} = require('../../cosmo23/lib/memory-sidecar');

// Real, spy-free serializer captured before any test installs a spy.
const realStringify = JSON.stringify.bind(JSON);

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-streamed-capture-'));
  const runDir = path.join(root, 'run');
  const lockRoot = path.join(root, 'locks');
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(lockRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runDir, lockRoot };
}

async function readJsonlGz(file) {
  const bytes = await fs.readFile(file);
  const text = zlib.gunzipSync(bytes).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function readManifest(runDir) {
  return JSON.parse(await fs.readFile(path.join(runDir, 'memory-manifest.json'), 'utf8'));
}

function gzipShellSaver(runDir, sink = {}) {
  return async (captured) => {
    sink.state = captured;
    sink.shellJsonLength = realStringify(captured).length;
    await fs.writeFile(
      path.join(runDir, 'state.json.gz'),
      zlib.gzipSync(realStringify(captured)),
    );
    return { compressed: true, size: sink.shellJsonLength };
  };
}

test('a 50k-node save never builds a graph-sized string and round-trips byte-faithfully', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const NODE_COUNT = 50000;
  const nodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
    id: `n${index + 1}`,
    concept: `synthetic streamed capture concept ${index + 1} with a little padding`,
    tag: index % 2 ? 'finding' : 'research',
    weight: 1,
  }));
  const edges = Array.from({ length: NODE_COUNT - 1 }, (_, index) => ({
    source: `n${index + 1}`,
    target: `n${index + 2}`,
    weight: 0.5,
    type: 'related',
  }));
  const graph = { nodes, edges, clusters: [], nextNodeId: NODE_COUNT + 1, nextClusterId: 1 };
  const state = { cycleCount: 3, journal: ['streamed capture'], memory: graph, goals: [] };

  // The whole point: prove the graph is big enough that a single-string
  // capture would be caught by the spy threshold below.
  const graphJsonLength = realStringify(graph).length;
  assert.equal(graphJsonLength > 4 * 1024 * 1024, true,
    `fixture graph must serialize past 4MB (got ${graphJsonLength})`);
  const MAX_SINGLE_STRING = 1024 * 1024;

  const sink = {};
  let maxStringifyLength = 0;
  const original = JSON.stringify;
  JSON.stringify = function spiedStringify(...args) {
    const out = original.apply(JSON, args);
    if (typeof out === 'string' && out.length > maxStringifyLength) {
      maxStringifyLength = out.length;
    }
    return out;
  };
  let outcome;
  try {
    outcome = await persistResearchState(runDir, state, {
      lockRoot,
      saveState: gzipShellSaver(runDir, sink),
    });
  } finally {
    JSON.stringify = original;
  }

  assert.equal(outcome.degraded, false);
  assert.equal(maxStringifyLength < MAX_SINGLE_STRING, true,
    `no JSON.stringify call may approach graph size (max seen ${maxStringifyLength}, graph ${graphJsonLength})`);
  assert.equal(sink.shellJsonLength < 64 * 1024, true,
    `saveState must receive a shell bounded by non-memory state (got ${sink.shellJsonLength})`);
  assert.deepEqual(sink.state.memory.nodes, []);
  assert.deepEqual(sink.state.memory.edges, []);
  assert.equal(sink.state.memory.nodeCount, NODE_COUNT);
  assert.equal(sink.state.memory.edgeCount, NODE_COUNT - 1);
  assert.equal(sink.state.memorySource, 'manifest');

  const manifest = await readManifest(runDir);
  assert.deepEqual(manifest.summary, {
    nodeCount: NODE_COUNT,
    edgeCount: NODE_COUNT - 1,
    clusterCount: 0,
  });

  // Byte-faithful round-trip: hydrate the shell exactly like loadState does
  // (from the durable gz, not the frozen in-memory capture).
  const shell = JSON.parse(zlib.gunzipSync(
    await fs.readFile(path.join(runDir, 'state.json.gz')),
  ).toString('utf8'));
  const report = await hydrateStateMemory(runDir, shell, { logger: { warn() {} } });
  assert.equal(report.hydrated, true);
  assert.equal(report.source, 'manifest');
  assert.equal(report.nodes, NODE_COUNT);
  assert.equal(report.edges, NODE_COUNT - 1);
  assert.deepEqual(shell.memory.nodes, nodes);
  assert.deepEqual(shell.memory.edges, edges);
  for (const index of [0, Math.floor(NODE_COUNT / 2), NODE_COUNT - 1]) {
    assert.equal(realStringify(shell.memory.nodes[index]), realStringify(nodes[index]),
      `node ${index} must round-trip byte-faithfully`);
  }
});

test('per-record capture preserves legacy normalization semantics exactly', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const created = new Date('2026-07-22T12:00:00.000Z');
  const graph = {
    nodes: [
      {
        id: 'typed-1',
        concept: 'typed array embedding',
        embedding: new Float32Array([0.25, 0.5, 1.5]),
        created,
        meta: { deep: { ok: true } },
        ghost: undefined,
      },
      { id: 'plain-2', concept: 'plain embedding', embedding: [0.125, 0.75] },
    ],
    edges: [{ source: 'typed-1', target: 'plain-2', weight: 1, type: 'related' }],
    clusters: [{ id: 1, size: 2, nodes: ['typed-1', 'plain-2'] }],
    nextNodeId: 3,
    nextClusterId: 2,
  };
  const state = { cycleCount: 8, journal: [], memory: graph, goals: [] };

  const sink = {};
  const outcome = await persistResearchState(runDir, state, {
    lockRoot,
    saveState: gzipShellSaver(runDir, sink),
  });
  assert.equal(outcome.degraded, false);

  const manifest = await readManifest(runDir);
  const persistedNodes = await readJsonlGz(path.join(runDir, manifest.activeBase.nodes.file));
  assert.deepEqual(persistedNodes[0], {
    id: 'typed-1',
    concept: 'typed array embedding',
    embedding: [0.25, 0.5, 1.5],
    created: '2026-07-22T12:00:00.000Z',
    meta: { deep: { ok: true } },
  }, 'Float32Array → plain array, Date → ISO string, undefined prop dropped');
  assert.deepEqual(persistedNodes[1], graph.nodes[1]);

  // Shell key order matches the legacy full-state capture: memory stays at
  // its original position, evidence keys append after.
  assert.deepEqual(Object.keys(sink.state), [
    'cycleCount', 'journal', 'memory', 'goals',
    'memorySource', 'memorySourceRevision', 'memorySourceEvidence',
  ]);
  assert.equal(Object.isFrozen(sink.state), true);
  assert.equal(Object.isFrozen(sink.state.memory), true);
  assert.equal(sink.state.memory.nextNodeId, 3);
  assert.equal(sink.state.memory.nextClusterId, 2);

  const shell = JSON.parse(zlib.gunzipSync(
    await fs.readFile(path.join(runDir, 'state.json.gz')),
  ).toString('utf8'));
  const report = await hydrateStateMemory(runDir, shell, { logger: { warn() {} } });
  assert.equal(report.hydrated, true);
  assert.equal(realStringify(shell.memory.nodes), realStringify(persistedNodes),
    'hydrated records must be byte-identical to the persisted capture');
});

test('capture completes before the first await — same-tick mutation cannot bleed in', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const embedding = new Float32Array([0.25, 0.5]);
  const graph = {
    nodes: [{ id: 'a1', concept: 'original concept', embedding, meta: { rev: 1 } }],
    edges: [],
    clusters: [],
    nextNodeId: 2,
    nextClusterId: 1,
  };
  const state = { cycleCount: 1, journal: ['first'], memory: graph };

  const sink = {};
  const pending = persistResearchState(runDir, state, {
    lockRoot,
    saveState: gzipShellSaver(runDir, sink),
  });
  // Same tick, before any await resolves: mutate everything the capture
  // could possibly share with the live state.
  graph.nodes.push({ id: 'late', concept: 'must not persist' });
  graph.nodes[0].concept = 'MUTATED';
  graph.nodes[0].meta.rev = 999;
  embedding[0] = 999;
  state.journal.push('late entry');
  const outcome = await pending;

  assert.equal(outcome.degraded, false);
  const manifest = await readManifest(runDir);
  const persistedNodes = await readJsonlGz(path.join(runDir, manifest.activeBase.nodes.file));
  assert.deepEqual(persistedNodes, [{
    id: 'a1',
    concept: 'original concept',
    embedding: [0.25, 0.5],
    meta: { rev: 1 },
  }]);
  assert.equal(manifest.summary.nodeCount, 1);
  assert.deepEqual(sink.state.journal, ['first']);
  assert.equal(sink.state.memory.nodeCount, 1);
});

test('degraded inline capture keeps legacy array-element semantics and key order', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const graph = {
    nodes: [
      { id: 'k1', concept: 'kept one', embedding: new Float32Array([0.5]) },
      undefined,
      { id: 'k3', concept: 'kept three' },
    ],
    edges: [],
    clusters: [{ id: 1, size: 2, nodes: ['k1', 'k3'] }],
    nextNodeId: 4,
    nextClusterId: 2,
  };
  const state = { cycleCount: 9, journal: ['recover me'], memory: graph };
  let savedState = null;

  const outcome = await persistResearchState(runDir, state, {
    lockRoot,
    writerOptions: { faultAt: 'beforeManifestRename' },
    async saveState(captured) { savedState = captured; },
  });

  assert.equal(outcome.degraded, true);
  assert.equal(outcome.manifest, null);
  // Whole-array JSON.stringify emitted null for undefined slots; per-record
  // capture must do the same.
  assert.deepEqual(savedState.memory.nodes, [
    { id: 'k1', concept: 'kept one', embedding: [0.5] },
    null,
    { id: 'k3', concept: 'kept three' },
  ]);
  // Inline saves serialize the captured memory directly — key order must
  // match the legacy whole-object round-trip (declaration order).
  assert.deepEqual(Object.keys(savedState.memory),
    ['nodes', 'edges', 'clusters', 'nextNodeId', 'nextClusterId']);
  assert.equal(savedState.memorySource, 'inline');
  assert.equal(Object.isFrozen(savedState.memory), true);
  assert.notEqual(savedState.memory, graph, 'inline capture is a copy, never the live graph');
});

test('validation errors match the streamed capture contract', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const saveState = async () => {};

  await assert.rejects(
    persistResearchState(runDir, ['not-a-state'], { lockRoot, saveState }),
    { name: 'TypeError', message: 'research state object required' },
  );
  await assert.rejects(
    persistResearchState(runDir, { cycleCount: 1 }, { lockRoot, saveState }),
    { name: 'TypeError', message: 'research memory must contain node and edge arrays' },
  );
  await assert.rejects(
    persistResearchState(runDir, { memory: { nodes: [], edges: [], clusters: 'nope' } }, { lockRoot, saveState }),
    { name: 'TypeError', message: 'research memory clusters must be an array when present' },
  );
  await assert.rejects(
    persistResearchState(runDir, { memory: 42 }, { lockRoot, saveState }),
    { name: 'TypeError', message: 'research memory must contain node and edge arrays' },
  );
});

test('persistResearchMemoryRevision streams an exportGraph capture with typed arrays normalized', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const live = {
    exportGraph: () => ({
      nodes: [{ id: 'g1', concept: 'from exportGraph', embedding: new Float32Array([0.25, 0.75]) }],
      edges: [],
      clusters: [],
      nextNodeId: 2,
      nextClusterId: 1,
    }),
  };
  const committed = await persistResearchMemoryRevision(runDir, live, { lockRoot });
  assert.equal(Number.isSafeInteger(committed.revision), true);
  const manifest = await readManifest(runDir);
  const persistedNodes = await readJsonlGz(path.join(runDir, manifest.activeBase.nodes.file));
  assert.deepEqual(persistedNodes, [
    { id: 'g1', concept: 'from exportGraph', embedding: [0.25, 0.75] },
  ]);
  assert.equal(Object.isFrozen(committed.capturedMemory), true);
});

```

## API NOTES

WHAT jsonCapture IS FOR (analyzed, all four properties preserved by the streamed design): (1) mutation freeze — the deep copy completes synchronously before persistResearchState's first await, so live mutation during async writes cannot blend generations (pinned by the existing barrier test and my stronger same-tick test); (2) JSON normalization — the typed-array replacer converts Float32Array embeddings to plain arrays (the writer's own per-record cloneJson LACKS this: JSON.stringify(Float32Array) yields {"0":...} objects, silent embedding corruption), Date→toJSON→ISO, undefined object-props dropped / array elements→null; (3) serializability proof before anything is written; (4) deepFreeze safety — freezing must operate on a copy, because deepFreeze of exportGraph() output would freeze live shared sub-objects and Object.freeze THROWS on a non-empty TypedArray. Therefore "pass the materialized export uncopied" was rejected; the chosen design moves the SAME round-trip to per-record granularity. Net cost is strictly lower than before: old = 2 full-graph strings (captureResearchState captured the graph once inside the full-state stringify, then normalizeResearchGraph stringified it AGAIN) + writer per-record clones; new = 1 per-record capture pass + writer per-record clones, zero graph-sized strings.

WRITER API REALITY (read, not assumed): rewriteMemoryBase requires plain ARRAYS (normalizeCapturedView rejects iterators/generators), deep-clones per record, then writeJsonlGzAtomic streams record-by-record through gzip (16MB/record cap, wx tmp + fsync + rename). So "streams" here = per-record captured arrays; no shared/memory-source change needed and none proposed. DONOR (engine/src/core/memory-persistence.js:194-300): captures via memory.capturePersistenceSnapshot()/capturePersistenceChangesSnapshot() and feeds snapshot.fullView.nodes/edges arrays straight to rewriteMemoryBase — never a full-graph string. Donor mismatch per G6: cosmo23's NetworkMemory has NO capturePersistence* surfaces; its materialization is exportGraph() (orchestrator.js:8503 calls it before persistResearchState). cosmo23 NetworkMemory stores embeddings as plain arrays (zero Float32Array hits in network-memory.js), but merged/Home23-origin graphs can carry typed arrays — the replacer defense is kept per record.

PEAK ACCOUNTING: success path (every cycle) max single string = max(non-memory shell, one record) — proven by the spy test (fixture graph >4MB serialized; max observed stringify <1MB with actual values ~KB; saveState shell <64KB). Degraded fallback still builds ONE full inline string inside the caller's StateCompression.saveCompressed (cosmo23/engine/src/core/state-compression.js:141-143) — pre-existing last-resort-vs-data-loss behavior, outside this fix's boundary; capture-side giant strings are eliminated even on that path (was 3 total, now 1, and only when the manifest commit fails).

INTENTIONAL BEHAVIOR DELTAS (degenerate inputs only, none pinned by any existing test — verified by grep): (a) persistResearchState now ACCEPTS state.memory bearing exportGraph() (previously the Map-mangling full-state round-trip guaranteed a TypeError) — aligns with persistResearchMemoryRevision's documented contract; no current caller passes instances. (b) missing/undefined state.memory now throws 'research memory must contain node and edge arrays' instead of 'research state must be JSON serializable'. (c) exotic toJSON-on-root degenerates still throw the same TypeError names (guards on the captured shells retained). Key order of the persisted shell AND degraded inline memory is preserved via null placeholders (pinned by new tests), so valid-input output is bit-for-bit equivalent — which is why this ships UNGATED (G2 gates govern delta compaction/community detection, not this parity refactor). G1: no node deletion/degradation — capture mechanics only; execution_result/execution_failure content flows through unchanged. G3: manifest-before-shell commit order, degrade-to-inline, brain-snapshot stamping, hydration/BRAIN_LOAD_EMPTY all untouched; existing suites pin them. G4: no retroactive sweep — nothing rewrites existing brains; next save simply captures smaller.

VALIDATION RECEIPTS (applied to the repo, tested, then REVERTED BYTE-EXACT — final shasum 7b4122f251ff918bb2f588f39ff8afa59659641ad16f4e4db8220a4375e7df2c matches the pre-change file; validation test file deleted): baseline 48/48 green across research-memory-manifest, state-hydration, brain-backups, merge-engine-state-io, memory-sidecar, brain-snapshot-guard; patched: new suite 6/6 (50k test ~5.6s wall), full regression set green except ONE flake — research-memory-manifest 'normal Orchestrator save' teardown ENOTEMPTY on a lock candidate dir, reproduced at 1/10 on patched AND 1/10 on ORIGINAL bytes with identical signature (fire-and-forget maybeBackupBrain racing the tmpdir rm; pre-existing, background chip filed task_095830f6).

IMPLEMENTER CAUTIONS: package.json and tests/cosmo23/package-test-registration.test.cjs (and research-memory-manifest.test.cjs) carry foreign uncommitted hunks from concurrent sessions — surgical staging (git add -p) only; NEVER git stash in this worktree. tests/cosmo23/memory-sidecar.test.cjs exists committed but is absent from both the package.json chain and the registration list (historical anomaly, hydration-only coverage) — do not confuse it with the new file, and do not "fix" its registration as part of this change. memory-sidecar.js module exports are unchanged (jsonCaptureRecord/typedArrayToPlain stay module-private). No anchor in this proposal contains trailing whitespace; the package.json anchor is a mid-line substring of the scripts.test value.
