import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createQueryNotebookService,
  decodeNotebookCursor,
  encodeNotebookCursor,
  projectNotebookSummary,
  projectNotebookResult,
} = require('../../../engine/src/dashboard/query-notebook-service.js');
const { BrainOperationStore } = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const {
  createBrainOperationStoreReader,
} = require('../../../engine/src/dashboard/brain-operations/store-reader.js');
const {
  MATCH_OUTCOME,
  SOURCE_HEALTH,
} = require('../../../shared/memory-source/contracts.cjs');

const OPERATION_ID = `brop_${'N'.repeat(32)}`;
const NOW = '2026-07-13T16:00:00.000Z';

function queryRecord(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    operationType: 'query',
    requestParameters: { query: 'How is the brain?', mode: 'full' },
    parameters: {
      query: 'How is the brain?', mode: 'full',
      modelSelection: { provider: 'anthropic', model: 'claude-opus-4-8' },
      operationControl: { hardDeadlineAt: '2099-01-01T00:00:00.000Z' },
    },
    acceptedAt: '2026-07-13T15:00:00.000Z',
    requesterAgent: 'jerry',
    target: {
      domain: 'brain', brainId: 'brain-jerry', displayName: 'Jerry',
      canonicalRoot: '/private/brain', route: '/private/route',
      mutationBoundaries: [{ kind: 'brain', path: '/private/brain' }],
    },
    state: 'complete',
    startedAt: '2026-07-13T15:00:01.000Z',
    updatedAt: '2026-07-13T15:00:02.000Z',
    completedAt: '2026-07-13T15:00:02.000Z',
    progressSnapshot: { version: 1, stage: 'terminal', eventSequence: 3 },
    error: null,
    pgsSession: null,
    result: { answer: 'bounded answer' },
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: '2026-07-20T15:00:02.000Z',
    resultExpiredAt: null,
    notebookResultSummary: {
      version: 1,
      resultVersion: `qrv1_${'v'.repeat(43)}`,
      answerAvailable: true,
      coverage: null,
      continuation: null,
    },
    sourceEvidence: {
      sourceHealth: 'healthy',
      identity: { canonicalRoot: '/private/brain' },
      returnedTotals: { nodes: 3, edges: 2 },
    },
    sourcePinDescriptor: { canonicalRoot: '/private/brain' },
    ...overrides,
  };
}

function pgsRecord(overrides = {}) {
  const session = {
    sessionId: `pgss_${'S'.repeat(32)}`,
    continuableUntil: '2026-07-20T15:00:00.000Z',
    sourceOperationId: null,
  };
  return queryRecord({
    operationType: 'pgs',
    requestParameters: { query: 'Map the brain', pgsMode: 'fresh', pgsLevel: 'sample' },
    parameters: {
      query: 'Map the brain', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'sweep-model' },
      pgsSynth: { provider: 'anthropic', model: 'synth-model' },
    },
    pgsSession: session,
    notebookResultSummary: {
      ...queryRecord().notebookResultSummary,
      continuation: {
        canContinue: true,
        continuableUntil: session.continuableUntil,
        sourceOperationId: null,
      },
    },
    ...overrides,
  });
}

test('summary and result projections are exact, bounded, and redacted', () => {
  const record = queryRecord();
  const summary = projectNotebookSummary(record, { now: () => NOW });
  assert.equal(summary.question, 'How is the brain?');
  assert.equal(summary.executionState, 'complete');
  assert.equal(summary.resultAvailability, 'available');
  assert.deepEqual(summary.configuration.directModel, {
    provider: 'anthropic', model: 'claude-opus-4-8',
  });

  const result = projectNotebookResult(record, {
    answer: 'bounded answer',
    sweepOutputs: [{ output: 'x'.repeat(1_000_000) }],
    sourceEvidence: { canonicalRoot: '/private/result' },
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    resultVersion: `qrv1_${'v'.repeat(43)}`,
    answer: 'bounded answer',
    coverage: null,
    evidence: {
      sourceHealth: 'healthy',
      returnedTotals: { nodes: 3, edges: 2 },
    },
    continuation: null,
  });

  for (const forbidden of [
    'canonicalRoot', 'mutationBoundaries', 'sourcePinDescriptor', 'resultHandle',
    'sweepOutputs', 'operationControl', '/private/',
  ]) {
    assert.equal(JSON.stringify({ summary, result }).includes(forbidden), false, forbidden);
  }
});

