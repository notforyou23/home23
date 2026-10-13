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
const { OWNED_EMBEDDER_ID } = require('../../../engine/src/memory/embedding-provider.js');
const {
  OWNED_EMBEDDING_PROFILE, OWNED_EMBEDDING_RECIPE_ID,
  LEGACY_EMBEDDING_PROFILE, LEGACY_EMBEDDING_RECIPE_ID,
} = require('../../../shared/semantic-encoder-contract.cjs');
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
    secrets: {},
    env: { GEMINI_API_KEY: 'fake-test-key' },
    fetch: async () => ({ ok: true, json: async () => ({ embeddings: [{ values: [3, 4] }] }) }),
  });
  result.tokenizer = null;
  return result;
}

function ownedMemory({ fromEnvironment = false, recipeId } = {}) {
  const graph = new NetworkMemory({
    embedding: fromEnvironment ? {} : {
      provider: 'owned-onnx', model: OWNED_EMBEDDING_PROFILE, dimensions: 768,
      baseUrl: 'http://127.0.0.1:23111/v1', ...(recipeId ? { recipeId } : {}),
    },
    smallWorld: {}, decay: { minimumWeight: 0.1 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
  }, logger, {
    env: fromEnvironment ? {
      EMBEDDING_PROVIDER: 'home23-owned', EMBEDDING_MODEL: OWNED_EMBEDDING_PROFILE,
      EMBEDDING_DIMENSIONS: '768', EMBEDDING_BASE_URL: 'http://127.0.0.1:23111/v1',
    } : {},
    fetch: async () => { assert.fail('These admission tests must not request embeddings'); },
  });
  graph.tokenizer = null;
  return graph;
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

test('Host owned alias keeps the owned recipe when inherited legacy Seed recipe is present', () => {
  const graph = memory();
  graph.config.embedding = { provider: 'home23-owned', model: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix', dimensions: 768 };
  graph.embeddingDeps.env = { EMBEDDING_PROVIDER: 'ollama-local', EMBEDDING_MODEL: 'nomic-embed-text' };
  const previous = process.env.EMBEDDING_RECIPE_ID;
  process.env.EMBEDDING_RECIPE_ID = 'legacy-ollama-nomic-unprefixed';
  try {
    assert.equal(graph.activeMemoryRecipe().profile, 'owned-nomic-v1.5-onnx-fp32-mean-noprefix');
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_RECIPE_ID;
    else process.env.EMBEDDING_RECIPE_ID = previous;
  }
});

test('an environment-selected owned brain refuses unstamped add, import, and replacement vectors', async () => {
  const graph = ownedMemory({ fromEnvironment: true });
  const vector = new Array(768).fill(1);
  assert.equal(graph.resolvedEmbeddingConfig().provider, 'owned-onnx');
  assert.equal(graph.config.embedding.provider, undefined);
  await assert.rejects(() => graph.addNode({ concept: 'unattributed imported vector', embedding: vector }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.throws(() => graph.importGraphChanges({ nodes: [{ id: 1, concept: 'unattributed vector', embedding: vector }] }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.equal(graph.nodes.size, 0);
  const node = await graph.addNode({ concept: 'owned vector', embedding: vector, embedder_id: OWNED_EMBEDDER_ID });
  const before = Array.from(node.embedding);
  assert.throws(() => graph.patchNode(node.id, { embedding: vector }), { code: 'EMBEDDER_ID_MISMATCH' });
  assert.deepEqual(Array.from(node.embedding), before);
  assert.equal(node.embedder_id, OWNED_EMBEDDER_ID);
});

test('owned vector admission rejects explicit conflicting recipe stamps despite a matching embedder identity', async () => {
  const graph = ownedMemory(), vector = new Array(768).fill(1);
  for (const fields of [
    { embedding_recipe_id: LEGACY_EMBEDDING_RECIPE_ID },
    { embeddingRecipeId: LEGACY_EMBEDDING_PROFILE },
    { embedding_encoder: LEGACY_EMBEDDING_PROFILE },
    { embedding_recipe_id: OWNED_EMBEDDING_RECIPE_ID, embeddingRecipeId: LEGACY_EMBEDDING_RECIPE_ID },
    { embedding_recipe_id: 'unknown-encoder-recipe' },
  ]) {
    const incoming = { id: 1, concept: 'conflicting recipe', embedding: vector, embedder_id: OWNED_EMBEDDER_ID, ...fields };
    await assert.rejects(() => graph.addNode(incoming), { code: 'EMBEDDER_ID_MISMATCH' });
    assert.throws(() => graph.importGraphChanges({ nodes: [incoming] }), { code: 'EMBEDDER_ID_MISMATCH' });
    assert.equal(graph.nodes.size, 0);
  }
});

test('owned recipe aliases are accepted and recipe-only patches cannot relabel existing owned vectors', async () => {
  const graph = ownedMemory(), vector = new Array(768).fill(1);
  const node = await graph.addNode({
    concept: 'owned recipe alias', embedding: vector, embedder_id: OWNED_EMBEDDER_ID,
    embedding_recipe_id: OWNED_EMBEDDING_PROFILE, embeddingRecipeId: OWNED_EMBEDDING_RECIPE_ID,
    embedding_encoder: OWNED_EMBEDDING_PROFILE,
  });
  assert.equal(node.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(node.embedding_encoder, OWNED_EMBEDDING_PROFILE);
  for (const field of ['embedding_recipe_id', 'embeddingRecipeId', 'embedding_encoder']) {
    assert.throws(() => graph.patchNode(node.id, { [field]: LEGACY_EMBEDDING_PROFILE }), { code: 'EMBEDDER_ID_MISMATCH' });
    assert.throws(() => graph.patchNode(node.id, {
      embedding: vector, embedder_id: OWNED_EMBEDDER_ID, [field]: LEGACY_EMBEDDING_PROFILE,
    }), { code: 'EMBEDDER_ID_MISMATCH' });
  }
  assert.equal(node.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(node.embedding_encoder, OWNED_EMBEDDING_PROFILE);
});

test('the owned provider retains its fixed recipe despite a conflicting raw recipe configuration', async () => {
  const graph = ownedMemory({ recipeId: LEGACY_EMBEDDING_RECIPE_ID });
  assert.equal(graph.activeMemoryRecipe().hash, OWNED_EMBEDDING_RECIPE_ID);
  const node = await graph.addNode({
    concept: 'fixed owned provenance', embedding: new Array(768).fill(1), embedder_id: OWNED_EMBEDDER_ID,
  });
  assert.equal(node.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(node.embedding_encoder, OWNED_EMBEDDING_PROFILE);
});

test('newly generated and regenerated owned vectors replace stale recipe fields on text-only records', async () => {
  const graph = ownedMemory(), vector = new Array(768).fill(1);
  graph.embed = async () => vector;
  const node = await graph.addNode({
    concept: 'text from the legacy brain', embedding_recipe_id: LEGACY_EMBEDDING_RECIPE_ID,
    embedding_encoder: LEGACY_EMBEDDING_PROFILE,
  });
  assert.equal(node.embedder_id, OWNED_EMBEDDER_ID);
  assert.equal(node.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(node.embedding_encoder, OWNED_EMBEDDING_PROFILE);
  graph.nodes.set(99, { id: 99, concept: 'missing vector', embedding: null,
    embedder_id: OWNED_EMBEDDER_ID, embedding_recipe_id: LEGACY_EMBEDDING_RECIPE_ID,
    embeddingRecipeId: LEGACY_EMBEDDING_PROFILE, embedding_encoder: LEGACY_EMBEDDING_PROFILE });
  graph.embedBatch = async () => [vector];
  assert.equal((await graph.regenerateMissingEmbeddings()).regenerated, 1);
  const regenerated = graph.nodes.get(99);
  assert.equal(regenerated.embedder_id, OWNED_EMBEDDER_ID);
  assert.equal(regenerated.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(regenerated.embedding_encoder, OWNED_EMBEDDING_PROFILE);
  assert.equal(regenerated.embeddingRecipeId, undefined);
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
