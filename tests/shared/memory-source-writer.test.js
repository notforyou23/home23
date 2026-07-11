import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, renameSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  advanceAnnBuiltFromRevision,
  appendMemoryRevision,
  compareAndSwapSourceRevision,
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  openMemorySource,
  openPinnedSource,
  readJsonl,
  readManifest,
  releaseOperationSource,
  retireUnpinnedSources,
  rewriteMemoryBase,
  sourceDescriptorDigest,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createCommittedFixture() {
  const dir = await tempDir('home23-memory-source-writer-brain-');
  const runtime = await tempDir('home23-memory-source-writer-runtime-');
  const lockRoot = path.join(runtime, 'runtime', 'brain-source-locks');
  const nodes = await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.base-1.jsonl.gz'), [
    { id: 'n1', concept: 'old committed canary' },
  ]);
  const edges = await writeJsonlGzAtomic(path.join(dir, 'memory-edges.base-1.jsonl.gz'), []);
  await fsp.writeFile(path.join(dir, 'memory-delta.e2.jsonl'), '');
  const manifest = {
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 1,
    currentRevision: 1,
    activeDeltaEpoch: 'e2',
    activeBase: {
      nodes: { file: 'memory-nodes.base-1.jsonl.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'memory-edges.base-1.jsonl.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: 'e2',
      file: 'memory-delta.e2.jsonl',
      fromRevision: 2,
      toRevision: 1,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 1 },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  };
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, runtime, lockRoot };
}

async function concepts(source) {
  const result = [];
  for await (const node of source.iterateNodes()) result.push(node.concept);
  return result.sort();
}

function replacementCapturedView() {
  return {
    nodes: [{ id: 'replacement', concept: 'replacement canary' }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  };
}

async function readCommittedDelta(dir) {
  const manifest = await readManifest(dir);
  const rows = [];
  for await (const row of readJsonl(path.join(dir, manifest.activeDelta.file), {
    confinedRoot: dir,
    byteLimit: manifest.activeDelta.committedBytes,
    requireCompletePrefix: true,
  })) rows.push(row);
  return rows;
}

test('a failed full rewrite leaves the old manifest and delta authoritative', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  await assert.rejects(() => rewriteMemoryBase(dir, replacementCapturedView(), {
    lockRoot,
    faultAt: 'beforeManifestRename',
  }), /injected:beforeManifestRename/);
  const source = await openMemorySource(dir);
  assert.deepEqual(await concepts(source), ['old committed canary']);
  assert.equal((await readManifest(dir)).generation, 'g1');
  await source.close();
});

test('uncommitted appended bytes are ignored and truncated by the next append', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  await assert.rejects(() => appendMemoryRevision(dir, {
    nodes: [{ id: 'orphan', concept: 'must not cross' }],
  }, { lockRoot, faultAt: 'afterDeltaFsync' }), /injected:afterDeltaFsync/);
  await appendMemoryRevision(dir, {
    nodes: [{ id: 'committed', concept: 'new committed canary' }],
  }, {
    lockRoot,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  const source = await openMemorySource(dir);
  assert.deepEqual(await concepts(source), ['new committed canary', 'old committed canary']);
  await source.close();
});

test('append rejects a delta pathname replacement before manifest publication', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const manifestBefore = await readManifest(dir);
  const deltaPath = path.join(dir, manifestBefore.activeDelta.file);
  await assert.rejects(() => appendMemoryRevision(dir, {
    nodes: [{ id: 'raced', concept: 'must not publish' }],
  }, {
    lockRoot,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
    _testHooks: {
      beforeManifestRename() {
        const displaced = `${deltaPath}.displaced`;
        renameSync(deltaPath, displaced);
        copyFileSync(displaced, deltaPath);
      },
    },
  }), { code: 'source_changed' });
  const manifestAfter = await readManifest(dir);
  assert.equal(manifestAfter.generation, manifestBefore.generation);
  assert.equal(manifestAfter.currentRevision, manifestBefore.currentRevision);
  assert.equal(
    manifestAfter.activeDelta.committedBytes,
    manifestBefore.activeDelta.committedBytes,
  );
});

test('delta records carry one epoch and strictly increasing sequence and revision', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const result = await appendMemoryRevision(dir, {
    nodes: [{ id: 'n2' }, { id: 'n3' }],
    removedNodeIds: ['n1'],
  }, {
    lockRoot,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  assert.equal(result.fromRevision + 2, result.toRevision);
  const rows = await readCommittedDelta(dir);
  assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.revision), [2, 3, 4]);
  assert.equal(new Set(rows.map((row) => row.epoch)).size, 1);
});

