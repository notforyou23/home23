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
  const sizesAtRejectedClaim = [];
  const observingQuota = {
    operationRoot: ctx.scratchQuota.operationRoot,
    assertOperationRoot: (...args) => ctx.scratchQuota.assertOperationRoot(...args),
    async claim(...args) {
      const before = (await fsp.stat(tempPath)).size;
      try {
        return await ctx.scratchQuota.claim(...args);
      } catch (error) {
        sizesAtRejectedClaim.push([before, (await fsp.stat(tempPath)).size]);
        throw error;
      }
    },
    release: (...args) => ctx.scratchQuota.release(...args),
    reconcile: (...args) => ctx.scratchQuota.reconcile(...args),
  };
  const writer = await createQuotaBackpressuredJsonlGzipWriter(ctx.outputPath, {
    operationRoot: ctx.operationRoot,
    scratchQuota: observingQuota,
    reservationWindowBytes: 16 * 1024,
    _testHooks: {
      afterTempCreated(input) { tempPath = input.tempPath; },
    },
  });

  await assert.rejects(() => writer.writeAll([{ id: 1, text: 'quota' }]), {
    code: 'result_too_large', status: 413, retryable: false,
  });
  assert.equal(await exists(ctx.outputPath), false);
  assert.equal(tempPath !== null, true);
  assert.deepEqual(sizesAtRejectedClaim, [[0, 0]]);
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

test('cleanup fails closed on directory replacement, retains quota, and succeeds after restoration', async () => {
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
  const reserved = Object.values(failedLedger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, value) => sum + value, 0);
  assert.equal(reserved > 0, true);

  await fsp.rm(ctx.attemptRoot, { recursive: true });
  await fsp.rename(movedAttemptRoot, ctx.attemptRoot);
  await writer.cleanup();
  assert.equal(await exists(tempPath), false);
  assert.equal(await exists(ctx.outputPath), false);
  const cleanLedger = JSON.parse(await fsp.readFile(path.join(ctx.operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.deepEqual(cleanLedger.reservations, {});
  ctx.scratchQuota.close();
});
