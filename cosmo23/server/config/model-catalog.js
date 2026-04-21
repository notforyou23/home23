const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../../lib/config-loader-sync');

const MODEL_CATALOG_FILE_NAME = 'model-catalog.json';

const BUILTIN_MODEL_CATALOG = {
  version: 1,
  providers: {
    openai: {
      label: 'OpenAI',
      models: [
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', kind: 'chat' },
        { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', kind: 'chat' },
        { id: 'gpt-5.2', label: 'GPT-5.2', kind: 'chat' },
        { id: 'gpt-5-mini', label: 'GPT-5 mini', kind: 'chat' },
        { id: 'gpt-4o', label: 'GPT-4o', kind: 'chat' },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini', kind: 'chat' },
        { id: 'text-embedding-3-small', label: 'text-embedding-3-small', kind: 'embedding' }
      ]
    },
    'ollama-cloud': {
      label: 'Ollama Cloud',
      models: [
        { id: 'qwen3.5:397b', label: 'Qwen 3.5 397B', kind: 'chat' },
        { id: 'kimi-k2.6', label: 'Kimi K2.6', kind: 'chat' },
        { id: 'nemotron-3-super', label: 'Nemotron 3 Super 120B', kind: 'chat' },
        { id: 'minimax-m2.7', label: 'Minimax M2.7', kind: 'chat' },
        { id: 'glm-5', label: 'GLM-5 744B', kind: 'chat' },
        { id: 'qwen3-coder-next', label: 'Qwen 3 Coder Next', kind: 'chat' },
        { id: 'qwen3-next:80b', label: 'Qwen 3 Next 80B', kind: 'chat' },
        { id: 'mistral-large-3:675b', label: 'Mistral Large 3 675B', kind: 'chat' },
        { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', kind: 'chat' },
        { id: 'qwen3-vl:235b', label: 'Qwen 3 VL 235B', kind: 'chat' },
        { id: 'devstral-small-2:24b', label: 'Devstral Small 2 24B', kind: 'chat' },
        { id: 'nemotron-3-nano:30b', label: 'Nemotron 3 Nano 30B', kind: 'chat' },
        { id: 'ministral-3:14b', label: 'Ministral 3 14B', kind: 'chat' },
        { id: 'minimax-m2.5', label: 'Minimax M2.5', kind: 'chat' },
        { id: 'rnj-1:8b', label: 'Rnj-1 8B', kind: 'chat' }
      ]
    },
    anthropic: {
      label: 'Anthropic',
      models: [
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'chat' },
        { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', kind: 'chat' },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', kind: 'chat' },
        { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', kind: 'chat' }
      ]
    },
    minimax: {
      label: 'MiniMax',
      models: [
        { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', kind: 'chat' },
        { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', kind: 'chat' },
        { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', kind: 'chat' },
        { id: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed', kind: 'chat' },
        { id: 'MiniMax-M2.1', label: 'MiniMax M2.1', kind: 'chat' },
        { id: 'MiniMax-M2.1-highspeed', label: 'MiniMax M2.1 Highspeed', kind: 'chat' },
        { id: 'MiniMax-M2', label: 'MiniMax M2', kind: 'chat' }
      ]
    },
    xai: {
      label: 'xAI',
      models: [
        { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning', kind: 'chat' },
        { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 Non-Reasoning', kind: 'chat' },
        { id: 'grok-4.20-multi-agent', label: 'Grok 4.20 Multi-Agent', kind: 'responses' },
        { id: 'grok-4-1-fast-reasoning', label: 'Grok 4.1 Fast Reasoning', kind: 'chat' },
        { id: 'grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast Non-Reasoning', kind: 'chat' },
        { id: 'grok-code-fast-1', label: 'Grok Code Fast 1', kind: 'chat' },
        { id: 'grok-2', label: 'Grok 2', kind: 'chat' }
      ]
    },
    'openai-codex': {
      label: 'OpenAI Codex',
      models: [
        { id: 'gpt-5.2', label: 'GPT-5.2', kind: 'chat' },
        { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', kind: 'chat' },
        { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', kind: 'chat' }
      ]
    }
  },
  defaults: {
    queryModel: 'gpt-5.2',
    pgsSweepModel: null,
    launch: {
      primary: 'gpt-5.2',
      fast: 'gpt-5-mini',
      strategic: 'gpt-5.2'
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

function getModelCatalogPath() {
  return process.env.COSMO23_MODEL_CATALOG_PATH || path.join(getConfigDir(), MODEL_CATALOG_FILE_NAME);
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
    id,
    label: String(entry.label || id).trim(),
    kind: inferModelKind(id, entry.kind),
    provider: providerId
  };
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter(model => {
    if (!model?.id || seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

function normalizeProviderConfig(providerId, providerConfig = {}, fallbackConfig = {}) {
  const normalizedModels = Array.isArray(providerConfig.models)
    ? providerConfig.models.map(model => normalizeModelEntry(model, providerId)).filter(Boolean)
    : fallbackConfig.models.map(model => normalizeModelEntry(model, providerId)).filter(Boolean);

  return {
    label: String(providerConfig.label || fallbackConfig.label || providerId),
    models: dedupeModels(normalizedModels)
  };
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

function normalizeModelCatalog(input = null) {
  const base = deepClone(BUILTIN_MODEL_CATALOG);
  const source = input && typeof input === 'object' ? input : {};
  const requestedEmbeddingModel = source.defaults?.embeddings?.model;
  const requestedEmbeddingDimensions = Number.parseInt(source.defaults?.embeddings?.dimensions, 10);

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
        provider: base.defaults.embeddings.provider,
        model: base.defaults.embeddings.model,
        dimensions: Number.isFinite(requestedEmbeddingDimensions) && requestedEmbeddingDimensions > 0
          ? requestedEmbeddingDimensions
          : base.defaults.embeddings.dimensions
      },
      local: {
        primary: String(source.defaults?.local?.primary || base.defaults.local.primary),
        fast: String(source.defaults?.local?.fast || base.defaults.local.fast),
        embeddings: String(source.defaults?.local?.embeddings || base.defaults.local.embeddings)
      }
    }
  };

  for (const providerId of Object.keys(base.providers)) {
    catalog.providers[providerId] = normalizeProviderConfig(
      providerId,
      source.providers?.[providerId],
      base.providers[providerId]
    );
  }

  catalog.defaults.embeddings.model = resolveDefaultModel(
    requestedEmbeddingModel,
    base.defaults.embeddings.model,
    catalog,
    'embedding'
  ) || base.defaults.embeddings.model;

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
  catalog.defaults.launch.primary = resolveDefaultModel(
    source.defaults?.launch?.primary,
    base.defaults.launch.primary,
    catalog,
    'chat'
  );
  catalog.defaults.launch.fast = resolveDefaultModel(
    source.defaults?.launch?.fast,
    base.defaults.launch.fast,
    catalog,
    'chat'
  );
  catalog.defaults.launch.strategic = resolveDefaultModel(
    source.defaults?.launch?.strategic,
    base.defaults.launch.strategic,
    catalog,
    'chat'
  );

  return catalog;
}

function loadModelCatalogSync() {
  const catalogPath = getModelCatalogPath();
  try {
    if (!fs.existsSync(catalogPath)) {
      return normalizeModelCatalog();
    }

    const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    return normalizeModelCatalog(raw);
  } catch (error) {
    console.warn('[ModelCatalog] Failed to load catalog, using built-ins:', error.message);
    return normalizeModelCatalog();
  }
}

function saveModelCatalogSync(input) {
  const catalogPath = getModelCatalogPath();
  const normalized = normalizeModelCatalog(input);
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(normalized, null, 2), 'utf8');
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
    lowered.startsWith('gpt-oss') ||
    lowered.startsWith('glm-')
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

module.exports = {
  BUILTIN_MODEL_CATALOG,
  getModelCatalogPath,
  inferModelKind,
  normalizeModelCatalog,
  loadModelCatalogSync,
  saveModelCatalogSync,
  listCatalogModels,
  inferProviderFromModel,
  getCatalogDefaults,
  getEmbeddingConfig
};
