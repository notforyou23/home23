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
  optionalJsonObject,
  requiredBoundedText,
} from '../brain-operations/input-validation.js';
import { operationToolResult } from '../tool-result.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

const DEFAULT_BRAIN_QUERY_MODE = 'quick';
const BRAIN_OPERATION_ID_PATTERN = '^brop_[A-Za-z0-9_-]{32}$';
const BRAIN_OPERATION_ID = /^brop_[A-Za-z0-9_-]{32}$/;
const PGS_MODES = ['fresh', 'continue', 'targeted'] as const;
const PGS_LEVELS = ['skim', 'sample', 'deep', 'full'] as const;
const PGS_PARTITION_ID_PATTERN = '^(?:c|h)-[A-Za-z0-9._-]{1,253}$';
const PGS_PARTITION_ID = /^(?:c|h)-[A-Za-z0-9._-]{1,253}$/;
const MAX_PGS_TARGET_PARTITIONS = 256;

const targetSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  description: 'Omit target for this agent own brain. Otherwise select exactly one authorized brain.',
  properties: {
    agent: {
      type: 'string', minLength: 1, maxLength: 256,
      description: 'Agent name for an authorized resident brain, for example forrest.',
    },
    brainId: {
      type: 'string', minLength: 1, maxLength: 256,
      description: 'Exact opaque brain ID returned by the brain catalog; never an agent name.',
    },
  },
} as const;

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
  assertExactKeys(input, allowed, 'input');
}

function requiredToolText(
  input: Record<string, unknown>,
  key: string,
  max: number,
): string {
  if (!hasOwn(input, key)) throw invalidRequest(`${key}_invalid`);
  return requiredBoundedText(input[key], key, max);
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
  if (agent !== undefined && brainId !== undefined) throw invalidRequest('target_invalid');
  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(brainId !== undefined ? { brainId } : {}),
  };
}

function requiredOperationId(input: Record<string, unknown>): string {
  const operationId = requiredToolText(input, 'operationId', 256);
  if (!BRAIN_OPERATION_ID.test(operationId)) throw invalidRequest('operation_id_invalid');
  return operationId;
}

function exactPairWhenPresent(
  input: Record<string, unknown>,
  key: string,
): { provider: string; model: string } | undefined {
  return parsedWhenPresent(input, key, (value) => exactProviderModelPair(value, key));
}

function requiredExactPair(
  input: Record<string, unknown>,
  key: string,
): { provider: string; model: string } {
  if (!hasOwn(input, key)) throw invalidRequest(`${key}_invalid`);
  const pair = exactProviderModelPair(input[key], key);
  if (pair === undefined) throw invalidRequest(`${key}_invalid`);
  return pair;
}

function continuationIdWhenPresent(input: Record<string, unknown>): string | undefined {
  if (!hasOwn(input, 'continueFromOperationId')) return undefined;
  const value = requiredBoundedText(
    input.continueFromOperationId,
    'continueFromOperationId',
    256,
  );
  if (!BRAIN_OPERATION_ID.test(value)) throw invalidRequest('continueFromOperationId_invalid');
  return value;
}

function targetPartitionIdsWhenPresent(input: Record<string, unknown>): string[] | undefined {
  if (!hasOwn(input, 'targetPartitionIds')) return undefined;
  const value = input.targetPartitionIds;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PGS_TARGET_PARTITIONS) {
    throw invalidRequest('targetPartitionIds_invalid');
  }
  const seen = new Set<string>();
  return value.map((partitionId) => {
    if (typeof partitionId !== 'string' || !PGS_PARTITION_ID.test(partitionId)
        || seen.has(partitionId)) {
      throw invalidRequest('targetPartitionIds_invalid');
    }
    seen.add(partitionId);
    return partitionId;
  });
}

