// Each work item is one conversation. Only Talk can originate owner messages.
import { createHash, timingSafeEqual } from 'node:crypto';
import { requestedTools, toolWorkIntent } from './tool-access.mjs';

const hash = value => createHash('sha256').update(value).digest();
export const bearerMatches = (header, secret) => Boolean(secret) && timingSafeEqual(hash(header ?? ''), hash('Bearer ' + secret));
const clean = text => String(text ?? '').trim();
export const ownerRevision = item => item.messages?.filter(m => m.from === 'owner' || m.from === 'jerry').length ?? 0;
export const threadError = (message, status = 400) => Object.assign(new Error(message), {httpStatus:status});
export const receiptQuestion = 'What did you observe that confirms the result? Use evidence from the work already done. If you could not verify it, say so.';

export function missingReceipt(item, text) {
  const requested=item.messages?.some(m=>m.from==='owner' && /\b(?:confirm|verify|verification|show (?:me )?(?:the )?(?:evidence|receipt)|prove)\b/i.test(m.text));
  return requested && /^(?:yes[, .]*)?(?:done|finished|all (?:set|done)|confirmed|verified|it works|completed|success(?:ful)?)[.!\s]*$/i.test(text.trim());
}
export const receiptRequested = item => item.messages?.some(m=>m.from==='jerry' && m.kind==='receipt');
export const unconfirmedReply = 'The worker reported that the work finished. I didn’t receive the confirming observation you asked for.';

export function resolveWorkChoice(text, choice, items) {
  if (!choice || !['stop','steer','status'].includes(choice.kind) || !Array.isArray(choice.ids)) return null;
  const options=choice.ids.map(id=>items.find(item=>item.id===id)).filter(Boolean);
  const value=clean(text).toLowerCase().replace(/[.!?]$/,'');
  const ordinal=value.match(/^(?:the |number )?(first|second|third|last|\d+)(?: one)?$/);
  let match;
  if (ordinal) {
    const index={first:0,second:1,third:2,last:options.length-1}[ordinal[1]] ?? Number(ordinal[1])-1;
    match=options[index];
  } else {
    const words=value.replace(/[^\p{L}\p{N}_]+/gu,' ').split(/\s+/).filter(w=>w && !['the','one','about','please','work','task','job'].includes(w));
    if (!words.length) return null;
    const matches=options.filter(i=>words.every(w=>(i.id+' '+(i.peer??'')+' '+i.ask).toLowerCase().includes(w)));
    if (matches.length===1) match=matches[0];
  }
  return match ? {kind:choice.kind,text:choice.text,item:match,candidates:[match]} : null;
}

export function threadMessage(item, id, from, kind, value, revision) {
  const text = clean(value);
  if (typeof value !== 'string' || typeof id !== 'string' || !/^[\w.:-]{1,160}$/.test(id) || !text || text.length > 24000) throw threadError('Invalid message ID or text.');
  const messages = item.messages ?? [];
  const prior = messages.find(m => m.id === id && m.from === from);
  if (prior) {
    if (prior.text !== text || prior.kind !== kind) throw threadError('Message ID already used for different content.',409);
    return {message:prior, duplicate:true};
  }
  if (from === 'worker' && revision !== ownerRevision(item)) throw threadError('New owner directions are waiting. Read the thread before replying.',409);
  return {message:{id, from, kind, text, at:new Date().toISOString(), revision:from === 'worker' ? revision : ownerRevision(item)+1}};
}

