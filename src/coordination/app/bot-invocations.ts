import { createHash } from 'node:crypto';
import type { CoordinationTurnOrigin } from '../../agent/types.js';
import type { M11Database } from '../work/types.js';
import type { createWorkService } from '../work/service.js';
import type { createLeaseService } from '../leases/service.js';
import { generateCoordinationId } from '../ids/index.js';
import { canonicalJson } from '../work/canonical.js';
import type { DetachmentCredential } from './foreground-detachments.js';
import type { CoordinationMessageSubmissionPort } from './types.js';
import type { MessagingActorContext } from '../channels/types.js';
import type { createChannelService } from '../channels/service.js';

type Invocation = { origin: CoordinationTurnOrigin; invocationId: string; botId: string; prompt: string; channelId: string; messageId: string };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
export function botInvocationMessageId(workId: string, invocationId: string): string {
  const suffix = createHash('sha256').update(`bot-invocation:${workId}:${invocationId}`).digest('hex').slice(0, 12);
  return `msg_${workId.slice(4, -12)}${suffix}`;
}

/** Read delivery evidence from canonical messages, never from a worker's self-report. */
export function botDeliveryEvidence(db: M11Database, parentWorkId: string) {
  return db.readAll<{ invocationId: string; requestedBotId: string; requestedChannelId: string;
    workId: string; state: string; messageId: string | null; authorPrincipalId: string | null;
    authorDisplayName: string | null; channelId: string | null; channelTitle: string | null; text: string | null }>(`
    SELECT json_extract(e.payload_json, '$.invocationId') AS invocationId,
      json_extract(e.payload_json, '$.botId') AS requestedBotId,
      json_extract(e.payload_json, '$.channelId') AS requestedChannelId,
      w.id AS workId, w.state, m.id AS messageId, m.author_principal_id AS authorPrincipalId,
      m.author_display_name AS authorDisplayName, m.channel_id AS channelId, c.title AS channelTitle,
      m.body_text AS text
    FROM events e JOIN works w ON w.origin_message_id = e.aggregate_id
      AND w.channel_id = json_extract(e.payload_json, '$.channelId')
      AND w.target_principal_id = json_extract(e.payload_json, '$.botId')
    LEFT JOIN messages m ON m.work_id = w.id AND m.kind = 'result'
    LEFT JOIN channels c ON c.id = m.channel_id
    WHERE e.aggregate_kind = 'bot_invocation' AND e.aggregate_version = 1
      AND json_extract(e.payload_json, '$.origin.workId') = ? ORDER BY e.sequence, w.created_at`, parentWorkId)
    .map(row => ({ ...row, verifiedDelivery: row.state === 'succeeded' && row.messageId !== null
      && row.authorPrincipalId === row.requestedBotId && row.channelId === row.requestedChannelId }));
}

/** The canonical event journal is the durable parent/child admission record.
 * Child Works are joined through their immutable origin Message, not a memory-only callback. */
