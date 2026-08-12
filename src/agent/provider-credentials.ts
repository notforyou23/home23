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
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

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
  // Resolves from this module's location: src/agent/ and dist/agent/ both sit
  // two levels under the repo root — cwd-independent (the cwd trap has bitten
  // this house before).
  return resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'secrets.yaml');
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
  const fresh = freshProviderKey(provider, force);
  if (fresh !== '') return fresh;
  if (configured !== undefined && configured !== '') return configured;
  for (const name of ENV_FALLBACKS[provider] ?? []) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
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
}
