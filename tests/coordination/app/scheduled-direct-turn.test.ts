import assert from 'node:assert/strict';
import test from 'node:test';
import { ResidentCoordinationAdapter, createM11ResidentCoordinationPort } from '../../../src/coordination-adapter/index.js';
import type { ResidentAgentPort } from '../../../src/coordination-adapter/index.js';
import { createDirectMessageSubmissionService, SqliteDirectMessageContext } from '../../../src/coordination/app/index.js';
import { createScheduledChannelTurns } from '../../../src/coordination/app/scheduled-turns.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';
import { SqliteMessagingRepository, SqliteBotConversationBindingAdapter } from '../../../src/coordination/channels/index.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { createWorkService, M11MessageProvenanceAuthority } from '../../../src/coordination/work/index.js';
import { AT, BOT_ID, CHANNEL_ID, M11TestDatabase, OWNER_ID, createFixtureIdGenerator, fixtureId } from '../work/test-fixture.js';

const runId = 'sched-run-0198d95f-6c00-7000-8000-000000000830';
const conversationId = fixtureId('conversation', 830);
const input = {runId, jobId: 'morning-reflection', channelId: CHANNEL_ID,
  prompt: 'Reflect on whether accumulated context has translated into useful follow-through. PRIVATE SCHEDULE INSTRUCTION', timeoutMs: 1_800_000};
const requestIdentity = {requestId: fixtureId('request', 830), correlationId: fixtureId('correlation', 830)};
const residentContext = {principalId: BOT_ID, ...requestIdentity, identity: {kind: 'resident' as const,
  resident: {...requestIdentity, credential: {residentSlug: 'jerry', role: 'resident' as const, instanceId: 'resident-1', keyVersion: 1}}}};
const ownerContext = {principalId: OWNER_ID, ...requestIdentity, identity: {kind: 'owner' as const, auth: {
  principalId: OWNER_ID as 'user_owner', deviceId: 'dev_0198d95f-6c00-7000-8000-000000000831', sessionId: 'ses_0198d95f-6c00-7000-8000-000000000832',
  scopes: ['product:read', 'message:send'] as const}}};
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let count = 0; count < 50; count++) { if (predicate()) return; await settle(); }
  assert.ok(predicate(), 'isolated canonical fixture should settle');
}

