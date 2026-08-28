const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(process.cwd(), 'engine/src/dashboard');
const bots = [
  { id:'bot_jerry', principalId:'principal_jerry', name:'Jerry', purpose:'Your primary Home23 companion.', availability:'available', lifecycle:'active', conversationId:'conversation_jerry', residentBinding:'jerry', updatedAt:'2026-08-25T18:21:00Z' },
  { id:'bot_forrest', principalId:'principal_forrest', name:'Forrest', purpose:'A durable specialist with his own conversation.', availability:'available', lifecycle:'active', conversationId:'conversation_forrest', residentBinding:'forrest', updatedAt:'2026-08-25T17:42:00Z' },
  { id:'bot_research', principalId:'principal_research', name:'Researcher', purpose:'Finds and compares primary sources.', availability:'busy', lifecycle:'active', conversationId:'conversation_research', residentBinding:'researcher', updatedAt:'2026-08-25T18:18:00Z' },
];
const channels = [
  { id:'channel_jerry', conversationId:'conversation_jerry', kind:'direct', title:'Jerry', purpose:'Your primary Home23 conversation.', lifecycle:'active', members:[{principalId:'user_owner',kind:'owner'},{principalId:'principal_jerry',kind:'bot'}], updatedAt:'2026-08-25T18:21:00Z' },
  { id:'channel_forrest', conversationId:'conversation_forrest', kind:'direct', title:'Forrest', purpose:'Forrest’s durable conversation.', lifecycle:'active', members:[{principalId:'user_owner',kind:'owner'},{principalId:'principal_forrest',kind:'bot'}], updatedAt:'2026-08-25T17:42:00Z' },
  { id:'channel_research', conversationId:'conversation_research', kind:'direct', title:'Researcher', purpose:'Research specialist.', lifecycle:'active', members:[{principalId:'user_owner',kind:'owner'},{principalId:'principal_research',kind:'bot'}], updatedAt:'2026-08-25T18:18:00Z' },
  { id:'channel_launch', conversationId:'conversation_launch', kind:'group', title:'Launch', purpose:'Jerry and Forrest coordinate the release.', lifecycle:'active', members:[{principalId:'user_owner',kind:'owner'},{principalId:'principal_jerry',kind:'bot'},{principalId:'principal_forrest',kind:'bot'}], updatedAt:'2026-08-25T18:20:00Z' },
];
const inbox = [
  {channelId:'channel_jerry',title:'Jerry',pinned:true,unread:{count:0},activity:{state:'idle',label:null},latestMessage:{preview:'I’ll keep the result here when it’s ready.',createdAt:'2026-08-25T18:21:00Z'},updatedAt:'2026-08-25T18:21:00Z'},
  {channelId:'channel_forrest',title:'Forrest',pinned:false,unread:{count:2},activity:{state:'idle',label:null},latestMessage:{preview:'The comparison is ready to review.',createdAt:'2026-08-25T17:42:00Z'},updatedAt:'2026-08-25T17:42:00Z'},
  {channelId:'channel_research',title:'Researcher',pinned:false,unread:{count:0},activity:{state:'working',label:'Reading three sources'},latestMessage:{preview:'Working in the background…',createdAt:'2026-08-25T18:18:00Z'},updatedAt:'2026-08-25T18:18:00Z'},
  {channelId:'channel_launch',title:'Launch',pinned:false,unread:{count:1},activity:{state:'idle',label:null},latestMessage:{preview:'Forrest: The handoff is complete.',createdAt:'2026-08-25T18:20:00Z'},updatedAt:'2026-08-25T18:20:00Z'},
];
const messages = {
  channel_jerry:[
    {id:'message_1',sequence:1,author:{kind:'owner',displayName:'You'},text:'Jerry, ask Researcher to compare the release notes and bring the useful result back here.',attachments:[],createdAt:'2026-08-25T18:17:00Z'},
    {id:'message_2',sequence:2,author:{kind:'bot',displayName:'Jerry'},text:'I asked Researcher to compare them. You can leave this conversation; I’ll keep the result here when it’s ready.',attachments:[],createdAt:'2026-08-25T18:18:00Z'},
    {id:'message_3',sequence:3,author:{kind:'bot',displayName:'Jerry'},text:'Researcher found two material differences. The authentication note is clearer, and the rollback section now preserves created conversations.',attachments:[{name:'release-comparison.pdf',contentType:'application/pdf',byteCount:184320}],createdAt:'2026-08-25T18:21:00Z'},
  ],
};
const communicationEvents = [
  {schemaVersion:1,eventId:'cevt_status',eventSequence:1,conversationId:'conversation_jerry',channelId:'channel_jerry',messageId:'message_3',workId:'work_release',attemptId:'attempt_release',turnId:'turn_release',parentEventId:null,actor:{principalId:'principal_jerry',displayName:'Jerry',kind:'resident_bot'},source:{system:'resident_runtime',provider:'openai-codex',model:'gpt-5.6',sourceEventType:'agent.status',reasoningEffort:'max'},kind:'status',provenance:null,occurredAt:'2026-08-25T18:20:00Z',payload:{status:'running',requestedModel:'gpt-5.6',requestedEffort:'max'},terminal:false},
  {schemaVersion:1,eventId:'cevt_reasoning',eventSequence:2,conversationId:'conversation_jerry',channelId:'channel_jerry',messageId:'message_3',workId:'work_release',attemptId:'attempt_release',turnId:'turn_release',parentEventId:null,actor:{principalId:'principal_jerry',displayName:'Jerry',kind:'resident_bot'},source:{system:'provider',provider:'openai-codex',model:'gpt-5.6',sourceEventType:'response.reasoning_summary_text.delta'},kind:'reasoning',provenance:'provider_reasoning_summary',occurredAt:'2026-08-25T18:20:10Z',payload:{text:'Compared the exact release evidence.'},terminal:false},
  {schemaVersion:1,eventId:'cevt_tool_start',eventSequence:3,conversationId:'conversation_jerry',channelId:'channel_jerry',messageId:'message_3',workId:'work_release',attemptId:'attempt_release',turnId:'turn_release',parentEventId:'cevt_reasoning',actor:{principalId:'principal_jerry',displayName:'Jerry',kind:'resident_bot'},source:{system:'provider',provider:'openai-codex',model:'gpt-5.6',sourceEventType:'response.function_call_arguments.done'},kind:'tool_call_started',provenance:null,occurredAt:'2026-08-25T18:20:20Z',payload:{toolCallId:'call_compare',tool:'read_release_notes',arguments:{paths:['release-a.md','release-b.md'],mode:'exact'}},terminal:false},
  {schemaVersion:1,eventId:'cevt_tool_result',eventSequence:4,conversationId:'conversation_jerry',channelId:'channel_jerry',messageId:'message_3',workId:'work_release',attemptId:'attempt_release',turnId:'turn_release',parentEventId:'cevt_tool_start',actor:{principalId:'principal_jerry',displayName:'Jerry',kind:'resident_bot'},source:{system:'resident_runtime',provider:'openai-codex',model:'gpt-5.6',sourceEventType:'agent.tool_result'},kind:'tool_call_completed',provenance:null,occurredAt:'2026-08-25T18:20:30Z',payload:{toolCallId:'call_compare',tool:'read_release_notes',result:{differences:2,exact:true},success:true},terminal:true},
  {schemaVersion:1,eventId:'cevt_receipt',eventSequence:5,conversationId:'conversation_jerry',channelId:'channel_jerry',messageId:'message_3',workId:'work_release',attemptId:'attempt_release',turnId:'turn_release',parentEventId:'cevt_tool_result',actor:{principalId:'principal_jerry',displayName:'Jerry',kind:'resident_bot'},source:{system:'resident_runtime',provider:'openai-codex',model:'gpt-5.6',sourceEventType:'turn.terminal',reasoningEffort:'max'},kind:'receipt',provenance:null,occurredAt:'2026-08-25T18:21:00Z',payload:{status:'succeeded',resultDigest:'a'.repeat(64),actualModel:'gpt-5.6',actualEffort:'max'},terminal:true},
];
function json(res,value,status=200){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/home23'){let html=fs.readFileSync(path.join(assets,'connected-agents.html'),'utf8');html=html.replace('<script src="/connected-agents-inspector.js?v=20260827b" defer></script>','<script>sessionStorage.setItem("home23:product-token","visual-fixture-token")</script><script src="/connected-agents-inspector.js?v=20260827b" defer></script>');res.writeHead(200,{'content-type':'text/html'});return res.end(html)}
  if(url.pathname==='/connected-agents.css') {res.writeHead(200,{'content-type':'text/css'});return res.end(fs.readFileSync(path.join(assets,'connected-agents.css')))}
  if(url.pathname==='/connected-agents-fixes.css') {res.writeHead(200,{'content-type':'text/css'});return res.end(fs.readFileSync(path.join(assets,'connected-agents-fixes.css')))}
  if(url.pathname==='/connected-agents.js') {res.writeHead(200,{'content-type':'text/javascript'});return res.end(fs.readFileSync(path.join(assets,'connected-agents.js')))}
  if(url.pathname==='/connected-agents-inspector.js') {res.writeHead(200,{'content-type':'text/javascript'});return res.end(fs.readFileSync(path.join(assets,'connected-agents-inspector.js')))}
  if(url.pathname==='/connected-agents-selection.js') {res.writeHead(200,{'content-type':'text/javascript'});return res.end(fs.readFileSync(path.join(assets,'connected-agents-selection.js')))}
  if(url.pathname==='/home23/api/product/capabilities')return json(res,{contractVersion:1,capabilities:{bootstrap:true,channelsRead:true,conversationsRead:true,messagesRead:true,unreadRead:true,messageSubmission:true,modelSelection:true,readCursorMutation:true,search:true,activity:true,botLifecycle:true,attachments:false,communicationEvidence:true,work:true,workMutation:true}});
  if(url.pathname==='/home23/api/product/bootstrap')return json(res,{home:{name:'Home23',primaryBotId:'bot_jerry'},snapshot:{bots},connection:{displayName:'This Mac',reachable:true}});
  if(url.pathname==='/home23/api/product/bots')return json(res,{bots});
  if(url.pathname==='/home23/api/product/channels')return json(res,{channels,nextCursor:null});
  if(url.pathname==='/home23/api/product/inbox')return json(res,{conversations:inbox});
  const channelMatch=url.pathname.match(/^\/home23\/api\/product\/channels\/([^/]+)$/);if(channelMatch)return json(res,{channel:channels.find(c=>c.id===channelMatch[1])});
  const messageMatch=url.pathname.match(/^\/home23\/api\/product\/channels\/([^/]+)\/messages$/);if(messageMatch)return json(res,{messages:messages[messageMatch[1]]||[],nextBeforeSequence:null});
  const executionMatch=url.pathname.match(/^\/home23\/api\/product\/channels\/([^/]+)\/execution-options$/);if(executionMatch)return json(res,{channelId:executionMatch[1],conversationId:channels.find(c=>c.id===executionMatch[1])?.conversationId,targetBotId:'bot_jerry',models:[{alias:'sol',provider:'openai-codex',model:'gpt-5.6-sol',reasoningEffort:'high'},{alias:'terra',provider:'openai-codex',model:'gpt-5.6-terra',reasoningEffort:'medium'}],defaultModel:'gpt-5.6-sol',defaultProvider:'openai-codex',defaultReasoningEffort:'high',reasoningEfforts:['none','low','medium','high','xhigh','max']});
  if(url.pathname==='/home23/api/product/search')return json(res,{results:[{type:'message',id:'message_3',channelId:'channel_jerry',title:'Jerry',excerpt:'Researcher found two material differences',createdAt:'2026-08-25T18:21:00Z'}],completeness:{status:'complete'}});
  if(url.pathname==='/home23/api/product/communications/events'){const after=Number(url.searchParams.get('after')||0);return json(res,{kind:'events',events:communicationEvents.filter(event=>event.eventSequence>after),throughSequence:communicationEvents.length,currentSequence:communicationEvents.length,retentionFloorSequence:1,hasMore:false})}
  if(url.pathname==='/home23/api/product/work/work_release')return json(res,{work:{id:'work_release',channelId:'channel_jerry',state:'succeeded',cancelAvailable:false,retryAvailable:false,createdAt:'2026-08-25T18:20:00Z',updatedAt:'2026-08-25T18:21:00Z',terminalAt:'2026-08-25T18:21:00Z',retryOfWorkId:null}});
  if(req.method==='POST')return json(res,{outcome:'accepted'},202);
  return json(res,{error:{code:'route_not_found'}},404);
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(`${server.address().port}\n`));
