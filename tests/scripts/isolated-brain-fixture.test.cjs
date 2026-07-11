'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

async function receiptFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-fixture-receipt-')));
  const receiptRunDir = path.join(root, 'receipt-run');
  await fs.mkdir(receiptRunDir);
  return {
    root,
    context: {
      receiptRunDir,
      receiptRunId: 'isolated-production-fixture',
      authority: 'isolated-controlled',
      implementationCommit: 'a'.repeat(40),
      hostname: 'fixture-host',
      startedAt: '2026-07-10T00:00:00.000Z',
    },
  };
}

async function awaitTerminal(client, initial) {
  let current = initial;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (TERMINAL.has(current.state)) {
      return client.inspectOperation(current.operationId, 'result');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = await client.getOperation(current.operationId);
  }
  throw Object.assign(new Error('fixture operation did not become terminal'), {
    code: 'fixture_operation_timeout',
  });
}

async function awaitState(client, operationId, expected) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = await client.getOperation(operationId);
    if (expected.includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Object.assign(new Error(`fixture operation did not reach ${expected.join(',')}`), {
    code: 'fixture_operation_timeout',
  });
}

async function awaitProviderStart(fixture, baseline) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const telemetry = await fixture.telemetry();
    if (telemetry.cosmo.providerStarts > baseline) return telemetry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Object.assign(new Error('fixture provider did not start'), {
    code: 'fixture_provider_timeout',
  });
}

test('isolated stop refuses child handles not created by the fixture launcher', async () => {
  const { stopIsolatedFixture } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  await assert.rejects(stopIsolatedFixture({
    children: {
      dashboard: { pid: 111, exitCode: 0 },
      cosmo: { pid: 222, exitCode: 0 },
    },
    operationsRoot: '/tmp/not-a-fixture-store',
  }), (error) => error.code === 'isolated_child_not_owned');
});

test('isolated launcher refuses the repository as a fixture root before creating runtime state', async (t) => {
  const { startIsolatedFixture } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(startIsolatedFixture({
    fixtureRoot: process.cwd(),
    context: state.context,
  }), (error) => error.code === 'isolated_fixture_live_root_refused');
});

