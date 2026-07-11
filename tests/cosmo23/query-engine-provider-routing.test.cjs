const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');
const { loadModelCatalogSync } = require('../../cosmo23/server/config/model-catalog');

function useTemporaryCatalog(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-engine-provider-routing-'));
  const catalogPath = path.join(root, 'model-catalog.json');
  const previous = process.env.COSMO23_MODEL_CATALOG_PATH;
  process.env.COSMO23_MODEL_CATALOG_PATH = catalogPath;
  t.after(() => {
    if (previous === undefined) delete process.env.COSMO23_MODEL_CATALOG_PATH;
    else process.env.COSMO23_MODEL_CATALOG_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function makeRuntime(overrides = {}) {
  const runtime = Object.create(QueryEngine.prototype);
  runtime.modelCatalog = loadModelCatalogSync();
  runtime.providerRegistry = {
    get(provider, model) {
      if (provider === 'minimax' && model === 'MiniMax-M3') {
        return { id: 'minimax', providerId: 'minimax', generate() {} };
      }
      throw Object.assign(new Error('unavailable'), { code: 'provider_unavailable' });
    },
  };
  return Object.assign(runtime, overrides);
}

test('routes an exact MiniMax pair through the injected registry', t => {
  useTemporaryCatalog(t);
  const runtime = makeRuntime();

  const resolved = runtime.resolveQueryRuntime('MiniMax-M3', 'minimax');

  assert.equal(resolved.providerId, 'minimax');
  assert.equal(resolved.providerLabel, 'minimax');
  assert.equal(resolved.client.id, 'minimax');
  assert.equal(resolved.effectiveModel, 'MiniMax-M3');
});

test('never infers MiniMax from a model-only selection', t => {
  useTemporaryCatalog(t);
  const runtime = makeRuntime();

  assert.throws(
    () => runtime.resolveQueryRuntime('MiniMax-M3'),
    error => error.code === 'provider_model_mismatch',
  );
});

test('builds Codex query input as response input items', () => {
  assert.deepEqual(QueryEngine.buildCodexInputItems('context\n\nQuestion: test'), [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'context\n\nQuestion: test' }],
  }]);
});
