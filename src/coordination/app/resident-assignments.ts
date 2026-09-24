import type { CoordinationTurnOrigin } from '../../agent/types.js';
import type { MessagingActorContext } from '../channels/types.js';
import type { M11Database } from '../work/types.js';
import { canonicalJson } from '../work/canonical.js';
import { WorkError } from '../work/errors.js';

export type AssignmentState = 'active' | 'blocked' | 'complete' | 'cancelled';
export interface AssignmentConclusion {
  workId: string; state: AssignmentState; summary: string; evidence: string[];
  waitFor: string[]; revisitAt: string | null; invocationKey: string; recordedAt: string;
  observedOwnerMessageSequence?: number;
}

/** Shared assignment conclusions live in Core's existing event journal. They
 * are distinct from execution terminal state and from the resident's private
 * Seed/development. A delivered explanation does not close an assignment. */
export function createResidentAssignments(database: M11Database) {
  const hasOutcomeStore = !!database.readOne("SELECT name FROM sqlite_master WHERE type='table' AND name='resident_outcomes'");
  function root(workId: string): string {
    const seen = new Set<string>();
    let current = workId;
    for (let depth = 0; depth < 64; depth++) {
      if (seen.has(current)) throw new Error('Assignment lineage cycle');
      seen.add(current);
      const review = hasOutcomeStore ? database.readOne<{ source: string }>('SELECT source_work_id AS source FROM resident_outcomes WHERE review_work_id=?', current) : undefined;
      if (review) { current = review.source; continue; }
      const parent = database.readOne<{ id: string }>('SELECT parent_work_id AS id FROM work_planned_invocations WHERE work_id=?', current);
      if (!parent) return current;
      const upstream = hasOutcomeStore ? database.readOne<{ source: string }>('SELECT source_work_id AS source FROM resident_outcomes WHERE review_work_id=?', parent.id) : undefined;
      if (upstream) { current = upstream.source; continue; }
      if (database.readOne('SELECT work_id FROM work_planned_invocations WHERE work_id=?', parent.id)) { current = parent.id; continue; }
      return current;
    }
    throw new Error('Assignment lineage exceeds supported depth');
  }
  function latest(workId: string): (AssignmentConclusion & { eventSequence: number }) | null {
    const record = database.readOne<{ payload: string; sequence: number }>(`SELECT payload_json AS payload,sequence FROM events
      WHERE aggregate_kind='resident_assignment' AND aggregate_id=? ORDER BY aggregate_version DESC LIMIT 1`, root(workId));
    return record ? { ...JSON.parse(record.payload), eventSequence: record.sequence } : null;
  }
  function presentationState(workId: string, executionState: string, conclusion = latest(workId)): string {
    if (conclusion && conclusion.state !== 'blocked') return conclusion.state;
    const outcome = hasOutcomeStore && database.readOne<{ key: string; reviewState: string | null; settledAt: string | null }>(`SELECT o.outcome_key AS key,review.state AS reviewState,o.settled_at AS settledAt FROM resident_outcomes o
      LEFT JOIN works review ON review.id=o.review_work_id
      WHERE o.source_work_id=?
      ORDER BY CASE WHEN o.settled_at IS NULL AND review.state IN ('queued','leased','running','cancelling') THEN 0 ELSE 1 END,
        o.created_at DESC,o.outcome_key DESC
      LIMIT 1`, workId);
    // An admitted resident follow-through is still doing the assignment. Its
    // execution is separate from the helper that already returned a result;
    // it is not an owner-facing request for attention or proof of completion.
    const reviewing = outcome && outcome.settledAt === null && outcome.reviewState !== null
      && ['queued','leased','running','cancelling'].includes(outcome.reviewState);
    if (conclusion) {
      const revisitKey = `assignment-revisit:${conclusion.workId}:${conclusion.eventSequence}`;
      return reviewing && (outcome.key === revisitKey || outcome.key.startsWith(`${revisitKey}:assessment-retry:`))
        ? 'active' : conclusion.state;
    }
    if (executionState === 'cancelled' || executionState === 'failed') return executionState;
    if (executionState !== 'succeeded' || reviewing) return 'active';
    // A result already delivered in the owning chat remains delivered when
    // background follow-through fails. This does not assess or close the assignment.
    if (outcome && database.readOne(`SELECT m.id FROM messages m JOIN works w ON w.id=?
      WHERE m.work_id=w.id AND m.channel_id=w.channel_id AND m.author_principal_id=w.target_principal_id
        AND m.kind='result' AND m.stored_visibility='visible'
        AND NOT EXISTS(SELECT 1 FROM messages tombstone WHERE tombstone.tombstones_message_id=m.id)
      LIMIT 1`, workId)) return 'returned';
    // Settlement confirms delivery of the review, not its assessed outcome.
    if (outcome && outcome.settledAt !== null && outcome.reviewState === 'succeeded') return 'returned';
    // Preserve ordinary completed executions that never required follow-through.
    return outcome ? 'needs_review' : 'complete';
  }
  function assertOpen(workId: string) {
    const conclusion = latest(workId);
    if (conclusion && conclusion.state !== 'active') throw new Error(`Assignment is ${conclusion.state}; assess the current direction with work_report_outcome before another launch`);
    const stopped = database.readOne<{ state: string; sequence: number }>(`SELECT w.state,
      (SELECT coalesce(max(sequence),0) FROM events WHERE aggregate_kind='work' AND aggregate_id=w.id) AS sequence
      FROM works w WHERE w.id=?`, root(workId));
    if (stopped?.state === 'cancelled' && (!conclusion || stopped.sequence > conclusion.eventSequence)) throw new Error('Assignment was cancelled; a late result cannot restart it');
  }
  function direction(workId: string) {
    const row = database.readOne<{ prepared: number; current: number }>(`SELECT c.channel_watermark AS prepared,
      coalesce((SELECT max(m.channel_sequence) FROM messages m WHERE m.channel_id=w.channel_id
        AND m.author_kind='owner' AND m.kind='text' AND m.stored_visibility='visible'
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.aggregate_kind='scheduled_channel_run'
          AND e.aggregate_version=1 AND json_extract(e.payload_json,'$.messageId')=m.id)),0) AS current
      FROM works w JOIN context_manifests c ON c.id=w.context_manifest_id WHERE w.id=?`, workId);
    if (!row) throw new Error('Work context unavailable');
    const acknowledged = database.readOne<{ sequence: number }>(`SELECT max(CAST(json_extract(payload_json,'$.ownerMessageSequence') AS INTEGER)) AS sequence
      FROM events WHERE aggregate_kind='resident_assignment' AND (json_extract(payload_json,'$.originWorkId')=?
        OR (json_extract(payload_json,'$.originWorkId')=(SELECT parent_work_id FROM work_planned_invocations WHERE work_id=?)
          AND sequence < (SELECT min(sequence) FROM events WHERE aggregate_kind='work' AND aggregate_id=?)))`, workId, workId, workId)?.sequence ?? 0;
    return { ownerMessageSequence: row.current, acknowledgedSequence: Math.max(row.prepared, acknowledged) };
  }
  function report(context: MessagingActorContext, origin: CoordinationTurnOrigin, args: Record<string, unknown>, invocationKey: string) {
    const invalid = (message: string): never => { throw new WorkError('invalid_request', message); };
    const requestedWorkId = args.work_id;
    if (typeof requestedWorkId !== 'string') throw new WorkError('invalid_request', 'work_id is required');
    const workId = root(requestedWorkId);
    const work = database.readOne<{ principal: string; channel: string }>('SELECT target_principal_id AS principal,channel_id AS channel FROM works WHERE id=?', workId);
    if (!work || work.principal !== context.principalId) throw new Error('Assignment is outside this resident scope');
    const state = args.state as AssignmentState;
    if (!['active','blocked','complete','cancelled'].includes(state)) invalid('state must be active, blocked, complete, or cancelled');
    const summary = args.summary;
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 4000) throw new WorkError('invalid_request', 'summary must be a non-empty string of at most 4000 characters');
    const strings = (field: string, value: unknown, maximum: number): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 4096)) {
        invalid(`${field} must be an array of at most ${maximum} non-empty strings`);
      }
      return [...new Set(value as string[])];
    };
    const evidence = strings('evidence', args.evidence, 16), waitFor = strings('wait_for', args.wait_for, 16);
    if (state === 'complete' && !evidence.length) invalid('Completion requires inspected evidence references');
    for (const id of waitFor) {
      const dependency = database.readOne<{ principal: string }>('SELECT target_principal_id AS principal FROM works WHERE id=?', id);
      if (!dependency || dependency.principal !== context.principalId || root(id) === workId) throw new Error('Dependency must be another existing assignment of this resident');
    }
    const revisitAt = args.revisit_at === undefined || args.revisit_at === null ||
      (typeof args.revisit_at === 'string' && !args.revisit_at.trim())
      ? null
      : typeof args.revisit_at === 'string' ? args.revisit_at : invalid('revisit_at must be an ISO timestamp when provided');
    if (revisitAt !== null && (!Number.isFinite(Date.parse(revisitAt)) || new Date(revisitAt).toISOString() !== revisitAt)) invalid('revisit_at must be an ISO timestamp when provided');
    if (args.owner_message_sequence !== undefined && (typeof args.owner_message_sequence !== 'number' || !Number.isSafeInteger(args.owner_message_sequence) || args.owner_message_sequence < 0)) invalid('owner_message_sequence must be a non-negative safe integer');
    const ownerMessageSequence = typeof args.owner_message_sequence === 'number' ? args.owner_message_sequence : null;
    const value = { workId, state, summary, evidence, waitFor, revisitAt, invocationKey, originWorkId: origin.workId, ownerMessageSequence };
    const prior = database.readOne<{ payload: string }>(`SELECT payload_json AS payload FROM events WHERE aggregate_kind='resident_assignment'
      AND json_extract(payload_json,'$.invocationKey')=?`, invocationKey);
    if (prior) {
      const { recordedAt, observedOwnerMessageSequence, ...saved } = JSON.parse(prior.payload);
      if (canonicalJson(saved) !== canonicalJson(value)) throw new Error('Assignment conclusion replay changed');
      return { ...saved, recordedAt, replayed: true };
    }
    const current = direction(origin.workId);
    if ((current.ownerMessageSequence > current.acknowledgedSequence || ownerMessageSequence !== null)
        && ownerMessageSequence !== current.ownerMessageSequence) throw new WorkError('invalid_request',
          `Read work_list and reconcile the latest owner messages; use its current top-level ownerMessageSequence (${current.ownerMessageSequence}) as owner_message_sequence, not the sequence saved in an earlier conclusion`);
    if (revisitAt !== null && Date.parse(revisitAt) <= Date.now()) invalid('revisit_at must be in the future');
    if (state !== 'blocked' && (waitFor.length || revisitAt !== null)) invalid('Revisit conditions belong to a blocked assignment');
    if (state === 'active') {
      const previous = latest(workId);
      const cancelled = database.readOne<{ sequence: number }>(`SELECT max(e.sequence) AS sequence FROM works w JOIN events e
        ON e.aggregate_kind='work' AND e.aggregate_id=w.id WHERE w.id=? AND w.state='cancelled'`, workId)?.sequence;
      if (previous?.state === 'complete' || previous?.state === 'cancelled' || cancelled) {
        const freshRequest = database.readOne(`SELECT m.id FROM works w JOIN messages m ON m.id=w.origin_message_id
          JOIN events e ON e.aggregate_kind='message' AND e.aggregate_id=m.id AND e.aggregate_version=1
          WHERE w.id=? AND w.channel_id=? AND w.kind IN ('resident_turn','channel.bot_turn')
            AND m.author_kind='owner' AND m.kind='text' AND m.stored_visibility='visible'
            AND e.sequence>? AND NOT EXISTS(SELECT 1 FROM resident_outcomes o WHERE o.review_work_id=w.id)
            AND NOT EXISTS(SELECT 1 FROM events s WHERE s.aggregate_kind='scheduled_channel_run' AND s.aggregate_version=1
              AND json_extract(s.payload_json,'$.messageId')=m.id)`, origin.workId, work.channel, Math.max(cancelled ?? 0, previous?.eventSequence ?? 0));
        if (!freshRequest) throw new Error('Reopening a stopped or completed assignment requires a newer canonical owner request; a late result is insufficient');
      }
    }
    if (state === 'complete') {
      for (const active of database.readAll<{ id: string }>(`SELECT id FROM works WHERE target_principal_id=? AND id<>?
        AND kind='resident_work_thread' AND state IN ('queued','leased','running','cancelling')`, context.principalId, origin.workId)) {
        if (root(active.id) === workId) throw new Error('Assignment still has an active execution');
      }
    }
    const recordedAt = new Date().toISOString();
    database.mutateWithEvent(tx => ({ value: undefined, event: { type: 'activity.updated', aggregateKind: 'resident_assignment',
      aggregateId: workId, aggregateVersion: (tx.readOne<{ version: number }>("SELECT coalesce(max(aggregate_version),0) AS version FROM events WHERE aggregate_kind='resident_assignment' AND aggregate_id=?", workId)?.version ?? 0) + 1,
      channelId: work.channel, actorPrincipalId: context.principalId, requestId: context.requestId,
      correlationId: context.correlationId, payload: { ...value, recordedAt, observedOwnerMessageSequence: current.ownerMessageSequence }, createdAt: recordedAt } }));
    return { ...value, recordedAt, replayed: false };
  }
  function list(principalId: string, includeClosed = false, limit = 20) {
    const works = database.readAll<{ id: string }>(`SELECT w.id FROM works w
      LEFT JOIN work_thread_presentations p ON p.work_id=w.id
      WHERE w.target_principal_id=? AND (w.kind='resident_work_thread' OR p.work_id IS NOT NULL)
        AND (w.state IN ('queued','leased','running','cancelling') OR w.terminal_at >= (SELECT enabled_at FROM resident_outcome_policy WHERE id=1))
      ORDER BY w.created_at DESC LIMIT 1000`, principalId);
    const roots = [...new Set(works.map(work => root(work.id)))];
    const result = [];
    for (const id of roots) {
      const conclusion = latest(id);
      if (!includeClosed && (conclusion?.state === 'complete' || conclusion?.state === 'cancelled')) continue;
      const work = database.readOne<Record<string, unknown>>(`SELECT w.id,w.channel_id AS channelId,w.state,
        w.origin_message_id AS originMessageId,coalesce(p.title,substr(m.body_text,1,160),'Assignment') AS title,
        coalesce(p.summary,m.body_text) AS summary,m.body_text AS originalRequest,w.created_at AS createdAt,
        w.terminal_reason AS terminalReason FROM works w LEFT JOIN work_thread_presentations p ON p.work_id=w.id
        LEFT JOIN messages m ON m.id=w.origin_message_id WHERE w.id=?`, id)!;
      const assignmentState = presentationState(id, String(work.state), conclusion);
      if (!includeClosed && ['complete', 'cancelled', 'failed'].includes(assignmentState)) continue;
      result.push({ ...work, assignmentState, conclusion });
      if (result.length >= limit) break;
    }
    return result;
  }
  /** Page candidates on the indexed resident/creation order. The projector
   * yields between pages so this derived snapshot cannot block Core's API. */
  function listForProjectionPage(principalId: string, after: { createdAt: string; id: string } | null = null,
    remaining = 1000) {
    // A row-value range lets SQLite seek both ordered columns in
    // works_target_created. The OR form only constrained principal_id and
    // rescanned the resident's newer history on every subsequent page.
    const seek = after ? 'AND (w.created_at,w.id) < (?,?)' : '';
    // LIMIT must apply before the eligibility filter. A selective LIMIT over
    // all resident Work can still scan years of rows in one blocking call.
    const batch = database.readAll<{ id: string; createdAt: string; kind: string; state: string;
      terminalAt: string | null; presentedWorkId: string | null; enabledAt: string }>(`WITH batch AS MATERIALIZED (
        SELECT w.id,w.created_at AS createdAt,w.kind,w.state,w.terminal_at AS terminalAt FROM works w
        WHERE w.target_principal_id=? ${seek}
        ORDER BY w.created_at DESC,w.id DESC LIMIT 16
      ) SELECT batch.*,p.work_id AS presentedWorkId,
        (SELECT enabled_at FROM resident_outcome_policy WHERE id=1) AS enabledAt
      FROM batch LEFT JOIN work_thread_presentations p ON p.work_id=batch.id`, principalId,
      ...(after ? [after.createdAt, after.id] : []));
    batch.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const cursor = batch.length ? { createdAt: batch.at(-1)!.createdAt, id: batch.at(-1)!.id } : null;
    const candidates = batch.filter(row => (row.kind === 'resident_work_thread' || row.presentedWorkId !== null)
      && (['queued','leased','running','cancelling'].includes(row.state)
        || (row.terminalAt !== null && row.terminalAt >= row.enabledAt))).slice(0, remaining);
    if (!candidates.length) return { assignments: [] as Array<Record<string, unknown>>, cursor,
      candidateCount: 0, scannedCount: batch.length };
    const ids = JSON.stringify(candidates.map(row => row.id));
    // Follow exactly the same review/planned lineage as root(), but in one
    // recursive query. The depth and cycle guards retain root()'s limits.
    const reviewJoin = hasOutcomeStore
      ? `LEFT JOIN resident_outcomes review ON review.review_work_id=l.id
         LEFT JOIN resident_outcomes parent_review ON parent_review.review_work_id=plan.parent_work_id`
      : '';
    const next = hasOutcomeStore
      ? `coalesce(review.source_work_id,parent_review.source_work_id,
           CASE WHEN upstream.work_id IS NOT NULL THEN plan.parent_work_id END)`
      : `CASE WHEN upstream.work_id IS NOT NULL THEN plan.parent_work_id END`;
    const lineage = database.readAll<{ seed: string; id: string; depth: number; path: string; next: string | null }>(`WITH RECURSIVE
      lineage(seed,id,depth,path) AS (
        SELECT value,value,0,'|' || value || '|' FROM json_each(?)
        UNION ALL
        SELECT l.seed,${next},l.depth+1,l.path || ${next} || '|'
        FROM lineage l
        LEFT JOIN work_planned_invocations plan ON plan.work_id=l.id
        ${reviewJoin}
        LEFT JOIN work_planned_invocations upstream ON upstream.work_id=plan.parent_work_id
        WHERE l.depth<64 AND ${next} IS NOT NULL
          AND instr(l.path,'|' || ${next} || '|')=0
      ) SELECT l.seed,l.id,l.depth,l.path,${next} AS next FROM lineage l
        LEFT JOIN work_planned_invocations plan ON plan.work_id=l.id
        ${reviewJoin}
        LEFT JOIN work_planned_invocations upstream ON upstream.work_id=plan.parent_work_id`, ids);
    const final = new Map<string, typeof lineage[number]>();
    for (const row of lineage) if (!final.has(row.seed) || row.depth > final.get(row.seed)!.depth) final.set(row.seed, row);
    for (const row of final.values()) {
      if (row.next !== null) throw new Error(row.depth >= 64 ? 'Assignment lineage exceeds supported depth' : 'Assignment lineage cycle');
    }
    const roots = [...new Set(candidates.map(row => final.get(row.id)!.id))];
    const rootIds = JSON.stringify(roots);
    const workRows = database.readAll<Record<string, unknown>>(`SELECT w.id,w.channel_id AS channelId,w.state,
      w.origin_message_id AS originMessageId,coalesce(p.title,substr(m.body_text,1,160),'Assignment') AS title,
      coalesce(p.summary,m.body_text) AS summary,m.body_text AS originalRequest,w.created_at AS createdAt,
      w.terminal_reason AS terminalReason FROM works w LEFT JOIN work_thread_presentations p ON p.work_id=w.id
      LEFT JOIN messages m ON m.id=w.origin_message_id WHERE w.id IN (SELECT value FROM json_each(?))`, rootIds);
    const works = new Map(workRows.map(row => [String(row.id), row]));
    // Drive from the bounded roots. Starting at events can scan every
    // historical assignment event before filtering the current roots.
    const conclusionRows = database.readAll<{ id: string; payload: string; sequence: number }>(`SELECT roots.value AS id,e.payload_json AS payload,e.sequence
      FROM json_each(?) roots JOIN events e ON e.sequence=(
        SELECT latest.sequence FROM events latest
        WHERE latest.aggregate_kind='resident_assignment' AND latest.aggregate_id=roots.value
        ORDER BY latest.aggregate_version DESC LIMIT 1)`, rootIds);
    const conclusions = new Map(conclusionRows.map(row => [row.id,
      { ...JSON.parse(row.payload) as AssignmentConclusion, eventSequence: row.sequence }]));
    // A completed assessment determines its own presentation. Only blocked
    // assessments and unassessed successful Work can depend on an outcome.
    // On an established home most roots are already assessed, so do not run
    // the sorted outcome lookup (or delivered-message lookup) for every root.
    const outcomeIds = roots.filter(id => {
      const work = works.get(id), conclusion = conclusions.get(id);
      return work && (conclusion?.state === 'blocked' || (!conclusion && work.state === 'succeeded'));
    });
    const outcomeRows = hasOutcomeStore && outcomeIds.length ? database.readAll<{ id: string; key: string; reviewState: string | null; settledAt: string | null }>(`SELECT roots.value AS id,o.outcome_key AS key,
      review.state AS reviewState,o.settled_at AS settledAt FROM json_each(?) roots
      JOIN resident_outcomes o ON o.outcome_key=(SELECT latest.outcome_key FROM resident_outcomes latest
        LEFT JOIN works current_review ON current_review.id=latest.review_work_id
        WHERE latest.source_work_id=roots.value
        ORDER BY CASE WHEN latest.settled_at IS NULL AND current_review.state IN ('queued','leased','running','cancelling') THEN 0 ELSE 1 END,
          latest.created_at DESC,latest.outcome_key DESC LIMIT 1)
      LEFT JOIN works review ON review.id=o.review_work_id`, JSON.stringify(outcomeIds)) : [];
    const outcomes = new Map(outcomeRows.map(row => [row.id, row]));
    const deliveryIds = outcomeIds.filter(id => !conclusions.has(id) && outcomes.has(id));
    const deliveredRows = deliveryIds.length ? database.readAll<{ id: string }>(`SELECT roots.value AS id FROM json_each(?) roots
      JOIN works w ON w.id=roots.value WHERE EXISTS(
        SELECT 1 FROM messages m
        WHERE m.work_id=w.id AND m.channel_id=w.channel_id
          AND m.author_principal_id=w.target_principal_id AND m.kind='result' AND m.stored_visibility='visible'
          AND NOT EXISTS(SELECT 1 FROM messages tombstone WHERE tombstone.tombstones_message_id=m.id)
        LIMIT 1)`, JSON.stringify(deliveryIds)) : [];
    const delivered = new Set(deliveredRows.map(row => row.id));
    const assignments = roots.flatMap<Record<string, unknown>>(id => {
      const work = works.get(id);
      if (!work) return [];
      const conclusion = conclusions.get(id) ?? null;
      const outcome = outcomes.get(id);
      const reviewing = outcome && outcome.settledAt === null && outcome.reviewState !== null
        && ['queued','leased','running','cancelling'].includes(outcome.reviewState);
      let assignmentState: string;
      if (conclusion && conclusion.state !== 'blocked') assignmentState = conclusion.state;
      else if (conclusion) {
        const revisitKey = `assignment-revisit:${conclusion.workId}:${conclusion.eventSequence}`;
        assignmentState = reviewing && (outcome!.key === revisitKey || outcome!.key.startsWith(`${revisitKey}:assessment-retry:`))
          ? 'active' : conclusion.state;
      } else if (work.state === 'cancelled' || work.state === 'failed') assignmentState = String(work.state);
      else if (work.state !== 'succeeded' || reviewing) assignmentState = 'active';
      else if (outcome && (delivered.has(id) || (outcome.settledAt !== null && outcome.reviewState === 'succeeded'))) assignmentState = 'returned';
      else assignmentState = outcome ? 'needs_review' : 'complete';
      return [{ ...work, assignmentState, conclusion }];
    });
    return { assignments, cursor, candidateCount: candidates.length, scannedCount: batch.length };
  }
  function listForProjection(principalId: string) {
    const assignments: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let cursor: { createdAt: string; id: string } | null = null;
    let remaining = 1000;
    while (remaining > 0) {
      const page = listForProjectionPage(principalId, cursor, remaining);
      for (const assignment of page.assignments) {
        const id = String(assignment.id);
        if (!seen.has(id)) { seen.add(id); assignments.push(assignment); }
      }
      remaining -= page.candidateCount;
      if (page.scannedCount < 16) break;
      cursor = page.cursor;
    }
    return assignments;
  }
  // Outcome discovery asks for revisits on relevant Work or assignment events
  // and when a blocked deadline is due. Retain only latest blocked conclusions
  // instead of resolving every historical assignment on each timer tick.
  const blockedRevisits = new Map<string, AssignmentConclusion & { eventSequence: number }>();
  const revisitVersions = new Map<string, number>();
  let revisitCursor: number | null = null;
  let bootstrapAfter = '';
  let bootstrapComplete = false;
  let revisitEvaluationCursor = 0;
  let revisitSweepRemaining = 0;
  let revisitCatchupPending = false;
  function timedRevisitDue(now: number): boolean {
    if (!bootstrapComplete) return true;
    for (const value of blockedRevisits.values()) {
      if (value.revisitAt !== null && Date.parse(value.revisitAt) <= now) return true;
    }
    return false;
  }
  function hasBlockedRevisits(): boolean { return !bootstrapComplete || blockedRevisits.size > 0; }
  function revisitBootstrapIncomplete(): boolean { return !bootstrapComplete; }
  function revisitSweepPending(): boolean { return revisitSweepRemaining > 0; }
  function revisitEventCatchupPending(): boolean { return revisitCatchupPending; }
  function observeRevisitEvent(row: { id: string; sequence: number; payload: string }) {
    if ((revisitVersions.get(row.id) ?? 0) >= row.sequence) return;
    revisitVersions.set(row.id, row.sequence);
    const value = { ...JSON.parse(row.payload) as AssignmentConclusion, eventSequence: row.sequence };
    if (value.state === 'blocked') blockedRevisits.set(row.id, value);
    else blockedRevisits.delete(row.id);
  }
  function revisits(startSweep = false) {
    const journalEnd = database.readOne<{ sequence: number }>('SELECT coalesce(max(sequence),0) AS sequence FROM events')!.sequence;
    if (revisitCursor === null || journalEnd < revisitCursor) {
      blockedRevisits.clear();
      revisitVersions.clear();
      revisitCursor = journalEnd;
      bootstrapAfter = '';
      bootstrapComplete = false;
      revisitEvaluationCursor = 0;
      revisitSweepRemaining = 0;
      revisitCatchupPending = false;
    }
    if (!bootstrapComplete) {
      // The aggregate index orders each assignment's latest version first.
      // Advance by aggregate ID, skipping older versions even when a page
      // ends within one long assignment history.
      const records = database.readAll<{ id: string; sequence: number; payload: string }>(`SELECT aggregate_id AS id,sequence,payload_json AS payload FROM events
        WHERE aggregate_kind='resident_assignment' AND aggregate_id>?
        ORDER BY aggregate_id,aggregate_version DESC LIMIT 8`, bootstrapAfter);
      const seen = new Set<string>();
      for (const record of records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        observeRevisitEvent(record);
      }
      if (records.length) bootstrapAfter = records.at(-1)!.id;
      bootstrapComplete = records.length < 8;
    }
    // Limit each timer turn even if a writer appends a large burst of events.
    // A cursor advances through unrelated events as well, so it cannot get
    // stuck behind them. Any remaining records are picked up on the next tick.
    const changes = database.readAll<{ id: string; sequence: number; payload: string | null }>(`SELECT aggregate_id AS id,sequence,
      CASE WHEN aggregate_kind='resident_assignment' THEN payload_json END AS payload
      FROM events WHERE sequence>? ORDER BY sequence LIMIT 16`, revisitCursor);
    revisitCatchupPending = changes.length === 16;
    let observedAssignment = false;
    for (const change of changes) {
      if (change.payload !== null) {
        observeRevisitEvent({ ...change, payload: change.payload });
        observedAssignment = true;
      }
      revisitCursor = change.sequence;
    }
    const now = Date.now();
    const values = [...blockedRevisits.values()];
    if (startSweep || observedAssignment) revisitSweepRemaining = Math.max(revisitSweepRemaining, values.length);
    revisitSweepRemaining = Math.min(revisitSweepRemaining, values.length);
    const count = Math.min(32, values.length, revisitSweepRemaining || 32);
    const evaluation = Array.from({ length: count }, (_, index) => values[(revisitEvaluationCursor + index) % values.length]!);
    revisitEvaluationCursor = values.length ? (revisitEvaluationCursor + count) % values.length : 0;
    revisitSweepRemaining = Math.max(0, revisitSweepRemaining - count);
    const waiting = evaluation.filter(value => value.revisitAt === null || Date.parse(value.revisitAt) > now);
    const dependencyIds = [...new Set(waiting.flatMap(value => value.waitFor))];
    const dependencyRows = dependencyIds.length ? database.readAll<{ id: string; state: string }>(`SELECT id,state FROM works
      WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(dependencyIds)) : [];
    const terminal = new Set(dependencyRows.filter(row => ['succeeded','failed','cancelled'].includes(row.state)).map(row => row.id));
    return evaluation.filter(value =>
      (value.revisitAt !== null && Date.parse(value.revisitAt) <= now) ||
      (value.waitFor.length > 0 && value.waitFor.every(id => terminal.has(id))));
  }
  return { root, latest, presentationState, report, list, listForProjection, listForProjectionPage, revisits, timedRevisitDue, hasBlockedRevisits, revisitBootstrapIncomplete, revisitSweepPending, revisitEventCatchupPending, assertOpen, direction };
}
