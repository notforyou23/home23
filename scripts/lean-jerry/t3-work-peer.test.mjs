import test from 'node:test';
import assert from 'node:assert/strict';
import {syncT3Work,syncWorkConnections,stopExpiredRuns} from './t3-work-peer.mjs';

function wire() {
  const target='fixed-thread';
  const identify={threadId:target,interactionMode:'plan',runtimeMode:'approval-required',archived:false,parentThreadId:null,activeRunId:null};
  const work={threadId:'one',status:'waiting',dispatchable:true,messages:[],revision:0};
  const state={},posts=[],sends=new Map(),stops=[],items=[];
  let run=null, drop=false, runStatus='running';
  const direct=text=>{work.revision++;work.messages.push({from:'owner',kind:work.revision===1?'request':'direction',id:'o'+work.revision,text,revision:work.revision});};
  direct('Compare the two drafts.');
  const jerry={async call(name,a){
    if(name==='jerry_work_list')return [work];
    if(name==='jerry_thread_read')return structuredClone(work);
    if(name==='jerry_thread_post'){assert.equal(a.revision,work.revision);if(!posts.some(x=>x.messageId===a.messageId))posts.push(a);if(a.kind==='result')work.status='done';return {};}
    throw new Error(name);
  }};
  const t3={async call(name,a){
    assert.equal(a.threadId,target);
    if(name==='t3_thread_read')return {thread:identify,recentRuns:run?[{runId:run,status:runStatus}]:[],items};
    if(name==='t3_thread_send'){
      if(!sends.has(a.clientRequestId)){run='run-1';sends.set(a.clientRequestId,a.message);identify.activeRunId=run;}
      if(drop){drop=false;throw new Error('lost receipt');}
      return {threadId:target,runId:run};
    }
    if(name==='t3_thread_interrupt'){stops.push(a.runId);return {};}
    throw new Error(name);
  }};
  const tick=(options={})=>syncT3Work({jerry,t3,target,state,save(){},...options});
  const addReply=(text,fields={})=>items.push({sourceThreadId:target,visibility:'local',runId:run,type:'assistant_message',createdBy:'agent',text,
    position:items.length+1,itemId:'m'+items.length,...fields});
  return {tick,identify,direct,work,posts,sends,stops,state,addReply,jerry,t3,lose:()=>{drop=true;},
    done:(status='completed')=>{runStatus=status;identify.activeRunId=null;identify.latestRunId=run;}};
}
test('T3 MCP retry reuses its delivery key, steers the same run and returns only its reply',async()=>{
  const s=wire();
  s.lose();await assert.rejects(s.tick(),/lost receipt/);
  await s.tick();
  assert.equal(s.sends.size,1);
  s.direct('Compare only the headings.');
  s.work.messages.push({id:'external',from:'worker',text:'Another worker instruction',revision:2});
  await s.tick();
  assert.deepEqual([...s.sends.values()],['Compare the two drafts.','Compare only the headings.']);
  s.addReply('The two headings agree.');
  s.addReply('Wrong conversation.',{sourceThreadId:'foreign',position:100});
  s.addReply('Other run.',{runId:'someone-else',position:101});
  s.addReply('Inherited history.',{visibility:'inherited',position:102});
  s.done();await s.tick();await s.tick();
  assert.deepEqual(s.posts.map(p=>[p.kind,p.text]),[['result','The two headings agree.']]);
});

test('a Jerry handoff keeps the approved context stable across a lost send receipt',async()=>{
  const s=wire();
  s.work.toolRequest={targets:[]};
  s.work.residentContext='A private owner-approved resident profile.';
  s.lose();await assert.rejects(s.tick(),/lost receipt/);
  s.work.residentContext='The owner revised the profile during the retry.';
  await s.tick();
  assert.equal(s.sends.size,1);
  const [sent]=s.sends.values();
  assert.match(sent,/A private owner-approved resident profile/);
  assert.doesNotMatch(sent,/revised the profile/);
  assert.equal(s.state.one.projectInstructions,undefined);
});

