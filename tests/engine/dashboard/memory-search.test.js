import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  openMemorySource,
  readManifest,
  rewriteMemoryBase,
  appendMemoryRevision,
} = require('../../../shared/memory-source');
const {
  createMemorySearchService,
} = require('../../../engine/src/dashboard/memory-search');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const lockRoots = new Map();

async function createBrain({ nodes = [], edges = [] } = {}) {
  const dir = await tempDir('home23-memory-search-brain-');
  const runtime = await tempDir('home23-memory-search-runtime-');
  const lockRoot = path.join(runtime, 'runtime', 'brain-source-locks');
  lockRoots.set(dir, lockRoot);
  await rewriteMemoryBase(dir, {
    nodes,
    edges,
    summary: { nodeCount: nodes.length, edgeCount: edges.length, clusterCount: nodes.length ? 1 : 0 },
  }, { lockRoot });
  return dir;
}

async function appendRevision(dir, changes, summary) {
  return appendMemoryRevision(dir, changes, {
    lockRoot: lockRoots.get(dir),
    summary,
  });
}

async function markAnn(dir, { builtFromRevision, indexFile = 'memory-ann.test.index', metaFile = 'memory-ann.test.meta.json' } = {}) {
  await fsp.writeFile(path.join(dir, indexFile), 'index');
  await fsp.writeFile(path.join(dir, metaFile), '{}');
  const manifest = JSON.parse(JSON.stringify(await readManifest(dir)));
  manifest.ann = {
    indexFile,
    metaFile,
    builtFromRevision: builtFromRevision ?? manifest.currentRevision,
  };
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function sourceSearch({ dir, embedQuery, loadAnn, query = 'canary', request = {} }) {
  const source = await openMemorySource(dir);
  const service = createMemorySearchService({
    brainDir: dir,
    embedQuery,
    loadAnn,
    logger: { warn() {} },
  });
  try {
    return await service.search({
      sourcePin: source,
      identity: { operationId: 'test-search', requesterAgent: 'jerry', brainId: 'jerry' },
      query,
      topK: 5,
      minSimilarity: 0.1,
      noiseFloor: 0.1,
      ...request,
    });
  } finally {
    await source.close();
  }
}

test('stale ANN cannot hide a new delta keyword canary', async () => {
  const dir = await createBrain({
    nodes: [{ id: 'old', concept: 'old semantic', embedding: [0, 1] }],
  });
  const base = await readManifest(dir);
  await markAnn(dir, { builtFromRevision: base.currentRevision });
  await appendRevision(dir, {
    nodes: [{ id: 'canary', concept: 'route-watermark-canary', embedding: [1, 0] }],
  }, { nodeCount: 2, edgeCount: 0, clusterCount: 1 });
  const result = await sourceSearch({
    dir,
    query: 'route-watermark-canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => ({ dimension: 2, search: () => [] }),
  });
  assert.equal(result.results[0].id, 'canary');
  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.equal(result.evidence.matchOutcome, 'matches');
  assert.equal(result.evidence.indexWatermark.fresh, false);
  assert.equal(result.evidence.fallback.route, 'logical-source-scan');
  assert.equal(result.evidence.fallback.reason, 'ann_stale');
});

test('a delta tombstone suppresses an ANN label', async () => {
  const dir = await createBrain({
    nodes: [{ id: 'deleted', concept: 'deleted canary', embedding: [1, 0] }],
  });
  const base = await readManifest(dir);
  await markAnn(dir, { builtFromRevision: base.currentRevision });
  await appendRevision(dir, {
    removedNodeIds: ['deleted'],
  }, { nodeCount: 0, edgeCount: 0, clusterCount: 0 });
  const result = await sourceSearch({
    dir,
    query: 'deleted canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => ({
      dimension: 2,
      search: () => [{ node: { id: 'deleted', concept: 'deleted canary', embedding: [1, 0] }, similarity: 1 }],
    }),
  });
  assert.equal(result.results.some((row) => row.id === 'deleted'), false);
  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.equal(result.evidence.matchOutcome, 'unknown');
});

test('dimension mismatch and embedding failure use keyword retrieval', async () => {
  const dir = await createBrain({
    nodes: [{ id: 'keyword', concept: 'keyword canary', embedding: [1, 0] }],
  });
  await markAnn(dir);
  const mismatch = await sourceSearch({
    dir,
    query: 'keyword canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => ({ dimension: 3, search: () => [] }),
  });
  assert.equal(mismatch.evidence.fallback.reason, 'embedding_dimension_mismatch');

  const unavailable = await sourceSearch({
    dir,
    query: 'keyword canary',
    embedQuery: async () => { throw new Error('offline'); },
    loadAnn: async () => null,
  });
  assert.equal(unavailable.results[0].retrievalMode, 'keyword');
  assert.equal(unavailable.evidence.fallback.reason, 'embedding_unavailable');
});

test('semantic vectors and final merged response are byte bounded', async () => {
  const dir = await createBrain({
    nodes: [{ id: 'x', concept: 'big canary', embedding: [1, 0] }],
  });
  await assert.rejects(
    () => sourceSearch({
      dir,
      query: 'big canary',
      embedQuery: async () => new Array(8193).fill(0),
      loadAnn: async () => null,
    }),
    (error) => error.code === 'result_too_large',
  );
  const malformed = await sourceSearch({
    dir,
    query: 'big canary',
    embedQuery: async () => [1, NaN],
    loadAnn: async () => null,
  });
  assert.equal(malformed.evidence.fallback.reason, 'embedding_invalid');
});

