import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
// Use actual in-memory NetworkMemory, with no credential/provider initialization.
Module._load = function loadFixture(request, parent, isMain) {
  if (request === '../core/openai-client') return { getOpenAIClient() { throw new Error('No provider calls in this fixture'); }, getEmbeddingClient() { throw new Error('No provider calls in this fixture'); } };
  if (request === 'tiktoken') return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  return originalLoad.call(this, request, parent, isMain);
};
let NetworkMemory;
try {
  ({ NetworkMemory } = require('../../../engine/src/memory/network-memory.js'));
} finally {
  Module._load = originalLoad;
}
const { resolveGraphNodeId, graphEdgeEndpoints } = require('../../../engine/src/cognition/graph-identity.js');
const { PGSAdapter, toPgsGraph, extractConnections } = require('../../../engine/src/cognition/pgs-adapter.js');
const { DeepDive } = require('../../../engine/src/cognition/deep-dive.js');
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(representation, { degree = 6, nodeCount = 12 } = {}) {
  const id = value => representation === 'numeric' || (representation === 'mixed' && value % 2 === 0) ? value : String(value);
  const memory = new NetworkMemory({
    embedding: {}, coordinator: {}, smallWorld: { maxBridgesPerNode: 40 },
    spreading: { bridgeTraversalFactor: 0.2, maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  }, logger);
  memory.importGraphChanges({
    nodes: Array.from({ length: nodeCount }, (_, offset) => ({ id: id(100 + offset), concept: `Fixture material ${100 + offset}`, cluster: null })),
    edges: Array.from({ length: degree }, (_, offset) => ({ source: id(100), target: id(101 + offset), weight: 0.7, type: 'semantic' })),
  });
  return { memory, id };
}

function shape(graph) {
  return {
    nodes: graph.nodes.map(node => String(node.id)),
    edges: graph.edges.map(edge => [String(edge.source), String(edge.target), edge.weight]),
  };
}

test('node resolution preserves exact keys and rejects lossy numeric aliases', () => {
  const memory = { nodes: new Map([[1, {}], ['1', {}], [0, {}], [-2, {}], ['01', {}], ['named', {}], [Number.MAX_SAFE_INTEGER, {}]]) };
  assert.equal(resolveGraphNodeId(memory, 1), 1);
  assert.equal(resolveGraphNodeId(memory, '1'), '1');
  assert.equal(resolveGraphNodeId(memory, '0'), 0);
  assert.equal(resolveGraphNodeId(memory, '-2'), -2);
  assert.equal(resolveGraphNodeId(memory, '01'), '01');
  assert.equal(resolveGraphNodeId(memory, 'named'), 'named');
  assert.equal(resolveGraphNodeId(memory, String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const value of ['001', '+1', '1.0', '1e0', ' 1', '-0', '9007199254740993', '', null, {}, NaN]) {
    assert.equal(resolveGraphNodeId(memory, value), undefined, String(value));
  }
  assert.equal(resolveGraphNodeId({ nodes: new Map([['2', {}]]) }, 2), '2');
});

test('edge resolution prefers explicit endpoints and admits only existing typed nodes', () => {
  const memory = { nodes: new Map([[1, {}], [2, {}], [3, {}], ['four', {}]]) };
  assert.deepEqual(graphEdgeEndpoints(memory, '1->2', { source: 3, target: 'four' }), [3, 'four']);
  assert.deepEqual(graphEdgeEndpoints(memory, '1->2', { from: '3', to: 'four' }), [3, 'four']);
  assert.deepEqual(graphEdgeEndpoints(memory, '1->2', {}), [1, 2]);
  assert.equal(graphEdgeEndpoints(memory, '1->2', { source: 999, target: 2 }), null);
  assert.equal(graphEdgeEndpoints(memory, '1->missing', {}), null);
  assert.equal(graphEdgeEndpoints(memory, '01->2', {}), null);
  assert.equal(graphEdgeEndpoints(memory, '1->1', {}), null);
});

test('textual citations use exact context IDs independent of numeric/string insertion order', () => {
  // NetworkMemory persistence rejects duplicate logical IDs. Extraction still
  // preserves exact precedence if a supplied context contains both types.
  const nodes = [{ id: 100 }, { id: '100' }, { id: 101 }];
  for (const contextNodes of [nodes, [...nodes].reverse()]) {
    const memory = { nodes: new Map([...contextNodes, { id: 999 }].map(node => [node.id, node])), edges: new Map(), clusters: new Map() };
    const dive = new DeepDive({ memory, logger, unifiedClient: {} });
    assert.deepEqual(dive._extractReferencedNodes('Node 100 contrasts with Node 101. Node 999 is not supplied.', contextNodes), ['100', 101]);
    const result = extractConnections('## A contrast\nNode 100 connects to Node 101. Node 999 is not supplied.', { nodes: contextNodes }, { maxEdgeCandidates: 10 });
    assert.deepEqual(result.candidateEdges.map(({ from, to }) => [from, to]), [['100', 101]]);
    assert.deepEqual(result.perspectives[0].searchResult, ['100', 101]);
  }
});

test('focused and full projections preserve equivalent numeric, string and mixed graph edges', () => {
  let expected;
  for (const representation of ['numeric', 'string', 'mixed']) {
    const { memory, id } = fixture(representation);
    const adapter = Object.create(PGSAdapter.prototype);
    adapter.memory = memory;
    assert.equal(adapter._countSeedEdges(['100']), 6);
    assert.equal(memory.getNeighbors(id(100)).length, 6);
    const focused = toPgsGraph(memory, ['100'], { cap: 10, hops: 1 });
    assert.equal(focused.nodes.length, 7);
    assert.equal(focused.edges.length, 6);
    if (!expected) expected = shape(focused);
    else assert.deepEqual(shape(focused), expected);
    for (const node of focused.nodes) assert.ok(memory.nodes.has(node.id));
    for (const edge of focused.edges) assert.ok(memory.nodes.has(edge.source) && memory.nodes.has(edge.target));
    const full = toPgsGraph(memory, ['100'], { cap: 20, hops: 1 });
    assert.equal(full.nodes.length, 12);
    assert.equal(full.edges.length, 6);
    const capped = toPgsGraph(memory, ['100'], { cap: 5, hops: 1 });
    assert.equal(capped.nodes.length, 5);
    assert.equal(capped.edges.length, 4);
    const sampled = toPgsGraph(memory, [], { cap: 5 });
    assert.equal(sampled.nodes[0].id, id(100));
    assert.equal(sampled.edges.length, 4);
    // Legacy keys without stored endpoints must preserve the same projection.
    for (const [key, edge] of memory.edges) memory.edges.set(key, { weight: edge.weight });
    assert.deepEqual(shape(toPgsGraph(memory, ['100'], { cap: 10, hops: 1 })), expected);
  }
});

test('DeepDive traverses the configured hops and returns only admitted references in original ID types', async () => {
  for (const representation of ['numeric', 'string', 'mixed']) {
    const { memory, id } = fixture(representation, { degree: 1 });
    memory.importGraphChanges({ edges: [
      { source: id(101), target: id(102), weight: 0.6 },
      { source: id(102), target: id(103), weight: 0.5 },
    ] });
    let prompt;
    const dive = new DeepDive({ memory, logger, unifiedClient: { async generate(options) {
      prompt = options.messages[0].content;
      return { content: 'Node 101 contrasts with Node 102. Node 103 and Node 999 are outside the supplied neighborhood.' };
    } } });
    const neighborhood = dive._gatherNeighborhood(['100']);
    assert.deepEqual(neighborhood.nodes.map(node => node.id), [id(100), id(101), id(102)]);
    assert.equal(neighborhood.edges.length, 2);
    const result = await dive.think({ nodeIds: ['100', id(100)], signal: 'exploration', rationale: 'Fixture remembered material' }, {});
    assert.deepEqual(result.referencedNodes, [id(100), id(101), id(102)]);
    assert.ok(result.referencedNodes.every(ref => memory.nodes.has(ref)));
    assert.equal(result.usage.neighborhoodSize, 3);
    assert.match(prompt, /Material to think about\n\*\*\[100/);
    assert.doesNotMatch(prompt, /no node content retrievable/);
  }
});

test('connected numeric, string and mixed graphs reach real PGS and preserve extracted citation IDs', async () => {
  for (const representation of ['numeric', 'string', 'mixed']) {
    const { memory, id } = fixture(representation, { degree: 11, nodeCount: 15001 });
    const calls = [];
    let scope;
    const adapter = new PGSAdapter({ memory, logger: { ...logger, info(message, metadata) {
      if (message === '[pgs-adapter] starting') scope = metadata;
    } }, unifiedClient: { async generate(options) {
      calls.push(options);
      return { content: options.component === 'pgsSynthesis'
        ? '## A useful contrast\nNode 100 connects to Node 101 through the supplied material. Node 999 is not supplied evidence.'
        : 'Node 100 and Node 101 support a contrast.' };
    } } });
    const result = await adapter.connect({ thought: 'Consider the fixture material.', referencedNodes: ['100'] });
    assert.equal(result.available, true, result.note);
    assert.equal(scope.graphSize, 15001);
    assert.equal(scope.scopedNodes, 12);
    assert.equal(scope.scopedEdges, 11);
    assert.equal(scope.maxSweepPartitions, 2);
    assert.equal(scope.timeoutMs, 165000);
    assert.deepEqual(calls.map(call => call.component), ['pgsSweep', 'pgsSynthesis']);
    assert.ok(calls[0].messages[0].content.includes('Fixture material 100'));
    assert.deepEqual(result.candidateEdges.map(({ from, to }) => [from, to]), [[id(100), id(101)]]);
    assert.deepEqual(result.connectionNotes[0].nodeIds, [id(100), id(101)]);
    assert.deepEqual(result.perspectives[0].searchResult, [id(100), id(101)]);
    assert.ok(result.candidateEdges.every(edge => memory.nodes.has(edge.from) && memory.nodes.has(edge.to)));
  }
});

test('a legitimate seven-node scope skips before PGS execution or provider calls on a massive graph', async () => {
  const { memory } = fixture('numeric', { nodeCount: 15001 });
  let executions = 0, calls = 0;
  const adapter = new PGSAdapter({ memory, logger, unifiedClient: { async generate() { calls++; throw new Error('No providers for a sparse graph'); } } });
  adapter.engine.execute = async () => { executions++; throw new Error('Sparse graph must skip before execution'); };
  const result = await adapter.connect({ thought: 'Consider the fixture material.', referencedNodes: ['100'] });
  assert.equal(result.available, false);
  assert.equal(result.note, 'skipped_small_graph');
  assert.equal(executions, 0);
  assert.equal(calls, 0);
  assert.equal(adapter.stats.skippedSmallGraphCount, 1);
  assert.equal(adapter.engine.config.minNodesForPgs, 10);
  assert.equal(adapter._executionInFlight, false);
});
