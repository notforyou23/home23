import { isDeepStrictEqual } from 'node:util';
import { hostname } from 'node:os';
import { localToolInventory, describeInventory } from './tool-inventory.mjs';
import {targetsThisMachine} from './tool-access.mjs';

const remoteTargets=(request,machine)=>request?.targets.filter(t=>t.environmentId && !targetsThisMachine([t],machine)) ?? [];

export async function remoteAccess(t3,request,machine) {
  const targets=remoteTargets(request,machine);
  if (!targets.length) return null;
  const {links}=await t3.call('t3_environment_links',{});
  for (const target of targets) {
    const link=links.find(l=>l.environmentId===target.environmentId);
    if (link?.status!=='reachable') return target.name+' is '+(link?.status??'unlinked')+' in T3. The requested remote work could not start.';
  }
  return null;
}

async function scratchProjectId(t3,environmentId) {
  let cursor=0;
  while (true) {
    const page=await t3.call('t3_project_list',{environmentId,limit:100,cursor});
    const scratch=page.projects.find(p=>p.id && !p.archivedAt && !p.deletedAt && !p.repositoryIdentity &&
      /(?:^|[\\/])\.t3[\\/]scratch[\\/]?$/.test(p.workspaceRoot));
    if (scratch) return scratch.id;
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor<=cursor) return null;
    cursor=page.nextCursor;
  }
}

async function remoteTargetInstructions(t3,target,harnesses) {
  const {environmentId}=target;
  const [project,capabilities]=await Promise.allSettled([
    scratchProjectId(t3,environmentId),
    harnesses.length ? t3.call('orchestrator_capabilities',{environmentId}) : undefined
  ]);
  const context={environmentId};
  const lines=[];
  if (project.status==='fulfilled' && project.value) {
    context.projectId=project.value;
    lines.push('For machine-level work on '+target.name+', its registered scratch target is '+JSON.stringify(context)+'.');
  } else {
    lines.push('Look up the project on '+target.name+' before delegating. If you cannot resolve a suitable project, report that to the owner.');
  }
  const providers=capabilities.status==='fulfilled' ? capabilities.value?.providers ?? [] : [];
  for (const harness of harnesses) {
    const provider=providers.find(p=>p.providerInstanceId===harness.provider && p.driverKind &&
      p.canRunChildTask && p.models?.some(m=>m.id===harness.model));
    if (provider) {
      const selected={...context,driverKind:provider.driverKind,providerInstanceId:provider.providerInstanceId,model:harness.model};
      lines.push('For '+harness.name+' on '+target.name+', use '+JSON.stringify(selected)+' as the registered target fields on the first call.');
    } else {
      lines.push('T3 could not confirm '+harness.name+' with '+harness.model+' on '+target.name+'. Check orchestrator_capabilities in that environment before delegating and report an unavailable selection.');
    }
  }
  return lines;
}

export async function remoteProjectInstructions(t3,request,machine) {
  const targets=remoteTargets(request,machine);
  if (!targets.length) return '';
  const harnesses=request.targets.filter(t=>t.kind==='harness' && t.provider);
  const lines=['Before requesting a remote T3 delegation, include both target.environmentId and target.projectId in the first delegate_task call. For work in a named project, select its active projectId with t3_project_list in that same environment.'];
  const perMachine=await Promise.all(targets.map(target=>remoteTargetInstructions(t3,target,harnesses)));
  lines.push(...perMachine.flat());
  lines.push('When selecting a remote provider, include its driverKind, providerInstanceId and model. If the owner named a different model, verify that exact choice with orchestrator_capabilities on the requested computer.');
  return lines.join('\n');
}

// The MCP adapter changes only the provider on its already pinned, idle thread.
// Preserve the owner's exact previous selection, including model options, across a crash.
export async function selectProvider(t3, threadId, local, wanted, save) {
  if (!wanted) return null;
  const read=()=>t3.call('t3_thread_configure',{threadId});
  const current=await read();
  if (current.runtimeMode!=='approval-required') throw new Error('The tool thread requires Supervised mode.');
  const sameProvider=selection=>selection?.instanceId===wanted.instanceId && selection.model===wanted.model;
  if (sameProvider(current.modelSelection)) {
    if (local.selection && !local.selection.applied) {
      local.selection.applied=current.modelSelection;
      save();
    }
    return null;
  }
  if (local.sending || local.run) return 'The active T3 run no longer has the requested provider. Check its state before sending another direction.';
  if (local.selection && !isDeepStrictEqual(local.selection.before,current.modelSelection))
    return 'The owner changed this T3 thread’s provider while the request was starting. The requested harness did not start.';
  const capabilities=await t3.call('orchestrator_capabilities',{});
  const provider=capabilities.providers.find(p=>p.providerInstanceId===wanted.instanceId);
  if (!provider?.canRunChildTask || !provider.models.some(m=>m.id===wanted.model))
    return 'T3 does not currently offer '+wanted.instanceId+' with '+wanted.model+' on this Mac.';
  if (!local.selection) {local.selection={before:current.modelSelection,wanted};save();}
  const selected=await t3.call('t3_thread_configure',{threadId,modelSelection:wanted});
  if (selected.runtimeMode!=='approval-required' || !sameProvider(selected.modelSelection)) throw new Error('T3 did not confirm the requested provider.');
  local.selection.applied=selected.modelSelection;save();
  return null;
}

