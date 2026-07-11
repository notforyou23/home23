'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  canonicalJson,
  canonicalSha256,
} = require('../../../../shared/brain-operations/canonical-json.cjs');

const EXECUTION_STATES = Object.freeze([
  'queued',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const ATTACHMENT_STATES = Object.freeze(['attached', 'detached', 'closed']);
const INLINE_RESULT_LIMIT_BYTES = 64 * 1024;
const OPERATION_EVENT_MAX_COUNT = 4096;
const OPERATION_EVENT_MAX_BYTES = 8 * 1024 * 1024;
const OPERATION_RESULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const IDENTIFIER_MAX_LENGTH = 256;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const RESULT_HANDLE_PATTERN = /^brres_[A-Za-z0-9_-]{32}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const TARGET_ACCESS_MODES = new Set(['own', 'read-only']);
const BRAIN_KINDS = new Set(['resident', 'research']);
const BRAIN_LIFECYCLES = new Set(['resident', 'completed']);
const OWNED_RUN_STATES = new Set([
  'starting', 'active', 'stopping', 'paused', 'failed', 'completed', 'stopped',
]);
const MUTATION_BOUNDARY_KINDS = Object.freeze([
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
]);
const BOUNDED_JSON_OBJECT_MAX_BYTES = 64 * 1024;
const ERROR_MESSAGE_MAX_LENGTH = 4096;

const PUBLIC_RECORD_FIELDS = Object.freeze([
  'operationId',
  'requestId',
  'operationType',
  'requestParameters',
  'parameters',
  'canonicalEvidence',
  'recordVersion',
  'eventSequence',
  'requesterAgent',
  'target',
  'state',
  'phase',
  'startedAt',
  'updatedAt',
  'completedAt',
  'lastProviderActivityAt',
  'lastProgressAt',
  'result',
  'resultHandle',
  'resultArtifact',
  'error',
  'sourceEvidence',
  'sourcePinDescriptor',
  'sourcePinDigest',
  'sourcePinReleasedAt',
  'resultExpiresAt',
  'resultExpiredAt',
  'metadataExpiresAt',
]);

function operationError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function assertIdentifier(value, name = 'identifier') {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > IDENTIFIER_MAX_LENGTH
      || !IDENTIFIER_PATTERN.test(value)
      || value === '.'
      || value === '..') {
    throw operationError('identifier_invalid');
  }
  return value;
}

function assertOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw operationError('operation_id_invalid');
  }
  return value;
}

function assertResultHandle(value) {
  if (typeof value !== 'string' || !RESULT_HANDLE_PATTERN.test(value)) {
    throw operationError('result_handle_invalid');
  }
  return value;
}

function assertExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw operationError('version_invalid');
  return value;
}

function safeJsonClone(value, code = 'json_invalid') {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw operationError(code, error);
  }
}

function assertJsonObject(value, code) {
  const copy = safeJsonClone(value, code);
  if (!copy || Array.isArray(copy) || typeof copy !== 'object') throw operationError(code);
  return copy;
}

function assertBoundedString(
  value,
  code,
  { allowEmpty = false, maxLength = IDENTIFIER_MAX_LENGTH } = {},
) {
  if (typeof value !== 'string'
      || (!allowEmpty && value.length === 0)
      || value.length > maxLength
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw operationError(code);
  }
  return value;
}

function assertAbsoluteCanonicalPath(value, code = 'target_invalid') {
  if (typeof value !== 'string'
      || !path.isAbsolute(value)
      || value.length > 4096
      || value.includes('\0')
      || /[\u0000-\u001f\u007f]/.test(value)
      || path.normalize(value) !== value) {
    throw operationError(code);
  }
  return value;
}

function assertAbsoluteCanonicalRoot(value) {
  return assertAbsoluteCanonicalPath(value, 'target_invalid');
}

