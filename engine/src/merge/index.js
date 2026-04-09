/**
 * COSMO Merge V2 - Public API
 * 
 * Deterministic, scalable brain merge with full provenance tracking.
 */

const crypto = require('crypto');
const { createSeededRng, deriveSeedFromRuns, sortNodesStable, sortEdgesStable, sortDomainsStable } = require('./deterministic');
const { DomainRegistry, detectDomain } = require('./domain-registry');
const { DomainEmbeddingProvider, combinedEmbedding, normalize } = require('./domain-embeddings');
const { createAnnIndex, cosineSimilarity } = require('./ann-index');
const { createProvenance, recordMerge, ensureProvenance, getProvenanceStats } = require('./provenance');
const { POLICIES, DEFAULT_POLICY, DEFAULT_CONFLICT_THRESHOLD, resolveConflict, mergeNodeData } = require('./conflict-resolver');

/**
 * Generate stable 6-character prefix from run name (matches V1)
 * @param {string} runName 
 * @returns {string}
 */
function getRunPrefix(runName) {
  const hash = crypto.createHash('sha256').update(runName).digest('hex');
  return hash.slice(0, 6);
}

/**
 * @typedef {Object} MergeOptions
 * @property {string} [seed] - Override seed for determinism
 * @property {number} [threshold] - Similarity threshold for merging (default 0.85)
 * @property {string} [conflictPolicy] - Conflict resolution policy
 * @property {number} [domainAlpha] - Domain embedding weight (default 0.15)
 * @property {number} [annK] - Number of ANN candidates (default 10)
 * @property {number} [maxProvenanceMerges] - Max merge events per node (default 100)
 * @property {number} [maxOutDegreePerNode] - Max edges per node (default 2000)
 * @property {object} [logger] - Logger instance
 */

const DEFAULT_OPTIONS = {
  threshold: 0.85,
  conflictPolicy: DEFAULT_POLICY,
  domainAlpha: 0.15,
  annK: 10,
  maxProvenanceMerges: 100,
  maxOutDegreePerNode: 2000
};

/**
 * @typedef {Object} MergeMetrics
 * @property {number} loadTimeMs
 * @property {number} embeddingTimeMs
 * @property {number} indexBuildTimeMs
 * @property {number} mergeLoopTimeMs
 * @property {number} serializationTimeMs
 * @property {number} totalTimeMs
 * @property {Object} conflictCounts
 * @property {Object} provenanceStats
 */

/**
 * Merge multiple runs into a single brain state
 * 
 * @param {object[]} loadedRuns - Array of loaded run states with metadata
 * @param {MergeOptions} options - Merge configuration
 * @returns {Promise<{brain: object, metrics: MergeMetrics}>}
 */
