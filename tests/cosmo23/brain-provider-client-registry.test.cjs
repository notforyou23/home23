'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBrainProviderClientRegistry,
  pairKey,
} = require('../../cosmo23/lib/brain-provider-client-registry');

function catalog() {
  return {
    version: 1,
    providers: {
      alpha: {
        label: 'Alpha',
        executionDefaults: {
          maxOutputTokens: 256, providerStallMs: 1000, transport: 'responses',
        },
        models: [{ id: 'shared', kind: 'chat', maxOutputTokens: 256,
          providerStallMs: 1000, transport: 'responses' }],
      },
      beta: {
        label: 'Beta',
        executionDefaults: {
          maxOutputTokens: 512, providerStallMs: 2000, transport: 'chat-completions',
        },
        models: [{ id: 'shared', kind: 'chat', maxOutputTokens: 512,
          providerStallMs: 2000, transport: 'chat-completions' }],
      },
      custom: {
        label: 'Custom',
        executionDefaults: {
          maxOutputTokens: 128, providerStallMs: 1000, transport: 'responses',
        },
        models: [{ id: 'custom-model', kind: 'chat', maxOutputTokens: 128,
          providerStallMs: 1000, transport: 'responses' }],
      },
    },
    defaults: {},
  };
}

function builtInCatalog() {
  function provider(transport, models) {
    return {
      executionDefaults: {
        maxOutputTokens: 256, providerStallMs: 1000, transport,
      },
      models: models.map((entry) => ({
        id: entry.id,
        kind: 'chat',
        maxOutputTokens: 256,
        providerStallMs: 1000,
        transport: entry.transport || transport,
      })),
    };
  }
  return {
    version: 1,
    providers: {
      openai: provider('responses', [{ id: 'shared' }]),
      'openai-codex': provider('codex-responses', [{ id: 'codex' }]),
      anthropic: provider('anthropic-messages', [{ id: 'claude' }]),
      minimax: provider('anthropic-messages', [{ id: 'minimax' }]),
      xai: provider('chat-completions', [
        { id: 'shared' },
        { id: 'xai-responses', transport: 'responses' },
      ]),
      'ollama-cloud': provider('chat-completions', [{ id: 'ollama' }]),
      custom: provider('responses', [{ id: 'custom' }]),
    },
    defaults: {},
  };
}

test('registry keys clients by exact provider and model without model-only fallback', () => {
  const alpha = { providerId: 'alpha', generate() {} };
  const beta = { providerId: 'beta', generate() {} };
  const registry = createBrainProviderClientRegistry({
    catalog: catalog(),
    pairFactories: {
      [pairKey('alpha', 'shared')]: () => alpha,
      [pairKey('beta', 'shared')]: () => beta,
    },
  });
  assert.equal(registry.get('alpha', 'shared'), alpha);
  assert.equal(registry.get('beta', 'shared'), beta);
  assert.notEqual(registry.get('alpha', 'shared'), registry.get('beta', 'shared'));
  assert.equal(registry.has('custom', 'custom-model'), false);
  assert.deepEqual(registry.availability('custom', 'custom-model'), {
    available: false,
    reason: 'provider factory is not registered',
  });
  assert.throws(() => registry.get('custom', 'custom-model'), (error) =>
    error.code === 'provider_unavailable' && error.retryable === true);
});

test('registry constructs each exact pair once and never probes a provider', () => {
  const calls = [];
  const registry = createBrainProviderClientRegistry({
    catalog: catalog(),
    pairFactories: {
      alpha: ({ provider, model }) => {
        calls.push(`${provider}/${model}`);
        return { providerId: provider, generate() {} };
      },
      beta: ({ provider, model }) => {
        calls.push(`${provider}/${model}`);
        return { providerId: provider, generate() {} };
      },
    },
  });
  assert.deepEqual(calls, ['alpha/shared', 'beta/shared']);
  const one = registry.get('alpha', 'shared');
  assert.equal(registry.get('alpha', 'shared'), one);
});

test('pair keys reject partial or empty identities', () => {
  for (const pair of [[null, 'm'], ['p', null], ['', 'm'], ['p', ' ']]) {
    assert.throws(() => pairKey(pair[0], pair[1]), (error) =>
      error.code === 'provider_model_mismatch');
  }
});

test('built-in factories create exact transport clients without provider calls', () => {
  const neverCalled = new Proxy({}, {
    get() { throw new Error('provider must not be called during registry construction'); },
  });
  const registry = createBrainProviderClientRegistry({
    catalog: builtInCatalog(),
    providerConfig: {
      openai: { client: neverCalled },
      anthropic: { client: neverCalled },
      minimax: { client: neverCalled },
      xai: { client: neverCalled },
      'ollama-cloud': { client: neverCalled },
    },
    credentialsProviders: {
      'openai-codex': async () => ({ accessToken: 'test', accountId: 'account' }),
    },
    fetchImpl: async () => { throw new Error('fetch must not run during registry construction'); },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  const openai = registry.get('openai', 'shared');
  const xaiChat = registry.get('xai', 'shared');
  const xaiResponses = registry.get('xai', 'xai-responses');
  const anthropic = registry.get('anthropic', 'claude');
  const minimax = registry.get('minimax', 'minimax');
  const ollama = registry.get('ollama-cloud', 'ollama');
  const codex = registry.get('openai-codex', 'codex');

  assert.equal(openai.constructor.name, 'GPT5Client');
  assert.equal(openai.providerId, 'openai');
  assert.equal(xaiChat.constructor.name, 'ChatCompletionsClient');
  assert.equal(xaiChat.config.providerId, 'xai');
  assert.equal(xaiResponses.constructor.name, 'GPT5Client');
  assert.equal(xaiResponses.providerId, 'xai');
  assert.equal(anthropic.constructor.name, 'AnthropicClient');
  assert.equal(anthropic.providerId, 'anthropic');
  assert.equal(minimax.providerId, 'minimax');
  assert.equal(ollama.config.providerId, 'ollama-cloud');
  assert.equal(codex.constructor.name, 'CodexResponsesClient');
  assert.equal(codex.providerId, 'openai-codex');
  assert.notEqual(openai, xaiResponses);
  assert.equal(registry.has('custom', 'custom'), false);
});

test('built-in availability is false when required credentials are absent', () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const source = builtInCatalog();
    source.providers = { openai: source.providers.openai };
    const registry = createBrainProviderClientRegistry({ catalog: source });
    assert.equal(registry.has('openai', 'shared'), false);
    assert.deepEqual(registry.availability('openai', 'shared'), {
      available: false,
      reason: 'openai: credentials are unavailable',
    });
    assert.throws(() => registry.get('openai', 'shared'), (error) =>
      error.code === 'provider_unavailable' && error.retryable === true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
