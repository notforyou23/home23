/**
 * ChatCompletionsClient - Adapter for local LLMs using Chat Completions API
 *
 * This client provides the same interface as GPT5Client but uses the standard
 * OpenAI Chat Completions API format, which is compatible with:
 * - Ollama (http://192.168.6.205:11434/v1)
 * - vLLM (http://localhost:8000/v1)
 * - llama.cpp server
 * - LocalAI
 * - Any OpenAI-compatible local inference server
 *
 * DESIGN PRINCIPLES:
 * 1. Same interface as GPT5Client - drop-in replacement
 * 2. Transforms Responses API format → Chat Completions format
 * 3. Transforms responses back to GPT5Client expected format
 * 4. Supports streaming for responsive output
 * 5. Model name mapping via config (gpt-5.5 → llama3.1:70b)
 * 6. Graceful degradation for unsupported features
 */

function loadOpenAI() {
  try {
    return require('openai');
  } catch (error) {
    error.message = `OpenAI SDK is unavailable: ${error.message}`;
    throw error;
  }
}

const { normalizeProviderCompletion } = require('../../../lib/provider-completion');
const {
  abortableDelay,
  awaitWithCancellation,
  boundedOutputJson,
  cancelAsyncProviderStream,
  createUtf8OutputBudget,
  reportProviderActivity,
  requireMaxOutputBytes,
  requireMaxOutputTokens,
  rethrowCancellation,
  rethrowNonRetryable,
  resultTooLarge,
  throwIfAborted,
} = require('../../../lib/provider-execution');

const MAX_STREAM_TOOL_CALLS = 4096;

function requireProviderId(value) {
  const providerId = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw Object.assign(new Error('Canonical providerId is required'), {
      code: 'provider_model_mismatch', retryable: false,
    });
  }
  return providerId;
}

function mergeToolCallDeltas(toolCalls, deltas, outputBudget) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : 0;
    if (index < 0 || index >= MAX_STREAM_TOOL_CALLS) {
      throw resultTooLarge('Provider tool call', outputBudget.maxBytes);
    }
    if (!toolCalls[index]) {
      const initialId = delta.id || `call_${index}`;
      const initialName = delta.function?.name || '';
      outputBudget.reserve(`tool-${index}-structure`, 64, 'Provider tool call');
      toolCalls[index] = {
        id: outputBudget.set(
          `tool-${index}-id`, initialId, 'Provider tool call',
        ),
        name: outputBudget.set(
          `tool-${index}-name`, initialName, 'Provider tool call',
        ),
        arguments: '',
      };
    }
    if (delta.id) {
      toolCalls[index].id = outputBudget.set(
        `tool-${index}-id`, delta.id, 'Provider tool call',
      );
    }
    if (delta.function?.name) {
      toolCalls[index].name = outputBudget.set(
        `tool-${index}-name`, delta.function.name, 'Provider tool call',
      );
    }
    if (delta.function?.arguments) {
      toolCalls[index].arguments = outputBudget.append(
        `tool-${index}-arguments`, toolCalls[index].arguments,
        delta.function.arguments, 'Provider tool call',
      );
    }
  }
}

