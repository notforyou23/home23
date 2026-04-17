/**
 * COSMO Home 2.3 — Cron Scheduler
 *
 * Manages scheduled jobs with cron expressions, fixed intervals,
 * and one-shot timers. Jobs are persisted to disk and run logs
 * are appended as JSONL per job.
 *
 * Built-in cron parser — no external dependencies.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SchedulerConfig } from '../types.js';

// ─── Types ───────────────────────────────────────────────────

export type ScheduleSpec =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'at'; at: string };

export type JobPayload =
  | { kind: 'agentTurn'; message?: string; messagePath?: string; model?: string; timeoutSeconds?: number; sessionHistory?: 'persistent' | 'fresh' }
  | { kind: 'exec'; command: string; timeoutSeconds?: number }
  | { kind: 'query'; message: string; mode?: string; model?: string; timeoutSeconds?: number }
  | { kind: 'systemEvent'; text: string };

export interface DeliveryConfig {
  mode: 'none' | 'failures' | 'summary' | 'full';
  channel?: string;
  channels?: Array<{ channel: string; to: string }>;
  to?: string;
  profile?: string;
}

export interface JobState {
  nextRunAtMs: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error';
  lastDurationMs?: number;
  consecutiveErrors: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: ScheduleSpec;
  sessionTarget: 'isolated' | 'main';
  wakeMode: 'now' | 'next-heartbeat';
  payload: JobPayload;
  delivery?: DeliveryConfig;
  state: JobState;
}

export interface JobResult {
  status: 'ok' | 'error';
  response?: string;
  error?: string;
  durationMs: number;
}

export type JobHandler = (job: CronJob) => Promise<JobResult>;

// ─── Cron Expression Parser ─────────────────────────────────

interface CronField {
  values: Set<number>;
}

function parseCronField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      // */N or N/M
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr!, 10);
      let start = min;
      if (base !== '*') {
        start = parseInt(base!, 10);
      }
      for (let i = start; i <= max; i += step) {
        values.add(i);
      }
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return { values };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length} in "${expr}"`);
  }
  return {
    minute: parseCronField(fields[0]!, 0, 59),
    hour: parseCronField(fields[1]!, 0, 23),
    dayOfMonth: parseCronField(fields[2]!, 1, 31),
    month: parseCronField(fields[3]!, 1, 12),
    dayOfWeek: parseCronField(fields[4]!, 0, 6),
  };
}

/** Extract date fields in a specific timezone using Intl.DateTimeFormat. */
function getFieldsInTz(date: Date, tz: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric', minute: 'numeric', day: 'numeric',
      month: 'numeric', weekday: 'short', hour12: false,
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      minute: parseInt(map.minute ?? '0'),
      hour: parseInt(map.hour ?? '0'),
      day: parseInt(map.day ?? '1'),
      month: parseInt(map.month ?? '1'),
      weekday: weekdayMap[map.weekday ?? 'Sun'] ?? 0,
    };
  } catch {
    // Fallback to local time if timezone is invalid
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay(),
    };
  }
}

function cronMatchesTz(parsed: ParsedCron, date: Date, tz: string): boolean {
  const f = getFieldsInTz(date, tz);
  return (
    parsed.minute.values.has(f.minute) &&
    parsed.hour.values.has(f.hour) &&
    parsed.dayOfMonth.values.has(f.day) &&
    parsed.month.values.has(f.month) &&
    parsed.dayOfWeek.values.has(f.weekday)
  );
}

/**
 * Find the next matching time for a cron expression after the given date.
 * Evaluates in the specified timezone. Searches minute-by-minute up to ~2 years.
 */
export function nextMatch(expr: string, after: Date, tz: string = 'America/New_York'): Date {
  const parsed = parseCronExpr(expr);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 1_051_200;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatchesTz(parsed, candidate, tz)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No cron match found within 2 years for "${expr}"`);
}

// ─── CronScheduler ──────────────────────────────────────────

export class CronScheduler {
  private config: SchedulerConfig;
  private handler: JobHandler;
  private runtimeDir: string;
  private jobs: Map<string, CronJob> = new Map();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private jobsFilePath: string;
  private runsDirPath: string;

