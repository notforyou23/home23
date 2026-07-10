import type { BrainOperationEvent, BrainOperationEventGap } from './types.js';

export interface OperationEventReadOptions {
  signal?: AbortSignal;
  inactivityMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export function isEventGap(event: BrainOperationEvent): event is BrainOperationEventGap {
  return (event as { type?: unknown }).type === 'event_gap';
}

export function validateEventGap(
  operationId: string,
  after: number,
  input: BrainOperationEventGap | { details?: unknown },
): BrainOperationEventGap {
  const raw = ('type' in input ? input : input.details) as Partial<BrainOperationEventGap> | undefined;
  const gap = raw?.type === 'event_gap'
    ? raw
    : ({ ...raw, type: 'event_gap' } as Partial<BrainOperationEventGap>);
  if (gap.operationId !== operationId
      || !Number.isSafeInteger(gap.oldestSequence)
      || !Number.isSafeInteger(gap.latestSequence)
      || Number(gap.oldestSequence) <= after
      || Number(gap.oldestSequence) > Number(gap.latestSequence)
      || !gap.currentStatus
      || gap.currentStatus.operationId !== operationId
      || !Number.isSafeInteger(gap.currentStatus.eventSequence)
      || gap.currentStatus.eventSequence < Number(gap.latestSequence)
      || gap.currentStatus.eventSequence <= after) {
    throw Object.assign(new Error('operation_event_gap_invalid'), {
      code: 'operation_event_gap_invalid',
    });
  }
  return gap as BrainOperationEventGap;
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
    const event = JSON.parse(payload) as BrainOperationEvent;
    if (isEventGap(event)) {
      const gap = validateEventGap(operationId, lastSequence, event);
      lastSequence = gap.currentStatus.eventSequence;
      return gap;
    }
    if (event.operationId !== operationId) throw new Error('operation_event_mismatch');
    if (!Number.isInteger(event.eventSequence) || event.eventSequence <= lastSequence) {
      throw new Error('operation_event_out_of_order');
    }
    lastSequence = event.eventSequence;
    return event;
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
