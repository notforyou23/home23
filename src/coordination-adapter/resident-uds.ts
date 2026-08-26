import type { ConversationHistory } from "../agent/history.js";
import type { AgentEvent, AgentResponse, CoordinationTurnOrigin } from "../agent/types.js";
import type { AgentLoop } from "../agent/loop.js";
import { TurnStore } from "../chat/turn-store.js";
import { ResidentProtocolError, type JsonValue, type ResidentCredential, type ResidentRequestFrame } from "../coordination/resident-protocol/index.js";
import { ResidentUdsClient, ResidentUdsServer } from "../coordination/transport/uds/index.js";
import type { ResidentAgentPort } from "./types.js";

const START = "/internal/v1/turns/start";
const MAX_INSTRUCTION_BYTES = 262_144;
const RESULT_RETRY_MS = 100;
const MAX_RESULT_RETRIES = 3;

export function residentFence(origin: CoordinationTurnOrigin): string {
  return `${origin.workId}:${origin.attemptId}:${origin.leaseId}:${origin.fencingToken}`;
}

function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResidentProtocolError("request_invalid", "resident turn payload must be an object");
  return value;
}
function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new ResidentProtocolError("request_invalid", `${label} is invalid`);
  return value;
}
function origin(value: JsonValue | undefined): CoordinationTurnOrigin {
  const v=object(value as JsonValue); const result={kind:"coordination" as const,workId:string(v.workId,"workId"),attemptId:string(v.attemptId,"attemptId"),leaseId:string(v.leaseId,"leaseId"),holderPrincipalId:string(v.holderPrincipalId,"holderPrincipalId"),holderInstanceId:string(v.holderInstanceId,"holderInstanceId"),authorityReference:string(v.authorityReference,"authorityReference"),fencingToken:v.fencingToken,channelId:string(v.channelId,"channelId"),originMessageId:v.originMessageId===null?null:string(v.originMessageId,"originMessageId"),roundId:v.roundId===null?null:string(v.roundId,"roundId")};
  if(!Number.isSafeInteger(result.fencingToken)||Number(result.fencingToken)<1)throw new ResidentProtocolError("fence_invalid","resident fence is invalid");
  return result as CoordinationTurnOrigin;
}
function jsonOrigin(value:CoordinationTurnOrigin):JsonValue{return{...value};}

export interface ResidentTurnUdsServerOptions {
  socketPath:string;serverInstanceId:string;credential:ResidentCredential;
  residentSlug:string;agent:Pick<AgentLoop,"runWithTurn"|"stop"|"isRunning">;history:ConversationHistory;
  now?:()=>number;
}

