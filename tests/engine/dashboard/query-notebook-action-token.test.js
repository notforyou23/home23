import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const {
  createQueryNotebookActionTokens,
} = require('../../../engine/src/dashboard/query-notebook-action-token.js');
const {
  createQueryNotebookService,
} = require('../../../engine/src/dashboard/query-notebook-service.js');

const NOW = '2026-07-13T16:00:00.000Z';
const LATER = '2026-07-13T16:10:00.000Z';
const KEY = Buffer.alloc(32, 0x4a);
const SOURCE_OPERATION_ID = `brop_${'S'.repeat(32)}`;
const CHILD_OPERATION_ID = `brop_${'C'.repeat(32)}`;
const SESSION_ID = `pgss_${'P'.repeat(32)}`;
const REQUEST_ID = `qreq_${'R'.repeat(32)}`;

function tokenAuthority(overrides = {}) {
  let now = Date.parse(NOW);
  const tokens = createQueryNotebookActionTokens({
    key: KEY,
    requesterAgent: 'jerry',
    now: () => now,
    randomBytes: () => Buffer.alloc(24, 0x5a),
    ...overrides,
  });
  return { tokens, setNow: (value) => { now = Date.parse(value); } };
}

test('action tokens use exact bounded claims and reject tamper, drift, and expiry', () => {
  assert.doesNotThrow(() => createQueryNotebookActionTokens({
    key: KEY,
    requesterAgent: 'jerry',
  }));
  const { tokens, setNow } = tokenAuthority();
  const token = tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID,
    action: 'continueSweep',
    expiresAt: LATER,
  });
  const claims = tokens.verify(token, { sourceOperationId: SOURCE_OPERATION_ID });
  assert.deepEqual(Object.keys(claims).sort(), [
    'action', 'expiresAt', 'issuedAt', 'nonce', 'requesterAgent',
    'sourceOperationId', 'v',
  ]);
  assert.equal(claims.action, 'continueSweep');
  assert.equal(claims.requesterAgent, 'jerry');
  assert.equal(claims.issuedAt, NOW);
  assert.equal(claims.expiresAt, LATER);
  for (const forbidden of [
    'query', '/private/', 'targetPartitionIds', 'resultHandle', 'provider', 'secret',
  ]) assert.equal(Buffer.from(token.split('.')[0], 'base64url').toString().includes(forbidden), false);

  assert.throws(() => tokens.verify(`${token}x`, { sourceOperationId: SOURCE_OPERATION_ID }),
    { code: 'action_token_invalid' });
  assert.throws(() => tokens.verify(token, { sourceOperationId: `brop_${'X'.repeat(32)}` }),
    { code: 'action_token_invalid' });
  assert.throws(() => tokens.verify(token, {
    sourceOperationId: SOURCE_OPERATION_ID, action: 'targetedRetry',
  }), { code: 'action_token_invalid' });
  assert.throws(() => tokenAuthority({ requesterAgent: 'forrest' }).tokens.verify(token, {
    sourceOperationId: SOURCE_OPERATION_ID,
  }), { code: 'action_token_invalid' });

  const [payload] = token.split('.');
  const genericSignature = crypto.createHmac('sha256', KEY)
    .update(Buffer.from(payload, 'base64url')).digest('base64url');
  assert.throws(() => tokens.verify(`${payload}.${genericSignature}`, {
    sourceOperationId: SOURCE_OPERATION_ID,
  }), { code: 'action_token_invalid' });

  setNow(LATER);
  assert.throws(() => tokens.verify(token, { sourceOperationId: SOURCE_OPERATION_ID }),
    { code: 'action_token_invalid' });
});

