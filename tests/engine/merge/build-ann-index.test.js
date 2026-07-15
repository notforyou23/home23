import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  appendMemoryRevision,
  readManifest,
  rewriteMemoryBase,
  withEphemeralMemorySource,
} = require('../../../shared/memory-source');
const { build } = require('../../../engine/src/merge/build-ann-index');
const { createDefaultLoadAnn } = require('../../../engine/src/dashboard/memory-search');
const { attestMemoryAuthority } = require('../../../shared/memory-authority-attestation.cjs');

const CURRENT_ANN_AUTHORITY_PROJECTION_SCHEMA = 'home23.ann-authority-projection.v1';
const AUTHORITY_KEY = '8'.repeat(64);
const AUTHORITY_KEY_ID = createHash('sha256').update(AUTHORITY_KEY).digest('hex').slice(0, 16);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const lockRoots = new Map();

async function createBrain() {
  const dir = await tempDir('home23-ann-builder-brain-');
  const runtime = await tempDir('home23-ann-builder-runtime-');
  const lockRoot = path.join(runtime, 'runtime', 'brain-source-locks');
  lockRoots.set(dir, lockRoot);
  await rewriteMemoryBase(dir, {
    nodes: [
      { id: 'base', concept: 'base indexed', embedding: [1, 0] },
      { id: 'deleted', concept: 'deleted old', embedding: [0, 1] },
      { id: 'wrong-dim', concept: 'wrong dim', embedding: [1, 0, 0] },
    ],
    edges: [],
    summary: { nodeCount: 3, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  await appendMemoryRevision(dir, {
    nodes: [{ id: 'delta', concept: 'delta indexed', embedding: [0.5, 0.5] }],
    removedNodeIds: ['deleted'],
  }, {
    lockRoot,
    summary: { nodeCount: 3, edgeCount: 0, clusterCount: 1 },
  });
  return dir;
}

function fakeHnsw(record) {
  return {
    HierarchicalNSW: class {
      constructor(space, dimension) {
        record.space = space;
        record.dimension = dimension;
        record.points = [];
      }

      initIndex(capacity, m, efConstruction) {
        record.capacity = capacity;
        record.m = m;
        record.efConstruction = efConstruction;
      }

      addPoint(vector, label) {
        record.points.push({ vector, label });
      }

      writeIndexSync(filePath) {
        record.writePath = filePath;
        require('node:fs').writeFileSync(filePath, 'fake-index');
      }

      readIndexSync() {}

      getCurrentCount() { return record.points.length; }
    },
  };
}

async function canonicalResolve(dir) {
  const canonicalRoot = await fsp.realpath(dir);
  return {
    catalogRevision: 'catalog-1',
    accessMode: 'own',
    target: {
      id: 'brain-jerry',
      ownerAgent: 'jerry',
      canonicalRoot,
      kind: 'resident',
      sourceType: 'brain',
    },
  };
}

test('builder streams one pinned logical source and advances ANN watermark', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-home-');
  const hnswRecord = {};
  let ephemeralCalls = 0;
  const result = await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw(hnswRecord),
    now: () => new Date('2026-07-10T12:00:00Z'),
    withEphemeralMemorySource: async (options, callback) => {
      ephemeralCalls += 1;
      assert.equal(options.prefix, 'ann-build');
      return withEphemeralMemorySource(options, async (source, context) => {
        assert.equal(source.manifest.formatVersion, 1);
        return callback(source, context);
      });
    },
  });
  assert.equal(ephemeralCalls, 1);
  assert.equal(result.total, 2);
  assert.equal(result.advanced.advanced, true);
  assert.deepEqual(Object.keys(result.stageDurations).sort(), [
    'cleanupMs', 'indexWriteMs', 'metadataWriteMs', 'publishMs', 'reuseValidationMs',
    'sourceOpenMs', 'sourceScanMs', 'totalMs',
  ]);
  assert.ok(Object.values(result.stageDurations)
    .every((value) => Number.isSafeInteger(value) && value >= 0));
  assert.deepEqual(result.stageStatuses, {
    cleanup: 'completed',
    sourceOpen: 'completed',
    sourceScan: 'completed',
    indexWrite: 'completed',
    metadataWrite: 'completed',
    publish: 'completed',
    reuseValidation: 'skipped',
    total: 'completed',
  });
  assert.deepEqual(result.semanticCoverage, {
    status: 'complete', sourceNodes: 3, indexed: 2, skipped: 1,
    usable: true, vectorCoverageBps: 6666, minimumVectorCoverageBps: 5000,
  });
  assert.equal(hnswRecord.dimension, 2);
  assert.equal(hnswRecord.points.length, 2);
  const meta = JSON.parse(await fsp.readFile(path.join(dir, `memory-ann.${result.builtFromRevision}.meta.json`), 'utf8'));
  assert.deepEqual(meta.labels.map((label) => label.id).sort(), ['base', 'delta', 'wrong-dim']);
  assert.equal(meta.count, 2);
  assert.equal(meta.skipped, 1);
  assert.equal(meta.authorityProjectionSchema, CURRENT_ANN_AUTHORITY_PROJECTION_SCHEMA);
  assert.equal(meta.authorityAttestationKeyId, AUTHORITY_KEY_ID);
  assert.notEqual(meta.authorityAttestationKeyId, AUTHORITY_KEY);
  assert.equal(meta.builtFromRevision, result.builtFromRevision);
  assert.equal(meta.generation, result.generation);
  assert.match(
    path.basename(hnswRecord.writePath),
    new RegExp(`^memory-ann\\.${result.builtFromRevision}\\.index\\.tmp\\.`),
  );
  const manifest = await readManifest(dir);
  assert.equal(manifest.ann.builtFromRevision, result.builtFromRevision);
  assert.equal(manifest.ann.indexFile, `memory-ann.${result.builtFromRevision}.index`);
  assert.equal(manifest.ann.metaFile, `memory-ann.${result.builtFromRevision}.meta.json`);
  let loadedIndexPath = null;
  class FakeLoadedIndex {
    readIndexSync(filePath) { loadedIndexPath = filePath; }
    setEf() {}
    searchKnn() { return { neighbors: [], distances: [] }; }
  }
  const loadAnn = createDefaultLoadAnn({
    hnswlibLoader: () => ({ HierarchicalNSW: FakeLoadedIndex }),
  });
  const loaded = await loadAnn({
    descriptor: {
      canonicalRoot: await fsp.realpath(dir),
      generation: manifest.generation,
      cutoffRevision: manifest.currentRevision,
      summary: manifest.summary,
    },
  }, manifest.ann);
  assert.equal(loaded.count, 2);
  assert.equal(loaded.labels.length, 3);
  assert.equal(path.basename(loadedIndexPath), manifest.ann.indexFile);
  await loadAnn.close();
});

