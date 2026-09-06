import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { executeAndFormatTool } from '../../src/agent/tool-result.ts';
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from '../../src/coordination/channels/index.ts';
import { workResultIdempotencyKey } from '../../src/coordination/contracts/resident-presence.ts';
import { createLeaseService } from '../../src/coordination/leases/index.ts';
import { createMessageService } from '../../src/coordination/messages/index.ts';
import {
  createWorkService,
  M11MessageProvenanceAuthority,
} from '../../src/coordination/work/index.ts';
import {
  createForegroundDetachLock,
  createLane3ResultCommit,
  createResidentAttemptRunner,
  dispatchForegroundDetach,
  readChannelManifestAnchors,
} from '../../src/work/foreground-detach.ts';
import { residentAttemptChatId } from '../../src/work/detach.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { WorkStore } from '../../src/work/work-store.ts';
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
} from '../coordination/work/test-fixture.ts';

const CONVERSATION_ID = 'cnv_0198d95f-6c00-7000-8000-000000000050';
const HOLDER_INSTANCE_ID = 'resident-1';
const AUTHORITY_REFERENCE = 'resident:jerry';
const CONVERSATION_CHAT_ID = 'ios_conv_42';
const INSTRUCTION = 'Finish the long assignment.';

function residentContext(requestId: string, correlationId: string) {
  return {
    principalId: BOT_ID,
    requestId,
    correlationId,
    identity: {
      kind: 'resident' as const,
      resident: {
        requestId,
        correlationId,
        credential: {
          residentSlug: 'jerry',
          role: 'resident' as const,
          instanceId: HOLDER_INSTANCE_ID,
          keyVersion: 1,
        },
      },
    },
  };
}

function seedConversation(database: M11TestDatabase) {
  database.raw.prepare('INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)')
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare('UPDATE bots SET conversation_id = ? WHERE id = ?').run(CONVERSATION_ID, BOT_ID);
}

function jerryDirectory() {
  const botRecord = Object.freeze({
    id: BOT_ID,
    principalId: BOT_ID,
    name: 'Jerry',
    purpose: 'Persistent resident',
    lifecycle: 'active' as const,
    conversationId: CONVERSATION_ID,
    residentBinding: 'jerry',
    continuingIdentity: true,
    durableMailbox: true,
    requiredCapabilities: Object.freeze(['messages']),
    activeInstanceId: HOLDER_INSTANCE_ID,
    activeKeyVersion: 1,
    residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(['messages']),
    residentRegisteredAt: AT,
    lastHeartbeatAt: AT,
    reportedAvailability: 'available' as const,
    availability: 'available' as const,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
  return {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (namespace: string, value: string) =>
      namespace === 'resident' && value === 'jerry' ? botRecord : null,
    getBotByResidentBinding: async (value: string) => value === 'jerry' ? botRecord : null,
  };
}

async function setupCreatedPath(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'foreground-detach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  seedConversation(database);
  const generateId = createFixtureIdGenerator();
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({
    database,
    generateId,
    now: () => new Date(AT),
    leaseTtlMs: 60_000,
  });
  const messages = createMessageService({
    repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    }),
    participantDirectory: jerryDirectory(),
    now: () => new Date(AT),
  });
  const registry = new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
  const speaking = new Set<string>([CONVERSATION_CHAT_ID]);
  const marked: string[] = [];
  const lock = createForegroundDetachLock({
    isRunning: (chatId) => speaking.has(chatId),
  });
  const originalMark = lock.markActive.bind(lock);
  lock.markActive = (chatId) => {
    marked.push(chatId);
    originalMark(chatId);
  };
  const runWithTurnCalls: Array<{ chatId: string; instruction: string; hasOrigin: boolean }> = [];
  const writeStartCalls: string[] = [];
  const runner = createResidentAttemptRunner({
    async runWithTurn(chatId, instruction, options) {
      runWithTurnCalls.push({
        chatId,
        instruction,
        hasOrigin: options?.coordinationOrigin?.kind === 'coordination',
      });
      writeStartCalls.push(chatId);
      return {
        turnId: 't_attempt',
        response: Promise.resolve({
          text: 'Canonical Jerry result.',
          model: 'test',
          toolCallCount: 0,
          durationMs: 1,
        }),
      };
    },
  });
  const results = createLane3ResultCommit({
    messages,
    actorContext: ({ requestId, correlationId }) => residentContext(requestId, correlationId),
    now: () => new Date(AT),
  });
  const ports = {
    work,
    leases,
    results,
    readChannelState: (channelId: string, originMessageId: string) =>
      readChannelManifestAnchors(database, channelId, originMessageId),
    readOriginAttachmentIds: (messageId: string) => database.readAll<{ artifactId: string }>(
      'SELECT artifact_id AS artifactId FROM message_artifacts WHERE message_id = ? ORDER BY ordinal',
      messageId,
    ).map((row) => row.artifactId),
    now: () => new Date(AT),
  };
  return {
    database,
    work,
    messages,
    registry,
    lock,
    marked,
    runner,
    ports,
    runWithTurnCalls,
    writeStartCalls,
    speaking,
  };
}

