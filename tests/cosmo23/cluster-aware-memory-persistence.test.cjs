'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

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
const { ClusterAwareMemory } = require('../../cosmo23/engine/src/cluster/cluster-aware-memory.js');
Module._load = originalLoad;

function createMemory() {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const base = new NetworkMemory({
    embedding: {},
    coordinator: {},
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    smallWorld: { bridgeProbability: 0 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  }, logger);
  base.tokenizer = null;
  base.embed = async () => [0.1, 0.2];
  const cluster = new ClusterAwareMemory(base, {
    logger,
    config: { cluster: { enabled: true } },
    instanceId: 'cosmo-test',
  });
  return { base, cluster, memory: cluster.getInterface() };
}

test('COSMO addNode returns the stored cluster-instrumented identity', async () => {
  const { memory } = createMemory();
  const node = await memory.addNode('durable semantic concept', 'research', [0.1, 0.2]);
  assert.ok(node);
  assert.equal(node, memory.nodes.get(node.id));
});

test('COSMO merged graph import advances persistence generation without outbound echo', async () => {
  const { base, cluster, memory } = createMemory();
  base.importGraphChanges({
    nodes: [
      { id: 1, concept: 'move', cluster: 1 },
      { id: 2, concept: 'delete', cluster: 1 },
    ],
    edges: [{
      source: 1,
      target: 2,
      weight: 0.4,
      type: 'merged',
      created: '2020-01-01T00:00:00.000Z',
      accessed: '2020-01-01T00:00:00.000Z',
    }],
    clusters: [{ id: 1, nodes: [1, 2] }],
  });
  base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
  cluster.attachStateStore({
    async getMergedState() {
      return {
        memory: {
          sets: {
            nodes: [
              { id: 1, concept: 'moved', cluster: 2 },
              { id: 2, concept: 'set loses to tombstone', cluster: 2 },
            ],
            edges: [],
            clusters: [
              { id: 1, nodes: [] },
              { id: 2, nodes: [1, 2] },
            ],
          },
          deletes: { nodeIds: [2], edgeKeys: ['1->2'], clusterIds: [] },
        },
      };
    },
    async submitDiff() {},
  });
  cluster.setClusterEnabled(true);
  cluster.startCycleTracking();
  const stale = base.capturePersistenceSnapshot();

  await cluster.fetchMergedState(1);

  assert.equal(memory.nodes.get(1).cluster, 2);
  assert.equal(memory.clusters.get(1)?.has(1) || false, false);
  assert.equal(memory.clusters.get(2).has(1), true);
  assert.equal(memory.nodes.has(2), false);
  assert.equal(base.deletedNodeIds.has(2), true);
  assert.equal(base.markPersistenceCleanIfGeneration(stale.generation), false);
  assert.equal(cluster.trackedNodes.size, 0);
  assert.equal(cluster.trackedEdges.size, 0);
  assert.equal(cluster.trackedClusters.size, 0);
});

test('COSMO merged string IDs stay exact in outbound cluster diffs', async () => {
  const { base, cluster, memory } = createMemory();
  base.importGraphChanges({
    nodes: [{ id: 'merged-alpha', concept: 'string identity', cluster: null }],
  });
  cluster.attachStateStore({ async submitDiff() {}, async getMergedState() { return null; } });
  cluster.setClusterEnabled(true);
  cluster.startCycleTracking();

  memory.nodes.get('merged-alpha').weight = 0.73;
  const diff = await cluster.getCycleDiff(2);

  assert.ok(diff.fields['memory.node.merged-alpha']);
  assert.equal(diff.fields['memory.node.NaN'], undefined);
});

test('COSMO imported node and edge timestamps remain executable Date values', () => {
  const { base, memory } = createMemory();
  base.importGraphChanges({
    nodes: [
      { id: 1, concept: 'old one', cluster: null, weight: 1, accessed: '2020-01-01T00:00:00.000Z' },
      { id: 2, concept: 'old two', cluster: null, weight: 1, accessed: '2020-01-01T00:00:00.000Z' },
    ],
    edges: [{
      source: 1,
      target: 2,
      weight: 1,
      type: 'merged',
      created: '2020-01-01T00:00:00.000Z',
      accessed: '2020-01-01T00:00:00.000Z',
    }],
  });

  assert.equal(memory.nodes.get(1).accessed instanceof Date, true);
  assert.equal(memory.edges.get('1->2').created instanceof Date, true);
  assert.equal(memory.edges.get('1->2').accessed instanceof Date, true);
});

test('COSMO read-only queries preserve source state while own queries publish access and activation', async () => {
  const { base, memory } = createMemory();
  base.importGraphChanges({
    nodes: [{
      id: 1,
      concept: 'query target',
      embedding: [1, 0],
      activation: 0,
      accessCount: 0,
      weight: 0.5,
      cluster: null,
      created: '2026-07-11T00:00:00.000Z',
      accessed: '2026-07-11T00:00:00.000Z',
    }],
  });
  base.embed = async () => [1, 0];
  base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
  const generation = base.persistenceGeneration;

  const readOnly = await memory.query('target', 1, { accessMode: 'read-only' });
  assert.equal(readOnly.length, 1);
  assert.equal(memory.nodes.get(1).activation, 0);
  assert.equal(memory.nodes.get(1).accessCount, 0);
  assert.equal(base.persistenceGeneration, generation);
  assert.equal(base.dirtyNodeIds.size, 0);

  const own = await memory.query('target', 1, { accessMode: 'own' });
  assert.equal(own.length, 1);
  assert.equal(memory.nodes.get(1).activation, 1);
  assert.equal(memory.nodes.get(1).accessCount, 1);
  assert.equal(memory.nodes.get(1).weight, 0.6);
  assert.ok(base.persistenceGeneration >= generation + 2);
  assert.equal(base.dirtyNodeIds.has(1), true);
});

test('COSMO persistence barrier rejects async callbacks before invocation', () => {
  const { base } = createMemory();
  let invoked = false;
  assert.throws(
    () => base.withPersistenceBarrier(async () => {
      invoked = true;
    }),
    /persistence_barrier_async_callback/,
  );
  assert.equal(invoked, false);
});

test('COSMO accepted graph mutators all invalidate a stale clean generation', async () => {
  const { base } = createMemory();
  const assertInvalidates = async (label, mutate) => {
    base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
    const stale = base.capturePersistenceSnapshot();
    await mutate();
    assert.ok(base.persistenceGeneration > stale.generation, `${label}: generation did not advance`);
    assert.equal(base.markPersistenceCleanIfGeneration(stale.generation), false, `${label}: stale clean succeeded`);
  };

  const first = await base.addNode('durable first semantic concept', 'research', [1, 0]);
  assert.ok(first);
  const second = await base.addNode('durable second semantic concept', 'research', [0, 1]);
  assert.ok(second);

  await assertInvalidates('edge insert', () => base.addEdge(first.id, second.id, 0.2, 'manual'));
  await assertInvalidates('edge remove', () => base.removeEdge(first.id, second.id));
  await assertInvalidates('access update', () => base.recordNodeAccess([first.id]));

  base.importGraphChanges({ nodes: [{ id: 'loose', concept: 'loose node', embedding: [1, 0], cluster: null }] });
  await assertInvalidates('cluster assignment', () => base.assignToCluster('loose'));

  base.importGraphChanges({ nodes: [{ id: 'missing-vector', concept: 'missing vector', cluster: null }] });
  base.embedBatch = async () => [[0.2, 0.8]];
  await assertInvalidates('embedding regeneration', () => base.regenerateMissingEmbeddings());

  const old = '2020-01-01T00:00:00.000Z';
  base.config.hebbian.enabled = true;
  base.config.hebbian.weakenFactor = 0.5;
  base.config.decay.decayInterval = 1;
  base.importGraphChanges({
    nodes: [
      { id: 'decay-a', concept: 'decay a', cluster: null, weight: 1, accessed: old },
      { id: 'decay-b', concept: 'decay b', cluster: null, weight: 1, accessed: old },
    ],
    edges: [{ source: 'decay-a', target: 'decay-b', weight: 1, type: 'manual', accessed: old }],
  });
  await assertInvalidates('node and edge decay', () => base.applyDecay());
  assert.equal(base.nodes.get('decay-a').weight, 0.95);
  assert.equal(base.edges.get('decay-a->decay-b').weight, 0.5);
});
