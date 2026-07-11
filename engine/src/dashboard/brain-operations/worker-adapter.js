'use strict';

const crypto = require('node:crypto');
const {
  canonicalJson,
  canonicalSha256,
} = require('../../../../shared/brain-operations/canonical-json.cjs');
const {
  OPERATION_EVENT_MAX_BYTES,
  OPERATION_EVENT_MAX_COUNT,
  assertIdentifier,
  assertOperationId,
  operationError,
  safeJsonClone,
} = require('./operation-contract.js');

const WORKER_STATES = new Set([
  'queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const WORKER_TERMINAL_STATES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const LOCAL_RESULT_STATES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const PROVIDER_EVENT_TYPES = new Set([
  'provider_selected', 'provider_activity', 'provider_call_terminal',
]);
const NOISY_EVENT_TYPES = new Set([
  'heartbeat', 'progress', 'progress_update', 'token', 'token_estimate',
]);
const MAX_ACTIVE_PROVIDER_CALLS = 4096;
const OBSERVED_TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const UNREAD_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const WORKER_EVENT_TYPES = new Set([
  'event_gap', 'heartbeat', 'phase', 'progress', 'progress_update', 'provider_activity',
  'provider_call_terminal', 'provider_selected', 'terminal', 'token', 'token_estimate',
]);
const WORKER_EVENT_FORBIDDEN_KEYS = new Set([
  'accessMode', 'brainId', 'canonicalRoot', 'capability', 'capabilityToken',
  'catalogRevision', 'lockRoot', 'mutationBoundaries', 'operationControl',
  'operationPath', 'operationRoot', 'operationType', 'ownerAgent', 'projectionRoot',
  'requester', 'requesterAgent', 'route', 'runId', 'runOwner', 'runOwnerAgent',
  'runState', 'scratchDir', 'scratchPath', 'selectedAgent', 'selectedBrain',
  'sourcePinDescriptor', 'sourcePinDigest', 'target', 'targetBrainId', 'targetDomain',
  'targetKind', 'targetLifecycle', 'targetRequesterAgent', 'targetRunId', 'token',
  'writeScope', 'writes',
]);

function workerError(code, cause) {
  return operationError(code, cause);
}

function clone(value, code = 'worker_contract_invalid') {
  return safeJsonClone(value, code);
}

function exactKeys(value, allowed, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw workerError(code);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) throw workerError(code);
  }
}

function validateWorkerReference(raw, expected = {}) {
  const code = 'worker_contract_invalid';
  const reference = clone(raw, code);
  exactKeys(reference, ['version', 'workerId', 'workerType', 'operationType'], code);
  if (reference.version !== 1) throw workerError(code);
  assertIdentifier(reference.workerId, 'workerId');
  assertIdentifier(reference.operationType, 'operationType');
  if (reference.workerType !== 'local' && reference.workerType !== 'cosmo') {
    throw workerError(code);
  }
  if (expected.operationType && reference.operationType !== expected.operationType) {
    throw workerError(code);
  }
  if (expected.workerType && reference.workerType !== expected.workerType) {
    throw workerError(code);
  }
  return Object.freeze(reference);
}

function validateActiveProviderCalls(rawCalls) {
  const code = 'worker_contract_invalid';
  if (!Array.isArray(rawCalls) || rawCalls.length > MAX_ACTIVE_PROVIDER_CALLS) {
    throw workerError(code);
  }
  const seen = new Set();
  return rawCalls.map((raw) => {
    const call = clone(raw, code);
    exactKeys(call, ['providerCallId', 'providerStallMs', 'idleMs'], code);
    assertIdentifier(call.providerCallId, 'providerCallId');
    if (seen.has(call.providerCallId)
        || !Number.isFinite(call.providerStallMs) || call.providerStallMs <= 0
        || !Number.isFinite(call.idleMs) || call.idleMs < 0) {
      throw workerError(code);
    }
    seen.add(call.providerCallId);
    return Object.freeze(call);
  });
}

