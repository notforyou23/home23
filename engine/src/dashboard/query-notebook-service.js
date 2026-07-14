'use strict';

const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const { canonicalJson } = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  MATCH_OUTCOME,
  SOURCE_HEALTH,
} = require('../../../shared/memory-source/contracts.cjs');
const {
  EXECUTION_STATES,
  OPERATION_ID_PATTERN,
  assertOperationId,
  operationError,
  validateNotebookResultSummary,
} = require('./brain-operations/operation-contract.js');
const {
  validateQueryProgressSnapshot,
} = require('./brain-operations/query-progress.js');

const QUERY_MAX_CHARS = 12_000;
const QUESTION_TITLE_MAX_CHARS = 160;
const ANSWER_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_CHARS = 512;
const CURSOR_MAX_BYTES = 1024;
const RESULT_VERSION_PATTERN = /^qrv1_[A-Za-z0-9_-]{43}$/;
const FILTER_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NOTEBOOK_OPERATION_TYPES = new Set(['query', 'pgs']);
const REQUEST_KINDS = new Set(['direct', 'pgs']);
const STATE_GROUPS = new Set(['running', 'finished']);
const QUERY_MODES = new Set([
  'quick', 'full', 'expert', 'dive', 'fast', 'normal', 'deep', 'executive',
  'raw', 'report', 'innovation', 'consulting', 'grounded',
]);
const PGS_MODES = new Set(['fresh', 'continue', 'targeted']);
const PGS_LEVELS = new Set(['skim', 'sample', 'deep', 'full']);
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const SAFE_EVIDENCE_TOTALS = Object.freeze(['authoritativeTotals', 'returnedTotals']);
const SOURCE_HEALTH_VALUES = new Set(Object.values(SOURCE_HEALTH));
const MATCH_OUTCOME_VALUES = new Set(Object.values(MATCH_OUTCOME));
const FRESHNESS_VALUES = new Set(['known', 'unknown']);
const COVERAGE_FIELDS = Object.freeze([
  'coverageLevel', 'coverageFraction', 'successfulSweeps',
  'selectedWorkUnits', 'pendingWorkUnits', 'reusedWorkUnits', 'newWorkUnits',
  'scopeWorkUnits', 'scopeSuccessfulWorkUnits', 'scopePendingWorkUnits', 'scopeComplete',
  'globalCoveredWorkUnits', 'globalPendingWorkUnits', 'fullCoverage',
  'targetPartitionIds', 'retryablePartitions', 'retryablePartitionCount',
]);
const COVERAGE_COUNTER_FIELDS = new Set([
  'successfulSweeps', 'selectedWorkUnits', 'pendingWorkUnits', 'reusedWorkUnits',
  'newWorkUnits', 'scopeWorkUnits', 'scopeSuccessfulWorkUnits',
  'scopePendingWorkUnits', 'globalCoveredWorkUnits', 'globalPendingWorkUnits',
  'retryablePartitionCount',
]);
const PARTITION_ID_PATTERN = /^(?:c|h)-[A-Za-z0-9._-]{1,253}$/;
const RETRYABLE_PARTITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const PROGRESS_FIELDS = Object.freeze([
  'version', 'stage', 'eventSequence', 'sourceNodes', 'sourceEdges',
  'candidateWorkUnits', 'selected', 'completed', 'successful', 'failed', 'reused',
  'pending', 'retryable', 'total', 'synthesisLevel', 'synthesisBatch',
  'synthesisBatches', 'lastProviderActivityAt', 'lastProgressAt',
]);

function notebookError(code, cause) {
  return operationError(code, cause);
}

function plainObject(value, code = 'notebook_projection_invalid') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw notebookError(code);
  return value;
}

function canonicalIsoOrNull(value, code = 'notebook_projection_invalid') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw notebookError(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw notebookError(code);
  }
  return value;
}

function safeCounter(value, code = 'notebook_projection_invalid') {
  if (!Number.isSafeInteger(value) || value < 0) throw notebookError(code);
  return value;
}

