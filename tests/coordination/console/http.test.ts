import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinationApplication, disabledCoordinationFeatureFlags } from '../../../src/coordination/app/application.js';
import { createCoordinationHttpServer } from '../../../src/coordination/http/index.js';
import { ConsoleService } from '../../../src/coordination/console/service.js';
import type { ConsoleCatalog } from '../../../src/coordination/console/catalog.js';
import type { ResolvedConsoleSource } from '../../../src/coordination/console/types.js';
import { AuthError } from '../../../src/coordination/auth/index.js';
import { validateCanonicalFixture } from '../../../src/coordination/contracts/contract-pack.js';

const headers={authorization:'Bearer test-token'};
async function fixture(t: import('node:test').TestContext) {
  const root=await mkdtemp(join(tmpdir(),'home23-console-http-'));
  const sources=new Map<string,ResolvedConsoleSource>();
  const active:AbortController[]=[];
  let valid=true;
  const controls:unknown[]=[];
  const catalog={
    async resolve(id:string){return sources.get(id);},
    async list({state='recent',limit=200}:{state?:string;limit?:number}) {
      const all=[...sources.values()].filter(v=>state!=='active'||v.source.state==='running').map(v=>v.source);
      return {sources:all.slice(0,limit),nextCursor:all.length>limit?'next':null,notices:[]};
    },
  } as unknown as ConsoleCatalog;
  const service=new ConsoleService({catalog,pollMs:15,controls:{available:()=>true,execute:async(_source,request)=>{
    controls.push(request);
    return {operationId:'ec_fixture',targetId:request.jobId??request.turnId!,status:request.expectedJobId===request.jobId?'cancellation_requested':'stale_target'};
  }}});
  const application=createCoordinationApplication({flags:{...disabledCoordinationFeatureFlags(),'coordination.process.enabled':true,'coordination.public_api.enabled':true},services:{console:service,auth:{validateAccessToken:async({accessToken})=>{
    if(!valid||accessToken!=='test-token') throw new AuthError('access_invalid');
    return {principalId:'user_owner',deviceId:'dev_00000000-0000-7000-8000-000000000001',sessionId:'ses_00000000-0000-7000-8000-000000000001',scopes:['product:read','message:send']};
  }}}});
  const server=createCoordinationHttpServer({application,port:0});
  t.after(async()=>{for(const controller of active)controller.abort(); await server.drain();await rm(root,{recursive:true,force:true});});
  const {origin}=await server.start();
  async function source(id:string,raw='') {
    const file=join(root,`${id}.jsonl`);await writeFile(file,raw);
    const resolved:ResolvedConsoleSource={source:{id,kind:'coding',label:id,actor:{id:'jerry',name:'Jerry'},backend:'codex',parentSourceId:null,workId:null,harnessWorkId:null,executionId:id,conversationId:null,state:'running',startedAt:'2026-09-19T12:00:00.000Z',finishedAt:null,lastOutputAt:null,lastOutputAtBasis:'unknown',checkedAt:'2026-09-19T12:00:00.000Z',output:{availability:'available',reason:null,format:'codex-jsonl',shellOutputTiming:'at_completion',historyCompleteness:'unknown'},actions:[]},root:{id:'resident:jerry',actor:{id:'jerry',name:'Jerry'},jobsDir:root,workDir:root,historyDir:root,historyNamespace:'jerry'},streams:[{id:'events',path:file,allowedRoot:root,format:'codex-jsonl',writerClosed:false}],target:{runtimeId:'resident:jerry',kind:'coding',jobId:id},channelId:null};
    sources.set(id,resolved);return {resolved,file};
  }
  async function stream(query:string,extra:Record<string,string>={}) {
    const controller=new AbortController();active.push(controller);
    const response=await fetch(`${origin}/api/v1/console/stream?${query}`,{headers:{...headers,...extra},signal:controller.signal});
    assert.equal(response.status,200);
    const iterator=frames(response)[Symbol.asyncIterator]();
    return {controller,iterator,async next(event:string,predicate:(value:any)=>boolean=()=>true){
      for(let n=0;n<200;n++){const value=await deadline(iterator.next());if(value.done)throw new Error('stream ended');if(value.value.event===event&&predicate(value.value.data))return value.value;}
      throw new Error(`missing event ${event}`);
    }};
  }
  return {root,origin,source,stream,sources,controls,drain:()=>server.drain(),revoke:()=>{valid=false;}};
}
async function* frames(response:Response) {
  let buffer='';const decoder=new TextDecoder();
  for await(const value of response.body as any){buffer+=decoder.decode(value,{stream:true});let i:number;while((i=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,i);buffer=buffer.slice(i+2);const event=/^event: (.+)$/m.exec(frame)?.[1],data=/^data: (.+)$/m.exec(frame)?.[1],id=/^id: (.+)$/m.exec(frame)?.[1];if(event&&data)yield{event,data:JSON.parse(data),id};}}
}
async function deadline<T>(promise:Promise<T>):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('stream deadline')),3000);})]);}finally{clearTimeout(timer);}}