test('builder reports exact manifest and scanned counts while failing closed on source drift', async () => {
  const dir = await tempDir('home23-ann-builder-count-drift-brain-');
  const home23Root = await tempDir('home23-ann-builder-count-drift-home-');
  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
      withEphemeralMemorySource: async (_options, callback) => callback({
        revision: 3,
        manifest: {
          formatVersion: 1,
          generation: 'count-drift-generation',
          baseRevision: 2,
          activeDeltaEpoch: 'count-drift-epoch',
          summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
          ann: { indexFile: null, metaFile: null, builtFromRevision: null },
        },
        async *iterateNodes() {
          yield { id: '42', concept: 'one canonical node', embedding: [1, 0] };
        },
      }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
      advanceAnnBuiltFromRevision: async () => { throw new Error('must not publish'); },
    }),
    (error) => error?.code === 'invalid_memory_source'
      && error?.manifestNodeCount === 2
      && error?.scannedNodeCount === 1,
  );
});

test('builder counts an underreported source without exhausting native HNSW capacity', async () => {
  const dir = await tempDir('home23-ann-builder-underreported-brain-');
  const home23Root = await tempDir('home23-ann-builder-underreported-home-');
  let addCalls = 0;
  const capacityHnsw = {
    HierarchicalNSW: class {
      initIndex(capacity) { this.capacity = capacity; }
      addPoint() {
        addCalls += 1;
        if (addCalls > this.capacity) throw new Error('native HNSW capacity exhausted');
      }
      writeIndexSync() { throw new Error('must not publish'); }
    },
  };

  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: capacityHnsw,
      withEphemeralMemorySource: async (_options, callback) => callback({
        revision: 3,
        manifest: {
          formatVersion: 1,
          generation: 'underreported-generation',
          baseRevision: 2,
          activeDeltaEpoch: 'underreported-epoch',
          summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
          ann: { indexFile: null, metaFile: null, builtFromRevision: null },
        },
        async *iterateNodes() {
          yield { id: 'one', concept: 'first node', embedding: [1, 0] };
          yield { id: 'two', concept: 'second node', embedding: [0, 1] };
        },
      }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
      advanceAnnBuiltFromRevision: async () => { throw new Error('must not publish'); },
    }),
    (error) => error?.code === 'invalid_memory_source'
      && error?.manifestNodeCount === 1
      && error?.scannedNodeCount === 2
      && error?.indexedNodeCount === 2
      && error?.skippedNodeCount === 0,
  );
  assert.equal(addCalls, 1);
  await assert.rejects(fsp.access(path.join(dir, 'memory-ann.3.index')), { code: 'ENOENT' });
  await assert.rejects(fsp.access(path.join(dir, 'memory-ann.3.meta.json')), { code: 'ENOENT' });
});

