import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResidentAssignments } from '../../../src/coordination/app/resident-assignments.js';
import { createResidentOutcomeStore } from '../../../src/coordination/app/resident-outcomes.js';
import { projectResidentWork } from '../../../src/coordination/app/resident-work-projection.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { WorkError } from '../../../src/coordination/work/errors.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';
import type { MessagingActorContext } from '../../../src/coordination/channels/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
  database.raw.prepare("UPDATE bots SET active_instance_id='instance-jerry',active_key_version=1 WHERE id=?").run(BOT_ID);
  const generateId = createFixtureIdGenerator(), now = () => new Date(AT);
  const work = createWorkService({ database, generateId, now });
  const leases = createLeaseService({ database, generateId, now, leaseTtlMs: 60000 });
  const identity = { requestId: fixtureId('request', 10), correlationId: fixtureId('correlation', 10) };
  const context = { principalId: BOT_ID, ...identity } as MessagingActorContext;
  const parent = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: 'parent-speaking-idempotency',
    manifest: manifestInput(), maxAutomaticOffers: 1, ...identity }).work;
  const offer = leases.offer({ workId: parent.id, holderPrincipalId: BOT_ID, holderInstanceId: 'instance-jerry', authorityReference: 'resident:jerry', automatic: true, ...identity });
  const binding = { workId: parent.id, attemptId: offer.attempt.id, leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: 'instance-jerry', fencingToken: offer.fencingToken, ...identity };
  leases.accept(binding); leases.start(binding);
  const origin: CoordinationTurnOrigin = { kind: 'coordination', ...binding, authorityReference: 'resident:jerry', channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null };
  const credential = { residentSlug: 'jerry', instanceId: 'client-jerry', keyVersion: 1 };
  const consumer = createForegroundDetachmentConsumer({ database, work, now, schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'client-jerry', serverInstanceId: 'instance-jerry', keyVersion: 1 }) });
  const admit = (invocationId: string) => consumer.admit({ credential, request: { parentOrigin: origin,
    residentSlug: 'jerry', invocationId, toolName: 'spawn_agent', canonicalArgs: { task: 'Verify the repair' },
    executionInstruction: 'Verify the repair', title: 'Repair the launcher', summary: 'Running and verified', recoveryPolicy: 'safe_before_start' } }).workId;
  const cancel = (id: string) => work.cancelQueued({ workId: id, actorPrincipalId: OWNER_ID, reasonCode: 'operator_stop', sourceReference: 'owner:stop', timestamp: AT, ...identity });
  const finish = (id: string, status: 'succeeded' | 'failed' = 'succeeded') => {
    const offered = leases.offer({ workId: id, holderPrincipalId: BOT_ID, holderInstanceId: 'instance-jerry',
      authorityReference: 'resident:jerry', automatic: true, ...identity });
    const execution = { workId: id, attemptId: offered.attempt.id, leaseId: offered.lease.id,
      holderPrincipalId: BOT_ID, holderInstanceId: 'instance-jerry', fencingToken: offered.fencingToken, ...identity };
    leases.accept(execution); leases.start(execution);
    leases.terminalize({ ...execution, receipt: { status, sourceReference: 'resident:jerry',
      resultDigest: 'a'.repeat(64), artifactIds: [], timestamp: AT } });
  };
  const assignments = createResidentAssignments(database);
  return { database, work, origin, context, consumer, admit, cancel, finish, assignments };
}

