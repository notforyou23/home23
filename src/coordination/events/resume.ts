export interface EventResumeCursorInput {
  after?: number;
  lastEventId?: string;
}

function queryCursor(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("event after cursor must be a nonnegative safe integer");
  }
  return value;
}

function headerCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError("Last-Event-ID must be a decimal nonnegative safe integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("Last-Event-ID must be a decimal nonnegative safe integer");
  }
  return parsed;
}

export function resolveEventResumeSequence(input: EventResumeCursorInput): number {
  const after = queryCursor(input.after);
  const lastEventId = headerCursor(input.lastEventId);
  if (after !== undefined && lastEventId !== undefined && after !== lastEventId) {
    throw new TypeError("event resume cursors disagree");
  }
  return lastEventId ?? after ?? 0;
}
