import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai') return class OpenAI {};
  if (request === 'dotenv') return { config() {} };
  if (request.endsWith('/core/openai-client') || request === '../core/openai-client') {
    return {
      getOpenAIClient: () => null,
      getEmbeddingClient: () => null,
    };
  }
  if (request === 'tiktoken') {
    return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
Module._load = originalLoad;

function memory(overrides = {}) {
  const mem = new NetworkMemory({
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    spreading: {
      bridgeTraversalFactor: 0.2,
      maxDepth: 2,
      activationThreshold: 0.01,
      decayFactor: 0.8,
    },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: {
      baseFactor: 0.95,
      minimumWeight: 0.01,
      decayInterval: 300,
      exemptTags: [],
    },
    ...overrides,
  }, {
    info() {},
    warn() {},
    debug() {},
    error() {},
  });
  mem.tokenizer = null;
  return mem;
}

async function addIsolatedNode(mem, id, embedding, extra = {}) {
  return mem.addNode({
    id,
    concept: `node ${id}`,
    tag: 'test',
    metadata: { nested: { value: id } },
    ...extra,
  }, 'test', embedding);
}

function installBarrierSpy(mem) {
  const calls = [];
  let label = null;
  const original = mem.withPersistenceBarrier;
  mem.withPersistenceBarrier = function withPersistenceBarrierSpy(callback) {
    assert.equal(this.persistenceBarrierActive, false, `${label}: entered while another barrier was active`);
    const call = { label, before: this.persistenceGeneration, after: null };
    calls.push(call);
    return original.call(this, () => {
      assert.equal(this.persistenceBarrierActive, true, `${label}: callback ran outside the barrier`);
      const result = callback();
      assert.equal(Boolean(result && typeof result.then === 'function'), false, `${label}: callback yielded`);
      call.after = this.persistenceGeneration;
      return result;
    });
  };
  return {
    calls,
    async run(expectedLabel, callback) {
      const before = calls.length;
      label = expectedLabel;
      try {
        return await callback();
      } finally {
        label = null;
        assert.equal(calls.length, before + 1, `${expectedLabel}: expected exactly one outer barrier`);
        assert.equal(calls.at(-1).label, expectedLabel);
      }
    },
  };
}

function guardMapWrites(mem, map, name) {
  for (const method of ['set', 'delete']) {
    const native = Map.prototype[method];
    Object.defineProperty(map, method, {
      configurable: true,
      value(...args) {
        assert.equal(mem.persistenceBarrierActive, true, `${name}.${method} ran outside the barrier`);
        return native.apply(this, args);
      },
    });
  }
}

function guardRecordWrites(mem, map, key, name) {
  const target = Map.prototype.get.call(map, key);
  const proxy = new Proxy(target, {
    set(record, property, value) {
      assert.equal(mem.persistenceBarrierActive, true, `${name}.${String(property)} ran outside the barrier`);
      return Reflect.set(record, property, value);
    },
  });
  Map.prototype.set.call(map, key, proxy);
  return proxy;
}

test('accepted node and edge mutators advance generation inside one shared barrier', async () => {
  const mem = memory();
  const barrier = installBarrierSpy(mem);
  guardMapWrites(mem, mem.nodes, 'nodes');
  guardMapWrites(mem, mem.edges, 'edges');

  let generation = mem.persistenceGeneration;
  const first = await barrier.run('node insert', () => addIsolatedNode(mem, 'n1', [1, 0]));
  assert.equal(mem.persistenceGeneration, generation + 1);
  generation = mem.persistenceGeneration;

  const guardedFirst = guardRecordWrites(mem, mem.nodes, first.id, 'node n1');
  await barrier.run('explicit node access update', () => mem.recordNodeAccess([first.id], { weightBoost: 0.1 }));
  assert.equal(guardedFirst.accessCount, 1);
  assert.equal(mem.persistenceGeneration, generation + 1);
  generation = mem.persistenceGeneration;

  await barrier.run('node activation update', () => mem.spreadActivation(first.id));
  assert.equal(guardedFirst.activation, 1);
  assert.equal(mem.persistenceGeneration, generation + 1);
  generation = mem.persistenceGeneration;

  const second = await barrier.run('second node insert', () => addIsolatedNode(mem, 'n2', [0, 1]));
  assert.equal(mem.persistenceGeneration, generation + 1);
  generation = mem.persistenceGeneration;

  await barrier.run('edge insert', () => mem.addEdge(first.id, second.id, 0.2, 'manual'));
  assert.equal(mem.persistenceGeneration, generation + 1);
  generation = mem.persistenceGeneration;

  const edgeKey = 'n1->n2';
  const guardedEdge = guardRecordWrites(mem, mem.edges, edgeKey, 'edge n1->n2');
  await barrier.run('edge update', () => mem.addEdge(second.id, first.id, 0.2, 'manual'));
  assert.equal(guardedEdge.weight, 0.4);
  assert.equal(mem.persistenceGeneration, generation + 1);
  generation = mem.persistenceGeneration;

  await barrier.run('edge delete', () => mem.removeEdge(first.id, second.id));
  assert.equal(mem.persistenceGeneration, generation + 1);
  assert.equal(mem.deletedEdgeKeys.has(edgeKey), true);
  generation = mem.persistenceGeneration;

  await barrier.run('node delete', () => mem.removeNode(second.id));
  assert.equal(mem.persistenceGeneration, generation + 1);
  assert.equal(mem.deletedNodeIds.has(second.id), true);

  await barrier.run('capture', () => mem.capturePersistenceSnapshot());
  await barrier.run('clean CAS', () => mem.markPersistenceCleanIfGeneration(mem.persistenceGeneration));
  assert.equal(mem.hasPersistenceChanges(), false);
  assert.deepEqual(barrier.calls.map((call) => call.label), [
    'node insert',
    'explicit node access update',
    'node activation update',
    'second node insert',
    'edge insert',
    'edge update',
    'edge delete',
    'node delete',
    'capture',
    'clean CAS',
  ]);
});

test('missing, rejected, and read-only paths do not advance generation', async () => {
  const mem = memory();
  const node = await addIsolatedNode(mem, 'n1', [1, 0]);
  mem.markPersistenceClean();
  const generation = mem.persistenceGeneration;

  assert.equal(await mem.addNode('   ', 'test', [1, 0]), null);
  assert.equal(mem.addEdge(node.id, node.id, 0.2), undefined);
  assert.equal(mem.removeNode('missing'), false);
  assert.equal(mem.removeEdge(node.id, 'missing'), false);
  assert.equal(mem.markNodeDirty('missing'), false);
  assert.equal(mem.markEdgeDirty('missing->edge'), false);
  assert.equal(mem.recordNodeAccess(['missing']), undefined);
  mem.embed = async () => [1, 0];
  const results = await mem.query('node n1', 1, { accessMode: 'read-only' });

  assert.equal(results.length, 1);
  assert.equal(mem.nodes.get(node.id).activation, 0);
  assert.equal(mem.persistenceGeneration, generation);
  assert.equal(mem.hasPersistenceChanges(), false);
});

test('same-ID repeated accepted access mutations advance generation despite stable dirty cardinality', async () => {
  const mem = memory();
  const node = await addIsolatedNode(mem, 'n1', [1, 0]);
  mem.markPersistenceClean();
  const generation = mem.persistenceGeneration;

  mem.recordNodeAccess([node.id]);
  mem.recordNodeAccess([node.id]);

  assert.equal(mem.dirtyNodeIds.size, 1);
  assert.equal(mem.persistenceGeneration, generation + 2);
  assert.equal(mem.nodes.get(node.id).accessCount, 2);
});

test('explicit high IDs advance allocation and generated IDs skip occupied records atomically', async () => {
  const mem = memory();
  const explicit = await addIsolatedNode(mem, 42, [1, 0, 0]);
  const generated = await mem.addNode('generated after explicit', 'test', [0, 1, 0]);
  const collision = await mem.addNode({
    id: 42,
    concept: 'explicit collision must allocate safely',
    tag: 'test',
  }, 'test', [0, 0, 1]);

  assert.equal(explicit.id, 42);
  assert.equal(generated.id, 43);
  assert.equal(collision.id, 44);
  assert.equal(mem.nextNodeId, 45);
  assert.equal(mem.nodes.size, 3);
  assert.equal(mem.nodes.get(42).concept, 'node 42');
  assert.deepEqual([...mem.dirtyNodeIds], [42, 43, 44]);
  assert.equal(mem.persistenceGeneration, 3);
});

test('numeric allocator reconciles canonical string IDs before generating a node', async () => {
  const mem = memory();
  Map.prototype.set.call(mem.nodes, '547601', {
    id: '547601', concept: 'loaded canonical source node', cluster: null,
  });
  Map.prototype.set.call(mem.nodes, '547602', {
    id: '547602', concept: 'loaded canonical source node', cluster: null,
  });
  mem.nextNodeId = 547602;

  assert.equal(mem.reconcileNodeIdAllocator(), 547603);
  const generated = await mem.addNode('must not alias a loaded string ID', 'test', [1, 0]);

  assert.equal(generated.id, 547603);
  assert.equal(mem.nodes.size, 3);
  assert.equal(mem.nodes.has('547602'), true);
  assert.equal(mem.nodes.has(547602), false);
});

test('node patch options cannot redirect the target or replace the requested patch', async () => {
  const mem = memory();
  const first = await addIsolatedNode(mem, 'n1', [1, 0]);
  const second = await addIsolatedNode(mem, 'n2', [0, 1]);
  mem.markPersistenceClean();
  const generation = mem.persistenceGeneration;

  const updated = mem.patchNode(first.id, { concept: 'updated first' }, {
    nodeId: second.id,
    patch: { concept: 'redirected second' },
  });

  assert.equal(updated, first);
  assert.equal(first.concept, 'updated first');
  assert.equal(second.concept, 'node n2');
  assert.equal(mem.persistenceGeneration, generation + 1);
  assert.deepEqual([...mem.dirtyNodeIds], [first.id]);
});

test('graph import keeps node and cluster indexes consistent when snapshots replace membership', () => {
  const mem = memory();
  mem.importGraphChanges({
    nodes: [
      { id: 'n1', concept: 'first', cluster: 1 },
      { id: 'n2', concept: 'second', cluster: 2 },
    ],
    clusters: [
      { id: 1, nodes: ['n1'] },
      { id: 2, nodes: ['n2'] },
    ],
  });
  mem.markPersistenceClean();

  mem.importGraphChanges({
    nodes: [{ id: 'n1', concept: 'first moved', cluster: 2 }],
    clusters: [{ id: 2, nodes: ['n1', 'n2'] }],
  });

  assert.equal(mem.nodes.get('n1').cluster, 2);
  assert.equal(mem.clusters.get(1)?.has('n1') || false, false);
  assert.deepEqual([...mem.clusters.get(2)].sort(), ['n1', 'n2']);

  mem.importGraphChanges({ clusters: [{ id: 2, nodes: ['n2'] }] });

  assert.equal(mem.nodes.get('n1').cluster, null);
  assert.deepEqual([...mem.clusters.get(2)], ['n2']);
});

test('graph import updates an equivalent logical ID without creating a type alias', () => {
  const mem = memory();
  mem.importGraphChanges({
    nodes: [{ id: '42', concept: 'loaded canonical node', cluster: null }],
  });
  mem.markPersistenceClean();

  const result = mem.importGraphChanges({
    nodes: [{ id: 42, concept: 'updated through numeric ingress', cluster: null }],
  });

  assert.equal(result.importedNodes, 1);
  assert.equal(mem.nodes.size, 1);
  assert.equal(mem.nodes.has('42'), true);
  assert.equal(mem.nodes.has(42), false);
  assert.equal(mem.nodes.get('42').id, '42');
  assert.equal(mem.nodes.get('42').concept, 'updated through numeric ingress');
  assert.doesNotThrow(() => mem.capturePersistenceChangesSnapshot());
});

test('graph import rejects accessor-backed pair records without invoking accessors', () => {
  const mem = memory();
  let getterCalls = 0;
  const record = {};
  Object.defineProperty(record, 'concept', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    },
  });

  assert.throws(
    () => mem.importGraphChanges({ nodes: [['n1', record]] }),
    /persistence_record_accessor_not_allowed/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(mem.persistenceGeneration, 0);
});

