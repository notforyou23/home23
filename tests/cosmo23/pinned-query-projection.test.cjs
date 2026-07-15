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

test('pinned Query ranks current verified evidence above freshly reingested archive text', async () => {
  const now = '2026-07-14T20:00:00.000Z';
  const records = [
    {
      id: 'archive',
      content: 'brain retrieval is unavailable archive canary',
      salience: 1,
      created: now,
      source_event_at: '2025-01-01T00:00:00.000Z',
      metadata: { sourcePath: 'workspace/reports/x-timeline-archive.md' },
      provenance: { authorityClass: 'narrative', operationalAuthority: false },
    },
    {
      id: 'current',
      content: 'brain retrieval is available current canary',
      salience: 0.2,
      asserted_at: '2026-07-14T19:59:00.000Z',
      tag: 'state_snapshot',
      provenance: {
        authorityClass: 'verified_current_state',
        operationalAuthority: true,
        evidenceRefs: ['verifier:live-probe'],
      },
    },
  ];
  const projection = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: records.length,
      edgeCount: 0,
      nodeFactory: index => records[index],
    }),
    query: 'brain retrieval canary',
    signal: new AbortController().signal,
    limits: { maxNodes: 2, maxEdges: 1 },
    nowMs: Date.parse(now),
  });

  assert.deepEqual(projection.nodes.map(node => node.id), ['current', 'archive']);
  assert.deepEqual(projection.nodeAuthorities.map(node => node.authorityClass), [
    'verified_current_state',
    'narrative',
  ]);
  assert.deepEqual(projection.nodeAuthorities.map(node => node.domain), [
    'current_ops',
    'external_intake',
  ]);
  assert.equal(projection.nodeAuthorities[0].operationalAuthority, true);
  assert.equal(projection.nodeAuthorities[1].requiresFreshVerification, true);
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

test('Jerry-shaped large records retain a deterministic score-ranked subset within byte budget', async () => {
  async function project() {
    const sourcePin = createSyntheticPinnedSource({
      nodeCount: 5_000,
      edgeCount: 20_000,
      nodeFactory: index => ({
        id: `n${index}`,
        content: `jerry canary ${index} ${'x'.repeat(20 * 1024)}`,
        salience: (index % 100) / 100,
      }),
      edgeFactory: index => ({
        source: `n${index % 5_000}`,
        target: `n${(index + 1) % 5_000}`,
        type: 'jerry-shaped-edge',
      }),
    });
    const projection = await projectPinnedQuery({
      sourcePin,
      query: 'jerry canary',
      signal: new AbortController().signal,
      limits: { maxProjectionBytes: 8 * 1024 * 1024 },
    });
    return { projection, sourcePin };
  }

  const first = await project();
  const second = await project();
  assert.equal(first.projection.nodes.length > 0, true);
  assert.equal(first.projection.nodes.length < 4_000, true);
  assert.equal(first.projection.stats.maxRetainedBytes <= 8 * 1024 * 1024, true);
  assert.equal(first.projection.stats.retainedBytes <= 8 * 1024 * 1024, true);
  assert.equal(first.projection.stats.nodesScanned, 5_000);
  assert.equal(first.projection.stats.edgesScanned, 20_000);
  assert.equal(first.sourcePin.stats().recordsConsumed, 25_000);
  assert.deepEqual(
    first.projection.nodes.map(node => node.id),
    second.projection.nodes.map(node => node.id),
  );
});

test('known numeric vector payload fields are omitted without mutating evidence records', async () => {
  const node = {
    id: 'n0',
    content: 'projection density canary evidence',
    salience: 0.95,
    embedding: [0.1, 0.2],
    embeddings: [[0.3, 0.4]],
    vector: [0.5, 0.6],
    vectors: [[0.7, 0.8]],
    embeddingModel: 'keep-this-model-metadata',
    vectorEvidence: 'keep-this-evidence-field',
    metadata: {
      source: 'jerry',
      embedding: [0.9, 1],
      nested: {
        vectors: [[1.1, 1.2]],
        vector: 'textual evidence using the field name vector',
        note: 'keep nested metadata',
      },
    },
  };
  const edge = {
    source: 'n0',
    target: 'n0',
    type: 'supports',
    evidence: 'keep edge evidence',
    embedding: [0.1],
    vector: [0.2],
    metadata: { provenance: 'brain', embeddings: [[0.3]], keep: true },
  };
  const sourceBefore = JSON.parse(JSON.stringify({ node, edge }));
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: 1,
    edgeCount: 1,
    nodeFactory: () => node,
    edgeFactory: () => edge,
  });

  const projection = await projectPinnedQuery({
    sourcePin,
    query: 'projection density canary',
    signal: new AbortController().signal,
  });

  assert.deepEqual(projection.nodes, [{
    id: 'n0',
    content: 'projection density canary evidence',
    salience: 0.95,
    embeddingModel: 'keep-this-model-metadata',
    vectorEvidence: 'keep-this-evidence-field',
    metadata: {
      source: 'jerry',
      nested: {
        vector: 'textual evidence using the field name vector',
        note: 'keep nested metadata',
      },
    },
  }]);
  assert.deepEqual(projection.edges, [{
    source: 'n0',
    target: 'n0',
    type: 'supports',
    evidence: 'keep edge evidence',
    metadata: { provenance: 'brain', keep: true },
  }]);
  assert.deepEqual({ node, edge }, sourceBefore);
});

