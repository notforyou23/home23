import assert from 'node:assert/strict';
import test from 'node:test';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkingThreadStop } from '../../../src/coordination/app/working-thread-stop.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createProductWorkControl } from '../../../src/coordination/work/product-control.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';

function setup() {
  const database=M11TestDatabase.temporary(); const now=()=>new Date(AT); const generateId=createFixtureIdGenerator();
  const conversationId=fixtureId('conversation',500);
  database.raw.prepare('INSERT INTO conversation_handles (id,channel_id,created_at) VALUES (?,?,?)').run(conversationId,CHANNEL_ID,AT);
  database.raw.prepare("UPDATE bots SET active_instance_id='instance-jerry',active_key_version=1,conversation_id=? WHERE id=?").run(conversationId,BOT_ID);
  const work=createWorkService({database,generateId,now});
  const leases=createLeaseService({database,generateId,now,leaseTtlMs:60000});
  const control=createProductWorkControl({database,work,leases,now});
  const ids={requestId:fixtureId('request',501),correlationId:fixtureId('correlation',501)};
  const context={...ids,principalId:OWNER_ID,identity:{kind:'owner' as const,auth:{} as any}};
  const parent=work.create({principalId:OWNER_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,kind:'resident_turn',idempotencyKey:'parent-speaking-cancellation',manifest:manifestInput(),maxAutomaticOffers:1,...ids}).work;
  const offer=(workId:string)=>{
    const receipt=leases.offer({workId,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',authorityReference:'resident:jerry',automatic:true,...ids});
    const binding={workId,attemptId:receipt.attempt.id,leaseId:receipt.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',fencingToken:receipt.fencingToken,...ids};
    const origin={kind:'coordination' as const,...binding,authorityReference:'resident:jerry',channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null};
    return {binding,origin};
  };
  const speaking=offer(parent.id);leases.accept(speaking.binding);leases.start(speaking.binding);
  const credential={residentSlug:'jerry',instanceId:'client-jerry',keyVersion:1};
  const consumer=createForegroundDetachmentConsumer({database,work,now,resolveResident:()=>({clientInstanceId:'client-jerry',serverInstanceId:'instance-jerry',keyVersion:1}),schedule:()=>{}});
  const request={parentOrigin:speaking.origin,residentSlug:'jerry',invocationId:'selected-cancel',toolName:'spawn_agent',canonicalArgs:{task:'Inspect health'},executionInstruction:'Inspect health',title:'Health review',summary:'Inspect health',recoveryPolicy:'safe_before_start' as const};
  const child=consumer.admit({credential,request});
  return {database,work,leases,control,context,ids,consumer,credential,child,offer};
}

for (const phase of ['offered','accepted']) test(`planned ${phase} cancellation fences start without executor transport`, t=>{
  const f=setup();t.after(()=>f.database.close());
  const child=f.offer(f.child.workId);if(phase==='accepted')f.leases.accept(child.binding);
  const result=f.control.cancel({context:f.context,workId:f.child.workId,idempotencyKey:`cancel-${phase}`});
  assert.equal(result.outcome,'cancelled');assert.equal(f.work.get(f.child.workId)?.state,'cancelled');
  assert.equal(f.work.getInvocationExecution(f.child.workId),null);
  assert.throws(()=>f.consumer.start({credential:f.credential,origin:child.origin,invocationId:'selected-cancel'}),/current authenticated resident fence/);
  assert.throws(()=>f.leases.start(child.binding));
  assert.equal(f.control.cancel({context:f.context,workId:f.child.workId,idempotencyKey:`cancel-${phase}`}).replayed,true);
  assert.equal(f.database.readOne<{n:number}>('SELECT count(*) AS n FROM terminal_receipts WHERE work_id=?',f.child.workId)?.n,1);
});

test('running but not-started planned cancellation settles without contacting an absent harness',async t=>{
  const f=setup();t.after(()=>f.database.close());const child=f.offer(f.child.workId);
  f.leases.accept(child.binding);f.leases.start(child.binding);
  assert.equal(f.control.cancel({context:f.context,workId:f.child.workId,idempotencyKey:'cancel-before-permission'}).outcome,'cancellation_requested');
  const stop=createWorkingThreadStop({database:f.database,work:f.work,leases:f.leases,
    residentAdapters:new Map([['jerry',{stopRevoked:async()=>assert.fail('no tool permission exists')}]]),
    residentAgents:new Map([['jerry',{stopExact:async()=>assert.fail('no tool permission exists')}]]),
  });
  await stop(f.child.workId,f.ids);
  assert.equal(f.work.get(f.child.workId)?.state,'cancelled');
  assert.throws(()=>f.consumer.start({credential:f.credential,origin:child.origin,invocationId:'selected-cancel'}),/current authenticated resident fence/);
  await stop(f.child.workId,f.ids);
  assert.equal(f.database.readOne<{n:number}>('SELECT count(*) AS n FROM terminal_receipts WHERE work_id=?',f.child.workId)?.n,1);
});
