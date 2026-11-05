import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
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
  deriveNotebookResultSummary,
} = require('../../../engine/src/dashboard/brain-operations/operation-contract.js');
const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  MATCH_OUTCOME,
  SOURCE_HEALTH,
  createEvidence,
} = require('../../../shared/memory-source/contracts.cjs');
const {
  hasExactVerifiedFollowUpComponentSupport,
} = require('../../../shared/query/verified-follow-up-support.cjs');

const OPERATION_ID = `brop_${'N'.repeat(32)}`;
const NOW = '2026-07-13T16:00:00.000Z';
const FOLLOW_UP_PARENT_ID = `brop_${'P'.repeat(32)}`;
const FOLLOW_UP_CHILD_ID = `brop_${'C'.repeat(32)}`;
const FOLLOW_UP_GRANDCHILD_ID = `brop_${'G'.repeat(32)}`;

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

function canonicalParent({ operationId = FOLLOW_UP_PARENT_ID, operationType = 'query',
  answer = 'Verified parent answer.', overrides = {} } = {}) {
  const base = operationType === 'pgs'
    ? pgsRecord({ operationId })
    : queryRecord({ operationId });
  const result = { answer };
  const serializedSha256 = crypto.createHash('sha256')
    .update(canonicalJson(result), 'utf8').digest('hex');
  return {
    record: {
      ...base,
      operationId,
      result,
      notebookResultSummary: deriveNotebookResultSummary(base, result, serializedSha256),
      ...overrides,
    },
    result,
  };
}

function followUpBody(record, overrides = {}) {
  return {
    kind: 'verifiedFollowUp',
    schemaVersion: 1,
    followUpFrom: {
      operationId: record.operationId,
      resultVersion: record.notebookResultSummary.resultVersion,
    },
    query: 'What changed after that?',
    mode: 'dive',
    modelSelection: { provider: 'openai', model: 'gpt-5.2' },
    enableSynthesis: true,
    includeOutputs: true,
    includeThoughts: true,
    includeCoordinatorInsights: true,
    allowActions: false,
    ...overrides,
  };
}

function followUpCatalog(overrides = {}) {
  return {
    agent: 'jerry',
    available: true,
    models: [{ id: 'gpt-5.2', provider: 'openai', kind: 'chat' }],
    brains: [{ id: 'brain-jerry', displayName: 'Jerry' }],
    limits: { maxQueryChars: 12_000, maxPriorContextChars: 20_000 },
    ...overrides,
  };
}

function followUpServiceFixture({ parent, parentResult, parentLineage = null,
  parentPrivateContext = null, ready = true, catalog = followUpCatalog(),
  readError = null } = {}) {
  const calls = [];
  const readiness = { value: ready };
  let accepted = null;
  const coordinator = {
    async startVerifiedFollowUp(input) {
      calls.push(['coordinator', input.requestId, input.requestParameters]);
      if (accepted !== null) {
        if (accepted.requestId !== input.requestId
            || canonicalJson(accepted.body) !== canonicalJson(input.requestParameters)) {
          const error = new Error('idempotency_conflict');
          error.code = 'idempotency_conflict';
          throw error;
        }
        return accepted.record;
      }
      const acceptance = await input.resolveAcceptance();
      calls.push(['acceptance', acceptance]);
      const record = {
        operationId: FOLLOW_UP_CHILD_ID,
        operationType: 'query',
        requesterAgent: 'jerry',
        state: 'queued',
      };
      accepted = { requestId: input.requestId, body: input.requestParameters, record };
      return record;
    },
  };
  const reader = {
    expectedRequester: 'jerry',
    async listAuthorized() { return []; },
    async getAuthorized(operationId) {
      calls.push(['parent', operationId]);
      if (readError) throw readError;
      return parent;
    },
    async getResultAuthorized(operationId) {
      calls.push(['result', operationId]);
      return parentResult;
    },
    async getQueryFollowUpLineageAuthorized(operationId) {
      calls.push(['lineage', operationId]);
      return parentLineage;
    },
    async getVerifiedFollowUpContextAuthorized(operationId) {
      calls.push(['private', operationId]);
      return parentPrivateContext;
    },
  };
  const service = createQueryNotebookService({
    reader,
    now: () => NOW,
    coordinator,
    verifiedFollowUpReadiness: async () => {
      calls.push(['readiness']);
      return readiness.value;
    },
    queryCatalogProvider: async () => {
      calls.push(['catalog']);
      return catalog;
    },
  });
  return {
    service, calls, coordinator,
    setReadiness(value) { readiness.value = value; },
  };
}

