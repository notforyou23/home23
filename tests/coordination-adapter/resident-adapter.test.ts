import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResidentCoordinationAdapter, residentRecoveryTruth } from '../../src/coordination-adapter/index.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import type {
  ResidentAgentPort,
  ResidentCoordinationPort,
  ResidentTerminalReceipt,
  ResidentWorkRequest,
} from '../../src/coordination-adapter/index.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function request(): ResidentWorkRequest {
  return {
    chatId: 'coordination:channel_00000000000000000000000001:work_00000000000000000000000001',
    instruction: 'Summarize the visible channel decision.',
    requestId: 'request_00000000000000000000000001',
    correlationId: 'correlation_00000000000000000000001',
    origin: {
      kind: 'coordination',
      workId: 'work_00000000000000000000000001',
      attemptId: 'attempt_000000000000000000000001',
      leaseId: 'lease_00000000000000000000000001',
      holderPrincipalId: 'principal_00000000000000000000001',
      holderInstanceId: 'resident:test',
      authorityReference: 'resident:turn-test',
      fencingToken: 7,
      channelId: 'channel_00000000000000000000000001',
      originMessageId: 'message_0000000000000000000000001',
      roundId: null,
    },
  };
}

function harness(options: { staleAfter?: number; deferred?: boolean } = {}) {
  const calls: string[] = [];
  const observations: unknown[] = [];
  const receipts: ResidentTerminalReceipt[] = [];
  let checks = 0;
  let resolveResponse!: (value: any) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<any>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let capturedText = '';
  let capturedOrigin: unknown;
  const agent: ResidentAgentPort = {
    async runWithTurn(_chatId, text, opts) {
      capturedText = text;
      capturedOrigin = opts.coordinationOrigin;
      calls.push('durable');
      await opts.onDurableStart({ turnId: 'turn-resident-1', chatId: request().chatId, persistedAt: '2026-08-25T12:00:00.000Z' });
      opts.onEvent({ type: 'status', status: 'working' });
      if (!options.deferred) resolveResponse({ text: 'exact result', model: 'test', toolCallCount: 0, durationMs: 1 });
      return { turnId: 'turn-resident-1', response };
    },
    stop(_chatId, turnId) {
      calls.push(`stop:${turnId}`);
      rejectResponse(new Error('operator_stop'));
      return { stopped: true };
    },
  };
  const coordination: ResidentCoordinationPort = {
    assertCurrent() {
      checks += 1;
      calls.push('fence');
      if (options.staleAfter && checks >= options.staleAfter) throw new Error('stale_fence');
    },
    accept() { calls.push('accept'); },
    start() { calls.push('start'); },
    revoke() { calls.push('revoke'); },
    terminalize({ receipt }) {
      calls.push(`terminal:${receipt.status}`);
      receipts.push(receipt);
      return { receipt };
    },
    observe(_binding, observation) {
      calls.push('observe');
      observations.push(observation);
    },
  };
  return {
    adapter: new ResidentCoordinationAdapter(agent, coordination, () => new Date('2026-08-25T12:01:00.000Z')),
    calls,
    observations,
    receipts,
    resolveResponse,
    captured: () => ({ text: capturedText, origin: capturedOrigin }),
  };
}

test('resident turn is durable before lease acceptance/start and uses the intended AgentLoop route', async () => {
  const h = harness();
  const run = await h.adapter.execute(request());
  await run.response;
  await run.receipt;
  assert.equal(run.turnId, 'turn-resident-1');
  assert.deepEqual(h.calls.slice(0, 5), ['durable', 'fence', 'accept', 'fence', 'start']);
});

test('a Work cannot acquire a second resident turn while its fenced turn is active', async () => {
  const h = harness({ deferred: true });
  const run = await h.adapter.execute(request());
  await assert.rejects(h.adapter.execute(request()), /already has an active turn/);
  assert.equal(await h.adapter.cancel(request().origin.workId), true);
  await assert.rejects(run.response, /operator_stop/);
  await run.receipt;
});

test('coordination origin remains separate and does not inject hidden text into the visible instruction', async () => {
  const h = harness();
  const input = request();
  (input.origin as unknown as Record<string, unknown>).memory = 'must never cross';
  const run = await h.adapter.execute(input);
  await run.receipt;
  assert.equal(h.captured().text, input.instruction);
  assert.deepEqual(h.captured().origin, request().origin);
  assert.equal((h.captured().origin as Record<string, unknown>).memory, undefined);
  assert.doesNotMatch(h.captured().text, /work_|attempt_|lease_|fenc|authority/i);
});

