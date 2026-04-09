/**
 * Cron tools — schedule, list, and delete recurring/one-shot tasks.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import type { ScheduleSpec } from '../../scheduler/cron.js';
import { randomUUID } from 'node:crypto';

export const cronScheduleTool: ToolDefinition = {
  name: 'cron_schedule',
  description: 'Schedule a task. Supports cron expressions (e.g., "0 9 * * *" for 9am daily), fixed intervals (everyMs), or one-shot (ISO datetime). Payload kinds: agentTurn (full tool access), exec (shell command), query (brain query, no tools).',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable job name' },
      schedule_kind: { type: 'string', enum: ['cron', 'every', 'at'], description: 'Schedule type' },
      cron_expr: { type: 'string', description: 'Cron expression (for kind=cron), e.g., "30 9 * * 1-5"' },
      every_ms: { type: 'number', description: 'Interval in ms (for kind=every)' },
      at: { type: 'string', description: 'ISO datetime string (for kind=at, one-shot)' },
      timezone: { type: 'string', description: 'Timezone (default: America/New_York)' },
      payload_kind: { type: 'string', enum: ['agentTurn', 'exec', 'query'], description: 'Payload type: agentTurn (full AgentLoop + tools), exec (shell command), query (brain query). Default: agentTurn' },
      message: { type: 'string', description: 'The message/prompt (for agentTurn/query) or shell command (for exec)' },
      delivery_channel: { type: 'string', description: 'Channel to deliver results to (default: auto — uses first available channel)' },
      delivery_to: { type: 'string', description: 'Chat ID to deliver to' },
      announce_mode: { type: 'string', enum: ['none', 'failures', 'summary', 'full'], description: 'Delivery verbosity for cron results (default: failures)' },
    },
    required: ['name', 'schedule_kind', 'message'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const kind = input.schedule_kind as string;
    let schedule: ScheduleSpec;

    if (kind === 'cron') {
      schedule = { kind: 'cron', expr: input.cron_expr as string, tz: (input.timezone as string) || 'America/New_York' };
    } else if (kind === 'every') {
      schedule = { kind: 'every', everyMs: input.every_ms as number };
    } else if (kind === 'at') {
      schedule = { kind: 'at', at: input.at as string };
    } else {
      return { content: `Unknown schedule kind: ${kind}`, is_error: true };
    }

    const payloadKind = (input.payload_kind as string) || 'agentTurn';
    const message = input.message as string;

    let payload: import('../../scheduler/cron.js').JobPayload;
    if (payloadKind === 'exec') {
      payload = { kind: 'exec', command: message };
    } else if (payloadKind === 'query') {
      payload = { kind: 'query', message };
    } else {
      payload = { kind: 'agentTurn', message };
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
        to: (input.delivery_to as string) || ctx.chatId,
      },
      state: { nextRunAtMs: 0, consecutiveErrors: 0 },
    };

    ctx.scheduler.addJob(job);
    return { content: `Job "${job.name}" scheduled (id: ${id}, ${kind}, payload: ${payloadKind})` };
  },
};

export const cronListTool: ToolDefinition = {
  name: 'cron_list',
  description: 'List all scheduled cron jobs with their status and next run time.',
  input_schema: {
    type: 'object',
    properties: {},
  },

  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.scheduler) {
      return { content: 'Scheduler not available.', is_error: true };
    }

    const jobs = ctx.scheduler.getJobs();
    if (jobs.length === 0) return { content: 'No scheduled jobs.' };

    const lines = jobs.map(j => {
      const nextRun = j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : 'not scheduled';
      const status = j.enabled ? 'enabled' : 'disabled';
      return `[${j.id}] ${j.name} — ${status}, next: ${nextRun}`;
    });

    return { content: lines.join('\n') };
  },
};

export const cronDeleteTool: ToolDefinition = {
  name: 'cron_delete',
  description: 'Delete a scheduled job by ID.',
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
