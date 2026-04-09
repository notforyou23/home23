/**
 * Anthropic Provider Adapter
 *
 * Adapter for Anthropic's Claude models using the official SDK.
 * Claude uses JSON Schema natively for tools, so minimal conversion is needed.
 *
 * Supports both API keys and OAuth tokens (via stealth mode).
 * 
 * COSMO IDE Integration:
 * This adapter integrates with COSMO IDE's existing anthropic-oauth.js service
 * for OAuth token management. The service handles:
 * - Token import from Claude CLI (~/.claude/auth.json)
 * - Encrypted database storage
 * - Token caching and expiry tracking
 */

const Anthropic = require('@anthropic-ai/sdk');
const { ProviderAdapter } = require('./base.js');
const {
  getCachedProviderModels,
  setCachedProviderModels,
  sortDiscoveredModels
} = require('../model-catalog.js');
const {
  createResponse,
  StopReasons,
  extractText
} = require('../types/unified.js');

// Import COSMO IDE's existing OAuth service
// This provides getAnthropicApiKey(), prepareSystemPrompt(), isOAuthToken()
let anthropicOAuth = null;
try {
  anthropicOAuth = require('../../services/anthropic-oauth.js');
} catch (e) {
  console.warn('[AnthropicAdapter] Could not load anthropic-oauth.js service, OAuth support disabled');
}

// Fallback stealth mode headers if OAuth service not available
const CLAUDE_CODE_VERSION = '2.1.32';

function getStealthHeaders() {
  // Prefer OAuth service's headers (single source of truth for version)
  if (anthropicOAuth?.getStealthHeaders) {
    return anthropicOAuth.getStealthHeaders();
  }
  return {
    'accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
    'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    'x-app': 'cli'
  };
}

function isOAuthToken(token) {
  if (anthropicOAuth?.isOAuthToken) {
    return anthropicOAuth.isOAuthToken(token);
  }
  return token && (token.includes('sk-ant-oauth') || token.includes('sk-ant-oat'));
}

/**
 * @typedef {import('../types/unified.js').UnifiedRequest} UnifiedRequest
 * @typedef {import('../types/unified.js').UnifiedResponse} UnifiedResponse
 * @typedef {import('../types/unified.js').UnifiedChunk} UnifiedChunk
 * @typedef {import('../types/unified.js').UnifiedTool} UnifiedTool
 * @typedef {import('../types/unified.js').UnifiedToolCall} UnifiedToolCall
 * @typedef {import('../types/unified.js').ProviderCapabilities} ProviderCapabilities
 */

class AnthropicAdapter extends ProviderAdapter {
  /**
   * @param {Object} config
   * @param {string} [config.apiKey] - Anthropic API key (sk-ant-api*)
   * @param {string} [config.authToken] - OAuth token (sk-ant-oat*) from setup-token
   * @param {string} [config.baseUrl] - Optional base URL override
   * @param {boolean} [config.useOAuthService] - Use COSMO IDE's OAuth service (default: true)
   */
  constructor(config = {}) {
    super(config);

    this._catalogProviderId = String(config.providerId || 'anthropic');
    this._seedModels = Array.isArray(config.seedModels) && config.seedModels.length > 0
      ? config.seedModels.slice()
      : [
          'claude-sonnet-4-6',
          'claude-opus-4-6',
          'claude-haiku-4-5'
        ];
    this._discoveryEnabled = config.discoveryEnabled !== false;
    this._discoveryTtlMs = Number(config.discoveryTtlMs || (15 * 60 * 1000));
    this._listModelsPromise = null;
    const cachedModels = getCachedProviderModels(this._catalogProviderId, this._discoveryTtlMs);
    this._availableModels = cachedModels && cachedModels.length > 0
      ? cachedModels
      : this._seedModels.slice();
    this._modelsFetchedAt = cachedModels && cachedModels.length > 0 ? Date.now() : 0;

    this._useOAuthService = config.useOAuthService !== false && anthropicOAuth !== null;
    
    // Determine if using OAuth mode
    const token = config.authToken || config.apiKey;
    this._isOAuth = isOAuthToken(token);

    if (this._isOAuth) {
      // Store token as authToken for OAuth
      this.config.authToken = token;
      this.config.apiKey = null;
    }
  }

