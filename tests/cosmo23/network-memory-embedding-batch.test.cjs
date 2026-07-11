'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');

function createMemory(getEmbeddingClient) {
  const memory = new NetworkMemory({
    embedding: { model: 'test-embedding', dimensions: 2 },
    smallWorld: {}, spreading: {},
  }, {
    info() {}, warn() {}, debug() {}, error() {},
  }, null, { getEmbeddingClient });
  memory.tokenizer = null;
  return memory;
}

test('COSMO successful batch preserves provider indexes without duplicate fallback calls', async () => {
  const calls = [];
  const memory = createMemory(() => ({
    embeddings: {
      create: async (request) => {
        calls.push(request.input);
        return { data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ] };
      },
    },
  }));

  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b']]);
});

test('COSMO batch retries only missing indexes and keeps output order', async () => {
  const calls = [];
  const memory = createMemory(() => ({
    embeddings: {
      create: async (request) => {
        calls.push(request.input);
        if (Array.isArray(request.input)) {
          return { data: [{ index: 1, embedding: [0, 1] }] };
        }
        assert.equal(request.input, 'a');
        return { data: [{ index: 0, embedding: [1, 0] }] };
      },
    },
  }));

  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b'], 'a']);
});

test('COSMO read-only query does not mutate access metadata', async () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  memory.embed = async () => [1, 0];
  const accessed = new Date('2026-01-01T00:00:00.000Z');
  memory.nodes.set('n1', {
    id: 'n1', concept: 'canary', embedding: [1, 0], activation: 0,
    weight: 0.2, accessCount: 0, created: accessed, accessed,
  });
  const generation = memory.persistenceGeneration;

  const result = await memory.query('canary', 1, { markAccess: false });

  assert.equal(result.length, 1);
  assert.equal(memory.nodes.get('n1').accessCount, 0);
  assert.equal(memory.nodes.get('n1').accessed, accessed);
  assert.equal(memory.nodes.get('n1').weight, 0.2);
  assert.equal(memory.nodes.get('n1').activation, 0);
  assert.equal(memory.persistenceGeneration, generation);
  assert.deepEqual([...memory.dirtyNodeIds], []);
});

test('COSMO own-brain query publishes activation and access through the persistence CAS', async () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  memory.embed = async () => [1, 0];
  const accessed = new Date('2026-01-01T00:00:00.000Z');
  memory.nodes.set('n1', {
    id: 'n1', concept: 'canary', embedding: [1, 0], activation: 0,
    weight: 0.2, accessCount: 0, created: accessed, accessed,
  });
  const stale = memory.capturePersistenceSnapshot();

  const result = await memory.query('canary', 1);

  assert.equal(result.length, 1);
  assert.equal(memory.nodes.get('n1').activation, 1);
  assert.equal(memory.nodes.get('n1').accessCount, 1);
  assert.ok(Math.abs(memory.nodes.get('n1').weight - 0.3) < Number.EPSILON);
  assert.ok(memory.persistenceGeneration > stale.generation);
  assert.equal(memory.dirtyNodeIds.has('n1'), true);
  assert.equal(memory.markPersistenceCleanIfGeneration(stale.generation), false);
});

test('COSMO persistence snapshots use the immutable full source-truth contract', () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  memory.importGraphChanges({
    nodes: [
      {
        id: 'snapshot-a', concept: 'captured node', embedding: [1, 0], cluster: 4,
        metadata: { nested: { value: 'captured' } },
      },
      { id: 'snapshot-b', concept: 'peer node', embedding: [0, 1], cluster: 4 },
    ],
    edges: [{
      source: 'snapshot-a', target: 'snapshot-b', weight: 0.5, type: 'evidence',
      metadata: { route: 'fixture' },
    }],
    clusters: [{ id: 4, nodes: ['snapshot-a', 'snapshot-b'] }],
  });

  const snapshot = memory.capturePersistenceSnapshot();
  memory.nodes.get('snapshot-a').concept = 'mutated live value';
  memory.nodes.get('snapshot-a').metadata.nested.value = 'mutated live metadata';
  memory.edges.get('snapshot-a->snapshot-b').weight = 0.99;

  assert.deepEqual(Object.keys(snapshot).sort(), ['changes', 'fullView', 'generation', 'summary']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.changes.nodes), true);
  assert.equal(Object.isFrozen(snapshot.fullView.nodes[0].metadata.nested), true);
  assert.deepEqual(snapshot.summary, { nodeCount: 2, edgeCount: 1, clusterCount: 1 });
  assert.equal(snapshot.fullView.nodes.find((node) => node.id === 'snapshot-a').concept, 'captured node');
  assert.equal(
    snapshot.fullView.nodes.find((node) => node.id === 'snapshot-a').metadata.nested.value,
    'captured',
  );
  assert.equal(snapshot.fullView.edges[0].weight, 0.5);
  assert.equal(snapshot.fullView.edges[0].metadata.route, 'fixture');
});

test('COSMO persistence capture rejects accessors without invoking them', () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  let getterCalls = 0;
  const record = { id: 'descriptor-node', concept: 'safe', cluster: null };
  Object.defineProperty(record, 'pluginValue', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    },
  });
  memory.nodes.set(record.id, record);
  memory.dirtyNodeIds.add(record.id);

  assert.throws(
    () => memory.capturePersistenceSnapshot(),
    /persistence_record_accessor_not_allowed/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(memory.persistenceBarrierActive, false);
});

test('COSMO node patches reject structural cluster changes', () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  memory.importGraphChanges({
    nodes: [{ id: 'clustered', concept: 'indexed node', embedding: [1, 0], cluster: 9 }],
    clusters: [{ id: 9, nodes: ['clustered'] }],
  });

  assert.throws(
    () => memory.patchNode('clustered', { cluster: 10 }),
    /node_patch_forbidden_key:cluster/,
  );
  assert.equal(memory.nodes.get('clustered').cluster, 9);
  assert.equal(memory.clusters.get(9).has('clustered'), true);
  assert.equal(memory.clusters.has(10), false);
});

test('COSMO collision-safe reclustering preserves occupied clusters', () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  memory.importGraphChanges({
    nodes: [
      { id: 'occupied', concept: 'existing member', embedding: [1, 0], cluster: 1 },
      { id: 'candidate', concept: 'new member', embedding: [0, 1], cluster: null },
    ],
    clusters: [{ id: 1, nodes: ['occupied'] }],
    nextClusterId: 1,
  });
  memory.nextClusterId = 1;

  const result = memory.applyReclusterPlan({ newClusterGroups: [['candidate']] });

  assert.equal(result.createdClusters, 1);
  assert.deepEqual([...memory.clusters.get(1)], ['occupied']);
  assert.deepEqual([...memory.clusters.get(2)], ['candidate']);
  assert.equal(memory.nextClusterId, 3);
});
