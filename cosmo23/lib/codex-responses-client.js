'use strict';

const {
  normalizeProviderCompletion,
  requireCompleteProviderResult,
} = require('./provider-completion');
const {
  awaitWithCancellation,
  reportProviderActivity,
  requireMaxOutputTokens,
  throwIfAborted,
} = require('./provider-execution');

const MAX_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function boundedText(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}…`;
}

class CodexResponsesClient {
  constructor({ fetchImpl = globalThis.fetch, credentialsProvider }) {
    if (typeof fetchImpl !== 'function' || typeof credentialsProvider !== 'function') {
      throw typed('provider_configuration_invalid', 'Codex provider dependencies are unavailable');
    }
    this.fetchImpl = fetchImpl;
    this.credentialsProvider = credentialsProvider;
    this.providerId = 'openai-codex';
  }

  async generate({
    provider,
    model,
    instructions = '',
    input,
    maxOutputTokens,
    signal,
    onChunk,
    onProviderActivity,
  } = {}) {
    if (provider !== this.providerId) {
      throw typed('provider_model_mismatch', 'Codex requires provider openai-codex');
    }
    if (typeof model !== 'string' || !model.trim()) {
      throw typed('model_not_found', 'Codex model is required');
    }
    const outputTokens = requireMaxOutputTokens(maxOutputTokens, this.providerId, model);
    throwIfAborted(signal);

    const credentials = await awaitWithCancellation(
      () => this.credentialsProvider({ signal }), signal,
    );
    if (!credentials?.accessToken) {
      throw typed('provider_unavailable', 'Codex credentials are unavailable', true);
    }
    const response = await awaitWithCancellation(() => this.fetchImpl(
      'https://chatgpt.com/backend-api/codex/responses',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          'content-type': 'application/json',
          'chatgpt-account-id': credentials.accountId || '',
          'openai-beta': 'responses=experimental',
          originator: 'cosmo',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          store: false,
          stream: true,
          instructions,
          input,
          max_output_tokens: outputTokens,
        }),
        signal,
      },
    ), signal);
    if (!response?.ok) {
      const body = await awaitWithCancellation(() => response.text(), signal);
      throw typed(
        'provider_failed',
        `Codex ${response?.status || 'error'}: ${boundedText(body, MAX_ERROR_TEXT_BYTES)}`,
        true,
      );
    }
    if (!response.body?.getReader) {
      throw typed('provider_failed', 'Codex response body is not a readable stream', true);
    }

    let content = '';
    let terminalReceived = false;
    let finishReason = null;
    let hadError = false;
    let streamFailure = null;
    let responseId = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processFrame = (frame) => {
      throwIfAborted(signal);
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        const event = JSON.parse(raw);
        reportProviderActivity(onProviderActivity, { type: event.type });
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta || event.content || '';
          content += delta;
          if (delta && typeof onChunk === 'function') onChunk({ type: 'chunk', text: delta });
        } else if (event.type === 'response.completed') {
          terminalReceived = true;
          finishReason = 'completed';
          responseId = event.response?.id || responseId;
        } else if (event.type === 'response.incomplete') {
          terminalReceived = true;
          finishReason = 'response.incomplete';
          responseId = event.response?.id || responseId;
        } else if (event.type === 'response.failed' || event.type === 'response.cancelled') {
          terminalReceived = true;
          finishReason = event.type;
          hadError = true;
          streamFailure = event.error || event.response?.error || typed(
            'provider_failed', `Codex terminal event: ${event.type}`, true,
          );
          responseId = event.response?.id || responseId;
        }
      }
      throwIfAborted(signal);
    };

    const drainFrames = () => {
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) processFrame(frame);
    };

    try {
      while (true) {
        const next = await awaitWithCancellation(() => reader.read(), signal);
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          throw typed('provider_failed', 'Codex SSE frame exceeds the buffer limit', true);
        }
        drainFrames();
      }
      buffer += decoder.decode();
      drainFrames();
      if (buffer.trim()) processFrame(buffer);
      buffer = '';
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error?.name === 'AbortError') throw error;
      hadError = true;
      streamFailure = error;
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    }

    throwIfAborted(signal);
    const normalized = normalizeProviderCompletion({
      content,
      terminalReceived,
      finishReason,
      hadError,
      error: streamFailure,
      provider: this.providerId,
      model,
      responseId,
    });
    return normalized.status === 'complete'
      ? requireCompleteProviderResult(normalized)
      : normalized;
  }
}

module.exports = { CodexResponsesClient };
