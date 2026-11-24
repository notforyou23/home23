import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkspaceTurns} from './workspace-turn.mjs';

function start(workspace, response) {
  const log = [];
  const actions = [{command:'wc -c sample.txt'}, {answer:'The file has six bytes.'}];
  const abort = new AbortController();
  const result = workspace.answer({
    turn:{id:'turn1',model:'local'}, messages:[{role:'system',content:'Jerry'}],
    cwd:'/work', signal:abort.signal, checkWriter:()=>abort.signal.throwIfAborted(),
    model:{generate:async ({messages})=>{
      log.push(structuredClone(messages));
      return JSON.stringify(actions.shift());
    }},
    publish:action=>queueMicrotask(()=>response(action,abort))
  });
  return {result,log};
}

test('workspace results require a single matching live claim and reach the model',async ()=>{
  const workspace = new WorkspaceTurns();
  const receipt = {exitCode:0,output:'6 sample.txt'};
  const {result,log} = start(workspace,({callId})=>{
    assert.equal(workspace.receive('turn1',callId,receipt),false);
    assert.equal(workspace.claim('other',callId),false);
    assert.equal(workspace.claim('turn1',callId),true);
    assert.equal(workspace.claim('turn1',callId),false);
    assert.equal(workspace.receive('turn1',callId,receipt),true);
    assert.equal(workspace.receive('turn1',callId,receipt),false);
  });
  assert.equal(await result,'The file has six bytes.');
  assert.match(log[1].at(-1).content,/6 sample.txt/);
});

test('denial stops the loop and cancellation invalidates the pending command',async ()=>{
  const workspace = new WorkspaceTurns();
  const denied = start(workspace,({callId})=>workspace.receive('turn1',callId,{denied:true}));
  assert.match(await denied.result,/declined/);
  assert.equal(denied.log.length,1);
  const cancelled = start(workspace,({callId},abort)=>{
    abort.abort();
    assert.equal(workspace.claim('turn1',callId),false);
  });
  await assert.rejects(cancelled.result,{name:'AbortError'});
});

test('a workspace turn can finish after more than 24 approved commands',async ()=>{
  const workspace = new WorkspaceTurns();
  const signal = new AbortController().signal;
  let receipts = 0;
  const answer = await workspace.answer({
    turn:{id:'long',model:'local'}, messages:[{role:'system',content:'Jerry'}],
    cwd:'/work', signal, checkWriter:()=>signal.throwIfAborted(),
    model:{generate:async ()=>JSON.stringify(receipts < 25 ? {command:'pwd'} : {answer:'Complete.'})},
    publish:({callId})=>{
      assert.equal(workspace.claim('long',callId),true);
      assert.equal(workspace.receive('long',callId,{exitCode:0,output:'/work'}),true);
      receipts++;
    }
  });
  assert.equal(receipts,25);
  assert.equal(answer,'Complete.');
});

test('a plain model reply is displayed without executing it', async () => {
  const workspace = new WorkspaceTurns();
  const result = await workspace.answer({
    turn: {id:'chat', model:'local'}, messages:[{role:'system',content:'Jerry'}],
    cwd:'/work', signal:new AbortController().signal, checkWriter:()=>{},
    model:{generate:async ()=>'marigold'},
    publish:()=>assert.fail('A chat reply must never execute a command.')
  });
  assert.equal(result, 'marigold');
});
