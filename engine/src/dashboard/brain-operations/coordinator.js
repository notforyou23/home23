'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  canonicalJson,
} = require('../../../../shared/brain-operations/canonical-json.cjs');
const {
  issueCapability,
} = require('../../../../shared/brain-operations/capability.cjs');
const {
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
  TERMINAL_STATES,
  assertIdentifier,
  assertOperationId,
  buildBrainOperationIdempotencyKey,
  operationError,
  safeJsonClone,
  validateSourcePin,
} = require('./operation-contract.js');
const {
  validateActiveProviderCalls,
  validateWorkerRecord,
  validateWorkerReference,
} = require('./worker-adapter.js');

let defaultAuthority = null;
try {
  defaultAuthority = require('../../../../shared/brain-operations/authority.cjs');
} catch {
  // Authority can be injected by focused foundation tests before the shared
  // module lands. Production construction fails closed if neither is present.
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_EVENT_SILENCE_MS = 60_000;
const CAPABILITY_TTL_MS = 60_000;
const MAX_ACTIVE_PROVIDER_CALLS = 4096;
const PROVIDER_OPERATION_TYPES = new Set(['query', 'pgs', 'synthesis', 'research_compile']);
const TERMINAL_WORKER_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const WORKER_RESULT_STATES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const WORKER_EVENT_TYPES = new Set([
  'event_gap', 'heartbeat', 'phase', 'progress', 'progress_update', 'provider_activity',
  'provider_call_terminal', 'provider_selected', 'terminal', 'token', 'token_estimate',
]);

const DEFAULT_EXECUTION_DEADLINES_MS = Object.freeze({
  search: 2 * HOUR_MS,
  graph: 2 * HOUR_MS,
  status: 2 * HOUR_MS,
  query: 2 * HOUR_MS,
  pgs: 8 * HOUR_MS,
  graph_export: 2 * HOUR_MS,
  synthesis: 8 * HOUR_MS,
  research_compile: 2 * HOUR_MS,
  research_launch: 2 * HOUR_MS,
  research_continue: 2 * HOUR_MS,
  research_stop: 2 * HOUR_MS,
  research_watch: 2 * HOUR_MS,
  research_intelligence: 2 * HOUR_MS,
  ad_hoc_export: 2 * HOUR_MS,
});

const CALLER_FORBIDDEN_PARAMETER_KEYS = new Set([
  'requesterAgent', 'idempotencyKey', 'canonicalEvidence', 'canonicalRoot',
  'accessMode', 'ownerAgent', 'lifecycle', 'runOwner', 'runOwnerAgent', 'policy',
  'sourcePinDescriptor', 'sourcePinDigest', 'lockRoot', 'projectionRoot',
  'operationRoot', 'operationPath', 'scratchDir', 'scratchPath', 'writeScope',
  'writes', 'mutationBoundaries', 'operationControl',
]);

const WORKER_EVIDENCE_FORBIDDEN_KEYS = new Set([
  'accessMode', 'brainId', 'canonicalRoot', 'capability', 'capabilityToken',
  'catalogRevision', 'lockRoot', 'mutationBoundaries', 'operationControl',
  'operationId', 'operationPath', 'operationRoot', 'operationType', 'ownerAgent',
  'projectionRoot', 'requester', 'requesterAgent', 'route', 'runId', 'runOwner',
  'runOwnerAgent', 'runState', 'scratchDir', 'scratchPath', 'selectedAgent',
  'selectedBrain', 'sourcePinDescriptor', 'sourcePinDigest', 'target',
  'targetBrainId', 'targetDomain', 'targetKind', 'targetLifecycle',
  'targetRequesterAgent', 'targetRunId', 'token', 'writeScope', 'writes',
]);

function coordinatorError(code, cause) {
  return operationError(code, cause);
}

function exactKeys(value, allowed, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw coordinatorError(code);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) throw coordinatorError(code);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value, code = 'invalid_request') {
  return safeJsonClone(value, code);
}

function sameJson(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function synthesisResultFromClaim(claim) {
  const { version, ...result } = claim;
  return result;
}

function synthesisStateMatchesClaim(state, claim) {
  const result = synthesisResultFromClaim(claim);
  return state?.operationId === result.operationId
    && state.generationMarker === result.generationMarker
    && state.generatedAt === result.generatedAt
    && state.sourceRevision === result.sourceRevision
    && state.provider === result.provider
    && state.model === result.model
    && state.brainStateSha256 === result.brainStateSha256;
}

function synthesisStateRelation(state, claim) {
  if (state === null) return 'missing';
  if (synthesisStateMatchesClaim(state, claim)) return 'match';
  if (state?.operationId !== claim.operationId) {
    const result = synthesisResultFromClaim(claim);
    const sameClaimPayload = state?.generationMarker === result.generationMarker
      && state.generatedAt === result.generatedAt
      && state.sourceRevision === result.sourceRevision
      && state.provider === result.provider
      && state.model === result.model
      && state.brainStateSha256 === result.brainStateSha256;
    return sameClaimPayload ? 'mismatch' : 'prior';
  }
  return 'mismatch';
}

function sanitizeErrorCode(value, fallback) {
  if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value)) {
    return value;
  }
  return fallback;
}

function typedErrorPayload(error, fallbackCode, retryable = true, extra = {}) {
  const code = sanitizeErrorCode(error?.code, fallbackCode);
  const rawMessage = typeof error?.message === 'string' && error.message
    ? error.message
    : code;
  const message = rawMessage.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 4096) || code;
  return {
    code,
    message,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : retryable,
    ...extra,
  };
}

function validateIsoDeadline(value) {
  if (typeof value !== 'string') throw coordinatorError('operation_recovery_invalid');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw coordinatorError('operation_recovery_invalid');
  }
  return milliseconds;
}

function validateSelectorForDomain(domain, selector) {
  if (domain === 'brain') {
    const value = selector === undefined ? {} : selector;
    exactKeys(value, ['agent', 'brainId']);
    if (value.agent !== undefined) assertIdentifier(value.agent, 'agent');
    if (value.brainId !== undefined) assertIdentifier(value.brainId, 'brainId');
    return clone(value);
  }
  if (domain === 'owned-run') {
    exactKeys(selector, ['runId']);
    assertIdentifier(selector.runId, 'runId');
    return { runId: selector.runId };
  }
  if (domain === 'requester') {
    if (selector !== undefined) throw coordinatorError('invalid_request');
    return undefined;
  }
  throw coordinatorError('operation_not_authorized');
}

function persistedSelectorMatches(record, selector) {
  const target = record.target;
  if (target.domain === 'brain') {
    if (selector === undefined || Object.keys(selector).length === 0) {
      return target.kind === 'resident'
        && target.ownerAgent === record.requesterAgent
        && target.accessMode === 'own';
    }
    if (selector.agent !== undefined
        && (target.kind !== 'resident' || selector.agent !== target.ownerAgent)) return false;
    if (selector.brainId !== undefined && selector.brainId !== target.brainId) return false;
    return true;
  }
  if (target.domain === 'owned-run') {
    return selector !== undefined
      && Object.keys(selector).length === 1
      && selector.runId === target.runId;
  }
  return selector === undefined;
}

function brainTargetSnapshot(context) {
  const entry = context.target;
  return {
    domain: 'brain',
    brainId: entry.id,
    canonicalRoot: entry.canonicalRoot,
    accessMode: context.accessMode,
    ownerAgent: entry.ownerAgent ?? null,
    displayName: entry.displayName,
    kind: entry.kind,
    lifecycle: entry.lifecycle,
    catalogRevision: context.catalogRevision,
    route: entry.route,
    mutationBoundaries: clone(entry.mutationBoundaries, 'target_invalid'),
  };
}

function sanitizeWorkerEvidenceValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeWorkerEvidenceValue);
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    if (WORKER_EVIDENCE_FORBIDDEN_KEYS.has(key)) continue;
    sanitized[key] = sanitizeWorkerEvidenceValue(child);
  }
  return sanitized;
}

function containsForbiddenWorkerEvidenceKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenWorkerEvidenceKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    WORKER_EVIDENCE_FORBIDDEN_KEYS.has(key) || containsForbiddenWorkerEvidenceKey(child));
}

function validateCoordinatorWorkerEvent(rawEvent, operationId, afterSequence) {
  const event = clone(rawEvent, 'worker_event_invalid');
  if (!event || Array.isArray(event) || typeof event !== 'object'
      || event.operationId !== operationId
      || !Number.isSafeInteger(event.eventSequence)
      || event.eventSequence <= afterSequence
      || !WORKER_EVENT_TYPES.has(event.type)
      || Object.hasOwn(event, 'sequence')) {
    throw coordinatorError('worker_event_invalid');
  }
  const payload = { ...event };
  delete payload.operationId;
  delete payload.eventSequence;
  delete payload.type;
  if (event.type === 'event_gap') delete payload.currentStatus;
  if (containsForbiddenWorkerEvidenceKey(payload)) throw coordinatorError('worker_event_invalid');
  if (event.type !== 'terminal' && Object.hasOwn(event, 'state')) {
    throw coordinatorError('worker_event_invalid');
  }
  if (event.type === 'terminal' && !TERMINAL_WORKER_STATES.has(event.state)) {
    throw coordinatorError('worker_event_invalid');
  }
  if (event.type === 'phase') {
    try { assertIdentifier(event.phase, 'phase'); } catch (error) {
      throw coordinatorError('worker_event_invalid', error);
    }
  }
  if (event.type === 'event_gap') {
    if (!Number.isSafeInteger(event.oldestSequence) || event.oldestSequence <= 0
        || !Number.isSafeInteger(event.latestSequence)
        || event.latestSequence < event.oldestSequence
        || event.eventSequence < event.latestSequence) {
      throw coordinatorError('worker_event_invalid');
    }
  }
  return event;
}

