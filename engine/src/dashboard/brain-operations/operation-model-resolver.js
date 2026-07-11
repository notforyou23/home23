'use strict';

const {
  flattenCatalogModels,
  getModelCapabilities,
} = require('../../../../cosmo23/server/config/model-catalog.js');

const QUERY_KEYS = Object.freeze([
  'query', 'mode', 'modelSelection', 'topK', 'priorContext', 'enableSynthesis',
  'includeOutputs', 'includeThoughts', 'includeCoordinatorInsights', 'allowActions',
]);
const PGS_KEYS = Object.freeze([
  'query', 'mode', 'pgsMode', 'pgsConfig', 'pgsSweep', 'pgsSynth',
  'priorContext', 'allowActions',
]);
const MODES = new Set(['quick', 'full', 'expert', 'dive']);

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw typed('invalid_request', `${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  plainObject(value, label);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key) || value[key] === undefined) {
      throw typed('invalid_request', `${label} contains an invalid field`);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactPair(value, label) {
  assertExactKeys(value, ['provider', 'model'], label);
  if (Object.keys(value).length !== 2) {
    throw typed('provider_model_mismatch', `${label} requires provider and model`);
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model || provider.length > 256 || model.length > 256) {
    throw typed('provider_model_mismatch', `${label} requires provider and model`);
  }
  return deepFreeze({ provider, model });
}

function optionalBoolean(value, label) {
  if (typeof value !== 'boolean') throw typed('invalid_request', `${label} must be boolean`);
  return value;
}

function priorContext(value) {
  assertExactKeys(value, ['query', 'answer'], 'priorContext');
  if (Object.keys(value).length !== 2
      || typeof value.query !== 'string' || value.query.length > 12_000
      || typeof value.answer !== 'string' || value.answer.length > 20_000) {
    throw typed('invalid_request', 'priorContext is invalid');
  }
  return deepFreeze({ query: value.query, answer: value.answer });
}

function normalizeRequest(operationType, input) {
  const allowed = operationType === 'query' ? QUERY_KEYS
    : operationType === 'pgs' ? PGS_KEYS
      : null;
  if (!allowed) throw typed('invalid_request', 'unsupported provider operation');
  assertExactKeys(input, allowed, 'requestParameters');
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 12_000) {
    throw typed('invalid_request', 'query is invalid');
  }
  const result = { query: input.query };
  if (Object.hasOwn(input, 'mode')) {
    if (typeof input.mode !== 'string' || !MODES.has(input.mode)) {
      throw typed('invalid_request', 'mode is invalid');
    }
    result.mode = input.mode;
  }
  if (Object.hasOwn(input, 'priorContext')) result.priorContext = priorContext(input.priorContext);
  if (Object.hasOwn(input, 'allowActions')) {
    result.allowActions = optionalBoolean(input.allowActions, 'allowActions');
  }

  if (operationType === 'query') {
    if (Object.hasOwn(input, 'modelSelection')) {
      result.modelSelection = exactPair(input.modelSelection, 'modelSelection');
    }
    if (Object.hasOwn(input, 'topK')) {
      if (!Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > 100) {
        throw typed('invalid_request', 'topK is invalid');
      }
      result.topK = input.topK;
    }
    for (const key of [
      'enableSynthesis', 'includeOutputs', 'includeThoughts', 'includeCoordinatorInsights',
    ]) {
      if (Object.hasOwn(input, key)) result[key] = optionalBoolean(input[key], key);
    }
  } else {
    if (Object.hasOwn(input, 'pgsMode')) {
      if (input.pgsMode !== 'full') throw typed('invalid_request', 'pgsMode is invalid');
      result.pgsMode = 'full';
    }
    if (Object.hasOwn(input, 'pgsConfig')) {
      assertExactKeys(input.pgsConfig, ['sweepFraction'], 'pgsConfig');
      const config = {};
      if (Object.hasOwn(input.pgsConfig, 'sweepFraction')) {
        const fraction = input.pgsConfig.sweepFraction;
        if (typeof fraction !== 'number' || !Number.isFinite(fraction)
            || fraction <= 0 || fraction > 1) {
          throw typed('invalid_request', 'pgsConfig.sweepFraction is invalid');
        }
        config.sweepFraction = fraction;
      }
      result.pgsConfig = deepFreeze(config);
    }
    if (Object.hasOwn(input, 'pgsSweep')) result.pgsSweep = exactPair(input.pgsSweep, 'pgsSweep');
    if (Object.hasOwn(input, 'pgsSynth')) result.pgsSynth = exactPair(input.pgsSynth, 'pgsSynth');
  }
  return deepFreeze(result);
}

function createOperationModelResolver({ catalog, providerRegistry, queryDefaults } = {}) {
  if (!catalog?.providers || !providerRegistry || !queryDefaults) {
    throw typed('provider_unavailable', 'provider operation resolver is unavailable', true);
  }
  const assertAvailable = typeof providerRegistry.assertPairAvailable === 'function'
    ? providerRegistry.assertPairAvailable.bind(providerRegistry)
    : typeof providerRegistry.get === 'function'
      ? providerRegistry.get.bind(providerRegistry)
      : null;
  if (!assertAvailable) {
    throw typed('provider_unavailable', 'provider registry is unavailable', true);
  }

  const defaults = deepFreeze({
    query: exactPair({
      provider: queryDefaults.defaultProvider,
      model: queryDefaults.defaultModel,
    }, 'query default'),
    pgsSweep: exactPair({
      provider: queryDefaults.pgsSweepProvider,
      model: queryDefaults.pgsSweepModel,
    }, 'PGS sweep default'),
    pgsSynth: exactPair({
      provider: queryDefaults.pgsSynthProvider,
      model: queryDefaults.pgsSynthModel,
    }, 'PGS synthesis default'),
  });

  function validatePair(pair) {
    getModelCapabilities(catalog, pair.provider, pair.model);
    assertAvailable(pair.provider, pair.model);
    return pair;
  }
  for (const pair of new Map(Object.values(defaults).map((value) => [
    `${value.provider}\0${value.model}`, value,
  ])).values()) validatePair(pair);

  function resolve(operationType, requestParameters) {
    const normalized = normalizeRequest(operationType, requestParameters);
    const parameters = { ...normalized };
    if (operationType === 'query') {
      parameters.modelSelection = validatePair(normalized.modelSelection || defaults.query);
    } else {
      parameters.pgsSweep = validatePair(normalized.pgsSweep || defaults.pgsSweep);
      parameters.pgsSynth = validatePair(normalized.pgsSynth || defaults.pgsSynth);
    }
    return deepFreeze({
      requestParameters: normalized,
      parameters: deepFreeze(parameters),
    });
  }

  const resolver = async function operationModelResolver({ operationType, requestParameters } = {}) {
    return resolve(operationType, requestParameters).parameters;
  };
  Object.defineProperty(resolver, 'resolve', {
    value: resolve,
    enumerable: true,
  });
  return Object.freeze(resolver);
}

async function migrateQueryDefaultPairs({
  settingsStore,
  catalog,
  providerRegistry,
  maxAttempts = 4,
} = {}) {
  if (!settingsStore || typeof settingsStore.read !== 'function'
      || typeof settingsStore.update !== 'function'
      || !catalog?.providers || !providerRegistry
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw typed('provider_unavailable', 'query default migration is unavailable', true);
  }
  const assertAvailable = typeof providerRegistry.assertPairAvailable === 'function'
    ? providerRegistry.assertPairAvailable.bind(providerRegistry)
    : typeof providerRegistry.get === 'function'
      ? providerRegistry.get.bind(providerRegistry)
      : null;
  if (!assertAvailable) throw typed('provider_unavailable', 'provider registry is unavailable', true);

  function validate(provider, model) {
    const pair = exactPair({ provider, model }, 'query default pair');
    getModelCapabilities(catalog, pair.provider, pair.model);
    assertAvailable(pair.provider, pair.model);
    return pair;
  }

  function infer(model) {
    if (typeof model !== 'string' || !model.trim()) {
      throw typed('provider_model_mismatch', 'query default model is missing');
    }
    const candidates = [];
    for (const row of flattenCatalogModels(catalog, { kind: 'chat' })) {
      if (row.id !== model.trim()) continue;
      try {
        validate(row.provider, row.id);
        candidates.push({ provider: row.provider, model: row.id });
      } catch (error) {
        if (!['provider_unavailable', 'model_not_found', 'model_capability_invalid']
          .includes(error.code)) throw error;
      }
    }
    if (candidates.length === 0) {
      throw typed('provider_unavailable', `No available provider for query model ${model}`, true);
    }
    if (candidates.length !== 1) {
      throw typed('model_ambiguous', `Query model ${model} has multiple available providers`);
    }
    return candidates[0];
  }

  function resolveDocument(data) {
    const query = plainObject(data.query, 'query defaults');
    const slots = [
      ['defaultProvider', 'defaultModel'],
      ['pgsSweepProvider', 'pgsSweepModel'],
      ['pgsSynthProvider', 'pgsSynthModel'],
    ];
    const providers = {};
    let changed = false;
    for (const [providerField, modelField] of slots) {
      const model = query[modelField];
      const provider = query[providerField];
      const pair = typeof provider === 'string' && provider.trim()
        ? validate(provider, model)
        : infer(model);
      providers[providerField] = pair.provider;
      if (provider !== pair.provider) changed = true;
    }
    return { providers, changed };
  }

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await settingsStore.read();
    const resolved = resolveDocument(current.data);
    if (!resolved.changed) {
      return deepFreeze({
        migrated: false,
        version: current.version,
        queryDefaults: { ...current.data.query },
      });
    }
    try {
      const updated = await settingsStore.update({
        expectedVersion: current.version,
        mutate(data) {
          const fresh = resolveDocument(data);
          for (const [field, provider] of Object.entries(fresh.providers)) {
            data.query[field] = provider;
          }
        },
      });
      return deepFreeze({
        migrated: true,
        version: updated.version,
        queryDefaults: { ...updated.data.query },
      });
    } catch (error) {
      if (error.code !== 'settings_changed') throw error;
      lastError = error;
    }
  }
  throw lastError || typed('settings_changed', 'query defaults changed during migration', true);
}

module.exports = {
  createOperationModelResolver,
  migrateQueryDefaultPairs,
  normalizeRequest,
};
