import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';

function makeRegistry(t: { after(fn: () => void): void }): WorkRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'work-reg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
}

test('create resolves root origin and returns a running record', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({
    kind: 'coding',
    originChatId: 'subagent:ios_abc_jerry_x_ff:ab12',
    label: 'fix flaky test',
    resultHandle: { type: 'coding_job', jobId: 'cj_a_1111' },
    originTurnId: 't_x_y',
    parentWorkId: 'aw_parent_0000',
  });
  assert.match(rec.workId, /^aw_/);
  assert.equal(rec.originChatId, 'ios_abc_jerry_x_ff'); // root, not the subagent chat
  assert.equal(rec.status, 'running');
  assert.equal(rec.verification, 'none');
  assert.equal(reg.get(rec.workId)?.label, 'fix flaky test');
});

test('findByJobId and list filters', (t) => {
  const reg = makeRegistry(t);
  const a = reg.create({ kind: 'coding', originChatId: '123', label: 'a', resultHandle: { type: 'coding_job', jobId: 'cj_a_1' } });
  reg.create({ kind: 'subagent', originChatId: 'ios_x_jerry_y_z', label: 'b', resultHandle: { type: 'subagent_chat', chatId: 'subagent:ios_x_jerry_y_z:aaaa' } });
  reg.complete(a.workId, 'completed');

  assert.equal(reg.findByJobId('cj_a_1')?.workId, a.workId);
  assert.equal(reg.findByJobId('cj_nope'), undefined);
  assert.equal(reg.list({ active: true }).length, 1);
  assert.equal(reg.list({ originChatId: '123' }).length, 1);
  assert.equal(reg.list().length, 2);
});

test('complete is terminal-once and maps cancel intent', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({ kind: 'subagent', originChatId: '123', label: 'x', resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' } });

  reg.requestCancel(rec.workId);
  const done = reg.complete(rec.workId, 'failed', 'operator_stop');
  assert.equal(done.status, 'cancelled'); // failed + cancel intent => cancelled
  assert.ok(done.finishedAt);

  const again = reg.complete(rec.workId, 'completed');
  assert.equal(again.status, 'cancelled'); // terminal-once: second transition ignored
});

test('noteProgress throttles writes', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({ kind: 'coding', originChatId: '123', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_p_1' } });
  reg.noteProgress(rec.workId, '3 events · tool_use Bash');
  const first = reg.get(rec.workId)!.progressSummary;
  assert.equal(first, '3 events · tool_use Bash');
  reg.noteProgress(rec.workId, '4 events · tool_use Read'); // within throttle window
  assert.equal(reg.get(rec.workId)!.progressSummary, first);
});

test('reconcileOnBoot: subagent work interrupted, undelivered terminal coding work surfaced, orphan jobs backfilled', (t) => {
  const reg = makeRegistry(t);
  const sub = reg.create({ kind: 'subagent', originChatId: '123', label: 'lost sub', resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' } });
  const cod = reg.create({ kind: 'coding', originChatId: '123', label: 'done while down', resultHandle: { type: 'coding_job', jobId: 'cj_d_1' } });

  const result = reg.reconcileOnBoot({
    jobs: [
      { id: 'cj_d_1', status: 'completed', requestedBy: '123', label: 'done while down', startedAt: '2026-08-06T10:00:00.000Z' },
      { id: 'cj_run_2', status: 'running', requestedBy: 'subagent:ios_a_jerry_b_c:ab12', label: 'orphan running', startedAt: '2026-08-06T10:01:00.000Z' },
    ],
  });

  assert.equal(reg.get(sub.workId)!.status, 'interrupted');
  assert.equal(reg.get(cod.workId)!.status, 'completed');
  // both need delivery: the interrupted subagent and the finished-while-down coding work
  assert.deepEqual(result.needsDelivery.map(w => w.workId).sort(), [cod.workId, sub.workId].sort());
  // the orphan running job got a backfilled record with root origin
  const backfilled = reg.findByJobId('cj_run_2');
  assert.ok(backfilled);
  assert.equal(backfilled!.originChatId, 'ios_a_jerry_b_c');
  assert.equal(backfilled!.status, 'running');
});

test('reconcileOnBoot: coding work whose job vanished is interrupted', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({ kind: 'coding', originChatId: '123', label: 'gone', resultHandle: { type: 'coding_job', jobId: 'cj_gone_1' } });
  const result = reg.reconcileOnBoot({ jobs: [] });
  assert.equal(reg.get(rec.workId)!.status, 'interrupted');
  assert.equal(result.interrupted.length, 1);
});
