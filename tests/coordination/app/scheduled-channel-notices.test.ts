import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledChannelNotices, scheduledNoChangeFingerprint, scheduledResponseCommunication } from '../../../src/coordination/app/scheduled-channel-notices.js';
import {createScheduledChannelTurns} from '../../../src/coordination/app/scheduled-turns.js';
import {createLeaseService} from '../../../src/coordination/leases/index.js';
import {createProductWorkControl,createWorkService} from '../../../src/coordination/work/index.js';
import {M11TestDatabase,AT,BOT_ID,CHANNEL_ID,createFixtureIdGenerator,fixtureId,manifestInput} from '../work/test-fixture.js';

const text = 'The `publication_guarded` stage confirmed the repair guard; no checkpoint or curriculum state changed, and the guard continues to block publication.';
const evidence = [{ tool: 'read_file', arguments:{path:'TASK_BUNDLE.json'}, result: JSON.stringify({schema:1, generated_at: '2026-10-14T10:00:00Z', stage: 'publication_guarded', task_id: 'repair',repair_guard:{enabled:true,path:'guard.md'}, inputs: [{path:'draft.md',sha256:'abc'}] }), success: true },
  { tool: 'read_file',arguments:{path:'guard.md'}, result: 'Repair guard: publication requires repair review.', success: true }];

test('unchanged guarded outcomes retain a stable fingerprint across timestamp and confirmed/verified wording', () => {
  const first = scheduledNoChangeFingerprint(text, evidence, []);
  assert.ok(first);
  assert.equal(scheduledNoChangeFingerprint(text.replace('confirmed', 'verified'),
    [{...evidence[0], result: evidence[0]!.result.replace('10:00:00','16:00:00')}, evidence[1]!], []), first);
  assert.notEqual(scheduledNoChangeFingerprint(text, [{...evidence[0], result: evidence[0]!.result.replace('abc', 'def')}, evidence[1]!], []), first);
  assert.notEqual(scheduledNoChangeFingerprint(text, [{...evidence[0],result:evidence[0]!.result.replace('guard.md','new-guard.md')},evidence[1]!], []), first);
});

test('failures, progress, artifacts and incomplete evidence always remain visible', () => {
  for (const value of ['Published the article.', 'Still blocked by the guard.', 'The guarded check failed; no state changed.',
    text + ' A new draft was saved.']) assert.equal(scheduledNoChangeFingerprint(value, evidence, []), null);
  assert.equal(scheduledNoChangeFingerprint(text, [{...evidence[0]!,success:false}], []), null);
  assert.equal(scheduledNoChangeFingerprint(text, [], []), null);
  assert.equal(scheduledNoChangeFingerprint(text, evidence, ['artifact']), null);
  assert.equal(scheduledNoChangeFingerprint(text, [...evidence,{tool:'shell',arguments:{command:'touch draft.md'},result:'Exit code: 0',success:true}], []),null);
});

test('scheduled response chunks retain private evidence instead of publishing narration before the outcome decision', () => {
  const input: any = { event: {workId:'wrk_fixture',kind:'assistant_response_delta',payload:{delta:text,rawEvent:{type:'response_chunk',chunk:text}}} };
  const database: any = {readOne:()=>({payload:'{}'})};
  const result = scheduledResponseCommunication(database,input);
  assert.equal(result.event.kind,'receipt');
  assert.equal(result.event.payload.scheduledResponseBuffered,true);
  assert.equal(result.event.payload.rawEvent,input.event.payload.rawEvent);
  assert.equal(scheduledResponseCommunication({readOne:()=>undefined} as any,input),input);
  assert.equal(scheduledResponseCommunication(database,{event:{...input.event,kind:'failure'}} as any).event.kind,'failure');
});

