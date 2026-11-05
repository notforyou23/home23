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
  const messages: Array<{
    key: string;
    text: string | null;
    workId: string;
    artifactIds: readonly string[];
  }> = [];
  return {
    messages,
    async commit(input: {
      workId: string;
      text: string | null;
      artifactIds?: readonly string[];
      idempotencyKey: string;
    }) {
      const existing = messages.find((row) => row.key === input.idempotencyKey);
      if (existing) {
        return { messageId: `msg_${input.workId.slice(4)}`, replayed: true };
      }
      messages.push({
        key: input.idempotencyKey,
        text: input.text,
        workId: input.workId,
        artifactIds: [...(input.artifactIds ?? [])],
      });
      return { messageId: `msg_${input.workId.slice(4)}`, replayed: false };
    },
  };
}

function seedReadyArtifact(
  database: M11TestDatabase,
  artifactId: string,
  originalName: string,
) {
  database.raw.prepare(
    `INSERT INTO artifacts (
      id, owner_principal_id, state, original_name, declared_content_type,
      detected_content_type, byte_count, sha256, storage_kind, created_at,
      expires_at, failed_at, deleted_at, version
    ) VALUES (?, ?, 'ready', ?, 'text/plain', 'text/plain', 12, ?,
              'content_addressed', ?, NULL, NULL, NULL, 1)`,
  ).run(
    artifactId,
    BOT_ID,
    originalName,
    'c'.repeat(64),
    AT,
  );
}

async function setup(
  t: { after(fn: () => void): void },
  options: {
    runner?: Parameters<typeof createDetachedAttemptPath>[0]['runner'];
    resolveArtifactIds?: Parameters<typeof createDetachedAttemptPath>[0]['resolveArtifactIds'];
  } = {},
) {
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
  let runnerRuns = 0;
  const path = createDetachedAttemptPath({
    registry,
    work,
    leases,
    lock,
    results,
    now: () => new Date(AT),
    resolveArtifactIds: options.resolveArtifactIds,
    runner: options.runner ?? {
      async run(input) {
        runnerRuns += 1;
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
  return {
    path,
    lock,
    results,
    registry,
    seenLocks,
    generateId,
    work,
    leases,
    database,
    runnerRuns: () => runnerRuns,
  };
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

test('second dispatch of a terminal Work replays the result and does not start a new Attempt', async (t) => {
  const ctx = await setup(t);
  const first = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-03',
    requestId: fixtureId('request', 42),
    correlationId: fixtureId('correlation', 42),
  }));
  const settled = await first.settled;
  assert.equal(settled.status, 'completed');
  assert.equal(ctx.results.messages.length, 1);
  assert.equal(ctx.runnerRuns(), 1);
  assert.equal(ctx.work.get(first.workId)?.state, 'succeeded');

  const second = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-03',
    requestId: fixtureId('request', 43),
    correlationId: fixtureId('correlation', 43),
  }));
  const replayed = await second.settled;
  assert.equal(second.workId, first.workId);
  assert.equal(second.harnessWorkId, first.harnessWorkId);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.messageId, settled.messageId);
  assert.equal(replayed.text, 'Canonical Jerry result.');
  assert.equal(ctx.results.messages.length, 1);
  assert.equal(ctx.runnerRuns(), 1);
  assert.equal(ctx.registry.list({}).filter((row) => row.parentWorkId === first.workId).length, 1);

  let restartRuns = 0;
  const restarted = createDetachedAttemptPath({
    registry: ctx.registry,
    work: ctx.work,
    leases: ctx.leases,
    lock: ctx.lock,
    results: ctx.results,
    now: () => new Date(AT),
    runner: {
      async run() {
        restartRuns += 1;
        return { text: 'A second Attempt must not run.' };
      },
    },
  });
  const third = restarted.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-03',
    requestId: fixtureId('request', 44),
    correlationId: fixtureId('correlation', 44),
  }));
  const fromDisk = await third.settled;
  assert.equal(third.workId, first.workId);
  assert.equal(fromDisk.replayed, true);
  assert.equal(fromDisk.messageId, settled.messageId);
  assert.equal(fromDisk.text, 'Canonical Jerry result.');
  assert.equal(ctx.results.messages.length, 1);
  assert.equal(restartRuns, 0);
  assert.equal(ctx.work.get(first.workId)?.state, 'succeeded');
});

