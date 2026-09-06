import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';

class Clock {
  time=Date.now(); next=0; tasks=new Map<number,{at:number;run:()=>void}>();
  now=()=>this.time;
  setTimeout=(run:()=>void,ms:number)=>{const id=++this.next;this.tasks.set(id,{at:this.time+ms,run});return id;};
  clearTimeout=(id:unknown)=>{this.tasks.delete(id as number);};
  advance(ms:number){this.time+=ms;for(const [id,t] of [...this.tasks])if(t.at<=this.time&&this.tasks.delete(id))t.run();}
}
for(const mode of ['active','stalled','hard','stop','shutdown'] as const)test(`Codex ${mode}: progress respects inactivity, hard ceiling and Stop`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-progress-'));mkdirSync(join(root,'workspace'));
 const history=new ConversationHistory(join(root,'history'),400000,'test');
 const agent=new AgentLoop({apiKey:'test',provider:'openai-codex',model:'gpt-5.5',workspacePath:join(root,'workspace'),
  history,registry:createSeededToolRegistry([]),contextManager:{getSystemPrompt:()=> 'Fixture',getPromptSourceInfo:()=>({loadedFiles:[]})} as any,
  toolContext:{brainOperations:{withActivityHandler(){return this;}},turnRuntime:null} as any});
 const clock=new Clock();(agent as any).turnTiming=clock;(agent as any).codexCredentialsProvider=async()=>({accessToken:'test',refreshToken:'test',expires:Date.now()+3600000,accountId:'fixture'});
 const priorFetch=globalThis.fetch;const priorTimeout=AbortSignal.timeout;const usedTimeouts:number[]=[];
 AbortSignal.timeout=((ms:number)=>{usedTimeouts.push(ms);return priorTimeout(ms);}) as typeof AbortSignal.timeout;
 let calls=0;
 globalThis.fetch=(async(_url:any,init:any)=>{
  calls++;const signal=init.signal as AbortSignal;let n=0;
  return new Response(new ReadableStream<Uint8Array>({pull(controller){
   n++;clock.advance(mode==='stalled'?100000:70000);
   if(mode==='stop')agent.stop('progress');
   if(mode==='shutdown')agent.stop('progress',undefined,'harness_shutdown');
   if(signal.aborted){controller.error(signal.reason);return;}
   const event=n<4?{type:'response.reasoning_summary_text.delta',delta:'reasoning progress'}:{type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'done'}]}],usage:{input_tokens:10,output_tokens:10}}};
   controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));if(n===4)controller.close();
  }},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch;
 try{
  const started=await agent.runWithTurn('progress','bounded fixture',{inactivityMs:90000,hardDurationMs:mode==='hard'?180000:600000,firstTokenTimeoutMs:60000});
  if(mode==='active'){const result=await started.response;assert.equal(result.text,'done');assert.equal(calls,1);assert.ok(!usedTimeouts.includes(120000),'no hidden fixed two-minute deadline');}
  else await assert.rejects(started.response,mode==='shutdown'?/harness_shutdown/i:mode==='stop'?/operator_stop|abort/i:mode==='hard'?/hard.*timeout/i:/inactivity.*timeout/i);
 }finally{globalThis.fetch=priorFetch;AbortSignal.timeout=priorTimeout;rmSync(root,{recursive:true,force:true});}
});
