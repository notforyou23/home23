/** Read-only, bounded projections for the observatory. A display is not a Seed
 * writer, an execution authority, or evidence that a human received a message. */
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { seedOutreachDeliveryId } from '../../src/substrate/operator-outreach.js';

export type ObservedRow = Record<string, unknown>;
export const objectOf = (value: unknown): ObservedRow => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObservedRow : {};
const text = (value: unknown, max = 500): string => typeof value === 'string' ? value.slice(0, max) : '';
export interface WindowCoverage { bytesRead: number; totalBytes: number; startOffset: number; endOffset: number; fullHistory: boolean; tornTail: boolean }
export interface JsonlWindow { available: boolean; records: ObservedRow[]; coverage: WindowCoverage; recordHashes?: Record<string, string>; error?: string }

export function readJsonlWindow(file: string, maxBytes = 512 * 1024): JsonlWindow {
  const result: JsonlWindow = { available: false, records: [], recordHashes: {}, coverage: { bytesRead: 0, totalBytes: 0, startOffset: 0, endOffset: 0, fullHistory: false, tornTail: false } };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid observatory window budget');
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('not a regular file');
    const length = Math.min(before.size, maxBytes), start = before.size - length;
    const buffer = Buffer.alloc(length); let read = 0;
    while (read < length) { const n = readSync(fd, buffer, read, length - read, start + read); if (!n) break; read += n; }
    if (read !== length || fstatSync(fd).size < before.size) throw new Error('source changed during bounded read');
    const bytes = buffer.subarray(0, read);
    let begin = 0;
    if (start > 0) { const boundary = bytes.indexOf(10); begin = boundary < 0 ? read : boundary + 1; }
    const last = bytes.lastIndexOf(10), end = last < begin ? begin : last + 1;
    result.coverage = { bytesRead: read, totalBytes: before.size, startOffset: start + begin, endOffset: start + end, fullHistory: start === 0, tornTail: read > 0 && bytes.at(-1) !== 10 };
    if (start > 0 && begin === read) throw new Error('no complete record in bounded window');
    for (const line of bytes.subarray(begin, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid committed JSONL record');
      result.records.push(value as ObservedRow);
      if (Number.isSafeInteger((value as ObservedRow).seq)) result.recordHashes![String((value as ObservedRow).seq)] = createHash('sha256').update(line).digest('hex');
    }
    result.available = true;
  } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 180) : 'source unavailable'; }
  finally { if (fd !== undefined) closeSync(fd); }
  return result;
}

export interface OutreachView {
  commitmentId: string; message: string; at: string; deliveryId: string;
  commitmentStatus: string; deliveryStatus: string; notification: 'not_confirmed';
  messageIds: string[]; reason: string;
}
export function projectOutreach(outbox: readonly ObservedRow[], concern: ObservedRow, receipts: readonly ObservedRow[], now = Date.now()): { current: OutreachView[]; history: OutreachView[] } {
  const current: OutreachView[] = [], history: OutreachView[] = [];
  for (const row of outbox.slice(-32)) {
    const commitmentId = text(row.commitmentId), at = text(row.dispatchedAt, 100);
    const valid = typeof row.idempotencyKey === 'string' && Number.isSafeInteger(row.actSeq) && Number(row.actSeq) > 0 && commitmentId !== '';
    const deliveryId = valid ? seedOutreachDeliveryId({ idempotencyKey: row.idempotencyKey as string, actSeq: row.actSeq as number }) : '';
    const matches = receipts.filter(r => r.deliveryId === deliveryId && r.commitmentId === commitmentId && r.actSeq === row.actSeq);
    const receipt = matches.length === 1 ? matches[0] : undefined;
    const commitmentStatus = text(objectOf(concern[commitmentId]).status, 100) || 'unknown';
    const messageIds = Array.isArray(receipt?.messageIds) ? receipt.messageIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 8) : [];
    const age = now - Date.parse(at), fresh = Number.isFinite(age) && age >= -60_000 && age <= 24 * 60 * 60_000;
    const deliveryStatus = text(receipt?.status, 100) || 'unconfirmed';
    const delivered = deliveryStatus === 'committed' && messageIds.length > 0;
    const view: OutreachView = { commitmentId, message: text(row.message, 300), at, deliveryId, commitmentStatus, deliveryStatus,
      notification: 'not_confirmed', messageIds, reason: !fresh ? 'historical request; outside the relay freshness window'
        : commitmentStatus !== 'open' ? `commitment ${commitmentStatus}` : delivered ? 'canonical message recorded; notification and owner attention unconfirmed' : 'canonical delivery not confirmed' };
    (fresh && commitmentStatus === 'open' && delivered ? current : history).push(view);
  }
  return { current: current.slice(-2), history: history.slice(-4) };
}

