/**
 * COSMO Merge V2 - Node Provenance Tracking
 * 
 * Tracks origin, merge history, and lineage for every node.
 */

/**
 * @typedef {Object} NodeProvenanceMergeEvent
 * @property {string} fromRun - Source run name
 * @property {string|number} fromId - Source node ID
 * @property {string} intoRun - Target run name
 * @property {string|number} intoId - Target node ID
 * @property {number} similarity - Similarity score at merge
 * @property {string} timestamp - ISO8601 timestamp
 * @property {string} policy - Conflict policy used
 * @property {boolean} contested - Whether merge was contested
 * @property {number} confidence - Confidence score 0.0-1.0
 */

/**
 * @typedef {Object} NodeProvenance
 * @property {{run: string, id: string|number, created: string}} origin
 * @property {NodeProvenanceMergeEvent[]} merges
 * @property {number} lineageDepth
 */

const DEFAULT_MAX_MERGES = 100;

/**
 * Create initial provenance for a new node
 * 
 * @param {string} run - Run name
 * @param {string|number} id - Node ID
 * @param {string} created - ISO8601 creation timestamp
 * @returns {NodeProvenance}
 */
function createProvenance(run, id, created) {
  return {
    origin: {
      run,
      id,
      created: created || new Date().toISOString()
    },
    merges: [],
    lineageDepth: 0
  };
}

/**
 * Record a merge event in provenance
 * 
 * @param {NodeProvenance} targetProvenance - Provenance of the surviving node
 * @param {NodeProvenance} sourceProvenance - Provenance of the merged-in node
 * @param {Object} mergeInfo - Merge details
 * @param {number} mergeInfo.similarity
 * @param {string} mergeInfo.policy
 * @param {boolean} mergeInfo.contested
 * @param {number} mergeInfo.confidence
 * @param {number} maxMerges - Max merge events to keep (default 100)
 * @returns {NodeProvenance} - Updated provenance (mutates targetProvenance)
 */
function recordMerge(targetProvenance, sourceProvenance, mergeInfo, maxMerges = DEFAULT_MAX_MERGES) {
  const event = {
    fromRun: sourceProvenance.origin.run,
    fromId: sourceProvenance.origin.id,
    intoRun: targetProvenance.origin.run,
    intoId: targetProvenance.origin.id,
    similarity: mergeInfo.similarity,
    timestamp: new Date().toISOString(),
    policy: mergeInfo.policy,
    contested: mergeInfo.contested,
    confidence: mergeInfo.confidence
  };
  
  // Add the merge event
  targetProvenance.merges.push(event);
  
  // Carry forward any merges from the source
  if (sourceProvenance.merges && sourceProvenance.merges.length > 0) {
    targetProvenance.merges.push(...sourceProvenance.merges);
  }
  
  // Update lineage depth
  const sourceDepth = sourceProvenance.lineageDepth || 0;
  const targetDepth = targetProvenance.lineageDepth || 0;
  targetProvenance.lineageDepth = Math.max(sourceDepth, targetDepth) + 1;
  
  // Handle size management if exceeding max
  if (targetProvenance.merges.length > maxMerges) {
    targetProvenance = truncateProvenance(targetProvenance, maxMerges);
  }
  
  return targetProvenance;
}

/**
 * Truncate provenance when it exceeds max merges
 * Keeps most recent events, rolls up oldest into summary
 * 
 * @param {NodeProvenance} provenance 
 * @param {number} maxMerges 
 * @returns {NodeProvenance}
 */
function truncateProvenance(provenance, maxMerges) {
  if (provenance.merges.length <= maxMerges) {
    return provenance;
  }
  
  // Sort by timestamp (oldest first)
  const sorted = [...provenance.merges].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  // Calculate how many to truncate
  const truncateCount = sorted.length - maxMerges + 1; // +1 for summary event
  const toTruncate = sorted.slice(0, truncateCount);
  const toKeep = sorted.slice(truncateCount);
  
  // Create rollup summary
  const avgConfidence = toTruncate.reduce((sum, e) => sum + e.confidence, 0) / toTruncate.length;
  const rollupEvent = {
    fromRun: '[rolled up]',
    fromId: `${truncateCount} events`,
    intoRun: provenance.origin.run,
    intoId: provenance.origin.id,
    similarity: 0,
    timestamp: toTruncate[0].timestamp, // Earliest timestamp
    policy: 'ROLLED_UP',
    contested: false,
    confidence: avgConfidence
  };
  
  provenance.merges = [rollupEvent, ...toKeep];
  
  return provenance;
}

/**
 * Ensure a node has provenance (migrate V1 nodes)
 * 
 * @param {object} node - Node object
 * @param {string} runName - Run name for origin
 * @returns {NodeProvenance}
 */
function ensureProvenance(node, runName) {
  if (node.provenance && node.provenance.origin) {
    return node.provenance;
  }
  
  // Migrate from V1: use existing sourceRuns or create minimal provenance
  const created = node.created || node.timestamp || new Date().toISOString();
  
  // Check for V1 sourceRuns array
  if (node.sourceRuns && node.sourceRuns.length > 0) {
    const provenance = createProvenance(node.sourceRuns[0], node.id, created);
    
    // Record subsequent sources as merges (without full detail)
    for (let i = 1; i < node.sourceRuns.length; i++) {
      provenance.merges.push({
        fromRun: node.sourceRuns[i],
        fromId: 'unknown',
        intoRun: node.sourceRuns[0],
        intoId: node.id,
        similarity: 0,
        timestamp: created,
        policy: 'MIGRATED_V1',
        contested: false,
        confidence: 0
      });
    }
    
    provenance.lineageDepth = node.sourceRuns.length - 1;
    return provenance;
  }
  
  // Create fresh provenance
  return createProvenance(runName, node.id, created);
}

/**
 * Get provenance statistics for a brain
 * 
 * @param {object[]} nodes - Array of nodes with provenance
 * @returns {object} - Statistics
 */
function getProvenanceStats(nodes) {
  let totalMerges = 0;
  let maxLineageDepth = 0;
  let totalLineageDepth = 0;
  let truncatedCount = 0;
  
  for (const node of nodes) {
    const prov = node.provenance;
    if (!prov) continue;
    
    totalMerges += prov.merges?.length || 0;
    totalLineageDepth += prov.lineageDepth || 0;
    maxLineageDepth = Math.max(maxLineageDepth, prov.lineageDepth || 0);
    
    if (prov.merges?.some(m => m.policy === 'ROLLED_UP')) {
      truncatedCount++;
    }
  }
  
  const nodeCount = nodes.length;
  return {
    nodeCount,
    totalMerges,
    avgMergesPerNode: nodeCount > 0 ? (totalMerges / nodeCount).toFixed(2) : 0,
    avgLineageDepth: nodeCount > 0 ? (totalLineageDepth / nodeCount).toFixed(2) : 0,
    maxLineageDepth,
    truncatedNodes: truncatedCount
  };
}

module.exports = {
  createProvenance,
  recordMerge,
  truncateProvenance,
  ensureProvenance,
  getProvenanceStats,
  DEFAULT_MAX_MERGES
};