test('safe evidence publishes only canonical memory-source enum values', () => {
  const injected = projectNotebookResult(queryRecord({
    sourceEvidence: {
      sourceHealth: '/Users/jtr/private/brain',
      freshness: 'anthropic:claude-secret-provider',
      matchOutcome: 'sk-secret-token-value',
    },
  }), { answer: 'bounded answer' }, { now: () => NOW });
  assert.equal(injected.evidence, null);
  assert.equal(JSON.stringify(injected).includes('/Users/jtr/private'), false);
  assert.equal(JSON.stringify(injected).includes('anthropic'), false);
  assert.equal(JSON.stringify(injected).includes('sk-secret'), false);

  for (const sourceHealth of Object.values(SOURCE_HEALTH)) {
    const projected = projectNotebookResult(queryRecord({
      sourceEvidence: { sourceHealth },
    }), { answer: 'bounded answer' }, { now: () => NOW });
    assert.deepEqual(projected.evidence, { sourceHealth });
  }
  for (const matchOutcome of Object.values(MATCH_OUTCOME)) {
    const projected = projectNotebookResult(queryRecord({
      sourceEvidence: { matchOutcome },
    }), { answer: 'bounded answer' }, { now: () => NOW });
    assert.deepEqual(projected.evidence, { matchOutcome });
  }
  for (const freshness of ['known', 'unknown']) {
    const projected = projectNotebookResult(queryRecord({
      sourceEvidence: { freshness },
    }), { answer: 'bounded answer' }, { now: () => NOW });
    assert.deepEqual(projected.evidence, { freshness });
  }
});

function inventoryRecord(index, overrides = {}) {
  const suffix = String(index).padStart(32, '0');
  const minute = String(index).padStart(2, '0');
  return queryRecord({
    operationId: `brop_${suffix}`,
    requestParameters: { query: `Question ${minute} Alpha`, mode: 'full' },
    parameters: {
      query: `Question ${minute} Alpha`, mode: 'full',
      modelSelection: { provider: 'openai-codex', model: 'gpt-5.5' },
    },
    acceptedAt: `2026-07-13T15:${minute}:00.000Z`,
    startedAt: `2026-07-13T15:${minute}:01.000Z`,
    updatedAt: `2026-07-13T15:${minute}:02.000Z`,
    completedAt: `2026-07-13T15:${minute}:02.000Z`,
    ...overrides,
  });
}

test('authorized inventory paginates immutable acceptedAt order and binds normalized filters', async () => {
  const records = Array.from({ length: 30 }, (_, index) => inventoryRecord(index));
  records.push(inventoryRecord(29, {
    operationId: `brop_${'Z'.repeat(32)}`,
    requestParameters: { query: 'Tie breaker', mode: 'full' },
  }));
  let listCalls = 0;
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { listCalls += 1; return records; },
      async getAuthorized() { throw new Error('not used'); },
      async getResultAuthorized() { throw new Error('not used'); },
    },
    now: () => NOW,
  });

  const first = await service.listQueryNotebookAuthorized();
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].operationId, `brop_${'Z'.repeat(32)}`);
  assert.equal(first.items[1].operationId, `brop_${String(29).padStart(32, '0')}`);
  assert.equal(typeof first.nextCursor, 'string');
  assert.deepEqual(Object.keys(decodeNotebookCursor(first.nextCursor)).sort(), [
    'acceptedAt', 'filterDigest', 'operationId', 'v',
  ]);

  const second = await service.listQueryNotebookAuthorized({ cursor: first.nextCursor });
  assert.equal(second.items.length, 6);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.operationId)).size, 31);
  assert.equal(second.nextCursor, null);
  assert.equal(listCalls, 2);

  const searched = await service.listQueryNotebookAuthorized({ q: '  question 2  ' });
  assert.deepEqual(searched.items.map(row => row.question),
    Array.from({ length: 10 }, (_, offset) => `Question 2${9 - offset} Alpha`));
  await assert.rejects(
    () => service.listQueryNotebookAuthorized({ cursor: first.nextCursor, q: 'different' }),
    { code: 'notebook_cursor_filter_mismatch' },
  );
  await assert.rejects(
    () => service.listQueryNotebookAuthorized({ stateGroup: 'running', executionState: 'queued' }),
    { code: 'invalid_request' },
  );
  records[0] = inventoryRecord(0, {
    requestParameters: { query: 'Alpha   Beta', mode: 'full' },
  });
  assert.deepEqual((await service.listQueryNotebookAuthorized({ q: ' alpha beta ' }))
    .items.map(row => row.question), ['Alpha   Beta']);
});

