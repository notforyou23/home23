/**
 * ChatCompletionsClient - Adapter for local LLMs using Chat Completions API
 *
 * This client provides the same interface as GPT5Client but uses the standard
 * OpenAI Chat Completions API format, which is compatible with:
 * - Ollama (http://localhost:11434/v1)
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
 * 5. Model name mapping via config (gpt-5.2 → llama3.1:70b)
 * 6. Graceful degradation for unsupported features
 */

const OpenAI = require('openai');

// ─── Per-baseURL concurrency gate + 429 retry ─────────────────────────────────
// Some upstreams (ollama-cloud, notably) rate-limit "too many concurrent
// requests" per API key well below what the cognitive engine issues in flight.
// We cap concurrent chat.completions.create() calls per baseURL and retry 429s
// with exponential backoff + jitter. Scope is module-level so every
// ChatCompletionsClient instance sharing a baseURL shares the gate.

const DEFAULT_MAX_CONCURRENT = Number(process.env.CHAT_COMPLETIONS_MAX_CONCURRENT) || 2;
const CONCURRENCY_GATES = new Map(); // baseURL -> { inFlight, queue, limit }

function getGate(baseURL) {
  let gate = CONCURRENCY_GATES.get(baseURL);
  if (!gate) {
    gate = { inFlight: 0, queue: [], limit: DEFAULT_MAX_CONCURRENT };
    CONCURRENCY_GATES.set(baseURL, gate);
  }
  return gate;
}

function acquireGateSlot(gate) {
  if (gate.inFlight < gate.limit) {
    gate.inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => gate.queue.push(resolve));
}

function releaseGateSlot(gate) {
  gate.inFlight--;
  const next = gate.queue.shift();
  if (next) {
    gate.inFlight++;
    next();
  }
}

function is429(error) {
  if (!error) return false;
  if (error.status === 429) return true;
  const msg = String(error.message || '');
  return /\b429\b|too many concurrent requests|rate.?limit/i.test(msg);
}

async function createWithGateAndRetry(client, payload, logger) {
  const baseURL = String(client.baseURL || '');
  const gate = getGate(baseURL);
  const maxAttempts = 5;
  await acquireGateSlot(gate);
  try {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await client.chat.completions.create(payload);
      } catch (error) {
        lastErr = error;
        if (!is429(error) || attempt === maxAttempts - 1) throw error;
        const backoff = Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        logger?.warn?.('Chat Completions 429, backing off', {
          baseURL,
          attempt: attempt + 1,
          backoffMs: backoff,
          model: payload?.model,
        });
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastErr || new Error('Chat Completions 429 retry exhausted');
  } finally {
    releaseGateSlot(gate);
  }
}

class ChatCompletionsClient {
  constructor(config = {}, logger = null) {
    this.logger = logger;
    this.config = config;

    // Get base URL from config or environment
    // Default to Ollama's OpenAI-compatible endpoint
    const baseURL = config.baseURL ||
                    process.env.LOCAL_LLM_BASE_URL ||
                    process.env.OPENAI_BASE_URL ||
                    'http://localhost:11434/v1';

    // API key - many local servers don't need one, use dummy if not set
    const apiKey = config.apiKey ||
                   process.env.LOCAL_LLM_API_KEY ||
                   process.env.OPENAI_API_KEY ||
                   'not-needed';

    this.client = new OpenAI({
      apiKey,
      baseURL
    });

    // Model name mapping: GPT-5.2 names → local model names
    // Can be overridden via config
    this.modelMapping = config.modelMapping || {
      'gpt-5.2': 'llama3.1:70b',
      'gpt-5': 'llama3.1:70b',
      'gpt-5-mini': 'llama3.1:8b',
      'gpt-5-nano': 'llama3.1:8b',
      'gpt-4o': 'llama3.1:70b',
      'gpt-4o-mini': 'llama3.1:8b'
    };

    // Default model if none specified
    this.defaultModel = config.defaultModel || 'llama3.1:70b';

    // Features supported by the local LLM server
    this.supportsTools = config.supportsTools !== false; // Default true
    this.supportsStreaming = config.supportsStreaming !== false; // Default true

    this.logger?.info?.('ChatCompletionsClient initialized', {
      baseURL,
      defaultModel: this.defaultModel,
      hasApiKey: apiKey !== 'not-needed',
      supportsTools: this.supportsTools,
      supportsStreaming: this.supportsStreaming
    });
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
      model = 'gpt-5.2',
      max_output_tokens,
      maxOutputTokens,
      maxTokens,
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

    // Add max_tokens
    const effectiveMaxTokens = max_output_tokens ?? maxOutputTokens ?? maxTokens ?? 2000;
    if (effectiveMaxTokens) {
      payload.max_tokens = effectiveMaxTokens;
    }

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

    // Disable thinking for local Ollama models (e.g. qwen3.5) — thinking
    // wastes tokens on internal reasoning that the COSMO framework already handles.
    // Ollama's OpenAI-compat API accepts 'options' for model-specific params.
    if (this.client?.baseURL?.includes('11434')) {
      payload.options = { ...(payload.options || {}), think: false };
    }

    this.logger?.debug?.('Chat Completions request', {
      model: mappedModel,
      originalModel: model,
      messageCount: messages.length,
      maxTokens: effectiveMaxTokens,
      hasTools: transformedTools.length > 0,
      streaming: this.supportsStreaming
    });

    try {
      if (this.supportsStreaming) {
        return await this.generateStreaming(payload, model);
      } else {
        return await this.generateNonStreaming(payload, model);
      }
    } catch (error) {
      this.logger?.error?.('Chat Completions API call failed', {
        error: error.message,
        model: mappedModel,
        baseURL: this.client.baseURL
      });
      throw error;
    }
  }