test('protected notebook starter exposes exact immutable acceptance and replay support', () => {
  const { record, result } = canonicalParent();
  const fixture = followUpServiceFixture({ parent: record, parentResult: result });
  assert.equal(
    hasExactVerifiedFollowUpComponentSupport(fixture.service, 'protectedStarter'),
    true,
  );
});

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
    projection: {
      nodesScanned: 142_764,
      nodesRetained: 180,
      edgesScanned: 468_230,
      edgesRetained: 64,
      droppedForPromptBudget: 12,
      promptReduced: true,
    },
    answerQuality: {
      requestedMode: 'full', state: 'substantial', expansionAttempted: true,
    },
    sweepOutputs: [{ output: 'x'.repeat(1_000_000) }],
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
    projection: {
      nodesScanned: 142_764,
      nodesRetained: 180,
      edgesScanned: 468_230,
      edgesRetained: 64,
      droppedForPromptBudget: 12,
      promptReduced: true,
    },
    answerQuality: {
      requestedMode: 'full', state: 'substantial', expansionAttempted: true,
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

test('result receipt projection is exact and legacy results remain readable', () => {
  const legacy = projectNotebookResult(queryRecord(), { answer: 'legacy answer' });
  assert.equal(legacy.projection, null);
  assert.equal(legacy.answerQuality, null);

  const validProjection = {
    nodesScanned: 100,
    nodesRetained: 80,
    edgesScanned: 50,
    edgesRetained: 20,
    droppedForPromptBudget: 4,
    promptReduced: true,
  };
  const validQuality = {
    requestedMode: 'full', state: 'constrained', expansionAttempted: true,
  };
  for (const rawResult of [
    {
      answer: 'x',
      projection: { ...validProjection, privatePath: '/Users/jtr/private' },
      answerQuality: validQuality,
    },
    {
      answer: 'x',
      projection: { ...validProjection, nodesRetained: 101 },
      answerQuality: validQuality,
    },
    {
      answer: 'x',
      projection: { ...validProjection, promptReduced: false },
      answerQuality: validQuality,
    },
    {
      answer: 'x',
      projection: validProjection,
      answerQuality: { ...validQuality, requestedMode: 'dive' },
    },
    {
      answer: 'x', projection: validProjection,
    },
  ]) {
    assert.throws(
      () => projectNotebookResult(queryRecord(), rawResult),
      error => error?.code === 'notebook_result_invalid',
    );
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

test('notebook result exposes bounded retrieval coverage, timings, and authority counts', () => {
  const projected = projectNotebookResult(queryRecord({
    sourceEvidence: {
      sourceHealth: 'healthy',
      freshness: 'known',
      matchOutcome: 'matches',
      retrievalMode: 'semantic-ann-delta-overlay',
      indexCoverage: {
        complete: true,
        indexedRevision: 40,
        currentRevision: 45,
        coveredThroughRevision: 45,
        deltaRecords: 5,
        changedNodes: 2,
        upsertedNodes: 1,
        removedNodes: 1,
      },
      stageTimingsMs: {
        sourceOpen: 2,
        deltaOverlay: 3,
        embedding: 4,
        annLoad: 5,
        annQuery: 6,
        deltaSemantic: 7,
        keyword: 8,
        merge: 9,
        total: 44,
      },
      authoritySummary: {
        verifiedCurrentState: 2,
        jtrCorrection: 1,
        artifactLog: 1,
        workerReceipt: 0,
        generatedDoctrine: 0,
        narrative: 1,
        requiresFreshVerification: 1,
      },
      canonicalRoot: '/private/must-not-leak',
    },
  }), { answer: 'bounded answer' }, { now: () => NOW });

  assert.deepEqual(projected.evidence, {
    sourceHealth: 'healthy',
    freshness: 'known',
    matchOutcome: 'matches',
    retrievalMode: 'semantic-ann-delta-overlay',
    indexCoverage: {
      complete: true,
      indexedRevision: 40,
      currentRevision: 45,
      coveredThroughRevision: 45,
      deltaRecords: 5,
      distinctChangedNodes: 2,
      distinctUpsertedNodes: 1,
      distinctRemovedNodes: 1,
      edgeOnlyRecords: 0,
      changedNodes: 2,
      upsertedNodes: 1,
      removedNodes: 1,
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
      total: 5,
      authorityClasses: {
        verified_current_state: 2,
        jtr_correction: 1,
        artifact_log: 1,
        worker_receipt: 0,
        generated_doctrine: 0,
        narrative: 1,
      },
      retrievalDomains: {
        current_ops: 0,
        closed_incidents: 0,
        project_history: 0,
        external_intake: 0,
      },
      sourceChain: {
        withEvidence: 0,
        withoutEvidence: 0,
        referenceCounts: {
          source: 0,
          evidence: 0,
          artifact: 0,
          trace: 0,
          generation: 0,
          lineage: 0,
          verification: 0,
          closure: 0,
        },
      },
      verifiedCurrentState: 2,
      jtrCorrection: 1,
      artifactLog: 1,
      workerReceipt: 0,
      generatedDoctrine: 0,
      narrative: 1,
      requiresFreshVerification: 1,
    },
  });
  assert.equal(JSON.stringify(projected).includes('/private/'), false);
});

test('notebook projects real durable sourceEvidence into canonical public evidence', () => {
  const sourceEvidence = createEvidence({
    sourceHealth: 'healthy',
    freshness: 'known',
    matchOutcome: 'matches',
    deltaRevision: 45,
    retrievalMode: 'semantic-ann-delta-overlay',
    indexCoverage: {
      complete: true,
      indexedRevision: 40,
      currentRevision: 45,
      coveredThroughRevision: 45,
      deltaRecords: 5,
      distinctChangedNodes: 2,
      distinctUpsertedNodes: 1,
      distinctRemovedNodes: 1,
      edgeOnlyRecords: 0,
      route: 'ann-plus-delta',
      completeness: 'complete',
    },
    stageTimingsMs: {
      sourceOpen: 1.25,
      embedding: 2.5,
      overlayRefresh: 3.75,
      annLoad: 4,
      annSearch: 5,
      overlayScoring: 6,
      keywordScoring: 7,
      merge: 8,
      response: 9,
    },
    authoritySummary: {
      total: 2,
      authorityClasses: { verified_current_state: 1, narrative: 1 },
      retrievalDomains: { current_ops: 1, external_intake: 1 },
      sourceChain: {
        withEvidence: 1,
        withoutEvidence: 1,
        referenceCounts: { evidence: 1, generation: 1 },
      },
      requiresFreshVerification: 1,
    },
  });
  const record = queryRecord({ sourceEvidence });

  const projected = projectNotebookResult(record, { answer: 'bounded answer' }, { now: () => NOW });

  assert.equal(projected.evidence.retrievalMode, 'semantic-ann-delta-overlay');
  assert.equal(projected.evidence.indexCoverage.currentRevision, 45);
  assert.equal(projected.evidence.indexCoverage.distinctChangedNodes, 2);
  assert.equal(projected.evidence.stageTimingsMs.overlayRefresh, 3.75);
  assert.equal(projected.evidence.authoritySummary.total, 2);
  assert.equal(projected.evidence.authoritySummary.retrievalDomains.external_intake, 1);
  assert.equal(projected.evidence.authoritySummary.sourceChain.referenceCounts.evidence, 1);
  assert.equal(Object.hasOwn(projected, 'sourceEvidence'), false);
});

test('notebook rejects raw result source evidence that conflicts with the durable record', () => {
  const sourceEvidence = createEvidence({
    retrievalMode: 'semantic-ann',
    indexCoverage: {
      complete: true,
      indexedRevision: 45,
      currentRevision: 45,
      coveredThroughRevision: 45,
      deltaRecords: 0,
      route: 'ann',
      completeness: 'complete',
    },
  });
  assert.throws(() => projectNotebookResult(
    queryRecord({ sourceEvidence }),
    {
      answer: 'bounded answer',
      sourceEvidence: { ...sourceEvidence, retrievalMode: 'logical-source-scan' },
    },
    { now: () => NOW },
  ), { code: 'notebook_result_invalid' });
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

test('mixed notebook pages keep known legacy PGS receipts and count unknown rows', async () => {
  const modern = pgsRecord({
    operationId: `brop_${'M'.repeat(32)}`,
    acceptedAt: '2026-07-13T15:04:00.000Z',
  });
  const legacy = pgsRecord({
    operationId: `brop_${'L'.repeat(32)}`,
    acceptedAt: '2026-07-13T15:02:00.000Z',
    requestParameters: {
      query: 'legacy sweep', mode: 'quick', pgsMode: 'full',
      pgsConfig: { sweepFraction: 0.001 },
    },
    parameters: {
      query: 'legacy sweep', mode: 'quick', pgsMode: 'full',
      pgsConfig: { sweepFraction: 0.001 },
      pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
      pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
    },
    pgsSession: null,
    notebookResultSummary: {
      ...queryRecord().notebookResultSummary,
      coverage: {
        selectedWorkUnits: 1,
        successfulSweeps: 1,
        pendingWorkUnits: 2_647,
        retryablePartitionCount: 300,
        retryablePartitions: Array.from(
          { length: 300 }, (_, index) => `retry-${String(index).padStart(3, '0')}`,
        ),
      },
      continuation: null,
    },
  });
  const unknown = pgsRecord({
    operationId: `brop_${'U'.repeat(32)}`,
    acceptedAt: '2026-07-13T15:03:00.000Z',
    requestParameters: {
      query: 'unknown sweep', pgsMode: 'invented', pgsConfig: { sweepFraction: 0.001 },
    },
    parameters: {
      query: 'unknown sweep', pgsMode: 'invented', pgsConfig: { sweepFraction: 0.001 },
      pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
      pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
    },
    pgsSession: null,
    notebookResultSummary: {
      ...queryRecord().notebookResultSummary,
      coverage: null,
      continuation: null,
    },
  });
  const older = pgsRecord({
    operationId: `brop_${'O'.repeat(32)}`,
    acceptedAt: '2026-07-13T15:01:00.000Z',
  });
  const projectedLegacy = projectNotebookSummary(legacy, { now: () => NOW });
  assert.equal(projectedLegacy.configuration.legacy, true);
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return [older, legacy, unknown, modern]; },
      async getAuthorized() { throw new Error('not used'); },
      async getResultAuthorized() { throw new Error('not used'); },
    },
    now: () => NOW,
    actionTokens: {
      issue() { throw new Error('legacy receipt must not issue an action'); },
      verify() { throw new Error('not used'); },
    },
    startOperation: async () => { throw new Error('not used'); },
  });

  const first = await service.listQueryNotebookAuthorized({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.operationId), [
    modern.operationId, legacy.operationId,
  ]);
  assert.equal(first.items[1].configuration.pgsMode, 'fresh');
  assert.equal(first.items[1].configuration.pgsLevel, 'legacy');
  assert.equal(first.items[1].configuration.legacy, true);
  assert.equal(first.items[1].coverage.retryablePartitionCount, 300);
  assert.equal(Object.hasOwn(first.items[1].coverage, 'retryablePartitions'), false);
  assert.deepEqual(first.items[1].actions, []);
  assert.equal(first.omittedIncompatibleCount, 1);
  assert.equal(typeof first.nextCursor, 'string');

  const second = await service.listQueryNotebookAuthorized({
    limit: 2, cursor: first.nextCursor,
  });
  assert.deepEqual(second.items.map(item => item.operationId), [older.operationId]);
  assert.equal(second.omittedIncompatibleCount, 0);
  assert.equal(second.nextCursor, null);
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

test('terminal history removal hides inventory but preserves exact operation reads', async () => {
  const record = queryRecord();
  const hidden = new Set();
  const visibilityStore = {
    async hiddenOperationIds() { return [...hidden]; },
    async isHidden(operationId) { return hidden.has(operationId); },
    async hide(operationId) { hidden.add(operationId); return true; },
    async prune(existingOperationIds) {
      for (const operationId of [...hidden]) {
        if (!existingOperationIds.includes(operationId)) hidden.delete(operationId);
      }
    },
  };
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return [record]; },
      async getAuthorized() { return record; },
      async getResultAuthorized() { return { answer: 'bounded answer' }; },
    },
    visibilityStore,
    now: () => NOW,
  });

  assert.deepEqual((await service.listQueryNotebookAuthorized()).items
    .map(({ operationId }) => operationId), [OPERATION_ID]);
  assert.deepEqual(await service.hideQueryNotebookOperationAuthorized(OPERATION_ID), {
    schemaVersion: 1, operationId: OPERATION_ID, hidden: true,
  });
  assert.deepEqual((await service.listQueryNotebookAuthorized()).items, []);
  assert.equal((await service.getQueryNotebookStatusAuthorized(OPERATION_ID)).operationId,
    OPERATION_ID);
  assert.equal((await service.getQueryNotebookResultAuthorized(OPERATION_ID)).answer,
    'bounded answer');
  assert.deepEqual(await service.hideQueryNotebookOperationAuthorized(OPERATION_ID), {
    schemaVersion: 1, operationId: OPERATION_ID, hidden: true,
  });
});

