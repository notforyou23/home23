import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
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
  const reads = [];
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
    reads,
    status: async (provider) => { reads.push(['status', provider]); return status(provider); },
    // Like the real broker: no credential, no probe; a live one is confirmed by the provider.
    verify: async (provider) => {
      reads.push(['verify', provider]);
      const current = await status(provider);
      return current.configured ? { ...current, verified: true, revoked: false, verificationError: null } : current;
    },
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

test('settings reports Home23-owned OAuth state for both providers, confirmed by the provider', async () => {
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
        verified: false,
        revoked: false,
        verificationError: null,
      },
      openaiCodex: {
        configured: true,
        valid: true,
        refreshable: true,
        source: 'home23',
        expiresAt: '2030-01-01T00:00:00.000Z',
        accountId: 'acct-test',
        verified: true,
        revoked: false,
        verificationError: null,
      },
    });
    assert.deepEqual(broker.reads, [['verify', 'anthropic'], ['verify', 'openai-codex']]);
  });
});

test('settings reports a grant the provider revoked instead of trusting expiry, and ?verify=0 reads expiry only', async () => {
  const revoked = {
    configured: true, valid: false, refreshable: true, source: 'home23',
    expiresAt: '2030-01-01T00:00:00.000Z', accountId: null, verified: true, revoked: true, verificationError: null,
  };
  const broker = fakeBroker();
  const verify = broker.verify;
  broker.verify = async (provider) => {
    if (provider !== 'anthropic') return verify(provider);
    broker.reads.push(['verify', provider]);
    return revoked;
  };
  await withSettings(broker, async (api) => {
    const verified = await (await fetch(`${api}/oauth/status`)).json();
    assert.deepEqual(verified.anthropic, revoked);
    assert.equal(verified.openaiCodex.verified, true);

    broker.reads.length = 0;
    for (const query of ['?verify=0', '?verify=false']) {
      const polled = await (await fetch(`${api}/oauth/status${query}`)).json();
      assert.equal(polled.openaiCodex.valid, true);
      assert.equal(polled.openaiCodex.verified, false);
      assert.equal(polled.anthropic.revoked, false);
    }
    assert.deepEqual(broker.reads, [
      ['status', 'anthropic'], ['status', 'openai-codex'],
      ['status', 'anthropic'], ['status', 'openai-codex'],
    ], 'a poll never probes the provider');
  });
});

test('sign-in payloads carry the shared public shape', async () => {
  const broker = fakeBroker();
  await withSettings(broker, async (api) => {
    const imported = await (await fetch(`${api}/oauth/anthropic/import-cli`, { method: 'POST' })).json();
    const completed = await (await fetch(`${api}/oauth/openai-codex/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callbackUrl: 'https://callback.example/?code=x&state=y' }),
    })).json();
    for (const payload of [imported, completed]) {
      assert.equal(payload.ok, true);
      assert.deepEqual([payload.configured, payload.verified, payload.revoked, payload.verificationError], [true, false, false, null]);
    }
  });
});

test('settings OAuth cards name a revoked grant and an unconfirmed one, and the poll keeps a known revocation', () => {
  const source = fs.readFileSync(path.resolve('engine/src/dashboard/home23-settings.js'), 'utf8');
  const slice = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `${start} is present`);
    return source.slice(from, to);
  };
  const elements = {
    'anthropic-oauth-status': { style: {}, innerHTML: '' },
    'btn-anthropic-oauth-logout': { hidden: true },
  };
  const ui = runInNewContext(
    `${slice('const verifiedOAuthStatus', 'async function loadOAuthStatus')}
     ${slice('function renderOAuthCard(kind, status)', 'function showOAuthMessage')}
     ({ renderOAuthCard, withKnownRevocation, verifiedOAuthStatus })`,
    { document: { getElementById: id => elements[id] } },
  );
  const card = elements['anthropic-oauth-status'];
  const live = { configured: true, valid: true, refreshable: true, expiresAt: '2030-01-01T00:00:00.000Z', accountId: null };

  ui.renderOAuthCard('anthropic', { ...live, valid: false, verified: true, revoked: true });
  assert.match(card.innerHTML, /Provider revoked this sign-in — sign in again/);
  assert.equal(elements['btn-anthropic-oauth-logout'].hidden, false);

  for (const verificationError of ['unreachable', 'timeout', 'provider_error:503']) {
    ui.renderOAuthCard('anthropic', { ...live, verified: false, verificationError });
    assert.match(card.innerHTML, /✓ Connected · expires .* · couldn’t confirm with provider/);
  }
  ui.renderOAuthCard('anthropic', { ...live, verified: true, verificationError: null });
  assert.match(card.innerHTML, /✓ Connected · expires/);
  assert.doesNotMatch(card.innerHTML, /couldn’t confirm/);
  ui.renderOAuthCard('anthropic', { ...live, valid: false, verificationError: 'expired' });
  assert.match(card.innerHTML, /Token expired/);

  // The 3 s onboarding poll reads expiry only; it must not repaint a revoked grant as connected.
  ui.verifiedOAuthStatus.anthropic = { ...live, valid: false, verified: true, revoked: true };
  assert.equal(ui.withKnownRevocation('anthropic', live).revoked, true);
  assert.equal(ui.withKnownRevocation('anthropic', { ...live, expiresAt: '2031-01-01T00:00:00.000Z' }).revoked, undefined,
    'a new sign-in replaces the known revocation');
  assert.match(slice('async function checkOnboardingProviderGate', 'async function obTestProvider'), /\/oauth\/status\?verify=0/);
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