async function mergeRuns(loadedRuns, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = opts.logger || console;
  const metrics = {
    loadTimeMs: 0,
    embeddingTimeMs: 0,
    indexBuildTimeMs: 0,
    mergeLoopTimeMs: 0,
    serializationTimeMs: 0,
    totalTimeMs: 0,
    conflictCounts: {},
    provenanceStats: {}
  };
  
  const totalStart = Date.now();
  
  // Extract run names for seed derivation
  const runNames = loadedRuns.map(r => r.name || r.runName || 'unknown');
  const seed = opts.seed || deriveSeedFromRuns(runNames);
  
  logger.info?.(`Merge V2: ${loadedRuns.length} runs, seed: ${seed.slice(0, 12)}...`);
  
  // Initialize domain registry
  const domainRegistry = new DomainRegistry();
  
  // Initialize domain embedding provider
  const domainEmbeddings = new DomainEmbeddingProvider(
    { alpha: opts.domainAlpha, dimensions: 512 },
    logger
  );
  
  // Collect all nodes from all runs with domain info
  const allNodes = [];
  const runDomains = new Map();
  
  const loadStart = Date.now();
  for (const run of loadedRuns) {
    const domain = detectDomain(run);
    runDomains.set(run.name || run.runName, domain);
    domainRegistry.getDomainIndex(domain); // Register domain
    
    const nodes = run.state?.memory?.nodes || [];
    for (const node of nodes) {
      allNodes.push({
        ...node,
        _sourceRun: run.name || run.runName,
        _domain: domain
      });
    }
  }
  metrics.loadTimeMs = Date.now() - loadStart;
  
  logger.info?.(`Loaded ${allNodes.length} nodes from ${loadedRuns.length} runs`);
  logger.info?.(`Domains: ${domainRegistry.getDomains().join(', ')}`);
  
  // Sort nodes for deterministic processing
  allNodes.sort((a, b) => {
    // Sort by id
    const idCmp = String(a.id).localeCompare(String(b.id));
    if (idCmp !== 0) return idCmp;
    // Then by source run
    return (a._sourceRun || '').localeCompare(b._sourceRun || '');
  });
  
  // Compute combined embeddings with domain info
  const embeddingStart = Date.now();
  const nodeEmbeddings = new Map();
  
  for (const node of allNodes) {
    if (!node.embedding || !Array.isArray(node.embedding)) continue;
    
    try {
      const domainEmbed = await domainEmbeddings.getEmbedding(node._domain);
      const combined = combinedEmbedding(node.embedding, domainEmbed, opts.domainAlpha);
      nodeEmbeddings.set(node, combined);
    } catch (err) {
      logger.warn?.(`Failed to compute embedding for node ${node.id}: ${err.message}`);
      nodeEmbeddings.set(node, node.embedding); // Fallback to raw embedding
    }
  }
  metrics.embeddingTimeMs = Date.now() - embeddingStart;
  
  // Build ANN index
  const indexStart = Date.now();
  const annIndex = createAnnIndex(512, {}, logger);
  metrics.indexBuildTimeMs = Date.now() - indexStart;
  
  // Main merge loop
  const mergeStart = Date.now();
  const mergedNodes = [];
  const mergedNodeMap = new Map(); // newId -> node
  const idMapping = new Map(); // compound key "runName:originalId" -> newId (for edge remapping)
  const conflictCounts = {};
  let nextNodeIndex = 1;
  
  // Context for conflict resolution
  let maxDegree = 0;
  let maxAgeMs = 365 * 24 * 60 * 60 * 1000; // 1 year default
  
  // First pass: find max degree
  for (const node of allNodes) {
    const deg = node.degree || node.connections || 0;
    if (deg > maxDegree) maxDegree = deg;
  }
  
  const conflictContext = {
    maxDegree,
    maxAgeMs,
    threshold: opts.threshold
  };
  
  logger.info?.(`Starting merge loop with threshold ${opts.threshold}, policy ${opts.conflictPolicy}`);
  
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i];
    const embedding = nodeEmbeddings.get(node);
    const sourceRun = node._sourceRun;
    const originalId = node.id;
    const compoundKey = `${sourceRun}:${originalId}`;
    
    if (!embedding) {
      // No embedding - keep as-is with prefixed ID
      const runPrefix = getRunPrefix(sourceRun);
      const newId = `${runPrefix}_${nextNodeIndex++}`;
      
      const provenance = ensureProvenance(node, sourceRun);
      const newNode = { 
        ...node, 
        id: newId,
        originalId: originalId,
        sourceRun: sourceRun,
        runPrefix: runPrefix,
        provenance 
      };
      delete newNode._sourceRun;
      delete newNode._domain;
      
      mergedNodes.push(newNode);
      mergedNodeMap.set(newId, newNode);
      idMapping.set(compoundKey, newId);
      continue;
    }
    
    // Search for candidates
    let candidates = [];
    if (annIndex.size > 0) {
      const result = annIndex.searchKnn(embedding, opts.annK);
      candidates = result.ids.map((id, idx) => ({
        id,
        distance: result.distances[idx],
        similarity: 1 - result.distances[idx]
      })).filter(c => c.similarity >= opts.threshold);
    }
    
    // Find best match above threshold
    let bestMatch = null;
    let bestSimilarity = 0;
    
    for (const candidate of candidates) {
      if (candidate.similarity > bestSimilarity) {
        bestSimilarity = candidate.similarity;
        bestMatch = mergedNodeMap.get(candidate.id);
      }
    }
    
    if (bestMatch && bestSimilarity >= opts.threshold) {
      // CRITICAL: Don't merge nodes from the SAME source run
      // Prevents intra-run collapse (different insights from same run matching each other)
      // Check both sourceRun (first node) and sourceRuns array (merged nodes)
      const sameRun = bestMatch.sourceRun === sourceRun || 
                      bestMatch.sourceRuns?.includes(sourceRun);
      
      if (sameRun) {
        bestMatch = null; // Force as new node - don't collapse same-run insights
      }
    }
    
    if (bestMatch && bestSimilarity >= opts.threshold) {
      // DUPLICATE FOUND - Follow V1 pattern: keep matched node, update content if better
      // V1: Always keeps matchedNode.id, never replaces it
      
      // Track conflict counts
      conflictCounts['BEST_REP'] = (conflictCounts['BEST_REP'] || 0) + 1;
      
      // Map incoming node's compound key to the existing matched node's ID
      // This is CRITICAL for edge remapping
      idMapping.set(compoundKey, bestMatch.id);
      
      // V1 pattern: Use scoring to decide if incoming node's CONTENT is better
      const nodeScore = (node.activation || 0) * 0.35 + 
                       (node.accessCount || 0) * 0.15 +
                       (node.weight || 1) * 0.10 +
                       (node.degree || 0) * 0.10;
      const matchScore = (bestMatch.activation || 0) * 0.35 + 
                        (bestMatch.accessCount || 0) * 0.15 +
                        (bestMatch.weight || 1) * 0.10 +
                        (bestMatch.degree || 0) * 0.10;
      
      // If incoming node is better, update matched node's content (but keep its ID!)
      if (nodeScore > matchScore) {
        bestMatch.concept = node.concept;
        bestMatch.embedding = node.embedding;
        bestMatch.tag = node.tag;
      }
      
      // Aggregate numeric values regardless of which content wins
      bestMatch.activation = Math.max(bestMatch.activation || 0, node.activation || 0);
      bestMatch.weight = Math.max(bestMatch.weight || 1, node.weight || 1);
      bestMatch.accessCount = (bestMatch.accessCount || 0) + (node.accessCount || 0);
      bestMatch.degree = (bestMatch.degree || 0) + (node.degree || 0);
      
      // Track source runs
      bestMatch.sourceRuns = bestMatch.sourceRuns || [];
      if (sourceRun && !bestMatch.sourceRuns.includes(sourceRun)) {
        bestMatch.sourceRuns.push(sourceRun);
      }
      
      // Update provenance
      if (!bestMatch.provenance) {
        bestMatch.provenance = ensureProvenance(bestMatch, bestMatch.sourceRun);
      }
      const incomingProvenance = ensureProvenance(node, sourceRun);
      recordMerge(bestMatch.provenance, incomingProvenance, {
        similarity: bestSimilarity,
        policy: 'BEST_REP',
        contested: false,
        confidence: bestSimilarity
      }, opts.maxProvenanceMerges);
      
    } else {
      // No match - add as new node with prefixed ID
      const runPrefix = getRunPrefix(sourceRun);
      const newId = `${runPrefix}_${nextNodeIndex++}`;
      
      const provenance = ensureProvenance(node, sourceRun);
      const newNode = { 
        ...node, 
        id: newId,
        originalId: originalId,
        sourceRun: sourceRun,
        runPrefix: runPrefix,
        sourceRuns: [sourceRun],
        provenance 
      };
      delete newNode._sourceRun;
      delete newNode._domain;
      
      mergedNodes.push(newNode);
      mergedNodeMap.set(newId, newNode);
      annIndex.addPoint(embedding, newId);
      idMapping.set(compoundKey, newId);
    }
    
    // Progress logging
    if ((i + 1) % 1000 === 0 || i === allNodes.length - 1) {
      logger.info?.(`Processed ${i + 1}/${allNodes.length} nodes, ${mergedNodes.length} merged`);
    }
  }
  
  metrics.mergeLoopTimeMs = Date.now() - mergeStart;
  metrics.conflictCounts = conflictCounts;
  
  // Merge edges using compound keys for proper remapping
  const edgeMap = new Map(); // "source->target->type" -> edge
  let orphanEdges = 0;
  
  for (const run of loadedRuns) {
    const runName = run.name || run.runName;
    const edges = run.state?.memory?.edges || [];
    
    for (const edge of edges) {
      const source = edge.source || edge.from;
      const target = edge.target || edge.to;
      
      // Skip invalid edges
      if (source === null || source === undefined || target === null || target === undefined) {
        orphanEdges++;
        continue;
      }
      
      // Use compound keys for remapping
      const sourceKey = `${runName}:${source}`;
      const targetKey = `${runName}:${target}`;
      
      const newSource = idMapping.get(sourceKey);
      const newTarget = idMapping.get(targetKey);
      
      if (!newSource || !newTarget) {
        orphanEdges++;
        continue;
      }
      
      // Skip self-loops
      if (newSource === newTarget) {
        continue;
      }
      
      const key = `${newSource}->${newTarget}->${edge.type || 'associative'}`;
      
      if (edgeMap.has(key)) {
        // Merge edge weights
        const existing = edgeMap.get(key);
        existing.weight = (existing.weight || 1) + (edge.weight || 1);
        existing.count = (existing.count || 1) + 1;
      } else {
        edgeMap.set(key, {
          source: newSource,
          target: newTarget,
          type: edge.type || 'associative',
          weight: edge.weight || 1,
          created: edge.created || new Date().toISOString()
        });
      }
    }
  }
  
  if (orphanEdges > 0) {
    logger.warn?.(`Dropped ${orphanEdges} orphan edges (missing nodes)`);
  }
  
  // Apply max out-degree limit
  const edgesBySource = new Map();
  for (const edge of edgeMap.values()) {
    if (!edgesBySource.has(edge.source)) {
      edgesBySource.set(edge.source, []);
    }
    edgesBySource.get(edge.source).push(edge);
  }
  
  const mergedEdges = [];
  let truncatedEdges = 0;
  
  for (const [source, edges] of edgesBySource) {
    if (edges.length <= opts.maxOutDegreePerNode) {
      mergedEdges.push(...edges);
    } else {
      // Keep highest weight edges
      edges.sort((a, b) => (b.weight || 1) - (a.weight || 1));
      mergedEdges.push(...edges.slice(0, opts.maxOutDegreePerNode));
      truncatedEdges += edges.length - opts.maxOutDegreePerNode;
    }
  }
  
  if (truncatedEdges > 0) {
    logger.warn?.(`Truncated ${truncatedEdges} edges due to maxOutDegreePerNode limit`);
  }
  
  // Update node degrees
  const degreeCount = new Map();
  for (const edge of mergedEdges) {
    degreeCount.set(edge.source, (degreeCount.get(edge.source) || 0) + 1);
    degreeCount.set(edge.target, (degreeCount.get(edge.target) || 0) + 1);
  }
  
  for (const node of mergedNodes) {
    node.degree = degreeCount.get(String(node.id)) || 0;
  }
  
  // Sort for deterministic output
  const serializeStart = Date.now();
  const sortedNodes = sortNodesStable(mergedNodes);
  const sortedEdges = sortEdgesStable(mergedEdges);
  const sortedDomains = sortDomainsStable(domainRegistry.getDomains());
  
  // Compute provenance stats
  metrics.provenanceStats = getProvenanceStats(sortedNodes);
  metrics.serializationTimeMs = Date.now() - serializeStart;
  metrics.totalTimeMs = Date.now() - totalStart;
  
  logger.info?.(`Merge complete: ${sortedNodes.length} nodes, ${sortedEdges.length} edges`);
  logger.info?.(`Time: ${metrics.totalTimeMs}ms total`);
  
  // Build merged brain state
  const brain = {
    nodes: sortedNodes,
    edges: sortedEdges,
    domains: sortedDomains,
    domainRegistry: domainRegistry.toJSON(),
    annIndex: annIndex.serialize(),
    mergeVersion: 2,
    mergeSeed: seed,
    mergeTimestamp: new Date().toISOString()
  };
  
  return { brain, metrics };
}

