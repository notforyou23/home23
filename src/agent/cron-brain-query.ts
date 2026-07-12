import type { BrainOperationsClient } from './brain-operations/client.js';
import type {
  BrainOperationResult,
  BrainOperationState,
  BrainQueryRequest,
} from './brain-operations/types.js';

export interface CronBrainQueryPayload {
  message: string;
  mode?: string;
  model?: string;
  timeoutSeconds?: number;
}

export interface CronBrainQueryResult {
  text: string;
  operationId: string;
  state: BrainOperationState;
  partial: boolean;
}

type ModelAliases = Record<string, { provider: string; model: string }>;

export const DEFAULT_CRON_BRAIN_QUERY_TIMEOUT_SECONDS = 5_400;
export const CRON_TIMEOUT_MIN_SECONDS = 1;
// Node schedules one timer for this deadline and clamps delays above the signed
// 32-bit millisecond ceiling to 1 ms. Whole seconds avoid that overflow while
// remaining well above Home23's six-hour agent-turn default.
export const CRON_TIMEOUT_MAX_SECONDS = Math.floor(0x7fff_ffff / 1_000);

export interface CronBrainQueryJobOutcome {
  status: 'ok' | 'error';
  response?: string;
  error?: string;
  semanticStatus: 'satisfied' | 'failed' | 'unknown';
}

export interface CronBrainQueryJobOptions {
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export function preserveCronBrainQueryDeliveryFailure(
  outcome: CronBrainQueryJobOutcome,
  deliveryError: string,
): CronBrainQueryJobOutcome {
  const deliveryAuthority = `[code=delivery_failed] ${deliveryError}`;
  return {
    ...outcome,
    status: 'error',
    error: outcome.error
      ? `${outcome.error}\n${deliveryAuthority}`
      : deliveryAuthority,
  };
}

function cronQueryError(
  code: string,
  message: string,
  operationId?: string,
  retryable?: boolean,
): Error & { code: string; operationId?: string; retryable?: boolean } {
  return Object.assign(new Error(message), {
    code,
    ...(operationId ? { operationId } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  });
}

export function validateCronTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)
      || (value as number) < CRON_TIMEOUT_MIN_SECONDS
      || (value as number) > CRON_TIMEOUT_MAX_SECONDS) {
    throw cronQueryError(
      'cron_timeout_seconds_invalid',
      `timeout_seconds must be a whole number from ${CRON_TIMEOUT_MIN_SECONDS} through ${CRON_TIMEOUT_MAX_SECONDS}`,
    );
  }
  return value as number;
}

function boundedText(value: unknown, field: string, maxCharacters: number): string {
  if (typeof value !== 'string' || !value.trim()
      || value.length > maxCharacters) {
    throw cronQueryError(`cron_brain_query_${field}_invalid`, `${field} is invalid`);
  }
  return value.trim();
}

function queryMode(value: unknown): BrainQueryRequest['mode'] {
  if (value === undefined) return 'quick';
  if (value === 'quick' || value === 'full' || value === 'expert' || value === 'dive') {
    return value;
  }
  throw cronQueryError('cron_brain_query_mode_invalid', 'scheduled brain query mode is invalid');
}

function modelSelection(alias: unknown, aliases: ModelAliases) {
  if (alias === undefined) return undefined;
  const name = boundedText(alias, 'model_alias', 256);
  const selected = aliases[name];
  if (!selected || typeof selected.provider !== 'string' || !selected.provider.trim()
      || typeof selected.model !== 'string' || !selected.model.trim()) {
    throw cronQueryError(
      'cron_brain_query_model_alias_not_found',
      `scheduled brain query model alias not found: ${name}`,
    );
  }
  return { provider: selected.provider, model: selected.model };
}

function answerFrom(operation: BrainOperationResult): string | null {
  const answer = operation.result?.answer;
  return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
}