for (const reviewResult of ['succeeded', 'failed'] as const) {
  test(`resident follow-through stays active while executing and ${reviewResult} review cannot silently close an unassessed assignment`, t => {
    const f = fixture(t), id = f.admit(`review-${reviewResult}`);
    f.finish(id);
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'complete', 'ordinary no-review completion is preserved');
    const outcomes = createResidentOutcomeStore(f.database);
    outcomes.enqueue(`work:${id}`, id, { status: 'succeeded', result: 'Candidate findings; assessment remains' });
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'needs_review', 'review has not been admitted');
    const review = f.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
      originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: `resident-review-${reviewResult}`,
      manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request', 90), correlationId: fixtureId('correlation', 90) }).work;
    outcomes.update(outcomes.pending()[0], 'review_work_id', review.id);
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'active', 'resident is following through, not asking owner for attention');
    f.finish(review.id, reviewResult);
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'needs_review', 'terminal review alone is not a completion assessment');
    outcomes.update(outcomes.pending()[0], 'settled_at', AT);
    const deliveredState = reviewResult === 'succeeded' ? 'returned' : 'needs_review';
    assert.equal(f.assignments.presentationState(id, 'succeeded'), deliveredState, 'successful delivery is returned, not a completion assessment');
    assert.equal(f.assignments.list(BOT_ID).find(value => value.id === id)?.assignmentState, deliveredState,
      'unassessed delivery remains in the resident accountability list');
    f.database.reopen();
    assert.equal(f.assignments.presentationState(id, 'succeeded'), deliveredState);
    f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Current result inspected',
      evidence: ['receipt:independent-verification'] }, `assessed-${reviewResult}`);
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'complete');
  });
}

function visibleResult(f: ReturnType<typeof fixture>, id: string, overrides: {
  workId?: string; channelId?: string; visibility?: 'visible' | 'tombstoned'; kind?: 'result' | 'text'; author?: string;
} = {}) {
  const messageId = `msg_${id.slice(4)}`, channelId = overrides.channelId ?? CHANNEL_ID;
  const author = overrides.author ?? BOT_ID;
  f.database.mutateWithEvent(tx => {
    tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,
      author_display_name,kind,body_text,stored_visibility,work_id,created_at)
      VALUES(?,?,2,?,?,'Resident',?,'Candidate findings delivered to the owner',?,?,?)`,
    messageId, channelId, author, author === OWNER_ID ? 'owner' : 'bot', overrides.kind ?? 'result',
    overrides.visibility ?? 'visible', overrides.workId ?? id, AT);
    return { value: undefined, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: messageId,
      aggregateVersion: 1, channelId, actorPrincipalId: author, requestId: fixtureId('request', 95),
      correlationId: fixtureId('correlation', 95), payload: {}, createdAt: AT } };
  });
}

function failedFollowThrough(f: ReturnType<typeof fixture>, id: string, settled = true) {
  const store = createResidentOutcomeStore(f.database);
  store.enqueue(`work:${id}`, id, { status: 'succeeded', result: 'Candidate findings' });
  const review = f.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: `failed-follow-through-${id}`,
    manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request', 93), correlationId: fixtureId('correlation', 93) }).work;
  store.update(store.pending()[0], 'review_work_id', review.id);
  f.finish(review.id, 'failed');
  if (settled) store.update(store.pending()[0], 'settled_at', AT);
  return review;
}

for (const settled of [false, true]) {
  test(`a visible delivered result survives a failed ${settled ? 'settled' : 'unsettled'} background review without closing accountability`, t => {
    const f = fixture(t), id = f.admit('visible-delivery'); f.finish(id);
    visibleResult(f, id);
    const review = failedFollowThrough(f, id, settled);
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'returned');
    assert.equal(f.assignments.list(BOT_ID).find(row => row.id === id)?.assignmentState, 'returned');
    assert.equal(f.assignments.latest(id), null, 'delivery does not invent an explicit conclusion');
    assert.doesNotThrow(() => f.assignments.assertOpen(id));
    assert.equal(f.work.get(review.id)?.state, 'failed', 'review failure remains available');
    f.database.reopen();
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'returned');
    assert.equal(f.work.get(id)?.state, 'succeeded');
  });
}

for (const mismatch of ['missing', 'hidden', 'wrong_work', 'wrong_channel', 'not_result', 'wrong_author'] as const) {
  test(`${mismatch} result cannot label a failed background review Delivered`, t => {
    const f = fixture(t), id = f.admit(`delivery-${mismatch}`); f.finish(id);
    failedFollowThrough(f, id);
    if (mismatch === 'wrong_channel') {
      const otherChannel = fixtureId('channel', 2);
      f.database.raw.prepare(`INSERT INTO channels(id,kind,title,purpose,owner_principal_id,responder_mode,
        coordinator_bot_id,response_order,max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at)
        VALUES(?,'direct','Other chat','','user_owner','mentions_only',NULL,'parallel',1,'active',0,1,3,?,?)`).run(otherChannel, AT, AT);
      f.database.raw.prepare(`INSERT INTO channel_members(channel_id,principal_id,kind,role,active,joined_at,left_at)
        VALUES(?,?,'bot','member',1,?,NULL)`).run(otherChannel, BOT_ID, AT);
      visibleResult(f, id, { channelId: otherChannel });
    } else if (mismatch !== 'missing') visibleResult(f, id, {
      ...(mismatch === 'hidden' ? { visibility: 'tombstoned' } : {}),
      ...(mismatch === 'wrong_work' ? { workId: f.origin.workId } : {}),
      ...(mismatch === 'not_result' ? { kind: 'text' } : {}),
      ...(mismatch === 'wrong_author' ? { author: OWNER_ID } : {}),
    });
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'needs_review');
  });
}

test('a canonical tombstone hides a delivered result even though its original stored visibility stays visible', t => {
  const f = fixture(t), id = f.admit('deleted-visible-result'); f.finish(id);
  failedFollowThrough(f, id); visibleResult(f, id);
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'returned');
  const messageId = `msg_${id.slice(4)}`, tombstoneId = fixtureId('message', 96);
  f.database.mutateWithEvent(tx => {
    tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,
      author_display_name,kind,body_text,stored_visibility,tombstones_message_id,created_at)
      VALUES(?,?,3,?,'owner','Owner','system',NULL,'visible',?,?)`, tombstoneId, CHANNEL_ID, OWNER_ID, messageId, AT);
    return { value: undefined, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: tombstoneId,
      aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: OWNER_ID, requestId: fixtureId('request', 96),
      correlationId: fixtureId('correlation', 96), payload: {}, createdAt: AT } };
  });
  assert.equal(f.database.readOne<{ visibility: string }>('SELECT stored_visibility AS visibility FROM messages WHERE id=?', messageId)?.visibility, 'visible');
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'needs_review');
  f.database.reopen();
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'needs_review');
});

