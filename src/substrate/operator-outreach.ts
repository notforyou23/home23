/** Relays authorized Seed outbox entries to the existing owner conversation.
 * An outbox write is queued intent. A committed send is a canonical message,
 * never evidence of a phone notification, delivery, or human attention. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SeedOutreachRequest { text: string; reason: string; deliveryId: string }
export interface SeedOutreachSendResult {
  status: 'committed' | 'queued';
  notification: 'not_confirmed';
  messageIds?: string[];
  channelId?: string;
}
export interface SeedOperatorOutreachOptions {
  stateDir: string;
  /** Must deduplicate by deliveryId: a process can stop after commit but before receipt. */
  send(request: SeedOutreachRequest): Promise<SeedOutreachSendResult>;
  now?: () => number;
  pollIntervalMs?: number;
  maxAgeMs?: number;
  onError?: (error: Error) => void;
}
export interface SeedOutreachFlushSummary { committed: number; queued: number; pending: number; expired: number; failed: number; invalid: number; duplicate: number }
interface Receipt {
  deliveryId: string;
  actSeq?: number;
  commitmentId?: string;
  status: 'pending' | 'queued' | 'committed' | 'expired' | 'invalid';
  notification: 'not_confirmed';
  at: string;
  attempts: number;
  reason?: string;
  messageIds?: string[];
  channelId?: string;
}
interface RelayState { version: 1; offset: number; anchor: string; receipts: Receipt[] }
interface OutboxRecord { idempotencyKey: string; actSeq: number; commitmentId: string; message: string; dispatchedAt: string }
const READ_BYTES = 64 * 1024;
const MAX_RECORDS = 32;
const MAX_RECEIPTS = 128;
const DAY_MS = 24 * 60 * 60 * 1000;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function seedOutreachDeliveryId(record: Pick<OutboxRecord, 'idempotencyKey' | 'actSeq'>): string {
  return `seed-outreach:${hash(JSON.stringify([record.idempotencyKey, record.actSeq]))}`;
}
function isRecord(value: unknown): value is OutboxRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<OutboxRecord>;
  return typeof r.idempotencyKey === 'string' && r.idempotencyKey.length > 0 && r.idempotencyKey.length <= 512
    && Number.isSafeInteger(r.actSeq) && r.actSeq! > 0
    && typeof r.commitmentId === 'string' && r.commitmentId.length > 0 && r.commitmentId.length <= 512
    && typeof r.message === 'string' && r.message.trim().length > 0 && r.message.length <= 4000 && !r.message.includes('\0')
    && typeof r.dispatchedAt === 'string' && Number.isFinite(Date.parse(r.dispatchedAt));
}
function readAnchor(fd: number, offset: number): string {
  if (offset === 0) return '';
  const size = Math.min(offset, 256);
  const bytes = Buffer.alloc(size);
  if (readSync(fd, bytes, 0, size, offset - size) !== size) throw new Error('Seed outreach outbox was truncated behind its cursor');
  return hash(bytes);
}
function loadState(path: string): RelayState {
  if (!existsSync(path)) return { version: 1, offset: 0, anchor: '', receipts: [] };
  // This file is bounded by the writer. Refuse corrupt state instead of resetting
  // the cursor and accidentally replaying the owner's conversation.
  if (statSync(path).size > 512 * 1024) throw new Error('Seed outreach receipt state exceeds its bound');
  const state = JSON.parse(readFileSync(path, 'utf8')) as RelayState;
  if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0
      || typeof state.anchor !== 'string' || !Array.isArray(state.receipts) || state.receipts.length > MAX_RECEIPTS
      || state.receipts.some(r => !r || typeof r.deliveryId !== 'string'
        || !['pending', 'queued', 'committed', 'expired', 'invalid'].includes(r.status))) {
    throw new Error('Seed outreach receipt state is invalid');
  }
  return state;
}
function persistState(path: string, state: RelayState): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(state) + '\n', 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(join(path, '..'), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function createSeedOperatorOutreach(options: SeedOperatorOutreachOptions): {
  start(): void;
  stop(): Promise<void>;
  flush(): Promise<SeedOutreachFlushSummary>;
} {
  const outboxPath = join(options.stateDir, 'outbox.jsonl');
  const receiptPath = join(options.stateDir, 'operator-outreach.json');
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DAY_MS;
  if (!(maxAgeMs > 0 && maxAgeMs <= DAY_MS)) throw new Error('Seed outreach maxAgeMs must be between zero and 24 hours');
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<SeedOutreachFlushSummary> | undefined;
  const onError = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  async function drain(): Promise<SeedOutreachFlushSummary> {
    const summary = { committed: 0, queued: 0, pending: 0, expired: 0, failed: 0, invalid: 0, duplicate: 0 };
    if (!existsSync(outboxPath)) return summary;
    const state = loadState(receiptPath);
    const fd = openSync(outboxPath, 'r');
    try {
      if (readAnchor(fd, state.offset) !== state.anchor) throw new Error('Seed outreach outbox no longer matches its saved cursor');
      const buffer = Buffer.alloc(READ_BYTES);
      const bytes = readSync(fd, buffer, 0, buffer.length, state.offset);
      const batch = buffer.subarray(0, bytes);
      let consumed = 0;
      for (let count = 0; count < MAX_RECORDS; count++) {
        const end = batch.indexOf(10, consumed);
        if (end < 0) {
          if (consumed === 0 && bytes === READ_BYTES) throw new Error('Seed outreach outbox entry exceeds the bounded read size');
          break; // A JSONL record only exists once its newline is committed.
        }
        const line = batch.subarray(consumed, end).toString('utf8');
        const nextOffset = state.offset + end + 1 - consumed;
        let value: unknown;
        try { value = JSON.parse(line); } catch { value = null; }
        const record = isRecord(value) ? value : null;
        const deliveryId = record ? seedOutreachDeliveryId(record) : `seed-outreach-invalid:${hash(line)}`;
        const previous = state.receipts.find(receipt => receipt.deliveryId === deliveryId);
        const at = new Date(now()).toISOString();
        const receipt: Receipt = {
          deliveryId, ...(record ? { actSeq: record.actSeq, commitmentId: record.commitmentId } : {}),
          status: 'pending', notification: 'not_confirmed', at, attempts: previous?.attempts ?? 0,
        };
        const saveReceipt = (advance: boolean): void => {
          state.receipts = [...state.receipts.filter(r => r.deliveryId !== deliveryId), receipt].slice(-MAX_RECEIPTS);
          if (advance) { state.offset = nextOffset; state.anchor = readAnchor(fd, nextOffset); }
          persistState(receiptPath, state);
        };
        if (previous?.status === 'committed' || previous?.status === 'expired' || previous?.status === 'invalid') {
          Object.assign(receipt, previous);
          saveReceipt(true);
          summary.duplicate++;
        } else if (!record) {
          receipt.status = 'invalid'; receipt.reason = 'Malformed or unsupported committed outbox entry';
          saveReceipt(true); summary.invalid++;
        } else if (!previous?.attempts && (now() - Date.parse(record.dispatchedAt) > maxAgeMs || Date.parse(record.dispatchedAt) > now() + 60_000)) {
          receipt.status = 'expired'; receipt.reason = 'Outbox request is older than 24 hours or has an invalid future time';
          saveReceipt(true); summary.expired++;
        } else {
          receipt.attempts++;
          saveReceipt(false); // Retry identity survives a crash or an uncertain send result.
          let result: SeedOutreachSendResult;
          try {
            result = await options.send({ text: record.message, reason: `Seed concern ${record.commitmentId}; authorized act ${record.actSeq}`, deliveryId });
          } catch (error) {
            receipt.reason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
            saveReceipt(false);
            summary.failed++; summary.pending++; onError(error);
            break;
          }
          if (!result || !['committed', 'queued'].includes(result.status) || result.notification !== 'not_confirmed') {
            receipt.reason = 'Seed outreach sender returned an unsupported delivery receipt';
            saveReceipt(false);
            summary.failed++; summary.pending++; onError(new Error(receipt.reason));
            break;
          }
          receipt.status = result.status;
          receipt.messageIds = result.messageIds?.filter(id => typeof id === 'string').slice(0, 8).map(id => id.slice(0, 256));
          receipt.channelId = result.channelId?.slice(0, 256);
          saveReceipt(result.status === 'committed');
          summary[result.status]++;
          if (result.status === 'queued') { summary.pending++; break; } // Same request/ID until canonical commit.
        }
        consumed = end + 1;
      }
      return summary;
    } finally { closeSync(fd); }
  }
  function flush(): Promise<SeedOutreachFlushSummary> {
    if (inFlight) return inFlight;
    inFlight = drain().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return {
    start() {
      if (timer) return;
      void flush().catch(onError);
      timer = setInterval(() => { void flush().catch(onError); }, Math.max(250, options.pollIntervalMs ?? 5000));
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (inFlight) await inFlight.catch(onError);
    },
    flush,
  };
}
