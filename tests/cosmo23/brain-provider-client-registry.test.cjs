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