test('visible delivery does not override an admitted follow-through or an explicit assessment', t => {
  const f = fixture(t), id = f.admit('visible-follow-through'); f.finish(id); visibleResult(f, id);
  const store = createResidentOutcomeStore(f.database);
  store.enqueue(`work:${id}`, id, { status: 'succeeded' });
  const review = f.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: 'active-visible-follow-through',
    manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request', 94), correlationId: fixtureId('correlation', 94) }).work;
  store.update(store.pending()[0], 'review_work_id', review.id);
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'active');
  f.finish(review.id, 'failed'); store.update(store.pending()[0], 'settled_at', AT);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'blocked', summary: 'Owner input required' }, 'visible-explicit-block');
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'blocked');
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Result independently verified',
    evidence: ['receipt:verified-result'] }, 'visible-explicit-complete');
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'complete');
});

test('missed blocked-revisit assessments retry with durable backoff and a fixed budget, preserving every review identity', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AT) });
  const f = fixture(t), id = f.admit('revisit-assessment');
  f.finish(id);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'blocked', summary: 'Waiting for verification',
    revisit_at: new Date(Date.now() + 1000).toISOString() }, 'revisit-assessment-block');
  let store = createResidentOutcomeStore(f.database);
  const revisitRows = () => f.database.readAll<{ key: string }>(
    "SELECT outcome_key AS key FROM resident_outcomes WHERE outcome_key LIKE 'assignment-revisit:%' ORDER BY created_at,outcome_key");
  const settle = (number: number, status: 'succeeded' | 'failed') => {
    const row = store.pending().find(value => value.key.startsWith('assignment-revisit:'))!;
    const review = f.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
      originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: `revisit-assessment-proof-${number}`,
      manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request', 91), correlationId: fixtureId('correlation', 91) }).work;
    store.update(row, 'review_work_id', review.id);
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'active', 'a current revisit is following through on the older block');
    f.finish(review.id, status);
    store.update(row, 'settled_at', new Date().toISOString());
    assert.equal(f.assignments.presentationState(id, 'succeeded'), 'blocked', 'missing assessment does not erase the blocker');
    return review.id;
  };
  t.mock.timers.tick(1000); store.discover();
  assert.equal(revisitRows().length, 1);
  const originalReview = settle(0, 'succeeded');
  t.mock.timers.tick(59_999); store.discover();
  assert.equal(revisitRows().length, 1);
  t.mock.timers.tick(1); store.discover(); store.discover();
  assert.equal(revisitRows().length, 2, 'only one retry after the first minute');
  f.database.reopen(); store = createResidentOutcomeStore(f.database); store.discover();
  assert.equal(revisitRows().length, 2, 'restart retains the retry identity and budget');
  assert.equal(f.assignments.root(originalReview), id, 'retry does not overwrite the original review lineage');
  settle(1, 'failed');
  t.mock.timers.tick(299_999); store.discover();
  assert.equal(revisitRows().length, 2);
  t.mock.timers.tick(1); store.discover();
  assert.equal(revisitRows().length, 3);
  settle(2, 'failed');
  t.mock.timers.tick(86_400_000); store.discover();
  assert.equal(revisitRows().length, 3, 'the same blocked conclusion cannot repeat forever');
  assert.equal(f.work.get(id)?.state, 'succeeded', 'assessment retries never replay the original execution');
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'blocked', summary: 'New inspected dependency',
    revisit_at: new Date(Date.now() + 1000).toISOString() }, 'new-blocked-assessment');
  t.mock.timers.tick(1000); store.discover();
  assert.equal(revisitRows().length, 4, 'a new explicit assessment owns a distinct revisit budget');
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Verified',
    evidence: ['receipt:verified'] }, 'finally-assessed');
  assert.equal(f.assignments.presentationState(id, 'succeeded'), 'complete');
  t.mock.timers.tick(86_400_000); store.discover();
  assert.equal(revisitRows().length, 4, 'completion does not create another assessment retry');
});

