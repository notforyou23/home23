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

test('bridge discount is load-bearing: bridges whisper, associative links pull', () => {
  // Node 900 sits between clique A (1..6, ONE associative edge to node 1)
  // and clique B (11..16, THREE edges to 11,12,13). At full weight the three
  // B-side edges outvote A (3 > 1) and 900 joins B; discounted as bridges
  // (3 x 0.2 = 0.6 < 1) the single associative edge wins and 900 joins A.
  function withCrossType(type) {
    const memory = twoCliquesBridged({ bridgeType: 'bridge' });
    memory.nodes.set(900, node(900));
    const add = (a, b, w, t) => memory.edges.set(`${a}->${b}`, edge(a, b, w, t));
    add(900, 1, 1, 'associative');
    add(900, 11, 1, type);
    add(900, 12, 1, type);
    add(900, 13, 1, type);
    return memory;
  }
  const communityOf = (plan, id) => plan.communities.find((c) => c.members.includes(id));
  const whispered = planMemoryCommunities(withCrossType('bridge'), { minCommunitySize: 2 });
  const w900 = communityOf(whispered, 900);
  assert.ok(w900, 'node 900 missing from all communities (bridge case)');
  assert.ok(w900.members.includes(1),
    'discounted bridges: 900 must stay with clique A');
  const pulled = planMemoryCommunities(withCrossType('associative'), { minCommunitySize: 2 });
  const p900 = communityOf(pulled, 900);
  assert.ok(p900, 'node 900 missing from all communities (associative case)');
  assert.ok(p900.members.includes(11),
    'full-weight links: 900 must be pulled to clique B');
});

test('sum voting is load-bearing: two weaker edges outvote one stronger edge', () => {
  // Node 900: TWO 0.6-weight associative edges into clique A vs ONE 1.0-weight
  // associative edge into clique B. Summed votes: A 1.2 > B 1.0 → 900 joins A.
  // Under strongest-single-edge (max) voting B's 1.0 would win — that mutant
  // is single-linkage clustering and must stay dead.
  const memory = twoCliquesBridged({ bridgeType: 'bridge' });
  memory.nodes.set(900, node(900));
  const add = (a, b, w, t) => memory.edges.set(`${a}->${b}`, edge(a, b, w, t));
  add(900, 1, 0.6, 'associative');
  add(900, 2, 0.6, 'associative');
  add(900, 11, 1, 'associative');
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  const communityOf = (id) => plan.communities.find((c) => c.members.includes(id));
  const c900 = communityOf(900);
  assert.ok(c900, 'node 900 missing from all communities');
  assert.ok(c900.members.includes(1),
    'summed votes (1.2) must beat the single strongest edge (1.0)');
});

test('tie handling: equal summed votes retain the current label; forced moves pick the smaller label', () => {
  // Stage 1 (tie-break direction): three prior clusters — clique A = 7,
  // clique B = 8, node 500 alone in cluster 9 — with ONE 1.0 edge into each
  // clique. 500's votes are c:7 = 1 vs c:8 = 1 and its own c:9 scores 0, so
  // it MUST move (strict improvement satisfied) and the tie breaks to the
  // smaller label: c:7, clique A. A flipped comparator sends it to c:8.
  // The singleton-seeded path cannot pin the comparator direction: under
  // largest-wins, the contested node's own label ('n:500' sorts above every
  // clique label) becomes the tie attractor clique B consolidates onto,
  // grouping 500 with B for the wrong reason — and no node id can sort above
  // 'n:2' yet below 'n:16', so no id choice fixes that. Cluster seeding has
  // no singleton labels to leak.
  const memory = twoCliquesBridged({ bridgeType: 'bridge' });
  for (const [id, n] of memory.nodes) n.cluster = id <= 6 ? 7 : 8; // two prior clusters
  memory.nodes.set(500, { id: 500, cluster: 9, concept: 'tied node' });
  const add = (a, b, w, t) => memory.edges.set(`${a}->${b}`, edge(a, b, w, t));
  add(500, 1, 1, 'associative');   // votes for c:7 — smaller label, must win the tie
  add(500, 11, 1, 'associative');  // votes for c:8
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  const c500 = plan.communities.find((c) => c.members.includes(500));
  assert.ok(c500, 'node 500 missing from all communities');
  assert.ok(c500.members.includes(1),
    'tie between cluster labels must break to the smaller label (c:7, clique A)');

  // Stage 2 (strictness guard): seed from clusters, with 500's OWN cluster
  // being the LARGER label (c:8) and the tied competitor the SMALLER (c:7).
  // Tie-break selects c:7 as best (≠ current), scores are equal — strict `>`
  // keeps 500 in clique B; the `>=` mutant would move it to clique A.
  const memory2 = twoCliquesBridged({ bridgeType: 'bridge' });
  for (const [id, n] of memory2.nodes) n.cluster = id <= 6 ? 7 : 8; // two prior clusters
  memory2.nodes.set(500, { id: 500, cluster: 8, concept: 'tied node' });
  const add2 = (a, b, w, t) => memory2.edges.set(`${a}->${b}`, edge(a, b, w, t));
  add2(500, 1, 1, 'associative');   // votes for c:7 — smaller competing label
  add2(500, 11, 1, 'associative');  // votes for c:8 — its own
  const plan2 = planMemoryCommunities(memory2, { minCommunitySize: 2 });
  const c500b = plan2.communities.find((c) => c.members.includes(500));
  assert.ok(c500b, 'node 500 missing (stage 2)');
  assert.ok(c500b.members.includes(11),
    'equal scores must retain the current cluster (8, clique B) — strict improvement only');
});

test('garbage edges are ignored: NaN weight, dangling endpoints, self-loops', () => {
  const memory = twoCliquesBridged({ bridgeType: 'bridge' });
  const add = (a, b, w, t) => memory.edges.set(`${a}->${b}`, edge(a, b, w, t));
  add(1, 2, NaN, 'associative');       // NaN weight
  add(1, 999, 1, 'associative');       // dangling endpoint
  add(3, 3, 1, 'associative');         // self-loop
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2); // unchanged split, no crash
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
