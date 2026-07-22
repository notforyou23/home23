'use strict';

// Fix 3.5 — community detection (seeded label propagation), config-gated,
// default OFF (architecture.memory.communityDetection).
//
// The lineage one-blob bug: NetworkMemory._assignToClusterUnsafe adopts each
// newborn node into its neighbors' majority cluster at birth-time, so the
// first cluster conquers the graph and nothing global ever corrects it.
// planMemoryCommunities (cosmo23/engine/src/memory/community-detection.js)
// is the global correction; NetworkMemory.applyCommunityPlan applies it;
// Orchestrator._maybeRunCommunityDetection schedules it INSIDE the cycle,
// immediately before the end-of-cycle save (serialized with saves).
//
// Contracts pinned here:
// - G1: pure relabeling — protected (execution_result) nodes keep every field
//   except cluster; no node or edge is created, deleted, or reweighted.
// - G2: gates off = bit-for-bit today's behavior (disabled driver mutates
//   nothing, logs nothing; birth-time adoption unchanged); arming thresholds
//   minNodes default 5000, intervalCycles default 50.
// - G3: moves are dirty-tracked for the manifest delta chain; ledger event
//   with move counts, never awaited.
// - Coherence: node.cluster and memory.clusters agree for every reader —
//   exportGraph, orchestrator loadState cluster rebuild, legacy save()
//   validator (serializeLegacyClusterEntries), cluster-aware CRDT snapshots.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  planMemoryCommunities,
  applyMemoryCommunities,
} = require('../../cosmo23/engine/src/memory/community-detection.js');
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const ORCHESTRATOR_SOURCE = fs.readFileSync(
  require.resolve('../../cosmo23/engine/src/core/orchestrator.js'),
  'utf8'
);

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-community-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── planner-level fixtures (planner reads nodes Map, edges Map,
//    config.spreading.bridgeTraversalFactor — nothing else) ──

function makePlannerMemory({ nodes, edges, bridgeTraversalFactor = 0.2 }) {
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [`${e.source}->${e.target}`, e])),
    config: { spreading: { bridgeTraversalFactor } },
  };
}

function plannerNode(id, cluster = 1) {
  return { id, cluster, concept: `concept ${id}` };
}

function plannerEdge(source, target, weight = 1, type = 'associative') {
  return { source, target, weight, type };
}

// Two dense 6-cliques (1-6 and 11-16), all sharing cluster 1 — the real-world
// one-blob starting state in miniature. Joined only by bridge edges.
function twoCliquesBridged() {
  const nodes = [];
  const edges = [];
  for (const base of [0, 10]) {
    for (let i = 1; i <= 6; i++) nodes.push(plannerNode(base + i));
    for (let i = 1; i <= 6; i++) {
      for (let j = i + 1; j <= 6; j++) edges.push(plannerEdge(base + i, base + j, 1));
    }
  }
  edges.push(plannerEdge(3, 13, 1, 'bridge'));
  edges.push(plannerEdge(4, 14, 1, 'bridge'));
  return makePlannerMemory({ nodes, edges });
}

// ── real-NetworkMemory fixture ──

function memoryConfig() {
  return {
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40, bridgeProbability: 0.1 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8, bridgeTraversalFactor: 0.2 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  };
}

function fakeVec(seed) {
  const v = new Array(8).fill(0);
  v[seed % 8] = 1;
  return v;
}

// Two 5-cliques joined by one bridge, every node forced into cluster 1 —
// jerry's real starting state in miniature, built through the real addNode
// path (pre-computed embeddings skip the quality gate and the embed call;
// findInitialConnections stubbed so the graph is exactly our clique edges).
async function oneBlobMemory() {
  const memory = new NetworkMemory(memoryConfig(), quietLogger);
  memory.findInitialConnections = () => [];
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const node = await memory.addNode(
      `community test node ${i}`,
      i === 0 ? 'execution_result' : 'general',
      fakeVec(i),
    );
    assert.ok(node, `addNode ${i} accepted`);
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
  assert.equal(memory.clusters.size, 1, 'fixture starts as one blob');
  return { memory, ids };
}

function assertClusterCoherence(memory) {
  for (const [id, node] of memory.nodes) {
    assert.ok(node.cluster !== null && node.cluster !== undefined, `node ${id} clustered`);
    assert.ok(memory.clusters.get(node.cluster)?.has(id), `clusters map missing node ${id}`);
  }
  let total = 0;
  for (const [clusterId, members] of memory.clusters) {
    for (const id of members) {
      total += 1;
      assert.equal(memory.nodes.get(id)?.cluster, clusterId, `member ${id} back-references ${clusterId}`);
    }
  }
  assert.equal(total, memory.nodes.size, 'no duplicate or orphan cluster membership');
}