function priorContextWhenPresent(
  input: Record<string, unknown>,
): { query: string; answer: string } | undefined {
  if (!hasOwn(input, 'priorContext')) return undefined;
  const value = input.priorContext;
  assertExactKeys(value, ['query', 'answer'], 'priorContext', { requireAll: true });
  const priorContext = {
    query: requiredBoundedText(value.query, 'priorContext.query', 12_000),
    answer: requiredBoundedText(value.answer, 'priorContext.answer', 20_000),
  };
  if (priorContext.query.length + priorContext.answer.length > 20_000) {
    throw invalidRequest('priorContext_invalid');
  }
  return priorContext;
}

function optionalTagWhenPresent(input: Record<string, unknown>): string | undefined {
  if (!hasOwn(input, 'tag')) return undefined;
  if (input.tag === '') return undefined;
  return parsedWhenPresent(input, 'tag', (value) => optionalBoundedText(value, 'tag', 256));
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
  const sourceEvidence = value.sourceEvidence
    ?? (value.evidence && typeof value.evidence === 'object' ? value.evidence : undefined);
  return {
    content: `${label}\n${JSON.stringify(value, null, 2)}`,
    resultHandle: typeof value.resultHandle === 'string' ? value.resultHandle : undefined,
    metadata: {
      operationId: value.operationId,
      state: value.state,
      sourceEvidence,
      resultArtifact: value.resultArtifact,
    },
  };
}

function boundedExportReceipt(value: Record<string, unknown>): ToolResult {
  const receipt = {
    exportHandle: value.exportHandle,
    relativePath: value.relativePath,
    bytes: value.bytes,
    sha256: value.sha256,
    sourceOperationId: value.sourceOperationId,
    sourceResultHandleHash: value.sourceResultHandleHash,
    format: value.format,
    canonicalEvidence: value.canonicalEvidence,
  };
  const rendered = boundedJson('brain_query_export', receipt);
  return {
    ...rendered,
    metadata: receipt,
  };
}

function operationControlResult(
  action: string,
  value: BrainOperationRecord | BrainOperationResultEnvelope,
): ToolResult {
  if (value.state === 'partial') {
    return {
      content: `operation=${value.operationId} state=${value.state}\n`
        + 'Terminal partial status recorded. Read and classify the protected result with '
        + `brain_status {action:"result",operationId:"${value.operationId}"}.`,
      resultHandle: value.resultHandle || undefined,
      metadata: {
        action,
        operationId: value.operationId,
        state: value.state,
        classification: 'partial_status',
        error: value.error,
        sourceEvidence: value.sourceEvidence,
        resultArtifact: value.resultArtifact,
      },
    };
  }
  const failed = ['failed', 'cancelled', 'interrupted'].includes(value.state);
  const running = value.state === 'queued' || value.state === 'running';
  const runningProjection = running ? {
    phase: 'phase' in value ? value.phase : null,
    updatedAt: 'updatedAt' in value ? value.updatedAt : null,
    lastProviderActivityAt: 'lastProviderActivityAt' in value
      ? value.lastProviderActivityAt : null,
    lastProgressAt: 'lastProgressAt' in value ? value.lastProgressAt : null,
    pgsSession: 'pgsSession' in value ? value.pgsSession : null,
  } : null;
  return {
    content: `${failed
      ? `${value.error?.code || value.state}: ${value.error?.message || value.state}`
      : JSON.stringify(runningProjection || value.result || {})}\noperation=${value.operationId} state=${value.state}`
      + (running
        ? `\nUse brain_status {action:"status",operationId:"${value.operationId}"} to check it,`
          + ' action:"result" after terminal, or action:"cancel" to stop it.'
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
      ...(runningProjection || {}),
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
    const tag = optionalTagWhenPresent(input);
    const value = await turn.brainOperations.search({
      ...(target ? { target } : {}),
      query: requiredToolText(input, 'query', 12_000),
      topK,
      ...(tag !== undefined ? { tag } : {}),
    }, turn.signal);
    return boundedJson('brain_search', value);
  } catch (error) {
    return toolFailure('brain_search', error);
  }
}

async function executeBrainCatalog(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, []);
    const turn = runtime(ctx);
    const [brainCatalog, queryCatalog] = await Promise.all([
      turn.brainOperations.getCatalog({ signal: turn.signal }),
      turn.brainOperations.getQueryCatalog(turn.signal),
    ]);
    const models = queryCatalog.models.map((model) => ({
      provider: model.provider,
      model: model.id,
      name: model.name ?? null,
      providerLabel: model.providerLabel ?? null,
    }));
    const defaults = queryCatalog.defaults;
    const defaultPairs = [
      ['query', defaults.provider, defaults.model],
      ['pgsSweep', defaults.pgsSweepProvider, defaults.pgsSweepModel],
      ['pgsSynth', defaults.pgsSynthProvider, defaults.pgsSynthModel],
    ].map(([purpose, provider, model]) => ({
      purpose,
      provider: typeof provider === 'string' ? provider : null,
      model: typeof model === 'string' ? model : null,
      selectable: typeof provider === 'string' && typeof model === 'string'
        && models.some((entry) => entry.provider === provider && entry.model === model),
    }));
    return boundedJson('brain_catalog', {
      catalogRevision: brainCatalog.catalogRevision,
      brains: brainCatalog.brains.map((brain) => ({
        id: brain.id,
        displayName: brain.displayName,
        ownerAgent: brain.ownerAgent,
        kind: brain.kind,
        lifecycle: brain.lifecycle,
        nodeCount: brain.nodeCount,
        sourceType: brain.sourceType,
        modifiedAt: brain.modifiedAt,
      })),
      queryAvailable: queryCatalog.available,
      queryReason: queryCatalog.reason ?? null,
      models,
      defaults: defaultPairs,
      streaming: queryCatalog.streaming ?? null,
      limits: queryCatalog.limits ?? null,
    });
  } catch (error) {
    return toolFailure('brain_catalog', error);
  }
}

