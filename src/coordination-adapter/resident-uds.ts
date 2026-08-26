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
const MAX_REQUEST_DEADLINE_MS = 25_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
// AgentLoop's normal hard turn limit is eight hours. A result read is a
// renewable signed transport request, not the lifetime of the resident turn.
const DEFAULT_RESULT_TIMEOUT_MS = (8 * 60 * 60 * 1_000) + 60_000;

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
  const v=object(value as JsonValue);
  if(v.kind!=="coordination")throw new ResidentProtocolError("request_invalid","resident turn origin kind is invalid");
  const result={kind:"coordination" as const,workId:string(v.workId,"workId"),attemptId:string(v.attemptId,"attemptId"),leaseId:string(v.leaseId,"leaseId"),holderPrincipalId:string(v.holderPrincipalId,"holderPrincipalId"),holderInstanceId:string(v.holderInstanceId,"holderInstanceId"),authorityReference:string(v.authorityReference,"authorityReference"),fencingToken:v.fencingToken,channelId:string(v.channelId,"channelId"),originMessageId:v.originMessageId===null?null:string(v.originMessageId,"originMessageId"),roundId:v.roundId===null?null:string(v.roundId,"roundId")};
  if(!Number.isSafeInteger(result.fencingToken)||Number(result.fencingToken)<1)throw new ResidentProtocolError("fence_invalid","resident fence is invalid");
  return result as CoordinationTurnOrigin;
}
function jsonOrigin(value:CoordinationTurnOrigin):JsonValue{return{...value};}

function exactOrigin(left: CoordinationTurnOrigin | undefined, right: CoordinationTurnOrigin): boolean {
  return left?.kind === right.kind && left.workId === right.workId &&
    left.attemptId === right.attemptId && left.leaseId === right.leaseId &&
    left.holderPrincipalId === right.holderPrincipalId &&
    left.holderInstanceId === right.holderInstanceId &&
    left.authorityReference === right.authorityReference &&
    left.fencingToken === right.fencingToken && left.channelId === right.channelId &&
    left.originMessageId === right.originMessageId && left.roundId === right.roundId;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function nonnegativeSafeInteger(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ResidentProtocolError("request_invalid", `${name} is invalid`);
  }
  return value;
}

function retryableTransportWait(error: unknown): boolean {
  if (!(error instanceof ResidentProtocolError)) return false;
  return error.code === "deadline_exceeded" ||
    (error.retryable && (
      error.code === "connection_lost" ||
      error.code === "server_busy" ||
      error.code === "request_rate_limited" ||
      error.code === "internal_error"
    ));
}

