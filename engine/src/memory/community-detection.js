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