function validateWorkerRecord(rawRecord, expected = {}) {
  const code = 'worker_contract_invalid';
  const record = clone(rawRecord, code);
  exactKeys(record, [
    'reference', 'operationId', 'operationType', 'state', 'phase', 'eventSequence',
    'activeProviderCalls',
  ], code);
  assertOperationId(record.operationId);
  if (expected.operationId && record.operationId !== expected.operationId) throw workerError(code);
  if (!WORKER_STATES.has(record.state)) throw workerError(code);
  if (record.phase !== null) assertIdentifier(record.phase, 'phase');
  if (!Number.isSafeInteger(record.eventSequence) || record.eventSequence < 0) {
    throw workerError(code);
  }
  const reference = validateWorkerReference(record.reference, expected);
  assertIdentifier(record.operationType, 'operationType');
  if (record.operationType !== reference.operationType
      || (expected.operationType && record.operationType !== expected.operationType)) {
    throw workerError(code);
  }
  const activeProviderCalls = validateActiveProviderCalls(record.activeProviderCalls);
  return Object.freeze({
    reference,
    operationId: record.operationId,
    operationType: record.operationType,
    state: record.state,
    phase: record.phase,
    eventSequence: record.eventSequence,
    activeProviderCalls: Object.freeze(activeProviderCalls),
  });
}

function validateResultEnvelope(rawEnvelope) {
  const code = 'worker_result_invalid';
  const envelope = clone(rawEnvelope, code);
  exactKeys(envelope, ['state', 'result', 'resultArtifact', 'error', 'sourceEvidence'], code);
  if (!LOCAL_RESULT_STATES.has(envelope.state)) throw workerError(code);
  if (envelope.result !== null
      && (!envelope.result || Array.isArray(envelope.result) || typeof envelope.result !== 'object')) {
    throw workerError(code);
  }
  if (envelope.resultArtifact !== null && envelope.resultArtifact !== undefined) {
    if (envelope.result !== null) throw workerError(code);
    exactKeys(envelope.resultArtifact, [
      'scratchPath', 'mediaType', 'contentEncoding', 'bytes', 'sha256',
    ], code);
  }
  if (envelope.error !== null
      && (!envelope.error || Array.isArray(envelope.error) || typeof envelope.error !== 'object')) {
    throw workerError(code);
  }
  if (envelope.sourceEvidence !== null
      && (!envelope.sourceEvidence
        || Array.isArray(envelope.sourceEvidence)
        || typeof envelope.sourceEvidence !== 'object')) {
    throw workerError(code);
  }
  return envelope;
}

function containsForbiddenEventKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenEventKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    WORKER_EVENT_FORBIDDEN_KEYS.has(key) || containsForbiddenEventKey(child));
}

function validateWorkerEvent(rawEvent, expected = {}) {
  const code = 'worker_event_invalid';
  const event = clone(rawEvent, code);
  if (!event || Array.isArray(event) || typeof event !== 'object'
      || event.operationId !== expected.operationId
      || !Number.isSafeInteger(event.eventSequence)
      || event.eventSequence <= (expected.afterSequence ?? -1)
      || !WORKER_EVENT_TYPES.has(event.type)
      || Object.hasOwn(event, 'sequence')) {
    throw workerError(code);
  }
  const payload = { ...event };
  delete payload.operationId;
  delete payload.eventSequence;
  delete payload.type;
  if (event.type === 'event_gap') delete payload.currentStatus;
  if (containsForbiddenEventKey(payload)) throw workerError(code);
  if (event.type !== 'terminal' && Object.hasOwn(event, 'state')) throw workerError(code);
  if (event.type === 'terminal' && !WORKER_TERMINAL_STATES.has(event.state)) {
    throw workerError(code);
  }
  if (event.type === 'phase') {
    try { assertIdentifier(event.phase, 'phase'); } catch (error) {
      throw workerError(code, error);
    }
  }
  if (PROVIDER_EVENT_TYPES.has(event.type)) {
    try { assertIdentifier(event.providerCallId, 'providerCallId'); } catch (error) {
      throw workerError(code, error);
    }
    if (event.type === 'provider_selected'
        && (!Number.isFinite(event.providerStallMs) || event.providerStallMs <= 0)) {
      throw workerError(code);
    }
  }
  if (event.type === 'event_gap') {
    if (!Number.isSafeInteger(event.oldestSequence) || event.oldestSequence <= 0
        || !Number.isSafeInteger(event.latestSequence)
        || event.latestSequence < event.oldestSequence
        || event.eventSequence < event.latestSequence) {
      throw workerError(code);
    }
    const currentStatus = validateWorkerRecord(event.currentStatus, {
      operationId: expected.operationId,
    });
    if (currentStatus.eventSequence < event.latestSequence) throw workerError(code);
    event.currentStatus = currentStatus;
  }
  return event;
}

