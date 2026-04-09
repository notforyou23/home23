/**
 * Base Provider Adapter
 *
 * Abstract base class that defines the interface all provider adapters must implement.
 * Provides common utilities for error handling and response normalization.
 */

const { ErrorTypes, createError } = require('../types/unified.js');

/**
 * @typedef {import('../types/unified.js').UnifiedRequest} UnifiedRequest
 * @typedef {import('../types/unified.js').UnifiedResponse} UnifiedResponse
 * @typedef {import('../types/unified.js').UnifiedChunk} UnifiedChunk
 * @typedef {import('../types/unified.js').UnifiedTool} UnifiedTool
 * @typedef {import('../types/unified.js').UnifiedToolCall} UnifiedToolCall
 * @typedef {import('../types/unified.js').ProviderCapabilities} ProviderCapabilities
 * @typedef {import('../types/unified.js').ProviderError} ProviderError
 */

class ProviderAdapter {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - API key for the provider
   * @param {string} [config.baseUrl] - Optional base URL override
   * @param {Object} [config.options] - Additional provider-specific options
   */
  constructor(config = {}) {
    if (this.constructor === ProviderAdapter) {
      throw new Error('ProviderAdapter is abstract and cannot be instantiated directly');
    }

    this.config = config;
    this._client = null;
  }

  /**
   * Provider identifier (e.g., 'anthropic', 'openai')
   * @type {string}
   */
  get id() {
    throw new Error('Subclass must implement id getter');
  }

  /**
   * Human-readable provider name
   * @type {string}
   */
  get name() {
    throw new Error('Subclass must implement name getter');
  }

  /**
   * Provider capabilities
   * @type {ProviderCapabilities}
   */
  get capabilities() {
    throw new Error('Subclass must implement capabilities getter');
  }

  /**
   * Available models for this provider
   * @returns {string[]}
   */
  getAvailableModels() {
    throw new Error('Subclass must implement getAvailableModels');
  }

  async listModels() {
    return this.getAvailableModels();
  }

  /**
   * Check if a model is supported by this provider
   * @param {string} model
   * @returns {boolean}
   */
  supportsModel(model) {
    return this.getAvailableModels().some(m =>
      m === model || model.includes(m) || m.includes(model)
    );
  }

  /**
   * Initialize the underlying SDK client
   * Called lazily on first use
   * @protected
   */
  _initClient() {
    throw new Error('Subclass must implement _initClient');
  }

  /**
   * Get or create the SDK client
   * @protected
   * @returns {Object}
   */
  _getClient() {
    if (!this._client) {
      this._initClient();
    }
    return this._client;
  }

  /**
   * Create a message (non-streaming)
   * @param {UnifiedRequest} request
   * @returns {Promise<UnifiedResponse>}
   */
  async createMessage(request) {
    throw new Error('Subclass must implement createMessage');
  }

  /**
   * Stream a message response
   * @param {UnifiedRequest} request
   * @returns {AsyncGenerator<UnifiedChunk>}
   */
  async *streamMessage(request) {
    throw new Error('Subclass must implement streamMessage');
  }

  /**
   * Convert unified tools to provider-specific format
   * @param {UnifiedTool[]} tools
   * @returns {any[]} Provider-specific tool format
   */
  convertTools(tools) {
    throw new Error('Subclass must implement convertTools');
  }

  /**
   * Parse provider response into unified tool calls
   * @param {any} response - Provider-specific response
   * @returns {UnifiedToolCall[]}
   */
  parseToolCalls(response) {
    throw new Error('Subclass must implement parseToolCalls');
  }

  /**
   * Normalize provider response to unified format
   * @param {any} response - Provider-specific response
   * @returns {UnifiedResponse}
   */
  normalizeResponse(response) {
    throw new Error('Subclass must implement normalizeResponse');
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error
   * @returns {boolean}
   */
  isRateLimitError(error) {
    return false;
  }

  /**
   * Check if error is a billing/quota error
   * @param {Error} error
   * @returns {boolean}
   */
  isBillingError(error) {
    return false;
  }

  /**
   * Check if error is an authentication error
   * @param {Error} error
   * @returns {boolean}
   */
  isAuthError(error) {
    return false;
  }

  /**
   * Check if error is a server error (5xx)
   * @param {Error} error
   * @returns {boolean}
   */
  isServerError(error) {
    return false;
  }

  /**
   * Check if the error is retryable
   * @param {Error} error
   * @returns {boolean}
   */
  shouldRetry(error) {
    return this.isRateLimitError(error) || this.isServerError(error);
  }

  /**
   * Get suggested retry delay for an error
   * @param {Error} error
   * @returns {number} Delay in milliseconds
   */
  getRetryDelay(error) {
    // Check for Retry-After header
    if (error.headers?.['retry-after']) {
      const retryAfter = parseInt(error.headers['retry-after']);
      if (!isNaN(retryAfter)) {
        return retryAfter * 1000;
      }
    }

    // Default delays based on error type
    if (this.isRateLimitError(error)) {
      return 60000; // 1 minute for rate limits
    }
    if (this.isServerError(error)) {
      return 5000; // 5 seconds for server errors
    }

    return 1000; // 1 second default
  }

  /**
   * Classify an error into a unified error type
   * @param {Error} error
   * @returns {ProviderError}
   */
  classifyError(error) {
    if (this.isRateLimitError(error)) {
      return createError({
        type: ErrorTypes.RATE_LIMIT,
        message: error.message,
        retryable: true,
        retryAfter: this.getRetryDelay(error),
        originalError: error
      });
    }

    if (this.isBillingError(error)) {
      return createError({
        type: ErrorTypes.BILLING,
        message: error.message,
        retryable: false,
        originalError: error
      });
    }

    if (this.isAuthError(error)) {
      return createError({
        type: ErrorTypes.AUTH,
        message: error.message,
        retryable: false,
        originalError: error
      });
    }

    if (this.isServerError(error)) {
      return createError({
        type: ErrorTypes.SERVER,
        message: error.message,
        retryable: true,
        retryAfter: this.getRetryDelay(error),
        originalError: error
      });
    }

    return createError({
      type: ErrorTypes.UNKNOWN,
      message: error.message,
      retryable: false,
      originalError: error
    });
  }

  /**
   * Validate a request before sending
   * @param {UnifiedRequest} request
   * @throws {Error} If request is invalid
   */
  validateRequest(request) {
    if (!request.messages || request.messages.length === 0) {
      throw new Error('Request must contain at least one message');
    }

    if (!request.model) {
      throw new Error('Request must specify a model');
    }

    if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 1)) {
      throw new Error('Temperature must be between 0 and 1');
    }

