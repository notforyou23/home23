import { SqliteMessagingRepository, SqliteBotConversationBindingAdapter } from '../../../src/coordination/channels/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { M11MessageProvenanceAuthority } from '../../../src/coordination/work/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { AT,BOT_ID,CHANNEL_ID,MESSAGE_ID,OWNER_ID,M11TestDatabase,createFixtureIdGenerator,fixtureId,manifestInput } from '../work/test-fixture.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';

function setup(kind='resident_turn') {
 const database=M11TestDatabase.temporary(); const now=()=>new Date(AT); const generateId=createFixtureIdGenerator();
 database.raw.prepare("UPDATE bots SET active_instance_id='instance-jerry',active_key_version=1 WHERE id=?").run(BOT_ID);
 const work=createWorkService({database,generateId,now}); const leases=createLeaseService({database,generateId,now,leaseTtlMs:60000});
 const parent=work.create({principalId:OWNER_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,kind,idempotencyKey:'parent-speaking-idempotency',manifest:manifestInput(),maxAutomaticOffers:1,requestId:fixtureId('request',1),correlationId:fixtureId('correlation',1)}).work;
 function start(workId:string):CoordinationTurnOrigin { const ids={requestId:fixtureId('request',2),correlationId:fixtureId('correlation',2)};const offer=leases.offer({workId,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',authorityReference:'resident:jerry',automatic:true,...ids});const binding={workId,attemptId:offer.attempt.id,leaseId:offer.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',fencingToken:offer.fencingToken,...ids};leases.accept(binding);leases.start(binding);return {kind:'coordination',...binding,authorityReference:'resident:jerry',channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null}; }
 const parentOrigin=start(parent.id);const credential={residentSlug:'jerry',instanceId:'client-jerry',keyVersion:1};const scheduled:string[]=[];const consumer=createForegroundDetachmentConsumer({database,work,now,resolveResident:()=>({clientInstanceId:"client-jerry",serverInstanceId:"instance-jerry",keyVersion:1}),schedule:id=>{scheduled.push(id);}});
 const request={parentOrigin,residentSlug:'jerry',invocationId:'call-1',toolName:'spawn_agent',canonicalArgs:{task:'Inspect system'},executionInstruction:'Inspect system',title:'System health',summary:'Inspect system health',recoveryPolicy:'safe_before_start' as const};
 return {database,work,consumer,request,credential,start,scheduled};
}

import { createDirectMessageSubmissionService, type DirectMessageExecutionRequest } from '../../../src/coordination/app/direct-message.js';
import type { ResidentRun } from '../../../src/coordination-adapter/index.js';


import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { createResidentOutcomeStore } from '../../../src/coordination/app/resident-outcomes.js';

for (const scenario of ['succeeded','failed','cancelled','delivery_recovery','review_failure'] as const) {
 const outcome=scenario==='delivery_recovery'||scenario==='review_failure'?'failed':scenario;
 test(`durable ${scenario} outcome wakes accountable resident once with latest corrections`,async t=>{
  const f=setup();t.after(()=>f.database.close());
  f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
  const {workId}=f.consumer.admit({credential:f.credential,request:f.request});
  const origin=outcome==='cancelled'?null:f.start(workId);
  const leases=createLeaseService({database:f.database,generateId:createFixtureIdGenerator(15000),now:()=>new Date(AT),leaseTtlMs:60000});
  const ids={requestId:fixtureId('request',300),correlationId:fixtureId('correlation',300)};
  const binding=(o:CoordinationTurnOrigin)=>({workId:o.workId,attemptId:o.attemptId,leaseId:o.leaseId,holderPrincipalId:o.holderPrincipalId,holderInstanceId:o.holderInstanceId,fencingToken:o.fencingToken,...ids});
  const terminal=(o:CoordinationTurnOrigin,status:'succeeded'|'failed')=>{try{return leases.terminalize({...binding(o),receipt:{status,sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:AT}}).receipt;}catch(e){console.error('terminal:',(e as Error).message);throw e;}};
  if(origin) { f.consumer.start({credential:f.credential,origin,invocationId:f.request.invocationId}); terminal(origin,outcome==='succeeded'?'succeeded':'failed'); }
  else f.work.cancelQueued({workId,actorPrincipalId:OWNER_ID,reasonCode:'operator_stop',sourceReference:'owner:stop',timestamp:AT,...ids});
  f.database.raw.prepare('INSERT INTO conversation_handles(id,channel_id,created_at) VALUES(?,?,?)').run(fixtureId('conversation',1),CHANNEL_ID,AT);
  const bot={id:BOT_ID,principalId:BOT_ID,name:'Jerry',lifecycle:'active',residentBinding:'jerry',continuingIdentity:true,durableMailbox:true,requiredCapabilities:['messages'],activeInstanceId:'instance-jerry',activeKeyVersion:1,residentProtocolVersion:1,residentRegisteredAt:AT,residentCapabilities:['messages']};
  const messages=createMessageService({repository:new SqliteMessagingRepository(f.database,{botConversationBinding:new SqliteBotConversationBindingAdapter(),messageProvenanceAuthorization:new M11MessageProvenanceAuthority()}),participantDirectory:{listVisibleBots:async()=>[bot],resolveAlias:async()=>bot,getBotByResidentBinding:async()=>bot} as any,now:()=>new Date(AT)});
  const residentContext=(x:any)=>({...x,identity:{kind:'resident',resident:{...ids,credential:{residentSlug:'jerry',role:'resident',instanceId:'instance-jerry',keyVersion:1}}}});
  const owner={principalId:OWNER_ID,...ids,identity:{kind:'owner',auth:{principalId:OWNER_ID,deviceId:'dev_0198d95f-6c00-7000-8000-000000000900',sessionId:'ses_0198d95f-6c00-7000-8000-000000000900',scopes:['product:read','message:send']}}} as any;
  if(outcome==='succeeded') await messages.sendMessage({context:residentContext({principalId:BOT_ID,...ids}),channelId:CHANNEL_ID,messageId:`msg_${workId.slice(4)}`,authorPrincipalId:BOT_ID,idempotencyKey:`work-result:${workId}`,kind:'result',text:'worker evidence',mentions:[],clientMessageId:null,replyToMessageId:MESSAGE_ID,tombstonesMessageId:null,provenance:{roundId:null,workId}});
  const latest=(await messages.sendMessage({context:owner,channelId:CHANNEL_ID,messageId:fixtureId('message',500),authorPrincipalId:OWNER_ID,idempotencyKey:'latest-correction-500',kind:'text',text:'Latest correction: preserve my changes.',mentions:[],clientMessageId:null,replyToMessageId:null,tombstonesMessageId:null,provenance:{roundId:null,workId:null}})).message;
  if(outcome==='succeeded') f.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'bot_invocation',aggregateId:MESSAGE_ID,aggregateVersion:1,
    channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,...ids,payload:{origin:{workId},invocationId:'helper-proof',botId:BOT_ID,channelId:CHANNEL_ID},createdAt:AT}}));
  let store=createResidentOutcomeStore(f.database);store.discover();store.discover();assert.equal(store.pending().length,1);
  const row=store.pending()[0];assert.match(row.evidence,new RegExp(outcome));
  if(outcome==='succeeded') {
    const delivered=JSON.parse(row.evidence).helperDeliveries.find((d:any)=>d.messageId===`msg_${workId.slice(4)}`);
    assert.equal(delivered.verifiedDelivery,true);assert.equal(delivered.authorPrincipalId,BOT_ID);
    assert.equal(delivered.channelId,CHANNEL_ID);assert.equal(delivered.text,'worker evidence');
  }
  f.database.reopen();store=createResidentOutcomeStore(f.database);assert.equal(store.pending().length,1);
  const posted=new Map<string,any>();let calls=0;let seen:DirectMessageExecutionRequest|undefined;
  const response={text:'I checked the outcome and closed the loop.',model:'fixture',toolCallCount:0,durationMs:1};
  let savedReceipt:any;
  const execute=async(input:DirectMessageExecutionRequest):Promise<ResidentRun>=>{
   calls++;seen=input;
   const b=binding(input.origin);leases.accept(b);leases.start(b);
   const receipt=terminal(input.origin,scenario==='review_failure'?'failed':'succeeded'); savedReceipt=receipt;
   return {turnId:'review',response:scenario==='review_failure'?Promise.reject(new Error('fixture review interruption')):Promise.resolve(response),receipt:Promise.resolve(receipt)};
  };
  const prepared={channelId:CHANNEL_ID,conversationId:fixtureId('conversation',1),targetBotId:BOT_ID,targetBotDisplayName:'Jerry',targetPrincipalId:BOT_ID,residentBinding:'jerry',instruction:'Finish the requested task, do not publish.',historyBackfill:[],attachments:[],manifest:manifestInput()};
  let deliveryAttempts=0;
  const service=createDirectMessageSubmissionService({outcomes:store,work:f.work,leases,
   context:{resolveTarget:async()=>prepared,prepare:async()=>prepared,recover:async()=>({prepared,originMessageId:MESSAGE_ID})},
   messages:{listMessages:async()=>({messages:[latest]}),
    getMessage:async input=>posted.get(input.messageId)??null,
    sendMessage:async input=>{if(scenario==='delivery_recovery'&&deliveryAttempts++===0)throw new Error('delivery connection lost');const message={...input,id:input.messageId} as any;posted.set(message.id,message);return {outcome:'committed',message,receipt:{eventSequence:1}};}},
   resolveResident:()=>({resident:{execute,continueAccepted:execute,reattach:execute,recoverCompleted:async()=>({turnId:'review',response:Promise.resolve(response),receipt:Promise.resolve(savedReceipt)})},holderInstanceId:'instance-jerry',models:{modelCatalog:async()=>({}) as any},context:(x:any)=>x}),
   authority:{current:()=>({capability:'messages',epoch:3,mode:'canonical',writer:'home23-coordination',effectiveAtEventSequence:41,rollbackEpoch:1}) as any},beginWork:()=>()=>{},recoveryIdentity:()=>ids,
  });
  await service.processResidentOutcomes();assert.equal(calls,0,'active speaking parent takes priority');
  terminal(f.request.parentOrigin,'succeeded');
  await service.processResidentOutcomes();
  const review=store.pending()[0].reviewWorkId!;await service.awaitSettlement(review);
  await service.processResidentOutcomes();await service.awaitSettlement(review);await service.processResidentOutcomes();
  assert.equal(calls,1);assert.equal(posted.size,1);assert.equal(store.pending().length,0);
  assert.match(seen!.instruction,/INTERNAL WORK OUTCOME/);assert.match(seen!.instruction,/do not publish/);
  assert.match(seen!.instruction,/owner has said Stop/);assert.match(JSON.stringify(seen!.historyBackfill),/Latest correction/);
  assert.equal(seen!.plannedExecution,undefined,'review cannot replay the original planned tool');
 });
}