test('unfiltered acceptedAt cursor remains complete when a later row finishes between pages', async () => {
  const records = Array.from({ length: 6 }, (_, index) => inventoryRecord(index, {
    state: 'running',
    completedAt: null,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    notebookResultSummary: null,
  }));
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return records; },
      async getAuthorized() { throw new Error('not used'); },
      async getResultAuthorized() { throw new Error('not used'); },
    },
    now: () => NOW,
  });

  const first = await service.listQueryNotebookAuthorized({ limit: 3 });
  const later = records.find(record => record.operationId === `brop_${String(1).padStart(32, '0')}`);
  later.state = 'complete';
  later.completedAt = '2026-07-13T15:01:30.000Z';
  later.updatedAt = later.completedAt;
  const second = await service.listQueryNotebookAuthorized({ limit: 3, cursor: first.nextCursor });
  const expected = records
    .toSorted((left, right) => right.acceptedAt.localeCompare(left.acceptedAt)
      || right.operationId.localeCompare(left.operationId))
    .map(record => record.operationId);
  const actual = [...first.items, ...second.items].map(record => record.operationId);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, records.length);
  assert.equal(second.items.find(record => record.operationId === later.operationId).executionState,
    'complete');
});

test('inventory filters before slicing, caps pages, and rejects foreign requester rows', async () => {
  const pgs = Array.from({ length: 105 }, (_, index) => inventoryRecord(index % 60, {
    operationId: `brop_${String(index).padStart(32, 'A')}`,
    operationType: 'pgs',
    requestParameters: {
      query: `PGS ${index}`, pgsMode: 'fresh', pgsLevel: 'sample',
    },
    parameters: {
      query: `PGS ${index}`, pgsMode: 'fresh', pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'sweep' },
      pgsSynth: { provider: 'anthropic', model: 'synth' },
    },
    state: index % 2 === 0 ? 'running' : 'complete',
    completedAt: index % 2 === 0 ? null : '2026-07-13T15:59:02.000Z',
    result: index % 2 === 0 ? null : { answer: 'done' },
    notebookResultSummary: index % 2 === 0 ? null : queryRecord().notebookResultSummary,
  }));
  const reader = {
    expectedRequester: 'jerry',
    async listAuthorized() { return pgs; },
    async getAuthorized() { throw new Error('not used'); },
    async getResultAuthorized() { throw new Error('not used'); },
  };
  const service = createQueryNotebookService({ reader, now: () => NOW });
  assert.equal((await service.listQueryNotebookAuthorized({ limit: 100 })).items.length, 100);
  assert.equal((await service.listQueryNotebookAuthorized({
    limit: 100, requestKind: 'pgs', stateGroup: 'running',
  })).items.length, 53);

  pgs.push(inventoryRecord(1, { requesterAgent: 'mallory' }));
  await assert.rejects(() => service.listQueryNotebookAuthorized(), { code: 'access_denied' });
});

