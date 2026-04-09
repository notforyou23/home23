#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { loadSecurityProfile, isOnlyOfficeCallbackUrlAllowed } = require('../lib/security-profile');

const STARTUP_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 8000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { response } = await fetchJson(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // ignore until timeout
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

function startInternetProfileServer() {
  const basePort = 37000 + Math.floor(Math.random() * 2000);
  const env = {
    ...process.env,
    PORT: String(basePort),
    HTTPS_PORT: String(basePort + 1),
    SECURITY_PROFILE: 'internet',
    EVOBREW_PROXY_SHARED_SECRET: 'smoke-proxy-secret',
    WORKSPACE_ROOT: process.cwd(),
    COLLABORA_SECRET: 'smoke-collabora-secret',
    ONLYOFFICE_CALLBACK_ALLOWLIST: 'https://docs.example.com',
    INTERNET_ENABLE_MUTATIONS: 'false',
    INTERNET_ENABLE_GATEWAY_PROXY: 'false'
  };

  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    baseUrl: `http://127.0.0.1:${basePort}`,
    stderr: () => stderr
  };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');

  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000)
  ]);

  if (!child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

async function runConfigChecks() {
  const local = loadSecurityProfile({ SECURITY_PROFILE: 'local' });
  assert.equal(local.securityProfile, 'local');
  assert.equal(local.internetEnableMutations, false);
  assert.equal(local.internetEnableGatewayProxy, false);

  const workspaceRoot = process.cwd();
  const internet = loadSecurityProfile({
    SECURITY_PROFILE: 'internet',
    EVOBREW_PROXY_SHARED_SECRET: 'test-shared-secret',
    WORKSPACE_ROOT: workspaceRoot,
    COLLABORA_SECRET: 'test-collabora-secret',
    ONLYOFFICE_CALLBACK_ALLOWLIST: 'https://docs.example.com,office.internal:443'
  });

  assert.equal(internet.isInternetProfile, true);
  assert.equal(path.resolve(internet.workspaceRoot), path.resolve(workspaceRoot));
  assert.equal(
    isOnlyOfficeCallbackUrlAllowed('https://docs.example.com/save', internet.onlyOfficeAllowlist),
    true
  );
  assert.equal(
    isOnlyOfficeCallbackUrlAllowed('https://evil.example.com/save', internet.onlyOfficeAllowlist),
    false
  );
}

async function runInternetBoundaryChecks() {
  const server = startInternetProfileServer();
  const authHeaders = {
    'x-evobrew-proxy-secret': 'smoke-proxy-secret',
    'x-evobrew-auth-user': 'security-smoke-user'
  };

  try {
    await waitForHealth(server.baseUrl);

    const unauthChat = await fetchJson(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'smoke', model: 'gpt-5.2' })
    });
    assert.equal(unauthChat.response.status, 401, 'unauthenticated /api/chat should return 401');

    const blockedMutation = await fetchJson(`${server.baseUrl}/api/folder/create`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${process.cwd()}/smoke-test-should-not-create` })
    });
    assert.equal(blockedMutation.response.status, 403, 'mutation route should be blocked in internet profile');

    const blockedGateway = await fetchJson(`${server.baseUrl}/api/gateway-auth`, {
      headers: authHeaders
    });
    assert.equal(blockedGateway.response.status, 403, 'gateway auth route should be disabled in internet profile by default');

    const unauthOauthStart = await fetchJson(`${server.baseUrl}/api/oauth/anthropic/start`);
    assert.equal(unauthOauthStart.response.status, 401, 'unauthenticated OAuth start should return 401');

    const authOauthStart = await fetchJson(`${server.baseUrl}/api/oauth/anthropic/start`, {
      headers: authHeaders
    });
    assert.equal(authOauthStart.response.status, 200, 'authenticated OAuth start should return 200');
    assert.equal(Boolean(authOauthStart.data?.flowId), true, 'OAuth start should return flowId');
    assert.equal(
      Object.prototype.hasOwnProperty.call(authOauthStart.data || {}, 'codeVerifier'),
      false,
      'OAuth start must not return codeVerifier'
    );
  } catch (error) {
    const serverStderr = server.stderr().trim();
    if (serverStderr) {
      throw new Error(`${error.message}\n[server stderr]\n${serverStderr}`);
    }
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

async function run() {
  await runConfigChecks();
  await runInternetBoundaryChecks();
  console.log('[security:test] smoke checks passed');
}

run().catch((error) => {
  console.error('[security:test] failed:', error.message);
  process.exit(1);
});