function speakingFacts() {
  return {
    chatId: CONVERSATION_CHAT_ID,
    turnRuntime: { turnId: 't_fg' },
    authenticatedUserMessage: {
      chatId: CONVERSATION_CHAT_ID,
      messageRef: 'turn:t_fg:user',
      text: INSTRUCTION,
    },
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    originMessageId: MESSAGE_ID,
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    residentBinding: 'jerry',
    residentInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE,
    runAgentLoop: async () => ({
      text: 'The requested work finished successfully, and the checked result is ready.',
      model: 'test-synthesis', toolCallCount: 0, durationMs: 1,
    }),
  };
}

test('coding_run executes exactly once in Work and commits one sanitized resident result', async (t) => {
  const setup = await setupCreatedPath(t);
  const executions: Array<{ name: string; input: Record<string, unknown>; workId: string | undefined }> = [];
  let synthesisCall: { system: string; message: string; toolCount: number; registryToolCount: number } | undefined;
  let createdHandle: ReturnType<typeof dispatchForegroundDetach> | undefined;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async (name: string, toolInput: Record<string, unknown>, context: { parentWorkId?: string }) => {
        executions.push({ name, input: toolInput, workId: context.parentWorkId });
        return { content: 'Job job_internal: completed\nTo merge: git -C /tmp/private merge branch' };
      },
    } as never,
    name: 'coding_run',
    toolCallId: 'call-created',
    input: { prompt: 'check', cwd: '/tmp/private' },
    context: {
      ...speakingFacts(),
      runAgentLoop: async (system: string, message: string, tools: unknown[], _context: unknown,
        options?: { registry?: { getAnthropicTools(): unknown[] } }) => {
        synthesisCall = {
          system,
          message,
          toolCount: tools.length,
          registryToolCount: options?.registry?.getAnthropicTools().length ?? -1,
        };
        return {
          text: 'The requested work finished successfully, and the checked result is ready.',
          model: 'test-synthesis', toolCallCount: 0, durationMs: 1,
        };
      },
      onForegroundDetachRequired: (request) => {
        createdHandle = dispatchForegroundDetach({
          request,
          context: speakingFacts(),
          ports: setup.ports,
          pathDeps: {
            registry: setup.registry,
            lock: setup.lock,
            runner: setup.runner,
          },
        });
        return createdHandle;
      },
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });

  assert.equal(rendered.success, true);
  assert.notEqual(rendered.result.is_error, true);
  assert.ok(createdHandle?.created);
  if (!createdHandle?.created) return;
  const workId = createdHandle.handle.workId;
  assert.equal(setup.work.get(workId)?.channelId, CHANNEL_ID);
  assert.equal(setup.work.get(workId)?.originMessageId, MESSAGE_ID);
  assert.equal(setup.work.get(workId)?.kind, 'resident_work_thread');
  assert.match(rendered.result.content, /was handed off/);
  assert.doesNotMatch(rendered.result.content, /wrk_/);
  assert.doesNotMatch(rendered.result.content, new RegExp(workId));
  assert.equal(setup.registry.get(createdHandle.handle.harnessWorkId)?.label, 'check');
  assert.doesNotMatch(rendered.result.content, /do not claim this assignment exists as Work/);

  const settled = await createdHandle.handle.settled;
  assert.equal(settled.status, 'completed', JSON.stringify(setup.registry.get(createdHandle.handle.harnessWorkId)));
  assert.deepEqual(executions, [{
    name: 'coding_run',
    input: { prompt: 'check', cwd: '/tmp/private' },
    workId,
  }], 'the exact selected tool invocation runs once under the canonical Working Thread');
  assert.equal(setup.runWithTurnCalls.length, 0,
    'the exact tool invocation must not be reinterpreted by a fresh model turn');
  assert.deepEqual(setup.writeStartCalls, []);
  assert.equal(synthesisCall?.system, '', 'Home ignores this argument, so the contract must be in the user message');
  assert.match(synthesisCall?.message ?? '', /owner-result contract/);
  assert.match(synthesisCall?.message ?? '', /Do not call tools/);
  assert.equal(synthesisCall?.toolCount, 0);
  assert.equal(synthesisCall?.registryToolCount, 0,
    'the no-tools synthesis has an explicit empty seeded registry and cannot fall back to shared tools');
  assert.equal(
    setup.marked.includes(CONVERSATION_CHAT_ID),
    false,
    'Attempt must never markActive the conversation chatId',
  );
  assert.equal(setup.lock.isRunning(CONVERSATION_CHAT_ID), true);
  assert.equal(settled.workId, workId);
  assert.equal(settled.text, 'The requested work finished successfully, and the checked result is ready.');
  assert.doesNotMatch(settled.text ?? '', /job_internal|\/tmp\/private|git -C/);

  const resultRows = setup.database.readAll<{
    id: string;
    kind: string;
    workId: string | null;
    text: string | null;
  }>(
    `SELECT id, kind, work_id AS workId, body_text AS text
     FROM messages WHERE work_id = ? AND kind = 'result'`,
    workId,
  );
  assert.equal(resultRows.length, 1);
  assert.equal(resultRows[0].kind, 'result');
  assert.equal(resultRows[0].text, 'The requested work finished successfully, and the checked result is ready.');
  assert.equal(workResultIdempotencyKey(workId), `work-result:${workId}`);
});

