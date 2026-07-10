import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const yaml = require('js-yaml');
const { createSettingsRouter } = require('../../../engine/src/dashboard/home23-settings-api.js');

async function withSettingsServer(homeConfig, fn, secrets = { providers: { 'ollama-cloud': { apiKey: 'oc-test' } } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-vibe-settings-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), yaml.dump(homeConfig), 'utf8');
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), yaml.dump(secrets), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  fs.mkdirSync(path.join(root, 'cli', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'generate-ecosystem.js'),
    'export function generateEcosystem() {}\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'evobrew-config.js'),
    'export function writeEvobrewConfig() {}\n',
    'utf8'
  );

  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root).router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await fn(`http://127.0.0.1:${port}`, root);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withCapabilityFailureSettingsServer(fn, options = {}) {
  const { seedFails = true, pm2JlistFails = false } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-capability-settings-'));
  const childProcess = require('node:child_process');
  const originalExecFileSync = childProcess.execFileSync;
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cli', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), 'home: {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), 'providers: {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  fs.writeFileSync(
    path.join(root, 'scripts', 'home23-pm2-watchdog.cjs'),
    'module.exports.parsePm2JlistOutput = (text) => JSON.parse(text);\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'generate-ecosystem.js'),
    'export function generateEcosystem() {}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'evobrew-config.js'),
    'export function writeEvobrewConfig() {}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'cosmo23-config.js'),
    seedFails ? `export async function seedCosmo23Config() {
      const error = new Error('capability_secret_invalid');
      error.code = 'capability_secret_invalid';
      throw error;
    }\n` : 'export async function seedCosmo23Config() {}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'cli', 'lib', 'shared-service-start.js'),
    `import fs from 'node:fs';
     export const SHARED_SERVICES = [{ name: 'home23-cosmo23' }];
     export async function coordinateSharedServiceStartup({ home23Root }) {
       fs.writeFileSync(home23Root + '/restart-called', 'yes');
     }\n`,
    'utf8',
  );

  childProcess.execFileSync = (command, args, options) => {
    if (command === 'pm2' && args?.[0] === 'jlist') {
      if (pm2JlistFails) throw new Error('pm2 jlist unavailable');
      return '[]';
    }
    return originalExecFileSync(command, args, options);
  };
  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root).router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, root);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('COSMO settings restart propagates capability preparation failure without restarting', async () => {
  await withCapabilityFailureSettingsServer(async (baseUrl, root) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/cosmo23/restart`, { method: 'POST' });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /capability_secret_invalid/);
    assert.equal(fs.existsSync(path.join(root, 'restart-called')), false);
  });
});

test('provider settings propagate COSMO capability seeding failure and do not report success', async () => {
  await withCapabilityFailureSettingsServer(async (baseUrl, root) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/providers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { openai: { apiKey: 'test-key' } } }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /capability_secret_invalid/);
    assert.equal(fs.existsSync(path.join(root, 'restart-called')), false);
  });
});

test('provider settings preserve warning response for an ordinary PM2 inspection failure', async () => {
  await withCapabilityFailureSettingsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/providers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { openai: { apiKey: 'test-key' } } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.restarted, false);
    assert.match(body.warn, /pm2 jlist unavailable/);
  }, { seedFails: false, pm2JlistFails: true });
});

test('vibe settings expose and preserve xAI Grok image models', async () => {
  await withSettingsServer({
    dashboard: { vibe: { autoGenerate: true } },
    media: {
      imageGeneration: {
        provider: 'xai',
        model: 'grok-imagine-image-pro',
      },
    },
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/home23/api/settings/vibe`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(body.imageProviders.xai.models, [
      'grok-imagine-image',
      'grok-imagine-image-pro',
    ]);
    assert.deepEqual(body.imageGeneration, {
      provider: 'xai',
      model: 'grok-imagine-image-pro',
    });
  });
});

