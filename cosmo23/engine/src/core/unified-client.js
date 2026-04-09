const { GPT5Client } = require('./gpt5-client');
const { MCPClient } = require('./mcp-client');
const { ChatCompletionsClient } = require('./chat-completions-client');
const AnthropicClient = require('./anthropic-client');
const OpenAI = require('openai');
const { wrapSystemPrompt } = require('./provider-prompts');

/**
 * UnifiedClient - Extends GPT5Client with multi-provider and MCP support
 * 
 * CRITICAL DESIGN PRINCIPLES:
 * 1. Default behavior = exactly GPT5Client (zero breaking changes)
 * 2. Only routes to alternatives if modelAssignments configured
 * 3. All GPT5Client methods inherited and working
 * 4. Config-driven routing - no hard-coded logic
 * 5. Safe fallback to GPT-5.2 on any error
 * 6. MCP tools available when configured
 * 
 * Usage:
 * - new UnifiedClient(null, logger) -> behaves exactly like GPT5Client
 * - new UnifiedClient(config, logger) with no modelAssignments -> uses GPT-5
 * - new UnifiedClient(config, logger) with modelAssignments -> routes per config
 * - new UnifiedClient(config, logger) with MCP servers -> MCP tools available
 */
class UnifiedClient extends GPT5Client {
  constructor(config, logger) {
    // Call parent constructor (GPT5Client)
    super(logger);
    
    // Store config (can be null for backward compatibility)
    this.config = config || {};
    
    // Initialize additional providers ONLY if explicitly enabled in config
    this.xai = null;
    this.anthropicClient = null;  // Use AnthropicClient adapter (OAuth-aware)
    this.localClient = null; // For local LLM support via Chat Completions API
    this.ollamaCloudClient = null; // For Ollama Cloud (ollama.com/v1)
    this.codexClient = null; // OpenAI Codex (ChatGPT OAuth) — separate SDK instance
    this._codexConfig = this.config.providers?.['openai-codex'] || null;
    this._codexLastToken = null; // Track token for refresh detection
    this.mcpClients = new Map(); // MCP server label -> MCPClient instance

    // Only initialize if provider is enabled in config
    if (this.config.providers?.xai?.enabled) {
      const apiKey = process.env.XAI_API_KEY || this.config.providers.xai.apiKey;
      if (apiKey) {
        this.xai = new OpenAI({
          apiKey: apiKey,
          baseURL: 'https://api.x.ai/v1'
        });
        this.logger?.info('✅ xAI Grok provider initialized');
      } else {
        this.logger?.warn('xAI enabled in config but no API key found (XAI_API_KEY)');
      }
    }

    // Initialize Anthropic provider with OAuth support
    if (this.config.providers?.anthropic?.enabled || process.env.LLM_BACKEND === 'anthropic') {
      const anthropicConfig = this.config.providers?.anthropic || {};
      this.anthropicClient = new AnthropicClient({
        modelMapping: anthropicConfig.modelMapping,
        useExtendedThinking: anthropicConfig.useExtendedThinking !== false,
        defaultMaxTokens: anthropicConfig.defaultMaxTokens || 8000,
        temperature: anthropicConfig.temperature || 0.1,
        ...anthropicConfig
      }, this.logger);
      this.logger?.info('✅ Anthropic Claude provider initialized (OAuth-aware)');
    }

    // Initialize local LLM client if enabled
    // Supports Ollama, vLLM, llama.cpp, LocalAI, etc.
    if (this.config.providers?.local?.enabled || process.env.LLM_BACKEND === 'local') {
      const localConfig = this.config.providers?.local || {};
      this.localClient = new ChatCompletionsClient({
        baseURL: localConfig.baseURL || process.env.LOCAL_LLM_BASE_URL,
        apiKey: localConfig.apiKey || process.env.LOCAL_LLM_API_KEY,
        modelMapping: localConfig.modelMapping,
        defaultModel: localConfig.defaultModel,
        supportsTools: localConfig.supportsTools,
        supportsStreaming: localConfig.supportsStreaming,
        searxngUrl: localConfig.searxngUrl || process.env.SEARXNG_URL
      }, this.logger);
      this.logger?.info('✅ Local LLM provider initialized (Chat Completions API)');
    }

    // Initialize Ollama Cloud client (ollama.com/v1 — OpenAI-compatible)
    if (this.config.providers?.['ollama-cloud']?.enabled) {
      const cloudConfig = this.config.providers['ollama-cloud'];
      this.ollamaCloudClient = new ChatCompletionsClient({
        baseURL: cloudConfig.baseURL || 'https://ollama.com/v1',
        apiKey: cloudConfig.apiKey || process.env.OLLAMA_CLOUD_API_KEY || 'ollama',
        defaultModel: cloudConfig.defaultModel || 'nemotron-3-super',
        modelMapping: {},  // No mapping — cloud models use their own names
        supportsTools: cloudConfig.supportsTools !== false,
        supportsStreaming: cloudConfig.supportsStreaming !== false
      }, this.logger);
      this.logger?.info('✅ Ollama Cloud provider initialized (ollama.com/v1)');
    }

    // Initialize MCP clients if configured
    if (this.config.mcp?.client?.enabled) {
      this.initializeMCPClients();
    }
  }

