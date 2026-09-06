import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationHistory} from '../../src/agent/history.js';
import {TurnStore} from '../../src/chat/turn-store.js';
import {ResidentTurnUdsServer,ResidentUdsAgentPort} from '../../src/coordination-adapter/resident-uds.js';
import {ResidentUdsClient} from '../../src/coordination/transport/uds/index.js';
import {createResidentCredential} from '../../src/coordination/resident-protocol/index.js';
import {generateCoordinationId} from '../../src/coordination/ids/index.js';

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root=mkdtempSync(join(tmpdir(),'replay-batch-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const history=new ConversationHistory(join(root,'conversations'),400_000,'jerry');
  const store=new TurnStore(history);
  const origin={kind:'coordination' as const,workId:generateCoordinationId('work'),attemptId:generateCoordinationId('attempt'),leaseId:generateCoordinationId('lease'),holderPrincipalId:generateCoordinationId('bot'),holderInstanceId:'home23-jerry-harness',authorityReference:'resident:jerry',fencingToken:1,channelId:generateCoordinationId('channel'),originMessageId:generateCoordinationId('message'),roundId:null};
  const chatId=`coordination:${origin.channelId}:${origin.workId}`,turnId=`coord-${origin.workId}`;
  store.writeStart(chatId,turnId,'fixture-model','fixture-provider',{coordination_origin:origin});
  const expected:string[]=[];
  for(let seq=1;seq<=986;seq++){
    const text=seq===500?'large:'+('x'.repeat(300_000)):`event-${seq}`;expected.push(text);
    store.writeEvent(chatId,{type:'event',turn_id:turnId,seq,ts:'2026-09-04T22:31:00.000Z',kind:'response_chunk',data:{type:'response_chunk',chunk:text}});
    if(seq<=450)store.writeEvent(chatId,{type:'event',turn_id:'hidden-synthesis',seq,ts:'2026-09-04T22:31:00.000Z',kind:'response_chunk',data:{type:'response_chunk',chunk:'hidden'}});
  }
  history.appendRecord(chatId,{role:'assistant',content:'One final result.',ts:'2026-09-04T22:31:23.000Z'});
  store.writeEnd(chatId,turnId,'complete',{last_seq:986});
  const credential=createResidentCredential({rootKey:Buffer.alloc(32,0x57),residentSlug:'jerry',role:'resident',instanceId:'coordinator-jerry',keyVersion:1});
  let executions=1,reads=0;
  const load=history.loadRaw.bind(history);history.loadRaw=(chat)=>{reads++;return load(chat);};
  const agent={getModel:()=> 'fixture-model',getProvider:()=> 'fixture-provider',getReasoningEffort:()=> 'medium',isRunning:()=>false,stop:()=>({stopped:false,chatIds:[]}),runWithTurn:async()=>{executions++;throw Error('completed invocation must not execute');}};
  const socketPath=join(root,'resident.sock');
  const startServer=async()=>{const server=new ResidentTurnUdsServer({socketPath,serverInstanceId:'home23-jerry-harness',credential,residentSlug:'jerry',agent:agent as never,history});await server.start();return server;};
  const connect=(mutate?:(payload:any)=>void)=>{
    const client=new ResidentUdsClient({socketPath,serverInstanceId:'home23-jerry-harness',credential});
    let requests=0,partialChunks=0,continuedWithNext=false;const request=client.request.bind(client);
    client.request=async(input)=>{const response=await request(input);if(input.path.endsWith('/events')){requests++;const payload=response.payload as any;partialChunks+=(payload.events??[]).filter((event:any)=>event.nextOffset<event.totalBytes).length;continuedWithNext ||= (payload.events?.[0]?.offset>0&&payload.events.length>1);mutate?.(response.payload);}return response;};
    const port=new ResidentUdsAgentPort({client,residentSlug:'jerry',deadlineMs:2000,resultTimeoutMs:10000});
    return {port,client,count:()=>requests,partialChunks:()=>partialChunks,continuedWithNext:()=>continuedWithNext};
  };
  const run=(port:ResidentUdsAgentPort,onEvent:(event:any)=>void)=>port.runWithTurn(chatId,'must not execute',{coordinationOrigin:origin,coordinationRequest:{requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')},turnSelection:{modelAlias:null,reasoningEffort:null},completedRecovery:true,onDurableStart:()=>undefined,onEvent});
  return {store,chatId,turnId,expected,startServer,connect,run,reads:()=>reads,executions:()=>executions};
}

test('986 root events plus450 synthesis records replay in bounded fresh batches across harness/client restart',async t=>{
  const f=await fixture(t);
  for(let pass=0;pass<2;pass++){
    const server=await f.startServer();const c=f.connect();const before=f.reads();
    try{
      const observed:string[]=[],sequences:number[]=[];
      const started=await f.run(c.port,event=>{observed.push(event.event.chunk);sequences.push(event.sequence);});
      assert.equal((await started.response).text,'One final result.');
      const terminal=await started.terminal;
      assert.equal(terminal.lastSequence,986);
      assert.equal(sequences.length,986,'terminal waits for every complete event, including the large-event tail');
      assert.ok(c.partialChunks()>=3);
      assert.equal(c.continuedWithNext(),true,'large-event continuation and following events share a bounded batch');
      assert.deepEqual(observed,f.expected);
      assert.deepEqual(sequences,Array.from({length:986},(_,i)=>i+1));
      assert.ok(c.count()<=40,`bounded RPCs: ${c.count()}`);
      assert.ok(f.reads()-before<=50,`bounded journal scans: ${f.reads()-before}`);
      assert.equal(f.executions(),1);
    }finally{await c.port.close();await server.close();}
  }
});

test('batched replay rejects changed digest, sequence gaps and oversized batches',async t=>{
  const f=await fixture(t);const server=await f.startServer();t.after(()=>server.close());
  for(const mode of ['digest','sequence','oversized','terminal']){
    let changed=false;const c=f.connect(payload=>{if(changed||!payload.events?.length)return;changed=true;if(mode==='digest')payload.events[0].digest='0'.repeat(64);else if(mode==='sequence')payload.events[0].sequence=2;else if(mode==='terminal')payload.terminal.lastSeq=1;else payload.events.push(...payload.events);});
    try{
      const delivered:number[]=[];
      const run=await f.run(c.port,event=>{delivered.push(event.sequence);if(mode!=='terminal')assert.fail('corrupt first batch must not deliver an event');});
      await assert.rejects(run.response,/digest differs|not contiguous|invalid resident event batch|exceeds terminal boundary/);
      await assert.rejects(run.terminal);
      if(mode==='terminal')assert.deepEqual(delivered,[1],'no event beyond declared terminal may reach durable callback');
      assert.equal(f.executions(),1);
    }finally{await c.port.close();}
  }
});

test('replay snapshot is fresh after an append and excludes other turn identities',async t=>{
  const f=await fixture(t);const before=f.reads();
  assert.equal(f.store.replaySnapshot(f.chatId,f.turnId).events.length,986);
  f.store.writeEvent(f.chatId,{type:'event',turn_id:f.turnId,seq:987,ts:'2026-09-04T22:32:00.000Z',kind:'status',data:{type:'status',status:'late-evidence'}});
  assert.equal(f.store.replaySnapshot(f.chatId,f.turnId).events.length,987);
  assert.equal(f.reads()-before,2);
});
