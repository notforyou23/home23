import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { acquireSupervisorLock } from '../../../scripts/release/supervisor.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const { createSettingsRouter } = require('../../../engine/src/dashboard/home23-settings-api.js');

test('dashboard agent start and restart refuse while the adoption supervisor lock is held', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-start-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances/ada'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances/.house/maintenance'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/home.yaml'), 'home:\n  primaryAgent: ada\n');
  fs.writeFileSync(path.join(root, 'instances/ada/config.yaml'), 'agent:\n  name: ada\n');
  fs.writeFileSync(path.join(root, 'ecosystem.config.cjs'), "module.exports = { apps: [{ name: 'home23-ada' }, { name: 'home23-ada-dash' }, { name: 'home23-ada-harness' }] };\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(root, 'cli/lib/generate-ecosystem.js'), 'export function generateEcosystem() {}\n');
  fs.writeFileSync(path.join(root, 'cli/lib/evobrew-config.js'), 'export function writeEvobrewConfig() {}\n');
  fs.writeFileSync(path.join(root, 'cli/lib/shared-service-start.js'), 'export async function coordinateSharedServiceStartup() { return { services: [] }; }\n');

  const held = acquireSupervisorLock(
    path.join(root, 'instances/.house/maintenance'),
    DatabaseSync,
    { purpose: 'adoption', writers: ['home23-ada'] },
  );
  t.after(() => held());

  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root).router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/home23/api/settings`;

  for (const route of ['/agents/ada/start', '/agents/ada/restart-engine', '/agents/ada/restart-harness']) {
    const response = await fetch(`${base}${route}`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 409, route);
    assert.equal(body.code, 'supervisor_lock_unavailable', route);
    assert.match(body.error || '', /lock|supervisor|held/i, route);
  }
});