  /**
   * Initialize MCP clients from config
   */
  initializeMCPClients() {
    const servers = this.config.mcp?.client?.servers || [];
    
    for (const serverConfig of servers) {
      if (!serverConfig.enabled) {
        continue;
      }
      
      try {
        // Pass runtimeRoot to MCP client for proper path resolution
        const configWithRuntime = {
          ...serverConfig,
          runtimeRoot: this.config.runtimeRoot || this.config.logsDir
        };
        const client = new MCPClient(configWithRuntime, this.logger);
        this.mcpClients.set(serverConfig.label, client);
        this.logger?.info('✅ MCP client initialized', {
          label: serverConfig.label,
          url: serverConfig.url
        });
      } catch (error) {
        this.logger?.error('Failed to initialize MCP client', {
          label: serverConfig.label,
          error: error.message
        });
      }
    }
    
    if (this.mcpClients.size > 0) {
      this.logger?.info(`✅ ${this.mcpClients.size} MCP server(s) available`);
    }
  }

  /**
   * Get available MCP tools from all configured servers
   */
  async getMCPTools() {
    const allTools = [];
    
    for (const [label, client] of this.mcpClients) {
      try {
        const tools = await client.listTools();
        allTools.push(...tools.map(t => ({
          ...t,
          _mcpServer: label
        })));
      } catch (error) {
        this.logger?.warn('Failed to list tools from MCP server', {
          server: label,
          error: error.message
        });
      }
    }
    
    return allTools;
  }

  /**
   * Get MCP servers in GPT-5.2 Responses API tool format
   * Per OpenAI docs: Pass MCP servers as tools directly to GPT-5
   * Then GPT-5.2 automatically calls tools when needed
   * 
   * @returns {Array} Array of MCP tool definitions for GPT-5
   */
  getMCPServersAsTools() {
    const mcpTools = [];
    
    if (!this.config.mcp?.client?.enabled) {
      return mcpTools;
    }
    
    const servers = this.config.mcp.client.servers || [];
    
    for (const server of servers) {
      if (!server.enabled) continue;
      
      // Build MCP tool in GPT-5.2 Responses API format
      const mcpTool = {
        type: 'mcp',
        server_label: server.label,
        server_url: server.url,
        require_approval: server.requireApproval || 'never'
      };
      
      // Add allowed_tools if specified
      if (server.allowedTools && server.allowedTools.length > 0) {
        mcpTool.allowed_tools = server.allowedTools;
      }
      
      // Add authorization if specified
      if (server.auth) {
        mcpTool.authorization = server.auth;
      }
      
      // Add description if specified
      if (server.description) {
        mcpTool.server_description = server.description;
      }
      
      mcpTools.push(mcpTool);
    }
    
    return mcpTools;
  }

  /**
   * Call an MCP tool
   * @param {string} serverLabel - MCP server label
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   */
  async callMCPTool(serverLabel, toolName, args = {}) {
    const client = this.mcpClients.get(serverLabel);
    
    if (!client) {
      throw new Error(`MCP server not found: ${serverLabel}`);
    }
    
    // Check approval requirement
    const serverConfig = this.config.mcp?.client?.servers?.find(s => s.label === serverLabel);
    const requireApproval = serverConfig?.requireApproval || this.config.mcp?.client?.defaultApproval || 'always';
    
    if (requireApproval === 'always') {
      this.logger?.warn('MCP tool call requires approval but auto-approval not implemented yet', {
        server: serverLabel,
        tool: toolName
      });
      // For now, proceed - in production, this would wait for approval
    }
    
    this.logger?.info('Calling MCP tool', {
      server: serverLabel,
      tool: toolName,
      args
    });
    
    return await client.callTool(toolName, args);
  }

  /**
   * Check if a specific MCP server is available
   * @param {string} serverLabel - MCP server label (e.g., 'github', 'filesystem')
   * @returns {boolean} True if server is initialized and available
   */
  hasMCPServer(serverLabel) {
    return this.mcpClients.has(serverLabel);
  }

  /**
   * List all available MCP servers
   * @returns {Array<string>} Array of server labels
   */
  listMCPServers() {
    return Array.from(this.mcpClients.keys());
  }

