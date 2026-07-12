'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function makeState(t, name, { autoCleanup = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `home23-${name}-`)));
  const receiptRunDir = path.join(root, 'receipts');
  const fixtureRoot = path.join(root, 'fixture');
  await Promise.all([
    fs.mkdir(receiptRunDir),
    fs.mkdir(fixtureRoot),
  ]);
  if (autoCleanup) t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    receiptRunDir,
    fixtureRoot,
    env: {
      ...process.env,
      HOME23_RECEIPT_RUN_DIR: receiptRunDir,
      HOME23_RECEIPT_RUN_ID: `isolated-cli-${name}`,
      HOME23_RECEIPT_AUTHORITY: 'isolated-controlled',
    },
  };
}

async function readRows(file) {
  const { readReceiptRows } = await import('../../scripts/live-brain-tools-smoke.mjs');
  return readReceiptRows(file);
}

function assertStopped(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
}

function assertSourceIntegrity(row) {
  assert.equal(row.isolatedSourceIntegrity?.unchanged, true, JSON.stringify(row));
  assert.deepEqual(
    row.isolatedSourceIntegrity.before.sources.map((source) => source.role),
    ['own', 'sibling', 'research'],
  );
  assert.deepEqual(
    row.isolatedSourceIntegrity.before,
    row.isolatedSourceIntegrity.after,
  );
  for (const source of row.isolatedSourceIntegrity.after.sources) {
    assert.ok(source.files.length >= 5);
    assert.ok(source.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  }
}

function assertIsolatedTerminal(row, state) {
  assert.equal(row.receiptKind, 'operation-terminal');
  assert.equal(row.authority, 'isolated-controlled');
  assert.equal(row.protectedResultRead, true);
  assert.equal(row.state, state, JSON.stringify(row));
  assert.equal(row.authorizedEndpoint, null);
  assert.equal(typeof row.isolatedStore, 'string');
  assert.equal(path.isAbsolute(row.isolatedStore), true);
  assert.equal(row.isolatedFixture.retainedStore, row.isolatedStore);
  assertSourceIntegrity(row);
  assert.deepEqual(row.isolatedFixture.sourceIntegrity, row.isolatedSourceIntegrity);
  assert.match(row.isolatedFixture.basename, /^fixture$/);
  assert.match(row.isolatedFixture.dev, /^\d+$/);
  assert.match(row.isolatedFixture.ino, /^\d+$/);
  assert.ok(row.isolatedFixture.ports.dashboard > 0);
  assert.ok(row.isolatedFixture.ports.cosmo > 0);
  assert.ok(row.isolatedFixture.ports.mcp > 0);
  assert.notEqual(row.isolatedFixture.pids.dashboard, row.isolatedFixture.pids.cosmo);
  assert.notEqual(row.isolatedFixture.pids.dashboard, row.isolatedFixture.pids.mcp);
  assert.notEqual(row.isolatedFixture.pids.cosmo, row.isolatedFixture.pids.mcp);
  assert.deepEqual([...row.isolatedFixture.stoppedPids].sort((a, b) => a - b),
    [
      row.isolatedFixture.pids.cosmo,
      row.isolatedFixture.pids.dashboard,
      row.isolatedFixture.pids.mcp,
    ].sort((a, b) => a - b));
  for (const pid of row.isolatedFixture.stoppedPids) assertStopped(pid);
}

test('controlled lifecycle CLI refuses a supplied endpoint instead of risking a live service', async (t) => {
  const { main } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await makeState(t, 'endpoint-refusal');
  await assert.rejects(main([
    '--scenario', 'detach-reattach',
    '--isolated-fixture', state.fixtureRoot,
    '--controlled-provider',
    '--base-url', 'http://127.0.0.1:9',
    '--output', path.join(state.receiptRunDir, 'must-not-exist.jsonl'),
  ], state.env), (error) => error.code === 'isolated_fixture_endpoint_override_refused');
});

test('isolated CLI proves real dashboard-to-MCP parity and a healthy exhaustive zero result', async (t) => {
  const { main } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await makeState(t, 'mcp-parity', { autoCleanup: false });
  let launched = await startIsolatedFixture({
    fixtureRoot: state.fixtureRoot,
    context: {
      receiptRunDir: state.receiptRunDir,
      receiptRunId: state.env.HOME23_RECEIPT_RUN_ID,
      authority: 'isolated-controlled',
    },
    agent: 'mcp-fixture',
    nodeCount: 20,
    edgeCount: 19,
    operationDelayMs: 5,
  });
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await fs.rm(state.root, { recursive: true, force: true });
  });
  const shared = [
    '--base-url', launched.baseUrl,
    '--caller-agent', launched.agent,
    '--isolated-fixture', state.fixtureRoot,
    '--isolated-store', launched.operationsRoot,
    '--controlled-provider',
  ];

  const canaryFile = path.join(state.receiptRunDir, 'mcp-canary.json');
  await main([
    '--scenario', 'discover-canary', ...shared,
    '--output', canaryFile,
  ], state.env);
  const [canary] = await readRows(canaryFile);
  assert.equal(canary.sourceHealth, 'healthy');
  assert.equal(canary.selectedBrain, launched.brainId);

  const parityFile = path.join(state.receiptRunDir, 'mcp-parity.jsonl');
  await main([
    '--scenario', 'mcp-parity', ...shared,
    '--canary-receipt', canaryFile,
    '--output', parityFile,
  ], state.env);
  const [parity] = await readRows(parityFile);
  assertSourceIntegrity(parity);
  assert.equal(parity.mcpParity, true);
  assert.equal(parity.nodeId, canary.nodeId);
  assert.equal(parity.sourceRevision, canary.sourceRevision);

  const zeroFile = path.join(state.receiptRunDir, 'zero.jsonl');
  await main([
    '--scenario', 'zero-result', ...shared,
    '--query', 'fixture-guaranteed-absent-7edc38031ed44e6ba66f',
    '--output', zeroFile,
  ], state.env);
  const [zero] = await readRows(zeroFile);
  assert.equal(zero.sourceHealth, 'healthy');
  assert.equal(zero.matchOutcome, 'no_match');
  assert.equal(zero.completeCoverage, true);
  assert.equal(zero.authoritativeTotal, 20);

  const stopped = await stopIsolatedFixture(launched);
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    assert.equal(stopped[role].exited, true);
    assertStopped(stopped[role].pid);
  }
  launched = null;
});

