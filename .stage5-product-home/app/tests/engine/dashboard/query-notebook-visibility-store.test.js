import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createQueryNotebookVisibilityStore,
} = require('../../../engine/src/dashboard/query-notebook-visibility-store.js');

const FIRST_OPERATION_ID = `brop_${'A'.repeat(32)}`;
const SECOND_OPERATION_ID = `brop_${'B'.repeat(32)}`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-visibility-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filePath: path.join(root, 'query-notebook-visibility.json') };
}

test('visibility tombstones persist idempotently and prune missing operations', async (t) => {
  const { filePath } = fixture(t);
  let now = Date.parse('2026-07-14T20:00:00.000Z');
  const store = createQueryNotebookVisibilityStore({
    filePath, requesterAgent: 'jerry', now: () => now,
  });

  assert.equal(await store.isHidden(FIRST_OPERATION_ID), false);
  assert.deepEqual(await store.hiddenOperationIds(), []);
  await store.hide(FIRST_OPERATION_ID);
  now += 60_000;
  await store.hide(FIRST_OPERATION_ID);
  assert.equal(await store.isHidden(FIRST_OPERATION_ID), true);
  assert.deepEqual(await store.hiddenOperationIds(), [FIRST_OPERATION_ID]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
    schemaVersion: 1,
    requesterAgent: 'jerry',
    hidden: { [FIRST_OPERATION_ID]: '2026-07-14T20:00:00.000Z' },
  });

  const reloaded = createQueryNotebookVisibilityStore({
    filePath, requesterAgent: 'jerry', now: () => now,
  });
  assert.equal(await reloaded.isHidden(FIRST_OPERATION_ID), true);
  assert.equal(await reloaded.prune([FIRST_OPERATION_ID, SECOND_OPERATION_ID]), 0);
  assert.equal(await reloaded.prune([SECOND_OPERATION_ID]), 1);
  assert.equal(await reloaded.isHidden(FIRST_OPERATION_ID), false);
});

test('concurrent hides serialize without losing either exact operation ID', async (t) => {
  const { filePath } = fixture(t);
  const store = createQueryNotebookVisibilityStore({
    filePath,
    requesterAgent: 'jerry',
    now: () => Date.parse('2026-07-14T20:00:00.000Z'),
  });
  await Promise.all([store.hide(FIRST_OPERATION_ID), store.hide(SECOND_OPERATION_ID)]);
  assert.deepEqual(await store.hiddenOperationIds(), [FIRST_OPERATION_ID, SECOND_OPERATION_ID]);
});

test('corrupt visibility authority fails closed and is never overwritten', async (t) => {
  const { filePath } = fixture(t);
  const corrupt = Buffer.from('{"schemaVersion":1,"requesterAgent":"mallory","hidden":{}}\n');
  fs.writeFileSync(filePath, corrupt, { mode: 0o600 });
  const store = createQueryNotebookVisibilityStore({
    filePath,
    requesterAgent: 'jerry',
    now: () => Date.parse('2026-07-14T20:00:00.000Z'),
  });
  await assert.rejects(() => store.hide(FIRST_OPERATION_ID), {
    code: 'visibility_store_corrupt',
  });
  assert.deepEqual(fs.readFileSync(filePath), corrupt);
});

test('visibility capacity and caller inputs remain bounded', async (t) => {
  const { filePath } = fixture(t);
  const store = createQueryNotebookVisibilityStore({
    filePath,
    requesterAgent: 'jerry',
    maxEntries: 1,
    now: () => Date.parse('2026-07-14T20:00:00.000Z'),
  });
  await store.hide(FIRST_OPERATION_ID);
  await assert.rejects(() => store.hide(SECOND_OPERATION_ID), {
    code: 'visibility_capacity_exceeded',
  });
  await assert.rejects(() => store.hide('not-an-operation'), {
    code: 'visibility_invalid',
  });
  await assert.rejects(() => store.prune([FIRST_OPERATION_ID, FIRST_OPERATION_ID]), {
    code: 'visibility_invalid',
  });
});
