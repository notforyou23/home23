/**
 * OpenAI Codex OAuth — Credential Management
 *
 * Reads ChatGPT OAuth credentials from ~/.evobrew/auth-profiles.json.
 * Auto-refreshes when < 5 min from expiry.
 * Mirrors the Anthropic OAuth pattern in loop.ts.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const AUTH_PATH = join(homedir(), '.evobrew', 'auth-profiles.json');
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh if < 5 min remaining

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  expires: number;    // ms since epoch
  accountId: string;  // value for chatgpt-account-id header
}

/**
 * Load credentials from ~/.evobrew/auth-profiles.json.
 * Returns null if file or profile is missing.
 */
function loadCredentials(): CodexCredentials | null {
  try {
    if (!existsSync(AUTH_PATH)) return null;
    const raw = readFileSync(AUTH_PATH, 'utf-8');
    const data = JSON.parse(raw) as { profiles?: Record<string, unknown> };
    const profile = data?.profiles?.['openai-codex:default'] as CodexCredentials | undefined;
    if (!profile?.accessToken || !profile?.refreshToken || !profile?.accountId || typeof profile?.expires !== 'number') return null;
    return profile;
  } catch {
    return null;
  }
}

/**
 * Save credentials back to ~/.evobrew/auth-profiles.json via atomic write.
 * Reads the full file first to preserve other profiles.
 */
function saveCredentials(creds: CodexCredentials): void {
  let profiles: Record<string, unknown> = {};
  try {
    if (existsSync(AUTH_PATH)) {
      const raw = readFileSync(AUTH_PATH, 'utf-8');
      const data = JSON.parse(raw) as { profiles?: Record<string, unknown> };
      profiles = data?.profiles ?? {};
    }
  } catch { /* start fresh */ }

  profiles['openai-codex:default'] = creds;
  const output = JSON.stringify({ version: 1, profiles }, null, 2);

  // Atomic write: write to temp, rename over target
  const tmp = join(tmpdir(), `auth-profiles-${Date.now()}.json`);
  writeFileSync(tmp, output, 'utf-8');
  renameSync(tmp, AUTH_PATH);
}

/**
 * Refresh an expired/near-expiry access token.
 * Returns updated credentials or null on failure.
 */
async function refreshCredentials(creds: CodexCredentials): Promise<CodexCredentials | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[codex-auth] Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const refreshed: CodexCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expires: Date.now() + data.expires_in * 1000,
      accountId: creds.accountId,
    };

    saveCredentials(refreshed);
    console.log('[codex-auth] Token refreshed successfully');
    return refreshed;
  } catch (err) {
    console.error('[codex-auth] Refresh error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Get valid Codex credentials, refreshing if near-expiry.
 * Returns null if not configured or refresh fails.
 */
export async function getCodexCredentials(): Promise<CodexCredentials | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  if (creds.expires - Date.now() < REFRESH_THRESHOLD_MS) {
    console.log('[codex-auth] Token near-expiry — refreshing');
    return refreshCredentials(creds);
  }

  return creds;
}

/**
 * Build request headers for the Codex API endpoint.
 */
export function getCodexHeaders(creds: CodexCredentials): Record<string, string> {
  return {
    'Authorization': `Bearer ${creds.accessToken}`,
    'chatgpt-account-id': creds.accountId,
    'OpenAI-Beta': 'responses=experimental',
    'originator': 'cosmo-home',
    'accept': 'text/event-stream',
    'content-type': 'application/json',
  };
}
