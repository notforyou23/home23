import type { AttentionItem } from './types.js';
import { macRead, MacSurfaceError, type MacRunner } from './mac.js';

export interface AttentionScanInput {
  hoursAhead?: number;
  query?: string;
  includeMail?: boolean;
  includeFinder?: boolean;
}

export interface AttentionScanOptions {
  signal?: AbortSignal;
  /** Budget for each source, so one slow Mac surface cannot hold the whole scan. */
  sourceBudgetMs?: number;
}

export interface AttentionScanResult {
  items: AttentionItem[];
  degraded: Array<{ source: string; error: string; code: string }>;
  timings: Array<{ source: string; ms: number; code?: string }>;
  generatedAt: string;
}

export const ATTENTION_SOURCE_BUDGET_MS = 12_000;

/** The caller's signal plus a budget. The timer is ref'd (unlike AbortSignal.timeout), so it fires even when a hung source holds nothing else open. */
function budgetSignal(caller: AbortSignal | undefined, budgetMs: number): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('source budget exceeded', 'TimeoutError')), budgetMs);
  const onAbort = () => controller.abort(caller?.reason);
  if (caller?.aborted) onAbort();
  else caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

function needsOwner(item: AttentionItem, now: number, hoursAhead: number): boolean {
  if (item.needsOwner) return true;
  if (item.kind === 'commitment') return true;
  if (item.kind === 'event' && item.when) {
    const ts = Date.parse(item.when);
    if (Number.isFinite(ts) && ts - now < Math.min(hoursAhead, 12) * 3600_000) return true;
  }
  return false;
}

export async function scanAttention(
  input: AttentionScanInput,
  runner: MacRunner,
  options: AttentionScanOptions = {},
): Promise<AttentionScanResult> {
  const hoursAhead = input.hoursAhead ?? 36;
  const query = input.query ?? '';
  const budgetMs = options.sourceBudgetMs ?? ATTENTION_SOURCE_BUDGET_MS;
  const degraded: AttentionScanResult['degraded'] = [];
  const timings: AttentionScanResult['timings'] = [];
  const items: AttentionItem[] = [];

  const sources: Array<{ name: string; read: (signal: AbortSignal) => Promise<AttentionItem[]> }> = [
    { name: 'mac.calendar', read: (signal) => macRead('calendar', query, runner, hoursAhead, { signal }) },
    { name: 'mac.reminders', read: (signal) => macRead('reminders', query, runner, hoursAhead, { signal }) },
    { name: 'mac.notes', read: (signal) => macRead('notes', query, runner, hoursAhead, { signal }) },
  ];
  if (input.includeMail) {
    sources.push({ name: 'mac.mail', read: (signal) => macRead('mail', query, runner, hoursAhead, { signal }) });
  }
  if (input.includeFinder && query) {
    sources.push({ name: 'mac.finder', read: (signal) => macRead('finder', query, runner, hoursAhead, { signal }) });
  }

  for (const source of sources) {
    if (options.signal?.aborted) throw new MacSurfaceError('aborted', 'aborted: attention scan was cancelled');
    const started = Date.now();
    const budget = budgetSignal(options.signal, budgetMs);
    try {
      items.push(...await source.read(budget.signal));
      timings.push({ source: source.name, ms: Date.now() - started });
    } catch (error) {
      const code = error instanceof MacSurfaceError ? error.code : 'error';
      timings.push({ source: source.name, ms: Date.now() - started, code });
      degraded.push({ source: source.name, error: error instanceof Error ? error.message : String(error), code });
    } finally {
      budget.release();
    }
  }
  if (options.signal?.aborted) throw new MacSurfaceError('aborted', 'aborted: attention scan was cancelled');

  const now = Date.now();
  const ranked = items
    .map((item) => ({ ...item, needsOwner: needsOwner(item, now, hoursAhead) }))
    .sort((a, b) => Number(Boolean(b.needsOwner)) - Number(Boolean(a.needsOwner)));

  return {
    items: ranked.slice(0, 40),
    degraded,
    timings,
    generatedAt: new Date().toISOString(),
  };
}
