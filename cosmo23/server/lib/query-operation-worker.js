'use strict';

const {
  canonicalJson,
  projectRetrievalEvidenceEnvelope,
  summarizeRetrievalAuthority,
  normalizeAuthoritySummary,
  getAttestedRetrievalAuthoritySummary,
} = require('../../../shared/memory-source/contracts.cjs');

const QUERY_PARAMETER_KEYS = Object.freeze([
  'query', 'mode', 'modelSelection', 'topK', 'priorContext', 'enableSynthesis',
  'includeOutputs', 'includeThoughts', 'includeCoordinatorInsights', 'allowActions',
]);
const PGS_PARAMETER_KEYS = Object.freeze([
  'query', 'mode', 'pgsMode', 'pgsLevel', 'pgsConfig',
  'continueFromOperationId', 'targetPartitionIds', 'pgsSweep', 'pgsSynth',
]);
const QUERY_MODES = new Set(['quick', 'full', 'expert', 'dive']);
const PGS_LEVEL_FRACTIONS = Object.freeze({
  skim: 0.10,
  sample: 0.25,
  deep: 0.50,
  full: 1,
});
const PGS_MODES = new Set(['fresh', 'continue', 'targeted']);
const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const PGS_SESSION_ID_PATTERN = /^pgss_[A-Za-z0-9_-]{32}$/;
const PARTITION_ID_PATTERN = /^(?:c|h)-[A-Za-z0-9._-]{1,253}$/;
const MAX_TARGET_PARTITIONS = 256;
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed']);
const MAX_QUERY_CHARS = 12_000;
const MAX_PRIOR_CONTEXT_CHARS = 20_000;
const MAX_PAIR_PART_CHARS = 256;

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function invalid(message) {
  return typed('invalid_request', message);
}

function assertDataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) {
      throw invalid(`${label} contains an invalid field`);
    }
  }
  return value;
}

function assertExactKeys(value, allowedKeys, label) {
  assertDataObject(value, label);
  const allowed = new Set(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || descriptor.value === undefined) {
      throw invalid(`${label} contains an invalid field`);
    }
  }
  return value;
}

function requireOwn(value, key, label) {
  if (!Object.hasOwn(value, key)) throw invalid(`${label}.${key} is required`);
  return value[key];
}

function exactPair(value, label) {
  assertExactKeys(value, ['provider', 'model'], label);
  if (Object.keys(value).length !== 2) {
    throw typed('provider_model_mismatch', `${label} requires provider and model`);
  }
  const provider = typeof value.provider === 'string' ? value.provider : '';
  const model = typeof value.model === 'string' ? value.model : '';
  if (!provider || provider.trim() !== provider || provider.length > MAX_PAIR_PART_CHARS
      || !model || model.trim() !== model || model.length > MAX_PAIR_PART_CHARS) {
    throw typed('provider_model_mismatch', `${label} requires provider and model`);
  }
  return Object.freeze({ provider, model });
}

