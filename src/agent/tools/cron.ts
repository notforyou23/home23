/**
 * Cron tools — schedule, list, delete, enable, disable, and update recurring/one-shot tasks.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import type { ScheduleSpec, JobPayload } from '../../scheduler/cron.js';
import { randomUUID } from 'node:crypto';

// ─── cron_schedule ──────────────────────────────────────────

export const cronScheduleTool: ToolDefinition = {
  name: 'cron_schedule',
  description: `Schedule a recurring or one-shot task.

Schedule kinds:
  cron  — standard cron expression, evaluated in the configured timezone (default America/New_York).
          Examples: "30 9 * * 1-5" = 9:30am ET weekdays, "0 */2 * * *" = every 2h on the hour.
  every — fixed interval in milliseconds. Example: 1800000 = every 30 minutes.
  at    — one-shot at an ISO 8601 datetime. Example: "2026-04-16T14:00:00-04:00".

Payload kinds:
  agentTurn — full agent loop with all tools (default). For complex tasks.
  exec      — shell command. Runs in the home23 project root. For scripts/health checks.
  query     — brain query (no tools). For lightweight lookups.

Delivery:
  delivery_to MUST be a valid, durable chat ID for the target channel:
    Telegram: a numeric user/group ID like "8317115546" or "-5204338402"
    Discord:  a numeric channel ID
  Do NOT use dashboard session IDs (dashboard-jerry-...) — those are ephemeral and stop working.
  If unsure, use "8317115546" (jtr's Telegram DM).`,
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable job name' },
      schedule_kind: { type: 'string', enum: ['cron', 'every', 'at'], description: 'Schedule type' },
      cron_expr: { type: 'string', description: 'Cron expression (required when schedule_kind=cron). E.g. "30 9 * * 1-5"' },
      every_ms: { type: 'number', description: 'Interval in ms (required when schedule_kind=every). E.g. 1800000 for 30min.' },
      at: { type: 'string', description: 'ISO datetime (required when schedule_kind=at). E.g. "2026-04-16T14:00:00-04:00"' },
      timezone: { type: 'string', description: 'Timezone for cron evaluation (default: America/New_York)' },
      payload_kind: { type: 'string', enum: ['agentTurn', 'exec', 'query'], description: 'Payload type (default: agentTurn)' },
      message: { type: 'string', description: 'Prompt (agentTurn/query) or shell command (exec)' },
      model: { type: 'string', description: 'Model alias override for agentTurn/query (e.g. "sonnet"). Omit for agent default.' },
      timeout_seconds: { type: 'number', description: 'Max seconds before timeout. Defaults: agentTurn=300, exec=60, query=120.' },
      delivery_channel: { type: 'string', description: 'Channel: "telegram", "discord", or "auto" (first available). Default: auto.' },
      delivery_to: { type: 'string', description: 'Durable chat ID for delivery (Telegram numeric ID, Discord channel ID). REQUIRED for delivery to work.' },
      announce_mode: { type: 'string', enum: ['none', 'failures', 'summary', 'full'], description: 'When to deliver results (default: failures)' },
      cwd: { type: 'string', description: 'Working directory for exec commands (default: home23 project root)' },
    },
    required: ['name', 'schedule_kind', 'message'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const kind = input.schedule_kind as string;
    let schedule: ScheduleSpec;

    // Validate + build schedule
    if (kind === 'cron') {
      const expr = input.cron_expr as string | undefined;
      if (!expr || typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) {
        return { content: `Invalid or missing cron_expr. Must be a 5-field cron expression like "30 9 * * 1-5".`, is_error: true };
      }
      schedule = { kind: 'cron', expr: expr.trim(), tz: (input.timezone as string) || 'America/New_York' };
    } else if (kind === 'every') {
      const ms = input.every_ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 10_000) {
        return { content: `Invalid every_ms: must be a number >= 10000 (10 seconds). Got: ${JSON.stringify(ms)}`, is_error: true };
      }
      schedule = { kind: 'every', everyMs: ms };
    } else if (kind === 'at') {
      const at = input.at as string | undefined;
      if (!at || typeof at !== 'string') {
        return { content: `Missing "at" field. Must be an ISO 8601 datetime string.`, is_error: true };
      }
      const parsed = new Date(at).getTime();
      if (isNaN(parsed)) {
        return { content: `Invalid "at" datetime: "${at}". Use ISO 8601, e.g. "2026-04-16T14:00:00-04:00".`, is_error: true };
      }
      schedule = { kind: 'at', at };
    } else {
      return { content: `Unknown schedule_kind: "${kind}". Use cron, every, or at.`, is_error: true };
    }

    // Build payload
    const payloadKind = (input.payload_kind as string) || 'agentTurn';
    const message = input.message as string;
    const timeoutSeconds = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : undefined;
    const model = typeof input.model === 'string' ? input.model : undefined;
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;

    let payload: JobPayload;
    if (payloadKind === 'exec') {
      payload = { kind: 'exec', command: message, ...(timeoutSeconds ? { timeoutSeconds } : {}), ...(cwd ? { cwd } : {}) } as JobPayload;
    } else if (payloadKind === 'query') {
      payload = { kind: 'query', message, ...(model ? { model } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
    } else {
      payload = { kind: 'agentTurn', message, ...(model ? { model } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
    }

    // Delivery — warn about ephemeral chatIds
    const deliveryTo = (input.delivery_to as string) || '';
    if (!deliveryTo) {
      console.warn(`[cron_schedule] Job "${input.name}" created with no delivery_to — delivery will fail.`);
    } else if (deliveryTo.startsWith('dashboard-')) {
      console.warn(`[cron_schedule] Job "${input.name}" has ephemeral dashboard chatId as delivery_to — this won't survive browser close.`);
    }

    const id = `agent-${randomUUID()}`;
    const job = {
      id,
      name: input.name as string,
      enabled: true,
      schedule,
      sessionTarget: 'isolated' as const,
      wakeMode: 'now' as const,
      payload,
      delivery: {
        mode: ((input.announce_mode as 'none' | 'failures' | 'summary' | 'full') || 'failures'),
        channel: (input.delivery_channel as string) || 'auto',
        to: deliveryTo,
      },
      state: { nextRunAtMs: 0, consecutiveErrors: 0 },
    };

    ctx.scheduler.addJob(job);

    const warnings: string[] = [];
    if (!deliveryTo) warnings.push('⚠ No delivery_to set — results won\'t be delivered anywhere.');
    if (deliveryTo.startsWith('dashboard-')) warnings.push('⚠ delivery_to is a dashboard session ID — use a Telegram numeric ID instead.');

    return { content: `Job "${job.name}" scheduled (id: ${id}, ${kind}, payload: ${payloadKind})${warnings.length ? '\n' + warnings.join('\n') : ''}` };
  },
};

// ─── cron_list ──────────────────────────────────────────────

export const cronListTool: ToolDefinition = {
  name: 'cron_list',
  description: 'List all scheduled cron jobs with their status, schedule, delivery target, and next run time.',
  input_schema: {
    type: 'object',
    properties: {
      show_disabled: { type: 'boolean', description: 'Include disabled jobs (default: false)' },
    },
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const showDisabled = input.show_disabled === true;
    let jobs = ctx.scheduler.getJobs();
    if (!showDisabled) jobs = jobs.filter(j => j.enabled);
    if (jobs.length === 0) return { content: showDisabled ? 'No scheduled jobs.' : 'No enabled jobs. Use show_disabled=true to see all.' };

    const lines = jobs.map(j => {
      const nextRun = (j.state.nextRunAtMs && j.state.nextRunAtMs > 0)
        ? new Date(j.state.nextRunAtMs).toISOString()
        : 'not scheduled';
      const status = j.enabled ? '✓ enabled' : '✗ disabled';
      const s = j.schedule as Record<string, unknown>;
      const sched = s.kind === 'cron' ? `cron "${s.expr}"`
        : s.kind === 'every' ? `every ${(Number(s.everyMs) / 1000)}s`
        : s.kind === 'at' ? `at ${s.at}`
        : String(s.kind);
      const deliver = j.delivery ? `→ ${j.delivery.channel}:${j.delivery.to || '(none)'}` : '';
      const errs = j.state.consecutiveErrors > 0 ? ` [${j.state.consecutiveErrors} errors]` : '';
      const lastStatus = j.state.lastStatus ? ` last:${j.state.lastStatus}` : '';
      return `[${j.id}] ${j.name} — ${status}, ${sched}, next: ${nextRun} ${deliver}${errs}${lastStatus}`;
    });

    return { content: lines.join('\n') };
  },
};

// ─── cron_delete ────────────────────────────────────────────

export const cronDeleteTool: ToolDefinition = {
  name: 'cron_delete',
  description: 'Delete a scheduled job by ID. Use cron_list to find IDs.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job ID to delete' },
    },
    required: ['job_id'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const id = input.job_id as string;
    const job = ctx.scheduler.getJob(id);
    if (!job) return { content: `Job not found: ${id}`, is_error: true };

    ctx.scheduler.removeJob(id);
    return { content: `Deleted job: ${job.name} (${id})` };
  },
};