export function createBotInvocationService(options: {
  database: M11Database; work: ReturnType<typeof createWorkService>; leases: ReturnType<typeof createLeaseService>;
  channels: ReturnType<typeof createChannelService>; submit: CoordinationMessageSubmissionPort;
  authorize(credential: DetachmentCredential, origin: CoordinationTurnOrigin): unknown;
  currentCredential(credential: DetachmentCredential, origin: CoordinationTurnOrigin): boolean;
  context(origin: CoordinationTurnOrigin): MessagingActorContext;
  stopChild(workId: string): Promise<void>;
  beginWork?(): () => void;
}) {
  const db = options.database;
  const pending = new Map<string, Promise<void>>();
  let reconciling = false;
  // Walk admission events in small pages. A restart starts at the beginning;
  // each full pass revisits still-active invocations as parent/child state changes.
  let reconcileAfterSequence = 0;
  const RECONCILE_BATCH_SIZE = 32;
  const RECONCILE_SEQUENCE_WINDOW = 4096;
  const journal = (messageId: string) => db.readOne<{ payload: string }>(
    "SELECT payload_json AS payload FROM events WHERE aggregate_kind = 'bot_invocation' AND aggregate_id = ? AND aggregate_version = 1", messageId);
  function record(invocation: Invocation, version: number, extra: Record<string, unknown> = {}) {
    db.mutateWithEvent(() => ({ value: undefined, event: {
      type: 'activity.updated', aggregateKind: 'bot_invocation', aggregateId: invocation.messageId,
      aggregateVersion: version, channelId: invocation.origin.channelId,
      actorPrincipalId: invocation.origin.holderPrincipalId,
      requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation'),
      payload: JSON.parse(JSON.stringify({ ...invocation, ...extra })), createdAt: new Date().toISOString(),
    } }));
  }
  function children(invocation: Invocation) {
    return db.readAll<{ id: string; state: string; text: string | null; messageId: string | null }>(
      `SELECT w.id, w.state, m.body_text AS text, m.id AS messageId FROM works w
       LEFT JOIN messages m ON m.work_id = w.id AND m.kind = 'result'
       WHERE w.origin_message_id = ? AND w.channel_id = ? AND w.target_principal_id = ? ORDER BY w.created_at`,
      invocation.messageId, invocation.channelId, invocation.botId);
  }
  function journalTerminal(invocation: Invocation) {
    return db.readOne("SELECT sequence FROM events WHERE aggregate_kind = 'bot_invocation' AND aggregate_id = ? AND aggregate_version = 2", invocation.messageId);
  }
  function status(invocation: Invocation) {
    const failure = db.readOne<{ payload: string }>(
      "SELECT payload_json AS payload FROM events WHERE aggregate_kind = 'bot_invocation' AND aggregate_id = ? AND aggregate_version = 2", invocation.messageId);
    const rows = children(invocation);
    if (rows.length && rows.every(row => TERMINAL.has(row.state))) {
      if (rows.some(row => row.state !== 'succeeded')) return { state: rows.some(row => row.state === 'cancelled') ? 'cancelled' : 'failed', error: 'The helper did not complete its assignment.', childWorkIds: rows.map(row => row.id) };
      // Terminal Work may precede its canonical Message commit. Keep waiting.
      if (rows.every(row => row.messageId !== null)) {
        const deliveries = botDeliveryEvidence(db, invocation.origin.workId).filter(row => row.invocationId === invocation.invocationId);
        if (deliveries.length !== rows.length || deliveries.some(row => !row.verifiedDelivery))
          return { state: 'failed', error: 'Canonical helper result author or channel does not match the invocation.', deliveries };
        return { state: 'succeeded', text: rows.map(row => row.text ?? '').join('\n\n'), childWorkIds: rows.map(row => row.id), deliveries };
      }
    }
    if (!rows.length && failure) { const outcome = JSON.parse(failure.payload); return { state: outcome.state === 'cancelled' ? 'cancelled' : 'failed', error: String(outcome.error ?? 'Helper admission failed') }; }
    return { state: 'running', childWorkIds: rows.map(row => row.id) };
  }
  function dispatch(invocation: Invocation) {
    if (pending.has(invocation.messageId) || children(invocation).length || TERMINAL.has(status(invocation).state)) return;
    const endWork = options.beginWork?.();
    const promise = (async () => {
      const parent = options.work.get(invocation.origin.workId);
      if (!parent || parent.state !== 'running') throw new Error('Parent Work is no longer running');
      const submitted = await options.submit.submitMessage({ context: options.context(invocation.origin), channelId: invocation.channelId,
        idempotencyKey: `bot-invoke:${invocation.messageId}`, body: {
          messageId: invocation.messageId, clientMessageId: invocation.messageId, text: invocation.prompt,
          attachmentIds: [], mentions: [invocation.botId], replyToMessageId: null,
          modelAlias: null, reasoningEffort: null,
        } });
      // Observe execution rejection; canonical Work/result remains the source of truth.
      void submitted.response?.catch(() => undefined);
    })().catch(error => {
      if (['turn_in_progress','server_busy','deadline_exceeded','connection_lost','request_rate_limited'].includes(String(error?.code))) return;
      if (!db.readOne("SELECT sequence FROM events WHERE aggregate_kind = 'bot_invocation' AND aggregate_id = ? AND aggregate_version = 2", invocation.messageId))
        record(invocation, 2, { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { pending.delete(invocation.messageId); endWork?.(); });
    pending.set(invocation.messageId, promise);
  }
  async function stop(invocation: Invocation) {
    // Settle in-flight admission before deciding whether cancellation has no child.
    await pending.get(invocation.messageId);
    if (!children(invocation).length && !journalTerminal(invocation)) record(invocation, 2, { state: 'cancelled', error: 'Parent cancelled before helper admission' });
    for (const row of children(invocation)) {
      if (TERMINAL.has(row.state)) continue;
      if (row.state === 'queued') {
        options.work.cancelQueued({ workId: row.id, actorPrincipalId: invocation.origin.holderPrincipalId,
          reasonCode: 'parent_cancelled', sourceReference: `work:${invocation.origin.workId}`, timestamp: new Date().toISOString(),
          requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') });
      } else {
        const current = options.leases.current(row.id);
        const binding = { workId: row.id, attemptId: current.attempt.id,
          leaseId: current.lease.id, holderPrincipalId: current.attempt.holderPrincipalId,
          holderInstanceId: current.attempt.holderInstanceId, fencingToken: current.attempt.fencingToken,
          reasonCode: 'parent_cancelled', requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') };
        if (current.work.state === 'running') options.leases.revoke(binding);
        else if (current.work.state === 'leased') {
          if (current.attempt.state === 'offered') options.leases.reject(binding);
          else if (current.attempt.state === 'accepted') options.leases.expire(binding);
          options.work.cancelQueued({ workId: row.id, actorPrincipalId: invocation.origin.holderPrincipalId,
            reasonCode: 'parent_cancelled', sourceReference: `work:${invocation.origin.workId}`, timestamp: new Date().toISOString(),
            requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') });
        }
        await options.stopChild(row.id);
      }
    }
  }
  return {
    async call(credential: DetachmentCredential, input: { origin: CoordinationTurnOrigin; invocationId: string; args: Record<string, unknown> }) {
      if (!options.currentCredential(credential, input.origin)) throw new Error('Current executive credential required');
      const messageId = botInvocationMessageId(input.origin.workId, input.invocationId);
      const prior = journal(messageId);
      let invocation: Invocation;
      if (prior) {
        invocation = JSON.parse(prior.payload);
        if (canonicalJson(invocation.origin) !== canonicalJson(input.origin) || invocation.invocationId !== input.invocationId)
          throw new Error('Bot invocation lineage differs');
      } else {
        if (input.args.operation !== 'bot_invoke') throw new Error('Bot invocation has not been admitted');
        options.authorize(credential, input.origin);
        const { botId, prompt } = input.args;
        if (typeof botId !== 'string' || botId === input.origin.holderPrincipalId || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000)
          throw new Error('Bot invocation requires an exact other Bot and bounded prompt');
        // Joining an ancestor would wait on a turn which is already waiting on us.
        let ancestorWork = input.origin.workId;
        const seen = new Set<string>();
        while (!seen.has(ancestorWork)) {
          seen.add(ancestorWork);
          const row = db.readOne<{originMessageId:string}>("SELECT origin_message_id AS originMessageId FROM works WHERE id=?",ancestorWork);
          const parent = row?.originMessageId ? journal(row.originMessageId) : undefined;
          if (!parent) break;
          const lineage = JSON.parse(parent.payload) as Invocation;
          if (lineage.origin.holderPrincipalId === botId) throw new Error('This agent is already waiting in the assignment chain. Return the result to it instead of creating a circular assignment.');
          ancestorWork = lineage.origin.workId;
        }
        const channelId = typeof input.args.channelId === 'string' ? input.args.channelId : input.origin.channelId;
        const channel = await options.channels.getChannel({ context: options.context(input.origin), channelId });
        if (channel.kind !== 'group' || channel.lifecycle !== 'active' || !channel.members.some(member => member.principalId === botId))
          throw new Error('The selected helper must belong to an active shared topic channel');
        invocation = { origin: input.origin, invocationId: input.invocationId, botId, prompt, channelId, messageId };
        try { record(invocation, 1); }
        catch (error) {
          const concurrent = journal(messageId);
          if (!concurrent || canonicalJson(JSON.parse(concurrent.payload)) !== canonicalJson(invocation)) throw error;
        }
      }
      if (input.args.operation === 'bot_invoke') {
        options.authorize(credential, input.origin);
        if (input.args.botId !== invocation.botId || input.args.prompt !== invocation.prompt ||
          (input.args.channelId !== undefined && input.args.channelId !== invocation.channelId)) throw new Error('Bot invocation replay changed');
        dispatch(invocation);
      } else if (input.args.operation === 'bot_stop') await stop(invocation);
      else if (input.args.operation !== 'bot_result') throw new Error('Unknown Bot invocation operation');
      return status(invocation);
    },
    async reconcile() {
      if (reconciling) return;
      reconciling = true;
      try {
      const journalEnd = db.readOne<{ sequence: number }>('SELECT coalesce(max(sequence), 0) AS sequence FROM events')!.sequence;
      const windowEnd = Math.min(reconcileAfterSequence + RECONCILE_SEQUENCE_WINDOW, journalEnd);
      // Admission records use activity.updated. The type/sequence index bounds
      // recovery to this journal window without reading every event data page.
      const active = db.readAll<{ sequence: number; payload: string }>(`SELECT e.sequence AS sequence, e.payload_json AS payload FROM events e INDEXED BY events_type_sequence
        JOIN works w ON w.id = json_extract(e.payload_json, '$.origin.workId')
        WHERE e.type = 'activity.updated' AND e.aggregate_kind = 'bot_invocation' AND e.aggregate_version = 1
          AND e.sequence > ? AND e.sequence <= ?
          AND (w.state IN ('running','cancelling') OR (w.state IN ('succeeded','failed','cancelled') AND EXISTS
            (SELECT 1 FROM works child WHERE child.origin_message_id = e.aggregate_id AND child.state NOT IN ('succeeded','failed','cancelled'))))
        ORDER BY e.sequence LIMIT ?`, reconcileAfterSequence, windowEnd, RECONCILE_BATCH_SIZE);
      for (const row of active) {
        const invocation = JSON.parse(row.payload) as Invocation;
        if (TERMINAL.has(status(invocation).state)) continue;
        const parent = options.work.get(invocation.origin.workId);
        if (parent?.state === 'running') dispatch(invocation);
        else await stop(invocation);
      }
      const through = active.length === RECONCILE_BATCH_SIZE ? active.at(-1)!.sequence : windowEnd;
      reconcileAfterSequence = through >= journalEnd ? 0 : through;
      } finally { reconciling = false; }
    },
  };
}
