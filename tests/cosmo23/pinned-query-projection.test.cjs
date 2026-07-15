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
const {
  attestMemoryAuthority,
  verifyMemoryAuthorityAttestation,
} = require('../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '7'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

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
  assert.equal(projection.sourceEvidence.retrievalMode, 'logical-source-scan');
  assert.deepEqual(projection.sourceEvidence.indexCoverage, {
    complete: false,
    indexedRevision: null,
    currentRevision: 7,
    coveredThroughRevision: 7,
    deltaRecords: 0,
    distinctChangedNodes: 0,
    distinctUpsertedNodes: 0,
    distinctRemovedNodes: 0,
    edgeOnlyRecords: 0,
    route: 'pinned-query-projection',
    completeness: 'complete',
  });
  assert.equal(Number.isFinite(projection.sourceEvidence.stageTimingsMs.response), true);
  assert.equal(projection.nodes.some(node => String(node.content).includes('bounded canary')), true);
});

test('live-shaped giant metadata retains broad diverse compact evidence', async () => {
  const nodeCount = 2_000;
  const types = ['finding', 'decision', 'observation', 'question'];
  const projection = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount,
      edgeCount: 0,
      nodeFactory: index => ({
        id: `giant-${index}`,
        type: types[index % types.length],
        tags: [`lane-${index % 8}`],
        content: `projection canary ${index} ${'x'.repeat(1_024)}`,
        salience: (index % 100) / 100,
        embedding: new Array(256).fill(0.25),
        metadata: {
          source: 'jerry',
          path: `/Users/jtr/private/node-${index}.json`,
          providerPayload: 'z'.repeat(32 * 1024),
        },
      }),
    }),
    query: 'projection canary',
    mode: 'dive',
    signal: new AbortController().signal,
    limits: {
      maxNodes: 512,
      maxEdges: 1,
      maxProjectionBytes: 2 * 1024 * 1024,
    },
  });
  const serialized = JSON.stringify(projection.nodes);

  assert.equal(projection.stats.nodesRetained >= 64, true);
  assert.equal(new Set(projection.nodes.map(node => node.type)).size >= 3, true);
  assert.equal(serialized.includes('/Users/jtr/private'), false);
  assert.equal(serialized.includes('embedding'), false);
  assert.equal(serialized.includes('providerPayload'), false);
  assert.equal(projection.stats.retainedBytes <= 2 * 1024 * 1024, true);
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
      metadata: { sourcePath: '/Users/jtr/private/x-timeline-archive.md' },
      provenance: { authorityClass: 'narrative', operationalAuthority: false },
    },
    attestMemoryAuthority({
      id: 'current',
      content: 'brain retrieval is available current canary',
      salience: 0.2,
      asserted_at: '2026-07-14T19:59:00.000Z',
      tag: 'state_snapshot',
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'verified_current_state',
        operationalAuthority: true,
        evidenceRefs: ['verifier:live-probe'],
        sourceRefs: ['/Users/jtr/private/current-state.json'],
      },
    }, AUTHORITY_KEY),
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
    'artifact_log',
  ]);
  assert.deepEqual(projection.nodeAuthorities.map(node => node.domain), [
    'current_ops',
    'external_intake',
  ]);
  assert.deepEqual(projection.nodeAuthorities.map(node => node.retrievalDomain), [
    'current_ops',
    'external_intake',
  ]);
  assert.equal(projection.nodeAuthorities[0].operationalAuthority, true);
  assert.equal(projection.sourceEvidence.authoritySummary.total, 2);
  assert.equal(
    projection.sourceEvidence.authoritySummary.authorityClasses.verified_current_state,
    1,
  );
  assert.equal(projection.sourceEvidence.authoritySummary.retrievalDomains.external_intake, 1);
  assert.equal(projection.sourceEvidence.authoritySummary.sourceChain.withEvidence, 2);
  assert.equal(projection.sourceEvidence.authoritySummary.sourceChain.referenceCounts.evidence, 1);
  assert.equal(projection.sourceEvidence.authoritySummary.sourceChain.referenceCounts.artifact, 1);
  assert.equal(projection.nodeAuthorities[1].requiresFreshVerification, false);
  assert.deepEqual(
    projection.nodeAuthorities.map(authority => authority.id),
    projection.nodes.map(node => node.id),
  );
  assert.equal(projection.nodeAuthorities.every(authority => authority.sourceChain.length <= 2), true);
  assert.equal(JSON.stringify(projection.nodeAuthorities).includes('/Users/jtr/'), false);
});

