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
import { mustDetachLongTool } from '../../work/detach.js';
import { TERMINAL_JOB_STATUSES } from '../../acp/types.js';

const MAX_WAIT_SECONDS = 600;
const RESULT_TAIL_RUN_MAX = 4000;
const RESULT_TAIL_FULL_MAX = 8000;
const CONTAINED_WAIT_POLL_MS = 30_000;

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

function integrationNotes(receipt: Pick<CodingJobReceipt, 'worktree' | 'checkpoint'>): string[] {
  const lines: string[] = [];
  if (receipt.worktree) {
    const { repoRoot, path, branch, baseCommit } = receipt.worktree;
    lines.push(`Worktree: ${path} (branch ${branch}, base ${baseCommit})`);
    lines.push(`Integration target: ${repoRoot}. Inspect committed and uncommitted changes in the job workspace, then integrate only the authorized diff into the current target state and verify it.`);
    lines.push('The worktree started from committed HEAD; local uncommitted and untracked files were not copied. A worktree is not a machine sandbox. Preserve the job workspace until its work is integrated or explicitly discarded.');
  }
  if (receipt.checkpoint) {
    const { repoRoot, headCommit, stashCommit, dirty } = receipt.checkpoint;
    lines.push(`Checkpoint: ${repoRoot}, base ${headCommit}, pre-job working tree ${dirty ? 'modified' : 'clean'}.`);
    if (stashCommit) lines.push(`Tracked-state checkpoint object: ${stashCommit}. It excludes untracked and ignored files; inspect it alongside the current diff before recovering selected changes.`);
    else if (dirty) lines.push('No tracked-state checkpoint object was created; untracked files are not backed up by this checkpoint.');
    lines.push('Checkpoint mode edits the original checkout. It does not isolate writes or automatically restore pre-job state.');
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
  lines.push(...integrationNotes(receipt));
  if (receipt.diffStat) lines.push(`Diff:\n${bound(receipt.diffStat, 2000)}`);
  lines.push('', `Result:\n${bound(receipt.resultTail, resultTailMax)}`);
  return lines.join('\n');
}

function normalizeWaitSeconds(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_WAIT_SECONDS);
}

/** Conversation-foreground turns must detach before any wait. */
function waitBudget(raw: unknown, chatId: string): number {
  if (mustDetachLongTool(chatId)) return 0;
  return normalizeWaitSeconds(raw);
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.map(item => String(item)).filter(item => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Shared wait-then-report path for coding_run / coding_continue. */
async function awaitOrHandOff(bridge: CodingBridgeRef, job: CodingJobRecord, waitSeconds: number, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.coordinationWorkDestination) {
    let current = job;
    let sequence = 0;
    while (!isTerminal(current)) {
      if (ctx.abortSignal?.aborted) {
        await bridge.cancelJob(job.id).catch(() => undefined);
        ctx.abortSignal.throwIfAborted();
      }
      current = await bridge.waitForJob(job.id, CONTAINED_WAIT_POLL_MS);
      ctx.turnRuntime?.onWorkActivity?.({
        workId: ctx.coordinationWorkDestination.parentWorkId,
        sequence: ++sequence,
        state: current.status,
        phase: `coding:${job.id}`,
      });
    }
    const receipt = bridge.getReceipt(job.id);
    const content = receipt
      ? receiptSummary(receipt, RESULT_TAIL_RUN_MAX)
      : `${jobSummary(current)}\n\n(no receipt persisted)`;
    return {
      content,
      ...(current.status === 'completed' ? {} : { is_error: true }),
    };
  }
  if (waitSeconds > 0) {
    const settled = await bridge.waitForJob(job.id, waitSeconds * 1000);
    if (isTerminal(settled)) {
      const receipt = bridge.getReceipt(job.id);
      if (receipt) return { content: receiptSummary(receipt, RESULT_TAIL_RUN_MAX), ...(receipt.status !== 'completed' ? { is_error: true } : {}) };
      return { content: `${jobSummary(settled)}\n\n(no receipt persisted — use coding_status for the event tail)`, ...(settled.status !== 'completed' ? { is_error: true } : {}) };
    }
    return { content: `Job ${job.id} still running after ${waitSeconds}s in ${describeLocation(settled)}. Results will be delivered when complete; check coding_status ${job.id}.` };
  }
  return { content: `Started coding job ${job.id} (${job.backend}) in ${describeLocation(job)} [cwd shown: ${shortCwd(ctx, job.cwd)}]. Results will be delivered when complete; check coding_status.` };
}

export const codingRunTool: ToolDefinition = {
  name: 'coding_run',
  description: 'Start a detached CLI coding job when a separate session helps. Home23 jobs default to a Git worktree from committed HEAD (local changes are not copied); this is not a machine sandbox. Returns a durable job ID. Inspect the receipt and integrate authorized changes before claiming completion.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The full coding task for the backend session' },
      backend: { type: 'string', description: 'Omit to use the configured default. Use coding_backends to discover enabled backends; never guess an id.' },
      cwd: { type: 'string', description: 'Working directory for the job (default: project root)' },
      label: { type: 'string', description: 'Short human label for the job' },
      model: { type: 'string', description: 'Backend model override' },
      effort: { type: 'string', description: 'Reasoning effort override (backend-specific)' },
      isolation: { type: 'string', enum: ['worktree', 'checkpoint', 'none'], description: 'Isolation mode; defaults to worktree inside the Home23 checkout' },
      wait_seconds: { type: 'number', description: 'Seconds to wait for completion before returning (0 = return immediately, max 600)' },
      append_system_prompt: { type: 'string', description: 'Extra instructions where supported by the backend (not portable; include essential constraints in prompt)' },
      allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Backend tool allowlist (allowlist permission mode)' },
      disallowed_tools: { type: 'array', items: { type: 'string' }, description: 'Backend tools to deny' },
      max_budget_usd: { type: 'number', exclusiveMinimum: 0, description: 'Positive USD cap, Claude Code only. Omit for Codex, Grok and Cursor; zero is not a default.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) return { content: 'coding_run requires a non-empty prompt.', is_error: true };
    const waitSeconds = waitBudget(input.wait_seconds, ctx.chatId);
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
        taskBrief: prompt,
        originChatId: ctx.chatId,
        originTurnId: ctx.turnRuntime?.turnId,
        parentWorkId: ctx.coordinationWorkDestination?.parentWorkId ?? ctx.parentWorkId,
        deliveryMode: ctx.coordinationWorkDestination ? 'inline' : 'detached',
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
    if (!isTerminal(job)) {
      return { content: `Job ${jobId} is still ${job.status} and cannot be continued. Wait for it to finish or cancel it first; continuing now could start a second process in the same working directory.`, is_error: true };
    }
    if (!job.sessionId) {
      return { content: `Job ${jobId} has no resumable backend session (no session id was recorded — the backend may not support resume, or the job died before the session started). Start a fresh coding_run instead.`, is_error: true };
    }
    if (!job.executionOptions) return { content: 'Legacy coding job has no saved execution settings. Inspect its original invocation and start a new job with explicit supported controls; continuation was not started.', is_error: true };
    const waitSeconds = waitBudget(input.wait_seconds, ctx.chatId);
    try {
      const previousBrief = ctx.workRegistry?.list?.().find(work =>
        work.resultHandle.type === 'coding_job' && work.resultHandle.jobId === job.id)?.taskBrief ?? job.prompt;
      const resumed = await bridge.startJob({
        backend: job.backend,
        prompt,
        cwd: job.cwd,
        isolation: 'none',
        resumeSessionId: job.sessionId,
        resumedFromJobId: job.id,
        label: job.label,
        model: job.model,
        effort: job.effort,
        requestedBy: ctx.chatId,
      });
      ctx.workRegistry?.create({
        kind: 'coding',
        taskBrief: `${previousBrief}\n\nCurrent follow-up: ${prompt}`,
        originChatId: ctx.chatId,
        originTurnId: ctx.turnRuntime?.turnId,
        parentWorkId: ctx.coordinationWorkDestination?.parentWorkId ?? ctx.parentWorkId,
        deliveryMode: ctx.coordinationWorkDestination ? 'inline' : 'detached',
        label: resumed.label ?? resumed.prompt.slice(0, 100),
        resultHandle: { type: 'coding_job', jobId: resumed.id },
      });
      const result = await awaitOrHandOff(bridge, resumed, waitSeconds, ctx);
      return result;
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
  description: 'Fetch a finished coding job receipt: result, status, diff summary, and workspace/checkpoint provenance. A receipt does not establish integration or deployment.',
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
      return { content: `Job ${jobId} ${isTerminal(job) ? 'has no persisted receipt' : 'not finished'} — status ${job.status}.\n\nRecent events:\n${renderEventsTail(events)}`, ...(isTerminal(job) && job.status !== 'completed' ? { is_error: true } : {}) };
    }
    return { content: receiptSummary(receipt, RESULT_TAIL_FULL_MAX), ...(receipt.status !== 'completed' ? { is_error: true } : {}) };
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
  description: 'List configured coding backend binaries. This reports installation and binary resolution only; it is not an authentication, balance, or provider-health probe.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const bridge = getBridge(ctx);
    if (!bridge) return BRIDGE_UNAVAILABLE;
    const backends = bridge.listBackends();
    if (backends.length === 0) return { content: 'No coding backends configured.' };
    const lines = backends.map(b =>
      `- ${b.id}${'enabled' in b && !b.enabled ? " [disabled]" : ""}${'isDefault' in b && b.isDefault ? " [default]" : ""}: ${b.available ? `installed (binary found: ${b.bin})` : 'NOT INSTALLED (binary not found)'}${b.defaultModel ? ` default model ${b.defaultModel}` : ''}`,
    );
    lines.push('Use acp.defaultAgent, not a guessed backend; codex requires the Codex CLI to be installed. Codex accepts model and sandbox configuration, but not effort, append_system_prompt, tool lists or max_budget_usd. Claude Code accepts those optional controls; Grok does not accept max_budget_usd. Omit unsupported options. This list only reports binary resolution; it does not probe authentication, balance, or provider health.');
    return { content: lines.join('\n') };
  },
};

/** Match advertised choices to this resident's configuration, before a model constructs a call. */
export function configuredCodingRunTool(config: { defaultAgent: string; allowedAgents: string[] }): ToolDefinition {
  const schema = structuredClone(codingRunTool.input_schema) as { properties: Record<string, Record<string, unknown>> };
  const enabled = config.allowedAgents.length ? config.allowedAgents : ['codex', 'claude-code', 'grok-build', 'cursor'];
  schema.properties.backend!.enum = enabled;
  schema.properties.backend!.description = `Configured default: ${config.defaultAgent}. Omit backend to use it.`;
  const controls: Record<string, string[]> = {
    effort: ['claude-code','grok-build'], append_system_prompt: ['claude-code','grok-build'],
    allowed_tools: ['claude-code','grok-build'], disallowed_tools: ['claude-code','grok-build'], max_budget_usd: ['claude-code'],
  };
  for (const [key, supported] of Object.entries(controls)) {
    const available = enabled.filter(id => supported.includes(id));
    if (!available.length) delete schema.properties[key];
    else schema.properties[key]!.description += ` Supported only by ${available.join(', ')}; omit for other backends.`;
  }
  return { ...codingRunTool, input_schema: schema };
}
