const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { canonicalJson } = require('../../shared/brain-operations/canonical-json.cjs');

const FIXTURE_METRIC_SEMANTICS = Object.freeze({
  v8HeapUsedBytes: 'request-time-sample',
  rssBytes: 'request-time-sample',
  processMaxRssBytes: 'process-lifetime-high-water',
});

function operation(overrides = {}) {
  const state = overrides.state || 'complete';
  return {
    operationId: overrides.operationId || 'op_acceptance_0001',
    requestId: 'request-acceptance',
    operationType: overrides.operationType || 'query',
    requestParameters: { query: 'authoritative canary' },
    parameters: { query: 'authoritative canary' },
    canonicalEvidence: true,
    recordVersion: overrides.eventSequence ?? 2,
    eventSequence: overrides.eventSequence ?? 2,
    requesterAgent: 'jerry',
    target: { domain: 'brain', brainId: 'brain-jerry', ownerAgent: 'jerry', accessMode: 'own' },
    state,
    phase: state === 'running' ? 'provider' : state,
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:02.000Z',
    completedAt: ['queued', 'running'].includes(state) ? null : '2026-07-10T00:00:02.000Z',
    lastProviderActivityAt: '2026-07-10T00:00:02.000Z',
    lastProgressAt: '2026-07-10T00:00:01.000Z',
    result: overrides.result ?? {
      answer: 'authoritative answer',
      metadata: { provider: 'fixture-provider', model: 'fixture-model' },
    },
    resultHandle: ['queued', 'running'].includes(state) ? null : 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    resultArtifact: null,
    error: overrides.error ?? null,
    sourceEvidence: overrides.sourceEvidence ?? {
      sourceHealth: 'healthy',
      matchOutcome: 'matches',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 1, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourcePinReleasedAt: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    metadataExpiresAt: null,
    attachmentState: 'closed',
    ...overrides,
  };
}

function envelope(value) {
  return {
    operationId: value.operationId,
    state: value.state,
    result: value.result,
    resultHandle: value.resultHandle,
    resultArtifact: value.resultArtifact,
    error: value.error,
    sourceEvidence: value.sourceEvidence,
  };
}

function notification(value, type = value.state === 'running' ? 'progress' : 'terminal') {
  return {
    type,
    operationId: value.operationId,
    eventSequence: value.eventSequence,
    sequence: value.eventSequence,
    at: value.updatedAt,
    state: value.state,
    phase: value.phase,
    updatedAt: value.updatedAt,
    lastProviderActivityAt: value.lastProviderActivityAt,
    lastProgressAt: value.lastProgressAt,
  };
}

function providerTerminal(value, overrides = {}) {
  return {
    operationId: value.operationId,
    type: 'provider_call_terminal',
    eventSequence: overrides.eventSequence ?? 4,
    phase: overrides.phase ?? value.operationType,
    provider: overrides.provider ?? 'fixture-provider',
    model: overrides.model ?? 'fixture-model',
    providerCallId: overrides.providerCallId ?? value.operationType,
    outcome: overrides.outcome ?? 'complete',
    ...overrides,
  };
}

async function fixture(authority = 'live') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-live-smoke-')));
  const receiptRunDir = path.join(root, 'receipt-run');
  const isolatedStore = path.join(root, 'isolated-store');
  await fs.mkdir(receiptRunDir, { mode: 0o700 });
  await fs.mkdir(isolatedStore, { mode: 0o700 });
  await fs.writeFile(path.join(receiptRunDir, 'run-authority.json'), `${JSON.stringify({
    schemaVersion: 1,
    receiptRunId: 'brain-smoke-fixture',
    authority: 'live',
    implementationCommit: 'a'.repeat(40),
    expectedLiveTree: 'b'.repeat(40),
    actualLiveTree: 'b'.repeat(40),
    hostname: 'fixture-host',
    startedAt: '2026-07-10T00:00:00.000Z',
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const context = await receiptContext({
    'receipt-run-dir': receiptRunDir,
    'receipt-run-id': 'brain-smoke-fixture',
    authority,
  }, {}, { startedAt: '2026-07-10T00:00:00.000Z' });
  const liveContext = authority === 'live' ? context : await receiptContext({
    'receipt-run-dir': receiptRunDir,
    'receipt-run-id': 'brain-smoke-fixture',
    authority: 'live',
  }, {}, { startedAt: '2026-07-10T00:00:00.000Z' });
  const isolatedContext = authority === 'isolated-controlled' ? context : await receiptContext({
    'receipt-run-dir': receiptRunDir,
    'receipt-run-id': 'brain-smoke-fixture',
    authority: 'isolated-controlled',
  }, {}, { startedAt: '2026-07-10T00:00:00.000Z' });
  return {
    root,
    isolatedStore,
    context,
    liveContext,
    isolatedContext,
  };
}

const REQUIRED_GUARDED_PM2_TRANSACTIONS = Object.freeze([
  Object.freeze({
    mode: 'dry-run',
    transactionId: '11111111-1111-4111-8111-111111111111',
    resultBasename: 'guarded-pm2-save-dry-run.json',
  }),
  Object.freeze({
    mode: 'apply',
    transactionId: '22222222-2222-4222-8222-222222222222',
    resultBasename: 'guarded-pm2-save-apply.json',
  }),
]);

async function writeGuardedPm2Transaction(state, {
  mode,
  transactionId,
  resultBasename,
} = {}) {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const live = path.join(state.context.receiptRunDir, 'live');
  const backups = path.join(state.context.receiptRunDir, 'backups');
  await fs.mkdir(live, { recursive: true, mode: 0o700 });
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  const outputPath = path.join(live, resultBasename);
  const intentBasename = `.${resultBasename}.${transactionId}.guarded-pm2-intent.json`;
  const dumpPath = path.join(state.root, 'dump.pm2');
  const dumpBytes = Buffer.from('[{"name":"home23-jerry"}]\n');
  try {
    await fs.writeFile(dumpPath, dumpBytes, { flag: 'wx', mode: 0o640 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const backupBasename = `dump.pm2.${transactionId}.bak`;
  const backupPath = path.join(backups, backupBasename);
  await fs.writeFile(backupPath, dumpBytes, { flag: 'wx', mode: 0o600 });
  const [dumpStat, backupStat] = await Promise.all([
    fs.stat(dumpPath, { bigint: true }),
    fs.stat(backupPath, { bigint: true }),
  ]);
  const fileIdentity = (file, stat) => ({
    path: file,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    nlink: stat.nlink.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o777n),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
  const originalSha256 = createHash('sha256').update(dumpBytes).digest('hex');
  const processRow = {
    name: 'home23-jerry', status: 'online', pid: 101, restarts: 0,
    script: path.join(state.root, 'engine.js'), cwd: state.root,
  };
  const table = [processRow];
  const common = {
    helper: 'guarded-pm2-save',
    transactionId,
    transactionState: 'committed',
    mode,
    dumpPath,
    outputPath,
    ok: true,
    pm2SaveInvoked: mode === 'apply',
    applied: mode === 'apply',
    restored: false,
    restorationVerified: false,
    errorCode: null,
    backupBasename,
  };
  const result = await writeJsonReceipt(state.context, outputPath, {
    ...common,
    backupPath,
    backupMode: '0600',
    backupCreatedExclusively: true,
    backupSha256: originalSha256,
    backupIdentity: fileIdentity(backupPath, backupStat),
    originalMode: '0640',
    originalSha256,
    originalIdentity: fileIdentity(dumpPath, dumpStat),
    allowChanged: ['home23-jerry'],
    expectedConfigured: ['home23-jerry'],
    ecosystemIdentity: table,
    liveTable: table,
    liveModules: [],
    moduleRowsExcluded: true,
    moduleRowsFrozen: true,
    unrelatedRestartBaselineMonotonic: true,
    unrelatedRowsFrozen: true,
    restartBaseline: [],
    unrelatedRestartBaselines: [],
    dumpTableBefore: table,
    dumpTableAfter: mode === 'apply' ? table : null,
    ...(mode === 'apply' ? {
      ecosystemAuthorityReloaded: true,
      immediatePreSaveTableRevalidated: true,
      dumpSha256After: originalSha256,
    } : {}),
    receiptKind: 'guarded-pm2-save-result',
    transactionRole: 'result',
    transactionIntentBasename: intentBasename,
    receiptPublicationVerified: true,
  });
  await writeJsonReceipt(state.context, path.join(live, intentBasename), {
    ...common,
    receiptKind: 'guarded-pm2-save-intent',
    transactionRole: 'intent',
    outputArtifactSha256: result.artifactSha256,
  });
  return { outputPath, intentBasename, result };
}

async function writeRequiredGuardedPm2Transactions(state) {
  for (const transaction of REQUIRED_GUARDED_PM2_TRANSACTIONS) {
    await writeGuardedPm2Transaction(state, transaction);
  }
}

async function operationReceiptInventory(state) {
  const inventory = [];
  async function walk(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      let text;
      try { text = await fs.readFile(candidate, 'utf8'); }
      catch { continue; }
      let rows;
      try {
        const parsed = JSON.parse(text);
        rows = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed] : [];
      } catch {
        try {
          rows = text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        } catch { rows = []; }
      }
      for (const row of rows) {
        if (row?.receiptKind === 'operation-terminal'
            && typeof row.operationId === 'string') {
          inventory.push({
            row,
            receipt: path.relative(state.context.receiptRunDir, candidate),
          });
        }
      }
    }
  }
  await walk(state.context.receiptRunDir);
  return inventory;
}

async function writeOperationIdentityManifest(state, { addMissingGroups = true } = {}) {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const missing = async (authority, requesterAgent, suffix) => {
    const context = authority === 'live' ? state.liveContext : state.isolatedContext;
    const directory = path.join(state.context.receiptRunDir, authority);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await writeJsonReceipt(context, path.join(directory, `seal-${requesterAgent}.json`), {
      helper: 'fixture', receiptKind: 'operation-terminal',
      operationId: `brop_${suffix.repeat(32)}`, operationType: 'search', state: 'complete',
      requesterAgent, protectedResultRead: true,
      authorizedEndpoint: authority === 'live'
        ? `http://127.0.0.1:${requesterAgent === 'jerry' ? '5002' : '5012'}`
        : null,
      isolatedStore: authority === 'isolated-controlled' ? state.isolatedStore : null,
    });
  };
  if (addMissingGroups) {
    let inventory = await operationReceiptInventory(state);
    if (!inventory.some(({ row }) => row.authority === 'live' && row.requesterAgent === 'jerry')) {
      await missing('live', 'jerry', 'q');
    }
    inventory = await operationReceiptInventory(state);
    if (!inventory.some(({ row }) => row.authority === 'live' && row.requesterAgent === 'forrest')) {
      await missing('live', 'forrest', 'r');
    }
    inventory = await operationReceiptInventory(state);
    if (!inventory.some(({ row }) => row.authority === 'isolated-controlled')) {
      await missing('isolated-controlled', 'fixture-agent', 's');
    }
  }
  const inventory = await operationReceiptInventory(state);
  const groups = { jerryLive: [], forrestLive: [], isolatedControlled: [] };
  for (const { row, receipt } of inventory.sort(
    (left, right) => left.row.operationId.localeCompare(right.row.operationId),
  )) {
    const group = row.authority === 'isolated-controlled'
      ? 'isolatedControlled'
      : row.requesterAgent === 'jerry' ? 'jerryLive'
        : row.requesterAgent === 'forrest' ? 'forrestLive' : null;
    if (!group) continue;
    groups[group].push({
      operationId: row.operationId,
      authority: row.authority,
      requesterAgent: row.requesterAgent,
      receipt,
      isolatedStore: row.isolatedStore ?? null,
      authorizedEndpoint: row.authorizedEndpoint ?? null,
    });
  }
  await fs.writeFile(
    path.join(state.context.receiptRunDir, 'operation-identity-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      receiptRunId: state.context.receiptRunId,
      authorities: ['live', 'isolated-controlled'],
      auditRoot: state.context.receiptRunDir,
      createdAt: '2026-07-10T00:00:03.000Z',
      groups,
    }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

async function writeFixtureMetric(file, {
  role,
  pid,
  updatedAt,
  restartCount = 0,
} = {}) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({
    schemaVersion: 2,
    role,
    pid,
    restartCount,
    v8HeapUsedMiB: 32,
    rssMiB: 64,
    processMaxRssMiB: 96,
    semantics: FIXTURE_METRIC_SEMANTICS,
    updatedAt,
  })}\n`, { flag: 'wx' });
  await fs.rename(temporary, file);
}

function attachmentEvidence({
  detachedId = 'attachment-a',
  survivorId = 'attachment-b',
  detachedState = 'detached',
  detachedReason = 'transport_disconnect',
  survivorState = 'attached',
  survivorReason = survivorState === 'closed' ? 'operation_terminal' : null,
} = {}) {
  const entries = [
    { attachmentId: detachedId, state: detachedState, reason: detachedReason },
    { attachmentId: survivorId, state: survivorState, reason: survivorReason },
  ].sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  return {
    total: entries.length,
    attached: entries.filter((entry) => entry.state === 'attached').length,
    detached: entries.filter((entry) => entry.state === 'detached').length,
    closed: entries.filter((entry) => entry.state === 'closed').length,
    attachmentIds: entries.map((entry) => entry.attachmentId),
    entries,
  };
}

async function writeFixtureMetric(file, {
  role,
  pid,
  updatedAt,
  restartCount = 0,
} = {}) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({
    schemaVersion: 2,
    role,
    pid,
    restartCount,
    v8HeapUsedMiB: 32,
    rssMiB: 64,
    processMaxRssMiB: 96,
    semantics: FIXTURE_METRIC_SEMANTICS,
    updatedAt,
  })}\n`, { flag: 'wx' });
  await fs.rename(temporary, file);
}

function attachmentEvidence({
  detachedId = 'attachment-a',
  survivorId = 'attachment-b',
  detachedState = 'detached',
  detachedReason = 'transport_disconnect',
  survivorState = 'attached',
  survivorReason = survivorState === 'closed' ? 'operation_terminal' : null,
} = {}) {
  const entries = [
    { attachmentId: detachedId, state: detachedState, reason: detachedReason },
    { attachmentId: survivorId, state: survivorState, reason: survivorReason },
  ].sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  return {
    total: entries.length,
    attached: entries.filter((entry) => entry.state === 'attached').length,
    detached: entries.filter((entry) => entry.state === 'detached').length,
    closed: entries.filter((entry) => entry.state === 'closed').length,
    attachmentIds: entries.map((entry) => entry.attachmentId),
    entries,
  };
}

async function canaryReceipt(state, authority = state.context.authority, overrides = {}) {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const suffix = overrides.sourceHealth === 'degraded' ? '-degraded' : '';
  const file = path.join(state.context.receiptRunDir, `canary-${authority}${suffix}.json`);
  const sourceEvidence = overrides.sourceEvidence ?? {
    sourceHealth: 'healthy', matchOutcome: 'matches',
    deltaWatermark: { revision: 7 },
    authoritativeTotals: { nodes: 140_086, edges: 456_709 },
    returnedTotals: { nodes: 1, edges: 0 },
    selectedBrain: 'brain-jerry',
  };
  const row = canonicalReceiptRow({ ...state.context, authority }, {
    helper: 'live-brain-tools-smoke',
    scenario: 'discover-canary',
    receiptKind: 'operation-terminal',
    operationId: 'op_canary_0001',
    operationType: 'search',
    state: 'complete',
    protectedResultRead: true,
    requesterAgent: 'jerry',
    authorizedEndpoint: authority === 'live' ? 'http://fixture' : null,
    isolatedStore: authority === 'live' ? null : state.isolatedStore,
    query: 'authoritative canary',
    nodeId: 'n-canary',
    sourceRevision: 7,
    sourceHealth: overrides.sourceHealth ?? sourceEvidence.sourceHealth,
    selectedBrain: 'brain-jerry',
    sourceEvidence,
  });
  await fs.writeFile(file, `${JSON.stringify(row)}\n`);
  return file;
}

