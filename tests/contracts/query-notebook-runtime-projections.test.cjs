const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

require('tsx/cjs');

const {
  createQueryNotebookCredentialAuthority,
  deriveQueryNotebookCredentialKey,
} = require('../../shared/query-notebook-credential.cjs');
const {
  createHome23QueryNotebookRouter,
} = require('../../engine/src/dashboard/home23-query-notebook-api.js');
const {
  createQueryNotebookActionTokens,
} = require('../../engine/src/dashboard/query-notebook-action-token.js');
const {
  createQueryNotebookAuth,
} = require('../../engine/src/dashboard/query-notebook-auth.js');
const {
  createQueryNotebookService,
} = require('../../engine/src/dashboard/query-notebook-service.js');
const {
  DeviceRegistry,
} = require('../../src/push/device-registry.ts');
const {
  createQueryCredentialHandler,
  createQueryCredentialJsonParser,
} = require('../../src/routes/device.ts');
const {
  canonicalJson,
} = require('../../shared/brain-operations/canonical-json.cjs');

const NOW = '2026-07-13T20:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const BRIDGE_TOKEN = `bridge_${'b'.repeat(64)}`;
const INSTALLATION_ID = 'install_0123456789abcdef01234567';
const IDS = Object.freeze({
  page: `brop_${'A'.repeat(32)}`,
  status: `brop_${'B'.repeat(32)}`,
  cancel: `brop_${'C'.repeat(32)}`,
  child: `brop_${'D'.repeat(32)}`,
  older: `brop_${'E'.repeat(32)}`,
  result: `brop_${'F'.repeat(32)}`,
  unknown: `brop_${'G'.repeat(32)}`,
});
const RESULT_VERSION = `qrv1_${'V'.repeat(43)}`;
const DIRECT_RESULT_VERSION = `qrv1_${'D'.repeat(43)}`;
const SESSION_ID = `pgss_${'S'.repeat(32)}`;
const CONTINUABLE_UNTIL = '2026-07-20T19:10:00.000Z';
const ACTION_EXPIRES_AT = '2026-07-13T21:00:00.000Z';
const FIXTURE_NAMES = Object.freeze([
  'query-notebook-page',
  'query-notebook-status',
  'query-notebook-progress-event',
  'query-notebook-gap-event',
  'query-notebook-terminal-event',
  'query-notebook-result',
  'query-notebook-export',
  'query-notebook-cancel',
  'query-notebook-history-visibility',
  'query-notebook-action',
  'query-notebook-notification',
  'query-notebook-device-credential',
  'query-notebook-web-session',
]);

// This independent corpus pin makes coordinated runtime+fixture shape drift fail until
// a reviewer deliberately accepts a new public contract.
const EXPECTED_FIXTURE_CORPUS_SHA256 =
  '83dbb4c5d28446eea97d96313285bc65f9c05e7f71d680932bfeda58fcd9096a';

function fixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'contracts', 'fixtures', `${name}.json`), 'utf8',
  ));
}

