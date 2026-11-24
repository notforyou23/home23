// A named Jerry work connection on the machine that owns the T3 grant. The
// credential and the fixed T3 thread never enter a model's context or workspace.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import http from 'node:http';
import {hostname} from 'node:os';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {receiptQuestion} from './work-thread.mjs';
import {requestedProvider,toolInstructions} from './tool-access.mjs';
import {directoryReport,remoteAccess,remoteProjectInstructions,reportApprovals,restoreProvider,selectProvider} from './t3-tool-access.mjs';

function privateFile(file) {
  if (!path.isAbsolute(file)) throw new Error('Use an absolute private file path.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const st=fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077)) throw new Error('Expected a private file.');
    return fs.readFileSync(fd,'utf8').trim();
  } finally { fs.closeSync(fd); }
}

function savePrivate(file, value) {
  const dir=path.dirname(file);
  if (!path.isAbsolute(file) || !fs.lstatSync(dir).isDirectory() || (fs.statSync(dir).mode & 0o077)) throw new Error('Use a private directory for work connection state.');
  const tmp=file+'.tmp-'+randomUUID();
  fs.writeFileSync(tmp,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});
  fs.renameSync(tmp,file);
  const fd=fs.openSync(dir,'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// T3 issues MCP credentials through its OAuth service. Authorization uses a loopback
// callback, PKCE and a separate revocable client. The bridge never uses a desktop login.
function oauthStore(config, interactive=false) {
  const file=config.authFile;
  const record=fs.existsSync(file) ? JSON.parse(privateFile(file)) : {};
  if (record.server && record.server!==config.url) throw new Error('This authorization belongs to another MCP server.');
  if (!interactive && !record.tokens) throw new Error('Authorize the T3 MCP connection first.');
  const redirectUrl=new URL(config.redirectURL ?? 'http://127.0.0.1:46783/oauth/callback');
  if (redirectUrl.protocol!=='http:' || redirectUrl.hostname!=='127.0.0.1' || !redirectUrl.port || redirectUrl.username ||
      redirectUrl.password || redirectUrl.search || redirectUrl.hash) throw new Error('Use a loopback OAuth callback.');
  const persist=()=>savePrivate(file,{...record,server:config.url});
  let verifier, nonce, onRedirect;
  const provider={
    redirectUrl,
    clientMetadata:{client_name:'Home23 Jerry work',redirect_uris:[redirectUrl.href],grant_types:['authorization_code'],
      response_types:['code'],token_endpoint_auth_method:'none',scope:'orchestration:read orchestration:operate'},
    state:()=>nonce=randomBytes(32).toString('base64url'),clientInformation:()=>record.client,
    saveClientInformation:client=>{record.client=client;persist();},tokens:()=>record.tokens,
    saveTokens:tokens=>{record.tokens=tokens;persist();},saveCodeVerifier:value=>{verifier=value;},codeVerifier:()=>verifier,
    redirectToAuthorization:url=>{
      if (!interactive || !onRedirect) throw new Error('Authorize the T3 MCP connection to continue.');
      if (new URL(url).origin!==new URL(config.url).origin) throw new Error('Unexpected T3 authorization origin.');
      onRedirect(url);
    },
    invalidateCredentials:scope=>{
      if (scope==='all' || scope==='client') delete record.client;
      if (scope==='all' || scope==='tokens') delete record.tokens;
      if (scope==='all' || scope==='verifier') verifier=undefined;
      persist();
    }
  };
  return {provider,redirectUrl,validState:value=>typeof nonce==='string' && value===nonce,redirect:cb=>{onRedirect=cb;}};
}

export async function authorizeT3(config,show=url=>console.log('Approve Jerry’s T3 connection on this Mac:\n'+url)) {
  const require=createRequire(import.meta.url);
  const {auth}=require('@modelcontextprotocol/sdk/client/auth.js');
  const store=oauthStore(config,true);
  let resolveCode;
  const received=new Promise(resolve=>{resolveCode=resolve;});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,store.redirectUrl);
    if (req.method!=='GET' || req.headers.host!==store.redirectUrl.host || url.pathname!==store.redirectUrl.pathname || !store.validState(url.searchParams.get('state'))) {
      res.writeHead(400); return res.end('Invalid authorization response.');
    }
    const code=url.searchParams.get('code');
    res.writeHead(code?200:403,{'content-type':'text/plain','cache-control':'no-store'});
    res.end(code?'You can return to Home23.':'Authorization was declined.');
    resolveCode(code);
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(Number(store.redirectUrl.port),'127.0.0.1',resolve));
  let timer;
  try {
    store.redirect(show);
    const opts={serverUrl:new URL(config.url),scope:store.provider.clientMetadata.scope};
    const result=await auth(store.provider,opts);
    if (result==='REDIRECT') {
      const code=await Promise.race([received,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10*60_000);})]);
      if (!code) throw new Error('T3 authorization was declined or timed out.');
      if (await auth(store.provider,{...opts,authorizationCode:code})!=='AUTHORIZED') throw new Error('T3 authorization did not complete.');
    }
  } finally {clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

export async function connectWorkMcp(config,{signal}={}) {
  const url=new URL(config.url);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname))) ||
      url.username || url.password || url.hash || url.search) throw new Error('Use HTTPS or a loopback MCP endpoint.');
  const require=createRequire(import.meta.url);
  const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const options={requestInit:{redirect:'error'}};
  const requestOptions=signal ? {signal} : undefined;
  if (signal) {
    // The SDK supplies its own transport signal on each fetch, including initialization.
    options.fetch=(input,init={})=>fetch(input,{
      ...init,signal:init.signal ? AbortSignal.any([init.signal,signal]) : signal,
    });
  }
  if (config.authFile) options.authProvider=oauthStore(config).provider;
  else options.requestInit.headers={authorization:'Bearer '+privateFile(config.tokenFile)};
  const transport=new StreamableHTTPClientTransport(url,options);
  const client=new Client({name:'home23-jerry-work-peer',version:'1.0'});
  try { await client.connect(transport,requestOptions); }
  catch(e) { await client.close().catch(()=>{}); throw e; }
  return {
    async call(name,args={}) {
      const envelope=await client.callTool({name,arguments:args},undefined,requestOptions);
      if (envelope.isError) throw Object.assign(new Error('The MCP tool '+name+' declined this call.'), {tool:name});
      if (envelope.structuredContent) return envelope.structuredContent;
      return JSON.parse(envelope.content.find(c=>c.type==='text').text);
    },
    tools:()=>client.listTools(),
    close:()=>client.close(),
  };
}

