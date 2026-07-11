'use strict';

const crypto = require('node:crypto');

const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');

const PROVIDER_CALL_ID = 'research_compile';
const PHASE = 'research_compile';
const MAX_PROVIDER_EVENT_TYPE_BYTES = 128;
const MAX_PROVIDER_EVENT_AT_BYTES = 64;

function adapterError(code, message = code, retryable = false, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    retryable,
  });
}

function throwIfAborted(signal) {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    throw signal.reason || adapterError('operation_cancelled', 'Operation cancelled');
  }
}

function safeProviderEventType(value) {
  if (typeof value !== 'string' || !value
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_EVENT_TYPE_BYTES) return undefined;
  return value;
}

function safeProviderEventAt(value) {
  if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_EVENT_AT_BYTES) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  try {
    if (new Date(parsed).toISOString() !== value) return undefined;
  } catch {
    return undefined;
  }
  return value;
}

function validateContext(context) {
  if (!context || Array.isArray(context) || typeof context !== 'object'
      || context.operationType !== 'research_compile'
      || typeof context.operationId !== 'string'
      || !context.operationId
      || !(context.signal instanceof AbortSignal)
      || typeof context.reportEvent !== 'function'
      || !context.sourcePin
      || typeof context.sourcePin.getEvidence !== 'function') {
    throw adapterError('invalid_request', 'Authorized research compile context is required');
  }
  const parameters = context.parameters;
  if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') {
    throw adapterError('invalid_request', 'Research compile parameters are required');
  }
  for (const key of [
    'provider', 'providerId', 'model', 'modelId', 'modelSelection',
    'output', 'outputFile', 'outputPath', 'outputRoot',
  ]) {
    if (Object.hasOwn(parameters, key)) {
      throw adapterError('provider_model_mismatch', 'Research compile provider and output are server-owned');
    }
  }
  return parameters;
}

function validateWriter(writer) {
  if (!writer || Array.isArray(writer) || typeof writer !== 'object'
      || typeof writer.writeAtomic !== 'function') {
    throw adapterError('output_boundary_invalid', 'Prevalidated requester writer is required');
  }
  return writer;
}

function normalizePair(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || typeof value.provider !== 'string' || !value.provider.trim()
      || typeof value.model !== 'string' || !value.model.trim()) {
    throw adapterError('model_assignment_invalid', 'Exact research compile provider/model is required');
  }
  return Object.freeze({ provider: value.provider.trim(), model: value.model.trim() });
}

function normalizeCapabilities(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0
      || !Number.isSafeInteger(value.providerStallMs) || value.providerStallMs <= 0) {
    throw adapterError('model_capability_missing', 'Research compile model capabilities are invalid');
  }
  return Object.freeze({
    maxOutputTokens: value.maxOutputTokens,
    providerStallMs: value.providerStallMs,
  });
}

function outputBasename(operationId) {
  const digest = crypto.createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 24);
  return `research-compile-${digest}.md`;
}

function createResearchCompileProviderAdapter({
  resolveConfiguredPair,
  getExactProviderClient,
  requireCompleteProviderResult,
  getModelCapabilities,
} = {}) {
  for (const [name, fn] of Object.entries({
    resolveConfiguredPair,
    getExactProviderClient,
    requireCompleteProviderResult,
    getModelCapabilities,
  })) {
    if (typeof fn !== 'function') {
      throw adapterError('worker_configuration_invalid', `${name} is required`);
    }
  }

  return async function compileSectionWithProvider({
    context,
    sectionContent,
    sectionSelection,
    sourceEvidence,
    writer,
  } = {}) {
    const parameters = validateContext(context);
    validateWriter(writer);
    throwIfAborted(context.signal);
    const pair = normalizePair(await resolveConfiguredPair());
    const capabilities = normalizeCapabilities(
      await getModelCapabilities(pair.provider, pair.model),
    );
    const client = await getExactProviderClient(pair.provider, pair.model);
    if (!client || typeof client.generate !== 'function') {
      throw adapterError('provider_unavailable', 'Research compile provider is unavailable', true);
    }
    if (client.providerId && client.providerId !== pair.provider) {
      throw adapterError('provider_model_mismatch', 'Research compile provider identity mismatch');
    }

    let input;
    try {
      input = canonicalJson({
        focus: typeof parameters.focus === 'string' ? parameters.focus : '',
        sectionSelection,
        sectionContent,
        sourceEvidence: sourceEvidence || context.sourcePin.getEvidence(),
      });
    } catch (error) {
      throw adapterError('invalid_request', 'Research compile source projection is invalid', false, error);
    }
    const instructions = [
      'Compile the supplied pinned Home23 research evidence into a concise Markdown artifact.',
      'Separate observed evidence from inference, preserve uncertainty, and do not invent coverage.',
      'Return only the Markdown artifact body.',
    ].join(' ');
    const baseEvent = Object.freeze({
      phase: PHASE,
      provider: pair.provider,
      model: pair.model,
      providerCallId: PROVIDER_CALL_ID,
    });
    context.reportEvent({
      type: 'provider_selected',
      ...baseEvent,
      providerStallMs: capabilities.providerStallMs,
    });

    let outcome = 'failed';
    try {
      const raw = await client.generate({
        provider: pair.provider,
        model: pair.model,
        instructions,
        input,
        maxOutputTokens: capabilities.maxOutputTokens,
        signal: context.signal,
        onProviderActivity(child = {}) {
          throwIfAborted(context.signal);
          const providerEventType = safeProviderEventType(child?.type);
          const providerEventAt = safeProviderEventAt(child?.at);
          context.reportEvent({
            type: 'provider_activity',
            ...baseEvent,
            ...(providerEventType ? { providerEventType } : {}),
            ...(providerEventAt ? { providerEventAt } : {}),
          });
        },
      });
      throwIfAborted(context.signal);
      const complete = requireCompleteProviderResult(raw);
      throwIfAborted(context.signal);
      const content = String(complete?.content || '').trim();
      if (!content) {
        throw adapterError('provider_incomplete', 'Research compile provider returned no content', true);
      }
      const published = await writer.writeAtomic(
        outputBasename(context.operationId),
        Buffer.from(`${content}\n`, 'utf8'),
      );
      throwIfAborted(context.signal);
      if (!published || typeof published.relativePath !== 'string'
          || !published.relativePath || published.relativePath.startsWith('/')
          || published.relativePath.includes('..')) {
        throw adapterError('output_boundary_changed', 'Requester writer returned an invalid result path');
      }
      outcome = 'complete';
      const evidence = sourceEvidence || context.sourcePin.getEvidence();
      return {
        state: 'complete',
        result: {
          provider: pair.provider,
          model: pair.model,
          relativePath: published.relativePath,
          bytes: published.bytes,
          sectionSelection,
          sourceEvidence: evidence,
        },
        resultArtifact: null,
        error: null,
        sourceEvidence: evidence,
      };
    } catch (error) {
      if (context.signal.aborted) {
        outcome = 'cancelled';
        throw context.signal.reason || error;
      }
      throw error;
    } finally {
      context.reportEvent({
        type: 'provider_call_terminal',
        ...baseEvent,
        outcome,
      });
    }
  };
}

module.exports = {
  createResearchCompileProviderAdapter,
  safeProviderEventAt,
  safeProviderEventType,
};
