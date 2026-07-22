'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const Module = require('node:module');

const gunzip = promisify(zlib.gunzip);

// NetworkMemory pulls heavyweight optional deps at require time; stub them
// exactly like tests/cosmo23/cluster-aware-memory-persistence.test.cjs does.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai') return class OpenAI {};
  if (request === 'dotenv') return { config() {} };
  if (request === 'tiktoken') {
    return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator.js');
Module._load = originalLoad;

const {
  persistResearchState,
  hydrateStateMemory,
} = require('../../cosmo23/lib/memory-sidecar');
const {
  resolveKnownGoodNodeCount,
  writeSnapshot,
} = require('../../cosmo23/engine/src/core/brain-snapshot');
const { readManifest } = require('../../shared/memory-source');

const toPlainJson = (value) => JSON.parse(JSON.stringify(value));

async function makeFixture(t) {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-delta-compaction-'));
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fs.mkdir(lockRoot, { recursive: true });
  const runDir = path.join(home23Root, 'brains', 'runs', 'delta-run');
  await fs.mkdir(runDir, { recursive: true });
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  return { home23Root, lockRoot, runDir };
}

function memoryConfig() {
  return {
    embedding: {},
    coordinator: {},
    spreading: {
      maxDepth: 2,
      activationThreshold: 0.01,
      decayFactor: 0.8,
      bridgeTraversalFactor: 0.2,
    },
    smallWorld: {
      bridgeProbability: 0,
      maxBridgesPerNode: 40,
      maxRewireEdgesPerRun: 100,
      rewireYieldEvery: 100,
    },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  };
}

function createLiveMemory() {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const memory = new NetworkMemory(memoryConfig(), logger);
  memory.tokenizer = null;
  memory.embed = async () => { throw new Error('tests must pass explicit embeddings'); };
  return memory;
}

async function seedNodes(memory, count, label = 'seed') {
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index + 1) / (count + 1);
    const node = await memory.addNode(
      `durable ${label} semantic concept ${index + 1}`,
      'research',
      [Math.sin(angle), Math.cos(angle)],
    );
    assert.ok(node, `node ${index + 1} stored`);
    nodes.push(node);
  }
  return nodes;
}

function saveOptions(memory, lockRoot, extra = {}) {
  let savedState = null;
  const options = {
    lockRoot,
    liveMemory: memory,
    deltaCompaction: { enabled: true, minNodes: 1 },
    async saveState(captured) { savedState = captured; return { compressed: false, size: 0 }; },
    ...extra,
  };
  return { options, getSavedState: () => savedState };
}

async function persistOnce(runDir, memory, options, cycle) {
  const state = { cycleCount: cycle, journal: [], memory: memory.exportGraph() };
  return persistResearchState(runDir, state, options);
}

async function readDeltaRecords(runDir, manifest) {
  const text = await fs.readFile(path.join(runDir, manifest.activeDelta.file), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function dirtSize(memory) {
  return memory.dirtyNodeIds.size + memory.dirtyEdgeKeys.size
    + memory.deletedNodeIds.size + memory.deletedEdgeKeys.size;
}

test('gate off: saves stay full-rewrite, result shape and dirty sets untouched', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 4);

  // liveMemory present but NO deltaCompaction config — today's path exactly.
  const first = await persistOnce(runDir, memory, {
    lockRoot,
    liveMemory: memory,
    async saveState() {},
  }, 1);
  assert.equal(first.degraded, false);
  assert.equal('compaction' in first, false, 'gate off adds no compaction key');
  assert.equal('deltaExpected' in first, false, 'gate off adds no deltaExpected key');
  assert.ok(dirtSize(memory) > 0, 'gate off never consumes dirty tracking');
  const firstManifest = await readManifest(runDir);

  const second = await persistOnce(runDir, memory, {
    lockRoot,
    liveMemory: memory,
    async saveState() {},
  }, 2);
  assert.equal('compaction' in second, false);
  const secondManifest = await readManifest(runDir);
  assert.ok(secondManifest.baseRevision > firstManifest.baseRevision, 'second save rewrote the base');
  assert.notEqual(secondManifest.activeBase.nodes.file, firstManifest.activeBase.nodes.file);
  assert.equal(secondManifest.activeDelta.count, 0);

  // enabled but below minNodes threshold — still today's path, no receipt.
  const third = await persistOnce(runDir, memory, {
    lockRoot,
    liveMemory: memory,
    deltaCompaction: { enabled: true, minNodes: 10000 },
    async saveState() {},
  }, 3);
  assert.equal('compaction' in third, false, 'below minNodes stays on the legacy path');
  const thirdManifest = await readManifest(runDir);
  assert.ok(thirdManifest.baseRevision > secondManifest.baseRevision);
});

