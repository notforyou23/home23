import type { AppendCommunicationEventInput } from '../communications/types.js';
import type { M11Database, WorkRecord } from '../work/types.js';
import { canonicalJson, sha256 } from '../work/canonical.js';
import { generateCoordinationId } from '../ids/index.js';
import { createResidentAssignments } from './resident-assignments.js';

type ToolEvidence = { tool: string; result: string; success: boolean; arguments?: unknown };
type Admission = {jobId:string;channelId:string;botId:string;targetBotId?:string;prompt:string;messageId:string};
type QuietState = {fingerprint:string;observations:Record<string,string>};
type Decision = {suppressed:boolean;text:string|null;fingerprint:string|null;scope:string;observations:Record<string,string>};

/** Require a no-change report and complete successful tool evidence. A guarded
 * dispatcher compares its canonical snapshot and overlapping observations;
 * the generic fallback compares the full report and sorted tool evidence.
 * A top-level regeneration timestamp does not describe changed state. */
function noChangeState(text: string | null, evidence: readonly ToolEvidence[], artifacts: readonly string[]): QuietState | null {
  if (!text || artifacts.length || !evidence.length || evidence.some(row => row.success !== true)) return null;
  if (!/\b(?:guard(?:ed)?|blocked|waiting)\b|\b\w+_(?:guarded|blocked|waiting)\b/i.test(text)
      || !/\b(?:no|nothing)\b[^.!?\n]{0,100}\b(?:chang(?:e[ds]?)|progress|updates?)\b/i.test(text)
      || /\b(?:error|failed|failure|timed? out|deadline)\b/i.test(text)) return null;
  // A report that also claims new work is ambiguous, so always publish it.
  const remaining = text.replace(/\b(?:no|nothing)\b[^.!?\n]{0,100}\b(?:chang(?:e[ds]?)|progress|updates?)\b/gi, '');
  if (/\b(?:created|saved|advanced|completed|published|updated|repaired|fixed|wrote|new)\b/i.test(remaining)) return null;
  let snapshot: Record<string, any> | null = null;
  const results = evidence.map(row => {
    let result = row.result;
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const {generated_at: _, ...stable} = parsed;
        result = canonicalJson(stable);
        if (stable.schema===1 && stable.stage==='publication_guarded' && typeof stable.task_id==='string'
          && stable.repair_guard?.enabled===true && typeof stable.repair_guard.path==='string' && Array.isArray(stable.inputs)
          && stable.inputs.length && stable.inputs.every((input:any)=>typeof input.path==='string' && typeof input.sha256==='string')) snapshot=stable;
      }
    } catch { /* Plain text is evidence too; preserve every byte. */ }
    return {tool:row.tool,arguments:row.arguments??null,result};
  });
  const normalized=text.trim().replace(/\b(?:confirmed|verified)\b/gi,'checked');
  const observations:Record<string,string>={};
  // A guarded dispatcher exposes its state and input hashes. Compare that
  // state plus overlapping observations, so an extra read-only inspection
  // does not become a new blocking condition. Changed evidence still emits.
  if (snapshot) {
    for (const row of results) {
      const args=row.arguments as Record<string,unknown> | null;
      if (row.tool==='shell') {
        const command=args?.command;
        const dispatcher=command==='bash bin/run-cycle.sh' && row.result.trim()==='Exit code: 0';
        const presence=typeof command==='string' && /^for p in [A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*; do if \[ -f "\$p" \]; then printf 'PRESENT %s\\n' "\$p"; else printf 'ABSENT %s\\n' "\$p"; fi; done$/.test(command);
        if (!dispatcher && !presence) return null;
        if (presence) observations[`presence:${canonicalJson(args)}`]=sha256(row.result);
      } else if (row.tool==='read_file' && typeof args?.path==='string') {
        observations[`file:${args.path}`]=sha256(row.result);
      } else return null;
    }
    return {fingerprint:sha256(canonicalJson(snapshot)),observations};
  }
  if (evidence.some(row=>!['read_file','work_status','work_list'].includes(row.tool))) return null;
  return {fingerprint:sha256(canonicalJson({text:normalized,results:results.sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))})),observations};
}

export function scheduledNoChangeFingerprint(text: string | null, evidence: readonly ToolEvidence[], artifacts: readonly string[]): string | null {
  const state=noChangeState(text,evidence,artifacts);
  return state?sha256(canonicalJson(state)):null;
}

