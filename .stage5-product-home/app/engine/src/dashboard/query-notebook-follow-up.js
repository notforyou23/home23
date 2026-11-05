'use strict';

const {
  renderVerifiedConversation,
  validateVerifiedConversationContext,
  takeLeadingUtf16,
  takeTrailingUtf16,
} = require('../../../shared/query/verified-follow-up-context.cjs');

const MAX_VERIFIED_CONTEXT_UTF16 = 20_000;
const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const RESULT_VERSION_PATTERN = /^qrv1_[A-Za-z0-9_-]{43}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const QUERY_MAX_UTF16 = 12_000;
const DIRECT_MODES = new Set(['quick', 'full', 'expert', 'dive']);
const REQUEST_KEYS = Object.freeze([
  'kind', 'schemaVersion', 'followUpFrom', 'query', 'mode', 'modelSelection',
  'enableSynthesis', 'includeOutputs', 'includeThoughts',
  'includeCoordinatorInsights', 'allowActions',
]);
const REFERENCE_KEYS = Object.freeze(['operationId', 'resultVersion']);
const MODEL_KEYS = Object.freeze(['provider', 'model']);
const LINEAGE_KEYS = Object.freeze([
  'rootOperationId', 'parentOperationId', 'parentResultVersion', 'depth',
  'availableExchangeCount', 'includedExchangeCount', 'contextTruncated',
  'sourceAnswerTruncated',
]);
const PRIVATE_CONTEXT_KEYS = Object.freeze([
  'version', ...LINEAGE_KEYS, 'exchanges',
]);
const PRIVATE_EXCHANGE_KEYS = Object.freeze([
  'operationId', 'resultVersion', 'query', 'answer',
]);
const BUILD_KEYS = Object.freeze([
  'parentRecord', 'parentResult', 'parentLineage', 'parentPrivateContext',
  'maxPriorContextChars',
]);
const TERMINAL_ANSWER_STATES = new Set(['complete', 'partial']);
const IMMEDIATE_ANSWER_OMISSION_MARKER = '\n\n[... middle of immediate parent answer omitted by Home23 verified follow-up context budget ...]\n\n';

function followUpError(code = 'verified_follow_up_context_invalid') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) {
  throw followUpError(code);
}

function assertObject(value, code = 'verified_follow_up_context_invalid') {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(code);
  return value;
}

function assertExactKeys(value, expected, code = 'verified_follow_up_context_invalid') {
  assertObject(value, code);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (keys.length !== expected.length
      || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) fail(code);
  return value;
}

function assertOperationId(value, code = 'verified_follow_up_context_invalid') {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) fail(code);
  return value;
}

function assertResultVersion(value, code = 'verified_follow_up_context_invalid') {
  if (typeof value !== 'string' || !RESULT_VERSION_PATTERN.test(value)) fail(code);
  return value;
}

function assertBoundedNonemptyString(value, maxUtf16, code) {
  if (typeof value !== 'string' || value.length === 0 || !value.trim()
      || value.length > maxUtf16) fail(code);
  return value;
}

function normalizeReference(value, code) {
  assertExactKeys(value, REFERENCE_KEYS, code);
  return {
    operationId: assertOperationId(value.operationId, code),
    resultVersion: assertResultVersion(value.resultVersion, code),
  };
}

function normalizeModelPair(value, code) {
  assertExactKeys(value, MODEL_KEYS, code);
  if (typeof value.provider !== 'string' || value.provider.trim() !== value.provider
      || value.provider.length === 0
      || value.provider.length > 256
      || typeof value.model !== 'string' || value.model.trim() !== value.model
      || value.model.length === 0
      || value.model.length > 256) fail(code);
  return { provider: value.provider, model: value.model };
}

function normalizeVerifiedFollowUpRequest(raw) {
  const code = 'invalid_request';
  assertExactKeys(raw, REQUEST_KEYS, code);
  if (raw.kind !== 'verifiedFollowUp' || raw.schemaVersion !== 1
      || !DIRECT_MODES.has(raw.mode)
      || typeof raw.enableSynthesis !== 'boolean'
      || typeof raw.includeOutputs !== 'boolean'
      || typeof raw.includeThoughts !== 'boolean'
      || typeof raw.includeCoordinatorInsights !== 'boolean'
      || raw.allowActions !== false) fail(code);
  return {
    kind: 'verifiedFollowUp',
    schemaVersion: 1,
    followUpFrom: normalizeReference(raw.followUpFrom, code),
    query: assertBoundedNonemptyString(raw.query, QUERY_MAX_UTF16, code),
    mode: raw.mode,
    modelSelection: normalizeModelPair(raw.modelSelection, code),
    enableSynthesis: raw.enableSynthesis,
    includeOutputs: raw.includeOutputs,
    includeThoughts: raw.includeThoughts,
    includeCoordinatorInsights: raw.includeCoordinatorInsights,
    allowActions: false,
  };
}

