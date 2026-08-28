import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResidentCoordinationAdapter, residentRecoveryTruth } from '../../src/coordination-adapter/index.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import { SqliteCommunicationEventRepository } from '../../src/coordination/communications/index.js';
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  M11TestDatabase,
  fixtureId,
} from '../coordination/work/test-fixture.js';
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
      opts.onEvent({
        turnId: 'turn-resident-1',
        sequence: 1,
        occurredAt: '2026-08-25T12:00:30.000Z',
        provider: 'fixture',
        model: 'test',
        reasoningEffort: 'high',
        event: { type: 'status', status: 'working', sourceEventType: 'runtime.status' },
      });
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
    assertCompleted(_binding, resultDigest) { calls.push(`completed:${resultDigest ?? 'pending'}`); },
    accept() { calls.push('accept'); },
    start() { calls.push('start'); },
    reattach() { calls.push('reattach'); },
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

test('resident reattachment preserves the current turn and does not accept or start a second lease', async () => {
  const h = harness();
  const run = await h.adapter.reattach(request());
  await run.response;
  await run.receipt;
  assert.deepEqual(h.calls.slice(0, 2), ['durable', 'fence']);
  assert.ok(h.calls.includes('reattach'));
  assert.equal(h.calls.includes('accept'), false);
  assert.equal(h.calls.includes('start'), false);
});

test('accepted resident continuation starts the exact durable turn without accepting twice', async () => {
  const h = harness();
  const run = await h.adapter.continueAccepted(request());
  await run.response;
  await run.receipt;
  assert.equal(h.calls.includes('accept'), false);
  assert.ok(h.calls.includes('start'));
  assert.equal(h.calls.includes('reattach'), false);
});

