import type { BrainOperationResult } from './brain-operations/types.js';
import type { ToolRegistry } from './tools/index.js';
import type {
  AgentEventCallback,
  BrainToolEventMetadata,
  ToolContext,
  ToolResult,
} from './types.js';

const OPERATION_ID = /^brop_[A-Za-z0-9_-]{32}$/;
const RESULT_HANDLE = /^brres_[A-Za-z0-9_-]{32}$/;
const OPERATION_TYPE = /^[a-z][a-z0-9_-]{0,63}$/;
const OPERATION_STATES = new Set([
  'queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const ATTACHMENT_STATES = new Set(['attached', 'detached', 'closed']);
const PGS_FIELDS = new Set([
  'totalPartitions', 'completedPartitions', 'successfulSweeps', 'failedSweeps',
  'pendingWorkUnits', 'completedWorkUnits', 'totalWorkUnits', 'coverage',
  'mode', 'level', 'fresh',
]);
const SOURCE_FIELDS = new Set([
  'sourceHealth', 'implementation', 'currentRevision', 'baseRevision',
  'deltaRevision', 'builtFromRevision', 'fresh', 'fallbackReason', 'matchOutcome',
  'freshness', 'nodeCount', 'edgeCount', 'retrievalMode',
]);
const INDEX_COVERAGE_FIELDS = new Set([
  'complete', 'indexedRevision', 'currentRevision', 'coveredThroughRevision',
  'deltaRecords', 'distinctChangedNodes', 'distinctUpsertedNodes',
  'distinctRemovedNodes', 'edgeOnlyRecords', 'route', 'completeness',
]);
const STAGE_TIMING_FIELDS = new Set([
  'sourceOpen', 'embedding', 'overlayRefresh', 'annLoad', 'annSearch',
  'overlayScoring', 'keywordScoring', 'merge', 'response',
]);
const AUTHORITY_CLASSES = new Set([
  'verified_current_state', 'jtr_correction', 'artifact_log', 'worker_receipt',
  'generated_doctrine', 'narrative',
]);
const RETRIEVAL_DOMAINS = new Set([
  'current_ops', 'closed_incidents', 'project_history', 'external_intake',
]);
const SOURCE_CHAIN_KINDS = new Set([
  'source', 'evidence', 'artifact', 'trace', 'generation', 'lineage',
  'verification', 'closure',
]);
const MAX_EVENT_METADATA_BYTES = 32 * 1024;

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function safePrimitive(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= 256 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) {
    return value;
  }
  return undefined;
}

function projectPrimitiveRecord(
  value: unknown,
  allowed: Set<string>,
): Record<string, string | number | boolean | null> | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const projected: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const primitive = safePrimitive(ownDataValue(source, key));
    if (primitive !== undefined) projected[key] = primitive;
  }
  return Object.keys(projected).length ? projected : undefined;
}

function projectError(value: unknown): BrainToolEventMetadata['error'] | undefined {
  const error = recordValue(value);
  if (!error) return undefined;
  const code = boundedString(ownDataValue(error, 'code'), 128);
  const message = boundedString(ownDataValue(error, 'message'), 1_024);
  const retryable = ownDataValue(error, 'retryable');
  return code && message && typeof retryable === 'boolean'
    ? { code, message, retryable }
    : undefined;
}

function projectCountRecord(value: unknown, allowed: Set<string>): Record<string, number> | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const projected: Record<string, number> = {};
  for (const key of allowed) {
    const entry = ownDataValue(source, key);
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
      projected[key] = entry;
    }
  }
  return Object.keys(projected).length ? projected : undefined;
}

function projectSourceEvidence(value: unknown): Record<string, unknown> | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = projectPrimitiveRecord(source, SOURCE_FIELDS) || {};
  const indexCoverage = projectPrimitiveRecord(
    ownDataValue(source, 'indexCoverage'), INDEX_COVERAGE_FIELDS,
  );
  if (indexCoverage) projected.indexCoverage = indexCoverage;
  const timings = recordValue(ownDataValue(source, 'stageTimingsMs'));
  if (timings) {
    const safeTimings: Record<string, number> = {};
    for (const key of STAGE_TIMING_FIELDS) {
      const entry = ownDataValue(timings, key);
      if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) safeTimings[key] = entry;
    }
    if (Object.keys(safeTimings).length) projected.stageTimingsMs = safeTimings;
  }
  const authority = recordValue(ownDataValue(source, 'authoritySummary'));
  if (authority) {
    const summary: Record<string, unknown> = {};
    for (const key of ['total', 'requiresFreshVerification']) {
      const entry = ownDataValue(authority, key);
      if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) summary[key] = entry;
    }
    const authorityClasses = projectCountRecord(
      ownDataValue(authority, 'authorityClasses'), AUTHORITY_CLASSES,
    );
    const retrievalDomains = projectCountRecord(
      ownDataValue(authority, 'retrievalDomains'), RETRIEVAL_DOMAINS,
    );
    if (authorityClasses) summary.authorityClasses = authorityClasses;
    if (retrievalDomains) summary.retrievalDomains = retrievalDomains;
    const chain = recordValue(ownDataValue(authority, 'sourceChain'));
    if (chain) {
      const chainSummary: Record<string, unknown> = {};
      for (const key of ['withEvidence', 'withoutEvidence']) {
        const entry = ownDataValue(chain, key);
        if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
          chainSummary[key] = entry;
        }
      }
      const referenceCounts = projectCountRecord(
        ownDataValue(chain, 'referenceCounts'), SOURCE_CHAIN_KINDS,
      );
      if (referenceCounts) chainSummary.referenceCounts = referenceCounts;
      if (Object.keys(chainSummary).length) summary.sourceChain = chainSummary;
    }
    if (Object.keys(summary).length) projected.authoritySummary = summary;
  }
  return Object.keys(projected).length ? projected : undefined;
}