function fixture(t: test.TestContext) {
  const database = M11TestDatabase.temporary(); t.after(() => database.close());
  database.raw.prepare('INSERT INTO conversation_handles (id,channel_id,created_at) VALUES (?,?,?)').run(conversationId, CHANNEL_ID, AT);
  database.raw.prepare('UPDATE bots SET conversation_id=? WHERE id=?').run(conversationId, BOT_ID);
  const bot = {id: BOT_ID, principalId: BOT_ID, name: 'Jerry', purpose: 'Persistent resident', lifecycle: 'active' as const,
    conversationId, residentBinding: 'jerry', continuingIdentity: true, durableMailbox: true, requiredCapabilities: ['messages'],
    activeInstanceId: 'resident-1', activeKeyVersion: 1, residentProtocolVersion: 1, residentCapabilities: ['messages'],
    residentRegisteredAt: AT, lastHeartbeatAt: AT, reportedAvailability: 'available' as const, availability: 'available' as const,
    version: 1, createdAt: AT, updatedAt: AT};
  const directory = {listVisibleBots: async () => [bot], resolveAlias: async () => bot,
    getBotByResidentBinding: async (slug: string) => slug === 'jerry' ? bot : null};
  const messages = createMessageService({repository: new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority()}), participantDirectory: directory,
    now: () => new Date(AT)});
  const work = createWorkService({database, generateId: createFixtureIdGenerator(40_000), now: () => new Date(AT)});
  const leases = createLeaseService({database, generateId: createFixtureIdGenerator(50_000), now: () => new Date(AT), leaseTtlMs: 60_000});
  const context = new SqliteDirectMessageContext(database, messages);
  const instructions: string[] = [];
  const origins: CoordinationTurnOrigin[] = [];
  let finish!: (response: {text: string; model: string; toolCallCount: number; durationMs: number}) => void;
  const response = new Promise<{text: string; model: string; toolCallCount: number; durationMs: number}>(resolve => {finish = resolve;});
  const agent: ResidentAgentPort = {
    async modelCatalog() { return {models: [], defaultModel: 'gpt-5.6-terra', defaultProvider: 'openai-codex', defaultReasoningEffort: 'medium', reasoningEfforts: ['medium']}; },
    async runWithTurn(chatId, text, options) {
      assert.equal(database.readAll("SELECT sequence FROM events WHERE aggregate_kind='scheduled_channel_run' AND aggregate_id=? AND aggregate_version=1", runId).length, 1);
      instructions.push(text);
      origins.push(options.coordinationOrigin);
      const turnId = `coord-${options.coordinationOrigin.workId}`;
      await options.onDurableStart({turnId, chatId, persistedAt: AT, selection: {
        requestedProvider: null, requestedModelAlias: options.turnSelection.modelAlias, requestedModel: null,
        requestedEffort: options.turnSelection.reasoningEffort, resolvedProvider: 'openai-codex', resolvedModel: 'gpt-5.6-terra',
        resolvedEffort: 'medium', actualProvider: 'openai-codex', actualModel: 'gpt-5.6-terra', actualEffort: 'medium'}});
      return {turnId, response};
    }, stop: () => ({stopped: true}),
  };
  const resident = new ResidentCoordinationAdapter(agent, createM11ResidentCoordinationPort(leases), () => new Date(AT));
  const direct = createDirectMessageSubmissionService({messages, context, work, leases,
    resolveResident: slug => slug === 'jerry' ? {resident, holderInstanceId: 'resident-1', models: agent,
      context: identity => ({...residentContext, ...identity})} : undefined,
    authority: {current: () => ({capability: 'messages', epoch: 3, mode: 'canonical', writer: 'home23-coordination', effectiveAtEventSequence: 1, rollbackEpoch: 1})},
    beginWork: () => () => {}, recoveryIdentity: () => requestIdentity});
  const channels = {getChannel: async ({channelId}: {channelId: string}) => ({kind: 'direct', lifecycle: 'active', members: database.readAll<{principalId: string}>(
    'SELECT principal_id AS principalId FROM channel_members WHERE channel_id=? AND active=1', channelId)})};
  const options = {database, channels: channels as any, context: () => residentContext, submit: direct,
    beginWork: () => () => {}, expireWork: () => {}, now: () => 1_000};
  return {database, messages, work, leases, context, direct, options, instructions, origins, finish};
}

