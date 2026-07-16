# Graph Community Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine-level community detection that partitions every agent brain's single mega-cluster into organic, edge-structure-derived communities — persisted through delta records, consumed by PGS/brain-map/cognition with zero downstream changes.

**Architecture:** A pure seeded-label-propagation planner (`engine/src/memory/community-detection.js`, mirroring `recluster.js`), a barrier-protected `NetworkMemory.applyCommunityPlan` mutation reusing `_moveNodeToClusterUnsafe`/`_allocateClusterIdUnsafe`, a dry-run/apply admin endpoint sibling to `/admin/memory/cleanup/recluster`, and a nightly driver script looping all agents. Spec: `docs/superpowers/specs/2026-07-16-community-detection-design.md`.

**Tech Stack:** Pure Node.js (no deps), `node:test` + `node:assert/strict` tests via `createRequire`, bash driver, home-level cron entry.

**Live-system rules that bind every task:**
- Brain persistence is sacred. `network-memory.js` changes are persistence-adjacent → standalone load test before ANY engine restart (Task 8 does this; no task before it restarts anything).
- Both engines are live and rebuilding (jerry ~22.7k nodes, forrest ~300). Nothing before Task 8 touches a running process.
- Event rule: zero moves ⇒ no barrier entry, no backup, no save, no receipt.
- **Task 8 ends in a HARD STOP for jtr's review of the live dry-run. Task 9 is blocked until he approves.**

---

## File map

| File | Role |
|---|---|
| Create `engine/src/memory/community-detection.js` | Pure planner: `planMemoryCommunities`, `applyMemoryCommunities` wrapper |
| Create `tests/engine/memory/community-detection.test.js` | Planner unit tests (Tasks 1–3) + mutation-test targets (Task 4) |
| Modify `engine/src/memory/network-memory.js` (immediately after `applyReclusterPlan`, ~line 1410) | `applyCommunityPlan` mutation method |
| Create `tests/engine/memory/network-memory-community-plan.test.js` | Mutation-method tests (Task 5) |
| Modify `engine/src/realtime/websocket-server.js` (~line 23 require block, ~line 660 after recluster endpoint) | `/admin/memory/cleanup/communities` endpoint |
| Create `scripts/run-community-detection.sh` | Nightly driver looping `instances/*/config.yaml` |
| Modify `config/cron-jobs.json` | `community-detection-nightly` entry, 03:45 ET |

Branch: `codex/community-detection` in a worktree (`git worktree add ../home23-worktrees/community-detection -b codex/community-detection`). Tasks 1–7 run there. Task 8 merges to `main` in the live checkout before restarting jerry.

---

### Task 1: Planner core — seeding, propagation, plan shape

**Files:**
- Create: `engine/src/memory/community-detection.js`
- Test: `tests/engine/memory/community-detection.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/engine/memory/community-detection.test.js`:

```js
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
  // NOTE: two cliques joined by two weak edges staying separate at ANY weight
  // is CORRECT sum-voting behavior — do not "fix" the algorithm to fuse them
  // (that is single-linkage clustering; it chains real brains into one blob).
  // Node id 900 is deliberate: label 'n:900' sorts after clique labels and
  // never wins tie-breaks.
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
  assert.ok(communityOf(whispered, 900).members.includes(1),
    'discounted bridges: 900 must stay with clique A');
  const pulled = planMemoryCommunities(withCrossType('associative'), { minCommunitySize: 2 });
  assert.ok(communityOf(pulled, 900).members.includes(11),
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
  assert.ok(communityOf(900).members.includes(1),
    'summed votes (1.2) must beat the single strongest edge (1.0)');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/engine/memory/community-detection.test.js`
Expected: FAIL — `Cannot find module '.../community-detection.js'`

- [ ] **Step 3: Write the planner**

Create `engine/src/memory/community-detection.js`. Complete file (floor folding and
id-reuse arrive in Tasks 2–3; the hooks below are written so those tasks only fill
in the two marked functions — everything else is final):

