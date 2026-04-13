/**
 * Local Agent Adapter
 *
 * Connects to a local agent process via HTTP+SSE.
 * The agent provides LLM reasoning; evobrew provides tools.
 * Protocol: POST request with messages+tools, SSE response with UnifiedChunk events.
 */

const { ProviderAdapter } = require('./base.js');
const { ErrorTypes, createError } = require('../types/unified.js');

class LocalAgentAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super(config);
    this._id = config.id || 'local-agent';
    this._name = config.name || 'Local Agent';
    this._url = config.url;
    this._endpoint = config.endpoint || '/api/chat';
    this._apiKey = config.apiKey;
    this._capabilities = {
      tools: true,
      vision: false,
      thinking: false,
      streaming: true,
      caching: false,
      maxOutputTokens: config.capabilities?.maxOutputTokens || 64000,
      contextWindow: config.capabilities?.contextWindow || 128000,
      ...config.capabilities
    };
  }

  get id() { return this._id; }
  get name() { return this._name; }
  get capabilities() { return this._capabilities; }

  getAvailableModels() { return [this._id]; }

  supportsModel(modelId) {
    return modelId === this._id || modelId === this._name.toLowerCase();
  }

  _initClient() {
    // No SDK client — we use native fetch
    this._client = { url: this._url, endpoint: this._endpoint };
  }

  convertTools(tools) {
    // Pass through — agents accept JSON Schema (Anthropic format)
    return tools;
  }

  parseToolCalls(response) {
    return response?.toolCalls || [];
  }

  normalizeResponse(response) {
    return response;
  }

  async createMessage(request) {
    const chunks = [];
    for await (const chunk of this.streamMessage(request)) {
      chunks.push(chunk);
    }
    let text = '';
    const toolCalls = [];
    let currentTool = null;

    for (const chunk of chunks) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
      if (chunk.type === 'tool_use_start') {
        currentTool = { id: chunk.toolId, name: chunk.toolName, arguments: '' };
      }
      if (chunk.type === 'tool_use_delta' && currentTool) {
        currentTool.arguments += chunk.argumentsDelta || '';
      }
      if (chunk.type === 'tool_use_end' && currentTool) {
        try { currentTool.arguments = JSON.parse(currentTool.arguments); } catch (_) {}
        toolCalls.push(currentTool);
        currentTool = null;
      }
    }

    return {
      content: text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 }
    };
  }

  async *streamMessage(request) {
    const url = `${this._url}${this._endpoint}`;
    console.log(`[LocalAgent:${this._id}] POST ${url} (messages: ${request.messages?.length}, tools: ${request.tools?.length})`);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };
    if (this._apiKey) {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }

    const body = JSON.stringify({
      messages: request.messages,
      tools: request.tools || [],
      model: request.model || this._id,
      maxTokens: request.maxTokens || 64000,
      temperature: request.temperature ?? 0.1,
      systemPrompt: request.systemPrompt || ''
    });

    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      throw createError({
        type: ErrorTypes.SERVER,
        message: `Agent "${this._name}" at ${this._url} is not reachable: ${err.message}`,
        retryable: false,
        originalError: err
      });
    }

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch (_) {}
      let errorType = ErrorTypes.SERVER;
      if (response.status === 401 || response.status === 403) errorType = ErrorTypes.AUTH;
      if (response.status === 429) errorType = ErrorTypes.RATE_LIMIT;
      throw createError({
        type: errorType,
        message: `Agent "${this._name}" returned ${response.status}: ${errorBody}`,
        retryable: errorType === ErrorTypes.RATE_LIMIT || errorType === ErrorTypes.SERVER
      });
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const chunk = JSON.parse(data);
            yield chunk;
          } catch (parseErr) {
            console.warn(`[LocalAgent:${this._id}] Failed to parse SSE chunk:`, data);
          }
        }
      }
    }

    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data);
        } catch (_) {}
      }
    }
  }

  isRateLimitError(error) {
    return error?.type === ErrorTypes.RATE_LIMIT || error?.status === 429;
  }

  isServerError(error) {
    return error?.type === ErrorTypes.SERVER || (error?.status >= 500 && error?.status < 600);
  }

  isAuthError(error) {
    return error?.type === ErrorTypes.AUTH || error?.status === 401 || error?.status === 403;
  }
}

module.exports = { LocalAgentAdapter };
