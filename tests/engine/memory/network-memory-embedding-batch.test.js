import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const {
  LEGACY_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  OWNED_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_RECIPE_ID,
} = require('../../../shared/semantic-encoder-contract.cjs');

function createMemory(getEmbeddingClient) {
  const memory = new NetworkMemory({
    embedding: { model: 'test-embedding', dimensions: 2 },
    smallWorld: {},
    spreading: { bridgeTraversalFactor: 0.2, maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
  }, {
    info() {}, warn() {}, debug() {}, error() {},
  }, { getEmbeddingClient });
  memory.tokenizer = null;
  return memory;
}

test('successful batch returns one ordered vector per input without fallback calls', async () => {
  const calls = [];
  const memory = createMemory(() => ({
    embeddings: {
      create: async (request) => {
        calls.push(request.input);
        return { data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ] };
      },
    },
  }));

  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b']]);
});

test('batch fallback requests only missing response indexes', async () => {
  const calls = [];
  const memory = createMemory(() => ({
    embeddings: {
      create: async (request) => {
        calls.push(request.input);
        if (Array.isArray(request.input)) {
          return { data: [{ index: 0, embedding: [1, 0] }] };
        }
        assert.equal(request.input, 'b');
        return { data: [{ index: 0, embedding: [0, 1] }] };
      },
    },
  }));

  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b'], 'b']);
});

test('query refuses length and recipe mismatches rather than mixing spaces', () => {
  const memory = createMemory(() => ({
    embeddings: { create: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) },
  }));
  const owned = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';
  assert.equal(memory.embeddingsComparable([1, 0], [1, 0, 0], null, null), false);
  assert.equal(memory.cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(memory.embeddingsComparable([1, 0], [1, 0], owned, null), false);
  assert.equal(memory.embeddingsComparable([1, 0], [1, 0], owned, owned), true);
  assert.equal(memory.embeddingsComparable([1, 0], [1, 0], null, null), true);
  memory.config.embedding.recipeId = owned;
  assert.equal(memory.getEmbeddingRecipeId(), owned);
});

test('batch validation keeps one output slot per input when provider rows are malformed', async () => {
  const calls = [];
  const memory = createMemory(() => ({
    embeddings: {
      create: async (request) => {
        calls.push(request.input);
        if (Array.isArray(request.input)) {
          return { data: [
            { index: 0, embedding: [1, 0] },
            { index: 0, embedding: [9, 9] },
            { index: 99, embedding: [9, 9] },
            { index: 1, embedding: null },
          ] };
        }
        return { data: [{ index: 0, embedding: [0, 1] }] };
      },
    },
  }));

  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b'], 'b']);
});

function withClearedMemoryRecipeEnv(run) {
  const priorRecipe = process.env.EMBEDDING_RECIPE_ID;
  const priorModel = process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_RECIPE_ID;
  delete process.env.EMBEDDING_MODEL;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (priorRecipe === undefined) delete process.env.EMBEDDING_RECIPE_ID;
      else process.env.EMBEDDING_RECIPE_ID = priorRecipe;
      if (priorModel === undefined) delete process.env.EMBEDDING_MODEL;
      else process.env.EMBEDDING_MODEL = priorModel;
    });
}

test('addNode stamps new embedded nodes with the default lived-legacy hash', async () => {
  await withClearedMemoryRecipeEnv(async () => {
    const memory = createMemory(() => ({ embeddings: { create: async () => { throw new Error('unused'); } } }));
    const node = await memory.addNode({ concept: 'a hydrologic note', embedding: [1, 0] });
    assert.equal(node.embedding_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
    assert.equal(node.embedding_encoder, LEGACY_EMBEDDING_PROFILE);
    assert.equal(memory.activeMemoryRecipe().hash, LEGACY_EMBEDDING_RECIPE_ID);
  });
});

test('addNode stamps owned hash when the home requests the owned recipe by name or hash', async () => {
  await withClearedMemoryRecipeEnv(async () => {
    const byName = createMemory(() => ({ embeddings: { create: async () => { throw new Error('unused'); } } }));
    byName.config.embedding.recipeId = OWNED_EMBEDDING_PROFILE;
    const named = await byName.addNode({ concept: 'owned by profile name', embedding: [1, 0] });
    assert.equal(named.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
    assert.equal(named.embedding_encoder, OWNED_EMBEDDING_PROFILE);

    const byHash = createMemory(() => ({ embeddings: { create: async () => { throw new Error('unused'); } } }));
    byHash.config.embedding.recipeId = OWNED_EMBEDDING_RECIPE_ID;
    const hashed = await byHash.addNode({ concept: 'owned by recipe hash', embedding: [1, 0] });
    assert.equal(hashed.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
    assert.equal(hashed.embedding_encoder, OWNED_EMBEDDING_PROFILE);
  });
});

test('addNode does not invent a recipe when the node has no vector', async () => {
  await withClearedMemoryRecipeEnv(async () => {
    const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
    const node = await memory.addNode('memory lite node without a vector');
    assert.equal(node.embedding, null);
    assert.equal(node.embedding_status, 'missing');
    assert.equal(node.embedding_recipe_id, undefined);
    assert.equal(node.embedding_encoder, undefined);
  });
});

test('importGraphChanges leaves unstamped nodes unstamped and query does not backfill them', async () => {
  await withClearedMemoryRecipeEnv(async () => {
    const memory = createMemory(() => ({
      embeddings: { create: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) },
    }));
    memory.config.embedding.recipeId = OWNED_EMBEDDING_PROFILE;
    const stamped = await memory.addNode({ concept: 'hydrologic cycle movement of water', embedding: [1, 0] });
    memory.importGraphChanges({
      nodes: [{ id: 99, concept: 'granite crystallizes from magma', embedding: [1, 0] }],
    });
    const imported = memory.nodes.get(99);
    assert.ok(imported);
    assert.equal(stamped.embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
    assert.equal(imported.embedding_recipe_id, undefined);
    assert.equal(imported.embeddingRecipeId, undefined);
    const queryHash = memory.activeMemoryRecipe().hash;
    assert.equal(queryHash, OWNED_EMBEDDING_RECIPE_ID);
    assert.equal(memory.embeddingsComparable([1, 0], [1, 0], queryHash, memory.nodeEmbeddingRecipeId(stamped)), true);
    assert.equal(memory.embeddingsComparable([1, 0], [1, 0], queryHash, memory.nodeEmbeddingRecipeId(imported)), false);
    assert.equal(
      memory.findInitialConnections(stamped, stamped.id).some(row => row.id === 99),
      false,
    );
  });
});
