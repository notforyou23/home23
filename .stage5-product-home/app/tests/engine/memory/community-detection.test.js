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

function compare(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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
  // one community reclaims prior id 1 (its members stay), the other gets a fresh id
  assert.equal(plan.movedNodes, 6);
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

test('sub-floor appendage folds into its best-connected neighbor community', () => {
  // 12-node core clique + 4-node satellite clique, joined by 3 real edges.
  // Propagation alone absorbs this fixture — the fold-specific pin is the bridge-tethered test below.
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 12; i++) nodes.push(node(i));
  for (let i = 1; i <= 12; i++) for (let j = i + 1; j <= 12; j++) edges.push(edge(i, j, 1));
  for (let i = 21; i <= 24; i++) nodes.push(node(i));
  for (let i = 21; i <= 24; i++) for (let j = i + 1; j <= 24; j++) edges.push(edge(i, j, 1));
  edges.push(edge(1, 21, 1), edge(2, 22, 1), edge(3, 23, 1));
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 6 });
  assert.equal(plan.communityCount, 1);
  assert.equal(plan.communities[0].members.length, 16);
});

test('folding is load-bearing: a bridge-tethered satellite that propagation keeps separate still folds', () => {
  // Same 12-core + 4-satellite shape, but the 3 connecting edges are BRIDGES
  // (vote 0.2 each). Propagation alone keeps the satellite separate — bridges
  // whisper — so only the floor fold can merge it. Red under the identity
  // stub; green once foldSmallCommunities is real.
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 12; i++) nodes.push(node(i));
  for (let i = 1; i <= 12; i++) for (let j = i + 1; j <= 12; j++) edges.push(edge(i, j, 1));
  for (let i = 21; i <= 24; i++) nodes.push(node(i));
  for (let i = 21; i <= 24; i++) for (let j = i + 1; j <= 24; j++) edges.push(edge(i, j, 1));
  edges.push(edge(1, 21, 1, 'bridge'), edge(2, 22, 1, 'bridge'), edge(3, 23, 1, 'bridge'));
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 6 });
  assert.equal(plan.communityCount, 1);
  assert.equal(plan.communities[0].members.length, 16);
});

test('an isolated island below the floor survives — it is a real island', () => {
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 12; i++) nodes.push(node(i));
  for (let i = 1; i <= 12; i++) for (let j = i + 1; j <= 12; j++) edges.push(edge(i, j, 1));
  // 4-node island with NO edges to the core
  for (let i = 31; i <= 34; i++) nodes.push(node(i));
  for (let i = 31; i <= 34; i++) for (let j = i + 1; j <= 34; j++) edges.push(edge(i, j, 1));
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 6 });
  assert.equal(plan.communityCount, 2);
  const sizes = plan.communities.map((c) => c.members.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [4, 12]);
});

test('fold target is chosen by summed connection strength, not strongest single edge', () => {
  // Two 12-cliques A (1..12) and B (21..32), plus a 3-clique fragment F
  // (41..43) below the floor. All tethers are bridge-typed so propagation
  // cannot absorb F. F->A: two w=1 bridges (0.2+0.2=0.4 summed);
  // F->B: one w=1.5 bridge (0.3). Sum semantics fold F into A; a
  // strongest-single-edge mutant would pick B (0.3 > 0.2).
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 12; i++) nodes.push(node(i));
  for (let i = 1; i <= 12; i++) for (let j = i + 1; j <= 12; j++) edges.push(edge(i, j, 1));
  for (let i = 21; i <= 32; i++) nodes.push(node(i));
  for (let i = 21; i <= 32; i++) for (let j = i + 1; j <= 32; j++) edges.push(edge(i, j, 1));
  for (let i = 41; i <= 43; i++) nodes.push(node(i));
  for (let i = 41; i <= 43; i++) for (let j = i + 1; j <= 43; j++) edges.push(edge(i, j, 1));
  edges.push(edge(41, 1, 1, 'bridge'));
  edges.push(edge(42, 2, 1, 'bridge'));
  edges.push(edge(43, 21, 1.5, 'bridge'));
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 6 });
  assert.equal(plan.communityCount, 2);
  const withA = plan.communities.find((c) => c.members.includes(1));
  assert.ok(withA, 'community containing node 1 missing');
  assert.ok(withA.members.includes(41) && withA.members.includes(43),
    'fragment must fold into A (summed 0.4) not B (single 0.3)');
  const withB = plan.communities.find((c) => c.members.includes(21));
  assert.equal(withB.members.length, 12, 'B must not absorb the fragment');
});

test('a fold target that crosses the floor mid-pass stops folding (live-set guard)', () => {
  // Core 12-clique (1..12). Two 4-clique fragments F1 (51..54) and F2
  // (61..64), floor 6. F1<->F2: three w=1 bridges (0.6 summed);
  // F1->core: one w=1 bridge (0.2). F1 folds into F2 first (0.6 > 0.2);
  // F2 then holds 8 members >= floor and must NOT fold anywhere.
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 12; i++) nodes.push(node(i));
  for (let i = 1; i <= 12; i++) for (let j = i + 1; j <= 12; j++) edges.push(edge(i, j, 1));
  for (const base of [50, 60]) {
    for (let i = 1; i <= 4; i++) nodes.push(node(base + i));
    for (let i = 1; i <= 4; i++) for (let j = i + 1; j <= 4; j++) edges.push(edge(base + i, base + j, 1));
  }
  edges.push(edge(51, 61, 1, 'bridge'));
  edges.push(edge(52, 62, 1, 'bridge'));
  edges.push(edge(53, 63, 1, 'bridge'));
  edges.push(edge(54, 1, 1, 'bridge'));
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 6 });
  assert.equal(plan.communityCount, 2);
  const sizes = plan.communities.map((c) => c.members.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [8, 12], 'fragments merge with each other, not into the core');
});

