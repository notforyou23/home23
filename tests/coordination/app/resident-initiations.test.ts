import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentInitiations, parseResidentInitiation, type ResidentInitiation } from '../../../src/coordination/app/resident-initiations.js';
import { createDirectMessageSubmissionService } from '../../../src/coordination/app/direct-message.js';
import { SqliteDirectMessageContext } from '../../../src/coordination/app/direct-message-context.js';
import { createResidentOutcomeStore, initiativeReviewCommunication, residentInitiativeOutcomeInstruction } from '../../../src/coordination/app/resident-outcomes.js';
import { createResidentAssignments } from '../../../src/coordination/app/resident-assignments.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { projectResidentWork } from '../../../src/coordination/app/resident-work-projection.js';
import { ResidentCoordinationAdapter, createM11ResidentCoordinationPort, type ResidentAgentPort } from '../../../src/coordination-adapter/index.js';
import { createWorkService, createProductWorkControl, M11MessageProvenanceAuthority } from '../../../src/coordination/work/index.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { SqliteMessagingRepository, SqliteBotConversationBindingAdapter } from '../../../src/coordination/channels/index.js';
import { SqliteCommunicationEventRepository } from '../../../src/coordination/communications/index.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL } from '../../../src/coordination/migrations/0019-inbox-and-reconciliation-indexes.js';
import { AT, BOT_ID, CHANNEL_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId } from '../work/test-fixture.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const request: ResidentInitiation = { initiationId: 'resident-one-move', pursuitId: 'garcia-midi', snapshotDigest: 'a'.repeat(64),
  purpose: 'exploration', nextMove: 'Explore the Garcia MIDI connection in our saved conversations.',
  stopCondition: 'Stop after checking the saved evidence and one useful connection.', evidenceRefs: ['conversation:garcia-midi'], timeoutMs: 60_000 };
const credential = { residentSlug: 'jerry', instanceId: 'resident-client', keyVersion: 1 };

