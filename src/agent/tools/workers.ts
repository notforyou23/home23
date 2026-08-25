import type { ToolContext, ToolDefinition } from '../types.js';
import { resolveHarnessBridgeUrl } from '../harness-bridge-url.js';

function baseUrl(ctx: ToolContext): string {
  return resolveHarnessBridgeUrl(ctx);
}

function fetcher(ctx: ToolContext): typeof fetch {
  return ctx.fetch || fetch;
}

async function jsonRequest(ctx: ToolContext, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetcher(ctx)(`${baseUrl(ctx)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error((data && typeof data === 'object' && 'error' in data) ? String(data.error) : `HTTP ${res.status}`);
  }
  return data;
}

export const workerListTool: ToolDefinition = {
  name: 'worker_list',
  description: 'List reusable Home23 workers available through the worker connector.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const data = await jsonRequest(ctx, '/api/workers');
    return { content: JSON.stringify(data, null, 2) };
  }
};

export const workerRunTool: ToolDefinition = {
  name: 'worker_run',
  description: 'Run a reusable Home23 worker through the backend connector and return the receipt summary.',
  input_schema: {
    type: 'object',
    properties: {
      worker: { type: 'string' },
      prompt: { type: 'string' },
      requestedBy: { type: 'string', enum: ['house-agent', 'human', 'live-problems', 'good-life', 'cron', 'cli', 'api'] },
      collaborationHandoff: {
        type: 'object',
        description: 'Optional delegation brief: why this matters, constraints, and review lens so the worker preserves owner intent.',
        additionalProperties: true
      }
    },
    required: ['worker', 'prompt'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const worker = String(input.worker || '');
    const prompt = String(input.prompt || '');
    const data = await jsonRequest(ctx, `/api/workers/${encodeURIComponent(worker)}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        requestedBy: input.requestedBy || 'house-agent',
        requester: ctx.agentName,
        collaborationHandoff: input.collaborationHandoff
      })
    }) as { runId?: string; receipt?: { status?: string; verifierStatus?: string; summary?: string } };
    return { content: `Worker run ${data.runId}: ${data.receipt?.status || 'unknown'} / verifier ${data.receipt?.verifierStatus || 'unknown'}\n${data.receipt?.summary || ''}` };
  }
};

export const workerStatusTool: ToolDefinition = {
  name: 'worker_status',
  description: 'Return current worker roster and recent worker run status from the connector.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const data = await jsonRequest(ctx, '/api/workers/runs');
    return { content: JSON.stringify(data, null, 2) };
  }
};

export const workerReceiptTool: ToolDefinition = {
  name: 'worker_receipt',
  description: 'Fetch a worker run receipt by run id.',
  input_schema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, `/api/workers/runs/${encodeURIComponent(String(input.runId))}/receipt`);
    return { content: JSON.stringify(data, null, 2) };
  }
};

export const workerPromoteMemoryTool: ToolDefinition = {
  name: 'worker_promote_memory',
  description: 'Mark worker receipt memory candidates for promotion through the connector.',
  input_schema: {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, `/api/workers/runs/${encodeURIComponent(String(input.runId))}/promote-memory`, { method: 'POST', body: '{}' });
    return { content: JSON.stringify(data, null, 2) };
  }
};
