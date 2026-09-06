import test from 'node:test';
import assert from 'node:assert/strict';
import { ResidentCoordinationAdapter } from '../../src/coordination-adapter/resident-adapter.js';
import { parsePlannedToolExecution } from '../../src/coordination-adapter/foreground-detachment-contract.js';
import type { ResidentAgentPort, ResidentCoordinationPort, ResidentWorkRequest } from '../../src/coordination-adapter/types.js';

const planned = { kind:'planned_tool' as const, invocationId:'selected-1',toolName:'spawn_agent',canonicalArgs:{task:'Inspect health'},executionInstruction:'Inspect health',title:'Health review',recoveryPolicy:'safe_before_start' as const };
const request: ResidentWorkRequest = {
  chatId:'coordination:channel:work',instruction:'Inspect health',requestId:'request',correlationId:'correlation',
  turnSelection:{modelAlias:null,reasoningEffort:null}, plannedExecution:planned,
  origin:{kind:'coordination',workId:'work',attemptId:'attempt',leaseId:'lease',holderPrincipalId:'resident',holderInstanceId:'harness',authorityReference:'resident:jerry',fencingToken:1,channelId:'channel',originMessageId:'message',roundId:null},
};
for (const durable of [false,true]) test(`planned cancellation ${durable ? 'settles from durable stop' : 'stays unresolved after transport loss'}`, async () => {
  let receipts = 0;
  const agent = {
    async runWithTurn(chatId: string, _instruction: string, options: Parameters<ResidentAgentPort['runWithTurn']>[2]) {
      await options.onDurableStart({turnId:'turn',chatId,persistedAt:'2026-09-04T12:00:00.000Z'});
      const response = Promise.reject(new Error(durable ? 'operator_stop' : 'connection_lost'));
      const terminal = durable ? Promise.resolve({status:'stopped',lastSequence:0,endedAt:'2026-09-04T12:00:01.000Z',errorCode:'operator_stop',errorMessage:'Stopped',provider:'provider',model:'model',reasoningEffort:null}) : Promise.reject(new Error('connection_lost'));
      void terminal.catch(()=>undefined);
      return {turnId:'turn',response,terminal};
    },
    stop:()=>({stopped:false}),
  } as unknown as ResidentAgentPort;
  const coordination = {
    assertCurrent:()=>{},accept:()=>{},start:()=>{},
    cancellationState:()=>({timestamp:'2026-09-04T12:00:01.000Z'}),
    terminalize:({receipt}:{receipt: {status:string}})=>{assert.equal(receipt.status,'cancelled');receipts++;},
  } as unknown as ResidentCoordinationPort;
  const adapter = new ResidentCoordinationAdapter(agent,coordination);
  const execution = await adapter.execute(request);
  void execution.response.catch(()=>undefined);
  if (durable) { assert.equal((await execution.receipt).status,'cancelled'); assert.equal(receipts,1); }
  else { await assert.rejects(execution.receipt,/durable|confirm|terminal/i); assert.equal(receipts,0); }
});

test('signed planned execution refuses tools that cannot satisfy the joined recovery contract', () => {
  for (const toolName of ['shell','nonexistent']) assert.throws(()=>parsePlannedToolExecution({...planned,toolName}));
  assert.equal(parsePlannedToolExecution({ ...planned, toolName: 'research_launch', recoveryPolicy: 'idempotent_operation' }).recoveryPolicy, 'idempotent_operation');
  assert.throws(() => parsePlannedToolExecution({ ...planned, toolName: 'generate_image', recoveryPolicy: 'idempotent_operation' }));
  for (const toolName of ['spawn_agent', 'worker_run', 'skills_run', 'generate_image', 'generate_music', 'tts'])
    assert.equal(parsePlannedToolExecution({ ...planned, toolName }).toolName, toolName);
});