test('production client and real brain_query tool survive SSE progress, EOF reconnect, and terminal readback', async (t) => {
  const {
    QUERY_WAIT_MS,
    PGS_WAIT_MS,
    createClientOptions,
    loadProductionModules,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const activities = [];
  const queued = operation({ state: 'queued', eventSequence: 0, result: null, sourceEvidence: null });
  const running = operation({ state: 'running', eventSequence: 1, result: null });
  const terminal = operation();
  let eventCalls = 0;
  let statusCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === 'POST') return new Response(JSON.stringify(queued));
    if (parsed.pathname.endsWith('/result')) return new Response(JSON.stringify(envelope(terminal)));
    if (parsed.pathname.endsWith('/events')) {
      eventCalls += 1;
      const value = eventCalls === 1 ? running : terminal;
      return new Response(`data: ${JSON.stringify(notification(value))}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (parsed.pathname.endsWith(`/${terminal.operationId}`)) {
      statusCalls += 1;
      return new Response(JSON.stringify(eventCalls >= 2 ? terminal : running));
    }
    return new Response('', { status: 404 });
  };
  const options = createClientOptions({
    baseUrl: 'http://fixture', callerAgent: 'jerry', values: {}, fetchImpl,
    onActivity: (activity) => activities.push(activity),
  });
  assert.equal(options.queryWaitMs, 5_400_000);
  assert.equal(options.pgsWaitMs, 21_600_000);
  assert.equal(options.queryWaitMs, QUERY_WAIT_MS);
  assert.equal(options.pgsWaitMs, PGS_WAIT_MS);
  const client = new modules.BrainOperationsClient({ ...options, reconnectDelayMs: 1 });
  const controller = new AbortController();
  const result = await modules.brainQueryTool.execute({ query: 'authoritative canary' }, {
    turnRuntime: {
      turnId: 'acceptance-turn', abortController: controller,
      signal: controller.signal, brainOperations: client, onOperationActivity() {},
    },
    brainOperations: client,
    agentName: 'jerry',
  });
  assert.equal(result.is_error, undefined);
  assert.equal(result.metadata.operationId, terminal.operationId);
  assert.equal(result.metadata.state, 'complete');
  assert.equal(eventCalls, 2);
  assert.ok(statusCalls >= 2);
  assert.deepEqual(activities.map((entry) => entry.sequence), [1, 2]);
});

test('large pinned PGS partial retains canonical null-answer sweep outputs and exact source revision', async (t) => {
  const { executeScenario, loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const canary = await canaryReceipt(state);
  const sweepOutputs = Array.from({ length: 128 }, (_, index) => ({
    workUnitId: `work-${String(index).padStart(3, '0')}`,
    partitionId: `partition-${String(index).padStart(3, '0')}`,
    output: `bounded sweep evidence ${index}`,
    provider: 'fixture-provider',
    model: 'fixture-model',
  }));
  const partial = operation({
    operationType: 'pgs',
    state: 'partial',
    sourcePinDescriptor: { version: 1, sourceRevision: 7, digest: 'pin-descriptor' },
    sourcePinDigest: `sha256:${'b'.repeat(64)}`,
    result: {
      answer: null,
      sweepOutputs,
      metadata: { pgs: { successfulSweeps: sweepOutputs.length, retryablePartitions: ['retry-001'] } },
    },
    error: { code: 'provider_partial', message: 'one partition remains retryable', retryable: true },
  });
  const detachedClientFor = (terminal) => ({
    async launchQuery() {
      return {
        ...terminal,
        state: 'running',
        attachmentState: 'detached',
        completedAt: null,
        result: null,
        error: null,
      };
    },
    async resumeOperation() { return terminal; },
    async inspectOperation() { return terminal; },
  });
  const client = detachedClientFor(partial);
  const row = await executeScenario({
    scenario: 'pgs', modules, client,
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      ...sweepOutputs.map((sweep, index) => providerTerminal(partial, {
        eventSequence: index + 1,
        phase: 'pgs_sweep',
        providerCallId: `pgs:${sweep.workUnitId}`,
        workUnitId: sweep.workUnitId,
        partitionId: sweep.partitionId,
        provider: sweep.provider,
        model: sweep.model,
      })),
      providerTerminal(partial, {
        eventSequence: sweepOutputs.length + 1,
        phase: 'pgs_synthesis',
        providerCallId: 'pgs:synthesis',
        outcome: 'failed',
      }),
    ],
  });
  assert.equal(row.state, 'partial');
  assert.equal(row.startedAt, partial.startedAt);
  assert.equal(row.completedAt, partial.completedAt);
  assert.equal(row.result.answerPresent, false);
  assert.equal(row.result.sweepOutputCount, 128);
  assert.equal(row.result.sweepOutputs.length, 128);
  assert.match(row.result.sweepOutputs[0].outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(row.result.metadata.pgs.successfulSweeps, 128);
  assert.equal(row.sourceRevision, 7);
  assert.equal(row.providerTerminalValidated, true);
  assert.equal(row.authoritativeNodeCount, 140_086);
  assert.equal(row.sourcePinDescriptor.sourceRevision, 7);
  assert.match(row.sourcePinDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(row.liveProviderLargePgsGatePassed, true);

  await assert.rejects(executeScenario({
    scenario: 'pgs', modules, client,
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      ...sweepOutputs.map((sweep, index) => providerTerminal(partial, {
        eventSequence: index + 1,
        phase: 'pgs_sweep',
        providerCallId: `pgs:${sweep.workUnitId}`,
        workUnitId: sweep.workUnitId,
        partitionId: sweep.partitionId,
        provider: sweep.provider,
        model: sweep.model,
      })),
      providerTerminal(partial, {
        eventSequence: sweepOutputs.length + 1,
        phase: 'pgs_synthesis',
        providerCallId: 'pgs:synthesis',
        provider: 'wrong-synthesis-provider',
        model: 'wrong-synthesis-model',
        outcome: 'failed',
      }),
    ],
  }), (error) => error.code === 'provider_terminal_unproven');

  for (const outcome of ['cancelled', 'aborted']) {
    await assert.rejects(executeScenario({
      scenario: 'pgs', modules, client,
      values: {
        'canary-receipt': canary,
        'target-brain': 'brain-jerry',
        'require-authoritative-nodes': '100000',
        'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
        'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      },
      context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
      signal: new AbortController().signal,
      activityLog: [
        ...sweepOutputs.map((sweep, index) => providerTerminal(partial, {
          eventSequence: index + 1,
          phase: 'pgs_sweep',
          providerCallId: `pgs:${sweep.workUnitId}`,
          workUnitId: sweep.workUnitId,
          partitionId: sweep.partitionId,
          provider: sweep.provider,
          model: sweep.model,
        })),
        providerTerminal(partial, {
          eventSequence: sweepOutputs.length + 1,
          phase: 'pgs_synthesis',
          providerCallId: 'pgs:synthesis',
          outcome,
        }),
      ],
    }), (error) => error.code === 'provider_terminal_unproven');
  }

  await assert.rejects(executeScenario({
    scenario: 'pgs', modules, client,
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      ...sweepOutputs.map((sweep, index) => providerTerminal(partial, {
        eventSequence: index + 1,
        phase: 'pgs_sweep',
        providerCallId: `pgs:${sweep.workUnitId}`,
        workUnitId: sweep.workUnitId,
        partitionId: sweep.partitionId,
        provider: sweep.provider,
        model: sweep.model,
      })),
      providerTerminal(partial, {
        eventSequence: sweepOutputs.length + 1,
        phase: 'pgs_synthesis',
        providerCallId: 'pgs:synthesis',
        outcome: 'failed',
      }),
    ],
  }), (error) => error.code === 'invalid_request');

  const degradedCanary = await canaryReceipt(state, state.context.authority, {
    sourceHealth: 'degraded',
    sourceEvidence: {
      sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'matches',
      implementation: 'legacy-resident-sidecar-projection',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 1, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
  });
  const [degradedSweep] = sweepOutputs;
  const degradedPartial = operation({
    ...partial,
    operationId: 'op_pgs_degraded_pinned_0001',
    sourceEvidence: {
      sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'unknown',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 0, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
    result: {
      answer: null,
      sweepOutputs: [degradedSweep],
      metadata: { pgs: { successfulSweeps: 1, retryablePartitions: ['retry-legacy'] } },
    },
  });
  const degradedEvents = [
    providerTerminal(degradedPartial, {
      eventSequence: 1,
      phase: 'pgs_sweep',
      providerCallId: `pgs:${degradedSweep.workUnitId}`,
      workUnitId: degradedSweep.workUnitId,
      partitionId: degradedSweep.partitionId,
      provider: degradedSweep.provider,
      model: degradedSweep.model,
    }),
    providerTerminal(degradedPartial, {
      eventSequence: 2,
      phase: 'pgs_synthesis',
      providerCallId: 'pgs:synthesis',
      outcome: 'failed',
    }),
  ];
  await assert.rejects(executeScenario({
    scenario: 'pgs', modules,
    client: detachedClientFor(degradedPartial),
    values: {
      'canary-receipt': degradedCanary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: degradedEvents,
  }), (error) => error.code === 'source_evidence_not_useful');

  const duplicateSweepPartial = operation({
    ...partial,
    operationId: 'op_pgs_duplicate_sweep_0001',
    result: {
      answer: null,
      sweepOutputs: [degradedSweep, { ...degradedSweep, output: 'duplicate receipt row' }],
      metadata: { pgs: { successfulSweeps: 2, retryablePartitions: ['retry-duplicate'] } },
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'pgs', modules,
    client: detachedClientFor(duplicateSweepPartial),
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      providerTerminal(duplicateSweepPartial, {
        eventSequence: 1,
        phase: 'pgs_sweep',
        providerCallId: `pgs:${degradedSweep.workUnitId}`,
        workUnitId: degradedSweep.workUnitId,
        partitionId: degradedSweep.partitionId,
      }),
      providerTerminal(duplicateSweepPartial, {
        eventSequence: 2,
        phase: 'pgs_synthesis',
        providerCallId: 'pgs:synthesis',
        outcome: 'failed',
      }),
    ],
  }), (error) => error.code === 'provider_terminal_unproven');

  await assert.rejects(executeScenario({
    scenario: 'pgs', modules,
    client: detachedClientFor({ ...degradedPartial, sourceEvidence: {
      ...degradedPartial.sourceEvidence, deltaWatermark: { revision: 8 },
    } }),
    values: {
      'canary-receipt': degradedCanary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: degradedEvents,
  }), (error) => error.code === 'canary_source_revision_mismatch');

  await assert.rejects(executeScenario({
    scenario: 'pgs', modules, client,
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [{
      operationId: partial.operationId,
      type: 'provider_call_terminal',
      eventSequence: 9,
    }],
  }), (error) => error.code === 'provider_terminal_unproven');
  await assert.rejects(executeScenario({
    scenario: 'pgs', modules, client,
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [],
  }), (error) => error.code === 'provider_terminal_unproven');
});

test('SSE receipts preserve production event type and monotonic eventSequence', async (t) => {
  const {
    createActivityCollector,
    flushActivity,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const output = path.join(state.context.receiptRunDir, 'pgs-events.jsonl');
  await flushActivity(state.context, output, [
    {
      source: 'brain_operation', operationId: 'op_pgs_events', type: 'progress',
      eventSequence: 1, sequence: 1, state: 'running', phase: 'sweep',
      updatedAt: '2026-07-10T00:00:01.000Z', lastProviderActivityAt: null,
      lastProgressAt: '2026-07-10T00:00:01.000Z',
    },
    {
      source: 'brain_operation', operationId: 'op_pgs_events', type: 'heartbeat',
      eventSequence: 2, sequence: 2, state: 'running', phase: 'synthesize',
      updatedAt: '2026-07-10T00:00:02.000Z', lastProviderActivityAt: '2026-07-10T00:00:02.000Z',
      lastProgressAt: '2026-07-10T00:00:01.000Z',
    },
  ], 'jerry', 'pgs', 'live');
  const rows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(({ type, eventSequence }) => ({ type, eventSequence })), [
    { type: 'progress', eventSequence: 1 },
    { type: 'heartbeat', eventSequence: 2 },
  ]);
  assert.equal(rows.some((row) => Object.hasOwn(row, 'sequence')), false);
  assert.deepEqual(rows.map((row) => row.lastProgressAt), [
    '2026-07-10T00:00:01.000Z',
    '2026-07-10T00:00:01.000Z',
  ]);

  const collector = createActivityCollector({ maxEvents: 4 });
  const replay = {
    source: 'brain_operation', operationId: 'op_attachment_replay', type: 'progress',
    eventSequence: 1, sequence: 1, state: 'running', phase: 'provider',
    updatedAt: '2026-07-10T00:00:01.000Z', lastProviderActivityAt: null,
    lastProgressAt: '2026-07-10T00:00:01.000Z',
  };
  collector.listener('primary')(replay);
  collector.listener('survivor')({ ...replay });
  assert.equal(collector.events.length, 1);
  assert.deepEqual(collector.events[0].observedAttachments, ['primary', 'survivor']);
  assert.deepEqual(collector.summary('op_attachment_replay'), {
    uniqueEvents: 1,
    duplicateDeliveries: 1,
    attachments: [
      { attachment: 'primary', observations: 1 },
      { attachment: 'survivor', observations: 1 },
    ],
  });
  assert.throws(
    () => collector.listener('conflicting')({ ...replay, type: 'terminal' }),
    (error) => error.code === 'operation_event_identity_conflict',
  );
  const payloadReplay = {
    ...replay,
    eventSequence: 2,
    sequence: 2,
    tokenDelta: { text: 'first authenticated payload' },
  };
  collector.listener('primary')(payloadReplay);
  assert.throws(
    () => collector.listener('survivor')({
      ...payloadReplay,
      tokenDelta: { text: 'conflicting authenticated payload' },
    }),
    (error) => error.code === 'operation_event_identity_conflict',
  );
  const sequenceReplay = {
    ...replay,
    eventSequence: 3,
    sequence: 3,
  };
  collector.listener('primary')(sequenceReplay);
  assert.throws(
    () => collector.listener('survivor')({ ...sequenceReplay, sequence: 99 }),
    (error) => error.code === 'operation_event_identity_conflict',
  );
  collector.listener('other-operation')({
    ...replay,
    operationId: 'op_other_attachment',
  });
  assert.deepEqual(collector.summary('op_attachment_replay').attachments, [
    { attachment: 'primary', observations: 3 },
    { attachment: 'survivor', observations: 1 },
  ]);

  const eventBytes = Buffer.byteLength(JSON.stringify(replay), 'utf8');
  const byteBounded = createActivityCollector({
    maxEvents: 10,
    maxEventBytes: eventBytes + 16,
    maxRetainedBytes: eventBytes + 16,
  });
  byteBounded.add(replay);
  assert.throws(
    () => byteBounded.add({ ...replay, eventSequence: 2, sequence: 2 }),
    (error) => error.code === 'operation_activity_bytes_exceeded',
  );
  assert.throws(
    () => createActivityCollector({
      maxEvents: 10,
      maxEventBytes: 128,
      maxRetainedBytes: 1024,
    }).add({ ...replay, oversized: 'x'.repeat(1024) }),
    (error) => error.code === 'operation_activity_event_too_large',
  );
  const dedupedOutput = path.join(state.context.receiptRunDir, 'deduped-events.jsonl');
  await flushActivity(
    state.context,
    dedupedOutput,
    collector.events,
    'jerry',
    'detach-reattach',
    'live',
  );
  const [deduped] = (await fs.readFile(dedupedOutput, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(deduped.streamAttachments, ['primary', 'survivor']);
  await assert.rejects(
    flushActivity(
      state.context,
      path.join(state.context.receiptRunDir, 'duplicate-events.jsonl'),
      [replay, { ...replay }],
      'jerry',
      'detach-reattach',
      'live',
    ),
    (error) => error.code === 'operation_event_out_of_order',
  );
});

test('HTTP, receipt, and memory evidence readers remain bounded before parse', async (t) => {
  const {
    createBoundedMetricAccumulator,
    readReceiptRows,
    readResponseJsonBounded,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));

  const oversizedReceipt = path.join(state.context.receiptRunDir, 'oversized.json');
  const handle = await fs.open(oversizedReceipt, 'wx');
  await handle.truncate(32 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(
    readReceiptRows(oversizedReceipt),
    (error) => error.code === 'receipt_invalid',
  );
  const response = new Response('12345', {
    headers: { 'content-type': 'application/json', 'content-length': '5' },
  });
  await assert.rejects(
    readResponseJsonBounded(response, { maxBytes: 4, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  let advertisedBodyCancelled = false;
  await assert.rejects(
    readResponseJsonBounded({
      headers: { get: () => '5' },
      body: {
        async cancel() { advertisedBodyCancelled = true; },
        getReader() { throw new Error('oversized body must not be opened'); },
      },
    }, { maxBytes: 4, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  assert.equal(advertisedBodyCancelled, true);
  let synchronousBodyCancelled = false;
  await assert.rejects(
    readResponseJsonBounded({
      headers: { get: () => '5' },
      body: {
        cancel() { synchronousBodyCancelled = true; },
        getReader() { throw new Error('oversized body must not be opened'); },
      },
    }, { maxBytes: 4, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  assert.equal(synchronousBodyCancelled, true);
  await assert.rejects(
    readResponseJsonBounded({ headers: { get: () => null }, body: {} }, {
      maxBytes: 4,
      errorCode: 'bounded_http_test',
    }),
    (error) => error.code === 'bounded_http_test',
  );
  let invalidChunkCancelled = false;
  await assert.rejects(
    readResponseJsonBounded({
      headers: { get: () => null },
      body: {
        getReader() {
          let delivered = false;
          return {
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: 'not-a-byte-chunk' };
            },
            async cancel() { invalidChunkCancelled = true; },
            releaseLock() {},
          };
        },
      },
    }, { maxBytes: 64, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  assert.equal(invalidChunkCancelled, true);

  const accumulator = createBoundedMetricAccumulator({ role: 'dashboard', expectedPid: 123 });
  for (let index = 0; index < 10_000; index += 1) {
    accumulator.add({
      role: 'dashboard', pid: 123, restartCount: 0,
      capturedAt: new Date(1_000 + index).toISOString(),
      updatedAt: new Date(1_000 + index).toISOString(),
      v8HeapUsedMiB: 100 + (index === 5_000 ? 50 : 0),
      rssMiB: 200 + (index === 6_000 ? 60 : 0),
      processMaxRssMiB: 300 + Math.floor(index / 1_000),
    });
  }
  const summary = accumulator.summary();
  assert.equal(summary.observedSamples, 10_000);
  assert.ok(summary.retainedSamples <= 256);
  assert.equal(summary.maxSampledV8HeapGrowthMiB, 50);
  assert.equal(summary.maxSampledRssGrowthMiB, 60);
  assert.equal(summary.processMaxRssGrowthMiB, 9);
  assert.equal(summary.samples.length, summary.retainedSamples);
});

test('isolated metric sampler proves advancing recovery and rejects frozen or malformed metrics', async (t) => {
  const { startIsolatedMetricSampler } = await import('../../scripts/live-brain-tools-smoke.mjs');

  async function setupMetricFixture(name) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `home23-${name}-`)));
    const metricFiles = {
      dashboard: path.join(root, 'dashboard.json'),
      cosmo: path.join(root, 'cosmo.json'),
    };
    const pids = { dashboard: 41_001, cosmo: 41_002 };
    const fixtureState = { root, metrics: metricFiles, pids };
    const writePair = async (updatedAt, overrides = {}) => {
      await Promise.all(['dashboard', 'cosmo'].map((role) => writeFixtureMetric(
        metricFiles[role],
        {
          role,
          pid: overrides[role]?.pid ?? pids[role],
          restartCount: overrides[role]?.restartCount ?? 0,
          updatedAt,
        },
      )));
    };
    await writePair(new Date().toISOString());
    return { fixtureState, writePair };
  }

  await t.test('transient stale metrics must recover with three new samples per role', async (t) => {
    const { fixtureState, writePair } = await setupMetricFixture('metric-recovery');
    t.after(() => fs.rm(fixtureState.root, { recursive: true, force: true }));
    const sampler = startIsolatedMetricSampler(fixtureState, {
      intervalMs: 5,
      initialFreshWaitMs: 500,
      finalFreshWaitMs: 1_000,
    });
    await sampler.ready;
    await writePair(new Date(Date.now() - 10_000).toISOString());
    await delay(30);

    let keepWriting = true;
    const writer = (async () => {
      let sequence = 0;
      while (keepWriting && sequence < 20) {
        await delay(15);
        sequence += 1;
        await writePair(new Date(Date.now() + sequence).toISOString());
      }
    })();
    const evidence = await sampler.stop();
    keepWriting = false;
    await writer;

    assert.ok(evidence.staleCaptureCount > 0);
    for (const role of ['dashboard', 'cosmo']) {
      assert.equal(evidence.finalSamples[role].length, 3);
      const timestamps = evidence.finalSamples[role].map(Date.parse);
      assert.ok(timestamps.every((value, index) => index === 0 || value > timestamps[index - 1]));
    }
  });

  await t.test('one refreshed but frozen timestamp cannot satisfy final proof', async (t) => {
    const { fixtureState, writePair } = await setupMetricFixture('metric-frozen');
    t.after(() => fs.rm(fixtureState.root, { recursive: true, force: true }));
    const sampler = startIsolatedMetricSampler(fixtureState, {
      intervalMs: 5,
      initialFreshWaitMs: 500,
      finalFreshWaitMs: 150,
    });
    await sampler.ready;
    const oneRefresh = delay(15).then(() => writePair(new Date(Date.now() + 1).toISOString()));
    await assert.rejects(
      sampler.stop(),
      (error) => error.code === 'isolated_fixture_metric_stale',
    );
    await oneRefresh;
  });

  await t.test('malformed process identity remains an immediate hard failure', async (t) => {
    const { fixtureState, writePair } = await setupMetricFixture('metric-malformed');
    t.after(() => fs.rm(fixtureState.root, { recursive: true, force: true }));
    const sampler = startIsolatedMetricSampler(fixtureState, {
      intervalMs: 5,
      initialFreshWaitMs: 500,
      finalFreshWaitMs: 500,
    });
    await sampler.ready;
    await writePair(new Date(Date.now() + 1).toISOString(), {
      dashboard: { pid: fixtureState.pids.dashboard + 1 },
    });
    await assert.rejects(
      sampler.stop(),
      (error) => error.code === 'isolated_fixture_metric_invalid',
    );
  });

  await t.test('final proof rejects a fresh metric read that crosses its monotonic deadline', async (t) => {
    const { fixtureState, writePair } = await setupMetricFixture('metric-read-deadline');
    t.after(() => fs.rm(fixtureState.root, { recursive: true, force: true }));
    let monotonicMs = 0;
    let finalRead = false;
    let injectedReads = 0;
    const sampler = startIsolatedMetricSampler(fixtureState, {
      intervalMs: 1_000,
      initialFreshWaitMs: 500,
      finalFreshWaitMs: 10,
      monotonicNow: () => monotonicMs,
      readMetricFile: async (file) => {
        injectedReads += 1;
        const metric = JSON.parse(await fs.readFile(file, 'utf8'));
        if (finalRead) monotonicMs = 11;
        return metric;
      },
      deadlineWait: async (_milliseconds, signal) => new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    });
    await sampler.ready;
    await writePair(new Date(Date.now() + 1).toISOString());
    finalRead = true;
    await assert.rejects(
      sampler.stop(),
      (error) => error.code === 'isolated_fixture_metric_stale',
    );
    assert.ok(injectedReads > 0);
  });

  await t.test('final proof clamps waits to its remaining monotonic budget', async (t) => {
    const { fixtureState } = await setupMetricFixture('metric-wait-deadline');
    t.after(() => fs.rm(fixtureState.root, { recursive: true, force: true }));
    let monotonicMs = 0;
    let sequence = 0;
    let finalRead = false;
    const waits = [];
    const sampler = startIsolatedMetricSampler(fixtureState, {
      intervalMs: 1_000,
      initialFreshWaitMs: 500,
      finalFreshWaitMs: 10,
      monotonicNow: () => monotonicMs,
      readMetricFile: async (file) => {
        const metric = JSON.parse(await fs.readFile(file, 'utf8'));
        if (finalRead) {
          sequence += 1;
          metric.updatedAt = new Date(Date.now() + sequence).toISOString();
        }
        return metric;
      },
      wait: async (milliseconds, signal) => {
        if (signal?.aborted) throw signal.reason;
        waits.push(milliseconds);
        monotonicMs += milliseconds;
      },
      deadlineWait: async (_milliseconds, signal) => new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    });
    await sampler.ready;
    waits.length = 0;
    finalRead = true;
    await assert.rejects(
      sampler.stop(),
      (error) => error.code === 'isolated_fixture_metric_stale',
    );
    assert.ok(waits.length > 0);
    assert.ok(waits.every((milliseconds) => milliseconds <= 10));
  });

  await t.test('operator abort preempts final metric collection', async (t) => {
    const { fixtureState } = await setupMetricFixture('metric-final-abort');
    t.after(() => fs.rm(fixtureState.root, { recursive: true, force: true }));
    const controller = new AbortController();
    const reason = Object.assign(new Error('operator_stop'), { code: 'operator_stop' });
    const sampler = startIsolatedMetricSampler(fixtureState, {
      intervalMs: 5,
      initialFreshWaitMs: 500,
      finalFreshWaitMs: 100,
      signal: controller.signal,
    });
    await sampler.ready;
    const stopping = sampler.stop();
    setTimeout(() => controller.abort(reason), 10);
    await assert.rejects(stopping, (error) => error === reason);
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
  });
});

test('surviving attachment proof waits only for the exact durable terminal transition', async (t) => {
  const { waitForSurvivingAttachmentClosure } = await import(
    '../../scripts/live-brain-tools-smoke.mjs'
  );
  const initialEvidence = attachmentEvidence();
  const terminalEvidence = attachmentEvidence({ survivorState: 'closed' });

  function rejectAfter(promise, milliseconds, message) {
    let timer;
    const watchdog = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
  }

  function cancellableDeadlineWait() {
    let signal = null;
    let released = false;
    return {
      get signal() { return signal; },
      get released() { return released; },
      wait: async (_milliseconds, candidateSignal) => new Promise((resolve, reject) => {
        signal = candidateSignal;
        const abort = () => {
          candidateSignal.removeEventListener('abort', abort);
          released = true;
          reject(candidateSignal.reason);
        };
        candidateSignal.addEventListener('abort', abort, { once: true });
        if (candidateSignal.aborted) abort();
      }),
    };
  }

  await t.test('an attached survivor may become exactly closed after terminal publication', async () => {
    const callerAbortInitial = attachmentEvidence({ detachedReason: 'caller_abort' });
    const evidenceSequence = [
      attachmentEvidence({ detachedReason: 'caller_abort' }),
      attachmentEvidence({ detachedReason: 'caller_abort', survivorState: 'closed' }),
    ];
    let elapsed = 0;
    const terminal = await waitForSurvivingAttachmentClosure({
      initialEvidence: callerAbortInitial,
      readEvidence: async () => evidenceSequence.shift(),
      timeoutMs: 100,
      pollMs: 5,
      now: () => elapsed,
      wait: async (ms) => { elapsed += ms; },
    });
    assert.deepEqual(terminal, attachmentEvidence({
      detachedReason: 'caller_abort',
      survivorState: 'closed',
    }));
  });

  await t.test('abort during an evidence read wins over a late terminal snapshot', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('operator_stop'), { code: 'operator_stop' });
    const deadlineWait = cancellableDeadlineWait();
    await assert.rejects(
      waitForSurvivingAttachmentClosure({
        initialEvidence,
        signal: controller.signal,
        readEvidence: async () => {
          controller.abort(reason);
          return terminalEvidence;
        },
        deadlineWait: deadlineWait.wait,
      }),
      (error) => error === reason,
    );
    assert.equal(deadlineWait.released, true);
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(require('node:events').getEventListeners(deadlineWait.signal, 'abort').length, 0);
  });

  await t.test('deadline crossing during an evidence read rejects a late terminal snapshot', async () => {
    let elapsed = 0;
    const deadlineWait = cancellableDeadlineWait();
    await assert.rejects(
      waitForSurvivingAttachmentClosure({
        initialEvidence,
        readEvidence: async () => {
          elapsed = 11;
          return terminalEvidence;
        },
        timeoutMs: 10,
        now: () => elapsed,
        deadlineWait: deadlineWait.wait,
      }),
      (error) => error.code === 'surviving_attachment_not_proven',
    );
    assert.equal(deadlineWait.released, true);
    assert.equal(require('node:events').getEventListeners(deadlineWait.signal, 'abort').length, 0);
  });

  await t.test('a never-settling evidence read is independently preempted', async (t) => {
    await t.test('by caller abort', async () => {
      const controller = new AbortController();
      const reason = Object.assign(new Error('operator_stop'), { code: 'operator_stop' });
      let settleStarted;
      const started = new Promise((resolve) => { settleStarted = resolve; });
      const pending = waitForSurvivingAttachmentClosure({
        initialEvidence,
        signal: controller.signal,
        timeoutMs: 1_000,
        readEvidence: async () => {
          settleStarted();
          return new Promise(() => {});
        },
      });
      await started;
      controller.abort(reason);
      await assert.rejects(
        rejectAfter(pending, 100, 'abort did not preempt evidence read'),
        (error) => error === reason,
      );
      assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
    });

    await t.test('by its own deadline', async () => {
      let deadlineSignal = null;
      const pending = waitForSurvivingAttachmentClosure({
        initialEvidence,
        timeoutMs: 10,
        now: () => 0,
        deadlineWait: async (_milliseconds, signal) => {
          deadlineSignal = signal;
        },
        readEvidence: async () => new Promise(() => {}),
      });
      await assert.rejects(
        rejectAfter(pending, 100, 'deadline did not preempt evidence read'),
        (error) => error.code === 'surviving_attachment_not_proven',
      );
      assert.equal(deadlineSignal.aborted, true);
      assert.equal(require('node:events').getEventListeners(deadlineSignal, 'abort').length, 0);
    });
  });

  await t.test('a perpetually attached survivor fails with the last coherent snapshot', async () => {
    let elapsed = 0;
    await assert.rejects(
      waitForSurvivingAttachmentClosure({
        initialEvidence,
        readEvidence: async () => attachmentEvidence(),
        timeoutMs: 20,
        pollMs: 5,
        now: () => elapsed,
        wait: async (ms) => { elapsed += ms; },
      }),
      (error) => error.code === 'surviving_attachment_not_proven'
        && error.message.includes('"attached":1'),
    );
  });

  await t.test('identity, count, state, and reason drift fail immediately', async () => {
    const invalidSnapshots = [
      attachmentEvidence({ survivorId: 'replacement-attachment' }),
      { ...attachmentEvidence(), total: 3 },
      attachmentEvidence({ survivorState: 'detached', survivorReason: 'transport_disconnect' }),
      attachmentEvidence({ survivorState: 'closed', survivorReason: 'wrong-reason' }),
      attachmentEvidence({ detachedState: 'closed', detachedReason: 'operation_terminal' }),
    ];
    for (const invalid of invalidSnapshots) {
      await assert.rejects(
        waitForSurvivingAttachmentClosure({
          initialEvidence,
          readEvidence: async () => invalid,
          timeoutMs: 100,
          pollMs: 5,
        }),
        (error) => error.code === 'surviving_attachment_evidence_invalid',
      );
    }
    const readFailure = Object.assign(new Error('attachment_corrupt'), {
      code: 'attachment_corrupt',
    });
    await assert.rejects(
      waitForSurvivingAttachmentClosure({
        initialEvidence,
        readEvidence: async () => { throw readFailure; },
      }),
      (error) => error === readFailure,
    );
  });
});

test('COSMO authority rejection keeps an independent hard deadline for status, result, and cancel', async () => {
  const { proveCosmoAuthorityRejection } = await import('../../scripts/live-brain-tools-smoke.mjs');
  for (const hungAction of ['status', 'result', 'cancel']) {
    const observed = [];
    const started = Date.now();
    await assert.rejects(
      proveCosmoAuthorityRejection({
        baseUrl: 'http://127.0.0.1:43210',
        operationId: 'brop_' + 'a'.repeat(32),
        signal: new AbortController().signal,
        timeoutMs: 10,
        fetchImpl: async (url, init) => {
          const action = new URL(url).pathname.split('/').at(-1);
          observed.push(action);
          if (action !== hungAction) {
            return new Response(JSON.stringify({
              success: false,
              error: { code: 'capability_invalid' },
            }), { status: 401, headers: { 'content-type': 'application/json' } });
          }
          return new Promise((resolve, reject) => {
            if (init.signal.aborted) {
              reject(init.signal.reason);
              return;
            }
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        },
      }),
      (error) => error.code === 'cosmo_authority_rejection_unproven'
        && error.message.includes(hungAction),
    );
    assert.deepEqual(observed, ['status', 'result', 'cancel'].slice(0, observed.length));
    assert.equal(observed.at(-1), hungAction);
    assert.ok(Date.now() - started < 1_000);
  }
});

test('fixture cleanup owns signals, aborts work, removes handlers, and stops once', async () => {
  const { createBoundedFixtureCleanup } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const signalTarget = new EventEmitter();
  const controller = new AbortController();
  let stops = 0;
  const fixtureValue = { pids: {}, children: {} };
  const cleanup = createBoundedFixtureCleanup({
    fixture: fixtureValue,
    stopFixture: async (received) => {
      stops += 1;
      assert.equal(received, fixtureValue);
      return { retainedStore: '/controlled/store' };
    },
    controller,
    signalTarget,
    timeoutMs: 1_000,
  });
  signalTarget.emit('SIGTERM');
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.code, 'acceptance_interrupted');
  assert.equal(controller.signal.reason.exitCode, 143);
  assert.deepEqual(await cleanup.cleanup(), { retainedStore: '/controlled/store' });
  await cleanup.cleanup();
  cleanup.dispose();
  assert.equal(stops, 1);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('fixture cleanup deadline force-kills only the three exact owned fixture children', async () => {
  const { createBoundedFixtureCleanup } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const killed = [];
  const pids = { dashboard: 101, cosmo: 202, mcp: 303 };
  const children = Object.fromEntries(Object.entries(pids).map(([role, pid]) => {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      killed.push({ role, pid, signal });
      setImmediate(() => child.emit('exit', null, signal));
      return true;
    };
    return [role, child];
  }));
  const cleanup = createBoundedFixtureCleanup({
    fixture: { pids, children },
    stopFixture: () => new Promise(() => {}),
    controller: new AbortController(),
    signalTarget: new EventEmitter(),
    timeoutMs: 5,
    forceTimeoutMs: 1_000,
  });
  await assert.rejects(
    cleanup.cleanup(),
    (error) => error.code === 'isolated_fixture_cleanup_timeout',
  );
  cleanup.dispose();
  assert.deepEqual(killed, [
    { role: 'dashboard', pid: 101, signal: 'SIGKILL' },
    { role: 'cosmo', pid: 202, signal: 'SIGKILL' },
    { role: 'mcp', pid: 303, signal: 'SIGKILL' },
  ]);
});

test('isolated own, sibling, and research source manifests are rehashed after a run', async (t) => {
  const {
    captureFixtureSourceIntegrity,
    verifyFixtureSourceIntegrity,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-source-integrity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = 'integrity-fixture';
  const roots = {
    own: path.join(root, 'instances', agent, 'brain'),
    sibling: path.join(root, 'instances', `${agent}-sibling`, 'brain'),
    research: path.join(
      root, 'instances', agent, 'workspace', 'research', 'runs', 'completed-fixture-run',
    ),
  };
  for (const [role, brainDir] of Object.entries(roots)) {
    await fs.mkdir(brainDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.writeFile(path.join(brainDir, 'nodes.jsonl'), `${role}-node\n`),
      fs.writeFile(path.join(brainDir, 'edges.jsonl'), `${role}-edge\n`),
      fs.writeFile(path.join(brainDir, 'delta.jsonl'), ''),
      fs.writeFile(path.join(brainDir, 'brain-snapshot.json'), '{"currentRevision":1}\n'),
      fs.writeFile(path.join(brainDir, 'brain-state.json'), '{"mutable":true}\n'),
    ]);
    await fs.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({
      generation: `${role}-g1`,
      currentRevision: 1,
      activeBase: { nodes: { file: 'nodes.jsonl' }, edges: { file: 'edges.jsonl' } },
      activeDelta: { file: 'delta.jsonl' },
    }));
  }
  const options = { fixtureRoot: root, agent };
  const before = await captureFixtureSourceIntegrity(options);
  const unchanged = await verifyFixtureSourceIntegrity(before, options);
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.before.sources.map((source) => source.role), [
    'own', 'sibling', 'research',
  ]);
  assert.ok(unchanged.before.sources.every((source) => source.files.length === 5
    && source.excludedMutableFiles[0] === 'brain-state.json'));

  await fs.appendFile(path.join(roots.sibling, 'nodes.jsonl'), 'drift\n');
  await assert.rejects(
    verifyFixtureSourceIntegrity(before, options),
    (error) => error.code === 'isolated_source_identity_or_hash_drift',
  );
});

test('authoritative canary discovery precedes query and typed failures remain failures', async (t) => {
  const { executeScenario, loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const calls = [];
  let graphRequest;
  const graphTerminal = operation({
    operationId: 'op_graph_canary_0001',
    operationType: 'graph',
    result: {
      nodes: [{
        id: 'n-canary',
        tag: 'state_snapshot',
        concept: '[STATE_SNAPSHOT] RECENT.md as of cycle 42518.\n\n'
          + '_Generated: 2026-07-10T14:14:06.710Z.\n'
          + 'Shared status markers disk_free_ok journal_freshness '
          + 'jerry_harness_cron_jobs_healthy retrieval_health_ok.\n'
          + 'Distinctive proof marker jerry_create_file_tool_writes_to_disk.',
      }],
      edges: [],
    },
  });
  const searchTerminal = operation({
    operationId: 'op_search_0001', operationType: 'search',
    result: { results: [{ id: 'n-canary' }] },
  });
  let searchRequest;
  const client = {
    async resolveTarget() {
      calls.push('resolve');
      return {
        id: 'brain-jerry', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident',
      };
    },
    async graph(request) {
      calls.push('graph');
      graphRequest = request;
      return {
        operationId: graphTerminal.operationId,
        state: graphTerminal.state,
        nodes: graphTerminal.result.nodes,
        edges: graphTerminal.result.edges,
        sourceEvidence: graphTerminal.sourceEvidence,
      };
    },
    async search(request) {
      calls.push('search');
      searchRequest = request;
      return {
        operationId: searchTerminal.operationId,
        state: searchTerminal.state,
        results: [{ id: 'n-canary' }],
        sourceEvidence: searchTerminal.sourceEvidence,
      };
    },
    async inspectOperation(operationId, action) {
      calls.push(`protected-${operationId}-${action}`);
      return operationId === graphTerminal.operationId ? graphTerminal : searchTerminal;
    },
  };
  const discovered = await executeScenario({
    scenario: 'discover-canary', modules, client, values: {}, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  });
  assert.deepEqual(calls, [
    'resolve', 'graph',
    `protected-${graphTerminal.operationId}-status`,
    `protected-${graphTerminal.operationId}-result`,
    'search',
    `protected-${searchTerminal.operationId}-status`,
    `protected-${searchTerminal.operationId}-result`,
  ]);
  assert.equal(graphRequest.edgeLimit, 1);
  assert.equal(searchRequest.tag, 'state_snapshot');
  assert.match(searchRequest.query, /42518/);
  assert.match(searchRequest.query, /2026-07-10T14:14:06\.710Z/);
  assert.match(searchRequest.query, /jerry_create_file_tool_writes_to_disk/);
  assert.equal(discovered.nodeId, 'n-canary');
  assert.equal(discovered.sourceRevision, 7);
  assert.deepEqual(
    discovered.operationReceipts.map((row) => row.operationId),
    [graphTerminal.operationId, searchTerminal.operationId],
  );
  assert.ok(discovered.operationReceipts.every((row) =>
    row.receiptKind === 'operation-terminal' && row.protectedResultRead === true));

  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const consumedCanary = path.join(state.context.receiptRunDir, 'discovered-canary.json');
  await writeJsonReceipt(state.context, consumedCanary, discovered);
  const queryTerminal = operation({ operationId: 'op_query_after_canary_0001' });
  const consumed = await executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return queryTerminal; },
      async inspectOperation() { return queryTerminal; },
    },
    values: { 'canary-receipt': consumedCanary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(queryTerminal)],
  });
  assert.equal(consumed.canaryNodeId, 'n-canary');
  assert.equal(consumed.canarySourceRevision, 7);

  const degradedProviderProse = operation({
    operationId: 'op_query_degraded_prose_0001',
    sourceEvidence: {
      sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'unknown',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 0, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
    result: { answer: 'provider prose that is not exact source-match evidence' },
  });
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return degradedProviderProse; },
      async inspectOperation() { return degradedProviderProse; },
    },
    values: { 'canary-receipt': consumedCanary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(degradedProviderProse)],
  }), (error) => error.code === 'source_evidence_not_useful');

  const healthyNoMatchProse = operation({
    operationId: 'op_query_healthy_no_match_prose_0001',
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'no_match', completeCoverage: true,
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 0, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return healthyNoMatchProse; },
      async inspectOperation() { return healthyNoMatchProse; },
    },
    values: { 'canary-receipt': consumedCanary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(healthyNoMatchProse)],
  }), (error) => error.code === 'source_evidence_not_useful');

  for (const invalidIdentity of [
    { phase: 'synthesis', providerCallId: 'query' },
    { phase: 'query', providerCallId: 'synthesis' },
  ]) {
    await assert.rejects(executeScenario({
      scenario: 'direct-query', modules,
      client: {
        async query() { return queryTerminal; },
        async inspectOperation() { return queryTerminal; },
      },
      values: { 'canary-receipt': consumedCanary }, context: state.context,
      baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
      activityLog: [providerTerminal(queryTerminal, invalidIdentity)],
    }), (error) => error.code === 'provider_terminal_unproven');
  }

  for (const invalidPair of [
    { provider: 'wrong-provider' },
    { model: 'wrong-model' },
  ]) {
    await assert.rejects(executeScenario({
      scenario: 'direct-query', modules,
      client: {
        async query() { return queryTerminal; },
        async inspectOperation() { return queryTerminal; },
      },
      values: { 'canary-receipt': consumedCanary }, context: state.context,
      baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
      activityLog: [providerTerminal(queryTerminal, invalidPair)],
    }), (error) => error.code === 'provider_terminal_unproven');
  }

  const compileTerminal = operation({
    operationId: 'op_research_compile_exact_provider_0001',
    operationType: 'research_compile',
    result: {
      relativePath: 'research-compile-exact-provider.md',
      provider: 'fixture-provider',
      model: 'fixture-model',
    },
  });
  const compileModules = {
    compileBrainTool: {
      async execute() { return { metadata: { operationId: compileTerminal.operationId } }; },
    },
  };
  const compileClient = { async inspectOperation() { return compileTerminal; } };
  const compileValues = {
    'canary-receipt': consumedCanary,
    'target-brain': 'brain-jerry',
  };
  const compiled = await executeScenario({
    scenario: 'completed-research-compile', modules: compileModules,
    client: compileClient, values: compileValues, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(compileTerminal)],
  });
  assert.equal(compiled.providerTerminalValidated, true);
  await assert.rejects(executeScenario({
    scenario: 'completed-research-compile', modules: compileModules,
    client: compileClient, values: compileValues, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(compileTerminal, { model: 'wrong-model' })],
  }), (error) => error.code === 'provider_terminal_unproven');

  const canary = await canaryReceipt(state);
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: { async query() { throw Object.assign(new Error('hard deadline'), { code: 'operation_timeout' }); } },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'operation_timeout');

  const failed = operation({
    operationId: 'op_query_failed_after_canary_0001',
    state: 'failed',
    result: null,
    error: { code: 'provider_failed', message: 'fixture failure', retryable: true },
  });
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return failed; },
      async inspectOperation() { return failed; },
    },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.toolResult?.is_error === true && /provider_failed/.test(error.message));
});

test('canary discovery receipts every search attempt and accepts null owners only for completed research', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const graphTerminal = operation({
    operationId: 'op_graph_research_canary_0001',
    operationType: 'graph',
    target: {
      domain: 'brain', brainId: 'brain-research', ownerAgent: null,
      accessMode: 'read-only',
    },
    result: {
      nodes: [
        { id: 'first', concept: 'first authoritative candidate phrase' },
        { id: 'second', concept: 'second authoritative candidate phrase' },
      ],
      edges: [],
    },
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'matches', deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 2, edges: 0 }, returnedTotals: { nodes: 2, edges: 0 },
      selectedBrain: 'brain-research',
    },
  });
  const firstSearch = operation({
    operationId: 'op_search_research_canary_first_0001',
    operationType: 'search',
    target: graphTerminal.target,
    result: { results: [] },
    sourceEvidence: {
      ...graphTerminal.sourceEvidence,
      matchOutcome: 'no_match', completeCoverage: true,
      returnedTotals: { nodes: 0, edges: 0 },
    },
  });
  const secondSearch = operation({
    operationId: 'op_search_research_canary_second_0001',
    operationType: 'search',
    target: graphTerminal.target,
    result: { results: [{ id: 'second' }] },
    sourceEvidence: {
      ...graphTerminal.sourceEvidence,
      returnedTotals: { nodes: 1, edges: 0 },
    },
  });
  let searchIndex = 0;
  const terminals = new Map([
    [graphTerminal.operationId, graphTerminal],
    [firstSearch.operationId, firstSearch],
    [secondSearch.operationId, secondSearch],
  ]);
  const discovered = await executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() {
        return {
          id: 'brain-research', ownerAgent: null,
          kind: 'research', lifecycle: 'completed',
        };
      },
      async graph() {
        return {
          operationId: graphTerminal.operationId, state: 'complete',
          ...graphTerminal.result, sourceEvidence: graphTerminal.sourceEvidence,
        };
      },
      async search() {
        const terminal = [firstSearch, secondSearch][searchIndex++];
        return {
          operationId: terminal.operationId, state: 'complete',
          ...terminal.result, sourceEvidence: terminal.sourceEvidence,
        };
      },
      async inspectOperation(operationId) { return terminals.get(operationId); },
    },
    values: { 'target-brain': 'brain-research' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  });
  assert.equal(discovered.nodeId, 'second');
  assert.deepEqual(
    discovered.operationReceipts.map((row) => row.operationId),
    [graphTerminal.operationId, firstSearch.operationId, secondSearch.operationId],
  );
  assert.equal(discovered.operationReceipts.at(-1), discovered);

  const wrongGraphTerminal = operation({
    operationId: 'op_graph_research_wrong_target_0001', operationType: 'graph',
    target: {
      domain: 'brain', brainId: 'brain-other', ownerAgent: 'other', accessMode: 'read-only',
    },
    result: {
      nodes: [{ id: 'wrong-graph-node', concept: 'wrong graph candidate phrase' }], edges: [],
    },
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'matches', deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 1, edges: 0 }, returnedTotals: { nodes: 1, edges: 0 },
      selectedBrain: 'brain-other',
    },
  });
  const correctSearchTerminal = operation({
    operationId: 'op_search_after_wrong_graph_target_0001', operationType: 'search',
    target: graphTerminal.target,
    result: { results: [{ id: 'wrong-graph-node' }] },
    sourceEvidence: graphTerminal.sourceEvidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() {
        return {
          id: 'brain-research', ownerAgent: null,
          kind: 'research', lifecycle: 'completed',
        };
      },
      async graph() {
        return {
          operationId: wrongGraphTerminal.operationId, state: 'complete',
          ...wrongGraphTerminal.result, sourceEvidence: wrongGraphTerminal.sourceEvidence,
        };
      },
      async search() {
        return {
          operationId: correctSearchTerminal.operationId, state: 'complete',
          ...correctSearchTerminal.result, sourceEvidence: correctSearchTerminal.sourceEvidence,
        };
      },
      async inspectOperation(operationId) {
        return operationId === wrongGraphTerminal.operationId
          ? wrongGraphTerminal
          : correctSearchTerminal;
      },
    },
    values: { 'target-brain': 'brain-research' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'canary_target_mismatch');

  await assert.rejects(executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() {
        return { id: 'brain-ownerless-resident', ownerAgent: null, kind: 'resident', lifecycle: 'resident' };
      },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
  }), (error) => error.code === 'canary_target_invalid');
});

test('canary discovery forwards a 256-character tag and omits an oversized tag', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const allowedTag = 'a'.repeat(256);
  const oversizedTag = 'b'.repeat(257);
  const graphTerminal = operation({
    operationId: 'op_graph_tag_boundary_0001',
    operationType: 'graph',
    result: {
      nodes: [
        { id: 'first', tag: allowedTag, concept: 'first authoritative candidate phrase' },
        { id: 'second', tag: oversizedTag, concept: 'second authoritative candidate phrase' },
      ],
      edges: [],
    },
  });
  const firstSearch = operation({
    operationId: 'op_search_tag_boundary_first_0001',
    operationType: 'search',
    result: { results: [] },
  });
  const secondSearch = operation({
    operationId: 'op_search_tag_boundary_second_0001',
    operationType: 'search',
    result: { results: [{ id: 'second' }] },
  });
  const terminals = new Map([
    [graphTerminal.operationId, graphTerminal],
    [firstSearch.operationId, firstSearch],
    [secondSearch.operationId, secondSearch],
  ]);
  const searchRequests = [];
  let searchIndex = 0;
  const discovered = await executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() {
        return {
          id: 'brain-jerry', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident',
        };
      },
      async graph() {
        return {
          operationId: graphTerminal.operationId, state: 'complete',
          ...graphTerminal.result, sourceEvidence: graphTerminal.sourceEvidence,
        };
      },
      async search(request) {
        searchRequests.push(request);
        if (request.tag !== undefined && request.tag.length > 256) {
          throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
        }
        const terminal = [firstSearch, secondSearch][searchIndex++];
        return {
          operationId: terminal.operationId, state: 'complete',
          ...terminal.result, sourceEvidence: terminal.sourceEvidence,
        };
      },
      async inspectOperation(operationId) { return terminals.get(operationId); },
    },
    values: {}, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  });

  assert.equal(searchRequests[0].tag, allowedTag);
  assert.equal(Object.hasOwn(searchRequests[1], 'tag'), false);
  assert.equal(discovered.nodeId, 'second');
});

test('own scenario emits one protected terminal receipt for each unique tool operation', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const canary = await canaryReceipt(state);
  const operations = [
    operation({ operationId: 'op_own_search_0001', operationType: 'search' }),
    operation({ operationId: 'op_own_status_0001', operationType: 'status' }),
    operation({ operationId: 'op_own_graph_0001', operationType: 'graph' }),
    operation({ operationId: 'op_own_query_0001', operationType: 'query' }),
  ];
  const byId = new Map(operations.map((row) => [row.operationId, row]));
  const tool = (operationId) => ({
    async execute() { return { content: 'ok', metadata: { operationId } }; },
  });
  const result = await executeScenario({
    scenario: 'own',
    modules: {
      brainSearchTool: tool(operations[0].operationId),
      brainStatusTool: tool(operations[1].operationId),
      brainMemoryGraphTool: tool(operations[2].operationId),
      brainQueryTool: tool(operations[3].operationId),
    },
    client: {
      async inspectOperation(operationId) { return byId.get(operationId); },
    },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(operations[3])],
  });
  assert.deepEqual(
    result.operationReceipts.map((row) => row.operationId),
    operations.map((row) => row.operationId),
  );
  assert.equal(new Set(result.operationReceipts.map((row) => row.operationId)).size, 4);
  assert.ok(result.operationReceipts.every((row) =>
    row.receiptKind === 'operation-terminal' && row.protectedResultRead === true));
  assert.equal(result, result.operationReceipts.at(-1));
});

test('canonical receipt consumers reject implementation commit drift before use or sealing', async (t) => {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    executeScenario,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const validCanary = await canaryReceipt(state);
  const { artifactSha256: _artifact, ...canaryPayload } = JSON.parse(
    await fs.readFile(validCanary, 'utf8'),
  );
  const wrongContext = { ...state.context, implementationCommit: 'd'.repeat(40) };
  const wrongCanary = path.join(state.context.receiptRunDir, 'wrong-commit-canary.json');
  await fs.writeFile(wrongCanary, `${JSON.stringify(canonicalReceiptRow(
    wrongContext,
    canaryPayload,
  ))}\n`);
  let queryCalls = 0;
  const unexpectedTerminal = operation({ operationId: 'op_wrong_commit_query_0001' });
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules: {
      brainQueryTool: {
        async execute() {
          queryCalls += 1;
          return { content: 'unexpected', metadata: { operationId: unexpectedTerminal.operationId } };
        },
      },
    },
    client: { async inspectOperation() { return unexpectedTerminal; } },
    values: { 'canary-receipt': wrongCanary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(unexpectedTerminal)],
  }), (error) => error.code === 'receipt_implementation_commit_mismatch');
  assert.equal(queryCalls, 0);

  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  await fs.writeFile(path.join(live, 'wrong-operation.jsonl'), `${JSON.stringify(
    canonicalReceiptRow(wrongContext, {
      helper: 'fixture', receiptKind: 'operation-terminal', operationId: 'op_wrong_commit_0001',
      operationType: 'query', state: 'complete', requesterAgent: 'jerry',
      protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
    }),
  )}\n`);
  await assert.rejects(buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
    context: state.context,
  }), (error) => error.code === 'receipt_implementation_commit_mismatch');
});

test('manifest builders and read-only verifiers reject a replaced receipt run directory', async (t) => {
  const {
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
    verifyReceiptManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  await writeJsonReceipt(state.context, path.join(live, 'operation.json'), {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'D'.repeat(32)}`,
    operationType: 'search', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });

  const displaced = path.join(state.root, 'receipt-run-displaced');
  await fs.rename(state.context.receiptRunDir, displaced);
  await fs.mkdir(state.context.receiptRunDir, { mode: 0o700 });
  await fs.copyFile(
    path.join(displaced, 'run-authority.json'),
    path.join(state.context.receiptRunDir, 'run-authority.json'),
  );
  await fs.chmod(path.join(state.context.receiptRunDir, 'run-authority.json'), 0o600);

  await assert.rejects(
    verifyArtifactManifest({ manifestPath, context: state.context }),
    (error) => error.code === 'path_changed',
  );
  await assert.rejects(
    buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'replacement-manifest.json'),
      context: state.context,
    }),
    (error) => error.code === 'path_changed',
  );
  await assert.rejects(
    verifyReceiptManifest({
      manifestPath: path.join(state.context.receiptRunDir, 'identity-manifest.json'),
      modules: {}, context: state.context, values: {}, callerAgent: 'jerry',
      signal: new AbortController().signal,
    }),
    (error) => error.code === 'path_changed',
  );
});