const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const open = row => ['queued','running','waiting'].includes(row.status);
const terminal = status => ['completed','failed','cancelled','interrupted','rolled_back'].includes(status);
function verifyPeer(page, target) {
  const t=page.thread;
  if (!t || t.threadId!==target || t.archived || t.parentThreadId ||
      t.runtimeMode!=='approval-required')
    throw new Error('The linked T3 conversation must be an active, approval-required thread.');
}

function rememberLease(local,work,started,save) {
  if (!Number.isFinite(work.writerValidForMs)) return;
  const until=started+Math.max(0,work.writerValidForMs);
  if (Math.abs(until-(local.validUntil??0))>100) {local.validUntil=until;save();}
}

export async function stopExpiredRuns(t3,target,state,save,now=Date.now()) {
  for (const [id,local] of Object.entries(state)) {
    const run=local.run;
    if (!run || !local.validUntil || now<local.validUntil) continue;
    const page=await t3.call('t3_thread_read',{threadId:target,beforePosition:Number.MAX_SAFE_INTEGER,limit:1,runLimit:50,maxCharsPerItem:1});
    verifyPeer(page,target);
    const owned=page.recentRuns.find(r=>r.runId===run);
    if (!owned || !terminal(owned.status))
      await t3.call('t3_thread_interrupt',{threadId:target,runId:run,stop:true,clientRequestId:key(target,id,run,'writer-expired')});
    if (local.run===run) {local.leaseEnded=run;local.run=null;save();}
  }
}