async function executeBrainOperationsList(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['state', 'limit']);
    const turn = runtime(ctx);
    const state = parsedWhenPresent(input, 'state', (value) =>
      optionalEnum(value, 'state', ['nonterminal', 'recent'] as const)) ?? 'recent';
    const limit = parsedWhenPresent(input, 'limit', (value) =>
      optionalFiniteInteger(value, 'limit', 1, 100)) ?? 20;
    if (state === 'nonterminal' && hasOwn(input, 'limit')) throw invalidRequest();
    const operations = await turn.brainOperations.listOperations({
      state,
      ...(state === 'recent' ? { limit } : {}),
      signal: turn.signal,
    });
    return boundedJson('brain_operations_list', { state, count: operations.length, operations });
  } catch (error) {
    return toolFailure('brain_operations_list', error);
  }
}

async function executeBrainPgsPartitions(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, ['target']);
    const turn = runtime(ctx);
    const target = targetFrom(input);
    const result = await turn.brainOperations.graph({
      ...(target ? { target } : {}),
      view: 'pgs_partitions',
    }, turn.signal);
    return boundedJson('brain_pgs_partitions', result);
  } catch (error) {
    return toolFailure('brain_pgs_partitions', error);
  }
}

async function executeBrainQuery(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    assertToolKeys(input, [
      'query', 'target', 'mode', 'enablePGS', 'pgsMode', 'pgsLevel',
      'continueFromOperationId', 'targetPartitionIds', 'pgsSweep', 'pgsSynth',
      'modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
      'includeCoordinatorInsights', 'allowActions', 'priorContext',
    ]);
    const turn = runtime(ctx);
    const enablePGS = parsedWhenPresent(input, 'enablePGS', (value) =>
      optionalBoolean(value, 'enablePGS')) ?? false;
    const pgsOnly = [
      'pgsMode', 'pgsLevel', 'continueFromOperationId', 'targetPartitionIds',
      'pgsSweep', 'pgsSynth',
    ];
    const directOnly = ['mode', 'modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
      'includeCoordinatorInsights', 'allowActions', 'priorContext'];
    if ((!enablePGS && pgsOnly.some((key) => hasOwn(input, key)))
        || (enablePGS && directOnly.some((key) => hasOwn(input, key)))) {
      throw invalidRequest();
    }
    const target = targetFrom(input);
    const priorContext = priorContextWhenPresent(input);
    const modelSelection = exactPairWhenPresent(input, 'modelSelection');
    let pgsParameters: Record<string, unknown> | undefined;
    if (enablePGS) {
      const pgsMode = parsedWhenPresent(input, 'pgsMode', (value) =>
        optionalEnum(value, 'pgsMode', PGS_MODES));
      const pgsLevel = parsedWhenPresent(input, 'pgsLevel', (value) =>
        optionalEnum(value, 'pgsLevel', PGS_LEVELS));
      if (pgsMode === undefined) throw invalidRequest('pgsMode_invalid');
      if (pgsLevel === undefined) throw invalidRequest('pgsLevel_invalid');
      const continueFromOperationId = continuationIdWhenPresent(input);
      const targetPartitionIds = targetPartitionIdsWhenPresent(input);
      if (pgsMode === 'fresh' && (continueFromOperationId || targetPartitionIds)) {
        throw invalidRequest('pgsMode_invalid');
      }
      if (pgsMode === 'continue' && (!continueFromOperationId || targetPartitionIds)) {
        throw invalidRequest('pgsMode_invalid');
      }
      if (pgsMode === 'targeted' && !targetPartitionIds) {
        throw invalidRequest('pgsMode_invalid');
      }
      pgsParameters = {
        enablePGS: true,
        pgsMode,
        pgsLevel,
        ...(continueFromOperationId ? { continueFromOperationId } : {}),
        ...(targetPartitionIds ? { targetPartitionIds } : {}),
        pgsSweep: requiredExactPair(input, 'pgsSweep'),
        pgsSynth: requiredExactPair(input, 'pgsSynth'),
      };
    }
    const request = {
      ...(target ? { target } : {}),
      query: requiredToolText(input, 'query', 12_000),
      ...(priorContext !== undefined ? { priorContext } : {}),
      ...(enablePGS ? {
        ...pgsParameters,
      } : {
        mode: parsedWhenPresent(input, 'mode', (value) =>
          optionalEnum(value, 'mode', ['quick', 'full', 'expert', 'dive'] as const))
          ?? DEFAULT_BRAIN_QUERY_MODE,
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
    };
    const operation = await (enablePGS
      ? turn.brainOperations.launchQuery(request, turn.signal)
      : turn.brainOperations.query(request, turn.signal));
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
      'operationId', 'query', 'answer', 'format', 'metadata',
    ]);
    const turn = runtime(ctx);
    const format = parsedWhenPresent(input, 'format', (value) =>
      optionalEnum(value, 'format', ['markdown', 'json'] as const)) ?? 'markdown';
    const canonical = hasOwn(input, 'operationId');
    if (canonical && (hasOwn(input, 'query') || hasOwn(input, 'answer'))) throw invalidRequest();
    if (!canonical && (!hasOwn(input, 'query') || !hasOwn(input, 'answer'))) throw invalidRequest();
    if (canonical && hasOwn(input, 'metadata')) throw invalidRequest();
    const metadata = parsedWhenPresent(input, 'metadata', (value) =>
      optionalJsonObject(value, 'metadata', 32_000));
    const value = canonical
      ? await turn.brainOperations.exportResult({
        operationId: requiredOperationId(input),
        format,
      }, turn.signal)
      : await turn.brainOperations.exportAdHocResult({
        query: requiredToolText(input, 'query', 12_000),
        answer: requiredToolText(input, 'answer', 1_000_000),
        format,
        metadata: { ...(metadata || {}), canonicalEvidence: false },
      }, turn.signal);
    return boundedExportReceipt(value);
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
      if (operation.state === 'complete') {
        if (!operation.resultHandle || !operation.resultArtifact) {
          return {
            ...rendered,
            content: 'invalid_graph_export_result: completed export lacks its durable handle or artifact\n'
              + `operation=${operation.operationId} state=${operation.state}`,
            is_error: true,
            metadata: { ...rendered.metadata, classification: 'invalid_graph_export_result' },
          };
        }
        rendered.content += '\nFull graph stored in requester-owned operation result storage.';
      }
      return rendered;
    }
    if (hasOwn(input, 'format')) throw invalidRequest();
    const nodeLimit = parsedWhenPresent(input, 'topN', (value) =>
      optionalFiniteInteger(value, 'topN', 1, 100)) ?? 25;
    const tag = optionalTagWhenPresent(input);
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
      if (operationId !== undefined && !BRAIN_OPERATION_ID.test(operationId)) {
        throw invalidRequest('operation_id_invalid');
      }
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
      const operationId = requiredOperationId(input);
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
      const operationId = requiredOperationId(input);
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

