import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sampleMemoryGraph,
  projectGraphNode,
  projectGraphEdge,
} = require('../../shared/memory-source');

function syntheticStreamingSource({ nodes = 0, edges = 0, extraNode = () => ({}), abortController = null } = {}) {
  const source = {
    loadAllCalls: 0,
    recordsConsumed: 0,
    recordsAtAbort: null,
    revision: 7,
    async loadAll() {
      this.loadAllCalls += 1;
      throw new Error('unbounded loader invoked');
    },
    async *iterateNodes({ signal } = {}) {
      for (let index = 0; index < nodes; index += 1) {
        if (signal?.aborted) throw signal.reason;
        this.recordsConsumed += 1;
        if (abortController && index === 74) {
          this.recordsAtAbort = this.recordsConsumed;
          abortController.abort(Object.assign(new Error('stop'), {
            name: 'AbortError',
            code: 'cancelled',
          }));
        }
        yield {
          id: `n-${index}`,
          concept: `node ${index}`,
          tag: 'general',
          weight: index % 11,
          activation: index % 7,
          cluster: index % 5,
          created: '2026-07-10T00:00:00.000Z',
          accessCount: index % 13,
          embedding: new Array(768).fill(0.1),
          metadata: { discarded: true },
          ...extraNode(index),
        };
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edges; index += 1) {
        if (signal?.aborted) throw signal.reason;
        yield {
          source: `n-${index % nodes}`,
          target: `n-${(index + 1) % nodes}`,
          weight: index % 17,
          metadata: { discarded: true },
        };
      }
    },
    async summarize() {
      return { nodes, edges, clusters: 5 };
    },
    getEvidence(input = {}) {
      return {
        sourceHealth: 'healthy',
        matchOutcome: input.matchOutcome || 'matches',
        authoritativeTotals: input.authoritativeTotals,
        returnedTotals: input.returnedTotals,
        filters: input.filters,
        limits: input.limits,
      };
    },
  };
  return source;
}

test('samples a large source within node and edge caps without unbounded loading', async () => {
  const source = syntheticStreamingSource({ nodes: 100000, edges: 300000 });
  const result = await sampleMemoryGraph(source, { nodeLimit: 250, edgeLimit: 1000 });
  assert.equal(result.nodes.length <= 250, true);
  assert.equal(result.edges.length <= 1000, true);
  assert.equal(result.meta.authoritativeNodeCount, 100000);
  assert.equal(result.meta.returnedNodeCount, result.nodes.length);
  assert.equal(source.loadAllCalls, 0);
  assert.equal(result.meta.maxNodeHeapSize, 250);
  assert.equal(result.meta.maxEdgeHeapSize <= 1000, true);
  assert.equal(result.meta.heapComparisons < 12_000_000, true);
});

test('normalizes numeric cluster filters and produces a deterministic pinned sample', async () => {
  const source = syntheticStreamingSource({
    nodes: 9,
    edges: 0,
    extraNode: (index) => ({ cluster: [4, '4', 5][index % 3] }),
  });
  const first = await sampleMemoryGraph(source, { clusterId: '4', nodeLimit: 2, edgeLimit: 2 });
  const second = await sampleMemoryGraph(syntheticStreamingSource({
    nodes: 9,
    edges: 0,
    extraNode: (index) => ({ cluster: [4, '4', 5][index % 3] }),
  }), { clusterId: 4, nodeLimit: 2, edgeLimit: 2 });
  assert.deepEqual(first.nodes.map((row) => row.id), second.nodes.map((row) => row.id));
  assert.equal(first.nodes.every((row) => String(row.cluster) === '4'), true);
});

