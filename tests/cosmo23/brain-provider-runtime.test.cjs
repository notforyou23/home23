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

test('provider registry rebuilds when credentials rotate on disk — no restart required', async (t) => {
  const root = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const seen = [];
  const silent = { info() {}, warn() {}, error() {} };
  const runtime = createHome23BrainProviderRuntime({
    home23Root: root,
    catalog,
    logger: silent,
    credentialCheckMs: 0, // test seam: re-check on every call
    pairFactories: {
      minimax(options) {
        seen.push(options.providerConfig.apiKey);
        return { providerId: 'minimax', async generate() { return {}; } };
      },
    },
  });
  assert.equal(runtime.providerRegistry.has('minimax', 'MiniMax-Test'), true);
  assert.deepEqual(seen, ['secret-test-key']);

  // Rotate the key on disk — this is all the OAuth poller does now; nothing
  // restarts (rotationRestartTargets is []). The registry must notice.
  const secretsPath = path.join(root, 'config', 'secrets.yaml');
  await fsp.writeFile(secretsPath, yaml.dump({
    providers: { minimax: { apiKey: 'rotated-key' } },
  }), { mode: 0o600 });
  const bumped = new Date(Date.now() + 2000);
  await fsp.utimes(secretsPath, bumped, bumped);

  assert.equal(runtime.providerRegistry.has('minimax', 'MiniMax-Test'), true);
  assert.deepEqual(seen, ['secret-test-key', 'rotated-key'], 'registry rebuilt with the rotated key');
  assert.equal(runtime.providerConfig.minimax.apiKey, 'rotated-key', 'runtime accessors track the rebuild');

  // A torn or invalid rewrite keeps the previous registry serving (and the
  // fingerprint is not adopted, so the rebuild retries on later calls).
  await fsp.writeFile(secretsPath, '{invalid yaml: [', { mode: 0o600 });
  const bumpedAgain = new Date(Date.now() + 4000);
  await fsp.utimes(secretsPath, bumpedAgain, bumpedAgain);
  assert.equal(runtime.providerRegistry.has('minimax', 'MiniMax-Test'), true,
    'previous registry keeps serving through a torn write');
  assert.deepEqual(seen.slice(-1), ['rotated-key'], 'no client was built from the torn file');
});

test('provider runtime enables Anthropic OAuth only when no explicit credential exists', () => {
  const withoutKey = require('../../cosmo23/lib/brain-provider-runtime')
    .mergeProviderConfiguration({ providers: { anthropic: {} } }, {});
  assert.equal(withoutKey.anthropic.useOAuthService, true);
  const withKey = require('../../cosmo23/lib/brain-provider-runtime')
    .mergeProviderConfiguration({}, { providers: { anthropic: { apiKey: 'key' } } });
  assert.equal(Object.hasOwn(withKey.anthropic, 'useOAuthService'), false);
});

test('provider runtime sends managed Anthropic OAuth credentials as an auth token', () => {
  const merged = require('../../cosmo23/lib/brain-provider-runtime')
    .mergeProviderConfiguration({}, {
      providers: {
        anthropic: {
          apiKey: 'sk-ant-oat-managed-test-token',
          oauthManaged: true,
        },
      },
    });
  assert.equal(merged.anthropic.authToken, 'sk-ant-oat-managed-test-token');
  assert.equal(Object.hasOwn(merged.anthropic, 'apiKey'), false);
  assert.equal(Object.hasOwn(merged.anthropic, 'api_key'), false);
  assert.equal(Object.hasOwn(merged.anthropic, 'useOAuthService'), false);
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