export async function restoreProvider(t3, threadId, local, save) {
  const selection=local.selection;
  if (!selection) return;
  const {thread}=await t3.call('t3_thread_read',{threadId,limit:1,maxCharsPerItem:1});
  if (thread.threadId!==threadId || thread.runtimeMode!=='approval-required') throw new Error('The original tool thread changed.');
  if (thread.activeRunId) return;
  if (!selection.runId || thread.latestRunId===selection.runId) {
    const current=await t3.call('t3_thread_configure',{threadId});
    const applied=selection.applied;
    const matches=applied ? isDeepStrictEqual(current.modelSelection,applied) :
      current.modelSelection?.instanceId===selection.wanted.instanceId && current.modelSelection?.model===selection.wanted.model;
    if (matches)
      await t3.call('t3_thread_configure',{threadId,modelSelection:selection.before});
  }
  delete local.selection;save();
}

export async function directoryReport({t3,jerry,request,inspectLocal=localToolInventory,inspectOtherMachines,machine=hostname()}) {
  const hostKey=name=>name.toLowerCase().replace(/\.local\.?$/,'');
  const residentRead=jerry.call('jerry_tools_list');
  const localRead=residentRead.then(r=>hostKey(r.host)===hostKey(machine) ? r : inspectLocal(),()=>inspectLocal());
  const [local,resident,providers,links]=await Promise.allSettled([localRead,residentRead,
    t3.call('orchestrator_capabilities',{}),t3.call('t3_environment_links',{})]);
  const hosts=new Map([local,resident].filter(r=>r.status==='fulfilled').map(r=>[hostKey(r.value.host),r.value]));
  const requested=request.targets.filter(t=>t.kind==='machine');
  const needsOtherHost=requested.length ? requested.some(t=>!hosts.has(hostKey(t.host??t.name))) : hosts.size<2;
  let missingPeer=false;
  if (needsOtherHost && inspectOtherMachines) {
    const inventories=await inspectOtherMachines();
    for (const host of inventories) hosts.set(hostKey(host.host),host);
    missingPeer=inventories.length===0;
  }
  const chosen=requested.length ? requested.map(t=>hosts.get(hostKey(t.host??t.name)) ?? {unavailable:t.name}) : [...hosts.values()];
  const sections=chosen.map(h=>h.unavailable ? h.unavailable+' did not return a live tool inventory.' : describeInventory(h));
  if (!requested.length && missingPeer) sections.push('The other enrolled Jerry service did not return its tool inventory.');
  if (!requested.length && resident.status==='rejected') sections.push('The Jerry service did not return its tool inventory.');
  if (!requested.length && local.status==='rejected') sections.push('The T3 computer did not return its tool inventory.');
  if (providers.status==='fulfilled') {
    const enabled=providers.value.providers.filter(p=>p.canRunChildTask).map(p=>p.displayName ?? p.providerInstanceId);
    sections.push('T3'+(local.status==='fulfilled' ? ' on '+local.value.host : '')+' currently offers '+(enabled.join(', ')||'no enabled providers')+'.');
  } else sections.push('T3 provider inventory is unavailable.');
  if (links.status==='fulfilled') {
    const linked=links.value.links.map(l=>(l.label??l.environmentId)+' ('+l.status+', '+l.access+')');
    sections.push(linked.length ? 'Linked T3 environments — '+linked.join(', ') : 'This T3 environment currently has no linked environment.');
    const selected=links.value.links.filter(l=>l.status==='reachable' && (!requested.length || requested.some(t=>t.environmentId===l.environmentId)));
    const reports=await Promise.allSettled(selected.map(l=>t3.call('orchestrator_capabilities',{environmentId:l.environmentId})));
    for (const [index,report] of reports.entries()) {
      const label=selected[index].label;
      const names=report.status==='fulfilled' ? report.value.providers.filter(p=>p.canRunChildTask).map(p=>p.displayName ?? p.providerInstanceId) : null;
      sections.push(names ? 'T3 on '+label+' offers '+(names.join(', ')||'no enabled providers')+'.' : label+' did not return its T3 providers.');
    }
  } else sections.push('T3 linked-machine status is unavailable.');
  return sections.join('\n\n');
}

export async function reportApprovals({t3,jerry,threadId,id,runId,revision,thread,key,local,save}) {
  if (!thread.pendingRequestCount || thread.activeRunId!==runId) return false;
  const activity=await t3.call('t3_thread_read',{threadId,view:'activity',beforePosition:Number.MAX_SAFE_INTEGER,limit:50,runLimit:1,maxCharsPerItem:1});
  if (activity.thread.threadId!==threadId || activity.thread.runtimeMode!=='approval-required') throw new Error('The tool thread changed.');
  const pending=activity.items.filter(i=>i.sourceThreadId===threadId && i.runId===runId && i.type==='approval_request' && i.status==='waiting');
  if (!pending.length) return false;
  const link=activity.thread.link;
  const trusted=typeof link==='string' && (link.startsWith('https://app.t3.codes/threads/') || link.startsWith('t3-thread://'));
  const text='T3 needs your approval for a tool action on this work. '+(trusted ? 'Review the request in the Jerry thread. '+link : 'Open the Jerry thread in T3 to review it.');
  // A stable ID covers one batch even if more requests arrive before it is approved.
  const first=pending.sort((a,b)=>a.position-b.position)[0];
  const messageId=key(threadId,id,runId,first.itemId,revision,'approval');
  if (local.approvalNotice!==messageId) {
    await jerry.call('jerry_thread_post',{threadId:id,revision,kind:'progress',messageId,text});
    local.approvalNotice=messageId;
    save();
  }
  return true;
}
