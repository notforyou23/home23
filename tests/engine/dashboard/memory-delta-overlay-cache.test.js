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
} = require('../../../shared/memory-source');
const {
  createMemoryDeltaOverlayCache,
} = require('../../../engine/src/dashboard/memory-delta-overlay-cache');

async function fixture() {
  const brain = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-delta-cache-brain-'));
  const requester = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-delta-cache-requester-'));
  const lockRoot = path.join(requester, 'locks');
  await rewriteMemoryBase(brain, {
    nodes: [{ id: 'base', concept: 'base', embedding: [0, 1] }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  return { brain, requester, lockRoot };
}

async function append(f, changes, summary = { nodeCount: 2, edgeCount: 0, clusterCount: 1 }) {
  await appendMemoryRevision(f.brain, changes, { lockRoot: f.lockRoot, summary });
  return readManifest(f.brain);
}

test('first load persists under requester cache and unchanged refresh is O(1)', async () => {
  const f = await fixture();
  const manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one', embedding: [1, 0] }] });
  let reads = 0;
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: { onReadRange() { reads += 1; } },
  });
  const first = await cache.refresh({ canonicalRoot: f.brain, manifest });
  const second = await cache.refresh({ canonicalRoot: f.brain, manifest });

  assert.equal(first.node('delta').concept, 'one');
  assert.equal(first.hasNodeUpsert('delta'), true);
  assert.equal(second, first);
  assert.equal(reads, 1);
  assert.equal(first.cachePath.startsWith(f.requester), true);
  assert.equal(first.cachePath.startsWith(f.brain), false);
  await fsp.access(first.cachePath);

  const restarted = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: { onReadRange() { reads += 1; } },
  });
  const restored = await restarted.refresh({ canonicalRoot: f.brain, manifest });
  assert.equal(restored.node('delta').concept, 'one');
  assert.equal(reads, 1, 'a restarted requester must reuse its persisted derived cache');
});

test('extension reads only suffix and preserves latest node and edge-only coverage', async () => {
  const f = await fixture();
  let manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one', embedding: [1, 0] }] });
  const ranges = [];
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: { onReadRange(range) { ranges.push(range); } },
  });
  const first = await cache.refresh({ canonicalRoot: f.brain, manifest });
  manifest = await append(f, { edges: [{ source: 'base', target: 'delta', weight: 1 }] }, {
    nodeCount: 2, edgeCount: 1, clusterCount: 1,
  });
  const edgeSnapshot = await cache.refresh({ canonicalRoot: f.brain, manifest });
  manifest = await append(f, { nodes: [{ id: 'delta', concept: 'two', embedding: [1, 0] }] });
  const next = await cache.refresh({ canonicalRoot: f.brain, manifest });

  assert.equal(ranges.length, 3);
  assert.equal(ranges[1].startByte, first.committedBytes);
  assert.equal(ranges[2].startByte, edgeSnapshot.committedBytes);
  assert.equal(next.node('delta').concept, 'two');
  assert.equal(next.deltaRecords, 3);
  assert.equal(next.changedNodeCount, 1);
  assert.equal(next.coveredThroughRevision, manifest.currentRevision);
});

test('suffix refresh verifies a bounded historical fingerprint instead of rehashing the backlog', async () => {
  const f = await fixture();
  let manifest = await append(f, {
    nodes: [{ id: 'large-delta', concept: 'x'.repeat(6 * 1024 * 1024) }],
  });
  const prefixReads = [];
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: {
      onPrefixRead(range) { prefixReads.push(range); },
    },
  });
  const first = await cache.refresh({ canonicalRoot: f.brain, manifest });
  prefixReads.length = 0;
  manifest = await append(f, { nodes: [{ id: 'later', concept: 'small suffix' }] }, {
    nodeCount: 3, edgeCount: 0, clusterCount: 1,
  });
  await cache.refresh({ canonicalRoot: f.brain, manifest });

  const historicalBytesRead = prefixReads.reduce((total, range) => (
    total + Math.max(0, Math.min(range.endByte, first.committedBytes) - range.startByte)
  ), 0);
  assert.ok(prefixReads.length > 0, 'prefix verification reads must be observable');
  assert.ok(historicalBytesRead <= 3 * 1024 * 1024,
    `append verification reread ${historicalBytesRead} historical bytes`);
  assert.ok(historicalBytesRead < first.committedBytes,
    'append verification must be sublinear in the historical backlog');
});

