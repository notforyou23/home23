const OpenAI = require('openai');
const { getOpenAIClient } = require('./openai-client');

/**
 * GPT-5.2 Responses API Client Wrapper
 * Uses OpenAI's new Responses API with GPT-5.2 models and tool support
 */
class GPT5Client {
  constructor(logger) {
    this.client = getOpenAIClient();
    this.logger = logger;
  }

  /**
   * Generate response using GPT-5.2 Responses API with STREAMING
   * Proper implementation matching Cosmo's pattern
   */
  async generate(options = {}) {
    const {
      model = 'gpt-5.2',
      instructions = '',
      messages = [],
      input = null,
      max_output_tokens,
      maxOutputTokens,
      maxTokens,
      tools = [],
      toolChoice,
      tool_choice,
      reasoning,
      reasoningEffort,
      verbosity = 'auto',
      parallelToolCalls = true,
      parallel_tool_calls,
      conversationId = null,
      previousResponseId = null,
      include = [],
      systemPrompt = null
    } = options;

    // Build payload in Responses API format
    const payload = {
      model,
      stream: true // Use streaming for GPT-5.2 Responses API
    };

    // NEW: Support both input string (preferred for web search) and messages array
    if (input !== null) {
      // Use direct input (string or structured input)
      payload.input = typeof input === 'string' ? input : input;
    } else if (messages && messages.length > 0) {
      // Convert messages to input format
      payload.input = messages.map(msg => ({
        type: 'message',
        role: msg.role,
        content: typeof msg.content === 'string' 
          ? [{ type: 'input_text', text: msg.content }]
          : msg.content
      }));
    } else {
      throw new Error('Either input or messages must be provided');
    }

    // PURE MODE: Use systemPrompt if provided (overrides instructions)
    if (systemPrompt !== null && systemPrompt !== undefined) {
      // In pure mode, systemPrompt replaces instructions
      payload.instructions = systemPrompt.trim();
    } else if (instructions && instructions.trim().length > 0) {
      payload.instructions = instructions.trim();
    }

    const effectiveMaxTokens = max_output_tokens ?? maxOutputTokens ?? maxTokens ?? 2000;
    if (effectiveMaxTokens) {
      payload.max_output_tokens = effectiveMaxTokens;
    }

    // NEW: Add include parameter for sources
    if (include && include.length > 0) {
      payload.include = include;
    }

    // NOTE: temperature is NOT supported by GPT-5.2 Responses API
    // The model controls its own sampling internally

    // Per OpenAI docs: GPT-5.2 defaults to 'none' reasoning effort
    // Use 'low'/'medium'/'high' for more thinking, 'xhigh' for hardest problems
    // NOTE: Only GPT-5 models support reasoning.effort. GPT-5.2 adds 'none' (default) and 'xhigh'
    const supportsReasoningEffort = model.includes('gpt-5');
    if (reasoning) {
      payload.reasoning = reasoning;
    } else if (supportsReasoningEffort && reasoningEffort && reasoningEffort !== 'none') {
      payload.reasoning = { effort: reasoningEffort };
    }

    if (verbosity && verbosity !== 'auto') {
      payload.text = { verbosity: verbosity };
    }

    if (tools.length > 0) {
      payload.tools = tools;
      const toolChoiceValue = tool_choice ?? toolChoice ?? 'auto';
      const parallelToolCallsValue = parallel_tool_calls ?? parallelToolCalls;
      payload.tool_choice = toolChoiceValue;
      payload.parallel_tool_calls = parallelToolCallsValue;
    }

    if (previousResponseId) {
      payload.previous_response_id = previousResponseId;
    } else if (conversationId) {
      payload.conversation = conversationId;
    }

    // Call streaming API
    try {
      const stream = await this.client.responses.stream(payload);

      let aggregatedText = '';
      let reasoningSummary = '';
      let finalResponse = null;
      let hadError = false;
      let errorType = null;
      let webSearchSources = [];
      let citations = [];

      // Process streaming events
      try {
        for await (const event of stream) {
          switch (event.type) {
            case 'response.created':
              finalResponse = event.response || finalResponse;
              break;

            case 'response.completed':
              finalResponse = event.response;
              if (!aggregatedText || aggregatedText.length === 0) {
                aggregatedText = this.extractTextFromResponse(event.response);
              }
              const extracted = this.extractWebSearchData(event.response);
              webSearchSources = extracted.sources;
              citations = extracted.citations;
              break;

            case 'response.output_text.delta':
              aggregatedText += event.delta || '';
              break;

            case 'response.output_text.done':
              if (event.text) {
                aggregatedText = event.text;
              }
              break;

            case 'response.reasoning_summary_text.delta':
              reasoningSummary += event.delta || '';
              break;

            case 'response.reasoning_summary_text.done':
              if (event.text) {
                reasoningSummary = event.text;
              }
              break;

            case 'response.failed':
            case 'response.cancelled':
            case 'response.incomplete':
              this.logger?.warn?.('Response terminated abnormally', {
                type: event.type,
                error: event.error,
                responseId: event.response?.id,
                hasText: aggregatedText.length > 0
              });
              hadError = true;
              errorType = event.type;
              if (event.response) {
                finalResponse = event.response;
              }
              break;
          }
        }
      } catch (streamError) {
        this.logger?.error?.('Error during stream processing', { 
          error: streamError.message,
          hasPartialText: aggregatedText.length > 0
        });
      }

      // Final fallback: if we still have no text, try extracting from response
      if ((!aggregatedText || aggregatedText.length === 0) && finalResponse) {
        this.logger?.warn?.('Using fallback text extraction', {
          responseId: finalResponse.id
        });
        aggregatedText = this.extractTextFromResponse(finalResponse);
      }

      // CRITICAL FIX: If no text but we have reasoning, USE the reasoning as content
      if ((!aggregatedText || aggregatedText.length === 0) && reasoningSummary && reasoningSummary.length > 0) {
        this.logger?.info?.('Using reasoning as content (response.incomplete workaround)', {
          responseId: finalResponse?.id,
          reasoningLength: reasoningSummary.length
        });
        aggregatedText = reasoningSummary;
        // Clear the reasoning field since we're using it as content
        reasoningSummary = '';
      }

      // If we STILL have no content after all fallbacks, that's a real problem
      if (!aggregatedText || aggregatedText.length === 0) {
        const errorMsg = `No content received from GPT-5.2 (${errorType || 'unknown reason'})`;
        this.logger?.error?.(errorMsg, {
          model,
          hadError,
          errorType,
          responseId: finalResponse?.id,
          hadReasoning: Boolean(reasoningSummary)
        });
        // Return a meaningful error message instead of empty string
        return {
          content: `[Error: ${errorMsg}]`,
          reasoning: reasoningSummary,
          responseId: finalResponse?.id,
          conversationId: finalResponse?.conversation?.id,
          model: finalResponse?.model || model,
          usage: finalResponse?.usage,
          hadError: true,
          errorType
        };
      }

      return {
        content: aggregatedText,
        reasoning: reasoningSummary,
        responseId: finalResponse?.id,
        conversationId: finalResponse?.conversation?.id,
        model: finalResponse?.model || model,
        usage: finalResponse?.usage,
        hadError,
        errorType: hadError ? errorType : null,
        webSearchSources, // NEW: Return web search sources
        citations, // NEW: Return URL citations
        output: finalResponse?.output // CRITICAL: Pass through for code_interpreter file annotations
      };
    } catch (error) {
      this.logger?.error?.('GPT-5.2 API call failed', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  /**
   * Generate with automatic retry on failures
   * Wrapper around generate() with exponential backoff
   */
  async generateWithRetry(options = {}, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.generate(options);
        
        // If got valid content, success!
        if (result.content && result.content.length > 10 && !result.content.includes('[Error:')) {
          if (attempt > 0) {
            this.logger?.info?.('Retry successful', { attempt: attempt + 1 });
          }
          return result;
        }

        // If incomplete or error but we have retries left
        if (result.hadError && attempt < maxRetries - 1) {
          // For response.incomplete, use longer backoff since it might be a rate limit or overload issue
          const baseBackoff = result.errorType === 'response.incomplete' ? 3000 : 1000;
          const backoff = Math.pow(2, attempt) * baseBackoff;
          this.logger?.warn?.(`Response incomplete, retrying after ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`, {
            errorType: result.errorType,
            contentLength: result.content?.length || 0,
            isIncomplete: result.errorType === 'response.incomplete'
          });

          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        
        // Last attempt or got some content
        return result;
        
      } catch (error) {
        lastError = error;

        if (attempt < maxRetries - 1) {
          // For response.incomplete errors, use longer backoff as it might be rate limiting
          const baseBackoff = error.message?.includes('response.incomplete') ? 3000 : 1000;
          const backoff = Math.pow(2, attempt) * baseBackoff;
          this.logger?.warn?.(`API call failed, retrying after ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`, {
            error: error.message,
            isIncomplete: error.message?.includes('response.incomplete')
          });

          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }
    
    // All retries exhausted
    this.logger?.error?.(`All ${maxRetries} retry attempts failed`);
    throw lastError || new Error('GPT-5.2 call failed after all retries');
  }

  /**
   * Extract text content from Responses API output
   * Based on actual Cosmo implementation - handles reasoning and text outputs
   */
  extractTextFromResponse(response) {
    if (!response?.output) {
      this.logger?.warn?.('No response.output');
      return '';
    }

    const textParts = [];
    const reasoningParts = [];
    
    for (const item of response.output) {
      // Handle 'content' type (main text output)
      if (item.type === 'content' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text' && part.text) {
            textParts.push(part.text);
          }
        }
      }
      // Handle 'message' type (alternative format)
      else if (item.type === 'message' && item.content) {
        if (typeof item.content === 'string') {
          textParts.push(item.content);
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.text) textParts.push(part.text);
          }
        }
      }
      // Handle 'reasoning' type separately
      else if (item.type === 'reasoning' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'reasoning_text' && part.text) {
            reasoningParts.push(part.text);
          }
        }
      }
      // Handle 'code_interpreter_call' type (code execution output)
      // CRITICAL: This type appears in responses but wasn't being extracted as text
      // Root cause of "empty text extraction" warnings when response has only code+reasoning
      else if (item.type === 'code_interpreter_call') {
        if (item.output) {
          // item.output can be string or object with text property
          if (typeof item.output === 'string') {
            textParts.push(item.output);
          } else if (item.output.text) {
            textParts.push(item.output.text);
          } else if (typeof item.output === 'object') {
            // Some outputs are structured - convert to readable text
            textParts.push(JSON.stringify(item.output, null, 2));
          }
        }
        // Also capture logs if present
        if (item.logs && Array.isArray(item.logs)) {
          const logText = item.logs.join('\n');
          if (logText.trim()) {
            textParts.push('Execution logs:\n' + logText);
          }
        }
      }
    }

    // If we have text, use it
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
    
    // If no text but we have reasoning, use reasoning directly (don't wrap it)
    // This handles response.incomplete where only reasoning was generated
    if (reasoningParts.length > 0) {
      this.logger?.debug?.('Using reasoning as text (no output_text received)', {
        reasoningLength: reasoningParts.join('\n').length
      });
      return reasoningParts.join('\n');
    }

    // Truly empty
    if (textParts.length === 0 && reasoningParts.length === 0) {
      this.logger?.warn?.('Empty text extraction', {
        outputItems: response.output?.length,
        outputTypes: response.output?.map(o => o.type)
      });
    }

    return '';
  }

  /**
   * Extract reasoning from response (GPT-5.2 feature)
   */
  extractReasoning(response) {
    if (!response?.output) return null;

    for (const item of response.output) {
      if (item.type === 'reasoning' && Array.isArray(item.content)) {
        const reasoningParts = [];
        for (const part of item.content) {
          if (part.type === 'reasoning_text' && part.text) {
            reasoningParts.push(part.text);
          }
        }
        return reasoningParts.join('\n');
      }
    }

    return null;
  }

  /**
   * Extract tool calls from response
   */
  extractToolCalls(response) {
    if (!response?.output) return [];

    const toolCalls = [];

    for (const item of response.output) {
      if (item.type === 'tool_use' || item.type === 'function_call') {
        toolCalls.push({
          id: item.id,
          name: item.name,
          arguments: item.arguments,
          type: item.type
        });
      }
    }

    return toolCalls;
  }

  /**
   * Extract web search sources and citations from response
   * NEW: Based on official OpenAI documentation
   */
  extractWebSearchData(response) {
    const sources = [];
    const citations = [];

    if (!response?.output) {
      return { sources, citations };
    }

    for (const item of response.output) {
      // Extract sources from web_search_call
      if (item.type === 'web_search_call' && item.action?.sources) {
        sources.push(...item.action.sources);
      }

      // Extract citations from message annotations
      if (item.type === 'message' && item.content) {
        for (const contentItem of item.content) {
          if (contentItem.type === 'output_text' && contentItem.annotations) {
            for (const annotation of contentItem.annotations) {
              if (annotation.type === 'url_citation') {
                citations.push({
                  url: annotation.url,
                  title: annotation.title || '',
                  startIndex: annotation.start_index,
                  endIndex: annotation.end_index
                });
              }
            }
          }
        }
      }
    }

    return { sources, citations };
  }

  /**
   * Generate with web search tool enabled
   * FIXED: Use proper Responses API format with input string
   */
  async generateWithWebSearch(options = {}) {
    // Build the input string from instructions and query
    const { instructions = '', messages = [], query = '' } = options;
    
    // Create a simple input string for web search (much more reliable than messages)
    let inputString = query || (messages.length > 0 ? messages[0].content : '');
    
    // Prepend instructions if provided
    if (instructions && instructions.trim().length > 0) {
      inputString = `${instructions.trim()}\n\nQuery: ${inputString}`;
    }

    return this.generateWithRetry({
      ...options,
      input: inputString, // Use input string instead of messages array
      messages: undefined, // Clear messages to avoid conflicts
      tools: [
        { type: 'web_search' },
        ...(options.tools || [])
      ],
      reasoningEffort: 'low', // Efficient default - container operations benefit from speed
      max_output_tokens: options.max_output_tokens || options.maxOutputTokens || options.maxTokens || 4000,
      include: ['web_search_call.action.sources']
    }, 3);
  }

  /**
   * Generate with extended reasoning (GPT-5.2 deep thinking) WITH RETRY
   */
  async generateWithReasoning(options = {}) {
    return this.generateWithRetry({
      ...options,
      reasoningEffort: 'medium', // Reduced from 'high' to prevent incomplete responses
      verbosity: 'medium',
      max_output_tokens: options.max_output_tokens || options.maxOutputTokens || options.maxTokens || 6000
    }, 3);
  }

  /**
   * Fast generation with GPT-5-mini
   */
  async generateFast(options = {}) {
    return this.generateWithRetry({
      ...options,
      model: options.model || 'gpt-5-mini', // Use mini by default, nano is broken
      reasoningEffort: 'low',
      max_output_tokens: options.max_output_tokens || options.maxOutputTokens || options.maxTokens || 1000
    }, 3);
  }

  /**
   * ============================================================================
   * CONTAINER MANAGEMENT - For Code Execution Agent
   * ============================================================================
   */

  /**
   * Create a new container for code execution
   * @returns {string} Container ID
   */
  async createContainer() {
    try {
      this.logger?.info?.('Creating code execution container...');
      const containerName = `code-exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const container = await this.client.containers.create({
        name: containerName
      });
      this.logger?.info?.('Container created', { containerId: container.id, name: containerName });
      return container.id;
    } catch (error) {
      this.logger?.error?.('Failed to create container', { error: error.message });
      throw error;
    }
  }

  /**
   * Upload file to container
   * @param {string} containerId - Container ID
   * @param {Buffer|ReadStream} file - File data
   * @param {string} filename - Filename
   * @returns {Object} File upload response
   */
  async uploadFileToContainer(containerId, file, filename) {
    try {
      this.logger?.debug?.('Uploading file to container', { containerId, filename });
      const fileForUpload = file instanceof File ? file : await OpenAI.toFile(file, filename || 'container_file');
      const result = await this.client.containers.files.create(containerId, {
        file: fileForUpload
      });
      this.logger?.debug?.('File uploaded successfully', { containerId, filename });
      return result;
    } catch (error) {
      this.logger?.error?.('Failed to upload file to container', { 
        containerId, 
        filename, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * List files in container
   * Container files must use the container-specific endpoint
   * @param {string} containerId - Container ID
   * @returns {Array} List of files with {id, filename, ...}
   */
  async listContainerFiles(containerId, options = {}) {
    try {
      this.logger?.debug?.('Listing container files', { containerId });

      const files = [];
      const iterator = this.client.containers.files.list(containerId, options);

      for await (const file of iterator) {
        files.push(file);
      }

      this.logger?.debug?.('Container files listed', {
        containerId,
        count: files.length
      });

      return files;
    } catch (error) {
      this.logger?.error?.('Failed to list container files', {
        containerId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Download file from container
   * Container files (cfile_...) must use the container endpoint, not the Files API
   * @param {string} containerId - Container ID
   * @param {string} fileId - File ID from code interpreter response (cfile_...)
   * @returns {Buffer} File content as buffer
   */
  async downloadFileFromContainer(containerId, fileId) {
    try {
      this.logger?.debug?.('Downloading file from container', { containerId, fileId });

      const response = await this.client.containers.files.content.retrieve(fileId, {
        container_id: containerId
      });

      const contentLengthHeader = response.headers?.get?.('content-length');
      const expectedSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

      const arrayBuffer = await response.arrayBuffer();
      const fileContent = Buffer.from(arrayBuffer);

      if (expectedSize !== null && fileContent.length !== expectedSize) {
        const sizeMismatch = {
          fileId,
          expected: expectedSize,
          received: fileContent.length,
          truncated: fileContent.length < expectedSize,
          missingBytes: expectedSize - fileContent.length
        };
        
        this.logger?.error('File download size mismatch - file is incomplete', sizeMismatch);
        
        // Fail instead of returning corrupt data
        throw new Error(
          `File download incomplete: expected ${expectedSize} bytes, received ${fileContent.length} bytes ` +
          `(missing ${sizeMismatch.missingBytes} bytes). File ID: ${fileId}`
        );
      }

      this.logger?.debug?.('File downloaded successfully', {
        containerId,
        fileId,
        size: fileContent.length,
        expectedSize: expectedSize || 'unknown'
      });
      return fileContent;
    } catch (error) {
      this.logger?.error?.('Failed to download file from container', { 
        containerId, 
        fileId,
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Execute code in container using code_interpreter tool
   * @param {Object} options - Execution options
   * @returns {Object} Execution results
   */
  async executeInContainer(options = {}) {
    const {
      containerId,
      input = null,
      instructions = '',
      code = '',
      messages = [],
      files = [],
      max_output_tokens,
      maxOutputTokens,
      maxTokens,
      reasoning,
      reasoningEffort,
      tools = [],
      tool_choice,
      parallel_tool_calls,
      retryCount = 3,
      ...rest
    } = options;

    if (!containerId) {
      throw new Error('containerId is required for executeInContainer');
    }

    try {
      for (const file of files) {
        await this.uploadFileToContainer(containerId, file.data, file.name);
      }

      const promptSegments = [];
      if (instructions && instructions.trim().length > 0) {
        promptSegments.push(instructions.trim());
      }
      if (code && code.trim().length > 0) {
        promptSegments.push(`Code to execute:\n\`\`\`python\n${code.trim()}\n\`\`\``);
      }

      const finalInput = input !== null && input !== undefined
        ? input
        : (promptSegments.length > 0 ? promptSegments.join('\n\n') : null);

      const requestPayload = {
        ...rest,
        tools: [
          { type: 'code_interpreter', container: containerId },
          ...tools
        ]
      };

      const includeEntries = Array.isArray(requestPayload.include)
        ? [...requestPayload.include]
        : [];
      if (!includeEntries.includes('code_interpreter_call.outputs')) {
        includeEntries.push('code_interpreter_call.outputs');
      }
      requestPayload.include = includeEntries;

      if (tool_choice !== undefined) {
        requestPayload.tool_choice = tool_choice;
      }

      if (parallel_tool_calls !== undefined) {
        requestPayload.parallel_tool_calls = parallel_tool_calls;
      }

      const effectiveMaxTokens = max_output_tokens ?? maxOutputTokens ?? maxTokens;
      if (effectiveMaxTokens) {
        requestPayload.max_output_tokens = effectiveMaxTokens;
      }

      const reasoningConfig = reasoning ?? (reasoningEffort ? { effort: reasoningEffort } : undefined);
      if (reasoningConfig) {
        requestPayload.reasoning = reasoningConfig;
      }

      if (finalInput !== null && finalInput !== undefined) {
        requestPayload.input = finalInput;
        requestPayload.messages = undefined;
      } else if (messages && messages.length > 0) {
        requestPayload.messages = messages;
      } else {
        throw new Error('executeInContainer requires either input or messages to be provided');
      }

      const response = await this.generateWithRetry(requestPayload, retryCount);

      if (response.output) {
        const codeResults = this.extractCodeInterpreterResults(response);
        response.codeResults = codeResults;
      }

      return response;
    } catch (error) {
      this.logger?.error?.('Code execution in container failed', {
        containerId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Extract code interpreter results from response
   * Files are referenced in annotations as container_file_citation
   * @param {Object} response - API response
   * @returns {Array} Code execution results
   */
  extractCodeInterpreterResults(response) {
    const results = [];

    if (!response?.output) {
      return results;
    }

    for (const item of response.output) {
      // Extract code interpreter outputs
      if (item.type === 'code_interpreter_call' && item.output) {
        const files = [];
        
        // Method 1: Direct files array (if present)
        if (item.files && item.files.length > 0) {
          files.push(...item.files);
        }
        
        // Method 2: Parse annotations for container_file_citation (primary method)
        // Files generated in containers appear as annotations in the output text
        if (item.output.annotations && Array.isArray(item.output.annotations)) {
          for (const annotation of item.output.annotations) {
            if (annotation.type === 'container_file_citation' && annotation.file_id) {
              files.push({
                file_id: annotation.file_id,
                filename: annotation.filename || `file_${annotation.file_id.substring(6, 14)}.bin`
              });
            }
          }
        }
        
        results.push({
          type: 'code_output',
          output: item.output,
          logs: item.logs || [],
          files: files
        });
      }
    }

    return results;
  }

  /**
   * Delete container and cleanup resources
   * @param {string} containerId - Container ID
   */
  async deleteContainer(containerId) {
    try {
      this.logger?.info?.('Deleting container', { containerId });
      await this.client.containers.delete(containerId);
      this.logger?.info?.('Container deleted successfully', { containerId });
    } catch (error) {
      // Log but don't throw - cleanup should be best-effort
      this.logger?.warn?.('Failed to delete container (non-fatal)', { 
        containerId, 
        error: error.message 
      });
    }
  }

  /**
   * Generate with code interpreter tool enabled (convenience method)
   * Similar to generateWithWebSearch but for code execution
   */
  async generateWithCodeInterpreter(options = {}) {
    const { instructions = '', messages = [], query = '' } = options;
    
    // Create a simple input string
    let inputString = query || (messages.length > 0 ? messages[0].content : '');
    
    // Prepend instructions if provided
    if (instructions && instructions.trim().length > 0) {
      inputString = `${instructions.trim()}\n\n${inputString}`;
    }

    return this.generateWithRetry({
      ...options,
      input: inputString,
      messages: undefined,
      tools: [
        { type: 'code_interpreter' },
        ...(options.tools || [])
      ],
      reasoningEffort: options.reasoningEffort || 'medium',
      maxTokens: options.maxTokens || 6000
      // Note: code_interpreter results appear in response.output automatically
    }, 3);
  }
}

module.exports = { GPT5Client };


