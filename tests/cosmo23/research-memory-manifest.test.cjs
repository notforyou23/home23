'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);

const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');
const { MergeEngine } = require('../../cosmo23/engine/src/merge/merge-engine');
const {
  persistResearchState,
} = require('../../cosmo23/lib/memory-sidecar');

async function makeFixture(t) {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-research-manifest-'));
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fs.mkdir(lockRoot, { recursive: true });
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  return { home23Root, lockRoot };
}

function memoryGraph(label = 'normal', count = 3) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `${label}-n${index + 1}`,
    concept: `${label} concept ${index + 1}`,
    tag: index % 2 ? 'finding' : 'research',
    embedding: [index / 10, 1 - (index / 10)],
    weight: 1,
  }));
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      source: nodes[index].id,
      target: node.id,
      weight: 0.75,
      type: 'related',
    })),
    clusters: [{ id: `${label}-c1`, size: nodes.length, nodes: nodes.map(({ id }) => id) }],
    nextNodeId: count + 1,
    nextClusterId: 2,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readCompressedState(runDir) {
  const bytes = await fs.readFile(path.join(runDir, 'state.json.gz'));
  return JSON.parse((await gunzip(bytes)).toString('utf8'));
}

async function readJsonlGz(file) {
  const bytes = await fs.readFile(file);
  const text = (await gunzip(bytes)).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function assertManifestGeneration(runDir, expected) {
  const manifest = await readJson(path.join(runDir, 'memory-manifest.json'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(Number.isSafeInteger(manifest.baseRevision), true);
  assert.equal(Number.isSafeInteger(manifest.currentRevision), true);
  assert.equal(manifest.baseRevision > 0, true);
  assert.equal(manifest.currentRevision, manifest.baseRevision);
  assert.equal(manifest.activeDelta.fromRevision, manifest.currentRevision + 1);
  assert.equal(manifest.activeDelta.toRevision, manifest.currentRevision);
  assert.equal(manifest.activeDelta.count, 0);
  assert.equal(manifest.activeDelta.committedBytes, 0);
  assert.deepEqual(manifest.summary, {
    nodeCount: expected.nodes.length,
    edgeCount: expected.edges.length,
    clusterCount: expected.clusters.length,
  });

  assert.match(manifest.activeBase.nodes.file, /^memory-nodes\.base-[1-9][0-9]*\.jsonl\.gz$/);
  assert.match(manifest.activeBase.edges.file, /^memory-edges\.base-[1-9][0-9]*\.jsonl\.gz$/);
  assert.match(manifest.activeDelta.file, /^memory-delta\.e-[1-9][0-9]*-.+\.jsonl$/);
  assert.deepEqual(
    await readJsonlGz(path.join(runDir, manifest.activeBase.nodes.file)),
    expected.nodes,
  );
  assert.deepEqual(
    await readJsonlGz(path.join(runDir, manifest.activeBase.edges.file)),
    expected.edges,
  );
  assert.equal((await fs.stat(path.join(runDir, manifest.activeDelta.file))).size, 0);
  return manifest;
}

function assertEmptyMemoryShell(state, graph, manifest) {
  assert.deepEqual(state.memory.nodes, []);
  assert.deepEqual(state.memory.edges, []);
  assert.deepEqual(state.memory.clusters, []);
  assert.equal(state.memory.nodeCount, graph.nodes.length);
  assert.equal(state.memory.edgeCount, graph.edges.length);
  assert.equal(state.memory.clusterCount, graph.clusters.length);
  assert.equal(state.memory.nextNodeId, graph.nextNodeId);
  assert.equal(state.memory.nextClusterId, graph.nextClusterId);
  assert.equal(state.memorySource, 'manifest');
  assert.equal(state.memorySourceRevision, manifest.currentRevision);
  assert.equal(state.memorySourceEvidence.sourceHealth, 'healthy');
  assert.equal(state.memorySourceEvidence.baseWatermark.revision, manifest.baseRevision);
  assert.equal(state.memorySourceEvidence.deltaWatermark.revision, manifest.currentRevision);
  assert.deepEqual(state.memorySourceEvidence.authoritativeTotals, {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  });
  assert.equal(state.memorySourceEvidence.completeCoverage, true);
}

test('normal Orchestrator save publishes a numeric manifest generation before an empty compressed shell', async (t) => {
  const { home23Root, lockRoot } = await makeFixture(t);
  const runDir = path.join(home23Root, 'brains', 'runs', 'normal-run');
  await fs.mkdir(runDir, { recursive: true });
  const graph = memoryGraph('normal', 12);
  const logs = [];
  const noopLogger = {
    info(message, fields) { logs.push({ level: 'info', message, fields }); },
    warn(message, fields) { logs.push({ level: 'warn', message, fields }); },
    error(message, fields) { logs.push({ level: 'error', message, fields }); },
  };
  const fake = {
    evaluation: null,
    cycleCount: 2,
    journal: [],
    memory: { exportGraph: () => graph },
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
    config: { memorySource: { lockRoot } },
    generateSessionSummary: () => ({ cycleCount: 2 }),
    getProgressMarkers: () => [],
    writeProgressFile: async () => {},
  };

  await Orchestrator.prototype.saveState.call(fake);

  assert.equal(logs.some(({ level }) => level === 'error'), false, JSON.stringify(logs));
  const manifest = await assertManifestGeneration(runDir, graph);
  assertEmptyMemoryShell(await readCompressedState(runDir), graph, manifest);
});

test('merged run save publishes a manifest and stores only its captured memory shell', async (t) => {
  const { home23Root, lockRoot } = await makeFixture(t);
  const runsPath = path.join(home23Root, 'brains', 'runs');
  await fs.mkdir(runsPath, { recursive: true });
  const graph = memoryGraph('merged', 5);
  const mergedState = {
    cycleCount: 0,
    memory: graph,
    goals: [],
    thoughtHistory: [],
  };
  const engine = new MergeEngine({ runsPath, memorySourceLockRoot: lockRoot });
  engine.copyWorkArtifacts = async () => ({
    summary: {},
    totals: { fileCount: 0, directoriesCopied: 0, filesCopied: 0, sourcesProcessed: 0 },
  });
  const runDir = await engine.saveMergedRun('merged-run', mergedState, [], {
    memory: { duplicates: 0, confidenceReport: null },
    goals: { duplicates: 0 },
  });

  const manifest = await assertManifestGeneration(runDir, graph);
  assertEmptyMemoryShell(await readCompressedState(runDir), graph, manifest);
  assert.deepEqual(mergedState.memory.nodes, graph.nodes, 'caller-owned merged state remains intact');
});

test('one pre-await capture governs sidecars, evidence, and shell across a blocked writer', async (t) => {
  const { home23Root, lockRoot } = await makeFixture(t);
  const runDir = path.join(home23Root, 'brains', 'runs', 'barrier-run');
  await fs.mkdir(runDir, { recursive: true });
  const graph = memoryGraph('barrier', 2);
  const state = { cycleCount: 4, memory: graph, journal: [] };
  let releaseWriter;
  let writerReached;
  const reached = new Promise((resolve) => { writerReached = resolve; });
  const barrier = new Promise((resolve) => { releaseWriter = resolve; });
  let savedState = null;

  const pending = persistResearchState(runDir, state, {
    lockRoot,
    writerOptions: {
      async beforeLock() {
        writerReached();
        await barrier;
      },
    },
    async saveState(captured) {
      assert.equal(await fs.access(path.join(runDir, 'memory-manifest.json')).then(() => true), true);
      assert.equal(captured.memorySourceEvidence.sourceHealth, 'healthy');
      savedState = captured;
    },
  });

  await reached;
  graph.nodes.push({ id: 'later-node', concept: 'must wait for next save' });
  graph.edges.push({ source: 'barrier-n2', target: 'later-node', weight: 1 });
  graph.clusters[0].nodes.push('later-node');
  graph.clusters[0].size += 1;
  releaseWriter();
  const outcome = await pending;

  assert.equal(outcome.degraded, false);
  const capturedGraph = memoryGraph('barrier', 2);
  const manifest = await assertManifestGeneration(runDir, capturedGraph);
  assertEmptyMemoryShell(savedState, capturedGraph, manifest);
  assert.equal(graph.nodes.length, 3, 'later live mutation remains dirty for the next save');
  assert.equal(graph.edges.length, 2);
});

test('manifest commit failure saves the original full captured graph with degraded diagnostics', async (t) => {
  const { home23Root, lockRoot } = await makeFixture(t);
  const runDir = path.join(home23Root, 'brains', 'runs', 'failed-manifest-run');
  await fs.mkdir(runDir, { recursive: true });
  const graph = memoryGraph('failure', 4);
  const state = { cycleCount: 9, memory: graph, journal: ['recover me'] };
  let savedState = null;

  const outcome = await persistResearchState(runDir, state, {
    lockRoot,
    writerOptions: { faultAt: 'beforeManifestRename' },
    async saveState(captured) { savedState = captured; },
  });

  assert.equal(outcome.degraded, true);
  assert.equal(outcome.manifest, null);
  assert.deepEqual(savedState.memory, graph);
  assert.notEqual(savedState.memory, graph, 'recoverable state is an immutable capture, not the live graph');
  assert.equal(savedState.memorySource, 'inline');
  assert.equal(savedState.memorySourceEvidence.sourceHealth, 'degraded');
  assert.equal(savedState.memorySourceEvidence.freshness, 'unknown');
  assert.match(savedState.memorySourceEvidence.diagnostics[0].message, /injected:beforeManifestRename/);
  await assert.rejects(fs.access(path.join(runDir, 'memory-manifest.json')));
});