test('artifact verification rejects a manifest replacement between digest read and semantic validation', async (t) => {
  const {
    canonicalReceiptRow,
    readBoundedFile,
    sha256Bytes,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  await writeJsonReceipt(state.context, path.join(live, 'operation.json'), {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'M'.repeat(32)}`,
    operationType: 'search', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  const digestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.sha256');
  await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });

  const originalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const { artifactSha256: _artifactHash, ...replacementPayload } = originalManifest;
  replacementPayload.completedAt = '2026-07-11T00:00:01.000Z';
  const replacementRow = canonicalReceiptRow(
    state.context,
    replacementPayload,
    replacementPayload.completedAt,
  );
  const replacementBytes = Buffer.from(`${JSON.stringify(replacementRow, null, 2)}\n`);
  const replacementDigest = Buffer.from(
    `${sha256Bytes(replacementBytes)}  artifact-manifest.json\n`,
  );
  let releaseFirstManifestRead;
  const firstManifestRead = new Promise((resolve) => { releaseFirstManifestRead = resolve; });
  let manifestReads = 0;
  let digestReads = 0;
  const readBoundedFileImpl = async (file, options) => {
    if (file === manifestPath && ++manifestReads === 1) {
      const bytes = await readBoundedFile(file, options);
      releaseFirstManifestRead();
      return bytes;
    }
    if (file === digestPath && ++digestReads === 1) {
      await firstManifestRead;
      const bytes = await readBoundedFile(file, options);
      await fs.writeFile(manifestPath, replacementBytes);
      await fs.writeFile(digestPath, replacementDigest);
      return bytes;
    }
    return readBoundedFile(file, options);
  };

  await assert.rejects(
    verifyArtifactManifest({
      manifestPath,
      context: state.context,
      readBoundedFileImpl,
    }),
    (error) => error.code === 'artifact_manifest_changed_concurrently',
  );
});

test('artifact verification binds JSON semantics to the exact bytes recorded in the manifest', async (t) => {
  const {
    canonicalReceiptRow,
    readBoundedFile,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  const receiptPath = path.join(live, 'operation.json');
  await writeJsonReceipt(state.context, receiptPath, {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'A'.repeat(32)}`,
    operationType: 'search', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });

  const originalReceipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const { artifactSha256: _artifactHash, ...replacementPayload } = originalReceipt;
  replacementPayload.operationId = `brop_${'B'.repeat(32)}`;
  const replacementRow = canonicalReceiptRow(
    state.context,
    replacementPayload,
    replacementPayload.completedAt,
  );
  const replacementBytes = Buffer.from(`${JSON.stringify(replacementRow, null, 2)}\n`);
  let receiptReads = 0;
  const readBoundedFileImpl = async (file, options) => {
    if (file === receiptPath && ++receiptReads === 1) {
      await fs.writeFile(receiptPath, replacementBytes);
    }
    return readBoundedFile(file, options);
  };

  await assert.rejects(
    verifyArtifactManifest({
      manifestPath,
      context: state.context,
      readBoundedFileImpl,
    }),
    (error) => error.code === 'artifact_identity_mismatch',
  );
});

