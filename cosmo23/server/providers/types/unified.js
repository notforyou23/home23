/**
 * Unified Types for Model-Agnostic Provider Abstraction
 *
 * Defines common request/response formats that work across all AI providers.
 * Uses JSON Schema for tool definitions (native to Anthropic, convertible for others).
 */

/**
 * @typedef {Object} UnifiedMessage
 * @property {'user'|'assistant'|'system'|'tool'} role - Message role
 * @property {string|ContentBlock[]} content - Message content
 * @property {UnifiedToolCall[]} [toolCalls] - Tool calls made by assistant
 * @property {UnifiedToolResult[]} [toolResults] - Results from tool execution
 */

/**
 * @typedef {Object} ContentBlock
 * @property {'text'|'image'|'tool_use'|'tool_result'|'thinking'} type
 * @property {string} [text] - For text blocks
 * @property {string} [source] - For image blocks (base64 or URL)
 * @property {string} [mediaType] - For image blocks (e.g., 'image/png')
 * @property {string} [id] - For tool_use blocks
 * @property {string} [name] - For tool_use blocks
 * @property {Object} [input] - For tool_use blocks
 * @property {string} [toolUseId] - For tool_result blocks
 * @property {string} [content] - For tool_result blocks
 * @property {boolean} [isError] - For tool_result blocks
 * @property {string} [thinking] - For thinking blocks
 */

/**
 * @typedef {Object} UnifiedTool
 * @property {string} name - Tool name (alphanumeric + underscore)
 * @property {string} description - What the tool does
 * @property {Object} input_schema - JSON Schema for input parameters
 */

/**
 * @typedef {Object} UnifiedToolCall
 * @property {string} id - Unique identifier for this tool call
 * @property {string} name - Tool name being called
 * @property {Object} arguments - Arguments passed to the tool
 */

/**
 * @typedef {Object} UnifiedToolResult
 * @property {string} toolUseId - ID of the tool call this is responding to
 * @property {string} content - Result content (JSON stringified)
 * @property {boolean} [isError] - Whether this is an error result
 */

/**
 * @typedef {Object} UnifiedRequest
 * @property {UnifiedMessage[]} messages - Conversation messages
 * @property {UnifiedTool[]} [tools] - Available tools
 * @property {string} model - Model identifier (e.g., 'claude-sonnet-4-20250514')
 * @property {number} [maxTokens] - Maximum output tokens
 * @property {number} [temperature] - Sampling temperature (0-1)
 * @property {string} [systemPrompt] - System prompt
 * @property {'off'|'low'|'medium'|'high'} [thinking] - Extended thinking mode
 * @property {string[]} [stopSequences] - Stop sequences
 * @property {number} [contextWindow] - Context window size hint
 */

/**
 * @typedef {Object} UnifiedResponse
 * @property {string} id - Response identifier
 * @property {string} model - Model that generated the response
 * @property {'assistant'} role - Always 'assistant'
 * @property {string} content - Text content of the response
 * @property {UnifiedToolCall[]} [toolCalls] - Tool calls made
 * @property {'end_turn'|'max_tokens'|'tool_use'|'stop_sequence'} stopReason - Why generation stopped
 * @property {UsageStats} usage - Token usage statistics
 * @property {string} [thinkingContent] - Extended thinking content (if enabled)
 * @property {ContentBlock[]} [rawContent] - Raw content blocks from provider
 */

/**
 * @typedef {Object} UsageStats
 * @property {number} inputTokens - Tokens in the request
 * @property {number} outputTokens - Tokens in the response
 * @property {number} [cacheCreationInputTokens] - Tokens written to cache
 * @property {number} [cacheReadInputTokens] - Tokens read from cache
 */