function validateContext(rawContext) {
  const code = 'worker_context_invalid';
  if (!rawContext || Array.isArray(rawContext) || typeof rawContext !== 'object') {
    throw workerError(code);
  }
  assertOperationId(rawContext.operationId);
  assertIdentifier(rawContext.operationType, 'operationType');
  assertIdentifier(rawContext.requesterAgent, 'requesterAgent');
  if (!rawContext.target || Array.isArray(rawContext.target) || typeof rawContext.target !== 'object') {
    throw workerError(code);
  }
  if (!rawContext.parameters
      || Array.isArray(rawContext.parameters)
      || typeof rawContext.parameters !== 'object') {
    throw workerError(code);
  }
  if (typeof rawContext.scratchDir !== 'string' || !rawContext.scratchDir) {
    throw workerError(code);
  }
  const parameters = clone(rawContext.parameters, code);
  const nestedControl = parameters.operationControl;
  if (nestedControl !== undefined && rawContext.operationControl !== undefined) {
    throw workerError(code);
  }
  const control = rawContext.operationControl ?? nestedControl;
  if (!control || Array.isArray(control) || typeof control !== 'object') throw workerError(code);
  exactKeys(control, ['hardDeadlineAt'], code);
  const parsedDeadline = Date.parse(control.hardDeadlineAt);
  if (!Number.isFinite(parsedDeadline)
      || new Date(parsedDeadline).toISOString() !== control.hardDeadlineAt) {
    throw workerError(code);
  }
  delete parameters.operationControl;
  const claimSynthesisCompletion = rawContext.claimSynthesisCompletion ?? null;
  if (claimSynthesisCompletion !== null && typeof claimSynthesisCompletion !== 'function') {
    throw workerError(code);
  }
  return {
    operationId: rawContext.operationId,
    operationType: rawContext.operationType,
    requesterAgent: rawContext.requesterAgent,
    target: clone(rawContext.target, code),
    parameters,
    hardDeadlineAt: control.hardDeadlineAt,
    scratchDir: rawContext.scratchDir,
    scratchQuota: rawContext.scratchQuota ?? null,
    sourcePin: rawContext.sourcePin ?? null,
    sourcePinDescriptor: rawContext.sourcePinDescriptor ?? rawContext.sourcePin?.descriptor ?? null,
    sourcePinDigest: rawContext.sourcePinDigest ?? null,
    claimSynthesisCompletion,
  };
}

function fingerprintContext(context) {
  try {
    return canonicalSha256({
      operationId: context.operationId,
      operationType: context.operationType,
      requesterAgent: context.requesterAgent,
      target: context.target,
      parameters: context.parameters,
      hardDeadlineAt: context.hardDeadlineAt,
      scratchDir: context.scratchDir,
      sourcePinDescriptor: context.sourcePinDescriptor,
      sourcePinDigest: context.sourcePinDigest,
    });
  } catch (error) {
    throw workerError('worker_context_invalid', error);
  }
}