function fixture(t: test.TestContext, queuedOnly = false) {
  const database = M11TestDatabase.temporary(); t.after(() => database.close());
  database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  database.raw.exec(INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL);
  database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
  const conversationId = fixtureId('conversation', 940);
  database.raw.prepare('INSERT INTO conversation_handles(id,channel_id,created_at) VALUES(?,?,?)').run(conversationId, CHANNEL_ID, AT);
  database.raw.prepare('UPDATE bots SET conversation_id=? WHERE id=?').run(conversationId, BOT_ID);
  const bot = { id: BOT_ID, principalId: BOT_ID, name: 'Jerry', purpose: 'Persistent resident', lifecycle: 'active' as const,
    conversationId, residentBinding: 'jerry', continuingIdentity: true, durableMailbox: true, requiredCapabilities: ['messages'],
    activeInstanceId: 'resident-1', activeKeyVersion: 1, residentProtocolVersion: 1, residentCapabilities: ['messages'],
    residentRegisteredAt: AT, lastHeartbeatAt: AT, reportedAvailability: 'available' as const, availability: 'available' as const,
    version: 1, createdAt: AT, updatedAt: AT };
  const directory = { listVisibleBots: async () => [bot], getBotByResidentBinding: async () => bot, resolveAlias: async () => bot };
  const repository = new SqliteMessagingRepository(database, { botConversationBinding: new SqliteBotConversationBindingAdapter(), messageProvenanceAuthorization: new M11MessageProvenanceAuthority() });
  const messages = createMessageService({ repository, participantDirectory: directory, now: () => new Date(AT) });
  const context = new SqliteDirectMessageContext(database, messages);
  const generateId = createFixtureIdGenerator(50_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const communications = new SqliteCommunicationEventRepository(database);
  let now = Date.parse(AT);
  const control = createProductWorkControl({ database, work, leases, now: () => new Date(AT) });
  const residentContext = (input: { principalId: string; requestId: string; correlationId: string }) => ({ ...input,
    identity: { kind: 'resident' as const, resident: { requestId: input.requestId, correlationId: input.correlationId,
      credential: { role: 'resident' as const, residentSlug: 'jerry', instanceId: 'resident-1', keyVersion: 1 } } } });
  const target = { serverInstanceId: 'resident-1', clientInstanceId: 'resident-client', keyVersion: 1, context: residentContext };
  let finish!: (value: { text: string; model: string; toolCallCount: number; durationMs: number }) => void;
  let fail!: (error: Error) => void;
  const response = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>((resolve, reject) => { finish = resolve; fail = reject; });
  let reviewText: string | undefined;
  let reviewAssessment: ((origin: import('../../../src/agent/types.js').CoordinationTurnOrigin) => void) | undefined;
  const turns = new Set<string>(); const instructions: string[] = []; const origins: unknown[] = [];
  const agent: ResidentAgentPort = {
    async modelCatalog() { return { models: [], defaultProvider: 'fixture', defaultModel: 'frontier', defaultReasoningEffort: 'high', reasoningEfforts: ['high'] }; },
    async runWithTurn(chatId, text, options) {
      turns.add(options.coordinationOrigin.workId); instructions.push(text); origins.push(options.coordinationOrigin);
      const turnId = `coord-${options.coordinationOrigin.workId}`;
      await options.onDurableStart({ turnId, chatId, persistedAt: AT, selection: { requestedProvider: null, requestedModelAlias: null,
        requestedModel: null, requestedEffort: null, resolvedProvider: 'fixture', resolvedModel: 'frontier', resolvedEffort: 'high',
        actualProvider: 'fixture', actualModel: 'frontier', actualEffort: 'high' } });
      if (text.startsWith('INTERNAL RESIDENT INITIATIVE OUTCOME')) {
        reviewAssessment?.(options.coordinationOrigin);
        if (reviewText !== undefined) return { turnId, response: Promise.resolve({ text: reviewText, model: 'frontier', toolCallCount: 0, durationMs: 1 }) };
      }
      return { turnId, response };
    }, stop: () => ({ stopped: true }),
  };
  const resident = new ResidentCoordinationAdapter(agent, createM11ResidentCoordinationPort(leases), () => new Date(AT), communications);
  const outcomes = createResidentOutcomeStore(database);
  let initiatives: ReturnType<typeof createResidentInitiations>;
  const service = createDirectMessageSubmissionService({ messages, context, work, leases, communications, outcomes,
    recoverInitiativeContext: work => initiatives.recover(work), residentInitiativeForWork: work => initiatives.provenance(work),
    residentInitiativeReviewAllowed: work => initiatives.reviewAllowed(work),
    resolveResident: () => ({ resident, holderInstanceId: 'resident-1', models: agent, context: residentContext }),
    authority: { current: () => ({ capability: 'messages', epoch: 3, mode: 'canonical', writer: 'home23-coordination', effectiveAtEventSequence: 1, rollbackEpoch: 1 }) },
    beginWork: () => () => {}, recoveryIdentity: () => ({ requestId: fixtureId('request', 941), correlationId: fixtureId('correlation', 941) }) });
  const submit = queuedOnly ? { async initiateResidentTurn(input: Parameters<typeof service.initiateResidentTurn>[0]) {
    const created = work.create({ principalId: input.context.principalId, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
      originMessageId: input.originMessageId, roundId: null, kind: 'resident_turn', idempotencyKey: input.idempotencyKey,
      manifest: input.prepared.manifest, maxAutomaticOffers: 1, requestId: input.context.requestId, correlationId: input.context.correlationId,
      presentation: { title: request.nextMove, summary: request.nextMove } });
    input.beforeDispatch(created.work);
    return { work: created.work, response: new Promise<never>(() => {}), replayed: created.replayed };
  } } : service;
  const make = () => createResidentInitiations({ database, primaryResident: 'jerry', messages, context, submit, work,
    resolveResident: slug => slug === 'jerry' ? target : undefined, now: () => now,
    expireWork: workId => { control.cancel({ context: residentContext({ principalId: BOT_ID, requestId: fixtureId('request', 943), correlationId: fixtureId('correlation', 943) }), workId, idempotencyKey: 'expired' }); } });
  initiatives = make();
  const owner = { principalId: 'user_owner', requestId: fixtureId('request', 942), correlationId: fixtureId('correlation', 942),
    identity: { kind: 'owner' as const, auth: { principalId: 'user_owner' as const, deviceId: 'dev_0198d95f-6c00-7000-8000-000000000942', sessionId: 'ses_0198d95f-6c00-7000-8000-000000000942', scopes: ['product:read', 'message:send'] as const } } };
  return { database, messages, work, service, initiatives, make, owner, context, control, outcomes, turns, instructions, origins, residentContext,
    assignments: createResidentAssignments(database), finish, fail, reviewWithText: (text: string) => { reviewText = text; }, assessReview: (callback: typeof reviewAssessment) => { reviewAssessment = callback; },
    advance: (ms: number) => { now += ms; } };
}

test('only bounded intent fields are admitted; caller identity, channel, and authority are rejected', () => {
  assert.deepEqual(parseResidentInitiation(request), request);
  for (const extra of [{ channelId: CHANNEL_ID }, { principalId: 'user_owner' }, { permissions: ['all'] }, { timeoutMs: 900_001 }, { snapshotDigest: 'clock-time' }, { evidenceRefs: [] }, { purpose: ['exploration'] }, { purpose: {} }, { reasoningEffort: 'impossible' }]) {
    assert.throws(() => parseResidentInitiation({ ...request, ...extra }), (error: any) => error.code === 'request_invalid');
  }
});

test('signed initiative enters canonical Work with a real resident origin; replay/busy/restart preserve it', async t => {
  const f = fixture(t);
  await assert.rejects(f.initiatives.run({ ...credential, instanceId: 'stale' }, request));
  await assert.rejects(f.initiatives.run({ ...credential, residentSlug: 'forrest' }, request));
  assert.equal(f.database.readAll('SELECT id FROM works').length, 0);
  const beforeStatus = f.database.readOne<{ count: number }>('SELECT count(*) AS count FROM events')!.count;
  assert.deepEqual(f.initiatives.status(credential, { initiationId: request.initiationId }), { initiationId: request.initiationId, state: 'not_admitted' });
  assert.equal(f.database.readOne<{ count: number }>('SELECT count(*) AS count FROM events')!.count, beforeStatus);
  assert.throws(() => f.initiatives.status(credential, { initiationId: request.initiationId, channelId: CHANNEL_ID }));
  assert.throws(() => f.initiatives.status({ ...credential, instanceId: 'stale' }, { initiationId: request.initiationId }));
  const first = await f.initiatives.run(credential, request);
  assert.ok(first.workId); await new Promise(resolve => setImmediate(resolve));
  const work = f.work.get(first.workId!)!;
  assert.equal(f.initiatives.status(credential, { initiationId: request.initiationId }).workId, work.id);
  assert.equal(work.principalId, BOT_ID); assert.equal(work.kind, 'resident_turn');
  assert.match(f.instructions[0]!, /not a new owner request/);
  const origin = await f.messages.getMessage({ context: f.owner, messageId: work.originMessageId! });
  assert.equal(origin?.author.principalId, BOT_ID); assert.equal(origin?.text, request.nextMove);
  assert.doesNotMatch(origin!.text!, /INTERNAL|snapshotDigest/);
  const replay = await f.initiatives.run(credential, request);
  assert.equal(replay.workId, work.id); assert.equal(f.turns.size, 1);
  await assert.rejects(f.initiatives.run(credential, { ...request, nextMove: 'Changed move' }));
  const busy = await f.initiatives.run(credential, { ...request, initiationId: 'different' });
  assert.equal(busy.state, 'deferred'); assert.equal(f.database.readAll('SELECT id FROM works').length, 1);
  const restored = f.make(); const recovered = await restored.recover(work);
  assert.equal(recovered?.prepared.instruction, f.instructions[0]); assert.deepEqual(recovered?.prepared.residentInitiative, request);
  const afterLostAck = await restored.run(credential, request); assert.equal(afterLostAck.workId, work.id); assert.equal(f.turns.size, 1);
  const product = f.control.list({ context: f.owner }).works[0]!;
  assert.equal(product.id, work.id); assert.equal(product.origin, 'resident_initiative'); assert.equal(product.purpose, 'exploration');
  assert.equal(product.assignmentState, undefined); assert.equal(product.cancelAvailable, true);
  const projectionDirectory = mkdtempSync(join(tmpdir(), 'home23-initiative-projection-')); t.after(() => rmSync(projectionDirectory, { recursive: true }));
  projectResidentWork(f.database, projectionDirectory, ['jerry']);
  const shown = JSON.parse(readFileSync(join(projectionDirectory, 'jerry.work.json'), 'utf8')).assignments[0];
  assert.equal(shown.origin, 'resident_initiative'); assert.equal(shown.originalRequest, undefined); assert.equal(shown.assignmentState, undefined);
  f.finish({ text: 'The saved MIDI connection is useful.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(work.id); f.outcomes.discover({ startup: true });
  const outcome = f.outcomes.pending()[0]!; assert.equal(outcome.key, `initiative:${work.id}`);
  assert.equal(JSON.parse(outcome.evidence).provenance, 'resident_initiative');
  assert.match(residentInitiativeOutcomeInstruction(request, outcome.evidence, work.id), /not an owner-requested assignment/);
});

test('queued Stop, deadline, and lost journal acknowledgement stay on the original Work', async t => {
  const f = fixture(t, true);
  const first = await f.initiatives.run(credential, { ...request, purpose: 'action' });
  const work = f.work.get(first.workId!)!;
  f.control.cancel({ context: f.owner, workId: work.id, idempotencyKey: 'explicit-stop' });
  assert.equal((await f.make().run(credential, { ...request, purpose: 'action' })).state, 'cancelled');
  assert.equal(f.database.readAll('SELECT id FROM works').length, 1); assert.equal(f.turns.size, 0);
  const second = await f.initiatives.run(credential, { ...request, initiationId: 'deadline', timeoutMs: 10 });
  f.advance(20); f.initiatives.reconcile();
  assert.equal(f.work.get(second.workId!)!.state, 'cancelled');
  assert.equal((await f.make().run(credential, { ...request, initiationId: 'deadline', timeoutMs: 10 })).workId, second.workId);
});

test('missing or changed canonical owner pair and mutable membership fail closed', async t => {
  const f = fixture(t, true);
  f.database.raw.prepare('UPDATE bots SET conversation_id=NULL WHERE id=?').run(BOT_ID);
  await assert.rejects(f.initiatives.run(credential, request));
  assert.equal(f.database.readAll('SELECT id FROM works').length, 0);
});

test('action initiative and its actual child share accountability; verification and dependency revisits retain initiative provenance', async t => {
  const f = fixture(t);
  const input = { ...request, purpose: 'action' as const };
  const first = await f.initiatives.run(credential, input); await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  const identity = { requestId: fixtureId('request', 960), correlationId: fixtureId('correlation', 960) };
  const context = f.residentContext({ principalId: BOT_ID, ...identity });
  const detach = createForegroundDetachmentConsumer({ database: f.database, work: f.work, now: () => new Date(AT), schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'resident-client', serverInstanceId: 'resident-1', keyVersion: 1 }) });
  const child = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: 'verify-initiative',
    toolName: 'spawn_agent', canonicalArgs: { task: 'Inspect the saved notes' }, executionInstruction: 'Inspect the saved notes',
    title: 'Inspect notes', summary: 'Inspect useful evidence', recoveryPolicy: 'safe_before_start' } });
  assert.equal(f.assignments.root(child.workId), first.workId);
  assert.deepEqual(f.initiatives.provenance(f.work.get(child.workId)!), input);
  assert.throws(() => f.assignments.report(context, origin, { work_id: first.workId, state: 'complete', summary: 'Premature', evidence: ['uninspected'] }, 'premature'), /active execution/);
  const revisitAt = Date.now() + 60_000;
  f.assignments.report(context, origin, { work_id: first.workId, state: 'blocked', summary: 'Revisit the inspected notes', revisit_at: new Date(revisitAt).toISOString() }, 'wait-notes');
  f.work.cancelQueued({ workId: child.workId, actorPrincipalId: BOT_ID, reasonCode: 'fixture_stop', sourceReference: 'fixture:stop', timestamp: AT, ...identity });
  t.mock.method(Date, 'now', () => revisitAt + 1);
  const revisit = f.assignments.revisits(true).find(row => row.workId === first.workId); assert.ok(revisit);
  f.outcomes.discover();
  assert.ok(f.outcomes.pending().some(row => row.key.startsWith(`assignment-revisit:${first.workId}:`)));
  f.assignments.report(context, origin, { work_id: first.workId, state: 'complete', summary: 'Inspected the bounded result', evidence: ['saved:notes'] }, 'complete-notes');
  const saved = f.assignments.list(BOT_ID, true)[0]!;
  assert.equal(saved.origin, 'resident_initiative'); assert.equal(saved.originalRequest, undefined); assert.equal(saved.assignmentState, 'complete');
  f.finish({ text: 'I inspected the saved notes.', model: 'frontier', toolCallCount: 0, durationMs: 1 }); await f.service.awaitSettlement(first.workId!);
  f.assessReview(reviewOrigin => f.assignments.report(context, reviewOrigin, { work_id: first.workId, state: 'complete', summary: 'Outcome review inspected the saved notes', evidence: ['saved:notes'] }, `review:${reviewOrigin.workId}`));
  await f.service.processResidentOutcomes();
  for (const outcome of f.outcomes.pending()) if (outcome.reviewWorkId) await f.service.awaitSettlement(outcome.reviewWorkId);
  assert.ok(f.instructions.some(text => text.startsWith('INTERNAL RESIDENT INITIATIVE OUTCOME')));
  assert.equal(f.assignments.latest(first.workId!)!.summary, 'Outcome review inspected the saved notes');
  const preparedReviews = f.database.readAll<{ prepared: string }>('SELECT prepared_json AS prepared FROM resident_outcomes WHERE prepared_json IS NOT NULL');
  assert.ok(preparedReviews.length);
  for (const row of preparedReviews) { const prepared = JSON.parse(row.prepared); assert.equal(prepared.originalOwnerRequest, undefined); assert.equal(prepared.residentInitiative.purpose, 'action'); }
});

