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
  assert.deepEqual(meta.labels.map((label) => label.id).sort(), ['base', 'delta']);
  assert.equal(meta.builtFromRevision, result.builtFromRevision);
  assert.equal(meta.generation, result.generation);
  assert.equal(path.basename(hnswRecord.writePath), `memory-ann.${result.builtFromRevision}.index.tmp`);
  const manifest = await readManifest(dir);
  assert.equal(manifest.ann.builtFromRevision, result.builtFromRevision);
  assert.equal(manifest.ann.indexFile, `memory-ann.${result.builtFromRevision}.index`);
  assert.equal(manifest.ann.metaFile, `memory-ann.${result.builtFromRevision}.meta.json`);
});

test('builder leaves ANN watermark stale if generation changes before CAS', async () => {
  const dir = await createBrain();
  const home23Root = await tempDir('home23-ann-builder-home-');
  const original = await readManifest(dir);
  const result = await build(dir, {
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
  });
  assert.equal(result.advanced.advanced, false);
  assert.equal(result.advanced.reason, 'source_changed');
  const manifest = await readManifest(dir);
  assert.notEqual(manifest.generation, original.generation);
  assert.equal(manifest.ann.builtFromRevision, null);
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