test('graph import derives next numeric IDs without spreading the whole graph onto the stack', () => {
  const mem = memory();
  for (let id = 1; id <= 150_000; id += 1) {
    mem.nodes.set(id, { id, concept: `node ${id}`, cluster: null });
  }

  assert.doesNotThrow(() => mem.importGraphChanges({
    nodes: [{ id: 150_001, concept: 'last node', cluster: null }],
  }));
  assert.equal(mem.nextNodeId, 150_002);
});

test('embedding regeneration is an accepted node update behind the barrier', async () => {
  const mem = memory();
  const node = await addIsolatedNode(mem, 'n1', null);
  mem.markPersistenceClean();
  const barrier = installBarrierSpy(mem);
  const guardedNode = guardRecordWrites(mem, mem.nodes, node.id, 'regenerated node');
  mem.embedBatch = async () => [[0.25, 0.75]];
  const generation = mem.persistenceGeneration;

  const result = await barrier.run('node embedding update', () => mem.regenerateMissingEmbeddings());

  assert.deepEqual(result, { regenerated: 1, total: 1 });
  assert.deepEqual(Array.from(guardedNode.embedding), [0.25, 0.75]);
  assert.equal(guardedNode.embedding_status, 'embedded');
  assert.equal(mem.persistenceGeneration, generation + 1);
  assert.equal(mem.dirtyNodeIds.has(node.id), true);
});

