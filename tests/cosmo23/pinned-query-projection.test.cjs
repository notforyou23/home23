'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  boundedLimits,
  projectPinnedQuery,
} = require('../../cosmo23/lib/pinned-query-projection');
const {
  QUERY_OPERATION_LIMITS,
} = require('../../cosmo23/lib/brain-operation-limits');

function createSyntheticPinnedSource({
  nodeCount,
  edgeCount,
  revision = 7,
  nodeFactory = null,
  edgeFactory = null,
} = {}) {
  let recordsConsumed = 0;
  async function* iterateNodes({ signal } = {}) {
    for (let index = 0; index < nodeCount; index += 1) {
      if (signal?.aborted) throw signal.reason;
      recordsConsumed += 1;
      yield nodeFactory ? nodeFactory(index) : {
        id: `n${index}`,
        type: 'fact',
        content: index % 997 === 0 ? `bounded canary ${index}` : `ordinary ${index}`,
        salience: (index % 100) / 100,
      };
    }
  }
  async function* iterateEdges({ signal } = {}) {
    for (let index = 0; index < edgeCount; index += 1) {
      if (signal?.aborted) throw signal.reason;
      recordsConsumed += 1;
      yield edgeFactory ? edgeFactory(index) : {
        source: `n${index % nodeCount}`,
        target: `n${(index + 1) % nodeCount}`,
        type: 'relates',
      };
    }
  }
  const materializerError = new Error('full materializer forbidden');
  return {
    revision,
    descriptor: {
      version: 1,
      cutoffRevision: revision,
      summary: { nodeCount, edgeCount, clusterCount: 0 },
    },
    iterateNodes,
    iterateEdges,
    async summarize() { return { nodeCount, edgeCount, clusterCount: 0 }; },
    getEvidence(extra) {
      return { deltaWatermark: { revision }, ...extra };
    },
    stats() { return { recordsConsumed }; },
    loadAll() { throw materializerError; },
    loadState() { throw materializerError; },
    readGraph() { throw materializerError; },
    createPinnedQueryState() { throw materializerError; },
  };
}

test('large direct query scans portable iterators once and retains bounded records', async () => {
  const sourcePin = createSyntheticPinnedSource({ nodeCount: 50_000, edgeCount: 100_000 });
  const projection = await projectPinnedQuery({
    sourcePin,
    query: 'bounded canary',
    signal: new AbortController().signal,
    limits: { maxNodes: 400, maxEdges: 1_600 },
  });

  assert.equal(projection.nodes.length <= 400, true);
  assert.equal(projection.edges.length <= 1_600, true);
  assert.equal(projection.stats.nodesScanned, 50_000);
  assert.equal(projection.stats.edgesScanned, 100_000);
  assert.equal(projection.stats.maxRetainedNodes <= 400, true);
  assert.equal(projection.stats.maxRetainedEdges <= 1_600, true);
  assert.equal(projection.stats.maxRetainedBytes <= 64 * 1024 * 1024, true);
  assert.equal(sourcePin.stats().recordsConsumed, 150_000);
  assert.equal(projection.sourceRevision, 7);
  assert.equal(projection.sourceEvidence.operation, 'query_projection');
  assert.deepEqual(projection.sourceEvidence.returnedTotals, {
    nodes: projection.nodes.length,
    edges: projection.edges.length,
  });
  assert.equal(projection.sourceEvidence.completeCoverage, true);
  assert.equal(projection.nodes.some(node => String(node.content).includes('bounded canary')), true);
});

test('oversized and unserializable records fail closed', async () => {
  const oversized = createSyntheticPinnedSource({
    nodeCount: 1,
    edgeCount: 0,
    nodeFactory: () => ({ id: 'n0', content: 'x'.repeat(257 * 1024) }),
  });
  await assert.rejects(projectPinnedQuery({
    sourcePin: oversized,
    query: 'x',
    signal: new AbortController().signal,
  }), error => error.code === 'result_too_large');

  const circularNode = { id: 'n0' };
  circularNode.self = circularNode;
  const unserializable = createSyntheticPinnedSource({
    nodeCount: 1,
    edgeCount: 0,
    nodeFactory: () => circularNode,
  });
  await assert.rejects(projectPinnedQuery({
    sourcePin: unserializable,
    query: 'x',
    signal: new AbortController().signal,
  }), error => error.code === 'source_invalid');
});

test('aggregate retained bytes keep the deterministic best fitting subset and disclose truncation', async () => {
  const sourceOptions = {
    nodeCount: 300,
    edgeCount: 0,
    nodeFactory: index => ({ id: `n${index}`, content: `x${'y'.repeat(64 * 1024)}` }),
  };
  const project = sourcePin => projectPinnedQuery({
    sourcePin,
    query: 'x',
    signal: new AbortController().signal,
    limits: { maxProjectionBytes: 2 * 1024 * 1024 },
  });

  const projection = await project(createSyntheticPinnedSource(sourceOptions));
  const repeated = await project(createSyntheticPinnedSource(sourceOptions));

  assert.equal(projection.nodes.length > 0 && projection.nodes.length < 300, true);
  assert.deepEqual(projection.nodes.map(node => node.id), repeated.nodes.map(node => node.id));
  assert.equal(projection.stats.retainedBytes <= 2 * 1024 * 1024, true);
  assert.equal(projection.stats.byteBudgetTruncated, true);
  assert.equal(projection.stats.droppedForByteBudget > 0, true);
  assert.equal(projection.sourceEvidence.byteBudgetTruncated, true);
  assert.equal(
    projection.sourceEvidence.droppedForByteBudget,
    projection.stats.droppedForByteBudget,
  );
});