test('artifact-only success still writes one replayable result Message', async (t) => {
  const artifactId = 'art_0198d95f-6c00-7000-8000-000000000b01';
  const ctx = await setup(t, {
    runner: {
      async run() {
        return {
          text: '',
          artifacts: [{
            type: 'document',
            path: artifactId,
            fileName: 'answer.txt',
          }],
        };
      },
    },
  });
  seedReadyArtifact(ctx.database, artifactId, 'answer.txt');
  const handle = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-04',
    requestId: fixtureId('request', 45),
    correlationId: fixtureId('correlation', 45),
  }));
  const result = await handle.settled;
  assert.equal(result.status, 'completed');
  assert.ok(result.text && result.text.includes('answer.txt'));
  assert.deepEqual([...result.artifactIds], [artifactId]);
  assert.equal(ctx.results.messages.length, 1);
  assert.ok(ctx.results.messages[0].text && ctx.results.messages[0].text.includes('answer.txt'));
  assert.deepEqual([...ctx.results.messages[0].artifactIds], [artifactId]);
  assert.ok(result.messageId);

  const harness = ctx.registry.get(handle.harnessWorkId)!;
  assert.equal(harness.terminalResult?.artifacts?.length, 1);
  assert.equal(harness.terminalResult?.artifacts?.[0].path, artifactId);

  const replayed = await ctx.path.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-04',
    requestId: fixtureId('request', 46),
    correlationId: fixtureId('correlation', 46),
  })).settled;
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.messageId, result.messageId);
  assert.deepEqual([...replayed.artifactIds], [artifactId]);
  assert.equal(ctx.results.messages.length, 1);
});

test('requestCancel revokes the lease and terminalizes Work as cancelled', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedAt = new Promise<void>((resolve) => { started = resolve; });
  const ctx = await setup(t, {
    runner: {
      async run() {
        started();
        await gate;
        return { text: 'cancelled runners must not succeed the Work' };
      },
    },
  });
  const handle = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-05',
    requestId: fixtureId('request', 47),
    correlationId: fixtureId('correlation', 47),
  }));
  await startedAt;
  const outcome = ctx.path.requestCancel({
    registry: ctx.registry,
    cancelCodingJob: async () => undefined,
    stopChat: () => true,
  }, handle.harnessWorkId);
  assert.equal(outcome.status, 'accepted');
  assert.equal(ctx.work.get(handle.workId)?.state, 'cancelling');
  assert.equal(ctx.leases.current(handle.workId).attempt.state, 'cancel_requested');
  release();
  const result = await handle.settled;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.messageId, null);
  assert.equal(ctx.results.messages.length, 0);
  assert.equal(ctx.work.get(handle.workId)?.state, 'cancelled');
  assert.equal(ctx.leases.current(handle.workId).attempt.state, 'cancelled');
  assert.equal(ctx.registry.get(handle.harnessWorkId)?.status, 'cancelled');
});

test('restarted path honors durable cancel and does not succeed the Work', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedAt = new Promise<void>((resolve) => { started = resolve; });
  t.after(() => release());
  const ctx = await setup(t, {
    runner: {
      async run() {
        started();
        await gate;
        return { text: 'cancelled runners must not succeed the Work' };
      },
    },
  });
  const first = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-06',
    requestId: fixtureId('request', 48),
    correlationId: fixtureId('correlation', 48),
  }));
  await startedAt;
  const outcome = ctx.path.requestCancel({
    registry: ctx.registry,
    cancelCodingJob: async () => undefined,
    stopChat: () => true,
  }, first.harnessWorkId);
  assert.equal(outcome.status, 'accepted');
  assert.equal(ctx.work.get(first.workId)?.state, 'cancelling');
  assert.equal(ctx.leases.current(first.workId).attempt.state, 'cancel_requested');

  let restartRuns = 0;
  const restarted = createDetachedAttemptPath({
    registry: ctx.registry,
    work: ctx.work,
    leases: ctx.leases,
    lock: ctx.lock,
    results: ctx.results,
    now: () => new Date(AT),
    runner: {
      async run() {
        restartRuns += 1;
        return { text: 'A restarted path must not succeed a revoked Work.' };
      },
    },
  });
  const second = restarted.dispatch(dispatchInput(ctx.generateId, {
    idempotencyKey: 'detached-attempt-key-06',
    requestId: fixtureId('request', 49),
    correlationId: fixtureId('correlation', 49),
  }));
  const settled = await second.settled;
  assert.equal(second.workId, first.workId);
  assert.equal(restartRuns, 0);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.messageId, null);
  assert.equal(ctx.results.messages.length, 0);
  assert.equal(ctx.work.get(first.workId)?.state, 'cancelled');
  assert.equal(ctx.leases.current(first.workId).attempt.state, 'cancelled');
  assert.notEqual(ctx.work.get(first.workId)?.state, 'succeeded');
  assert.equal(ctx.registry.get(first.harnessWorkId)?.status, 'cancelled');

  release();
  const firstSettled = await first.settled;
  assert.equal(firstSettled.status, 'cancelled');
  assert.equal(ctx.results.messages.length, 0);
  assert.equal(ctx.work.get(first.workId)?.state, 'cancelled');
});

