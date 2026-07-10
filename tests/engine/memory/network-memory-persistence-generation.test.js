import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai') {
    return class OpenAI {};
  }
  if (request === 'dotenv') {
    return { config() {} };
  }
  if (request.endsWith('/core/openai-client') || request === '../core/openai-client') {
    return {
      getOpenAIClient: () => null,
      getEmbeddingClient: () => null,
    };
  }
  if (request === 'tiktoken') {
    return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
Module._load = originalLoad;

function memory() {
  return new NetworkMemory({ embedding: {}, smallWorld: {}, spreading: {} }, {
    info() {},
    warn() {},
    debug() {},
  });
}

test('capturePersistenceSnapshot returns immutable generation, changes, full view, and summary', () => {
  const mem = memory();
  mem.nodes.set('n1', { id: 'n1', concept: 'first', cluster: 'c1', embedding: Float32Array.from([1, 2]) });
  mem.markNodeDirty('n1');
  const snapshot = mem.capturePersistenceSnapshot();
  assert.equal(snapshot.generation, mem.persistenceGeneration);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.fullView.nodes[0]), true);
  assert.deepEqual(snapshot.summary, { nodeCount: 1, edgeCount: 0, clusterCount: 1 });
  mem.nodes.get('n1').concept = 'mutated';
  assert.equal(snapshot.fullView.nodes[0].concept, 'first');
  assert.deepEqual(snapshot.fullView.nodes[0].embedding, [1, 2]);
});

test('markPersistenceCleanIfGeneration clears only when no later mutation was accepted', () => {
  const mem = memory();
  mem.nodes.set('n1', { id: 'n1', concept: 'first' });
  mem.markNodeDirty('n1');
  const snapshot = mem.capturePersistenceSnapshot();
  mem.nodes.set('n2', { id: 'n2', concept: 'second' });
  mem.markNodeDirty('n2');
  assert.equal(mem.markPersistenceCleanIfGeneration(snapshot.generation), false);
  assert.equal(mem.hasPersistenceChanges(), true);
  assert.equal(mem.markPersistenceCleanIfGeneration(mem.persistenceGeneration), true);
  assert.equal(mem.hasPersistenceChanges(), false);
});

test('same-id repeated accepted mutation advances generation beyond set cardinality', () => {
  const mem = memory();
  mem.nodes.set('n1', { id: 'n1', concept: 'first' });
  mem.markNodeDirty('n1');
  const firstGeneration = mem.persistenceGeneration;
  mem.nodes.set('n1', { id: 'n1', concept: 'second' });
  mem.markNodeDirty('n1');
  assert.equal(mem.dirtyNodeIds.size, 1);
  assert.equal(mem.persistenceGeneration, firstGeneration + 1);
});

test('persistence barrier rejects async callbacks and re-entry', () => {
  const mem = memory();
  assert.throws(() => mem.withPersistenceBarrier(() => Promise.resolve()), /persistence_barrier_async_callback/);
  assert.throws(() => mem.withPersistenceBarrier(() => mem.withPersistenceBarrier(() => 1)), /persistence_barrier_reentry/);
});