test('bridge-cap eviction and insertion publish tombstone and dirty state in one barrier', async () => {
  const mem = memory({
    smallWorld: { maxBridgesPerNode: 1 },
  });
  const a = await addIsolatedNode(mem, 'a', [1, 0, 0]);
  const b = await addIsolatedNode(mem, 'b', [0, 1, 0]);
  const c = await addIsolatedNode(mem, 'c', [0, 0, 1]);
  mem.addEdge(a.id, b.id, 0.1, 'bridge');
  mem.markPersistenceClean();
  const barrier = installBarrierSpy(mem);
  guardMapWrites(mem, mem.edges, 'edges');
  const generation = mem.persistenceGeneration;

  await barrier.run('bridge cap eviction plus insert', () => mem.addEdge(a.id, c.id, 0.2, 'bridge'));

  assert.equal(mem.edges.has('a->b'), false);
  assert.equal(mem.edges.has('a->c'), true);
  assert.deepEqual([...mem.deletedEdgeKeys], ['a->b']);
  assert.deepEqual([...mem.dirtyEdgeKeys], ['a->c']);
  assert.equal(mem.persistenceGeneration, generation + 2);
});

test('node removal cascades all incident edge tombstones inside its single outer barrier', async () => {
  const mem = memory();
  const a = await addIsolatedNode(mem, 'a', [1, 0, 0]);
  const b = await addIsolatedNode(mem, 'b', [0, 1, 0]);
  const c = await addIsolatedNode(mem, 'c', [0, 0, 1]);
  mem.addEdge(a.id, b.id, 0.1, 'manual');
  mem.addEdge(a.id, c.id, 0.1, 'manual');
  mem.markPersistenceClean();
  const barrier = installBarrierSpy(mem);
  guardMapWrites(mem, mem.nodes, 'nodes');
  guardMapWrites(mem, mem.edges, 'edges');
  const generation = mem.persistenceGeneration;

  await barrier.run('node plus incident edges delete', () => mem.removeNode(a.id));

  assert.deepEqual([...mem.deletedNodeIds], ['a']);
  assert.deepEqual([...mem.deletedEdgeKeys].sort(), ['a->b', 'a->c']);
  assert.equal(mem.persistenceGeneration, generation + 3);
  assert.equal(mem.nodes.has(a.id), false);
  assert.equal([...mem.clusters.values()].some((members) => members.has(a.id)), false);
});

