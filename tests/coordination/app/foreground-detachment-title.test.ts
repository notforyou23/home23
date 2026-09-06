import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAndFormatTool } from '../../../src/agent/tool-result.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { ResidentTurnUdsServer } from '../../../src/coordination-adapter/resident-uds.js';
import { parseForegroundDetachmentRequest } from '../../../src/coordination-adapter/foreground-detachment-contract.js';
import { createResidentCredential } from '../../../src/coordination/resident-protocol/index.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';

function setup() {
  const database=M11TestDatabase.temporary();const now=()=>new Date(AT);const generateId=createFixtureIdGenerator();
  database.raw.prepare("UPDATE bots SET active_instance_id='instance-jerry',active_key_version=1 WHERE id=?").run(BOT_ID);
  const work=createWorkService({database,generateId,now});const leases=createLeaseService({database,generateId,now,leaseTtlMs:60000});
  const ids={requestId:fixtureId('request',100),correlationId:fixtureId('correlation',100)};
  const parent=work.create({principalId:OWNER_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,kind:'resident_turn',idempotencyKey:'title-speaking-parent',manifest:manifestInput(),maxAutomaticOffers:1,...ids}).work;
  const offered=leases.offer({workId:parent.id,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',authorityReference:'resident:jerry',automatic:true,...ids});
  const binding={workId:parent.id,attemptId:offered.attempt.id,leaseId:offered.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'instance-jerry',fencingToken:offered.fencingToken,...ids};
  leases.accept(binding);leases.start(binding);
  const parentOrigin={kind:'coordination' as const,...binding,authorityReference:'resident:jerry',channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null};
  const credential=createResidentCredential({residentSlug:'jerry',role:'resident',instanceId:'client-jerry',keyVersion:1,rootKey:Buffer.alloc(32,45)});
  const consumer=createForegroundDetachmentConsumer({database,work,now,resolveResident:()=>({clientInstanceId:'client-jerry',serverInstanceId:'instance-jerry',keyVersion:1}),schedule:()=>{}});
  return {database,work,parentOrigin,credential,consumer};
}

const observedShapeTask='Using only this supplied fictional scenario, prepare an approximately 900-word reliability review with eight concrete failure cases and a short conclusion: a household assistant accepts a long assignment, keeps conversation available, saves progress, survives relaunch, supports cancellation, and returns one final result. Analyze exactly these areas: duplicate delivery, lost acknowledgments, process restart before start, uncertain effects after start, cancellation races, two simultaneous assignments, resident isolation, and stale UI. Do not inspect any machine, access files, browse the web, invoke tools, alter settings, or send messages to anyone. Return one self-contained review of approximately 900 words, with a clear heading, eight numbered failure cases, and a short conclusion.';
for (const [label,task] of [['observed long ASCII assignment',observedShapeTask],['long UTF8 assignment','家庭の信頼性を確認してください。🏠 '.repeat(30)]]) {
  test(`${label} passes real harness admission and Work presentation without altering execution`,async t=>{
    const f=setup();t.after(()=>f.database.close());
    const root=mkdtempSync(join(tmpdir(),'h23-title-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
    const args={task,label:'Working Thread check',mode:'joined',tool_grants:[],isolated:true,model:'',effort:'medium'};
    let canonicalRequest: ReturnType<typeof parseForegroundDetachmentRequest> | undefined;
    const server=new ResidentTurnUdsServer({socketPath:join(root,'resident.sock'),serverInstanceId:'instance-jerry',credential:f.credential,residentSlug:'jerry',history:new ConversationHistory(join(root,'history'),400000,'jerry'),
      agent:{getModel:()=> 'fixture',getProvider:()=> 'fixture',getReasoningEffort:()=> 'medium',runWithTurn:async()=>assert.fail('no model execution at admission'),stop:()=>({stopped:false,chatIds:[]}),isRunning:()=>false},
      exactToolRuntime:{registry:{get:()=>({})} as never,context:{} as never},
      coordinationClient:{request:async ({payload,path}:{payload:unknown;path:string})=>{
        assert.equal(path,'/internal/v1/foreground-detachments');canonicalRequest=parseForegroundDetachmentRequest(payload);
        return {payload:f.consumer.admit({credential:f.credential,request:canonicalRequest})};
      },close:async()=>{}} as never,
    });t.after(()=>server.close());
    let selectedRequest: import('../../../src/agent/foreground-tool-policy.js').ForegroundDetachRequest | undefined;
    let childId='';
    const rendered=await executeAndFormatTool({registry:{execute:async()=>assert.fail('speaking tool must stay deferred')} as never,name:'spawn_agent',toolCallId:'selected-title-1',input:args,context:{chatId:'coordination:parent',turnRuntime:{turnId:'speaking',coordinationOrigin:f.parentOrigin},onForegroundDetachRequired:async(request: import('../../../src/agent/foreground-tool-policy.js').ForegroundDetachRequest)=>{
      selectedRequest=request;const ack=await server.admitForegroundDetachment(request);childId=ack.workId;return {created:true,handle:{workId:ack.workId}};
    }} as never,modelLimit:4000,eventLimit:4000});
    assert.equal(rendered.success,true);assert.ok(canonicalRequest);assert.ok(selectedRequest);
    assert.ok(canonicalRequest.title.length>88,'fixture crosses Work title bound');
    const presentation=f.database.readOne<{title:string;summary:string}>('SELECT title,summary FROM work_thread_presentations WHERE work_id=?',childId)!;
    assert.ok(presentation.title.length<=88);assert.ok(presentation.summary.length<=280);
    assert.equal(Buffer.from(presentation.title).toString('utf8'),presentation.title);
    const planned=f.work.getPlannedInvocation(childId)!;
    assert.deepEqual(planned.canonicalArgs,args);assert.equal(planned.title,canonicalRequest.title);
    assert.equal(planned.executionInstruction,canonicalRequest.executionInstruction);assert.equal(planned.summary,canonicalRequest.summary);
    assert.equal((await server.admitForegroundDetachment(selectedRequest)).workId,childId);
    assert.equal(f.database.readOne<{n:number}>("SELECT count(*) AS n FROM works WHERE kind='resident_work_thread'")?.n,1);
  });
}

test('supported 1000-byte summary is projected to Work limit while immutable assignment and replay retain it',t=>{
  const f=setup();t.after(()=>f.database.close());
  const request=parseForegroundDetachmentRequest({parentOrigin:f.parentOrigin,residentSlug:'jerry',invocationId:'summary-1000',toolName:'spawn_agent',canonicalArgs:{task:'Review'},executionInstruction:'Review',title:'Owner review',summary:'s'.repeat(1000),recoveryPolicy:'safe_before_start'});
  const ack=f.consumer.admit({credential:f.credential,request});
  const presentation=f.database.readOne<{summary:string}>('SELECT summary FROM work_thread_presentations WHERE work_id=?',ack.workId)!;
  assert.ok(presentation.summary.length<=280);
  assert.equal(f.work.getPlannedInvocation(ack.workId)?.summary,request.summary);
  assert.deepEqual(f.consumer.admit({credential:f.credential,request}),ack);
  assert.equal(f.database.readOne<{n:number}>("SELECT count(*) AS n FROM works WHERE kind='resident_work_thread'")?.n,1);
});