// Match a direct, idle-thread request only. Requests containing project or task
// instructions continue through the existing work dispatcher with their full text.
function threadDestination(work, primaryThreadMachine) {
  const owner = work.messages.filter(message => message.from === 'owner');
  if (owner.length !== 1 || owner[0].kind !== 'request') return null;
  const match = owner[0].text.trim().match(/^(?:(?:hey|ok|okay)[, ]+)?(?:jerry[, ]+)?(?:please +)?(?:(?:can|could|would|will) you +)?(?:please +)?(?:open|start|create|launch) +(?:me +)?(?:a |an |one )?(?:new |fresh )?t3(?: code)? +thread(?: +on +(?:(?:my|the) +)?([a-z0-9 -]+?))?(?: +please)?[.?!]*$/i);
  const machines = work.toolRequest?.targets.filter(t => t.kind === 'machine') ?? [];
  if (!match) return null;
  if (!match[1] && machines.length === 0) return primaryThreadMachine;
  if (!match[1] || machines.length !== 1 || !machines[0].environmentId) return null;
  // The Talk router resolved its configured machine alias. Match the complete
  // destination here too, so trailing instructions cannot be silently dropped.
  const name = match[1].trim().toLowerCase();
  const machine = machines[0];
  return [machine.name.toLowerCase(), machine.name.toLowerCase().replace(/^mac /,'')]
    .includes(name) ? machine : null;
}

async function openJerryThread(t3, machine, requestId, localEnvironmentId, runtimeMode) {
  const local = machine.environmentId === localEnvironmentId;
  const scope = local ? {} : {environmentId:machine.environmentId};
  if (!local) {
    const {links} = await t3.call('t3_environment_links',{});
    if (!links.some(link => link.environmentId === machine.environmentId && link.status === 'reachable'))
      return {kind:'error',text:machine.name+' is unavailable in T3.'};
  }
  const {providers} = await t3.call('orchestrator_capabilities',{...scope,search:'Jerry'});
  const instanceId = 'home23-jerry';
  const model = 'default';
  if (!providers.some(p => p.providerInstanceId === instanceId && p.models?.some(m => m.id === model)))
    return {kind:'error',text:'T3 on '+machine.name+' does not list the Home23 / Jerry provider and model.'};
  const receipt = await t3.call('t3_thread_launch',{...scope,scratch:true,title:'Jerry · Home23',
    modelSelection:{instanceId,model},...(runtimeMode ? {runtimeMode} : {}),clientRequestId:requestId});
  const {thread} = await t3.call('t3_thread_read',{...scope,threadId:receipt.threadId,limit:1,maxCharsPerItem:1});
  // Outside-agent MCP clients receive an HTTPS link. In-app callers can
  // receive a Markdown link to the same environment and thread.
  const uri = thread.link?.match(/\]\(([^)]+)\)$/)?.[1] ?? thread.link;
  const address = machine.environmentId+'/'+receipt.threadId;
  const validLink = typeof uri === 'string' && [
    'https://app.t3.codes/threads/'+address, 't3-thread://v2/'+address
  ].includes(decodeURIComponent(uri));
  if (thread.threadId !== receipt.threadId || thread.providerInstanceId !== instanceId ||
      thread.model !== model || (runtimeMode && thread.runtimeMode !== runtimeMode) || !validLink)
    return {kind:'error',text:'T3 accepted the request, but I could not verify the new Jerry thread on '+machine.name+'.'};
  return {kind:'result',text:'I opened a Jerry thread on '+machine.name+'. '+thread.link};
}

