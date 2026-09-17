import { TelegramAdapter } from '../../channels/telegram.js';
import { requestAsyncWorkCancel } from '../../work/cancel.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { unprivilegedChildEnv } from '../../security/child-process-env.js';
import { runCronBrainQueryJob } from '../../agent/cron-brain-query.js';
import { resolveModelOverride } from '../../agent/model-resolution.js';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrainOperationsClient } from '../../agent/brain-operations/client.js';
import { createToolRegistry } from '../../agent/tools/index.js';
import { BrowserController } from '../../browser/cdp.js';
import { TTSService } from '../../observability/tts.js';
import { ACPBridge, normalizeBridgeConfig } from '../../acp/bridge.js';
import { WorkRegistry } from '../../work/registry.js';
import { WorkStore } from '../../work/work-store.js';
import { createTrackedAgentRunner, executeTrackedTurn } from '../../agent/turn-entrypoint.js';
import { createWorkerHandlers } from '../../workers/connector.js';
import { CronScheduler, type JobResult } from '../../scheduler/cron.js';
import { runScheduledChannelTurn } from '../../scheduler/channel-run.js';
import type { ScheduledChannelTurn } from './scheduled-turns.js';
import type { ToolContext } from '../../agent/types.js';
import type { AgentLoop } from '../../agent/loop.js';
import type { HomeConfig } from '../../types.js';

/** File-backed recall for a helper without an engine. Reads actual retained
 * documents, never another resident's automatic personal-memory endpoint. */
export function searchHelperMemory(workspace: string, query: string, topK: number) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const hits: Array<{content:string; text:string; source:string; score:number}> = [];
  const walk = (dir:string, depth:number) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if (entry.name.startsWith('.')) continue;
      const file=join(dir,entry.name);
      if (entry.isDirectory() && depth<2) { walk(file,depth+1); continue; }
      if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name) || lstatSync(file).size>1_048_576) continue;
      const text=readFileSync(file,'utf8');
      for (const paragraph of text.split(/\n\s*\n/)) {
        const score=words.reduce((n,w)=>n+(paragraph.toLowerCase().includes(w)?1:0),0);
        if (score) hits.push({content:paragraph,text:paragraph,source:file,score});
      }
    }
  };
  walk(workspace,0);
  const results=hits.sort((a,b)=>b.score-a.score).slice(0,topK);
  return {results,sourceEvidence:{sourceHealth:'healthy',matchOutcome:results.length?'match':'no_match',retrievalMode:'helper_workspace',completeness:'bounded'}};
}

