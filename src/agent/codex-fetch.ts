import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const DIAGNOSTIC_CODES = new Set([...TRANSIENT_CODES,
  'ENOTFOUND', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const DIAGNOSTIC_NAMES = new Set(['Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError']);

/** Only fixed allowlisted tokens escape; never copy error messages or request data. */
function diagnostic(error: unknown): { names: string[]; codes: string[] } {
  const names = new Set<string>();
  const codes = new Set<string>();
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length > 0 && count < 16; count++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const item = value as { name?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    names.add(typeof item.name === 'string' && DIAGNOSTIC_NAMES.has(item.name) ? item.name : 'Error');
    if (item.code !== undefined) codes.add(typeof item.code === 'string' && DIAGNOSTIC_CODES.has(item.code) ? item.code : 'OTHER');
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 16));
  }
  if (pending.length > 0) codes.add('OTHER');
  return { names: [...names].sort(), codes: [...codes].sort() };
}

/** Retry transport establishment only. A returned Response (including its body) is never replayed. */
export async function fetchCodexResponse(
  url: string,
  init: RequestInit & { body: string; signal: AbortSignal },
): Promise<Response> {
  // Freeze the exact request inputs once, including headers, across both attempts.
  const request = { ...init, headers: new Headers(init.headers) };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (init.signal.aborted) throw new Error('codex transport request aborted before fetch');
    try {
      return await fetch(url, request);
    } catch (error) {
      const detail = diagnostic(error);
      const aborted = init.signal.aborted || detail.names.includes('AbortError') || detail.names.includes('TimeoutError');
      const retry = !aborted && attempt === 1 && detail.codes.length > 0
        && detail.codes.every(code => TRANSIENT_CODES.has(code));
      const summary = `codex transport failure (attempt=${attempt}; names=${detail.names.join(',') || 'Error'}; codes=${detail.codes.join(',') || 'UNKNOWN'}; state=${aborted ? 'aborted' : 'transport'})`;
      console.warn(`[agent] ${summary}; retry=${retry}`);
      if (!retry) throw new Error(summary);
      try {
        await delay(250, undefined, { signal: init.signal });
      } catch {
        throw new Error('codex transport retry aborted before second attempt');
      }
    }
  }
  throw new Error('codex transport attempts exhausted');
}
