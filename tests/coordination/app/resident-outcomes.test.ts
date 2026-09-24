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
import { createResidentOutcomeStore, workTerminalEvidence, residentOutcomeInstruction } from '../../../src/coordination/app/resident-outcomes.js';

test('idle outcome discovery does not rescan terminal Work and scheduled runs', t => {
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 const original=f.database.readAll.bind(f.database);
 let terminalScans=0;
 f.database.readAll=((sql:string,...params:unknown[])=>{
  if(sql.includes('FROM works WHERE rowid > ?') || sql.includes('FROM events WHERE sequence > ? AND sequence <= ?')) terminalScans++;
  return original(sql,...params);
 }) as typeof f.database.readAll;
 const store=createResidentOutcomeStore(f.database);
 store.discover();assert.equal(terminalScans,2,'startup recovers existing terminal work');
 store.discover();assert.equal(terminalScans,2,'idle tick reads only the event cursor');
 f.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'scheduled_channel_run',
  aggregateId:'sched-outcome-cursor',aggregateVersion:1,channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,
  requestId:fixtureId('request',999),correlationId:fixtureId('correlation',999),
  payload:{messageId:fixtureId('message',999)},createdAt:AT}}));
 store.discover();assert.equal(terminalScans,2,'new scheduled admission resolves its exact Work without a global rescan');
});

test('startup recovery advances through irrelevant event history in bounded pages', t => {
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 for(let n=0;n<130;n++)f.database.mutateWithEvent(()=>({value:undefined,event:{
  type:'activity.updated',aggregateKind:'irrelevant_history',aggregateId:`history-${n}`,aggregateVersion:1,
  channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',5000+n),
  correlationId:fixtureId('correlation',5000+n),payload:{large:'x'.repeat(1000)},createdAt:AT,
 }}));
 const original=f.database.readAll.bind(f.database);
 const pageStarts:number[]=[];
 f.database.readAll=((sql:string,...params:unknown[])=>{
  if(sql.includes('FROM events WHERE sequence > ? AND sequence <= ?')) pageStarts.push(params[0] as number);
  return original(sql,...params);
 }) as typeof f.database.readAll;
 const store=createResidentOutcomeStore(f.database);
 for(let n=0;n<4;n++)store.discover();
 assert.ok(pageStarts.length >= 3,'history is drained across calls rather than one broad scan');
 assert.equal(pageStarts[0],0);
 assert.ok(pageStarts[1]! > pageStarts[0]! && pageStarts[2]! > pageStarts[1]!);
 assert.equal(store.pending().length,0);
});

test('a short Work recovery page is not complete until every candidate is visited', t => {
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
 for(let n=0;n<5;n++){
  const {workId}=f.consumer.admit({credential:f.credential,request:{...f.request,
   invocationId:`short-page-${n}`,canonicalArgs:{task:`Historical ${n}`}}});
  f.work.cancelQueued({workId,actorPrincipalId:OWNER_ID,reasonCode:'operator_stop',sourceReference:'owner:stop',timestamp:AT,
   requestId:fixtureId('request',6000+n),correlationId:fixtureId('correlation',6000+n)});
 }
 f.database.raw.prepare('UPDATE resident_outcome_policy SET event_cursor=(SELECT max(sequence) FROM events)').run();
 const store=createResidentOutcomeStore(f.database);
 store.discover();assert.equal(store.pending().length,4);
 store.discover();assert.equal(store.pending().length,5,'the fifth candidate remains recoverable');
});

test('a short scheduled recovery page resumes after the fourth admission', t => {
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 for(let n=0;n<5;n++){
  f.database.mutateWithEvent(()=>({value:undefined,event:{
   type:'activity.updated',aggregateKind:'scheduled_channel_run',aggregateId:`short-schedule-${n}`,aggregateVersion:1,
   channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',7000+n),
   correlationId:fixtureId('correlation',7000+n),payload:{messageId:fixtureId('message',7000+n)},createdAt:AT,
  }}));
 }
 const fourth=f.database.readOne<{sequence:number}>('SELECT sequence FROM events WHERE aggregate_id=?','short-schedule-3')!.sequence;
 f.database.raw.prepare('UPDATE resident_outcome_policy SET event_cursor=(SELECT max(sequence) FROM events)').run();
 const original=f.database.readAll.bind(f.database);const starts:number[]=[];
 f.database.readAll=((sql:string,...params:unknown[])=>{
  if(sql.includes('FROM events WHERE sequence > ? AND sequence <= ?'))starts.push(params[0] as number);
  return original(sql,...params);
 }) as typeof f.database.readAll;
 const store=createResidentOutcomeStore(f.database);
 store.discover();store.discover();
 assert.deepEqual(starts,[0,fourth],'the fifth scheduled admission is visited on the next tick');
});

