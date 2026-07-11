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
const ALLOWED_BODY_KEYS = new Set([
  'query', 'model', 'provider', 'mode', 'includeEvidenceMetrics',
  'enableSynthesis', 'includeCoordinatorInsights', 'includeOutputs', 'includeThoughts',
  'priorContext', 'exportFormat', 'allowActions', 'enablePGS', 'pgsMode',
  'pgsSessionId', 'pgsFullSweep', 'pgsConfig', 'pgsSweepModel', 'synthesis', 'topK',
]);
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
        || body.pgsFullSweep !== undefined || body.synthesis !== undefined
        || body.topK !== undefined) {
      throw typed('invalid_request', 'Legacy PGS provider/session shortcuts are unsupported');
    }
    if (body.pgsMode !== undefined && body.pgsMode !== null && body.pgsMode !== 'full') {
      throw typed('invalid_request', 'pgsMode is invalid');
    }
    parameters.pgsMode = 'full';
    if (body.pgsConfig !== undefined && body.pgsConfig !== null) {
      plainObject(body.pgsConfig, 'pgsConfig');
      if (Reflect.ownKeys(body.pgsConfig).join('\0') !== 'sweepFraction'
          || typeof body.pgsConfig.sweepFraction !== 'number'
          || !Number.isFinite(body.pgsConfig.sweepFraction)
          || body.pgsConfig.sweepFraction <= 0 || body.pgsConfig.sweepFraction > 1) {
        throw typed('invalid_request', 'pgsConfig is invalid');
      }
      parameters.pgsConfig = Object.freeze({ sweepFraction: body.pgsConfig.sweepFraction });
    }
    return Object.freeze({ operationType: 'pgs', parameters: Object.freeze(parameters) });
  }

  if (body.pgsMode !== undefined || body.pgsConfig !== undefined
      || body.pgsSweepModel !== undefined || body.pgsSessionId !== undefined
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

function validateStarted(started, operationType) {
  if (!started || typeof started !== 'object' || Array.isArray(started)
      || !OPERATION_ID_PATTERN.test(started.operationId || '')
      || started.operationType !== operationType
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
      || typeof payload.error.code !== 'string' || payload.error.retryable !== true)) {
    throw typed('operation_contract_invalid', 'Partial operation has no retryable typed error', true);
  }
  if (operationType === 'query') {
    if (payload.result.metadata?.provider !== selected.provider
        || payload.result.metadata?.model !== selected.model) {
      throw typed('provider_model_mismatch', 'Terminal query identity changed');
    }
  } else {
    if (!Array.isArray(payload.result.sweepOutputs)
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

function createLegacyQueryOperationAdapter({
  dashboardOrigin = `http://127.0.0.1:${process.env.HOME23_DASHBOARD_PORT || 5002}`,
  fetchImpl = globalThis.fetch,
  catalogProvider,
  randomUUID = crypto.randomUUID,
} = {}) {
  const origin = String(dashboardOrigin || '').replace(/\/$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)
      || typeof fetchImpl !== 'function' || typeof catalogProvider !== 'function'
      || typeof randomUUID !== 'function') {
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
    try {
      await fetchJson(`/home23/api/brain-operations/${encodeURIComponent(operationId)}/detach`, {
        method: 'POST',
        body: { attachmentId, reason: 'caller_disconnected' },
        signal: new AbortController().signal,
      });
    } catch {}
  }

  return Object.freeze({
    async execute({ brainId, body, signal = new AbortController().signal, onEvent } = {}) {
      if (typeof brainId !== 'string' || !IDENTIFIER_PATTERN.test(brainId)
          || !(signal instanceof AbortSignal)
          || (onEvent !== undefined && typeof onEvent !== 'function')) {
        throw typed('invalid_request', 'Legacy durable query request is invalid');
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
      }), normalized.operationType);
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
  createLegacyQueryOperationAdapter,
  normalizeLegacyQueryRequest,
};