test('history removal rejects active and foreign operations before visibility mutation', async () => {
  let record = queryRecord({ state: 'running', completedAt: null, result: null,
    resultExpiresAt: null, notebookResultSummary: null });
  let hideCalls = 0;
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return [record]; },
      async getAuthorized() { return record; },
      async getResultAuthorized() { throw new Error('not used'); },
    },
    visibilityStore: {
      async hiddenOperationIds() { return []; },
      async isHidden() { return false; },
      async hide() { hideCalls += 1; },
      async prune() {},
    },
    now: () => NOW,
  });

  await assert.rejects(
    () => service.hideQueryNotebookOperationAuthorized(OPERATION_ID),
    { code: 'operation_not_terminal' },
  );
  record = queryRecord({ requesterAgent: 'mallory' });
  await assert.rejects(
    () => service.hideQueryNotebookOperationAuthorized(OPERATION_ID),
    { code: 'access_denied' },
  );
  assert.equal(hideCalls, 0);
});

test('protected export is derived only from the stored bounded notebook result', async () => {
  const record = queryRecord();
  const calls = [];
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return []; },
      async getAuthorized(operationId) { calls.push(['get', operationId]); return record; },
      async getResultAuthorized(...args) {
        calls.push(['result', ...args]);
        return {
          answer: 'bounded answer',
          sweepOutputs: [{ output: 'private sweep output' }],
          resultHandle: `brres_${'H'.repeat(32)}`,
          canonicalRoot: '/private/brain',
          providerPayload: { secret: 'sk-private' },
        };
      },
    },
    now: () => NOW,
  });

  const exported = await service.exportQueryNotebookResultAuthorized(
    OPERATION_ID, { format: 'markdown' },
  );
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.operationId, OPERATION_ID);
  assert.equal(exported.resultVersion, `qrv1_${'v'.repeat(43)}`);
  assert.equal(exported.format, 'markdown');
  assert.match(exported.filename, /^home23-query-[A-Za-z0-9_-]{8}\.md$/);
  assert.equal(exported.mediaType, 'text/markdown; charset=utf-8');
  assert.equal(exported.content, '# Query Answer\n\nbounded answer\n');
  assert.equal(exported.bytes, Buffer.byteLength(exported.content, 'utf8'));
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls, [
    ['get', OPERATION_ID],
    ['result', OPERATION_ID],
  ]);
  for (const forbidden of [
    'sweepOutputs', 'resultHandle', 'canonicalRoot', '/private/', 'providerPayload', 'sk-private',
  ]) assert.equal(JSON.stringify(exported).includes(forbidden), false, forbidden);

  await assert.rejects(
    () => service.exportQueryNotebookResultAuthorized(OPERATION_ID, { format: 'json' }),
    { code: 'export_format_invalid' },
  );
  await assert.rejects(
    () => service.exportQueryNotebookResultAuthorized(OPERATION_ID, {
      format: 'markdown', answer: 'caller supplied',
    }),
    { code: 'invalid_request' },
  );
});