function assertResidentBinding(
  provenance: CoordinationTurnOrigin,
  residentSlug: string,
  serverInstanceId: string,
): void {
  if (
    provenance.authorityReference !== `resident:${residentSlug}` ||
    provenance.holderInstanceId !== serverInstanceId
  ) {
    throw new ResidentProtocolError("fence_invalid", "resident turn is bound to a different harness");
  }
}

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
      assertResidentBinding(provenance,this.options.residentSlug,this.options.serverInstanceId);
      if(Buffer.byteLength(instruction,"utf8")>MAX_INSTRUCTION_BYTES)throw new ResidentProtocolError("request_invalid","resident instruction is too large");
      if(turnId!==`coord-${provenance.workId}`)throw new ResidentProtocolError("fence_invalid","resident turn ID does not match its Work origin");
      if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
      const started=this.#store.startEnvelope(chatId,turnId);if(started&&!exactOrigin(started.coordination_origin,provenance))throw new ResidentProtocolError("fence_invalid","resident turn origin does not match durable start");
      const final=this.#store.finalEnvelope(chatId,turnId);if(final)return{turnId,chatId,persistedAt:final.ended_at??final.started_at,recovered:true};
      if(started&&!this.options.agent.isRunning(chatId))throw new ResidentProtocolError("connection_lost","persisted resident turn requires coordinator recovery",{retryable:true});
      if(!started){const run=await this.options.agent.runWithTurn(chatId,instruction,{turnId,coordinationOrigin:provenance,onDurableStart:async()=>undefined,onEvent:()=>undefined});this.#responses.set(turnId,run.response);void run.response.finally(()=>setTimeout(()=>this.#responses.delete(turnId),60_000).unref()).catch(()=>undefined);}
      const durable=this.#store.startEnvelope(chatId,turnId);if(!durable)throw new Error("AgentLoop returned before durable turn start");
      if(signal.aborted)throw new ResidentProtocolError("request_cancelled","resident start was cancelled");
      return{turnId,chatId,persistedAt:durable.started_at,recovered:Boolean(started)};
    }
    const match=/^\/internal\/v1\/turns\/([^/]+)\/(result|stop)$/.exec(request.path);
    if(!match)throw new ResidentProtocolError("request_invalid","unknown resident turn operation");
    const turnId=decodeURIComponent(match[1]!);const p=object(request.payload);const chatId=string(p.chatId,"chatId");const provenance=origin(p.origin);if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
    assertResidentBinding(provenance,this.options.residentSlug,this.options.serverInstanceId);
    if(turnId!==`coord-${provenance.workId}`)throw new ResidentProtocolError("fence_invalid","resident turn ID does not match its Work origin");
    const durableStart=this.#store.startEnvelope(chatId,turnId);if(!durableStart||!exactOrigin(durableStart.coordination_origin,provenance))throw new ResidentProtocolError("fence_invalid","resident turn origin does not match durable start");
    if(match[2]==="stop"){return{stopped:this.options.agent.stop(chatId,turnId).stopped};}
    const active=this.#responses.get(turnId);if(active){
      try {
        const response=await active;return{text:response.text,model:response.model,toolCallCount:response.toolCallCount,durationMs:response.durationMs};
      } catch (error) {
        const terminal=this.#store.finalEnvelope(chatId,turnId);
        if(terminal&&terminal.status!=="complete")throw new ResidentProtocolError("internal_error",terminal.error_message??terminal.error??`resident turn ended ${terminal.status}`);
        throw error;
      }
    }
    const final=this.#store.finalEnvelope(chatId,turnId);if(!final)throw new ResidentProtocolError("connection_lost","resident result is not terminal",{retryable:true});
    if(final.status!=="complete"||typeof final.assistant_content!=="string")throw new ResidentProtocolError("internal_error",final.error_message??final.error??`resident turn ended ${final.status}`);
    return{text:final.assistant_content,model:final.model??"recovered",toolCallCount:0,durationMs:0,recovered:true};
  }
}

export interface ResidentUdsAgentPortOptions {
  client:ResidentUdsClient;
  residentSlug:string;
  /** Per-request signed transport window. It does not bound the resident turn. */
  deadlineMs?:number;
  /** Overall startup/reattachment window while the resident harness comes online. */
  startTimeoutMs?:number;
  /** Overall wait for a terminal resident result. Defaults just beyond AgentLoop's hard limit. */
  resultTimeoutMs?:number;
  retryDelayMs?:number;
  now?:()=>number;
}

