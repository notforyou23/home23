import Database from 'better-sqlite3';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { enrichTerminalEnvelope } from '../../chat/history-projection.js';
import { isTurnEnvelope, type TurnEnvelope } from '../../chat/turn-types.js';
import { createVerifiedOnlineBackup, type VerifiedBackupReceipt } from '../db/backup.js';
import { openCoordinationDatabase, type SqliteValue } from '../db/index.js';
import { inspectCoordinationSchema } from '../db/migration-engine.js';
import { generateCoordinationId } from '../ids/index.js';
import { assertCoordinationId } from '../ids/index.js';
import { createLeaseService, type TerminalReceiptInput, type LeaseBindingInput } from '../leases/index.js';
import { canonicalJson, sha256 } from '../work/canonical.js';
import type { M11Database } from '../work/types.js';

type Reader = Pick<M11Database, 'readAll' | 'readOne'>;
type TerminalState = TerminalReceiptInput['status'];
type Evidence = { kind: 'communication' | 'resident_journal'; reference: string; digest: string };
export interface ScheduledWorkRepairItem {
  workId: string; runId: string; state: string; attemptId: string | null;
  admissionSequence: number;
  assignmentState: string | null; noticeSuppressed: boolean; resultMessageId: string | null;
  disposition: 'already_terminal' | 'repair' | 'skipped'; reason: string;
  targetState?: TerminalState; evidence?: Evidence;
}
export interface ScheduledWorkRepairReport {
  kind: 'scheduled-channel-work-repair'; mode: 'dry-run' | 'applied';
  status: 'inspected' | 'locked'; channelId: string; schemaVersion?: number;
  eventSequence?: number; items: ScheduledWorkRepairItem[]; repairIds: string[];
  appliedIds: string[]; backup?: VerifiedBackupReceipt; note: string;
}
export interface ScheduledWorkRepairInput {
  databasePath: string; channelId: string; journalPaths?: readonly string[];
  apply?: boolean; coreStopped?: boolean; backupPath?: string;
}
interface WorkRow {
  workId: string; state: string; currentAttemptId: string | null; principalId: string;
  targetPrincipalId: string; originMessageId: string; roundId: string | null;
  channelId: string; admission: string; admissionDigest: string; runId: string;
  admissionSequence: number; assignmentState: string | null; suppressed: number | null;
  resultMessageId: string | null; kind: string; idempotencyKeyDigest: string;
}
interface Execution {
  attemptId: string; leaseId: string; holderPrincipalId: string; holderInstanceId: string;
  authorityReference: string; fencingToken: number; attemptState: string; leaseState: string;
  leaseHolderPrincipalId: string; leaseHolderInstanceId: string; leaseFencingToken: number;
}
interface Planned extends ScheduledWorkRepairItem {
  binding?: Omit<LeaseBindingInput, 'requestId' | 'correlationId'>;
  receipt?: TerminalReceiptInput;
}
interface Journal { path: string; digest: string; records: unknown[] }
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const canonicalTime = (value: unknown): value is string => typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function reader(database: Database.Database): Reader {
  return {
    readOne: <T>(sql: string, ...parameters: SqliteValue[]) => database.prepare<SqliteValue[], T>(sql).get(...parameters),
    readAll: <T>(sql: string, ...parameters: SqliteValue[]) => database.prepare<SqliteValue[], T>(sql).all(...parameters),
  };
}
function readJournals(paths: readonly string[]): Journal[] {
  return [...new Set(paths.map(path => realpathSync(path)))].map(path => {
    if (!statSync(path).isFile()) throw new Error('journal must be an existing regular file');
    const source = readFileSync(path, 'utf8');
    // Malformed/truncated evidence is refused, rather than skipping a possible
    // terminal record and accepting a different one. Never print journal text.
    const records = source.split('\n').filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line) as unknown; }
      catch { throw new Error(`journal has invalid JSON at line ${index + 1}`); }
    });
    return { path, digest: sha256(source), records };
  });
}
function execution(db: Reader, row: WorkRow): Execution | undefined {
  return db.readOne<Execution>(`SELECT a.id AS attemptId,l.id AS leaseId,a.holder_principal_id AS holderPrincipalId,
    a.holder_instance_id AS holderInstanceId,a.authority_reference AS authorityReference,a.fencing_token AS fencingToken,
    a.state AS attemptState,l.state AS leaseState,l.holder_principal_id AS leaseHolderPrincipalId,
    l.holder_instance_id AS leaseHolderInstanceId,l.fencing_token AS leaseFencingToken
    FROM attempts a JOIN leases l ON l.attempt_id=a.id AND l.work_id=a.work_id
    WHERE a.id=? AND a.work_id=?`, row.currentAttemptId, row.workId);
}
function exactExecution(row: WorkRow, value: Execution | undefined): value is Execution {
  return !!value && value.attemptId === row.currentAttemptId && value.holderPrincipalId === row.targetPrincipalId &&
    value.holderPrincipalId === value.leaseHolderPrincipalId && value.holderInstanceId === value.leaseHolderInstanceId &&
    value.fencingToken === value.leaseFencingToken;
}
function journalReceipt(row: WorkRow, binding: Execution, journals: readonly Journal[]): Array<{receipt: TerminalReceiptInput; evidence: Evidence}> {
  const found: Array<{receipt: TerminalReceiptInput; evidence: Evidence}> = [];
  const expectedOrigin = { kind: 'coordination', workId: row.workId, attemptId: binding.attemptId,
    leaseId: binding.leaseId, holderPrincipalId: binding.holderPrincipalId, holderInstanceId: binding.holderInstanceId,
    authorityReference: binding.authorityReference, fencingToken: binding.fencingToken,
    channelId: row.channelId, originMessageId: row.originMessageId, roundId: row.roundId };
  const turnId = `coord-${row.workId}`, chatId = `coordination:${row.channelId}:${row.workId}`;
  for (const journal of journals) {
    const starts = journal.records.filter(record => isTurnEnvelope(record) && record.turn_id === turnId && record.status === 'pending') as TurnEnvelope[];
    if (starts.length !== 1 || starts[0]?.chat_id !== chatId || canonicalJson(starts[0]?.coordination_origin ?? null) !== canonicalJson(expectedOrigin)) continue;
    const endings = journal.records.filter(record => isTurnEnvelope(record) && record.turn_id === turnId && record.status !== 'pending') as TurnEnvelope[];
    // Terminal history is evidence, not a mutable status field. A second,
    // contradictory ending must be investigated instead of winning by order.
    const terminalEndings = endings.filter(ending => ['complete', 'stopped', 'error', 'timeout', 'orphaned'].includes(ending.status));
    if (new Set(terminalEndings.map(ending => canonicalJson(ending))).size !== 1) continue;
    const last = endings.at(-1);
    if (!last || last.chat_id !== chatId || !canonicalTime(last.ended_at)) continue;
    const final = enrichTerminalEnvelope(journal.records, last);
    let status: TerminalState, resultDigest: string | null;
    if (final.status === 'complete' && typeof final.assistant_content === 'string') {
      // The journal cannot promote attachment bytes. Let normal resident
      // recovery handle completed turns containing generated media.
      if (journal.records.some(record => !!record && typeof record === 'object' &&
        (record as any).type === 'event' && (record as any).turn_id === turnId && (record as any).kind === 'media')) continue;
      status = 'succeeded'; resultDigest = sha256(final.assistant_content);
    } else if (final.status === 'stopped') { status = 'cancelled'; resultDigest = null; }
    else if (['timeout', 'error', 'orphaned'].includes(final.status)) {
      status = 'failed'; resultDigest = sha256(final.error_message ?? final.error_code ?? final.error ?? `resident turn ended ${final.status}`);
    } else continue;
    found.push({ receipt: { status, sourceReference: binding.authorityReference, resultDigest, artifactIds: [], timestamp: last.ended_at },
      evidence: { kind: 'resident_journal', reference: journal.path, digest: journal.digest } });
  }
  return found;
}
function communicationReceipts(db: Reader, row: WorkRow, binding: Execution): Array<{receipt: TerminalReceiptInput; evidence: Evidence}> {
  const found: Array<{receipt: TerminalReceiptInput; evidence: Evidence}> = [];
  const events = db.readAll<{sequence: number; payload: string; digest: string}>(`SELECT sequence,payload_json AS payload,payload_digest AS digest
    FROM events INDEXED BY communication_events_turn_sequence WHERE type='communication.recorded'
      AND json_extract(payload_json,'$.communication.turnId')=? AND json_extract(payload_json,'$.communication.workId')=?
      AND json_extract(payload_json,'$.communication.attemptId')=? AND json_extract(payload_json,'$.communication.terminal')=1
    ORDER BY sequence`, `coord-${row.workId}`, row.workId, binding.attemptId);
  for (const event of events) {
    if (sha256(event.payload) !== event.digest) continue;
    const communication = JSON.parse(event.payload).communication, payload = communication?.payload;
    if (communication?.channelId !== row.channelId || communication?.actor?.principalId !== row.targetPrincipalId ||
      payload?.sourceReference !== binding.authorityReference || !terminal.has(payload?.status) ||
      !(payload.resultDigest === null || isDigest(payload.resultDigest)) || !Array.isArray(payload.artifactIds) ||
      payload.artifactIds.length > 32 || !canonicalTime(communication.occurredAt)) continue;
    try { for (const artifact of payload.artifactIds) assertCoordinationId('artifact', artifact); } catch { continue; }
    found.push({ receipt: { status: payload.status, sourceReference: payload.sourceReference, resultDigest: payload.resultDigest,
      artifactIds: payload.artifactIds, timestamp: communication.occurredAt },
      evidence: { kind: 'communication', reference: `events.sequence:${event.sequence}`, digest: event.digest } });
  }
  return found;
}
function plan(db: Reader, channelId: string, journals: readonly Journal[]): Planned[] {
  const rows = db.readAll<WorkRow>(`SELECT w.id AS workId,w.state,w.current_attempt_id AS currentAttemptId,w.principal_id AS principalId,
    w.target_principal_id AS targetPrincipalId,w.origin_message_id AS originMessageId,w.round_id AS roundId,w.channel_id AS channelId,
    w.kind,w.idempotency_key_digest AS idempotencyKeyDigest,e.payload_json AS admission,e.payload_digest AS admissionDigest,
    e.aggregate_id AS runId,e.sequence AS admissionSequence,
    (SELECT json_extract(a.payload_json,'$.state') FROM events a WHERE a.aggregate_kind='resident_assignment' AND a.aggregate_id=w.id ORDER BY a.aggregate_version DESC LIMIT 1) AS assignmentState,
    (SELECT json_extract(q.payload_json,'$.suppressed') FROM events q WHERE q.aggregate_kind='scheduled_channel_notice_work' AND q.aggregate_id=w.id AND q.aggregate_version=1) AS suppressed,
    (SELECT m.id FROM messages m WHERE m.work_id=w.id AND m.kind='result' ORDER BY m.channel_sequence DESC LIMIT 1) AS resultMessageId
    FROM works w JOIN events e ON e.aggregate_kind='scheduled_channel_run' AND e.aggregate_version=1
      AND json_extract(e.payload_json,'$.messageId')=w.origin_message_id
    WHERE w.channel_id=? ORDER BY w.created_at,w.id`, channelId);
  return rows.map(row => {
    const item: Planned = { workId: row.workId, runId: row.runId, state: row.state, attemptId: row.currentAttemptId,
      admissionSequence: row.admissionSequence,
      assignmentState: row.assignmentState, noticeSuppressed: row.suppressed === 1, resultMessageId: row.resultMessageId,
      disposition: 'skipped', reason: 'No exact durable terminal evidence; age and assistant text alone are insufficient' };
    if (sha256(row.admission) !== row.admissionDigest) return { ...item, reason: 'Scheduled admission digest mismatch' };
    const admission = JSON.parse(row.admission);
    if (admission.runId !== row.runId || admission.channelId !== channelId || admission.messageId !== row.originMessageId ||
      (admission.targetBotId ?? admission.botId) !== row.targetPrincipalId ||
      !(['channel.bot_turn', 'bot_turn'].includes(row.kind) || (row.kind === 'resident_turn' &&
        row.principalId === admission.botId && row.idempotencyKeyDigest === sha256(`scheduled:${row.runId}`)))) {
      return { ...item, reason: 'Work does not match scheduled admission binding' };
    }
    if (terminal.has(row.state)) return { ...item, disposition: 'already_terminal',
      reason: row.assignmentState === 'blocked' ? 'Execution already terminal; fixed scheduled card projection needs no database rewrite' : 'Canonical Work already terminal' };
    const binding = execution(db, row);
    if (!exactExecution(row, binding)) return item;
    const evidence = [...communicationReceipts(db, row, binding), ...journalReceipt(row, binding, journals)];
    if (!evidence.length) return item;
    // Different evidence sources can prove the same outcome with different
    // failure text/timestamps. Never guess between conflicting receipts.
    const distinct = new Set(evidence.map(value => canonicalJson(value.receipt)));
    if (distinct.size !== 1) return { ...item, reason: 'Conflicting durable terminal receipts require investigation' };
    const selected = evidence[0]!;
    const canTerminalize = row.state === 'running' && binding.attemptState === 'running' && binding.leaseState === 'active' ||
      selected.receipt.status === 'cancelled' && row.state === 'cancelling' && binding.attemptState === 'cancel_requested' && binding.leaseState === 'revoked';
    if (!canTerminalize) return { ...item, reason: 'Terminal evidence cannot legally close the current Work/Attempt/Lease states' };
    const { attemptId, leaseId, holderPrincipalId, holderInstanceId, fencingToken } = binding;
    return { ...item, disposition: 'repair', reason: 'Exact current-attempt terminal evidence', targetState: selected.receipt.status,
      evidence: selected.evidence, receipt: selected.receipt, binding: { workId: row.workId, attemptId, leaseId, holderPrincipalId, holderInstanceId, fencingToken } };
  });
}
function report(input: ScheduledWorkRepairInput, items: Planned[], eventSequence: number, schemaVersion: number): ScheduledWorkRepairReport {
  return { kind: 'scheduled-channel-work-repair', mode: input.apply ? 'applied' : 'dry-run', status: 'inspected', channelId: input.channelId,
    schemaVersion, eventSequence, items: items.map(({ binding: _, receipt: __, ...item }) => item),
    repairIds: items.filter(item => item.disposition === 'repair').map(item => item.workId), appliedIds: [],
    note: 'Apply requires Core stopped. Terminal scheduled card projection is corrected by product code; existing terminal Work needs no rewrite.' };
}