test('grouped and exact state filters preserve the public state algebra', async () => {
  const states = ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted'];
  const records = states.map((state, index) => inventoryRecord(index, {
    state,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiresAt: null,
    notebookResultSummary: null,
    completedAt: ['queued', 'running'].includes(state)
      ? null : `2026-07-13T15:0${index}:02.000Z`,
  }));
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return records; },
      async getAuthorized() { throw new Error('not used'); },
      async getResultAuthorized() { throw new Error('not used'); },
    },
    now: () => NOW,
  });
  assert.deepEqual((await service.listQueryNotebookAuthorized({ stateGroup: 'running' }))
    .items.map(row => row.executionState).sort(), ['queued', 'running']);
  assert.deepEqual((await service.listQueryNotebookAuthorized({ stateGroup: 'finished' }))
    .items.map(row => row.executionState).sort(),
  ['cancelled', 'complete', 'failed', 'interrupted', 'partial']);
  for (const state of states) {
    const exact = await service.listQueryNotebookAuthorized({ executionState: state });
    assert.deepEqual(exact.items.map(row => row.executionState), [state]);
  }
});

test('cursor, search, timestamp, question, and answer bounds fail closed', async () => {
  const records = Array.from({ length: 3 }, (_, index) => inventoryRecord(index));
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return records; },
      async getAuthorized(operationId) {
        return records.find(record => record.operationId === operationId);
      },
      async getResultAuthorized() { return { answer: 'ok' }; },
    },
    now: () => NOW,
  });
  const cursor = (await service.listQueryNotebookAuthorized({ limit: 1 })).nextCursor;
  const parsed = decodeNotebookCursor(cursor);
  assert.throws(() => encodeNotebookCursor({ ...parsed, acceptedAt: null }),
    { code: 'notebook_cursor_invalid' });
  const withExtra = Buffer.from(JSON.stringify({ ...parsed, extra: true })).toString('base64url');
  assert.throws(() => decodeNotebookCursor(withExtra), { code: 'notebook_cursor_invalid' });
  assert.throws(() => decodeNotebookCursor('A'.repeat(2049)), { code: 'notebook_cursor_invalid' });
  await assert.rejects(() => service.listQueryNotebookAuthorized({ limit: 0 }),
    { code: 'invalid_request' });
  await assert.rejects(() => service.listQueryNotebookAuthorized({ limit: 101 }),
    { code: 'invalid_request' });
  await assert.rejects(() => service.listQueryNotebookAuthorized({ q: '\uFB03'.repeat(200) }),
    { code: 'invalid_request' });

  records[0] = { ...records[0], acceptedAt: null };
  await assert.rejects(() => service.listQueryNotebookAuthorized(),
    { code: 'notebook_projection_invalid' });
  assert.throws(() => projectNotebookSummary(queryRecord({
    requestParameters: { query: 'q'.repeat(12_001), mode: 'full' },
  })), { code: 'notebook_projection_invalid' });

  const exactlyBounded = projectNotebookResult(queryRecord(), { answer: 'a'.repeat(1024 * 1024) },
    { now: () => NOW });
  assert.equal(Buffer.byteLength(exactlyBounded.answer), 1024 * 1024);
  assert.throws(() => projectNotebookResult(queryRecord(), {
    answer: 'a'.repeat((1024 * 1024) + 1),
  }, { now: () => NOW }), { code: 'notebook_result_invalid' });
});

