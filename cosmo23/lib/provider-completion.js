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

function normalizeProviderCompletion(input = {}) {
  const content = String(input.content || '').trim();
  const finishReason = input.finishReason == null ? null : String(input.finishReason);
  const terminalReceived = input.terminalReceived === true;
  const hadError = input.hadError === true;
  const abnormal = finishReason && ABNORMAL_FINISH_REASONS.has(finishReason);
  const normal = finishReason && NORMAL_FINISH_REASONS.has(finishReason);
  const errorPayload = isErrorPayload(content);

  let status = 'complete';
  let code = null;
  if (hadError || errorPayload) {
    status = content && !errorPayload ? 'partial' : 'failed';
    code = 'provider_failed';
  } else if (!terminalReceived || abnormal || !normal || !content) {
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
      message: input.error?.message
        || input.errorType
        || `Provider ended with ${finishReason || 'no terminal event'}`,
      retryable: input.retryable !== false,
    } : null,
    usage: input.usage || null,
    provider: input.provider || null,
    model: input.model || null,
    responseId: input.responseId || null,
    reasoning: input.reasoning || null,
    output: input.output || null,
    webSearchSources: input.webSearchSources || [],
    citations: input.citations || [],
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

module.exports = {
  ProviderCompletionError,
  normalizeProviderCompletion,
  requireCompleteProviderResult,
};
