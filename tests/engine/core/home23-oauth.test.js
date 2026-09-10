import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const {
  createHome23OAuthBroker,
  parseCallback,
} = require('../../../shared/home23-oauth.cjs');

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function readSecrets(root) {
  return yaml.load(fs.readFileSync(path.join(root, 'config', 'secrets.yaml'), 'utf8'));
}

async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-oauth-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('OpenAI flow persists PKCE privately and writes refreshable Home23 credentials', async () => {
  await withRoot(async (root) => {
    let request;
    const accessToken = jwt({
      exp: 2_000_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-home23' },
    });
    const broker = createHome23OAuthBroker({
      home23Root: root,
      now: () => 1_900_000_000_000,
      fetchImpl: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh-home23',
          expires_in: 3600,
        }), { status: 200 });
      },
    });

    const started = await broker.begin('openai-codex');
    const authUrl = new URL(started.authUrl);
    const pending = readSecrets(root).providers['openai-codex'].oauthPending;
    assert.equal(authUrl.searchParams.get('state'), pending.state);
    assert.equal(authUrl.searchParams.get('originator'), 'home23');
    assert.equal(authUrl.searchParams.has('code_verifier'), false);
    assert.equal(started.authUrl.includes(pending.verifier), false);

    const result = await broker.complete(
      'openai-codex',
      `http://localhost:1455/auth/callback?code=authorization-code&state=${pending.state}`,
    );
    assert.equal(result.configured, true);
    assert.equal(result.accountId, 'acct-home23');
    assert.equal(request.url, 'https://auth.openai.com/oauth/token');
    assert.equal(request.init.body.get('code_verifier'), pending.verifier);
    assert.equal(request.init.body.get('code'), 'authorization-code');

    const stored = readSecrets(root).providers['openai-codex'];
    assert.equal(stored.apiKey, accessToken);
    assert.equal(stored.oauthManaged, true);
    assert.equal(stored.oauth.refreshToken, 'refresh-home23');
    assert.equal(stored.oauth.accountId, 'acct-home23');
    assert.equal(stored.oauthPending, undefined);
    assert.equal(fs.statSync(path.join(root, 'config', 'secrets.yaml')).mode & 0o777, 0o600);
  });
});

test('callback state is checked before a provider request', async () => {
  await withRoot(async (root) => {
    let requests = 0;
    const broker = createHome23OAuthBroker({
      home23Root: root,
      fetchImpl: async () => { requests += 1; throw new Error('must not run'); },
    });
    await broker.begin('anthropic');
    await assert.rejects(
      () => broker.complete('anthropic', 'https://console.anthropic.com/oauth/code/callback?code=x#wrong-state'),
      (error) => error.code === 'oauth_state_mismatch',
    );
    assert.equal(requests, 0);
  });
});

test('Anthropic callback parser supports fragment state and compact code#state input', () => {
  assert.deepEqual(
    parseCallback('anthropic', 'https://console.anthropic.com/oauth/code/callback?code=hello#state-value'),
    { code: 'hello', state: 'state-value' },
  );
  assert.deepEqual(parseCallback('anthropic', 'hello#state-value'), { code: 'hello', state: 'state-value' });
});

test('near-expiry credentials refresh in place and preserve a non-rotated refresh token', async () => {
  await withRoot(async (root) => {
    let currentTime = 1_900_000_000_000;
    let requests = 0;
    const oldAccess = jwt({ exp: Math.floor((currentTime + 60_000) / 1000), sub: 'acct-old' });
    const newAccess = jwt({ exp: Math.floor((currentTime + 3_600_000) / 1000), sub: 'acct-new' });
    fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), yaml.dump({
      providers: {
        'openai-codex': {
          apiKey: oldAccess,
          oauthManaged: true,
          oauth: {
            refreshToken: 'refresh-stays',
            expiresAt: new Date(currentTime + 60_000).toISOString(),
            accountId: 'acct-old',
          },
        },
      },
    }), { mode: 0o600 });
    const broker = createHome23OAuthBroker({
      home23Root: root,
      now: () => currentTime,
      fetchImpl: async (_url, init) => {
        requests += 1;
        assert.equal(init.body.get('grant_type'), 'refresh_token');
        assert.equal(init.body.get('refresh_token'), 'refresh-stays');
        return new Response(JSON.stringify({ access_token: newAccess, expires_in: 3600 }), { status: 200 });
      },
    });

    const credentials = await broker.credentials('openai-codex');
    assert.equal(requests, 1);
    assert.equal(credentials.accessToken, newAccess);
    assert.equal(credentials.refreshToken, 'refresh-stays');
    assert.equal(credentials.accountId, 'acct-new');
    assert.equal(readSecrets(root).providers['openai-codex'].oauth.refreshToken, 'refresh-stays');
  });
});

test('a force refresh yields to credentials already rotated by another caller', async () => {
  await withRoot(async (root) => {
    const oldAccess = jwt({ exp: 2_000_000_000, sub: 'old' });
    const newAccess = jwt({ exp: 2_000_000_000, sub: 'new' });
    fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), yaml.dump({
      providers: {
        'openai-codex': {
          apiKey: newAccess,
          oauthManaged: true,
          oauth: { refreshToken: 'refresh-new', expiresAt: '2033-01-01T00:00:00.000Z', accountId: 'new' },
        },
      },
    }), { mode: 0o600 });
    let requests = 0;
    const broker = createHome23OAuthBroker({
      home23Root: root,
      fetchImpl: async () => { requests += 1; throw new Error('must not refresh'); },
    });
    const credentials = await broker.credentials('openai-codex', {
      force: true,
      staleAccessToken: oldAccess,
    });
    assert.equal(credentials.accessToken, newAccess);
    assert.equal(requests, 0);
  });
});

test('CLI import is a one-time copy into Home23 and logout removes only managed OAuth data', async () => {
  await withRoot(async (root) => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-user-'));
    try {
      fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
      const accessToken = jwt({ exp: 2_000_000_000, sub: 'acct-imported' });
      fs.writeFileSync(path.join(userHome, '.codex', 'auth.json'), JSON.stringify({
        tokens: { access_token: accessToken, refresh_token: 'import-refresh', account_id: 'acct-imported' },
      }));
      const broker = createHome23OAuthBroker({ home23Root: root, userHome, fetchImpl: async () => new Response() });
      const imported = await broker.importCli('openai-codex');
      assert.equal(imported.configured, true);
      fs.rmSync(path.join(userHome, '.codex', 'auth.json'));
      assert.equal((await broker.credentials('openai-codex')).accessToken, accessToken);

      await broker.clear('openai-codex');
      assert.equal((await broker.status('openai-codex')).configured, false);
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });
});
