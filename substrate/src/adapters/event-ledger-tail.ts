/**
 * EventLedgerTailAdapter — the Seed's first reality spine (Cut 2).
 *
 * Tails a Home23 harness event-ledger JSONL (append-only, written by
 * src/agent/event-ledger.ts) and maps entries into inert typed SourceEvents.
 *
 * Boundaries:
 *   - STRICTLY read-only on the source: opened with 'r', never written,
 *     never locked, never rotated by us. The cursor lives in the SEED's own
 *     state dir, not beside the source.
 *   - At-least-once delivery: pull() returns events carrying their end byte
 *     offset; the runner calls commit(offset) after each successful receipted
 *     transition. A crash between pull and commit re-delivers — duplicates
 *     are receipted transitions, never silent loss.
 *   - Torn tails are never consumed: only lines terminated by \n advance the
 *     cursor. A partially-written last line waits for its writer.
 */

import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceAdapter, SourceEvent, EventCategory, SourceAuthority } from '../types.js';
import { sanitizeSemanticVector } from '../semantic-projection.js';

const DEFAULT_READ_WINDOW_BYTES = 1024 * 1024; // 1MB per pull
const DEFAULT_OVERSIZED_LINE_MAX = 8 * 1024 * 1024; // single-line hard cap
const DEFAULT_MAX_BATCH = 200;

/** Map a harness event_type to a substrate category. Heuristic, documented,
 * and deliberately coarse — the metabolism differentiates content; this only
 * picks the routing channel. */
export function mapHarnessCategory(eventType: string): EventCategory {
  const t = eventType.toLowerCase();
  if (t.includes('challenge') || t.includes('reject') || t.includes('breakdown')) return 'correction';
  if (t.includes('outcome') || t.includes('actedon') || t.includes('acted_on')) return 'consequence';
  if (t.includes('statedelta') || t.includes('uncertainty')) return 'interpretation';
  return 'observation';
}

interface HarnessEntry {
  event_id?: string;
  event_type?: string;
  thread_id?: string;
  session_id?: string;
  object_id?: string;
  timestamp?: string;
  ts?: string;
}

export interface TailedSourceEvent extends SourceEvent {
  /** Byte offset just past this event's line — commit(this) after the
   * transition is receipted. */
  endOffset: number;
}

export type TailSourceType = 'harness-ledger' | 'relationship-ledger' | 'worker-runs' | 'conversation-stream';

export interface EventLedgerTailOptions {
  /** Absolute path of the JSONL stream to tail (read-only). */
  sourcePath: string;
  /** Which mapping to apply (default 'harness-ledger'). */
  sourceType?: TailSourceType;
  /** Directory for the adapter's own durable cursor (the Seed's state dir). */
  cursorDir: string;
  id?: string;
  /** Start at end of file (default true — a newborn Seed lives forward). */
  fromEnd?: boolean;
  /** When starting from end, back up this many bytes to give the Seed a
   * bounded tail of recent reality (aligned forward to a line boundary). */
  backfillBytes?: number;
  maxBatch?: number;
  /** Bytes read per pull (default 1MB). Injectable for tests. */
  readWindowBytes?: number;
  /** Largest single line the adapter will deliver (default 8MB). A complete
   * line beyond this is SKIPPED — cursor advanced past it, counted, logged —
   * so one pathological source line can never stall the reality spine. */
  oversizedLineMax?: number;
  log?: (line: string) => void;
}

export class EventLedgerTailAdapter implements SourceAdapter {
  readonly id: string;
  readonly authority: SourceAuthority = 'home23.event-ledger';
  private readonly sourcePath: string;
  private readonly sourceType: TailSourceType;
  private readonly cursorPath: string;
  private readonly maxBatch: number;
  private readonly readWindowBytes: number;
  private readonly oversizedLineMax: number;
  private readonly log: (line: string) => void;
  private offset: number;
  private pendingOffset: number | null = null;
  private skippedLines = 0;
  private oversizedSkips = 0;