test('quiet decisions survive restart, finish polling and recovery, and omit repeated Work cards', async t => {
  const database=M11TestDatabase.temporary();t.after(()=>database.close());
  database.raw.prepare('INSERT INTO conversation_handles(id,channel_id,created_at) VALUES(?,?,?)').run(fixtureId('conversation',1),CHANNEL_ID,AT);
  const generateId=createFixtureIdGenerator(1000);
  const work=createWorkService({database,generateId,now:()=>new Date()});
  const leases=createLeaseService({database,generateId,now:()=>new Date(),leaseTtlMs:60000});
  let notices=createScheduledChannelNotices(database);
  let counter=0;
  function event(kind:string,id:string,payload:any) {
    database.mutateWithEvent(()=>({value:undefined,event:{type:kind==='communication'?'communication.recorded':'activity.updated',aggregateKind:kind,aggregateId:id,
      aggregateVersion:(database.readOne<{v:number}>('SELECT coalesce(max(aggregate_version),0) AS v FROM events WHERE aggregate_kind=? AND aggregate_id=?',kind,id)?.v??0)+1,
      channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',900+counter),correlationId:fixtureId('correlation',900+counter),payload,createdAt:new Date().toISOString()}}));
  }
  function run(report=text,jobId='editorial',changed=false,variant=false) {
    const n=++counter;const messageId=fixtureId('message',100+n);
    const input={runId:`sched-run-0198d95f-6c00-7000-8000-${String(n).padStart(12,'0')}`,jobId,channelId:CHANNEL_ID,prompt:'Run the cycle'};
    const admitted={...input,messageId,botId:BOT_ID};
    event('scheduled_channel_run',input.runId,admitted);notices.admit(admitted);
    database.mutateWithEvent(tx=>{
      tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
        VALUES(?,?,?,?,'bot','Jerry','text',?,'visible',?)`,messageId,CHANNEL_ID,n+1,BOT_ID,input.prompt,AT);
      return {value:undefined,event:{type:'message.appended',aggregateKind:'message',aggregateId:messageId,aggregateVersion:1,
        channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',n),correlationId:fixtureId('correlation',n),payload:{},createdAt:AT}};
    });
    const queued=work.create({principalId:BOT_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:messageId,roundId:null,kind:'channel.bot_turn',idempotencyKey:`scheduled:${input.runId}`,
      manifest:manifestInput({messageIds:[messageId],watermarks:{channelSequence:n+1,eventSequence:100}}),presentation:{title:'Scheduled channel run',summary:'Scheduled check'},
      maxAutomaticOffers:1,requestId:fixtureId('request',n),correlationId:fixtureId('correlation',n)}).work;
    const offer=leases.offer({workId:queued.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',authorityReference:'resident:jerry',automatic:true,requestId:fixtureId('request',n),correlationId:fixtureId('correlation',n)});
    const binding={workId:queued.id,attemptId:offer.attempt.id,leaseId:offer.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',fencingToken:offer.fencingToken,requestId:fixtureId('request',n),correlationId:fixtureId('correlation',n)};
    leases.accept(binding);leases.start(binding);
    const inspected=variant?[evidence[0]!,{tool:'shell',arguments:{command:'for p in state/GUARD.md; do if [ -f "$p" ]; then printf \'PRESENT %s\\n\' "$p"; else printf \'ABSENT %s\\n\' "$p"; fi; done'},result:'PRESENT state/GUARD.md',success:true}]:evidence;
    for(const [i,row] of inspected.entries()) {
      const toolCallId=`call-${n}-${i}`;
      const base={workId:queued.id,attemptId:binding.attemptId,turnId:`coord-${queued.id}`};
      event('communication',CHANNEL_ID,{communication:{...base,kind:'tool_call_started',payload:{tool:row.tool,toolCallId,arguments:row.arguments}}});
      event('communication',CHANNEL_ID,{communication:{...base,kind:'tool_call_completed',payload:{...row,toolCallId,result:changed?row.result.replace('abc','def'):row.result}}});
    }
    leases.terminalize({...binding,receipt:{status:'succeeded',sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:new Date().toISOString()}});
    const finished=work.get(queued.id)!;
    return {input,work:finished,suppressed:notices.prepare(finished,report,[],inspected.length)};
  }
  const first=run();assert.equal(first.suppressed,false);notices.delivered(first.work);
  const chunk:any={event:{kind:'assistant_response_delta',workId:first.work.id,channelId:CHANNEL_ID,actor:{principalId:BOT_ID},terminal:false,payload:{delta:'Guard narration',rawEvent:{type:'response_chunk',chunk:'Guard narration'}}}};
  const buffered=scheduledResponseCommunication(database,chunk);
  assert.equal(buffered.event.kind,'receipt');assert.equal(buffered.event.terminal,false);assert.equal(buffered.event.payload.delta,undefined);
  assert.equal(scheduledResponseCommunication(database,{event:{...chunk.event,actor:{principalId:'user_owner'}}} as any).event.kind,'assistant_response_delta');
  assert.equal(scheduledResponseCommunication(database,{event:{...chunk.event,channelId:fixtureId('channel',99)}} as any).event.kind,'assistant_response_delta');
  database.reopen();notices=createScheduledChannelNotices(database);
  const paraphrase=text.replace('confirmed the repair guard','verified the repair-unpublished guard');
  const second=run(paraphrase);assert.equal(second.suppressed,true);
  assert.equal(notices.hasResult(second.work.id),true);
  assert.equal(notices.prepare(second.work,'Changed replay',[],0),true,'recovery reuses the durable decision');
  const scheduled=createScheduledChannelTurns({database,channels:{} as any,submit:{submitMessage:async()=>{throw new Error('must not redispatch');}},context:()=>({principalId:BOT_ID} as any),beginWork:()=>()=>{}});
  const status=await scheduled.run(second.input);assert.equal(status.state,'succeeded');assert.equal(status.noticeSuppressed,true);assert.equal(status.text,paraphrase);
  const control=createProductWorkControl({database,work,leases});
  const context={principalId:'user_owner',requestId:fixtureId('request',888),correlationId:fixtureId('correlation',888),identity:{kind:'owner' as const,auth:{} as any}};
  assert.equal(control.list({context}).works.some(row=>row.id===second.work.id),false);
  assert.equal(control.get({context,workId:second.work.id}).id,second.work.id,'private execution remains inspectable');
  assert.equal(run(text,'editorial',false,true).suppressed,true,'equivalent guard presence inspection does not cause another notice');
  const changed=run(text,'editorial',true);assert.equal(changed.suppressed,false);notices.delivered(changed.work);
  const restored=run();assert.equal(restored.suppressed,false);notices.delivered(restored.work);
  const progress=run('Saved a new draft.');assert.equal(progress.suppressed,false);notices.delivered(progress.work);
  const afterProgress=run();assert.equal(afterProgress.suppressed,false);notices.delivered(afterProgress.work);
  assert.equal(run(text,'other-job').suppressed,false);
  const crashProgress=run('Saved a new source review.');assert.equal(crashProgress.suppressed,false);
  const resultId=`msg_${crashProgress.work.id.slice(4)}`;
  database.mutateWithEvent(tx=>{
    tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at,work_id)
      VALUES(?,?,10000,?,'bot','Jerry','result','Saved a new source review.','visible',?,?)`,resultId,CHANNEL_ID,BOT_ID,AT,crashProgress.work.id);
    return {value:undefined,event:{type:'message.appended',aggregateKind:'message',aggregateId:resultId,aggregateVersion:1,
      channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',998),correlationId:fixtureId('correlation',998),payload:{},createdAt:AT}};
  });
  // Crash before delivered(), and do not recover the old Work first.
  database.reopen();notices=createScheduledChannelNotices(database);
  const afterCrash=run();assert.equal(afterCrash.suppressed,false,'a committed progress result resets stale blocking state');
  notices.delivered(afterCrash.work);
  const cancelled=work.create({principalId:BOT_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:fixtureId('message',1),roundId:null,kind:'channel.bot_turn',
    idempotencyKey:'actual-cancellation',manifest:manifestInput(),maxAutomaticOffers:1,requestId:fixtureId('request',999),correlationId:fixtureId('correlation',999)}).work;
  work.cancelQueued({workId:cancelled.id,actorPrincipalId:BOT_ID,reasonCode:'cancelled',sourceReference:'fixture:cancelled',timestamp:new Date().toISOString(),requestId:fixtureId('request',999),correlationId:fixtureId('correlation',999)});
  assert.equal(run().suppressed,false,'an actual failed/cancelled execution resets the unchanged blocker');
});
