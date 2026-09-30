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
import { SqliteCommunicationEventRepository, stableCommunicationEventId } from '../../../src/coordination/communications/index.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL } from '../../../src/coordination/migrations/0019-inbox-and-reconciliation-indexes.js';
import { COMMUNICATION_EVIDENCE_INDEX_MIGRATION_SQL } from '../../../src/coordination/migrations/0008-communication-evidence-indexes.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const request: ResidentInitiation = { initiationId: 'resident-one-move', pursuitId: 'garcia-midi', snapshotDigest: 'a'.repeat(64),
  purpose: 'exploration', nextMove: 'Explore the Garcia MIDI connection in our saved conversations.',
  stopCondition: 'Stop after checking the saved evidence and one useful connection.', evidenceRefs: ['conversation:garcia-midi'], timeoutMs: 60_000 };
const credential = { residentSlug: 'jerry', instanceId: 'resident-client', keyVersion: 1 };

function fixture(t: test.TestContext, queuedOnly = false, replay = true) {
  const database = M11TestDatabase.temporary(); t.after(() => { database.close(); rmSync(dirname(database.path), { recursive: true, force: true }); });
  database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  database.raw.exec(INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL);
  if (!replay) database.raw.exec(COMMUNICATION_EVIDENCE_INDEX_MIGRATION_SQL);
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
  const outcomes = createResidentOutcomeStore(database, { replay, primaryResident: 'jerry' });
  let initiatives: ReturnType<typeof createResidentInitiations>;
  const makeService = (store = outcomes) => createDirectMessageSubmissionService({ messages, context, work, leases, communications, outcomes: store,
    recoverInitiativeContext: work => initiatives.recover(work), residentInitiativeForWork: work => initiatives.provenance(work),
    residentInitiativeReviewAllowed: work => initiatives.reviewAllowed(work),
    resolveResident: () => ({ resident, holderInstanceId: 'resident-1', models: agent, context: residentContext }),
    authority: { current: () => ({ capability: 'messages', epoch: 3, mode: 'canonical', writer: 'home23-coordination', effectiveAtEventSequence: 1, rollbackEpoch: 1 }) },
    beginWork: () => () => {}, recoveryIdentity: () => ({ requestId: fixtureId('request', 941), correlationId: fixtureId('correlation', 941) }) });
  const service = makeService();
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
  return { database, messages, work, leases, communications, service, makeService, initiatives, make, owner, context, control, outcomes, turns, instructions, origins, residentContext,
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

for (const replay of [true, false]) test(`action initiative and its actual child share accountability; verification and dependency revisits retain initiative provenance; replay=${replay}`, async t => {
  const f = fixture(t, false, replay);
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

for (const replay of [true, false]) for (const failedSource of [false, true]) test(`a quiet request cannot hide an unassessed action or failed initiative: failed=${failedSource}; replay=${replay}`, async t => {
  const f = fixture(t, false, replay);
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

for (const replay of [true, false]) test(`action review can stay quiet only after its accepted inspected assessment; the result remains delivered; replay=${replay}`, async t => {
  const f = fixture(t, false, replay);
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

for (const replay of [true, false]) test(`owner reaches the actual active child in ordinary Work; Stop cannot be overwritten or continued through the initiative root; replay=${replay}`, async t => {
  const f = fixture(t, false, replay);
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

test('paused replay verifies a new initiative past 100001 unrelated events and old pending rows without advancing legacy history', async t => {
  const f = fixture(t, false, false);
  t.mock.method(Date, 'now', () => Date.parse(AT));
  const identity = { requestId: fixtureId('request', 1200), correlationId: fixtureId('correlation', 1200) };
  const legacy = f.work.create({ principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: 'paused-legacy-parent',
    manifest: manifestInput(), maxAutomaticOffers: 1, ...identity }).work;
  f.work.cancelQueued({ workId: legacy.id, actorPrincipalId: BOT_ID, reasonCode: 'fixture_stop', sourceReference: 'fixture:history', timestamp: AT, ...identity });
  for (let n = 0; n < 41; n++) f.outcomes.enqueue(`legacy:${n}`, legacy.id, { saved: `historical evidence ${n}` });
  const oldRows = f.database.readAll('SELECT * FROM resident_outcomes ORDER BY outcome_key');
  const oldPolicy = f.database.readOne('SELECT * FROM resident_outcome_policy');
  const insert = f.database.raw.prepare(`INSERT INTO events(id,schema_version,type,durability,aggregate_kind,aggregate_id,aggregate_version,
    channel_id,actor_principal_id,request_id,correlation_id,payload_json,payload_digest,created_at)
    VALUES (?,1,'communication.recorded','durable','communication',?,1,NULL,NULL,?,? ,?, ?,?)`);
  const payload = JSON.stringify({ communication: { conversationId: fixtureId('conversation', 1201) } });
  f.database.raw.transaction(() => {
    for (let n = 0; n < 100001; n++) insert.run(fixtureId('event', 1000000 + n), `unrelated:${n}`, identity.requestId, identity.correlationId, payload, 'a'.repeat(64), AT);
  })();
  const first = await f.initiatives.run(credential, request); await new Promise(resolve => setImmediate(resolve));
  f.finish({ text: 'The saved notes support this useful connection.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!);
  const readAll = f.database.readAll.bind(f.database), readOne = f.database.readOne.bind(f.database);
  const plans: string[] = []; let legacyCursorReads = 0;
  function inspect(sql: string, values: Array<string | number | bigint | Buffer | null>) {
    if (sql.includes('FROM events WHERE sequence > ? ORDER BY sequence LIMIT 16')) legacyCursorReads++;
    if (sql.includes("aggregate_kind='resident_initiation_work'") || sql.includes('WHERE parent_work_id=?') ||
        sql.includes('WHERE source_work_id=?') || sql.includes("communication.conversationId')=?")) {
      plans.push(...f.database.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => String((row as { detail: string }).detail)));
    }
  }
  f.database.readAll = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T[] => { inspect(sql, values); return readAll<T>(sql, ...values); };
  f.database.readOne = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T | undefined => { inspect(sql, values); return readOne<T>(sql, ...values); };
  f.reviewWithText(''); await f.service.processResidentOutcomes();
  const review = f.database.readOne<{ id: string }>('SELECT review_work_id AS id FROM resident_outcomes WHERE outcome_key=?', `initiative:${first.workId}`)!;
  assert.ok(review.id, 'the new result reaches verification on the first ordinary pump');
  await f.service.awaitSettlement(review.id);
  assert.equal(f.turns.size, 2); assert.equal(f.assignments.latest(first.workId!), null, 'exploration does not acquire an invented action assessment');
  const reloaded = createResidentOutcomeStore(f.database, { replay: false, primaryResident: 'jerry' });
  reloaded.discover({ startup: true });
  const recovered = f.makeService(reloaded);
  for (let tick = 0; tick < 4; tick++) await recovered.processResidentOutcomes();
  assert.equal(f.turns.size, 2, 'settled quiet review is not repeated after restart');
  assert.deepEqual(f.database.readAll("SELECT * FROM resident_outcomes WHERE outcome_key LIKE 'legacy:%' ORDER BY outcome_key"), oldRows);
  assert.deepEqual(f.database.readOne('SELECT * FROM resident_outcome_policy'), oldPolicy);
  assert.equal(legacyCursorReads, 0, 'the paused event cursor is neither consumed nor moved');
  assert.ok(plans.some(plan => /SEARCH events USING COVERING INDEX sqlite_autoindex_events_\d+ \(aggregate_kind=\? AND aggregate_id>\?\)/.test(plan)), [...new Set(plans)].join('; '));
  assert.ok(plans.some(plan => plan.includes('work_planned_invocations_parent')), plans.join('; '));
  assert.ok(plans.some(plan => plan.includes('resident_outcomes_source_created')), plans.join('; '));
  assert.ok(plans.some(plan => plan.includes('communication_events_conversation_sequence')), plans.join('; '));
  assert.equal(plans.some(plan => /SCAN (?:e|events|work_planned_invocations|resident_outcomes)\b/.test(plan)), false, plans.join('; '));
});

test('paused root recovery paginates stopped and expired initiatives after restart without any new execution', async t => {
  const f = fixture(t, true, false);
  const ids: string[] = [];
  for (let n = 0; n < 7; n++) {
    const first = await f.initiatives.run(credential, { ...request, initiationId: `closed-root-${n}`, timeoutMs: 10 });
    ids.push(first.workId!);
    if (n % 2) { f.advance(11); f.initiatives.reconcile(); }
    else f.control.cancel({ context: f.owner, workId: first.workId!, idempotencyKey: `closed-stop-${n}` });
  }
  const policy = f.database.readOne('SELECT * FROM resident_outcome_policy');
  const reloaded = createResidentOutcomeStore(f.database, { replay: false, primaryResident: 'jerry' });
  const service = f.makeService(reloaded);
  for (let tick = 0; tick < 40; tick++) await service.processResidentOutcomes();
  const rows = f.database.readAll<{ id: string; settled: string | null; review: string | null }>('SELECT source_work_id AS id,settled_at AS settled,review_work_id AS review FROM resident_outcomes');
  assert.deepEqual(rows.map(row => row.id).sort(), ids.sort());
  assert.ok(rows.every(row => row.settled !== null && row.review === null));
  assert.equal(f.turns.size, 0); assert.deepEqual(f.database.readOne('SELECT * FROM resident_outcome_policy'), policy);
});

test('a cached paused initiative walk loses eligibility when its canonical primary conversation changes', async t => {
  const f = fixture(t, true, false);
  const first = await f.initiatives.run(credential, request);
  f.outcomes.discover();
  f.database.raw.prepare('UPDATE bots SET conversation_id=NULL WHERE id=?').run(BOT_ID);
  f.control.cancel({ context: f.owner, workId: first.workId!, idempotencyKey: 'changed-primary-stop' });
  f.outcomes.discover(); await f.service.processResidentOutcomes();
  assert.equal(f.database.readAll('SELECT outcome_key FROM resident_outcomes').length, 0);
  assert.equal(f.turns.size, 0);
});

test('paused lineage walks use a fixed edge budget, preserve a wide real family and notice a new child immediately', async t => {
  const f = fixture(t, false, false);
  t.mock.method(Date, 'now', () => Date.parse(AT));
  const first = await f.initiatives.run(credential, { ...request, purpose: 'action' }); await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  const detach = createForegroundDetachmentConsumer({ database: f.database, work: f.work, now: () => new Date(AT), schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'resident-client', serverInstanceId: 'resident-1', keyVersion: 1 }) });
  const identity = { requestId: fixtureId('request', 1300), correlationId: fixtureId('correlation', 1300) };
  function child(index: number) {
    const admitted = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: `wide-${index}`,
      toolName: 'spawn_agent', canonicalArgs: { task: `Inspect note ${index}` }, executionInstruction: `Inspect note ${index}`,
      title: 'Inspect notes', summary: 'Inspect actual evidence', recoveryPolicy: 'safe_before_start' } });
    f.work.cancelQueued({ workId: admitted.workId, actorPrincipalId: BOT_ID, reasonCode: 'fixture_stop', sourceReference: 'fixture:child-result', timestamp: AT, ...identity });
    return admitted.workId;
  }
  const ids = Array.from({ length: 70 }, (_, index) => child(index));
  const original = f.database.readOne.bind(f.database); let reads = 0;
  f.database.readOne = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T | undefined => {
    if (sql.includes('WHERE parent_work_id=?') || (sql.includes('review_work_id AS id') && sql.includes('WHERE source_work_id=?'))) reads++;
    return original<T>(sql, ...values);
  };
  function tick() { reads = 0; f.outcomes.discover(); assert.ok(reads <= 33, `edge reads exceeded fixed budget: ${reads}`); }
  tick();
  assert.ok(f.database.readAll("SELECT outcome_key FROM resident_outcomes WHERE outcome_key LIKE 'work:%'").length < 70);
  const late = child(70); ids.push(late);
  tick(); assert.ok(f.database.readOne('SELECT outcome_key FROM resident_outcomes WHERE outcome_key=?', `work:${late}`), 'fresh direct child bypasses the old subtree');
  f.finish({ text: 'The real family returned its saved evidence.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!);
  f.reviewWithText('I inspected the recorded child cancellation.');
  for (let n = 0; n < 150; n++) {
    tick(); await f.service.processResidentOutcomes();
    for (const row of f.outcomes.pending()) if (row.reviewWorkId) await f.service.awaitSettlement(row.reviewWorkId);
  }
  const rows = f.database.readAll<{ id: string }>("SELECT source_work_id AS id FROM resident_outcomes WHERE outcome_key LIKE 'work:%'");
  assert.deepEqual(rows.map(row => row.id).sort(), ids.sort());
});

test('paused specialist evidence uses the real detached schema and excludes unrelated or malformed callbacks', async t => {
  const f = fixture(t, false, false);
  t.mock.method(Date, 'now', () => Date.parse(AT));
  const first = await f.initiatives.run(credential, request); await new Promise(resolve => setImmediate(resolve));
  const conversationId = fixtureId('conversation', 940);
  for (let n = 0; n < 13; n++) await new SqliteCommunicationEventRepository(f.database).append({
    requestId: fixtureId('request', 1400 + n), correlationId: fixtureId('correlation', 1400 + n), event: {
      eventId: stableCommunicationEventId(`specialist-terminal:${first.workId}:aw_fixture${n}_abcd`, AT), conversationId, channelId: CHANNEL_ID, workId: first.workId!,
      actor: { principalId: n === 11 ? 'user_owner' : BOT_ID, displayName: 'Jerry', kind: 'resident_bot' },
      source: { system: 'resident_runtime', adapter: 'resident_uds', sourceEventType: 'specialist.completed' },
      kind: 'subagent_completed', provenance: 'resident_authenticated_specialist_terminal', occurredAt: AT, terminal: true,
      payload: { parentWorkId: first.workId!, childWorkId: n === 12 ? '' : `aw_fixture${n}_abcd`, childKind: 'subagent',
        childResultHandle: { id: `aw_fixture${n}_abcd`, type: 'fixture' }, status: 'completed', terminalEvidence: 'fixture evidence', terminalText: 'Inspected notes', artifacts: [] },
    },
  });
  for (let tick = 0; tick < 8; tick++) f.outcomes.discover();
  const rows = f.database.readAll<{ key: string }>("SELECT outcome_key AS key FROM resident_outcomes WHERE outcome_key LIKE 'specialist:%'");
  assert.equal(rows.length, 11, 'callbacks beyond the first communication page remain discoverable');
  assert.ok(rows.every(row => /^specialist:aw_fixture\d+_abcd$/.test(row.key)));
  f.finish({ text: 'The useful result is saved.', model: 'frontier', toolCallCount: 0, durationMs: 1 }); await f.service.awaitSettlement(first.workId!);
});

test('paused root candidate reads stay bounded among 100001 expired initiative bindings', async t => {
  const f = fixture(t, true, false);
  t.mock.method(Date, 'now', () => Date.parse(AT));
  const stopped = await f.initiatives.run(credential, request);
  f.control.cancel({ context: f.owner, workId: stopped.workId!, idempotencyKey: 'expired-history-template' });
  const columns = f.database.raw.prepare('PRAGMA table_info(works)').all().map(row => (row as { name: string }).name);
  const copy = f.database.raw.prepare(`INSERT INTO works(${columns.join(',')}) SELECT ${columns.map(name => ['id', 'context_manifest_id', 'idempotency_key_digest'].includes(name) ? '?' : name).join(',')} FROM works WHERE id=?`);
  const manifestColumns = f.database.raw.prepare('PRAGMA table_info(context_manifests)').all().map(row => (row as { name: string }).name);
  const copyManifest = f.database.raw.prepare(`INSERT INTO context_manifests(${manifestColumns.join(',')}) SELECT ${manifestColumns.map(name => name === 'id' ? '?' : name).join(',')} FROM context_manifests WHERE id=?`);
  const templateManifest = f.work.get(stopped.workId!)!.contextManifestId;
  const insert = f.database.raw.prepare(`INSERT INTO events(id,schema_version,type,durability,aggregate_kind,aggregate_id,aggregate_version,
    channel_id,actor_principal_id,request_id,correlation_id,payload_json,payload_digest,created_at)
    VALUES (?,1,'activity.updated','durable','resident_initiation_work',?,1,?,?,?,?,?,?,?)`);
  f.database.raw.transaction(() => {
    for (let n = 0; n < 100001; n++) {
      const id = `wrk_0180d95f-6c00-7000-8000-${String(n).padStart(12, '0')}`;
      const manifestId = `ctx_0180d95f-6c00-7000-8000-${String(n).padStart(12, '0')}`;
      copyManifest.run(manifestId, templateManifest);
      copy.run(id, manifestId, n.toString(16).padStart(64, '0'), stopped.workId!);
      const payload = { workId: id, residentSlug: 'jerry', principalId: BOT_ID, channelId: CHANNEL_ID, deadlineAtMs: 0,
        request: { ...request, initiationId: `expired-${n}` } };
      insert.run(fixtureId('event', 3000000 + n), id, CHANNEL_ID, BOT_ID, fixtureId('request', 1500), fixtureId('correlation', 1500), JSON.stringify(payload), 'b'.repeat(64), AT);
    }
  })();
  const newest = await f.initiatives.run(credential, { ...request, initiationId: 'new-live-after-expired-history', timeoutMs: 10 });
  f.advance(11); f.initiatives.reconcile(); t.mock.method(Date, 'now', () => Date.parse(AT) + 11);
  const readAll = f.database.readAll.bind(f.database), readOne = f.database.readOne.bind(f.database);
  let candidateRows = 0, bindingReads = 0;
  f.database.readAll = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T[] => {
    const rows = readAll<T>(sql, ...values);
    if (sql.includes("SELECT aggregate_id AS id FROM events") && sql.includes("aggregate_kind='resident_initiation_work'")) candidateRows += rows.length;
    return rows;
  };
  f.database.readOne = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T | undefined => {
    if (sql.includes('w.target_principal_id AS principalId,e.sequence')) bindingReads++;
    return readOne<T>(sql, ...values);
  };
  const policy = f.database.readOne('SELECT * FROM resident_outcome_policy');
  f.outcomes.discover({ startup: true });
  assert.ok(candidateRows <= 3 && bindingReads <= 3, `raw candidates=${candidateRows}, point bindings=${bindingReads}`);
  assert.ok(f.database.readOne('SELECT outcome_key FROM resident_outcomes WHERE outcome_key=?', `initiative:${newest.workId}`), 'expiry before the first pump reaches private settlement immediately');
  candidateRows = 0; bindingReads = 0; f.outcomes.discover();
  assert.ok(candidateRows <= 3 && bindingReads <= 5);
  assert.ok(f.database.readOne('SELECT outcome_key FROM resident_outcomes WHERE outcome_key=?', `initiative:${newest.workId}`));
  await f.service.processResidentOutcomes(); assert.equal(f.turns.size, 0, 'expired recovery cannot start a provider review');
  assert.deepEqual(f.database.readOne('SELECT * FROM resident_outcome_policy'), policy);
});

test('paused metadata pages seek through 100001 settled siblings and retain an unoffered older candidate', async t => {
  const f = fixture(t, false, false); t.mock.method(Date, 'now', () => Date.parse(AT));
  const first = await f.initiatives.run(credential, request); await new Promise(resolve => setImmediate(resolve));
  f.finish({ text: 'Inspected the saved connection.', model: 'frontier', toolCallCount: 0, durationMs: 1 });
  await f.service.awaitSettlement(first.workId!); f.reviewWithText('');
  for (let n = 0; n < 5; n++) { await f.service.processResidentOutcomes(); for (const row of f.outcomes.pending()) if (row.reviewWorkId) await f.service.awaitSettlement(row.reviewWorkId); }
  const insert = f.database.raw.prepare('INSERT INTO resident_outcomes(outcome_key,source_work_id,evidence_json,created_at,settled_at) VALUES (?,?,?,?,?)');
  const pendingKey = 'metadata:099950', nextKey = 'metadata:099949';
  f.database.raw.transaction(() => { for (let n = 0; n < 100001; n++) {
    const key = `metadata:${String(n).padStart(6, '0')}`;
    insert.run(key, first.workId, '{}', AT, [pendingKey, nextKey].includes(key) ? null : AT);
  } })();
  const policy = f.database.readOne('SELECT * FROM resident_outcome_policy');
  const store = createResidentOutcomeStore(f.database, { replay: false, primaryResident: 'jerry' });
  const readOne = f.database.readOne.bind(f.database); const plans: string[] = []; const cursors: string[] = [];
  let sourceReads = 0;
  f.database.readOne = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T | undefined => {
    if (sql.includes('WHERE source_work_id=?')) {
      sourceReads++;
      assert.doesNotMatch(sql, /source_work_id=\?.*settled_at IS NULL/s, 'pending filtering occurs after the raw indexed row');
      if (sql.includes('(created_at,outcome_key)<(?,?)')) {
        cursors.push(String(values[2]));
        plans.push(...f.database.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => String((row as { detail: string }).detail)));
      }
    }
    return readOne<T>(sql, ...values);
  };
  const after = { createdAt: '9999-01-01T00:00:00.000Z', key: 'future' };
  for (let tick = 0; tick < 12; tick++) { sourceReads = 0; store.discover(); assert.ok(sourceReads <= 40, `source metadata reads=${sourceReads}`); assert.deepEqual(store.pendingPage(after, 4), []); }
  assert.ok(cursors.some(key => key < 'metadata:100000'), 'settled pages advance a retained raw cursor');
  assert.ok(plans.some(detail => detail.includes('resident_outcomes_source_created') && detail.includes('(created_at,outcome_key)<(?,?)')), [...new Set(plans)].join('; '));
  const row = store.pending().find(value => value.key === pendingKey)!;
  store.update(row, 'settled_at', AT); // An already in-flight review completes before this frame offers it.
  for (let tick = 0; tick < 3; tick++) store.discover();
  assert.ok(store.pendingPage(null, 4).some(value => value.key === nextKey), 'a settled unoffered key cannot pin the walker or hide its older sibling');
  assert.ok(cursors.some(key => key === pendingKey), 'the raw tuple cursor advances through the settled candidate');
  assert.deepEqual(f.database.readOne('SELECT * FROM resident_outcome_policy'), policy);
});

test('paused terminal projections preserve actual failed cause and bound cancelled/no-attempt and unrelated history', async t => {
  const f = fixture(t, false, false); t.mock.method(Date, 'now', () => Date.parse(AT));
  const first = await f.initiatives.run(credential, request); await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  const detach = createForegroundDetachmentConsumer({ database: f.database, work: f.work, now: () => new Date(AT), schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'resident-client', serverInstanceId: 'resident-1', keyVersion: 1 }) });
  const identity = { requestId: fixtureId('request', 1700), correlationId: fixtureId('correlation', 1700) };
  const child = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: 'failed-evidence-child', toolName: 'spawn_agent',
    canonicalArgs: { task: 'Inspect evidence' }, executionInstruction: 'Inspect evidence', title: 'Inspect evidence', summary: 'Inspect evidence', recoveryPolicy: 'safe_before_start' } });
  const offered = f.leases.offer({ workId: child.workId, holderPrincipalId: BOT_ID, holderInstanceId: 'resident-1', authorityReference: 'authority:messages', automatic: true, ...identity });
  const binding = { workId: child.workId, attemptId: offered.attempt.id, leaseId: offered.lease.id, holderPrincipalId: BOT_ID,
    holderInstanceId: 'resident-1', fencingToken: offered.lease.fencingToken, ...identity };
  f.leases.accept(binding); f.leases.start(binding);
  const insert = f.database.raw.prepare(`INSERT INTO events(id,schema_version,type,durability,aggregate_kind,aggregate_id,aggregate_version,
    channel_id,actor_principal_id,request_id,correlation_id,payload_json,payload_digest,created_at) VALUES (?,1,'communication.recorded','durable','communication',?,1,NULL,NULL,?,?,?,?,?)`);
  f.database.raw.transaction(() => { for (let n = 0; n < 100001; n++) insert.run(fixtureId('event', 3000000 + n), `terminal-unrelated:${n}`, identity.requestId, identity.correlationId,
    JSON.stringify({ communication: { conversationId: fixtureId('conversation', 1701) } }), 'a'.repeat(64), AT); })();
  f.communications.append({ ...identity, event: { conversationId: fixtureId('conversation', 940), channelId: CHANNEL_ID, workId: child.workId,
    attemptId: offered.attempt.id, turnId: 'failed-child-turn', actor: { principalId: BOT_ID, displayName: 'Jerry', kind: 'resident_bot' },
    source: { system: 'fixture', sourceEventType: 'turn.terminal' }, kind: 'failure', occurredAt: AT, terminal: true, payload: { status: 'failed', error: 'Saved note could not be read: fixture denied.' } } });
  f.leases.terminalize({ ...binding, receipt: { status: 'failed', sourceReference: 'authority:messages', resultDigest: null, artifactIds: [], timestamp: AT } });
  const stopped = detach.admit({ credential, request: { parentOrigin: origin, residentSlug: 'jerry', invocationId: 'no-attempt-evidence-child', toolName: 'spawn_agent',
    canonicalArgs: { task: 'Inspect more evidence' }, executionInstruction: 'Inspect more evidence', title: 'Inspect more', summary: 'Inspect more', recoveryPolicy: 'safe_before_start' } });
  f.work.cancelQueued({ workId: stopped.workId, actorPrincipalId: BOT_ID, reasonCode: 'fixture_stop', sourceReference: 'fixture:no-attempt', timestamp: AT, ...identity });
  f.finish({ text: 'The saved inspection returned a concrete problem.', model: 'frontier', toolCallCount: 0, durationMs: 1 }); await f.service.awaitSettlement(first.workId!);
  const readAll = f.database.readAll.bind(f.database); const windows: string[] = [];
  f.database.readAll = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T[] => {
    if (sql.includes("communication.conversationId')=?") && sql.includes('LIMIT 17')) {
      windows.push(...f.database.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => String((row as { detail: string }).detail)));
      assert.ok(Number(values[1]) <= Number(values[2]));
    }
    assert.doesNotMatch(sql, /WHERE sequence >= \(SELECT min\(sequence\)/, 'paused scope must not use the unbounded legacy terminal query');
    return readAll<T>(sql, ...values);
  };
  f.outcomes.discover(); f.reviewWithText('The recorded inspection failed; I have not claimed completion.');
  for (let tick = 0; tick < 10; tick++) { await f.service.processResidentOutcomes(); for (const row of f.outcomes.pending()) if (row.reviewWorkId) await f.service.awaitSettlement(row.reviewWorkId); }
  const evidence = (id: string) => JSON.parse(f.database.readOne<{ evidence: string }>('SELECT evidence_json AS evidence FROM resident_outcomes WHERE outcome_key=?', `work:${id}`)!.evidence);
  const failed = evidence(child.workId), cancelled = evidence(stopped.workId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.executionReceipt.terminal_status, 'failed');
  assert.equal(failed.terminalEvidence[0].communication.payload.error, 'Saved note could not be read: fixture denied.');
  assert.equal(failed.terminalEvidenceWindow.truncated, false); assert.equal(failed.helperDeliveryWindow.truncated, true, 'large global event window is explicitly partial');
  assert.equal(cancelled.executionReceipt.attempt_id, null); assert.equal(cancelled.terminalEvidenceWindow.examined, 0); assert.deepEqual(cancelled.terminalEvidence, []);
  assert.ok(windows.some(detail => detail.includes('communication_events_conversation_sequence') && detail.includes('sequence>? AND sequence<?')), windows.join('; '));
  assert.match(f.instructions.find(value => value.startsWith('INTERNAL RESIDENT INITIATIVE OUTCOME'))!, /If a window is truncated, inspect the normal canonical Work/);
});

test('paused blocked revisit assessment retries keep their durable budget and conservative clearance across restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AT) });
  const f = fixture(t, false, false);
  const first = await f.initiatives.run(credential, { ...request, purpose: 'action', timeoutMs: 900000 }); await new Promise(resolve => setImmediate(resolve));
  const origin = f.origins[0] as import('../../../src/agent/types.js').CoordinationTurnOrigin;
  f.finish({ text: 'The inspection needs a later assessment.', model: 'frontier', toolCallCount: 0, durationMs: 1 }); await f.service.awaitSettlement(first.workId!);
  f.assignments.report(f.residentContext({ principalId: BOT_ID, requestId: fixtureId('request', 1800), correlationId: fixtureId('correlation', 1800) }), origin,
    { work_id: first.workId, state: 'blocked', summary: 'Waiting for an inspected assessment', revisit_at: new Date(Date.now() + 1000).toISOString() }, 'paused-assessment-block');
  f.reviewWithText('I inspected the blocker but have not accepted a new assessment.');
  let store = f.outcomes, service = f.service;
  const count = () => f.database.readOne<{ count: number }>("SELECT count(*) AS count FROM resident_outcomes WHERE outcome_key LIKE 'assignment-revisit:%'")!.count;
  const readOne = f.database.readOne.bind(f.database);
  f.database.readOne = <T>(sql: string, ...values: Array<string | number | bigint | Buffer | null>): T | undefined => {
    assert.doesNotMatch(sql, /WHERE source_work_id=\? AND settled_at IS NULL LIMIT 1/, 'paused retry uses retained raw clearance and exact keys');
    return readOne<T>(sql, ...values);
  };
  async function pump() { for (let tick = 0; tick < 12; tick++) { await service.processResidentOutcomes(); for (const row of store.pending()) if (row.reviewWorkId) await service.awaitSettlement(row.reviewWorkId); } }
  const advance = (ms: number) => { t.mock.timers.tick(ms); f.advance(ms); };
  advance(1000); await pump(); assert.equal(count(), 1);
  advance(59999); await pump(); assert.equal(count(), 1);
  const settled = f.database.raw.prepare('INSERT INTO resident_outcomes(outcome_key,source_work_id,evidence_json,created_at,settled_at) VALUES (?,?,?,?,?)');
  for (let n = 0; n < 40; n++) settled.run(`retry-history:${n}`, first.workId, '{}', AT, AT);
  store.discover(); // Begin a raw DESC sweep before a newer callback arrives.
  const raceKey = 'specialist:aw_retryrace_abcd';
  store.enqueue(raceKey, first.workId!, { parentWorkId: first.workId, childWorkId: 'aw_retryrace_abcd', childKind: 'subagent' });
  const pending = store.pending().find(value => value.key === raceKey)!;
  const review = f.work.create({ principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID, originMessageId: f.work.get(first.workId!)!.originMessageId,
    roundId: null, kind: 'resident_turn', idempotencyKey: `resident-outcome:${raceKey}`, manifest: (await f.initiatives.recover(f.work.get(first.workId!)!))!.prepared.manifest,
    maxAutomaticOffers: 1, requestId: fixtureId('request', 1801), correlationId: fixtureId('correlation', 1801) }).work;
  store.update(pending, 'review_work_id', review.id);
  advance(1);
  for (let tick = 0; tick < 8; tick++) { store.discover(); store.pendingPage(null, 4); }
  assert.equal(count(), 1, 'a new offered/bound but unsettled callback above the cursor invalidates retry clearance');
  f.work.cancelQueued({ workId: review.id, actorPrincipalId: BOT_ID, reasonCode: 'fixture_stop', sourceReference: 'fixture:review-race', timestamp: AT,
    requestId: fixtureId('request', 1802), correlationId: fixtureId('correlation', 1802) });
  store.update(pending, 'settled_at', new Date().toISOString());
  await pump(); assert.equal(count(), 2);
  const policy = f.database.readOne('SELECT * FROM resident_outcome_policy');
  store = createResidentOutcomeStore(f.database, { replay: false, primaryResident: 'jerry' }); service = f.makeService(store);
  advance(299999); await pump(); assert.equal(count(), 2);
  advance(1); await pump(); assert.equal(count(), 3);
  advance(60000); await pump(); assert.equal(count(), 3, 'one explicit blocked conclusion permits only two assessment retries');
  assert.deepEqual(f.database.readOne('SELECT * FROM resident_outcome_policy'), policy);
  assert.equal(f.work.get(first.workId!)!.state, 'succeeded', 'assessment retries preserve original execution');
});
