'use strict';

const NORMAL_FINISH_REASONS = new Set([
  'completed',
  'stop',
  'end_turn',
  'stop_sequence',
]);
const ABNORMAL_FINISH_REASONS = new Set([
  'response.incomplete',
  'response.failed',
  'response.cancelled',
  'length',
  'max_tokens',
  'cancelled',
  'failed',
]);
const MAX_OBSERVED_MODEL_BYTES = 512;

class ProviderCompletionError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProviderCompletionError';
    this.code = code;
    this.retryable = options.retryable !== false;
    this.status = options.status || 'failed';
    this.result = options.result || null;
  }
}

function isErrorPayload(content) {
  return /^\s*\[Error:/i.test(String(content || ''));
}

function normalizeObservedModel(value) {
  if (typeof value !== 'string') return null;
  const observed = value.trim();
  if (!observed || Buffer.byteLength(observed, 'utf8') > MAX_OBSERVED_MODEL_BYTES
      || /[\u0000-\u001f\u007f]/.test(observed)) return null;
  return observed;
}

function normalizeProviderCompletion(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const content = String(source.content || '').trim();
  const finishReason = source.finishReason == null ? null : String(source.finishReason);
  const terminalReceived = source.terminalReceived === true;
  const abnormal = finishReason && ABNORMAL_FINISH_REASONS.has(finishReason);
  const normal = finishReason && NORMAL_FINISH_REASONS.has(finishReason);
  const terminalIncomplete = !terminalReceived || abnormal || !normal || !content;
  const derivedIncomplete = source.hadError === false
    && source.error?.code === 'provider_incomplete'
    && terminalIncomplete;
  const hadError = source.hadError === true
    || (source.error != null && !derivedIncomplete)
    || source.errorType != null;
  const errorPayload = isErrorPayload(content);

  let status = 'complete';
  let code = null;
  if (hadError || errorPayload) {
    status = content && !errorPayload ? 'partial' : 'failed';
    code = 'provider_failed';
  } else if (terminalIncomplete) {
    status = content ? 'partial' : 'failed';
    code = 'provider_incomplete';
  }

  return {
    status,
    content,
    terminalReceived,
    finishReason,
    hadError,
    error: code ? {
      code,
      message: source.error?.message
        || source.errorType
        || `Provider ended with ${finishReason || 'no terminal event'}`,
      retryable: source.retryable !== false && source.error?.retryable !== false,
    } : null,
    usage: source.usage || null,
    provider: source.provider || null,
    model: source.model || null,
    observedModel: normalizeObservedModel(source.observedModel ?? source.wireModel),
    responseId: source.responseId || null,
    reasoning: source.reasoning || null,
    output: source.output || null,
    webSearchSources: source.webSearchSources || [],
    citations: source.citations || [],
  };
}

function requireCompleteProviderResult(input) {
  const result = normalizeProviderCompletion(input);
  if (result.status !== 'complete') {
    throw new ProviderCompletionError(
      result.error?.code || 'provider_failed',
      result.error?.message || 'Provider did not complete normally',
      {
        retryable: result.error?.retryable,
        status: result.status,
        result,
      },
    );
  }
  return result;
}

function assertProviderResultIdentity(result, provider, model) {
  const expectedProvider = typeof provider === 'string' ? provider.trim() : '';
  const expectedModel = typeof model === 'string' ? model.trim() : '';
  if (!expectedProvider || !expectedModel
      || result?.provider !== expectedProvider
      || result?.model !== expectedModel) {
    throw new ProviderCompletionError(
      'provider_model_mismatch',
      'Provider completion identity does not match the selected provider/model pair',
      { retryable: false, status: 'failed', result: result || null },
    );
  }
  return result;
}

module.exports = {
  ProviderCompletionError,
  assertProviderResultIdentity,
  normalizeProviderCompletion,
  requireCompleteProviderResult,
};
