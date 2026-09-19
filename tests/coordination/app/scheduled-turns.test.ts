import test from 'node:test';
import assert from 'node:assert/strict';
import {createScheduledChannelTurns} from '../../../src/coordination/app/scheduled-turns.js';
import {createWorkService} from '../../../src/coordination/work/index.js';
import {M11TestDatabase,AT,BOT_ID,CHANNEL_ID,createFixtureIdGenerator,fixtureId,manifestInput} from '../work/test-fixture.js';

test('canonical scheduled admission, child Work and resolved prompt survive restart without another dispatch',async t=>{
  const database=M11TestDatabase.temporary();t.after(()=>database.close());
  const work=createWorkService({database,generateId:createFixtureIdGenerator(),now:()=>new Date(AT)});
  let effects=0;let ends=0;let clock=1000;const expirations:string[]=[];
  const options={database,now:()=>clock,expireWork:(id:string)=>{expirations.push(id);},channels:{getChannel:async()=>({kind:'group',lifecycle:'active',members:[{principalId:BOT_ID}]})} as any,
    context:()=>({principalId:BOT_ID}) as any,beginWork:()=>()=>{ends++;},submit:{submitMessage:async(input:any)=>{
      effects++;
      database.mutateWithEvent(tx=>{tx.run(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
        VALUES (?,?,2,?,'bot','Jerry','text',?,'visible',?)`,input.body.messageId,CHANNEL_ID,BOT_ID,input.body.text,AT);
        return {value:undefined,event:{type:'message.appended',aggregateKind:'message',aggregateId:input.body.messageId,aggregateVersion:1,channelId:CHANNEL_ID,
          actorPrincipalId:BOT_ID,requestId:fixtureId('request',77),correlationId:fixtureId('correlation',77),payload:{},createdAt:AT}};});
      work.create({principalId:BOT_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:input.body.messageId,roundId:null,kind:'channel.bot_turn',
        idempotencyKey:input.idempotencyKey,maxAutomaticOffers:2,manifest:manifestInput({messageIds:[input.body.messageId],watermarks:{channelSequence:2,eventSequence:100}}),
        requestId:fixtureId('request',78),correlationId:fixtureId('correlation',78)});
      work.create({principalId:BOT_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:input.body.messageId,roundId:null,kind:'resident_turn',
        idempotencyKey:'review-of-scheduled-work',maxAutomaticOffers:1,manifest:manifestInput({messageIds:[input.body.messageId],watermarks:{channelSequence:2,eventSequence:100}}),
        requestId:fixtureId('request',79),correlationId:fixtureId('correlation',79)});
      return {};
    }}};
  const input={runId:'sched-run-0198d95f-6c00-7000-8000-000000000011',jobId:'editorial',channelId:CHANNEL_ID,prompt:'Prepare today’s draft',timeoutMs:5000};
  let service=createScheduledChannelTurns(options);
  assert.equal((await service.run(input)).state,'running');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ends,1);assert.equal(effects,1);
  database.reopen();service=createScheduledChannelTurns(options);service.reconcile();
  const result=await service.run(input);assert.equal(result.state,'running');assert.equal(result.workIds?.length,1);assert.equal(effects,1);
  await assert.rejects(service.run({...input,prompt:'Changed editorial effects'}),/replay changed/);
  assert.equal(effects,1);
  await assert.rejects(service.run({...input,timeoutMs:6000}),/replay changed/);
  clock=5999;service.reconcile();assert.equal(expirations.length,0);
  database.reopen();service=createScheduledChannelTurns(options);
  clock=6000;service.reconcile();assert.deepEqual(expirations,result.workIds);
  assert.equal((await service.run(input)).state,'running','a stop request is not a terminal receipt');
  const childId=result.workIds![0]!;
  work.cancelQueued({workId:childId,actorPrincipalId:BOT_ID,reasonCode:'deadline',sourceReference:'scheduled:deadline',timestamp:AT,requestId:fixtureId('request',80),correlationId:fixtureId('correlation',80)});
  const final=await service.run(input);assert.equal(final.state,'cancelled');assert.match(final.error!,/deadline reached/);
  assert.equal(effects,1);
});


test('busy scheduled admission stays pending and reuses its message after reopen',async t=>{
 const database=M11TestDatabase.temporary();t.after(()=>database.close());const ids:string[]=[];
 const options={database,channels:{getChannel:async()=>({kind:'group',lifecycle:'active',members:[{principalId:BOT_ID}]})} as any,
 context:()=>({principalId:BOT_ID}) as any,beginWork:()=>()=>{},submit:{submitMessage:async(input:any)=>{ids.push(input.body.messageId);throw Object.assign(new Error('Bot already has an active turn'),{code:'turn_in_progress'});}}};
 const input={runId:'sched-run-0198d95f-6c00-7000-8000-000000000012',jobId:'busy-editorial',channelId:CHANNEL_ID,prompt:'Wait for my existing run'};
 let service=createScheduledChannelTurns(options);await service.run(input);await new Promise(r=>setImmediate(r));
 database.reopen();service=createScheduledChannelTurns(options);assert.equal((await service.run(input)).state,'running');await new Promise(r=>setImmediate(r));
 assert.equal(ids.length,2);assert.equal(new Set(ids).size,1);assert.equal(database.readAll("SELECT sequence FROM events WHERE aggregate_kind='scheduled_channel_run' AND aggregate_version=2").length,0);
});

test('explicit target keeps resident authorship, tracks only target Work and binds replay to actor and target',async t=>{
 const database=M11TestDatabase.temporary();t.after(()=>database.close());
 const target=fixtureId('bot',2);
 database.raw.prepare("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)").run(target,AT);
 database.raw.prepare(`INSERT INTO bots (id,principal_id,name,purpose,lifecycle,resident_binding,continuing_identity,durable_mailbox,required_capabilities_json,resident_capabilities_json,version,created_at,updated_at)
 VALUES (?,?,'Chester','Chess','active','bot-chester',1,1,'[]','[]',1,?,?)`).run(target,target,AT,AT);
 database.raw.prepare("INSERT INTO channel_members (channel_id,principal_id,kind,role,active,joined_at,left_at) VALUES (?,?,'bot','member',1,?,NULL)").run(CHANNEL_ID,target,AT);
 const work=createWorkService({database,generateId:createFixtureIdGenerator(),now:()=>new Date(AT)});
 let actor=BOT_ID;let member=true;const submissions:any[]=[];
 const options={database,channels:{getChannel:async()=>({kind:'group',lifecycle:'active',members:[{principalId:BOT_ID},...(member?[{principalId:target}]:[])]})} as any,
 context:()=>({principalId:actor,identity:{kind:'resident'}}) as any,beginWork:()=>()=>{},submit:{submitMessage:async(input:any)=>{
   submissions.push(input);
   database.mutateWithEvent(tx=>{tx.run(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
     VALUES (?,?,2,?,'bot','Jerry','text',?,'visible',?)`,input.body.messageId,CHANNEL_ID,input.context.principalId,input.body.text,AT);
     return {value:undefined,event:{type:'message.appended',aggregateKind:'message',aggregateId:input.body.messageId,aggregateVersion:1,channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',77),correlationId:fixtureId('correlation',77),payload:{},createdAt:AT}};});
   for(const id of [BOT_ID,target]) work.create({principalId:BOT_ID,targetPrincipalId:id,channelId:CHANNEL_ID,originMessageId:input.body.messageId,roundId:null,kind:'channel.bot_turn',
    idempotencyKey:`${input.idempotencyKey}:${id}`,maxAutomaticOffers:1,manifest:manifestInput({messageIds:[input.body.messageId],watermarks:{channelSequence:2,eventSequence:100}}),
    requestId:fixtureId('request',78),correlationId:fixtureId('correlation',78)});
   return {};
 }}};
 const input={runId:'sched-run-0198d95f-6c00-7000-8000-000000000013',jobId:'chess',channelId:CHANNEL_ID,prompt:'Play the next move',targetBotId:target};
 let service=createScheduledChannelTurns(options);
 member=false;await assert.rejects(service.run(input),/active bot member/);member=true;
 database.raw.prepare("UPDATE bots SET lifecycle='archived' WHERE id=?").run(target);
 await assert.rejects(service.run(input),/active bot member/);
 database.raw.prepare("UPDATE bots SET lifecycle='active' WHERE id=?").run(target);
 await assert.rejects(service.run({...input,targetBotId:'user_owner'}),/Invalid scheduled/);
 await service.run(input);await new Promise(r=>setImmediate(r));
 assert.equal(submissions.length,1);assert.equal(submissions[0].context.principalId,BOT_ID);assert.deepEqual(submissions[0].body.mentions,[target]);
 const result=await service.run(input);assert.equal(result.workIds?.length,1);
 assert.equal(database.readOne<{id:string}>('SELECT target_principal_id AS id FROM works WHERE id=?',result.workIds![0])!.id,target);
 await assert.rejects(service.run({...input,targetBotId:BOT_ID}),/replay changed/);
 actor=target;await assert.rejects(service.run(input),/another agent/);actor=BOT_ID;
 database.reopen();service=createScheduledChannelTurns(options);service.reconcile();
 assert.deepEqual((await service.run(input)).workIds,result.workIds);assert.equal(submissions.length,1);
});

test('superseded native game turns do not dispatch after a busy admission and restart', async t => {
 const database=M11TestDatabase.temporary();t.after(()=>database.close());let active=true;let submissions=0;
 const options={database,channels:{getChannel:async()=>({kind:'group',lifecycle:'active',members:[{principalId:BOT_ID}]})} as any,
 context:()=>({principalId:BOT_ID}) as any,beginWork:()=>()=>{},canDispatch:()=>active,
 submit:{submitMessage:async()=>{submissions++;throw Object.assign(new Error('Busy'),{code:'turn_in_progress'});}}};
 const input={runId:'sched-run-0198d95f-6c00-7000-8000-000000000019',jobId:'native-chess:fixture:2',channelId:CHANNEL_ID,prompt:'Play the current game turn'};
 let service=createScheduledChannelTurns(options);await service.run(input);await new Promise(r=>setImmediate(r));
 active=false;database.reopen();service=createScheduledChannelTurns(options);service.reconcile();await new Promise(r=>setImmediate(r));
 assert.equal(submissions,1);assert.equal((await service.run(input)).state,'failed');service.reconcile();assert.equal(submissions,1);
});
