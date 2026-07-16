import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planMemoryCommunities,
} = require('../../../engine/src/memory/community-detection.js');

// ── fixtures ─────────────────────────────────────────────────────
// Minimal memory shape: the planner only reads memory.nodes (Map),
// memory.edges (Map), memory.config.spreading.bridgeTraversalFactor.

function makeMemory({ nodes, edges, bridgeTraversalFactor = 0.2 }) {
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [`${e.source}->${e.target}`, e])),
    config: { spreading: { bridgeTraversalFactor } },
  };
}

function node(id, cluster = 1, extra = {}) {
  return { id, cluster, concept: `concept ${id}`, tag: extra.tag || 'general', ...extra };
}

function edge(source, target, weight = 1, type = 'associative') {
  return { source, target, weight, type };
}

// Two dense 6-cliques (nodes 1-6 and 11-16), all sharing cluster 1 —
// jerry's real starting state in miniature. Joined only by bridge edges.
function twoCliquesBridged({ bridgeType = 'bridge', bridgeWeight = 1 } = {}) {
  const nodes = [];
  const edges = [];
  for (const base of [0, 10]) {
    for (let i = 1; i <= 6; i++) nodes.push(node(base + i));
    for (let i = 1; i <= 6; i++) {
      for (let j = i + 1; j <= 6; j++) edges.push(edge(base + i, base + j, 1));
    }
  }
  edges.push(edge(3, 13, bridgeWeight, bridgeType));
  edges.push(edge(4, 14, bridgeWeight, bridgeType));
  return makeMemory({ nodes, edges });
}

test('virgin uniform-cluster brain splits into structural communities (singleton seeding)', () => {
  const plan = planMemoryCommunities(twoCliquesBridged(), { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2);
  const sizes = plan.communities.map((c) => c.members.length).sort();
  assert.deepEqual(sizes, [6, 6]);
  // every node moves: the partition differs from the uniform cluster 1
  assert.equal(plan.movedNodes, 12);
  assert.equal(plan.unchanged, false);
  assert.equal(plan.converged, true);
});

test('bridge discount is load-bearing: full-weight associative links fuse the cliques', () => {
  const fused = planMemoryCommunities(
    twoCliquesBridged({ bridgeType: 'associative' }),
    { minCommunitySize: 2 },
  );
  assert.equal(fused.communityCount, 1);
});

test('identical input yields an identical plan (determinism)', () => {
  const a = planMemoryCommunities(twoCliquesBridged(), { minCommunitySize: 2 });
  const b = planMemoryCommunities(twoCliquesBridged(), { minCommunitySize: 2 });
  assert.deepEqual(
    a.communities.map((c) => ({ clusterId: c.clusterId, members: [...c.members].sort() })),
    b.communities.map((c) => ({ clusterId: c.clusterId, members: [...c.members].sort() })),
  );
  assert.equal(a.movedNodes, b.movedNodes);
});

test('empty brain: zero communities, unchanged, no crash', () => {
  const plan = planMemoryCommunities(makeMemory({ nodes: [], edges: [] }));
  assert.equal(plan.communityCount, 0);
  assert.equal(plan.movedNodes, 0);
  assert.equal(plan.unchanged, true);
  assert.equal(plan.degenerate, false);
});

test('degenerate flag: one dense blob reports honestly', () => {
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 20; i++) nodes.push(node(i));
  for (let i = 1; i <= 20; i++) {
    for (let j = i + 1; j <= 20; j++) edges.push(edge(i, j, 1));
  }
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 2 });
  assert.equal(plan.degenerate, true);
  assert.ok(plan.communityCount < 3);
});
