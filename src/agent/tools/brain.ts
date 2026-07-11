/**
 * Brain tools — all access goes through the requester-bound durable operations client.
 */

import type {
  BrainOperationRecord,
  BrainOperationResult,
  BrainOperationResultEnvelope,
} from '../brain-operations/types.js';
import {
  assertExactKeys,
  exactProviderModelPair,
  hasOwn,
  optionalBoolean,
  optionalBoundedText,
  optionalEnum,
  optionalFiniteInteger,
  optionalFiniteNumber,
  optionalJsonObject,
  requiredBoundedText,
} from '../brain-operations/input-validation.js';
import { operationToolResult } from '../tool-result.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

const DEFAULT_BRAIN_QUERY_MODE = 'quick';

const targetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent: { type: 'string', minLength: 1 },
    brainId: { type: 'string', minLength: 1 },
  },
} as const;

const providerModelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
  },
  required: ['provider', 'model'],
} as const;

function invalidRequest(message = 'invalid_request'): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

function assertToolKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Reflect.ownKeys(input);
  const allow = new Set(allowed);
  if (keys.some((key) => typeof key !== 'string' || !allow.has(key))) throw invalidRequest();
}

function parsedWhenPresent<T>(
  input: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = parse(input[key]);
  if (value === undefined) throw invalidRequest(`${key}_invalid`);
  return value;
}

function targetFrom(input: Record<string, unknown>): { agent?: string; brainId?: string } | undefined {
  if (!hasOwn(input, 'target')) return undefined;
  const value = input.target;
  assertExactKeys(value, ['agent', 'brainId'], 'target', { requireAny: true });
  const agent = parsedWhenPresent(value, 'agent', (candidate) =>
    optionalBoundedText(candidate, 'target.agent', 256));
  const brainId = parsedWhenPresent(value, 'brainId', (candidate) =>
    optionalBoundedText(candidate, 'target.brainId', 256));
  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(brainId !== undefined ? { brainId } : {}),
  };
}

function exactPairWhenPresent(
  input: Record<string, unknown>,
  key: string,
): { provider: string; model: string } | undefined {
  return parsedWhenPresent(input, key, (value) => exactProviderModelPair(value, key));
}

function pgsConfigWhenPresent(
  input: Record<string, unknown>,
): { sweepFraction?: number } | undefined {
  if (!hasOwn(input, 'pgsConfig')) return undefined;
  const value = input.pgsConfig;
  assertExactKeys(value, ['sweepFraction'], 'pgsConfig');
  const sweepFraction = parsedWhenPresent(value, 'sweepFraction', (candidate) =>
    optionalFiniteNumber(candidate, 'pgsConfig.sweepFraction', 0, 1, { exclusiveMin: true }));
  return sweepFraction === undefined ? {} : { sweepFraction };
}

function priorContextWhenPresent(
  input: Record<string, unknown>,
): { query: string; answer: string } | undefined {
  if (!hasOwn(input, 'priorContext')) return undefined;
  const value = input.priorContext;
  assertExactKeys(value, ['query', 'answer'], 'priorContext', { requireAll: true });
  return {
    query: requiredBoundedText(value.query, 'priorContext.query', 12_000),
    answer: requiredBoundedText(value.answer, 'priorContext.answer', 20_000),
  };
}

function runtime(ctx: ToolContext): NonNullable<ToolContext['turnRuntime']> {
  if (!ctx.turnRuntime) {
    throw Object.assign(new Error('turn_runtime_unavailable'), { code: 'turn_runtime_unavailable' });
  }
  return ctx.turnRuntime;
}

function toolFailure(label: string, error: unknown): ToolResult {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'brain_operation_error';
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: `${label}: ${code}: ${message}`,
    is_error: true,
    metadata: {
      code,
      sourceHealth: code === 'source_unavailable' ? 'unavailable' : 'unknown',
    },
  };
}