/** Offline one-time reconciliation through the product's normal exclusive
 * writer, lease transitions, event journal, terminal receipts and outbox.
 * Dry-run uses SQLite OPEN_READONLY (mode=ro), never immutable/live copying. */
export async function repairScheduledChannelWork(input: ScheduledWorkRepairInput): Promise<ScheduledWorkRepairReport> {
  assertCoordinationId('channel', input.channelId);
  if (input.apply && input.coreStopped !== true) throw new Error('--apply requires --core-stopped; stop Core through its normal lifecycle first');
  if (input.apply && !input.backupPath) throw new Error('--apply requires --backup PATH');
  const databasePath = realpathSync(input.databasePath);
  const backupPath = input.backupPath ? resolve(input.backupPath) : undefined;
  if (input.apply && backupPath && (backupPath === databasePath || existsSync(backupPath) || existsSync(`${backupPath}.manifest.json`))) {
    throw new Error('backup database and manifest must not exist and must differ from the source');
  }
  let raw: Database.Database | undefined;
  let backup: VerifiedBackupReceipt | undefined;
  let initial: ScheduledWorkRepairReport;
  const journals = readJournals(input.journalPaths ?? []);
  try {
    raw = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
    raw.pragma('query_only = ON'); raw.pragma('trusted_schema = OFF');
    const schema = inspectCoordinationSchema(raw);
    // Never let opening a writer migrate before the backup. Update the product
    // normally first; this narrowly scoped repair only accepts current schema.
    if (schema.version < 21 || (input.apply && schema.needsMigration)) throw new Error(`coordination schema ${schema.version} requires normal product migration before repair`);
    const db = reader(raw);
    const eventSequence = db.readOne<{sequence: number}>('SELECT coalesce(max(sequence),0) AS sequence FROM events')!.sequence;
    initial = report(input, plan(db, input.channelId, journals), eventSequence, schema.version);
    if (!input.apply) return initial;
    // SQLite's backup API includes WAL pages. Reserve/verify the backup and
    // manifest before acquiring any writable handle to the source database.
    backup = await createVerifiedOnlineBackup(raw, { path: backupPath! });
  } catch (error) {
    if (!input.apply && ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as {code?: unknown})?.code))) {
      return { kind: 'scheduled-channel-work-repair', mode: 'dry-run', status: 'locked', channelId: input.channelId,
        items: [], repairIds: [], appliedIds: [], note: 'Not inspected: Core holds the exclusive SQLite writer. No lock bypass or live file copy was attempted. Run dry-run after Core is stopped.' };
    }
    throw error;
  } finally { if (raw?.open) raw.close(); }
  const db = openCoordinationDatabase({ path: databasePath });
  try {
    const sequence = db.readOne<{sequence: number}>('SELECT coalesce(max(sequence),0) AS sequence FROM events')!.sequence;
    if (sequence !== initial.eventSequence || sequence !== backup!.eventSequence) throw new Error('database changed after backup; inspect again with Core stopped');
    const currentJournals = readJournals(input.journalPaths ?? []);
    if (canonicalJson(currentJournals.map(({path,digest}) => ({path,digest}))) !== canonicalJson(journals.map(({path,digest}) => ({path,digest})))) {
      throw new Error('resident journal changed during offline repair; stop the resident executor and inspect again');
    }
    const items = plan(db, input.channelId, currentJournals);
    const result = report(input, items, sequence, initial.schemaVersion!); result.backup = backup;
    for (const item of items) {
      if (item.disposition !== 'repair' || !item.receipt || !item.binding) continue;
      const identity = { requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') };
      const binding = { ...item.binding, ...identity };
      const leases = createLeaseService({ database: db, generateId: generateCoordinationId, leaseTtlMs: 60_000,
        now: () => new Date(item.receipt!.timestamp) });
      if (item.receipt.status === 'cancelled' && item.state === 'running') leases.revoke({ ...binding, reasonCode: 'scheduled_terminal_repair' });
      leases.terminalize({ ...binding, receipt: item.receipt });
      result.appliedIds.push(item.workId);
    }
    return result;
  } finally { db.close(); }
}
