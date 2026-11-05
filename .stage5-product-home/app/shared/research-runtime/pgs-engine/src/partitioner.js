/**
 * Partition enrichment functions for PGS.
 *
 * Given raw Louvain communities, nodes, and edges, these functions compute
 * centroid embeddings, extract keywords, find adjacent partitions, and
 * generate quick summaries — all without any LLM calls.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this',
  'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our',
  'you', 'your', 'he', 'she', 'his', 'her', 'what', 'which', 'who',
  'also', 'about', 'up', 'down', 'new', 'one', 'two', 'three', 'first'
]);

/**
 * Enrich raw Louvain communities with centroid embeddings, keywords,
 * adjacency information, and quick summaries.
 *
 * @param {Array<{id: number, nodeIds: string[]}>} communities - from runLouvain
 * @param {Array<{id, concept, embedding, tag, weight}>} nodes
 * @param {Array<{source, target, weight, type}>} edges
 * @returns {Array<Object>} Enriched partitions
 */
function enrichPartitions(communities, nodes, edges) {
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(String(node.id), node);
  }

  const partitions = [];

  for (const comm of communities) {
    const centroid = computeCentroid(comm.nodeIds, nodeMap);
    const keywords = extractKeywords(comm.nodeIds, nodeMap, 50);
    const adjacentPartitions = findAdjacentPartitions(comm, communities, edges);
    const summary = generateQuickSummary(comm.nodeIds, nodeMap, keywords);

    partitions.push({
      id: comm.id,
      nodeIds: comm.nodeIds,
      nodeCount: comm.nodeIds.length,
      summary,
      keywords: keywords.slice(0, 20),
      centroidEmbedding: centroid,
      adjacentPartitions
    });
  }

  return partitions;
}

/**
 * Compute centroid embedding (element-wise mean of node embeddings).
 * Skips nodes without valid array embeddings. Returns null if none found.
 *
 * @param {string[]} nodeIds
 * @param {Map<string, Object>} nodeMap
 * @returns {number[]|null}
 */
function computeCentroid(nodeIds, nodeMap) {
  let count = 0;
  let centroid = null;

  for (const nid of nodeIds) {
    const node = nodeMap.get(nid);
    if (!node?.embedding || !Array.isArray(node.embedding)) continue;

    if (!centroid) {
      centroid = new Array(node.embedding.length).fill(0);
    }

    for (let i = 0; i < node.embedding.length; i++) {
      centroid[i] += node.embedding[i];
    }
    count++;
  }

  if (!centroid || count === 0) return null;

  for (let i = 0; i < centroid.length; i++) {
    centroid[i] /= count;
  }

  return centroid;
}

/**
 * Extract top keywords from partition nodes using term frequency.
 * Uses document frequency (each term counted once per node).
 *
 * @param {string[]} nodeIds
 * @param {Map<string, Object>} nodeMap
 * @param {number} [topK=50]
 * @returns {string[]}
 */
function extractKeywords(nodeIds, nodeMap, topK = 50) {
  const termFreq = new Map();

  for (const nid of nodeIds) {
    const node = nodeMap.get(nid);
    if (!node?.concept) continue;

    const words = node.concept.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    const seen = new Set();
    for (const word of words) {
      if (!seen.has(word)) {
        termFreq.set(word, (termFreq.get(word) || 0) + 1);
        seen.add(word);
      }
    }
  }

  return [...termFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([term]) => term);
}

/**
 * Find partitions adjacent to this one (connected by cross-partition edges).
 * Returns top 5 sorted by shared edge count descending.
 *
 * @param {{id: number, nodeIds: string[]}} partition
 * @param {Array<{id: number, nodeIds: string[]}>} allPartitions
 * @param {Array<{source, target}>} edges
 * @returns {Array<{id: number, sharedEdges: number}>}
 */
function findAdjacentPartitions(partition, allPartitions, edges) {
  const nodeIdSet = new Set(partition.nodeIds);
  const adjacentWeights = new Map();

  // Build reverse lookup: nodeId -> partitionId
  const nodeToPartition = new Map();
  for (const p of allPartitions) {
    for (const nid of p.nodeIds) {
      nodeToPartition.set(nid, p.id);
    }
  }

  for (const edge of edges) {
    const src = String(edge.source);
    const tgt = String(edge.target);

    if (nodeIdSet.has(src) && !nodeIdSet.has(tgt)) {
      const targetPartition = nodeToPartition.get(tgt);
      if (targetPartition !== undefined && targetPartition !== partition.id) {
        adjacentWeights.set(targetPartition, (adjacentWeights.get(targetPartition) || 0) + 1);
      }
    } else if (nodeIdSet.has(tgt) && !nodeIdSet.has(src)) {
      const targetPartition = nodeToPartition.get(src);
      if (targetPartition !== undefined && targetPartition !== partition.id) {
        adjacentWeights.set(targetPartition, (adjacentWeights.get(targetPartition) || 0) + 1);
      }
    }
  }

  return [...adjacentWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pid, count]) => ({ id: pid, sharedEdges: count }));
}

/**
 * Generate a quick summary from top nodes and keywords (no LLM call).
 *
 * @param {string[]} nodeIds
 * @param {Map<string, Object>} nodeMap
 * @param {string[]} keywords
 * @returns {string}
 */
function generateQuickSummary(nodeIds, nodeMap, keywords) {
  const nodesWithWeight = nodeIds
    .map(nid => nodeMap.get(nid))
    .filter(n => n && n.concept)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));

  const topNode = nodesWithWeight[0];
  const topKeywords = keywords.slice(0, 8).join(', ');

  if (topNode) {
    const snippet = topNode.concept.substring(0, 120).replace(/\n/g, ' ');
    return `${topKeywords}. Top finding: ${snippet}...`;
  }

  return topKeywords || `Partition with ${nodeIds.length} nodes`;
}

module.exports = {
  enrichPartitions,
  computeCentroid,
  extractKeywords,
  findAdjacentPartitions,
  generateQuickSummary
};
