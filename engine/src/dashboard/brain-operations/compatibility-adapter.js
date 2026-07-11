'use strict';

const crypto = require('node:crypto');
const {
  assertIdentifier,
  assertOperationId,
  operationError,
} = require('./operation-contract.js');

const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const START_STATES = new Set(['queued', 'running']);
const QUERY_WAIT_MS = 90 * 60_000;
const DETACH_CLEANUP_MS = 5_000;

function adapterError(code, cause) {
  return operationError(code, cause);
}

function exactObject(value, allowed, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw adapterError(code);
  const keys = Reflect.ownKeys(value);
  const accepted = new Set(allowed);
  if (keys.some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw adapterError(code);
  }
  return value;
}

function assertRecord(record, { start = false } = {}) {
  if (!record || Array.isArray(record) || typeof record !== 'object') {
    throw adapterError('operation_contract_invalid');
  }
  assertOperationId(record.operationId);
  assertIdentifier(record.operationType, 'operationType');
  assertIdentifier(record.requesterAgent, 'requesterAgent');
  if (start ? !START_STATES.has(record.state) : !START_STATES.has(record.state)
      && !TERMINAL_STATES.has(record.state)) {
    throw adapterError('operation_contract_invalid');
  }
  if (!Number.isSafeInteger(record.eventSequence) || record.eventSequence < 0) {
    throw adapterError('operation_contract_invalid');
  }
  return record;
}

function createAttachmentId(randomUUID = crypto.randomUUID) {
  const value = `compat-${randomUUID()}`;
  assertIdentifier(value, 'attachmentId');
  return value;
}

function deferredSignal() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function resultlessTerminal(record) {
  return ['failed', 'cancelled', 'interrupted'].includes(record.state)
    && record.result === null
    && record.resultHandle === null
    && record.resultArtifact === null
    && record.resultExpiredAt === null;
}

function attachmentFailure(record, cause) {
  const error = adapterError('attachment_detach_failed', cause);
  error.retryable = true;
  error.operationId = record.operationId;
  error.state = record.state;
  error.attachmentState = 'attached';
  error.resultHandle = record.resultHandle ?? null;
  error.resultArtifact = record.resultArtifact ?? null;
  error.sourceEvidence = record.sourceEvidence ?? null;
  return error;
}

class BrainOperationsCompatibilityAdapter {
  constructor(options = {}) {
    exactObject(options, [
      'requesterAgent', 'coordinator', 'reader', 'exporter', 'timers', 'randomUUID',
    ], 'compatibility_adapter_configuration_invalid');
    assertIdentifier(options.requesterAgent, 'requesterAgent');
    for (const [owner, methods] of [
      [options.coordinator, ['start', 'attach', 'detach']],
      [options.reader, ['getAuthorized', 'getResultAuthorized']],
      [options.exporter, ['exportResult']],
    ]) {
      if (!owner || methods.some((method) => typeof owner[method] !== 'function')) {
        throw adapterError('compatibility_adapter_configuration_invalid');
      }
    }
    if (options.timers !== undefined) {
      exactObject(options.timers, ['setTimeout', 'clearTimeout'], 'compatibility_adapter_configuration_invalid');
      if (typeof options.timers.setTimeout !== 'function'
          || typeof options.timers.clearTimeout !== 'function') {
        throw adapterError('compatibility_adapter_configuration_invalid');
      }
    }
    if (options.randomUUID !== undefined && typeof options.randomUUID !== 'function') {
      throw adapterError('compatibility_adapter_configuration_invalid');
    }
    this.requesterAgent = options.requesterAgent;
    this.coordinator = options.coordinator;
    this.reader = options.reader;
    this.exporter = options.exporter;
    this.setTimeout = options.timers?.setTimeout || setTimeout;
    this.clearTimeout = options.timers?.clearTimeout || clearTimeout;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
  }

  _authorize(record, { start = false } = {}) {
    assertRecord(record, { start });
    if (record.requesterAgent !== this.requesterAgent) throw adapterError('access_denied');
    return record;
  }

  async start(request) {
    exactObject(request, ['requestId', 'operationType', 'target', 'parameters']);
    const record = await this.coordinator.start(request);
    return this._authorize(record, { start: true });
  }

