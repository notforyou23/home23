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

function makeInstall() {
  const root = mkdtempSync(join(tmpdir(), 'home23-harness-supervision-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'jerry'), { recursive: true });
  symlinkSync(TEST_NODE_MODULES, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
    providers: { openai: { defaultModels: ['gpt-test'] } },
    chat: { defaultProvider: 'openai', defaultModel: 'gpt-test' },
  }), 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump({
    providers: {},
    cosmo23: { encryptionKey: 'not-a-real-secret' },
  }), 'utf8');
  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({
    agent: { displayName: 'jerry' },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003 },
  }), 'utf8');
  generateEcosystem(root);
  return root;
}

function loadApps(root) {
  const config = require(join(root, 'ecosystem.config.cjs'));
  return config.apps;
}

test('harness app has a bounded kill_timeout so PM2 SIGKILLs a wedged shutdown quickly', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = loadApps(root);

  const harness = apps.find((app) => app.name === 'home23-jerry-harness');
  assert.ok(harness, 'harness app must exist');
  // The 2026-08-07/08 forrest orphan incident: a fossil kill_timeout of 210s
  // left a multi-minute stopping window in which racing pm2 actions spawned a
  // duplicate harness and abandoned the old one alive on the bridge port.
  // Harness graceful shutdown self-limits via its own watchdog, so PM2's
  // backstop must be short.
  assert.equal(harness.kill_timeout, 30000);
});

test('harness app has exponential restart backoff so a boot-crash loop cannot run hot', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = loadApps(root);

  const harness = apps.find((app) => app.name === 'home23-jerry-harness');
  assert.ok(harness, 'harness app must exist');
  assert.equal(harness.exp_backoff_restart_delay, 200);
});

test('engine and dashboard keep their generous kill_timeout for brain persistence', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = loadApps(root);

  const engine = apps.find((app) => app.name === 'home23-jerry');
  const dash = apps.find((app) => app.name === 'home23-jerry-dash');
  assert.equal(engine.kill_timeout, 210000);
  assert.equal(dash.kill_timeout, 210000);
});

test('ecosystem generation uses a configured external instance root for runtime paths and manifest metadata', (t) => {
  const root = makeInstall();
  const externalRoot = mkdtempSync(join(tmpdir(), 'home23-external-instance-root-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });

  mkdirSync(join(externalRoot, 'brain'), { recursive: true });
  mkdirSync(join(externalRoot, 'workspace'), { recursive: true });
  mkdirSync(join(externalRoot, 'logs'), { recursive: true });
  mkdirSync(join(externalRoot, 'conversations'), { recursive: true });

  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({
    agent: { displayName: 'jerry' },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
    system: {
      name: 'home23',
      version: '1.0.0',
      workspace: 'workspace',
      instanceRoot: externalRoot,
    },
  }), 'utf8');
  generateEcosystem(root);

  const apps = loadApps(root);
  const engine = apps.find((app) => app.name === 'home23-jerry');
  const dash = apps.find((app) => app.name === 'home23-jerry-dash');
  const harness = apps.find((app) => app.name === 'home23-jerry-harness');
  const manifest = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
  const jerry = manifest.find((agent) => agent.name === 'jerry');

  assert.equal(engine.env.HOME23_ROOT, root);
  assert.equal(engine.env.HOME23_INSTANCE_DIR, externalRoot);
  assert.equal(engine.env.COSMO_RUNTIME_DIR, join(externalRoot, 'brain'));
  assert.equal(engine.env.COSMO_WORKSPACE_PATH, join(externalRoot, 'workspace'));
  assert.equal(engine.out_file, join(externalRoot, 'logs', 'engine-out.log'));
  assert.equal(dash.env.HOME23_INSTANCE_DIR, externalRoot);
  assert.equal(harness.env.HOME23_INSTANCE_DIR, externalRoot);
  assert.equal(jerry.instanceRoot, externalRoot);
  assert.equal(jerry.storageMode, 'external');
  assert.equal(jerry.brainPath, join(externalRoot, 'brain'));
  assert.equal(jerry.workspacePath, join(externalRoot, 'workspace'));
});

test('harness node_args keep a spaced logs path as one --cpu-prof-dir value', (t) => {
  const root = makeInstall();
  const externalRoot = mkdtempSync(join(tmpdir(), 'home23 Casey Jones '));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });

  mkdirSync(join(externalRoot, 'brain'), { recursive: true });
  mkdirSync(join(externalRoot, 'workspace'), { recursive: true });
  mkdirSync(join(externalRoot, 'logs'), { recursive: true });
  mkdirSync(join(externalRoot, 'conversations'), { recursive: true });

  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({
    agent: { displayName: 'jerry' },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
    system: {
      name: 'home23',
      version: '1.0.0',
      workspace: 'workspace',
      instanceRoot: externalRoot,
    },
  }), 'utf8');
  generateEcosystem(root);

  const harness = loadApps(root).find((app) => app.name === 'home23-jerry-harness');
  const logsDir = join(externalRoot, 'logs');
  assert.ok(Array.isArray(harness.node_args), 'PM2 string node_args split on spaces');
  assert.equal(harness.node_args.find((arg) => String(arg).startsWith('--cpu-prof-dir=')), `--cpu-prof-dir=${logsDir}`);
  assert.equal(harness.node_args.find((arg) => String(arg).startsWith('--heap-prof-dir=')), `--heap-prof-dir=${logsDir}`);
});
