const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { loadModelCatalogSync } = require('../../cosmo23/server/config/model-catalog');

const repoRoot = path.resolve(__dirname, '../..');
const previousOpusModelId = ['claude', 'opus', '4', '7'].join('-');
const previousMiniMaxModelPattern = new RegExp(['MiniMax-M', '2|minimax-m', '2'].join(''), 'i');

test('Home23 model defaults use Claude Opus 4.8 instead of the previous Opus release', () => {
  const homeConfig = yaml.load(fs.readFileSync(path.join(repoRoot, 'config/home.yaml'), 'utf8'));

  assert.deepEqual(homeConfig.providers.anthropic.defaultModels, [
    'claude-sonnet-4-7',
    'claude-opus-4-8',
    'claude-haiku-4-5'
  ]);
  assert.equal(homeConfig.models.aliases.opus.model, 'claude-opus-4-8');
  assert.equal(homeConfig.query.defaultModel, 'claude-opus-4-8');
  assert.equal(homeConfig.query.pgsSynthModel, 'claude-opus-4-8');
});

test('COSMO built-in Anthropic catalog exposes Claude Opus 4.8', () => {
  const catalog = loadModelCatalogSync();
  const anthropicModels = catalog.providers.anthropic.models.map((model) => model.id);

  assert.ok(anthropicModels.includes('claude-opus-4-8'));
  assert.equal(anthropicModels.includes(previousOpusModelId), false);
});

test('Evobrew default runtime preferences point PGS synthesis at Claude Opus 4.8', () => {
  const runtimeSettings = fs.readFileSync(path.join(repoRoot, 'evobrew/public/js/ui-runtime-settings.js'), 'utf8');

  assert.match(runtimeSettings, /anthropic\/claude-opus-4-8/);
  assert.doesNotMatch(runtimeSettings, new RegExp(`anthropic/${previousOpusModelId}`));
});

test('Home23 MiniMax catalog uses M3 and removes older M2 models', () => {
  const homeConfig = yaml.load(fs.readFileSync(path.join(repoRoot, 'config/home.yaml'), 'utf8'));
  const ollamaCloudModels = homeConfig.providers['ollama-cloud'].defaultModels || [];

  assert.deepEqual(homeConfig.providers.minimax.defaultModels, ['MiniMax-M3']);
  assert.equal(homeConfig.models.aliases.minimax.model, 'MiniMax-M3');
  assert.equal(homeConfig.query.pgsSweepModel, 'MiniMax-M3');
  assert.equal(ollamaCloudModels.some((model) => previousMiniMaxModelPattern.test(model)), false);
});

test('COSMO built-in MiniMax catalog exposes only MiniMax-M3', () => {
  const catalog = loadModelCatalogSync();
  const minimaxModels = catalog.providers.minimax.models.map((model) => model.id);
  const ollamaCloudModels = catalog.providers['ollama-cloud'].models.map((model) => model.id);

  assert.deepEqual(minimaxModels, ['MiniMax-M3']);
  assert.equal(ollamaCloudModels.some((model) => previousMiniMaxModelPattern.test(model)), false);
});

test('Evobrew default runtime preferences point PGS sweep at MiniMax-M3', () => {
  const runtimeSettings = fs.readFileSync(path.join(repoRoot, 'evobrew/public/js/ui-runtime-settings.js'), 'utf8');

  assert.match(runtimeSettings, /minimax\/MiniMax-M3/);
  assert.doesNotMatch(runtimeSettings, previousMiniMaxModelPattern);
});
