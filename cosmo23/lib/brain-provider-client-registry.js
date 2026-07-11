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
  const clients = new Map();
  const unavailable = new Map();
  for (const [provider, config] of Object.entries(catalog.providers).sort(([left], [right]) =>
    left.localeCompare(right))) {
    for (const row of config.models || []) {
      if ((row.kind || 'chat') !== 'chat') continue;
      const key = pairKey(provider, row.id);
      try {
        getModelCapabilities(catalog, provider, row.id);
        const factory = pairFactories[key] || pairFactories[provider];
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
  createBrainProviderClientRegistry,
  pairKey,
};
