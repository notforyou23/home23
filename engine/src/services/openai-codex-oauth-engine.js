const os = require('os');
const { randomUUID } = require('node:crypto');
const { responsesReasoning } = require('../../../shared/responses-reasoning.cjs');
const {
  awaitWithCancellation, cancelReadableStreamReader, rethrowCancellation, throwIfAborted,
} = require('../../../shared/research-runtime/lib/provider-execution.js');
const {
  resolveProviderKey,
  isAuthError,
  managedOAuthCredentials,
} = require('../core/provider-credentials');

function isOpenAIOAuthToken(token) {
  return (
    token
    && typeof token === 'string'
    && token.startsWith('eyJ')
    && token.split('.').length === 3
  );
}

function decodeJwtPayload(token) {
  if (!isOpenAIOAuthToken(token)) return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function resolveCodexToken(config = {}, force = false) {
  config = config || {};
  // Read-at-use from Home23's secrets.yaml; configured value and
  // OPENAI_CODEX_AUTH_TOKEN / OPENAI_OAUTH_TOKEN env stay as the floor.
  // `force` drops the resolver cache — the auth-failure path.
  const configured = config.providers?.['openai-codex']?.authToken
    || config.providers?.['openai-codex']?.apiKey;
  return resolveProviderKey('openai-codex', configured, force) || null;
}

function credentialsFromToken(token, accountIdOverride = null) {
  if (!token) {
    throw new Error('No OpenAI Codex OAuth token configured. Refusing to use OPENAI_API_KEY for openai-codex.');
  }

  if (!isOpenAIOAuthToken(token)) {
    throw new Error('OPENAI_CODEX_AUTH_TOKEN is not an OpenAI OAuth JWT. Refusing to use OPENAI_API_KEY for openai-codex.');
  }

  const payload = decodeJwtPayload(token);
  const expiresAt = payload?.exp ? payload.exp * 1000 : null;
  if (expiresAt && expiresAt <= Date.now()) {
    throw new Error('OpenAI Codex OAuth token is expired. Refusing to use OPENAI_API_KEY for openai-codex.');
  }

  return {
    accessToken: token,
    apiKey: token,
    authMode: 'oauth',
    isOAuth: true,
    expiresAt,
    accountId: accountIdOverride
      || payload?.['https://api.openai.com/auth']?.chatgpt_account_id
      || payload?.https?.['api.openai.com/auth']?.chatgpt_account_id
      || payload?.sub
      || null,
  };
}

function getOpenAICodexCredentials(config = {}, force = false) {
  config = config || {};
  return credentialsFromToken(resolveCodexToken(config, force));
}

async function getOpenAICodexCredentialsAtUse(config = {}, options = {}) {
  const managed = await managedOAuthCredentials('openai-codex', {
    force: options.force === true,
    staleAccessToken: options.staleAccessToken,
  });
  if (managed?.accessToken) {
    return credentialsFromToken(managed.accessToken, managed.accountId);
  }
  return getOpenAICodexCredentials(config, options.force === true);
}

function toCodexMessage(role, content) {
  return {
    type: 'message',
    role,
    content: typeof content === 'string'
      ? [{
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: content,
        }]
      : content,
  };
}

function isCodexInstructionRole(role) {
  return role === 'system' || role === 'developer';
}

function extractCodexText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content?.text === 'string') return content.text;
  return '';
}

function extractCodexInstructionText({ input = null, messages = [], instructions = null, systemPrompt = null } = {}) {
  const parts = [];
  const explicit = systemPrompt ?? instructions;

  if (typeof explicit === 'string' && explicit.trim()) {
    parts.push(explicit.trim());
  }

  for (const msg of messages || []) {
    if (!isCodexInstructionRole(msg?.role)) continue;
    const text = extractCodexText(msg.content).trim();
    if (text) parts.push(text);
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isCodexInstructionRole(item?.role)) continue;
      const text = extractCodexText(item.content).trim();
      if (text) parts.push(text);
    }
  }

  return parts.join('\n\n');
}

function sanitizeCodexInputItems(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(item => !isCodexInstructionRole(item?.role));
}

function buildCodexInputItems({ input = null, query = null, messages = [] } = {}) {
  if (input !== null) {
    return sanitizeCodexInputItems(
      typeof input === 'string' ? [toCodexMessage('user', input)] : input
    );
  }
  if (query) {
    return [toCodexMessage('user', query)];
  }
  if (messages && messages.length > 0) {
    return messages
      .filter(msg => !isCodexInstructionRole(msg?.role))
      .map(msg => toCodexMessage(msg.role, msg.content));
  }
  throw new Error('Either input, messages, or query must be provided');
}

