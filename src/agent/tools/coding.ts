/**
 * Coding tools — delegate real coding work to headless CLI backends
 * (Claude Code / Codex) through the ACP bridge (Step 29).
 *
 * All tools operate against ctx.codingBridge (CodingBridgeRef). Jobs are
 * durable and detached; results are delivered by the bridge's job_finished
 * listener wired in home.ts, and remain queryable via coding_status /
 * coding_result after a harness restart.
 */

import type { ToolContext, ToolDefinition, ToolResult, CodingBridgeRef } from '../types.js';
import type { BridgeEvent, CodingJobRecord, CodingJobReceipt, CodingIsolation } from '../../acp/types.js';
import { TERMINAL_JOB_STATUSES } from '../../acp/types.js';

const MAX_WAIT_SECONDS = 600;
const RESULT_TAIL_RUN_MAX = 4000;
const RESULT_TAIL_FULL_MAX = 8000;

const BRIDGE_UNAVAILABLE: ToolResult = {
  content: 'Coding bridge unavailable (acp disabled or not configured).',
  is_error: true,
};

function getBridge(ctx: ToolContext): CodingBridgeRef | null {
  return ctx.codingBridge ?? null;
}

function bound(text: string | undefined, max: number): string {
  const value = text ?? '';
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function isTerminal(job: CodingJobRecord): boolean {
  return TERMINAL_JOB_STATUSES.includes(job.status);
}

function errorResult(prefix: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: `${prefix}: ${message}`, is_error: true };
}

function shortCwd(ctx: ToolContext, cwd: string): string {
  if (ctx.projectRoot && cwd.startsWith(ctx.projectRoot)) {
    return `.${cwd.slice(ctx.projectRoot.length)}` || '.';
  }
  return bound(cwd, 120);
}

function describeLocation(job: CodingJobRecord): string {
  if (job.worktree) {
    return `worktree ${job.worktree.path} (branch ${job.worktree.branch}, base ${job.worktree.baseCommit.slice(0, 12)})`;
  }
  if (job.checkpoint) {
    return `${job.cwd} (checkpoint at ${job.checkpoint.headCommit.slice(0, 12)}${job.checkpoint.stashCommit ? `, stash ${job.checkpoint.stashCommit.slice(0, 12)}` : ''})`;
  }
  return job.cwd;
}

function jobSummary(job: CodingJobRecord): string {
  const lines = [
    `Job: ${job.id}`,
    `Backend: ${job.backend}${job.model ? ` (${job.model})` : ''}`,
    `Status: ${job.status}`,
  ];
  if (job.label) lines.push(`Label: ${job.label}`);
  lines.push(`Cwd: ${describeLocation(job)}`);
  lines.push(`Started: ${job.startedAt}`);
  if (job.finishedAt) lines.push(`Finished: ${job.finishedAt}`);
  if (job.exitCode !== undefined && job.exitCode !== null) lines.push(`Exit code: ${job.exitCode}`);
  if (job.sessionId) lines.push(`Session: ${job.sessionId} (resumable via coding_continue)`);
  if (job.resumedFromJobId) lines.push(`Resumed from: ${job.resumedFromJobId}`);
  if (job.error) lines.push(`Error: ${bound(job.error, 500)}`);
  return lines.join('\n');
}

function renderEvent(event: BridgeEvent): string {
  switch (event.kind) {
    case 'session':
      return `session ${event.sessionId}${event.model ? ` (${event.model})` : ''}`;
    case 'text':
      return `text: ${bound(event.text.replace(/\s+/g, ' ').trim(), 160)}`;
    case 'thinking':
      return `thinking: ${bound(event.text.replace(/\s+/g, ' ').trim(), 120)}`;
    case 'tool_use':
      return `tool ${event.tool}: ${bound(event.summary, 140)}`;
    case 'result':
      return `result ok=${event.ok}${event.costUsd !== undefined ? ` cost=$${event.costUsd.toFixed(4)}` : ''}${event.numTurns !== undefined ? ` turns=${event.numTurns}` : ''}: ${bound(event.text.replace(/\s+/g, ' ').trim(), 200)}`;
    case 'other':
      return `other: ${bound(event.raw.replace(/\s+/g, ' ').trim(), 120)}`;
  }
}