test('protected export rejects absent, expired, and non-text stored results', async () => {
  let record = queryRecord({
    state: 'failed', result: null, resultHandle: null, resultArtifact: null,
    resultExpiresAt: null, notebookResultSummary: null,
  });
  let answer = 'unused';
  const service = createQueryNotebookService({
    reader: {
      expectedRequester: 'jerry',
      async listAuthorized() { return []; },
      async getAuthorized() { return record; },
      async getResultAuthorized() { return { answer }; },
    },
    now: () => NOW,
  });
  await assert.rejects(
    () => service.exportQueryNotebookResultAuthorized(OPERATION_ID, { format: 'markdown' }),
    { code: 'result_unavailable' },
  );
  record = queryRecord({ result: null, resultExpiredAt: NOW });
  await assert.rejects(
    () => service.exportQueryNotebookResultAuthorized(OPERATION_ID, { format: 'markdown' }),
    { code: 'result_unavailable' },
  );
  record = queryRecord();
  answer = null;
  await assert.rejects(
    () => service.exportQueryNotebookResultAuthorized(OPERATION_ID, { format: 'markdown' }),
    { code: 'result_unavailable' },
  );
});

test('protected verified follow-up accepts terminal Direct and PGS sources on their exact brain', async () => {
  for (const operationType of ['query', 'pgs']) {
    const { record, result } = canonicalParent({ operationType });
    const { service, calls } = followUpServiceFixture({
      parent: record,
      parentResult: result,
    });
    const requestId = `qreq_${operationType === 'query' ? 'D' : 'P'}`.padEnd(37, operationType === 'query' ? 'D' : 'P');
    const started = await service.startVerifiedFollowUpAuthorized({
      requestId,
      body: followUpBody(record),
    });
    assert.equal(started.operationId, FOLLOW_UP_CHILD_ID);
    assert.equal(started.operationType, 'query');
    assert.equal(calls[0][0], 'coordinator');
    assert.deepEqual(calls.slice(1).map(([kind]) => kind), [
      'readiness', 'parent', 'result', 'lineage', 'private', 'catalog', 'acceptance',
    ]);
    const acceptance = calls.at(-1)[1];
    assert.deepEqual(acceptance.target, { brainId: 'brain-jerry' });
    assert.deepEqual(acceptance.queryFollowUpLineage, {
      rootOperationId: record.operationId,
      parentOperationId: record.operationId,
      parentResultVersion: record.notebookResultSummary.resultVersion,
      depth: 1,
      availableExchangeCount: 1,
      includedExchangeCount: 1,
      contextTruncated: false,
      sourceAnswerTruncated: false,
    });
    assert.equal(acceptance.privateContext.exchanges[0].answer, result.answer);
  }
});

