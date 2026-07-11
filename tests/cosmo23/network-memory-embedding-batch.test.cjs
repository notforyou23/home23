'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');

function createMemory(getEmbeddingClient) {
  const memory = new NetworkMemory({
    embedding: { model: 'test-embedding', dimensions: 2 },
    smallWorld: {}, spreading: {},
  }, {
    info() {}, warn() {}, debug() {}, error() {},
  }, null, { getEmbeddingClient });
  memory.tokenizer = null;
  return memory;
}

test('COSMO successful batch preserves provider indexes without duplicate fallback calls', async () => {
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

test('COSMO batch retries only missing indexes and keeps output order', async () => {
  const calls = [];
  const memory = createMemory(() => ({
    embeddings: {
      create: async (request) => {
        calls.push(request.input);
        if (Array.isArray(request.input)) {
          return { data: [{ index: 1, embedding: [0, 1] }] };
        }
        assert.equal(request.input, 'a');
        return { data: [{ index: 0, embedding: [1, 0] }] };
      },
    },
  }));

  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b'], 'a']);
});

test('COSMO read-only query does not mutate access metadata', async () => {
  const memory = createMemory(() => ({ embeddings: { create: async () => ({ data: [] }) } }));
  memory.embed = async () => [1, 0];
  const accessed = new Date('2026-01-01T00:00:00.000Z');
  memory.nodes.set('n1', {
    id: 'n1', concept: 'canary', embedding: [1, 0], activation: 0,
    weight: 0.2, accessCount: 0, created: accessed, accessed,
  });

  const result = await memory.query('canary', 1, { markAccess: false });

  assert.equal(result.length, 1);
  assert.equal(memory.nodes.get('n1').accessCount, 0);
  assert.equal(memory.nodes.get('n1').accessed, accessed);
  assert.equal(memory.nodes.get('n1').weight, 0.2);
});