test('decay updates every accepted node and edge record in one barrier', async () => {
  const mem = memory({
    decay: {
      baseFactor: 0.5,
      minimumWeight: 0.01,
      decayInterval: 1,
      exemptTags: ['protected'],
      bridgeDecayInterval: 1,
    },
    hebbian: { enabled: true, reinforcementStrength: 0.1, weakenFactor: 0.5 },
  });
  const old = new Date('2020-01-01T00:00:00.000Z');
  const first = await addIsolatedNode(mem, 'n1', [1, 0], { accessed: old, weight: 0.8 });
  const protectedNode = await addIsolatedNode(mem, 'n2', [0, 1], {
    accessed: old,
    weight: 0.8,
    tag: 'protected',
  });
  mem.addEdge(first.id, protectedNode.id, 0.6, 'manual');
  mem.edges.get('n1->n2').accessed = old;
  mem.markPersistenceClean();
  const barrier = installBarrierSpy(mem);
  const guardedFirst = guardRecordWrites(mem, mem.nodes, first.id, 'decayed node');
  const guardedEdge = guardRecordWrites(mem, mem.edges, 'n1->n2', 'decayed edge');
  const generation = mem.persistenceGeneration;

  await barrier.run('decay updates', () => mem.applyDecay());

  assert.equal(guardedFirst.weight, 0.4);
  assert.equal(protectedNode.weight, 0.8);
  assert.equal(guardedEdge.weight, 0.3);
  assert.equal(mem.persistenceGeneration, generation + 2);
  assert.deepEqual([...mem.dirtyNodeIds], ['n1']);
  assert.deepEqual([...mem.dirtyEdgeKeys], ['n1->n2']);
});