test('boot reconciliation closes an interrupted canonical Working Thread as failed without chat delivery', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedAt = new Promise<void>((resolve) => { started = resolve; });
  const ctx = await setup(t, {
    runner: {
      async run() {
        started();
        await gate;
        return { text: 'a lost runner must not become success' };
      },
    },
  });
  const handle = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    workKind: 'resident_work_thread',
    idempotencyKey: 'detached-attempt-interrupted-root',
    requestId: fixtureId('request', 50),
    correlationId: fixtureId('correlation', 50),
  }));
  await startedAt;

  const boot = ctx.registry.reconcileOnBoot({ jobs: [] });
  assert.equal(boot.interrupted.some((work) => work.workId === handle.harnessWorkId), true);
  const reconciled = ctx.path.reconcileInterrupted(handle.harnessWorkId);
  assert.equal(reconciled?.status, 'failed');
  assert.equal(ctx.work.get(handle.workId)?.state, 'failed');
  assert.equal(ctx.registry.get(handle.harnessWorkId)?.deliveredAt !== undefined, true);
  assert.equal(ctx.results.messages.length, 0);

  release();
  await handle.settled.catch(() => undefined);
  assert.notEqual(ctx.work.get(handle.workId)?.state, 'succeeded');
  assert.equal(ctx.results.messages.length, 0);
});

test('boot reconciliation finishes a terminal harness whose canonical Work was still running', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedAt = new Promise<void>((resolve) => { started = resolve; });
  const ctx = await setup(t, { runner: { async run() { started(); await gate; return { text: 'late result' }; } } });
  const handle = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    workKind: 'resident_work_thread',
    idempotencyKey: 'detached-attempt-harness-first-crash',
    requestId: fixtureId('request', 51),
    correlationId: fixtureId('correlation', 51),
  }));
  await startedAt;
  ctx.registry.complete(handle.harnessWorkId, 'completed', undefined, Object.freeze({
    receiptText: '[Attempt complete] deep work',
    resultText: 'persisted result',
    artifacts: Object.freeze([]),
  }));

  const restarted = createDetachedAttemptPath({
    registry: ctx.registry, work: ctx.work, leases: ctx.leases, lock: ctx.lock, results: ctx.results,
    now: () => new Date(AT), runner: { async run() { throw new Error('must not rerun'); } },
  });
  const recovered = await restarted.reconcilePersisted(handle.harnessWorkId);
  assert.equal(recovered?.status, 'completed');
  assert.equal(ctx.work.get(handle.workId)?.state, 'succeeded');
  assert.equal(ctx.results.messages.length, 1);
  assert.equal(ctx.results.messages[0].text, 'persisted result');
  assert.ok(ctx.registry.get(handle.harnessWorkId)?.deliveredAt);

  release();
  await handle.settled.catch(() => undefined);
  assert.equal(ctx.results.messages.length, 1);
});

test('boot reconciliation delivers a succeeded canonical Work whose result commit was interrupted', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedAt = new Promise<void>((resolve) => { started = resolve; });
  const ctx = await setup(t, { runner: { async run() { started(); await gate; return { text: 'late result' }; } } });
  const handle = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    workKind: 'resident_work_thread',
    idempotencyKey: 'detached-attempt-canonical-first-crash',
    requestId: fixtureId('request', 52),
    correlationId: fixtureId('correlation', 52),
  }));
  await startedAt;
  ctx.registry.complete(handle.harnessWorkId, 'completed', undefined, Object.freeze({
    receiptText: '[Attempt complete] deep work',
    resultText: 'persisted result after canonical commit',
    artifacts: Object.freeze([]),
  }));
  ctx.leases.terminalize({
    workId: handle.workId, attemptId: handle.attemptId, leaseId: handle.leaseId,
    holderPrincipalId: BOT_ID, holderInstanceId: 'resident-jerry-1', fencingToken: handle.fencingToken,
    requestId: fixtureId('request', 53), correlationId: fixtureId('correlation', 53),
    receipt: { status: 'succeeded', sourceReference: 'resident:jerry',
      resultDigest: 'd'.repeat(64), artifactIds: [], timestamp: AT },
  });

  const restarted = createDetachedAttemptPath({
    registry: ctx.registry, work: ctx.work, leases: ctx.leases, lock: ctx.lock, results: ctx.results,
    now: () => new Date(AT), runner: { async run() { throw new Error('must not rerun'); } },
  });
  const recovered = await restarted.reconcilePersisted(handle.harnessWorkId);
  assert.equal(recovered?.status, 'completed');
  assert.equal(ctx.results.messages.length, 1);
  assert.equal(ctx.results.messages[0].text, 'persisted result after canonical commit');

  release();
  await handle.settled.catch(() => undefined);
  assert.equal(ctx.results.messages.length, 1);
});