test('terminal Work created after startup enters the durable outcome inbox',t=>{
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
 const store=createResidentOutcomeStore(f.database);
 store.discover();
 const {workId}=f.consumer.admit({credential:f.credential,request:f.request});
 f.work.cancelQueued({workId,actorPrincipalId:OWNER_ID,reasonCode:'operator_stop',sourceReference:'owner:stop',timestamp:AT,
  requestId:fixtureId('request',800),correlationId:fixtureId('correlation',800)});
 store.discover();
 assert.equal(store.pending().length,1);
 assert.equal(store.pending()[0]!.key,`work:${workId}`);
 store.discover();
 assert.equal(store.pending().length,1,'incremental event replay stays idempotent');
});

test('startup recovery drains more than one hundred historical terminal Works in bounded pages',t=>{
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
 for(let n=0;n<105;n++){
  const {workId}=f.consumer.admit({credential:f.credential,request:{...f.request,
   invocationId:`historical-${n}`,canonicalArgs:{task:`Historical ${n}`}}});
  f.work.cancelQueued({workId,actorPrincipalId:OWNER_ID,reasonCode:'operator_stop',sourceReference:'owner:stop',timestamp:AT,
   requestId:fixtureId('request',1000+n),correlationId:fixtureId('correlation',1000+n)});
 }
 const store=createResidentOutcomeStore(f.database);
 const count=()=>f.database.readOne<{value:number}>('SELECT count(*) AS value FROM resident_outcomes')!.value;
 store.discover({startup:true});
 assert.equal(count(),16,'pre-bind work is capped at one small page');
 for(let n=0;n<30;n++)store.discover();
 assert.equal(count(),105,'the remaining frozen Work is recovered after bind');
 store.discover();
 assert.equal(count(),105,'recovery stays idempotent');
});

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
  assert.match(seen!.instruction,/latest top-level ownerMessageSequence/);
  assert.match(seen!.instruction,/historical conclusion is not the current owner direction/);
  assert.equal(seen!.plannedExecution,undefined,'review cannot replay the original planned tool');
 });
}

test('pending outcome pages advance past one hundred blocked rows without changing their evidence',t=>{
 const f=setup();t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
 const store=createResidentOutcomeStore(f.database);const source=f.request.parentOrigin.workId;
 for(let n=0;n<126;n++)store.enqueue(`blocked-${String(n).padStart(3,'0')}`,source,{number:n});
 const seen:string[]=[];let cursor:null|{createdAt:string;key:string}=null;
 for(let n=0;n<6;n++){
  const page=store.pendingPage(cursor,25);
  seen.push(...page.map(row=>row.key));
  if(page.length)cursor={createdAt:page.at(-1)!.createdAt,key:page.at(-1)!.key};
 }
 assert.equal(seen.length,126);assert.equal(new Set(seen).size,126);
 assert.ok(seen.includes('blocked-125'));
 assert.deepEqual(JSON.parse(store.pending().find(row=>row.key==='blocked-000')!.evidence),{number:0});
 const first=store.pending()[0]!;store.update(first,'settled_at',new Date().toISOString());
 assert.notEqual(store.pendingPage(null,1)[0]!.key,first.key);
});

test('failed historical Bot outcomes cool down while a newer outcome reaches review',async t=>{
 const originalWarn=console.warn;console.warn=()=>{};t.after(()=>{console.warn=originalWarn;});
 const rows=Array.from({length:101},(_,n)=>({
  key:`blocked-${String(n).padStart(3,'0')}`,createdAt:AT,sourceWorkId:'source-work',
  evidence:'{}',reviewWorkId:null,prepared:JSON.stringify({
   channelId:CHANNEL_ID,conversationId:fixtureId('conversation',1),targetBotId:BOT_ID,
   targetBotDisplayName:'Jerry',targetPrincipalId:BOT_ID,
   residentBinding:n===100?'jerry':'bot-stale',instruction:'Review',historyBackfill:[],attachments:[],
   manifest:manifestInput(),
  }),
 }));
 let oldAttempts=0,newAttempts=0;
 const store={discover(){},busy(){return false;},pendingPage(after:{createdAt:string;key:string}|null,limit:number){
  return rows.filter(row=>after===null||row.createdAt>after.createdAt||
   (row.createdAt===after.createdAt&&row.key>after.key)).slice(0,limit);
 }};
 const service=createDirectMessageSubmissionService({
  outcomes:store as any,work:{get:()=>({originMessageId:MESSAGE_ID,kind:'channel.bot_turn',channelId:CHANNEL_ID,targetPrincipalId:BOT_ID})} as any,
  leases:{} as any,messages:{} as any,context:{} as any,
  resolveResident:()=>undefined,resolveExecutionTarget:descriptor=>{
   if(descriptor.residentBinding==='bot-stale'){
    oldAttempts++;throw new Error('direct-message Bot is not an active processless identity');
   }
   newAttempts++;throw new Error('newer outcome reached review');
  },authority:{current:()=>({capability:'messages',epoch:3,mode:'canonical',writer:'home23-coordination',effectiveAtEventSequence:41,rollbackEpoch:1}) as any},
  beginWork:()=>()=>{},recoveryIdentity:()=>({requestId:fixtureId('request',901),correlationId:fixtureId('correlation',901)}),
 } as any);
 for(let n=0;n<26;n++){
  const attemptsBeforeTick=oldAttempts+newAttempts;
  await service.processResidentOutcomes();
  assert.ok(oldAttempts+newAttempts-attemptsBeforeTick<=4,'one timer turn must bound synchronous recovery');
 }
 assert.equal(oldAttempts,100);assert.equal(newAttempts,1);
 await service.processResidentOutcomes();
 assert.equal(oldAttempts,100,'cooled old outcomes must not retry on immediate wrap');
 assert.equal(rows.length,101,'the authoritative pending rows are untouched');
});