export async function syncT3Work({jerry,t3,target,state,save,machine=hostname(),inspectLocal,inspectOtherMachines,primaryThreadMachine,localEnvironmentId,newThreadRuntimeMode,environmentByHost}) {
  const rows=await jerry.call('jerry_work_list');
  for (const summary of rows) {
    const id=summary.threadId;
    let local=state[id];
    if (!open(summary) && !local?.run && !local?.selection && !local?.sending) continue;
    const started=Date.now();
    const work=await jerry.call('jerry_thread_read',{threadId:id});
    // Home enrollment predates moving the connector. A formerly local machine
    // may have only its hostname on older queued work.
    for (const target of work.toolRequest?.targets ?? []) {
      if (target.kind === 'machine' && !target.environmentId && environmentByHost?.[target.host])
        target.environmentId = environmentByHost[target.host];
    }
    if (!open(work)) {
      if (local?.run && ['stopped','lease_lost','interrupted','failed'].includes(work.status)) {
        await t3.call('t3_thread_interrupt',{threadId:target,runId:local.run,clientRequestId:key(id,local.run,'stop'),stop:true});
      }
      if (local?.run || local?.sending) {local.run=null;local.sending=null;local.mode=null;delete local.projectInstructions;save();}
      if (local?.selection) await restoreProvider(t3,target,local,save);
      continue;
    }
    if (!work.dispatchable) continue;
    let page=await t3.call('t3_thread_read',{threadId:target,beforePosition:Number.MAX_SAFE_INTEGER,limit:1,runLimit:1,maxCharsPerItem:1});
    verifyPeer(page,target);
    if (!local) {local=state[id]={sent:0,run:null};save();}
    if (local.leaseEnded && work.revision>local.sent) {
      delete local.leaseEnded;
      delete local.validUntil;
      save();
    }
    if (local.leaseEnded) {
      await jerry.call('jerry_thread_post',{threadId:id,revision:work.revision,kind:'error',
        messageId:key(target,id,local.leaseEnded,'lease-ended'),text:'The writer connection expired during this task. Some steps may have finished. I stopped following that run.'});
      continue;
    }
    rememberLease(local,work,started,save);
    const destination = threadDestination(work,primaryThreadMachine);
    if (destination) {
      const requestId = key(id,work.messages.find(m=>m.from==='owner').id,'open-jerry-thread');
      if (!local.openThread) {
        const fresh = await jerry.call('jerry_thread_read',{threadId:id});
        if (!open(fresh) || !fresh.dispatchable || fresh.revision !== work.revision) continue;
        try {
          local.openThread = await openJerryThread(t3,destination,requestId,localEnvironmentId,newThreadRuntimeMode);
        } catch (error) {
          if (!error.tool) throw error;
          local.openThread = {kind:'error',text:'T3 declined '+error.tool+' for '+destination.name+
            '. I could not confirm that a new thread opened.'};
        }
        save();
      }
      await jerry.call('jerry_thread_post',{threadId:id,revision:work.revision,
        messageId:requestId,...local.openThread});
      continue;
    }
    if (work.toolRequest?.inventory && work.messages.filter(m=>m.from==='owner').length===1) {
      if (!local.directory || local.directory.revision!==work.revision) {
        local.directory={revision:work.revision,text:await directoryReport({t3,jerry,request:work.toolRequest,inspectLocal,inspectOtherMachines,machine})};
        save();
      }
      const fresh=await jerry.call('jerry_thread_read',{threadId:id});
      if (open(fresh) && fresh.dispatchable && fresh.revision===work.revision)
        await jerry.call('jerry_thread_post',{threadId:id,revision:work.revision,kind:'result',
          messageId:key(target,id,work.revision,'directory'),text:local.directory.text});
      continue;
    }
    // A person can use this thread in T3 between assignments. Do not steer their run.
    if (page.thread.activeRunId && page.thread.activeRunId!==local?.run && !local?.sending) continue;
    if (Object.entries(state).some(([otherId,other])=>otherId!==id && (other.sending || other.selection))) continue;
    const authorizedMessage=m=>m.from==='owner' || (m.from==='jerry' && m.kind==='receipt' && m.text===receiptQuestion);
    for (const msg of work.messages.filter(m=>authorizedMessage(m) && m.revision>local.sent)) {
      const requestId=key(target,id,msg.id);
      const provider=requestedProvider(work.toolRequest,machine);
      const remoteProblem=local.sending ? null : await remoteAccess(t3,work.toolRequest,machine);
      const problem=remoteProblem ?? await selectProvider(t3,target,local,provider,save);
      if (problem) {
        await jerry.call('jerry_thread_post',{threadId:id,revision:work.revision,kind:'error',
          messageId:key(target,id,work.revision,'tool-unavailable'),text:problem});
        break;
      }
      const includeTools=msg.kind==='request' || msg.kind==='direction';
      // Save project and resident instructions with the request key. A retry must send the
      // same message, even after the owner revises the biography or changes projects.
      if (!local.sending && includeTools) {
        const projects=await remoteProjectInstructions(t3,work.toolRequest,machine);
        const context=[projects,work.residentContext].filter(Boolean).join('\n\n');
        if (context) local.projectInstructions=context;
      }
      if (!local.sending && Number.isSafeInteger(page.thread.itemCount)) local.sendPosition=page.thread.itemCount-1;
      local.sending=requestId;
      local.mode ??= local.run && page.thread.activeRunId===local.run ? 'auto' : 'queue';
      save();
      const checking=Date.now();
      const fresh=await jerry.call('jerry_thread_read',{threadId:id});
      if (!open(fresh) || !fresh.dispatchable) return;
      rememberLease(local,fresh,checking,save);
      if (local.validUntil && Date.now()>=local.validUntil) return;
      const instruction=includeTools ? [toolInstructions(work.toolRequest,machine),local.projectInstructions].filter(Boolean).join('\n') : '';
      const message=instruction ? instruction+'\n\nOwner’s message:\n'+msg.text : msg.text;
      const receipt=await t3.call('t3_thread_send',{threadId:target,mode:local.mode,message,clientRequestId:requestId});
      if (receipt.threadId!==target || !receipt.runId) throw new Error('T3 did not confirm the addressed thread and run.');
      if (local.selection) local.selection.runId=receipt.runId;
      if (local.run!==receipt.runId) {
        delete local.progressThrough;
        local.startPosition=local.sendPosition;
      }
      delete local.sendPosition;
      delete local.projectInstructions;
      local.sent=msg.revision; local.run=receipt.runId; local.sending=null; local.mode=null; save();
    }
    if (!local.run) continue;
    // Only assistant messages from the run admitted for this owner direction can return to Talk.
    const read={threadId:target,limit:50,runLimit:50,maxCharsPerItem:20000};
    const floor=local.progressThrough ?? local.startPosition;
    page=await t3.call('t3_thread_read',{...read,...(Number.isSafeInteger(floor) ? {afterPosition:floor} : {beforePosition:Number.MAX_SAFE_INTEGER})});
    verifyPeer(page,target);
    const run=page.recentRuns.find(r=>r.runId===local.run);
    if (!run) continue;
    if (await reportApprovals({t3,jerry,threadId:target,id,runId:local.run,revision:local.sent,thread:page.thread,key,local,save})) continue;
    const items=[...page.items];
    let cursor=floor;
    while (Number.isSafeInteger(cursor) && page.hasMore && Number.isSafeInteger(page.nextPosition) && page.nextPosition>cursor) {
      cursor=page.nextPosition;
      page=await t3.call('t3_thread_read',{...read,afterPosition:cursor});
      verifyPeer(page,target);
      items.push(...page.items);
    }
    const replies=items.filter(m=>m.runId===local.run && m.sourceThreadId===target && m.visibility==='local' &&
      m.type==='assistant_message' && m.createdBy==='agent' && m.text).sort((a,b)=>a.position-b.position);
    const latest=replies.at(-1);
    for (const message of replies.slice(0,-1)) {
      if (message.position<=(local.progressThrough ?? -1) || message.textTruncated || message.status!=='completed') continue;
      await jerry.call('jerry_thread_post',{threadId:id,revision:local.sent,messageId:key(target,id,local.run,message.itemId,'progress'),
        kind:'progress',text:message.text});
      local.progressThrough=message.position;
      save();
    }
    if (!terminal(run.status) && !(run.status==='waiting' && latest)) continue;
    let body=latest?.text ?? '';
    if (latest && (run.status==='completed' || run.status==='waiting')) {
      let offset=latest.nextTextOffset;
      while (offset!=null) {
        const more=await t3.call('t3_thread_read',{threadId:target,itemId:latest.itemId,textOffset:offset,maxCharsPerItem:20000});
        const part=more.items.find(m=>m.itemId===latest.itemId && m.runId===local.run);
        if (!part?.text || (part.nextTextOffset!=null && part.nextTextOffset<=offset)) throw new Error('Incomplete T3 reply.');
        body+=part.text;
        offset=part.nextTextOffset;
      }
    } else {
      const providerNotice=work.toolRequest && latest?.status==='completed' && !latest.textTruncated && latest.text.length<=750 &&
        /(?:limit|quota|sign.?in|log.?in|permission|unavailable|unsupported|authentication|access denied)/i.test(latest.text);
      body=providerNotice ? latest.text : 'T3 ended this request with status '+run.status+'.';
    }
    const failed=terminal(run.status) && (run.status!=='completed' || !latest?.text?.trim());
    if (!body.trim()) body='T3 finished without a text reply.';
    const question=run.status==='waiting' || (run.status==='completed' && body.length<=600 && body.trimEnd().endsWith('?'));
    const messageKey=key(target,id,local.run,latest?.itemId,run.status,local.sent);
    if (local.delivered===messageKey) continue;
    const chunks=body.match(/[\s\S]{1,10000}/gu) ?? [];
    for (const [index,text] of chunks.entries()) {
      await jerry.call('jerry_thread_post',{threadId:id,revision:local.sent,messageId:messageKey+'.'+index,
        kind:index<chunks.length-1 ? 'progress' : failed && work.toolRequest ? 'error' : question ? 'question' : 'result',text});
    }
    local.delivered=messageKey;
    if (terminal(run.status)) local.run=null;
    save();
    if (!local.run && local.selection) await restoreProvider(t3,target,local,save);
  }
}