function boundedJson(label: string, value: Record<string, unknown>): ToolResult {
  return {
    content: `${label}\n${JSON.stringify(value, null, 2)}`,
    resultHandle: typeof value.resultHandle === 'string' ? value.resultHandle : undefined,
    metadata: {
      operationId: value.operationId,
      state: value.state,
      sourceEvidence: value.sourceEvidence,
      resultArtifact: value.resultArtifact,
    },
  };
}

function operationControlResult(
  action: string,
  value: BrainOperationRecord | BrainOperationResultEnvelope,
): ToolResult {
  const failed = ['failed', 'cancelled', 'interrupted'].includes(value.state);
  const running = value.state === 'queued' || value.state === 'running';
  return {
    content: `${failed
      ? `${value.error?.code || value.state}: ${value.error?.message || value.state}`
      : JSON.stringify(value.result || {})}\noperation=${value.operationId} state=${value.state}`
      + (running
        ? `\nUse brain_status {action:"wait",operationId:"${value.operationId}"} to reattach,`
          + ' or action:"cancel" to stop it.'
        : ''),
    is_error: failed || undefined,
    resultHandle: value.resultHandle || undefined,
    metadata: {
      action,
      operationId: value.operationId,
      state: value.state,
      error: value.error,
      sourceEvidence: value.sourceEvidence,
      resultArtifact: value.resultArtifact,
    },
  };
}

function synthesisResult(operation: BrainOperationResult): ToolResult {
  const rendered = operationToolResult(operation);
  const generationMarker = operation.result?.generationMarker;
  if (typeof generationMarker === 'string' && generationMarker.trim()) {
    rendered.content += `\ngenerationMarker=${generationMarker}`;
    rendered.metadata = { ...rendered.metadata, generationMarker };
  }
  return rendered;
}

async function executeBrainSearch(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['query', 'limit', 'tag', 'target']);
    const turn = runtime(ctx);
    const target = targetFrom(input);
    const topK = parsedWhenPresent(input, 'limit', (value) =>
      optionalFiniteInteger(value, 'limit', 1, 100)) ?? 10;
    const tag = parsedWhenPresent(input, 'tag', (value) =>
      optionalBoundedText(value, 'tag', 256));
    const value = await turn.brainOperations.search({
      ...(target ? { target } : {}),
      query: requiredBoundedText(input.query, 'query', 12_000),
      topK,
      ...(tag !== undefined ? { tag } : {}),
    }, turn.signal);
    return boundedJson('brain_search', value);
  } catch (error) {
    return toolFailure('brain_search', error);
  }
}

