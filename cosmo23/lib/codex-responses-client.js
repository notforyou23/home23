'use strict';

const {
  normalizeProviderCompletion,
  requireCompleteProviderResult,
} = require('./provider-completion');
const {
  awaitWithCancellation,
  cancelReadableStreamReader,
  createUtf8OutputBudget,
  reportProviderActivity,
  requireMaxOutputBytes,
  requireMaxOutputTokens,
  rethrowCancellation,
  rethrowNonRetryable,
  resultTooLarge,
  throwIfAborted,
} = require('./provider-execution');

const MAX_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_TOOL_CALLS = 4096;

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
    maxOutputBytes,
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
    const outputBytes = requireMaxOutputBytes(maxOutputBytes, this.providerId, model);
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
    let observedModel = model;
    let reasoning = '';
    const toolCalls = new Map();
    const outputBudget = createUtf8OutputBudget(outputBytes, 'Provider output');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const sseBudget = createUtf8OutputBudget(MAX_SSE_BUFFER_BYTES, 'Codex SSE frame');

    const toolCallFor = (event) => {
      const id = String(
        event.item_id ?? event.call_id ?? event.output_index ?? 0,
      );
      let toolCall = toolCalls.get(id);
      if (!toolCall) {
        if (toolCalls.size >= MAX_STREAM_TOOL_CALLS) {
          throw resultTooLarge('Provider tool call', outputBytes);
        }
        toolCall = {
          type: 'function_call',
          id,
          call_id: event.call_id || null,
          name: event.name || '',
          arguments: '',
        };
        outputBudget.reserve(`tool-${id}-structure`, 64, 'Provider tool call');
        outputBudget.set(`tool-${id}-id`, id, 'Provider tool call');
        toolCalls.set(id, toolCall);
      }
      if (event.call_id) {
        toolCall.call_id = outputBudget.set(
          `tool-${id}-call-id`, event.call_id, 'Provider tool call',
        );
      }
      if (event.name) {
        toolCall.name = outputBudget.set(
          `tool-${id}-name`, event.name, 'Provider tool call',
        );
      }
      return toolCall;
    };

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
          content = outputBudget.append(
            'content', content, delta, 'Provider content',
          );
          if (delta && typeof onChunk === 'function') onChunk({ type: 'chunk', text: delta });
        } else if (event.type === 'response.output_text.done' && event.text) {
          content = outputBudget.set('content', event.text, 'Provider content');
        } else if (event.type === 'response.reasoning_summary_text.delta') {
          reasoning = outputBudget.append(
            'reasoning', reasoning, event.delta || '', 'Provider reasoning',
          );
        } else if (event.type === 'response.reasoning_summary_text.done' && event.text) {
          reasoning = outputBudget.set('reasoning', event.text, 'Provider reasoning');
        } else if (event.type === 'response.function_call_arguments.delta') {
          const toolCall = toolCallFor(event);
          toolCall.arguments = outputBudget.append(
            `tool-${toolCall.id}-arguments`, toolCall.arguments,
            event.delta || '', 'Provider tool call',
          );
        } else if (event.type === 'response.function_call_arguments.done') {
          const toolCall = toolCallFor(event);
          toolCall.arguments = outputBudget.set(
            `tool-${toolCall.id}-arguments`, event.arguments || toolCall.arguments,
            'Provider tool call',
          );
        } else if (event.type === 'response.completed') {
          terminalReceived = true;
          finishReason = 'completed';
          responseId = event.response?.id || responseId;
          observedModel = event.response?.model || observedModel;
        } else if (event.type === 'response.incomplete') {
          terminalReceived = true;
          finishReason = 'response.incomplete';
          responseId = event.response?.id || responseId;
          observedModel = event.response?.model || observedModel;
        } else if (event.type === 'response.failed' || event.type === 'response.cancelled') {
          terminalReceived = true;
          finishReason = event.type;
          hadError = true;
          streamFailure = event.error || event.response?.error || typed(
            'provider_failed', `Codex terminal event: ${event.type}`, true,
          );
          responseId = event.response?.id || responseId;
          observedModel = event.response?.model || observedModel;
        } else if (event.type === 'response.created') {
          responseId = event.response?.id || responseId;
          observedModel = event.response?.model || observedModel;
        }
      }
      throwIfAborted(signal);
    };

    const appendSse = (text) => {
      buffer = sseBudget.append('frame', buffer, text, 'Codex SSE frame');
    };

    const feedSse = (text) => {
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset);
        if (newline === -1) {
          appendSse(text.slice(offset));
          break;
        }
        appendSse(text.slice(offset, newline + 1));
        if (buffer.endsWith('\n\n') || buffer.endsWith('\r\n\r\n')) {
          const delimiterBytes = buffer.endsWith('\r\n\r\n') ? 4 : 2;
          const frame = buffer.slice(0, -delimiterBytes);
          buffer = '';
          sseBudget.clear('frame');
          processFrame(frame);
        }
        offset = newline + 1;
      }
    };

    let readerFailure = null;
    try {
      while (true) {
        const next = await awaitWithCancellation(() => reader.read(), signal);
        if (next.done) break;
        feedSse(decoder.decode(next.value, { stream: true }));
      }
      feedSse(decoder.decode());
      if (buffer.trim()) processFrame(buffer);
      buffer = '';
      sseBudget.clear('frame');
    } catch (error) {
      readerFailure = signal?.aborted ? signal.reason : error;
      rethrowCancellation(error, signal);
      rethrowNonRetryable(error);
      hadError = true;
      streamFailure = error;
    } finally {
      if (readerFailure) cancelReadableStreamReader(reader, readerFailure);
      try {
        reader.releaseLock();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (!readerFailure) throw error;
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
      observedModel,
      responseId,
      reasoning: reasoning || null,
      output: toolCalls.size ? [...toolCalls.values()] : null,
    });
    return normalized.status === 'complete'
      ? requireCompleteProviderResult(normalized)
      : normalized;
  }
}

module.exports = { CodexResponsesClient };