test('isolated launcher exposes distinct own, sibling, completed-research, and MCP sources', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const { loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-source-mcp-fixture-'),
  ));
  let launched;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'source-fixture',
    nodeCount: 12,
    edgeCount: 11,
    operationDelayMs: 5,
  });
  assert.equal(Number.isSafeInteger(launched.pids.mcp), true);
  assert.equal(Number.isSafeInteger(launched.ports.mcp), true);
  assert.notEqual(launched.pids.mcp, launched.pids.dashboard);
  assert.notEqual(launched.pids.mcp, launched.pids.cosmo);
  assert.deepEqual(launched.canary, {
    query: 'authoritative isolated canary production',
    nodeId: '1',
    sourceRevision: 1,
    sourceHealth: 'healthy',
    selectedBrain: launched.brainId,
    discoveryRoute: 'production-memory-source-reader',
  });
  const firstMetrics = {};
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    const metrics = JSON.parse(await fs.readFile(launched.metrics[role], 'utf8'));
    firstMetrics[role] = metrics;
    assert.equal(metrics.schemaVersion, 2);
    assert.equal(metrics.role, role);
    assert.equal(metrics.pid, launched.pids[role]);
    assert.equal(Object.hasOwn(metrics, 'heapUsedMiB'), false);
    assert.equal(Number.isFinite(metrics.v8HeapUsedMiB) && metrics.v8HeapUsedMiB >= 0, true);
    assert.equal(Number.isFinite(metrics.rssMiB) && metrics.rssMiB > 0, true);
    assert.equal(metrics.processMaxRssMiB >= metrics.rssMiB, true);
    assert.deepEqual(metrics.semantics, {
      v8HeapUsedBytes: 'request-time-sample',
      rssBytes: 'request-time-sample',
      processMaxRssBytes: 'process-lifetime-high-water',
    });
    assert.equal(Number.isFinite(Date.parse(metrics.updatedAt)), true);
  }
  await new Promise((resolve) => setTimeout(resolve, 75));
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    const metrics = JSON.parse(await fs.readFile(launched.metrics[role], 'utf8'));
    assert.equal(metrics.pid, firstMetrics[role].pid);
    assert.equal(metrics.processMaxRssMiB >= firstMetrics[role].processMaxRssMiB, true);
  }

  const client = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'source-fixture',
    shortWaitMs: 5_000,
    reconnectDelayMs: 10,
  });
  const catalog = await client.getCatalog({ forceRefresh: true });
  const own = catalog.brains.find((brain) => brain.id === launched.brainId);
  const sibling = catalog.brains.find((brain) => brain.id === `${launched.brainId}-sibling`);
  const research = catalog.brains.find((brain) => brain.id === `${launched.brainId}-research-completed`);
  assert.ok(own);
  assert.ok(sibling);
  assert.ok(research);
  assert.equal(sibling.ownerAgent, 'source-fixture-sibling');
  assert.equal(research.kind, 'research');
  assert.equal(research.lifecycle, 'completed');
  assert.equal(new Set([
    own.canonicalRoot,
    sibling.canonicalRoot,
    research.canonicalRoot,
  ]).size, 3);
  assert.equal((await client.resolveTarget()).accessMode, 'own');
  assert.equal((await client.resolveTarget({ agent: sibling.ownerAgent })).accessMode, 'read-only');
  assert.equal((await client.resolveTarget({ brainId: research.id })).accessMode, 'read-only');

  const cases = [
    { target: undefined, phrase: 'authoritative isolated own canary', brainId: own.id },
    {
      target: { agent: sibling.ownerAgent },
      phrase: 'authoritative isolated sibling canary',
      brainId: sibling.id,
    },
    {
      target: { brainId: research.id },
      phrase: 'authoritative isolated completed research canary',
      brainId: research.id,
    },
  ];
  for (const entry of cases) {
    const initialSearch = await client.search({
      ...(entry.target ? { target: entry.target } : {}),
      query: entry.phrase,
      topK: 5,
    });
    const search = TERMINAL.has(initialSearch.state)
      ? await client.inspectOperation(initialSearch.operationId, 'result')
      : await awaitTerminal(client, initialSearch);
    assert.equal(search.sourceEvidence?.sourceHealth, 'healthy', JSON.stringify(search));
    assert.equal(search.sourceEvidence.selectedBrain, entry.brainId);
    assert.ok(search.result.results.some(
      (result) => String(result.concept).includes(entry.phrase),
    ));
  }

  const health = await fetch(`${launched.mcpBaseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    protocolVersion: '2025-03-26',
    sourceHealth: 'healthy',
    revision: 1,
    totals: { nodes: 12, edges: 11 },
  });
  const proxied = await fetch(`${launched.baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'isolated-mcp-parity',
      method: 'tools/call',
      params: {
        name: 'query_memory',
        arguments: { query: 'authoritative isolated own canary', limit: 5 },
      },
    }),
  });
  const mcpText = await proxied.text();
  const dataLine = mcpText.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, mcpText);
  const mcpBody = JSON.parse(dataLine.slice(6));
  assert.equal(proxied.status, 200, JSON.stringify(mcpBody));
  const mcpResult = JSON.parse(mcpBody.result.content[0].text);
  assert.equal(mcpResult.evidence.sourceHealth, 'healthy');
  assert.equal(mcpResult.evidence.identity.brainId, own.id);
  assert.ok(mcpResult.results.some((result) => String(result.id) === '1'));
});

