/**
 * Ollama Provider Adapter
 *
 * Adapter for Ollama's local embeddings using nomic-embed-text model.
 * Provides 768-dimensional embeddings for semantic search and memory.
 */

const { ProviderAdapter } = require('./base.js');

/**
 * @typedef {Object} EmbeddingResponse
 * @property {number[]} embedding - The embedding vector (768 dimensions for nomic-embed-text)
 * @property {string} model - Model name used for embedding
 */

class OllamaAdapter extends ProviderAdapter {
  /**
   * @param {Object} config
   * @param {string} [config.baseUrl] - Ollama API base URL (default: http://localhost:11434)
   * @param {string} [config.embeddingModel] - Embedding model name (default: nomic-embed-text)
   */
  constructor(config = {}) {
    super(config);
    // Use OpenAI-compatible endpoint for chat (supports tool calling)
    this.baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.openaiCompatibleUrl = `${this.baseUrl}/v1`;
    this.embeddingModel = config.embeddingModel || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';

    // Initialize OpenAI client for chat completions (Ollama /v1 endpoint is OpenAI-compatible)
    const OpenAI = require('openai');
    this._openaiClient = new OpenAI({
      apiKey: 'not-needed', // Ollama doesn't need API key
      baseURL: this.openaiCompatibleUrl
    });
  }

  get id() {
    return 'ollama';
  }

  get name() {
    return 'Ollama';
  }

  get capabilities() {
    return {
      tools: true,  // Ollama supports basic function calling
      advancedTools: false,  // No web_search, code_interpreter, mcp
      vision: false,  // Most Ollama models don't support vision
      thinking: false,
      streaming: true,  // Ollama supports streaming
      caching: false,
      embeddings: true,  // Ollama is also used for embeddings
      maxOutputTokens: 2048,  // Conservative for local models
      contextWindow: 8192,  // Varies by model
      reducedParallelism: true  // Signal to ai-handler for local model constraints
    };
  }

  getAvailableModels() {
    // This returns default models. Use listModels() to get actually installed models.
    return [
      'llama3.3:70b',
      'llama3.2:3b',
      'llama3.1:8b',
      'mistral:7b',
      'mixtral:8x7b',
      'codellama:13b',
      'deepseek-coder:6.7b',
      'qwen2.5-coder:7b',
      'nomic-embed-text',  // Embedding models
      'mxbai-embed-large',
      'all-minilm'
    ];
  }