function sourceRecord(overrides = {}) {
  const continuableUntil = '2026-07-20T16:00:00.000Z';
  return {
    operationId: SOURCE_OPERATION_ID,
    operationType: 'pgs',
    requesterAgent: 'jerry',
    requestParameters: {
      query: 'Map the durable brain', pgsMode: 'fresh', pgsLevel: 'sample',
    },
    parameters: {
      query: 'Map the durable brain', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'stored-sweep' },
      pgsSynth: { provider: 'anthropic', model: 'stored-synth' },
      operationControl: { hardDeadlineAt: '2026-07-14T16:00:00.000Z' },
    },
    acceptedAt: '2026-07-13T15:00:00.000Z',
    target: {
      domain: 'brain', brainId: 'brain-jerry', displayName: 'Jerry',
      canonicalRoot: '/private/brain', ownerAgent: 'jerry',
    },
    state: 'partial',
    startedAt: '2026-07-13T15:00:01.000Z',
    updatedAt: '2026-07-13T15:10:00.000Z',
    completedAt: '2026-07-13T15:10:00.000Z',
    progressSnapshot: { version: 1, stage: 'terminal', eventSequence: 5 },
    error: { code: 'pgs_scope_incomplete', retryable: true },
    pgsSession: {
      sessionId: SESSION_ID, continuableUntil, sourceOperationId: null,
    },
    result: null,
    resultHandle: `brres_${'H'.repeat(32)}`,
    resultArtifact: { mediaType: 'application/json', contentEncoding: 'identity', bytes: 1, sha256: '0'.repeat(64) },
    resultExpiresAt: '2026-07-20T15:10:00.000Z',
    resultExpiredAt: null,
    notebookResultSummary: {
      version: 1,
      resultVersion: `qrv1_${'V'.repeat(43)}`,
      answerAvailable: true,
      coverage: {
        coverageLevel: 'sample', coverageFraction: 0.25,
        scopePendingWorkUnits: 0, scopeComplete: true, fullCoverage: false,
        retryablePartitions: ['c-retry-001'], retryablePartitionCount: 1,
      },
      continuation: { canContinue: true, continuableUntil, sourceOperationId: null },
    },
    sourcePinDescriptor: {
      version: 1, canonicalRoot: '/private/brain', cutoffRevision: 42,
    },
    sourcePinDigest: `sha256:${'a'.repeat(64)}`,
    sourceEvidence: null,
    ...overrides,
  };
}

function pgsResult(record, retryablePartitions) {
  return {
    answer: 'partial answer',
    metadata: { pgs: {
      sessionId: record.pgsSession.sessionId,
      continuableUntil: record.pgsSession.continuableUntil,
      sourceOperationId: record.pgsSession.sourceOperationId,
      canContinue: true,
      retryablePartitions,
    } },
  };
}

function actionService({ record = sourceRecord(), result, startOperation } = {}) {
  const { tokens } = tokenAuthority();
  const reader = {
    expectedRequester: 'jerry',
    async listAuthorized() { return [record]; },
    async getAuthorized(operationId) {
      assert.equal(operationId, SOURCE_OPERATION_ID);
      return record;
    },
    async getResultAuthorized(operationId) {
      assert.equal(operationId, SOURCE_OPERATION_ID);
      return result ?? pgsResult(record, ['c-retry-001']);
    },
  };
  return {
    tokens,
    service: createQueryNotebookService({
      reader,
      now: () => NOW,
      actionTokens: tokens,
      startOperation: startOperation ?? (async () => ({
        operationId: CHILD_OPERATION_ID, operationType: 'pgs', state: 'queued',
      })),
    }),
  };
}

test('notebook projections issue only currently authorized executable actions', async () => {
  const { tokens, service } = actionService();
  const page = await service.listQueryNotebookAuthorized();
  assert.deepEqual(page.items[0].actions.map(({ kind }) => kind), [
    'continueSweep', 'targetedRetry',
  ]);
  for (const projected of page.items[0].actions) {
    assert.deepEqual(Object.keys(projected).sort(), ['expiresAt', 'kind', 'token']);
    assert.equal(tokens.verify(projected.token, {
      sourceOperationId: SOURCE_OPERATION_ID,
      action: projected.kind,
    }).expiresAt, projected.expiresAt);
    const serializedClaims = Buffer.from(projected.token.split('.')[0], 'base64url')
      .toString('utf8');
    for (const forbidden of [
      'Map the durable brain', 'brain-jerry', '/private/', 'c-retry-001', 'stored-sweep',
    ]) assert.equal(serializedClaims.includes(forbidden), false, forbidden);
  }
  const result = await service.getQueryNotebookResultAuthorized(SOURCE_OPERATION_ID);
  assert.deepEqual(result.actions.map(({ kind }) => kind), [
    'continueSweep', 'targetedRetry',
  ]);

  const unpinned = actionService({
    record: sourceRecord({ sourcePinDescriptor: null, sourcePinDigest: null }),
  });
  assert.deepEqual(
    (await unpinned.service.listQueryNotebookAuthorized()).items[0].actions,
    [],
  );

  const expired = actionService({
    record: sourceRecord({
      pgsSession: {
        ...sourceRecord().pgsSession,
        continuableUntil: '2026-07-13T15:59:59.000Z',
      },
      notebookResultSummary: {
        ...sourceRecord().notebookResultSummary,
        continuation: {
          ...sourceRecord().notebookResultSummary.continuation,
          continuableUntil: '2026-07-13T15:59:59.000Z',
        },
      },
    }),
  });
  assert.deepEqual(
    (await expired.service.listQueryNotebookAuthorized()).items[0].actions,
    [],
  );
});

