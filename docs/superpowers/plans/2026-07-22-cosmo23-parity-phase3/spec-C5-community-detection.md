# cosmo23 memory hygiene — Fix 3.5: community detection (seeded label propagation), config-gated default OFF, applied in-cycle serialized with saves

## Target current state

THE BUG (lineage one-blob): /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js `_assignToClusterUnsafe` (line 2061) assigns each newborn node to its neighbors' majority cluster at birth time (bridge edges vote at config.spreading?.bridgeTraversalFactor, default 0.2). The first cluster therefore conquers the whole graph and nothing global ever corrects it — every long-lived brain converges to one blob. No community-detection module, no `applyCommunityPlan`, and no `communityDetection` config key exist anywhere in cosmo23 today (verified by grep).

WHAT ALREADY EXISTS IN COSMO23 (verified byte-identical to the Home23 donor by diff): `applyReclusterPlan` (network-memory.js:1386), `_moveNodeToClusterUnsafe` (:1441), `_allocateClusterIdUnsafe` (:1458), `withPersistenceBarrier`/`_markNodeDirtyUnsafe`/`_advancePersistenceGenerationUnsafe`, `capturePersistenceSnapshot`, `markPersistenceCleanIfGeneration`. This means the donor's `applyCommunityPlan` (Home23 engine/src/memory/network-memory.js:1408-1463) ports essentially verbatim — its only dependencies are those identical primitives.

DONOR (WORKING, live on jerry since 2026-07-16): /Users/jtr/_JTR23_/release/home23/engine/src/memory/community-detection.js (planMemoryCommunities: seeded label propagation, fixed-point iteration clamped at maxIterations default 20 / hard cap 100, bridge-discounted weighted votes, strict-improvement-only moves for stability, small-community folding with isolated-island survival, stable cluster-id reclamation by plurality with greedy one-claim-per-id) + recluster.js (unclustered-only assignment — different tool, NOT ported; cosmo23 already has its apply side). Donor scheduling is an operator HTTP endpoint in engine/src/realtime/websocket-server.js:709-748 (dry-run/apply + sidecar backup) — cosmo23 gets an autonomous in-cycle driver instead, per spec.

CLUSTER READERS AUDITED (who consumes cluster ids): (1) exportGraph (network-memory.js:2420, called by orchestrator saveState at :4607 and :8503) exports node.cluster AND the clusters list — `_moveNodeToClusterUnsafe` maintains both in lockstep. (2) Manifest-backed saves persist ONLY node.cluster: lib/memory-sidecar.js memoryShell (:124) zeroes clusters[] in the shell, and orchestrator loadState rebuilds memory.clusters from node.cluster at orchestrator.js:9117-9161 (task brief said ~8697 — stale; tree moved) and bumps nextClusterId past the max — node.cluster is the durable authority, so dirty-marking moved nodes is sufficient for the manifest delta chain. (3) Legacy NetworkMemory.save() (:2470) runs serializeLegacyClusterEntries (:245) which THROWS network_save_invalid_cluster on any node.cluster/clusters-map disagreement — the save path is itself a coherence validator. (4) cluster-aware-memory.js (multi-instance CRDT, :317/:519/:568) instruments the clusters Map's set/delete and each member Set — applyCommunityPlan mutates exclusively through those instrumented paths. (5) Consolidation (memory/summarizer.js clusterSimilarMemories :338) groups by EMBEDDING similarity, NOT graph clusters — unaffected. (6) orchestrator.js:3740 and meta-coordinator.js read memory.clusters with Object.keys()/.length on a Map — pre-existing degenerate readers (always 0/undefined); unchanged by this fix.

CYCLE STRUCTURE: executeCycle's step "21. Network maintenance" (orchestrator.js:3623, cycleCount % 30: rewire/decay/GC) is followed by the every-cycle `await this.saveState()` behind the unique comment "// PRODUCTION: Save state EVERY cycle for real-time tracking" (:3657). Sleep cycles `return` earlier ("Skip normal cycle operations during sleep"); consolidationMode returns at Phase 0 — so a pass placed just before that save runs on awake cycles only and is serialized with saves by construction. NetworkMemory is constructed with config.architecture.memory (index.js:351/:987, worker :234), so the G2 gate "memory.communityDetection.*" lives at architecture.memory.communityDetection, read via this.config.architecture?.memory (same pattern as :2786 contextDiversity). eventLedger call-site convention: `this.eventLedger?.log(type, data)` never awaited (:1574, :3669).

