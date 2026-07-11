'use strict';

const {
  flattenCatalogModels,
  getModelCapabilities,
} = require('../../../cosmo23/server/config/model-catalog.js');
const {
  requireCompleteProviderResult,
} = require('../../../cosmo23/lib/provider-completion.js');
const {
  throwIfAborted,
} = require('../../../cosmo23/lib/provider-execution.js');
const {
  SYNTHESIS_OPERATION_LIMITS,
} = require('../../../cosmo23/lib/brain-operation-limits.js');

const DEFAULT_SYNTHESIS_SELECTION = Object.freeze({
  provider: 'minimax',
  model: 'MiniMax-M3',
});
const DEFAULT_SYNTHESIS_INTERVAL_HOURS = 4;
const MAX_CONFIG_VALUE_BYTES = 256;

function typed(code, message, retryable = false, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    retryable,
  });
}

function boundedConfigString(value, label, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw typed('synthesis_config_invalid', `${label} is required`);
  }
  if (typeof value !== 'string'
      || value.trim() !== value
      || value.length === 0
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > MAX_CONFIG_VALUE_BYTES) {
    throw typed('synthesis_config_invalid', `${label} must be a bounded nonempty string`);
  }
  return value;
}

function positiveInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 24 * 30) {
    throw typed(
      'synthesis_config_invalid',
      'intervalHours must be greater than 0 and no more than 720',
    );
  }
  return number;
}

function environmentValue(env, key) {
  if (!Object.prototype.hasOwnProperty.call(env || {}, key)) return null;
  return boundedConfigString(env[key], key);
}

function requireSynthesisRoot(homeConfig) {
  if (homeConfig === undefined || homeConfig === null) return {};
  if (Array.isArray(homeConfig) || typeof homeConfig !== 'object') {
    throw typed('synthesis_config_invalid', 'Home configuration must be an object');
  }
  const configured = homeConfig.synthesis ?? {};
  if (!configured || Array.isArray(configured) || typeof configured !== 'object') {
    throw typed('synthesis_config_invalid', 'synthesis configuration must be an object');
  }
  return configured;
}

function uniqueProviderForLegacyModel(modelCatalog, model) {
  const matches = flattenCatalogModels(modelCatalog || {}, { kind: 'chat' })
    .filter((row) => row.id === model);
  if (matches.length !== 1) {
    throw typed(
      matches.length > 1 ? 'model_ambiguous' : 'model_not_found',
      'Legacy synthesis model does not resolve uniquely',
    );
  }
  return boundedConfigString(matches[0].provider, 'synthesis provider');
}

function resolveSynthesisConfig({
  homeConfig = {},
  env = process.env,
  modelCatalog,
  providerRegistry,
} = {}) {
  const configured = requireSynthesisRoot(homeConfig);
  const envProvider = environmentValue(env, 'SYNTHESIS_LLM_PROVIDER');
  const envModel = environmentValue(env, 'SYNTHESIS_LLM_MODEL');
  if (envProvider && !envModel) {
    throw typed(
      'synthesis_config_invalid',
      'SYNTHESIS_LLM_PROVIDER requires SYNTHESIS_LLM_MODEL',
    );
  }

  let provider;
  let model;
  if (envModel) {
    provider = envProvider;
    model = envModel;
  } else {
    provider = configured.provider === undefined
      ? null
      : boundedConfigString(configured.provider, 'synthesis provider');
    model = configured.model === undefined
      ? null
      : boundedConfigString(configured.model, 'synthesis model');
  }

  let migratedFromModelOnly = false;
  if (!provider && model) {
    provider = uniqueProviderForLegacyModel(modelCatalog, model);
    migratedFromModelOnly = true;
  }
  if (!provider && !model) {
    provider = DEFAULT_SYNTHESIS_SELECTION.provider;
    model = DEFAULT_SYNTHESIS_SELECTION.model;
  }
  if (!provider || !model) {
    throw typed('synthesis_config_invalid', 'Synthesis provider and model are required');
  }
  if (!modelCatalog?.providers || typeof modelCatalog.providers !== 'object') {
    throw typed('model_catalog_invalid', 'Canonical model catalog is required');
  }
  if (!providerRegistry || (typeof providerRegistry.assertPairAvailable !== 'function'
      && typeof providerRegistry.get !== 'function')) {
    throw typed('provider_unavailable', 'Synthesis provider registry is unavailable', true);
  }

  const capabilities = getModelCapabilities(modelCatalog, provider, model);
  if (!Number.isSafeInteger(capabilities.maxOutputTokens)
      || capabilities.maxOutputTokens <= 0
      || !Number.isSafeInteger(capabilities.providerStallMs)
      || capabilities.providerStallMs <= 0) {
    throw typed('model_capability_invalid', 'Synthesis model capabilities are invalid');
  }
  const getClient = typeof providerRegistry.assertPairAvailable === 'function'
    ? providerRegistry.assertPairAvailable.bind(providerRegistry)
    : providerRegistry.get.bind(providerRegistry);
  const client = getClient(provider, model);
  if (!client || typeof client.generate !== 'function') {
    throw typed('provider_unavailable', `Provider unavailable: ${provider}/${model}`, true);
  }
  if (client.providerId && client.providerId !== provider) {
    throw typed('provider_model_mismatch', 'Synthesis provider client identity mismatch');
  }

  const selection = Object.freeze({ provider, model });
  const normalizedCapabilities = Object.freeze({
    maxOutputTokens: capabilities.maxOutputTokens,
    providerStallMs: capabilities.providerStallMs,
  });
  return Object.freeze({
    selection,
    capabilities: normalizedCapabilities,
    client,
    intervalHours: positiveInterval(configured.intervalHours ?? DEFAULT_SYNTHESIS_INTERVAL_HOURS),
    migratedFromModelOnly,
    needsPersistence: !envModel && (migratedFromModelOnly
      || configured.provider !== provider
      || configured.model !== model),
  });
}

