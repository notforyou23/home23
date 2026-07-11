'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createResearchRunOperationAdapter,
} = require('../../cosmo23/server/lib/research-run-operation-adapter');

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeFixture(t, overrides = {}) {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-research-run-adapter-'));
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));

  const workspace = path.join(home23Root, 'instances', 'jerry', 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  const records = new Map();
  const calls = [];
  const statusQueue = [];
  const logQueue = [];
  let activeContext = null;
  let tick = 0;

  const clock = () => new Date(Date.UTC(2026, 6, 10, 12, 0, tick++)).toISOString();
  const clone = (value) => value == null ? value : structuredClone(value);

  const runManager = {
    async createRun(runId, options) {
      calls.push({ type: 'createRun', runId, options: clone(options) });
      await fs.mkdir(options.runPath, { recursive: true });
      return { success: true, runName: runId, path: options.runPath };
    },
  };

  const processManager = {
    async startMCPServer(port) {
      calls.push({ type: 'startMCPServer', port, record: clone(records.values().next().value) });
      return { success: true, port, pid: 101 };
    },
    async startMainDashboard(port) {
      calls.push({ type: 'startMainDashboard', port });
      return { success: true, port, pid: 102 };
    },
    async startCOSMO() {
      calls.push({ type: 'startCOSMO' });
      return { success: true, pid: 103 };
    },
    async stopAll() {
      calls.push({ type: 'stopAll' });
      return { success: true };
    },
    getStatus() {
      calls.push({ type: 'getStatus' });
      return clone(statusQueue.length > 0 ? statusQueue.shift() : {
        count: 3,
        running: [
          { name: 'mcp-http', pid: 101, killed: false },
          { name: 'main-dashboard', pid: 102, killed: false },
          { name: 'cosmo-main', pid: 103, killed: false },
        ],
      });
    },
    getLogs(options) {
      calls.push({ type: 'getLogs', options: clone(options) });
      return clone(logQueue.length > 0 ? logQueue.shift() : {
        logs: [], cursor: options.after || 0, total: 0,
      });
    },
  };

  const loadCanonicalRunMetadata = async (runRoot) => {
    calls.push({ type: 'loadMetadata', runRoot });
    return clone(records.get(runRoot) || null);
  };
  const writeCanonicalRunMetadataAtomic = async (runRoot, record) => {
    records.set(runRoot, clone(record));
    calls.push({ type: 'writeMetadata', runRoot, record: clone(record) });
  };

  const launchPreparedResearch = async (brain, payload, request) => {
    calls.push({ type: 'launchPreparedResearch', brain: clone(brain), payload: clone(payload), request });
    await processManager.startMCPServer(43147);
    await processManager.startMainDashboard(43144);
    await processManager.startCOSMO();
    activeContext = {
      runName: brain.name,
      runPath: brain.path,
      brainId: brain.id,
      topic: payload.topic,
      startedAt: clock(),
    };
    calls.push({ type: 'setActiveByLauncher', value: clone(activeContext) });
    return {
      success: true,
      runName: brain.name,
      brainId: brain.id,
      brainPath: brain.path,
      isContinuation: brain.hasState,
    };
  };

  const dependencies = {
    home23Root,
    runManager,
    processManager,
    launchPreparedResearch,
    getActiveContext: () => clone(activeContext),
    setActiveContext: (value) => {
      calls.push({ type: 'setActiveContext', value: clone(value) });
      activeContext = clone(value);
    },
    loadCanonicalRunMetadata,
    writeCanonicalRunMetadataAtomic,
    clock,
    resolveRequesterWorkspace: ({ requesterAgent }) =>
      path.join(home23Root, 'instances', requesterAgent, 'workspace'),
    stopPollIntervalMs: 0,
    stopWaitTimeoutMs: 1_000,
    ...overrides,
  };

  const adapter = createResearchRunOperationAdapter(dependencies);
  const runRoot = (runId, requesterAgent = 'jerry') => path.join(
    home23Root, 'instances', requesterAgent, 'workspace', 'research-runs', runId,
  );

  return {
    adapter,
    calls,
    records,
    statusQueue,
    logQueue,
    processManager,
    runManager,
    dependencies,
    home23Root,
    workspace,
    runRoot,
    get activeContext() { return clone(activeContext); },
    setActiveContext(value) { activeContext = clone(value); },
  };
}