test('continuation is PGS-only, lineage-bound, and evaluated using the injected clock', () => {
  assert.throws(() => projectNotebookSummary(queryRecord({
    notebookResultSummary: {
      ...queryRecord().notebookResultSummary,
      continuation: {
        canContinue: true,
        continuableUntil: '2099-01-01T00:00:00.000Z',
        sourceOperationId: null,
      },
    },
  }), { now: () => NOW }), { code: 'notebook_projection_invalid' });
  const pgs = pgsRecord();
  assert.equal(projectNotebookResult(pgs, { answer: 'ok' }, {
    now: () => '2026-07-19T00:00:00.000Z',
  }).continuation.canContinue, true);
  assert.equal(projectNotebookResult(pgs, { answer: 'ok' }, {
    now: () => '2026-07-21T00:00:00.000Z',
  }).continuation.canContinue, false);
  assert.throws(() => projectNotebookSummary(pgsRecord({
    notebookResultSummary: {
      ...pgsRecord().notebookResultSummary,
      continuation: {
        ...pgsRecord().notebookResultSummary.continuation,
        sourceOperationId: `brop_${'X'.repeat(32)}`,
      },
    },
  }), { now: () => NOW }), { code: 'notebook_projection_invalid' });
});

test('expired and absent inventory mask result identity and stale continuation authority', () => {
  const expired = projectNotebookSummary(pgsRecord({
    result: null,
    resultExpiredAt: NOW,
    notebookResultSummary: {
      ...pgsRecord().notebookResultSummary,
      continuation: {
        ...pgsRecord().notebookResultSummary.continuation,
        continuableUntil: '2026-07-20T15:00:00.000Z',
      },
    },
  }), { now: () => NOW });
  assert.equal(expired.resultAvailability, 'expired');
  assert.equal(expired.resultVersion, null);
  assert.equal(expired.answerPreviewAvailable, false);
  assert.equal(expired.continuation.canContinue, false);

  const absent = projectNotebookSummary(queryRecord({
    state: 'failed', result: null, notebookResultSummary: null,
    resultExpiresAt: null,
  }), { now: () => NOW });
  assert.equal(absent.resultAvailability, 'absent');
  assert.equal(absent.resultVersion, null);
  assert.equal(absent.answerPreviewAvailable, false);
});

test('result detail loads through the requester reader without a caller handle', async () => {
  const record = queryRecord();
  const calls = [];
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return []; },
      async getAuthorized(operationId) { calls.push(['get', operationId]); return record; },
      async getResultAuthorized(...args) {
        calls.push(['result', ...args]);
        return { answer: 'bounded answer', sweepOutputs: [{ secret: true }] };
      },
    },
    now: () => NOW,
  });
  assert.equal((await service.getQueryNotebookResultAuthorized(OPERATION_ID)).answer, 'bounded answer');
  assert.deepEqual(calls, [
    ['get', OPERATION_ID],
    ['result', OPERATION_ID],
  ]);
});

function mutationBoundaries(root = '/brains/jerry') {
  return ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency']
    .map(kind => ({ kind, path: `${root}/${kind}` }));
}

function storeTarget() {
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot: '/brains/jerry',
    accessMode: 'own',
    ownerAgent: 'jerry',
    displayName: 'Jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: mutationBoundaries(),
  };
}