test('a stopped revisit is not automatically retried', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AT) });
  const f = fixture(t), id = f.admit('stopped-revisit'); f.finish(id);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'blocked', summary: 'Waiting',
    revisit_at: new Date(Date.now() + 1000).toISOString() }, 'stopped-revisit-block');
  const store = createResidentOutcomeStore(f.database);
  t.mock.timers.tick(1000); store.discover();
  const row = store.pending()[0];
  const review = f.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: 'stopped-revisit-review',
    manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request', 92), correlationId: fixtureId('correlation', 92) }).work;
  store.update(row, 'review_work_id', review.id); f.cancel(review.id);
  store.update(row, 'settled_at', new Date().toISOString());
  t.mock.timers.tick(86_400_000); store.discover();
  assert.equal(store.pending().length, 0, 'an explicit stop is not a transient assessment failure');
});

test('execution termination remains an obligation until the resident records its assessed outcome', t => {
  const f = fixture(t), id = f.admit('first');
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Done', evidence: ['receipt:one'] }, 'active-completion'), /active execution/);
  f.cancel(id);
  assert.throws(() => f.assignments.assertOpen(id), /cancelled/);
  assert.equal(f.assignments.list(BOT_ID).length, 0);
  assert.equal(f.assignments.list(BOT_ID, true)[0].assignmentState, 'cancelled');
  const args = { work_id: id, state: 'blocked', summary: 'Code saved; activation remains unverified', evidence: ['file:repair'] };
  f.assignments.report(f.context, f.origin, args, 'blocked-report');
  const outcomes = createResidentOutcomeStore(f.database);
  outcomes.discover();
  outcomes.update(outcomes.pending()[0], 'settled_at', AT);
  f.database.reopen();
  assert.equal(f.assignments.list(BOT_ID)[0].assignmentState, 'blocked', 'a delivered explanation does not settle the obligation');
  assert.equal(f.assignments.report(f.context, f.origin, args, 'blocked-report').replayed, true);
  assert.throws(() => f.assignments.report(f.context, f.origin, { ...args, summary: 'Changed' }, 'blocked-report'), /replay changed/);
  assert.throws(() => f.assignments.assertOpen(id), /blocked/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Done' }, 'missing-evidence'), /evidence/);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Running behavior inspected', evidence: ['receipt:live-verification'] }, 'verified-report');
  assert.equal(f.assignments.list(BOT_ID).length, 0);
  assert.equal(f.assignments.list(BOT_ID, true)[0].assignmentState, 'complete');
  assert.throws(() => f.assignments.assertOpen(id), /complete/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'active', summary: 'Another attempt' }, 'late-reopen'), /newer canonical owner request/);
});

