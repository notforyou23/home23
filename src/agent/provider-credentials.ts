/**
 * Provider credential resolution — read-at-use, from the single source of
 * truth. THE fix for the token-rotation class (2026-08-10, after the third
 * bite in three weeks).
 *
 * The underlying disease every incident shared (Jul 27 codex lapse, Aug 8–9
 * fleet codex-death, Aug 9 the broker's 16h-old token, Aug 10 the seeds'
 * revoked Anthropic token): credentials were distributed BY VALUE — copied
 * into process env or boot-time config and frozen there. Rotation then
 * requires knowing every consumer and restarting each; every consumer
 * missing from a restart list is a future outage.
 *
 * The cure: consumers resolve the credential AT USE TIME from
 * config/secrets.yaml (the file the OAuth mirror keeps fresh), with an
 * mtime-checked cache and a force-reread path for auth failures. Rotation
 * becomes a file write. No restart lists. No frozen env.
 *
 * The one deliberate exception: a configured key that is NOT a managed OAuth
 * token (sk-ant-oat*) is treated as a deliberately pinned static API key and
 * respected as configured — the rotating-managed class is exactly the OAuth
 * tokens; static keys don't rotate under anyone.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { getHome23Root } from '../config.js';

/** Env fallbacks per provider — the pre-existing behavior, kept as the floor
 * so credential-free hosts and tests keep working unchanged. */
const ENV_FALLBACKS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY'],
};

const CACHE_CHECK_MS = 15_000;

let cache: { mtimeMs: number; checkedAt: number; providers: Record<string, string> } | null = null;

function secretsPath(): string {
  const override = process.env['HOME23_SECRETS_PATH'];
  if (override !== undefined && override !== '') return override;
  // Immutable coordination releases deliberately contain no live config.
  // HOME23_ROOT is the explicit installation boundary; the module-relative
  // packaged root remains the public-install fallback when it is absent.
  return join(getHome23Root(), 'config', 'secrets.yaml');
}

/** The freshest key secrets.yaml holds for this provider, '' when the file or
 * entry is absent (credential-free hosts). Never throws. */
export function freshProviderKey(provider: string, force = false): string {
  try {
    const path = secretsPath();
    const now = Date.now();
    if (force || cache === null || now - cache.checkedAt > CACHE_CHECK_MS) {
      const mtimeMs = statSync(path).mtimeMs;
      if (force || cache === null || cache.mtimeMs !== mtimeMs) {
        const parsed = loadYaml(readFileSync(path, 'utf-8')) as
          | { providers?: Record<string, { apiKey?: unknown } | undefined> }
          | undefined;
        const providers: Record<string, string> = {};
        for (const [name, entry] of Object.entries(parsed?.providers ?? {})) {
          if (typeof entry?.apiKey === 'string' && entry.apiKey !== '') providers[name] = entry.apiKey;
        }
        cache = { mtimeMs, checkedAt: now, providers };
      } else {
        cache.checkedAt = now;
      }
    }
    return cache.providers[provider] ?? '';
  } catch {
    cache = null;
    return '';
  }
}

/**
 * Resolve the credential to USE for a provider right now.
 *   - A configured static key (non-OAuth) is a deliberate pin: respected.
 *   - Otherwise: freshest file value → configured value → env fallback.
 * `force` drops the cache first (the auth-failure path).
 */