test('isolated CLI reads sibling and completed-research brains and exports requester-owned results', async (t) => {
  const { main } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await makeState(t, 'cross-brain', { autoCleanup: false });
  let launched = await startIsolatedFixture({
    fixtureRoot: state.fixtureRoot,
    context: {
      receiptRunDir: state.receiptRunDir,
      receiptRunId: state.env.HOME23_RECEIPT_RUN_ID,
      authority: 'isolated-controlled',
    },
    agent: 'cross-fixture',
    nodeCount: 20,
    edgeCount: 19,
    operationDelayMs: 5,
  });
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await fs.rm(state.root, { recursive: true, force: true });
  });
  const shared = [
    '--base-url', launched.baseUrl,
    '--caller-agent', launched.agent,
    '--isolated-fixture', state.fixtureRoot,
    '--isolated-store', launched.operationsRoot,
    '--controlled-provider',
    '--query-wait-ms', '10000',
  ];
  const siblingAgent = `${launched.agent}-sibling`;
  const researchBrain = `${launched.brainId}-research-completed`;

  const siblingCanaryFile = path.join(state.receiptRunDir, 'sibling-canary.json');
  await main([
    '--scenario', 'discover-canary', ...shared,
    '--target-agent', siblingAgent,
    '--output', siblingCanaryFile,
  ], state.env);
  const [siblingCanary] = await readRows(siblingCanaryFile);
  assert.equal(siblingCanary.selectedAgent, siblingAgent);
  assert.equal(siblingCanary.sourceHealth, 'healthy');

  const siblingFile = path.join(state.receiptRunDir, 'sibling.jsonl');
  try {
    await main([
      '--scenario', 'sibling', ...shared,
      '--target-agent', siblingAgent,
      '--canary-receipt', siblingCanaryFile,
      '--output', siblingFile,
    ], state.env);
  } catch (error) {
    const operationId = /brop_[A-Za-z0-9_-]{32}/.exec(error.message)?.[0];
    if (operationId) {
      error.message = `${error.message} worker=${JSON.stringify(
        await launched.operationTelemetry(operationId),
      )}`;
    }
    throw error;
  }
  const [sibling] = await readRows(siblingFile);
  assertSourceIntegrity(sibling);
  assert.equal(sibling.state, 'complete', JSON.stringify(sibling));
  assert.equal(sibling.target.brainId, `${launched.brainId}-sibling`);
  assert.equal(sibling.target.accessMode, 'read-only');

  const researchCanaryFile = path.join(state.receiptRunDir, 'research-canary.json');
  await main([
    '--scenario', 'discover-canary', ...shared,
    '--target-brain', researchBrain,
    '--output', researchCanaryFile,
  ], state.env);
  const [researchCanary] = await readRows(researchCanaryFile);
  assert.equal(researchCanary.selectedBrain, researchBrain);
  assert.equal(researchCanary.sourceHealth, 'healthy');

  const researchFile = path.join(state.receiptRunDir, 'research.jsonl');
  await main([
    '--scenario', 'completed-research', ...shared,
    '--target-brain', researchBrain,
    '--canary-receipt', researchCanaryFile,
    '--output', researchFile,
  ], state.env);
  const [research] = await readRows(researchFile);
  assertSourceIntegrity(research);
  assert.equal(research.state, 'complete', JSON.stringify(research));
  assert.equal(research.target.brainId, researchBrain);
  assert.equal(research.target.accessMode, 'read-only');

  const exportFile = path.join(state.receiptRunDir, 'research-export.jsonl');
  await main([
    '--scenario', 'canonical-export', ...shared,
    '--operation-receipt', researchFile,
    '--format', 'markdown',
    '--output', exportFile,
  ], state.env);
  const [exported] = await readRows(exportFile);
  assert.equal(exported.receiptKind, 'export');
  assert.equal(exported.operationId, research.operationId);
  assert.equal(typeof exported.exportResult?.relativePath, 'string', JSON.stringify(exported));
  assert.match(
    exported.exportResult.relativePath,
    /^workspace\/brain-exports\//,
    JSON.stringify(exported),
  );

  const compileFile = path.join(state.receiptRunDir, 'research-compile.jsonl');
  await main([
    '--scenario', 'completed-research-compile', ...shared,
    '--target-brain', researchBrain,
    '--canary-receipt', researchCanaryFile,
    '--output', compileFile,
  ], state.env);
  const [compiled] = await readRows(compileFile);
  assertSourceIntegrity(compiled);
  assert.equal(compiled.state, 'complete', JSON.stringify(compiled));
  assert.equal(compiled.target.accessMode, 'read-only');

  const stopped = await stopIsolatedFixture(launched);
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    assert.equal(stopped[role].exited, true);
    assertStopped(stopped[role].pid);
  }
  launched = null;
});