async function createRun(fixture, overrides = {}) {
  return fixture.adapter.createOwnedRun({
    runId: 'research-brop_0123456789abcdef0123456789abcdef',
    ownerAgent: 'jerry',
    operationId: 'brop_0123456789abcdef0123456789abcdef',
    topic: 'Durable research run truth',
    parameters: {
      topic: 'Durable research run truth',
      context: 'Use exact source receipts.',
      cycles: 12,
      explorationMode: 'guided',
      analysisDepth: 'deep',
      maxConcurrent: 4,
      primaryProvider: 'openai', primaryModel: 'gpt-5.5',
      fastProvider: 'openai', fastModel: 'gpt-5-mini',
      strategicProvider: 'anthropic', strategicModel: 'claude-opus-4-8',
    },
    ...overrides,
  });
}

test('server index exports the prepared launcher used by the adapter', () => {
  const server = require('../../cosmo23/server/index.js');
  assert.equal(typeof server.launchPreparedResearch, 'function');
  assert.equal(server.launchPreparedResearch.length, 3);
});

test('create/start derives the owner run root, persists before spawn, and activates exact identity', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  const expectedRoot = fixture.runRoot(created.runId);

  assert.equal(created.canonicalRoot, expectedRoot);
  assert.equal(created.ownerAgent, 'jerry');
  assert.equal(created.state, 'starting');
  assert.equal(fixture.calls.find((call) => call.type === 'createRun').options.runPath, expectedRoot);
  assert.equal(fixture.calls.find((call) => call.type === 'createRun').options.owner, 'jerry');

  const launch = await fixture.adapter.start(created.runId);
  assert.equal(launch.runId, created.runId);
  assert.equal(launch.state, 'active');

  const firstStart = fixture.calls.findIndex((call) => call.type === 'startMCPServer');
  const startingWrite = fixture.calls.findIndex((call) =>
    call.type === 'writeMetadata' && call.record.state === 'starting');
  assert.ok(startingWrite >= 0 && startingWrite < firstStart);
  assert.equal(fixture.calls[firstStart].record.state, 'starting');

  const prepared = fixture.calls.find((call) => call.type === 'launchPreparedResearch');
  assert.equal(prepared.brain.name, created.runId);
  assert.equal(prepared.brain.path, expectedRoot);
  assert.equal(prepared.payload.runName, created.runId);
  assert.equal(prepared.payload.runRoot, expectedRoot);
  assert.equal(prepared.payload.owner, 'jerry');
  assert.equal(prepared.payload.enableWebSearch, true);
  assert.equal(prepared.payload.enableCodingAgents, false);
  assert.equal(prepared.payload.enableAgentRouting, true);
  assert.equal(prepared.payload.enableMemoryGovernance, true);

  const canonical = fixture.records.get(expectedRoot);
  assert.equal(canonical.state, 'active');
  assert.ok(canonical.createdAt);
  assert.ok(canonical.startedAt);
  assert.equal(canonical.runId, created.runId);
  assert.equal(canonical.ownerAgent, 'jerry');
  assert.equal(canonical.operationId, created.operationId);

  canonical.state = 'paused';
  canonical.pausedAt = '2026-07-10T12:30:00.000Z';
  fixture.records.set(expectedRoot, canonical);
  const reloaded = await fixture.adapter.resolveOwnedRun({
    runId: created.runId,
    requesterAgent: 'jerry',
  });
  assert.equal(reloaded.state, 'paused');
  assert.equal(reloaded.pausedAt, '2026-07-10T12:30:00.000Z');
});

