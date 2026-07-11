import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  DURABLE_OPERATION_SOURCE_LOCK_WAIT_MAX_MS,
  coordinatorPinPath,
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  durableBrainOperationRoot,
  openPinnedSource,
  pinOperationSource,
  pruneStalePins,
  retireUnpinnedSources,
  sourceDescriptorDigest,
  withMemorySourceLock,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');
const {
  createDurableOperationLockCapability,
} = require('../../shared/memory-source/durable-lock-authority.cjs');
const { createDefaultLoadAnn } = require('../../engine/src/dashboard/memory-search');
const {
  BrainOperationStore,
} = require('../../engine/src/dashboard/brain-operations/operation-store.js');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeManifestBrain() {
  const brain = await tempDir('home23-memory-source-pin-brain-');
  const nodes = await writeJsonlGzAtomic(path.join(brain, 'nodes.gz'), [{ id: 1, concept: 'pin canary' }]);
  const edges = await writeJsonlGzAtomic(path.join(brain, 'edges.gz'), []);
  await fsp.writeFile(path.join(brain, 'delta.jsonl'), '');
  await fsp.writeFile(path.join(brain, 'ann.index'), 'ann-index-canary\n');
  await fsp.writeFile(path.join(brain, 'ann.meta.json'), '{"dimension":1}\n');
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
    ann: { indexFile: 'ann.index', metaFile: 'ann.meta.json', builtFromRevision: 2 },
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function durableOperationRoot(home23Root, requesterAgent, operationId) {
  return path.join(
    home23Root,
    'instances',
    requesterAgent,
    'runtime',
    'brain-operations',
    'operations',
    operationId,
  );
}

async function createCoordinatorReadFixture(t, suffix) {
  const home23Root = await fsp.realpath(await tempDir(`home23-coordinator-read-${suffix}-home-`));
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = `brop_coordinator_read_${suffix}`;
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const recordPath = path.join(operationRoot, 'coordinator-source-pin.json');
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brain, { recursive: true, force: true }),
  ]));
  return {
    home23Root,
    brain,
    provider,
    operationId,
    operationRoot,
    recordPath,
    pinned,
  };
}

async function oversizeCoordinatorRecord(recordPath) {
  const record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
  await fsp.writeFile(recordPath, `${JSON.stringify({
    ...record,
    padding: 'x'.repeat((1024 * 1024) + 1),
  })}\n`);
}

async function symlinkCoordinatorRecord(t, recordPath, { valid = true } = {}) {
  const outsideRoot = await tempDir('home23-coordinator-read-outside-');
  const outsidePath = path.join(outsideRoot, 'coordinator-source-pin.json');
  const bytes = valid ? await fsp.readFile(recordPath) : Buffer.from('{not-json\n');
  await fsp.writeFile(outsidePath, bytes);
  await fsp.unlink(recordPath);
  await fsp.symlink(outsidePath, recordPath);
  t.after(() => fsp.rm(outsideRoot, { recursive: true, force: true }));
  return { outsidePath, bytes };
}

function residentTarget(canonicalRoot, requesterAgent = 'jerry') {
  return {
    domain: 'brain',
    brainId: `brain-${requesterAgent}`,
    canonicalRoot,
    accessMode: 'own',
    ownerAgent: requesterAgent,
    displayName: requesterAgent,
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-durable-root-test',
    route: `/api/brain/brain-${requesterAgent}`,
    mutationBoundaries: [
      { kind: 'brain', path: canonicalRoot },
      { kind: 'run', path: canonicalRoot },
      { kind: 'pgs', path: path.join(canonicalRoot, 'pgs') },
      { kind: 'session', path: path.join(canonicalRoot, 'sessions') },
      { kind: 'cache', path: path.join(canonicalRoot, 'cache') },
      { kind: 'export', path: path.join(canonicalRoot, 'exports') },
      { kind: 'agency', path: path.join(canonicalRoot, 'agency') },
    ],
  };
}

test('durable operation root rejects dot segments before path construction', async () => {
  const home23Root = path.resolve('/tmp/home23-durable-root-validation');
  for (const [requesterAgent, operationId] of [
    ['..', 'brop_safe'],
    ['.', 'brop_safe'],
    ['jerry', '..'],
    ['jerry', '.'],
  ]) {
    assert.throws(
      () => durableBrainOperationRoot(home23Root, requesterAgent, operationId),
      { code: 'invalid_request' },
    );
  }
});

