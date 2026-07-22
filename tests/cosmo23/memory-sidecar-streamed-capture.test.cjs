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
