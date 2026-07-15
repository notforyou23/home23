import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
  assert.equal(hnswRecord.dimension, 2);
  assert.equal(hnswRecord.points.length, 2);
  const meta = JSON.parse(await fsp.readFile(path.join(dir, `memory-ann.${result.builtFromRevision}.meta.json`), 'utf8'));
  assert.deepEqual(meta.labels.map((label) => label.id).sort(), ['base', 'delta', 'wrong-dim']);
  assert.equal(meta.count, 2);
  assert.equal(meta.skipped, 1);
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
  assert.equal(result.coverage, 'overlay-covered');
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
