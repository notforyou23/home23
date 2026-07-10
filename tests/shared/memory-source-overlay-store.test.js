import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createBoundedOverlayStore,
  createOperationScratchQuota,
} = require('../../shared/memory-source');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-overlay-store-'));
}

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

async function overlayFiles(operationRoot) {
  const artifacts = [];
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(filePath);
      else if (/\.sqlite$|-(journal|wal|shm)$/.test(entry.name)) artifacts.push(filePath);
    }
  }
  await walk(operationRoot);
  return artifacts.sort();
}

async function findOverlayDirectory(operationRoot) {
  const artifacts = await overlayFiles(operationRoot);
  assert.equal(artifacts.length > 0, true, 'expected a SQLite overlay artifact');
  return path.dirname(artifacts.find((filePath) => filePath.endsWith('.sqlite')));
}

function node(id, concept = id) {
  return { op: 'upsert_node', record: { id, concept } };
}

function edge(source, target, weight = 1) {
  return { op: 'upsert_edge', record: { source, target, weight } };
}

test('applies last-write-wins upserts and tombstones with remove_edge key support', async () => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  await store.apply(node('b', 'before'));
  await store.apply(node('a', 'alpha'));
  const beforeReplacement = store.retainedBytes;
  await store.apply(node('b', 'after'));
  assert.equal(store.retainedBytes <= beforeReplacement, true);

  await store.apply(edge('a', 'b', 0.5));
  assert.equal(store.hasEdgeUpsert('a->b'), true);
  assert.equal(store.edge('a->b').weight, 0.5);
  await store.apply({ op: 'remove_edge', key: 'a->b' });
  assert.equal(store.hasRemovedEdge('a->b'), true);
  assert.equal(store.hasEdgeUpsert('a->b'), false);

  await store.apply(edge('a', 'b', 0.75));
  await store.apply({ op: 'remove_node', id: 'b' });
  assert.equal(store.hasRemovedNode('b'), true);
  assert.equal(store.edge('a->b'), undefined);
  assert.deepEqual(await collect(store.iterateEdgeUpserts()), []);
  await store.apply(node('b', 'restored'));

  const nodeIterator = store.iterateNodeUpserts();
  assert.equal(Array.isArray(nodeIterator), false);
  assert.equal(typeof nodeIterator[Symbol.asyncIterator], 'function');
  assert.deepEqual(
    (await collect(nodeIterator)).map((record) => [record.id, record.concept]),
    [['a', 'alpha'], ['b', 'restored']],
  );
  assert.deepEqual(
    (await collect(store.iterateEdgeUpserts())).map((record) => [record.source, record.target, record.weight]),
    [['a', 'b', 0.75]],
  );
  assert.equal(Array.isArray(store.upsertedNodes()), false);
  assert.deepEqual([...store.upsertedNodes()].map((record) => record.id), ['a', 'b']);
  await store.close();
});

test('replacement and tombstone accounting tracks retained state rather than cumulative writes', async () => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  await store.apply(node('same', 'x'.repeat(32 * 1024)));
  const largeBytes = store.retainedBytes;
  await store.apply(node('same', 'small'));
  const replacementBytes = store.retainedBytes;
  assert.equal(replacementBytes < largeBytes / 4, true);
  await store.apply({ op: 'remove_node', id: 'same' });
  assert.equal(store.retainedBytes < replacementBytes, true);
  assert.equal(store.hasNodeUpsert('same'), false);
  assert.equal(store.hasRemovedNode('same'), true);
  await store.close();
});

test('detaches retained state from the caller delta record', async () => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  const record = { id: 'detached', concept: 'before', metadata: { source: 'original' } };
  await store.apply({ op: 'upsert_node', record });
  record.concept = 'mutated';
  record.metadata.source = 'mutated';
  assert.deepEqual(store.node('detached'), {
    id: 'detached',
    concept: 'before',
    metadata: { source: 'original' },
  });
  await store.close();
});

test('deep-freezes in-memory lookup and iterator records without corrupting accounting', async () => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  await store.apply({
    op: 'upsert_node',
    record: {
      id: 'memory-frozen',
      concept: 'before',
      metadata: { provenance: { source: 'original' }, tags: ['one'] },
    },
  });
  const beforeBytes = store.retainedBytes;
  const lookup = store.node('memory-frozen');
  const [iterated] = await collect(store.iterateNodeUpserts());

  assert.equal(Object.isFrozen(lookup.metadata.provenance), true);
  assert.equal(Object.isFrozen(iterated.metadata.tags), true);
  assert.throws(() => { lookup.metadata.provenance.source = 'mutated'; }, TypeError);
  assert.throws(() => { iterated.metadata.tags.push('two'); }, TypeError);
  assert.deepEqual(store.node('memory-frozen').metadata, {
    provenance: { source: 'original' },
    tags: ['one'],
  });
  assert.equal(store.retainedBytes, beforeBytes);
  assert.equal(store.retainedBytes >= 0, true);
  await store.close();
});

