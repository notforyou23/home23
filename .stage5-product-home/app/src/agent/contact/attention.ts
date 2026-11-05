import type { AttentionItem } from './types.js';
import { macRead, type MacRunner } from './mac.js';

export interface AttentionScanInput {
  hoursAhead?: number;
  query?: string;
  includeMail?: boolean;
  includeFinder?: boolean;
}

export interface AttentionScanResult {
  items: AttentionItem[];
  degraded: Array<{ source: string; error: string }>;
  generatedAt: string;
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
): Promise<AttentionScanResult> {
  const hoursAhead = input.hoursAhead ?? 36;
  const query = input.query ?? '';
  const degraded: Array<{ source: string; error: string }> = [];
  const items: AttentionItem[] = [];

  const sources: Array<{ name: string; read: () => Promise<AttentionItem[]> }> = [
    { name: 'mac.calendar', read: () => macRead('calendar', query, runner, hoursAhead) },
    { name: 'mac.reminders', read: () => macRead('reminders', query, runner, hoursAhead) },
    { name: 'mac.notes', read: () => macRead('notes', query, runner, hoursAhead) },
  ];
  if (input.includeMail) {
    sources.push({ name: 'mac.mail', read: () => macRead('mail', query, runner, hoursAhead) });
  }
  if (input.includeFinder && query) {
    sources.push({ name: 'mac.finder', read: () => macRead('finder', query, runner, hoursAhead) });
  }

  for (const source of sources) {
    try {
      items.push(...await source.read());
    } catch (error) {
      degraded.push({
        source: source.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const now = Date.now();
  const ranked = items
    .map((item) => ({ ...item, needsOwner: needsOwner(item, now, hoursAhead) }))
    .sort((a, b) => Number(Boolean(b.needsOwner)) - Number(Boolean(a.needsOwner)));

  return {
    items: ranked.slice(0, 40),
    degraded,
    generatedAt: new Date().toISOString(),
  };
}
