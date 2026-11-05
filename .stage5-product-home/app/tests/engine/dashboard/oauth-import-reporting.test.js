import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const express = require('express');
const { createSettingsRouter } = require('../../../engine/src/dashboard/home23-settings-api.js');

async function withSettings(oauthBroker, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-oauth-routes-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances', 'jerry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), yaml.dump({ providers: {} }), 'utf8');
  fs.writeFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({}), 'utf8');

  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root, {
    oauthBroker,
    seedModelAuthority: async () => {},
    onModelAuthorityChanged: async () => ({ scheduled: [] }),
    recycleManagedProcess: () => false,
  }).router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/home23/api/settings`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fakeBroker(overrides = {}) {
  const calls = [];
  const status = async (provider) => ({
    configured: provider === 'openai-codex',
    valid: provider === 'openai-codex',
    refreshable: provider === 'openai-codex',
    source: provider === 'openai-codex' ? 'home23' : 'none',
    expiresAt: provider === 'openai-codex' ? '2030-01-01T00:00:00.000Z' : null,
    accountId: provider === 'openai-codex' ? 'acct-test' : null,
  });
  return {
    calls,
    status,
    begin: async (provider) => {
      calls.push(['begin', provider]);
      return { authUrl: `https://auth.example/${provider}`, expiresInSeconds: 600 };
    },
    complete: async (provider, callbackUrl) => {
      calls.push(['complete', provider, callbackUrl]);
      return { ...(await status(provider)), configured: true, valid: true, source: 'home23' };
    },
    importCli: async (provider) => {
      calls.push(['importCli', provider]);
      return { ...(await status(provider)), configured: true, valid: true, source: 'home23' };
    },
    clear: async (provider) => { calls.push(['clear', provider]); return { cleared: true }; },
    ...overrides,
  };
}

test('settings reports Home23-owned OAuth state for both providers', async () => {
  const broker = fakeBroker();
  await withSettings(broker, async (api) => {
    const response = await fetch(`${api}/oauth/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      anthropic: {
        configured: false,
        valid: false,
        refreshable: false,
        source: 'none',
        expiresAt: null,
        accountId: null,
      },
      openaiCodex: {
        configured: true,
        valid: true,
        refreshable: true,
        source: 'home23',
        expiresAt: '2030-01-01T00:00:00.000Z',
        accountId: 'acct-test',
      },
    });
  });
});

for (const provider of ['anthropic', 'openai-codex']) {
  test(`${provider} setup routes start and complete a non-blocking Home23 PKCE flow`, async () => {
    const broker = fakeBroker();
    await withSettings(broker, async (api) => {
      const start = await fetch(`${api}/oauth/${provider}/start`, { method: 'POST' });
      assert.equal(start.status, 200);
      assert.deepEqual(await start.json(), {
        ok: true,
        authUrl: `https://auth.example/${provider}`,
        expiresInSeconds: 600,
      });

      const callbackUrl = `https://callback.example/?code=${provider}&state=state`;
      const complete = await fetch(`${api}/oauth/${provider}/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackUrl }),
      });
      assert.equal(complete.status, 200);
      assert.equal((await complete.json()).source, 'home23');
      assert.deepEqual(broker.calls, [
        ['begin', provider],
        ['complete', provider, callbackUrl],
      ]);
    });
  });
}

test('official CLI import and logout delegate to the Home23 authority', async () => {
  const broker = fakeBroker();
  await withSettings(broker, async (api) => {
    for (const provider of ['anthropic', 'openai-codex']) {
      const imported = await fetch(`${api}/oauth/${provider}/import-cli`, { method: 'POST' });
      assert.equal(imported.status, 200);
      assert.equal((await imported.json()).configured, true);
      const loggedOut = await fetch(`${api}/oauth/${provider}/logout`, { method: 'POST' });
      assert.equal(loggedOut.status, 200);
    }
    assert.deepEqual(broker.calls, [
      ['importCli', 'anthropic'],
      ['clear', 'anthropic'],
      ['importCli', 'openai-codex'],
      ['clear', 'openai-codex'],
    ]);
  });
});

test('OAuth errors retain their safe code and HTTP status', async () => {
  const failure = Object.assign(new Error('Start a new OAuth flow'), {
    code: 'oauth_flow_missing',
    statusCode: 400,
  });
  const broker = fakeBroker({ complete: async () => { throw failure; } });
  await withSettings(broker, async (api) => {
    const response = await fetch(`${api}/oauth/anthropic/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callbackUrl: 'x' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'Start a new OAuth flow',
      code: 'oauth_flow_missing',
    });
  });
});
