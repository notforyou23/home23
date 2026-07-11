import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');

function populatedMemory() {
  const memory = new NetworkMemory({
    embedding: { model: 'test', dimensions: 2 },
    smallWorld: {},
    spreading: {},
  }, {
    info() {}, warn() {}, debug() {}, error() {},
  });
  memory.tokenizer = null;
  memory.embed = async () => [1, 0];
  memory.nodes.set('n1', {
    id: 'n1', concept: 'brain access canary', embedding: [1, 0],
    activation: 0, weight: 0.2, accessCount: 0,
    created: new Date('2026-01-01T00:00:00.000Z'),
    accessed: new Date('2026-01-01T00:00:00.000Z'),
  });
  return memory;
}

function accessSnapshot(memory) {
  const node = memory.nodes.get('n1');
  return {
    accessed: node.accessed,
    accessCount: node.accessCount,
    weight: node.weight,
    revision: memory.persistenceRevision,
    generation: memory.persistenceGeneration,
    dirty: [...memory.dirtyNodeIds],
  };
}

test('read-only query does not mutate access metadata or persistence state', async () => {
  const memory = populatedMemory();
  const before = accessSnapshot(memory);

  const result = await memory.query('brain access canary', 1, { markAccess: false });

  assert.equal(result.length, 1);
  assert.deepEqual(accessSnapshot(memory), before);
});

test('own-brain semantic query mutates the stored node and marks it dirty', async () => {
  const memory = populatedMemory();

  const result = await memory.query('brain access canary', 1, { markAccess: true });

  assert.equal(result.length, 1);
  assert.equal(memory.nodes.get('n1').accessCount, 1);
  assert.ok(Math.abs(memory.nodes.get('n1').weight - 0.3) < Number.EPSILON * 2);
  assert.equal(memory.dirtyNodeIds.has('n1'), true);
});

test('keyword access uses the same mutation gate and helper', () => {
  const memory = populatedMemory();
  memory.recordNodeAccess = (nodeIds, options) => {
    assert.deepEqual(nodeIds, ['n1']);
    assert.deepEqual(options, { weightBoost: 0.05 });
  };

  const result = memory.queryByKeyword('brain access canary', 1, { markAccess: true });

  assert.equal(result.length, 1);
});