test('verified follow-up carries the requester-bound private chain into a grandchild', async () => {
  const root = canonicalParent();
  const first = followUpServiceFixture({ parent: root.record, parentResult: root.result });
  await first.service.startVerifiedFollowUpAuthorized({
    requestId: `qreq_${'C'.repeat(32)}`,
    body: followUpBody(root.record),
  });
  const firstAcceptance = first.calls.at(-1)[1];
  const childResult = { answer: 'Verified child answer.' };
  const childBase = queryRecord({
    operationId: FOLLOW_UP_CHILD_ID,
    requestParameters: followUpBody(root.record),
    parameters: {
      query: 'What changed after that?', mode: 'dive',
      modelSelection: { provider: 'openai', model: 'gpt-5.2' },
    },
    target: { ...root.record.target },
  });
  const childSha = crypto.createHash('sha256')
    .update(canonicalJson(childResult), 'utf8').digest('hex');
  const child = {
    ...childBase,
    result: childResult,
    notebookResultSummary: deriveNotebookResultSummary(childBase, childResult, childSha),
  };
  const second = followUpServiceFixture({
    parent: child,
    parentResult: childResult,
    parentLineage: firstAcceptance.queryFollowUpLineage,
    parentPrivateContext: firstAcceptance.privateContext,
  });
  await second.service.startVerifiedFollowUpAuthorized({
    requestId: `qreq_${'G'.repeat(32)}`,
    body: followUpBody(child, { query: 'And what changed next?' }),
  });
  const grandchild = second.calls.at(-1)[1];
  assert.equal(grandchild.queryFollowUpLineage.rootOperationId, root.record.operationId);
  assert.equal(grandchild.queryFollowUpLineage.parentOperationId, child.operationId);
  assert.equal(grandchild.queryFollowUpLineage.depth, 2);
  assert.deepEqual(grandchild.privateContext.exchanges.map(({ operationId }) => operationId), [
    root.record.operationId, child.operationId,
  ]);
  assert.equal(grandchild.privateContext.exchanges[1].answer, childResult.answer);
});

