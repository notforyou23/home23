const { GPT5Client } = require('./gpt5-client');
const { MCPClient } = require('./mcp-client');
const { ChatCompletionsClient } = require('./chat-completions-client');
const OpenAI = require('openai');

/**
 * Stealth headers required when authenticating to Anthropic via OAuth tokens
 * (sk-ant-oat*). Without these, Anthropic rejects the request with
 * "OAuth authentication is currently not supported."
 *
 * This mirrors the header set the TS harness uses at src/agent/loop.ts —
 * the two must stay in sync. Any change here likely needs a matching change
 * there.
 */
function getAnthropicStealthHeaders() {
  return {
    'accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
    'user-agent': 'claude-cli/2.1.32 (external, cli)',
    'x-app': 'cli',
  };
}

function isAnthropicSamplingDeprecatedModel(model) {
  return /^claude-opus-4-7(?:$|[-@])/.test(String(model || '').trim());
}

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
    this.anthropic = null;
    this.minimax = null;
    this.localClient = null; // For local LLM support via Chat Completions API
    this.groqClient = null;  // Groq free tier (OpenAI-compatible)
    this.hfClient = null;    // HuggingFace Inference (OpenAI-compatible)
    this.mcpClients = new Map(); // MCP server label -> MCPClient instance

    // Rate limit tracking for free-tier providers
    this.rateLimits = new Map(); // provider -> { requests: Map<model, {count, resetAt}>, tokens: Map<model, {count, resetAt}> }

    // Load Anthropic SDK only if needed (lazy loading)
    this.AnthropicSDK = null;
    
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
    
    if (this.config.providers?.anthropic?.enabled) {
      const authToken = process.env.ANTHROPIC_AUTH_TOKEN || this.config.providers.anthropic.authToken;
      const apiKey = process.env.ANTHROPIC_API_KEY || this.config.providers.anthropic.apiKey;
      const isOAuth = Boolean(authToken && String(authToken).startsWith('sk-ant-oat'));
      if (authToken || apiKey) {
        try {
          // Lazy load Anthropic SDK — support both OAuth token and API key.
          // OAuth tokens (sk-ant-oat*) require stealth headers that impersonate
          // Claude Code CLI; the SDK's raw apiKey/authToken path without these
          // headers gets rejected with "OAuth authentication is currently not
          // supported." Port the same header set the TS harness uses at
          // src/agent/loop.ts getStealthHeaders().
          this.AnthropicSDK = require('@anthropic-ai/sdk');
          const opts = authToken ? { authToken } : { apiKey };
          if (isOAuth) {
            opts.defaultHeaders = getAnthropicStealthHeaders();
          }
          this.anthropic = new this.AnthropicSDK(opts);
          this.logger?.info(`✅ Anthropic Claude provider initialized (${authToken ? (isOAuth ? 'OAuth + stealth headers' : 'OAuth') : 'API key'})`);
        } catch (error) {
          this.logger?.warn('Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk');
        }
      } else {
        this.logger?.warn('Anthropic enabled in config but no API key found (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)');
      }
    }

    if (this.config.providers?.minimax?.enabled) {
      const apiKey = process.env.MINIMAX_API_KEY || this.config.providers.minimax.apiKey;
      if (apiKey) {
        try {
          this.AnthropicSDK = this.AnthropicSDK || require('@anthropic-ai/sdk');
          this.minimax = new this.AnthropicSDK({
            apiKey,
            baseURL: this.config.providers.minimax.baseUrl || 'https://api.minimax.io/anthropic'
          });
          this.logger?.info('✅ MiniMax provider initialized (Anthropic-compatible)');
        } catch (error) {
          this.logger?.warn(`MiniMax enabled in config but failed to initialize: ${error.message}`);
        }
      } else {
        this.logger?.warn('MiniMax enabled in config but no API key found (MINIMAX_API_KEY)');
      }
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

    // Initialize Groq client if enabled (OpenAI-compatible, free tier)
    if (this.config.providers?.groq?.enabled) {
      const apiKey = process.env.GROQ_API_KEY || this.config.providers.groq.apiKey;
      if (apiKey) {
        const groqConfig = this.config.providers.groq;
        this.groqClient = new ChatCompletionsClient({
          baseURL: groqConfig.baseURL || 'https://api.groq.com/openai/v1',
          apiKey: apiKey,
          modelMapping: groqConfig.modelMapping || {},
          defaultModel: groqConfig.defaultModel || 'llama-3.3-70b-versatile',
          supportsTools: groqConfig.supportsTools !== false,
          supportsStreaming: groqConfig.supportsStreaming !== false
        }, this.logger);
        // Initialize rate limit tracking for Groq models
        this.initRateLimits('groq', groqConfig.rateLimits || {});
        this.logger?.info('✅ Groq provider initialized (free tier)');
      } else {
        this.logger?.warn('Groq enabled in config but no API key found (GROQ_API_KEY)');
      }
    }

    // Initialize Ollama Cloud client if enabled (OpenAI-compatible, https://ollama.com/v1)
    this.ollamaCloudClient = null;
    if (this.config.providers?.['ollama-cloud']?.enabled) {
      const apiKey = process.env.OLLAMA_CLOUD_API_KEY || this.config.providers['ollama-cloud'].apiKey;
      if (apiKey) {
        const cloudConfig = this.config.providers['ollama-cloud'];
        this.ollamaCloudClient = new ChatCompletionsClient({
          baseURL: cloudConfig.baseURL || 'https://ollama.com/v1',
          apiKey: apiKey,
          modelMapping: cloudConfig.modelMapping || {},
          defaultModel: cloudConfig.defaultModel || 'nemotron-3-nano:30b',
          supportsTools: cloudConfig.supportsTools !== false,
          supportsStreaming: cloudConfig.supportsStreaming !== false
        }, this.logger);
        this.logger?.info('✅ Ollama Cloud provider initialized');
      } else {
        this.logger?.warn('Ollama Cloud enabled in config but no API key found (OLLAMA_CLOUD_API_KEY)');
      }
    }

    // Initialize HuggingFace client if enabled (OpenAI-compatible, free tier)
    if (this.config.providers?.huggingface?.enabled) {
      const apiKey = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || this.config.providers.huggingface.apiKey;
      if (apiKey) {
        const hfConfig = this.config.providers.huggingface;
        this.hfClient = new ChatCompletionsClient({
          baseURL: hfConfig.baseURL || 'https://router.huggingface.co/v1',
          apiKey: apiKey,
          modelMapping: hfConfig.modelMapping || {},
          defaultModel: hfConfig.defaultModel || 'deepseek-ai/DeepSeek-V3.1',
          supportsTools: hfConfig.supportsTools !== false,
          supportsStreaming: hfConfig.supportsStreaming !== false
        }, this.logger);
        this.logger?.info('✅ HuggingFace provider initialized (free tier)');
      } else {
        this.logger?.warn('HuggingFace enabled in config but no token found (HF_TOKEN)');
      }
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
        const client = new MCPClient(serverConfig, this.logger);
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
   * Initialize rate limit tracking for a provider
   * Config format: { "model-id": { rpd: 1000, tpd: 100000, rpm: 30, tpm: 12000 } }
   */
  initRateLimits(provider, limits) {
    const providerLimits = {
      requests: new Map(), // model -> { count, dayResetAt }
      requestsPerMin: new Map() // model -> { count, minResetAt }
    };
    for (const [model, modelLimits] of Object.entries(limits)) {
      providerLimits.requests.set(model, {
        count: 0, dayResetAt: this.getNextDayReset(),
        rpd: modelLimits.rpd || Infinity, rpm: modelLimits.rpm || Infinity,
        tpd: modelLimits.tpd || Infinity, tpm: modelLimits.tpm || Infinity
      });
      providerLimits.requestsPerMin.set(model, {
        count: 0, minResetAt: Date.now() + 60000
      });
    }
    this.rateLimits.set(provider, providerLimits);
  }

  getNextDayReset() {
    const now = new Date();
    const reset = new Date(now);
    reset.setHours(24, 0, 0, 0);
    return reset.getTime();
  }

  /**
   * Check if a provider+model is within rate limits
   * Returns true if OK, false if rate-limited
   */
  checkRateLimit(provider, model) {
    const limits = this.rateLimits.get(provider);
    if (!limits) return true; // No limits configured = allow

    const dayTracker = limits.requests.get(model);
    if (!dayTracker) return true; // No limits for this model = allow

    const now = Date.now();

    // Reset daily counters if day has rolled over
    if (now >= dayTracker.dayResetAt) {
      dayTracker.count = 0;
      dayTracker.dayResetAt = this.getNextDayReset();
    }

    // Reset per-minute counters
    const minTracker = limits.requestsPerMin.get(model);
    if (minTracker && now >= minTracker.minResetAt) {
      minTracker.count = 0;
      minTracker.minResetAt = now + 60000;
    }

    // Check daily limit
    if (dayTracker.count >= dayTracker.rpd) {
      this.logger?.warn('Rate limit reached (RPD)', { provider, model, count: dayTracker.count, limit: dayTracker.rpd });
      return false;
    }

    // Check per-minute limit
    if (minTracker && minTracker.count >= dayTracker.rpm) {
      this.logger?.warn('Rate limit reached (RPM)', { provider, model, count: minTracker.count, limit: dayTracker.rpm });
      return false;
    }

    return true;
  }

  /**
   * Record a request for rate limiting
   */
  recordRequest(provider, model) {
    const limits = this.rateLimits.get(provider);
    if (!limits) return;

    const dayTracker = limits.requests.get(model);
    if (dayTracker) dayTracker.count++;

    const minTracker = limits.requestsPerMin.get(model);
    if (minTracker) minTracker.count++;
  }

  /**
   * Generate with a ChatCompletionsClient (Groq or HuggingFace)
   */
  async generateWithChatClient(client, providerName, assignment, options) {
    if (!client) {
      throw new Error(`${providerName} provider not initialized`);
    }

    this.logger?.info(`Routing to ${providerName}`, {
      model: assignment.model,
      hasInstructions: Boolean(options.instructions),
      messageCount: (options.messages || []).length
    });

    // Record the request for rate limiting
    this.recordRequest(providerName, assignment.model);

    return await client.generate({
      ...options,
      model: assignment.model
    });
  }

  /**
   * Resolve a fallback chain — supports single object or array of fallbacks
   * Tries each in order until one succeeds
   */
  async resolveFallbackChain(fallbacks, options) {
    const chain = Array.isArray(fallbacks) ? fallbacks : [fallbacks];

    for (let i = 0; i < chain.length; i++) {
      const fb = chain[i];
      try {
        // Check rate limits before trying
        if ((fb.provider === 'groq' || fb.provider === 'huggingface') && !this.checkRateLimit(fb.provider, fb.model)) {
          this.logger?.info('Skipping rate-limited fallback', { provider: fb.provider, model: fb.model, step: i + 1 });
          continue;
        }

        this.logger?.info('Trying fallback', { provider: fb.provider, model: fb.model, step: i + 1, total: chain.length });

        if (fb.provider === 'openai' || fb.provider === 'openai-codex') {
          return await super.generate({ ...options, model: fb.model });
        } else if (fb.provider === 'xai') {
          return await this.generateXAI(fb, options);
        } else if (fb.provider === 'anthropic') {
          return await this.generateAnthropic(fb, options);
        } else if (fb.provider === 'minimax') {
          return await this.generateMiniMax(fb, options);
        } else if (fb.provider === 'local') {
          return await this.generateLocal(fb, options);
        } else if (fb.provider === 'groq') {
          return await this.generateWithChatClient(this.groqClient, 'groq', fb, options);
        } else if (fb.provider === 'huggingface') {
          return await this.generateWithChatClient(this.hfClient, 'huggingface', fb, options);
        } else if (fb.provider === 'ollama-cloud') {
          return await this.generateWithChatClient(this.ollamaCloudClient, 'ollama-cloud', fb, options);
        }
      } catch (error) {
        this.logger?.warn('Fallback failed', { provider: fb.provider, model: fb.model, step: i + 1, error: error.message });
        continue;
      }
    }

    throw new Error('All fallbacks exhausted');
  }

  /**
   * Override generate() to add routing with automatic retry
   * CRITICAL: If no modelAssignments or provider is 'openai', calls super.generate()
   * This ensures default behavior = exact GPT5Client behavior
   */
  async generate(options = {}, maxRetries = 1) {
    // Get model assignment from config (returns null if none configured)
    const assignment = this.getModelAssignment(options.component, options.purpose);
    
    // If no assignment OR assignment is OpenAI/OpenAI-Codex -> use parent GPT5Client implementation
    if (!assignment || assignment.provider === 'openai' || assignment.provider === 'openai-codex') {
      // Apply model override if specified in assignment
      if (assignment && assignment.model) {
        options = { ...options, model: assignment.model };
      }

      // Use parent implementation - exact current GPT-5.2 behavior
      return await super.generate(options);
    }
    
    // Check rate limits for free-tier providers before attempting
    if ((assignment.provider === 'groq' || assignment.provider === 'huggingface') 
        && !this.checkRateLimit(assignment.provider, assignment.model)) {
      // Rate-limited — skip directly to fallback chain
      this.logger?.info('Primary provider rate-limited, going to fallback chain', {
        provider: assignment.provider, model: assignment.model
      });
      if (assignment.fallback) {
        return await this.resolveFallbackChain(assignment.fallback, options);
      }
      throw new Error(`Rate limited on ${assignment.provider}/${assignment.model} with no fallback`);
    }

    // Route to alternative provider with retry logic
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (assignment.provider === 'xai') {
          return await this.generateXAI(assignment, options);
        } else if (assignment.provider === 'anthropic') {
          return await this.generateAnthropic(assignment, options);
        } else if (assignment.provider === 'minimax') {
          return await this.generateMiniMax(assignment, options);
        } else if (assignment.provider === 'local') {
          return await this.generateLocal(assignment, options);
        } else if (assignment.provider === 'groq') {
          return await this.generateWithChatClient(this.groqClient, 'groq', assignment, options);
        } else if (assignment.provider === 'huggingface') {
          return await this.generateWithChatClient(this.hfClient, 'huggingface', assignment, options);
        } else if (assignment.provider === 'ollama-cloud') {
          return await this.generateWithChatClient(this.ollamaCloudClient, 'ollama-cloud', assignment, options);
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
    
    // All retries exhausted, try fallback chain
    if (assignment.fallback) {
      this.logger?.info('Attempting fallback chain after all retries failed');
      try {
        return await this.resolveFallbackChain(assignment.fallback, options);
      } catch (fallbackError) {
        this.logger?.error('All fallbacks exhausted', { error: fallbackError.message });
        throw fallbackError;
      }
    }
    
    // No fallback configured -> throw error
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
      hadError,
      errorType
    };
  }

  /**
   * Generate with Anthropic Claude
   * Different API structure - Messages API
   */
  async generateAnthropic(assignment, options) {
    if (!this.anthropic) {
      throw new Error('Anthropic provider not initialized');
    }
    return await this.generateAnthropicCompatible(this.anthropic, 'Anthropic', assignment, options);
  }

  async generateMiniMax(assignment, options) {
    if (!this.minimax) {
      throw new Error('MiniMax provider not initialized');
    }
    return await this.generateAnthropicCompatible(this.minimax, 'MiniMax', assignment, options);
  }

  async generateAnthropicCompatible(client, providerName, assignment, options) {

    const {
      instructions = '',
      messages = [],
      input = null,
      query = null,
      maxTokens = 4096,
      temperature = 1.0,
      topP = 1.0,
      topK = 5,
      tools = []
    } = options;

    // Anthropic requires max_tokens - use default if not provided
    const finalMaxTokens = maxTokens || 4096;

    // Many engine callers use the GPT5Client `input` / `query` shorthand
    // (OpenAI Responses API style) rather than an explicit `messages`
    // array. Translate so the Anthropic-compatible API doesn't reject
    // with "messages must not be empty (2013)".
    let finalMessages = Array.isArray(messages) ? [...messages] : [];
    if (finalMessages.length === 0) {
      const userContent = input != null ? input : query;
      if (userContent != null) {
        const text = typeof userContent === 'string'
          ? userContent
          : JSON.stringify(userContent);
        if (text && text.trim().length > 0) {
          finalMessages = [{ role: 'user', content: text }];
        }
      }
    }
    if (finalMessages.length === 0) {
      throw new Error(`${providerName}: no messages, input, or query provided`);
    }

    const payload = {
      model: assignment.model,
      messages: finalMessages,
      max_tokens: finalMaxTokens // REQUIRED by Anthropic
    };

    if (!(providerName === 'Anthropic' && isAnthropicSamplingDeprecatedModel(assignment.model))) {
      payload.temperature = temperature;
      payload.top_p = topP;
      payload.top_k = topK;
    }

    // System prompt with ephemeral cache breakpoint for large prompts.
    // MiniMax + Anthropic both support cache_control: ephemeral (5-min TTL,
    // auto-refreshed on hits). Cached reads cost ~0.1× base, writes cost 1.25×.
    // Net savings require hit rate > ~11% — so we only cache prompts large
    // enough that a single hit pays back the write. The engine has many
    // unique per-call prompts (coordinator phases, scorers, categorizers) that
    // would write without ever being re-read at a 1024-char threshold.
    //
    // 4096 chars (~1000 tokens) covers the few genuinely stable large prompts
    // (identity-heavy system messages) while skipping per-call noise.
    if (instructions && instructions.trim().length > 0) {
      const sys = instructions.trim();
      if (sys.length >= 4096) {
        payload.system = [{
          type: 'text',
          text: sys,
          cache_control: { type: 'ephemeral' }
        }];
      } else {
        payload.system = sys;
      }
    }

    // Tool forwarding — MiniMax-M2.7 and Claude both accept Anthropic-format tools:
    //   { name, description, input_schema }
    // Callers may pass OpenAI-format tools: { type: 'function', function: {...} }
    // Skip built-in tools that don't exist in the Anthropic API (web_search, etc.)
    const anthropicTools = this._convertToolsToAnthropic(tools);
    if (anthropicTools.length > 0) {
      payload.tools = anthropicTools;
    }

    this.logger?.debug('Calling Anthropic-compatible API', {
      provider: providerName,
      model: assignment.model,
      maxTokens: finalMaxTokens,
      hasSystem: Boolean(payload.system),
      systemCached: Array.isArray(payload.system),
      toolCount: anthropicTools.length,
      messageCount: finalMessages.length
    });

    // Call the API
    const response = await client.messages.create(payload);

    // Extract all block types. MiniMax-M2.7 and Claude can interleave:
    //   - text blocks (normal response content)
    //   - thinking blocks (interleaved reasoning — M2.7 returns this before tool calls)
    //   - tool_use blocks (structured function calls)
    const textParts = [];
    const thinkingParts = [];
    const toolCalls = [];

    for (const block of (response.content || [])) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'thinking') {
        thinkingParts.push(block.thinking);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input
        });
      }
    }

    const content = textParts.join('\n');
    const reasoning = thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null;

    this.logger?.debug(`${providerName} response received`, {
      model: response.model,
      stopReason: response.stop_reason,
      contentLength: content.length,
      reasoningLength: reasoning?.length || 0,
      toolCallCount: toolCalls.length,
      cacheRead: response.usage?.cache_read_input_tokens || 0,
      cacheWrite: response.usage?.cache_creation_input_tokens || 0
    });

    // Surface cache activity at info level — cache hits are operationally
    // significant (cost savings + shorter TTFB) and cache writes indicate
    // the breakpoint is working
    const cacheRead = response.usage?.cache_read_input_tokens || 0;
    const cacheWrite = response.usage?.cache_creation_input_tokens || 0;
    if (cacheRead > 0 || cacheWrite > 0) {
      this.logger?.info?.(`${providerName} cache activity`, {
        model: response.model,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0
      });
    }

    return {
      content: content,
      reasoning: reasoning, // Interleaved thinking blocks (M2.7 / Claude extended thinking)
      toolCalls: toolCalls, // Structured tool_use blocks for agent loops
      rawContent: response.content || [], // Preserved block array for multi-turn tool continuation
      responseId: response.id,
      model: response.model,
      usage: response.usage,
      hadError: false,
      errorType: null,
      metadata: {
        stopReason: response.stop_reason,
        stopSequence: response.stop_sequence,
        cacheReadTokens: response.usage?.cache_read_input_tokens || 0,
        cacheWriteTokens: response.usage?.cache_creation_input_tokens || 0
      }
    };
  }

  /**
   * Convert tool definitions to Anthropic's expected shape.
   * Accepts either Anthropic-format ({name, input_schema}) or
   * OpenAI-format ({type: 'function', function: {name, parameters}}).
   * Drops unsupported built-in tools (web_search, file_search, etc.) that
   * the Anthropic API doesn't accept.
   */
  _convertToolsToAnthropic(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    const result = [];
    for (const tool of tools) {
      // Skip OpenAI-style built-ins not supported by Anthropic-compatible endpoints
      if (tool.type === 'web_search' || tool.type === 'file_search' ||
          tool.type === 'code_interpreter' || tool.type === 'retrieval') {
        continue;
      }
      // Already Anthropic-format
      if (tool.name && tool.input_schema) {
        result.push({
          name: tool.name,
          description: tool.description || '',
          input_schema: tool.input_schema
        });
        continue;
      }
      // OpenAI function-format: { type: 'function', function: {name, description, parameters} }
      if (tool.type === 'function' && tool.function) {
        result.push({
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || { type: 'object', properties: {} }
        });
        continue;
      }
      // Unknown shape — log and skip
      this.logger?.warn?.('Skipping tool with unrecognized shape', {
        keys: Object.keys(tool || {}).join(',')
      });
    }
    return result;
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
    
    // If OpenAI or no assignment -> use parent (GPT-5.2) with model override
    if (!assignment || assignment.provider === 'openai' || assignment.provider === 'openai-codex') {
      // CRITICAL: Apply model override if assignment specifies a different model
      if (assignment && assignment.model) {
        options = { ...options, model: assignment.model };
        this.logger?.info('🔄 Model override applied', {
          component: options.component,
          purpose: options.purpose,
          from: 'gpt-5-mini',
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

    // If local -> use local client's web search handling (graceful fallback)
    if (assignment.provider === 'local' && this.localClient) {
      return await this.localClient.generateWithWebSearch(options);
    }

    // Groq/HF/OllamaCloud -> use local web search enrichment then send to cloud model
    if ((assignment.provider === 'groq' || assignment.provider === 'huggingface' || assignment.provider === 'ollama-cloud')) {
      const client = assignment.provider === 'groq' ? this.groqClient
        : assignment.provider === 'ollama-cloud' ? this.ollamaCloudClient
        : this.hfClient;
      if (client) {
        return await client.generateWithWebSearch({ ...options, model: assignment.model });
      }
    }

    // Anthropic or other -> fallback to GPT-5
    this.logger?.warn('Web search not supported by provider, using GPT-5.2 fallback', {
      provider: assignment.provider
    });
    return await super.generateWithWebSearch(options);
  }

  /**
   * Override generateWithReasoning
   * Falls back to parent for most cases
   */
  async generateWithReasoning(options = {}) {
    const assignment = this.getModelAssignment(options.component, options.purpose);
    
    // If OpenAI or no assignment -> use parent (GPT-5.2) with model override
    if (!assignment || assignment.provider === 'openai' || assignment.provider === 'openai-codex') {
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
    
    // Anthropic doesn't have separate reasoning -> regular call
    if (assignment.provider === 'anthropic' || assignment.provider === 'minimax') {
      this.logger?.info('Anthropic does not support separate reasoning, using standard generation');
      return await this.generate(options);
    }

    // Local LLMs don't have separate reasoning -> use standard generation with more tokens
    if (assignment.provider === 'local' && this.localClient) {
      return await this.localClient.generateWithReasoning(options);
    }

    // Groq/HF/OllamaCloud -> standard generation with more tokens
    if (assignment.provider === 'groq' || assignment.provider === 'huggingface' || assignment.provider === 'ollama-cloud') {
      return await this.generate({
        ...options,
        maxTokens: options.maxTokens || 6000
      });
    }

    return await super.generateWithReasoning(options);
  }

  /**
   * Override generateFast
   * Falls back to parent
   */
  async generateFast(options = {}) {
    const assignment = this.getModelAssignment(options.component, options.purpose);
    
    // If no assignment -> use parent
    if (!assignment) {
      return await super.generateFast(options);
    }
    
    // If OpenAI/Codex assignment -> use parent with model override
    if (assignment.provider === 'openai' || assignment.provider === 'openai-codex') {
      options = { ...options, model: assignment.model };
      this.logger?.debug('Model override for fast generation', {
        component: options.component,
        purpose: options.purpose,
        model: assignment.model
      });
      return await super.generateFast(options);
    }

    // If local -> use local client's fast generation
    if (assignment.provider === 'local' && this.localClient) {
      return await this.localClient.generateFast({
        ...options,
        model: assignment.model
      });
    }

    // Groq/HF/OllamaCloud -> use fast settings via chat client
    if (assignment.provider === 'groq' || assignment.provider === 'huggingface' || assignment.provider === 'ollama-cloud') {
      return await this.generate({
        ...options,
        maxTokens: options.maxTokens || 1000,
        reasoningEffort: 'low'
      });
    }

    // Other providers -> use with fast settings
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
}

module.exports = { UnifiedClient };
