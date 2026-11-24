// Names help Talk recognize requests. The selected harness still discovers the owner's
// actual tools and uses its own grants. A name here never grants access.
import { hostname } from 'node:os';

const clean = text => text.trim().replace(/\s+/g,' ');
const folded = text => clean(text).toLowerCase();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const kinds = new Set(['machine','harness','bot','app','tool']);
const validName = s => typeof s==='string' && s.length<=96 && clean(s)===s && /^[\p{L}\p{N}][\p{L}\p{N} ._+&()/-]*$/u.test(s);

export function toolAccess(entries) {
  if (entries===undefined) return null;
  if (!Array.isArray(entries)) throw new Error('Tool access must list named destinations.');
  const aliases=new Set();
  return entries.map(entry=>{
    if (!entry || !kinds.has(entry.kind) || !validName(entry.name) || !Array.isArray(entry.aliases ?? []) ||
        (entry.via!==undefined && !validName(entry.via)) || (entry.host!==undefined && !validName(entry.host)) ||
        (entry.provider!==undefined && (entry.kind!=='harness' || !validName(entry.provider) || !validName(entry.model))) ||
        (entry.model!==undefined && !entry.provider) || (entry.environmentId!==undefined &&
          (entry.kind!=='machine' || !entry.host || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(entry.environmentId))))
      throw new Error('Invalid tool destination.');
    const names=[entry.name,...(entry.aliases ?? [])];
    for (const name of names) {
      if (!validName(name) || aliases.has(folded(name))) throw new Error('Invalid or duplicate tool destination name.');
      aliases.add(folded(name));
    }
    const pattern=names.map(escape).sort((a,b)=>b.length-a.length).join('|');
    const match=new RegExp('(?<![\\p{L}\\p{N}_])(?:'+pattern+')(?![\\p{L}\\p{N}_])','iu');
    const target={kind:entry.kind,name:entry.name,...(entry.via ? {via:entry.via}:{}),...(entry.host ? {host:entry.host}:{}),
      ...(entry.environmentId ? {environmentId:entry.environmentId}:{}),...(entry.provider ? {provider:entry.provider,model:entry.model}:{})};
    return {match,target};
  });
}