function renderEventsTail(events: BridgeEvent[]): string {
  if (events.length === 0) return '(no events yet)';
  return events.map(e => `- ${renderEvent(e)}`).join('\n');
}

function mergeInstructions(receipt: Pick<CodingJobReceipt, 'worktree' | 'checkpoint'>): string[] {
  const lines: string[] = [];
  if (receipt.worktree) {
    const { repoRoot, path, branch } = receipt.worktree;
    lines.push(`Worktree: ${path} (branch ${branch})`);
    lines.push(`To merge: git -C ${repoRoot} merge ${branch}`);
    lines.push(`To discard: git -C ${repoRoot} worktree remove ${path} --force && git -C ${repoRoot} branch -D ${branch}`);
  }
  if (receipt.checkpoint?.stashCommit) {
    lines.push(`Checkpoint: git -C ${receipt.checkpoint.repoRoot} stash apply ${receipt.checkpoint.stashCommit} restores the pre-job dirty state.`);
  } else if (receipt.checkpoint) {
    lines.push(`Checkpoint: tree was clean at ${receipt.checkpoint.headCommit.slice(0, 12)}; git -C ${receipt.checkpoint.repoRoot} diff ${receipt.checkpoint.headCommit} shows what the job changed.`);
  }
  return lines;
}

function receiptSummary(receipt: CodingJobReceipt, resultTailMax: number): string {
  const lines = [
    `Job ${receipt.jobId}: ${receipt.status}`,
    `Backend: ${receipt.backend}${receipt.model ? ` (${receipt.model})` : ''}`,
    `Duration: ${Math.round(receipt.durationMs / 1000)}s${receipt.numTurns !== undefined ? `, ${receipt.numTurns} turns` : ''}${receipt.costUsd !== undefined ? `, $${receipt.costUsd.toFixed(4)}` : ''}`,
  ];
  if (receipt.label) lines.push(`Label: ${receipt.label}`);
  if (receipt.exitCode !== undefined && receipt.exitCode !== null) lines.push(`Exit code: ${receipt.exitCode}`);
  if (receipt.sessionId) lines.push(`Session: ${receipt.sessionId} (resumable via coding_continue)`);
  lines.push(...mergeInstructions(receipt));
  if (receipt.diffStat) lines.push(`Diff:\n${bound(receipt.diffStat, 2000)}`);
  lines.push('', `Result:\n${bound(receipt.resultTail, resultTailMax)}`);
  return lines.join('\n');
}