```js
'use strict';

/**
 * Graph community detection — seeded label propagation.
 *
 * Every brain to date lived in a single cluster: `_assignToClusterUnsafe`
 * adopts each newborn into its neighbors' majority cluster, so the first
 * cluster conquered the world at birth-time and nothing global ever
 * corrected it. This planner is the global correction: it derives
 * communities from actual edge structure, keeps ids stable across runs,
 * and reports honestly when the graph is one dense blob.
 *
 * Pure module — no mutation. Apply via NetworkMemory.applyCommunityPlan.
 * Spec: docs/superpowers/specs/2026-07-16-community-detection-design.md
 */

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MIN_COMMUNITY_SIZE = 12;

function compareAsStrings(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeNodeId(memory, rawId) {
  if (memory.nodes.has(rawId)) return rawId;
  const text = String(rawId);
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (memory.nodes.has(numeric)) return numeric;
  }
  if (memory.nodes.has(text)) return text;
  return rawId;
}

function edgeEndpoints(key, edge, memory) {
  let source = edge?.source;
  let target = edge?.target;
  if ((source === undefined || target === undefined) && typeof key === 'string') {
    const parts = key.split('->');
    source = parts[0];
    target = parts[1];
  }
  if (source === undefined || target === undefined) return null;
  return [normalizeNodeId(memory, source), normalizeNodeId(memory, target)];
}

function hasCluster(node) {
  return node?.cluster !== null && node?.cluster !== undefined;
}

function buildAdjacency(memory, nodeIds, { bridgeVote, minEdgeWeight }) {
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const [key, edge] of memory.edges) {
    const endpoints = edgeEndpoints(key, edge, memory);
    if (!endpoints) continue;
    const [source, target] = endpoints;
    if (source === target) continue;
    if (!adjacency.has(source) || !adjacency.has(target)) continue;
    const weight = Number(edge?.weight ?? 0);
    if (!(weight > 0) || weight < minEdgeWeight) continue;
    const vote = weight * (edge?.type === 'bridge' ? bridgeVote : 1);
    if (!(vote > 0)) continue;
    adjacency.get(source).push([target, vote]);
    adjacency.get(target).push([source, vote]);
  }
  return adjacency;
}

function propagateLabels(nodeIds, adjacency, labels, maxIterations) {
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    iterations += 1;
    let moves = 0;
    for (const id of nodeIds) {
      const neighbors = adjacency.get(id);
      if (neighbors.length === 0) continue;
      const votes = new Map();
      for (const [neighborId, vote] of neighbors) {
        const label = labels.get(neighborId);
        votes.set(label, (votes.get(label) || 0) + vote);
      }
      let best = null;
      let bestScore = -Infinity;
      for (const [label, score] of votes) {
        if (score > bestScore
            || (score === bestScore && compareAsStrings(label, best) < 0)) {
          best = label;
          bestScore = score;
        }
      }
      const current = labels.get(id);
      const currentScore = votes.get(current) || 0;
      // Move only on a STRICT improvement: retaining the current label on
      // ties is what keeps successive runs stable instead of churning.
      if (best !== current && bestScore > currentScore) {
        labels.set(id, best);
        moves += 1;
      }
    }
    if (moves === 0) {
      converged = true;
      break;
    }
  }
  return { iterations, converged };
}

// Task 2 fills this in. Until then, no folding (identity).
function foldSmallCommunities(groups, adjacency, minCommunitySize) {
  return groups;
}

// Task 3 fills this in. Until then, every community gets a fresh id.
function assignStableClusterIds(groups, memory) {
  return groups.map((group) => ({ clusterId: null, members: group.members }));
}

function planMemoryCommunities(memory, options = {}) {
  const nodes = memory?.nodes instanceof Map ? memory.nodes : new Map();
  const bridgeVote = Number(
    options.bridgeVote ?? memory?.config?.spreading?.bridgeTraversalFactor ?? 0.2,
  );
  const maxIterations = Math.min(100, Math.max(1, Number(options.maxIterations) || DEFAULT_MAX_ITERATIONS));
  const minCommunitySize = Math.min(500, Math.max(2, Number(options.minCommunitySize) || DEFAULT_MIN_COMMUNITY_SIZE));
  const minEdgeWeight = Number(options.minEdgeWeight ?? 0);

  const nodeIds = Array.from(nodes.keys()).sort(compareAsStrings);
  const totalNodes = nodeIds.length;
  const scopedMemory = { nodes, edges: memory?.edges instanceof Map ? memory.edges : new Map() };
  const adjacency = buildAdjacency(scopedMemory, nodeIds, { bridgeVote, minEdgeWeight });

  // Seeding: stability after structure. >1 distinct prior cluster → seed from
  // clusters (subsequent runs move only genuinely re-wired nodes). Otherwise
  // (virgin uniform/unclustered brain) seed singletons — a uniform seed over a
  // dense region can never split from within, which is exactly the mega-ball
  // this module exists to break.
  const distinctPriorClusters = new Set();
  for (const node of nodes.values()) {
    if (hasCluster(node)) distinctPriorClusters.add(String(node.cluster));
  }
  const seededFromClusters = distinctPriorClusters.size > 1;
  const labels = new Map();
  for (const id of nodeIds) {
    const node = nodes.get(id);
    labels.set(
      id,
      seededFromClusters && hasCluster(node) ? `c:${String(node.cluster)}` : `n:${String(id)}`,
    );
  }

  const { iterations, converged } = propagateLabels(nodeIds, adjacency, labels, maxIterations);

  // Group by final label (deterministic member order).
  const byLabel = new Map();
  for (const id of nodeIds) {
    const label = labels.get(id);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(id);
  }
  let groups = Array.from(byLabel.entries())
    .map(([label, members]) => ({ label, members }))
    .sort((a, b) => b.members.length - a.members.length || compareAsStrings(a.label, b.label));

  groups = foldSmallCommunities(groups, adjacency, minCommunitySize);

  const communities = assignStableClusterIds(groups, { nodes });

  let movedNodes = 0;
  const sample = [];
  for (const community of communities) {
    for (const nodeId of community.members) {
      const node = nodes.get(nodeId);
      const from = hasCluster(node) ? node.cluster : null;
      const moves = community.clusterId === null
        ? true
        : String(from) !== String(community.clusterId) || from === null;
      if (!moves) continue;
      movedNodes += 1;
      if (sample.length < 20) {
        sample.push({
          id: String(nodeId),
          from: from === null ? null : String(from),
          to: community.clusterId === null ? 'new' : String(community.clusterId),
          preview: String(node?.concept || '').slice(0, 120),
        });
      }
    }
  }

  const largest = communities.reduce((max, c) => Math.max(max, c.members.length), 0);
  const degenerate = totalNodes > 0
    && (largest > totalNodes * 0.5 || communities.length < 3);

  return {
    communityCount: communities.length,
    movedNodes,
    unchanged: movedNodes === 0,
    converged,
    iterations,
    degenerate,
    communities,
    sizes: communities
      .map((c) => ({ clusterId: c.clusterId, size: c.members.length }))
      .sort((a, b) => b.size - a.size),
    sample,
  };
}

function applyMemoryCommunities(memory, plan) {
  if (!memory?.nodes || !plan) {
    return { movedNodes: 0, createdClusters: 0, communityCount: 0 };
  }
  if (typeof memory.applyCommunityPlan !== 'function') {
    throw new Error('memory_communities_mutation_api_required');
  }
  return memory.applyCommunityPlan(plan);
}

module.exports = {
  applyMemoryCommunities,
  planMemoryCommunities,
};
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/engine/memory/community-detection.test.js`
Expected: 8 pass, 0 fail after the quality-fix pass (tie-handling + garbage-edges tests included). (The empty-brain degenerate assertion passes because
`totalNodes > 0` guards the flag; the 20-clique test yields 1 community from
singleton seeds via propagation — degenerate true.)