test('action-enabled notebook service requires both token issue and verify authority', () => {
  const reader = {
    expectedRequester: 'jerry',
    async listAuthorized() { return []; },
    async getAuthorized() { return sourceRecord(); },
    async getResultAuthorized() { return {}; },
  };
  assert.throws(() => createQueryNotebookService({
    reader,
    actionTokens: { verify() {} },
    startOperation: async () => {},
  }), { code: 'notebook_configuration_invalid' });
});

test('targeted retry is projected only when every durable partition is executable', async () => {
  let starts = 0;
  const record = sourceRecord({
    notebookResultSummary: {
      ...sourceRecord().notebookResultSummary,
      coverage: {
        ...sourceRecord().notebookResultSummary.coverage,
        retryablePartitions: ['retry-1'],
        retryablePartitionCount: 1,
      },
    },
  });
  const { tokens, service } = actionService({
    record,
    result: pgsResult(record, ['retry-1']),
    startOperation: async () => { starts += 1; },
  });
  assert.deepEqual(
    (await service.listQueryNotebookAuthorized()).items[0].actions.map(({ kind }) => kind),
    ['continueSweep'],
  );
  const token = tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID,
    action: 'targetedRetry',
    expiresAt: LATER,
  });
  await assert.rejects(() => service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID,
    kind: 'targetedRetry',
    actionToken: token,
    requestId: REQUEST_ID,
  }), { code: 'action_unavailable' });
  assert.equal(starts, 0);
});

test('continuation advances only with explicit completed-scope evidence', async () => {
  for (const coverage of [
    null,
    { coverageLevel: 'sample', scopeComplete: true, fullCoverage: false },
    {
      coverageLevel: 'sample', scopePendingWorkUnits: 0,
      scopeComplete: false, fullCoverage: false,
    },
  ]) {
    let starts = 0;
    const record = sourceRecord({
      notebookResultSummary: {
        ...sourceRecord().notebookResultSummary,
        coverage,
      },
    });
    const { tokens, service } = actionService({
      record,
      startOperation: async () => { starts += 1; },
    });
    assert.equal(
      (await service.listQueryNotebookAuthorized()).items[0].actions
        .some(({ kind }) => kind === 'continueSweep'),
      false,
    );
    const token = tokens.issue({
      sourceOperationId: SOURCE_OPERATION_ID,
      action: 'continueSweep',
      expiresAt: LATER,
    });
    await assert.rejects(() => service.resolveAction({
      sourceOperationId: SOURCE_OPERATION_ID,
      kind: 'continueSweep',
      actionToken: token,
      requestId: REQUEST_ID,
    }), { code: 'action_unavailable' });
    assert.equal(starts, 0);
  }

  const pendingRecord = sourceRecord({
    notebookResultSummary: {
      ...sourceRecord().notebookResultSummary,
      coverage: {
        ...sourceRecord().notebookResultSummary.coverage,
        scopePendingWorkUnits: 2,
        scopeComplete: false,
      },
    },
  });
  const starts = [];
  const pending = actionService({
    record: pendingRecord,
    startOperation: async (request) => {
      starts.push(request);
      return { operationId: CHILD_OPERATION_ID, operationType: 'pgs', state: 'queued' };
    },
  });
  const pendingToken = pending.tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID,
    action: 'continueSweep',
    expiresAt: LATER,
  });
  await pending.service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID,
    kind: 'continueSweep',
    actionToken: pendingToken,
    requestId: REQUEST_ID,
  });
  assert.equal(starts[0].parameters.pgsLevel, 'sample');
});