/** Coordinator-owned Agent port. Only privacy-safe turn data crosses UDS. */
export class ResidentUdsAgentPort implements ResidentAgentPort {
  readonly #active=new Map<string,{chatId:string;origin:CoordinationTurnOrigin;correlationId:string}>();
  readonly #requestDeadlineMs:number;
  readonly #startTimeoutMs:number;
  readonly #resultTimeoutMs:number;
  readonly #retryDelayMs:number;
  constructor(private readonly options:ResidentUdsAgentPortOptions){
    this.#requestDeadlineMs=Math.min(positiveSafeInteger(options.deadlineMs??MAX_REQUEST_DEADLINE_MS,"resident request deadline"),MAX_REQUEST_DEADLINE_MS);
    this.#startTimeoutMs=positiveSafeInteger(options.startTimeoutMs??DEFAULT_START_TIMEOUT_MS,"resident start timeout");
    this.#resultTimeoutMs=positiveSafeInteger(options.resultTimeoutMs??DEFAULT_RESULT_TIMEOUT_MS,"resident result timeout");
    this.#retryDelayMs=positiveSafeInteger(options.retryDelayMs??RESULT_RETRY_MS,"resident result retry delay");
  }
  async runWithTurn(chatId:string,userText:string,options:{coordinationOrigin:CoordinationTurnOrigin;coordinationRequest?:{requestId:string;correlationId:string};onDurableStart(start:{turnId:string;chatId:string;persistedAt:string}):void|Promise<void>;onEvent(event:AgentEvent):void}){
    if(options.coordinationOrigin.authorityReference!==`resident:${this.options.residentSlug}`)throw new TypeError("resident authority does not match the configured port");
    const request=options.coordinationRequest;if(!request)throw new Error("resident coordination request identity is required");const turnId=`coord-${options.coordinationOrigin.workId}`;const fence=residentFence(options.coordinationOrigin);const now=()=>this.options.now?.()??Date.now();
    const payload={chatId,instruction:userText,turnId,origin:jsonOrigin(options.coordinationOrigin),correlationId:request.correlationId} as JsonValue;
    const startDeadlineAt=now()+this.#startTimeoutMs;let started;let firstStartRequest=true;
    for(;;){
      const remaining=startDeadlineAt-now();
      if(remaining<1)throw new ResidentProtocolError("deadline_exceeded","resident turn did not durably start before its overall deadline");
      try{
        started=await this.options.client.request({method:"POST",path:START,payload,deadlineAtMs:now()+Math.min(this.#requestDeadlineMs,remaining),fence,correlationId:request.correlationId,...(firstStartRequest?{requestId:request.requestId}:{})});
        break;
      }catch(caught){
        if(!retryableTransportWait(caught))throw caught;
        firstStartRequest=false;
        const retryRemaining=startDeadlineAt-now();
        if(retryRemaining<1)throw new ResidentProtocolError("deadline_exceeded","resident turn did not durably start before its overall deadline");
        await new Promise(resolve=>setTimeout(resolve,Math.min(this.#retryDelayMs,retryRemaining)));
      }
    }
    const s=object(started.payload);await options.onDurableStart({turnId:string(s.turnId,"turnId"),chatId:string(s.chatId,"chatId"),persistedAt:string(s.persistedAt,"persistedAt")});this.#active.set(turnId,{chatId,origin:options.coordinationOrigin,correlationId:request.correlationId});
    options.onEvent({type:"status",status:"resident_durable_started"});
    const response=(async()=>{try{
      const resultDeadlineAt=now()+this.#resultTimeoutMs;
      for(;;){
        const remaining=resultDeadlineAt-now();
        if(remaining<1)throw new ResidentProtocolError("deadline_exceeded","resident result did not become terminal before its overall deadline");
        try{
          const result=await this.options.client.request({method:"GET",path:`/internal/v1/turns/${encodeURIComponent(turnId)}/result`,payload:{chatId,origin:jsonOrigin(options.coordinationOrigin),correlationId:request.correlationId},deadlineAtMs:now()+Math.min(this.#requestDeadlineMs,remaining),fence,correlationId:request.correlationId});const value=object(result.payload);return{text:string(value.text,"text"),model:string(value.model,"model"),toolCallCount:nonnegativeSafeInteger(value.toolCallCount,"toolCallCount"),durationMs:nonnegativeSafeInteger(value.durationMs,"durationMs")};
        }catch(caught){
          if(!retryableTransportWait(caught))throw caught;
          const retryRemaining=resultDeadlineAt-now();
          if(retryRemaining<1)throw new ResidentProtocolError("deadline_exceeded","resident result did not become terminal before its overall deadline");
          await new Promise(resolve=>setTimeout(resolve,Math.min(this.#retryDelayMs,retryRemaining)));
        }
      }
    }finally{this.#active.delete(turnId);}})();
    return{turnId,response};
  }
  async stop(chatId:string,turnId:string){
    const active=this.#active.get(turnId);if(!active||active.chatId!==chatId)return{stopped:false};const result=await this.options.client.request({method:"POST",path:`/internal/v1/turns/${encodeURIComponent(turnId)}/stop`,payload:{chatId,origin:jsonOrigin(active.origin),correlationId:active.correlationId},deadlineAtMs:(this.options.now?.()??Date.now())+5_000,fence:residentFence(active.origin),correlationId:active.correlationId});return{stopped:object(result.payload).stopped===true};
  }
  async close(){await this.options.client.close();}
}
