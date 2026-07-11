'use strict';

const { getModelCapabilities } = require('../server/config/model-catalog');

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function pairKey(provider, model) {
  if (typeof provider !== 'string' || !provider.trim()
      || typeof model !== 'string' || !model.trim()) {
    throw typed('provider_model_mismatch', 'Provider and model are required');
  }
  return `${provider.trim()}\0${model.trim()}`;
}

function firstNonempty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function providerSecret(config, envName) {
  return firstNonempty(config.apiKey, config.api_key, process.env[envName]);
}

function providerBaseUrl(config, envName, fallback) {
  return firstNonempty(config.baseURL, config.baseUrl, config.base_url,
    envName ? process.env[envName] : null, fallback);
}

function unavailable(provider, message) {
  throw typed('provider_unavailable', `${provider}: ${message}`, true);
}

function requireTransport(provider, modelConfig, allowed) {
  const transport = modelConfig?.transport;
  if (!allowed.includes(transport)) {
    throw typed(
      'provider_model_mismatch',
      `Unsupported transport for ${provider}: ${String(transport || 'missing')}`,
      false,
    );
  }
  return transport;
}

function createResponsesClient({ provider, modelConfig, providerConfig, logger }) {
  requireTransport(provider, modelConfig, ['responses']);
  const envName = provider === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = providerSecret(providerConfig, envName);
  if (!apiKey && !providerConfig.client) unavailable(provider, 'credentials are unavailable');
  const baseURL = providerBaseUrl(
    providerConfig,
    provider === 'xai' ? 'XAI_BASE_URL' : 'OPENAI_BASE_URL',
    provider === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1',
  );
  const { GPT5Client } = require('./gpt5-client');
  const client = new GPT5Client(logger, {
    providerId: provider,
    clientOptions: providerConfig.client ? null : { apiKey, baseURL },
  });
  if (providerConfig.client) client.client = providerConfig.client;
  return client;
}

function createChatCompletionsClient({
  provider, model, modelConfig, providerConfig, logger,
}) {
  requireTransport(provider, modelConfig, ['chat-completions']);
  const envName = provider === 'xai' ? 'XAI_API_KEY' : 'OLLAMA_CLOUD_API_KEY';
  const apiKey = providerSecret(providerConfig, envName);
  if (!apiKey && !providerConfig.client) unavailable(provider, 'credentials are unavailable');
  const fallback = provider === 'xai' ? 'https://api.x.ai/v1' : 'https://ollama.com/v1';
  const baseURL = providerBaseUrl(
    providerConfig,
    provider === 'xai' ? 'XAI_BASE_URL' : 'OLLAMA_CLOUD_BASE_URL',
    fallback,
  );
  const { ChatCompletionsClient } = require('../engine/src/core/chat-completions-client');
  return new ChatCompletionsClient({
    ...providerConfig,
    providerId: provider,
    apiKey,
    baseURL,
    client: providerConfig.client || null,
    defaultModel: model,
    modelMapping: {},
    supportsStreaming: true,
  }, logger);
}

function createAnthropicMessagesClient({
  provider, model, modelConfig, providerConfig, logger,
}) {
  requireTransport(provider, modelConfig, ['anthropic-messages']);
  const isMiniMax = provider === 'minimax';
  const envApiKey = isMiniMax ? 'MINIMAX_API_KEY' : 'ANTHROPIC_API_KEY';
  const apiKey = providerSecret(providerConfig, envApiKey);
  const authToken = firstNonempty(
    providerConfig.authToken,
    providerConfig.auth_token,
    !isMiniMax ? process.env.ANTHROPIC_AUTH_TOKEN : null,
  );
  const useOAuthService = !isMiniMax
    && providerConfig.useOAuthService === true
    && !apiKey
    && !authToken;
  if (!apiKey && !authToken && !useOAuthService && !providerConfig.client) {
    unavailable(provider, 'credentials are unavailable');
  }
  const AnthropicClient = require('./anthropic-client');
  const client = new AnthropicClient({
    ...providerConfig,
    providerId: provider,
    apiKey,
    authToken,
    useOAuthService,
    baseURL: providerBaseUrl(
      providerConfig,
      isMiniMax ? 'MINIMAX_BASE_URL' : 'ANTHROPIC_BASE_URL',
      isMiniMax ? 'https://api.minimax.io/anthropic' : 'https://api.anthropic.com',
    ),
    modelMapping: {},
    defaultModel: model,
  }, logger);
  if (providerConfig.client) client.anthropic = providerConfig.client;
  return client;
}