function buildBrainOperationIdempotencyKey(requesterAgent, requestId, operationType) {
  assertIdentifier(requesterAgent, 'requesterAgent');
  assertIdentifier(requestId, 'requestId');
  assertIdentifier(operationType, 'operationType');
  const digest = crypto.createHash('sha256')
    .update(requesterAgent, 'utf8')
    .update('\0', 'utf8')
    .update(requestId, 'utf8')
    .update('\0', 'utf8')
    .update(operationType, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function validateMutationBoundaries(rawBoundaries, canonicalRoot) {
  const code = 'target_invalid';
  assertAbsoluteCanonicalRoot(canonicalRoot);
  if (!Array.isArray(rawBoundaries) || rawBoundaries.length !== MUTATION_BOUNDARY_KINDS.length) {
    throw operationError(code);
  }
  const byKind = new Map();
  for (const boundary of rawBoundaries) {
    assertExactKeys(boundary, ['kind', 'path'], code);
    if (!MUTATION_BOUNDARY_KINDS.includes(boundary.kind) || byKind.has(boundary.kind)) {
      throw operationError(code);
    }
    const boundaryPath = assertAbsoluteCanonicalPath(boundary.path, code);
    byKind.set(boundary.kind, {
      kind: boundary.kind,
      path: boundaryPath,
    });
  }
  if (byKind.size !== MUTATION_BOUNDARY_KINDS.length) throw operationError(code);
  return MUTATION_BOUNDARY_KINDS.map((kind) => byKind.get(kind));
}

function validateTargetSnapshot(rawTarget, requesterAgent) {
  const code = 'target_invalid';
  try {
    const target = assertJsonObject(rawTarget, code);
    if (target.domain === 'brain') {
      assertExactKeys(target, [
        'domain', 'brainId', 'canonicalRoot', 'accessMode', 'ownerAgent', 'displayName',
        'kind', 'lifecycle', 'catalogRevision', 'route', 'mutationBoundaries',
      ], code);
      assertIdentifier(target.brainId, 'brainId');
      assertAbsoluteCanonicalRoot(target.canonicalRoot);
      if (!TARGET_ACCESS_MODES.has(target.accessMode)) throw operationError(code);
      if (target.ownerAgent !== null) assertIdentifier(target.ownerAgent, 'ownerAgent');
      assertBoundedString(target.displayName, code);
      if (!BRAIN_KINDS.has(target.kind) || !BRAIN_LIFECYCLES.has(target.lifecycle)) {
        throw operationError(code);
      }
      assertBoundedString(target.catalogRevision, code);
      assertAbsoluteCanonicalPath(target.route, code);
      return {
        domain: 'brain',
        brainId: target.brainId,
        canonicalRoot: target.canonicalRoot,
        accessMode: target.accessMode,
        ownerAgent: target.ownerAgent,
        displayName: target.displayName,
        kind: target.kind,
        lifecycle: target.lifecycle,
        catalogRevision: target.catalogRevision,
        route: target.route,
        mutationBoundaries: validateMutationBoundaries(
          target.mutationBoundaries,
          target.canonicalRoot,
        ),
      };
    }
    if (target.domain === 'owned-run') {
      assertExactKeys(target, [
        'domain', 'runId', 'canonicalRoot', 'ownerAgent', 'runState', 'catalogRevision',
        'route', 'mutationBoundaries',
      ], code);
      assertIdentifier(target.runId, 'runId');
      assertAbsoluteCanonicalRoot(target.canonicalRoot);
      assertIdentifier(target.ownerAgent, 'ownerAgent');
      if (!OWNED_RUN_STATES.has(target.runState)) throw operationError(code);
      assertBoundedString(target.catalogRevision, code);
      assertAbsoluteCanonicalPath(target.route, code);
      return {
        domain: 'owned-run',
        runId: target.runId,
        canonicalRoot: target.canonicalRoot,
        ownerAgent: target.ownerAgent,
        runState: target.runState,
        catalogRevision: target.catalogRevision,
        route: target.route,
        mutationBoundaries: validateMutationBoundaries(
          target.mutationBoundaries,
          target.canonicalRoot,
        ),
      };
    }
    if (target.domain === 'requester') {
      assertExactKeys(target, ['domain', 'requesterAgent'], code);
      assertIdentifier(target.requesterAgent, 'requesterAgent');
      if (target.requesterAgent !== requesterAgent) throw operationError(code);
      return { domain: 'requester', requesterAgent: target.requesterAgent };
    }
    throw operationError(code);
  } catch (error) {
    if (error?.code === code) throw error;
    throw operationError(code, error);
  }
}

function stableTargetIdentity(rawTarget, requesterAgent) {
  const target = validateTargetSnapshot(rawTarget, requesterAgent);
  if (target.domain === 'brain') {
    return {
      domain: 'brain',
      brainId: target.brainId,
      canonicalRoot: target.canonicalRoot,
      accessMode: target.accessMode,
    };
  }
  if (target.domain === 'owned-run') {
    return {
      domain: 'owned-run',
      runId: target.runId,
      canonicalRoot: target.canonicalRoot,
      ownerAgent: target.ownerAgent,
    };
  }
  return { domain: 'requester', requesterAgent: target.requesterAgent };
}

function buildRequestFingerprint(target, requestParameters, requesterAgent) {
  const stableTarget = stableTargetIdentity(target, requesterAgent);
  const normalized = assertJsonObject(requestParameters, 'request_parameters_invalid');
  try {
    return canonicalSha256({ target: stableTarget, requestParameters: normalized });
  } catch (error) {
    throw operationError('request_parameters_invalid', error);
  }
}

function assertExactKeys(value, expected, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw operationError(code);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || wanted.some((key, index) => keys[index] !== key)) {
    throw operationError(code);
  }
}

function validateBoundedJsonObject(value, code) {
  const copy = assertJsonObject(value, code);
  if (Buffer.byteLength(canonicalJson(copy), 'utf8') > BOUNDED_JSON_OBJECT_MAX_BYTES) {
    throw operationError(code);
  }
  return copy;
}

function validateResultObject(value) {
  return assertJsonObject(value, 'result_invalid');
}

function validateTransitionError(value, code = 'transition_invalid') {
  if (value === null) return null;
  try {
    const error = validateBoundedJsonObject(value, code);
    if (!Object.hasOwn(error, 'code')
        || !Object.hasOwn(error, 'message')
        || !Object.hasOwn(error, 'retryable')) {
      throw operationError(code);
    }
    assertIdentifier(error.code, 'errorCode');
    assertBoundedString(error.message, code, { maxLength: ERROR_MESSAGE_MAX_LENGTH });
    if (typeof error.retryable !== 'boolean') throw operationError(code);
    return error;
  } catch (error) {
    if (error?.code === code) throw error;
    throw operationError(code, error);
  }
}

function validateSourceEvidence(value, code = 'transition_invalid') {
  if (value === null) return null;
  return validateBoundedJsonObject(value, code);
}

function assertSafeNonnegative(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw operationError(code);
}

function assertSafePositive(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw operationError(code);
}

function assertGeneratedBasename(value, code) {
  assertBoundedString(value, code);
  if (!IDENTIFIER_PATTERN.test(value)
      || value === '.'
      || value === '..'
      || path.basename(value) !== value
      || value.includes('/')
      || value.includes('\\')) {
    throw operationError(code);
  }
}

function validateBaseFile(value, code) {
  assertExactKeys(value, ['file', 'count', 'bytes'], code);
  assertGeneratedBasename(value.file, code);
  assertSafeNonnegative(value.count, code);
  assertSafeNonnegative(value.bytes, code);
}

function validateSourcePinDescriptor(rawDescriptor, expectedCanonicalRoot) {
  const code = 'source_pin_invalid';
  const descriptor = assertJsonObject(rawDescriptor, code);
  assertExactKeys(descriptor, [
    'version', 'canonicalRoot', 'generation', 'baseRevision', 'cutoffRevision',
    'activeBase', 'activeDelta', 'summary',
  ], code);
  if (descriptor.version !== 1) throw operationError(code);
  assertBoundedString(descriptor.generation, code);
  if (!IDENTIFIER_PATTERN.test(descriptor.generation)) throw operationError(code);
  if (descriptor.canonicalRoot !== expectedCanonicalRoot) throw operationError(code);
  assertSafeNonnegative(descriptor.baseRevision, code);
  assertSafeNonnegative(descriptor.cutoffRevision, code);
  if (descriptor.cutoffRevision < descriptor.baseRevision
      || descriptor.baseRevision >= Number.MAX_SAFE_INTEGER) throw operationError(code);

  assertExactKeys(descriptor.activeBase, ['nodes', 'edges'], code);
  validateBaseFile(descriptor.activeBase.nodes, code);
  validateBaseFile(descriptor.activeBase.edges, code);

  assertExactKeys(descriptor.activeDelta, [
    'epoch', 'file', 'fromRevision', 'toRevision', 'count', 'committedBytes',
  ], code);
  if (typeof descriptor.activeDelta.epoch !== 'string'
      || !IDENTIFIER_PATTERN.test(descriptor.activeDelta.epoch)
      || descriptor.activeDelta.epoch === '.'
      || descriptor.activeDelta.epoch === '..') {
    throw operationError(code);
  }
  assertGeneratedBasename(descriptor.activeDelta.file, code);
  assertSafeNonnegative(descriptor.activeDelta.fromRevision, code);
  assertSafeNonnegative(descriptor.activeDelta.toRevision, code);
  assertSafeNonnegative(descriptor.activeDelta.count, code);
  assertSafeNonnegative(descriptor.activeDelta.committedBytes, code);
  if (descriptor.activeDelta.fromRevision !== descriptor.baseRevision + 1
      || descriptor.activeDelta.toRevision !== descriptor.cutoffRevision
      || descriptor.activeDelta.count !== descriptor.cutoffRevision - descriptor.baseRevision) {
    throw operationError(code);
  }

  assertExactKeys(descriptor.summary, ['nodeCount', 'edgeCount', 'clusterCount'], code);
  assertSafeNonnegative(descriptor.summary.nodeCount, code);
  assertSafeNonnegative(descriptor.summary.edgeCount, code);
  assertSafeNonnegative(descriptor.summary.clusterCount, code);
  return descriptor;
}

function validateSourcePin(rawDescriptor, digest, expectedCanonicalRoot) {
  const descriptor = validateSourcePinDescriptor(rawDescriptor, expectedCanonicalRoot);
  if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
    throw operationError('source_pin_invalid');
  }
  let calculated;
  try {
    calculated = canonicalSha256(descriptor);
  } catch (error) {
    throw operationError('source_pin_invalid', error);
  }
  const suppliedBytes = Buffer.from(digest.slice('sha256:'.length), 'hex');
  const calculatedBytes = Buffer.from(calculated.slice('sha256:'.length), 'hex');
  if (suppliedBytes.length !== calculatedBytes.length
      || !crypto.timingSafeEqual(suppliedBytes, calculatedBytes)) {
    throw operationError('source_pin_invalid');
  }
  return descriptor;
}