test('pin provider opens against the exact BrainOperationStore scratch quota root', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-memory-source-pin-store-root-'));
  const brain = await writeManifestBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brain, { recursive: true, force: true }),
  ]));
  const storeRoot = path.join(
    home23Root, 'instances', 'jerry', 'runtime', 'brain-operations',
  );
  await fsp.mkdir(storeRoot, { recursive: true });
  const store = new BrainOperationStore({ root: storeRoot, requesterAgent: 'jerry' });
  const created = await store.create({
    requestId: 'durable-root-synthesis',
    requesterAgent: 'jerry',
    target: residentTarget(await fsp.realpath(brain)),
    operationType: 'synthesis',
    requestParameters: { trigger: 'manual' },
    parameters: { trigger: 'manual', provider: 'test', model: 'test-model' },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: true,
  });
  const operationId = created.record.operationId;
  const scratchDir = await store.ensureScratchDirectory(operationId);
  const operationRoot = path.dirname(scratchDir);
  assert.equal(operationRoot, durableOperationRoot(home23Root, 'jerry', operationId));

  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const pinned = await provider.pin(brain, operationId);
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    operationRoot,
    scratchQuota,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  try {
    assert.equal(source.operationRoot, undefined);
    assert.deepEqual((await collect(source.iterateNodes())).map((node) => node.concept), [
      'pin canary',
    ]);
    assert.equal(
      await fsp.access(path.join(operationRoot, 'coordinator-source-pin.json'))
        .then(() => true).catch(() => false),
      true,
    );
  } finally {
    await source.release();
    await provider.releaseOperationPins(operationId);
    await scratchQuota.close();
  }
});

test('pin discovery includes durable nested and legacy flat operation roots', async (t) => {
  const home23Root = await tempDir('home23-memory-source-discovery-layouts-');
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const brainOperationsRoot = path.join(
    home23Root, 'instances', 'jerry', 'runtime', 'brain-operations',
  );
  const operationIds = {
    durable: 'brop_durable_discovery',
    legacy: 'mcp-legacy-discovery',
  };
  const roots = {
    durable: durableOperationRoot(home23Root, 'jerry', operationIds.durable),
    legacy: path.join(brainOperationsRoot, operationIds.legacy),
  };
  for (const [kind, operationRoot] of Object.entries(roots)) {
    const processIdentity = `${kind}-process`;
    const pinDir = path.join(operationRoot, 'pins', processIdentity);
    await fsp.mkdir(pinDir, { recursive: true });
    await fsp.writeFile(path.join(operationRoot, 'coordinator-source-pin.json'), '{}\n');
    await fsp.writeFile(path.join(pinDir, `${kind === 'durable' ? 'a' : 'b'}`.repeat(64) + '.json'), '{}\n');
  }
  const { discoverOperationPinFiles } = require('../../shared/memory-source');
  const discovered = await discoverOperationPinFiles(home23Root);
  assert.deepEqual(
    discovered.map(({ kind, operationId }) => ({ kind, operationId })),
    [
      { kind: 'coordinator', operationId: operationIds.durable },
      { kind: 'process', operationId: operationIds.durable },
      { kind: 'coordinator', operationId: operationIds.legacy },
      { kind: 'process', operationId: operationIds.legacy },
    ].sort((left, right) => {
      const leftPath = left.operationId === operationIds.durable ? roots.durable : roots.legacy;
      const rightPath = right.operationId === operationIds.durable ? roots.durable : roots.legacy;
      return `${leftPath}/${left.kind}`.localeCompare(`${rightPath}/${right.kind}`);
    }),
  );
});

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
  const scratchPath = path.join(
    durableOperationRoot(home23Root, 'jerry', 'brop_test_pin'),
    'scratch',
  );
  const scratchStat = await fsp.lstat(scratchPath);
  assert.equal(scratchStat.isDirectory(), true);
  assert.equal(scratchStat.isSymbolicLink(), false);
  assert.equal(
    await fsp.realpath(scratchPath),
    path.join(await fsp.realpath(path.dirname(scratchPath)), 'scratch'),
  );
  const recordPath = path.join(
    durableOperationRoot(home23Root, 'jerry', 'brop_test_pin'),
    'coordinator-source-pin.json',
  );
  const record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
  assert.equal(record.physicalRoot, await fsp.realpath(brain));
  assert.equal(record.digest, result.digest);
  assert.deepEqual(record.pinnedManifest, JSON.parse(
    await fsp.readFile(path.join(brain, 'memory-manifest.json'), 'utf8'),
  ));
  assert.deepEqual(record.protectedFileIdentities.map(({ role, file }) => ({ role, file })), [
    { role: 'manifest', file: 'memory-manifest.json' },
    { role: 'nodes', file: 'nodes.gz' },
    { role: 'edges', file: 'edges.gz' },
    { role: 'delta', file: 'delta.jsonl' },
    { role: 'ann-index', file: 'ann.index' },
    { role: 'ann-meta', file: 'ann.meta.json' },
  ]);
  for (const identity of record.protectedFileIdentities) {
    const stat = await fsp.lstat(path.join(brain, identity.file), { bigint: true });
    assert.deepEqual(
      { dev: identity.dev, ino: identity.ino, size: identity.size },
      { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) },
    );
  }
  assert.deepEqual(await provider.pin(brain, 'brop_test_pin'), result);
});