  /**
   * Generate with streaming (preferred method)
   */
  async generateStreaming(payload, originalModel) {
    const stream = await createWithGateAndRetry(this.client, payload, this.logger);

    let aggregatedText = '';
    let finalResponse = null;
    let hadError = false;
    let errorType = null;
    let toolCalls = [];

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          aggregatedText += delta.content;
        }

        // Handle streaming tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || `call_${idx}`,
                name: tc.function?.name || '',
                arguments: ''
              };
            }
            if (tc.function?.name) {
              toolCalls[idx].name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCalls[idx].arguments += tc.function.arguments;
            }
          }
        }

        // Check for finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          finalResponse = {
            id: chunk.id,
            model: chunk.model,
            usage: chunk.usage,
            finishReason: chunk.choices[0].finish_reason
          };
        }
      }
    } catch (streamError) {
      this.logger?.error?.('Error during stream processing', {
        error: streamError.message,
        hasPartialText: aggregatedText.length > 0
      });
      hadError = true;
      errorType = 'stream_error';
    }

    // Handle no content case
    if (!aggregatedText && toolCalls.length === 0) {
      this.logger?.warn?.('No content received from Chat Completions');
      hadError = true;
      errorType = 'no_content';
    }

    return this.formatResponse({
      content: aggregatedText,
      toolCalls,
      responseId: finalResponse?.id,
      model: finalResponse?.model || payload.model,
      originalModel,
      usage: finalResponse?.usage,
      finishReason: finalResponse?.finishReason,
      hadError,
      errorType
    });
  }

  /**
   * Generate without streaming (fallback)
   */
  async generateNonStreaming(payload, originalModel) {
    payload.stream = false;

    const response = await createWithGateAndRetry(this.client, payload, this.logger);

    const choice = response.choices?.[0];
    const content = choice?.message?.content || '';
    const toolCalls = choice?.message?.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments
    })) || [];

    return this.formatResponse({
      content,
      toolCalls,
      responseId: response.id,
      model: response.model,
      originalModel,
      usage: response.usage,
      finishReason: choice?.finish_reason,
      hadError: false,
      errorType: null
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
      reasoning: null, // Chat Completions doesn't have separate reasoning
      responseId,
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

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.generate(options);

        if (result.content && result.content.length > 10 && !result.content.includes('[Error:')) {
          if (attempt > 0) {
            this.logger?.info?.('Retry successful', { attempt: attempt + 1 });
          }
          return result;
        }

        if (result.hadError && attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          this.logger?.warn?.(`Response incomplete, retrying after ${backoff}ms`, {
            attempt: attempt + 1,
            maxRetries,
            errorType: result.errorType
          });
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }

        return result;
      } catch (error) {
        lastError = error;

        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          this.logger?.warn?.(`API call failed, retrying after ${backoff}ms`, {
            error: error.message,
            attempt: attempt + 1
          });
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    this.logger?.error?.(`All ${maxRetries} retry attempts failed`);
    throw lastError || new Error('Chat Completions call failed after all retries');
  }

  /**
   * Fast generation (matches GPT5Client interface)
   */
  async generateFast(options = {}) {
    const model = options.model || 'gpt-5-mini';
    return this.generateWithRetry({
      ...options,
      model,
      maxTokens: options.maxTokens || 1000
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
      maxTokens: options.maxTokens || 6000
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
        const { FreeWebSearch } = require('../tools/web-search-free');
        const searcher = new FreeWebSearch(this.logger, {
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