test('an exact promoted tool failure fails the canonical Work and never posts a chat result', async (t) => {
  const setup = await setupCreatedPath(t);
  let createdHandle: ReturnType<typeof dispatchForegroundDetach> | undefined;
  let executions = 0;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async () => {
        executions += 1;
        return { content: 'specialist failed honestly', is_error: true };
      },
    } as never,
    name: 'coding_run',
    toolCallId: 'call-exact-failure',
    input: { prompt: 'perform the guarded check' },
    context: {
      ...speakingFacts(),
      onForegroundDetachRequired: (request) => {
        createdHandle = dispatchForegroundDetach({
          request,
          context: speakingFacts(),
          ports: setup.ports,
          pathDeps: { registry: setup.registry, lock: setup.lock, runner: setup.runner },
        });
        return createdHandle;
      },
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });

  assert.equal(rendered.success, true, 'foreground acknowledgment only confirms the handoff');
  assert.ok(createdHandle?.created);
  if (!createdHandle?.created) return;
  const settled = await createdHandle.handle.settled;
  assert.equal(executions, 1);
  assert.equal(settled.status, 'failed');
  assert.equal(setup.work.get(createdHandle.handle.workId)?.state, 'failed');
  assert.equal(setup.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE work_id = ? AND kind = 'result'",
    createdHandle.handle.workId,
  )?.count, 0);
});