class ChatCompletionsClient {
  constructor(config = {}, logger = null) {
    this.logger = logger;
    this.config = { ...config, providerId: requireProviderId(config.providerId) };
    Object.defineProperty(this, 'providerId', {
      value: this.config.providerId,
      enumerable: true,
      configurable: false,
      writable: false,
    });

    // Get base URL from config or environment
    // Default to Ollama's OpenAI-compatible endpoint
    const baseURL = config.baseURL ||
                    process.env.LOCAL_LLM_BASE_URL ||
                    process.env.OPENAI_BASE_URL ||
                    'http://192.168.6.205:11434/v1';

    // API key - many local servers don't need one, use dummy if not set
    const apiKey = config.apiKey ||
                   process.env.LOCAL_LLM_API_KEY ||
                   process.env.OPENAI_API_KEY ||
                   'not-needed';

    this.client = config.client || null;
    this.clientConfig = { apiKey, baseURL };

    // Model name mapping: GPT-5.2 names → local model names
    // Can be overridden via config
    this.modelMapping = config.modelMapping || {
      'gpt-5.5': 'llama3.1:70b',
      'gpt-5': 'llama3.1:70b',
      'gpt-5.4-mini': 'llama3.1:8b',
      'gpt-5.4-nano': 'llama3.1:8b',
      'gpt-4o': 'llama3.1:70b',
      'gpt-4o-mini': 'llama3.1:8b'
    };

    // Default model if none specified
    this.defaultModel = config.defaultModel || 'llama3.1:70b';

    // Features supported by the local LLM server
    this.supportsTools = config.supportsTools !== false; // Default true
    this.supportsStreaming = config.supportsStreaming !== false; // Default true

    // Add OpenAI SDK-compatible interface for ai-handler.js compatibility
    // This allows ChatCompletionsClient to be used as a drop-in replacement
    // where code expects openai.chat.completions.create()
    this.chat = {
      completions: {
        create: async (params) => {
          return await this.getClient().chat.completions.create(params);
        }
      }
    };

    // Add Responses API wrapper for ai-handler.js compatibility
    // Translates Responses API calls to Chat Completions format
    this.responses = {
      create: async (params) => {
        // Transform Responses API params to our generate() method format
        const generateOptions = {
          model: params.model,
          instructions: params.instructions,
          input: params.input,
          tools: params.tools || [],
          tool_choice: params.tool_choice,
          temperature: params.temperature,
          maxOutputTokens: params.max_output_tokens,
        };

        // Use our generate method which returns GPT5Client-compatible format
        return await this.generate(generateOptions);
      }
    };

    this.logger?.info?.('ChatCompletionsClient initialized', {
      baseURL,
      defaultModel: this.defaultModel,
      hasApiKey: apiKey !== 'not-needed',
      supportsTools: this.supportsTools,
      supportsStreaming: this.supportsStreaming
    });
  }

  getClient() {
    if (!this.client) {
      const OpenAI = loadOpenAI();
      this.client = new OpenAI(this.clientConfig);
    }
    return this.client;
  }

  /**
   * Map GPT-5 model names to local model names
   */
  mapModelName(requestedModel) {
    if (!requestedModel) {
      return this.defaultModel;
    }

    // Check explicit mapping
    if (this.modelMapping[requestedModel]) {
      const mapped = this.modelMapping[requestedModel];
      this.logger?.debug?.('Model mapped', { from: requestedModel, to: mapped });
      return mapped;
    }

    // If no mapping, use as-is (allows direct local model specification)
    return requestedModel;
  }

  /**
   * Transform Responses API input format to Chat Completions messages
   *
   * Responses API uses:
   * - input: string or array of {type: 'message', role, content: [{type: 'input_text', text}]}
   * - instructions: string (system prompt)
   *
   * Chat Completions uses:
   * - messages: [{role: 'system'|'user'|'assistant', content: string}]
   */
  transformInputToMessages(options) {
    const messages = [];
    const { instructions, systemPrompt, input, messages: inputMessages } = options;

    // Add system message from instructions or systemPrompt
    // Include English language instruction for bilingual models like Qwen
    const systemContent = systemPrompt || instructions;
    const languageInstruction = 'Always respond in English.';

    if (systemContent && systemContent.trim().length > 0) {
      messages.push({
        role: 'system',
        content: `${languageInstruction}\n\n${systemContent.trim()}`
      });
    } else {
      // Even without system prompt, add language instruction
      messages.push({
        role: 'system',
        content: languageInstruction
      });
    }

    // Handle input parameter (Responses API format)
    if (input !== null && input !== undefined) {
      if (typeof input === 'string') {
        // Simple string input → user message
        messages.push({
          role: 'user',
          content: input
        });
      } else if (Array.isArray(input)) {
        // Array of message objects
        for (const item of input) {
          if (item.type === 'message') {
            // Extract text content from Responses API format
            let content = '';
            if (typeof item.content === 'string') {
              content = item.content;
            } else if (Array.isArray(item.content)) {
              // Content is array like [{type: 'input_text', text: '...'}]
              content = item.content
                .filter(c => c.type === 'input_text' || c.type === 'output_text' || c.text)
                .map(c => c.text)
                .join('\n');
            }

            if (content) {
              messages.push({
                role: item.role || 'user',
                content
              });
            }
          }
        }
      }
    }

    // Handle messages array (already in Chat Completions format)
    if (inputMessages && inputMessages.length > 0) {
      for (const msg of inputMessages) {
        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          content = msg.content
            .filter(c => c.text)
            .map(c => c.text)
            .join('\n');
        }

        if (content) {
          messages.push({
            role: msg.role || 'user',
            content
          });
        }
      }
    }