export function workIntent(text, items, peerNames = [], latestQuestion, toolPeer) {
  const value = clean(text);
  const names = [...new Set([...peerNames,'Home','T3'].map(name=>name.toLowerCase()))];
  for (const name of names) {
    const prefix = new RegExp('^(?:(?:hey |ok(?:ay)?[, ]+)?jerry[, ]+)?(?:please )?(?:ask|have|tell|send to|hand (?:this|that) to) '+name+'(?:\\s+(?:to|about)|[:,])?\\s+(.+)$','is');
    const match = value.match(prefix);
    if (match) {
      const peer=peerNames.find(p=>p.toLowerCase()===name);
      if (toolPeer && (!peer || peer===toolPeer.name)) {
        const toolRequest=requestedTools(peer ? match[1] : value,toolPeer.destinations);
        if (toolRequest) return toolWorkIntent(peer ? match[1] : value,items,toolPeer.name,toolRequest);
      }
      if (!peer) return {kind:'unpaired',peer:name==='t3' ? 'T3' : 'Home'};
      const existing=items.filter(i=>i.peer===peer && !i.toolRequest && ['running','queued','waiting'].includes(i.status));
      if (existing.length) return {kind:'steer',text:match[1],candidates:existing,item:existing.length===1 ? existing[0] : null};
      const previous=items.findLast(i=>i.peer===peer && !i.toolRequest);
      if (previous && (/\btell\s/i.test(value) || /^(?:also|instead|follow up)\b/i.test(match[1])))
        return {kind:'steer',text:match[1],item:previous,candidates:[previous]};
      return {kind:'assign',peer,text:match[1]};
    }
  }
  const textFold = value.toLowerCase().replace(/[’]/g,"'");
  const named = items.filter(i => textFold.includes(i.id) || i.label && textFold.includes(i.label.toLowerCase()));
  const directive = value.match(/^(?:(?:please|jerry)[, ]+)?(?:tell (?:the |that |your )?(?:worker|helper)|steer(?: the (?:worker|task))?|follow up(?: on (?:that|the work))?|reply to (?:the |that )?(?:worker|question)|(?:for|on) (?:that|the) (?:job|task|work|request))\s*[:,]?\s+(.+)$/is);
  if (toolPeer && !directive && !named.length) {
    const request=requestedTools(value,toolPeer.destinations);
    if (request) return toolWorkIntent(value,items,toolPeer.name,request);
  }
  const open = items.filter(i => ['running','queued','waiting'].includes(i.status));
  const addressed = named.length ? named : open;
  let kind, body = value;
  if (/^(?:(?:hey |ok(?:ay)?,? |actually,? |jerry,? |please )\s*)*(?:stop|cancel|abort|never ?mind|forget it|hold off|don't bother|scratch that)(?:\s+(?:(?:that|the|this|my|your)\s+)?(?:one|job|task|work|thread|worker|request)|\s+(?:that|it)|[.!?\s]*$)/i.test(textFold) || named.length && /^(?:stop|cancel)\b/.test(textFold)) kind = 'stop';
  else if (/^(?:how(?:'s| is) (?:it|that|the (?:work|job|task)) going|any (?:news|update|progress)|is (?:it|that) (?:finished|done)|(?:work |task )?status|what(?:'s| is) (?:the status|running)|are you still (?:on it|working))\b/i.test(textFold)) kind = 'status';
  else {
    if (directive) { kind='steer'; body=directive[1]; }
    else if (open.length && /^(?:(?:actually|instead)[, ]+(?:please )?(?:use|check|include|focus|skip|compare|try|look|change|leave|make|start|only)\b|while you(?:'re| are) (?:there|at it)[, ]+|also (?:check|include|use|look at|compare|skip)|use .+ instead\b)/i.test(textFold) || named.length && /^(?:tell|ask|continue|use|also|for|on)\b/.test(textFold)) kind='steer';
    else if (latestQuestion && value.length < 240 && !value.endsWith('?') &&
        !/^(?:new (?:topic|task)|actually|separately|unrelated|by the way|hey\b|hi\b|good (?:morning|evening)|tell me|how |why |what |who |can you )/i.test(value)) {
      const item=open.find(i=>i.id===latestQuestion && i.awaiting);
      if (item) return {kind:'steer',text:value,item,candidates:[item]};
    }
  }
  if (!kind || !items.length) return null;
  const candidates = addressed.length ? addressed : items.slice(-1);
  return {kind, text:body, candidates, item:candidates.length === 1 ? candidates[0] : null};
}

export function publicThread(item) {
  return {threadId:item.id, subject:item.ask, status:item.status, revision:ownerRevision(item), messages:item.messages ?? [],
    ...(item.toolRequest ? {toolRequest:item.toolRequest} : {}), ...(item.ended ? {ended:item.ended} : {})};
}

const string = {type:'string'};
const object = (properties, required) => ({type:'object',properties,required,additionalProperties:false});
const tools = [
  {name:'jerry_work_list', description:'List the work Jerry addressed to this connection.', inputSchema:object({},[])},
  {name:'jerry_work_wait', description:'Wait for an assignment or change to work addressed to this connection. Omit the cursor for the first snapshot.',inputSchema:object({cursor:string},[])},
  {name:'jerry_thread_read', description:'Read this work conversation and its current owner revision. Read again between steps and before completing work.',inputSchema:object({threadId:string},['threadId'])},
  {name:'jerry_thread_wait', description:'Wait up to 15 seconds for new directions or cancellation in this thread. Returns immediately when a change is already available.',inputSchema:object({threadId:string,revision:{type:'integer',minimum:0}},['threadId','revision'])},
  {name:'jerry_thread_post', description:'Send Jerry a progress update, a question, or the final result in the originating Talk conversation. Reuse the same messageId on retry.',inputSchema:object({
    threadId:string, messageId:string, kind:{enum:['progress','question','result','error'], type:'string'}, text:{type:'string',maxLength:24000},
    revision:{type:'integer',minimum:0}},['threadId','messageId','kind','text','revision'])}
];
const inventoryTool={name:'jerry_tools_list',description:'Read the registered tools, applications and harness sign-in status on the computer serving Jerry. Returns names and status only.',inputSchema:object({})};
const protocols = ['2025-11-25','2025-06-18','2025-03-26'];
export const workToolNames = tools.map(tool=>tool.name);
export async function serveWorkMcp(req,res,{principal, readBody, sendJSON, list, read, post, wait, waitForWork, inspectTools}) {
  if (!principal) return sendJSON(res,401,{error:'A work connection credential is required.'});
  // Native MCP clients omit Origin. Browser clients must use this service's origin.
  if (req.headers.origin) {
    let origin;
    try { origin=new URL(req.headers.origin); } catch {}
    if (!origin || origin.origin!==req.headers.origin || origin.host!==req.headers.host ||
        (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname))))
      return sendJSON(res,403,{error:'Unexpected browser origin.'});
  }
  if (req.method !== 'POST') { res.setHeader('allow','POST'); return sendJSON(res,405,{error:'Use MCP POST.'}); }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return sendJSON(res,415,{error:'Expected application/json.'});
  const protocol = req.headers['mcp-protocol-version'];
  if (protocol && !protocols.includes(protocol)) return sendJSON(res,400,{error:'Unsupported MCP protocol version.'});
  const message = await readBody(req, 128 * 1024);
  const {id, method, params} = message;
  const fail = (code,msg) => sendJSON(res,200,{jsonrpc:'2.0',id:id ?? null,error:{code,message:msg}});
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600,'Invalid JSON-RPC request.');
  if (id === undefined) { res.writeHead(202); return res.end(); }
  const canInspect=Boolean(principal.peer?.destinations && inspectTools);
  let result;
  if (method === 'initialize') result = {protocolVersion:protocols.includes(params?.protocolVersion) ? params.protocolVersion : protocols[0],
    capabilities:{tools:{}}, serverInfo:{name:'home23-jerry-work',version:'1.0'}, instructions:'Work stays in the thread Jerry assigned. Owner messages are directions. Post questions and results here.'};
  else if (method === 'ping') result = {};
  else if (method === 'tools/list') result = {tools:(canInspect ? [...tools,inventoryTool] : tools).map(tool=>({...tool,annotations:{
    readOnlyHint:tool.name!=='jerry_thread_post',destructiveHint:false,idempotentHint:true,openWorldHint:false
  }}))};
  else if (method === 'tools/call') {
    let value;
    try {
      const a = params?.arguments ?? {};
      if (params?.name === inventoryTool.name && canInspect) value=await inspectTools();
      else if (params?.name === 'jerry_work_list') value = list(principal);
      else if (params?.name === 'jerry_thread_read') value = read(principal,a.threadId);
      else if (params?.name === 'jerry_thread_wait' || params?.name === 'jerry_work_wait') {
        const abort = new AbortController();
        const close = () => abort.abort();
        res.once('close',close);
        try {
          value = params.name === 'jerry_thread_wait' ? await wait(principal,a.threadId,a.revision,abort.signal) :
            await waitForWork(principal,a.cursor,abort.signal);
        } finally { res.off('close',close); }
      }
      else if (params?.name === 'jerry_thread_post') value = post(principal,a);
      else return fail(-32602,'Unknown work tool.');
      result = {content:[{type:'text',text:JSON.stringify(value)}]};
    } catch (e) {
      if (!e.httpStatus) throw e;
      result = {isError:true,content:[{type:'text',text:e.message}]};
    }
  } else return fail(-32601,'Method not found.');
  return sendJSON(res,200,{jsonrpc:'2.0',id,result});
}
