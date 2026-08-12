'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const yaml = require('js-yaml');

const requestedSandboxRoot = path.resolve(process.env.HOME23_REPLAY_SANDBOX_ROOT || '');
const configRoot = path.resolve(process.env.HOME23_REPLAY_CONFIG_ROOT || '');
const artifactDir = path.resolve(process.env.HOME23_REPLAY_ARTIFACT_DIR || '');
assert.match(requestedSandboxRoot, /^\/tmp\/home23-cosmo-repair-replay-[A-Za-z0-9._-]+$/);
const sandboxRoot = fs.realpathSync(requestedSandboxRoot);
assert.match(sandboxRoot, /^\/private\/tmp\/home23-cosmo-repair-replay-[A-Za-z0-9._-]+$/);
assert.ok(configRoot && configRoot !== '/', 'HOME23_REPLAY_CONFIG_ROOT is required');
assert.ok(artifactDir && artifactDir !== '/', 'HOME23_REPLAY_ARTIFACT_DIR is required');
fs.mkdirSync(artifactDir, { recursive: true });

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(read, accept, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch (error) {
      latest = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} not reached within ${timeoutMs}ms; latest=${JSON.stringify(latest)}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, body };
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function childHasJerryEnvironment(pid) {
  for (const args of [['eww', '-p', String(pid)], ['eww', '-o', 'command=', '-p', String(pid)]]) {
    try {
      const text = execFileSync('ps', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (/(?:^|\s)HOME23_AGENT=jerry(?:\s|$)/.test(text)) return true;
    } catch { /* try the alternate ps form */ }
  }
  return false;
}

function scrubLog(message) {
  return String(message)
    .replace(/(?:sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/gi, '[credential-redacted]')
    .slice(0, 1000);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function exactSandboxPortPids(ports) {
  const pids = new Set();
  for (const port of ports) {
    try {
      const output = execFileSync('lsof', ['-ti', `TCP:${port}`], { encoding: 'utf8' });
      for (const raw of output.split(/\s+/).filter(Boolean)) {
        const pid = Number(raw);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        let command = '';
        try { command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch {}
        if (command.includes(sandboxRoot)) pids.add(pid);
      }
    } catch { /* no listener */ }
  }
  return [...pids];
}

async function terminateExactPids(pids) {
  for (const pid of pids) {
    if (!processAlive(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && pids.some(processAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of pids) {
    if (!processAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

const receipt = {
  schema: 'home23.repair-replay.cosmo.v1',
  startedAt: new Date().toISOString(),
  sandboxRoot,
};
let parentServer = null;
let serverApi = null;
let baseUrl = null;
let mcpUrl = null;
let childPids = [];
let ports = [];
let thrown = null;

(async () => {
  try {
    assert.ok(fs.existsSync(path.join(sandboxRoot, 'cosmo23', 'server', 'index.js')),
      'patched COSMO sandbox copy is missing');
    const homeConfig = readYaml(path.join(configRoot, 'config', 'home.yaml'));
    const secrets = readYaml(path.join(configRoot, 'config', 'secrets.yaml'));
    const credential = secrets?.providers?.anthropic?.apiKey
      || process.env.ANTHROPIC_AUTH_TOKEN
      || process.env.ANTHROPIC_API_KEY;
    const openaiCredential = secrets?.providers?.openai?.apiKey || process.env.OPENAI_API_KEY;
    assert.ok(credential, 'Jerry Anthropic credential is unavailable');
    assert.ok(openaiCredential, 'Dashboard OpenAI credential is unavailable');

    const [appPort, wsPort, mcpPort, dashboardPort] = await Promise.all([
      freePort(), freePort(), freePort(), freePort(),
    ]);
    ports = [appPort, wsPort, mcpPort, dashboardPort];
    baseUrl = `http://127.0.0.1:${appPort}`;
    mcpUrl = `http://127.0.0.1:${mcpPort}`;

    const configDir = path.join(sandboxRoot, 'cosmo-config');
    const runId = `research-replay-${Date.now().toString(36)}`;
    const runRoot = path.join(sandboxRoot, 'instances', 'jerry', 'workspace', 'research-runs', runId);
    fs.mkdirSync(path.join(sandboxRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(sandboxRoot, 'instances', 'jerry', 'workspace'), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, 'config', 'home.yaml'), JSON.stringify({
      home: { primaryAgent: homeConfig?.home?.primaryAgent || 'jerry' },
    }, null, 2));

    Object.assign(process.env, {
      ANTHROPIC_AUTH_TOKEN: credential,
      OPENAI_API_KEY: openaiCredential,
      HOME23_AGENT: 'shared-parent-sentinel',
      HOME23_MANAGED: 'false',
      COSMO23_CONFIG_DIR: configDir,
      COSMO23_PORT: String(appPort),
      COSMO23_WS_PORT: String(wsPort),
      COSMO23_MCP_HTTP_PORT: String(mcpPort),
      COSMO23_DASHBOARD_PORT: String(dashboardPort),
      COSMO23_SENTINEL_CHECK_INTERVAL_MS: '3600000',
      COSMO23_SENTINEL_LAUNCH_GRACE_MS: '3600000',
    });
    delete process.env.HOME23_MCP_REQUEST_IDENTITY_KEY;

    serverApi = require(path.join(sandboxRoot, 'cosmo23', 'server', 'index.js'));
    const { RunManager } = require(path.join(sandboxRoot, 'cosmo23', 'launcher', 'run-manager.js'));
    const { writeJsonlGzAtomic } = require(path.join(sandboxRoot, 'shared', 'memory-source'));
    parentServer = serverApi.startServer();
    await waitFor(
      () => fetchJson(`${baseUrl}/api/health`),
      (value) => value.status === 200 && value.body?.success === true,
      15_000,
      'sandbox COSMO parent health',
    );

    const runManager = new RunManager(path.join(sandboxRoot, 'cosmo23', 'runs'), console,
      path.join(sandboxRoot, 'cosmo23'));
    const created = await runManager.createRun(runId, {
      runPath: runRoot,
      owner: 'jerry',
      topic: 'Bounded trusted MCP replay',
    });
    assert.equal(created.success, true, created.error);

    const nodes = await writeJsonlGzAtomic(path.join(runRoot, 'memory-nodes.base-1.jsonl.gz'), []);
    const edges = await writeJsonlGzAtomic(path.join(runRoot, 'memory-edges.base-1.jsonl.gz'), []);
    fs.writeFileSync(path.join(runRoot, 'memory-delta.replay-e2.jsonl'), '');
    fs.writeFileSync(path.join(runRoot, 'memory-manifest.json'), `${JSON.stringify({
      formatVersion: 1,
      generation: 'replay-g1',
      baseRevision: 1,
      currentRevision: 1,
      activeDeltaEpoch: 'replay-e2',
      activeBase: {
        nodes: { file: 'memory-nodes.base-1.jsonl.gz', count: 0, bytes: nodes.bytes },
        edges: { file: 'memory-edges.base-1.jsonl.gz', count: 0, bytes: edges.bytes },
      },
      activeDelta: {
        epoch: 'replay-e2',
        file: 'memory-delta.replay-e2.jsonl',
        fromRevision: 2,
        toRevision: 1,
        count: 0,
        committedBytes: 0,
      },
      ann: { indexFile: null, metaFile: null, builtFromRevision: 1 },
      summary: { nodeCount: 0, edgeCount: 0, clusterCount: 0 },
    }, null, 2)}\n`);

    const brain = {
      id: `replay-${Date.now().toString(36)}`,
      routeKey: `replay-${Date.now().toString(36)}`,
      name: runId,
      path: runRoot,
      sourceType: 'local',
      sourceLabel: 'Local',
      topic: 'Bounded trusted MCP replay',
      hasState: false,
      cycleCount: 0,
    };
    const payload = {
      runName: runId,
      runRoot,
      owner: 'jerry',
      topic: 'Bounded trusted MCP replay',
      context: 'Stop immediately after trusted MCP and filesystem readiness are proven.',
      cycles: 1,
      maxRuntimeMinutes: 1,
      explorationMode: 'guided',
      analysisDepth: 'shallow',
      maxConcurrent: 1,
      primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-5',
      fastProvider: 'anthropic', fastModel: 'claude-sonnet-5',
      strategicProvider: 'anthropic', strategicModel: 'claude-sonnet-5',
      enableWebSearch: true,
      enableCodingAgents: false,
      enableAgentRouting: true,
      enableMemoryGovernance: true,
      enableSleep: false,
      enableIntrospection: false,
      enableRecursiveMode: false,
      enableFrontier: false,
    };

    const launchResult = await serverApi.launchPreparedResearch(brain, payload, {
      headers: {}, secure: false, hostname: '127.0.0.1', requesterAgent: 'jerry',
    });
    assert.equal(launchResult.success, true);
    assert.equal(process.env.HOME23_AGENT, 'shared-parent-sentinel');

    const activeStatus = await waitFor(
      () => fetchJson(`${baseUrl}/api/status`),
      (value) => value.status === 200 && value.body?.activeRun === true,
      10_000,
      'active prepared run status',
    );
    const running = activeStatus.body.processStatus?.running || [];
    const requiredNames = ['mcp-http', 'main-dashboard', 'cosmo-main'];
    assert.deepEqual([...running.map((entry) => entry.name)].sort(), [...requiredNames].sort());
    childPids = running.map((entry) => entry.pid).filter((pid) => Number.isSafeInteger(pid));
    const mcpProcess = running.find((entry) => entry.name === 'mcp-http');
    assert.ok(mcpProcess?.pid);
    assert.equal(childHasJerryEnvironment(mcpProcess.pid), true,
      'actual MCP child did not expose HOME23_AGENT=jerry');

    const mcpHealth = await waitFor(
      () => fetchJson(`${mcpUrl}/health`),
      (value) => value.status === 200 && value.body?.ok === true,
      15_000,
      'trusted MCP source health',
    );
    assert.notEqual(mcpHealth.body?.error?.code, 'mcp_source_context_required');

    const listResponse = await fetch(`${mcpUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'replay-tools-list', method: 'tools/list', params: {} }),
    });
    const listText = await listResponse.text();
    assert.equal(listResponse.status, 200);
    assert.match(listText, /query_memory|get_memory_statistics/);
    assert.doesNotMatch(listText, /mcp_source_context_required|trusted MCP source environment required/);

    const logsBeforeStop = await fetchJson(`${baseUrl}/api/watch/logs?after=0&limit=1000`);
    const selectedLogs = (logsBeforeStop.body?.logs || [])
      .filter((entry) => /MCP|Dashboard|COSMO|run|runtime|source|started/i.test(entry.message || ''))
      .map((entry) => ({
        id: entry.id,
        source: entry.source,
        level: entry.level,
        message: scrubLog(entry.message),
        timestamp: entry.timestamp,
      }));
    assert.doesNotMatch(JSON.stringify(selectedLogs),
      /mcp_source_context_required|trusted MCP source environment required/);

    receipt.launch = {
      runId,
      ownerAgent: 'jerry',
      runJsonOwner: JSON.parse(fs.readFileSync(path.join(runRoot, 'run.json'), 'utf8')).owner,
      canonicalEmptySourceSeeded: true,
      launchResult,
      parentAgentAfterLaunch: process.env.HOME23_AGENT,
      requiredProcesses: running.map((entry) => ({ name: entry.name, pid: entry.pid, killed: entry.killed })),
      mcpChildHasJerryEnvironment: true,
      mcpHealth: mcpHealth.body,
      mcpToolsListStatus: listResponse.status,
      mcpToolsListReached: true,
      forbiddenSourceErrorObserved: false,
    };
    receipt.selectedLogs = selectedLogs;

    const stop = await fetchJson(`${baseUrl}/api/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.equal(stop.body?.status, 'stopped');
    const stoppedStatus = await waitFor(
      () => fetchJson(`${baseUrl}/api/status`),
      (value) => value.status === 200
        && value.body?.activeRun === false
        && value.body?.processStatus?.count === 0,
      15_000,
      'sandbox COSMO child shutdown',
    );
    const mcpReachableAfterStop = await fetch(`${mcpUrl}/health`)
      .then(() => true)
      .catch(() => false);
    assert.equal(mcpReachableAfterStop, false);
    assert.deepEqual(childPids.filter(processAlive), []);
    receipt.stop = {
      response: stop.body,
      processCountAfter: stoppedStatus.body.processStatus.count,
      activeRunAfter: stoppedStatus.body.activeRun,
      mcpReachableAfterStop,
      childPidsAliveAfter: childPids.filter(processAlive),
    };

    const evidenceDir = path.join(artifactDir, 'cosmo-runtime-evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    for (const name of ['run.json', 'metadata.json', 'run-metadata.json']) {
      const source = path.join(runRoot, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(evidenceDir, name));
    }
    fs.writeFileSync(path.join(evidenceDir, 'selected-process-logs.json'), JSON.stringify(selectedLogs, null, 2));
    receipt.completedAt = new Date().toISOString();
  } catch (error) {
    thrown = error;
    receipt.failure = { message: error.message, stack: error.stack };
  } finally {
    try {
      if (baseUrl) await fetchJson(`${baseUrl}/api/stop`, { method: 'POST' });
    } catch {}
    const lingering = [...new Set([...childPids, ...exactSandboxPortPids(ports)])];
    await terminateExactPids(lingering);
    try { serverApi?.runSentinel?.stop?.(); } catch {}
    try { await closeServer(parentServer); } catch {}
    const aliveAfterCleanup = lingering.filter(processAlive);
    const listenerPidsAfterCleanup = exactSandboxPortPids(ports);
    await fsp.rm(sandboxRoot, { recursive: true, force: true });
    receipt.cleanup = {
      sandboxRemoved: !fs.existsSync(sandboxRoot),
      childPidsAliveAfterCleanup: aliveAfterCleanup,
      sandboxListenerPidsAfterCleanup: listenerPidsAfterCleanup,
    };
    fs.writeFileSync(path.join(artifactDir, 'cosmo-prepared-replay.json'), JSON.stringify(receipt, null, 2));
  }

  console.log(JSON.stringify({
    ok: !receipt.failure,
    receipt: path.join(artifactDir, 'cosmo-prepared-replay.json'),
    launch: receipt.launch,
    stop: receipt.stop,
    cleanup: receipt.cleanup,
    failure: receipt.failure?.message,
  }, null, 2));
  if (thrown) throw thrown;
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