test('House authentication protects real history and oversized raw bytes',async t=>{
  const f=await fixture(t), oversized=JSON.stringify({type:'item.completed',item:{aggregated_output:'😀\\'.repeat(20_000)}});
  await f.source('cs_one',`${JSON.stringify({type:'thread.started',thread_id:'one'})}\n${oversized}\n`);
  assert.equal((await fetch(`${f.origin}/api/v1/console/sources`)).status,401);
  const catalog=await (await fetch(`${f.origin}/api/v1/console/sources`,{headers})).json();
  assert.deepEqual(validateCanonicalFixture('console-sources',catalog),{valid:true,errors:[]});
  const response=await fetch(`${f.origin}/api/v1/console/sources/cs_one/records`,{headers});assert.equal(response.status,200);
  const page=await response.json() as any;assert.deepEqual(validateCanonicalFixture('console-records-codex',page),{valid:true,errors:[]});
  assert.equal(page.records.length,2);const large=page.records.find((r:any)=>r.rawUrl);assert.ok(large);assert.equal(large.raw,null);
  const raw=await fetch(`${f.origin}${large.rawUrl}`,{headers});assert.equal(raw.status,200);assert.equal(await raw.text(),oversized);assert.equal(Number(raw.headers.get('content-length')),Buffer.byteLength(oversized));
  const unauthorized=await fetch(`${f.origin}${large.rawUrl}`);assert.equal(unauthorized.status,401);
  assert.equal((await fetch(`${f.origin}/api/v1/console/sources/cs_one/records?before=invalid`,{headers})).status,400);
  assert.equal((await fetch(`${f.origin}/api/v1/console/stream?sourceId=cs_one&after=invalid`,{headers})).status,400);
});

test('history handoff and checkpoint resume retain split UTF-8 records and live appends',async t=>{
  const f=await fixture(t),s=await f.source('cs_one','{"type":"initial"}\n');
  const history=await (await fetch(`${f.origin}/api/v1/console/sources/cs_one/records`,{headers})).json() as any;
  await appendFile(s.file,'{"type":"after-history"}\n');
  const live=await f.stream(`sourceId=cs_one&after=${history.resumeCursor}`);
  const first=await live.next('record');assert.equal(JSON.parse(first.data.record.raw).type,'after-history');
  const checkpoint=await live.next('checkpoint');live.controller.abort();
  const bytes=Buffer.from('{"type":"split","text":"😀"}\n');const split=bytes.indexOf(Buffer.from('😀'))+2;
  await appendFile(s.file,bytes.subarray(0,split));
  const resumed=await f.stream('sourceId=cs_one',{'last-event-id':checkpoint.id!});
  await resumed.next('checkpoint');await appendFile(s.file,bytes.subarray(split));
  const record=await resumed.next('record');assert.equal(JSON.parse(record.data.record.raw).text,'😀');
  assert.notEqual(first.data.record.id,record.data.record.id);resumed.controller.abort();
});

test('active feed discovers another writer, scopes end, and reports offline coverage',async t=>{
  const f=await fixture(t),a=await f.source('cs_a','{"type":"a"}\n');
  const live=await f.stream('scope=active');await live.next('record');
  await f.source('cs_b','{"type":"b"}\n');
  const b=await live.next('record',v=>v.record.sourceId==='cs_b');assert.equal(JSON.parse(b.data.record.raw).type,'b');
  a.resolved.source.state='completed';a.resolved.streams[0]!.writerClosed=true;
  const ended=await live.next('end',v=>v.sourceId==='cs_a');assert.equal(ended.data.status,'drained');
  const checkpoint=await live.next('checkpoint');live.controller.abort();
  const resumed=await f.stream('scope=active',{'last-event-id':checkpoint.id!});
  assert.equal((await resumed.next('gap')).data.reason,'catalog_coverage_unknown');resumed.controller.abort();
});

