const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILTIN_MODEL_CATALOG,
  normalizeModelCatalog,
} = require('../../server/config/model-catalog');

const previousOpusModelId = ['claude', 'opus', '4', '7'].join('-');
const previousMiniMaxModelPattern = new RegExp(['MiniMax-M', '2|minimax-m', '2'].join(''), 'i');

test('COSMO built-in Anthropic catalog exposes Claude Opus 4.8', () => {
  const catalog = normalizeModelCatalog(BUILTIN_MODEL_CATALOG);
  const anthropicModels = catalog.providers.anthropic.models.map((model) => model.id);

  assert.ok(anthropicModels.includes('claude-opus-4-8'));
  assert.equal(anthropicModels.includes(previousOpusModelId), false);
});

test('COSMO built-in MiniMax catalog exposes only MiniMax-M3', () => {
  const catalog = normalizeModelCatalog(BUILTIN_MODEL_CATALOG);
  const minimaxModels = catalog.providers.minimax.models.map((model) => model.id);
  const ollamaCloudModels = catalog.providers['ollama-cloud'].models.map((model) => model.id);

  assert.deepEqual(minimaxModels, ['MiniMax-M3']);
  assert.equal(ollamaCloudModels.some((model) => previousMiniMaxModelPattern.test(model)), false);
});