test('graph sampling applies an exact bounded tag filter to returned nodes and evidence', async () => {
  const source = syntheticStreamingSource({
    nodes: 8,
    edges: 8,
    extraNode: (index) => ({ tag: index % 2 ? 'beta' : 'alpha' }),
  });
  const result = await sampleMemoryGraph(source, {
    tag: 'alpha', nodeLimit: 8, edgeLimit: 8,
  });
  assert.equal(result.nodes.length, 4);
  assert.equal(result.nodes.every((node) => node.tag === 'alpha'), true);
  assert.equal(result.edges.every((edge) => (
    Number(edge.source.split('-')[1]) % 2 === 0
    && Number(edge.target.split('-')[1]) % 2 === 0
  )), true);
  assert.equal(result.evidence.filters.tag, 'alpha');
  await assert.rejects(
    () => sampleMemoryGraph(source, { tag: ' alpha ' }),
    (error) => error.code === 'invalid_request' && error.status === 400 && error.field === 'tag',
  );
});

test('rejects full graph compatibility requests', async () => {
  await assert.rejects(
    () => sampleMemoryGraph(syntheticStreamingSource({ nodes: 1, edges: 0 }), { full: '1' }),
    (error) => error.code === 'result_too_large' && error.status === 413,
  );
});

test('graph limits require finite bounded integers', async () => {
  for (const [name, value] of [
    ['nodeLimit', NaN], ['nodeLimit', Infinity], ['nodeLimit', 1.5],
    ['nodeLimit', '1.5'], ['nodeLimit', 0], ['nodeLimit', 2001],
    ['edgeLimit', -1], ['edgeLimit', 2.25], ['edgeLimit', 8001],
  ]) {
    await assert.rejects(
      () => sampleMemoryGraph(syntheticStreamingSource({ nodes: 1, edges: 0 }), { [name]: value }),
      (error) => error.code === 'invalid_request' && error.status === 400,
    );
  }
  const result = await sampleMemoryGraph(syntheticStreamingSource({ nodes: 1, edges: 1 }), {
    nodeLimit: '1',
    edgeLimit: '0',
  });
  assert.equal(result.edges.length, 0);
});

test('projects graph records through exact scalar schemas and byte caps', async () => {
  const hugeNode = {
    id: 'huge',
    concept: `${'x'.repeat(2 * 1024 * 1024)}🧠`,
    tag: 'tag',
    weight: '2',
    activation: '3',
    cluster: 4,
    created: '2026-07-10T00:00:00.000Z',
    accessed: null,
    accessCount: 2,
    embedding: new Array(4096).fill(0.1),
    metadata: { deeply: { discarded: true } },
  };
  const projectedNode = projectGraphNode(hugeNode);
  assert.deepEqual(Object.keys(projectedNode).sort(), [
    'accessCount', 'accessed', 'activation', 'cluster', 'concept', 'conceptTruncated',
    'created', 'id', 'tag', 'weight',
  ].sort());
  assert.equal(Object.hasOwn(projectedNode, 'embedding'), false);
  assert.equal(projectedNode.conceptTruncated, true);
  assert.equal(Buffer.byteLength(JSON.stringify(projectedNode), 'utf8') <= 128 * 1024, true);

  const projectedEdge = projectGraphEdge({
    source: 'huge',
    target: 'other',
    weight: '5',
    metadata: { huge: 'x'.repeat(1024 * 1024) },
  }, { sourceId: 'huge', targetId: 'other' });
  assert.deepEqual(Object.keys(projectedEdge).sort(), ['source', 'target', 'type', 'weight'].sort());
  assert.equal(Buffer.byteLength(JSON.stringify(projectedEdge), 'utf8') <= 32 * 1024, true);
});

test('omits exact cluster totals when cluster map crosses bounded totals caps', async () => {
  const result = await sampleMemoryGraph(syntheticStreamingSource({
    nodes: 10050,
    edges: 0,
    extraNode: (index) => ({ cluster: `cluster-${index}` }),
  }), { nodeLimit: 10, edgeLimit: 0 });
  assert.equal(result.clusters, null);
  assert.equal(result.meta.clusterTotalsOmitted, true);
});

test('graph cancellation stops node and edge consumption and remains AbortError', async () => {
  const controller = new AbortController();
  const source = syntheticStreamingSource({ nodes: 1000, edges: 0, abortController: controller });
  await assert.rejects(
    () => sampleMemoryGraph(source, { nodeLimit: 10, edgeLimit: 20, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(source.recordsConsumed, source.recordsAtAbort);
});