test('deep-freezes SQLite lookup and iterator records without corrupting spill accounting', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 4 * 1024 * 1024,
  });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 2 * 1024 * 1024,
  });
  await store.apply({
    op: 'upsert_node',
    record: {
      id: 'disk-frozen',
      concept: 'before',
      metadata: { provenance: { source: 'original' }, tags: ['one'] },
    },
  });
  const beforeDiskBytes = store.diskBytes;
  const lookup = store.node('disk-frozen');
  const [iterated] = await collect(store.iterateNodeUpserts());

  assert.equal(Object.isFrozen(lookup.metadata.provenance), true);
  assert.equal(Object.isFrozen(iterated.metadata.tags), true);
  assert.throws(() => { lookup.metadata.provenance.source = 'mutated'; }, TypeError);
  assert.throws(() => { iterated.metadata.tags.push('two'); }, TypeError);
  assert.deepEqual(store.node('disk-frozen').metadata, {
    provenance: { source: 'original' },
    tags: ['one'],
  });
  assert.equal(store.diskBytes, beforeDiskBytes);
  assert.equal(store.retainedBytes >= 0, true);
  assert.equal(store.diskBytes >= 0, true);
  assert.equal(store.diskBytes <= store.maxDiskBytes, true);
  await store.close();
  scratchQuota.close();
});

test('spills exact ordered state into private SQLite and removes every database artifact', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 4 * 1024 * 1024,
  });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 160,
    maxDiskBytes: 2 * 1024 * 1024,
  });
  await store.apply(node('c', 'charlie'.repeat(20)));
  await store.apply(node('a', 'alpha'.repeat(20)));
  await store.apply(node('b', 'bravo'.repeat(20)));
  await store.apply(edge('c', 'a', 3));
  await store.apply({ op: 'remove_node', id: 'b' });

  assert.equal(store.spilled, true);
  assert.equal(store.retainedBytes <= 160, true);
  const filesWhileOpen = await overlayFiles(operationRoot);
  assert.equal(filesWhileOpen.some((name) => name.endsWith('.sqlite')), true);
  const privateDirectory = await findOverlayDirectory(operationRoot);
  assert.equal(path.dirname(privateDirectory), operationRoot);
  assert.notEqual(path.basename(privateDirectory), 'overlay');
  assert.deepEqual(
    (await collect(store.iterateNodeUpserts())).map((record) => record.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    (await collect(store.iterateEdgeUpserts())).map((record) => `${record.source}->${record.target}`),
    ['c->a'],
  );

  await store.close();
  await store.close();
  const filesAfterClose = await overlayFiles(operationRoot);
  assert.deepEqual(filesAfterClose, []);
  scratchQuota.close();
});

test('requires an operation root at the spill threshold without partially applying the record', async () => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 128 });
  await store.apply(node('small', 'ok'));
  await assert.rejects(
    () => store.apply(node('large', 'x'.repeat(1024))),
    { code: 'source_operation_required' },
  );
  assert.equal(store.node('small').concept, 'ok');
  assert.equal(store.node('large'), undefined);
  await store.close();
});

test('creates the database exclusively and never follows a replaced basename', async () => {
  const operationRoot = await tempDir();
  const outside = await tempDir();
  const outsideFile = path.join(outside, 'sentinel.sqlite');
  await fsp.writeFile(outsideFile, 'outside');
  const scratchQuota = await createOperationScratchQuota({ operationRoot, maxBytes: 1024 * 1024 });
  let injectedPath = null;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 64,
    _testHooks: {
      async beforeDatabaseCreate({ databasePath }) {
        injectedPath = databasePath;
        await fsp.symlink(outsideFile, databasePath);
      },
    },
  });
  await assert.rejects(
    () => store.apply(node('escape', 'x'.repeat(1024))),
    { code: 'invalid_memory_source' },
  );
  assert.equal(await fsp.readFile(outsideFile, 'utf8'), 'outside');
  assert.equal(injectedPath !== null, true);
  await fsp.rm(injectedPath);
  await store.close();
  scratchQuota.close();
});

