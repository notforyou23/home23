'use strict';

const {
  canonicalJson,
  canonicalSha256,
} = require('../brain-operations/canonical-json.cjs');

const SOURCE_HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
});

const MATCH_OUTCOME = Object.freeze({
  MATCHES: 'matches',
  NO_MATCH: 'no_match',
  FILTERED: 'filtered',
  CORPUS_EMPTY: 'corpus_empty',
  UNKNOWN: 'unknown',
});

const TYPED_MEMORY_SOURCE_CODES = new Set([
  'invalid_request',
  'invalid_memory_source',
  'source_unavailable',
  'source_changed',
  'source_busy',
  'source_pin_conflict',
  'source_stale',
  'result_too_large',
  'source_operation_required',
  'cancelled',
]);

function memorySourceError(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeKeywordTokens(query) {
  if (typeof query !== 'string' || !query.trim()) throw memorySourceError('invalid_request');
  const raw = query.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_:-]+/gu) || [];
  const words = [...new Set(raw)];
  if (words.length < 1 || words.length > 64
      || words.some((word) => Buffer.byteLength(word, 'utf8') > 256)) {
    throw memorySourceError('invalid_request');
  }
  return words;
}

function invalidBoundedInteger(name, value) {
  return memorySourceError('invalid_request', `${name} must be a finite bounded integer`, {
    status: 400,
    field: name,
    value,
  });
}

function parseBoundedInteger(value, { name, defaultValue, min, max }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw invalidBoundedInteger(name, value);
  }
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) {
    throw invalidBoundedInteger(name, value);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalidBoundedInteger(name, value);
  }
  return parsed;
}

function edgeKeyFor(edge) {
  const source = normalizeId(edge?.source ?? edge?.from);
  const target = normalizeId(edge?.target ?? edge?.to);
  return [source, target].sort((left, right) => left.localeCompare(right)).join('->');
}

function sourceDescriptorDigest(descriptor) {
  return canonicalSha256(descriptor);
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || Object.assign(new Error('cancelled'), {
    name: 'AbortError',
    code: 'cancelled',
  });
}

function rethrowAbort(error, signal) {
  if (!isAbortError(error, signal)) return;
  throw signal?.reason || error || Object.assign(new Error('cancelled'), {
    name: 'AbortError',
    code: 'cancelled',
  });
}

