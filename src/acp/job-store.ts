/**
 * Durable coding-job store (Step 29).
 *
 * One directory per job under jobsDir:
 *   <jobsDir>/<jobId>/job.json      metadata + status (atomic tmp+rename)
 *   <jobsDir>/<jobId>/events.jsonl  raw CLI stdout — the detached child writes
 *                                   this directly via fd; the store only reads
 *   <jobsDir>/<jobId>/stderr.log
 *   <jobsDir>/<jobId>/receipt.json  concise terminal receipt
 *
 * The events file doubles as durability and streaming source, so the store
 * never buffers it whole: tail reads are capped at the last 256KB.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { CodingJobReceipt, CodingJobRecord, CodingJobStatus } from './types.js';

const TAIL_READ_MAX_BYTES = 256 * 1024;

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export class CodingJobStore {
  constructor(private readonly jobsDir: string) {
    mkdirSync(jobsDir, { recursive: true });
  }

  newJobId(now = new Date()): string {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
    return `cj_${stamp}_${suffix}`;
  }

  jobDir(id: string): string {
    return path.join(this.jobsDir, id);
  }

  eventsPath(id: string): string {
    return path.join(this.jobDir(id), 'events.jsonl');
  }

  stderrPath(id: string): string {
    return path.join(this.jobDir(id), 'stderr.log');
  }

  private jobJsonPath(id: string): string {
    return path.join(this.jobDir(id), 'job.json');
  }

  private receiptPath(id: string): string {
    return path.join(this.jobDir(id), 'receipt.json');
  }

  createJob(record: CodingJobRecord): void {
    mkdirSync(this.jobDir(record.id), { recursive: true });
    writeJsonAtomic(this.jobJsonPath(record.id), record);
  }

  updateJob(id: string, patch: Partial<CodingJobRecord>): CodingJobRecord {
    const current = this.getJob(id);
    if (!current) throw new Error(`Unknown coding job: ${id}`);
    const next = { ...current, ...patch, id: current.id } as CodingJobRecord;
    writeJsonAtomic(this.jobJsonPath(id), next);
    return next;
  }

  getJob(id: string): CodingJobRecord | undefined {
    try {
      const raw = readFileSync(this.jobJsonPath(id), 'utf-8');
      const parsed = JSON.parse(raw) as CodingJobRecord;
      return parsed && typeof parsed === 'object' && parsed.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  listJobs(filter: { status?: CodingJobStatus; limit?: number } = {}): CodingJobRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(this.jobsDir);
    } catch {
      return [];
    }
    const jobs: CodingJobRecord[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('cj_')) continue;
      if (!existsSync(this.jobJsonPath(entry))) continue;
      const job = this.getJob(entry);
      if (!job) {
        console.warn(`[acp] Skipping corrupt or unreadable job record: ${entry}`);
        continue;
      }
      if (filter.status && job.status !== filter.status) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => (b.startedAt.localeCompare(a.startedAt)) || b.id.localeCompare(a.id));
    return filter.limit && filter.limit > 0 ? jobs.slice(0, filter.limit) : jobs;
  }

  writeReceipt(receipt: CodingJobReceipt): void {
    mkdirSync(this.jobDir(receipt.jobId), { recursive: true });
    writeJsonAtomic(this.receiptPath(receipt.jobId), receipt);
  }

  getReceipt(id: string): CodingJobReceipt | undefined {
    try {
      return JSON.parse(readFileSync(this.receiptPath(id), 'utf-8')) as CodingJobReceipt;
    } catch {
      return undefined;
    }
  }

  /**
   * Last maxLines complete lines of events.jsonl without loading the file:
   * reads at most the trailing 256KB. When the window starts mid-file the
   * first (possibly partial) line is dropped.
   */
  readRawEventsTail(id: string, maxLines: number): string[] {
    const filePath = this.eventsPath(id);
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return [];
    }
    if (size === 0 || maxLines <= 0) return [];
    const readLen = Math.min(size, TAIL_READ_MAX_BYTES);
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const read = readSync(fd, buf, 0, readLen, size - readLen);
      const lines = buf.toString('utf8', 0, read).split('\n').filter(line => line.trim().length > 0);
      if (readLen < size && lines.length > 0) lines.shift();
      return lines.slice(-maxLines);
    } finally {
      closeSync(fd);
    }
  }
}
