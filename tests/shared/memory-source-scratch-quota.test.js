import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  assertOperationRoot,
  createOperationScratchQuota,
} = require('../../shared/memory-source');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-scratch-quota-'));
}

async function exists(filePath) {
  return fsp.access(filePath).then(() => true).catch(() => false);
}

async function runChild(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('persists one exact-root ledger and rejects mismatched or closed handles', async () => {
  const operationRoot = await tempDir();
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 256 * 1024 });
  const canonicalRoot = await fsp.realpath(operationRoot);

  assert.equal(quota.operationRoot, canonicalRoot);
  assert.equal(await quota.assertOperationRoot(operationRoot), true);
  await assert.rejects(
    () => quota.assertOperationRoot(path.dirname(operationRoot)),
    { code: 'invalid_request' },
  );

  const usedAfterClaim = await quota.claim(1024, 'overlay-test');
  assert.equal(usedAfterClaim <= quota.maxBytes, true);
  const ledgerPath = path.join(canonicalRoot, '.scratch-quota.json');
  const ledger = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  assert.equal(ledger.operationRoot, canonicalRoot);
  assert.equal(ledger.maxBytes, 256 * 1024);
  assert.equal(await exists(path.join(canonicalRoot, '.scratch-quota.lock')), false);

  await assert.rejects(
    () => createOperationScratchQuota({ operationRoot, maxBytes: 512 * 1024 }),
    { code: 'invalid_request' },
  );

  quota.close();
  await assert.rejects(() => quota.claim(1), { code: 'invalid_request' });
  await assert.rejects(() => quota.release(1), { code: 'invalid_request' });
  await assert.rejects(() => quota.reconcile(), { code: 'invalid_request' });
  await assert.rejects(() => quota.assertOperationRoot(operationRoot), { code: 'invalid_request' });
});

test('serializes concurrent handles so successful aggregate claims never exceed max', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 192 * 1024;
  const handles = await Promise.all(Array.from({ length: 12 }, () =>
    createOperationScratchQuota({ operationRoot, maxBytes })));

  const outcomes = await Promise.all(handles.map(async (quota, index) => {
    try {
      return { ok: true, index, used: await quota.claim(24 * 1024, `worker-${index}`) };
    } catch (error) {
      assert.equal(error.code, 'result_too_large');
      assert.equal(error.status, 413);
      return { ok: false, index };
    }
  }));

  assert.equal(outcomes.some((value) => value.ok), true);
  assert.equal(outcomes.some((value) => !value.ok), true);
  const authoritative = await handles[0].reconcile();
  assert.equal(authoritative <= maxBytes, true);
  const successfulBytes = outcomes.filter((value) => value.ok).length * 24 * 1024;
  assert.equal(successfulBytes <= maxBytes, true);
  handles.forEach((quota) => quota.close());
});