test('blank optional revisit timestamps are omitted while invalid timestamps remain actionable', t => {
  const f = fixture(t), id = f.admit('optional-revisit');
  assert.equal(f.assignments.report(f.context, f.origin, {
    work_id: id, state: 'active', summary: 'Still working', revisit_at: '',
  }, 'active-blank').revisitAt, null);
  assert.throws(() => f.assignments.report(f.context, f.origin, {
    work_id: id, state: 'active', summary: 'Still working', revisit_at: 'tomorrow',
  }, 'invalid-revisit'), (error: unknown) => error instanceof WorkError &&
    error.code === 'invalid_request' && /ISO timestamp/.test(error.message));
  assert.throws(() => f.assignments.report(f.context, f.origin, {
    work_id: id, state: 'blocked', summary: 'Waited too long', revisit_at: '2020-01-01T00:00:00.000Z',
  }, 'past-revisit'), (error: unknown) => error instanceof WorkError &&
    error.code === 'invalid_request' && /future/.test(error.message));
  f.cancel(id);
  assert.equal(f.assignments.report(f.context, f.origin, {
    work_id: id, state: 'blocked', summary: 'Waiting without a scheduled revisit', revisit_at: '   ',
  }, 'blocked-blank').revisitAt, null);
  assert.equal(f.assignments.report(f.context, f.origin, {
    work_id: id, state: 'complete', summary: 'Inspected completion', evidence: ['receipt:verified'], revisit_at: '',
  }, 'complete-blank').revisitAt, null);
});

test('malformed evidence is rejected as an actionable request error rather than fabricated completion', t => {
  const f = fixture(t), id = f.admit('malformed-evidence');
  f.cancel(id);
  assert.throws(() => f.assignments.report(f.context, f.origin, {
    work_id: id, state: 'complete', summary: 'Claimed completion', evidence: 'receipt:not-an-array',
  }, 'string-evidence'), (error: unknown) => error instanceof WorkError &&
    error.code === 'invalid_request' && /evidence must be an array/.test(error.message));
  assert.equal(f.assignments.list(BOT_ID, true)[0].assignmentState, 'cancelled');
});

test('a canonical stop supersedes an earlier active assessment without relying on a new chat message', t => {
  const f = fixture(t), id = f.admit('first');
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'active', summary: 'Execution underway' }, 'before-stop');
  f.cancel(id);
  assert.throws(() => f.assignments.assertOpen(id), /cancelled/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'active', summary: 'Try again' }, 'late-restart'), /newer canonical owner request/);
});

test('a dependency wakes the same unfinished assignment once, with separate resident scope', t => {
  const f = fixture(t), id = f.admit('first'), dependency = f.admit('dependency');
  f.cancel(id);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'blocked', summary: 'Waiting for the verifier', wait_for: [dependency] }, 'dependency-report');
  assert.equal(f.assignments.revisits().length, 0);
  f.cancel(dependency);
  const store = createResidentOutcomeStore(f.database);
  store.discover(); store.discover();
  assert.equal(store.pending().filter(row => row.key.startsWith('assignment-revisit:')).length, 1);
  f.database.reopen(); createResidentOutcomeStore(f.database).discover();
  assert.equal(store.pending().filter(row => row.key.startsWith('assignment-revisit:')).length, 1);
  assert.throws(() => f.assignments.report({ ...f.context, principalId: fixtureId('bot', 2) }, f.origin,
    { work_id: id, state: 'active', summary: 'Other resident' }, 'outside-scope'), /resident scope/);
});