test('retryable stalled PGS resumes committed sweep work at the same level', async () => {
  const stalled = sourceRecord({
    state: 'failed',
    error: { code: 'provider_stalled', retryable: true },
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    notebookResultSummary: null,
    progressSnapshot: {
      version: 1,
      stage: 'terminal',
      eventSequence: 2669,
      sourceNodes: 142231,
      sourceEdges: 465991,
      candidateWorkUnits: 1038,
      selected: 256,
      completed: 200,
      successful: 200,
      failed: 0,
      reused: 0,
      pending: 56,
      retryable: 0,
      total: 1038,
      lastProviderActivityAt: '2026-07-13T15:09:59.000Z',
      lastProgressAt: '2026-07-13T15:09:58.000Z',
    },
  });
  const starts = [];
  const { tokens, service } = actionService({
    record: stalled,
    startOperation: async (request) => {
      starts.push(request);
      return { operationId: CHILD_OPERATION_ID, operationType: 'pgs', state: 'queued' };
    },
  });

  const status = await service.getQueryNotebookStatusAuthorized(SOURCE_OPERATION_ID);
  assert.deepEqual(status.actions.map(({ kind }) => kind), ['continueSweep']);
  const actionToken = status.actions[0].token;
  assert.equal(tokens.verify(actionToken, {
    sourceOperationId: SOURCE_OPERATION_ID,
    action: 'continueSweep',
  }).action, 'continueSweep');

  await service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID,
    kind: 'continueSweep',
    actionToken,
    requestId: REQUEST_ID,
  });
  assert.deepEqual(starts, [{
    requestId: REQUEST_ID,
    operationType: 'pgs',
    target: { brainId: 'brain-jerry' },
    parameters: {
      query: 'Map the durable brain',
      pgsMode: 'continue',
      pgsLevel: 'sample',
      continueFromOperationId: SOURCE_OPERATION_ID,
      pgsSweep: { provider: 'minimax', model: 'stored-sweep' },
      pgsSynth: { provider: 'anthropic', model: 'stored-synth' },
    },
  }]);
});

test('failed PGS recovery remains unavailable without retryable bound durable progress', async () => {
  const stalled = sourceRecord({
    state: 'failed',
    error: { code: 'provider_stalled', retryable: true },
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    notebookResultSummary: null,
    progressSnapshot: {
      version: 1, stage: 'terminal', eventSequence: 10,
      selected: 4, completed: 2, successful: 2, failed: 0,
      reused: 0, pending: 2, retryable: 0, total: 4,
    },
  });
  const unavailable = [
    { ...stalled, error: { code: 'provider_stalled', retryable: false } },
    { ...stalled, error: { code: 'provider_failed', retryable: true } },
    {
      ...stalled,
      pgsSession: { ...stalled.pgsSession, continuableUntil: '2026-07-13T15:59:59.000Z' },
    },
    { ...stalled, pgsSession: null },
    { ...stalled, sourcePinDescriptor: null, sourcePinDigest: null },
    {
      ...stalled,
      progressSnapshot: {
        version: 1, stage: 'terminal', eventSequence: 10,
        selected: 4, completed: 0, successful: 0, failed: 0,
        reused: 0, pending: 4, retryable: 0, total: 4,
      },
    },
  ];

  for (const record of unavailable) {
    const { service } = actionService({ record });
    const status = await service.getQueryNotebookStatusAuthorized(SOURCE_OPERATION_ID);
    assert.deepEqual(status.actions, []);
  }
});

