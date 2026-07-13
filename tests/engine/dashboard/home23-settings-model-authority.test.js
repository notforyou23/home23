import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  applyModelAuthorityRuntimeRefresh,
  createSettingsRouter,
  planModelAuthorityRuntimeTargets,
} = require('../../../engine/src/dashboard/home23-settings-api.js');

test('model authority runtime refresh plans only the exact affected services', () => {
  assert.deepEqual(planModelAuthorityRuntimeTargets({
    agent: 'forrest',
    agentNames: ['jerry', 'forrest'],
    globalCatalogChanged: false,
    affectsManagedCosmo: false,
  }), ['home23-forrest-dash']);
  assert.deepEqual(planModelAuthorityRuntimeTargets({
    agent: 'jerry',
    agentNames: ['jerry', 'forrest'],
    globalCatalogChanged: false,
    affectsManagedCosmo: true,
  }), ['home23-cosmo23', 'home23-jerry-dash']);
  assert.deepEqual(planModelAuthorityRuntimeTargets({
    agent: 'jerry',
    agentNames: ['jerry', 'forrest', 'jerry'],
    globalCatalogChanged: true,
    affectsManagedCosmo: true,
  }), ['home23-cosmo23', 'home23-jerry-dash', 'home23-forrest-dash']);
});

test('production model authority refresh awaits current reload and exact service restarts', async () => {
  const calls = [];
  const result = await applyModelAuthorityRuntimeRefresh({
    change: {
      agent: 'jerry', globalCatalogChanged: true, affectsManagedCosmo: true,
    },
    currentAgent: 'jerry',
    agentNames: ['jerry', 'forrest'],
    reloadCurrentDashboard: async () => calls.push('reload:jerry'),
    restartProcesses: async (targets) => {
      calls.push(`restart:${targets.join(',')}`);
      return targets;
    },
  });
  assert.deepEqual(calls, [
    'restart:home23-cosmo23,home23-forrest-dash',
    'reload:jerry',
  ]);
  assert.deepEqual(result, {
    refreshed: ['home23-jerry-dash'],
    restarted: ['home23-cosmo23', 'home23-forrest-dash'],
  });

  await assert.rejects(() => applyModelAuthorityRuntimeRefresh({
    change: { agent: 'jerry', affectsManagedCosmo: true },
    currentAgent: 'jerry',
    agentNames: ['jerry'],
    reloadCurrentDashboard: async () => { throw new Error('reload failed'); },
    restartProcesses: async (targets) => targets,
  }), /reload failed/);
});

function baseHomeConfig() {
  return {
    home: { primaryAgent: 'jerry' },
    chat: { defaultProvider: 'openai', defaultModel: 'gpt-5.5' },
    providers: {
      openai: { defaultModels: ['gpt-5.5', 'gpt-5.4'] },
      'openai-codex': { defaultModels: ['gpt-5.5', 'gpt-5.4'] },
    },
  };
}

function baseAgentConfig() {
  return {
    chat: { defaultProvider: 'openai', defaultModel: 'gpt-5.5' },
    query: {
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5',
      pgsSweepProvider: 'openai',
      pgsSweepModel: 'gpt-5.4',
      pgsSynthProvider: 'openai-codex',
      pgsSynthModel: 'gpt-5.5',
    },
  };
}