test('ANN completion advances only its built-from watermark', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const before = await readManifest(dir);
  const result = await advanceAnnBuiltFromRevision(dir, {
    lockRoot,
    expectedGeneration: before.generation,
    builtFromRevision: before.currentRevision,
    indexFile: `memory-ann.${before.currentRevision}.index`,
    metaFile: `memory-ann.${before.currentRevision}.meta.json`,
  });
  assert.equal(result.advanced, true);
  assert.equal(result.manifest.currentRevision, before.currentRevision);
  assert.equal(result.manifest.ann.builtFromRevision, before.currentRevision);
});

test('derived-state compare-and-swap rejects a newer source revision', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const pinned = await openMemorySource(dir);
  await appendMemoryRevision(dir, { nodes: [{ id: 'newer', concept: 'newer source' }] }, {
    lockRoot,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  let writes = 0;
  const result = await compareAndSwapSourceRevision(dir, {
    lockRoot,
    expectedGeneration: pinned.manifest.generation,
    expectedRevision: pinned.revision,
    expectedDigest: sourceDescriptorDigest(pinned.descriptor),
    commit: async () => { writes += 1; },
  });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'source_changed');
  assert.equal(writes, 0);
  await pinned.close();
});

test('derived-state CAS keeps a completed commit when cancellation arrives after callback entry', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const source = await openMemorySource(dir);
  const descriptor = source.descriptor;
  await source.close();
  const derivedPath = path.join(dir, 'derived-state.txt');
  const prior = 'prior-state\n';
  await fsp.writeFile(derivedPath, prior);
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancelled-after-commit'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  const result = await compareAndSwapSourceRevision(dir, {
    lockRoot,
    expectedGeneration: descriptor.generation,
    expectedRevision: descriptor.cutoffRevision,
    expectedDigest: sourceDescriptorDigest(descriptor),
    signal: controller.signal,
    async commit() {
      await fsp.writeFile(derivedPath, 'prospective-state\n');
      controller.abort(reason);
      return { published: true };
    },
  });

  assert.equal(result.committed, true);
  assert.equal(await fsp.readFile(derivedPath, 'utf8'), 'prospective-state\n');
});

test('a source-lock release error cannot erase a completed CAS callback outcome', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const source = await openMemorySource(dir);
  const descriptor = source.descriptor;
  await source.close();
  let releaseHookCalls = 0;
  const result = await compareAndSwapSourceRevision(dir, {
    lockRoot,
    expectedGeneration: descriptor.generation,
    expectedRevision: descriptor.cutoffRevision,
    expectedDigest: sourceDescriptorDigest(descriptor),
    async commit() {
      return { published: true };
    },
    _testHooks: {
      afterLockReleased() {
        releaseHookCalls += 1;
        throw new Error('injected release failure after cleanup');
      },
    },
  });
  assert.equal(releaseHookCalls, 1);
  assert.deepEqual(result.value, { published: true });
  assert.equal(result.committed, true);
});

test('retirement preserves files named by an active reader pin', async () => {
  const { dir, lockRoot } = await createCommittedFixture();
  const home23Root = await tempDir('home23-memory-source-writer-home-');
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'ada' });
  const operationId = 'brop_writer_pin';
  const pinnedDescriptor = await provider.pin(dir, operationId);
  const operationRoot = path.join(home23Root, 'instances', 'ada', 'runtime', 'brain-operations', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const pinned = await openPinnedSource(pinnedDescriptor.descriptor, {
    expectedDigest: pinnedDescriptor.digest,
    expectedCanonicalRoot: pinnedDescriptor.descriptor.canonicalRoot,
    expectedRevision: pinnedDescriptor.descriptor.cutoffRevision,
    operationId,
    requesterAgent: 'ada',
    operationRoot,
    scratchQuota,
  });
  const oldNodeFile = pinned.manifest.activeBase.nodes.file;
  await rewriteMemoryBase(dir, replacementCapturedView(), { lockRoot });
  const protectedResult = await retireUnpinnedSources(dir, { home23Root, lockRoot });
  assert.equal(protectedResult.retired.includes(oldNodeFile), false);
  await pinned.release();
  await releaseOperationSource({ home23Root, requesterAgent: 'ada', operationId });
  const releasedResult = await retireUnpinnedSources(dir, { home23Root, lockRoot });
  assert.equal(releasedResult.retired.includes(oldNodeFile), true);
  scratchQuota.close();
});