  constructor(opts: EventLedgerTailOptions) {
    this.sourcePath = opts.sourcePath;
    this.sourceType = opts.sourceType ?? 'harness-ledger';
    this.id = opts.id ?? `tail_${createHash('sha256').update(opts.sourcePath, 'utf-8').digest('hex').slice(0, 8)}`;
    mkdirSync(opts.cursorDir, { recursive: true });
    this.cursorPath = join(opts.cursorDir, `adapter-cursor.${this.id}.json`);
    this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
    this.readWindowBytes = opts.readWindowBytes ?? DEFAULT_READ_WINDOW_BYTES;
    this.oversizedLineMax = opts.oversizedLineMax ?? DEFAULT_OVERSIZED_LINE_MAX;
    this.log = opts.log ?? (() => {});

    const persisted = this.readCursor();
    if (persisted !== null) {
      this.offset = persisted;
    } else if (opts.fromEnd === false) {
      this.offset = 0;
    } else {
      const size = existsSync(this.sourcePath) ? statSync(this.sourcePath).size : 0;
      const backfill = Math.max(0, opts.backfillBytes ?? 0);
      this.offset = Math.max(0, size - backfill);
      if (this.offset > 0 && backfill > 0) {
        // Align forward to the next line boundary so we never start mid-line.
        this.offset = this.alignToNextLine(this.offset);
      }
    }
  }

  get currentOffset(): number { return this.offset; }
  get skipped(): number { return this.skippedLines; }

  /** Read new complete lines from the source, map them, and return them with
   * end offsets. Does NOT advance the durable cursor — commit() does. */
  pull(): Promise<SourceEvent[]> {
    return Promise.resolve(this.pullSync());
  }

  pullSync(): TailedSourceEvent[] {
    if (!existsSync(this.sourcePath)) return [];
    const size = statSync(this.sourcePath).size;
    if (size < this.offset) {
      // Source shrank (rotation/truncation upstream). Restart from the top of
      // the new file — bounded by maxBatch per pull, so no flood.
      this.offset = 0;
    }
    if (size === this.offset) return [];

    const fd = openSync(this.sourcePath, 'r');
    let buf: Buffer;
    try {
      const readLen = Math.min(this.readWindowBytes, size - this.offset);
      buf = Buffer.alloc(readLen);
      const actuallyRead = readSync(fd, buf, 0, readLen, this.offset);
      buf = buf.subarray(0, actuallyRead);
    } finally {
      closeSync(fd);
    }

    const events: TailedSourceEvent[] = [];
    let lineStart = 0;
    while (events.length < this.maxBatch) {
      const nl = buf.indexOf(0x0a, lineStart);
      if (nl < 0) break; // no newline in the remaining window
      const line = buf.subarray(lineStart, nl).toString('utf-8').trim();
      const endOffset = this.offset + nl + 1;
      lineStart = nl + 1;
      if (line.length === 0) continue;
      const mapped = this.mapLine(line, endOffset);
      if (mapped === null) {
        this.skippedLines++;
        continue;
      }
      events.push(mapped);
    }

    // Liveness guard A: complete lines were consumed but none yielded events
    // (all unparseable/blank). They were examined and rejected — advance the
    // durable cursor past them or the same garbage is re-read forever.
    if (events.length === 0 && lineStart > 0) {
      this.commit(this.offset + lineStart);
      return events;
    }

    // Liveness guard B: zero events with a FULL window and more file beyond it
    // means the line at the cursor is larger than the window — NOT "caught
    // up". Without this, the adapter re-reads the same window forever and the
    // Seed silently stops perceiving reality. Deliver the oversized line via
    // a one-off exact read if it is bounded; skip past it (durably, counted,
    // logged) if it exceeds the hard cap; wait only if it is genuinely still
    // being written.
    if (events.length === 0 && buf.length === this.readWindowBytes && this.offset + buf.length < size) {
      const nextNl = this.findNextNewline(this.offset + buf.length, size);
      if (nextNl === null) return events; // unterminated giant tail — writer still going
      const lineLen = nextNl - this.offset;
      if (lineLen <= this.oversizedLineMax) {
        const bigFd = openSync(this.sourcePath, 'r');
        try {
          const bigBuf = Buffer.alloc(lineLen);
          const read = readSync(bigFd, bigBuf, 0, lineLen, this.offset);
          const line = bigBuf.subarray(0, read).toString('utf-8').trim();
          const mapped = this.mapLine(line, nextNl + 1);
          if (mapped !== null) {
            this.log(`oversized line delivered (${lineLen} bytes) at offset ${this.offset}`);
            events.push(mapped);
          } else {
            this.skippedLines++;
            this.commit(nextNl + 1);
            this.log(`oversized unparseable line skipped (${lineLen} bytes) at offset ${this.offset}`);
          }
        } finally {
          closeSync(bigFd);
        }
      } else {
        this.oversizedSkips++;
        this.skippedLines++;
        const skippedFrom = this.offset;
        this.commit(nextNl + 1);
        this.log(`oversized line SKIPPED (${lineLen} bytes > cap ${this.oversizedLineMax}) at offset ${skippedFrom}`);
      }
    }
    return events;
  }