test('large PGS CLI auto-launches a 100k/300k isolated source and retains durable proof', async (t) => {
  const { main } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await makeState(t, 'large-pgs');
  const output = path.join(state.receiptRunDir, 'large-pgs.jsonl');
  const eventsFile = path.join(state.receiptRunDir, 'large-pgs-events.jsonl');
  const heapFile = path.join(state.receiptRunDir, 'large-pgs-heap.json');
  await main([
    '--scenario', 'large-pgs-isolated',
    '--isolated-fixture', state.fixtureRoot,
    '--synthetic-nodes', '100000',
    '--synthetic-edges', '300000',
    '--controlled-provider',
    '--fixture-operation-delay-ms', '1',
    '--sweep-fraction', '0.10',
    '--pgs-wait-ms', '300000',
    '--sse-output', eventsFile,
    '--heap-output', heapFile,
    '--output', output,
  ], state.env);

  const [receipt] = await readRows(output);
  assertIsolatedTerminal(receipt, 'complete');
  assert.equal(receipt.scenario, 'large-pgs-isolated');
  assert.equal(receipt.authoritativeNodeCount, 100000);
  assert.equal(receipt.authoritativeNodes, 100000);
  assert.equal(receipt.sourcePinDescriptor.summary.nodeCount, 100000);
  assert.equal(receipt.sourcePinDescriptor.summary.edgeCount, 300000);
  assert.equal(receipt.controlledProvider, true);
  assert.equal(receipt.liveProviderLargePgsGatePassed, false);
  assert.equal(receipt.providerTerminalValidated, true);
  assert.equal(receipt.result.sweepOutputCount, 400);
  assert.equal(receipt.error, null);
  assert.equal(
    receipt.result.metadata.pgs.successfulSweeps,
    receipt.result.sweepOutputCount,
  );
  assert.deepEqual(receipt.result.metadata.pgs.retryablePartitions, []);
  assert.ok((await fs.stat(receipt.isolatedStore)).isDirectory());

  const events = await readRows(eventsFile);
  assert.ok(events.some((event) => event.type === 'provider_call_terminal'));
  assert.ok(events.some((event) => event.type === 'progress'));
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].eventSequence > events[index - 1].eventSequence);
  }
  const [heap] = await readRows(heapFile);
  assert.equal(heap.receiptKind, 'isolated-process-memory');
  assert.equal(heap.metric, 'runtime-memory-evidence-v2');
  assert.deepEqual(heap.targets.map((target) => target.name).sort(), ['cosmo', 'dashboard']);
  for (const target of heap.targets) {
    assert.ok(target.samples.length >= 3);
    assert.equal(target.pid, receipt.isolatedFixture.pids[target.name]);
    assert.equal(target.pidChanged, false);
    assert.equal(target.restartDelta, 0);
    assert.equal(target.metricFresh, true);
    assert.ok(target.maxSampledV8HeapGrowthMiB <= 256);
    assert.ok(target.maxSampledRssGrowthMiB <= 256);
    assert.ok(target.processMaxRssGrowthMiB <= 256);
    assert.ok(target.finalProcessMaxRssMiB >= target.maxSampledRssMiB);
    assert.ok(target.observedSamples >= target.retainedSamples);
    assert.ok(target.retainedSamples <= heap.maxRetainedSamplesPerRole);
  }
});