function exactPair(value) {
  plainObject(value);
  if (Reflect.ownKeys(value).length !== 2
      || typeof value.provider !== 'string' || !value.provider
      || value.provider.length > 256
      || typeof value.model !== 'string' || !value.model
      || value.model.length > 256) {
    throw notebookError('notebook_projection_invalid');
  }
  return { provider: value.provider, model: value.model };
}

function validateNotebookRecord(record) {
  plainObject(record);
  assertOperationId(record.operationId);
  if (!NOTEBOOK_OPERATION_TYPES.has(record.operationType)
      || typeof record.requesterAgent !== 'string' || !record.requesterAgent
      || !EXECUTION_STATES.includes(record.state)) {
    throw notebookError('notebook_projection_invalid');
  }
  const request = plainObject(record.requestParameters);
  if (typeof request.query !== 'string' || !request.query.trim()
      || request.query.length > QUERY_MAX_CHARS) {
    throw notebookError('notebook_projection_invalid');
  }
  const target = plainObject(record.target);
  if (target.domain !== 'brain'
      || typeof target.brainId !== 'string' || !target.brainId
      || typeof target.displayName !== 'string' || !target.displayName
      || target.displayName.length > 4096) {
    throw notebookError('notebook_projection_invalid');
  }
  return record;
}

function deriveResultAvailability(record) {
  plainObject(record);
  if (record.resultExpiredAt !== null && record.resultExpiredAt !== undefined) return 'expired';
  if (record.result !== null && record.result !== undefined) return 'available';
  if (record.resultHandle !== null && record.resultHandle !== undefined) return 'available';
  if (record.resultArtifact !== null && record.resultArtifact !== undefined) return 'available';
  return 'absent';
}

function questionTitle(question) {
  return question.trim().replace(/\s+/gu, ' ').slice(0, QUESTION_TITLE_MAX_CHARS);
}

function publicTypedError(value) {
  if (value === null || value === undefined) return null;
  plainObject(value);
  if (typeof value.code !== 'string' || !value.code || value.code.length > 256
      || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value.code)
      || typeof value.retryable !== 'boolean') {
    throw notebookError('notebook_projection_invalid');
  }
  return { code: value.code, retryable: value.retryable };
}

function safeTotals(value) {
  if (value === undefined || value === null) return undefined;
  plainObject(value);
  return {
    nodes: safeCounter(value.nodes),
    edges: safeCounter(value.edges),
  };
}

function projectSafeEvidence(value) {
  if (value === null || value === undefined) return null;
  plainObject(value);
  const projected = {};
  if (SOURCE_HEALTH_VALUES.has(value.sourceHealth)) projected.sourceHealth = value.sourceHealth;
  if (FRESHNESS_VALUES.has(value.freshness)) projected.freshness = value.freshness;
  if (MATCH_OUTCOME_VALUES.has(value.matchOutcome)) projected.matchOutcome = value.matchOutcome;
  if (value.completeCoverage !== undefined) {
    if (typeof value.completeCoverage !== 'boolean') throw notebookError('notebook_projection_invalid');
    projected.completeCoverage = value.completeCoverage;
  }
  if (value.filteredTotal !== undefined) projected.filteredTotal = safeCounter(value.filteredTotal);
  for (const field of SAFE_EVIDENCE_TOTALS) {
    const totals = safeTotals(value[field]);
    if (totals !== undefined) projected[field] = totals;
  }
  return Object.keys(projected).length === 0 ? null : projected;
}

function projectConfiguration(record) {
  const request = record.requestParameters;
  const parameters = plainObject(record.parameters);
  if (record.operationType === 'query') {
    const directMode = request.mode ?? null;
    if (directMode !== null && !QUERY_MODES.has(directMode)) {
      throw notebookError('notebook_projection_invalid');
    }
    return {
      directMode,
      directModel: exactPair(parameters.modelSelection),
    };
  }
  if (!PGS_MODES.has(request.pgsMode) || !PGS_LEVELS.has(request.pgsLevel)) {
    throw notebookError('notebook_projection_invalid');
  }
  return {
    pgsMode: request.pgsMode,
    pgsLevel: request.pgsLevel,
    sweepModel: exactPair(parameters.pgsSweep),
    synthesisModel: exactPair(parameters.pgsSynth),
  };
}