test('a Connected Agents speaking Work promotes long work into a distinct canonical Working Thread', async (t) => {
  const setup = await setupCreatedPath(t);
  const ownerText = 'Keep this going in a separate thread.';
  const scopedTask = 'Run the detailed four-phase validation and preserve the publish gate.';
  const speakingWork = setup.work.create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: 'resident_turn',
    idempotencyKey: 'speaking-work-before-working-thread',
    manifest: {
      privacy: 'channel_only', channelId: CHANNEL_ID, messageIds: [MESSAGE_ID], artifactIds: [],
      counts: { messages: 1, artifacts: 0 },
      watermarks: { channelSequence: 1, eventSequence: 0 },
      digests: { context: 'a'.repeat(64), source: 'b'.repeat(64) },
    },
    maxAutomaticOffers: 2,
    requestId: 'req_0198d95f-6c00-7000-8000-000000000301',
    correlationId: 'cor_0198d95f-6c00-7000-8000-000000000301',
  }).work;
  const chatId = `coordination:${CHANNEL_ID}:${speakingWork.id}`;
  const context = {
    chatId,
    authenticatedUserMessage: { chatId, messageRef: 'turn:coord-speaking:user', text: ownerText },
    turnRuntime: {
      turnId: `coord-${speakingWork.id}`,
      coordinationOrigin: {
        kind: 'coordination', workId: speakingWork.id, attemptId: 'att_existing', leaseId: 'lse_existing',
        holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
        authorityReference: AUTHORITY_REFERENCE, fencingToken: 1,
        channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null,
      },
      coordinationDelivery: {
        conversationId: CONVERSATION_ID, targetPrincipalId: BOT_ID,
        targetDisplayName: 'Jerry', targetKind: 'bot',
      },
    },
    runAgentLoop: async () => ({
      text: 'The validation finished and the publish gate remains protected.',
      model: 'test-synthesis', toolCallCount: 0, durationMs: 1,
    }),
  };
  let promoted: ReturnType<typeof dispatchForegroundDetach> | undefined;
  let directExecutions = 0;
  const rendered = await executeAndFormatTool({
    registry: { execute: async () => {
      directExecutions += 1;
      return { content: 'Scoped specialist result.' };
    } } as never,
    name: 'spawn_agent', toolCallId: 'call-promote', input: { task: scopedTask, mode: 'detached' },
    context: {
      ...context,
      onForegroundDetachRequired: (request: Parameters<typeof dispatchForegroundDetach>[0]['request']) => {
        promoted = dispatchForegroundDetach({
          request,
          context,
          ports: setup.ports,
          pathDeps: { registry: setup.registry, lock: setup.lock, runner: setup.runner },
        });
        return promoted;
      },
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });

  assert.equal(rendered.success, true);
  assert.ok(promoted?.created);
  if (!promoted?.created) return;
  assert.notEqual(promoted.handle.workId, speakingWork.id);
  assert.equal(setup.work.get(speakingWork.id)?.kind, 'resident_turn');
  assert.equal(setup.work.get(promoted.handle.workId)?.kind, 'resident_work_thread');
  assert.equal(setup.work.get(promoted.handle.workId)?.principalId, OWNER_ID,
    'owner authority is recovered from the exact speaking Work');
  const result = await promoted.handle.settled;
  assert.equal(result.status, 'completed', JSON.stringify(setup.registry.get(promoted.handle.harnessWorkId)));
  assert.equal(result.text, 'The validation finished and the publish gate remains protected.');
  assert.equal(directExecutions, 1, 'the promoted spawn invocation runs exactly once');
  assert.equal(setup.runWithTurnCalls.length, 0,
    'the scoped tool assignment is executed directly rather than rewritten as a model prompt');
  assert.equal(setup.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE work_id = ? AND kind = 'result'",
    promoted.handle.workId,
  )?.count, 1);
});

test('same-tool invocations in one speaking turn create distinct Working Threads while exact replay deduplicates', async (t) => {
  const setup = await setupCreatedPath(t);
  const created: Array<ReturnType<typeof dispatchForegroundDetach>> = [];
  const executedTasks: string[] = [];
  const context = speakingFacts();
  const invoke = async (toolCallId: string, task: string) => executeAndFormatTool({
    registry: { execute: async (_name: string, toolInput: Record<string, unknown>) => {
      executedTasks.push(String(toolInput.task));
      return { content: `finished ${String(toolInput.task)}` };
    } } as never,
    name: 'spawn_agent',
    toolCallId,
    input: { task, mode: 'detached' },
    context: {
      ...context,
      onForegroundDetachRequired: (request: Parameters<typeof dispatchForegroundDetach>[0]['request']) => {
        const result = dispatchForegroundDetach({
          request,
          context,
          ports: setup.ports,
          pathDeps: { registry: setup.registry, lock: setup.lock, runner: setup.runner },
        });
        created.push(result);
        return result;
      },
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });

  await invoke('call-one', 'First independent assignment.');
  const firstCreated = created[0];
  if (firstCreated?.created) await firstCreated.handle.settled;
  await invoke('call-two', 'Second independent assignment.');
  const secondCreated = created[1];
  if (secondCreated?.created) await secondCreated.handle.settled;
  await invoke('call-one', 'First independent assignment.');
  const handles = created.filter((item): item is Extract<typeof item, { created: true }> => item.created);
  assert.equal(handles.length, 3);
  assert.notEqual(handles[0].handle.workId, handles[1].handle.workId);
  assert.equal(handles[0].handle.workId, handles[2].handle.workId);
  await Promise.all(handles.map((item) => item.handle.settled));
  assert.deepEqual(executedTasks.sort(), [
    'First independent assignment.',
    'Second independent assignment.',
  ]);
});

test('missing ports or facts refuse without creating Work', async () => {
  const missingPorts = dispatchForegroundDetach({
    request: {
      tool: 'worker_run',
      reason: 'must become durable Work',
      chatId: CONVERSATION_CHAT_ID,
      turnId: 't_fg',
    },
    context: { chatId: CONVERSATION_CHAT_ID, turnRuntime: { turnId: 't_fg' } },
    ports: null,
    pathDeps: null,
  });
  assert.equal(missingPorts.created, false);
  if (missingPorts.created) return;
  assert.ok(missingPorts.missing.includes('ports'));
  assert.ok(missingPorts.missing.includes('channelId'));
  assert.ok(missingPorts.missing.includes('conversationId'));
  assert.ok(missingPorts.missing.includes('originMessageId'));
  assert.ok(missingPorts.missing.includes('principalId'));
  assert.ok(missingPorts.missing.includes('targetPrincipalId'));

  let executed = 0;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async () => {
        executed += 1;
        return { content: 'should not run' };
      },
    } as never,
    name: 'coding_run',
    toolCallId: 'call-missing',
    input: { prompt: 'check' },
    context: {
      chatId: CONVERSATION_CHAT_ID,
      turnRuntime: { turnId: 't_fg' },
      onForegroundDetachRequired: (request) => dispatchForegroundDetach({
        request,
        context: { chatId: CONVERSATION_CHAT_ID, turnRuntime: { turnId: 't_fg' } },
        ports: null,
        pathDeps: null,
      }),
    } as never,
    modelLimit: 4000,
    eventLimit: 4000,
  });
  assert.equal(executed, 0);
  assert.equal(rendered.success, false);
  assert.match(rendered.result.content, /was not started/);
  assert.match(rendered.result.content, /[Dd]o not claim this assignment exists as Work/);
  assert.match(rendered.result.content, /missing:/);
  assert.match(rendered.result.content, /ports/);
  assert.match(rendered.result.content, /channelId/);
  assert.doesNotMatch(rendered.result.content, /Detach is not wired yet/);
});