class BrainOperationWorkerAdapter {
  constructor(options = {}) {
    if (!options || Array.isArray(options) || typeof options !== 'object') {
      throw workerError('worker_configuration_invalid');
    }
    this.remoteWorker = options.remoteWorker ?? null;
    this.now = typeof options.clock?.now === 'function' ? options.clock.now : Date.now;
    this.monotonicNow = typeof options.clock?.monotonicNow === 'function'
      ? options.clock.monotonicNow
      : this.now;
    this.localExecutors = new Map();
    this.localRecords = new Map();
    this.localTombstones = new Set();
    this.stopped = false;
    if (options.sourceOperationTypes !== undefined
        && !Array.isArray(options.sourceOperationTypes)) {
      throw workerError('worker_configuration_invalid');
    }
    this.sourceOperationTypes = new Set();
    for (const operationType of options.sourceOperationTypes || []) {
      assertIdentifier(operationType, 'operationType');
      this.sourceOperationTypes.add(operationType);
    }
    this.supportsSourceOperations = options.supportsSourceOperations === true
      || this.remoteWorker?.supportsSourceOperations === true;
  }

  registerLocalExecutor(operationType, executor) {
    assertIdentifier(operationType, 'operationType');
    if (typeof executor !== 'function') throw workerError('executor_invalid');
    if (this.localExecutors.has(operationType)) throw workerError('executor_conflict');
    this.localExecutors.set(operationType, executor);
  }

  _gcLocalRecords() {
    const now = this.now();
    for (const [operationId, record] of this.localRecords) {
      if (!WORKER_TERMINAL_STATES.has(record.state) || !Number.isFinite(record.terminalAt)) continue;
      const expiresAt = record.resultObservedAt === null
        ? record.terminalAt + UNREAD_TERMINAL_RETENTION_MS
        : record.resultObservedAt + OBSERVED_TERMINAL_RETENTION_MS;
      if (now < expiresAt) continue;
      record.events.length = 0;
      record.eventByteSizes.clear();
      record.eventBytes = 0;
      record.activeProviderCalls.clear();
      record.result = null;
      record.context = null;
      this.localRecords.delete(operationId);
      this.localTombstones.add(operationId);
    }
  }

  _assertNotEvicted(operationId) {
    if (this.localTombstones.has(operationId)) throw workerError('worker_not_found');
  }

  async _releaseUnownedContext(context, retainedContext = null) {
    try {
      if (context.sourcePin && context.sourcePin !== retainedContext?.sourcePin) {
        await context.sourcePin.release?.();
      }
    } finally {
      if (context.scratchQuota && context.scratchQuota !== retainedContext?.scratchQuota) {
        await context.scratchQuota.close?.();
      }
    }
  }

  usesLocalExecutor(operationType) {
    assertIdentifier(operationType, 'operationType');
    return this.localExecutors.has(operationType);
  }

  supportsSourceOperation(operationType) {
    assertIdentifier(operationType, 'operationType');
    if (this.localExecutors.has(operationType)) {
      return this.sourceOperationTypes.has(operationType);
    }
    if (typeof this.remoteWorker?.supportsSourceOperation === 'function') {
      return this.remoteWorker.supportsSourceOperation(operationType) === true;
    }
    return this.remoteWorker?.start
      ? this.sourceOperationTypes.has(operationType)
      : false;
  }

  _publicRecord(record) {
    const monotonic = this.monotonicNow();
    const activeProviderCalls = [...record.activeProviderCalls.values()]
      .map((call) => ({
        providerCallId: call.providerCallId,
        providerStallMs: call.providerStallMs,
        idleMs: Math.max(0, monotonic - call.lastActivityAt),
      }))
      .sort((left, right) => left.providerCallId.localeCompare(right.providerCallId));
    return validateWorkerRecord({
      reference: record.reference,
      operationId: record.operationId,
      operationType: record.operationType,
      state: record.state,
      phase: record.phase,
      eventSequence: record.eventSequence,
      activeProviderCalls,
    }, {
      operationId: record.operationId,
      operationType: record.operationType,
      workerType: 'local',
    });
  }