test('weak-edge pruning records its delete tombstone behind the barrier', async () => {
  const mem = memory({
    smallWorld: {
      maxBridgesPerNode: 40,
      rewireYieldEvery: 1000,
      bridgeProbability: 0,
    },
  });
  const first = await addIsolatedNode(mem, 'n1', [1, 0]);
  const second = await addIsolatedNode(mem, 'n2', [0, 1]);
  mem.addEdge(first.id, second.id, 0.05, 'manual');
  mem.markPersistenceClean();
  const barrier = installBarrierSpy(mem);
  guardMapWrites(mem, mem.edges, 'edges');
  const generation = mem.persistenceGeneration;

  await barrier.run('weak-edge prune', () => mem.rewire());

  assert.equal(mem.edges.has('n1->n2'), false);
  assert.deepEqual([...mem.deletedEdgeKeys], ['n1->n2']);
  assert.equal(mem.persistenceGeneration, generation + 1);
});

test('capture deeply clones and freezes one exact generation without invoking overridable callbacks', async () => {
  const mem = memory();
  const input = {
    id: 'n1',
    concept: 'first',
    tag: 'test',
    tags: ['durable'],
    metadata: { nested: { value: 'captured' } },
  };
  const first = await mem.addNode(input, 'test', [1, 2]);
  const second = await addIsolatedNode(mem, 'n2', [-2, 1]);
  mem.addEdge(first.id, second.id, 0.4, 'manual');
  let userCallbackCalls = 0;
  first.toJSON = () => {
    userCallbackCalls += 1;
    return { id: 'corrupted-by-callback' };
  };
  mem.edges.get('n1->n2').toJSON = () => {
    userCallbackCalls += 1;
    return { source: 'corrupted-by-callback' };
  };
  mem.getPersistenceChanges = () => {
    userCallbackCalls += 1;
    throw new Error('public persistence callback must not run during capture');
  };
  mem.serializeNodeRecord = () => {
    userCallbackCalls += 1;
    throw new Error('public serializer callback must not run during capture');
  };

  const snapshot = mem.capturePersistenceSnapshot();
  const capturedGeneration = mem.persistenceGeneration;
  input.tags.push('post-capture');
  input.metadata.nested.value = 'mutated input';
  first.concept = 'mutated live node';
  first.metadata.nested.value = 'mutated live metadata';
  mem.edges.get('n1->n2').weight = 0.99;
  mem.nodes.set('rogue', { id: 'rogue', concept: 'post-capture map mutation' });

  assert.equal(snapshot.generation, capturedGeneration);
  assert.equal(userCallbackCalls, 0);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.changes), true);
  assert.equal(Object.isFrozen(snapshot.changes.nodes), true);
  assert.equal(Object.isFrozen(snapshot.changes.nodes[0].metadata.nested), true);
  assert.equal(Object.isFrozen(snapshot.fullView), true);
  assert.equal(Object.isFrozen(snapshot.fullView.nodes), true);
  assert.equal(Object.isFrozen(snapshot.fullView.nodes[0]), true);
  assert.equal(snapshot.fullView.nodes.find((node) => node.id === 'n1').concept, 'first');
  assert.equal(snapshot.fullView.nodes.find((node) => node.id === 'n1').metadata.nested.value, 'captured');
  assert.deepEqual(snapshot.fullView.nodes.find((node) => node.id === 'n1').tags, ['durable']);
  assert.equal(snapshot.fullView.edges.find((edge) => edge.source === 'n1').weight, 0.4);
  assert.deepEqual(snapshot.summary, { nodeCount: 2, edgeCount: 1, clusterCount: 2 });
});

