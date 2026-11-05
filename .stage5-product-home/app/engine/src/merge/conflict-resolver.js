/**
 * COSMO Merge V2 - Conflict Resolution
 * 
 * Implements configurable policies for resolving merge conflicts
 * between similar nodes.
 */

/**
 * @typedef {'KEEP_BOTH'|'BEST_REP'|'MOST_RECENT'|'MOST_CONNECTED'|'MARK_UNCERTAIN'} ConflictPolicyName
 */

/**
 * @typedef {Object} ConflictResolutionMetadata
 * @property {ConflictPolicyName} policy
 * @property {boolean} contested
 * @property {number} confidence
 */

/**
 * @typedef {Object} ConflictContext
 * @property {number} maxDegree - Max degree in graph (for normalization)
 * @property {number} maxAgeMs - Max age in milliseconds (for normalization)
 * @property {number} threshold - Merge threshold
 */

/**
 * @typedef {Object} ConflictResolutionResult
 * @property {'merge'|'keep_both'|'skip'} result
 * @property {object} [merged] - Merged node (if result === 'merge')
 * @property {object[]} [kept] - Both nodes (if result === 'keep_both')
 * @property {ConflictResolutionMetadata} metadata
 */

const POLICIES = {
  KEEP_BOTH: 'KEEP_BOTH',
  BEST_REP: 'BEST_REP',
  MOST_RECENT: 'MOST_RECENT',
  MOST_CONNECTED: 'MOST_CONNECTED',
  MARK_UNCERTAIN: 'MARK_UNCERTAIN'
};

const DEFAULT_POLICY = POLICIES.BEST_REP;
const DEFAULT_CONFLICT_THRESHOLD = 0.78;

/**
 * Calculate recency score for a node
 * 1.0 for newest, 0.0 for oldest
 * 
 * @param {object} node 
 * @param {number} maxAgeMs 
 * @returns {number}
 */
function recencyScore(node, maxAgeMs) {
  const created = node.provenance?.origin?.created || node.created || node.timestamp;
  if (!created || maxAgeMs <= 0) return 0.5;
  
  const ageMs = Date.now() - new Date(created).getTime();
  return 1.0 - Math.min(1.0, ageMs / maxAgeMs);
}

/**
 * Calculate normalized degree score
 * 
 * @param {object} node 
 * @param {number} maxDegree 
 * @returns {number}
 */
function normalizedDegree(node, maxDegree) {
  const degree = node.degree || node.connections || 0;
  return maxDegree > 0 ? degree / maxDegree : 0;
}

/**
 * Calculate combined score for BEST_REP policy
 * 
 * @param {object} node 
 * @param {number} similarity 
 * @param {ConflictContext} context 
 * @returns {number}
 */
function calculateScore(node, similarity, context) {
  return (
    0.5 * similarity +
    0.3 * normalizedDegree(node, context.maxDegree) +
    0.2 * recencyScore(node, context.maxAgeMs)
  );
}

/**
 * Resolve a conflict between two similar nodes
 * 
 * @param {object} nodeA - First node (typically existing)
 * @param {object} nodeB - Second node (typically incoming)
 * @param {number} similarity - Similarity score between them
 * @param {ConflictPolicyName} policy - Conflict resolution policy
 * @param {ConflictContext} context - Context for scoring
 * @returns {ConflictResolutionResult}
 */
function resolveConflict(nodeA, nodeB, similarity, policy = DEFAULT_POLICY, context = {}) {
  const ctx = {
    maxDegree: context.maxDegree || 100,
    maxAgeMs: context.maxAgeMs || (365 * 24 * 60 * 60 * 1000), // 1 year default
    threshold: context.threshold || DEFAULT_CONFLICT_THRESHOLD
  };
  
  switch (policy) {
    case POLICIES.KEEP_BOTH:
      return {
        result: 'keep_both',
        kept: [nodeA, nodeB],
        metadata: {
          policy: POLICIES.KEEP_BOTH,
          contested: false,
          confidence: similarity
        }
      };
    
    case POLICIES.MOST_RECENT:
      return resolveMostRecent(nodeA, nodeB, similarity);
    
    case POLICIES.MOST_CONNECTED:
      return resolveMostConnected(nodeA, nodeB, similarity);
    
    case POLICIES.MARK_UNCERTAIN:
      return resolveMarkUncertain(nodeA, nodeB, similarity, ctx);
    
    case POLICIES.BEST_REP:
    default:
      return resolveBestRep(nodeA, nodeB, similarity, ctx);
  }
}

