import assert from 'node:assert/strict';
import test from 'node:test';

function newerOwnerMessage(f: ReturnType<typeof setup>) {
 f.database.mutateWithEvent(tx => { tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,
 author_display_name,kind,body_text,stored_visibility,created_at)
 VALUES(?,?,2,'user_owner','owner','Owner','text','Take a beat. Just respond.','visible',?)`
 ,fixtureId('message',900),CHANNEL_ID,AT);
 return {value:undefined,event:{type:'message.appended',aggregateKind:'message',aggregateId:fixtureId('message',900),aggregateVersion:1,
 channelId:CHANNEL_ID,actorPrincipalId:OWNER_ID,requestId:fixtureId('request',900),correlationId:fixtureId('correlation',900),payload:{},createdAt:AT}}; });
}

test('new owner direction prevents an older review from launching another worker', t => {
 const f=setup();t.after(()=>f.database.close());newerOwnerMessage(f);
 assert.throws(()=>f.consumer.admit({credential:f.credential,request:f.request}),/Owner direction changed/);
 assert.equal(f.database.readOne<{n:number}>("SELECT count(*) AS n FROM works WHERE kind='resident_work_thread'")?.n,0);
 assert.equal(f.scheduled.length,0);
});

test('a queued child cannot cross the execution boundary after newer owner direction', t => {
 const f=setup();t.after(()=>f.database.close());const ack=f.consumer.admit({credential:f.credential,request:f.request});
 newerOwnerMessage(f);const origin=f.start(ack.workId);
 assert.throws(()=>f.consumer.start({credential:f.credential,origin,invocationId:f.request.invocationId}),/Owner direction changed/);
 assert.equal(f.work.getInvocationExecution(ack.workId),null);
});
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
test('admission atomically persists immutable intent and lineage; retry and durable start execute once',t=>{
 const f=setup();t.after(()=>f.database.close());const ack=f.consumer.admit({credential:f.credential,request:f.request});
 assert.equal(f.work.get(ack.workId)?.state,'queued');assert.deepEqual(f.work.getPlannedInvocation(ack.workId)?.canonicalArgs,{task:'Inspect system'});
 assert.equal(f.database.readOne<{id:string}>('SELECT parent_work_id AS id FROM work_planned_invocations WHERE work_id=?',ack.workId)?.id,f.request.parentOrigin.workId);
 assert.deepEqual(f.consumer.admit({credential:f.credential,request:f.request}),ack);
 assert.throws(()=>f.consumer.admit({credential:f.credential,request:{...f.request,canonicalArgs:{task:'changed'}}}),/replay changed/);
 assert.throws(()=>f.consumer.admit({credential:{...f.credential,instanceId:'forged'},request:f.request}),/configured harness/);
 assert.throws(()=>f.database.raw.prepare("UPDATE work_planned_invocations SET invocation_id='other' WHERE work_id=?").run(ack.workId),/immutable/);
 const origin=f.start(ack.workId);assert.deepEqual(f.consumer.start({credential:f.credential,origin,invocationId:'call-1'}),{started:true});
 assert.deepEqual(f.consumer.start({credential:f.credential,origin,invocationId:'call-1'}),{started:false});
 f.database.reopen();assert.equal(f.work.getInvocationExecution(ack.workId)?.invocationId,'call-1');
});
test('stale authority and transaction failure expose no child or wake intent',t=>{
 const f=setup();t.after(()=>f.database.close());
 assert.throws(()=>f.consumer.admit({credential:f.credential,request:{...f.request,parentOrigin:{...f.request.parentOrigin,fencingToken:5}}}),/current authenticated resident fence/);
 f.database.raw.exec("CREATE TRIGGER test_reject_assignment BEFORE INSERT ON work_planned_invocations BEGIN SELECT RAISE(ABORT, 'injected assignment failure'); END;");
 assert.throws(()=>f.consumer.admit({credential:f.credential,request:f.request}),/injected assignment failure/);
 assert.equal(f.database.readOne<{n:number}>("SELECT count(*) AS n FROM works WHERE kind='resident_work_thread'")?.n,0);
 assert.equal(f.database.readOne<{n:number}>('SELECT count(*) AS n FROM context_manifests')?.n,1);
 assert.equal(f.database.readOne<{n:number}>('SELECT count(*) AS n FROM outbox')?.n,1);
 assert.equal(f.scheduled.length,0);
});

test('only an idempotent operation can reclaim execution permission under the current fence', t => {
 const f=setup();t.after(()=>f.database.close());
 const request={...f.request,toolName:'research_launch',canonicalArgs:{topic:'fixture',context:'fixture'},recoveryPolicy:'idempotent_operation' as const};
 const ack=f.consumer.admit({credential:f.credential,request});const origin=f.start(ack.workId);
 assert.deepEqual(f.consumer.start({credential:f.credential,origin,invocationId:request.invocationId}),{started:true});
 f.database.reopen();
 assert.deepEqual(f.consumer.start({credential:f.credential,origin,invocationId:request.invocationId}),{started:true});
 assert.throws(()=>f.consumer.start({credential:f.credential,origin:{...origin,fencingToken:origin.fencingToken+1},invocationId:request.invocationId}),/current authenticated resident fence/);
 assert.equal(f.database.readOne<{n:number}>('SELECT count(*) AS n FROM work_invocation_starts WHERE work_id=?',ack.workId)?.n,1);
});
