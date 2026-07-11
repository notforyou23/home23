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

async function advanceManifestBrain(brain) {
  const nodes = await writeJsonlGzAtomic(path.join(brain, 'nodes-v2.gz'), [
    { id: 2, concept: 'live revision advanced' },
  ]);
  const edges = await writeJsonlGzAtomic(path.join(brain, 'edges-v2.gz'), []);
  await fsp.writeFile(path.join(brain, 'delta-v2.jsonl'), '');
  await fsp.writeFile(path.join(brain, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g2',
    baseRevision: 3,
    currentRevision: 3,
    activeDeltaEpoch: 'e1',
    activeBase: {
      nodes: { file: 'nodes-v2.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'edges-v2.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: 'e1',
      file: 'delta-v2.jsonl',
      fromRevision: 4,
      toRevision: 3,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 3 },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, null, 2)}\n`);
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
    requesterAgent: 'jerry',
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

test('openPinnedSource binds a safe PID-plus-start process identity and rolls back failed opens', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_process_identity';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = path.join(
    home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', operationId,
  );
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const exact = {
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    operationId,
    requesterAgent: 'jerry',
    operationRoot,
    scratchQuota,
  };

  const processIdentity = 'cosmo-43210-0123456789abcdefabcd';
  const source = await openPinnedSource(pinned.descriptor, { ...exact, processIdentity });
  const processPin = path.join(
    operationRoot, 'pins', processIdentity,
    `${path.basename((await fsp.readdir(path.join(operationRoot, 'pins', processIdentity)))[0])}`,
  );
  const processRecord = JSON.parse(await fsp.readFile(processPin, 'utf8'));
  assert.equal(processRecord.processIdentity, processIdentity);
  await source.release();

  await assert.rejects(
    () => openPinnedSource(pinned.descriptor, { ...exact, processIdentity: '../escape' }),
    { code: 'invalid_request' },
  );

  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel before open'), { code: 'cancelled' });
  controller.abort(reason);
  await assert.rejects(
    () => openPinnedSource(pinned.descriptor, {
      ...exact,
      processIdentity,
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  assert.deepEqual(await fsp.readdir(path.join(operationRoot, 'pins')).catch(() => []), []);
  await scratchQuota.close();
});

test('same-process concurrent opens retain the shared pin until the last release', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_process_reference';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = path.join(
    home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', operationId,
  );
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const processIdentity = 'cosmo-777-reference-test';
  const exact = {
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    operationId,
    requesterAgent: 'jerry',
    operationRoot,
    scratchQuota,
    processIdentity,
  };
  const [first, second] = await Promise.all([
    openPinnedSource(pinned.descriptor, exact),
    openPinnedSource(pinned.descriptor, exact),
  ]);
  const pinDir = path.join(operationRoot, 'pins', processIdentity);
  const [pinName] = await fsp.readdir(pinDir);
  const pinFile = path.join(pinDir, pinName);

  await first.release();
  assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), true);
  assert.deepEqual((await collect(second.iterateNodes())).map((node) => node.concept), [
    'pin canary',
  ]);
  await first.release();
  assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), true);

  await second.release();
  assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), false);
  await scratchQuota.close();
});

test('native operation pin reads its exact revision after the live manifest advances', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_native_revision';
  const pinned = await provider.pin(brain, operationId);
  await advanceManifestBrain(brain);

  const operationRoot = path.join(
    home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    operationRoot,
    scratchQuota,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  try {
    assert.equal(source.revision, pinned.descriptor.cutoffRevision);
    assert.equal(source.manifest.generation, pinned.descriptor.generation);
    assert.deepEqual((await collect(source.iterateNodes())).map((node) => node.concept), [
      'pin canary',
    ]);
  } finally {
    await source.release();
    await scratchQuota.close();
  }
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
    operationId,
    requesterAgent: 'jerry',
    expectedDigest: wrongDigest,
    operationRoot,
    scratchQuota,
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    operationId,
    requesterAgent: 'jerry',
    expectedDigest: pinned.digest,
    expectedCanonicalRoot: path.join(home23Root, 'other'),
    operationRoot,
    scratchQuota,
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    operationId,
    requesterAgent: 'jerry',
    expectedDigest: pinned.digest,
    expectedRevision: pinned.descriptor.cutoffRevision + 1,
    operationRoot,
    scratchQuota,
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    operationId,
    requesterAgent: 'jerry',
    expectedDigest: pinned.digest,
    operationRoot,
  }), { code: 'invalid_request' });
  scratchQuota.close();
});

test('openPinnedSource requires the exact coordinator operation requester and descriptor', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_exact_record';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = path.join(
    home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  const recordPath = path.join(operationRoot, 'coordinator-source-pin.json');
  const originalRecord = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const exact = {
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    operationId,
    requesterAgent: 'jerry',
    operationRoot,
    scratchQuota,
  };

  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    ...exact,
    operationId: 'brop_wrong_operation',
  }), { code: 'source_changed' });
  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    ...exact,
    requesterAgent: 'forrest',
  }), { code: 'source_changed' });

  const wrongDescriptorRecord = structuredClone(originalRecord);
  wrongDescriptorRecord.descriptor.summary.clusterCount += 1;
  await fsp.writeFile(recordPath, `${JSON.stringify(wrongDescriptorRecord, null, 2)}\n`);
  await assert.rejects(() => openPinnedSource(pinned.descriptor, exact), {
    code: 'source_changed',
  });
  await fsp.writeFile(recordPath, `${JSON.stringify(originalRecord, null, 2)}\n`);

  const missingDescriptorRecord = structuredClone(originalRecord);
  delete missingDescriptorRecord.descriptor;
  await fsp.writeFile(recordPath, `${JSON.stringify(missingDescriptorRecord, null, 2)}\n`);
  await assert.rejects(() => openPinnedSource(pinned.descriptor, exact), {
    code: 'source_changed',
  });
  await fsp.writeFile(recordPath, `${JSON.stringify(originalRecord, null, 2)}\n`);

  await assert.rejects(() => openPinnedSource(pinned.descriptor, {
    ...exact,
    expectedDigest: undefined,
  }), { code: 'source_changed' });
  await scratchQuota.close();
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
    requesterAgent: 'jerry',
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

test('stale process pruning treats partial operations as terminal', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-partial-');
  const operationId = 'brop_partial_terminal';
  const processIdentity = 'cosmo-partial-dead-process';
  const pinDir = path.join(
    home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
    'pins',
    processIdentity,
  );
  const pinFile = path.join(pinDir, `${'a'.repeat(64)}.json`);
  await fsp.mkdir(pinDir, { recursive: true });
  await fsp.writeFile(pinFile, `${JSON.stringify({
    pid: 999_994,
    processIdentity,
  })}\n`);
  const canonicalPinFile = await fsp.realpath(pinFile);
  const { pruneStalePins } = require('../../shared/memory-source');

  const removed = await pruneStalePins(home23Root, {
    getOperationState: async (candidate) => {
      assert.equal(candidate, operationId);
      return 'partial';
    },
    isProcessAlive: async () => false,
  });

  assert.deepEqual(removed, [canonicalPinFile]);
  assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), false);
});
