'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILTIN_EXECUTION_DEFAULTS,
  BUILTIN_MODEL_CATALOG,
  normalizeProviderConfig,
} = require('../../cosmo23/server/config/model-catalog');

// Models observed in live standalone catalogs (~/.cosmo2.3/model-catalog.json,
// 2026-07-22) that predate strict capability validation. They must stay in the
// built-in catalog so bare legacy rows keep resolving execution defaults
// instead of throwing model_capability_invalid at load time.
const LEGACY_OBSERVED_MODELS = {
  'ollama-cloud': ['qwen3-next:80b', 'qwen3-vl:235b', 'cogito-2.1:671b'],
  'openai-codex': ['gpt-5.3-codex'],
};

test('built-in catalog covers models observed in live standalone catalogs', () => {
  for (const [providerId, modelIds] of Object.entries(LEGACY_OBSERVED_MODELS)) {
    const builtinIds = BUILTIN_MODEL_CATALOG.providers[providerId].models
      .map((model) => model.id);
    for (const modelId of modelIds) {
      assert.ok(
        builtinIds.includes(modelId),
        `${providerId}/${modelId} missing from built-in catalog`,
      );
    }
  }
});

test('bare legacy catalog rows for observed models normalize via built-in defaults', () => {
  for (const [providerId, modelIds] of Object.entries(LEGACY_OBSERVED_MODELS)) {
    const normalized = normalizeProviderConfig(
      providerId,
      {
        label: BUILTIN_MODEL_CATALOG.providers[providerId].label,
        models: modelIds.map((id) => ({ id, kind: 'chat' })),
      },
      BUILTIN_MODEL_CATALOG.providers[providerId],
    );
    const defaults = BUILTIN_EXECUTION_DEFAULTS[providerId];
    assert.equal(normalized.models.length, modelIds.length);
    for (const model of normalized.models) {
      assert.equal(model.maxOutputTokens, defaults.maxOutputTokens,
        `${providerId}/${model.id} maxOutputTokens`);
      assert.equal(model.contextWindowTokens, defaults.contextWindowTokens,
        `${providerId}/${model.id} contextWindowTokens`);
      assert.equal(model.providerStallMs, defaults.providerStallMs,
        `${providerId}/${model.id} providerStallMs`);
      assert.equal(model.transport, defaults.transport,
        `${providerId}/${model.id} transport`);
    }
  }
});