test('durable process-pin open and release wait past the generic 30-second lock window', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-durable-lock-wait-home-'));
  const brain = await writeManifestBrain();
  const operationId = 'brop_durable_lock_wait';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const clock = { value: Date.now(), now() { return this.value; } };
  let phaseStartedAt = clock.value;
  let releaseHolder = null;
  const retryElapsed = [];
  const provider = createMemorySourcePinProvider({
    home23Root,
    requesterAgent: 'jerry',
    _durableLockClock: clock,
    _durableLockRetryMs: 1,
    _durableLockJitterMs: 0,
    _durableLockTestHooks: {
      beforeLockRetry({ elapsedMs }) {
        retryElapsed.push(elapsedMs);
        clock.value += 20_000;
        if (clock.value - phaseStartedAt > 30_000) releaseHolder?.();
      },
    },
  });
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brain, { recursive: true, force: true }),
  ]));
  const control = () => ({
    hardDeadlineAt: new Date(
      clock.value + DURABLE_OPERATION_SOURCE_LOCK_WAIT_MAX_MS,
    ).toISOString(),
    signal: null,
    cleanupSignal: null,
  });
  const authority = () => createDurableOperationLockCapability(control());

  async function holdSourceLock() {
    const entered = deferred();
    const released = deferred();
    releaseHolder = released.resolve;
    const held = withMemorySourceLock(brain, { lockRoot }, async () => {
      entered.resolve();
      await released.promise;
    });
    await entered.promise;
    return { held };
  }

  phaseStartedAt = clock.value;
  const { held: heldForPin } = await holdSourceLock();
  const pinned = await provider.pin(brain, operationId, authority());
  await heldForPin;
  assert.equal(clock.value - phaseStartedAt > 30_000, true);

  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  t.after(() => scratchQuota.close());

  phaseStartedAt = clock.value;
  const { held: heldForOpen } = await holdSourceLock();
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    operationRoot,
    scratchQuota,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    lockTimeoutMs: 0,
  }, authority());
  await heldForOpen;
  assert.equal(clock.value - phaseStartedAt > 30_000, true);
  assert.equal(retryElapsed.some((elapsed) => elapsed >= 20_000), true);
  await source.release();

  phaseStartedAt = clock.value;
  const { held: heldForRelease } = await holdSourceLock();
  const expiredReleaseAuthority = createDurableOperationLockCapability({
    hardDeadlineAt: new Date(clock.value - 1).toISOString(),
    signal: new AbortController().signal,
    cleanupSignal: null,
  });
  await provider.releaseOperationPins(operationId, expiredReleaseAuthority);
  await heldForRelease;
  assert.equal(clock.value - phaseStartedAt > 30_000, true);
  assert.equal(
    await fsp.access(coordinatorPinPath(operationRoot)).then(() => true).catch(() => false),
    false,
  );
});

test('public provider rejects a shape-forged durable lock control and preserves the generic bound', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-forged-lock-control-home-'));
  const brain = await writeManifestBrain();
  const operationId = 'brop_forged_lock_control';
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brain, { recursive: true, force: true }),
  ]));
  const entered = deferred();
  const release = deferred();
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  t.after(() => scratchQuota.close());
  const forged = {
    hardDeadlineAt: new Date(Date.now() + DURABLE_OPERATION_SOURCE_LOCK_WAIT_MAX_MS).toISOString(),
    signal: null,
    cleanupSignal: null,
  };
  await assert.rejects(
    () => provider.openPinnedSource(pinned.descriptor, {
      operationId,
      operationRoot,
      scratchQuota,
      expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
    }, forged),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    () => provider.releaseOperationPins(operationId, forged),
    { code: 'invalid_request' },
  );
  assert.equal(
    await fsp.access(coordinatorPinPath(operationRoot)).then(() => true).catch(() => false),
    true,
  );
  const held = withMemorySourceLock(brain, { lockRoot }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await assert.rejects(
      () => provider.pin(brain, `${operationId}_other`, forged),
      { code: 'invalid_request' },
    );
  } finally {
    release.resolve();
    await held;
  }
  await provider.releaseOperationPins(operationId);
});

test('coordinator pin retry rejects an oversized durable record', async (t) => {
  const fixture = await createCoordinatorReadFixture(t, 'retry_oversized');
  const scratchQuota = await createOperationScratchQuota({
    operationRoot: fixture.operationRoot,
  });
  t.after(() => scratchQuota.close());
  await oversizeCoordinatorRecord(fixture.recordPath);

  await assert.rejects(
    () => pinOperationSource({
      canonicalRoot: fixture.brain,
      operationRoot: fixture.operationRoot,
      operationId: fixture.operationId,
      requesterAgent: 'jerry',
      lockRoot: path.join(fixture.home23Root, 'runtime', 'brain-source-locks'),
      scratchQuota,
    }),
    { code: 'source_pin_conflict', retryable: true },
  );
});

test('coordinator pin retry never follows a durable-record symlink', async (t) => {
  const fixture = await createCoordinatorReadFixture(t, 'retry_symlink');
  const scratchQuota = await createOperationScratchQuota({
    operationRoot: fixture.operationRoot,
  });
  t.after(() => scratchQuota.close());
  const outside = await symlinkCoordinatorRecord(t, fixture.recordPath);

  await assert.rejects(
    () => pinOperationSource({
      canonicalRoot: fixture.brain,
      operationRoot: fixture.operationRoot,
      operationId: fixture.operationId,
      requesterAgent: 'jerry',
      lockRoot: path.join(fixture.home23Root, 'runtime', 'brain-source-locks'),
      scratchQuota,
    }),
    { code: 'source_pin_conflict', retryable: true },
  );
  assert.deepEqual(await fsp.readFile(outside.outsidePath), outside.bytes);
});

