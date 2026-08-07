/**
 * SeedLedger — trusted, hash-chained, append-only developmental record.
 *
 * Stronger than the Home23 EventLedger (best-effort, no chain):
 *   - monotonic seq numbers, resumed on re-open from file tail
 *   - sha256 hash chain (GENESIS anchor for fresh ledger)
 *   - fail-closed: developmental mutation throws on append failure, never swallows
 *   - branch/replay metadata support
 *   - verifyChain() walks every record and reports breaks
 *   - never silently rewrites or reorders records
 *
 * The Seed may dispute or reinterpret an observation. It may not alter source events.
 */

import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  LedgerRecord,
  LedgerVerifyResult,
  EventCategory,
  SourceAuthority,
} from './types.js';

const GENESIS = 'GENESIS';
const LEDGER_FILENAME = 'seed-ledger.jsonl';
const TAIL_READ_SIZE = 65_536; // 64KB

function sha256Line(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

interface TailState {
  seq: number;
  prevHash: string;
  lastLine: string;
  bytes: number;
}

function resumeFromTail(filePath: string): TailState {
  if (!existsSync(filePath)) {
    return { seq: 0, prevHash: GENESIS, lastLine: '', bytes: 0 };
  }
  const stat = statSync(filePath);
  if (stat.size === 0) {
    return { seq: 0, prevHash: GENESIS, lastLine: '', bytes: 0 };
  }

  const readSize = Math.min(TAIL_READ_SIZE, stat.size);
  const start = stat.size - readSize;
  const buf = Buffer.alloc(readSize);

  const fd = import('node:fs').then(() => undefined); // unused — use sync approach
  // Synchronous tail read via readFileSync on the whole file is safe for small ledgers.
  // For production rotation this would use a fd + pread; for Cut 1 the ledger is bounded.
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Walk backwards to find last parseable seq-bearing line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    try {
      const parsed = JSON.parse(line) as Partial<LedgerRecord>;
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
        return {
          seq: parsed.seq,
          prevHash: sha256Line(line),
          lastLine: line,
          bytes: stat.size,
        };
      }
    } catch {
      continue;
    }
  }

  // File exists but has no recoverable chain record — treat as corrupted tail
  return { seq: 0, prevHash: GENESIS, lastLine: '', bytes: stat.size };
}

export class SeedLedger {
  private readonly ledgerPath: string;
  private seq: number;
  private prevHash: string;
  private lastLine: string;
  private ledgerBytes: number;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.ledgerPath = join(stateDir, LEDGER_FILENAME);
    const tail = resumeFromTail(this.ledgerPath);
    this.seq = tail.seq;
    this.prevHash = tail.prevHash;
    this.lastLine = tail.lastLine;
    this.ledgerBytes = tail.bytes;
  }

  get currentSeq(): number { return this.seq; }
  get currentCursor(): string { return this.lastLine ? sha256Line(this.lastLine) : GENESIS; }
  get bytes(): number { return this.ledgerBytes; }

  /**
   * Append one record. Throws on any failure — developmental mutation must not
   * proceed if the receipt cannot be committed. Fail-closed by design.
   */
  append(opts: {
    category: EventCategory;
    sourceAuthority: SourceAuthority;
    sourceRef: string;
    payload: Record<string, unknown>;
    stateHashBefore?: string;
    stateHashAfter?: string;
    branchId?: string;
    replayFromSeq?: number;
  }): LedgerRecord {
    const nextSeq = this.seq + 1;
    const record: LedgerRecord = {
      schema: 'home23.seed.ledger.v1',
      seq: nextSeq,
      prevHash: this.prevHash,
      recordId: randomUUID(),
      category: opts.category,
      sourceAuthority: opts.sourceAuthority,
      sourceRef: opts.sourceRef,
      payload: opts.payload,
      stateHashBefore: opts.stateHashBefore,
      stateHashAfter: opts.stateHashAfter,
      issuedAt: new Date().toISOString(),
      branchId: opts.branchId,
      replayFromSeq: opts.replayFromSeq,
    };

    // Canonical serialization: deterministic property order via explicit construction.
    // The hash of this exact string is stored as the next record's prevHash.
    const line = JSON.stringify(record);

    // Fail-closed: any write failure throws into the caller.
    appendFileSync(this.ledgerPath, line + '\n');

    this.seq = nextSeq;
    this.prevHash = sha256Line(line);
    this.lastLine = line;
    this.ledgerBytes += Buffer.byteLength(line + '\n', 'utf-8');

    return record;
  }

  /**
   * Walk every record in the ledger and verify the hash chain.
   * Reports each break without repairing.
   */
  verifyChain(): LedgerVerifyResult {
    if (!existsSync(this.ledgerPath)) {
      return { ok: true, totalRecords: 0, errors: [] };
    }

    const raw = readFileSync(this.ledgerPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const errors: LedgerVerifyResult['errors'] = [];
    let expectedPrevHash: string = GENESIS;
    let expectedSeq = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      let parsed: Partial<LedgerRecord>;
      try {
        parsed = JSON.parse(line) as Partial<LedgerRecord>;
      } catch {
        errors.push({ seq: expectedSeq, type: 'invalid_json', detail: `line ${i + 1}` });
        continue;
      }

      if (parsed.schema !== 'home23.seed.ledger.v1') {
        errors.push({ seq: parsed.seq ?? expectedSeq, type: 'schema_invalid', detail: `schema: ${parsed.schema}` });
      }

      if (typeof parsed.seq === 'number' && parsed.seq !== expectedSeq) {
        errors.push({
          seq: parsed.seq,
          type: 'seq_break',
          detail: `expected ${expectedSeq}, got ${parsed.seq}`,
        });
      }

      if (parsed.prevHash !== expectedPrevHash) {
        errors.push({
          seq: parsed.seq ?? expectedSeq,
          type: 'prev_hash_mismatch',
          detail: `expected ${expectedPrevHash.slice(0, 16)}…, got ${String(parsed.prevHash).slice(0, 16)}…`,
        });
      }

      expectedPrevHash = sha256Line(line);
      expectedSeq = (parsed.seq ?? expectedSeq) + 1;
    }

    return { ok: errors.length === 0, totalRecords: lines.length, errors };
  }

  /** Read all records for replay/inspection. Never mutates. */
  readAll(): LedgerRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    const raw = readFileSync(this.ledgerPath, 'utf-8');
    const records: LedgerRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as LedgerRecord);
      } catch {
        // torn tail or corruption — surface via verifyChain(), not here
      }
    }
    return records;
  }

  /** Read all records from a given seq (inclusive) for replay from checkpoint. */
  readFrom(seq: number): LedgerRecord[] {
    return this.readAll().filter((r) => r.seq >= seq);
  }

  /** Path to the ledger file, for size checks. */
  get path(): string { return this.ledgerPath; }
}