function exactKeys(value, allowed, code = 'notebook_projection_invalid') {
  plainObject(value, code);
  const accepted = new Set(allowed);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw notebookError(code);
  }
}

function projectCoverage(value) {
  if (value === null || value === undefined) return null;
  exactKeys(value, COVERAGE_FIELDS);
  const projected = {};
  for (const field of COVERAGE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const entry = value[field];
    if (COVERAGE_COUNTER_FIELDS.has(field)) projected[field] = safeCounter(entry);
    else if (field === 'coverageLevel') {
      if (!['skim', 'sample', 'deep', 'full'].includes(entry)) {
        throw notebookError('notebook_projection_invalid');
      }
      projected.coverageLevel = entry;
    } else if (field === 'coverageFraction') {
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 1) {
        throw notebookError('notebook_projection_invalid');
      }
      projected.coverageFraction = entry;
    } else if (field === 'scopeComplete' || field === 'fullCoverage') {
      if (typeof entry !== 'boolean') throw notebookError('notebook_projection_invalid');
      projected[field] = entry;
    } else if (field === 'targetPartitionIds' || field === 'retryablePartitions') {
      const pattern = field === 'targetPartitionIds'
        ? PARTITION_ID_PATTERN : RETRYABLE_PARTITION_ID_PATTERN;
      if (!Array.isArray(entry) || entry.length > 256
          || new Set(entry).size !== entry.length
          || entry.some((id) => typeof id !== 'string' || !pattern.test(id)
            || id === '.' || id === '..')) {
        throw notebookError('notebook_projection_invalid');
      }
      projected[field] = [...entry];
    }
  }
  return projected;
}

function projectContinuation(value, nowValue) {
  if (value === null || value === undefined) return null;
  exactKeys(value, ['canContinue', 'continuableUntil', 'sourceOperationId']);
  if (typeof value.canContinue !== 'boolean') throw notebookError('notebook_projection_invalid');
  const continuableUntil = canonicalIsoOrNull(value.continuableUntil);
  if (continuableUntil === null) throw notebookError('notebook_projection_invalid');
  if (value.sourceOperationId !== null && !OPERATION_ID_PATTERN.test(value.sourceOperationId)) {
    throw notebookError('notebook_projection_invalid');
  }
  return {
    canContinue: value.canContinue && Date.parse(continuableUntil) > nowValue,
    continuableUntil,
    sourceOperationId: value.sourceOperationId,
  };
}

function projectPersistedResultSummary(record, nowValue) {
  const availability = deriveResultAvailability(record);
  const summary = record.notebookResultSummary;
  if (summary === null || summary === undefined) {
    if (availability === 'available') throw notebookError('notebook_result_summary_missing');
    return {
      resultVersion: null,
      answerPreviewAvailable: false,
      coverage: null,
      continuation: null,
    };
  }
  let validated;
  try {
    validated = validateNotebookResultSummary(summary, 'notebook_projection_invalid');
  } catch (error) {
    throw notebookError('notebook_projection_invalid', error);
  }
  if (!RESULT_VERSION_PATTERN.test(validated.resultVersion)
      || (record.operationType === 'query' && validated.continuation !== null)) {
    throw notebookError('notebook_projection_invalid');
  }
  if (record.operationType === 'pgs' && validated.continuation !== null) {
    const session = plainObject(record.pgsSession);
    if (validated.continuation.continuableUntil !== session.continuableUntil
        || validated.continuation.sourceOperationId !== session.sourceOperationId) {
      throw notebookError('notebook_projection_invalid');
    }
  }
  return {
    resultVersion: validated.resultVersion,
    answerPreviewAvailable: validated.answerAvailable,
    coverage: projectCoverage(validated.coverage),
    continuation: projectContinuation(validated.continuation, nowValue),
  };
}