test('noise-filtered semantic candidates are supplemented by exact keyword results', async () => {
  const dir = await createBrain({
    nodes: [{ id: 'exact', concept: 'exact-canary', embedding: [1, 0] }],
  });
  const result = await sourceSearch({
    dir,
    query: 'exact-canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
    request: { minSimilarity: 0.1, noiseFloor: 1.1 },
  });
  assert.equal(result.results.some((row) => row.concept.includes('exact-canary')), true);
  assert.equal(result.evidence.fallback.reason, 'ann_missing');
});

test('healthy empty, healthy no-match, and degraded unknown remain distinct', async () => {
  const emptyDir = await createBrain({ nodes: [] });
  const empty = await sourceSearch({
    dir: emptyDir,
    query: 'empty-canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
  });
  assert.equal(empty.evidence.matchOutcome, 'corpus_empty');

  const noMatchDir = await createBrain({ nodes: [{ id: 'other', concept: 'other', embedding: [0, 1] }] });
  const noMatch = await sourceSearch({
    dir: noMatchDir,
    query: 'absent-canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
  });
  assert.equal(noMatch.evidence.matchOutcome, 'no_match');

  const degradedSource = {
    manifest: null,
    revision: null,
    async summarize() { return { nodes: 0, edges: 0, clusters: 0 }; },
    async *iterateNodes() {},
    async searchKeyword() { return { results: [] }; },
    getEvidence(input = {}) {
      return {
        sourceHealth: input.sourceHealth || 'unavailable',
        matchOutcome: input.matchOutcome || 'unknown',
        indexWatermark: { fresh: false, builtFromRevision: null },
      };
    },
  };
  const service = createMemorySearchService({
    brainDir: emptyDir,
    embedQuery: async () => { throw new Error('offline'); },
    loadAnn: async () => null,
    logger: { warn() {} },
  });
  const degraded = await service.search({
    sourcePin: degradedSource,
    identity: { operationId: 'test-search' },
    query: 'anything',
  });
  assert.equal(degraded.evidence.matchOutcome, 'unknown');
});

test('search cancellation is never converted into embedding fallback or source unavailable', async () => {
  const controller = new AbortController();
  let recordsConsumed = 0;
  let fallbacksRecorded = 0;
  const source = {
    manifest: { formatVersion: 1, ann: { builtFromRevision: 1 }, currentRevision: 2 },
    revision: 2,
    async summarize() { return { nodes: 2, edges: 0, clusters: 0 }; },
    async *iterateNodes() {
      recordsConsumed += 1;
      controller.abort(Object.assign(new Error('stop'), { name: 'AbortError', code: 'cancelled' }));
      throw controller.signal.reason;
    },
    async searchKeyword() {
      fallbacksRecorded += 1;
      return { results: [] };
    },
    getEvidence(input = {}) {
      return {
        sourceHealth: input.sourceHealth || 'healthy',
        matchOutcome: input.matchOutcome || 'unknown',
        indexWatermark: { fresh: false, builtFromRevision: 1 },
      };
    },
  };
  const service = createMemorySearchService({
    brainDir: await tempDir('home23-memory-search-unused-'),
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
    logger: { warn() {} },
  });
  await assert.rejects(
    () => service.search({
      sourcePin: source,
      identity: { operationId: 'test-search' },
      query: 'canary',
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(recordsConsumed, 1);
  assert.equal(fallbacksRecorded, 0);
});

test('compatibility search derives canonical own-target identity and private scratch', async () => {
  const brainDir = await createBrain({ nodes: [{ id: 'canary', concept: 'canary', embedding: [1, 0] }] });
  const canonicalRoot = await fsp.realpath(brainDir);
  const requesterAgent = 'jerry';
  const target = {
    id: 'brain-jerry',
    ownerAgent: requesterAgent,
    canonicalRoot,
    kind: 'resident',
    sourceType: 'brain',
  };
  let resolveCalls = 0;
  let capturedOperationRoot = null;
  const service = createMemorySearchService({
    brainDir,
    home23Root: await tempDir('home23-memory-search-home-'),
    requesterAgent,
    resolveTargetContext: async () => {
      resolveCalls += 1;
      return { catalogRevision: 'catalog-1', accessMode: 'own', target };
    },
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
    logger: { warn() {} },
    withEphemeralSource: async (options, callback) => {
      capturedOperationRoot = path.join(options.home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations', 'dashboard-search-test');
      const source = await openMemorySource(brainDir);
      try {
        return await callback(source, {
          operationRoot: capturedOperationRoot,
          operationId: 'dashboard-search-test',
          identity: { ...options.identity, canonicalRoot, operationId: 'dashboard-search-test' },
        });
      } finally {
        await source.close();
      }
    },
  });
  const result = await service.search({ query: 'canary', topK: 5 });
  assert.equal(resolveCalls, 1);
  assert.equal(result.evidence.identity.requesterAgent, requesterAgent);
  assert.equal(result.evidence.identity.brainId, target.id);
  assert.match(result.evidence.identity.operationId, /^dashboard-search-/);
  assert.equal(capturedOperationRoot.startsWith(target.canonicalRoot), false);
  assert.equal(await fsp.access(capturedOperationRoot).then(() => true).catch(() => false), false);
  await assert.rejects(
    () => service.search({ query: 'canary', identity: { requesterAgent: 'mallory' } }),
    (error) => error.code === 'invalid_request',
  );
});
