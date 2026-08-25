import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { requestAsyncWorkCancel } from '../../src/work/cancel.ts';
import { finishCronAgentTurn, startCronAgentTurn } from '../../src/work/cron-work.ts';

function makeRegistry(t: { after(fn: () => void): void }): WorkRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'cron-work-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
}

test('startCronAgentTurn records a running cron_chat work item', (t) => {
  const registry = makeRegistry(t);
  const work = startCronAgentTurn(registry, { id: 'heartbeat', name: 'Heartbeat pulse' });
  assert.equal(work.kind, 'cron');
  assert.equal(work.originChatId, 'cron-heartbeat');
  assert.deepEqual(work.resultHandle, { type: 'cron_chat', chatId: 'cron-heartbeat' });
  assert.equal(work.label, 'Heartbeat pulse');
  assert.equal(work.status, 'running');
});

test('finishCronAgentTurn completes ok and fails error', (t) => {
  const registry = makeRegistry(t);
  const ok = startCronAgentTurn(registry, { id: 'ok-job', name: 'ok' });
  assert.equal(finishCronAgentTurn(registry, ok.workId, { status: 'ok' }).status, 'completed');

  const bad = startCronAgentTurn(registry, { id: 'bad-job', name: 'bad' });
  const failed = finishCronAgentTurn(registry, bad.workId, { status: 'error', error: 'boom' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
});

test('cancel of cron work stops the cron chat', (t) => {
  const registry = makeRegistry(t);
  const work = startCronAgentTurn(registry, { id: 'nightly', name: 'Nightly' });
  const stopped: string[] = [];
  const outcome = requestAsyncWorkCancel({
    registry,
    cancelCodingJob: async () => {},
    stopChat: (chatId) => { stopped.push(chatId); return true; },
  }, work.workId);
  assert.equal(outcome.status, 'accepted');
  assert.deepEqual(stopped, ['cron-nightly']);
  assert.equal(finishCronAgentTurn(registry, work.workId, { status: 'error', error: 'aborted' }).status, 'cancelled');
});