test('continue action reconstructs query, target, models, and next level from durable source only', async () => {
  const starts = [];
  const { tokens, service } = actionService({
    startOperation: async (request) => {
      starts.push(request);
      return { operationId: CHILD_OPERATION_ID, operationType: 'pgs', state: 'queued' };
    },
  });
  const actionToken = tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID, action: 'continueSweep', expiresAt: LATER,
  });
  const started = await service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID, kind: 'continueSweep',
    actionToken, requestId: REQUEST_ID,
  });
  assert.equal(started.operationId, CHILD_OPERATION_ID);
  assert.deepEqual(starts, [{
    requestId: REQUEST_ID,
    operationType: 'pgs',
    target: { brainId: 'brain-jerry' },
    parameters: {
      query: 'Map the durable brain',
      pgsMode: 'continue',
      pgsLevel: 'deep',
      continueFromOperationId: SOURCE_OPERATION_ID,
      pgsSweep: { provider: 'minimax', model: 'stored-sweep' },
      pgsSynth: { provider: 'anthropic', model: 'stored-synth' },
    },
  }]);
  await assert.rejects(() => service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID, kind: 'continueSweep',
    actionToken, requestId: REQUEST_ID,
    query: 'caller override',
  }), { code: 'invalid_request' });
});

test('action resolution binds the requested kind to the signed action before start', async () => {
  let starts = 0;
  const { tokens, service } = actionService({
    startOperation: async () => { starts += 1; },
  });
  const actionToken = tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID, action: 'continueSweep', expiresAt: LATER,
  });
  await assert.rejects(() => service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID,
    kind: 'targetedRetry',
    actionToken,
    requestId: REQUEST_ID,
  }), { code: 'action_token_invalid' });
  assert.equal(starts, 0);
});

test('targeted retry uses only durable canonical retryable partitions with a deterministic cap', async () => {
  const record = sourceRecord();
  const canonicalPartitions = Array.from(
    { length: 300 }, (_, index) => `c-retry-${String(index).padStart(3, '0')}`,
  );
  const durablePartitions = [...canonicalPartitions].reverse();
  const starts = [];
  const { tokens, service } = actionService({
    record,
    result: pgsResult(record, durablePartitions),
    startOperation: async (request) => {
      starts.push(request);
      return { operationId: CHILD_OPERATION_ID, operationType: 'pgs', state: 'queued' };
    },
  });
  const actionToken = tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID, action: 'targetedRetry', expiresAt: LATER,
  });
  await service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID, kind: 'targetedRetry',
    actionToken, requestId: REQUEST_ID,
  });
  assert.deepEqual(starts[0].parameters.targetPartitionIds, canonicalPartitions.slice(0, 256));
  assert.equal(starts[0].parameters.pgsMode, 'targeted');
  assert.equal(starts[0].parameters.continueFromOperationId, SOURCE_OPERATION_ID);
});

test('action resolution rejects session drift and never fresh-falls back on source change', async () => {
  let starts = 0;
  const drifted = sourceRecord({
    notebookResultSummary: {
      ...sourceRecord().notebookResultSummary,
      continuation: {
        ...sourceRecord().notebookResultSummary.continuation,
        continuableUntil: '2026-07-19T16:00:00.000Z',
      },
    },
  });
  const drift = actionService({ record: drifted, startOperation: async () => { starts += 1; } });
  const driftToken = drift.tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID, action: 'continueSweep', expiresAt: LATER,
  });
  await assert.rejects(() => drift.service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID, kind: 'continueSweep',
    actionToken: driftToken, requestId: REQUEST_ID,
  }), { code: 'action_unavailable' });
  assert.equal(starts, 0);

  const changed = actionService({ startOperation: async (request) => {
    starts += 1;
    assert.equal(request.parameters.pgsMode, 'continue');
    const error = new Error('source changed');
    error.code = 'source_changed';
    error.retryable = true;
    throw error;
  } });
  const changedToken = changed.tokens.issue({
    sourceOperationId: SOURCE_OPERATION_ID, action: 'continueSweep', expiresAt: LATER,
  });
  await assert.rejects(() => changed.service.resolveAction({
    sourceOperationId: SOURCE_OPERATION_ID, kind: 'continueSweep',
    actionToken: changedToken, requestId: REQUEST_ID,
  }), { code: 'source_changed' });
  assert.equal(starts, 1);
});
