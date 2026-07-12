'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  createOperationScratchQuota,
} = require('../../shared/memory-source/scratch-quota.cjs');
const {
  canonicalJson,
  sourceDescriptorDigest,
} = require('../../shared/memory-source/contracts.cjs');
const {
  openPinnedPGSStore,
} = require('../../cosmo23/pgs-engine/src/pinned-store');

function descriptor(revision = 3, nodeCount = 600, edgeCount = 599) {
  return {
    version: 1,
    canonicalRoot: '/synthetic/pinned-brain',
    generation: `g${revision}`,
    baseRevision: revision,
    cutoffRevision: revision,
    summary: { nodeCount, edgeCount, clusterCount: 3 },
    activeBase: {
      nodes: { file: 'nodes.jsonl.gz', count: nodeCount, bytes: 1 },
      edges: { file: 'edges.jsonl.gz', count: edgeCount, bytes: 1 },
    },
    activeDelta: {
      epoch: 'e1', file: 'delta.jsonl', fromRevision: revision + 1,
      toRevision: revision, count: 0, committedBytes: 0,
    },
  };
}

function syntheticSource({
  revision = 3,
  nodeCount = 600,
  edgeCount = 599,
  oversized = false,
  onNode = null,
} = {}) {
  return {
    revision,
    descriptor: descriptor(revision, nodeCount, edgeCount),
    async *iterateNodes({ signal } = {}) {
      for (let index = 0; index < nodeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        onNode?.(index);
        yield {
          id: `n${index}`,
          clusterId: `cluster-${index % 3}`,
          content: oversized && index === 0 ? 'x'.repeat(257 * 1024) : `node ${index}`,
        };
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edgeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        yield { source: `n${index}`, target: `n${index + 1}`, type: 'next' };
      }
    },
    loadAll() { throw new Error('materializer forbidden'); },
    loadState() { throw new Error('materializer forbidden'); },
  };
}

async function fixture(t, maxBytes = 64 * 1024 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-store-'));
  const operationRoot = path.join(root, 'instances', 'jerry', 'runtime', 'brain-operations', 'op-pgs');
  const scratchDir = path.join(operationRoot, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  t.after(async () => {
    quota.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, operationRoot, scratchDir, quota };
}

const limits = {
  maxScratchBytes: 64 * 1024 * 1024,
  minFreeScratchBytes: 1,
  maxTransactionRecords: 100,
  maxTransactionBytes: 1024 * 1024,
  maxNodesPerWorkUnit: 25,
  maxContextCharsPerWorkUnit: 4096,
};

const query = 'What does the pinned evidence show?';

test('streams a revision-bound projection and creates deterministic bounded work units', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({}),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  });
  t.after(() => store.close());

  assert.equal(store.stats.nodeCount, 600);
  assert.equal(store.stats.edgeCount, 599);
  assert.equal(store.stats.maxTransactionRecords <= 100, true);
  assert.equal(store.stats.maxTransactionBytes <= 1024 * 1024, true);
  assert.equal(store.stats.maxRetainedRecords <= 100, true);
  assert.equal(store.stats.workUnitCount > 3, true);

  const pending = store.snapshotPendingWorkUnits({ attemptId: 'attempt-1', limit: 10 });
  assert.equal(pending.length, 10);
  assert.deepEqual(
    pending.slice(0, 3).map(workUnitId => store.loadWorkUnit(workUnitId).partitionId),
    ['c-cluster-0', 'c-cluster-1', 'c-cluster-2'],
  );
  const unit = store.loadWorkUnit(pending[0]);
  assert.equal(unit.nodes.length <= 25, true);
  assert.equal(unit.stats.contextChars <= 4096, true);
  assert.match(unit.workUnitId, /^p-c-cluster-[0-2]-u\d{4}$/);
});

