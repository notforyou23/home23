/**
 * COSMO research toolkit — requester-authorized durable operations only.
 *
 * Policy and workflow live in COSMO_RESEARCH.md. This module validates the
 * public tool contract and delegates to the turn-scoped BrainOperationsClient.
 */

import {
  exactProviderModelPair,
  hasOwn,
  optionalBoolean,
  optionalBoundedText,
  optionalEnum,
  optionalFiniteInteger,
  optionalFiniteNumber,
  requiredBoundedText,
} from '../brain-operations/input-validation.js';
import type { BrainQueryRequest } from '../brain-operations/types.js';
import { operationToolResult, recoverableExcerpt } from '../tool-result.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

const SEARCH_ALL_MAX_TARGETS = 20;
const SEARCH_ALL_CONCURRENCY = 3;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUMMARY_SECTIONS = ['executive', 'goals', 'trajectory', 'thoughts', 'insights'] as const;

const providerModelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1, maxLength: 256 },
    model: { type: 'string', minLength: 1, maxLength: 256 },
  },
  required: ['provider', 'model'],
} as const;

function invalidRequest(message = 'invalid_request'): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

function assertToolKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Reflect.ownKeys(input);
  const allowedSet = new Set(allowed);
  if (keys.some((key) => typeof key !== 'string' || !allowedSet.has(key))) {
    throw invalidRequest();
  }
}

function parsedWhenPresent<T>(
  input: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  if (!hasOwn(input, key)) return undefined;
  const parsed = parse(input[key]);
  if (parsed === undefined) throw invalidRequest(`${key}_invalid`);
  return parsed;
}

function runtime(ctx: ToolContext): NonNullable<ToolContext['turnRuntime']> {
  if (!ctx.turnRuntime) {
    throw Object.assign(new Error('turn_runtime_unavailable'), { code: 'turn_runtime_unavailable' });
  }
  return ctx.turnRuntime;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

async function boundedMap<T, R>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      throwIfAborted(signal);
      if (cursor >= items.length) return;
      const index = cursor;
      cursor += 1;
      output[index] = await run(items[index]!);
      throwIfAborted(signal);
    }
  });
  await Promise.all(workers);
  return output;
}

function researchError(error: unknown): { code: string; message: string } {
  return {
    code: typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'research_operation_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorResult(error: unknown): ToolResult {
  const typed = researchError(error);
  return { content: `${typed.code}: ${typed.message}`, is_error: true, metadata: { code: typed.code } };
}

function exactPgsConfig(value: unknown): { sweepFraction?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || key !== 'sweepFraction')) {
    throw invalidRequest();
  }
  if (!hasOwn(value, 'sweepFraction')) return {};
  const sweepFraction = optionalFiniteNumber(
    (value as { sweepFraction?: unknown }).sweepFraction,
    'pgsConfig.sweepFraction',
    0,
    1,
    { exclusiveMin: true },
  );
  if (sweepFraction === undefined) throw invalidRequest();
  return { sweepFraction };
}

function exactPairWhenPresent(
  input: Record<string, unknown>,
  key: string,
): { provider: string; model: string } | undefined {
  return parsedWhenPresent(input, key, (value) => exactProviderModelPair(value, key));
}

function researchQueryParameters(input: Record<string, unknown>): Omit<BrainQueryRequest, 'target'> {
  const enablePGS = parsedWhenPresent(input, 'enablePGS', (value) =>
    optionalBoolean(value, 'enablePGS')) ?? false;
  const request: Omit<BrainQueryRequest, 'target'> = {
    query: requiredBoundedText(input.query, 'query', 12_000),
    mode: parsedWhenPresent(input, 'mode', (value) =>
      optionalEnum(value, 'mode', ['quick', 'full', 'expert', 'dive'] as const)) ?? 'quick',
    enablePGS,
  };
  if (enablePGS) {
    if (hasOwn(input, 'modelSelection')) throw invalidRequest();
    request.pgsMode = 'full';
    if (hasOwn(input, 'pgsConfig')) request.pgsConfig = exactPgsConfig(input.pgsConfig);
    const pgsSweep = exactPairWhenPresent(input, 'pgsSweep');
    const pgsSynth = exactPairWhenPresent(input, 'pgsSynth');
    if (pgsSweep !== undefined) request.pgsSweep = pgsSweep;
    if (pgsSynth !== undefined) request.pgsSynth = pgsSynth;
  } else {
    if (hasOwn(input, 'pgsConfig') || hasOwn(input, 'pgsSweep') || hasOwn(input, 'pgsSynth')) {
      throw invalidRequest();
    }
    const modelSelection = exactPairWhenPresent(input, 'modelSelection');
    if (modelSelection !== undefined) request.modelSelection = modelSelection;
  }
  return request;
}

