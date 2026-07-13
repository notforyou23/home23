import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

import { seedCosmo23Config } from '../../cli/lib/cosmo23-config.js';

const require = createRequire(import.meta.url);
const {
  getModelCapabilities,
  normalizeModelCatalog,
} = require('../../cosmo23/server/config/model-catalog.js');

function makeInstall() {
  const root = mkdtempSync(join(tmpdir(), 'home23-cosmo-catalog-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'cosmo23', '.cosmo23-config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'jerry'), { recursive: true });
  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), '{}\n');
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump({
    brainOperations: { capabilityKey: 'a'.repeat(64) },
    cosmo23: { encryptionKey: 'b'.repeat(64) },
  }), { mode: 0o600 });
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
    providers: {
      openai: { defaultModels: ['gpt-home-custom'] },
      xai: { defaultModels: ['grok-home-custom'] },
      'openai-codex': { defaultModels: ['codex-home-custom'] },
    },
    embeddings: {
      providers: [{
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      }],
    },
    models: {
      aliases: {
        gpt: { provider: 'openai', model: 'gpt-home-custom' },
        grok: { provider: 'xai', model: 'grok-home-custom' },
        codex: { provider: 'openai-codex', model: 'codex-home-custom' },
      },
    },
    chat: { defaultProvider: 'openai', defaultModel: 'gpt-home-custom' },
    query: {
      defaultProvider: 'openai',
      defaultModel: 'gpt-home-custom',
      pgsSweepProvider: 'xai',
      pgsSweepModel: 'grok-home-custom',
      pgsSynthProvider: 'openai-codex',
      pgsSynthModel: 'codex-home-custom',
    },
  }));
  writeFileSync(
    join(root, 'cosmo23', '.cosmo23-config', 'model-catalog.json'),
    JSON.stringify({
      version: 1,
      providers: {
        openai: {
          models: [{
            id: 'stale-discovered-model',
            kind: 'chat',
            maxOutputTokens: 1024,
            contextWindowTokens: 8192,
            providerStallMs: 1000,
            transport: 'responses',
          }],
        },
      },
      defaults: { queryModel: 'stale-discovered-model' },
    }, null, 2),
  );
  return root;
}

function chatPairs(catalog) {
  return Object.entries(catalog.providers || {}).flatMap(([provider, config]) =>
    (config.models || [])
      .filter((model) => model.kind === 'chat')
      .map((model) => `${provider}/${model.id}`))
    .sort();
}

test('COSMO seed replaces stale discovery with Home23 provider defaultModels', async (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await seedCosmo23Config(root);
  const catalogPath = join(root, 'cosmo23', '.cosmo23-config', 'model-catalog.json');
  const persisted = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const managedConfig = JSON.parse(readFileSync(result.configPath, 'utf8'));

  assert.equal(result.modelCatalogPath, catalogPath);
  assert.deepEqual(chatPairs(persisted), [
    'openai-codex/codex-home-custom',
    'openai/gpt-home-custom',
    'xai/grok-home-custom',
  ]);
  assert.equal(JSON.stringify(persisted).includes('stale-discovered-model'), false);
  assert.deepEqual(managedConfig.home23.queryDefaults, {
    defaultProvider: 'openai',
    defaultModel: 'gpt-home-custom',
    pgsSweepProvider: 'xai',
    pgsSweepModel: 'grok-home-custom',
    pgsSynthProvider: 'openai-codex',
    pgsSynthModel: 'codex-home-custom',
    defaultMode: 'full',
    enablePGSByDefault: false,
    pgsDepth: 0.25,
  });
});

test('seeded COSMO catalog retains executable capabilities and embedding authority', async (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await seedCosmo23Config(root);
  const persisted = JSON.parse(readFileSync(
    join(root, 'cosmo23', '.cosmo23-config', 'model-catalog.json'),
    'utf8',
  ));
  const normalized = normalizeModelCatalog(persisted);

  assert.deepEqual(chatPairs(normalized), [
    'openai-codex/codex-home-custom',
    'openai/gpt-home-custom',
    'xai/grok-home-custom',
  ]);

  for (const [provider, model] of [
    ['openai', 'gpt-home-custom'],
    ['xai', 'grok-home-custom'],
    ['openai-codex', 'codex-home-custom'],
  ]) {
    const capabilities = getModelCapabilities(normalized, provider, model);
    assert.ok(capabilities.maxOutputTokens > 0);
    assert.ok(capabilities.contextWindowTokens > capabilities.maxOutputTokens);
    assert.ok(capabilities.providerStallMs > 0);
  }
  assert.equal(normalized.defaults.embeddings.provider, 'openai');
  assert.equal(normalized.defaults.embeddings.model, 'text-embedding-3-small');
  assert.ok(normalized.defaults.embeddings.dimensions > 0);
  assert.equal(
    normalized.providers.openai.models.some((model) =>
      model.id === 'text-embedding-3-small' && model.kind === 'embedding'),
    true,
  );
});

test('COSMO seed can build the managed catalog before a primary agent exists', async (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homePath = join(root, 'config', 'home.yaml');
  const home = yaml.load(readFileSync(homePath, 'utf8'));
  delete home.home;
  writeFileSync(homePath, yaml.dump(home));
  rmSync(join(root, 'instances'), { recursive: true, force: true });

  await seedCosmo23Config(root);
  const persisted = JSON.parse(readFileSync(
    join(root, 'cosmo23', '.cosmo23-config', 'model-catalog.json'),
    'utf8',
  ));

  assert.deepEqual(chatPairs(persisted), [
    'openai-codex/codex-home-custom',
    'openai/gpt-home-custom',
    'xai/grok-home-custom',
  ]);
});

test('managed catalog seed publishes atomically across an interrupted replacement', async (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogDir = join(root, 'cosmo23', '.cosmo23-config');
  const catalogPath = join(catalogDir, 'model-catalog.json');
  const priorBytes = readFileSync(catalogPath);

  await assert.rejects(
    seedCosmo23Config(root, { _testModelCatalogCrashAt: 'before-rename' }),
    (error) => error?.code === 'model_catalog_write_interrupted',
  );

  assert.deepEqual(readFileSync(catalogPath), priorBytes);
  assert.equal(JSON.parse(readFileSync(catalogPath, 'utf8')).defaults.queryModel,
    'stale-discovered-model');
  assert.deepEqual(
    readdirSync(catalogDir).filter((name) => name.includes('.tmp-')),
    [],
  );

  await seedCosmo23Config(root);
  const replaced = JSON.parse(readFileSync(catalogPath, 'utf8'));
  assert.deepEqual(chatPairs(replaced), [
    'openai-codex/codex-home-custom',
    'openai/gpt-home-custom',
    'xai/grok-home-custom',
  ]);
  assert.deepEqual(
    readdirSync(catalogDir).filter((name) => name.includes('.tmp-')),
    [],
  );

  await assert.rejects(
    seedCosmo23Config(root, { _testModelCatalogCrashAt: 'after-rename' }),
    (error) => error?.code === 'model_catalog_write_interrupted',
  );
  assert.deepEqual(chatPairs(JSON.parse(readFileSync(catalogPath, 'utf8'))), [
    'openai-codex/codex-home-custom',
    'openai/gpt-home-custom',
    'xai/grok-home-custom',
  ]);
  assert.deepEqual(
    readdirSync(catalogDir).filter((name) => name.includes('.tmp-')),
    [],
  );
});