test('setResult atomically persists one bounded PGS notebook summary before file publication', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-notebook-store-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-07-13T15:00:00.000Z');
  const store = new BrainOperationStore({ root, requesterAgent: 'jerry', now: () => now });
  const created = await store.create({
    requestId: 'pgs-notebook-summary',
    requesterAgent: 'jerry',
    target: storeTarget(),
    operationType: 'pgs',
    requestParameters: {
      query: 'Map the brain', pgsMode: 'fresh', pgsLevel: 'sample',
    },
    parameters: {
      query: 'Map the brain', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsConfig: { sweepFraction: 0.25 },
      pgsSweep: { provider: 'minimax', model: 'sweep-model' },
      pgsSynth: { provider: 'anthropic', model: 'synth-model' },
    },
  });
  const session = {
    sessionId: `pgss_${'S'.repeat(32)}`,
    continuableUntil: '2026-07-20T15:00:00.000Z',
    sourceOperationId: null,
  };
  const worker = await store.setWorker(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    worker: { workerId: 'worker-1' },
    pgsSession: session,
  });
  const result = {
    answer: 'A'.repeat(70 * 1024),
    sweepOutputs: [{ partitionId: 'c-private', output: 'secret sweep output' }],
    metadata: { pgs: {
      sessionId: session.sessionId,
      continuableUntil: session.continuableUntil,
      sourceOperationId: null,
      canContinue: true,
      coverageLevel: 'sample',
      coverageFraction: 0.25,
      successfulSweeps: 3,
      reusedWorkUnits: 2,
      newWorkUnits: 1,
      scopeWorkUnits: 4,
      scopeSuccessfulWorkUnits: 3,
      scopePendingWorkUnits: 1,
      scopeComplete: false,
      globalCoveredWorkUnits: 3,
      globalPendingWorkUnits: 9,
      fullCoverage: false,
      targetPartitionIds: ['c-alpha'],
      retryablePartitions: Array.from(
        { length: 300 },
        (_, index) => `retry-${String(index).padStart(3, '0')}`,
      ),
      sourceTotals: { nodes: 999, edges: 888, privatePath: '/private/source' },
    } },
    sourceEvidence: { canonicalRoot: '/private/source' },
  };
  const published = await store.setResult(created.record.operationId, {
    expectedVersion: worker.recordVersion,
    result,
  });
  assert.equal(published.result, null);
  assert.match(published.resultHandle, /^brres_/);
  assert.match(published.notebookResultSummary.resultVersion, /^qrv1_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(published.notebookResultSummary, {
    version: 1,
    resultVersion: published.notebookResultSummary.resultVersion,
    answerAvailable: true,
    coverage: {
      coverageLevel: 'sample', coverageFraction: 0.25,
      successfulSweeps: 3, reusedWorkUnits: 2, newWorkUnits: 1,
      scopeWorkUnits: 4, scopeSuccessfulWorkUnits: 3, scopePendingWorkUnits: 1,
      scopeComplete: false, globalCoveredWorkUnits: 3, globalPendingWorkUnits: 9,
      fullCoverage: false, targetPartitionIds: ['c-alpha'],
      retryablePartitions: Array.from(
        { length: 256 },
        (_, index) => `retry-${String(index).padStart(3, '0')}`,
      ),
      retryablePartitionCount: 300,
    },
    continuation: {
      canContinue: true,
      continuableUntil: session.continuableUntil,
      sourceOperationId: null,
    },
  });
  const encodedSummary = JSON.stringify(published.notebookResultSummary);
  for (const forbidden of ['sweepOutputs', 'sourceTotals', 'privatePath', 'canonicalRoot', 'resultHandle']) {
    assert.equal(encodedSummary.includes(forbidden), false, forbidden);
  }

  now += 1000;
  const terminal = await store.transition(created.record.operationId, {
    expectedVersion: published.recordVersion,
    state: 'complete',
  });
  assert.deepEqual(terminal.notebookResultSummary, published.notebookResultSummary);

  const reader = createBrainOperationStoreReader({
    operationsRoot: root, expectedRequester: 'jerry', liveStore: store,
  });
  const inventory = await reader.listAuthorized();
  assert.equal(inventory.length, 1);
  assert.deepEqual(inventory[0].notebookResultSummary, published.notebookResultSummary);
  const service = createQueryNotebookService({ reader, now: () => NOW });
  const page = await service.listQueryNotebookAuthorized();
  assert.equal(page.items[0].resultVersion, published.notebookResultSummary.resultVersion);
  assert.equal(page.items[0].continuation.canContinue, true);
  assert.equal((await service.getQueryNotebookResultAuthorized(created.record.operationId)).answer,
    result.answer);
});

