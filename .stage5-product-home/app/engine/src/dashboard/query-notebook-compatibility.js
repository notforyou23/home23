'use strict';

const {
  operationError,
} = require('./brain-operations/operation-contract.js');

const MODERN_RETRYABLE_PARTITION_LIMIT = 256;
const LEGACY_RETRYABLE_PARTITION_LIMIT = 4096;
const RETRYABLE_PARTITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

function projectionError(cause) {
  return operationError('notebook_projection_invalid', cause);
}

function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function levelForFraction(value) {
  if (value === 0.10) return 'skim';
  if (value === 0.25) return 'sample';
  if (value === 0.50) return 'deep';
  if (value === 1.0) return 'full';
  return null;
}

function sanitizeLegacyCoverage(record) {
  const summary = record.notebookResultSummary;
  if (!plainObject(summary) || !plainObject(summary.coverage)) return false;
  const coverage = summary.coverage;
  const partitions = coverage.retryablePartitions;
  if (!Array.isArray(partitions)
      || partitions.length <= MODERN_RETRYABLE_PARTITION_LIMIT) return false;
  if (partitions.length > LEGACY_RETRYABLE_PARTITION_LIMIT
      || new Set(partitions).size !== partitions.length
      || partitions.some((partitionId) => typeof partitionId !== 'string'
        || !RETRYABLE_PARTITION_ID_PATTERN.test(partitionId))) {
    throw projectionError();
  }
  const persistedCount = coverage.retryablePartitionCount;
  if (persistedCount !== undefined
      && (!Number.isSafeInteger(persistedCount) || persistedCount < partitions.length)) {
    throw projectionError();
  }
  coverage.retryablePartitionCount = persistedCount ?? partitions.length;
  coverage.retryablePartitions = partitions.slice(0, MODERN_RETRYABLE_PARTITION_LIMIT);
  return true;
}

function normalizeNotebookRecordForProjection(rawRecord) {
  let record;
  try {
    record = structuredClone(rawRecord);
  } catch (error) {
    throw projectionError(error);
  }
  if (!plainObject(record) || record.operationType !== 'pgs') {
    return Object.freeze({
      record,
      legacyConfiguration: false,
      omittedLegacyRetryablePartitions: false,
    });
  }
  const request = record.requestParameters;
  if (!plainObject(request)) {
    return Object.freeze({
      record,
      legacyConfiguration: false,
      omittedLegacyRetryablePartitions: false,
    });
  }
  const legacyMode = request.pgsMode === undefined || request.pgsMode === 'full';
  const legacyLevel = request.pgsLevel === undefined;
  if (legacyMode) request.pgsMode = 'fresh';
  if (legacyLevel) {
    request.pgsLevel = levelForFraction(request.pgsConfig?.sweepFraction) ?? 'legacy';
  }
  const sanitizedCoverage = sanitizeLegacyCoverage(record);
  return Object.freeze({
    record,
    legacyConfiguration: legacyMode || legacyLevel || sanitizedCoverage,
    omittedLegacyRetryablePartitions: sanitizedCoverage,
  });
}

module.exports = {
  LEGACY_RETRYABLE_PARTITION_LIMIT,
  MODERN_RETRYABLE_PARTITION_LIMIT,
  levelForFraction,
  normalizeNotebookRecordForProjection,
};
