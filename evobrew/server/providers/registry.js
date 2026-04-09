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
const {
  buildModelAliases,
  sortDiscoveredModels
} = require('./model-catalog.js');
const {
  parseModelSelection,
  qualifyModelSelection
} = require('../../lib/model-selection.js');

/**
 * @typedef {import('./adapters/base.js').ProviderAdapter} ProviderAdapter
 */

class ProviderRegistry {
  constructor() {
    /** @type {Map<string, ProviderAdapter>} */
    this.providers = new Map();

    /** @type {Map<string, string>} */
    this.modelMap = new Map();

    /** @type {Map<string, Set<string>>} */
    this.providerModels = new Map();

    /** @type {Map<string, Function>} */
    this.adapterFactories = new Map();

    /** @type {Map<string, Map<string, {id:string,label:string,target:string}>>} */
    this.aliasMap = new Map();

    // Register built-in adapter factories
    this._registerBuiltinFactories();
  }

  /**
   * Register built-in adapter factories
   * @private
   */
  _registerBuiltinFactories() {
    this.adapterFactories.set('anthropic', (config) => new AnthropicAdapter({
      ...config,
      providerId: 'anthropic'
    }));
    this.adapterFactories.set('openai', (config) => new OpenAIAdapter({
      ...config,
      providerId: 'openai'
    }));
    this.adapterFactories.set('ollama', (config) => new OllamaAdapter(config));
    // xAI uses OpenAI adapter with different base URL and custom ID
    this.adapterFactories.set('xai', (config) => {
      const adapter = new OpenAIAdapter({
        ...config,
        providerId: 'xai',
        baseUrl: config.baseUrl || 'https://api.x.ai/v1',
        seedModels: [
          'grok-4-latest',
          'grok-4.20-non-reasoning-latest',
          'grok-4.20-reasoning-latest',
          'grok-4.20-multi-agent-latest',
          'grok-4-fast-reasoning-latest',
          'grok-code-fast-1'
        ],
        modelFilter: (modelId) => String(modelId || '').toLowerCase().startsWith('grok')
      });
      // Override ID for routing
      Object.defineProperty(adapter, 'id', { value: 'xai', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'xAI (Grok)', writable: false });
      return adapter;
    });

    // OpenAI Codex via ChatGPT OAuth - uses OpenAI adapter with Codex endpoint
    this.adapterFactories.set('openai-codex', (config) => {
      const adapter = new OpenAIAdapter({
        ...config,
        providerId: 'openai-codex',
        baseUrl: config.baseUrl || 'https://chatgpt.com/backend-api',
        seedModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'],
        modelFilter: (modelId) => /gpt|codex/i.test(String(modelId || '')),
        discoveryEnabled: false
      });
      // Override ID for routing
      Object.defineProperty(adapter, 'id', { value: 'openai-codex', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'OpenAI Codex (OAuth)', writable: false });
      return adapter;
    });

    // Ollama Cloud — OpenAI-compatible API at ollama.com/v1
    // Uses dynamic model discovery so new models appear without code changes
    this.adapterFactories.set('ollama-cloud', (config) => {
      const adapter = new OpenAIAdapter({
        ...config,
        providerId: 'ollama-cloud',
        baseUrl: 'https://ollama.com/v1',
        seedModels: [
          'nemotron-3-super',
          'nemotron-3-nano:30b',
          'minimax-m2.7',
          'kimi-k2.5',
          'qwen3.5:397b',
          'qwen3-next:80b',
          'deepseek-v3.1:671b',
          'cogito-2.1:671b',
          'kimi-k2-thinking',
          'gemma3:12b',
          'devstral-small-2:24b',
          'gpt-oss:20b',
          'glm-5'
        ],
        modelFilter: (modelId) => {
          const normalized = String(modelId || '').toLowerCase();
          return !normalized.includes('embed');
        }
      });
      Object.defineProperty(adapter, 'id', { value: 'ollama-cloud', writable: false });
      Object.defineProperty(adapter, 'name', { value: 'Ollama Cloud', writable: false });

      return adapter;
    });

    // Local Agents — HTTP-based agents configured in config.json
    this.adapterFactories.set('local-agent', (config) => {
      const { LocalAgentAdapter } = require('./adapters/local-agent.js');
      return new LocalAgentAdapter(config);
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
    this._registerProviderModels(adapter.id, adapter.getAvailableModels());
  }

  /**
   * Register a model-to-provider mapping
   * @param {string} modelId
   * @param {string} providerId
   */
  registerModel(modelId, providerId) {
    const rawModelId = String(modelId || '').trim();
    const provider = String(providerId || '').trim();
    if (!rawModelId || !provider) return;

    this.modelMap.set(qualifyModelSelection(provider, rawModelId), provider);
    if (!this.modelMap.has(rawModelId)) {
      this.modelMap.set(rawModelId, provider);
    }

    if (!this.providerModels.has(provider)) {
      this.providerModels.set(provider, new Set());
    }
    this.providerModels.get(provider).add(rawModelId);
  }

  _registerProviderModels(providerId, models = []) {
    const sortedModels = sortDiscoveredModels(providerId, models);
    for (const model of sortedModels) {
      this.registerModel(model, providerId);
    }
    this._updateAliases(providerId, sortedModels);
  }

  _getKnownModelsForProvider(providerId) {
    const known = this.providerModels.get(providerId);
    if (known && known.size > 0) {
      return sortDiscoveredModels(providerId, Array.from(known));
    }

    const adapter = this.providers.get(providerId);
    if (adapter) {
      return sortDiscoveredModels(providerId, adapter.getAvailableModels());
    }

    const models = [];
    for (const [modelId, mappedProviderId] of this.modelMap.entries()) {
      if (mappedProviderId !== providerId) continue;
      if (String(modelId || '').startsWith('latest')) continue;
      models.push(modelId);
    }
    return sortDiscoveredModels(providerId, models);
  }

  _updateAliases(providerId, models = []) {
    const aliases = buildModelAliases(providerId, models);
    const aliasEntries = new Map();
    for (const alias of aliases) {
      aliasEntries.set(alias.id, alias);
    }
    this.aliasMap.set(providerId, aliasEntries);
  }

  getAliasesForProvider(providerId) {
    const existing = this.aliasMap.get(providerId);
    if (!existing || existing.size === 0) {
      const knownModels = this._getKnownModelsForProvider(providerId);
      if (knownModels.length > 0) {
        this._updateAliases(providerId, knownModels);
      }
    }
    return Array.from(this.aliasMap.get(providerId)?.values() || []);
  }

  async refreshProviderModels(providerId, options = {}) {
    const adapter = this.getProviderById(providerId);
    if (!adapter) return [];

    const models = typeof adapter.listModels === 'function'
      ? await adapter.listModels(options)
      : adapter.getAvailableModels();

    if (Array.isArray(models) && models.length > 0) {
      this._registerProviderModels(providerId, models);
      return sortDiscoveredModels(providerId, models);
    }

    const fallbackModels = adapter.getAvailableModels();
    this._registerProviderModels(providerId, fallbackModels);
    return sortDiscoveredModels(providerId, fallbackModels);
  }

  async refreshModelCatalog(options = {}) {
    for (const providerId of this.getProviderIds()) {
      await this.refreshProviderModels(providerId, options);
    }
  }

  async resolveModelSelection(selection, options = {}) {
    const parsed = parseModelSelection(selection);
    let providerId = parsed.providerId || this.parseProviderId(parsed.modelId);
    if (!providerId) {
      return {
        selection: parsed.selection,
        providerId: null,
        modelId: parsed.modelId,
        resolvedModel: parsed.modelId,
        resolvedSelection: parsed.selection || parsed.modelId,
        provider: null,
        aliasId: null
      };
    }

    let provider = this.getProviderById(providerId) || this.getProvider(selection);
    const knownModels = this._getKnownModelsForProvider(providerId);
    const aliasEntry = this.getAliasesForProvider(providerId).find((alias) => alias.id === parsed.modelId) || null;

    if (!provider && aliasEntry?.target) {
      return {
        selection: parsed.selection,
        providerId,
        modelId: parsed.modelId,
        resolvedModel: aliasEntry.target,
        resolvedSelection: qualifyModelSelection(providerId, aliasEntry.target),
        provider: null,
        aliasId: aliasEntry.id
      };
    }

    if (!provider) {
      return {
        selection: parsed.selection,
        providerId,
        modelId: parsed.modelId,
        resolvedModel: parsed.modelId,
        resolvedSelection: parsed.qualified ? parsed.selection : qualifyModelSelection(providerId, parsed.modelId),
        provider: null,
        aliasId: null
      };
    }

    const aliasMap = this.aliasMap.get(providerId);
    if (aliasMap?.has(parsed.modelId)) {
      await this.refreshProviderModels(providerId, options);
      const refreshedAlias = this.aliasMap.get(providerId)?.get(parsed.modelId);
      if (refreshedAlias?.target) {
        return {
          selection: parsed.selection,
          providerId,
          modelId: parsed.modelId,
          resolvedModel: refreshedAlias.target,
          resolvedSelection: qualifyModelSelection(providerId, refreshedAlias.target),
          provider,
          aliasId: refreshedAlias.id
        };
      }
    }

    if (!parsed.qualified && !provider.supportsModel(parsed.modelId) && typeof provider.listModels === 'function') {
      await this.refreshProviderModels(providerId, options);
      provider = this.getProviderById(providerId) || provider;
    }

    return {
      selection: parsed.selection,
      providerId,
      modelId: parsed.modelId,
      resolvedModel: parsed.modelId,
      resolvedSelection: parsed.qualified ? parsed.selection : qualifyModelSelection(providerId, parsed.modelId),
      provider,
      aliasId: null
    };
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
    // Local agents use "local:" prefix
    if (modelId.startsWith('local:')) {
      return modelId;
    }

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
    if (modelId.startsWith('gemini')) {
      return 'google';
    }
    // Ollama Cloud models — hosted at ollama.com (not local)
    if (modelId.startsWith('nemotron') ||
        modelId.startsWith('kimi-k2') ||
        modelId.startsWith('cogito') ||
        modelId.startsWith('minimax') ||
        modelId.startsWith('devstral') ||
        modelId.startsWith('gpt-oss') ||
        modelId.startsWith('glm-')) {
      return 'ollama-cloud';
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
    const factoryKey = providerId.startsWith('local:') ? 'local-agent' : providerId;
    const factory = this.adapterFactories.get(factoryKey);
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
    this.providerModels.delete(providerId);
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
   * @returns {Object[]} Array of { id, provider, value, label }
   */
  listModels(options = {}) {
    const includeAliases = options.includeAliases !== false;
    const models = [];
    const seen = new Set();
    const providerIds = new Set([
      ...this.providers.keys(),
      ...Array.from(this.modelMap.values())
    ]);

    for (const providerId of providerIds) {
      const adapter = this.providers.get(providerId);
      const providerName = adapter ? adapter.name : providerId;
      const knownModels = this._getKnownModelsForProvider(providerId);

      if (includeAliases) {
        for (const alias of this.getAliasesForProvider(providerId)) {
          const aliasValue = qualifyModelSelection(providerId, alias.id);
          models.push({
            id: alias.id,
            provider: providerId,
            value: aliasValue,
            label: this._formatAliasLabel(alias.target, providerName),
            isAlias: true,
            channelLabel: alias.label,
            resolvedModel: alias.target
          });
          seen.add(aliasValue);
        }
      }

      for (const modelId of knownModels) {
        const selectionValue = qualifyModelSelection(providerId, modelId);
        models.push({
          id: modelId,
          provider: providerId,
          value: selectionValue,
          label: this._formatModelLabel(modelId, providerName)
        });
        seen.add(selectionValue);
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
    const normalizedProviderName = String(providerName || '').replace(/\s*\([^)]*\)\s*/g, '').trim();
    const normalizedModelId = String(modelId || '').trim();
    if (!normalizedModelId) return normalizedProviderName || '';

    let label = normalizedModelId
      .replace(/-\d{8}$/, '')
      .replace(/(?<=\d)-(?=\d)/g, '.')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    label = label
      .replace(/\bGpt\b/g, 'GPT')
      .replace(/\bApi\b/g, 'API')
      .replace(/\bOauth\b/g, 'OAuth')
      .replace(/\bXai\b/g, 'xAI')
      .replace(/\bMoe\b/g, 'MoE')
      .replace(/\bOss\b/g, 'OSS')
      .replace(/\bGlm\b/g, 'GLM')
      .replace(/\bMinimax\b/g, 'MiniMax')
      .replace(/\bNemotron\b/g, 'Nemotron')
      .replace(/\bQwen(\d(?:\.\d+)*)\b/g, 'Qwen $1')
      .replace(/\bDeepseek\b/g, 'DeepSeek')
      .replace(/\bGemma(\d(?:\.\d+)*)\b/g, 'Gemma $1')
      .replace(/\bDevstral Small (\d(?:\.\d+)*)\b/g, 'Devstral Small $1')
      .replace(/\bKimi K(\d(?:\.\d+)*) Thinking\b/g, 'Kimi K$1 Thinking')
      .replace(/\bKimi K(\d(?:\.\d+)*)\b/g, 'Kimi K$1')
      .replace(/\bClaude Sonnet (\d(?:\.\d+)*)\b/g, 'Claude Sonnet $1')
      .replace(/\bClaude Opus (\d(?:\.\d+)*)\b/g, 'Claude Opus $1')
      .replace(/\bClaude Haiku (\d(?:\.\d+)*)\b/g, 'Claude Haiku $1')
      .replace(/\bGrok (\d(?:\.\d+)*) Multi Agent\b/g, 'Grok $1 Multi-Agent')
      .replace(/\bGrok (\d(?:\.\d+)*) Non Reasoning\b/g, 'Grok $1 Non-Reasoning')
      .replace(/\bGrok (\d(?:\.\d+)*) Reasoning\b/g, 'Grok $1 Reasoning')
      .replace(/\bGrok (\d(?:\.\d+)*) Latest\b/g, 'Grok $1')
      .replace(/\bGPT (\d(?:\.\d+)*)\b/g, 'GPT-$1');

    return label;
  }

  _formatAliasLabel(resolvedModel, providerName) {
    return this._formatModelLabel(resolvedModel, providerName);
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

      const aliasTarget = this.aliasMap.get(assignment.provider)?.get(modelId)?.target;
      if (aliasTarget) {
        modelId = aliasTarget;
      }

      // Try fallback if primary unavailable or fails health check
      if (!provider && assignment.fallback) {
        console.log(`[Registry] Primary provider unavailable, trying fallback: ${assignment.fallback}`);
        const [fallbackProvider, fallbackModel] = assignment.fallback.split('/');
        provider = this.getProviderById(fallbackProvider);
        modelId = this.aliasMap.get(fallbackProvider)?.get(fallbackModel)?.target || fallbackModel;
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
    return this.providers.has('ollama') ||
           Array.from(this.providers.values()).some(p =>
             p.capabilities?.reducedParallelism === true
           );
  }
}

module.exports = { ProviderRegistry };