// Each writer has a separate execution journal. A disconnected machine cannot
// prevent a reachable writer from delivering its own admitted work.
export async function syncWorkConnections(connections,{connect,exchange}) {
  const errors=[];
  for (const connection of connections) {
    try {
      connection.client ??= await connect(connection.endpoint);
      await exchange(connection.client,connection.state);
    } catch (error) {
      await connection.client?.close().catch(()=>{});
      connection.client=null;
      errors.push(error);
    }
  }
  return errors;
}

async function main(file,once) {
  const config=JSON.parse(privateFile(file));
  if (process.argv.includes('--authorize')) return authorizeT3(config.t3);
  if (!config.t3.threadId || !path.isAbsolute(config.stateFile)) throw new Error('A fixed T3 thread and private state file are required.');
  const endpoints=[config.jerry,...(config.jerryAlternates ?? [])];
  if (new Set(endpoints.map(e=>new URL(e.url).href)).size!==endpoints.length) throw new Error('Each Jerry service needs a distinct endpoint.');
  const dir=path.dirname(config.stateFile);
  fs.mkdirSync(dir,{mode:0o700,recursive:true});
  if ((fs.lstatSync(dir).mode & 0o077) || !fs.lstatSync(dir).isDirectory()) throw new Error('Use a private state directory.');
  if (process.argv.includes('--check')) {
    const t3=await connectWorkMcp(config.t3);
    try {
      const page=await t3.call('t3_thread_read',{threadId:config.t3.threadId,limit:1,maxCharsPerItem:1});
      verifyPeer(page,config.t3.threadId);
      for (const endpoint of endpoints) {
        const jerry=await connectWorkMcp(endpoint);
        try {
          if (!Array.isArray(await jerry.call('jerry_work_list'))) throw new Error('The Jerry endpoint did not confirm work access.');
        } finally {await jerry.close();}
      }
      console.log(JSON.stringify({jerryConnected:true,jerryEndpoints:endpoints.length,t3Connected:true,thread:page.thread.link}));
    } finally {await t3.close();}
    return;
  }
  // An advisory SQLite lock releases on process death, including SIGKILL.
  const {DatabaseSync}=await import('node:sqlite');
  const lock=new DatabaseSync(config.stateFile+'.lock');
  try { lock.exec('BEGIN EXCLUSIVE'); } catch { lock.close(); throw new Error('A bridge already owns this connection.'); }
  // Owner and marked connections may share the same dedicated T3 thread.
  // Serialize the provider selection and send across those processes.
  const grantDir=path.dirname(config.t3.authFile ?? config.t3.tokenFile);
  const dispatchLock=new DatabaseSync(path.join(grantDir,'jerry-thread-'+key(config.t3.url,config.t3.threadId)+'.sqlite'));
  const binding=key(config.jerry.url,config.t3.url,config.t3.threadId);
  const record=fs.existsSync(config.stateFile) ? JSON.parse(privateFile(config.stateFile)) : {binding,work:{}};
  if (record.binding!==binding) throw new Error('This state belongs to another work connection.');
  const save=()=>savePrivate(config.stateFile,record);
  const connections=endpoints.map((endpoint,index)=>{
    if (!index) return {endpoint,state:record.work};
    record.alternates ??= {};
    const address=key(endpoint.url,config.t3.url,config.t3.threadId);
    return {endpoint,state:record.alternates[address] ??= {}};
  });
  let t3;
  let guarding=false;
  const guard=async()=>{
    if (guarding || !t3) return;
    guarding=true;
    try {
      for (const c of connections) await stopExpiredRuns(t3,config.t3.threadId,c.state,save);
    } catch (error) {console.error('The T3 work stop is waiting:',error.name);}
    finally {guarding=false;}
  };
  const guardTimer=setInterval(guard,1000);
  guardTimer.unref();
  try {
    do {
      try {
        t3 ??= await connectWorkMcp(config.t3);
        await guard();
        const errors=await syncWorkConnections(connections,{connect:connectWorkMcp,exchange:async(jerry,state)=>{
          try {dispatchLock.exec('BEGIN IMMEDIATE');}
          catch(error){if (error.errcode===5) return;throw error;}
          const others=connections.filter(connection=>connection.state!==state);
          const inspectOtherMachines=others.length ? async()=>{
            const results=await Promise.allSettled(others.map(async ({endpoint})=>{
              const peer=await connectWorkMcp(endpoint,{signal:AbortSignal.timeout(16_000)});
              try {return await peer.call('jerry_tools_list');} finally {await peer.close();}
            }));
            return results.filter(result=>result.status==='fulfilled').map(result=>result.value);
          } : undefined;
          try {await syncT3Work({jerry,t3,target:config.t3.threadId,state,save,inspectOtherMachines,primaryThreadMachine:config.t3.primaryThreadMachine,
            localEnvironmentId:config.t3.localEnvironmentId,newThreadRuntimeMode:config.t3.newThreadRuntimeMode,environmentByHost:config.t3.environmentByHost});}
          finally {dispatchLock.exec('ROLLBACK');}
        }});
        if (errors.length) {
          if (once || errors.length===connections.length) throw errors[0];
          console.error('A Jerry work connection is waiting:',errors[0].name);
        }
      } catch (error) {
        if (once) throw error;
        console.error('Work peer is waiting for its configured MCP connections:',error.name);
        await t3?.close().catch(()=>{});
        t3=null;
      }
      if (!once) await delay(2000);
    } while (!once);
  } finally {clearInterval(guardTimer);await Promise.allSettled([t3?.close(),...connections.map(c=>c.client?.close())]);dispatchLock.close();lock.close();}
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
  main(process.argv[2],process.argv.includes('--once')).catch(error=>{console.error(error.message);process.exitCode=1;});