test('intermittent cache refresh validates multiple writer appends from the saved chain watermark', async () => {
  const f = await fixture();
  let manifest = await append(f, {
    nodes: [{ id: 'large-delta', concept: 'x'.repeat(6 * 1024 * 1024) }],
  });
  const ranges = [];
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: { onReadRange(range) { ranges.push(range); } },
  });
  const first = await cache.refresh({ canonicalRoot: f.brain, manifest });
  manifest = await append(f, { edges: [{ source: 'base', target: 'large-delta', weight: 1 }] }, {
    nodeCount: 2, edgeCount: 1, clusterCount: 1,
  });
  manifest = await append(f, { nodes: [{ id: 'later', concept: 'second missed append' }] }, {
    nodeCount: 3, edgeCount: 1, clusterCount: 1,
  });
  const next = await cache.refresh({ canonicalRoot: f.brain, manifest });

  assert.equal(ranges.at(-1).startByte, first.committedBytes);
  assert.equal(next.node('later').concept, 'second missed append');
  assert.equal(next.edgeOnlyRecords, 1);
});

test('suffix extension rejects a changed previously committed prefix', async () => {
  const f = await fixture();
  let manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one' }] });
  const cache = createMemoryDeltaOverlayCache({ cacheRoot: path.join(f.requester, 'cache') });
  await cache.refresh({ canonicalRoot: f.brain, manifest });
  manifest = await append(f, { nodes: [{ id: 'later', concept: 'two' }] }, {
    nodeCount: 3, edgeCount: 0, clusterCount: 1,
  });
  const deltaPath = path.join(f.brain, manifest.activeDelta.file);
  const text = await fsp.readFile(deltaPath, 'utf8');
  await fsp.writeFile(deltaPath, text.replace('"sequence":1', '"sequence":9'));
  await assert.rejects(
    () => cache.refresh({ canonicalRoot: f.brain, manifest }),
    { code: 'source_changed' },
  );
});

