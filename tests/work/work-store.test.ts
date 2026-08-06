import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import type { AsyncWorkRecord } from '../../src/work/types.ts';

function makeRecord(overrides: Partial<AsyncWorkRecord> = {}): AsyncWorkRecord {
  return {
    schema: 'home23.async-work.v1',
    workId: 'aw_t1_ab12',
    kind: 'coding',
    agent: 'jerry',
    originChatId: 'ios_abc_jerry_x_ff',
    label: 'fix the thing',
    status: 'running',
    startedAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:00:00.000Z',
    resultHandle: { type: 'coding_job', jobId: 'cj_x_1111' },
    verification: 'none',
    ...overrides,
  };
}

test('write/read/list round-trip, newest first, corrupt skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'work-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkStore(dir);

  store.write(makeRecord({ workId: 'aw_t1_aaaa', startedAt: '2026-08-06T10:00:00.000Z' }));
  store.write(makeRecord({ workId: 'aw_t2_bbbb', startedAt: '2026-08-06T11:00:00.000Z' }));
  writeFileSync(join(dir, 'aw_bad_cccc.json'), '{nope');

  assert.equal(store.read('aw_t1_aaaa')?.workId, 'aw_t1_aaaa');
  assert.equal(store.read('aw_missing_dddd'), undefined);

  const listed = store.list();
  assert.deepEqual(listed.map(r => r.workId), ['aw_t2_bbbb', 'aw_t1_aaaa']);
});

test('update patches and bumps updatedAt', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'work-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkStore(dir);
  store.write(makeRecord());
  const updated = store.update('aw_t1_ab12', { status: 'completed', finishedAt: '2026-08-06T12:05:00.000Z' });
  assert.equal(updated?.status, 'completed');
  assert.notEqual(updated?.updatedAt, '2026-08-06T12:00:00.000Z');
  assert.equal(store.read('aw_t1_ab12')?.status, 'completed');
  assert.equal(store.update('aw_missing_x', { status: 'failed' }), undefined);
});
