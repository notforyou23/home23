'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function fixture(t, authority = 'live') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-brain-authority-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    context: {
      receiptRunDir: root,
      receiptRunId: 'authority-run',
      authority,
      implementationCommit: 'a'.repeat(40),
      hostname: 'fixture-host',
      startedAt: '2026-07-11T00:00:00.000Z',
    },
  };
}

test('pretty canonical JSON receipts round-trip as one row and artifact manifests classify them as receipts', async (t) => {
  const fx = await fixture(t);
  const common = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  const pretty = path.join(fx.root, 'live', 'canary.json');
  await common.writeJsonReceipt(fx.context, pretty, {
    helper: 'pretty-canary',
    receiptKind: 'operation-terminal',
    operationId: `brop_${'P'.repeat(32)}`,
  });

  const rows = await smoke.readReceiptRows(pretty);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].helper, 'pretty-canary');

  const output = path.join(fx.root, 'artifact-manifest.json');
  const manifest = await smoke.buildArtifactManifest({
    smokeRoot: fx.root,
    output,
    context: fx.context,
  });
  assert.deepEqual(
    manifest.artifacts.map(({ path: artifactPath, kind }) => ({ artifactPath, kind })),
    [{ artifactPath: 'live/canary.json', kind: 'receipt' }],
  );
  assert.equal((await smoke.readReceiptRows(output)).length, 1);
});

test('artifact manifests reject canonical pretty receipts with corrupt hashes or authority tags', async (t) => {
  await t.test('hash', async (subtest) => {
    const fx = await fixture(subtest);
    const common = await import('../../scripts/lib/brain-acceptance-common.mjs');
    const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
    const pretty = path.join(fx.root, 'live', 'corrupt.json');
    await common.writeJsonReceipt(fx.context, pretty, { helper: 'corrupt-hash' });
    const row = JSON.parse(await fs.readFile(pretty, 'utf8'));
    row.artifactSha256 = '0'.repeat(64);
    await fs.writeFile(pretty, `${JSON.stringify(row, null, 2)}\n`);
    await assert.rejects(
      smoke.buildArtifactManifest({
        smokeRoot: fx.root,
        output: path.join(fx.root, 'artifact-manifest.json'),
        context: fx.context,
      }),
      (error) => error.code === 'receipt_artifact_hash_mismatch',
    );
  });

  await t.test('authority tag', async (subtest) => {
    const fx = await fixture(subtest);
    const common = await import('../../scripts/lib/brain-acceptance-common.mjs');
    const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
    await common.writeJsonReceipt(
      { ...fx.context, authority: 'isolated-controlled' },
      path.join(fx.root, 'live', 'wrong-authority.json'),
      { helper: 'wrong-authority' },
    );
    await assert.rejects(
      smoke.buildArtifactManifest({
        smokeRoot: fx.root,
        output: path.join(fx.root, 'artifact-manifest.json'),
        context: fx.context,
      }),
      (error) => error.code === 'artifact_authority_mismatch',
    );
  });
});

