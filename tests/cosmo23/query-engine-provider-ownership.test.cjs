'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const QUERY_ENGINE_PATH = path.resolve(__dirname, '../../cosmo23/lib/query-engine.js');

function catalog() {
  return {
    version: 1,
    providers: {
      alpha: {
        models: [{
          id: 'answer-model', kind: 'chat', transport: 'responses',
          maxOutputTokens: 128, providerStallMs: 30_000,
        }],
      },
    },
    defaults: {},
  };
}

test('QueryEngine contains no provider constructors, model inference, or raw Codex fetch path', () => {
  const source = fs.readFileSync(QUERY_ENGINE_PATH, 'utf8');
  assert.doesNotMatch(source, /require\(['"]openai['"]\)/);
  assert.doesNotMatch(source, /new\s+(?:GPT5Client|AnthropicClient|ChatCompletionsClient|OpenAI)\b/);
  assert.doesNotMatch(source, /inferProviderFromModel\b/);
  assert.doesNotMatch(source, /_getCodexCredentials\b/);
  assert.doesNotMatch(source, /chatgpt\.com\/backend-api\/codex\/responses/);
});

test('legacy-path construction receives the exact registry and cannot reach global fetch', async t => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-query-registry-only-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const client = { providerId: 'alpha', async generate() { throw new Error('not called'); } };
  const registry = {
    get(provider, model) {
      assert.equal(provider, 'alpha');
      assert.equal(model, 'answer-model');
      return client;
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('global fetch is forbidden'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[QUERY_ENGINE_PATH];
  const { QueryEngine } = require(QUERY_ENGINE_PATH);
  const engine = new QueryEngine(runtimeDir, 'ignored-provider-key', {
    providerRegistry: registry,
    modelCatalog: catalog(),
    embeddingClient: null,
  });
  const runtime = engine.resolveQueryRuntime('answer-model', 'alpha');
  assert.equal(runtime.client, client);
  assert.equal(runtime.providerId, 'alpha');
  assert.equal(runtime.effectiveModel, 'answer-model');
  assert.throws(
    () => engine.resolveQueryRuntime('answer-model'),
    error => error.code === 'provider_model_mismatch',
  );
});