  _notify(record) {
    const waiters = [...record.waiters];
    record.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  _eventBytes(events) {
    return events.reduce((total, event) =>
      total + Buffer.byteLength(`${canonicalJson(event)}\n`, 'utf8'), 0);
  }

  _removeEventAt(record, index) {
    const [removed] = record.events.splice(index, 1);
    if (!removed) return;
    const bytes = record.eventByteSizes.get(removed.eventSequence) ?? 0;
    record.eventByteSizes.delete(removed.eventSequence);
    record.eventBytes = Math.max(0, record.eventBytes - bytes);
  }

  _pushEvent(record, event) {
    const bytes = Buffer.byteLength(`${canonicalJson(event)}\n`, 'utf8');
    record.events.push(event);
    record.eventByteSizes.set(event.eventSequence, bytes);
    record.eventBytes += bytes;
    this._compactEvents(record);
  }

  _compactEvents(record) {
    while (record.events.length > OPERATION_EVENT_MAX_COUNT
        || record.eventBytes > OPERATION_EVENT_MAX_BYTES) {
      const overBytes = record.eventBytes > OPERATION_EVENT_MAX_BYTES;
      let index = overBytes
        ? record.events.findLastIndex((event) => NOISY_EVENT_TYPES.has(event.type))
        : record.events.findIndex((event) => NOISY_EVENT_TYPES.has(event.type));
      if (index < 0) {
        index = record.events.findIndex((event, candidate) =>
          event.type === 'phase'
          && record.events.slice(candidate + 1).some((later) => later.type === 'phase'));
      }
      if (index < 0) index = 0;
      this._removeEventAt(record, index);
    }
  }

  _reportEvent(record, rawEvent) {
    if (WORKER_TERMINAL_STATES.has(record.state)) throw workerError('worker_terminal');
    const event = clone(rawEvent, 'worker_event_invalid');
    if (!event || Array.isArray(event) || typeof event !== 'object'
        || Object.hasOwn(event, 'operationId')
        || Object.hasOwn(event, 'eventSequence')) {
      throw workerError('worker_event_invalid');
    }
    const nextSequence = record.eventSequence + 1;
    const normalized = Object.freeze(validateWorkerEvent({
      ...event,
      operationId: record.operationId,
      eventSequence: nextSequence,
      at: new Date(this.now()).toISOString(),
    }, {
      operationId: record.operationId,
      afterSequence: record.eventSequence,
    }));
    const monotonic = this.monotonicNow();
    if (PROVIDER_EVENT_TYPES.has(normalized.type)) {
      const current = record.activeProviderCalls.get(normalized.providerCallId);
      if (normalized.type === 'provider_selected') {
        if (current) {
          throw workerError('provider_contract_invalid');
        }
        if (record.activeProviderCalls.size >= MAX_ACTIVE_PROVIDER_CALLS) {
          throw workerError('provider_contract_invalid');
        }
        record.activeProviderCalls.set(normalized.providerCallId, {
          providerCallId: normalized.providerCallId,
          providerStallMs: normalized.providerStallMs,
          lastActivityAt: monotonic,
        });
      } else if (!current) {
        throw workerError('provider_contract_invalid');
      } else if (normalized.type === 'provider_activity') {
        current.lastActivityAt = monotonic;
      } else {
        record.activeProviderCalls.delete(normalized.providerCallId);
      }
    }
    record.eventSequence = nextSequence;
    if (normalized.type === 'phase') record.phase = normalized.phase;
    this._pushEvent(record, normalized);
    this._notify(record);
    return normalized;
  }

  async _releaseLocalResources(record) {
    if (record.releasePromise) return record.releasePromise;
    const context = record.context;
    record.releasePromise = (async () => {
      try {
        await context?.sourcePin?.release?.();
      } finally {
        await context?.scratchQuota?.close?.();
      }
    })();
    return record.releasePromise;
  }

  async _runLocal(record, executor) {
    let envelope;
    try {
      envelope = validateResultEnvelope(await executor({
        operationId: record.operationId,
        operationType: record.operationType,
        requesterAgent: record.context.requesterAgent,
        target: clone(record.context.target),
        parameters: clone(record.context.parameters),
        scratchDir: record.context.scratchDir,
        scratchQuota: record.context.scratchQuota,
        signal: record.controller.signal,
        sourcePin: record.context.sourcePin,
        claimSynthesisCompletion: record.context.claimSynthesisCompletion,
        reportEvent: (event) => this._reportEvent(record, event),
      }));
    } catch (error) {
      if (record.controller.signal.aborted && error === record.controller.signal.reason) {
        envelope = {
          state: 'cancelled',
          result: null,
          resultArtifact: null,
          error: null,
          sourceEvidence: null,
        };
      } else {
        envelope = {
          state: 'failed',
          result: null,
          resultArtifact: null,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'executor_failed',
            message: error?.message || 'executor failed',
            retryable: error?.retryable === true,
          },
          sourceEvidence: null,
        };
      }
    }
    record.result = envelope;
    record.state = envelope.state;
    record.phase = 'terminal';
    record.terminalAt = this.now();
    record.eventSequence += 1;
    this._pushEvent(record, Object.freeze({
      type: 'terminal',
      operationId: record.operationId,
      eventSequence: record.eventSequence,
      state: record.state,
      at: new Date(this.now()).toISOString(),
    }));
    this._notify(record);
    await this._releaseLocalResources(record).catch(() => {});
  }

