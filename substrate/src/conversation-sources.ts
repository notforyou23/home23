import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { SeedRunnerOptions } from './runner.js';

/** Resolve supervised conversation subscriptions before starting a runner.
 * Preserve the single-source cursor; additional owner-only sources have a
 * stable path-derived identity independent of declaration order. */
export function resolveConversationSources(
  env: Record<string, string | undefined>, backfillBytes: number,
): NonNullable<SeedRunnerOptions['extraSources']> {
  const sources: NonNullable<SeedRunnerOptions['extraSources']> = [];
  const seen = new Set<string>();
  const own = env['SEED_CONVERSATION_SOURCE'];
  if (own !== undefined && own !== '') {
    seen.add(resolve(own));
    sources.push({ sourcePath: own, sourceType: 'conversation-stream', id: 'conversation', backfillBytes });
  }
  const raw = env['SEED_OWNER_CONVERSATION_SOURCES'];
  if (raw === undefined || raw === '') return sources;
  let paths: unknown;
  try { paths = JSON.parse(raw); }
  catch { throw new Error('SEED_OWNER_CONVERSATION_SOURCES must be a JSON array of nonempty source paths'); }
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.trim() || path.includes('\0'))) {
    throw new Error('SEED_OWNER_CONVERSATION_SOURCES must be a JSON array of nonempty source paths');
  }
  for (const path of paths as string[]) {
    const sourcePath = resolve(path);
    if (seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    const id = `owner-conversation-${createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}`;
    sources.push({ sourcePath, sourceType: 'owner-conversation-stream', id, backfillBytes });
  }
  return sources;
}