async function withSettingsServer(fn, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-settings-authority-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances', 'jerry'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances', 'forrest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), yaml.dump(baseHomeConfig()), 'utf8');
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), 'providers: {}\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'instances', 'jerry', 'config.yaml'),
    yaml.dump(baseAgentConfig()),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'instances', 'forrest', 'config.yaml'),
    yaml.dump(baseAgentConfig()),
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  fs.mkdirSync(path.join(root, 'cli', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'evobrew-config.js'),
    'export function writeEvobrewConfig() {}\n',
    'utf8',
  );

  const calls = [];
  const routerOptions = {
    seedModelAuthority: async ({ agent }) => {
      calls.push({
        type: 'seed',
        agent,
        stored: yaml.load(fs.readFileSync(
          path.join(root, 'instances', agent, 'config.yaml'),
          'utf8',
        )),
      });
      if (options.seedError && calls.filter((entry) => entry.type === 'seed').length === 1) {
        throw options.seedError;
      }
    },
    onModelAuthorityChanged: async (change) => {
      calls.push({ type: 'refresh', change });
      if (options.refreshError) throw options.refreshError;
      return { scheduled: ['home23-cosmo23', `home23-${change.agent}-dash`] };
    },
    recycleManagedProcess: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root, routerOptions).router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, root, calls });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readAgent(root) {
  return yaml.load(fs.readFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'utf8'));
}

test('Query settings persist exact provider and model identity for all three roles', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/query`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        defaultProvider: 'openai-codex',
        defaultModel: 'gpt-5.5',
        pgsSweepProvider: 'openai',
        pgsSweepModel: 'gpt-5.5',
        pgsSynthProvider: 'openai-codex',
        pgsSynthModel: 'gpt-5.4',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.runtimeRefresh, {
      scheduled: ['home23-cosmo23', 'home23-jerry-dash'],
    });
    assert.deepEqual(readAgent(root).query, {
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.5',
      pgsSweepProvider: 'openai',
      pgsSweepModel: 'gpt-5.5',
      pgsSynthProvider: 'openai-codex',
      pgsSynthModel: 'gpt-5.4',
    });
    assert.deepEqual(calls.map((entry) => entry.type), ['seed', 'refresh']);
    assert.equal(calls[0].stored.query.defaultProvider, 'openai-codex');
    assert.equal(calls[1].change.primaryAgent, 'jerry');
    assert.equal(calls[1].change.globalCatalogChanged, false);
    assert.equal(calls[1].change.affectsManagedCosmo, true);
  });
});

test('Query settings reject a model that is not configured for the selected provider', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const before = fs.readFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'utf8');
    const response = await fetch(`${baseUrl}/home23/api/settings/query`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        defaultProvider: 'openai',
        defaultModel: 'codex-only-model',
        pgsSweepProvider: 'openai',
        pgsSweepModel: 'gpt-5.5',
        pgsSynthProvider: 'openai-codex',
        pgsSynthModel: 'gpt-5.4',
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'model_pair_invalid');
    assert.equal(fs.readFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'utf8'), before);
    assert.deepEqual(calls, []);
  });
});

test('Query settings roll back the agent config when managed reseeding fails', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const before = fs.readFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'utf8');
    const response = await fetch(`${baseUrl}/home23/api/settings/query`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        defaultProvider: 'openai-codex',
        defaultModel: 'gpt-5.5',
        pgsSweepProvider: 'openai',
        pgsSweepModel: 'gpt-5.5',
        pgsSynthProvider: 'openai-codex',
        pgsSynthModel: 'gpt-5.4',
      }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'utf8'), before);
    assert.deepEqual(calls.map((entry) => entry.type), ['seed', 'seed']);
    assert.equal(calls[1].stored.query.defaultProvider, 'openai');
  }, { seedError: new Error('managed seed failed') });
});

test('Query settings roll back when runtime refresh scheduling fails', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const before = readAgent(root);
    const response = await fetch(`${baseUrl}/home23/api/settings/query`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        defaultProvider: 'openai-codex',
        defaultModel: 'gpt-5.5',
        pgsSweepProvider: 'openai',
        pgsSweepModel: 'gpt-5.5',
        pgsSynthProvider: 'openai-codex',
        pgsSynthModel: 'gpt-5.4',
      }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(readAgent(root), before);
    assert.deepEqual(calls.map((entry) => entry.type), ['seed', 'refresh', 'seed', 'refresh']);
    assert.equal(calls.at(-1).change.rollback, true);
  }, { refreshError: new Error('refresh scheduling failed') });
});

test('model catalog edits reject removal of the selected exact Chat pair before saving', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const homePath = path.join(root, 'config', 'home.yaml');
    const agentPath = path.join(root, 'instances', 'jerry', 'config.yaml');
    const beforeHome = fs.readFileSync(homePath, 'utf8');
    const beforeAgent = fs.readFileSync(agentPath, 'utf8');
    const response = await fetch(`${baseUrl}/home23/api/settings/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        chat: { defaultProvider: 'openai', defaultModel: 'gpt-5.5' },
        providerModels: {
          openai: ['gpt-5.4'],
          'openai-codex': ['gpt-5.5', 'gpt-5.4'],
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'model_catalog_invalid');
    assert.equal(fs.readFileSync(homePath, 'utf8'), beforeHome);
    assert.equal(fs.readFileSync(agentPath, 'utf8'), beforeAgent);
    assert.deepEqual(calls, []);
  });
});

