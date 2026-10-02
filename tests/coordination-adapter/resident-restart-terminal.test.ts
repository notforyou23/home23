import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ConversationHistory } from '../../src/agent/history.js';
import type { AgentLoop } from '../../src/agent/loop.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import {
  ResidentCoordinationAdapter, ResidentTurnUdsServer, ResidentUdsAgentPort,
  type ResidentCoordinationPort, type ResidentTerminalReceipt,
} from '../../src/coordination-adapter/index.js';
import { createResidentCredential, ResidentProtocolError } from '../../src/coordination/resident-protocol/index.js';
import { ResidentUdsClient } from '../../src/coordination/transport/uds/index.js';

const origin = {
  kind: 'coordination',
  workId: 'wrk_0198d95f-6c00-7000-8000-000000000301',
  attemptId: 'att_0198d95f-6c00-7000-8000-000000000302',
  leaseId: 'lea_0198d95f-6c00-7000-8000-000000000303',
  holderPrincipalId: 'bot_0198d95f-6c00-7000-8000-000000000304',
  holderInstanceId: 'home23-jerry-harness', authorityReference: 'resident:jerry',
  fencingToken: 1,
  channelId: 'chn_0198d95f-6c00-7000-8000-000000000305',
  originMessageId: 'msg_0198d95f-6c00-7000-8000-000000000306', roundId: null,
} as const;
const chatId = `coordination:${origin.channelId}:${origin.workId}`;
const turnId = `coord-${origin.workId}`;
const identity = {
  requestId: 'req_0198d95f-6c00-7000-8000-000000000307',
  correlationId: 'cor_0198d95f-6c00-7000-8000-000000000308',
};
const replayIdentity = {
  requestId: 'req_0198d95f-6c00-7000-8000-000000000309',
  correlationId: 'cor_0198d95f-6c00-7000-8000-00000000030a',
};
const turnSelection = { modelAlias: null, reasoningEffort: null };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'h23-resident-restart-'));
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'jerry');
  const store = new TurnStore(history);
  let starts = 0;
  let finish = () => {};
  const agent: Pick<AgentLoop, 'runWithTurn' | 'stop' | 'isRunning' | 'getModel' | 'getProvider' | 'getReasoningEffort'> = {
    getModel: () => 'fixture-model', getProvider: () => 'fixture-provider', getReasoningEffort: () => 'medium',
    isRunning: () => false,
    stop: () => ({ stopped: false, chatIds: [] }),
    async runWithTurn() {
      starts++;
      store.writeStart(chatId, turnId, 'fixture-model', 'fixture-provider', { coordination_origin: origin });
      const response = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>(resolve => {
        finish = () => {
          history.append(chatId, [{ role: 'assistant', content: 'Finished normally.' }]);
          store.writeEnd(chatId, turnId, 'complete', { last_seq: 0 });
          resolve({ text: 'Finished normally.', model: 'fixture-model', toolCallCount: 0, durationMs: 1 });
          finish = () => {};
        };
      });
      return { turnId, response };
    },
  };
  const credential = createResidentCredential({ rootKey: Buffer.alloc(32, 0x62), residentSlug: 'jerry',
    role: 'resident', instanceId: origin.holderInstanceId, keyVersion: 1 });
  const socketPath = join(root, 'resident.sock');
  const server = new ResidentTurnUdsServer({ socketPath, serverInstanceId: origin.holderInstanceId,
    credential, residentSlug: 'jerry', agent, history });
  await server.start();
  const client = new ResidentUdsClient({ socketPath, serverInstanceId: origin.holderInstanceId, credential });
  const port = new ResidentUdsAgentPort({ client, residentSlug: 'jerry', retryDelayMs: 10, resultTimeoutMs: 3_000 });
  t.after(async () => { finish(); await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const options = { coordinationOrigin: origin, coordinationRequest: identity, turnSelection,
    onDurableStart: () => {}, onEvent: () => {} };
  return { store, history, port, options, starts: () => starts, finish: () => finish() };
}

test('restart reattachment terminalizes the exact abandoned chat as failed without replaying its execution', async t => {
  const f = await fixture(t);
  f.store.writeStart(chatId, turnId, 'previous-model', 'previous-provider', { coordination_origin: origin });
  f.store.writeEvent(chatId, { type: 'event', turn_id: turnId, seq: 1,
    ts: '2026-10-01T12:03:00.000Z', kind: 'status',
    data: { type: 'status', status: 'awaiting_model', message: 'waiting for first model token after 180000ms' } });
  let canonicalState = 'running';
  const calls: string[] = [];
  const receipts: ResidentTerminalReceipt[] = [];
  const coordination: ResidentCoordinationPort = {
    assertCurrent(binding) { assert.equal(binding.workId, origin.workId); assert.equal(binding.fencingToken, 1); },
    assertCompleted() { throw new Error('Must not claim successful completion'); },
    accept() { throw new Error('Must not accept twice'); }, start() { throw new Error('Must not restart the lease'); },
    revoke() { throw new Error('No operator cancellation was requested'); },
    reattach() { calls.push('reattach'); },
    terminalize({ receipt }) { canonicalState = receipt.status; receipts.push(receipt); return { receipt }; },
  };
  const adapter = new ResidentCoordinationAdapter(f.port, coordination);
  const run = await adapter.reattach({ chatId, instruction: 'Resume this reply', origin,
    ...identity, turnSelection });
  await assert.rejects(run.response, /interrupted/i);
  assert.equal((await run.receipt).status, 'failed');
  assert.equal(canonicalState, 'failed');
  assert.deepEqual(calls, ['reattach']);
  assert.equal(f.starts(), 0, 'A potentially side-effecting resident turn must never be replayed');
  assert.equal(f.store.finalEnvelope(chatId, turnId)?.status, 'orphaned');
  assert.equal(f.store.finalEnvelope(chatId, turnId)?.last_seq, 1);
  assert.equal(f.store.eventsSince(chatId, turnId, -1).length, 1, 'Keep the original diagnostic evidence');

  const replay = await f.port.runWithTurn(chatId, 'Retry transport recovery', {
    ...f.options, coordinationRequest: replayIdentity,
  });
  await assert.rejects(replay.response, /interrupted/i);
  assert.equal((await replay.terminal).status, 'orphaned');
  assert.equal(receipts.length, 1);
  assert.equal(f.history.loadRaw(chatId).filter(record => record.type === 'turn' && record.status === 'orphaned').length, 1);
  assert.equal(f.starts(), 0);
});

test('a forged recovery fence cannot terminalize a pending resident turn', async t => {
  const f = await fixture(t);
  f.store.writeStart(chatId, turnId, 'previous-model', 'previous-provider', { coordination_origin: origin });
  await assert.rejects(f.port.runWithTurn(chatId, 'Recover', {
    ...f.options, coordinationOrigin: { ...origin, fencingToken: 2 },
  }), (error: unknown) => error instanceof ResidentProtocolError && error.code === 'fence_invalid');
  assert.equal(f.store.finalEnvelope(chatId, turnId), null);
  assert.equal(f.starts(), 0);
});

test('a duplicate start joins the current response promise even while AgentLoop reports no active model run', async t => {
  const f = await fixture(t);
  const first = await f.port.runWithTurn(chatId, 'Reply', f.options);
  let replay;
  try {
    replay = await f.port.runWithTurn(chatId, 'Reply', { ...f.options, coordinationRequest: replayIdentity });
    assert.equal(f.store.finalEnvelope(chatId, turnId), null, 'A current response promise is not an orphan');
  } finally {
    f.finish();
    await first.response;
  }
  assert.equal((await replay.response).text, 'Finished normally.');
  assert.equal(f.starts(), 1);
  assert.equal(f.store.finalEnvelope(chatId, turnId)?.status, 'complete');
});
