const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../../lib/config-loader-sync');

const MODEL_CATALOG_FILE_NAME = 'model-catalog.json';

const BUILTIN_EXECUTION_DEFAULTS = Object.freeze({
  openai: Object.freeze({
    maxOutputTokens: 32768,
    providerStallMs: 900000,
    transport: 'responses',
  }),
  'openai-codex': Object.freeze({
    maxOutputTokens: 32768,
    providerStallMs: 900000,
    transport: 'codex-responses',
  }),
  anthropic: Object.freeze({
    maxOutputTokens: 8192,
    providerStallMs: 900000,
    transport: 'anthropic-messages',
  }),
  minimax: Object.freeze({
    maxOutputTokens: 32768,
    providerStallMs: 900000,
    transport: 'anthropic-messages',
  }),
  xai: Object.freeze({
    maxOutputTokens: 8192,
    providerStallMs: 900000,
    transport: 'chat-completions',
  }),
  'ollama-cloud': Object.freeze({
    maxOutputTokens: 8192,
    providerStallMs: 900000,
    transport: 'chat-completions',
  }),
});

const REVIEWED_LEGACY_MODEL_DEFAULTS = Object.freeze({
  xai: Object.freeze({
    'grok-4.20-0309-reasoning': BUILTIN_EXECUTION_DEFAULTS.xai,
    'grok-4.20-0309-non-reasoning': BUILTIN_EXECUTION_DEFAULTS.xai,
    'grok-4.20-multi-agent-0309': Object.freeze({
      ...BUILTIN_EXECUTION_DEFAULTS.xai,
      transport: 'responses',
    }),
  }),
});

const EXECUTION_TRANSPORTS = new Set([
  'responses',
  'chat-completions',
  'anthropic-messages',
  'codex-responses',
]);
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PROVIDER_IDS = new Set(['__proto__', 'prototype', 'constructor']);