test('scheduled terminal Work enters the durable Jerry inbox once after restart',t=>{
  const f=setup('channel.bot_turn');t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
  const origin=f.request.parentOrigin;
  f.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'scheduled_channel_run',aggregateId:'sched-run-fixture',aggregateVersion:1,
    channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',991),correlationId:fixtureId('correlation',991),
    payload:{runId:'sched-run-fixture',jobId:'editorial',messageId:MESSAGE_ID,channelId:CHANNEL_ID,prompt:'Prepare the saved draft',botId:BOT_ID},createdAt:AT}}));
  const leases=createLeaseService({database:f.database,generateId:createFixtureIdGenerator(99000),now:()=>new Date(AT),leaseTtlMs:60000});
  leases.terminalize({workId:origin.workId,attemptId:origin.attemptId,leaseId:origin.leaseId,holderPrincipalId:origin.holderPrincipalId,holderInstanceId:origin.holderInstanceId,
    fencingToken:origin.fencingToken,requestId:fixtureId('request',992),correlationId:fixtureId('correlation',992),
    receipt:{status:'failed',sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:AT}});
  let store=createResidentOutcomeStore(f.database);store.discover();assert.equal(store.pending().length,1);
  assert.match(store.pending()[0]!.key,/^scheduled:/);assert.match(store.pending()[0]!.evidence,/editorial/);
  f.database.reopen();store=createResidentOutcomeStore(f.database);store.discover();assert.equal(store.pending().length,1);
});


