import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryManager } from '../../src/scheduler/delivery.ts';
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

test('deliver returns the send error via its return value, not just a shared field', async () => {
  const failingAdapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send() {
      throw new Error('telegram 429');
    },
  };
  const manager = new DeliveryManager(new Map([['telegram', failingAdapter]]));

  const { error } = await manager.deliver(makeJob({ delivery: { mode: 'full', channel: 'telegram', to: '1' } }), {
    status: 'ok',
    response: 'done',
    durationMs: 10,
  });

  assert.match(error ?? '', /telegram 429/);
});

test('deliver returns null error when the send succeeds', async () => {
  const okAdapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send() {},
  };
  const manager = new DeliveryManager(new Map([['telegram', okAdapter]]));

  const { error } = await manager.deliver(makeJob({ delivery: { mode: 'full', channel: 'telegram', to: '1' } }), {
    status: 'ok',
    response: 'done',
    durationMs: 10,
  });

  assert.equal(error, null);
});

test('concurrent deliveries do not cross-contaminate their error results', async () => {
  // The scheduler fires jobs concurrently. A per-call return value must isolate
  // each job's delivery outcome — a shared mutable field cannot.
  const adapter: ChannelAdapter = {
    name: 'telegram',
    async start() {},
    async stop() {},
    async send(response) {
      // Yield so the two deliveries interleave, then fail only for chat '2'.
      await new Promise((r) => setTimeout(r, response.chatId === '1' ? 20 : 1));
      if (response.chatId === '2') throw new Error('boom-2');
    },
  };
  const manager = new DeliveryManager(new Map([['telegram', adapter]]));

  const [a, b] = await Promise.all([
    manager.deliver(makeJob({ id: 'a', delivery: { mode: 'full', channel: 'telegram', to: '1' } }), { status: 'ok', response: 'a', durationMs: 1 }),
    manager.deliver(makeJob({ id: 'b', delivery: { mode: 'full', channel: 'telegram', to: '2' } }), { status: 'ok', response: 'b', durationMs: 1 }),
  ]);

  assert.equal(a.error, null, 'job a delivered fine and must not inherit job b failure');
  assert.match(b.error ?? '', /boom-2/);
});