VALIDATION PERFORMED (no repo file edited; my writes went only to the scratchpad — git status confirms the worktree deltas are foreign concurrent-session work): the exact proposed applyCommunityPlan and _maybeRunCommunityDetection bodies were executed against the CURRENT cosmo23 NetworkMemory class in a scratchpad harness. Green: one-blob (two 5-cliques, all cluster 1, built through real addNode) splits into 2 communities, movedNodes 5, createdClusters 1, dry-run==apply; full node.cluster/memory.clusters coherence; exportGraph and loadState-rebuild parity; legacy save() validator accepts the result; execution_result node fields byte-identical except cluster (G1); moved nodes present in capturePersistenceSnapshot dirty changes (G3); second pass unchanged with persistenceGeneration frozen; three-clique planner fixture converges to 3; driver gates (disabled/below_min_nodes default 5000/off_interval default 50) mutate nothing and log nothing; armed driver applies and emits community_detection ledger event with counts; birth-time adoption behavior pin passes; 10k nodes / 39,880 edges planned in 106ms (2 iterations).

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/community-detection.js

NEW FILE — cosmo23-native port of the donor planner (seeded label propagation, fixed-point iteration). Pure module, zero mutation; apply via NetworkMemory.applyCommunityPlan. Algorithm is byte-equivalent to the donor (/Users/jtr/_JTR23_/release/home23/engine/src/memory/community-detection.js); only the header comment is adapted. Validated end-to-end against the real cosmo23 NetworkMemory in a scratchpad harness before proposing.