export const brainCatalogTool: ToolDefinition = {
  name: 'brain_catalog',
  description: 'List authorized brains and exact configured/selectable provider-model pairs; selection is not a credential health probe.',
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  execute: executeBrainCatalog,
};

export const brainOperationsListTool: ToolDefinition = {
  name: 'brain_operations_list',
  description: 'Rediscover requester-owned recent or currently running durable operations and their exact operation IDs.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      state: { type: 'string', enum: ['recent', 'nonterminal'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  execute: executeBrainOperationsList,
};

export const brainPgsPartitionsTool: ToolDefinition = {
  name: 'brain_pgs_partitions',
  description: 'List the complete canonical PGS partition IDs and estimated work for an authorized brain before targeted PGS.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: { target: targetSchema },
  },
  execute: executeBrainPgsPartitions,
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
      pgsMode: { type: 'string', enum: PGS_MODES },
      pgsLevel: { type: 'string', enum: PGS_LEVELS },
      continueFromOperationId: { type: 'string', pattern: BRAIN_OPERATION_ID_PATTERN },
      targetPartitionIds: {
        type: 'array', minItems: 1, maxItems: MAX_PGS_TARGET_PARTITIONS, uniqueItems: true,
        items: {
          type: 'string', minLength: 3, maxLength: 256, pattern: PGS_PARTITION_ID_PATTERN,
        },
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
        description: 'Direct-query follow-up context. Query and answer are limited to 20,000 characters combined.',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 12_000 },
          answer: { type: 'string', minLength: 1, maxLength: 20_000 },
        },
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
      operationId: { type: 'string', pattern: BRAIN_OPERATION_ID_PATTERN },
      query: { type: 'string', minLength: 1 },
      answer: { type: 'string', minLength: 1, maxLength: 1_000_000 },
      format: { type: 'string', enum: ['markdown', 'json'] },
      metadata: { type: 'object', additionalProperties: true },
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
      operationId: { type: 'string', pattern: BRAIN_OPERATION_ID_PATTERN },
      generationMarker: { type: 'string', minLength: 1, maxLength: 256 },
      trigger: { type: 'string', minLength: 1, maxLength: 256 },
      reason: { type: 'string', minLength: 1, maxLength: 4_000 },
    },
  },
  execute: executeBrainSynthesis,
};

export const brainStatusTool: ToolDefinition = {
  name: 'brain_status',
  description: 'Read authoritative bounded brain status; omit all arguments for own-brain health, or control one exact durable operation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: targetSchema,
      operationId: {
        type: 'string', pattern: BRAIN_OPERATION_ID_PATTERN,
        description: 'Exact operation ID returned by a prior brain tool call; never invent one.',
      },
      action: { type: 'string', enum: ['status', 'result', 'wait', 'cancel'] },
    },
  },
  execute: executeBrainStatus,
};
