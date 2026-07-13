'use strict';

const crypto = require('node:crypto');
const {
  PGS_OPERATION_LIMITS,
  QUERY_OPERATION_LIMITS,
} = require('../../lib/brain-operation-limits');

const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const SUCCESS_STATES = new Set(['complete', 'partial']);
const CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_OVERHEAD_BYTES = 256 * 1024;
const MAX_EVENT_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const ALLOWED_BODY_KEYS = new Set([
  'query', 'model', 'provider', 'mode', 'includeEvidenceMetrics',
  'enableSynthesis', 'includeCoordinatorInsights', 'includeOutputs', 'includeThoughts',
  'priorContext', 'exportFormat', 'allowActions', 'enablePGS', 'pgsMode',
  'pgsLevel', 'continueFromOperationId', 'targetPartitionIds', 'pgsSweep', 'pgsSynth',
  'pgsSessionId', 'pgsFullSweep', 'pgsConfig', 'pgsSweepModel', 'synthesis', 'topK',
]);
// HOME23 PATCH — canonical durable PGS accepts named levels, never a caller's
// raw fraction or model-only shortcut.
const PGS_LEVEL_FRACTIONS = Object.freeze({
  skim: 0.10,
  sample: 0.25,
  deep: 0.50,
  full: 1,
});
const PGS_MODES = new Set(['fresh', 'continue', 'targeted']);
const PARTITION_ID_PATTERN = /^(?:c|h)-[A-Za-z0-9._-]{1,253}$/;
const MAX_TARGET_PARTITION_IDS = 256;
const MODE_MAP = Object.freeze({
  quick: 'quick', fast: 'quick',
  full: 'full', normal: 'full',
  expert: 'expert', deep: 'expert',
  dive: 'dive',
});

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function plainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw typed('invalid_request', `${label} must be an object`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw typed('invalid_request', `${label} must be boolean`);
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return 'full';
  if (typeof value !== 'string' || !MODE_MAP[value]) {
    throw typed('invalid_request', 'Legacy query mode is unsupported');
  }
  return MODE_MAP[value];
}

function exactPair(provider, model) {
  const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedProvider || !normalizedModel
      || normalizedProvider.length > 256 || normalizedModel.length > 256) {
    throw typed('provider_model_mismatch', 'Exact provider and model are required');
  }
  return Object.freeze({ provider: normalizedProvider, model: normalizedModel });
}

function exactPairObject(value, label) {
  plainObject(value, label);
  if (Reflect.ownKeys(value).sort().join('\0') !== 'model\0provider') {
    throw typed('provider_model_mismatch', `${label} requires only provider and model`);
  }
  return exactPair(value.provider, value.model);
}

function uniquePairForModel(catalog, model) {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) throw typed('provider_model_mismatch', 'Model is required');
  const candidates = [];
  for (const [provider, config] of Object.entries(catalog?.providers || {})) {
    for (const row of config.models || []) {
      if ((row.kind || 'chat') === 'chat' && row.id === normalizedModel) {
        candidates.push({ provider, model: normalizedModel });
      }
    }
  }
  if (candidates.length === 0) throw typed('model_not_found', `Model not found: ${normalizedModel}`);
  if (candidates.length !== 1) {
    throw typed('model_ambiguous', `Model ${normalizedModel} requires an explicit provider`);
  }
  return Object.freeze(candidates[0]);
}

function validatePriorContext(value) {
  if (value === undefined || value === null) return value;
  plainObject(value, 'priorContext');
  if (Reflect.ownKeys(value).sort().join('\0') !== 'answer\0query'
      || typeof value.query !== 'string' || typeof value.answer !== 'string'
      || value.query.length + value.answer.length > 20_000) {
    throw typed('invalid_request', 'priorContext is invalid');
  }
  return Object.freeze({ query: value.query, answer: value.answer });
}

function validateContinueFromOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw typed('invalid_request', 'continueFromOperationId is invalid');
  }
  return value;
}

function validateTargetPartitionIds(value) {
  if (!Array.isArray(value)
      || value.length === 0
      || value.length > MAX_TARGET_PARTITION_IDS) {
    throw typed('invalid_request', 'targetPartitionIds is invalid');
  }
  const unique = new Set();
  for (const partitionId of value) {
    if (typeof partitionId !== 'string'
        || partitionId.length > 256
        || !PARTITION_ID_PATTERN.test(partitionId)
        || unique.has(partitionId)) {
      throw typed('invalid_request', 'targetPartitionIds is invalid');
    }
    unique.add(partitionId);
  }
  return Object.freeze([...value]);
}

