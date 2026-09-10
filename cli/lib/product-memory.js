/** Read-only detection of the optional local semantic-memory dependency.
 * Owned encoder readiness is GET /ready (warm inference). /api/tags is never ready.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import seedEmbedding from '../../shared/seed-embedding-config.cjs';
import { OWNED_PROFILE_ID, OWNED_RECIPE_HASH, probeOwnedReady } from './product-embedder.js';

async function readModels(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
  if (!response.ok) throw new Error('Model server unavailable');
  const text = await response.text();
  if (text.length > 512000) throw new Error('Model listing too large');
  return JSON.parse(text);
}

export async function inspectProductMemory(homeRoot, { request = readModels } = {}) {
  const path = join(homeRoot, 'app/config/home.yaml');
  if (!existsSync(path)) return { semanticStatus: 'unconfigured', warnings: [] };
  const config = yaml.load(readFileSync(path, 'utf8')) || {};
  const selected = config.embeddings?.providers?.find(item => item?.provider && item?.model);
  const warnings = [];
  const detections = new Map();
  async function detected(endpoint, model) {
    const key = `${endpoint}\0${model}`;
    if (!detections.has(key)) detections.set(key, (async () => {
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
        url.pathname = url.pathname.replace(/\/(?:api\/embeddings|v1\/?|api\/embed)\/?$/, '').replace(/\/$/, '') + '/api/tags';
        url.search = ''; url.hash = '';
        const listing = await request(url.href);
        const normalize = value => String(value || '').replace(/:latest$/, '');
        return Array.isArray(listing.models) && listing.models.some(item => normalize(item.name || item.model) === normalize(model));
      } catch { return false; }
    })());
    return detections.get(key);
  }
  let semanticStatus = 'not_detected';
  if (selected?.provider === 'home23-owned' || selected?.model === OWNED_PROFILE_ID) {
    const endpoint = selected.endpoint || config.substrate?.embedding?.endpoint || '';
    let port;
    try { port = Number(new URL(endpoint).port); } catch { port = config.embedder?.port; }
    const ready = await probeOwnedReady(port);
    if (ready.warm && ready.recipeId === OWNED_RECIPE_HASH) semanticStatus = 'ready';
    else warnings.push('Semantic memory is still preparing or unavailable. Conversations and text memory are retained. Resume preparation in Home23 Host — you do not install embedding tools yourself.');
  } else if (selected?.provider === 'ollama-local') {
    const endpoint = selected.endpoint || selected.baseUrl || config.providers?.['ollama-local']?.baseUrl || 'http://127.0.0.1:11434';
    if (await detected(endpoint, selected.model)) semanticStatus = 'model_detected';
    else warnings.push(`Semantic search needs the local ${selected.model} embedding model. Conversations and text memory are retained while it is unavailable.`);
  } else if (selected) {
    semanticStatus = 'configured_unverified';
    warnings.push(`Semantic search is configured for ${selected.provider}; Host has not verified that embedding service.`);
  } else warnings.push('Semantic search has no embedding service configured. Conversations and text memory are retained.');
  const env = seedEmbedding.resolveSeedEmbeddingEnv(config);
  const seedEndpoint = env.SEED_EMBED_ENDPOINT || 'http://127.0.0.1:11434/api/embeddings';
  const seedModel = env.SEED_EMBED_MODEL || 'nomic-embed-text';
  let seedDetected = false;
  if (seedModel === OWNED_PROFILE_ID || selected?.provider === 'home23-owned') {
    seedDetected = semanticStatus === 'ready';
  } else {
    seedDetected = await detected(seedEndpoint, seedModel);
    if (!seedDetected && semanticStatus !== 'not_detected') warnings.push('The Seed contact encoder needs its credential-free local embedding model. Its event history is retained while that model is unavailable.');
  }
  return { semanticStatus, seedSemanticStatus: seedDetected ? (semanticStatus === 'ready' ? 'ready' : 'model_detected') : 'not_detected', warnings };
}
