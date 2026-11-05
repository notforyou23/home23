import type {
  BrainOperationEvent,
  BrainOperationEventGap,
  BrainOperationNotification,
  BrainOperationNotificationType,
  BrainOperationState,
} from './types.js';

export interface OperationEventReadOptions {
  signal?: AbortSignal;
  inactivityMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export function isEventGap(event: unknown): event is BrainOperationEventGap {
  return Boolean(event) && typeof event === 'object'
    && (event as { type?: unknown }).type === 'event_gap';
}

export function validateEventGap(
  operationId: string,
  after: number,
  input: BrainOperationEventGap | { details?: unknown },
): BrainOperationEventGap {
  const raw = (input && typeof input === 'object' && 'type' in input
    ? input
    : input?.details) as Partial<BrainOperationEventGap> | undefined;
  const gap = raw?.type === 'event_gap'
    ? raw
    : ({ ...raw, type: 'event_gap' } as Partial<BrainOperationEventGap>);
  if (gap.operationId !== operationId
      || !Number.isSafeInteger(gap.oldestSequence)
      || !Number.isSafeInteger(gap.latestSequence)
      || Number(gap.oldestSequence) <= after
      || Number(gap.oldestSequence) > Number(gap.latestSequence)
      || (gap.eventSequence !== undefined
        && (!Number.isSafeInteger(gap.eventSequence)
          || Number(gap.eventSequence) < Number(gap.latestSequence)
          || Number(gap.eventSequence) <= after))
      || (gap.currentStatus !== undefined
        && (gap.currentStatus.operationId !== operationId
          || !Number.isSafeInteger(gap.currentStatus.eventSequence)
          || gap.currentStatus.eventSequence < Number(gap.latestSequence)
          || gap.currentStatus.eventSequence <= after))) {
    throw Object.assign(new Error('operation_event_gap_invalid'), {
      code: 'operation_event_gap_invalid',
    });
  }
  return gap as BrainOperationEventGap;
}

const NOTIFICATION_TYPES = new Set<BrainOperationNotificationType>([
  'heartbeat', 'phase', 'progress', 'progress_update', 'provider_activity',
  'provider_call_terminal', 'provider_selected', 'result_ready',
  'source_pin_attached', 'state', 'terminal', 'token', 'token_estimate',
  'worker_assigned',
]);

const OPERATION_STATES = new Set<BrainOperationState>([
  'queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);

const TERMINAL_STATES = new Set<BrainOperationState>([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);

function validateNotification(
  operationId: string,
  lastSequence: number,
  input: unknown,
): BrainOperationNotification {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw Object.assign(new Error('operation_event_invalid'), { code: 'operation_event_invalid' });
  }
  const event = input as Partial<BrainOperationNotification> & Record<string, unknown>;
  if (event.operationId !== operationId) {
    throw Object.assign(new Error('operation_event_mismatch'), { code: 'operation_event_mismatch' });
  }
  if (typeof event.type !== 'string'
      || !NOTIFICATION_TYPES.has(event.type as BrainOperationNotificationType)) {
    throw Object.assign(new Error('operation_event_invalid'), { code: 'operation_event_invalid' });
  }
  if (!Number.isSafeInteger(event.eventSequence) || Number(event.eventSequence) <= lastSequence
      || (event.sequence !== undefined && event.sequence !== event.eventSequence)) {
    throw Object.assign(new Error('operation_event_out_of_order'), {
      code: 'operation_event_out_of_order',
    });
  }
  if (event.state !== undefined && !OPERATION_STATES.has(event.state)) {
    throw Object.assign(new Error('operation_event_invalid'), { code: 'operation_event_invalid' });
  }
  if (event.type === 'terminal' && (!event.state || !TERMINAL_STATES.has(event.state))) {
    throw Object.assign(new Error('operation_event_invalid'), { code: 'operation_event_invalid' });
  }
  if (event.type === 'phase' && (typeof event.phase !== 'string' || !event.phase)) {
    throw Object.assign(new Error('operation_event_invalid'), { code: 'operation_event_invalid' });
  }
  for (const field of ['at', 'updatedAt'] as const) {
    if (event[field] !== undefined && typeof event[field] !== 'string') {
      throw Object.assign(new Error('operation_event_invalid'), { code: 'operation_event_invalid' });
    }
  }
  return event as BrainOperationNotification;
}

function readWithInactivity(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: OperationEventReadOptions,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout
    ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const inactivityMs = options.inactivityMs ?? 60_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(options.signal?.reason ?? new Error('operation_event_aborted')));
    const timer = setTimer(
      () => finish(() => reject(Object.assign(new Error('operation_event_inactive'), { code: 'operation_event_inactive' }))),
      inactivityMs,
    );
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function* parseOperationEvents(
  body: ReadableStream<Uint8Array>,
  operationId: string,
  after: number,
  options: OperationEventReadOptions = {},
): AsyncGenerator<BrainOperationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSequence = after;
  const parseFrame = (frame: string): BrainOperationEvent | null => {
    const payload = frame.replace(/\r\n/g, '\n').split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!payload || payload === '[DONE]') return null;
    const event = JSON.parse(payload) as unknown;
    if (isEventGap(event)) {
      const gap = validateEventGap(operationId, lastSequence, event);
      lastSequence = gap.eventSequence ?? gap.latestSequence;
      return gap;
    }
    const notification = validateNotification(operationId, lastSequence, event);
    lastSequence = notification.eventSequence;
    return notification;
  };
  try {
    while (true) {
      const { done, value } = await readWithInactivity(reader, options);
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) {
          yield event;
          if (isEventGap(event)) return;
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        const finalEvent = parseFrame(buffer);
        if (finalEvent) yield finalEvent;
        buffer = '';
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