function normalizeLegacyQueryRequest(body, { catalog } = {}) {
  plainObject(body, 'request body');
  if (Reflect.ownKeys(body).some(key => typeof key !== 'string' || !ALLOWED_BODY_KEYS.has(key))) {
    throw typed('invalid_request', 'Legacy query request contains an unsupported field');
  }
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 12_000) {
    throw typed('invalid_request', 'query is invalid');
  }
  const enablePGS = optionalBoolean(body.enablePGS, 'enablePGS') === true;
  const parameters = {
    query: body.query,
    mode: normalizeMode(body.mode),
  };
  const priorContext = validatePriorContext(body.priorContext);
  if (priorContext !== undefined) parameters.priorContext = priorContext;

  if (enablePGS) {
    if (body.model !== undefined || body.provider !== undefined
        || body.pgsSweepModel !== undefined || body.pgsSessionId !== undefined
        || body.pgsFullSweep !== undefined || body.pgsConfig !== undefined
        || body.synthesis !== undefined
        || body.topK !== undefined) {
      throw typed('invalid_request', 'Legacy PGS provider/session shortcuts are unsupported');
    }
    if (!PGS_MODES.has(body.pgsMode)) {
      throw typed('invalid_request', 'pgsMode is invalid');
    }
    if (typeof body.pgsLevel !== 'string'
        || !Object.hasOwn(PGS_LEVEL_FRACTIONS, body.pgsLevel)) {
      throw typed('invalid_request', 'pgsLevel is invalid');
    }
    const hasContinuation = Object.hasOwn(body, 'continueFromOperationId');
    const hasTargets = Object.hasOwn(body, 'targetPartitionIds');
    if (body.pgsMode === 'fresh') {
      if (hasContinuation || hasTargets) {
        throw typed('invalid_request', 'Fresh PGS cannot continue or target partitions');
      }
    } else if (body.pgsMode === 'continue') {
      if (!hasContinuation || hasTargets) {
        throw typed('invalid_request', 'Continue PGS requires one prior operation and no targets');
      }
      parameters.continueFromOperationId = validateContinueFromOperationId(
        body.continueFromOperationId,
      );
    } else {
      if (!hasTargets) {
        throw typed('invalid_request', 'Targeted PGS requires targetPartitionIds');
      }
      parameters.targetPartitionIds = validateTargetPartitionIds(body.targetPartitionIds);
      if (hasContinuation) {
        parameters.continueFromOperationId = validateContinueFromOperationId(
          body.continueFromOperationId,
        );
      }
    }
    parameters.pgsMode = body.pgsMode;
    parameters.pgsLevel = body.pgsLevel;
    parameters.pgsConfig = Object.freeze({
      sweepFraction: PGS_LEVEL_FRACTIONS[body.pgsLevel],
    });
    parameters.pgsSweep = exactPairObject(body.pgsSweep, 'pgsSweep');
    parameters.pgsSynth = exactPairObject(body.pgsSynth, 'pgsSynth');
    return Object.freeze({ operationType: 'pgs', parameters: Object.freeze(parameters) });
  }

  if (body.pgsMode !== undefined || body.pgsLevel !== undefined
      || body.continueFromOperationId !== undefined || body.targetPartitionIds !== undefined
      || body.pgsConfig !== undefined || body.pgsSweep !== undefined
      || body.pgsSynth !== undefined || body.pgsSweepModel !== undefined
      || body.pgsSessionId !== undefined
      || body.pgsFullSweep !== undefined) {
    throw typed('invalid_request', 'PGS fields require enablePGS');
  }
  if (body.provider !== undefined && body.model === undefined) {
    throw typed('provider_model_mismatch', 'Provider requires an exact model');
  }
  if (body.model !== undefined) {
    parameters.modelSelection = body.provider === undefined
      ? uniquePairForModel(catalog, body.model)
      : exactPair(body.provider, body.model);
  }
  for (const key of [
    'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions',
  ]) {
    const normalized = optionalBoolean(body[key], key);
    if (normalized !== undefined) parameters[key] = normalized;
  }
  if (body.topK !== undefined) {
    if (!Number.isSafeInteger(body.topK) || body.topK < 1 || body.topK > 100) {
      throw typed('invalid_request', 'topK is invalid');
    }
    parameters.topK = body.topK;
  }
  return Object.freeze({ operationType: 'query', parameters: Object.freeze(parameters) });
}