    if (request.maxTokens !== undefined && request.maxTokens < 1) {
      throw new Error('maxTokens must be positive');
    }

    // Check capability requirements
    if (request.tools?.length > 0 && !this.capabilities.tools) {
      throw new Error(`Provider ${this.id} does not support tools`);
    }

    if (request.thinking && request.thinking !== 'off' && !this.capabilities.thinking) {
      throw new Error(`Provider ${this.id} does not support extended thinking`);
    }

    // Check for vision content
    const hasVision = request.messages.some(msg => {
      if (Array.isArray(msg.content)) {
        return msg.content.some(block => block.type === 'image');
      }
      return false;
    });

    if (hasVision && !this.capabilities.vision) {
      throw new Error(`Provider ${this.id} does not support vision`);
    }
  }

  /**
   * Strip unsupported features from request (graceful degradation)
   * @param {UnifiedRequest} request
   * @returns {UnifiedRequest}
   */
  prepareRequest(request) {
    const prepared = { ...request };

    // Remove tools if not supported
    if (!this.capabilities.tools && prepared.tools?.length > 0) {
      console.warn(`[${this.id}] Tools not supported, removing from request`);
      prepared.tools = [];
    }

    // Disable thinking if not supported
    if (!this.capabilities.thinking && prepared.thinking && prepared.thinking !== 'off') {
      console.warn(`[${this.id}] Extended thinking not supported, disabling`);
      prepared.thinking = 'off';
    }

    // Strip images if vision not supported
    if (!this.capabilities.vision) {
      prepared.messages = prepared.messages.map(msg => {
        if (Array.isArray(msg.content)) {
          const filtered = msg.content.filter(block => block.type !== 'image');
          if (filtered.length !== msg.content.length) {
            console.warn(`[${this.id}] Vision not supported, removing images from message`);
          }
          return { ...msg, content: filtered };
        }
        return msg;
      });
    }

    return prepared;
  }

  /**
   * Test the connection with a minimal request
   * @returns {Promise<{success: boolean, latency: number, error?: string}>}
   */
  async testConnection() {
    const start = Date.now();
    try {
      await this.createMessage({
        model: this.getAvailableModels()[0],
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10
      });
      return {
        success: true,
        latency: Date.now() - start
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
   * Get health status of the provider
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    const connectionTest = await this.testConnection();
    return {
      provider: this.id,
      name: this.name,
      healthy: connectionTest.success,
      latency: connectionTest.latency,
      error: connectionTest.error,
      capabilities: this.capabilities,
      timestamp: Date.now()
    };
  }

  /**
   * Filter tools based on provider capabilities
   * @param {UnifiedTool[]} tools
   * @returns {UnifiedTool[]} Filtered tools
   */
  filterToolsByCapability(tools) {
    try {
      const config = require('../../config/model-config.js');
      const allowedTools = config.toolCompatibility[this.id] || ['*'];

      // If wildcard, allow all
      if (allowedTools.includes('*')) {
        return tools;
      }

      // Filter to allowed tools only
      return tools.filter(tool => {
        const toolName = tool.function?.name || tool.name;
        const isAllowed = allowedTools.includes(toolName);

        if (!isAllowed) {
          console.log(`[${this.id}] Skipping unsupported tool: ${toolName}`);
        }

        return isAllowed;
      });
    } catch (e) {
      // Config doesn't exist - allow all tools
      return tools;
    }
  }

  /**
   * Get performance hints for this provider
   * @returns {Object} Performance configuration
   */
  getPerformanceHints() {
    try {
      const config = require('../../config/model-config.js');
      return config.performanceProfiles[this.id] || {
        maxConcurrentTools: 10,
        maxToolsPerIteration: 15,
        pollingInterval: 500,
        reducedParallelism: false,
        conservativeTokens: false,
        maxOutputTokens: 4096
      };
    } catch (e) {
      // Config doesn't exist - use cloud defaults
      return {
        maxConcurrentTools: 10,
        maxToolsPerIteration: 15,
        pollingInterval: 500,
        reducedParallelism: false,
        conservativeTokens: false,
        maxOutputTokens: 4096
      };
    }
  }
}

module.exports = { ProviderAdapter };
