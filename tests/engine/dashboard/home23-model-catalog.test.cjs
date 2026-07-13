'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  buildHome23ModelAuthority,
  loadHome23ModelAuthority,
} = require('../../../engine/src/dashboard/home23-model-catalog.js');
const {
  BUILTIN_EXECUTION_DEFAULTS,
  BUILTIN_MODEL_CATALOG,
  normalizeModelCatalog,
} = require('../../../cosmo23/server/config/model-catalog.js');
const {
  createBrainProviderClientRegistry,
  pairKey,
} = require('../../../cosmo23/lib/brain-provider-client-registry.js');

function baseHome() {
  return {
    providers: {
      'openai-codex': {
        defaultModels: ['future-codex-model', 'shared-name', '   '],
      },
      xai: {
        defaultModels: ['shared-name', 'grok-home'],
      },
      'ollama-local': {
        baseUrl: 'http://127.0.0.1:11434',
      },
    },
    chat: {
      defaultProvider: 'xai',
      defaultModel: 'grok-home',
    },
    embeddings: {
      providers: [{
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      }],
    },
    query: {
      defaultProvider: 'xai',
      defaultModel: 'shared-name',
      pgsSweepProvider: 'openai-codex',
      pgsSweepModel: 'future-codex-model',
      pgsSynthProvider: 'xai',
      pgsSynthModel: 'grok-home',
      defaultMode: 'full',
      enablePGSByDefault: true,
      pgsDepth: 0.5,
    },
  };
}

test('pure builder exposes only Home23 exact chat pairs with COSMO provider capabilities', () => {
  const authority = buildHome23ModelAuthority({
    homeConfig: baseHome(),
    agentConfig: {},
  });

  assert.deepEqual(
    authority.models.map(({ provider, model, kind, source }) => ({
      provider, model, kind, source,
    })),
    [
      {
        provider: 'openai-codex', model: 'future-codex-model',
        kind: 'chat', source: 'home23-config',
      },
      {
        provider: 'openai-codex', model: 'shared-name',
        kind: 'chat', source: 'home23-config',
      },
      {
        provider: 'xai', model: 'shared-name',
        kind: 'chat', source: 'home23-config',
      },
      {
        provider: 'xai', model: 'grok-home',
        kind: 'chat', source: 'home23-config',
      },
    ],
  );
  assert.equal(
    authority.models.some(({ model }) => model === 'gpt-5.5' || model === 'grok-4.5'),
    false,
    'COSMO built-in model IDs must not leak into Home23 authority',
  );
  assert.deepEqual(
    authority.executionCatalog.providers['openai-codex'].executionDefaults,
    BUILTIN_EXECUTION_DEFAULTS['openai-codex'],
  );
  assert.deepEqual(
    authority.executionCatalog.providers.xai.executionDefaults,
    BUILTIN_EXECUTION_DEFAULTS.xai,
  );
  assert.deepEqual(
    authority.executionCatalog.providers['openai-codex'].models[0],
    {
      id: 'future-codex-model',
      label: 'future-codex-model',
      kind: 'chat',
      provider: 'openai-codex',
      source: 'home23-config',
      ...BUILTIN_EXECUTION_DEFAULTS['openai-codex'],
    },
  );
  assert.equal(Object.hasOwn(authority.executionCatalog.providers, 'ollama-local'), false);
  assert.deepEqual(authority.executionCatalog.defaults.embeddings, {
    ...BUILTIN_MODEL_CATALOG.defaults.embeddings,
    dimensions: 1536,
  });
  assert.deepEqual(
    authority.executionCatalog.providers.openai.models,
    BUILTIN_MODEL_CATALOG.providers.openai.models.filter(({ kind }) => kind === 'embedding'),
  );
  assert.doesNotThrow(() => normalizeModelCatalog(authority.executionCatalog));
});

