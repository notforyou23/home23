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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dash-links-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), yaml.dump(homeConfig), 'utf8');
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), yaml.dump({ providers: {} }), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  fs.mkdirSync(path.join(root, 'cli', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'lib', 'generate-ecosystem.js'), 'export function generateEcosystem() {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'cli', 'lib', 'evobrew-config.js'), 'export function writeEvobrewConfig() {}\n', 'utf8');

  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root).router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/home23/api/settings`, root);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function putLinks(base, links) {
  const res = await fetch(`${base}/dash`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links }),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /dash returns an empty list when nothing is saved', async () => {
  await withSettingsServer({ home: {} }, async (base) => {
    const res = await fetch(`${base}/dash`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.links, []);
    assert.equal(body.version, 1);
  });
});

test('PUT /dash persists ordered links house-wide and GET reads them back', async () => {
  await withSettingsServer({ home: {} }, async (base, root) => {
    const links = [
      { id: 'a', title: 'Grafana', url: 'https://grafana.local:3000/d/house' },
      { id: 'b', title: 'Router', url: 'http://192.168.7.1' },
    ];
    const put = await putLinks(base, links);
    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true);
    assert.deepEqual(put.body.links.map((l) => l.id), ['a', 'b']);
    assert.ok(put.body.updatedAt);

    const saved = yaml.load(fs.readFileSync(path.join(root, 'config', 'home.yaml'), 'utf8'));
    assert.deepEqual(saved.dashboard.dash.links.map((l) => l.title), ['Grafana', 'Router']);

    // Reorder: order on the wire is the order stored.
    const reordered = await putLinks(base, [links[1], links[0]]);
    assert.deepEqual(reordered.body.links.map((l) => l.id), ['b', 'a']);

    const get = await (await fetch(`${base}/dash`)).json();
    assert.deepEqual(get.links.map((l) => l.id), ['b', 'a']);
  });
});

test('PUT /dash assigns ids, trims, and rejects bad entries', async () => {
  await withSettingsServer({ home: {} }, async (base) => {
    const ok = await putLinks(base, [{ title: '  Pi-hole  ', url: 'http://pi.hole/admin' }]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.links[0].title, 'Pi-hole');
    assert.match(ok.body.links[0].id, /^[A-Za-z0-9_-]{6,}$/);

    const badShape = await fetch(`${base}/dash`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: 'nope' }),
    });
    assert.equal(badShape.status, 400);

    for (const bad of [
      { title: 'No title', url: '' },
      { title: '', url: 'https://ok.example' },
      { title: 'ftp', url: 'ftp://files.example' },
      { title: 'creds', url: 'https://user:pass@example.com' },
      { title: 'js', url: 'javascript:alert(1)' },
    ]) {
      const res = await putLinks(base, [bad]);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(res.body.ok, false);
    }
  });
});

test('PUT /dash leaves other dashboard settings untouched', async () => {
  await withSettingsServer({ home: {}, dashboard: { vibe: { autoGenerate: true } } }, async (base, root) => {
    await putLinks(base, [{ id: 'x', title: 'X', url: 'https://x.example' }]);
    const saved = yaml.load(fs.readFileSync(path.join(root, 'config', 'home.yaml'), 'utf8'));
    assert.equal(saved.dashboard.vibe.autoGenerate, true);
    assert.equal(saved.dashboard.dash.links.length, 1);
  });
});
