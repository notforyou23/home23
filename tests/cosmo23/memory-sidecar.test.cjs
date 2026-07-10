const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { hydrateStateMemory } = require('../../cosmo23/lib/memory-sidecar');

function writeJsonlGz(filePath, records) {
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(filePath, zlib.gzipSync(body));
}

test('hydrates empty inline memory from Home23 sidecars', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-sidecar-'));
  const nodes = [
    { id: 'n1', concept: 'first node', tag: 'test' },
    { id: 'n2', concept: 'second node', tag: 'test' }
  ];
  const edges = [{ source: 'n1', target: 'n2', weight: 1 }];

  writeJsonlGz(path.join(dir, 'memory-nodes.jsonl.gz'), nodes);
  writeJsonlGz(path.join(dir, 'memory-edges.jsonl.gz'), edges);
  fs.writeFileSync(path.join(dir, 'brain-snapshot.json'), JSON.stringify({
    nodeCount: nodes.length,
    edgeCount: edges.length,
    memorySource: 'sidecar'
  }));

  const state = { cycleCount: 7, memory: { nodes: [], edges: [] } };
  const result = await hydrateStateMemory(dir, state, { logger: { warn() {} } });

  assert.equal(result.source, 'sidecar');
  assert.equal(result.hydrated, true);
  assert.equal(result.nodes, 2);
  assert.equal(result.edges, 1);
  assert.deepEqual(state.memory.nodes, nodes);
  assert.deepEqual(state.memory.edges, edges);
  assert.equal(state.memorySource, 'sidecar');
});

test('keeps legacy inline memory when no sidecars exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-inline-'));
  const state = {
    memory: {
      nodes: [{ id: 'legacy', concept: 'inline node' }],
      edges: []
    }
  };

  const result = await hydrateStateMemory(dir, state, { logger: { warn() {} } });

  assert.equal(result.source, 'inline');
  assert.equal(result.hydrated, false);
  assert.equal(result.nodes, 1);
  assert.equal(state.memory.nodes[0].id, 'legacy');
});

test('hydrates legacy sidecars through numeric-v1 projection without mutating target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-sidecar-projection-'));
  const nodes = [
    { id: 101, concept: 'projected node', tag: 'legacy', cluster: 7, embedding: [1, 2, 3] },
    { id: 'n-two', concept: 'second projected node', tag: 'legacy', cluster: '7' }
  ];
  const edges = [{ from: 101, to: 'n-two', weight: 0.8, type: 'link' }];

  writeJsonlGz(path.join(dir, 'memory-nodes.jsonl.gz'), nodes);
  writeJsonlGz(path.join(dir, 'memory-edges.jsonl.gz'), edges);
  const before = fs.readdirSync(dir).sort();
  const beforeStats = Object.fromEntries(before.map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    return [name, { size: stat.size, mtimeMs: stat.mtimeMs }];
  }));

  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async () => {
    throw new Error('whole-file read forbidden');
  };
  try {
    const state = { memory: { nodes: [], edges: [] } };
    const result = await hydrateStateMemory(dir, state, { logger: { warn() {} } });

    assert.equal(result.source, 'sidecar');
    assert.equal(result.hydrated, true);
    assert.deepEqual(state.memory.nodes.map((node) => node.id), ['101', 'n-two']);
    assert.deepEqual(state.memory.edges.map((edge) => [edge.source, edge.target]), [['101', 'n-two']]);
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  for (const name of before) {
    const after = fs.statSync(path.join(dir, name));
    assert.equal(after.size, beforeStats[name].size);
    assert.equal(after.mtimeMs, beforeStats[name].mtimeMs);
  }
});
