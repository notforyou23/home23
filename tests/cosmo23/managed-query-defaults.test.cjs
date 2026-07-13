'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildExactQueryDefaults,
} = require('../../cosmo23/server/lib/managed-query-defaults');

const MODELS = [
  { provider: 'openai', id: 'shared', kind: 'chat' },
  { provider: 'openai-codex', id: 'shared', kind: 'chat' },
  { provider: 'openai-codex', id: 'fast', kind: 'chat' },
  { provider: 'anthropic', id: 'strong', kind: 'chat' },
];

test('managed Query defaults preserve exact Direct, PGS sweep, and PGS synth pairs', () => {
  const queryDefaults = buildExactQueryDefaults({
    models: MODELS,
    managed: true,
    managedDefaults: {
      defaultProvider: 'openai-codex',
      defaultModel: 'shared',
      pgsSweepProvider: 'openai-codex',
      pgsSweepModel: 'fast',
      pgsSynthProvider: 'anthropic',
      pgsSynthModel: 'strong',
      defaultMode: 'dive',
      enablePGSByDefault: true,
      pgsDepth: 0.5,
    },
  });

  assert.deepEqual(queryDefaults, {
    defaultProvider: 'openai-codex',
    defaultModel: 'shared',
    pgsSweepProvider: 'openai-codex',
    pgsSweepModel: 'fast',
    pgsSynthProvider: 'anthropic',
    pgsSynthModel: 'strong',
    defaultMode: 'dive',
    enablePGSByDefault: true,
    pgsDepth: 0.5,
  });
});

test('managed Query defaults fail closed for missing, partial, or mismatched exact pairs', () => {
  for (const managedDefaults of [
    null,
    { defaultModel: 'shared' },
    {
      defaultProvider: 'missing', defaultModel: 'shared',
      pgsSweepProvider: 'openai-codex', pgsSweepModel: 'fast',
      pgsSynthProvider: 'anthropic', pgsSynthModel: 'strong',
    },
  ]) {
    assert.throws(
      () => buildExactQueryDefaults({ models: MODELS, managed: true, managedDefaults }),
      (error) => error.code === 'model_catalog_invalid' && error.retryable === false,
    );
  }
});

test('standalone Query defaults resolve only unique catalog model IDs without literals', () => {
  assert.deepEqual(buildExactQueryDefaults({
    models: MODELS,
    managed: false,
    legacyDefaults: { queryModel: 'strong', pgsSweepModel: 'fast' },
  }), {
    defaultProvider: 'anthropic',
    defaultModel: 'strong',
    pgsSweepProvider: 'openai-codex',
    pgsSweepModel: 'fast',
    pgsSynthProvider: 'anthropic',
    pgsSynthModel: 'strong',
    defaultMode: 'full',
    enablePGSByDefault: false,
    pgsDepth: 0.25,
  });

  assert.throws(
    () => buildExactQueryDefaults({
      models: MODELS,
      managed: false,
      legacyDefaults: { queryModel: 'shared', pgsSweepModel: 'fast' },
    }),
    (error) => error.code === 'model_ambiguous',
  );
});