function copyExactProviderOverride(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  modelKey: string,
  providerKey: string,
): void {
  const hasModel = hasOwn(input, modelKey);
  const hasProvider = hasOwn(input, providerKey);
  if (hasModel !== hasProvider) throw invalidRequest();
  if (!hasModel) return;
  const model = requiredBoundedText(input[modelKey], modelKey, 256);
  const provider = requiredBoundedText(input[providerKey], providerKey, 128);
  output[modelKey] = model;
  output[providerKey] = provider;
}

function approvedLaunchOptions(input: Record<string, unknown>): Record<string, unknown> {
  assertToolKeys(input, [
    'topic', 'context', 'cycles', 'explorationMode', 'analysisDepth', 'maxConcurrent',
    'primaryModel', 'primaryProvider', 'fastModel', 'fastProvider',
    'strategicModel', 'strategicProvider',
  ]);
  const output: Record<string, unknown> = {
    topic: requiredBoundedText(input.topic, 'topic', 12_000),
  };
  const context = parsedWhenPresent(input, 'context', (value) =>
    optionalBoundedText(value, 'context', 20_000));
  const cycles = parsedWhenPresent(input, 'cycles', (value) =>
    optionalFiniteInteger(value, 'cycles', 1, 10_000));
  const explorationMode = parsedWhenPresent(input, 'explorationMode', (value) =>
    optionalEnum(value, 'explorationMode', ['guided', 'autonomous'] as const));
  const analysisDepth = parsedWhenPresent(input, 'analysisDepth', (value) =>
    optionalEnum(value, 'analysisDepth', ['shallow', 'normal', 'deep'] as const));
  const maxConcurrent = parsedWhenPresent(input, 'maxConcurrent', (value) =>
    optionalFiniteInteger(value, 'maxConcurrent', 1, 64));
  if (context !== undefined) output.context = context;
  if (cycles !== undefined) output.cycles = cycles;
  if (explorationMode !== undefined) output.explorationMode = explorationMode;
  if (analysisDepth !== undefined) output.analysisDepth = analysisDepth;
  if (maxConcurrent !== undefined) output.maxConcurrent = maxConcurrent;
  copyExactProviderOverride(input, output, 'primaryModel', 'primaryProvider');
  copyExactProviderOverride(input, output, 'fastModel', 'fastProvider');
  copyExactProviderOverride(input, output, 'strategicModel', 'strategicProvider');
  return output;
}

function exactRunId(input: Record<string, unknown>, allowed: readonly string[]): string {
  assertToolKeys(input, allowed);
  if (!hasOwn(input, 'runId') || typeof input.runId !== 'string' || !RUN_ID.test(input.runId)) {
    throw invalidRequest();
  }
  return input.runId;
}

function approvedContinueOptions(input: Record<string, unknown>): Record<string, unknown> {
  const runId = exactRunId(input, [
    'runId', 'context', 'cycles', 'primaryModel', 'primaryProvider',
  ]);
  const output: Record<string, unknown> = { target: { runId } };
  const context = parsedWhenPresent(input, 'context', (value) =>
    optionalBoundedText(value, 'context', 20_000));
  const cycles = parsedWhenPresent(input, 'cycles', (value) =>
    optionalFiniteInteger(value, 'cycles', 1, 10_000));
  if (context !== undefined) output.context = context;
  if (cycles !== undefined) output.cycles = cycles;
  copyExactProviderOverride(input, output, 'primaryModel', 'primaryProvider');
  return output;
}

