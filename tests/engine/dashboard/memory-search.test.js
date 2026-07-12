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
  createDefaultEmbedQuery,
  createDefaultLoadAnn,
  createMemorySearchService,
  MAX_ANN_METADATA_BYTES,
} = require('../../../engine/src/dashboard/memory-search');
const {
  sendMemorySearchError,
} = require('../../../engine/src/dashboard/server');

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

async function fileSnapshot(dir) {
  const names = (await fsp.readdir(dir)).sort();
  const rows = {};
  for (const name of names) {
    if (!/^memory-/.test(name)) continue;
    const file = path.join(dir, name);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) continue;
    rows[name] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      bytes: await fsp.readFile(file, 'base64'),
    };
  }
  return rows;
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

test('healthy empty and healthy no-match remain distinct while unavailable fails truthfully', async () => {
  const emptyDir = await createBrain({ nodes: [] });
  const empty = await sourceSearch({
    dir: emptyDir,
    query: 'empty-canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
  });
  assert.equal(empty.evidence.matchOutcome, 'corpus_empty');
  assert.equal(empty.evidence.completeCoverage, true);

  const noMatchDir = await createBrain({ nodes: [{ id: 'other', concept: 'other', embedding: [0, 1] }] });
  const noMatch = await sourceSearch({
    dir: noMatchDir,
    query: 'absent-canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
  });
  assert.equal(noMatch.evidence.matchOutcome, 'no_match');
  assert.equal(noMatch.evidence.completeCoverage, true);

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
  await assert.rejects(
    () => service.search({
      sourcePin: degradedSource,
      identity: { operationId: 'test-search' },
      query: 'anything',
    }),
    (error) => error.code === 'source_unavailable'
      && error.status === 503
      && error.sourceEvidence?.matchOutcome === 'unknown',
  );
});

test('keyword fallback applies exact tags instead of merely claiming the filter', async () => {
  const dir = await createBrain({
    nodes: [
      { id: 'alpha', concept: 'shared route canary', tag: 'alpha' },
      { id: 'beta', concept: 'shared route canary', tag: 'beta' },
    ],
  });
  const result = await sourceSearch({
    dir,
    query: 'shared route canary',
    embedQuery: async () => { throw new Error('offline'); },
    loadAnn: async () => null,
    request: { tag: 'alpha' },
  });
  assert.deepEqual(result.results.map((row) => row.id), ['alpha']);
  assert.deepEqual(result.evidence.filters, { tag: 'alpha' });
  await assert.rejects(
    () => sourceSearch({
      dir,
      query: 'shared route canary',
      embedQuery: async () => null,
      loadAnn: async () => null,
      request: { tag: ' alpha ' },
    }),
    (error) => error.code === 'invalid_request' && error.field === 'tag',
  );
});

test('healthy complete tag-filtered zero reports filtered evidence instead of no match', async () => {
  const dir = await createBrain({
    nodes: [
      { id: 'beta-1', concept: 'filtered route canary', tag: 'beta' },
      { id: 'beta-2', concept: 'filtered route canary', tag: 'beta' },
    ],
  });
  const result = await sourceSearch({
    dir,
    query: 'filtered route canary',
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
    request: { tag: 'alpha' },
  });

  assert.deepEqual(result.results, []);
  assert.equal(result.evidence.sourceHealth, 'healthy');
  assert.equal(result.evidence.completeCoverage, true);
  assert.equal(result.evidence.filteredTotal, 2);
  assert.equal(result.evidence.matchOutcome, 'filtered');
});

test('default embedding transport forwards the exact AbortSignal', async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const embed = createDefaultEmbedQuery({
    getClient: () => ({
      embeddings: {
        async create(_parameters, options) {
          receivedSignal = options.signal;
          return { data: [{ embedding: [1, 0] }] };
        },
      },
    }),
  });
  assert.deepEqual(await embed('canary', { signal: controller.signal }), [1, 0]);
  assert.equal(receivedSignal, controller.signal);
  controller.abort(Object.assign(new Error('stop'), { name: 'AbortError', code: 'cancelled' }));
  await assert.rejects(() => embed('never sent', { signal: controller.signal }), {
    code: 'cancelled',
  });
});

