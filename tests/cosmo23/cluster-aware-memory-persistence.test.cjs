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
const { MemoryDiffMerger } = require('../../cosmo23/engine/src/cluster/memory-merger.js');
const { MemorySummarizer: CosmoMemorySummarizer } = require('../../cosmo23/engine/src/memory/summarizer.js');
const { NetworkMemory: RootNetworkMemory } = require('../../engine/src/memory/network-memory.js');
const { ClusterAwareMemory: RootClusterAwareMemory } = require('../../engine/src/cluster/cluster-aware-memory.js');
const { MemoryDiffMerger: RootMemoryDiffMerger } = require('../../engine/src/cluster/memory-merger.js');
Module._load = originalLoad;

const IMPLEMENTATIONS = [
  {
    name: 'root',
    NetworkMemory: RootNetworkMemory,
    ClusterAwareMemory: RootClusterAwareMemory,
    MemoryDiffMerger: RootMemoryDiffMerger,
  },
  {
    name: 'COSMO',
    NetworkMemory,
    ClusterAwareMemory,
    MemoryDiffMerger,
  },
];

const toPlainJson = (value) => JSON.parse(JSON.stringify(value));

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

function createMemory() {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const base = new NetworkMemory(memoryConfig(), logger);
  base.tokenizer = null;
  base.embed = async () => [0.1, 0.2];
  const cluster = new ClusterAwareMemory(base, {
    logger,
    config: { cluster: { enabled: true } },
    instanceId: 'cosmo-test',
  });
  return { base, cluster, memory: cluster.getInterface() };
}