// ─── cron_enable ────────────────────────────────────────────

export const cronEnableTool: ToolDefinition = {
  name: 'cron_enable',
  description: 'Enable a disabled scheduled job by ID. Recomputes the next run time.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job ID to enable' },
    },
    required: ['job_id'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const id = input.job_id as string;
    const job = ctx.scheduler.getJob(id);
    if (!job) return { content: `Job not found: ${id}`, is_error: true };
    if (job.enabled) return { content: `Job "${job.name}" is already enabled.` };

    ctx.scheduler.enableJob(id);
    const updated = ctx.scheduler.getJob(id);
    const next = updated?.state.nextRunAtMs ? new Date(updated.state.nextRunAtMs).toISOString() : 'unknown';
    return { content: `Enabled job: ${job.name} (${id}). Next run: ${next}` };
  },
};

// ─── cron_disable ───────────────────────────────────────────

export const cronDisableTool: ToolDefinition = {
  name: 'cron_disable',
  description: 'Disable a scheduled job without deleting it. Preserves run history and state.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job ID to disable' },
    },
    required: ['job_id'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const id = input.job_id as string;
    const job = ctx.scheduler.getJob(id);
    if (!job) return { content: `Job not found: ${id}`, is_error: true };
    if (!job.enabled) return { content: `Job "${job.name}" is already disabled.` };

    ctx.scheduler.disableJob(id);
    return { content: `Disabled job: ${job.name} (${id}). Use cron_enable to re-enable.` };
  },
};