test('the first remote delegation supplies the project from that environment and keeps it on a lost receipt',async()=>{
  const s=wire(),attempts=[],lookups=[];
  s.work.toolRequest={targets:[{kind:'machine',name:'Mini',host:'mini',environmentId:'linked-mini'}]};
  const t3={async call(name,args){
    if (name==='t3_environment_links') return {links:[{environmentId:'linked-mini',status:'reachable',access:'approval-required'}]};
    if (name==='t3_project_list') {
      assert.equal(args.environmentId,'linked-mini');
      lookups.push(args.cursor??0);
      if (!args.cursor) return {projects:[{id:'unrelated',title:'No project',workspaceRoot:'/other/repository'}],nextCursor:12};
      return {projects:[{id:'archived',workspaceRoot:'/old/.t3/scratch',archivedAt:'yesterday'},
        {id:'mini-scratch',workspaceRoot:'/Users/owner/.t3/scratch'}],nextCursor:null};
    }
    if (name==='t3_thread_send') attempts.push(args.message);
    return s.t3.call(name,args);
  }};
  s.lose();
  await assert.rejects(s.tick({t3,machine:'book'}),/lost receipt/);
  await s.tick({t3,machine:'book'});
  assert.deepEqual(lookups,[0,12]);
  assert.equal(attempts.length,2);
  assert.equal(attempts[0],attempts[1]);
  assert.match(attempts[0],/"environmentId":"linked-mini","projectId":"mini-scratch"/);
  assert.doesNotMatch(attempts[0],/unrelated|archived/);
  // An older bridge persisted the send key without any project instructions.
  const older=wire();
  older.work.toolRequest=s.work.toolRequest;
  older.state.one={sent:0,run:null,sending:[...s.sends.keys()][0],mode:'queue'};
  await older.tick({machine:'book'});
  assert.match([...older.sends.values()][0],/linked-mini/);
  assert.doesNotMatch([...older.sends.values()][0],/target\.projectId/);
});
test('the first remote harness request includes its registered provider and model, including on a delivery retry',async()=>{
  const s=wire(),attempts=[],lookups=[];
  s.work.toolRequest={targets:[
    {kind:'machine',name:'Mini',host:'mini',environmentId:'linked-mini'},
    {kind:'harness',name:'Claude',provider:'claudeAgent',model:'configured-model'}
  ]};
  const t3={async call(name,args){
    if (name==='t3_environment_links') return {links:[{environmentId:'linked-mini',status:'reachable'}]};
    if (name==='t3_project_list') return {projects:[{id:'mini-scratch',workspaceRoot:'/Users/owner/.t3/scratch'}]};
    if (name==='orchestrator_capabilities') {
      lookups.push(args.environmentId);
      return {providers:[{driverKind:'claude-driver',providerInstanceId:'claudeAgent',canRunChildTask:true,models:[{id:'configured-model'}]}]};
    }
    if (name==='t3_thread_send') attempts.push(args.message);
    return s.t3.call(name,args);
  }};
  s.lose();
  await assert.rejects(s.tick({t3,machine:'book'}),/lost receipt/);
  await s.tick({t3,machine:'book'});
  const registered={environmentId:'linked-mini',projectId:'mini-scratch',driverKind:'claude-driver',providerInstanceId:'claudeAgent',model:'configured-model'};
  assert.ok(attempts[0].includes(JSON.stringify(registered)));
  assert.equal(attempts[0],attempts[1]);
  assert.deepEqual(lookups,['linked-mini']);
});

test('an unavailable remote model is never supplied as a registered delegation target',async()=>{
  const s=wire();
  s.work.toolRequest={targets:[
    {kind:'machine',name:'Mini',host:'mini',environmentId:'linked-mini'},
    {kind:'harness',name:'Claude',provider:'claudeAgent',model:'absent-model'}
  ]};
  const t3={async call(name,args){
    if (name==='t3_environment_links') return {links:[{environmentId:'linked-mini',status:'reachable'}]};
    if (name==='t3_project_list') return {projects:[]};
    if (name==='orchestrator_capabilities') return {providers:[
      {driverKind:'claude',providerInstanceId:'claudeAgent',canRunChildTask:true,models:[{id:'other-private-model'}]}
    ]};
    return s.t3.call(name,args);
  }};
  await s.tick({t3,machine:'book'});
  const [message]=s.sends.values();
  assert.match(message,/Look up the project on Mini/);
  assert.match(message,/could not confirm Claude.*absent-model.*Mini/);
  assert.doesNotMatch(message,/"model":"absent-model"|other-private-model/);
});