function exactInclude(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUMMARY_SECTIONS.length) {
    throw invalidRequest();
  }
  const output = value.map((entry) => {
    if (typeof entry !== 'string' || !SUMMARY_SECTIONS.includes(entry as typeof SUMMARY_SECTIONS[number])) {
      throw invalidRequest();
    }
    return entry;
  });
  if (new Set(output).size !== output.length) throw invalidRequest();
  return output;
}

export async function checkCosmoActiveRun(
  ctx?: ToolContext,
): Promise<{ runName: string; topic: string; startedAt: string; processCount: number | null } | null> {
  if (!ctx?.turnRuntime) return null;
  try {
    const turn = ctx.turnRuntime;
    const operations = await turn.brainOperations.listNonterminal(turn.signal);
    const active = operations
      .filter((operation) => ['queued', 'running'].includes(operation.state)
        && ['research_launch', 'research_continue', 'research_stop'].includes(operation.operationType))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!active) return null;
    const runName = active.target.domain === 'owned-run'
      ? active.target.runId
      : typeof active.result?.runId === 'string'
        ? active.result.runId
        : `research-${active.operationId}`;
    const topic = typeof active.requestParameters.topic === 'string'
      ? active.requestParameters.topic
      : '';
    return {
      runName,
      topic,
      startedAt: active.startedAt || '',
      processCount: null,
    };
  } catch {
    return null;
  }
}

async function executeListBrains(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['limit', 'includeReferences']);
    const turn = runtime(ctx);
    const limit = parsedWhenPresent(input, 'limit', (value) =>
      optionalFiniteInteger(value, 'limit', 1, 100)) ?? 20;
    const includeReferences = parsedWhenPresent(input, 'includeReferences', (value) =>
      optionalBoolean(value, 'includeReferences')) ?? true;
    const catalog = await turn.brainOperations.getCatalog({ signal: turn.signal });
    const selected = catalog.brains
      .filter((brain) => includeReferences || brain.sourceType === 'local')
      .slice(0, limit);
    const lines = selected.map((brain) =>
      `${brain.displayName} (${brain.id}) — ${brain.lifecycle} — ${brain.nodeCount ?? '?'} nodes`);
    return {
      content: `Catalog ${catalog.catalogRevision}\n${lines.length ? lines.join('\n') : '(no matching catalog rows)'}`,
    };
  } catch (error) {
    return errorResult(error);
  }
}

async function executeQueryBrain(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, [
      'brainId', 'query', 'mode', 'enablePGS', 'modelSelection',
      'pgsConfig', 'pgsSweep', 'pgsSynth',
    ]);
    const turn = runtime(ctx);
    const brainId = requiredBoundedText(input.brainId, 'brainId', 128);
    return operationToolResult(await turn.brainOperations.query({
      target: { brainId },
      ...researchQueryParameters(input),
    }, turn.signal));
  } catch (error) {
    return errorResult(error);
  }
}

