import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProviderOperationRuntime } = require(
  '../../../engine/src/dashboard/brain-operations/provider-operation-runtime.js'
);

const catalog = {
  version: 1,
  providers: {
    anthropic: {
      label: 'Anthropic',
      executionDefaults: {
        transport: 'anthropic-messages', maxOutputTokens: 8192, providerStallMs: 900000,
      },
      models: [{
        id: 'claude-opus-test', kind: 'chat', transport: 'anthropic-messages',
        maxOutputTokens: 8192, providerStallMs: 900000,
      }],
    },
    minimax: {
      label: 'MiniMax',
      executionDefaults: {
        transport: 'anthropic-messages', maxOutputTokens: 8192, providerStallMs: 900000,
      },
      models: [{
        id: 'MiniMax-Test', kind: 'chat', transport: 'anthropic-messages',
        maxOutputTokens: 8192, providerStallMs: 900000,
      }],
    },
  },
};

async function makeHome(query) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-provider-operation-runtime-'));
  await fsp.mkdir(path.join(root, 'config'));
  await fsp.writeFile(path.join(root, 'config', 'home.yaml'), yaml.dump({ query }));
  return root;
}

function registry(available = true) {
  return {
    assertPairAvailable(provider, model) {
      if (!available) throw Object.assign(new Error(`${provider}/${model} unavailable`), {
        code: 'provider_unavailable', retryable: true,
      });
      return {};
    },
  };
}

test('provider operation runtime migrates all model-only defaults before resolving', async (t) => {
  const root = await makeHome({
    defaultModel: 'claude-opus-test',
    pgsSweepModel: 'MiniMax-Test',
    pgsSynthModel: 'claude-opus-test',
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runtime = createProviderOperationRuntime({
    home23Root: root, catalog, providerRegistry: registry(), logger: { error() {} },
  });
  assert.equal(runtime.getReadiness().status, 'starting');
  const resolved = await runtime.resolve({ operationType: 'query', requestParameters: { query: 'canary' } });
  assert.deepEqual(resolved.modelSelection, {
    provider: 'anthropic', model: 'claude-opus-test',
  });
  assert.deepEqual(runtime.getReadiness(), {
    ready: true, status: 'ready', code: null, retryable: false, migrated: true,
  });
  const persisted = yaml.load(fs.readFileSync(path.join(root, 'config', 'home.yaml'), 'utf8'));
  assert.deepEqual({
    defaultProvider: persisted.query.defaultProvider,
    pgsSweepProvider: persisted.query.pgsSweepProvider,
    pgsSynthProvider: persisted.query.pgsSynthProvider,
  }, {
    defaultProvider: 'anthropic', pgsSweepProvider: 'minimax', pgsSynthProvider: 'anthropic',
  });
});

test('provider operation runtime stays unavailable without creating an operation fallback', async (t) => {
  const root = await makeHome({
    defaultProvider: 'anthropic', defaultModel: 'claude-opus-test',
    pgsSweepProvider: 'minimax', pgsSweepModel: 'MiniMax-Test',
    pgsSynthProvider: 'anthropic', pgsSynthModel: 'claude-opus-test',
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runtime = createProviderOperationRuntime({
    home23Root: root, catalog, providerRegistry: registry(false), logger: { error() {} },
  });
  await assert.rejects(
    () => runtime.resolve({ operationType: 'query', requestParameters: { query: 'canary' } }),
    (error) => error.code === 'provider_unavailable' && error.retryable === true,
  );
  assert.deepEqual(runtime.getReadiness(), {
    ready: false, status: 'unavailable', code: 'provider_unavailable',
    retryable: true, migrated: false,
  });
});
