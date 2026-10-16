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

const { createModelDiscovery } = require('../../shared/model-discovery.cjs');

test('automatic discovery updates a running resident, Settings, and bridge without editing configuration or restarting', async t => {
  const root = mkdtempSync(join(tmpdir(), 'h23-live-models-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  mkdirSync(join(root,'config'), {recursive:true});
  mkdirSync(join(root,'instances/jerry'), {recursive:true});
  const initial = { home:{primaryAgent:'jerry'}, chat:{defaultProvider:'openai-codex',defaultModel:'gpt-fixture-base'},
    providers:{'openai-codex':{defaultModels:['gpt-fixture-base']}},
    models:{aliases:{base:{provider:'openai-codex',model:'gpt-fixture-base'}}} };
  const homePath = join(root,'config/home.yaml');
  writeFileSync(homePath,yaml.dump(initial));
  writeFileSync(join(root,'config/secrets.yaml'),'providers:\n  openai-codex:\n    apiKey: fixture-key\n');
  writeFileSync(join(root,'instances/jerry/config.yaml'),yaml.dump({chat:initial.chat}));
  let listed = ['gpt-fixture-base'];
  let calls = 0;
  const discovery = createModelDiscovery({home23Root:root,env:{},autoStart:false,fetchImpl:async()=>{
    calls++;
    return {ok:true,json:async()=>({models:listed.map(slug=>({slug,supported_in_api:true,visibility:'list',
      supported_reasoning_levels:slug==='future-only'?[{effort:'ultra'}]:[{effort:'low'},{effort:'ultra'}],default_reasoning_level:slug==='future-only'?'ultra':'low'}))})};
  }});
  t.after(()=>discovery.close());
  await discovery.refreshAll();
  const readAliases = createModelAliasReader(root,'jerry',discovery);
  const pinnedBeforeEdit = resolveCatalogModelOverride('base',readAliases());
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
  app.use('/settings', createSettingsRouter(root, {modelDiscoveryService:discovery,
    seedModelAuthority:async()=>{}, onModelAuthorityChanged:async()=>({refreshed:['fixture']}),
    recycleManagedProcess:()=>{restarts++;return false;},
  }).router);
  app.get('/models',createModelsHandler({agentName:'jerry',agent,history,get modelAliases(){return readAliases();}}));
  const server=http.createServer(app);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const bridge=()=>fetch(base+'/models').then(r=>r.json());
  const original=readFileSync(homePath,'utf8');
  assert((await bridge()).models.some((m:any)=>m.alias==='base'));
  const before = await port.modelCatalog(request);
  assert(before.models.some(m=>m.alias==='base'));
  listed = ['gpt-fixture-base','future-no-family'];
  await discovery.refreshAll({force:true});
  const alias='openai-codex/future-no-family';
  assert.equal((await bridge()).models.find((m:any)=>m.alias===alias).model,'future-no-family');
  const refreshed=await port.modelCatalog(request);
  const option=refreshed.models.find(m=>m.alias===alias)!;
  assert.equal(option.provider,'openai-codex');
  assert.deepEqual(option.reasoningEfforts,['low']);
  assert.deepEqual(option.reasoningEffortOptions,['low','ultra']);
  const settings=await fetch(base+'/settings/models?agent=jerry').then(r=>r.json());
  assert(settings.catalog.some((m:any)=>m.model==='future-no-family'));
  assert.equal(settings.discovery.providers['openai-codex'].state,'fresh');
  listed=['future-no-family'];
  await discovery.refreshAll({force:true});
  assert.equal((await port.modelCatalog(request)).models.some(m=>m.alias==='base'),false);
  assert.equal(resolveCatalogModelOverride('base',readAliases()),null);
  assert.equal(pinnedBeforeEdit?.model,'gpt-fixture-base','Already resolved in-flight selection retains its original pair');
  assert.equal(restarts,0); assert.equal(calls,3);
  assert.equal(readFileSync(homePath,'utf8'),original);
  const missing=await fetch(base+'/settings/models?agent=jerry').then(r=>r.json());
  assert(missing.unavailableSelections.some((m:any)=>m.model==='gpt-fixture-base'));
  listed=[...Array.from({length:150},(_,i)=>`many-model-${i}`),'future-only'];
  await discovery.refreshAll({force:true});
  const full=await bridge();
  assert.equal(full.modelOptions.length,151);
  assert(full.models.length<=128);
  assert(full.models.every((m:any)=>m.reasoningEfforts.length>0 && m.reasoningEfforts.every((v:string)=>['none','low','medium','high','xhigh','max'].includes(v))));
  assert(!full.models.some((m:any)=>m.model==='future-only'));
  assert.deepEqual(full.modelOptions.find((m:any)=>m.model==='future-only').reasoningEffortOptions,['ultra']);
  const fullResident=await port.modelCatalog(request);
  assert.equal(fullResident.modelOptions?.length,151);
  assert(fullResident.models.length<=128);
});
