import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResidentCoordinationAdapter } from '../../src/coordination-adapter/resident-adapter.js';
import type {
  ResidentAgentPort,
  ResidentCoordinationPort,
  ResidentWorkRequest,
} from '../../src/coordination-adapter/types.js';

function origin(workId: string): ResidentWorkRequest['origin'] {
  return {
    kind: 'coordination',
    workId,
    attemptId: `attempt_${workId}`,
    leaseId: `lease_${workId}`,
    holderPrincipalId: 'principal_jerry',
    holderInstanceId: 'resident:jerry',
    authorityReference: 'resident:jerry',
    fencingToken: 1,
    channelId: 'channel_1',
    originMessageId: 'message_1',
    roundId: null,
  };
}

function request(workId: string): ResidentWorkRequest {
  return {
    chatId: `coordination:channel_1:${workId}`,
    instruction: 'do the assignment',
    requestId: `request_${workId}`,
    correlationId: `correlation_${workId}`,
    turnSelection: { modelAlias: null, reasoningEffort: null },
    origin: origin(workId),
  };
}

test('adapter active set is keyed by workId, not by resident or conversation', async () => {
  const started: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const agent: ResidentAgentPort = {
    async runWithTurn(chatId, _text, opts) {
      started.push(chatId);
      await opts.onDurableStart({
        turnId: `coord-${opts.coordinationOrigin.workId}`,
        chatId,
        persistedAt: new Date().toISOString(),
      });
      return {
        turnId: `coord-${opts.coordinationOrigin.workId}`,
        response: hold.then(() => ({ text: 'ok', model: 'test', toolCallCount: 0, durationMs: 1 })),
      };
    },
    async stop() { return { stopped: true, chatIds: [] }; },
  };
  const coordination: ResidentCoordinationPort = {
    async assertCurrent() {},
    async accept() {},
    async start() {},
    async reattach() {},
    async assertCompleted() { return undefined; },
    async terminalize(_binding, receipt) { return receipt; },
    async revoke() {},
  };

  const adapter = new ResidentCoordinationAdapter(agent, coordination);
  const first = await adapter.execute(request('work_w1'));
  assert.deepEqual(adapter.listActiveWorkIds(), ['work_w1']);

  const second = await adapter.execute(request('work_w2'));
  assert.deepEqual([...adapter.listActiveWorkIds()].sort(), ['work_w1', 'work_w2']);

  await assert.rejects(adapter.execute(request('work_w1')), /already has an active turn/);
  release();
  await first.response;
  await first.receipt;
  await second.response;
  await second.receipt;
  assert.deepEqual(adapter.listActiveWorkIds(), []);
});