export function resolveProviderKey(provider: string, configured?: string, force = false): string {
  if (configured !== undefined && configured !== '' && !configured.startsWith('sk-ant-oat')) {
    return configured;
  }
  // Broker answer first, but ONLY while it is newer than the file it would
  // shadow (see brokeredIfNewer). Present only after a 401 asked for it.
  const broker = brokeredIfNewer(provider);
  if (broker !== '') return broker;
  const fresh = freshProviderKey(provider, force);
  if (fresh !== '') return fresh;
  if (configured !== undefined && configured !== '') return configured;
  for (const name of ENV_FALLBACKS[provider] ?? []) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

/**
 * ── The polled-not-triggered gap (closed 2026-08-13) ────────────────────────
 *
 * `force` above drops the cache and re-reads secrets.yaml. But secrets.yaml is
 * only updated by the dashboard's THIRTY-MINUTE OAuth poller
 * (engine/src/dashboard/server.js), and — per that poller's own comment — the
 * raw-token FETCH is what triggers cosmo23's lazy re-mint. So between a token
 * expiring and the next poll, nobody has even ASKED for a new one, and the
 * force-reread returns the identical dead token. The retry was mechanically
 * correct and semantically a no-op for up to half an hour.
 *
 * Proven cost, from jerry's chain: 401 at 17:11:43Z, next success 17:42:10Z —
 * 31 minutes, exactly one poller cycle, one thought lost. The Seed feels this
 * worse than anything else in the house because its recruitment cadence (30
 * min) is the same order as the poll interval, so one blind window costs it a
 * whole thought; the engine and harness make many calls and recover on the
 * next one.
 *
 * So on auth failure we ask the BROKER, which is the authority and the thing
 * that actually mints. We deliberately do NOT write secrets.yaml: a second
 * writer would race the poller on the file the whole fleet reads. The poller
 * remains the single writer and converges on its own schedule; until it does,
 * whichever of (broker answer, file) is NEWER wins below.
 */
/**
 * ONLY anthropic. cosmo23 brokers the codex token too and the dashboard poller
 * syncs both into secrets.yaml — but generateText's codex branch never reads
 * secrets.yaml: it resolves through codex-auth.ts's own OAuth store, which has
 * its own forced-refresh path. Asking the broker for codex would be a pointless
 * network call inside a failure path, and `text-generation.test.ts` catches it
 * by counting fetches ("exactly one retry, never a loop"). The gap this closes
 * exists only where the credential is READ FROM the polled file.
 */
const BROKERED = new Set(['anthropic']);
let brokered: { provider: string; token: string; fetchedAt: number } | null = null;

/** Ask cosmo23 for the current token, which is what makes it mint a fresh one.
 * Never throws, never logs the value; broker unreachable → false, and the
 * caller's retry proceeds exactly as it did before this existed. */
export async function refreshFromBroker(provider: string, timeoutMs = 5_000): Promise<boolean> {
  if (!BROKERED.has(provider)) return false;
  try {
    const port = process.env['COSMO23_PORT'] ?? '43210';
    const res = await fetch(`http://localhost:${port}/api/oauth/${provider}/raw-token`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const token = (await res.json() as { token?: unknown })?.token;
    if (typeof token !== 'string' || token === '') return false;
    brokered = { provider, token, fetchedAt: Date.now() };
    return true;
  } catch {
    return false;
  }
}

/** The broker's answer, but only while it is NEWER than secrets.yaml — once
 * the poller writes the file, the file is authoritative again and this stops
 * shadowing it. A stale override outliving its file is how a "fix" becomes the
 * next frozen credential. */
function brokeredIfNewer(provider: string): string {
  const b = brokered;
  if (b === null || b.provider !== provider) return '';
  try {
    if (statSync(secretsPath()).mtimeMs >= b.fetchedAt) { brokered = null; return ''; }
  } catch { /* no file — the broker answer is all we have */ }
  return b.token;
}

/** Is this error an authentication failure worth one fresh-credential retry?
 * Matches SDK errors (.status) and raw provider bodies. */
export function isAuthError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status === 401 || status === 403) return true;
  const message = error instanceof Error ? error.message : String(error);
  // Separator classes are symmetric on purpose: providers spell the same
  // failure "invalid_api_key" (OpenAI's machine code), "Invalid API key"
  // (prose), and "invalid-api-key". An asymmetric class silently misses one
  // spelling, and a missed match costs the fresh-credential retry that would
  // have recovered the call. Keep in sync with engine/src/core/provider-credentials.js.
  return /authentication_error|token has been revoked|invalid[ _-]?api[ _-]?key|\b401\b/i.test(message);
}

/** Test seam: drop the cache (also used by the force path implicitly). */
export function _resetCredentialCache(): void {
  cache = null;
  brokered = null;
}