function admission(database: M11Database, messageId: string): Admission | null {
  const row = database.readOne<{payload:string}>(`SELECT payload_json AS payload FROM events
    WHERE aggregate_kind='scheduled_channel_run' AND aggregate_version=1
      AND json_extract(payload_json,'$.messageId')=? LIMIT 1`, messageId);
  return row ? JSON.parse(row.payload) : null;
}
function scope(value: Admission) {
  return sha256(canonicalJson({jobId:value.jobId,channelId:value.channelId,botId:value.botId,
    targetBotId:value.targetBotId??value.botId,prompt:value.prompt}));
}

/** Scheduled replies are committed once the complete outcome is known. Keep
 * their original deltas as private receipts so streaming cannot bypass dedup. */
export function scheduledResponseCommunication(database: M11Database, input: AppendCommunicationEventInput): AppendCommunicationEventInput {
  if (input.event.kind !== 'assistant_response_delta' || !input.event.workId) return input;
  const scheduled = database.readOne(`SELECT e.sequence FROM works w JOIN events e
    ON e.aggregate_kind='scheduled_channel_run' AND e.aggregate_version=1
      AND json_extract(e.payload_json,'$.messageId')=w.origin_message_id
    WHERE w.id=? AND w.channel_id=? AND w.target_principal_id=?`,
  input.event.workId,input.event.channelId,input.event.actor?.principalId);
  if (!scheduled) return input;
  const {delta: _, ...payload} = input.event.payload;
  return {...input,event:{...input.event,kind:'receipt',payload:{...payload,scheduledResponseBuffered:true}}};
}