function pgsRecord(overrides = {}) {
  return {
    operationId: IDS.page,
    requestId: 'runtime-contract-pgs',
    operationType: 'pgs',
    requesterAgent: 'jerry',
    requestParameters: {
      query: 'Map durable truth across the current brain source.',
      pgsMode: 'fresh',
      pgsLevel: 'sample',
    },
    parameters: {
      query: 'Map durable truth across the current brain source.',
      pgsMode: 'fresh',
      pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M2.1' },
      pgsSynth: { provider: 'anthropic', model: 'claude-opus-4-8' },
    },
    target: {
      domain: 'brain',
      brainId: 'brain-jerry',
      displayName: 'Jerry',
      canonicalRoot: '/private/runtime-contract/brain',
    },
    state: 'partial',
    acceptedAt: '2026-07-13T19:00:00.000Z',
    startedAt: '2026-07-13T19:00:01.000Z',
    updatedAt: '2026-07-13T19:10:00.000Z',
    completedAt: '2026-07-13T19:10:00.000Z',
    progressSnapshot: {
      version: 1,
      stage: 'terminal',
      eventSequence: 41,
      selected: 12,
      completed: 10,
      successful: 9,
      failed: 1,
      reused: 3,
      pending: 2,
      retryable: 1,
      total: 12,
      lastProviderActivityAt: '2026-07-13T19:09:58.000Z',
      lastProgressAt: '2026-07-13T19:10:00.000Z',
    },
    error: { code: 'pgs_scope_incomplete', retryable: true },
    result: { answer: 'stored-private-result' },
    resultHandle: `brres_${'H'.repeat(32)}`,
    resultArtifact: null,
    resultExpiresAt: CONTINUABLE_UNTIL,
    resultExpiredAt: null,
    pgsSession: {
      sessionId: SESSION_ID,
      continuableUntil: CONTINUABLE_UNTIL,
      sourceOperationId: null,
    },
    notebookResultSummary: {
      version: 1,
      resultVersion: RESULT_VERSION,
      answerAvailable: true,
      coverage: {
        coverageLevel: 'sample',
        successfulSweeps: 9,
        selectedWorkUnits: 12,
        pendingWorkUnits: 2,
        reusedWorkUnits: 3,
        newWorkUnits: 7,
        scopeWorkUnits: 12,
        scopeSuccessfulWorkUnits: 9,
        scopePendingWorkUnits: 2,
        scopeComplete: false,
        retryablePartitions: ['c-retry-1'],
        retryablePartitionCount: 1,
      },
      continuation: {
        canContinue: true,
        continuableUntil: CONTINUABLE_UNTIL,
        sourceOperationId: null,
      },
    },
    sourceEvidence: {
      sourceHealth: 'degraded',
      freshness: 'known',
      matchOutcome: 'matches',
      completeCoverage: false,
      filteredTotal: 12,
      authoritativeTotals: { nodes: 141900, edges: 464000 },
      returnedTotals: { nodes: 12, edges: 36 },
      canonicalRoot: '/private/runtime-contract/brain',
    },
    sourcePinDescriptor: {
      version: 1,
      canonicalRoot: '/private/runtime-contract/brain',
      cutoffRevision: 42,
    },
    sourcePinDigest: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function directRunningRecord() {
  return {
    operationId: IDS.status,
    requestId: 'runtime-contract-direct',
    operationType: 'query',
    requesterAgent: 'jerry',
    requestParameters: {
      query: 'What changed in the brain today?',
      mode: 'grounded',
    },
    parameters: {
      query: 'What changed in the brain today?',
      mode: 'grounded',
      modelSelection: { provider: 'xai', model: 'grok-4-0709' },
    },
    target: {
      domain: 'brain', brainId: 'brain-jerry', displayName: 'Jerry',
      canonicalRoot: '/private/runtime-contract/brain',
    },
    state: 'running',
    acceptedAt: '2026-07-13T20:00:00.000Z',
    startedAt: '2026-07-13T20:00:01.000Z',
    updatedAt: '2026-07-13T20:00:03.000Z',
    completedAt: null,
    progressSnapshot: {
      version: 1,
      stage: 'preparing_source',
      eventSequence: 3,
      sourceNodes: 141900,
      sourceEdges: 464000,
      lastProgressAt: '2026-07-13T20:00:03.000Z',
    },
    error: null,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    notebookResultSummary: null,
    pgsSession: null,
    sourceEvidence: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
  };
}

function directResultRecord() {
  return {
    operationId: IDS.result,
    requestId: 'runtime-contract-direct-result',
    operationType: 'query',
    requesterAgent: 'jerry',
    requestParameters: {
      query: 'Synthesize the strongest current themes and contradictions.',
      mode: 'dive',
    },
    parameters: {
      query: 'Synthesize the strongest current themes and contradictions.',
      mode: 'dive',
      modelSelection: { provider: 'openai-codex', model: 'gpt-5.5' },
    },
    target: {
      domain: 'brain', brainId: 'brain-jerry', displayName: 'Jerry',
      canonicalRoot: '/private/runtime-contract/brain',
    },
    state: 'complete',
    acceptedAt: '2026-07-13T18:30:00.000Z',
    startedAt: '2026-07-13T18:30:01.000Z',
    updatedAt: '2026-07-13T18:40:00.000Z',
    completedAt: '2026-07-13T18:40:00.000Z',
    progressSnapshot: {
      version: 1,
      stage: 'terminal',
      eventSequence: 12,
      sourceNodes: 142764,
      sourceEdges: 468230,
      lastProgressAt: '2026-07-13T18:40:00.000Z',
    },
    error: null,
    result: { answer: 'stored-private-direct-result' },
    resultHandle: `brres_${'D'.repeat(32)}`,
    resultArtifact: null,
    resultExpiresAt: '2026-07-20T18:40:00.000Z',
    resultExpiredAt: null,
    notebookResultSummary: {
      version: 1,
      resultVersion: DIRECT_RESULT_VERSION,
      answerAvailable: true,
      coverage: null,
      continuation: null,
    },
    pgsSession: null,
    sourceEvidence: {
      sourceHealth: 'healthy',
      freshness: 'known',
      matchOutcome: 'matches',
      completeCoverage: true,
      filteredTotal: 0,
      authoritativeTotals: { nodes: 142764, edges: 468230 },
      returnedTotals: { nodes: 80, edges: 14 },
      retrievalMode: 'semantic-ann-delta-overlay',
      indexCoverage: {
        complete: true,
        indexedRevision: 142760,
        currentRevision: 142764,
        coveredThroughRevision: 142764,
        deltaRecords: 4,
        distinctChangedNodes: 2,
        distinctUpsertedNodes: 1,
        distinctRemovedNodes: 1,
        edgeOnlyRecords: 0,
        changedNodes: 2,
        upsertedNodes: 1,
        removedNodes: 1,
        route: 'pinned-query-projection',
        completeness: 'complete',
      },
      stageTimingsMs: {
        sourceOpen: 2,
        embedding: 4,
        overlayRefresh: 3,
        annLoad: 5,
        annSearch: 6,
        overlayScoring: 7,
        keywordScoring: 8,
        merge: 9,
        response: 44,
        deltaOverlay: 3,
        annQuery: 6,
        deltaSemantic: 7,
        keyword: 8,
        total: 44,
      },
      authoritySummary: {
        total: 80,
        authorityClasses: {
          verified_current_state: 2,
          jtr_correction: 1,
          artifact_log: 30,
          worker_receipt: 4,
          generated_doctrine: 3,
          narrative: 40,
        },
        retrievalDomains: {
          current_ops: 20,
          closed_incidents: 10,
          project_history: 30,
          external_intake: 20,
        },
        sourceChain: {
          withEvidence: 50,
          withoutEvidence: 30,
          referenceCounts: {
            source: 10,
            evidence: 10,
            artifact: 10,
            trace: 5,
            generation: 5,
            lineage: 5,
            verification: 3,
            closure: 2,
          },
        },
        requiresFreshVerification: 40,
        verifiedCurrentState: 2,
        jtrCorrection: 1,
        artifactLog: 30,
        workerReceipt: 4,
        generatedDoctrine: 3,
        narrative: 40,
      },
      canonicalRoot: '/private/runtime-contract/brain',
    },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
  };
}

function legacyDisplayRecord() {
  return pgsRecord({
    operationId: IDS.older,
    requestId: 'runtime-contract-legacy',
    requestParameters: {
      query: 'Legacy sweep receipt retained for display.',
      mode: 'quick',
      pgsMode: 'full',
      pgsConfig: { sweepFraction: 0.333 },
    },
    parameters: {
      query: 'Legacy sweep receipt retained for display.',
      mode: 'quick',
      pgsMode: 'full',
      pgsConfig: { sweepFraction: 0.333 },
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M2.1' },
      pgsSynth: { provider: 'anthropic', model: 'claude-opus-4-8' },
    },
    state: 'complete',
    acceptedAt: '2026-07-13T18:00:00.000Z',
    startedAt: '2026-07-13T18:00:01.000Z',
    updatedAt: '2026-07-13T18:05:00.000Z',
    completedAt: '2026-07-13T18:05:00.000Z',
    progressSnapshot: null,
    error: null,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    pgsSession: null,
    notebookResultSummary: null,
    sourceEvidence: null,
  });
}

function incompatibleRecord() {
  return pgsRecord({
    operationId: IDS.unknown,
    requestId: 'runtime-contract-unknown',
    requestParameters: {
      query: 'Unknown future receipt.', pgsMode: 'fresh', pgsLevel: 'future',
    },
    parameters: {
      query: 'Unknown future receipt.', pgsMode: 'fresh', pgsLevel: 'future',
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M2.1' },
      pgsSynth: { provider: 'anthropic', model: 'claude-opus-4-8' },
    },
    state: 'complete',
    acceptedAt: '2026-07-13T17:00:00.000Z',
    startedAt: '2026-07-13T17:00:01.000Z',
    updatedAt: '2026-07-13T17:05:00.000Z',
    completedAt: '2026-07-13T17:05:00.000Z',
    progressSnapshot: null,
    error: null,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    pgsSession: null,
    notebookResultSummary: null,
    sourceEvidence: null,
  });
}

function cancelledRecord(terminal) {
  return {
    operationId: IDS.cancel,
    requestId: 'runtime-contract-cancel',
    operationType: 'pgs',
    requesterAgent: 'jerry',
    requestParameters: {
      query: 'Inspect the selected areas and stop if requested.',
      pgsMode: 'targeted',
      pgsLevel: 'deep',
    },
    parameters: {
      query: 'Inspect the selected areas and stop if requested.',
      pgsMode: 'targeted',
      pgsLevel: 'deep',
      pgsSweep: { provider: 'openai', model: 'gpt-5.2' },
      pgsSynth: { provider: 'anthropic', model: 'claude-opus-4-8' },
    },
    target: {
      domain: 'brain', brainId: 'brain-jerry', displayName: 'Jerry',
      canonicalRoot: '/private/runtime-contract/brain',
    },
    state: terminal ? 'cancelled' : 'running',
    acceptedAt: '2026-07-13T20:10:00.000Z',
    startedAt: '2026-07-13T20:10:01.000Z',
    updatedAt: terminal ? '2026-07-13T20:11:00.000Z' : '2026-07-13T20:10:45.000Z',
    completedAt: terminal ? '2026-07-13T20:11:00.000Z' : null,
    progressSnapshot: {
      version: 1,
      stage: terminal ? 'terminal' : 'sweeping',
      eventSequence: 8,
      selected: 4,
      completed: 1,
      successful: 1,
      failed: 0,
      reused: 0,
      pending: 3,
      retryable: 0,
      total: 4,
      lastProgressAt: '2026-07-13T20:10:45.000Z',
    },
    error: null,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    notebookResultSummary: null,
    pgsSession: null,
    sourceEvidence: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
  };
}

function rawPgsResult() {
  return {
    answer: 'The durable source remains available. This bounded answer preserves the useful partial while one retryable area remains.',
    metadata: {
      pgs: {
        sessionId: SESSION_ID,
        continuableUntil: CONTINUABLE_UNTIL,
        sourceOperationId: null,
        canContinue: true,
        retryablePartitions: ['c-retry-1'],
      },
    },
    sweepOutputs: [{ output: 'private-runtime-sweep-output' }],
  };
}

function rawDirectResult() {
  return {
    answer: 'Findings, evidence, themes, non-obvious connections, convergence, contradictions, confidence, actionable implications, and unresolved questions are addressed in the stored Direct answer. Projection limits: the answer used the retained prompt subset rather than the entire brain.',
    projection: {
      nodesScanned: 142764,
      nodesRetained: 80,
      edgesScanned: 468230,
      edgesRetained: 14,
      droppedForPromptBudget: 1920,
      promptReduced: true,
    },
    answerQuality: {
      requestedMode: 'dive', state: 'substantial', expansionAttempted: true,
    },
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function parseSse(text) {
  return text.trim().split('\n\n').map((frame) => {
    const type = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    return { type, data: JSON.parse(data) };
  });
}

async function runtimeProjectionCorpus(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-contract-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const registry = new DeviceRegistry(path.join(directory, 'device-registry.json'), {
    now: () => NOW_MS,
    randomBytes: () => Buffer.alloc(24, 0xdd),
  });
  const credentialAuthority = createQueryNotebookCredentialAuthority({
    bridgeToken: BRIDGE_TOKEN,
    requesterAgent: 'jerry',
    now: () => NOW_MS,
  });
  const bridge = express();
  bridge.post(
    '/api/device/query-credential',
    createQueryCredentialJsonParser(),
    createQueryCredentialHandler({
      agentName: 'jerry',
      registry,
      token: BRIDGE_TOKEN,
      queryCredentialAuthority: credentialAuthority,
      now: () => NOW_MS,
    }),
  );
  const bridgeServer = await listen(bridge);
  t.after(bridgeServer.close);
  const enrollment = await jsonRequest(bridgeServer.base, '/api/device/query-credential', {
    method: 'POST',
    headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: { installationId: INSTALLATION_ID, agent: 'jerry' },
  });
  assert.equal(enrollment.response.status, 200);

  const records = new Map([
    [IDS.page, pgsRecord()],
    [IDS.status, directRunningRecord()],
    [IDS.cancel, cancelledRecord(false)],
    [IDS.result, directResultRecord()],
  ]);
  const older = legacyDisplayRecord();
  const unknown = incompatibleRecord();
  const reader = {
    expectedRequester: 'jerry',
    async listAuthorized() {
      return [records.get(IDS.page), records.get(IDS.result), older, unknown];
    },
    async getAuthorized(operationId) {
      return records.get(operationId) || (operationId === IDS.older ? older : null);
    },
    async getResultAuthorized(operationId) {
      if (operationId === IDS.page) return rawPgsResult();
      assert.equal(operationId, IDS.result);
      return rawDirectResult();
    },
  };
  const actionTokens = createQueryNotebookActionTokens({
    key: deriveQueryNotebookCredentialKey({
      bridgeToken: BRIDGE_TOKEN,
      requesterAgent: 'jerry',
    }),
    requesterAgent: 'jerry',
    now: () => NOW_MS,
    randomBytes: () => Buffer.alloc(24, 0xaa),
  });
  const hiddenOperationIds = new Set();
  const notebookService = createQueryNotebookService({
    reader,
    actionTokens,
    now: () => NOW_MS,
    visibilityStore: {
      async prune(existingOperationIds) {
        const existing = new Set(existingOperationIds);
        for (const operationId of hiddenOperationIds) {
          if (!existing.has(operationId)) hiddenOperationIds.delete(operationId);
        }
      },
      async hiddenOperationIds() { return [...hiddenOperationIds].sort(); },
      async isHidden(operationId) { return hiddenOperationIds.has(operationId); },
      async hide(operationId) { hiddenOperationIds.add(operationId); },
    },
    startOperation: async () => ({
      operationId: IDS.child,
      operationType: 'pgs',
      requesterAgent: 'jerry',
      state: 'queued',
    }),
  });
  const auth = createQueryNotebookAuth({
    requesterAgent: 'jerry',
    credentialAuthority,
    lookupDeviceCredential: async (credentialId) => (
      registry.getQueryCredentialByCredentialId(credentialId, 'jerry')
    ),
    verifyBridgeBearer: async (token) => token === BRIDGE_TOKEN,
    now: () => NOW_MS,
    randomBytes: () => Buffer.alloc(24, 0xee),
  });

  const subscriptionRows = [];
  const subscriptions = {
    async listActive(input = {}) {
      return subscriptionRows.filter((row) => (
        input.operationId === undefined || row.operationId === input.operationId
      ));
    },
    async subscribe(input) {
      const row = {
        ...input,
        routeId: `qroute_${'R'.repeat(32)}`,
        deliveryState: input.terminalState === null ? 'active' : 'pending',
      };
      subscriptionRows.push(row);
      return row;
    },
    async unsubscribe() { return true; },
    async markTerminalPending() { return []; },
  };
  const events = [
    {
      sequence: 21,
      type: 'progress',
      progressSnapshot: {
        version: 1,
        stage: 'sweeping',
        sourceNodes: 141900,
        sourceEdges: 464000,
        candidateWorkUnits: 12,
        selected: 12,
        completed: 7,
        successful: 6,
        failed: 1,
        reused: 3,
        pending: 5,
        retryable: 1,
        total: 12,
        eventSequence: 21,
        lastProviderActivityAt: '2026-07-13T19:05:58.000Z',
        lastProgressAt: '2026-07-13T19:06:00.000Z',
      },
    },
    {
      type: 'event_gap', eventSequence: 30, oldestSequence: 24, latestSequence: 30,
    },
    { sequence: 41, type: 'state', state: 'partial' },
  ];
  const coordinator = {
    async cancel(operationId) {
      assert.equal(operationId, IDS.cancel);
      records.set(IDS.cancel, cancelledRecord(true));
    },
    async attach(operationId) {
      assert.equal(operationId, IDS.page);
      return { async nextEvent() { return events.shift() ?? null; } };
    },
    async detach() {},
  };
  const router = createHome23QueryNotebookRouter({
    requesterAgent: 'jerry',
    auth,
    notebookService,
    getStatusAuthorized: (operationId) => (
      notebookService.getQueryNotebookStatusAuthorized(operationId)
    ),
    coordinator,
    subscriptions,
  });
  const dashboard = express();
  dashboard.use('/home23/api/query', express.json({ limit: '64kb', strict: true }), router);
  const dashboardServer = await listen(dashboard);
  t.after(dashboardServer.close);
  const deviceHeaders = {
    authorization: `Bearer ${enrollment.body.token}`,
    'x-home23-device-id': enrollment.body.credentialId,
  };

  const page = await jsonRequest(dashboardServer.base,
    '/home23/api/query/notebook?limit=3', { headers: deviceHeaders });
  const status = await jsonRequest(dashboardServer.base,
    `/home23/api/query/operations/${IDS.status}`, { headers: deviceHeaders });
  const result = await jsonRequest(dashboardServer.base,
    `/home23/api/query/operations/${IDS.result}/result`, { headers: deviceHeaders });
  const exported = await jsonRequest(dashboardServer.base,
    `/home23/api/query/operations/${IDS.page}/export`, {
      method: 'POST', body: { format: 'markdown' }, headers: deviceHeaders,
    });
  const cancel = await jsonRequest(dashboardServer.base,
    `/home23/api/query/operations/${IDS.cancel}/cancel`, {
      method: 'POST', body: {}, headers: deviceHeaders,
    });
  const continueAction = page.body.items[0].actions.find(({ kind }) => kind === 'continueSweep');
  assert.equal(continueAction.expiresAt, ACTION_EXPIRES_AT);
  const action = await jsonRequest(dashboardServer.base,
    `/home23/api/query/operations/${IDS.page}/actions`, {
      method: 'POST',
      headers: deviceHeaders,
      body: {
        kind: 'continueSweep',
        actionToken: continueAction.token,
        requestId: `qreq_${'Q'.repeat(32)}`,
      },
    });
  const notification = await jsonRequest(dashboardServer.base,
    `/home23/api/query/operations/${IDS.status}/notifications`, {
      method: 'POST', body: { enabled: true }, headers: deviceHeaders,
    });
  const streamResponse = await fetch(
    `${dashboardServer.base}/home23/api/query/operations/${IDS.page}/events?after=0&attachmentId=runtime-contract`,
    { headers: deviceHeaders },
  );
  assert.equal(streamResponse.status, 200);
  const stream = parseSse(await streamResponse.text());
  const byType = new Map(stream.map((event) => [event.type, event.data]));

  const origin = dashboardServer.base;
  const webSession = await jsonRequest(dashboardServer.base, '/home23/api/query/session', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
      origin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
  });
  const historyVisibility = await jsonRequest(
    dashboardServer.base,
    `/home23/api/query/operations/${IDS.page}/history`,
    { method: 'DELETE', headers: deviceHeaders },
  );

  for (const response of [
    page, status, result, exported, cancel, action, notification, webSession,
    historyVisibility,
  ]) {
    assert.ok(response.response.ok, `${response.response.status}: ${canonicalJson(response.body)}`);
  }
  return {
    'query-notebook-page': page.body,
    'query-notebook-status': status.body,
    'query-notebook-progress-event': byType.get('progress'),
    'query-notebook-gap-event': byType.get('gap'),
    'query-notebook-terminal-event': byType.get('terminal'),
    'query-notebook-result': result.body,
    'query-notebook-export': exported.body,
    'query-notebook-cancel': cancel.body,
    'query-notebook-history-visibility': historyVisibility.body,
    'query-notebook-action': action.body,
    'query-notebook-notification': notification.body,
    'query-notebook-device-credential': enrollment.body,
    'query-notebook-web-session': webSession.body,
  };
}

test('Query notebook fixtures are locked to actual runtime projections', async (t) => {
  const actual = await runtimeProjectionCorpus(t);
  const expected = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, fixture(name)]));
  for (const name of FIXTURE_NAMES) {
    assert.deepEqual(actual[name], expected[name], `${name} drifted from its runtime projection`);
  }
  const digest = crypto.createHash('sha256').update(canonicalJson(expected), 'utf8').digest('hex');
  assert.equal(digest, EXPECTED_FIXTURE_CORPUS_SHA256,
    'Query notebook fixture corpus changed without an explicit contract review');
});