test('default ANN loading derives files from the pinned target source, not requester brainDir', async () => {
  const requesterDir = await createBrain({ nodes: [{ id: 'requester', concept: 'wrong brain' }] });
  const targetDir = await createBrain({ nodes: [{ id: 'target', concept: 'target canary' }] });
  const manifest = await markAnn(targetDir);
  await fsp.writeFile(path.join(targetDir, manifest.ann.metaFile), JSON.stringify({
    dimension: 2,
    count: 0,
    skipped: 1,
    generation: manifest.generation,
    builtFromRevision: manifest.currentRevision,
    labels: [],
  }));
  const pathsRead = [];
  class FakeIndex {
    readIndexSync(filePath) { pathsRead.push(filePath); }
    setEf() {}
    searchKnn() { return { neighbors: [], distances: [] }; }
  }
  const source = await openMemorySource(targetDir);
  const service = createMemorySearchService({
    brainDir: requesterDir,
    embedQuery: async () => [1, 0],
    loadAnn: createDefaultLoadAnn({
      hnswlibLoader: () => ({ HierarchicalNSW: FakeIndex }),
    }),
    logger: { warn() {} },
  });
  try {
    const result = await service.search({
      sourcePin: source,
      identity: { operationId: 'cross-brain-ann', accessMode: 'read-only' },
      query: 'target canary',
      topK: 5,
      minSimilarity: 0.1,
      noiseFloor: 0.1,
    });
    assert.equal(result.results.some((row) => row.id === 'target'), true);
    assert.deepEqual(pathsRead, [path.join(await fsp.realpath(targetDir), manifest.ann.indexFile)]);
    assert.equal(pathsRead[0].startsWith(await fsp.realpath(requesterDir)), false);
  } finally {
    await source.close();
  }
});

test('default ANN loading consumes anchored handles without reopening target pathnames', async () => {
  const targetDir = await createBrain({ nodes: [{ id: 'target', concept: 'target canary' }] });
  const pathsRead = [];
  const stableRoles = [];
  class FakeIndex {
    readIndexSync(filePath) { pathsRead.push(filePath); }
    setEf() {}
  }
  const views = {
    'ann-index': {
      path: '/dev/fd/73',
      identity: { dev: '1', ino: '73', size: '4096' },
      async assertStable() { stableRoles.push('ann-index'); },
    },
    'ann-meta': {
      path: '/dev/fd/74',
      identity: { dev: '1', ino: '74', size: '140000000' },
      async readFile({ maxBytes }) {
        assert.equal(maxBytes, MAX_ANN_METADATA_BYTES);
        return Buffer.from(JSON.stringify({ dimension: 2, labels: [] }));
      },
      async assertStable() { stableRoles.push('ann-meta'); },
    },
  };
  const loadAnn = createDefaultLoadAnn({
    hnswlibLoader: () => ({ HierarchicalNSW: FakeIndex }),
  });
  const loaded = await loadAnn({
    descriptor: { canonicalRoot: await fsp.realpath(targetDir) },
    getAnchoredFile(role) { return views[role] || null; },
  }, { indexFile: 'ann.index', metaFile: 'ann.meta.json' });
  assert.equal(loaded.dimension, 2);
  assert.deepEqual(pathsRead, ['/dev/fd/73']);
  assert.deepEqual(stableRoles.sort(), ['ann-index', 'ann-meta']);
});

test('default ANN loading deduplicates concurrent immutable pinned loads and caches the result', async () => {
  const targetDir = await createBrain({ nodes: [{ id: 'target', concept: 'target canary' }] });
  let metadataReads = 0;
  let indexReads = 0;
  class FakeIndex {
    readIndexSync() { indexReads += 1; }
    setEf() {}
  }
  const views = {
    'ann-index': {
      path: '/dev/fd/83',
      identity: { dev: '1', ino: '83', size: '457000000' },
      async assertStable() {},
    },
    'ann-meta': {
      path: '/dev/fd/84',
      identity: { dev: '1', ino: '84', size: '140000000' },
      async readFile({ maxBytes }) {
        metadataReads += 1;
        assert.equal(maxBytes, MAX_ANN_METADATA_BYTES);
        return Buffer.from(JSON.stringify({ dimension: 2, labels: [] }));
      },
      async assertStable() {},
    },
  };
  const source = {
    descriptor: {
      canonicalRoot: await fsp.realpath(targetDir),
      generation: 'g-live',
      cutoffRevision: 42,
    },
    getAnchoredFile(role) { return views[role] || null; },
  };
  const loadAnn = createDefaultLoadAnn({
    hnswlibLoader: () => ({ HierarchicalNSW: FakeIndex }),
  });
  const annMeta = {
    indexFile: 'memory-ann.42.index',
    metaFile: 'memory-ann.42.meta.json',
    builtFromRevision: 42,
  };
  const [first, second] = await Promise.all([
    loadAnn(source, annMeta),
    loadAnn(source, annMeta),
  ]);
  const third = await loadAnn(source, annMeta);
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(metadataReads, 1);
  assert.equal(indexReads, 1);
});