test('pinned opener rejects an oversized coordinator record as changed source truth', async (t) => {
  const fixture = await createCoordinatorReadFixture(t, 'open_oversized');
  const scratchQuota = await createOperationScratchQuota({
    operationRoot: fixture.operationRoot,
  });
  let source = null;
  t.after(() => scratchQuota.close());
  await oversizeCoordinatorRecord(fixture.recordPath);

  try {
    await assert.rejects(async () => {
      source = await fixture.provider.openPinnedSource(fixture.pinned.descriptor, {
        operationId: fixture.operationId,
        scratchQuota,
        expectedCanonicalRoot: fixture.pinned.descriptor.canonicalRoot,
        expectedRevision: fixture.pinned.descriptor.cutoffRevision,
        expectedDigest: fixture.pinned.digest,
      });
    }, { code: 'source_changed', retryable: true });
  } finally {
    await source?.release().catch(() => {});
  }
});

test('pinned opener never follows a coordinator-record symlink', async (t) => {
  const fixture = await createCoordinatorReadFixture(t, 'open_symlink');
  const scratchQuota = await createOperationScratchQuota({
    operationRoot: fixture.operationRoot,
  });
  const outside = await symlinkCoordinatorRecord(t, fixture.recordPath);
  let source = null;
  t.after(() => scratchQuota.close());

  try {
    await assert.rejects(async () => {
      source = await fixture.provider.openPinnedSource(fixture.pinned.descriptor, {
        operationId: fixture.operationId,
        scratchQuota,
        expectedCanonicalRoot: fixture.pinned.descriptor.canonicalRoot,
        expectedRevision: fixture.pinned.descriptor.cutoffRevision,
        expectedDigest: fixture.pinned.digest,
      });
    }, { code: 'source_changed', retryable: true });
  } finally {
    await source?.release().catch(() => {});
  }
  assert.deepEqual(await fsp.readFile(outside.outsidePath), outside.bytes);
});

test('terminal release rejects an oversized coordinator record before cleanup', async (t) => {
  const fixture = await createCoordinatorReadFixture(t, 'release_oversized');
  await oversizeCoordinatorRecord(fixture.recordPath);

  await assert.rejects(
    () => fixture.provider.releaseOperationPins(fixture.operationId),
    { code: 'result_too_large', retryable: false },
  );
  assert.equal(await fsp.lstat(fixture.recordPath).then((stat) => stat.isFile()), true);
});

test('terminal release rejects a coordinator-record symlink before reading its target', async (t) => {
  const fixture = await createCoordinatorReadFixture(t, 'release_symlink');
  const outside = await symlinkCoordinatorRecord(t, fixture.recordPath, { valid: false });

  await assert.rejects(
    () => fixture.provider.releaseOperationPins(fixture.operationId),
    { code: 'invalid_memory_source', retryable: false },
  );
  assert.deepEqual(await fsp.readFile(outside.outsidePath), outside.bytes);
});

const protectedReplacementCases = [
  ['manifest', 'memory-manifest.json'],
  ['nodes', 'nodes.gz'],
  ['edges', 'edges.gz'],
  ['delta', 'delta.jsonl'],
  ['ann-index', 'ann.index'],
  ['ann-meta', 'ann.meta.json'],
];

for (const [role, file] of protectedReplacementCases) {
  test(`identical coordinator pin retry rejects a replaced ${role} identity`, async (t) => {
    const home23Root = await tempDir('home23-memory-source-pin-retry-home-');
    const brain = await writeManifestBrain();
    const operationId = `brop_retry_replace_${role.replace('-', '_')}`;
    const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
    t.after(() => Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brain, { recursive: true, force: true }),
    ]));
    await provider.pin(brain, operationId);
    const recordPath = path.join(
      durableOperationRoot(home23Root, 'jerry', operationId),
      'coordinator-source-pin.json',
    );
    const recordBefore = await fsp.readFile(recordPath);
    const target = path.join(brain, file);
    const displaced = `${target}.retry-displaced`;
    await fsp.rename(target, displaced);
    await fsp.copyFile(displaced, target);

    await assert.rejects(() => provider.pin(brain, operationId), {
      code: 'source_changed',
      retryable: true,
    });
    assert.deepEqual(await fsp.readFile(recordPath), recordBefore);
  });
}