Note: if the discount test fails, check the vote arithmetic at node 900 —
bridges: 3 × 0.2 = 0.6 vs 1.0 associative (A wins); full weight: 3.0 vs 1.0
(B wins). Debug the arithmetic; never swap sum-voting for max-voting.

- [ ] **Step 5: Commit**

```bash
git add engine/src/memory/community-detection.js tests/engine/memory/community-detection.test.js
git commit -m "feat(memory): community detection planner core — seeded label propagation"
```

---

### Task 2: Floor folding — small communities merge into their strongest neighbor

**Files:**
- Modify: `engine/src/memory/community-detection.js` (replace `foldSmallCommunities`)
- Test: `tests/engine/memory/community-detection.test.js` (append)

- [ ] **Step 1: Write the failing tests** (append to the test file)

```js
test('sub-floor appendage folds into its best-connected neighbor community', () => {
  // 12-node core clique + 4-node satellite clique, joined by 3 real edges.
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/engine/memory/community-detection.test.js`
Expected: first new test FAILS (appendage stays separate → communityCount 2);
island test may already pass — that is fine, it pins behavior.

- [ ] **Step 3: Implement folding** (replace the Task 1 stub)

```js
function foldSmallCommunities(groups, adjacency, minCommunitySize) {
  const labelOf = new Map();
  const members = new Map();
  for (const group of groups) {
    members.set(group.label, new Set(group.members));
    for (const id of group.members) labelOf.set(id, group.label);
  }

  let folded = true;
  while (folded) {
    folded = false;
    // Deterministic order: smallest community first, then label.
    const candidates = Array.from(members.entries())
      .filter(([, ids]) => ids.size > 0 && ids.size < minCommunitySize)
      .sort((a, b) => a[1].size - b[1].size || compareAsStrings(a[0], b[0]));
    for (const [label, ids] of candidates) {
      if (!members.has(label) || members.get(label).size >= minCommunitySize) continue;
      const external = new Map();
      for (const id of ids) {
        for (const [neighborId, vote] of adjacency.get(id) || []) {
          const neighborLabel = labelOf.get(neighborId);
          if (neighborLabel === label) continue;
          external.set(neighborLabel, (external.get(neighborLabel) || 0) + vote);
        }
      }
      if (external.size === 0) continue; // genuinely isolated island — keep it
      let target = null;
      let targetScore = -Infinity;
      for (const [neighborLabel, score] of external) {
        if (score > targetScore
            || (score === targetScore && compareAsStrings(neighborLabel, target) < 0)) {
          target = neighborLabel;
          targetScore = score;
        }
      }
      const targetSet = members.get(target);
      for (const id of ids) {
        targetSet.add(id);
        labelOf.set(id, target);
      }
      members.delete(label);
      folded = true;
    }
  }

  return Array.from(members.entries())
    .map(([label, ids]) => ({ label, members: Array.from(ids).sort(compareAsStrings) }))
    .sort((a, b) => b.members.length - a.members.length || compareAsStrings(a.label, b.label));
}
```

- [ ] **Step 4: Run the full planner test file**

Run: `node --test tests/engine/memory/community-detection.test.js`
Expected: 10 pass, 0 fail (Task 1 tests must still pass — they use
`minCommunitySize: 2`, which folding never triggers on groups ≥ 2).

- [ ] **Step 5: Commit**

```bash
git add engine/src/memory/community-detection.js tests/engine/memory/community-detection.test.js
git commit -m "feat(memory): community floor folding — fragments merge, islands survive"
```

---

### Task 3: Id stability — plurality reuse, moved counting, second-run stability

**Files:**
- Modify: `engine/src/memory/community-detection.js` (replace `assignStableClusterIds`)
- Test: `tests/engine/memory/community-detection.test.js` (append)

- [ ] **Step 1: Write the failing tests** (append)

```js
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
  assert.ok(ids.includes(7));
  assert.ok(ids.includes('9'));
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
  // Give clique 1 a prior id so it can be claimed; clique 2 keeps uniform 1 too —
  // both claim candidates. Then add a THIRD clique with prior cluster null.
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
});
```

Add this helper next to the other fixtures (top of file):

```js
function compare(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/engine/memory/community-detection.test.js`
Expected: all three new tests FAIL (`clusterId` is always `null` from the stub;
movedNodes counts everyone).

- [ ] **Step 3: Implement id stability** (replace the Task 1 stub)

