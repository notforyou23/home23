import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createOperationScratchQuota,
  createQuotaBackpressuredJsonlGzipWriter,
  readJsonl,
} = require('../../shared/memory-source');
const {
  createBoundedClusterCounter,
} = require('../../shared/memory-source/legacy-projection.cjs');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-projection-writer-'));
}

async function fixture({ maxBytes = 16 * 1024 * 1024 } = {}) {
  const operationRoot = await tempDir();
  const scratchQuota = await createOperationScratchQuota({ operationRoot, maxBytes });
  const attemptRoot = path.join(scratchQuota.operationRoot, 'source-projections', '.tmp-test');
  await fsp.mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  return {
    operationRoot: scratchQuota.operationRoot,
    scratchQuota,
    attemptRoot,
    outputPath: path.join(attemptRoot, 'nodes.jsonl.gz'),
  };
}

async function exists(filePath) {
  return fsp.access(filePath).then(() => true).catch(() => false);
}

async function collect(filePath) {
  const records = [];
  for await (const record of readJsonl(filePath, {
    gzip: true,
    confinedRoot: path.dirname(filePath),
  })) records.push(record);
  return records;
}

test('legacy cluster cardinality is bounded by both keys and retained bytes', () => {
  const byKeys = createBoundedClusterCounter({ maxKeys: 2, maxBytes: 1024 });
  assert.equal(byKeys.add('alpha'), true);
  assert.equal(byKeys.add('alpha'), false);
  assert.equal(byKeys.add('beta'), true);
  assert.throws(() => byKeys.add('gamma'), { code: 'result_too_large', status: 413 });

  const byBytes = createBoundedClusterCounter({ maxKeys: 100, maxBytes: 70 });
  byBytes.add('a');
  assert.equal(byBytes.retainedBytes, 33);
  assert.throws(() => byBytes.add('123456'), { code: 'result_too_large', status: 413 });
});

async function sha256File(filePath) {
  const bytes = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function temporaryArtifacts(root) {
  const matches = [];
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(child);
      else if (/\.tmp-|\.partial-|\.jsonl\.gz\./.test(entry.name)) matches.push(child);
    }
  }
  await walk(root);
  return matches.sort();
}

async function quotaSnapshot(operationRoot) {
  const ledgerPath = path.join(operationRoot, '.scratch-quota.json');
  const text = await fsp.readFile(ledgerPath, 'utf8');
  const ledger = JSON.parse(text);
  const reservations = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, value) => sum + value, 0);
  let physical = 0;
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(candidate);
      else if (candidate !== ledgerPath && entry.name !== '.scratch-quota.lock') {
        physical += (await fsp.stat(candidate)).size;
      }
    }
  }
  await walk(operationRoot);
  return {
    physical,
    reservations,
    ledgerBytes: Buffer.byteLength(text, 'utf8'),
    aggregate: physical + reservations + Buffer.byteLength(text, 'utf8') + 2048,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('streams an async source into valid gzip with exact count, bytes, digest, and bounded lookahead', async () => {
  const ctx = await fixture();
  let yielded = 0;
  let accepted = 0;
  let maxAhead = 0;
  async function* records() {
    for (let index = 0; index < 250; index += 1) {
      yielded += 1;
      maxAhead = Math.max(maxAhead, yielded - accepted);
      yield { id: index, concept: `record-${index}-${'x'.repeat(2048)}` };
    }
  }
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 32 * 1024,
    _testHooks: {
      afterRecordAccepted() { accepted += 1; },
    },
  });
  const result = await writer.writeAll(records());

  assert.equal(result.count, 250);
  assert.equal(result.bytes, (await fsp.stat(ctx.outputPath)).size);
  assert.equal(result.sha256, await sha256File(ctx.outputPath));
  assert.equal(maxAhead <= 1, true);
  assert.deepEqual((await collect(ctx.outputPath)).map((row) => row.id),
    Array.from({ length: 250 }, (_, index) => index));
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  ctx.scratchQuota.close();
});

