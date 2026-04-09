/**
 * Provider Registry
 *
 * Central registry for provider adapters. Routes model identifiers to the
 * appropriate provider and manages provider lifecycle.
 * 
 * Simplified from COZMO's version - no ProviderFactory or profile rotation.
 */

const { AnthropicAdapter } = require('./adapters/anthropic.js');
const { OpenAIAdapter } = require('./adapters/openai.js');
const { OllamaAdapter } = require('./adapters/ollama.js');
const { loadModelCatalogSync, listCatalogModels } = require('../config/model-catalog.js');

/**
 * @typedef {import('./adapters/base.js').ProviderAdapter} ProviderAdapter
 */

class ProviderRegistry {
  constructor() {
    /** @type {Map<string, ProviderAdapter>} */
    this.providers = new Map();

    /** @type {Map<string, string>} */
    this.modelMap = new Map();

    /** @type {Map<string, Function>} */
    this.adapterFactories = new Map();

    // Register built-in adapter factories
    this._registerBuiltinFactories();
  }

  /**
   * Register built-in adapter factories
   * @private
   */
  _registerBuiltinFactories() {
    this.adapterFactories.set('anthropic', (config) => new AnthropicAdapter(config));
    this.adapterFactories.set('openai', (config) => new OpenAIAdapter(config));
    this.adapterFactories.set('ollama', (config) => new OllamaAdapter(config));
    // xAI uses OpenAI adapter with different base URL and custom ID
    this.adapterFactories.set('xai', (config) => {
      const adapter = new OpenAIAdapter({
        ...config,
        baseUrl: config.baseUrl || 'https://api.x.ai/v1'
      });
      // Override ID for routing
      Object.defineProperty(adapter, 'id', { value: 'xai', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'xAI (Grok)', writable: false });
      // Override available models for xAI
      adapter.getAvailableModels = () => listCatalogModels(loadModelCatalogSync(), {
        providers: ['xai'],
        kind: 'chat'
      }).map(model => model.id);
      return adapter;
    });

    // OpenAI Codex via ChatGPT OAuth - uses OpenAI adapter with ChatGPT backend
    this.adapterFactories.set('openai-codex', (config) => {
      const adapter = new OpenAIAdapter({
        ...config,
        baseUrl: config.baseUrl || 'https://chatgpt.com/backend-api'
      });
      // Override ID for routing
      Object.defineProperty(adapter, 'id', { value: 'openai-codex', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'OpenAI Codex (OAuth)', writable: false });
      // Override available models for Codex
      adapter.getAvailableModels = () => ['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'];
      return adapter;
    });

    // Ollama Cloud — OpenAI-compatible API at ollama.com/v1
    // Uses dynamic model discovery so new models appear without code changes
    this.adapterFactories.set('ollama-cloud', (config) => {
      const adapter = new OpenAIAdapter({
        ...config,
        baseUrl: 'https://ollama.com/v1'
      });
      Object.defineProperty(adapter, 'id', { value: 'ollama-cloud', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'Ollama Cloud', writable: false });

      // Seed list — used as fallback if live fetch fails
      const seedModels = [
        'nemotron-3-super',
        'nemotron-3-nano:30b',
        'qwen3.5:397b',
        'qwen3-next:80b',
        'deepseek-v3.1:671b',
        'cogito-2.1:671b',
        'kimi-k2:1t',
        'kimi-k2-thinking',
        'gemma3:12b',
        'devstral-small-2:24b',
        'gpt-oss:20b',
        'minimax-m2.5',
        'glm-5',
      ];
      const discoveryTtlMs = 5 * 60 * 1000;
      let cachedModels = seedModels.slice();
      let cacheExpiresAt = 0;
      let inFlightListModels = null;
      adapter.getAvailableModels = () => cachedModels.slice();

      // Dynamic discovery: fetch live model list from ollama.com/v1/models
      adapter.listModels = async () => {
        const now = Date.now();
        if (cacheExpiresAt > now && cachedModels.length > 0) {
          return cachedModels.slice();
        }
        if (inFlightListModels) {
          return inFlightListModels;
        }

        inFlightListModels = (async () => {
          try {
            const OpenAI = require('openai');
            const client = new OpenAI({
              apiKey: config.apiKey,
              baseURL: 'https://ollama.com/v1'
            });
            const response = await client.models.list();
            const ids = (response.data || []).map(m => m.id).filter(Boolean);
            cachedModels = ids.length > 0 ? ids : seedModels.slice();
            cacheExpiresAt = Date.now() + discoveryTtlMs;
            return cachedModels.slice();
          } catch (err) {
            const fallbackModels = cachedModels.length > 0 ? cachedModels : seedModels;
            cacheExpiresAt = Date.now() + discoveryTtlMs;
            console.warn('[OllamaCloud] Dynamic model fetch failed, using cached/seed list:', err.message);
            return fallbackModels.slice();
          } finally {
            inFlightListModels = null;
          }
        })();

        return inFlightListModels;
      };

      return adapter;
    });

    // LMStudio uses OpenAI adapter with local URL and custom ID
    this.adapterFactories.set('lmstudio', (config) => {
      const adapter = new OpenAIAdapter({
        apiKey: 'not-needed',  // LMStudio doesn't require API key
        baseUrl: config.baseUrl || 'http://localhost:1234/v1'
      });
      // Override ID for routing
      Object.defineProperty(adapter, 'id', { value: 'lmstudio', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'LMStudio', writable: false });
      // Set reduced parallelism for local models
      const originalCaps = adapter.capabilities;
      Object.defineProperty(adapter, 'capabilities', {
        get: () => ({ ...originalCaps, reducedParallelism: true })
      });
      // Dynamic model discovery - models loaded in LMStudio
      adapter.getAvailableModels = () => [];  // Will be populated by listModels()
      return adapter;
    });
  }