test('coordinator pin publication fsyncs its file and operation-root directory', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-memory-source-pin-fsync-home-'));
  const brain = await writeManifestBrain();
  const operationId = 'brop_coordinator_fsync';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const originalOpen = fsp.open;
  const synced = [];
  t.after(async () => {
    fsp.open = originalOpen;
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brain, { recursive: true, force: true }),
    ]);
  });
  fsp.open = async (filePath, ...args) => {
    const handle = await originalOpen.call(fsp, filePath, ...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') {
          return async () => {
            synced.push(String(filePath));
            return target.sync();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  await provider.pin(brain, operationId);
  assert.equal(synced.some((entry) =>
    entry.startsWith(path.join(operationRoot, 'coordinator-source-pin.json.'))
      && entry.endsWith('.tmp')), true);
  assert.equal(synced.includes(operationRoot), true);
});

test('failed coordinator rename removes only its owned temporary file', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-memory-source-pin-temp-home-'));
  const brain = await writeManifestBrain();
  const operationId = 'brop_coordinator_temp_cleanup';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const recordPath = path.join(operationRoot, 'coordinator-source-pin.json');
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const originalRename = fsp.rename;
  t.after(async () => {
    fsp.rename = originalRename;
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brain, { recursive: true, force: true }),
    ]);
  });
  fsp.rename = async (source, destination) => {
    if (destination === recordPath) {
      throw Object.assign(new Error('injected coordinator rename failure'), { code: 'EIO' });
    }
    return originalRename.call(fsp, source, destination);
  };

  await assert.rejects(() => provider.pin(brain, operationId), { code: 'EIO' });
  assert.deepEqual(
    (await fsp.readdir(operationRoot)).filter((name) =>
      name.startsWith('coordinator-source-pin.json.') && name.endsWith('.tmp')),
    [],
  );
});

for (const [role, file] of protectedReplacementCases) {
  test(`openPinnedSource rejects an inode replacement of the pinned ${role} file`, async () => {
    const home23Root = await tempDir('home23-memory-source-pin-replacement-home-');
    const brain = await writeManifestBrain();
    const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
    const operationId = `brop_test_replace_${role.replace('-', '_')}`;
    const pinned = await provider.pin(brain, operationId);
    const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
    const scratchQuota = await createOperationScratchQuota({ operationRoot });
    const target = path.join(brain, file);
    const displaced = `${target}.displaced`;
    await fsp.rename(target, displaced);
    await fsp.copyFile(displaced, target);
    let source = null;
    try {
      await assert.rejects(async () => {
        source = await provider.openPinnedSource(pinned.descriptor, {
          operationId,
          scratchQuota,
          expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
          expectedRevision: pinned.descriptor.cutoffRevision,
          expectedDigest: pinned.digest,
        });
        return source;
      }, { code: 'source_changed' });
    } finally {
      await source?.release();
      await scratchQuota.close();
    }
  });
}

test('pinOperationSource rechecks captured file identities before coordinator publication', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-race-home-');
  const brain = await writeManifestBrain();
  const operationId = 'brop_test_pin_capture_race';
  const operationRoot = path.join(
    home23Root, 'instances', 'jerry', 'runtime', 'brain-operations', operationId,
  );
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const target = path.join(brain, 'nodes.gz');
  try {
    await assert.rejects(() => pinOperationSource({
      canonicalRoot: brain,
      operationRoot,
      operationId,
      requesterAgent: 'jerry',
      lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
      scratchQuota,
      _testHooks: {
        async beforeCoordinatorPublish() {
          const displaced = `${target}.displaced`;
          await fsp.rename(target, displaced);
          await fsp.copyFile(displaced, target);
        },
      },
    }), { code: 'source_changed' });
    assert.equal(
      await fsp.access(path.join(operationRoot, 'coordinator-source-pin.json'))
        .then(() => true).catch(() => false),
      false,
    );
  } finally {
    await scratchQuota.close();
  }
});

test('openPinnedSource validates coordinator record and writes a separate process pin', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_open';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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

test('an opened pinned source reads its anchored base handle after pathname replacement', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-anchored-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_anchored_base';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    scratchQuota,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  try {
    const nodesPath = path.join(brain, 'nodes.gz');
    await fsp.rename(nodesPath, `${nodesPath}.displaced`);
    await fsp.writeFile(nodesPath, 'replacement is not the pinned gzip');
    assert.deepEqual((await collect(source.iterateNodes())).map((node) => node.concept), [
      'pin canary',
    ]);
  } finally {
    await source.release();
    await scratchQuota.close();
  }
});

test('ANN loading uses anchored index and metadata handles after pathname replacement', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-ann-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_anchored_ann';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    scratchQuota,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  const pathsRead = [];
  class FakeIndex {
    readIndexSync(filePath) { pathsRead.push(filePath); }
    setEf() {}
  }
  try {
    for (const file of ['ann.index', 'ann.meta.json']) {
      const target = path.join(brain, file);
      await fsp.rename(target, `${target}.displaced`);
      await fsp.writeFile(target, 'replacement must not be loaded');
    }
    const ann = await createDefaultLoadAnn({
      hnswlibLoader: () => ({ HierarchicalNSW: FakeIndex }),
    })(source, source.manifest.ann);
    assert.equal(ann.dimension, 1);
    assert.equal(pathsRead.length, 1);
    assert.match(pathsRead[0], /^\/(dev\/fd|proc\/self\/fd)\/[0-9]+$/);
    assert.notEqual(pathsRead[0], path.join(brain, 'ann.index'));
  } finally {
    await source.release();
    await scratchQuota.close();
  }
});