export function createScheduledChannelNotices(database: M11Database) {
  function record(kind: string, id: string, payload: Record<string, any>, channelId: string, actor: string) {
    database.mutateWithEvent(tx => ({value:undefined,event:{type:'activity.updated',aggregateKind:kind,aggregateId:id,
      aggregateVersion:(tx.readOne<{version:number}>('SELECT coalesce(max(aggregate_version),0) AS version FROM events WHERE aggregate_kind=? AND aggregate_id=?',kind,id)?.version??0)+1,
      channelId,actorPrincipalId:actor,requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation'),
      payload,createdAt:new Date().toISOString()}}));
  }
  function previous(key: string) {
    const cached=database.readOne<{payload:string;sequence:number}>(`SELECT payload_json AS payload,sequence FROM events
      WHERE aggregate_kind='scheduled_channel_notice' AND aggregate_id=? ORDER BY aggregate_version DESC LIMIT 1`,key);
    // A result can commit before the producer records its scope marker. Read
    // that published decision here, before a new run can reuse stale state.
    const published=database.readOne<{payload:string;sequence:number;recordedAt:string}>(`SELECT e.payload_json AS payload,e.sequence,e.created_at AS recordedAt
      FROM events e JOIN messages m ON m.work_id=e.aggregate_id AND m.kind='result'
      WHERE e.aggregate_kind='scheduled_channel_notice_work' AND e.sequence>?
        AND json_extract(e.payload_json,'$.scope')=? AND json_extract(e.payload_json,'$.suppressed')=0
      ORDER BY e.sequence DESC LIMIT 1`,cached?.sequence??0,key);
    return published?{...published,payload:JSON.stringify({...JSON.parse(published.payload),recordedAt:published.recordedAt})}:cached;
  }
  const decision = (workId: string) => database.readOne<{payload:string;sequence:number}>(`SELECT payload_json AS payload,sequence FROM events
    WHERE aggregate_kind='scheduled_channel_notice_work' AND aggregate_id=? AND aggregate_version=1`,workId);
  return {
    hasResult(workId: string) {
      const saved=decision(workId);
      return !!saved && JSON.parse(saved.payload).suppressed===true;
    },
    admit(value: Admission) {
      const prior = previous(scope(value));
      if (!prior || !JSON.parse(prior.payload).fingerprint || database.readOne(`SELECT sequence FROM events
        WHERE aggregate_kind='scheduled_channel_notice_pending' AND aggregate_id=? AND aggregate_version=1`,value.messageId)) return;
      record('scheduled_channel_notice_pending',value.messageId,{pending:true},value.channelId,value.targetBotId??value.botId);
    },
    prepare(work: WorkRecord, text: string | null, artifacts: readonly string[], toolCallCount: number): boolean {
      const saved = decision(work.id);
      if (saved) return (JSON.parse(saved.payload) as Decision).suppressed;
      if (!work.originMessageId) return false;
      const value = admission(database,work.originMessageId);
      if (!value || value.channelId!==work.channelId || (value.targetBotId??value.botId)!==work.targetPrincipalId) return false;
      const key = scope(value);
      const rows = database.readAll<{payload:string;digest:string}>(`SELECT payload_json AS payload,payload_digest AS digest FROM events INDEXED BY communication_events_turn_sequence
        WHERE type='communication.recorded' AND json_extract(payload_json,'$.communication.turnId')=?
          AND json_extract(payload_json,'$.communication.workId')=? AND json_extract(payload_json,'$.communication.attemptId')=?
          AND json_extract(payload_json,'$.communication.kind') IN ('tool_call_started','tool_call_completed','failure','artifact','media','subagent_completed','worker_completed')
        ORDER BY sequence LIMIT 257`,`coord-${work.id}`,work.id,work.currentAttemptId);
      const evidence: ToolEvidence[] = [];
      const starts=new Map<string,{tool:string;arguments:unknown}>();
      const finished=new Set<string>();
      let complete = work.state==='succeeded' && rows.length>0 && rows.length<=256 && rows.length===toolCallCount*2;
      for (const row of rows) {
        if (sha256(row.payload)!==row.digest) { complete=false; break; }
        const event=JSON.parse(row.payload).communication;
        const payload=event?.payload;
        if (event?.kind==='tool_call_started' && typeof payload?.tool==='string' && typeof payload?.toolCallId==='string'
          && payload.arguments && typeof payload.arguments==='object' && !starts.has(payload.toolCallId)) {
          starts.set(payload.toolCallId,{tool:payload.tool,arguments:payload.arguments});
          continue;
        }
        if (event?.kind!=='tool_call_completed' || typeof payload?.tool!=='string' || typeof payload?.result!=='string'
          || typeof payload?.success!=='boolean') { complete=false; break; }
        const started=starts.get(payload.toolCallId);
        if (!started || started.tool!==payload.tool || finished.has(payload.toolCallId)) { complete=false; break; }
        finished.add(payload.toolCallId);
        evidence.push({tool:payload.tool,arguments:started.arguments,result:payload.result,success:payload.success});
      }
      const conclusion=createResidentAssignments(database).latest(work.id);
      const state=complete && (!conclusion || conclusion.state==='blocked') ? noChangeState(text,evidence,artifacts) : null;
      const fingerprint=state?sha256(canonicalJson({fingerprint:state.fingerprint,conclusion:conclusion?{state:conclusion.state,summary:conclusion.summary,evidence:conclusion.evidence,waitFor:conclusion.waitFor,revisitAt:conclusion.revisitAt}:null})):null;
      const prior=previous(key);
      // An intervening failed execution resets a repeated blocking condition.
      const last=prior?JSON.parse(prior.payload):null;
      const failedSince=last && database.readOne(`SELECT w.id FROM works w JOIN events e
        ON e.aggregate_kind='work' AND e.aggregate_id=w.id AND e.sequence>?
        WHERE w.channel_id=? AND w.target_principal_id=? AND w.state IN ('failed','cancelled') LIMIT 1`,prior!.sequence,work.channelId,work.targetPrincipalId);
      const observations=state?.observations??{};
      const changed=Object.entries(observations).some(([name,digest])=>last?.observations?.[name]!==undefined && last.observations[name]!==digest);
      const suppressed=!!fingerprint && !failedSince && !changed && last?.fingerprint===fingerprint;
      const merged=suppressed?{...last.observations,...observations}:observations;
      record('scheduled_channel_notice_work',work.id,{suppressed,text,fingerprint,scope:key,observations:merged},work.channelId,work.targetPrincipalId);
      if(suppressed) record('scheduled_channel_notice',key,{fingerprint,observations:merged,workId:work.id,recordedAt:new Date().toISOString()},work.channelId,work.targetPrincipalId);
      return suppressed;
    },
    delivered(work: WorkRecord) {
      const saved=decision(work.id);
      if (!saved) return;
      const value=JSON.parse(saved.payload) as Decision;
      if (value.suppressed) return;
      if ((previous(value.scope)?.sequence??0)>saved.sequence) return;
      record('scheduled_channel_notice',value.scope,{fingerprint:value.fingerprint,observations:value.observations,workId:work.id,recordedAt:new Date().toISOString()},work.channelId,work.targetPrincipalId);
    },
  };
}
