import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  createBoundedOverlayStore,
  createOperationScratchQuota,
} = require('../../shared/memory-source');
const {
  applyOverlayEntriesInBatches,
} = require('../../shared/memory-source/overlay-store.cjs');

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

test('deep-freezes wide JSON arrays without materializing an all-key list', async (t) => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  t.after(() => store.close().catch(() => {}));
  const originalOwnKeys = Reflect.ownKeys;
  let arrayOwnKeyCalls = 0;
  Reflect.ownKeys = (value) => {
    if (Array.isArray(value)) {
      arrayOwnKeyCalls += 1;
      throw new Error('wide array key amplification');
    }
    return originalOwnKeys(value);
  };
  try {
    await store.applyBatch([{
      op: 'upsert_node',
      record: {
        id: 'wide-array',
        samples: Array.from({ length: 4096 }, (_, index) => index),
      },
    }]);
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }

  assert.equal(arrayOwnKeyCalls, 0);
  assert.equal(Object.isFrozen(store.node('wide-array').samples), true);
  assert.throws(() => { store.node('wide-array').samples.push(4096); }, TypeError);
});

test('normalizes private node and edge records in place under a bounded child heap', async () => {
  const memorySourceModule = path.resolve('shared/memory-source');
  const script = String.raw`
    'use strict';
    const assert = require('node:assert/strict');
    const { createBoundedOverlayStore } = require(${JSON.stringify(memorySourceModule)});
    (async () => {
      const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
      const privateNode = { id: 23, concept: 'private-node' };
      const privateEdge = { from: 9, to: 2, weight: 0.5 };
      const detachedEntries = [
        { op: 'upsert_node', record: privateNode },
        { op: 'upsert_edge', record: privateEdge },
      ];
      const originalParse = JSON.parse;
      JSON.parse = (text, ...args) => detachedEntries.shift() || originalParse(text, ...args);
      try {
        await store.applyBatch([
          { op: 'upsert_node', record: { id: 'placeholder-node' } },
          { op: 'upsert_edge', record: { source: 'placeholder-a', target: 'placeholder-b' } },
        ]);
      } finally {
        JSON.parse = originalParse;
      }
      assert.strictEqual(store.node('23'), privateNode);
      assert.equal(privateNode.id, '23');
      assert.equal(Object.isFrozen(privateNode), true);
      assert.strictEqual(store.edge({ source: '9', target: '2' }), privateEdge);
      assert.equal(privateEdge.source, '9');
      assert.equal(privateEdge.target, '2');
      assert.equal(Object.isFrozen(privateEdge), true);
      await store.close();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--max-old-space-size=64',
    '-e',
    script,
  ], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
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

test('owned scratch quota construction honors an already-aborted store signal', async () => {
  const operationRoot = await tempDir();
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop owned quota construction'), {
    name: 'AbortError',
  });
  controller.abort(reason);
  try {
    await assert.rejects(
      () => createBoundedOverlayStore({
        operationRoot,
        signal: controller.signal,
        maxMemoryBytes: 0,
      }),
      (error) => error === reason,
    );
    await assert.rejects(
      () => fsp.lstat(path.join(operationRoot, '.scratch-quota.json')),
      { code: 'ENOENT' },
    );
  } finally {
    await fsp.rm(operationRoot, { recursive: true, force: true });
  }
});

test('shared operation abort still permits exact overlay cleanup and quota reconciliation', async () => {
  const operationRoot = await tempDir();
  const operationAbort = new AbortController();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 4 * 1024 * 1024,
    signal: operationAbort.signal,
  });
  let privateDirectory = null;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    signal: operationAbort.signal,
    maxMemoryBytes: 0,
    maxDiskBytes: 2 * 1024 * 1024,
    _testHooks: {
      async afterPrivateDirectoryCreate({ overlayRoot }) {
        privateDirectory = overlayRoot;
      },
      async beforeDiskMutation() {
        operationAbort.abort(Object.assign(new Error('stop disk mutation'), {
          name: 'AbortError',
        }));
      },
    },
  });

  await assert.rejects(
    () => store.apply(node('abort-shared-signal', 'x'.repeat(1024))),
    { name: 'AbortError' },
  );
  await assert.rejects(
    () => scratchQuota.claim(1, 'post-abort-claim'),
    { name: 'AbortError' },
  );
  await assert.rejects(
    () => scratchQuota.assertOperationRoot(operationRoot),
    { name: 'AbortError' },
  );
  await assert.rejects(
    () => scratchQuota.release(0),
    { name: 'AbortError' },
  );
  await assert.rejects(
    () => scratchQuota.reconcile(),
    { name: 'AbortError' },
  );
  assert.notEqual(privateDirectory, null);

  await store.close();
  await store.close();
  await assert.rejects(() => fsp.lstat(privateDirectory), { code: 'ENOENT' });
  assert.deepEqual(await overlayFiles(operationRoot), []);

  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(reservedBytes, 0);
  scratchQuota.close();
});

test('cleanup settlement is idempotent after ledger publish throws post-commit', async () => {
  const operationRoot = await tempDir();
  const operationAbort = new AbortController();
  let failCleanupPublish = false;
  let injectedFailures = 0;
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 4 * 1024 * 1024,
    signal: operationAbort.signal,
    _testHooks: {
      async afterLedgerPublish() {
        if (!failCleanupPublish) return;
        failCleanupPublish = false;
        injectedFailures += 1;
        throw Object.assign(new Error('post-commit ledger fsync failure'), { code: 'EIO' });
      },
    },
  });
  let privateDirectory = null;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    signal: operationAbort.signal,
    maxMemoryBytes: 0,
    maxDiskBytes: 2 * 1024 * 1024,
    _testHooks: {
      async afterPrivateDirectoryCreate({ overlayRoot }) {
        privateDirectory = overlayRoot;
      },
      async beforeDiskMutation() {
        failCleanupPublish = true;
        operationAbort.abort(Object.assign(new Error('stop before SQLite mutation'), {
          name: 'AbortError',
        }));
      },
    },
  });

  await assert.rejects(
    () => store.apply(node('post-commit-cleanup', 'x'.repeat(1024))),
    { name: 'AbortError' },
  );
  assert.equal(injectedFailures, 1);
  assert.notEqual(privateDirectory, null);

  await store.close();
  await store.close();
  await assert.rejects(() => fsp.lstat(privateDirectory), { code: 'ENOENT' });
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(reservedBytes, 0);
  scratchQuota.close();
});

test('partial preflight release cleans either durable reservation state after post-commit failure', async () => {
  const operationRoot = await tempDir();
  let publishCount = 0;
  let injectedFailures = 0;
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 4 * 1024 * 1024,
    _testHooks: {
      async afterLedgerPublish() {
        publishCount += 1;
        // Construction publishes once, the overlay preflight claim publishes
        // second, and its partial release publishes third.
        if (publishCount !== 3) return;
        injectedFailures += 1;
        throw Object.assign(new Error('partial preflight release post-commit failure'), {
          code: 'EIO',
        });
      },
    },
  });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 2 * 1024 * 1024,
  });

  await assert.rejects(
    () => store.apply(node('partial-preflight-release', 'x'.repeat(1024))),
    /partial preflight release post-commit failure/,
  );
  assert.equal(injectedFailures, 1);

  await store.close();
  await store.close();
  assert.deepEqual(await overlayFiles(operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(reservedBytes, 0);
  scratchQuota.close();
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

test('batches spilled delta imports into one FULL transaction and one aggregate quota cycle', async () => {
  const operationRoot = await tempDir();
  let ledgerPublishes = 0;
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
    _testHooks: {
      async afterLedgerPublish() {
        ledgerPublishes += 1;
      },
    },
  });
  const diskTransactions = [];
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 32 * 1024 * 1024,
    _testHooks: {
      async afterDiskTransaction(details) {
        diskTransactions.push(details);
      },
    },
  });
  await store.apply(node('seed', 'seed'));
  ledgerPublishes = 0;
  diskTransactions.length = 0;

  const entries = Array.from({ length: 64 }, (_, index) =>
    node(`batch-${String(index).padStart(3, '0')}`, `value-${index}`));
  await store.applyBatch(entries);

  assert.equal(diskTransactions.length, 1);
  assert.equal(diskTransactions[0].entryCount, entries.length);
  assert.equal(diskTransactions[0].serializedBytes > 0, true);
  assert.equal(ledgerPublishes, 3);
  assert.equal(store.node('batch-000').concept, 'value-0');
  assert.equal(store.node('batch-063').concept, 'value-63');
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(reservedBytes, 0);
  assert.equal(ledger.actualPrivateBytes, store.diskBytes);

  await store.close();
  scratchQuota.close();
});

test('stream batching adapts to a disk cap where the same sequential writes fit', async (t) => {
  async function createDiskStore(label) {
    const operationRoot = await tempDir();
    const scratchQuota = await createOperationScratchQuota({
      operationRoot,
      maxBytes: 64 * 1024 * 1024,
    });
    const store = await createBoundedOverlayStore({
      operationRoot,
      scratchQuota,
      maxMemoryBytes: 0,
      maxDiskBytes: 2 * 1024 * 1024,
    });
    t.after(async () => {
      await store.close().catch(() => {});
      scratchQuota.close();
      await fsp.rm(operationRoot, { recursive: true, force: true });
    });
    return { label, store };
  }

  const entryCount = 16;
  const sequential = await createDiskStore('sequential');
  for (let index = 0; index < entryCount; index += 1) {
    await sequential.store.apply(node(`${sequential.label}-${index}`, 'value'));
  }
  assert.equal(sequential.store.diskBytes < sequential.store.maxDiskBytes, true);

  const direct = await createDiskStore('direct');
  await direct.store.applyBatch(Array.from({ length: entryCount }, (_, index) =>
    node(`${direct.label}-${index}`, 'value')));
  assert.equal(direct.store.node('direct-0').concept, 'value');
  assert.equal(direct.store.node('direct-15').concept, 'value');

  const streamed = await createDiskStore('streamed');
  async function* entries() {
    for (let index = 0; index < entryCount; index += 1) {
      yield node(`${streamed.label}-${index}`, 'value');
    }
  }
  await applyOverlayEntriesInBatches(streamed.store, entries());

  assert.equal(streamed.store.node('streamed-0').concept, 'value');
  assert.equal(streamed.store.node('streamed-15').concept, 'value');
  assert.equal(streamed.store.diskBytes < streamed.store.maxDiskBytes, true);
});

test('direct replacement batches split before rollback reservation exceeds the disk cap', async (t) => {
  async function createReplacementStore(label) {
    const operationRoot = await tempDir();
    const scratchQuota = await createOperationScratchQuota({
      operationRoot,
      maxBytes: 64 * 1024 * 1024,
    });
    const store = await createBoundedOverlayStore({
      operationRoot,
      scratchQuota,
      maxMemoryBytes: 0,
      maxDiskBytes: 1024 * 1024,
    });
    t.after(async () => {
      await store.close().catch(() => {});
      scratchQuota.close();
      await fsp.rm(operationRoot, { recursive: true, force: true });
    });
    for (let index = 0; index < 4; index += 1) {
      await store.apply(node(`${label}-${index}`, 'a'.repeat(100 * 1024)));
    }
    return store;
  }

  const sequential = await createReplacementStore('sequential-replacement');
  for (let index = 0; index < 4; index += 1) {
    await sequential.apply(node(`sequential-replacement-${index}`, 'b'.repeat(100 * 1024)));
  }

  const direct = await createReplacementStore('direct-replacement');
  await direct.applyBatch(Array.from({ length: 4 }, (_, index) =>
    node(`direct-replacement-${index}`, 'b'.repeat(100 * 1024))));

  for (let index = 0; index < 4; index += 1) {
    assert.equal(sequential.node(`sequential-replacement-${index}`).concept[0], 'b');
    assert.equal(direct.node(`direct-replacement-${index}`).concept[0], 'b');
  }
});

test('batches the bounded in-memory state during the initial SQLite spill', async () => {
  const operationRoot = await tempDir();
  let ledgerPublishes = 0;
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
    _testHooks: {
      async afterLedgerPublish() {
        ledgerPublishes += 1;
      },
    },
  });
  const diskTransactions = [];
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 16 * 1024,
    maxDiskBytes: 32 * 1024 * 1024,
    maxRecordBytes: 64 * 1024,
    _testHooks: {
      async afterDiskTransaction(details) {
        diskTransactions.push(details);
      },
    },
  });
  const retainedEntries = Array.from({ length: 64 }, (_, index) =>
    node(`retained-${String(index).padStart(3, '0')}`, 'x'.repeat(32)));
  for (const entry of retainedEntries) await store.apply(entry);
  assert.equal(store.spilled, false);
  ledgerPublishes = 0;

  await store.apply(node('spill-trigger', 'y'.repeat(32 * 1024)));

  assert.equal(store.spilled, true);
  assert.deepEqual(
    diskTransactions.map(({ entryCount }) => entryCount),
    [retainedEntries.length, 1],
  );
  // One claim/partial-release/settlement cycle creates the database, one
  // imports retained memory, and one applies the threshold-crossing entry.
  assert.equal(ledgerPublishes, 9);
  assert.equal(store.node('retained-000').concept.length, 32);
  assert.equal(store.node('retained-063').concept.length, 32);
  assert.equal(store.node('spill-trigger').concept.length, 32 * 1024);

  await store.close();
  scratchQuota.close();
});

test('initial spill caps multi-entry transactions while allowing one larger valid record', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 128 * 1024 * 1024,
  });
  const diskTransactions = [];
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 2 * 1024 * 1024,
    maxDiskBytes: 64 * 1024 * 1024,
    _testHooks: {
      async afterDiskTransaction(details) {
        diskTransactions.push(details);
      },
    },
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
  });

  for (let index = 0; index < 40; index += 1) {
    await store.apply(node(`retained-default-limit-${index}`, 'x'.repeat(32 * 1024)));
  }
  assert.equal(store.spilled, false);

  await store.apply(node('larger-valid-spill-trigger', 'y'.repeat(2 * 1024 * 1024)));

  const multiEntryTransactions = diskTransactions.filter(({ entryCount }) => entryCount > 1);
  const singleEntryTransactions = diskTransactions.filter(({ entryCount }) => entryCount === 1);
  assert.equal(store.spilled, true);
  assert.equal(multiEntryTransactions.length >= 2, true);
  assert.equal(
    multiEntryTransactions.every(({ serializedBytes }) => serializedBytes <= store.maxBatchBytes),
    true,
  );
  assert.equal(
    singleEntryTransactions.some(({ serializedBytes }) => serializedBytes > store.maxBatchBytes),
    true,
  );
  assert.equal(store.node('larger-valid-spill-trigger').concept.length, 2 * 1024 * 1024);
});

test('rejects non-array and empty batch inputs before enqueue', async (t) => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  t.after(() => store.close().catch(() => {}));
  async function* generatedEntries() {
    yield node('generator-entry', 'must-not-run');
  }

  await assert.rejects(
    () => store.applyBatch(generatedEntries()),
    { code: 'invalid_request' },
  );
  await assert.rejects(
    () => store.applyBatch([]),
    { code: 'invalid_request' },
  );
  assert.equal(store.node('generator-entry'), undefined);
});

test('exposes immutable configured batch admission limits', async (t) => {
  const store = await createBoundedOverlayStore({
    maxMemoryBytes: 1024 * 1024,
    maxRecordBytes: 4096,
  });
  t.after(() => store.close().catch(() => {}));

  assert.equal(store.maxBatchEntries, 256);
  assert.equal(store.maxBatchBytes, 4096);
  assert.equal(store.maxRecordBytes, 4096);
  assert.throws(() => { store.maxBatchEntries = 1; }, TypeError);
  assert.throws(() => { store.maxBatchBytes = 1; }, TypeError);
  assert.throws(() => { store.maxRecordBytes = 1; }, TypeError);
  assert.throws(() => Object.defineProperty(store, 'maxBatchEntries', { value: 1 }), TypeError);
  assert.throws(() => Object.defineProperty(store, 'maxBatchBytes', { value: 1 }), TypeError);
  assert.throws(() => Object.defineProperty(store, 'maxRecordBytes', { value: 1 }), TypeError);
  assert.equal(store.maxBatchEntries, 256);
  assert.equal(store.maxBatchBytes, 4096);
  assert.equal(store.maxRecordBytes, 4096);
});

test('async batch streaming detaches the exact measured JSON before queueing', async () => {
  const store = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  let toJsonCalls = 0;
  const callerOwned = {};
  Object.defineProperty(callerOwned, 'hidden', {
    value: Buffer.alloc(4 * 1024 * 1024),
    enumerable: false,
  });
  callerOwned.toJSON = () => {
    toJsonCalls += 1;
    return node('stream-detached', `serialization-${toJsonCalls}`);
  };
  async function* entries() {
    yield callerOwned;
  }

  await applyOverlayEntriesInBatches(store, entries());

  assert.equal(toJsonCalls, 1);
  assert.equal(store.node('stream-detached').concept, 'serialization-1');
  await store.close();
});

test('async batch streaming rejects an oversized entry before decoding a second copy', async (t) => {
  const store = await createBoundedOverlayStore({
    maxMemoryBytes: 1024 * 1024,
    maxRecordBytes: 128,
  });
  t.after(() => store.close().catch(() => {}));
  async function* entries() {
    yield node('oversized-stream-entry', 'x'.repeat(512));
  }
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = (...args) => {
    parseCalls += 1;
    return originalParse(...args);
  };
  try {
    await assert.rejects(
      () => applyOverlayEntriesInBatches(store, entries()),
      { code: 'result_too_large', status: 413, retryable: false },
    );
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(parseCalls, 0);
});

test('batch admission measures a Proxy serialization instead of trusting forged encoded metadata', async (t) => {
  const store = await createBoundedOverlayStore({
    maxMemoryBytes: 1024 * 1024,
    maxRecordBytes: 128,
  });
  t.after(() => store.close().catch(() => {}));
  const forgedRecord = node('forged-exact-encoded', 'x'.repeat(504));
  const forgedText = JSON.stringify(forgedRecord);
  const forgedEncoded = Object.freeze({ text: forgedText, bytes: 1 });
  const proxy = new Proxy({}, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return forgedEncoded;
      if (property === 'toJSON') return () => forgedRecord;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(Buffer.byteLength(forgedText, 'utf8'), 576);

  await assert.rejects(
    () => store.applyBatch([proxy]),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.equal(store.node('forged-exact-encoded'), undefined);
});

test('async batch streaming keeps ten thousand tiny records within forty apply batches', async () => {
  const appliedBatchSizes = [];
  const overlay = {
    maxBatchEntries: 256,
    maxBatchBytes: 1024 * 1024,
    maxRecordBytes: 16 * 1024 * 1024,
    async applyBatch(entries) {
      appliedBatchSizes.push(entries.length);
    },
  };
  async function* entries() {
    for (let index = 0; index < 10_000; index += 1) {
      yield node(`tiny-throughput-${index}`, 'x');
    }
  }

  await applyOverlayEntriesInBatches(overlay, entries());

  assert.equal(appliedBatchSizes.length, 40);
  assert.equal(appliedBatchSizes.every((size) => size <= 256), true);
  assert.equal(appliedBatchSizes.reduce((sum, size) => sum + size, 0), 10_000);
});

test('rejects batch entry-count and aggregate-byte overflow before enqueue', async (t) => {
  const countStore = await createBoundedOverlayStore({ maxMemoryBytes: 1024 * 1024 });
  t.after(() => countStore.close().catch(() => {}));
  await assert.rejects(
    () => countStore.applyBatch(Array.from({ length: 257 }, (_, index) =>
      node(`too-many-${index}`, 'x'))),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.equal(countStore.node('too-many-0'), undefined);

  const byteStore = await createBoundedOverlayStore({
    maxMemoryBytes: 1024 * 1024,
    maxRecordBytes: 512,
  });
  t.after(() => byteStore.close().catch(() => {}));
  const oversized = [
    node('aggregate-a', 'a'.repeat(220)),
    node('aggregate-b', 'b'.repeat(220)),
  ];
  const encodedSizes = oversized.map((entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8'));
  assert.equal(encodedSizes.every((bytes) => bytes < 512), true);
  assert.equal(encodedSizes.reduce((sum, bytes) => sum + bytes, 0) > 512, true);
  await assert.rejects(
    () => byteStore.applyBatch(oversized),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.equal(byteStore.node('aggregate-a'), undefined);
});

test('scales aggregate SQLite reservation headroom with unique batch cardinality', async (t) => {
  const operationRoot = await tempDir();
  let captureReservations = false;
  const reservationSamples = [];
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 8 * 1024 * 1024,
    _testHooks: {
      async afterLedgerPublish({ ledgerPath }) {
        if (!captureReservations) return;
        const ledger = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
        reservationSamples.push(Object.values(ledger.reservations)
          .flatMap((entry) => Object.values(entry.kinds))
          .reduce((sum, bytes) => sum + bytes, 0));
      },
    },
  });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 4 * 1024 * 1024,
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
  });
  await store.apply(node('seed', 'seed'));
  captureReservations = true;
  await store.applyBatch(Array.from({ length: 4 }, (_, index) =>
    node(`cardinality-${index}`, 'x')));
  captureReservations = false;

  const peakReservation = Math.max(...reservationSamples);
  assert.equal(peakReservation >= 2 * 4 * 128 * 1024, true);
  assert.equal(peakReservation < 2 * 5 * 128 * 1024, true);
});

test('shared quota serializes concurrent spilled batches without aggregate overcommit', async (t) => {
  const operationRoot = await tempDir();
  const maxBytes = 1_400_000;
  const scratchQuota = await createOperationScratchQuota({ operationRoot, maxBytes });
  let markLeftReserved;
  let releaseLeft;
  const leftReserved = new Promise((resolve) => { markLeftReserved = resolve; });
  const leftGate = new Promise((resolve) => { releaseLeft = resolve; });
  let blockLeft = false;
  const left = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 4 * 1024 * 1024,
    _testHooks: {
      async beforeDiskMutation({ normalized }) {
        if (!blockLeft || normalized.key !== 'shared-left-0') return;
        markLeftReserved();
        await leftGate;
      },
    },
  });
  const right = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 4 * 1024 * 1024,
  });
  let leftBatch = null;
  t.after(async () => {
    releaseLeft();
    await Promise.allSettled([leftBatch].filter(Boolean));
    await left.close().catch(() => {});
    await right.close().catch(() => {});
    scratchQuota.close();
  });
  await left.apply(node('shared-left-seed', 'seed'));
  await right.apply(node('shared-right-seed', 'seed'));
  blockLeft = true;
  leftBatch = left.applyBatch(Array.from({ length: 4 }, (_, index) =>
    node(`shared-left-${index}`, 'left')));
  await leftReserved;

  const rightOutcome = await right.applyBatch(Array.from({ length: 4 }, (_, index) =>
    node(`shared-right-${index}`, 'right'))).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  assert.equal(rightOutcome.ok, false);
  assert.equal(rightOutcome.error.code, 'result_too_large');
  assert.equal(rightOutcome.error.status, 413);
  releaseLeft();
  await leftBatch;
  await left.close();
  await right.close();

  const usedBytes = await scratchQuota.reconcile();
  assert.equal(usedBytes <= maxBytes, true);
  assert.deepEqual(await overlayFiles(operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(reservedBytes, 0);
});

test('mixed batch spills early in-memory entries and commits the remaining suffix', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  const transactionSizes = [];
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 160,
    maxDiskBytes: 8 * 1024 * 1024,
    _testHooks: {
      async afterDiskTransaction({ entryCount }) {
        transactionSizes.push(entryCount);
      },
    },
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
  });

  const entries = Array.from({ length: 4 }, (_, index) =>
    node(`mixed-${index}`, 'x'.repeat(8)));
  await store.applyBatch(entries);

  assert.equal(store.spilled, true);
  assert.equal(transactionSizes.length, 2);
  assert.equal(transactionSizes[0] > 0 && transactionSizes[0] < entries.length, true);
  assert.equal(transactionSizes.reduce((sum, count) => sum + count, 0), entries.length);
  assert.deepEqual(
    (await collect(store.iterateNodeUpserts())).map((record) => record.id),
    entries.map((entry) => entry.record.id),
  );
});

test('threads a per-call abort through multi-chunk initial spill', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 256 * 1024 * 1024,
  });
  const batchAbort = new AbortController();
  let abortDuringSpill = false;
  let diskTransactions = 0;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 64 * 1024,
    maxDiskBytes: 128 * 1024 * 1024,
    maxRecordBytes: 128 * 1024,
    _testHooks: {
      async afterDiskTransaction() {
        diskTransactions += 1;
        if (!abortDuringSpill || diskTransactions !== 1) return;
        batchAbort.abort(Object.assign(new Error('stop initial spill'), {
          name: 'AbortError',
        }));
      },
    },
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
  });
  for (let index = 0; index < 300; index += 1) {
    await store.apply(node(`retained-for-abort-${index}`, 'x'.repeat(32)));
  }
  assert.equal(store.spilled, false);
  abortDuringSpill = true;

  await assert.rejects(
    () => store.applyBatch([node('abort-spill-trigger', 'y'.repeat(80 * 1024))], {
      signal: batchAbort.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(diskTransactions, 1);
  assert.deepEqual(await overlayFiles(operationRoot), []);
});

test('rolls back a SQLite batch when abort is observed after its first statement', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  const batchAbort = new AbortController();
  let injectAbort = false;
  let statementsObserved = 0;
  let rollbackSnapshot = null;
  let store;
  store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 8 * 1024 * 1024,
    _testHooks: {
      afterDiskStatement() {
        if (!injectAbort) return;
        statementsObserved += 1;
        if (statementsObserved === 1) {
          batchAbort.abort(Object.assign(new Error('stop inside SQLite transaction'), {
            name: 'AbortError',
          }));
        }
      },
      async afterDiskRollback() {
        rollbackSnapshot = {
          existing: store.node('rollback-existing')?.concept,
          first: store.node('rollback-first'),
          second: store.node('rollback-second'),
        };
      },
    },
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
  });
  await store.apply(node('rollback-existing', 'before'));
  injectAbort = true;

  await assert.rejects(
    () => store.applyBatch([
      node('rollback-first', 'one'),
      node('rollback-second', 'two'),
    ], { signal: batchAbort.signal }),
    { name: 'AbortError' },
  );
  assert.equal(statementsObserved, 1);
  assert.deepEqual(rollbackSnapshot, {
    existing: 'before',
    first: undefined,
    second: undefined,
  });
  assert.deepEqual(await overlayFiles(operationRoot), []);
});

test('post-COMMIT failure cleans physical growth and settles the outstanding reservation', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  let failAfterCommit = false;
  let postCommitFailures = 0;
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 8 * 1024 * 1024,
    _testHooks: {
      async afterDiskCommit() {
        if (!failAfterCommit) return;
        failAfterCommit = false;
        postCommitFailures += 1;
        throw Object.assign(new Error('post-COMMIT accounting crash'), { code: 'EIO' });
      },
    },
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
  });
  await store.apply(node('commit-seed', 'seed'));
  failAfterCommit = true;

  await assert.rejects(
    () => store.applyBatch([node('committed-before-crash', 'value')]),
    /post-COMMIT accounting crash/,
  );
  assert.equal(postCommitFailures, 1);
  assert.deepEqual(await overlayFiles(operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(reservedBytes, 0);
});

test('uses the configured record envelope for node IDs and object-derived edge keys', async (t) => {
  const store = await createBoundedOverlayStore({
    maxMemoryBytes: 1024 * 1024,
    maxRecordBytes: 64 * 1024,
  });
  t.after(() => store.close().catch(() => {}));

  const nodeId = 'n'.repeat(32 * 1024);
  const edgeSource = 's'.repeat(16 * 1024);
  const edgeTarget = 't'.repeat(16 * 1024);
  await store.applyBatch([node(nodeId, 'accepted within record envelope')]);
  await store.applyBatch([edge(edgeSource, edgeTarget)]);
  assert.equal(store.node(nodeId).concept, 'accepted within record envelope');
  assert.equal(store.edge({ source: edgeSource, target: edgeTarget }).weight, 1);

  await assert.rejects(
    () => store.applyBatch([node('n'.repeat(64 * 1024), 'beyond record envelope')]),
    { code: 'result_too_large', status: 413, retryable: false },
  );
});

test('eagerly detaches a bounded batch before enqueue and preserves queued apply order', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  let releaseBlocker;
  let markBlockerBlocked;
  const blockerBlocked = new Promise((resolve) => { markBlockerBlocked = resolve; });
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const transactionSizes = [];
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 32 * 1024 * 1024,
    _testHooks: {
      async beforeDiskMutation({ normalized }) {
        if (normalized.key !== 'batch-blocker') return;
        markBlockerBlocked();
        await blockerGate;
      },
      async afterDiskTransaction({ entryCount }) {
        transactionSizes.push(entryCount);
      },
    },
  });
  t.after(async () => {
    await store.close().catch(() => {});
    scratchQuota.close();
  });
  await store.apply(node('seed', 'seed'));
  transactionSizes.length = 0;

  const blocker = store.apply(node('batch-blocker', 'block'));
  await blockerBlocked;
  const entries = [
    node('detached-before-enqueue', 'before'),
    node('ordered-after-batch', 'batch'),
  ];
  const batch = store.applyBatch(entries);
  entries[0].record.concept = 'mutated-after-call';
  entries.push(node('pushed-after-call', 'must-not-apply'));
  const laterApply = store.apply(node('ordered-after-batch', 'queued-after-batch'));
  releaseBlocker();
  await Promise.all([blocker, batch, laterApply]);

  assert.deepEqual(transactionSizes, [1, 2, 1]);
  assert.equal(store.node('detached-before-enqueue').concept, 'before');
  assert.equal(store.node('pushed-after-call'), undefined);
  assert.equal(store.node('ordered-after-batch').concept, 'queued-after-batch');

  await store.close();
});

test('queued batch admission retains encoded records without eagerly decoding graphs', async (t) => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  let releaseBlocker;
  let markBlockerBlocked;
  const blockerBlocked = new Promise((resolve) => { markBlockerBlocked = resolve; });
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    maxMemoryBytes: 0,
    maxDiskBytes: 32 * 1024 * 1024,
    _testHooks: {
      async beforeDiskMutation({ normalized }) {
        if (normalized.key !== 'encoded-queue-blocker') return;
        markBlockerBlocked();
        await blockerGate;
      },
    },
  });
  t.after(async () => {
    releaseBlocker();
    await store.close().catch(() => {});
    scratchQuota.close();
  });
  await store.apply(node('seed', 'seed'));
  const blocker = store.apply(node('encoded-queue-blocker', 'block'));
  await blockerBlocked;

  const entries = [
    node('queued-encoded-1', 'before-1'),
    node('queued-encoded-2', 'before-2'),
  ];
  const originalParse = JSON.parse;
  let queuedRecordParseCalls = 0;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.includes('queued-encoded-')) {
      queuedRecordParseCalls += 1;
    }
    return originalParse(text, ...args);
  };
  let batch = null;
  try {
    batch = store.applyBatch(entries);
    assert.equal(queuedRecordParseCalls, 0);
    entries[0].record.concept = 'mutated-after-admission';
    releaseBlocker();
    await Promise.all([blocker, batch]);
    assert.equal(queuedRecordParseCalls, entries.length);
  } finally {
    JSON.parse = originalParse;
    releaseBlocker();
    await Promise.allSettled([blocker, batch].filter(Boolean));
  }

  assert.equal(store.node('queued-encoded-1').concept, 'before-1');
  assert.equal(store.node('queued-encoded-2').concept, 'before-2');
});

test('batch abort fails closed, cleans exact artifacts, and settles aggregate quota', async () => {
  const operationRoot = await tempDir();
  const operationAbort = new AbortController();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
    signal: operationAbort.signal,
  });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    signal: operationAbort.signal,
    maxMemoryBytes: 0,
    maxDiskBytes: 32 * 1024 * 1024,
    _testHooks: {
      async beforeDiskMutation({ normalized }) {
        if (normalized.key !== 'abort-batch-17') return;
        operationAbort.abort(Object.assign(new Error('stop batch import'), {
          name: 'AbortError',
        }));
      },
    },
  });

  await assert.rejects(
    () => store.applyBatch(Array.from({ length: 64 }, (_, index) =>
      node(`abort-batch-${index}`, `value-${index}`))),
    { name: 'AbortError' },
  );
  await store.close();
  assert.deepEqual(await overlayFiles(operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reservedBytes = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(reservedBytes, 0);
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

test('bounds tiny pending entry count while an earlier disk mutation is blocked', async () => {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 8 * 1024 * 1024,
  });
  const operationAbort = new AbortController();
  let releaseFirst;
  let markFirstBlocked;
  const firstBlocked = new Promise((resolve) => { markFirstBlocked = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const store = await createBoundedOverlayStore({
    operationRoot,
    scratchQuota,
    signal: operationAbort.signal,
    maxMemoryBytes: 0,
    maxDiskBytes: 4 * 1024 * 1024,
    _testHooks: {
      async beforeDiskMutation({ normalized }) {
        if (normalized.key !== 'blocked-first') return;
        markFirstBlocked();
        await firstGate;
      },
    },
  });
  const first = store.apply(node('blocked-first', 'first'));
  await firstBlocked;

  const queued = Array.from({ length: 5000 }, (_, index) =>
    store.apply(node(`tiny-${index}`, 'x')).then(
      () => null,
      (error) => error,
    ));
  await new Promise((resolve) => setImmediate(resolve));
  const immediateRejections = (await Promise.all(queued.map(async (outcome) =>
    Promise.race([
      outcome,
      new Promise((resolve) => setImmediate(() => resolve(null))),
    ])))).filter(Boolean);

  try {
    assert.equal(immediateRejections.length > 0, true);
    assert.equal(immediateRejections.every((error) => error.code === 'result_too_large'), true);
  } finally {
    operationAbort.abort(Object.assign(new Error('stop queued overlay mutations'), {
      name: 'AbortError',
    }));
    releaseFirst();
    await Promise.allSettled([first, ...queued]);
    await store.close();
    scratchQuota.close();
  }
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