  get id() {
    return 'anthropic';
  }

  get name() {
    return 'Anthropic';
  }

  get capabilities() {
    return {
      tools: true,
      vision: true,
      thinking: true,
      streaming: true,
      caching: true,
      maxOutputTokens: 128000,
      contextWindow: 200000
    };
  }

  getAvailableModels() {
    return this._availableModels.slice();
  }

  async listModels(options = {}) {
    if (!this._discoveryEnabled) {
      return this.getAvailableModels();
    }

    const force = options.force === true;
    const cacheFresh = this._modelsFetchedAt > 0 && (Date.now() - this._modelsFetchedAt) < this._discoveryTtlMs;
    if (!force && cacheFresh && this._availableModels.length > 0) {
      return this.getAvailableModels();
    }

    if (this._listModelsPromise) {
      return this._listModelsPromise;
    }

    this._listModelsPromise = (async () => {
      try {
        if ((this._useOAuthService || this._isOAuth) && !this._client) {
          await this._initClientAsync();
        }

        const baseUrl = String(this.config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
        const headers = this._isOAuth || this.config.authToken
          ? {
              ...getStealthHeaders(),
              'anthropic-version': '2023-06-01',
              Authorization: `Bearer ${this.config.authToken}`
            }
          : {
              'x-api-key': this.config.apiKey,
              'anthropic-version': '2023-06-01'
            };

        const response = await fetch(`${baseUrl}/v1/models`, { headers });
        if (!response.ok) {
          throw new Error(`Model list returned ${response.status}`);
        }

        const payload = await response.json();
        const ids = sortDiscoveredModels(
          this._catalogProviderId,
          (payload.data || [])
            .map((model) => model?.id)
            .filter((modelId) => String(modelId || '').toLowerCase().includes('claude'))
        );

        if (ids.length > 0) {
          this._availableModels = ids;
          this._modelsFetchedAt = Date.now();
          setCachedProviderModels(this._catalogProviderId, ids, {
            source: 'live',
            ttlMs: this._discoveryTtlMs
          });
          return this.getAvailableModels();
        }
      } catch (error) {
        console.warn('[anthropic] Live model discovery failed, using cached/seed list:', error.message);
      } finally {
        this._listModelsPromise = null;
      }

      const cachedModels = getCachedProviderModels(this._catalogProviderId, this._discoveryTtlMs * 4);
      if (cachedModels && cachedModels.length > 0) {
        this._availableModels = cachedModels;
        this._modelsFetchedAt = Date.now();
      }

      return this.getAvailableModels();
    })();

    return this._listModelsPromise;
  }

  /**
   * Initialize client, optionally using COSMO IDE's OAuth service
   */
  async _initClientAsync() {
    // If using COSMO IDE's OAuth service, get credentials from it
    if (this._useOAuthService && anthropicOAuth?.getAnthropicApiKey) {
      try {
        const credentials = await anthropicOAuth.getAnthropicApiKey();
        if (credentials) {
          this._isOAuth = isOAuthToken(credentials.apiKey || credentials.authToken);
          if (credentials.authToken) {
            this.config.authToken = credentials.authToken;
            this.config.apiKey = null;
          } else if (credentials.apiKey) {
            this.config.apiKey = credentials.apiKey;
          }
        }
      } catch (e) {
        console.warn('[AnthropicAdapter] Failed to get credentials from OAuth service:', e.message);
      }
    }

    this._initClient();
  }

  _initClient() {
    const options = {};

    if (this._isOAuth || this.config.authToken) {
      // OAuth stealth mode: impersonate Claude Code
      options.apiKey = null;
      options.authToken = this.config.authToken;
      options.defaultHeaders = getStealthHeaders();
      options.dangerouslyAllowBrowser = true;
      console.log('[ANTHROPIC] Using OAuth stealth mode');
    } else {
      // Standard API key
      options.apiKey = this.config.apiKey;
    }

    if (this.config.baseUrl) {
      options.baseURL = this.config.baseUrl;
    }

    this._client = new Anthropic(options);
  }

  /**
   * Check if using OAuth mode
   * @returns {boolean}
   */
  get isOAuthMode() {
    return this._isOAuth;
  }

  /**
   * Prepare system prompt, injecting Claude Code identity for OAuth mode
   * Uses COSMO IDE's prepareSystemPrompt if available, otherwise fallback
   * @param {string|Object[]} systemPrompt - Original system prompt
   * @returns {Object[]|string|undefined} - System prompt
   * @private
   */
  _prepareSystemPrompt(systemPrompt) {
    // Use COSMO IDE's OAuth service if available
    if (this._isOAuth && anthropicOAuth?.prepareSystemPrompt) {
      return anthropicOAuth.prepareSystemPrompt(systemPrompt, true);
    }

    // Fallback: Claude Code system prompt that must be prepended for OAuth to work
    const claudeCodeSystemPrompt = {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: 'ephemeral' }
    };

    // If not OAuth mode, just return original (or undefined if none)
    if (!this._isOAuth) {
      if (!systemPrompt) return undefined;
      if (typeof systemPrompt === 'string') return systemPrompt;
      return systemPrompt;
    }

    // OAuth mode: prepend Claude Code prompt
    if (!systemPrompt) {
      return [claudeCodeSystemPrompt];
    }

    if (typeof systemPrompt === 'string') {
      return [
        claudeCodeSystemPrompt,
        { type: 'text', text: systemPrompt }
      ];
    }

    if (Array.isArray(systemPrompt)) {
      return [claudeCodeSystemPrompt, ...systemPrompt];
    }

    // Unknown format, just use Claude Code prompt
    return [claudeCodeSystemPrompt];
  }