test('durable Stop wins over a completed harness before reconciliation and suppresses its result', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedAt = new Promise<void>((resolve) => { started = resolve; });
  const ctx = await setup(t, { runner: { async run() { started(); await gate; return { text: 'late result' }; } } });
  const handle = ctx.path.dispatch(dispatchInput(ctx.generateId, {
    workKind: 'resident_work_thread',
    idempotencyKey: 'detached-attempt-cancel-reconcile-race',
    requestId: fixtureId('request', 54),
    correlationId: fixtureId('correlation', 54),
  }));
  await startedAt;
  ctx.registry.complete(handle.harnessWorkId, 'completed', undefined, Object.freeze({
    receiptText: '[Attempt complete] deep work',
    resultText: 'must never post after stop',
    artifacts: Object.freeze([]),
  }));
  ctx.leases.revoke({
    workId: handle.workId, attemptId: handle.attemptId, leaseId: handle.leaseId,
    holderPrincipalId: BOT_ID, holderInstanceId: 'resident-jerry-1', fencingToken: handle.fencingToken,
    requestId: fixtureId('request', 55), correlationId: fixtureId('correlation', 55),
    reasonCode: 'operator_cancel',
  });

  const restarted = createDetachedAttemptPath({
    registry: ctx.registry, work: ctx.work, leases: ctx.leases, lock: ctx.lock, results: ctx.results,
    now: () => new Date(AT), runner: { async run() { throw new Error('must not rerun'); } },
  });
  const recovered = await restarted.reconcilePersisted(handle.harnessWorkId);
  assert.equal(recovered?.status, 'cancelled');
  assert.equal(ctx.work.get(handle.workId)?.state, 'cancelled');
  assert.equal(ctx.results.messages.length, 0);
  assert.ok(ctx.registry.get(handle.harnessWorkId)?.deliveredAt);

  release();
  await handle.settled.catch(() => undefined);
  assert.equal(ctx.results.messages.length, 0);
});

test('live Stop at the harness-to-canonical commit boundary settles cancelled without restart', async (t) => {
  const ctx = await setup(t);
  let injected = false;
  const leases = {
    offer: ctx.leases.offer.bind(ctx.leases),
    accept: ctx.leases.accept.bind(ctx.leases),
    start: ctx.leases.start.bind(ctx.leases),
    current: ctx.leases.current.bind(ctx.leases),
    revoke: ctx.leases.revoke.bind(ctx.leases),
    reject: ctx.leases.reject.bind(ctx.leases),
    expire: ctx.leases.expire.bind(ctx.leases),
    terminalize(input: Parameters<typeof ctx.leases.terminalize>[0]) {
      if (!injected) {
        injected = true;
        const { receipt: _receipt, ...binding } = input;
        ctx.leases.revoke({ ...binding, reasonCode: 'operator_cancel' });
      }
      return ctx.leases.terminalize(input);
    },
  };
  const path = createDetachedAttemptPath({
    registry: ctx.registry, work: ctx.work, leases, lock: ctx.lock, results: ctx.results,
    now: () => new Date(AT), runner: { async run() { return { text: 'must be suppressed' }; } },
  });
  const handle = path.dispatch(dispatchInput(ctx.generateId, {
    workKind: 'resident_work_thread',
    idempotencyKey: 'detached-attempt-live-cancel-boundary',
    requestId: fixtureId('request', 56),
    correlationId: fixtureId('correlation', 56),
  }));
  const settled = await handle.settled;
  assert.equal(injected, true);
  assert.equal(settled.status, 'cancelled');
  assert.equal(ctx.work.get(handle.workId)?.state, 'cancelled');
  assert.equal(ctx.results.messages.length, 0);
});