test('safe projection applies record and aggregate limits after removing vector payloads', async () => {
  const nodeCount = 80;
  const vector = new Array(1_024).fill(0.123456);
  const sampleRaw = {
    id: 'n0', content: 'density canary evidence 0', salience: 1,
    metadata: { source: 'jerry' }, embedding: vector,
  };
  const maxProjectionBytes = 16 * 1024;
  const rawRecordBytes = Buffer.byteLength(JSON.stringify(sampleRaw), 'utf8');
  const rawCapacity = Math.floor(maxProjectionBytes / rawRecordBytes);
  assert.equal(rawRecordBytes > 8 * 1024, true);
  assert.equal(rawCapacity, 1);
  const sourcePin = createSyntheticPinnedSource({
    nodeCount,
    edgeCount: 0,
    nodeFactory: index => ({
      id: `n${index}`,
      content: `density canary evidence ${index}`,
      salience: 1,
      metadata: { source: 'jerry' },
      embedding: vector,
    }),
  });

  const projection = await projectPinnedQuery({
    sourcePin,
    query: 'density canary',
    signal: new AbortController().signal,
    limits: { maxNodes: nodeCount, maxRecordBytes: 512, maxProjectionBytes },
  });

  assert.equal(projection.nodes.length, nodeCount);
  assert.equal(projection.nodes.length >= rawCapacity * 40, true);
  assert.equal(projection.nodes.every(node => !Object.hasOwn(node, 'embedding')), true);
  assert.equal(projection.stats.retainedBytes <= maxProjectionBytes, true);
  assert.equal(projection.stats.maxRetainedBytes <= maxProjectionBytes, true);
});

test('safe projection keeps UTF-8 byte accounting and rejects oversized remaining evidence', async () => {
  const keptNode = {
    id: 'unicode-kept',
    content: `unicode ${'🧠'.repeat(20)}`,
    embedding: new Array(2_000).fill(0.25),
  };
  const kept = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1, edgeCount: 0, nodeFactory: () => keptNode,
    }),
    query: 'unicode',
    signal: new AbortController().signal,
    limits: { maxRecordBytes: 256, maxProjectionBytes: 512 },
  });
  const expectedBytes = Buffer.byteLength(JSON.stringify({
    id: keptNode.id, content: keptNode.content,
  }), 'utf8');
  assert.equal(kept.stats.retainedBytes, expectedBytes);
  assert.equal(kept.nodes[0].content, keptNode.content);

  await assert.rejects(projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1,
      edgeCount: 0,
      nodeFactory: () => ({
        id: 'unicode-too-large',
        content: `unicode ${'🧠'.repeat(100)}`,
        embedding: new Array(2_000).fill(0.25),
      }),
    }),
    query: 'unicode',
    signal: new AbortController().signal,
    limits: { maxRecordBytes: 256, maxProjectionBytes: 512 },
  }), error => error.code === 'result_too_large');
});

test('vector sanitization does not bypass dangerous accessors or nonserializable evidence', async () => {
  let getterCalls = 0;
  const accessorNode = { id: 'accessor', content: 'canary' };
  Object.defineProperty(accessorNode, 'embedding', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('dangerous embedding getter');
    },
  });
  await assert.rejects(projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1, edgeCount: 0, nodeFactory: () => accessorNode,
    }),
    query: 'canary',
    signal: new AbortController().signal,
  }), error => error.code === 'source_invalid');
  assert.equal(getterCalls, 1);

  const circularEmbedding = [];
  circularEmbedding.push(circularEmbedding);
  await assert.rejects(projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1,
      edgeCount: 0,
      nodeFactory: () => ({
        id: 'circular-embedding', content: 'canary', embedding: circularEmbedding,
      }),
    }),
    query: 'canary',
    signal: new AbortController().signal,
  }), error => error.code === 'source_invalid');

  const circularMetadata = { provenance: 'brain' };
  circularMetadata.self = circularMetadata;
  await assert.rejects(projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1,
      edgeCount: 0,
      nodeFactory: () => ({
        id: 'circular', content: 'canary', embedding: [0.1], metadata: circularMetadata,
      }),
    }),
    query: 'canary',
    signal: new AbortController().signal,
  }), error => error.code === 'source_invalid');
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

test('edge byte pressure skips later edges while completing the full source scan', async () => {
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: 2,
    edgeCount: 20,
    nodeFactory: index => ({ id: `n${index}`, content: `canary ${index}` }),
    edgeFactory: index => ({
      source: 'n0',
      target: 'n1',
      type: `edge-${index}`,
      evidence: 'x'.repeat(400),
    }),
  });
  const projection = await projectPinnedQuery({
    sourcePin,
    query: 'canary',
    signal: new AbortController().signal,
    limits: { maxProjectionBytes: 2 * 1024 },
  });

  assert.equal(projection.edges.length > 0, true);
  assert.equal(projection.edges.length < 20, true);
  assert.equal(projection.stats.edgesScanned, 20);
  assert.equal(sourcePin.stats().recordsConsumed, 22);
  assert.equal(projection.stats.retainedBytes <= 2 * 1024, true);
});