const opener=/^(?:(?:hey|okay|ok)[, ]+)?(?:jerry[, ]+)?(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/i;
const discovery=/^(?:(?:show|list|check|discover|refresh)\s+(?:me\s+)?(?:(?:all|my|your|the|available|connected|installed|enabled|our)\s+)*(?:tools|harnesses|computers|machines|connections|MCP servers|connected apps)\b|(?:what|which)\b.{0,75}\b(?:tools|harnesses|computers|machines|MCP servers|connected apps)\b.{0,75}\b(?:have|use|access|connected|available|enabled|reach|installed)|(?:what|which)\b.{0,55}\b(?:access|connected|available)\b.{0,70}\b(?:tools|harnesses|computers|machines|apps))/i;
const actionVerbs=String.raw`ask|tell|use|message|send|have|check|find|look|read|list|show|compare|open|launch|run|inspect|change|set|write|edit|create|update|fix|search|research|investigate|summari[sz]e|build|test|call|fetch|download|upload|review|get|see|switch|connect|contact|install|move|restart|delete|deploy|schedule`;
const request=new RegExp("^(?:"+actionVerbs+"|using|on|in|with|through|via|what(?:'s| is| are| did| does| do)|which|is|are|did|does|how (?:much|many))\\b",'i');
const basicHostFacts=/^(?:what(?:'s| is| are)|check|report|read|show(?: me)?|tell me|get)\s+(?:(?:the|its|your)\s+)?(?:host ?name|computer name|architecture|cpu architecture|macos version|uptime)(?:\s*(?:,|and|&)\s*(?:its |the )?(?:host ?name|computer name|architecture|cpu architecture|macos version|uptime))*[?.! ]*$/i;

// Mentioning a computer or a tool while weighing an idea is not an assignment.
// A separate direct request in the same message still goes through normal routing.
const reflection=/^(?:(?:i'm |i am )?(?:just )?thinking (?:out loud|aloud)\b|what do you (?:think (?:of|about)|make of)\b|what(?:'s| is) your (?:take|opinion) (?:on|of)\b|(?:think hard about |tell me )?(?:who you are|what makes you you)\b|(?:i'm|i am) working on (?:a|your) bio(?:graphy)? for you\b)/i;
const additionalRequest=new RegExp(String.raw`(?:[.!?;,]\s*|\b(?:also|then)\s+|\band\s+(?=(?:please|can you|could you|would you|i need you to)\b))(?:(?:and|also|then|actually|please)\s+)*(?:(?:can|could|would|will) you\s+|i (?:want|need) you to\s+)?(?:please\s+)?((?:`+actionVerbs+String.raw`)\b.*)`,'i');
export function requestedAction(text) {
  const s=clean(String(text ?? '')).replace(/[’‘]/g,"'").replace(opener,'');
  if (!reflection.test(s)) return text;
  return s.match(additionalRequest)?.[1] ?? '';
}

export function requestedTools(text, destinations) {
  if (!destinations) return null;
  const s=clean(requestedAction(text)).replace(/[’]/g,"'").replace(opener,'');
  const inventory=discovery.test(s) || /^(?:what(?:'s| is) installed|what can you (?:access|use)) on\b/i.test(s);
  if (!inventory && !request.test(s) && !/^(?:reply to|follow up with|contact|consult|also ask)\b/i.test(s)) return null;
  // A name in the content of a message to a bot or harness is not an addressee.
  const address=s.match(/^(?:ask|tell|message|send to|reply to|follow up with|contact|consult|also ask|use|using|via|through|have|get)\s+/i);
  const scope=address ? address[0]+s.slice(address[0].length).split(/\s+(?:to|for|about|whether|if|that)\s+|[:,;.!?]/i,1)[0] : s;
  const selected=[];
  for (const {match,target} of destinations) {
    const hit=match.exec(scope);
    if (!hit) {
      if (target.kind==='machine' && /\b(?:both (?:of )?(?:my |the )?|each of (?:my |the ))(?:Macs|computers|machines)\b/i.test(scope)) selected.push(target);
      continue;
    }
    // "at home" is a place; "ask Home" is a message to a particular bot.
    if (target.kind==='bot' && !/\b(?:ask|tell|message|contact|consult|with|to|from|did|through|via|have|get)\s+(?:the bot\s+)?$/i.test(s.slice(0,hit.index))) continue;
    selected.push(target);
  }
  // Tools installed after configuration work immediately through explicit addressing.
  const explicit=s.match(/^(?:use|using|via|through)\s+(?:the\s+)?([^,:!?]{1,75}?)\s+(?:to\s+|for\s+)/i);
  const explicitName=explicit?.[1].split(/\s+(?:on|from|with)\s+(?:my |the )?/i)[0];
  if (explicitName && validName(explicitName) && !/^(?:this|that|it\b|the |my |your |second |first |both |either |each )/i.test(explicitName) &&
      !destinations.some(({match})=>match.test(explicitName))) selected.push({kind:'tool',name:explicitName});
  if (!selected.length && !inventory) return null;
  let localFacts=false;
  if (!inventory && selected.length===1 && selected[0].kind==='machine') {
    const {match}=destinations.find(d=>d.target===selected[0]);
    const question=s.replace(match,'@').replace(/\b(?:on|of|for|from)\s+(?:(?:the|my|your)\s+)?@[, ]*/i,'')
      .replace(/(?:(?:the|my|your)\s+)?@(?:'s)?[, ]*/i,'').trim();
    localFacts=basicHostFacts.test(question);
  }
  return {targets:selected,...(inventory ? {inventory:true}:{}),...(localFacts ? {localFacts:true}:{})};
}

export function toolWorkIntent(text, items, peer, request) {
  const key=r=>r.targets.map(t=>t.kind+'/'+folded(t.name)).sort().join('|');
  const matches=items.filter(i=>(i.peer===peer || (!i.peer && nativeMachineWork(request))) && i.toolRequest &&
    key(i.toolRequest)===key(request) && Boolean(i.toolRequest.inventory)===Boolean(request.inventory));
  const directed=/^(?:tell|ask|message|have|follow up|reply to|also)\b/i.test(clean(text).replace(opener,''));
  if (directed) {
    const active=matches.filter(i=>['running','queued','waiting'].includes(i.status));
    const candidates=active.length ? active : /^(?:tell|follow up|also)\b/i.test(clean(text).replace(opener,'')) ? matches.slice(-1) : [];
    if (candidates.length) return {kind:'steer',text,item:candidates.length===1 ? candidates[0] : null,candidates};
  }
  return {kind:'assign',text,peer,toolRequest:request};
}

export function toolInstructions(request,localHost) {
  if (!request) return '';
  const scope=request.targets.map(t=>t.kind+' '+t.name+(t.host ? ' (local hostname '+t.host+')':'')+
    (t.environmentId ? ' in enrolled T3 environment '+t.environmentId : '')+(t.via ? ' in '+t.via:'')).join(', ');
  const lines=['This is an owner-directed Home23 tool request'+(scope ? ' for '+scope:'')+'.',
    'Use the requested machine and the actual signed-in tool, app, harness or bot. Use its normal permissions. Verify the machine identity for machine-specific work. Return the tool observation or the exact blocker.'];
  if (request.targets.some(t=>t.kind==='bot'))
    lines.push('Deliver the owner’s message to that existing bot in its named app and read its actual reply. Do not answer on the bot’s behalf. Avoid resending an already delivered message.');
  const machines=request.targets.filter(t=>t.kind==='machine');
  if (localHost && machines.length && targetsThisMachine(machines,localHost))
    lines.push('The dispatching bridge verified this computer directly with the operating system: '+localHost+'. You can use that observation for host identity and proceed directly to the requested tool.');
  else if (machines.length)
    lines.push('For a different computer, check the linked environments or the owner’s enrolled machine connection. Report which computer actually handled the task.');
  if (request.targets.some(t=>t.kind==='bot' && t.via))
    lines.push('Open the named application with the native desktop controls and locate the recipient in the application.');
  if (request.targets.some(t=>t.environmentId))
    lines.push('Use the supplied environmentId for operations on that enrolled computer. Run any explicitly requested remote harness there. Verify the returned computer and harness before reporting success.');
  if (request.inventory) lines.push('Inspect the live tool and provider inventories on the requested computers. Distinguish installed, signed-in, reachable and actually exercised tools.');
  return lines.join('\n');
}

export function targetsThisMachine(targets, machine=hostname()) {
  const host=machine.toLowerCase().replace(/\.local\.?$/,'');
  return targets.every(t=>t.host && t.host.toLowerCase().replace(/\.local\.?$/,'')===host);
}

// The local worker can answer basic host facts while another Mac sleeps.
// General machine work needs the enrolled harness and its actual owner profile.
export function nativeMachineWork(request) {
  return Boolean(request?.localFacts && !request.inventory && request.targets.length===1 &&
    request.targets[0].kind==='machine' && targetsThisMachine(request.targets));
}

export function requestedProvider(request, machine) {
  if (!request || request.inventory) return null;
  const named=request.targets.filter(t=>t.kind==='harness' && t.provider);
  const machines=request.targets.filter(t=>t.kind==='machine');
  if (named.length!==1 || !targetsThisMachine(machines,machine)) return null;
  return {instanceId:named[0].provider,model:named[0].model};
}