test('resident morning follow-up uses its own direct canonical Work and private instruction across reattachment', async t => {
  const f = fixture(t); let scheduled = createScheduledChannelTurns(f.options);
  assert.equal((await scheduled.run(input)).state, 'running');
  await until(() => f.instructions.length === 1);
  assert.equal(f.instructions[0], input.prompt);
  const roots = f.database.readAll<{id: string; state: string; kind: string; originMessageId: string}>(
    'SELECT id,state,kind,origin_message_id AS originMessageId FROM works');
  assert.equal(roots.length, 1); assert.equal(roots[0].kind, 'resident_turn');
  const root = f.work.get(roots[0].id)!;
  const origin = await f.messages.getMessage({context: ownerContext, messageId: root.originMessageId!});
  assert.equal(origin!.author.principalId, BOT_ID); assert.equal(origin!.kind, 'system'); assert.equal(origin!.text, null);
  assert.equal(origin!.clientMessageId, `scheduled:${runId}`);
  const recovered = await new SqliteDirectMessageContext(f.database, f.messages).recover(root);
  assert.equal(recovered.prepared.instruction, input.prompt); assert.deepEqual(recovered.prepared.scheduledTurn, input);
  assert.equal(recovered.prepared.originalOwnerRequest, undefined); assert.equal(recovered.prepared.residentInitiative, undefined);
  assert.deepEqual(f.context.scheduledTurnForRoot(root), input);
  const childIds: string[] = [];
  const consumer = createForegroundDetachmentConsumer({database: f.database, work: f.work, now: () => new Date(AT),
    resolveResident: () => ({clientInstanceId: 'resident-1', serverInstanceId: 'resident-1', keyVersion: 1}), schedule: id => childIds.push(id)});
  const detached = consumer.admit({credential: {residentSlug: 'jerry', instanceId: 'resident-1', keyVersion: 1}, request: {
    parentOrigin: f.origins[0], residentSlug: 'jerry', invocationId: 'inspect-reflection-examples', toolName: 'spawn_agent',
    canonicalArgs: {task: 'Inspect the saved examples'}, executionInstruction: 'Inspect the saved examples', title: 'Inspect saved examples',
    summary: 'Inspect examples for the scheduled reflection', recoveryPolicy: 'safe_before_start'}});
  assert.deepEqual(childIds, [detached.workId]);
  const child = f.work.get(detached.workId)!;
  assert.equal(child.kind, 'resident_work_thread'); assert.notEqual(child.idempotencyKeyDigest, root.idempotencyKeyDigest);
  const childRecovered = await new SqliteDirectMessageContext(f.database, f.messages).recover(child);
  assert.deepEqual(childRecovered.prepared.scheduledTurn, input); assert.equal(childRecovered.prepared.instruction, input.prompt);
  assert.equal(f.context.scheduledTurnForRoot(child), undefined);
  const review = f.work.create({principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: root.originMessageId, roundId: null, kind: 'resident_turn', idempotencyKey: `resident-outcome:scheduled:${root.id}`,
    manifest: recovered.prepared.manifest, maxAutomaticOffers: 1, ...requestIdentity}).work;
  assert.equal(f.context.scheduledTurnForRoot(review), undefined, 'a review sharing the private marker is not a scheduled root');
  const presentation = f.database.readOne<{title: string; summary: string}>('SELECT title,summary FROM work_thread_presentations WHERE work_id=?', root.id)!;
  assert.equal(presentation.title, 'Scheduled follow-up'); assert.ok(!JSON.stringify(presentation).includes('PRIVATE SCHEDULE'));
  // This is the exact primary Apple direct-transcript author/kind policy:
  // owner/text or bot/result; canonical bot/system markers never become bubbles.
  const transcript = (await f.messages.listMessages({context: ownerContext, channelId: CHANNEL_ID, limit: 100})).messages;
  const bubbles = transcript.filter(message => message.author.kind === 'owner' && message.kind === 'text' || message.author.kind === 'bot' && message.kind === 'result');
  assert.ok(!bubbles.some(message => message.id === origin!.id)); assert.ok(!JSON.stringify(transcript).includes('PRIVATE SCHEDULE'));
  scheduled = createScheduledChannelTurns(f.options); scheduled.reconcile();
  assert.deepEqual((await scheduled.run(input)).workIds, [root.id]); assert.equal(f.instructions.length, 1);
  await assert.rejects(scheduled.run({...input, prompt: 'Altered request'}), {code: 'request_invalid', retryable: false});
  const body = {messageId: origin!.id, clientMessageId: origin!.id, text: input.prompt, attachmentIds: [], mentions: [BOT_ID],
    replyToMessageId: null, modelAlias: null, reasoningEffort: null};
  await assert.rejects(f.direct.submitMessage({context: residentContext, channelId: CHANNEL_ID, idempotencyKey: `scheduled:${runId}`,
    scheduledRunId: runId, body: {...body, text: 'Altered request'}}), {code: 'idempotency_conflict'});
  await assert.rejects(f.direct.submitMessage({context: residentContext, channelId: CHANNEL_ID, idempotencyKey: `scheduled:${runId}`,
    scheduledRunId: runId, body: {...body, modelAlias: 'forged-selection'}}), {code: 'idempotency_conflict'});
  f.finish({text: 'Here is the saved reflection.', model: 'fixture', toolCallCount: 0, durationMs: 1});
  await until(() => f.work.get(root.id)!.state === 'succeeded');
  await until(() => f.database.readAll("SELECT id FROM messages WHERE kind='result' AND work_id=?", root.id).length === 1);
  assert.equal((await scheduled.run(input)).state, 'succeeded');
  assert.equal((await scheduled.run(input)).text, 'Here is the saved reflection.'); assert.equal(f.instructions.length, 1);
});

