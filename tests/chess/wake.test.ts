import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ResidentUdsServer } from '../../src/coordination/transport/uds/index.js';
import { createResidentCredential } from '../../src/coordination/resident-protocol/index.js';
import { signedChessWake } from '../../src/chess/wake.js';
test('adapter signs existing scheduled submission path with configured resident identity and unchanged durable run', async () => {
  const dir = await mkdtemp('/tmp/chess-uds-'); const socketPath=join(dir,'core.sock');
  const rootKey=Buffer.alloc(32,17);
  const credential=createResidentCredential({residentSlug:'executive',role:'resident',instanceId:'fixture-executive',keyVersion:1,rootKey});
  const input={runId:'sched-run-0198d95f-6c00-7000-8000-000000000011',jobId:'chess-session:fixture',channelId:'chn_01a0ba12-afc6-704a-9ad5-d4665e2e3fda',prompt:'White played Nc3',targetBotId:'bot_chester'};
  let calls=0;
  const server=new ResidentUdsServer({socketPath,serverInstanceId:'fixture-core',credentials:[credential],validateFence:fence=>fence===null,
    handleRequest:(request,context)=>{ calls++; assert.equal(context.credential.residentSlug,'executive'); assert.equal(request.path,'/internal/v1/scheduled-turns'); assert.equal(request.method,'POST'); assert.deepEqual(request.payload,input); return {state:'succeeded',workIds:['canonical-work']}; }});
  const adapter=signedChessWake({HOME23_AGENT:'executive',HOME23_COORDINATION_RESIDENT_KEY:rootKey.toString('hex'),HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID:'fixture-executive',HOME23_COORDINATION_RESIDENT_KEY_VERSION:'1',HOME23_COORDINATION_SOCKET_PATH:socketPath,HOME23_COORDINATION_SERVER_INSTANCE_ID:'fixture-core'});
  try { await server.start(); assert.deepEqual(await adapter.submit(input),{state:'succeeded',workIds:['canonical-work']}); assert.equal(calls,1); }
  finally { await adapter.close(); await server.close(); await rm(dir,{recursive:true,force:true}); }
});