test('rejects a symlinked PGS directory without touching its outside target', async t => {
  const { scratchDir, quota } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-store-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const sourcePin = syntheticSource({ nodeCount: 1, edgeCount: 0 });
  const component = `${sourceDescriptorDigest(sourcePin.descriptor)}-r${sourcePin.revision}`;
  const outsideComponent = path.join(outside, component);
  const canary = path.join(outsideComponent, 'keep.txt');
  await fs.mkdir(outsideComponent, { recursive: true });
  await fs.writeFile(canary, 'outside content must survive\n');
  await fs.symlink(outside, path.join(scratchDir, 'pgs'));

  await assert.rejects(
    () => openPinnedPGSStore({
      sourcePin,
      scratchDir,
      scratchQuota: quota,
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
      query,
      signal: new AbortController().signal,
      limits,
    }),
    { code: 'invalid_request' },
  );
  assert.equal(await fs.readFile(canary, 'utf8'), 'outside content must survive\n');
  assert.deepEqual(await fs.readdir(outsideComponent), ['keep.txt']);
});

test('rejects a symlinked revision directory without touching its outside target', async t => {
  const { scratchDir, quota } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-revision-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const sourcePin = syntheticSource({ nodeCount: 1, edgeCount: 0 });
  const component = `${sourceDescriptorDigest(sourcePin.descriptor)}-r${sourcePin.revision}`;
  const pgsRoot = path.join(scratchDir, 'pgs');
  const canary = path.join(outside, 'keep.txt');
  await fs.mkdir(pgsRoot);
  await fs.writeFile(canary, 'outside content must survive\n');
  await fs.symlink(outside, path.join(pgsRoot, component));

  await assert.rejects(
    () => openPinnedPGSStore({
      sourcePin,
      scratchDir,
      scratchQuota: quota,
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
      query,
      signal: new AbortController().signal,
      limits,
    }),
    { code: 'invalid_request' },
  );
  assert.equal(await fs.readFile(canary, 'utf8'), 'outside content must survive\n');
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});

test('persists successful work idempotently and leaves failed work pending', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 12, edgeCount: 11 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 2 },
  });
  t.after(() => store.close());

  const [first, second] = store.snapshotPendingWorkUnits({ attemptId: 'attempt-2', limit: 2 });
  store.beginWorkUnitAttempt(first, {
    attemptId: 'attempt-2', provider: 'minimax', model: 'MiniMax-M3',
  });
  store.beginWorkUnitAttempt(second, {
    attemptId: 'attempt-2', provider: 'minimax', model: 'MiniMax-M3',
  });
  await store.commitSuccessfulSweeps([{ workUnitId: first, output: 'durable finding' }]);
  await store.commitSuccessfulSweeps([{ workUnitId: first, output: 'durable finding' }]);
  store.recordRetryableFailure(second, Object.assign(new Error('retry'), { code: 'provider_failed' }));

  assert.deepEqual(store.listSuccessfulSweeps().map(row => row.output), ['durable finding']);
  assert.equal(store.countPendingWorkUnits(), store.stats.workUnitCount - 1);
  assert.equal(store.listRetryablePartitions().length > 0, true);
  await assert.rejects(
    store.commitSuccessfulSweeps([{ workUnitId: first, output: 'changed' }]),
    error => error.code === 'pgs_state_conflict',
  );
});

test('caps cumulative durable sweep output before every retry commit', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 2, edgeCount: 0 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: {
      ...limits,
      maxNodesPerWorkUnit: 1,
      maxSelectedWorkUnits: 16,
      maxSweepOutputBytes: 64,
      maxTotalSweepOutputBytes: 64,
    },
  });
  t.after(() => store.close());

  const [first, second] = store.snapshotPendingWorkUnits({
    attemptId: 'attempt-cumulative-cap',
    limit: 2,
  });
  for (const workUnitId of [first, second]) {
    store.beginWorkUnitAttempt(workUnitId, {
      attemptId: 'attempt-cumulative-cap',
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
  }
  const escapedOutput = '"\n'.repeat(20);
  assert.equal(Buffer.byteLength(escapedOutput, 'utf8'), 40);
  assert.equal(Buffer.byteLength(canonicalJson({ output: escapedOutput }), 'utf8') > 64, true);
  await assert.rejects(
    store.commitSuccessfulSweeps([{ workUnitId: first, output: escapedOutput }]),
    error => error.code === 'result_too_large',
  );
  const exactOutput = 'x'.repeat(51);
  assert.equal(Buffer.byteLength(canonicalJson({ output: exactOutput }), 'utf8'), 64);
  await assert.rejects(
    store.commitSuccessfulSweeps(Array.from({ length: 17 }, () => ({
      workUnitId: first,
      output: exactOutput,
    }))),
    error => error.code === 'result_too_large',
  );
  await store.commitSuccessfulSweeps([{ workUnitId: first, output: exactOutput }]);
  await assert.rejects(
    store.commitSuccessfulSweeps([{ workUnitId: second, output: 'y' }]),
    error => error.code === 'result_too_large',
  );
  assert.deepEqual(store.listSuccessfulSweeps().map(row => ({
    workUnitId: row.workUnitId,
    output: row.output,
  })), [{ workUnitId: first, output: exactOutput }]);
  assert.equal(store.countPendingWorkUnits(), 1);
});