test('every observation and terminal callback is rejected after the lease fence becomes stale', async () => {
  const h = harness({ staleAfter: 3 });
  const run = await h.adapter.execute(request());
  await assert.rejects(run.receipt, /stale_fence/);
  assert.equal(h.observations.length, 0);
  assert.equal(h.receipts.length, 0);
  assert.ok(h.calls.includes('stop:turn-resident-1'));
});

test('successful resident completion emits exact positive terminal truth and bounded observations', async () => {
  const h = harness();
  const run = await h.adapter.execute(request());
  await run.receipt;
  assert.equal(h.receipts.length, 1);
  assert.deepEqual(h.receipts[0], {
    status: 'succeeded',
    sourceReference: request().origin.authorityReference,
    resultDigest: sha256('exact result'),
    artifactIds: [],
    timestamp: '2026-08-25T12:01:00.000Z',
  });
  assert.equal(h.observations.length, 1);
  assert.deepEqual(Object.keys(h.observations[0] as object).sort(), ['at', 'evidenceDigest', 'kind', 'outcomeCode']);
});

test('coordination cancellation maps revoke then exact resident turn stop then cancelled receipt', async () => {
  const h = harness({ deferred: true });
  const run = await h.adapter.execute(request());
  assert.equal(await h.adapter.cancel(request().origin.workId), true);
  await assert.rejects(run.response, /operator_stop/);
  await run.receipt;
  assert.ok(h.calls.indexOf('revoke') < h.calls.indexOf('stop:turn-resident-1'));
  assert.equal(h.receipts[0]?.status, 'cancelled');
  assert.equal(h.receipts[0]?.resultDigest, null);
});

test('persisted coordination provenance survives restart and orphaning without private self state', () => {
  const root = join(tmpdir(), `m13-orphan-${process.pid}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  try {
    const history = new ConversationHistory(root, 400_000, 'resident');
    const store = new TurnStore(history);
    const input = request();
    store.writeStart(input.chatId, 'turn-orphan', 'test', 'test', { coordination_origin: input.origin });
    assert.deepEqual(store.startEnvelope(input.chatId, 'turn-orphan')?.coordination_origin, input.origin);
    assert.deepEqual(store.sweepOrphans(input.chatId, 0), ['turn-orphan']);
    assert.equal(store.finalEnvelope(input.chatId, 'turn-orphan')?.status, 'orphaned');
    assert.deepEqual(residentRecoveryTruth(store, input.chatId, 'turn-orphan'), {
      kind: 'unknown',
      workId: input.origin.workId,
      attemptId: input.origin.attemptId,
    });
    const raw = JSON.stringify(history.loadRaw(input.chatId));
    assert.doesNotMatch(raw, /brain|memory|relationship/i);
    assert.doesNotMatch(raw, new RegExp(input.instruction));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart recovery reports exact positive terminal truth only from durable completed output', () => {
  const input = request();
  const records: unknown[] = [];
  const store = new TurnStore({
    appendRecord(_chatId: string, record: unknown) { records.push(record); },
    loadRaw() { return records; },
  } as never);
  store.writeStart(input.chatId, 'turn-complete', 'test', 'test', { coordination_origin: input.origin });
  store.writeEvent(input.chatId, {
    type: 'event', turn_id: 'turn-complete', seq: 1, ts: '2026-08-25T12:01:00.000Z',
    kind: 'response_chunk', data: { type: 'response_chunk', chunk: 'exact result' },
  });
  records.push({ role: 'assistant', content: 'exact result', ts: '2026-08-25T12:01:00.000Z' });
  store.writeEnd(input.chatId, 'turn-complete', 'complete', { last_seq: 1 });
  const truth = residentRecoveryTruth(store, input.chatId, 'turn-complete');
  assert.equal(truth?.kind, 'terminal');
  if (truth?.kind !== 'terminal') assert.fail('terminal truth required');
  assert.equal(truth.receipt.resultDigest, sha256('exact result'));
  assert.equal(truth.receipt.sourceReference, input.origin.authorityReference);
  assert.equal(truth.fencingToken, input.origin.fencingToken);
});
