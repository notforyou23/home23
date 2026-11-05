import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { createResidentOutcomeStore } from '../../../src/coordination/app/resident-outcomes.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createDirectMessageSubmissionService, SqliteDirectMessageContext } from '../../../src/coordination/app/index.js';
import { SqliteMessagingRepository, SqliteBotConversationBindingAdapter } from '../../../src/coordination/channels/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { M11MessageProvenanceAuthority } from '../../../src/coordination/work/index.js';
import { createBotDirectory, SqliteBotDirectoryRepository } from '../../../src/coordination/bots/index.js';
import { SqliteCommunicationEventRepository } from '../../../src/coordination/communications/index.js';
import assert from "node:assert/strict";
import test from "node:test";

import {
  ResidentCoordinationAdapter,
  createM11ResidentCoordinationPort,
  type ResidentAgentPort,
} from "../../../src/coordination-adapter/index.js";
import { SqliteGroupChannelMessageContext } from "../../../src/coordination/app/channel-message-context.js";
import { createGroupChannelMessageService } from "../../../src/coordination/app/channel-message.js";
import { directMessageManifest } from "../../../src/coordination/app/direct-message.js";
import {
  ChannelCoordinatorError,
  createChannelCoordinator,
  type ChannelTurnTrigger,
  type CoordinatorAdmissionPlan,
  type CreateChannelCoordinatorOptions,
} from "../../../src/coordination/channel-coordinator/index.js";
import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createRoundService } from "../../../src/coordination/rounds/index.js";
import { createWorkService, type WorkRecord } from "../../../src/coordination/work/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
} from "../work/test-fixture.js";

const BOT_2 = fixtureId("bot", 2);
const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000001";
const DEADLINE = "2026-08-25T16:10:00.000Z";
const AUTHORITY = Object.freeze({
  capability: "messages" as const,
  mode: "canonical" as const,
  epoch: 2,
  writer: "home23-coordination",
});

type DurabilityFailpoint = NonNullable<
  CreateChannelCoordinatorOptions["durabilityFailpoint"]
>;

function prepare(database: M11TestDatabase, responseOrder: "parallel" | "sequential"): void {
  database.raw.prepare(
    "INSERT INTO authority_epochs VALUES ('messages', 2, 'canonical', 'home23-coordination', 1, 1, '{}', ?)",
  ).run(AT);
  database.raw.prepare(
    `UPDATE channels SET kind = 'group', responder_mode = 'mention_or_coordinator',
       coordinator_bot_id = ?, response_order = ?, max_bot_turns = 4
     WHERE id = ?`,
  ).run(BOT_ID, responseOrder, CHANNEL_ID);
  database.raw.prepare(
    "INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)",
  ).run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare(
    "INSERT INTO principals (id, kind, created_at) VALUES (?, 'bot', ?)",
  ).run(BOT_2, AT);
  database.raw.prepare(
    `INSERT INTO bots (
      id, principal_id, name, purpose, lifecycle, conversation_id, resident_binding,
      continuing_identity, durable_mailbox, required_capabilities_json,
      active_instance_id, active_key_version, resident_protocol_version,
      resident_capabilities_json, resident_registered_at, last_heartbeat_at,
      reported_availability, version, created_at, updated_at
    ) VALUES (?, ?, 'Ada', 'Persistent resident', 'active', NULL, 'ada', 1, 1,
              '["messages"]', 'resident-2', 1, 1, '["messages"]', ?, ?,
              'available', 1, ?, ?)`,
  ).run(BOT_2, BOT_2, AT, AT, AT, AT);
  database.raw.prepare(
    `INSERT INTO channel_members (
      channel_id, principal_id, kind, role, active, joined_at, left_at
    ) VALUES (?, ?, 'bot', 'member', 1, ?, NULL)`,
  ).run(CHANNEL_ID, BOT_2, AT);
}

function initialManifest(database: M11TestDatabase) {
  const event = database.readOne<{ sequence: number }>(
    `SELECT sequence FROM events
     WHERE aggregate_kind = 'message' AND aggregate_id = ?
       AND type = 'message.appended'`,
    MESSAGE_ID,
  );
  assert.ok(event);
  return directMessageManifest({
    channelId: CHANNEL_ID,
    messageIds: [MESSAGE_ID],
    attachmentIds: [],
    channelSequence: 1,
    eventSequence: event.sequence,
  });
}

