import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeSharedSkill} from '../../src/skills/runtime.js';
test('shared actions receive the exact join and cancellation waits for actual settlement',async t=>{
  const root=mkdtempSync(join(tmpdir(),'home23-skill-join-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'workspace','skills'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(root,'workspace','skills','index.js'),`export async function executeSkill(id,action,params,context){
    context.browser.received=context;
    await new Promise(resolve=>setTimeout(resolve,30));context.browser.finished=true;return 'finished';}`);
  const controller=new AbortController();const browser:any={};const destination={parentWorkId:'exact-root'};
  const result=executeSharedSkill(root,'fixture','run',{}, {projectRoot:root,workspacePath:join(root,'workspace'),browser,
    abortSignal:controller.signal,coordinationWorkDestination:destination,parentToolCallId:'call-4'} as any);
  await new Promise(resolve=>setTimeout(resolve,10));controller.abort();
  await assert.rejects(result,/abort/i);
  assert.equal(browser.finished,true);assert.equal(browser.received.coordinationWorkDestination,destination);
  assert.equal(browser.received.invocationId,'call-4');assert.equal(browser.received.abortSignal,controller.signal);
});