function normalizeWaitSeconds(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_WAIT_SECONDS);
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.map(item => String(item)).filter(item => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Shared wait-then-report path for coding_run / coding_continue. */
async function awaitOrHandOff(bridge: CodingBridgeRef, job: CodingJobRecord, waitSeconds: number, ctx: ToolContext): Promise<ToolResult> {
  if (waitSeconds > 0) {
    const settled = await bridge.waitForJob(job.id, waitSeconds * 1000);
    if (isTerminal(settled)) {
      const receipt = bridge.getReceipt(job.id);
      if (receipt) return { content: receiptSummary(receipt, RESULT_TAIL_RUN_MAX) };
      return { content: `${jobSummary(settled)}\n\n(no receipt persisted — use coding_status for the event tail)` };
    }
    return { content: `Job ${job.id} still running after ${waitSeconds}s in ${describeLocation(settled)}. Results will be delivered when complete; check coding_status ${job.id}.` };
  }
  return { content: `Started coding job ${job.id} (${job.backend}) in ${describeLocation(job)} [cwd shown: ${shortCwd(ctx, job.cwd)}]. Results will be delivered when complete; check coding_status.` };
}

export const codingRunTool: ToolDefinition = {
  name: 'coding_run',
  description: 'Delegate substantial multi-file coding work to a headless Claude Code (or Codex) session with full machine authority. Use for real implementation tasks — refactors, features, bug fixes across files — rather than single-file edits you can do directly. For Home23 self-modification the job runs in an isolated git worktree by default, so the live checkout is never touched. Returns a durable job id; results are delivered when the job completes.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The full coding task for the backend session' },
      backend: { type: 'string', description: 'Backend id (default from acp config, usually claude-code)' },
      cwd: { type: 'string', description: 'Working directory for the job (default: project root)' },
      label: { type: 'string', description: 'Short human label for the job' },
      model: { type: 'string', description: 'Backend model override' },
      effort: { type: 'string', description: 'Reasoning effort override (backend-specific)' },
      isolation: { type: 'string', enum: ['worktree', 'checkpoint', 'none'], description: 'Isolation mode; defaults to worktree inside the Home23 checkout' },
      wait_seconds: { type: 'number', description: 'Seconds to wait for completion before returning (0 = return immediately, max 600)' },
      append_system_prompt: { type: 'string', description: 'Extra system-prompt text appended to the backend session' },
      allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Backend tool allowlist (allowlist permission mode)' },
      disallowed_tools: { type: 'array', items: { type: 'string' }, description: 'Backend tools to deny' },
      max_budget_usd: { type: 'number', description: 'Spend cap for the job in USD' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) return { content: 'coding_run requires a non-empty prompt.', is_error: true };
    const waitSeconds = normalizeWaitSeconds(input.wait_seconds);
    try {
      const job = await bridge.startJob({
        prompt,
        backend: input.backend ? String(input.backend) : undefined,
        cwd: input.cwd ? String(input.cwd) : undefined,
        label: input.label ? String(input.label) : undefined,
        model: input.model ? String(input.model) : undefined,
        effort: input.effort ? String(input.effort) : undefined,
        isolation: input.isolation ? String(input.isolation) as CodingIsolation : undefined,
        appendSystemPrompt: input.append_system_prompt ? String(input.append_system_prompt) : undefined,
        allowedTools: stringArray(input.allowed_tools),
        disallowedTools: stringArray(input.disallowed_tools),
        maxBudgetUsd: typeof input.max_budget_usd === 'number' ? input.max_budget_usd : undefined,
        requestedBy: ctx.chatId,
      });
      // Register durable async work at the tool boundary, where origin context
      // is real. The registry resolves subagent: chats to the root conversation.
      ctx.workRegistry?.create({
        kind: 'coding',
        originChatId: ctx.chatId,
        originTurnId: ctx.turnRuntime?.turnId,
        parentWorkId: ctx.parentWorkId,
        label: (input.label ? String(input.label) : undefined) ?? job.label ?? job.prompt.slice(0, 100),
        resultHandle: { type: 'coding_job', jobId: job.id },
      });
      return await awaitOrHandOff(bridge, job, waitSeconds, ctx);
    } catch (err) {
      return errorResult('coding_run failed', err);
    }
  },
};

export const codingContinueTool: ToolDefinition = {
  name: 'coding_continue',
  description: 'Continue a finished coding job\'s backend session with a follow-up prompt. Reuses the SAME working directory / worktree as the original job so the conversation picks up where it left off.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The coding job to continue' },
      prompt: { type: 'string', description: 'Follow-up instruction for the resumed session' },
      wait_seconds: { type: 'number', description: 'Seconds to wait for completion before returning (0 = return immediately, max 600)' },
    },
    required: ['job_id', 'prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const jobId = String(input.job_id ?? '');
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) return { content: 'coding_continue requires a non-empty prompt.', is_error: true };
    const job = bridge.getJob(jobId);
    if (!job) return { content: `No coding job found with id ${jobId}. Use coding_jobs to list known jobs.`, is_error: true };
    if (!job.sessionId) {
      return { content: `Job ${jobId} has no resumable backend session (no session id was recorded — the backend may not support resume, or the job died before the session started). Start a fresh coding_run instead.`, is_error: true };
    }
    const waitSeconds = normalizeWaitSeconds(input.wait_seconds);
    try {
      const resumed = await bridge.startJob({
        backend: job.backend,
        prompt,
        cwd: job.cwd,
        isolation: 'none',
        resumeSessionId: job.sessionId,
        resumedFromJobId: job.id,
        label: job.label,
        model: job.model,
        requestedBy: ctx.chatId,
      });
      ctx.workRegistry?.create({
        kind: 'coding',
        originChatId: ctx.chatId,
        originTurnId: ctx.turnRuntime?.turnId,
        parentWorkId: ctx.parentWorkId,
        label: resumed.label ?? resumed.prompt.slice(0, 100),
        resultHandle: { type: 'coding_job', jobId: resumed.id },
      });
      return await awaitOrHandOff(bridge, resumed, waitSeconds, ctx);
    } catch (err) {
      return errorResult('coding_continue failed', err);
    }
  },
};