test('model catalog and Chat changes reseed and schedule runtime refresh as one authority update', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        chat: { defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4' },
        providerModels: {
          openai: ['gpt-5.5', 'gpt-5.4'],
          'openai-codex': ['gpt-5.5', 'gpt-5.4'],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.runtimeRefresh, {
      scheduled: ['home23-cosmo23', 'home23-jerry-dash'],
    });
    const stored = readAgent(root);
    assert.deepEqual(
      { provider: stored.chat.defaultProvider, model: stored.chat.defaultModel },
      { provider: 'openai-codex', model: 'gpt-5.4' },
    );
    assert.deepEqual(calls.map((entry) => entry.type), ['seed', 'refresh']);
    assert.equal(calls[1].change.primaryAgent, 'jerry');
    assert.equal(calls[1].change.globalCatalogChanged, true);
    assert.equal(calls[1].change.affectsManagedCosmo, true);
  });
});

test('non-primary Query defaults scope refresh to that dashboard, not managed COSMO', async () => {
  await withSettingsServer(async ({ baseUrl, calls }) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/query`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'forrest',
        defaultProvider: 'openai-codex',
        defaultModel: 'gpt-5.5',
        pgsSweepProvider: 'openai',
        pgsSweepModel: 'gpt-5.5',
        pgsSynthProvider: 'openai-codex',
        pgsSynthModel: 'gpt-5.4',
      }),
    });
    assert.equal(response.status, 200);
    const change = calls.find((entry) => entry.type === 'refresh').change;
    assert.equal(change.agent, 'forrest');
    assert.equal(change.primaryAgent, 'jerry');
    assert.equal(change.globalCatalogChanged, false);
    assert.equal(change.affectsManagedCosmo, false);
  });
});

test('global catalog edits cannot remove another configured agent\'s selected Chat pair', async () => {
  await withSettingsServer(async ({ baseUrl, root, calls }) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'jerry',
        chat: { defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4' },
        providerModels: {
          openai: ['gpt-5.4'],
          'openai-codex': ['gpt-5.5', 'gpt-5.4'],
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'model_catalog_invalid');
    assert.equal(readAgent(root).chat.defaultProvider, 'openai');
    assert.deepEqual(calls, []);
  });
});

test('Settings Query UI encodes exact pairs and submits provider fields', () => {
  const source = fs.readFileSync(
    path.resolve('engine/src/dashboard/home23-settings.js'),
    'utf8',
  );
  assert.match(source, /opt\.value = encodeSettingsModelPair\(m\)/);
  assert.match(source, /defaultProvider:\s*directPair\.provider/);
  assert.match(source, /defaultModel:\s*directPair\.model/);
  assert.match(source, /pgsSweepProvider:\s*sweepPair\.provider/);
  assert.match(source, /pgsSweepModel:\s*sweepPair\.model/);
  assert.match(source, /pgsSynthProvider:\s*synthPair\.provider/);
  assert.match(source, /pgsSynthModel:\s*synthPair\.model/);
  assert.doesNotMatch(source, /opt\.value = m\.id;[\s\S]{0,400}query-default-model/);
});
