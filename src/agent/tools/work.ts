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
      work_id: { type: 'string', description: 'Exact aw_... work ID returned by spawn_agent or work_list' },
    },
    required: ['work_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
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
      work_id: { type: 'string', description: 'Exact active aw_... work ID to cancel' },
    },
    required: ['work_id'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
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