test('armed: first save rebases, delta save appends tombstoned changes and consumes dirty sets', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  const seeded = await seedNodes(memory, 5);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);
  assert.equal(first.degraded, false);
  assert.equal(first.compaction.mode, 'full');
  assert.equal(first.compaction.reason, 'no_expected_source');
  assert.equal(first.compaction.cleaned, true);
  assert.equal(dirtSize(memory), 0, 'full rewrite consumed the dirty sets');
  assert.equal(typeof first.deltaExpected.generation, 'string');
  assert.match(first.deltaExpected.digest, /^sha256:[a-f0-9]{64}$/);
  const baseManifest = await readManifest(runDir);
  assert.equal(baseManifest.currentRevision, first.revision);

  // Mutate through REAL NetworkMemory methods: add (with metadata that full
  // saves drop), touch, and remove-with-edge-cascade.
  const added = await memory.addNode('durable delta semantic concept', 'research', [0.6, 0.8], { origin: 'test' });
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(added.id, seeded[0].id, 0.7, 'associative', {});
  });
  memory.recordNodeAccess([seeded[1].id]);
  assert.equal(memory.removeNode(seeded[2].id), true);
  assert.ok(memory.deletedNodeIds.has(seeded[2].id));

  const { options: options2, getSavedState } = saveOptions(memory, lockRoot, {
    deltaExpected: first.deltaExpected,
  });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.degraded, false);
  assert.equal(second.compaction.mode, 'delta');
  assert.equal(second.compaction.reason, undefined);
  assert.equal(second.compaction.cleaned, true);
  assert.equal(dirtSize(memory), 0, 'delta append consumed the dirty sets');
  assert.ok(second.compaction.counts.records > 0);
  assert.ok(second.compaction.counts.removedNodes >= 1);

  const manifest = await readManifest(runDir);
  assert.equal(manifest.generation, baseManifest.generation, 'no rebase: same manifest generation');
  assert.equal(manifest.activeBase.nodes.file, baseManifest.activeBase.nodes.file, 'base sidecars untouched');
  assert.equal(manifest.currentRevision, baseManifest.currentRevision + second.compaction.counts.records);
  assert.equal(manifest.activeDelta.count, second.compaction.counts.records);
  assert.equal(manifest.summary.nodeCount, memory.nodes.size);
  assert.equal(manifest.summary.edgeCount, memory.edges.size);

  const records = await readDeltaRecords(runDir, manifest);
  assert.equal(records.length, second.compaction.counts.records);
  for (const record of records) assert.equal(record.epoch, manifest.activeDeltaEpoch);
  const ops = records.map((record) => record.op);
  assert.ok(ops.includes('upsert_node'));
  assert.ok(ops.includes('remove_node'), 'deleted node produced a tombstone record');
  assert.ok(records.some((record) => record.op === 'remove_node' && record.id === seeded[2].id));

  // Projection parity: delta node records carry exactly the exportGraph
  // field set — nothing full saves would have dropped (metadata, summary).
  const addedRecord = records.find((record) => record.op === 'upsert_node' && record.record.id === added.id);
  assert.ok(addedRecord);
  const exported = toPlainJson(memory.exportGraph().nodes.find((node) => node.id === added.id));
  assert.deepEqual(
    Object.keys(addedRecord.record).sort(),
    Object.keys(exported).sort(),
    'delta record fields match the exportGraph projection',
  );
  assert.equal('metadata' in addedRecord.record, false);

  // The shell still carries authoritative counts + the new revision.
  const shell = getSavedState();
  assert.equal(shell.memorySource, 'manifest');
  assert.equal(shell.memorySourceRevision, manifest.currentRevision);
  assert.equal(shell.memory.nodeCount, memory.nodes.size);
  assert.deepEqual(shell.memory.nodes, []);

  // deltaExpected advanced to the appended revision.
  assert.equal(second.deltaExpected.generation, manifest.generation);
  assert.equal(second.deltaExpected.revision, manifest.currentRevision);
});