test('restored-mtime in-place tamper cannot inherit writer append authority', async () => {
  const f = await fixture();
  let manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one' }] });
  const deltaPath = path.join(f.brain, manifest.activeDelta.file);
  const fixedTime = new Date('2026-07-14T12:00:00.000Z');
  await fsp.utimes(deltaPath, fixedTime, fixedTime);
  const trustedStat = await fsp.stat(deltaPath, { bigint: true });
  manifest = JSON.parse(JSON.stringify(manifest));
  manifest.activeDelta.fileIdentity = {
    dev: String(trustedStat.dev),
    ino: String(trustedStat.ino),
    size: String(trustedStat.size),
    mtimeNs: String(trustedStat.mtimeNs),
    ctimeNs: String(trustedStat.ctimeNs),
  };
  await fsp.writeFile(
    path.join(f.brain, 'memory-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const cache = createMemoryDeltaOverlayCache({ cacheRoot: path.join(f.requester, 'cache') });
  const cached = await cache.refresh({ canonicalRoot: f.brain, manifest });
  assert.equal(cached.node('delta').concept, 'one');

  const original = await fsp.readFile(deltaPath, 'utf8');
  await fsp.writeFile(deltaPath, original.replace('"concept":"one"', '"concept":"two"'));
  await fsp.utimes(deltaPath, fixedTime, fixedTime);
  const tamperedStat = await fsp.stat(deltaPath, { bigint: true });
  assert.equal(String(tamperedStat.size), manifest.activeDelta.fileIdentity.size);
  assert.equal(String(tamperedStat.mtimeNs), manifest.activeDelta.fileIdentity.mtimeNs);
  assert.notEqual(String(tamperedStat.ctimeNs), manifest.activeDelta.fileIdentity.ctimeNs);

  await assert.rejects(
    () => append(f, { nodes: [{ id: 'later', concept: 'append must fail' }] }, {
      nodeCount: 3, edgeCount: 0, clusterCount: 1,
    }),
    { code: 'source_changed' },
  );
});

test('trailing-byte recovery cannot hide restored-mtime committed-prefix tampering', async () => {
  const f = await fixture();
  let manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one' }] });
  const deltaPath = path.join(f.brain, manifest.activeDelta.file);
  const fixedTime = new Date('2026-07-14T12:00:00.000Z');
  await fsp.utimes(deltaPath, fixedTime, fixedTime);
  const trustedStat = await fsp.stat(deltaPath, { bigint: true });
  manifest = JSON.parse(JSON.stringify(manifest));
  manifest.activeDelta.fileIdentity = {
    dev: String(trustedStat.dev),
    ino: String(trustedStat.ino),
    size: String(trustedStat.size),
    mtimeNs: String(trustedStat.mtimeNs),
    ctimeNs: String(trustedStat.ctimeNs),
  };
  await fsp.writeFile(
    path.join(f.brain, 'memory-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const cache = createMemoryDeltaOverlayCache({ cacheRoot: path.join(f.requester, 'cache') });
  const cached = await cache.refresh({ canonicalRoot: f.brain, manifest });
  assert.equal(cached.node('delta').concept, 'one');

  const original = await fsp.readFile(deltaPath, 'utf8');
  const tampered = original.replace('"concept":"one"', '"concept":"two"');
  await fsp.writeFile(deltaPath, `${tampered}x`);
  await fsp.utimes(deltaPath, fixedTime, fixedTime);
  const tamperedStat = await fsp.stat(deltaPath, { bigint: true });
  assert.ok(Number(tamperedStat.size) > manifest.activeDelta.committedBytes);
  assert.equal(String(tamperedStat.mtimeNs), manifest.activeDelta.fileIdentity.mtimeNs);

  await assert.rejects(
    () => append(f, { nodes: [{ id: 'later', concept: 'append must fail' }] }, {
      nodeCount: 3, edgeCount: 0, clusterCount: 1,
    }),
    { code: 'source_changed' },
  );
  await assert.rejects(
    () => cache.refresh({ canonicalRoot: f.brain, manifest }),
    { code: 'source_changed' },
  );
  assert.equal((await fsp.stat(deltaPath)).size, Number(tamperedStat.size),
    'failed validation must not truncate or bless the trailing bytes');
});

test('cache rejects an excessive retained node overlay before materialization', async () => {
  const f = await fixture();
  const manifest = await append(f, {
    nodes: [{ id: 'large', concept: 'x'.repeat(4096) }],
  });
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    maxRetainedBytes: 1024,
  });
  await assert.rejects(
    () => cache.refresh({ canonicalRoot: f.brain, manifest }),
    { code: 'result_too_large' },
  );
});

test('tombstone suppresses an upsert and epoch change rebuilds the cache', async () => {
  const f = await fixture();
  let manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one', embedding: [1, 0] }] });
  let reads = 0;
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: { onReadRange() { reads += 1; } },
  });
  await cache.refresh({ canonicalRoot: f.brain, manifest });
  manifest = await append(f, { removedNodeIds: ['delta'] }, {
    nodeCount: 1, edgeCount: 0, clusterCount: 1,
  });
  const tombstoned = await cache.refresh({ canonicalRoot: f.brain, manifest });
  assert.equal(tombstoned.node('delta'), null);
  assert.equal(tombstoned.hasRemovedNode('delta'), true);

  await rewriteMemoryBase(f.brain, {
    nodes: [{ id: 'replacement', concept: 'new epoch', embedding: [1, 0] }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot: f.lockRoot });
  const rewritten = await cache.refresh({ canonicalRoot: f.brain, manifest: await readManifest(f.brain) });
  assert.equal(rewritten.changedNodeCount, 0);
  assert.equal(rewritten.deltaRecords, 0);
  assert.equal(reads, 3);
});

test('corrupt/gapped delta, abort, and same-inode replacement are rejected', async () => {
  const f = await fixture();
  const manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one' }] });
  const cache = createMemoryDeltaOverlayCache({ cacheRoot: path.join(f.requester, 'cache') });
  await cache.refresh({ canonicalRoot: f.brain, manifest });
  const deltaPath = path.join(f.brain, manifest.activeDelta.file);
  const text = await fsp.readFile(deltaPath, 'utf8');
  await fsp.writeFile(deltaPath, text.replace('"sequence":1', '"sequence":9'));
  await assert.rejects(
    () => cache.refresh({ canonicalRoot: f.brain, manifest }),
    { code: 'source_changed' },
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => cache.refresh({ canonicalRoot: f.brain, manifest, signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('concurrent refreshes serialize and share one immutable snapshot', async () => {
  const f = await fixture();
  const manifest = await append(f, { nodes: [{ id: 'delta', concept: 'one' }] });
  let reads = 0;
  const cache = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(f.requester, 'cache'),
    _testHooks: { onReadRange() { reads += 1; } },
  });
  const [left, right] = await Promise.all([
    cache.refresh({ canonicalRoot: f.brain, manifest }),
    cache.refresh({ canonicalRoot: f.brain, manifest }),
  ]);
  assert.equal(left, right);
  assert.equal(reads, 1);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.node('delta')), true);
});