test('capture rejects record accessors without invoking them while the barrier is held', async () => {
  const mem = memory();
  const node = await addIsolatedNode(mem, 'n1', [1, 0]);
  let getterCalls = 0;
  Object.defineProperty(node, 'pluginValue', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    },
  });

  assert.throws(
    () => mem.capturePersistenceSnapshot(),
    /persistence_record_accessor_not_allowed/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(mem.persistenceBarrierActive, false);
});

test('node patches reject structural cluster changes without corrupting membership indexes', async () => {
  const mem = memory();
  const node = await addIsolatedNode(mem, 'n1', [1, 0]);
  const originalCluster = node.cluster;
  const originalMembers = [...mem.clusters.get(originalCluster)];

  assert.throws(
    () => mem.patchNode(node.id, { cluster: originalCluster + 100 }),
    /node_patch_forbidden_key:cluster/,
  );
  assert.equal(mem.nodes.get(node.id).cluster, originalCluster);
  assert.deepEqual([...mem.clusters.get(originalCluster)], originalMembers);
  assert.equal(mem.clusters.has(originalCluster + 100), false);
});

test('generation CAS preserves every dirty and tombstone set after an intervening mutation', async () => {
  const mem = memory();
  const first = await addIsolatedNode(mem, 'n1', [1, 0]);
  const second = await addIsolatedNode(mem, 'n2', [0, 1]);
  mem.addEdge(first.id, second.id, 0.2, 'manual');
  mem.markPersistenceClean();
  const snapshot = mem.capturePersistenceSnapshot();

  mem.recordNodeAccess([first.id]);
  mem.recordNodeAccess([first.id]);
  mem.removeEdge(first.id, second.id);
  mem.removeNode(second.id);
  const before = {
    dirtyNodes: [...mem.dirtyNodeIds],
    dirtyEdges: [...mem.dirtyEdgeKeys],
    deletedNodes: [...mem.deletedNodeIds],
    deletedEdges: [...mem.deletedEdgeKeys],
  };

  assert.equal(mem.markPersistenceCleanIfGeneration(snapshot.generation), false);
  assert.deepEqual({
    dirtyNodes: [...mem.dirtyNodeIds],
    dirtyEdges: [...mem.dirtyEdgeKeys],
    deletedNodes: [...mem.deletedNodeIds],
    deletedEdges: [...mem.deletedEdgeKeys],
  }, before);
  assert.equal(mem.markPersistenceCleanIfGeneration(mem.persistenceGeneration), true);
  assert.equal(mem.hasPersistenceChanges(), false);
});

test('persistence barrier rejects re-entry and Promise-returning callbacks', () => {
  const mem = memory();
  assert.throws(
    () => mem.withPersistenceBarrier(() => Promise.resolve()),
    /persistence_barrier_async_callback/,
  );
  assert.equal(mem.persistenceBarrierActive, false);
  assert.throws(
    () => mem.withPersistenceBarrier(() => mem.withPersistenceBarrier(() => 1)),
    /persistence_barrier_reentry/,
  );
  assert.equal(mem.persistenceBarrierActive, false);
});

