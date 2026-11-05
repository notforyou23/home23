import type { ToolDefinition, ToolResult } from '../types.js';

const UNAVAILABLE: ToolResult = {
  content: 'Async work registry is unavailable in this agent context.',
  is_error: true,
};

function exactWorkId(input: Record<string, unknown>): string | null {
  const value = typeof input.work_id === 'string' ? input.work_id.trim() : '';
  return value || null;
}

export const workListTool: ToolDefinition = {
  name: 'work_list',
  description: 'List this agent\'s durable async work. Defaults to active work; optionally include terminal records.',
  input_schema: {
    type: 'object',
    properties: {
      include_terminal: { type: 'boolean', description: 'Include completed, failed, cancelled, and interrupted work (default false)' },
      limit: { type: 'number', description: 'Maximum records to return (default 20, maximum 100)' },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (ctx.turnRuntime?.coordinationOrigin && ctx.coordinationChannelOperation && ctx.parentToolCallId) {
      const operation = typeof input.work_id === 'string' ? 'work_status' : 'work_list';
      const result = await ctx.coordinationChannelOperation({ origin: ctx.turnRuntime.coordinationOrigin,
        invocationId: ctx.parentToolCallId, args: { ...input, operation } });
      return { content: JSON.stringify(result, null, 2) };
    }
    if (!ctx.workRegistry) return UNAVAILABLE;
    const rawLimit = Number(input.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 100)
      : 20;
    const work = ctx.workRegistry.list({
      active: input.include_terminal !== true,
      limit,
    });
    if (work.length === 0) {
      return { content: input.include_terminal === true ? 'No durable async work recorded.' : 'No active durable async work.' };
    }
    return { content: JSON.stringify({ work }, null, 2) };
  },
};

export const workStatusTool: ToolDefinition = {
  name: 'work_status',
  description: 'Inspect one exact durable async-work record by work ID.',
  input_schema: {
    type: 'object',
    properties: {
      work_id: { type: 'string', description: 'Exact work ID returned by work_list; canonical wrk_... IDs are supported on connected resident turns' },
    },
    required: ['work_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const requestedId = exactWorkId(input);
    if (!requestedId) return { content: 'work_id is required.', is_error: true };
    if (requestedId.startsWith('wrk_') && ctx.turnRuntime?.coordinationOrigin && ctx.coordinationChannelOperation && ctx.parentToolCallId) {
      const operation = typeof input.work_id === 'string' ? 'work_status' : 'work_list';
      const result = await ctx.coordinationChannelOperation({ origin: ctx.turnRuntime.coordinationOrigin,
        invocationId: ctx.parentToolCallId, args: { ...input, operation } });
      return { content: JSON.stringify(result, null, 2) };
    }
    if (!ctx.workRegistry) return UNAVAILABLE;
    const workId = exactWorkId(input);
    if (!workId) return { content: 'work_id is required.', is_error: true };
    const work = ctx.workRegistry.get(workId);
    if (!work) return { content: `Unknown work id: ${workId}`, is_error: true };
    return { content: JSON.stringify(work, null, 2) };
  },
};

export const workCancelTool: ToolDefinition = {
  name: 'work_cancel',
  description: 'Request cancellation of one exact active durable async-work record.',
  input_schema: {
    type: 'object',
    properties: {
      work_id: { type: 'string', description: 'Exact active work ID to cancel; canonical wrk_... IDs are supported on connected resident turns' },
    },
    required: ['work_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const requestedId = exactWorkId(input);
    if (requestedId?.startsWith('wrk_') && ctx.turnRuntime?.coordinationOrigin && ctx.coordinationChannelOperation && ctx.parentToolCallId) {
      const result = await ctx.coordinationChannelOperation({ origin: ctx.turnRuntime.coordinationOrigin,
        invocationId: ctx.parentToolCallId, args: { work_id: requestedId, operation: 'work_cancel' } });
      return { content: JSON.stringify(result, null, 2) };
    }
    if (!ctx.workRegistry || !ctx.requestWorkCancel) return UNAVAILABLE;
    const workId = exactWorkId(input);
    if (!workId) return { content: 'work_id is required.', is_error: true };
    const outcome = ctx.requestWorkCancel(workId);
    if (outcome.status === 'not_found') {
      return { content: `Unknown work id: ${workId}`, is_error: true };
    }
    if (outcome.status === 'already_terminal') {
      return { content: `Work ${workId} is already terminal (${outcome.work.status}).`, is_error: true };
    }
    return { content: `Cancellation requested for work ${workId}.` };
  },
};

export const workReportOutcomeTool: ToolDefinition = {
  name: 'work_report_outcome',
  description: 'Record this resident\'s assessment of an existing canonical assignment. Complete requires inspected evidence; a blocked assignment remains open and can return when dependencies finish or at the specified revisit time. This does not launch work.',
  input_schema: { type: 'object', properties: {
    work_id: { type: 'string', description: 'Existing canonical assignment or execution ID' },
    state: { type: 'string', enum: ['active','blocked','complete','cancelled'] },
    summary: { type: 'string', description: 'What was achieved or what remains; report the actual outcome' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Inspected file, artifact, or receipt references; required for completion' },
    wait_for: { type: 'array', items: { type: 'string' }, description: 'Other existing Work IDs whose termination warrants reconsidering the blocker' },
    revisit_at: { type: 'string', description: 'Optional exact ISO time when reconsideration is warranted' },
    owner_message_sequence: { type: 'integer', description: 'After reading changed owner direction in work_list, acknowledge its exact ownerMessageSequence here. Active permits continuation; a pause stays blocked without an automatic revisit.' },
  }, required: ['work_id','state','summary','evidence'], additionalProperties: false },
  async execute(input, ctx) {
    if (!ctx.turnRuntime?.coordinationOrigin || !ctx.coordinationChannelOperation || !ctx.parentToolCallId) return UNAVAILABLE;
    return { content: JSON.stringify(await ctx.coordinationChannelOperation({ origin: ctx.turnRuntime.coordinationOrigin,
      invocationId: ctx.parentToolCallId, args: { ...input, operation: 'work_report_outcome' } }), null, 2) };
  },
};
