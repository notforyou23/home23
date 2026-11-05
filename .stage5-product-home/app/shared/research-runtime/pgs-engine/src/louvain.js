/**
 * Louvain community detection algorithm (standalone, pure JS)
 * Extracted from lib/pgs-engine.js
 */

/**
 * Louvain community detection algorithm
 * @param {Array<{id: string|number}>} nodes
 * @param {Array<{source: string|number, target: string|number, weight?: number}>} edges
 * @param {{minCommunitySize?: number, targetPartitionMax?: number}} config
 * @returns {Array<{id: number, nodeIds: string[]}>}
 */
function runLouvain(nodes, edges, config) {
  const { minCommunitySize, targetPartitionMax } = config;

  // Build adjacency list with weights
  const adj = new Map(); // nodeId -> Map<neighborId, totalWeight>
  const nodeIds = nodes.map(n => String(n.id));
  const nodeIdSet = new Set(nodeIds);

  for (const nid of nodeIds) {
    adj.set(nid, new Map());
  }

  // Total graph weight (sum of all edge weights)
  let totalWeight = 0;
  for (const edge of edges) {
    const src = String(edge.source);
    const tgt = String(edge.target);
    if (!nodeIdSet.has(src) || !nodeIdSet.has(tgt)) continue;
    const w = edge.weight || 0.5;
    totalWeight += w;

    // Undirected: add both directions
    if (!adj.has(src)) adj.set(src, new Map());
    if (!adj.has(tgt)) adj.set(tgt, new Map());
    adj.get(src).set(tgt, (adj.get(src).get(tgt) || 0) + w);
    adj.get(tgt).set(src, (adj.get(tgt).get(src) || 0) + w);
  }

  if (totalWeight === 0) {
    // No edges: every node in one big community (or return single partition)
    return [{ id: 0, nodeIds }];
  }

  const m2 = 2 * totalWeight; // 2m in Louvain notation

  // Initialize: each node in its own community
  const community = new Map(); // nodeId -> communityId
  const communityNodes = new Map(); // communityId -> Set<nodeId>

  for (let i = 0; i < nodeIds.length; i++) {
    community.set(nodeIds[i], i);
    communityNodes.set(i, new Set([nodeIds[i]]));
  }

  // Precompute node strengths (sum of edge weights for each node)
  const strength = new Map();
  for (const nid of nodeIds) {
    let s = 0;
    const neighbors = adj.get(nid);
    if (neighbors) {
      for (const w of neighbors.values()) s += w;
    }
    strength.set(nid, s);
  }

  // Community total strength (sum of strengths of all nodes in community)
  const communityStrength = new Map();
  for (const [cid, members] of communityNodes) {
    let total = 0;
    for (const nid of members) total += strength.get(nid) || 0;
    communityStrength.set(cid, total);
  }

  // Iterative optimization
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = false;

    // Shuffle nodes for better convergence
    const shuffled = [...nodeIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const nid of shuffled) {
      const currentComm = community.get(nid);
      const neighbors = adj.get(nid);
      if (!neighbors || neighbors.size === 0) continue;

      const ki = strength.get(nid) || 0;

      // Compute weight to each neighbor community
      const commWeights = new Map(); // communityId -> sum of edge weights to that community
      for (const [neighbor, w] of neighbors) {
        const neighborComm = community.get(neighbor);
        commWeights.set(neighborComm, (commWeights.get(neighborComm) || 0) + w);
      }

      // Modularity gain for removing node from current community
      const wCurrent = commWeights.get(currentComm) || 0;
      const sigmaCurrent = communityStrength.get(currentComm) || 0;
      const removeGain = wCurrent - (ki * (sigmaCurrent - ki)) / m2;

      // Find best community to move to
      let bestComm = currentComm;
      let bestGain = 0;

      for (const [targetComm, wTarget] of commWeights) {
        if (targetComm === currentComm) continue;
        const sigmaTarget = communityStrength.get(targetComm) || 0;
        const gain = wTarget - (ki * sigmaTarget) / m2;
        const netGain = gain - removeGain;
        if (netGain > bestGain) {
          bestGain = netGain;
          bestComm = targetComm;
        }
      }

      // Move node if beneficial
      if (bestComm !== currentComm && bestGain > 1e-10) {
        // Remove from current
        communityNodes.get(currentComm).delete(nid);
        communityStrength.set(currentComm, (communityStrength.get(currentComm) || 0) - ki);

        // Clean up empty communities
        if (communityNodes.get(currentComm).size === 0) {
          communityNodes.delete(currentComm);
          communityStrength.delete(currentComm);
        }

        // Add to new
        community.set(nid, bestComm);
        if (!communityNodes.has(bestComm)) {
          communityNodes.set(bestComm, new Set());
        }
        communityNodes.get(bestComm).add(nid);
        communityStrength.set(bestComm, (communityStrength.get(bestComm) || 0) + ki);

        moved = true;
      }
    }

    if (!moved) break; // Converged
  }

  // Post-process: merge small communities into their most-connected neighbor
  mergeSmallCommunities(communityNodes, community, adj, minCommunitySize);

  // Post-process: split oversized communities
  splitLargeCommunities(communityNodes, community, adj, nodes, targetPartitionMax);

  // Convert to partition format
  const result = [];
  let partitionId = 0;
  for (const [, members] of communityNodes) {
    if (members.size === 0) continue;
    result.push({
      id: partitionId++,
      nodeIds: [...members]
    });
  }

  return result;
}