test('persistence barrier rejects AsyncFunction before invocation and contains returned thenables', async () => {
  const mem = memory();
  let asyncStarted = false;
  assert.throws(
    () => mem.withPersistenceBarrier(async () => {
      asyncStarted = true;
      await Promise.resolve();
    }),
    /persistence_barrier_async_callback/,
  );
  assert.equal(asyncStarted, false);

  let escapedMutation = false;
  assert.throws(
    () => mem.withPersistenceBarrier(() => Promise.resolve().then(() => {
      try {
        mem._advancePersistenceGenerationUnsafe();
        escapedMutation = true;
      } catch {
        // The continuation runs only after the barrier has closed.
      }
    })),
    /persistence_barrier_async_callback/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(escapedMutation, false);
  assert.equal(mem.persistenceGeneration, 0);
  assert.equal(mem.persistenceBarrierActive, false);
});

test('full and changes-only snapshots preserve enumerable edge extensions', () => {
  const mem = memory();
  mem.importGraphChanges({
    nodes: [
      { id: 'a', concept: 'alpha', cluster: null },
      { id: 'b', concept: 'beta', cluster: null },
    ],
    edges: [{
      source: 'a',
      target: 'b',
      weight: 0.4,
      type: 'evidence',
      metadata: { source: 'call-site-regression' },
      confidence: 0.87,
    }],
  });

  const full = mem.capturePersistenceSnapshot();
  const changes = mem.capturePersistenceChangesSnapshot();
  assert.equal(full.fullView.edges[0].confidence, 0.87);
  assert.equal(full.fullView.edges[0].metadata.source, 'call-site-regression');
  assert.equal(changes.changes.edges[0].confidence, 0.87);
  assert.equal(changes.changes.edges[0].metadata.source, 'call-site-regression');
});

test('changes-only capture rejects accessors without invoking their getter', async () => {
  const mem = memory();
  const node = await addIsolatedNode(mem, 'n1', [1, 0]);
  let getterCalls = 0;
  Object.defineProperty(node, 'lateBound', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    },
  });

  assert.throws(
    () => mem.capturePersistenceChangesSnapshot(),
    /persistence_record_accessor_not_allowed/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(mem.persistenceBarrierActive, false);
});

test('persistence capture rejects numeric and string aliases for one logical node ID', () => {
  const mem = memory();
  Map.prototype.set.call(mem.nodes, '42', {
    id: '42', concept: 'canonical source node', cluster: null,
  });
  Map.prototype.set.call(mem.nodes, 42, {
    id: 42, concept: 'resident type alias', cluster: null,
  });

  assert.throws(
    () => mem.capturePersistenceChangesSnapshot(),
    /memory_persistence_duplicate_logical_node_id:42/,
  );
  assert.throws(
    () => mem.capturePersistenceSnapshot(),
    /memory_persistence_duplicate_logical_node_id:42/,
  );
});

test('descriptor clone preserves own __proto__ data without prototype pollution', async () => {
  const mem = memory();
  const metadata = Object.create(null);
  Object.defineProperty(metadata, '__proto__', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { polluted: true },
  });
  await mem.addNode({ id: 'safe', concept: 'safe metadata', metadata }, 'test', [1, 0]);

  const snapshot = mem.capturePersistenceSnapshot();
  const captured = snapshot.fullView.nodes.find((node) => node.id === 'safe').metadata;
  assert.equal(Object.getPrototypeOf(captured), null);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, '__proto__'), true);
  assert.equal(captured.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test('graph import validates tuple records descriptor-first and rejects non-plain ingress', () => {
  const mem = memory();
  let getterCalls = 0;
  const accessorNode = {};
  Object.defineProperty(accessorNode, 'concept', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must not run';
    },
  });
  assert.throws(
    () => mem.importGraphChanges({ nodes: [['safe-id', accessorNode]] }),
    /persistence_record_accessor_not_allowed/,
  );
  assert.equal(getterCalls, 0);

  class CustomRecord {
    constructor() {
      this.id = 'custom';
      this.concept = 'custom prototype';
    }
  }
  assert.throws(
    () => mem.importGraphChanges({ nodes: [new CustomRecord()] }),
    /persistence_record_plain_json_required/,
  );
  assert.equal(mem.persistenceGeneration, 0);
});

