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

  test(`${implementation.name} merger rejects accessor-backed diff structure without invoking getters`, () => {
    const assertRejected = (buildDiff) => {
      let getterCalls = 0;
      const diff = buildDiff(() => {
        getterCalls += 1;
        return {};
      });
      assert.throws(
        () => new implementation.MemoryDiffMerger().applyDiff(diff, 'accessor-instance'),
        /memory_diff_accessor_not_allowed/,
      );
      assert.equal(getterCalls, 0);
    };

    assertRejected((getter) => {
      const diff = {};
      Object.defineProperty(diff, 'fields', { enumerable: true, get: getter });
      return diff;
    });
    assertRejected((getter) => {
      const fields = {};
      Object.defineProperty(fields, 'memory.node.safe', { enumerable: true, get: getter });
      return { fields };
    });
    for (const property of ['op', 'value']) {
      assertRejected((getter) => {
        const operation = {};
        Object.defineProperty(operation, property, { enumerable: true, get: getter });
        return { fields: { 'memory.node.safe': operation } };
      });
    }
    assertRejected((getter) => {
      const value = { id: 'safe' };
      Object.defineProperty(value, 'metadata', { enumerable: true, get: getter });
      return {
        fields: {
          'memory.node.safe': { op: 'set', nodeId: 'safe', value },
        },
      };
    });
  });

  test(`${implementation.name} merger validates every later field before applying any entry`, () => {
    const assertAtomicRejection = (invalidOperation, pattern) => {
      const merger = new implementation.MemoryDiffMerger();
      merger.applyDiff({
        diff_id: 'baseline',
        timestamp: 10,
        fields: {
          'memory.node.stable.string': {
            op: 'set',
            nodeId: 'stable.string',
            value: { id: 'stable.string', concept: 'baseline' },
            versionVector: { source: 1 },
            timestamp: 10,
          },
        },
      }, 'source');
      const before = merger.build(1);

      assert.throws(
        () => merger.applyDiff({
          diff_id: 'must-be-atomic',
          timestamp: 20,
          fields: {
            'memory.node.stable.string': {
              op: 'set',
              nodeId: 'stable.string',
              value: { id: 'stable.string', concept: 'partial update must not land' },
              versionVector: { source: 2 },
              timestamp: 20,
            },
            'memory.node.new.string': {
              op: 'set',
              nodeId: 'new.string',
              value: { id: 'new.string', concept: 'new partial row must not land' },
              versionVector: { source: 2 },
              timestamp: 20,
            },
            'memory.node.later.string': invalidOperation,
          },
        }, 'source'),
        pattern,
      );

      const after = merger.build(2);
      assert.equal(after.diffCount, before.diffCount);
      assert.deepEqual(after.memory, before.memory);
      assert.deepEqual(after.metadata, before.metadata);
    };

    assertAtomicRejection({
      op: 'set',
      nodeId: 'forged.string',
      value: { id: 'later.string', concept: 'forged identity' },
      versionVector: { source: 2 },
      timestamp: 20,
    }, /memory_diff_identity_mismatch/);
    assertAtomicRejection({
      op: 'forged-operation',
      nodeId: 'later.string',
      value: { id: 'later.string', concept: 'invalid operation' },
      versionVector: { source: 2 },
      timestamp: 20,
    }, /memory_diff_operation_invalid/);
    assertAtomicRejection({
      op: 'set',
      nodeId: 'later.string',
      value: { id: 'later.string', concept: 'invalid vector' },
      versionVector: { source: -1 },
      timestamp: 20,
    }, /memory_diff_version_vector_invalid/);
  });

  test(`${implementation.name} merger builds deep-detached nested values`, () => {
    const merger = new implementation.MemoryDiffMerger();
    const metadata = { nested: { source: 'durable' }, tags: ['one', 'two'] };
    Object.defineProperty(metadata, '__proto__', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { polluted: false },
    });
    merger.applyDiff({
      diff_id: 'detached-build',
      timestamp: 30,
      fields: {
        'memory.node.node.string': {
          op: 'set',
          nodeId: 'node.string',
          value: {
            id: 'node.string',
            concept: 'detached node',
            metadata,
          },
          versionVector: { source: 3 },
          timestamp: 30,
        },
        'memory.edge.node.string->peer.string': {
          op: 'set',
          edgeKey: 'node.string->peer.string',
          value: {
            source: 'node.string',
            target: 'peer.string',
            metadata: { nested: { confidence: 0.9 } },
          },
          versionVector: { source: 3 },
          timestamp: 30,
        },
        'memory.cluster.cluster.string': {
          op: 'set',
          clusterId: 'cluster.string',
          value: {
            id: 'cluster.string',
            nodes: ['node.string', 'peer.string'],
            metadata: { nested: { label: 'stable' } },
          },
          versionVector: { source: 3 },
          timestamp: 30,
        },
      },
    }, 'source');

    const first = merger.build(1);
    first.memory.sets.nodes[0].id = 'mutated-id';
    first.memory.sets.nodes[0].metadata.nested.source = 'mutated';
    first.memory.sets.nodes[0].metadata.tags.push('three');
    first.memory.sets.nodes[0].metadata.__proto__.polluted = true;
    first.memory.sets.edges[0].metadata.nested.confidence = 0;
    first.memory.sets.clusters[0].nodes.length = 0;
    first.memory.sets.clusters[0].metadata.nested.label = 'mutated';

    const second = merger.build(2);
    const node = second.memory.sets.nodes[0];
    const edge = second.memory.sets.edges[0];
    const cluster = second.memory.sets.clusters[0];
    assert.equal(node.id, 'node.string');
    assert.equal(node.metadata.nested.source, 'durable');
    assert.deepEqual(node.metadata.tags, ['one', 'two']);
    assert.equal(node.metadata.__proto__.polluted, false);
    assert.equal({}.polluted, undefined);
    assert.equal(edge.metadata.nested.confidence, 0.9);
    assert.deepEqual(cluster.nodes, ['node.string', 'peer.string']);
    assert.equal(cluster.metadata.nested.label, 'stable');
  });
}