test('resident review sharing a scheduled origin cannot recursively wake itself',t=>{
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
 f.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'scheduled_channel_run',aggregateId:'sched-review-loop',aggregateVersion:1,
 channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',999),correlationId:fixtureId('correlation',999),payload:{messageId:MESSAGE_ID},createdAt:AT}}));
 const o=f.request.parentOrigin;const leases=createLeaseService({database:f.database,generateId:createFixtureIdGenerator(99000),now:()=>new Date(AT),leaseTtlMs:60000});
 leases.terminalize({workId:o.workId,attemptId:o.attemptId,leaseId:o.leaseId,holderPrincipalId:o.holderPrincipalId,holderInstanceId:o.holderInstanceId,fencingToken:o.fencingToken,requestId:fixtureId('request',998),correlationId:fixtureId('correlation',998),receipt:{status:'failed',sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:AT}});
 const store=createResidentOutcomeStore(f.database);store.discover();assert.equal(store.pending().length,0);
});


for(const offered of [false,true]) test(`obsolete scheduled review is retired before dispatch; offered=${offered}`,async t=>{
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 const store=createResidentOutcomeStore(f.database);const source=f.request.parentOrigin.workId;
 store.enqueue(`scheduled:${source}`,source,{status:'succeeded'});let row=store.pending()[0]!;
 const review=f.work.create({principalId:OWNER_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,kind:'resident_turn',idempotencyKey:'obsolete-review-fixture',manifest:manifestInput(),maxAutomaticOffers:1,requestId:fixtureId('request',880),correlationId:fixtureId('correlation',880)}).work;
 store.update(row,'review_work_id',review.id);
 store.update(row,'prepared_json',JSON.stringify({instruction:'old recursive context '.repeat(20000)}));
 const leases=createLeaseService({database:f.database,generateId:createFixtureIdGenerator(99000),now:()=>new Date(AT),leaseTtlMs:60000});
 if(offered)leases.offer({workId:review.id,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',authorityReference:'resident:jerry',automatic:true,requestId:fixtureId('request',881),correlationId:fixtureId('correlation',881)});
 const forbid=()=>{throw new Error('Obsolete review attempted context recovery or execution');};
 const service=createDirectMessageSubmissionService({outcomes:store,work:f.work,leases,context:{resolveTarget:forbid,prepare:forbid,recover:forbid},messages:{listMessages:forbid,sendMessage:forbid},resolveResident:forbid,
 authority:{current:()=>({capability:'messages',epoch:3,mode:'canonical',writer:'home23-coordination',effectiveAtEventSequence:41,rollbackEpoch:1}) as any},beginWork:forbid,recoveryIdentity:()=>({requestId:fixtureId('request',882),correlationId:fixtureId('correlation',882)})});
 await service.processResidentOutcomes();assert.equal(f.work.get(review.id)!.state,'cancelled');assert.equal(store.pending().length,0);
 f.database.reopen();await service.processResidentOutcomes();assert.equal(f.work.get(review.id)!.state,'cancelled');
});