function renderOperation(operation: BrainOperationResult): CronBrainQueryResult {
  const { operationId, state } = operation;
  if (state === 'complete') {
    const answer = answerFrom(operation);
    if (!answer) {
      throw cronQueryError(
        'cron_brain_query_result_invalid',
        'completed scheduled brain query has no nonempty answer',
        operationId,
      );
    }
    return { text: answer, operationId, state, partial: false };
  }
  if (state === 'partial') {
    const answer = answerFrom(operation);
    if (!answer || !operation.error?.code) {
      throw cronQueryError(
        'cron_brain_query_partial_invalid',
        'partial scheduled brain query has no useful answer and typed error',
        operationId,
      );
    }
    return {
      text: `${answer}\n\n[Partial brain result: ${operation.error.code}; operation=${operationId}]`,
      operationId,
      state,
      partial: true,
    };
  }
  if (state === 'queued' || state === 'running') {
    return {
      text: `Brain operation ${operationId} is still running; no duplicate was started. `
        + `Resume with brain_status {action:"wait",operationId:"${operationId}"} `
        + 'or read its terminal result with action:"result".',
      operationId,
      state,
      partial: false,
    };
  }
  throw cronQueryError(
    operation.error?.code || state,
    operation.error?.message || `scheduled brain query ended ${state}`,
    operationId,
    operation.error?.retryable,
  );
}

function formatCronBrainQueryFailure(error: unknown): string {
  const typed = error as {
    code?: unknown;
    operationId?: unknown;
    retryable?: unknown;
    operation?: BrainOperationResult;
  } | null;
  const code = typeof typed?.code === 'string' && typed.code
    ? typed.code : 'cron_brain_query_failed';
  const operationId = typeof typed?.operationId === 'string' && typed.operationId
    ? typed.operationId
    : typeof typed?.operation?.operationId === 'string' && typed.operation.operationId
      ? typed.operation.operationId : undefined;
  const retryable = typeof typed?.retryable === 'boolean'
    ? typed.retryable
    : typeof typed?.operation?.error?.retryable === 'boolean'
      ? typed.operation.error.retryable : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const authority = [
    `code=${code}`,
    ...(operationId ? [`operation=${operationId}`] : []),
    ...(retryable !== undefined ? [`retryable=${retryable}`] : []),
  ];
  return `[${authority.join(' ')}] ${message}`;
}

function createWaitDeadline(
  timeoutSeconds: number,
  options: CronBrainQueryJobOptions,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const setTimer = options.setTimeout
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimeout
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const handle = setTimer(() => controller.abort(
    Object.assign(new Error('wait_deadline'), { code: 'wait_deadline' }),
  ), timeoutSeconds * 1_000);
  (handle as { unref?: () => void } | null)?.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimer(handle),
  };
}

export async function runCronBrainQuery(
  client: Pick<BrainOperationsClient, 'query'>,
  payload: CronBrainQueryPayload,
  aliases: ModelAliases,
  signal?: AbortSignal,
): Promise<CronBrainQueryResult> {
  const query = boundedText(payload.message, 'message', 12_000);
  const selected = modelSelection(payload.model, aliases);
  const request: BrainQueryRequest = {
    query,
    mode: queryMode(payload.mode),
    ...(selected ? { modelSelection: selected } : {}),
  };
  return renderOperation(await client.query(request, signal));
}

export async function runCronBrainQueryJob(
  client: Pick<BrainOperationsClient, 'query'>,
  payload: CronBrainQueryPayload,
  aliases: ModelAliases,
  options: CronBrainQueryJobOptions = {},
): Promise<CronBrainQueryJobOutcome> {
  let deadline: { signal: AbortSignal; dispose: () => void } | undefined;
  try {
    const timeoutSeconds = validateCronTimeoutSeconds(payload.timeoutSeconds)
      ?? DEFAULT_CRON_BRAIN_QUERY_TIMEOUT_SECONDS;
    deadline = createWaitDeadline(timeoutSeconds, options);
    const result = await runCronBrainQuery(client, payload, aliases, deadline.signal);
    return {
      status: 'ok',
      response: result.text,
      semanticStatus: result.state === 'complete' ? 'satisfied' : 'unknown',
    };
  } catch (error) {
    return {
      status: 'error',
      error: formatCronBrainQueryFailure(error),
      semanticStatus: 'failed',
    };
  } finally {
    deadline?.dispose();
  }
}