export const codingStatusTool: ToolDefinition = {
  name: 'coding_status',
  description: 'Show a coding job\'s current state plus the tail of its event stream (text, tool use, result).',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The coding job to inspect' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const jobId = String(input.job_id ?? '');
    const job = bridge.getJob(jobId);
    if (!job) return { content: `No coding job found with id ${jobId}. Use coding_jobs to list known jobs.`, is_error: true };
    const events = bridge.readEventsTail(jobId, 15);
    return { content: `${jobSummary(job)}\n\nRecent events:\n${renderEventsTail(events)}` };
  },
};

export const codingResultTool: ToolDefinition = {
  name: 'coding_result',
  description: 'Fetch the final receipt of a finished coding job: result text, diff stat, cost, and worktree/checkpoint merge or rollback instructions.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The coding job to fetch the receipt for' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const jobId = String(input.job_id ?? '');
    const receipt = bridge.getReceipt(jobId);
    if (!receipt) {
      const job = bridge.getJob(jobId);
      if (!job) return { content: `No coding job found with id ${jobId}. Use coding_jobs to list known jobs.`, is_error: true };
      const events = bridge.readEventsTail(jobId, 10);
      return { content: `Job ${jobId} not finished — status ${job.status}.\n\nRecent events:\n${renderEventsTail(events)}` };
    }
    return { content: receiptSummary(receipt, RESULT_TAIL_FULL_MAX) };
  },
};

export const codingCancelTool: ToolDefinition = {
  name: 'coding_cancel',
  description: 'Cancel a running coding job and report its resulting status.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The coding job to cancel' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const jobId = String(input.job_id ?? '');
    try {
      const job = await bridge.cancelJob(jobId);
      return { content: `Job ${job.id} is now ${job.status}.${job.sessionId ? ` Session ${job.sessionId} remains resumable via coding_continue.` : ''}` };
    } catch (err) {
      return errorResult('coding_cancel failed', err);
    }
  },
};

export const codingJobsTool: ToolDefinition = {
  name: 'coding_jobs',
  description: 'List coding jobs (newest first), optionally filtered by status.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted'], description: 'Only list jobs with this status' },
      limit: { type: 'number', description: 'Maximum jobs to list (default 10)' },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const limitRaw = Number(input.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 50) : 10;
    const status = input.status ? String(input.status) as CodingJobRecord['status'] : undefined;
    const jobs = bridge.listJobs({ status, limit });
    if (jobs.length === 0) return { content: status ? `No coding jobs with status ${status}.` : 'No coding jobs recorded.' };
    const lines = jobs.map(job =>
      `- ${job.id} [${job.status}] ${job.backend}${job.label ? ` "${bound(job.label, 60)}"` : ''} started ${job.startedAt} cwd ${shortCwd(ctx, job.cwd)}`,
    );
    return { content: lines.join('\n') };
  },
};

export const codingBackendsTool: ToolDefinition = {
  name: 'coding_backends',
  description: 'List available coding backends and their resolved binaries.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const backends = bridge.listBackends();
    if (backends.length === 0) return { content: 'No coding backends configured.' };
    const lines = backends.map(b =>
      `- ${b.id}: ${b.available ? `available (${b.bin})` : 'NOT AVAILABLE (binary not found)'}${b.defaultModel ? ` default model ${b.defaultModel}` : ''}`,
    );
    lines.push('The default backend comes from acp.defaultAgent (usually claude-code); codex requires the Codex CLI to be installed before it can run jobs.');
    return { content: lines.join('\n') };
  },
};
