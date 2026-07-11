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
  normalizeModelCatalog,
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

function useTemporaryCatalog(t, prefix = 'model-catalog-isolated-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const catalogPath = path.join(root, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  useCatalogPath(t, catalogPath);
  return { root, catalogPath };
}

function assertCatalogError(action, code = 'model_catalog_invalid') {
  assert.throws(
    action,
    error => error.code === code && error.retryable === false,
  );
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

test('routes MiniMax query defaults to the MiniMax query client', t => {
  useTemporaryCatalog(t);
  const runtime = makeRuntime();

  const resolved = runtime.resolveQueryRuntime('MiniMax-M3');

  assert.equal(resolved.providerId, 'minimax');
  assert.equal(resolved.providerLabel, 'MiniMax');
  assert.equal(resolved.client, runtime.minimaxQueryClient);
  assert.equal(resolved.effectiveModel, 'MiniMax-M3');
});

test('fails clearly when MiniMax is selected but no MiniMax query client is configured', t => {
  useTemporaryCatalog(t);
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

test('model catalog preserves declared provider execution capabilities', t => {
  useTemporaryCatalog(t);
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

test('custom models under built-in providers require source-declared capabilities', () => {
  const customModel = { id: 'custom-openai-model', kind: 'chat' };
  const catalog = providers => ({ version: 1, providers });

  assertCatalogError(
    () => normalizeModelCatalog(catalog({
      openai: { models: [customModel] },
    })),
    'model_capability_invalid',
  );
  assertCatalogError(
    () => normalizeModelCatalog(catalog({
      openai: {
        executionDefaults: { maxOutputTokens: 4096 },
        models: [customModel],
      },
    })),
    'model_capability_invalid',
  );

  const explicit = normalizeModelCatalog(catalog({
    openai: {
      executionDefaults: {
        maxOutputTokens: 4096,
        providerStallMs: 120000,
        transport: 'responses',
      },
      models: [customModel],
    },
  }));
  assert.deepEqual(
    getModelCapabilities(explicit, 'openai', 'custom-openai-model'),
    { maxOutputTokens: 4096, providerStallMs: 120000 },
  );

  const modelDeclared = normalizeModelCatalog(catalog({
    openai: {
      models: [{
        ...customModel,
        maxOutputTokens: 2048,
        providerStallMs: 60000,
        transport: 'responses',
      }],
    },
  }));
  assert.deepEqual(
    getModelCapabilities(modelDeclared, 'openai', 'custom-openai-model'),
    { maxOutputTokens: 2048, providerStallMs: 60000 },
  );

  const legacy = normalizeModelCatalog(catalog({
    openai: { models: [{ id: 'gpt-5.4-mini', kind: 'chat' }] },
  }));
  assert.deepEqual(
    getModelCapabilities(legacy, 'openai', 'gpt-5.4-mini'),
    { maxOutputTokens: 32768, providerStallMs: 900000 },
  );
});

test('reviewed legacy Home23 xAI models receive only the xAI built-in defaults', () => {
  const legacyModels = [
    ['grok-4.20-0309-reasoning', 'chat-completions'],
    ['grok-4.20-0309-non-reasoning', 'chat-completions'],
    ['grok-4.20-multi-agent-0309', 'responses'],
  ];

  for (const [modelId, transport] of legacyModels) {
    const catalog = normalizeModelCatalog({ version: 1, providers: {
      xai: { models: [{ id: modelId, kind: 'chat' }] },
    } });
    assert.deepEqual(
      getModelCapabilities(catalog, 'xai', modelId),
      { maxOutputTokens: 8192, providerStallMs: 900000 },
    );
    assert.equal(catalog.providers.xai.models[0].transport, transport);
  }

  assertCatalogError(
    () => normalizeModelCatalog({ version: 1, providers: {
      xai: { models: [{ id: 'grok-unreviewed-custom', kind: 'chat' }] },
    } }),
    'model_capability_invalid',
  );
});

test('every selectable built-in chat model has valid execution capabilities', t => {
  useTemporaryCatalog(t);
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

test('generated built-in execution defaults stay non-declared across save and reload', t => {
  useTemporaryCatalog(t, 'model-catalog-default-provenance-');
  saveModelCatalogSync({ version: 1, providers: {
    openai: {
      models: [{
        id: 'custom-openai-explicit',
        kind: 'chat',
        maxOutputTokens: 2048,
        providerStallMs: 60000,
        transport: 'responses',
      }],
    },
  } });

  const reloaded = loadModelCatalogSync();
  reloaded.providers.openai.models.push({
    id: 'custom-openai-capability-less',
    kind: 'chat',
  });

  assertCatalogError(
    () => saveModelCatalogSync(reloaded),
    'model_capability_invalid',
  );
});

test('structurally invalid saves fail closed and preserve the prior catalog bytes', t => {
  const { catalogPath } = useTemporaryCatalog(t, 'model-catalog-invalid-save-');
  const valid = { version: 1, providers: {
    acme: {
      executionDefaults: {
        maxOutputTokens: 4096,
        providerStallMs: 120000,
        transport: 'chat-completions',
      },
      models: [{ id: 'acme-model', kind: 'chat' }],
    },
  } };
  saveModelCatalogSync(valid);
  const priorBytes = fs.readFileSync(catalogPath);

  for (const [name, invalid] of [
    ['null root', null],
    ['array root', []],
    ['missing providers', {}],
    ['array providers', { version: 1, providers: [] }],
    ['string providers', { version: 1, providers: 'invalid' }],
    ['invalid provider row', { version: 1, providers: { acme: 'invalid' } }],
    ['invalid models shape', { version: 1, providers: { acme: { models: 'invalid' } } }],
    ['invalid defaults shape', { version: 1, providers: {
      acme: { executionDefaults: 'invalid', models: [] },
    } }],
    ['null model row', { version: 1, providers: { acme: { models: [null] } } }],
    ['missing model id', { version: 1, providers: { acme: { models: [{}] } } }],
  ]) {
    assertCatalogError(
      () => saveModelCatalogSync(invalid),
      'model_catalog_invalid',
    );
    assert.deepEqual(fs.readFileSync(catalogPath), priorBytes, name);
    assert.equal(loadModelCatalogSync().providers.acme.models[0].id, 'acme-model', name);
  }
});

test('present structurally invalid catalogs fail closed on load', t => {
  const { catalogPath } = useTemporaryCatalog(t, 'model-catalog-invalid-load-');
  for (const [name, invalid] of [
    ['null root', null],
    ['array root', []],
    ['missing providers', {}],
    ['array providers', { version: 1, providers: [] }],
    ['string providers', { version: 1, providers: 'invalid' }],
    ['invalid provider row', { version: 1, providers: { acme: 'invalid' } }],
    ['invalid models shape', { version: 1, providers: { acme: { models: 'invalid' } } }],
    ['null model row', { version: 1, providers: { acme: { models: [null] } } }],
    ['missing model id', { version: 1, providers: { acme: { models: [{}] } } }],
  ]) {
    fs.writeFileSync(catalogPath, JSON.stringify(invalid));
    assertCatalogError(
      () => loadModelCatalogSync(),
      'model_catalog_invalid',
    );
    assert.equal(fs.existsSync(catalogPath), true, name);
  }
});

test('an absent catalog alone receives built-in defaults', t => {
  useTemporaryCatalog(t, 'model-catalog-absent-');
  const loaded = loadModelCatalogSync();
  assert.equal(loaded.providers.minimax.models[0].id, 'MiniMax-M3');
});

test('a dangling catalog symlink fails closed instead of loading built-ins', t => {
  const { root, catalogPath } = useTemporaryCatalog(t, 'model-catalog-dangling-');
  fs.symlinkSync(path.join(root, 'missing-target.json'), catalogPath);
  assert.equal(fs.lstatSync(catalogPath).isSymbolicLink(), true);
  assertCatalogError(
    () => loadModelCatalogSync(),
    'model_catalog_invalid',
  );
});

test('a catalog beneath a dangling parent symlink fails closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-dangling-parent-'));
  const linkedParent = path.join(root, 'config-link');
  const catalogPath = path.join(linkedParent, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  useCatalogPath(t, catalogPath);

  fs.symlinkSync(path.join(root, 'missing-config-directory'), linkedParent, 'dir');
  assert.equal(fs.lstatSync(linkedParent).isSymbolicLink(), true);
  assertCatalogError(
    () => loadModelCatalogSync(),
    'model_catalog_invalid',
  );
});

test('an unreadable present catalog path fails closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-unreadable-'));
  const locked = path.join(root, 'locked');
  const catalogPath = path.join(locked, 'model-catalog.json');
  fs.mkdirSync(locked);
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, providers: {} }));
  useCatalogPath(t, catalogPath);
  t.after(() => {
    try {
      fs.chmodSync(locked, 0o700);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.chmodSync(locked, 0o000);
  let directReadError = null;
  try {
    fs.readFileSync(catalogPath, 'utf8');
  } catch (error) {
    directReadError = error;
  }
  if (directReadError?.code !== 'EACCES') {
    fs.chmodSync(locked, 0o700);
    t.skip('filesystem permissions do not produce EACCES for this process');
    return;
  }
  try {
    assertCatalogError(
      () => loadModelCatalogSync(),
      'model_catalog_invalid',
    );
  } finally {
    fs.chmodSync(locked, 0o700);
  }
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
  const realFsyncSync = fs.fsyncSync;
  let fsyncCalls = 0;
  fs.fsyncSync = function trackedFsyncSync(fd) {
    fsyncCalls += 1;
    return realFsyncSync.call(fs, fd);
  };
  t.after(() => {
    fs.fsyncSync = realFsyncSync;
  });

  saveModelCatalogSync({ version: 1, providers: { acme: provider('Old', 2048) } });
  assert.equal(fsyncCalls, 2, 'successful save fsyncs the file and directory');
  const oldBytes = fs.readFileSync(catalogPath);

  fsyncCalls = 0;
  assert.throws(() => saveModelCatalogSync(
    { version: 1, providers: { acme: provider('New', 4096) } },
    { _testCrashAt: 'before-rename' },
  ), /injected model catalog crash/);
  assert.equal(fsyncCalls, 1, 'pre-rename crash occurs after only the temp-file fsync');
  assert.deepEqual(fs.readFileSync(catalogPath), oldBytes);
  assert.equal(loadModelCatalogSync().providers.acme.label, 'Old');

  fsyncCalls = 0;
  assert.throws(() => saveModelCatalogSync(
    { version: 1, providers: { acme: provider('New', 4096) } },
    { _testCrashAt: 'after-rename' },
  ), /injected model catalog crash/);
  assert.equal(
    fsyncCalls,
    1,
    'post-rename crash is injected before the directory fsync',
  );
  const reloaded = loadModelCatalogSync();
  assert.equal(new Set(['Old', 'New']).has(reloaded.providers.acme.label), true);
  if (reloaded.providers.acme.label === 'New') {
    assert.equal(reloaded.providers.acme.models[0].maxOutputTokens, 4096);
  }
  assert.deepEqual(
    fs.readdirSync(root).filter(name => name.includes('.tmp-')),
    [],
  );
});
