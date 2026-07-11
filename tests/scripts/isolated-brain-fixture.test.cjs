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
  const client = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'acceptance-fixture',
    queryWaitMs: 5_000,
    reconnectDelayMs: 10,
  });

  const initial = await client.query({ query: 'controlled production fixture query' });
  if (['queued', 'running'].includes(initial.state)) await client.resumeOperation(initial.operationId);
  const terminal = await awaitTerminal(client, initial);
  assert.equal(terminal.state, 'complete');
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
  assert.equal(pgs.state, 'partial');
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

  const restartStart = await client.start('query', {
    query: 'controlled lifecycle restart acceptance', mode: 'quick',
  });
  await awaitState(client, restartStart.operationId, ['running']);
  const firstDashboardPid = launched.pids.dashboard;
  await launched.restartDashboard();
  assert.notEqual(launched.pids.dashboard, firstDashboardPid);
  assert.throws(() => process.kill(firstDashboardPid, 0), (error) => error.code === 'ESRCH');
  const reloaded = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'acceptance-fixture',
  });
  const reconciled = await reloaded.getOperation(restartStart.operationId);
  assert.equal(reconciled.state, 'running');
  assert.equal((await awaitTerminal(reloaded, reconciled)).state, 'complete');
  assert.equal((await reloaded.inspectOperation(terminal.operationId, 'result')).state, 'complete');

  const stopped = await stopIsolatedFixture(launched);
  assert.equal(stopped.retainedStore, launched.operationsRoot);
  assert.ok((await fs.stat(launched.operationsRoot)).isDirectory());
  for (const pid of [launched.pids.dashboard, launched.pids.cosmo]) {
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
  }
  launched = null;
});