function admissionPlan(
  database: M11TestDatabase,
  responseOrder: "parallel" | "sequential",
): CoordinatorAdmissionPlan {
  return Object.freeze({
    version: 1 as const,
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    originMessageId: MESSAGE_ID,
    originEventId: fixtureId("event", 1),
    actorPrincipalId: OWNER_ID,
    visibleParticipantIds: Object.freeze([BOT_ID, BOT_2]),
    selectedTargets: Object.freeze([
      Object.freeze({
        targetBotId: BOT_ID,
        targetBotDisplayName: "Jerry",
        targetPrincipalId: BOT_ID,
        residentBinding: "jerry",
      }),
      Object.freeze({
        targetBotId: BOT_2,
        targetBotDisplayName: "Ada",
        targetPrincipalId: BOT_2,
        residentBinding: "ada",
      }),
    ]),
    responseOrder,
    standingReference: `canonical-channel-membership:${CHANNEL_ID}:version:1`,
    manifest: initialManifest(database),
    turnSelection: Object.freeze({ modelAlias: "gpt-5.6", reasoningEffort: "max" }),
  });
}

function trigger(
  plan: CoordinatorAdmissionPlan,
  input: {
    mentionedBotIds?: readonly string[];
    manifest?: CoordinatorAdmissionPlan["manifest"];
    identitySuffix?: number;
  } = {},
): ChannelTurnTrigger {
  const identitySuffix = input.identitySuffix ?? 800;
  return Object.freeze({
    eventId: plan.originEventId,
    messageId: plan.originMessageId,
    channelId: plan.channelId,
    actorPrincipalId: plan.actorPrincipalId,
    selection: "mentions" as const,
    mentionedBotIds: input.mentionedBotIds ?? plan.selectedTargets.map(
      (target) => target.targetBotId,
    ),
    plannedBotIds: plan.selectedTargets.map((target) => target.targetBotId),
    admissionPlan: plan,
    visibleParticipantIds: plan.visibleParticipantIds,
    standing: Object.freeze({
      source: "trusted_policy_boundary" as const,
      reference: plan.standingReference,
      channelId: plan.channelId,
      allowedParticipantIds: plan.visibleParticipantIds,
      broadcastAllowed: false,
    }),
    authority: AUTHORITY,
    deadlineAt: DEADLINE,
    manifest: input.manifest ?? plan.manifest,
    turnSelection: plan.turnSelection,
    requestId: fixtureId("request", identitySuffix),
    correlationId: fixtureId("correlation", identitySuffix),
  });
}

function replayIdentity(suffix: number) {
  return Object.freeze({
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    actorPrincipalId: OWNER_ID,
    authority: AUTHORITY,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  });
}

function harness(
  database: M11TestDatabase,
  idStart: number,
  durabilityFailpoint?: DurabilityFailpoint,
  now: () => Date = () => new Date(AT),
) {
  const generateId = createFixtureIdGenerator(idStart);
  const work = createWorkService({ database, generateId, now });
  const rounds = createRoundService({ database, generateId, now });
  const leases = createLeaseService({
    database,
    generateId,
    now,
    leaseTtlMs: 60_000,
  });
  const coordinator = createChannelCoordinator({
    database,
    rounds,
    work,
    enabled: true,
    expectedAuthorityWriter: AUTHORITY.writer,
    now,
    ...(durabilityFailpoint === undefined ? {} : { durabilityFailpoint }),
  });
  const context = new SqliteGroupChannelMessageContext(database, {
    async listMessages() {
      throw new Error("durability recovery must not resnapshot mutable Message projections");
    },
  });
  return { coordinator, context, leases, rounds, work };
}