function toCodexTool(tool) {
  if (!tool || typeof tool !== 'object') return null;

  // Built-in Responses API tools already have a concrete type. Preserve only
  // the known built-ins; dropping unknowns is safer than sending `type: null`
  // to ChatGPT's codex/responses endpoint and killing the whole branch.
  if (['web_search', 'file_search', 'code_interpreter'].includes(tool.type)) {
    return tool;
  }

  // Anthropic-format cycle tools: { name, description, input_schema }.
  if (tool.name && tool.input_schema) {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    };
  }

  // OpenAI Chat Completions format: { type: 'function', function: {...} }.
  if (tool.type === 'function' && tool.function?.name) {
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    };
  }

  // Responses API function format: { type: 'function', name, parameters }.
  if (tool.type === 'function' && tool.name) {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    };
  }

  return null;
}

function buildCodexTools(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map(toCodexTool).filter(Boolean);
}

function extractTextFromResponse(response) {
  const textParts = [];
  for (const item of response?.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.text) textParts.push(part.text);
      }
    } else if (item.type === 'content' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.text) textParts.push(part.text);
      }
    }
  }
  return textParts.join('\n');
}

function codexUsageMetadata(usage) {
  const metadata = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    const value = usage?.[key];
    if (Number.isSafeInteger(value) && value >= 0) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function getCodexHeaders(credentials) {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
    'chatgpt-account-id': credentials.accountId || '',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'home23',
    'oai-language': 'en-US',
    'User-Agent': `home23 (${os.platform()} ${os.release()}; ${os.arch()})`,
    accept: 'text/event-stream',
  };
}

class OpenAICodexClient {
  constructor(config = {}, logger = null) {
    this.config = config || {};
    this.logger = logger;
    this.baseURL = process.env.OPENAI_CODEX_BASE_URL
      || this.config.providers?.['openai-codex']?.baseURL
      || this.config.providers?.['openai-codex']?.baseUrl
      || 'https://chatgpt.com/backend-api';
  }

  async generate(options = {}) {
    throwIfAborted(options.signal);
    const credentials = await awaitWithCancellation(() => getOpenAICodexCredentialsAtUse(this.config), options.signal);
    try {
      return await this._generateAttempt(options, credentials);
    } catch (error) {
      rethrowCancellation(error, options.signal);
      // One force-fresh retry on auth failure: the token may have rotated in
      // secrets.yaml after the last resolver read. Never loop.
      if (!isAuthError(error)) throw error;
      this.logger?.warn?.('[OpenAI-Codex] Auth failure — refreshing Home23 credentials for one retry', {
        error: error.message,
      });
      const refreshed = await awaitWithCancellation(() => getOpenAICodexCredentialsAtUse(this.config, {
        force: true,
        staleAccessToken: credentials.accessToken,
      }), options.signal);
      return await this._generateAttempt(options, refreshed);
    }
  }

  async _generateAttempt(options = {}, credentials) {
    const { signal } = options;
    throwIfAborted(signal);
    const model = options.model || this.config.providers?.['openai-codex']?.defaultModel || 'gpt-5.5';
    const tools = buildCodexTools(options.tools || []);
    const body = {
      model,
      store: false,
      stream: true,
      input: buildCodexInputItems(options),
    };
    const reasoning = responsesReasoning(model, options.reasoningEffort);
    if (reasoning) body.reasoning = reasoning;

    const instructions = extractCodexInstructionText(options);
    body.instructions = typeof instructions === 'string' && instructions.trim()
      ? instructions.trim()
      : 'You are a helpful Home23 assistant. Be concise and accurate.';

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = options.tool_choice || options.toolChoice || 'auto';
    }

    const url = `${String(this.baseURL).replace(/\/+$/, '')}/codex/responses`;
    const requestId = randomUUID();
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    this.logger?.info?.('[OpenAI-Codex] Request', {
      requestId,
      authMode: credentials.authMode,
      model,
      reasoningEffort: body.reasoning?.effort || null,
      inputItems: Array.isArray(body.input) ? body.input.length : null,
      hasTools: tools.length > 0,
    });

    let aggregatedText = '';
    let reasoningSummary = '';
    let finalUsage = {};
    let reader = null;
    let headersMs = null;
    const decoder = new TextDecoder();
    let buffer = '';
    let terminalEvent = null;
    let firstEventMs = null;
    let firstTextMs = null;
    let terminalMs = null;
    let eventsReceived = 0;