test('selected agent Query authority exposes the same exact pairs as Chat aliases', () => {
  const homeConfig = baseHome();
  homeConfig.models = {
    aliases: {
      terra: { provider: 'openai-codex', model: 'future-codex-model' },
      grok: { provider: 'xai', model: 'grok-home' },
      'grok-again': { provider: 'xai', model: 'grok-home' },
    },
  };

  const authority = buildHome23ModelAuthority({ homeConfig, agentConfig: {} });

  assert.deepEqual(
    authority.models.map(({ provider, model }) => ({ provider, model })),
    [
      { provider: 'openai-codex', model: 'future-codex-model' },
      { provider: 'xai', model: 'grok-home' },
    ],
  );
  assert.deepEqual(
    authority.executionCatalog.providers['openai-codex'].models
      .filter(({ kind }) => kind === 'chat')
      .map(({ provider, id }) => ({ provider, model: id })),
    [{ provider: 'openai-codex', model: 'future-codex-model' }],
  );
  assert.deepEqual(
    authority.executionCatalog.providers.xai.models
      .filter(({ kind }) => kind === 'chat')
      .map(({ provider, id }) => ({ provider, model: id })),
    [{ provider: 'xai', model: 'grok-home' }],
  );
  assert.deepEqual(authority.queryDefaults, {
    defaultProvider: 'xai',
    defaultModel: 'grok-home',
    pgsSweepProvider: 'openai-codex',
    pgsSweepModel: 'future-codex-model',
    pgsSynthProvider: 'xai',
    pgsSynthModel: 'grok-home',
    defaultMode: 'full',
    enablePGSByDefault: true,
    pgsDepth: 0.5,
  });
});

test('agent role preferences resolve only as configured exact pairs and otherwise use Chat', () => {
  const authority = buildHome23ModelAuthority({
    homeConfig: baseHome(),
    agentConfig: {
      chat: {
        defaultProvider: 'openai-codex',
        defaultModel: 'future-codex-model',
      },
      query: {
        defaultProvider: 'xai',
        defaultModel: 'shared-name',
        pgsSweepProvider: 'xai',
        pgsSweepModel: 'not-configured',
        pgsSynthProvider: 'openai-codex',
        pgsSynthModel: 'grok-home',
        defaultMode: 'dive',
        enablePGSByDefault: false,
        pgsDepth: 0.25,
      },
    },
  });

  assert.deepEqual(authority.queryDefaults, {
    defaultProvider: 'xai',
    defaultModel: 'shared-name',
    pgsSweepProvider: 'openai-codex',
    pgsSweepModel: 'future-codex-model',
    pgsSynthProvider: 'openai-codex',
    pgsSynthModel: 'future-codex-model',
    defaultMode: 'dive',
    enablePGSByDefault: false,
    pgsDepth: 0.25,
  });
  assert.deepEqual(authority.executionCatalog.defaults, {
    queryModel: 'shared-name',
    pgsSweepModel: 'future-codex-model',
    launch: {
      primary: 'shared-name',
      fast: 'shared-name',
      strategic: 'shared-name',
    },
    embeddings: {
      ...BUILTIN_MODEL_CATALOG.defaults.embeddings,
      dimensions: 1536,
    },
  });
});

test('query roles use Home defaults when the agent has no query override', () => {
  const authority = buildHome23ModelAuthority({
    homeConfig: baseHome(),
    agentConfig: {
      chat: {
        defaultProvider: 'openai-codex',
        defaultModel: 'future-codex-model',
      },
    },
  });

  assert.deepEqual(authority.queryDefaults, {
    defaultProvider: 'xai',
    defaultModel: 'shared-name',
    pgsSweepProvider: 'openai-codex',
    pgsSweepModel: 'future-codex-model',
    pgsSynthProvider: 'xai',
    pgsSynthModel: 'grok-home',
    defaultMode: 'full',
    enablePGSByDefault: true,
    pgsDepth: 0.5,
  });
});

test('builder fails closed when the current Chat pair is not configured', () => {
  const homeConfig = baseHome();
  assert.throws(
    () => buildHome23ModelAuthority({
      homeConfig,
      agentConfig: {
        chat: {
          defaultProvider: 'openai-codex',
          defaultModel: 'grok-home',
        },
      },
    }),
    (error) => error.code === 'model_catalog_invalid'
      && error.retryable === false
      && /Chat pair/.test(error.message),
  );
});