test('scheduled terminal Work enters the durable Jerry inbox once after restart',t=>{
  const f=setup('channel.bot_turn');t.after(()=>f.database.close());f.database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  f.database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
  let store=createResidentOutcomeStore(f.database);store.discover();
  const origin=f.request.parentOrigin;
  f.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'scheduled_channel_run',aggregateId:'sched-run-fixture',aggregateVersion:1,
    channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',991),correlationId:fixtureId('correlation',991),
    payload:{runId:'sched-run-fixture',jobId:'editorial',messageId:MESSAGE_ID,channelId:CHANNEL_ID,prompt:'Prepare the saved draft',botId:BOT_ID},createdAt:AT}}));
  const leases=createLeaseService({database:f.database,generateId:createFixtureIdGenerator(99000),now:()=>new Date(AT),leaseTtlMs:60000});
  leases.terminalize({workId:origin.workId,attemptId:origin.attemptId,leaseId:origin.leaseId,holderPrincipalId:origin.holderPrincipalId,holderInstanceId:origin.holderInstanceId,
    fencingToken:origin.fencingToken,requestId:fixtureId('request',992),correlationId:fixtureId('correlation',992),
    receipt:{status:'failed',sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:AT}});
  const record = (n: number, attemptId: string, sourceEventType: string, payload: unknown) => {
    f.database.mutateWithEvent(() => ({ value: undefined, event: {
      type: 'communication.recorded', aggregateKind: 'communication', aggregateId: `terminal-evidence-${n}`, aggregateVersion: 1,
      channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: fixtureId('request', 1000+n), correlationId: fixtureId('correlation', 1000+n),
      payload: { communication: { workId: origin.workId, attemptId, source: { sourceEventType }, terminal: true, payload } }, createdAt: AT,
    } }));
  };
  record(1, origin.attemptId, 'turn.terminal', {
    status: 'failed', residentTerminal: { status: 'error', errorCode: 'provider_error', errorMessage: 'terminated' },
  });
  // A later tool result or another attempt must not replace the actual cause.
  record(2, origin.attemptId, 'agent.tool_result', { errorMessage: 'unrelated tool error' });
  record(3, 'another-attempt', 'turn.terminal', { errorMessage: 'stale attempt error' });
  const expected = workTerminalEvidence(f.database, origin.workId);
  assert.equal(expected.length, 1);
  assert.match(JSON.stringify(expected), /provider_error/);
  assert.doesNotMatch(JSON.stringify(expected), /unrelated tool error|stale attempt error/);
  assert.deepEqual(workTerminalEvidence(f.database, 'unknown-work'), []);
  store.discover();assert.equal(store.pending().length,1);
  const evidence = JSON.parse(store.pending()[0]!.evidence);
  assert.equal(evidence.reason, 'receipt_failed');
  assert.equal(evidence.result, null);
  assert.deepEqual(evidence.terminalEvidence, expected);
  const instruction = residentOutcomeInstruction('Prepare the saved draft', store.pending()[0]!.evidence, origin.workId);
  assert.match(instruction, /provider_error/);
  assert.match(instruction, /does not mean receipt persistence or work_report_outcome failed/);
  assert.match(instruction, /does not update project files/);
  assert.match(store.pending()[0]!.key,/^scheduled:/);assert.match(store.pending()[0]!.evidence,/editorial/);
  f.database.reopen();store=createResidentOutcomeStore(f.database);store.discover();assert.equal(store.pending().length,1);
  assert.deepEqual(JSON.parse(store.pending()[0]!.evidence).terminalEvidence, expected);
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
