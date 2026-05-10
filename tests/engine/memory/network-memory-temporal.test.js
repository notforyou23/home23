import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');

function makeMemory() {
  const memory = new NetworkMemory({
    embedding: { model: 'test', dimensions: 2 },
    decay: { minimumWeight: 0.1 },
    hebbian: { reinforcementStrength: 0.1 },
    spreading: { bridgeTraversalFactor: 0.2 },
    retrieval: { temporalHalfLifeDays: 14 },
    coordinator: {},
  }, {
    info() {},
    warn() {},
    debug() {},
    error() {},
  });
  memory.embed = async () => [1, 0];
  return memory;
}

function makeRewireMemory() {
  const memory = makeMemory();
  memory.config.smallWorld = {
    ...(memory.config.smallWorld || {}),
    maxRewireEdgesPerRun: 3,
    rewireYieldEvery: 1,
    maxBridgesPerNode: 40,
  };
  for (let id = 1; id <= 30; id++) {
    const cluster = id <= 15 ? 1 : 2;
    memory.nodes.set(id, {
      id,
      concept: `node ${id}`,
      cluster,
      activation: 0,
      created: new Date(),
      accessed: new Date(),
    });
    const set = memory.clusters.get(cluster) || new Set();
    set.add(id);
    memory.clusters.set(cluster, set);
  }
  for (let id = 1; id <= 12; id++) {
    memory.addEdge(id, id + 1, 0.25, 'semantic');
  }
  return memory;
}

test('query boosts current state_snapshot above older cue-matched nodes', async () => {
  const memory = makeMemory();

  const old = await memory.addNode('Health shortcut is dark and the bridge is broken.', 'deep_thought', [1, 0]);
  old.created = new Date(Date.now() - 30 * 86400000);
  old.asserted_at = new Date(Date.now() - 30 * 86400000).toISOString();

  const snapshot = await memory.addNode({
    concept: '[STATE_SNAPSHOT] RECENT.md: health bridge is stale at the Pi/HealthKit source; dashboard is live.',
    tag: 'state_snapshot',
    type: 'state_snapshot',
    tags: ['state_snapshot', 'current_state'],
    asserted_at: new Date().toISOString(),
    asserted_cycle: 6299,
    metadata: { kind: 'state_snapshot', source: 'RECENT.md' },
  }, 'state_snapshot', [1, 0]);

  const results = await memory.query('health bridge dashboard', 2);

  assert.equal(results[0].id, snapshot.id);
  assert.ok(results[0].retrievalScore > results[1].retrievalScore);
  assert.equal(results[0].asserted_cycle, 6299);
});

test('addNode preserves temporal metadata through exportGraph', async () => {
  const memory = makeMemory();
  await memory.addNode({
    concept: 'Goal resolved with visible output.',
    tag: 'goal_resolution',
    type: 'goal_resolution',
    tags: ['goal_resolution', 'completed'],
    asserted_at: '2026-05-01T19:00:00.000Z',
    asserted_cycle: 6300,
    superseded_by: 'node-newer',
    confidence_decay: 0.8,
    status: 'completed',
    metadata: { kind: 'goal_resolution', goalId: 'g1' },
  }, 'goal_resolution', [1, 0]);

  const [node] = memory.exportGraph().nodes;
  assert.equal(node.type, 'goal_resolution');
  assert.deepEqual(node.tags, ['goal_resolution', 'completed']);
  assert.equal(node.asserted_at, '2026-05-01T19:00:00.000Z');
  assert.equal(node.asserted_cycle, 6300);
  assert.equal(node.superseded_by, 'node-newer');
  assert.equal(node.confidence_decay, 0.8);
  assert.equal(node.status, 'completed');
  assert.equal(node.metadata.goalId, 'g1');
});

test('persistence changes capture node, edge, and removal mutations', async () => {
  const memory = makeMemory();
  const first = await memory.addNode('first durable memory', 'test', [1, 0]);
  const second = await memory.addNode('second durable memory', 'test', [1, 0]);
  memory.addEdge(first.id, second.id, 0.25, 'manual');

  const initial = memory.consumePersistenceChanges();
  assert.ok(initial.nodes.some((node) => node.id === first.id));
  assert.ok(initial.nodes.some((node) => node.id === second.id));
  assert.ok(initial.edges.some((edge) => edge.source === first.id || edge.target === first.id));
  assert.equal(memory.hasPersistenceChanges(), false);

  memory.removeNode(first.id);
  const removed = memory.consumePersistenceChanges();
  assert.deepEqual(removed.removedNodeIds, [first.id]);
  assert.ok(removed.removedEdgeKeys.length >= 1);
  assert.equal(memory.hasPersistenceChanges(), false);
});

test('exportPersistenceShell omits full node and edge payloads but keeps graph metadata', async () => {
  const memory = makeMemory();
  const first = await memory.addNode('first durable memory', 'test', [1, 0]);
  const second = await memory.addNode('second durable memory', 'test', [1, 0]);
  memory.addEdge(first.id, second.id, 0.25, 'manual');

  const shell = memory.exportPersistenceShell();

  assert.deepEqual(shell.nodes, []);
  assert.deepEqual(shell.edges, []);
  assert.ok(Array.isArray(shell.clusters));
  assert.equal(shell.nextNodeId, memory.nextNodeId);
  assert.equal(shell.nextClusterId, memory.nextClusterId);
});

test('rewireSmallWorld caps large topology maintenance runs for engine responsiveness', async () => {
  const memory = makeRewireMemory();

  const rewired = await memory.rewireSmallWorld(1);

  assert.ok(rewired <= 3);
});

test('rewireSmallWorld does not scan all bridges for each dream bridge insertion', async () => {
  const memory = makeRewireMemory();
  const originalRandom = Math.random;
  Math.random = () => 0.75;
  memory.enforceBridgeCap = () => {
    throw new Error('rewireSmallWorld should use precomputed bridge counts');
  };

  try {
    const rewired = await memory.rewireSmallWorld(1);

    assert.ok(rewired > 0);
  } finally {
    Math.random = originalRandom;
  }
});