test('revoked access closes a live stream and exact source controls preserve the expected target',async t=>{
  const f=await fixture(t);await f.source('cs_one');
  const body={expectedExecutionId:'cs_one'};
  const result=await fetch(`${f.origin}/api/v1/executions/cs_one/cancel`,{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':'console-control-0001'},body:JSON.stringify(body)});
  assert.equal(result.status,202);assert.equal((await result.json() as any).status,'cancellation_requested');
  assert.deepEqual(f.controls[0],{operation:'cancel',idempotencyKey:'console-control-0001',text:undefined,jobId:'cs_one',chatId:undefined,turnId:undefined,harnessWorkId:undefined,expectedJobId:'cs_one'});
  const live=await f.stream('sourceId=cs_one');await live.next('checkpoint');f.revoke();
  assert.equal((await live.next('gap')).data.reason,'stream_unavailable');
  assert.equal((await deadline(live.iterator.next())).done,true);
});

test('32-source checkpoints stay below header limit and selection mismatch fails before streaming',async t=>{
  const f=await fixture(t);
  for(let n=0;n<32;n++){const s=await f.source(`cs_${String(n).padStart(24,'0')}`);s.resolved.streams.push({...s.resolved.streams[0]!,id:'stderr'});}
  const ids=[...f.sources.keys()];const live=await f.stream(ids.map(id=>`sourceId=${id}`).join('&'));
  const checkpoint=await live.next('checkpoint');assert.ok(checkpoint.id!.length<=8192,checkpoint.id!.length.toString());live.controller.abort();
  const mismatch=await fetch(`${f.origin}/api/v1/console/stream?sourceId=${ids[0]}`,{headers:{...headers,'last-event-id':checkpoint.id!}});assert.equal(mismatch.status,400);
});

test('authenticated resident transport preserves exact target and retry identity',async t=>{
  const { ConversationHistory }=await import('../../../src/agent/history.js');
  const { createExecutionControlPort }=await import('../../../src/agent/execution-control.js');
  const { ResidentTurnUdsServer, ResidentUdsAgentPort }=await import('../../../src/coordination-adapter/resident-uds.js');
  const { createResidentCredential }=await import('../../../src/coordination/resident-protocol/index.js');
  const { ResidentUdsClient }=await import('../../../src/coordination/transport/uds/index.js');
  const { generateCoordinationId }=await import('../../../src/coordination/ids/index.js');
  const root=await mkdtemp(join(tmpdir(),'h23-console-uds-'));
  const credential=createResidentCredential({rootKey:Buffer.alloc(32,21),residentSlug:'jerry',role:'resident',instanceId:'home23-jerry-harness',keyVersion:1});
  const history=new ConversationHistory(join(root,'history'),100_000,'jerry');
  let stopped=0,ready=false;
  const agent={getModel:()=> 'fixture',getProvider:()=> 'fixture',getReasoningEffort:()=> 'medium' as const,runWithTurn:async()=>{throw new Error('Unexpected model run');},isRunning:()=>true,isTurnActive:(_chat:string,turn:string)=>turn==='t_one',executionTurnState:(_chat:string,turn:string)=>turn==='t_one'?'active' as const:'unknown' as const,steerExecution:()=>{throw new Error('Unexpected steering');},stop:(chat:string,turn:string)=>{assert.equal(chat,'shared');assert.equal(turn,'t_one');stopped++;return {stopped:true,chatIds:[chat]};}};
  const controls=createExecutionControlPort({instanceDir:root,agent});
  const server=new ResidentTurnUdsServer({socketPath:join(root,'r.sock'),serverInstanceId:'home23-jerry-harness',credential,residentSlug:'jerry',agent,history,executionControl:{available:()=>ready,execute:controls.execute}});
  await server.start();
  const client=new ResidentUdsClient({socketPath:join(root,'r.sock'),serverInstanceId:'home23-jerry-harness',credential});
  t.after(async()=>{await client.close();await server.close();await rm(root,{recursive:true,force:true});});
  const port=new ResidentUdsAgentPort({client,residentSlug:'jerry'});
  const identity=()=>({requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')});
  assert.equal(await port.executionCapabilities(identity()),false);ready=true;assert.equal(await port.executionCapabilities(identity()),true);
  const request={operation:'cancel' as const,chatId:'shared',turnId:'t_one',expectedTurnId:'t_other',idempotencyKey:'console-uds-stop-0001'};
  assert.equal((await port.executeControl(request,identity())).status,'stale_target');assert.equal(stopped,0);
  request.expectedTurnId='t_one';
  assert.equal((await port.executeControl(request,identity())).status,'cancellation_requested');
  assert.equal((await port.executeControl(request,identity())).status,'cancellation_requested');assert.equal(stopped,1);
});


test('an open Console releases the request when Core drains',async t=>{
  const f=await fixture(t);await f.source('cs_one');
  const live=await f.stream('sourceId=cs_one');await live.next('checkpoint');
  const drain=f.drain();
  assert.equal((await live.next('gap')).data.reason,'server_draining');
  assert.equal((await deadline(live.iterator.next())).done,true);
  await deadline(drain);
});