test('foreground promotion fails closed when the owner Message has attachments that the detached runner cannot hydrate', async (t) => {
  const setup = await setupCreatedPath(t);
  const artifactId = 'art_0198d95f-6c00-7000-8000-000000000b22';
  const ports = { ...setup.ports, readOriginAttachmentIds: () => [artifactId] };

  const result = dispatchForegroundDetach({
    request: {
      tool: 'spawn_agent', reason: 'background', chatId: CONVERSATION_CHAT_ID,
      turnId: 't_attachment', invocationId: 'call-attachment',
      executionInstruction: 'Inspect the attached reference.',
    },
    context: speakingFacts(),
    ports,
    pathDeps: { registry: setup.registry, lock: setup.lock, runner: setup.runner },
  });
  assert.equal(result.created, false);
  if (result.created) return;
  assert.deepEqual(result.missing, ['attachments']);
  assert.equal(setup.registry.list({}).length, 0);
});

function residentRunnerInput() {
  const workId = fixtureId('work', 880);
  return {
    attemptChatId: residentAttemptChatId(CHANNEL_ID, workId),
    conversationChatId: CONVERSATION_CHAT_ID,
    office: 'resident' as const,
    instruction: 'Complete the independent assignment.',
    authority: {
      principalId: OWNER_ID, targetPrincipalId: BOT_ID, residentBinding: 'jerry',
      residentInstanceId: HOLDER_INSTANCE_ID, authorityReference: AUTHORITY_REFERENCE,
      channelId: CHANNEL_ID, conversationId: CONVERSATION_ID,
      originMessageId: MESSAGE_ID, conversationChatId: CONVERSATION_CHAT_ID,
      instruction: 'Complete the independent assignment.',
    },
    destination: {
      kind: 'coordination' as const, parentWorkId: workId, channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID, originMessageId: MESSAGE_ID,
      attemptId: fixtureId('attempt', 880), leaseId: fixtureId('lease', 880), fencingToken: 1,
      targetPrincipalId: BOT_ID, residentBinding: 'jerry', residentInstanceId: HOLDER_INSTANCE_ID,
      authorityReference: AUTHORITY_REFERENCE,
    },
    onProgress: () => undefined,
    onEvidence: () => undefined,
  };
}

