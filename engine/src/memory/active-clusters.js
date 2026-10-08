/**
 * Active cluster summarization for cognitive cycles.
 *
 * Goal: provide a compact, real-memory-derived context block (top recent clusters)
 * without ever breaking a cycle.
 */

const {
  classifyMemoryDomain,
  classifyClaimAuthority,
  scoreMemoryAuthority,
  getSemanticTimeMs,
  normalizeRetrievalIntent,
  createMemoryAuthorityResolver,
} = require('../../../shared/memory-authority.cjs');
const { performance } = require('node:perf_hooks');

const SCAN_SLICE_MS = 8;
const SCAN_SLICE_NODES = 256;

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
async function getActiveClusterSummary(memoryGraph, maxClusters = 5, maxNodesPerCluster = 3, options = {}) {
  try {
    if (!memoryGraph) return null;

    const sourceNodes = memoryGraph.nodes;
    if (!sourceNodes) return null;
    const isMap = sourceNodes instanceof Map;
    // Capture identities before yielding, including nodes not yet visited.
    // This copies references only; it never enumerates a node's payload.
    const tokens = isMap ? Array.from(sourceNodes.entries()) : Object.entries(sourceNodes);
    const size = tokens.length;
    if (size === 0) return null;
    const generation = memoryGraph.persistenceGeneration;
    const cluster = memoryGraph.__cluster;
    const clusterVersion = cluster?.versionClock;
    const assertCurrent = () => {
      if (memoryGraph.nodes !== sourceNodes
          || !Object.is(memoryGraph.persistenceGeneration, generation)
          || !Object.is(cluster?.versionClock, clusterVersion)
          || (isMap && sourceNodes.size !== size)) {
        throw new Error('active_cluster_summary_source_changed');
      }
    };
    let sliceStartedAt = performance.now();
    let sliceNodes = 0;
    const sliceEnded = () => ++sliceNodes >= SCAN_SLICE_NODES
      || performance.now() - sliceStartedAt >= SCAN_SLICE_MS;
    const yieldScan = async () => {
      await new Promise(resolve => setImmediate(resolve));
      assertCurrent();
      sliceStartedAt = performance.now();
      sliceNodes = 0;
    };
    const intent = normalizeRetrievalIntent(options.intent || 'current_state');
    const resolver = createMemoryAuthorityResolver({ intent });
    // Observe the complete graph before resolving candidates: a correction or
    // closure near the end must still suppress an earlier claim. Retain only
    // identity tokens, not copies of embedding or other unused payloads.
    for (const [key, node] of tokens) {
      if ((isMap ? sourceNodes.get(key) : sourceNodes[key]) !== node) {
        throw new Error('active_cluster_summary_source_changed');
      }
      resolver.observe(node);
      if (sliceEnded()) await yieldScan();
    }
    const nodes = [];
    for (const [key, n] of tokens) {
      if ((isMap ? sourceNodes.get(key) : sourceNodes[key]) !== n) {
        throw new Error('active_cluster_summary_source_changed');
      }
      if (n && (n.concept || n.summary || n.keyPhrase || n.tag)
          && resolver.apply([n], { includeNodePayload: false }).length > 0
          && (intent !== 'current_state' || (
            classifyMemoryDomain(n) === 'current_ops'
            && ['verified_current_state', 'jtr_correction', 'artifact_log', 'worker_receipt']
              .includes(classifyClaimAuthority(n))
          ))) {
        const accessed = toTs(n.accessed || n.lastAccessed || n.updatedAt);
        const created = toTs(n.created || n.createdAt);
        const recency = accessed || created;
        if (recency > 0) nodes.push({
          id: n.id,
          cluster: n.cluster ?? 'general',
          tag: n.tag,
          keyPhrase: n.keyPhrase,
          summary: n.summary,
          concept: n.concept,
          weight: typeof n.weight === 'number' ? n.weight : 0,
          activation: typeof n.activation === 'number' ? n.activation : 0,
          recency,
          authorityScore: scoreMemoryAuthority(n, 1, {
            intent: options.intent || 'current_state',
            nowMs: options.nowMs,
          }),
          semanticTime: getSemanticTimeMs(n),
        });
      }
      if (sliceEnded()) await yieldScan();
    }

    if (nodes.length === 0) return null;

    // Score clusters by their most-recent node access; tie-break by summed weight.
    const clusterAgg = new Map();
    for (const n of nodes) {
      const key = n.cluster;
      const prev = clusterAgg.get(key) || { last: 0, semanticTime: 0, authority: 0, weight: 0 };
      clusterAgg.set(key, {
        last: Math.max(prev.last, n.recency),
        semanticTime: Math.max(prev.semanticTime, n.semanticTime),
        authority: Math.max(prev.authority, n.authorityScore),
        weight: prev.weight + (n.weight || 0)
      });
    }

    const rankedClusters = Array.from(clusterAgg.entries())
      .sort((a, b) => {
        // Authority is primary so a recently accessed archive cannot outrank
        // current evidence. Semantic event time then beats access recency.
        if (b[1].authority !== a[1].authority) return b[1].authority - a[1].authority;
        if (b[1].semanticTime !== a[1].semanticTime) return b[1].semanticTime - a[1].semanticTime;
        if (b[1].last !== a[1].last) return b[1].last - a[1].last;
        // secondary: weight
        return (b[1].weight || 0) - (a[1].weight || 0);
      })
      .slice(0, maxClusters);

    const lines = [];
    for (const [clusterId] of rankedClusters) {
      const clusterNodes = nodes
        .filter(n => n.cluster === clusterId)
        .sort((a, b) => (b.authorityScore - a.authorityScore)
          || (b.semanticTime - a.semanticTime)
          || (b.recency - a.recency))
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

    // A plain Map can replace an already visited node without changing size.
    // This final identity-only check is synchronous: a replacement cannot slip
    // behind an already checked token while publishing the finished summary.
    for (const [key, node] of tokens) {
      if ((isMap ? sourceNodes.get(key) : sourceNodes[key]) !== node) {
        throw new Error('active_cluster_summary_source_changed');
      }
    }
    assertCurrent();
    if (!isMap && Object.keys(sourceNodes).length !== size) return null;
    if (lines.length === 0) return null;

    return `Recent active knowledge clusters:\n${lines.join('\n')}`;
  } catch (e) {
    return null; // never break cycles
  }
}

module.exports = { getActiveClusterSummary };