function targetClient(catalog, { source, denySynthesis = true } = {}) {
  let providerCalls = 0;
  function resolve(selector = {}) {
    const byAgent = selector.agent
      ? catalog.brains.filter((brain) => brain.kind === 'resident'
        && brain.ownerAgent === selector.agent) : [];
    const byId = selector.brainId
      ? catalog.brains.filter((brain) => brain.id === selector.brainId) : [];
    if (byAgent.length > 1 || byId.length > 1) {
      throw Object.assign(new Error('target_ambiguous'), { code: 'target_ambiguous' });
    }
    if ((selector.agent && byAgent.length === 0) || (selector.brainId && byId.length === 0)) {
      throw Object.assign(new Error('target_not_found'), { code: 'target_not_found' });
    }
    if (byAgent[0] && byId[0] && byAgent[0].id !== byId[0].id) {
      throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
    }
    const selected = byAgent[0] || byId[0]
      || catalog.brains.find((brain) => brain.ownerAgent === 'jerry' && brain.kind === 'resident');
    const eligible = selected && ((selected.kind === 'resident' && selected.lifecycle === 'resident')
      || (selected.kind === 'research' && selected.lifecycle === 'completed'));
    if (!eligible) {
      throw Object.assign(new Error('target_not_available'), { code: 'target_not_available' });
    }
    return selected;
  }
  return {
    source,
    get providerCalls() { return providerCalls; },
    providerEvidence() {
      return { evidenceSource: 'test-provider-counter', providerCalls };
    },
    async getCatalog() { return structuredClone(catalog); },
    async resolveTarget(selector) { return resolve(selector); },
    async synthesize(request) {
      const selected = resolve(request.target);
      if (denySynthesis && selected.ownerAgent !== 'jerry') {
        throw Object.assign(new Error('access_denied'), { code: 'access_denied' });
      }
      providerCalls += 1;
      throw new Error('provider boundary must not be reached');
    },
    async probeAccessDenied(request) {
      const selected = resolve(request.target);
      if (denySynthesis && selected.ownerAgent !== 'jerry') {
        throw Object.assign(new Error('access_denied'), { code: 'access_denied' });
      }
      providerCalls += 1;
      throw new Error('provider boundary must not be reached');
    },
  };
}

