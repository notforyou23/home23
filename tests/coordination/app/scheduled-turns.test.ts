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