### Code
```js
'use strict';

/**
 * Graph community detection — seeded label propagation (Fix 3.5).
 *
 * Every brain to date lived in a single cluster: `_assignToClusterUnsafe`
 * adopts each newborn into its neighbors' majority cluster, so the first
 * cluster conquered the world at birth-time and nothing global ever
 * corrected it. This planner is the global correction: it derives
 * communities from actual edge structure, keeps ids stable across runs,
 * and reports honestly when the graph is one dense blob.
 *
 * Pure module — no mutation. Apply via NetworkMemory.applyCommunityPlan.
 * Ported from the Home23 engine donor (live on jerry since 2026-07-16);
 * scheduled in-cycle by Orchestrator._maybeRunCommunityDetection.
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
    // Precondition: edge keys are canonical (sorted endpoints, one key per
    // pair) — _upsertEdgeUnsafe enforces this and legacy load validates it.
    // A hand-built map with both A->B and B->A keys would double this vote.
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

// Fold communities below the floor into their strongest-connected neighbor
// community (bridge discount already applied to votes); isolated islands with
// no external edges survive — real islands are honest data.
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

  // label is plan-internal (sort tiebreak only) — not stable across runs;
  // never key identity off it.
  return Array.from(members.entries())
    .map(([label, ids]) => ({ label, members: Array.from(ids).sort(compareAsStrings) }))
    .sort((a, b) => b.members.length - a.members.length || compareAsStrings(a.label, b.label));
}

// Each community reclaims the prior cluster id it inherited the plurality of
// its members from; each prior id is claimable once (greedy, overlap desc).
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
        // members pre-sorted by fold — [0] is the string-smallest.
        smallestMember: group.members[0],
      });
    }
  });

  // Greedy claim: largest overlap wins each prior id; ties -> larger group,
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

function planMemoryCommunities(memory, options = {}) {
  const nodes = memory?.nodes instanceof Map ? memory.nodes : new Map();
  const rawBridgeVote = Number(
    options.bridgeVote ?? memory?.config?.spreading?.bridgeTraversalFactor ?? 0.2,
  );
  const bridgeVote = Number.isFinite(rawBridgeVote) ? rawBridgeVote : 0.2;
  const maxIterations = Math.min(100, Math.max(1, Number(options.maxIterations) || DEFAULT_MAX_ITERATIONS));
  const minCommunitySize = Math.min(500, Math.max(2, Number(options.minCommunitySize) || DEFAULT_MIN_COMMUNITY_SIZE));
  const rawMinEdgeWeight = Number(options.minEdgeWeight ?? 0);
  const minEdgeWeight = Number.isFinite(rawMinEdgeWeight) ? rawMinEdgeWeight : 0;

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

  // Sample round-robins across communities (2 per community, 20 total) so a
  // giant first community cannot crowd every other community out of the plan
  // preview. movedNodes still counts every move exactly.
  let movedNodes = 0;
  const perCommunitySamples = [];
  for (const community of communities) {
    const communitySamples = [];
    for (const nodeId of community.members) {
      const node = nodes.get(nodeId);
      const from = hasCluster(node) ? node.cluster : null;
      const moves = community.clusterId === null
        ? true
        : String(from) !== String(community.clusterId) || from === null;
      if (!moves) continue;
      movedNodes += 1;
      if (communitySamples.length < 2) {
        communitySamples.push({
          id: String(nodeId),
          from: from === null ? null : String(from),
          to: community.clusterId === null ? 'new' : String(community.clusterId),
          preview: String(node?.concept || '').slice(0, 120),
        });
      }
    }
    perCommunitySamples.push(communitySamples);
  }
  const sample = [];
  for (const communitySamples of perCommunitySamples) {
    for (const s of communitySamples) {
      if (sample.length >= 20) break;
      sample.push(s);
    }
    if (sample.length >= 20) break;
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

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Add NetworkMemory.applyCommunityPlan — donor method ported verbatim (its dependencies _moveNodeToClusterUnsafe / _allocateClusterIdUnsafe / _advancePersistenceGenerationUnsafe / withPersistenceBarrier are byte-identical between donor and cosmo23, verified by diff; only the 'nightly driver' comment is adapted to 'in-cycle driver'). INSERT the code block, followed by ONE blank line, immediately BEFORE the anchor line. The anchor is grep-unique; the two lines above it are '  }' and an empty line, both clean of trailing whitespace.

### Anchor
```
  _moveNodeToClusterUnsafe(nodeId, clusterId) {
```

### Code
```js
  applyCommunityPlan(plan) {
    if (!plan || typeof plan !== 'object') {
      return { movedNodes: 0, createdClusters: 0, communityCount: 0 };
    }
    // Plans are consumed in-process only: member ids must be the exact typed
    // values keyed in this.nodes. A JSON-round-tripped plan (string ids for a
    // numeric-id graph) silently matches nothing and applies zero moves.
    const communities = Array.from(plan.communities || [])
      .map((community) => ({
        clusterId: community?.clusterId ?? null,
        members: Array.from(new Set(community?.members || []))
          .filter((nodeId) => this.nodes.has(nodeId)),
      }))
      .filter((community) => community.members.length > 0);
    const communityCount = communities.length;

    // Event rule: a plan that moves nothing must not enter the barrier or
    // advance the persistence generation. The move test String-compares to
    // stay consistent with the planner's (community-detection.js
    // planMemoryCommunities) movedNodes accounting — dry-run and
    // apply must never disagree (the in-cycle driver's skip keys off it). A
    // String-equal member with a type-only mismatch is skipped here BEFORE
    // _moveNodeToClusterUnsafe, whose strict === would treat it as a move.
    const nodeNeedsMove = (nodeId, clusterId) => {
      const node = this.nodes.get(nodeId);
      if (!node) return false;
      if (clusterId === null) return true; // fresh community: every member moves (re-applying a plan re-allocates — plans are single-use)
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
          if (this._moveNodeToClusterUnsafe(nodeId, targetClusterId)) movedNodes += 1;
        }
      }
      return { movedNodes, createdClusters, communityCount };
    });
  }

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Hunk A of 3 — module import. INSERT the code line immediately AFTER the anchor line (the require block, current line 28; anchor is grep-unique).

### Anchor
```
const { MemoryGovernor } = require('../system/memory-governor');
```

### Code
```js
const { planMemoryCommunities } = require('../memory/community-detection');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Hunk B of 3 — the in-cycle driver method. INSERT the code block, followed by ONE blank line, immediately BEFORE the '  /**' line that begins the docblock containing the anchor (the performDeepSleepConsolidation docblock, current lines 3904-3907; anchor text is grep-unique; surrounding lines are clean of trailing whitespace). Synchronous on purpose: it completes fully before the end-of-cycle await this.saveState(), which is what serializes it with saves.

### Anchor
```
   * Deep sleep with GPT-5.2 enhanced processing