for (const fromReview of [false, true]) test(`group Working Thread ${fromReview ? 'from saved review' : 'from ordinary turn'} retains exact dispatch and one originating result`, async t => {
  const database=M11TestDatabase.temporary();t.after(()=>database.close());prepare(database,'parallel');
  database.raw.prepare("UPDATE bots SET active_instance_id='resident-1',active_key_version=1 WHERE id=?").run(BOT_ID);
  const services=harness(database,80000);
  const started=services.coordinator.start(trigger(admissionPlan(database,'parallel')));
  let parent=started.works.find(row=>row.work.targetPrincipalId===BOT_ID)!.work;
  assert.equal(parent.kind,'channel.bot_turn');
  const ids={requestId:fixtureId('request',81000),correlationId:fixtureId('correlation',81000)};
  let savedReview: { row: NonNullable<ReturnType<ReturnType<typeof createResidentOutcomeStore>['forReview']>>; store: ReturnType<typeof createResidentOutcomeStore>; prepared: Record<string, unknown> } | undefined;
  if (fromReview) {
    database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
    const source = parent;
    // Core saves review context at the current global event watermark, which
    // includes Work events after the last channel Message.
    const eventWatermark = database.readOne<{seq:number}>('SELECT max(sequence) AS seq FROM events')!.seq;
    const manifest = directMessageManifest({channelId:CHANNEL_ID,messageIds:[MESSAGE_ID],attachmentIds:[],channelSequence:1,eventSequence:eventWatermark});
    parent = services.work.create({principalId:source.principalId,targetPrincipalId:source.targetPrincipalId,
      channelId:source.channelId,originMessageId:source.originMessageId,roundId:source.roundId,
      kind:'resident_turn',idempotencyKey:'group-review-idempotency',manifest,maxAutomaticOffers:1,...ids}).work;
    const store = createResidentOutcomeStore(database);
    store.enqueue('work:'+source.id,source.id,{status:'succeeded'});
    const row = store.pending().find(r=>r.sourceWorkId===source.id)!;
    const prepared = {channelId:CHANNEL_ID,conversationId:CONVERSATION_ID,targetPrincipalId:BOT_ID,
      instruction:'Review the saved outcome and follow through',manifest};
    store.update(row,'review_work_id',parent.id);store.update(row,'prepared_json',JSON.stringify(prepared));
    savedReview={row,store,prepared};
  }

  const offered=services.leases.offer({workId:parent.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',authorityReference:'resident:jerry',automatic:true,...ids});
  const binding={workId:parent.id,attemptId:offered.attempt.id,leaseId:offered.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',fencingToken:offered.fencingToken,...ids};
  services.leases.accept(binding);services.leases.start(binding);
  const parentOrigin={kind:'coordination' as const,...binding,authorityReference:'resident:jerry',channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:parent.roundId};
  const credential={residentSlug:'jerry',instanceId:'resident-client',keyVersion:1};
  const admission=createForegroundDetachmentConsumer({database,work:services.work,now:()=>new Date(AT),resolveResident:()=>({clientInstanceId:'resident-client',serverInstanceId:'resident-1',keyVersion:1}),schedule:()=>{}});
  const ack=admission.admit({credential,request:{parentOrigin,residentSlug:'jerry',invocationId:'group-selected',toolName:'spawn_agent',canonicalArgs:{task:'Inspect group assignment'},executionInstruction:'Inspect group assignment',title:'Group assignment',summary:'Inspect group assignment',recoveryPolicy:'safe_before_start'}});
  const child=services.work.get(ack.workId)!;
  assert.equal(child.roundId,parent.roundId);assert.equal(services.work.getPlannedInvocation(child.id)?.parentOrigin.workId,parent.id);
  const recovered=await services.context.recover(child);
  assert.equal(recovered.selectedTargets.length,1);assert.equal(recovered.selectedTargets[0]?.residentBinding,'jerry');
  if (savedReview) {
    assert.equal(recovered.instruction,'Review the saved outcome and follow through');
    savedReview.store.update(savedReview.row,'prepared_json',JSON.stringify({...savedReview.prepared,targetPrincipalId:BOT_2}));
    await assert.rejects(services.context.recover(child),/invalid_relation/);
    savedReview.store.update(savedReview.row,'prepared_json',JSON.stringify(savedReview.prepared));
    savedReview.store.update(savedReview.row,'review_work_id',savedReview.row.sourceWorkId);
    await assert.rejects(services.context.recover(child),/invalid_relation/);
    savedReview.store.update(savedReview.row,'review_work_id',parent.id);
  }

  await assert.rejects(services.context.recover({...child,targetPrincipalId:fixtureId('bot',999)}));
  const botRepository=new SqliteBotDirectoryRepository(database);
  const directory=createBotDirectory({repository:botRepository,now:()=>new Date(AT),availabilityPolicy:{degradedAfterMs:30000,offlineAfterMs:120000}});
  await directory.ensurePersistentBinding({residentBinding:'jerry',name:'Jerry',purpose:'Persistent resident',continuingIdentity:true,durableMailbox:true,requiredCapabilities:['messages'],aliases:[{namespace:'resident',value:'jerry'}]}, {principalId:OWNER_ID,...ids});
  const messages=createMessageService({repository:new SqliteMessagingRepository(database,{botConversationBinding:new SqliteBotConversationBindingAdapter(),messageProvenanceAuthorization:new M11MessageProvenanceAuthority()}),participantDirectory:{listVisibleBots:directory.listVisibleBots,resolveAlias:directory.resolveAlias,getBotByResidentBinding:(slug:string)=>botRepository.getBotByResidentBinding(slug)},now:()=>new Date(AT)});
  let effects=0;
  const response={text:'The group assignment is complete.',model:'fixture',toolCallCount:1,durationMs:1};
  const agent={async runWithTurn(chatId:string,_instruction:string,options:Parameters<ResidentAgentPort['runWithTurn']>[2]) {
    assert.equal(chatId,`coordination:${CHANNEL_ID}:${child.id}`);assert.equal(options.coordinationOrigin.roundId,parent.roundId);
    assert.equal(options.coordinationOrigin.holderPrincipalId,BOT_ID);assert.equal(options.coordinationOrigin.authorityReference,'resident:jerry');
    assert.deepEqual(options.plannedExecution?.canonicalArgs,{task:'Inspect group assignment'});
    assert.equal(options.coordinationWorkDestination?.parentWorkId,child.id);
    await options.onDurableStart({turnId:`coord-${child.id}`,chatId,persistedAt:AT});
    if(!options.completedRecovery){assert.deepEqual(admission.start({credential,origin:options.coordinationOrigin,invocationId:'group-selected'}),{started:true});effects++;}
    return {turnId:`coord-${child.id}`,response:Promise.resolve(response)};
  },stop:()=>({stopped:true})} as ResidentAgentPort;
  const resident=new ResidentCoordinationAdapter(agent,createM11ResidentCoordinationPort(services.leases),()=>new Date(AT));
  let identityCounter=82000;
  const deliveryErrors: unknown[]=[];
  const submission=createDirectMessageSubmissionService({messages:{...messages,sendMessage:async input=>{try{return await messages.sendMessage(input);}catch(error){deliveryErrors.push(error);throw error;}}},context:new SqliteDirectMessageContext(database,messages),work:services.work,leases:services.leases,
    recoverWorkingContext:async work=>{
      const group=await services.context.recover(work);const target=group.selectedTargets.find(row=>row.targetPrincipalId===work.targetPrincipalId)!;
      return {originMessageId:group.originMessageId,prepared:{...target,channelId:group.channelId,conversationId:group.conversationId,instruction:group.instruction,attachments:group.attachments,manifest:group.manifest,historyBackfill:group.transcript.map(message=>({messageId:message.messageId,sequence:message.sequence,role:message.authorPrincipalId===work.targetPrincipalId?'assistant' as const:'user' as const,text:message.text,createdAt:message.createdAt}))}};
    },
    resolveResident:slug=>{assert.equal(slug,'jerry');return {resident,holderInstanceId:'resident-1',models:agent,context:({principalId,requestId,correlationId})=>({principalId,requestId,correlationId,identity:{kind:'resident' as const,resident:{requestId,correlationId,credential:{residentSlug:'jerry',role:'resident' as const,instanceId:'resident-1',keyVersion:1}}}})};},
    authority:{current:()=>({...AUTHORITY,effectiveAtEventSequence:1,rollbackEpoch:1})},beginWork:()=>()=>{},recoveryIdentity:()=>({requestId:fixtureId('request',++identityCounter),correlationId:fixtureId('correlation',identityCounter)}),communications:new SqliteCommunicationEventRepository(database),
  });
  await submission.dispatchWorkingThread(child.id);await submission.awaitSettlement(child.id);
  assert.equal(services.work.get(child.id)?.state,'succeeded');
  await submission.dispatchWorkingThread(child.id);await submission.awaitSettlement(child.id);
  assert.equal(effects,1);
  assert.deepEqual(deliveryErrors,[]);
  const results=database.readAll<{author:string;roundId:string;reply:string;body:string}>("SELECT author_principal_id AS author,round_id AS roundId,reply_to_message_id AS reply,body_text AS body FROM messages WHERE work_id=? AND kind='result'",child.id);
  assert.deepEqual(results,[{author:BOT_ID,roundId:parent.roundId,reply:MESSAGE_ID,body:response.text}]);
});

for(const targetSlug of ['ada','jerry']) test(`Jerry can dispatch joined channel Work to ${targetSlug} and recover one canonical result`,async t=>{
  const database=M11TestDatabase.temporary();t.after(()=>database.close());prepare(database,'parallel');
  const services=harness(database,91000);
  const repo=new SqliteBotDirectoryRepository(database);
  const directory=createBotDirectory({repository:repo,now:()=>new Date(AT),availabilityPolicy:{degradedAfterMs:30000,offlineAfterMs:120000}});
  for(const slug of ['jerry','ada']) await directory.ensurePersistentBinding({residentBinding:slug,name:slug==='jerry'?'Jerry':'Ada',purpose:'Persistent resident',continuingIdentity:true,durableMailbox:true,requiredCapabilities:['messages'],aliases:[{namespace:'resident',value:slug}]},{principalId:OWNER_ID,requestId:fixtureId('request',91970),correlationId:fixtureId('correlation',91970)});
  const messages=createMessageService({repository:new SqliteMessagingRepository(database,{botConversationBinding:new SqliteBotConversationBindingAdapter(),messageProvenanceAuthorization:new M11MessageProvenanceAuthority()}),
    participantDirectory:{listVisibleBots:directory.listVisibleBots,resolveAlias:directory.resolveAlias,getBotByResidentBinding:(slug:string)=>repo.getBotByResidentBinding(slug)},now:()=>new Date(AT)});
  const context=new SqliteGroupChannelMessageContext(database,messages);
  let calls=0;
  const actor=(slug:string,input:{principalId:string;requestId:string;correlationId:string})=>({...input,identity:{kind:'resident' as const,resident:{requestId:input.requestId,correlationId:input.correlationId,
    credential:{residentSlug:slug,role:'resident' as const,instanceId:slug==='jerry'?'resident-1':'resident-2',keyVersion:1}}}});
  const modelCatalog=async()=>({models:[{alias:'default',provider:'fixture',model:'fixture',reasoningEffort:'low' as const}],defaultModel:'fixture',defaultProvider:'fixture',defaultReasoningEffort:'low' as const,reasoningEfforts:['low' as const]});
  const agent:ResidentAgentPort={modelCatalog,async runWithTurn(chatId,instruction,options){
    calls++;assert.ok(instruction.includes('Do this channel assignment'));
    assert.equal(options.coordinationWorkDestination?.parentWorkId,options.coordinationOrigin.workId);
    await options.onDurableStart({turnId:`coord-${options.coordinationOrigin.workId}`,chatId,persistedAt:AT});
    return {turnId:`coord-${options.coordinationOrigin.workId}`,response:Promise.resolve({text:'The channel assignment is done.',model:'fixture',toolCallCount:0,durationMs:1})};
  },stop:()=>({stopped:true})};
  const resident=new ResidentCoordinationAdapter(agent,createM11ResidentCoordinationPort(services.leases),()=>new Date(AT));
  const coordinator=createChannelCoordinator({database,rounds:services.rounds,work:services.work,enabled:true,expectedAuthorityWriter:AUTHORITY.writer,now:()=>new Date(AT),presentation:()=>({title:'Joined assignment',summary:'Channel work'})});
  const options={messages,context,coordinator,work:services.work,leases:services.leases,joinedInvocation:()=>true,
    resolveResident:(slug:string)=>({resident,holderInstanceId:slug==='jerry'?'resident-1':'resident-2',models:{modelCatalog},context:(input:any)=>actor(slug,input)}),
    authority:{current:()=>({...AUTHORITY,effectiveAtEventSequence:1,rollbackEpoch:1})},recordMessage:async()=>{},beginWork:()=>()=>{},now:()=>new Date(AT),
    recoveryIdentity:()=>({requestId:fixtureId('request',91998),correlationId:fixtureId('correlation',91998)})};
  let service=createGroupChannelMessageService(options);
  const submitted=await service.submitMessage({context:actor('jerry',{principalId:BOT_ID,requestId:fixtureId('request',91990),correlationId:fixtureId('correlation',91990)}),channelId:CHANNEL_ID,idempotencyKey:'jerry-joined-dispatch',
    body:{messageId:fixtureId('message',91990),clientMessageId:'jerry-dispatch',text:'Do this channel assignment',attachmentIds:[],mentions:[targetSlug==='jerry'?BOT_ID:BOT_2],replyToMessageId:null,modelAlias:null,reasoningEffort:null}});
  await submitted.response;
  const works=database.readAll<{id:string;state:string}>("SELECT id,state FROM works WHERE origin_message_id=?",fixtureId('message',91990));
  assert.equal(works.length,1);assert.equal(works[0]!.state,'succeeded');assert.equal(calls,1);
  const results=database.readAll<{author:string}>("SELECT author_principal_id AS author FROM messages WHERE work_id=? AND kind='result'",works[0]!.id);
  assert.deepEqual(results,[{author:targetSlug==='jerry'?BOT_ID:BOT_2}]);
  service=createGroupChannelMessageService(options);await service.recoverResidentWork();assert.equal(calls,1);
});
