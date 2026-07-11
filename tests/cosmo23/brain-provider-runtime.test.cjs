'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  createHome23BrainProviderRuntime,
  loadHome23BrainProviderConfig,
} = require('../../cosmo23/lib/brain-provider-runtime');

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-provider-runtime-'));
  await fsp.mkdir(path.join(root, 'config'));
  await fsp.writeFile(path.join(root, 'config', 'home.yaml'), yaml.dump({
    providers: {
      minimax: { baseUrl: 'https://api.minimax.example/anthropic' },
      anthropic: { defaultModels: ['claude-test'] },
    },
    query: { defaultProvider: 'minimax', defaultModel: 'MiniMax-Test' },
  }));
  await fsp.writeFile(path.join(root, 'config', 'secrets.yaml'), yaml.dump({
    providers: { minimax: { apiKey: 'secret-test-key' } },
  }), { mode: 0o600 });
  return root;
}

const catalog = {
  version: 1,
  providers: {
    minimax: {
      label: 'MiniMax',
      executionDefaults: {
        transport: 'anthropic-messages', maxOutputTokens: 4096, providerStallMs: 900000,
      },
      models: [{
        id: 'MiniMax-Test', kind: 'chat', transport: 'anthropic-messages',
        maxOutputTokens: 4096, providerStallMs: 900000,
      }],
    },
  },
};

test('provider runtime merges canonical public settings and secrets into exact-pair clients', async (t) => {
  const root = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const seen = [];
  const runtime = createHome23BrainProviderRuntime({
    home23Root: root,
    catalog,
    pairFactories: {
      minimax(options) {
        seen.push(options);
        return { providerId: 'minimax', async generate() { return {}; } };
      },
    },
  });
  assert.equal(runtime.providerRegistry.has('minimax', 'MiniMax-Test'), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].providerConfig.apiKey, 'secret-test-key');
  assert.equal(seen[0].providerConfig.baseUrl, 'https://api.minimax.example/anthropic');
  assert.equal(runtime.home.query.defaultModel, 'MiniMax-Test');
});

test('provider runtime enables Anthropic OAuth only when no explicit credential exists', () => {
  const withoutKey = require('../../cosmo23/lib/brain-provider-runtime')
    .mergeProviderConfiguration({ providers: { anthropic: {} } }, {});
  assert.equal(withoutKey.anthropic.useOAuthService, true);
  const withKey = require('../../cosmo23/lib/brain-provider-runtime')
    .mergeProviderConfiguration({}, { providers: { anthropic: { apiKey: 'key' } } });
  assert.equal(Object.hasOwn(withKey.anthropic, 'useOAuthService'), false);
});

test('provider runtime rejects symlinked canonical config and permits an absent secrets file', async (t) => {
  const root = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.rm(path.join(root, 'config', 'secrets.yaml'));
  assert.deepEqual(
    loadHome23BrainProviderConfig({ home23Root: root }).providerConfig.minimax,
    { baseUrl: 'https://api.minimax.example/anthropic' },
  );
  const outside = path.join(root, 'outside.yaml');
  await fsp.writeFile(outside, 'providers: {}\n');
  await fsp.rm(path.join(root, 'config', 'home.yaml'));
  await fsp.symlink(outside, path.join(root, 'config', 'home.yaml'));
  assert.throws(() => loadHome23BrainProviderConfig({ home23Root: root }), {
    code: 'provider_configuration_invalid',
  });

  await fsp.rm(path.join(root, 'config'), { recursive: true });
  const outsideConfig = path.join(root, 'outside-config');
  await fsp.mkdir(outsideConfig);
  await fsp.writeFile(path.join(outsideConfig, 'home.yaml'), 'providers: {}\n');
  await fsp.symlink(outsideConfig, path.join(root, 'config'));
  assert.throws(() => loadHome23BrainProviderConfig({ home23Root: root }), {
    code: 'provider_configuration_invalid',
  });
});
