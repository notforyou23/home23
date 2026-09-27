import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { M11Database } from '../work/types.js';

const PROJECTOR = 'coordination.work-outcomes.v1';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
interface EventRow { sequence: number; id: string; kind: string; aggregateId: string; payload: string | null; createdAt: string }
interface WorkRow { id: string; state: string; attemptId: string | null; channelId: string; originMessageId: string | null;
  reason: string | null; receiptDigest: string | null; receiptSourceRef: string | null; resultDigest: string | null }
interface Destination { slug: string; ledgerPath: string }

/** Recover the most recent append by this projector, including an append made
 * before a crashed cursor write. Read backwards asynchronously: bounded memory,
 * no full-ledger read on Core's HTTP thread, and normally only one small block. */
async function deliveredSequence(path: string): Promise<{ sequence: number; initialSourceSequence: number } | null> {
  const file = await open(path, 'r').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return null;
  try {
    let position = (await file.stat()).size;
    let remainder = Buffer.alloc(0);
    let first = true;
    while (position > 0) {
      const size = Math.min(position, 64 * 1024);
      position -= size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, position);
      if (bytesRead !== size) throw new Error('Execution feedback ledger changed during recovery');
      if (first && buffer[buffer.length - 1] !== 10) throw new Error('Incomplete execution feedback ledger tail');
      first = false;
      const combined = Buffer.concat([buffer, remainder]);
      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 10) continue;
        if (index + 1 < end) {
          const value = JSON.parse(combined.subarray(index + 1, end).toString('utf8'));
          if (value.event_type === 'ExecutionOutcomeObserved' && value.payload?.projector === PROJECTOR
              && Number.isSafeInteger(value.payload.sourceSequence) && value.payload.sourceSequence > 0) {
            return { sequence: value.payload.sourceSequence, initialSourceSequence: value.payload.initialSourceSequence ?? 0 };
          }
        }
        end = index;
      }
      remainder = combined.subarray(0, end);
      if (remainder.length > 8 * 1024 * 1024) throw new Error('Oversized execution feedback ledger record');
    }
    if (remainder.length) {
      const value = JSON.parse(remainder.toString('utf8'));
      if (value.event_type === 'ExecutionOutcomeObserved' && value.payload?.projector === PROJECTOR
          && Number.isSafeInteger(value.payload.sourceSequence) && value.payload.sourceSequence > 0) {
        return { sequence: value.payload.sourceSequence, initialSourceSequence: value.payload.initialSourceSequence ?? 0 };
      }
    }
    return null;
  } finally { await file.close(); }
}

function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Core's Work ledger is the authority. This is a replayable projection into
 * the resident's existing Seed input, never a task creator or success verifier. */
