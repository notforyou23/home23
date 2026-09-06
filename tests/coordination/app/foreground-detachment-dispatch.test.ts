import assert from 'node:assert/strict';
import test from 'node:test';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { AT,BOT_ID,CHANNEL_ID,MESSAGE_ID,OWNER_ID,M11TestDatabase,createFixtureIdGenerator,fixtureId,manifestInput } from '../work/test-fixture.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';

function setup() {
 const database=M11TestDatabase.temporary(); const now=()=>new Date(AT); const generateId=createFixtureIdGenerator();
 database.raw.prepare("UPDATE bots SET active_instance_id='instance-jerry',active_key_version=1 WHERE id=?").run(BOT_ID);
 const work=createWorkService({database,generateId,now}); const leases=createLeaseService({database,generateId,now,leaseTtlMs:60000});
 const parent=work.create({principalId:OWNER_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,kind:'resident_turn',idempotencyKey:'parent-speaking-idempotency',manifest:manifestInput(),maxAutomaticOffers:1,requestId:fixtureId('request',1),correlationId:fixtureId('correlation',1)}).work;
 function start(workId:string):CoordinationTurnOrigin { const ids={requestId:fixtureId('request',2),correlationId:fixtureId('correlation',2)};const offer=leases.offer({workId,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',authorityReference:'resident:jerry',automatic:true,...ids});const binding={workId,attemptId:offer.attempt.id,leaseId:offer.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',fencingToken:offer.fencingToken,...ids};leases.accept(binding);leases.start(binding);return {kind:'coordination',...binding,authorityReference:'resident:jerry',channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null}; }
 const parentOrigin=start(parent.id);const credential={residentSlug:'jerry',instanceId:'client-jerry',keyVersion:1};const scheduled:string[]=[];const consumer=createForegroundDetachmentConsumer({database,work,now,resolveResident:()=>({clientInstanceId:"client-jerry",serverInstanceId:"instance-jerry",keyVersion:1}),schedule:id=>{scheduled.push(id);}});
 const request={parentOrigin,residentSlug:'jerry',invocationId:'call-1',toolName:'spawn_agent',canonicalArgs:{task:'Inspect system'},executionInstruction:'Inspect system',title:'System health',summary:'Inspect system health',recoveryPolicy:'safe_before_start' as const};
 return {database,work,consumer,request,credential,start,scheduled};
}

import { createDirectMessageSubmissionService, type DirectMessageExecutionRequest } from '../../../src/coordination/app/direct-message.js';
import type { ResidentRun } from '../../../src/coordination-adapter/index.js';

function dispatcher(f: ReturnType<typeof setup>, execute: (input: DirectMessageExecutionRequest) => Promise<ResidentRun>, resultMessages?: import('../../../src/coordination/app/direct-message.js').DirectMessageMessagePort) {
 let posts=0; const prepared={channelId:CHANNEL_ID,conversationId:fixtureId('conversation',1),targetBotId:BOT_ID,targetBotDisplayName:'Jerry',targetPrincipalId:BOT_ID,residentBinding:'jerry',instruction:'Original instruction',historyBackfill:[],attachments:[],manifest:manifestInput()};
 const context={resolveTarget:async()=>prepared,prepare:async()=>prepared,recover:async()=>({prepared,originMessageId:MESSAGE_ID})};
 const service=createDirectMessageSubmissionService({work:f.work,leases:createLeaseService({database:f.database,generateId:createFixtureIdGenerator(9000),now:()=>new Date(AT),leaseTtlMs:60000}),context,
 messages:resultMessages ?? {listMessages:async()=>({messages:[]}),sendMessage:async()=>{posts++;throw new Error('unexpected Chat result');}},
 resolveResident:()=>({resident:{execute,continueAccepted:execute,reattach:execute,recoverCompleted:execute},holderInstanceId:'instance-jerry',models:{modelCatalog:async()=>{throw new Error('unused');}},context:({principalId,requestId,correlationId})=>({principalId,requestId,correlationId,identity:{kind:'resident',resident:{requestId,correlationId,credential:{residentSlug:'jerry',role:'resident',instanceId:'client-jerry',keyVersion:1}}}})}),
 authority:{current:()=>({capability:'messages',epoch:3,mode:'canonical',writer:'home23-coordination',effectiveAtEventSequence:41,rollbackEpoch:1})},beginWork:()=>()=>{},recoveryIdentity:()=>({requestId:fixtureId('request',88),correlationId:fixtureId('correlation',88)})});
 return {service,posts:()=>posts};
}

test('after-start connection uncertainty fails canonical Work without tool replay or Chat machinery',async t=>{
 const f=setup(); t.after(()=>f.database.close()); const {workId}=f.consumer.admit({credential:f.credential,request:f.request});const origin=f.start(workId);
 f.consumer.start({credential:f.credential,origin,invocationId:f.request.invocationId});f.database.reopen();
 let reconnects=0;const d=dispatcher(f,async input=>{reconnects++;assert.equal(input.plannedExecution?.toolName,'spawn_agent');assert.deepEqual(input.plannedExecution?.canonicalArgs,f.request.canonicalArgs);throw new Error('resident has no result receipt after connection loss');});
 await d.service.dispatchWorkingThread(workId); await d.service.awaitSettlement(workId);
 assert.equal(f.work.get(workId)?.state,'failed');assert.equal(reconnects,1);assert.equal(d.posts(),0);
 await d.service.dispatchWorkingThread(workId);assert.equal(reconnects,1);
 assert.equal(f.database.readOne<{n:number}>('SELECT count(*) AS n FROM terminal_receipts WHERE work_id=?',workId)?.n,1);
});

test('queued planned invocation reaches exact execution envelope once across repeated admission scheduling',async t=>{
 const f=setup(); t.after(()=>f.database.close());const {workId}=f.consumer.admit({credential:f.credential,request:f.request});let calls=0;let reject!: (error:Error)=>void;
 const blocked=new Promise<ResidentRun>((_,r)=>{reject=r;});const d=dispatcher(f,async input=>{calls++;assert.equal(input.coordinationWorkDestination?.parentWorkId,workId);assert.deepEqual(input.plannedExecution?.canonicalArgs,f.request.canonicalArgs);return blocked;});
 await d.service.dispatchWorkingThread(workId);await d.service.dispatchWorkingThread(workId);assert.equal(calls,1);reject(new Error('injected transport startup failure'));await d.service.awaitSettlement(workId);assert.equal(d.posts(),0);assert.equal(f.work.get(workId)?.state,'leased');assert.equal(f.work.getInvocationExecution(workId),null);
 await d.service.dispatchWorkingThread(workId);await d.service.awaitSettlement(workId);assert.equal(calls,2);assert.equal(f.work.getInvocationExecution(workId),null);
});


test('planned completed recovery uses stable Work result identity and exactly one committed message',async t=>{
 const f=setup(); t.after(()=>f.database.close());const {workId}=f.consumer.admit({credential:f.credential,request:f.request});const origin=f.start(workId);f.consumer.start({credential:f.credential,origin,invocationId:f.request.invocationId});
 const leases=createLeaseService({database:f.database,generateId:createFixtureIdGenerator(9500),now:()=>new Date(AT),leaseTtlMs:60000});
 const receipt=leases.terminalize({workId:origin.workId,attemptId:origin.attemptId,leaseId:origin.leaseId,holderPrincipalId:origin.holderPrincipalId,holderInstanceId:origin.holderInstanceId,fencingToken:origin.fencingToken,requestId:fixtureId('request',95),correlationId:fixtureId('correlation',95),receipt:{status:'succeeded',sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:AT}}).receipt;
 let committed=0;const seen=new Set<string>();const results:import('../../../src/coordination/app/direct-message.js').DirectMessageMessagePort={listMessages:async()=>({messages:[]}),sendMessage:async input=>{
  assert.equal(input.idempotencyKey,`work-result:${workId}`);assert.equal(input.messageId,`msg_${workId.slice(4)}`);assert.equal(input.replyToMessageId,MESSAGE_ID);assert.equal(input.provenance.workId,workId);
  const replayed=seen.has(input.idempotencyKey);if(!replayed){committed++;seen.add(input.idempotencyKey);}
  return {outcome:replayed?'replayed':'committed',message:{id:input.messageId} as import('../../../src/coordination/channels/index.js').MessageProjection,receipt:{eventSequence:1}};
 }};
 let recoveries=0;const d=dispatcher(f,async input=>{recoveries++;assert.equal(input.plannedExecution?.invocationId,f.request.invocationId);return {turnId:'fixture',response:Promise.resolve({text:'Verified health summary',model:'fixture',toolCallCount:1,durationMs:1}),receipt:Promise.resolve(receipt)};},results);
 await d.service.dispatchWorkingThread(workId);await d.service.awaitSettlement(workId);await d.service.dispatchWorkingThread(workId);await d.service.awaitSettlement(workId);
 assert.equal(committed,1);assert.equal(recoveries,2);
});
