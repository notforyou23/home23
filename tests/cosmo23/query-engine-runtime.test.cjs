const test = require('node:test');
const assert = require('node:assert/strict');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');
const { loadModelCatalogSync } = require('../../cosmo23/server/config/model-catalog');

function makeRuntime(overrides = {}) {
  const runtime = Object.create(QueryEngine.prototype);
  runtime.modelCatalog = loadModelCatalogSync();
  runtime.modelDefaults = { queryModel: 'MiniMax-M3' };
  runtime.gpt5Client = { id: 'gpt' };
  runtime.anthropicClient = { id: 'anthropic' };
  runtime.minimaxQueryClient = { id: 'minimax' };
  runtime.ollamaCloudClient = { id: 'ollama-cloud' };
  runtime.xaiQueryClient = { id: 'xai' };
  runtime.xaiResponsesClient = { id: 'xai-responses' };
  runtime.localQueryClient = { id: 'local', defaultModel: 'qwen3.5:4b' };
  runtime.runMetadata = {};
  return Object.assign(runtime, overrides);
}

test('routes MiniMax query defaults to the MiniMax query client', () => {
  const runtime = makeRuntime();

  const resolved = runtime.resolveQueryRuntime('MiniMax-M3');

  assert.equal(resolved.providerId, 'minimax');
  assert.equal(resolved.providerLabel, 'MiniMax');
  assert.equal(resolved.client, runtime.minimaxQueryClient);
  assert.equal(resolved.effectiveModel, 'MiniMax-M3');
});

test('fails clearly when MiniMax is selected but no MiniMax query client is configured', () => {
  const runtime = makeRuntime({ minimaxQueryClient: null });

  assert.throws(
    () => runtime.resolveQueryRuntime('MiniMax-M3'),
    /MiniMax-M3.*minimax.*not configured/i
  );
});

test('builds Codex query input as response input items', () => {
  assert.deepEqual(QueryEngine.buildCodexInputItems('context\n\nQuestion: test'), [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'context\n\nQuestion: test' }]
  }]);
});