function normalizeLineage(value, code = 'verified_follow_up_lineage_invalid') {
  assertExactKeys(value, LINEAGE_KEYS, code);
  const normalized = {
    rootOperationId: assertOperationId(value.rootOperationId, code),
    parentOperationId: assertOperationId(value.parentOperationId, code),
    parentResultVersion: assertResultVersion(value.parentResultVersion, code),
    depth: value.depth,
    availableExchangeCount: value.availableExchangeCount,
    includedExchangeCount: value.includedExchangeCount,
    contextTruncated: value.contextTruncated,
    sourceAnswerTruncated: value.sourceAnswerTruncated,
  };
  if (!Number.isSafeInteger(normalized.depth) || normalized.depth < 1
      || !Number.isSafeInteger(normalized.availableExchangeCount)
      || normalized.availableExchangeCount !== normalized.depth
      || !Number.isSafeInteger(normalized.includedExchangeCount)
      || normalized.includedExchangeCount < 1
      || normalized.includedExchangeCount > normalized.availableExchangeCount
      || typeof normalized.contextTruncated !== 'boolean'
      || normalized.contextTruncated
        !== (normalized.includedExchangeCount < normalized.availableExchangeCount)
      || typeof normalized.sourceAnswerTruncated !== 'boolean') fail(code);
  return normalized;
}

function validateFollowUpLineage(record) {
  assertObject(record, 'verified_follow_up_lineage_invalid');
  if (!Object.hasOwn(record, 'queryFollowUpLineage')
      || record.queryFollowUpLineage === null) return null;
  return normalizeLineage(record.queryFollowUpLineage);
}

function projectFollowUpLineage(record) {
  const lineage = validateFollowUpLineage(record);
  return lineage === null ? null : { ...lineage };
}

function normalizePrivateExchange(value, code) {
  assertExactKeys(value, PRIVATE_EXCHANGE_KEYS, code);
  return {
    operationId: assertOperationId(value.operationId, code),
    resultVersion: assertResultVersion(value.resultVersion, code),
    query: assertBoundedNonemptyString(value.query, QUERY_MAX_UTF16, code),
    answer: assertBoundedNonemptyString(value.answer, MAX_VERIFIED_CONTEXT_UTF16, code),
  };
}

function normalizePrivateContext(value) {
  const code = 'verified_follow_up_context_invalid';
  assertExactKeys(value, PRIVATE_CONTEXT_KEYS, code);
  if (value.version !== 1 || !Array.isArray(value.exchanges)) fail(code);
  const lineage = normalizeLineage(Object.fromEntries(
    LINEAGE_KEYS.map((key) => [key, value[key]]),
  ), code);
  const exchanges = value.exchanges.map((exchange) => normalizePrivateExchange(exchange, code));
  if (exchanges.length !== lineage.includedExchangeCount) fail(code);
  const identities = new Set(exchanges.map((exchange) => exchange.operationId));
  if (identities.size !== exchanges.length) fail(code);
  const newest = exchanges.at(-1);
  if (!newest || newest.operationId !== lineage.parentOperationId
      || newest.resultVersion !== lineage.parentResultVersion) fail(code);
  if (!lineage.contextTruncated && exchanges[0].operationId !== lineage.rootOperationId) fail(code);
  if (lineage.contextTruncated && identities.has(lineage.rootOperationId)) fail(code);
  if (lineage.sourceAnswerTruncated
      && !newest.answer.includes(IMMEDIATE_ANSWER_OMISSION_MARKER)) fail(code);
  const stripped = { version: 1, exchanges: exchanges.map(({ query, answer }) => ({ query, answer })) };
  validateVerifiedConversationContext(stripped, { maxUtf16: MAX_VERIFIED_CONTEXT_UTF16 });
  return { version: 1, ...lineage, exchanges };
}

function assertMatchingAncestry(lineage, privateContext) {
  for (const key of LINEAGE_KEYS) {
    if (lineage[key] !== privateContext[key]) fail('verified_follow_up_context_invalid');
  }
}

function normalizeParent(parentRecord, parentResult) {
  const code = 'verified_follow_up_context_invalid';
  assertObject(parentRecord, code);
  assertObject(parentResult, code);
  const operationId = assertOperationId(parentRecord.operationId, code);
  if (parentRecord.operationType !== 'query' && parentRecord.operationType !== 'pgs') fail(code);
  if (typeof parentRecord.requesterAgent !== 'string'
      || !IDENTIFIER_PATTERN.test(parentRecord.requesterAgent)) fail(code);
  const target = assertObject(parentRecord.target, code);
  if (target.domain !== 'brain' || typeof target.brainId !== 'string'
      || !IDENTIFIER_PATTERN.test(target.brainId)) fail(code);
  if (!TERMINAL_ANSWER_STATES.has(parentRecord.state)) fail(code);
  const request = assertObject(parentRecord.requestParameters, code);
  const query = assertBoundedNonemptyString(request.query, QUERY_MAX_UTF16, code);
  const summary = assertObject(parentRecord.notebookResultSummary, code);
  if (summary.version !== 1 || summary.answerAvailable !== true) fail(code);
  const version = assertResultVersion(summary.resultVersion, code);
  const answer = assertBoundedNonemptyString(
    parentResult.answer,
    Number.MAX_SAFE_INTEGER,
    code,
  );
  return { operationId, version, query, answer, request };
}