test('create derives the durable operation ID from the executor run ID when omitted', async (t) => {
  const fixture = await makeFixture(t);
  const operationId = 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const created = await fixture.adapter.createOwnedRun({
    runId: `research-${operationId}`,
    ownerAgent: 'jerry',
    topic: 'Derived operation identity',
    parameters: { topic: 'Derived operation identity' },
  });
  assert.equal(created.operationId, operationId);
  assert.equal(fixture.records.get(fixture.runRoot(created.runId)).operationId, operationId);
});

test('create rejects resolver escape and symlink ancestors before run-manager mutation', async (t) => {
  const escaped = await makeFixture(t, {
    resolveRequesterWorkspace: ({ requesterAgent: _requesterAgent }) => path.join(os.tmpdir(), 'outside-home23'),
  });
  await assert.rejects(() => createRun(escaped), hasCode('run_path_escape'));
  assert.equal(escaped.calls.some((call) => call.type === 'createRun'), false);

  const symlinked = await makeFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-research-runs-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(symlinked.workspace, 'research-runs'), 'dir');
  await assert.rejects(() => createRun(symlinked), hasCode('run_path_symlink'));
  assert.equal(symlinked.calls.some((call) => call.type === 'createRun'), false);
});

test('launch failures and missing cosmo-main status become durable typed failures', async (t) => {
  const launchFailure = await makeFixture(t, {
    launchPreparedResearch: async () => {
      const record = launchFailure.records.values().next().value;
      launchFailure.calls.push({ type: 'launchSawState', state: record.state });
      const error = new Error('engine spawn failed');
      error.code = 'E_SPAWN';
      throw error;
    },
  });
  const failedRun = await createRun(launchFailure);
  await assert.rejects(() => launchFailure.adapter.start(failedRun.runId), hasCode('research_launch_failed'));
  const failedRecord = launchFailure.records.get(launchFailure.runRoot(failedRun.runId));
  assert.equal(failedRecord.state, 'failed');
  assert.equal(failedRecord.error.code, 'research_launch_failed');
  assert.match(failedRecord.error.message, /engine spawn failed/);
  assert.equal(launchFailure.calls.find((call) => call.type === 'launchSawState').state, 'starting');

  const earlyExit = await makeFixture(t);
  const earlyRun = await createRun(earlyExit);
  earlyExit.statusQueue.push({
    count: 2,
    running: [
      { name: 'mcp-http', pid: 101, killed: false },
      { name: 'main-dashboard', pid: 102, killed: false },
    ],
  });
  await assert.rejects(() => earlyExit.adapter.start(earlyRun.runId), hasCode('research_process_exit'));
  const exitedRecord = earlyExit.records.get(earlyExit.runRoot(earlyRun.runId));
  assert.equal(exitedRecord.state, 'failed');
  assert.equal(exitedRecord.error.code, 'research_process_exit');
});

test('watch durably fails the exact active run when cosmo-main exits after activation', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  await fixture.adapter.start(created.runId);
  fixture.statusQueue.push({
    count: 2,
    running: [
      { name: 'mcp-http', pid: 101, killed: false },
      { name: 'main-dashboard', pid: 102, killed: false },
    ],
  });

  const watched = await fixture.adapter.watch(created.runId, {
    after: 0,
    limit: 50,
    filter: 'all',
  });
  assert.equal(watched.state, 'failed');
  const canonical = fixture.records.get(fixture.runRoot(created.runId));
  assert.equal(canonical.state, 'failed');
  assert.equal(canonical.error.code, 'research_process_exit');
});