```

### Code
```js
  /**
   * Fix 3.5 — in-cycle community detection (seeded label propagation).
   *
   * `_assignToClusterUnsafe` adopts every newborn node into its neighbors'
   * majority cluster at birth time, so the first cluster conquers the graph
   * and nothing global ever corrects it (the lineage one-blob bug). This
   * pass is the global correction: every `intervalCycles` cycles it derives
   * communities from actual edge structure (planMemoryCommunities) and
   * applies them through NetworkMemory.applyCommunityPlan.
   *
   * Composition contract:
   * - Config-gated (architecture.memory.communityDetection.enabled), default
   *   OFF, armed only at/above minNodes (default 5000). Gates off = the
   *   birth-time behavior is untouched, bit for bit.
   * - Synchronous, called INSIDE executeCycle immediately before the
   *   end-of-cycle saveState(), so cluster moves are serialized with saves
   *   and land in the same cycle's manifest generation (moved nodes are
   *   dirty-marked by _moveNodeToClusterUnsafe for the delta chain).
   * - Pure relabeling: only node.cluster and the memory.clusters index move.
   *   No node or edge is created, deleted, or reweighted — execution_result
   *   and execution_failure nodes keep every field except cluster.
   * - Bounded runtime: planner iterations are clamped (default 20, hard cap
   *   100) over adjacency built in one edge pass — O(iterations x edges);
   *   measured ~106ms for 10k nodes / 40k edges.
   * - Durable evidence: ledger event with move counts (never awaited).
   */
  _maybeRunCommunityDetection() {
    const settings = this.config?.architecture?.memory?.communityDetection;
    if (!settings?.enabled) return { ran: false, reason: 'disabled' };
    const memory = this.memory;
    if (!(memory?.nodes instanceof Map) || typeof memory.applyCommunityPlan !== 'function') {
      return { ran: false, reason: 'memory_unavailable' };
    }
    const rawMinNodes = Number(settings.minNodes);
    const minNodes = Number.isFinite(rawMinNodes) && rawMinNodes >= 0 ? rawMinNodes : 5000;
    if (memory.nodes.size < minNodes) {
      return { ran: false, reason: 'below_min_nodes', nodes: memory.nodes.size, minNodes };
    }
    const rawInterval = Number(settings.intervalCycles);
    const intervalCycles = Number.isSafeInteger(rawInterval) && rawInterval > 0 ? rawInterval : 50;
    if (this.cycleCount % intervalCycles !== 0) {
      return { ran: false, reason: 'off_interval', intervalCycles };
    }

    const startedAt = Date.now();
    try {
      const plan = planMemoryCommunities(memory, {
        ...(settings.maxIterations != null ? { maxIterations: settings.maxIterations } : {}),
        ...(settings.minCommunitySize != null ? { minCommunitySize: settings.minCommunitySize } : {}),
        ...(settings.minEdgeWeight != null ? { minEdgeWeight: settings.minEdgeWeight } : {}),
      });
      const applied = plan.unchanged
        ? { movedNodes: 0, createdClusters: 0, communityCount: plan.communityCount }
        : memory.applyCommunityPlan(plan);
      const durationMs = Date.now() - startedAt;
      const summary = {
        cycle: this.cycleCount,
        nodes: memory.nodes.size,
        communities: plan.communityCount,
        movedNodes: applied.movedNodes,
        createdClusters: applied.createdClusters,
        iterations: plan.iterations,
        converged: plan.converged,
        degenerate: plan.degenerate,
        largestCommunity: plan.sizes.length > 0 ? plan.sizes[0].size : 0,
        durationMs,
      };
      this.eventLedger?.log('community_detection', summary);
      this.logger.info('🧩 Community detection pass complete', summary);
      return { ran: true, ...summary };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.eventLedger?.log('community_detection_failed', {
        cycle: this.cycleCount,
        error: error.message,
        durationMs,
      });
      this.logger.warn('Community detection pass failed', { error: error.message, durationMs });
      return { ran: false, reason: 'error', error: error.message };
    }
  }

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Hunk C of 3 — the executeCycle call site. INSERT the code block, followed by ONE blank line, immediately BEFORE the anchor comment line (current line 3657, grep-unique). TRAILING-WHITESPACE WARNING: the line immediately ABOVE the anchor is whitespace-only (exactly 6 spaces, between the closing '}' of the %30 maintenance block and this comment) — do NOT include that line in any old_string match and do NOT trim it; insert between it and the anchor comment.

### Anchor
```
      // PRODUCTION: Save state EVERY cycle for real-time tracking
```