test('durable sweep and retry listings stream rows through explicit byte bounds', () => {
  const source = require('node:fs').readFileSync(
    path.resolve(__dirname, '../../cosmo23/pgs-engine/src/pinned-store.js'),
    'utf8',
  );
  const successful = source.slice(
    source.indexOf('    listSuccessfulSweeps('),
    source.indexOf('    listRetryablePartitions(', source.indexOf('    listSuccessfulSweeps(')),
  );
  const retryable = source.slice(
    source.indexOf('    listRetryablePartitions('),
    source.indexOf('    countPendingWorkUnits()', source.indexOf('    listRetryablePartitions(')),
  );
  for (const body of [successful, retryable]) {
    assert.match(body, /\.iterate\s*\(/);
    assert.doesNotMatch(body, /\.all\s*\(/);
  }
  assert.match(successful, /maxTotalSweepOutputBytes/);
  assert.match(retryable, /maxResultBytes/);
});

test('reuses only an exact source revision, limits, and sweep pair', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 20, edgeCount: 19 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  assert.equal(first.reused, false);
  first.close();
  const second = await openPinnedPGSStore(options);
  assert.equal(second.reused, true);
  second.close();

  await assert.rejects(
    openPinnedPGSStore({ ...options, query: `${query} changed` }),
    { code: 'pgs_binding_mismatch' },
  );
  await assert.rejects(
    openPinnedPGSStore({
      ...options,
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M3-alt' },
    }),
    { code: 'pgs_binding_mismatch' },
  );
});

test('rebuilds boundedly when durable projection metadata has an unexpected oversized field', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 20, edgeCount: 19 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  const { databasePath } = first;
  first.close();
  const database = new Database(databasePath);
  database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run(
    'unexpected', JSON.stringify('x'.repeat(512 * 1024)),
  );
  database.close();

  const rebuilt = await openPinnedPGSStore(options);
  assert.equal(rebuilt.reused, false);
  rebuilt.close();
  const readback = new Database(databasePath, { readonly: true });
  assert.equal(
    readback.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key = 'unexpected'").get().count,
    0,
  );
  readback.close();
});

test('oversized records and cancellation remove an incomplete projection', async t => {
  const { scratchDir, quota } = await fixture(t);
  await assert.rejects(openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 2, edgeCount: 0, oversized: true }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  }), error => error.code === 'result_too_large');

  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel store'), { code: 'cancelled' });
  await assert.rejects(openPinnedPGSStore({
    sourcePin: syntheticSource({
      nodeCount: 500,
      edgeCount: 0,
      onNode(index) { if (index === 25) controller.abort(reason); },
    }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: controller.signal,
    limits,
  }), error => error === reason);

  const pgsRoot = path.join(scratchDir, 'pgs');
  const entries = await fs.readdir(pgsRoot).catch(() => []);
  assert.deepEqual(entries, []);
});

test('refuses schema-v2 state instead of silently rebuilding it', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 6, edgeCount: 5 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  const { databasePath } = first;
  first.close();
  const database = new Database(databasePath);
  database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schemaVersion'").run();
  database.close();

  await assert.rejects(openPinnedPGSStore(options), { code: 'pgs_schema_unsupported' });
});