async function executeSearchAll(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, [
      'query', 'mode', 'topN', 'enablePGS', 'modelSelection',
      'pgsConfig', 'pgsSweep', 'pgsSynth',
    ]);
    const turn = runtime(ctx);
    const signal = turn.signal;
    throwIfAborted(signal);
    const queryParameters = researchQueryParameters(input);
    const topN = parsedWhenPresent(input, 'topN', (value) =>
      optionalFiniteInteger(value, 'topN', 1, SEARCH_ALL_MAX_TARGETS)) ?? 5;
    const catalog = await turn.brainOperations.getCatalog({ signal });
    throwIfAborted(signal);
    const selected = catalog.brains
      .filter((brain) => brain.kind === 'research' && brain.lifecycle === 'completed')
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id))
      .slice(0, topN);
    if (selected.length === 0) {
      return {
        content: 'no_eligible_targets: catalog has no completed research brains',
        is_error: true,
        metadata: {
          aggregate: 'no_eligible_targets',
          catalogRevision: catalog.catalogRevision,
          selectedCount: 0,
          outcomes: [],
        },
      };
    }
    const outcomes = await boundedMap(selected, SEARCH_ALL_CONCURRENCY, signal, async (brain) => {
      throwIfAborted(signal);
      try {
        const operation = await turn.brainOperations.query({
          target: { brainId: brain.id },
          ...queryParameters,
        }, signal);
        throwIfAborted(signal);
        const classified = operationToolResult(operation);
        const classification = String(classified.metadata?.classification || operation.state);
        const useful = classified.is_error !== true
          && (operation.state === 'complete' || classification === 'useful_partial');
        return {
          brainId: brain.id,
          displayName: brain.displayName,
          catalogRevision: catalog.catalogRevision,
          state: operation.state,
          classification,
          useful,
          operationId: operation.operationId,
          resultHandle: operation.resultHandle,
          sourceEvidence: operation.sourceEvidence,
          error: operation.error,
          excerpt: recoverableExcerpt(classified.content, 4_000, {
            operationId: operation.operationId,
            resultHandle: operation.resultHandle,
          }),
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return {
          brainId: brain.id,
          displayName: brain.displayName,
          catalogRevision: catalog.catalogRevision,
          state: 'failed',
          operationId: null,
          classification: 'failed',
          useful: false,
          resultHandle: null,
          sourceEvidence: null,
          error: researchError(error),
          excerpt: '',
        };
      }
    });
    const usefulCount = outcomes.filter((item) => item.useful).length;
    const aggregate = usefulCount === outcomes.length
      && outcomes.every((item) => item.state === 'complete')
      ? 'complete'
      : usefulCount > 0 ? 'partial' : 'all_failed';
    return {
      content: `${aggregate}\n${outcomes.map((item) =>
        `${item.brainId}: ${item.state}: ${item.excerpt || item.error?.code || 'no answer'}`,
      ).join('\n')}`,
      is_error: aggregate === 'all_failed' || undefined,
      metadata: {
        aggregate,
        catalogRevision: catalog.catalogRevision,
        selectedCount: selected.length,
        outcomes: outcomes.map(({ excerpt: _displayOnly, useful: _internal, ...provenance }) => provenance),
      },
    };
  } catch (error) {
    return errorResult(error);
  }
}

async function executeLaunch(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const turn = runtime(ctx);
    return operationToolResult(await turn.brainOperations.launchResearch(
      approvedLaunchOptions(input), turn.signal,
    ));
  } catch (error) {
    return errorResult(error);
  }
}

async function executeContinue(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const turn = runtime(ctx);
    return operationToolResult(await turn.brainOperations.continueResearch(
      approvedContinueOptions(input) as {
        target: { runId: string }; context?: string; cycles?: number;
        primaryModel?: string; primaryProvider?: string;
      },
      turn.signal,
    ));
  } catch (error) {
    return errorResult(error);
  }
}

async function executeStop(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const turn = runtime(ctx);
    const runId = exactRunId(input, ['runId']);
    return operationToolResult(await turn.brainOperations.stopResearch(
      { target: { runId } }, turn.signal,
    ));
  } catch (error) {
    return errorResult(error);
  }
}

async function executeWatch(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const turn = runtime(ctx);
    const runId = exactRunId(input, ['runId', 'after', 'limit', 'filter']);
    const after = parsedWhenPresent(input, 'after', (value) =>
      optionalFiniteInteger(value, 'after', 0, Number.MAX_SAFE_INTEGER)) ?? 0;
    const limit = parsedWhenPresent(input, 'limit', (value) =>
      optionalFiniteInteger(value, 'limit', 1, 500));
    const filter = parsedWhenPresent(input, 'filter', (value) =>
      optionalEnum(value, 'filter', ['all', 'errors', 'progress', 'cycles'] as const));
    const value = await turn.brainOperations.watchResearch({
      target: { runId },
      after,
      ...(limit !== undefined ? { limit } : {}),
      ...(filter !== undefined ? { filter } : {}),
    }, turn.signal);
    return {
      content: `**Cursor:** ${String(value.latest ?? after)}\n${JSON.stringify(value.logs || [], null, 2)}`,
      metadata: { runId, cursor: value.latest ?? after, active: value.active },
    };
  } catch (error) {
    return errorResult(error);
  }
}