  async _startLocal(context, executor) {
    this._gcLocalRecords();
    this._assertNotEvicted(context.operationId);
    const fingerprint = fingerprintContext(context);
    const existing = this.localRecords.get(context.operationId);
    if (existing) {
      await this._releaseUnownedContext(context, existing.context).catch(() => {});
      if (existing.fingerprint !== fingerprint) throw workerError('worker_operation_conflict');
      return this._publicRecord(existing);
    }
    if (this.stopped) {
      await this._releaseUnownedContext(context).catch(() => {});
      throw workerError('worker_stopped');
    }
    const workerId = `local-${crypto.randomBytes(18).toString('base64url')}`;
    const record = {
      reference: Object.freeze({
        version: 1,
        workerId,
        workerType: 'local',
        operationType: context.operationType,
      }),
      operationId: context.operationId,
      operationType: context.operationType,
      state: 'running',
      phase: 'executing',
      eventSequence: 0,
      activeProviderCalls: new Map(),
      events: [],
      eventBytes: 0,
      eventByteSizes: new Map(),
      waiters: new Set(),
      result: null,
      controller: new AbortController(),
      context,
      fingerprint,
      releasePromise: null,
      runPromise: null,
      terminalAt: null,
      resultObservedAt: null,
    };
    this.localRecords.set(context.operationId, record);
    record.runPromise = Promise.resolve().then(() => this._runLocal(record, executor));
    return this._publicRecord(record);
  }

  async start(rawContext, capability) {
    const context = validateContext(rawContext);
    const executor = this.localExecutors.get(context.operationType);
    if (executor) return this._startLocal(context, executor);
    if (!this.remoteWorker?.start) {
      await this._releaseUnownedContext(context).catch(() => {});
      throw workerError('executor_unavailable');
    }
    const remoteContext = {
      operationId: context.operationId,
      operationType: context.operationType,
      requesterAgent: context.requesterAgent,
      target: context.target,
      parameters: context.parameters,
      operationControl: { hardDeadlineAt: context.hardDeadlineAt },
      sourcePinDescriptor: context.sourcePinDescriptor,
      sourcePinDigest: context.sourcePinDigest,
    };
    try {
      const result = await this.remoteWorker.start(remoteContext, capability);
      return validateWorkerRecord(result, {
        operationId: context.operationId,
        operationType: context.operationType,
        workerType: 'cosmo',
      });
    } finally {
      await this._releaseUnownedContext(context).catch(() => {});
    }
  }

  async status(operationId, capability) {
    assertOperationId(operationId);
    this._gcLocalRecords();
    this._assertNotEvicted(operationId);
    const local = this.localRecords.get(operationId);
    if (local) return this._publicRecord(local);
    if (!this.remoteWorker?.status) throw workerError('worker_not_found');
    return validateWorkerRecord(await this.remoteWorker.status(operationId, capability), {
      operationId,
      workerType: 'cosmo',
    });
  }

