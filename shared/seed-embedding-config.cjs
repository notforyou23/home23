'use strict';

const {
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  OWNED_EMBEDDING_RECIPE_ID,
  resolveWriterRecipe,
} = require('./semantic-encoder-contract.cjs');

const KNOWN_SEED_EMBED_MODELS = new Set([
  'nomic-embed-text',
  'nomic-embed-text:latest',
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  OWNED_EMBEDDING_RECIPE_ID,
]);

function looksLikeEncoderIdentity(model) {
  return /^(nomic-embed|legacy-ollama|owned-nomic)/.test(model) || /^[0-9a-f]{64}$/.test(model);
}

function assertSeedEmbedModel(model) {
  if (typeof model !== 'string' || !model.trim() || model.length > 256 || model.includes('\0')) {
    throw new Error('Invalid Seed embedding model');
  }
  if (looksLikeEncoderIdentity(model) && !KNOWN_SEED_EMBED_MODELS.has(model)) {
    throw new Error('Unknown Seed embedding model');
  }
}

/** The Seed's contact encoder is credential-free and uses 768-dimensional
 * local embeddings. Configuration is shared by harness and substrate feeds;
 * it never imports the paid-provider credentials used by the cognitive engine.
 */
function resolveSeedEmbeddingEnv(homeConfig = {}) {
  const config = homeConfig.substrate?.embedding;
  if (!config) return {};
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Seed embedding configuration');
  const endpoint = new URL(config.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Seed embedding endpoint must be credential-free HTTP or HTTPS');
  }
  if (config.apiKey || config.token || config.headers) throw new Error('Seed embedding configuration cannot carry credentials');
  const model = config.model || 'nomic-embed-text';
  assertSeedEmbedModel(model);
  const recipeId = typeof config.recipeId === 'string' && config.recipeId.trim()
    ? config.recipeId.trim()
    : model;
  if (recipeId !== model) assertSeedEmbedModel(recipeId);
  return {
    SEED_EMBED_ENDPOINT: endpoint.href,
    SEED_EMBED_MODEL: model,
    SEED_EMBED_RECIPE_ID: resolveWriterRecipe(recipeId).hash,
  };
}

module.exports = { resolveSeedEmbeddingEnv, assertSeedEmbedModel, KNOWN_SEED_EMBED_MODELS };