  constructor(config: SchedulerConfig, handler: JobHandler, runtimeDir: string) {
    this.config = config;
    this.handler = handler;
    this.runtimeDir = runtimeDir;
    this.jobsFilePath = join(runtimeDir, config.jobsFile);
    this.runsDirPath = join(runtimeDir, config.runsDir);

    // Ensure directories exist
    mkdirSync(dirname(this.jobsFilePath), { recursive: true });
    mkdirSync(this.runsDirPath, { recursive: true });

    // Load persisted jobs
    this.loadJobs();
  }

  // ─── Lifecycle ──────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[scheduler] Started — ${this.jobs.size} job(s) loaded, tick every 30s`);

    // Run first tick immediately, then every 30 seconds
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    console.log('[scheduler] Stopped');
  }

  // ─── Job Management ────────────────────────────────────

  addJob(job: CronJob): void {
    // Compute the first nextRunAtMs so the job doesn't fire immediately
    job.state.nextRunAtMs = this.computeNextRun(job);
    this.jobs.set(job.id, job);
    this.saveJobs();
    console.log(`[scheduler] Job added: ${job.id} (${job.name}), next run: ${new Date(job.state.nextRunAtMs).toISOString()}`);
  }

  removeJob(id: string): void {
    const deleted = this.jobs.delete(id);
    if (deleted) {
      this.saveJobs();
      console.log(`[scheduler] Job removed: ${id}`);
    }
  }

  enableJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.enabled = true;
      // Recompute next run
      job.state.nextRunAtMs = this.computeNextRun(job);
      this.saveJobs();
      console.log(`[scheduler] Job enabled: ${id}`);
    }
  }

  disableJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.enabled = false;
      this.saveJobs();
      console.log(`[scheduler] Job disabled: ${id}`);
    }
  }

  getJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  // ─── Tick Loop ─────────────────────────────────────────

  private tick(): void {
    const now = Date.now();
    const dueJobs: CronJob[] = [];

    for (const job of this.jobs.values()) {
      if (job.enabled && now >= job.state.nextRunAtMs) {
        dueJobs.push(job);
      }
    }

    if (dueJobs.length > 0) {
      // Pre-compute next run BEFORE firing to prevent double-fire
      // (if a job takes >30s, the next tick would see it as still due).
      // One-shot 'at' jobs: disable here so the next tick won't re-queue.
      for (const job of dueJobs) {
        if (job.schedule.kind === 'at') {
          job.enabled = false;
        }
        job.state.nextRunAtMs = this.computeNextRun(job);
      }
      this.saveJobs();

      // Fire all due jobs concurrently (don't block tick)
      for (const job of dueJobs) {
        this.executeJob(job).catch(err => {
          console.error(`[scheduler] Unhandled error executing job ${job.id}:`, err);
        });
      }
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    const startMs = Date.now();
    let result: JobResult;

    try {
      result = await this.handler(job);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      result = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }

    // Update job state
    job.state.lastRunAtMs = startMs;
    job.state.lastStatus = result.status;
    job.state.lastDurationMs = result.durationMs;

    if (result.status === 'ok') {
      job.state.consecutiveErrors = 0;
    } else {
      job.state.consecutiveErrors++;
    }

    // Compute next run (already disabled in tick for 'at' jobs — just update state).
    job.state.nextRunAtMs = this.computeNextRun(job);
    if (job.schedule.kind === 'at') {
      console.log(`[scheduler] One-shot job ${job.id} fired`);
    }

    // Persist
    this.saveJobs();

    // Append run log
    this.appendRunLog(job.id, {
      jobId: job.id,
      timestamp: new Date(startMs).toISOString(),
      status: result.status,
      response: result.response,
      error: result.error,
      durationMs: result.durationMs,
    });

    const statusTag = result.status === 'ok' ? 'OK' : 'ERROR';
    console.log(`[scheduler] Job ${job.id} ${statusTag} (${result.durationMs}ms)`);
  }

  // ─── Next Run Computation ─────────────────────────────

  private computeNextRun(job: CronJob): number {
    const now = new Date();
    const schedule = job.schedule;

    switch (schedule.kind) {
      case 'cron': {
        const next = nextMatch(schedule.expr, now, schedule.tz || 'America/New_York');
        return next.getTime();
      }
      case 'every': {
        const base = job.state.lastRunAtMs ?? Date.now();
        let next = base + schedule.everyMs;
        // Align to anchor if set — use positive modulo (JS % is sign-of-dividend).
        if (schedule.anchorMs !== undefined) {
          const diff = next - schedule.anchorMs;
          const offset = ((diff % schedule.everyMs) + schedule.everyMs) % schedule.everyMs;
          if (offset !== 0) {
            next = next - offset + schedule.everyMs;
          }
        }
        // If next is in the past, fast-forward
        const now = Date.now();
        while (next <= now) {
          next += schedule.everyMs;
        }
        return next;
      }
      case 'at': {
        const atMs = new Date(schedule.at).getTime();
        if (isNaN(atMs)) {
          console.warn(`[scheduler] Invalid 'at' value "${schedule.at}" for job ${job.id}`);
          return Date.now() + 365 * 24 * 60 * 60 * 1000;
        }
        if (atMs <= Date.now()) {
          return Date.now() + 365 * 24 * 60 * 60 * 1000;
        }
        return atMs;
      }
      default:
        return Date.now() + 60_000; // fallback: 1 minute
    }
  }

  // ─── Persistence ──────────────────────────────────────

  private loadJobs(): void {
    if (!existsSync(this.jobsFilePath)) return;

    try {
      const raw = readFileSync(this.jobsFilePath, 'utf-8');
      const arr: CronJob[] = JSON.parse(raw);
      let skipped = 0;
      let pruned = 0;
      for (const job of arr) {
        // Validate: must have id, schedule.kind, and a valid payload
        if (!job.id || !job.schedule?.kind || !job.payload?.kind) {
          console.warn(`[scheduler] Skipping malformed job: ${JSON.stringify(job).slice(0, 100)}`);
          skipped++;
          continue;
        }
        // Validate schedule fields
        if (job.schedule.kind === 'cron' && !(job.schedule as { expr?: string }).expr) {
          console.warn(`[scheduler] Skipping cron job "${job.id}" with missing expr`);
          skipped++;
          continue;
        }
        if (job.schedule.kind === 'at' && !(job.schedule as { at?: string }).at) {
          console.warn(`[scheduler] Skipping at job "${job.id}" with missing at field`);
          skipped++;
          continue;
        }
        // Fix null nextRunAtMs (corrupt state) — recompute
        if (job.state.nextRunAtMs == null || isNaN(job.state.nextRunAtMs)) {
          job.state.nextRunAtMs = this.computeNextRun(job);
        }
        // Auto-prune disabled one-shot jobs older than 7 days
        if (job.schedule.kind === 'at' && !job.enabled && job.state.lastRunAtMs) {
          const age = Date.now() - job.state.lastRunAtMs;
          if (age > 7 * 24 * 60 * 60 * 1000) {
            pruned++;
            continue;
          }
        }
        this.jobs.set(job.id, job);
      }
      const msgs = [`${this.jobs.size} job(s) from ${this.config.jobsFile}`];
      if (skipped > 0) msgs.push(`${skipped} malformed skipped`);
      if (pruned > 0) msgs.push(`${pruned} expired one-shots pruned`);
      console.log(`[scheduler] Loaded ${msgs.join(', ')}`);

      // Persist if we pruned or fixed anything
      if (skipped > 0 || pruned > 0) this.saveJobs();
    } catch (err) {
      console.error('[scheduler] Failed to load jobs file:', err);
    }
  }

  private saveJobs(): void {
    const arr = Array.from(this.jobs.values());
    const json = JSON.stringify(arr, null, 2);
    const tmpPath = this.jobsFilePath + `.tmp-${randomUUID().slice(0, 8)}`;

    try {
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.jobsFilePath);
    } catch (err) {
      console.error('[scheduler] Failed to save jobs:', err);
      // Clean up temp file if rename failed
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  private appendRunLog(jobId: string, entry: Record<string, unknown>): void {
    const logPath = join(this.runsDirPath, `${jobId}.jsonl`);
    try {
      appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error(`[scheduler] Failed to append run log for ${jobId}:`, err);
    }
  }
}