test('exact replay wins before readiness, source, result, lineage, or catalog reads', async () => {
  const { record, result } = canonicalParent();
  const fixture = followUpServiceFixture({ parent: record, parentResult: result });
  const originalReadiness = fixture.service;
  const input = {
    requestId: `qreq_${'R'.repeat(32)}`,
    body: followUpBody(record),
  };
  const first = await originalReadiness.startVerifiedFollowUpAuthorized(input);
  const readsAfterFirst = fixture.calls.length;
  fixture.setReadiness(false);
  const replay = await originalReadiness.startVerifiedFollowUpAuthorized(input);
  assert.deepEqual(replay, first);
  assert.deepEqual(fixture.calls.slice(readsAfterFirst).map(([kind]) => kind), ['coordinator']);

  const unavailable = followUpServiceFixture({
    parent: record, parentResult: result, ready: false,
  });
  await assert.rejects(
    () => unavailable.service.startVerifiedFollowUpAuthorized({
      requestId: `qreq_${'U'.repeat(32)}`,
      body: followUpBody(record),
    }),
    { code: 'verified_follow_up_unavailable', httpStatus: 503, retryable: true },
  );
  assert.deepEqual(unavailable.calls.map(([kind]) => kind), ['coordinator', 'readiness']);

  await assert.rejects(
    () => fixture.service.startVerifiedFollowUpAuthorized({
      ...input, body: followUpBody(record, { query: 'Different body' }),
    }),
    { code: 'idempotency_conflict', retryable: true },
  );
  assert.deepEqual(fixture.calls.slice(readsAfterFirst + 1).map(([kind]) => kind), ['coordinator']);
});

