import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LEGACY_EMBEDDER_ID, OWNED_EMBEDDER_ID,
  resolveEmbeddingConfig, embeddingId, createEmbeddingProvider: createProvider,
} = require('../../../engine/src/memory/embedding-provider.js');
const {
  OWNED_EMBEDDING_PROFILE, OWNED_EMBEDDING_RECIPE_ID,
} = require('../../../shared/semantic-encoder-contract.cjs');

const vector = (a = 3, b = 4, dimensions = 768) => [a, b, ...Array(dimensions - 2).fill(0)];
const ok = body => ({ ok: true, status: 200, json: async () => body });
const geminiReply = count => ok({ embeddings: Array.from({ length: count }, () => ({ values: vector() })) });
const geminiEnv = { GEMINI_API_KEY: 'a-private-test-key' };
const geminiConfig = { provider: 'gemini', maxRetries: 0 };
// Tests never consult installation credentials. The explicit file-reader test
// below supplies its own in-memory fake rather than a filesystem path.
const createEmbeddingProvider = (config, deps = {}) => createProvider(config,
  deps.readFileSync ? deps : { secrets: {}, ...deps });

test('default memory config keeps the Ollama model, dimensions, batch limit and no fallback', async () => {
  const config = resolveEmbeddingConfig({}, {});
  assert.equal(embeddingId(config), LEGACY_EMBEDDER_ID);
  assert.equal(config.provider, 'ollama');
  assert.equal(config.dimensions, 768);
  assert.equal(config.batchSize, 2048);
  assert.equal(config.fallback, 'none');
  assert.equal(config.pricePerMillionTokens, 0.20);
  const requests = [];
  const provider = createEmbeddingProvider({}, {
    env: {},
    getEmbeddingClient: () => ({ embeddings: { create: async request => {
      requests.push(request);
      return { data: [{ index: 0, embedding: [3, 4] }] };
    } } }),
    fetch: async () => { throw new Error('A default provider must not use fetch.'); },
  });
  // Existing SDK vectors are passed through without normalization or dimension changes.
  assert.deepEqual(await provider.embed('legacy input'), [3, 4]);
  assert.deepEqual(requests, [{ model: 'nomic-embed-text', input: 'legacy input', dimensions: 768, encoding_format: 'float' }]);
});