  async *events(operationId, input, capability) {
    assertOperationId(operationId);
    this._gcLocalRecords();
    this._assertNotEvicted(operationId);
    if (!input || !Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0
        || !(input.signal instanceof AbortSignal)) {
      throw workerError('worker_event_cursor_invalid');
    }
    const local = this.localRecords.get(operationId);
    if (!local) {
      if (!this.remoteWorker?.events) throw workerError('worker_not_found');
      let cursor = input.afterSequence;
      for await (const rawEvent of this.remoteWorker.events(operationId, input, capability)) {
        const event = validateWorkerEvent(rawEvent, { operationId, afterSequence: cursor });
        cursor = event.eventSequence;
        yield event;
      }
      return;
    }
    let cursor = input.afterSequence;
    while (!input.signal.aborted) {
      const event = local.events.find((candidate) => candidate.eventSequence > cursor);
      if (local.eventSequence > cursor
          && (!event || event.eventSequence > cursor + 1)) {
        yield {
          type: 'event_gap',
          operationId,
          eventSequence: local.eventSequence,
          oldestSequence: event?.eventSequence ?? local.eventSequence,
          latestSequence: local.eventSequence,
          currentStatus: this._publicRecord(local),
        };
        cursor = local.eventSequence;
        continue;
      }
      if (event) {
        cursor = event.eventSequence;
        yield clone(event);
        continue;
      }
      if (WORKER_TERMINAL_STATES.has(local.state)) return;
      await new Promise((resolve) => {
        const wake = () => {
          local.waiters.delete(wake);
          input.signal.removeEventListener('abort', wake);
          resolve();
        };
        local.waiters.add(wake);
        input.signal.addEventListener('abort', wake, { once: true });
      });
    }
  }

  async result(operationId, capability, statusCapability) {
    assertOperationId(operationId);
    this._gcLocalRecords();
    this._assertNotEvicted(operationId);
    const local = this.localRecords.get(operationId);
    if (local) {
      if (!local.result) throw workerError('worker_result_unavailable');
      if (local.resultObservedAt === null) local.resultObservedAt = this.now();
      return clone(local.result, 'worker_result_invalid');
    }
    if (!this.remoteWorker?.result) throw workerError('worker_not_found');
    return validateResultEnvelope(await this.remoteWorker.result(
      operationId,
      capability,
      statusCapability,
    ));
  }

  async cancel(operationId, capability) {
    assertOperationId(operationId);
    this._gcLocalRecords();
    this._assertNotEvicted(operationId);
    const local = this.localRecords.get(operationId);
    if (local) {
      if (!WORKER_TERMINAL_STATES.has(local.state) && !local.controller.signal.aborted) {
        local.controller.abort(workerError('operation_cancelled'));
        this._notify(local);
      }
      return this._publicRecord(local);
    }
    if (!this.remoteWorker?.cancel) throw workerError('worker_not_found');
    return validateWorkerRecord(await this.remoteWorker.cancel(operationId, capability), {
      operationId,
      workerType: 'cosmo',
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const record of this.localRecords.values()) {
      if (!WORKER_TERMINAL_STATES.has(record.state) && !record.controller.signal.aborted) {
        record.controller.abort(workerError('worker_stopped'));
      }
      this._notify(record);
    }
    await Promise.allSettled([...this.localRecords.values()]
      .map((record) => record.runPromise)
      .filter(Boolean));
    this.localRecords.clear();
    this.localTombstones.clear();
  }
}

module.exports = {
  BrainOperationWorkerAdapter,
  MAX_ACTIVE_PROVIDER_CALLS,
  OBSERVED_TERMINAL_RETENTION_MS,
  UNREAD_TERMINAL_RETENTION_MS,
  WORKER_STATES,
  WORKER_TERMINAL_STATES,
  validateActiveProviderCalls,
  validateWorkerRecord,
  validateWorkerEvent,
  validateWorkerReference,
};
