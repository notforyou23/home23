import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import { generateEcosystem } from '../../cli/lib/generate-ecosystem.js';

const require = createRequire(import.meta.url);
const TEST_NODE_MODULES = dirname(dirname(require.resolve('js-yaml/package.json')));

function generate(home = {}, secrets = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-coordination-generation-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'jerry'), { recursive: true });
  symlinkSync(TEST_NODE_MODULES, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
    ...home,
  }));
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump(secrets));
  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({
    agent: { displayName: 'Jerry' },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
  }));
  generateEcosystem(root);
  return root;
}

test('fresh generation emits exactly one disabled loopback-only coordination process', (t) => {
  const root = generate();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  const matches = apps.filter((app) => app.name === 'home23-coordination');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].autorestart, false);
  assert.equal(matches[0].env.HOME23_COORDINATION_ENABLED, 'false');
  assert.equal(matches[0].env.HOME23_COORDINATION_PUBLIC_API_ENABLED, 'false');
  for (const [key, value] of Object.entries(matches[0].env)) {
    if (key.startsWith('HOME23_COORDINATION_') && key.endsWith('_ENABLED')) assert.equal(value, 'false');
  }
  assert.equal(matches[0].env.HOME23_COORDINATION_HOST, '127.0.0.1');
  assert.match(matches[0].env.HOME23_COORDINATION_DB_PATH, /instances\/.house\/coordination/);
  assert.match(matches[0].env.HOME23_COORDINATION_SOCKET_PATH, /instances\/.house\/coordination/);
  assert.equal(readFileSync(join(root, 'config', 'home.yaml'), 'utf8').includes('coordination:'), false,
    'legacy local config remains accepted and is not mutated');
});

test('explicit configuration is rendered but an unsafe bind remains startup-invalid', (t) => {
  const root = generate({
    coordination: {
      process: { enabled: true },
      publicApi: { enabled: false, host: '0.0.0.0', port: 7446 },
      activity: { enabled: true },
      attachments: { enabled: true },
    },
  }, { coordination: { capabilityToken: 'd'.repeat(64) } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = require(join(root, 'ecosystem.config.cjs')).apps
    .find((candidate) => candidate.name === 'home23-coordination');
  assert.equal(app.env.HOME23_COORDINATION_ENABLED, 'true');
  assert.equal(app.env.HOME23_COORDINATION_HOST, '127.0.0.1');
  assert.equal(app.env.HOME23_COORDINATION_ACTIVITY_ENABLED, 'true');
  assert.equal(app.env.HOME23_COORDINATION_ATTACHMENTS_ENABLED, 'true');
  assert.match(app.env.HOME23_COORDINATION_ATTACHMENTS_ROOT, /instances\/.house\/coordination\/attachments$/);
  assert.equal(app.autorestart, false);
  assert.equal(app.env.HOME23_COORDINATION_PORT, '7446');
});

test('Jerry and Forrest resident identities and credentials remain distinct and feature-off', (t) => {
  const root = generate({}, { coordination: { capabilityToken: 'd'.repeat(64), residents: { jerry: { keyVersion: 2, key: 'a'.repeat(64) }, forrest: { keyVersion: 3, key: 'b'.repeat(64) } } } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  const coordinator = apps.find((app) => app.name === 'home23-coordination');
  const jerry = apps.find((app) => app.env?.HOME23_AGENT === 'jerry' && app.env?.HOME23_COORDINATION_RESIDENT_ENABLED !== undefined);
  assert.notEqual(coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_KEY, coordinator.env.HOME23_COORDINATION_RESIDENT_FORREST_KEY);
  assert.notEqual(coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_SERVER_INSTANCE_ID, coordinator.env.HOME23_COORDINATION_RESIDENT_FORREST_SERVER_INSTANCE_ID);
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_ENABLED, 'false');
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_KEY, 'a'.repeat(64));
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID, 'home23-jerry-harness');
});

test('explicit M14 generation gives the coordinator and Jerry harness one exact resident binding', (t) => {
  const root = generate({
    coordination: {
      process: { enabled: true },
      publicApi: { enabled: true },
      flags: { 'coordination.resident.jerry.enabled': true },
    },
  }, {
    coordination: {
      capabilityToken: 'd'.repeat(64),
      residents: {
        jerry: { keyVersion: 7, key: 'a'.repeat(64) },
        forrest: { keyVersion: 8, key: 'b'.repeat(64) },
      },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  const coordinator = apps.find((app) => app.name === 'home23-coordination');
  const jerry = apps.find((app) => app.name === 'home23-jerry-harness');

  assert.equal(coordinator.env.HOME23_COORDINATION_ENABLED, 'true');
  assert.equal(coordinator.env.HOME23_COORDINATION_PUBLIC_API_ENABLED, 'true');
  assert.equal(coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_ENABLED, 'true');
  assert.equal(coordinator.env.HOME23_COORDINATION_RESIDENT_FORREST_ENABLED, 'false');
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_ENABLED, 'true');
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_SOCKET_PATH,
    coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_SOCKET_PATH);
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID,
    coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_SERVER_INSTANCE_ID);
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID,
    coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_CLIENT_INSTANCE_ID);
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_KEY_VERSION,
    coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_KEY_VERSION);
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_KEY,
    coordinator.env.HOME23_COORDINATION_RESIDENT_JERRY_KEY);
});
