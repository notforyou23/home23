/**
 * Anthropic Client Adapter for COSMO Research Engine
 *
 * Translates GPT-5.2 Responses API format → Anthropic Messages API
 * Maintains compatibility with GPT5Client interface for zero breaking changes
 *
 * Key Features:
 * - OAuth token support with stealth headers
 * - Tool calling (OpenAI format → Anthropic format)
 * - Streaming responses
 * - Extended thinking (reasoning effort → extended_thinking)
 * - Web search via native web_search_20250305 tool (Claude Sonnet 4.5+)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getAnthropicApiKey, prepareSystemPrompt, isOAuthToken } = require('../server/services/anthropic-oauth');
const { getModelId } = require('./model-selection');

class AnthropicClient {
  /**
   * Initialize Anthropic client adapter
   * @param {Object} config - Configuration object
   * @param {Object} logger - Logger instance
   */
  constructor(config = {}, logger = null) {
    this.logger = logger;
    this.config = config;
    this.anthropic = null;  // Lazy initialization
    this.isOAuth = false;
    this._credentialsFetchedAt = 0;  // Track when credentials were obtained
    this._refreshPromise = null;    // Lock to prevent concurrent refresh

    // Model mapping (GPT names → Claude models)
    this.modelMapping = config.modelMapping || {
      'gpt-5.2': 'claude-sonnet-4-5',
      'gpt-5': 'claude-sonnet-4-5',
      'gpt-5-mini': 'claude-sonnet-4-5',
      'gpt-5-nano': 'claude-sonnet-4-5'
    };

    // Default settings
    this.defaultMaxTokens = config.defaultMaxTokens || 8000;
    this.temperature = config.temperature || 0.1;
    this.useExtendedThinking = config.useExtendedThinking !== false;
  }

  /**
   * Initialize Anthropic SDK client (lazy, OAuth-aware)
   * Called before each API request. Re-initializes if OAuth credentials are stale (>50 min).
   * API keys never expire so they skip the refresh check.
   * Safe: preserves old client on refresh failure, prevents concurrent refresh races.
   */
  async _initClient() {
    // Fast path: client exists and credentials are fresh
    if (this.anthropic) {
      if (!this.isOAuth) return;  // API keys don't expire
      const age = Date.now() - this._credentialsFetchedAt;
      if (age < 50 * 60 * 1000) return;  // Less than 50 min old, still fresh
    }

    // If another call is already refreshing, wait for it
    if (this._refreshPromise) {
      await this._refreshPromise;
      return;
    }

    // Take the refresh lock
    this._refreshPromise = this._doRefreshClient();
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  /**
   * Internal: actually fetch credentials and create SDK client.
   * Preserves old client on failure so stale-but-working credentials aren't lost.
   */
  async _doRefreshClient() {
    const isRefresh = !!this.anthropic;
    const oldClient = this.anthropic;
    const oldIsOAuth = this.isOAuth;
    const oldFetchedAt = this._credentialsFetchedAt;

    if (isRefresh) {
      this.logger?.info?.('[AnthropicClient] OAuth credentials stale, refreshing...');
    }

    try {
      // Get credentials from OAuth system (auto-refreshes expired tokens)
      const credentials = await getAnthropicApiKey();
      this.isOAuth = credentials.isOAuth;
      this._credentialsFetchedAt = Date.now();

      if (credentials.isOAuth) {
        this.logger?.info?.('[AnthropicClient] Initializing with OAuth token (stealth mode)');
        this.anthropic = new Anthropic({
          authToken: credentials.authToken,
          defaultHeaders: credentials.defaultHeaders,
          dangerouslyAllowBrowser: credentials.dangerouslyAllowBrowser
        });
      } else {
        this.logger?.info?.('[AnthropicClient] Initializing with API key');
        this.anthropic = new Anthropic({
          apiKey: credentials.apiKey
        });
      }
    } catch (error) {
      if (isRefresh) {
        // Restore old client — stale credentials are better than no credentials
        this.anthropic = oldClient;
        this.isOAuth = oldIsOAuth;
        this._credentialsFetchedAt = oldFetchedAt;
        this.logger?.warn?.('[AnthropicClient] Refresh failed, continuing with existing credentials:', error.message);
        return;
      }
      // First init — no old client to fall back to, must throw
      this.logger?.error?.('[AnthropicClient] Failed to initialize:', error.message);
      throw error;
    }
  }

  /**
   * Main generation method (matches GPT5Client interface)
   * Translates Responses API format → Messages API format
   *
   * @param {Object} options - Generation options
   * @param {string} options.instructions - System prompt
   * @param {string|Array} options.input - User input (Responses API format)
   * @param {Array} options.messages - Messages array (Messages API format)
   * @param {Array} options.tools - Tool definitions (OpenAI format)
   * @param {string} options.toolChoice - Tool choice strategy
   * @param {string} options.reasoningEffort - Reasoning level
   * @param {number} options.max_output_tokens - Max tokens
   * @param {string} options.model - Model override
   * @returns {Object} - GPT5Client-compatible response
   */
  async generate(options = {}) {
    await this._initClient();

    try {
      // Extract system prompt from messages array if present (coordinators use this pattern)
      let systemPrompt = options.instructions;
      let messagesToUse = options.input || options.messages;

      // If messages array contains system role, extract it
      if (Array.isArray(messagesToUse) && messagesToUse.length > 0) {
        const systemMessage = messagesToUse.find(m => m.role === 'system');
        if (systemMessage) {
          // Merge with instructions if both exist
          systemPrompt = systemPrompt
            ? `${systemPrompt}\n\n${systemMessage.content}`
            : systemMessage.content;
          // Remove system message from array (Anthropic doesn't support it in messages)
          messagesToUse = messagesToUse.filter(m => m.role !== 'system');
        }
      }

      // Prepare system prompt (OAuth requires Claude Code identity)
      systemPrompt = prepareSystemPrompt(systemPrompt, this.isOAuth);

      // Transform input to messages format
      const messages = this._transformInputToMessages(messagesToUse);

      // Transform tools from OpenAI → Anthropic format
      const tools = options.tools ? this._transformTools(options.tools) : undefined;

      // Determine if extended thinking should be used
      const useExtendedThinking = this._shouldUseExtendedThinking(options.reasoningEffort);

      // Get model (with mapping)
      const model = this._getModelFromOptions(options);

      // Determine temperature (CRITICAL: Anthropic requires temperature=1 when thinking is enabled)
      let temperature = options.temperature !== undefined ? options.temperature : this.temperature;
      if (useExtendedThinking) {
        this.logger?.info?.('[AnthropicClient] Extended thinking enabled, forcing temperature=1', {
          originalTemp: temperature,
          useExtendedThinking
        });
        temperature = 1;  // Anthropic API requirement: temperature must be 1 with extended thinking
      }

      // Build API request
      const requestParams = {
        model,
        max_tokens: options.max_output_tokens || this.defaultMaxTokens,
        temperature,
        system: systemPrompt,
        messages,
        stream: true
      };

      // Add tools if provided
      if (tools && tools.length > 0) {
        requestParams.tools = tools;

        // Add tool choice if specified
        if (options.toolChoice) {
          requestParams.tool_choice = this._transformToolChoice(options.toolChoice);
        }
      }

      // Add extended thinking if appropriate
      if (useExtendedThinking) {
        requestParams.thinking = {
          type: 'enabled',
          budget_tokens: 2000
        };
      }

      this.logger?.info?.('[AnthropicClient] Starting generation', {
        model,
        temperature,
        hasTools: !!tools,
        toolCount: tools?.length || 0,
        messageCount: messages.length,
        extendedThinking: useExtendedThinking
      });

      // Debug: Log message structure for troubleshooting
      if (this.logger?.debug) {
        messages.forEach((msg, i) => {
          this.logger.debug(`[AnthropicClient] Message ${i}: role=${msg.role}, contentType=${Array.isArray(msg.content) ? 'array' : typeof msg.content}`);
        });
      }

      // Stream the response
      const stream = await this.anthropic.messages.stream(requestParams);

      // Process streaming response
      return await this._streamResponse(stream, options);

    } catch (error) {
      this.logger?.error?.('[AnthropicClient] Generation failed:', error.message);
      return this._buildErrorResponse(error);
    }
  }

  /**
   * Generate with retry logic (matches GPT5Client interface)
   */
  async generateWithRetry(options = {}, maxRetries = 3) {
    let lastResult = null;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.generate(options);
        lastResult = result;

        // Success: non-empty content without error, OR tool calls present
        const hasContent = result.content && result.content.trim().length > 0 && !result.hadError;
        const hasToolCalls = result.output && result.output.length > 0;
        if (hasContent || hasToolCalls) {
          if (attempt > 0) {
            this.logger?.info?.('[AnthropicClient] Retry successful', { attempt: attempt + 1 });
          }
          return result;
        }

        // If we have an error and retries left, wait and retry
        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          this.logger?.warn?.(`[AnthropicClient] Retry ${attempt + 1}/${maxRetries} after ${backoff}ms`, {
            component: options.component,
            purpose: options.purpose,
            hadError: result.hadError,
            contentLength: result.content?.length || 0,
            errorType: result.errorType
          });
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }

        // Last attempt — return what we have
        this.logger?.error?.('[AnthropicClient] All retries exhausted', {
          component: options.component,
          purpose: options.purpose,
          hadError: result.hadError,
          contentLength: result.content?.length || 0,
          errorType: result.errorType
        });
        return result;

      } catch (error) {
        lastError = error;
        this.logger?.error?.('[AnthropicClient] Exception during generation', {
          component: options.component,
          purpose: options.purpose,
          attempt: attempt + 1,
          error: error.message
        });

        if (attempt === maxRetries - 1) {
          throw error;
        }
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    // If we somehow get here, return last result or build error
    if (lastResult) {
      return lastResult;
    }
    return this._buildErrorResponse(lastError || new Error('All retries exhausted'));
  }

  /**
   * Generate with extended thinking (reasoning)
   */
  async generateWithReasoning(options = {}) {
    return await this.generateWithRetry({
      ...options,
      reasoningEffort: 'high'  // Force extended thinking
    }, 3);
  }

  /**
   * Fast generation (use same model, no extended thinking)
   */
  async generateFast(options = {}) {
    return await this.generateWithRetry({
      ...options,
      reasoningEffort: 'none',  // Disable extended thinking
      max_output_tokens: options.max_output_tokens || 1000
    }, 3);
  }

  /**
   * Generate with web search
   * Uses Anthropic's native web_search_20250305 tool (Claude Sonnet 4.5+)
   * Falls back to DuckDuckGo if native search not available
   */
  async generateWithWebSearch(options = {}) {
    await this._initClient();

    try {
      // Extract search query from input or messages (support both patterns)
      const inputOrMessages = options.input || options.messages;
      const query = options.query || (typeof inputOrMessages === 'string'
        ? inputOrMessages
        : inputOrMessages?.[0]?.content || inputOrMessages?.[inputOrMessages.length - 1]?.content || '');

      this.logger?.info?.('[AnthropicClient] Web search requested:', query);

      // Build messages (support both input and messages)
      const messages = this._transformInputToMessages(inputOrMessages || [{ role: 'user', content: query }]);

      // Get model
      const model = this._getModelFromOptions(options);

      // Use Anthropic's native web_search tool
      const requestParams = {
        model,
        max_tokens: options.maxTokens || options.max_output_tokens || this.defaultMaxTokens,
        temperature: options.temperature !== undefined ? options.temperature : this.temperature,
        system: prepareSystemPrompt(options.instructions, this.isOAuth),
        messages,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5
        }],
        stream: true
      };

      this.logger?.info?.('[AnthropicClient] Using native web_search tool', { model, query });

      // Stream the response
      const stream = await this.anthropic.messages.stream(requestParams);

      // Process streaming response (handles web_search_tool_result blocks)
      return await this._streamResponseWithWebSearch(stream, options);

    } catch (error) {
      this.logger?.error?.('[AnthropicClient] Native web search failed, trying DuckDuckGo fallback:', error.message);

      // Fallback to DuckDuckGo
      try {
        // Extract query from input or messages
        const inputOrMessages = options.input || options.messages;
        const query = typeof inputOrMessages === 'string'
          ? inputOrMessages
          : inputOrMessages?.[0]?.content || inputOrMessages?.[inputOrMessages.length - 1]?.content || '';

        const searchResults = await this._performWebSearch(query);
        const enhancedInstructions = options.instructions
          ? `${options.instructions}\n\nWeb Search Results:\n${searchResults}`
          : `Web Search Results:\n${searchResults}`;

        return await this.generateWithRetry({
          ...options,
          instructions: enhancedInstructions
        }, 3);
      } catch (fallbackError) {
        this.logger?.error?.('[AnthropicClient] All web search methods failed:', fallbackError.message);
        return await this.generateWithRetry(options, 3);
      }
    }
  }

  /**
   * Container methods (not supported by Anthropic)
   * These throw errors to indicate unsupported operations
   */
  async createContainer() {
    throw new Error('[AnthropicClient] Container operations not supported. Use OpenAI for code execution.');
  }

  async uploadFileToContainer() {
    throw new Error('[AnthropicClient] Container operations not supported. Use OpenAI for code execution.');
  }

  async listContainerFiles() {
    throw new Error('[AnthropicClient] Container operations not supported. Use OpenAI for code execution.');
  }

  async downloadFileFromContainer() {
    throw new Error('[AnthropicClient] Container operations not supported. Use OpenAI for code execution.');
  }

  async executeInContainer() {
    throw new Error('[AnthropicClient] Container operations not supported. Use OpenAI for code execution.');
  }

  async deleteContainer() {
    throw new Error('[AnthropicClient] Container operations not supported. Use OpenAI for code execution.');
  }

  async generateWithCodeInterpreter() {
    throw new Error('[AnthropicClient] Code interpreter not supported. Use OpenAI for code execution.');
  }

  // ============ INTERNAL HELPER METHODS ============

  /**
   * Transform input to Anthropic messages format
   * CRITICAL: Handles tool result conversion from OpenAI → Anthropic format
   */
  _transformInputToMessages(input) {
    if (!input) {
      return [{ role: 'user', content: '' }];
    }

    // If input is already in Responses API array format
    if (Array.isArray(input)) {
      const messages = [];

      for (const item of input) {
        // Handle OpenAI Responses API function_call_output format
        // Convert to Anthropic's tool_result content block
        if (item.type === 'function_call_output' || item.type === 'tool_result') {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: item.tool_use_id || item.call_id,
              content: item.output || item.content || ''
            }]
          });
        }
        // Handle OpenAI Messages API tool role format
        // Convert to Anthropic's tool_result content block
        else if (item.role === 'tool') {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: item.tool_use_id || item.tool_call_id,
              content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
            }]
          });
        }
        // Handle assistant messages with tool calls
        // Need to convert to Anthropic's tool_use content blocks
        else if (item.role === 'assistant' && item.tool_calls) {
          messages.push({
            role: 'assistant',
            content: [
              // Include any text content first
              ...(item.content ? [{ type: 'text', text: item.content }] : []),
              // Then tool use blocks
              ...item.tool_calls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments)
              }))
            ]
          });
        }
        // Standard role messages (user, assistant)
        else if (item.role && item.content) {
          messages.push({ role: item.role, content: item.content });
        }
        // Fallback for unknown formats
        else {
          messages.push({ role: 'user', content: String(item) });
        }
      }

      return messages;
    }

    // If input is a string
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }];
    }

    // If input is an object with content
    if (input.content) {
      return [{ role: 'user', content: input.content }];
    }

    // Fallback
    return [{ role: 'user', content: String(input) }];
  }

  /**
   * Transform tools from OpenAI format → Anthropic format
   */
  _transformTools(tools) {
    if (!tools || !Array.isArray(tools)) return [];

    return tools
      .filter(tool => {
        // Filter out built-in tools (Anthropic doesn't support these)
        if (tool.type === 'web_search' || tool.type === 'code_interpreter') {
          this.logger?.warn?.(`[AnthropicClient] Skipping unsupported tool type: ${tool.type}`);
          return false;
        }
        return tool.type === 'function';
      })
      .map(tool => {
        // OpenAI format: { type: 'function', function: { name, description, parameters } }
        // Anthropic format: { name, description, input_schema }
        const func = tool.function || tool;
        return {
          name: func.name,
          description: func.description || '',
          input_schema: func.parameters || { type: 'object', properties: {} }
        };
      });
  }

  /**
   * Transform tool choice from OpenAI → Anthropic format
   */
  _transformToolChoice(toolChoice) {
    if (!toolChoice) return undefined;

    // OpenAI: 'auto', 'required', 'none', or { type: 'function', function: { name } }
    // Anthropic: { type: 'auto' | 'any' | 'tool', name?: string }

    if (toolChoice === 'auto') {
      return { type: 'auto' };
    }

    if (toolChoice === 'required') {
      return { type: 'any' };
    }

    if (toolChoice === 'none') {
      return undefined;  // Don't send tool_choice
    }

    // Specific tool selection
    if (typeof toolChoice === 'object' && toolChoice.function?.name) {
      return {
        type: 'tool',
        name: toolChoice.function.name
      };
    }

    return { type: 'auto' };
  }

  /**
   * Process streaming response from Anthropic (with web search support)
   * Alias for _streamResponseWithWebSearch for backward compatibility
   */
  async _streamResponse(stream, options) {
    return await this._streamResponseWithWebSearch(stream, options);
  }

  /**
   * Process streaming response from Anthropic with web search support
   */
  async _streamResponseWithWebSearch(stream, options) {
    let textContent = '';
    let thinkingContent = '';
    const toolCalls = [];
    let currentToolUse = null;
    const webSearchSources = [];
    const citations = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let responseId = null;
    let model = null;

    try {
      for await (const event of stream) {
        // Message start - capture metadata
        if (event.type === 'message_start') {
          responseId = event.message?.id;
          model = event.message?.model;
          inputTokens = event.message?.usage?.input_tokens || 0;
        }

        // Content block start - detect tool use, thinking, or web search results
        else if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: ''
            };
          } else if (event.content_block?.type === 'thinking') {
            // Extended thinking block
            this.logger?.debug?.('[AnthropicClient] Thinking block started');
          } else if (event.content_block?.type === 'web_search_tool_result') {
            // Web search results
            const results = event.content_block?.content || [];
            for (const result of results) {
              if (result.type === 'web_search_result') {
                webSearchSources.push({
                  url: result.url,
                  title: result.title,
                  pageAge: result.page_age
                });
                this.logger?.debug?.('[AnthropicClient] Web search source:', result.url);
              }
            }
          }
        }

        // Content block delta - accumulate text, tool input, or thinking
        else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            // Check for citations in text content
            const text = event.delta.text;
            textContent += text;

            // Emit chunk for real-time streaming (matches GPT5Client onChunk pattern)
            if (options.onChunk && text) {
              options.onChunk({ type: 'chunk', text: text });
            }

            // Extract citations if present (Anthropic includes them in text deltas)
            if (event.delta.citations && event.delta.citations.length > 0) {
              for (const citation of event.delta.citations) {
                if (citation.type === 'web_search_result_location') {
                  citations.push({
                    url: citation.url,
                    title: citation.title,
                    citedText: citation.cited_text
                  });
                }
              }
            }
          } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
            // Accumulate tool input JSON
            currentToolUse.input += event.delta.partial_json;
          } else if (event.delta?.type === 'thinking_delta') {
            thinkingContent += event.delta.thinking || '';
          }
        }

        // Content block stop - finalize tool use
        else if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            // Parse accumulated JSON and store in OpenAI format
            try {
              const parsedInput = JSON.parse(currentToolUse.input);
              toolCalls.push({
                id: currentToolUse.id,
                type: 'function',
                function: {
                  name: currentToolUse.name,
                  arguments: JSON.stringify(parsedInput)  // OpenAI expects string
                }
              });
            } catch (e) {
              this.logger?.warn?.('[AnthropicClient] Failed to parse tool input:', e.message);
            }
            currentToolUse = null;
          }
        }

        // Message delta - update token counts
        else if (event.type === 'message_delta') {
          outputTokens += event.usage?.output_tokens || 0;
        }

        // Message stop - completion
        else if (event.type === 'message_stop') {
          this.logger?.debug?.('[AnthropicClient] Stream complete');
        }

        // Error handling
        else if (event.type === 'error') {
          this.logger?.error?.('[AnthropicClient] Stream error:', event.error);
          throw new Error(event.error?.message || 'Streaming error');
        }
      }

      // Build GPT5Client-compatible response with web search data
      const response = {
        content: textContent,
        reasoning: thinkingContent || null,
        responseId,
        model: model || this._getModelFromOptions(options),
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        },
        output: toolCalls.length > 0 ? toolCalls : null,
        hadError: false,
        errorType: null
      };

      // Add web search data if present (matches OpenAI format)
      if (webSearchSources.length > 0) {
        response.webSearchSources = webSearchSources;
        this.logger?.info?.('[AnthropicClient] Web search sources extracted:', webSearchSources.length);
      }

      if (citations.length > 0) {
        response.citations = citations;
        this.logger?.info?.('[AnthropicClient] Citations extracted:', citations.length);
      }

      return response;

    } catch (error) {
      this.logger?.error?.('[AnthropicClient] Stream processing error:', error.message);
      return this._buildErrorResponse(error);
    }
  }

  /**
   * Perform web search using DuckDuckGo
   */
  async _performWebSearch(query) {
    // Simple DuckDuckGo search implementation
    // This is a fallback since Anthropic doesn't have built-in search
    try {
      const https = require('https');
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;

      return new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const results = JSON.parse(data);
              const formatted = this._formatSearchResults(results);
              resolve(formatted);
            } catch (e) {
              resolve('Web search results unavailable');
            }
          });
        }).on('error', reject);
      });
    } catch (error) {
      this.logger?.error?.('[AnthropicClient] Web search error:', error.message);
      return 'Web search unavailable';
    }
  }

  /**
   * Format search results for context
   */
  _formatSearchResults(results) {
    if (!results || !results.RelatedTopics) {
      return 'No search results found';
    }

    const topics = results.RelatedTopics
      .filter(t => t.Text)
      .slice(0, 5)
      .map(t => `- ${t.Text}`)
      .join('\n');

    return topics || 'No relevant results found';
  }

  /**
   * Determine if extended thinking should be used
   */
  _shouldUseExtendedThinking(reasoningEffort) {
    if (!this.useExtendedThinking) return false;
    if (!reasoningEffort) return false;

    // Map reasoning effort → extended thinking
    const effortLevel = (reasoningEffort || '').toLowerCase();
    return ['medium', 'high', 'xhigh'].includes(effortLevel);
  }

  /**
   * Get model with mapping
   */
  _getModelFromOptions(options) {
    const requestedModel = getModelId(options.model || 'gpt-5.2') || 'gpt-5.2';
    // If already a Claude model, use it directly
    if (requestedModel.startsWith('claude-')) {
      return requestedModel;
    }
    return this.modelMapping[requestedModel] || 'claude-sonnet-4-5';
  }

  /**
   * Build error response (matches GPT5Client format)
   */
  _buildErrorResponse(error) {
    return {
      content: `[Error: ${error.message}]`,
      reasoning: null,
      responseId: null,
      model: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      output: null,
      hadError: true,
      errorType: error.type || 'unknown_error'
    };
  }

  /**
   * Response extraction methods (for compatibility with GPT5Client interface)
   */

  extractTextFromResponse(response) {
    if (!response) return '';
    if (typeof response === 'string') return response;
    if (response.content) return response.content;
    if (response.output?.content) return response.output.content;
    return '';
  }

  extractReasoning(response) {
    if (!response) return null;
    return response.reasoning || null;
  }

  extractToolCalls(response) {
    if (!response || !response.output) return [];
    return response.output || [];
  }

  extractWebSearchData(response) {
    // Extract web search data from Anthropic response (now supported via native web_search tool)
    return {
      sources: response?.webSearchSources || [],
      citations: response?.citations || []
    };
  }

  extractCodeInterpreterResults(response) {
    // Anthropic doesn't have code interpreter
    return [];
  }
}

module.exports = AnthropicClient;
