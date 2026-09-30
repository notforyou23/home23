import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledChannelTurn, deliverScheduledChannelFailure } from '../../src/scheduler/channel-run.js';
import { ResidentProtocolError } from '../../src/coordination/resident-protocol/errors.js';
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
test('explicit permanent scheduled rejection settles, while busy and unknown rejection remain pending', async () => {
  const execute = (error: unknown) => runScheduledChannelTurn(input, {runId: input.runId, persistCanonicalTurn: () => {}}, async () => {throw error;});
  const rejected = await execute(new ResidentProtocolError('request_invalid', 'Foreign direct conversation'));
  assert.equal(rejected.status, 'error'); assert.equal(rejected.semanticStatus, 'failed');
  assert.equal(rejected.canonicalRunPending, undefined); assert.match(rejected.error!, /rejected: Foreign direct/);
  for (const error of [new ResidentProtocolError('server_busy', 'Busy', {retryable: true}),
    new ResidentProtocolError('internal_error', 'Unknown admission', {retryable: true}),
    Object.assign(new Error('Unverified rejection'), {code: 'request_invalid'})]) {
    const pending = await execute(error); assert.equal(pending.canonicalRunPending, true); assert.equal(pending.semanticStatus, 'unknown');
  }
});

test('a completed refusal is delivered but never counted as the editorial objective satisfied',async()=>{
  const result=await runScheduledChannelTurn(input,{runId:input.runId,persistCanonicalTurn:()=>{}},async()=>({state:'succeeded',text:'I refuse to run this; ask me again.'}));
  assert.equal(result.status,'ok');assert.equal(result.semanticStatus,'unknown');assert.equal(result.outcomeLayers?.task?.status,'unknown');
});

for (const state of ['blocked', 'cancelled'] as const) test(`a succeeded Work reporting ${state} is a terminal scheduled failure with conclusion evidence`, async () => {
  const conclusion = { state, summary: 'Cannot save the canonical project state', workId: 'work-fixture', evidence: ['STATE.json refusal'] };
  const result = await runScheduledChannelTurn(input, { runId: input.runId, persistCanonicalTurn: () => {} },
    async () => ({ state: 'succeeded', text: 'The assignment is blocked.', conclusion }));
  assert.equal(result.status, 'error'); assert.equal(result.semanticStatus, 'failed');
  assert.match(result.error!, new RegExp(`reported ${state}: Cannot save`));
  assert.equal(result.response, 'The assignment is blocked.');
  assert.deepEqual(result.outcomeLayers?.task?.evidence?.conclusion, conclusion);
  assert.equal(result.canonicalRunPending, undefined);
});

test('a self-reported completion remains unverified', async () => {
  const result = await runScheduledChannelTurn(input, { runId: input.runId, persistCanonicalTurn: () => {} },
    async () => ({ state: 'succeeded', text: 'Done', conclusion: { state: 'complete', summary: 'Saved the file' } }));
  assert.equal(result.status, 'ok'); assert.equal(result.semanticStatus, 'unknown');
});

test('only terminal channel-run errors take the cron alert path, recording its actual outcome', async () => {
  let calls = 0;
  const outcome = { status: 'suppressed' as const, reason: 'fixture', retryEligible: false };
  const deliver = async () => { calls++; return outcome; };
  for (const result of [{ status: 'ok' as const, durationMs: 1 },
    { status: 'error' as const, canonicalRunPending: true, durationMs: 1 }]) {
    assert.equal((await deliverScheduledChannelFailure(result, deliver)).deliveryOutcome, undefined);
  }
  const result = await deliverScheduledChannelFailure({ status: 'error', error: 'Work failed', durationMs: 1 }, deliver);
  assert.equal(calls, 1); assert.deepEqual(result.deliveryOutcome, outcome);
});