/**
 * @typedef {Object} UnifiedChunk
 * @property {'text'|'tool_use_start'|'tool_use_delta'|'tool_use_end'|'thinking'|'done'} type
 * @property {string} [text] - Text delta
 * @property {string} [toolId] - Tool call ID
 * @property {string} [toolName] - Tool name
 * @property {string} [argumentsDelta] - Partial arguments JSON
 * @property {string} [thinking] - Thinking delta
 * @property {UnifiedResponse} [response] - Final response (on 'done')
 */

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} tools - Supports tool/function calling
 * @property {boolean} vision - Supports image input
 * @property {boolean} thinking - Supports extended thinking
 * @property {boolean} streaming - Supports streaming responses
 * @property {boolean} caching - Supports prompt caching
 * @property {number} maxOutputTokens - Maximum output tokens
 * @property {number} contextWindow - Context window size
 */

/**
 * @typedef {Object} ProviderError
 * @property {string} type - Error type (rate_limit, billing, auth, server, unknown)
 * @property {string} message - Error message
 * @property {boolean} retryable - Whether the error is retryable
 * @property {number} [retryAfter] - Suggested retry delay in ms
 * @property {Error} [originalError] - Original error object
 */

/**
 * Error type constants
 */
const ErrorTypes = {
  RATE_LIMIT: 'rate_limit',
  BILLING: 'billing',
  AUTH: 'auth',
  SERVER: 'server',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown'
};

/**
 * Stop reason constants
 */
const StopReasons = {
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  TOOL_USE: 'tool_use',
  STOP_SEQUENCE: 'stop_sequence'
};

/**
 * Thinking level constants
 */
const ThinkingLevels = {
  OFF: 'off',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
};

/**
 * Create a unified request with defaults
 * @param {Partial<UnifiedRequest>} options
 * @returns {UnifiedRequest}
 */
function createRequest(options) {
  return {
    messages: options.messages || [],
    model: options.model || 'claude-sonnet-4-20250514',
    maxTokens: options.maxTokens || 8192,
    temperature: options.temperature ?? 0.7,
    systemPrompt: options.systemPrompt || '',
    tools: options.tools || [],
    thinking: options.thinking || ThinkingLevels.OFF,
    stopSequences: options.stopSequences || [],
    contextWindow: options.contextWindow
  };
}

/**
 * Create a unified response
 * @param {Object} options
 * @returns {UnifiedResponse}
 */
function createResponse(options) {
  return {
    id: options.id || `resp_${Date.now()}`,
    model: options.model || 'unknown',
    role: 'assistant',
    content: options.content || '',
    toolCalls: options.toolCalls || [],
    stopReason: options.stopReason || StopReasons.END_TURN,
    usage: options.usage || { inputTokens: 0, outputTokens: 0 },
    thinkingContent: options.thinkingContent,
    rawContent: options.rawContent
  };
}

/**
 * Create a unified tool definition
 * @param {Object} options
 * @returns {UnifiedTool}
 */
function createTool(options) {
  return {
    name: options.name,
    description: options.description || '',
    input_schema: options.input_schema || { type: 'object', properties: {} }
  };
}

/**
 * Create a provider error
 * @param {Object} options
 * @returns {ProviderError}
 */
function createError(options) {
  return {
    type: options.type || ErrorTypes.UNKNOWN,
    message: options.message || 'Unknown error',
    retryable: options.retryable ?? false,
    retryAfter: options.retryAfter,
    originalError: options.originalError
  };
}

/**
 * Check if content contains tool calls
 * @param {ContentBlock[]} content
 * @returns {boolean}
 */
function hasToolCalls(content) {
  if (!Array.isArray(content)) return false;
  return content.some(block => block.type === 'tool_use');
}

/**
 * Extract text from content blocks
 * @param {string|ContentBlock[]} content
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('');
}

/**
 * Extract tool calls from content blocks
 * @param {ContentBlock[]} content
 * @returns {UnifiedToolCall[]}
 */
function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];

  return content
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      id: block.id,
      name: block.name,
      arguments: block.input || {}
    }));
}

module.exports = {
  ErrorTypes,
  StopReasons,
  ThinkingLevels,
  createRequest,
  createResponse,
  createTool,
  createError,
  hasToolCalls,
  extractText,
  extractToolCalls
};
