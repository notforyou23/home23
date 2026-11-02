'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UnifiedClient } = require('../../../engine/src/core/unified-client.js');
const { ConfigLoader } = require('../../../engine/src/core/config-loader.js');
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

for (const provider of ['local', 'ollama-local']) test(`engine routes ${provider} assignments without changing the selected model`, async () => {
  const client = new UnifiedClient({ providers: { [provider]: { enabled: true } },
    modelAssignments: { default: { provider, model: 'fixture-local', fallback: [] } } }, quiet);
  assert.ok(client.localClientFor(provider));
  let request;
  client.localClientFor(provider).generate = async options => { request = options; return { content: 'local result' }; };
  const result = await client.generate({ component: 'unmapped-role', input: 'inspect fixture' });
  assert.equal(result.content, 'local result');
  assert.equal(request.model, 'fixture-local');
  assert.equal(request.localProvider, provider);
});

for (const method of ['generate', 'generateFast', 'generateWithReasoning', 'generateWithWebSearch']) {
  test(`local-only ${method} refuses unassigned/cloud roles before dispatch`, async () => {
    const client = new UnifiedClient({ localOnly: true }, quiet);
    await assert.rejects(client[method]({ component: 'missing' }), { code: 'local_provider_required' });
    client.config.modelAssignments = { default: { provider: 'openai', model: 'cloud-model' } };
    await assert.rejects(client[method]({ component: 'missing' }), { code: 'local_provider_required' });
  });
}

test('local-only engine refuses cloud fallback and cloud proxy tags', async () => {
  const client = new UnifiedClient({ localOnly: true, providers: { 'ollama-local': { enabled: true } }, modelAssignments: {
    default: { provider: 'ollama-local', model: 'fixture-local', fallback: [{ provider: 'openai', model: 'cloud-model' }] },
  } }, quiet);
  client.ollamaLocalClient.generate = async () => { throw new Error('local failed'); };
  await assert.rejects(client.generate({ input: 'hello' }), { code: 'local_provider_required' });
  client.config.modelAssignments.default.model = 'remote:cloud';
  await assert.rejects(client.generate({ input: 'hello' }), { code: 'local_model_required' });
});

test('instance local inference settings overlay endpoint and local-only without changing embedding recipe', () => {
  const loader = new ConfigLoader('/unused-fixture.yaml');
  const embedding = { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 };
  loader.config = { providers: { 'ollama-local': { enabled: true, baseUrl: 'http://old.invalid' } }, architecture: { memory: { embedding } } };
  loader.applyLocalInferenceConfig({ engine: { localOnly: true }, providers: { 'ollama-local': { baseUrl: 'http://127.0.0.1:11434', inference: { contextTokens: 8192 } } } });
  assert.equal(loader.config.localOnly, true);
  assert.equal(loader.config.providers['ollama-local'].enabled, true);
  assert.equal(loader.config.providers['ollama-local'].baseUrl, 'http://127.0.0.1:11434');
  assert.equal(loader.config.architecture.memory.embedding, embedding);
});

test('canonical and generic local endpoints remain separate; a disabled canonical provider cannot fall back', async () => {
  const client = new UnifiedClient({ providers: {
    local: { enabled: true, baseURL: 'http://127.0.0.1:8000/v1' },
    'ollama-local': { enabled: true, baseUrl: 'http://127.0.0.1:11434' },
  }, modelAssignments: { default: { provider: 'ollama-local', model: 'fixture-local' } } }, quiet);
  assert.equal(client.localClient.clientConfig.baseURL, 'http://127.0.0.1:8000/v1');
  assert.equal(client.ollamaLocalClient.clientConfig.baseURL, 'http://127.0.0.1:11434');
  const disabled = new UnifiedClient({ providers: { local: { enabled: true }, 'ollama-local': { enabled: false } },
    modelAssignments: { default: { provider: 'ollama-local', model: 'fixture-local' } } }, quiet);
  for (const method of ['generate', 'generateFast', 'generateWithReasoning', 'generateWithWebSearch']) {
    await assert.rejects(disabled[method]({ input: 'test' }), /not initialized|disabled or unconfigured/);
  }
});

test('native engine dispatch preserves caller reasoning choices and explicit role defaults', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const chats = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'thinking'] });
    assert.ok(String(url).startsWith('http://127.0.0.1:11434/'));
    chats.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Classified.' }, done: true, done_reason: 'stop' }) + '\n');
  };
  const client = new UnifiedClient({ providers: { 'ollama-local': { enabled: true, baseUrl: 'http://127.0.0.1:11434' } },
    modelAssignments: { default: { provider: 'ollama-local', model: 'thinking-fixture', reasoningEffort: 'none', fallback: [] } } }, quiet);
  for (const [options, expectedThink] of [
    [{ reasoningEffort: 'none' }, false],
    [{ reasoning: { effort: 'none' } }, false],
    [{}, false],
    [{ reasoningEffort: 'high' }, true],
    [{ reasoning: { effort: 'high' } }, true],
    [{ reasoningEffort: 'high', think: false }, false],
  ]) {
    const result = await client.generate({ component: 'local-proof', input: 'Classify this fixture.', maxTokens: 80, ...options });
    assert.equal(result.content, 'Classified.');
    assert.equal(chats.at(-1).think, expectedThink);
  }
  for (const method of ['generateFast', 'generateWithReasoning', 'generateWithWebSearch']) {
    // Use messages instead of a search query so this exercises routing without external search.
    await client[method]({ component: 'local-proof', messages: [{ role: 'user', content: 'Classify this fixture.' }], maxTokens: 80 });
    assert.equal(chats.at(-1).think, false, `${method} retains the role's explicit none`);
  }
});

test('an empty fallback list preserves the native completion error', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let chatCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
    chatCalls++;
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Unfinished' }, done: true, done_reason: 'length' }) + '\n');
  };
  const client = new UnifiedClient({ providers: { 'ollama-local': { enabled: true, baseUrl: 'http://127.0.0.1:11434' } },
    modelAssignments: { default: { provider: 'ollama-local', model: 'incomplete-fixture', fallback: [] } } }, quiet);
  await assert.rejects(client.generate({ input: 'Classify this fixture.', maxTokens: 80 }), {
    code: 'provider_incomplete', message: 'Local inference stopped before a complete response',
  });
  assert.equal(chatCalls, 1);
});
