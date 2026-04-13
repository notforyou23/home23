const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.evobrew');
const CACHE_PATH = path.join(CACHE_DIR, 'model-catalog-cache.json');

const PRE_RELEASE_PATTERN = /(preview|beta|alpha|experimental|nightly|snapshot|rc\b|dev\b|test\b)/i;

let inMemoryCache = null;

function ensureCacheLoaded() {
  if (inMemoryCache) return inMemoryCache;

  try {
    if (fs.existsSync(CACHE_PATH)) {
      inMemoryCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch (error) {
    console.warn('[ModelCatalog] Failed to read cache:', error.message);
  }

  if (!inMemoryCache || typeof inMemoryCache !== 'object') {
    inMemoryCache = { providers: {} };
  }

  if (!inMemoryCache.providers || typeof inMemoryCache.providers !== 'object') {
    inMemoryCache.providers = {};
  }

  return inMemoryCache;
}

function persistCache() {
  const cache = ensureCacheLoaded();

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.warn('[ModelCatalog] Failed to persist cache:', error.message);
  }
}

function normalizeModelIds(models = []) {
  const seen = new Set();
  const normalized = [];

  for (const model of models) {
    const value = String(model || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function compareNaturalDescending(left, right) {
  const tokenize = (value) => String(value || '').toLowerCase().match(/\d+|\D+/g) || [];
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  const length = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < length; index += 1) {
    const a = leftTokens[index];
    const b = rightTokens[index];
    if (a === undefined) return 1;
    if (b === undefined) return -1;

    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;

    if (aNumber !== null && bNumber !== null) {
      if (aNumber !== bNumber) {
        return bNumber - aNumber;
      }
      continue;
    }

    const compared = b.localeCompare(a);
    if (compared !== 0) return compared;
  }

  return 0;
}

function isStableModelId(modelId) {
  return !PRE_RELEASE_PATTERN.test(String(modelId || ''));
}

function sortDiscoveredModels(providerId, models = []) {
  const normalized = normalizeModelIds(models);

  normalized.sort((left, right) => {
    const leftStable = isStableModelId(left);
    const rightStable = isStableModelId(right);
    if (leftStable !== rightStable) {
      return leftStable ? -1 : 1;
    }

    const provider = String(providerId || '').trim();
    if (provider === 'openai-codex') {
      const leftCodex = /codex/i.test(left);
      const rightCodex = /codex/i.test(right);
      if (leftCodex !== rightCodex) {
        return leftCodex ? -1 : 1;
      }
    }

    if (provider === 'xai') {
      const leftFast = /fast/i.test(left);
      const rightFast = /fast/i.test(right);
      if (leftFast !== rightFast) {
        return leftFast ? -1 : 1;
      }
    }

    return compareNaturalDescending(left, right);
  });

  return normalized;
}

function pickAliasTarget(models, predicate) {
  return models.find((model) => isStableModelId(model) && predicate(model)) ||
    models.find(predicate) ||
    null;
}

function buildModelAliases(providerId, models = []) {
  const sorted = sortDiscoveredModels(providerId, models);
  const aliases = [];
  const addAlias = (id, label, predicate) => {
    const target = pickAliasTarget(sorted, predicate);
    if (!target || aliases.some((entry) => entry.id === id)) return;
    aliases.push({ id, label, target });
  };

  addAlias('latest', 'Latest', () => true);
  addAlias('latest-stable', 'Latest Stable', () => true);

  switch (String(providerId || '').trim()) {
    case 'anthropic':
      addAlias('latest-sonnet', 'Latest Sonnet', (model) => /claude-sonnet/i.test(model));
      addAlias('latest-opus', 'Latest Opus', (model) => /claude-opus/i.test(model));
      addAlias('latest-haiku', 'Latest Haiku', (model) => /claude-haiku/i.test(model));
      break;
    case 'openai':
      addAlias('latest-reasoning', 'Latest Reasoning', (model) => /^o[134]/i.test(model) || /gpt-5/i.test(model));
      addAlias('latest-mini', 'Latest Mini', (model) => /mini/i.test(model));
      addAlias('latest-nano', 'Latest Nano', (model) => /nano/i.test(model));
      break;
    case 'openai-codex':
      addAlias('latest-codex', 'Latest Codex', () => true);
      addAlias('latest-mini', 'Latest Mini', (model) => /mini/i.test(model));
      addAlias('latest-nano', 'Latest Nano', (model) => /nano/i.test(model));
      break;
    case 'xai':
      addAlias('latest-fast', 'Latest Fast', (model) => /fast/i.test(model));
      addAlias('latest-reasoning', 'Latest Reasoning', (model) => /reason/i.test(model));
      addAlias('latest-4-20', 'Latest 4.20', (model) => /4[._-]?20/i.test(model) && !/(multi-agent|reason)/i.test(model));
      addAlias('latest-4-20-moe', 'Latest 4.20 MoE', (model) => /4[._-]?20/i.test(model) && /(multi-agent|moe)/i.test(model));
      break;
    case 'ollama-cloud':
      addAlias('latest-coder', 'Latest Coder', (model) => /coder/i.test(model));
      addAlias('latest-kimi', 'Latest Kimi', (model) => /kimi/i.test(model));
      addAlias('latest-minimax', 'Latest MiniMax', (model) => /minimax/i.test(model));
      addAlias('latest-nemotron', 'Latest Nemotron', (model) => /nemotron/i.test(model));
      break;
    default:
      break;
  }

  return aliases;
}

function getCachedProviderModels(providerId, maxAgeMs) {
  const cache = ensureCacheLoaded();
  const entry = cache.providers[String(providerId || '').trim()];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) {
    return null;
  }

  const fetchedAt = Number(entry.fetchedAt || 0);
  if (maxAgeMs && fetchedAt > 0 && (Date.now() - fetchedAt) > maxAgeMs) {
    return null;
  }

  return sortDiscoveredModels(providerId, entry.models);
}

function setCachedProviderModels(providerId, models, metadata = {}) {
  const cache = ensureCacheLoaded();
  cache.providers[String(providerId || '').trim()] = {
    models: sortDiscoveredModels(providerId, models),
    fetchedAt: Date.now(),
    metadata: {
      source: metadata.source || 'live',
      ttlMs: metadata.ttlMs || null
    }
  };
  persistCache();
}

module.exports = {
  buildModelAliases,
  getCachedProviderModels,
  isStableModelId,
  setCachedProviderModels,
  sortDiscoveredModels
};
