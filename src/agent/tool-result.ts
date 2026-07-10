import type { BrainOperationResult } from './brain-operations/types.js';
import type { ToolRegistry } from './tools/index.js';
import type { AgentEventCallback, ToolContext, ToolResult } from './types.js';

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
  const useful = answer.trim() || (sweepOutputs.length
    ? sweepOutputs
      .map((sweep, index) => `Sweep ${index + 1}: ${String(sweep.output || '')}`)
      .join('\n')
    : JSON.stringify(operation.result || {}));
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
        state: operation.state,
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
      && operation.state === 'running'
    ? `\nDetached from wait; the durable operation is still running. Resume with brain_status {action:"wait",operationId:"${operation.operationId}"}.`
    : '';
  return {
    content: `${invalidPartial ? 'invalid_partial_result: malformed partial payload' : useful}`
      + `${invalidPartial ? '' : errorLine}\n\n---\n[${stateLine}]${detachedGuidance}`,
    is_error: invalidPartial ? true : undefined,
    resultHandle: operation.resultHandle || undefined,
    metadata: {
      operationId: operation.operationId,
      state: operation.state,
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
  input.onEvent?.({
    type: 'tool_result',
    tool: input.name,
    result: eventContent,
    success,
  });
  return { result, modelContent, eventContent, success };
}
