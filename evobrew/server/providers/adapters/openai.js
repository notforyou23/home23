/**
 * OpenAI Provider Adapter
 *
 * Adapter for OpenAI's GPT models using the official SDK.
 * Converts between unified format and OpenAI's API format.
 * 
 * Supports both APIs:
 * - Chat Completions API (GPT-4o, GPT-4, etc.)
 * - Responses API (GPT-5+) with stateful conversation support
 */

const OpenAI = require('openai');
const { ProviderAdapter } = require('./base.js');
const {
  getCachedProviderModels,
  setCachedProviderModels,
  sortDiscoveredModels
} = require('../model-catalog.js');
const {
  createResponse,
  StopReasons
} = require('../types/unified.js');

/**
 * @typedef {import('../types/unified.js').UnifiedRequest} UnifiedRequest
 * @typedef {import('../types/unified.js').UnifiedResponse} UnifiedResponse
 * @typedef {import('../types/unified.js').UnifiedChunk} UnifiedChunk
 * @typedef {import('../types/unified.js').UnifiedTool} UnifiedTool
 * @typedef {import('../types/unified.js').UnifiedToolCall} UnifiedToolCall
 * @typedef {import('../types/unified.js').ProviderCapabilities} ProviderCapabilities
 */

/**
 * Check if a model should use the Responses API
 * GPT-5+ models use the new Responses API for better stateful conversations
 * @param {string} model
 * @returns {boolean}
 */
function shouldUseResponsesAPI(model) {
  const modelLower = model.toLowerCase();
  return (
    modelLower.includes('gpt-5') ||
    modelLower.includes('gpt5') ||
    modelLower.startsWith('o3') ||
    modelLower.startsWith('o4')
  );
}

class OpenAIAdapter extends ProviderAdapter {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - OpenAI API key
   * @param {string} [config.baseUrl] - Optional base URL override (e.g., for xAI)
   * @param {string} [config.organization] - Optional organization ID
   */
  constructor(config = {}) {
    super(config);

    this._catalogProviderId = String(config.providerId || 'openai');
    this._seedModels = Array.isArray(config.seedModels) && config.seedModels.length > 0
      ? config.seedModels.slice()
      : [
          'gpt-5.4',
          'gpt-5.4-mini',
          'gpt-5.4-nano',
          'gpt-4o',
          'gpt-4o-mini'
        ];
    this._discoveryEnabled = config.discoveryEnabled !== false;
    this._discoveryTtlMs = Number(config.discoveryTtlMs || (15 * 60 * 1000));
    this._modelFilter = typeof config.modelFilter === 'function'
      ? config.modelFilter
      : ((modelId) => this._defaultModelFilter(modelId));
    this._listModelsPromise = null;

    const cachedModels = getCachedProviderModels(this._catalogProviderId, this._discoveryTtlMs);
    this._availableModels = cachedModels && cachedModels.length > 0
      ? cachedModels
      : this._seedModels.slice();
    this._modelsFetchedAt = cachedModels && cachedModels.length > 0 ? Date.now() : 0;
    
    // State for Responses API (stateful across tool-calling turns)
    this._previousResponseId = null;
    this._pendingToolOutputs = null;
  }

  get id() {
    return 'openai';
  }

  get name() {
    return 'OpenAI';
  }

  get capabilities() {
    return {
      tools: true,
      vision: true,
      thinking: false, // OpenAI doesn't have extended thinking like Claude
      streaming: true,
      caching: false,
      maxOutputTokens: 64000,
      contextWindow: 200000
    };
  }

  getAvailableModels() {
    return this._availableModels.slice();
  }