async function readBoundedText(response, maximum, signal) {
  if (!response?.body?.getReader) throw typed('operation_transport_invalid', 'Response body is unreadable', true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    if (signal?.aborted) throw signal.reason;
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) throw typed('result_too_large', 'Dashboard response exceeds its byte limit');
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function errorFromResponse(status, payload) {
  const source = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  return typed(
    typeof source?.code === 'string' ? source.code : 'operation_transport_failed',
    typeof source?.message === 'string' ? source.message : `Dashboard request failed (${status})`,
    source?.retryable === true || status >= 500,
  );
}

function validateStarted(started, { operationType, brainId, requesterAgent }) {
  if (!started || typeof started !== 'object' || Array.isArray(started)
      || !OPERATION_ID_PATTERN.test(started.operationId || '')
      || started.operationType !== operationType
      || started.requesterAgent !== requesterAgent
      || started.target?.domain !== 'brain'
      || started.target?.brainId !== brainId
      || !['queued', 'running'].includes(started.state)) {
    throw typed('operation_contract_invalid', 'Durable operation did not start correctly', true);
  }
  return started;
}

function validateSelectedPair(started, operationType) {
  if (operationType === 'query') {
    return exactPair(started.parameters?.modelSelection?.provider, started.parameters?.modelSelection?.model);
  }
  return {
    sweep: exactPair(started.parameters?.pgsSweep?.provider, started.parameters?.pgsSweep?.model),
    synth: exactPair(started.parameters?.pgsSynth?.provider, started.parameters?.pgsSynth?.model),
  };
}

function validateTerminal(payload, { operationId, operationType, selected }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.operationId !== operationId || !TERMINAL_STATES.has(payload.state)) {
    throw typed('operation_contract_invalid', 'Durable operation result is invalid', true);
  }
  if (!SUCCESS_STATES.has(payload.state)) {
    if (!payload.error || typeof payload.error.code !== 'string'
        || typeof payload.error.message !== 'string'
        || typeof payload.error.retryable !== 'boolean') {
      throw typed('operation_contract_invalid', 'Durable failure is untyped', true);
    }
    throw typed(payload.error.code, payload.error.message, payload.error.retryable);
  }
  if (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)
      || payload.resultArtifact !== null) {
    throw typed('operation_contract_invalid', 'Durable success result is invalid', true);
  }
  const answer = payload.result.answer;
  if (payload.state === 'complete' && (payload.error !== null
      || typeof answer !== 'string' || !answer.trim())) {
    throw typed('operation_contract_invalid', 'Complete operation has no validated answer', true);
  }
  if (payload.state === 'partial' && (!payload.error
      || typeof payload.error.code !== 'string'
      || typeof payload.error.message !== 'string'
      || typeof payload.error.retryable !== 'boolean')) {
    throw typed('operation_contract_invalid', 'Partial operation has no typed error', true);
  }
  if (operationType === 'query') {
    if (payload.result.metadata?.provider !== selected.provider
        || payload.result.metadata?.model !== selected.model) {
      throw typed('provider_model_mismatch', 'Terminal query identity changed');
    }
  } else {
    if (!Array.isArray(payload.result.sweepOutputs) || payload.result.sweepOutputs.length === 0
        || payload.result.sweepOutputs.some(row => row?.provider !== selected.sweep.provider
          || row?.model !== selected.sweep.model)) {
      throw typed('provider_model_mismatch', 'Terminal PGS sweep identity changed');
    }
  }
  return Object.freeze({
    ...payload.result,
    operationId,
    state: payload.state,
    resultHandle: payload.resultHandle ?? null,
    resultArtifact: null,
    sourceEvidence: payload.sourceEvidence ?? payload.result.sourceEvidence ?? null,
    ...(payload.error ? { error: payload.error } : {}),
  });
}

function buildLegacyQueryResponse(result, { query, artifactInventory } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof query !== 'string' || !query.trim()
      || !artifactInventory || typeof artifactInventory !== 'object'
      || Array.isArray(artifactInventory)) {
    throw typed('operation_contract_invalid', 'Legacy query response is invalid');
  }
  return {
    ...result,
    query,
    artifactInventory,
  };
}

