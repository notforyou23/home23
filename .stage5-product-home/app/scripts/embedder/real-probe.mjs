#!/usr/bin/env node
/**
 * Real inference probe. Not a fixture. Encodes public corpus ids only.
 * Does not log prompt text.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedEmbedder } from './serve.mjs';
import { EXPECTED_DIM, OWNED_RECIPE_ID } from './recipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, '../embedder-experiment/corpus.json'), 'utf8'));
const ids = ['library_hours', 'rain_forecast', 'node_install', 'recycle_query', 'unrelated_geology'];

function l2(vec) {
  return Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0));
}

const cache = process.env.HOME23_EMBEDDER_CACHE;
if (!cache) {
  console.error(JSON.stringify({ event: 'fatal', code: 'unavailable', reason: 'cache-required' }));
  process.exit(1);
}

const port = Number.parseInt(process.env.HOME23_EMBEDDER_PORT || '28766', 10);
const service = await startOwnedEmbedder({
  port,
  bind: '127.0.0.1',
  cache,
  fetchIfMissing: process.env.HOME23_EMBEDDER_FETCH !== '0',
});

const host = { Host: `127.0.0.1:${port}` };
const ready = await fetch(`http://127.0.0.1:${port}/ready`, { headers: host });
const health = await ready.json();
const encodings = [];

for (const id of ids) {
  const text = corpus.texts[id];
  const seed = await fetch(`http://127.0.0.1:${port}/api/embeddings`, {
    method: 'POST',
    headers: { ...host, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OWNED_RECIPE_ID, prompt: text }),
  });
  const seedBody = await seed.json();
  encodings.push({
    id,
    protocol: 'ollama-native',
    status: seed.status,
    dim: Array.isArray(seedBody.embedding) ? seedBody.embedding.length : 0,
    finite: Array.isArray(seedBody.embedding) && seedBody.embedding.every((n) => Number.isFinite(n)),
    l2: Array.isArray(seedBody.embedding) ? Number(l2(seedBody.embedding).toFixed(6)) : null,
  });
}

const memory = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
  method: 'POST',
  headers: { ...host, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: OWNED_RECIPE_ID,
    input: ids.map((id) => corpus.texts[id]),
  }),
});
const memoryBody = await memory.json();

const evidence = {
  realInference: true,
  fixtureSubstituted: false,
  node: process.version,
  recipeId: health.recipeId,
  expectedRecipeId: OWNED_RECIPE_ID,
  dimension: health.dimension,
  expectedDimension: EXPECTED_DIM,
  warm: health.warm,
  readyStatus: ready.status,
  artifactDigests: health.artifactDigests,
  encodings,
  openaiBatch: {
    status: memory.status,
    count: Array.isArray(memoryBody.data) ? memoryBody.data.length : 0,
    dims: Array.isArray(memoryBody.data) ? memoryBody.data.map((row) => row.embedding?.length ?? 0) : [],
  },
  cacheReused: cache,
};

const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'stage3-real-inference.json');
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.error(JSON.stringify({ event: 'real-probe', outPath, recipeId: health.recipeId, warm: health.warm, dim: health.dimension }));
const ok = ready.status === 200
  && health.warm === true
  && health.recipeId === OWNED_RECIPE_ID
  && health.dimension === EXPECTED_DIM
  && encodings.every((row) => row.status === 200 && row.dim === EXPECTED_DIM && row.finite)
  && memory.status === 200
  && evidence.openaiBatch.dims.every((dim) => dim === EXPECTED_DIM);
try { await service.close(); } catch { /* ignore listen close */ }
process.exit(ok ? 0 : 1);
