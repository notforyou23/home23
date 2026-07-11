'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const IMPLEMENTATIONS = [
  {
    name: 'root',
    ClusterAwareMemory: require('../../engine/src/cluster/cluster-aware-memory.js')
      .ClusterAwareMemory,
    MemoryDiffMerger: require('../../engine/src/cluster/memory-merger.js').MemoryDiffMerger,
  },
  {
    name: 'COSMO',
    ClusterAwareMemory: require('../../cosmo23/engine/src/cluster/cluster-aware-memory.js')
      .ClusterAwareMemory,
    MemoryDiffMerger: require('../../cosmo23/engine/src/cluster/memory-merger.js')
      .MemoryDiffMerger,
  },
];

function createMemory(ClusterAwareMemory, instanceId) {
  const localMemory = {
    nodes: new Map(),
    edges: new Map(),
    clusters: new Map(),
    importGraphChanges() {},
  };
  const stateStore = {
    async getMergedState() { return null; },
    async submitDiff() {},
  };
  const cluster = new ClusterAwareMemory(localMemory, {
    instanceId,
    stateStore,
    clusterEnabled: true,
    config: { cluster: { enabled: true } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return { cluster, memory: cluster.getInterface() };
}

for (const implementation of IMPLEMENTATIONS) {
  test(`${implementation.name} snapshot and merger preserve exact IDs and enumerable extensions`, async () => {
    const { cluster, memory } = createMemory(
      implementation.ClusterAwareMemory,
      `${implementation.name}-snapshot-source`,
    );
    cluster.startCycleTracking();
    const metadata = { nested: { source: 'fixture' }, confidence: 0.91 };
    memory.nodes.set('001.alpha', {
      id: 'caller-value-must-not-replace-map-identity',
      concept: 'descriptor-safe identity',
      embedding: new Float32Array([1, 0, 0]),
      cluster: 'cluster.alpha',
      tags: ['durable', 'cross-instance'],
      metadata,
      provenance: { sourceClass: 'research', route: 'cluster-sync' },
      status: 'accepted',
      consolidatedAt: '2026-07-11T00:00:00.000Z',
      created: new Date('2026-07-10T00:00:00.000Z'),
      accessed: new Date('2026-07-11T00:00:00.000Z'),
    });
    memory.nodes.set('merged.beta', {
      id: 'merged.beta',
      concept: 'second identity',
      embedding: [0, 1, 0],
      cluster: 'cluster.alpha',
    });
    memory.edges.set('001.alpha->merged.beta', {
      source: '001.alpha',
      target: 'merged.beta',
      weight: 0.6,
      type: 'evidence',
      confidence: 0.87,
      metadata: { source: 'round-trip' },
      created: new Date('2026-07-10T00:00:00.000Z'),
    });
    memory.clusters.set('cluster.alpha', new Set(['001.alpha', 'merged.beta']));

    const diff = await cluster.getCycleDiff(1);
    metadata.nested.source = 'mutated-after-snapshot';
    assert.equal(diff.fields['memory.node.001.alpha'].nodeId, '001.alpha');
    assert.equal(diff.fields['memory.edge.001.alpha->merged.beta'].edgeKey,
      '001.alpha->merged.beta');
    assert.equal(diff.fields['memory.cluster.cluster.alpha'].clusterId, 'cluster.alpha');
    assert.equal(diff.fields['memory.node.001.alpha'].value.metadata.nested.source, 'fixture');

    const merger = new implementation.MemoryDiffMerger({
      info() {}, warn() {}, error() {}, debug() {},
    });
    merger.applyDiff(diff, `${implementation.name}-snapshot-source`);
    const merged = merger.build(1);
    const node = merged.memory.sets.nodes.find((entry) => entry.id === '001.alpha');
    const edge = merged.memory.sets.edges.find(
      (entry) => entry.id === '001.alpha->merged.beta',
    );
    const projectedCluster = merged.memory.sets.clusters.find(
      (entry) => entry.id === 'cluster.alpha',
    );

    assert.ok(node);
    assert.deepEqual(node.embedding, [1, 0, 0]);
    assert.deepEqual(node.tags, ['durable', 'cross-instance']);
    assert.deepEqual(node.metadata, { nested: { source: 'fixture' }, confidence: 0.91 });
    assert.deepEqual(node.provenance, { sourceClass: 'research', route: 'cluster-sync' });
    assert.equal(node.status, 'accepted');
    assert.equal(node.consolidatedAt, '2026-07-11T00:00:00.000Z');
    assert.equal(node.created, '2026-07-10T00:00:00.000Z');
    assert.equal(node.accessed, '2026-07-11T00:00:00.000Z');
    assert.ok(edge);
    assert.deepEqual([edge.source, edge.target], ['001.alpha', 'merged.beta']);
    assert.equal(edge.confidence, 0.87);
    assert.deepEqual(edge.metadata, { source: 'round-trip' });
    assert.deepEqual(projectedCluster, {
      id: 'cluster.alpha',
      nodes: ['001.alpha', 'merged.beta'],
    });

    cluster.startCycleTracking();
    memory.nodes.delete('001.alpha');
    const deleteDiff = await cluster.getCycleDiff(2);
    const deleteMerger = new implementation.MemoryDiffMerger();
    deleteMerger.applyDiff(deleteDiff, `${implementation.name}-snapshot-source`);
    assert.deepEqual(deleteMerger.build(2).memory.deletes.nodeIds, ['001.alpha']);
  });

  test(`${implementation.name} snapshot rejects nested accessors without invoking them`, async () => {
    const { cluster, memory } = createMemory(
      implementation.ClusterAwareMemory,
      `${implementation.name}-accessor-source`,
    );
    cluster.startCycleTracking();
    let getterCalls = 0;
    const metadata = {};
    Object.defineProperty(metadata, 'unsafe', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must not execute';
      },
    });
    memory.nodes.set('accessor.node', {
      id: 'accessor.node',
      concept: 'accessor fixture',
      cluster: null,
      metadata,
    });

    await assert.rejects(
      cluster.getCycleDiff(3),
      (error) => error.message === 'cluster_snapshot_accessor_not_allowed',
    );
    assert.equal(getterCalls, 0);
  });
}