test('a community keeps the prior cluster id it inherited the plurality of members from', () => {
  // Clique A carries prior cluster 7 (numeric); clique B prior cluster '9' (string).
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 6; i++) nodes.push(node(i, 7));
  for (let i = 11; i <= 16; i++) nodes.push(node(i, '9'));
  for (const base of [0, 10]) {
    for (let i = 1; i <= 6; i++) {
      for (let j = i + 1; j <= 6; j++) edges.push(edge(base + i, base + j, 1));
    }
  }
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2);
  const ids = plan.communities.map((c) => c.clusterId).sort(compare);
  // original-typed values preserved: numeric 7 stays numeric, string '9' stays string
  assert.deepEqual(ids, [7, '9']);
  // nobody moved: the detected partition matches the prior assignment exactly
  assert.equal(plan.movedNodes, 0);
  assert.equal(plan.unchanged, true);
});

test('second run seeded from first-run communities moves zero nodes on an unchanged graph', () => {
  const memory = twoCliquesBridged();
  const first = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(first.communityCount, 2);
  // Exactly one community reclaims the uniform prior id 1; the other is fresh.
  assert.equal(first.communities.filter((c) => c.clusterId === null).length, 1);
  // Simulate apply: fresh communities get numeric ids, claimed ids stick.
  const assigned = first.communities.map(
    (community, index) => (community.clusterId === null ? 100 + index : community.clusterId),
  );
  first.communities.forEach((community, index) => {
    for (const id of community.members) memory.nodes.get(id).cluster = assigned[index];
  });
  const second = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(second.movedNodes, 0);
  assert.equal(second.unchanged, true);
  // Claim-order-agnostic: the second run must keep exactly the applied ids.
  assert.deepEqual(
    second.communities.map((c) => String(c.clusterId)).sort(),
    assigned.map(String).sort(),
  );
});

test('a genuinely new dense component gets clusterId null (fresh id allocated at apply)', () => {
  const memory = twoCliquesBridged();
  // Add a THIRD clique whose nodes have prior cluster null.
  for (let i = 21; i <= 26; i++) memory.nodes.set(21000 + i, { id: 21000 + i, cluster: null, concept: `c${i}` });
  for (let i = 21; i <= 26; i++) {
    for (let j = i + 1; j <= 26; j++) {
      memory.edges.set(`${21000 + i}->${21000 + j}`, { source: 21000 + i, target: 21000 + j, weight: 1, type: 'associative' });
    }
  }
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 3);
  const freshGroups = plan.communities.filter((c) => c.clusterId === null);
  // prior world had ONE claimable id (cluster 1) — only one community can keep it
  assert.equal(freshGroups.length, 2);
  assert.equal(String(plan.communities.find((c) => c.clusterId !== null).clusterId), '1');
});

test('greedy claiming: the larger-overlap community wins a contested prior id; the loser gets null', () => {
  // X: 8-clique, all prior cluster 1 → label c:1, plurality '1' (overlap 8).
  // Y: 6 nodes, 4 with prior 1 (ids 21-24) weakly interlinked (w 0.1) and 2
  // with prior 2 (ids 31,32) heavily linked to everyone in Y (w 5). Heavy
  // edges pull all of Y to label c:2, but Y's member plurality is still '1'
  // (4 > 2) — so X and Y CONTEND for prior id 1. X wins on overlap (8 > 4);
  // Y gets null, NOT its second-choice id 2 (one claim per community).
  // movedNodes: X keeps id 1 (0 moves) + all of Y moves (6) = 6.
  // Minority-plurality mutant → Y claims '2' → 4 moves. Overlap-ascending
  // mutant → Y claims '1', X gets null → 10 moves. Either flips the number.
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 8; i++) nodes.push(node(i, 1));
  for (let i = 1; i <= 8; i++) for (let j = i + 1; j <= 8; j++) edges.push(edge(i, j, 1));
  for (const id of [21, 22, 23, 24]) nodes.push(node(id, 1));
  for (const id of [31, 32]) nodes.push(node(id, 2));
  const yIds = [21, 22, 23, 24, 31, 32];
  for (let a = 0; a < yIds.length; a++) {
    for (let b = a + 1; b < yIds.length; b++) {
      const bothWeak = yIds[a] < 30 && yIds[b] < 30;
      edges.push(edge(yIds[a], yIds[b], bothWeak ? 0.1 : 5));
    }
  }
  const plan = planMemoryCommunities(makeMemory({ nodes, edges }), { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2);
  const xCommunity = plan.communities.find((c) => c.members.includes(1));
  assert.ok(xCommunity, 'X community missing');
  assert.equal(String(xCommunity.clusterId), '1', 'X (overlap 8) must win the contested id');
  const yCommunity = plan.communities.find((c) => c.members.includes(21));
  assert.ok(yCommunity, 'Y community missing');
  assert.equal(yCommunity.clusterId, null, 'Y must get null, not fall back to id 2');
  assert.equal(plan.movedNodes, 6);
});
