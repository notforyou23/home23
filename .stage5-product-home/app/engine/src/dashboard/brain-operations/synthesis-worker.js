'use strict';

const {
  assertOperationId,
} = require('./operation-contract.js');

const ALLOWED_PARAMETER_KEYS = new Set(['trigger', 'reason', 'provider', 'model']);

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function bounded(value, label, maxBytes = 1024) {
  if (typeof value !== 'string'
      || value.trim() !== value
      || value.length === 0
      || /[\u0000-\u001f\u007f]/.test(value)
      || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw typed('invalid_request', `${label} is invalid`);
  }
  return value;
}

function sourceEvidence(context) {
  return typeof context.sourcePin?.getEvidence === 'function'
    ? context.sourcePin.getEvidence({ route: 'synthesis-operation' })
    : context.sourcePin?.evidence || null;
}

function isCancellation(error, signal) {
  if (signal?.aborted) return error === signal.reason;
  return Boolean(error?.name === 'AbortError' || error?.code === 'cancelled');
}

function exactKeys(value, expected) {
  const keys = Reflect.ownKeys(value || {});
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function validateSynthesisResult(result, context, selection) {
  const fields = [
    'generationMarker', 'generatedAt', 'sourceRevision', 'provider', 'model',
    'operationId', 'brainStateSha256',
  ];
  if (!result || Array.isArray(result) || typeof result !== 'object'
      || !exactKeys(result, fields)
      || result.operationId !== context.operationId
      || result.provider !== selection.provider
      || result.model !== selection.model
      || !Number.isSafeInteger(result.sourceRevision)
      || result.sourceRevision < 0
      || result.sourceRevision !== context.sourcePin?.revision
      || !new RegExp(`^generation-${result.sourceRevision}-[a-f0-9]{24}$`).test(result.generationMarker)
      || !/^sha256:[a-f0-9]{64}$/.test(result.brainStateSha256)
      || typeof result.generatedAt !== 'string') {
    throw typed('worker_result_invalid', 'Synthesis result is invalid');
  }
  const generatedAt = Date.parse(result.generatedAt);
  if (!Number.isFinite(generatedAt)
      || new Date(generatedAt).toISOString() !== result.generatedAt) {
    throw typed('worker_result_invalid', 'Synthesis generatedAt is invalid');
  }
  return result;
}

function validateContext(context, selection) {
  if (!context || Array.isArray(context) || typeof context !== 'object') {
    throw typed('worker_context_invalid', 'Synthesis worker context is required');
  }
  assertOperationId(context.operationId);
  if (context.operationType !== 'synthesis') {
    throw typed('access_denied', 'Only synthesis operations are accepted');
  }
  const target = context.target;
  if (!target || target.domain !== 'brain'
      || target.accessMode !== 'own'
      || target.ownerAgent !== context.requesterAgent
      || target.kind !== 'resident'
      || target.lifecycle !== 'resident') {
    throw typed('access_denied', 'Synthesis is restricted to the requester own resident brain');
  }
  const parameters = context.parameters;
  if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') {
    throw typed('invalid_request', 'Synthesis parameters are required');
  }
  for (const key of Reflect.ownKeys(parameters)) {
    if (typeof key !== 'string' || !ALLOWED_PARAMETER_KEYS.has(key)) {
      throw typed('invalid_request', 'Synthesis parameters contain an unsupported field');
    }
  }
  const provider = bounded(parameters.provider, 'provider', 256);
  const model = bounded(parameters.model, 'model', 256);
  if (provider !== selection.provider || model !== selection.model) {
    throw typed('provider_model_mismatch', 'Synthesis worker provider/model mismatch');
  }
  if (!context.sourcePin
      || context.sourcePin.descriptor?.canonicalRoot !== target.canonicalRoot) {
    throw typed('source_changed', 'Synthesis source pin does not match the target', true);
  }
  if (typeof context.claimSynthesisCompletion !== 'function') {
    throw typed('worker_context_invalid', 'Durable synthesis completion claim is required');
  }
  const operationControl = context.operationControl;
  if (!operationControl || Array.isArray(operationControl)
      || typeof operationControl !== 'object'
      || !exactKeys(operationControl, ['hardDeadlineAt'])) {
    throw typed('worker_context_invalid', 'Synthesis hard deadline is required');
  }
  const hardDeadline = Date.parse(operationControl.hardDeadlineAt);
  if (!Number.isFinite(hardDeadline)
      || new Date(hardDeadline).toISOString() !== operationControl.hardDeadlineAt) {
    throw typed('worker_context_invalid', 'Synthesis hard deadline is invalid');
  }
  const trigger = parameters.trigger === undefined
    ? (parameters.reason === undefined ? 'manual' : bounded(parameters.reason, 'reason'))
    : bounded(parameters.trigger, 'trigger', 256);
  if (parameters.reason !== undefined) bounded(parameters.reason, 'reason');
  return { trigger, hardDeadlineAt: operationControl.hardDeadlineAt };
}

function failureEnvelope(error, context) {
  const message = typeof error?.message === 'string'
    ? error.message.slice(0, 4096)
    : 'Synthesis failed';
  return {
    state: 'failed',
    result: null,
    resultArtifact: null,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'synthesis_failed',
      message,
      retryable: error?.retryable === true,
    },
    sourceEvidence: sourceEvidence(context),
  };
}

function createSynthesisWorker({ agent, selection } = {}) {
  if (!agent || typeof agent.runOperation !== 'function') {
    throw typed('synthesis_configuration_invalid', 'Synthesis agent is required');
  }
  const fixedSelection = Object.freeze({
    provider: bounded(selection?.provider, 'provider', 256),
    model: bounded(selection?.model, 'model', 256),
  });

  return async function executeSynthesis(context) {
    try {
      const { trigger, hardDeadlineAt } = validateContext(context, fixedSelection);
      if (context.signal?.aborted) throw context.signal.reason;
      const result = validateSynthesisResult(await agent.runOperation({
        operationId: context.operationId,
        trigger,
        sourcePin: context.sourcePin,
        signal: context.signal || null,
        onEvent: context.reportEvent || null,
        claimCompletion: context.claimSynthesisCompletion,
        hardDeadlineAt,
      }), context, fixedSelection);
      return {
        state: 'complete',
        result,
        resultArtifact: null,
        error: null,
        sourceEvidence: sourceEvidence(context),
      };
    } catch (error) {
      if (isCancellation(error, context?.signal)) {
        if (context?.signal?.aborted) throw context.signal.reason;
        throw error;
      }
      return failureEnvelope(error, context || {});
    }
  };
}

module.exports = {
  createSynthesisWorker,
  validateSynthesisResult,
  validateSynthesisWorkerContext: validateContext,
};