### Code
```js
      // Fix 3.5: community detection (seeded label propagation) — config-gated
      // via architecture.memory.communityDetection, default OFF. Synchronous
      // and placed immediately before the end-of-cycle save so cluster moves
      // are serialized with saves and land in this cycle's manifest
      // generation. Sleep/consolidation cycles return earlier and never
      // reach this pass.
      this._maybeRunCommunityDetection();

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new test in the cosmo23 node --test segment of the "test" script. REPLACE the anchor substring (grep-unique, single occurrence inside the one-line script string) with the same text plus the new path in the middle: 'tests/cosmo23/network-memory-embedding-batch.test.cjs tests/cosmo23/community-detection.test.cjs tests/cosmo23/query-engine-provider-ownership.test.cjs'. CONCURRENCY WARNING: package.json carries FOREIGN uncommitted hunks from other live sessions — re-verify the anchor with grep at apply time and stage ONLY this substring change (surgical git add -p), never the whole file blindly.

### Anchor
```
tests/cosmo23/network-memory-embedding-batch.test.cjs tests/cosmo23/query-engine-provider-ownership.test.cjs
```

### Code
```js
tests/cosmo23/network-memory-embedding-batch.test.cjs tests/cosmo23/community-detection.test.cjs tests/cosmo23/query-engine-provider-ownership.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Register the new test in the exactly-once registration list (the test asserts command.split(file).length - 1 === 1 for every listed path; 'tests/cosmo23/community-detection.test.cjs' is not a substring of any other registered path, verified). INSERT the code line immediately AFTER the anchor line (current line 34; grep-unique; 4-space indentation, no trailing whitespace). CONCURRENCY WARNING: this file carries FOREIGN uncommitted hunks from other live sessions — re-verify the anchor at apply time and stage surgically.

### Anchor
```
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
```

### Code
```js
    'tests/cosmo23/community-detection.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/community-detection.test.cjs

```js
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