function createSynthesisProviderAdapter(resolved) {
  if (!resolved || Array.isArray(resolved) || typeof resolved !== 'object') {
    throw typed('synthesis_config_invalid', 'Resolved synthesis configuration is required');
  }
  const provider = boundedConfigString(resolved.selection?.provider, 'synthesis provider');
  const model = boundedConfigString(resolved.selection?.model, 'synthesis model');
  const maxOutputTokens = resolved.capabilities?.maxOutputTokens;
  const providerStallMs = resolved.capabilities?.providerStallMs;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0
      || !Number.isSafeInteger(providerStallMs) || providerStallMs <= 0) {
    throw typed('model_capability_invalid', 'Synthesis model capabilities are invalid');
  }
  const client = resolved.client;
  if (!client || typeof client.generate !== 'function') {
    throw typed('provider_unavailable', 'Synthesis provider client is unavailable', true);
  }
  if (client.providerId && client.providerId !== provider) {
    throw typed('provider_model_mismatch', 'Synthesis provider client identity mismatch');
  }

  return Object.freeze({
    provider,
    model,
    capabilities: Object.freeze({ maxOutputTokens, providerStallMs }),
    async generate(options = {}) {
      if (!options || Array.isArray(options) || typeof options !== 'object') {
        throw typed('invalid_request', 'Synthesis provider request must be an object');
      }
      for (const forbidden of ['provider', 'providerId', 'model', 'modelId', 'maxOutputTokens']) {
        if (Object.prototype.hasOwnProperty.call(options, forbidden)) {
          throw typed('provider_model_mismatch', 'Synthesis provider selection is fixed');
        }
      }
      const signal = options.signal || null;
      const maxOutputBytes = options.maxOutputBytes
        ?? SYNTHESIS_OPERATION_LIMITS.maxProviderOutputBytes;
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0
          || maxOutputBytes > SYNTHESIS_OPERATION_LIMITS.maxProviderOutputBytes) {
        throw typed('invalid_request', 'Synthesis provider output byte limit is invalid');
      }
      throwIfAborted(signal);
      const raw = await client.generate({
        provider,
        model,
        instructions: String(options.instructions || ''),
        input: String(options.input || ''),
        maxOutputTokens,
        maxOutputBytes,
        signal,
        onProviderActivity: options.onProviderActivity || null,
      });
      throwIfAborted(signal);
      return requireCompleteProviderResult(raw);
    },
  });
}

module.exports = {
  DEFAULT_SYNTHESIS_INTERVAL_HOURS,
  DEFAULT_SYNTHESIS_SELECTION,
  createSynthesisProviderAdapter,
  positiveInterval,
  resolveSynthesisConfig,
};