```js
function assignStableClusterIds(groups, memory) {
  // For each group, tally members' prior cluster ids — keyed by String() so
  // numeric 1 and '1' agree, but remembering the first-seen ORIGINAL value so
  // reuse never hands the clusters map a type-flipped id.
  const claims = [];
  groups.forEach((group, index) => {
    const priorCounts = new Map();
    for (const id of group.members) {
      const node = memory.nodes.get(id);
      if (!hasCluster(node)) continue;
      const key = String(node.cluster);
      const entry = priorCounts.get(key) || { count: 0, original: node.cluster };
      entry.count += 1;
      priorCounts.set(key, entry);
    }
    let bestKey = null;
    let best = null;
    for (const [key, entry] of priorCounts) {
      if (!best || entry.count > best.count
          || (entry.count === best.count && compareAsStrings(key, bestKey) < 0)) {
        best = entry;
        bestKey = key;
      }
    }
    if (best) {
      claims.push({
        index,
        key: bestKey,
        original: best.original,
        overlap: best.count,
        size: group.members.length,
        smallestMember: group.members[0],
      });
    }
  });

  // Greedy claim: largest overlap wins each prior id; ties → larger group,
  // then smallest member id. One claim per prior id.
  claims.sort((a, b) => b.overlap - a.overlap
    || b.size - a.size
    || compareAsStrings(a.smallestMember, b.smallestMember));
  const claimedKeys = new Set();
  const assigned = new Map();
  for (const claim of claims) {
    if (claimedKeys.has(claim.key)) continue;
    claimedKeys.add(claim.key);
    assigned.set(claim.index, claim.original);
  }

  return groups.map((group, index) => ({
    clusterId: assigned.has(index) ? assigned.get(index) : null,
    members: group.members,
  }));
}
```

- [ ] **Step 4: Run the full planner file**

Run: `node --test tests/engine/memory/community-detection.test.js`
Expected: 13 pass, 0 fail. Task 1's split test still expects `movedNodes: 12` —
both cliques share prior cluster 1, only one community can claim it, and its
members then don't move… **check the assertion**: the claiming community's 6
members keep cluster 1 → they do NOT move. Update Task 1's split test now that id
reuse exists:

```js
  // was: assert.equal(plan.movedNodes, 12);
  // one community reclaims prior id 1 (its members stay), the other gets a fresh id:
  assert.equal(plan.movedNodes, 6);
```

Re-run. Expected: 13 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add engine/src/memory/community-detection.js tests/engine/memory/community-detection.test.js
git commit -m "feat(memory): stable community ids via plurality reuse"
```

---

### Task 4: Mutation testing — prove the tests bite

House rule from this project: tests have passed against weakened implementations
four times. Each mutant below must make at least one NAMED test fail; if it
doesn't, STOP and strengthen the test before proceeding.

**Files:** `tests/engine/memory/community-detection.test.js` (Step 0 strengthening), then temporary module edits, always restored

- [ ] **Step 0: Add the contention fixture (kills Mutants F and G below — Task 3's quality review proved both survive the current suite)**

Grouping is by LABEL, not connected component — two disconnected cliques sharing
a prior cluster seed the same `c:` label and merge into ONE group, so plurality
contention between two groups needs the group label to DIVERGE from the member
plurality. Equal-weight cliques can never do that (label majority = plurality
majority); weight asymmetry can:

```js
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
```

Also apply two review nits while in the file: in the plurality-reuse test replace
the two `.includes()` asserts with `assert.deepEqual(ids, [7, '9'])`; in the
fresh-component test assert the surviving claimed id is `'1'`
(`assert.equal(String(plan.communities.find((c) => c.clusterId !== null).clusterId), '1')`).
Run the file: 17 pass / 0 fail. Commit as
"test(memory): contention fixture — greedy claim direction now pinned".

- [ ] **Step 1: Mutant A — break the bridge discount**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
# bridge edges vote at full weight:
sed -i '' "s/edge?.type === 'bridge' ? bridgeVote : 1/edge?.type === 'bridge' ? 1 : 1/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -E "^✖|fail [0-9]"
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: `✖ bridge discount is load-bearing…` fails (node 900's "whispered"
assertion — at full bridge weight it gets pulled to clique B). The split test
still passes under this mutant (two weak cross-edges cannot fuse dense cliques
under sum voting at any weight — that is by design). If zero failures: STOP, fix
the fixture.

- [ ] **Step 2: Mutant B — break the tie-break**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
sed -i '' "s/compareAsStrings(label, best) < 0/compareAsStrings(label, best) > 0/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -cE "^✖" 
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: ≥1 failure (determinism or split-shape test). If zero: add a fixture
with a genuine tie (two equal-weight neighbor labels) asserting the smaller label
wins, then re-run the mutant.

- [ ] **Step 3: Mutant C — break plurality claiming**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
# every community gets null (no reuse):
sed -i '' "s/clusterId: assigned.has(index) ? assigned.get(index) : null/clusterId: null/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -cE "^✖"
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: ≥2 failures (plurality-reuse test, second-run stability test).

- [ ] **Step 3b: Mutant D — break move strictness**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
# ties now move instead of retaining the current label:
sed -i '' "s/bestScore > currentScore/bestScore >= currentScore/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -cE "^✖"
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: ≥1 failure — the tie-handling test's stage-2 assertion (equal scores
must retain the current cluster). Quality review found this mutant surviving the
original Task 1 suite; the tie fixture added in Task 1's quality-fix pass is its
designated killer. If zero failures: STOP, the tie fixture regressed.

(Also note: a sum→max voting mutant — the rejected single-linkage variant — is
permanently guarded by the 'sum voting is load-bearing' test; no separate Task 4
step needed, but do not remove that test.)

- [ ] **Step 3c: Mutant E — break fold target selection**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
# fold tally becomes strongest-single-edge instead of summed:
sed -i '' "s/external.set(neighborLabel, (external.get(neighborLabel) || 0) + vote)/external.set(neighborLabel, Math.max(external.get(neighborLabel) || 0, vote))/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -cE "^✖"
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: ≥1 failure — 'fold target is chosen by summed connection strength…'
(fragment folds to B under max, to A under sum).

**Known EQUIVALENT mutant — do not chase:** deleting the fold's `while (folded)`
loop (single working pass) passes every test and is semantically equivalent: the
pass-1 candidate snapshot already contains every community that can ever be
sub-floor (folds never shrink communities), live sets accumulate mid-pass, and
grown candidates are skipped by the floor guard — so the second pass is always
the quiet termination check. A surviving mutant HERE is not a test gap.

- [ ] **Step 3d: Mutant F — plurality direction**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
sed -i '' "s/entry.count > best.count/entry.count < best.count/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -cE "^✖"
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: ≥1 failure — the Step 0 contention test (Y claims '2' → movedNodes 4 ≠ 6).

- [ ] **Step 3e: Mutant G — greedy claim order**

```bash
cp engine/src/memory/community-detection.js /tmp/cd.bak
sed -i '' "s/claims.sort((a, b) => b.overlap - a.overlap/claims.sort((a, b) => a.overlap - b.overlap/" engine/src/memory/community-detection.js
node --test tests/engine/memory/community-detection.test.js 2>&1 | grep -cE "^✖"
cp /tmp/cd.bak engine/src/memory/community-detection.js
```

Expected: ≥1 failure — the Step 0 contention test (Y claims '1', X nulls → movedNodes 10 ≠ 6).

- [ ] **Step 4: Verify restoration + full pass**

```bash
git diff --stat engine/src/memory/community-detection.js   # must be empty
node --test tests/engine/memory/community-detection.test.js
```

Expected: no diff; 13 pass.

- [ ] **Step 5: Commit** (test strengthening only, if any was needed)

```bash
git add -A tests/engine/memory/community-detection.test.js
git commit -m "test(memory): strengthen community-detection tests found soft under mutation" --allow-empty
```

---

### Task 5: `NetworkMemory.applyCommunityPlan` — barrier-protected mutation

**Files:**
- Modify: `engine/src/memory/network-memory.js` (insert immediately after the
  `applyReclusterPlan` method's closing brace, before `_moveNodeToClusterUnsafe`)
- Test: Create `tests/engine/memory/network-memory-community-plan.test.js`

- [ ] **Step 1: Read the primitives first (do not skip)**

Read `_moveNodeToClusterUnsafe` in full (`grep -n "_moveNodeToClusterUnsafe" engine/src/memory/network-memory.js`,
then read that method to its end). Confirm: (a) it returns a boolean-ish signal
(`false` on same-cluster/missing-node; check what it returns on success), (b) it
calls `this._markNodeDirtyUnsafe(nodeId)`, (c) it maintains `this.clusters` and
deletes emptied clusters. Also read `_allocateClusterIdUnsafe`. If (a) shows it
returns `undefined` on success, count moves by comparing `node.cluster` before
and after instead of trusting the return value — adjust the implementation below
accordingly and note it in the commit message.

- [ ] **Step 2: Write the failing tests**

Create `tests/engine/memory/network-memory-community-plan.test.js`:

```js
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

