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

const RETRIEVAL_MODES = Object.freeze([
  'semantic-ann',
  'semantic-ann-delta-overlay',
  'keyword-index-overlay',
  'logical-source-scan',
]);
const RETRIEVAL_MODE_SET = new Set(RETRIEVAL_MODES);
const RETRIEVAL_DOMAINS = Object.freeze([
  'current_ops', 'closed_incidents', 'project_history', 'external_intake',
]);
const AUTHORITY_CLASSES = Object.freeze([
  'verified_current_state', 'jtr_correction', 'artifact_log', 'worker_receipt',
  'generated_doctrine', 'narrative',
]);
const SOURCE_CHAIN_KINDS = Object.freeze([
  'source', 'evidence', 'artifact', 'trace', 'generation', 'lineage',
  'verification', 'closure',
]);
const AUTHORITY_CLASS_ALIASES = Object.freeze({
  verified_current_state: 'verifiedCurrentState',
  jtr_correction: 'jtrCorrection',
  artifact_log: 'artifactLog',
  worker_receipt: 'workerReceipt',
  generated_doctrine: 'generatedDoctrine',
  narrative: 'narrative',
});
const AUTHORITY_SUMMARY_ATTESTATIONS = new WeakMap();

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

function safeCount(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeOptionalCount(value) {
  return value === null || value === undefined
    ? null
    : (Number.isSafeInteger(value) && value >= 0 ? value : null);
}

function safeDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1000) / 1000
    : null;
}

function boundedEvidenceText(value, maxBytes = 256) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return truncateUtf8(value.trim(), maxBytes);
}

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function normalizeAuthoritySummary(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const nestedClasses = input.authorityClasses && typeof input.authorityClasses === 'object'
    && !Array.isArray(input.authorityClasses) ? input.authorityClasses : {};
  const authorityClasses = zeroCounts(AUTHORITY_CLASSES);
  for (const authorityClass of AUTHORITY_CLASSES) {
    const alias = AUTHORITY_CLASS_ALIASES[authorityClass];
    authorityClasses[authorityClass] = safeCount(
      nestedClasses[authorityClass],
      safeCount(input[alias]),
    );
  }
  const nestedDomains = input.retrievalDomains && typeof input.retrievalDomains === 'object'
    && !Array.isArray(input.retrievalDomains) ? input.retrievalDomains : {};
  const retrievalDomains = zeroCounts(RETRIEVAL_DOMAINS);
  for (const domain of RETRIEVAL_DOMAINS) {
    retrievalDomains[domain] = safeCount(nestedDomains[domain]);
  }
  const source = input.sourceChain && typeof input.sourceChain === 'object'
    && !Array.isArray(input.sourceChain) ? input.sourceChain : {};
  const rawReferenceCounts = source.referenceCounts && typeof source.referenceCounts === 'object'
    && !Array.isArray(source.referenceCounts) ? source.referenceCounts : {};
  const referenceCounts = zeroCounts(SOURCE_CHAIN_KINDS);
  for (const kind of SOURCE_CHAIN_KINDS) referenceCounts[kind] = safeCount(rawReferenceCounts[kind]);
  const total = safeCount(input.total,
    Object.values(authorityClasses).reduce((sum, count) => sum + count, 0));
  const result = {
    total,
    authorityClasses,
    retrievalDomains,
    sourceChain: {
      withEvidence: safeCount(source.withEvidence),
      withoutEvidence: safeCount(source.withoutEvidence),
      referenceCounts,
    },
    requiresFreshVerification: safeCount(input.requiresFreshVerification),
  };
  for (const [authorityClass, alias] of Object.entries(AUTHORITY_CLASS_ALIASES)) {
    result[alias] = authorityClasses[authorityClass];
  }
  return result;
}

function createRetrievalAuthorityAccumulator() {
  const summary = normalizeAuthoritySummary();
  return Object.freeze({
    add(value) {
      const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const authorityClass = AUTHORITY_CLASSES.includes(entry.authorityClass)
        ? entry.authorityClass : 'narrative';
      const retrievalDomain = RETRIEVAL_DOMAINS.includes(entry.retrievalDomain)
        ? entry.retrievalDomain
        : (RETRIEVAL_DOMAINS.includes(entry.domain) ? entry.domain : 'current_ops');
      summary.total += 1;
      summary.authorityClasses[authorityClass] += 1;
      summary[AUTHORITY_CLASS_ALIASES[authorityClass]] += 1;
      summary.retrievalDomains[retrievalDomain] += 1;
      if (entry.requiresFreshVerification === true) summary.requiresFreshVerification += 1;
      const chain = Array.isArray(entry.sourceChain) ? entry.sourceChain : [];
      if (chain.length > 0) summary.sourceChain.withEvidence += 1;
      else summary.sourceChain.withoutEvidence += 1;
      for (const link of chain) {
        if (link && typeof link === 'object' && SOURCE_CHAIN_KINDS.includes(link.kind)) {
          summary.sourceChain.referenceCounts[link.kind] += 1;
        }
      }
    },
    snapshot() { return normalizeAuthoritySummary(summary); },
  });
}

