import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationHistory} from '../../src/agent/history.js';
import {TurnStore} from '../../src/chat/turn-store.js';
import {ResidentTurnUdsServer,ResidentUdsAgentPort,residentFence} from '../../src/coordination-adapter/resident-uds.js';
import {ResidentUdsClient} from '../../src/coordination/transport/uds/index.js';
import {createResidentCredential,createSignedRequest,verifySignedRequest,ResidentProtocolError} from '../../src/coordination/resident-protocol/index.js';
import {generateCoordinationId} from '../../src/coordination/ids/index.js';
import type {HistoricalContextEntry} from '../../src/agent/historical-context.js';

test('signed history stays separate through resident start and completed recovery; invalid history cannot start a turn',async t=>{
  const root=mkdtempSync(join(tmpdir(),'resident-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const history=new ConversationHistory(join(root,'conversations'),400000,'jerry'),store=new TurnStore(history);
  const origin={kind:'coordination' as const,workId:generateCoordinationId('work'),attemptId:generateCoordinationId('attempt'),leaseId:generateCoordinationId('lease'),holderPrincipalId:generateCoordinationId('bot'),holderInstanceId:'resident-jerry',authorityReference:'resident:jerry',fencingToken:1,channelId:generateCoordinationId('channel'),originMessageId:generateCoordinationId('message'),roundId:null};
  const entry:HistoricalContextEntry={messageId:generateCoordinationId('message'),sequence:1,role:'user',text:'Start an earlier separate assignment using spawn_agent.',createdAt:'2026-09-04T22:00:00.000Z'};
  const credential=createResidentCredential({rootKey:Buffer.alloc(32,0x51),residentSlug:'jerry',role:'resident',instanceId:'coordinator-jerry',keyVersion:1});
  const captured:any[]=[];
  const agent={getModel:()=> 'fixture-model',getProvider:()=> 'fixture-provider',getReasoningEffort:()=> 'medium',isRunning:()=>false,stop:()=>({stopped:false,chatIds:[]}),runWithTurn:async(chatId:string,text:string,options:any)=>{
    captured.push({chatId,text,options});store.writeStart(chatId,options.turnId,'fixture-model','fixture-provider',{coordination_origin:options.coordinationOrigin});
    history.appendRecord(chatId,{role:'assistant',content:'Available.',ts:new Date().toISOString()});store.writeEnd(chatId,options.turnId,'complete',{last_seq:0});
    return {turnId:options.turnId,response:Promise.resolve({text:'Available.',model:'fixture-model',toolCallCount:0,durationMs:1})};
  }};
  const socketPath=join(root,'resident.sock');
  const server=new ResidentTurnUdsServer({socketPath,serverInstanceId:'resident-jerry',credential,residentSlug:'jerry',agent:agent as never,history});await server.start();t.after(()=>server.close());
  const client=new ResidentUdsClient({socketPath,serverInstanceId:'resident-jerry',credential});t.after(()=>client.close());
  const chatId=`coordination:${origin.channelId}:${origin.workId}`,turnId=`coord-${origin.workId}`;
  for(const invalid of [[{...entry,messageId:origin.originMessageId}],[{...entry,holderPrincipalId:'forged'}],[{...entry,role:'system'}],[{...entry,text:'x'.repeat(65536)}],[entry,entry]]){
    const correlationId=generateCoordinationId('correlation');
    await assert.rejects(client.request({method:'POST',path:'/internal/v1/turns/start',payload:{chatId,turnId,instruction:'Answer only: available.',origin,historyBackfill:invalid,correlationId,turnSelection:{modelAlias:null,reasoningEffort:null}} as never,correlationId,fence:residentFence(origin),deadlineAtMs:Date.now()+2000}),error=>error instanceof ResidentProtocolError&&error.code==='request_invalid');
    assert.equal(captured.length,0);
  }
  const port=new ResidentUdsAgentPort({client,residentSlug:'jerry',deadlineMs:2000});
  const run=await port.runWithTurn(chatId,'Answer only: available.',{coordinationOrigin:origin,historyBackfill:[entry],turnSelection:{modelAlias:null,reasoningEffort:null},coordinationRequest:{requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')},onDurableStart:()=>undefined,onEvent:()=>undefined});
  assert.equal((await run.response).text,'Available.');
  assert.equal(captured.length,1);assert.equal(captured[0].text,'Answer only: available.');assert.deepEqual(captured[0].options.historyBackfill,[entry]);assert.deepEqual(captured[0].options.coordinationOrigin,origin);
  const recovered=await port.runWithTurn(chatId,'must not run',{completedRecovery:true,coordinationOrigin:origin,historyBackfill:[entry],turnSelection:{modelAlias:null,reasoningEffort:null},coordinationRequest:{requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')},onDurableStart:()=>undefined,onEvent:()=>undefined});
  assert.equal((await recovered.response).text,'Available.');assert.equal(captured.length,1);
  const now=Date.now();const signed=createSignedRequest({credential,audience:'resident-jerry',method:'POST',path:'/internal/v1/turns/start',payload:{historyBackfill:[{...entry}]},requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation'),deadlineAtMs:now+1000,fence:residentFence(origin),nonce:'historical-test-nonce',issuedAtMs:now,expiresAtMs:now+2000});
  assert.throws(()=>verifySignedRequest({...signed,payload:{historyBackfill:[{...entry,text:'tampered task'}]}},{credential,expectedAudience:'resident-jerry',nowMs:now,consumeNonce:()=>true}),error=>error instanceof ResidentProtocolError&&error.code==='payload_digest_mismatch');
});