  /**
   * Get all MCP tools organized by server
   * @returns {Promise<Object>} Object with server labels as keys, tool arrays as values
   */
  async listMCPTools() {
    const toolsByServer = {};
    
    for (const [label, client] of this.mcpClients) {
      try {
        const tools = await client.listTools();
        toolsByServer[label] = tools.map(t => t.name);
      } catch (error) {
        this.logger?.warn('Failed to list tools from MCP server', {
          server: label,
          error: error.message
        });
        toolsByServer[label] = [];
      }
    }
    
    return toolsByServer;
  }

  /**
   * Get Codex SDK client, refreshing credentials if needed.
   * Called before every Codex API call to ensure fresh tokens.
   * Rebuilds the client if the token has changed since last init.
   */
  /**
   * Get Codex credentials (auto-refreshes expired tokens).
   * Returns { accessToken, accountId } for raw fetch calls.
   */
  async _getCodexCredentials() {
    const codexConfig = this._codexConfig;
    if (!codexConfig?.enabled) {
      throw new Error('OpenAI Codex provider not enabled in config');
    }

    const codexOAuthEngine = require('../services/codex-oauth-engine');
    const creds = await codexOAuthEngine.getCodexCredentials();
    if (!creds || !creds.accessToken) {
      throw new Error('No Codex OAuth credentials available. Import via server OAuth flow.');
    }

    return creds;
  }

  /**
   * Override generate() to add routing with automatic retry
   * CRITICAL: If no modelAssignments or provider is 'openai', calls super.generate()
   * This ensures default behavior = exact GPT5Client behavior
   */
  async generate(options = {}, maxRetries = 1) {
    // Get model assignment from config (returns null if none configured)
    const assignment = this.getModelAssignment(options.component, options.purpose);

    // Provider-aware prompt wrapping
    if (!options.skipProviderOverlay) {
      const provider = assignment?.provider || 'openai';
      if (options.instructions && typeof options.instructions === 'string') {
        options = { ...options, instructions: wrapSystemPrompt(options.instructions, provider) };
      } else if (options.systemPrompt && typeof options.systemPrompt === 'string') {
        options = { ...options, systemPrompt: wrapSystemPrompt(options.systemPrompt, provider) };
      }
    }

    // If no assignment OR assignment is OpenAI -> use parent GPT5Client implementation
    if (!assignment || assignment.provider === 'openai') {
      // Apply model override if specified in assignment
      if (assignment && assignment.model) {
        options = { ...options, model: assignment.model };
      }
      
      // Use parent implementation - exact current GPT-5.2 behavior
      return await super.generate(options);
    }
    
    // Route to alternative provider with retry logic
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (assignment.provider === 'xai') {
          return await this.generateXAI(assignment, options);
        } else if (assignment.provider === 'anthropic') {
          return await this.generateAnthropic(assignment, options);
        } else if (assignment.provider === 'ollama-cloud') {
          return await this.generateOllamaCloud(assignment, options);
        } else if (assignment.provider === 'local') {
          return await this.generateLocal(assignment, options);
        } else if (assignment.provider === 'openai-codex') {
          return await this.generateCodex(assignment, options);
        } else {
          throw new Error(`Unknown provider: ${assignment.provider}`);
        }
      } catch (error) {
        lastError = error;
        
        this.logger?.error('Alternative provider failed', {
          provider: assignment.provider,
          model: assignment.model,
          attempt: attempt + 1,
          maxRetries,
          error: error.message
        });
        
        // Retry with backoff if we have attempts left
        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          this.logger?.info(`Retrying after ${backoff}ms`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
      }
    }
    
    // All retries exhausted, try fallback
    if (assignment.fallback) {
      this.logger?.info('Attempting fallback after all retries failed', {
        fallbackProvider: assignment.fallback.provider,
        fallbackModel: assignment.fallback.model
      });
      
      const fallbackAssignment = assignment.fallback;
      
      if (fallbackAssignment.provider === 'openai') {
        // Fallback to GPT-5
        const fallbackOptions = { ...options, model: fallbackAssignment.model };
        return await super.generate(fallbackOptions);
      } else if (fallbackAssignment.provider === 'xai') {
        return await this.generateXAI(fallbackAssignment, options);
      } else if (fallbackAssignment.provider === 'openai-codex') {
        return await this.generateCodex(fallbackAssignment, options);
      } else if (fallbackAssignment.provider === 'anthropic') {
        return await this.generateAnthropic(fallbackAssignment, options);
      } else if (fallbackAssignment.provider === 'ollama-cloud') {
        return await this.generateOllamaCloud(fallbackAssignment, options);
      } else if (fallbackAssignment.provider === 'local') {
        return await this.generateLocal(fallbackAssignment, options);
      }
    }
    