test('continue is state-gated, persists explicit overrides before launch, and preserves identity', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  const root = fixture.runRoot(created.runId);
  const completed = fixture.records.get(root);
  completed.state = 'completed';
  completed.completedAt = '2026-07-10T12:45:00.000Z';
  fixture.records.set(root, completed);

  await fixture.adapter.resolveOwnedRun({ runId: created.runId, requesterAgent: 'jerry' });
  const before = fixture.calls.length;
  const continued = await fixture.adapter.continue(created.runId, {
    context: 'Now verify the contradictory receipts.',
    cycles: 8,
    primaryProvider: 'openai',
    primaryModel: 'gpt-5.5',
  });
  assert.equal(continued.state, 'active');

  const continuationCalls = fixture.calls.slice(before);
  const startingWrite = continuationCalls.findIndex((call) =>
    call.type === 'writeMetadata' && call.record.state === 'starting');
  const firstStart = continuationCalls.findIndex((call) => call.type === 'startMCPServer');
  assert.ok(startingWrite >= 0 && startingWrite < firstStart);
  const persisted = continuationCalls[startingWrite].record;
  assert.equal(persisted.parameters.context, 'Now verify the contradictory receipts.');
  assert.equal(persisted.parameters.cycles, 8);
  assert.equal(persisted.runId, created.runId);
  assert.equal(persisted.ownerAgent, created.ownerAgent);
  assert.equal(persisted.operationId, created.operationId);

  const prepared = continuationCalls.find((call) => call.type === 'launchPreparedResearch');
  assert.equal(prepared.payload.context, 'Now verify the contradictory receipts.');
  assert.equal(prepared.payload.cycles, 8);

  const active = fixture.records.get(root);
  active.state = 'active';
  fixture.records.set(root, active);
  const launchesBefore = fixture.calls.filter((call) => call.type === 'launchPreparedResearch').length;
  await assert.rejects(
    () => fixture.adapter.continue(created.runId, { context: 'not allowed while active' }),
    hasCode('run_state_conflict'),
  );
  await assert.rejects(
    () => fixture.adapter.continue(created.runId, { owner: 'forrest' }),
    hasCode('invalid_request'),
  );
  assert.equal(fixture.calls.filter((call) => call.type === 'launchPreparedResearch').length, launchesBefore);
});

test('stop persists stopping, waits for actual child status, then persists stopped before clearing context', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  await fixture.adapter.start(created.runId);
  const before = fixture.calls.length;
  fixture.statusQueue.push(
    { count: 1, running: [{ name: 'cosmo-main', pid: 103, killed: false }] },
    { count: 0, running: [] },
  );

  const result = await fixture.adapter.stopAndWait(created.runId);
  assert.equal(result.terminal, true);
  assert.equal(result.state, 'stopped');
  assert.equal(fixture.activeContext, null);

  const stopCalls = fixture.calls.slice(before);
  const stoppingWrite = stopCalls.findIndex((call) =>
    call.type === 'writeMetadata' && call.record.state === 'stopping');
  const stopAll = stopCalls.findIndex((call) => call.type === 'stopAll');
  const stoppedWrite = stopCalls.findIndex((call) =>
    call.type === 'writeMetadata' && call.record.state === 'stopped');
  const clear = stopCalls.findIndex((call) => call.type === 'setActiveContext' && call.value === null);
  assert.ok(stoppingWrite >= 0 && stoppingWrite < stopAll);
  assert.ok(stopAll < stoppedWrite && stoppedWrite < clear);
  assert.equal(stopCalls.filter((call) => call.type === 'getStatus').length, 2);
});

test('stop cancellation never claims stopped or clears the exact active context', async (t) => {
  const controller = new AbortController();
  const stopGate = deferred();
  let fixture;
  fixture = await makeFixture(t, {
    processManager: {
      startMCPServer: async () => ({ success: true }),
      startMainDashboard: async () => ({ success: true }),
      startCOSMO: async () => ({ success: true }),
      stopAll: async () => {
        fixture.calls.push({ type: 'stopAll' });
        return stopGate.promise;
      },
      getStatus: () => ({ count: 0, running: [] }),
      getLogs: ({ after = 0 }) => ({ logs: [], cursor: after, total: 0 }),
    },
  });

  const created = await createRun(fixture);
  const root = fixture.runRoot(created.runId);
  const record = fixture.records.get(root);
  record.state = 'active';
  record.startedAt = '2026-07-10T12:10:00.000Z';
  fixture.records.set(root, record);
  fixture.setActiveContext({ runName: created.runId, runPath: root, brainId: created.runId });
  await fixture.adapter.resolveOwnedRun({ runId: created.runId, requesterAgent: 'jerry' });

  const stopping = fixture.adapter.stopAndWait(created.runId, { signal: controller.signal });
  for (let attempt = 0; attempt < 100
      && !fixture.calls.some((call) => call.type === 'stopAll'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.calls.some((call) => call.type === 'stopAll'), true);
  controller.abort(new DOMException('operator cancelled wait', 'AbortError'));
  const outcome = stopping.then(
    () => ({ state: 'resolved' }),
    (error) => ({ state: 'rejected', error }),
  );
  const promptOutcome = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve({ state: 'timeout' }), 50)),
  ]);
  stopGate.resolve({ success: true });
  assert.equal(promptOutcome.state, 'rejected');
  assert.equal(promptOutcome.error?.name, 'AbortError');
  assert.equal(fixture.records.get(root).state, 'stopping');
  assert.equal(fixture.activeContext.runName, created.runId);
  assert.equal(fixture.calls.some((call) =>
    call.type === 'writeMetadata' && call.record.state === 'stopped'), false);
  assert.equal(fixture.calls.some((call) =>
    call.type === 'setActiveContext' && call.value === null), false);
});