test('T3 sends require the configured planning thread and a current Jerry writer',async()=>{
  const s=wire();s.work.dispatchable=false;await s.tick();assert.equal(s.sends.size,0);
  s.work.dispatchable=true;s.identify.runtimeMode='full-access';
  await assert.rejects(s.tick(),/approval-required/);assert.equal(s.sends.size,0);
  s.identify.runtimeMode='approval-required';s.identify.activeRunId='unrelated';
  await s.tick();assert.equal(s.sends.size,0);
  s.identify.activeRunId=null;await s.tick();s.work.status='stopped';await s.tick();
  assert.deepEqual(s.stops,['run-1']);assert.equal(s.sends.size,1);
});
test('a clarifying question in a completed T3 turn stays open for an answer in the same conversation',async()=>{
  const s=wire();
  await s.tick();
  s.addReply('Which day should I compare?');s.done();await s.tick();
  assert.deepEqual(s.posts.map(p=>p.kind),['question']);
  s.direct('Saturday.');await s.tick();
  assert.deepEqual([...s.sends.values()],['Compare the two drafts.','Saturday.']);
});

test('a directory question returns actual observations once even with an active unrelated run and a lost response',async()=>{
  const s=wire();s.work.toolRequest={targets:[],inventory:true};s.identify.activeRunId='another-person';
  let probes=0,drop=true;
  const host=host=>({host,architecture:'arm64',harnesses:[],apps:['Fixture'],mcp:[]});
  const options={inspectLocal:async()=>{probes++;return host('MacBook');},
    jerry:{async call(name,args){
      if(name==='jerry_tools_list')return host('Mini');
      if(name==='jerry_thread_post' && drop){drop=false;throw new Error('lost response');}
      return s.jerry.call(name,args);
    }},t3:{async call(name,args){
      if(name==='orchestrator_capabilities')return {providers:[]};
      if(name==='t3_environment_links')return {links:[]};
      return s.t3.call(name,args);
    }}};
  await assert.rejects(s.tick(options),/lost response/);
  await s.tick(options);await s.tick(options);
  assert.equal(probes,1);assert.equal(s.sends.size,0);
  assert.deepEqual(s.posts.map(p=>p.kind),['result']);assert.match(s.posts[0].text,/MacBook/);assert.match(s.posts[0].text,/Mini/);
});

test('the requested harness runs on its assigned Mac, the matching reply returns and the previous provider is restored',async()=>{
  const s=wire(),before={instanceId:'codex',model:'previous'},configs=[];
  s.work.toolRequest={targets:[{name:'MacBook',kind:'machine',host:'book'},{name:'Claude',kind:'harness',provider:'claudeAgent',model:'model'}]};
  let selection=before;
  const options={machine:'book.local',t3:{async call(name,args){
    if(name==='orchestrator_capabilities')return {providers:[{providerInstanceId:'claudeAgent',models:[{id:'model'}],canRunChildTask:true}]};
    if(name==='t3_thread_configure') {
      if(args.modelSelection){selection=args.modelSelection;configs.push(selection);}
      return {modelSelection:selection,runtimeMode:'approval-required'};
    }
    return s.t3.call(name,args);
  }}};
  await s.tick(options);
  assert.deepEqual(configs,[{instanceId:'claudeAgent',model:'model'}]);
  assert.match([...s.sends.values()][0],/local hostname book/);
  assert.match([...s.sends.values()][0],/bridge verified this computer directly with the operating system: book.local/);
  s.addReply('I found the calibration entry.');s.done();await s.tick(options);await s.tick(options);
  assert.deepEqual(configs.at(-1),before);assert.equal(s.posts[0].kind,'result');assert.equal(s.state.one.selection,undefined);
});

test('a provider usage limit is delivered to Talk as a failure with the provider’s own explanation',async()=>{
  const s=wire();s.work.toolRequest={targets:[]};
  await s.tick();s.addReply('You have hit your 5-hour limit.',{status:'completed'});s.done('failed');await s.tick();
  assert.deepEqual(s.posts.map(p=>[p.kind,p.text]),[['error','You have hit your 5-hour limit.']]);
});

test('a disconnected writer cannot block the other Mac and each retains its private receipt state',async()=>{
  const connections=['mini','book'].map(endpoint=>({endpoint,state:{count:0}}));
  let online=false;
  const connect=async name=>{if(name==='mini' && !online)throw new Error('offline');return {name,async close(){}};};
  const exchange=async(client,state)=>{state.count++;state.host=client.name;};
  assert.equal((await syncWorkConnections(connections,{connect,exchange})).length,1);
  assert.deepEqual(connections.map(c=>c.state.count),[0,1]);
  online=true;assert.deepEqual(await syncWorkConnections(connections,{connect,exchange}),[]);
  assert.deepEqual(connections.map(c=>c.state),[{count:1,host:'mini'},{count:2,host:'book'}]);
});