/**
 * Merge communities smaller than minSize into their most-connected neighbor.
 * Iteratively merges until stable. Mutates communityNodes and community in place.
 * @param {Map<number, Set<string>>} communityNodes
 * @param {Map<string, number>} community
 * @param {Map<string, Map<string, number>>} adj
 * @param {number} minSize
 */
function mergeSmallCommunities(communityNodes, community, adj, minSize) {
  let merged = true;
  while (merged) {
    merged = false;
    for (const [cid, members] of communityNodes) {
      if (members.size >= minSize || members.size === 0) continue;

      // Find most-connected neighboring community
      const neighborCommWeights = new Map();
      for (const nid of members) {
        const neighbors = adj.get(nid);
        if (!neighbors) continue;
        for (const [neighbor, w] of neighbors) {
          const nComm = community.get(neighbor);
          if (nComm !== cid) {
            neighborCommWeights.set(nComm, (neighborCommWeights.get(nComm) || 0) + w);
          }
        }
      }

      if (neighborCommWeights.size === 0) continue;

      // Find best target
      let bestTarget = null;
      let bestWeight = -1;
      for (const [targetComm, w] of neighborCommWeights) {
        if (w > bestWeight) {
          bestWeight = w;
          bestTarget = targetComm;
        }
      }

      if (bestTarget === null) continue;

      // Merge: move all nodes to target community
      for (const nid of members) {
        community.set(nid, bestTarget);
        communityNodes.get(bestTarget).add(nid);
      }
      members.clear();
      communityNodes.delete(cid);
      merged = true;
      break; // Restart after merge
    }
  }
}

/**
 * Split communities larger than maxSize using greedy bisection.
 * Mutates communityNodes and community in place.
 * @param {Map<number, Set<string>>} communityNodes
 * @param {Map<string, number>} community
 * @param {Map<string, Map<string, number>>} adj
 * @param {Array} allNodes - Legacy parameter (not read in current impl)
 * @param {number} maxSize
 */
function splitLargeCommunities(communityNodes, community, adj, allNodes, maxSize) {
  const toSplit = [];
  for (const [cid, members] of communityNodes) {
    if (members.size > maxSize) toSplit.push(cid);
  }

  for (const cid of toSplit) {
    const members = [...communityNodes.get(cid)];
    if (members.length <= maxSize) continue;

    // Simple bisection: split into two halves based on internal connectivity
    // Assign first node to group A, then greedily assign each node to the group
    // it has more connections to, trying to keep sizes balanced
    const groupA = new Set();
    const groupB = new Set();

    // Seed: use the two nodes with the weakest connection between them
    groupA.add(members[0]);
    groupB.add(members[Math.floor(members.length / 2)]);

    for (let i = 1; i < members.length; i++) {
      const nid = members[i];
      if (groupA.has(nid) || groupB.has(nid)) continue;

      let wA = 0, wB = 0;
      const neighbors = adj.get(nid);
      if (neighbors) {
        for (const [neighbor, w] of neighbors) {
          if (groupA.has(neighbor)) wA += w;
          if (groupB.has(neighbor)) wB += w;
        }
      }

      // Balance factor: prefer the smaller group
      const balanceFactor = 0.1;
      const scoreA = wA - balanceFactor * groupA.size;
      const scoreB = wB - balanceFactor * groupB.size;

      if (scoreA >= scoreB) {
        groupA.add(nid);
      } else {
        groupB.add(nid);
      }
    }

    // Replace original community with group A, create new community for group B
    const existingKeys = [...communityNodes.keys()];
    const newCid = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 0;

    communityNodes.get(cid).clear();
    for (const nid of groupA) {
      communityNodes.get(cid).add(nid);
      community.set(nid, cid);
    }

    communityNodes.set(newCid, new Set());
    for (const nid of groupB) {
      communityNodes.get(newCid).add(nid);
      community.set(nid, newCid);
    }
  }
}

module.exports = { runLouvain, mergeSmallCommunities, splitLargeCommunities };