function validateCreateInput(rawInput, expectedRequester) {
  const input = assertJsonObject(rawInput, 'request_invalid');
  const allowed = new Set([
    'requestId', 'requesterAgent', 'target', 'operationType', 'requestParameters', 'parameters',
    'sourcePinDescriptor', 'sourcePinDigest', 'canonicalEvidence',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw operationError('request_invalid');
  }
  assertIdentifier(input.requestId, 'requestId');
  assertIdentifier(input.requesterAgent, 'requesterAgent');
  assertIdentifier(input.operationType, 'operationType');
  if (expectedRequester && input.requesterAgent !== expectedRequester) {
    throw operationError('requester_mismatch');
  }
  if (input.sourcePinDescriptor != null || input.sourcePinDigest != null) {
    throw operationError('source_pin_invalid');
  }
  const requestParameters = assertJsonObject(input.requestParameters, 'request_parameters_invalid');
  const parameters = assertJsonObject(input.parameters, 'parameters_invalid');
  const target = validateTargetSnapshot(input.target, input.requesterAgent);
  if (input.canonicalEvidence !== undefined && typeof input.canonicalEvidence !== 'boolean') {
    throw operationError('request_invalid');
  }
  const idempotencyKey = buildBrainOperationIdempotencyKey(
    input.requesterAgent,
    input.requestId,
    input.operationType,
  );
  const requestFingerprint = buildRequestFingerprint(
    target,
    requestParameters,
    input.requesterAgent,
  );
  return {
    requestId: input.requestId,
    requesterAgent: input.requesterAgent,
    operationType: input.operationType,
    target,
    requestParameters,
    parameters,
    canonicalEvidence: input.canonicalEvidence !== false,
    idempotencyKey,
    requestFingerprint,
  };
}

function assertTransition(from, to) {
  if (!EXECUTION_STATES.includes(to)) throw operationError('transition_invalid');
  if (TERMINAL_STATES.has(from)) throw operationError('operation_terminal');
  const valid = from === 'queued'
    ? to === 'running' || TERMINAL_STATES.has(to)
    : from === 'running' && TERMINAL_STATES.has(to);
  if (!valid) throw operationError('transition_invalid');
}

function projectPublicRecord(record) {
  const output = {};
  for (const field of PUBLIC_RECORD_FIELDS) output[field] = record[field] ?? null;
  return safeJsonClone(output, 'operation_corrupt');
}

module.exports = {
  ATTACHMENT_STATES,
  EXECUTION_STATES,
  IDENTIFIER_MAX_LENGTH,
  INLINE_RESULT_LIMIT_BYTES,
  OPERATION_EVENT_MAX_BYTES,
  OPERATION_EVENT_MAX_COUNT,
  OPERATION_ID_PATTERN,
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
  PUBLIC_RECORD_FIELDS,
  RESULT_HANDLE_PATTERN,
  SHA256_HEX_PATTERN,
  SHA256_PATTERN,
  TERMINAL_STATES,
  assertExpectedVersion,
  assertIdentifier,
  assertOperationId,
  assertResultHandle,
  assertTransition,
  buildBrainOperationIdempotencyKey,
  buildRequestFingerprint,
  operationError,
  projectPublicRecord,
  safeJsonClone,
  stableTargetIdentity,
  validateResultObject,
  validateSourceEvidence,
  validateTargetSnapshot,
  validateTransitionError,
  validateCreateInput,
  validateSourcePin,
};