test('direct scheduled admission rejects owner, foreign mailbox, inactive resident and missing owner membership before journal/Work', async t => {
  const f = fixture(t);
  const reject = async (options = f.options, turn = input) => {
    await assert.rejects(createScheduledChannelTurns(options).run(turn), {code: 'request_invalid', retryable: false});
    assert.equal(f.database.readAll("SELECT id FROM events WHERE aggregate_kind='scheduled_channel_run'").length, 0);
    assert.equal(f.database.readAll('SELECT id FROM works').length, 0);
  };
  await reject({...f.options, context: () => ownerContext} as any);
  f.database.raw.prepare('UPDATE bots SET conversation_id=NULL WHERE id=?').run(BOT_ID); await reject();
  f.database.raw.prepare('UPDATE bots SET conversation_id=? WHERE id=?').run(conversationId, BOT_ID);
  f.database.raw.prepare('UPDATE channel_members SET active=0,left_at=? WHERE principal_id=?').run(AT, BOT_ID); await reject();
  f.database.raw.prepare('UPDATE channel_members SET active=1,left_at=NULL WHERE principal_id=?').run(BOT_ID);
  const foreignChannel = fixtureId('channel', 834); const foreignConversation = fixtureId('conversation', 834);
  f.database.raw.prepare(`INSERT INTO channels(id,kind,title,purpose,owner_principal_id,responder_mode,coordinator_bot_id,response_order,max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at)
    VALUES (?,'direct','Other mailbox','','user_owner','mentions_only',NULL,'parallel',1,'active',0,1,1,?,?)`).run(foreignChannel, AT, AT);
  f.database.raw.prepare('INSERT INTO conversation_handles(id,channel_id,created_at) VALUES (?,?,?)').run(foreignConversation, foreignChannel, AT);
  f.database.raw.prepare("INSERT INTO channel_members(channel_id,principal_id,kind,role,active,joined_at,left_at) VALUES (?,?,'bot','member',1,?,NULL)").run(foreignChannel, BOT_ID, AT);
  await reject(f.options, {...input, channelId: foreignChannel});
  f.database.raw.prepare('UPDATE bots SET conversation_id=? WHERE id=?').run(foreignConversation, BOT_ID);
  await reject(f.options, {...input, channelId: foreignChannel}); // bound but has no canonical owner membership
  f.database.raw.prepare('UPDATE bots SET conversation_id=? WHERE id=?').run(conversationId, BOT_ID);
  const body = {messageId: fixtureId('message', 833), clientMessageId: fixtureId('message', 833), text: input.prompt,
    attachmentIds: [], mentions: [BOT_ID], replyToMessageId: null, modelAlias: null, reasoningEffort: null};
  await assert.rejects(f.direct.submitMessage({context: residentContext, channelId: CHANNEL_ID, idempotencyKey: `scheduled:${runId}`,
    scheduledRunId: runId, body}), {code: 'request_invalid'});
  await assert.rejects(f.direct.submitMessage({context: residentContext, channelId: CHANNEL_ID, idempotencyKey: 'unjournaled-resident', body}), {code: 'request_invalid'});
  f.database.mutateWithEvent(() => ({value: undefined, event: {type: 'activity.updated', aggregateKind: 'scheduled_channel_run',
    aggregateId: runId, aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: OWNER_ID,
    ...requestIdentity, payload: {...input, messageId: body.messageId, botId: BOT_ID, deadlineAtMs: 1_801_000}, createdAt: AT}}));
  await assert.rejects(f.direct.submitMessage({context: residentContext, channelId: CHANNEL_ID, idempotencyKey: `scheduled:${runId}`,
    scheduledRunId: runId, body}), {code: 'invalid_relation'});
  assert.equal(await f.messages.getMessage({context: ownerContext, messageId: body.messageId}), null,
    'a payload naming the resident cannot borrow a mismatched journal actor');
  assert.equal(f.database.readAll('SELECT id FROM works').length, 0);
});