test('rejects aggregate quota before compressed output growth and removes its exact temp artifact', async () => {
  const ctx = await fixture({ maxBytes: 24 * 1024 });
  let tempPath = null;
  const sizesAtRejectedGrowth = [];
  const observingQuota = {
    operationRoot: ctx.scratchQuota.operationRoot,
    assertOperationRoot: (...args) => ctx.scratchQuota.assertOperationRoot(...args),
    async claim(...args) {
      return ctx.scratchQuota.claim(...args);
    },
    release: (...args) => ctx.scratchQuota.release(...args),
    reconcile: (...args) => ctx.scratchQuota.reconcile(...args),
    async withPhysicalGrowth(...args) {
      const before = (await fsp.stat(tempPath)).size;
      try {
        return await ctx.scratchQuota.withPhysicalGrowth(...args);
      } catch (error) {
        sizesAtRejectedGrowth.push([before, (await fsp.stat(tempPath)).size]);
        throw error;
      }
    },
  };
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: observingQuota,
    reservationWindowBytes: 16 * 1024,
    _testHooks: {
      afterTempCreated(input) { tempPath = input.tempPath; },
    },
  });

  await assert.rejects(() => writer.writeAll([{
    id: 1,
    text: crypto.randomBytes(32 * 1024).toString('base64'),
  }]), {
    code: 'result_too_large', status: 413, retryable: false,
  });
  assert.equal(await exists(ctx.outputPath), false);
  assert.equal(tempPath !== null, true);
  assert.equal(sizesAtRejectedGrowth.length, 1);
  assert.equal(sizesAtRejectedGrowth[0][0] > 0, true);
  assert.equal(sizesAtRejectedGrowth[0][1], sizesAtRejectedGrowth[0][0]);
  assert.equal(await exists(tempPath), false);
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  ctx.scratchQuota.close();
});

test('abort stops async generator consumption, preserves AbortError, and leaves no artifacts', async () => {
  const ctx = await fixture();
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop projection output'), { name: 'AbortError' });
  let consumed = 0;
  async function* records() {
    for (let index = 0; index < 1000; index += 1) {
      consumed += 1;
      if (consumed === 5) controller.abort(reason);
      yield { id: index, text: 'x'.repeat(4096) };
    }
  }
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    signal: controller.signal,
    reservationWindowBytes: 16 * 1024,
  });

  await assert.rejects(() => writer.writeAll(records()), (error) => error === reason);
  assert.equal(consumed, 5);
  assert.equal(await exists(ctx.outputPath), false);
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  ctx.scratchQuota.close();
});

test('shared quota signal abort removes the exact temp and reconciles its ledger', async () => {
  const operationRoot = await tempDir();
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop shared quota writer'), { name: 'AbortError' });
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 1024 * 1024,
    signal: controller.signal,
  });
  const attemptRoot = path.join(scratchQuota.operationRoot, 'source-projections', '.tmp-shared-abort');
  await fsp.mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  const outputPath = path.join(attemptRoot, 'nodes.jsonl.gz');
  let tempPath = null;
  const writer = await createQuotaBackpressuredJsonlGzipWriter(outputPath, {
    operationRoot: scratchQuota.operationRoot,
    scratchQuota,
    signal: controller.signal,
    reservationWindowBytes: 4096,
    gzipChunkBytes: 1024,
    _testHooks: {
      afterTempCreated(input) { tempPath = input.tempPath; },
      beforeCompressedWrite() { controller.abort(reason); },
    },
  });

  await assert.rejects(
    () => writer.writeAll([{ id: 1, text: crypto.randomBytes(8192).toString('hex') }]),
    (error) => error === reason,
  );
  assert.equal(tempPath !== null, true);
  assert.equal(await exists(tempPath), false);
  assert.equal(await exists(outputPath), false);
  assert.deepEqual(await temporaryArtifacts(operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  scratchQuota.close();
});

