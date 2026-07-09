import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SHARED_SERVICES,
  coordinateSharedServiceStartup,
} from '../../cli/lib/shared-service-start.js';

function onlineRow(name, pid) {
  return { name, pid, pm2_env: { status: 'online' } };
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
});
