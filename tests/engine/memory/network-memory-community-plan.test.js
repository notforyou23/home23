import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const {
  planMemoryCommunities,
  applyMemoryCommunities,
} = require('../../../engine/src/memory/community-detection.js');

function config() {
  return {
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8, bridgeTraversalFactor: 0.2 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function seededMemory() {
  const memory = new NetworkMemory(config(), logger);
  memory.embed = async () => null; // Memory Lite: no embeddings needed
  // Two 5-cliques, all forced into cluster 1 (the real-world starting state).
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const node = await memory.addNode(`community test node ${i}`, 'general');
    ids.push(node.id);
  }
  memory.withPersistenceBarrier(() => {
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 5; b++) {
        memory._upsertEdgeUnsafe(ids[a], ids[b], 1, 'associative', { enforceBridgeCap: false });
        memory._upsertEdgeUnsafe(ids[5 + a], ids[5 + b], 1, 'associative', { enforceBridgeCap: false });
      }
    }
    memory._upsertEdgeUnsafe(ids[0], ids[5], 1, 'bridge', { enforceBridgeCap: false });
    for (const id of ids) memory._moveNodeToClusterUnsafe(id, 1);
  });
  return { memory, ids };
}

test('applyCommunityPlan moves nodes, allocates fresh ids, and reports counts', async () => {
  const { memory } = await seededMemory();
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2);
  const result = applyMemoryCommunities(memory, plan);
  assert.equal(result.communityCount, 2);
  assert.ok(result.movedNodes >= 5, `expected >=5 moves, got ${result.movedNodes}`);
  assert.equal(result.createdClusters, 1); // one community reclaims prior id 1
  assert.equal(result.movedNodes, plan.movedNodes,
    'apply and dry-run must agree on moved count');
  const clusters = new Set(Array.from(memory.nodes.values()).map((n) => String(n.cluster)));
  assert.equal(clusters.size, 2);
  // clusters map coherent: every node's cluster contains it
  for (const [id, node] of memory.nodes) {
    assert.ok(memory.clusters.get(node.cluster)?.has(id), `cluster map missing node ${id}`);
  }
});

test('moves are captured for persistence (dirty snapshot contains moved nodes)', async () => {
  const { memory } = await seededMemory();
  memory.markPersistenceCleanIfGeneration(memory.persistenceGeneration);
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  const result = applyMemoryCommunities(memory, plan);
  const snapshot = memory.capturePersistenceSnapshot();
  const dirtyIds = new Set(snapshot.changes.nodes.map((n) => String(n.id)));
  assert.ok(dirtyIds.size >= result.movedNodes,
    `moved ${result.movedNodes} but snapshot only carries ${dirtyIds.size}`);
});

test('no-op plan does not advance the persistence generation (event rule)', async () => {
  const { memory } = await seededMemory();
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  applyMemoryCommunities(memory, plan);
  memory.markPersistenceCleanIfGeneration(memory.persistenceGeneration);
  const generation = memory.persistenceGeneration;
  // Re-plan on the now-partitioned graph: seeded from clusters → zero moves.
  const second = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(second.unchanged, true);
  const result = applyMemoryCommunities(memory, second);
  assert.equal(result.movedNodes, 0);
  assert.equal(memory.persistenceGeneration, generation,
    'no-op apply must not advance the persistence generation');
});

test('missing mutation API throws the typed error', () => {
  assert.throws(
    () => applyMemoryCommunities({ nodes: new Map() }, { communities: [] }),
    /memory_communities_mutation_api_required/,
  );
});

test('mixed-type member under a claimed id is not a move (String contract)', async () => {
  const { memory, ids } = await seededMemory();
  // Force one node's cluster to the STRING '1' while the community claims numeric 1.
  memory.withPersistenceBarrier(() => {
    const node = memory.nodes.get(ids[0]);
    const members = memory.clusters.get(node.cluster);
    members?.delete(ids[0]);
    node.cluster = '1';
    if (!memory.clusters.has('1')) memory.clusters.set('1', new Set());
    memory.clusters.get('1').add(ids[0]);
    memory._markNodeDirtyUnsafe(ids[0]);
  });
  memory.markPersistenceCleanIfGeneration(memory.persistenceGeneration);
  const generation = memory.persistenceGeneration;
  const result = memory.applyCommunityPlan({
    communities: [{ clusterId: 1, members: [ids[0]] }],
  });
  assert.equal(result.movedNodes, 0, "String('1') === String(1): not a move");
  assert.equal(memory.persistenceGeneration, generation,
    'type-only mismatch must not advance the generation');
});

test('newborn wired into a community is adopted at birth (spec §6 claim, verified)', async () => {
  const { memory, ids } = await seededMemory();
  applyMemoryCommunities(memory, planMemoryCommunities(memory, { minCommunitySize: 2 }));
  const cliqueACluster = memory.nodes.get(ids[0]).cluster;
  // Embeddings are off, so initial edges don't form at addNode time; wire
  // edges first, then re-run the engine's own birth-adoption primitive.
  const newborn = await memory.addNode('newborn about clique A topics', 'general');
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(newborn.id, ids[0], 1, 'associative', { enforceBridgeCap: false });
    memory._upsertEdgeUnsafe(newborn.id, ids[1], 1, 'associative', { enforceBridgeCap: false });
    memory._assignToClusterUnsafe(newborn.id);
  });
  assert.equal(String(memory.nodes.get(newborn.id).cluster), String(cliqueACluster),
    'newborn must join its neighborhood community at birth');
});