  async attachAndWait(record, options = {}) {
    this._authorize(record);
    exactObject(options, ['attachmentId', 'signal', 'waitMs', 'onEvent']);
    assertIdentifier(options.attachmentId, 'attachmentId');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw adapterError('invalid_request');
    }
    if (!Number.isSafeInteger(options.waitMs) || options.waitMs <= 0
        || options.waitMs > 24 * 60 * 60_000) {
      throw adapterError('invalid_request');
    }
    if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
      throw adapterError('invalid_request');
    }

    let cursor = 0;
    let detachedReason = null;
    let detachPromise = null;
    let detachFailure = null;
    let detachSucceeded = false;
    let settled = false;
    let attachmentOutcome = null;
    const detachFinished = deferredSignal();
    const detachOnce = (reason) => {
      if (settled || detachPromise) return detachPromise;
      detachedReason = reason;
      detachPromise = this._detachWithinDeadline(
        record.operationId,
        options.attachmentId,
        reason,
      )
        .then((value) => {
          detachSucceeded = true;
          return value;
        })
        .catch((error) => {
          detachFailure = error;
          return null;
        })
        .finally(() => detachFinished.resolve());
      return detachPromise;
    };
    const onAbort = () => { detachOnce('caller_abort'); };
    let timer = null;
    let attachment;
    try {
      try {
        attachment = await this.coordinator.attach(record.operationId, {
          attachmentId: options.attachmentId,
          afterSequence: 0,
          onEvent: (event) => {
            const sequence = event?.eventSequence ?? event?.sequence;
            if (!Number.isSafeInteger(sequence) || sequence < 0) {
              throw adapterError('event_stream_invalid');
            }
            if (sequence <= cursor) return;
            cursor = sequence;
            options.onEvent?.(event);
          },
        });
        if (!attachment || typeof attachment.done?.then !== 'function') {
          throw adapterError('operation_contract_invalid');
        }
        timer = this.setTimeout(() => { detachOnce('attachment_deadline'); }, options.waitMs);
        if (typeof timer?.unref === 'function') timer.unref();
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort, { once: true });
        }
        attachmentOutcome = await Promise.race([attachment.done, detachFinished.promise]);
        if (detachPromise) await detachPromise;
      } catch (error) {
        if (!detachPromise) {
          await detachOnce('attachment_setup_failed');
        }
        throw error;
      }
    } finally {
      settled = true;
      if (timer !== null) this.clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const current = this._authorize(await this.reader.getAuthorized(record.operationId));
    if (TERMINAL_STATES.has(current.state)) {
      return { ...current, attachmentState: 'closed' };
    }
    if (detachFailure) throw attachmentFailure(current, detachFailure);
    const externallyDetached = attachmentOutcome?.state === 'detached';
    if (!detachSucceeded && !externallyDetached) {
      throw attachmentFailure(current, adapterError('attachment_state_unknown'));
    }
    return {
      ...current,
      attachmentState: 'detached',
      detachedReason: detachedReason
        || attachmentOutcome?.reason
        || attachment?.reason
        || 'transport_closed',
    };
  }

  async _detachWithinDeadline(operationId, attachmentId, reason) {
    const attempt = this.detach(operationId, attachmentId, reason);
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = this.setTimeout(() => {
        reject(adapterError('attachment_detach_timeout'));
      }, DETACH_CLEANUP_MS);
      if (typeof timer?.unref === 'function') timer.unref();
    });
    try {
      const detached = await Promise.race([attempt, deadline]);
      if (!detached || detached.state !== 'detached') {
        throw adapterError('attachment_detach_invalid');
      }
      return detached;
    } finally {
      if (timer !== null) this.clearTimeout(timer);
    }
  }

  async getResult(operationId) {
    assertOperationId(operationId);
    const record = this._authorize(await this.reader.getAuthorized(operationId));
    let result = null;
    if (!resultlessTerminal(record)) {
      result = await this.reader.getResultAuthorized(
        operationId,
        record.resultHandle || undefined,
      );
      if (record.resultArtifact && result?.result === null
          && result?.resultHandle === record.resultHandle) result = null;
    }
    return {
      operationId: record.operationId,
      operationType: record.operationType,
      state: record.state,
      result,
      resultHandle: record.resultHandle,
      resultArtifact: record.resultArtifact,
      error: record.error,
      sourceEvidence: record.sourceEvidence,
    };
  }

  async detach(operationId, attachmentId, reason) {
    assertOperationId(operationId);
    assertIdentifier(attachmentId, 'attachmentId');
    assertIdentifier(reason, 'reason');
    return this.coordinator.detach(operationId, { attachmentId, reason });
  }

  async exportStored(request) {
    exactObject(request, [
      'kind', 'requestId', 'operationId', 'resultHandle', 'format', 'fileName',
      'query', 'answer', 'metadata', 'signal',
    ]);
    if (request.kind === 'canonical') {
      return this.exporter.exportResult({
        requesterAgent: this.requesterAgent,
        operationId: request.operationId,
        resultHandle: request.resultHandle,
        format: request.format,
        fileName: request.fileName,
      });
    }
    if (request.kind !== 'ad_hoc') throw adapterError('invalid_request');
    const started = await this.start({
      requestId: request.requestId,
      operationType: 'ad_hoc_export',
      parameters: {
        query: request.query,
        answer: request.answer,
        format: request.format,
        metadata: request.metadata,
      },
    });
    const attachmentId = createAttachmentId(this.randomUUID);
    const terminal = await this.attachAndWait(started, {
      attachmentId,
      signal: request.signal,
      waitMs: QUERY_WAIT_MS,
    });
    if (terminal.attachmentState === 'detached') {
      return {
        operationId: terminal.operationId,
        state: terminal.state,
        attachmentState: 'detached',
      };
    }
    const envelope = await this.getResult(terminal.operationId);
    if (!['complete', 'partial'].includes(envelope.state)
        || !envelope.result || Array.isArray(envelope.result)
        || typeof envelope.result !== 'object') {
      throw adapterError(envelope.error?.code || 'export_failed');
    }
    return {
      operationId: terminal.operationId,
      state: envelope.state,
      resultHandle: envelope.resultHandle,
      canonicalEvidence: false,
      ...envelope.result,
    };
  }
}

function createBrainOperationsCompatibilityAdapter(options) {
  return new BrainOperationsCompatibilityAdapter(options);
}

module.exports = {
  BrainOperationsCompatibilityAdapter,
  DETACH_CLEANUP_MS,
  QUERY_WAIT_MS,
  createBrainOperationsCompatibilityAdapter,
};