test('verified follow-up bounds coordinator drift behind its public error algebra', async () => {
  const base = canonicalParent();
  for (const [internalCode, expected] of [
    [
      'source_operations_unavailable',
      { code: 'verified_follow_up_unavailable', httpStatus: 503, retryable: true },
    ],
    [
      'model_not_found',
      { code: 'follow_up_model_unavailable', httpStatus: 422, retryable: false },
    ],
  ]) {
    const fixture = followUpServiceFixture({ parent: base.record, parentResult: base.result });
    fixture.coordinator.startVerifiedFollowUp = async () => {
      throw Object.assign(new Error(internalCode), { code: internalCode });
    };
    await assert.rejects(
      () => fixture.service.startVerifiedFollowUpAuthorized({
        requestId: `qreq_${internalCode[0].toUpperCase().repeat(32)}`,
        body: followUpBody(base.record),
      }),
      expected,
      internalCode,
    );
  }
});

test('verified follow-up returns exact bounded source, result, and model failures', async () => {
  const base = canonicalParent();
  const cases = [
    {
      name: 'nonterminal',
      parent: { ...base.record, state: 'running', completedAt: null },
      result: base.result,
      expected: { code: 'follow_up_source_not_terminal', httpStatus: 409, retryable: true },
    },
    {
      name: 'unavailable',
      parent: {
        ...base.record,
        result: null,
        resultHandle: null,
        resultArtifact: null,
        resultExpiresAt: null,
        notebookResultSummary: null,
      },
      result: base.result,
      requestRecord: base.record,
      expected: { code: 'follow_up_source_unavailable', httpStatus: 404, retryable: true },
    },
    {
      name: 'expired',
      parent: { ...base.record, resultExpiredAt: NOW },
      result: base.result,
      expected: { code: 'follow_up_source_expired', httpStatus: 410, retryable: false },
    },
    {
      name: 'empty',
      parent: canonicalParent({ answer: '   ' }).record,
      result: { answer: '   ' },
      expected: { code: 'follow_up_source_empty', httpStatus: 422, retryable: false },
    },
    {
      name: 'model',
      parent: base.record,
      result: base.result,
      catalog: followUpCatalog({ models: [{ id: 'different', provider: 'openai' }] }),
      expected: { code: 'follow_up_model_unavailable', httpStatus: 422, retryable: false },
    },
  ];
  for (const row of cases) {
    const fixture = followUpServiceFixture({
      parent: row.parent,
      parentResult: row.result,
      catalog: row.catalog,
    });
    await assert.rejects(
      () => fixture.service.startVerifiedFollowUpAuthorized({
        requestId: `qreq_${row.name[0].toUpperCase().repeat(32)}`,
        body: followUpBody(row.requestRecord ?? row.parent),
      }),
      row.expected,
      row.name,
    );
  }

  const stale = followUpServiceFixture({ parent: base.record, parentResult: base.result });
  await assert.rejects(
    () => stale.service.startVerifiedFollowUpAuthorized({
      requestId: `qreq_${'S'.repeat(32)}`,
      body: followUpBody(base.record, {
        followUpFrom: {
          operationId: base.record.operationId,
          resultVersion: `qrv1_${'X'.repeat(43)}`,
        },
      }),
    }),
    { code: 'follow_up_result_version_conflict', httpStatus: 409, retryable: false },
  );
});

