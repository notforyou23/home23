import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { inspectProductMemory } from '../../cli/lib/product-memory.js';
import { OWNED_PROFILE_ID, OWNED_RECIPE_HASH } from '../../cli/lib/product-embedder.js';

function home(t, config) {
  const root = mkdtempSync(join(tmpdir(), 'h23-memory-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'app/config'), { recursive: true });
  writeFileSync(join(root, 'app/config/home.yaml'), yaml.dump(config));
  return root;
}

test('Host detects its configured local embedding model without dropping text memory', async t => {
  const endpoint = 'http://127.0.0.1:21400/api/embeddings';
  const root = home(t, { embeddings: { providers: [{ provider: 'ollama-local', model: 'nomic-embed-text', endpoint }] },
    substrate: { embedding: { endpoint, model: 'nomic-embed-text' } } });
  let present = true, requests = 0;
  const deps = { request: async url => {
    requests++; assert.equal(url, 'http://127.0.0.1:21400/api/tags');
    return { models: present ? [{ name: 'nomic-embed-text:latest' }] : [] };
  }, probe: async () => assert.fail('Legacy encoders do not use the owned probe') };
  assert.deepEqual(await inspectProductMemory(root, deps), { semanticStatus: 'model_detected', seedSemanticStatus: 'model_detected', warnings: [] });
  assert.equal(requests, 1, 'engine and Seed share the bounded model probe');
  present = false;
  const unavailable = await inspectProductMemory(root, deps);
  assert.equal(unavailable.semanticStatus, 'not_detected');
  assert.match(unavailable.warnings[0], /text memory are retained/);
});

test('owned readiness requires a warm probe and never treats model listing as warm', async t => {
  const endpoint = 'http://127.0.0.1:21401/api/embeddings';
  const root = home(t, { embedder: { owned: true, port: 21401 },
    embeddings: { providers: [{ provider: 'home23-owned', model: OWNED_PROFILE_ID, endpoint }] },
    substrate: { embedding: { endpoint, model: OWNED_PROFILE_ID } } });
  let warm = false, requests = 0;
  const deps = { request: async () => assert.fail('Owned encoders use /ready'), probe: async port => {
    requests++; assert.equal(port, 21401); return { warm, recipeId: OWNED_RECIPE_HASH };
  } };
  assert.equal((await inspectProductMemory(root, deps)).semanticStatus, 'not_detected');
  warm = true;
  const live = await inspectProductMemory(root, deps);
  assert.equal(live.semanticStatus, 'ready'); assert.equal(live.seedSemanticStatus, 'ready');
  assert.equal(requests, 2, 'each inspection shares the engine/Seed readiness probe');
});

test('enabling owned memory preserves independent legacy Seed status', async t => {
  const root = home(t, { embeddings: { providers: [{ provider: 'home23-owned', model: OWNED_PROFILE_ID,
    endpoint: 'http://127.0.0.1:21402/api/embeddings' }] },
    substrate: { embedding: { endpoint: 'http://127.0.0.1:11434/api/embeddings', model: 'nomic-embed-text' } } });
  let seedPresent = false;
  const deps = { probe: async port => { assert.equal(port, 21402); return { warm: true, recipeId: OWNED_RECIPE_HASH }; },
    request: async url => { assert.equal(url, 'http://127.0.0.1:11434/api/tags'); return { models: seedPresent ? [{ name: 'nomic-embed-text' }] : [] }; } };
  const status = await inspectProductMemory(root, deps);
  assert.equal(status.semanticStatus, 'ready'); assert.equal(status.seedSemanticStatus, 'not_detected');
  seedPresent = true;
  assert.equal((await inspectProductMemory(root, deps)).seedSemanticStatus, 'model_detected');
});