export interface GrowthView { seq: number; op: string; targets: string[]; status: 'pending' | 'unresolved_in_window' | 'declined' | 'applied'; decisionSeq?: number; applicationEvidence?: 'direct' | 'self-gate' }
export function projectGrowth(records: readonly ObservedRow[], fullHistory: boolean): GrowthView[] {
  const proposals = records.filter(r => r.category === 'proposal' && r.sourceRef === 'growth.pressure');
  return proposals.slice(-12).map(row => {
    const p = objectOf(row.payload), seq = Number(row.seq);
    const matching = records.filter(r => {
      if (r.category !== 'act' || Number(r.seq) <= seq) return false;
      const act = objectOf(r.payload);
      return (r.sourceRef === 'growth.operator-decision' && act.proposalSeq === seq && act.operatorDecision === 'declined')
        || (r.sourceRef === 'growth.operator-application' && act.proposalSeq === seq && act.growthApplication === true)
        || (r.sourceRef === 'growth.self-application' && act.growthApplication === true && Array.isArray(objectOf(act.gateEvidence).proposalSeqs) && (objectOf(act.gateEvidence).proposalSeqs as unknown[]).includes(seq));
    });
    const terminal = matching.at(-1);
    const result: GrowthView = { seq, op: text(p.op, 80), targets: Array.isArray(p.targetCellIds) ? p.targetCellIds.filter((id): id is string => typeof id === 'string').slice(0, 16) : [],
      status: terminal ? objectOf(terminal.payload).growthApplication === true ? 'applied' : 'declined' : fullHistory ? 'pending' : 'unresolved_in_window' };
    if (terminal) { result.decisionSeq = Number(terminal.seq); if (result.status === 'applied') result.applicationEvidence = terminal.sourceRef === 'growth.self-application' ? 'self-gate' : 'direct'; }
    return result;
  });
}

export interface RoutingView { eventId: string; at: string; stage: 'routing' | 'execution'; status: string; reasonCode: string; detail: string; agendaId: string; turnId: string; executionId: string; executionAttempted: boolean; taskOutcomeVerified: boolean }
export function summarizeRouting(records: readonly ObservedRow[]): { counts: Record<string, number>; events: RoutingView[] } {
  const counts: Record<string, number> = {}, events: RoutingView[] = [];
  for (const row of records) {
    const p = objectOf(row.payload), routing = row.event_type === 'MotorActionRouted';
    const execution = row.event_type === 'ExecutionOutcomeObserved' && p.schema === 'home23.execution-outcome.v1';
    if (!routing && !execution) continue;
    const status = text(p.status, 100) || 'unknown';
    const reasonCode = routing ? p.routingVersion === 2 ? text(p.reasonCode, 100) || 'unknown' : `legacy_${status}` : status;
    counts[reasonCode] = (counts[reasonCode] ?? 0) + 1;
    const evidence = Array.isArray(p.evidenceRefs) ? p.evidenceRefs : [];
    events.push({ eventId: text(row.event_id), at: text(row.timestamp ?? row.ts, 100), stage: routing ? 'routing' : 'execution', status, reasonCode,
      detail: text(p.detail ?? p.content ?? p.head, 500), agendaId: text(p.agendaId), turnId: text(p.turnId), executionId: text(p.executionId),
      executionAttempted: execution && p.executionAttempted === true,
      taskOutcomeVerified: execution && p.verificationStatus === 'verified' && p.taskOutcomeVerified === true && evidence.length > 0 });
  }
  return { counts, events: events.slice(-12).reverse() };
}
