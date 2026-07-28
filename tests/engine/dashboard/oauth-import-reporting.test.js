// Regression guard for the 2026-07-27 Codex outage post-mortem.
//
// The OAuth proxy routes built their response as `{ ok: true, ...sync }`. When
// mirroring the token into secrets.yaml failed, the spread overwrote `ok` with
// the sync result's `ok: false`, so the UI reported "Import failed" for an
// import that had actually succeeded — sending the operator to debug the wrong
// half of the system. Import success and propagation success are separate
// facts and must be reported separately.

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
const {
  createSettingsRouter,
  OAUTH_INTERACTIVE_FLOW_TIMEOUT_MS,
} = require('../../../engine/src/dashboard/home23-settings-api.js');
const { CALLBACK_TIMEOUT_MS } = require('../../../cosmo23/lib/oauth-codex.cjs');

// The dashboard used a flat 15s abort on a route that waits for a human to
// finish a browser sign-in, so it always gave up first — the operator saw a
// bare abort rather than cosmo23's account of what went wrong. The client must
// outlast the server's own callback timeout for that error to survive.
test('the interactive OAuth proxy outlasts cosmo23 own callback timeout', () => {
  assert.ok(
    OAUTH_INTERACTIVE_FLOW_TIMEOUT_MS > CALLBACK_TIMEOUT_MS,
    `dashboard timeout ${OAUTH_INTERACTIVE_FLOW_TIMEOUT_MS}ms must exceed `
    + `cosmo23 callback timeout ${CALLBACK_TIMEOUT_MS}ms`,
  );
  // And it must still be long enough for a real sign-in.
  assert.ok(OAUTH_INTERACTIVE_FLOW_TIMEOUT_MS >= 60_000);
});

// Stub cosmo23: the proxied OAuth call succeeds, but raw-token (the mirror
// step) reports no usable credential — exactly the state a dead refresh token
// produces. syncOAuthTokenToSecrets bails here, before touching pm2 or the
// ecosystem file, so this exercises the reporting bug with no side effects.
async function withStubbedCosmo(fn) {
  const cosmo = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/raw-token')) {
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: 'not configured' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      accountId: 'acct-test',
      expiresAt: '2026-08-02T00:12:59.000Z',
    }));
  });
  await new Promise(resolve => cosmo.listen(0, '127.0.0.1', resolve));
  const previousPort = process.env.COSMO23_PORT;
  process.env.COSMO23_PORT = String(cosmo.address().port);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-oauth-report-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances', 'jerry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), yaml.dump({ providers: {} }), 'utf8');
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), 'providers: {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({}), 'utf8');

  const app = express();
  app.use(express.json());
  app.use('/home23/api/settings', createSettingsRouter(root, {
    seedModelAuthority: async () => {},
    onModelAuthorityChanged: async () => ({ scheduled: [] }),
    recycleManagedProcess: () => false,
  }).router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    await fn({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    if (previousPort === undefined) delete process.env.COSMO23_PORT;
    else process.env.COSMO23_PORT = previousPort;
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => cosmo.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const OAUTH_ROUTES = [
  '/oauth/openai-codex/import-evobrew',
  '/oauth/openai-codex/start',
  '/oauth/anthropic/import-cli',
];

for (const route of OAUTH_ROUTES) {
  test(`${route} reports a failed secrets mirror without denying the import succeeded`, async () => {
    await withStubbedCosmo(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/home23/api/settings${route}`, { method: 'POST' });
      const body = await response.json();

      // The proxied OAuth call succeeded, so the operation itself did not fail.
      assert.equal(body.ok, true, `expected ok:true, got ${JSON.stringify(body)}`);
      // ...but the propagation failure must be visible, not swallowed.
      assert.equal(body.sync.ok, false);
      assert.match(body.sync.error, /not configured/);
    });
  });
}

test('anthropic callback keeps import and mirror outcomes separate too', async () => {
  await withStubbedCosmo(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/home23/api/settings/oauth/anthropic/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callbackUrl: 'https://example.test/cb?code=x&state=y' }),
    });
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.sync.ok, false);
    assert.match(body.sync.error, /not configured/);
  });
});