export function createHelperServices(input: {
  root: string; botRoot: string; workspace: string; agentName: string; config?: HomeConfig;
  enginePort: number; schedule?: (turn: ScheduledChannelTurn) => Promise<unknown>;
}) {
  const {config}=input;
  const coding=normalizeBridgeConfig(config?.acp);
  const providers=config?.providers as Record<string,{apiKey?:string}>|undefined;
  const registry=createToolRegistry({coding,web:{braveApiKey:providers?.brave?.apiKey??process.env.BRAVE_API_KEY??process.env.BRAVE_SEARCH_API_KEY,
    searxngUrl:(config?.search as {searxngUrl?:string}|undefined)?.searxngUrl??process.env.SEARXNG_URL}});
  const bridge=coding.enabled?new ACPBridge({config:coding,jobsDir:join(input.botRoot,'coding-jobs'),projectRoot:input.root}):null;
  const workRegistry=new WorkRegistry({store:new WorkStore(join(input.botRoot,'async-work')),agent:input.agentName});
  const tts={...config?.tts};
  if (tts.enabled&&!tts.apiKey&&tts.provider) tts.apiKey=providers?.[tts.provider]?.apiKey??'';
  const brainOperations=new BrainOperationsClient({baseUrl:`http://127.0.0.1:${input.enginePort}`,callerAgent:input.agentName,
    contextSearch:async(req,signal)=>{signal?.throwIfAborted();return searchHelperMemory(input.workspace,req.query,req.topK)}});
  let kernelPromise: Promise<any>|undefined;
  const kernel=()=>kernelPromise??=(async()=>{
    const mod=await import(pathToFileURL(join(input.root,'engine/src/agency/resident-kernel.js')).href);
    return new mod.AgencyKernel({brainDir:join(input.botRoot,'brain'),agentName:input.agentName,
      charterPath:resolve(input.root,config?.agency?.charterPath??'agency/charter.yaml'),config:config?.agency??{enabled:true,mode:'live'},logger:console});
  })();
  const agencyRequest=async(path:string,init?:RequestInit)=>{
    const k=await kernel(),body=init?.body?JSON.parse(String(init.body)):{};
    if (path==='/api/agency/state') return k.state();
    if (path==='/api/agency/brief') return k.brief(init?.method==='POST'?body:undefined);
    if (path==='/api/agency/pursuits') return {pursuits:k.pursuits({limit:100})};
    if (path==='/api/agency/intake') return k.intake(body);
    if (path==='/api/agency/world-stream') return k.intakeWorldStream(body);
    if (path==='/api/agency/tick') return k.tick(body);
    if (path==='/api/agency/claims') return {claim:k.recordClaim(body)};
    if (path==='/api/agency/deltas') return k.proposeDelta(body);
    if (path==='/api/agency/scratch') return {scratch:k.recordScratch(body)};
    if (path==='/api/agency/questions') return {question:k.raiseQuestion(body)};
    if (path==='/api/agency/tasks') return {task:k.recordTask(body)};
    const match=path.match(/^\/api\/agency\/(tasks|pursuits)\/([^/]+)\/transition$/);
    if (match) return match[1]==='tasks'?{task:k.closeTask(decodeURIComponent(match[2]!),body)}:k.transition(decodeURIComponent(match[2]!),body);
    throw new Error('Unknown helper agency operation');
  };
  let scheduler:CronScheduler|null=null;
  const context:Partial<ToolContext>={projectRoot:input.root,personalWorkspacePath:input.workspace,artifactWorkspacePath:input.workspace,brainOperations,agencyRequest,
    browser:config?.browser?.enabled?new BrowserController(config.browser):null,
    ttsService:tts.enabled&&tts.apiKey?new TTSService(tts as HomeConfig['tts']):null,
    codingBridge:bridge,workRegistry,subAgentTracker:{active:0,maxConcurrent:config?.agent?.maxSubAgents??8,queue:[]}};
  if (config?.channels?.telegram?.enabled) {
    const tc=config.channels.telegram,botToken=tc.botToken||process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error('House Telegram is enabled but has no configured token');
    // Sending shares the configured house adapter; Core must not create another inbound poller.
    const adapter=new TelegramAdapter({...tc,botToken,streaming:tc.streaming as 'partial'|'off'},async()=>{},join(input.botRoot,'state'));
    context.telegramAdapter={sendText:adapter.sendText.bind(adapter),sendTyping:adapter.sendTyping.bind(adapter),
      sendPhoto:adapter.sendPhoto.bind(adapter),sendVoice:adapter.sendVoice.bind(adapter),sendDocument:adapter.sendDocument.bind(adapter)};
  }
  return {registry,context,
    async initialize() { if(bridge) await bridge.recover(); workRegistry.reconcileOnBoot({jobs:bridge?.listJobs()??[]}); },
    attach(agent:AgentLoop,ctx:ToolContext) {
      ctx.runAgentLoop=createTrackedAgentRunner(agent);
      ctx.requestWorkCancel=workId=>requestAsyncWorkCancel({registry:workRegistry,
        cancelCodingJob:async jobId=>{if(bridge) await bridge.cancelJob(jobId);},
        stopChat:chatId=>agent.stop(chatId).stopped},workId);
      const workers=createWorkerHandlers({projectRoot:input.root,ctx});
      ctx.workerConnectorBaseUrl='http://home23-helper.local';
      ctx.fetch=async(url,init)=>{
        const u=new URL(String(url));
        if(u.origin!=='http://home23-helper.local') return fetch(url,init);
        let value:unknown;
        if(u.pathname==='/api/workers') value=await workers.listWorkers();
        else if(u.pathname==='/api/workers/runs') value=await workers.listRuns();
        else {const m=u.pathname.match(/^\/api\/workers\/runs\/([^/]+)(?:\/(receipt|promote-memory))?$/);
          if(!m) throw new Error('Unknown helper worker operation');
          value=m[2]==='receipt'?await workers.readReceipt(m[1]!):m[2]==='promote-memory'?await workers.promoteMemory(m[1]!):await workers.getRun(m[1]!);}
        return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
      };
      if (input.schedule && config?.scheduler) {
        scheduler=new CronScheduler({...config.scheduler,jobsFile:'cron-jobs.json',runsDir:'cron-runs'},async(job,execution)=>{
          if (!execution) throw new Error('Scheduled helper run lacks durable execution identity');
          const p=job.payload;
          const joined=execution.caller;
          if(p.kind==='systemEvent') return {status:'ok',response:p.text,durationMs:0};
          let prompt=p.kind==='agentTurn' ? (p.messagePath?readFileSync(resolve(input.root,p.messagePath),'utf8'):p.message??'') : '';
          if(p.kind==='exec'||p.kind==='query') {
            const receipts=join(input.botRoot,'state','scheduled-results');
            mkdirSync(receipts,{recursive:true,mode:0o700});
            const receipt=join(receipts,`${execution.runId}.json`), started=`${receipt}.started`;
            let result:JobResult;
            if(existsSync(receipt)) result=JSON.parse(readFileSync(receipt,'utf8'));
            else if(existsSync(started)) result={status:'error',error:'Execution was interrupted without a terminal receipt. Inspect its effects before deciding whether to run it again.',durationMs:0};
            else {
              writeFileSync(started,JSON.stringify({jobId:job.id,payload:p}),{flag:'wx',mode:0o600});
              const at=Date.now();
              // Jobs that genuinely need the source checkout (git, npm run,
              // scripts/*) pass an explicit payload.cwd; anything else
              // defaults to this bot's own scratch dir, never input.root
              // (which is the source root for on-demand bots).
              if(p.kind==='exec'&&!p.cwd) mkdirSync(join(input.botRoot,'scratch'),{recursive:true});
              try {
                result=p.kind==='exec' ? {status:'ok',response:(await promisify(exec)(p.command,{cwd:p.cwd||join(input.botRoot,'scratch'),
                  timeout:(p.timeoutSeconds??60)*1000,signal:joined?.abortSignal,env:unprivilegedChildEnv(),maxBuffer:10*1024*1024})).stdout.trim(),durationMs:Date.now()-at}
                  : {...await runCronBrainQueryJob(brainOperations,p,ctx.modelAliases??{},{signal:joined?.abortSignal}),durationMs:Date.now()-at};
              } catch(error) {result={status:'error',error:error instanceof Error?error.message:String(error),durationMs:Date.now()-at};}
              writeFileSync(`${receipt}.next`,JSON.stringify(result),{mode:0o600});renameSync(`${receipt}.next`,receipt);
            }
            if(joined || job.delivery?.mode==='none' || (job.delivery?.mode==='failures'&&result.status==='ok')) return result;
            prompt=`Report this already-executed scheduled job result to the owner. Do not repeat its execution. Job: ${job.name}. Receipt: ${receipt}\n${JSON.stringify(result).slice(0,10000)}`;
          }
          if(joined?.coordinationWorkDestination) {
            const model=p.kind==='agentTurn'&&p.model?resolveModelOverride(p.model,ctx.modelAliases??{}):undefined;
            if(p.kind==='agentTurn'&&p.model&&!model) throw new Error('Unknown scheduled model');
            const at=Date.now(),timeoutMs=(p.timeoutSeconds??21600)*1000;
            const result=await executeTrackedTurn(agent,`cron-${job.id}:${execution.runId}`,prompt,{
              signal:joined.abortSignal,onEvent:joined.onEvent,coordinationOrigin:joined.turnRuntime?.coordinationOrigin,
              coordinationWorkDestination:joined.coordinationWorkDestination,parentWorkId:joined.parentWorkId,
              hardDurationMs:timeoutMs,settlementTimeoutMs:timeoutMs,...(model?{modelOverride:model}:{}),
              ...(p.kind==='agentTurn'&&p.effort?{effort:p.effort}:{})});
            return {status:'ok',response:result.response.text,durationMs:Date.now()-at};
          }
          const channelId=p.channelId;
          if(!channelId) throw new Error('Helper schedule requires its channel_id');
          return runScheduledChannelTurn(execution.canonicalTurn??{runId:execution.runId,jobId:job.id,channelId,prompt,
            ...('model'in p&&p.model?{modelAlias:p.model}:{}),...('effort'in p&&p.effort?{reasoningEffort:p.effort}:{}),
            ...('timeoutSeconds'in p&&p.timeoutSeconds?{timeoutMs:p.timeoutSeconds*1000}:{})},execution,input.schedule!);
        },join(input.botRoot,'state'));
        ctx.scheduler=scheduler;
        ctx.schedulerUsesCurrentChannel=true;
      }
    },
    start(){scheduler?.start()},
    close(){scheduler?.stop();bridge?.dispose()},
  };
}
