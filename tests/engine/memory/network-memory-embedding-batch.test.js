import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');

function createMemory(getEmbeddingClient) {
  const memory = new NetworkMemory({
    embedding: { model: 'test-embedding', dimensions: 2 },
    smallWorld: {},
    spreading: {},
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
