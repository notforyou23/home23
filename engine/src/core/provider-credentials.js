/**
 * Provider credential resolution — read-at-use, from the single source of
 * truth. The engine-side port of src/agent/provider-credentials.ts (the
 * harness fix that killed the token-rotation class, 2026-08-10). The two
 * modules must stay in sync semantically.
 *
 * The underlying disease every incident shared (Jul 27 codex lapse, Aug 8–9
 * fleet codex-death, Aug 9 the broker's 16h-old token, Aug 10 the seeds'
 * revoked Anthropic token): credentials were distributed BY VALUE — copied
 * into process env or boot-time config and frozen there. The engine was the
 * last large consumer left on frozen env, protected only by the dashboard's
 * 30-minute rotation poller restarting it.
 *
 * The cure: consumers resolve the credential AT USE TIME from
 * config/secrets.yaml (the file the OAuth mirror keeps fresh), with an
 * mtime-checked cache and a force-reread path for auth failures. Rotation
 * becomes a file write. No restart lists. No frozen env.
 *
 * The one deliberate exception: a configured key that is NOT a managed OAuth
 * token is treated as a deliberately pinned static API key and respected as
 * configured — the rotating-managed class is exactly the OAuth tokens
 * (Anthropic sk-ant-oat*, and for the engine also OpenAI Codex OAuth JWTs);
 * static keys don't rotate under anyone.
 */

'use strict';

const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

/** Env fallbacks per provider — the pre-existing engine behavior, kept as the
 * floor so credential-free hosts and tests keep working unchanged. Superset of
 * the harness map: the engine also serves groq, huggingface, and openai-codex
 * from env. */
const ENV_FALLBACKS = {
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_TOKEN'],
  'openai-codex': ['OPENAI_CODEX_AUTH_TOKEN', 'OPENAI_OAUTH_TOKEN'],
};

const CACHE_CHECK_MS = 15_000;

let cache = null; // { mtimeMs, checkedAt, providers: { name -> apiKey } }

function secretsPath() {
  const override = process.env.HOME23_SECRETS_PATH;
  if (override !== undefined && override !== '') return override;
  // Resolves from this module's location: engine/src/core sits three levels
  // under the repo root — cwd-independent (the cwd trap has bitten this house
  // before).
  return path.resolve(__dirname, '..', '..', '..', 'config', 'secrets.yaml');
}

/** Managed OAuth tokens are the rotating class: Anthropic sk-ant-oat* and
 * OpenAI Codex OAuth JWTs (three base64url segments starting eyJ). */
function isManagedOAuthToken(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('sk-ant-oat')) return true;
  return value.startsWith('eyJ') && value.split('.').length === 3;
}

/** The freshest key secrets.yaml holds for this provider, '' when the file or
 * entry is absent (credential-free hosts). Never throws. */
function freshProviderKey(provider, force = false) {
  try {
    const filePath = secretsPath();
    const now = Date.now();
    if (force || cache === null || now - cache.checkedAt > CACHE_CHECK_MS) {
      const mtimeMs = statSync(filePath).mtimeMs;
      if (force || cache === null || cache.mtimeMs !== mtimeMs) {
        const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
        const providers = {};
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
function resolveProviderKey(provider, configured, force = false) {
  if (configured !== undefined && configured !== '' && !isManagedOAuthToken(configured)) {
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
function isAuthError(error) {
  const status = error?.status;
  if (status === 401 || status === 403) return true;
  const message = error instanceof Error ? error.message : String(error);
  // Separator classes are symmetric on purpose: providers spell the same
  // failure "invalid_api_key" (OpenAI's machine code), "Invalid API key"
  // (prose), and "invalid-api-key". An asymmetric class silently misses one
  // spelling, and a missed match costs the fresh-credential retry that would
  // have recovered the call. Keep in sync with src/agent/provider-credentials.ts.
  return /authentication_error|token has been revoked|invalid[ _-]?api[ _-]?key|\b401\b/i.test(message);
}

/** Test seam: drop the cache (also used by the force path implicitly). */
function _resetCredentialCache() {
  cache = null;
}

module.exports = {
  freshProviderKey,
  resolveProviderKey,
  isAuthError,
  isManagedOAuthToken,
  _resetCredentialCache,
};