test('stop refuses an active-context mismatch before process mutation', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  const root = fixture.runRoot(created.runId);
  const record = fixture.records.get(root);
  record.state = 'active';
  fixture.records.set(root, record);
  fixture.setActiveContext({ runName: 'different-run', runPath: fixture.runRoot('different-run') });
  await fixture.adapter.resolveOwnedRun({ runId: created.runId, requesterAgent: 'jerry' });

  await assert.rejects(() => fixture.adapter.stopAndWait(created.runId), hasCode('run_state_conflict'));
  assert.equal(fixture.calls.some((call) => call.type === 'stopAll'), false);
  assert.equal(fixture.records.get(root).state, 'active');
});

test('watch keeps a bounded per-run ring, exact cursor/filter, and never substitutes the active run', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  await fixture.adapter.start(created.runId);

  fixture.logQueue.push({
    logs: [
      { id: 846, level: 'info', source: 'COSMO', message: 'Cycle 4 completed' },
      { id: 847, level: 'error', source: 'COSMO', message: 'provider failed' },
      { id: 848, level: 'info', source: 'COSMO', message: 'planning next cycle' },
    ],
    cursor: 848,
    total: 848,
  });
  const watched = await fixture.adapter.watch(created.runId, {
    after: 845,
    limit: 2,
    filter: 'errors',
  });
  assert.deepEqual(watched.logs.map((entry) => entry.id), [847]);
  assert.equal(watched.cursor, 848);
  assert.equal(watched.latest, 848);
  assert.equal(watched.state, 'active');

  const firstPage = await fixture.adapter.watch(created.runId, {
    after: 845,
    limit: 2,
    filter: 'all',
  });
  assert.deepEqual(firstPage.logs.map((entry) => entry.id), [846, 847]);
  assert.equal(firstPage.cursor, 847);
  const secondPage = await fixture.adapter.watch(created.runId, {
    after: firstPage.cursor,
    limit: 2,
    filter: 'all',
  });
  assert.deepEqual(secondPage.logs.map((entry) => entry.id), [848]);
  assert.equal(secondPage.cursor, 848);

  const root = fixture.runRoot(created.runId);
  const stopped = fixture.records.get(root);
  stopped.state = 'stopped';
  stopped.stoppedAt = '2026-07-10T13:00:00.000Z';
  fixture.records.set(root, stopped);
  fixture.setActiveContext({ runName: 'other-run', runPath: fixture.runRoot('other-run') });
  fixture.logQueue.push({
    logs: [{ id: 999, level: 'error', source: 'COSMO', message: 'other run secret' }],
    cursor: 999,
    total: 999,
  });
  const getLogsBefore = fixture.calls.filter((call) => call.type === 'getLogs').length;
  const exact = await fixture.adapter.watch(created.runId, {
    after: 848,
    limit: 50,
    filter: 'all',
  });
  assert.deepEqual(exact.logs, []);
  assert.equal(exact.cursor, 848);
  assert.equal(exact.state, 'stopped');
  assert.equal(fixture.calls.filter((call) => call.type === 'getLogs').length, getLogsBefore);
  assert.doesNotMatch(JSON.stringify(exact), /other run secret/);

  await assert.rejects(
    () => fixture.adapter.watch(created.runId, { after: 0, limit: 10_000, filter: 'all' }),
    hasCode('invalid_request'),
  );
});