test('initiative deadline and exclusivity follow a detached child after the resident root returns', async t => {
  const f = fixture(t);
  const input = { ...request, purpose: 'action' as const, timeoutMs: 100 };
  const first = await f.initiatives.run(credential, input); await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  const detach = createForegroundDetachmentConsumer({ database: f.database, work: f.work, now: () => new Date(AT), schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'resident-client', serverInstanceId: 'resident-1', keyVersion: 1 }) });
  const child = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: 'held-child',
    toolName: 'spawn_agent', canonicalArgs: { task: 'Inspect the saved notes' }, executionInstruction: 'Inspect the saved notes',
    title: 'Inspect notes', summary: 'Inspect useful evidence', recoveryPolicy: 'safe_before_start' } });
  f.finish({ text: 'The inspection is continuing.', model: 'frontier', toolCallCount: 1, durationMs: 1 }); await f.service.awaitSettlement(first.workId!);
  assert.equal(f.work.get(first.workId!)!.state, 'succeeded');
  const busy = await f.initiatives.run(credential, { ...input, initiationId: 'another-action' }); assert.equal(busy.state, 'deferred');
  f.advance(101);
  await f.service.recoverResidentWork(); await f.service.dispatchWorkingThread(child.workId);
  assert.equal(f.turns.size, 1, 'startup and attestation recovery cannot resume an expired descendant before the cancellation sweep');
  const restarted = f.make(); restarted.reconcile();
  assert.equal(f.work.get(child.workId)!.state, 'cancelled');
  assert.equal(restarted.reviewAllowed(f.work.get(first.workId!)!), false);
  await f.service.processResidentOutcomes();
  assert.equal(f.database.readAll('SELECT id FROM works').length, 2, 'expired initiative does not admit another follow-through executor');
});