test('a remote worker loses its admitted run after the writer stops renewing, even when Jerry cannot be reached',async()=>{
  const s=wire();s.work.toolRequest={targets:[]};s.work.writerValidForMs=1000;
  await s.tick();
  assert.ok(s.state.one.validUntil);
  const stop=now=>stopExpiredRuns(s.t3,'fixed-thread',s.state,()=>{},now);
  await stop(s.state.one.validUntil-1);assert.deepEqual(s.stops,[]);
  await stop(s.state.one.validUntil);await stop(s.state.one.validUntil+100);
  assert.deepEqual(s.stops,['run-1']);
  assert.equal(s.state.one.run,null);assert.equal(s.state.one.leaseEnded,'run-1');
  await s.tick();assert.equal(s.posts.at(-1).kind,'error');
  assert.equal(s.sends.size,1);
});

test('a long-lived T3 thread delivers the new reply across pages when the installed MCP defaults to the oldest messages',async()=>{
  const s=wire();s.identify.itemCount=100;
  const real=s.t3.call.bind(s.t3);
  const options={t3:{async call(name,args){
    const page=await real(name,args);
    if(name!=='t3_thread_read')return page;
    if(args.beforePosition!==undefined)return {...page,items:[]};
    const rows=page.items.filter(m=>m.position>(args.afterPosition??-1));
    const items=rows.slice(0,1);
    return {...page,items,hasMore:rows.length>1,nextPosition:items.at(-1)?.position};
  }}};
  await s.tick(options);
  assert.equal(s.state.one.startPosition,99);
  s.addReply('From another run.',{position:100,runId:'unrelated'});
  s.addReply('Checking the receipt.',{position:101,status:'completed'});
  s.addReply('The tool returned the new receipt.',{position:103,status:'completed'});
  s.done();await s.tick(options);
  assert.deepEqual(s.posts.map(m=>m.text),['Checking the receipt.','The tool returned the new receipt.']);
});

test('opening an idle Jerry thread uses the enrolled Mini and survives a lost launch receipt', async () => {
  const s=wire();
  s.work.messages[0].text='Jerry, open a T3 thread on the Mini.';
  s.work.toolRequest={targets:[{kind:'machine',name:'Mac mini',environmentId:'mini-env'}]};
  const original=s.t3.call.bind(s.t3);
  const launches=[];
  s.t3.call=async (name,args)=>{
    if (args.threadId==='fixed-thread') return original(name,args);
    if (name==='t3_environment_links') return {links:[{environmentId:'mini-env',status:'reachable'}]};
    assert.equal(args.environmentId,'mini-env');
    if (name==='orchestrator_capabilities') return {providers:[{providerInstanceId:'home23-jerry',models:[{id:'default'}]}]};
    if (name==='t3_thread_launch') {
      launches.push(args);
      if (launches.length===1) throw Error('lost response');
      return {threadId:'new'};
    }
    assert.equal(name,'t3_thread_read');
    return {thread:{threadId:'new',model:'default',providerInstanceId:'home23-jerry',link:'[Jerry](t3-thread://v2/mini-env/new)'}};
  };
  await assert.rejects(s.tick(),/lost response/);
  await s.tick();
  assert.deepEqual(launches[0],launches[1]);
  assert.deepEqual(launches[0].modelSelection,{instanceId:'home23-jerry',model:'default'});
  assert.equal(launches[0].scratch,true);
  assert.equal(launches[0].message,undefined);
  assert.match(s.posts[0].text,/t3-thread:\/\/v2\/mini-env\/new/);
});

test('the primary opens a local thread with the configured mode and no remote environment lookup',async()=>{
  const s=wire();
  s.work.messages[0].text='Jerry, open a T3 thread.';
  const machine={name:'Mini',environmentId:'here'};
  const options={primaryThreadMachine:machine,localEnvironmentId:'here',newThreadRuntimeMode:'full-access',
    t3:{async call(name,args){
      if(args.threadId==='fixed-thread')return s.t3.call(name,args);
      assert.equal(args.environmentId,undefined);
      if(name==='orchestrator_capabilities')return {providers:[{providerInstanceId:'home23-jerry',models:[{id:'default'}]}]};
      if(name==='t3_thread_launch'){assert.equal(args.runtimeMode,'full-access');return {threadId:'new'};}
      assert.equal(name,'t3_thread_read');
      return {thread:{threadId:'new',model:'default',runtimeMode:'full-access',providerInstanceId:'home23-jerry',link:'https://app.t3.codes/threads/here/new'}};
    }}};
  await s.tick(options);
  assert.equal(s.posts[0].kind,'result');
});