/**
 * BEST_REP: Select winner based on combined score
 */
function resolveBestRep(nodeA, nodeB, similarity, context) {
  const scoreA = calculateScore(nodeA, similarity, context);
  const scoreB = calculateScore(nodeB, similarity, context);
  
  const contested = Math.abs(scoreA - scoreB) < 0.05;
  const winner = scoreA >= scoreB ? nodeA : nodeB;
  const loser = scoreA >= scoreB ? nodeB : nodeA;
  
  return {
    result: 'merge',
    merged: winner,
    loser: loser,
    metadata: {
      policy: POLICIES.BEST_REP,
      contested,
      confidence: similarity
    }
  };
}

/**
 * MOST_RECENT: Newer node wins
 */
function resolveMostRecent(nodeA, nodeB, similarity) {
  const timeA = new Date(nodeA.provenance?.origin?.created || nodeA.created || 0).getTime();
  const timeB = new Date(nodeB.provenance?.origin?.created || nodeB.created || 0).getTime();
  
  const winner = timeA >= timeB ? nodeA : nodeB;
  const loser = timeA >= timeB ? nodeB : nodeA;
  
  return {
    result: 'merge',
    merged: winner,
    loser: loser,
    metadata: {
      policy: POLICIES.MOST_RECENT,
      contested: false,
      confidence: similarity
    }
  };
}

/**
 * MOST_CONNECTED: Higher degree wins
 */
function resolveMostConnected(nodeA, nodeB, similarity) {
  const degreeA = nodeA.degree || nodeA.connections || 0;
  const degreeB = nodeB.degree || nodeB.connections || 0;
  
  const winner = degreeA >= degreeB ? nodeA : nodeB;
  const loser = degreeA >= degreeB ? nodeB : nodeA;
  
  return {
    result: 'merge',
    merged: winner,
    loser: loser,
    metadata: {
      policy: POLICIES.MOST_CONNECTED,
      contested: false,
      confidence: similarity
    }
  };
}

/**
 * MARK_UNCERTAIN: Merge but mark as contested with low confidence
 */
function resolveMarkUncertain(nodeA, nodeB, similarity, context) {
  // Still pick a winner using BEST_REP logic, but mark uncertain
  const scoreA = calculateScore(nodeA, similarity, context);
  const scoreB = calculateScore(nodeB, similarity, context);
  
  const winner = scoreA >= scoreB ? nodeA : nodeB;
  const loser = scoreA >= scoreB ? nodeB : nodeA;
  
  return {
    result: 'merge',
    merged: winner,
    loser: loser,
    metadata: {
      policy: POLICIES.MARK_UNCERTAIN,
      contested: true,
      confidence: Math.min(similarity, context.threshold)
    }
  };
}

/**
 * Merge node data after conflict resolution
 * Combines attributes from loser into winner
 * 
 * @param {object} winner - Winning node
 * @param {object} loser - Losing node
 * @returns {object} - Merged node (mutates winner)
 */
function mergeNodeData(winner, loser) {
  // Merge sourceRuns (V1 compatibility)
  if (loser.sourceRuns) {
    winner.sourceRuns = winner.sourceRuns || [];
    for (const run of loser.sourceRuns) {
      if (!winner.sourceRuns.includes(run)) {
        winner.sourceRuns.push(run);
      }
    }
  }
  
  // Preserve highest degree
  if (loser.degree > (winner.degree || 0)) {
    winner.degree = loser.degree;
  }
  
  // Preserve highest activation
  if (loser.activation > (winner.activation || 0)) {
    winner.activation = loser.activation;
  }
  
  // Merge clusters
  if (loser.cluster && !winner.cluster) {
    winner.cluster = loser.cluster;
  }
  
  // Preserve metadata
  if (loser.metadata && !winner.metadata) {
    winner.metadata = loser.metadata;
  }
  
  return winner;
}

module.exports = {
  POLICIES,
  DEFAULT_POLICY,
  DEFAULT_CONFLICT_THRESHOLD,
  resolveConflict,
  mergeNodeData,
  calculateScore,
  recencyScore,
  normalizedDegree
};

