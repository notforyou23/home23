const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_GZIP_LEVEL,
  MEMORY_DELTA_FILE,
  appendMemoryDelta,
  readJsonlGz,
  readMemoryDeltas,
  writeJsonlGz,
  writeMemorySidecars,
} = require('../../../engine/src/core/memory-sidecar');

test('writeJsonlGz supports overlapping writes to the same output path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-sidecar-overlap-'));
  const outPath = path.join(dir, 'memory-nodes.jsonl.gz');
  const first = Array.from({ length: 1500 }, (_, i) => ({ id: `a${i}`, value: 'first' }));
  const second = Array.from({ length: 1500 }, (_, i) => ({ id: `b${i}`, value: 'second' }));

  const results = await Promise.allSettled([
    writeJsonlGz(outPath, first),
    writeJsonlGz(outPath, second),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);

  const readResult = await readJsonlGz(outPath, () => {});
  assert.equal(readResult.count, 1500);
  assert.equal(readResult.parseErrors, 0);

  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonlGz defaults to speed-oriented gzip for hot engine saves', () => {
  assert.equal(DEFAULT_GZIP_LEVEL, 1);
});

test('memory deltas append and replay node and edge mutations', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-sidecar-delta-'));

  await appendMemoryDelta(dir, {
    nodes: [{ id: 'n1', concept: 'first' }],
    edges: [{ source: 'n1', target: 'n2', weight: 0.4, type: 'test' }],
  });
  await appendMemoryDelta(dir, {
    nodes: [{ id: 'n1', concept: 'updated' }],
    removedNodeIds: ['n3'],
    removedEdgeKeys: ['n3->n4'],
  });

  const seen = { nodes: [], edges: [], removedNodes: [], removedEdges: [] };
  const result = await readMemoryDeltas(dir, {
    onNode: (node) => seen.nodes.push(node),
    onEdge: (edge) => seen.edges.push(edge),
    onRemoveNode: (id) => seen.removedNodes.push(id),
    onRemoveEdge: (key) => seen.removedEdges.push(key),
  });

  assert.equal(result.count, 5);
  assert.equal(result.parseErrors, 0);
  assert.deepEqual(seen.nodes.map((node) => node.concept), ['first', 'updated']);
  assert.deepEqual(seen.edges.map((edge) => edge.source), ['n1']);
  assert.deepEqual(seen.removedNodes, ['n3']);
  assert.deepEqual(seen.removedEdges, ['n3->n4']);
});

test('memory deltas stream append without one giant joined string', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-sidecar-stream-delta-'));
  const originalAppendFile = fs.promises.appendFile;
  fs.promises.appendFile = async (_file, data) => {
    if (String(data).length > 1024) {
      throw new Error('simulated Invalid string length');
    }
    return originalAppendFile.apply(fs.promises, arguments);
  };

  try {
    const bigEmbedding = Array.from({ length: 512 }, (_, i) => i / 512);
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`,
      concept: `cluster reassignment ${i}`,
      cluster: i % 4,
      embedding: bigEmbedding,
    }));

    const result = await appendMemoryDelta(dir, { nodes });

    assert.equal(result.count, 80);
  } finally {
    fs.promises.appendFile = originalAppendFile;
  }

  let replayed = 0;
  const readResult = await readMemoryDeltas(dir, {
    onNode: (node) => {
      replayed++;
      assert.equal(Array.isArray(node.embedding), true);
    },
  });

  assert.equal(readResult.count, 80);
  assert.equal(readResult.parseErrors, 0);
  assert.equal(replayed, 80);
});

test('full sidecar rewrite clears pending memory delta journal', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-sidecar-compact-'));
  await appendMemoryDelta(dir, { nodes: [{ id: 'n1', concept: 'delta' }] });
  assert.equal(fs.existsSync(path.join(dir, MEMORY_DELTA_FILE)), true);

  await writeMemorySidecars(dir, {
    nodes: [{ id: 'n1', concept: 'base' }],
    edges: [],
  });

  assert.equal(fs.existsSync(path.join(dir, MEMORY_DELTA_FILE)), false);
});

test('full sidecar rewrite serializes typed-array embeddings as JSON arrays', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-sidecar-typed-'));
  const nodes = new Map([
    ['n1', { id: 'n1', concept: 'typed', embedding: Float32Array.from([0.25, 0.5]) }],
  ]);

  await writeMemorySidecars(dir, { nodes, edges: [] });

  const seen = [];
  await readJsonlGz(path.join(dir, 'memory-nodes.jsonl.gz'), (node) => seen.push(node));

  assert.equal(Array.isArray(seen[0].embedding), true);
  assert.deepEqual(seen[0].embedding, [0.25, 0.5]);
});