test('mismatched PGS continuation metadata preserves a useful partial without continuation authority', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-notebook-lineage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new BrainOperationStore({
    root,
    requesterAgent: 'jerry',
    now: () => Date.parse(NOW),
  });
  const created = await store.create({
    requestId: 'pgs-notebook-lineage-mismatch',
    requesterAgent: 'jerry',
    target: storeTarget(),
    operationType: 'pgs',
    requestParameters: {
      query: 'Keep useful partial evidence', pgsMode: 'fresh', pgsLevel: 'sample',
    },
    parameters: {
      query: 'Keep useful partial evidence', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'sweep-model' },
      pgsSynth: { provider: 'anthropic', model: 'synth-model' },
    },
  });
  const session = {
    sessionId: `pgss_${'D'.repeat(32)}`,
    continuableUntil: '2026-07-20T16:00:00.000Z',
    sourceOperationId: null,
  };
  const worker = await store.setWorker(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    worker: { workerId: 'lineage-worker' },
    pgsSession: session,
  });
  const usefulPartial = {
    answer: 'Useful partial answer',
    metadata: { pgs: {
      sessionId: `pgss_${'X'.repeat(32)}`,
      continuableUntil: session.continuableUntil,
      sourceOperationId: null,
      canContinue: true,
      coverageLevel: 'sample',
      coverageFraction: 0.25,
      scopeWorkUnits: 4,
      scopeSuccessfulWorkUnits: 2,
      scopePendingWorkUnits: 2,
      scopeComplete: false,
    } },
  };
  const published = await store.setResult(created.record.operationId, {
    expectedVersion: worker.recordVersion,
    result: usefulPartial,
  });
  assert.equal(published.result.answer, usefulPartial.answer);
  assert.equal(published.notebookResultSummary.answerAvailable, true);
  assert.equal(published.notebookResultSummary.continuation, null);
  const terminal = await store.transition(created.record.operationId, {
    expectedVersion: published.recordVersion,
    state: 'partial',
    error: { code: 'pgs_scope_incomplete', message: 'partial', retryable: true },
  });
  assert.equal(terminal.state, 'partial');
  assert.equal(terminal.result.answer, usefulPartial.answer);
  assert.equal(terminal.notebookResultSummary.continuation, null);

  const reader = createBrainOperationStoreReader({
    operationsRoot: root,
    expectedRequester: 'jerry',
    liveStore: store,
  });
  const service = createQueryNotebookService({
    reader,
    now: () => NOW,
    actionTokens: {
      issue() { throw new Error('continuation action must not be issued'); },
      verify() { throw new Error('not used'); },
    },
    startOperation: async () => { throw new Error('not used'); },
  });
  const page = await service.listQueryNotebookAuthorized();
  assert.equal(page.items[0].executionState, 'partial');
  assert.equal(page.items[0].continuation, null);
  assert.deepEqual(page.items[0].actions, []);
  const detail = await service.getQueryNotebookResultAuthorized(created.record.operationId);
  assert.equal(detail.answer, usefulPartial.answer);
  assert.equal(detail.continuation, null);
  assert.deepEqual(detail.actions, []);
});

function removePersistedNotebookSummary(root, operationId) {
  const file = path.join(root, 'operations', operationId, 'status.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const authority = {
    acceptedAt: record.acceptedAt,
    updatedAt: record.updatedAt,
    recordVersion: record.recordVersion,
    eventSequence: record.eventSequence,
  };
  delete record.notebookResultSummary;
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return { file, authority };
}