test('openPinnedSource binds a safe PID-plus-start process identity and rolls back failed opens', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_process_identity';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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
  await source.release();
  assert.deepEqual(Object.keys(processRecord).sort(), [
    'bootToken',
    'canonicalRoot',
    'committedBytes',
    'createdAt',
    'digest',
    'generation',
    'heartbeatAt',
    'operationId',
    'pid',
    'processIdentity',
    'processStartToken',
    'protectedFiles',
    'requesterAgent',
    'revision',
    'version',
  ]);
  assert.equal(processRecord.processIdentity, processIdentity);
  assert.deepEqual(processRecord.protectedFiles, [
    'nodes.gz',
    'edges.gz',
    'delta.jsonl',
    'ann.index',
    'ann.meta.json',
  ]);
  assert.equal(processRecord.committedBytes, 0);
  assert.equal(processRecord.pid, process.pid);
  assert.equal(typeof processRecord.bootToken, 'string');
  assert.notEqual(processRecord.bootToken.length, 0);
  assert.equal(typeof processRecord.processStartToken, 'string');
  assert.notEqual(processRecord.processStartToken.length, 0);
  assert.equal(Number.isNaN(Date.parse(processRecord.createdAt)), false);
  assert.equal(Number.isNaN(Date.parse(processRecord.heartbeatAt)), false);
  assert.equal(Date.parse(processRecord.heartbeatAt) >= Date.parse(processRecord.createdAt), true);
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
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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
  const first = await openPinnedSource(pinned.descriptor, exact);
  const pinDir = path.join(operationRoot, 'pins', processIdentity);
  const [pinName] = await fsp.readdir(pinDir);
  const pinFile = path.join(pinDir, pinName);
  const initialRecord = JSON.parse(await fsp.readFile(pinFile, 'utf8'));
  const second = await openPinnedSource(pinned.descriptor, exact);
  try {
    const heartbeatRecord = JSON.parse(await fsp.readFile(pinFile, 'utf8'));
    assert.equal(heartbeatRecord.createdAt, initialRecord.createdAt);
    assert.equal(
      Date.parse(heartbeatRecord.heartbeatAt) > Date.parse(initialRecord.heartbeatAt),
      true,
    );

    await first.release();
    assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), true);
    assert.deepEqual((await collect(second.iterateNodes())).map((node) => node.concept), [
      'pin canary',
    ]);
    await first.release();
    assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), true);

    await second.release();
    assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), false);
  } finally {
    await first.release().catch(() => {});
    await second.release().catch(() => {});
  }
  await scratchQuota.close();
});

test('process pin publication heartbeat and removal are atomically fsynced', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-process-pin-fsync-home-'));
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_process_pin_fsync';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const quota = await createOperationScratchQuota({ operationRoot });
  const processIdentity = 'cosmo-process-fsync';
  const pinDir = path.join(operationRoot, 'pins', processIdentity);
  const pinsRoot = path.dirname(pinDir);
  const originalOpen = fsp.open;
  const synced = [];
  t.after(async () => {
    fsp.open = originalOpen;
    await provider.releaseOperationPins(operationId).catch(() => {});
    await quota.close();
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brain, { recursive: true, force: true }),
    ]);
  });
  fsp.open = async (filePath, ...args) => {
    const handle = await originalOpen.call(fsp, filePath, ...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') {
          return async () => {
            synced.push(String(filePath));
            return target.sync();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    scratchQuota: quota,
    processIdentity,
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  try {
    const processTemps = (await fsp.readdir(pinDir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(processTemps, []);
    assert.equal(synced.some((entry) => entry.startsWith(pinDir) && entry.endsWith('.tmp')), true);
    assert.equal(synced.includes(pinDir), true);
    await source.release();
    assert.equal(synced.includes(pinsRoot), true);
  } finally {
    await source.release().catch(() => {});
  }
});

test('pinned opener holds the external source lock through process-pin publication', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-process-pin-order-home-'));
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_process_pin_lock_order';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const quota = await createOperationScratchQuota({ operationRoot });
  const entered = deferred();
  const release = deferred();
  let source = null;
  let opening = null;
  t.after(async () => {
    release.resolve();
    if (!source && opening) source = await opening.catch(() => null);
    await source?.release().catch(() => {});
    await provider.releaseOperationPins(operationId).catch(() => {});
    await quota.close();
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brain, { recursive: true, force: true }),
    ]);
  });

  opening = provider.openPinnedSource(pinned.descriptor, {
    operationId,
    scratchQuota: quota,
    processIdentity: 'cosmo-process-order',
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    _testHooks: {
      async beforeProcessPinPublish() {
        entered.resolve();
        await release.promise;
      },
    },
  });
  await Promise.race([
    entered.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('process pin hook not reached')), 100)),
  ]);
  let retirementFinished = false;
  const retirement = retireUnpinnedSources(brain, {
    home23Root,
    lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
  }).then((result) => {
    retirementFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retirementFinished, false);
  release.resolve();
  source = await opening;
  await retirement;
});