test('plans deterministic cumulative round-robin scopes and never reselects success', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 30, edgeCount: 29 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 1, maxSelectedWorkUnits: 64 },
  });
  t.after(() => store.close());
  const completed = new Set();
  const levels = [
    ['skim', 0.1, 3],
    ['sample', 0.25, 8],
    ['deep', 0.5, 15],
    ['full', 1, 30],
  ];

  for (const [coverageLevel, coverageFraction, expectedScope] of levels) {
    const attemptId = `attempt-${coverageLevel}`;
    const plan = store.planScope({ attemptId, coverageLevel, coverageFraction });
    assert.equal(plan.scopeWorkUnits, expectedScope);
    const selected = store.snapshotPendingWorkUnits({ attemptId, limit: 64 });
    assert.equal(selected.length, expectedScope - completed.size);
    assert.equal(selected.every(id => !completed.has(id)), true);
    if (coverageLevel === 'skim') {
      assert.equal(new Set(selected.map(id => store.loadWorkUnit(id).partitionId)).size, 3);
    }
    for (const workUnitId of selected) {
      store.beginWorkUnitAttempt(workUnitId, {
        attemptId, provider: 'minimax', model: 'MiniMax-M3',
      });
    }
    await store.commitSuccessfulSweeps(selected.map(workUnitId => ({
      workUnitId, output: `finding ${workUnitId}`,
    })));
    selected.forEach(id => completed.add(id));
    assert.equal(store.countScopePendingWorkUnits(attemptId), 0);
    assert.equal(store.countScopeSuccessfulWorkUnits(attemptId), expectedScope);
  }
});

test('target scopes filter snapshots, successes, counts, and monotonic unions', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 12, edgeCount: 11 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 1, maxSelectedWorkUnits: 64 },
  });
  t.after(() => store.close());

  const firstPlan = store.planScope({
    attemptId: 'attempt-target-one',
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    targetPartitionIds: ['c-cluster-1'],
  });
  assert.deepEqual(firstPlan.targetPartitionIds, ['c-cluster-1']);
  const first = store.snapshotPendingWorkUnits({ attemptId: firstPlan.attemptId, limit: 64 });
  assert.equal(first.length, 1);
  assert.equal(first.every(id => store.loadWorkUnit(id).partitionId === 'c-cluster-1'), true);
  for (const workUnitId of first) {
    store.beginWorkUnitAttempt(workUnitId, {
      attemptId: firstPlan.attemptId, provider: 'minimax', model: 'MiniMax-M3',
    });
  }
  await store.commitSuccessfulSweeps(first.map(workUnitId => ({
    workUnitId, output: `target ${workUnitId}`,
  })));
  assert.equal(store.listSuccessfulSweeps({ attemptId: firstPlan.attemptId }).length, 1);
  assert.equal(store.countScopePendingWorkUnits(firstPlan.attemptId), 0);
  assert.equal(store.countPendingWorkUnits(), 11);

  const union = store.planScope({
    attemptId: 'attempt-target-union',
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    targetPartitionIds: ['c-cluster-2', 'c-cluster-1'],
  });
  assert.deepEqual(union.targetPartitionIds, ['c-cluster-1', 'c-cluster-2']);
  const newIds = store.snapshotPendingWorkUnits({ attemptId: union.attemptId, limit: 64 });
  assert.equal(newIds.length, 1);
  assert.equal(newIds.every(id => store.loadWorkUnit(id).partitionId === 'c-cluster-2'), true);

  const deeper = store.planScope({
    attemptId: 'attempt-target-deeper',
    coverageLevel: 'deep',
    coverageFraction: 0.5,
    targetPartitionIds: ['c-cluster-1', 'c-cluster-2'],
  });
  assert.equal(deeper.scopeWorkUnits, 4);
  assert.equal(store.snapshotPendingWorkUnits({ attemptId: deeper.attemptId, limit: 64 }).length, 3);
  await assert.rejects(
    Promise.resolve().then(() => store.planScope({
      attemptId: 'attempt-target-shrink',
      coverageLevel: 'deep',
      coverageFraction: 0.5,
      targetPartitionIds: ['c-cluster-2'],
    })),
    { code: 'pgs_scope_non_monotonic' },
  );
});
