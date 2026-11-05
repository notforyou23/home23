/**
 * PGS Engine — Default Configuration
 *
 * All parameters configurable via the PGSEngine constructor's `config` option.
 */

const PGS_DEFAULTS = {
  // Parallel LLM calls per sweep batch
  maxConcurrentSweeps: 5,

  // Minimum graph size to use PGS (0 = always use PGS)
  minNodesForPgs: 0,

  // Louvain post-processing: merge communities smaller than this
  minCommunitySize: 30,

  // Louvain post-processing: split communities larger than this
  targetPartitionMax: 1800,

  // Maximum partitions to sweep per query
  maxSweepPartitions: 15,

  // Minimum partitions to sweep (0 = no forced minimum, route by relevance only)
  minSweepPartitions: 0,

  // Cosine similarity threshold for routing query to partitions
  partitionRelevanceThreshold: 0.25,

  // Token budget per sweep LLM call
  sweepMaxTokens: 6000,

  // Token budget for synthesis LLM call
  synthesisMaxTokens: 16000,

  // Fraction of routed partitions to sweep (0.1-1.0, overrides maxSweepPartitions when set)
  sweepFraction: null,
};

module.exports = { PGS_DEFAULTS };
