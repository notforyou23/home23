const os = require('os');

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

function resolveCodexToken(config = {}) {
  config = config || {};
  return process.env.OPENAI_CODEX_AUTH_TOKEN
    || process.env.OPENAI_OAUTH_TOKEN
    || config.providers?.['openai-codex']?.authToken
    || config.providers?.['openai-codex']?.apiKey
    || null;
}

function getOpenAICodexCredentials(config = {}) {
  config = config || {};
  const token = resolveCodexToken(config);

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
    accountId: payload?.https?.['api.openai.com/auth']?.chatgpt_account_id || payload?.sub || null,
  };
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

function buildCodexInputItems({ input = null, query = null, messages = [] } = {}) {
  if (input !== null) {
    return typeof input === 'string' ? [toCodexMessage('user', input)] : input;
  }
  if (query) {
    return [toCodexMessage('user', query)];
  }
  if (messages && messages.length > 0) {
    return messages.map(msg => toCodexMessage(msg.role, msg.content));
  }
  throw new Error('Either input, messages, or query must be provided');
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

function getCodexHeaders(credentials) {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
    'chatgpt-account-id': credentials.accountId || '',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'cosmo-home',
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
    const credentials = getOpenAICodexCredentials(this.config);
    const model = options.model || this.config.providers?.['openai-codex']?.defaultModel || 'gpt-5.5';
    const tools = options.tools || [];
    const body = {
      model,
      store: false,
      stream: true,
      input: buildCodexInputItems(options),
    };

    const instructions = options.systemPrompt ?? options.instructions;
    body.instructions = typeof instructions === 'string' && instructions.trim()
      ? instructions.trim()
      : 'You are a helpful Home23 assistant. Be concise and accurate.';

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = options.tool_choice || options.toolChoice || 'auto';
    }

    const url = `${String(this.baseURL).replace(/\/+$/, '')}/codex/responses`;
    this.logger?.info?.('[OpenAI-Codex] Request', {
      authMode: credentials.authMode,
      model,
      inputItems: Array.isArray(body.input) ? body.input.length : null,
      hasTools: tools.length > 0,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: getCodexHeaders(credentials),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`OpenAI Codex ${response.status}: ${errorText.slice(0, 300)}`);
    }
    if (!response.body) {
      throw new Error('OpenAI Codex response missing body');
    }

    let aggregatedText = '';
    let reasoningSummary = '';
    let finalUsage = {};
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk.split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim());

        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          switch (event.type) {
            case 'response.output_text.delta':
              aggregatedText += event.delta || '';
              break;
            case 'response.output_text.done':
              if (event.text) aggregatedText = event.text;
              break;
            case 'response.reasoning_summary_text.delta':
              reasoningSummary += event.delta || '';
              break;
            case 'response.completed':
              finalUsage = event.response?.usage || finalUsage;
              if (!aggregatedText && event.response) {
                aggregatedText = extractTextFromResponse(event.response);
              }
              break;
            case 'response.failed':
              throw new Error(event.response?.error?.message || 'OpenAI Codex response failed');
            case 'error':
              throw new Error(event.message || event.code || 'OpenAI Codex stream error');
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }

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
  const credentials = getOpenAICodexCredentials(config);

  logger?.info?.('[OpenAI-Codex] Initializing client', {
    authMode: credentials.authMode,
    baseURL: process.env.OPENAI_CODEX_BASE_URL
      || config.providers?.['openai-codex']?.baseURL
      || config.providers?.['openai-codex']?.baseUrl
      || 'https://chatgpt.com/backend-api',
    expiresAt: credentials.expiresAt ? new Date(credentials.expiresAt).toISOString() : null,
    hasAccountId: Boolean(credentials.accountId),
  });

  return new OpenAICodexClient(config, logger);
}

module.exports = {
  decodeJwtPayload,
  buildCodexInputItems,
  getCodexHeaders,
  getOpenAICodexClient,
  getOpenAICodexCredentials,
  isOpenAIOAuthToken,
  OpenAICodexClient,
};