```

## API NOTES

CONFIG KNOBS (all under architecture.memory.communityDetection in the run's config.yaml — this is the block NetworkMemory receives as its own config, so it satisfies the G2 naming memory.communityDetection.*): enabled (bool, default false — absent key means disabled, so fresh runs and all current production brains are bit-for-bit unchanged; no YAML template changes needed anywhere), minNodes (default 5000; explicit 0 is honored per the no-backend-magic rule), intervalCycles (default 50; runs when cycleCount % intervalCycles === 0), maxIterations (optional, planner clamps 1..100, default 20), minCommunitySize (optional, planner clamps 2..500, default 12), minEdgeWeight (optional, default 0), bridgeVote (optional, defaults to spreading.bridgeTraversalFactor, 0.2).

DONOR-VS-COSMO23 API DELTA AUDIT (every delta found, per G6): (1) cosmo23 NetworkMemory LACKS applyCommunityPlan — added by this fix; ports verbatim because applyReclusterPlan, _moveNodeToClusterUnsafe, and _allocateClusterIdUnsafe are byte-identical between the two files (verified by extracting and diffing both regions). (2) cosmo23 addNode(concept, tag, embedding, metadata) REJECTS null embeddings and runs the classifyContent quality gate; the donor tolerates embed()->null (Memory Lite). Donor tests stub memory.embed = async () => null — that pattern DOES NOT WORK in cosmo23; tests pass a pre-computed embedding param instead (bypasses both gates by design) and stub findInitialConnections to keep fixture graphs exact. (3) cosmo23 nodes carry extra fields (metadata, type, embedding_status); the planner reads only id/cluster/concept — unaffected. (4) cosmo23 _assignToClusterUnsafe reads config.spreading?.bridgeTraversalFactor (optional-chained) vs donor unchained — planner's own read is nullish-safe for both. (5) Both _upsertEdgeUnsafe implementations canonicalize edge keys (sorted endpoints, one key per pair) — the planner's no-double-vote precondition holds. (6) cosmo23 NetworkMemory is constructed with config.architecture.memory (engine/src/index.js:351/:987, worker/orchestrator-worker.js:234). (7) Donor scheduling is an operator HTTP endpoint (engine/src/realtime/websocket-server.js /admin/memory/cleanup/communities with dry-run/apply + sidecar backup); cosmo23 gets the autonomous in-cycle driver per spec — no HTTP surface added. Donor tests exist at tests/engine/memory/community-detection.test.js and network-memory-community-plan.test.js (ESM, node:test) — patterns adapted to cosmo23 .cjs conventions.

SHARED-CONTRACT COMPLIANCE: G1 — the pass is a pure relabel: no delete/decay path is touched, no node or edge is created/deleted/reweighted; execution_result/execution_failure nodes keep every field except cluster (test-pinned); action is config-gated, count-logged (ledger + logger), and reversible in design intent (relabeling is non-destructive and re-derivable from edge structure; node.cluster history is not needed because stable-id reclamation keeps ids sticky). G2 — default OFF, arming thresholds minNodes 5000 / intervalCycles 50, gates-off pinned three ways (driver short-circuits before touching memory, persistenceGeneration frozen on all gated-off paths, birth-time _assignToClusterUnsafe adoption behavior test). G3 — moves go through _moveNodeToClusterUnsafe -> _markNodeDirtyUnsafe -> dirtyNodeIds -> capturePersistenceSnapshot().changes.nodes, which is exactly what the manifest delta chain consumes; node.cluster is the durable authority for manifest-backed saves (lib/memory-sidecar.js memoryShell zeroes the clusters list; orchestrator loadState rebuilds memory.clusters from node.cluster at orchestrator.js:9117-9161 — the task brief's ~8697 is stale, the tree moved); ledger events emitted via this.eventLedger?.log, never awaited (source-pinned). Legacy save() (serializeLegacyClusterEntries) actively validates coherence and throws on disagreement — test proves post-apply saves pass. G4 — n/a (no content gate here; no retroactive sweep of node CONTENT — the pass touches only the cluster field, which is the explicit purpose of this fix). G5 — node:test .test.cjs, assert/strict, tmpdir fixture with t.after cleanup, real-behavior via Orchestrator.prototype call on fakes (same pattern as tests/cosmo23/cycle-watchdog.test.cjs and engine-heartbeat.test.cjs), registered exactly once in package.json AND package-test-registration.test.cjs. G6 — every donor API assumption was verified by reading cosmo23's actual source; deltas listed above.

BOUNDED RUNTIME (verified, not assumed): no donor doc with explicit complexity notes exists; the bound is structural — buildAdjacency is one O(E) pass, propagateLabels is O(iterations x 2E) with iterations clamped at 100 (default 20), fold/claim are sub-linear in practice. Measured on this machine: 10,000 nodes / 39,880 edges planned in 106ms (2 iterations). Jerry-scale (29k nodes / 111k edges) extrapolates to well under one second. The pass is synchronous inside executeCycle, so the cycle watchdog's hard deadline (max(cycleTimeoutMs x 3, 10 min)) is the ultimate backstop.

BEHAVIORAL NOTES FOR THE IMPLEMENTER: (a) sleeping cycles return before the call site and consolidationMode returns at Phase 0 — the pass runs on awake cycles only, which also means it never contends with dream-phase rewiring; (b) a degenerate plan (one dense blob) is still applied — it is a no-op or near-no-op with stable ids, and degenerate: true is carried in the ledger event for observability; (c) plans are single-use and in-process only (typed member ids — never JSON-round-trip a plan); (d) the driver returns structured skip reasons ({ ran: false, reason: 'disabled' | 'below_min_nodes' | 'off_interval' | 'memory_unavailable' | 'error' }) so a future status surface can expose it without new plumbing; (e) pre-existing quirk, deliberately untouched: orchestrator.js:3740 and coordinator/meta-coordinator.js read memory.clusters with Object.keys()/.length on a Map (always 0/undefined) — they were degenerate before this fix and remain unchanged; (f) PGS/read-side NOT wired per spec — lib/pgs-engine.js's own Louvain partitioning (Patch 66 coarsening) is a separate read-side system and was not touched.

CONCURRENCY WARNINGS (the tree is hot — it changed mid-analysis): package.json and tests/cosmo23/package-test-registration.test.cjs BOTH carry foreign uncommitted hunks from other live sessions (cosmo23/lib/memory-sidecar.js and cosmo23/server/config/model-catalog.js also went dirty during this analysis, and new foreign test files appeared). All anchors were re-verified grep-unique against the live tree at proposal time (2026-07-22), but the implementer MUST re-run the uniqueness greps at apply time and stage surgically (git add -p; only the specific hunks above). NEVER git stash in this worktree (stash@{0} belongs to another session). Target files cosmo23/engine/src/memory/network-memory.js and cosmo23/engine/src/core/orchestrator.js were clean of foreign modifications at proposal time. Trailing-whitespace hazard: exactly one — the whitespace-only line (6 spaces) immediately above the '// PRODUCTION: Save state EVERY cycle for real-time tracking' anchor in orchestrator.js; keep it out of any old_string match. Validation harness artifacts live in the session scratchpad (community-detection.js, validate.cjs, community-detection.test.cjs) — the repo itself was never edited by this analysis (verified via git status: only foreign concurrent-session deltas present).