test('builder rejects declared providers that lack reviewed execution capabilities', () => {
  const homeConfig = baseHome();
  homeConfig.providers.custom = { defaultModels: ['custom-model'] };
  assert.throws(
    () => buildHome23ModelAuthority({ homeConfig, agentConfig: {} }),
    (error) => error.code === 'model_catalog_invalid'
      && /execution capabilities/.test(error.message),
  );
});

test('execution catalog is directly usable by the exact-pair brain provider registry', () => {
  const authority = buildHome23ModelAuthority({
    homeConfig: baseHome(),
    agentConfig: {},
  });
  const client = { providerId: 'openai-codex', generate() {} };
  const registry = createBrainProviderClientRegistry({
    catalog: authority.executionCatalog,
    pairFactories: {
      [pairKey('openai-codex', 'future-codex-model')]: () => client,
    },
  });

  assert.equal(registry.getExact('openai-codex', 'future-codex-model'), client);
});

test('filesystem loader reads Home23 and the selected agent configs', (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-model-authority-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home23Root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home23Root, 'instances', 'jerry'), { recursive: true });
  fs.writeFileSync(
    path.join(home23Root, 'config', 'home.yaml'),
    yaml.dump(baseHome()),
  );
  fs.writeFileSync(
    path.join(home23Root, 'instances', 'jerry', 'config.yaml'),
    yaml.dump({
      chat: {
        defaultProvider: 'openai-codex',
        defaultModel: 'future-codex-model',
      },
      query: {
        defaultProvider: 'openai-codex',
        defaultModel: 'future-codex-model',
        pgsSweepProvider: 'xai',
        pgsSweepModel: 'shared-name',
        pgsSynthProvider: 'xai',
        pgsSynthModel: 'missing',
        defaultMode: 'quick',
        enablePGSByDefault: false,
        pgsDepth: 0.1,
      },
    }),
  );

  const authority = loadHome23ModelAuthority({ home23Root, agent: 'jerry' });
  assert.deepEqual(authority.queryDefaults, {
    defaultProvider: 'openai-codex',
    defaultModel: 'future-codex-model',
    pgsSweepProvider: 'xai',
    pgsSweepModel: 'shared-name',
    pgsSynthProvider: 'openai-codex',
    pgsSynthModel: 'future-codex-model',
    defaultMode: 'quick',
    enablePGSByDefault: false,
    pgsDepth: 0.1,
  });
  assert.throws(
    () => loadHome23ModelAuthority({ home23Root, agent: '../forrest' }),
    (error) => error.code === 'model_catalog_invalid',
  );
});

test('filesystem loader supports fresh-install seeding before an agent exists', (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-model-authority-fresh-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home23Root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home23Root, 'config', 'home.yaml'),
    yaml.dump(baseHome()),
  );

  const authority = loadHome23ModelAuthority({ home23Root });
  assert.equal(authority.queryDefaults.defaultProvider, 'xai');
  assert.equal(authority.queryDefaults.defaultModel, 'shared-name');
  assert.deepEqual(authority.executionCatalog.defaults.launch, {
    primary: 'shared-name',
    fast: 'shared-name',
    strategic: 'shared-name',
  });
});

test('public model aliases resolve only to exact selectable Home23 pairs', () => {
  const homeConfig = yaml.load(fs.readFileSync(
    path.join(__dirname, '../../../config/home.yaml.example'),
    'utf8',
  ));
  const selectablePairs = new Set(
    Object.entries(homeConfig.providers || {}).flatMap(([provider, config]) => (
      (config.defaultModels || []).map((model) => `${provider}\0${model}`)
    )),
  );

  for (const [alias, pair] of Object.entries(homeConfig.models?.aliases || {})) {
    assert.equal(
      selectablePairs.has(`${pair.provider}\0${pair.model}`),
      true,
      `${alias} must resolve to a configured provider/model pair`,
    );
  }
});
