import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverScheduledChannelFailure, runScheduledChannelTurn } from '../../src/scheduler/channel-run.js';
import type { JobExecutionContext } from '../../src/scheduler/cron.js';

const input = {
  runId: 'sched-run-0198d95f-6c00-7000-8000-000000000001',
  jobId: 'guarded-check', channelId: 'chn_topic', prompt: 'Inspect the current guard',
};

async function observe(status: Record<string, unknown>) {
  const saved: unknown[] = [];
  const execution: JobExecutionContext = { runId: input.runId, persistCanonicalTurn: value => { saved.push(value); } };
  const result = await runScheduledChannelTurn(input, execution, async () => status);
  let alerts = 0;
  await deliverScheduledChannelFailure(result, async () => {
    alerts++;
    return { status: 'delivered', reason: 'at least one adapter send confirmed', retryEligible: false,
      confirmedTargets: [{ channel: 'home23', to: input.channelId }], unavailableTargets: [], failedTargets: [] };
  });
  assert.deepEqual(saved, [input]);
  return { result, alerts };
}

test('the first or changed blocked outcome alerts while an identical blocked repeat stays quiet', async () => {
  const blocked = { state: 'succeeded', text: 'The guard is unchanged.',
    conclusion: { state: 'blocked', summary: 'Awaiting repair review' } };
  const first = await observe(blocked);
  assert.equal(first.result.status, 'error');
  assert.equal(first.alerts, 1);
  const repeat = await observe({ ...blocked, noticeSuppressed: true });
  assert.equal(repeat.result.semanticStatus, 'failed', 'silence preserves the recorded blocked outcome');
  assert.equal(repeat.alerts, 0);
  const changed = await observe({ ...blocked, conclusion: { state: 'blocked', summary: 'Awaiting a different review' } });
  assert.equal(changed.alerts, 1);
});

for (const state of ['failed', 'cancelled']) {
  test(`repeated ${state} executions always alert despite a stray quiet-notice flag`, async () => {
    for (let run = 0; run < 2; run++) {
      const { result, alerts } = await observe({ state, error: 'Execution did not complete', noticeSuppressed: true });
      assert.equal(result.status, 'error');
      assert.equal(result.scheduledNoticeSuppressed, undefined);
      assert.equal(alerts, 1);
    }
  });
}

test('a cancelled conclusion remains visible and completed progress retains its response', async () => {
  const cancelled = await observe({ state: 'succeeded', noticeSuppressed: true,
    conclusion: { state: 'cancelled', summary: 'The owner stopped this assignment' } });
  assert.equal(cancelled.alerts, 1);
  assert.equal(cancelled.result.scheduledNoticeSuppressed, undefined);
  const progress = await observe({ state: 'succeeded', text: 'The checkpoint advanced.',
    conclusion: { state: 'complete', summary: 'New checkpoint saved' } });
  assert.equal(progress.result.status, 'ok');
  assert.equal(progress.result.response, 'The checkpoint advanced.');
  assert.equal(progress.result.scheduledNoticeSuppressed, undefined);
});