function projectProgress(value) {
  if (value === null || value === undefined) return null;
  let validated;
  try {
    validated = validateQueryProgressSnapshot(value, 'notebook_projection_invalid');
  } catch (error) {
    throw notebookError('notebook_projection_invalid', error);
  }
  const projected = {};
  for (const field of PROGRESS_FIELDS) {
    if (Object.hasOwn(validated, field)) projected[field] = validated[field];
  }
  return projected;
}

function projectNotebookSummary(rawRecord, { now = Date.now } = {}) {
  if (typeof now !== 'function') throw notebookError('notebook_projection_invalid');
  const record = validateNotebookRecord(rawRecord);
  const rawNow = now();
  const nowValue = rawNow instanceof Date ? rawNow.getTime()
    : typeof rawNow === 'string' ? Date.parse(rawNow) : rawNow;
  if (!Number.isFinite(nowValue)) throw notebookError('notebook_projection_invalid');
  const result = projectPersistedResultSummary(record, nowValue);
  const availability = deriveResultAvailability(record);
  return {
    schemaVersion: 1,
    operationId: record.operationId,
    requestKind: record.operationType === 'query' ? 'direct' : 'pgs',
    requesterAgent: record.requesterAgent,
    brain: { id: record.target.brainId, displayName: record.target.displayName },
    question: record.requestParameters.query,
    questionTitle: questionTitle(record.requestParameters.query),
    configuration: projectConfiguration(record),
    executionState: record.state,
    humanClassification: record.state === 'queued' || record.state === 'running'
      ? 'running' : 'finished',
    acceptedAt: canonicalIsoOrNull(record.acceptedAt),
    startedAt: canonicalIsoOrNull(record.startedAt),
    updatedAt: canonicalIsoOrNull(record.updatedAt),
    completedAt: canonicalIsoOrNull(record.completedAt),
    progress: projectProgress(record.progressSnapshot),
    error: publicTypedError(record.error),
    resultAvailability: availability,
    expiresAt: canonicalIsoOrNull(record.resultExpiresAt),
    answerPreviewAvailable: availability === 'available' && result.answerPreviewAvailable,
    resultVersion: availability === 'available' ? result.resultVersion : null,
    coverage: result.coverage,
    continuation: availability === 'available' || result.continuation === null
      ? result.continuation
      : { ...result.continuation, canContinue: false },
  };
}

function projectNotebookResult(rawRecord, rawResult, { now = Date.now } = {}) {
  if (typeof now !== 'function') throw notebookError('notebook_projection_invalid');
  const record = validateNotebookRecord(rawRecord);
  if (deriveResultAvailability(record) !== 'available') {
    throw notebookError('result_unavailable');
  }
  const rawNow = now();
  const nowValue = rawNow instanceof Date ? rawNow.getTime()
    : typeof rawNow === 'string' ? Date.parse(rawNow) : rawNow;
  if (!Number.isFinite(nowValue)) throw notebookError('notebook_projection_invalid');
  const persisted = projectPersistedResultSummary(record, nowValue);
  const result = plainObject(rawResult, 'notebook_result_invalid');
  const answer = result.answer;
  if (answer !== null && (typeof answer !== 'string'
      || Buffer.byteLength(answer, 'utf8') > ANSWER_MAX_BYTES)) {
    throw notebookError('notebook_result_invalid');
  }
  return {
    schemaVersion: 1,
    operationId: record.operationId,
    resultVersion: persisted.resultVersion,
    answer,
    coverage: persisted.coverage,
    evidence: projectSafeEvidence(record.sourceEvidence),
    continuation: persisted.continuation,
  };
}

function normalizeSearch(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > SEARCH_MAX_CHARS || value.includes('\0')) {
    throw notebookError('invalid_request');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
  if (normalized.length > SEARCH_MAX_CHARS) throw notebookError('invalid_request');
  return normalized || null;
}