function enrichSourceEvidence(record, workerEvidence = {}) {
  const evidence = workerEvidence === null
    ? {}
    : sanitizeWorkerEvidenceValue(clone(workerEvidence, 'worker_result_invalid'));
  const base = {
    ...evidence,
    requesterAgent: record.requesterAgent,
    operationId: record.operationId,
    operationType: record.operationType,
    targetDomain: record.target.domain,
  };
  if (record.target.domain === 'brain') {
    return deepFreeze({
      ...base,
      selectedAgent: record.target.ownerAgent,
      selectedBrain: record.target.brainId,
      route: record.target.route,
      targetKind: record.target.kind,
      targetLifecycle: record.target.lifecycle,
      catalogRevision: record.target.catalogRevision,
      accessMode: record.target.accessMode,
    });
  }
  if (record.target.domain === 'owned-run') {
    return deepFreeze({
      ...base,
      runId: record.target.runId,
      runOwnerAgent: record.target.ownerAgent,
      runState: record.target.runState,
      route: record.target.route,
      catalogRevision: record.target.catalogRevision,
    });
  }
  return deepFreeze({ ...base, selectedAgent: record.requesterAgent });
}

function validateResultEnvelope(rawEnvelope) {
  const envelope = clone(rawEnvelope, 'worker_result_invalid');
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') {
    throw coordinatorError('worker_result_invalid');
  }
  const allowed = new Set(['state', 'result', 'resultArtifact', 'error', 'sourceEvidence']);
  if (Reflect.ownKeys(envelope).some((key) => typeof key !== 'string' || !allowed.has(key))
      || !Object.hasOwn(envelope, 'state')
      || !Object.hasOwn(envelope, 'result')
      || !Object.hasOwn(envelope, 'error')
      || !Object.hasOwn(envelope, 'sourceEvidence')) {
    throw coordinatorError('worker_result_invalid');
  }
  if (!WORKER_RESULT_STATES.has(envelope.state)) throw coordinatorError('worker_result_invalid');
  if (envelope.result !== null
      && (!envelope.result || Array.isArray(envelope.result) || typeof envelope.result !== 'object')) {
    throw coordinatorError('worker_result_invalid');
  }
  if (envelope.resultArtifact !== undefined && envelope.resultArtifact !== null
      && envelope.result !== null) {
    throw coordinatorError('worker_result_invalid');
  }
  return envelope;
}

function validateArtifactEnvelope(operationType, rawArtifact) {
  const code = 'worker_result_invalid';
  if (operationType !== 'graph_export') throw coordinatorError(code);
  const artifact = clone(rawArtifact, code);
  exactKeys(artifact, ['scratchPath', 'mediaType', 'contentEncoding', 'bytes', 'sha256'], code);
  if (typeof artifact.scratchPath !== 'string'
      || !path.isAbsolute(artifact.scratchPath)
      || path.normalize(artifact.scratchPath) !== artifact.scratchPath
      || artifact.mediaType !== 'application/x-ndjson'
      || artifact.contentEncoding !== 'identity'
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || artifact.bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw coordinatorError(code);
  }
  return artifact;
}

function validateScratchQuotaHandle(handle, required) {
  if (handle === null) {
    if (required) throw coordinatorError('source_context_invalid');
    return null;
  }
  if (!handle || Array.isArray(handle) || typeof handle !== 'object') {
    throw coordinatorError('source_context_invalid');
  }
  for (const method of ['claim', 'release', 'reconcile', 'assertOperationRoot', 'close']) {
    if (typeof handle[method] !== 'function') throw coordinatorError('source_context_invalid');
  }
  return handle;
}

function validatePinnedSourceHandle(handle, record) {
  if (!handle || Array.isArray(handle) || typeof handle !== 'object'
      || handle.revision !== record.sourcePinDescriptor.cutoffRevision
      || !sameJson(handle.descriptor, record.sourcePinDescriptor)
      || !handle.evidence || Array.isArray(handle.evidence) || typeof handle.evidence !== 'object') {
    throw coordinatorError('source_context_invalid');
  }
  for (const method of [
    'iterateNodes', 'iterateEdges', 'summarize', 'searchKeyword', 'getEvidence',
    'isCurrent', 'compareAndSwap', 'release',
  ]) {
    if (typeof handle[method] !== 'function') throw coordinatorError('source_context_invalid');
  }
  return handle;
}

