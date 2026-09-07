import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHelperServices} from '../../../src/coordination/app/helper-services.js';
import type {ToolContext} from '../../../src/agent/types.js';
import type {HomeConfig} from '../../../src/types.js';

test('helper scheduled commands execute directly, retain results across service recreation, and keep silent jobs silent',async t=>{
 const root=mkdtempSync('/private/tmp/home23-helper-services-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const botRoot=join(root,'bot');mkdirSync(join(botRoot,'workspace'),{recursive:true});
 const delivered:string[]=[];
 const config={scheduler:{timezone:'UTC',jobsFile:'ignored',runsDir:'ignored'}} as HomeConfig;
 const create=()=>{
  const services=createHelperServices({root,botRoot,workspace:join(botRoot,'workspace'),agentName:'bot-helper',enginePort:1,config,schedule:async input=>{delivered.push(input.prompt);return {state:'succeeded',text:'Delivered'};}});
  const ctx={...services.context,modelAliases:{}} as ToolContext;
  services.attach({runWithTurn:()=>{throw new Error('A scheduled command must not launch a local model');}} as any,ctx);
  return {services,scheduler:ctx.scheduler!};
 };
 let runtime=create();t.after(()=>runtime.services.close());
 runtime.scheduler.addJob({id:'command',name:'Command receipt',enabled:true,schedule:{kind:'every',everyMs:60000},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'exec',channelId:'chn_fixture',command:'echo actual-execution'},delivery:{mode:'none'},state:{nextRunAtMs:Date.now()+60000,consecutiveErrors:0}});
 const first=await runtime.scheduler.runJobNow('command');assert.equal(first.status,'ok');assert.equal(first.response,'actual-execution');assert.equal(delivered.length,0);
 runtime.services.close();runtime=create();assert.equal(runtime.scheduler.getJobs().length,1);assert.equal(runtime.scheduler.getRecentRuns('command').length,1);
 assert.equal(runtime.scheduler.getRecentRuns('command')[0]!.status,'ok');
 const job=runtime.scheduler.getJob('command')!;job.delivery={mode:'summary'};
 runtime.scheduler.addJob({...job,id:'announced'});
 assert.equal((await runtime.scheduler.runJobNow('announced')).status,'ok');
 assert.equal(delivered.length,1);assert.match(delivered[0]!,/already-executed/);assert.match(delivered[0]!,/actual-execution/);
});