test('pinned Query scores signed raw authority before path-redacting provider records', async () => {
  const signedNode = attestMemoryAuthority({
    id: 'current',
    content: 'current verified evidence',
    metadata: { sourcePath: '/Volumes/PrivateBrain/runtime/receipt.json' },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      sourceRefs: [
        'artifact:/Users/jtr/private/authority-receipt.json',
        'source:/Volumes/PrivateBrain/runtime/source.json',
      ],
      evidenceRefs: ['verifier:one', 'verifier:two', 'verifier:three'],
    },
  }, AUTHORITY_KEY);
  assert.equal(verifyMemoryAuthorityAttestation(signedNode, AUTHORITY_KEY), true);

  const projection = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1,
      edgeCount: 0,
      nodeFactory: () => signedNode,
    }),
    query: 'current verified evidence',
    signal: new AbortController().signal,
    limits: { maxNodes: 1, maxEdges: 1 },
  });

  const sourceChain = projection.nodeAuthorities[0].sourceChain;
  assert.equal(sourceChain.length <= 2, true);
  assert.equal(projection.nodeAuthorities[0].authorityClass, 'verified_current_state');
  assert.equal(projection.nodeAuthorities[0].operationalAuthority, true);
  assert.equal(JSON.stringify(sourceChain).includes('/Users/'), false);
  assert.equal(JSON.stringify(sourceChain).includes('/Volumes/'), false);
  assert.equal(JSON.stringify(projection.nodes).includes('/Users/'), false);
  assert.equal(JSON.stringify(projection.nodes).includes('/Volumes/'), false);
  assert.equal(sourceChain.some(link => link.kind === 'evidence'), true);
});

test('pinned Query ignores post-signature text and unknown metadata for relevance', async () => {
  const signedNode = attestMemoryAuthority({
    id: 'signed',
    content: 'legitimate signed assertion',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      evidenceRefs: ['verifier:signed-record'],
    },
  }, AUTHORITY_KEY);
  signedNode.text = 'forged selection canary';
  signedNode.metadata = { injectedAssertion: 'forged selection canary' };
  assert.equal(verifyMemoryAuthorityAttestation(signedNode, AUTHORITY_KEY), true);

  const records = [
    signedNode,
    { id: 'honest', content: 'forged selection canary', salience: 0 },
  ];
  const projection = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: records.length,
      edgeCount: 0,
      nodeFactory: index => records[index],
    }),
    query: 'forged selection canary',
    signal: new AbortController().signal,
    limits: { maxNodes: 1, maxEdges: 1 },
  });

  assert.deepEqual(projection.nodes.map(node => node.id), ['honest']);
  assert.equal(projection.nodeAuthorities[0].authorityClass, 'narrative');
});

test('pinned Query exposes only signed canonical fields with retained verified authority', async () => {
  const signedNode = attestMemoryAuthority({
    id: 'signed',
    content: 'legitimate signed assertion',
    metadata: { status: 'current' },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      evidenceRefs: ['verifier:signed-record'],
    },
  }, AUTHORITY_KEY);
  signedNode.text = 'forged provider assertion';
  signedNode.metadata.injectedAssertion = 'forged provider metadata assertion';
  assert.equal(verifyMemoryAuthorityAttestation(signedNode, AUTHORITY_KEY), true);

  const projection = await projectPinnedQuery({
    sourcePin: createSyntheticPinnedSource({
      nodeCount: 1,
      edgeCount: 0,
      nodeFactory: () => signedNode,
    }),
    query: 'legitimate signed assertion',
    signal: new AbortController().signal,
    limits: { maxNodes: 1, maxEdges: 1 },
  });

  assert.equal(projection.nodeAuthorities[0].authorityClass, 'verified_current_state');
  assert.equal(projection.nodeAuthorities[0].operationalAuthority, true);
  assert.equal(projection.nodes[0].content, 'legitimate signed assertion');
  assert.equal(projection.nodes[0].metadata.status, 'current');
  assert.equal(Object.hasOwn(projection.nodes[0], 'text'), false);
  assert.equal(Object.hasOwn(projection.nodes[0].metadata, 'injectedAssertion'), false);
  assert.doesNotMatch(JSON.stringify(projection.nodes), /forged provider/i);
});