test('missing, foreign, cross-scope, and corrupt source references are indistinguishable', async () => {
  const base = canonicalParent();
  const inheritedFixture = followUpServiceFixture({
    parent: base.record,
    parentResult: base.result,
  });
  await inheritedFixture.service.startVerifiedFollowUpAuthorized({
    requestId: `qreq_${'I'.repeat(32)}`,
    body: followUpBody(base.record),
  });
  const inherited = inheritedFixture.calls.at(-1)[1];
  const followUpResult = { answer: 'Verified child answer.' };
  const followUpBase = queryRecord({
    operationId: FOLLOW_UP_CHILD_ID,
    requestParameters: followUpBody(base.record),
    parameters: {
      query: 'What changed after that?',
      mode: 'dive',
      modelSelection: { provider: 'openai', model: 'gpt-5.2' },
      enableSynthesis: true,
      includeOutputs: true,
      includeThoughts: true,
      includeCoordinatorInsights: true,
      allowActions: false,
    },
    target: { ...base.record.target },
    result: followUpResult,
  });
  const followUpSha = crypto.createHash('sha256')
    .update(canonicalJson(followUpResult), 'utf8').digest('hex');
  const followUpParent = {
    ...followUpBase,
    notebookResultSummary: deriveNotebookResultSummary(
      followUpBase, followUpResult, followUpSha,
    ),
  };
  const hidden = { code: 'follow_up_source_not_found', httpStatus: 404, retryable: false };
  const notFound = new Error('operation_not_found');
  notFound.code = 'operation_not_found';
  const variants = [
    { name: 'missing', readError: notFound },
    { name: 'foreign requester', parent: { ...base.record, requesterAgent: 'forrest' } },
    {
      name: 'cross-agent source',
      parent: { ...base.record, target: { ...base.record.target, ownerAgent: 'forrest' } },
    },
    {
      name: 'cross-brain source',
      parent: base.record,
      catalog: followUpCatalog({ brains: [{ id: 'brain-forrest', displayName: 'Forrest' }] }),
    },
    {
      name: 'malformed lineage pair',
      parent: base.record,
      parentLineage: {
        rootOperationId: base.record.operationId,
        parentOperationId: base.record.operationId,
        parentResultVersion: base.record.notebookResultSummary.resultVersion,
        depth: 1,
        availableExchangeCount: 1,
        includedExchangeCount: 1,
        contextTruncated: false,
        sourceAnswerTruncated: false,
      },
      parentPrivateContext: null,
    },
    {
      name: 'safe and private lineage mismatch',
      parent: followUpParent,
      parentResult: followUpResult,
      requestRecord: followUpParent,
      parentLineage: {
        ...inherited.queryFollowUpLineage,
        rootOperationId: FOLLOW_UP_GRANDCHILD_ID,
      },
      parentPrivateContext: inherited.privateContext,
    },
    {
      name: 'cyclic lineage',
      parent: { ...followUpParent, operationId: base.record.operationId },
      parentResult: followUpResult,
      requestRecord: { ...followUpParent, operationId: base.record.operationId },
      parentLineage: inherited.queryFollowUpLineage,
      parentPrivateContext: inherited.privateContext,
    },
  ];
  for (const row of variants) {
    const fixture = followUpServiceFixture({
      parent: row.parent ?? base.record,
      parentResult: row.parentResult ?? base.result,
      parentLineage: row.parentLineage,
      parentPrivateContext: row.parentPrivateContext,
      catalog: row.catalog,
      readError: row.readError,
    });
    await assert.rejects(
      () => fixture.service.startVerifiedFollowUpAuthorized({
        requestId: `qreq_${row.name[0].toUpperCase().repeat(32)}`,
        body: followUpBody(row.requestRecord ?? base.record),
      }),
      (error) => {
        assert.deepEqual({
          code: error.code, httpStatus: error.httpStatus, retryable: error.retryable,
        }, hidden);
        assert.equal(Object.hasOwn(error, 'operationId'), false);
        assert.equal(Object.hasOwn(error, 'brainId'), false);
        return true;
      },
      row.name,
    );
  }
});

test('verified follow-up derives current result identity and exact 20,000-unit context from catalog truth', async () => {
  const base = canonicalParent({ answer: 'A'.repeat(19_000) });
  const fixture = followUpServiceFixture({ parent: base.record, parentResult: base.result });
  await fixture.service.startVerifiedFollowUpAuthorized({
    requestId: `qreq_${'B'.repeat(32)}`,
    body: followUpBody(base.record),
  });
  const acceptance = fixture.calls.at(-1)[1];
  assert.ok(acceptance.privateContext.exchanges[0].answer.length <= 20_000);

  const tamperedResult = { answer: `${base.result.answer}!` };
  const tampered = followUpServiceFixture({
    parent: base.record,
    parentResult: tamperedResult,
  });
  await assert.rejects(
    () => tampered.service.startVerifiedFollowUpAuthorized({
      requestId: `qreq_${'T'.repeat(32)}`,
      body: followUpBody(base.record),
    }),
    { code: 'follow_up_result_version_conflict', retryable: false },
  );

  const wrongLimit = followUpServiceFixture({
    parent: base.record,
    parentResult: base.result,
    catalog: followUpCatalog({
      limits: { maxQueryChars: 12_000, maxPriorContextChars: 19_999 },
    }),
  });
  await assert.rejects(
    () => wrongLimit.service.startVerifiedFollowUpAuthorized({
      requestId: `qreq_${'L'.repeat(32)}`,
      body: followUpBody(base.record),
    }),
    { code: 'verified_follow_up_unavailable', httpStatus: 503, retryable: true },
  );
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
