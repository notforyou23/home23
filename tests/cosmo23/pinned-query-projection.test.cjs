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
  assert.equal(projection.nodes.some(node => String(node.content).includes('bounded canary')), true);
});

test('oversized records and aggregate retained bytes fail closed', async () => {
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

  const aggregate = createSyntheticPinnedSource({
    nodeCount: 300,
    edgeCount: 0,
    nodeFactory: index => ({ id: `n${index}`, content: `x${'y'.repeat(64 * 1024)}` }),
  });
  await assert.rejects(projectPinnedQuery({
    sourcePin: aggregate,
    query: 'x',
    signal: new AbortController().signal,
    limits: { maxProjectionBytes: 2 * 1024 * 1024 },
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
