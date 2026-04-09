/**
 * Provider Abstraction Layer for COSMO IDE
 * 
 * Model-agnostic provider system supporting:
 * - Anthropic (Claude) with OAuth stealth mode
 * - OpenAI (GPT-4o, GPT-5+) with Responses API support
 * - xAI (Grok) via OpenAI-compatible API
 * - Ollama for local embeddings (Mac only, skipped on Pi)
 * 
 * Usage:
 * ```javascript
 * const { createRegistry } = require('./providers');
 * 
 * // Create and initialize the registry
 * const registry = await createRegistry();
 * 
 * // Get provider for a model
 * const provider = registry.getProvider('claude-sonnet-4-5');
 * 
 * // Use the provider
 * const response = await provider.createMessage({
 *   model: 'claude-sonnet-4-5',
 *   messages: [{ role: 'user', content: 'Hello!' }]
 * });
 * ```
 */

// Platform detection
const { getPlatform } = require('../config/platform.js');
const {
  loadModelCatalogSync,
  getCatalogDefaults
} = require('../config/model-catalog.js');

// Types
const unified = require('./types/unified.js');

// Adapters
const { ProviderAdapter } = require('./adapters/base.js');
const { AnthropicAdapter, createAnthropicAdapterWithOAuth } = require('./adapters/anthropic.js');
const { OpenAIAdapter, createOpenAIAdapter, shouldUseResponsesAPI } = require('./adapters/openai.js');
const { OllamaAdapter, createOllamaAdapter } = require('./adapters/ollama.js');
const { decryptConfigSecrets } = require('../../lib/encryption');

// Registry
const { ProviderRegistry } = require('./registry.js');

/**
 * Detect if Ollama is running at the given URL
 * @param {string} [baseUrl] - Ollama base URL (default: http://localhost:11434)
 * @param {number} [timeoutMs=1000] - Timeout in milliseconds
 * @returns {Promise<boolean>}
 */
async function detectOllama(baseUrl = 'http://localhost:11434', timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function normalizeOllamaBaseUrl(baseUrl = 'http://localhost:11434') {
  return String(baseUrl || 'http://localhost:11434').replace(/\/v1\/?$/i, '');
}

/**
 * Load COSMO 2.3 config from ~/.cosmo2.3/config.json
 * @returns {Promise<Object|null>}
 */
async function loadCosmoConfig() {
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const configPath = process.env.COSMO23_CONFIG_PATH || path.join(os.homedir(), '.cosmo2.3', 'config.json');
    
    if (!fs.existsSync(configPath)) {
      return null;
    }
    
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return decryptConfigSecrets(parsed);
  } catch (err) {
    console.warn('[Providers] ⚠️ Failed to load COSMO config:', err.message);
    return null;
  }
}

/**
 * Create a fully-initialized provider registry for COSMO IDE
 * 
 * This helper:
 * 1. Initializes Anthropic with COSMO IDE's OAuth service
 * 2. Initializes OpenAI from environment
 * 3. Initializes xAI (Grok) from environment
 * 4. Detects and optionally initializes Ollama
 * 
 * @param {Object} [options]
 * @param {boolean} [options.detectOllama=true] - Auto-detect Ollama
 * @param {boolean} [options.useAnthropicOAuth=true] - Use COSMO IDE's OAuth service
 * @returns {Promise<ProviderRegistry>}
 */
