'use strict';

const QUERY_PARAMETER_KEYS = Object.freeze([
  'query', 'mode', 'modelSelection', 'topK', 'priorContext', 'enableSynthesis',
  'includeOutputs', 'includeThoughts', 'includeCoordinatorInsights', 'allowActions',
]);
const PGS_PARAMETER_KEYS = Object.freeze([
  'query', 'mode', 'pgsMode', 'pgsConfig', 'pgsSweep', 'pgsSynth',
  'priorContext', 'allowActions',
]);
const QUERY_MODES = new Set(['quick', 'full', 'expert', 'dive']);
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
  const priorContext = optionalPriorContext(parameters.priorContext);
  const allowActions = optionalBoolean(parameters.allowActions, 'allowActions');
  let pgsMode;
  if (Object.hasOwn(parameters, 'pgsMode')) {
    if (parameters.pgsMode !== 'full') throw invalid('pgsMode is invalid');
    pgsMode = 'full';
  }
  let sweepFraction = 1;
  if (Object.hasOwn(parameters, 'pgsConfig')) {
    assertExactKeys(parameters.pgsConfig, ['sweepFraction'], 'pgsConfig');
    if (Object.hasOwn(parameters.pgsConfig, 'sweepFraction')) {
      sweepFraction = parameters.pgsConfig.sweepFraction;
      if (typeof sweepFraction !== 'number' || !Number.isFinite(sweepFraction)
          || sweepFraction <= 0 || sweepFraction > 1) {
        throw invalid('pgsConfig.sweepFraction is invalid');
      }
    }
  }
  return {
    query,
    mode,
    pgsMode,
    pgsConfig: Object.freeze({ sweepFraction }),
    pgsSweep,
    pgsSynth,
    priorContext,
    allowActions,
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
  return context;
}

function canonicalEvidence(context) {
  return context.sourcePin.getEvidence({
    selectedAgent: context.target.ownerAgent ?? null,
    selectedBrain: context.target.brainId,
    route: typeof context.target.route === 'string' && context.target.route
      ? context.target.route
      : 'brain-operation-worker',
  });
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
            pgsConfig: parameters.pgsConfig,
            pgsSweep: parameters.pgsSweep,
            pgsSynth: parameters.pgsSynth,
          }),
    };

    try {
      const rawResult = await queryEngine.executeEnhancedQuery(parameters.query, options);
      throwIfAborted(context.signal);
      const evidence = canonicalEvidence(context);
      throwIfAborted(context.signal);
      return normalizeEnvelope(rawResult, evidence);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      throw error;
    }
  };
}

module.exports = {
  createQueryOperationExecutor,
};
