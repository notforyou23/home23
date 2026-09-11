import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createEmbedderServer } from '../../scripts/embedder/serve.mjs';
import { MEMORY_TRUNCATION_CHARS } from '../../shared/semantic-encoder-contract.cjs';
import { OWNED_PROFILE, OWNED_RECIPE_ID, EXPECTED_DIM } from '../../scripts/embedder/recipe.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.once('error', reject);
  });
}

async function listenOnAllowedPort(embed, { failAfter } = {}) {
  let port;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    port = await freePort();
    if (port >= 20000 && port <= 60999 && port !== 11435) break;
  }
  const seen = [];
  let calls = 0;
  const service = createEmbedderServer({
    async embed(text) {
      seen.push(text);
      calls += 1;
      if (failAfter && calls > failAfter) {
        throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      }
      return new Array(EXPECTED_DIM).fill(0.01);
    },
    artifactDigests: { 'onnx/model.onnx': 'abc' },
    port,
  });
  await service.listen();
  return { service, port, seen };
}

function headers(port) {
  return { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
}

test('owned encode truncates to the Memory recipe cap', async () => {
  const { service, port, seen } = await listenOnAllowedPort();
  try {
    const prompt = 'x'.repeat(MEMORY_TRUNCATION_CHARS + 400);
    const response = await fetch(`http://127.0.0.1:${port}/api/embeddings`, {
      method: 'POST',
      headers: headers(port),
      body: JSON.stringify({ model: OWNED_PROFILE, prompt }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen[0].length, MEMORY_TRUNCATION_CHARS);
  } finally {
    await service.close();
  }
});

test('encode failure clears warm and /ready re-encodes while warm', async () => {
  const { service, port, seen } = await listenOnAllowedPort(undefined, { failAfter: 2 });
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/embeddings`, {
      method: 'POST',
      headers: headers(port),
      body: JSON.stringify({ model: OWNED_PROFILE, prompt: 'The library opens at nine.' }),
    });
    assert.equal(ok.status, 200);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`, { headers: headers(port) });
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.warm, true);
    assert.equal(readyBody.recipeId, OWNED_RECIPE_ID);
    assert.ok(seen.length >= 2, 'GET /ready must run a finite re-encode');

    const failed = await fetch(`http://127.0.0.1:${port}/api/embeddings`, {
      method: 'POST',
      headers: headers(port),
      body: JSON.stringify({ model: OWNED_PROFILE, prompt: 'The granite cooled slowly.' }),
    });
    assert.equal(failed.status, 503);
    const cold = await fetch(`http://127.0.0.1:${port}/ready`, { headers: headers(port) });
    assert.equal(cold.status, 503);
    const coldBody = await cold.json();
    assert.equal(coldBody.warm, false);
  } finally {
    await service.close();
  }
});