test('isolated launcher exercises production query, pinned PGS, and lifecycle recovery', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const { loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-two-process-fixture-'),
  ));
  let launched;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });
  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'acceptance-fixture',
    nodeCount: 600,
    edgeCount: 599,
    operationDelayMs: 5,
    pgsSynthesisIncomplete: true,
  });
  assert.notEqual(launched.pids.dashboard, launched.pids.cosmo);
  assert.ok(launched.ports.dashboard > 0 && launched.ports.cosmo > 0);
  assert.equal(path.isAbsolute(launched.runtimeRoot), true);
  assert.equal(path.relative(launched.fixtureRoot, launched.runtimeRoot).startsWith('..'), false);
  const dashboardConfig = JSON.parse(await fs.readFile(launched.dashboardConfigFile, 'utf8'));
  assert.equal(Object.hasOwn(dashboardConfig, 'capabilityKey'), false);
  assert.equal(dashboardConfig.capabilityKeyFile, launched.capabilityKeyFile);
  assert.equal((await fs.stat(launched.capabilityKeyFile)).mode & 0o777, 0o600);
  const client = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'acceptance-fixture',
    queryWaitMs: 5_000,
    reconnectDelayMs: 10,
  });

  const initial = await client.query({ query: 'controlled production fixture query' });
  if (['queued', 'running'].includes(initial.state)) await client.resumeOperation(initial.operationId);
  const terminal = await awaitTerminal(client, initial);
  const workerTelemetry = await launched.operationTelemetry(terminal.operationId);
  assert.equal(terminal.state, 'complete', JSON.stringify({ terminal, workerTelemetry }));
  assert.match(terminal.result.answer, /production pinned query executor/);

  const pgsInitial = await client.query({
    query: 'authoritative isolated canary',
    enablePGS: true,
    pgsMode: 'full',
    pgsConfig: { sweepFraction: 1 },
    pgsSweep: { provider: 'controlled', model: 'controlled-pgs' },
    pgsSynth: { provider: 'controlled', model: 'controlled-pgs' },
  });
  if (['queued', 'running'].includes(pgsInitial.state)) {
    await client.resumeOperation(pgsInitial.operationId);
  }
  const pgs = await awaitTerminal(client, pgsInitial);
  assert.equal(pgs.state, 'partial', JSON.stringify(pgs));
  assert.equal(pgs.error.code, 'provider_incomplete');
  assert.equal(pgs.result.sweepOutputs.length, 3);
  assert.equal(pgs.result.metadata.pgs.successfulSweeps, 3);
  assert.deepEqual(pgs.result.metadata.pgs.sourceTotals, {
    edges: 599, nodes: 600, workUnits: 3,
  });
  assert.equal(pgs.sourceEvidence.authoritativeTotals.nodes, 600);
  assert.equal(pgs.sourcePinDescriptor.summary.nodeCount, 600);
  assert.match(pgs.sourcePinDigest, /^sha256:[a-f0-9]{64}$/);
  const telemetry = await launched.telemetry();
  assert.equal(telemetry.cosmo.models['controlled-pgs'], 4);
  assert.equal(telemetry.dashboard.providerStarts, 0);

  const detachStart = await client.start('query', {
    query: 'controlled lifecycle detach acceptance', mode: 'quick',
  });
  const detachRunning = await awaitState(client, detachStart.operationId, ['running']);
  const disconnect = new AbortController();
  disconnect.abort(Object.assign(new Error('controlled transport drop'), {
    code: 'transport_disconnect',
  }));
  const detached = await client.wait(detachStart.operationId, {
    operationType: 'query', initial: detachRunning,
    signal: disconnect.signal, waitMs: 5_000,
  });
  assert.equal(detached.state, 'running');
  assert.equal(detached.attachmentState, 'detached');
  await client.resumeOperation(detachStart.operationId);
  assert.equal((await awaitTerminal(client, detachRunning)).state, 'complete');

  const cancelStart = await client.start('query', {
    query: 'controlled lifecycle cancel acceptance', mode: 'quick',
  });
  const cancelRunning = await awaitState(client, cancelStart.operationId, ['running']);
  const abortsBefore = (await launched.telemetry()).cosmo.providerAborts;
  await client.cancel(cancelStart.operationId);
  const cancelled = await awaitTerminal(client, cancelRunning);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error.code, 'operation_cancelled');
  assert.equal((await launched.telemetry()).cosmo.providerAborts, abortsBefore + 1);

  const restartProviderStarts = (await launched.telemetry()).cosmo.providerStarts;
  const restartStart = await client.start('query', {
    query: 'controlled lifecycle restart acceptance', mode: 'quick',
  });
  await awaitState(client, restartStart.operationId, ['running']);
  await awaitProviderStart(launched, restartProviderStarts);
  const firstDashboardPid = launched.pids.dashboard;
  await launched.restartDashboard();
  assert.notEqual(launched.pids.dashboard, firstDashboardPid);
  assert.throws(() => process.kill(firstDashboardPid, 0), (error) => error.code === 'ESRCH');
  const reloaded = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'acceptance-fixture',
  });
  let reconciled;
  try {
    reconciled = await reloaded.getOperation(restartStart.operationId);
  } catch (error) {
    const operationDirectory = path.join(
      launched.operationsRoot,
      'operations',
      restartStart.operationId,
    );
    const attachmentDirectory = path.join(operationDirectory, 'attachments');
    const attachments = await fs.readdir(attachmentDirectory).catch(() => []);
    const diagnostics = {
      error: { code: error.code, message: error.message },
      status: JSON.parse(await fs.readFile(path.join(operationDirectory, 'status.json'), 'utf8')),
      attachments: Object.fromEntries(await Promise.all(attachments.map(async (name) => [
        name,
        JSON.parse(await fs.readFile(path.join(attachmentDirectory, name), 'utf8')),
      ]))),
      worker: await launched.operationTelemetry(restartStart.operationId),
    };
    assert.fail(JSON.stringify(diagnostics));
  }
  assert.equal(reconciled.state, 'running');
  const resumed = await reloaded.resumeOperation(restartStart.operationId);
  assert.equal((await awaitTerminal(reloaded, resumed)).state, 'complete');
  assert.equal((await reloaded.inspectOperation(terminal.operationId, 'result')).state, 'complete');

  const stopped = await stopIsolatedFixture(launched);
  assert.equal(stopped.retainedStore, launched.operationsRoot);
  assert.ok((await fs.stat(launched.operationsRoot)).isDirectory());
  for (const pid of [launched.pids.dashboard, launched.pids.cosmo]) {
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
  }
  launched = null;
});