async function executeSummary(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['brainId', 'include']);
    const turn = runtime(ctx);
    const include = hasOwn(input, 'include')
      ? exactInclude(input.include)
      : ['executive', 'goals', 'trajectory'];
    const value = await turn.brainOperations.readIntelligence({
      target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) },
      include,
    }, turn.signal);
    return { content: JSON.stringify(value, null, 2), metadata: { sourceEvidence: value.sourceEvidence } };
  } catch (error) {
    return errorResult(error);
  }
}

async function executeGraph(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['brainId', 'clusterId', 'minWeight', 'limit']);
    const turn = runtime(ctx);
    const nodeLimit = parsedWhenPresent(input, 'limit', (value) =>
      optionalFiniteInteger(value, 'limit', 1, 2_000)) ?? 250;
    const clusterId = parsedWhenPresent(input, 'clusterId', (value) =>
      optionalBoundedText(value, 'clusterId', 256));
    const minWeight = parsedWhenPresent(input, 'minWeight', (value) =>
      optionalFiniteNumber(value, 'minWeight', 0, 1));
    const value = await turn.brainOperations.graph({
      target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) },
      nodeLimit,
      edgeLimit: Math.min(8_000, nodeLimit * 2),
      ...(clusterId !== undefined ? { clusterId } : {}),
      ...(minWeight !== undefined ? { minWeight } : {}),
    }, turn.signal);
    return { content: JSON.stringify(value, null, 2), metadata: { sourceEvidence: value.sourceEvidence } };
  } catch (error) {
    return errorResult(error);
  }
}

async function executeCompileBrain(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['brainId', 'focus']);
    const turn = runtime(ctx);
    const focus = parsedWhenPresent(input, 'focus', (value) =>
      optionalBoundedText(value, 'focus', 12_000));
    return operationToolResult(await turn.brainOperations.compile({
      target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) },
      kind: 'brain',
      ...(focus !== undefined ? { focus } : {}),
    }, turn.signal));
  } catch (error) {
    return errorResult(error);
  }
}

async function executeCompileSection(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['brainId', 'section', 'sectionId', 'focus']);
    const turn = runtime(ctx);
    const focus = parsedWhenPresent(input, 'focus', (value) =>
      optionalBoundedText(value, 'focus', 12_000));
    const section = parsedWhenPresent(input, 'section', (value) =>
      optionalEnum(value, 'section', ['goal', 'insight', 'agent'] as const));
    if (section === undefined) throw invalidRequest();
    return operationToolResult(await turn.brainOperations.compile({
      target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) },
      kind: 'section',
      section,
      sectionId: requiredBoundedText(input.sectionId, 'sectionId', 256),
      ...(focus !== undefined ? { focus } : {}),
    }, turn.signal));
  } catch (error) {
    return errorResult(error);
  }
}

export const listBrainsTool: ToolDefinition = {
  name: 'research_list_brains',
  description: 'List canonical resident and completed research brains before launching more work.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      includeReferences: { type: 'boolean' },
    },
  },
  execute: executeListBrains,
};

export const queryBrainTool: ToolDefinition = {
  name: 'research_query_brain',
  description: 'Run a durable direct or PGS query against one exact research brain.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      brainId: { type: 'string', minLength: 1 },
      query: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['quick', 'full', 'expert', 'dive'] },
      enablePGS: { type: 'boolean' },
      modelSelection: providerModelSchema,
      pgsConfig: {
        type: 'object', additionalProperties: false,
        properties: { sweepFraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 } },
      },
      pgsSweep: providerModelSchema,
      pgsSynth: providerModelSchema,
    },
    required: ['brainId', 'query'],
  },
  execute: executeQueryBrain,
};

export const searchAllBrainsTool: ToolDefinition = {
  name: 'research_search_all_brains',
  description: 'Query up to twenty completed research brains with bounded concurrency and explicit outcomes.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1 },
      topN: { type: 'integer', minimum: 1, maximum: SEARCH_ALL_MAX_TARGETS },
      mode: { type: 'string', enum: ['quick', 'full', 'expert', 'dive'] },
      enablePGS: { type: 'boolean' },
      modelSelection: providerModelSchema,
      pgsConfig: {
        type: 'object', additionalProperties: false,
        properties: { sweepFraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 } },
      },
      pgsSweep: providerModelSchema,
      pgsSynth: providerModelSchema,
    },
    required: ['query'],
  },
  execute: executeSearchAll,
};