test('newborn wired into a community is adopted at birth (spec §6 claim, verified)', async () => {
  const { memory, ids } = await seededMemory();
  applyMemoryCommunities(memory, planMemoryCommunities(memory, { minCommunitySize: 2 }));
  const cliqueACluster = memory.nodes.get(ids[0]).cluster;
  // New node whose only edges point into clique A — _assignToClusterUnsafe
  // runs inside addNode AFTER initial edges exist only when similarity
  // creates them; embeddings are off here, so wire edges first, then
  // re-run the engine's own birth-adoption primitive directly.
  const newborn = await memory.addNode('newborn about clique A topics', 'general');
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(newborn.id, ids[0], 1, 'associative', { enforceBridgeCap: false });
    memory._upsertEdgeUnsafe(newborn.id, ids[1], 1, 'associative', { enforceBridgeCap: false });
    memory._assignToClusterUnsafe(newborn.id);
  });
  assert.equal(String(memory.nodes.get(newborn.id).cluster), String(cliqueACluster),
    'newborn must join its neighborhood community at birth');
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/engine/memory/network-memory-community-plan.test.js`
Expected: FAIL — `memory.applyCommunityPlan is not a function` (first three);
the typed-error test may already pass (wrapper shipped in Task 1).

- [ ] **Step 4: Implement `applyCommunityPlan`** (insert after `applyReclusterPlan` in `network-memory.js`)

```js
  applyCommunityPlan(plan) {
    if (!plan || typeof plan !== 'object') {
      return { movedNodes: 0, createdClusters: 0, communityCount: 0 };
    }
    const communities = Array.from(plan.communities || [])
      .map((community) => ({
        clusterId: community?.clusterId ?? null,
        members: Array.from(new Set(community?.members || []))
          .filter((nodeId) => this.nodes.has(nodeId)),
      }))
      .filter((community) => community.members.length > 0);
    const communityCount = communities.length;

    // Event rule: a plan that moves nothing must not enter the barrier or
    // advance the persistence generation.
    const nodeNeedsMove = (nodeId, clusterId) => {
      const node = this.nodes.get(nodeId);
      if (!node) return false;
      if (clusterId === null) return true; // fresh community: every member moves
      if (node.cluster === null || node.cluster === undefined) return true;
      return String(node.cluster) !== String(clusterId);
    };
    const hasAcceptedMove = communities.some(({ clusterId, members }) =>
      members.some((nodeId) => nodeNeedsMove(nodeId, clusterId)));
    if (!hasAcceptedMove) {
      return { movedNodes: 0, createdClusters: 0, communityCount };
    }

    return this.withPersistenceBarrier(() => {
      let movedNodes = 0;
      let createdClusters = 0;
      for (const { clusterId, members } of communities) {
        const moving = members.filter((nodeId) => nodeNeedsMove(nodeId, clusterId));
        if (moving.length === 0) continue;
        let targetClusterId = clusterId;
        if (targetClusterId === null) {
          targetClusterId = this._allocateClusterIdUnsafe();
          this.clusters.set(targetClusterId, new Set());
          this._advancePersistenceGenerationUnsafe();
          createdClusters += 1;
        }
        for (const nodeId of moving) {
          const before = this.nodes.get(nodeId)?.cluster;
          this._moveNodeToClusterUnsafe(nodeId, targetClusterId);
          if (this.nodes.get(nodeId)?.cluster !== before) movedNodes += 1;
        }
      }
      return { movedNodes, createdClusters, communityCount };
    });
  }