export function projectBrainToolEventMetadata(
  toolName: string,
  result: ToolResult,
): { resultHandle?: string; toolMetadata?: BrainToolEventMetadata } {
  if (!toolName.startsWith('brain_')) return {};
  const resultRecord = result as unknown as Record<string, unknown>;
  const metadata = recordValue(ownDataValue(resultRecord, 'metadata'));
  if (!metadata) return {};
  const operationId = ownDataValue(metadata, 'operationId');
  const state = ownDataValue(metadata, 'state');
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)
      || typeof state !== 'string' || !OPERATION_STATES.has(state)) return {};

  const projected: BrainToolEventMetadata = {
    operationId,
    state: state as BrainToolEventMetadata['state'],
  };
  const operationType = boundedString(ownDataValue(metadata, 'operationType'), 64);
  if (operationType && OPERATION_TYPE.test(operationType)) projected.operationType = operationType;
  const attachmentState = ownDataValue(metadata, 'attachmentState');
  if (typeof attachmentState === 'string' && ATTACHMENT_STATES.has(attachmentState)) {
    projected.attachmentState = attachmentState as NonNullable<BrainToolEventMetadata['attachmentState']>;
  }
  const classification = boundedString(ownDataValue(metadata, 'classification'), 128);
  if (classification) projected.classification = classification;
  const error = projectError(ownDataValue(metadata, 'error'));
  if (error) projected.error = error;
  const pgs = projectPrimitiveRecord(ownDataValue(metadata, 'pgs'), PGS_FIELDS);
  if (pgs) projected.pgs = pgs;
  const sourceEvidence = projectSourceEvidence(ownDataValue(metadata, 'sourceEvidence'));
  if (sourceEvidence) projected.sourceEvidence = sourceEvidence;
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_EVENT_METADATA_BYTES) return {};

  return {
    ...(typeof ownDataValue(resultRecord, 'resultHandle') === 'string'
        && RESULT_HANDLE.test(ownDataValue(resultRecord, 'resultHandle') as string)
      ? { resultHandle: ownDataValue(resultRecord, 'resultHandle') as string }
      : {}),
    toolMetadata: projected,
  };
}

function validateDisplayLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 128) {
    throw new Error('tool_display_limit_invalid');
  }
}

export function recoverableExcerpt(
  content: string,
  limit: number,
  reference: { resultHandle?: string | null; operationId?: string | null },
): string {
  validateDisplayLimit(limit);
  if (content.length <= limit) return content;
  const locator = [
    reference.resultHandle ? `handle=${reference.resultHandle}` : null,
    reference.operationId ? `operation=${reference.operationId}` : null,
  ].filter(Boolean).join(' ') || 'no durable reference';
  const marker = `\n\n[OUTPUT TRUNCATED; full result: ${locator}]`;
  if (marker.length > limit) throw new Error('recoverable_marker_too_large');
  const prefixLength = limit - marker.length;
  let prefix = content.slice(0, prefixLength);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = `${prefix.slice(0, -1)}…`;
  return `${prefix}${marker}`;
}

function isTypedTerminalError(error: BrainOperationResult['error']): boolean {
  return Boolean(error
    && typeof error.code === 'string' && error.code.trim()
    && typeof error.message === 'string' && error.message.trim()
    && typeof error.retryable === 'boolean');
}