function normalizeQuestionForSearch(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

function notebookFilterDigest(filters) {
  const digest = crypto.createHash('sha256').update(canonicalJson({
    q: filters.q,
    stateGroup: filters.stateGroup,
    executionState: filters.executionState,
    requestKind: filters.requestKind,
  }), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function encodeNotebookCursor({ acceptedAt, operationId, filterDigest }) {
  const canonicalAcceptedAt = canonicalIsoOrNull(acceptedAt, 'notebook_cursor_invalid');
  if (canonicalAcceptedAt === null) throw notebookError('notebook_cursor_invalid');
  const payload = {
    v: 1,
    acceptedAt: canonicalAcceptedAt,
    operationId,
    filterDigest,
  };
  try { assertOperationId(payload.operationId); } catch (error) {
    throw notebookError('notebook_cursor_invalid', error);
  }
  if (!FILTER_DIGEST_PATTERN.test(payload.filterDigest)) {
    throw notebookError('notebook_cursor_invalid');
  }
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  if (bytes.length > CURSOR_MAX_BYTES) throw notebookError('notebook_cursor_invalid');
  return bytes.toString('base64url');
}

function decodeNotebookCursor(value) {
  if (typeof value !== 'string' || !value || value.length > 2048
      || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw notebookError('notebook_cursor_invalid');
  }
  let bytes;
  let parsed;
  try {
    bytes = Buffer.from(value, 'base64url');
    if (bytes.length > CURSOR_MAX_BYTES || bytes.toString('base64url') !== value) {
      throw notebookError('notebook_cursor_invalid');
    }
    parsed = JSON.parse(bytes.toString('utf8'));
    exactKeys(parsed, ['v', 'acceptedAt', 'operationId', 'filterDigest'], 'notebook_cursor_invalid');
    if (Reflect.ownKeys(parsed).length !== 4 || parsed.v !== 1) {
      throw notebookError('notebook_cursor_invalid');
    }
    const canonical = encodeNotebookCursor(parsed);
    if (canonical !== value) throw notebookError('notebook_cursor_invalid');
  } catch (error) {
    if (error?.code === 'notebook_cursor_invalid') throw error;
    throw notebookError('notebook_cursor_invalid', error);
  }
  return parsed;
}

function normalizeListInput(raw = {}) {
  exactKeys(raw, ['limit', 'cursor', 'q', 'stateGroup', 'executionState', 'requestKind'], 'invalid_request');
  const limit = raw.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw notebookError('invalid_request');
  }
  const stateGroup = raw.stateGroup ?? null;
  const executionState = raw.executionState ?? null;
  const requestKind = raw.requestKind ?? null;
  if ((stateGroup !== null && !STATE_GROUPS.has(stateGroup))
      || (executionState !== null && !EXECUTION_STATES.includes(executionState))
      || (requestKind !== null && !REQUEST_KINDS.has(requestKind))
      || (stateGroup !== null && executionState !== null)
      || (raw.cursor !== undefined && raw.cursor !== null && typeof raw.cursor !== 'string')) {
    throw notebookError('invalid_request');
  }
  return {
    limit,
    cursor: raw.cursor ?? null,
    q: normalizeSearch(raw.q),
    stateGroup,
    executionState,
    requestKind,
  };
}

function matchesFilters(record, filters) {
  const kind = record.operationType === 'query' ? 'direct' : 'pgs';
  if (filters.requestKind !== null && kind !== filters.requestKind) return false;
  if (filters.executionState !== null && record.state !== filters.executionState) return false;
  if (filters.stateGroup === 'running'
      && record.state !== 'queued' && record.state !== 'running') return false;
  if (filters.stateGroup === 'finished' && !TERMINAL_STATES.has(record.state)) return false;
  if (filters.q !== null) {
    const question = normalizeQuestionForSearch(record.requestParameters.query);
    if (!question.includes(filters.q)) return false;
  }
  return true;
}

function createQueryNotebookService(options) {
  exactKeys(options, ['reader', 'now'], 'notebook_configuration_invalid');
  const { reader } = options;
  const now = options.now ?? Date.now;
  if (!reader || typeof reader.expectedRequester !== 'string'
      || !reader.expectedRequester
      || typeof reader.listAuthorized !== 'function'
      || typeof reader.getAuthorized !== 'function'
      || typeof reader.getResultAuthorized !== 'function'
      || typeof now !== 'function') {
    throw notebookError('notebook_configuration_invalid');
  }

  async function ensureVisibleSummary(record) {
    if (deriveResultAvailability(record) !== 'available'
        || (record.notebookResultSummary !== null
          && record.notebookResultSummary !== undefined)) {
      return record;
    }
    if (typeof reader.ensureNotebookResultSummaryAuthorized !== 'function') {
      throw notebookError('notebook_result_summary_missing');
    }
    const backfilled = await reader.ensureNotebookResultSummaryAuthorized(record.operationId);
    validateNotebookRecord(backfilled);
    if (backfilled.operationId !== record.operationId
        || backfilled.requesterAgent !== reader.expectedRequester) {
      throw notebookError('access_denied');
    }
    return backfilled;
  }

  async function listQueryNotebookAuthorized(rawInput = {}) {
    const filters = normalizeListInput(rawInput);
    const filterDigest = notebookFilterDigest(filters);
    const cursor = filters.cursor === null ? null : decodeNotebookCursor(filters.cursor);
    if (cursor && cursor.filterDigest !== filterDigest) {
      throw notebookError('notebook_cursor_filter_mismatch');
    }
    const source = await reader.listAuthorized();
    if (!Array.isArray(source)) throw notebookError('operation_corrupt');
    for (const record of source) {
      if (!record || Array.isArray(record) || typeof record !== 'object') {
        throw notebookError('operation_corrupt');
      }
      if (record.requesterAgent !== reader.expectedRequester) throw notebookError('access_denied');
    }
    let records = source.filter((record) => NOTEBOOK_OPERATION_TYPES.has(record.operationType));
    records = records.filter((record) => {
      validateNotebookRecord(record);
      if (canonicalIsoOrNull(record.acceptedAt) === null) {
        throw notebookError('notebook_projection_invalid');
      }
      return matchesFilters(record, filters);
    });
    records.sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt)
      || right.operationId.localeCompare(left.operationId));
    if (cursor) {
      records = records.filter((record) => record.acceptedAt < cursor.acceptedAt
        || (record.acceptedAt === cursor.acceptedAt
          && record.operationId < cursor.operationId));
    }
    const page = records.slice(0, filters.limit + 1);
    const hasMore = page.length > filters.limit;
    if (hasMore) page.pop();
    const visible = [];
    for (const record of page) visible.push(await ensureVisibleSummary(record));
    const items = visible.map((record) => projectNotebookSummary(record, { now }));
    const last = page.at(-1);
    return {
      schemaVersion: 1,
      items,
      nextCursor: hasMore ? encodeNotebookCursor({
        acceptedAt: last.acceptedAt,
        operationId: last.operationId,
        filterDigest,
      }) : null,
    };
  }

  async function getQueryNotebookResultAuthorized(operationId) {
    assertOperationId(operationId);
    let record = await reader.getAuthorized(operationId);
    if (record.requesterAgent !== reader.expectedRequester) throw notebookError('access_denied');
    validateNotebookRecord(record);
    record = await ensureVisibleSummary(record);
    const result = await reader.getResultAuthorized(operationId);
    return projectNotebookResult(record, result, { now });
  }

  return Object.freeze({
    getQueryNotebookResultAuthorized,
    listQueryNotebookAuthorized,
  });
}

module.exports = {
  createQueryNotebookService,
  decodeNotebookCursor,
  deriveResultAvailability,
  encodeNotebookCursor,
  notebookFilterDigest,
  projectNotebookResult,
  projectNotebookSummary,
};
