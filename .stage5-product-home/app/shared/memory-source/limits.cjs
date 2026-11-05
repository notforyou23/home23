'use strict';

const { memorySourceError } = require('./contracts.cjs');

const MAX_MEMORY_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw memorySourceError(
      'invalid_request',
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function explicitLimit(value, fallback, label) {
  if (value === undefined) return fallback;
  const validated = positiveSafeInteger(value, label);
  if (validated > MAX_MEMORY_SOURCE_BYTES) {
    throw memorySourceError(
      'invalid_request',
      `${label} exceeds the memory source hard maximum`,
    );
  }
  return validated;
}

function resolveMemorySourceReadLimits({
  maxInputBytes,
  maxDecompressedBytes,
  quotaMaxBytes,
} = {}) {
  const quotaLimit = quotaMaxBytes === undefined
    ? MAX_MEMORY_SOURCE_BYTES
    : positiveSafeInteger(quotaMaxBytes, 'operation scratch quota limit');
  const fallback = Math.min(quotaLimit, MAX_MEMORY_SOURCE_BYTES);
  return Object.freeze({
    maxInputBytes: explicitLimit(maxInputBytes, fallback, 'memory source compressed-input limit'),
    maxDecompressedBytes: explicitLimit(
      maxDecompressedBytes,
      fallback,
      'memory source decompression limit',
    ),
  });
}

function assertMemorySourceInputSelection(selectedBytes, maxInputBytes) {
  if (!Number.isSafeInteger(selectedBytes) || selectedBytes < 0) {
    throw memorySourceError('invalid_request', 'invalid memory source input selection');
  }
  const limit = explicitLimit(
    maxInputBytes,
    MAX_MEMORY_SOURCE_BYTES,
    'memory source compressed-input limit',
  );
  if (selectedBytes > limit) {
    throw memorySourceError('result_too_large', 'memory source input selection limit exceeded', {
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit,
    });
  }
  return selectedBytes;
}

module.exports = {
  MAX_MEMORY_SOURCE_BYTES,
  assertMemorySourceInputSelection,
  resolveMemorySourceReadLimits,
};