function createLegacyQueryOperationAdapter({
  dashboardOrigin = `http://127.0.0.1:${process.env.HOME23_DASHBOARD_PORT || 5002}`,
  fetchImpl = globalThis.fetch,
  catalogProvider,
  requesterAgent = null,
  requesterAgentProvider = null,
  randomUUID = crypto.randomUUID,
  cleanupTimeoutMs,
  detachTimeoutMs,
} = {}) {
  const origin = String(dashboardOrigin || '').replace(/\/$/, '');
  const effectiveCleanupTimeoutMs = cleanupTimeoutMs ?? detachTimeoutMs
    ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)
      || typeof fetchImpl !== 'function' || typeof catalogProvider !== 'function'
      || typeof randomUUID !== 'function'
      || (requesterAgent !== null && (typeof requesterAgent !== 'string'
        || !IDENTIFIER_PATTERN.test(requesterAgent)))
      || (requesterAgentProvider !== null && typeof requesterAgentProvider !== 'function')
      || (requesterAgent === null && requesterAgentProvider === null)
      || !Number.isSafeInteger(effectiveCleanupTimeoutMs)
      || effectiveCleanupTimeoutMs < 1 || effectiveCleanupTimeoutMs > 60_000) {
    throw typed('operation_adapter_unavailable', 'Legacy durable query adapter is unavailable', true);
  }

  async function fetchJson(pathname, { method = 'GET', body, signal, maxBytes = CONTROL_RESPONSE_BYTES } = {}) {
    if (signal?.aborted) throw signal.reason;
    const response = await fetchImpl(`${origin}${pathname}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json', 'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const text = await readBoundedText(response, maxBytes, signal);
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch {
      throw typed('operation_transport_invalid', 'Dashboard returned invalid JSON', true);
    }
    if (!response.ok) throw errorFromResponse(response.status, payload);
    return payload;
  }

  async function readEvents(operationId, attachmentId, signal, onEvent) {
    if (signal?.aborted) throw signal.reason;
    const pathname = `/home23/api/brain-operations/${encodeURIComponent(operationId)}/events`
      + `?after=0&attachmentId=${encodeURIComponent(attachmentId)}`;
    const response = await fetchImpl(`${origin}${pathname}`, {
      method: 'GET', headers: { accept: 'text/event-stream' }, signal,
    });
    if (!response.ok) {
      const text = await readBoundedText(response, CONTROL_RESPONSE_BYTES, signal);
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      throw errorFromResponse(response.status, payload);
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw typed('operation_transport_invalid', 'Event stream is unreadable', true);
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_BUFFER_BYTES) {
        throw typed('operation_transport_invalid', 'Event stream frame is too large', true);
      }
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch {
          throw typed('operation_transport_invalid', 'Event stream contained invalid JSON', true);
        }
        if (typeof onEvent === 'function') onEvent(event);
      }
    }
  }

  async function detach(operationId, attachmentId) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(typed(
          'attachment_detach_timeout',
          'Legacy operation detach exceeded its cleanup deadline',
          true,
        ));
        resolve();
      }, effectiveCleanupTimeoutMs);
    });
    const cleanup = Promise.resolve().then(() => fetchJson(
      `/home23/api/brain-operations/${encodeURIComponent(operationId)}/detach`,
      {
        method: 'POST',
        body: { attachmentId, reason: 'caller_disconnected' },
        signal: controller.signal,
      },
    )).catch(() => undefined);
    try {
      await Promise.race([cleanup, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async execute({ brainId, body, signal = new AbortController().signal, onEvent } = {}) {
      if (typeof brainId !== 'string' || !IDENTIFIER_PATTERN.test(brainId)
          || !(signal instanceof AbortSignal)
          || (onEvent !== undefined && typeof onEvent !== 'function')) {
        throw typed('invalid_request', 'Legacy durable query request is invalid');
      }
      const expectedRequesterAgent = requesterAgent ?? await requesterAgentProvider();
      if (typeof expectedRequesterAgent !== 'string'
          || !IDENTIFIER_PATTERN.test(expectedRequesterAgent)) {
        throw typed(
          'provider_configuration_invalid',
          'Legacy durable query requester identity is unavailable',
        );
      }
      const catalog = await catalogProvider();
      const normalized = normalizeLegacyQueryRequest(body, { catalog });
      const requestId = `legacy-query-${randomUUID()}`;
      const started = validateStarted(await fetchJson('/home23/api/brain-operations', {
        method: 'POST',
        body: {
          requestId,
          operationType: normalized.operationType,
          target: { brainId },
          parameters: normalized.parameters,
        },
        signal,
      }), {
        operationType: normalized.operationType,
        brainId,
        requesterAgent: expectedRequesterAgent,
      });
      const selected = validateSelectedPair(started, normalized.operationType);
      const attachmentId = `legacy-attachment-${randomUUID()}`;
      try {
        await readEvents(started.operationId, attachmentId, signal, onEvent);
      } catch (error) {
        await detach(started.operationId, attachmentId);
        if (signal.aborted) throw signal.reason;
        throw error;
      }
      const ceiling = normalized.operationType === 'pgs'
        ? PGS_OPERATION_LIMITS.maxResultBytes : QUERY_OPERATION_LIMITS.maxResultBytes;
      const terminal = await fetchJson(
        `/home23/api/brain-operations/${encodeURIComponent(started.operationId)}/result`,
        { signal, maxBytes: ceiling + RESPONSE_OVERHEAD_BYTES },
      );
      return validateTerminal(terminal, {
        operationId: started.operationId,
        operationType: normalized.operationType,
        selected,
      });
    },
  });
}

module.exports = {
  buildLegacyQueryResponse,
  createLegacyQueryOperationAdapter,
  normalizeLegacyQueryRequest,
};