test('hydration replays the delta chain with no read-side change', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  const seeded = await seedNodes(memory, 4);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);

  const added = await memory.addNode('durable hydration semantic concept', 'research', [0.6, 0.8]);
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(added.id, seeded[0].id, 0.9, 'associative', {});
  });
  assert.equal(memory.removeNode(seeded[3].id), true);

  const { options: options2 } = saveOptions(memory, lockRoot, { deltaExpected: first.deltaExpected });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'delta');

  const hydration = await hydrateStateMemory(runDir, { memory: {} }, { logger: { warn() {} } });
  assert.equal(hydration.hydrated, true);
  assert.equal(hydration.source, 'manifest');

  const live = toPlainJson(memory.exportGraph());
  // The shared reader has always normalized node ids to strings on yield
  // (pre-existing manifest-v1 behavior, identical on the gate-off path);
  // per lib/CLAUDE.md doctrine comparisons use String(id).
  const normalizeId = (node) => ({ ...node, id: String(node.id) });
  const hydratedNodes = new Map(hydration.state.memory.nodes.map((node) => [String(node.id), normalizeId(node)]));
  assert.equal(hydratedNodes.size, live.nodes.length, 'hydrated node count matches live graph');
  for (const node of live.nodes) {
    assert.deepEqual(hydratedNodes.get(String(node.id)), normalizeId(node), `node ${node.id} round-tripped`);
  }
  assert.equal(hydratedNodes.has(String(seeded[3].id)), false, 'removed node stays removed after replay');
  const edgeKey = (edge) => [String(edge.source), String(edge.target)].sort().join('->');
  assert.deepEqual(
    hydration.state.memory.edges.map(edgeKey).sort(),
    live.edges.map(edgeKey).sort(),
    'hydrated edges match live graph',
  );
});

test('base older than fullRewriteIntervalMs rebases with a fresh base', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 3);

  const armed = { enabled: true, minNodes: 1, fullRewriteIntervalMs: 1 };
  const { options } = saveOptions(memory, lockRoot, { deltaCompaction: armed });
  const first = await persistOnce(runDir, memory, options, 1);
  const firstManifest = await readManifest(runDir);
  await new Promise((resolve) => setTimeout(resolve, 10));

  await memory.addNode('durable rebase semantic concept', 'research', [0.6, 0.8]);
  const { options: options2 } = saveOptions(memory, lockRoot, {
    deltaCompaction: armed,
    deltaExpected: first.deltaExpected,
  });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'full');
  assert.equal(second.compaction.reason, 'base_overdue');
  assert.equal(second.compaction.cleaned, true);
  assert.equal(dirtSize(memory), 0);

  const manifest = await readManifest(runDir);
  assert.notEqual(manifest.generation, firstManifest.generation, 'rebase minted a new generation');
  assert.notEqual(manifest.activeBase.nodes.file, firstManifest.activeBase.nodes.file);
  assert.equal(manifest.activeDelta.count, 0, 'fresh empty delta chain after rebase');
  assert.equal(manifest.summary.nodeCount, memory.nodes.size);
  const baseWrittenAtMs = Date.parse(manifest.baseWrittenAt);
  assert.ok(Number.isFinite(baseWrittenAtMs), 'rebase stamped baseWrittenAt');
});

test('stale expected lineage forces a full rewrite instead of appending', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 3);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);

  await memory.addNode('durable stale-lineage semantic concept', 'research', [0.6, 0.8]);
  const forged = { ...first.deltaExpected, revision: first.deltaExpected.revision + 1 };
  const { options: options2 } = saveOptions(memory, lockRoot, { deltaExpected: forged });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'full');
  assert.equal(second.compaction.reason, 'expected_source_changed');

  const manifest = await readManifest(runDir);
  assert.equal(manifest.activeDelta.count, 0, 'nothing was appended onto the unproven lineage');
  assert.equal(manifest.summary.nodeCount, memory.nodes.size, 'full rewrite persisted the whole graph');
});