    // No fallback or fallback failed -> throw error
    throw lastError || new Error('Generation failed after all retries');
  }

  /**
   * Generate with xAI Grok
   * xAI uses OpenAI-compatible Responses API
   */
  async generateXAI(assignment, options) {
    if (!this.xai) {
      throw new Error('xAI provider not initialized');
    }
    
    const {
      instructions = '',
      messages = [],
      input = null,
      query = null,  // Support query parameter
      maxTokens = 2000,
      reasoningEffort = 'medium',
      tools = []
    } = options;
    
    // Build payload - xAI uses same format as OpenAI Responses API
    const payload = {
      model: assignment.model,
      stream: true,
      max_output_tokens: maxTokens
    };
    
    if (instructions && instructions.trim().length > 0) {
      payload.instructions = instructions.trim();
    }
    
    if (input !== null) {
      payload.input = typeof input === 'string' ? input : input;
    } else if (query) {
      // Support query parameter (from generateWithWebSearch)
      let inputString = query;
      if (instructions) {
        inputString = `${instructions}\n\nQuery: ${query}`;
      }
      payload.input = inputString;
    } else if (messages && messages.length > 0) {
      payload.input = messages.map(msg => ({
        type: 'message',
        role: msg.role,
        content: typeof msg.content === 'string' 
          ? [{ type: 'input_text', text: msg.content }]
          : msg.content
      }));
    } else {
      throw new Error('Either input, messages, or query must be provided');
    }
    
    // xAI reasoning effort support varies by model
    // grok-4: Does NOT support reasoning_effort (automatic)
    // grok-3-mini, grok-3-mini-fast: Support low/high
    const supportsReasoningEffort = assignment.model.includes('grok-3');
    if (supportsReasoningEffort && reasoningEffort && reasoningEffort !== 'none') {
      payload.reasoning = { effort: reasoningEffort };
    }
    
    // Check for web search tool
    const needsWebSearch = tools.some(t => t.type === 'web_search');
    if (needsWebSearch) {
      // xAI uses search_parameters for live search (not tools)
      payload.search_parameters = {
        mode: 'auto',  // Model decides when to search
        max_search_results: 3,
        return_citations: true
      };
      this.logger?.info('xAI live search enabled', {
        mode: 'auto',
        maxResults: 3
      });
    } else if (tools.length > 0) {
      // Other tools pass through
      payload.tools = tools;
    }
    
    // Call xAI (same streaming format as OpenAI)
    const stream = await this.xai.responses.stream(payload);
    
    // Extract response (same format as OpenAI)
    let aggregatedText = '';
    let reasoningSummary = '';
    let finalResponse = null;
    let hadError = false;
    let errorType = null;
    
    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'response.completed':
            finalResponse = event.response;
            if (!aggregatedText || aggregatedText.length === 0) {
              aggregatedText = this.extractTextFromResponse(event.response);
            }
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
          case 'response.incomplete':
            hadError = true;
            errorType = event.type;
            this.logger?.warn('xAI response terminated abnormally', {
              type: event.type,
              hasText: aggregatedText.length > 0
            });
            if (event.response) {
              finalResponse = event.response;
            }
            break;
        }
      }
    } catch (streamError) {
      this.logger?.error('xAI stream processing error', {
        error: streamError.message,
        hasPartialText: aggregatedText.length > 0
      });
    }
    
    // Fallback extraction
    if ((!aggregatedText || aggregatedText.length === 0) && finalResponse) {
      aggregatedText = this.extractTextFromResponse(finalResponse);
    }
    
    // Use reasoning as content if needed (same logic as GPT5Client)
    if ((!aggregatedText || aggregatedText.length === 0) && reasoningSummary && reasoningSummary.length > 0) {
      this.logger?.info('Using reasoning as content (xAI workaround)');
      aggregatedText = reasoningSummary;
      reasoningSummary = '';
    }
    
    return {
      content: aggregatedText,
      reasoning: reasoningSummary,
      responseId: finalResponse?.id,
      model: assignment.model,
      usage: finalResponse?.usage,
      output: finalResponse?.output || null,  // CRITICAL: tool calls for agentic loop
      hadError,
      errorType
    };
  }

  /**
   * Generate with OpenAI Codex (ChatGPT OAuth)
   * Uses the Responses API via the Codex backend.
   * Mirrors generateXAI structure — same OpenAI SDK, different client instance.
   */
  async generateCodex(assignment, options) {
    const creds = await this._getCodexCredentials();
    const os = require('os');

    const {
      instructions = '',
      messages = [],
      input = null,
      query = null,
      maxTokens = 2000,
      reasoningEffort = 'medium',
      tools = []
    } = options;

    // Build input in Responses API format
    let resolvedInput;
    if (input !== null) {
      resolvedInput = typeof input === 'string' ? input : input;
    } else if (query) {
      resolvedInput = query;
    } else if (messages && messages.length > 0) {
      resolvedInput = messages.map(msg => ({
        type: 'message',
        role: msg.role,
        content: typeof msg.content === 'string'
          ? [{ type: 'input_text', text: msg.content }]
          : msg.content
      }));
    } else {
      throw new Error('Either input, messages, or query must be provided');
    }

    // Build request body matching OpenClaw's openai-codex-responses format
    const body = {
      model: assignment.model,
      store: false,
      stream: true,
      input: resolvedInput,
      max_output_tokens: maxTokens,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
    };

    if (instructions && instructions.trim().length > 0) {
      body.instructions = instructions.trim();
    }

    if (reasoningEffort && reasoningEffort !== 'none') {
      body.reasoning = { effort: reasoningEffort, summary: 'auto' };
    }

    if (tools.length > 0) {
      body.tools = tools;
    }

    // POST to chatgpt.com/backend-api/codex/responses (NOT /responses)
    const baseUrl = (this._codexConfig?.baseURL || 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
    const url = `${baseUrl}/codex/responses`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
        'chatgpt-account-id': creds.accountId || '',
        'OpenAI-Beta': 'responses=experimental',
        'originator': 'cosmo',
        'oai-language': 'en-US',
        'User-Agent': `cosmo (${os.platform()} ${os.release()}; ${os.arch()})`,
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status} ${errorText.substring(0, 200)}`);
    }

    // Parse SSE stream
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
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim());

        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
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
                if (event.response?.usage) finalUsage = event.response.usage;
                if (!aggregatedText && event.response) {
                  aggregatedText = this.extractTextFromResponse(event.response);
                }
                break;
              case 'response.failed':
                throw new Error(event.response?.error?.message || 'Codex response failed');
              case 'error':
                throw new Error(event.message || event.code || 'Codex stream error');
            }
          } catch (e) {
            if (e.message?.includes('Codex')) throw e;
            // Ignore JSON parse errors on individual events
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
      usage: {
        input_tokens: finalUsage.input_tokens || 0,
        output_tokens: finalUsage.output_tokens || 0,
        total_tokens: (finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0)
      },
      model: assignment.model,
      provider: 'openai-codex'
    };
  }

  /**
   * Generate with Anthropic Claude
   * Different API structure - Messages API
   */
  async generateAnthropic(assignment, options) {
    if (!this.anthropicClient) {
      throw new Error('Anthropic provider not initialized. Enable it in config or set LLM_BACKEND=anthropic. Check that providers.anthropic.enabled is true in config.yaml.');
    }

    const modelToUse = assignment.model || 'claude-sonnet-4-5';

    try {
      this.logger?.info(`[UnifiedClient] Using Anthropic provider with model ${modelToUse}`);

      // AnthropicClient handles all format translation, OAuth, streaming, and tool calling
      const result = await this.anthropicClient.generateWithRetry({
        ...options,
        model: modelToUse
      }, 3);

      return result;

    } catch (error) {
      this.logger?.error('[UnifiedClient] Anthropic generation failed:', error.message);

      // Fallback to OpenAI if configured
      if (assignment.fallback) {
        this.logger?.info('[UnifiedClient] Falling back to OpenAI');
        return await super.generate({
          ...options,
          model: assignment.fallback.model
        });
      }

      throw error;
    }
  }

  /**
   * Generate with local LLM using Chat Completions API
   * Delegates to ChatCompletionsClient which handles format translation
   */
  async generateLocal(assignment, options) {
    if (!this.localClient) {
      throw new Error('Local LLM provider not initialized. Enable it in config or set LLM_BACKEND=local');
    }

    const {
      instructions = '',
      messages = [],
      input = null,
      maxTokens = 2000,
      tools = [],
      temperature,
      top_p
    } = options;

    this.logger?.info('Routing to local LLM', {
      model: assignment.model,
      hasInstructions: Boolean(instructions),
      messageCount: messages.length,
      hasInput: Boolean(input)
    });

    // ChatCompletionsClient handles all the format translation
    // Pass through options with model from assignment
    return await this.localClient.generate({
      ...options,
      model: assignment.model,
      instructions,
      messages,
      input,
      maxTokens,
      tools,
      temperature,
      top_p
    });
  }

  /**
   * Generate with Ollama Cloud (ollama.com/v1)
   * Uses ChatCompletionsClient pointed at cloud endpoint
   */
  async generateOllamaCloud(assignment, options) {
    if (!this.ollamaCloudClient) {
      throw new Error('Ollama Cloud provider not initialized. Enable providers.ollama-cloud in config or set OLLAMA_CLOUD_API_KEY');
    }

    const {
      instructions = '',
      messages = [],
      input = null,
      maxTokens = 2000,
      tools = [],
      temperature,
      top_p
    } = options;

    this.logger?.info('Routing to Ollama Cloud', {
      model: assignment.model,
      hasInstructions: Boolean(instructions),
      messageCount: messages.length,
      hasInput: Boolean(input)
    });

    return await this.ollamaCloudClient.generate({
      ...options,
      model: assignment.model,
      instructions,
      messages,
      input,
      maxTokens,
      tools,
      temperature,
      top_p
    });
  }

  /**
   * Get model assignment from config
   * CRITICAL: Returns null if no modelAssignments configured
   * This ensures default behavior = GPT5Client
   */
  getModelAssignment(component, purpose) {
    // If no modelAssignments in config, return null -> use GPT5Client
    if (!this.config.modelAssignments) {
      this.logger?.debug('No modelAssignments in config, using defaults');
      return null;
    }
    
    // Build config key: component.purpose (e.g., "quantumReasoner.branches")
    const key = purpose ? `${component}.${purpose}` : component;
    let assignment = this.config.modelAssignments[key];
    
    // Try component-level default if specific not found
    if (!assignment && purpose) {
      assignment = this.config.modelAssignments[component];
    }

    // Try global 'default' assignment as final fallback (for local LLM mode)
    if (!assignment) {
      assignment = this.config.modelAssignments['default'];
      if (assignment) {
        this.logger?.debug('Using default model assignment', {
          component,
          purpose,
          provider: assignment.provider,
          model: assignment.model
        });
      }
    }

    // If still no assignment found, return null -> use GPT5Client
    if (!assignment) {
      this.logger?.debug('No assignment found for component', {
        component,
        purpose,
        key,
        availableKeys: Object.keys(this.config.modelAssignments || {})
      });
      return null;
    }
    
    this.logger?.info('✅ Model assignment found', {
      key: key,
      provider: assignment.provider,
      model: assignment.model
    });
    
    return {
      provider: assignment.provider || 'openai',
      model: assignment.model,
      fallback: assignment.fallback || null
    };
  }

  /**
   * Override generateWithWebSearch to support xAI and model routing
   * Falls back to parent if using OpenAI
   */
  async generateWithWebSearch(options = {}) {
    const assignment = this.getModelAssignment(options.component, options.purpose);

    // Provider-aware prompt wrapping
    if (!options.skipProviderOverlay) {
      const provider = assignment?.provider || 'openai';
      if (options.instructions && typeof options.instructions === 'string') {
        options = { ...options, instructions: wrapSystemPrompt(options.instructions, provider) };
      } else if (options.systemPrompt && typeof options.systemPrompt === 'string') {
        options = { ...options, systemPrompt: wrapSystemPrompt(options.systemPrompt, provider) };
      }
    }

    // If OpenAI or no assignment -> use parent (GPT-5.2) with model override
    if (!assignment || assignment.provider === 'openai') {
      // CRITICAL: Apply model override if assignment specifies a different model
      if (assignment && assignment.model) {
        options = { ...options, model: assignment.model };
        this.logger?.info('🔄 Model override applied', {
          component: options.component,
          purpose: options.purpose,
          from: 'default',
          to: assignment.model
        });
      }
      return await super.generateWithWebSearch(options);
    }
    
    // If xAI -> use xAI's web search
    if (assignment.provider === 'xai') {
      return await this.generate({
        ...options,
        tools: [{ type: 'web_search' }]
      });
    }

    // If openai-codex -> use Codex client with web search tool
    if (assignment.provider === 'openai-codex') {
      return await this.generate({
        ...options,
        tools: [{ type: 'web_search' }]
      });
    }

    // If local -> use local client's web search handling (DuckDuckGo/SearXNG)
    if (assignment.provider === 'local') {
      if (!this.localClient) {
        throw new Error('Local LLM provider not initialized. Enable it in config or set LLM_BACKEND=local');
      }
      return await this.localClient.generateWithWebSearch(options);
    }

    // If ollama-cloud -> use cloud client's web search handling
    if (assignment.provider === 'ollama-cloud') {
      if (!this.ollamaCloudClient) {
        throw new Error('Ollama Cloud provider not initialized. Enable providers.ollama-cloud in config');
      }
      return await this.ollamaCloudClient.generateWithWebSearch({ ...options, model: assignment.model });
    }

    // If Anthropic -> use Anthropic's native web_search_20250305 tool
    if (assignment.provider === 'anthropic') {
      if (!this.anthropicClient) {
        throw new Error('Anthropic provider not initialized but assignment routes to Anthropic. Check config.');
      }
      return await this.anthropicClient.generateWithWebSearch(options);
    }

    // Unknown provider - throw instead of silently falling back
    throw new Error(`Web search not supported by provider: ${assignment.provider}`);
  }

  /**
   * Override generateWithReasoning
   * Falls back to parent for most cases
   */
  async generateWithReasoning(options = {}) {
    const assignment = this.getModelAssignment(options.component, options.purpose);
    
    // If OpenAI or no assignment -> use parent (GPT-5.2) with model override
    if (!assignment || assignment.provider === 'openai') {
      // CRITICAL: Apply model override if assignment specifies a different model
      if (assignment && assignment.model) {
        options = { ...options, model: assignment.model };
        this.logger?.debug('Model override for reasoning', {
          component: options.component,
          purpose: options.purpose,
          model: assignment.model
        });
      }
      return await super.generateWithReasoning(options);
    }
    
    // xAI supports reasoning
    if (assignment.provider === 'xai') {
      return await this.generate({
        ...options,
        reasoningEffort: 'high'
      });
    }

    // If openai-codex -> use Codex with high reasoning
    if (assignment.provider === 'openai-codex') {
      return await this.generate({
        ...options,
        reasoningEffort: 'high'
      });
    }

    // Anthropic doesn't have separate reasoning -> regular call
    if (assignment.provider === 'anthropic') {
      this.logger?.info('Anthropic does not support separate reasoning, using standard generation');
      return await this.generate(options);
    }

    // Local LLMs don't have separate reasoning -> use standard generation with more tokens
    if (assignment.provider === 'local') {
      if (!this.localClient) {
        throw new Error('Local LLM provider not initialized. Enable it in config or set LLM_BACKEND=local');
      }
      return await this.localClient.generateWithReasoning(options);
    }

    // Ollama Cloud -> use cloud client's reasoning
    if (assignment.provider === 'ollama-cloud') {
      if (!this.ollamaCloudClient) {
        throw new Error('Ollama Cloud provider not initialized. Enable providers.ollama-cloud in config');
      }
      return await this.ollamaCloudClient.generateWithReasoning({ ...options, model: assignment.model });
    }

    // Unknown provider - don't silently fall back to OpenAI
    throw new Error(`Reasoning not supported by provider: ${assignment.provider}`);
  }

  /**
   * Override generateFast
   * Falls back to parent
   */
  async generateFast(options = {}) {
    const assignment = this.getModelAssignment(options.component, options.purpose);

    // Provider-aware prompt wrapping
    if (!options.skipProviderOverlay) {
      const provider = assignment?.provider || 'openai';
      if (options.instructions && typeof options.instructions === 'string') {
        options = { ...options, instructions: wrapSystemPrompt(options.instructions, provider) };
      } else if (options.systemPrompt && typeof options.systemPrompt === 'string') {
        options = { ...options, systemPrompt: wrapSystemPrompt(options.systemPrompt, provider) };
      }
    }

    // If no assignment -> use parent
    if (!assignment) {
      return await super.generateFast(options);
    }
    
    // If OpenAI assignment -> use parent with model override
    if (assignment.provider === 'openai') {
      options = { ...options, model: assignment.model };
      this.logger?.debug('Model override for fast generation', {
        component: options.component,
        purpose: options.purpose,
        model: assignment.model
      });
      return await super.generateFast(options);
    }

    // If openai-codex -> use Codex with fast settings
    if (assignment.provider === 'openai-codex') {
      return await this.generate({
        ...options,
        maxTokens: options.maxTokens || 1000,
        reasoningEffort: 'low'
      });
    }

    // If local -> use local client's fast generation
    if (assignment.provider === 'local') {
      if (!this.localClient) {
        throw new Error('Local LLM provider not initialized. Enable it in config or set LLM_BACKEND=local');
      }
      return await this.localClient.generateFast({
        ...options,
        model: assignment.model
      });
    }

    // If ollama-cloud -> use cloud client's fast generation
    if (assignment.provider === 'ollama-cloud') {
      if (!this.ollamaCloudClient) {
        throw new Error('Ollama Cloud provider not initialized. Enable providers.ollama-cloud in config');
      }
      return await this.ollamaCloudClient.generateFast({
        ...options,
        model: assignment.model
      });
    }

    // If assignment exists for alternative provider, use it with fast settings
    return await this.generate({
      ...options,
      maxTokens: options.maxTokens || 1000,
      reasoningEffort: 'low'
    });
  }

  /**
   * All other methods inherited from GPT5Client:
   * - generateWithRetry()
   * - extractTextFromResponse()
   * - extractReasoning()
   * - extractToolCalls()
   * - extractWebSearchData()
   * - createContainer()
   * - uploadFileToContainer()
   * - listContainerFiles()
   * - executeInContainer()
   * - deleteContainer()
   * - generateWithCodeInterpreter()
   * 
   * These all work exactly as before via inheritance.
   */
  
  /**
   * OpenAI-compatible createCompletion method for IDE Agent
   * Uses GPT5Client Responses API for proper function calling
   * Matches the working IDE pattern from ide/ai-handler.js
   * 
   * @param {Object} options - { messages, tools, model, ... }
   * @returns {Object} - { choices: [{ message: { content, tool_calls } }] }
   */
  async createCompletion(options = {}) {
    const { messages = [], tools = [], model, ...rest } = options;
    
    // Use model assignment routing if available, fall back to config hierarchy
    const assignment = this.getModelAssignment('ide', 'completion');
    const selectedModel = model || assignment?.model || this.config?.ide?.model || this.config?.models?.primary;
    
    // Extract system message for instructions
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMsgs = messages.filter(m => m.role !== 'system');
    
    // Convert messages to Responses API input format (matching ide/ai-handler.js)
    const input = [];
    for (const msg of conversationMsgs) {
      if (msg.role === 'user') {
        input.push({ 
          role: 'user', 
          content: typeof msg.content === 'string' ? msg.content : msg.content 
        });
      } else if (msg.role === 'assistant') {
        // Handle assistant messages with tool calls (matching ide/ai-handler.js exactly)
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          // Content first (if any), then function_call items
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
          // No tool calls - push content (empty string if none, matching IDE)
          input.push({ role: 'assistant', content: msg.content || '' });
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        // Convert tool results to function_call_output format
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      }
    }
    
    // Convert Chat Completions tool format to Responses API format
    // Chat Completions: { type: 'function', function: { name, description, parameters } }
    // Responses API: { type: 'function', name, description, parameters, strict }
    // CRITICAL: When strict=true, parameters MUST have additionalProperties: false
    const convertedTools = tools.length > 0 ? tools
      .filter(t => t && t.type === 'function' && t.function && t.function.name)
      .map(t => {
        // Ensure parameters have additionalProperties: false (required for strict mode)
        const params = t.function.parameters ? {
          ...t.function.parameters,
          additionalProperties: false
        } : null;
        
        return {
          type: 'function',
          name: t.function.name,
          description: t.function.description || null,
          parameters: params,
          strict: true
        };
      }) : undefined;
    
    try {
      // Route through UnifiedClient.generate() — handles OpenAI, Anthropic, xAI, Ollama
      // CRITICAL: Pass messages in BOTH formats. The `input` (Responses API) is only
      // used by OpenAI. Anthropic/xAI/Ollama use `messages` (Chat Completions format)
      // which the Anthropic client's _transformInputToMessages correctly handles
      // (assistant tool_calls → tool_use blocks, tool results → tool_result blocks).
      // If `input` is passed, AnthropicClient prefers it but can't convert function_call
      // items to tool_use blocks, causing "no corresponding tool_use block" errors.
      const response = await this.generate({
        component: 'execution',
        purpose: 'agentic_loop',
        model: selectedModel,
        instructions: systemMsg?.content || '',
        messages: conversationMsgs,  // Chat Completions format — used by Anthropic, xAI, Ollama
        input: input,                // Responses API format — used by OpenAI only
        tools: convertedTools,
        ...rest
      });

      // UnifiedClient.generate() returns tool calls in response.output (all providers)
      // Anthropic client uses type: 'function' (OpenAI Chat Completions format)
      // OpenAI Responses API uses type: 'function_call'
      // Normalize all formats
      let toolCalls = [];
      if (response.output && Array.isArray(response.output)) {
        toolCalls = response.output.filter(item =>
          item.type === 'function_call' || item.type === 'tool_use' || item.type === 'function'
        );
      }
      if (toolCalls.length === 0 && response.tool_calls && Array.isArray(response.tool_calls)) {
        toolCalls = response.tool_calls;
      }

      // Build OpenAI Chat Completions API compatible response
      const assistantMessage = {
        role: 'assistant',
        content: response.content || null
      };

      // Add tool_calls in OpenAI Chat Completions format
      // Handles three source formats:
      //   Anthropic client: { type: 'function', id, function: { name, arguments } }
      //   OpenAI Responses: { type: 'function_call', call_id, name, arguments }
      //   Anthropic native: { type: 'tool_use', id, name, input }
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls.map(tc => {
          const name = tc.function?.name || tc.name;
          const rawArgs = tc.function?.arguments || tc.arguments || tc.input;
          const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
          return {
            id: tc.id || tc.call_id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: { name, arguments: args }
          };
        });
      }

      return {
        choices: [{
          index: 0,
          message: assistantMessage,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }],
        model: response.model || selectedModel,
        usage: response.usage
      };
    } catch (error) {
      this.logger?.error?.('createCompletion failed', { error: error.message });
      throw error;
    }
  }
}

module.exports = { UnifiedClient };