  /**
   * Register a provider adapter
   * @param {ProviderAdapter} adapter
   */
  register(adapter) {
    this.providers.set(adapter.id, adapter);

    // Auto-register all models from the adapter
    for (const model of adapter.getAvailableModels()) {
      this.registerModel(model, adapter.id);
    }
  }

  /**
   * Register a model-to-provider mapping
   * @param {string} modelId
   * @param {string} providerId
   */
  registerModel(modelId, providerId) {
    this.modelMap.set(modelId, providerId);
  }

  /**
   * Get a provider adapter by ID
   * @param {string} providerId
   * @returns {ProviderAdapter|undefined}
   */
  getProviderById(providerId) {
    return this.providers.get(providerId);
  }

  /**
   * Get the provider for a model
   * @param {string} modelId - Model identifier (e.g., 'claude-sonnet-4-20250514' or 'anthropic/claude-sonnet-4')
   * @returns {ProviderAdapter|undefined}
   */
  getProvider(modelId) {
    // Check explicit mapping first
    const mappedProvider = this.modelMap.get(modelId);
    if (mappedProvider) {
      return this.providers.get(mappedProvider);
    }

    // Parse provider from model ID if prefixed
    const providerId = this.parseProviderId(modelId);
    if (providerId) {
      return this.providers.get(providerId);
    }

    // Try to find a provider that supports this model
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(modelId)) {
        return provider;
      }
    }

    return undefined;
  }

  /**
   * Parse provider ID from a model identifier
   * @param {string} modelId
   * @returns {string|null}
   */
  parseProviderId(modelId) {
    // Handle prefixed format: "anthropic/claude-sonnet-4"
    if (modelId.includes('/')) {
      return modelId.split('/')[0];
    }

    // Heuristics for unprefixed model names
    if (modelId.startsWith('claude') || modelId.includes('claude')) {
      return 'anthropic';
    }
    if (modelId.startsWith('gpt') || modelId.includes('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
      return 'openai';
    }
    if (modelId.startsWith('grok')) {
      return 'xai';
    }
    // Ollama Cloud models — hosted at ollama.com (not local)
    if (modelId.startsWith('nemotron') ||
        modelId.startsWith('kimi-k') ||
        modelId.startsWith('cogito') ||
        modelId.startsWith('minimax') ||
        modelId.startsWith('devstral') ||
        modelId.startsWith('gpt-oss') ||
        modelId.startsWith('glm-') ||
        modelId.startsWith('gemma4') ||
        modelId.startsWith('rnj-') ||
        modelId.startsWith('ministral')) {
      return 'ollama-cloud';
    }
    if (modelId.startsWith('gemini')) {
      return 'google';
    }

    // Ollama models - both chat and embedding models
    if (modelId.startsWith('llama') ||
        modelId.startsWith('mistral') ||
        modelId.startsWith('mixtral') ||
        modelId.startsWith('codellama') ||
        modelId.startsWith('deepseek') ||
        modelId.startsWith('qwen') ||
        modelId.startsWith('nomic') ||
        modelId.startsWith('mxbai') ||
        modelId.startsWith('all-minilm') ||
        modelId.includes(':')) {  // Ollama format like "qwen2.5:14b"
      return 'ollama';
    }

    return null;
  }

  /**
   * Extract the model name from a prefixed model ID
   * @param {string} modelId - e.g., 'anthropic/claude-sonnet-4-20250514'
   * @returns {string} - e.g., 'claude-sonnet-4-20250514'
   */
  extractModelName(modelId) {
    if (modelId.includes('/')) {
      return modelId.split('/').slice(1).join('/');
    }
    return modelId;
  }

  /**
   * Create a provider adapter from config
   * @param {string} providerId
   * @param {Object} config
   * @returns {ProviderAdapter}
   */
  createAdapter(providerId, config) {
    const factory = this.adapterFactories.get(providerId);
    if (!factory) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return factory(config);
  }

  /**
   * Initialize and register a provider
   * @param {string} providerId
   * @param {Object} config
   * @returns {ProviderAdapter}
   */
  initializeProvider(providerId, config) {
    const adapter = this.createAdapter(providerId, config);
    this.register(adapter);
    return adapter;
  }

  /**
   * Get all registered providers
   * @returns {ProviderAdapter[]}
   */
  getAllProviders() {
    return Array.from(this.providers.values());
  }

  /**
   * Get all registered provider IDs
   * @returns {string[]}
   */
  getProviderIds() {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider is registered
   * @param {string} providerId
   * @returns {boolean}
   */
  hasProvider(providerId) {
    return this.providers.has(providerId);
  }

  /**
   * Unregister a provider
   * @param {string} providerId
   */
  unregister(providerId) {
    const adapter = this.providers.get(providerId);
    if (adapter) {
      // Remove model mappings for this provider
      for (const [model, provider] of this.modelMap.entries()) {
        if (provider === providerId) {
          this.modelMap.delete(model);
        }
      }
      this.providers.delete(providerId);
    }
  }

  /**
   * Get health status of all providers
   * @returns {Promise<Object[]>}
   */
  async healthCheck() {
    const results = [];
    for (const adapter of this.providers.values()) {
      const health = await adapter.healthCheck();
      results.push(health);
    }
    return results;
  }

  /**
   * Get capabilities of all providers
   * @returns {Object}
   */
  getCapabilities() {
    const caps = {};
    for (const [id, adapter] of this.providers.entries()) {
      caps[id] = adapter.capabilities;
    }
    return caps;
  }

  /**
   * List all available models across all providers
   * @returns {Object[]} Array of { id, provider, label }
   */
  listModels() {
    const models = [];
    const seen = new Set();
    for (const [providerId, adapter] of this.providers.entries()) {
      for (const modelId of adapter.getAvailableModels()) {
        models.push({
          id: modelId,
          provider: providerId,
          label: this._formatModelLabel(modelId, adapter.name)
        });
        seen.add(modelId);
      }
    }
    // Include models registered via registerModel() that weren't listed by their adapter
    for (const [modelId, providerId] of this.modelMap.entries()) {
      if (!seen.has(modelId)) {
        const adapter = this.providers.get(providerId);
        const providerName = adapter ? adapter.name : providerId;
        models.push({
          id: modelId,
          provider: providerId,
          label: this._formatModelLabel(modelId, providerName)
        });
      }
    }
    return models;
  }

  /**
   * Format a user-friendly model label
   * @param {string} modelId
   * @param {string} providerName
   * @returns {string}
   * @private
   */
  _formatModelLabel(modelId, providerName) {
    // Remove date suffixes and format nicely
    let label = modelId
      .replace(/-\d{8}$/, '')  // Remove date suffixes like -20250514
      .replace(/-/g, ' ')       // Replace dashes with spaces
      .replace(/\b\w/g, c => c.toUpperCase()); // Title case

    return `${label} (${providerName})`;
  }

  /**
   * Get provider based on context and config
   * @param {string} context - Context like 'fast', 'reasoning', 'default'
   * @returns {ProviderAdapter|undefined}
   */
  getProviderForContext(context = 'default') {
    try {
      const config = require('../config/model-config.js');
      const assignment = config.modelAssignments[context] || config.modelAssignments.default;

      if (!assignment) {
        console.warn(`[Registry] No assignment for context: ${context}, using default provider`);
        return this.getProvider('claude-sonnet-4-5');
      }

      // Try primary provider
      let provider = this.getProviderById(assignment.provider);
      let modelId = assignment.model;

      // Try fallback if primary unavailable or fails health check
      if (!provider && assignment.fallback) {
        console.log(`[Registry] Primary provider unavailable, trying fallback: ${assignment.fallback}`);
        const [fallbackProvider, fallbackModel] = assignment.fallback.split('/');
        provider = this.getProviderById(fallbackProvider);
        modelId = fallbackModel;
      }

      if (!provider) {
        console.warn(`[Registry] No provider available for context: ${context}`);
        return this.getProvider('claude-sonnet-4-5');  // Ultimate fallback
      }

      // Register model assignment for later lookups
      if (modelId) {
        this.registerModel(modelId, provider.id);
      }

      return provider;
    } catch (e) {
      console.warn('[Registry] Config error, using default provider:', e.message);
      return this.getProvider('claude-sonnet-4-5');
    }
  }

  /**
   * Check if any registered provider is a local model provider
   * @returns {boolean}
   */
  hasLocalProvider() {
    return this.providers.has('ollama') || this.providers.has('ollama-cloud') ||
           Array.from(this.providers.values()).some(p =>
             p.capabilities?.reducedParallelism === true
           );
  }
}

module.exports = { ProviderRegistry };