async function createRegistry(options = {}) {
  const registry = new ProviderRegistry();
  const detectOllamaEnabled = options.detectOllama !== false;
  const useAnthropicOAuth = options.useAnthropicOAuth !== false;
  const modelCatalog = loadModelCatalogSync();
  const modelDefaults = getCatalogDefaults(modelCatalog);

  // Initialize Anthropic (OAuth-only)
  if (useAnthropicOAuth) {
    try {
      const anthropicAdapter = createAnthropicAdapterWithOAuth();
      registry.register(anthropicAdapter);
      console.log('[Providers] ✅ Anthropic registered (OAuth service)');
    } catch (e) {
      console.warn('[Providers] ⚠️ Anthropic OAuth not available:', e.message);
    }
  }

  // Initialize OpenAI
  if (process.env.OPENAI_API_KEY) {
    registry.initializeProvider('openai', { apiKey: process.env.OPENAI_API_KEY });
    console.log('[Providers] ✅ OpenAI registered');
  } else {
    console.warn('[Providers] ⚠️ OPENAI_API_KEY not set, OpenAI provider unavailable');
  }

  // OpenAI Codex (OAuth)
  // Codex uses the standard OpenAI API with OAuth JWT auth (not sk- keys).
  // Dynamic model discovery with seed list fallback.
  try {
    const codexOAuth = require('../services/openai-codex-oauth');
    const codexCreds = await codexOAuth.getCodexCredentials();
    if (codexCreds) {
      const codexAdapter = registry.initializeProvider('openai-codex', {
        apiKey: codexCreds.accessToken,
        baseUrl: 'https://chatgpt.com/backend-api',
        defaultHeaders: {
          'chatgpt-account-id': codexCreds.accountId || '',
          'oai-language': 'en-US',
        }
      });
      console.log('[Providers] ✅ OpenAI Codex registered (OAuth)');

      // Attempt dynamic model discovery (5-min TTL cache)
      try {
        if (codexAdapter && codexAdapter.listModels) {
          const discoveredModels = await codexAdapter.listModels();
          if (discoveredModels && discoveredModels.length > 0) {
            registry._codexDiscoveredModels = discoveredModels;
            registry._codexDiscoveryTime = Date.now();
            console.log(`[Providers] ✅ Codex model discovery: ${discoveredModels.length} models`);
          }
        }
      } catch (discoveryErr) {
        console.log('[Providers] ℹ️ Codex model discovery unavailable, using seed list');
      }
    } else {
      console.log('[Providers] ℹ️ OpenAI Codex not configured (no OAuth token)');
    }
  } catch (e) {
    console.log('[Providers] ℹ️ OpenAI Codex OAuth not available:', e.message);
  }

  // Load COSMO config for provider + local LLM settings
  const cosmoConfig = await loadCosmoConfig();

  // Initialize xAI (Grok)
  const xaiKey = process.env.XAI_API_KEY || cosmoConfig?.providers?.xai?.api_key;
  if (xaiKey) {
    registry.initializeProvider('xai', {
      apiKey: xaiKey,
      baseUrl: 'https://api.x.ai/v1'
    });
    console.log('[Providers] ✅ xAI (Grok) registered');
  }
  // Initialize Ollama Cloud
  const ollamaCloudKey = process.env.OLLAMA_CLOUD_API_KEY
    || cosmoConfig?.providers?.['ollama-cloud']?.api_key;
  if (ollamaCloudKey) {
    registry.initializeProvider('ollama-cloud', { apiKey: ollamaCloudKey });
    console.log('[Providers] ✅ Ollama Cloud registered');
  } else {
    console.log('[Providers] ℹ️ Ollama Cloud not configured (set OLLAMA_CLOUD_API_KEY or providers.ollama-cloud.api_key in config)');
  }

  const ollamaConfig = cosmoConfig?.providers?.ollama || { enabled: true, auto_detect: true, base_url: 'http://localhost:11434' };
  
  // Detect and initialize Ollama (for embeddings + chat)
  // NOTE: On Raspberry Pi we still want to support *remote* Ollama (e.g. Mac mini inference).
  const platform = getPlatform();
  const ollamaBaseUrl = normalizeOllamaBaseUrl(ollamaConfig.base_url || 'http://localhost:11434');
  const isRemoteOllama = !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/i.test(ollamaBaseUrl);
  const forceEnableOllamaOnPi = platform.platform === 'pi' && (ollamaConfig.force_enable_on_pi === true);

  if (platform.supportsLocalModels || isRemoteOllama || forceEnableOllamaOnPi) {
    // Ollama
    if (ollamaConfig.enabled !== false) {
      const shouldAutoDetect = ollamaConfig.auto_detect !== false && detectOllamaEnabled;

      if (shouldAutoDetect) {
        const ollamaAvailable = await detectOllama(ollamaBaseUrl);
        if (ollamaAvailable) {
          registry.initializeProvider('ollama', {
            baseUrl: ollamaBaseUrl,
            embeddingModel: modelDefaults.local.embeddings
          });
          console.log(`[Providers] ✅ Ollama detected at ${ollamaBaseUrl} - models available`);
        } else {
          console.log(`[Providers] ℹ️ Ollama not detected at ${ollamaBaseUrl}`);
        }
      } else if (!shouldAutoDetect && ollamaConfig.enabled) {
        registry.initializeProvider('ollama', {
          baseUrl: ollamaBaseUrl,
          embeddingModel: modelDefaults.local.embeddings
        });
        console.log(`[Providers] ✅ Ollama configured at ${ollamaBaseUrl} (auto-detect disabled)`);
      }
    } else {
      console.log('[Providers] ℹ️ Ollama disabled in config');
    }

  } else if (detectOllamaEnabled && !platform.supportsLocalModels) {
    console.log(`[Providers] ℹ️ Skipping local models on ${platform.platform} (not supported; set providers.ollama.base_url to a remote host to enable)`);
  }

  return registry;
}

/**
 * Singleton registry instance
 * @type {ProviderRegistry|null}
 */
let defaultRegistry = null;

/**
 * Get or create the default registry
 * @param {Object} [options]
 * @returns {Promise<ProviderRegistry>}
 */
async function getDefaultRegistry(options) {
  if (!defaultRegistry) {
    defaultRegistry = await createRegistry(options);
  }
  return defaultRegistry;
}

/**
 * Reset the default registry (useful for testing)
 */
function resetDefaultRegistry() {
  defaultRegistry = null;
}

module.exports = {
  // Registry
  ProviderRegistry,
  createRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  
  // Adapters
  ProviderAdapter,
  AnthropicAdapter,
  OpenAIAdapter,
  OllamaAdapter,
  
  // Factory functions
  createAnthropicAdapterWithOAuth,
  createOpenAIAdapter,
  createOllamaAdapter,
  
  // Utilities
  detectOllama,
  shouldUseResponsesAPI,
  
  // Platform detection
  getPlatform,
  
  // Types and constants
  ...unified
};