class BrainOperationCoordinator {
  constructor(options = {}) {
    if (!options || Array.isArray(options) || typeof options !== 'object') {
      throw coordinatorError('coordinator_configuration_invalid');
    }
    assertIdentifier(options.requesterAgent, 'requesterAgent');
    if (!options.store || typeof options.store !== 'object'
        || typeof options.buildCanonicalCatalog !== 'function'
        || typeof options.resolveCanonicalTarget !== 'function'
        || !options.worker || typeof options.worker !== 'object') {
      throw coordinatorError('coordinator_configuration_invalid');
    }
    this.requesterAgent = options.requesterAgent;
    this.store = options.store;
    this.buildCanonicalCatalog = options.buildCanonicalCatalog;
    this.resolveCanonicalTarget = options.resolveCanonicalTarget;
    this.resolveOwnedRunTarget = options.resolveOwnedRunTarget ?? null;
    this.operationAuthority = options.operationAuthority ?? defaultAuthority?.OPERATION_AUTHORITY ?? null;
    this.authorizeBrainOperation = options.authorizeBrainOperation
      ?? defaultAuthority?.authorizeBrainOperation
      ?? null;
    if (!this.operationAuthority || typeof this.authorizeBrainOperation !== 'function') {
      throw coordinatorError('coordinator_configuration_invalid');
    }
    this.worker = options.worker;
    this.sourcePins = options.sourcePins ?? null;
    this.scratchQuotaFactory = options.scratchQuotaFactory ?? null;
    this.operationModelResolver = options.operationModelResolver ?? null;
    this.exporter = options.exporter ?? null;
    this.readSynthesisState = typeof options.readSynthesisState === 'function'
      ? options.readSynthesisState
      : null;
    this.now = typeof options.clock?.now === 'function' ? options.clock.now : Date.now;
    this.setTimeout = typeof options.timers?.setTimeout === 'function'
      ? options.timers.setTimeout
      : setTimeout;
    this.clearTimeout = typeof options.timers?.clearTimeout === 'function'
      ? options.timers.clearTimeout
      : clearTimeout;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.capabilityKey = options.capabilityKey ?? process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY;
    this.injectedCapabilityIssuer = typeof options.capabilityIssuer === 'function'
      ? options.capabilityIssuer
      : null;
    this.heartbeatMs = options.limits?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.eventSilenceMs = options.limits?.eventSilenceMs ?? DEFAULT_EVENT_SILENCE_MS;
    this.workerControlTimeoutMs = options.limits?.workerControlTimeoutMs
      ?? DEFAULT_EVENT_SILENCE_MS;
    this.stopTimeoutMs = options.limits?.stopTimeoutMs ?? Math.min(DEFAULT_EVENT_SILENCE_MS, 1_000);
    this.executionDeadlineMsByType = Object.freeze({
      ...DEFAULT_EXECUTION_DEADLINES_MS,
      ...(options.limits?.executionDeadlineMsByType || {}),
    });
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs <= 0
        || !Number.isFinite(this.eventSilenceMs) || this.eventSilenceMs <= 0
        || !Number.isFinite(this.workerControlTimeoutMs) || this.workerControlTimeoutMs <= 0
        || !Number.isFinite(this.stopTimeoutMs) || this.stopTimeoutMs <= 0) {
      throw coordinatorError('coordinator_configuration_invalid');
    }
    for (const operationType of Object.keys(this.operationAuthority)) {
      const deadline = this.executionDeadlineMsByType[operationType];
      if (!Number.isFinite(deadline) || deadline <= 0) {
        throw coordinatorError('coordinator_configuration_invalid');
      }
    }
    this.operationQueues = new Map();
    this.runtimes = new Map();
    this.stopped = false;
  }

  async _enqueue(operationId, callback) {
    const prior = this.operationQueues.get(operationId) || Promise.resolve();
    const current = prior.catch(() => {}).then(callback);
    this.operationQueues.set(operationId, current);
    try {
      return await current;
    } finally {
      if (this.operationQueues.get(operationId) === current) this.operationQueues.delete(operationId);
    }
  }

  _policy(operationType) {
    const policy = this.operationAuthority[operationType];
    if (!policy) throw coordinatorError('operation_not_authorized');
    return policy;
  }

  _sourceOperationsReady(operationType) {
    const workerReady = typeof this.worker.supportsSourceOperation === 'function'
      ? this.worker.supportsSourceOperation(operationType) === true
      : this.worker.supportsSourceOperations === true;
    const sourceAndQuotaReady = this.sourcePins
      && typeof this.sourcePins.pin === 'function'
      && typeof this.sourcePins.openPinnedSource === 'function'
      && typeof this.sourcePins.releaseOperationPins === 'function'
      && typeof this.scratchQuotaFactory === 'function'
      && workerReady;
    return sourceAndQuotaReady
      && (!PROVIDER_OPERATION_TYPES.has(operationType)
        || typeof this.operationModelResolver === 'function');
  }

  _normalizeStartInput(rawInput) {
    exactKeys(rawInput, ['requestId', 'operationType', 'target', 'parameters']);
    assertIdentifier(rawInput.requestId, 'requestId');
    assertIdentifier(rawInput.operationType, 'operationType');
    let operationType = rawInput.operationType;
    const parameters = clone(rawInput.parameters, 'invalid_request');
    if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') {
      throw coordinatorError('invalid_request');
    }
    for (const key of Object.keys(parameters)) {
      if (CALLER_FORBIDDEN_PARAMETER_KEYS.has(key)) throw coordinatorError('invalid_request');
    }
    if (Object.hasOwn(parameters, 'enablePGS')) {
      if (operationType === 'query' && parameters.enablePGS === true) {
        operationType = 'pgs';
        delete parameters.enablePGS;
      } else {
        throw coordinatorError('invalid_request');
      }
    }
    if (operationType === 'synthesis') {
      for (const key of ['provider', 'providerId', 'model', 'modelId', 'modelSelection', 'pgsSweep', 'pgsSynth']) {
        if (Object.hasOwn(parameters, key)) throw coordinatorError('invalid_request');
      }
    }
    const policy = this._policy(operationType);
    const target = validateSelectorForDomain(policy.domain, rawInput.target);
    return {
      requestId: rawInput.requestId,
      operationType,
      target,
      requestParameters: parameters,
      policy,
    };
  }

  async resolveTargetContext(selector = {}) {
    const catalog = await this.buildCanonicalCatalog();
    const selected = this.resolveCanonicalTarget(catalog, this.requesterAgent, selector);
    const accessMode = selected.kind === 'resident'
      && selected.lifecycle === 'resident'
      && selected.ownerAgent === this.requesterAgent
      ? 'own'
      : 'read-only';
    return deepFreeze(clone({
      catalogRevision: catalog.catalogRevision,
      target: selected,
      accessMode,
    }, 'catalog_unavailable'));
  }

  async _resolveTarget(normalized) {
    if (normalized.policy.domain === 'brain') {
      return brainTargetSnapshot(await this.resolveTargetContext(normalized.target));
    }
    if (normalized.policy.domain === 'owned-run') {
      if (typeof this.resolveOwnedRunTarget !== 'function') {
        throw coordinatorError('target_not_available');
      }
      const target = await this.resolveOwnedRunTarget({ runId: normalized.target.runId });
      if (!target || target.domain !== 'owned-run' || target.runId !== normalized.target.runId) {
        throw coordinatorError('target_not_available');
      }
      return clone(target, 'target_invalid');
    }
    return { domain: 'requester', requesterAgent: this.requesterAgent };
  }

  _matchesExisting(record, normalized) {
    return record.requesterAgent === this.requesterAgent
      && record.operationType === normalized.operationType
      && sameJson(record.requestParameters, normalized.requestParameters)
      && persistedSelectorMatches(record, normalized.target);
  }

  async _resolveExecutorParameters(normalized, target) {
    let parameters = clone(normalized.requestParameters, 'invalid_request');
    if (PROVIDER_OPERATION_TYPES.has(normalized.operationType)) {
      if (typeof this.operationModelResolver !== 'function') {
        throw coordinatorError('source_operations_unavailable');
      }
      parameters = await this.operationModelResolver({
        requesterAgent: this.requesterAgent,
        operationType: normalized.operationType,
        target: clone(target),
        requestParameters: clone(normalized.requestParameters),
      });
      parameters = clone(parameters, 'parameters_invalid');
    }
    const deadlineMs = this.executionDeadlineMsByType[normalized.operationType];
    return {
      ...parameters,
      operationControl: {
        hardDeadlineAt: new Date(this.now() + deadlineMs).toISOString(),
      },
    };
  }

  _capabilityClaims(record) {
    const target = record.target;
    const issuedAt = this.now();
    const nonceBytes = this.randomBytes(24);
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 24) {
      throw coordinatorError('capability_unavailable');
    }
    return {
      requesterAgent: record.requesterAgent,
      targetDomain: target.domain,
      targetBrainId: target.domain === 'brain' ? target.brainId : null,
      targetRunId: target.domain === 'owned-run' ? target.runId : null,
      targetRequesterAgent: target.domain === 'requester' ? target.requesterAgent : null,
      canonicalRoot: target.domain === 'requester' ? null : target.canonicalRoot,
      accessMode: target.domain === 'brain' ? target.accessMode : 'own',
      operationType: record.operationType,
      operationId: record.operationId,
      sourcePinDigest: record.sourcePinDigest,
      issuedAt,
      expiresAt: issuedAt + CAPABILITY_TTL_MS,
      nonce: nonceBytes.toString('base64url'),
    };
  }

  _issueCapability(record, purpose) {
    const claims = this._capabilityClaims(record);
    if (this.injectedCapabilityIssuer) {
      return this.injectedCapabilityIssuer({
        record: clone(record),
        operationId: record.operationId,
        purpose,
        claims,
      });
    }
    return issueCapability(this.capabilityKey, claims);
  }

  async _boundedWorkerControl(callback) {
    let timer = null;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          if (timer) this.clearTimeout(timer);
          handler(value);
        };
        timer = this.setTimeout(() => {
          finish(reject, coordinatorError('worker_control_timeout'));
        }, this.workerControlTimeoutMs);
        Promise.resolve()
          .then(callback)
          .then((value) => finish(resolve, value), (error) => finish(reject, error));
      });
    } finally {
      if (timer) this.clearTimeout(timer);
    }
  }

  async _authenticatedWorkerStatus(record, options = {}) {
    const capability = this._issueCapability(record, 'status');
    const rawWorkerRecord = await this._boundedWorkerControl(() =>
      this.worker.status(record.operationId, capability));
    try {
      validateActiveProviderCalls(rawWorkerRecord?.activeProviderCalls);
    } catch (error) {
      throw coordinatorError('provider_contract_invalid', error);
    }
    const workerRecord = validateWorkerRecord(rawWorkerRecord, {
      operationId: record.operationId,
      operationType: record.operationType,
    });
    if (TERMINAL_WORKER_STATES.has(workerRecord.state)
        && workerRecord.activeProviderCalls.length > 0) {
      throw coordinatorError('provider_contract_invalid');
    }
    const persistedReference = options.expectedReference
      ?? await this.store.getWorker(record.operationId);
    if (persistedReference === null) {
      if (options.allowUnassigned !== true) throw coordinatorError('worker_contract_invalid');
    } else {
      validateWorkerReference(persistedReference, { operationType: record.operationType });
      if (!sameJson(workerRecord.reference, persistedReference)) {
        throw coordinatorError('worker_contract_invalid');
      }
    }
    const minimum = options.minimumEventSequence ?? 0;
    if (!Number.isSafeInteger(minimum) || minimum < 0
        || workerRecord.eventSequence < minimum) {
      throw coordinatorError('worker_contract_invalid');
    }
    return workerRecord;
  }

  _ensureRuntime(record) {
    let runtime = this.runtimes.get(record.operationId);
    if (!runtime) {
      runtime = {
        operationId: record.operationId,
        heartbeatTimer: null,
        hardDeadlineTimer: null,
        silenceTimer: null,
        streamController: null,
        pumpPromise: null,
        workerCursor: 0,
        providerSnapshotThrough: null,
        providerCalls: new Map(),
        attachments: new Map(),
        stopped: false,
      };
      this.runtimes.set(record.operationId, runtime);
    }
    this._armHeartbeat(record, runtime);
    this._armHardDeadline(record, runtime);
    return runtime;
  }

  _armHeartbeat(record, runtime) {
    if (runtime.heartbeatTimer || runtime.stopped || TERMINAL_STATES.has(record.state) || this.stopped) return;
    runtime.heartbeatTimer = this.setTimeout(async () => {
      runtime.heartbeatTimer = null;
      try {
        await this._enqueue(record.operationId, async () => {
          if (runtime.stopped || this.stopped || this.runtimes.get(record.operationId) !== runtime) return;
          const current = await this.store.get(record.operationId).catch(() => null);
          if (!current || TERMINAL_STATES.has(current.state)) return;
          const next = await this.store.appendEvent(record.operationId, { type: 'heartbeat' });
          await this._broadcastNewEvents(runtime, current.eventSequence);
          this._armHeartbeat(next, runtime);
        });
      } catch (error) {
        await this._handleTimerFailure(record.operationId, runtime, error);
      }
    }, this.heartbeatMs);
  }

  async _handleTimerFailure(operationId, runtime, error) {
    if (this.stopped || runtime.stopped || this.runtimes.get(operationId) !== runtime) return;
    await this._enqueue(operationId, async () => {
      if (this.stopped || runtime.stopped || this.runtimes.get(operationId) !== runtime) return;
      const current = await this.store.get(operationId).catch(() => null);
      if (!current) return;
      if (TERMINAL_STATES.has(current.state)) {
        await this._afterTerminalLocked(current).catch(() => {});
        return;
      }
      await this._failLocked(operationId, {
        state: 'failed',
        code: 'timer_callback_failed',
        message: error?.message || 'operation timer callback failed',
        retryable: true,
        cancelWorker: true,
      });
    }).catch(() => {});
  }

  _hardDeadline(record) {
    const control = record.parameters?.operationControl;
    if (!control || Object.keys(control).length !== 1) {
      throw coordinatorError('operation_recovery_invalid');
    }
    return validateIsoDeadline(control.hardDeadlineAt);
  }

  _armHardDeadline(record, runtime) {
    if (runtime.hardDeadlineTimer || runtime.stopped || TERMINAL_STATES.has(record.state) || this.stopped) return;
    const deadlineAt = this._hardDeadline(record);
    const delay = Math.max(0, deadlineAt - this.now());
    runtime.hardDeadlineTimer = this.setTimeout(async () => {
      runtime.hardDeadlineTimer = null;
      try {
        await this._enqueue(record.operationId, async () => {
          if (runtime.stopped || this.stopped || this.runtimes.get(record.operationId) !== runtime) return;
          return this._failLocked(record.operationId, {
            state: 'failed',
            code: 'operation_timeout',
            message: 'operation execution deadline elapsed',
            retryable: true,
            cancelWorker: true,
          });
        });
      } catch (error) {
        await this._handleTimerFailure(record.operationId, runtime, error);
      }
    }, delay);
  }

  async _pinRecord(record) {
    if (record.sourcePinDescriptor !== null || record.sourcePinDigest !== null) return record;
    const pinned = await this.sourcePins.pin(record.target.canonicalRoot, record.operationId);
    const descriptor = validateSourcePin(
      pinned?.descriptor,
      pinned?.digest,
      record.target.canonicalRoot,
    );
    try {
      return await this.store.attachSourcePin(record.operationId, {
        expectedVersion: record.recordVersion,
        descriptor,
        digest: pinned.digest,
      });
    } catch (error) {
      const published = await this.store.get(record.operationId).catch(() => null);
      if (published
          && published.sourcePinDigest === pinned.digest
          && sameJson(published.sourcePinDescriptor, descriptor)) {
        return published;
      }
      await this.sourcePins.releaseOperationPins(record.operationId).catch(() => {});
      throw error;
    }
  }

  async _buildWorkerContext(record) {
    const scratchDir = await this.store.ensureScratchDirectory(record.operationId);
    const policy = this._policy(record.operationType);
    let scratchQuota = null;
    let sourcePin = null;
    try {
      const rawScratchQuota = typeof this.scratchQuotaFactory === 'function'
        ? await this.scratchQuotaFactory({
        operationId: record.operationId,
        operationRoot: path.dirname(scratchDir),
        scratchDir,
      })
        : null;
      scratchQuota = rawScratchQuota;
      validateScratchQuotaHandle(scratchQuota, policy.requiresSourcePin);
      const localSource = typeof this.worker.usesLocalExecutor !== 'function'
        || this.worker.usesLocalExecutor(record.operationType);
      const localExecutor = typeof this.worker.usesLocalExecutor === 'function'
        && this.worker.usesLocalExecutor(record.operationType);
      if (policy.requiresSourcePin && localSource) {
        sourcePin = await this.sourcePins.openPinnedSource(record.sourcePinDescriptor, {
            requesterAgent: record.requesterAgent,
            operationId: record.operationId,
            operationType: record.operationType,
            operationRoot: path.dirname(scratchDir),
            scratchQuota,
            expectedCanonicalRoot: record.target.canonicalRoot,
            expectedDigest: record.sourcePinDigest,
            expectedRevision: record.sourcePinDescriptor.cutoffRevision,
          });
        validatePinnedSourceHandle(sourcePin, record);
      }
      const parameters = clone(record.parameters, 'operation_corrupt');
      const operationControl = parameters.operationControl;
      delete parameters.operationControl;
      return {
        operationId: record.operationId,
        operationType: record.operationType,
        requesterAgent: record.requesterAgent,
        target: clone(record.target),
        parameters,
        operationControl: clone(operationControl),
        scratchDir,
        scratchQuota,
        sourcePin,
        sourcePinDescriptor: record.sourcePinDescriptor,
        sourcePinDigest: record.sourcePinDigest,
        ...(record.operationType === 'synthesis' && localExecutor ? {
          claimSynthesisCompletion: (claim) =>
            this.store.claimSynthesisCompletion(record.operationId, claim),
        } : {}),
      };
    } catch (error) {
      try {
        await sourcePin?.release?.();
      } finally {
        await scratchQuota?.close?.();
      }
      throw error;
    }
  }

  async _persistWorkerReference(record, workerRecord) {
    const intended = validateWorkerReference(workerRecord.reference, {
      operationType: record.operationType,
    });
    try {
      return await this.store.setWorker(record.operationId, {
        expectedVersion: record.recordVersion,
        worker: intended,
      });
    } catch (error) {
      const published = await this.store.getWorker(record.operationId).catch(() => null);
      if (published && sameJson(published, intended)) return this.store.get(record.operationId);
      throw error;
    }
  }

  async _startWorker(record) {
    const workerRecord = await this._requestWorkerStart(record);
    return this._publishStartedWorkerLocked(record, workerRecord);
  }

  async _requestWorkerStart(record) {
    const context = await this._buildWorkerContext(record);
    const capability = this._issueCapability(record, 'start');
    return validateWorkerRecord(
      await this._boundedWorkerControl(() => this.worker.start(context, capability)),
      { operationId: record.operationId, operationType: record.operationType },
    );
  }

  async _publishStartedWorkerLocked(record, workerRecord) {
    let current = await this.store.get(record.operationId);
    if (TERMINAL_STATES.has(current.state)) {
      void this._cancelWorker(current).catch(() => {});
      return current;
    }
    const existingWorker = await this.store.getWorker(record.operationId);
    if (existingWorker === null) current = await this._persistWorkerReference(current, workerRecord);
    else if (!sameJson(existingWorker, workerRecord.reference)) {
      throw coordinatorError('worker_conflict');
    }
    if (TERMINAL_WORKER_STATES.has(workerRecord.state)) {
      return this._finalizeFromWorkerLocked(current.operationId, workerRecord);
    }
    if (current.state === 'queued') {
      current = await this.store.transition(current.operationId, {
        expectedVersion: current.recordVersion,
        state: 'running',
        phase: workerRecord.phase,
        error: null,
        sourceEvidence: null,
      });
    }
    const runtime = this._ensureRuntime(current);
    // Initial start replays the worker journal from zero. Active-call snapshots
    // are a restart/reconnect recovery seam; arming them here would make their
    // corresponding provider_selected events look like duplicate selections.
    this._startEventPump(current, runtime, 0);
    return current;
  }

  async _probeUncertainStartLocked(record) {
    const current = await this.store.get(record.operationId);
    let workerRecord;
    try {
      workerRecord = await this._authenticatedWorkerStatus(current, { allowUnassigned: true });
    } catch (error) {
      if (error?.code === 'worker_not_found') return null;
      throw error;
    }
    return this._publishStartedWorkerLocked(current, workerRecord);
  }

  async start(rawInput) {
    if (this.stopped) throw coordinatorError('coordinator_stopped');
    const normalized = this._normalizeStartInput(rawInput);
    const idempotencyKey = buildBrainOperationIdempotencyKey(
      this.requesterAgent,
      normalized.requestId,
      normalized.operationType,
    );
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (!this._matchesExisting(existing, normalized)) throw coordinatorError('idempotency_conflict');
      return existing;
    }
    if (normalized.policy.requiresSourcePin
        && !this._sourceOperationsReady(normalized.operationType)) {
      throw coordinatorError('source_operations_unavailable');
    }
    const target = await this._resolveTarget(normalized);
    const policy = this.authorizeBrainOperation({
      requesterAgent: this.requesterAgent,
      operationType: normalized.operationType,
      target: clone(target),
    });
    const parameters = await this._resolveExecutorParameters(normalized, target);
    const created = await this.store.create({
      requestId: normalized.requestId,
      requesterAgent: this.requesterAgent,
      target,
      operationType: normalized.operationType,
      requestParameters: normalized.requestParameters,
      parameters,
      sourcePinDescriptor: null,
      sourcePinDigest: null,
      canonicalEvidence: policy.canonicalEvidence !== false,
    });
    if (!created.created) return created.record;
    let record = created.record;
    this._ensureRuntime(record);
    try {
      record = await this._enqueue(record.operationId, async () => {
        const current = await this.store.get(record.operationId);
        if (TERMINAL_STATES.has(current.state)) return current;
        return policy.requiresSourcePin ? this._pinRecord(current) : current;
      });
    } catch (error) {
      await this._enqueue(record.operationId, async () => {
        const current = await this.store.get(record.operationId);
        if (TERMINAL_STATES.has(current.state)) return current;
        return this._failLocked(record.operationId, {
          state: 'failed',
          code: sanitizeErrorCode(error?.code, 'worker_start_failed'),
          message: error?.message || 'worker start failed',
          retryable: error?.retryable !== false,
          cancelWorker: false,
        });
      }).catch(() => {});
      throw error;
    }
    if (TERMINAL_STATES.has(record.state)) return record;

    let workerRecord;
    try {
      workerRecord = await this._requestWorkerStart(record);
    } catch (error) {
      return this._enqueue(record.operationId, async () => {
        const current = await this.store.get(record.operationId);
        if (TERMINAL_STATES.has(current.state)) return current;
        try {
          const recovered = await this._probeUncertainStartLocked(current);
          if (recovered) return recovered;
        } catch (probeError) {
          if (probeError?.code !== 'worker_not_found') {
            // A status transport/authentication failure cannot prove that the
            // worker is absent. Leave queued durable truth for reconciliation.
            throw error;
          }
        }
        const persistedWorker = await this.store.getWorker(record.operationId).catch(() => null);
        await this._failLocked(record.operationId, {
          state: 'failed',
          code: sanitizeErrorCode(error?.code, 'worker_start_failed'),
          message: error?.message || 'worker start failed',
          retryable: error?.retryable !== false,
          cancelWorker: persistedWorker !== null,
        });
        throw error;
      });
    }
    return this._enqueue(record.operationId, () =>
      this._publishStartedWorkerLocked(record, workerRecord));
  }

  async status(operationId) {
    assertOperationId(operationId);
    return this._enqueue(operationId, async () => {
      let record = await this.store.get(operationId);
      if (record.requesterAgent !== this.requesterAgent) throw coordinatorError('access_denied');
      if (!TERMINAL_STATES.has(record.state) && await this.store.getWorker(operationId)) {
        try {
          const workerRecord = await this._authenticatedWorkerStatus(record, {
            minimumEventSequence: this.runtimes.get(operationId)?.workerCursor ?? 0,
          });
          if (TERMINAL_WORKER_STATES.has(workerRecord.state)) {
            record = await this._finalizeFromWorkerLocked(operationId, workerRecord);
          }
        } catch (error) {
          if (error?.code === 'worker_contract_invalid'
              || error?.code === 'provider_contract_invalid') {
            record = await this._failLocked(operationId, {
              state: 'failed',
              code: error.code,
              message: 'worker status did not match durable worker identity',
              retryable: true,
              cancelWorker: true,
            });
          } else if (error?.code !== 'worker_not_found') {
            throw error;
          }
        }
      }
      return record;
    });
  }

  async listNonterminal() {
    return (await this.store.listNonterminal())
      .filter((record) => record.requesterAgent === this.requesterAgent);
  }

  _attachmentResult(runtime, attachmentId, attachment, afterSequence) {
    const queue = [];
    const waiting = [];
    const finished = deferredPromise();
    const subscriber = {
      attachment,
      queue,
      waiting,
      finished,
      onEvent: null,
      signalHandler: null,
      signal: null,
      cursor: afterSequence,
      terminalReplayThrough: null,
    };
    runtime.attachments.set(attachmentId, subscriber);
    return {
      ...attachment,
      done: finished.promise,
      nextEvent: () => this._nextAttachmentEvent(runtime, subscriber),
      _subscriber: subscriber,
    };
  }

  _terminalReplayAttachment(record, input, rows) {
    const events = [];
    let cursor = input.afterSequence ?? 0;
    for (const row of rows) {
      let event;
      let nextCursor;
      if (row.type === 'event_gap' && Number.isSafeInteger(row.sequence)) {
        // A worker-gap evidence marker is durable coordinator journal truth,
        // not a dashboard transport gap. Advance past it without exposing a
        // malformed cross-sequence-domain gap to the requester stream.
        if (row.sequence > cursor) cursor = row.sequence;
        continue;
      }
      if (row.type === 'event_gap') {
        if (!Number.isSafeInteger(row.latestSequence) || row.latestSequence < cursor) {
          throw coordinatorError('event_stream_invalid');
        }
        event = Object.freeze({ ...row, eventSequence: row.latestSequence });
        nextCursor = row.latestSequence;
      } else {
        if (!Number.isSafeInteger(row.sequence)) throw coordinatorError('event_stream_invalid');
        if (row.sequence <= cursor) continue;
        event = Object.freeze({ ...row, eventSequence: row.sequence });
        nextCursor = row.sequence;
      }
      cursor = nextCursor;
      events.push(event);
    }
    const closedAt = record.completedAt || record.updatedAt;
    const outcome = Object.freeze({
      attachmentId: input.attachmentId,
      operationId: record.operationId,
      requesterAgent: record.requesterAgent,
      state: 'closed',
      openedAt: closedAt,
      updatedAt: closedAt,
      detachedAt: null,
      closedAt,
      reason: 'operation_terminal',
    });
    const finished = deferredPromise();
    let signalHandler = null;
    const close = () => {
      if (input.signal && signalHandler) input.signal.removeEventListener('abort', signalHandler);
      signalHandler = null;
      finished.resolve(outcome);
    };
    if (input.signal) {
      signalHandler = () => {
        events.length = 0;
        close();
      };
      if (input.signal.aborted) signalHandler();
      else input.signal.addEventListener('abort', signalHandler, { once: true });
    }
    if (input.onEvent) {
      for (const event of events.splice(0)) {
        try { input.onEvent(event); } catch {}
      }
      close();
    } else if (events.length === 0) {
      close();
    }
    return {
      ...outcome,
      done: finished.promise,
      nextEvent: async () => {
        if (input.signal?.aborted || events.length === 0) {
          close();
          return null;
        }
        const event = events.shift();
        if (events.length === 0) close();
        return event;
      },
      _subscriber: null,
    };
  }

  async _nextAttachmentEvent(runtime, subscriber) {
    if (subscriber.signal?.aborted) {
      subscriber.queue.length = 0;
      return null;
    }
    if (subscriber.queue.length > 0) return subscriber.queue.shift();
    if (Number.isSafeInteger(subscriber.terminalReplayThrough)) {
      while (subscriber.cursor < subscriber.terminalReplayThrough) {
        if (subscriber.signal?.aborted) return null;
        const before = subscriber.cursor;
        const rows = await this.store.readEvents(runtime.operationId, subscriber.cursor);
        this._deliverRowsToSubscriber(subscriber, rows);
        if (subscriber.queue.length > 0) return subscriber.queue.shift();
        if (subscriber.cursor <= before) throw coordinatorError('event_stream_invalid');
      }
      return null;
    }
    if (subscriber.finished.settled) return null;
    if (subscriber.waiting.length > 0) throw coordinatorError('attachment_read_pending');
    let resolvePending;
    const pending = new Promise((resolve) => { resolvePending = resolve; });
    subscriber.waiting.push(resolvePending);
    try {
      const rows = await this.store.readEvents(runtime.operationId, subscriber.cursor);
      this._deliverRowsToSubscriber(subscriber, rows);
      if (subscriber.finished.settled && subscriber.waiting.includes(resolvePending)) {
        subscriber.waiting.splice(subscriber.waiting.indexOf(resolvePending), 1);
        resolvePending(null);
      }
    } catch (error) {
      const index = subscriber.waiting.indexOf(resolvePending);
      if (index >= 0) subscriber.waiting.splice(index, 1);
      throw error;
    }
    return pending;
  }

  async attach(operationId, input) {
    assertOperationId(operationId);
    exactKeys(input, ['attachmentId', 'afterSequence', 'signal', 'onEvent']);
    assertIdentifier(input.attachmentId, 'attachmentId');
    const afterSequence = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw coordinatorError('event_cursor_invalid');
    }
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
      throw coordinatorError('invalid_request');
    }
    if (input.onEvent !== undefined && typeof input.onEvent !== 'function') {
      throw coordinatorError('invalid_request');
    }
    const result = await this._enqueue(operationId, async () => {
      const record = await this.store.get(operationId);
      if (record.requesterAgent !== this.requesterAgent) throw coordinatorError('access_denied');
      if (TERMINAL_STATES.has(record.state)) {
        const replay = await this.store.readEvents(operationId, afterSequence);
        return this._terminalReplayAttachment(record, input, replay);
      }
      const runtime = this._ensureRuntime(record);
      if (runtime.attachments.has(input.attachmentId)) {
        throw coordinatorError('attachment_already_attached');
      }
      const attachment = await this.store.openAttachment(operationId, input.attachmentId);
      const attached = this._attachmentResult(
        runtime,
        input.attachmentId,
        attachment,
        afterSequence,
      );
      attached._subscriber.onEvent = input.onEvent ?? null;
      const replay = await this.store.readEvents(operationId, afterSequence);
      this._deliverRowsToSubscriber(attached._subscriber, replay);
      return attached;
    });
    if (input.signal && result._subscriber) {
      result._subscriber.signal = input.signal;
      result._subscriber.signalHandler = () => {
        this.detach(operationId, {
          attachmentId: input.attachmentId,
          reason: 'caller_abort',
        }).catch(() => {});
      };
      if (input.signal.aborted) result._subscriber.signalHandler();
      else input.signal.addEventListener('abort', result._subscriber.signalHandler, { once: true });
    }
    const { _subscriber, ...publicResult } = result;
    return publicResult;
  }

  async detach(operationId, input) {
    assertOperationId(operationId);
    exactKeys(input, ['attachmentId', 'reason']);
    assertIdentifier(input.attachmentId, 'attachmentId');
    assertIdentifier(input.reason, 'reason');
    return this._enqueue(operationId, async () => {
      const record = await this.store.get(operationId);
      if (record.requesterAgent !== this.requesterAgent) throw coordinatorError('access_denied');
      const attachment = await this.store.detachAttachment(
        operationId,
        input.attachmentId,
        input.reason,
      );
      const runtime = this.runtimes.get(operationId);
      const subscriber = runtime?.attachments.get(input.attachmentId);
      if (subscriber) {
        if (subscriber.signal && subscriber.signalHandler) {
          subscriber.signal.removeEventListener('abort', subscriber.signalHandler);
        }
        subscriber.finished.resolve(attachment);
        for (const resolve of subscriber.waiting.splice(0)) resolve(null);
        runtime.attachments.delete(input.attachmentId);
      }
      return attachment;
    });
  }

  async _broadcastNewEvents(runtime, afterSequence) {
    const rows = await this.store.readEvents(runtime.operationId, afterSequence);
    for (const subscriber of runtime.attachments.values()) {
      this._deliverRowsToSubscriber(subscriber, rows);
    }
  }

  _deliverRowsToSubscriber(subscriber, rows) {
    for (const row of rows) {
      let event;
      let nextCursor;
      if (row.type === 'event_gap' && Number.isSafeInteger(row.sequence)) {
        if (row.sequence > subscriber.cursor) subscriber.cursor = row.sequence;
        continue;
      }
      if (row.type === 'event_gap') {
        if (!Number.isSafeInteger(row.oldestSequence)
            || !Number.isSafeInteger(row.latestSequence)
            || row.oldestSequence > row.latestSequence) {
          throw coordinatorError('event_stream_invalid');
        }
        if (row.oldestSequence <= subscriber.cursor) continue;
        event = Object.freeze({
          ...row,
          eventSequence: row.latestSequence,
        });
        nextCursor = event.eventSequence;
      } else {
        if (!Number.isSafeInteger(row.sequence) || row.sequence <= subscriber.cursor) continue;
        event = Object.freeze({ ...row, eventSequence: row.sequence });
        nextCursor = row.sequence;
      }
      if (subscriber.onEvent) {
        subscriber.cursor = nextCursor;
        try { subscriber.onEvent(event); } catch {}
        const waiter = subscriber.waiting.shift();
        if (waiter) waiter(event);
        continue;
      }
      const waiter = subscriber.waiting.shift();
      if (waiter) {
        subscriber.cursor = nextCursor;
        waiter(event);
        continue;
      }
      if (subscriber.queue.length === 0) {
        subscriber.cursor = nextCursor;
        subscriber.queue.push(event);
        continue;
      }
      break;
    }
  }

  _cleanWorkerEvent(rawEvent) {
    const event = clone(rawEvent, 'worker_event_invalid');
    const workerEventSequence = event.eventSequence;
    delete event.operationId;
    delete event.eventSequence;
    delete event.currentStatus;
    delete event.sequence;
    return { ...event, workerEventSequence };
  }

  _validateProviderCallId(operationType, providerCallId) {
    try {
      assertIdentifier(providerCallId, 'providerCallId');
    } catch (error) {
      throw coordinatorError('provider_contract_invalid', error);
    }
    if (!PROVIDER_OPERATION_TYPES.has(operationType)) {
      throw coordinatorError('provider_contract_invalid');
    }
    const singleton = operationType === 'query'
      || operationType === 'synthesis'
      || operationType === 'research_compile';
    if (singleton && providerCallId !== operationType) throw coordinatorError('provider_contract_invalid');
    if (operationType === 'pgs' && !/^pgs:(?:synthesis|[A-Za-z0-9][A-Za-z0-9._:@+-]{0,251})$/.test(providerCallId)) {
      throw coordinatorError('provider_contract_invalid');
    }
  }

  _clearProviderTimer(call) {
    if (call?.timer) this.clearTimeout(call.timer);
  }

  _armProviderTimer(record, runtime, providerCallId, providerStallMs, delay = providerStallMs) {
    const prior = runtime.providerCalls.get(providerCallId);
    if (prior) this._clearProviderTimer(prior);
    const call = prior || {
      providerCallId, providerStallMs, lastActivityAt: this.now(), timer: null, generation: 0,
    };
    call.providerStallMs = providerStallMs;
    call.lastActivityAt = this.now();
    call.generation += 1;
    const generation = call.generation;
    let timer = null;
    timer = this.setTimeout(async () => {
      if (call.timer === timer) call.timer = null;
      try {
        await this._enqueue(record.operationId, async () => {
          const currentCall = runtime.providerCalls.get(providerCallId);
          if (runtime.stopped || this.stopped
              || this.runtimes.get(record.operationId) !== runtime
              || currentCall !== call || call.generation !== generation) return;
          return this._failLocked(record.operationId, {
            state: 'failed',
            code: 'provider_stalled',
            message: `provider call stalled: ${providerCallId}`,
            retryable: true,
            cancelWorker: true,
            extra: { providerCallId },
          });
        });
      } catch (error) {
        await this._handleTimerFailure(record.operationId, runtime, error);
      }
    }, Math.max(0, delay));
    call.timer = timer;
    runtime.providerCalls.set(providerCallId, call);
  }

  async _handleProviderEventLocked(record, runtime, event) {
    this._validateProviderCallId(record.operationType, event.providerCallId);
    const current = runtime.providerCalls.get(event.providerCallId);
    if (event.type === 'provider_selected') {
      const max = this.executionDeadlineMsByType[record.operationType];
      if (current || !Number.isFinite(event.providerStallMs)
          || event.providerStallMs <= 0 || event.providerStallMs > max) {
        throw coordinatorError('provider_contract_invalid');
      }
      this._armProviderTimer(record, runtime, event.providerCallId, event.providerStallMs);
      return;
    }
    if (!current) throw coordinatorError('provider_contract_invalid');
    if (event.type === 'provider_activity') {
      this._armProviderTimer(record, runtime, event.providerCallId, current.providerStallMs);
      return;
    }
    this._clearProviderTimer(current);
    runtime.providerCalls.delete(event.providerCallId);
  }

  _validateHistoricalProviderEvent(record, event) {
    this._validateProviderCallId(record.operationType, event.providerCallId);
    if (event.type === 'provider_selected') {
      const max = this.executionDeadlineMsByType[record.operationType];
      if (!Number.isFinite(event.providerStallMs)
          || event.providerStallMs <= 0 || event.providerStallMs > max) {
        throw coordinatorError('provider_contract_invalid');
      }
    }
  }

  async _acceptWorkerEventLocked(operationId, rawEvent, runtime) {
    const record = await this.store.get(operationId);
    if (TERMINAL_STATES.has(record.state)) return rawEvent.eventSequence;
    rawEvent = validateCoordinatorWorkerEvent(rawEvent, operationId, runtime.workerCursor);
    if (rawEvent.type === 'event_gap') {
      const workerRecord = await this._authenticatedWorkerStatus(record, {
        minimumEventSequence: Math.max(runtime.workerCursor, rawEvent.eventSequence),
      });
      const before = record.eventSequence;
      await this.store.appendEvent(operationId, {
        // The COSMO stream had a gap, but the requester-facing durable journal
        // remains contiguous. Publish the authenticated status recovery as a
        // heartbeat so clients do not mistake worker-local sequence loss for a
        // requester journal gap and skip later provider/terminal evidence.
        type: 'heartbeat',
        workerOldestSequence: rawEvent.oldestSequence,
        workerLatestSequence: rawEvent.latestSequence,
        workerEventSequence: workerRecord.eventSequence,
      });
      await this._broadcastNewEvents(runtime, before);
      await this._rearmProviderCallsLocked(record, workerRecord.activeProviderCalls, runtime);
      runtime.workerCursor = rawEvent.eventSequence;
      runtime.providerSnapshotThrough = workerRecord.eventSequence > runtime.workerCursor
        ? workerRecord.eventSequence
        : null;
      return runtime.workerCursor;
    }
    const isHistoricalSnapshotEvent = Number.isSafeInteger(runtime.providerSnapshotThrough)
      && rawEvent.eventSequence <= runtime.providerSnapshotThrough;
    if (['provider_selected', 'provider_activity', 'provider_call_terminal'].includes(rawEvent.type)) {
      if (isHistoricalSnapshotEvent) this._validateHistoricalProviderEvent(record, rawEvent);
      else await this._handleProviderEventLocked(record, runtime, rawEvent);
    }
    const before = record.eventSequence;
    await this.store.appendEvent(operationId, this._cleanWorkerEvent(rawEvent));
    if (rawEvent.type !== 'terminal') await this._broadcastNewEvents(runtime, before);
    runtime.workerCursor = rawEvent.eventSequence;
    if (Number.isSafeInteger(runtime.providerSnapshotThrough)
        && runtime.workerCursor >= runtime.providerSnapshotThrough) {
      runtime.providerSnapshotThrough = null;
    }
    if (rawEvent.type === 'terminal') {
      if (runtime.providerCalls.size > 0) {
        throw coordinatorError('provider_contract_invalid');
      }
      const workerRecord = await this._authenticatedWorkerStatus(record, {
        minimumEventSequence: runtime.workerCursor,
      });
      if (!TERMINAL_WORKER_STATES.has(workerRecord.state)) {
        throw coordinatorError('worker_contract_invalid');
      }
      await this._finalizeFromWorkerLocked(operationId, workerRecord);
    }
    return runtime.workerCursor;
  }

  _armSilence(runtime) {
    if (runtime.silenceTimer) this.clearTimeout(runtime.silenceTimer);
    runtime.silenceTimer = this.setTimeout(() => {
      runtime.silenceTimer = null;
      runtime.streamController?.abort(coordinatorError('worker_event_silence'));
    }, this.eventSilenceMs);
  }

  _startEventPump(record, runtime, afterSequence) {
    if (runtime.pumpPromise || runtime.stopped || this.stopped || TERMINAL_STATES.has(record.state)) return;
    runtime.workerCursor = Math.max(runtime.workerCursor, afterSequence || 0);
    runtime.pumpPromise = this._runEventPump(record.operationId, runtime)
      .catch(async (error) => {
        if (runtime.stopped || this.stopped || error?.code === 'coordinator_stopped') return;
        await this._enqueue(record.operationId, () => this._failLocked(record.operationId, {
          state: 'failed',
          code: sanitizeErrorCode(error?.code, 'worker_event_invalid'),
          message: error?.message || 'worker event stream failed',
          retryable: true,
          cancelWorker: true,
        })).catch(() => {});
      })
      .finally(() => {
        runtime.pumpPromise = null;
      });
  }

  async _runEventPump(operationId, runtime) {
    while (!runtime.stopped && !this.stopped) {
      const record = await this.store.get(operationId);
      if (runtime.stopped || this.stopped || TERMINAL_STATES.has(record.state)) return;
      const controller = new AbortController();
      runtime.streamController = controller;
      this._armSilence(runtime);
      try {
        const capability = this._issueCapability(record, 'events');
        for await (const event of this.worker.events(operationId, {
          afterSequence: runtime.workerCursor,
          signal: controller.signal,
        }, capability)) {
          if (controller.signal.aborted || runtime.stopped || this.stopped) break;
          this._armSilence(runtime);
          await this._enqueue(operationId, () => this._acceptWorkerEventLocked(operationId, event, runtime));
          const current = await this.store.get(operationId);
          if (TERMINAL_STATES.has(current.state)) return;
        }
      } catch (error) {
        const expectedSilenceAbort = controller.signal.aborted
          && controller.signal.reason?.code === 'worker_event_silence';
        if (!expectedSilenceAbort) throw error;
      } finally {
        if (runtime.silenceTimer) this.clearTimeout(runtime.silenceTimer);
        runtime.silenceTimer = null;
        if (runtime.streamController === controller) runtime.streamController = null;
      }
      if (runtime.stopped || this.stopped) return;
      const current = await this.store.get(operationId);
      if (TERMINAL_STATES.has(current.state)) return;
      const status = await this._authenticatedWorkerStatus(current, {
        minimumEventSequence: runtime.workerCursor,
      });
      if (runtime.stopped || this.stopped || this.runtimes.get(operationId) !== runtime) return;
      if (TERMINAL_WORKER_STATES.has(status.state)) {
        await this._enqueue(operationId, () => this._finalizeFromWorkerLocked(operationId, status));
        return;
      }
      await this._enqueue(operationId, () => this._rearmProviderCallsLocked(current, status.activeProviderCalls, runtime));
    }
  }

  async _rearmProviderCallsLocked(record, rawCalls, runtime) {
    if (runtime.stopped || this.stopped || this.runtimes.get(record.operationId) !== runtime) return;
    let calls;
    try {
      calls = validateActiveProviderCalls(rawCalls);
    } catch (error) {
      throw coordinatorError('provider_contract_invalid', error);
    }
    if (calls.length > MAX_ACTIVE_PROVIDER_CALLS) throw coordinatorError('provider_contract_invalid');
    for (const call of runtime.providerCalls.values()) this._clearProviderTimer(call);
    runtime.providerCalls.clear();
    for (const call of calls) {
      if (runtime.stopped || this.stopped || this.runtimes.get(record.operationId) !== runtime) return;
      this._validateProviderCallId(record.operationType, call.providerCallId);
      const max = this.executionDeadlineMsByType[record.operationType];
      if (call.providerStallMs > max) throw coordinatorError('provider_contract_invalid');
      if (call.idleMs >= call.providerStallMs) {
        await this._failLocked(record.operationId, {
          state: 'failed',
          code: 'provider_stalled',
          message: `provider call stalled: ${call.providerCallId}`,
          retryable: true,
          cancelWorker: true,
          extra: { providerCallId: call.providerCallId },
        });
        return;
      }
      this._armProviderTimer(
        record,
        runtime,
        call.providerCallId,
        call.providerStallMs,
        call.providerStallMs - call.idleMs,
      );
    }
  }

  async _validateArtifactPath(operationId, artifact) {
    const scratchDir = await this.store.ensureScratchDirectory(operationId);
    const relative = path.relative(scratchDir, artifact.scratchPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw coordinatorError('worker_result_invalid');
    }
    let stat;
    let realScratch;
    let realArtifact;
    try {
      [stat, realScratch, realArtifact] = await Promise.all([
        fsp.lstat(artifact.scratchPath),
        fsp.realpath(scratchDir),
        fsp.realpath(artifact.scratchPath),
      ]);
    } catch (error) {
      throw coordinatorError('worker_result_invalid', error);
    }
    const realRelative = path.relative(realScratch, realArtifact);
    if (!stat.isFile() || stat.isSymbolicLink()
        || !realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw coordinatorError('worker_result_invalid');
    }
  }

  async _finalizeFromWorkerLocked(operationId, workerRecord) {
    let record = await this.store.get(operationId);
    if (TERMINAL_STATES.has(record.state)) return record;
    const runtime = this.runtimes.get(operationId) || this._ensureRuntime(record);
    if (runtime.providerCalls.size > 0 || workerRecord?.activeProviderCalls?.length > 0) {
      return this._failLocked(operationId, {
        state: 'failed',
        code: 'provider_contract_invalid',
        message: 'provider call remained active at worker completion',
        retryable: true,
        cancelWorker: true,
      });
    }
    let envelope;
    try {
      envelope = validateResultEnvelope(
        await this._boundedWorkerControl(() => this.worker.result(
          operationId,
          this._issueCapability(record, 'result'),
          this._issueCapability(record, 'result_status'),
        )),
      );
      if (workerRecord && envelope.state !== workerRecord.state) {
        throw coordinatorError('worker_result_invalid');
      }
      if (record.operationType === 'synthesis'
          && typeof this.store.getSynthesisCompletionClaim === 'function') {
        const claim = await this.store.getSynthesisCompletionClaim(operationId);
        if (claim !== null) {
          let state = null;
          let readError = null;
          if (this.readSynthesisState) {
            try {
              state = await this.readSynthesisState();
            } catch (error) {
              readError = error;
            }
          }
          const relation = readError ? 'invalid' : synthesisStateRelation(state, claim);
          if (relation === 'match') {
            return this._completeClaimedSynthesisLocked(record, claim, envelope.sourceEvidence);
          }
          if (envelope.state !== 'failed'
              && (relation === 'invalid' || relation === 'mismatch')) {
            return this._failLocked(operationId, {
              state: 'failed',
              code: 'synthesis_commit_mismatch',
              message: 'Claimed synthesis state does not match durable operation authority',
              retryable: false,
              cancelWorker: false,
              skipClaimReconcile: true,
            });
          }
          if (envelope.state !== 'failed') {
            return this._failLocked(operationId, {
              state: 'interrupted',
              code: 'synthesis_commit_missing',
              message: 'Claimed synthesis state was not committed',
              retryable: true,
              cancelWorker: false,
              skipClaimReconcile: true,
            });
          }
        }
      }
      const artifact = envelope.resultArtifact ?? null;
      if (artifact !== null) {
        const validated = validateArtifactEnvelope(record.operationType, artifact);
        if (record.resultHandle === null && record.resultArtifact === null) {
          await this._validateArtifactPath(operationId, validated);
          try {
            record = await this.store.adoptResultArtifact(operationId, {
              expectedVersion: record.recordVersion,
              ...validated,
            });
          } catch (error) {
            const published = await this.store.get(operationId).catch(() => null);
            if (!published?.resultHandle
                || published.resultArtifact?.mediaType !== validated.mediaType
                || published.resultArtifact?.contentEncoding !== validated.contentEncoding
                || published.resultArtifact?.bytes !== validated.bytes
                || published.resultArtifact?.sha256 !== validated.sha256) {
              throw error;
            }
            record = published;
          }
        } else if (record.resultArtifact?.mediaType !== validated.mediaType
            || record.resultArtifact?.contentEncoding !== validated.contentEncoding
            || record.resultArtifact?.bytes !== validated.bytes
            || record.resultArtifact?.sha256 !== validated.sha256) {
          throw coordinatorError('worker_result_invalid');
        }
      } else if (envelope.result !== null) {
        if (record.result === null && record.resultArtifact === null) {
          try {
            record = await this.store.setResult(operationId, {
              expectedVersion: record.recordVersion,
              result: envelope.result,
            });
          } catch (error) {
            const published = await this.store.get(operationId).catch(() => null);
            let persisted = null;
            if (published?.result !== null) persisted = published.result;
            else if (published?.resultHandle) {
              persisted = await this.store.getResult(operationId, {
                requesterAgent: this.requesterAgent,
                resultHandle: published.resultHandle,
              }).catch(() => null);
            }
            if (!published || !sameJson(persisted, envelope.result)) throw error;
            record = published;
          }
        } else {
          const persisted = record.result !== null
            ? record.result
            : await this.store.getResult(operationId, {
              requesterAgent: this.requesterAgent,
              resultHandle: record.resultHandle,
            });
          if (!sameJson(persisted, envelope.result)) throw coordinatorError('worker_result_invalid');
        }
      }
      const error = envelope.error === null
        ? null
        : typedErrorPayload(envelope.error, 'worker_failed', true);
      try {
        record = await this.store.transition(operationId, {
          expectedVersion: record.recordVersion,
          state: envelope.state,
          phase: 'terminal',
          error,
          sourceEvidence: enrichSourceEvidence(record, envelope.sourceEvidence),
        });
      } catch (transitionError) {
        const published = await this.store.get(operationId).catch(() => null);
        if (!published || !TERMINAL_STATES.has(published.state)) throw transitionError;
        record = published;
      }
      await this._afterTerminalLocked(record);
      return record;
    } catch (error) {
      if (error?.code === 'operation_terminal') return this.store.get(operationId);
      if (error?.code === 'worker_result_invalid'
          || error?.code === 'result_artifact_invalid'
          || error?.code === 'result_invalid') {
        return this._failLocked(operationId, {
          state: 'failed',
          code: 'worker_result_invalid',
          message: 'worker returned an invalid result envelope',
          retryable: true,
          cancelWorker: true,
        });
      }
      throw error;
    }
  }

  async _completeClaimedSynthesisLocked(record, claim, sourceEvidence = null) {
    let current = await this.store.get(record.operationId);
    if (TERMINAL_STATES.has(current.state)) return current;
    const result = synthesisResultFromClaim(claim);
    if (current.result === null && current.resultArtifact === null) {
      current = await this.store.setResult(current.operationId, {
        expectedVersion: current.recordVersion,
        result,
      });
    } else {
      const persisted = current.result !== null
        ? current.result
        : await this.store.getResult(current.operationId, {
          requesterAgent: this.requesterAgent,
          resultHandle: current.resultHandle,
        });
      if (!sameJson(persisted, result)) throw coordinatorError('synthesis_commit_mismatch');
    }
    const fallbackEvidence = {
      sourceHealth: 'healthy',
      sourceRevision: claim.sourceRevision,
      baseRevision: current.sourcePinDescriptor?.baseRevision ?? claim.sourceRevision,
      cutoffRevision: claim.sourceRevision,
      ...(current.sourcePinDescriptor?.summary ? {
        authoritativeTotals: {
          nodes: current.sourcePinDescriptor.summary.nodeCount,
          edges: current.sourcePinDescriptor.summary.edgeCount,
        },
      } : {}),
    };
    current = await this.store.transition(current.operationId, {
      expectedVersion: current.recordVersion,
      state: 'complete',
      phase: 'terminal',
      error: null,
      sourceEvidence: enrichSourceEvidence(
        current,
        sourceEvidence ?? current.sourceEvidence ?? fallbackEvidence,
      ),
    });
    await this._afterTerminalLocked(current);
    return current;
  }

  async _reconcileClaimedSynthesisLocked(record, {
    allowPending = false,
    preserveMissing = false,
  } = {}) {
    if (record.operationType !== 'synthesis'
        || typeof this.store.getSynthesisCompletionClaim !== 'function') return null;
    const claim = await this.store.getSynthesisCompletionClaim(record.operationId);
    if (claim === null) return null;
    let state = null;
    let readError = null;
    if (this.readSynthesisState) {
      try {
        state = await this.readSynthesisState();
      } catch (error) {
        readError = error;
      }
    }
    const relation = readError ? 'invalid' : synthesisStateRelation(state, claim);
    if (relation === 'match') {
      return this._completeClaimedSynthesisLocked(record, claim);
    }
    if (relation === 'missing' || relation === 'prior') {
      if (allowPending) return this.store.get(record.operationId);
      if (preserveMissing) return null;
      return this._failLocked(record.operationId, {
        state: 'interrupted',
        code: 'synthesis_commit_missing',
        message: 'Claimed synthesis state was not committed before interruption',
        retryable: true,
        cancelWorker: false,
        skipClaimReconcile: true,
      });
    }
    return this._failLocked(record.operationId, {
      state: 'failed',
      code: 'synthesis_commit_mismatch',
      message: 'Claimed synthesis state does not match durable operation authority',
      retryable: false,
      cancelWorker: false,
      skipClaimReconcile: true,
      extra: readError ? { causeCode: sanitizeErrorCode(readError.code, 'synthesis_state_invalid') } : {},
    });
  }

  async _cancelWorker(record) {
    try {
      const capability = this._issueCapability(record, 'cancel');
      const pending = this.worker.cancel(record.operationId, capability);
      await this._boundedWorkerControl(() => pending);
    } catch (error) {
      if (error?.code !== 'worker_not_found') throw error;
    }
  }

  async _failLocked(operationId, options) {
    let record = await this.store.get(operationId);
    if (TERMINAL_STATES.has(record.state)) return record;
    if (!options.skipClaimReconcile) {
      const claimed = await this._reconcileClaimedSynthesisLocked(record, { preserveMissing: true });
      if (claimed !== null) return claimed;
    }
    if (options.cancelWorker && !options.cancelAfterTerminal) {
      // Non-user failure paths retain the existing prompt best-effort abort.
      // Explicit cancellation uses cancelAfterTerminal so its durable CAS is
      // serialized against a synthesis completion claim first.
      void this._cancelWorker(record).catch(() => {});
    }
    const error = {
      code: sanitizeErrorCode(options.code, 'operation_failed'),
      message: String(options.message || options.code || 'operation failed').slice(0, 4096),
      retryable: options.retryable !== false,
      ...(options.extra || {}),
    };
    try {
      record = await this.store.transition(operationId, {
        expectedVersion: record.recordVersion,
        state: options.state,
        phase: 'terminal',
        error,
        sourceEvidence: record.sourceEvidence,
      });
    } catch (transitionError) {
      record = await this.store.get(operationId).catch(() => null);
      if (options.state === 'cancelled'
          && record
          && !TERMINAL_STATES.has(record.state)
          && ['version_conflict', 'synthesis_completion_claimed'].includes(transitionError?.code)) {
        const claimed = await this._reconcileClaimedSynthesisLocked(record, { allowPending: true });
        if (claimed !== null) return claimed;
      }
      if (record && TERMINAL_STATES.has(record.state)) {
        await this._afterTerminalLocked(record);
        return record;
      }
      throw transitionError;
    }
    if (options.cancelWorker && options.cancelAfterTerminal) {
      // Durable terminal truth wins before best-effort worker cancellation,
      // so a racing synthesis claim observes cancellation-first atomically.
      void this._cancelWorker(record).catch(() => {});
    }
    await this._afterTerminalLocked(record);
    return record;
  }

  async _releasePinOnce(record) {
    if (record.sourcePinDescriptor === null) return record;
    if (!this.sourcePins?.releaseOperationPins) throw coordinatorError('source_operations_unavailable');
    return this.store.releaseSourcePinOnce(
      record.operationId,
      new Date(this.now()).toISOString(),
      async () => this.sourcePins.releaseOperationPins(record.operationId),
    );
  }

  async _closeRuntimeAttachments(record, runtime) {
    if (!runtime) return;
    for (const [attachmentId, subscriber] of runtime.attachments) {
      subscriber.terminalReplayThrough = record.eventSequence;
      let attachment = null;
      try {
        attachment = await this.store.closeAttachment(record.operationId, attachmentId, 'operation_terminal');
      } catch {}
      if (subscriber.signal && subscriber.signalHandler) {
        subscriber.signal.removeEventListener('abort', subscriber.signalHandler);
      }
      subscriber.finished.resolve(attachment || record);
      for (const resolve of subscriber.waiting.splice(0)) resolve(null);
    }
    runtime.attachments.clear();
  }

  async _afterTerminalLocked(record) {
    const runtime = this.runtimes.get(record.operationId);
    if (runtime?.attachments.size > 0) {
      const oldestCursor = Math.min(
        ...[...runtime.attachments.values()].map((subscriber) => subscriber.cursor),
      );
      await this._broadcastNewEvents(runtime, oldestCursor);
    }
    await this._closeRuntimeAttachments(record, runtime);
    this._stopRuntime(record.operationId);
    await this._releasePinOnce(record);
  }

  _stopRuntime(operationId) {
    const runtime = this.runtimes.get(operationId);
    if (!runtime) return;
    runtime.stopped = true;
    for (const timer of [runtime.heartbeatTimer, runtime.hardDeadlineTimer, runtime.silenceTimer]) {
      if (timer) this.clearTimeout(timer);
    }
    for (const call of runtime.providerCalls.values()) this._clearProviderTimer(call);
    runtime.providerCalls.clear();
    runtime.streamController?.abort(coordinatorError('coordinator_stopped'));
    for (const subscriber of runtime.attachments.values()) {
      if (subscriber.signal && subscriber.signalHandler) {
        subscriber.signal.removeEventListener('abort', subscriber.signalHandler);
      }
      subscriber.finished.resolve({
        ...subscriber.attachment,
        transportClosed: true,
        transportReason: 'coordinator_stopped',
      });
      for (const resolve of subscriber.waiting.splice(0)) resolve(null);
    }
    runtime.attachments.clear();
    this.runtimes.delete(operationId);
  }

  async cancel(operationId) {
    assertOperationId(operationId);
    return this._enqueue(operationId, async () => {
      const record = await this.store.get(operationId);
      if (record.requesterAgent !== this.requesterAgent) throw coordinatorError('access_denied');
      const claimed = await this._reconcileClaimedSynthesisLocked(record, { allowPending: true });
      if (claimed !== null) return claimed;
      return this._failLocked(operationId, {
        state: 'cancelled',
        code: 'operation_cancelled',
        message: 'operation cancelled',
        retryable: false,
        cancelWorker: true,
        cancelAfterTerminal: true,
      });
    });
  }

  async exportResult(operationId, input) {
    assertOperationId(operationId);
    if (!this.exporter?.exportResult) throw coordinatorError('export_unavailable');
    exactKeys(input, ['resultHandle', 'format', 'fileName']);
    const normalized = clone(input, 'invalid_request');
    return this.exporter.exportResult({
      ...normalized,
      requesterAgent: this.requesterAgent,
      operationId,
    });
  }

  async _recoverNonterminalLocked(record) {
    let current = await this.store.get(record.operationId);
    if (TERMINAL_STATES.has(current.state)) return current;
    const claimedSynthesis = await this._reconcileClaimedSynthesisLocked(current, { allowPending: true });
    if (claimedSynthesis !== null) {
      if (TERMINAL_STATES.has(claimedSynthesis.state)) return claimedSynthesis;
      current = claimedSynthesis;
    }
    let policy;
    let hardDeadlineAt;
    try {
      policy = this._policy(current.operationType);
      this.authorizeBrainOperation({
        requesterAgent: this.requesterAgent,
        operationType: current.operationType,
        target: clone(current.target),
      });
      hardDeadlineAt = this._hardDeadline(current);
    } catch (error) {
      return this._failLocked(current.operationId, {
        state: 'interrupted',
        code: 'operation_recovery_invalid',
        message: error?.message || 'operation recovery metadata is invalid',
        retryable: true,
        cancelWorker: false,
      });
    }
    if (hardDeadlineAt <= this.now()) {
      return this._failLocked(current.operationId, {
        state: 'failed',
        code: 'operation_timeout',
        message: 'operation execution deadline elapsed before recovery',
        retryable: true,
        cancelWorker: current.state !== 'queued' || current.sourcePinDescriptor !== null,
      });
    }
    if (policy.requiresSourcePin) {
      if (!this._sourceOperationsReady(current.operationType)) {
        return this._failLocked(current.operationId, {
          state: 'interrupted',
          code: 'source_operations_unavailable',
          message: 'source operation recovery is unavailable',
          retryable: true,
          cancelWorker: false,
        });
      }
      if (current.sourcePinDescriptor === null || current.sourcePinDigest === null) {
        if (current.state !== 'queued') {
          return this._failLocked(current.operationId, {
            state: 'interrupted',
            code: 'source_pin_missing',
            message: 'running operation has no durable source pin',
            retryable: true,
            cancelWorker: true,
          });
        }
        try {
          current = await this._pinRecord(current);
        } catch (error) {
          await this.sourcePins.releaseOperationPins(current.operationId).catch(() => {});
          return this._failLocked(current.operationId, {
            state: 'interrupted',
            code: 'source_pin_unavailable',
            message: error?.message || 'source pin could not be recovered',
            retryable: true,
            cancelWorker: false,
          });
        }
      }
    } else if (current.sourcePinDescriptor !== null || current.sourcePinDigest !== null) {
      return this._failLocked(current.operationId, {
        state: 'interrupted',
        code: 'source_pin_invalid',
        message: 'non-source operation has a source pin',
        retryable: true,
        cancelWorker: true,
      });
    }
    const reference = await this.store.getWorker(current.operationId);
    if (reference === null) {
      const claimedWithoutWorker = await this._reconcileClaimedSynthesisLocked(current);
      if (claimedWithoutWorker !== null) return claimedWithoutWorker;
      this._ensureRuntime(current);
      try {
        return await this._startWorker(current);
      } catch (error) {
        return this._failLocked(current.operationId, {
          state: 'interrupted',
          code: sanitizeErrorCode(error?.code, 'worker_interrupted'),
          message: error?.message || 'worker could not be recovered',
          retryable: true,
          cancelWorker: false,
        });
      }
    }
    const durableEvents = await this.store.readEvents(current.operationId, 0);
    const durableWorkerCursor = durableEvents.reduce((maximum, event) =>
      Math.max(maximum, Number.isSafeInteger(event.workerEventSequence) ? event.workerEventSequence : 0), 0);
    let workerRecord;
    try {
      validateWorkerReference(reference, { operationType: current.operationType });
      workerRecord = await this._authenticatedWorkerStatus(current, {
        expectedReference: reference,
        minimumEventSequence: durableWorkerCursor,
      });
    } catch (error) {
      const claimedAfterWorkerLoss = await this._reconcileClaimedSynthesisLocked(current);
      if (claimedAfterWorkerLoss !== null) return claimedAfterWorkerLoss;
      await this._cancelWorker(current).catch(() => {});
      const code = error?.code === 'provider_contract_invalid'
        ? 'provider_contract_invalid'
        : 'worker_interrupted';
      return this._failLocked(current.operationId, {
        state: code === 'provider_contract_invalid' ? 'failed' : 'interrupted',
        code,
        message: error?.message || 'recorded worker is not active',
        retryable: true,
        cancelWorker: false,
      });
    }
    if (TERMINAL_WORKER_STATES.has(workerRecord.state)) {
      return this._finalizeFromWorkerLocked(current.operationId, workerRecord);
    }
    if (current.state === 'queued') {
      current = await this.store.transition(current.operationId, {
        expectedVersion: current.recordVersion,
        state: 'running',
        phase: workerRecord.phase,
        error: null,
        sourceEvidence: null,
      });
    }
    const runtime = this._ensureRuntime(current);
    runtime.workerCursor = durableWorkerCursor;
    try {
      await this._rearmProviderCallsLocked(current, workerRecord.activeProviderCalls, runtime);
    } catch (error) {
      const code = error?.code === 'provider_contract_invalid'
        ? 'provider_contract_invalid'
        : 'worker_interrupted';
      return this._failLocked(current.operationId, {
        state: code === 'provider_contract_invalid' ? 'failed' : 'interrupted',
        code,
        message: error?.message || 'worker provider snapshot is invalid',
        retryable: true,
        cancelWorker: true,
      });
    }
    runtime.providerSnapshotThrough = workerRecord.eventSequence > durableWorkerCursor
      ? workerRecord.eventSequence
      : null;
    this._startEventPump(current, runtime, durableWorkerCursor);
    return current;
  }

  async reconcile() {
    if (this.stopped) throw coordinatorError('coordinator_stopped');
    for (const record of await this.store.listPinsPendingRelease()) {
      if (record.requesterAgent !== this.requesterAgent) throw coordinatorError('access_denied');
      await this._enqueue(record.operationId, async () => {
        const current = await this.store.get(record.operationId);
        if (TERMINAL_STATES.has(current.state)) await this._releasePinOnce(current);
      });
    }
    for (const record of await this.store.listNonterminal()) {
      if (record.requesterAgent !== this.requesterAgent) throw coordinatorError('access_denied');
      await this._enqueue(record.operationId, () => this._recoverNonterminalLocked(record));
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    const pumps = [];
    for (const [operationId, runtime] of this.runtimes) {
      if (runtime.pumpPromise) pumps.push(runtime.pumpPromise);
      this._stopRuntime(operationId);
    }
    if (pumps.length === 0) return;
    let timer = null;
    try {
      await Promise.race([
        Promise.allSettled(pumps),
        new Promise((resolve) => {
          timer = globalThis.setTimeout(resolve, this.stopTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) globalThis.clearTimeout(timer);
    }
  }
}

function deferredPromise() {
  let resolve;
  const result = {
    settled: false,
    promise: null,
    resolve: null,
  };
  result.promise = new Promise((res) => {
    resolve = res;
  });
  result.resolve = (value) => {
    if (result.settled) return;
    result.settled = true;
    resolve(value);
  };
  return result;
}

module.exports = {
  BrainOperationCoordinator,
  CAPABILITY_TTL_MS,
  DEFAULT_EVENT_SILENCE_MS,
  DEFAULT_EXECUTION_DEADLINES_MS,
  DEFAULT_HEARTBEAT_MS,
  enrichSourceEvidence,
};