test('settings agent creation records purpose and starter ingestion folders', async () => {
  await withSettingsServer({ home: {} }, async (baseUrl, root) => {
    const templatesDir = path.join(root, 'cli', 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'MISSION.md'), '# Mission\n\n{{purpose}}\n', 'utf8');

    const projectDir = path.join(root, 'projects', 'sample-project');
    const claudeDir = path.join(root, 'imports', 'Claude Exports', 'client-notes');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });

    const purpose = 'Help JTR run client projects, remember decisions, and surface next actions.';
    const personalFacts = 'Prefers receipts before summaries.\nWorks through Home23 and project imports.';
    const createRes = await fetch(`${baseUrl}/home23/api/settings/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ada',
        displayName: 'Ada',
        ownerName: 'JTR',
        purpose,
        personalFacts,
        ingestPaths: `${projectDir}\n${claudeDir}`,
        provider: 'ollama-cloud',
        model: 'kimi-k2.6',
      }),
    });
    assert.equal(createRes.status, 200);
    const createBody = await createRes.json();
    assert.equal(createBody.ok, true);
    assert.equal(createBody.agent.purpose, purpose);
    assert.deepEqual(createBody.agent.personalFacts, ['Prefers receipts before summaries.', 'Works through Home23 and project imports.']);
    assert.equal(createBody.agent.ingestPaths.length, 2);

    const instanceDir = path.join(root, 'instances', 'ada');
    const config = yaml.load(fs.readFileSync(path.join(instanceDir, 'config.yaml'), 'utf8'));
    assert.equal(config.agent.purpose, purpose);
    assert.equal(config.engine.thought, 'MiniMax-M3');
    assert.equal(config.engine.query, 'MiniMax-M3');
    assert.equal(config.chat.defaultModel, 'kimi-k2.6');
    assert.equal(config.chat.memorySearch.enabled, true);
    assert.deepEqual(config.agent.owner.facts, ['Prefers receipts before summaries.', 'Works through Home23 and project imports.']);
    assert.ok(config.feeder.additionalWatchPaths.some((entry) => entry.path === projectDir && entry.label === 'sample-project'));
    assert.ok(config.feeder.additionalWatchPaths.some((entry) => entry.path === claudeDir && entry.label === 'client-notes'));

    const mission = fs.readFileSync(path.join(instanceDir, 'workspace', 'MISSION.md'), 'utf8');
    const personal = fs.readFileSync(path.join(instanceDir, 'workspace', 'PERSONAL.md'), 'utf8');
    const projects = fs.readFileSync(path.join(instanceDir, 'workspace', 'PROJECTS.md'), 'utf8');
    const recent = fs.readFileSync(path.join(instanceDir, 'workspace', 'RECENT.md'), 'utf8');
    assert.match(mission, new RegExp(purpose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(personal, /Prefers receipts before summaries\./);
    assert.match(personal, /Works through Home23 and project imports\./);
    assert.match(projects, /sample-project:/);
    assert.match(projects, /client-notes:/);
    assert.match(recent, /Starter ingestion paths: 2/);

    const listRes = await fetch(`${baseUrl}/home23/api/settings/agents`);
    const listBody = await listRes.json();
    assert.equal(listBody.agents[0].purpose, purpose);

    const updatedPurpose = 'Help JTR keep this project organized and ready for handoff.';
    const updateRes = await fetch(`${baseUrl}/home23/api/settings/agents/ada`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: updatedPurpose }),
    });
    assert.equal(updateRes.status, 200);
    const updatedMission = fs.readFileSync(path.join(instanceDir, 'workspace', 'MISSION.md'), 'utf8');
    assert.match(updatedMission, new RegExp(updatedPurpose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('settings agent creation rejects an unconfigured selected chat provider', async () => {
  await withSettingsServer({ home: {} }, async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/home23/api/settings/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-provider',
        displayName: 'Bad Provider',
        ownerName: 'JTR',
        purpose: 'Test provider guard.',
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
    assert.equal(createRes.status, 400);
    const body = await createRes.json();
    assert.match(body.error, /openai.*not configured/i);
  });
});

test('setup readiness reports Memory Lite and configured provider status', async () => {
  await withSettingsServer({ home: {} }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/home23/api/settings/setup/readiness?provider=ollama-cloud`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.providers.configured, ['ollama-cloud']);
    assert.equal(body.providers.selectedReady, true);
    assert.equal(body.memory.mode, 'memory_lite');
    assert.equal(body.memory.label, 'Memory Lite');
  });
});

test('embedding backfill request is queued safely when no live engine is attached', async () => {
  await withSettingsServer({
    home: { primaryAgent: 'ada' },
    embeddings: {
      providers: [{ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 }],
    },
  }, async (baseUrl, root) => {
    const instanceDir = path.join(root, 'instances', 'ada');
    fs.mkdirSync(path.join(instanceDir, 'brain'), { recursive: true });
    fs.writeFileSync(
      path.join(instanceDir, 'config.yaml'),
      yaml.dump({ agent: { name: 'ada' }, ports: { engine: 5001, dashboard: 5002 } }),
      'utf8'
    );

    const res = await fetch(`${baseUrl}/home23/api/settings/memory/backfill-embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'ada' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'pending_next_engine_load');
    assert.ok(fs.existsSync(path.join(instanceDir, 'brain', 'embedding-backfill-request.json')));
  }, { providers: { openai: { apiKey: 'sk-test' } } });
});
