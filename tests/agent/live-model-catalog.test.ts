import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';
import yaml from 'js-yaml';
import { createModelAliasReader } from '../../src/config.js';
import { createModelsHandler } from '../../src/routes/chat-turn.js';
import { resolveCatalogModelOverride, resolveModelOverride } from '../../src/agent/model-resolution.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { ResidentTurnUdsServer, ResidentUdsAgentPort } from '../../src/coordination-adapter/index.js';
import { createResidentCredential } from '../../src/coordination/resident-protocol/index.js';
import { ResidentUdsClient } from '../../src/coordination/transport/uds/index.js';
const require = createRequire(import.meta.url);
const { createSettingsRouter } = require('../../engine/src/dashboard/home23-settings-api.js');

test('saving a house catalog updates an already running resident and bridge without restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'h23-live-models-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  mkdirSync(join(root,'config'), {recursive:true});
  mkdirSync(join(root,'instances/jerry'), {recursive:true});
  const initial = { home:{primaryAgent:'jerry'}, chat:{defaultProvider:'openai-codex',defaultModel:'gpt-fixture-base'},
    providers:{'openai-codex':{defaultModels:['gpt-fixture-base']}},
    models:{aliases:{base:{provider:'openai-codex',model:'gpt-fixture-base'}}} };
  const homePath = join(root,'config/home.yaml');
  writeFileSync(homePath,yaml.dump(initial));
  writeFileSync(join(root,'config/secrets.yaml'),'providers: {}\n');
  writeFileSync(join(root,'instances/jerry/config.yaml'),yaml.dump({chat:initial.chat}));
  mkdirSync(join(root,'cli/lib'),{recursive:true});
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  writeFileSync(join(root,'cli/lib/evobrew-config.js'),'export function writeEvobrewConfig() {}');
  const readAliases = createModelAliasReader(root,'jerry');
  const pinnedBeforeEdit = resolveModelOverride('base',readAliases());
  const agent = {getModel:()=> 'gpt-fixture-base',getProvider:()=> 'openai-codex',getReasoningEffort:()=> 'medium',
    toolContext:{get modelAliases(){return readAliases();}}, isRunning:()=>false,stop:()=>({stopped:false,chatIds:[]})} as any;
  const history = new ConversationHistory(join(root,'history'),400_000,'jerry');
  const credential = createResidentCredential({rootKey:Buffer.alloc(32,7),residentSlug:'jerry',role:'resident',instanceId:'fixture',keyVersion:1});
  const socketPath=join(root,'resident.sock');
  const resident = new ResidentTurnUdsServer({socketPath,serverInstanceId:'fixture',credential,residentSlug:'jerry',agent,history,
    get modelAliases(){return readAliases();}});
  await resident.start();
  t.after(()=>resident.close());
  const client = new ResidentUdsClient({socketPath,serverInstanceId:'fixture',credential});
  t.after(()=>client.close());
  const port = new ResidentUdsAgentPort({client,residentSlug:'jerry'});
  const request={requestId:'req_0198d95f-6c00-7000-8000-0000000000c1',correlationId:'cor_0198d95f-6c00-7000-8000-0000000000c2'};
  const app = express(); app.use(express.json());
  let restarts=0;
  app.use('/settings', createSettingsRouter(root, {
    seedModelAuthority:async()=>{}, onModelAuthorityChanged:async()=>({refreshed:['fixture']}),
    recycleManagedProcess:()=>{restarts++;return false;},
  }).router);
  app.get('/models',createModelsHandler({agentName:'jerry',agent,history,get modelAliases(){return readAliases();}}));
  const server=http.createServer(app);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const bridge=()=>fetch(base+'/models').then(r=>r.json());
  assert.deepEqual((await bridge()).models.map((m:any)=>m.alias),['base']);
  assert.equal((await port.modelCatalog(request)).models.length,1);
  const aliases={...initial.models.aliases, future:{provider:'openai-codex',model:'gpt-fixture-next'}};
  const save=await fetch(base+'/settings/models',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
    agent:'jerry',providerModels:{'openai-codex':['gpt-fixture-base','gpt-fixture-next']},aliases,
  })});
  assert.equal(save.status,200,await save.text());
  assert.equal((await bridge()).models.find((m:any)=>m.alias==='future').model,'gpt-fixture-next');
  assert.equal((await port.modelCatalog(request)).models.find(m=>m.alias==='future')?.provider,'openai-codex');
  assert.deepEqual(resolveModelOverride('future',readAliases()),{provider:'openai-codex',model:'gpt-fixture-next'});
  const remove=await fetch(base+'/settings/models',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
    agent:'jerry',providerModels:{'openai-codex':['gpt-fixture-base']},aliases:initial.models.aliases,
  })});
  assert.equal(remove.status,200,await remove.text());
  assert.equal((await port.modelCatalog(request)).models.some(m=>m.alias==='future'),false);
  assert.equal(resolveModelOverride('future',readAliases()),null);
  assert.deepEqual(pinnedBeforeEdit,{provider:'openai-codex',model:'gpt-fixture-base'});
  assert.equal(restarts,0);
  assert.equal(resolveCatalogModelOverride('gpt-fixture-next',readAliases()),null, 'A removed picker entry must never fall back to another provider');
  const prior=readFileSync(homePath,'utf8');
  const invalid=await fetch(base+'/settings/models',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'jerry',aliases:{}})});
  assert.equal(invalid.status,400);
  assert.equal(readFileSync(homePath,'utf8'),prior);
  writeFileSync(homePath,'models: [broken:');
  assert.throws(readAliases);
  writeFileSync(homePath,prior);
  assert.equal(readAliases().base?.model,'gpt-fixture-base');
});
