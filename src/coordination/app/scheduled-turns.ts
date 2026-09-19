import type { M11Database } from '../work/types.js';
import type { createChannelService } from '../channels/service.js';
import type { MessagingActorContext } from '../channels/types.js';
import type { CoordinationMessageSubmissionPort } from './types.js';
import { generateCoordinationId } from '../ids/index.js';
import { canonicalJson } from '../work/canonical.js';
import { parseReasoningEffort } from '../../agent/reasoning-effort.js';

export interface ScheduledChannelTurn {
  runId: string; jobId: string; channelId: string; prompt: string;
  modelAlias?: string; reasoningEffort?: string; timeoutMs?: number;
  /** Execution target; the authenticated scheduling resident remains the author. */
  targetBotId?: string;
}
type Admission = ScheduledChannelTurn & { messageId: string; botId: string; deadlineAtMs?: number };
const terminal = new Set(['succeeded','failed','cancelled']);

/** Admit once from the scheduler's signed resident connection, then let canonical
 * Channel Work own execution/recovery. The scheduler only observes the result. */
export function createScheduledChannelTurns(options: {
  database: M11Database; channels: ReturnType<typeof createChannelService>;
  submit: CoordinationMessageSubmissionPort;
  context(botId?: string): MessagingActorContext; beginWork(): () => void;
  expireWork?(workId: string): void; now?(): number;
}) {
  const db = options.database;
  const pending = new Map<string,Promise<void>>();
  const admitted = (runId: string) => db.readOne<{ payload: string }>(
    "SELECT payload_json AS payload FROM events WHERE aggregate_kind = 'scheduled_channel_run' AND aggregate_id = ? AND aggregate_version = 1",runId);
  const failure = (runId: string) => db.readOne<{payload:string}>(
    "SELECT payload_json AS payload FROM events WHERE aggregate_kind = 'scheduled_channel_run' AND aggregate_id = ? AND aggregate_version = 2",runId);
  function record(value: Admission, version: number, error?: string) {
    db.mutateWithEvent(() => ({ value:undefined,event:{ type:'activity.updated', aggregateKind:'scheduled_channel_run',aggregateId:value.runId,
      aggregateVersion:version,channelId:value.channelId,actorPrincipalId:value.botId,requestId:generateCoordinationId('request'),
      correlationId:generateCoordinationId('correlation'),payload:JSON.parse(JSON.stringify({...value,...(error?{error}:{})})),createdAt:new Date().toISOString() } }));
  }
  const children = (value: Admission) => db.readAll<{id:string;state:string;text:string|null;messageId:string|null}>(
    `SELECT w.id,w.state,m.body_text AS text,m.id AS messageId FROM works w LEFT JOIN messages m ON m.work_id=w.id AND m.kind='result'
     WHERE w.kind IN ('channel.bot_turn','bot_turn') AND w.origin_message_id=? AND w.channel_id=? AND w.target_principal_id=?`, value.messageId,value.channelId,value.targetBotId ?? value.botId);
  function enforceDeadline(value: Admission) {
    if (value.deadlineAtMs === undefined || (options.now?.() ?? Date.now()) < value.deadlineAtMs) return;
    const rows = children(value);
    if (rows.length && rows.every(row => terminal.has(row.state))) return;
    if (!failure(value.runId)) record(value, 2, 'Scheduled channel execution deadline reached');
    for (const row of rows) if (!terminal.has(row.state)) options.expireWork?.(row.id);
  }
  function status(value: Admission) {
    enforceDeadline(value);
    const rows = children(value);
    if (rows.length && rows.every(row=>terminal.has(row.state))) {
      if (rows.some(row=>row.state!=='succeeded')) return {state: rows.some(row=>row.state==='cancelled')?'cancelled':'failed',error:failure(value.runId)?String(JSON.parse(failure(value.runId)!.payload).error):'Scheduled channel Work did not complete.',workIds:rows.map(row=>row.id)};
      if (rows.every(row=>row.messageId)) return {state:'succeeded',text:rows.map(row=>row.text??'').join('\n\n'),workIds:rows.map(row=>row.id)};
    }
    const failed = failure(value.runId);
    if (!rows.length && failed && !pending.has(value.runId)) return {state:'failed',error:String(JSON.parse(failed.payload).error)};
    return {state:'running',workIds:rows.map(row=>row.id)};
  }
  function dispatch(value: Admission) {
    enforceDeadline(value);
    if (pending.has(value.runId)||children(value).length||failure(value.runId)) return;
    const done = options.beginWork();
    const promise = options.submit.submitMessage({context:options.context(value.botId),channelId:value.channelId,idempotencyKey:`scheduled:${value.runId}`,
      body:{messageId:value.messageId,clientMessageId:value.messageId,text:value.prompt,attachmentIds:[],mentions:[value.targetBotId ?? value.botId],replyToMessageId:null,
        modelAlias:value.modelAlias??null,reasoningEffort:value.reasoningEffort?(parseReasoningEffort(value.reasoningEffort)??null):null}})
      .then(result=>{void result.response?.catch(()=>undefined);})
      .catch(error=>{
        // Busy admission and lost observations retain the exact journaled request for retry.
        if (['turn_in_progress','server_busy','deadline_exceeded','connection_lost','request_rate_limited'].includes(String(error?.code))) return;
        if(!failure(value.runId)) record(value,2,error instanceof Error?error.message:String(error));
      })
      .finally(()=>{pending.delete(value.runId);done();});
    pending.set(value.runId,promise);
  }
  return {
    async run(raw: unknown, botId?: string) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid scheduled channel run');
      const input = raw as ScheduledChannelTurn;
      if (typeof input.runId!=='string'||!/^sched-run-[a-f0-9-]{36}$/.test(input.runId)||typeof input.jobId!=='string'||!input.jobId||input.jobId.length>200||
        typeof input.channelId!=='string'||typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>64000||
        (input.modelAlias!==undefined&&typeof input.modelAlias!=='string')||
        (input.targetBotId!==undefined&&(typeof input.targetBotId!=='string'||!input.targetBotId.startsWith('bot_')||input.targetBotId.length>128))) throw new Error('Invalid scheduled channel run');
      if (input.timeoutMs!==undefined && (!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>2147483647||!options.expireWork)) throw new Error('Invalid scheduled execution deadline');
      if (input.reasoningEffort!==undefined) parseReasoningEffort(input.reasoningEffort);
      const normalized: ScheduledChannelTurn={runId:input.runId,jobId:input.jobId,channelId:input.channelId,prompt:input.prompt,
        ...(input.targetBotId?{targetBotId:input.targetBotId}:{}),...(input.modelAlias?{modelAlias:input.modelAlias}:{}),...(input.reasoningEffort?{reasoningEffort:input.reasoningEffort}:{}),...(input.timeoutMs?{timeoutMs:input.timeoutMs}:{})};
      let prior = admitted(input.runId); let value: Admission;
      if (!prior) {
        const context=options.context(botId);
        const channel=await options.channels.getChannel({context,channelId:input.channelId});
        if((channel.kind!=='group' && context.identity.kind!=='on_demand_bot')||channel.lifecycle!=='active'||!channel.members.some(member=>member.principalId===context.principalId))
          throw new Error('Scheduled channel must be active and contain the scheduling agent');
        if (input.targetBotId && (!db.readOne("SELECT id FROM bots WHERE id=? AND principal_id=? AND lifecycle='active'",input.targetBotId,input.targetBotId)||
          !channel.members.some(member=>member.principalId===input.targetBotId)))
          throw new Error('Scheduled target must be an active bot member of the channel');
        value={...normalized,messageId:generateCoordinationId('message'),botId:context.principalId,...(input.timeoutMs?{deadlineAtMs:(options.now?.()??Date.now())+input.timeoutMs}:{})};
        // getChannel yields; another retry may have completed admission meanwhile.
        prior=admitted(input.runId);
        if(!prior) record(value,1);
      }
      if(prior) {
        value=JSON.parse(prior.payload);
        if(value.botId!==options.context(botId).principalId) throw new Error('Scheduled run belongs to another agent');
        const {messageId:_,botId:__,deadlineAtMs:___,...original}=value;
        if(canonicalJson(original)!==canonicalJson(normalized)) throw new Error('Scheduled run replay changed');
      }
      dispatch(value!); return status(value!);
    },
    reconcile() {
      for (const row of db.readAll<{payload:string}>(`SELECT e.payload_json AS payload FROM events e
        WHERE e.aggregate_kind='scheduled_channel_run' AND e.aggregate_version=1
          AND EXISTS(SELECT 1 FROM works w WHERE w.kind IN ('channel.bot_turn','bot_turn') AND w.origin_message_id=json_extract(e.payload_json,'$.messageId') AND w.state NOT IN ('succeeded','failed','cancelled'))`))
        enforceDeadline(JSON.parse(row.payload));
      for(const row of db.readAll<{payload:string}>(`SELECT e.payload_json AS payload FROM events e
        WHERE e.aggregate_kind='scheduled_channel_run' AND e.aggregate_version=1
          AND NOT EXISTS(SELECT 1 FROM works w WHERE w.kind IN ('channel.bot_turn','bot_turn') AND w.origin_message_id=json_extract(e.payload_json,'$.messageId'))
          AND NOT EXISTS(SELECT 1 FROM events f WHERE f.aggregate_kind=e.aggregate_kind AND f.aggregate_id=e.aggregate_id AND f.aggregate_version=2)`))
        dispatch(JSON.parse(row.payload));
    },
  };
}