test('serializes concurrent writes and compressed disk writes under backpressure', async () => {
  const ctx = await fixture();
  let activeDiskWrites = 0;
  let maxActiveDiskWrites = 0;
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 4096,
    gzipChunkBytes: 1024,
    _testHooks: {
      async beforeCompressedWrite() {
        activeDiskWrites += 1;
        maxActiveDiskWrites = Math.max(maxActiveDiskWrites, activeDiskWrites);
        await new Promise((resolve) => setImmediate(resolve));
      },
      afterCompressedWrite() { activeDiskWrites -= 1; },
    },
  });
  const records = Array.from({ length: 48 }, (_, index) => ({
    id: index,
    payload: crypto.createHash('sha256').update(String(index)).digest('hex').repeat(128),
  }));
  await Promise.all(records.map((record) => writer.write(record)));
  const result = await writer.finish();

  assert.equal(result.count, records.length);
  assert.equal(maxActiveDiskWrites, 1);
  assert.deepEqual(await collect(ctx.outputPath), records);
  ctx.scratchQuota.close();
});

test('enforces the per-record UTF-8 limit before accepting the record', async () => {
  const ctx = await fixture();
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    maxRecordBytes: 128,
    reservationWindowBytes: 4096,
  });
  await assert.rejects(() => writer.write({ id: 1, text: 'é'.repeat(256) }), {
    code: 'result_too_large', status: 413, retryable: false,
  });
  await writer.cleanup();
  assert.equal(await exists(ctx.outputPath), false);
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  ctx.scratchQuota.close();
});

test('cleanup fails closed on directory replacement, preserves its artifact, and succeeds after restoration', async () => {
  const ctx = await fixture();
  let compressedWriteStarted;
  let allowCompressedWrite;
  const started = new Promise((resolve) => { compressedWriteStarted = resolve; });
  const allowed = new Promise((resolve) => { allowCompressedWrite = resolve; });
  let tempPath = null;
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 16 * 1024,
    _testHooks: {
      afterTempCreated(input) { tempPath = input.tempPath; },
      async beforeCompressedWrite() {
        compressedWriteStarted();
        await allowed;
      },
    },
  });
  await writer.write({ id: 1, text: crypto.randomBytes(8192).toString('hex') });
  const finishing = writer.finish();
  await started;

  const movedAttemptRoot = `${ctx.attemptRoot}-original`;
  await fsp.rename(ctx.attemptRoot, movedAttemptRoot);
  await fsp.mkdir(ctx.attemptRoot, { mode: 0o700 });
  const sentinel = path.join(ctx.attemptRoot, path.basename(tempPath));
  await fsp.writeFile(sentinel, 'replacement sentinel');
  allowCompressedWrite();

  await assert.rejects(() => finishing, { code: 'invalid_memory_source' });
  await assert.rejects(() => writer.cleanup(), { code: 'invalid_memory_source' });
  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'replacement sentinel');
  const failedLedger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(failedLedger.reservations, {});
  assert.equal(failedLedger.usedBytes <= failedLedger.maxBytes, true);
  assert.equal(await exists(path.join(movedAttemptRoot, path.basename(tempPath))), true);

  await fsp.rm(ctx.attemptRoot, { recursive: true });
  await fsp.rename(movedAttemptRoot, ctx.attemptRoot);
  await writer.cleanup();
  assert.equal(await exists(tempPath), false);
  assert.equal(await exists(ctx.outputPath), false);
  const cleanLedger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(cleanLedger.reservations, {});
  ctx.scratchQuota.close();
});

test('preserves a large backpressured quota failure instead of stream teardown AbortError', async () => {
  const ctx = await fixture({ maxBytes: 24 * 1024 });
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 16 * 1024,
  });

  await assert.rejects(
    () => writer.writeAll([{
      id: 1,
      text: crypto.randomBytes(4 * 1024 * 1024).toString('hex'),
    }]),
    (error) => error?.code === 'result_too_large'
      && error?.status === 413 && error?.name !== 'AbortError',
  );
  assert.equal(await exists(ctx.outputPath), false);
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  ctx.scratchQuota.close();
});

test('abort after the first accepted record stops before pulling a second generator value', async () => {
  const ctx = await fixture();
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop after accepted record'), { name: 'AbortError' });
  let consumed = 0;
  async function* records() {
    for (let index = 0; index < 20; index += 1) {
      consumed += 1;
      yield { id: index, text: 'accepted boundary' };
    }
  }
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    signal: controller.signal,
    reservationWindowBytes: 4096,
    _testHooks: {
      afterRecordAccepted({ count }) {
        if (count === 1) controller.abort(reason);
      },
    },
  });

  await assert.rejects(() => writer.writeAll(records()), (error) => error === reason);
  assert.equal(consumed, 1);
  assert.equal(await exists(ctx.outputPath), false);
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  ctx.scratchQuota.close();
});

