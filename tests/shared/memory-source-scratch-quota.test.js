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

async function regularFileBytes(directory) {
  let total = 0;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await regularFileBytes(filePath);
    else if (entry.isFile()) total += (await fsp.stat(filePath)).size;
  }
  return total;
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

test('missing Linux boot identity cannot reclaim a reservation owned by a live PID', async () => {
  const operationRoot = await tempDir();
  const modulePath = path.resolve('shared/memory-source/scratch-quota.cjs');
  const childScript = String.raw`
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const fs = require('node:fs');
    const path = require('node:path');
    const originalReadFile = fs.promises.readFile;
    let bootIdentityUnavailable = false;
    function processStat(pid, startToken) {
      return pid + ' (home23-test) ' + ['S', ...Array(18).fill('0'), startToken].join(' ');
    }
    fs.promises.readFile = async function (filePath, ...args) {
      const target = String(filePath);
      if (target === '/proc/sys/kernel/random/boot_id') {
        if (bootIdentityUnavailable) {
          const error = new Error('boot identity unavailable');
          error.code = 'ENOENT';
          throw error;
        }
        return 'test-boot-id\n';
      }
      if (target === '/proc/' + process.pid + '/stat') {
        return processStat(process.pid, 'self-start-token');
      }
      if (target === '/proc/' + process.ppid + '/stat') {
        return processStat(process.ppid, 'live-parent-start-token');
      }
      return originalReadFile.call(this, filePath, ...args);
    };
    const { createOperationScratchQuota } = require(process.argv[1]);
    (async () => {
      const owner = await createOperationScratchQuota({
        operationRoot: process.argv[2],
        maxBytes: 512 * 1024,
      });
      await owner.claim(4096, 'live-owner-with-unknown-boot');
      owner.close();

      const ledgerPath = path.join(process.argv[2], '.scratch-quota.json');
      const ledger = JSON.parse(await originalReadFile(ledgerPath, 'utf8'));
      const reservation = Object.values(ledger.reservations)[0];
      reservation.owner.pid = process.ppid;
      reservation.owner.bootToken = 'test-boot-id';
      reservation.owner.processStartToken = 'live-parent-start-token';
      ledger.usedBytes += 4096;
      await fs.promises.writeFile(ledgerPath, JSON.stringify(ledger) + '\n', { mode: 0o600 });

      bootIdentityUnavailable = true;
      const observer = await createOperationScratchQuota({
        operationRoot: process.argv[2],
        maxBytes: 512 * 1024,
      });
      const observed = JSON.parse(await originalReadFile(ledgerPath, 'utf8'));
      const reservations = Object.values(observed.reservations);
      process.stdout.write(JSON.stringify({
        reservationCount: reservations.length,
        ownerPid: reservations[0]?.owner?.pid,
        bytes: reservations[0]?.kinds?.['live-owner-with-unknown-boot'] || 0,
      }));
      observer.close();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = await runChild(childScript, [modulePath, operationRoot]);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    reservationCount: 1,
    ownerPid: process.pid,
    bytes: 4096,
  });
});

test('retains fallback ownership when a later exact observer sees the same live PID', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 512 * 1024;
  const ownerQuota = await createOperationScratchQuota({ operationRoot, maxBytes });
  await ownerQuota.claim(4096, 'fallback-live');
  ownerQuota.close();

  const ledgerPath = path.join(operationRoot, '.scratch-quota.json');
  const ledger = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  const reservation = Object.values(ledger.reservations)[0];
  reservation.owner.bootToken = 'unverifiable-boot:transient-owner-inspection';
  reservation.owner.processStartToken = 'unverifiable-start:transient-owner-inspection';
  // Preserve a conservative upper bound after making the fixture tokens longer.
  ledger.usedBytes += 4096;
  await fsp.writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });

  const observer = await createOperationScratchQuota({ operationRoot, maxBytes });
  const observed = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  assert.equal(Object.keys(observed.reservations).length, 1);
  assert.equal(Object.values(observed.reservations)[0].kinds['fallback-live'], 4096);
  observer.close();
});

test('retains a fallback-owned lock when a later exact observer sees the same live PID', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 512 * 1024;
  const fixture = await createOperationScratchQuota({ operationRoot, maxBytes });
  await fixture.claim(1, 'fallback-lock-fixture');
  fixture.close();
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  const owner = structuredClone(Object.values(ledger.reservations)[0].owner);
  owner.bootToken = 'unverifiable-boot:transient-owner-inspection';
  owner.processStartToken = 'unverifiable-start:transient-owner-inspection';
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  await fsp.writeFile(lockPath, `${JSON.stringify({
    version: 1,
    operationRoot: await fsp.realpath(operationRoot),
    maxBytes,
    owner,
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });

  await assert.rejects(() => createOperationScratchQuota({
    operationRoot,
    maxBytes,
    lockRetryMs: 1,
    lockTimeoutMs: 5,
  }), { code: 'source_busy', retryable: true });
  assert.equal(await exists(lockPath), true);
});

test('a custom liveness probe cannot reclaim fallback ownership for an existing PID', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 512 * 1024;
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  await fsp.writeFile(lockPath, `${JSON.stringify({
    version: 1,
    operationRoot: await fsp.realpath(operationRoot),
    maxBytes,
    owner: {
      pid: process.pid,
      processStartedAt: 1,
      handleId: '00000000-0000-0000-0000-000000000000',
      bootToken: 'unverifiable-boot:custom-probe',
      processStartToken: 'unverifiable-start:custom-probe',
    },
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });

  await assert.rejects(() => createOperationScratchQuota({
    operationRoot,
    maxBytes,
    lockRetryMs: 1,
    lockTimeoutMs: 5,
    isProcessAlive: async () => false,
  }), { code: 'source_busy', retryable: true });
  assert.equal(await exists(lockPath), true);
});

test('a cached false self-inspection cannot reclaim its own fallback reservation', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async () => {
  const operationRoot = await tempDir();
  const modulePath = path.resolve('shared/memory-source/scratch-quota.cjs');
  const childScript = String.raw`
    const fs = require('node:fs');
    const childProcess = require('node:child_process');
    const originalReadFile = fs.promises.readFile;
    const originalExecFile = childProcess.execFile;
    if (process.platform === 'linux') {
      fs.promises.readFile = async function (filePath, ...args) {
        if (String(filePath) === '/proc/' + process.pid + '/stat') {
          const error = new Error('transient proc lookup failure');
          error.code = 'ENOENT';
          throw error;
        }
        return originalReadFile.call(this, filePath, ...args);
      };
    } else if (process.platform === 'darwin') {
      childProcess.execFile = function (file, args, options, callback) {
        if (file === '/bin/ps') {
          const error = new Error('transient ps lookup failure');
          error.code = 1;
          queueMicrotask(() => callback(error, '', ''));
          return { once() {}, kill() {} };
        }
        return originalExecFile.call(this, file, args, options, callback);
      };
    }
    const { createOperationScratchQuota } = require(process.argv[1]);
    (async () => {
      const quota = await createOperationScratchQuota({
        operationRoot: process.argv[2],
        maxBytes: 512 * 1024,
      });
      fs.promises.readFile = originalReadFile;
      childProcess.execFile = originalExecFile;
      await quota.claim(4096, 'fallback-self');
      const ledger = JSON.parse(await originalReadFile(
        require('node:path').join(process.argv[2], '.scratch-quota.json'),
        'utf8',
      ));
      process.stdout.write(JSON.stringify({
        reservationCount: Object.keys(ledger.reservations).length,
        fallbackBytes: Object.values(ledger.reservations)[0]?.kinds?.['fallback-self'] || 0,
      }));
      quota.close();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = await runChild(childScript, [modulePath, operationRoot]);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { reservationCount: 1, fallbackBytes: 4096 });
});

test('independently absent fallback PID ownership is reclaimable', async () => {
  const operationRoot = await tempDir();
  const canonicalRoot = await fsp.realpath(operationRoot);
  const maxBytes = 256 * 1024;
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  await fsp.writeFile(lockPath, `${JSON.stringify({
    version: 1,
    operationRoot: canonicalRoot,
    maxBytes,
    owner: {
      pid: 2_147_483_647,
      processStartedAt: 1,
      handleId: '00000000-0000-0000-0000-000000000000',
      bootToken: 'unverifiable-boot:absent-owner',
      processStartToken: 'unverifiable-start:absent-owner',
    },
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });

  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  assert.equal(await exists(lockPath), false);
  quota.close();
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
    owner: {
      pid: 999999,
      processStartedAt: 1,
      handleId: '00000000-0000-0000-0000-000000000000',
      bootToken: 'test-boot',
      processStartToken: 'test-start',
    },
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

test('counts orphan bytes and new reservations additively before permitting retry growth', async () => {
  const operationRoot = await tempDir();
  const orphanPath = path.join(operationRoot, 'orphaned-projection.bin');
  const retryPath = path.join(operationRoot, 'retry-projection.bin');
  await fsp.writeFile(orphanPath, Buffer.alloc(100 * 1024));
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 130 * 1024,
  });

  let wroteRetry = false;
  await assert.rejects(async () => {
    await quota.claim(100 * 1024, 'projection-retry');
    wroteRetry = true;
    await fsp.writeFile(retryPath, Buffer.alloc(100 * 1024));
  }, { code: 'result_too_large', status: 413, retryable: false });
  assert.equal(wroteRetry, false);
  assert.equal(await exists(retryPath), false);

  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  const reservations = Object.values(ledger.reservations)
    .flatMap((entry) => Object.values(entry.kinds))
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(ledger.actualPrivateBytes >= 100 * 1024, true);
  assert.equal(ledger.actualPrivateBytes + reservations <= ledger.usedBytes, true);
  assert.equal(ledger.usedBytes <= ledger.maxBytes, true);
  quota.close();
});

test('blocked lock contention materializes at most one candidate within the hard quota', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 3000;
  let blockOwnerPublish = false;
  let markOwnerBlocked;
  let releaseOwnerPublish;
  const ownerBlocked = new Promise((resolve) => { markOwnerBlocked = resolve; });
  const ownerGate = new Promise((resolve) => { releaseOwnerPublish = resolve; });
  const owner = await createOperationScratchQuota({
    operationRoot,
    maxBytes,
    lockRetryMs: 1,
    _testHooks: {
      async beforeLedgerPublish() {
        if (!blockOwnerPublish) return;
        markOwnerBlocked();
        await ownerGate;
      },
    },
  });
  blockOwnerPublish = true;
  const heldTransaction = owner.reconcile();
  await ownerBlocked;

  const contenderAbort = new AbortController();
  let releaseContenders;
  const contenderGate = new Promise((resolve) => { releaseContenders = resolve; });
  const arrived = new Set();
  let markAllArrived;
  const allArrived = new Promise((resolve) => { markAllArrived = resolve; });
  function markArrived(index) {
    arrived.add(index);
    if (arrived.size === 10) markAllArrived();
  }
  const contenders = Array.from({ length: 10 }, (_, index) =>
    createOperationScratchQuota({
      operationRoot,
      maxBytes,
      signal: contenderAbort.signal,
      lockRetryMs: 1,
      _testHooks: {
        async afterLockCandidateSynced() {
          markArrived(index);
          await contenderGate;
        },
        async beforeLockRetry() {
          markArrived(index);
        },
      },
    }));

  try {
    await allArrived;
    const rootEntries = await fsp.readdir(operationRoot);
    const candidates = rootEntries.filter((name) =>
      name.startsWith('.scratch-quota.lock.candidate-'));
    assert.equal(candidates.length <= 1, true);
    assert.equal(await regularFileBytes(operationRoot) <= maxBytes, true);
  } finally {
    contenderAbort.abort(Object.assign(new Error('stop blocked contenders'), {
      name: 'AbortError',
    }));
    releaseContenders();
    await Promise.allSettled(contenders);
    releaseOwnerPublish();
    await heldTransaction;
    owner.close();
  }
});

test('recovers zero-byte and truncated unpublished serialized lock candidates', async () => {
  for (const [label, contents] of [
    ['zero-byte', ''],
    ['truncated', '{"version":1,"operationRoot":'],
  ]) {
    const operationRoot = await tempDir();
    const candidatePath = path.join(
      operationRoot,
      '.scratch-quota.lock.candidate-serialized',
    );
    await fsp.writeFile(candidatePath, contents, { mode: 0o600 });

    const quota = await createOperationScratchQuota({
      operationRoot,
      maxBytes: 256 * 1024,
      lockRetryMs: 1,
      lockTimeoutMs: 50,
    });
    assert.equal(await exists(candidatePath), false, label);
    assert.equal(await quota.claim(1024, `recovered-${label}`) <= quota.maxBytes, true);
    await quota.release(1024, `recovered-${label}`);
    quota.close();
  }
});

test('retries normal lock turnover under repeated high concurrency', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 8 * 1024 * 1024;
  for (let repetition = 0; repetition < 10; repetition += 1) {
    const handles = await Promise.all(Array.from({ length: 8 }, () =>
      createOperationScratchQuota({
        operationRoot,
        maxBytes,
        lockRetryMs: 1,
      })));
    await Promise.all(handles.map((quota, index) => quota.claim(256, `r${repetition}-${index}`)));
    await Promise.all(handles.map((quota, index) => quota.release(256, `r${repetition}-${index}`)));
    handles.forEach((quota) => quota.close());
  }
  const observer = await createOperationScratchQuota({ operationRoot, maxBytes });
  assert.equal(await observer.reconcile() <= maxBytes, true);
  observer.close();
});

test('sustained stale-lock turnover observes retry delay and timeout', async () => {
  const operationRoot = await tempDir();
  const canonicalRoot = await fsp.realpath(operationRoot);
  const maxBytes = 512 * 1024;
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  const staleLock = `${JSON.stringify({
    version: 1,
    operationRoot: canonicalRoot,
    maxBytes,
    owner: {
      pid: 999999,
      processStartedAt: 1,
      handleId: '00000000-0000-0000-0000-000000000000',
      bootToken: 'test-boot',
      processStartToken: 'test-start',
    },
    acquiredAt: 1,
  })}\n`;
  await fsp.writeFile(lockPath, staleLock, { mode: 0o600 });
  const controller = new AbortController();
  let fakeNow = 0;
  let turnoverAttempts = 0;
  let retryCalls = 0;
  const startedAt = Date.now();

  await assert.rejects(() => createOperationScratchQuota({
    operationRoot,
    maxBytes,
    signal: controller.signal,
    lockRetryMs: 15,
    lockTimeoutMs: 10,
    clock: { now: () => fakeNow },
    isProcessAlive: async () => false,
    _testHooks: {
      async afterLockCandidateSynced() {
        turnoverAttempts += 1;
        fakeNow += 4;
        if (!await exists(lockPath)) await fsp.writeFile(lockPath, staleLock, { mode: 0o600 });
        if (turnoverAttempts >= 8) {
          controller.abort(Object.assign(new Error('turnover guard'), { name: 'AbortError' }));
        }
      },
      async beforeLockRetry({ delayMs }) {
        assert.equal(delayMs, 15);
        retryCalls += 1;
      },
    },
  }), { code: 'source_busy', retryable: true });

  assert.equal(turnoverAttempts, 3);
  assert.equal(retryCalls, 2);
  assert.equal(Date.now() - startedAt >= 10, true);
});

test('validates the complete lock owner before liveness and never reclaims malformed ownership', async () => {
  const operationRoot = await tempDir();
  const canonicalRoot = await fsp.realpath(operationRoot);
  const maxBytes = 256 * 1024;
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  await fsp.writeFile(lockPath, `${JSON.stringify({
    version: 1,
    operationRoot: canonicalRoot,
    maxBytes,
    owner: {
      pid: process.pid,
      processStartedAt: Date.now(),
      handleId: '00000000-0000-0000-0000-000000000000',
      // Intentionally missing bootToken and processStartToken.
    },
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });
  let livenessCalls = 0;
  await assert.rejects(() => createOperationScratchQuota({
    operationRoot,
    maxBytes,
    isProcessAlive: async () => {
      livenessCalls += 1;
      return false;
    },
  }), { code: 'invalid_memory_source', retryable: false });
  assert.equal(livenessCalls, 0);
  assert.equal(await exists(lockPath), true);
});

test('reclaims stale ownership when a live reused PID has a different process token', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 512 * 1024;
  const ownerQuota = await createOperationScratchQuota({ operationRoot, maxBytes });
  await ownerQuota.claim(1, 'identity-fixture');
  ownerQuota.close();
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  const owner = structuredClone(Object.values(ledger.reservations)[0].owner);
  owner.processStartToken = `${owner.processStartToken}-reused`;
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  await fsp.writeFile(lockPath, `${JSON.stringify({
    version: 1,
    operationRoot: await fsp.realpath(operationRoot),
    maxBytes,
    owner,
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });

  const contender = await createOperationScratchQuota({
    operationRoot,
    maxBytes,
    lockRetryMs: 1,
    lockTimeoutMs: 10,
  });
  assert.equal(await exists(lockPath), false);
  contender.close();
});

test('retains a valid lock when owner liveness cannot be proven', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 512 * 1024;
  const fixture = await createOperationScratchQuota({ operationRoot, maxBytes });
  await fixture.claim(1, 'identity-fixture');
  fixture.close();
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  const owner = structuredClone(Object.values(ledger.reservations)[0].owner);
  const lockPath = path.join(operationRoot, '.scratch-quota.lock');
  await fsp.writeFile(lockPath, `${JSON.stringify({
    version: 1,
    operationRoot: await fsp.realpath(operationRoot),
    maxBytes,
    owner,
    acquiredAt: 1,
  })}\n`, { mode: 0o600 });

  await assert.rejects(() => createOperationScratchQuota({
    operationRoot,
    maxBytes,
    lockRetryMs: 1,
    lockTimeoutMs: 5,
    isProcessAlive: async () => {
      throw new Error('identity inspection unavailable');
    },
  }), { code: 'source_busy', retryable: true });
  assert.equal(await exists(lockPath), true);
});

test('metadata publishing and scans fail closed across deterministic operation-root replacement', async () => {
  const operationRoot = await tempDir();
  const maxBytes = 512 * 1024;
  const movedRoot = `${operationRoot}-original`;
  let swapOnLedgerPublish = false;
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes,
    _testHooks: {
      async beforeLedgerPublish() {
        if (!swapOnLedgerPublish) return;
        swapOnLedgerPublish = false;
        await fsp.rename(operationRoot, movedRoot);
        await fsp.mkdir(operationRoot, { mode: 0o700 });
        await fsp.writeFile(path.join(operationRoot, 'replacement-sentinel'), 'keep');
      },
    },
  });

  swapOnLedgerPublish = true;
  await assert.rejects(() => quota.claim(1, 'swap'), { code: 'invalid_memory_source' });
  assert.equal(await fsp.readFile(path.join(operationRoot, 'replacement-sentinel'), 'utf8'), 'keep');
  assert.deepEqual(await fsp.readdir(operationRoot), ['replacement-sentinel']);

  await fsp.rm(operationRoot, { recursive: true });
  await fsp.rename(movedRoot, operationRoot);
  quota.close();

  const scanRoot = await tempDir();
  const scanMoved = `${scanRoot}-original`;
  let swapDuringScan = false;
  let canonicalScanRoot = null;
  const scanQuota = await createOperationScratchQuota({
    operationRoot: scanRoot,
    maxBytes,
    _testHooks: {
      async afterScanDirectoryRead(directory) {
        if (!swapDuringScan || directory !== canonicalScanRoot) return;
        swapDuringScan = false;
        await fsp.rename(scanRoot, scanMoved);
        await fsp.mkdir(scanRoot, { mode: 0o700 });
        await fsp.writeFile(path.join(scanRoot, 'replacement-sentinel'), 'keep');
      },
    },
  });
  canonicalScanRoot = scanQuota.operationRoot;
  swapDuringScan = true;
  await assert.rejects(() => scanQuota.reconcile(), { code: 'invalid_memory_source' });
  assert.equal(await fsp.readFile(path.join(scanRoot, 'replacement-sentinel'), 'utf8'), 'keep');
  await fsp.rm(scanRoot, { recursive: true });
  await fsp.rename(scanMoved, scanRoot);
  scanQuota.close();
});

test('reconcile retries a disappearing attempt entry and counts its atomic replacement', async () => {
  const operationRoot = await tempDir();
  const attemptRoot = path.join(operationRoot, '.attempt-race');
  const temporary = path.join(attemptRoot, 'memory-manifest.json.tmp');
  const published = path.join(attemptRoot, 'memory-manifest.json');
  const contents = 'durable projection manifest\n';
  await fsp.mkdir(attemptRoot, { mode: 0o700 });
  await fsp.writeFile(temporary, contents, { mode: 0o600 });
  const canonicalAttemptRoot = await fsp.realpath(attemptRoot);

  let publishDuringScan = false;
  let scans = 0;
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 512 * 1024,
    _testHooks: {
      async afterScanDirectoryRead(directory) {
        if (!publishDuringScan || directory !== canonicalAttemptRoot) return;
        publishDuringScan = false;
        scans += 1;
        await fsp.rename(temporary, published);
      },
    },
  });

  publishDuringScan = true;
  assert.equal(await quota.reconcile() <= quota.maxBytes, true);
  assert.equal(scans, 1);
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  assert.equal(ledger.actualPrivateBytes, Buffer.byteLength(contents));
  quota.close();
  await fsp.rm(operationRoot, { recursive: true, force: true });
});

test('withPhysicalGrowth serializes bounded growth across concurrent quota handles', async () => {
  const operationRoot = await tempDir();
  const dataRoot = path.join(operationRoot, 'projection');
  await fsp.mkdir(dataRoot, { mode: 0o700 });
  const maxBytes = 320 * 1024;
  const first = await createOperationScratchQuota({
    operationRoot, maxBytes, lockRetryMs: 1,
  });
  const second = await createOperationScratchQuota({
    operationRoot, maxBytes, lockRetryMs: 1,
  });
  let releaseFirst;
  let firstEntered;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  let secondEntered = false;

  const firstWrite = first.withPhysicalGrowth(96 * 1024, 'first-growth', async ({ checkpoint }) => {
    await fsp.writeFile(path.join(dataRoot, 'first.bin'), Buffer.alloc(96 * 1024));
    await checkpoint();
    firstEntered();
    await firstBlocked;
  });
  await entered;
  const secondWrite = second.withPhysicalGrowth(96 * 1024, 'second-growth', async ({ checkpoint }) => {
    secondEntered = true;
    await fsp.writeFile(path.join(dataRoot, 'second.bin'), Buffer.alloc(96 * 1024));
    await checkpoint();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([firstWrite, secondWrite]);

  assert.equal(secondEntered, true);
  assert.equal(await first.reconcile() <= maxBytes, true);
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, '.scratch-quota.json'), 'utf8'));
  assert.equal(ledger.actualPrivateBytes >= 192 * 1024, true);
  assert.deepEqual(ledger.reservations, {});
  first.close();
  second.close();
});

test('withPhysicalGrowth rejects aggregate growth before invoking the filesystem callback', async () => {
  const operationRoot = await tempDir();
  await fsp.writeFile(path.join(operationRoot, 'existing.bin'), Buffer.alloc(100 * 1024));
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 160 * 1024,
  });
  let invoked = false;

  await assert.rejects(
    () => quota.withPhysicalGrowth(100 * 1024, 'rejected-growth', async () => { invoked = true; }),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.equal(invoked, false);
  assert.equal((await fsp.stat(path.join(operationRoot, 'existing.bin'))).size, 100 * 1024);
  quota.close();
});

test('withPhysicalGrowth checkpoint rejects growth beyond its exact authorization', async () => {
  const operationRoot = await tempDir();
  const outputPath = path.join(operationRoot, 'oversized.bin');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 256 * 1024,
  });

  await assert.rejects(
    () => quota.withPhysicalGrowth(1024, 'bounded-growth', async ({ checkpoint }) => {
      await fsp.writeFile(outputPath, Buffer.alloc(1025));
      await checkpoint();
    }),
    { code: 'result_too_large', status: 413, retryable: false },
  );
  assert.equal((await fsp.stat(outputPath)).size, 1025);
  await fsp.unlink(outputPath);
  await quota.reconcile();
  quota.close();
});