function createVariantMemory(implementation, instanceId, stateStore = null) {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const base = new implementation.NetworkMemory(memoryConfig(), logger);
  base.tokenizer = null;
  base.embed = async () => [0.1, 0.2, 0.3];
  const cluster = new implementation.ClusterAwareMemory(base, {
    logger,
    config: { cluster: { enabled: Boolean(stateStore) } },
    instanceId,
    stateStore,
    clusterEnabled: Boolean(stateStore),
  });
  return { base, cluster, memory: cluster.getInterface(), logger };
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

for (const implementation of IMPLEMENTATIONS) {
  test(`${implementation.name} string-ID rewiring removes the exact edge and never creates NaN endpoints`, async () => {
    const { base } = createVariantMemory(implementation, `${implementation.name}-rewire`);
    base.importGraphChanges({
      nodes: [
        { id: 'merged-a', concept: 'alpha', embedding: [1, 0, 0], cluster: 1 },
        { id: 'merged-b', concept: 'beta', embedding: [0, 1, 0], cluster: 1 },
        { id: 'merged-c', concept: 'gamma', embedding: [0, 0, 1], cluster: 2 },
      ],
      edges: [{
        source: 'merged-a', target: 'merged-b', weight: 0.4, type: 'associative',
        created: '2026-07-11T00:00:00.000Z', accessed: '2026-07-11T00:00:00.000Z',
      }],
      clusters: [
        { id: 1, nodes: ['merged-a', 'merged-b'] },
        { id: 2, nodes: ['merged-c'] },
      ],
    });
    base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
    const generation = base.persistenceGeneration;
    const originalRandom = Math.random;
    Math.random = () => 0.99;
    try {
      assert.equal(await base.rewireSmallWorld(1), 1);
    } finally {
      Math.random = originalRandom;
    }

    assert.equal(base.edges.has('merged-a->merged-b'), false);
    assert.equal(base.deletedEdgeKeys.has('merged-a->merged-b'), true);
    assert.equal(base.edges.has('merged-a->merged-c'), true);
    assert.deepEqual(
      [base.edges.get('merged-a->merged-c').source, base.edges.get('merged-a->merged-c').target],
      ['merged-a', 'merged-c'],
    );
    assert.equal([...base.edges.keys()].some((key) => key.includes('NaN')), false);
    assert.equal(
      [...base.edges.values()].some((edge) => Number.isNaN(edge.source) || Number.isNaN(edge.target)),
      false,
    );
    assert.ok(base.persistenceGeneration >= generation + 2);
  });

  test(`${implementation.name} missing-cluster index repair invalidates a stale generation`, () => {
    const { base } = createVariantMemory(implementation, `${implementation.name}-cluster-repair`);
    base.importGraphChanges({
      nodes: [
        { id: 'repair-a', concept: 'alpha', embedding: [1, 0, 0], cluster: 7 },
        { id: 'repair-b', concept: 'beta', embedding: [0, 1, 0], cluster: 7 },
      ],
      edges: [{ source: 'repair-a', target: 'repair-b', weight: 0.5, type: 'associative' }],
      clusters: [{ id: 7, nodes: ['repair-a', 'repair-b'] }],
    });
    Map.prototype.delete.call(base.clusters, 7);
    base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
    const staleGeneration = base.persistenceGeneration;

    assert.equal(base.assignToCluster('repair-a'), 7);

    assert.equal(base.clusters.get(7).has('repair-a'), true);
    assert.equal(base.persistenceGeneration, staleGeneration + 1);
    assert.equal(base.dirtyNodeIds.has('repair-a'), true);
    assert.equal(base.markPersistenceCleanIfGeneration(staleGeneration), false);
  });

  test(`${implementation.name} graph import derives allocation floors only from accepted records`, () => {
    const { base } = createVariantMemory(implementation, `${implementation.name}-counter-import`);
    base.nextNodeId = 1;
    base.nextClusterId = 1;
    base.importGraphChanges({
      nodes: [{ id: 50, concept: 'high present identity', embedding: [1, 0, 0], cluster: 20 }],
      clusters: [{ id: 20, nodes: [50] }],
      nextNodeId: 2,
      nextClusterId: 2,
    });
    assert.equal(base.nextNodeId, 51);
    assert.equal(base.nextClusterId, 21);

    base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
    const generation = base.persistenceGeneration;
    const result = base.importGraphChanges({ nextNodeId: 500, nextClusterId: 300 });

    assert.deepEqual(result, {
      importedNodes: 0,
      importedEdges: 0,
      importedClusters: 0,
      removedNodes: 0,
      removedEdges: 0,
      removedClusters: 0,
    });
    assert.equal(base.nextNodeId, 51);
    assert.equal(base.nextClusterId, 21);
    assert.equal(base.persistenceGeneration, generation);
    assert.equal(base.markPersistenceCleanIfGeneration(generation), true);

    const stableGeneration = base.persistenceGeneration;
    base.importGraphChanges({
      nodes: [{ id: 50, concept: 'high present identity', embedding: [1, 0, 0], cluster: 20 }],
      clusters: [{ id: 20, nodes: [50] }],
      nextNodeId: 500,
      nextClusterId: 300,
    });
    assert.equal(base.nextNodeId, 51);
    assert.equal(base.nextClusterId, 21);
    assert.equal(base.persistenceGeneration, stableGeneration);
  });

  test(`${implementation.name} cluster allocation probes only occupied counter collisions`, () => {
    const { base } = createVariantMemory(implementation, `${implementation.name}-cluster-allocation`);
    base.importGraphChanges({
      nodes: [
        { id: 'occupied-low', concept: 'low cluster member', embedding: [1, 0, 0], cluster: 1 },
        { id: 'occupied-high', concept: 'sparse high member', embedding: [0, 1, 0], cluster: 1_000_000 },
        { id: 'candidate', concept: 'new cluster candidate', embedding: [0, 0, 1], cluster: null },
      ],
      clusters: [
        { id: 1, nodes: ['occupied-low'] },
        { id: 1_000_000, nodes: ['occupied-high'] },
      ],
    });
    base.nextClusterId = 1;
    base.clusters.keys = () => {
      throw new Error('cluster allocator must not enumerate sparse keys');
    };

    const result = base.applyReclusterPlan({ newClusterGroups: [['candidate']] });

    assert.deepEqual(result, {
      assignedToExisting: 0,
      createdClusters: 1,
      assignedToNewClusters: 1,
    });
    assert.deepEqual([...base.clusters.get(1)], ['occupied-low']);
    assert.deepEqual([...base.clusters.get(2)], ['candidate']);
    assert.deepEqual([...base.clusters.get(1_000_000)], ['occupied-high']);
    assert.equal(base.nextClusterId, 3);
  });

  test(`${implementation.name} diff-merger-peer round trip preserves string IDs and full record extensions without echo`, async () => {
    let mergedState = null;
    const stateStore = {
      async getMergedState() { return mergedState; },
      async submitDiff() {},
    };
    const source = createVariantMemory(implementation, `${implementation.name}-source`, stateStore);
    const peer = createVariantMemory(implementation, `${implementation.name}-peer`, stateStore);
    source.cluster.startCycleTracking();
    peer.cluster.startCycleTracking();

    source.memory.importGraphChanges({
      nodes: [
        {
          id: 'merged-alpha',
          concept: 'string identity',
          embedding: [1, 0, 0],
          cluster: 'cluster-11',
          tag: 'research',
          tags: ['durable', 'cross-instance'],
          type: 'evidence',
          metadata: { nested: { source: 'fixture' }, confidence: 0.91 },
          provenance: { sourceClass: 'research', route: 'cluster-sync' },
          status: 'accepted',
          consolidatedAt: '2026-07-11T00:00:00.000Z',
          created: '2026-07-10T00:00:00.000Z',
          accessed: '2026-07-11T00:00:00.000Z',
        },
        {
          id: 'merged-beta', concept: 'second identity', embedding: [0, 1, 0], cluster: 'cluster-11',
          created: '2026-07-10T00:00:00.000Z', accessed: '2026-07-11T00:00:00.000Z',
        },
      ],
      edges: [{
        source: 'merged-alpha',
        target: 'merged-beta',
        weight: 0.6,
        type: 'evidence',
        confidence: 0.87,
        metadata: { source: 'round-trip' },
        created: '2026-07-10T00:00:00.000Z',
        accessed: '2026-07-11T00:00:00.000Z',
      }],
      clusters: [{ id: 'cluster-11', nodes: ['merged-alpha', 'merged-beta'] }],
    });
    const diff = await source.cluster.getCycleDiff(1);
    const merger = new implementation.MemoryDiffMerger(source.logger);
    merger.applyDiff(diff, `${implementation.name}-source`);
    mergedState = merger.build(1);

    await peer.cluster.fetchMergedState(1);

    const received = peer.memory.nodes.get('merged-alpha');
    assert.ok(received);
    assert.deepEqual(received.tags, ['durable', 'cross-instance']);
    assert.deepEqual(toPlainJson(received.metadata), { nested: { source: 'fixture' }, confidence: 0.91 });
    assert.deepEqual(toPlainJson(received.provenance), { sourceClass: 'research', route: 'cluster-sync' });
    assert.equal(received.type, 'evidence');
    assert.equal(received.status, 'accepted');
    assert.equal(received.consolidatedAt, '2026-07-11T00:00:00.000Z');
    assert.equal(received.created instanceof Date, true);
    assert.equal(received.accessed instanceof Date, true);
    const receivedEdge = peer.memory.edges.get('merged-alpha->merged-beta');
    assert.ok(receivedEdge);
    assert.deepEqual([receivedEdge.source, receivedEdge.target], ['merged-alpha', 'merged-beta']);
    assert.equal(receivedEdge.confidence, 0.87);
    assert.deepEqual(toPlainJson(receivedEdge.metadata), { source: 'round-trip' });
    assert.equal(peer.cluster.trackedNodes.size, 0);
    assert.equal(peer.cluster.trackedEdges.size, 0);
    assert.equal(peer.cluster.trackedClusters.size, 0);
    assert.equal(peer.cluster.deletedClusters.size, 0);

    source.cluster.startCycleTracking();
    source.memory.removeNode('merged-alpha');
    source.memory.clusters.delete('cluster-11');
    const deleteDiff = await source.cluster.getCycleDiff(2);
    assert.equal(deleteDiff.fields['memory.cluster.cluster-11'].op, 'delete');
    assert.equal(deleteDiff.fields['memory.cluster.cluster-11'].clusterId, 'cluster-11');
    const deleteMerger = new implementation.MemoryDiffMerger(source.logger);
    deleteMerger.applyDiff(deleteDiff, `${implementation.name}-source`);
    mergedState = deleteMerger.build(2);
    peer.cluster.startCycleTracking();

    await peer.cluster.fetchMergedState(2);

    assert.equal(peer.memory.nodes.has('merged-alpha'), false);
    assert.equal(peer.memory.edges.has('merged-alpha->merged-beta'), false);
    assert.equal(peer.memory.clusters.has('cluster-11'), false);
    assert.equal(peer.memory.nodes.get('merged-beta').cluster, null);
    assert.equal(peer.cluster.trackedNodes.size, 0);
    assert.equal(peer.cluster.trackedEdges.size, 0);
    assert.equal(peer.cluster.trackedClusters.size, 0);
    assert.equal(peer.cluster.deletedClusters.size, 0);
  });

  test(`${implementation.name} cluster projection rejects accessors without invoking them`, async () => {
    const stateStore = { async getMergedState() { return null; }, async submitDiff() {} };
    const { cluster, memory } = createVariantMemory(
      implementation,
      `${implementation.name}-descriptor`,
      stateStore,
    );
    cluster.startCycleTracking();
    let getterCalls = 0;
    const record = { id: 'descriptor-node', cluster: null };
    Object.defineProperty(record, 'concept', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'unsafe getter';
      },
    });
    memory.nodes.set('descriptor-node', record);

    await assert.rejects(
      cluster.getCycleDiff(3),
      /cluster_snapshot_accessor_not_allowed/,
    );
    assert.equal(getterCalls, 0);
  });

  test(`${implementation.name} diff merger rejects redirected or non-scalar operation identities`, () => {
    const redirected = new implementation.MemoryDiffMerger({});
    assert.throws(
      () => redirected.applyDiff({
        fields: {
          'memory.node.expected-node': {
            op: 'set',
            nodeId: 'redirected-node',
            value: { id: 'redirected-node', concept: 'forged redirect' },
          },
        },
      }, 'forged-instance'),
      /memory_diff_identity_mismatch/,
    );

    const valueMismatch = new implementation.MemoryDiffMerger({});
    assert.throws(
      () => valueMismatch.applyDiff({
        fields: {
          'memory.edge.expected-a->expected-b': {
            op: 'set',
            edgeKey: 'expected-a->expected-b',
            value: {
              id: 'expected-a->expected-b',
              source: 'other-a',
              target: 'other-b',
            },
          },
        },
      }, 'forged-instance'),
      /memory_diff_identity_mismatch/,
    );

    const invalidShape = new implementation.MemoryDiffMerger({});
    assert.throws(
      () => invalidShape.applyDiff({
        fields: {
          'memory.cluster.cluster-a': {
            op: 'delete',
            clusterId: { forged: true },
          },
        },
      }, 'forged-instance'),
      /memory_diff_identity_invalid/,
    );
  });
}

