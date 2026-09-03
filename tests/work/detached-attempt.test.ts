import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLeaseService } from '../../src/coordination/leases/index.ts';
import { createWorkService } from '../../src/coordination/work/index.ts';
import { createDetachedAttemptPath } from '../../src/work/detached-attempt.ts';
import { conversationRunLockHeld, residentAttemptChatId } from '../../src/work/detach.ts';
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
  manifestInput,
} from '../coordination/work/test-fixture.ts';

function makeLock() {
  const runs = new Set<string>();
  const marked: string[] = [];
  return {
    runs,
    marked,
    isRunning: (chatId: string) => runs.has(chatId),
    markActive: (chatId: string) => {
      marked.push(chatId);
      runs.add(chatId);
    },
    clear: (chatId: string) => {
      runs.delete(chatId);
    },
  };
}

function makeResults() {
  const messages: Array<{ key: string; text: string | null; workId: string }> = [];
  return {
    messages,
    async commit(input: {
      workId: string;
      text: string | null;
      idempotencyKey: string;
    }) {
      const existing = messages.find((row) => row.key === input.idempotencyKey);
      if (existing) {
        return { messageId: `msg_${input.workId.slice(4)}`, replayed: true };
      }
      messages.push({ key: input.idempotencyKey, text: input.text, workId: input.workId });
      return { messageId: `msg_${input.workId.slice(4)}`, replayed: false };
    },
  };
}

async function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'detached-attempt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator();
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({
    database,
    generateId,
    now: () => new Date(AT),
    leaseTtlMs: 60_000,
  });
  const registry = new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
  const lock = makeLock();
  const results = makeResults();
  const seenLocks: Array<{ conversation: boolean; attempt: boolean }> = [];
  const path = createDetachedAttemptPath({
    registry,
    work,
    leases,
    lock,
    results,
    now: () => new Date(AT),
    runner: {
      async run(input) {
        seenLocks.push({
          conversation: conversationRunLockHeld(input.conversationChatId, lock.isRunning),
          attempt: lock.isRunning(input.attemptChatId),
        });
        input.onProgress('reading the assignment');
        input.onEvidence('question: confirm the target file?');
        return { text: 'Canonical Jerry result.' };
      },
    },
  });
  return { path, lock, results, registry, seenLocks, generateId };
}

function dispatchInput(
  generateId: ReturnType<typeof createFixtureIdGenerator>,
  overrides: Record<string, unknown> = {},
) {
  return {
    office: 'resident' as const,
    label: 'deep work',
    conversationChatId: 'ios_conv_42',
    instruction: 'Finish the long assignment.',
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    residentBinding: 'jerry',
    residentInstanceId: 'resident-jerry-1',
    authorityReference: 'resident:jerry',
    channelId: CHANNEL_ID,
    conversationId: 'cnv_test_1',
    originMessageId: MESSAGE_ID,
    manifest: manifestInput(),
    idempotencyKey: 'detached-attempt-key-01',
    requestId: fixtureId('request', 40),
    correlationId: fixtureId('correlation', 40),
    ...overrides,
  };
}

test('create Work -> run Attempt -> one result without holding the conversation lock', async (t) => {
  const { path, lock, results, registry, seenLocks, generateId } = await setup(t);
  lock.markActive('ios_conv_42');
  const handle = path.dispatch(dispatchInput(generateId));

  assert.equal(handle.conversationChatId, 'ios_conv_42');
  assert.equal(handle.attemptChatId, residentAttemptChatId(CHANNEL_ID, handle.workId));
  assert.notEqual(handle.attemptChatId, handle.conversationChatId);
  assert.deepEqual(
    lock.marked.filter((id) => id === 'ios_conv_42'),
    ['ios_conv_42'],
    'path never marks the conversation run lock',
  );

  const result = await handle.settled;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Canonical Jerry result.');
  assert.equal(results.messages.length, 1);
  assert.equal(results.messages[0].key, `work-result:${handle.workId}`);
  assert.equal(results.messages[0].text, 'Canonical Jerry result.');
  assert.equal(result.replayed, false);
  assert.ok(result.messageId);

  assert.equal(seenLocks.length, 1);
  assert.equal(seenLocks[0].attempt, true, 'Attempt may hold its own Work-scoped chat');
  assert.equal(lock.isRunning(handle.attemptChatId), false);
  assert.equal(
    lock.marked.includes(handle.attemptChatId),
    true,
    'Attempt ran on the detached Work chat, not the conversation',
  );

  const harness = registry.get(handle.harnessWorkId)!;
  assert.equal(harness.status, 'completed');
  assert.ok(harness.deliveredAt);
  assert.equal(harness.office, 'resident');
  assert.ok(harness.evidenceNotes?.some((note) => note.includes('question:')));
  assert.equal(harness.originChatId, handle.attemptChatId);

  lock.clear('ios_conv_42');
  assert.equal(lock.isRunning('ios_conv_42'), false);
});

test('second completion and retry are idempotent — one Jerry result Message', async (t) => {
  const { path, results, generateId } = await setup(t);
  const handle = path.dispatch(dispatchInput(generateId));
  const first = await handle.settled;
  assert.equal(results.messages.length, 1);

  const second = await handle.settled;
  assert.equal(second.messageId, first.messageId);
  assert.equal(results.messages.length, 1);

  const replayed = await path.replayCompletion(handle.harnessWorkId);
  assert.ok(replayed);
  assert.equal(replayed.messageId, first.messageId);
  assert.equal(replayed.replayed, true);
  assert.equal(results.messages.length, 1);
  assert.equal(results.messages[0].text, 'Canonical Jerry result.');
});

test('delegated office still returns one Jerry result on the same Work identity', async (t) => {
  const { path, results, generateId } = await setup(t);
  const handle = path.dispatch(dispatchInput(generateId, {
    office: 'delegated',
    idempotencyKey: 'detached-attempt-key-02',
    requestId: fixtureId('request', 41),
    correlationId: fixtureId('correlation', 41),
  }));
  assert.match(handle.attemptChatId, /^subagent:coordination:/);
  const result = await handle.settled;
  assert.equal(result.status, 'completed');
  assert.equal(result.workId, handle.workId);
  assert.equal(results.messages.length, 1);
  assert.equal(results.messages[0].key, `work-result:${handle.workId}`);
});

test('cancel stays on the existing Work identity', async (t) => {
  const { path, registry, generateId } = await setup(t);
  const handle = path.dispatch(dispatchInput(generateId, {
    idempotencyKey: 'detached-attempt-key-03',
    requestId: fixtureId('request', 42),
    correlationId: fixtureId('correlation', 42),
  }));
  const stopped: string[] = [];
  const outcome = path.requestCancel({
    registry,
    cancelCodingJob: async () => undefined,
    stopChat: (chatId) => {
      stopped.push(chatId);
      return true;
    },
  }, handle.harnessWorkId);
  assert.ok(outcome.status === 'accepted' || outcome.status === 'already_terminal');
  assert.equal(
    outcome.status === 'not_found' ? '' : outcome.work.workId,
    handle.harnessWorkId,
  );
  await handle.settled;
});