test('per-run lock rejects concurrent lifecycle mutations without duplicate spawn or stale overwrite', async (t) => {
  const gate = deferred();
  let fixture;
  fixture = await makeFixture(t, {
    launchPreparedResearch: async (brain) => {
      fixture.calls.push({ type: 'launchPreparedResearch', brain: structuredClone(brain) });
      await gate.promise;
      fixture.setActiveContext({ runName: brain.name, runPath: brain.path, brainId: brain.id });
      return { success: true, runName: brain.name, brainId: brain.id, brainPath: brain.path };
    },
  });
  const created = await createRun(fixture);
  const first = fixture.adapter.start(created.runId);
  for (let attempt = 0; attempt < 100
      && !fixture.calls.some((call) => call.type === 'launchPreparedResearch'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.calls.some((call) => call.type === 'launchPreparedResearch'), true);

  await assert.rejects(() => fixture.adapter.start(created.runId), hasCode('run_state_conflict'));
  await assert.rejects(() => fixture.adapter.stopAndWait(created.runId), hasCode('run_state_conflict'));
  assert.equal(fixture.calls.filter((call) => call.type === 'launchPreparedResearch').length, 1);
  assert.equal(fixture.calls.some((call) => call.type === 'stopAll'), false);

  gate.resolve();
  await first;
  assert.equal(fixture.records.get(fixture.runRoot(created.runId)).state, 'active');
});

test('start refuses a different active run before invoking the prepared launcher', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  fixture.setActiveContext({
    runName: 'already-active',
    runPath: fixture.runRoot('already-active'),
    brainId: 'already-active',
  });

  await assert.rejects(() => fixture.adapter.start(created.runId), hasCode('run_state_conflict'));
  assert.equal(fixture.calls.some((call) => call.type === 'launchPreparedResearch'), false);
  assert.equal(fixture.records.get(fixture.runRoot(created.runId)).state, 'starting');
});

test('resolveOwnedRun rejects malformed selectors and ambiguous or foreign canonical ownership', async (t) => {
  const fixture = await makeFixture(t);
  const created = await createRun(fixture);
  const root = fixture.runRoot(created.runId);

  for (const selector of [
    {},
    { runId: '*' },
    { brainId: created.runId, requesterAgent: 'jerry' },
    { runId: created.runId, requesterAgent: 'jerry', extra: true },
  ]) {
    await assert.rejects(() => fixture.adapter.resolveOwnedRun(selector), hasCode('invalid_request'));
  }

  const missingOwner = fixture.records.get(root);
  missingOwner.ownerAgent = null;
  fixture.records.set(root, missingOwner);
  await assert.rejects(
    () => fixture.adapter.resolveOwnedRun({ runId: created.runId, requesterAgent: 'jerry' }),
    hasCode('run_owner_ambiguous'),
  );

  missingOwner.ownerAgent = 'forrest';
  fixture.records.set(root, missingOwner);
  await assert.rejects(
    () => fixture.adapter.resolveOwnedRun({ runId: created.runId, requesterAgent: 'jerry' }),
    hasCode('access_denied'),
  );

  missingOwner.ownerAgent = 'jerry';
  missingOwner.operationId = 'brop_ffffffffffffffffffffffffffffffff';
  fixture.records.set(root, missingOwner);
  await assert.rejects(
    () => fixture.adapter.resolveOwnedRun({ runId: created.runId, requesterAgent: 'jerry' }),
    hasCode('run_identity_mismatch'),
  );
  assert.equal(fixture.calls.some((call) => call.type === 'stopAll'), false);
  assert.equal(fixture.calls.some((call) => call.type === 'launchPreparedResearch'), false);
});
