'use strict';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const QUERY_OPERATION_LIMITS = Object.freeze({
  maxNodes: 4_000,
  maxEdges: 16_000,
  maxRecordBytes: 256 * 1024,
  maxProjectionBytes: 64 * MiB,
  maxPromptBytes: 8 * MiB,
  maxResultBytes: 8 * MiB,
});

const PGS_OPERATION_LIMITS = Object.freeze({
  maxRecordBytes: 256 * 1024,
  maxTransactionRecords: 1_000,
  maxTransactionBytes: 8 * MiB,
  maxScratchBytes: 8 * GiB,
  minFreeScratchBytes: 1 * GiB,
  maxSelectedWorkUnits: 256,
  maxNodesPerWorkUnit: 250,
  maxContextCharsPerWorkUnit: 128_000,
  maxSweepOutputBytes: 256 * 1024,
  maxTotalSweepOutputBytes: 16 * MiB,
  maxSynthesisInputBytes: 16 * MiB,
  maxSynthesisOutputBytes: 2 * MiB,
  maxResultBytes: 24 * MiB,
});

const SYNTHESIS_OPERATION_LIMITS = Object.freeze({
  maxPromptBytes: 8 * MiB,
  maxProviderOutputBytes: 2 * MiB,
  maxBrainStateBytes: 4 * MiB,
});

module.exports = {
  PGS_OPERATION_LIMITS,
  QUERY_OPERATION_LIMITS,
  SYNTHESIS_OPERATION_LIMITS,
};