function makeFakeOrchestrator(memory, communityDetection, cycleCount) {
  return {
    config: communityDetection === undefined
      ? {}
      : { architecture: { memory: { communityDetection } } },
    memory,
    cycleCount,
    logger: quietLogger,
    eventLedger: {
      entries: [],
      log(type, data = {}) { this.entries.push({ type, data }); return Promise.resolve(null); },
    },
    _maybeRunCommunityDetection: Orchestrator.prototype._maybeRunCommunityDetection,
  };
}

// ── planner behavior ──

test('planner: three dense cliques converge to three communities', () => {
  const nodes = [];
  const edges = [];
  for (const base of [0, 100, 200]) {
    for (let i = 1; i <= 6; i++) nodes.push(plannerNode(base + i));
    for (let i = 1; i <= 6; i++) {
      for (let j = i + 1; j <= 6; j++) edges.push(plannerEdge(base + i, base + j, 1));
    }
  }
  edges.push(plannerEdge(3, 103, 1, 'bridge'));
  edges.push(plannerEdge(104, 204, 1, 'bridge'));
  const plan = planMemoryCommunities(makePlannerMemory({ nodes, edges }), { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 3);
  assert.equal(plan.converged, true);
  assert.deepEqual(plan.sizes.map((s) => s.size), [6, 6, 6]);
  assert.equal(plan.degenerate, false);
});

test('planner: virgin one-blob brain splits via singleton seeding', () => {
  const plan = planMemoryCommunities(twoCliquesBridged(), { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2);
  const sizes = plan.communities.map((c) => c.members.length).sort();
  assert.deepEqual(sizes, [6, 6]);
  // one community reclaims prior id 1, the other gets a fresh id at apply
  assert.equal(plan.movedNodes, 6);
  assert.equal(plan.unchanged, false);
  assert.equal(plan.converged, true);
});

test('planner: identical input yields an identical plan (determinism)', () => {
  const a = planMemoryCommunities(twoCliquesBridged(), { minCommunitySize: 2 });
  const b = planMemoryCommunities(twoCliquesBridged(), { minCommunitySize: 2 });
  assert.deepEqual(
    a.communities.map((c) => ({ clusterId: c.clusterId, members: [...c.members].sort() })),
    b.communities.map((c) => ({ clusterId: c.clusterId, members: [...c.members].sort() })),
  );
  assert.equal(a.movedNodes, b.movedNodes);
});

test('planner: one dense blob reports degenerate honestly', () => {
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= 20; i++) nodes.push(plannerNode(i));
  for (let i = 1; i <= 20; i++) {
    for (let j = i + 1; j <= 20; j++) edges.push(plannerEdge(i, j, 1));
  }
  const plan = planMemoryCommunities(makePlannerMemory({ nodes, edges }), { minCommunitySize: 2 });
  assert.equal(plan.degenerate, true);
  assert.ok(plan.communityCount < 3);
});

// ── real NetworkMemory apply + reader coherence ──

test('one-blob fixture splits; node.cluster and memory.clusters stay coherent for every reader', async (t) => {
  const { memory, ids } = await oneBlobMemory();
  const protectedBefore = JSON.stringify({ ...memory.nodes.get(ids[0]), cluster: null, embedding: null });

  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(plan.communityCount, 2, 'blob splits into 2 communities');
  const applied = applyMemoryCommunities(memory, plan);
  assert.equal(applied.communityCount, 2);
  assert.equal(applied.movedNodes, 5, 'one clique reclaims id 1, the other 5 members move');
  assert.equal(applied.createdClusters, 1);
  assert.equal(applied.movedNodes, plan.movedNodes, 'dry-run and apply must agree');
  assertClusterCoherence(memory);

  // G1: protected execution_result node — only cluster changed.
  const protectedAfter = JSON.stringify({ ...memory.nodes.get(ids[0]), cluster: null, embedding: null });
  assert.equal(protectedAfter, protectedBefore, 'execution_result node fields untouched except cluster');
  assert.equal(memory.nodes.size, 10, 'no node created or deleted');

  // Reader 1: exportGraph (saveState path) — clusters list matches node.cluster.
  const exported = memory.exportGraph();
  for (const entry of exported.clusters) {
    assert.deepEqual(
      entry.nodes.slice().sort(),
      Array.from(memory.clusters.get(entry.id)).sort(),
    );
  }

  // Reader 2: orchestrator loadState cluster rebuild (manifest-backed runs
  // rebuild memory.clusters from node.cluster — node.cluster is the durable
  // authority). The rebuild must reproduce the live index exactly.
  const rebuilt = new Map();
  for (const node of exported.nodes) {
    if (node.cluster === null || node.cluster === undefined) continue;
    if (!rebuilt.has(node.cluster)) rebuilt.set(node.cluster, new Set());
    rebuilt.get(node.cluster).add(node.id);
  }
  assert.equal(rebuilt.size, memory.clusters.size);
  for (const [clusterId, members] of memory.clusters) {
    assert.deepEqual(Array.from(rebuilt.get(clusterId)).sort(), Array.from(members).sort());
  }

  // Reader 3: legacy save() runs serializeLegacyClusterEntries, which THROWS
  // on any node.cluster/clusters-map disagreement — must accept the result.
  const dir = makeTmpDir(t);
  await memory.save(path.join(dir, 'network.json'));
});

test('moves land in the dirty snapshot (manifest delta-chain composition)', async () => {
  const { memory } = await oneBlobMemory();
  memory.markPersistenceCleanIfGeneration(memory.persistenceGeneration);
  const plan = planMemoryCommunities(memory, { minCommunitySize: 2 });
  // Compute expected movers BEFORE applying (apply mutates node.cluster).
  const expectedMoved = plan.communities.flatMap((c) => c.members.filter((id) => {
    const node = memory.nodes.get(id);
    return c.clusterId === null || node.cluster == null
      || String(node.cluster) !== String(c.clusterId);
  }));
  const result = memory.applyCommunityPlan(plan);
  const snapshot = memory.capturePersistenceSnapshot();
  const dirtyIds = new Set(snapshot.changes.nodes.map((n) => String(n.id)));
  assert.equal(expectedMoved.length, result.movedNodes);
  for (const id of expectedMoved) {
    assert.ok(dirtyIds.has(String(id)), `moved node ${id} missing from dirty snapshot`);
  }
});

test('settled graph: second pass unchanged; no-op apply never advances the persistence generation', async () => {
  const { memory } = await oneBlobMemory();
  const first = planMemoryCommunities(memory, { minCommunitySize: 2 });
  memory.applyCommunityPlan(first);
  memory.markPersistenceCleanIfGeneration(memory.persistenceGeneration);
  const generation = memory.persistenceGeneration;

  const second = planMemoryCommunities(memory, { minCommunitySize: 2 });
  assert.equal(second.unchanged, true, 'cluster-seeded second pass moves zero nodes');
  const result = memory.applyCommunityPlan(second);
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

// ── driver gates (G2) ──

test('driver gates: disabled default is bit-for-bit off; minNodes and interval arm honestly', async () => {
  const { memory } = await oneBlobMemory();
  const generation = memory.persistenceGeneration;

  // No communityDetection config at all (every existing run) → disabled.
  const off = makeFakeOrchestrator(memory, undefined, 100);
  assert.deepEqual(off._maybeRunCommunityDetection(), { ran: false, reason: 'disabled' });
  assert.equal(off.eventLedger.entries.length, 0, 'disabled: zero ledger events');

  // enabled: false explicitly → disabled.
  const explicitOff = makeFakeOrchestrator(memory, { enabled: false }, 100);
  assert.equal(explicitOff._maybeRunCommunityDetection().reason, 'disabled');

  // enabled with default thresholds: 10-node brain is far below minNodes 5000.
  const belowFloor = makeFakeOrchestrator(memory, { enabled: true }, 100);
  const floorResult = belowFloor._maybeRunCommunityDetection();
  assert.equal(floorResult.reason, 'below_min_nodes');
  assert.equal(floorResult.minNodes, 5000, 'default minNodes is 5000');

  // armed but off the interval boundary → skipped.
  const offInterval = makeFakeOrchestrator(memory, { enabled: true, minNodes: 4 }, 101);
  const intervalResult = offInterval._maybeRunCommunityDetection();
  assert.equal(intervalResult.reason, 'off_interval');
  assert.equal(intervalResult.intervalCycles, 50, 'default intervalCycles is 50');

  assert.equal(memory.persistenceGeneration, generation,
    'every gated-off path leaves the graph untouched');
  assert.equal(memory.clusters.size, 1, 'still one blob — no correction ran');
});

test('driver armed: applies the plan and emits a community_detection ledger event with move counts', async () => {
  const { memory } = await oneBlobMemory();
  const fake = makeFakeOrchestrator(
    memory,
    { enabled: true, minNodes: 4, intervalCycles: 50, minCommunitySize: 2 },
    100,
  );

  const result = fake._maybeRunCommunityDetection();
  assert.equal(result.ran, true);
  assert.equal(result.communities, 2);
  assert.equal(result.movedNodes, 5);
  assert.equal(result.createdClusters, 1);
  assertClusterCoherence(memory);

  assert.equal(fake.eventLedger.entries.length, 1);
  const event = fake.eventLedger.entries[0];
  assert.equal(event.type, 'community_detection');
  assert.equal(event.data.movedNodes, 5);
  assert.equal(event.data.createdClusters, 1);
  assert.equal(event.data.cycle, 100);
  assert.equal(typeof event.data.durationMs, 'number');

  // Second scheduled run on the settled graph: still runs, moves nothing,
  // still leaves durable evidence.
  const again = fake._maybeRunCommunityDetection();
  assert.equal(again.ran, true);
  assert.equal(again.movedNodes, 0);
  assert.equal(fake.eventLedger.entries.length, 2);
});

// ── gates-off behavior pin (G2): birth-time adoption unchanged ──

test('gates off: _assignToClusterUnsafe still adopts a newborn into its neighbor-majority cluster', async () => {
  const { memory, ids } = await oneBlobMemory();
  const newborn = await memory.addNode('newborn adoptee', 'general', fakeVec(3));
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(newborn.id, ids[0], 1, 'associative', { enforceBridgeCap: false });
  });
  const assigned = memory.assignToCluster(newborn.id);
  assert.equal(assigned, 1,
    'birth-time adoption into the majority cluster is untouched — the one-blob mechanism is corrected globally, never edited');
});

// ── wiring pins: in-cycle, before the save, ledger never awaited ──

test('executeCycle wiring: community pass runs inside the cycle, before the end-of-cycle save', () => {
  const callSite = 'this._maybeRunCommunityDetection();';
  assert.equal(countOccurrences(ORCHESTRATOR_SOURCE, callSite), 1,
    'exactly one in-cycle call site');
  const callIndex = ORCHESTRATOR_SOURCE.indexOf(callSite);
  const saveCommentIndex = ORCHESTRATOR_SOURCE.indexOf('// PRODUCTION: Save state EVERY cycle');
  assert.ok(callIndex > -1 && saveCommentIndex > -1);
  assert.ok(callIndex < saveCommentIndex,
    'community pass must precede the end-of-cycle saveState (serialized with saves)');

  // G3: ledger events are fire-and-forget — never awaited.
  assert.ok(ORCHESTRATOR_SOURCE.includes("this.eventLedger?.log('community_detection'"));
  assert.ok(!ORCHESTRATOR_SOURCE.includes("await this.eventLedger?.log('community_detection'"),
    'ledger writes must not be awaited');
});

// ── bounded runtime ──

test('bounded runtime: 10k-node / ~40k-edge graph plans in bounded time', () => {
  const nodes = new Map();
  const edges = new Map();
  const COMMUNITIES = 20;
  const PER = 500;
  for (let c = 0; c < COMMUNITIES; c++) {
    const hub = c * PER;
    for (let i = 0; i < PER; i++) {
      const id = c * PER + i;
      nodes.set(id, { id, cluster: 1, concept: `node ${id}` });
      for (let k = 1; k <= 3; k++) {
        const peer = c * PER + ((i + k) % PER);
        const [a, b] = id < peer ? [id, peer] : [peer, id];
        edges.set(`${a}->${b}`, { source: a, target: b, weight: 1, type: 'associative' });
      }
      if (id !== hub) {
        edges.set(`${hub}->${id}`, { source: hub, target: id, weight: 1, type: 'associative' });
      }
    }
    const bridgeFrom = c * PER;
    const bridgeTo = ((c + 1) % COMMUNITIES) * PER;
    const [a, b] = bridgeFrom < bridgeTo ? [bridgeFrom, bridgeTo] : [bridgeTo, bridgeFrom];
    edges.set(`${a}->${b}`, { source: a, target: b, weight: 1, type: 'bridge' });
  }
  const started = Date.now();
  const plan = planMemoryCommunities(
    { nodes, edges, config: { spreading: { bridgeTraversalFactor: 0.2 } } },
    { minCommunitySize: 12 },
  );
  const elapsed = Date.now() - started;
  assert.equal(plan.communityCount, COMMUNITIES, 'hub-anchored ring of 20 communities fully resolves');
  assert.ok(elapsed < 30000, `bounded runtime (took ${elapsed}ms; ~100ms measured on this fixture)`);
});