test('clean cycle with no changes reuses the committed manifest untouched', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 3);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);
  const before = await readManifest(runDir);

  const { options: options2, getSavedState } = saveOptions(memory, lockRoot, {
    deltaExpected: first.deltaExpected,
  });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'reused');
  assert.equal(second.revision, first.revision);
  const after = await readManifest(runDir);
  assert.deepEqual(after, before, 'manifest bytes semantically untouched by a no-change save');
  assert.equal(getSavedState().memorySourceRevision, first.revision, 'shell still written');
  assert.deepEqual(second.deltaExpected, first.deltaExpected);
});

test('save guard baseline stays authoritative with deltas on', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 4);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);
  await memory.addNode('durable guard semantic concept', 'research', [0.6, 0.8]);
  const { options: options2 } = saveOptions(memory, lockRoot, { deltaExpected: first.deltaExpected });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'delta');

  // No brain-snapshot.json here → the manifest tier resolves, and its
  // summary includes the delta-appended node (never a base-only count).
  const statePath = path.join(runDir, 'state.json');
  const resolved = await resolveKnownGoodNodeCount(runDir, statePath);
  assert.equal(resolved.source, 'memory-manifest');
  assert.equal(resolved.count, memory.nodes.size);

  // The snapshot tier still outranks the manifest when present.
  assert.equal(writeSnapshot(runDir, { nodes: 2, edges: 1, savedAt: new Date().toISOString() }), true);
  const snapshotResolved = await resolveKnownGoodNodeCount(runDir, statePath);
  assert.equal(snapshotResolved.source, 'snapshot');
  assert.equal(snapshotResolved.count, 2);
});

test('orchestrator saveState wires the gate end-to-end and ledgers compaction events', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 4);
  const events = [];
  const logs = [];
  const noopLogger = {
    info(message, fields) { logs.push({ level: 'info', message, fields }); },
    warn(message, fields) { logs.push({ level: 'warn', message, fields }); },
    error(message, fields) { logs.push({ level: 'error', message, fields }); },
  };
  const fake = {
    evaluation: null,
    cycleCount: 1,
    journal: [],
    memory,
    goals: { export: () => [], goals: new Map(), completedGoals: [] },
    roles: { getRoles: () => [] },
    reflection: { export: () => ({}) },
    oscillator: { getStats: () => ({}) },
    stateModulator: { getState: () => ({}) },
    temporal: null,
    coordinator: null,
    agentExecutor: null,
    forkSystem: null,
    topicQueue: null,
    goalCurator: null,
    executiveRing: null,
    guidedMissionPlan: null,
    completionTracker: null,
    planProgressEvents: [],
    lastSummarization: 0,
    reasoningHistory: [],
    webSearchCount: 0,
    goalAllocator: null,
    clusterSync: null,
    clusterCoordinator: null,
    sessionNumber: 0,
    logsDir: runDir,
    logger: noopLogger,
    eventLedger: { log(name, fields) { events.push({ name, fields }); } },
    config: {
      memorySource: { lockRoot },
      memory: { deltaCompaction: { enabled: true, minNodes: 1 } },
    },
    generateSessionSummary: () => ({ cycleCount: 1 }),
    getProgressMarkers: () => [],
    writeProgressFile: async () => {},
  };
  Object.setPrototypeOf(fake, Orchestrator.prototype);

  const firstResult = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(firstResult.saved, true, JSON.stringify(logs.filter((l) => l.level === 'error')));
  assert.ok(fake._memoryDeltaExpected, 'manifest lineage stashed for the next save');
  const firstEvent = events.find((event) => event.name === 'memory_delta_compaction');
  assert.ok(firstEvent, 'compaction outcome ledgered');
  assert.equal(firstEvent.fields.mode, 'full');
  assert.equal(firstEvent.fields.reason, 'no_expected_source');

  await memory.addNode('durable orchestrator semantic concept', 'research', [0.6, 0.8]);
  fake.cycleCount = 2;
  events.length = 0;
  const secondResult = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(secondResult.saved, true);
  const secondEvent = events.find((event) => event.name === 'memory_delta_compaction');
  assert.equal(secondEvent.fields.mode, 'delta');
  assert.equal(secondEvent.fields.reason, null);
  assert.ok(secondEvent.fields.records > 0);
  const manifest = await readManifest(runDir);
  assert.equal(fake._memoryDeltaExpected.revision, manifest.currentRevision);
  assert.equal(manifest.summary.nodeCount, memory.nodes.size);
  await fake._backupPromise;
});

