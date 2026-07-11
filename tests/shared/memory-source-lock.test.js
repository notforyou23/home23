import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pinsPath = require.resolve('../../shared/memory-source/pins.cjs');
const { withMemorySourceLock } = require(pinsPath);

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-source-lock-'));
  const brainDir = path.join(root, 'brain');
  const lockRoot = path.join(root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(brainDir, { recursive: true });
  await fsp.mkdir(lockRoot, { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const canonicalRoot = await fsp.realpath(brainDir);
  const lockName = createHash('sha256').update(canonicalRoot).digest('hex');
  return {
    brainDir,
    canonicalRoot,
    lockRoot,
    lockDir: path.join(lockRoot, lockName),
  };
}

function ownerRecord(canonicalRoot, overrides = {}) {
  return {
    version: 1,
    canonicalRoot,
    pid: 999_991,
    processStartedAt: 1,
    bootToken: 'test-boot-token',
    processStartToken: 'test-process-start-token',
    createdAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

async function publishFixtureLock(lockDir, owner) {
  await fsp.mkdir(lockDir);
  await fsp.writeFile(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify(owner)}\n`,
    { mode: 0o600 },
  );
}

test('published source lock has a complete exact process and boot identity', async (t) => {
  const fx = await fixture(t);
  let unblock;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });

  const held = withMemorySourceLock(fx.brainDir, { lockRoot: fx.lockRoot }, async () => {
    const owner = JSON.parse(await fsp.readFile(path.join(fx.lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.version, 1);
    assert.equal(owner.canonicalRoot, fx.canonicalRoot);
    assert.equal(owner.pid, process.pid);
    assert.equal(Number.isSafeInteger(owner.processStartedAt), true);
    assert.equal(typeof owner.bootToken, 'string');
    assert.notEqual(owner.bootToken.length, 0);
    assert.equal(typeof owner.processStartToken, 'string');
    assert.notEqual(owner.processStartToken.length, 0);
    assert.equal(Number.isNaN(Date.parse(owner.createdAt)), false);
    entered();
    await blocked;
  });

  await enteredPromise;
  const retryDelays = [];
  await assert.rejects(
    () => withMemorySourceLock(fx.brainDir, {
      lockRoot: fx.lockRoot,
      lockRetryMs: 1,
      lockJitterMs: 2,
      lockTimeoutMs: 8,
      random: () => 0.75,
      isProcessAlive: async () => true,
      _testHooks: {
        beforeLockRetry({ delayMs }) { retryDelays.push(delayMs); },
      },
    }, async () => assert.fail('live owner lock must not be acquired')),
    { code: 'source_busy', retryable: true },
  );
  assert.equal(retryDelays.length > 0, true);
  assert.equal(retryDelays.every((delay) => delay >= 1 && delay <= 3), true);

  unblock();
  await held;
  assert.deepEqual(await fsp.readdir(fx.lockRoot), []);
});

for (const crashHook of [
  'afterOwnerFsync',
  'beforeOwnerRename',
  'beforeFinalDirectoryRename',
]) {
  test(`crash at ${crashHook} never publishes an ownerless final source lock`, async (t) => {
    const fx = await fixture(t);
    const child = spawnSync(process.execPath, ['-e', `
      const { withMemorySourceLock } = require(${JSON.stringify(pinsPath)});
      withMemorySourceLock(
        ${JSON.stringify(fx.brainDir)},
        {
          lockRoot: ${JSON.stringify(fx.lockRoot)},
          _testHooks: { ${crashHook}: () => process.exit(73) },
        },
        async () => {},
      ).then(() => process.exit(0), () => process.exit(74));
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 73, child.stderr || child.stdout);
    assert.equal(
      await fsp.access(fx.lockDir).then(() => true).catch(() => false),
      false,
      'a pre-publication crash may strand only a non-authoritative candidate',
    );
    await withMemorySourceLock(fx.brainDir, { lockRoot: fx.lockRoot }, async () => {});
  });
}

test('a published lock is recovered only after its exact owner is proven dead', async (t) => {
  const fx = await fixture(t);
  const staleOwner = ownerRecord(fx.canonicalRoot);
  await publishFixtureLock(fx.lockDir, staleOwner);
  const inspected = [];

  const value = await withMemorySourceLock(fx.brainDir, {
    lockRoot: fx.lockRoot,
    lockRetryMs: 1,
    lockTimeoutMs: 20,
    isProcessAlive: async (owner) => {
      inspected.push(owner);
      return false;
    },
  }, async () => 42);

  assert.equal(value, 42);
  assert.deepEqual(inspected, [staleOwner]);
  assert.deepEqual(await fsp.readdir(fx.lockRoot), []);
});

test('stale recovery never deletes a replacement lock with a different inode', async (t) => {
  const fx = await fixture(t);
  const staleOwner = ownerRecord(fx.canonicalRoot, { pid: 999_992 });
  const replacementOwner = ownerRecord(fx.canonicalRoot, {
    pid: 999_993,
    processStartToken: 'replacement-process-start-token',
  });
  await publishFixtureLock(fx.lockDir, staleOwner);
  let replaced = false;

  await assert.rejects(
    () => withMemorySourceLock(fx.brainDir, {
      lockRoot: fx.lockRoot,
      lockRetryMs: 1,
      lockJitterMs: 0,
      lockTimeoutMs: 8,
      isProcessAlive: async (owner) => {
        if (owner.pid === staleOwner.pid && !replaced) {
          replaced = true;
          await fsp.rm(fx.lockDir, { recursive: true });
          await publishFixtureLock(fx.lockDir, replacementOwner);
          return false;
        }
        return true;
      },
    }, async () => assert.fail('replacement live owner must retain the lock')),
    { code: 'source_busy', retryable: true },
  );
  assert.equal(replaced, true);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(fx.lockDir, 'owner.json'), 'utf8')),
    replacementOwner,
  );
});

for (const malformedOwner of [null, '{not-json}\n']) {
  test(`a ${malformedOwner === null ? 'missing' : 'corrupt'} final owner fails closed`, async (t) => {
    const fx = await fixture(t);
    await fsp.mkdir(fx.lockDir);
    if (malformedOwner !== null) {
      await fsp.writeFile(path.join(fx.lockDir, 'owner.json'), malformedOwner);
    }
    let livenessChecks = 0;
    await assert.rejects(
      () => withMemorySourceLock(fx.brainDir, {
        lockRoot: fx.lockRoot,
        lockRetryMs: 1,
        lockJitterMs: 0,
        lockTimeoutMs: 4,
        isProcessAlive: async () => { livenessChecks += 1; return false; },
      }, async () => assert.fail('malformed published lock must not be reclaimed')),
      { code: 'source_busy', retryable: true },
    );
    assert.equal(livenessChecks, 0);
    assert.equal(await fsp.access(fx.lockDir).then(() => true).catch(() => false), true);
  });
}
