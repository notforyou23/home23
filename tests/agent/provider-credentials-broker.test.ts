/**
 * Home23 must mint a replacement managed credential during the 401 path,
 * persist it as the house authority, and leave static providers untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import {
  refreshManagedOAuth, resolveProviderKey, _resetCredentialCache,
} from '../../src/agent/provider-credentials.js';

const FILE_TOKEN = 'sk-ant-oat-FILE-value';
const REFRESHED_TOKEN = 'sk-ant-oat-HOME23-value';

function managedSecrets(token = FILE_TOKEN): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'home23-credentials-'));
  mkdirSync(join(root, 'config'));
  const secretsPath = join(root, 'config', 'secrets.yaml');
  writeFileSync(secretsPath, dumpYaml({
    providers: {
      anthropic: {
        apiKey: token,
        oauthManaged: true,
        oauth: {
          refreshToken: 'refresh-old',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    },
  }), { mode: 0o600 });
  return { root, path: secretsPath };
}

async function withManagedSecrets(
  fetchImpl: typeof fetch,
  fn: (state: { root: string; path: string }) => Promise<void>,
): Promise<void> {
  const state = managedSecrets();
  const previousPath = process.env['HOME23_SECRETS_PATH'];
  const previousFetch = globalThis.fetch;
  process.env['HOME23_SECRETS_PATH'] = state.path;
  globalThis.fetch = fetchImpl;
  _resetCredentialCache();
  try {
    await fn(state);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) delete process.env['HOME23_SECRETS_PATH'];
    else process.env['HOME23_SECRETS_PATH'] = previousPath;
    _resetCredentialCache();
    rmSync(state.root, { recursive: true, force: true });
  }
}

function successfulRefresh(): Response {
  return new Response(JSON.stringify({
    access_token: REFRESHED_TOKEN,
    refresh_token: 'refresh-new',
    expires_in: 3600,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a 401 asks Home23 to refresh and the retry reads the persisted token', async () => {
  let requests = 0;
  await withManagedSecrets(async (url, init) => {
    requests += 1;
    assert.equal(String(url), 'https://console.anthropic.com/v1/oauth/token');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      grant_type: 'refresh_token',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      refresh_token: 'refresh-old',
    });
    return successfulRefresh();
  }, async ({ path }) => {
    assert.equal(resolveProviderKey('anthropic'), FILE_TOKEN);
    assert.equal(await refreshManagedOAuth('anthropic'), true);
    assert.equal(resolveProviderKey('anthropic', undefined, true), REFRESHED_TOKEN);
    const stored = loadYaml(readFileSync(path, 'utf8')) as {
      providers: { anthropic: { apiKey: string; oauth: { refreshToken: string } } };
    };
    assert.equal(stored.providers.anthropic.apiKey, REFRESHED_TOKEN);
    assert.equal(stored.providers.anthropic.oauth.refreshToken, 'refresh-new');
    assert.equal(requests, 1);
  });
});

test('a failed Home23 refresh preserves the current file credential', async () => {
  await withManagedSecrets(async () => new Response(
    JSON.stringify({ error: 'invalid_grant' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  ), async () => {
    assert.equal(await refreshManagedOAuth('anthropic'), false);
    assert.equal(resolveProviderKey('anthropic', undefined, true), FILE_TOKEN);
  });
});

test('only harness-managed Anthropic OAuth generates a refresh request here', async () => {
  let requests = 0;
  await withManagedSecrets(async () => { requests += 1; return successfulRefresh(); }, async () => {
    assert.equal(await refreshManagedOAuth('xai'), false);
    assert.equal(await refreshManagedOAuth('ollama-cloud'), false);
    assert.equal(await refreshManagedOAuth('openai-codex'), false, 'codex refreshes in codex-auth.ts');
    assert.equal(requests, 0);
    assert.equal(await refreshManagedOAuth('anthropic'), true);
    assert.equal(requests, 1);
  });
});

test('a pinned static key still outranks managed OAuth', async () => {
  await withManagedSecrets(async () => successfulRefresh(), async () => {
    await refreshManagedOAuth('anthropic');
    assert.equal(
      resolveProviderKey('anthropic', 'sk-static-pinned-key', true),
      'sk-static-pinned-key',
    );
  });
});