test('artifact manifest building rejects a JSON artifact changed during its bounded snapshot', async (t) => {
  const {
    canonicalReceiptRow,
    readBoundedFile,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  const receiptPath = path.join(live, 'operation.json');
  await writeJsonReceipt(state.context, receiptPath, {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'C'.repeat(32)}`,
    operationType: 'search', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  const originalReceipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const { artifactSha256: _artifactHash, ...replacementPayload } = originalReceipt;
  replacementPayload.operationId = `brop_${'D'.repeat(32)}`;
  const replacementRow = canonicalReceiptRow(
    state.context,
    replacementPayload,
    replacementPayload.completedAt,
  );
  const replacementBytes = Buffer.from(`${JSON.stringify(replacementRow, null, 2)}\n`);
  let receiptReads = 0;
  const readBoundedFileImpl = async (file, options) => {
    const bytes = await readBoundedFile(file, options);
    if (file === receiptPath && ++receiptReads === 1) {
      await fs.writeFile(receiptPath, replacementBytes);
    }
    return bytes;
  };

  await assert.rejects(
    buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      context: state.context,
      readBoundedFileImpl,
    }),
    (error) => error.code === 'artifact_changed_concurrently',
  );
});

test('artifact verification rejects files added after the manifest path-set snapshot', async (t) => {
  const {
    readBoundedFile,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  const receiptPath = path.join(live, 'operation.json');
  await writeJsonReceipt(state.context, receiptPath, {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'E'.repeat(32)}`,
    operationType: 'search', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  const latePath = path.join(state.context.receiptRunDir, 'late-unmanifested-artifact.txt');
  let receiptReads = 0;
  const readBoundedFileImpl = async (file, options) => {
    const bytes = await readBoundedFile(file, options);
    if (file === receiptPath && ++receiptReads === 1) {
      await fs.writeFile(latePath, 'late artifact\n');
    }
    return bytes;
  };

  await assert.rejects(
    verifyArtifactManifest({
      manifestPath,
      context: state.context,
      readBoundedFileImpl,
    }),
    (error) => error.code === 'artifact_tree_changed_concurrently',
  );
});

test('positive reads require complete exact targets while zero-result requires healthy coverage', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const signal = new AbortController().signal;

  const failedGraph = operation({
    operationId: 'op_graph_failed_0001',
    operationType: 'graph',
    state: 'failed',
    result: null,
    error: { code: 'source_failed', message: 'graph failed', retryable: false },
  });
  await assert.rejects(executeScenario({
    scenario: 'graph', modules: {},
    client: {
      async graph() { return { operationId: failedGraph.operationId, nodes: [{ id: 'n1' }] }; },
      async inspectOperation() { return failedGraph; },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'operation_success_required');

  const lyingGraph = operation({
    operationId: 'op_graph_lying_totals_0001',
    operationType: 'graph',
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'matches', selectedBrain: 'brain-jerry',
      authoritativeTotals: { nodes: 3, edges: 2 },
      returnedTotals: { nodes: 1, edges: 1 },
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'graph', modules: {},
    client: {
      async graph() {
        return {
          operationId: lyingGraph.operationId,
          nodes: [{ id: 'n1' }, { id: 'n2' }],
          edges: [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n1' }],
        };
      },
      async inspectOperation() { return lyingGraph; },
    },
    values: { 'node-limit': '1', 'edge-limit': '1' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'graph_result_invalid');

  const wrongTargetGraph = operation({
    operationId: 'op_graph_before_wrong_target_0001',
    operationType: 'graph',
    result: { nodes: [{ id: 'n-canary', concept: 'authoritative canary phrase' }], edges: [] },
  });
  const wrongCanaryTarget = operation({
    operationId: 'op_search_wrong_target_0001',
    operationType: 'search',
    target: { domain: 'brain', brainId: 'brain-other', ownerAgent: 'other', accessMode: 'sibling' },
    result: { results: [{ id: 'n-canary' }] },
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'matches', deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 10, edges: 4 }, returnedTotals: { nodes: 1, edges: 0 },
      selectedBrain: 'brain-other',
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() {
        return { id: 'brain-jerry', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident' };
      },
      async graph() {
        return { operationId: wrongTargetGraph.operationId, state: 'complete', ...wrongTargetGraph.result };
      },
      async search() {
        return {
          operationId: wrongCanaryTarget.operationId,
          state: 'complete',
          results: [{ id: 'n-canary' }],
          sourceEvidence: wrongCanaryTarget.sourceEvidence,
        };
      },
      async inspectOperation(operationId) {
        return operationId === wrongTargetGraph.operationId ? wrongTargetGraph : wrongCanaryTarget;
      },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'canary_target_mismatch');

  const degradedEvidence = {
    sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'matches',
    implementation: 'legacy-resident-sidecar-projection',
    deltaWatermark: { revision: 7 }, authoritativeTotals: { nodes: 10, edges: 4 },
    returnedTotals: { nodes: 1, edges: 0 }, selectedBrain: 'brain-jerry',
  };
  const degradedSearch = operation({
    operationId: 'op_search_degraded_0001', operationType: 'search',
    result: { results: [{ id: 'n-canary' }] },
    sourceEvidence: degradedEvidence,
  });
  const degradedGraph = operation({
    operationId: 'op_graph_degraded_0001', operationType: 'graph',
    result: { nodes: [{ id: 'n-canary', concept: 'authoritative canary phrase' }], edges: [] },
    sourceEvidence: degradedEvidence,
  });
  const degradedCanary = await executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() {
        return { id: 'brain-jerry', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident' };
      },
      async graph() {
        return { operationId: degradedGraph.operationId, state: 'complete', ...degradedGraph.result };
      },
      async search() {
        return {
          operationId: degradedSearch.operationId,
          state: 'complete',
          results: [{ id: 'n-canary' }],
          sourceEvidence: degradedEvidence,
        };
      },
      async inspectOperation(operationId) {
        return operationId === degradedGraph.operationId ? degradedGraph : degradedSearch;
      },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  });
  assert.equal(degradedCanary.state, 'complete');
  assert.equal(degradedCanary.sourceHealth, 'degraded');

  const zeroEvidence = {
    sourceHealth: 'healthy', matchOutcome: 'no_match', completeCoverage: true,
    deltaWatermark: { revision: 7 }, authoritativeTotals: { nodes: 10, edges: 4 },
    selectedBrain: 'brain-jerry',
  };
  const partialZero = operation({
    operationId: 'op_zero_partial_0001', operationType: 'search', state: 'partial',
    result: { results: [] }, sourceEvidence: zeroEvidence,
    error: { code: 'source_partial', message: 'partial search', retryable: true },
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return { operationId: partialZero.operationId, results: [], sourceEvidence: zeroEvidence };
      },
      async inspectOperation() { return partialZero; },
    },
    values: { query: 'definitely absent' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'operation_success_required');
  const degradedZero = operation({
    operationId: 'op_zero_degraded_0001', operationType: 'search',
    result: { results: [] },
    sourceEvidence: { ...zeroEvidence, sourceHealth: 'degraded', freshness: 'unknown' },
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: degradedZero.operationId,
          results: [],
          sourceEvidence: degradedZero.sourceEvidence,
        };
      },
      async inspectOperation() { return degradedZero; },
    },
    values: { query: 'degraded absence is not proof' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'source_health_unhealthy');

  const strictEvidence = {
    sourceHealth: 'healthy', freshness: 'known', matchOutcome: 'no_match',
    completeCoverage: true, deltaWatermark: { revision: 7 },
    authoritativeTotals: { nodes: 10, edges: 4 }, returnedTotals: { nodes: 0, edges: 0 },
    selectedBrain: 'brain-jerry', filters: { tag: 'strict-zero-tag' }, limits: { topK: 100 },
    implementation: 'manifest-v1',
  };
  const strictZero = operation({
    operationId: 'op_zero_strict_healthy_0001', operationType: 'search',
    target: {
      domain: 'brain', brainId: 'brain-jerry', ownerAgent: 'jerry', accessMode: 'own',
      kind: 'resident', lifecycle: 'resident',
    },
    result: { results: [] }, sourceEvidence: strictEvidence,
  });
  let strictRequest;
  const strictResult = await executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search(request) {
        strictRequest = request;
        return { operationId: strictZero.operationId, results: [], sourceEvidence: strictEvidence };
      },
      async inspectOperation() { return strictZero; },
    },
    values: {
      query: 'strict healthy absence', tag: 'strict-zero-tag',
      'zero-policy': 'healthy-no-match',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  });
  assert.equal(strictResult.matchOutcome, 'no_match');
  assert.deepEqual(strictRequest, {
    query: 'strict healthy absence', topK: 100, tag: 'strict-zero-tag',
  });

  const unknownFreshnessEvidence = {
    ...strictEvidence, freshness: 'unknown',
  };
  const unknownFreshnessZero = operation({
    operationId: 'op_zero_strict_unknown_freshness_0001', operationType: 'search',
    target: strictZero.target,
    result: { results: [] }, sourceEvidence: unknownFreshnessEvidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: unknownFreshnessZero.operationId,
          results: [], sourceEvidence: unknownFreshnessEvidence,
        };
      },
      async inspectOperation() { return unknownFreshnessZero; },
    },
    values: {
      query: 'unknown freshness cannot prove absence', tag: 'strict-zero-tag',
      'zero-policy': 'healthy-no-match',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'zero_result_not_proven');

  const missingWatermarkEvidence = {
    ...strictEvidence, deltaWatermark: null,
  };
  const missingWatermarkZero = operation({
    operationId: 'op_zero_strict_missing_watermark_0001', operationType: 'search',
    target: strictZero.target,
    result: { results: [] }, sourceEvidence: missingWatermarkEvidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: missingWatermarkZero.operationId,
          results: [], sourceEvidence: missingWatermarkEvidence,
        };
      },
      async inspectOperation() { return missingWatermarkZero; },
    },
    values: {
      query: 'absence without a watermark is unproven', tag: 'strict-zero-tag',
      'zero-policy': 'healthy-no-match',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'zero_result_not_proven');

  const contradictoryReturnedTotalEvidence = {
    ...strictEvidence, returnedTotals: { nodes: 1, edges: 0 },
  };
  const contradictoryReturnedTotalZero = operation({
    operationId: 'op_zero_strict_contradictory_returned_total_0001',
    operationType: 'search', target: strictZero.target,
    result: { results: [] }, sourceEvidence: contradictoryReturnedTotalEvidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: contradictoryReturnedTotalZero.operationId,
          results: [], sourceEvidence: contradictoryReturnedTotalEvidence,
        };
      },
      async inspectOperation() { return contradictoryReturnedTotalZero; },
    },
    values: {
      query: 'empty arrays cannot contradict returned totals', tag: 'strict-zero-tag',
      'zero-policy': 'healthy-no-match',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'zero_result_not_proven');

  const legacyImplementationEvidence = {
    ...strictEvidence, implementation: 'legacy-resident-sidecar-projection',
  };
  const legacyImplementationZero = operation({
    operationId: 'op_zero_strict_legacy_implementation_0001', operationType: 'search',
    target: strictZero.target,
    result: { results: [] }, sourceEvidence: legacyImplementationEvidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: legacyImplementationZero.operationId,
          results: [], sourceEvidence: legacyImplementationEvidence,
        };
      },
      async inspectOperation() { return legacyImplementationZero; },
    },
    values: {
      query: 'legacy projection cannot prove absence', tag: 'strict-zero-tag',
      'zero-policy': 'healthy-no-match',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'zero_result_not_proven');

  const wrongStrictTargetEvidence = {
    ...strictEvidence, selectedBrain: 'brain-forrest',
  };
  const wrongStrictTarget = operation({
    operationId: 'op_zero_strict_wrong_target_0001', operationType: 'search',
    target: {
      domain: 'brain', brainId: 'brain-forrest', ownerAgent: 'forrest',
      accessMode: 'read-only', kind: 'resident', lifecycle: 'resident',
    },
    result: { results: [] }, sourceEvidence: wrongStrictTargetEvidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: wrongStrictTarget.operationId,
          results: [], sourceEvidence: wrongStrictTargetEvidence,
        };
      },
      async inspectOperation() { return wrongStrictTarget; },
    },
    values: {
      query: 'wrong strict target', tag: 'strict-zero-tag',
      'zero-policy': 'healthy-no-match',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'zero_result_not_proven');

  const unprovableEvidence = {
    sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'unknown',
    completeCoverage: true, deltaWatermark: { revision: 7 },
    authoritativeTotals: { nodes: 10, edges: 4 }, returnedTotals: { nodes: 0, edges: 0 },
    selectedBrain: 'brain-jerry', filters: { tag: 'unique-zero-tag' }, limits: { topK: 100 },
    implementation: 'legacy-resident-sidecar-projection',
  };
  const unprovable = operation({
    operationId: 'op_zero_unprovable_degraded_0001', operationType: 'search',
    target: {
      domain: 'brain', brainId: 'brain-jerry', ownerAgent: 'jerry', accessMode: 'own',
      kind: 'resident', lifecycle: 'resident',
    },
    result: { results: [] }, sourceEvidence: unprovableEvidence,
  });
  let unprovableRequest;
  const unprovableResult = await executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search(request) {
        unprovableRequest = request;
        return {
          operationId: unprovable.operationId, results: [],
          sourceEvidence: unprovableEvidence,
        };
      },
      async inspectOperation() { return unprovable; },
    },
    values: {
      query: 'degraded absence cannot be claimed', tag: 'unique-zero-tag',
      'zero-policy': 'degraded-unprovable',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  });
  assert.equal(unprovableResult.state, 'complete');
  assert.equal(unprovableResult.absenceProven, false);
  assert.equal(unprovableResult.emptyBrainClaimAllowed, false);
  assert.equal(unprovableResult.classification, 'absence_unprovable');
  assert.equal(unprovableResult.authoritativeTotal, 10);
  assert.deepEqual(unprovableRequest, {
    query: 'degraded absence cannot be claimed', topK: 100, tag: 'unique-zero-tag',
  });

  for (const [index, sourceEvidence] of [
    { ...unprovableEvidence, matchOutcome: 'no_match' },
    { ...unprovableEvidence, freshness: 'known' },
    { ...unprovableEvidence, completeCoverage: false },
    { ...unprovableEvidence, authoritativeTotals: { nodes: 0, edges: 0 } },
    { ...unprovableEvidence, filters: { tag: 'not-null' } },
    { ...unprovableEvidence, limits: { topK: 99 } },
    { ...unprovableEvidence, selectedBrain: 'brain-other' },
    { ...unprovableEvidence, implementation: 'different-projection' },
  ].entries()) {
    const invalid = operation({
      operationId: `op_zero_unprovable_invalid_${index}`,
      operationType: 'search', target: unprovable.target,
      result: { results: [] }, sourceEvidence,
    });
    await assert.rejects(executeScenario({
      scenario: 'zero-result', modules: {},
      client: {
        async search() {
          return { operationId: invalid.operationId, results: [], sourceEvidence };
        },
        async inspectOperation() { return invalid; },
      },
      values: {
        query: 'invalid degraded absence', tag: 'unique-zero-tag',
        'zero-policy': 'degraded-unprovable',
      },
      context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
    }), (error) => error.code === 'absence_unprovable_not_proven');
  }

  const canary = await canaryReceipt(state);
  const dashboardTerminal = operation({
    operationId: 'op_mcp_parity_0001', operationType: 'search',
  });
  const mcpResponse = (selectedBrain) => new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'acceptance', result: { content: [{
      type: 'text',
      text: JSON.stringify({
        results: [{ id: 'n-canary' }],
        evidence: {
          sourceHealth: 'healthy', matchOutcome: 'matches',
          deltaWatermark: { revision: 7 },
          authoritativeTotals: { nodes: 140_086, edges: 456_709 },
          returnedTotals: { nodes: 1, edges: 0 },
          selectedBrain,
        },
      }),
    }] },
  }), { headers: { 'content-type': 'application/json' } });
  const mcpClient = {
    async search() {
      return {
        operationId: dashboardTerminal.operationId,
        results: [{ id: 'n-canary' }],
        sourceEvidence: dashboardTerminal.sourceEvidence,
      };
    },
    async inspectOperation() { return dashboardTerminal; },
  };
  await assert.rejects(executeScenario({
    scenario: 'mcp-parity', modules: {}, client: mcpClient,
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
    fetchImpl: async () => mcpResponse('brain-other'),
  }), (error) => error.code === 'mcp_target_mismatch');
  const parity = await executeScenario({
    scenario: 'mcp-parity', modules: {}, client: mcpClient,
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
    fetchImpl: async () => mcpResponse('brain-jerry'),
  });
  assert.equal(parity.state, 'complete');
  assert.equal(parity.mcpParity, true);

  const advancedDashboard = operation({
    operationId: 'op_mcp_parity_advanced', operationType: 'search',
    result: { results: [{ id: 'n-current-crossing' }] },
    sourceEvidence: {
      ...dashboardTerminal.sourceEvidence,
      deltaWatermark: { revision: 9 },
      returnedTotals: { nodes: 1, edges: 0 },
    },
  });
  const advancedClient = {
    async search() {
      return {
        operationId: advancedDashboard.operationId,
        results: [{ id: 'n-current-crossing' }],
        sourceEvidence: advancedDashboard.sourceEvidence,
      };
    },
    async inspectOperation() { return advancedDashboard; },
  };
  const advancedMcpResponse = new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'acceptance', result: { content: [{
      type: 'text',
      text: JSON.stringify({
        results: [{ id: 'n-current-crossing' }],
        evidence: {
          sourceHealth: 'healthy', matchOutcome: 'matches',
          deltaWatermark: { revision: 10 },
          authoritativeTotals: { nodes: 140_090, edges: 456_720 },
          returnedTotals: { nodes: 1, edges: 0 },
          selectedBrain: 'brain-jerry',
        },
      }),
    }] },
  }), { headers: { 'content-type': 'application/json' } });
  let advancedMcpSignal = null;
  const advanced = await executeScenario({
    scenario: 'mcp-parity', modules: {}, client: advancedClient,
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
    mcpTimeoutMs: 17,
    fetchImpl: async (_url, init) => {
      advancedMcpSignal = init.signal;
      return advancedMcpResponse;
    },
  });
  assert.equal(advanced.mcpParity, true);
  assert.equal(advanced.sourceRevision, 9);
  assert.equal(advanced.mcpSourceRevision, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(advancedMcpSignal.aborted, true);
  assert.equal(advancedMcpSignal.reason?.name, 'TimeoutError');
});

