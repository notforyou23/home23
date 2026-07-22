'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');
const { hydrateOrchestratorState } = require('../../cosmo23/engine/src/core/state-hydration');
const { persistResearchState } = require('../../cosmo23/lib/memory-sidecar');

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-state-hydration-'));
  const runDir = path.join(root, 'run');
  const lockRoot = path.join(root, 'locks');
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(lockRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runDir, lockRoot };
}

function memoryGraph(count = 3) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    concept: `hydration concept ${index + 1}`,
    tag: index % 2 ? 'finding' : 'research',
    embedding: [index / 10, 1 - (index / 10)],
    weight: 1,
    cluster: 1,
  }));
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      source: nodes[index].id,
      target: node.id,
      weight: 0.75,
      type: 'related',
    })),
    clusters: [{ id: 1, size: nodes.length, nodes: nodes.map(({ id }) => id) }],
    nextNodeId: count + 1,
    nextClusterId: 2,
  };
}

function silentLogger(logs = []) {
  return {
    info(message, fields) { logs.push({ level: 'info', message, fields }); },
    warn(message, fields) { logs.push({ level: 'warn', message, fields }); },
    error(message, fields) { logs.push({ level: 'error', message, fields }); },
  };
}

// Persist through the REAL manifest writer, storing the shell exactly like
// StateCompression.saveCompressed does (gzip JSON at state.json.gz).
async function persistShellState(runDir, lockRoot, state) {
  const statePath = path.join(runDir, 'state.json');
  const outcome = await persistResearchState(runDir, state, {
    lockRoot,
    saveState: async (captured) => {
      await fs.writeFile(`${statePath}.gz`, zlib.gzipSync(JSON.stringify(captured)));
      return { compressed: true, size: 1 };
    },
  });
  assert.equal(outcome.degraded, false, 'fixture manifest commit must succeed');
  return outcome;
}

async function readShellState(runDir) {
  const bytes = await fs.readFile(path.join(runDir, 'state.json.gz'));
  return JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
}

test('hydrates a manifest-backed shell state through the streaming reader', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const graph = memoryGraph(3);
  await persistShellState(runDir, lockRoot, { cycleCount: 5, journal: [], memory: graph });

  const shell = await readShellState(runDir);
  assert.deepEqual(shell.memory.nodes, [], 'fixture must reproduce the empty-shell bug input');
  assert.equal(shell.memorySource, 'manifest');

  const report = await hydrateOrchestratorState(runDir, shell, { logger: silentLogger() });

  assert.equal(report.hydrated, true);
  assert.equal(report.source, 'manifest');
  assert.equal(report.nodes, 3);
  assert.equal(report.edges, 2);
  assert.equal(shell.memorySource, 'manifest');
  assert.deepEqual(shell.memory.nodes.map((node) => node.concept), graph.nodes.map((node) => node.concept));
  // The reader normalizes node ids to strings; edge endpoints must match so
  // the orchestrator's node-existence check keeps every edge.
  const nodeIds = new Set(shell.memory.nodes.map((node) => node.id));
  for (const edge of shell.memory.edges) {
    assert.equal(nodeIds.has(edge.source), true, `edge source ${edge.source} must match a hydrated node id`);
    assert.equal(nodeIds.has(edge.target), true, `edge target ${edge.target} must match a hydrated node id`);
  }
  // Shell scalars survive for the orchestrator's nextNodeId/nextClusterId restore.
  assert.equal(shell.memory.nextNodeId, graph.nextNodeId);
  assert.equal(shell.memory.nextClusterId, graph.nextClusterId);
});

test('throws BRAIN_LOAD_EMPTY when brain-snapshot expects nodes but hydration finds none', async (t) => {
  const { runDir } = await makeFixture(t);
  await fs.writeFile(path.join(runDir, 'brain-snapshot.json'), JSON.stringify({
    nodes: 42,
    edges: 96,
    savedAt: new Date().toISOString(),
    generation: 7,
  }));

  const state = { cycleCount: 9, memory: { nodes: [], edges: [] }, memorySource: 'manifest' };
  await assert.rejects(
    hydrateOrchestratorState(runDir, state, { logger: silentLogger() }),
    /^Error: BRAIN_LOAD_EMPTY: /,
  );
});

