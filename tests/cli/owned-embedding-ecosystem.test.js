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

function generate(home = {}) {
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
  generateEcosystem(root);
  return root;
}

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