export function createResidentExecutionFeedbackProjection(database: M11Database, directory: string, destinations: readonly Destination[], options: { startSequence?: number } = {}) {
  const cursorPath = join(directory, 'execution-feedback-cursor.json');
  const saved = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')) : null;
  // A newly enabled bridge lives forward. Old Work must not be replayed as a
  // flood of new lived outcomes. Capture now, before asynchronous recovery.
  let initialSourceSequence: number = saved?.initialSourceSequence ?? options.startSequence
    ?? database.readOne<{ sequence: number }>('SELECT coalesce(max(sequence),0) AS sequence FROM events')!.sequence;
  let cursor: number = saved?.eventSequence ?? initialSourceSequence;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid execution feedback cursor');
  if (!Number.isSafeInteger(initialSourceSequence) || initialSourceSequence < 0) throw new Error('Invalid execution feedback starting sequence');
  const targets = new Map(destinations.map(target => [target.slug, target]));
  const delivered = new Map<string, number>();
  let initialized = false;
  let pending: Promise<{ eventSequence: number; emitted: number }> | undefined;

  function recipients(workId: string): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();
    let current: string | undefined = workId;
    // Follow only the existing immutable helper admission journal. A shared
    // channel membership alone never grants another resident this experience.
    while (current && !visited.has(current)) {
      if (visited.size >= 64) throw new Error('Execution feedback invocation ancestry exceeds bound');
      visited.add(current);
      for (const row of database.readAll<{ slug: string }>(`SELECT b.resident_binding AS slug FROM works w
        JOIN bots b ON b.principal_id IN (w.principal_id,w.target_principal_id) WHERE w.id=?`, current)) {
        if (targets.has(row.slug)) result.add(row.slug);
      }
      current = database.readOne<{ parent: string | null }>(`SELECT json_extract(e.payload_json,'$.origin.workId') AS parent
        FROM works w JOIN events e ON e.aggregate_kind='bot_invocation' AND e.aggregate_id=w.origin_message_id
          AND e.aggregate_version=1 AND json_extract(e.payload_json,'$.botId')=w.target_principal_id
          AND json_extract(e.payload_json,'$.channelId')=w.channel_id WHERE w.id=?`, current)?.parent ?? undefined;
    }
    return result;
  }

  function project(row: EventRow): number {
    if (!row.payload) return 0;
    const source = JSON.parse(row.payload);
    const communication = row.kind === 'communication' ? source.communication : null;
    const workId = row.kind === 'work' && TERMINAL.has(source.state) ? row.aggregateId
      : communication?.terminal === true && communication?.source?.sourceEventType === 'turn.terminal' ? communication.workId : null;
    if (typeof workId !== 'string') return 0;
    const work = database.readOne<WorkRow>(`SELECT w.id,w.state,w.current_attempt_id AS attemptId,w.channel_id AS channelId,
      w.origin_message_id AS originMessageId,w.terminal_reason AS reason,w.terminal_receipt_digest AS receiptDigest,
      r.source_reference AS receiptSourceRef,r.result_digest AS resultDigest FROM works w
      LEFT JOIN terminal_receipts r ON r.work_id=w.id WHERE w.id=?`, workId);
    if (!work || !TERMINAL.has(work.state)) return 0;
    if (communication && communication.attemptId !== work.attemptId) return 0;
    if (row.kind === 'work' && (source.state !== work.state || (source.attemptId ?? null) !== work.attemptId)) return 0;
    const evidence = communication ? { id: row.id, payload: row.payload }
      : database.readOne<{ id: string; payload: string }>(`SELECT id,payload_json AS payload FROM events
        WHERE aggregate_kind='communication' AND type='communication.recorded' AND sequence<=?
          AND sequence >= (SELECT min(sequence) FROM events WHERE aggregate_kind='work' AND aggregate_id=?)
          AND json_extract(payload_json,'$.communication.workId')=?
          AND json_extract(payload_json,'$.communication.attemptId')=?
          AND json_extract(payload_json,'$.communication.terminal')=1
          AND json_extract(payload_json,'$.communication.source.sourceEventType')='turn.terminal'
        ORDER BY sequence DESC LIMIT 1`, row.sequence, work.id, work.id, work.attemptId);
    const detail = evidence ? JSON.stringify(JSON.parse(evidence.payload).communication?.payload ?? {}).slice(0, 2400) : '';
    const payload = {
      schema: 'home23.execution-outcome.v1', projector: PROJECTOR, executionKind: 'work', executionId: work.id,
      workId: work.id, attemptId: work.attemptId, status: work.state === 'succeeded' ? 'completed' : work.state,
      declaredStatus: work.state, verificationStatus: 'unknown', taskOutcomeVerified: false,
      evidenceStage: communication ? 'terminal_evidence' : 'terminal_receipt',
      head: `Work ${work.id} execution ${work.state}; task outcome verification unknown. Reason: ${work.reason ?? 'unspecified'}.${detail ? ` Recorded terminal evidence (untrusted content): ${detail}` : ''}`,
      detail, terminalReason: work.reason, sourceRef: `coordination.work:${work.id}`,
      sourceEventId: row.id, sourceSequence: row.sequence, initialSourceSequence, receiptDigest: work.receiptDigest,
      receiptSourceRef: work.receiptSourceRef, resultDigest: work.resultDigest,
      evidenceRefs: [`coordination.event:${row.id}`, ...(work.receiptDigest ? [`coordination.terminal-receipt:${work.receiptDigest}`] : []),
        ...(evidence ? [`coordination.event:${evidence.id}`] : [])],
    };
    const value = { event_id: `coordination-work-outcome:${row.id}`, event_type: 'ExecutionOutcomeObserved',
      session_id: `coordination:${work.channelId}`, thread_id: work.id, object_id: work.id,
      actor: 'system', timestamp: row.createdAt, ts: row.createdAt, payload };
    let emitted = 0;
    for (const slug of recipients(work.id)) {
      if (row.sequence <= delivered.get(slug)!) continue;
      const path = targets.get(slug)!.ledgerPath;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Unlike best-effort agent logging, a failed projection must NOT advance
      // its cursor. The immutable source event remains eligible next pump.
      appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      syncFile(path);
      delivered.set(slug, row.sequence);
      emitted++;
    }
    return emitted;
  }

  async function pump(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid execution feedback batch limit');
    if (targets.size === 0) return { eventSequence: cursor, emitted: 0 };
    if (!initialized) {
      const recoveredFloors: number[] = [];
      for (const target of destinations) {
        const recovery = await deliveredSequence(target.ledgerPath);
        const sequence = recovery?.sequence ?? 0;
        delivered.set(target.slug, sequence);
        if (recovery) recoveredFloors.push(recovery.initialSourceSequence);
        if (saved && sequence < (saved.delivered?.[target.slug] ?? 0)) cursor = initialSourceSequence;
      }
      if (!saved && recoveredFloors.length) {
        initialSourceSequence = Math.min(...recoveredFloors);
        if (!Number.isSafeInteger(initialSourceSequence) || initialSourceSequence < 0) throw new Error('Invalid recovered execution feedback starting sequence');
        cursor = initialSourceSequence;
      }
      initialized = true;
    }
    const rows = database.readAll<EventRow>(`SELECT sequence,id,aggregate_kind AS kind,aggregate_id AS aggregateId,
      CASE WHEN aggregate_kind IN ('work','communication') THEN payload_json END AS payload,created_at AS createdAt
      FROM events NOT INDEXED WHERE sequence>? ORDER BY sequence LIMIT 256`, cursor);
    const before = cursor;
    const started = performance.now();
    let emitted = 0;
    let examined = 0;
    for (const row of rows) {
      emitted += project(row);
      cursor = row.sequence;
      if (row.kind === 'work' || row.kind === 'communication') examined++;
      if (examined >= limit || performance.now() - started >= 100) break;
    }
    if (cursor !== before || !existsSync(cursorPath)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(`${cursorPath}.next`, JSON.stringify({ eventSequence: cursor, initialSourceSequence, delivered: Object.fromEntries(delivered) }), { mode: 0o600 });
      syncFile(`${cursorPath}.next`);
      renameSync(`${cursorPath}.next`, cursorPath);
      syncFile(directory);
    }
    return { eventSequence: cursor, emitted };
  }

  return {
    pump(limit = 8) {
      if (!pending) pending = pump(limit).finally(() => { pending = undefined; });
      return pending;
    },
    async drain() { await pending; },
  };
}