async function executeBrainQuery(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, [
      'query', 'target', 'mode', 'enablePGS', 'pgsMode', 'pgsConfig', 'pgsSweep',
      'pgsSynth', 'modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
      'includeCoordinatorInsights', 'allowActions', 'priorContext',
    ]);
    const turn = runtime(ctx);
    const enablePGS = parsedWhenPresent(input, 'enablePGS', (value) =>
      optionalBoolean(value, 'enablePGS')) ?? false;
    const pgsOnly = ['pgsMode', 'pgsConfig', 'pgsSweep', 'pgsSynth'];
    const directOnly = ['modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
      'includeCoordinatorInsights', 'allowActions'];
    if ((!enablePGS && pgsOnly.some((key) => hasOwn(input, key)))
        || (enablePGS && directOnly.some((key) => hasOwn(input, key)))) {
      throw invalidRequest();
    }
    const target = targetFrom(input);
    const mode = parsedWhenPresent(input, 'mode', (value) =>
      optionalEnum(value, 'mode', ['quick', 'full', 'expert', 'dive'] as const))
      ?? DEFAULT_BRAIN_QUERY_MODE;
    const priorContext = priorContextWhenPresent(input);
    const pgsConfig = pgsConfigWhenPresent(input);
    const pgsSweep = exactPairWhenPresent(input, 'pgsSweep');
    const pgsSynth = exactPairWhenPresent(input, 'pgsSynth');
    const modelSelection = exactPairWhenPresent(input, 'modelSelection');
    const operation = await turn.brainOperations.query({
      ...(target ? { target } : {}),
      query: requiredBoundedText(input.query, 'query', 12_000),
      mode,
      ...(priorContext !== undefined ? { priorContext } : {}),
      ...(enablePGS ? {
        enablePGS: true,
        pgsMode: parsedWhenPresent(input, 'pgsMode', (value) =>
          optionalEnum(value, 'pgsMode', ['full'] as const)) ?? 'full',
        ...(pgsConfig !== undefined ? { pgsConfig } : {}),
        ...(pgsSweep !== undefined ? { pgsSweep } : {}),
        ...(pgsSynth !== undefined ? { pgsSynth } : {}),
      } : {
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        ...(hasOwn(input, 'enableSynthesis') ? {
          enableSynthesis: parsedWhenPresent(input, 'enableSynthesis', (value) =>
            optionalBoolean(value, 'enableSynthesis'))!,
        } : {}),
        ...(hasOwn(input, 'includeOutputs') ? {
          includeOutputs: parsedWhenPresent(input, 'includeOutputs', (value) =>
            optionalBoolean(value, 'includeOutputs'))!,
        } : {}),
        ...(hasOwn(input, 'includeThoughts') ? {
          includeThoughts: parsedWhenPresent(input, 'includeThoughts', (value) =>
            optionalBoolean(value, 'includeThoughts'))!,
        } : {}),
        ...(hasOwn(input, 'includeCoordinatorInsights') ? {
          includeCoordinatorInsights: parsedWhenPresent(input, 'includeCoordinatorInsights', (value) =>
            optionalBoolean(value, 'includeCoordinatorInsights'))!,
        } : {}),
        ...(hasOwn(input, 'allowActions') ? {
          allowActions: parsedWhenPresent(input, 'allowActions', (value) =>
            optionalBoolean(value, 'allowActions'))!,
        } : {}),
      }),
    }, turn.signal);
    return operationToolResult(operation);
  } catch (error) {
    return toolFailure('brain_query', error);
  }
}

async function executeBrainExport(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, [
      'operationId', 'resultHandle', 'query', 'answer', 'format', 'metadata',
    ]);
    const turn = runtime(ctx);
    const format = parsedWhenPresent(input, 'format', (value) =>
      optionalEnum(value, 'format', ['markdown', 'json'] as const)) ?? 'markdown';
    const canonical = hasOwn(input, 'operationId');
    if (canonical && (hasOwn(input, 'query') || hasOwn(input, 'answer'))) throw invalidRequest();
    if (!canonical && (!hasOwn(input, 'query') || !hasOwn(input, 'answer')
        || hasOwn(input, 'resultHandle'))) throw invalidRequest();
    if (canonical && hasOwn(input, 'metadata')) throw invalidRequest();
    const metadata = parsedWhenPresent(input, 'metadata', (value) =>
      optionalJsonObject(value, 'metadata', 32_000));
    const resultHandle = parsedWhenPresent(input, 'resultHandle', (value) =>
      optionalBoundedText(value, 'resultHandle', 256));
    const value = canonical
      ? await turn.brainOperations.exportResult({
        operationId: requiredBoundedText(input.operationId, 'operationId', 256),
        ...(resultHandle !== undefined ? { resultHandle } : {}),
        format,
        ...(metadata ? { metadata } : {}),
      }, turn.signal)
      : await turn.brainOperations.exportAdHocResult({
        query: requiredBoundedText(input.query, 'query', 12_000),
        answer: requiredBoundedText(input.answer, 'answer', 2_000_000),
        format,
        metadata: { ...(metadata || {}), canonicalEvidence: false },
      }, turn.signal);
    return boundedJson('brain_query_export', value);
  } catch (error) {
    return toolFailure('brain_query_export', error);
  }
}

