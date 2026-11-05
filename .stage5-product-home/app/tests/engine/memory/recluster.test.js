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
    return { getOpenAIClient: () => null, getEmbeddingClient: () => null };
  }
  if (request === 'tiktoken') {
    return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { applyMemoryRecluster, planMemoryRecluster } = require('../../../engine/src/memory/recluster.js');
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
Module._load = originalLoad;

function makeMemory() {
  const memory = new NetworkMemory({
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    config: { spreading: { bridgeTraversalFactor: 0.2 } },
    spreading: { bridgeTraversalFactor: 0.2, maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  }, { info() {}, warn() {}, error() {}, debug() {} });
  memory.importGraphChanges({
    nodes: [
      { id: 'a', concept: 'clustered anchor', cluster: 7 },
      { id: 'b', concept: 'unclustered neighbor', cluster: null },
      { id: 'c', concept: 'component one', cluster: null },
      { id: 'd', concept: 'component two', cluster: null },
      { id: 'e', concept: 'component three', cluster: null },
    ],
    edges: [
      { source: 'a', target: 'b', weight: 0.9, type: 'semantic' },
      { source: 'c', target: 'd', weight: 0.8, type: 'semantic' },
      { source: 'd', target: 'e', weight: 0.8, type: 'semantic' },
    ],
    clusters: [{ id: 7, nodes: ['a'] }],
    nextClusterId: 8,
  });
  memory.markPersistenceClean();
  return memory;
}

test('planMemoryRecluster reports existing-cluster and new-component assignments without mutating', () => {
  const memory = makeMemory();
  const plan = planMemoryRecluster(memory);

  assert.equal(plan.unclusteredBefore, 4);
  assert.equal(plan.wouldAssignToExistingClusters, 1);
  assert.equal(plan.wouldCreateClusters, 1);
  assert.equal(plan.wouldAssignToNewClusters, 3);
  assert.equal(plan.unclusteredAfter, 0);
  assert.equal(memory.nodes.get('b').cluster, null);
});

test('applyMemoryRecluster mutates live graph and marks assigned nodes dirty', () => {
  const memory = makeMemory();
  const plan = planMemoryRecluster(memory);
  const originalApply = memory.applyReclusterPlan.bind(memory);
  let applyCalls = 0;
  memory.applyReclusterPlan = (candidate) => {
    applyCalls += 1;
    return originalApply(candidate);
  };
  const applied = applyMemoryRecluster(memory, plan);

  assert.deepEqual(applied, {
    assignedToExisting: 1,
    createdClusters: 1,
    assignedToNewClusters: 3,
  });
  assert.equal(applyCalls, 1);
  assert.equal(memory.nodes.get('b').cluster, 7);
  assert.equal(memory.nodes.get('c').cluster, 8);
  assert.equal(memory.nodes.get('d').cluster, 8);
  assert.equal(memory.nodes.get('e').cluster, 8);
  assert.deepEqual([...memory.dirtyNodeIds].sort(), ['b', 'c', 'd', 'e']);
});

test('stale imported cluster counters never overwrite an occupied cluster', () => {
  const memory = new NetworkMemory({
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  }, { info() {}, warn() {}, error() {}, debug() {} });
  memory.importGraphChanges({
    nodes: [
      { id: 'occupied', concept: 'existing member', cluster: 1 },
      { id: 'candidate', concept: 'new member', cluster: null },
    ],
    clusters: [{ id: 1, nodes: ['occupied'] }],
    nextClusterId: 1,
  });

  assert.equal(memory.nextClusterId, 2);
  const result = memory.applyReclusterPlan({ newClusterGroups: [['candidate']] });

  assert.deepEqual(result, {
    assignedToExisting: 0,
    createdClusters: 1,
    assignedToNewClusters: 1,
  });
  assert.deepEqual([...memory.clusters.get(1)], ['occupied']);
  assert.deepEqual([...memory.clusters.get(2)], ['candidate']);
  assert.equal(memory.nodes.get('occupied').cluster, 1);
  assert.equal(memory.nodes.get('candidate').cluster, 2);
  assert.equal(memory.nextClusterId, 3);
});