    // Ensure we have at least one user message
    if (messages.length === 0 || messages.every(m => m.role === 'system')) {
      this.logger?.warn?.('No user content provided, adding placeholder');
      messages.push({
        role: 'user',
        content: 'Please respond.'
      });
    }

    return messages;
  }

  /**
   * Transform tools from Responses API format to Chat Completions format
   * Filters out unsupported tool types (web_search, code_interpreter)
   */
  transformTools(tools) {
    if (!tools || tools.length === 0 || !this.supportsTools) {
      return [];
    }

    const transformed = [];

    for (const tool of tools) {
      // Skip built-in OpenAI tools that local LLMs don't support
      if (tool.type === 'web_search' || tool.type === 'code_interpreter' || tool.type === 'mcp') {
        this.logger?.debug?.('Skipping unsupported tool type', { type: tool.type });
        continue;
      }

      // Function tools pass through with minor format adjustments
      if (tool.type === 'function') {
        transformed.push({
          type: 'function',
          function: {
            name: tool.name || tool.function?.name,
            description: tool.description || tool.function?.description,
            parameters: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} }
          }
        });
      }
    }

    return transformed;
  }

  /**
   * Generate response using Chat Completions API with STREAMING
   * Matches GPT5Client.generate() interface exactly
   */
  async generate(options = {}) {
    const {
      model = 'gpt-5.5',
      maxOutputTokens,
      tools = [],
      toolChoice,
      tool_choice,
      temperature,
      top_p,
      // These Responses API options are logged but not used
      reasoning,
      reasoningEffort,
      verbosity,
      parallelToolCalls,
      parallel_tool_calls,
      previousResponseId,
      conversationId,
      include
    } = options;

    requireMaxOutputTokens(maxOutputTokens, this.config.providerId, model);
    requireMaxOutputBytes(options.maxOutputBytes, this.config.providerId, model);
    throwIfAborted(options.signal);

    // Log unsupported options for debugging
    if (reasoning || reasoningEffort) {
      this.logger?.debug?.('Reasoning options not supported by Chat Completions API', {
        reasoning,
        reasoningEffort
      });
    }

    // Map model name
    const mappedModel = this.mapModelName(model);

    // Transform input to messages
    const messages = this.transformInputToMessages(options);

    // Build Chat Completions payload
    const payload = {
      model: mappedModel,
      messages,
      stream: this.supportsStreaming
    };

    // Add optional parameters
    if (temperature !== undefined) {
      payload.temperature = temperature;
    }
    if (top_p !== undefined) {
      payload.top_p = top_p;
    }

    // Transform and add tools if any
    const transformedTools = this.transformTools(tools);
    if (transformedTools.length > 0) {
      payload.tools = transformedTools;

      const effectiveToolChoice = tool_choice ?? toolChoice ?? 'auto';
      payload.tool_choice = effectiveToolChoice;
    }

    this.logger?.debug?.('Chat Completions request', {
      model: mappedModel,
      originalModel: model,
      messageCount: messages.length,
      maxTokens: maxOutputTokens,
      hasTools: transformedTools.length > 0,
      streaming: this.supportsStreaming
    });

    try {
      throwIfAborted(options.signal);
      return this.supportsStreaming
        ? await this.generateStreaming(payload, model, options)
        : await this.generateNonStreaming(payload, model, options);
    } catch (error) {
      rethrowCancellation(error, options.signal);
      this.logger?.error?.('Chat Completions API call failed', {
        error: error.message,
        model: mappedModel,
        baseURL: this.clientConfig.baseURL
      });
      throw error;
    }
  }

  /**
   * Generate with streaming (preferred method)
   */
  async generateStreaming(payload, originalModel, options = {}) {
    const {
      signal = null, onChunk = null, onProviderActivity = null,
      maxOutputTokens = null, maxOutputBytes = null,
    } = options;
    const requestPayload = {
      ...payload,
      max_tokens: requireMaxOutputTokens(
        maxOutputTokens, this.config.providerId, originalModel,
      ),
    };
    throwIfAborted(signal);
    const stream = await awaitWithCancellation(
      () => this.getClient().chat.completions.create(
        requestPayload, signal ? { signal } : undefined,
      ),
      signal,
    );

    let content = '';
    let reasoning = '';
    let terminalReceived = false;
    let finishReason = null;
    let hadError = false;
    let streamError = null;
    const toolCalls = [];
    let responseId = null;
    let responseModel = requestPayload.model;
    let usage = null;
    const outputBudget = createUtf8OutputBudget(
      requireMaxOutputBytes(maxOutputBytes, this.config.providerId, originalModel),
      'Provider output',
    );

    const iterator = stream[Symbol.asyncIterator]();
    let streamExitReason = null;
    try {
      while (true) {
        const next = await awaitWithCancellation(() => iterator.next(), signal);
        if (next.done) break;
        const chunk = next.value;
        reportProviderActivity(onProviderActivity, { type: 'chat.completion.chunk' });
        responseId = chunk.id || responseId;
        responseModel = chunk.model || responseModel;
        usage = chunk.usage || usage;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          content = outputBudget.append(
            'content', content, choice.delta.content, 'Provider content',
          );
          onChunk?.({ type: 'chunk', text: choice.delta.content });
        }
        if (choice?.delta?.reasoning) {
          reasoning = outputBudget.append(
            'reasoning', reasoning, choice.delta.reasoning, 'Provider reasoning',
          );
        }
        mergeToolCallDeltas(
          toolCalls, choice?.delta?.tool_calls || [], outputBudget,
        );
        if (choice?.finish_reason) {
          terminalReceived = true;
          finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      streamExitReason = signal?.aborted ? signal.reason : error;
      rethrowCancellation(error, signal);
      rethrowNonRetryable(error);
      this.logger?.error?.('Error during stream processing', {
        error: error.message,
        hasPartialText: content.length > 0,
      });
      hadError = true;
      streamError = error;
    } finally {
      if (streamExitReason) {
        cancelAsyncProviderStream(stream, iterator, streamExitReason);
      }
    }

    if (!content && reasoning) content = reasoning;
    throwIfAborted(signal);
    return normalizeProviderCompletion({
      content, terminalReceived, finishReason, hadError, error: streamError,
      responseId, model: originalModel, observedModel: responseModel,
      provider: this.config.providerId,
      usage: usage ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      } : null,
      output: toolCalls.length ? toolCalls.map(toolCall => ({
        type: 'function_call', id: toolCall.id,
        name: toolCall.name, arguments: toolCall.arguments,
      })) : null,
    });
  }

  /**
   * Generate without streaming (fallback)
   */
  async generateNonStreaming(payload, originalModel, options = {}) {
    const requestPayload = {
      ...payload,
      stream: false,
      max_tokens: requireMaxOutputTokens(
        options.maxOutputTokens, this.config.providerId, originalModel,
      ),
    };
    throwIfAborted(options.signal);
    const response = await awaitWithCancellation(
      () => this.getClient().chat.completions.create(
        requestPayload, options.signal ? { signal: options.signal } : undefined,
      ),
      options.signal,
    );
    reportProviderActivity(options.onProviderActivity, { type: 'chat.completion' });

    const choice = response.choices?.[0];
    // Thinking models (e.g. qwen3.5:9b) return output in .reasoning, not .content
    const outputBudget = createUtf8OutputBudget(
      requireMaxOutputBytes(
        options.maxOutputBytes, this.config.providerId, originalModel,
      ),
      'Provider output',
    );
    const content = outputBudget.set(
      'content', choice?.message?.content || choice?.message?.reasoning || '',
      'Provider content',
    );
    if (choice?.message?.tool_calls) {
      outputBudget.set(
        'tool-calls', boundedOutputJson(
          choice.message.tool_calls, outputBudget.maxBytes, 'Provider tool call',
        ), 'Provider tool call',
      );
    }
    return normalizeProviderCompletion({
      content,
      terminalReceived: Boolean(choice?.finish_reason),
      finishReason: choice?.finish_reason || null,
      hadError: false,
      responseId: response.id,
      model: originalModel,
      observedModel: response.model || requestPayload.model,
      provider: this.config.providerId,
      usage: response.usage,
      output: choice?.message?.tool_calls || null,
    });
  }

  /**
   * Format response to match GPT5Client expected output
   */
  formatResponse(data) {
    const {
      content,
      toolCalls = [],
      responseId,
      model,
      originalModel,
      usage,
      finishReason,
      hadError = false,
      errorType = null
    } = data;

    const response = {
      content: content || '',
      output_text: content || '', // Responses API compatibility
      reasoning: null, // Chat Completions doesn't have separate reasoning
      responseId,
      id: responseId, // Responses API compatibility
      conversationId: null, // Not supported
      model,
      usage: usage ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      } : null,
      hadError,
      errorType,
      // Additional metadata for debugging
      _backend: 'chat-completions',
      _originalModel: originalModel,
      _finishReason: finishReason
    };

    // Add tool calls if present (format for GPT5Client compatibility)
    if (toolCalls.length > 0) {
      response.output = toolCalls.map(tc => ({
        type: 'function_call',
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments
      }));
    }

    return response;
  }

  /**
   * Generate with retry logic (matches GPT5Client interface)
   */
  async generateWithRetry(options = {}, maxRetries = 3) {
    let lastError = null;
    let lastResult = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      rethrowCancellation(null, options.signal);
      try {
        const result = await this.generate(options);
        rethrowCancellation(null, options.signal);
        lastResult = result;

        if (result.status === 'complete') {
          if (attempt > 0) {
            this.logger?.info?.('Retry successful', { attempt: attempt + 1 });
          }
          return result;
        }

        if (result.error?.retryable === false) return result;

        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          this.logger?.warn?.(`Response incomplete, retrying after ${backoff}ms`, {
            attempt: attempt + 1,
            maxRetries,
            errorType: result.error?.code,
          });
          await abortableDelay(backoff, options.signal);
          rethrowCancellation(null, options.signal);
          continue;
        }

        return result;
      } catch (error) {
        rethrowCancellation(error, options.signal);
        rethrowNonRetryable(error);
        lastError = error;

        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          this.logger?.warn?.(`API call failed, retrying after ${backoff}ms`, {
            error: error.message,
            attempt: attempt + 1
          });
          await abortableDelay(backoff, options.signal);
          rethrowCancellation(null, options.signal);
        }
      }
    }

    if (lastResult) return lastResult;
    this.logger?.error?.(`All ${maxRetries} retry attempts failed`);
    throw lastError || new Error('Chat Completions call failed after all retries');
  }

  /**
   * Fast generation (matches GPT5Client interface)
   */
  async generateFast(options = {}) {
    const model = options.model || 'gpt-5.4-mini';
    return this.generateWithRetry({
      ...options,
      model,
    }, 3);
  }

  /**
   * Generate with reasoning (maps to standard generation for local LLMs)
   * Local LLMs don't have separate reasoning, but we can request more tokens
   */
  async generateWithReasoning(options = {}) {
    this.logger?.debug?.('generateWithReasoning called - local LLMs use standard generation');
    return this.generateWithRetry({
      ...options,
    }, 3);
  }

  /**
   * Generate with web search using DuckDuckGo (free, no API key needed)
   * Performs actual web search and includes results in context for local LLM
   */
  async generateWithWebSearch(options = {}) {
    const { query, instructions = '' } = options;
    const searchQuery = query || options.input || '';

    let searchContext = '';

    if (searchQuery) {
      try {
        const { getSearchInstance } = require('../tools/web-search-free');
        const searcher = getSearchInstance(this.logger, {
          searxngUrl: this.config?.searxngUrl || process.env.SEARXNG_URL
        });

        this.logger?.info?.('🔍 Performing web search for local LLM', { query: searchQuery });
        const searchResult = await searcher.searchAndFormat(searchQuery);

        if (searchResult.success && searchResult.results.length > 0) {
          searchContext = '\n\n--- Web Search Results ---\n' + searchResult.formatted;
          this.logger?.info?.('✅ Web search completed', {
            resultCount: searchResult.results.length,
            source: searchResult.source
          });
        } else {
          this.logger?.warn?.('Web search returned no results', { query: searchQuery });
          searchContext = '\n\nNote: Web search returned no results. Please answer based on your training knowledge.';
        }
      } catch (error) {
        this.logger?.error?.('Web search failed', { error: error.message });
        searchContext = '\n\nNote: Web search temporarily unavailable. Please answer based on your training knowledge.';
      }
    }

    const enhancedInstructions = instructions + searchContext;

    return this.generateWithRetry({
      ...options,
      instructions: enhancedInstructions,
      input: searchQuery || options.input
    }, 3);
  }

  /**
   * Text extraction helper (matches GPT5Client interface)
   * For Chat Completions, content is already a string
   */
  extractTextFromResponse(response) {
    if (!response) return '';

    // If response is already a string
    if (typeof response === 'string') return response;

    // If it's our formatted response object
    if (response.content) return response.content;

    // If it's a raw Chat Completions response
    if (response.choices?.[0]?.message?.content) {
      return response.choices[0].message.content;
    }

    return '';
  }

  /**
   * Extract tool calls (matches GPT5Client interface)
   */
  extractToolCalls(response) {
    if (!response) return [];

    // From our formatted response
    if (response.output) {
      return response.output.filter(item =>
        item.type === 'function_call' || item.type === 'tool_use'
      );
    }

    // From raw Chat Completions response
    if (response.choices?.[0]?.message?.tool_calls) {
      return response.choices[0].message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
        type: 'function_call'
      }));
    }

    return [];
  }

  /**
   * Container methods - Not supported by local LLMs
   * These throw descriptive errors to prevent silent failures
   */
  async createContainer() {
    throw new Error('Code execution containers are not supported with local LLMs. Use OpenAI backend for code_interpreter features.');
  }

  async uploadFileToContainer() {
    throw new Error('Container file operations are not supported with local LLMs.');
  }

  async listContainerFiles() {
    throw new Error('Container file operations are not supported with local LLMs.');
  }

  async downloadFileFromContainer() {
    throw new Error('Container file operations are not supported with local LLMs.');
  }

  async executeInContainer() {
    throw new Error('Code execution containers are not supported with local LLMs. Use OpenAI backend for code_interpreter features.');
  }

  async deleteContainer() {
    throw new Error('Container operations are not supported with local LLMs.');
  }

  async generateWithCodeInterpreter() {
    throw new Error('Code interpreter is not supported with local LLMs. Use OpenAI backend for this feature.');
  }

  /**
   * Web search data extraction (returns empty - not supported)
   */
  extractWebSearchData() {
    return { sources: [], citations: [] };
  }

  /**
   * Reasoning extraction (returns null - not separately available)
   */
  extractReasoning() {
    return null;
  }
}

module.exports = { ChatCompletionsClient };