```

(If Step 1 confirmed `_moveNodeToClusterUnsafe` returns a usable boolean, count
with the return value instead of the before/after compare — either is correct;
pick one and stay consistent.)

- [ ] **Step 5: Run tests**

Run: `node --test tests/engine/memory/network-memory-community-plan.test.js`
Expected: 4 pass. Then the full memory suite for regressions:
`node --test "tests/engine/memory/*.test.js"` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add engine/src/memory/network-memory.js tests/engine/memory/network-memory-community-plan.test.js
git commit -m "feat(memory): applyCommunityPlan — barrier-protected community repartition"
```

---

### Task 6: Admin endpoint `/admin/memory/cleanup/communities`

**Files:**
- Modify: `engine/src/realtime/websocket-server.js` — two edits:
  the require at the top (next to the recluster require, ~line 23) and the
  endpoint block immediately after the recluster endpoint's closing brace (~line 662).

**Deviation from spec, documented:** the spec calls for an automated endpoint
contract test. The house has NO admin-endpoint test harness — the sibling
recluster and compost endpoints ship untested glue over tested primitives. The
endpoint below is thin glue over `planMemoryCommunities` (Tasks 1–4) and
`applyCommunityPlan` (Task 5), and its contract is verified against the live
engine with exact expected responses in Task 8. Building a server harness for one
endpoint is out of scope; if one lands later, port the Task 8 curl checks into it.

- [ ] **Step 1: Add the require**

Next to `const { applyMemoryRecluster, planMemoryRecluster } = require('../memory/recluster');`:

```js
const { applyMemoryCommunities, planMemoryCommunities } = require('../memory/community-detection');
```

- [ ] **Step 2: Add the endpoint** (after the recluster endpoint block)

```js
    if (url === '/admin/memory/cleanup/communities') {
      const maxIterationsValue = body.maxIterations ?? requestUrl.searchParams.get('maxIterations');
      const minCommunitySizeValue = body.minCommunitySize ?? requestUrl.searchParams.get('minCommunitySize');
      const plan = planMemoryCommunities(memory, {
        ...(maxIterationsValue != null ? { maxIterations: Number(maxIterationsValue) } : {}),
        ...(minCommunitySizeValue != null ? { minCommunitySize: Number(minCommunitySizeValue) } : {}),
      });
      const summary = {
        communityCount: plan.communityCount,
        movedNodes: plan.movedNodes,
        unchanged: plan.unchanged,
        converged: plan.converged,
        iterations: plan.iterations,
        degenerate: plan.degenerate,
        sizes: plan.sizes.slice(0, 50),
        sample: plan.sample,
      };

      if (req.method === 'GET' || mode === 'dry-run') {
        return json(200, { ok: true, mode: 'dry-run', ...summary });
      }
      if (req.method !== 'POST') {
        return json(405, { ok: false, error: 'method not allowed' });
      }
      if (mode !== 'apply') {
        return json(400, { ok: false, error: 'mode must be dry-run or apply' });
      }
      // Event rule: nothing moved — no backup, no mutation, no save.
      if (plan.unchanged) {
        return json(200, { ok: true, mode: 'apply', unchanged: true, movedNodes: 0 });
      }

      const backup = this._backupBrainSidecars('brain-communities');
      const applied = applyMemoryCommunities(memory, plan);
      if (typeof this.orchestrator.saveState === 'function') {
        await this.orchestrator.saveState();
      }
      return json(200, { ok: true, mode: 'apply', backup, ...summary, ...applied });
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --check engine/src/realtime/websocket-server.js`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add engine/src/realtime/websocket-server.js
git commit -m "feat(engine): /admin/memory/cleanup/communities endpoint (dry-run/apply)"
```

---

### Task 7: Nightly driver + cron entry

**Files:**
- Create: `scripts/run-community-detection.sh`
- Modify: `config/cron-jobs.json` (append one job)

- [ ] **Step 1: Write the driver**

```bash
#!/bin/bash
set -o pipefail

# Nightly community detection for every agent brain.
# Dry-run first; if nothing would move, skip silently (a loop that ticked is
# not an event). Apply only when the plan moves nodes. The engine takes its
# own sidecar backup before every apply.
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

json_field() {
  # $1 = JSON on stdin's saved variable, $2 = field — prints value or empty
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(s);
        const value = parsed[process.argv[1]];
        process.stdout.write(value === undefined ? "" : String(value));
      } catch { process.stdout.write(""); }
    });
  ' "$2"
}

