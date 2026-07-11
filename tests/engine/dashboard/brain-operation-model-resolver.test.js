import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  createOperationModelResolver,
  migrateQueryDefaultPairs,
} = require('../../../engine/src/dashboard/brain-operations/operation-model-resolver.js');

function model(id) {
  return {
    id,
    kind: 'chat',
    maxOutputTokens: 1024,
    providerStallMs: 900_000,
    transport: 'responses',
  };
}

function fixture(overrides = {}) {
  const catalog = overrides.catalog || {
    version: 1,
    providers: {
      anthropic: { models: [model('shared'), model('claude-opus-4-8')] },
      minimax: { models: [model('shared'), model('MiniMax-M3')] },
    },
    defaults: {},
  };
  const calls = [];
  const unavailable = new Set(overrides.unavailable || []);
  const providerRegistry = {
    assertPairAvailable(provider, selectedModel) {
      calls.push(`${provider}/${selectedModel}`);
      if (unavailable.has(`${provider}/${selectedModel}`)) {
        throw Object.assign(new Error('pair unavailable'), {
          code: 'provider_unavailable', retryable: true,
        });
      }
      return { providerId: provider, generate() {} };
    },
  };
  const queryDefaults = overrides.queryDefaults || {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-opus-4-8',
    pgsSweepProvider: 'minimax',
    pgsSweepModel: 'MiniMax-M3',
    pgsSynthProvider: 'anthropic',
    pgsSynthModel: 'claude-opus-4-8',
  };
  return {
    calls,
    resolver: createOperationModelResolver({ catalog, providerRegistry, queryDefaults }),
  };
}

test('resolves exact query and PGS defaults while preserving caller intent', async () => {
  const { resolver } = fixture();
  const query = resolver.resolve('query', { query: 'canary', mode: 'full' });
  assert.deepEqual(query.requestParameters, { query: 'canary', mode: 'full' });
  assert.deepEqual(query.parameters, {
    query: 'canary',
    mode: 'full',
    modelSelection: { provider: 'anthropic', model: 'claude-opus-4-8' },
  });

  const pgs = resolver.resolve('pgs', {
    query: 'canary',
    pgsSweep: { provider: 'minimax', model: 'shared' },
  });
  assert.deepEqual(pgs.requestParameters.pgsSweep, { provider: 'minimax', model: 'shared' });
  assert.deepEqual(pgs.parameters.pgsSweep, { provider: 'minimax', model: 'shared' });
  assert.deepEqual(pgs.parameters.pgsSynth, {
    provider: 'anthropic', model: 'claude-opus-4-8',
  });
  assert.equal(Object.isFrozen(pgs.parameters), true);
  assert.equal(Object.isFrozen(pgs.parameters.pgsSweep), true);

  assert.deepEqual(await resolver({
    operationType: 'query',
    requestParameters: { query: 'from coordinator' },
  }), {
    query: 'from coordinator',
    modelSelection: { provider: 'anthropic', model: 'claude-opus-4-8' },
  });
});

test('duplicate model labels remain provider-exact', () => {
  const { resolver } = fixture();
  const anthropic = resolver.resolve('query', {
    query: 'one', modelSelection: { provider: 'anthropic', model: 'shared' },
  });
  const minimax = resolver.resolve('query', {
    query: 'two', modelSelection: { provider: 'minimax', model: 'shared' },
  });
  assert.deepEqual(anthropic.parameters.modelSelection, { provider: 'anthropic', model: 'shared' });
  assert.deepEqual(minimax.parameters.modelSelection, { provider: 'minimax', model: 'shared' });
});

test('invalid or operation-inappropriate provider fields fail closed', () => {
  const { resolver } = fixture();
  for (const [operationType, parameters] of [
    ['query', { query: 'x', provider: 'anthropic', model: 'shared' }],
    ['query', { query: 'x', modelSelection: { provider: 'anthropic' } }],
    ['query', { query: 'x', pgsSweep: { provider: 'minimax', model: 'shared' } }],
    ['pgs', { query: 'x', modelSelection: { provider: 'anthropic', model: 'shared' } }],
    ['pgs', { query: 'x', pgsSweep: { provider: 'minimax', model: 'shared', extra: true } }],
    ['pgs', { query: 'x', pgsConfig: { sweepFraction: 0 } }],
    ['query', { query: 'x', topK: 0 }],
    ['query', { query: 'x', invented: true }],
  ]) {
    assert.throws(
      () => resolver.resolve(operationType, parameters),
      (error) => ['invalid_request', 'provider_model_mismatch'].includes(error.code),
      `${operationType} ${JSON.stringify(parameters)}`,
    );
  }
});