  get oversizedSkipCount(): number { return this.oversizedSkips; }

  /** Scan forward in windows for the next newline at/after `from`. Returns its
   * absolute offset, or null if none exists yet (line still being written). */
  private findNextNewline(from: number, size: number): number | null {
    const fd = openSync(this.sourcePath, 'r');
    try {
      let position = from;
      const chunk = Buffer.alloc(this.readWindowBytes);
      while (position < size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (read <= 0) return null;
        const nl = chunk.subarray(0, read).indexOf(0x0a);
        if (nl >= 0) return position + nl;
        position += read;
      }
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** Persist the durable cursor after the events up to `offset` have been
   * receipted by the Seed. Atomic tmp+rename. */
  commit(offset: number): void {
    if (offset <= this.offset) return;
    this.offset = offset;
    const tmp = `${this.cursorPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 'home23.seed.adapter-cursor.v1', sourcePath: this.sourcePath, offset }), 'utf-8');
    renameSync(tmp, this.cursorPath);
    this.pendingOffset = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private readCursor(): number | null {
    if (!existsSync(this.cursorPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cursorPath, 'utf-8')) as { offset?: unknown; sourcePath?: unknown };
      if (parsed.sourcePath !== this.sourcePath) return null; // cursor belongs to another source
      return typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) && parsed.offset >= 0
        ? parsed.offset
        : null;
    } catch {
      return null;
    }
  }

  private alignToNextLine(offset: number): number {
    const fd = openSync(this.sourcePath, 'r');
    try {
      const stat = fstatSync(fd);
      const scanLen = Math.min(64 * 1024, stat.size - offset);
      const buf = Buffer.alloc(scanLen);
      const read = readSync(fd, buf, 0, scanLen, offset);
      const nl = buf.subarray(0, read).indexOf(0x0a);
      return nl < 0 ? stat.size : offset + nl + 1;
    } finally {
      closeSync(fd);
    }
  }

  private mapLine(line: string, endOffset: number): TailedSourceEvent | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (this.sourceType === 'relationship-ledger') return this.mapRelationshipLine(parsed, line, endOffset);
    if (this.sourceType === 'worker-runs') return this.mapWorkerRunLine(parsed, line, endOffset);
    if (this.sourceType === 'conversation-stream') return this.mapConversationLine(parsed, line, endOffset);
    return this.mapHarnessLine(parsed as HarnessEntry, line, endOffset);
  }

  /** Conversation-stream lines (substrate/bin/conversation-shipper.ts): the
   * agent's ACTUAL conversations with his person — the life itself, not its
   * telemetry. Both voices are observations of lived contact (teaching stays
   * the relationship ledger's deliberate job — no manufactured corrections);
   * the words ride as a bounded head + the perceived semantic vector, so
   * both the reservoir AND recruited lobes finally eat meaning. */
  private mapConversationLine(parsed: Record<string, unknown>, line: string, endOffset: number): TailedSourceEvent | null {
    const ts = parsed['ts'];
    if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) return null;
    const role = parsed['role'];
    if (role !== 'user' && role !== 'assistant') return null;
    const text = parsed['text'];
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    const session = typeof parsed['session'] === 'string' ? parsed['session'] : 'unknown';
    const semanticVector = sanitizeSemanticVector(parsed['semantic_vector']);
    // Agent-generic voices: 'jtr' for the person, 'self' for the agent's own
    // turns. (Chains born before 2026-08-09 carry 'jerry' for self — legacy
    // labels stay as history; readers accept both.)
    const voice = role === 'user' ? 'jtr' : 'self';
    return {
      eventId: `conv_${createHash('sha256').update(line, 'utf-8').digest('hex').slice(0, 16)}`,
      category: 'observation',
      sourceAuthority: this.authority,
      sourceRef: `conversation.${voice}:${session}`,
      ...(semanticVector !== null ? { semanticVector } : {}),
      payload: {
        role,
        session,
        head: text.trim().slice(0, 160),
      },
      producedAt: ts,
      endOffset,
    };
  }

  /** Relationship-ledger events (src/agent/relationship-ledger.ts): entries
   * typed 'correction' are jtr↔agent corrections — THE teaching stream.
   * Entries typed 'attenuation' ("that was noise, care less") ride the same
   * correction channel — they are teaching, they route like teaching — and
   * develop with the opposite sign via attenuation.v1. */
  private mapRelationshipLine(parsed: Record<string, unknown>, line: string, endOffset: number): TailedSourceEvent | null {
    const ts = parsed['ts'];
    if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) return null;
    const payload = (parsed['payload'] ?? {}) as Record<string, unknown>;
    const entryType = typeof payload['type'] === 'string' ? payload['type'] : 'entry';
    const entryId = typeof parsed['entry_id'] === 'string' ? parsed['entry_id'] : '';
    const eventId = typeof parsed['event_id'] === 'string'
      ? parsed['event_id']
      : `rel_${createHash('sha256').update(line, 'utf-8').digest('hex').slice(0, 16)}`;
    const semanticVector = sanitizeSemanticVector(parsed['semantic_vector']);
    const head = payload['head'];
    return {
      eventId,
      category: entryType === 'correction' || entryType === 'attenuation' ? 'correction' : 'observation',
      sourceAuthority: this.authority,
      sourceRef: `relationship.${entryType}:${entryId}`,
      ...(semanticVector !== null ? { semanticVector } : {}),
      payload: {
        entry_type: entryType,
        actor: typeof payload['actor'] === 'string' ? payload['actor'] : null,
        entry_id: entryId || null,
        // Writers since 2026-08-08 carry the teaching's words as a bounded
        // head — pass them through so the ref carries readable reality.
        ...(typeof head === 'string' && head.length > 0 ? { head } : {}),
      },
      producedAt: ts,
      endOffset,
    };
  }

  /** Worker-run outcomes (worker-runs.jsonl): completed runs are consequences
   * of the house acting; failed/blocked runs are reality pushing back —
   * mapped as corrections so they TEACH rather than corroborate. */
  private mapWorkerRunLine(parsed: Record<string, unknown>, line: string, endOffset: number): TailedSourceEvent | null {
    const producedAt = (typeof parsed['finishedAt'] === 'string' ? parsed['finishedAt'] : parsed['startedAt']);
    if (typeof producedAt !== 'string' || !Number.isFinite(Date.parse(producedAt))) return null;
    const status = typeof parsed['status'] === 'string' ? parsed['status'] : 'unknown';
    const worker = typeof parsed['worker'] === 'string' ? parsed['worker'] : 'unknown';
    const runId = typeof parsed['runId'] === 'string'
      ? parsed['runId']
      : `wr_${createHash('sha256').update(line, 'utf-8').digest('hex').slice(0, 16)}`;
    // The live stream's actual vocabulary: 'fixed' and 'no_change' are the
    // house acting and the outcome holding (consequences — they corroborate);
    // 'failed' and 'blocked' are reality pushing back (corrections — they
    // teach). The generic terms stay for other producers. Before 2026-08-08
    // the list below missed the live vocabulary entirely — every run
    // (including 41 successes in the recent window) taught as a correction,
    // and both live seeds' consequence-role cells starved structurally.
    const succeeded = ['success', 'ok', 'completed', 'done', 'fixed', 'no_change'].includes(status.toLowerCase());
    const semanticVector = sanitizeSemanticVector(parsed['semantic_vector']);
    return {
      eventId: runId,
      category: succeeded ? 'consequence' : 'correction',
      sourceAuthority: this.authority,
      sourceRef: `worker.${worker}:${runId}`,
      ...(semanticVector !== null ? { semanticVector } : {}),
      payload: {
        worker,
        status,
        verifierStatus: typeof parsed['verifierStatus'] === 'string' ? parsed['verifierStatus'] : null,
      },
      producedAt,
      endOffset,
    };
  }

  private mapHarnessLine(entry: HarnessEntry, line: string, endOffset: number): TailedSourceEvent | null {
    const producedAt = entry.timestamp ?? entry.ts;
    if (typeof producedAt !== 'string' || !Number.isFinite(Date.parse(producedAt))) return null;
    const eventType = typeof entry.event_type === 'string' ? entry.event_type : 'unknown';
    const eventId = typeof entry.event_id === 'string'
      ? entry.event_id
      : `harness_${createHash('sha256').update(line, 'utf-8').digest('hex').slice(0, 16)}`;

    return {
      eventId,
      category: mapHarnessCategory(eventType),
      sourceAuthority: this.authority,
      sourceRef: `${eventType}:${entry.object_id ?? entry.thread_id ?? entry.session_id ?? ''}`,
      // Payload stays a bounded projection — the harness ledger remains the
      // authority; the Seed's receipt references it, never mirrors it.
      payload: {
        event_type: eventType,
        thread_id: entry.thread_id ?? null,
        object_id: entry.object_id ?? null,
      },
      producedAt,
      endOffset,
    };
  }
}
