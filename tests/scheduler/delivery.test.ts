import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryManager } from '../../src/scheduler/delivery.ts';
import { AttentionGate } from '../../src/agent/attention/attention-gate.ts';
import type { ChannelAdapter, OutgoingResponse } from '../../src/channels/router.ts';
import type { CronJob } from '../../src/scheduler/cron.ts';

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-field-report',
    name: 'field-report-cycle',
    enabled: true,
    schedule: { kind: 'cron', expr: '7 */2 * * *', tz: 'America/New_York' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', messagePath: 'instances/jerry/workspace/cron-prompts/field-report-cycle.md' },
    delivery: { mode: 'summary', channel: 'telegram', to: '123456789' },
    state: { nextRunAtMs: Date.now() + 60_000, consecutiveErrors: 0 },
    ...overrides,
  };
}

test('summary delivery sends the job response excerpt when a successful job produced human-facing content', async () => {
  const sent: OutgoingResponse[] = [];
  const adapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send(response) {
      sent.push(response);
    },
  };
  const manager = new DeliveryManager(new Map([['telegram', adapter]]));

  await manager.deliver(makeJob(), {
    status: 'ok',
    response: 'Field Report cycle ran Work Unit 2 and created an agency intake packet.',
    durationMs: 214945,
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Field Report cycle ran Work Unit 2/);
  assert.doesNotMatch(sent[0].text, /^\[scheduler\] field-report-cycle: ok/);
});

test('summary delivery keeps the Telegram note and strips the machine intake packet', async () => {
  const sent: OutgoingResponse[] = [];
  const adapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send(response) {
      sent.push(response);
    },
  };
  const manager = new DeliveryManager(new Map([['telegram', adapter]]));

  await manager.deliver(makeJob(), {
    status: 'ok',
    response: [
      'From the inside: wrote the next curriculum unit and filed one follow-up.',
      '',
      'AGENCY_INTAKE_PACKET:',
      '```json',
      '{"schema":"home23.agency.intake-packet.v1"}',
      '```',
    ].join('\n'),
    durationMs: 1000,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'From the inside: wrote the next curriculum unit and filed one follow-up.');
  assert.doesNotMatch(sent[0].text, /AGENCY_INTAKE_PACKET/);
});

test('a failed first delivery does not suppress an identical retry (dedup armed only after a real send)', async () => {
  let clock = 1_000;
  const gate = new AttentionGate({ nowMs: () => clock });

  let failNext = true;
  const sent: OutgoingResponse[] = [];
  const adapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send(response) {
      if (failNext) throw new Error('telegram send failed (transient)');
      sent.push(response);
    },
  };
  const manager = new DeliveryManager(new Map([['telegram', adapter]]), {}, gate);

  const job = makeJob({ delivery: { mode: 'failures', channel: 'telegram', to: '123456789' } });
  const result = { status: 'error' as const, error: 'Backup FAILED: disk full', durationMs: 1000 };

  // Run #1: identical text, but the adapter throws — nothing reaches jtr.
  await manager.deliver(job, result);
  assert.equal(sent.length, 0, 'first send failed, so nothing delivered');

  // Run #2, five minutes later (inside the 6h dedupe window): the transient
  // failure must NOT have armed dedup, so the identical retry still surfaces.
  clock += 5 * 60 * 1000;
  failNext = false;
  await manager.deliver(job, result);
  assert.equal(sent.length, 1, 'identical retry after a failed send must still deliver');
  assert.match(sent[0].text, /Backup FAILED: disk full/);
});

test('a successful delivery still suppresses an identical repeat within the dedupe window', async () => {
  let clock = 1_000;
  const gate = new AttentionGate({ nowMs: () => clock });

  const sent: OutgoingResponse[] = [];
  const adapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send(response) {
      sent.push(response);
    },
  };
  const manager = new DeliveryManager(new Map([['telegram', adapter]]), {}, gate);

  const job = makeJob({ delivery: { mode: 'summary', channel: 'telegram', to: '123456789' } });
  const result = { status: 'ok' as const, response: 'Nightly digest: all systems nominal.', durationMs: 1000 };

  // Run #1 delivers and arms dedup.
  await manager.deliver(job, result);
  assert.equal(sent.length, 1, 'first delivery surfaces');

  // Run #2, five minutes later with identical text, is deduped/suppressed.
  clock += 5 * 60 * 1000;
  await manager.deliver(job, result);
  assert.equal(sent.length, 1, 'identical repeat within the window is suppressed');
});
