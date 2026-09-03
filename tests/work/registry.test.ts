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

test('inline terminal states atomically count as delivered and never enter boot delivery', (t) => {
  const reg = makeRegistry(t);
  const success = reg.create({
    kind: 'subagent', originChatId: '123', deliveryMode: 'inline', label: 'success',
    resultHandle: { type: 'subagent_chat', chatId: `subagent:123:${'a'.repeat(32)}` },
  });
  const failure = reg.create({
    kind: 'subagent', originChatId: '123', deliveryMode: 'inline', label: 'failure',
    resultHandle: { type: 'subagent_chat', chatId: `subagent:123:${'b'.repeat(32)}` },
  });
  const cancel = reg.create({
    kind: 'subagent', originChatId: '123', deliveryMode: 'inline', label: 'cancel',
    resultHandle: { type: 'subagent_chat', chatId: `subagent:123:${'c'.repeat(32)}` },
  });

  const succeeded = reg.completeInline(success.workId, 'completed');
  const failed = reg.completeInline(failure.workId, 'failed', 'boom');
  reg.requestCancel(cancel.workId);
  const cancelled = reg.completeInline(cancel.workId, 'failed', 'operator_stop');

  for (const record of [succeeded, failed, cancelled]) {
    assert.ok(record.finishedAt);
    assert.equal(record.deliveredAt, record.finishedAt);
  }
  assert.deepEqual([succeeded.status, failed.status, cancelled.status], ['completed', 'failed', 'cancelled']);
  const recovered = reg.reconcileOnBoot({ jobs: [] });
  assert.deepEqual(recovered.needsDelivery, []);
});

test('boot interruption of an inline hand is terminal and never detached-delivered', (t) => {
  const reg = makeRegistry(t);
  const running = reg.create({
    kind: 'subagent', originChatId: 'ios_parent', deliveryMode: 'inline', label: 'lost inline hand',
    resultHandle: { type: 'subagent_chat', chatId: `subagent:ios_parent:${'d'.repeat(32)}` },
  });

  const recovered = reg.reconcileOnBoot({ jobs: [] });
  const interrupted = reg.get(running.workId)!;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.deliveredAt, interrupted.finishedAt);
  assert.deepEqual(recovered.needsDelivery, []);
});

test('appendEvidence stays on the Work record and is bounded', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({
    kind: 'subagent', originChatId: 'coordination:chn_1:wrk_1', office: 'resident',
    label: 'branch', resultHandle: { type: 'subagent_chat', chatId: 'coordination:chn_1:wrk_1' },
  });
  assert.equal(rec.office, 'resident');
  reg.appendEvidence(rec.workId, '  question: which file?  ');
  const noted = reg.get(rec.workId)!;
  assert.deepEqual(noted.evidenceNotes, ['question: which file?']);
  assert.equal(noted.progressSummary, 'question: which file?');
  for (let i = 0; i < 40; i++) reg.appendEvidence(rec.workId, `note ${i}`);
  assert.equal(reg.get(rec.workId)!.evidenceNotes?.length, 32);
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

test('create keeps cron origin on the cron chat itself', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({
    kind: 'cron',
    originChatId: 'cron-heartbeat',
    label: 'Heartbeat',
    resultHandle: { type: 'cron_chat', chatId: 'cron-heartbeat' },
  });
  assert.equal(rec.kind, 'cron');
  assert.equal(rec.originChatId, 'cron-heartbeat');
  assert.equal(rec.resultHandle.type, 'cron_chat');
  assert.equal(rec.status, 'running');
});

test('reconcileOnBoot: leftover cron work is interrupted', (t) => {
  const reg = makeRegistry(t);
  const cron = reg.create({
    kind: 'cron',
    originChatId: 'cron-heartbeat',
    label: 'Heartbeat',
    resultHandle: { type: 'cron_chat', chatId: 'cron-heartbeat' },
  });
  const result = reg.reconcileOnBoot({ jobs: [] });
  const done = reg.get(cron.workId)!;
  assert.equal(done.status, 'interrupted');
  assert.match(String(done.error || ''), /cron|harness restarted/i);
  assert.equal(result.interrupted.some((w) => w.workId === cron.workId), true);
});

test('reconcileOnBoot: coding work whose job vanished is interrupted', (t) => {
  const reg = makeRegistry(t);
  const rec = reg.create({ kind: 'coding', originChatId: '123', label: 'gone', resultHandle: { type: 'coding_job', jobId: 'cj_gone_1' } });
  const result = reg.reconcileOnBoot({ jobs: [] });
  assert.equal(reg.get(rec.workId)!.status, 'interrupted');
  assert.equal(result.interrupted.length, 1);
});