test('COSMO generated string IDs skip imported occupied suffixes without overwriting', async () => {
  const { base } = createMemory();
  base.nodeIdFormat = 'string';
  base.nodeIdPrefix = 'merged';
  base.nextNodeId = 1;
  base.importGraphChanges({
    nodes: [{
      id: 'merged_1', concept: 'existing imported identity', embedding: [1, 0], cluster: null,
    }],
  });
  base.markPersistenceCleanIfGeneration(base.persistenceGeneration);

  const created = await base.addNode('new collision-safe identity', 'research', [0, 1]);

  assert.equal(created.id, 'merged_2');
  assert.equal(base.nodes.get('merged_1').concept, 'existing imported identity');
  assert.equal(base.nodes.size, 2);
  assert.equal(base.nextNodeId, 3);
});

test('COSMO summarizer consolidation and garbage collection publish through mutation APIs', async () => {
  const { base } = createMemory();
  const sourceNodes = Array.from({ length: 10 }, (_, index) => ({
    id: `summary-source-${index}`,
    concept: `durable source ${index}`,
    embedding: [1, 0],
    cluster: null,
    weight: 1,
    accessed: '2026-07-11T00:00:00.000Z',
  }));
  base.importGraphChanges({ nodes: sourceNodes });
  base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
  const generation = base.persistenceGeneration;
  const summarizer = new CosmoMemorySummarizer({}, {
    info() {}, warn() {}, error() {}, debug() {},
  }, {});
  const cluster = sourceNodes.slice(0, 3).map((node) => base.nodes.get(node.id));
  summarizer.clusterSimilarMemories = async () => [cluster];
  summarizer.createConsolidatedMemoryGPT5 = async () => ({
    content: 'consolidated', reasoning: null, model: 'fixture-model',
  });

  const consolidated = await summarizer.consolidateMemories(base);

  assert.equal(consolidated.length, 1);
  assert.equal(base.persistenceGeneration, generation);
  const summaryNode = await base.addNode(
    consolidated[0].consolidated,
    'consolidated',
    [0.1, 0.2],
  );
  const sourceCommit = summarizer.commitConsolidationSources(
    base,
    consolidated[0],
    summaryNode,
  );
  assert.equal(sourceCommit.committed, true);
  assert.equal(summaryNode.consolidatedAt, consolidated[0].consolidationTimestamp);
  assert.ok(cluster.every((node) => node.consolidatedAt === summaryNode.consolidatedAt));
  assert.ok(base.persistenceGeneration >= generation + cluster.length + 1);
  assert.deepEqual(
    [...base.dirtyNodeIds].sort(),
    [summaryNode.id, ...cluster.map((node) => node.id)].sort(),
  );

  const old = '2020-01-01T00:00:00.000Z';
  base.importGraphChanges({
    nodes: [{
      id: 'garbage-node', concept: 'expired low-value node', embedding: [0, 1],
      cluster: null, weight: 0.001, accessed: old,
    }],
    edges: [{
      source: 'garbage-node', target: 'summary-source-9', weight: 0.4,
      type: 'associative', accessed: old,
    }],
  });
  base.markPersistenceCleanIfGeneration(base.persistenceGeneration);
  const gcGeneration = base.persistenceGeneration;

  assert.equal(summarizer.garbageCollect(base, 0.01, 1), 1);
  assert.equal(base.nodes.has('garbage-node'), false);
  assert.equal(base.edges.has('garbage-node->summary-source-9'), false);
  assert.equal(base.deletedNodeIds.has('garbage-node'), true);
  assert.equal(base.deletedEdgeKeys.has('garbage-node->summary-source-9'), true);
  assert.ok(base.persistenceGeneration >= gcGeneration + 2);
});