shopt -s nullglob
for CONFIG_PATH in "$HOME23_ROOT"/instances/*/config.yaml; do
  AGENT="$(basename "$(dirname "$CONFIG_PATH")")"
  PORT="$(awk '/^ports:/{inports=1; next} inports && /^[^[:space:]]/{inports=0} inports && $1=="engine:"{print $2; exit}' "$CONFIG_PATH")"
  if [ -z "$PORT" ]; then
    echo "[communities] $AGENT SKIP no ports.engine in config"
    continue
  fi

  DRY="$(curl -sf --max-time 300 "http://127.0.0.1:$PORT/admin/memory/cleanup/communities" 2>/dev/null)"
  if [ -z "$DRY" ]; then
    echo "[communities] $AGENT SKIP engine unreachable or busy on port $PORT"
    continue
  fi

  MOVED="$(json_field "$DRY" movedNodes)"
  UNCHANGED="$(json_field "$DRY" unchanged)"
  if [ "$UNCHANGED" = "true" ] || [ "$MOVED" = "0" ]; then
    echo "[communities] $AGENT unchanged (0 moves) — skipped"
    continue
  fi

  APPLY="$(curl -sf --max-time 600 -X POST -H 'Content-Type: application/json' \
    -d '{"mode":"apply"}' \
    "http://127.0.0.1:$PORT/admin/memory/cleanup/communities" 2>/dev/null)"
  if [ -z "$APPLY" ]; then
    echo "[communities] $AGENT APPLY FAILED (engine error or timeout)"
    RC=1
    continue
  fi
  echo "[communities] $AGENT applied: moved=$(json_field "$APPLY" movedNodes) communities=$(json_field "$APPLY" communityCount) converged=$(json_field "$APPLY" converged) degenerate=$(json_field "$APPLY" degenerate)"
done
shopt -u nullglob
exit $RC
```

`chmod +x scripts/run-community-detection.sh`

- [ ] **Step 2: Verify the mode plumbing assumption**

The apply POST sends `{"mode":"apply"}` in the body. Confirm the admin handler
derives `mode` from the body for sibling endpoints:
`grep -n "mode" engine/src/realtime/websocket-server.js | grep -iE "body.mode|searchParams.get\('mode'\)" | head -3`
Expected: a line showing `body.mode ?? requestUrl.searchParams.get('mode')` (or
equivalent). If mode comes ONLY from the query string, change the driver's apply
curl to `.../communities?mode=apply` and note it in the commit message.

- [ ] **Step 3: Dry-run the driver against the live engines (safe — GET only until moves exist, and the endpoint does not exist on the running engines yet)**

Run: `bash scripts/run-community-detection.sh`
Expected TODAY (endpoint not yet deployed): every agent line reads
`SKIP engine unreachable or busy` — because the live engines return 404/error to
curl `-f`. This validates the loop, port parsing, and skip paths. The real
end-to-end run happens in Task 8 after the engine restart.

- [ ] **Step 4: Add the cron entry**

In `config/cron-jobs.json`, append to the jobs array (match sibling field shape
exactly — verify with the existing `ann-index-rebuild-nightly` entry first):

```json
{
  "id": "community-detection-nightly",
  "name": "Nightly brain community detection",
  "enabled": true,
  "queueClass": "background",
  "schedule": { "kind": "cron", "expr": "45 3 * * *", "tz": "America/New_York" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "exec",
    "command": "bash scripts/run-community-detection.sh",
    "timeoutSeconds": 900,
    "cwd": "/Users/jtr/_JTR23_/release/home23"
  },
  "delivery": { "mode": "failures" },
  "state": { "nextRunAtMs": 0, "consecutiveErrors": 0 }
}
```

Validate: `node -e "JSON.parse(require('fs').readFileSync('config/cron-jobs.json','utf8')); console.log('json ok')"`
Then confirm the scheduler actually executes this file: check that sibling jobs
carry mutated state (`ann-index-rebuild-nightly` should show a
`state.lastRunAtMs` after tonight; the pressure jobs already do). If NO job in
this file has ever run, the file is dead config — move the entry to
`instances/jerry/conversations/cron-jobs.json` instead and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-community-detection.sh config/cron-jobs.json
git commit -m "feat(scripts): nightly community-detection driver + cron entry"
```

---

### Task 8: GATE — merge, load-test, restart jerry, live dry-run, STOP

**This task ends with a hard stop. Nothing applies to a real brain here.**

- [ ] **Step 1: Full test sweep in the worktree**

```bash
node --test "tests/engine/memory/*.test.js" "tests/shared/**/*.test.js" "tests/engine/core/*.test.js"
```

Expected: zero NEW failures vs main (pre-existing failures documented in the
2026-07-16 session are not yours).

- [ ] **Step 2: Merge to main in the live checkout**

```bash
cd /Users/jtr/_JTR23_/release/home23
git merge --no-ff codex/community-detection -m "merge: graph community detection (planner, apply, endpoint, nightly driver)"
node --test tests/engine/memory/community-detection.test.js tests/engine/memory/network-memory-community-plan.test.js
```

Expected: merge clean, tests pass on main.

- [ ] **Step 3: Standalone load test BEFORE any restart (house rule — network-memory.js changed)**

```bash
node /private/tmp/claude-501/-Users-jtr--JTR23--release-home23/0b58b33b-d35a-4f13-89bd-aeafe24bdab8/scratchpad/load-test.cjs jerry
node /private/tmp/claude-501/-Users-jtr--JTR23--release-home23/0b58b33b-d35a-4f13-89bd-aeafe24bdab8/scratchpad/load-test.cjs forrest
```

If the scratchpad script is gone, recreate it verbatim:

```js
// load-test.cjs — standalone brain load verification (house rule before restarts)
const { loadMemoryRevision } = require('/Users/jtr/_JTR23_/release/home23/engine/src/core/memory-persistence.js');
const agent = process.argv[2];
const brainDir = `/Users/jtr/_JTR23_/release/home23/instances/${agent}/brain`;
const t0 = Date.now();
loadMemoryRevision(brainDir, {
  home23Root: '/Users/jtr/_JTR23_/release/home23',
  requesterAgent: `load-test-${agent}`,
}).then((r) => {
  console.log(`${agent}: LOADED rev=${r.revision} nodes=${r.nodes.length} edges=${r.edges.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}, (err) => {
  console.error(`${agent}: LOAD FAILED — ${err.message}`);
  process.exit(1);
});
```
Expected: both print `LOADED rev=… nodes=…` with node counts matching each
agent's current manifest `summary.nodeCount` (read
`instances/<agent>/brain/memory-manifest.json`). Any mismatch or error: STOP.

- [ ] **Step 4: Restart jerry's engine only**

```bash
pm2 restart home23-jerry --update-env
# wait for "Memory revision loaded" in instances/jerry/logs/engine-out.log (~90s)
```

Expected: log line `Memory revision loaded {"revision":…,"nodes":…}` with the
pre-restart node count; restarts counter +1 exactly; no FATAL in engine-err.

- [ ] **Step 5: Live dry-run against jerry's real brain**

```bash
curl -s --max-time 300 "http://127.0.0.1:5001/admin/memory/cleanup/communities" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const p=JSON.parse(s);
    console.log("communities:", p.communityCount, "| moved:", p.movedNodes,
      "| converged:", p.converged, "| degenerate:", p.degenerate);
    console.log("sizes:", JSON.stringify(p.sizes.slice(0,15)));
    for (const s of p.sample.slice(0,10)) console.log(" ", s.from, "->", s.to, "|", s.preview.slice(0,80));
  })'
```

Expected shape: `communityCount` in the tens (organic — no target), `converged: true`,
`degenerate: false` (if `true`, that is honest data for the review — do not tune it
away silently), sizes showing real structure, samples previewing recognizable
content per community.

- [ ] **Step 6: STOP — present to jtr**

Present: community count, size distribution, degenerate/converged flags, and the
10 samples. **Do not POST apply. Do not touch forrest. Do not enable anything.**
Task 9 is blocked until jtr reviews this output and says go.

---

### Task 9: Post-approval rollout (BLOCKED until jtr approves Task 8's dry-run)

- [ ] **Step 1: Apply on jerry**

```bash
curl -s --max-time 600 -X POST -H 'Content-Type: application/json' -d '{"mode":"apply"}' \
  "http://127.0.0.1:5001/admin/memory/cleanup/communities"
```

Expected: `{ ok: true, mode: "apply", backup: {...}, movedNodes: >0, communityCount: … }`.

- [ ] **Step 2: Verify downstream, all four consumers**

```bash
# manifest: clusterCount > 1 after the next save
node -e "const m=require('/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/memory-manifest.json');console.log('clusterCount:',m.summary.clusterCount)"
# map: fetch the graph payload — distinct clusters > 1 flips the map off tag-fallback
curl -s "http://127.0.0.1:5002/home23/api/brain/graph?nodeLimit=200&edgeLimit=200" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log("distinct clusters in payload:", new Set(p.nodes.map(n=>String(n.cluster))).size)})'
```

Expected: `clusterCount` equals the applied communityCount (±1 while ingestion
runs); map payload shows the same. Visually confirm the brain map now renders
real communities (header says "N clusters", not "N tag groups").

Then PGS — the partitions must reflect the communities (this is the whole point):

```bash
node -e '
const ms = require("/Users/jtr/_JTR23_/release/home23/shared/memory-source");
(async () => {
  const source = await ms.openMemorySource("/Users/jtr/_JTR23_/release/home23/instances/jerry/brain", {
    home23Root: "/Users/jtr/_JTR23_/release/home23",
    requesterAgent: "pgs-partition-check",
  });
  try {
    const { listPgsPartitions } = require("/Users/jtr/_JTR23_/release/home23/shared/memory-source/pgs-partitions.cjs");
    const result = await listPgsPartitions(source);
    console.log("partitions:", result.totalPartitions, "nodes:", result.totalNodes);
    for (const p of result.partitions.slice(0, 15)) console.log(" ", p.partitionId, p.nodeCount);
  } finally { await source.close?.(); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
'
```

Expected: `partitions:` equals the community count, each `c-<id>` with a node
count matching the community sizes — no single partition holding ~100% of nodes.
(If `openMemorySource`'s option shape differs, follow the call pattern in
`tests/shared/memory-source-writer.test.js` — do not guess.)

- [ ] **Step 3: Restart forrest's engine, run the driver end-to-end**

```bash
pm2 restart home23-forrest --update-env
# wait for boot, then:
bash scripts/run-community-detection.sh
```

Expected: one line per agent; jerry `unchanged (0 moves) — skipped` (just
applied); forrest either applies (small brain, few communities) or reports
`degenerate` honestly — his ~300-node rebuild may legitimately be 1–2 communities.

- [ ] **Step 4: Confirm the cron job is armed**

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('config/cron-jobs.json','utf8'));const job=(Array.isArray(j)?j:j.jobs).find(x=>x.id==='community-detection-nightly');console.log(job.enabled, job.schedule.expr)"
```

Expected: `true 45 3 * * *`. Next morning, verify `state.lastRunAtMs` mutated and
the driver log line appeared — a scheduled job that has never fired is the
ANN-index disease; do not declare victory until it has run once on its own.

- [ ] **Step 5: Commit any rollout adjustments + update session memory**

```bash
git add -A && git commit -m "chore: community-detection rollout adjustments" --allow-empty
```

Note in the session handoff memory: communities live on both agents, nightly job
armed, first unattended run pending verification.

---

## Execution notes for the implementer

- `memory.embed = async () => null` in tests avoids embedding providers entirely
  (Memory Lite path) — do not mock further.
- `_upsertEdgeUnsafe(source, target, weight, type, opts)` and
  `_moveNodeToClusterUnsafe` must be called inside `memory.withPersistenceBarrier(() => …)`
  — calling them bare throws `_requirePersistenceBarrierUnsafe`.
- The planner never invents cluster ids: fresh communities carry `clusterId: null`
  and ids are allocated only inside `applyCommunityPlan` under the barrier.
- Cluster ids are mixed-typed in real brains (numeric `1` on disk, `'1'` in
  exports). All identity comparisons in this feature go through `String()`; all
  REUSED values preserve their original type.
