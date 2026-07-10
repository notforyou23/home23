import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  openPinnedSource,
  sourceDescriptorDigest,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeManifestBrain() {
  const brain = await tempDir('home23-memory-source-pin-brain-');
  const nodes = await writeJsonlGzAtomic(path.join(brain, 'nodes.gz'), [{ id: 1, concept: 'pin canary' }]);
  const edges = await writeJsonlGzAtomic(path.join(brain, 'edges.gz'), []);
  await fsp.writeFile(path.join(brain, 'delta.jsonl'), '');
  await fsp.writeFile(path.join(brain, 'memory-manifest.json'), `${JSON.stringify({
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
  return brain;
}

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

test('pin provider returns exactly descriptor and digest and persists private coordinator record', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  assert.equal('attachSourcePin' in provider, false);
  const result = await provider.pin(brain, 'brop_test_pin');
  assert.deepEqual(Object.keys(result).sort(), ['descriptor', 'digest']);
  assert.equal(result.digest, sourceDescriptorDigest(result.descriptor));
  assert.equal('close' in result, false);
  assert.equal('release' in result, false);
  assert.equal('physicalRoot' in result.descriptor, false);
  const recordPath = path.join(home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', 'brop_test_pin', 'coordinator-source-pin.json');
  const record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
  assert.equal(record.physicalRoot, await fsp.realpath(brain));
  assert.equal(record.digest, result.digest);
  assert.deepEqual(await provider.pin(brain, 'brop_test_pin'), result);
});

test('openPinnedSource validates coordinator record and writes a separate process pin', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_open';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = path.join(home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const source = await openPinnedSource(pinned.descriptor, {
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    operationId,
    operationRoot,
    scratchQuota,
  });
  const nodes = await collect(source.iterateNodes());
  assert.deepEqual(nodes.map((node) => node.concept), ['pin canary']);
  const pinRoot = path.join(operationRoot, 'pins');
  assert.equal((await fsp.readdir(pinRoot)).length, 1);
  await source.release();
  assert.equal(await fsp.access(path.join(operationRoot, 'coordinator-source-pin.json')).then(() => true), true);
  assert.equal(await fsp.access(pinRoot).then(() => true).catch(() => false), true);
  scratchQuota.close();
});

test('openPinnedSource rejects digest, root, and revision mismatch before reading', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_reject';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = path.join(home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const wrongDigest = `${pinned.digest.slice(0, -1)}${pinned.digest.endsWith('0') ? '1' : '0'}`;
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    expectedDigest: wrongDigest,
    operationRoot,
    scratchQuota,
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    expectedDigest: pinned.digest,
    expectedCanonicalRoot: path.join(home23Root, 'other'),
    operationRoot,
    scratchQuota,
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    expectedDigest: pinned.digest,
    expectedRevision: pinned.descriptor.cutoffRevision + 1,
    operationRoot,
    scratchQuota,
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    expectedDigest: pinned.digest,
    operationRoot,
  }), { code: 'invalid_request' });
  scratchQuota.close();
});

test('pin discovery, stale process prune, and terminal release are exact to operation roots', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_discovery';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = path.join(home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const {
    discoverOperationPinFiles,
    pruneStalePins,
    releaseOperationSource,
  } = require('../../shared/memory-source');
  const source = await openPinnedSource(pinned.descriptor, {
    expectedDigest: pinned.digest,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    operationId,
    operationRoot,
    scratchQuota,
  });
  let discovered = await discoverOperationPinFiles(home23Root);
  assert.deepEqual(discovered.map((entry) => entry.kind).sort(), ['coordinator', 'process']);
  assert.equal((await pruneStalePins(home23Root, {
    getOperationState: async () => 'running',
    isProcessAlive: async () => false,
  })).length, 0);
  assert.equal((await pruneStalePins(home23Root, {
    getOperationState: async () => 'interrupted',
    isProcessAlive: async () => false,
  })).length, 1);
  discovered = await discoverOperationPinFiles(home23Root);
  assert.deepEqual(discovered.map((entry) => entry.kind), ['coordinator']);
  await releaseOperationSource({ home23Root, requesterAgent: 'jerry', operationId });
  assert.deepEqual(await discoverOperationPinFiles(home23Root), []);
  await source.close();
  scratchQuota.close();
});
