/**
 * Active cluster summarization for cognitive cycles.
 *
 * Goal: provide a compact, real-memory-derived context block (top recent clusters)
 * without ever breaking a cycle.
 */

function safeSnippet(text, maxLen = 120) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

function toTs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {object} memoryGraph - expected NetworkMemory-like object
 * @param {number} maxClusters
 * @param {number} maxNodesPerCluster
 * @returns {Promise<string|null>}
 */
async function getActiveClusterSummary(memoryGraph, maxClusters = 5, maxNodesPerCluster = 3) {
  try {
    if (!memoryGraph) return null;

    // Support both Map-based (NetworkMemory) and object-based graphs.
    const nodesIterable = memoryGraph.nodes instanceof Map
      ? Array.from(memoryGraph.nodes.values())
      : Object.values(memoryGraph.nodes || {});

    if (!Array.isArray(nodesIterable) || nodesIterable.length === 0) return null;

    const nodes = nodesIterable
      .filter(n => n && (n.concept || n.summary || n.keyPhrase || n.tag))
      .map(n => {
        const accessed = toTs(n.accessed || n.lastAccessed || n.updatedAt);
        const created = toTs(n.created || n.createdAt);
        const recency = accessed || created;
        return {
          id: n.id,
          cluster: n.cluster ?? 'general',
          tag: n.tag,
          keyPhrase: n.keyPhrase,
          summary: n.summary,
          concept: n.concept,
          weight: typeof n.weight === 'number' ? n.weight : 0,
          activation: typeof n.activation === 'number' ? n.activation : 0,
          recency
        };
      })
      .filter(n => n.recency > 0);

    if (nodes.length === 0) return null;

    // Score clusters by their most-recent node access; tie-break by summed weight.
    const clusterAgg = new Map();
    for (const n of nodes) {
      const key = n.cluster;
      const prev = clusterAgg.get(key) || { last: 0, weight: 0 };
      clusterAgg.set(key, {
        last: Math.max(prev.last, n.recency),
        weight: prev.weight + (n.weight || 0)
      });
    }

    const rankedClusters = Array.from(clusterAgg.entries())
      .sort((a, b) => {
        // primary: recency
        if (b[1].last !== a[1].last) return b[1].last - a[1].last;
        // secondary: weight
        return (b[1].weight || 0) - (a[1].weight || 0);
      })
      .slice(0, maxClusters);

    const lines = [];
    for (const [clusterId] of rankedClusters) {
      const clusterNodes = nodes
        .filter(n => n.cluster === clusterId)
        .sort((a, b) => b.recency - a.recency)
        .slice(0, maxNodesPerCluster);

      const items = clusterNodes
        .map(n => safeSnippet(n.keyPhrase) || safeSnippet(n.summary) || safeSnippet(n.concept))
        .filter(Boolean);

      if (items.length === 0) continue;

      // Optional: a lightweight "label" using most common tag among sampled nodes.
      const tagCounts = new Map();
      for (const n of clusterNodes) {
        if (!n.tag) continue;
        tagCounts.set(n.tag, (tagCounts.get(n.tag) || 0) + 1);
      }
      const topTag = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
      const label = topTag ? ` (${topTag})` : '';

      lines.push(`- Cluster ${clusterId}${label}: ${items.map(i => `"${i}"`).join(', ')}`);
    }

    if (lines.length === 0) return null;

    return `Recent active knowledge clusters:\n${lines.join('\n')}`;
  } catch (e) {
    return null; // never break cycles
  }
}

module.exports = { getActiveClusterSummary };