test('negative target coverage observes all five exact codes without reaching a provider', async () => {
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  const primary = targetClient({
    catalogRevision: 'live-catalog',
    brains: [
      { id: 'brain-jerry', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-unavailable', ownerAgent: 'offline', kind: 'research', lifecycle: 'active' },
    ],
  }, { source: 'live-client' });
  const controlled = targetClient({
    catalogRevision: 'controlled-catalog',
    brains: [
      { id: 'brain-jerry-controlled', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-sibling', ownerAgent: 'forrest', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-unavailable-controlled', ownerAgent: 'offline', kind: 'research', lifecycle: 'active' },
      { id: 'brain-ambiguous-a', ownerAgent: 'twins', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-ambiguous-b', ownerAgent: 'twins', kind: 'resident', lifecycle: 'resident' },
    ],
  }, { source: 'controlled-production-client' });

  const result = await smoke.collectNegativeTargetCoverage({
    client: primary,
    controlledClient: controlled,
    callerAgent: 'jerry',
    expectedCodes: [
      'target_not_found',
      'target_not_available',
      'target_mismatch',
      'target_ambiguous',
      'access_denied',
    ],
    signal: new AbortController().signal,
    primaryAuthority: 'live',
  });

  assert.deepEqual(result.observedCodes, [
    'target_not_found',
    'target_not_available',
    'target_mismatch',
    'target_ambiguous',
    'access_denied',
  ]);
  assert.deepEqual(result.coverage.map(({ code, source, authority, providerFree }) => ({
    code, source, authority, providerFree,
  })), [
    { code: 'target_not_found', source: 'live-client', authority: 'live', providerFree: true },
    { code: 'target_not_available', source: 'live-client', authority: 'live', providerFree: true },
    {
      code: 'target_mismatch', source: 'controlled-production-client',
      authority: 'isolated-controlled', providerFree: true,
    },
    {
      code: 'target_ambiguous', source: 'controlled-production-client',
      authority: 'isolated-controlled', providerFree: true,
    },
    {
      code: 'access_denied', source: 'controlled-production-client',
      authority: 'isolated-controlled', providerFree: true,
    },
  ]);
  assert.equal(primary.providerCalls, 0);
  assert.equal(controlled.providerCalls, 0);
  assert.equal(result.providerCallsObserved, 0);
  assert.equal(result.providerEvidenceComplete, true);
  assert.ok(result.coverage.every((entry) =>
    entry.providerBoundaryEvidence?.providerCallDelta === 0));
});

test('negative target coverage requires the exact five-code contract', async () => {
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  await assert.rejects(smoke.collectNegativeTargetCoverage({
    client: {},
    callerAgent: 'jerry',
    expectedCodes: ['target_not_found'],
  }), (error) => error.code === 'negative_target_expected_codes_invalid');
});

test('negative target coverage falls back to controlled proof and rejects uninstrumented-only evidence', async () => {
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  const catalog = {
    catalogRevision: 'unproven-live-catalog',
    brains: [
      { id: 'brain-jerry', ownerAgent: 'jerry', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-sibling', ownerAgent: 'forrest', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-unavailable', ownerAgent: 'offline', kind: 'research', lifecycle: 'active' },
      { id: 'brain-ambiguous-a', ownerAgent: 'twins', kind: 'resident', lifecycle: 'resident' },
      { id: 'brain-ambiguous-b', ownerAgent: 'twins', kind: 'resident', lifecycle: 'resident' },
    ],
  };
  const unprovenDelegate = targetClient(catalog, { source: 'unproven-live-delegate' });
  const unprovenLive = {
    source: 'live-client-without-provider-proof',
    getCatalog: unprovenDelegate.getCatalog.bind(unprovenDelegate),
    resolveTarget: unprovenDelegate.resolveTarget.bind(unprovenDelegate),
    probeAccessDenied: unprovenDelegate.probeAccessDenied.bind(unprovenDelegate),
  };
  const controlled = targetClient(catalog, { source: 'controlled-production-client' });

  const result = await smoke.collectNegativeTargetCoverage({
    client: unprovenLive,
    controlledClient: controlled,
    callerAgent: 'jerry',
    expectedCodes: smoke.NEGATIVE_TARGET_CODES,
    primaryAuthority: 'live',
  });
  assert.equal(result.providerEvidenceComplete, true);
  assert.equal(result.providerCallsObserved, 0);
  assert.ok(result.coverage.every((entry) =>
    entry.source === 'controlled-production-client'
      && entry.authority === 'isolated-controlled'
      && entry.providerBoundaryEvidence?.providerCallDelta === 0));

  await assert.rejects(smoke.collectNegativeTargetCoverage({
    client: unprovenLive,
    callerAgent: 'jerry',
    expectedCodes: smoke.NEGATIVE_TARGET_CODES,
    primaryAuthority: 'live',
  }), (error) => error.code === 'negative_target_provider_evidence_incomplete');
});

test('default controlled negative client uses production resolver and authority code paths', async () => {
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  const { BrainOperationsClient } = await import('../../dist/agent/brain-operations/client.js');
  const controlled = smoke.createControlledNegativeTargetClient({
    Client: BrainOperationsClient,
    callerAgent: 'jerry',
  });
  const result = await smoke.collectNegativeTargetCoverage({
    client: controlled,
    controlledClient: controlled,
    callerAgent: 'jerry',
    expectedCodes: smoke.NEGATIVE_TARGET_CODES,
    primaryAuthority: 'isolated-controlled',
  });
  assert.deepEqual(result.observedCodes, smoke.NEGATIVE_TARGET_CODES);
  assert.equal(result.providerCallsObserved, 0);
  assert.equal(result.providerEvidenceComplete, true);
});

test('cross-brain synthesis denial crosses the production client, router, coordinator, and store without provider work', async (t) => {
  const fx = await fixture(t);
  const http = require('node:http');
  const express = require('express');
  const {
    createBrainOperationsPlaceholderRouter,
    createBrainOperationsRouter,
  } = require('../../engine/src/dashboard/brain-operations/router.js');
  const {
    BrainOperationCoordinator,
  } = require('../../engine/src/dashboard/brain-operations/coordinator.js');
  const {
    BrainOperationStore,
  } = require('../../engine/src/dashboard/brain-operations/operation-store.js');
  const {
    createBrainOperationStoreReader,
  } = require('../../engine/src/dashboard/brain-operations/store-reader.js');
  const {
    OPERATION_AUTHORITY,
    authorizeBrainOperation,
  } = require('../../shared/brain-operations/authority.cjs');
  const {
    resolveCanonicalTarget,
  } = require('../../cosmo23/server/lib/brain-registry.js');
  const { BrainOperationsClient } = await import('../../dist/agent/brain-operations/client.js');
  const { readResponseJsonBounded } = await import('../../scripts/live-brain-tools-smoke.mjs');

  const catalogEntry = (agent) => {
    const canonicalRoot = path.join(fx.root, 'brains', agent);
    return {
      id: `brain-${agent}`,
      ownerAgent: agent,
      displayName: agent,
      kind: 'resident',
      lifecycle: 'resident',
      canonicalRoot,
      sourceType: 'controlled-production-fixture',
      nodeCount: 1,
      modifiedAt: '2026-07-11T00:00:00.000Z',
      route: `/api/brain/brain-${agent}`,
      mutationBoundaries: mutationBoundaries(canonicalRoot),
    };
  };
  const catalog = Object.freeze({
    catalogRevision: 'production-negative-router-v1',
    brains: Object.freeze([catalogEntry('jerry'), catalogEntry('forrest')]),
  });
  const store = new BrainOperationStore({ root: fx.root, requesterAgent: 'jerry' });
  const reader = createBrainOperationStoreReader({
    operationsRoot: fx.root,
    expectedRequester: 'jerry',
    liveStore: store,
  });
  const calls = { worker: 0, model: 0, pin: 0, quota: 0 };
  const coordinator = new BrainOperationCoordinator({
    requesterAgent: 'jerry',
    store,
    buildCanonicalCatalog: async () => catalog,
    resolveCanonicalTarget,
    operationAuthority: OPERATION_AUTHORITY,
    authorizeBrainOperation,
    worker: {
      supportsSourceOperation: () => true,
      async start() {
        calls.worker += 1;
        throw new Error('worker must not start for an unauthorized target');
      },
    },
    sourcePins: {
      async pin() {
        calls.pin += 1;
        throw new Error('source pin must not be created for an unauthorized target');
      },
      async openPinnedSource() {
        throw new Error('source pin must not open for an unauthorized target');
      },
      async releaseOperationPins() {},
    },
    scratchQuotaFactory: async () => {
      calls.quota += 1;
      throw new Error('scratch quota must not be created for an unauthorized target');
    },
    operationModelResolver: async () => {
      calls.model += 1;
      throw new Error('model resolution must not run for an unauthorized target');
    },
  });
  t.after(() => coordinator.stop());

  const productionRoute = createBrainOperationsRouter({
    requesterAgent: 'jerry',
    coordinator,
    reader,
    exporter: { async exportResult() { throw new Error('unused exporter'); } },
    buildCatalog: async () => catalog,
  });
  const placeholder = createBrainOperationsPlaceholderRouter();
  placeholder.attach(productionRoute.router);
  const app = express();
  app.use('/home23/api/brain-operations', placeholder.router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(() => new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    return server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const client = new BrainOperationsClient({
    baseUrl,
    callerAgent: 'jerry',
    statusReadMs: 2_000,
  });
  const resolved = await client.resolveTarget({ agent: 'forrest' });
  assert.equal(resolved.accessMode, 'read-only');
  assert.equal(resolved.id, 'brain-forrest');

  const response = await fetch(`${baseUrl}/home23/api/brain-operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'production-access-denied-probe',
      operationType: 'synthesis',
      target: { brainId: 'brain-forrest' },
      parameters: { trigger: 'acceptance', reason: 'prove authorization precedes providers' },
    }),
  });
  assert.equal(response.status, 403);
  assert.equal((await readResponseJsonBounded(response, {
    maxBytes: 1024 * 1024,
    errorCode: 'authority_response_invalid',
  })).error.code, 'access_denied');
  assert.deepEqual(calls, { worker: 0, model: 0, pin: 0, quota: 0 });
  assert.deepEqual(await store.list(), []);
});

function mutationBoundaries(root) {
  return [
    { kind: 'brain', path: root },
    { kind: 'run', path: root },
    { kind: 'pgs', path: path.join(root, 'pgs-sessions') },
    { kind: 'session', path: path.join(root, 'sessions') },
    { kind: 'cache', path: path.join(root, 'cache') },
    { kind: 'export', path: path.join(root, 'exports') },
    { kind: 'agency', path: path.join(root, 'agency') },
  ];
}

function target(agent, root = `/fixture/${agent}/brain`) {
  return {
    domain: 'brain',
    brainId: `brain-${agent}`,
    canonicalRoot: root,
    accessMode: 'own',
    ownerAgent: agent,
    displayName: agent,
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-authority-v1',
    route: `/api/brain/brain-${agent}`,
    mutationBoundaries: mutationBoundaries(root),
  };
}

function evidence(agent, operationId) {
  return {
    selectedAgent: agent,
    selectedBrain: `brain-${agent}`,
    route: 'fixture-protected-readback',
    identity: {
      requesterAgent: agent,
      targetAgent: agent,
      brainId: `brain-${agent}`,
      operationId,
    },
    deltaWatermark: { revision: 7, epoch: 'e7', appliedRecords: 0 },
    authoritativeTotals: { nodes: 3, edges: 2 },
    returnedTotals: { nodes: 1, edges: 0 },
    sourceHealth: 'healthy',
    matchOutcome: 'matches',
  };
}

function projectedAnswer(answer) {
  return {
    answerPresent: true,
    answerBytes: Buffer.byteLength(answer),
    answerSha256: crypto.createHash('sha256').update(answer).digest('hex'),
    sweepOutputCount: null,
    sweepOutputs: null,
    metadata: null,
  };
}

function terminalRecord({ operationId, agent, answer }) {
  return {
    operationId,
    operationType: 'query',
    requesterAgent: agent,
    state: 'complete',
    target: target(agent),
    result: { answer },
    resultHandle: null,
    resultArtifact: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourceEvidence: evidence(agent, operationId),
    error: null,
  };
}

async function writeTerminalReceipt({
  common, context, file, record, authorizedEndpoint = null, isolatedStore = null,
}) {
  return common.appendJsonlReceipt(context, file, {
    helper: 'live-brain-tools-smoke',
    scenario: 'authority-fixture',
    receiptKind: 'operation-terminal',
    operationId: record.operationId,
    operationType: record.operationType,
    state: record.state,
    protectedResultRead: true,
    requesterAgent: record.requesterAgent,
    authorizedEndpoint,
    isolatedStore,
    target: record.target,
    resultHandle: record.resultHandle,
    resultArtifact: record.resultArtifact,
    sourcePinDescriptor: record.sourcePinDescriptor,
    sourcePinDigest: record.sourcePinDigest,
    sourceEvidence: record.sourceEvidence,
    error: record.error,
    result: projectedAnswer(record.result.answer),
  });
}

async function createIsolatedTerminal(t, agent = 'fixture-agent') {
  const operationsRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-retained-operation-store-'),
  ));
  t.after(() => fs.rm(operationsRoot, { recursive: true, force: true }));
  const { BrainOperationStore } = require('../../engine/src/dashboard/brain-operations/operation-store.js');
  const store = new BrainOperationStore({ root: operationsRoot, requesterAgent: agent });
  const created = await store.create({
    requestId: 'isolated-readback-request',
    requesterAgent: agent,
    target: target(agent),
    operationType: 'query',
    requestParameters: { query: 'isolated readback' },
    parameters: { query: 'isolated readback' },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: true,
  });
  const answer = 'isolated production store result';
  const stored = await store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result: { answer },
  });
  const sourceEvidence = evidence(agent, created.record.operationId);
  const terminal = await store.transition(created.record.operationId, {
    expectedVersion: stored.recordVersion,
    state: 'complete',
    phase: 'terminal',
    error: null,
    sourceEvidence,
  });
  return {
    operationsRoot,
    record: {
      ...terminal,
      result: { answer },
      sourceEvidence,
    },
  };
}

test('strict identity manifest rereads live and retained-store operations without crossing fixture IDs into live', async (t) => {
  const fx = await fixture(t);
  const common = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  const jerryUrl = 'http://jerry.invalid';
  const forrestUrl = 'http://forrest.invalid';
  const cosmoUrl = 'http://127.0.0.1:43210';
  const jerry = terminalRecord({
    operationId: `brop_${'J'.repeat(32)}`, agent: 'jerry', answer: 'jerry protected result',
  });
  const forrest = terminalRecord({
    operationId: `brop_${'F'.repeat(32)}`, agent: 'forrest', answer: 'forrest protected result',
  });
  const isolated = await createIsolatedTerminal(t);
  const liveContext = fx.context;
  const isolatedContext = { ...fx.context, authority: 'isolated-controlled' };
  const jerryReceipt = path.join(fx.root, 'live', 'jerry.jsonl');
  const forrestReceipt = path.join(fx.root, 'live', 'forrest.jsonl');
  const isolatedReceipt = path.join(fx.root, 'isolated-controlled', 'fixture.jsonl');
  await writeTerminalReceipt({
    common, context: liveContext, file: jerryReceipt, record: jerry,
    authorizedEndpoint: jerryUrl,
  });
  await writeTerminalReceipt({
    common, context: liveContext, file: forrestReceipt, record: forrest,
    authorizedEndpoint: forrestUrl,
  });
  await writeTerminalReceipt({
    common, context: isolatedContext, file: isolatedReceipt, record: isolated.record,
    isolatedStore: isolated.operationsRoot,
  });
  const manifestPath = path.join(fx.root, 'operation-identity-manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    receiptRunId: fx.context.receiptRunId,
    authorities: ['live', 'isolated-controlled'],
    auditRoot: fx.root,
    createdAt: '2026-07-11T00:10:00.000Z',
    groups: {
      jerryLive: [{
        operationId: jerry.operationId, authority: 'live', requesterAgent: 'jerry',
        receipt: path.relative(fx.root, jerryReceipt), isolatedStore: null,
        authorizedEndpoint: jerryUrl,
      }],
      forrestLive: [{
        operationId: forrest.operationId, authority: 'live', requesterAgent: 'forrest',
        receipt: path.relative(fx.root, forrestReceipt), isolatedStore: null,
        authorizedEndpoint: forrestUrl,
      }],
      isolatedControlled: [{
        operationId: isolated.record.operationId, authority: 'isolated-controlled',
        requesterAgent: 'fixture-agent', receipt: path.relative(fx.root, isolatedReceipt),
        isolatedStore: isolated.operationsRoot, authorizedEndpoint: null,
      }],
    },
  }, null, 2)}\n`);

  const calls = [];
  const endpointRecords = new Map([
    [jerryUrl, new Map([[jerry.operationId, jerry]])],
    [forrestUrl, new Map([[forrest.operationId, forrest]])],
  ]);
  const clientFactory = ({ baseUrl, callerAgent }) => ({
    async inspectOperation(operationId, mode) {
      calls.push({ baseUrl, callerAgent, operationId, mode });
      const record = endpointRecords.get(baseUrl)?.get(operationId);
      if (!record || record.requesterAgent !== callerAgent) {
        throw Object.assign(new Error('access_denied'), { code: 'access_denied' });
      }
      return structuredClone(record);
    },
  });
  const cosmoRequests = [];
  const fetchImpl = async (url, init = {}) => {
    cosmoRequests.push({ url: String(url), init });
    return new Response(JSON.stringify({
      success: false,
      error: { code: 'capability_invalid', message: 'capability_invalid' },
    }), { status: 401, headers: { 'content-type': 'application/json' } });
  };

  const verified = await smoke.verifyReceiptManifest({
    manifestPath,
    modules: {},
    context: fx.context,
    values: {
      'base-url': jerryUrl,
      'forrest-base-url': forrestUrl,
      'cosmo-base-url': cosmoUrl,
    },
    callerAgent: 'jerry',
    signal: new AbortController().signal,
    clientFactory,
    fetchImpl,
  });

  assert.equal(verified.ok, true);
  assert.deepEqual(verified.observed.map(({ group, operationId }) => ({ group, operationId })), [
    { group: 'jerryLive', operationId: jerry.operationId },
    { group: 'forrestLive', operationId: forrest.operationId },
    { group: 'isolatedControlled', operationId: isolated.record.operationId },
  ]);
  assert.deepEqual(verified.wrongRequesterReads.map(({ operationId, code }) => ({
    operationId, code,
  })), [
    { operationId: jerry.operationId, code: 'access_denied' },
    { operationId: forrest.operationId, code: 'access_denied' },
  ]);
  assert.equal(verified.isolatedWrongRequesterReads[0].code, 'access_denied');
  assert.deepEqual(verified.cosmoAuthorityRejection, {
    operationId: jerry.operationId,
    probes: [
      { action: 'status', method: 'GET',
        endpoint: `${cosmoUrl}/api/internal/brain-operations/${jerry.operationId}/status`,
        status: 401, code: 'capability_invalid' },
      { action: 'result', method: 'GET',
        endpoint: `${cosmoUrl}/api/internal/brain-operations/${jerry.operationId}/result`,
        status: 401, code: 'capability_invalid' },
      { action: 'cancel', method: 'POST',
        endpoint: `${cosmoUrl}/api/internal/brain-operations/${jerry.operationId}/cancel`,
        status: 401, code: 'capability_invalid' },
    ],
  });
  assert.equal(cosmoRequests.length, 3);
  assert.deepEqual(cosmoRequests.map((request) => request.init.method), ['GET', 'GET', 'POST']);
  assert.equal(cosmoRequests.every((request) =>
    Object.hasOwn(request.init.headers, 'authorization') === false), true);
  assert.equal(calls.some((call) => call.operationId === isolated.record.operationId), false);
  await assert.rejects(smoke.verifyReceiptManifest({
    manifestPath,
    modules: {},
    context: fx.context,
    values: {
      'base-url': jerryUrl,
      'forrest-base-url': forrestUrl,
      'cosmo-base-url': cosmoUrl,
    },
    callerAgent: 'jerry',
    signal: new AbortController().signal,
    clientFactory,
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'worker_not_found' },
    }), { status: 404, headers: { 'content-type': 'application/json' } }),
  }), (error) => error.code === 'cosmo_authority_rejection_unproven');

  const omitted = terminalRecord({
    operationId: `brop_${'U'.repeat(32)}`, agent: 'jerry', answer: 'unlisted result',
  });
  await writeTerminalReceipt({
    common,
    context: fx.context,
    file: path.join(fx.root, 'live', 'unlisted.jsonl'),
    record: omitted,
    authorizedEndpoint: jerryUrl,
  });
  await assert.rejects(smoke.verifyReceiptManifest({
    manifestPath,
    modules: {},
    context: fx.context,
    values: {
      'base-url': jerryUrl,
      'forrest-base-url': forrestUrl,
      'cosmo-base-url': cosmoUrl,
    },
    callerAgent: 'jerry',
    clientFactory,
    fetchImpl,
  }), (error) => error.code === 'identity_manifest_unlisted_operation');
});

test('identity manifest rejects missing required categories', async (t) => {
  const fx = await fixture(t);
  const smoke = await import('../../scripts/live-brain-tools-smoke.mjs');
  const manifestPath = path.join(fx.root, 'operation-identity-manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    receiptRunId: fx.context.receiptRunId,
    authorities: ['live', 'isolated-controlled'],
    auditRoot: fx.root,
    createdAt: '2026-07-11T00:10:00.000Z',
    groups: { jerryLive: [], isolatedControlled: [] },
  })}\n`);
  await assert.rejects(smoke.verifyReceiptManifest({
    manifestPath, modules: {}, context: fx.context, values: {}, callerAgent: 'jerry',
  }), (error) => error.code === 'identity_manifest_invalid');
});