function createCodexResponsesClient({
  provider, modelConfig, credentialsProvider, fetchImpl,
}) {
  requireTransport(provider, modelConfig, ['codex-responses']);
  if (typeof credentialsProvider !== 'function') {
    unavailable(provider, 'credentials provider is unavailable');
  }
  const { CodexResponsesClient } = require('./codex-responses-client');
  return new CodexResponsesClient({ fetchImpl, credentialsProvider });
}

function createXaiClient(options) {
  const transport = requireTransport('xai', options.modelConfig, [
    'responses', 'chat-completions',
  ]);
  return transport === 'responses'
    ? createResponsesClient(options)
    : createChatCompletionsClient(options);
}

function createBuiltInPairFactories() {
  return Object.freeze({
    openai: createResponsesClient,
    'openai-codex': createCodexResponsesClient,
    anthropic: createAnthropicMessagesClient,
    minimax: createAnthropicMessagesClient,
    xai: createXaiClient,
    'ollama-cloud': createChatCompletionsClient,
  });
}

function createBrainProviderClientRegistry({
  catalog,
  providerConfig = {},
  credentialsProviders = {},
  fetchImpl = globalThis.fetch,
  logger = console,
  pairFactories = {},
} = {}) {
  if (!catalog?.providers || typeof catalog.providers !== 'object') {
    throw typed('model_catalog_invalid', 'Canonical model catalog is required');
  }
  const builtInFactories = createBuiltInPairFactories();
  const clients = new Map();
  const unavailable = new Map();
  for (const [provider, config] of Object.entries(catalog.providers).sort(([left], [right]) =>
    left.localeCompare(right))) {
    for (const row of config.models || []) {
      if ((row.kind || 'chat') !== 'chat') continue;
      const key = pairKey(provider, row.id);
      try {
        getModelCapabilities(catalog, provider, row.id);
        const factory = pairFactories[key]
          || pairFactories[provider]
          || builtInFactories[provider];
        if (typeof factory !== 'function') {
          unavailable.set(key, 'provider factory is not registered');
          continue;
        }
        const client = factory({
          provider,
          model: row.id,
          modelConfig: row,
          providerConfig: providerConfig[provider] || {},
          credentialsProvider: credentialsProviders[provider] || null,
          fetchImpl,
          logger,
        });
        if (!client || typeof client.generate !== 'function') {
          unavailable.set(key, 'provider client is unavailable');
          continue;
        }
        if (client.providerId && client.providerId !== provider) {
          unavailable.set(key, 'provider client identity mismatch');
          continue;
        }
        clients.set(key, client);
      } catch (error) {
        unavailable.set(key, error?.message || 'provider client is unavailable');
      }
    }
  }

  function assertPairAvailable(provider, model) {
    getModelCapabilities(catalog, provider, model);
    const key = pairKey(provider, model);
    const client = clients.get(key);
    if (!client) {
      throw typed(
        'provider_unavailable',
        unavailable.get(key) || `Provider unavailable: ${provider}/${model}`,
        true,
      );
    }
    return client;
  }

  return Object.freeze({
    get: assertPairAvailable,
    getExact: assertPairAvailable,
    has: (provider, model) => clients.has(pairKey(provider, model)),
    availability: (provider, model) => {
      getModelCapabilities(catalog, provider, model);
      const key = pairKey(provider, model);
      return Object.freeze({
        available: clients.has(key),
        reason: unavailable.get(key) || null,
      });
    },
    assertPairAvailable,
  });
}

module.exports = {
  createBuiltInPairFactories,
  createBrainProviderClientRegistry,
  pairKey,
};
