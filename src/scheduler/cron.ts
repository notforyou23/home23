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
  | { kind: 'agentTurn'; message: string; model?: string; timeoutSeconds?: number }
  | { kind: 'exec'; command: string; timeoutSeconds?: number }
  | { kind: 'query'; message: string; mode?: string; model?: string; timeoutSeconds?: number }
  | { kind: 'systemEvent'; text: string };

export interface DeliveryConfig {
  mode: 'none' | 'failures' | 'summary' | 'full';
  channel?: string;
  channels?: Array<{ channel: string; to: string }>;
  to?: string;
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

function cronMatches(parsed: ParsedCron, date: Date): boolean {
  return (
    parsed.minute.values.has(date.getMinutes()) &&
    parsed.hour.values.has(date.getHours()) &&
    parsed.dayOfMonth.values.has(date.getDate()) &&
    parsed.month.values.has(date.getMonth() + 1) &&
    parsed.dayOfWeek.values.has(date.getDay())
  );
}

/**
 * Find the next matching time for a cron expression after the given date.
 * Searches minute-by-minute up to ~2 years out.
 */
export function nextMatch(expr: string, after: Date): Date {
  const parsed = parseCronExpr(expr);
  // Start from the next whole minute after `after`
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Safety: search up to 2 years (≈1,051,200 minutes)
  const maxIterations = 1_051_200;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(parsed, candidate)) {
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
      // (if a job takes >30s, the next tick would see it as still due)
      for (const job of dueJobs) {
        // For one-shot jobs, disable immediately before firing to prevent re-fire race
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

    // Compute next run
    job.state.nextRunAtMs = this.computeNextRun(job);

    // For one-shot ('at') jobs, disable after firing
    if (job.schedule.kind === 'at') {
      job.enabled = false;
      console.log(`[scheduler] One-shot job ${job.id} fired and disabled`);
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
        const next = nextMatch(schedule.expr, now);
        return next.getTime();
      }
      case 'every': {
        const base = job.state.lastRunAtMs ?? Date.now();
        let next = base + schedule.everyMs;
        // Align to anchor if set
        if (schedule.anchorMs !== undefined) {
          const offset = (next - schedule.anchorMs) % schedule.everyMs;
          if (offset !== 0) {
            next = next - offset + schedule.everyMs;
          }
        }
        // If next is in the past, fast-forward
        while (next <= Date.now()) {
          next += schedule.everyMs;
        }
        return next;
      }
      case 'at': {
        // One-shot: parse ISO string
        const atMs = new Date(schedule.at).getTime();
        // If the at-time is in the past, return far-future to prevent re-fire
        // (the job will be disabled after execution completes)
        if (atMs <= Date.now()) {
          return Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year from now
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
      for (const job of arr) {
        this.jobs.set(job.id, job);
      }
      console.log(`[scheduler] Loaded ${arr.length} job(s) from ${this.config.jobsFile}`);
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
