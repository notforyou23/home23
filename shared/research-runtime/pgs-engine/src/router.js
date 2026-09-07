/**
 * router.js — Query routing for Partitioned Graph Synthesis
 *
 * Routes queries to relevant partitions using cosine similarity
 * between query embeddings and partition centroid embeddings.
 * Broad/open-ended queries bypass routing for full coverage.
 */

'use strict';

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]|null} a - First vector
 * @param {number[]|null} b - Second vector
 * @returns {number} Similarity in [-1, 1], or 0 for invalid inputs
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Route a query to relevant partitions based on embedding similarity.
 *
 * @param {string} query - The search query
 * @param {number[]|null} queryEmbedding - Query embedding vector
 * @param {Array<{id: string, centroidEmbedding?: number[]}>} partitions - Enriched partitions
 * @param {Object} config - Routing configuration
 * @param {number} config.maxSweepPartitions - Maximum partitions to return
 * @param {number} config.minSweepPartitions - Minimum partitions to return (0 = no floor)
 * @param {number} [config.partitionRelevanceThreshold=0.25] - Minimum similarity threshold
 * @returns {Array} Partitions ranked by relevance with `.similarity` field attached
 */
function routeQuery(query, queryEmbedding, partitions, config) {
  const { maxSweepPartitions, minSweepPartitions, partitionRelevanceThreshold = 0.25 } = config;

  if (!queryEmbedding) {
    // No embedding available, return all partitions (limited by max)
    return partitions.slice(0, maxSweepPartitions);
  }

  // Check if this is a broad/open-ended query
  const broadPatterns = [
    /what.*(surpris|miss|gap|absence|unknown)/i,
    /what.*don.*t.*know/i,
    /full.*sweep/i,
    /everything/i,
    /comprehensive.*overview/i,
    /all.*partition/i
  ];
  const isBroadQuery = broadPatterns.some(p => p.test(query));

  if (isBroadQuery) {
    // Full sweep for broad queries
    return partitions.slice(0, maxSweepPartitions);
  }

  // Rank by cosine similarity to partition centroid
  const ranked = partitions
    .map(p => ({
      ...p,
      similarity: p.centroidEmbedding
        ? cosineSimilarity(queryEmbedding, p.centroidEmbedding)
        : 0
    }))
    .sort((a, b) => b.similarity - a.similarity);

  // Select: all above threshold, respecting min/max bounds
  let selected = ranked.filter(p => p.similarity >= partitionRelevanceThreshold);

  // Only enforce minimum if configured (default 0 = no forced minimum)
  if (minSweepPartitions > 0 && selected.length < minSweepPartitions) {
    selected = ranked.slice(0, minSweepPartitions);
  }

  if (selected.length > maxSweepPartitions) {
    selected = selected.slice(0, maxSweepPartitions);
  }

  return selected;
}

module.exports = { cosineSimilarity, routeQuery };
