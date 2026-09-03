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
    readChannelState: (channelId: string) => readChannelManifestAnchors(database, channelId),
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
  };
}

test('worker_run in a speaking turn creates Work and commits one result off the conversation chat', async (t) => {
  const setup = await setupCreatedPath(t);
  let executed = 0;
  let createdHandle: ReturnType<typeof dispatchForegroundDetach> | undefined;
  const rendered = await executeAndFormatTool({
    registry: {
      execute: async () => {
        executed += 1;
        return { content: 'should not run' };
      },
    } as never,
    name: 'worker_run',
    toolCallId: 'call-created',
    input: { worker: 'systems', prompt: 'check' },
    context: {
      ...speakingFacts(),
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

  assert.equal(executed, 0);
  assert.equal(rendered.success, false);
  assert.ok(createdHandle?.created);
  if (!createdHandle?.created) return;
  const workId = createdHandle.handle.workId;
  assert.equal(setup.work.get(workId)?.channelId, CHANNEL_ID);
  assert.equal(setup.work.get(workId)?.originMessageId, MESSAGE_ID);
  assert.match(rendered.result.content, /was not started/);
  assert.match(rendered.result.content, new RegExp(workId));
  assert.doesNotMatch(rendered.result.content, /do not claim this assignment exists as Work/);

  const settled = await createdHandle.handle.settled;
  assert.equal(settled.status, 'completed');
  assert.equal(setup.runWithTurnCalls.length, 1);
  assert.equal(setup.runWithTurnCalls[0].chatId, residentAttemptChatId(CHANNEL_ID, workId));
  assert.notEqual(setup.runWithTurnCalls[0].chatId, CONVERSATION_CHAT_ID);
  assert.equal(setup.runWithTurnCalls[0].instruction, INSTRUCTION);
  assert.equal(setup.runWithTurnCalls[0].hasOrigin, true);
  assert.deepEqual(setup.writeStartCalls, [residentAttemptChatId(CHANNEL_ID, workId)]);
  assert.equal(
    setup.marked.includes(CONVERSATION_CHAT_ID),
    false,
    'Attempt must never markActive the conversation chatId',
  );
  assert.equal(setup.lock.isRunning(CONVERSATION_CHAT_ID), true);
  assert.equal(settled.workId, workId);
  assert.equal(settled.text, 'Canonical Jerry result.');

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
  assert.equal(resultRows[0].text, 'Canonical Jerry result.');
  assert.equal(workResultIdempotencyKey(workId), `work-result:${workId}`);
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
    name: 'worker_run',
    toolCallId: 'call-missing',
    input: { worker: 'systems', prompt: 'check' },
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