test('changed direction requires explicit assessment; newly admitted children inherit that read without another launch attempt', t => {
  const f = fixture(t);
  f.database.mutateWithEvent(tx => {
    tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
      VALUES(?,?,2,?,'owner','Owner','text','Continue the repair; also tell me what you found.','visible',?)`, fixtureId('message', 900), CHANNEL_ID, OWNER_ID, AT);
    return { value: undefined, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: fixtureId('message', 900), aggregateVersion: 1,
      channelId: CHANNEL_ID, actorPrincipalId: OWNER_ID, requestId: fixtureId('request', 900), correlationId: fixtureId('correlation', 900), payload: {}, createdAt: AT } };
  });
  assert.throws(() => f.admit('stale'), /Owner direction changed/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: f.origin.workId, state: 'active', summary: 'Continue' }, 'missing-read'), /latest owner messages/);
  assert.throws(() => f.assignments.report(f.context, f.origin, {
    work_id: f.origin.workId, state: 'cancelled', summary: 'Retire an obsolete task', owner_message_sequence: 1,
  }, 'stale-conclusion-sequence'), (error: unknown) => error instanceof WorkError
    && error.code === 'invalid_request' && /top-level ownerMessageSequence \(2\)/.test(error.message));
  const direction = f.assignments.direction(f.origin.workId);
  f.assignments.report(f.context, f.origin, { work_id: f.origin.workId, state: 'active', summary: 'Owner asks for an update while the repair continues', owner_message_sequence: direction.ownerMessageSequence }, 'current-read');
  const id = f.admit('current');
  assert.doesNotThrow(() => f.consumer.assertCurrentDirection(id));
});

test('canonical observations reach the existing agency and preserve private tasks without a second execution owner', async t => {
  const f = fixture(t), id = f.admit('first');
  f.cancel(id);
  const directory = mkdtempSync(join(tmpdir(), 'canonical-agency-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // @ts-expect-error existing engine module is JavaScript
  const { AgencyKernel } = await import('../../../engine/src/agency/resident-kernel.js');
  // @ts-expect-error existing engine module is JavaScript
  const { reconcileCanonicalWork } = await import('../../../engine/src/agency/canonical-work.js');
  const kernel = new AgencyKernel({ brainDir: join(directory, 'brain'), agentName: 'jerry', config: { enabled: true, mode: 'dry_run' } });
  kernel.recordTask({ id: 'private-promise', summary: 'Existing resident concern' });
  const source = join(directory, 'jerry.work.json');
  projectResidentWork(f.database, directory, ['jerry']);
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 1);
  assert.equal(kernel.store.getTask(`coordination:${id}`).status, 'closed');
  const before = statSync(source).mtimeMs;
  projectResidentWork(f.database, directory, ['jerry']);
  assert.equal(statSync(source).mtimeMs, before, 'a timer tick is not progress');
  const getTask = kernel.store.getTask.bind(kernel.store);
  const getTasks = kernel.store.getTasks.bind(kernel.store);
  let taskReads = 0;
  kernel.store.getTask = (id: string) => { taskReads += 1; return getTask(id); };
  kernel.store.getTasks = (ids: string[]) => { taskReads += 1; return getTasks(ids); };
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 0);
  assert.equal(taskReads, 0, 'unchanged projection and task ledger require no task-file read');
  kernel.store.getTask = getTask;
  kernel.store.getTasks = getTasks;
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'cancelled', summary: 'Owner stopped the assignment' }, 'closed-report');
  projectResidentWork(f.database, directory, ['jerry']);
  reconcileCanonicalWork(kernel, source, 'jerry');
  assert.equal(kernel.store.getTask(`coordination:${id}`).status, 'closed');
  assert.equal(kernel.store.getTask('private-promise').status, 'open');
  assert.throws(() => reconcileCanonicalWork(kernel, source, 'forrest'), /Invalid canonical resident/);
  assert.equal(JSON.parse(readFileSync(source, 'utf8')).assignments[0].id, id);
});

test('batched resident projection retains assignment lineage and presentation states', t => {
  const f = fixture(t);
  const active = f.admit('projection-active');
  const blocked = f.admit('projection-blocked');
  f.cancel(blocked);
  f.assignments.report(f.context, f.origin, {
    work_id: blocked, state: 'blocked', summary: 'Waiting for owner direction',
  }, 'projection-blocked-report');
  const expected = f.assignments.list(BOT_ID, true, 1000);
  const actual = f.assignments.listForProjection(BOT_ID);
  assert.deepEqual(actual, expected);
  assert.equal(actual.find(row => row.id === active)?.assignmentState, 'active');
  assert.equal(actual.find(row => row.id === blocked)?.assignmentState, 'blocked');
});

test('canonical execution termination remains an open agency obligation while assignment state is not closed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-obligation-filter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // @ts-expect-error existing engine module is JavaScript
  const { AgencyKernel } = await import('../../../engine/src/agency/resident-kernel.js');
  // @ts-expect-error existing engine module is JavaScript
  const { reconcileCanonicalWork } = await import('../../../engine/src/agency/canonical-work.js');
  const kernel = new AgencyKernel({
    brainDir: join(directory, 'brain'),
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const source = join(directory, 'jerry.work.json');
  writeFileSync(source, JSON.stringify({
    schema: 'home23.resident.work.v1',
    resident: 'jerry',
    assignments: [
      { id: 'wrk_failed_terminal', title: 'Failed terminal Work', state: 'failed', assignmentState: 'failed' },
      { id: 'wrk_returned_terminal', title: 'Returned terminal Work', state: 'succeeded', assignmentState: 'returned' },
      { id: 'wrk_state_unknown', title: 'Work without known execution state', assignmentState: 'active' },
    ],
  }));

  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 3);
  const state = kernel.state();
  assert.equal(state.obligations.some((item: { taskId?: string }) => item.taskId === 'coordination:wrk_failed_terminal'), true);
  assert.equal(state.obligations.some((item: { taskId?: string }) => item.taskId === 'coordination:wrk_returned_terminal'), true);
  const unknown = state.obligations.find((item: { taskId?: string }) => item.taskId === 'coordination:wrk_state_unknown');
  assert.equal(unknown?.audience, 'self');
  assert.equal(unknown?.authorityLevel, 'unknown');
  assert.equal(kernel.store.getTask('coordination:wrk_failed_terminal').status, 'open', 'derive-time filtering does not rewrite the task store');
  kernel.store.updateTask('coordination:wrk_state_unknown', { authorityLevel: 'L2' }, {
    type: 'legacy_manufactured_authority',
    detail: { reason: 'fixture reproduces the old absence-to-L2 default' },
  });
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 1, 'authority normalization must bypass the unchanged-digest fast path');
  assert.equal(kernel.store.getTask('coordination:wrk_state_unknown').authorityLevel, 'unknown');
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 0);
});

test('canonical work skips unchanged file reads and rechecks changed files or agency tasks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-work-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // @ts-expect-error existing engine module is JavaScript
  const { reconcileCanonicalWork } = await import('../../../engine/src/agency/canonical-work.js');
  const source = join(directory, 'jerry.work.json');
  const tasks = new Map<string, { handoff: { canonicalDigest: string }; authorityLevel: string }>();
  let batchReads = 0;
  const kernel = {
    store: { getTask: (id: string) => tasks.get(id),
      getTasks: (ids: string[]) => { batchReads += 1; return new Map(ids.map(id => [id, tasks.get(id)])); },
      updateTask: (id: string, patch: Partial<{ handoff: { canonicalDigest: string }; authorityLevel: string }>) =>
        tasks.set(id, { ...tasks.get(id)!, ...patch }) },
    recordTask: (task: { id: string; handoff: { canonicalDigest: string }; authorityLevel: string }) => tasks.set(task.id, task),
    ensureState: () => {},
  };
  const projection = (title: string) => JSON.stringify({ schema: 'home23.resident.work.v1', resident: 'jerry',
    assignments: [{ id: 'wrk_cached', title, state: 'running', assignmentState: 'active' }] });
  writeFileSync(source, projection('First'));
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 1);

  const originalRead = fs.readFileSync;
  let sourceReads = 0;
  const spy = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === source) sourceReads += 1;
    return (originalRead as (...values: unknown[]) => ReturnType<typeof fs.readFileSync>)(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 0);
    assert.equal(sourceReads, 0, 'unchanged tick must not reread the projection');
    assert.equal(batchReads, 1, 'unchanged tick resolves cached tasks in one batch');

    const replacement = `${source}.next`;
    writeFileSync(replacement, projection('Second'));
    renameSync(replacement, source);
    assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 1);
    assert.equal(sourceReads, 1, 'atomic replacement must be read');

    tasks.get('coordination:wrk_cached')!.authorityLevel = 'L2';
    assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 1);
    assert.equal(sourceReads, 2, 'agency task drift must be reconciled even when the file is unchanged');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});
