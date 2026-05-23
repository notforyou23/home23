const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '../..');
const EVOBREW_ROOT = path.join(REPO_ROOT, 'evobrew');
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
      // Keep polling until the spawned server is ready.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

function startEvobrewServer() {
  const port = 38500 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: EVOBREW_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HTTPS_PORT: String(port + 1),
      SECURITY_PROFILE: 'local',
      EVOBREW_CONFIG_DIR: EVOBREW_ROOT,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
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

test('Evobrew local profile accepts Tailscale-origin brain picker requests', async () => {
  const server = startEvobrewServer();

  try {
    await waitForHealth(server.baseUrl);

    const { response, data } = await fetchJson(`${server.baseUrl}/api/brains/locations`, {
      headers: {
        origin: 'http://100.72.171.58:3415'
      }
    });

    assert.equal(response.status, 200);
    assert.equal(data?.success, true);
    assert.equal(Array.isArray(data?.locations), true);
  } catch (error) {
    const stderr = server.stderr().trim();
    if (stderr) {
      throw new Error(`${error.message}\n[server stderr]\n${stderr}`);
    }
    throw error;
  } finally {
    await stopServer(server.child);
  }
});