  /**
   * Convert unified tools to Anthropic format
   * Anthropic uses JSON Schema natively, so this is mostly pass-through
   * @param {UnifiedTool[]} tools
   * @returns {Object[]}
   */
  convertTools(tools) {
    if (!tools || tools.length === 0) return [];

    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema
    }));
  }

  /**
   * Convert unified messages to Anthropic format
   * @param {Object[]} messages
   * @returns {Object[]}
   */
  _convertMessages(messages) {
    const converted = [];

    for (const msg of messages) {
      // Skip system messages - handled separately
      if (msg.role === 'system') continue;

      const converted_msg = {
        role: msg.role === 'tool' ? 'user' : msg.role,
        content: this._convertContent(msg)
      };

      converted.push(converted_msg);
    }

    return converted;
  }

  /**
   * Convert message content to Anthropic format
   * @param {Object} msg
   * @returns {string|Object[]}
   */
  _convertContent(msg) {
    // Simple string content
    if (typeof msg.content === 'string') {
      return msg.content;
    }

    // Array of content blocks
    if (Array.isArray(msg.content)) {
      return msg.content.map(block => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text };

          case 'image':
            return {
              type: 'image',
              source: {
                type: block.source?.startsWith('http') ? 'url' : 'base64',
                media_type: block.mediaType || 'image/png',
                data: block.source
              }
            };

          case 'tool_result':
            return {
              type: 'tool_result',
              // Support both camelCase (unified) and snake_case (Anthropic) formats
              tool_use_id: block.tool_use_id || block.toolUseId,
              content: block.content,
              is_error: block.is_error || block.isError || false
            };

          default:
            // Pass through blocks that are already in Anthropic format
            return block;
        }
      });
    }

    // Tool results from unified format
    if (msg.toolResults) {
      return msg.toolResults.map(result => ({
        type: 'tool_result',
        // Support both camelCase (unified) and snake_case (Anthropic) formats
        tool_use_id: result.tool_use_id || result.toolUseId,
        content: result.content,
        is_error: result.is_error || result.isError || false
      }));
    }

    return msg.content;
  }

  /**
   * Map Anthropic stop reason to unified format
   * @param {string} reason
   * @returns {string}
   */
  _mapStopReason(reason) {
    switch (reason) {
      case 'end_turn':
        return StopReasons.END_TURN;
      case 'max_tokens':
        return StopReasons.MAX_TOKENS;
      case 'tool_use':
        return StopReasons.TOOL_USE;
      case 'stop_sequence':
        return StopReasons.STOP_SEQUENCE;
      default:
        return StopReasons.END_TURN;
    }
  }

  /**
   * Parse tool calls from Anthropic response
   * @param {Object} response
   * @returns {UnifiedToolCall[]}
   */
  parseToolCalls(response) {
    if (!response.content) return [];

    return response.content
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        name: block.name,
        arguments: block.input || {}
      }));
  }

  /**
   * Normalize Anthropic response to unified format
   * @param {Object} response
   * @returns {UnifiedResponse}
   */
  normalizeResponse(response) {
    // Extract text content
    const textContent = extractText(response.content);

    // Extract tool calls
    const toolCalls = this.parseToolCalls(response);

    // Extract thinking content if present
    const thinkingBlock = response.content?.find(block => block.type === 'thinking');
    const thinkingContent = thinkingBlock?.thinking;

    return createResponse({
      id: response.id,
      model: response.model,
      content: textContent,
      toolCalls,
      stopReason: this._mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens
      },
      thinkingContent,
      rawContent: response.content
    });
  }

  /**
   * Create a message (non-streaming)
   * @param {UnifiedRequest} request
   * @returns {Promise<UnifiedResponse>}
   */
  async createMessage(request) {
    this.validateRequest(request);
    const prepared = this.prepareRequest(request);

    // Ensure client is initialized (may need async for OAuth)
    if (!this._client) {
      await this._initClientAsync();
    }
    const client = this._getClient();

    // Build Anthropic request
    const anthropicRequest = {
      model: prepared.model,
      max_tokens: prepared.maxTokens || 8192,
      messages: this._convertMessages(prepared.messages)
    };

    // Add system prompt (with Claude Code injection for OAuth)
    anthropicRequest.system = this._prepareSystemPrompt(prepared.systemPrompt);

    // Add tools
    if (prepared.tools && prepared.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(prepared.tools);
    }

    // Add optional parameters
    if (prepared.temperature !== undefined) {
      anthropicRequest.temperature = prepared.temperature;
    }

    if (prepared.stopSequences && prepared.stopSequences.length > 0) {
      anthropicRequest.stop_sequences = prepared.stopSequences;
    }

    // Add thinking (extended thinking for Claude)
    if (prepared.thinking && prepared.thinking !== 'off') {
      // Map thinking levels to budget tokens
      const thinkingBudget = {
        low: 2000,
        medium: 8000,
        high: 32000
      };
      anthropicRequest.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget[prepared.thinking] || 8000
      };
    }

    try {
      const response = await client.messages.create(anthropicRequest);
      return this.normalizeResponse(response);
    } catch (error) {
      throw this._enhanceError(error);
    }
  }

  /**
   * Stream a message response
   * @param {UnifiedRequest} request
   * @returns {AsyncGenerator<UnifiedChunk>}
   */
  async *streamMessage(request) {
    this.validateRequest(request);
    const prepared = this.prepareRequest(request);

    // Ensure client is initialized
    if (!this._client) {
      await this._initClientAsync();
    }
    const client = this._getClient();

    // Build Anthropic request
    const anthropicRequest = {
      model: prepared.model,
      max_tokens: prepared.maxTokens || 8192,
      messages: this._convertMessages(prepared.messages)
    };

    // Add system prompt (with Claude Code injection for OAuth)
    anthropicRequest.system = this._prepareSystemPrompt(prepared.systemPrompt);

    // Add tools
    if (prepared.tools && prepared.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(prepared.tools);
    }

    // Add optional parameters
    if (prepared.temperature !== undefined) {
      anthropicRequest.temperature = prepared.temperature;
    }

    if (prepared.stopSequences && prepared.stopSequences.length > 0) {
      anthropicRequest.stop_sequences = prepared.stopSequences;
    }

    try {
      const stream = await client.messages.stream(anthropicRequest);

      let currentToolId = null;
      let currentToolName = null;
      let currentToolArgs = '';
      let fullResponse = null;

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              currentToolId = event.content_block.id;
              currentToolName = event.content_block.name;
              currentToolArgs = '';
              yield {
                type: 'tool_use_start',
                toolId: currentToolId,
                toolName: currentToolName
              };
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield {
                type: 'text',
                text: event.delta.text
              };
            } else if (event.delta.type === 'input_json_delta') {
              currentToolArgs += event.delta.partial_json;
              yield {
                type: 'tool_use_delta',
                toolId: currentToolId,
                argumentsDelta: event.delta.partial_json
              };
            } else if (event.delta.type === 'thinking_delta') {
              yield {
                type: 'thinking',
                thinking: event.delta.thinking
              };
            }
            break;

          case 'content_block_stop':
            if (currentToolId) {
              yield {
                type: 'tool_use_end',
                toolId: currentToolId,
                toolName: currentToolName,
                arguments: currentToolArgs ? JSON.parse(currentToolArgs) : {}
              };
              currentToolId = null;
              currentToolName = null;
              currentToolArgs = '';
            }
            break;

          case 'message_stop':
            fullResponse = stream.finalMessage;
            yield {
              type: 'done',
              response: this.normalizeResponse(fullResponse)
            };
            break;
        }
      }
    } catch (error) {
      throw this._enhanceError(error);
    }
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error
   * @returns {boolean}
   */
  isRateLimitError(error) {
    return (
      error.status === 429 ||
      error.error?.type === 'rate_limit_error' ||
      error.message?.toLowerCase().includes('rate limit')
    );
  }

  /**
   * Check if error is a billing error
   * @param {Error} error
   * @returns {boolean}
   */
  isBillingError(error) {
    return (
      error.status === 402 ||
      error.error?.type === 'insufficient_credits' ||
      error.message?.toLowerCase().includes('insufficient')
    );
  }

  /**
   * Check if error is an authentication error
   * @param {Error} error
   * @returns {boolean}
   */
  isAuthError(error) {
    return (
      error.status === 401 ||
      error.error?.type === 'authentication_error' ||
      error.error?.type === 'invalid_api_key' ||
      error.message?.toLowerCase().includes('api key')
    );
  }

  /**
   * Check if error is a server error
   * @param {Error} error
   * @returns {boolean}
   */
  isServerError(error) {
    return error.status >= 500 && error.status < 600;
  }

  /**
   * Enhance error with additional context
   * @param {Error} error
   * @returns {Error}
   * @private
   */
  _enhanceError(error) {
    error.provider = this.id;
    error.classified = this.classifyError(error);
    return error;
  }
}

/**
 * Create an Anthropic adapter with the given API key
 * @param {string} apiKey
 * @param {Object} [options]
 * @returns {AnthropicAdapter}
 */
function createAnthropicAdapter(apiKey, options = {}) {
  return new AnthropicAdapter({ apiKey, ...options });
}

/**
 * Create an Anthropic adapter using COSMO IDE's OAuth service
 * @param {Object} [options]
 * @returns {AnthropicAdapter}
 */
function createAnthropicAdapterWithOAuth(options = {}) {
  return new AnthropicAdapter({ useOAuthService: true, ...options });
}

module.exports = { AnthropicAdapter, createAnthropicAdapter, createAnthropicAdapterWithOAuth };