test('explicit Gemini ignores inherited Seed/product Ollama configuration', () => {
  const config = resolveEmbeddingConfig({ provider: 'gemini' }, {
    EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_MODEL: 'nomic-embed-text',
    EMBEDDING_DIMENSIONS: '123', EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1',
  });
  assert.equal(config.model, 'gemini-embedding-2');
  assert.equal(config.dimensions, 768);
  assert.equal(config.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(embeddingId(config), 'gemini:gemini-embedding-2:768');
});

test('Ollama SDK receives the caller exact AbortSignal in request options', async () => {
  const controller = new AbortController();
  let sdkSignal;
  const provider = createEmbeddingProvider({}, {
    env: {},
    getEmbeddingClient: () => ({ embeddings: { create: async (_params, options) => {
      sdkSignal = options.signal;
      return { data: [{ index: 0, embedding: [3, 4] }] };
    } } }),
  });
  await provider.embed('input', { signal: controller.signal });
  assert.equal(sdkSignal, controller.signal);
});

test('explicit Ollama baseUrl selects and caches its configured SDK client', async () => {
  const created = [];
  const requests = [];
  const provider = createEmbeddingProvider({
    provider: 'ollama', model: 'custom-embedding', dimensions: 2,
    baseUrl: 'http://127.0.0.1:24123/v1', timeoutMs: 4321,
  }, {
    env: { EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1' },
    getEmbeddingClient: () => { throw new Error('Explicit baseUrl must select the configured client.'); },
    createOllamaClient: config => {
      created.push(config);
      return { embeddings: { create: async request => {
        requests.push(request);
        return { data: [{ index: 0, embedding: [3, 4] }] };
      } } };
    },
  });
  await provider.embed('first input');
  await provider.embed('second input');
  assert.equal(created.length, 1);
  assert.equal(created[0].baseUrl, 'http://127.0.0.1:24123/v1');
  assert.equal(created[0].timeoutMs, 4321);
  assert.equal(requests[0].model, 'custom-embedding');
  assert.equal(requests[0].dimensions, 2);
  assert.equal(requests[0].encoding_format, 'float');
});

test('explicit Ollama baseURL alias reaches injected getEmbeddingClient and controls SDK parameters', async () => {
  const requests = [];
  let receivedConfig;
  const provider = createEmbeddingProvider({ provider: 'ollama', baseURL: 'http://127.0.0.1:11434/v1' }, {
    env: { EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'https://example.com/v1' },
    getEmbeddingClient: config => {
      receivedConfig = config;
      return { embeddings: { create: async request => {
        requests.push(request);
        return { data: [{ index: 0, embedding: [3, 4] }] };
      } } };
    },
  });
  await provider.embed('input');
  assert.equal(receivedConfig.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(requests[0], { model: 'nomic-embed-text', input: 'input' });
});

test('unchanged default Ollama SDK factory receives no configuration argument', async () => {
  const provider = createEmbeddingProvider({}, {
    env: {},
    getEmbeddingClient: (...args) => {
      assert.equal(args.length, 0);
      return { embeddings: { create: async () => ({ data: [{ index: 0, embedding: [3, 4] }] }) } };
    },
  });
  await provider.embed('input');
});

test('legacy local/unknown provider env and owned Host env remain supported', () => {
  assert.equal(resolveEmbeddingConfig({}, { EMBEDDING_PROVIDER: 'ollama-local' }).provider, 'ollama');
  const openai = resolveEmbeddingConfig({ provider: 'ollama' }, {
    EMBEDDING_PROVIDER: 'openai', EMBEDDING_MODEL: 'text-embedding-3-small', EMBEDDING_DIMENSIONS: '1536',
  });
  assert.equal(openai.provider, 'ollama');
  assert.equal(openai.model, 'text-embedding-3-small');
  assert.equal(openai.dimensions, 1536);
  const owned = resolveEmbeddingConfig({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 }, {
    EMBEDDING_PROVIDER: 'home23-owned', EMBEDDING_MODEL: OWNED_EMBEDDING_PROFILE,
    EMBEDDING_BASE_URL: 'http://127.0.0.1:24005/v1', EMBEDDING_DIMENSIONS: '768',
  });
  assert.equal(embeddingId(owned), OWNED_EMBEDDER_ID);
  assert.equal(owned.baseUrl, 'http://127.0.0.1:24005/v1');
});

test('legacy config keeps custom models and an explicit custom Ollama model wins inherited env', () => {
  const custom = resolveEmbeddingConfig({ model: 'test-embedding', dimensions: 2 }, {});
  assert.equal(custom.model, 'test-embedding');
  assert.equal(custom.dimensions, 2);
  const explicit = resolveEmbeddingConfig({ provider: 'ollama', model: 'custom-ollama', dimensions: 3 }, {
    EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_MODEL: 'nomic-embed-text', EMBEDDING_DIMENSIONS: '768',
  });
  assert.equal(explicit.model, 'custom-ollama');
  assert.equal(explicit.dimensions, 3);
});

test('explicit owned provider ignores inherited Seed legacy model, dimensions, endpoint and recipe', () => {
  const config = resolveEmbeddingConfig({
    provider: 'owned-onnx', baseUrl: 'http://127.0.0.1:24005/v1',
  }, {
    EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_MODEL: 'nomic-embed-text',
    EMBEDDING_DIMENSIONS: '123', EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1',
    EMBEDDING_RECIPE_ID: 'legacy-ollama-nomic-unprefixed',
  });
  assert.equal(config.provider, 'owned-onnx');
  assert.equal(config.model, OWNED_EMBEDDING_PROFILE);
  assert.equal(config.dimensions, 768);
  assert.equal(config.baseUrl, 'http://127.0.0.1:24005/v1');
  assert.equal(embeddingId(config), OWNED_EMBEDDER_ID);
});

test('Gemini batchEmbedContents sends at most 100 texts with 768 dimensions and normalizes each vector', async () => {
  const requests = [];
  const provider = createEmbeddingProvider({ provider: 'gemini', batchSize: 1000 }, {
    env: geminiEnv,
    fetch: async (url, request) => {
      const body = JSON.parse(request.body);
      requests.push({ url, request, body });
      return geminiReply(body.requests.length);
    },
  });
  const texts = Array.from({ length: 201 }, (_unused, index) => `input ${index}`);
  const output = await provider.embedBatch(texts, { recordedId: provider.id });
  assert.equal(output.length, texts.length);
  assert.deepEqual(requests.map(item => item.body.requests.length), [100, 100, 1]);
  assert.deepEqual(requests.flatMap(item => item.body.requests.map(row => row.content.parts[0].text)), texts);
  assert.ok(output.every(row => row.length === 768 && Math.abs(Math.hypot(...row) - 1) < 1e-12));
  assert.deepEqual(output[0].slice(0, 2), [0.6, 0.8]);
  for (const { url, request, body } of requests) {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
    assert.equal(new URL(url).search, '');
    assert.equal(request.headers['x-goog-api-key'], geminiEnv.GEMINI_API_KEY);
    assert.equal(request.method, 'POST');
    assert.equal(body.requests[0].model, 'models/gemini-embedding-2');
    assert.equal(body.requests[0].outputDimensionality, 768);
  }
});

test('Gemini retries 429 and 5xx using bounded exponential backoff plus jitter', async () => {
  let count = 0;
  const waits = [];
  const provider = createEmbeddingProvider({ provider: 'gemini', maxRetries: 3 }, {
    env: geminiEnv, random: () => 0.5, sleep: async ms => { waits.push(ms); },
    fetch: async () => {
      count += 1;
      return count === 1 ? { ok: false, status: 429 }
        : count === 2 ? { ok: false, status: 503 } : geminiReply(1);
    },
  });
  assert.equal((await provider.embed('a sample input')).length, 768);
  assert.equal(count, 3);
  assert.deepEqual(waits, [562.5, 1125]);
});

test('Gemini nonretryable errors neither inspect response bodies nor leak a key', async () => {
  let count = 0;
  const provider = createEmbeddingProvider({ provider: 'gemini' }, {
    env: geminiEnv,
    fetch: async () => {
      count += 1;
      return { ok: false, status: 401, json: async () => { throw new Error(geminiEnv.GEMINI_API_KEY); } };
    },
    sleep: async () => { throw new Error('401 must not retry.'); },
  });
  await assert.rejects(provider.embed('input'), error => {
    assert.equal(error.code, 'EMBEDDING_REQUEST_FAILED');
    assert.equal(error.status, 401);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(geminiEnv.GEMINI_API_KEY));
    return true;
  });
  assert.equal(count, 1);
});

test('fetch/SDK exceptions discard secret-bearing messages, stacks, causes and request properties', async () => {
  const secret = geminiEnv.GEMINI_API_KEY;
  const leak = Object.assign(new Error(`key=${secret} and ${encodeURIComponent(secret)}`), {
    cause: new Error(secret), request: { headers: { 'x-goog-api-key': secret } },
  });
  for (const provider of [
    createEmbeddingProvider(geminiConfig, { env: geminiEnv, fetch: async () => { throw leak; } }),
    createEmbeddingProvider({}, { env: {}, getEmbeddingClient: () => { throw leak; } }),
  ]) {
    await assert.rejects(provider.embed('input'), error => {
      assert.equal(error.message, 'Embedding request failed.');
      assert.equal(error.cause, undefined);
      assert.equal(error.request, undefined);
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(secret));
      return true;
    });
  }
});

test('Gemini bounds requests even when a fetch mock ignores AbortSignal', async () => {
  let signal;
  const provider = createEmbeddingProvider({ ...geminiConfig, timeoutMs: 10 }, {
    env: geminiEnv,
    fetch: async (_url, request) => { signal = request.signal; return new Promise(() => {}); },
  });
  await assert.rejects(provider.embed('input'), { code: 'EMBEDDING_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('external abort cancels a pending request and never contacts fallback', async () => {
  const controller = new AbortController();
  let requestSignal;
  let calls = 0;
  const provider = createEmbeddingProvider({ ...geminiConfig, fallback: 'owned-onnx' }, {
    env: geminiEnv,
    fetch: async (_url, request) => {
      calls += 1;
      requestSignal = request.signal;
      controller.abort(new Error('private cancellation reason'));
      return new Promise(() => {});
    },
  });
  await assert.rejects(provider.embed('input', { signal: controller.signal }), error => {
    assert.equal(error.code, 'EMBEDDING_CANCELLED');
    assert.ok(!error.stack.includes('private cancellation reason'));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
});

test('external abort during backoff interrupts the pause and prevents a retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = createEmbeddingProvider({ provider: 'gemini' }, {
    env: geminiEnv,
    fetch: async () => { calls += 1; return { ok: false, status: 429 }; },
    sleep: async () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  await assert.rejects(provider.embed('input', { signal: controller.signal }), { code: 'EMBEDDING_CANCELLED' });
  assert.equal(calls, 1);
});

test('Gemini refuses wrong dimensions, nonfinite, zero and wrong-count vectors', async () => {
  for (const embeddings of [
    [{ values: [3, 4] }],
    [{ values: vector(Infinity, 1) }],
    [{ values: vector(NaN, 1) }],
    [{ values: vector(0, 0) }],
    [],
  ]) {
    const provider = createEmbeddingProvider(geminiConfig, {
      env: geminiEnv, fetch: async () => ok({ embeddings }),
    });
    await assert.rejects(provider.embed('input'), { code: 'EMBEDDING_RESPONSE_INVALID' });
  }
});

test('normalization handles large finite values without overflowing', async () => {
  const provider = createEmbeddingProvider({ ...geminiConfig, dimensions: 2 }, {
    env: geminiEnv, fetch: async () => ok({ embeddings: [{ values: [1e308, 1e308] }] }),
  });
  const result = await provider.embed('input');
  assert.ok(result.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...result) - 1) < 1e-12);
});

test('Google secrets convention and root GEMINI_API_KEY take precedence over env and resolve at use', async () => {
  const headers = [];
  let contents = 'providers:\n  google:\n    apiKey: secret-from-google\n';
  const provider = createEmbeddingProvider(geminiConfig, {
    env: { ...geminiEnv, HOME23_SECRETS_PATH: '/an-isolated-secrets-fixture' },
    readFileSync: filename => {
      assert.equal(filename, '/an-isolated-secrets-fixture');
      return contents;
    },
    fetch: async (_url, request) => { headers.push(request.headers['x-goog-api-key']); return geminiReply(1); },
  });
  await provider.embed('input');
  contents = 'GEMINI_API_KEY: rotated-root-secret\n';
  await provider.embed('input');
  contents = '';
  await provider.embed('input');
  assert.deepEqual(headers, ['secret-from-google', 'rotated-root-secret', geminiEnv.GEMINI_API_KEY]);
  assert.ok(!JSON.stringify(provider.config).includes('secret'));
});

test('missing key fails before fetching and resolver exceptions are sanitized', async () => {
  for (const extra of [{ secrets: {} }, { resolveKey: () => { throw new Error('a-private-key'); } }]) {
    const provider = createEmbeddingProvider(geminiConfig, {
      env: {}, ...extra,
      fetch: async () => { throw new Error('Must not fetch without a key.'); },
    });
    await assert.rejects(provider.embed('input'), error => {
      assert.equal(error.code, 'EMBEDDING_KEY_MISSING');
      assert.ok(!error.stack.includes('a-private-key'));
      return true;
    });
  }
});

test('recorded embedder mismatch and unstamped legacy brains refuse before provider access', async () => {
  const provider = createEmbeddingProvider(geminiConfig, {
    env: {}, resolveKey: () => { throw new Error('Must not resolve a key.'); },
    fetch: async () => { throw new Error('Must not fetch.'); },
  });
  for (const recordedId of [LEGACY_EMBEDDER_ID, null, 'gemini:another-model:768']) {
    await assert.rejects(provider.embed('input', { recordedId }), error => {
      assert.equal(error.code, 'EMBEDDER_ID_MISMATCH');
      assert.match(error.message, /node cli\/home23\.js brain re-embed/);
      return true;
    });
  }
});

test('Gemini failure refuses a different-space owned fallback before sidecar contact', async () => {
  const urls = [];
  const provider = createEmbeddingProvider({ ...geminiConfig, fallback: 'owned-onnx', ownedBaseUrl: 'http://127.0.0.1:24005/v1' }, {
    env: geminiEnv,
    fetch: async url => { urls.push(url); return { ok: false, status: 503 }; },
  });
  await assert.rejects(provider.embed('input', { recordedId: provider.id }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('https://generativelanguage.googleapis.com/'));
});

test('owned provider uses existing sidecar protocol and permits only same-id owned fallback', async () => {
  const requests = [];
  const provider = createEmbeddingProvider({
    provider: 'owned-onnx', baseUrl: 'http://127.0.0.1:24005/v1',
    ownedBaseUrl: 'http://127.0.0.1:24006/v1', fallback: 'owned-onnx',
  }, {
    env: {},
    fetch: async (url, request) => {
      const body = JSON.parse(request.body);
      requests.push({ url, body });
      if (url.includes(':24005/')) return { ok: false, status: 503 };
      return ok({ data: [{ index: 1, embedding: vector(4, 3) }, { index: 0, embedding: vector() }] });
    },
  });
  const output = await provider.embedBatch(['first input', 'second input'], { recordedId: OWNED_EMBEDDER_ID });
  assert.deepEqual(output.map(row => row.slice(0, 2)), [[0.6, 0.8], [0.8, 0.6]]);
  assert.deepEqual(requests.map(row => row.url), [
    'http://127.0.0.1:24005/v1/embeddings', 'http://127.0.0.1:24006/v1/embeddings',
  ]);
  assert.equal(requests[0].body.model, OWNED_EMBEDDING_PROFILE);
  assert.equal(provider.id, OWNED_EMBEDDER_ID);
});

test('owned recipe hash canonicalizes to its profile; remote and malformed sidecars fail safely', async () => {
  assert.equal(embeddingId(resolveEmbeddingConfig({ provider: 'owned-onnx', model: OWNED_EMBEDDING_RECIPE_ID }, {})), OWNED_EMBEDDER_ID);
  assert.throws(() => resolveEmbeddingConfig({ provider: 'owned-onnx', model: 'nomic-embed-text' }, {}), { code: 'EMBEDDING_CONFIG_INVALID' });
  const remote = createEmbeddingProvider({ provider: 'owned-onnx', baseUrl: 'https://example.com/v1' }, {
    env: {}, fetch: async () => { throw new Error('Must not contact a remote owned provider.'); },
  });
  await assert.rejects(remote.embed('input'), { code: 'EMBEDDING_CONFIG_INVALID' });
  const duplicate = createEmbeddingProvider({ provider: 'owned-onnx', baseUrl: 'http://127.0.0.1:24005/v1' }, {
    env: {}, fetch: async () => ok({ data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] }),
  });
  await assert.rejects(duplicate.embedBatch(['first input', 'second input']), { code: 'EMBEDDING_RESPONSE_INVALID' });
});

test('Host owned provider alias and native endpoint use the same canonical vector space', async () => {
  const urls = [];
  const provider = createEmbeddingProvider({
    provider: 'home23-owned', model: OWNED_EMBEDDING_RECIPE_ID,
    endpoint: 'http://127.0.0.1:24005/api/embeddings',
  }, {
    env: { EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_MODEL: 'nomic-embed-text' },
    fetch: async url => { urls.push(url); return ok({ data: [{ index: 0, embedding: vector() }] }); },
  });
  assert.equal(provider.id, OWNED_EMBEDDER_ID);
  assert.deepEqual((await provider.embed('owned input', { recordedId: OWNED_EMBEDDER_ID })).slice(0, 2), [0.6, 0.8]);
  assert.deepEqual(urls, ['http://127.0.0.1:24005/v1/embeddings']);
});

test('owned adapter rejects unrelated endpoint paths and a reported different encoder identity', async () => {
  const wrongPath = createEmbeddingProvider({ provider: 'owned-onnx', baseUrl: 'http://127.0.0.1:24005/unrelated' }, {
    env: {}, fetch: async () => { assert.fail('Invalid endpoint must be rejected before fetch.'); },
  });
  await assert.rejects(wrongPath.embed('input'), { code: 'EMBEDDING_CONFIG_INVALID' });
  for (const identity of [{ model: 'nomic-embed-text' }, { recipeId: '5128b29c886857aeb89b148d2d9f2edf2c20f63de15a764342c2a18da640f71a' }]) {
    const provider = createEmbeddingProvider({ provider: 'owned-onnx', baseUrl: 'http://127.0.0.1:24005/v1' }, {
      env: {}, fetch: async () => ok({ ...identity, data: [{ index: 0, embedding: vector() }] }),
    });
    await assert.rejects(provider.embed('input'), { code: 'EMBEDDING_RESPONSE_INVALID' });
  }
});

test('empty batch is inert and invalid config fails with bounded public errors', async () => {
  const provider = createEmbeddingProvider(geminiConfig, { env: {}, fetch: async () => { throw new Error('Must not fetch.'); } });
  assert.deepEqual(await provider.embedBatch([]), []);
  for (const config of [
    { provider: 'unsupported-private-value' }, { provider: 'gemini', dimensions: -1 },
    { provider: 'gemini', batchSize: 0 }, { provider: 'gemini', maxRetries: -1 },
    { provider: 'gemini', pricePerMillionTokens: Infinity }, { provider: 'gemini', fallback: 'openai' },
  ]) {
    assert.throws(() => resolveEmbeddingConfig(config, {}), { code: 'EMBEDDING_CONFIG_INVALID' });
  }
});
