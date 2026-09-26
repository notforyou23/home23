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

function writeManaged(root, provider, { accessToken, refreshToken = 'refresh-fixture', expiresAt = '2033-01-01T00:00:00.000Z', accountId } = {}) {
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), yaml.dump({
    providers: {
      [provider]: {
        apiKey: accessToken,
        oauthManaged: true,
        oauth: { refreshToken, expiresAt, ...(accountId ? { accountId } : {}) },
      },
    },
  }), { mode: 0o600 });
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

test('verify probes Anthropic with its CLI identity and reports a revoked grant without rotating anything', async () => {
  await withRoot(async (root) => {
    const accessToken = jwt({ exp: 2_000_000_000, sub: 'acct-anthropic' });
    writeManaged(root, 'anthropic', { accessToken });
    const requests = [];
    let reply = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const broker = createHome23OAuthBroker({
      home23Root: root,
      fetchImpl: async (url, init) => { requests.push({ url, init }); return reply(); },
    });

    const verified = await broker.verify('anthropic');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/models?limit=1');
    assert.equal(requests[0].init.method, 'GET');
    assert.ok(requests[0].init.headers.authorization.startsWith('Bearer '));
    assert.equal(requests[0].init.headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(requests[0].init.headers['user-agent'], 'claude-cli/2.1.32 (external, cli)');
    assert.equal(requests[0].init.headers['x-app'], 'cli');
    assert.equal(requests[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(requests[0].init.headers.accept, 'application/json');
    assert.equal(requests[0].init.headers['chatgpt-account-id'], undefined);
    assert.ok(requests[0].init.signal instanceof AbortSignal);
    assert.deepEqual(
      [verified.configured, verified.valid, verified.verified, verified.revoked, verified.verificationError],
      [true, true, true, false, null],
    );
    assert.equal(JSON.stringify(verified).includes(accessToken), false);

    reply = () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'OAuth access token has been revoked' },
    }), { status: 401 });
    const revoked = await broker.verify('anthropic');
    assert.deepEqual(
      [revoked.configured, revoked.valid, revoked.verified, revoked.revoked, revoked.refreshable, revoked.verificationError],
      [true, false, true, true, true, null],
    );
    assert.equal(JSON.stringify(revoked).includes('has been revoked'), false);
    assert.equal(readSecrets(root).providers.anthropic.apiKey, accessToken);
    assert.equal(readSecrets(root).providers.anthropic.oauth.refreshToken, 'refresh-fixture');
    // status() stays the non-network, expiry-only view that create and the dashboard rely on.
    assert.equal((await broker.status('anthropic')).valid, true);
    assert.equal(requests.length, 2);
  });
});

test('verify probes OpenAI with the account header and keeps provider trouble apart from revocation', async () => {
  await withRoot(async (root) => {
    const accessToken = jwt({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-codex' } });
    writeManaged(root, 'openai-codex', { accessToken, accountId: 'acct-codex' });
    const requests = [];
    let reply = () => new Response(JSON.stringify({ models: [] }), { status: 200 });
    const broker = createHome23OAuthBroker({
      home23Root: root,
      fetchImpl: async (url, init) => {
        init.signal.throwIfAborted();
        requests.push({ url, init });
        return reply();
      },
    });

    const verified = await broker.verify('openai-codex');
    assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.50.0');
    assert.ok(requests[0].init.headers.authorization.startsWith('Bearer '));
    assert.equal(requests[0].init.headers['chatgpt-account-id'], 'acct-codex');
    assert.equal(requests[0].init.headers.accept, 'application/json');
    assert.equal(requests[0].init.headers['anthropic-version'], undefined);
    assert.deepEqual([verified.verified, verified.valid, verified.revoked, verified.accountId], [true, true, false, 'acct-codex']);

    reply = () => new Response(JSON.stringify({ detail: { type: 'authentication_error' } }), { status: 403 });
    const revoked = await broker.verify('openai-codex');
    assert.deepEqual([revoked.verified, revoked.valid, revoked.revoked], [true, false, true]);

    reply = () => new Response('forbidden', { status: 403 });
    const policy = await broker.verify('openai-codex');
    assert.deepEqual([policy.verified, policy.valid, policy.revoked, policy.verificationError], [false, true, false, 'provider_error:403']);

    reply = () => new Response('', { status: 503 });
    assert.equal((await broker.verify('openai-codex')).verificationError, 'provider_error:503');

    reply = () => { throw new TypeError('fetch failed'); };
    const down = await broker.verify('openai-codex');
    assert.deepEqual([down.verified, down.valid, down.revoked, down.verificationError], [false, true, false, 'unreachable']);

    reply = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    assert.equal((await broker.verify('openai-codex')).verificationError, 'timeout');

    await assert.rejects(
      () => broker.verify('openai-codex', { signal: AbortSignal.abort() }),
      (error) => error.name === 'AbortError',
    );
    assert.equal(readSecrets(root).providers['openai-codex'].apiKey, accessToken);
    assert.equal(readSecrets(root).providers['openai-codex'].oauth.refreshToken, 'refresh-fixture');
  });
});

test('verify never probes a missing or expired credential', async () => {
  await withRoot(async (root) => {
    let requests = 0;
    const broker = createHome23OAuthBroker({
      home23Root: root,
      fetchImpl: async () => { requests += 1; throw new Error('must not probe'); },
    });
    assert.deepEqual(await broker.verify('anthropic'), await broker.status('anthropic'));

    const accessToken = jwt({ exp: 1_000_000_000, sub: 'acct-stale' });
    writeManaged(root, 'anthropic', { accessToken, expiresAt: '2001-01-01T00:00:00.000Z' });
    const expired = await broker.verify('anthropic');
    assert.deepEqual(expired, {
      ...(await broker.status('anthropic')),
      verified: false,
      revoked: false,
      verificationError: 'expired',
    });
    assert.equal(expired.valid, false);
    assert.equal(expired.refreshable, true);
    assert.equal(requests, 0);
  });
});