test('builder rejects an oversized label id before publishing ANN outputs', async (t) => {
  const dir = await tempDir('home23-ann-builder-invalid-label-brain-');
  const home23Root = await tempDir('home23-ann-builder-invalid-label-home-');
  t.after(() => Promise.all([
    fsp.rm(dir, { recursive: true, force: true }),
    fsp.rm(home23Root, { recursive: true, force: true }),
  ]));
  const hnswRecord = {};
  let advanceCalls = 0;
  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw(hnswRecord),
      withEphemeralMemorySource: async (_options, callback) => callback({
        revision: 1,
        manifest: {
          formatVersion: 1,
          generation: 'invalid-label-generation',
          summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
        },
        async *iterateNodes() {
          yield { id: 'x'.repeat(300 * 1024), concept: 'oversized id', embedding: [1, 0] };
        },
      }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
      advanceAnnBuiltFromRevision: async () => {
        advanceCalls += 1;
        return { advanced: true };
      },
    }),
    (error) => error?.code === 'invalid_memory_source'
      && /cannot be represented/i.test(error.message),
  );
  assert.equal(hnswRecord.writePath, undefined);
  assert.equal(advanceCalls, 0);
  assert.deepEqual(await fsp.readdir(dir), []);
});

test('builder rejects legacy projection authority before HNSW construction or target writes', async () => {
  const dir = await tempDir('home23-ann-builder-legacy-brain-');
  const home23Root = await tempDir('home23-ann-builder-legacy-home-');
  const filesBefore = await fsp.readdir(dir);
  let hnswConstructions = 0;
  let sourceIterations = 0;
  let casCalls = 0;

  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: {
        HierarchicalNSW: class {
          constructor() { hnswConstructions += 1; }
        },
      },
      withEphemeralMemorySource: async (_options, callback) => callback({
        revision: 7,
        manifest: {
          formatVersion: 1,
          generation: 'legacy-generation',
          sourceMode: 'legacy_projection',
        },
        async *iterateNodes() {
          sourceIterations += 1;
          yield { id: 'legacy', concept: 'legacy', embedding: [1, 0] };
        },
      }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
      advanceAnnBuiltFromRevision: async () => {
        casCalls += 1;
        return { advanced: true };
      },
    }),
    (error) => error?.code === 'invalid_memory_source'
      && error?.sourceMode === 'legacy_projection',
  );

  assert.equal(hnswConstructions, 0);
  assert.equal(sourceIterations, 0);
  assert.equal(casCalls, 0);
  assert.deepEqual(await fsp.readdir(dir), filesBefore);
});

