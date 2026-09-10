import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IntrospectionModule } = require('../../../engine/src/system/introspection.js');

const logger = {
  debug() {},
  info() {},
  warn() {},
};

function item(filePath, preview = 'new output') {
  return {
    filePath,
    preview,
    timestamp: Date.now(),
    agentType: 'research',
    agentId: 'agent1',
  };
}

test('integrate never waits for semantic query or embedding provider I/O', async () => {
  let queryCalls = 0;
  let embeddingCalls = 0;
  const added = [];
  const memory = {
    nodes: new Map(),
    query() {
      queryCalls += 1;
      return new Promise(() => {});
    },
    queryByKeyword() {
      return [];
    },
    async addNode(node) {
      if (!node.embedding) {
        embeddingCalls += 1;
        return new Promise(() => {});
      }
      assert.ok(node.embedding instanceof Float32Array);
      assert.equal(node.embedding.length, 768);
      assert.equal(node.embedding.every((value) => value === 0), true);
      const stored = { ...node, id: `node-${added.length + 1}` };
      added.push(stored);
      memory.nodes.set(stored.id, stored);
      return stored;
    },
  };
  const module = new IntrospectionModule({ introspection: { enabled: true } }, logger, memory);

  const completion = module.integrate([
    item('/run/outputs/research/agent1/report.txt'),
    item('/run/outputs/analysis/agent2/report.txt'),
  ]);
  let timeout;
  const startedAt = performance.now();
  let nodeIds;
  try {
    nodeIds = await Promise.race([
      completion,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('integration exceeded 250ms')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }

  assert.deepEqual(nodeIds, ['node-1', 'node-2']);
  assert.ok(performance.now() - startedAt < 250);
  assert.equal(queryCalls, 0);
  assert.equal(embeddingCalls, 0);
  assert.deepEqual(
    added.map((node) => node.metadata.introspectionSourcePath),
    [
      '/run/outputs/research/agent1/report.txt',
      '/run/outputs/analysis/agent2/report.txt',
    ],
  );
});

test('integrate deduplicates exact normalized source paths and preserves legacy basename dedup', async () => {
  const added = [];
  const existing = [
    {
      id: 'exact',
      tag: 'introspection',
      concept: '[INTROSPECTION] exact.txt from research agent agent1: old',
      metadata: { introspectionSourcePath: '/run/outputs/research/agent1/../agent1/exact.txt' },
    },
    {
      id: 'legacy',
      tag: 'introspection',
      concept: '[INTROSPECTION] legacy.txt from research agent agent1: old',
    },
  ];
  const memory = {
    query() {
      throw new Error('semantic query must not be called');
    },
    queryByKeyword() {
      return existing;
    },
    async addNode(node) {
      added.push(node);
      return { ...node, id: 'new-node' };
    },
  };
  const module = new IntrospectionModule({ introspection: { enabled: true } }, logger, memory);

  const nodeIds = await module.integrate([
    item('/run/outputs/research/agent1/exact.txt'),
    item('/different/path/legacy.txt'),
    item('/run/outputs/research/agent1/new.txt'),
    item('/run/outputs/research/agent1/./new.txt'),
  ]);

  assert.deepEqual(nodeIds, ['new-node']);
  assert.equal(added.length, 1);
  assert.equal(added[0].metadata.introspectionSourcePath, '/run/outputs/research/agent1/new.txt');
});
