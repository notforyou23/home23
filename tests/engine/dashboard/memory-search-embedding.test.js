import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createDefaultEmbedQuery,
  createMemorySearchService,
} = require('../../../engine/src/dashboard/memory-search');
const { openMemorySource, rewriteMemoryBase, readManifest } = require('../../../shared/memory-source');

const LEGACY_ID = 'ollama:nomic-embed-text:768';
const GEMINI_ID = 'gemini:gemini-embedding-2:768';
const vector = () => [1, ...Array(767).fill(0)];

async function brain(t, nodes, { ann = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-query-embedding-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'brain');
  await rewriteMemoryBase(dir, {
    nodes, edges: [],
    summary: { nodeCount: nodes.length, edgeCount: 0, clusterCount: 0 },
  }, { lockRoot: path.join(root, 'locks') });
  if (ann) {
    const manifest = JSON.parse(JSON.stringify(await readManifest(dir)));
    manifest.ann = {
      indexFile: 'memory-ann.test.index', metaFile: 'memory-ann.test.meta.json',
      builtFromRevision: manifest.currentRevision,
    };
    await fsp.writeFile(path.join(dir, manifest.ann.indexFile), 'index');
    await fsp.writeFile(path.join(dir, manifest.ann.metaFile), '{}');
    await fsp.writeFile(path.join(dir, 'memory-manifest.json'), JSON.stringify(manifest));
  }
  const source = await openMemorySource(dir);
  t.after(() => source.close());
  return { dir, source };
}

async function search(t, source, embedderId, { query = 'canary', loadAnn = async () => null, mode } = {}) {
  const embedQuery = async () => vector();
  embedQuery.id = embedderId;
  const service = createMemorySearchService({ embedQuery, loadAnn, logger: { warn() {} } });
  t.after(() => service.close());
  return service.search({
    sourcePin: source, identity: { operationId: 'query-embedding-test' },
    query, mode, topK: 10, minSimilarity: 0.1, noiseFloor: 0.1,
  });
}

test('dashboard Gemini query uses configured shared provider and normalized vectors', async () => {
  let request;
  const embed = createDefaultEmbedQuery({
    embeddingConfig: { provider: 'gemini', model: 'gemini-embedding-2', dimensions: 768 },
    providerDependencies: {
      env: { GEMINI_API_KEY: 'query-test-key' },
      secrets: {},
      fetch: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ embeddings: [{ values: [3, 4, ...Array(766).fill(0)] }] }) };
      },
    },
  });
  const result = await embed('query canary');
  assert.equal(embed.id, GEMINI_ID);
  assert.equal(result.length, 768);
  assert.deepEqual(result.slice(0, 2), [0.6, 0.8]);
  assert.match(request.url, /gemini-embedding-2:batchEmbedContents$/);
  assert.equal(request.options.headers['x-goog-api-key'], 'query-test-key');
  assert.equal(JSON.parse(request.options.body).requests[0].outputDimensionality, 768);
});

test('dashboard query reads architecture.memory.embedding from home configuration', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-query-config-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'configs'));
  await fsp.mkdir(path.join(root, 'config'));
  await fsp.copyFile(path.resolve('configs/base-engine.yaml'), path.join(root, 'configs/base-engine.yaml'));
  await fsp.writeFile(path.join(root, 'config/home.yaml'), 'architecture:\n  memory:\n    embedding:\n      provider: gemini\n      model: gemini-embedding-2\n      dimensions: 768\n');
  let selected;
  const embed = createDefaultEmbedQuery({
    home23Root: root,
    createProvider: config => {
      selected = config;
      return { id: GEMINI_ID, embed: async () => vector() };
    },
  });
  await embed('query');
  assert.equal(selected.provider, 'gemini');
  assert.equal(selected.model, 'gemini-embedding-2');
  assert.equal(embed.id, GEMINI_ID);
});

test('same-dimensional legacy vectors cannot provide Gemini semantic matches', async t => {
  const { source } = await brain(t, [
    { id: 'legacy-lexical', concept: 'canary lexical result', embedding: vector() },
    { id: 'legacy-semantic', concept: 'different words', embedding: vector() },
  ]);
  const result = await search(t, source, GEMINI_ID);
  assert.deepEqual(result.results.map(node => node.id), ['legacy-lexical']);
  assert.equal(result.results[0].similarity, undefined);
  assert.equal(result.evidence.fallback.reason, 'embedding_id_mismatch');
  assert.equal(result.evidence.sourceHealth, 'degraded');
});

test('Gemini queries bypass unstamped ANN and compare only matching node identities', async t => {
  const { source } = await brain(t, [
    { id: 'gemini-semantic', concept: 'different words', embedding: vector(), embedder_id: GEMINI_ID },
    { id: 'legacy-semantic', concept: 'other words', embedding: vector() },
  ], { ann: true });
  let annLoads = 0;
  const result = await search(t, source, GEMINI_ID, { loadAnn: async () => { annLoads += 1; return null; } });
  assert.equal(annLoads, 0);
  assert.deepEqual(result.results.map(node => node.id), ['gemini-semantic']);
  assert.equal(result.evidence.fallback.reason, 'ann_embedding_id_unknown');
});

test('recorded brain mismatch forces honest keyword retrieval despite stamped nodes', async t => {
  const { source } = await brain(t, [
    { id: 'gemini-lexical', concept: 'canary lexical result', embedding: vector(), embedder_id: GEMINI_ID },
    { id: 'gemini-semantic', concept: 'different words', embedding: vector(), embedder_id: GEMINI_ID },
  ]);
  source.metadata = { embedderId: LEGACY_ID };
  const result = await search(t, source, GEMINI_ID, { mode: 'context' });
  assert.deepEqual(result.results.map(node => node.id), ['gemini-lexical']);
  assert.equal(result.results[0].similarity, undefined);
  assert.equal(result.evidence.fallback.reason, 'embedding_id_mismatch');
});

test('legacy queries also exclude vectors stamped with another embedder', async t => {
  const { source } = await brain(t, [
    { id: 'legacy', concept: 'different words', embedding: vector() },
    { id: 'gemini', concept: 'other words', embedding: vector(), embedder_id: GEMINI_ID },
  ]);
  const result = await search(t, source, LEGACY_ID);
  assert.deepEqual(result.results.map(node => node.id), ['legacy']);
});
