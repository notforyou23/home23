/**
 * COSMO Home 2.3 — Cron Scheduler
 *
 * Manages scheduled jobs with cron expressions, fixed intervals,
 * and one-shot timers. Jobs are persisted to disk and run logs
 * are appended as JSONL per job.
 *
 * Built-in cron parser — no external dependencies.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, unlinkSync, rmSync } from 'node:fs';
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
  lastSemanticStatus?: JobSemanticStatus;
  consecutiveNoConsequence?: number;
  lastDurationMs?: number;
  consecutiveErrors: number;
  lastDecisionAtMs?: number;
  lastDecisionAction?: JobDecisionAction;
  lastDecisionReason?: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  queueClass?: 'real_time' | 'scheduled' | 'background';
  schedule: ScheduleSpec;
  sessionTarget: 'isolated' | 'main';
  wakeMode: 'now' | 'next-heartbeat';
  payload: JobPayload;
  delivery?: DeliveryConfig;
  agency?: {
    pursuitId?: string;
    charterRule?: string;
    auditedAt?: string;
    auditDecision?: string;
    retiredAt?: string;
    retireReason?: string;
  };
  state: JobState;
}

export interface JobResult {
  status: 'ok' | 'error';
  response?: string;
  error?: string;
  durationMs: number;
  semanticStatus?: Exclude<JobSemanticStatus, 'withheld'>;
  outcomeLayers?: Partial<Record<JobOutcomeLayer, JobOutcomeLayerReceipt>>;
  artifacts?: string[];
}

export type JobHandler = (job: CronJob) => Promise<JobResult>;

export type JobDecisionAction = 'run' | 'repair' | 'skip' | 'catch_up' | 'defer' | 'escalate';
export type JobSemanticStatus = 'satisfied' | 'failed' | 'unknown' | 'withheld';
export type JobOutcomeLayer = 'calendar' | 'scheduler' | 'process' | 'task' | 'state' | 'artifact' | 'delivery' | 'intent';
export type JobOutcomeLayerStatus = 'success' | 'failed' | 'skipped' | 'unknown' | 'not_applicable';

export interface JobOutcomeLayerReceipt {
  status: JobOutcomeLayerStatus;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface JobOutcomeReceipt {
  schema: 'home23.scheduler.job-outcome.v1';
  sourceIssue: number;
  runId: string;
  jobId: string;
  jobName: string;
  recordedAt: string;
  mechanicalStatus: JobResult['status'];
  semanticStatus: JobSemanticStatus;
  resourceContract?: JobResourceContract;
  layers: Record<JobOutcomeLayer, JobOutcomeLayerReceipt>;
}

export interface JobRunLogEntry {
  runId?: string;
  jobId?: string;
  timestamp?: string;
  status?: JobResult['status'];
  response?: string;
  error?: string;
  durationMs?: number;
  decision?: JobDecision;
  outcome?: JobOutcomeReceipt;
  withheld?: boolean;
}

export interface JobResourceContract {
  schema: 'home23.scheduler.resource-contract.v1';
  sourceIssue: 98;
  priority: 'real_time' | 'scheduled' | 'background';
  commitment: string;
  maxRuntimeSeconds: number | null;
  pressureBehavior: string;
  retryPosture: string;
  outputObligation: string;
  duplicateDetection: string;
  stopCondition: string;
  receipt: string;
}

export interface JobDecision {
  schema: 'home23.scheduler.job-decision.v1';
  decisionId: string;
  jobId: string;
  jobName: string;
  decidedAt: string;
  source: 'scheduled' | 'manual';
  action: JobDecisionAction;
  reason: string;
  durableState: 'allowed_after_decision' | 'withheld_after_decision';
  willExecute: boolean;
  scheduleKind: ScheduleSpec['kind'];
  payloadKind: JobPayload['kind'];
  dueAt: string | null;
  overdueMs: number;
  consecutiveErrors: number;
  inputFreshness: {
    status: 'unknown' | 'current' | 'stale' | 'invalid';
    reason: string;
  };
  sourceIssue: number;
  resourceContract: JobResourceContract;
  nextReviewAtMs?: number;
}

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
  private decisionsFilePath: string;
  private ownerId = `${process.pid}-${randomUUID()}`;
  private ownershipDirPath: string;
  private ownershipFilePath: string;
  private ownershipLeaseMs: number;

  constructor(config: SchedulerConfig, handler: JobHandler, runtimeDir: string) {
    this.config = config;
    this.handler = handler;
    this.runtimeDir = runtimeDir;
    this.jobsFilePath = join(runtimeDir, config.jobsFile);
    this.runsDirPath = join(runtimeDir, config.runsDir);
    this.decisionsFilePath = join(runtimeDir, 'cron-decisions.jsonl');
    this.ownershipDirPath = join(runtimeDir, 'cron-scheduler.lock');
    this.ownershipFilePath = join(this.ownershipDirPath, 'owner.json');
    this.ownershipLeaseMs = config.ownershipLeaseMs ?? 2 * 60 * 1000;

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
    void this.tick();
    this.tickTimer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (!this.running) {
      this.releaseOwnership();
      return;
    }
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.releaseOwnership();
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

  /** Persist an existing job without recomputing nextRunAtMs. Use for non-schedule edits. */
  saveJob(job: CronJob): void {
    if (!this.jobs.has(job.id)) {
      console.warn(`[scheduler] saveJob called for unknown id ${job.id} — delegating to addJob`);
      this.addJob(job);
      return;
    }
    this.jobs.set(job.id, job);
    this.saveJobs();
    console.log(`[scheduler] Job saved: ${job.id} (${job.name})`);
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

  getRecentRuns(jobId: string, limit = 5): JobRunLogEntry[] {
    const logPath = join(this.runsDirPath, `${jobId}.jsonl`);
    if (!existsSync(logPath)) return [];
    try {
      return readFileSync(logPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .slice(-Math.max(0, limit))
        .map((line) => JSON.parse(line) as JobRunLogEntry)
        .reverse();
    } catch (err) {
      console.error(`[scheduler] Failed to read run log for ${jobId}:`, err);
      return [];
    }
  }

  async runJobNow(id: string): Promise<JobResult> {
    if (!this.ensureOwnership()) {
      return {
        status: 'error',
        error: 'scheduler lease held by another process',
        durationMs: 0,
      };
    }
    const job = this.jobs.get(id);
    if (!job) {
      return {
        status: 'error',
        error: `Job not found: ${id}`,
        durationMs: 0,
      };
    }

    const decision = this.decideJobPreflight(job, Date.now(), 'manual');
    this.appendDecisionLog(decision);
    if (!decision.willExecute) {
      return this.withholdJob(job, decision);
    }

    return await this.executeJob(job, decision);
  }

  // ─── Tick Loop ─────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.ensureOwnership()) return;

    const now = Date.now();
    const dueJobs: CronJob[] = [];

    for (const job of this.jobs.values()) {
      if (job.enabled && now >= job.state.nextRunAtMs) {
        dueJobs.push(job);
      }
    }

    if (dueJobs.length > 0) {
      const runnable: Array<{ job: CronJob; decision: JobDecision }> = [];
      const hasForegroundDue = dueJobs.some((job) => this.queueClass(job) !== 'background');
      dueJobs.sort((a, b) => this.queuePriority(a) - this.queuePriority(b));

      // Pre-compute next run BEFORE firing to prevent double-fire
      // (if a job takes >30s, the next tick would see it as still due).
      // One-shot 'at' jobs: disable here so the next tick won't re-queue.
      for (const job of dueJobs) {
        const decision = hasForegroundDue && this.queueClass(job) === 'background'
          ? this.deferBackgroundJob(job, now)
          : this.decideJobPreflight(job, now, 'scheduled');
        this.appendDecisionLog(decision);
        if (!decision.willExecute) {
          this.withholdJob(job, decision);
          continue;
        }

        if (job.schedule.kind === 'at') {
          job.enabled = false;
        }
        job.state.nextRunAtMs = this.computeNextRun(job);
        job.state.lastDecisionAtMs = now;
        job.state.lastDecisionAction = decision.action;
        job.state.lastDecisionReason = decision.reason;
        runnable.push({ job, decision });
      }
      this.saveJobs();

      // Fire all due jobs concurrently (don't block tick)
      await Promise.allSettled(runnable.map(({ job, decision }) => this.executeJob(job, decision).catch(err => {
          console.error(`[scheduler] Unhandled error executing job ${job.id}:`, err);
      })));
    }
  }

  private async executeJob(job: CronJob, decision?: JobDecision): Promise<JobResult> {
    const startMs = Date.now();
    const runId = `sched-run-${randomUUID().slice(0, 12)}`;
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

    let outcome = this.buildOutcomeReceipt(job, result, {
      runId,
      recordedAtMs: Date.now(),
      decision,
      withheld: false,
      statePersisted: true,
    });
    job.state.lastSemanticStatus = outcome.semanticStatus;
    this.updateNoConsequenceState(job, outcome.semanticStatus);
    const statePersisted = this.saveJobs();
    if (!statePersisted) {
      outcome = this.buildOutcomeReceipt(job, result, {
        runId,
        recordedAtMs: Date.now(),
        decision,
        withheld: false,
        statePersisted: false,
      });
      job.state.lastSemanticStatus = outcome.semanticStatus;
      this.updateNoConsequenceState(job, outcome.semanticStatus);
    }

    // Append run log
    this.appendRunLog(job.id, {
      runId,
      jobId: job.id,
      timestamp: new Date(startMs).toISOString(),
      status: result.status,
      response: result.response,
      error: result.error,
      durationMs: result.durationMs,
      decision,
      outcome,
    });

    const statusTag = result.status === 'ok' ? 'OK' : 'ERROR';
    console.log(`[scheduler] Job ${job.id} ${statusTag} semantic=${outcome.semanticStatus} (${result.durationMs}ms)`);
    return result;
  }

  private decideJobPreflight(job: CronJob, now: number, source: JobDecision['source']): JobDecision {
    const dueAtMs = Number(job.state?.nextRunAtMs);
    const overdueMs = Number.isFinite(dueAtMs) ? Math.max(0, now - dueAtMs) : 0;
    const invalidReason = this.invalidJobReason(job);
    let action: JobDecisionAction = 'run';
    let reason = source === 'manual' ? 'manual scheduler invocation' : 'job due and eligible';
    let willExecute = true;
    let nextReviewAtMs: number | undefined;

    if (!job.enabled) {
      action = 'skip';
      reason = 'job disabled';
      willExecute = false;
      nextReviewAtMs = now + 60 * 60 * 1000;
    } else if (invalidReason) {
      action = 'repair';
      reason = invalidReason;
      willExecute = false;
      nextReviewAtMs = now + 60 * 60 * 1000;
    } else if (source !== 'manual' && job.state.consecutiveErrors >= 3) {
      action = 'escalate';
      reason = `${job.state.consecutiveErrors} consecutive errors; withheld until operator or repair loop reviews job`;
      willExecute = false;
      nextReviewAtMs = now + 15 * 60 * 1000;
    } else if (source === 'scheduled' && overdueMs >= this.catchUpThresholdMs(job)) {
      action = 'catch_up';
      reason = `job overdue by ${overdueMs}ms; executing once as catch-up`;
    } else if (source === 'scheduled' && Number.isFinite(dueAtMs) && now < dueAtMs) {
      action = 'defer';
      reason = 'job not due yet';
      willExecute = false;
      nextReviewAtMs = dueAtMs;
    }

    return {
      schema: 'home23.scheduler.job-decision.v1',
      decisionId: `sched-dec-${randomUUID().slice(0, 12)}`,
      jobId: job.id,
      jobName: job.name,
      decidedAt: new Date(now).toISOString(),
      source,
      action,
      reason,
      durableState: willExecute ? 'allowed_after_decision' : 'withheld_after_decision',
      willExecute,
      scheduleKind: job.schedule.kind,
      payloadKind: job.payload.kind,
      dueAt: Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : null,
      overdueMs,
      consecutiveErrors: job.state.consecutiveErrors,
      inputFreshness: invalidReason
        ? { status: 'invalid', reason: invalidReason }
        : { status: 'unknown', reason: 'no job-specific freshness contract configured' },
      sourceIssue: 82,
      resourceContract: this.buildResourceContract(job),
      nextReviewAtMs,
    };
  }

  private queueClass(job: CronJob): 'real_time' | 'scheduled' | 'background' {
    return job.queueClass ?? 'scheduled';
  }

  private queuePriority(job: CronJob): number {
    switch (this.queueClass(job)) {
      case 'real_time': return 0;
      case 'scheduled': return 1;
      case 'background': return 2;
      default: return 1;
    }
  }

  private deferBackgroundJob(job: CronJob, now: number): JobDecision {
    const dueAtMs = Number(job.state?.nextRunAtMs);
    const nextReviewAtMs = now + 5 * 60 * 1000;
    return {
      schema: 'home23.scheduler.job-decision.v1',
      decisionId: `sched-dec-${randomUUID().slice(0, 12)}`,
      jobId: job.id,
      jobName: job.name,
      decidedAt: new Date(now).toISOString(),
      source: 'scheduled',
      action: 'defer',
      reason: 'background work deferred because foreground scheduled work is due; keep utilization below the queueing knee',
      durableState: 'withheld_after_decision',
      willExecute: false,
      scheduleKind: job.schedule.kind,
      payloadKind: job.payload.kind,
      dueAt: Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : null,
      overdueMs: Number.isFinite(dueAtMs) ? Math.max(0, now - dueAtMs) : 0,
      consecutiveErrors: job.state.consecutiveErrors,
      inputFreshness: { status: 'current', reason: 'load-shedding deferral, not input failure' },
      sourceIssue: 71,
      resourceContract: this.buildResourceContract(job),
      nextReviewAtMs,
    };
  }

  private buildResourceContract(job: CronJob): JobResourceContract {
    const priority = this.queueClass(job);
    const timeoutSeconds = 'timeoutSeconds' in job.payload && Number.isFinite(job.payload.timeoutSeconds)
      ? Number(job.payload.timeoutSeconds)
      : null;
    const deliveryMode = job.delivery?.mode && job.delivery.mode !== 'none'
      ? `delivery ${job.delivery.mode}`
      : 'no delivery target';
    const outputObligation = [
      deliveryMode,
      'handler should report artifacts or semanticStatus when the job promises durable output',
    ].join('; ');

    return {
      schema: 'home23.scheduler.resource-contract.v1',
      sourceIssue: 98,
      priority,
      commitment: `${job.name || job.id} (${job.payload.kind})`,
      maxRuntimeSeconds: timeoutSeconds,
      pressureBehavior: priority === 'background'
        ? 'defer when foreground scheduled work is due'
        : 'may run when eligible; background jobs yield first',
      retryPosture: 'escalate after 3 consecutive errors before executing again',
      outputObligation,
      duplicateDetection: `job id ${job.id}; isolated cron history cron-${job.id}`,
      stopCondition: job.schedule.kind === 'at'
        ? 'one one-shot scheduler firing, then disable'
        : 'one eligible scheduler firing per decision receipt',
      receipt: `cron-decisions.jsonl plus cron-runs/${job.id}.jsonl outcome receipt`,
    };
  }

  private invalidJobReason(job: CronJob): string | null {
    if (!job.id || !job.name) return 'job identity missing';
    if (!job.schedule?.kind) return 'schedule missing';
    if (!job.payload?.kind) return 'payload missing';

    if (job.schedule.kind === 'cron' && !(job.schedule as { expr?: string }).expr) {
      return 'cron expression missing';
    }
    if (job.schedule.kind === 'every' && !Number.isFinite((job.schedule as { everyMs?: number }).everyMs)) {
      return 'interval schedule missing everyMs';
    }
    if (job.schedule.kind === 'at') {
      const at = (job.schedule as { at?: string }).at;
      if (!at || Number.isNaN(new Date(at).getTime())) return 'one-shot schedule has invalid at time';
    }

    switch (job.payload.kind) {
      case 'exec':
        return job.payload.command ? null : 'exec payload missing command';
      case 'query':
        return job.payload.message ? null : 'query payload missing message';
      case 'systemEvent':
        return job.payload.text ? null : 'systemEvent payload missing text';
      case 'agentTurn':
        return job.payload.message || job.payload.messagePath ? null : 'agentTurn payload missing message or messagePath';
      default:
        return 'unknown payload kind';
    }
  }

  private catchUpThresholdMs(job: CronJob): number {
    if (job.schedule.kind === 'every') {
      return Math.max(job.schedule.everyMs * 2, 5 * 60 * 1000);
    }
    if (job.schedule.kind === 'at') {
      return 60 * 1000;
    }
    return 60 * 60 * 1000;
  }

  private withholdJob(job: CronJob, decision: JobDecision): JobResult {
    const decidedAtMs = Date.parse(decision.decidedAt);
    const reviewAtMs = decision.nextReviewAtMs ?? decidedAtMs + 15 * 60 * 1000;
    const isLoadDeferral = decision.action === 'defer' && decision.sourceIssue === 71;
    const runId = `sched-run-${randomUUID().slice(0, 12)}`;
    const result: JobResult = {
      status: isLoadDeferral ? 'ok' : 'error',
      error: `${decision.action}: ${decision.reason}`,
      durationMs: 0,
    };

    job.state.lastStatus = result.status;
    job.state.lastDurationMs = 0;
    if (isLoadDeferral) {
      job.state.consecutiveErrors = 0;
    }
    job.state.lastDecisionAtMs = decidedAtMs;
    job.state.lastDecisionAction = decision.action;
    job.state.lastDecisionReason = decision.reason;
    job.state.nextRunAtMs = Math.max(reviewAtMs, Date.now() + 60_000);
    let outcome = this.buildOutcomeReceipt(job, result, {
      runId,
      recordedAtMs: decidedAtMs,
      decision,
      withheld: true,
      statePersisted: true,
    });
    job.state.lastSemanticStatus = outcome.semanticStatus;
    this.updateNoConsequenceState(job, outcome.semanticStatus);
    const statePersisted = this.saveJobs();
    if (!statePersisted) {
      outcome = this.buildOutcomeReceipt(job, result, {
        runId,
        recordedAtMs: decidedAtMs,
        decision,
        withheld: true,
        statePersisted: false,
      });
      job.state.lastSemanticStatus = outcome.semanticStatus;
      this.updateNoConsequenceState(job, outcome.semanticStatus);
    }
    this.appendRunLog(job.id, {
      runId,
      jobId: job.id,
      timestamp: decision.decidedAt,
      status: result.status,
      error: result.error,
      durationMs: 0,
      withheld: true,
      decision,
      outcome,
    });
    console.warn(`[scheduler] Job ${job.id} withheld: ${decision.action} (${decision.reason})`);
    return result;
  }

  private buildOutcomeReceipt(
    job: CronJob,
    result: JobResult,
    options: {
      runId: string;
      recordedAtMs: number;
      decision?: JobDecision;
      withheld: boolean;
      statePersisted: boolean;
    },
  ): JobOutcomeReceipt {
    const decisionAction = options.decision?.action ?? 'run';
    const deliveryConfigured = Boolean(job.delivery && job.delivery.mode !== 'none');
    const deliveryFailed = result.error?.startsWith('Delivery failed:') ?? false;
    const processLayer: JobOutcomeLayerReceipt = options.withheld
      ? { status: 'skipped', reason: `process not invoked because scheduler decision was ${decisionAction}` }
      : result.status === 'ok'
        ? { status: 'success', reason: 'handler process completed without throwing' }
        : { status: 'failed', reason: result.error ?? 'handler process returned error' };

    const layers: Record<JobOutcomeLayer, JobOutcomeLayerReceipt> = {
      calendar: options.decision
        ? {
            status: 'success',
            reason: options.decision.source === 'manual'
              ? 'manual scheduler invocation reached decision gate'
              : 'scheduled wake reached decision gate',
          }
        : { status: 'unknown', reason: 'no decision receipt was supplied' },
      scheduler: options.withheld
        ? { status: 'skipped', reason: `scheduler withheld execution: ${decisionAction}` }
        : { status: 'success', reason: `scheduler allowed ${decisionAction} execution before durable state advance` },
      process: processLayer,
      task: options.withheld
        ? { status: 'skipped', reason: 'task not attempted because scheduler withheld execution' }
        : result.status === 'ok'
          ? { status: 'success', reason: 'task handler returned ok' }
          : { status: 'failed', reason: result.error ?? 'task handler returned error' },
      state: options.statePersisted
        ? { status: 'success', reason: 'job state persisted after decision/run update' }
        : { status: 'failed', reason: 'job state persistence failed after decision/run update' },
      artifact: Array.isArray(result.artifacts) && result.artifacts.length > 0
        ? { status: 'success', reason: 'handler reported durable artifact output', evidence: { artifacts: result.artifacts } }
        : { status: 'unknown', reason: 'no artifact contract or artifact output was reported' },
      delivery: !deliveryConfigured
        ? { status: 'not_applicable', reason: 'job has no delivery target or delivery mode is none' }
        : deliveryFailed
          ? { status: 'failed', reason: result.error ?? 'delivery failed' }
          : result.status === 'ok'
            ? { status: 'success', reason: 'configured delivery completed or was skipped by delivery policy' }
            : { status: 'unknown', reason: 'handler failed before delivery success could be established' },
      intent: result.semanticStatus === 'satisfied'
        ? { status: 'success', reason: 'handler reported intended outcome satisfied' }
        : result.semanticStatus === 'failed'
          ? { status: 'failed', reason: 'handler reported intended outcome failed' }
          : { status: 'unknown', reason: 'no intent satisfaction contract was reported' },
    };

    for (const [layer, receipt] of Object.entries(result.outcomeLayers ?? {}) as Array<[JobOutcomeLayer, JobOutcomeLayerReceipt]>) {
      if (receipt?.status && receipt.reason) {
        layers[layer] = receipt;
      }
    }

    const semanticStatus = this.deriveSemanticStatus(result, layers, options.withheld);
    return {
      schema: 'home23.scheduler.job-outcome.v1',
      sourceIssue: 82,
      runId: options.runId,
      jobId: job.id,
      jobName: job.name,
      recordedAt: new Date(options.recordedAtMs).toISOString(),
      mechanicalStatus: result.status,
      semanticStatus,
      resourceContract: options.decision?.resourceContract ?? this.buildResourceContract(job),
      layers,
    };
  }

  private deriveSemanticStatus(
    result: JobResult,
    layers: Record<JobOutcomeLayer, JobOutcomeLayerReceipt>,
    withheld: boolean,
  ): JobSemanticStatus {
    if (withheld) return 'withheld';
    if (result.status === 'error') return 'failed';

    const failedLayer = Object.values(layers).some((layer) => layer.status === 'failed');
    if (failedLayer) return 'failed';
    if (result.semanticStatus === 'satisfied') return 'satisfied';
    if (layers.intent.status === 'success') return 'satisfied';
    return 'unknown';
  }

  private updateNoConsequenceState(job: CronJob, semanticStatus: JobSemanticStatus): void {
    if (semanticStatus === 'unknown') {
      job.state.consecutiveNoConsequence = Number(job.state.consecutiveNoConsequence || 0) + 1;
      return;
    }
    job.state.consecutiveNoConsequence = 0;
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

  private saveJobs(): boolean {
    const arr = Array.from(this.jobs.values());
    const json = JSON.stringify(arr, null, 2);
    const tmpPath = this.jobsFilePath + `.tmp-${randomUUID().slice(0, 8)}`;

    try {
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.jobsFilePath);
      return true;
    } catch (err) {
      console.error('[scheduler] Failed to save jobs:', err);
      // Clean up temp file if rename failed
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      return false;
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

  private appendDecisionLog(decision: JobDecision): void {
    try {
      appendFileSync(this.decisionsFilePath, JSON.stringify(decision) + '\n');
    } catch (err) {
      console.error(`[scheduler] Failed to append decision log for ${decision.jobId}:`, err);
    }
  }

  private ensureOwnership(): boolean {
    const now = Date.now();

    if (this.hasOwnership()) {
      this.writeOwnership(now);
      return true;
    }

    try {
      mkdirSync(this.ownershipDirPath);
      this.writeOwnership(now);
      return true;
    } catch {
      if (!this.existingOwnerIsStale(now)) return false;
      try {
        rmSync(this.ownershipDirPath, { recursive: true, force: true });
        mkdirSync(this.ownershipDirPath);
        this.writeOwnership(now);
        return true;
      } catch {
        return this.hasOwnership();
      }
    }
  }

  private hasOwnership(): boolean {
    try {
      const owner = JSON.parse(readFileSync(this.ownershipFilePath, 'utf8')) as { ownerId?: string };
      return owner.ownerId === this.ownerId;
    } catch {
      return false;
    }
  }

  private writeOwnership(now: number): void {
    writeFileSync(this.ownershipFilePath, JSON.stringify({
      schema: 'home23.scheduler.owner.v1',
      ownerId: this.ownerId,
      pid: process.pid,
      acquiredAt: new Date(now).toISOString(),
      heartbeatAtMs: now,
    }, null, 2), 'utf8');
  }

  private existingOwnerIsStale(now: number): boolean {
    try {
      const owner = JSON.parse(readFileSync(this.ownershipFilePath, 'utf8')) as { ownerId?: string; pid?: number; heartbeatAtMs?: number };
      if (owner.ownerId === this.ownerId) return false;
      const heartbeatAtMs = Number(owner.heartbeatAtMs);
      if (Number.isFinite(heartbeatAtMs) && now - heartbeatAtMs > this.ownershipLeaseMs) return true;
      if (Number.isFinite(owner.pid) && !this.pidAlive(Number(owner.pid))) return true;
      return false;
    } catch {
      return true;
    }
  }

  private releaseOwnership(): void {
    if (!this.hasOwnership()) return;
    try {
      rmSync(this.ownershipDirPath, { recursive: true, force: true });
    } catch {
      // Best effort: stale owners are stealable by heartbeat timeout or dead pid.
    }
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