test('unsupported ANN descriptor paths degrade to a complete logical semantic scan', async () => {
  const targetDir = await createBrain({
    nodes: [{ id: 'portable', concept: 'portable descriptor canary', embedding: [1, 0] }],
  });
  const source = {
    descriptor: { canonicalRoot: await fsp.realpath(targetDir) },
    manifest: {
      formatVersion: 1,
      currentRevision: 3,
      ann: { indexFile: 'ann.index', metaFile: 'ann.meta.json', builtFromRevision: 3 },
    },
    async summarize() { return { nodes: 1, edges: 0, clusters: 1 }; },
    async *iterateNodes() {
      yield { id: 'portable', concept: 'portable descriptor canary', embedding: [1, 0] };
    },
    async searchKeyword() { return { results: [] }; },
    getAnchoredFile(role) {
      if (role === 'ann-index') {
        return { path: null, async assertStable() {} };
      }
      if (role === 'ann-meta') {
        return {
          async readFile() {
            return Buffer.from(JSON.stringify({ dimension: 2, labels: [] }));
          },
          async assertStable() {},
        };
      }
      return null;
    },
    getEvidence(input = {}) {
      return {
        sourceHealth: input.sourceHealth || 'healthy',
        matchOutcome: input.matchOutcome || 'unknown',
        indexWatermark: { fresh: true, builtFromRevision: 3 },
      };
    },
  };
  const service = createMemorySearchService({
    brainDir: targetDir,
    embedQuery: async () => [1, 0],
    loadAnn: createDefaultLoadAnn({
      hnswlibLoader: () => assert.fail('unsupported descriptor path must not load ANN'),
    }),
    logger: { warn() {} },
  });

  const result = await service.search({
    sourcePin: source,
    identity: { operationId: 'portable-ann', requesterAgent: 'jerry' },
    query: 'portable descriptor canary',
    topK: 5,
    minSimilarity: 0.1,
    noiseFloor: 0.1,
  });
  assert.deepEqual(result.results.map((row) => row.id), ['portable']);
  assert.equal(result.results[0].retrievalMode, 'semantic-scan');
  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.deepEqual(result.evidence.fallback, {
    route: 'logical-source-scan',
    reason: 'ann_descriptor_unsupported',
    completeness: 'complete',
  });
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

test('read-only pinned source search leaves target memory files unchanged', async () => {
  const dir = await createBrain({ nodes: [{ id: 'canary', concept: 'read only canary', embedding: [1, 0] }] });
  await appendRevision(dir, {
    nodes: [{ id: 'delta', concept: 'read only delta canary', embedding: [1, 0] }],
  }, { nodeCount: 2, edgeCount: 0, clusterCount: 1 });
  const source = await openMemorySource(dir);
  const before = await fileSnapshot(dir);
  const service = createMemorySearchService({
    brainDir: dir,
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
    logger: { warn() {} },
  });

  try {
    const result = await service.search({
      sourcePin: source,
      identity: {
        operationId: 'read-only-search',
        requesterAgent: 'jerry',
        targetAgent: 'forrest',
        brainId: 'brain-forrest',
        accessMode: 'read-only',
      },
      query: 'read only canary',
      topK: 5,
      minSimilarity: 0.1,
      noiseFloor: 0.1,
    });
    assert.equal(result.results.length > 0, true);
    assert.equal(result.evidence.identity.accessMode, 'read-only');
    assert.deepEqual(await fileSnapshot(dir), before);
  } finally {
    await source.close();
  }
});

test('dashboard memory-search boundary maps compatibility source contention to retryable 503', () => {
  assert.equal(typeof sendMemorySearchError, 'function');
  for (const code of ['source_busy', 'source_unavailable']) {
    const response = {
      statusCode: null,
      payload: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    sendMemorySearchError(response, Object.assign(new Error(`${code} fixture`), {
      code,
      retryable: true,
    }), { error() {} });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.payload, {
      ok: false,
      error: {
        code,
        message: `${code} fixture`,
        retryable: true,
      },
    });
  }
});