test('exact lifecycle CLIs auto-launch isolated production processes and retain one durable store', async (t) => {
  const { main } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await makeState(t, 'lifecycle');
  const shared = [
    '--isolated-fixture', state.fixtureRoot,
    '--controlled-provider',
    '--fixture-operation-delay-ms', '5',
  ];

  const detachFile = path.join(state.receiptRunDir, 'detach.jsonl');
  const detachEventsFile = path.join(state.receiptRunDir, 'detach-events.jsonl');
  await main([
    '--scenario', 'detach-reattach', ...shared,
    '--sse-output', detachEventsFile,
    '--output', detachFile,
  ], state.env);
  const [detached] = await readRows(detachFile);
  assertIsolatedTerminal(detached, 'complete');
  assert.equal(detached.detachedState, 'running');
  assert.equal(detached.reattachedTerminal, true);
  assert.deepEqual({
    total: detached.concurrentAttachments.total,
    attached: detached.concurrentAttachments.attached,
    detached: detached.concurrentAttachments.detached,
  }, { total: 2, attached: 1, detached: 1 });
  assert.deepEqual({
    total: detached.terminalAttachments.total,
    attached: detached.terminalAttachments.attached,
    detached: detached.terminalAttachments.detached,
    closed: detached.terminalAttachments.closed,
  }, { total: 2, attached: 0, detached: 1, closed: 1 });
  const terminalSurvivor = detached.terminalAttachments.entries.find((entry) =>
    entry.state === 'closed');
  const terminalDetached = detached.terminalAttachments.entries.find((entry) =>
    entry.state === 'detached');
  assert.equal(terminalSurvivor?.reason, 'operation_terminal');
  assert.ok(['caller_abort', 'transport_disconnect'].includes(terminalDetached?.reason));
  const detachEvents = await readRows(detachEventsFile);
  assert.equal(new Set(detachEvents.map((event) =>
    `${event.operationId}:${event.eventSequence}`)).size, detachEvents.length);
  assert.ok(detachEvents.every((event) => event.streamAttachments.length >= 1));
  assert.ok(detached.activityAttachments.attachments.some((entry) =>
    entry.attachment === 'survivor'));

  const cancelFile = path.join(state.receiptRunDir, 'cancel.jsonl');
  await main([
    '--scenario', 'cancel', ...shared,
    '--output', cancelFile,
  ], state.env);
  const [cancelled] = await readRows(cancelFile);
  assertIsolatedTerminal(cancelled, 'cancelled');
  assert.equal(cancelled.providerAbortObserved, true);
  assert.equal(cancelled.providerAbortEvidence.evidenceSource, 'isolated-provider-telemetry');
  assert.equal(cancelled.providerAbortEvidence.providerAbortDelta, 1);

  const restartFile = path.join(state.receiptRunDir, 'restart.jsonl');
  await main([
    '--scenario', 'restart-reconcile', ...shared,
    '--output', restartFile,
  ], state.env);
  const [restarted] = await readRows(restartFile);
  assertIsolatedTerminal(restarted, 'complete');
  assert.equal(restarted.dashboardRestarted, true);
  assert.equal(restarted.storeReloaded, true);
  assert.equal(restarted.reconciledState, 'running');
  assert.notEqual(restarted.dashboardPidBeforeRestart, restarted.dashboardPidAfterRestart);
  assertStopped(restarted.dashboardPidBeforeRestart);

  const synthesisFile = path.join(state.receiptRunDir, 'synthesis.jsonl');
  const synthesisEventsFile = path.join(state.receiptRunDir, 'synthesis-events.jsonl');
  await main([
    '--scenario', 'synthesis-reconnect', ...shared,
    '--sse-output', synthesisEventsFile,
    '--output', synthesisFile,
  ], state.env);
  const [synthesis] = await readRows(synthesisFile);
  assertIsolatedTerminal(synthesis, 'complete');
  assert.equal(synthesis.coordinatorRestarted, true);
  assert.equal(synthesis.storeReloaded, true);
  assert.equal(synthesis.reattachedTerminal, true);
  assert.match(synthesis.generationMarker, /^generation-1-[a-f0-9]{24}$/);
  assert.deepEqual({
    provider: synthesis.providerTerminalStoreEvidence.provider,
    model: synthesis.providerTerminalStoreEvidence.model,
    providerCallId: synthesis.providerTerminalStoreEvidence.providerCallId,
    outcome: synthesis.providerTerminalStoreEvidence.outcome,
  }, {
    provider: 'controlled',
    model: 'controlled-synthesis',
    providerCallId: 'synthesis',
    outcome: 'complete',
  });
  const synthesisEvents = await readRows(synthesisEventsFile);
  assert.equal(new Set(synthesisEvents.map((event) =>
    `${event.operationId}:${event.eventSequence}`)).size, synthesisEvents.length);
  assert.ok(synthesisEvents.every((event) => event.streamAttachments.length >= 1));
  assert.ok(['operation-stream', 'durable-operation-store'].includes(
    synthesis.providerTerminalEvidenceSource,
  ));
  if (synthesis.providerTerminalEvidenceSource === 'durable-operation-store') {
    assert.equal(synthesisEvents.some((event) =>
      event.eventSequence === synthesis.providerTerminalStoreEvidence.eventSequence
        && event.type === 'provider_call_terminal'), false);
  }

  assert.equal(detached.isolatedStore, cancelled.isolatedStore);
  assert.equal(cancelled.isolatedStore, restarted.isolatedStore);
  assert.equal(restarted.isolatedStore, synthesis.isolatedStore);
  assert.ok((await fs.stat(restarted.isolatedStore)).isDirectory());
});
