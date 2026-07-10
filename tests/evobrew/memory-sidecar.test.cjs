const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { hydrateStateMemory } = require('../../evobrew/lib/memory-sidecar');

function writeJsonlGz(filePath, records) {
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(filePath, zlib.gzipSync(body));
}

test('hydrates empty inline memory from Home23 sidecars', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evobrew-sidecar-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evobrew-inline-'));
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

test('hydrates legacy sidecars through shared source projection without mutating target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evobrew-sidecar-projection-'));
  const nodes = [
    { id: 201, concept: 'evobrew projected node', tag: 'legacy', cluster: 9 },
    { id: 'ev-two', concept: 'second evobrew node', tag: 'legacy', cluster: '9' }
  ];
  const edges = [{ from: 201, to: 'ev-two', weight: 0.6, type: 'link' }];

  writeJsonlGz(path.join(dir, 'memory-nodes.jsonl.gz'), nodes);
  writeJsonlGz(path.join(dir, 'memory-edges.jsonl.gz'), edges);
  const before = fs.readdirSync(dir).sort();
  const state = { memory: { nodes: [], edges: [] } };
  const result = await hydrateStateMemory(dir, state, { logger: { warn() {} } });

  assert.equal(result.source, 'sidecar');
  assert.equal(result.hydrated, true);
  assert.deepEqual(state.memory.nodes.map((node) => node.id), ['201', 'ev-two']);
  assert.deepEqual(state.memory.edges.map((edge) => [edge.source, edge.target]), [['201', 'ev-two']]);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});