function summarizeRetrievalAuthority(entries = []) {
  const accumulator = createRetrievalAuthorityAccumulator();
  if (!Array.isArray(entries)) return accumulator.snapshot();
  for (const value of entries) {
    accumulator.add(value);
  }
  return accumulator.snapshot();
}

function attestRetrievalAuthoritySummary(evidence, authorityEvidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw memorySourceError('invalid_memory_source', 'authority evidence target is invalid');
  }
  const summary = Array.isArray(authorityEvidence)
    ? summarizeRetrievalAuthority(authorityEvidence)
    : normalizeAuthoritySummary(authorityEvidence);
  AUTHORITY_SUMMARY_ATTESTATIONS.set(evidence, Object.freeze(summary));
  return evidence;
}

function getAttestedRetrievalAuthoritySummary(evidence) {
  const summary = evidence && typeof evidence === 'object'
    ? AUTHORITY_SUMMARY_ATTESTATIONS.get(evidence)
    : null;
  return summary ? normalizeAuthoritySummary(summary) : null;
}

function normalizeIndexCoverage(value, currentRevision) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.complete !== 'boolean') return null;
  return {
    complete: value.complete,
    indexedRevision: safeOptionalCount(value.indexedRevision),
    currentRevision: safeOptionalCount(value.currentRevision ?? currentRevision),
    coveredThroughRevision: safeOptionalCount(value.coveredThroughRevision),
    deltaRecords: safeCount(value.deltaRecords),
    distinctChangedNodes: safeCount(value.distinctChangedNodes ?? value.changedNodes),
    distinctUpsertedNodes: safeCount(value.distinctUpsertedNodes ?? value.upsertedNodes),
    distinctRemovedNodes: safeCount(value.distinctRemovedNodes ?? value.removedNodes),
    edgeOnlyRecords: safeCount(value.edgeOnlyRecords),
    route: boundedEvidenceText(value.route),
    completeness: boundedEvidenceText(value.completeness),
  };
}

function normalizeStageTimings(input = {}) {
  const value = input.stageTimingsMs && typeof input.stageTimingsMs === 'object'
    ? input.stageTimingsMs
    : input.stageTimings && typeof input.stageTimings === 'object'
      ? input.stageTimings : null;
  if (!value || Array.isArray(value)) return null;
  const aliases = {
    sourceOpen: ['sourceOpen', 'sourceOpenMs'],
    embedding: ['embedding', 'embeddingMs'],
    overlayRefresh: ['overlayRefresh', 'overlayRefreshMs', 'deltaOverlay'],
    annLoad: ['annLoad', 'annLoadMs'],
    annSearch: ['annSearch', 'annSearchMs', 'annQuery'],
    overlayScoring: ['overlayScoring', 'overlayScoringMs', 'deltaSemantic'],
    keywordScoring: ['keywordScoring', 'keywordScoringMs', 'keyword'],
    merge: ['merge', 'mergeMs'],
    response: ['response', 'responseMs', 'total'],
  };
  const result = {};
  for (const [canonical, candidates] of Object.entries(aliases)) {
    const selected = candidates.find((key) => Object.hasOwn(value, key));
    const duration = selected === undefined ? null : safeDuration(value[selected]);
    if (duration !== null) result[canonical] = duration;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function projectRetrievalEvidenceEnvelope(input = {}) {
  const result = {};
  if (RETRIEVAL_MODE_SET.has(input.retrievalMode)) result.retrievalMode = input.retrievalMode;
  const currentRevision = normalizeRevision(
    input.indexCoverage?.currentRevision ?? input.deltaRevision
      ?? input.deltaWatermark?.revision,
  );
  const indexCoverage = normalizeIndexCoverage(input.indexCoverage, currentRevision);
  if (indexCoverage) result.indexCoverage = indexCoverage;
  const stageTimingsMs = normalizeStageTimings(input);
  if (stageTimingsMs) result.stageTimingsMs = stageTimingsMs;
  if (input.authoritySummary && typeof input.authoritySummary === 'object'
      && !Array.isArray(input.authoritySummary)) {
    result.authoritySummary = normalizeAuthoritySummary(input.authoritySummary);
  }
  return result;
}

function createEvidence(input = {}) {
  const evidence = {
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
  Object.assign(evidence, projectRetrievalEvidenceEnvelope(input));
  return evidence;
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
  RETRIEVAL_MODES,
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
  normalizeAuthoritySummary,
  createRetrievalAuthorityAccumulator,
  projectRetrievalEvidenceEnvelope,
  summarizeRetrievalAuthority,
  attestRetrievalAuthoritySummary,
  getAttestedRetrievalAuthoritySummary,
  enrichEvidenceIdentity,
  memorySourceError,
};
