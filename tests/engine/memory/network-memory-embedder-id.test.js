import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const { ConfigLoader } = require('../../../engine/src/core/config-loader.js');
const { IngestionManifest } = require('../../../engine/src/ingestion/ingestion-manifest.js');
const yaml = require('js-yaml');
const legacy = 'ollama:nomic-embed-text:768';
const target = 'gemini:gemini-embedding-2:2';
const logger = { info() {}, debug() {}, warn() {}, error() {} };
function memory() {
  const result = new NetworkMemory({
    embedding: { provider: 'gemini', model: 'gemini-embedding-2', dimensions: 2 },
    smallWorld: {}, decay: { minimumWeight: 0.1 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
  }, logger, {
    env: { GEMINI_API_KEY: 'fake-test-key' },
    fetch: async () => ({ ok: true, json: async () => ({ embeddings: [{ values: [3, 4] }] }) }),
  });
  result.tokenizer = null;
  return result;
}

test('public defaults retain Ollama nomic-embed-text with 768 dimensions', async () => {
  for (const file of ['configs/base-engine.yaml', 'config/home.yaml.example']) {
    const config = yaml.load(await readFile(file, 'utf8')).architecture.memory.embedding;
    assert.equal(config.provider, 'ollama');
    assert.equal(config.model, 'nomic-embed-text');
    assert.equal(config.dimensions, 768);
    assert.equal(config.fallback, 'none');
    assert.equal(config.pricePerMillionTokens, 0.20);
  }
});

test('home memory configuration overlays base without removing decay or instance memory settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embedding-config-'));
  try {
    await mkdir(join(root, 'config'));
    await mkdir(join(root, 'configs'));
    const base = await readFile('configs/base-engine.yaml', 'utf8');
    await writeFile(join(root, 'configs/base-engine.yaml'), base);
    await writeFile(join(root, 'config/home.yaml'), 'architecture:\n  memory:\n    embedding:\n      provider: gemini\n      model: gemini-embedding-2\n');
    const loader = new ConfigLoader(join(root, 'configs/base-engine.yaml'));
    loader.resolveInstanceConfigPath = () => null;
    const config = loader.load();
    assert.equal(config.architecture.memory.embedding.provider, 'gemini');
    assert.equal(config.architecture.memory.embedding.dimensions, 768);
    assert.equal(config.architecture.memory.decay.baseFactor, 0.995);
    loader.applyInstanceArchitectureOverrides({ architecture: { memory: { embedding: { batchSize: 10 } } } });
    assert.equal(config.architecture.memory.decay.baseFactor, 0.995);
    assert.equal(loader.config.architecture.memory.embedding.model, 'gemini-embedding-2');
    assert.equal(loader.config.architecture.memory.embedding.batchSize, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Gemini vectors record their space and round-trip through all graph exports and standalone persistence', async () => {
  const graph = memory();
  const node = await graph.addNode('water runs downhill');
  assert.equal(node.embedder_id, target);
  assert.deepEqual(Array.from(node.embedding), Array.from(Float32Array.from([0.6, 0.8])));
  assert.equal(graph.exportGraph().metadata.embedderId, target);
  assert.equal(graph.exportGraph().nodes[0].embedder_id, target);
  assert.equal((await graph.exportGraphAsync()).metadata.embedderId, target);
  assert.equal(graph.exportPersistenceShell().metadata.embedderId, target);
  const dir = await mkdtemp(join(tmpdir(), 'embedding-brain-'));
  try {
    const file = join(dir, 'brain.json');
    await graph.save(file);
    const loaded = memory();
    await loaded.load(file);
    assert.equal(loaded.metadata.embedderId, target);
    assert.equal(loaded.nodes.get(node.id).embedder_id, target);
    loaded.config.embedding.model = 'another-embedding';
    await assert.rejects(() => loaded.addNode('new fact'), { code: 'EMBEDDER_ID_MISMATCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unstamped saved brains remain legacy and refuse every new vector write with re-embed guidance', async () => {
  const graph = memory();
  graph.loadEmbeddingMetadata();
  assert.equal(graph.metadata.embedderId, legacy);
  graph.nodes.set(1, { id: 1, concept: 'water runs downhill', embedding: null });
  await assert.rejects(() => graph.embed('query'), /brain re-embed/);
  await assert.rejects(() => graph.embedBatch(['query']), { code: 'EMBEDDER_ID_MISMATCH' });
  await assert.rejects(() => graph.addNode('query', 'general', [1, 0]), { code: 'EMBEDDER_ID_MISMATCH' });
  await assert.rejects(() => graph.regenerateMissingEmbeddings(), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.throws(() => graph.patchNode(1, { embedding: [1, 0] }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.throws(() => graph.importGraphChanges({ nodes: [{ id: 2, embedding: [1, 0] }] }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.equal(graph.nodes.get(1).embedding, null);
  assert.equal(graph.nodes.size, 1);
});

test('new Gemini brain refuses unstamped or differently stamped imported vectors', async () => {
  const graph = memory();
  await assert.rejects(() => graph.addNode({ concept: 'old vector', embedding: [1, 0] }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.throws(() => graph.importGraphChanges({ nodes: [{ id: 1, concept: 'old', embedding: [1, 0] }] }), { code: 'EMBEDDER_ID_MISMATCH' });
  const node = await graph.addNode('new fact');
  assert.throws(() => graph.patchNode(node.id, { embedding: [1, 0], embedder_id: legacy }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.throws(() => graph.patchNode(node.id, { embedding: [1, 0] }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.throws(() => graph.patchNode(node.id, { embedder_id: legacy }), { code: 'EMBEDDER_ID_MISMATCH' });
  graph.nodes.set(99, { id: 99, embedding: [1, 0], embedder_id: legacy });
  assert.throws(() => graph.patchNode(99, { embedder_id: target }), { code: 'EMBEDDER_ID_MISMATCH' });
});

test('owned re-embedded vectors retain recipe compatibility without legacy Seed env contamination', () => {
  const graph = memory();
  graph.config.embedding = { provider: 'owned-onnx', model: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix', dimensions: 768 };
  graph.embeddingDeps.env = { EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_MODEL: 'nomic-embed-text', EMBEDDING_RECIPE_ID: 'nomic-embed-text' };
  graph.metadata.embedderId = graph.getConfiguredEmbedderId();
  const recipe = graph.activeMemoryRecipe();
  assert.equal(recipe.known, true);
  assert.match(recipe.profile, /^owned-/);
  const node = { embedder_id: graph.metadata.embedderId };
  assert.equal(graph.nodeEmbeddingRecipeId(node), recipe.hash);
  assert.equal(graph.embeddingsComparable([1, 0], [1, 0], recipe.hash, graph.nodeEmbeddingRecipeId(node)), true);
});

test('NetworkMemory uses the configured Ollama SDK endpoint instead of its legacy default factory', async () => {
  let selected;
  const graph = new NetworkMemory({ embedding: {
    provider: 'ollama', model: 'nomic-embed-text', dimensions: 768,
    baseUrl: 'http://127.0.0.1:23456/v1',
  } }, logger, {
    env: { EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1' },
    createOllamaClient(config) {
      selected = config.baseUrl;
      return { embeddings: { create: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) } };
    },
  });
  graph.tokenizer = null;
  assert.deepEqual(await graph.embed('endpoint check'), [1, 0]);
  assert.equal(selected, 'http://127.0.0.1:23456/v1');
});

test('feeder re-embeds cached legacy vectors before admitting them to a Gemini brain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embedding-queue-'));
  const graph = memory();
  const manifest = new IngestionManifest({
    runPath: root, memory: graph, config: { batchSize: 20 }, logger,
    embeddingFn: text => graph.embed(text),
  });
  try {
    manifest._pending = [{
      filePath: '/workspace/note.md', sourcePath: '/workspace/note.md#chunk-0',
      chunkIndex: 0, totalChunks: 1, content: 'water runs downhill',
      contentHash: 'full-hash-0123456789', hash: 'full-hash-0123456789',
      embedding: [1, 0], tag: 'document', relationships: [],
    }];
    const result = await manifest.flush('embedder-switch');
    assert.equal(result.flushed, 1);
    const node = [...graph.nodes.values()][0];
    assert.equal(node.embedder_id, target);
    assert.deepEqual(Array.from(node.embedding), Array.from(Float32Array.from([0.6, 0.8])));
  } finally {
    await manifest.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