test('builder adds embeddings to HNSW while iterating and sizes it from manifest summary', async (t) => {
  const dir = await tempDir('home23-ann-builder-streaming-brain-');
  const home23Root = await tempDir('home23-ann-builder-streaming-home-');
  t.after(() => Promise.all([
    fsp.rm(dir, { recursive: true, force: true }),
    fsp.rm(home23Root, { recursive: true, force: true }),
  ]));
  const hnswRecord = {};
  const embeddings = [[1, 0], [0, 1]];

  const result = await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw(hnswRecord),
    withEphemeralMemorySource: async (_options, callback) => callback({
      revision: 11,
      manifest: {
        formatVersion: 1,
        generation: 'native-streaming-generation',
        summary: { nodeCount: embeddings.length, edgeCount: 0, clusterCount: 1 },
      },
      async *iterateNodes() {
        for (let index = 0; index < embeddings.length; index += 1) {
          yield { id: `node-${index}`, concept: `node ${index}`, embedding: embeddings[index] };
          assert.equal(hnswRecord.points?.length, index + 1);
          assert.equal(hnswRecord.points[index].vector, embeddings[index]);
        }
      },
    }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
    advanceAnnBuiltFromRevision: async () => ({ advanced: true }),
  });

  assert.equal(result.total, embeddings.length);
  assert.equal(hnswRecord.capacity, embeddings.length);
  assert.equal(hnswRecord.points.length, embeddings.length);
});

test('builder never clobbers pre-existing revisioned ANN outputs', async (t) => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-existing-home-');
  t.after(() => Promise.all([
    fsp.rm(dir, { recursive: true, force: true }),
    fsp.rm(home23Root, { recursive: true, force: true }),
  ]));
  const manifest = await readManifest(dir);
  const indexPath = path.join(dir, `memory-ann.${manifest.currentRevision}.index`);
  const metaPath = path.join(dir, `memory-ann.${manifest.currentRevision}.meta.json`);
  await fsp.writeFile(indexPath, 'existing-index');
  await fsp.writeFile(metaPath, 'existing-meta');
  let hnswConstructions = 0;
  let casCalls = 0;

  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: {
        HierarchicalNSW: class {
          constructor() { hnswConstructions += 1; }
        },
      },
      advanceAnnBuiltFromRevision: async () => {
        casCalls += 1;
        return { advanced: true };
      },
    }),
    (error) => error?.code === 'source_changed' && error?.retryable === true,
  );

  assert.equal(hnswConstructions, 0);
  assert.equal(casCalls, 0);
  assert.equal(await fsp.readFile(indexPath, 'utf8'), 'existing-index');
  assert.equal(await fsp.readFile(metaPath, 'utf8'), 'existing-meta');
  assert.deepEqual(
    (await fsp.readdir(dir)).filter((file) => file.includes('.tmp.')),
    [],
  );
});

test('builder reuses an ANN already pinned fresh at the current revision', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-reuse-home-');
  const first = await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  });
  let constructions = 0;
  let reads = 0;
  let casCalls = 0;
  const second = await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: {
      HierarchicalNSW: class {
        constructor() { constructions += 1; }
        readIndexSync() { reads += 1; }
        getCurrentCount() { return first.total; }
      },
    },
    advanceAnnBuiltFromRevision: async () => {
      casCalls += 1;
      return { advanced: true };
    },
  });
  assert.equal(second.reused, true);
  assert.equal(second.builtFromRevision, first.builtFromRevision);
  assert.equal(second.total, first.total);
  assert.equal(second.semanticCoverage.indexed, first.total);
  assert.equal(second.semanticCoverage.skipped, first.skipped);
  assert.equal(second.advanced.advanced, true);
  assert.equal(second.advanced.reason, 'already_fresh');
  assert.equal(constructions, 1);
  assert.equal(reads, 1);
  assert.equal(casCalls, 0);
});

test('builder refuses fresh reuse without an exact current authority projection schema', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-legacy-authority-reuse-home-');
  const first = await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  });
  const currentMeta = JSON.parse(await fsp.readFile(first.metaPath, 'utf8'));
  for (const authorityProjectionSchema of [undefined, 'home23.ann-authority-projection.v0']) {
    const meta = { ...currentMeta, authorityProjectionSchema };
    if (authorityProjectionSchema === undefined) delete meta.authorityProjectionSchema;
    await fsp.writeFile(first.metaPath, JSON.stringify(meta));

    await assert.rejects(() => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
    }), (error) => error?.code === 'source_unavailable'
      && /authority projection schema/i.test(error.message));
  }
});

test('builder refuses fresh ANN reuse after the authority verifier key rotates', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-authority-key-reuse-home-');
  await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
    authorityKey: AUTHORITY_KEY,
  });

  await assert.rejects(() => build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
    authorityKey: '9'.repeat(64),
  }), (error) => error?.code === 'source_unavailable'
    && /authority verifier context/i.test(error.message));
});

