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

// Types
const unified = require('./types/unified.js');

// Adapters
const { ProviderAdapter } = require('./adapters/base.js');
const { AnthropicAdapter, createAnthropicAdapter, createAnthropicAdapterWithOAuth } = require('./adapters/anthropic.js');
const { OpenAIAdapter, createOpenAIAdapter, shouldUseResponsesAPI } = require('./adapters/openai.js');
const { OllamaAdapter, createOllamaAdapter } = require('./adapters/ollama.js');

// Registry
const { ProviderRegistry } = require('./registry.js');

// Decrypt local agent API keys (config encryption doesn't recurse into arrays)
function decryptAgentKey(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('encrypted:')) return value;
  try {
    const { decrypt } = require('../../lib/encryption');
    return decrypt(value);
  } catch (_) {
    return value;
  }
}

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

/**
 * Load evobrew config from ~/.evobrew/config.json
 * @returns {Promise<Object|null>}
 */
async function loadEvobrewConfig() {
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const configPath = path.join(os.homedir(), '.evobrew', 'config.json');
    
    if (!fs.existsSync(configPath)) {
      return null;
    }
    
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[Providers] ⚠️ Failed to load evobrew config:', err.message);
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
  const evobrewConfig = await loadEvobrewConfig();
  const anthropicConfig = evobrewConfig?.providers?.anthropic || {};
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || anthropicConfig.api_key;
  const preferAnthropicOAuth = useAnthropicOAuth && anthropicConfig.oauth !== false;

  // Initialize Anthropic
  // Uses COSMO IDE's existing OAuth service for token management
  if (preferAnthropicOAuth) {
    try {
      const anthropicAdapter = createAnthropicAdapterWithOAuth();
      registry.register(anthropicAdapter);
      console.log('[Providers] ✅ Anthropic registered (OAuth service)');
    } catch (e) {
      console.warn('[Providers] ⚠️ Anthropic OAuth service failed, trying API key:', e.message);
      // Fallback to API key
      if (anthropicApiKey) {
        registry.initializeProvider('anthropic', { apiKey: anthropicApiKey });
        console.log('[Providers] ✅ Anthropic registered (API key)');
      }
    }
  } else if (anthropicApiKey) {
    registry.initializeProvider('anthropic', { apiKey: anthropicApiKey });
    console.log('[Providers] ✅ Anthropic registered (API key)');
  }

  // Initialize OpenAI
  if (process.env.OPENAI_API_KEY) {
    registry.initializeProvider('openai', { apiKey: process.env.OPENAI_API_KEY });
    console.log('[Providers] ✅ OpenAI registered');
  } else {
    console.warn('[Providers] ⚠️ OPENAI_API_KEY not set, OpenAI provider unavailable');
  }

  // OpenAI Codex (ChatGPT OAuth)
  // NOTE: we intentionally DO NOT register a registry provider here.
  // Codex OAuth is served via the legacy Codex client (chatgpt.com/backend-api/codex/responses)
  // because ChatGPT OAuth tokens often lack OpenAI Platform scopes (api.responses.write).
  // We still register the model IDs so the UI can select them.
  // Codex model IDs registered for routing only; listing handled in /api/providers/models handler
  registry.registerModel('gpt-5.4', 'openai-codex');
  registry.registerModel('gpt-5.4-mini', 'openai-codex');
  registry.registerModel('gpt-5.4-nano', 'openai-codex');
  registry.registerModel('gpt-5.2', 'openai-codex');
  registry.registerModel('gpt-5.3-codex', 'openai-codex');
  registry.registerModel('gpt-5.3-codex-spark', 'openai-codex');
  console.log('[Providers] ℹ️ OpenAI Codex models available (OAuth via legacy backend client)');

  // Initialize xAI (Grok)
  const xaiKey = process.env.XAI_API_KEY || evobrewConfig?.providers?.xai?.api_key;
  if (xaiKey) {
    registry.initializeProvider('xai', {
      apiKey: xaiKey,
      baseUrl: 'https://api.x.ai/v1'
    });
    // Register Grok models explicitly
    registry.registerModel('grok-code-fast-1', 'xai');
    registry.registerModel('grok-4-latest', 'xai');
    registry.registerModel('grok-4-fast-reasoning-latest', 'xai');
    registry.registerModel('grok-4.20-non-reasoning-latest', 'xai');
    registry.registerModel('grok-4.20-reasoning-latest', 'xai');
    registry.registerModel('grok-4.20-multi-agent-latest', 'xai');
    console.log('[Providers] ✅ xAI (Grok) registered');
  }
  // Initialize Ollama Cloud
  const ollamaCloudKey = process.env.OLLAMA_CLOUD_API_KEY
    || evobrewConfig?.providers?.['ollama-cloud']?.api_key;
  if (ollamaCloudKey) {
    registry.initializeProvider('ollama-cloud', { apiKey: ollamaCloudKey });
    console.log('[Providers] ✅ Ollama Cloud registered');
  } else {
    console.log('[Providers] ℹ️ Ollama Cloud not configured (run evobrew setup to add)');
  }

  const ollamaConfig = evobrewConfig?.providers?.ollama || { enabled: true, auto_detect: true, base_url: 'http://localhost:11434' };
  const lmstudioConfig = evobrewConfig?.providers?.lmstudio || { enabled: false, base_url: 'http://localhost:1234/v1' };
  
  // Detect and initialize Ollama (for embeddings + chat)
  // NOTE: On Raspberry Pi we still want to support *remote* Ollama (e.g. Mac mini inference).
  const platform = getPlatform();
  const ollamaBaseUrl = ollamaConfig.base_url || 'http://localhost:11434';
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
            embeddingModel: 'nomic-embed-text'
          });
          console.log(`[Providers] ✅ Ollama detected at ${ollamaBaseUrl} - models available`);
        } else {
          console.log(`[Providers] ℹ️ Ollama not detected at ${ollamaBaseUrl}`);
        }
      } else if (!shouldAutoDetect && ollamaConfig.enabled) {
        registry.initializeProvider('ollama', {
          baseUrl: ollamaBaseUrl,
          embeddingModel: 'nomic-embed-text'
        });
        console.log(`[Providers] ✅ Ollama configured at ${ollamaBaseUrl} (auto-detect disabled)`);
      }
    } else {
      console.log('[Providers] ℹ️ Ollama disabled in config');
    }

    // LMStudio (uses OpenAI-compatible API)
    if (lmstudioConfig.enabled) {
      const lmstudioBaseUrl = lmstudioConfig.base_url || 'http://localhost:1234/v1';
      registry.initializeProvider('lmstudio', {
        baseUrl: lmstudioBaseUrl
      });
      console.log(`[Providers] ✅ LMStudio configured at ${lmstudioBaseUrl}`);
    }
  } else if (detectOllamaEnabled && !platform.supportsLocalModels) {
    console.log(`[Providers] ℹ️ Skipping local models on ${platform.platform} (not supported; set providers.ollama.base_url to a remote host to enable)`);
  }

  // Local Agents — HTTP-based agents configured in config.json
  // Not gated by supportsLocalModels since agents connect to remote HTTP endpoints
  const localAgents = evobrewConfig?.providers?.local_agents || [];
  for (const agent of localAgents) {
    if (agent.enabled === false) continue;
    const agentId = `local:${agent.id}`;
    try {
      registry.initializeProvider(agentId, {
        id: agentId,
        name: agent.name || agent.id,
        url: agent.url,
        endpoint: agent.endpoint || '/api/chat',
        capabilities: agent.capabilities || {},
        apiKey: decryptAgentKey(agent.api_key)
      });
      console.log(`[Providers] ✅ Local agent registered: ${agent.name || agent.id} (${agentId})`);
    } catch (err) {
      console.warn(`[Providers] ⚠️ Failed to register local agent ${agent.name || agent.id}:`, err.message);
    }
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
  createAnthropicAdapter,
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