test('visible-page and detail reads lazily persist legacy inline/file summaries only once', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-notebook-legacy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-07-13T14:00:00.000Z');
  const store = new BrainOperationStore({ root, requesterAgent: 'jerry', now: () => now });
  const createQuery = async (requestId, answer) => {
    const created = await store.create({
      requestId,
      requesterAgent: 'jerry',
      target: storeTarget(),
      operationType: 'query',
      requestParameters: { query: requestId, mode: 'full' },
      parameters: {
        query: requestId, mode: 'full',
        modelSelection: { provider: 'openai-codex', model: 'gpt-5.5' },
      },
    });
    return store.setResult(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      result: { answer },
    });
  };

  const oldest = await createQuery('legacy-inline-oldest', 'inline answer');
  now += 1_000;
  const offPage = await createQuery('legacy-inline-off-page', 'must not be read');
  now += 1_000;
  const pgsCreated = await store.create({
    requestId: 'legacy-file-newest', requesterAgent: 'jerry', target: storeTarget(),
    operationType: 'pgs',
    requestParameters: { query: 'legacy file PGS', pgsMode: 'fresh', pgsLevel: 'sample' },
    parameters: {
      query: 'legacy file PGS', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsSweep: { provider: 'minimax', model: 'sweep' },
      pgsSynth: { provider: 'anthropic', model: 'synth' },
    },
  });
  const session = {
    sessionId: `pgss_${'L'.repeat(32)}`,
    continuableUntil: '2026-07-20T14:00:00.000Z',
    sourceOperationId: null,
  };
  const worker = await store.setWorker(pgsCreated.record.operationId, {
    expectedVersion: pgsCreated.record.recordVersion,
    worker: { workerId: 'legacy-worker' },
    pgsSession: session,
  });
  const newest = await store.setResult(pgsCreated.record.operationId, {
    expectedVersion: worker.recordVersion,
    result: {
      answer: 'F'.repeat(70 * 1024),
      metadata: { pgs: {
        sessionId: session.sessionId,
        continuableUntil: session.continuableUntil,
        sourceOperationId: null,
        canContinue: true,
        coverageLevel: 'sample', coverageFraction: 0.25,
        successfulSweeps: 2, scopeWorkUnits: 4,
        scopeSuccessfulWorkUnits: 2, scopePendingWorkUnits: 2,
        scopeComplete: false, retryablePartitions: ['retry-1', 'retry-2'],
      } },
    },
  });

  const legacy = [oldest, offPage, newest].map((record) =>
    removePersistedNotebookSummary(root, record.operationId));
  const backfills = [];
  const ensure = store.ensureNotebookResultSummary.bind(store);
  store.ensureNotebookResultSummary = async (operationId) => {
    backfills.push(operationId);
    return ensure(operationId);
  };
  const reader = createBrainOperationStoreReader({
    operationsRoot: root, expectedRequester: 'jerry', liveStore: store,
  });
  const service = createQueryNotebookService({ reader, now: () => NOW });

  const first = await service.listQueryNotebookAuthorized({ limit: 1 });
  assert.equal(first.items[0].operationId, newest.operationId);
  assert.deepEqual(backfills, [newest.operationId]);
  assert.equal(first.items[0].coverage.scopePendingWorkUnits, 2);
  assert.deepEqual(first.items[0].coverage.retryablePartitions, ['retry-1', 'retry-2']);
  assert.equal(first.items[0].coverage.retryablePartitionCount, 2);
  assert.equal(first.items[0].continuation.canContinue, true);
  const firstVersion = first.items[0].resultVersion;
  assert.match(firstVersion, /^qrv1_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.parse(fs.readFileSync(legacy[0].file, 'utf8')).notebookResultSummary, undefined);
  assert.equal(JSON.parse(fs.readFileSync(legacy[1].file, 'utf8')).notebookResultSummary, undefined);

  const repeated = await service.listQueryNotebookAuthorized({ limit: 1 });
  assert.equal(repeated.items[0].resultVersion, firstVersion);
  assert.deepEqual(backfills, [newest.operationId]);
  const migratedNewest = JSON.parse(fs.readFileSync(legacy[2].file, 'utf8'));
  for (const [field, value] of Object.entries(legacy[2].authority)) {
    assert.equal(migratedNewest[field], value, field);
  }

  const detail = await service.getQueryNotebookResultAuthorized(oldest.operationId);
  assert.equal(detail.answer, 'inline answer');
  assert.deepEqual(backfills, [newest.operationId, oldest.operationId]);
  const migratedOldest = JSON.parse(fs.readFileSync(legacy[0].file, 'utf8'));
  assert.match(migratedOldest.notebookResultSummary.resultVersion,
    /^qrv1_[A-Za-z0-9_-]{43}$/);
  for (const [field, value] of Object.entries(legacy[0].authority)) {
    assert.equal(migratedOldest[field], value, field);
  }
});
