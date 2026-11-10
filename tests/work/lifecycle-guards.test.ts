import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationHistory } from '../../src/agent/history.ts';
import { TurnStore } from '../../src/chat/turn-store.ts';
import { CodingJobStore } from '../../src/acp/job-store.ts';
import type { CodingJobRecord } from '../../src/acp/types.ts';
import { TERMINAL_JOB_STATUSES } from '../../src/acp/types.ts';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { TERMINAL_WORK_STATUSES } from '../../src/work/types.ts';

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRegistry(t: { after(fn: () => void): void }): WorkRegistry {
  return new WorkRegistry({ store: new WorkStore(tempDir(t, 'lifecycle-work-')), agent: 'jerry' });
}

function createWork(registry: WorkRegistry) {
  return registry.create({
    kind: 'coding', originChatId: '123', label: 'guarded',
    resultHandle: { type: 'coding_job', jobId: 'cj_guard_1' },
  });
}

test('the exported terminal sets are the catalog sets', () => {
  assert.deepEqual([...TERMINAL_WORK_STATUSES].sort(), ['cancelled', 'completed', 'failed', 'interrupted']);
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ['cancelled', 'completed', 'failed', 'interrupted']);
});

test('work can only be finished with a terminal status', (t) => {
  const registry = makeRegistry(t);
  const work = createWork(registry);
  for (const status of ['running', 'queued', 'blocked', 'done', undefined]) {
    assert.throws(() => registry.complete(work.workId, status as never), { code: 'lifecycle_transition_invalid' });
    assert.throws(() => registry.completeInline(work.workId, status as never), { code: 'lifecycle_transition_invalid' });
  }
  const untouched = registry.get(work.workId)!;
  assert.equal(untouched.status, 'running');
  assert.equal(untouched.finishedAt, undefined);
});

test('finished work cannot be reopened or relabelled through update', (t) => {
  const registry = makeRegistry(t);
  const work = createWork(registry);
  // Legal non-terminal moves and non-lifecycle patches still pass.
  assert.equal(registry.update(work.workId, { status: 'blocked' })?.status, 'blocked');
  assert.equal(registry.update(work.workId, { status: 'running', progressSummary: 'half way' })?.status, 'running');
  assert.equal(registry.update('aw_missing_0000', { status: 'failed' }), undefined);

  const done = registry.complete(work.workId, 'completed');
  assert.throws(() => registry.update(work.workId, { status: 'running' }), { code: 'lifecycle_terminal' });
  assert.throws(() => registry.update(work.workId, { status: 'failed' }), { code: 'lifecycle_terminal' });
  assert.throws(() => registry.update(work.workId, { status: 'paused' as never }), { code: 'lifecycle_state_unknown' });

  // Restating the status alongside post-terminal facts is not a move.
  const delivered = registry.update(work.workId, { status: 'completed', deliveredAt: '2026-11-09T00:00:00.000Z' })!;
  assert.equal(delivered.status, 'completed');
  assert.equal(delivered.finishedAt, done.finishedAt);
  assert.equal(registry.update(work.workId, { verification: 'pending' })?.verification, 'pending');
  // The first terminal status still wins a racing second completion.
  assert.equal(registry.complete(work.workId, 'failed', 'late').status, 'completed');
});

function jobRecord(id: string, status: CodingJobRecord['status']): CodingJobRecord {
  return {
    schema: 'home23.coding-job.v1', id, backend: 'codex', status, prompt: 'p',
    cwd: '/tmp/x', requestedCwd: '/tmp/x', startedAt: new Date().toISOString(), isolation: 'none',
  };
}

test('a coding job record follows the coding-job lifecycle', (t) => {
  const store = new CodingJobStore(tempDir(t, 'lifecycle-jobs-'));
  const id = store.newJobId();
  store.createJob(jobRecord(id, 'starting'));
  assert.equal(store.updateJob(id, { status: 'running', pid: 42 }).status, 'running');
  assert.throws(() => store.updateJob(id, { status: 'starting' }), { code: 'lifecycle_transition_invalid' });
  assert.throws(() => store.updateJob(id, { status: 'done' as never }), { code: 'lifecycle_state_unknown' });
  assert.equal(store.getJob(id)?.status, 'running');

  assert.equal(store.updateJob(id, { status: 'cancelled' }).status, 'cancelled');
  for (const status of ['running', 'completed', 'failed', 'interrupted', 'starting'] as const) {
    assert.throws(() => store.updateJob(id, { status }), { code: 'lifecycle_terminal' });
  }
  // Non-lifecycle patches and a restated status still land on a finished job.
  assert.equal(store.updateJob(id, { status: 'cancelled', error: 'operator stop' }).error, 'operator stop');
  assert.equal(store.updateJob(id, { sessionId: 'sess-9' }).status, 'cancelled');

  // A record written by another build with an unknown status can still be
  // moved to a known one, but never to another unknown one.
  const legacy = store.newJobId();
  store.createJob(jobRecord(legacy, 'paused' as never));
  assert.throws(() => store.updateJob(legacy, { status: 'resumed' as never }), { code: 'lifecycle_state_unknown' });
  assert.equal(store.updateJob(legacy, { status: 'interrupted' }).status, 'interrupted');

  // A job that never spawned ends straight from starting.
  const second = store.newJobId();
  store.createJob(jobRecord(second, 'starting'));
  assert.equal(store.updateJob(second, { status: 'failed' }).status, 'failed');
});

test('a turn can only be ended with a terminal status', (t) => {
  const history = new ConversationHistory(tempDir(t, 'lifecycle-turns-'));
  const store = new TurnStore(history);
  store.writeStart('chat-1', 't_guard_1');
  for (const status of ['pending', 'running', 'streaming', 'tool_running', 'stopping', 'finished']) {
    assert.throws(() => store.writeEnd('chat-1', 't_guard_1', status as never, { last_seq: 0 }),
      { code: 'lifecycle_transition_invalid' });
  }
  assert.equal(store.finalEnvelope('chat-1', 't_guard_1'), null);
  assert.equal(store.pendingTurns('chat-1').length, 1);

  for (const [index, status] of (['complete', 'stopped', 'error', 'timeout', 'orphaned'] as const).entries()) {
    const turnId = `t_guard_end_${index}`;
    store.writeStart('chat-1', turnId);
    assert.equal(store.writeEnd('chat-1', turnId, status, { last_seq: 0 }).status, status);
    assert.equal(store.statusForTurn('chat-1', turnId)?.status, status);
  }
});