test('unavailable explicit and default pairs fail before execution', () => {
  const { resolver } = fixture({ unavailable: ['minimax/shared'] });
  assert.throws(
    () => resolver.resolve('query', {
      query: 'x', modelSelection: { provider: 'minimax', model: 'shared' },
    }),
    (error) => error.code === 'provider_unavailable' && error.retryable === true,
  );
  assert.throws(
    () => fixture({ unavailable: ['anthropic/claude-opus-4-8'] }),
    (error) => error.code === 'provider_unavailable',
  );
});

test('validates bounded non-provider query and PGS options exactly', () => {
  const { resolver } = fixture();
  const priorContext = { query: 'before', answer: 'after' };
  const query = resolver.resolve('query', {
    query: 'x', mode: 'dive', topK: 100, priorContext,
    enableSynthesis: true, includeOutputs: false, includeThoughts: true,
    includeCoordinatorInsights: false, allowActions: true,
  });
  assert.deepEqual(query.parameters.priorContext, priorContext);
  const pgs = resolver.resolve('pgs', {
    query: 'x', mode: 'full', pgsMode: 'full',
    pgsConfig: { sweepFraction: 0.25 }, priorContext, allowActions: false,
  });
  assert.deepEqual(pgs.parameters.pgsConfig, { sweepFraction: 0.25 });
});

test('prior context uses the public combined 20k contract without a hidden query sub-cap', () => {
  const { resolver } = fixture();
  const accepted = resolver.resolve('query', {
    query: 'current',
    priorContext: { query: 'q'.repeat(13_000), answer: 'a'.repeat(7_000) },
  });
  assert.equal(accepted.parameters.priorContext.query.length, 13_000);
  assert.throws(() => resolver.resolve('query', {
    query: 'current',
    priorContext: { query: 'q'.repeat(13_000), answer: 'a'.repeat(7_001) },
  }), { code: 'invalid_request' });
});

test('migrates three model-only default slots in one settings CAS', async () => {
  const base = fixture();
  let data = {
    unrelated: { preserved: true },
    query: {
      defaultModel: 'claude-opus-4-8',
      pgsSweepModel: 'MiniMax-M3',
      pgsSynthModel: 'claude-opus-4-8',
    },
  };
  let version = 'v1';
  let updates = 0;
  const settingsStore = {
    async read() { return { data: structuredClone(data), version }; },
    async update({ expectedVersion, mutate }) {
      assert.equal(expectedVersion, version);
      const next = structuredClone(data);
      await mutate(next);
      data = next;
      version = `v${++updates + 1}`;
      return { data: structuredClone(data), version };
    },
  };
  const result = await migrateQueryDefaultPairs({
    settingsStore,
    catalog: {
      version: 1,
      providers: {
        anthropic: { models: [model('claude-opus-4-8')] },
        minimax: { models: [model('MiniMax-M3')] },
      },
      defaults: {},
    },
    providerRegistry: {
      assertPairAvailable(provider) { return { providerId: provider, generate() {} }; },
    },
  });
  assert.equal(updates, 1);
  assert.equal(result.migrated, true);
  assert.deepEqual(data.query, {
    defaultModel: 'claude-opus-4-8',
    pgsSweepModel: 'MiniMax-M3',
    pgsSynthModel: 'claude-opus-4-8',
    defaultProvider: 'anthropic',
    pgsSweepProvider: 'minimax',
    pgsSynthProvider: 'anthropic',
  });
  assert.deepEqual(data.unrelated, { preserved: true });
});

test('model-only migration rejects ambiguous or unavailable pairs without writing', async () => {
  let updates = 0;
  const settingsStore = {
    async read() {
      return {
        version: 'v1',
        data: {
          query: {
            defaultModel: 'shared',
            pgsSweepModel: 'shared',
            pgsSynthModel: 'shared',
          },
        },
      };
    },
    async update() { updates += 1; throw new Error('must not update'); },
  };
  const catalog = {
    version: 1,
    providers: {
      anthropic: { models: [model('shared')] },
      minimax: { models: [model('shared')] },
    },
    defaults: {},
  };
  await assert.rejects(migrateQueryDefaultPairs({
    settingsStore,
    catalog,
    providerRegistry: {
      assertPairAvailable(provider) { return { providerId: provider, generate() {} }; },
    },
  }), error => error.code === 'model_ambiguous');
  assert.equal(updates, 0);
});