test('disk and aggregate quota failures are typed 413 and clean partial spill files', async () => {
  const diskRoot = await tempDir();
  const diskQuota = await createOperationScratchQuota({ operationRoot: diskRoot, maxBytes: 1024 * 1024 });
  const diskStore = await createBoundedOverlayStore({
    operationRoot: diskRoot,
    scratchQuota: diskQuota,
    maxMemoryBytes: 64,
    maxDiskBytes: 4096,
  });
  await assert.rejects(
    () => diskStore.apply(node('disk-limit', 'x'.repeat(1024))),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.deepEqual(await overlayFiles(diskRoot), []);
  await diskStore.close();
  diskQuota.close();

  const aggregateRoot = await tempDir();
  const aggregateQuota = await createOperationScratchQuota({ operationRoot: aggregateRoot, maxBytes: 32 * 1024 });
  const aggregateStore = await createBoundedOverlayStore({
    operationRoot: aggregateRoot,
    scratchQuota: aggregateQuota,
    maxMemoryBytes: 64,
    maxDiskBytes: 1024 * 1024,
  });
  await assert.rejects(
    () => aggregateStore.apply(node('aggregate-limit', 'x'.repeat(1024))),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.deepEqual(await overlayFiles(aggregateRoot), []);
  await aggregateStore.close();
  aggregateQuota.close();
});

test('enforces per-record bounds before retention or spill', async () => {
  const store = await createBoundedOverlayStore({
    maxMemoryBytes: 1024 * 1024,
    maxRecordBytes: 256,
  });
  await assert.rejects(
    () => store.apply(node('too-large', 'x'.repeat(1024))),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.equal(store.retainedBytes, 0);
  await store.close();
});

test('abort during spill or ordered iteration stops work and permits complete cleanup', async () => {
  const spillRoot = await tempDir();
  const spillQuota = await createOperationScratchQuota({ operationRoot: spillRoot, maxBytes: 1024 * 1024 });
  const spillAbort = new AbortController();
  const spillStore = await createBoundedOverlayStore({
    operationRoot: spillRoot,
    scratchQuota: spillQuota,
    signal: spillAbort.signal,
    maxMemoryBytes: 64,
  });
  queueMicrotask(() => spillAbort.abort(Object.assign(new Error('stop spill'), { name: 'AbortError' })));
  await assert.rejects(() => spillStore.apply(node('abort', 'x'.repeat(1024))), { name: 'AbortError' });
  assert.deepEqual(await overlayFiles(spillRoot), []);
  await spillStore.close();
  spillQuota.close();

  const iterateRoot = await tempDir();
  const iterateQuota = await createOperationScratchQuota({ operationRoot: iterateRoot, maxBytes: 1024 * 1024 });
  const iterateAbort = new AbortController();
  const iterateStore = await createBoundedOverlayStore({
    operationRoot: iterateRoot,
    scratchQuota: iterateQuota,
    signal: iterateAbort.signal,
    maxMemoryBytes: 64,
  });
  await iterateStore.apply(node('a', 'x'.repeat(1024)));
  await iterateStore.apply(node('b', 'y'.repeat(1024)));
  const iterator = iterateStore.iterateNodeUpserts({ signal: iterateAbort.signal });
  assert.equal((await iterator.next()).value.id, 'a');
  iterateAbort.abort(Object.assign(new Error('stop iteration'), { name: 'AbortError' }));
  await assert.rejects(() => iterator.next(), { name: 'AbortError' });
  assert.deepEqual(await overlayFiles(iterateRoot), []);
  await iterateStore.close();
  assert.deepEqual(await overlayFiles(iterateRoot), []);
  iterateQuota.close();
});

test('serializes concurrent threshold-crossing apply calls and spills exactly once', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  let spillCount = 0;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 64,
    maxDiskBytes: 8 * 1024 * 1024,
    _testHooks: {
      async beforeDatabaseOpen() {
        spillCount += 1;
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
  });

  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    store.apply(node(`node-${index % 8}`, `value-${index}`))));
  assert.equal(spillCount, 1);
  assert.equal(store.spilled, true);
  const records = await collect(store.iterateNodeUpserts());
  assert.deepEqual(records.map((record) => record.id), Array.from({ length: 8 }, (_, index) => `node-${index}`));
  for (let index = 0; index < 8; index += 1) {
    assert.equal(store.node(`node-${index}`).concept, `value-${index + 16}`);
  }
  assert.equal((await overlayFiles(operationRoot)).filter((name) => name.endsWith('.sqlite')).length, 1);
  await store.close();
  scratchQuota.close();
});