  /**
   * Fetch list of actually installed models from Ollama server
   * @returns {Promise<string[]>}
   */
  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }
      const data = await response.json();
      return (data.models || []).map(m => m.name);
    } catch (error) {
      console.error('[Ollama] Failed to list models:', error.message);
      return [];
    }
  }

  /**
   * Ollama doesn't require SDK client initialization
   * We use fetch directly for embedding requests
   * @protected
   */
  _initClient() {
    // No client needed - we use fetch
    this._client = true;
  }

  /**
   * Generate an embedding for the given text
   * @param {string} text - Text to embed
   * @param {Object} [options]
   * @param {string} [options.model] - Override default embedding model
   * @returns {Promise<EmbeddingResponse>}
   */
  async embed(text, options = {}) {
    const model = options.model || this.embeddingModel;
    const endpoint = `${this.baseUrl}/api/embeddings`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt: text
        })
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `Ollama model '${model}' not found. ` +
            `Pull it with: ollama pull ${model}`
          );
        }
        const errorText = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      // Validate embedding dimensions (nomic-embed-text should be 768)
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid embedding response from Ollama');
      }

      return {
        embedding: data.embedding,
        model: model
      };

    } catch (error) {
      // Enhanced error for connection failures (Ollama offline)
      if (error.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
        throw new Error(
          `Cannot connect to Ollama at ${this.baseUrl}. ` +
          `Make sure Ollama is running with: ollama serve`
        );
      }
      throw error;
    }
  }

  /**
   * Batch embed multiple texts
   * @param {string[]} texts - Array of texts to embed
   * @param {Object} [options]
   * @returns {Promise<EmbeddingResponse[]>}
   */
  async embedBatch(texts, options = {}) {
    // Ollama doesn't have native batch API, so we do sequential requests
    // In production, consider parallelizing with Promise.all()
    const embeddings = [];
    for (const text of texts) {
      const result = await this.embed(text, options);
      embeddings.push(result);
    }
    return embeddings;
  }

  /**
   * Test connection to Ollama
   * @returns {Promise<{success: boolean, latency: number, error?: string, dimensions?: number}>}
   */
  async testConnection() {
    const start = Date.now();
    try {
      // Lightweight check: just hit /api/tags to confirm Ollama is responsive.
      // Previous approach ran a full embedding which hangs when large models
      // occupy VRAM and Ollama can't swap in the embedding model.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Ollama responded ${response.status}`);
      const data = await response.json();
      return {
        success: true,
        latency: Date.now() - start,
        dimensions: null,
        model: this.embeddingModel,
        modelCount: (data.models || []).length
      };
    } catch (error) {
      return {
        success: false,
        latency: Date.now() - start,
        error: error.message
      };
    }
  }

  /**
   * Check if Ollama server is healthy
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    const connectionTest = await this.testConnection();
    return {
      provider: this.id,
      name: this.name,
      healthy: connectionTest.success,
      latency: connectionTest.latency,
      dimensions: connectionTest.dimensions,
      model: this.embeddingModel,
      error: connectionTest.error,
      capabilities: this.capabilities,
      timestamp: Date.now()
    };
  }

  // Chat completion implementations

  /**
   * Create a chat completion (non-streaming) using OpenAI-compatible endpoint
   * @param {Object} request - Unified message request
   * @returns {Promise<Object>}
   */
  async createMessage(request) {
    const { model, messages, tools, temperature = 0.7, max_tokens } = request;

    const payload = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      stream: false,
      temperature,
      max_tokens: max_tokens || 4096
    };

    // Add tools if provided (OpenAI format)
    if (tools && tools.length > 0) {
      payload.tools = this.convertTools(tools);
      payload.tool_choice = 'auto';
    }

    try {
      const response = await this._openaiClient.chat.completions.create(payload);

      const choice = response.choices?.[0];
      const toolCalls = choice?.message?.tool_calls?.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function?.name,
          arguments: tc.function?.arguments
        }
      })) || [];

      return {
        id: response.id || `ollama_${Date.now()}`,
        model: response.model,
        content: choice?.message?.content || '',
        role: choice?.message?.role || 'assistant',
        tool_calls: toolCalls,
        usage: {
          prompt_tokens: response.usage?.prompt_tokens || 0,
          completion_tokens: response.usage?.completion_tokens || 0,
          total_tokens: response.usage?.total_tokens || 0
        },
        finish_reason: choice?.finish_reason || 'stop'
      };
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
        throw new Error(
          `Cannot connect to Ollama at ${this.baseUrl}. ` +
          `Make sure Ollama is running with: ollama serve`
        );
      }
      throw error;
    }
  }

  /**
   * Stream a chat completion using OpenAI-compatible endpoint
   * @param {Object} request - Unified message request
   * @returns {AsyncGenerator<Object>}
   */
  async *streamMessage(request) {
    const { model, messages, tools, temperature = 0.7, max_tokens } = request;

    const payload = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      stream: true,
      temperature,
      max_tokens: max_tokens || 4096
    };

    // DEBUG: Log message count and roles
    console.log(`[Ollama] Sending ${messages.length} messages to model ${model}`);
    console.log(`[Ollama] Message roles: ${messages.map(m => m.role).join(', ')}`);
    console.log(`[Ollama] First message (${messages[0]?.role}): ${messages[0]?.content?.substring(0, 200)}...`);
    console.log(`[Ollama] Last message (${messages[messages.length-1]?.role}): ${messages[messages.length-1]?.content?.substring(0, 200)}...`);

    // Add tools if provided (OpenAI format)
    if (tools && tools.length > 0) {
      payload.tools = this.convertTools(tools);
      payload.tool_choice = 'auto';
      console.log(`[Ollama] Sending ${tools.length} tools to model ${model}:`);
      console.log(`[Ollama] Tool names: ${payload.tools.map(t => t.function?.name).join(', ')}`);
    } else {
      console.log(`[Ollama] No tools provided for model ${model}`);
    }

    try {
      const stream = await this._openaiClient.chat.completions.create(payload);

      const toolCalls = [];
      let chunkCount = 0;
      let textContent = ''; // Accumulate text for XML parsing fallback

      for await (const chunk of stream) {
        chunkCount++;
        const delta = chunk.choices?.[0]?.delta;

        // Debug: Log first few chunks to see structure
        if (chunkCount <= 3) {
          console.log(`[Ollama] Chunk ${chunkCount}:`, JSON.stringify(chunk).substring(0, 300));
        }

        // Stream text content
        if (delta?.content) {
          textContent += delta.content; // Accumulate for XML parsing
          yield {
            type: 'content_delta',
            delta: {
              type: 'text',
              text: delta.content
            }
          };
        }

        // Handle tool calls (OpenAI format - works for qwen2.5:14b)
        if (delta?.tool_calls) {
          console.log(`[Ollama] Tool calls detected in chunk ${chunkCount}:`, JSON.stringify(delta.tool_calls).substring(0, 500));
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || `call_${idx}_${Date.now()}`,
                type: 'function',
                function: {
                  name: tc.function?.name || '',
                  arguments: ''
                }
              };
            }
            if (tc.function?.name) {
              toolCalls[idx].function.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      }

      // Fallback: Parse XML-format tool calls from text content (for qwen2.5-coder:7b)
      if (toolCalls.length === 0 && textContent && tools && tools.length > 0) {
        console.log(`[Ollama] No structured tool calls found, attempting XML parsing...`);
        const xmlToolCalls = this._parseXMLToolCalls(textContent);
        if (xmlToolCalls.length > 0) {
          console.log(`[Ollama] Successfully parsed ${xmlToolCalls.length} tool calls from XML format`);
          toolCalls.push(...xmlToolCalls);
        }
      }

      // Yield tool calls at the end if any
      console.log(`[Ollama] Stream complete. Total chunks: ${chunkCount}, Tool calls collected: ${toolCalls.length}`);
      if (toolCalls.length > 0) {
        console.log(`[Ollama] Yielding tool calls:`, toolCalls.map(tc => tc.function.name).join(', '));
        yield {
          type: 'tool_calls',
          tool_calls: toolCalls
        };
      } else {
        console.log(`[Ollama] No tool calls to yield - model may not support tool calling or didn't use tools`);
      }

    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
        throw new Error(
          `Cannot connect to Ollama at ${this.baseUrl}. ` +
          `Make sure Ollama is running with: ollama serve`
        );
      }
      throw error;
    }
  }

  /**
   * Convert unified tools format to Ollama format
   * @param {Array} tools - Tools in unified format
   * @returns {Array}
   */
  convertTools(tools) {
    // First filter to only supported tools
    const filtered = this.filterToolsByCapability(tools);

    console.log(`[Ollama convertTools] Input: ${tools.length} tools, After filtering: ${filtered.length} tools`);
    if (filtered.length > 0) {
      console.log(`[Ollama convertTools] First tool structure:`, JSON.stringify(filtered[0]).substring(0, 200));
    }

    // Ollama uses OpenAI-compatible function calling format
    // Tools may already in OpenAI format (type: 'function', function: {...})
    // or in Anthropic format (name, description, parameters directly)
    const converted = filtered.map(tool => {
      // If already in OpenAI format, return as-is
      if (tool.type === 'function' && tool.function) {
        return tool;
      }
      // Otherwise, convert from Anthropic format
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || tool.input_schema
        }
      };
    });

    if (converted.length > 0) {
      console.log(`[Ollama convertTools] Output: First tool name = ${converted[0]?.function?.name}`);
    }
    return converted;
  }

  /**
   * Prepare request with local model optimizations
   * @param {Object} request - Unified request
   * @returns {Object} Prepared request
   */
  prepareRequest(request) {
    const prepared = super.prepareRequest(request);
    const perfHints = this.getPerformanceHints();

    // Apply conservative token limits for local models
    if (perfHints.conservativeTokens) {
      const maxTokens = perfHints.maxOutputTokens || 2048;
      if (!prepared.maxTokens || prepared.maxTokens > maxTokens) {
        console.log(`[Ollama] Setting maxTokens to ${maxTokens} for local model`);
        prepared.maxTokens = maxTokens;
      }
    }

    // Conservative temperature for better determinism
    if (!prepared.temperature || prepared.temperature > 0.7) {
      prepared.temperature = 0.7;
    }

    return prepared;
  }

  /**
   * Parse tool calls from Ollama response
   * @param {Object} response - Ollama response
   * @returns {Array}
   */
  parseToolCalls(response) {
    if (!response.message?.tool_calls) {
      return [];
    }

    return response.message.tool_calls.map(tc => ({
      id: tc.id || `call_${Date.now()}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments)
      }
    }));
  }

  /**
   * Normalize Ollama response to unified format
   * @param {Object} response - Ollama response
   * @returns {Object}
   */
  normalizeResponse(response) {
    return {
      id: response.id || `ollama_${Date.now()}`,
      model: response.model,
      content: response.message?.content || '',
      role: response.message?.role || 'assistant',
      tool_calls: this.parseToolCalls(response),
      usage: {
        prompt_tokens: response.prompt_eval_count || 0,
        completion_tokens: response.eval_count || 0,
        total_tokens: (response.prompt_eval_count || 0) + (response.eval_count || 0)
      },
      finish_reason: response.done ? 'stop' : null
    };
  }

  /**
   * Parse XML-format tool calls from text content
   * Handles Ollama's custom <tool_call> XML format when /v1 endpoint doesn't translate properly
   * @param {string} text - Text content that may contain <tool_call> XML tags
   * @returns {Array} Array of tool calls in OpenAI format
   */
  _parseXMLToolCalls(text) {
    const toolCalls = [];

    // Match <tool_call>...</tool_call> blocks
    const toolCallRegex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g;
    let match;
    let callIndex = 0;

    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const jsonStr = match[1].trim();
        const parsed = JSON.parse(jsonStr);

        if (parsed.name && parsed.arguments !== undefined) {
          toolCalls.push({
            id: `call_xml_${callIndex}_${Date.now()}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments)
            }
          });
          callIndex++;
        }
      } catch (e) {
        console.warn(`[Ollama] Failed to parse XML tool call:`, match[1], e.message);
      }
    }

    return toolCalls;
  }
}

/**
 * Create an Ollama adapter
 * @param {Object} [config]
 * @param {string} [config.baseUrl] - Ollama base URL
 * @param {string} [config.embeddingModel] - Embedding model
 * @returns {OllamaAdapter}
 */
function createOllamaAdapter(config = {}) {
  return new OllamaAdapter(config);
}

module.exports = { OllamaAdapter, createOllamaAdapter };