function optionalMode(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !QUERY_MODES.has(value)) {
    throw invalid('mode is invalid');
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${label} must be boolean`);
  return value;
}

function optionalPriorContext(value) {
  if (value === undefined || value === null) return value;
  assertExactKeys(value, ['query', 'answer'], 'priorContext');
  if (Object.keys(value).length !== 2
      || typeof value.query !== 'string'
      || typeof value.answer !== 'string'
      || value.query.length + value.answer.length > MAX_PRIOR_CONTEXT_CHARS) {
    throw invalid('priorContext is invalid');
  }
  return Object.freeze({ query: value.query, answer: value.answer });
}

function validateQueryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_QUERY_CHARS) {
    throw invalid('query is invalid');
  }
  return value;
}

function validateQueryParameters(parameters) {
  assertExactKeys(parameters, QUERY_PARAMETER_KEYS, 'parameters');
  const query = validateQueryText(requireOwn(parameters, 'query', 'parameters'));
  const modelSelection = exactPair(
    requireOwn(parameters, 'modelSelection', 'parameters'),
    'modelSelection',
  );
  const mode = optionalMode(parameters.mode);
  const priorContext = optionalPriorContext(parameters.priorContext);
  let topK;
  if (Object.hasOwn(parameters, 'topK')) {
    topK = parameters.topK;
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) {
      throw invalid('topK is invalid');
    }
  }
  const booleans = {};
  for (const key of [
    'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions',
  ]) {
    booleans[key] = optionalBoolean(parameters[key], key);
  }
  return {
    query, mode, modelSelection, topK, priorContext, ...booleans,
  };
}

function validatePgsParameters(parameters) {
  assertExactKeys(parameters, PGS_PARAMETER_KEYS, 'parameters');
  const query = validateQueryText(requireOwn(parameters, 'query', 'parameters'));
  const pgsSweep = exactPair(requireOwn(parameters, 'pgsSweep', 'parameters'), 'pgsSweep');
  const pgsSynth = exactPair(requireOwn(parameters, 'pgsSynth', 'parameters'), 'pgsSynth');
  const mode = optionalMode(parameters.mode);
  const pgsMode = requireOwn(parameters, 'pgsMode', 'parameters');
  if (typeof pgsMode !== 'string' || !PGS_MODES.has(pgsMode)) {
    throw invalid('pgsMode is invalid');
  }
  const pgsLevel = requireOwn(parameters, 'pgsLevel', 'parameters');
  if (typeof pgsLevel !== 'string' || !Object.hasOwn(PGS_LEVEL_FRACTIONS, pgsLevel)) {
    throw invalid('pgsLevel is invalid');
  }
  const pgsConfig = requireOwn(parameters, 'pgsConfig', 'parameters');
  assertExactKeys(pgsConfig, ['sweepFraction'], 'pgsConfig');
  if (Object.keys(pgsConfig).length !== 1
      || pgsConfig.sweepFraction !== PGS_LEVEL_FRACTIONS[pgsLevel]) {
    throw invalid('pgsConfig.sweepFraction does not match pgsLevel');
  }
  let continueFromOperationId;
  if (Object.hasOwn(parameters, 'continueFromOperationId')) {
    continueFromOperationId = parameters.continueFromOperationId;
    if (typeof continueFromOperationId !== 'string'
        || !OPERATION_ID_PATTERN.test(continueFromOperationId)) {
      throw invalid('continueFromOperationId is invalid');
    }
  }
  let targetPartitionIds;
  if (Object.hasOwn(parameters, 'targetPartitionIds')) {
    if (!Array.isArray(parameters.targetPartitionIds)
        || parameters.targetPartitionIds.length < 1
        || parameters.targetPartitionIds.length > MAX_TARGET_PARTITIONS) {
      throw invalid('targetPartitionIds is invalid');
    }
    const seen = new Set();
    targetPartitionIds = parameters.targetPartitionIds.map((value) => {
      if (typeof value !== 'string' || !PARTITION_ID_PATTERN.test(value) || seen.has(value)) {
        throw invalid('targetPartitionIds is invalid');
      }
      seen.add(value);
      return value;
    }).sort();
  }
  if (pgsMode === 'fresh' && (continueFromOperationId || targetPartitionIds)) {
    throw invalid('fresh PGS cannot continue or target partitions');
  }
  if (pgsMode === 'continue' && (!continueFromOperationId || targetPartitionIds)) {
    throw invalid('continue PGS requires exactly one prior operation');
  }
  if (pgsMode === 'targeted' && !targetPartitionIds) {
    throw invalid('targeted PGS requires explicit partitions');
  }
  return {
    query,
    mode,
    pgsMode,
    pgsLevel,
    pgsConfig: Object.freeze({ sweepFraction: pgsConfig.sweepFraction }),
    continueFromOperationId,
    targetPartitionIds: targetPartitionIds ? Object.freeze(targetPartitionIds) : undefined,
    pgsSweep,
    pgsSynth,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function validateContext(context) {
  assertDataObject(context, 'operation context');
  if (!['query', 'pgs'].includes(context.operationType)) {
    throw invalid('unsupported query operation type');
  }
  if (typeof context.requesterAgent !== 'string' || !context.requesterAgent.trim()) {
    throw invalid('requesterAgent is invalid');
  }
  assertDataObject(context.target, 'target');
  if (context.target.domain !== 'brain'
      || typeof context.target.brainId !== 'string'
      || !context.target.brainId.trim()) {
    throw invalid('query target must be a canonical brain');
  }
  if (!['own', 'read-only'].includes(context.target.accessMode)) {
    throw invalid('target accessMode is invalid');
  }
  if (context.target.accessMode === 'own'
      && context.target.ownerAgent !== context.requesterAgent) {
    throw typed('access_denied', 'Cross-brain actions are not allowed');
  }
  if (!context.sourcePin || typeof context.sourcePin.getEvidence !== 'function') {
    throw typed('source_pin_required', 'Pinned source is required');
  }
  if (typeof context.scratchDir !== 'string' || !context.scratchDir.trim()) {
    throw invalid('scratchDir is invalid');
  }
  if (!context.scratchQuota || typeof context.scratchQuota !== 'object') {
    throw invalid('scratchQuota is required');
  }
  if (!context.signal || typeof context.signal.aborted !== 'boolean') {
    throw invalid('signal is required');
  }
  if (typeof context.reportEvent !== 'function') {
    throw invalid('reportEvent is required');
  }
  if (context.operationType === 'pgs') {
    assertDataObject(context.pgsSession, 'pgsSession');
    if (typeof context.pgsSession.sessionId !== 'string'
        || !PGS_SESSION_ID_PATTERN.test(context.pgsSession.sessionId)
        || typeof context.pgsSession.continuableUntil !== 'string'
        || !Number.isFinite(Date.parse(context.pgsSession.continuableUntil))
        || (context.pgsSession.sourceOperationId !== null
          && (typeof context.pgsSession.sourceOperationId !== 'string'
            || !OPERATION_ID_PATTERN.test(context.pgsSession.sourceOperationId)))) {
      throw invalid('pgsSession is invalid');
    }
    const storage = context.pgsSession.sessionStorage;
    if (!storage || typeof storage !== 'object'
        || typeof storage.verify !== 'function'
        || typeof storage.reconcileQuota !== 'function'
        // HOME23 PATCH 61 — fresh projection publication is an explicit capability.
        || typeof storage.markProjectionUsable !== 'function'
        || typeof storage.close !== 'function') {
      throw invalid('pgsSession storage is invalid');
    }
  }
  return context;
}

function attachPgsSession(envelope, context, parameters) {
  if (!envelope.result) return envelope;
  const result = envelope.result;
  const metadata = result.metadata && typeof result.metadata === 'object'
    && !Array.isArray(result.metadata) ? result.metadata : {};
  const pgs = metadata.pgs && typeof metadata.pgs === 'object'
    && !Array.isArray(metadata.pgs) ? metadata.pgs : {};
  const continuable = Date.parse(context.pgsSession.continuableUntil) > Date.now()
    && (parameters.pgsMode === 'targeted' || pgs.fullCoverage !== true);
  return {
    ...envelope,
    result: {
      ...result,
      metadata: {
        ...metadata,
        pgs: {
          ...pgs,
          sessionId: context.pgsSession.sessionId,
          continuableUntil: context.pgsSession.continuableUntil,
          sourceOperationId: context.pgsSession.sourceOperationId,
          canContinue: continuable,
        },
      },
    },
  };
}

function invalidWorkerResult(message) {
  return typed('worker_result_invalid', message);
}

function assertWorkerDataObject(value, label) {
  try {
    return assertDataObject(value, label);
  } catch {
    throw invalidWorkerResult(`${label} is invalid`);
  }
}

function exactEvidenceTotals(value, label) {
  assertWorkerDataObject(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 2
      || !Object.hasOwn(descriptors, 'nodes') || !Object.hasOwn(descriptors, 'edges')) {
    throw invalidWorkerResult(`${label} must contain exact node and edge totals`);
  }
  const nodes = descriptors.nodes.value;
  const edges = descriptors.edges.value;
  if (!Number.isSafeInteger(nodes) || nodes < 0
      || !Number.isSafeInteger(edges) || edges < 0) {
    throw invalidWorkerResult(`${label} must contain safe nonnegative integers`);
  }
  return Object.freeze({ nodes, edges });
}

function retrievalFacts(evidence, label) {
  assertWorkerDataObject(evidence, label);
  const descriptors = Object.getOwnPropertyDescriptors(evidence);
  if (!Object.hasOwn(descriptors, 'returnedTotals')
      || !Object.hasOwn(descriptors, 'completeCoverage')
      || !Object.hasOwn(descriptors, 'filteredTotal')) {
    throw invalidWorkerResult(`${label} is missing retrieval facts`);
  }
  const returnedTotals = exactEvidenceTotals(
    descriptors.returnedTotals.value,
    `${label}.returnedTotals`,
  );
  const completeCoverage = descriptors.completeCoverage.value;
  const filteredTotal = descriptors.filteredTotal.value;
  if (typeof completeCoverage !== 'boolean'
      || !Number.isSafeInteger(filteredTotal) || filteredTotal < 0) {
    throw invalidWorkerResult(`${label} contains invalid retrieval facts`);
  }
  return Object.freeze({ returnedTotals, completeCoverage, filteredTotal });
}

function sameRetrievalFacts(left, right) {
  return left.completeCoverage === right.completeCoverage
    && left.filteredTotal === right.filteredTotal
    && left.returnedTotals.nodes === right.returnedTotals.nodes
    && left.returnedTotals.edges === right.returnedTotals.edges;
}

function evidenceCandidates(raw) {
  const candidates = [];
  const terminal = Object.hasOwn(raw, 'state');
  let result = raw;
  if (terminal) {
    result = Object.hasOwn(raw, 'result') ? raw.result : null;
    if (Object.hasOwn(raw, 'sourceEvidence') && raw.sourceEvidence !== null) {
      candidates.push({ value: raw.sourceEvidence, label: 'query executor sourceEvidence' });
    }
    if (result !== null) {
      assertWorkerDataObject(result, 'query executor result.result');
      if (Object.hasOwn(result, 'sourceEvidence') && result.sourceEvidence !== null) {
        candidates.push({
          value: result.sourceEvidence,
          label: 'query executor result.sourceEvidence',
        });
      }
    }
  } else if (Object.hasOwn(raw, 'sourceEvidence') && raw.sourceEvidence !== null) {
    candidates.push({ value: raw.sourceEvidence, label: 'query result sourceEvidence' });
  }
  const requiresEvidence = !terminal || raw.state !== 'failed' || result !== null;
  if (requiresEvidence && candidates.length === 0) {
    throw invalidWorkerResult('Query executor omitted source evidence');
  }
  return candidates;
}

function expectedMatchOutcome(evidence, facts, authoritativeTotals) {
  if (facts.returnedTotals.nodes > 0) return 'matches';
  if (evidence.sourceHealth !== 'healthy' || !facts.completeCoverage) return 'unknown';
  if (authoritativeTotals.nodes === 0) return 'corpus_empty';
  if (facts.filteredTotal > 0) return 'filtered';
  return 'no_match';
}

function canonicalEvidence(context, facts, retrievalEnvelope = {}) {
  const route = typeof context.target.route === 'string' && context.target.route
    ? context.target.route
    : 'brain-operation-worker';
  const selectedAgent = context.target.ownerAgent ?? null;
  const selectedBrain = context.target.brainId;
  let evidence;
  try {
    evidence = context.sourcePin.getEvidence({
      selectedAgent,
      selectedBrain,
      route,
      returnedTotals: facts.returnedTotals,
      completeCoverage: facts.completeCoverage,
      filteredTotal: facts.filteredTotal,
      ...retrievalEnvelope,
    });
  } catch {
    throw invalidWorkerResult('Pinned source returned invalid evidence');
  }
  assertWorkerDataObject(evidence, 'canonical source evidence');
  const canonicalFacts = retrievalFacts(evidence, 'canonical source evidence');
  const authoritativeTotals = exactEvidenceTotals(
    evidence.authoritativeTotals,
    'canonical source evidence.authoritativeTotals',
  );
  if (!['healthy', 'degraded', 'unavailable'].includes(evidence.sourceHealth)
      || !['known', 'unknown'].includes(evidence.freshness)
      || !sameRetrievalFacts(facts, canonicalFacts)
      || canonicalFacts.returnedTotals.nodes > authoritativeTotals.nodes
      || canonicalFacts.returnedTotals.edges > authoritativeTotals.edges
      || canonicalFacts.filteredTotal > authoritativeTotals.nodes
      || evidence.selectedAgent !== selectedAgent
      || evidence.selectedBrain !== selectedBrain
      || evidence.route !== route
      || evidence.matchOutcome !== expectedMatchOutcome(
        evidence,
        canonicalFacts,
        authoritativeTotals,
      )) {
    throw invalidWorkerResult('Canonical source evidence is inconsistent');
  }
  validateCanonicalRetrievalEnvelope(evidence, canonicalFacts);
  return evidence;
}

function validateCanonicalRetrievalEnvelope(evidence, facts) {
  if (evidence.indexCoverage && typeof evidence.indexCoverage === 'object') {
    const coverage = evidence.indexCoverage;
    const currentRevision = evidence.deltaWatermark?.revision ?? null;
    const indexedRevision = evidence.indexWatermark?.builtFromRevision ?? null;
    if (coverage.currentRevision !== currentRevision
        || (coverage.indexedRevision !== null && coverage.indexedRevision !== indexedRevision)
        || (coverage.coveredThroughRevision !== null
          && (currentRevision === null || coverage.coveredThroughRevision > currentRevision))
        || (coverage.complete === true
          && (coverage.coveredThroughRevision !== currentRevision
            || coverage.completeness !== 'complete'))) {
      throw invalidWorkerResult('Canonical retrieval index coverage is inconsistent');
    }
  }
  if (evidence.authoritySummary && typeof evidence.authoritySummary === 'object') {
    const summary = evidence.authoritySummary;
    const classTotal = Object.values(summary.authorityClasses || {})
      .reduce((sum, count) => sum + count, 0);
    if (summary.total !== facts.returnedTotals.nodes
        || classTotal !== summary.total
        || summary.requiresFreshVerification > summary.total) {
      throw invalidWorkerResult('Canonical retrieval authority population is inconsistent');
    }
  }
}

function reconcileRetrievalEnvelope(candidates) {
  const projected = candidates
    .map(candidate => projectRetrievalEvidenceEnvelope(candidate.value))
    .filter(value => Object.keys(value).length > 0);
  const attested = candidates
    .map(candidate => getAttestedRetrievalAuthoritySummary(candidate.value))
    .filter(Boolean);
  const returnedNodes = candidates.length > 0
    ? retrievalFacts(candidates[0].value, candidates[0].label).returnedTotals.nodes
    : 0;
  const fallbackAuthority = normalizeAuthoritySummary({
    total: returnedNodes,
    authorityClasses: { narrative: returnedNodes },
    retrievalDomains: { current_ops: returnedNodes },
    sourceChain: { withEvidence: 0, withoutEvidence: returnedNodes, referenceCounts: {} },
    requiresFreshVerification: returnedNodes,
  });
  const canonicalAuthority = attested[0] || fallbackAuthority;
  if (attested.some(summary => canonicalJson(summary) !== canonicalJson(canonicalAuthority))) {
    throw invalidWorkerResult('Producer-attested authority evidence disagrees');
  }
  if (canonicalAuthority.total !== returnedNodes) {
    throw invalidWorkerResult('Producer-attested authority population is inconsistent');
  }
  if (projected.length === 0) return { authoritySummary: canonicalAuthority };
  const digest = canonicalJson(projected[0]);
  if (projected.slice(1).some(value => canonicalJson(value) !== digest)) {
    throw invalidWorkerResult('Child source evidence retrieval envelopes disagree');
  }
  return { ...projected[0], authoritySummary: canonicalAuthority };
}

function assertOptionalCanonicalValue(child, canonical, key, { nullAllowed = false } = {}) {
  if (!Object.hasOwn(child, key)) return;
  const value = child[key];
  if (nullAllowed && value === null) return;
  if (value !== canonical[key]) {
    throw invalidWorkerResult(`Child source evidence ${key} is inconsistent`);
  }
}

function assertOptionalWatermark(child, canonical, key, fields) {
  if (!Object.hasOwn(child, key)) return;
  const childWatermark = assertWorkerDataObject(child[key], `child source evidence.${key}`);
  const canonicalWatermark = assertWorkerDataObject(
    canonical[key],
    `canonical source evidence.${key}`,
  );
  for (const field of fields) {
    if (Object.hasOwn(childWatermark, field)
        && childWatermark[field] !== canonicalWatermark[field]) {
      throw invalidWorkerResult(`Child source evidence ${key}.${field} is inconsistent`);
    }
  }
}

function assertChildEvidenceCount(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidWorkerResult(`${label} must be a safe nonnegative integer`);
  }
}

function validateChildRetrievalClaims(child, label) {
  if (Object.hasOwn(child, 'indexCoverage')) {
    const coverage = assertWorkerDataObject(
      child.indexCoverage,
      `${label}.indexCoverage`,
    );
    if (typeof coverage.complete !== 'boolean') {
      throw invalidWorkerResult(`${label}.indexCoverage.complete must be boolean`);
    }
    for (const key of ['indexedRevision', 'currentRevision', 'coveredThroughRevision']) {
      if (Object.hasOwn(coverage, key)) {
        assertChildEvidenceCount(coverage[key], `${label}.indexCoverage.${key}`, {
          nullable: true,
        });
      }
    }
    for (const key of [
      'deltaRecords', 'distinctChangedNodes', 'distinctUpsertedNodes',
      'distinctRemovedNodes', 'edgeOnlyRecords',
    ]) {
      if (Object.hasOwn(coverage, key)) {
        assertChildEvidenceCount(coverage[key], `${label}.indexCoverage.${key}`);
      }
    }
    for (const key of ['route', 'completeness']) {
      if (Object.hasOwn(coverage, key)
          && (typeof coverage[key] !== 'string' || !coverage[key].trim())) {
        throw invalidWorkerResult(`${label}.indexCoverage.${key} is invalid`);
      }
    }
  }
  if (Object.hasOwn(child, 'authoritySummary')) {
    const summary = assertWorkerDataObject(
      child.authoritySummary,
      `${label}.authoritySummary`,
    );
    for (const [key, value] of Object.entries(summary)) {
      if (['authorityClasses', 'retrievalDomains', 'sourceChain'].includes(key)) continue;
      assertChildEvidenceCount(value, `${label}.authoritySummary.${key}`);
    }
    for (const key of ['authorityClasses', 'retrievalDomains']) {
      if (!Object.hasOwn(summary, key)) continue;
      const counts = assertWorkerDataObject(summary[key], `${label}.authoritySummary.${key}`);
      for (const [name, value] of Object.entries(counts)) {
        assertChildEvidenceCount(value, `${label}.authoritySummary.${key}.${name}`);
      }
    }
    if (Object.hasOwn(summary, 'sourceChain')) {
      const sourceChain = assertWorkerDataObject(
        summary.sourceChain,
        `${label}.authoritySummary.sourceChain`,
      );
      for (const key of ['withEvidence', 'withoutEvidence']) {
        if (Object.hasOwn(sourceChain, key)) {
          assertChildEvidenceCount(
            sourceChain[key],
            `${label}.authoritySummary.sourceChain.${key}`,
          );
        }
      }
      if (Object.hasOwn(sourceChain, 'referenceCounts')) {
        const references = assertWorkerDataObject(
          sourceChain.referenceCounts,
          `${label}.authoritySummary.sourceChain.referenceCounts`,
        );
        for (const [kind, value] of Object.entries(references)) {
          assertChildEvidenceCount(
            value,
            `${label}.authoritySummary.sourceChain.referenceCounts.${kind}`,
          );
        }
      }
    }
  }
}

function validateChildEvidence(child, canonical, facts, label) {
  assertWorkerDataObject(child, label);
  validateChildRetrievalClaims(child, label);
  const childFacts = retrievalFacts(child, label);
  if (!sameRetrievalFacts(childFacts, facts)) {
    throw invalidWorkerResult('Child source evidence retrieval facts disagree');
  }
  if (Object.hasOwn(child, 'authoritativeTotals')) {
    const childAuthority = exactEvidenceTotals(
      child.authoritativeTotals,
      `${label}.authoritativeTotals`,
    );
    const canonicalAuthority = exactEvidenceTotals(
      canonical.authoritativeTotals,
      'canonical source evidence.authoritativeTotals',
    );
    if (childAuthority.nodes !== canonicalAuthority.nodes
        || childAuthority.edges !== canonicalAuthority.edges) {
      throw invalidWorkerResult('Child source evidence authority is inconsistent');
    }
  }
  for (const key of ['sourceHealth', 'freshness', 'matchOutcome']) {
    assertOptionalCanonicalValue(child, canonical, key);
  }
  for (const key of ['selectedAgent', 'selectedBrain']) {
    assertOptionalCanonicalValue(child, canonical, key, { nullAllowed: true });
  }
  assertOptionalWatermark(child, canonical, 'baseWatermark', ['revision', 'file']);
  assertOptionalWatermark(child, canonical, 'deltaWatermark', ['revision', 'epoch', 'appliedRecords']);
  assertOptionalWatermark(child, canonical, 'indexWatermark', ['builtFromRevision', 'fresh']);
  if (Object.hasOwn(child, 'identity') && child.identity !== null) {
    const childIdentity = assertWorkerDataObject(child.identity, `${label}.identity`);
    const canonicalIdentity = assertWorkerDataObject(
      canonical.identity,
      'canonical source evidence.identity',
    );
    for (const key of [
      'requesterAgent', 'targetAgent', 'brainId', 'canonicalRoot', 'catalogRevision',
      'kind', 'sourceType', 'accessMode', 'operationId',
    ]) {
      if (Object.hasOwn(childIdentity, key) && childIdentity[key] !== null
          && childIdentity[key] !== canonicalIdentity[key]) {
        throw invalidWorkerResult(`Child source evidence identity.${key} is inconsistent`);
      }
    }
  }
}

function reconcileEvidence(context, raw) {
  assertWorkerDataObject(raw, 'query executor result');
  const candidates = evidenceCandidates(raw);
  const facts = candidates.length > 0
    ? retrievalFacts(candidates[0].value, candidates[0].label)
    : Object.freeze({
      returnedTotals: Object.freeze({ nodes: 0, edges: 0 }),
      completeCoverage: false,
      filteredTotal: 0,
    });
  for (const candidate of candidates.slice(1)) {
    if (!sameRetrievalFacts(facts, retrievalFacts(candidate.value, candidate.label))) {
      throw invalidWorkerResult('Child source evidence retrieval facts disagree');
    }
  }
  const evidence = canonicalEvidence(context, facts, reconcileRetrievalEnvelope(candidates));
  for (const candidate of candidates) {
    validateChildEvidence(candidate.value, evidence, facts, candidate.label);
  }
  return evidence;
}

function attachEvidence(result, evidence) {
  if (result === null) return null;
  assertDataObject(result, 'query result');
  return { ...result, sourceEvidence: evidence };
}

function normalizeEnvelope(raw, evidence) {
  assertDataObject(raw, 'query executor result');
  if (Object.hasOwn(raw, 'resultArtifact') && raw.resultArtifact !== null) {
    throw typed('worker_result_invalid', 'Query and PGS cannot return result artifacts');
  }

  if (!Object.hasOwn(raw, 'state')) {
    return {
      state: 'complete',
      result: attachEvidence(raw, evidence),
      error: null,
      sourceEvidence: evidence,
      resultArtifact: null,
    };
  }

  if (!TERMINAL_STATES.has(raw.state)) {
    throw typed('worker_result_invalid', 'Query executor returned an invalid terminal state');
  }
  const result = Object.hasOwn(raw, 'result') ? raw.result : null;
  return {
    state: raw.state,
    result: attachEvidence(result, evidence),
    error: Object.hasOwn(raw, 'error') ? raw.error : null,
    sourceEvidence: evidence,
    resultArtifact: null,
  };
}

/**
 * HOME23 PATCH 49 — Translate one capability-protected operation context into
 * the pinned QueryEngine API without copying caller objects, deriving paths,
 * changing target state, or taking ownership of the injected source pin.
 */
function createQueryOperationExecutor({ queryEngine } = {}) {
  if (!queryEngine || typeof queryEngine.executeEnhancedQuery !== 'function') {
    throw typed('executor_unavailable', 'Query operation executor is unavailable', true);
  }

  return async function executeQueryOperation(rawContext) {
    const context = validateContext(rawContext);
    throwIfAborted(context.signal);
    const parameters = context.operationType === 'query'
      ? validateQueryParameters(context.parameters)
      : validatePgsParameters(context.parameters);
    const mutationPolicy = context.target.accessMode === 'own' ? 'own' : 'read-only';
    const allowActions = mutationPolicy === 'own' && parameters.allowActions === true;
    const options = {
      sourcePin: context.sourcePin,
      scratchDir: context.scratchDir,
      scratchQuota: context.scratchQuota,
      signal: context.signal,
      reportEvent: context.reportEvent,
      enablePGS: context.operationType === 'pgs',
      mode: parameters.mode,
      priorContext: parameters.priorContext,
      mutationPolicy,
      allowActions,
      ...(context.operationType === 'query'
        ? {
            provider: parameters.modelSelection.provider,
            model: parameters.modelSelection.model,
            topK: parameters.topK,
            enableSynthesis: parameters.enableSynthesis === true,
            includeOutputs: parameters.includeOutputs === true,
            includeThoughts: parameters.includeThoughts === true,
            includeCoordinatorInsights: parameters.includeCoordinatorInsights === true,
          }
        : {
            pgsMode: parameters.pgsMode,
            pgsLevel: parameters.pgsLevel,
            pgsConfig: parameters.pgsConfig,
            ...(parameters.continueFromOperationId
              ? { continueFromOperationId: parameters.continueFromOperationId }
              : {}),
            ...(parameters.targetPartitionIds
              ? { targetPartitionIds: parameters.targetPartitionIds }
              : {}),
            sessionStorage: context.pgsSession.sessionStorage,
            pgsSweep: parameters.pgsSweep,
            pgsSynth: parameters.pgsSynth,
          }),
    };

    try {
      const rawResult = await queryEngine.executeEnhancedQuery(parameters.query, options);
      throwIfAborted(context.signal);
      const evidence = reconcileEvidence(context, rawResult);
      throwIfAborted(context.signal);
      const envelope = normalizeEnvelope(rawResult, evidence);
      return context.operationType === 'pgs'
        ? attachPgsSession(envelope, context, parameters)
        : envelope;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      throw error;
    }
  };
}

module.exports = {
  createQueryOperationExecutor,
};