test('bounds pending serialized admission while the first near-max mutation is blocked', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 4 * 1024 * 1024,
  });
  let releaseFirst;
  let markFirstBlocked;
  const firstBlocked = new Promise((resolve) => { markFirstBlocked = resolve; });
  const blocker = new Promise((resolve) => { releaseFirst = resolve; });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 2 * 1024 * 1024,
    maxRecordBytes: 2048,
    _testHooks: {
      async beforeDiskMutation({ normalized }) {
        if (normalized.key !== 'first-near-max') return;
        markFirstBlocked();
        await blocker;
      },
    },
  });
  const first = store.apply(node('first-near-max', 'x'.repeat(1300)));
  await firstBlocked;
  const second = store.apply(node('second-near-max', 'y'.repeat(1300))).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  let outcome;
  try {
    outcome = await Promise.race([
      second,
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 50)),
    ]);
    assert.equal(outcome.timedOut, undefined);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'result_too_large');
    assert.equal(outcome.error.status, 413);
    assert.equal(outcome.error.retryable, false);
  } finally {
    releaseFirst();
    await first;
    await second;
  }

  assert.equal(store.node('first-near-max').concept.length, 1300);
  assert.equal(store.node('second-near-max'), undefined);
  assert.equal(store.retainedBytes >= 0, true);
  assert.equal(store.diskBytes >= 0, true);
  assert.equal(store.diskBytes <= store.maxDiskBytes, true);
  await store.close();
  scratchQuota.close();
});

test('directory replacement fails closed, preserves the replacement, and retains accounting until retry cleanup', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 8 * 1024 * 1024,
  });
  let swapBeforeMutation = false;
  let originalDirectory = null;
  let movedDirectory = null;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 64,
    maxDiskBytes: 4 * 1024 * 1024,
    _testHooks: {
      async beforeDiskMutation({ overlayRoot }) {
        if (!swapBeforeMutation) return;
        swapBeforeMutation = false;
        originalDirectory = overlayRoot;
        movedDirectory = `${overlayRoot}-original`;
        await fsp.rename(overlayRoot, movedDirectory);
        await fsp.mkdir(overlayRoot, { mode: 0o700 });
        await fsp.writeFile(path.join(overlayRoot, 'replacement-sentinel'), 'keep');
      },
    },
  });
  await store.apply(node('first', 'x'.repeat(1024)));
  assert.equal(store.spilled, true);

  swapBeforeMutation = true;
  await assert.rejects(() => store.apply(node('second', 'y'.repeat(1024))), {
    code: 'invalid_memory_source',
  });
  assert.equal(await fsp.readFile(path.join(originalDirectory, 'replacement-sentinel'), 'utf8'), 'keep');
  await assert.rejects(() => store.close(), { code: 'invalid_memory_source' });
  assert.equal(await fsp.readFile(path.join(originalDirectory, 'replacement-sentinel'), 'utf8'), 'keep');

  const failedLedger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  const failedReserved = Object.values(failedLedger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, value) => sum + value, 0);
  assert.equal(failedReserved > 0, true);
  assert.equal(failedLedger.actualPrivateBytes + failedReserved <= failedLedger.usedBytes, true);
  assert.equal(failedLedger.usedBytes <= failedLedger.maxBytes, true);

  await fsp.rm(originalDirectory, { recursive: true });
  await fsp.rename(movedDirectory, originalDirectory);
  await store.close();
  assert.deepEqual(await overlayFiles(operationRoot), []);
  const cleanedLedger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  const cleanedReserved = Object.values(cleanedLedger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, value) => sum + value, 0);
  assert.equal(cleanedReserved, 0);
  scratchQuota.close();
});

test('a transient exact-artifact cleanup failure can be retried by close', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 8 * 1024 * 1024,
  });
  let failCleanup = true;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 64,
    _testHooks: {
      async beforeArtifactRemove() {
        if (!failCleanup) return;
        failCleanup = false;
        throw Object.assign(new Error('injected cleanup failure'), { code: 'EIO' });
      },
    },
  });
  await store.apply(node('cleanup', 'x'.repeat(1024)));
  await assert.rejects(() => store.close(), /injected cleanup failure/);
  assert.equal((await overlayFiles(operationRoot)).length > 0, true);
  await store.close();
  assert.deepEqual(await overlayFiles(operationRoot), []);
  scratchQuota.close();
});