export function operationToolResult(operation: BrainOperationResult): ToolResult {
  const answer = typeof operation.result?.answer === 'string' ? operation.result.answer : '';
  const sweepOutputs = Array.isArray(operation.result?.sweepOutputs)
    ? operation.result.sweepOutputs as Array<Record<string, unknown>>
    : [];
  const pgs = operation.result?.metadata && typeof operation.result.metadata === 'object'
    ? (operation.result.metadata as { pgs?: Record<string, unknown> }).pgs
    : undefined;
  const successfulSweeps = pgs?.successfulSweeps;
  const retryablePartitions = pgs?.retryablePartitions;
  const validSweep = (sweep: Record<string, unknown>): boolean =>
    Object.keys(sweep).sort().join(',') === 'model,output,partitionId,provider,workUnitId'
    && ['workUnitId', 'partitionId', 'output', 'provider', 'model'].every(key =>
      typeof sweep[key] === 'string' && Boolean((sweep[key] as string).trim()));
  const validRetryable = Array.isArray(retryablePartitions)
    && retryablePartitions.every(value => typeof value === 'string' && Boolean(value.trim()))
    && new Set(retryablePartitions).size === retryablePartitions.length
    && retryablePartitions.every((value, index) =>
      index === 0 || retryablePartitions[index - 1] < value);
  const typedPartialError = isTypedTerminalError(operation.error);
  const isPgsPartial = operation.state === 'partial' && operation.operationType === 'pgs';
  const isQueryPartial = operation.state === 'partial' && operation.operationType === 'query';
  const usefulPgsPartial = isPgsPartial && sweepOutputs.length > 0
    && typeof successfulSweeps === 'number' && Number.isSafeInteger(successfulSweeps)
    && successfulSweeps >= 0 && successfulSweeps === sweepOutputs.length
    && sweepOutputs.every(validSweep) && validRetryable && typedPartialError;
  const usefulQueryPartial = isQueryPartial && Boolean(answer.trim()) && typedPartialError;
  const usefulPartial = usefulPgsPartial || usefulQueryPartial;
  const invalidPartial = operation.state === 'partial' && !usefulPartial;
  const supplementalResult = operation.result && typeof operation.result === 'object'
    ? Object.fromEntries(Object.entries(operation.result).filter(([key]) =>
      !['answer', 'sweepOutputs', 'metadata'].includes(key)))
    : {};
  const supplementalText = Object.keys(supplementalResult).length
    ? JSON.stringify(supplementalResult)
    : '';
  const useful = answer.trim()
    ? `${answer.trim()}${supplementalText ? `\n${supplementalText}` : ''}`
    : sweepOutputs.length
      ? sweepOutputs
        .map((sweep, index) => `Sweep ${index + 1}: ${String(sweep.output || '')}`)
        .join('\n')
      : JSON.stringify(operation.result || {});
  const stateLine = `operation=${operation.operationId} state=${operation.state}`;
  const errorLine = operation.error
    ? `\n${operation.error.code}: ${operation.error.message} (retryable=${operation.error.retryable})`
    : '';

  if (operation.state === 'failed'
      || operation.state === 'cancelled'
      || operation.state === 'interrupted') {
    return {
      content: `${stateLine}\n${operation.error?.code || 'operation_failed'}: ${operation.error?.message || 'No result'}`,
      is_error: true,
      resultHandle: operation.resultHandle || undefined,
      metadata: {
        operationId: operation.operationId,
        operationType: operation.operationType,
        state: operation.state,
        attachmentState: operation.attachmentState,
        classification: operation.operationType === 'pgs' ? 'all_failed' : operation.state,
        pgs,
        sweepOutputs,
        error: operation.error,
        resultArtifact: operation.resultArtifact,
        sourceEvidence: operation.sourceEvidence,
      },
    };
  }

  const detachedGuidance = operation.attachmentState === 'detached'
      && (operation.state === 'queued' || operation.state === 'running')
    ? `\nStarted in the background; the durable operation is ${operation.state}. Check with brain_status {action:"status",operationId:"${operation.operationId}"}, then use action:"result" after it is terminal. Use action:"wait" only when intentionally blocking.`
    : '';
  return {
    content: `${invalidPartial ? 'invalid_partial_result: malformed partial payload' : useful}`
      + `${invalidPartial ? '' : errorLine}\n\n---\n[${stateLine}]${detachedGuidance}`,
    is_error: invalidPartial ? true : undefined,
    resultHandle: operation.resultHandle || undefined,
    metadata: {
      operationId: operation.operationId,
      operationType: operation.operationType,
      state: operation.state,
      attachmentState: operation.attachmentState,
      classification: usefulPartial
        ? 'useful_partial'
        : invalidPartial ? 'invalid_partial_result' : operation.state,
      pgs,
      sweepOutputs,
      error: operation.error,
      resultArtifact: operation.resultArtifact,
      sourceEvidence: operation.sourceEvidence,
    },
  };
}

function visibleContent(result: ToolResult, limit: number): string {
  const operationId = typeof result.metadata?.operationId === 'string'
    ? result.metadata.operationId
    : null;
  return recoverableExcerpt(result.content, limit, {
    resultHandle: result.resultHandle,
    operationId,
  });
}

export async function executeAndFormatTool(input: {
  registry: ToolRegistry;
  name: string;
  input: Record<string, unknown>;
  context: ToolContext;
  onEvent?: AgentEventCallback;
  modelLimit: number;
  eventLimit: number;
}): Promise<{
  result: ToolResult;
  modelContent: string;
  eventContent: string;
  success: boolean;
}> {
  validateDisplayLimit(input.modelLimit);
  validateDisplayLimit(input.eventLimit);
  const result = await input.registry.execute(input.name, input.input, input.context);
  const success = result.is_error !== true;
  const modelContent = visibleContent(result, input.modelLimit);
  const eventContent = visibleContent(result, input.eventLimit);
  const eventMetadata = projectBrainToolEventMetadata(input.name, result);
  input.onEvent?.({
    type: 'tool_result',
    tool: input.name,
    result: eventContent,
    success,
    ...eventMetadata,
  });
  return { result, modelContent, eventContent, success };
}