test('MCP acceptance call uses a configurable wait and preserves caller cancellation', async () => {
  const { mcpCall } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const response = new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'acceptance', result: { content: [{
      type: 'text', text: JSON.stringify({ ok: true }),
    }] },
  }), { headers: { 'content-type': 'application/json' } });
  const caller = new AbortController();
  let observedSignal = null;
  const result = await mcpCall('http://fixture', 'query_memory', { query: 'x' }, {
    signal: caller.signal,
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, false);

  const cancelled = new AbortController();
  const pending = mcpCall('http://fixture', 'query_memory', { query: 'x' }, {
    signal: cancelled.signal,
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  });
  const reason = Object.assign(new Error('caller stopped'), { code: 'cancelled' });
  cancelled.abort(reason);
  await assert.rejects(pending, (error) => error === reason);

  await assert.rejects(
    mcpCall('http://fixture', 'query_memory', { query: 'x' }, {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    }),
    (error) => error?.name === 'TimeoutError',
  );
});

test('healthy model discovery performs exact direct, PGS sweep, and PGS synthesis pair probes', async () => {
  const { discoverHealthyModels } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/providers/probe' && init.method === 'POST') {
      const request = JSON.parse(init.body);
      calls.push(request);
      const pairs = {
        'direct-query': { provider: 'direct-provider', model: 'query-model' },
        'pgs-sweep': { provider: 'sweep-provider', model: 'sweep-model' },
        'pgs-synthesis': { provider: 'synth-provider', model: 'synth-model' },
      };
      return new Response(JSON.stringify({
        healthy: true,
        purpose: request.purpose,
        pair: pairs[request.purpose],
        requestedPair: pairs[request.purpose],
        observedPair: pairs[request.purpose],
        terminalReceived: true,
      }));
    }
    return new Response('', { status: 404 });
  };
  const selected = await discoverHealthyModels('http://cosmo-fixture', fetchImpl);
  assert.deepEqual(calls, [
    { purpose: 'direct-query' },
    { purpose: 'pgs-sweep' },
    { purpose: 'pgs-synthesis' },
  ]);
  assert.deepEqual(selected.modelSelection, { provider: 'direct-provider', model: 'query-model' });
  assert.deepEqual(selected.pgsSweep, { provider: 'sweep-provider', model: 'sweep-model' });
  assert.deepEqual(selected.pgsSynth, { provider: 'synth-provider', model: 'synth-model' });
  assert.equal(selected.probes.every((probe) => probe.healthy && probe.terminalReceived), true);
});

