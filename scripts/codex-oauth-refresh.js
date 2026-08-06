#!/usr/bin/env node
/**
 * Codex OAuth refresh — mirrors engine/src/agent/codex-auth.js refreshCredentials().
 * Used by cron + by diagnostic dispatcher. Writes atomically to ~/.evobrew/auth-profiles.json.
 * Also mirrors the latest token into ~/.codex/auth.json (last_writer_wins — Home23's
 * copy is canonical for shared-account lineage).
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const AUTH_PATH = join(homedir(), '.evobrew', 'auth-profiles.json');
const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function loadProfile() {
  if (!existsSync(AUTH_PATH)) throw new Error(`missing: ${AUTH_PATH}`);
  const data = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  const p = data?.profiles?.['openai-codex:default'];
  if (!p?.accessToken || !p?.refreshToken || !p?.accountId) {
    throw new Error('profile missing required fields');
  }
  return p;
}

function saveProfile(p) {
  const data = existsSync(AUTH_PATH)
    ? JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
    : { version: 1, profiles: {} };
  data.profiles = data.profiles || {};
  data.profiles['openai-codex:default'] = p;
  const out = JSON.stringify(data, null, 2);
  const tmp = join(tmpdir(), `auth-profiles-${Date.now()}.json`);
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, AUTH_PATH);
}

function mirrorCodex(p, accessToken) {
  // Mirror to ~/.codex/auth.json so Home23 is the lineage winner going forward.
  if (!existsSync(CODEX_AUTH_PATH)) return false;
  try {
    const data = JSON.parse(readFileSync(CODEX_AUTH_PATH, 'utf8'));
    data.tokens = data.tokens || {};
    data.tokens.access_token = accessToken;
    if (p.refreshToken) data.tokens.refresh_token = p.refreshToken;
    if (p.accountId) data.tokens.account_id = p.accountId;
    data.last_refresh = new Date().toISOString();
    const tmp = join(tmpdir(), `codex-auth-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, CODEX_AUTH_PATH);
    return true;
  } catch (err) {
    console.error('[codex-oauth-refresh] mirror to ~/.codex/auth.json failed:', err.message);
    return false;
  }
}

async function refresh() {
  const profile = loadProfile();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: profile.refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const updated = {
    type: 'oauth',
    provider: 'openai-codex',
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? profile.refreshToken,
    expires: Date.now() + data.expires_in * 1000,
    accountId: profile.accountId,
  };
  saveProfile(updated);
  const mirrored = mirrorCodex(updated, data.access_token);
  return {
    ok: true,
    expiresInHours: (data.expires_in / 3600).toFixed(1),
    expiresAt: new Date(updated.expires).toISOString(),
    rotatedRefreshToken: !!data.refresh_token,
    mirrored,
  };
}

refresh()
  .then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });