'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveExactConfiguredPair,
} = require('../../cosmo23/server/config/model-catalog');

function catalog() {
  const capabilities = {
    kind: 'chat',
    maxOutputTokens: 1024,
    providerStallMs: 900_000,
    transport: 'responses',
  };
  return {
    version: 1,
    providers: {
      alpha: {
        executionDefaults: capabilities,
        models: [{ id: 'shared', ...capabilities }],
      },
      beta: {
        executionDefaults: capabilities,
        models: [{ id: 'shared', ...capabilities }],
      },
    },
    defaults: {},
  };
}

test('exact configured pair retains provider identity for a shared model label', () => {
  const pair = resolveExactConfiguredPair(catalog(), {
    'agents.research-synthesis': {
      provider: 'beta',
      model: 'shared',
      fallback: [{ provider: 'alpha', model: 'shared' }],
    },
  }, 'agents.research-synthesis');
  assert.deepEqual(pair, { provider: 'beta', model: 'shared' });
  assert.equal(Object.isFrozen(pair), true);
});

test('exact configured pair rejects missing, partial, inferred, and catalog-mismatched assignments', () => {
  const inputs = [
    {},
    { 'agents.research-synthesis': { model: 'shared' } },
    { 'agents.research-synthesis': { provider: 'beta' } },
    { 'agents.research-synthesis': { provider: 'missing', model: 'shared' } },
    { 'agents.research-synthesis': { provider: 'beta', model: 'missing' } },
  ];
  for (const configured of inputs) {
    assert.throws(
      () => resolveExactConfiguredPair(catalog(), configured, 'agents.research-synthesis'),
      (error) => ['model_assignment_invalid', 'model_not_found'].includes(error.code),
    );
  }
});
