'use strict';

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
  if (typeof model !== 'string' || !model.trim() || model.length > 256 || model.includes('\0')) throw new Error('Invalid Seed embedding model');
  return { SEED_EMBED_ENDPOINT: endpoint.href, SEED_EMBED_MODEL: model };
}

module.exports = { resolveSeedEmbeddingEnv };
