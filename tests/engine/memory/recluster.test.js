import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyMemoryRecluster, planMemoryRecluster } = require('../../../engine/src/memory/recluster.js');

function makeMemory() {
  const memory = {
    config: { spreading: { bridgeTraversalFactor: 0.2 } },
    nodes: new Map(),
    edges: new Map(),
    clusters: new Map([[7, new Set(['a'])]]),
    nextClusterId: 8,
    dirty: new Set(),
    markNodeDirty(id) { this.dirty.add(id); },
  };
  memory.nodes.set('a', { id: 'a', concept: 'clustered anchor', cluster: 7 });
  memory.nodes.set('b', { id: 'b', concept: 'unclustered neighbor', cluster: null });
  memory.nodes.set('c', { id: 'c', concept: 'component one', cluster: null });
  memory.nodes.set('d', { id: 'd', concept: 'component two', cluster: null });
  memory.nodes.set('e', { id: 'e', concept: 'component three', cluster: null });
  memory.edges.set('a->b', { source: 'a', target: 'b', weight: 0.9, type: 'semantic' });
  memory.edges.set('c->d', { source: 'c', target: 'd', weight: 0.8, type: 'semantic' });
  memory.edges.set('d->e', { source: 'd', target: 'e', weight: 0.8, type: 'semantic' });
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
  const applied = applyMemoryRecluster(memory, plan);

  assert.deepEqual(applied, {
    assignedToExisting: 1,
    createdClusters: 1,
    assignedToNewClusters: 3,
  });
  assert.equal(memory.nodes.get('b').cluster, 7);
  assert.equal(memory.nodes.get('c').cluster, 8);
  assert.equal(memory.nodes.get('d').cluster, 8);
  assert.equal(memory.nodes.get('e').cluster, 8);
  assert.deepEqual([...memory.dirty].sort(), ['b', 'c', 'd', 'e']);
});