test('isolated synthesis reconnect and MCP disabled/unreachable outcomes are typed', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture('isolated-controlled');
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const values = { 'isolated-store': state.isolatedStore };
  const completed = operation({
    operationId: 'op_synthesis_0001', operationType: 'synthesis',
    result: {
      generationMarker: 'generation-7',
      provider: 'fixture-provider',
      model: 'fixture-model',
    },
  });
  let reattached = 0;
  await assert.rejects(executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { reattached += 1; return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
  }), (error) => error.code === 'provider_terminal_unproven');
  reattached = 0;
  const synthesis = await executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { reattached += 1; return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [providerTerminal(completed, {
      eventSequence: 7,
      phase: 'synthesis',
      providerCallId: 'synthesis',
    })],
  });
  assert.equal(reattached, 1);
  assert.equal(synthesis.state, 'complete');
  assert.equal(synthesis.generationMarker, 'generation-7');
  assert.equal(synthesis.providerTerminalValidated, true);
  assert.equal(synthesis.lastProgressAt, completed.lastProgressAt);
  await assert.rejects(executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [providerTerminal(completed, {
      eventSequence: 7,
      phase: 'synthesis',
      providerCallId: 'synthesis',
      provider: 'wrong-provider',
    })],
  }), (error) => error.code === 'provider_terminal_unproven');
  await assert.rejects(executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      providerTerminal(completed, {
        eventSequence: 7,
        phase: 'synthesis',
        providerCallId: 'synthesis',
        outcome: 'complete',
      }),
      providerTerminal(completed, {
        eventSequence: 8,
        phase: 'synthesis',
        providerCallId: 'synthesis',
        outcome: 'failed',
      }),
    ],
  }), (error) => error.code === 'provider_terminal_unproven');

  const disabled = await executeScenario({
    scenario: 'mcp-unavailable', modules: {}, client: {},
    values: { ...values, 'expect-reason': 'mcp_disabled' }, context: state.context,
    baseUrl: 'http://isolated', callerAgent: 'jerry', signal: new AbortController().signal,
    fetchImpl: async () => new Response(JSON.stringify({ mcp: { reason: 'mcp_disabled' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal(disabled.reason, 'mcp_disabled');
  const unreachable = await executeScenario({
    scenario: 'mcp-unavailable', modules: {}, client: {},
    values: { ...values, 'expect-reason': 'mcp_unreachable' }, context: state.context,
    baseUrl: 'http://isolated', callerAgent: 'jerry', signal: new AbortController().signal,
    fetchImpl: async () => { throw new TypeError('connection refused'); },
  });
  assert.equal(unreachable.reason, 'mcp_unreachable');
});

test('receipt verification rejects duplicate terminal rows and conflicting identity metadata', async (t) => {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    projectProtectedResult,
    verifyReceiptManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const { BrainOperationStore } = require('../../engine/src/dashboard/brain-operations/operation-store.js');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const urls = {
    jerry: 'http://jerry.fixture',
    forrest: 'http://forrest.fixture',
    cosmo: 'http://127.0.0.1:43210',
  };
  const boundaries = (root) => ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency']
    .map((kind) => ({ kind, path: kind === 'brain' || kind === 'run' ? root : path.join(root, kind) }));
  const target = (agent) => ({
    domain: 'brain', brainId: `brain-${agent}`, canonicalRoot: `/fixture/${agent}/brain`,
    accessMode: 'own', ownerAgent: agent, displayName: agent, kind: 'resident',
    lifecycle: 'resident', catalogRevision: 'catalog-fixture-v1', route: `/api/brain/${agent}`,
    mutationBoundaries: boundaries(`/fixture/${agent}/brain`),
  });
  const sourceEvidence = (agent, operationId) => ({
    selectedAgent: agent, selectedBrain: `brain-${agent}`, route: 'fixture-readback',
    identity: { requesterAgent: agent, targetAgent: agent, brainId: `brain-${agent}`, operationId },
    deltaWatermark: { revision: 7, epoch: 'e7', appliedRecords: 0 },
    authoritativeTotals: { nodes: 3, edges: 2 }, returnedTotals: { nodes: 1, edges: 0 },
    sourceHealth: 'healthy', matchOutcome: 'matches',
  });
  const liveRecord = (agent, letter) => {
    const operationId = `brop_${letter.repeat(32)}`;
    return operation({
      operationId, requesterAgent: agent, target: target(agent), result: {}, resultHandle: null,
      sourceEvidence: sourceEvidence(agent, operationId),
    });
  };
  const jerry = liveRecord('jerry', 'J');
  const jerrySecond = liveRecord('jerry', 'K');
  const forrest = liveRecord('forrest', 'F');
  const store = new BrainOperationStore({ root: state.isolatedStore, requesterAgent: 'fixture-agent' });
  const created = await store.create({
    requestId: 'isolated-receipt-fixture', requesterAgent: 'fixture-agent',
    target: target('fixture-agent'), operationType: 'query',
    requestParameters: { query: 'receipt fixture' }, parameters: { query: 'receipt fixture' },
    sourcePinDescriptor: null, sourcePinDigest: null, canonicalEvidence: true,
  });
  const withResult = await store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion, result: {},
  });
  const isolatedEvidence = sourceEvidence('fixture-agent', created.record.operationId);
  const isolated = {
    ...(await store.transition(created.record.operationId, {
      expectedVersion: withResult.recordVersion, state: 'complete', phase: 'terminal',
      error: null, sourceEvidence: isolatedEvidence,
    })),
    result: {}, sourceEvidence: isolatedEvidence,
  };
  const receiptRow = (context, record, authorizedEndpoint, isolatedStore) => canonicalReceiptRow(context, {
    helper: 'live-brain-tools-smoke', scenario: 'direct-query', receiptKind: 'operation-terminal',
    operationId: record.operationId, operationType: 'query', state: 'complete',
    protectedResultRead: true, requesterAgent: record.requesterAgent,
    authorizedEndpoint, isolatedStore, target: record.target, resultHandle: record.resultHandle,
    resultArtifact: record.resultArtifact, sourcePinDescriptor: record.sourcePinDescriptor,
    sourcePinDigest: record.sourcePinDigest, sourceEvidence: record.sourceEvidence,
    lastProgressAt: record.lastProgressAt ?? null,
    error: record.error, result: projectProtectedResult(record.result),
  });
  const jerryReceipt = path.join(state.context.receiptRunDir, 'jerry.jsonl');
  const forrestReceipt = path.join(state.context.receiptRunDir, 'forrest.jsonl');
  const isolatedReceipt = path.join(state.context.receiptRunDir, 'isolated.jsonl');
  const terminalRow = receiptRow(state.context, jerry, urls.jerry, null);
  const secondTerminalRow = receiptRow(state.context, jerrySecond, urls.jerry, null);
  await fs.writeFile(
    jerryReceipt,
    `${JSON.stringify(terminalRow)}\n${JSON.stringify(secondTerminalRow)}\n`,
  );
  await fs.writeFile(forrestReceipt, `${JSON.stringify(receiptRow(
    state.context, forrest, urls.forrest, null,
  ))}\n`);
  await fs.writeFile(isolatedReceipt, `${JSON.stringify(receiptRow(
    { ...state.context, authority: 'isolated-controlled' }, isolated, null, state.isolatedStore,
  ))}\n`);
  const manifest = path.join(state.context.receiptRunDir, 'identity.json');
  await fs.writeFile(manifest, JSON.stringify({
    schemaVersion: 1, receiptRunId: state.context.receiptRunId,
    authorities: ['live', 'isolated-controlled'], auditRoot: state.context.receiptRunDir,
    createdAt: '2026-07-10T00:00:00.000Z',
    groups: {
      jerryLive: [{ operationId: jerry.operationId, authority: 'live', requesterAgent: 'jerry',
        receipt: 'jerry.jsonl', isolatedStore: null, authorizedEndpoint: urls.jerry },
      { operationId: jerrySecond.operationId, authority: 'live', requesterAgent: 'jerry',
        receipt: 'jerry.jsonl', isolatedStore: null, authorizedEndpoint: urls.jerry }],
      forrestLive: [{ operationId: forrest.operationId, authority: 'live', requesterAgent: 'forrest',
        receipt: 'forrest.jsonl', isolatedStore: null, authorizedEndpoint: urls.forrest }],
      isolatedControlled: [{ operationId: isolated.operationId, authority: 'isolated-controlled',
        requesterAgent: 'fixture-agent', receipt: 'isolated.jsonl',
        isolatedStore: state.isolatedStore, authorizedEndpoint: null }],
    },
  }));
  const liveRecords = new Map([
    [urls.jerry, new Map([
      [jerry.operationId, jerry],
      [jerrySecond.operationId, jerrySecond],
    ])],
    [urls.forrest, new Map([[forrest.operationId, forrest]])],
  ]);
  const clientFactory = ({ baseUrl, callerAgent }) => ({
    async inspectOperation(operationId) {
      const record = liveRecords.get(baseUrl)?.get(operationId);
      if (!record || record.requesterAgent !== callerAgent) {
        throw Object.assign(new Error('access_denied'), { code: 'access_denied' });
      }
      return record;
    },
  });
  const verify = () => verifyReceiptManifest({
    manifestPath: manifest, modules: {}, context: state.context,
    values: {
      'base-url': urls.jerry,
      'forrest-base-url': urls.forrest,
      'cosmo-base-url': urls.cosmo,
    },
    callerAgent: 'jerry', signal: new AbortController().signal, clientFactory,
    fetchImpl: async () => new Response(JSON.stringify({
      success: false,
      error: { code: 'capability_invalid', message: 'capability_invalid' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  const valid = await verify();
  assert.equal(valid.observed.length, 4);

  const extensionlessUnlisted = path.join(
    state.context.receiptRunDir,
    'extensionless-unlisted-terminal',
  );
  const unlisted = receiptRow(state.context, liveRecord('jerry', 'U'), urls.jerry, null);
  await fs.writeFile(extensionlessUnlisted, `${JSON.stringify(unlisted)}\n`);
  await assert.rejects(
    verify(),
    (error) => error.code === 'identity_manifest_unlisted_operation',
  );
  await fs.rm(extensionlessUnlisted);

  const wrongCommitRow = receiptRow(
    { ...state.context, implementationCommit: 'd'.repeat(40) },
    jerry,
    urls.jerry,
    null,
  );
  await fs.writeFile(jerryReceipt, `${JSON.stringify(wrongCommitRow)}\n`);
  await assert.rejects(
    verify(),
    (error) => error.code === 'receipt_implementation_commit_mismatch',
  );
  await fs.writeFile(
    jerryReceipt,
    `${JSON.stringify(terminalRow)}\n${JSON.stringify(secondTerminalRow)}\n`,
  );

  await fs.appendFile(jerryReceipt, `${JSON.stringify(terminalRow)}\n`);
  await assert.rejects(verify(), (error) => error.code === 'receipt_terminal_duplicate');

  const conflictingEvent = canonicalReceiptRow({ ...state.context, authority: 'isolated-controlled' }, {
    helper: 'live-brain-tools-smoke', scenario: 'direct-query', receiptKind: 'operation-event',
    operationId: jerry.operationId, requesterAgent: 'jerry', protectedResultRead: false,
  });
  await fs.writeFile(jerryReceipt, `${JSON.stringify(conflictingEvent)}\n${JSON.stringify(terminalRow)}\n`);
  await assert.rejects(verify(), (error) => error.code === 'receipt_authority_mismatch');
});

test('artifact manifests discover canonical receipts from content without a JSON filename extension', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest, verifyArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await writeRequiredGuardedPm2Transactions(state);
  for (const [basename, suffix] of [
    ['canonical-operation-receipt', 'E'],
    ['canonical-operation-receipt.txt', 'T'],
  ]) {
    await writeJsonReceipt(state.context, path.join(state.context.receiptRunDir, 'live', basename), {
      helper: 'fixture', receiptKind: 'operation-terminal',
      operationId: `brop_${suffix.repeat(32)}`, operationType: 'search', state: 'complete',
      requesterAgent: 'jerry', protectedResultRead: true,
      authorizedEndpoint: 'http://fixture', isolatedStore: null,
    });
  }
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  const manifest = await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  assert.equal(
    manifest.artifacts.find((entry) => entry.path === 'live/canonical-operation-receipt')?.kind,
    'receipt',
  );
  assert.equal(
    manifest.artifacts.find((entry) => entry.path === 'live/canonical-operation-receipt.txt')?.kind,
    'receipt',
  );
  assert.equal((await verifyArtifactManifest({ manifestPath, context: state.context })).ok, true);
});

test('artifact manifest verification requires exact mode-0600 manifest and digest files', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest, verifyArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  for (const changed of ['manifest', 'digest']) {
    const state = await fixture();
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    await writeRequiredGuardedPm2Transactions(state);
    await writeJsonReceipt(
      state.context,
      path.join(state.context.receiptRunDir, 'live', `mode-operation-${changed}.json`),
      {
        helper: 'fixture', receiptKind: 'operation-terminal',
        operationId: `brop_${(changed === 'manifest' ? 'U' : 'V').repeat(32)}`,
        operationType: 'search', state: 'complete', requesterAgent: 'jerry',
        protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
      },
    );
    await writeOperationIdentityManifest(state);
    const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
    await buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: manifestPath,
      context: state.context,
    });
    const changedPath = changed === 'manifest'
      ? manifestPath
      : path.join(state.context.receiptRunDir, 'artifact-manifest.sha256');
    await fs.chmod(changedPath, 0o644);
    await assert.rejects(
      verifyArtifactManifest({ manifestPath, context: state.context }),
      (error) => error.code === 'artifact_manifest_invalid',
    );
  }
});

test('artifact manifests fail closed on malformed extensionless canonical receipt candidates', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await writeRequiredGuardedPm2Transactions(state);
  await writeJsonReceipt(
    state.context,
    path.join(state.context.receiptRunDir, 'live', 'operation.json'),
    {
      helper: 'fixture', receiptKind: 'operation-terminal',
      operationId: `brop_${'M'.repeat(32)}`, operationType: 'search', state: 'complete',
      requesterAgent: 'jerry', protectedResultRead: true,
      authorizedEndpoint: 'http://fixture', isolatedStore: null,
    },
  );
  await fs.writeFile(
    path.join(state.context.receiptRunDir, 'live', 'malformed-canonical-receipt'),
    '{"helper":"fixture","receiptKind":"operation-terminal","artifactSha256":',
  );
  await assert.rejects(buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
    context: state.context,
  }), (error) => error.code === 'artifact_json_invalid');
});

test('artifact manifests reject stripped canonical operation receipt candidates', async (t) => {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await writeRequiredGuardedPm2Transactions(state);
  const canonical = canonicalReceiptRow(state.context, {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'W'.repeat(32)}`, operationType: 'search', state: 'complete',
    requesterAgent: 'jerry', protectedResultRead: true,
    authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  const { artifactSha256: _artifactSha256, ...stripped } = canonical;
  await fs.writeFile(
    path.join(state.context.receiptRunDir, 'live', 'stripped-operation-receipt.json'),
    `${JSON.stringify(stripped)}\n`,
  );

  await assert.rejects(buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
    context: state.context,
  }), (error) => error.code === 'artifact_receipt_invalid');
});

test('artifact manifest fails closed on malformed JSON and verifies detached digest, tags, hashes, and identities', async (t) => {
  const {
    canonicalReceiptRow,
    hashFile,
    sha256Bytes,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    main,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');

  const malformed = await fixture();
  t.after(() => fs.rm(malformed.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(malformed.context.receiptRunDir, 'live'), { mode: 0o700 });
  await fs.writeFile(path.join(malformed.context.receiptRunDir, 'live', 'broken.json'), '{broken');
  await assert.rejects(buildArtifactManifest({
    smokeRoot: malformed.context.receiptRunDir,
    output: path.join(malformed.context.receiptRunDir, 'artifact-manifest.json'),
    context: malformed.context,
  }), (error) => error.code === 'artifact_json_invalid');

  const emptyInventory = await fixture();
  t.after(() => fs.rm(emptyInventory.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(emptyInventory.context.receiptRunDir, 'live'), { mode: 0o700 });
  await fs.writeFile(path.join(emptyInventory.context.receiptRunDir, 'live', 'raw.txt'), 'raw only\n');
  await assert.rejects(buildArtifactManifest({
    smokeRoot: emptyInventory.context.receiptRunDir,
    output: path.join(emptyInventory.context.receiptRunDir, 'artifact-manifest.json'),
    context: emptyInventory.context,
  }), (error) => error.code === 'operation_inventory_empty');

  const wrongVerifyState = await fixture();
  t.after(() => fs.rm(wrongVerifyState.root, { recursive: true, force: true }));
  const wrongVerifyLive = path.join(wrongVerifyState.context.receiptRunDir, 'live');
  await fs.mkdir(wrongVerifyLive, { mode: 0o700 });
  const wrongVerifyContext = {
    ...wrongVerifyState.context,
    implementationCommit: 'd'.repeat(40),
  };
  await fs.writeFile(path.join(wrongVerifyLive, 'operation.jsonl'), `${JSON.stringify(
    canonicalReceiptRow(wrongVerifyContext, {
      helper: 'fixture', receiptKind: 'operation-terminal', operationId: 'op_verify_wrong_commit_0001',
      operationType: 'query', state: 'complete', requesterAgent: 'jerry',
      protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
    }),
  )}\n`);
  const wrongVerifyAuthorityPath = path.join(
    wrongVerifyState.context.receiptRunDir,
    'run-authority.json',
  );
  const wrongVerifyAuthority = JSON.parse(await fs.readFile(wrongVerifyAuthorityPath, 'utf8'));
  wrongVerifyAuthority.implementationCommit = wrongVerifyContext.implementationCommit;
  await fs.writeFile(wrongVerifyAuthorityPath, `${JSON.stringify(wrongVerifyAuthority, null, 2)}\n`);
  const wrongVerifyManifest = path.join(
    wrongVerifyState.context.receiptRunDir,
    'artifact-manifest.json',
  );
  await assert.rejects(
    buildArtifactManifest({
      smokeRoot: wrongVerifyState.context.receiptRunDir,
      output: wrongVerifyManifest,
      context: wrongVerifyContext,
    }),
    (error) => error.code === 'receipt_context_invalid',
  );

  const wrongRawBuild = await fixture();
  t.after(() => fs.rm(wrongRawBuild.root, { recursive: true, force: true }));
  const wrongRawBuildLive = path.join(wrongRawBuild.context.receiptRunDir, 'live');
  await fs.mkdir(wrongRawBuildLive, { mode: 0o700 });
  await fs.writeFile(path.join(wrongRawBuildLive, 'operation.jsonl'), `${JSON.stringify(
    canonicalReceiptRow(wrongRawBuild.context, {
      helper: 'fixture', receiptKind: 'operation-terminal', operationId: 'op_raw_build_commit_0001',
      operationType: 'query', state: 'complete', requesterAgent: 'jerry',
      protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
    }),
  )}\n`);
  const wrongRawBuildAuthority = path.join(
    wrongRawBuild.context.receiptRunDir,
    'run-authority.json',
  );
  const wrongRawBuildRow = JSON.parse(await fs.readFile(wrongRawBuildAuthority, 'utf8'));
  wrongRawBuildRow.implementationCommit = 'd'.repeat(40);
  await fs.writeFile(wrongRawBuildAuthority, `${JSON.stringify(wrongRawBuildRow, null, 2)}\n`);
  await assert.rejects(buildArtifactManifest({
    smokeRoot: wrongRawBuild.context.receiptRunDir,
    output: path.join(wrongRawBuild.context.receiptRunDir, 'artifact-manifest.json'),
    context: wrongRawBuild.context,
  }), (error) => error.code === 'receipt_run_authority_changed');

  const wrongRawVerify = await fixture();
  t.after(() => fs.rm(wrongRawVerify.root, { recursive: true, force: true }));
  const wrongRawVerifyLive = path.join(wrongRawVerify.context.receiptRunDir, 'live');
  await fs.mkdir(wrongRawVerifyLive, { mode: 0o700 });
  await fs.writeFile(path.join(wrongRawVerifyLive, 'operation.jsonl'), `${JSON.stringify(
    canonicalReceiptRow(wrongRawVerify.context, {
      helper: 'fixture', receiptKind: 'operation-terminal', operationId: `brop_${'V'.repeat(32)}`,
      operationType: 'query', state: 'complete', requesterAgent: 'jerry',
      protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
    }),
  )}\n`);
  const wrongRawVerifyManifest = path.join(
    wrongRawVerify.context.receiptRunDir,
    'artifact-manifest.json',
  );
  await writeRequiredGuardedPm2Transactions(wrongRawVerify);
  await writeOperationIdentityManifest(wrongRawVerify);
  await buildArtifactManifest({
    smokeRoot: wrongRawVerify.context.receiptRunDir,
    output: wrongRawVerifyManifest,
    context: wrongRawVerify.context,
  });
  const wrongRawVerifyAuthority = path.join(
    wrongRawVerify.context.receiptRunDir,
    'run-authority.json',
  );
  const wrongRawVerifyRow = JSON.parse(await fs.readFile(wrongRawVerifyAuthority, 'utf8'));
  wrongRawVerifyRow.implementationCommit = 'd'.repeat(40);
  await fs.writeFile(wrongRawVerifyAuthority, `${JSON.stringify(wrongRawVerifyRow, null, 2)}\n`);
  const changedAuthority = await hashFile(wrongRawVerifyAuthority);
  const wrongRawManifestRow = JSON.parse(await fs.readFile(wrongRawVerifyManifest, 'utf8'));
  const authorityEntry = wrongRawManifestRow.artifacts.find(
    (entry) => entry.path === 'run-authority.json',
  );
  assert.ok(authorityEntry);
  Object.assign(authorityEntry, {
    size: changedAuthority.physicalSize,
    sha256: changedAuthority.sha256,
    dev: changedAuthority.dev,
    ino: changedAuthority.ino,
    mtimeNs: changedAuthority.mtimeNs,
    ctimeNs: changedAuthority.ctimeNs,
  });
  const resealedManifest = canonicalReceiptRow(
    wrongRawVerify.context,
    wrongRawManifestRow,
    wrongRawManifestRow.completedAt,
  );
  const resealedBytes = Buffer.from(`${JSON.stringify(resealedManifest, null, 2)}\n`);
  await fs.writeFile(wrongRawVerifyManifest, resealedBytes);
  await fs.writeFile(
    path.join(wrongRawVerify.context.receiptRunDir, 'artifact-manifest.sha256'),
    `${sha256Bytes(resealedBytes)}  artifact-manifest.json\n`,
  );
  await assert.rejects(verifyArtifactManifest({
    manifestPath: wrongRawVerifyManifest,
    context: wrongRawVerify.context,
  }), (error) => error.code === 'receipt_run_authority_changed');

  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  const isolated = path.join(state.context.receiptRunDir, 'isolated-controlled');
  await fs.mkdir(live, { mode: 0o700 });
  await fs.mkdir(isolated, { mode: 0o700 });
  const liveReceipt = canonicalReceiptRow(state.context, {
    helper: 'fixture', receiptKind: 'operation-terminal', operationId: `brop_${'X'.repeat(32)}`,
    operationType: 'query', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  const isolatedReceipt = canonicalReceiptRow(state.isolatedContext, {
    helper: 'fixture', receiptKind: 'operation-terminal', operationId: `brop_${'Y'.repeat(32)}`,
    operationType: 'query', state: 'complete', requesterAgent: 'acceptance-fixture',
    protectedResultRead: true, authorizedEndpoint: null, isolatedStore: state.isolatedStore,
  });
  await fs.writeFile(path.join(live, 'operation.jsonl'), `${JSON.stringify(liveReceipt)}\n`);
  await fs.writeFile(path.join(isolated, 'operation.jsonl'), `${JSON.stringify(isolatedReceipt)}\n`);
  await fs.writeFile(path.join(live, 'raw.txt'), 'third-party capture\n');
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  const built = await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  assert.equal(built.artifacts.length, 12);
  assert.ok(built.artifacts.every((entry) => entry.receiptRunId === state.context.receiptRunId
    && ['live', 'isolated-controlled'].includes(entry.authority)
    && entry.dev && entry.ino && Number.isSafeInteger(entry.nlink)
    && /^[a-f0-9]{64}$/.test(entry.sha256)));
  const verified = await verifyArtifactManifest({ manifestPath, context: state.context });
  assert.equal(verified.artifactCount, 12);
  const inventory = async () => {
    const names = (await fs.readdir(state.context.receiptRunDir, { recursive: true })).sort();
    return Promise.all(names.map(async (name) => {
      const absolute = path.join(state.context.receiptRunDir, name);
      const stat = await fs.lstat(absolute, { bigint: true });
      return {
        name,
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      };
    }));
  };
  const beforeCliVerification = await inventory();
  const cliVerified = await main([
    '--receipt-run-dir', state.context.receiptRunDir,
    '--receipt-run-id', state.context.receiptRunId,
    '--authority', state.context.authority,
    '--scenario', 'verify-receipts',
    '--verify-artifact-manifest',
    '--artifact-manifest', manifestPath,
  ], {});
  assert.equal(cliVerified.receiptKind, 'artifact-manifest-verification');
  assert.equal(cliVerified.ok, true);
  assert.deepEqual(await inventory(), beforeCliVerification);
  const refusedOutput = path.join(state.context.receiptRunDir, 'verification.json');
  await assert.rejects(main([
    '--receipt-run-dir', state.context.receiptRunDir,
    '--receipt-run-id', state.context.receiptRunId,
    '--authority', state.context.authority,
    '--scenario', 'verify-receipts',
    '--verify-artifact-manifest',
    '--artifact-manifest', manifestPath,
    '--output', refusedOutput,
  ], {}), (error) => error.code === 'artifact_manifest_verification_read_only');
  await assert.rejects(fs.lstat(refusedOutput), (error) => error.code === 'ENOENT');
  await assert.rejects(main([
    '--receipt-run-dir', state.context.receiptRunDir,
    '--receipt-run-id', state.context.receiptRunId,
    '--authority', state.context.authority,
    '--scenario', 'verify-receipts',
    '--build-artifact-manifest',
    '--verify-artifact-manifest',
    '--smoke-root', state.context.receiptRunDir,
    '--artifact-manifest', manifestPath,
    '--output', path.join(state.context.receiptRunDir, 'other-manifest.json'),
  ], {}), (error) => error.code === 'artifact_manifest_mode_conflict');
  await fs.appendFile(path.join(live, 'raw.txt'), 'tamper');
  await assert.rejects(
    verifyArtifactManifest({ manifestPath, context: state.context }),
    (error) => error.code === 'artifact_identity_mismatch',
  );

  await fs.writeFile(path.join(live, 'raw.txt'), 'third-party capture\n');
  await fs.writeFile(
    path.join(state.context.receiptRunDir, 'artifact-manifest.sha256'),
    `${'0'.repeat(64)}  artifact-manifest.json\n`,
  );
  await assert.rejects(
    verifyArtifactManifest({ manifestPath, context: state.context }),
    (error) => error.code === 'artifact_manifest_digest_mismatch',
  );
});

test('canary consumers reject duplicate terminal rows before starting a provider operation', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const canary = await canaryReceipt(state);
  const encoded = await fs.readFile(canary, 'utf8');
  await fs.appendFile(canary, encoded);
  let toolCalls = 0;
  const terminal = operation({ operationId: `brop_${'D'.repeat(32)}` });
  await assert.rejects(executeScenario({
    scenario: 'direct-query',
    modules: {
      brainQueryTool: {
        async execute() {
          toolCalls += 1;
          return { content: 'unexpected', metadata: { operationId: terminal.operationId } };
        },
      },
    },
    client: { async inspectOperation() { return terminal; } },
    values: { 'canary-receipt': canary },
    context: state.context,
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [providerTerminal(terminal)],
  }), (error) => error.code === 'receipt_terminal_duplicate');
  assert.equal(toolCalls, 0);
});

test('artifact manifests preserve valid raw JSON arrays and primitives as raw evidence', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest, verifyArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  await writeJsonReceipt(state.context, path.join(live, 'operation.json'), {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'R'.repeat(32)}`, operationType: 'search', state: 'complete',
    requesterAgent: 'jerry', protectedResultRead: true,
    authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  await fs.writeFile(path.join(live, 'pm2-processes.json'), '[{"name":"one"},{"name":"two"}]\n');
  await fs.writeFile(path.join(live, 'provider-exit.json'), '7\n');
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  const manifest = await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  for (const relative of ['live/pm2-processes.json', 'live/provider-exit.json']) {
    assert.equal(manifest.artifacts.find((entry) => entry.path === relative)?.kind, 'raw');
  }
  assert.equal((await verifyArtifactManifest({ manifestPath, context: state.context })).ok, true);
});

test('content-based receipt discovery preserves bounded classification of large raw artifacts', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest, verifyArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  await writeJsonReceipt(state.context, path.join(live, 'operation.json'), {
    helper: 'fixture', receiptKind: 'operation-terminal',
    operationId: `brop_${'L'.repeat(32)}`, operationType: 'search', state: 'complete',
    requesterAgent: 'jerry', protectedResultRead: true,
    authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const largeRaw = path.join(live, 'large-test-output.tap');
  await fs.writeFile(largeRaw, 'TAP version 13\n');
  await fs.truncate(largeRaw, 32 * 1024 * 1024 + 1);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  const manifest = await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  assert.equal(manifest.artifacts.find((entry) => entry.path === 'live/large-test-output.tap')?.kind, 'raw');
  assert.equal((await verifyArtifactManifest({ manifestPath, context: state.context })).ok, true);
});

test('artifact verification rechecks every earlier artifact after later semantic reads', async (t) => {
  const {
    readBoundedFile,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest, verifyArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  await fs.mkdir(live, { mode: 0o700 });
  const first = path.join(live, 'a.json');
  const second = path.join(live, 'b.json');
  for (const [file, suffix] of [[first, 'A'], [second, 'B']]) {
    await writeJsonReceipt(state.context, file, {
      helper: 'fixture', receiptKind: 'operation-terminal',
      operationId: `brop_${suffix.repeat(32)}`, operationType: 'search', state: 'complete',
      requesterAgent: 'jerry', protectedResultRead: true,
      authorizedEndpoint: 'http://fixture', isolatedStore: null,
    });
  }
  await writeRequiredGuardedPm2Transactions(state);
  await writeOperationIdentityManifest(state);
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  let changed = false;
  const readBoundedFileImpl = async (file, options) => {
    const bytes = await readBoundedFile(file, options);
    if (file === second && !changed) {
      changed = true;
      await fs.appendFile(first, '\n');
    }
    return bytes;
  };
  await assert.rejects(
    verifyArtifactManifest({ manifestPath, context: state.context, readBoundedFileImpl }),
    (error) => ['artifact_identity_mismatch', 'artifact_tree_changed_concurrently']
      .includes(error.code),
  );
  assert.equal(changed, true);
});

test('healthy zero proof rejects base-only watermarks and numeric-string authority totals', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const evidence = {
    sourceHealth: 'healthy', freshness: 'known', matchOutcome: 'no_match',
    completeCoverage: true, deltaWatermark: null, baseWatermark: { revision: 7 },
    authoritativeTotals: { nodes: '10', edges: 4 }, returnedTotals: { nodes: 0, edges: 0 },
    selectedBrain: 'brain-jerry', filters: { tag: null }, limits: { topK: 100 },
    implementation: 'manifest-v1',
  };
  const terminal = operation({
    operationId: `brop_${'Z'.repeat(32)}`,
    operationType: 'search',
    target: {
      domain: 'brain', brainId: 'brain-jerry', ownerAgent: 'jerry', accessMode: 'own',
      kind: 'resident', lifecycle: 'resident',
    },
    result: { results: [] },
    sourceEvidence: evidence,
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() { return { operationId: terminal.operationId, results: [], sourceEvidence: evidence }; },
      async inspectOperation() { return terminal; },
    },
    values: { query: 'absent' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'zero_result_not_proven');
});

test('controlled auto-launch scenarios refuse caller-supplied endpoints before loading runtime code', async (t) => {
  const { main } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture('isolated-controlled');
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const isolatedRoot = path.join(state.root, 'controlled-fixture');
  await fs.mkdir(isolatedRoot, { mode: 0o700 });
  for (const scenario of ['zero-result', 'large-pgs-isolated']) {
    await assert.rejects(main([
      '--receipt-run-dir', state.context.receiptRunDir,
      '--receipt-run-id', state.context.receiptRunId,
      '--authority', 'isolated-controlled',
      '--scenario', scenario,
      '--controlled-provider',
      '--isolated-fixture', isolatedRoot,
      '--base-url', 'http://127.0.0.1:9',
      '--query', 'must not reach live',
      '--output', path.join(state.context.receiptRunDir, `${scenario}.jsonl`),
    ], {}), (error) => error.code === 'isolated_fixture_endpoint_override_refused');
  }
});

test('protected readback projection binds search, graph, research output, and last progress', async () => {
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  assert.equal(typeof smoke.projectProtectedResult, 'function');
  assert.equal(typeof smoke.assertProtectedReadback, 'function');
  const searchResult = { results: [{ id: 'node-a', score: 0.9 }] };
  const graphResult = { nodes: [{ id: 'node-a' }], edges: [{ source: 'node-a', target: 'node-a' }] };
  const compileResult = {
    provider: 'fixture', model: 'fixture-model', relativePath: 'research/result.md',
    bytes: 42, sectionSelection: { kind: 'brain' },
  };
  assert.match(smoke.projectProtectedResult(searchResult).search.resultsSha256, /^[a-f0-9]{64}$/);
  assert.match(smoke.projectProtectedResult(graphResult).graph.nodesSha256, /^[a-f0-9]{64}$/);
  assert.match(smoke.projectProtectedResult(compileResult).researchCompile.sha256, /^[a-f0-9]{64}$/);

  const base = {
    operationId: `brop_${'P'.repeat(32)}`, operationType: 'search', state: 'complete',
    target: { brainId: 'brain-jerry' }, resultHandle: null, resultArtifact: null,
    sourcePinDescriptor: null, sourcePinDigest: null, sourceEvidence: { selectedBrain: 'brain-jerry' },
    error: null, lastProgressAt: '2026-07-11T00:00:00.000Z', result: searchResult,
  };
  const receipt = {
    ...base,
    result: smoke.projectProtectedResult(searchResult),
  };
  assert.throws(
    () => smoke.assertProtectedReadback({
      ...base,
      result: { results: [{ id: 'node-b', score: 0.9 }] },
    }, receipt, { results: [{ id: 'node-b', score: 0.9 }] }),
    (error) => error.code === 'protected_readback_mismatch',
  );
  assert.throws(
    () => smoke.assertProtectedReadback({
      ...base,
      lastProgressAt: '2026-07-11T00:00:01.000Z',
    }, receipt, searchResult),
    (error) => error.code === 'protected_readback_mismatch',
  );
});

test('isolated fixture delay proof is bound to exact accepted operations and provider actions', async () => {
  const { isolatedFixtureReceipt } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const operationId = `brop_${'D'.repeat(32)}`;
  const delayEvidence = {
    schemaVersion: 2,
    configuredDelayMs: 3000,
    effectiveDelayMs: 5,
    testOnlyDelay: true,
    capturedBeforeStop: true,
    roles: {
      cosmo: {
        providerStarts: 1,
        providerAborts: 0,
        providerDelayStarts: 1,
        providerDelayCompletions: 1,
        actions: [{
          operationId,
          phase: 'query',
          providerCallId: 'query',
          provider: 'controlled',
          model: 'controlled-query',
          configuredDelayMs: 3000,
          effectiveDelayMs: 5,
          testOnlyDelay: true,
          startedAt: '2026-07-11T00:00:00.000Z',
          completedAt: '2026-07-11T00:00:00.005Z',
          elapsedMs: 5,
          actionProven: true,
          outcome: 'complete',
        }],
      },
      dashboard: {
        providerStarts: 0,
        providerAborts: 0,
        providerDelayStarts: 0,
        providerDelayCompletions: 0,
        actions: [],
      },
    },
  };
  const receiptProvenance = {
    receiptRunDir: '/controlled/receipt-run',
    receiptRunId: 'controlled-run',
    authority: 'isolated-controlled',
    implementationCommit: 'a'.repeat(40),
    hostname: 'fixture-host',
    startedAt: '2026-07-11T00:00:00.000Z',
  };
  const ownerWithoutSeal = {
    schemaVersion: 2,
    receiptRunId: receiptProvenance.receiptRunId,
    authority: receiptProvenance.authority,
    implementationCommit: receiptProvenance.implementationCommit,
    hostname: receiptProvenance.hostname,
    receiptStartedAt: receiptProvenance.startedAt,
    canonicalRoot: '/controlled/fixture',
    basename: 'fixture',
    dev: '1',
    ino: '2',
    createdAt: '2026-07-11T00:00:00.000Z',
  };
  const owner = {
    ...ownerWithoutSeal,
    provenanceSeal: `sha256:${createHash('sha256')
      .update(canonicalJson(ownerWithoutSeal), 'utf8').digest('hex')}`,
  };
  const identity = (file, ino, sha) => ({
    path: `/controlled/fixture/runtime/isolated-fixture/${file}`,
    dev: '1', ino: String(ino), size: '64', uid: '501', mode: 0o600,
    nlink: '1', sha256: sha.repeat(64),
  });
  const exactEnvironmentKeys = [
    'HOME23_ISOLATED_FIXTURE_CHILD',
    'HOME23_ISOLATED_FIXTURE_CONFIG',
    'HOME23_ISOLATED_FIXTURE_CONFIG_DEV',
    'HOME23_ISOLATED_FIXTURE_CONFIG_INO',
    'HOME23_ISOLATED_FIXTURE_CONFIG_SHA256',
    'HOME23_ISOLATED_FIXTURE_KEY_DEV',
    'HOME23_ISOLATED_FIXTURE_KEY_INO',
    'HOME23_ISOLATED_FIXTURE_KEY_SHA256',
    'HOME23_ISOLATED_FIXTURE_LAUNCHER_PID',
    'HOME23_ISOLATED_FIXTURE_OWNER_DEV',
    'HOME23_ISOLATED_FIXTURE_OWNER_INO',
    'HOME23_ISOLATED_FIXTURE_OWNER_SHA256',
    'HOME23_ISOLATED_FIXTURE_ROOT',
    'HOME23_ISOLATED_FIXTURE_ROOT_DEV',
    'HOME23_ISOLATED_FIXTURE_ROOT_INO',
    'HOME23_ISOLATED_FIXTURE_START_TOKEN',
    'NODE_PATH',
    'PATH',
  ].sort();
  const childEnvironmentKeys = {
    dashboard: [...exactEnvironmentKeys],
    cosmo: [...exactEnvironmentKeys],
    mcp: [...exactEnvironmentKeys],
  };
  const securityBindings = {
    fixtureRoot: { path: '/controlled/fixture', dev: '1', ino: '2' },
    owner: {
      ...identity('fixture-owner.json', 3, '1'),
      path: '/controlled/fixture/fixture-owner.json',
    },
    capabilityKey: identity('capability.key', 4, '2'),
    configs: {
      dashboard: identity('dashboard.json', 5, '3'),
      cosmo: identity('cosmo.json', 6, '4'),
      mcp: identity('mcp.json', 7, '5'),
    },
    ready: {
      dashboard: identity('dashboard.ready.json', 8, '6'),
      cosmo: identity('cosmo.ready.json', 9, '7'),
      mcp: identity('mcp.ready.json', 10, '8'),
    },
  };
  const fixture = {
    fixtureRoot: '/controlled/fixture',
    owner,
    receiptProvenance,
    launcherPid: 99,
    startToken: '11111111-2222-4333-8444-555555555555',
    pids: { dashboard: 101, cosmo: 102, mcp: 103 },
    ports: { dashboard: 5101, cosmo: 5102, mcp: 5103 },
    operationsRoot: '/controlled/store',
    source: { sourceHashes: { manifest: 'a'.repeat(64) } },
    configuredOperationDelayMs: 3000,
    effectiveOperationDelayMs: 5,
    testOnlyOperationDelay: true,
    operationDelayEvidence: delayEvidence,
    childEnvironmentKeys,
    securityBindings,
  };
  const cleanStop = (role, pid) => ({
    role, pid, expectedPid: pid, code: 0, signal: null, exited: true,
    cleanExit: true, forcedKill: false, terminationRequested: true,
    signalDeliveryObserved: true, outcome: 'clean-exit',
  });
  const stopped = {
    dashboard: cleanStop('dashboard', 101),
    cosmo: cleanStop('cosmo', 102),
    mcp: cleanStop('mcp', 103),
    retainedStore: '/controlled/store',
    securityEvidence: {
      ownerProvenance: owner,
      receiptProvenance,
      launcherPid: 99,
      startToken: '11111111-2222-4333-8444-555555555555',
      securityBindings,
      childEnvironmentKeys,
    },
  };
  const acceptedRows = [{
    receiptKind: 'operation-terminal',
    protectedResultRead: true,
    operationId,
    operationType: 'query',
    state: 'complete',
    completedAt: '2026-07-11T00:00:00.010Z',
  }];
  const operationEvents = [{
    operationId,
    type: 'provider_selected',
    eventSequence: 10,
    phase: 'query',
    provider: 'controlled',
    model: 'controlled-query',
    providerCallId: 'query',
    at: '2026-07-11T00:00:00.001Z',
  }, {
    operationId,
    type: 'provider_activity',
    eventSequence: 12,
    phase: 'query',
    provider: 'controlled',
    model: 'controlled-query',
    providerCallId: 'query',
    providerEventType: 'controlled_provider_progress',
    providerEventAt: '2026-07-11T00:00:00.005Z',
    at: '2026-07-11T00:00:00.006Z',
  }, {
    operationId,
    type: 'provider_call_terminal',
    eventSequence: 13,
    phase: 'query',
    provider: 'controlled',
    model: 'controlled-query',
    providerCallId: 'query',
    outcome: 'complete',
    at: '2026-07-11T00:00:00.007Z',
  }];
  const receipt = isolatedFixtureReceipt(
    fixture, stopped, { unchanged: true }, 'detach-reattach',
    { acceptedRows, operationEvents },
  );
  assert.equal(receipt.configuredOperationDelayMs, 3000);
  assert.equal(receipt.effectiveOperationDelayMs, 5);
  assert.equal(receipt.testOnlyOperationDelay, true);
  assert.deepEqual(receipt.ownerProvenance, owner);
  assert.deepEqual(receipt.receiptProvenance, receiptProvenance);
  assert.equal(receipt.launcherPid, 99);
  assert.equal(receipt.startToken, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(receipt.securityBindings, securityBindings);
  assert.deepEqual(receipt.childEnvironmentKeys, childEnvironmentKeys);
  assert.deepEqual(receipt.shutdown, {
    dashboard: cleanStop('dashboard', 101),
    cosmo: cleanStop('cosmo', 102),
    mcp: cleanStop('mcp', 103),
  });
  assert.equal(receipt.operationDelayEvidence.actionBeforeTerminalProven, true);
  assert.deepEqual(receipt.operationDelayEvidence.acceptedOperations, [{
    operationId,
    operationType: 'query',
    role: 'cosmo',
    terminalState: 'complete',
    terminalCompletedAt: '2026-07-11T00:00:00.010Z',
    actionRequired: true,
    actionBeforeTerminalProven: true,
    actions: [{
      operationId,
      role: 'cosmo',
      phase: 'query',
      provider: 'controlled',
      model: 'controlled-query',
      providerCallId: 'query',
      outcome: 'complete',
      configuredDelayMs: 3000,
      effectiveDelayMs: 5,
      selectedEventSequence: 10,
      startedAt: '2026-07-11T00:00:00.000Z',
      completedEventSequence: 12,
      completedAt: '2026-07-11T00:00:00.005Z',
      providerTerminalEventSequence: 13,
      providerTerminalAt: '2026-07-11T00:00:00.007Z',
      elapsedMs: 5,
      actionBeforeTerminalProven: true,
    }],
  }]);

  // Wall time can be adjusted backwards while a long acceptance run is in
  // flight. The controlled child records the delay with a monotonic clock;
  // keep wall timestamps ordered, but do not demand that they independently
  // prove the same duration.
  const monotonicDelayFixture = {
    ...fixture,
    operationDelayEvidence: {
      ...delayEvidence,
      roles: {
        ...delayEvidence.roles,
        cosmo: {
          ...delayEvidence.roles.cosmo,
          actions: [{
            ...delayEvidence.roles.cosmo.actions[0],
            completedAt: '2026-07-11T00:00:00.004Z',
            elapsedMs: 5.25,
          }],
        },
      },
    },
  };
  const monotonicDelayEvents = operationEvents.map((event) => (
    event.eventSequence === 12
      ? { ...event, providerEventAt: '2026-07-11T00:00:00.004Z' }
      : event
  ));
  const monotonicDelayReceipt = isolatedFixtureReceipt(
    monotonicDelayFixture,
    stopped,
    { unchanged: true },
    'large-pgs-isolated',
    {
      acceptedRows: [{ ...acceptedRows[0], operationType: 'pgs' }],
      operationEvents: monotonicDelayEvents,
    },
  );
  assert.equal(
    monotonicDelayReceipt.operationDelayEvidence.acceptedOperations[0].actions[0].elapsedMs,
    5.25,
  );

  // Wall timestamps still have to preserve causal ordering even though the
  // monotonic timer is the duration authority.
  const backwardsWallClockFixture = {
    ...fixture,
    operationDelayEvidence: {
      ...delayEvidence,
      roles: {
        ...delayEvidence.roles,
        cosmo: {
          ...delayEvidence.roles.cosmo,
          actions: [{
            ...delayEvidence.roles.cosmo.actions[0],
            completedAt: '2026-07-10T23:59:59.999Z',
          }],
        },
      },
    },
  };
  assert.throws(
    () => isolatedFixtureReceipt(
      backwardsWallClockFixture,
      stopped,
      { unchanged: true },
      'large-pgs-isolated',
      {
        acceptedRows: [{ ...acceptedRows[0], operationType: 'pgs' }],
        operationEvents: operationEvents.map((event) => event.eventSequence === 12
          ? { ...event, providerEventAt: '2026-07-10T23:59:59.999Z' }
          : event),
      },
    ),
    (error) => error.code === 'isolated_fixture_delay_unproven'
      && error.proofReason === 'complete_event_order_or_time',
  );

  // A successful action flag cannot substitute for the monotonic delay proof.
  const shortMonotonicFixture = {
    ...fixture,
    operationDelayEvidence: {
      ...delayEvidence,
      roles: {
        ...delayEvidence.roles,
        cosmo: {
          ...delayEvidence.roles.cosmo,
          actions: [{
            ...delayEvidence.roles.cosmo.actions[0],
            elapsedMs: 4.99,
            actionProven: true,
          }],
        },
      },
    },
  };
  assert.throws(
    () => isolatedFixtureReceipt(
      shortMonotonicFixture,
      stopped,
      { unchanged: true },
      'large-pgs-isolated',
      {
        acceptedRows: [{ ...acceptedRows[0], operationType: 'pgs' }],
        operationEvents,
      },
    ),
    (error) => error.code === 'isolated_fixture_delay_unproven'
      && error.proofReason === 'complete_event_order_or_time',
  );

  const completePgsReceipt = isolatedFixtureReceipt(
    fixture, stopped, { unchanged: true }, 'large-pgs-isolated', {
      acceptedRows: [{ ...acceptedRows[0], operationType: 'pgs' }],
      operationEvents,
    },
  );
  assert.equal(
    completePgsReceipt.operationDelayEvidence.acceptedOperations[0].terminalState,
    'complete',
  );

  for (const invalidStopped of [
    {
      ...stopped,
      dashboard: { ...stopped.dashboard, pid: 999, expectedPid: 999 },
    },
    {
      ...stopped,
      mcp: {
        ...stopped.mcp,
        code: 1,
        cleanExit: false,
        outcome: 'crashed',
      },
    },
    {
      ...stopped,
      cosmo: {
        ...stopped.cosmo,
        code: null,
        signal: 'SIGKILL',
        cleanExit: false,
        forcedKill: true,
        outcome: 'forced-kill',
      },
    },
  ]) {
    assert.throws(
      () => isolatedFixtureReceipt(
        fixture, invalidStopped, { unchanged: true }, 'detach-reattach',
        { acceptedRows, operationEvents },
      ),
      (error) => error.code === 'isolated_fixture_shutdown_unproven',
    );
  }

  for (const [fixtureOverride, stoppedOverride] of [
    [{ ...fixture, owner: { ...owner, provenanceSeal: `sha256:${'f'.repeat(64)}` } }, stopped],
    [fixture, {
      ...stopped,
      securityEvidence: {
        ...stopped.securityEvidence,
        securityBindings: {
          ...securityBindings,
          capabilityKey: { ...securityBindings.capabilityKey, sha256: 'f'.repeat(64) },
        },
      },
    }],
    [{
      ...fixture,
      childEnvironmentKeys: {
        ...childEnvironmentKeys,
        cosmo: [...childEnvironmentKeys.cosmo, 'OPENAI_API_KEY'],
      },
    }, stopped],
  ]) {
    assert.throws(
      () => isolatedFixtureReceipt(
        fixtureOverride, stoppedOverride, { unchanged: true }, 'detach-reattach',
        { acceptedRows, operationEvents },
      ),
      (error) => error.code === 'isolated_fixture_security_unproven',
    );
  }

  assert.throws(
    () => isolatedFixtureReceipt(
      fixture, stopped, { unchanged: true }, 'detach-reattach',
      {
        acceptedRows,
        operationEvents: operationEvents.map((event) => ({
          ...event,
          operationId: `brop_${'U'.repeat(32)}`,
        })),
      },
    ),
    (error) => error.code === 'isolated_fixture_delay_unproven',
  );

  assert.throws(
    () => isolatedFixtureReceipt(
      fixture, stopped, { unchanged: true }, 'detach-reattach',
      {
        acceptedRows,
        operationEvents: operationEvents.map((event) => event.eventSequence === 12
          ? { ...event, providerEventAt: '2026-07-11T00:00:00.004Z' }
          : event),
      },
    ),
    (error) => error.code === 'isolated_fixture_delay_unproven',
  );

  assert.throws(
    () => isolatedFixtureReceipt({
      ...fixture,
      operationDelayEvidence: {
        ...delayEvidence,
        roles: {
          ...delayEvidence.roles,
          cosmo: { ...delayEvidence.roles.cosmo, providerStarts: 2 },
        },
      },
    }, stopped, { unchanged: true }, 'detach-reattach', { acceptedRows, operationEvents }),
    (error) => error.code === 'isolated_fixture_delay_unproven',
  );

  assert.throws(
    () => isolatedFixtureReceipt({
      ...fixture,
      operationDelayEvidence: {
        ...delayEvidence,
        roles: {
          ...delayEvidence.roles,
          cosmo: {
            ...delayEvidence.roles.cosmo,
            actions: [{ ...delayEvidence.roles.cosmo.actions[0], actionProven: false }],
          },
        },
      },
    }, stopped, { unchanged: true }, 'detach-reattach', { acceptedRows, operationEvents }),
    (error) => error.code === 'isolated_fixture_delay_unproven'
      && error.proofReason === 'complete_action_elapsed'
      && !JSON.stringify(error).includes('controlled durable query result'),
  );

  const cancelOperationId = `brop_${'C'.repeat(32)}`;
  const cancelAction = {
    operationId: cancelOperationId,
    phase: 'query',
    providerCallId: 'query',
    provider: 'controlled',
    model: 'controlled-query',
    configuredDelayMs: 3000,
    effectiveDelayMs: 5,
    testOnlyDelay: true,
    startedAt: '2026-07-11T00:00:00.000Z',
    completedAt: '2026-07-11T00:00:00.020Z',
    elapsedMs: 20,
    actionProven: false,
    outcome: 'aborted',
  };
  const cancelFixture = {
    ...fixture,
    operationDelayEvidence: {
      ...delayEvidence,
      roles: {
        cosmo: {
          providerStarts: 1,
          providerAborts: 1,
          providerDelayStarts: 1,
          providerDelayCompletions: 0,
          actions: [cancelAction],
        },
        dashboard: { ...delayEvidence.roles.dashboard },
      },
    },
  };
  const cancelProof = {
    acceptedRows: [{
      receiptKind: 'operation-terminal', protectedResultRead: true,
      operationId: cancelOperationId, operationType: 'query', state: 'cancelled',
      completedAt: '2026-07-11T00:00:00.010Z',
    }],
    operationEvents: [],
  };
  const cancelled = isolatedFixtureReceipt(
    cancelFixture,
    stopped,
    { unchanged: true },
    'cancel',
    cancelProof,
  );
  assert.deepEqual(cancelled.operationDelayEvidence.acceptedOperations[0].actions[0], {
    operationId: cancelOperationId,
    role: 'cosmo',
    phase: 'query',
    provider: 'controlled',
    model: 'controlled-query',
    providerCallId: 'query',
    outcome: 'aborted',
    configuredDelayMs: 3000,
    effectiveDelayMs: 5,
    selectedEventSequence: null,
    startedAt: '2026-07-11T00:00:00.000Z',
    completedEventSequence: null,
    completedAt: null,
    providerTerminalEventSequence: null,
    providerTerminalAt: null,
    providerAbortObservedAt: '2026-07-11T00:00:00.020Z',
    elapsedMs: 20,
    actionBeforeTerminalProven: true,
  });
  for (const invalidAction of [
    { ...cancelAction, operationId: `brop_${'U'.repeat(32)}` },
    {
      ...cancelAction,
      startedAt: '2026-07-11T00:00:00.011Z',
      completedAt: '2026-07-11T00:00:00.021Z',
    },
  ]) {
    assert.throws(
      () => isolatedFixtureReceipt({
        ...cancelFixture,
        operationDelayEvidence: {
          ...cancelFixture.operationDelayEvidence,
          roles: {
            ...cancelFixture.operationDelayEvidence.roles,
            cosmo: {
              ...cancelFixture.operationDelayEvidence.roles.cosmo,
              actions: [invalidAction],
            },
          },
        },
      }, stopped, { unchanged: true }, 'cancel', cancelProof),
      (error) => error.code === 'isolated_fixture_delay_unproven',
    );
  }

  const noProviderEvidence = {
    ...delayEvidence,
    roles: {
      cosmo: {
        providerStarts: 0, providerAborts: 0,
        providerDelayStarts: 0, providerDelayCompletions: 0,
        actions: [],
      },
      dashboard: {
        providerStarts: 0, providerAborts: 0,
        providerDelayStarts: 0, providerDelayCompletions: 0,
        actions: [],
      },
    },
  };
  const zeroOperationId = `brop_${'Z'.repeat(32)}`;
  const zeroReceipt = isolatedFixtureReceipt({
    ...fixture,
    operationDelayEvidence: noProviderEvidence,
  }, stopped, { unchanged: true }, 'zero-result', {
    acceptedRows: [{
      receiptKind: 'operation-terminal', protectedResultRead: true,
      operationId: zeroOperationId, operationType: 'search', state: 'complete',
      completedAt: '2026-07-11T00:00:00.010Z',
    }],
    operationEvents: [],
  });
  assert.equal(zeroReceipt.operationDelayEvidence.actionBeforeTerminalProven, false);
  assert.deepEqual(zeroReceipt.operationDelayEvidence.acceptedOperations, [{
    operationId: zeroOperationId,
    operationType: 'search',
    role: null,
    terminalState: 'complete',
    terminalCompletedAt: '2026-07-11T00:00:00.010Z',
    actionRequired: false,
    actionBeforeTerminalProven: false,
    actions: [],
  }]);
  assert.throws(
    () => isolatedFixtureReceipt({
      ...fixture,
      operationDelayEvidence: noProviderEvidence,
    }, stopped, { unchanged: true }, 'large-pgs-isolated', {
      acceptedRows: [{
        receiptKind: 'operation-terminal', protectedResultRead: true,
        operationId: zeroOperationId, operationType: 'pgs', state: 'partial',
        completedAt: '2026-07-11T00:00:00.010Z',
      }],
      operationEvents: [],
    }),
    (error) => error.code === 'isolated_fixture_delay_unproven',
  );
});

test('final artifact sealing rejects a run with no guarded PM2 transactions', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await writeJsonReceipt(
    state.context,
    path.join(state.context.receiptRunDir, 'live', 'operation.json'),
    {
      helper: 'fixture', receiptKind: 'operation-terminal',
      operationId: `brop_${'N'.repeat(32)}`, operationType: 'search', state: 'complete',
      requesterAgent: 'jerry', protectedResultRead: true,
      authorizedEndpoint: 'http://fixture', isolatedStore: null,
    },
  );
  await writeOperationIdentityManifest(state);
  await assert.rejects(buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
    context: state.context,
  }), (error) => error.code === 'guarded_pm2_transaction_invalid');
});

test('final artifact sealing requires comprehensive guarded PM2 evidence and retained backups', async (t) => {
  const {
    canonicalReceiptRow,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { buildArtifactManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');

  async function preparedState(subtest) {
    const state = await fixture();
    subtest.after(() => fs.rm(state.root, { recursive: true, force: true }));
    await fs.mkdir(path.join(state.context.receiptRunDir, 'live'), { mode: 0o700 });
    await writeJsonReceipt(
      state.context,
      path.join(state.context.receiptRunDir, 'live', 'operation.json'),
      {
        helper: 'fixture', receiptKind: 'operation-terminal',
        operationId: `brop_${'P'.repeat(32)}`, operationType: 'search', state: 'complete',
        requesterAgent: 'jerry', protectedResultRead: true,
        authorizedEndpoint: 'http://127.0.0.1:5002', isolatedStore: null,
      },
    );
    await writeRequiredGuardedPm2Transactions(state);
    await writeOperationIdentityManifest(state);
    return state;
  }

  async function rewriteResultWithout(state, mode, field) {
    const transaction = REQUIRED_GUARDED_PM2_TRANSACTIONS.find(
      (candidate) => candidate.mode === mode,
    );
    const resultPath = path.join(
      state.context.receiptRunDir, 'live', transaction.resultBasename,
    );
    const intentPath = path.join(
      state.context.receiptRunDir,
      'live',
      `.${transaction.resultBasename}.${transaction.transactionId}.guarded-pm2-intent.json`,
    );
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    const { artifactSha256: _resultHash, ...resultPayload } = result;
    delete resultPayload[field];
    const rewrittenResult = canonicalReceiptRow(
      state.context, resultPayload, result.completedAt,
    );
    await fs.writeFile(resultPath, `${JSON.stringify(rewrittenResult, null, 2)}\n`);
    const intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
    const { artifactSha256: _intentHash, ...intentPayload } = intent;
    intentPayload.outputArtifactSha256 = rewrittenResult.artifactSha256;
    const rewrittenIntent = canonicalReceiptRow(
      state.context, intentPayload, intent.completedAt,
    );
    await fs.writeFile(intentPath, `${JSON.stringify(rewrittenIntent, null, 2)}\n`);
  }

  for (const [label, mode, field] of [
    ['backup digest', 'dry-run', 'backupSha256'],
    ['backup identity', 'dry-run', 'backupIdentity'],
    ['module freeze proof', 'dry-run', 'moduleRowsFrozen'],
    ['unrelated-row freeze proof', 'dry-run', 'unrelatedRowsFrozen'],
    ['ecosystem reload proof', 'apply', 'ecosystemAuthorityReloaded'],
    ['immediate pre-save proof', 'apply', 'immediatePreSaveTableRevalidated'],
    ['dump postcondition', 'apply', 'dumpTableAfter'],
  ]) {
    await t.test(`missing ${label} blocks sealing`, async (subtest) => {
      const state = await preparedState(subtest);
      await rewriteResultWithout(state, mode, field);
      await assert.rejects(buildArtifactManifest({
        smokeRoot: state.context.receiptRunDir,
        output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
        context: state.context,
      }), (error) => error.code === 'guarded_pm2_transaction_invalid');
    });
  }

  await t.test('missing retained backup artifact blocks sealing', async (subtest) => {
    const state = await preparedState(subtest);
    const dryRun = JSON.parse(await fs.readFile(path.join(
      state.context.receiptRunDir, 'live', 'guarded-pm2-save-dry-run.json',
    ), 'utf8'));
    await fs.rm(dryRun.backupPath);
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      context: state.context,
    }), (error) => error.code === 'guarded_pm2_transaction_invalid');
  });
});

test('final artifact sealing requires complete dual-authority operation identity evidence', async (t) => {
  const {
    canonicalReceiptRow,
    hashFile,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');

  async function preparedState(subtest) {
    const state = await fixture();
    subtest.after(() => fs.rm(state.root, { recursive: true, force: true }));
    await fs.mkdir(path.join(state.context.receiptRunDir, 'live'), { mode: 0o700 });
    await writeJsonReceipt(
      state.context,
      path.join(state.context.receiptRunDir, 'live', 'operation.json'),
      {
        helper: 'fixture', receiptKind: 'operation-terminal',
        operationId: `brop_${'I'.repeat(32)}`, operationType: 'search', state: 'complete',
        requesterAgent: 'jerry', protectedResultRead: true,
        authorizedEndpoint: 'http://127.0.0.1:5002', isolatedStore: null,
      },
    );
    await writeRequiredGuardedPm2Transactions(state);
    return state;
  }

  await t.test('missing identity manifest blocks sealing', async (subtest) => {
    const state = await preparedState(subtest);
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      context: state.context,
    }), (error) => error.code === 'identity_manifest_invalid');
  });

  await t.test('one authority and empty identity groups block sealing', async (subtest) => {
    const state = await preparedState(subtest);
    await writeOperationIdentityManifest(state, { addMissingGroups: false });
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      context: state.context,
    }), (error) => error.code === 'identity_manifest_invalid');
  });

  await t.test('a canonical terminal absent from the identity manifest blocks sealing', async (subtest) => {
    const state = await preparedState(subtest);
    await writeOperationIdentityManifest(state);
    await writeJsonReceipt(
      state.context,
      path.join(state.context.receiptRunDir, 'live', 'unlisted-operation.json'),
      {
        helper: 'fixture', receiptKind: 'operation-terminal',
        operationId: `brop_${'U'.repeat(32)}`, operationType: 'search', state: 'complete',
        requesterAgent: 'jerry', protectedResultRead: true,
        authorizedEndpoint: 'http://127.0.0.1:5002', isolatedStore: null,
      },
    );
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      context: state.context,
    }), (error) => error.code === 'identity_manifest_unlisted_operation');
  });

  await t.test('verification rejects a cohesively rehashed nonexact authority list', async (subtest) => {
    const state = await preparedState(subtest);
    await writeOperationIdentityManifest(state);
    const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
    await buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: manifestPath,
      context: state.context,
    });
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const { artifactSha256: _artifactSha256, ...payload } = manifest;
    payload.authorities = ['live'];
    const rewritten = canonicalReceiptRow(state.context, payload, manifest.completedAt);
    await fs.writeFile(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);
    const hash = await hashFile(manifestPath);
    await fs.writeFile(
      path.join(state.context.receiptRunDir, 'artifact-manifest.sha256'),
      `${hash.sha256}  artifact-manifest.json\n`,
    );
    await assert.rejects(
      verifyArtifactManifest({ manifestPath, context: state.context }),
      (error) => error.code === 'artifact_manifest_invalid',
    );
  });
});

