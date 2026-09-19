import { createHash } from 'node:crypto';
import { ConsoleReadError } from './types.js';

/** IDs are deterministic names, not authorization credentials. */
export function consoleSourceId(rootId: string, kind: string, executionId: string): string {
  return `cs_${createHash('sha256').update(JSON.stringify([rootId, kind, executionId])).digest('base64url').slice(0, 24)}`;
}

export function encodeConsoleCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeConsoleCursor<T>(cursor: string, maxBytes = 8192): T {
  if (!cursor || cursor.length > maxBytes || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ConsoleReadError('invalid_cursor');
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch { throw new ConsoleReadError('invalid_cursor'); }
}

export function isByteOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