test('every production call-site mutation invalidates a stale persistence clean CAS', async () => {
  const mem = memory();
  const first = await addIsolatedNode(mem, 'n1', [1, 0], { cluster: 7 });
  const second = await addIsolatedNode(mem, 'n2', [0, 1], { cluster: null });
  mem.markPersistenceClean();

  const assertInvalidatesStaleClean = (label, mutate) => {
    const snapshot = mem.capturePersistenceSnapshot();
    const generation = mem.persistenceGeneration;
    const result = mutate();
    assert.ok(mem.persistenceGeneration > generation, `${label}: generation did not advance`);
    assert.equal(mem.markPersistenceCleanIfGeneration(snapshot.generation), false, `${label}: stale clean succeeded`);
    assert.equal(mem.markPersistenceCleanIfGeneration(mem.persistenceGeneration), true, `${label}: current clean failed`);
    return result;
  };

  assertInvalidatesStaleClean('orchestrator background embedding / ingestion metadata patch', () => (
    mem.patchNode(first.id, { metadata: { source: 'background-and-ingestion' } }, { expectedNode: first })
  ));
  assertInvalidatesStaleClean('summarizer consolidatedAt batch patch', () => mem.patchNodes([{
    nodeId: second.id,
    expectedNode: second,
    patch: { consolidatedAt: '2026-07-11T00:00:00.000Z' },
  }]));
  assertInvalidatesStaleClean('orchestrator feeder import', () => mem.importGraphChanges({
    nodes: [{ id: 'feeder', concept: 'feeder import', cluster: null }],
  }));
  assertInvalidatesStaleClean('recluster plan', () => mem.applyReclusterPlan({
    existingAssignments: [{ nodeId: 'feeder', cluster: 7 }],
    newClusterGroups: [],
  }));
  assertInvalidatesStaleClean('cluster merged graph import', () => mem.importGraphChanges({
    nodes: [{ id: 'merged', concept: 'merged import', cluster: 9 }],
    clusters: [{ id: 9, nodes: ['merged'] }],
  }));
  assertInvalidatesStaleClean('summarizer garbage collection batch remove', () => mem.removeNodes(['feeder']));
});

test('graph imports reconcile cluster indexes exactly and tombstones win set-delete overlap', () => {
  const mem = memory();
  mem.importGraphChanges({
    nodes: [
      { id: 'move', concept: 'move me', cluster: 1 },
      { id: 'removed', concept: 'remove membership', cluster: 1 },
      { id: 'deleted', concept: 'delete wins', cluster: null },
    ],
    clusters: [{ id: 1, nodes: ['move', 'removed'] }],
  });
  mem.markPersistenceClean();

  mem.importGraphChanges({
    nodes: [
      { id: 'move', concept: 'move me', cluster: 2 },
      { id: 'deleted', concept: 'must not survive', cluster: 2 },
    ],
    clusters: [
      { id: 1, nodes: [] },
      { id: 2, nodes: ['move', 'deleted'] },
    ],
    nodeDeletes: ['deleted'],
  });

  assert.equal(mem.nodes.get('move').cluster, 2);
  assert.equal(mem.clusters.get(1)?.has('move') || false, false);
  assert.equal(mem.nodes.get('removed').cluster, null);
  assert.equal(mem.clusters.get(2).has('move'), true);
  assert.equal(mem.nodes.has('deleted'), false);
  assert.equal(mem.deletedNodeIds.has('deleted'), true);
});

test('large graph next-id scan stays bounded without argument spreading', () => {
  const mem = memory();
  for (let id = 1; id <= 100_500; id += 1) {
    Map.prototype.set.call(mem.nodes, id, { id, concept: `node ${id}`, cluster: null });
  }
  mem.nextNodeId = 1;

  assert.doesNotThrow(() => mem.importGraphChanges({
    nodes: [{ id: 100_501, concept: 'last node', cluster: null }],
  }));
  assert.equal(mem.nextNodeId, 100_502);
});
