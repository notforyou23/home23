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
const OWNED_PROFILE = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';
const OWNED_RECIPE = '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9';

function generate(home = {}, { omitEvobrew = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-owned-embedding-eco-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'jerry'), { recursive: true });
  symlinkSync(TEST_NODE_MODULES, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
    ...home,
  }));
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump({}));
  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({
    agent: { displayName: 'Jerry' },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
  }));
  if (omitEvobrew) writeFileSync(join(root, '.home23-product-no-evobrew'), '');
  generateEcosystem(root);
  return root;
}

test('consumer package ecosystem omits the standalone Evobrew process', t => {
  const root = generate({}, { omitEvobrew: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  assert.ok(!apps.some(app => app.name === 'home23-evobrew'));
  assert.ok(apps.some(app => app.name === 'home23-jerry'));
  assert.equal(apps.find(app => app.name === 'home23-jerry').env.HOME23_BRAIN_BACKUP_DIR, '');
});

test('persistent ecosystem services retry without an unstable-exit ceiling', t => {
  const root = generate({ embedder: { owned: true, port: 21495 } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  const persistent = apps.filter(app => app.autorestart === true);
  assert.ok(persistent.some(app => app.name === 'home23-embedder'));
  assert.ok(persistent.some(app => app.name === 'home23-jerry-harness'));
  assert.ok(persistent.every(app => app.min_uptime === 0 && app.max_restarts === undefined));
  assert.ok(persistent.every(app => app.restart_delay > 0 || app.exp_backoff_restart_delay > 0));
  assert.equal(apps.find(app => app.name === 'home23-coordination').autorestart, false);
  assert.equal(apps.find(app => app.name === 'home23-watchdog').autorestart, false);
});

test('configured brain backup directory reaches only engine processes', t => {
  const root = generate({ backups: { brain: { directory: '/Volumes/Backup Home/brain' } } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  assert.equal(apps.find(app => app.name === 'home23-jerry').env.HOME23_BRAIN_BACKUP_DIR, '/Volumes/Backup Home/brain');
  assert.equal(apps.find(app => app.name === 'home23-jerry-harness').env.HOME23_BRAIN_BACKUP_DIR, undefined);
});

function engineEnv(root) {
  return require(join(root, 'ecosystem.config.cjs')).apps
    .find((app) => app.name === 'home23-jerry').env;
}

test('configured owned home keeps embeddings off the Ollama default port', (t) => {
  const root = generate({
    providers: {
      'ollama-local': { baseUrl: 'http://127.0.0.1:1' },
    },
    embeddings: {
      providers: [{
        provider: 'home23-owned',
        model: OWNED_PROFILE,
        endpoint: 'http://127.0.0.1:21495',
        recipeId: OWNED_RECIPE,
        dimensions: 768,
      }],
    },
    substrate: {
      embedding: {
        endpoint: 'http://127.0.0.1:21495/api/embeddings',
        model: OWNED_PROFILE,
        recipeId: OWNED_RECIPE,
      },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = engineEnv(root);
  const source = readFileSync(join(root, 'ecosystem.config.cjs'), 'utf8');
  assert.match(source, /http:\/\/127\.0\.0\.1:11434/);
  assert.equal(env.EMBEDDING_PROVIDER, 'home23-owned');
  assert.equal(env.EMBEDDING_BASE_URL, 'http://127.0.0.1:21495');
  assert.equal(env.SEED_EMBED_ENDPOINT, 'http://127.0.0.1:21495/api/embeddings');
  assert.equal(String(env.EMBEDDING_BASE_URL).includes('11434'), false);
  assert.equal(String(env.SEED_EMBED_ENDPOINT).includes('11434'), false);
  assert.equal(env.LOCAL_LLM_BASE_URL, 'http://127.0.0.1:1/v1');
});

test('owned encoder without an endpoint does not inherit the Ollama URL', (t) => {
  const root = generate({
    providers: {
      'ollama-local': { baseUrl: 'http://127.0.0.1:11434' },
    },
    embeddings: {
      providers: [{
        provider: 'home23-owned',
        model: OWNED_PROFILE,
        dimensions: 768,
      }],
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = engineEnv(root);
  assert.equal(env.EMBEDDING_PROVIDER, 'home23-owned');
  assert.equal(String(env.EMBEDDING_BASE_URL || '').includes('11434'), false);
  assert.equal(String(env.SEED_EMBED_ENDPOINT || '').includes('11434'), false);
});

test('homes without an embeddings provider still default to local Ollama', (t) => {
  const root = generate({
    providers: {
      'ollama-local': { baseUrl: 'http://127.0.0.1:11434' },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = engineEnv(root);
  assert.equal(env.EMBEDDING_PROVIDER, 'ollama-local');
  assert.equal(env.EMBEDDING_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(env.EMBEDDING_MODEL, 'nomic-embed-text');
});
