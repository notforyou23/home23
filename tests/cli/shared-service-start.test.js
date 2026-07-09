import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SHARED_SERVICES,
  coordinateSharedServiceStartup,
} from '../../cli/lib/shared-service-start.js';

function onlineRow(name, pid) {
  return { name, pid, pm2_env: { status: 'online' } };
}

function stoppedRow(name) {
  return { name, pid: 0, pm2_env: { status: 'stopped' } };
}

async function makeTempPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'home23-shared-start-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    lockPath: join(dir, 'shared-service-start.lock'),
    receiptPath: join(dir, 'shared-service-startup.jsonl'),
  };
}

async function assertAbsent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

test('concurrent callers start each missing shared service exactly once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'home23-shared-start-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'shared-service-start.lock');
  const receiptPath = join(dir, 'shared-service-startup.jsonl');
  const online = new Map();
  const starts = new Map();
  let nextPid = 4000;

  const dependencies = {
    listProcesses: async () => Array.from(online, ([name, pid]) => onlineRow(name, pid)),
    startService: async ({ name }) => {
      starts.set(name, (starts.get(name) || 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      online.set(name, nextPid++);
    },
    appendReceipt: async (receipt) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    },
  };

  const options = {
    home23Root: '/tmp/home23',
    lockPath,
    receiptPath,
    pollMs: 5,
    lockTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    dependencies,
  };

  const results = await Promise.all([
    coordinateSharedServiceStartup(options),
    coordinateSharedServiceStartup(options),
  ]);

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(
    Object.fromEntries(starts),
    Object.fromEntries(SHARED_SERVICES.map(({ name }) => [name, 1])),
  );
  assert.equal(
    results.filter((result) => result.services.every((service) => service.action === 'started')).length,
    1,
  );
  assert.equal(
    results.filter((result) => result.services.every((service) => service.action === 'already-online')).length,
    1,
  );
  const receipts = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 2);
  assert.equal(receipts.every((receipt) => receipt.schema === 'home23.shared-service-start.receipt.v1'), true);
  assert.equal(receipts.every((receipt) => Number(receipt.caller.pid) > 0), true);
});

test('stale dead-owner lock is recovered and recorded', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  await writeFile(lockPath, `${JSON.stringify({ token: 'dead-owner', pid: 999999 })}\n`);

  const result = await coordinateSharedServiceStartup({
    home23Root: '/tmp/home23',
    lockPath,
    receiptPath,
    dependencies: {
      pidAlive: () => false,
      listProcesses: async () => SHARED_SERVICES.map(({ name }, index) => onlineRow(name, 5000 + index)),
      appendReceipt: async () => {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.lock.staleLocksRecovered, 1);
  await assertAbsent(lockPath);
});

test('live lock owner is not displaced before timeout', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  await writeFile(lockPath, `${JSON.stringify({ token: 'live-owner', pid: 1234 })}\n`);
  let now = 0;

  await assert.rejects(
    coordinateSharedServiceStartup({
      home23Root: '/tmp/home23',
      lockPath,
      receiptPath,
      lockTimeoutMs: 20,
      pollMs: 5,
      dependencies: {
        pidAlive: () => true,
        now: () => now,
        wait: async () => { now += 5; },
        appendReceipt: async () => {},
      },
    }),
    /Timed out waiting/,
  );

  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'live-owner');
});

test('stale cleanup preserves a replacement lock with a different token', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  await writeFile(lockPath, `${JSON.stringify({ token: 'dead-owner', pid: 999999 })}\n`);
  let now = 0;
  let pidChecks = 0;

  await assert.rejects(
    coordinateSharedServiceStartup({
      home23Root: '/tmp/home23',
      lockPath,
      receiptPath,
      lockTimeoutMs: 10,
      pollMs: 5,
      dependencies: {
        pidAlive: () => {
          pidChecks += 1;
          if (pidChecks === 1) {
            writeFileSync(lockPath, `${JSON.stringify({ token: 'replacement-owner', pid: 1234 })}\n`);
            return false;
          }
          return true;
        },
        now: () => now,
        wait: async () => { now += 5; },
        appendReceipt: async () => {},
      },
    }),
    /Timed out waiting/,
  );

  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'replacement-owner');
});

test('duplicate PM2 records fail closed without calling startService', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  let starts = 0;

  await assert.rejects(
    coordinateSharedServiceStartup({
      home23Root: '/tmp/home23',
      lockPath,
      receiptPath,
      dependencies: {
        listProcesses: async () => [
          onlineRow('home23-evobrew', 6001),
          onlineRow('home23-evobrew', 6002),
        ],
        startService: async () => { starts += 1; },
        appendReceipt: async () => {},
      },
    }),
    /Duplicate PM2 records/,
  );

  assert.equal(starts, 0);
  await assertAbsent(lockPath);
});

test('start failure releases the lock and writes a failed receipt', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  let capturedReceipt;

  await assert.rejects(
    coordinateSharedServiceStartup({
      home23Root: '/tmp/home23',
      lockPath,
      receiptPath,
      services: [SHARED_SERVICES[0]],
      dependencies: {
        listProcesses: async () => [],
        startService: async () => { throw new Error('synthetic start failure'); },
        appendReceipt: async (receipt) => { capturedReceipt = receipt; },
      },
    }),
    /synthetic start failure/,
  );

  await assertAbsent(lockPath);
  assert.equal(capturedReceipt.ok, false);
  assert.equal(capturedReceipt.services[0].action, 'failed');
  assert.match(capturedReceipt.services[0].error, /synthetic start failure/);
});

test('startup timeout releases the lock', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  let now = 0;
  let capturedReceipt;

  await assert.rejects(
    coordinateSharedServiceStartup({
      home23Root: '/tmp/home23',
      lockPath,
      receiptPath,
      services: [SHARED_SERVICES[0]],
      startupTimeoutMs: 20,
      pollMs: 5,
      dependencies: {
        now: () => now,
        wait: async () => { now += 5; },
        listProcesses: async () => [stoppedRow('home23-evobrew')],
        startService: async () => {},
        appendReceipt: async (receipt) => { capturedReceipt = receipt; },
      },
    }),
    /Timed out waiting for home23-evobrew/,
  );

  await assertAbsent(lockPath);
  assert.equal(capturedReceipt.services[0].action, 'failed');
  assert.match(capturedReceipt.services[0].error, /Timed out waiting for home23-evobrew/);
});

test('receipt failure warns without hiding successful startup', async (t) => {
  const { lockPath, receiptPath } = await makeTempPaths(t);
  const warnings = [];

  const result = await coordinateSharedServiceStartup({
    home23Root: '/tmp/home23',
    lockPath,
    receiptPath,
    dependencies: {
      listProcesses: async () => SHARED_SERVICES.map(({ name }, index) => onlineRow(name, 7000 + index)),
      appendReceipt: async () => { throw new Error('synthetic receipt failure'); },
      warn: (message) => warnings.push(message),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /receipt write failed: synthetic receipt failure/);
});