test('coordinates claims across processes through the durable ledger', async () => {
  const operationRoot = await tempDir();
  const modulePath = path.resolve('shared/memory-source/scratch-quota.cjs');
  const maxBytes = 160 * 1024;
  const claimBytes = 96 * 1024;
  const childScript = String.raw`
    const { createOperationScratchQuota } = require(process.argv[1]);
    (async () => {
      const quota = await createOperationScratchQuota({
        operationRoot: process.argv[2],
        maxBytes: Number(process.argv[3]),
      });
      try {
        const used = await quota.claim(Number(process.argv[4]), 'child');
        // Keep the successful reservation live long enough for the contender
        // to observe it; dead-owner reconciliation is tested separately.
        await new Promise((resolve) => setTimeout(resolve, 300));
        process.stdout.write(JSON.stringify({ ok: true, used }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
      } finally {
        quota.close();
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const args = [modulePath, operationRoot, String(maxBytes), String(claimBytes)];
  const [left, right] = await Promise.all([
    runChild(childScript, args),
    runChild(childScript, args),
  ]);
  assert.equal(left.code, 0, left.stderr);
  assert.equal(right.code, 0, right.stderr);
  const outcomes = [JSON.parse(left.stdout), JSON.parse(right.stdout)];
  assert.equal(outcomes.filter((value) => value.ok).length, 1);
  assert.deepEqual(outcomes.filter((value) => !value.ok).map((value) => value.code), ['result_too_large']);

  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  assert.equal(await quota.reconcile() <= maxBytes, true);
  quota.close();
});

test('reconcile reclaims only proven-dead reservations and retains live-handle accounting', async () => {
  const operationRoot = await tempDir();
  const modulePath = path.resolve('shared/memory-source/scratch-quota.cjs');
  const maxBytes = 256 * 1024;
  const childScript = String.raw`
    const { createOperationScratchQuota } = require(process.argv[1]);
    (async () => {
      const quota = await createOperationScratchQuota({
        operationRoot: process.argv[2],
        maxBytes: Number(process.argv[3]),
      });
      await quota.claim(32 * 1024, 'dead-worker');
      quota.close();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = await runChild(childScript, [modulePath, operationRoot, String(maxBytes)]);
  assert.equal(child.code, 0, child.stderr);
  const ledgerPath = path.join(operationRoot, '.scratch-quota.json');
  assert.equal(Object.keys(JSON.parse(await fsp.readFile(ledgerPath, 'utf8')).reservations).length, 1);

  const live = await createOperationScratchQuota({ operationRoot, maxBytes });
  assert.equal(Object.keys(JSON.parse(await fsp.readFile(ledgerPath, 'utf8')).reservations).length, 0);
  await live.claim(4096, 'live-worker');
  const observer = await createOperationScratchQuota({ operationRoot, maxBytes });
  await observer.reconcile();
  const afterLiveReconcile = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  assert.equal(Object.keys(afterLiveReconcile.reservations).length, 1);
  assert.equal(Object.values(afterLiveReconcile.reservations)[0].kinds['live-worker'], 4096);
  live.close();
  observer.close();
});

test('reconcile accounts private files without following symlinks', async () => {
  const operationRoot = await tempDir();
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 512 * 1024 });
  const before = await quota.reconcile();
  await fsp.mkdir(path.join(operationRoot, 'projection'), { mode: 0o700 });
  await fsp.writeFile(path.join(operationRoot, 'projection', 'partial.bin'), Buffer.alloc(8192));
  const afterWrite = await quota.reconcile();
  assert.equal(afterWrite >= before + 8192, true);

  const outside = path.join(await tempDir(), 'outside.bin');
  await fsp.writeFile(outside, Buffer.alloc(32));
  await fsp.symlink(outside, path.join(operationRoot, 'projection', 'escape'));
  await assert.rejects(() => quota.reconcile(), { code: 'invalid_memory_source' });
  assert.equal((await fsp.stat(outside)).size, 32);
  await fsp.rm(path.join(operationRoot, 'projection', 'escape'));

  await fsp.rm(path.join(operationRoot, 'projection', 'partial.bin'));
  const afterRemove = await quota.reconcile();
  assert.equal(afterRemove < afterWrite, true);
  quota.close();
});

test('durably reconciles actual private files after each aggregate 64 MiB of claims', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 96 * 1024 * 1024;
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  await fsp.writeFile(path.join(operationRoot, 'unclaimed-private.bin'), Buffer.alloc(4096));
  await quota.claim(64 * 1024 * 1024, 'large-component');
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.equal(ledger.actualPrivateBytes >= 4096, true);
  assert.equal(ledger.claimedSinceReconcile, 0);
  quota.close();
});

test('recovers a bounded lock only after its recorded owner is proven dead', async () => {
  const operationRoot = await tempDir();
  const canonicalRoot = await fsp.realpath(operationRoot);
  const maxBytes = 256 * 1024;
  await fsp.writeFile(path.join(operationRoot, '.scratch-quota.lock'), `${JSON.stringify({
    version: 1,
    operationRoot: canonicalRoot,
    maxBytes,
    owner: { pid: 999999, processStartedAt: 1, handleId: '00000000-0000-0000-0000-000000000000' },
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });
  let inspectedOwner = null;
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes,
    isProcessAlive: async (owner) => {
      inspectedOwner = owner;
      return false;
    },
  });
  assert.equal(inspectedOwner.pid, 999999);
  assert.equal(await exists(path.join(operationRoot, '.scratch-quota.lock')), false);
  quota.close();
});

test('one handle cannot release bytes accounted to another handle', async () => {
  const operationRoot = await tempDir();
  const left = await createOperationScratchQuota({ operationRoot, maxBytes: 256 * 1024 });
  const right = await createOperationScratchQuota({ operationRoot, maxBytes: 256 * 1024 });
  await left.claim(1024, 'left');
  await assert.rejects(() => right.release(1), { code: 'invalid_request' });
  await left.release(1024, 'left');
  left.close();
  right.close();
});

test('rejects a symlink as the trusted operation root', async () => {
  const target = await tempDir();
  const parent = await tempDir();
  const linkedRoot = path.join(parent, 'linked-operation');
  await fsp.symlink(target, linkedRoot);
  await assert.rejects(() => assertOperationRoot(linkedRoot), { code: 'invalid_memory_source' });
});

test('fails closed if the exact operation root is replaced after handle creation', async () => {
  const operationRoot = await tempDir();
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 256 * 1024 });
  const movedRoot = `${operationRoot}-moved`;
  const outside = await tempDir();
  await fsp.rename(operationRoot, movedRoot);
  await fsp.symlink(outside, operationRoot);
  await assert.rejects(() => quota.claim(1), { code: 'invalid_memory_source' });
  assert.deepEqual(await fsp.readdir(outside), []);
  quota.close();
  await fsp.rm(operationRoot);
  await fsp.rename(movedRoot, operationRoot);
});