test('oversized textual evidence is compacted while unserializable records fail closed', async () => {
  const oversized = createSyntheticPinnedSource({
    nodeCount: 1,
    edgeCount: 0,
    nodeFactory: () => ({ id: 'n0', content: 'x'.repeat(257 * 1024) }),
  });
  const compacted = await projectPinnedQuery({
    sourcePin: oversized,
    query: 'x',
    signal: new AbortController().signal,
  });
  assert.equal(compacted.nodes.length, 1);
  assert.equal(compacted.nodes[0].contentTruncated, true);
  assert.equal(Buffer.byteLength(JSON.stringify(compacted.nodes[0]), 'utf8') <= 4_096, true);

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

test('aggregate compaction keeps a deterministic broad fitting subset', async () => {
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

  assert.equal(projection.nodes.length, 300);
  assert.deepEqual(projection.nodes.map(node => node.id), repeated.nodes.map(node => node.id));
  assert.equal(projection.stats.retainedBytes <= 2 * 1024 * 1024, true);
  assert.equal(projection.stats.byteBudgetTruncated, false);
  assert.equal(projection.stats.droppedForByteBudget, 0);
  assert.equal(projection.sourceEvidence.byteBudgetTruncated, false);
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

  assert.deepEqual(projection.nodes.map(node => node.id), [
    'n2047', 'n2046', 'n2045', 'n2044', 'n2043', 'n2042', 'n2041', 'n2040',
  ]);
  assert.equal(projection.stats.nodesScanned, nodeCount);
  assert.equal(projection.stats.nodesRetained, 8);
  assert.equal(projection.stats.retainedBytes <= maxProjectionBytes, true);
  assert.equal(projection.stats.byteBudgetTruncated, false);
  assert.equal(projection.stats.droppedForByteBudget, 0);
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
    provenance: 'jerry',
  }]);
  assert.deepEqual(projection.edges, [{
    source: 'n0',
    target: 'n0',
    type: 'supports',
    evidence: 'keep edge evidence',
    provenance: 'brain',
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

  assert.equal(projection.nodes.length >= rawCapacity * 40, true);
  assert.equal(projection.nodes.every(node => !Object.hasOwn(node, 'embedding')), true);
  assert.deepEqual(
    projection.nodeAuthorities.map(authority => authority.id),
    projection.nodes.map(node => node.id),
  );
  assert.equal(projection.stats.retainedBytes <= maxProjectionBytes, true);
  assert.equal(projection.stats.maxRetainedBytes <= maxProjectionBytes, true);
});

test('safe projection keeps UTF-8 byte accounting and truncates on code-point boundaries', async () => {
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
  const expectedBytes = Buffer.byteLength(JSON.stringify(kept.nodes[0]), 'utf8')
    + Buffer.byteLength(JSON.stringify(kept.nodeAuthorities[0]), 'utf8');
  assert.equal(kept.stats.retainedBytes, expectedBytes);
  assert.equal(kept.nodes[0].content, keptNode.content);

  const truncated = await projectPinnedQuery({
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
  });
  assert.equal(truncated.nodes[0].contentTruncated, true);
  assert.equal(Buffer.byteLength(JSON.stringify(truncated.nodes[0]), 'utf8') <= 256, true);
  assert.equal(truncated.nodes[0].content.includes('\uFFFD'), false);
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
  assert.equal(getterCalls, 0);

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