test('bounds concurrent admission by pending write count and serialized UTF-8 bytes', async () => {
  const countCtx = await fixture();
  const countBlocked = deferred();
  const countEntered = deferred();
  const countWriter = await createQuotaBackpressuredJsonlGzipWriter(countCtx.outputPath, {
    operationRoot: countCtx.operationRoot,
    scratchQuota: countCtx.scratchQuota,
    reservationWindowBytes: 4096,
    maxPendingWrites: 2,
    maxPendingBytes: 1024,
    _testHooks: {
      async afterRecordAccepted({ count }) {
        if (count === 1) {
          countEntered.resolve();
          await countBlocked.promise;
        }
      },
    },
  });
  const first = countWriter.write({ id: 1, text: 'a'.repeat(128) });
  await countEntered.promise;
  const second = countWriter.write({ id: 2, text: 'b'.repeat(128) });
  let overflowSerialized = 0;
  const overflow = countWriter.write({
    id: 3,
    get text() {
      overflowSerialized += 1;
      return 'c'.repeat(128);
    },
  });
  countBlocked.resolve();
  await assert.rejects(overflow, {
    code: 'source_busy', retryable: true, limitKind: 'pending_writes', limit: 2,
  });
  assert.equal(overflowSerialized, 0);
  await Promise.all([first, second]);
  await countWriter.finish();
  assert.deepEqual((await collect(countCtx.outputPath)).map((record) => record.id), [1, 2]);
  countCtx.scratchQuota.close();

  const byteCtx = await fixture();
  const byteBlocked = deferred();
  const byteEntered = deferred();
  const byteWriter = await createQuotaBackpressuredJsonlGzipWriter(byteCtx.outputPath, {
    operationRoot: byteCtx.operationRoot,
    scratchQuota: byteCtx.scratchQuota,
    reservationWindowBytes: 4096,
    maxPendingWrites: 4,
    maxPendingBytes: 320,
    _testHooks: {
      async afterRecordAccepted({ count }) {
        if (count === 1) {
          byteEntered.resolve();
          await byteBlocked.promise;
        }
      },
    },
  });
  const byteFirst = byteWriter.write({ id: 1, text: 'x'.repeat(180) });
  await byteEntered.promise;
  const byteOverflow = byteWriter.write({ id: 2, text: 'y'.repeat(180) });
  await assert.rejects(byteOverflow, {
    code: 'source_busy', retryable: true, limitKind: 'pending_bytes', limit: 320,
  });
  byteBlocked.resolve();
  await byteFirst;
  await byteWriter.write({ id: 2, text: 'y'.repeat(180) });
  await byteWriter.finish();
  assert.deepEqual((await collect(byteCtx.outputPath)).map((record) => record.id), [1, 2]);
  byteCtx.scratchQuota.close();
});

test('cleanup remembers a successful unlink across a failed post-unlink identity check', async () => {
  const ctx = await fixture();
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 8192,
  });
  await writer.write({ id: 1, text: crypto.randomBytes(32 * 1024).toString('hex') });
  const movedAttemptRoot = `${ctx.attemptRoot}-post-unlink`;
  const originalUnlink = fsp.unlink;
  let replaced = false;
  fsp.unlink = async (candidate) => {
    await originalUnlink(candidate);
    if (!replaced && candidate === writer.tempPath) {
      replaced = true;
      await fsp.rename(ctx.attemptRoot, movedAttemptRoot);
      await fsp.mkdir(ctx.attemptRoot, { mode: 0o700 });
    }
  };
  try {
    await assert.rejects(() => writer.cleanup(), { code: 'invalid_memory_source' });
  } finally {
    fsp.unlink = originalUnlink;
  }
  assert.equal(await exists(path.join(movedAttemptRoot, path.basename(writer.tempPath))), false);
  await fsp.rm(ctx.attemptRoot, { recursive: true });
  await fsp.rename(movedAttemptRoot, ctx.attemptRoot);

  await writer.cleanup();
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  ctx.scratchQuota.close();
});