export const launchTool: ToolDefinition = {
  name: 'research_launch',
  description: 'Start one durable server-owned research run after checking existing brains.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      topic: { type: 'string', minLength: 1 },
      context: { type: 'string', minLength: 1 },
      cycles: { type: 'integer', minimum: 1, maximum: 10_000 },
      explorationMode: { type: 'string', enum: ['guided', 'autonomous'] },
      analysisDepth: { type: 'string', enum: ['shallow', 'normal', 'deep'] },
      maxConcurrent: { type: 'integer', minimum: 1, maximum: 64 },
      primaryModel: { type: 'string', minLength: 1 },
      primaryProvider: { type: 'string', minLength: 1 },
      fastModel: { type: 'string', minLength: 1 },
      fastProvider: { type: 'string', minLength: 1 },
      strategicModel: { type: 'string', minLength: 1 },
      strategicProvider: { type: 'string', minLength: 1 },
    },
    required: ['topic'],
  },
  execute: executeLaunch,
};

export const continueRunTool: ToolDefinition = {
  name: 'research_continue',
  description: 'Continue one exact requester-owned research run.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      runId: { type: 'string', minLength: 1 },
      context: { type: 'string', minLength: 1 },
      cycles: { type: 'integer', minimum: 1, maximum: 10_000 },
      primaryModel: { type: 'string', minLength: 1 },
      primaryProvider: { type: 'string', minLength: 1 },
    },
    required: ['runId'],
  },
  execute: executeContinue,
};

export const stopRunTool: ToolDefinition = {
  name: 'research_stop',
  description: 'Stop and wait for one exact requester-owned research run.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { runId: { type: 'string', minLength: 1 } },
    required: ['runId'],
  },
  execute: executeStop,
};

export const watchRunTool: ToolDefinition = {
  name: 'research_watch_run',
  description: 'Read the bounded log ring for one exact requester-owned run using a durable cursor.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      runId: { type: 'string', minLength: 1 },
      after: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      filter: { type: 'string', enum: ['all', 'errors', 'progress', 'cycles'] },
    },
    required: ['runId'],
  },
  execute: executeWatch,
};

export const getBrainSummaryTool: ToolDefinition = {
  name: 'research_get_brain_summary',
  description: 'Read bounded pinned intelligence sections from one exact research brain.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      brainId: { type: 'string', minLength: 1 },
      include: {
        type: 'array', minItems: 1, maxItems: SUMMARY_SECTIONS.length,
        items: { type: 'string', enum: SUMMARY_SECTIONS },
      },
    },
    required: ['brainId'],
  },
  execute: executeSummary,
};

export const getBrainGraphTool: ToolDefinition = {
  name: 'research_get_brain_graph',
  description: 'Read a server-bounded graph sample from one exact research brain.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      brainId: { type: 'string', minLength: 1 },
      clusterId: { type: 'string', minLength: 1 },
      minWeight: { type: 'number', minimum: 0, maximum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 2_000 },
    },
    required: ['brainId'],
  },
  execute: executeGraph,
};

export const compileBrainTool: ToolDefinition = {
  name: 'research_compile_brain',
  description: 'Compile one authorized brain into requester-owned durable output.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      brainId: { type: 'string', minLength: 1 },
      focus: { type: 'string', minLength: 1 },
    },
    required: ['brainId'],
  },
  execute: executeCompileBrain,
};

export const compileSectionTool: ToolDefinition = {
  name: 'research_compile_section',
  description: 'Compile one exact goal, insight, or agent section into requester-owned output.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      brainId: { type: 'string', minLength: 1 },
      section: { type: 'string', enum: ['goal', 'insight', 'agent'] },
      sectionId: { type: 'string', minLength: 1 },
      focus: { type: 'string', minLength: 1 },
    },
    required: ['brainId', 'section', 'sectionId'],
  },
  execute: executeCompileSection,
};