test('throws BRAIN_LOAD_EMPTY when manifest totals expect nodes but sidecars are unreadable', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  await persistShellState(runDir, lockRoot, { cycleCount: 2, memory: memoryGraph(4) });

  const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'memory-manifest.json'), 'utf8'));
  assert.equal(manifest.summary.nodeCount, 4);
  await fs.rm(path.join(runDir, manifest.activeBase.nodes.file));

  const shell = await readShellState(runDir);
  const logs = [];
  await assert.rejects(
    hydrateOrchestratorState(runDir, shell, { logger: silentLogger(logs) }),
    /^Error: BRAIN_LOAD_EMPTY: /,
  );
  assert.equal(logs.some(({ level }) => level === 'warn'), true, 'hydration failure must be logged before the guard fires');
});

test('leaves legacy inline states untouched and allows genuinely empty brains', async (t) => {
  const { runDir } = await makeFixture(t);

  const inline = {
    cycleCount: 1,
    memory: {
      nodes: [{ id: 'legacy-1', concept: 'inline legacy node', embedding: [1, 0] }],
      edges: [],
    },
  };
  const inlineReport = await hydrateOrchestratorState(runDir, inline, { logger: silentLogger() });
  assert.equal(inlineReport.hydrated, false);
  assert.equal(inlineReport.source, 'inline');
  assert.equal(inline.memory.nodes[0].id, 'legacy-1');
  assert.equal(inline.memorySource, undefined, 'inline states must not gain a memory source marker');

  const fresh = { cycleCount: 0, memory: { nodes: [], edges: [] } };
  const freshReport = await hydrateOrchestratorState(runDir, fresh, { logger: silentLogger() });
  assert.equal(freshReport.hydrated, false);
  assert.equal(freshReport.nodes, 0, 'a genuinely fresh brain must not trip the guard');
});

test('Orchestrator.loadState imports a hydrated manifest brain with nodes and edges intact', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const graph = memoryGraph(3);
  await persistShellState(runDir, lockRoot, { cycleCount: 11, journal: ['entry'], memory: graph });

  const logs = [];
  const fake = {
    logsDir: runDir,
    logger: silentLogger(logs),
    memory: {
      nodes: new Map(),
      edges: new Map(),
      clusters: new Map(),
      nextNodeId: 1,
      nextClusterId: 1,
      embed: async () => { throw new Error('embed must not be called for embedded fixture nodes'); },
    },
    reflection: { import() {} },
    stateModulator: { state: {} },
    goals: { import() {}, goals: new Map(), completedGoals: [] },
    clusterStateStore: null,
    webSearchCount: 0,
    // loadState fires replayAgentJournals() as a non-blocking recovery pass;
    // the fixture run has no agents dir, so an empty replay is the true result.
    replayAgentJournals: async () => [],
  };

  await Orchestrator.prototype.loadState.call(fake);

  assert.equal(fake.cycleCount, 11);
  assert.equal(fake.memory.nodes.size, 3, 'restart after a manifest-path save must boot the real nodes');
  assert.equal(fake.memory.edges.size, 2, 'hydrated edges must survive the corrupted-edge filter');
  assert.equal(fake.memory.nextNodeId, graph.nextNodeId);
  assert.equal(
    logs.some(({ level }) => level === 'error'),
    false,
    `loadState must not log errors: ${JSON.stringify(logs.filter(({ level }) => level === 'error'))}`,
  );
});

test('Orchestrator.loadState refuses to boot when the snapshot says nodes exist but load is empty', async (t) => {
  const { runDir } = await makeFixture(t);
  await fs.writeFile(path.join(runDir, 'brain-snapshot.json'), JSON.stringify({
    nodes: 500,
    edges: 900,
    savedAt: new Date().toISOString(),
    generation: 12,
  }));
  await fs.writeFile(
    path.join(runDir, 'state.json.gz'),
    zlib.gzipSync(JSON.stringify({
      cycleCount: 40,
      memory: { nodes: [], edges: [], nodeCount: 500, edgeCount: 900 },
      memorySource: 'manifest',
    })),
  );

  const fake = {
    logsDir: runDir,
    logger: silentLogger(),
    memory: {
      nodes: new Map(),
      edges: new Map(),
      clusters: new Map(),
      nextNodeId: 1,
      nextClusterId: 1,
      embed: async () => null,
    },
  };

  await assert.rejects(
    Orchestrator.prototype.loadState.call(fake),
    /BRAIN_LOAD_EMPTY/,
    'loadState must propagate the fail-loud guard instead of booting a fresh brain',
  );
});