function projectImmediateAnswer(query, answer, maxUtf16) {
  const full = { query, answer };
  if (renderVerifiedConversation([full]).length <= maxUtf16) {
    return { answer, sourceAnswerTruncated: false };
  }
  const fixedFramingUtf16 = `Question:\n${query}\n\nAnswer:\n`.length;
  const answerBudget = maxUtf16 - fixedFramingUtf16;
  const excerptBudget = answerBudget - IMMEDIATE_ANSWER_OMISSION_MARKER.length;
  if (excerptBudget < 0) fail('verified_follow_up_context_invalid');
  const leadingBudget = Math.ceil(excerptBudget / 2);
  const trailingBudget = Math.floor(excerptBudget / 2);
  const projected = takeLeadingUtf16(answer, leadingBudget)
    + IMMEDIATE_ANSWER_OMISSION_MARKER
    + takeTrailingUtf16(answer, trailingBudget);
  if (renderVerifiedConversation([{ query, answer: projected }]).length > maxUtf16) {
    fail('verified_follow_up_context_invalid');
  }
  return { answer: projected, sourceAnswerTruncated: true };
}

function buildVerifiedFollowUpContext(options) {
  assertExactKeys(options, BUILD_KEYS, 'verified_follow_up_context_invalid');
  if (options.maxPriorContextChars !== MAX_VERIFIED_CONTEXT_UTF16) {
    fail('verified_follow_up_context_invalid');
  }
  const parent = normalizeParent(options.parentRecord, options.parentResult);
  const hasLineage = options.parentLineage !== null;
  const hasPrivateContext = options.parentPrivateContext !== null;
  if (hasLineage !== hasPrivateContext) fail('verified_follow_up_context_invalid');

  let inheritedLineage = null;
  let inheritedPrivate = null;
  if (hasLineage) {
    if (options.parentRecord.operationType !== 'query') fail('verified_follow_up_context_invalid');
    parent.request = normalizeVerifiedFollowUpRequest(parent.request);
    parent.query = parent.request.query;
    inheritedLineage = normalizeLineage(options.parentLineage);
    inheritedPrivate = normalizePrivateContext(options.parentPrivateContext);
    assertMatchingAncestry(inheritedLineage, inheritedPrivate);
    const source = parent.request.followUpFrom;
    if (source.operationId !== inheritedLineage.parentOperationId
        || source.resultVersion !== inheritedLineage.parentResultVersion) {
      fail('verified_follow_up_context_invalid');
    }
    const inheritedIds = new Set(inheritedPrivate.exchanges.map(({ operationId }) => operationId));
    if (parent.operationId === inheritedLineage.rootOperationId
        || inheritedIds.has(parent.operationId)) fail('verified_follow_up_context_invalid');
  } else if (Object.hasOwn(parent.request, 'kind')) {
    fail('verified_follow_up_context_invalid');
  }

  const projectedImmediate = projectImmediateAnswer(
    parent.query,
    parent.answer,
    options.maxPriorContextChars,
  );
  const immediate = {
    operationId: parent.operationId,
    resultVersion: parent.version,
    query: parent.query,
    answer: projectedImmediate.answer,
  };
  const selected = [immediate];
  const inheritedExchanges = inheritedPrivate?.exchanges ?? [];
  for (let index = inheritedExchanges.length - 1; index >= 0; index -= 1) {
    const candidate = [inheritedExchanges[index], ...selected];
    const strippedCandidate = candidate.map(({ query, answer }) => ({ query, answer }));
    if (renderVerifiedConversation(strippedCandidate).length > options.maxPriorContextChars) break;
    selected.unshift(inheritedExchanges[index]);
  }

  const depth = (inheritedLineage?.depth ?? 0) + 1;
  const lineage = {
    rootOperationId: inheritedLineage?.rootOperationId ?? parent.operationId,
    parentOperationId: parent.operationId,
    parentResultVersion: parent.version,
    depth,
    availableExchangeCount: depth,
    includedExchangeCount: selected.length,
    contextTruncated: selected.length < depth,
    sourceAnswerTruncated: projectedImmediate.sourceAnswerTruncated,
  };
  const privateContext = {
    version: 1,
    ...lineage,
    exchanges: selected.map((exchange) => ({ ...exchange })),
  };
  const verifiedConversationContext = validateVerifiedConversationContext({
    version: 1,
    exchanges: selected.map(({ query, answer }) => ({ query, answer })),
  }, { maxUtf16: options.maxPriorContextChars });
  return { queryFollowUpLineage: lineage, privateContext, verifiedConversationContext };
}

module.exports = Object.freeze({
  normalizeVerifiedFollowUpRequest,
  buildVerifiedFollowUpContext,
  validateFollowUpLineage,
  projectFollowUpLineage,
});
