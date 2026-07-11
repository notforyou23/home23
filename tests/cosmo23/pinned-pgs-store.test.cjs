'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createOperationScratchQuota,
} = require('../../shared/memory-source/scratch-quota.cjs');
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

test('streams a revision-bound projection and creates deterministic bounded work units', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({}),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
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
  assert.deepEqual(pending, [...pending].sort());
  const unit = store.loadWorkUnit(pending[0]);
  assert.equal(unit.nodes.length <= 25, true);
  assert.equal(unit.stats.contextChars <= 4096, true);
  assert.match(unit.workUnitId, /^p-c-cluster-[0-2]-u\d{4}$/);
});

test('persists successful work idempotently and leaves failed work pending', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 12, edgeCount: 11 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
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

test('reuses only an exact source revision, limits, and sweep pair', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 20, edgeCount: 19 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  assert.equal(first.reused, false);
  first.close();
  const second = await openPinnedPGSStore(options);
  assert.equal(second.reused, true);
  second.close();

  const changed = await openPinnedPGSStore({
    ...options,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3-alt' },
  });
  assert.equal(changed.reused, false);
  changed.close();
});

test('oversized records and cancellation remove an incomplete projection', async t => {
  const { scratchDir, quota } = await fixture(t);
  await assert.rejects(openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 2, edgeCount: 0, oversized: true }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
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
    signal: controller.signal,
    limits,
  }), error => error === reason);

  const pgsRoot = path.join(scratchDir, 'pgs');
  const entries = await fs.readdir(pgsRoot).catch(() => []);
  assert.deepEqual(entries, []);
});