  _defaultModelFilter(modelId) {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return false;

    if (this._catalogProviderId === 'openai' && normalized.includes('codex')) {
      return false;
    }

    const looksLikeChatModel = (
      normalized.startsWith('gpt-') ||
      normalized.startsWith('o1') ||
      normalized.startsWith('o3') ||
      normalized.startsWith('o4') ||
      normalized.startsWith('grok-')
    );

    if (!looksLikeChatModel) return false;

    return !(
      normalized.includes('audio') ||
      normalized.includes('transcribe') ||
      normalized.includes('tts') ||
      normalized.includes('image') ||
      normalized.includes('embedding') ||
      normalized.includes('moderation') ||
      normalized.includes('search') ||
      normalized.includes('whisper') ||
      normalized.includes('instruct') ||
      normalized.includes('realtime')
    );
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
        const client = this._getClient();
        const response = await client.models.list();
        const ids = sortDiscoveredModels(
          this._catalogProviderId,
          (response.data || [])
            .map((model) => model?.id)
            .filter((modelId) => this._modelFilter(modelId))
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
        console.warn(`[${this._catalogProviderId}] Live model discovery failed, using cached/seed list:`, error.message);
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

  _initClient() {
    const options = {
      apiKey: this.config.apiKey
    };

    if (this.config.baseUrl) {
      options.baseURL = this.config.baseUrl;
    }

    if (this.config.organization) {
      options.organization = this.config.organization;
    }

    if (this.config.defaultHeaders) {
      options.defaultHeaders = this.config.defaultHeaders;
    }

    this._client = new OpenAI(options);
  }

  /**
   * Convert unified tools to OpenAI Chat Completions format
   * OpenAI requires tools wrapped in { type: "function", function: {...} }
   * @param {UnifiedTool[]} tools
   * @returns {Object[]}
   */
  convertTools(tools) {
    if (!tools || tools.length === 0) return [];

    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        // Ensure parameters is always a valid object schema — null/undefined
        // causes "None is not of type 'object'" on Ollama Cloud and similar APIs
        parameters: tool.input_schema && typeof tool.input_schema === 'object'
          ? tool.input_schema
          : { type: 'object', properties: {} }
      }
    }));
  }

  /**
   * Convert unified tools to OpenAI Responses API format
   * Responses API expects: { type:'function', name, description, parameters, strict }
   * @param {Object[]} chatToolDefinitions - Tools in Chat Completions format
   * @returns {Object[]}
   */
  _convertToolsForResponses(chatToolDefinitions) {
    return (chatToolDefinitions || [])
      .filter(t => t && t.type === 'function' && t.function && t.function.name)
      .map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description || null,
        parameters: t.function.parameters || null,
        strict: true
      }));
  }

  /**
   * Convert unified messages to OpenAI Chat Completions format
   * @param {Object[]} messages
   * @param {string} [systemPrompt]
   * @returns {Object[]}
   */
  _convertMessages(messages, systemPrompt) {
    const converted = [];

    // Add system prompt as first message
    if (systemPrompt) {
      converted.push({
        role: 'system',
        content: systemPrompt
      });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (!systemPrompt && typeof msg.content === 'string' && msg.content.trim()) {
          converted.push({
            role: 'system',
            content: msg.content
          });
        }
        continue;
      }

      const converted_msg = {
        role: msg.role === 'tool' ? 'tool' : msg.role,
        content: this._convertContent(msg)
      };

      // Handle tool call IDs for tool responses
      if (msg.role === 'tool' && msg.toolResults) {
        // OpenAI expects separate messages for each tool result
        for (const result of msg.toolResults) {
          converted.push({
            role: 'tool',
            tool_call_id: result.toolUseId,
            content: result.content
          });
        }
        continue;
      }

      // Handle assistant messages with tool calls
      if (msg.role === 'assistant' && msg.toolCalls) {
        converted_msg.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }));
      }

      converted.push(converted_msg);
    }

    return converted;
  }

  /**
   * Extract system instructions from messages for Responses API
   * @param {Object[]} messageList
   * @returns {string|null}
   */
  _extractInstructions(messageList) {
    const systemMsgs = (messageList || []).filter(m => m?.role === 'system' && typeof m.content === 'string');
    if (!systemMsgs.length) return null;
    return systemMsgs.map(m => m.content).join('\n\n');
  }

  /**
   * Convert messages to Responses API input format
   * @param {Object[]} messageList
   * @returns {Object[]}
   */
  _convertMessagesForResponses(messageList) {
    const input = [];
    for (const msg of messageList || []) {
      if (!msg || msg.role === 'system') continue;

      if (msg.role === 'user') {
        // If this is our legacy image message shape (chat.completions style), convert it.
        if (Array.isArray(msg.content)) {
          const contentList = [];
          for (const part of msg.content) {
            if (part?.type === 'text' && typeof part.text === 'string') {
              contentList.push({ type: 'input_text', text: part.text });
            } else if (part?.type === 'image_url' && part.image_url?.url) {
              contentList.push({ type: 'input_image', detail: 'auto', image_url: part.image_url.url });
            }
          }
          input.push({ role: 'user', content: contentList });
        } else {
          input.push({ role: 'user', content: msg.content || '' });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        // If we stored tool calls in chat.completions format, translate them to Responses items
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          if (msg.content) {
            input.push({ role: 'assistant', content: msg.content });
          }
          for (const tc of msg.tool_calls) {
            if (!tc?.id || !tc?.function?.name) continue;
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments || '{}'
            });
          }
        } else {
          input.push({ role: 'assistant', content: msg.content || '' });
        }
        continue;
      }

      if (msg.role === 'tool') {
        // Tool outputs become function_call_output items
        if (msg.tool_call_id) {
          input.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id,
            output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }
        continue;
      }
    }
    return input;
  }

  /**
   * Convert message content to OpenAI format
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
              type: 'image_url',
              image_url: {
                url: block.source?.startsWith('http')
                  ? block.source
                  : `data:${block.mediaType || 'image/png'};base64,${block.source}`
              }
            };

          case 'tool_result':
            // Handled separately in _convertMessages
            return null;

          default:
            return block;
        }
      }).filter(Boolean);
    }

    return msg.content;
  }

  /**
   * Map OpenAI finish reason to unified format
   * @param {string} reason
   * @returns {string}
   */
  _mapStopReason(reason) {
    switch (reason) {
      case 'stop':
        return StopReasons.END_TURN;
      case 'length':
        return StopReasons.MAX_TOKENS;
      case 'tool_calls':
        return StopReasons.TOOL_USE;
      case 'content_filter':
        return StopReasons.STOP_SEQUENCE;
      default:
        return StopReasons.END_TURN;
    }
  }

  /**
   * Parse tool calls from OpenAI Chat Completions response
   * @param {Object} response
   * @returns {UnifiedToolCall[]}
   */
  parseToolCalls(response) {
    const message = response.choices?.[0]?.message;
    if (!message?.tool_calls) return [];

    return message.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}')
    }));
  }

  /**
   * Normalize OpenAI response to unified format
   * @param {Object} response
   * @returns {UnifiedResponse}
   */
  normalizeResponse(response) {
    const message = response.choices?.[0]?.message;
    const finishReason = response.choices?.[0]?.finish_reason;

    // Extract text content
    const textContent = message?.content || '';

    // Extract tool calls
    const toolCalls = this.parseToolCalls(response);

    return createResponse({
      id: response.id,
      model: response.model,
      content: textContent,
      toolCalls,
      stopReason: this._mapStopReason(finishReason),
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0
      },
      rawContent: message
    });
  }

  /**
   * Create a message (non-streaming)
   * Auto-detects whether to use Chat Completions or Responses API
   * @param {UnifiedRequest} request
   * @returns {Promise<UnifiedResponse>}
   */
  async createMessage(request) {
    this.validateRequest(request);
    const prepared = this.prepareRequest(request);

    const client = this._getClient();
    const useResponsesAPI = shouldUseResponsesAPI(prepared.model);

    if (useResponsesAPI) {
      return this._createMessageWithResponses(client, prepared);
    } else {
      return this._createMessageWithCompletions(client, prepared);
    }
  }

  /**
   * Create message using Chat Completions API
   * @private
   */
  async _createMessageWithCompletions(client, prepared) {
    const openaiRequest = {
      model: prepared.model,
      max_tokens: prepared.maxTokens || 4096,
      messages: this._convertMessages(prepared.messages, prepared.systemPrompt)
    };

    if (prepared.tools && prepared.tools.length > 0) {
      openaiRequest.tools = this.convertTools(prepared.tools);
    }

    if (prepared.temperature !== undefined) {
      openaiRequest.temperature = prepared.temperature;
    }

    if (prepared.stopSequences && prepared.stopSequences.length > 0) {
      openaiRequest.stop = prepared.stopSequences;
    }

    try {
      const response = await client.chat.completions.create(openaiRequest);
      return this.normalizeResponse(response);
    } catch (error) {
      throw this._enhanceError(error);
    }
  }

  /**
   * Create message using Responses API (GPT-5+)
   * @private
   */
  async _createMessageWithResponses(client, prepared) {
    const chatTools = this.convertTools(prepared.tools);
    const responsesTools = this._convertToolsForResponses(chatTools);
    const messages = this._convertMessages(prepared.messages, prepared.systemPrompt);
    const instructions = this._extractInstructions(messages);

    const inputItems = this._pendingToolOutputs || this._convertMessagesForResponses(messages);

    const responseParams = {
      model: prepared.model,
      instructions,
      input: inputItems,
      tools: responsesTools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      truncation: 'auto',
      max_output_tokens: prepared.maxTokens || 64000,
      temperature: prepared.temperature ?? 0.1
    };

    // Add GPT-5.2 specific options
    if (prepared.model.includes('5.2')) {
      responseParams.reasoning = { effort: 'none' };
      responseParams.text = { verbosity: 'medium' };
    }

    if (this._previousResponseId) {
      responseParams.previous_response_id = this._previousResponseId;
    }

    try {
      const response = await client.responses.create(responseParams);
      
      this._previousResponseId = response.id;
      this._pendingToolOutputs = null;

      const outputItems = response.output || [];
      const textContent = outputItems
        .filter(i => i.type === 'message' || typeof i === 'string')
        .map(i => typeof i === 'string' ? i : i.content)
        .join('');

      const toolCalls = outputItems
        .filter(i => i.type === 'function_call')
        .map(tc => ({
          id: tc.call_id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments || '{}')
        }));

      return createResponse({
        id: response.id,
        model: prepared.model,
        content: textContent,
        toolCalls,
        stopReason: toolCalls.length > 0 ? StopReasons.TOOL_USE : StopReasons.END_TURN,
        usage: {
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0
        }
      });
    } catch (error) {
      throw this._enhanceError(error);
    }
  }

  /**
   * Stream a message response
   * Auto-detects whether to use Chat Completions or Responses API
   * @param {UnifiedRequest} request
   * @returns {AsyncGenerator<UnifiedChunk>}
   */
  async *streamMessage(request) {
    this.validateRequest(request);
    const prepared = this.prepareRequest(request);

    const client = this._getClient();
    const useResponsesAPI = shouldUseResponsesAPI(prepared.model);

    if (useResponsesAPI) {
      yield* this._streamMessageWithResponses(client, prepared);
    } else {
      yield* this._streamMessageWithCompletions(client, prepared);
    }
  }

  /**
   * Stream message using Chat Completions API
   * @private
   */
  async *_streamMessageWithCompletions(client, prepared) {
    const openaiRequest = {
      model: prepared.model,
      max_tokens: prepared.maxTokens || 4096,
      messages: this._convertMessages(prepared.messages, prepared.systemPrompt),
      stream: true
    };

    if (prepared.tools && prepared.tools.length > 0) {
      openaiRequest.tools = this.convertTools(prepared.tools);
    }

    if (prepared.temperature !== undefined) {
      openaiRequest.temperature = prepared.temperature;
    }

    try {
      const stream = await client.chat.completions.create(openaiRequest);

      const toolCallStates = new Map();
      let fullContent = '';

      const parseToolArgs = (rawArgs) => {
        if (!rawArgs) return {};
        try {
          return JSON.parse(rawArgs);
        } catch {
          return {};
        }
      };

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const finishReason = chunk.choices?.[0]?.finish_reason;

        // Text content
        if (delta?.content) {
          fullContent += delta.content;
          yield {
            type: 'text',
            text: delta.content
          };
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = Number.isInteger(tc.index) ? tc.index : 0;
            const existing = toolCallStates.get(index) || {
              id: null,
              name: null,
              argumentsText: ''
            };
            const isNew = !toolCallStates.has(index);

            if (tc.id) {
              existing.id = tc.id;
            }
            if (typeof tc.function?.name === 'string' && tc.function.name.trim()) {
              existing.name = tc.function.name.trim();
            }
            if (typeof tc.function?.arguments === 'string') {
              existing.argumentsText += tc.function.arguments;
            }

            toolCallStates.set(index, existing);

            if (isNew) {
              yield {
                type: 'tool_use_start',
                toolId: existing.id || `tool_call_${index}`,
                toolName: existing.name || 'unknown'
              };
            }

            if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
              yield {
                type: 'tool_use_delta',
                toolId: existing.id || `tool_call_${index}`,
                argumentsDelta: tc.function.arguments
              };
            }
          }
        }

        // Stream finished
        if (finishReason) {
          const orderedToolCalls = Array.from(toolCallStates.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([index, state]) => ({
              id: state.id || `tool_call_${index}`,
              name: state.name || 'unknown',
              arguments: parseToolArgs(state.argumentsText)
            }));

          for (const toolCall of orderedToolCalls) {
            yield {
              type: 'tool_use_end',
              toolId: toolCall.id,
              toolName: toolCall.name,
              arguments: toolCall.arguments
            };
          }

          yield {
            type: 'done',
            response: createResponse({
              id: chunk.id,
              model: chunk.model,
              content: fullContent,
              toolCalls: orderedToolCalls,
              stopReason: this._mapStopReason(finishReason),
              usage: {
                inputTokens: 0,
                outputTokens: 0
              }
            })
          };
        }
      }
    } catch (error) {
      throw this._enhanceError(error);
    }
  }

  /**
   * Stream message using Responses API (GPT-5+)
   * @private
   */
  async *_streamMessageWithResponses(client, prepared) {
    const chatTools = this.convertTools(prepared.tools);
    const responsesTools = this._convertToolsForResponses(chatTools);
    const messages = this._convertMessages(prepared.messages, prepared.systemPrompt);
    const instructions = this._extractInstructions(messages);

    const inputItems = this._pendingToolOutputs || this._convertMessagesForResponses(messages);

    const responseParams = {
      model: prepared.model,
      instructions,
      input: inputItems,
      tools: responsesTools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      truncation: 'auto',
      max_output_tokens: prepared.maxTokens || 64000,
      temperature: prepared.temperature ?? 0.1,
      stream: true
    };

    if (prepared.model.includes('5.2')) {
      responseParams.reasoning = { effort: 'none' };
      responseParams.text = { verbosity: 'medium' };
    }

    if (this._previousResponseId) {
      responseParams.previous_response_id = this._previousResponseId;
    }

    try {
      const stream = await client.responses.create(responseParams);

      let textContent = '';
      let responseId = null;
      let outputItems = [];

      for await (const chunk of stream) {
        if (chunk.id) {
          responseId = chunk.id;
        }

        // Collect output items from the stream
        if (chunk.output) {
          outputItems = chunk.output;
        }

        // Collect completed function calls
        if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
          const existingIndex = outputItems.findIndex(item => item.call_id === chunk.item.call_id);
          if (existingIndex >= 0) {
            outputItems[existingIndex] = chunk.item;
          } else {
            outputItems.push(chunk.item);
          }
        }

        // Stream text deltas
        if (chunk.output_text_delta) {
          textContent += chunk.output_text_delta;
          yield { type: 'text', text: chunk.output_text_delta };
        } else if (chunk.delta?.text) {
          textContent += chunk.delta.text;
          yield { type: 'text', text: chunk.delta.text };
        } else if (chunk.text) {
          textContent += chunk.text;
          yield { type: 'text', text: chunk.text };
        }
      }

      this._previousResponseId = responseId;
      this._pendingToolOutputs = null;

      const toolCalls = outputItems
        .filter(i => i?.type === 'function_call')
        .map(tc => ({
          id: tc.call_id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments || '{}')
        }));

      yield {
        type: 'done',
        response: createResponse({
          id: responseId,
          model: prepared.model,
          content: textContent,
          toolCalls,
          stopReason: toolCalls.length > 0 ? StopReasons.TOOL_USE : StopReasons.END_TURN,
          usage: { inputTokens: 0, outputTokens: 0 }
        })
      };
    } catch (error) {
      throw this._enhanceError(error);
    }
  }

  /**
   * Set pending tool outputs for next Responses API call
   * Used for stateful tool-calling conversations
   * @param {Object[]} toolOutputs
   */
  setPendingToolOutputs(toolOutputs) {
    this._pendingToolOutputs = toolOutputs;
  }

  /**
   * Reset Responses API state (for new conversations)
   */
  resetResponsesState() {
    this._previousResponseId = null;
    this._pendingToolOutputs = null;
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error
   * @returns {boolean}
   */
  isRateLimitError(error) {
    return (
      error.status === 429 ||
      error.code === 'rate_limit_exceeded' ||
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
      error.code === 'insufficient_quota' ||
      error.message?.toLowerCase().includes('quota')
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
      error.code === 'invalid_api_key' ||
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
 * Create an OpenAI adapter with the given API key
 * @param {string} apiKey
 * @param {Object} [options]
 * @returns {OpenAIAdapter}
 */
function createOpenAIAdapter(apiKey, options = {}) {
  return new OpenAIAdapter({ apiKey, ...options });
}

module.exports = { OpenAIAdapter, createOpenAIAdapter, shouldUseResponsesAPI };