test('builder refuses fresh ANN reuse across embedding provider or model identity', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-provider-reuse-home-');
  await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
    provider: 'provider-a',
    model: 'model-a',
  });
  await assert.rejects(() => build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
    provider: 'provider-b',
    model: 'model-b',
  }), (error) => error?.code === 'source_unavailable'
    && /embedding identity/i.test(error.message));
});

test('builder rejects zero or insufficient usable-vector coverage before publication', async (t) => {
  for (const [name, nodes] of [
    ['zero', [{ id: 'a', concept: 'a' }]],
    ['insufficient', [
      { id: 'a', concept: 'a', embedding: [1, 0] },
      { id: 'b', concept: 'b' },
      { id: 'c', concept: 'c' },
    ]],
  ]) {
    const dir = await tempDir(`home23-ann-builder-${name}-coverage-brain-`);
    const home23Root = await tempDir(`home23-ann-builder-${name}-coverage-home-`);
    t.after(() => Promise.all([
      fsp.rm(dir, { recursive: true, force: true }),
      fsp.rm(home23Root, { recursive: true, force: true }),
    ]));
    let publications = 0;
    await assert.rejects(() => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
      withEphemeralMemorySource: async (_options, callback) => callback({
        revision: 1,
        manifest: {
          formatVersion: 1,
          generation: `${name}-coverage-generation`,
          summary: { nodeCount: nodes.length, edgeCount: 0, clusterCount: 1 },
        },
        async *iterateNodes() { for (const node of nodes) yield node; },
      }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
      advanceAnnBuiltFromRevision: async () => {
        publications += 1;
        return { advanced: true };
      },
    }), (error) => error?.code === 'invalid_memory_source'
      && /usable-vector coverage/i.test(error.message));
    assert.equal(publications, 0);
    assert.deepEqual(await fsp.readdir(dir), []);
  }
});

test('default CLI target rejects a symlinked own-brain root that escapes Home23', async (t) => {
  const madeHome = await tempDir('home23-ann-builder-confined-home-');
  const madeExternal = await tempDir('home23-ann-builder-confined-external-');
  const home23Root = await fsp.realpath(madeHome);
  const externalBrain = await fsp.realpath(madeExternal);
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(externalBrain, { recursive: true, force: true }),
  ]));
  const agentRoot = path.join(home23Root, 'instances', 'jerry');
  await fsp.mkdir(agentRoot, { recursive: true });
  await rewriteMemoryBase(externalBrain, {
    nodes: [{ id: 'outside', concept: 'outside', embedding: [1, 0] }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') });
  const lexicalBrain = path.join(agentRoot, 'brain');
  await fsp.symlink(externalBrain, lexicalBrain);

  await assert.rejects(() => build(lexicalBrain, {
    hnswlib: fakeHnsw({}),
  }), (error) => error?.code === 'invalid_memory_source'
    && /canonical nonsymlink own-brain/i.test(error.message));
  assert.equal(
    (await fsp.readdir(externalBrain)).some((name) => name.startsWith('memory-ann.')),
    false,
  );
});

test('builder total timing includes operation cleanup after build phases', async (t) => {
  const dir = await tempDir('home23-ann-builder-cleanup-timing-brain-');
  const home23Root = await tempDir('home23-ann-builder-cleanup-timing-home-');
  t.after(() => Promise.all([
    fsp.rm(dir, { recursive: true, force: true }),
    fsp.rm(home23Root, { recursive: true, force: true }),
  ]));
  const result = await build(dir, {
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
    withEphemeralMemorySource: async (_options, callback) => {
      const value = await callback({
        revision: 1,
        manifest: {
          formatVersion: 1,
          generation: 'cleanup-timing-generation',
          summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
        },
        async *iterateNodes() { yield { id: 'a', concept: 'a', embedding: [1, 0] }; },
      }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return value;
    },
    advanceAnnBuiltFromRevision: async () => ({ advanced: true }),
  });
  assert.ok(result.stageDurations.cleanupMs >= 15, JSON.stringify(result.stageDurations));
  assert.ok(result.stageDurations.totalMs >= result.stageDurations.cleanupMs);
  assert.equal(result.stageStatuses.cleanup, 'completed');
});

test('builder refuses fresh reuse when the actual index is corrupt', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-corrupt-reuse-');
  const first = await build(dir, {
    home23Root, requesterAgent: 'jerry', resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  });
  await fsp.writeFile(first.indexPath, 'corrupt-index');
  await assert.rejects(() => build(dir, {
    home23Root, requesterAgent: 'jerry', resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: {
      HierarchicalNSW: class {
        readIndexSync() { throw new Error('corrupt HNSW'); }
      },
    },
  }), (error) => error?.code === 'source_unavailable');
});

test('builder refuses fresh reuse when full metadata authority is corrupt', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-corrupt-meta-reuse-');
  const first = await build(dir, {
    home23Root, requesterAgent: 'jerry', resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  });
  const meta = JSON.parse(await fsp.readFile(first.metaPath, 'utf8'));
  meta.generation = 'wrong-generation';
  await fsp.writeFile(first.metaPath, JSON.stringify(meta));
  await assert.rejects(() => build(dir, {
    home23Root, requesterAgent: 'jerry', resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  }), { code: 'source_unavailable' });
});