test('a returned initiative retains capacity before outcome discovery and until its honest assessment settles', async t => {
  const f = fixture(t);
  const first = await f.initiatives.run(credential, request); await new Promise(resolve => setImmediate(resolve));
  f.finish({ text: 'The saved connection is useful.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!);
  assert.equal(f.database.readAll('SELECT outcome_key FROM resident_outcomes').length, 0);
  const next = { ...request, initiationId: 'next-after-assessment' };
  assert.equal((await f.make().run(credential, next)).state, 'deferred', 'restart retains the discovery gap');
  f.outcomes.discover({ startup: true });
  assert.equal((await f.initiatives.run(credential, next)).state, 'deferred', 'pending review retains the responsibility');
  await f.service.processResidentOutcomes();
  const outcome = f.outcomes.pending().find(row => row.key === `initiative:${first.workId}`)!;
  assert.ok(outcome.reviewWorkId); await f.service.awaitSettlement(outcome.reviewWorkId!);
  await f.service.processResidentOutcomes();
  const admitted = await f.initiatives.run(credential, next);
  assert.ok(admitted.workId); assert.notEqual(admitted.workId, first.workId);
  assert.equal(f.assignments.latest(first.workId!), null, 'exploration settles without inventing an assignment');
  await f.service.awaitSettlement(admitted.workId!);
});

for (const reviewText of ['', '(no response)']) test(`an inspected initiative review can settle privately without another owner message: ${JSON.stringify(reviewText)}`, async t => {
  const f = fixture(t);
  const first = await f.initiatives.run(credential, request); await new Promise(resolve => setImmediate(resolve));
  f.finish({ text: 'The guitar notes support a useful connection.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!);
  f.reviewWithText(reviewText); await f.service.processResidentOutcomes();
  const review = f.outcomes.pending().find(row => row.key === `initiative:${first.workId}`)!;
  assert.ok(review.reviewWorkId); await f.service.awaitSettlement(review.reviewWorkId!);
  assert.equal(f.work.get(review.reviewWorkId!)!.state, 'succeeded', 'inspection executed with an ordinary terminal receipt');
  assert.equal(f.outcomes.pending().length, 0);
  assert.equal(f.database.readOne<{ count: number }>('SELECT count(*) AS count FROM messages WHERE work_id=?', review.reviewWorkId!)!.count, 0);
  const disposition = f.database.readOne<{ payload: string }>("SELECT payload_json AS payload FROM events WHERE aggregate_kind='resident_outcome' AND aggregate_id=? ORDER BY aggregate_version DESC LIMIT 1", review.key)!;
  assert.equal(JSON.parse(disposition.payload).ownerContactDisposition, 'no_owner_update');
  assert.equal(JSON.parse(disposition.payload).reason, 'already_delivered_result_sufficient');
  assert.equal(JSON.parse(disposition.payload).reviewWorkId, review.reviewWorkId);
  const activity: import('../../../src/coordination/communications/types.js').AppendCommunicationEventInput = {
    requestId: fixtureId('request', 997), correlationId: fixtureId('correlation', 997), event: {
      conversationId: fixtureId('conversation', 940), channelId: CHANNEL_ID, workId: review.reviewWorkId,
      messageId: `msg_${review.reviewWorkId!.slice(4)}`, actor: { principalId: BOT_ID, displayName: 'Jerry', kind: 'resident_bot' },
      source: { system: 'provider', sourceEventType: 'agent.response_chunk' }, kind: 'assistant_response_delta', occurredAt: AT, terminal: false,
      payload: { residentEventSequence: 7, delta: '(no response)', rawEvent: { type: 'response_chunk', chunk: '(no response)' } } } };
  const privateActivity = initiativeReviewCommunication(f.database, activity);
  assert.equal(privateActivity.event.kind, 'receipt'); assert.equal(privateActivity.event.payload.delta, undefined);
  assert.deepEqual(privateActivity.event.payload.rawEvent, activity.event.payload.rawEvent, 'lossless synthetic event and resident sequence remain evidence');
  assert.equal(privateActivity.event.payload.residentEventSequence, 7); assert.equal(privateActivity.event.terminal, false);
  assert.equal(initiativeReviewCommunication(f.database, { ...activity, event: { ...activity.event, workId: first.workId! } }).event.kind, 'assistant_response_delta', 'a real resident origin is not an outcome review');
  assert.equal(initiativeReviewCommunication(f.database, { ...activity, event: { ...activity.event, source: { ...activity.event.source, sourceEventType: 'content_block_delta.text_delta' } } }).event.kind, 'assistant_response_delta', 'literal provider text retains its ordinary activity');
  const reloaded = createResidentOutcomeStore(f.database); reloaded.discover({ startup: true });
  assert.equal(reloaded.pending().length, 0);
  const turns = f.turns.size;
  await f.service.recoverResidentWork(); await f.service.processResidentOutcomes();
  assert.equal(f.turns.size, turns, 'settled quiet inspection is not repeated or converted into a missing-result retry');
  assert.equal(f.assignments.latest(first.workId!), null);
  assert.doesNotMatch(f.instructions.find(text => text.startsWith('INTERNAL RESIDENT INITIATIVE OUTCOME'))!, /explain that briefly/);
});

for (const failedSource of [false, true]) test(`a quiet request cannot hide an unassessed action or failed initiative: failed=${failedSource}`, async t => {
  const f = fixture(t);
  const first = await f.initiatives.run(credential, { ...request, purpose: 'action' }); await new Promise(resolve => setImmediate(resolve));
  if (failedSource) f.fail(new Error('fixture execution failed'));
  else f.finish({ text: 'I returned before inspecting the action outcome.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!);
  assert.equal(f.work.get(first.workId!)!.state, failedSource ? 'failed' : 'succeeded');
  f.reviewWithText(''); await f.service.processResidentOutcomes();
  const review = f.outcomes.pending().find(row => row.key === `initiative:${first.workId}`)!;
  assert.ok(review.reviewWorkId); await f.service.awaitSettlement(review.reviewWorkId!);
  const message = f.database.readOne<{ text: string }>('SELECT body_text AS text FROM messages WHERE work_id=?', review.reviewWorkId!)!;
  assert.match(message.text, /could not confirm.*ready to close/);
  assert.equal(f.database.readAll("SELECT sequence FROM events WHERE aggregate_kind='resident_outcome' AND json_extract(payload_json,'$.ownerContactDisposition')='no_owner_update'").length, 0);
  assert.equal(f.assignments.latest(first.workId!), null, 'quiet does not invent completion or inspected evidence');
  await f.service.processResidentOutcomes(); assert.equal(f.outcomes.pending().length, 0);
});

test('action review can stay quiet only after its accepted inspected assessment; the result remains delivered', async t => {
  const f = fixture(t);
  const first = await f.initiatives.run(credential, { ...request, purpose: 'action' }); await new Promise(resolve => setImmediate(resolve));
  f.finish({ text: 'I verified the saved notes.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!);
  f.reviewWithText(''); f.assessReview(origin => f.assignments.report(f.residentContext({ principalId: BOT_ID,
    requestId: fixtureId('request', 998), correlationId: fixtureId('correlation', 998) }), origin,
    { work_id: first.workId, state: 'complete', summary: 'Inspected the saved notes', evidence: ['saved:notes'] }, 'quiet-inspected-assessment'));
  await f.service.processResidentOutcomes();
  const review = f.outcomes.pending()[0]!; await f.service.awaitSettlement(review.reviewWorkId!);
  assert.equal(f.outcomes.pending().length, 0); assert.equal(f.assignments.latest(first.workId!)!.state, 'complete');
  assert.equal(f.control.get({ context: f.owner, workId: first.workId! }).finalResultMessageId, `msg_${first.workId!.slice(4)}`);
  assert.equal(f.database.readOne<{ count: number }>('SELECT count(*) AS count FROM messages WHERE work_id=?', review.reviewWorkId!)!.count, 0);
});

for (const ordinaryText of ['', '(no response)']) test(`ordinary owner answers retain their existing delivery rule: ${JSON.stringify(ordinaryText)}`, async t => {
  const f = fixture(t);
  const accepted = await f.service.submitMessage({ context: f.owner, channelId: CHANNEL_ID, idempotencyKey: 'ordinary-answer-rule', body: {
    messageId: fixtureId('message', 999), clientMessageId: 'owner-ordinary', text: 'Check these notes', attachmentIds: [], mentions: [], replyToMessageId: null, modelAlias: null, reasoningEffort: null } });
  f.finish({ text: ordinaryText, model: 'frontier', toolCallCount: 0, durationMs: 1 });
  if (!ordinaryText) await assert.rejects(accepted.response, /produced no answer/);
  else assert.equal((await accepted.response).text, ordinaryText);
  assert.equal(f.database.readAll("SELECT sequence FROM events WHERE aggregate_kind='resident_outcome' AND json_extract(payload_json,'$.ownerContactDisposition')='no_owner_update'").length, 0);
});

test('initiative recovery and descendant expiry seek indexed roots among unrelated Work history', async t => {
  const f = fixture(t);
  const first = await f.initiatives.run(credential, { ...request, purpose: 'action', timeoutMs: 100 });
  await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  const detach = createForegroundDetachmentConsumer({ database: f.database, work: f.work, now: () => new Date(AT), schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'resident-client', serverInstanceId: 'resident-1', keyVersion: 1 }) });
  const child = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: 'indexed-child',
    toolName: 'spawn_agent', canonicalArgs: { task: 'Inspect notes' }, executionInstruction: 'Inspect notes',
    title: 'Inspect notes', summary: 'Inspect the actual connection', recoveryPolicy: 'safe_before_start' } });
  const work = f.work.get(first.workId!)!;
  const manifest = (await f.initiatives.recover(work))!.prepared.manifest;
  for (let index = 0; index < 256; index++) f.work.create({ principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: work.originMessageId, roundId: null, kind: 'resident_turn', idempotencyKey: `unrelated-history-${index}`,
    manifest,
    maxAutomaticOffers: 1, requestId: fixtureId('request', 996), correlationId: fixtureId('correlation', 996) });
  f.finish({ text: 'The actual inspection is continuing.', model: 'frontier', toolCallCount: 1, durationMs: 1 });
  await f.service.awaitSettlement(work.id);
  const original = f.database.readAll.bind(f.database); const plans: string[] = [];
  f.database.readAll = <T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T[] => {
    if (sql.includes('WITH RECURSIVE lineage(id,depth,path)') || sql.includes("aggregate_id>? AND aggregate_id < 'resident-initiation;'")) {
      plans.push(...f.database.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map(row => String((row as { detail: string }).detail)));
    }
    return original<T>(sql, ...parameters);
  };
  f.advance(101); f.make().reconcile();
  assert.equal(f.work.get(child.workId)!.state, 'cancelled');
  assert.ok(plans.some(detail => detail.includes('work_planned_invocations_parent')), plans.join('; '));
  assert.ok(plans.some(detail => detail.includes('resident_outcomes_source_created')), plans.join('; '));
  assert.ok(plans.some(detail => detail.includes('SEARCH w USING INDEX') && detail.includes('(id=?)')), plans.join('; '));
  assert.ok(plans.some(detail => detail.includes('events_aggregate_sequence') && detail.includes('aggregate_id>?')), plans.join('; '));
  assert.equal(plans.some(detail => /SCAN (?:w|child|events)\b/.test(detail)), false, plans.join('; '));
});

test('owner reaches the actual active child in ordinary Work; Stop cannot be overwritten or continued through the initiative root', async t => {
  const f = fixture(t);
  const input = { ...request, purpose: 'action' as const };
  const first = await f.initiatives.run(credential, input); await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  const detach = createForegroundDetachmentConsumer({ database: f.database, work: f.work, now: () => new Date(AT), schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'resident-client', serverInstanceId: 'resident-1', keyVersion: 1 }) });
  const child = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: 'owner-reachable-child',
    toolName: 'spawn_agent', canonicalArgs: { task: 'Inspect the saved notes' }, executionInstruction: 'Inspect the saved notes',
    title: 'Inspect notes', summary: 'Inspect useful evidence', recoveryPolicy: 'safe_before_start' } });
  f.finish({ text: 'The inspection is continuing.', model: 'frontier', toolCallCount: 1, durationMs: 1 }); await f.service.awaitSettlement(first.workId!);
  const rows = f.control.list({ context: f.owner }).works;
  const actual = rows.find(row => row.id === child.workId)!; const returned = rows.find(row => row.id === first.workId)!;
  assert.ok(actual); assert.equal(actual.cancelAvailable, true); assert.equal(actual.state, 'queued');
  assert.equal(actual.channelId, returned.channelId); assert.equal(actual.conversationId, returned.conversationId);
  assert.equal(actual.originMessageId, returned.originMessageId); assert.equal(returned.state, 'succeeded');
  const result = f.control.cancel({ context: f.owner, workId: child.workId, idempotencyKey: 'owner-child-stop' });
  assert.equal(result.outcome, 'cancelled'); assert.equal(f.work.get(first.workId!)!.state, 'succeeded', 'executor success is retained as a distinct fact');
  assert.equal(f.control.get({ context: f.owner, workId: first.workId! }).assignmentState, 'cancelled');
  assert.throws(() => f.assignments.assertOpen(first.workId!), /stopped/);
  assert.throws(() => f.assignments.report(f.residentContext({ principalId: BOT_ID, requestId: fixtureId('request', 990), correlationId: fixtureId('correlation', 990) }), origin,
    { work_id: first.workId, state: 'complete', summary: 'Late claim', evidence: ['late:evidence'] }, 'late-owner-stop-claim'), /cannot overwrite Stop/);
  const restarted = f.make(); restarted.reconcile();
  assert.equal(restarted.reviewAllowed(f.work.get(child.workId)!), false);
  await f.service.processResidentOutcomes();
  assert.equal(f.database.readAll('SELECT id FROM works').length, 2);
  assert.equal((await restarted.run(credential, input)).workId, first.workId);
});