// ─── cron_update ────────────────────────────────────────────

export const cronUpdateTool: ToolDefinition = {
  name: 'cron_update',
  description: `Update an existing job's fields without deleting it. Preserves run history, state, and job ID. Only the provided fields are changed; omit fields to keep their current value.`,
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job ID to update' },
      name: { type: 'string', description: 'New human-readable name' },
      message: { type: 'string', description: 'New prompt/command' },
      cron_expr: { type: 'string', description: 'New cron expression (only for cron jobs)' },
      every_ms: { type: 'number', description: 'New interval in ms (only for every jobs)' },
      delivery_to: { type: 'string', description: 'New delivery target (e.g. Telegram numeric ID)' },
      delivery_channel: { type: 'string', description: 'New delivery channel' },
      announce_mode: { type: 'string', enum: ['none', 'failures', 'summary', 'full'], description: 'New delivery mode' },
      timeout_seconds: { type: 'number', description: 'New timeout in seconds' },
      model: { type: 'string', description: 'New model alias override' },
    },
    required: ['job_id'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const id = input.job_id as string;
    const job = ctx.scheduler.getJob(id);
    if (!job) return { content: `Job not found: ${id}`, is_error: true };

    const changes: string[] = [];

    if (typeof input.name === 'string') { job.name = input.name; changes.push(`name → "${input.name}"`); }
    if (typeof input.message === 'string') {
      if (job.payload.kind === 'exec') {
        (job.payload as { command: string }).command = input.message;
      } else {
        (job.payload as { message: string }).message = input.message;
      }
      changes.push(`message updated`);
    }
    if (typeof input.cron_expr === 'string' && job.schedule.kind === 'cron') {
      (job.schedule as { expr: string }).expr = input.cron_expr;
      changes.push(`cron_expr → "${input.cron_expr}"`);
    }
    if (typeof input.every_ms === 'number' && job.schedule.kind === 'every') {
      (job.schedule as { everyMs: number }).everyMs = input.every_ms;
      changes.push(`every_ms → ${input.every_ms}`);
    }
    if (typeof input.delivery_to === 'string' && job.delivery) {
      job.delivery.to = input.delivery_to;
      changes.push(`delivery_to → "${input.delivery_to}"`);
    }
    if (typeof input.delivery_channel === 'string' && job.delivery) {
      job.delivery.channel = input.delivery_channel;
      changes.push(`delivery_channel → "${input.delivery_channel}"`);
    }
    if (typeof input.announce_mode === 'string' && job.delivery) {
      job.delivery.mode = input.announce_mode as 'none' | 'failures' | 'summary' | 'full';
      changes.push(`announce_mode → "${input.announce_mode}"`);
    }
    if (typeof input.timeout_seconds === 'number') {
      (job.payload as Record<string, unknown>).timeoutSeconds = input.timeout_seconds;
      changes.push(`timeout → ${input.timeout_seconds}s`);
    }
    if (typeof input.model === 'string') {
      (job.payload as Record<string, unknown>).model = input.model;
      changes.push(`model → "${input.model}"`);
    }

    if (changes.length === 0) return { content: `No changes specified for job ${id}.` };

    // Recompute next run if schedule changed
    if (input.cron_expr || input.every_ms) {
      ctx.scheduler.enableJob(id); // triggers recompute
    } else {
      // Just persist the changes
      ctx.scheduler.addJob(job); // addJob re-sets + persists
    }

    return { content: `Updated job "${job.name}" (${id}):\n${changes.join('\n')}` };
  },
};