test('default stale-pin pruning rejects PID reuse with a different process-start token', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-process-pin-reuse-home-'));
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_process_pin_pid_reuse';
  const pinned = await provider.pin(brain, operationId);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const quota = await createOperationScratchQuota({ operationRoot });
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    scratchQuota: quota,
    processIdentity: 'cosmo-process-reuse',
    expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  t.after(async () => {
    await source.close().catch(() => {});
    await provider.releaseOperationPins(operationId).catch(() => {});
    await quota.close();
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brain, { recursive: true, force: true }),
    ]);
  });
  const pinDir = path.join(operationRoot, 'pins', 'cosmo-process-reuse');
  const [pinName] = await fsp.readdir(pinDir);
  const pinFile = path.join(pinDir, pinName);
  const record = JSON.parse(await fsp.readFile(pinFile, 'utf8'));
  await fsp.writeFile(pinFile, `${JSON.stringify({
    ...record,
    processStartToken: `${record.processStartToken}-reused`,
  })}\n`);

  const removed = await pruneStalePins(home23Root, {
    getOperationState: async () => 'interrupted',
  });
  assert.deepEqual(removed, [await fsp.realpath(pinFile).catch(() => pinFile)]);
  assert.equal(await fsp.access(pinFile).then(() => true).catch(() => false), false);
});