test('live-shaped small topK query scans large records and retains the highest-ranked fitting candidates', async () => {
  const nodeCount = 2_048;
  const content = `live canary ${'z'.repeat(48 * 1024)}`;
  const records = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index}`,
    content,
    salience: index / (nodeCount - 1),
  }));
  const largestRecordBytes = Math.max(
    ...records.map(record => Buffer.byteLength(JSON.stringify(record), 'utf8')),
  );
  const maxProjectionBytes = largestRecordBytes * 2;
  const projection = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount,
      edgeCount: 0,
      nodeFactory: index => records[index],
    }),
    query: 'live canary',
    signal: new AbortController().signal,
    limits: {
      maxNodes: 8,
      maxEdges: 1,
      maxRecordBytes: 64 * 1024,
      maxProjectionBytes,
    },
  });

  assert.deepEqual(projection.nodes.map(node => node.id), ['n2047', 'n2046']);
  assert.equal(projection.stats.nodesScanned, nodeCount);
  assert.equal(projection.stats.nodesRetained, 2);
  assert.equal(projection.stats.retainedBytes <= maxProjectionBytes, true);
  assert.equal(projection.stats.byteBudgetTruncated, true);
  assert.equal(projection.stats.droppedForByteBudget > 0, true);
});

test('projection fails closed when no valid candidate fits the aggregate byte budget', async () => {
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: 2,
    edgeCount: 0,
    nodeFactory: index => ({ id: `n${index}`, content: 'x'.repeat(8 * 1024) }),
  });
  await assert.rejects(projectPinnedQuery({
    sourcePin,
    query: 'x',
    signal: new AbortController().signal,
    limits: { maxRecordBytes: 16 * 1024, maxProjectionBytes: 1024 },
  }), error => error.code === 'result_too_large');
});

test('projection cancellation preserves the exact caller reason', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel projection'), { code: 'cancelled' });
  const sourcePin = createSyntheticPinnedSource({ nodeCount: 100_000, edgeCount: 0 });
  const pending = projectPinnedQuery({
    sourcePin,
    query: 'canary',
    signal: controller.signal,
    limits: { maxNodes: 400, maxEdges: 1_600 },
    onNodeScanned(count) {
      if (count === 10_000) controller.abort(reason);
    },
  });

  await assert.rejects(pending, error => error === reason);
  assert.equal(sourcePin.stats().recordsConsumed, 10_000);
});

test('CPU-ready projection yields so external cancellation is observed by identity', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('external cancel projection'), { code: 'cancelled' });
  const sourcePin = createSyntheticPinnedSource({ nodeCount: 100_000, edgeCount: 100_000 });
  setImmediate(() => controller.abort(reason));

  await assert.rejects(projectPinnedQuery({
    sourcePin,
    query: 'canary',
    signal: controller.signal,
    limits: { maxNodes: 400, maxEdges: 1_600 },
  }), error => error === reason);
  assert.equal(sourcePin.stats().recordsConsumed < 200_000, true);
});

test('trusted limit overrides may lower but never raise production ceilings', () => {
  assert.equal(boundedLimits({ maxNodes: 1 }).maxNodes, 1);
  assert.throws(
    () => boundedLimits({ maxNodes: QUERY_OPERATION_LIMITS.maxNodes + 1 }),
    error => error.code === 'invalid_request',
  );
  assert.throws(
    () => boundedLimits({ maxNodes: 1, invented: 1 }),
    error => error.code === 'invalid_request',
  );
});

test('edge records are retained only when both endpoints are selected', async () => {
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: 3,
    edgeCount: 3,
    nodeFactory: index => ({
      id: `n${index}`,
      content: index < 2 ? `canary ${index}` : 'unrelated',
      salience: index < 2 ? 1 : 0,
    }),
    edgeFactory: index => [
      { source: 'n0', target: 'n1', type: 'kept' },
      { source: 'n0', target: 'n2', type: 'dropped' },
      { source: 'missing', target: 'n1', type: 'dropped' },
    ][index],
  });
  const projection = await projectPinnedQuery({
    sourcePin,
    query: 'canary',
    signal: new AbortController().signal,
    limits: { maxNodes: 2, maxEdges: 3 },
  });

  assert.deepEqual(projection.nodes.map(node => node.id).sort(), ['n0', 'n1']);
  assert.deepEqual(projection.edges, [{ source: 'n0', target: 'n1', type: 'kept' }]);
});