test('cleanup retries a transient pre-transaction quota reconciliation', async () => {
  const ctx = await fixture();
  let reconcileCalls = 0;
  const transientQuota = {
    operationRoot: ctx.scratchQuota.operationRoot,
    assertOperationRoot: (...args) => ctx.scratchQuota.assertOperationRoot(...args),
    claim: (...args) => ctx.scratchQuota.claim(...args),
    release: (...args) => ctx.scratchQuota.release(...args),
    async reconcile(...args) {
      reconcileCalls += 1;
      if (reconcileCalls === 1) {
        throw Object.assign(new Error('transient quota lock contention'), {
          code: 'source_busy', retryable: true,
        });
      }
      return ctx.scratchQuota.reconcile(...args);
    },
    withPhysicalGrowth: (...args) => ctx.scratchQuota.withPhysicalGrowth(...args),
  };
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: transientQuota,
    reservationWindowBytes: 4096,
  });

  await assert.rejects(() => writer.cleanup(), {
    code: 'source_busy', retryable: true,
  });
  await writer.cleanup();
  assert.equal(reconcileCalls, 2);
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  ctx.scratchQuota.close();
});

test('rejects a pre-publication external hard-link alias so the returned hash stays authoritative', async () => {
  const ctx = await fixture();
  const externalRoot = await tempDir();
  const externalPath = path.join(externalRoot, 'external-alias.gz');
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 4096,
    _testHooks: {
      async afterTempCreated({ tempPath }) {
        await fsp.link(tempPath, externalPath);
      },
    },
  });
  try {
    await assert.rejects(
      () => writer.writeAll([{ id: 1, text: 'immutable projection' }]),
      { code: 'invalid_memory_source', retryable: false },
    );
    assert.equal(await exists(ctx.outputPath), false);
    assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  } finally {
    await fsp.rm(externalRoot, { recursive: true, force: true });
    ctx.scratchQuota.close();
  }
});

test('serializes quota-owned physical growth and accounts partial growth without masking its error', async () => {
  const ctx = await fixture({ maxBytes: 512 * 1024 });
  const leftPath = path.join(ctx.attemptRoot, 'growth-left.bin');
  const rightPath = path.join(ctx.attemptRoot, 'growth-right.bin');
  let active = 0;
  let maxActive = 0;
  async function grow(filePath, byte) {
    return ctx.scratchQuota.withPhysicalGrowth(4096, 'test_growth', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      await fsp.writeFile(filePath, Buffer.alloc(4096, byte));
      active -= 1;
    });
  }

  await Promise.all([grow(leftPath, 1), grow(rightPath, 2)]);
  assert.equal(maxActive, 1);
  const primary = Object.assign(new Error('bounded growth callback failed'), { code: 'EIO' });
  const partialPath = path.join(ctx.attemptRoot, 'growth-partial.bin');
  await assert.rejects(
    () => ctx.scratchQuota.withPhysicalGrowth(1024, 'test_growth', async () => {
      await fsp.writeFile(partialPath, Buffer.alloc(512, 3));
      throw primary;
    }),
    (error) => error === primary,
  );
  const snapshot = await quotaSnapshot(ctx.operationRoot);
  assert.equal(snapshot.physical, 4096 + 4096 + 512);
  assert.equal(snapshot.reservations, 0);
  assert.equal(snapshot.aggregate <= ctx.scratchQuota.maxBytes, true);
  ctx.scratchQuota.close();
});

