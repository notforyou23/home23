import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEmbedderServer } from './serve.mjs';
import { EXPECTED_DIM, OWNED_PROFILE, OWNED_RECIPE_ID } from './recipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const health = JSON.parse(readFileSync(join(here, 'schema/health.json'), 'utf8'));
const contract = JSON.parse(readFileSync(join(here, 'process-contract.json'), 'utf8'));
const vec = Array.from({ length: EXPECTED_DIM }, (_, i) => (i === 0 ? 1 : 0));

async function withServer(fn) {
  const service = createEmbedderServer({
    embed: async () => vec,
    artifactDigests: { 'onnx/model.onnx': '147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965' },
    port: 28765,
    bind: '127.0.0.1',
  });
  await service.listen();
  service.markWarm();
  try {
    return await fn('http://127.0.0.1:28765');
  } finally {
    await service.close();
  }
}

test('process contract freezes argv, env, port key, health path', () => {
  assert.deepEqual(contract.argv, ['node', 'scripts/embedder/serve.mjs']);
  assert.equal(contract.portKey, 'embedder');
  assert.equal(contract.healthPath, '/ready');
  assert.equal(contract.bind, '127.0.0.1');
  assert.ok(contract.forbiddenPorts.includes(11435));
  assert.match(contract.env.HOME23_EMBEDDER_CACHE, /Required/);
  assert.match(contract.env.HOME23_EMBEDDER_CACHE, /Not ~\//);
  assert.equal(contract.recipeId, OWNED_RECIPE_ID);
});

test('fixture HTTP: owned model both shapes; legacy alias rejected; tags not ready', async () => {
  await withServer(async (base) => {
    const tooShort = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:28765', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OWNED_RECIPE_ID, prompt: 'Thanks!' }),
    });
    assert.equal(tooShort.status, 400);
    assert.equal((await tooShort.json()).error.code, 'too_short');

    const denied = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:28765', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'The library opens at nine.' }),
    });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, 'recipe_mismatch');

    const seed = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:28765', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OWNED_RECIPE_ID, prompt: 'The library opens at nine.' }),
    });
    assert.equal(seed.status, 200);
    const seedBody = await seed.json();
    assert.equal(seedBody.embedding.length, 768);

    const memory = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:28765', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OWNED_PROFILE, input: ['The library opens at nine.'] }),
    });
    assert.equal(memory.status, 200);
    const memoryBody = await memory.json();
    assert.equal(memoryBody.data[0].embedding.length, 768);

    const origin = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { Host: '127.0.0.1:28765', Origin: 'https://example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OWNED_RECIPE_ID, prompt: 'The library opens at nine.' }),
    });
    assert.equal(origin.status, 403);

    const ready = await fetch(`${base}/ready`, { headers: { Host: '127.0.0.1:28765' } });
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.recipeId, OWNED_RECIPE_ID);
    assert.equal(readyBody.dimension, 768);
    assert.equal(readyBody.warm, true);

    const tags = await fetch(`${base}/api/tags`, { headers: { Host: '127.0.0.1:28765' } });
    const tagsBody = await tags.json();
    assert.ok(Array.isArray(tagsBody.models));
    assert.notEqual(health.notReady.includes('/api/tags'), false);
  });
});
