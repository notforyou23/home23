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

async function withSettingsServer(homeConfig, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-vibe-settings-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), yaml.dump(homeConfig), 'utf8');
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
    const createRes = await fetch(`${baseUrl}/home23/api/settings/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ada',
        displayName: 'Ada',
        ownerName: 'JTR',
        purpose,
        ingestPaths: `${projectDir}\n${claudeDir}`,
        provider: 'ollama-cloud',
        model: 'kimi-k2.6',
      }),
    });
    assert.equal(createRes.status, 200);
    const createBody = await createRes.json();
    assert.equal(createBody.ok, true);
    assert.equal(createBody.agent.purpose, purpose);
    assert.equal(createBody.agent.ingestPaths.length, 2);

    const instanceDir = path.join(root, 'instances', 'ada');
    const config = yaml.load(fs.readFileSync(path.join(instanceDir, 'config.yaml'), 'utf8'));
    assert.equal(config.agent.purpose, purpose);
    assert.ok(config.feeder.additionalWatchPaths.some((entry) => entry.path === projectDir && entry.label === 'sample-project'));
    assert.ok(config.feeder.additionalWatchPaths.some((entry) => entry.path === claudeDir && entry.label === 'client-notes'));

    const mission = fs.readFileSync(path.join(instanceDir, 'workspace', 'MISSION.md'), 'utf8');
    const projects = fs.readFileSync(path.join(instanceDir, 'workspace', 'PROJECTS.md'), 'utf8');
    const recent = fs.readFileSync(path.join(instanceDir, 'workspace', 'RECENT.md'), 'utf8');
    assert.match(mission, new RegExp(purpose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