/**
 * Merge new runs into an existing brain (incremental merge)
 * 
 * @param {object} baseBrain - Existing brain state
 * @param {object[]} newRuns - Array of new run states
 * @param {MergeOptions} options - Merge configuration
 * @returns {Promise<{brain: object, metrics: MergeMetrics}>}
 */
async function mergeInto(baseBrain, newRuns, options = {}) {
  // Convert base brain to "loaded run" format
  const baseAsRun = {
    name: '_base_brain',
    state: {
      memory: {
        nodes: baseBrain.nodes || [],
        edges: baseBrain.edges || []
      }
    },
    metadata: {
      domain: 'merged'
    }
  };
  
  // Merge all together
  return mergeRuns([baseAsRun, ...newRuns], options);
}

module.exports = {
  mergeRuns,
  mergeInto,
  
  // Re-export utilities
  getRunPrefix,
  DomainRegistry,
  detectDomain,
  DomainEmbeddingProvider,
  combinedEmbedding,
  normalize,
  createAnnIndex,
  cosineSimilarity,
  createProvenance,
  recordMerge,
  ensureProvenance,
  getProvenanceStats,
  POLICIES,
  resolveConflict,
  mergeNodeData,
  deriveSeedFromRuns,
  sortNodesStable,
  sortEdgesStable,
  sortDomainsStable,
  
  DEFAULT_OPTIONS
};