async function executeBrainGraph(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['target', 'topN', 'tag', 'exportFull', 'format']);
    const turn = runtime(ctx);
    const target = targetFrom(input);
    const exportFull = parsedWhenPresent(input, 'exportFull', (value) =>
      optionalBoolean(value, 'exportFull')) ?? false;
    if (exportFull) {
      if (['topN', 'tag'].some((key) => hasOwn(input, key))) throw invalidRequest();
      const operation = await turn.brainOperations.graphExport({
        ...(target ? { target } : {}),
        format: parsedWhenPresent(input, 'format', (value) =>
          optionalEnum(value, 'format', ['jsonl'] as const)) ?? 'jsonl',
      }, turn.signal);
      const rendered = operationToolResult(operation);
      rendered.content += '\nFull graph stored in requester-owned operation result storage.';
      return rendered;
    }
    if (hasOwn(input, 'format')) throw invalidRequest();
    const nodeLimit = parsedWhenPresent(input, 'topN', (value) =>
      optionalFiniteInteger(value, 'topN', 1, 100)) ?? 25;
    const tag = parsedWhenPresent(input, 'tag', (value) =>
      optionalBoundedText(value, 'tag', 256));
    const value = await turn.brainOperations.graph({
      ...(target ? { target } : {}),
      nodeLimit,
      edgeLimit: Math.min(nodeLimit * 4, 400),
      ...(tag !== undefined ? { tag } : {}),
    }, turn.signal);
    return boundedJson('brain_memory_graph', value);
  } catch (error) {
    return toolFailure('brain_memory_graph', error);
  }
}

async function executeBrainSynthesis(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (hasOwn(input, 'target')) {
    return { content: 'brain_synthesize is own brain only.', is_error: true };
  }
  try {
    assertToolKeys(input, ['action', 'operationId', 'generationMarker', 'trigger', 'reason']);
    const turn = runtime(ctx);
    const action = parsedWhenPresent(input, 'action', (value) =>
      optionalEnum(value, 'action', ['run', 'status', 'reattach'] as const)) ?? 'run';
    if (action === 'status') {
      if (hasOwn(input, 'trigger') || hasOwn(input, 'reason')
          || (hasOwn(input, 'operationId') && hasOwn(input, 'generationMarker'))) {
        throw invalidRequest();
      }
      const operationId = parsedWhenPresent(input, 'operationId', (value) =>
        optionalBoundedText(value, 'operationId', 256));
      const generationMarker = parsedWhenPresent(input, 'generationMarker', (value) =>
        optionalBoundedText(value, 'generationMarker', 256));
      const value = await turn.brainOperations.synthesisStatus({
        ...(operationId !== undefined ? { operationId } : {}),
        ...(generationMarker !== undefined ? { generationMarker } : {}),
      }, turn.signal);
      return 'operationId' in value && 'state' in value
        ? synthesisResult(value as BrainOperationResult)
        : boundedJson('brain_synthesis_status', value as unknown as Record<string, unknown>);
    }
    if (action === 'reattach') {
      if (hasOwn(input, 'generationMarker') || hasOwn(input, 'trigger') || hasOwn(input, 'reason')) {
        throw invalidRequest();
      }
      const operationId = requiredBoundedText(input.operationId, 'operationId', 256);
      return synthesisResult(await turn.brainOperations.reattachSynthesis(
        operationId, turn.signal,
      ));
    }
    if (hasOwn(input, 'operationId') || hasOwn(input, 'generationMarker')) throw invalidRequest();
    const trigger = parsedWhenPresent(input, 'trigger', (value) =>
      optionalBoundedText(value, 'trigger', 256)) ?? 'tool';
    const reason = parsedWhenPresent(input, 'reason', (value) =>
      optionalBoundedText(value, 'reason', 4_000));
    return synthesisResult(await turn.brainOperations.synthesize({
      trigger,
      ...(reason !== undefined ? { reason } : {}),
    }, turn.signal));
  } catch (error) {
    return toolFailure('brain_synthesize', error);
  }
}