test('builder metadata retains bounded labels for skipped nodes', async () => {
  const dir = await tempDir('home23-ann-builder-skipped-brain-');
  const runtime = await tempDir('home23-ann-builder-skipped-runtime-');
  const lockRoot = path.join(runtime, 'locks');
  await rewriteMemoryBase(dir, {
    nodes: [
      { id: 'vector', concept: 'vector', embedding: [1, 0] },
      { id: 'skipped', concept: 'keyword-only node' },
    ],
    edges: [],
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  const result = await build(dir, {
    home23Root: runtime, requesterAgent: 'jerry', resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  });
  const meta = JSON.parse(await fsp.readFile(result.metaPath, 'utf8'));
  assert.equal(meta.count, 1);
  assert.equal(meta.skipped, 1);
  assert.equal(meta.labelCount, 2);
  assert.equal(meta.sourceNodeCount, 2);
  assert.deepEqual(meta.labels.map((label) => label.id), ['vector', 'skipped']);
});

test('builder metadata preserves bounded path-redacted source chains and qualified evidence truth', async (t) => {
  const authorityKey = '8'.repeat(64);
  const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = authorityKey;
  t.after(() => {
    if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
    else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
  });
  const dir = await tempDir('home23-ann-builder-source-chain-brain-');
  const runtime = await tempDir('home23-ann-builder-source-chain-runtime-');
  const lockRoot = path.join(runtime, 'locks');
  await rewriteMemoryBase(dir, {
    nodes: [attestMemoryAuthority({
      id: 'verified', concept: 'verified current source', embedding: [1, 0],
      created: '2026-07-14T12:00:00.000Z',
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'verified_current_state', operationalAuthority: true,
        sourceRefs: ['/Volumes/PrivateBrain/current/source.json'],
        evidenceRefs: ['verifier:live-source'],
      },
    }, authorityKey)],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  const result = await build(dir, {
    home23Root: runtime, requesterAgent: 'jerry', resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw({}),
  });
  const meta = JSON.parse(await fsp.readFile(result.metaPath, 'utf8'));
  const label = meta.labels[0];
  assert.equal(label.evidencePresent, true);
  assert.equal(label.sourceChain.length, 2);
  assert.ok(label.sourceChain.every(entry => !entry.ref.includes('/Volumes/')));
  assert.ok(label.sourceChain.every(entry => entry.ref.length <= 240));
});

test('concurrent builders use unique temps and only one publishes a revision', async (t) => {
  const dir = await tempDir('home23-ann-builder-concurrent-brain-');
  const home23Root = await tempDir('home23-ann-builder-concurrent-home-');
  t.after(() => Promise.all([
    fsp.rm(dir, { recursive: true, force: true }),
    fsp.rm(home23Root, { recursive: true, force: true }),
  ]));
  let waiting = 0;
  let release;
  const bothStreaming = new Promise((resolve) => { release = resolve; });
  const records = [{}, {}];
  const optionsFor = (record) => ({
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: () => canonicalResolve(dir),
    hnswlib: fakeHnsw(record),
    withEphemeralMemorySource: async (_options, callback) => callback({
      revision: 17,
      manifest: {
        formatVersion: 1,
        generation: 'native-concurrent-generation',
        summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
      },
      async *iterateNodes() {
        yield { id: 'one', concept: 'one', embedding: [1, 0] };
        waiting += 1;
        if (waiting === 2) release();
        await bothStreaming;
      },
    }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') }),
    advanceAnnBuiltFromRevision: async () => ({ advanced: true }),
  });

  const settled = await Promise.allSettled([
    build(dir, optionsFor(records[0])),
    build(dir, optionsFor(records[1])),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = settled.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'source_changed');
  assert.notEqual(records[0].writePath, records[1].writePath);
  const files = await fsp.readdir(dir);
  assert.ok(files.includes('memory-ann.17.index'));
  assert.ok(files.includes('memory-ann.17.meta.json'));
  assert.deepEqual(files.filter((file) => file.includes('.tmp.')), []);
});

test('builder removes its newly written ANN files and rejects if generation changes before CAS', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-home-');
  const original = await readManifest(dir);
  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
      advanceAnnBuiltFromRevision: async (brainDir, update) => {
        await rewriteMemoryBase(brainDir, {
          nodes: [{ id: 'new-generation', concept: 'new generation', embedding: [1, 0] }],
          edges: [],
          summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
        }, { lockRoot: update.lockRoot });
        const {
          advanceAnnBuiltFromRevision,
        } = require('../../../shared/memory-source');
        return advanceAnnBuiltFromRevision(brainDir, update);
      },
    }),
    (error) => error?.code === 'source_changed' && error?.retryable === true,
  );
  const manifest = await readManifest(dir);
  assert.notEqual(manifest.generation, original.generation);
  assert.equal(manifest.ann.builtFromRevision, null);
  await assert.rejects(
    fsp.access(path.join(dir, `memory-ann.${original.currentRevision}.index`)),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fsp.access(path.join(dir, `memory-ann.${original.currentRevision}.meta.json`)),
    { code: 'ENOENT' },
  );
});

test('builder publishes a bridgeable index after a same-generation append during build', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-same-generation-home-');
  const pinned = await readManifest(dir);

  const result = await build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
      advanceAnnBuiltFromRevision: async (brainDir, update) => {
        await appendMemoryRevision(brainDir, {
          nodes: [{ id: 'appended', concept: 'same generation append', embedding: [0, 1] }],
        }, {
          lockRoot: update.lockRoot,
          summary: {
            nodeCount: pinned.summary.nodeCount + 1,
            edgeCount: pinned.summary.edgeCount,
            clusterCount: pinned.summary.clusterCount,
          },
        });
        const {
          advanceAnnBuiltFromRevision,
        } = require('../../../shared/memory-source');
        return advanceAnnBuiltFromRevision(brainDir, update);
      },
    });

  const manifest = await readManifest(dir);
  assert.equal(manifest.generation, pinned.generation);
  assert.equal(manifest.currentRevision, pinned.currentRevision + 1);
  assert.equal(manifest.ann.indexFile, `memory-ann.${pinned.currentRevision}.index`);
  assert.equal(manifest.ann.metaFile, `memory-ann.${pinned.currentRevision}.meta.json`);
  assert.equal(manifest.ann.builtFromRevision, pinned.currentRevision);
  assert.equal(result.coverage, 'rebuilt-overlay-covered');
  assert.equal(result.currentRevision, pinned.currentRevision + 1);
  assert.equal(result.bridgeableGap, 1);
  assert.equal(result.semanticCoverage.indexed + result.semanticCoverage.skipped, pinned.summary.nodeCount);
  assert.deepEqual(
    (await fsp.readdir(dir)).filter((file) => file.includes('.tmp.')),
    [],
  );
});

test('ANN builder preserves typed retryable compatibility admission contention', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-busy-home-');
  const busy = Object.assign(new Error('compatibility source busy'), {
    code: 'source_busy',
    retryable: true,
  });
  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
      withEphemeralMemorySource: async () => { throw busy; },
    }),
    (error) => error === busy,
  );
});

test('ANN builder preserves typed retryable compatibility admission contention', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-busy-home-');
  const busy = Object.assign(new Error('compatibility source busy'), {
    code: 'source_busy',
    retryable: true,
  });
  await assert.rejects(
    () => build(dir, {
      home23Root,
      requesterAgent: 'jerry',
      resolveTargetContext: () => canonicalResolve(dir),
      hnswlib: fakeHnsw({}),
      withEphemeralMemorySource: async () => { throw busy; },
    }),
    (error) => error === busy,
  );
});
