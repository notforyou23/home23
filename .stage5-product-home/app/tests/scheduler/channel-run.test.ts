import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledChannelTurn } from '../../src/scheduler/channel-run.js';
const input={runId:'sched-run-fixture',jobId:'editorial',channelId:'topic',prompt:'Prepare newsletter'};
test('canonical scheduler persists before dispatch and waits for the final result',async()=>{
  let persisted=false;let calls=0;
  const result=await runScheduledChannelTurn(input,{runId:input.runId,persistCanonicalTurn:received=>{assert.deepEqual(received,input);persisted=true;}},async()=>{
    assert.equal(persisted,true);calls++;return calls===1?{state:'running'}:{state:'succeeded',text:'Saved draft'};
  },async()=>{});
  assert.equal(result.status,'ok');assert.equal(result.response,'Saved draft');assert.equal(calls,2);assert.equal(result.semanticStatus,'unknown');assert.equal(result.outcomeLayers?.intent?.status,'unknown');
});
test('lost admission response remains pending and never invokes a local fallback',async()=>{
  const result=await runScheduledChannelTurn(input,{runId:input.runId,persistCanonicalTurn:()=>{}},async()=>{throw new Error('lost response');});
  assert.equal(result.canonicalRunPending,true);assert.equal(result.semanticStatus,'unknown');
});

test('a completed refusal is delivered but never counted as the editorial objective satisfied',async()=>{
  const result=await runScheduledChannelTurn(input,{runId:input.runId,persistCanonicalTurn:()=>{}},async()=>({state:'succeeded',text:'I refuse to run this; ask me again.'}));
  assert.equal(result.status,'ok');assert.equal(result.semanticStatus,'unknown');assert.equal(result.outcomeLayers?.task?.status,'unknown');
});