test('detached resident root persists exact-work Thoughts and nested Tools through the canonical projector', async () => {
  const appended: Array<{ event: { kind: string; workId?: string | null; conversationId: string; parentEventId?: string | null; eventId?: string }; requestId: string; correlationId: string }> = [];
  const runner = createResidentAttemptRunner({
    async runWithTurn(_chatId, _instruction, options) {
      options?.onDurableEvent?.({ turnId: 'resident-work-test', sequence: 1, occurredAt: AT,
        provider: 'test', model: 'test-model', reasoningEffort: 'medium',
        event: { type: 'thinking', content: 'Checking the durable state.',
          provenance: 'provider_reasoning_summary', sourceEventType: 'test.reasoning' } });
      options?.onDurableEvent?.({ turnId: 'resident-work-test', sequence: 2, occurredAt: AT,
        provider: 'test', model: 'test-model', reasoningEffort: 'medium',
        event: { type: 'tool_start', tool: 'worker_run', args: { task: 'verify' },
          toolCallId: 'tool-1', sourceEventType: 'test.tool' } });
      options?.onDurableEvent?.({ turnId: 'resident-work-test', sequence: 3, occurredAt: AT,
        provider: 'test', model: 'test-model', reasoningEffort: 'medium',
        event: { type: 'tool_result', tool: 'worker_run', result: 'verified', success: true,
          toolCallId: 'tool-1', sourceEventType: 'test.tool_result' } });
      return { turnId: 'resident-work-test', response: Promise.resolve({
        text: 'Everything is verified.', model: 'test-model', toolCallCount: 1, durationMs: 1,
      }) };
    },
  }, {
    append: (input) => { appended.push(input); },
    actorFor: () => ({ principalId: BOT_ID, displayName: 'Jerry', kind: 'resident_bot' }),
    isCancellationRequested: () => false,
  });
  const input = residentRunnerInput();
  await runner.run(input);
  assert.deepEqual(appended.map(({ event }) => event.kind), [
    'reasoning', 'tool_call_started', 'tool_call_completed',
  ]);
  assert.ok(appended.every(({ event }) => event.workId === input.destination.parentWorkId));
  assert.ok(appended.every(({ event }) => event.conversationId === CONVERSATION_ID));
  assert.equal(appended[2].event.parentEventId, appended[1].event.eventId);
});

test('nested tool failure cannot be polished into successful canonical Work', async () => {
  const runner = createResidentAttemptRunner({
    async runWithTurn(_chatId, _instruction, options) {
      options?.onDurableEvent?.({ turnId: 'resident-work-failed', sequence: 1, occurredAt: AT,
        provider: 'test', model: 'test-model', reasoningEffort: null,
        event: { type: 'tool_result', tool: 'coding_run', result: 'child failed', success: false,
          toolCallId: 'tool-failed', sourceEventType: 'test.tool_result' } });
      return { turnId: 'resident-work-failed', response: Promise.resolve({
        text: 'I handled that cleanly.', model: 'test-model', toolCallCount: 1, durationMs: 1,
      }) };
    },
  });
  await assert.rejects(() => runner.run(residentRunnerInput()), /coding_run failed: child failed/);
});

test('durable canonical cancellation is observed by the resident root runner', async () => {
  let rejectResponse: ((error: Error) => void) | undefined;
  let stopped = false;
  const runner = createResidentAttemptRunner({
    async runWithTurn() {
      return { turnId: 'resident-work-stop', response: new Promise((_resolve, reject) => {
        rejectResponse = reject;
      }) };
    },
    stop() {
      stopped = true;
      rejectResponse?.(new Error('operator stopped'));
      return { stopped: true };
    },
  }, {
    append: () => undefined,
    actorFor: () => ({ principalId: BOT_ID, displayName: 'Jerry', kind: 'resident_bot' }),
    isCancellationRequested: () => true,
  });
  await assert.rejects(() => runner.run(residentRunnerInput()), /operator stopped/);
  assert.equal(stopped, true);
});

test('Stop interrupts the isolated attempt chat while exact-work synthesis is active', async () => {
  let stoppedTurnId: string | undefined = 'not-called';
  const runner = createResidentAttemptRunner({
    async runWithTurn() {
      throw new Error('the exact path does not start a second resident turn here');
    },
    stop(_chatId, turnId) {
      stoppedTurnId = turnId;
      return { stopped: true };
    },
  }, {
    append: () => undefined,
    actorFor: () => ({ principalId: BOT_ID, displayName: 'Jerry', kind: 'resident_bot' }),
    isCancellationRequested: () => true,
  });
  const input = residentRunnerInput();
  await assert.rejects(() => runner.run({
    ...input,
    execute: async ({ abortController }) => new Promise((_resolve, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(abortController.signal.reason);
      }, { once: true });
    }),
  }), /Working Thread was stopped/);
  assert.equal(stoppedTurnId, undefined,
    'exact-work synthesis gets a runtime-generated turn id, so Stop targets its isolated chat');
});