    let readerFailure;
    let failed = false;
    let cancelled = false;
    try {
      const response = await awaitWithCancellation(() => fetch(url, {
        method: 'POST',
        headers: getCodexHeaders(credentials),
        body: JSON.stringify(body),
        signal,
      }), signal);
      headersMs = elapsed();

      if (!response.ok) {
        const errorText = await awaitWithCancellation(() => response.text(), signal).catch(error => {
          rethrowCancellation(error, signal);
          return '';
        });
        throw new Error(`OpenAI Codex ${response.status}: ${errorText.slice(0, 300)}`);
      }
      if (!response.body) {
        throw new Error('OpenAI Codex response missing body');
      }
      reader = response.body.getReader();

      while (!terminalEvent) {
        const { done, value } = await awaitWithCancellation(() => reader.read(), signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator = /\r?\n\r?\n/.exec(buffer);
        while (separator && !terminalEvent) {
          const chunk = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = chunk.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim()).join('\n');
          if (data) {
            if (data === '[DONE]') throw new Error('OpenAI Codex stream ended before response.completed');
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              separator = /\r?\n\r?\n/.exec(buffer);
              continue;
            }
            eventsReceived++;
            firstEventMs ??= elapsed();

            switch (event.type) {
              case 'response.output_text.delta':
                aggregatedText += event.delta || '';
                if (event.delta) firstTextMs ??= elapsed();
                break;
              case 'response.output_text.done':
                if (event.text) aggregatedText = event.text;
                if (event.text) firstTextMs ??= elapsed();
                break;
              case 'response.reasoning_summary_text.delta':
                reasoningSummary += event.delta || '';
                break;
              case 'response.completed':
                terminalEvent = event.type;
                terminalMs = elapsed();
                finalUsage = event.response?.usage || finalUsage;
                if (!aggregatedText && event.response) {
                  aggregatedText = extractTextFromResponse(event.response);
                }
                if (aggregatedText) firstTextMs ??= elapsed();
                break;
              case 'response.incomplete': {
                terminalEvent = event.type;
                terminalMs = elapsed();
                const reason = event.response?.incomplete_details?.reason;
                throw new Error(`OpenAI Codex response incomplete${reason ? ': ' + String(reason).slice(0, 100) : ''}`);
              }
              case 'response.failed':
                terminalEvent = event.type;
                terminalMs = elapsed();
                throw new Error(event.response?.error?.message || 'OpenAI Codex response failed');
              case 'error':
                throw new Error(event.message || event.code || 'OpenAI Codex stream error');
            }
          }
          separator = /\r?\n\r?\n/.exec(buffer);
        }
      }
      // A completed response owns settlement. EOF without it cannot turn a
      // truncated answer or reasoning summary into a successful graph result.
      if (!terminalEvent) throw new Error('OpenAI Codex stream ended before response.completed');
    } catch (error) {
      failed = true;
      cancelled = signal?.aborted || error?.name === 'AbortError';
      readerFailure = signal?.aborted ? signal.reason : error;
      rethrowCancellation(error, signal);
      throw error;
    } finally {
      // Providers may keep SSE open after a terminal event. Release promptly;
      // cancellation itself may also remain pending and must not block Work.
      if (failed || terminalEvent) cancelReadableStreamReader(reader, readerFailure);
      try { reader?.releaseLock?.(); } catch {}
      this.logger?.info?.('[OpenAI-Codex] Response settled', {
        requestId, model, reasoningEffort: body.reasoning?.effort || null,
        outcome: signal?.aborted || cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
        headersMs, firstEventMs, firstTextMs, terminalMs,
        durationMs: elapsed(), terminalEvent, eventsReceived,
        usage: terminalEvent === 'response.completed' ? codexUsageMetadata(finalUsage) : null,
      });
    }
    throwIfAborted(signal);

    if (!aggregatedText && reasoningSummary) {
      aggregatedText = reasoningSummary;
    }

    return {
      content: aggregatedText,
      reasoning: reasoningSummary || undefined,
      model,
      provider: 'openai-codex',
      usage: {
        input_tokens: finalUsage.input_tokens || 0,
        output_tokens: finalUsage.output_tokens || 0,
        total_tokens: finalUsage.total_tokens || ((finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0)),
      },
    };
  }

  async generateWithWebSearch(options = {}) {
    return this.generate({
      ...options,
      tools: [{ type: 'web_search' }, ...(options.tools || [])],
    });
  }

  async generateWithReasoning(options = {}) {
    return this.generate(options);
  }

  async generateFast(options = {}) {
    return this.generate(options);
  }
}

function getOpenAICodexClient(config = {}, logger = null) {
  config = config || {};
  let credentials = null;
  try {
    credentials = getOpenAICodexCredentials(config);
  } catch (error) {
    // Client construction stays lazy so an expired managed access token can
    // refresh inside the first request. Missing/invalid credentials still
    // fail closed there before any Codex API call.
    logger?.warn?.('[OpenAI-Codex] Credential requires refresh or setup', {
      error: error.message,
    });
  }

  logger?.info?.('[OpenAI-Codex] Initializing client', {
    authMode: 'oauth',
    baseURL: process.env.OPENAI_CODEX_BASE_URL
      || config.providers?.['openai-codex']?.baseURL
      || config.providers?.['openai-codex']?.baseUrl
      || 'https://chatgpt.com/backend-api',
    expiresAt: credentials?.expiresAt ? new Date(credentials.expiresAt).toISOString() : null,
    hasAccountId: Boolean(credentials?.accountId),
  });

  return new OpenAICodexClient(config, logger);
}

module.exports = {
  decodeJwtPayload,
  buildCodexInputItems,
  getCodexHeaders,
  getOpenAICodexClient,
  getOpenAICodexCredentials,
  getOpenAICodexCredentialsAtUse,
  isOpenAIOAuthToken,
  OpenAICodexClient,
};