async function executeBrainStatus(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['target', 'operationId', 'action']);
    const turn = runtime(ctx);
    if (hasOwn(input, 'operationId')) {
      if (hasOwn(input, 'target')) throw invalidRequest();
      const operationId = requiredBoundedText(input.operationId, 'operationId', 256);
      const action = parsedWhenPresent(input, 'action', (value) =>
        optionalEnum(value, 'action', ['status', 'result', 'wait', 'cancel'] as const)) ?? 'status';
      const value = action === 'wait'
        ? await turn.brainOperations.resumeOperation(operationId, turn.signal)
        : await turn.brainOperations.inspectOperation(operationId, action, turn.signal);
      return 'attachmentState' in value
        ? operationToolResult(value as BrainOperationResult)
        : operationControlResult(action, value);
    }
    if (hasOwn(input, 'action')) throw invalidRequest();
    const target = targetFrom(input);
    return boundedJson('brain_status', await turn.brainOperations.status(
      target ? { target } : {}, turn.signal,
    ));
  } catch (error) {
    return toolFailure('brain_status', error);
  }
}

export const brainSearchTool: ToolDefinition = {
  name: 'brain_search',
  description: 'Search this agent brain or an authorized sibling/completed research brain.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      tag: { type: 'string', minLength: 1 },
      target: targetSchema,
    },
    required: ['query'],
  },
  execute: executeBrainSearch,
};

export const brainQueryTool: ToolDefinition = {
  name: 'brain_query',
  description: 'Run a durable brain query. PGS can take hours and remains reattachable by operation ID.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1 },
      target: targetSchema,
      mode: { type: 'string', enum: ['quick', 'full', 'expert', 'dive'] },
      enablePGS: { type: 'boolean' },
      pgsMode: { type: 'string', enum: ['full'] },
      pgsConfig: {
        type: 'object', additionalProperties: false,
        properties: { sweepFraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 } },
      },
      pgsSweep: providerModelSchema,
      pgsSynth: providerModelSchema,
      modelSelection: providerModelSchema,
      enableSynthesis: { type: 'boolean' },
      includeOutputs: { type: 'boolean' },
      includeThoughts: { type: 'boolean' },
      includeCoordinatorInsights: { type: 'boolean' },
      allowActions: { type: 'boolean' },
      priorContext: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string' }, answer: { type: 'string' } },
        required: ['query', 'answer'],
      },
    },
    required: ['query'],
  },
  execute: executeBrainQuery,
};

export const brainQueryExportTool: ToolDefinition = {
  name: 'brain_query_export',
  description: 'Export a requester-owned durable result, or explicitly mark an ad-hoc export noncanonical.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operationId: { type: 'string', minLength: 1 },
      resultHandle: { type: 'string', minLength: 1 },
      query: { type: 'string', minLength: 1 },
      answer: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['markdown', 'json'] },
      metadata: { type: 'object' },
    },
  },
  execute: executeBrainExport,
};

export const brainMemoryGraphTool: ToolDefinition = {
  name: 'brain_memory_graph',
  description: 'Read a bounded graph summary, or create a durable requester-owned full JSONL export.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: targetSchema,
      topN: { type: 'integer', minimum: 1, maximum: 100 },
      tag: { type: 'string', minLength: 1 },
      exportFull: { type: 'boolean' },
      format: { type: 'string', enum: ['jsonl'] },
    },
  },
  execute: executeBrainGraph,
};

export const brainSynthesizeTool: ToolDefinition = {
  name: 'brain_synthesize',
  description: 'Run, inspect, or reattach to synthesis for this agent own brain only.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['run', 'status', 'reattach'] },
      operationId: { type: 'string', minLength: 1 },
      generationMarker: { type: 'string', minLength: 1 },
      trigger: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 },
    },
  },
  execute: executeBrainSynthesis,
};

export const brainStatusTool: ToolDefinition = {
  name: 'brain_status',
  description: 'Read authoritative bounded brain status or control one exact durable operation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: targetSchema,
      operationId: { type: 'string', minLength: 1 },
      action: { type: 'string', enum: ['status', 'result', 'wait', 'cancel'] },
    },
  },
  execute: executeBrainStatus,
};