/** Resident-owned endpoint. It can access the AgentLoop and TurnStore, but no coordination DB. */
export class ResidentTurnUdsServer {
  readonly #store:TurnStore; readonly #responses=new Map<string,Promise<AgentResponse>>(); readonly #server:ResidentUdsServer;
  constructor(private readonly options:ResidentTurnUdsServerOptions){
    this.#store=new TurnStore(options.history);
    if(options.credential.residentSlug!==options.residentSlug)throw new TypeError("resident credential slug does not match harness");
    this.#server=new ResidentUdsServer({socketPath:options.socketPath,serverInstanceId:options.serverInstanceId,credentials:[options.credential],now:options.now,validateFence:(fence,request)=>request.method==="POST"&&request.path===START?typeof fence==="string"&&fence.length<512:true,handleRequest:(request,context)=>this.#handle(request,context.signal)});
  }
  start(){return this.#server.start();}
  close(){return this.#server.close();}
  async #handle(request:ResidentRequestFrame,signal:AbortSignal):Promise<JsonValue>{
    if(request.method==="POST"&&request.path===START){
      const p=object(request.payload);const chatId=string(p.chatId,"chatId");const instruction=string(p.instruction,"instruction");const turnId=string(p.turnId,"turnId");const provenance=origin(p.origin);
      if(Buffer.byteLength(instruction,"utf8")>MAX_INSTRUCTION_BYTES)throw new ResidentProtocolError("request_invalid","resident instruction is too large");
      if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
      const final=this.#store.finalEnvelope(chatId,turnId);if(final)return{turnId,chatId,persistedAt:final.ended_at??final.started_at,recovered:true};
      const started=this.#store.startEnvelope(chatId,turnId);if(started&&!this.options.agent.isRunning(chatId))throw new ResidentProtocolError("connection_lost","persisted resident turn requires coordinator recovery",{retryable:true});
      if(!started){const run=await this.options.agent.runWithTurn(chatId,instruction,{turnId,coordinationOrigin:provenance,onDurableStart:async()=>undefined,onEvent:()=>undefined});this.#responses.set(turnId,run.response);void run.response.finally(()=>setTimeout(()=>this.#responses.delete(turnId),60_000).unref()).catch(()=>undefined);}
      const durable=this.#store.startEnvelope(chatId,turnId);if(!durable)throw new Error("AgentLoop returned before durable turn start");
      if(signal.aborted)throw new ResidentProtocolError("request_cancelled","resident start was cancelled");
      return{turnId,chatId,persistedAt:durable.started_at,recovered:Boolean(started)};
    }
    const match=/^\/internal\/v1\/turns\/([^/]+)\/(result|stop)$/.exec(request.path);
    if(!match)throw new ResidentProtocolError("request_invalid","unknown resident turn operation");
    const turnId=decodeURIComponent(match[1]!);const p=object(request.payload);const chatId=string(p.chatId,"chatId");const provenance=origin(p.origin);if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
    if(match[2]==="stop"){return{stopped:this.options.agent.stop(chatId,turnId).stopped};}
    const active=this.#responses.get(turnId);if(active){const response=await active;return{text:response.text,model:response.model,toolCallCount:response.toolCallCount,durationMs:response.durationMs};}
    const final=this.#store.finalEnvelope(chatId,turnId);if(!final)throw new ResidentProtocolError("connection_lost","resident result is not terminal",{retryable:true});
    if(final.status!=="complete"||typeof final.assistant_content!=="string")throw new ResidentProtocolError("internal_error",final.error_message??final.error??`resident turn ended ${final.status}`);
    return{text:final.assistant_content,model:final.model??"recovered",toolCallCount:0,durationMs:0,recovered:true};
  }
}

export interface ResidentUdsAgentPortOptions { client:ResidentUdsClient; residentSlug:string; deadlineMs?:number; now?:()=>number }

/** Coordinator-owned Agent port. Only privacy-safe turn data crosses UDS. */
export class ResidentUdsAgentPort implements ResidentAgentPort {
  readonly #active=new Map<string,{chatId:string;origin:CoordinationTurnOrigin;correlationId:string}>();
  constructor(private readonly options:ResidentUdsAgentPortOptions){}
  async runWithTurn(chatId:string,userText:string,options:{coordinationOrigin:CoordinationTurnOrigin;coordinationRequest?:{requestId:string;correlationId:string};onDurableStart(start:{turnId:string;chatId:string;persistedAt:string}):void|Promise<void>;onEvent(event:AgentEvent):void}){
    const request=options.coordinationRequest;if(!request)throw new Error("resident coordination request identity is required");const turnId=`coord-${options.coordinationOrigin.workId}`;const fence=residentFence(options.coordinationOrigin);const deadline=()=>(this.options.now?.()??Date.now())+Math.min(this.options.deadlineMs??25_000,25_000);
    const payload={chatId,instruction:userText,turnId,origin:jsonOrigin(options.coordinationOrigin),correlationId:request.correlationId} as JsonValue;
    const started=await this.options.client.request({method:"POST",path:START,payload,deadlineAtMs:deadline(),fence,requestId:request.requestId,correlationId:request.correlationId});const s=object(started.payload);await options.onDurableStart({turnId:string(s.turnId,"turnId"),chatId:string(s.chatId,"chatId"),persistedAt:string(s.persistedAt,"persistedAt")});this.#active.set(turnId,{chatId,origin:options.coordinationOrigin,correlationId:request.correlationId});
    options.onEvent({type:"status",status:"resident_durable_started"});
    const response=(async()=>{try{let error:unknown;for(let attempt=0;attempt<MAX_RESULT_RETRIES;attempt++){try{const result=await this.options.client.request({method:"GET",path:`/internal/v1/turns/${encodeURIComponent(turnId)}/result`,payload:{chatId,origin:jsonOrigin(options.coordinationOrigin),correlationId:request.correlationId},deadlineAtMs:deadline(),fence,correlationId:request.correlationId});const value=object(result.payload);return{text:string(value.text,"text"),model:string(value.model,"model"),toolCallCount:Number(value.toolCallCount),durationMs:Number(value.durationMs)};}catch(caught){error=caught;if(attempt+1<MAX_RESULT_RETRIES)await new Promise(resolve=>setTimeout(resolve,RESULT_RETRY_MS));}}throw error;}finally{this.#active.delete(turnId);}})();
    return{turnId,response};
  }
  async stop(chatId:string,turnId:string){
    const active=this.#active.get(turnId);if(!active||active.chatId!==chatId)return{stopped:false};const result=await this.options.client.request({method:"POST",path:`/internal/v1/turns/${encodeURIComponent(turnId)}/stop`,payload:{chatId,origin:jsonOrigin(active.origin),correlationId:active.correlationId},deadlineAtMs:(this.options.now?.()??Date.now())+5_000,fence:residentFence(active.origin),correlationId:active.correlationId});return{stopped:object(result.payload).stopped===true};
  }
  async close(){await this.options.client.close();}
}