test('keeps concurrent one-mebibyte compressed windows under the aggregate hard ceiling', async () => {
  const windowBytes = 1024 * 1024;
  const maxBytes = 3_300_000;
  const ctx = await fixture({ maxBytes });
  const secondOutput = path.join(ctx.attemptRoot, 'edges.jsonl.gz');
  const simultaneous = deferred();
  let firstWindowEntries = 0;
  const observed = [];
  function hooks() {
    let first = true;
    return {
      async beforeCompressedWrite() {
        if (!first) return;
        first = false;
        firstWindowEntries += 1;
        if (firstWindowEntries === 2) simultaneous.resolve();
        await Promise.race([
          simultaneous.promise,
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
      },
      async afterCompressedWrite() {
        observed.push(await quotaSnapshot(ctx.operationRoot));
      },
    };
  }
  const [left, right] = await Promise.all([
    createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
      operationRoot: ctx.operationRoot,
      scratchQuota: ctx.scratchQuota,
      reservationWindowBytes: windowBytes,
      gzipChunkBytes: windowBytes,
      maxRecordBytes: 2 * windowBytes,
      _testHooks: hooks(),
    }),
    createQuotaBackpressuredJsonlGzipWriter(secondOutput, {
      operationRoot: ctx.operationRoot,
      scratchQuota: ctx.scratchQuota,
      reservationWindowBytes: windowBytes,
      gzipChunkBytes: windowBytes,
      maxRecordBytes: 2 * windowBytes,
      _testHooks: hooks(),
    }),
  ]);
  const records = [
    { id: 1, text: crypto.randomBytes(900 * 1024).toString('base64') },
  ];

  await Promise.all([left.writeAll(records), right.writeAll(records)]);
  assert.equal(observed.length > 0, true);
  assert.equal(Math.max(...observed.map((entry) => entry.aggregate)) <= maxBytes, true,
    JSON.stringify(observed));
  assert.equal((await fsp.stat(ctx.outputPath)).nlink, 1);
  assert.equal((await fsp.stat(secondOutput)).nlink, 1);
  ctx.scratchQuota.close();
});

test('default reservation sizing writes a tiny gzip inside a one-mebibyte aggregate quota', async () => {
  const ctx = await fixture({ maxBytes: 1024 * 1024 });
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
  });

  const result = await writer.writeAll([{ id: 1, text: 'tiny projection' }]);
  assert.equal(result.count, 1);
  assert.deepEqual(await collect(ctx.outputPath), [{ id: 1, text: 'tiny projection' }]);
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  ctx.scratchQuota.close();
});

test('atomic hard-link publication remains reconcilable throughout its dual-name window', async () => {
  const maxBytes = 1200 * 1024;
  const ctx = await fixture({ maxBytes });
  const observer = await createOperationScratchQuota({
    operationRoot: ctx.operationRoot,
    maxBytes,
    lockRetryMs: 1,
  });
  let publicationSnapshot = null;
  let reconcileSettled = false;
  let reconcilePromise = null;
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 256 * 1024,
    gzipChunkBytes: 64 * 1024,
    _testHooks: {
      async afterFinalLinked({ filePath, tempPath }) {
        assert.equal((await fsp.stat(filePath)).ino, (await fsp.stat(tempPath)).ino);
        reconcilePromise = observer.reconcile().then(() => { reconcileSettled = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reconcileSettled, false);
        publicationSnapshot = await quotaSnapshot(ctx.operationRoot);
      },
    },
  });

  const result = await writer.writeAll([{
    id: 1,
    text: crypto.randomBytes(128 * 1024).toString('base64'),
  }]);
  await reconcilePromise;
  assert.notEqual(publicationSnapshot, null);
  assert.equal(publicationSnapshot.physical >= result.bytes * 2, true);
  assert.equal(publicationSnapshot.aggregate <= maxBytes, true, JSON.stringify(publicationSnapshot));
  assert.equal(reconcileSettled, true);
  assert.equal((await fsp.stat(ctx.outputPath)).nlink, 1);
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  ctx.scratchQuota.close();
  observer.close();
});

test('publication-window failure removes both names and reconciles exact quota', async () => {
  const ctx = await fixture({ maxBytes: 1200 * 1024 });
  let linked = false;
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: ctx.scratchQuota,
    reservationWindowBytes: 256 * 1024,
    _testHooks: {
      afterFinalLinked() {
        linked = true;
        throw Object.assign(new Error('publication fault'), { code: 'EIO' });
      },
    },
  });

  await assert.rejects(
    () => writer.writeAll([{ id: 1, text: crypto.randomBytes(64 * 1024).toString('base64') }]),
    { code: 'source_unavailable', retryable: true },
  );
  assert.equal(linked, true);
  assert.equal(await exists(ctx.outputPath), false);
  assert.equal(await exists(writer.tempPath), false);
  assert.deepEqual(await temporaryArtifacts(ctx.operationRoot), []);
  const ledger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
  ctx.scratchQuota.close();
});