const BUILTIN_MODEL_CATALOG = {
  version: 1,
  providers: {
    openai: {
      label: 'OpenAI',
      executionDefaults: BUILTIN_EXECUTION_DEFAULTS.openai,
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5', kind: 'chat' },
        { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', kind: 'chat' },
        { id: 'gpt-5.4', label: 'GPT-5.4', kind: 'chat' },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', kind: 'chat' },
        { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', kind: 'chat' },
        { id: 'text-embedding-3-small', label: 'text-embedding-3-small', kind: 'embedding' }
      ]
    },
    'ollama-cloud': {
      label: 'Ollama Cloud',
      executionDefaults: BUILTIN_EXECUTION_DEFAULTS['ollama-cloud'],
      models: [
        { id: 'gpt-oss:120b', label: 'GPT OSS 120B', kind: 'chat' },
        { id: 'gpt-oss:20b', label: 'GPT OSS 20B', kind: 'chat' },
        { id: 'kimi-k2.6', label: 'Kimi K2.6', kind: 'chat' },
        { id: 'kimi-k2.5', label: 'Kimi K2.5', kind: 'chat' },
        { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', kind: 'chat' },
        { id: 'kimi-k2:1t', label: 'Kimi K2 1T', kind: 'chat' },
        { id: 'gemma4:31b', label: 'Gemma 4 31B', kind: 'chat' },
        { id: 'glm-5.2:cloud', label: 'GLM-5.2 Cloud', kind: 'chat' },
        { id: 'glm-5.1', label: 'GLM-5.1', kind: 'chat' },
        { id: 'glm-5', label: 'GLM-5 744B', kind: 'chat' },
        { id: 'glm-4.7', label: 'GLM-4.7', kind: 'chat' },
        { id: 'glm-4.6', label: 'GLM-4.6', kind: 'chat' },
        { id: 'qwen3.5:397b', label: 'Qwen 3.5 397B', kind: 'chat' },
        { id: 'qwen3-coder:480b', label: 'Qwen 3 Coder 480B', kind: 'chat' },
        { id: 'qwen3-coder-next', label: 'Qwen 3 Coder Next', kind: 'chat' },
        { id: 'qwen3-next:80b', label: 'Qwen 3 Next 80B', kind: 'chat' },
        { id: 'qwen3-vl:235b', label: 'Qwen 3 VL 235B', kind: 'chat' },
        { id: 'qwen3-vl:235b-instruct', label: 'Qwen 3 VL 235B Instruct', kind: 'chat' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', kind: 'chat' },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', kind: 'chat' },
        { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', kind: 'chat' },
        { id: 'deepseek-v3.1:671b', label: 'DeepSeek V3.1 671B', kind: 'chat' },
        { id: 'nemotron-3-super', label: 'Nemotron 3 Super 120B', kind: 'chat' },
        { id: 'nemotron-3-nano:30b', label: 'Nemotron 3 Nano 30B', kind: 'chat' },
        { id: 'mistral-large-3:675b', label: 'Mistral Large 3 675B', kind: 'chat' },
        { id: 'ministral-3:14b', label: 'Ministral 3 14B', kind: 'chat' },
        { id: 'ministral-3:8b', label: 'Ministral 3 8B', kind: 'chat' },
        { id: 'ministral-3:3b', label: 'Ministral 3 3B', kind: 'chat' },
        { id: 'devstral-2:123b', label: 'Devstral 2 123B', kind: 'chat' },
        { id: 'devstral-small-2:24b', label: 'Devstral Small 2 24B', kind: 'chat' },
        { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', kind: 'chat' },
        { id: 'cogito-2.1:671b', label: 'Cogito 2.1 671B', kind: 'chat' },
        { id: 'rnj-1:8b', label: 'Rnj-1 8B', kind: 'chat' }
      ]
    },
    anthropic: {
      label: 'Anthropic',
      executionDefaults: BUILTIN_EXECUTION_DEFAULTS.anthropic,
      models: [
        { id: 'claude-sonnet-4-7', label: 'Claude Sonnet 4.7', kind: 'chat' },
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', kind: 'chat' },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', kind: 'chat' }
      ]
    },
    minimax: {
      label: 'MiniMax',
      executionDefaults: BUILTIN_EXECUTION_DEFAULTS.minimax,
      models: [
        { id: 'MiniMax-M3', label: 'MiniMax M3', kind: 'chat' }
      ]
    },
    xai: {
      label: 'xAI',
      executionDefaults: BUILTIN_EXECUTION_DEFAULTS.xai,
      models: [
        { id: 'grok-4.5', label: 'Grok 4.5', kind: 'chat' },
        { id: 'grok-4.3', label: 'Grok 4.3', kind: 'chat' }
      ]
    },
    'openai-codex': {
      label: 'OpenAI Codex',
      executionDefaults: BUILTIN_EXECUTION_DEFAULTS['openai-codex'],
      models: [
        { id: 'gpt-5.6', label: 'GPT-5.6', kind: 'chat' },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', kind: 'chat' },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', kind: 'chat' },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', kind: 'chat' },
        { id: 'gpt-5.5', label: 'GPT-5.5', kind: 'chat' },
        { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', kind: 'chat' },
        { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', kind: 'chat' },
        { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', kind: 'chat' },
        { id: 'gpt-5.4', label: 'GPT-5.4', kind: 'chat' },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', kind: 'chat' }
      ]
    }
  },
  defaults: {
    queryModel: 'MiniMax-M3',
    pgsSweepModel: 'MiniMax-M3',
    launch: {
      primary: 'gpt-5.5',
      fast: 'nemotron-3-nano:30b',
      strategic: 'gpt-5.5-pro'
    },
    embeddings: {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 512
    },
    local: {
      primary: 'qwen3.5:14b',
      fast: 'qwen2.5-coder:7b',
      embeddings: 'nomic-embed-text'
    }
  }
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function modelCatalogError(message, cause = null) {
  const error = Object.assign(new Error(message), {
    code: 'model_catalog_invalid',
    retryable: false,
  });
  if (cause) error.cause = cause;
  return error;
}

function validateProviderId(providerId) {
  if (typeof providerId !== 'string'
      || !SAFE_PROVIDER_ID.test(providerId)
      || RESERVED_PROVIDER_IDS.has(providerId)) {
    throw modelCatalogError(`Invalid model catalog provider ID: ${String(providerId)}`);
  }
  return providerId;
}

function validateCatalogStructure(input) {
  if (!isPlainRecord(input)) {
    throw modelCatalogError('Model catalog root must be an object');
  }
  if (!hasOwn(input, 'providers') || !isPlainRecord(input.providers)) {
    throw modelCatalogError('Model catalog providers must be an object');
  }
  if (hasOwn(input, 'defaults') && !isPlainRecord(input.defaults)) {
    throw modelCatalogError('Model catalog defaults must be an object');
  }
  if (isPlainRecord(input.defaults)) {
    for (const section of ['launch', 'embeddings', 'local']) {
      if (hasOwn(input.defaults, section) && !isPlainRecord(input.defaults[section])) {
        throw modelCatalogError(`Model catalog defaults.${section} must be an object`);
      }
    }
    for (const [section, fields] of [
      ['launch', ['primary', 'fast', 'strategic']],
      ['embeddings', ['provider', 'model']],
      ['local', ['primary', 'fast', 'embeddings']],
    ]) {
      const defaults = input.defaults[section];
      if (!isPlainRecord(defaults)) continue;
      for (const field of fields) {
        if (hasOwn(defaults, field)
            && (typeof defaults[field] !== 'string' || !defaults[field].trim())) {
          throw modelCatalogError(`Model catalog defaults.${section}.${field} must be a nonempty string`);
        }
      }
    }
    const embeddingDefaults = input.defaults.embeddings;
    if (isPlainRecord(embeddingDefaults)
        && hasOwn(embeddingDefaults, 'dimensions')
        && (!Number.isSafeInteger(embeddingDefaults.dimensions)
          || embeddingDefaults.dimensions <= 0)) {
      throw modelCatalogError('Model catalog defaults.embeddings.dimensions must be a positive safe integer');
    }
  }

  for (const [providerId, provider] of Object.entries(input.providers)) {
    validateProviderId(providerId);
    if (!isPlainRecord(provider)) {
      throw modelCatalogError(`Model catalog provider ${providerId} must be an object`);
    }
    if (hasOwn(provider, 'executionDefaults') && !isPlainRecord(provider.executionDefaults)) {
      throw modelCatalogError(`Model catalog provider ${providerId} executionDefaults must be an object`);
    }
    if (!hasOwn(provider, 'models')) {
      if (!hasOwn(BUILTIN_MODEL_CATALOG.providers, providerId)) {
        throw modelCatalogError(`Model catalog provider ${providerId} models must be an array`);
      }
      continue;
    }
    if (!Array.isArray(provider.models)) {
      throw modelCatalogError(`Model catalog provider ${providerId} models must be an array`);
    }

    for (const [index, model] of provider.models.entries()) {
      if (typeof model === 'string') {
        if (model.trim()) continue;
      } else if (isPlainRecord(model)) {
        const modelId = model.id || model.name;
        if (typeof modelId === 'string' && modelId.trim()) continue;
      }
      throw modelCatalogError(`Invalid model catalog row ${providerId}[${index}]`);
    }
  }

  return input;
}

function getModelCatalogPath() {
  return process.env.COSMO23_MODEL_CATALOG_PATH || path.join(getConfigDir(), MODEL_CATALOG_FILE_NAME);
}

function isTrulyAbsentCatalogPath(catalogPath) {
  const absolutePath = path.resolve(catalogPath);
  const root = path.parse(absolutePath).root;
  let currentPath = absolutePath;
  let missingComponent = false;

  while (true) {
    let entry = null;
    try {
      entry = fs.lstatSync(currentPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missingComponent = true;
    }

    if (entry?.isSymbolicLink()) {
      try {
        fs.statSync(currentPath);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }

    if (currentPath === root) return missingComponent;
    currentPath = path.dirname(currentPath);
  }
}

function inferModelKind(modelId, explicitKind = null) {
  if (explicitKind === 'chat' || explicitKind === 'embedding') {
    return explicitKind;
  }

  const normalized = String(modelId || '').trim().toLowerCase();
  if (
    normalized.includes('embed') ||
    normalized.startsWith('text-embedding-') ||
    normalized.startsWith('nomic-embed') ||
    normalized.startsWith('mxbai-embed') ||
    normalized.startsWith('all-minilm')
  ) {
    return 'embedding';
  }
  return 'chat';
}

function normalizeModelEntry(entry, providerId) {
  if (!entry) {
    return null;
  }

  if (typeof entry === 'string') {
    const id = entry.trim();
    if (!id) return null;
    return {
      id,
      label: id,
      kind: inferModelKind(id),
      provider: providerId
    };
  }

  if (typeof entry !== 'object') {
    return null;
  }

  const id = String(entry.id || entry.name || '').trim();
  if (!id) {
    return null;
  }

  return {
    ...entry,
    id,
    label: String(entry.label || id).trim(),
    kind: inferModelKind(id, entry.kind),
    provider: providerId
  };
}

function requireUniqueModels(providerId, models) {
  const seen = new Set();
  for (const model of models) {
    if (seen.has(model.id)) {
      throw modelCatalogError(`Duplicate model catalog pair ${providerId}/${model.id}`);
    }
    seen.add(model.id);
  }
  return models;
}

function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function capabilityError(providerId, modelId, field) {
  return Object.assign(new Error(`Invalid ${field} for ${providerId}/${modelId}`), {
    code: 'model_capability_invalid',
    retryable: false,
  });
}

function normalizeProviderConfig(providerId, providerConfig = {}, fallbackConfig = {}) {
  validateProviderId(providerId);
  const provider = providerConfig && typeof providerConfig === 'object'
    && !Array.isArray(providerConfig) ? providerConfig : {};
  const fallback = fallbackConfig && typeof fallbackConfig === 'object'
    && !Array.isArray(fallbackConfig) ? fallbackConfig : {};
  const sourceModels = Array.isArray(provider.models)
    ? provider.models
    : (Array.isArray(fallback.models) ? fallback.models : []);
  const providerExecutionDefaults = isPlainRecord(provider.executionDefaults)
    ? provider.executionDefaults
    : {};
  const fallbackExecutionDefaults = isPlainRecord(fallback.executionDefaults)
    ? fallback.executionDefaults
    : {};
  // Built-in defaults are normalization inputs, not catalog declarations.
  // Persist only defaults supplied by this provider so a normalized catalog
  // cannot grant those built-ins to a later custom model after a round trip.
  const executionDefaults = { ...providerExecutionDefaults };
  const providerDeclaredModels = Array.isArray(provider.models);
  const fallbackModelIds = new Set(
    (Array.isArray(fallback.models) ? fallback.models : [])
      .map(model => normalizeModelEntry(model, providerId)?.id)
      .filter(Boolean),
  );
  const normalizedModels = sourceModels
    .map(model => normalizeModelEntry(model, providerId))
    .filter(Boolean)
    .map(model => {
      if (model.kind !== 'chat') return model;
      const canUseBuiltInDefaults = !providerDeclaredModels || fallbackModelIds.has(model.id);
      const reviewedLegacyDefaults = REVIEWED_LEGACY_MODEL_DEFAULTS[providerId]?.[model.id] || {};
      const modelDefaults = {
        ...(canUseBuiltInDefaults ? fallbackExecutionDefaults : reviewedLegacyDefaults),
        ...providerExecutionDefaults,
      };
      const maxOutputTokens = positiveSafeInteger(
        model.maxOutputTokens ?? modelDefaults.maxOutputTokens,
      );
      const providerStallMs = positiveSafeInteger(
        model.providerStallMs ?? modelDefaults.providerStallMs,
      );
      const transport = model.transport ?? modelDefaults.transport;
      if (!maxOutputTokens) {
        throw capabilityError(providerId, model.id, 'maxOutputTokens');
      }
      if (!providerStallMs) {
        throw capabilityError(providerId, model.id, 'providerStallMs');
      }
      if (!EXECUTION_TRANSPORTS.has(transport)) {
        throw capabilityError(providerId, model.id, 'transport');
      }
      return {
        ...model,
        maxOutputTokens,
        providerStallMs,
        transport,
      };
    });

  const normalizedProvider = {
    ...fallback,
    ...provider,
    label: String(provider.label || fallback.label || providerId),
    models: requireUniqueModels(providerId, normalizedModels),
  };
  if (Object.keys(executionDefaults).length > 0) {
    normalizedProvider.executionDefaults = executionDefaults;
  } else {
    delete normalizedProvider.executionDefaults;
  }
  return normalizedProvider;
}

function flattenCatalogModels(source, options = {}) {
  const kind = options.kind || null;
  const providers = Array.isArray(options.providers) && options.providers.length > 0
    ? new Set(options.providers)
    : null;
  const models = [];

  for (const [providerId, providerConfig] of Object.entries(source.providers || {})) {
    if (providers && !providers.has(providerId)) {
      continue;
    }

    for (const model of providerConfig.models || []) {
      if (kind && model.kind !== kind) {
        continue;
      }

      models.push({
        ...model,
        provider: providerId,
        providerLabel: providerConfig.label || providerId
      });
    }
  }

  return models;
}

function validateSelectableModelCapabilities(catalog) {
  for (const model of flattenCatalogModels(catalog).filter(entry => entry.kind === 'chat')) {
    if (!positiveSafeInteger(model.maxOutputTokens)) {
      throw capabilityError(model.provider, model.id, 'maxOutputTokens');
    }
    if (!positiveSafeInteger(model.providerStallMs)) {
      throw capabilityError(model.provider, model.id, 'providerStallMs');
    }
    if (!EXECUTION_TRANSPORTS.has(model.transport)) {
      throw capabilityError(model.provider, model.id, 'transport');
    }
  }
  return catalog;
}

function getModelCapabilities(catalog, providerId, modelId) {
  const models = flattenCatalogModels(catalog || loadModelCatalogSync())
    .filter(entry => entry.id === modelId && entry.kind === 'chat');
  if (!providerId && models.length > 1) {
    throw Object.assign(new Error(`Model ${modelId} is ambiguous`), {
      code: 'model_ambiguous',
      retryable: false,
    });
  }
  const model = models.find(entry => !providerId || entry.provider === providerId);
  if (!model) {
    throw Object.assign(new Error(`Unknown model ${providerId || '?'}/${modelId}`), {
      code: 'model_not_found',
      retryable: false,
    });
  }
  const maxOutputTokens = positiveSafeInteger(model.maxOutputTokens);
  const providerStallMs = positiveSafeInteger(model.providerStallMs);
  if (!maxOutputTokens || !providerStallMs || !EXECUTION_TRANSPORTS.has(model.transport)) {
    throw capabilityError(model.provider, model.id, 'execution capabilities');
  }
  return {
    maxOutputTokens,
    providerStallMs,
  };
}

function resolveDefaultModel(requestedId, fallbackId, catalog, kind = 'chat') {
  const models = flattenCatalogModels(catalog, { kind });
  const ids = new Set(models.map(model => model.id));
  if (requestedId && ids.has(requestedId)) {
    return requestedId;
  }
  if (fallbackId && ids.has(fallbackId)) {
    return fallbackId;
  }
  return models[0]?.id || null;
}

function requireDefaultModelPair(providerId, modelId, catalog, kind) {
  const model = flattenCatalogModels(catalog, { kind }).find(entry => (
    entry.provider === providerId && entry.id === modelId
  ));
  if (!model) {
    throw modelCatalogError(`Model catalog default pair ${providerId}/${modelId} is absent`);
  }
  return { provider: model.provider, model: model.id };
}

function resolveNestedDefaultModel(defaults, field, fallbackId, catalog, kind) {
  if (!hasOwn(defaults, field)) {
    return resolveDefaultModel(null, fallbackId, catalog, kind);
  }
  const requestedId = defaults[field].trim();
  const exists = flattenCatalogModels(catalog, { kind })
    .some(model => model.id === requestedId);
  if (!exists) {
    throw modelCatalogError(`Model catalog defaults.${field} model ${requestedId} is absent`);
  }
  return requestedId;
}

function normalizeModelCatalog(input) {
  const base = deepClone(BUILTIN_MODEL_CATALOG);
  const source = arguments.length === 0 ? {} : validateCatalogStructure(input);
  const sourceLaunchDefaults = source.defaults?.launch || {};
  const sourceEmbeddingDefaults = source.defaults?.embeddings || {};
  const sourceLocalDefaults = source.defaults?.local || {};
  const requestedEmbeddingProvider = hasOwn(sourceEmbeddingDefaults, 'provider')
    ? sourceEmbeddingDefaults.provider.trim()
    : base.defaults.embeddings.provider;
  const requestedEmbeddingModel = hasOwn(sourceEmbeddingDefaults, 'model')
    ? sourceEmbeddingDefaults.model.trim()
    : base.defaults.embeddings.model;
  const requestedEmbeddingDimensions = hasOwn(sourceEmbeddingDefaults, 'dimensions')
    ? sourceEmbeddingDefaults.dimensions
    : base.defaults.embeddings.dimensions;

  const catalog = {
    version: Number.parseInt(source.version || base.version, 10) || base.version,
    providers: {},
    defaults: {
      queryModel: null,
      pgsSweepModel: null,
      launch: {
        primary: null,
        fast: null,
        strategic: null
      },
      embeddings: {
        provider: requestedEmbeddingProvider,
        model: requestedEmbeddingModel,
        dimensions: requestedEmbeddingDimensions
      },
      local: {
        primary: hasOwn(sourceLocalDefaults, 'primary')
          ? sourceLocalDefaults.primary.trim()
          : base.defaults.local.primary,
        fast: hasOwn(sourceLocalDefaults, 'fast')
          ? sourceLocalDefaults.fast.trim()
          : base.defaults.local.fast,
        embeddings: hasOwn(sourceLocalDefaults, 'embeddings')
          ? sourceLocalDefaults.embeddings.trim()
          : base.defaults.local.embeddings
      }
    }
  };

  const providerIds = new Set([
    ...Object.keys(base.providers),
    ...Object.keys(source.providers || {}),
  ]);
  for (const providerId of [...providerIds].sort((left, right) => left.localeCompare(right))) {
    catalog.providers[providerId] = normalizeProviderConfig(
      providerId,
      source.providers?.[providerId],
      base.providers[providerId],
    );
  }

  Object.assign(
    catalog.defaults.embeddings,
    requireDefaultModelPair(
      requestedEmbeddingProvider,
      requestedEmbeddingModel,
      catalog,
      'embedding',
    ),
  );

  catalog.defaults.queryModel = resolveDefaultModel(
    source.defaults?.queryModel,
    base.defaults.queryModel,
    catalog,
    'chat'
  );
  catalog.defaults.pgsSweepModel = resolveDefaultModel(
    source.defaults?.pgsSweepModel,
    base.defaults.pgsSweepModel,
    catalog,
    'chat'
  );
  catalog.defaults.launch.primary = resolveNestedDefaultModel(
    sourceLaunchDefaults,
    'primary',
    base.defaults.launch.primary,
    catalog,
    'chat'
  );
  catalog.defaults.launch.fast = resolveNestedDefaultModel(
    sourceLaunchDefaults,
    'fast',
    base.defaults.launch.fast,
    catalog,
    'chat'
  );
  catalog.defaults.launch.strategic = resolveNestedDefaultModel(
    sourceLaunchDefaults,
    'strategic',
    base.defaults.launch.strategic,
    catalog,
    'chat'
  );

  return validateSelectableModelCapabilities(catalog);
}

function loadModelCatalogSync() {
  const catalogPath = getModelCatalogPath();
  let serialized;
  try {
    serialized = fs.readFileSync(catalogPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        if (isTrulyAbsentCatalogPath(catalogPath)) {
          return normalizeModelCatalog();
        }
      } catch (pathError) {
        throw modelCatalogError(
          `Invalid model catalog at ${catalogPath}: ${pathError.message}`,
          pathError,
        );
      }
    }
    throw modelCatalogError(
      `Invalid model catalog at ${catalogPath}: ${error.message}`,
      error,
    );
  }

  let raw;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    throw modelCatalogError(
      `Invalid model catalog at ${catalogPath}: ${error.message}`,
      error,
    );
  }
  return normalizeModelCatalog(raw);
}

function fsyncDirectorySync(directory) {
  const directoryFd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function injectedCatalogCrash(point) {
  throw Object.assign(new Error(`injected model catalog crash at ${point}`), {
    code: 'model_catalog_write_interrupted',
    retryable: true,
  });
}

function saveModelCatalogSync(input, options = {}) {
  const catalogPath = getModelCatalogPath();
  const normalized = normalizeModelCatalog(input);
  const directory = path.dirname(catalogPath);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(catalogPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let tempFd = null;
  let renamed = false;
  try {
    tempFd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(tempFd, serialized, 'utf8');
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = null;
    if (options?._testCrashAt === 'before-rename') injectedCatalogCrash('before-rename');
    fs.renameSync(tempPath, catalogPath);
    renamed = true;
    if (options?._testCrashAt === 'after-rename') injectedCatalogCrash('after-rename');
    fsyncDirectorySync(directory);
  } finally {
    if (tempFd !== null) fs.closeSync(tempFd);
    if (!renamed) {
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return normalized;
}

function listCatalogModels(catalog, options = {}) {
  const source = catalog ? normalizeModelCatalog(catalog) : loadModelCatalogSync();
  return flattenCatalogModels(source, options);
}

function inferProviderFromModel(modelId, catalog = null) {
  const normalized = String(modelId || '').trim();
  if (!normalized) {
    return null;
  }

  const lookup = listCatalogModels(catalog || loadModelCatalogSync());
  const exact = lookup.find(model => model.id === normalized);
  if (exact) {
    return exact.provider;
  }

  const lowered = normalized.toLowerCase();
  if (lowered.startsWith('claude')) return 'anthropic';
  if (normalized.startsWith('MiniMax-')) return 'minimax';
  if (lowered.startsWith('grok')) return 'xai';
  if (lowered.startsWith('gpt') || lowered.startsWith('o1') || lowered.startsWith('o3') || lowered.startsWith('o4')) {
    return 'openai';
  }
  // Ollama Cloud models — hosted at ollama.com (not available locally)
  if (
    lowered.startsWith('nemotron') ||
    lowered.startsWith('kimi-k2') ||
    lowered.startsWith('cogito') ||
    lowered.startsWith('minimax') ||
    lowered.startsWith('devstral') ||
    lowered.startsWith('deepseek-v4') ||
    lowered.startsWith('gpt-oss') ||
    lowered.startsWith('glm-') ||
    lowered.startsWith('gemma4') ||
    lowered.startsWith('mistral-large') ||
    lowered.startsWith('ministral') ||
    lowered.startsWith('qwen3.5') ||
    lowered.startsWith('qwen3-coder') ||
    lowered.startsWith('qwen3-next') ||
    lowered.startsWith('qwen3-vl') ||
    lowered.startsWith('rnj-')
  ) {
    return 'ollama-cloud';
  }
  if (
    lowered.startsWith('qwen') ||
    lowered.startsWith('llama') ||
    lowered.startsWith('mistral') ||
    lowered.startsWith('mixtral') ||
    lowered.startsWith('deepseek') ||
    lowered.startsWith('codellama') ||
    lowered.startsWith('nomic') ||
    lowered.startsWith('mxbai') ||
    lowered.startsWith('all-minilm') ||
    lowered.includes(':')
  ) {
    return 'ollama';
  }
  return null;
}

function getCatalogDefaults(catalog = null) {
  const source = catalog ? normalizeModelCatalog(catalog) : loadModelCatalogSync();
  return deepClone(source.defaults);
}

function getEmbeddingConfig(catalog = null) {
  const defaults = getCatalogDefaults(catalog);
  return deepClone(defaults.embeddings || BUILTIN_MODEL_CATALOG.defaults.embeddings);
}

/**
 * Resolve one explicitly configured provider/model assignment without model
 * inference or fallback. Research compilation uses this at the protected
 * worker boundary so two providers may safely expose the same model label.
 */
function resolveExactConfiguredPair(catalog, configuredAgents, assignmentKey) {
  if (!isPlainRecord(configuredAgents)
      || typeof assignmentKey !== 'string'
      || !assignmentKey.trim()
      || !hasOwn(configuredAgents, assignmentKey)) {
    throw Object.assign(new Error(`Missing exact model assignment: ${String(assignmentKey)}`), {
      code: 'model_assignment_invalid',
      retryable: false,
    });
  }
  const assignment = configuredAgents[assignmentKey];
  if (!isPlainRecord(assignment)
      || typeof assignment.provider !== 'string'
      || !assignment.provider.trim()
      || typeof assignment.model !== 'string'
      || !assignment.model.trim()) {
    throw Object.assign(new Error(`Invalid exact model assignment: ${assignmentKey}`), {
      code: 'model_assignment_invalid',
      retryable: false,
    });
  }
  const provider = assignment.provider.trim();
  const model = assignment.model.trim();
  getModelCapabilities(catalog, provider, model);
  return Object.freeze({ provider, model });
}

module.exports = {
  BUILTIN_EXECUTION_DEFAULTS,
  BUILTIN_MODEL_CATALOG,
  EXECUTION_TRANSPORTS,
  getModelCatalogPath,
  inferModelKind,
  normalizeProviderConfig,
  normalizeModelCatalog,
  loadModelCatalogSync,
  saveModelCatalogSync,
  validateSelectableModelCapabilities,
  getModelCapabilities,
  flattenCatalogModels,
  listCatalogModels,
  inferProviderFromModel,
  getCatalogDefaults,
  getEmbeddingConfig,
  resolveExactConfiguredPair,
};
