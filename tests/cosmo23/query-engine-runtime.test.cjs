const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');
const {
  flattenCatalogModels,
  getModelCapabilities,
  loadModelCatalogSync,
  saveModelCatalogSync,
  validateSelectableModelCapabilities,
} = require('../../cosmo23/server/config/model-catalog');

function useCatalogPath(t, catalogPath) {
  const previous = process.env.COSMO23_MODEL_CATALOG_PATH;
  process.env.COSMO23_MODEL_CATALOG_PATH = catalogPath;
  t.after(() => {
    if (previous === undefined) delete process.env.COSMO23_MODEL_CATALOG_PATH;
    else process.env.COSMO23_MODEL_CATALOG_PATH = previous;
  });
}

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

test('model catalog preserves declared provider execution capabilities', () => {
  const catalog = loadModelCatalogSync();
  const capabilities = getModelCapabilities(catalog, 'minimax', 'MiniMax-M3');
  assert.equal(capabilities.maxOutputTokens, 32768);
  assert.equal(capabilities.providerStallMs, 900000);
});

test('capability lookup uses provider plus model rather than model alone', () => {
  const catalog = { version: 1, providers: {
    openai: { models: [{
      id: 'shared-model', kind: 'chat', maxOutputTokens: 12000,
      providerStallMs: 120000, transport: 'responses',
    }] },
    minimax: { models: [{
      id: 'shared-model', kind: 'chat', maxOutputTokens: 32768,
      providerStallMs: 900000, transport: 'anthropic-messages',
    }] },
  } };
  assert.deepEqual(getModelCapabilities(catalog, 'openai', 'shared-model'), {
    maxOutputTokens: 12000,
    providerStallMs: 120000,
  });
  assert.deepEqual(getModelCapabilities(catalog, 'minimax', 'shared-model'), {
    maxOutputTokens: 32768,
    providerStallMs: 900000,
  });
});

test('every selectable built-in chat model has valid execution capabilities', () => {
  const catalog = loadModelCatalogSync();
  assert.doesNotThrow(() => validateSelectableModelCapabilities(catalog));
  for (const model of flattenCatalogModels(catalog).filter(entry => entry.kind === 'chat')) {
    const capabilities = getModelCapabilities(catalog, model.provider, model.id);
    assert.equal(Number.isSafeInteger(capabilities.maxOutputTokens), true);
    assert.equal(capabilities.maxOutputTokens > 0, true);
    assert.equal(Number.isSafeInteger(capabilities.providerStallMs), true);
    assert.equal(capabilities.providerStallMs > 0, true);
    assert.equal(new Set([
      'responses',
      'chat-completions',
      'anthropic-messages',
      'codex-responses',
    ]).has(model.transport), true);
  }
});

test('missing, invalid, and ambiguous model selections are typed failures', () => {
  const catalog = { version: 1, providers: {
    a: {
      executionDefaults: {
        maxOutputTokens: 100,
        providerStallMs: 1000,
        transport: 'chat-completions',
      },
      models: [{ id: 'shared', kind: 'chat' }],
    },
    b: {
      executionDefaults: {
        maxOutputTokens: 200,
        providerStallMs: 2000,
        transport: 'chat-completions',
      },
      models: [
        { id: 'shared', kind: 'chat' },
        { id: 'bad', kind: 'chat', maxOutputTokens: 0 },
      ],
    },
  } };
  assert.throws(
    () => getModelCapabilities(catalog, null, 'shared'),
    error => error.code === 'model_ambiguous',
  );
  assert.throws(
    () => getModelCapabilities(catalog, 'a', 'missing'),
    error => error.code === 'model_not_found',
  );
  assert.throws(
    () => getModelCapabilities(catalog, 'b', 'bad'),
    error => error.code === 'model_capability_invalid',
  );
});

test('valid custom providers survive an atomic save and reload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
  const catalogPath = path.join(root, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  useCatalogPath(t, catalogPath);

  const saved = saveModelCatalogSync({ version: 1, providers: {
    acme: {
      label: 'Acme',
      executionDefaults: {
        maxOutputTokens: 4096,
        providerStallMs: 120000,
        transport: 'chat-completions',
      },
      models: [{ id: 'shared-model', kind: 'chat' }],
    },
  } });
  assert.equal(saved.providers.acme.models[0].provider, 'acme');
  assert.deepEqual(
    loadModelCatalogSync().providers.acme.models[0],
    saved.providers.acme.models[0],
  );
});

test('present invalid custom catalogs fail closed on save and load', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-invalid-'));
  const catalogPath = path.join(root, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  useCatalogPath(t, catalogPath);

  const invalid = { version: 1, providers: {
    acme: { models: [{ id: 'missing-capabilities', kind: 'chat' }] },
  } };
  assert.throws(
    () => saveModelCatalogSync(invalid),
    error => error.code === 'model_capability_invalid',
  );
  assert.equal(fs.existsSync(catalogPath), false);

  fs.writeFileSync(catalogPath, JSON.stringify(invalid));
  assert.throws(
    () => loadModelCatalogSync(),
    error => error.code === 'model_capability_invalid',
  );

  fs.writeFileSync(catalogPath, '{not json');
  assert.throws(
    () => loadModelCatalogSync(),
    error => error.code === 'model_catalog_invalid',
  );
});

test('atomic catalog save leaves a complete old or new file across injected crash points', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-atomic-'));
  const catalogPath = path.join(root, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  useCatalogPath(t, catalogPath);

  const provider = (label, maxOutputTokens) => ({
    label,
    executionDefaults: {
      maxOutputTokens,
      providerStallMs: 120000,
      transport: 'chat-completions',
    },
    models: [{ id: 'acme-model', kind: 'chat' }],
  });
  saveModelCatalogSync({ version: 1, providers: { acme: provider('Old', 2048) } });
  const oldBytes = fs.readFileSync(catalogPath);

  assert.throws(() => saveModelCatalogSync(
    { version: 1, providers: { acme: provider('New', 4096) } },
    { _testCrashAt: 'before-rename' },
  ), /injected model catalog crash/);
  assert.deepEqual(fs.readFileSync(catalogPath), oldBytes);
  assert.equal(loadModelCatalogSync().providers.acme.label, 'Old');

  assert.throws(() => saveModelCatalogSync(
    { version: 1, providers: { acme: provider('New', 4096) } },
    { _testCrashAt: 'after-rename' },
  ), /injected model catalog crash/);
  assert.equal(loadModelCatalogSync().providers.acme.label, 'New');
  assert.equal(loadModelCatalogSync().providers.acme.models[0].maxOutputTokens, 4096);
  assert.deepEqual(
    fs.readdirSync(root).filter(name => name.includes('.tmp-')),
    [],
  );
});