test('artifact manifests require complete cross-linked guarded PM2 result and intent pairs', async (t) => {
  const {
    canonicalReceiptRow,
    hashFile,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const transactionId = '123e4567-e89b-42d3-a456-426614174000';

  async function transactionFixture(subtest, {
    includeIntent = true,
    resultState = 'committed',
    intentState = resultState,
    crossHash = null,
    stripArtifacts = false,
  } = {}) {
    const state = await fixture();
    subtest.after(() => fs.rm(state.root, { recursive: true, force: true }));
    await writeJsonReceipt(
      state.context,
      path.join(state.context.receiptRunDir, 'operation.json'),
      {
        helper: 'fixture',
        receiptKind: 'operation-terminal',
        operationId: `brop_${'G'.repeat(32)}`,
        operationType: 'search',
        state: 'complete',
        requesterAgent: 'jerry',
        protectedResultRead: true,
        authorizedEndpoint: 'http://fixture',
        isolatedStore: null,
      },
    );
    const { outputPath, intentBasename } = await writeGuardedPm2Transaction(state, {
      mode: 'dry-run',
      transactionId,
      resultBasename: 'guarded-pm2-save-dry-run.json',
    });
    const intentPath = path.join(state.context.receiptRunDir, 'live', intentBasename);
    const failureRestored = resultState === 'failed-restored';
    let result = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    if (resultState !== 'committed') {
      const { artifactSha256: _artifactSha256, ...payload } = result;
      Object.assign(payload, {
        transactionState: resultState,
        ok: false,
        pm2SaveInvoked: failureRestored,
        applied: false,
        restored: failureRestored,
        restorationVerified: failureRestored,
        receiptPublicationVerified: false,
      });
      result = canonicalReceiptRow(state.context, payload, result.completedAt);
      await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (!includeIntent) {
      await fs.rm(intentPath);
    } else if (intentState !== 'committed' || crossHash !== null || resultState !== 'committed') {
      const intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
      const { artifactSha256: _artifactSha256, ...payload } = intent;
      const intentFailureRestored = intentState === 'failed-restored';
      Object.assign(payload, {
        transactionState: intentState,
        ok: intentState === 'committed',
        pm2SaveInvoked: intentFailureRestored,
        restored: intentFailureRestored,
        restorationVerified: intentFailureRestored,
        outputArtifactSha256: crossHash ?? result.artifactSha256,
      });
      const rewritten = canonicalReceiptRow(state.context, payload, intent.completedAt);
      await fs.writeFile(intentPath, `${JSON.stringify(rewritten, null, 2)}\n`);
    }
    await writeGuardedPm2Transaction(state, REQUIRED_GUARDED_PM2_TRANSACTIONS[1]);
    await writeOperationIdentityManifest(state);
    if (stripArtifacts) {
      for (const file of [outputPath, intentPath]) {
        const document = JSON.parse(await fs.readFile(file, 'utf8'));
        delete document.artifactSha256;
        await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
      }
    }
    return {
      state,
      manifestPath: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      outputPath,
      intentPath,
    };
  }

  await t.test('valid committed pair seals and verifies', async (subtest) => {
    const { state, manifestPath } = await transactionFixture(subtest);
    await buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: manifestPath,
      context: state.context,
    });
    assert.equal((await verifyArtifactManifest({
      manifestPath,
      context: state.context,
    })).ok, true);
  });

  await t.test('one committed dry-run pair is still incomplete', async (subtest) => {
    const { state, manifestPath } = await transactionFixture(subtest);
    const apply = REQUIRED_GUARDED_PM2_TRANSACTIONS[1];
    await fs.rm(path.join(state.context.receiptRunDir, 'live', apply.resultBasename));
    await fs.rm(path.join(
      state.context.receiptRunDir,
      'live',
      `.${apply.resultBasename}.${apply.transactionId}.guarded-pm2-intent.json`,
    ));
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: manifestPath,
      context: state.context,
    }), (error) => error.code === 'guarded_pm2_transaction_invalid');
  });

  await t.test('dry-run and apply modes cannot trade their required result paths', async (subtest) => {
    const state = await fixture();
    subtest.after(() => fs.rm(state.root, { recursive: true, force: true }));
    await writeJsonReceipt(
      state.context,
      path.join(state.context.receiptRunDir, 'operation.json'),
      {
        helper: 'fixture', receiptKind: 'operation-terminal',
        operationId: `brop_${'W'.repeat(32)}`, operationType: 'search', state: 'complete',
        requesterAgent: 'jerry', protectedResultRead: true,
        authorizedEndpoint: 'http://fixture', isolatedStore: null,
      },
    );
    await writeGuardedPm2Transaction(state, {
      mode: 'dry-run',
      transactionId: '44444444-4444-4444-8444-444444444444',
      resultBasename: 'guarded-pm2-save-apply.json',
    });
    await writeGuardedPm2Transaction(state, {
      mode: 'apply',
      transactionId: '55555555-5555-4555-8555-555555555555',
      resultBasename: 'guarded-pm2-save-dry-run.json',
    });
    await writeOperationIdentityManifest(state);
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: path.join(state.context.receiptRunDir, 'artifact-manifest.json'),
      context: state.context,
    }), (error) => error.code === 'guarded_pm2_transaction_invalid');
  });

  await t.test('an extra retry transaction is not an exact final pair inventory', async (subtest) => {
    const { state, manifestPath } = await transactionFixture(subtest);
    await writeGuardedPm2Transaction(state, {
      mode: 'dry-run',
      transactionId: '33333333-3333-4333-8333-333333333333',
      resultBasename: 'guarded-pm2-save-dry-run-retry.json',
    });
    await assert.rejects(buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: manifestPath,
      context: state.context,
    }), (error) => error.code === 'guarded_pm2_transaction_invalid');
  });

  for (const transactionState of ['failed-nonmutating', 'failed-restored']) {
    await t.test(`${transactionState} evidence blocks the final committed seal`, async (subtest) => {
      const { state, manifestPath } = await transactionFixture(subtest, {
        resultState: transactionState,
      });
      await assert.rejects(buildArtifactManifest({
        smokeRoot: state.context.receiptRunDir,
        output: manifestPath,
        context: state.context,
      }), (error) => error.code === 'guarded_pm2_transaction_invalid');
    });
  }

  await t.test('verification independently rejects a cohesively rehashed state mismatch', async (subtest) => {
    const {
      state, manifestPath, intentPath,
    } = await transactionFixture(subtest);
    await buildArtifactManifest({
      smokeRoot: state.context.receiptRunDir,
      output: manifestPath,
      context: state.context,
    });
    const intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
    const tamperedIntent = canonicalReceiptRow(state.context, {
      ...intent,
      transactionState: 'failed-restored',
      ok: false,
      pm2SaveInvoked: true,
      restored: true,
      restorationVerified: true,
    }, intent.completedAt);
    await fs.writeFile(intentPath, `${JSON.stringify(tamperedIntent, null, 2)}\n`);

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const relativeIntent = path.relative(state.context.receiptRunDir, intentPath);
    const intentHash = await hashFile(intentPath);
    const artifacts = manifest.artifacts.map((entry) => entry.path === relativeIntent
      ? {
          ...entry,
          size: intentHash.physicalSize,
          sha256: intentHash.sha256,
          dev: intentHash.dev,
          ino: intentHash.ino,
          nlink: 1,
          mtimeNs: intentHash.mtimeNs,
          ctimeNs: intentHash.ctimeNs,
        }
      : entry);
    const resealedManifest = canonicalReceiptRow(state.context, {
      ...manifest,
      artifacts,
    }, manifest.completedAt);
    await fs.writeFile(manifestPath, `${JSON.stringify(resealedManifest, null, 2)}\n`);
    const manifestHash = await hashFile(manifestPath);
    await fs.writeFile(
      path.join(state.context.receiptRunDir, 'artifact-manifest.sha256'),
      `${manifestHash.sha256}  artifact-manifest.json\n`,
    );
    await assert.rejects(
      verifyArtifactManifest({ manifestPath, context: state.context }),
      (error) => error.code === 'guarded_pm2_transaction_invalid',
    );
  });

  for (const [name, options] of [
    ['missing intent', { includeIntent: false }],
    ['state mismatch', { intentState: 'failed-restored' }],
    ['cross-hash mismatch', { crossHash: '0'.repeat(64) }],
    ['reserved transaction', { resultState: 'reserved', intentState: 'reserved' }],
    ['stripped canonical seals', { stripArtifacts: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const { state, manifestPath } = await transactionFixture(subtest, options);
      await assert.rejects(buildArtifactManifest({
        smokeRoot: state.context.receiptRunDir,
        output: manifestPath,
        context: state.context,
      }), (error) => error.code === 'guarded_pm2_transaction_invalid');
    });
  }
});
