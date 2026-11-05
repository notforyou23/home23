import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  enumerateMemoryMutationBoundaries,
  resolveMemorySourceSelection,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-memory-source-adapters-'));
}

async function writeManifestFixture() {
  const dir = await tempDir();
  const nodes = await writeJsonlGzAtomic(path.join(dir, 'nodes.gz'), [{ id: 1 }]);
  const edges = await writeJsonlGzAtomic(path.join(dir, 'edges.gz'), []);
  await fsp.writeFile(path.join(dir, 'delta.jsonl'), '');
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 2,
    currentRevision: 2,
    activeDeltaEpoch: 'e0',
    activeBase: {
      nodes: { file: 'nodes.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'edges.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: 'e0',
      file: 'delta.jsonl',
      fromRevision: 3,
      toRevision: 2,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 2 },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, null, 2)}\n`);
  return dir;
}

test('resolveMemorySourceSelection is side-effect-free and reports manifest-v1 target files', async () => {
  const dir = await writeManifestFixture();
  const before = (await fsp.readdir(dir)).sort();
  const selection = await resolveMemorySourceSelection(dir);
  const after = (await fsp.readdir(dir)).sort();
  assert.deepEqual(after, before);
  assert.equal(selection.authority, 'manifest-v1');
  assert.equal(selection.canonicalRoot, await fsp.realpath(dir));
  assert.deepEqual(selection.targetFiles.map((file) => file.role).sort(), [
    'delta',
    'edges',
    'manifest',
    'nodes',
    'snapshot-advisory',
  ]);
  assert.equal(selection.targetFiles.some((file) => /pins|source-projections|brain-source-locks/.test(file.path)), false);
});

test('resolveMemorySourceSelection reports legacy sidecars and unavailable without projection or pins', async () => {
  const legacy = await tempDir();
  await writeJsonlGzAtomic(path.join(legacy, 'memory-nodes.jsonl.gz'), []);
  await writeJsonlGzAtomic(path.join(legacy, 'memory-edges.jsonl.gz'), []);
  const selection = await resolveMemorySourceSelection(legacy);
  assert.equal(selection.authority, 'legacy-resident-sidecars');
  assert.deepEqual((await fsp.readdir(legacy)).sort(), ['memory-edges.jsonl.gz', 'memory-nodes.jsonl.gz']);

  const empty = await tempDir();
  const unavailable = await resolveMemorySourceSelection(empty);
  assert.equal(unavailable.authority, 'unavailable');
  assert.deepEqual(unavailable.targetFiles, []);
});

test('getMutationBoundaries returns exactly seven sorted public target boundaries', async () => {
  const root = await tempDir();
  const boundaries = enumerateMemoryMutationBoundaries(root);
  assert.deepEqual(boundaries.map((entry) => entry.kind), [
    'agency',
    'brain',
    'cache',
    'export',
    'pgs',
    'run',
    'session',
  ]);
  assert.equal(boundaries.every((entry) => path.isAbsolute(entry.path)), true);
  assert.equal(boundaries.some((entry) => /brain-source-locks|brain-operations|source-projections|results/.test(entry.path)), false);
  assert.throws(
    () => enumerateMemoryMutationBoundaries(root, { extra: [{ kind: 'brain', path: '../escape' }] }),
    { code: 'invalid_request' },
  );
});