function isTypedMemorySourceError(error) {
  return typeof error?.code === 'string' && TYPED_MEMORY_SOURCE_CODES.has(error.code);
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function createDiagnosticRing({ maxEntries = 64, maxBytes = 32 * 1024, maxEntryBytes = 512 } = {}) {
  const entries = [];
  let retainedBytes = 0;
  let dropped = 0;
  let sawDegradation = false;
  return Object.freeze({
    push(value) {
      const text = truncateUtf8(String(value), maxEntryBytes);
      if (/_parse_error|revision_gap|source_missing|source_unavailable/.test(text)) {
        sawDegradation = true;
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (entries.length >= maxEntries || retainedBytes + bytes > maxBytes) {
        dropped += 1;
        return entries.length;
      }
      entries.push(text);
      retainedBytes += bytes;
      return entries.length;
    },
    some(predicate) { return entries.some(predicate); },
    snapshot() { return Object.freeze([...entries]); },
    get length() { return entries.length + dropped; },
    get dropped() { return dropped; },
    get sawDegradation() { return sawDegradation; },
  });
}

function classifyMatchOutcome({
  sourceHealth,
  authoritativeTotal,
  returnedTotal,
  filteredTotal = 0,
  completeCoverage = false,
}) {
  if (returnedTotal > 0) return MATCH_OUTCOME.MATCHES;
  if (sourceHealth !== SOURCE_HEALTH.HEALTHY || !completeCoverage) return MATCH_OUTCOME.UNKNOWN;
  if (authoritativeTotal === 0) return MATCH_OUTCOME.CORPUS_EMPTY;
  if (filteredTotal > 0) return MATCH_OUTCOME.FILTERED;
  return MATCH_OUTCOME.NO_MATCH;
}

function canonicalEvidenceIdentity(identity) {
  if (!identity) return null;
  return Object.freeze({
    requesterAgent: identity.requesterAgent || null,
    targetAgent: identity.targetAgent || null,
    brainId: identity.brainId || null,
    canonicalRoot: identity.canonicalRoot || null,
    catalogRevision: typeof identity.catalogRevision === 'string' ? identity.catalogRevision : null,
    kind: identity.kind || null,
    sourceType: identity.sourceType || null,
    accessMode: identity.accessMode || null,
    operationId: identity.operationId || null,
  });
}

function createEvidence(input = {}) {
  return {
    selectedAgent: input.selectedAgent || null,
    selectedBrain: input.selectedBrain || null,
    route: input.route || 'shared-memory-source',
    implementation: input.implementation || 'manifest-v1',
    identity: canonicalEvidenceIdentity(input.identity),
    baseWatermark: {
      revision: normalizeRevision(input.baseRevision),
      file: input.baseFile || null,
    },
    deltaWatermark: {
      revision: normalizeRevision(input.deltaRevision),
      epoch: input.deltaEpoch || null,
      appliedRecords: Number(input.deltaApplied || 0),
    },
    indexWatermark: {
      builtFromRevision: normalizeRevision(input.annBuiltFromRevision),
      fresh: input.annFresh === true,
    },
    filters: input.filters || {},
    limits: input.limits || {},
    authoritativeTotals: input.authoritativeTotals || { nodes: null, edges: null },
    returnedTotals: input.returnedTotals || { nodes: 0, edges: 0 },
    completeCoverage: input.completeCoverage === true,
    filteredTotal: Number.isSafeInteger(input.filteredTotal) && input.filteredTotal >= 0
      ? input.filteredTotal
      : 0,
    mutationBoundaries: Object.freeze([...(input.mutationBoundaries || [])]),
    sourceHealth: input.sourceHealth || SOURCE_HEALTH.UNAVAILABLE,
    matchOutcome: input.matchOutcome || MATCH_OUTCOME.UNKNOWN,
    fallback: input.fallback || null,
    freshness: input.freshness || 'known',
    diagnostics: Object.freeze(Array.isArray(input.diagnostics) ? [...input.diagnostics] : []),
    diagnosticsDropped: Number.isSafeInteger(input.diagnosticsDropped)
      ? input.diagnosticsDropped
      : 0,
  };
}

function enrichEvidenceIdentity(evidence, identity) {
  if (!identity?.requesterAgent || !identity?.brainId || !identity?.canonicalRoot
      || !identity?.catalogRevision || typeof identity.catalogRevision !== 'string'
      || !identity?.kind || !identity?.sourceType || !identity?.accessMode
      || !identity?.operationId) {
    throw memorySourceError('invalid_request', 'canonical evidence identity required');
  }
  const normalized = canonicalEvidenceIdentity(identity);
  const prior = evidence?.identity;
  const identityKeys = [
    'requesterAgent',
    'targetAgent',
    'brainId',
    'canonicalRoot',
    'catalogRevision',
    'kind',
    'sourceType',
    'accessMode',
    'operationId',
  ];
  if (prior && identityKeys.some((key) => prior[key] !== null && prior[key] !== normalized[key])) {
    throw memorySourceError('source_changed', 'evidence identity mismatch');
  }
  return Object.freeze({
    ...evidence,
    selectedAgent: normalized.targetAgent,
    selectedBrain: normalized.brainId,
    identity: normalized,
  });
}

module.exports = {
  SOURCE_HEALTH,
  MATCH_OUTCOME,
  normalizeRevision,
  normalizeId,
  normalizeKeywordTokens,
  parseBoundedInteger,
  edgeKeyFor,
  canonicalJson,
  sourceDescriptorDigest,
  isAbortError,
  throwIfAborted,
  rethrowAbort,
  isTypedMemorySourceError,
  createDiagnosticRing,
  classifyMatchOutcome,
  createEvidence,
  enrichEvidenceIdentity,
  memorySourceError,
};