test('completed resident recovery verifies the immutable result digest without a second terminal receipt', async () => {
  const h = harness();
  const run = await h.adapter.recoverCompleted(request());
  assert.equal((await run.response).text, 'exact result');
  assert.ok(h.calls.includes('completed:pending'));
  assert.ok(h.calls.includes(`completed:${sha256('exact result')}`));
  assert.equal(h.calls.some((call) => call.startsWith('terminal:')), false);
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

test('a stale lease fence prevents canonical communication evidence from being appended', async () => {
  let fenceChecks = 0;
  let appends = 0;
  let stopped = false;
  const agent: ResidentAgentPort = {
    async runWithTurn(chatId, _text, options) {
      const turnId = 'turn-stale-communications';
      await options.onDurableStart({ turnId, chatId, persistedAt: '2026-08-25T12:00:00.000Z' });
      options.onEvent({
        turnId,
        sequence: 1,
        occurredAt: '2026-08-25T12:00:01.000Z',
        provider: 'fixture',
        model: 'fixture-model',
        reasoningEffort: null,
        event: { type: 'status', status: 'working', sourceEventType: 'runtime.status' },
      });
      return {
        turnId,
        response: Promise.resolve({ text: 'must not commit', model: 'fixture-model', toolCallCount: 0, durationMs: 1 }),
      };
    },
    stop: () => { stopped = true; return { stopped: true }; },
  };
  const coordination: ResidentCoordinationPort = {
    assertCurrent() {
      fenceChecks += 1;
      if (fenceChecks >= 3) throw new Error('stale_fence');
    },
    assertCompleted: () => undefined,
    accept: () => undefined,
    start: () => undefined,
    reattach: () => undefined,
    revoke: () => undefined,
    terminalize: () => assert.fail('stale Work must not terminalize'),
  };
  const input = request();
  input.communication = {
    conversationId: 'cnv_0198d95f-6c00-7000-8000-000000000779',
    responseMessageId: 'msg_0198d95f-6c00-7000-8000-000000000779',
    actor: { principalId: 'bot_0198d95f-6c00-7000-8000-000000000779',
      displayName: 'Jerry', kind: 'resident_bot' },
  };
  const adapter = new ResidentCoordinationAdapter(
    agent,
    coordination,
    () => new Date('2026-08-25T12:00:02.000Z'),
    { append: () => { appends += 1; } },
  );
  const run = await adapter.execute(input);
  await assert.rejects(run.receipt, /stale_fence/);
  assert.equal(appends, 0);
  assert.equal(stopped, true);
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

test('resident evidence maps losslessly with stable identities, nesting, and replay idempotency', async (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const communications = new SqliteCommunicationEventRepository(database);
  const conversationId = 'cnv_0198d95f-6c00-7000-8000-000000000777';
  const responseMessageId = fixtureId('message', 777);
  const canonicalRequest: ResidentWorkRequest = {
    chatId: 'coordination:communications:work-777',
    instruction: 'Preserve every exposed event.',
    requestId: fixtureId('request', 777),
    correlationId: fixtureId('correlation', 777),
    origin: {
      kind: 'coordination',
      workId: fixtureId('work', 777),
      attemptId: fixtureId('attempt', 777),
      leaseId: fixtureId('lease', 777),
      holderPrincipalId: BOT_ID,
      holderInstanceId: 'resident-1',
      authorityReference: 'resident:jerry',
      fencingToken: 1,
      channelId: CHANNEL_ID,
      originMessageId: fixtureId('message', 776),
      roundId: null,
    },
    communication: {
      conversationId,
      responseMessageId,
      actor: { principalId: BOT_ID, displayName: 'Jerry', kind: 'resident_bot' },
    },
  };
  const durableEvents = [
    {
      turnId: 'coord-work-777', sequence: 1, occurredAt: '2026-08-25T16:00:00.001Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'thinking' as const, content: 'full exact reasoning',
        provenance: 'provider_verbatim_reasoning' as const,
        sourceEventType: 'response.reasoning_text.delta',
        providerEvent: { type: 'response.reasoning_text.delta', delta: 'full exact reasoning' } },
    },
    {
      turnId: 'coord-work-777', sequence: 2, occurredAt: '2026-08-25T16:00:00.002Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'thinking' as const, content: 'summary exact reasoning',
        provenance: 'provider_reasoning_summary' as const,
        sourceEventType: 'response.reasoning_summary_text.delta',
        providerEvent: { type: 'response.reasoning_summary_text.delta', delta: 'summary exact reasoning' } },
    },
    {
      turnId: 'coord-work-777', sequence: 3, occurredAt: '2026-08-25T16:00:00.003Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'tool_start' as const, tool: 'shell', toolCallId: 'call-a',
        args: { command: 'printf  exact  ' }, sourceEventType: 'response.function_call_arguments.done' },
    },
    {
      turnId: 'coord-work-777', sequence: 4, occurredAt: '2026-08-25T16:00:00.004Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'tool_result' as const, tool: 'shell', toolCallId: 'call-a',
        result: 'preview', exactResult: 'stdout\n  exact whitespace  \nstderr\n', success: true,
        sourceEventType: 'runtime.tool_result' },
    },
    {
      turnId: 'coord-work-777', sequence: 5, occurredAt: '2026-08-25T16:00:00.005Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'tool_start' as const, tool: 'shell', toolCallId: 'call-b',
        args: { command: 'second same-name call' }, sourceEventType: 'response.function_call_arguments.done' },
    },
    {
      turnId: 'coord-work-777', sequence: 6, occurredAt: '2026-08-25T16:00:00.006Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'subagent_start' as const, subagentId: 'subagent-1',
        task: 'nested exact task', parentToolCallId: 'call-b', label: 'Nested',
        sourceEventType: 'runtime.subagent_start' },
    },
    {
      turnId: 'coord-work-777', sequence: 7, occurredAt: '2026-08-25T16:00:00.007Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'subagent_result' as const, subagentId: 'subagent-1',
        task: 'nested exact task', result: 'nested exact result', success: true,
        parentToolCallId: 'call-b', sourceEventType: 'runtime.subagent_result' },
    },
    {
      turnId: 'coord-work-777', sequence: 8, occurredAt: '2026-08-25T16:00:00.008Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'tool_result' as const, tool: 'shell', toolCallId: 'call-b',
        result: 'second preview', exactResult: 'second exact result', success: false,
        sourceEventType: 'runtime.tool_result' },
    },
    {
      turnId: 'coord-work-777', sequence: 9, occurredAt: '2026-08-25T16:00:00.009Z',
      provider: 'openai-codex', model: 'gpt-5.6', reasoningEffort: 'high' as const,
      event: { type: 'response_chunk' as const, chunk: 'final exact delta',
        sourceEventType: 'response.output_text.delta',
        providerEvent: { type: 'response.output_text.delta', delta: 'final exact delta' } },
    },
  ];
  const agent: ResidentAgentPort = {
    async runWithTurn(chatId, _text, options) {
      await options.onDurableStart({ turnId: 'coord-work-777', chatId, persistedAt: AT });
      for (const event of durableEvents) options.onEvent(event);
      return {
        turnId: 'coord-work-777',
        response: Promise.resolve({ text: 'final exact delta', model: 'gpt-5.6', toolCallCount: 2, durationMs: 9 }),
        terminal: Promise.resolve({
          status: 'complete', lastSequence: 9, endedAt: '2026-08-25T16:00:00.010Z',
          errorCode: null, errorMessage: null, provider: 'openai-codex', model: 'gpt-5.6',
          reasoningEffort: 'high',
        }),
      };
    },
    stop: () => ({ stopped: true }),
  };
  const coordination: ResidentCoordinationPort = {
    assertCurrent: () => undefined,
    assertCompleted: () => undefined,
    accept: () => undefined,
    start: () => undefined,
    reattach: () => undefined,
    revoke: () => undefined,
    terminalize: () => undefined,
  };
  const adapter = new ResidentCoordinationAdapter(agent, coordination, () => new Date(AT), communications);
  const first = await adapter.execute(canonicalRequest);
  await Promise.all([first.response, first.receipt]);
  const replay = await adapter.reattach(canonicalRequest);
  await Promise.all([replay.response, replay.receipt]);

  const history = communications.history({
    afterSequence: 1,
    limit: 100,
    requestId: fixtureId('request', 778),
    conversationId,
  });
  assert.equal(history.kind, 'events');
  if (history.kind !== 'events') assert.fail('resident communication history required');
  assert.deepEqual(history.events.map((event) => event.kind), [
    'reasoning', 'reasoning', 'tool_call_started', 'tool_call_completed',
    'tool_call_started', 'subagent_started', 'subagent_completed',
    'tool_call_completed', 'assistant_response_delta', 'receipt',
  ]);
  assert.equal(history.events.length, 10, 'reattachment must not duplicate evidence');
  assert.equal(history.events[0]?.provenance, 'provider_verbatim_reasoning');
  assert.equal(history.events[1]?.provenance, 'provider_reasoning_summary');
  assert.deepEqual(history.events[0]?.payload.providerEvent,
    { type: 'response.reasoning_text.delta', delta: 'full exact reasoning' });
  assert.equal(history.events[3]?.payload.result, 'stdout\n  exact whitespace  \nstderr\n');
  assert.equal(history.events[2]?.payload.toolCallId, 'call-a');
  assert.equal(history.events[4]?.payload.toolCallId, 'call-b');
  assert.notEqual(history.events[2]?.eventId, history.events[4]?.eventId,
    'same-name tool calls require distinct stable identity');
  assert.equal(history.events[3]?.parentEventId, history.events[2]?.eventId);
  assert.equal(history.events[5]?.parentEventId, history.events[4]?.eventId);
  assert.equal(history.events[6]?.parentEventId, history.events[5]?.eventId);
  assert.equal(history.events[7]?.parentEventId, history.events[4]?.eventId);
  assert.equal(history.events[9]?.parentEventId, history.events[8]?.eventId);
  assert.equal(history.events[9]?.occurredAt, '2026-08-25T16:00:00.010Z');
  assert.equal(history.events[9]?.source.reasoningEffort, 'high');
  assert.equal((history.events[9]?.payload.residentTerminal as { lastSequence?: number })?.lastSequence, 9);
  assert.equal(new Set(history.events.map((event) => event.eventId)).size, history.events.length);
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