test('native operation pin reads its exact revision after the live manifest advances', async () => {
  const home23Root = await tempDir('home23-memory-source-pin-home-');
  const brain = await writeManifestBrain();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_test_native_revision';
  const pinned = await provider.pin(brain, operationId);

  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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
    await advanceManifestBrain(brain);
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
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
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

test('terminal release retries an exact projection quarantine after a crash before removal', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-release-quarantine-retry-'));
  const operationId = 'brop_release_quarantine_retry';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const projectionRoot = path.join(operationRoot, 'source-projections');
  const brain = path.join(home23Root, 'targets', 'brain');
  const coordinatorRecord = coordinatorPinPath(operationRoot);
  await fsp.mkdir(projectionRoot, { recursive: true });
  await fsp.mkdir(brain, { recursive: true });
  await fsp.mkdir(path.join(home23Root, 'runtime', 'brain-source-locks'), { recursive: true });
  await fsp.writeFile(coordinatorRecord, `${JSON.stringify({
    canonicalRoot: await fsp.realpath(brain),
  })}\n`);
  await fsp.writeFile(path.join(projectionRoot, 'canary'), 'owned projection\n');
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const { releaseOperationSource } = require('../../shared/memory-source');
  let injected = false;

  await assert.rejects(
    releaseOperationSource({
      home23Root,
      requesterAgent: 'jerry',
      operationId,
      _testHooks: {
        beforeQuarantineRemove({ label }) {
          if (label !== 'source projections root' || injected) return;
          injected = true;
          throw Object.assign(new Error('simulated crash after projection quarantine rename'), {
            code: 'EIO',
          });
        },
      },
    }),
    { code: 'EIO' },
  );
  assert.equal(await fsp.access(projectionRoot).then(() => true).catch(() => false), false);
  assert.equal(
    await fsp.access(coordinatorRecord).then(() => true).catch(() => false),
    true,
    'coordinator source authority must survive until directory cleanup commits',
  );
  const quarantines = (await fsp.readdir(operationRoot))
    .filter((name) => name.startsWith('.source-release-source-projections-'));
  assert.equal(quarantines.length, 1);
  assert.equal(
    await fsp.readFile(path.join(operationRoot, quarantines[0], 'canary'), 'utf8'),
    'owned projection\n',
  );

  const lockEntered = deferred();
  const unlock = deferred();
  const held = withMemorySourceLock(
    await fsp.realpath(brain),
    { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') },
    async () => {
      lockEntered.resolve();
      await unlock.promise;
    },
  );
  await lockEntered.promise;
  let retrySettled = false;
  const retry = releaseOperationSource({ home23Root, requesterAgent: 'jerry', operationId })
    .then(() => { retrySettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(retrySettled, false, 'retry must reacquire the retained source authority lock');
  unlock.resolve();
  await Promise.all([held, retry]);
  assert.equal((await fsp.readdir(operationRoot))
    .some((name) => name.startsWith('.source-release-source-projections-')), false);
  assert.equal(await fsp.access(coordinatorRecord).then(() => true).catch(() => false), false);
});

test('terminal release never follows or removes a forged projection quarantine', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-release-forged-quarantine-'));
  const outside = await fsp.realpath(await tempDir('home23-release-forged-quarantine-outside-'));
  const operationId = 'brop_release_forged_quarantine';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const outsideCanary = path.join(outside, 'canary');
  await fsp.mkdir(operationRoot, { recursive: true });
  await fsp.writeFile(outsideCanary, 'outside survives\n');
  await fsp.symlink(
    outside,
    path.join(operationRoot, '.source-release-source-projections-1-2'),
    'dir',
  );
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  const { releaseOperationSource } = require('../../shared/memory-source');

  await assert.rejects(
    releaseOperationSource({ home23Root, requesterAgent: 'jerry', operationId }),
    { code: 'invalid_memory_source' },
  );
  assert.equal(await fsp.readFile(outsideCanary, 'utf8'), 'outside survives\n');
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

test('terminal source release rejects a symlinked operation root without deleting outside data', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-memory-source-release-confined-'));
  const outside = await fsp.realpath(await tempDir('home23-memory-source-release-outside-'));
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  const operationId = 'brop_symlink_release';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const operationsRoot = path.dirname(operationRoot);
  await fsp.mkdir(operationsRoot, { recursive: true });
  for (const relative of [
    'coordinator-source-pin.json',
    path.join('pins', 'canary'),
    path.join('source-projections', 'canary'),
  ]) {
    const target = path.join(outside, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, `${relative}\n`);
  }
  await fsp.symlink(outside, operationRoot, 'dir');
  const { releaseOperationSource } = require('../../shared/memory-source');

  await assert.rejects(
    releaseOperationSource({ home23Root, requesterAgent: 'jerry', operationId }),
    { code: 'invalid_memory_source' },
  );
  for (const relative of [
    'coordinator-source-pin.json',
    path.join('pins', 'canary'),
    path.join('source-projections', 'canary'),
  ]) {
    assert.equal(await fsp.readFile(path.join(outside, relative), 'utf8'), `${relative}\n`);
  }
});

test('process-pin release rejects an operation-root swap without deleting the replacement target', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-memory-source-process-release-'));
  const outside = await fsp.realpath(await tempDir('home23-memory-source-process-outside-'));
  const brain = await writeManifestBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
    fsp.rm(brain, { recursive: true, force: true }),
  ]));
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_process_release_swap';
  const pinned = await provider.pin(brain, operationId);
  const canonicalBrain = await fsp.realpath(brain);
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const originalOpen = fsp.open;
  const closedProtectedFiles = new Set();
  fsp.open = async (filePath, ...args) => {
    const handle = await originalOpen.call(fsp, filePath, ...args);
    const candidate = String(filePath);
    if (!candidate.startsWith(`${canonicalBrain}${path.sep}`)) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'close') {
          return async () => {
            closedProtectedFiles.add(path.basename(candidate));
            return target.close();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let source;
  try {
    source = await provider.openPinnedSource(pinned.descriptor, {
      operationId,
      scratchQuota,
      expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
    });
  } finally {
    fsp.open = originalOpen;
  }
  const processIdentity = (await fsp.readdir(path.join(operationRoot, 'pins')))[0];
  const pinName = (await fsp.readdir(path.join(operationRoot, 'pins', processIdentity)))[0];
  const outsidePin = path.join(outside, 'pins', processIdentity, pinName);
  await fsp.mkdir(path.dirname(outsidePin), { recursive: true });
  await fsp.writeFile(outsidePin, 'outside process pin must survive\n');
  const displaced = `${operationRoot}.displaced`;
  await fsp.rename(operationRoot, displaced);
  await fsp.symlink(outside, operationRoot, 'dir');

  await assert.rejects(source.release(), { code: 'invalid_memory_source' });
  assert.equal(await fsp.readFile(outsidePin, 'utf8'), 'outside process pin must survive\n');
  assert.deepEqual([...closedProtectedFiles].sort(), [
    'ann.index',
    'ann.meta.json',
    'delta.jsonl',
    'edges.gz',
    'memory-manifest.json',
    'nodes.gz',
  ]);
  try {
    await scratchQuota.close();
  } catch {}
});

test('stale-pin pruning rejects an operation-root swap without deleting the replacement target', async (t) => {
  const home23Root = await fsp.realpath(await tempDir('home23-memory-source-prune-confined-'));
  const outside = await fsp.realpath(await tempDir('home23-memory-source-prune-outside-'));
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  const operationId = 'brop_prune_swap';
  const operationRoot = durableOperationRoot(home23Root, 'jerry', operationId);
  const processIdentity = 'dead-process';
  const pinName = `${'e'.repeat(64)}.json`;
  const pinFile = path.join(operationRoot, 'pins', processIdentity, pinName);
  await fsp.mkdir(path.dirname(pinFile), { recursive: true });
  await fsp.writeFile(pinFile, '{"pid":999994}\n');
  const outsidePin = path.join(outside, 'pins', processIdentity, pinName);
  await fsp.mkdir(path.dirname(outsidePin), { recursive: true });
  await fsp.writeFile(outsidePin, 'outside stale pin must survive\n');
  const displaced = `${operationRoot}.displaced`;
  let swapped = false;
  const { pruneStalePins } = require('../../shared/memory-source');

  await assert.rejects(pruneStalePins(home23Root, {
    async isProcessAlive() {
      await fsp.rename(operationRoot, displaced);
      await fsp.symlink(outside, operationRoot, 'dir');
      swapped = true;
      return false;
    },
    async getOperationState() { return 'interrupted'; },
  }), { code: 'invalid_memory_source' });
  assert.equal(swapped, true);
  assert.equal(await fsp.readFile(outsidePin, 'utf8'), 'outside stale pin must survive\n');
});
