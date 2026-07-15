import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BrainOperationStore,
} = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const {
  buildBrainOperationIdempotencyKey,
  OPERATION_EVENT_MAX_BYTES,
  OPERATION_EVENT_MAX_COUNT,
} = require('../../../engine/src/dashboard/brain-operations/operation-contract.js');
const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  BrainOperationCoordinator,
  DEFAULT_EXECUTION_DEADLINES_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  enrichSourceEvidence,
} = require('../../../engine/src/dashboard/brain-operations/coordinator.js');
const {
  BrainOperationWorkerAdapter,
  validateWorkerEvent,
} = require('../../../engine/src/dashboard/brain-operations/worker-adapter.js');
const {
  createCosmoBrainOperationWorkerClient,
} = require('../../../engine/src/dashboard/brain-operations/cosmo-worker-client.js');
const {
  OPERATION_AUTHORITY: REAL_OPERATION_AUTHORITY,
  authorizeBrainOperation: authorizeRealBrainOperation,
} = require('../../../shared/brain-operations/authority.cjs');
const {
  readDurableOperationLockCapability,
} = require('../../../shared/memory-source/durable-lock-authority.cjs');

const INITIAL_NOW = Date.parse('2026-07-10T16:00:00.000Z');
const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

function typedCode(code) {
  return (error) => error?.code === code;
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

async function flush(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function eventually(callback, rounds = 1000) {
  let lastError;
  for (let index = 0; index < rounds; index += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await flush(2);
    }
  }
  throw lastError;
}

class FakeTimers {
  constructor(now = INITIAL_NOW) {
    this.now = now;
    this.nextId = 1;
    this.entries = new Map();
  }

  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.entries.set(id, {
      id,
      callback,
      at: this.now + Math.max(0, Number(delay) || 0),
    });
    return id;
  };

  clearTimeout = (id) => {
    this.entries.delete(id);
  };

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.entries.values()]
        .filter((entry) => entry.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      this.entries.delete(due.id);
      this.now = due.at;
      await due.callback();
      await flush(4);
    }
    this.now = target;
    await flush(8);
  }

  pending() {
    return this.entries.size;
  }
}

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

function catalogEntry(agent, overrides = {}) {
  const canonicalRoot = overrides.canonicalRoot || `/brains/${agent}`;
  const id = overrides.id || `brain-${agent}`;
  return {
    id,
    displayName: overrides.displayName || agent,
    ownerAgent: agent,
    kind: 'resident',
    lifecycle: 'resident',
    canonicalRoot,
    sourceType: 'home23-agent',
    nodeCount: 12,
    modifiedAt: '2026-07-10T00:00:00.000Z',
    route: `/api/brain/${id}`,
    mutationBoundaries: mutationBoundaries(canonicalRoot),
    ...overrides,
  };
}

function makeCatalog(overrides = {}) {
  return Object.freeze({
    catalogRevision: overrides.catalogRevision || 'a'.repeat(64),
    brains: Object.freeze(overrides.brains || [catalogEntry('jerry'), catalogEntry('forrest')]),
  });
}

function resolveBrain(catalog, requesterAgent, selector = {}) {
  if (!selector || Array.isArray(selector) || typeof selector !== 'object') {
    const error = new Error('invalid_request');
    error.code = 'invalid_request';
    throw error;
  }
  if (Object.keys(selector).some((key) => key !== 'agent' && key !== 'brainId')) {
    const error = new Error('invalid_request');
    error.code = 'invalid_request';
    throw error;
  }
  const byAgent = selector.agent
    ? catalog.brains.filter((entry) => entry.ownerAgent === selector.agent && entry.kind === 'resident')
    : [];
  const byId = selector.brainId
    ? catalog.brains.filter((entry) => entry.id === selector.brainId)
    : [];
  if (byAgent.length > 1 || byId.length > 1) {
    const error = new Error('target_ambiguous');
    error.code = 'target_ambiguous';
    throw error;
  }
  if (byAgent[0] && byId[0] && byAgent[0].id !== byId[0].id) {
    const error = new Error('target_mismatch');
    error.code = 'target_mismatch';
    throw error;
  }
  if ((selector.agent !== undefined && byAgent.length === 0)
      || (selector.brainId !== undefined && byId.length === 0)) {
    const error = new Error('target_not_found');
    error.code = 'target_not_found';
    throw error;
  }
  const selected = byAgent[0] || byId[0] || catalog.brains.find((entry) =>
    entry.ownerAgent === requesterAgent && entry.kind === 'resident');
  if (!selected) {
    const error = new Error('target_not_found');
    error.code = 'target_not_found';
    throw error;
  }
  if (!['resident', 'completed'].includes(selected.lifecycle)) {
    const error = new Error('target_not_available');
    error.code = 'target_not_available';
    throw error;
  }
  return selected;
}

function ownedRunTarget(overrides = {}) {
  const canonicalRoot = '/runs/run-1';
  return {
    domain: 'owned-run',
    runId: 'run-1',
    canonicalRoot,
    ownerAgent: 'jerry',
    runState: 'active',
    catalogRevision: 'run-catalog-1',
    route: '/api/runs/run-1',
    mutationBoundaries: mutationBoundaries(canonicalRoot),
    ...overrides,
  };
}

const POLICIES = Object.freeze({
  search: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  graph: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  status: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  query: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  pgs: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  graph_export: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  synthesis: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  research_compile: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  research_launch: { domain: 'requester', requiresSourcePin: false, canonicalEvidence: true },
  research_continue: { domain: 'owned-run', requiresSourcePin: false, canonicalEvidence: true },
  research_stop: { domain: 'owned-run', requiresSourcePin: false, canonicalEvidence: true },
  research_watch: { domain: 'owned-run', requiresSourcePin: false, canonicalEvidence: true },
  research_intelligence: { domain: 'brain', requiresSourcePin: true, canonicalEvidence: true },
  ad_hoc_export: { domain: 'requester', requiresSourcePin: false, canonicalEvidence: false },
});

function authorizeBrainOperation({ requesterAgent, operationType, target }) {
  const policy = POLICIES[operationType];
  if (!policy || target.domain !== policy.domain) {
    const error = new Error('operation_not_authorized');
    error.code = 'operation_not_authorized';
    throw error;
  }
  if (target.domain === 'brain') {
    if (operationType === 'synthesis' && target.accessMode !== 'own') {
      const error = new Error('operation_not_authorized');
      error.code = 'operation_not_authorized';
      throw error;
    }
  } else if (target.domain === 'owned-run' && target.ownerAgent !== requesterAgent) {
    const error = new Error('operation_not_authorized');
    error.code = 'operation_not_authorized';
    throw error;
  } else if (target.domain === 'requester' && target.requesterAgent !== requesterAgent) {
    const error = new Error('operation_not_authorized');
    error.code = 'operation_not_authorized';
    throw error;
  }
  return policy;
}

function validDescriptor(canonicalRoot = '/brains/jerry') {
  return {
    version: 1,
    canonicalRoot,
    generation: 'g1',
    baseRevision: 1,
    cutoffRevision: 1,
    activeBase: {
      nodes: { file: 'nodes.base-1.jsonl.gz', count: 12, bytes: 100 },
      edges: { file: 'edges.base-1.jsonl.gz', count: 10, bytes: 100 },
    },
    activeDelta: {
      epoch: 'e1',
      file: 'delta.e1.jsonl',
      fromRevision: 2,
      toRevision: 1,
      count: 0,
      committedBytes: 0,
    },
    summary: { nodeCount: 12, edgeCount: 10, clusterCount: 2 },
  };
}

function descriptorDigest(descriptor) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(descriptor)).digest('hex')}`;
}

function synthesisCompletion(operationId, overrides = {}) {
  return {
    version: 1,
    operationId,
    generationMarker: `generation-1-${'a'.repeat(24)}`,
    generatedAt: '2026-07-10T16:00:00.000Z',
    sourceRevision: 1,
    provider: 'fake',
    model: 'synthesis-model',
    brainStateSha256: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
}

function synthesisResultFromClaim(claim) {
  const { version, ...result } = claim;
  return result;
}

function synthesisStateFromClaim(claim) {
  return {
    ...synthesisResultFromClaim(claim),
    selfUnderstanding: {},
    consolidatedInsights: [],
    recentActivity: [],
  };
}

function pinnedSourceHandle(descriptor, { release = async () => {} } = {}) {
  return {
    revision: descriptor.cutoffRevision,
    descriptor,
    evidence: { baseRevision: descriptor.baseRevision, cutoffRevision: descriptor.cutoffRevision },
    async *iterateNodes() {},
    async *iterateEdges() {},
    async summarize() { return {}; },
    async searchKeyword() { return {}; },
    getEvidence() { return this.evidence; },
    async isCurrent() { return true; },
    async compareAndSwap(commit) { return { committed: true, value: await commit() }; },
    release,
  };
}

class ControlledWorker {
  constructor() {
    this.supportsSourceOperations = true;
    this.records = new Map();
    this.startCalls = [];
    this.statusCalls = [];
    this.eventsCalls = [];
    this.resultCalls = [];
    this.cancelCalls = [];
    this.waiters = new Map();
    this.blockStart = null;
    this.startError = null;
  }

  _notify(operationId) {
    const waiters = this.waiters.get(operationId) || [];
    this.waiters.delete(operationId);
    for (const waiter of waiters) waiter();
  }

  async start(context, capability) {
    this.startCalls.push({ context: structuredClone({
      ...context,
      sourcePin: context.sourcePin ? { descriptor: context.sourcePin.descriptor } : null,
      scratchQuota: context.scratchQuota ? { present: true } : null,
    }), capability });
    if (this.blockStart) await this.blockStart.promise;
    if (this.startError) throw this.startError;
    let record = this.records.get(context.operationId);
    if (!record) {
      record = {
        reference: {
          version: 1,
          workerId: `worker-${context.operationId}`,
          workerType: 'cosmo',
          operationType: context.operationType,
        },
        operationId: context.operationId,
        state: 'running',
        phase: 'executing',
        eventSequence: 0,
        activeProviderCalls: [],
        events: [],
        result: null,
        ...(context.operationType === 'pgs' && this.pgsSessionForStarts
          ? { pgsSession: structuredClone(this.pgsSessionForStarts(context)) }
          : {}),
      };
      this.records.set(context.operationId, record);
    }
    return this.publicRecord(record);
  }

  publicRecord(record) {
    return structuredClone({
      reference: record.reference,
      operationId: record.operationId,
      operationType: record.reference.operationType,
      state: record.state,
      phase: record.phase,
      eventSequence: record.eventSequence,
      activeProviderCalls: record.activeProviderCalls,
      ...(record.pgsSession ? { pgsSession: record.pgsSession } : {}),
    });
  }

  async status(operationId, capability) {
    this.statusCalls.push({ operationId, capability });
    const record = this.records.get(operationId);
    if (!record) {
      const error = new Error('worker_not_found');
      error.code = 'worker_not_found';
      throw error;
    }
    return this.publicRecord(record);
  }

  async *events(operationId, { afterSequence, signal }, capability) {
    this.eventsCalls.push({ operationId, afterSequence, signal, capability });
    let cursor = afterSequence;
    while (!signal?.aborted) {
      const record = this.records.get(operationId);
      if (!record) return;
      const next = record.events.find((event) => event.eventSequence > cursor);
      if (next) {
        cursor = next.eventSequence;
        yield structuredClone(next);
        continue;
      }
      if (TERMINAL.has(record.state)) return;
      await new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const current = this.waiters.get(operationId) || [];
          const index = current.indexOf(finish);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) this.waiters.delete(operationId);
          else this.waiters.set(operationId, current);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const waiters = this.waiters.get(operationId) || [];
        waiters.push(finish);
        this.waiters.set(operationId, waiters);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
  }

  emit(operationId, rawEvent) {
    const record = this.records.get(operationId);
    assert.ok(record, `missing controlled worker ${operationId}`);
    const eventSequence = rawEvent.eventSequence ?? record.eventSequence + 1;
    record.eventSequence = Math.max(record.eventSequence, eventSequence);
    const event = { ...rawEvent, operationId, eventSequence };
    if (event.type === 'provider_selected') {
      record.activeProviderCalls.push({
        providerCallId: event.providerCallId,
        providerStallMs: event.providerStallMs,
        idleMs: 0,
      });
    } else if (event.type === 'provider_call_terminal') {
      record.activeProviderCalls = record.activeProviderCalls.filter((call) =>
        call.providerCallId !== event.providerCallId);
    }
    record.events.push(event);
    this._notify(operationId);
    return event;
  }

  finish(operationId, envelope, { emit = true } = {}) {
    const record = this.records.get(operationId);
    assert.ok(record);
    record.state = envelope.state;
    record.phase = 'terminal';
    record.result = structuredClone(envelope);
    record.activeProviderCalls = [];
    if (emit) this.emit(operationId, { type: 'terminal', state: envelope.state });
    else this._notify(operationId);
  }

  async result(operationId, capability, statusCapability) {
    this.resultCalls.push({ operationId, capability, statusCapability });
    const record = this.records.get(operationId);
    if (!record?.result) {
      const error = new Error('worker_result_unavailable');
      error.code = 'worker_result_unavailable';
      throw error;
    }
    return structuredClone(record.result);
  }

  async cancel(operationId, capability) {
    this.cancelCalls.push({ operationId, capability });
    const record = this.records.get(operationId);
    if (!record) {
      const error = new Error('worker_not_found');
      error.code = 'worker_not_found';
      throw error;
    }
    return this.publicRecord(record);
  }
}

function makeFixture(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'home23-brain-coordinator-')));
  const timers = overrides.timers || new FakeTimers();
  const store = overrides.store || new BrainOperationStore({
    root,
    requesterAgent: 'jerry',
    now: () => timers.now,
    lockTimeoutMs: 5_000,
  });
  const worker = overrides.worker || new ControlledWorker();
  const counters = {
    catalog: 0,
    authority: 0,
    model: 0,
    pin: 0,
    open: 0,
    releaseCalls: 0,
    releaseVisible: new Set(),
    quota: 0,
    capabilities: [],
  };
  let catalog = overrides.catalog || makeCatalog();
  const sourcePins = overrides.sourcePins === undefined ? {
    async pin(canonicalRoot) {
      counters.pin += 1;
      const descriptor = validDescriptor(canonicalRoot);
      return { descriptor, digest: descriptorDigest(descriptor) };
    },
    async openPinnedSource(descriptor) {
      counters.open += 1;
      return pinnedSourceHandle(descriptor);
    },
    async releaseOperationPins(operationId) {
      counters.releaseCalls += 1;
      counters.releaseVisible.add(operationId);
    },
  } : overrides.sourcePins;
  const scratchQuotaFactory = overrides.scratchQuotaFactory === undefined ? async () => {
    counters.quota += 1;
    return {
      async claim() {},
      async release() {},
      async reconcile() { return {}; },
      async assertOperationRoot() { return true; },
      async close() {},
    };
  } : overrides.scratchQuotaFactory;
  const operationModelResolver = overrides.operationModelResolver === undefined
    ? async ({ operationType, requestParameters }) => {
      counters.model += 1;
      if (operationType === 'query') {
        return { ...requestParameters, modelSelection: requestParameters.modelSelection || {
          provider: 'fake', model: 'query-model',
        } };
      }
      if (operationType === 'pgs') {
        return {
          ...requestParameters,
          pgsSweep: requestParameters.pgsSweep || { provider: 'fake', model: 'sweep-model' },
          pgsSynth: requestParameters.pgsSynth || { provider: 'fake', model: 'synth-model' },
        };
      }
      if (operationType === 'synthesis') {
        return { ...requestParameters, provider: 'fake', model: 'synthesis-model' };
      }
      return { ...requestParameters };
    }
    : overrides.operationModelResolver;
  const coordinator = new BrainOperationCoordinator({
    requesterAgent: 'jerry',
    store,
    buildCanonicalCatalog: overrides.buildCanonicalCatalog || (async () => {
      counters.catalog += 1;
      if (catalog instanceof Error) throw catalog;
      return catalog;
    }),
    resolveCanonicalTarget: overrides.resolveCanonicalTarget || resolveBrain,
    resolveOwnedRunTarget: overrides.resolveOwnedRunTarget || (async ({ runId }) => {
      if (runId !== 'run-1') {
        const error = new Error('target_not_found');
        error.code = 'target_not_found';
        throw error;
      }
      return ownedRunTarget();
    }),
    operationAuthority: POLICIES,
    authorizeBrainOperation: overrides.authorizeBrainOperation || ((input) => {
      counters.authority += 1;
      return authorizeBrainOperation(input);
    }),
    worker,
    sourcePins,
    scratchQuotaFactory,
    operationModelResolver,
    readSynthesisState: overrides.readSynthesisState,
    onTerminal: overrides.onTerminal,
    capabilityIssuer: overrides.capabilityIssuer || (({ operationId, purpose }) => {
      const token = `cap-${purpose}-${operationId}-${counters.capabilities.length + 1}`;
      counters.capabilities.push({ operationId, purpose, token });
      return token;
    }),
    clock: { now: () => timers.now },
    timers,
    limits: {
      heartbeatMs: 10_000,
      eventSilenceMs: 60_000,
      workerControlTimeoutMs: overrides.workerControlTimeoutMs,
      workerStartTimeoutMs: overrides.workerStartTimeoutMs,
      stopTimeoutMs: overrides.stopTimeoutMs,
      executionDeadlineMsByType: {
        search: 60_000,
        graph: 60_000,
        status: 60_000,
        query: 7_200_000,
        pgs: 28_800_000,
        graph_export: 7_200_000,
        synthesis: 28_800_000,
        research_compile: 7_200_000,
        research_launch: 7_200_000,
        research_continue: 7_200_000,
        research_stop: 7_200_000,
        research_watch: 7_200_000,
        research_intelligence: 7_200_000,
        ad_hoc_export: 7_200_000,
        ...overrides.executionDeadlineMsByType,
      },
    },
    exporter: overrides.exporter,
  });
  t.after(async () => {
    await coordinator.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    timers,
    store,
    worker,
    counters,
    coordinator,
    setCatalog(value) { catalog = value; },
  };
}

function request(overrides = {}) {
  return {
    requestId: 'req-1',
    operationType: 'query',
    parameters: { query: 'canary' },
    ...overrides,
  };
}

async function waitForState(fixture, operationId, expected) {
  return eventually(async () => {
    const record = await fixture.store.get(operationId);
    assert.equal(record.state, expected);
    return record;
  }, 10_000);
}

async function directQueuedRecord(fixture, {
  requestId = 'queued-request',
  operationType = 'query',
  target,
  requestParameters = { query: 'canary' },
  parameters,
} = {}) {
  const selected = target || {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot: '/brains/jerry',
    accessMode: 'own',
    ownerAgent: 'jerry',
    displayName: 'jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'a'.repeat(64),
    route: '/api/brain/brain-jerry',
    mutationBoundaries: mutationBoundaries('/brains/jerry'),
  };
  return fixture.store.create({
    requestId,
    requesterAgent: 'jerry',
    target: selected,
    operationType,
    requestParameters,
    parameters: parameters || {
      ...requestParameters,
      operationControl: { hardDeadlineAt: new Date(fixture.timers.now + 7_200_000).toISOString() },
    },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: true,
  });
}

test('default execution deadlines preserve two-hour ordinary and 24-hour PGS server bounds', () => {
  assert.equal(DEFAULT_EXECUTION_DEADLINES_MS.query, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULT_EXECUTION_DEADLINES_MS.research_compile, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULT_EXECUTION_DEADLINES_MS.research_stop, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULT_EXECUTION_DEADLINES_MS.pgs, 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_EXECUTION_DEADLINES_MS.synthesis, 8 * 60 * 60 * 1000);
  assert.equal(DEFAULT_STOP_TIMEOUT_MS, 180_000);
});

test('resolveTargetContext is fresh, deeply frozen, exact, and side-effect free', async (t) => {
  const fixture = makeFixture(t);
  const own = await fixture.coordinator.resolveTargetContext({});
  const sibling = await fixture.coordinator.resolveTargetContext({ agent: 'forrest' });

  assert.equal(fixture.counters.catalog, 2);
  assert.deepEqual(Object.keys(own).sort(), ['accessMode', 'catalogRevision', 'target']);
  assert.equal(own.accessMode, 'own');
  assert.equal(sibling.accessMode, 'read-only');
  assert.equal(sibling.target.id, 'brain-forrest');
  assert.equal(sibling.target.mutationBoundaries.length, 7);
  assert.equal(Object.isFrozen(sibling), true);
  assert.equal(Object.isFrozen(sibling.target), true);
  assert.equal(Object.isFrozen(sibling.target.mutationBoundaries), true);
  assert.deepEqual(await fixture.store.list(), []);
  assert.equal(fixture.counters.authority, 0);
  assert.equal(fixture.counters.model, 0);
  assert.equal(fixture.counters.pin, 0);
  assert.equal(fixture.counters.capabilities.length, 0);
  assert.equal(fixture.worker.startCalls.length, 0);

  await assert.rejects(
    () => fixture.coordinator.resolveTargetContext({ agent: 'missing' }),
    typedCode('target_not_found'),
  );
  await assert.rejects(
    () => fixture.coordinator.resolveTargetContext({ requesterAgent: 'forrest' }),
    typedCode('invalid_request'),
  );
});

test('start normalizes query enablePGS to durable pgs and rejects caller authority/control fields', async (t) => {
  const fixture = makeFixture(t);
  const started = await fixture.coordinator.start(request({
    parameters: { query: 'canary', enablePGS: true },
  }));
  assert.equal(started.operationType, 'pgs');
  assert.deepEqual(started.requestParameters, { query: 'canary' });
  assert.deepEqual(started.parameters.pgsSweep, { provider: 'fake', model: 'sweep-model' });
  assert.deepEqual(started.parameters.pgsSynth, { provider: 'fake', model: 'synth-model' });
  assert.equal(typeof started.parameters.operationControl.hardDeadlineAt, 'string');
  assert.equal(Object.hasOwn(fixture.worker.startCalls[0].context.parameters, 'operationControl'), false);

  for (const parameters of [
    { query: 'x', operationControl: { hardDeadlineAt: '2099-01-01T00:00:00.000Z' } },
    { query: 'x', canonicalRoot: '/brains/forrest' },
    { query: 'x', sourcePinDigest: 'sha256:' + 'a'.repeat(64) },
    { query: 'x', requesterAgent: 'forrest' },
    { query: 'x', writeScope: 'target' },
  ]) {
    await assert.rejects(
      () => fixture.coordinator.start(request({
        requestId: `bad-${Object.keys(parameters).at(-1)}`,
        parameters,
      })),
      typedCode('invalid_request'),
    );
  }
});

test('PGS continuation resolves only a same-target prior session into trusted worker parameters', async (t) => {
  const fixture = makeFixture(t);
  const fresh = await fixture.coordinator.start(request({
    requestId: 'pgs-session-fresh',
    operationType: 'pgs',
    parameters: {
      query: 'durable canary', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsConfig: { sweepFraction: 0.25 },
    },
  }));
  assert.equal(fixture.counters.pin, 1);
  const freshSourceDescriptor = structuredClone(fresh.sourcePinDescriptor);
  const freshSourceDigest = fresh.sourcePinDigest;
  fixture.worker.finish(fresh.operationId, {
    state: 'partial',
    result: {
      answer: 'sample synthesis',
      metadata: { pgs: {
        sessionId: `pgss_${'s'.repeat(32)}`,
        continuableUntil: '2026-07-19T12:00:00.000Z',
        canContinue: true,
      } },
    },
    error: { code: 'pgs_scope_incomplete', message: 'sample complete', retryable: true },
    sourceEvidence: null,
  });
  await waitForState(fixture, fresh.operationId, 'partial');

  const continued = await fixture.coordinator.start(request({
    requestId: 'pgs-session-continue',
    operationType: 'pgs',
    parameters: {
      query: 'durable canary', pgsMode: 'continue', pgsLevel: 'deep',
      pgsConfig: { sweepFraction: 0.5 },
      continueFromOperationId: fresh.operationId,
    },
  }));
  assert.equal(fixture.counters.pin, 1);
  assert.deepEqual(continued.sourcePinDescriptor, freshSourceDescriptor);
  assert.equal(continued.sourcePinDigest, freshSourceDigest);
  assert.equal(continued.parameters.pgsSessionId, `pgss_${'s'.repeat(32)}`);
  assert.deepEqual(
    fixture.worker.startCalls.at(-1).context.sourcePinDescriptor,
    freshSourceDescriptor,
  );
  assert.equal(
    fixture.worker.startCalls.at(-1).context.sourcePinDigest,
    freshSourceDigest,
  );
  assert.equal(
    fixture.worker.startCalls.at(-1).context.parameters.pgsSessionId,
    `pgss_${'s'.repeat(32)}`,
  );

  fixture.worker.finish(continued.operationId, {
    state: 'partial',
    result: {
      answer: 'deeper synthesis',
      metadata: { pgs: {
        sessionId: `pgss_${'s'.repeat(32)}`,
        continuableUntil: '2026-07-19T12:00:00.000Z',
        sourceOperationId: fresh.operationId,
        canContinue: true,
      } },
    },
    error: { code: 'pgs_scope_incomplete', message: 'deep complete', retryable: true },
    sourceEvidence: null,
  });
  await waitForState(fixture, continued.operationId, 'partial');
  const continuedAgain = await fixture.coordinator.start(request({
    requestId: 'pgs-session-continue-again',
    operationType: 'pgs',
    parameters: {
      query: 'durable canary', pgsMode: 'continue', pgsLevel: 'full',
      pgsConfig: { sweepFraction: 1 },
      continueFromOperationId: continued.operationId,
    },
  }));
  assert.equal(fixture.counters.pin, 1);
  assert.deepEqual(continuedAgain.sourcePinDescriptor, freshSourceDescriptor);
  assert.equal(continuedAgain.sourcePinDigest, freshSourceDigest);

  await assert.rejects(
    fixture.coordinator.start(request({
      requestId: 'pgs-session-wrong-target',
      operationType: 'pgs',
      target: { agent: 'forrest' },
      parameters: {
        query: 'durable canary', pgsMode: 'continue', pgsLevel: 'deep',
        pgsConfig: { sweepFraction: 0.5 },
        continueFromOperationId: fresh.operationId,
      },
    })),
    typedCode('session_target_mismatch'),
  );
});

test('cancelled, interrupted, and failed null-result PGS operations retain durable session lineage for continuation', async (t) => {
  const fixture = makeFixture(t);
  const continuableUntil = '2026-07-19T12:00:00.000Z';
  const sessions = [
    `pgss_${'c'.repeat(32)}`,
    `pgss_${'i'.repeat(32)}`,
    `pgss_${'f'.repeat(32)}`,
  ];
  let sessionIndex = 0;
  fixture.worker.pgsSessionForStarts = (context) => ({
    sessionId: context.parameters.pgsSessionId || sessions[sessionIndex++],
    continuableUntil,
    sourceOperationId: context.parameters.continueFromOperationId || null,
  });

  for (const [index, terminal] of ['cancelled', 'interrupted', 'failed'].entries()) {
    const fresh = await fixture.coordinator.start(request({
      requestId: `pgs-null-result-${terminal}`,
      operationType: 'pgs',
      parameters: {
        query: `durable ${terminal} canary`, pgsMode: 'fresh', pgsLevel: 'sample',
        pgsConfig: { sweepFraction: 0.25 },
      },
    }));
    assert.deepEqual(fresh.pgsSession, {
      sessionId: sessions[index], continuableUntil, sourceOperationId: null,
    });
    fixture.worker.finish(fresh.operationId, {
      state: terminal,
      result: null,
      error: terminal === 'failed'
        ? { code: 'provider_failed', message: 'provider failed after committed sweeps', retryable: true }
        : null,
      sourceEvidence: null,
    });
    const terminalRecord = await waitForState(fixture, fresh.operationId, terminal);
    assert.equal(terminalRecord.result, null);
    assert.deepEqual(terminalRecord.pgsSession, {
      sessionId: sessions[index], continuableUntil, sourceOperationId: null,
    });

    const continued = await fixture.coordinator.start(request({
      requestId: `pgs-null-result-${terminal}-continue`,
      operationType: 'pgs',
      parameters: {
        query: `durable ${terminal} canary`, pgsMode: 'continue', pgsLevel: 'deep',
        pgsConfig: { sweepFraction: 0.5 },
        continueFromOperationId: fresh.operationId,
      },
    }));
    assert.equal(continued.parameters.pgsSessionId, sessions[index]);
  }
});

test('PGS continuation fails closed for expired or answer-mismatched durable session lineage', async (t) => {
  const fixture = makeFixture(t);
  fixture.worker.pgsSessionForStarts = () => ({
    sessionId: `pgss_${'e'.repeat(32)}`,
    continuableUntil: '2026-07-19T12:00:00.000Z',
    sourceOperationId: null,
  });
  const fresh = await fixture.coordinator.start(request({
    requestId: 'pgs-lineage-mismatch-fresh',
    operationType: 'pgs',
    parameters: {
      query: 'lineage canary', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsConfig: { sweepFraction: 0.25 },
    },
  }));
  fixture.worker.finish(fresh.operationId, {
    state: 'partial',
    result: {
      answer: 'partial',
      metadata: { pgs: {
        sessionId: `pgss_${'x'.repeat(32)}`,
        continuableUntil: '2026-07-19T12:00:00.000Z',
        canContinue: true,
      } },
    },
    error: { code: 'pgs_scope_incomplete', message: 'partial', retryable: true },
    sourceEvidence: null,
  });
  await waitForState(fixture, fresh.operationId, 'partial');
  await assert.rejects(
    fixture.coordinator.start(request({
      requestId: 'pgs-lineage-mismatch-continue',
      operationType: 'pgs',
      parameters: {
        query: 'lineage canary', pgsMode: 'continue', pgsLevel: 'deep',
        pgsConfig: { sweepFraction: 0.5 }, continueFromOperationId: fresh.operationId,
      },
    })),
    typedCode('session_lineage_mismatch'),
  );

  const expiredFresh = await fixture.coordinator.start(request({
    requestId: 'pgs-lineage-expired-fresh',
    operationType: 'pgs',
    parameters: {
      query: 'expired lineage canary', pgsMode: 'fresh', pgsLevel: 'sample',
      pgsConfig: { sweepFraction: 0.25 },
    },
  }));
  fixture.worker.finish(expiredFresh.operationId, {
    state: 'partial',
    result: {
      answer: 'partial',
      metadata: { pgs: {
        sessionId: `pgss_${'e'.repeat(32)}`,
        continuableUntil: '2026-07-19T12:00:00.000Z',
        canContinue: true,
      } },
    },
    error: { code: 'pgs_scope_incomplete', message: 'partial', retryable: true },
    sourceEvidence: null,
  });
  await waitForState(fixture, expiredFresh.operationId, 'partial');
  fixture.timers.now = Date.parse('2026-07-20T00:00:00.000Z');
  await assert.rejects(
    fixture.coordinator.start(request({
      requestId: 'pgs-lineage-expired-continue',
      operationType: 'pgs',
      parameters: {
        query: 'expired lineage canary', pgsMode: 'continue', pgsLevel: 'deep',
        pgsConfig: { sweepFraction: 0.5 }, continueFromOperationId: expiredFresh.operationId,
      },
    })),
    typedCode('session_not_continuable'),
  );
});

test('thirty-two concurrent starts create, pin, issue, and start exactly once', async (t) => {
  const fixture = makeFixture(t);
  const results = await Promise.all(Array.from({ length: 32 }, () =>
    fixture.coordinator.start(request())));
  assert.equal(new Set(results.map(({ operationId }) => operationId)).size, 1);
  assert.equal(fixture.counters.pin, 1);
  assert.equal(fixture.worker.startCalls.length, 1);
  assert.equal(fixture.counters.capabilities.filter(({ purpose }) => purpose === 'start').length, 1);
  assert.equal((await fixture.store.list()).length, 1);
});

test('slow pin publication stays serialized while queued cancellation prevents worker dispatch', async (t) => {
  const pinEntered = deferred();
  const pinGate = deferred();
  const sourcePins = {
    async pin(canonicalRoot) {
      pinEntered.resolve();
      await pinGate.promise;
      const descriptor = validDescriptor(canonicalRoot);
      return { descriptor, digest: descriptorDigest(descriptor) };
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {},
  };
  const fixture = makeFixture(t, { sourcePins });
  const starting = fixture.coordinator.start(request({ requestId: 'slow-pin-cas' }));
  await pinEntered.promise;
  const heartbeat = fixture.timers.advance(10_000);
  await flush();
  const queued = (await fixture.store.listNonterminal())[0];
  const cancelling = fixture.coordinator.cancel(queued.operationId);
  await flush();
  pinGate.resolve();
  const [operation, , cancelled] = await Promise.all([starting, heartbeat, cancelling]);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await fixture.store.get(operation.operationId)).state, 'cancelled');
  assert.equal(fixture.worker.startCalls.length, 0);
  assert.equal((await fixture.store.readEvents(operation.operationId, 0))
    .some(({ type }) => type === 'heartbeat'), true);
});

test('queued cancellation aborts a trusted long source-pin wait without worker dispatch', async (t) => {
  const pinEntered = deferred();
  let pinControl = null;
  const sourcePins = {
    async pin(_canonicalRoot, _operationId, capability) {
      pinControl = readDurableOperationLockCapability(capability);
      pinEntered.resolve();
      await new Promise((resolve, reject) => {
        if (pinControl.signal.aborted) reject(pinControl.signal.reason);
        else pinControl.signal.addEventListener('abort', () => reject(pinControl.signal.reason), {
          once: true,
        });
      });
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {},
  };
  const fixture = makeFixture(t, { sourcePins });
  const starting = fixture.coordinator.start(request({ requestId: 'cancel-long-pin-wait' }));
  await pinEntered.promise;
  const queued = (await fixture.store.listNonterminal())[0];
  const cancelled = await fixture.coordinator.cancel(queued.operationId);
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(starting, typedCode('operation_cancelled'));
  assert.equal(pinControl.signal.aborted, true);
  assert.equal(pinControl.cleanupSignal, null);
  assert.equal(fixture.worker.startCalls.length, 0);
});

test('hard execution deadline aborts a trusted long source-pin wait', async (t) => {
  const pinEntered = deferred();
  let pinControl = null;
  const sourcePins = {
    async pin(_canonicalRoot, _operationId, capability) {
      pinControl = readDurableOperationLockCapability(capability);
      pinEntered.resolve();
      await new Promise((resolve, reject) => {
        if (pinControl.signal.aborted) reject(pinControl.signal.reason);
        else pinControl.signal.addEventListener('abort', () => reject(pinControl.signal.reason), {
          once: true,
        });
      });
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {},
  };
  const fixture = makeFixture(t, {
    sourcePins,
    executionDeadlineMsByType: { query: 100 },
  });
  const starting = fixture.coordinator.start(request({ requestId: 'deadline-long-pin-wait' }));
  await pinEntered.promise;
  const queued = (await fixture.store.listNonterminal())[0];
  await fixture.timers.advance(100);
  await assert.rejects(starting, typedCode('operation_timeout'));
  const failed = await waitForState(fixture, queued.operationId, 'failed');
  assert.equal(failed.error.code, 'operation_timeout');
  assert.equal(pinControl.signal.aborted, true);
  assert.equal(pinControl.cleanupSignal, null);
  assert.equal(fixture.worker.startCalls.length, 0);
});

test('slow source pin leaves queued status attachments and heartbeats available', async (t) => {
  const pinEntered = deferred();
  const pinGate = deferred();
  const sourcePins = {
    async pin(canonicalRoot) {
      pinEntered.resolve();
      await pinGate.promise;
      const descriptor = validDescriptor(canonicalRoot);
      return { descriptor, digest: descriptorDigest(descriptor) };
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {},
  };
  const fixture = makeFixture(t, { sourcePins });
  const starting = fixture.coordinator.start(request({ requestId: 'slow-pin-readable' }));
  await pinEntered.promise;
  const queued = (await fixture.store.listNonterminal())[0];
  assert.ok(queued);

  let statusSettled = false;
  let attachmentSettled = false;
  const status = fixture.coordinator.status(queued.operationId).then((value) => {
    statusSettled = true;
    return value;
  });
  const attachment = fixture.coordinator.attach(queued.operationId, {
    attachmentId: 'slow-pin-reader',
    afterSequence: queued.eventSequence,
  }).then((value) => {
    attachmentSettled = true;
    return value;
  });
  const heartbeat = fixture.timers.advance(10_000);
  let readinessDeadline;

  try {
    const [statusValue, attachmentValue] = await Promise.race([
      Promise.all([status, attachment, heartbeat]).then(([statusResult, attachmentResult]) =>
        [statusResult, attachmentResult]),
      new Promise((resolve, reject) => {
        readinessDeadline = setTimeout(() => reject(new Error(
          'queued status, attachment, and heartbeat did not become ready within 10 seconds',
        )), 10_000);
      }),
    ]);
    assert.equal(statusSettled, true, 'queued status must not wait for source projection');
    assert.equal(attachmentSettled, true, 'SSE attachment setup must not wait for source projection');
    assert.equal((await fixture.store.readEvents(queued.operationId, 0))
      .some(({ type }) => type === 'heartbeat'), true,
      'queued heartbeat must not wait for source projection');
    assert.equal(statusValue.state, 'queued');
    const event = await attachmentValue.nextEvent();
    assert.equal(event.type, 'heartbeat');
    assert.equal(event.state, 'queued');
  } finally {
    if (readinessDeadline) clearTimeout(readinessDeadline);
    pinGate.resolve();
    await Promise.allSettled([starting, status, attachment, heartbeat]);
  }
});

test('coordinator stop during slow pin leaves queued recovery truth without dispatching a worker', async (t) => {
  const pinEntered = deferred();
  const pinGate = deferred();
  const sourcePins = {
    async pin(canonicalRoot) {
      pinEntered.resolve();
      await pinGate.promise;
      const descriptor = validDescriptor(canonicalRoot);
      return { descriptor, digest: descriptorDigest(descriptor) };
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {},
  };
  const fixture = makeFixture(t, { sourcePins });
  const starting = fixture.coordinator.start(request({ requestId: 'slow-pin-stop-recovery' }));
  await pinEntered.promise;
  await fixture.coordinator.stop();
  pinGate.resolve();

  const operation = await starting;
  assert.equal(operation.state, 'queued');
  assert.equal(operation.sourcePinDigest, descriptorDigest(validDescriptor(operation.target.canonicalRoot)));
  assert.equal(fixture.worker.startCalls.length, 0);
});

test('lost worker-start response proves and publishes the live worker instead of releasing its pin', async (t) => {
  class LostStartResponseWorker extends ControlledWorker {
    async start(context, capability) {
      await super.start(context, capability);
      const error = new Error('worker start response was lost');
      error.code = 'worker_start_uncertain';
      throw error;
    }
  }
  const worker = new LostStartResponseWorker();
  const fixture = makeFixture(t, { worker });
  const operation = await fixture.coordinator.start(request({ requestId: 'lost-worker-start' }));
  const current = await fixture.store.get(operation.operationId);
  assert.equal(current.state, 'running');
  assert.deepEqual(await fixture.store.getWorker(operation.operationId),
    worker.records.get(operation.operationId).reference);
  assert.equal(worker.startCalls.length, 1);
  assert.equal(worker.statusCalls.length >= 1, true);
  assert.equal(fixture.counters.releaseCalls, 0);
});

test('timed-out uncertain worker startup sends cancellation even before a worker reference is published', async (t) => {
  class PendingStartWorker extends ControlledWorker {
    constructor() {
      super();
      this.startGate = deferred();
    }

    async start(context, capability) {
      this.startCalls.push({ context, capability });
      return this.startGate.promise;
    }

    async status(operationId, capability) {
      this.statusCalls.push({ operationId, capability });
      const error = new Error('worker_not_found');
      error.code = 'worker_not_found';
      throw error;
    }

    async cancel(operationId, capability) {
      this.cancelCalls.push({ operationId, capability });
      this.startGate.resolve({});
      return {};
    }
  }

  const worker = new PendingStartWorker();
  const fixture = makeFixture(t, {
    worker,
    workerStartTimeoutMs: 100,
    workerControlTimeoutMs: 100,
  });
  const starting = fixture.coordinator.start(request({ requestId: 'pending-start-timeout' }));
  await eventually(() => assert.equal(worker.startCalls.length, 1), 10_000);
  await fixture.timers.advance(100);
  await assert.rejects(starting, typedCode('worker_control_timeout'));
  await eventually(() => assert.equal(worker.cancelCalls.length, 1));
  const failed = (await fixture.store.list())[0];
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'worker_control_timeout');
});

test('lost start response retry matches persisted selectors before catalog/model drift', async (t) => {
  const fixture = makeFixture(t);
  const original = await fixture.coordinator.start(request({ target: { agent: 'forrest' } }));
  await eventually(async () => assert.equal(fixture.worker.eventsCalls.length, 1));
  const baseline = {
    catalog: fixture.counters.catalog,
    model: fixture.counters.model,
    pin: fixture.counters.pin,
    capabilities: fixture.counters.capabilities.length,
    starts: fixture.worker.startCalls.length,
  };
  const unavailable = new Error('catalog_unavailable');
  unavailable.code = 'catalog_unavailable';
  fixture.setCatalog(unavailable);

  for (const target of [
    { agent: 'forrest' },
    { brainId: original.target.brainId },
    { agent: 'forrest', brainId: original.target.brainId },
  ]) {
    const retry = await fixture.coordinator.start(request({ target }));
    assert.equal(retry.operationId, original.operationId);
  }
  assert.deepEqual({
    catalog: fixture.counters.catalog,
    model: fixture.counters.model,
    pin: fixture.counters.pin,
    capabilities: fixture.counters.capabilities.length,
    starts: fixture.worker.startCalls.length,
  }, baseline);

  for (const changed of [
    request({ target: { agent: 'jerry' } }),
    request({ target: { agent: 'forrest', brainId: 'brain-jerry' } }),
    request({ target: { brainId: 'brain-does-not-exist' } }),
    request({ parameters: { query: 'different' }, target: { agent: 'forrest' } }),
  ]) {
    await assert.rejects(() => fixture.coordinator.start(changed), typedCode('idempotency_conflict'));
  }
});

test('requester and owned-run domains use trusted targets without brain-catalog substitution', async (t) => {
  const fixture = makeFixture(t);
  const launch = await fixture.coordinator.start(request({
    requestId: 'launch-1',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  assert.deepEqual(launch.target, { domain: 'requester', requesterAgent: 'jerry' });

  const watch = await fixture.coordinator.start(request({
    requestId: 'watch-1',
    operationType: 'research_watch',
    target: { runId: 'run-1' },
    parameters: {},
  }));
  assert.equal(watch.target.domain, 'owned-run');
  assert.equal(watch.target.runId, 'run-1');
  assert.equal(watch.target.ownerAgent, 'jerry');
  assert.equal(watch.sourcePinDescriptor, null);
  assert.equal(watch.sourcePinDigest, null);
});

test('source-required production work fails closed without complete source, quota, model, and worker seams', async (t) => {
  const fixture = makeFixture(t, {
    sourcePins: null,
    scratchQuotaFactory: null,
    operationModelResolver: null,
  });
  await assert.rejects(
    () => fixture.coordinator.start(request()),
    typedCode('source_operations_unavailable'),
  );
  assert.deepEqual(await fixture.store.list(), []);
  assert.equal(fixture.worker.startCalls.length, 0);
});

test('source readiness requires exact worker support for the requested operation type', async (t) => {
  const worker = new BrainOperationWorkerAdapter({ supportsSourceOperations: true });
  t.after(() => worker.stop());
  const fixture = makeFixture(t, { worker });
  await assert.rejects(
    () => fixture.coordinator.start(request({ requestId: 'global-source-flag' })),
    typedCode('source_operations_unavailable'),
  );
  assert.deepEqual(await fixture.store.list(), []);
  assert.equal(fixture.counters.pin, 0);
});

test('non-source local operation accepts a deliberately null scratch quota seam', async (t) => {
  const fixture = makeFixture(t, {
    sourcePins: null,
    scratchQuotaFactory: null,
    operationModelResolver: null,
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'non-source-null-quota',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  assert.equal(operation.state, 'running');
  assert.equal(fixture.worker.startCalls[0].context.scratchQuota, null);
  assert.equal(fixture.worker.startCalls[0].context.sourcePin, null);
});

test('non-provider source reads require source and quota seams but not a model resolver', async (t) => {
  const fixture = makeFixture(t, { operationModelResolver: null });
  const operation = await fixture.coordinator.start(request({
    requestId: 'search-without-model-resolver',
    operationType: 'search',
    parameters: { query: 'canary' },
  }));
  assert.equal(operation.state, 'running');
  assert.equal(fixture.counters.pin, 1);
  assert.equal(fixture.counters.quota, 1);
  assert.equal(fixture.counters.model, 0);

  await assert.rejects(
    () => fixture.coordinator.start(request({ requestId: 'query-still-needs-model' })),
    typedCode('source_operations_unavailable'),
  );
});

test('source worker context rejects null products and closes quota when pinned-source opening fails', async (t) => {
  const nullQuota = makeFixture(t, { scratchQuotaFactory: async () => null });
  await assert.rejects(
    () => nullQuota.coordinator.start(request({ requestId: 'null-quota-product' })),
    typedCode('source_context_invalid'),
  );
  assert.equal(nullQuota.worker.startCalls.length, 0);

  for (const mode of ['null', 'throw']) {
    let quotaCloses = 0;
    const sourcePins = {
      async pin(canonicalRoot) {
        const descriptor = validDescriptor(canonicalRoot);
        return { descriptor, digest: descriptorDigest(descriptor) };
      },
      async openPinnedSource() {
        if (mode === 'throw') {
          const error = new Error('open failed');
          error.code = 'source_open_failed';
          throw error;
        }
        return null;
      },
      async releaseOperationPins() {},
    };
    const fixture = makeFixture(t, {
      sourcePins,
      scratchQuotaFactory: async () => ({
        async claim() {}, async release() {}, async reconcile() { return {}; },
        async assertOperationRoot() { return true; },
        async close() { quotaCloses += 1; },
      }),
    });
    await assert.rejects(
      () => fixture.coordinator.start(request({ requestId: `source-open-${mode}` })),
      mode === 'null' ? typedCode('source_context_invalid') : typedCode('source_open_failed'),
    );
    assert.equal(fixture.worker.startCalls.length, 0, mode);
    assert.equal(quotaCloses, 1, mode);
  }
});

test('detaching one durable attachment never changes execution or another attachment', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request());
  const a = await fixture.coordinator.attach(operation.operationId, { attachmentId: 'a' });
  const b = await fixture.coordinator.attach(operation.operationId, { attachmentId: 'b' });
  await fixture.coordinator.detach(operation.operationId, {
    attachmentId: 'a', reason: 'wait_deadline',
  });
  await a.done;
  assert.equal((await fixture.coordinator.status(operation.operationId)).state, 'running');
  fixture.worker.emit(operation.operationId, { type: 'progress', eventSequence: 1, completed: 1 });
  fixture.worker.emit(operation.operationId, { type: 'progress', eventSequence: 2, completed: 2 });
  assert.equal((await b.nextEvent()).eventSequence, 1);
  assert.equal((await b.nextEvent()).eventSequence, 2);
  assert.equal((await fixture.store.getAttachment(operation.operationId, 'a')).state, 'detached');
  assert.equal((await fixture.store.getAttachment(operation.operationId, 'b')).state, 'attached');
});

test('terminal state is broadcast to a surviving attachment before durable closure', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'terminal-before-attachment-close',
  }));
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'surviving-terminal-attachment',
    afterSequence: operation.eventSequence,
  });
  const terminalEvent = attachment.nextEvent();

  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'terminal attachment result' },
    error: null,
    sourceEvidence: null,
  });

  const event = await terminalEvent;
  assert.equal(event.state, 'complete');
  assert.equal((await fixture.coordinator.status(operation.operationId)).state, 'complete');
  await attachment.done;
  const closed = await fixture.store.getAttachment(
    operation.operationId,
    'surviving-terminal-attachment',
  );
  assert.equal(closed.state, 'closed');
  assert.equal(closed.reason, 'operation_terminal');
});

test('graceful stop waits for terminal source-pin release before dropping runtime tracking', async (t) => {
  const releaseEntered = deferred();
  const releaseGate = deferred();
  const sourcePins = {
    async pin(canonicalRoot) {
      const descriptor = validDescriptor(canonicalRoot);
      return { descriptor, digest: descriptorDigest(descriptor) };
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {
      releaseEntered.resolve();
      await releaseGate.promise;
    },
  };
  const fixture = makeFixture(t, { sourcePins });
  const operation = await fixture.coordinator.start(request({
    requestId: 'stop-waits-for-source-pin-release',
  }));
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'terminal-release-observer',
    afterSequence: operation.eventSequence,
  });
  const terminalEvent = attachment.nextEvent();

  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'release before shutdown' },
    error: null,
    sourceEvidence: null,
  });
  assert.equal((await terminalEvent).state, 'complete');
  await releaseEntered.promise;

  let stopResolved = false;
  const stopping = fixture.coordinator.stop().then(() => { stopResolved = true; });
  await flush();
  assert.equal(stopResolved, false);
  releaseGate.resolve();
  await stopping;

  const terminal = await fixture.store.get(operation.operationId);
  assert.equal(terminal.state, 'complete');
  assert.match(terminal.sourcePinReleasedAt, /^2026-07-10T/);
});

test('graceful stop fails visibly when source-pin release exceeds its shutdown budget', async (t) => {
  const releaseEntered = deferred();
  const releaseGate = deferred();
  t.after(() => releaseGate.resolve());
  const sourcePins = {
    async pin(canonicalRoot) {
      const descriptor = validDescriptor(canonicalRoot);
      return { descriptor, digest: descriptorDigest(descriptor) };
    },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins() {
      releaseEntered.resolve();
      await releaseGate.promise;
    },
  };
  const fixture = makeFixture(t, { sourcePins, stopTimeoutMs: 20 });
  const operation = await fixture.coordinator.start(request({
    requestId: 'stop-reports-source-pin-release-timeout',
  }));
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'release remains pending' },
    error: null,
    sourceEvidence: null,
  });
  await releaseEntered.promise;

  await assert.rejects(
    fixture.coordinator.stop(),
    typedCode('coordinator_stop_timeout'),
  );
  await assert.rejects(
    fixture.coordinator.stop(),
    typedCode('coordinator_stop_timeout'),
  );

  releaseGate.resolve();
  await eventually(async () => {
    const terminal = await fixture.store.get(operation.operationId);
    assert.match(terminal.sourcePinReleasedAt, /^2026-07-10T/);
  });
});

test('terminal closure drains durable provider evidence for a slow pull attachment', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'terminal-drains-provider-evidence',
  }));
  await waitForState(fixture, operation.operationId, 'running');
  const running = await fixture.store.get(operation.operationId);
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'slow-terminal-evidence',
    afterSequence: running.eventSequence,
  });
  const slowSubscriber = fixture.coordinator.runtimes
    .get(operation.operationId).attachments.get('slow-terminal-evidence');
  const selectedPending = attachment.nextEvent();
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected',
    providerCallId: 'query',
    providerStallMs: 5_000,
  });
  const selected = await selectedPending;
  assert.equal(selected.type, 'provider_selected');
  assert.equal(slowSubscriber.queue.length, 0);
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity',
    providerCallId: 'query',
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_call_terminal',
    providerCallId: 'query',
  });
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'terminal evidence result' },
    error: null,
    sourceEvidence: null,
  });
  await waitForState(fixture, operation.operationId, 'complete');
  await attachment.done;
  assert.deepEqual(
    slowSubscriber.queue.map((event) => event.type),
    ['provider_activity'],
  );

  const events = [selected];
  for (;;) {
    const event = await attachment.nextEvent();
    if (event === null) break;
    events.push(event);
  }
  assert.deepEqual(events.filter(event => event.type.startsWith('provider_')).map(event => event.type), [
    'provider_selected', 'provider_activity', 'provider_call_terminal',
  ]);
  assert.equal(events.at(-1).type, 'state');
  assert.equal(events.at(-1).state, 'complete');
});

test('shared terminal replay clips a compacted gap to each attachment cursor', async () => {
  const operationId = `brop_${'g'.repeat(32)}`;
  const rows = [
    {
      type: 'event_gap', operationId, oldestSequence: 2, latestSequence: 4,
    },
    {
      type: 'phase', operationId, sequence: 5, phase: 'retained-terminal-evidence',
    },
  ];
  const subscriber = (cursor) => ({ cursor, onEvent: null, waiting: [], queue: [] });
  const lagging = subscriber(1);
  const advanced = subscriber(2);
  const coordinator = Object.create(BrainOperationCoordinator.prototype);
  coordinator.store = {
    async readEvents(actualOperationId, afterSequence) {
      assert.equal(actualOperationId, operationId);
      assert.equal(afterSequence, 1);
      return rows;
    },
  };
  const runtime = {
    operationId,
    attachments: new Map([
      ['lagging', lagging],
      ['advanced', advanced],
    ]),
  };

  // Terminal closure reads once from the oldest cursor, then shares those rows
  // with every attachment. Each requester must see only its own unseen suffix.
  await coordinator._broadcastNewEvents(runtime, 1);
  assert.deepEqual(lagging.queue, [{
    ...rows[0], eventSequence: 4,
  }]);
  assert.deepEqual(advanced.queue, [{
    ...rows[0], oldestSequence: 3, eventSequence: 4,
  }]);

  lagging.queue.shift();
  advanced.queue.shift();
  coordinator._deliverRowsToSubscriber(lagging, rows);
  coordinator._deliverRowsToSubscriber(advanced, rows);
  assert.deepEqual(lagging.queue, [{ ...rows[1], eventSequence: 5 }]);
  assert.deepEqual(advanced.queue, [{ ...rows[1], eventSequence: 5 }]);
  assert.equal(lagging.cursor, 5);
  assert.equal(advanced.cursor, 5);
});

test('late terminal attachment replays the retained journal read-only and closes cleanly', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'late-terminal-journal-replay',
  }));
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected',
    providerCallId: 'query',
    providerStallMs: 5_000,
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity',
    providerCallId: 'query',
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_call_terminal',
    providerCallId: 'query',
  });
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'late replay result' },
    error: null,
    sourceEvidence: null,
  });
  await waitForState(fixture, operation.operationId, 'complete');
  await eventually(async () => {
    assert.match((await fixture.store.get(operation.operationId)).sourcePinReleasedAt,
      /^\d{4}-\d{2}-\d{2}T/);
  });
  const before = await fixture.store.get(operation.operationId);

  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'late-terminal-replay',
    afterSequence: 0,
  });
  const events = [];
  for (;;) {
    const event = await attachment.nextEvent();
    if (event === null) break;
    events.push(event);
  }
  const closed = await attachment.done;

  assert.equal(events.some((event) => event.type === 'provider_call_terminal'
    && event.providerCallId === 'query'), true);
  assert.equal(events.at(-1).type, 'state');
  assert.equal(events.at(-1).state, 'complete');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.reason, 'operation_terminal');
  const after = await fixture.store.get(operation.operationId);
  assert.equal(after.recordVersion, before.recordVersion);
  assert.equal(after.eventSequence, before.eventSequence);
  await assert.rejects(
    () => fixture.store.getAttachment(operation.operationId, 'late-terminal-replay'),
    typedCode('attachment_not_found'),
  );
});

test('late terminal attachment crosses compacted gaps and retains provider terminal evidence', async (t) => {
  const fixture = makeFixture(t);
  fixture.store.eventMaxCount = 8;
  fixture.store.eventMaxBytes = 1024 * 1024;
  const operation = await fixture.coordinator.start(request({
    requestId: 'late-terminal-compacted-replay',
  }));
  await waitForState(fixture, operation.operationId, 'running');
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected',
    providerCallId: 'query',
    providerStallMs: 5_000,
  });
  for (let index = 0; index < 24; index += 1) {
    fixture.worker.emit(operation.operationId, {
      type: 'progress',
      completed: index + 1,
    });
  }
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity',
    providerCallId: 'query',
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_call_terminal',
    providerCallId: 'query',
  });
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'compacted replay result' },
    error: null,
    sourceEvidence: null,
  });
  await waitForState(fixture, operation.operationId, 'complete');

  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'late-compacted-terminal-replay',
    afterSequence: 0,
  });
  const events = [];
  for (;;) {
    const event = await attachment.nextEvent();
    if (event === null) break;
    events.push(event);
  }
  await attachment.done;

  assert.equal(events.some((event) => event.type === 'event_gap'), true);
  assert.equal(events.some((event) => event.type === 'provider_call_terminal'
    && event.providerCallId === 'query'), true);
  assert.equal(events.at(-1).type, 'state');
  assert.equal(events.at(-1).state, 'complete');
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].eventSequence > events[index - 1].eventSequence, true);
  }
});

test('authenticated Query progress survives terminal finalization as lastProgressAt', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'query-progress-terminal-roundtrip',
  }));
  fixture.worker.emit(operation.operationId, {
    type: 'progress', phase: 'query', stage: 'projection_complete',
    selectedNodes: 12, selectedEdges: 10,
  });
  await eventually(async () => {
    assert.match((await fixture.coordinator.status(operation.operationId)).lastProgressAt,
      /^\d{4}-\d{2}-\d{2}T/);
  });
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'progress-preserving result' },
    error: null,
    sourceEvidence: null,
  });
  const terminal = await eventually(async () => {
    const current = await fixture.coordinator.status(operation.operationId);
    assert.equal(current.state, 'complete');
    return current;
  });
  assert.match(terminal.lastProgressAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('terminal notification hook cannot delay terminal truth or source-pin release', async (t) => {
  let notified = null;
  const notificationNeverReturns = deferred();
  const fixture = makeFixture(t, {
    onTerminal(record) {
      notified = record;
      return notificationNeverReturns.promise;
    },
  });
  t.after(() => notificationNeverReturns.resolve());
  const operation = await fixture.coordinator.start(request({
    requestId: 'terminal-notification-does-not-block',
  }));
  fixture.worker.finish(operation.operationId, {
    state: 'complete', result: { answer: 'durable first' },
    error: null, sourceEvidence: null,
  });

  await eventually(async () => {
    assert.equal((await fixture.store.get(operation.operationId)).state, 'complete');
    assert.equal(fixture.counters.releaseCalls, 1);
  });
  await flush();
  assert.equal(notified?.operationId, operation.operationId);
});

test('throwing terminal notification hook is isolated from terminal cleanup', async (t) => {
  let calls = 0;
  const fixture = makeFixture(t, {
    onTerminal() {
      calls += 1;
      throw new Error('push unavailable');
    },
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'terminal-notification-throws',
  }));
  fixture.worker.finish(operation.operationId, {
    state: 'partial', result: { answer: 'useful partial' },
    error: null, sourceEvidence: null,
  });
  await eventually(async () => {
    assert.equal((await fixture.store.get(operation.operationId)).state, 'partial');
    assert.equal(fixture.counters.releaseCalls, 1);
    assert.equal(calls, 1);
  });
});

test('Query subscription delivery failure remains durable and retryable with the stable route', async (t) => {
  const { createQueryNotebookSubscriptions } = require(
    '../../../engine/src/dashboard/query-notebook-subscriptions.js'
  );
  const root = fs.mkdtempSync(path.join(tmpdir(), 'home23-query-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'subscriptions.json');
  const createStore = () => createQueryNotebookSubscriptions({
    filePath, requesterAgent: 'jerry', now: () => Date.parse('2026-07-13T20:00:00.000Z'),
  });
  const store = createStore();
  const operationId = `brop_${'n'.repeat(32)}`;
  const subscribed = await store.subscribe({
    requesterAgent: 'jerry', operationId,
    credentialId: 'device-credential', deviceId: 'ios-installation-00000001', generation: 4,
    expiresAt: '2026-07-14T20:00:00.000Z', terminalState: null,
  });
  const [terminal] = await store.markTerminalPending({
    requesterAgent: 'jerry', operationId, terminalState: 'complete',
  });
  assert.equal(terminal.routeId, subscribed.routeId);
  const attempting = await store.markDeliveryPending({ routeId: subscribed.routeId });
  assert.equal(attempting.deliveryState, 'pending');
  assert.equal(attempting.deliveryAttempts, 1);
  const failed = await store.markDeliveryFailed({
    routeId: subscribed.routeId, retryable: true,
  });
  assert.equal(failed.deliveryState, 'failed');
  assert.equal(failed.deliveryRetryable, true);

  const reopened = createStore();
  const persisted = (await reopened.listActive({ operationId }))[0];
  assert.equal(persisted.deliveryState, 'failed');
  assert.equal(persisted.routeId, subscribed.routeId);
  const retrying = await reopened.markDeliveryPending({ routeId: subscribed.routeId });
  assert.equal(retrying.deliveryAttempts, 2);
  const delivered = await reopened.markDelivered({ routeId: subscribed.routeId });
  assert.equal(delivered.deliveryState, 'delivered');
  assert.equal(delivered.deliveryRetryable, false);
});

test('dashboard terminal delivery writes pending before I/O and replays lost responses idempotently', async () => {
  const { createQueryTerminalNotificationDelivery } = require(
    '../../../engine/src/dashboard/server.js'
  );
  assert.equal(typeof createQueryTerminalNotificationDelivery, 'function');
  const operationId = `brop_${'p'.repeat(32)}`;
  const routeId = `qroute_${'r'.repeat(32)}`;
  let entry = {
    requesterAgent: 'jerry', operationId, credentialId: 'credential-1',
    deviceId: 'ios-installation-00000001', generation: 4,
    expiresAt: '2026-07-14T20:00:00.000Z', terminalState: 'complete',
    routeId, deliveryState: 'pending', deliveryAttempts: 0,
    deliveryRetryable: null,
  };
  const order = [];
  const subscriptions = {
    async claimDeliveries({ routeIds }) {
      assert.deepEqual(routeIds, [routeId]);
      order.push('pending');
      entry = { ...entry, deliveryState: 'pending',
        deliveryAttempts: entry.deliveryAttempts + 1, deliveryRetryable: null };
      return [entry];
    },
    async settleDeliveries({ results }) {
      const [result] = results;
      assert.equal(result.routeId, routeId);
      entry = { ...entry, deliveryState: result.state,
        deliveryRetryable: result.retryable ?? false };
      return [entry];
    },
    async markTerminalPending() { return [entry]; },
    async markTerminalPendingBatch() { return []; },
    async listActive() { return [entry]; },
  };
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    order.push('fetch');
    assert.equal(options.headers.authorization, 'Bearer configured-bridge-token');
    bodies.push(JSON.parse(options.body));
    if (calls === 1) throw new Error('response lost after APNs accepted');
    return {
      ok: true,
      async json() {
        return { ok: true, operationId, routeId, generation: 4,
          delivered: [entry.deviceId], failed: [], pending: [] };
      },
    };
  };
  const delivery = createQueryTerminalNotificationDelivery({
    requesterAgent: 'jerry', subscriptions,
    getStatusAuthorized: async () => ({ operationId, executionState: 'complete' }),
    bridgeToken: 'configured-bridge-token', bridgeBaseUrl: 'http://127.0.0.1:5004',
    fetchImpl, timeoutMs: 100,
  });

  const failed = await delivery.enqueue(entry);
  assert.equal(failed.deliveryState, 'failed');
  assert.deepEqual(order.slice(0, 2), ['pending', 'fetch']);
  const delivered = await delivery.replay();
  assert.equal(delivered[0].deliveryState, 'delivered');
  assert.equal(calls, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0], {
    operationId, state: 'complete', agent: 'jerry', routeId,
    generation: 4, deviceIds: [entry.deviceId],
  });
});

test('dashboard wires terminal callbacks, subscribe-after-terminal, and startup replay to one delivery authority', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'engine/src/dashboard/server.js'), 'utf8');
  assert.match(source, /const notificationDelivery = dependencies\.notificationDelivery\s*\|\| createQueryTerminalNotificationDelivery/);
  assert.match(source, /enqueueTerminalNotification:\s*dependencies\.enqueueTerminalNotification\s*\|\| notificationDelivery\.enqueue/);
  assert.match(source, /this\.queryNotebookNotificationDelivery = notificationDelivery/);
  assert.match(source, /notificationDelivery\.start/);
  assert.match(source, /queryNotebookNotificationDelivery\?\.stop/);
  assert.match(source, /onTerminal:\s*\(record\) => this\.queryNotebookNotificationDelivery\?\.onTerminal\(record\)/);
});

test('dashboard terminal replay bounds concurrent harness delivery', async () => {
  const { createQueryTerminalNotificationDelivery } = require(
    '../../../engine/src/dashboard/server.js'
  );
  const entries = Array.from({ length: 20 }, (_, index) => ({
    requesterAgent: 'jerry',
    operationId: `brop_${String(index).padStart(32, '0')}`,
    credentialId: `credential-${index}`,
    deviceId: `ios-installation-${String(index).padStart(8, '0')}`,
    generation: 1,
    terminalState: 'complete',
    routeId: `qroute_${String(index).padStart(32, '0')}`,
    deliveryState: 'pending',
    deliveryRetryable: null,
  }));
  let active = 0;
  let maximum = 0;
  let claimCalls = 0;
  let settleCalls = 0;
  const subscriptions = {
    async listActive() { return entries; },
    async markTerminalPending() { return []; },
    async markTerminalPendingBatch() { return []; },
    async claimDeliveries({ routeIds }) {
      claimCalls += 1;
      return routeIds.map((routeId) => entries.find((entry) => entry.routeId === routeId));
    },
    async settleDeliveries({ results }) {
      settleCalls += 1;
      return results.map((result) => ({
        ...entries.find((entry) => entry.routeId === result.routeId),
        deliveryState: result.state,
      }));
    },
  };
  const delivery = createQueryTerminalNotificationDelivery({
    requesterAgent: 'jerry',
    subscriptions,
    getStatusAuthorized: async () => ({ executionState: 'complete' }),
    bridgeToken: 'configured-bridge-token', bridgeBaseUrl: 'http://127.0.0.1:5004',
    maxConcurrency: 3,
    fetchImpl: async (_url, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      const body = JSON.parse(options.body);
      return { ok: true, async json() {
        return { ok: true, operationId: body.operationId, routeId: body.routeId,
          generation: body.generation, delivered: body.deviceIds, failed: [], pending: [] };
      } };
    },
  });
  const results = await delivery.replay();
  assert.equal(results.length, 20);
  assert.equal(maximum <= 3, true);
  assert.equal(claimCalls, 1);
  assert.equal(settleCalls, 1);
});

test('dashboard delivery concurrency bound is shared across simultaneous terminal callbacks', async () => {
  const { createQueryTerminalNotificationDelivery } = require(
    '../../../engine/src/dashboard/server.js'
  );
  const entries = Array.from({ length: 8 }, (_, index) => ({
    requesterAgent: 'jerry', operationId: `brop_${String(index).padStart(32, '0')}`,
    credentialId: `credential-${index}`,
    deviceId: `ios-installation-${String(index).padStart(8, '0')}`, generation: 1,
    terminalState: 'complete', routeId: `qroute_${String(index).padStart(32, '0')}`,
    deliveryState: 'active', deliveryRetryable: null,
  }));
  let active = 0;
  let maximum = 0;
  const subscriptions = {
    async listActive() { return entries; },
    async markTerminalPending({ operationId }) {
      const entry = entries.find((candidate) => candidate.operationId === operationId);
      entry.deliveryState = 'pending';
      return [entry];
    },
    async markTerminalPendingBatch() { return []; },
    async claimDeliveries({ routeIds }) {
      return routeIds.map((routeId) => entries.find((entry) => entry.routeId === routeId));
    },
    async settleDeliveries({ results }) {
      return results.map((result) => ({
        ...entries.find((entry) => entry.routeId === result.routeId),
        deliveryState: result.state,
      }));
    },
  };
  const delivery = createQueryTerminalNotificationDelivery({
    requesterAgent: 'jerry', subscriptions,
    getStatusAuthorized: async () => ({ executionState: 'complete' }),
    bridgeToken: 'configured-bridge-token', bridgeBaseUrl: 'http://127.0.0.1:5004',
    maxConcurrency: 2,
    fetchImpl: async (_url, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      const body = JSON.parse(options.body);
      return { ok: true, async json() {
        return { ok: true, operationId: body.operationId, routeId: body.routeId,
          generation: body.generation, delivered: body.deviceIds, failed: [], pending: [] };
      } };
    },
  });
  await Promise.all(entries.map((entry) => delivery.onTerminal({
    requesterAgent: 'jerry', operationId: entry.operationId, state: 'complete',
  })));
  assert.equal(maximum, 2);
});

test('dashboard retry loop uses one unref timer, retries during uptime, and stops cleanly', async () => {
  const { createQueryTerminalNotificationDelivery } = require(
    '../../../engine/src/dashboard/server.js'
  );
  const operationId = `brop_${'u'.repeat(32)}`;
  const routeId = `qroute_${'v'.repeat(32)}`;
  let entry = {
    requesterAgent: 'jerry', operationId, credentialId: 'credential-retry',
    deviceId: 'ios-installation-00000001', generation: 1, terminalState: 'complete',
    routeId, deliveryState: 'failed', deliveryRetryable: true,
  };
  let fetches = 0;
  let scheduled = null;
  let clears = 0;
  let unrefs = 0;
  const delivery = createQueryTerminalNotificationDelivery({
    requesterAgent: 'jerry',
    subscriptions: {
      async listActive() { return [entry]; },
      async markTerminalPending() { return []; },
      async markTerminalPendingBatch() { return []; },
      async claimDeliveries() { entry = { ...entry, deliveryState: 'pending' }; return [entry]; },
      async settleDeliveries({ results }) {
        const result = results[0];
        entry = { ...entry, deliveryState: result.state,
          deliveryRetryable: result.retryable ?? false };
        return [entry];
      },
    },
    getStatusAuthorized: async () => ({ executionState: 'complete' }),
    bridgeToken: 'configured-bridge-token', bridgeBaseUrl: 'http://127.0.0.1:5004',
    retryIntervalMs: 20,
    timers: {
      setTimeout(callback) {
        scheduled = callback;
        return { unref() { unrefs += 1; } };
      },
      clearTimeout() { clears += 1; scheduled = null; },
    },
    fetchImpl: async (_url, options) => {
      fetches += 1;
      const body = JSON.parse(options.body);
      if (fetches === 1) throw new Error('bridge unavailable');
      return { ok: true, async json() {
        return { ok: true, operationId, routeId, generation: 1,
          delivered: body.deviceIds, failed: [], pending: [] };
      } };
    },
  });
  await delivery.start();
  assert.equal(fetches, 1);
  assert.equal(typeof scheduled, 'function');
  assert.equal(unrefs, 1);
  const retry = scheduled;
  await retry();
  assert.equal(fetches, 2);
  assert.equal(entry.deliveryState, 'delivered');
  assert.equal(unrefs, 2);
  await delivery.stop();
  assert.equal(clears, 1);
  assert.equal(scheduled, null);
});

test('dashboard delivery stop aborts an already-started terminal delivery within a bound', async () => {
  const { createQueryTerminalNotificationDelivery } = require(
    '../../../engine/src/dashboard/server.js'
  );
  const entered = deferred();
  const operationId = `brop_${'w'.repeat(32)}`;
  const routeId = `qroute_${'x'.repeat(32)}`;
  const entry = {
    requesterAgent: 'jerry', operationId, credentialId: 'credential-stop',
    deviceId: 'ios-installation-00000001', generation: 1, terminalState: 'complete',
    routeId, deliveryState: 'active', deliveryRetryable: null,
  };
  let observedSignal;
  const delivery = createQueryTerminalNotificationDelivery({
    requesterAgent: 'jerry',
    subscriptions: {
      async listActive() { return []; },
      async markTerminalPending() { entry.deliveryState = 'pending'; return [entry]; },
      async markTerminalPendingBatch() { return []; },
      async claimDeliveries() { return [entry]; },
      async settleDeliveries({ results }) {
        return [{ ...entry, deliveryState: results[0].state }];
      },
    },
    getStatusAuthorized: async () => ({ executionState: 'complete' }),
    bridgeToken: 'configured-bridge-token', bridgeBaseUrl: 'http://127.0.0.1:5004',
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const terminal = delivery.onTerminal({ requesterAgent: 'jerry', operationId, state: 'complete' });
  await entered.promise;
  await Promise.race([
    delivery.stop(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('delivery stop did not abort in time')), 100,
    )),
  ]);
  assert.equal(observedSignal.aborted, true);
  await terminal;
});

test('requester-bound cancel and detach reject a foreign durable record before mutation', async () => {
  const calls = { getWorker: 0, transition: 0, detach: 0 };
  const foreign = {
    operationId: `brop_${'f'.repeat(32)}`,
    requesterAgent: 'mallory',
    state: 'running',
  };
  const store = {
    async get() { return foreign; },
    async getWorker() { calls.getWorker += 1; return null; },
    async transition() { calls.transition += 1; return foreign; },
    async detachAttachment() { calls.detach += 1; return {}; },
  };
  const coordinator = new BrainOperationCoordinator({
    requesterAgent: 'jerry',
    store,
    buildCanonicalCatalog: async () => makeCatalog(),
    resolveCanonicalTarget: resolveBrain,
    operationAuthority: POLICIES,
    authorizeBrainOperation,
    worker: {},
    capabilityIssuer: () => 'capability',
  });

  await assert.rejects(
    () => coordinator.cancel(foreign.operationId),
    typedCode('access_denied'),
  );
  await assert.rejects(
    () => coordinator.detach(foreign.operationId, {
      attachmentId: 'attachment-foreign',
      reason: 'caller_abort',
    }),
    typedCode('access_denied'),
  );
  assert.deepEqual(calls, { getWorker: 0, transition: 0, detach: 0 });
  await coordinator.stop();
});

test('attachment cursor replays durable events then streams future events without duplicates', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'attachment-replay' }));
  const replayAfter = (await fixture.store.get(operation.operationId)).eventSequence;
  fixture.worker.emit(operation.operationId, { type: 'progress', eventSequence: 1, completed: 1 });
  fixture.worker.emit(operation.operationId, { type: 'progress', eventSequence: 2, completed: 2 });
  await eventually(async () => {
    const rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.filter(({ type }) => type === 'progress').length, 2);
  });

  const replay = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'replay', afterSequence: replayAfter,
  });
  const first = await replay.nextEvent();
  const second = await replay.nextEvent();
  assert.equal(first.eventSequence < second.eventSequence, true);
  assert.deepEqual([first.workerEventSequence, second.workerEventSequence], [1, 2]);

  const futureOnly = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'future', afterSequence: second.eventSequence,
  });
  fixture.worker.emit(operation.operationId, { type: 'progress', eventSequence: 3, completed: 3 });
  const future = await futureOnly.nextEvent();
  assert.equal(future.workerEventSequence, 3);
  assert.equal(future.eventSequence > second.eventSequence, true);

  await assert.rejects(
    () => fixture.coordinator.attach(operation.operationId, {
      attachmentId: 'bad-cursor', afterSequence: -1,
    }),
    typedCode('event_cursor_invalid'),
  );
  await fixture.coordinator.detach(operation.operationId, {
    attachmentId: 'replay',
    reason: 'test_complete',
  });
  await fixture.coordinator.detach(operation.operationId, {
    attachmentId: 'future',
    reason: 'test_complete',
  });
  await replay.done;
  await futureOnly.done;
});

test('callback-mode attachment delivery does not retain duplicate nextEvent backlog', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'callback-no-backlog' }));
  const afterSequence = (await fixture.store.get(operation.operationId)).eventSequence;
  const observed = [];
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'callback',
    afterSequence,
    onEvent(event) { observed.push(event); },
  });
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    fixture.worker.emit(operation.operationId, {
      type: 'progress', eventSequence: sequence, completed: sequence,
    });
  }
  await eventually(async () => assert.equal(observed.length, 10), 50_000);

  const next = attachment.nextEvent();
  fixture.worker.emit(operation.operationId, {
    type: 'progress', eventSequence: 11, completed: 11,
  });
  const delivered = await next;
  assert.equal(delivered.workerEventSequence, 11);
  assert.equal(observed.length, 11);
});

test('duplicate attachment IDs are rejected and slow pull consumers retain no unbounded backlog', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'bounded-attachment' }));
  const current = await fixture.store.get(operation.operationId);
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'bounded-consumer', afterSequence: current.eventSequence,
  });
  await assert.rejects(
    () => fixture.coordinator.attach(operation.operationId, {
      attachmentId: 'bounded-consumer', afterSequence: current.eventSequence,
    }),
    typedCode('attachment_already_attached'),
  );
  for (let index = 0; index < 200; index += 1) {
    fixture.worker.emit(operation.operationId, { type: 'progress', completed: index + 1 });
  }
  await eventually(async () => {
    const rows = await fixture.store.readEvents(operation.operationId, current.eventSequence);
    assert.equal(rows.length > 0, true);
  });
  const subscriber = fixture.coordinator.runtimes
    .get(operation.operationId).attachments.get('bounded-consumer');
  assert.equal(subscriber.queue.length <= 1, true);
  const event = await attachment.nextEvent();
  assert.equal(event.eventSequence > current.eventSequence, true);
});

test('the coordinator reuses one attachment ID only after durable detach and never after close', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'coordinator-reopen' }));
  const current = await fixture.store.get(operation.operationId);
  const first = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'stable-reconnect',
    afterSequence: current.eventSequence,
  });
  await assert.rejects(
    () => fixture.coordinator.attach(operation.operationId, {
      attachmentId: 'stable-reconnect',
      afterSequence: current.eventSequence,
    }),
    typedCode('attachment_already_attached'),
  );

  await fixture.coordinator.detach(operation.operationId, {
    attachmentId: 'stable-reconnect',
    reason: 'event_gap_reconnect',
  });
  await first.done;
  const reopened = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'stable-reconnect',
    afterSequence: current.eventSequence,
  });
  assert.equal((await fixture.store.getAttachment(
    operation.operationId,
    'stable-reconnect',
  )).state, 'attached');

  await fixture.coordinator.detach(operation.operationId, {
    attachmentId: 'stable-reconnect',
    reason: 'test_complete',
  });
  await reopened.done;
  await fixture.store.closeAttachment(
    operation.operationId,
    'stable-reconnect',
    'response_complete',
  );
  await assert.rejects(
    () => fixture.coordinator.attach(operation.operationId, {
      attachmentId: 'stable-reconnect',
      afterSequence: current.eventSequence,
    }),
    typedCode('attachment_closed'),
  );
});

test('queued and running heartbeats use ten-second cadence and stop clears timers without terminalizing', async (t) => {
  const worker = new ControlledWorker();
  worker.blockStart = deferred();
  t.after(() => worker.blockStart.resolve());
  const fixture = makeFixture(t, { worker });
  let startError = null;
  const starting = fixture.coordinator.start(request());
  starting.catch((error) => { startError = error; });
  await eventually(async () => {
    if (startError) throw startError;
    assert.equal(worker.startCalls.length, 1);
  }, 10_000);
  await eventually(async () => assert.equal((await fixture.store.listNonterminal()).length, 1));
  await eventually(async () => assert.equal(fixture.timers.pending() > 0, true));
  const queued = (await fixture.store.listNonterminal())[0];
  assert.equal(queued.state, 'queued');
  const queuedHeartbeat = fixture.timers.advance(10_000);
  await flush();
  worker.blockStart.resolve();
  const running = await starting;
  await queuedHeartbeat;
  assert.equal((await fixture.store.readEvents(queued.operationId, 0)).some(({ type }) => type === 'heartbeat'), true);
  await fixture.timers.advance(10_000);
  assert.equal((await fixture.store.readEvents(running.operationId, 0))
    .filter(({ type }) => type === 'heartbeat').length >= 2, true);
  await fixture.coordinator.stop();
  assert.equal(fixture.timers.pending(), 0);
  assert.equal((await fixture.store.get(running.operationId)).state, 'running');
});

test('source worker startup may exceed the short control timeout without creating ghost work', async (t) => {
  const worker = new ControlledWorker();
  worker.blockStart = deferred();
  t.after(() => worker.blockStart.resolve());
  const fixture = makeFixture(t, { worker });
  let settled = false;
  let startError = null;
  const starting = fixture.coordinator.start(request({ requestId: 'long-source-worker-start' }));
  starting.then(
    () => { settled = true; },
    (error) => { settled = true; startError = error; },
  );
  await eventually(() => {
    if (startError) throw startError;
    assert.equal(worker.startCalls.length, 1);
  }, 10_000);

  await fixture.timers.advance((15 * 60_000) + 60_000);
  await flush();
  assert.equal(settled, false);
  assert.equal((await fixture.store.listNonterminal())[0].state, 'queued');

  worker.blockStart.resolve();
  const running = await starting;
  assert.equal(running.state, 'running');
  assert.equal(worker.startCalls.length, 1);
  assert.equal(worker.cancelCalls.length, 0);
});

test('coordinator stop cancels and waits for an unpublished pending worker start', async (t) => {
  class StoppablePendingWorker extends ControlledWorker {
    constructor() {
      super();
      this.startGate = deferred();
    }

    async start(context, capability) {
      this.startCalls.push({ context, capability });
      await this.startGate.promise;
      let record = this.records.get(context.operationId);
      if (!record) {
        record = {
          reference: {
            version: 1,
            workerId: `worker-${context.operationId}`,
            workerType: 'cosmo',
            operationType: context.operationType,
          },
          operationId: context.operationId,
          state: 'running',
          phase: 'executing',
          eventSequence: 0,
          activeProviderCalls: [],
          events: [],
          result: null,
        };
        this.records.set(context.operationId, record);
      }
      return this.publicRecord(record);
    }

    async cancel(operationId, capability) {
      this.cancelCalls.push({ operationId, capability });
      this.startGate.resolve();
      return {};
    }
  }

  const worker = new StoppablePendingWorker();
  t.after(() => worker.startGate.resolve());
  const fixture = makeFixture(t, { worker });
  const starting = fixture.coordinator.start(request({ requestId: 'stop-pending-worker-start' }));
  await eventually(() => assert.equal(worker.startCalls.length, 1), 10_000);

  await fixture.coordinator.stop();
  assert.equal(worker.cancelCalls.length >= 1, true);
  const queued = await starting;
  assert.equal(queued.state, 'queued');
  assert.equal(await fixture.store.getWorker(queued.operationId), null);
  assert.equal(fixture.coordinator.runtimes.has(queued.operationId), false);
});

test('coordinator stop waits for cancellation after a worker resolves during publication', async (t) => {
  class PublicationGateWorker extends ControlledWorker {
    async start(context, capability) {
      const record = await super.start(context, capability);
      this.publicationOperationId = context.operationId;
      return record;
    }
  }

  const worker = new PublicationGateWorker();
  const fixture = makeFixture(t, { worker });
  const publicationEntered = deferred();
  const publicationGate = deferred();
  const storeGet = fixture.store.get.bind(fixture.store);
  let publicationBlocked = false;
  fixture.store.get = async (operationId) => {
    if (!publicationBlocked && operationId === worker.publicationOperationId) {
      publicationBlocked = true;
      publicationEntered.resolve();
      await publicationGate.promise;
    }
    return storeGet(operationId);
  };

  const starting = fixture.coordinator.start(request({ requestId: 'stop-during-worker-publication' }));
  await publicationEntered.promise;
  let stopSettled = false;
  const stopping = fixture.coordinator.stop().then(() => { stopSettled = true; });
  await flush();
  assert.equal(stopSettled, false);

  publicationGate.resolve();
  await stopping;
  const queued = await starting;
  assert.equal(queued.state, 'queued');
  assert.equal(worker.cancelCalls.length >= 1, true);
  assert.equal(await fixture.store.getWorker(queued.operationId), null);
  assert.equal(fixture.coordinator.runtimes.has(queued.operationId), false);
});

test('coordinator shutdown ends in-memory attachment waiters without terminalizing durable work', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'stop-attachment' }));
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'shutdown-waiter', afterSequence: operation.eventSequence,
  });
  let finished = false;
  attachment.done.then(() => { finished = true; });
  await fixture.coordinator.stop();
  await flush();
  assert.equal(finished, true);
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
  assert.equal(
    (await fixture.store.getAttachment(operation.operationId, 'shutdown-waiter')).state,
    'attached',
  );
});

test('sixty seconds of worker silence performs authenticated status and reconnect only', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request());
  await eventually(async () => assert.equal(fixture.worker.eventsCalls.length, 1));
  const statusBefore = fixture.worker.statusCalls.length;
  await fixture.timers.advance(60_000);
  await eventually(async () => assert.equal(fixture.worker.eventsCalls.length >= 2, true));
  assert.equal(fixture.worker.statusCalls.length > statusBefore, true);
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
  assert.equal(fixture.worker.cancelCalls.length, 0);
});

test('silence reconnect tolerates a worker iterator rejecting with the abort reason', async (t) => {
  class RejectingAbortWorker extends ControlledWorker {
    async *events(operationId, { afterSequence, signal }, capability) {
      this.eventsCalls.push({ operationId, afterSequence, signal, capability });
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  }
  const fixture = makeFixture(t, { worker: new RejectingAbortWorker() });
  const operation = await fixture.coordinator.start(request({ requestId: 'rejecting-silence' }));
  await eventually(() => assert.equal(fixture.worker.eventsCalls.length, 1));
  const statusBefore = fixture.worker.statusCalls.length;
  await fixture.timers.advance(60_000);
  await eventually(() => assert.equal(fixture.worker.eventsCalls.length >= 2, true));
  assert.equal(fixture.worker.statusCalls.length > statusBefore, true);
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
  assert.equal(fixture.worker.cancelCalls.length, 0);
});

test('silence recovery treats provider events covered by its status snapshot as historical', async (t) => {
  class SnapshotReplayWorker extends ControlledWorker {
    constructor() {
      super();
      this.firstStream = true;
      this.snapshotInjected = false;
    }

    async *events(operationId, options, capability) {
      if (this.firstStream) {
        this.firstStream = false;
        this.eventsCalls.push({ operationId, ...options, capability });
        await new Promise((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', resolve, { once: true });
        });
        return;
      }
      yield* super.events(operationId, options, capability);
    }

    async status(operationId, capability) {
      if (!this.snapshotInjected) {
        this.snapshotInjected = true;
        this.emit(operationId, {
          type: 'provider_selected',
          providerCallId: 'query',
          providerStallMs: 5_000,
        });
      }
      return super.status(operationId, capability);
    }
  }

  const worker = new SnapshotReplayWorker();
  const fixture = makeFixture(t, { worker });
  const operation = await fixture.coordinator.start(request({ requestId: 'silence-provider-snapshot' }));
  await eventually(() => assert.equal(worker.eventsCalls.length, 1));
  await fixture.timers.advance(60_000);
  await eventually(() => assert.equal(worker.eventsCalls.length >= 2, true));
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');

  worker.emit(operation.operationId, {
    type: 'provider_call_terminal',
    providerCallId: 'query',
  });
  worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'provider snapshot replay completed' },
    error: null,
    sourceEvidence: null,
  });
  const complete = await waitForState(fixture, operation.operationId, 'complete');
  assert.equal(complete.error, null);
  assert.equal(worker.cancelCalls.length, 0);
});

test('a stuck authenticated worker status is bounded without shortening execution', async (t) => {
  class StuckStatusWorker extends ControlledWorker {
    constructor() {
      super();
      this.statusGate = deferred();
    }

    async status(operationId, capability) {
      this.statusCalls.push({ operationId, capability });
      return this.statusGate.promise;
    }
  }
  const worker = new StuckStatusWorker();
  const fixture = makeFixture(t, { worker, workerControlTimeoutMs: 100 });
  t.after(() => {
    const record = worker.records.values().next().value;
    if (record) worker.statusGate.resolve(worker.publicRecord(record));
  });
  const operation = await fixture.coordinator.start(request({ requestId: 'stuck-status' }));
  let settled = false;
  let code = null;
  const checking = fixture.coordinator.status(operation.operationId).catch((error) => {
    settled = true;
    code = error.code;
  });
  await eventually(() => assert.equal(worker.statusCalls.length, 1));
  assert.equal(fixture.coordinator.workerControlTimeoutMs, 100);
  await fixture.timers.advance(100);
  await flush();
  assert.equal(settled, true);
  assert.equal(code, 'worker_control_timeout');
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
  await checking;
});

test('a delayed reconnect status cannot rearm provider timers after cancellation removed the runtime', async (t) => {
  class DelayedReconnectWorker extends ControlledWorker {
    constructor() {
      super();
      this.statusGate = deferred();
    }

    async *events(operationId, { afterSequence, signal }, capability) {
      this.eventsCalls.push({ operationId, afterSequence, signal, capability });
    }

    async status(operationId, capability) {
      this.statusCalls.push({ operationId, capability });
      return this.statusGate.promise;
    }
  }
  const worker = new DelayedReconnectWorker();
  const fixture = makeFixture(t, { worker });
  const operation = await fixture.coordinator.start(request({ requestId: 'delayed-reconnect' }));
  await eventually(() => assert.equal(worker.statusCalls.length, 1));
  const oldRuntime = fixture.coordinator.runtimes.get(operation.operationId);
  const cancelled = await fixture.coordinator.cancel(operation.operationId);
  assert.equal(cancelled.state, 'cancelled');
  const snapshot = worker.publicRecord(worker.records.get(operation.operationId));
  snapshot.activeProviderCalls = [{
    providerCallId: 'query', providerStallMs: 5_000, idleMs: 100,
  }];
  worker.statusGate.resolve(snapshot);
  await eventually(() => assert.equal(oldRuntime.pumpPromise, null));
  assert.equal(oldRuntime.stopped, true);
  assert.equal(oldRuntime.providerCalls.size, 0);
  assert.equal(fixture.coordinator.runtimes.has(operation.operationId), false);
});

test('worker event gaps record evidence, authenticate status, and resume future events', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request());
  const current = await fixture.store.get(operation.operationId);
  const attachment = await fixture.coordinator.attach(operation.operationId, {
    attachmentId: 'worker-gap-evidence',
    afterSequence: current.eventSequence,
  });
  const nextEvent = attachment.nextEvent();
  fixture.worker.emit(operation.operationId, {
    type: 'event_gap',
    eventSequence: 7,
    oldestSequence: 4,
    latestSequence: 7,
    currentStatus: fixture.worker.publicRecord(fixture.worker.records.get(operation.operationId)),
  });
  await eventually(async () => {
    const events = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(events.some((event) => event.type === 'heartbeat'
      && event.workerOldestSequence === 4
      && event.workerLatestSequence === 7), true);
    assert.equal(events.some(({ type }) => type === 'event_gap'), false);
  });
  const statusCalls = fixture.worker.statusCalls.length;
  fixture.worker.emit(operation.operationId, { type: 'progress', eventSequence: 8, completed: 8 });
  await eventually(async () => {
    const events = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(events.some((event) => event.workerEventSequence === 8), true);
  });
  const recovered = await nextEvent;
  assert.equal(recovered.type, 'heartbeat');
  assert.equal(recovered.workerLatestSequence, 7);
  const streamed = await attachment.nextEvent();
  assert.equal(streamed.type, 'progress');
  assert.equal(streamed.workerEventSequence, 8);
  assert.equal(fixture.worker.statusCalls.length >= statusCalls, true);
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
  await fixture.coordinator.detach(operation.operationId, {
    attachmentId: 'worker-gap-evidence',
    reason: 'test_complete',
  });
});

test('COSMO client and worker adapter preserve compacted Query gaps through terminal recovery', async (t) => {
  let operationId;
  let eventStreamCalls = 0;
  let statusCalls = 0;
  const record = (state = 'complete') => ({
    reference: {
      version: 1,
      workerId: `cosmo-${operationId}`,
      workerType: 'cosmo',
      operationType: 'query',
    },
    operationId,
    operationType: 'query',
    state,
    phase: state === 'running' ? 'executing' : 'terminal',
    eventSequence: state === 'running' ? 0 : 7,
    activeProviderCalls: [],
  });
  const jsonResponse = (value) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const remoteWorker = createCosmoBrainOperationWorkerClient({
    fetchImpl: async (rawUrl, options) => {
      const url = new URL(rawUrl);
      const action = url.pathname.split('/').at(-1);
      if (action === 'start') {
        const context = JSON.parse(options.body);
        operationId = context.operationId;
        return jsonResponse(record('running'));
      }
      if (action === 'status') {
        statusCalls += 1;
        return jsonResponse(record());
      }
      if (action === 'result') {
        return jsonResponse({
          state: 'complete',
          result: { answer: 'gap-safe' },
          resultArtifact: null,
          error: null,
          sourceEvidence: { fixture: 'cosmo-client-gap' },
        });
      }
      if (action === 'events') {
        eventStreamCalls += 1;
        const terminal = record();
        const frames = [
          { type: 'phase', phase: 'projecting', operationId, eventSequence: 1 },
          { type: 'progress', completed: 1, operationId, eventSequence: 2 },
          {
            type: 'provider_selected', providerCallId: 'query', providerStallMs: 5_000,
            operationId, eventSequence: 3,
          },
          {
            type: 'event_gap', oldestSequence: 5, latestSequence: 5,
            currentStatus: terminal, operationId, eventSequence: 5,
          },
          {
            type: 'provider_call_terminal', providerCallId: 'query',
            operationId, eventSequence: 6,
          },
          { type: 'terminal', state: 'complete', operationId, eventSequence: 7 },
        ];
        return new Response(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      throw new Error(`unexpected COSMO action: ${action}`);
    },
  });
  const worker = new BrainOperationWorkerAdapter({ remoteWorker });
  t.after(() => worker.stop?.());
  const fixture = makeFixture(t, { worker });
  const operation = await fixture.coordinator.start(request({ requestId: 'real-cosmo-gap' }));
  const completed = await waitForState(fixture, operation.operationId, 'complete');

  assert.equal(completed.result.answer, 'gap-safe');
  assert.equal(eventStreamCalls, 1);
  assert.equal(statusCalls >= 2, true);
  const events = await fixture.store.readEvents(operation.operationId, 0);
  assert.equal(events.some((event) => event.type === 'heartbeat'
    && event.workerOldestSequence === 5
    && event.workerLatestSequence === 5
    && event.workerEventSequence === 7), true);
  assert.equal(events.some((event) => event.type === 'event_gap'), false);
  assert.equal(events.some((event) => event.type === 'provider_call_terminal'
    && event.workerEventSequence === 6), true);
});

test('worker events reject forged terminal state, identity fields, and invalid gap bounds before persistence', async (t) => {
  const forgedFixture = makeFixture(t);
  const forgedOperation = await forgedFixture.coordinator.start(request({
    requestId: 'forged-progress-event',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  forgedFixture.worker.emit(forgedOperation.operationId, {
    type: 'progress', completed: 1, state: 'complete',
    requesterAgent: 'mallory', target: { requesterAgent: 'mallory' },
  });
  const forgedFailed = await waitForState(
    forgedFixture,
    forgedOperation.operationId,
    'failed',
  );
  assert.equal(forgedFailed.error.code, 'worker_event_invalid');
  const forgedRows = await forgedFixture.store.readEvents(forgedOperation.operationId, 0);
  assert.equal(forgedRows.some(({ requesterAgent }) => requesterAgent === 'mallory'), false);

  const gapFixture = makeFixture(t);
  const gapOperation = await gapFixture.coordinator.start(request({ requestId: 'invalid-gap-bounds' }));
  gapFixture.worker.emit(gapOperation.operationId, {
    type: 'event_gap', eventSequence: 7, oldestSequence: 8, latestSequence: 7,
  });
  const gapFailed = await waitForState(gapFixture, gapOperation.operationId, 'failed');
  assert.equal(gapFailed.error.code, 'worker_event_invalid');
});

test('worker status and gap recovery reject a reference different from durable worker identity', async (t) => {
  const statusFixture = makeFixture(t);
  const statusOperation = await statusFixture.coordinator.start(request({
    requestId: 'wrong-status-reference',
  }));
  const statusWorker = statusFixture.worker.records.get(statusOperation.operationId);
  statusWorker.reference = { ...statusWorker.reference, workerId: 'worker-forged-status' };
  statusWorker.state = 'complete';
  statusWorker.phase = 'terminal';
  statusWorker.result = {
    state: 'complete', result: { answer: 'forged' }, resultArtifact: null,
    error: null, sourceEvidence: {},
  };
  const statusFailed = await statusFixture.coordinator.status(statusOperation.operationId);
  assert.equal(statusFailed.state, 'failed');
  assert.equal(statusFailed.error.code, 'worker_contract_invalid');
  assert.equal(statusFailed.result, null);

  const gapFixture = makeFixture(t);
  const gapOperation = await gapFixture.coordinator.start(request({
    requestId: 'wrong-gap-reference',
  }));
  const gapWorker = gapFixture.worker.records.get(gapOperation.operationId);
  gapWorker.reference = { ...gapWorker.reference, workerId: 'worker-forged-gap' };
  gapFixture.worker.emit(gapOperation.operationId, {
    type: 'event_gap', eventSequence: 7, oldestSequence: 2, latestSequence: 7,
  });
  const gapFailed = await waitForState(gapFixture, gapOperation.operationId, 'failed');
  assert.equal(gapFailed.error.code, 'worker_contract_invalid');
  assert.equal(gapFixture.worker.cancelCalls.length, 1);

  const terminalFixture = makeFixture(t);
  const terminalOperation = await terminalFixture.coordinator.start(request({
    requestId: 'wrong-terminal-reference',
  }));
  const terminalWorker = terminalFixture.worker.records.get(terminalOperation.operationId);
  terminalWorker.reference = { ...terminalWorker.reference, workerId: 'worker-forged-terminal' };
  terminalWorker.state = 'complete';
  terminalWorker.phase = 'terminal';
  terminalWorker.result = {
    state: 'complete', result: { answer: 'forged-terminal' }, resultArtifact: null,
    error: null, sourceEvidence: {},
  };
  terminalFixture.worker.emit(terminalOperation.operationId, {
    type: 'terminal', state: 'complete',
  });
  const terminalFailed = await waitForState(
    terminalFixture,
    terminalOperation.operationId,
    'failed',
  );
  assert.equal(terminalFailed.error.code, 'worker_contract_invalid');
  assert.equal(terminalFailed.result, null);
});

test('provider call timers are independent and only matching local receipt activity renews one', async (t) => {
  const fixture = makeFixture(t, {
    executionDeadlineMsByType: { pgs: 60_000 },
  });
  const operation = await fixture.coordinator.start(request({
    operationType: 'pgs', parameters: { query: 'canary' },
  }));
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'pgs:p1-u1', providerStallMs: 5_000,
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'pgs:p2-u1', providerStallMs: 5_000,
  });
  await eventually(async () => {
    const rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.filter(({ type }) => type === 'provider_selected').length, 2);
  });
  const beforePartial = await fixture.store.get(operation.operationId);
  await fixture.store.setResult(operation.operationId, {
    expectedVersion: beforePartial.recordVersion,
    result: { sweepOutputs: [{ partition: 'p1', answer: 'partial' }] },
  });
  await fixture.timers.advance(1_000);
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity',
    providerCallId: 'pgs:p1-u1',
    providerEventAt: '2099-01-01T00:00:00.000Z',
  });
  const afterActivity = await eventually(async () => {
    const current = await fixture.store.get(operation.operationId);
    assert.equal(current.lastProviderActivityAt, new Date(fixture.timers.now).toISOString());
    return current;
  });
  assert.equal(afterActivity.lastProviderActivityAt, new Date(fixture.timers.now).toISOString());
  await fixture.timers.advance(4_000);
  const failed = await waitForState(fixture, operation.operationId, 'failed');
  assert.equal(failed.error.code, 'provider_stalled');
  assert.equal(failed.error.providerCallId, 'pgs:p2-u1');
  assert.equal(failed.error.retryable, true);
  assert.deepEqual(failed.result, { sweepOutputs: [{ partition: 'p1', answer: 'partial' }] });
  assert.equal(fixture.worker.cancelCalls.length, 1);
});

test('provider activity renews stall authority without a durable event per provider frame', async (t) => {
  const fixture = makeFixture(t, {
    executionDeadlineMsByType: { query: 120_000 },
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'provider-activity-journal-coalescing',
  }));
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'query', providerStallMs: 60_000,
  });
  await eventually(async () => {
    const rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.filter((event) => event.type === 'provider_selected').length, 1);
  });
  for (let index = 0; index < 20; index += 1) {
    fixture.worker.emit(operation.operationId, {
      type: 'provider_activity', providerCallId: 'query', providerChunk: index,
    });
  }
  await eventually(async () => {
    const runtime = fixture.coordinator.runtimes.get(operation.operationId);
    const workerRecord = fixture.worker.records.get(operation.operationId);
    const status = await fixture.store.get(operation.operationId);
    assert.equal(runtime.workerCursor, workerRecord.eventSequence, JSON.stringify({
      cursor: runtime.workerCursor, workerSequence: workerRecord.eventSequence,
      state: status.state, error: status.error,
    }));
  });
  let rows = await fixture.store.readEvents(operation.operationId, 0);
  assert.equal(rows.filter((event) => event.type === 'provider_activity').length, 1);
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');

  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'query',
    providerEventType: 'controlled_provider_progress',
  });
  await eventually(async () => {
    rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.filter((event) => event.type === 'provider_activity').length, 2);
    assert.equal(rows.at(-1).providerEventType, 'controlled_provider_progress');
  });

  await fixture.timers.advance(10_000);
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'query', providerChunk: 20,
  });
  await eventually(async () => {
    rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.filter((event) => event.type === 'provider_activity').length, 3);
  });
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
});

test('stale provider and hard-deadline callbacks no-op after renewal or coordinator stop', async (t) => {
  const providerFixture = makeFixture(t, {
    executionDeadlineMsByType: { query: 60_000 },
  });
  const operation = await providerFixture.coordinator.start(request({
    requestId: 'stale-provider-timer',
  }));
  providerFixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'query', providerStallMs: 5_000,
  });
  await eventually(async () => {
    const rows = await providerFixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.some(({ type }) => type === 'provider_selected'), true);
  });
  const providerGate = deferred();
  const occupied = providerFixture.coordinator._enqueue(
    operation.operationId,
    () => providerGate.promise,
  );
  const occupiedQueue = providerFixture.coordinator.operationQueues.get(operation.operationId);
  providerFixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'query',
  });
  await eventually(() => assert.notEqual(
    providerFixture.coordinator.operationQueues.get(operation.operationId),
    occupiedQueue,
  ));
  const providerExpiry = providerFixture.timers.advance(5_000);
  await flush();
  providerGate.resolve();
  await Promise.all([occupied, providerExpiry]);
  assert.equal((await providerFixture.store.get(operation.operationId)).state, 'running');

  const deadlineFixture = makeFixture(t, {
    executionDeadlineMsByType: { research_launch: 5_000 },
  });
  const deadlineOperation = await deadlineFixture.coordinator.start(request({
    requestId: 'stale-hard-deadline',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  const deadlineGate = deferred();
  const deadlineOccupied = deadlineFixture.coordinator._enqueue(
    deadlineOperation.operationId,
    () => deadlineGate.promise,
  );
  const deadlineQueue = deadlineFixture.coordinator.operationQueues.get(deadlineOperation.operationId);
  const deadlineExpiry = deadlineFixture.timers.advance(5_000);
  await eventually(() => assert.notEqual(
    deadlineFixture.coordinator.operationQueues.get(deadlineOperation.operationId),
    deadlineQueue,
  ));
  const stopping = deadlineFixture.coordinator.stop();
  deadlineGate.resolve();
  await Promise.all([deadlineOccupied, deadlineExpiry, stopping]);
  assert.equal((await deadlineFixture.store.get(deadlineOperation.operationId)).state, 'running');
});

test('initial worker start replays provider events without double-arming its active-call snapshot', async (t) => {
  class PreselectedWorker extends ControlledWorker {
    async start(context, capability) {
      await super.start(context, capability);
      this.emit(context.operationId, {
        type: 'provider_selected', providerCallId: 'query', providerStallMs: 5_000,
      });
      return this.publicRecord(this.records.get(context.operationId));
    }
  }
  const fixture = makeFixture(t, {
    worker: new PreselectedWorker(),
    executionDeadlineMsByType: { query: 60_000 },
  });
  const operation = await fixture.coordinator.start(request({ requestId: 'start-active-call' }));
  await eventually(async () => {
    const rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.filter(({ type }) => type === 'provider_selected').length, 1);
  });
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'query',
  });
  await eventually(async () => {
    assert.equal((await fixture.store.get(operation.operationId)).lastProviderActivityAt !== null, true);
  });
});

test('query provider lifecycle accepts the bounded sequential expansion call', async (t) => {
  const fixture = makeFixture(t, { executionDeadlineMsByType: { query: 60_000 } });
  const operation = await fixture.coordinator.start(request({
    requestId: 'query-expansion-provider-lifecycle',
  }));

  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'query', providerStallMs: 5_000,
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_call_terminal', providerCallId: 'query',
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'query-expand', providerStallMs: 5_000,
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'query-expand',
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_call_terminal', providerCallId: 'query-expand',
  });

  await eventually(async () => {
    const rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.deepEqual(
      rows.filter(({ type }) => type === 'provider_selected')
        .map(({ providerCallId }) => providerCallId),
      ['query', 'query-expand'],
    );
  });
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');
});

test('provider terminal clears one timer, invalid correlation fails closed, and heartbeats renew none', async (t) => {
  const fixture = makeFixture(t, { executionDeadlineMsByType: { query: 60_000 } });
  const operation = await fixture.coordinator.start(request());
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'query', providerStallMs: 5_000,
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_call_terminal', providerCallId: 'query',
  });
  await flush(20);
  await fixture.timers.advance(6_000);
  assert.equal((await fixture.store.get(operation.operationId)).state, 'running');

  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'unknown',
  });
  const failed = await waitForState(fixture, operation.operationId, 'failed');
  assert.equal(failed.error.code, 'provider_contract_invalid');
  assert.equal(failed.error.retryable, true);
});

test('provider lifecycle events fail closed on non-provider operation types', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'non-provider-event',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected',
    providerCallId: 'research_launch',
    providerStallMs: 5_000,
  });
  const failed = await waitForState(fixture, operation.operationId, 'failed');
  assert.equal(failed.error.code, 'provider_contract_invalid');
  assert.equal(fixture.worker.cancelCalls.length, 1);
});

test('terminal worker status with active provider calls fails the provider contract', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'terminal-active-call' }));
  const workerRecord = fixture.worker.records.get(operation.operationId);
  workerRecord.state = 'complete';
  workerRecord.phase = 'terminal';
  workerRecord.activeProviderCalls = [{
    providerCallId: 'query', providerStallMs: 5_000, idleMs: 100,
  }];
  workerRecord.result = {
    state: 'complete', result: { answer: 'unsafe' }, resultArtifact: null,
    error: null, sourceEvidence: {},
  };
  const failed = await fixture.coordinator.status(operation.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'provider_contract_invalid');
  assert.equal(failed.error.retryable, true);
  assert.equal(failed.result, null);
});

test('reconciliation rebuilds authenticated active call timers and expires stale calls immediately', async (t) => {
  const fixture = makeFixture(t, { executionDeadlineMsByType: { query: 60_000 } });
  const operation = await fixture.coordinator.start(request());
  const workerRecord = fixture.worker.records.get(operation.operationId);
  workerRecord.activeProviderCalls = [{
    providerCallId: 'query', providerStallMs: 5_000, idleMs: 5_000,
  }];
  await fixture.coordinator.stop();

  const resumed = new BrainOperationCoordinator({
    requesterAgent: 'jerry',
    store: fixture.store,
    buildCanonicalCatalog: async () => makeCatalog(),
    resolveCanonicalTarget: resolveBrain,
    resolveOwnedRunTarget: async () => ownedRunTarget(),
    operationAuthority: POLICIES,
    authorizeBrainOperation,
    worker: fixture.worker,
    sourcePins: {
      async pin(root) { const descriptor = validDescriptor(root); return { descriptor, digest: descriptorDigest(descriptor) }; },
      async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
      async releaseOperationPins() {},
    },
    scratchQuotaFactory: async () => ({
      async claim() {}, async release() {}, async reconcile() { return {}; },
      async assertOperationRoot() { return true; }, async close() {},
    }),
    operationModelResolver: async ({ requestParameters }) => requestParameters,
    capabilityIssuer: ({ purpose }) => `resume-${purpose}-${Math.random()}`,
    clock: { now: () => fixture.timers.now },
    timers: fixture.timers,
    limits: {
      heartbeatMs: 10_000,
      eventSilenceMs: 60_000,
      executionDeadlineMsByType: { ...DEFAULT_EXECUTION_DEADLINES_MS, query: 60_000 },
    },
  });
  t.after(() => resumed.stop());
  await resumed.reconcile();
  const failed = await waitForState(fixture, operation.operationId, 'failed');
  assert.equal(failed.error.code, 'provider_stalled');
  assert.equal(failed.error.providerCallId, 'query');
});

test('reconciliation terminalizes a duplicate active-provider snapshot and releases its pin', async (t) => {
  const fixture = makeFixture(t, { executionDeadlineMsByType: { pgs: 60_000 } });
  const operation = await fixture.coordinator.start(request({
    requestId: 'duplicate-provider-snapshot',
    operationType: 'pgs',
    parameters: { query: 'canary' },
  }));
  await fixture.coordinator.stop();
  fixture.worker.records.get(operation.operationId).activeProviderCalls = [
    { providerCallId: 'pgs:unit-1', providerStallMs: 5_000, idleMs: 10 },
    { providerCallId: 'pgs:unit-1', providerStallMs: 5_000, idleMs: 20 },
  ];

  const resumed = makeFixture(t, {
    store: fixture.store,
    worker: fixture.worker,
    timers: fixture.timers,
    executionDeadlineMsByType: { pgs: 60_000 },
  });
  await resumed.coordinator.reconcile();
  const failed = await fixture.store.get(operation.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'provider_contract_invalid');
  assert.equal(failed.error.retryable, true);
  assert.equal(typeof failed.sourcePinReleasedAt, 'string');
});

test('reattachment replays retained historical provider events without dropping evidence or double-selecting', async (t) => {
  const fixture = makeFixture(t, { executionDeadlineMsByType: { query: 60_000 } });
  const operation = await fixture.coordinator.start(request({ requestId: 'reattach-undurable-provider' }));
  await fixture.coordinator.stop();
  fixture.worker.emit(operation.operationId, {
    type: 'provider_selected', providerCallId: 'query', providerStallMs: 5_000,
  });

  const resumed = makeFixture(t, {
    store: fixture.store,
    worker: fixture.worker,
    timers: fixture.timers,
    executionDeadlineMsByType: { query: 60_000 },
  });
  await resumed.coordinator.reconcile();
  await eventually(async () => {
    const current = await fixture.store.get(operation.operationId);
    assert.equal(current.state, 'running');
    const rows = await fixture.store.readEvents(operation.operationId, 0);
    assert.equal(rows.some(({ type }) => type === 'provider_selected'), true);
    assert.equal(rows.some(({ type }) => type === 'event_gap'), false);
  });
  fixture.worker.emit(operation.operationId, {
    type: 'provider_activity', providerCallId: 'query',
  });
  await eventually(async () => {
    assert.equal((await fixture.store.get(operation.operationId)).lastProviderActivityAt !== null, true);
  });
});

test('hard execution deadline cancels independently of activity and explicit cancel propagates', async (t) => {
  const fixture = makeFixture(t, {
    executionDeadlineMsByType: { query: 100, pgs: 500 },
  });
  const timed = await fixture.coordinator.start(request());
  fixture.worker.emit(timed.operationId, { type: 'progress', completed: 1 });
  await fixture.timers.advance(100);
  const failed = await waitForState(fixture, timed.operationId, 'failed');
  assert.equal(failed.error.code, 'operation_timeout');
  assert.equal(fixture.worker.cancelCalls.some(({ operationId }) => operationId === timed.operationId), true);

  const explicit = await fixture.coordinator.start(request({ requestId: 'cancel-me' }));
  const cancelled = await fixture.coordinator.cancel(explicit.operationId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(fixture.worker.cancelCalls.some(({ operationId }) => operationId === explicit.operationId), true);
  fixture.worker.finish(explicit.operationId, {
    state: 'complete', result: { tooLate: true }, error: null, sourceEvidence: null,
  });
  await flush(20);
  assert.equal((await fixture.store.get(explicit.operationId)).state, 'cancelled');
});

test('durable cancellation does not wait forever for a stuck worker control response', async (t) => {
  class StuckCancelWorker extends ControlledWorker {
    constructor() {
      super();
      this.cancelGate = deferred();
    }

    async cancel(operationId, capability) {
      this.cancelCalls.push({ operationId, capability });
      return this.cancelGate.promise;
    }
  }
  const worker = new StuckCancelWorker();
  const fixture = makeFixture(t, { worker });
  t.after(() => {
    const record = worker.records.values().next().value;
    if (record) worker.cancelGate.resolve(worker.publicRecord(record));
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'stuck-worker-cancel',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  let settled = false;
  const cancelling = fixture.coordinator.cancel(operation.operationId)
    .then((record) => { settled = true; return record; });
  await eventually(() => assert.equal(settled, true), 10_000);
  const cancelled = await cancelling;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(worker.cancelCalls.length, 1);
});

test('claim-first synthesis cancellation yields to the durable committed result', async (t) => {
  let committedState = synthesisStateFromClaim(synthesisCompletion(`brop_${'8'.repeat(32)}`, {
    generationMarker: `generation-1-${'8'.repeat(24)}`,
    brainStateSha256: `sha256:${'8'.repeat(64)}`,
  }));
  const fixture = makeFixture(t, {
    readSynthesisState: async () => committedState,
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-claim-first-cancel',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  const claim = synthesisCompletion(operation.operationId);
  await fixture.store.claimSynthesisCompletion(operation.operationId, claim);

  const pending = await fixture.coordinator.cancel(operation.operationId);
  assert.equal(pending.state, 'running');
  assert.equal(fixture.worker.cancelCalls.length, 0);

  committedState = synthesisStateFromClaim(claim);
  const complete = await fixture.coordinator.cancel(operation.operationId);
  assert.equal(complete.state, 'complete');
  assert.deepEqual(complete.result, synthesisResultFromClaim(claim));
  assert.equal(fixture.worker.cancelCalls.length, 0);
});

test('a claim racing between cancellation read and terminal CAS still wins cleanly', async (t) => {
  const fixture = makeFixture(t, { readSynthesisState: async () => null });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-claim-cancel-interleave',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  const transitionEntered = deferred();
  const releaseTransition = deferred();
  const originalTransition = fixture.store.transition.bind(fixture.store);
  fixture.store.transition = async (operationId, input) => {
    if (operationId === operation.operationId && input.state === 'cancelled') {
      transitionEntered.resolve();
      await releaseTransition.promise;
    }
    return originalTransition(operationId, input);
  };

  const cancelling = fixture.coordinator.cancel(operation.operationId);
  await transitionEntered.promise;
  await fixture.store.claimSynthesisCompletion(
    operation.operationId,
    synthesisCompletion(operation.operationId),
  );
  releaseTransition.resolve();
  const winner = await cancelling;
  assert.equal(winner.state, 'running');
  assert.equal(fixture.worker.cancelCalls.length, 0);
});

test('restart reconciliation completes exact synthesis claims before generic worker interruption', async (t) => {
  let committedState = null;
  const fixture = makeFixture(t, { readSynthesisState: async () => committedState });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-crash-after-rename',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  const claim = synthesisCompletion(operation.operationId);
  await fixture.store.claimSynthesisCompletion(operation.operationId, claim);
  committedState = synthesisStateFromClaim(claim);
  await fixture.coordinator.stop();
  fixture.worker.records.delete(operation.operationId);

  const resumed = makeFixture(t, {
    store: fixture.store,
    worker: fixture.worker,
    timers: fixture.timers,
    readSynthesisState: async () => committedState,
  });
  await resumed.coordinator.reconcile();
  const complete = await fixture.store.get(operation.operationId);
  assert.equal(complete.state, 'complete');
  assert.deepEqual(complete.result, synthesisResultFromClaim(claim));
  assert.equal(complete.error, null);
});

test('restart reconciliation keeps missing, prior, and mismatched claimed synthesis state honest', async (t) => {
  for (const scenario of ['missing', 'prior', 'mismatched']) {
    await t.test(scenario, async (subtest) => {
      let committedState = null;
      const fixture = makeFixture(subtest, { readSynthesisState: async () => committedState });
      const operation = await fixture.coordinator.start(request({
        requestId: `synthesis-recovery-${scenario}`,
        operationType: 'synthesis',
        parameters: { trigger: 'manual' },
      }));
      const claim = synthesisCompletion(operation.operationId);
      await fixture.store.claimSynthesisCompletion(operation.operationId, claim);
      if (scenario === 'prior') {
        committedState = synthesisStateFromClaim(synthesisCompletion(
          `brop_${'9'.repeat(32)}`,
          {
            generationMarker: `generation-prior-${'d'.repeat(24)}`,
            generatedAt: '2026-07-09T16:00:00.000Z',
            brainStateSha256: `sha256:${'d'.repeat(64)}`,
          },
        ));
      } else if (scenario === 'mismatched') {
        committedState = synthesisStateFromClaim({
          ...claim,
          brainStateSha256: `sha256:${'c'.repeat(64)}`,
        });
      }
      await fixture.coordinator.stop();
      fixture.worker.records.delete(operation.operationId);
      const resumed = makeFixture(subtest, {
        store: fixture.store,
        worker: fixture.worker,
        timers: fixture.timers,
        readSynthesisState: async () => committedState,
      });
      await resumed.coordinator.reconcile();
      const terminal = await fixture.store.get(operation.operationId);
      assert.equal(terminal.state, scenario === 'mismatched' ? 'failed' : 'interrupted');
      assert.equal(
        terminal.error.code,
        scenario === 'mismatched' ? 'synthesis_commit_mismatch' : 'synthesis_commit_missing',
      );
      assert.equal(terminal.result, null);
    });
  }
});

test('a synthesis worker completing before the event pump reconciles from claim plus state', async (t) => {
  let committedState = null;
  const fixture = makeFixture(t, { readSynthesisState: async () => committedState });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-worker-before-pump',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  const claim = synthesisCompletion(operation.operationId);
  await fixture.store.claimSynthesisCompletion(operation.operationId, claim);
  committedState = synthesisStateFromClaim(claim);
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { untrusted: 'worker copy must not win' },
    resultArtifact: null,
    error: null,
    sourceEvidence: {},
  }, { emit: false });

  const complete = await fixture.coordinator.status(operation.operationId);
  assert.equal(complete.state, 'complete');
  assert.deepEqual(complete.result, synthesisResultFromClaim(claim));
});

test('worker completion cannot terminalize a mismatched claimed synthesis state as complete', async (t) => {
  let committedState = null;
  const fixture = makeFixture(t, { readSynthesisState: async () => committedState });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-worker-mismatch',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  const claim = synthesisCompletion(operation.operationId);
  await fixture.store.claimSynthesisCompletion(operation.operationId, claim);
  committedState = synthesisStateFromClaim({
    ...claim,
    brainStateSha256: `sha256:${'c'.repeat(64)}`,
  });
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: synthesisResultFromClaim(claim),
    resultArtifact: null,
    error: null,
    sourceEvidence: {},
  }, { emit: false });

  const failed = await fixture.coordinator.status(operation.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'synthesis_commit_mismatch');
  assert.equal(failed.result, null);
});

test('a claimed synthesis with no committed state terminalizes at its hard deadline', async (t) => {
  const fixture = makeFixture(t, {
    readSynthesisState: async () => null,
    executionDeadlineMsByType: { synthesis: 100 },
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-claim-hard-timeout',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  await fixture.store.claimSynthesisCompletion(
    operation.operationId,
    synthesisCompletion(operation.operationId),
  );
  await fixture.timers.advance(100);
  const failed = await fixture.store.get(operation.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'operation_timeout');
  assert.equal(failed.result, null);
  assert.equal(fixture.worker.cancelCalls.length, 1);
});

test('hard deadline reconciles a committed synthesis claim before timing out', async (t) => {
  let committedState = null;
  const fixture = makeFixture(t, {
    readSynthesisState: async () => committedState,
    executionDeadlineMsByType: { synthesis: 100 },
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-claim-hard-deadline-race',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  const claim = synthesisCompletion(operation.operationId);
  assert.deepEqual(
    await fixture.store.claimSynthesisCompletion(operation.operationId, claim),
    claim,
  );
  committedState = synthesisStateFromClaim(claim);
  await fixture.timers.advance(100);
  const terminal = await fixture.store.get(operation.operationId);

  assert.equal(terminal.state, 'complete');
  assert.equal(terminal.error, null);
  assert.deepEqual(terminal.result, synthesisResultFromClaim(claim));
  assert.equal(fixture.worker.cancelCalls.length, 0);
});

test('a typed worker commit failure survives before its claim replaces the prior state', async (t) => {
  const prior = synthesisStateFromClaim(synthesisCompletion(`brop_${'7'.repeat(32)}`, {
    generationMarker: `generation-1-${'7'.repeat(24)}`,
    brainStateSha256: `sha256:${'7'.repeat(64)}`,
  }));
  const fixture = makeFixture(t, { readSynthesisState: async () => prior });
  const operation = await fixture.coordinator.start(request({
    requestId: 'synthesis-claim-worker-failed',
    operationType: 'synthesis',
    parameters: { trigger: 'manual' },
  }));
  await fixture.store.claimSynthesisCompletion(
    operation.operationId,
    synthesisCompletion(operation.operationId),
  );
  fixture.worker.finish(operation.operationId, {
    state: 'failed',
    result: null,
    resultArtifact: null,
    error: {
      code: 'synthesis_commit_failed', message: 'state readback failed', retryable: false,
    },
    sourceEvidence: {},
  }, { emit: false });
  const failed = await fixture.coordinator.status(operation.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'synthesis_commit_failed');
  assert.equal(failed.error.retryable, false);
});

test('terminal transitions release requester source pins once across duplicate callbacks and reconciliation', async (t) => {
  for (const state of ['complete', 'partial', 'failed', 'cancelled']) {
    const fixture = makeFixture(t);
    const operation = await fixture.coordinator.start(request({ requestId: `terminal-${state}` }));
    const envelope = {
      state,
      result: state === 'cancelled' ? null : { state },
      error: state === 'failed'
        ? { code: 'provider_failed', message: 'failed', retryable: true }
        : null,
      sourceEvidence: { baseRevision: 1 },
    };
    fixture.worker.finish(operation.operationId, envelope);
    await Promise.all(Array.from({ length: 32 }, () =>
      fixture.coordinator.status(operation.operationId)));
    await waitForState(fixture, operation.operationId, state);
    await fixture.coordinator.reconcile();
    await fixture.coordinator.reconcile();
    const record = await fixture.store.get(operation.operationId);
    assert.equal(typeof record.sourcePinReleasedAt, 'string', state);
    assert.equal(fixture.counters.releaseCalls, 1, state);
    assert.equal(fixture.counters.releaseVisible.size, 1, state);
  }
});

test('reconciliation repairs create/pin/attach/start windows and interrupts an unprovable worker', async (t) => {
  const fixture = makeFixture(t);
  const created = await directQueuedRecord(fixture, { requestId: 'crash-before-pin' });
  await fixture.coordinator.reconcile();
  const running = await waitForState(fixture, created.record.operationId, 'running');
  assert.equal(running.sourcePinDescriptor.version, 1);
  assert.equal(fixture.counters.pin, 1);
  assert.equal(fixture.worker.startCalls.length, 1);

  const attachedOnly = await directQueuedRecord(fixture, { requestId: 'crash-after-attach' });
  const attachedDescriptor = validDescriptor('/brains/jerry');
  await fixture.store.attachSourcePin(attachedOnly.record.operationId, {
    expectedVersion: attachedOnly.record.recordVersion,
    descriptor: attachedDescriptor,
    digest: descriptorDigest(attachedDescriptor),
  });
  await fixture.coordinator.reconcile();
  await waitForState(fixture, attachedOnly.record.operationId, 'running');
  assert.equal(fixture.counters.pin, 1);
  assert.equal(fixture.worker.startCalls.length, 2);

  const orphan = await directQueuedRecord(fixture, { requestId: 'orphan' });
  const descriptor = validDescriptor('/brains/jerry');
  let orphanRecord = await fixture.store.attachSourcePin(orphan.record.operationId, {
    expectedVersion: orphan.record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  orphanRecord = await fixture.store.setWorker(orphan.record.operationId, {
    expectedVersion: orphanRecord.recordVersion,
    worker: {
      version: 1,
      workerId: `missing-${orphan.record.operationId}`,
      workerType: 'cosmo',
      operationType: 'query',
    },
  });
  await fixture.store.transition(orphan.record.operationId, {
    expectedVersion: orphanRecord.recordVersion,
    state: 'running',
    phase: 'executing',
    error: null,
    sourceEvidence: null,
  });
  await fixture.coordinator.reconcile();
  const interrupted = await waitForState(fixture, orphan.record.operationId, 'interrupted');
  assert.equal(interrupted.error.retryable, true);
  assert.equal(interrupted.error.code, 'worker_interrupted');
  assert.equal(typeof interrupted.sourcePinReleasedAt, 'string');
  assert.equal(fixture.counters.releaseCalls, 1);
});

test('shutdown racing reconciliation cannot create post-stop runtime or source work', async (t) => {
  const fixture = makeFixture(t);
  const created = await directQueuedRecord(fixture, { requestId: 'reconcile-stop-race' });
  const entered = deferred();
  const gate = deferred();
  const storeGet = fixture.store.get.bind(fixture.store);
  let blocked = false;
  fixture.store.get = async (operationId) => {
    if (!blocked && operationId === created.record.operationId) {
      blocked = true;
      entered.resolve();
      await gate.promise;
    }
    return storeGet(operationId);
  };

  const reconciling = fixture.coordinator.reconcile();
  await entered.promise;
  await fixture.coordinator.stop();
  gate.resolve();

  await assert.rejects(reconciling, typedCode('coordinator_stopped'));
  assert.equal(fixture.coordinator.runtimes.size, 0);
  assert.equal(fixture.counters.pin, 0);
  assert.equal(fixture.worker.startCalls.length, 0);
  assert.equal((await storeGet(created.record.operationId)).state, 'queued');
});

test('reconciliation releases a pre-existing terminal pin marker exactly once', async (t) => {
  const fixture = makeFixture(t);
  const created = await directQueuedRecord(fixture, { requestId: 'terminal-pin-pending' });
  const descriptor = validDescriptor('/brains/jerry');
  let record = await fixture.store.attachSourcePin(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  record = await fixture.store.transition(record.operationId, {
    expectedVersion: record.recordVersion,
    state: 'interrupted',
    phase: 'terminal',
    error: { code: 'worker_interrupted', message: 'orphaned', retryable: true },
    sourceEvidence: null,
  });
  assert.equal(record.sourcePinReleasedAt, null);
  await Promise.all(Array.from({ length: 32 }, () => fixture.coordinator.reconcile()));
  await fixture.coordinator.reconcile();
  const released = await fixture.store.get(record.operationId);
  assert.equal(typeof released.sourcePinReleasedAt, 'string');
  assert.equal(fixture.counters.releaseCalls, 1);
  assert.equal(fixture.counters.releaseVisible.size, 1);
});

test('reconciliation releases an expired terminal pin with fresh cleanup authority', async (t) => {
  let releaseControl = null;
  const sourcePins = {
    async pin() { throw new Error('terminal reconciliation must not repin'); },
    async openPinnedSource(descriptor) { return pinnedSourceHandle(descriptor); },
    async releaseOperationPins(_operationId, capability) {
      releaseControl = readDurableOperationLockCapability(capability);
    },
  };
  const fixture = makeFixture(t, { sourcePins });
  const hardDeadlineAt = new Date(fixture.timers.now - 1).toISOString();
  const created = await directQueuedRecord(fixture, {
    requestId: 'expired-terminal-pin-pending',
    parameters: { query: 'canary', operationControl: { hardDeadlineAt } },
  });
  const descriptor = validDescriptor('/brains/jerry');
  let record = await fixture.store.attachSourcePin(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  record = await fixture.store.transition(record.operationId, {
    expectedVersion: record.recordVersion,
    state: 'failed',
    phase: 'terminal',
    error: { code: 'operation_timeout', message: 'expired', retryable: true },
    sourceEvidence: null,
  });

  await fixture.coordinator.reconcile();
  const released = await fixture.store.get(record.operationId);
  assert.equal(typeof released.sourcePinReleasedAt, 'string');
  assert.equal(releaseControl.hardDeadlineAt, hardDeadlineAt);
  assert.equal(releaseControl.signal, null);
  assert.equal(releaseControl.cleanupSignal, null);
});

test('queued record without durable operationControl deadline is interrupted before worker work', async (t) => {
  const fixture = makeFixture(t);
  const old = await directQueuedRecord(fixture, {
    requestId: 'old-record',
    parameters: { query: 'canary' },
  });
  await fixture.coordinator.reconcile();
  const interrupted = await waitForState(fixture, old.record.operationId, 'interrupted');
  assert.equal(interrupted.error.code, 'operation_recovery_invalid');
  assert.equal(fixture.worker.startCalls.length, 0);
});

test('reconciliation expires a queued operation before pin, capability, or worker work', async (t) => {
  const fixture = makeFixture(t);
  const expired = await directQueuedRecord(fixture, {
    requestId: 'expired-record',
    parameters: {
      query: 'canary',
      operationControl: {
        hardDeadlineAt: new Date(fixture.timers.now - 1).toISOString(),
      },
    },
  });
  await fixture.coordinator.reconcile();
  const failed = await waitForState(fixture, expired.record.operationId, 'failed');
  assert.equal(failed.error.code, 'operation_timeout');
  assert.equal(fixture.counters.pin, 0);
  assert.equal(fixture.counters.open, 0);
  assert.equal(fixture.counters.capabilities.length, 0);
  assert.equal(fixture.worker.startCalls.length, 0);
});

test('expired pinned recovery cancels a live worker from the pre-reference crash window', async (t) => {
  const fixture = makeFixture(t);
  const expired = await directQueuedRecord(fixture, {
    requestId: 'expired-live-unassigned-worker',
    parameters: {
      query: 'canary',
      operationControl: {
        hardDeadlineAt: new Date(fixture.timers.now - 1).toISOString(),
      },
    },
  });
  const descriptor = validDescriptor('/brains/jerry');
  await fixture.store.attachSourcePin(expired.record.operationId, {
    expectedVersion: expired.record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  fixture.worker.records.set(expired.record.operationId, {
    reference: {
      version: 1,
      workerId: `worker-${expired.record.operationId}`,
      workerType: 'cosmo',
      operationType: 'query',
    },
    operationId: expired.record.operationId,
    state: 'running',
    phase: 'executing',
    eventSequence: 0,
    activeProviderCalls: [],
    events: [],
    result: null,
  });
  await fixture.coordinator.reconcile();
  const failed = await fixture.store.get(expired.record.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'operation_timeout');
  assert.equal(fixture.worker.cancelCalls.length, 1);
  assert.equal(typeof failed.sourcePinReleasedAt, 'string');
});

test('worker-start failure after durable pin terminalizes failed and releases once', async (t) => {
  const worker = new ControlledWorker();
  const failure = new Error('worker unavailable');
  failure.code = 'worker_unavailable';
  worker.startError = failure;
  const fixture = makeFixture(t, { worker });
  const rejected = await assert.rejects(
    () => fixture.coordinator.start(request()),
    typedCode('worker_unavailable'),
  );
  assert.equal(rejected, undefined);
  const [record] = await fixture.store.list();
  assert.equal(record.state, 'failed');
  assert.equal(record.error.code, 'worker_unavailable');
  assert.equal(fixture.counters.releaseCalls, 1);
  assert.equal(typeof record.sourcePinReleasedAt, 'string');
});

test('source pin attach failure releases an unpublished provider pin, while a lost attach response recovers', async (t) => {
  const unpublished = makeFixture(t);
  unpublished.store.attachSourcePin = async () => {
    const error = new Error('pin status write failed');
    error.code = 'source_pin_write_failed';
    throw error;
  };
  await assert.rejects(
    () => unpublished.coordinator.start(request({ requestId: 'pin-unpublished' })),
    typedCode('source_pin_write_failed'),
  );
  const [failed] = await unpublished.store.list();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.sourcePinDescriptor, null);
  assert.equal(unpublished.counters.releaseCalls, 1);

  const published = makeFixture(t);
  const originalAttach = published.store.attachSourcePin.bind(published.store);
  let first = true;
  published.store.attachSourcePin = async (...args) => {
    const result = await originalAttach(...args);
    if (first) {
      first = false;
      const error = new Error('lost attach response');
      error.code = 'durability_uncertain';
      throw error;
    }
    return result;
  };
  const running = await published.coordinator.start(request({ requestId: 'pin-published' }));
  assert.equal(running.state, 'running');
  assert.equal(running.sourcePinDescriptor.version, 1);
  assert.equal(published.worker.startCalls.length, 1);
  assert.equal(published.counters.releaseCalls, 0);
});

test('worker evidence identity is overwritten from durable authority while watermarks survive', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ target: { agent: 'forrest' } }));
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: { answer: 'ok' },
    error: null,
    sourceEvidence: {
      baseRevision: 3,
      cutoffRevision: 5,
      requesterAgent: 'mallory',
      selectedAgent: 'mallory',
      selectedBrain: 'brain-mallory',
      route: '/forged',
      canonicalRoot: '/brains/mallory',
      brainId: 'brain-mallory',
      ownerAgent: 'mallory',
      target: { brainId: 'brain-mallory', canonicalRoot: '/brains/mallory' },
      capability: 'secret-capability',
      provenance: { cutoffRevision: 5, scratchPath: '/private/worker/path' },
    },
  });
  const record = await waitForState(fixture, operation.operationId, 'complete');
  assert.deepEqual(record.sourceEvidence, enrichSourceEvidence(record, {
    baseRevision: 3,
    cutoffRevision: 5,
    requesterAgent: 'mallory',
    selectedAgent: 'mallory',
    selectedBrain: 'brain-mallory',
    route: '/forged',
    canonicalRoot: '/brains/mallory',
    brainId: 'brain-mallory',
    ownerAgent: 'mallory',
    target: { brainId: 'brain-mallory', canonicalRoot: '/brains/mallory' },
    capability: 'secret-capability',
    provenance: { cutoffRevision: 5, scratchPath: '/private/worker/path' },
  }));
  assert.equal(record.sourceEvidence.requesterAgent, 'jerry');
  assert.equal(record.sourceEvidence.selectedAgent, 'forrest');
  assert.equal(record.sourceEvidence.selectedBrain, 'brain-forrest');
  assert.equal(record.sourceEvidence.baseRevision, 3);
  assert.equal(Object.hasOwn(record.sourceEvidence, 'canonicalRoot'), false);
  assert.equal(Object.hasOwn(record.sourceEvidence, 'brainId'), false);
  assert.equal(Object.hasOwn(record.sourceEvidence, 'ownerAgent'), false);
  assert.equal(Object.hasOwn(record.sourceEvidence, 'target'), false);
  assert.equal(Object.hasOwn(record.sourceEvidence, 'capability'), false);
  assert.deepEqual(record.sourceEvidence.provenance, { cutoffRevision: 5 });
});

test('ordinary result commits before terminal transition using the returned version', async (t) => {
  const fixture = makeFixture(t);
  const calls = [];
  const originalSetResult = fixture.store.setResult.bind(fixture.store);
  const originalTransition = fixture.store.transition.bind(fixture.store);
  fixture.store.setResult = async (...args) => {
    calls.push(['setResult', args[1].expectedVersion]);
    return originalSetResult(...args);
  };
  fixture.store.transition = async (...args) => {
    calls.push(['transition', args[1].expectedVersion, args[1].state]);
    return originalTransition(...args);
  };
  const operation = await fixture.coordinator.start(request());
  fixture.worker.finish(operation.operationId, {
    state: 'complete', result: { answer: 'canonical' }, error: null, sourceEvidence: {},
  });
  const completed = await waitForState(fixture, operation.operationId, 'complete');
  const resultCall = calls.find(([name]) => name === 'setResult');
  const completeCall = calls.find(([name, , state]) => name === 'transition' && state === 'complete');
  assert.ok(resultCall);
  assert.ok(completeCall);
  assert.equal(completeCall[1], resultCall[1] + 1);
  assert.deepEqual(await fixture.store.getResult(operation.operationId, {
    requesterAgent: 'jerry', resultHandle: completed.resultHandle,
  }), { answer: 'canonical' });
});

test('lost result publication responses reload durable JSON and artifact state before terminal transition', async (t) => {
  const jsonFixture = makeFixture(t);
  const jsonOperation = await jsonFixture.coordinator.start(request({ requestId: 'json-publication-lost' }));
  const originalSet = jsonFixture.store.setResult.bind(jsonFixture.store);
  let setCalls = 0;
  jsonFixture.store.setResult = async (...args) => {
    setCalls += 1;
    await originalSet(...args);
    const error = new Error('lost result response');
    error.code = 'durability_uncertain';
    error.published = true;
    throw error;
  };
  jsonFixture.worker.finish(jsonOperation.operationId, {
    state: 'complete', result: { answer: 'durable' }, error: null, sourceEvidence: {},
  });
  const jsonComplete = await waitForState(jsonFixture, jsonOperation.operationId, 'complete');
  assert.equal(setCalls, 1);
  assert.deepEqual(jsonComplete.result, { answer: 'durable' });

  const artifactFixture = makeFixture(t);
  const artifactOperation = await artifactFixture.coordinator.start(request({
    requestId: 'artifact-publication-lost',
    operationType: 'graph_export',
    parameters: { format: 'jsonl' },
  }));
  const scratch = path.join(
    artifactFixture.root, 'operations', artifactOperation.operationId, 'scratch',
  );
  const artifactPath = path.join(scratch, 'lost.jsonl');
  const bytes = Buffer.from('{"durable":true}\n');
  fs.writeFileSync(artifactPath, bytes);
  const originalAdopt = artifactFixture.store.adoptResultArtifact.bind(artifactFixture.store);
  let adoptCalls = 0;
  artifactFixture.store.adoptResultArtifact = async (...args) => {
    adoptCalls += 1;
    await originalAdopt(...args);
    const error = new Error('lost artifact response');
    error.code = 'durability_uncertain';
    error.published = true;
    throw error;
  };
  artifactFixture.worker.finish(artifactOperation.operationId, {
    state: 'complete',
    result: null,
    resultArtifact: {
      scratchPath: artifactPath,
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
    error: null,
    sourceEvidence: {},
  });
  const artifactComplete = await waitForState(
    artifactFixture,
    artifactOperation.operationId,
    'complete',
  );
  assert.equal(adoptCalls, 1);
  assert.match(artifactComplete.resultHandle, /^brres_/);
});

test('lost terminal transition response reloads terminal truth and still releases its pin', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'terminal-response-lost' }));
  const originalTransition = fixture.store.transition.bind(fixture.store);
  let injected = false;
  fixture.store.transition = async (...args) => {
    const result = await originalTransition(...args);
    if (!injected && args[1].state === 'complete') {
      injected = true;
      const error = new Error('lost terminal response');
      error.code = 'durability_uncertain';
      error.published = true;
      throw error;
    }
    return result;
  };
  fixture.worker.finish(operation.operationId, {
    state: 'complete', result: { answer: 'complete' }, error: null, sourceEvidence: {},
  });
  const completed = await waitForState(fixture, operation.operationId, 'complete');
  await eventually(async () => {
    const reloaded = await fixture.store.get(operation.operationId);
    assert.equal(typeof reloaded.sourcePinReleasedAt, 'string');
  });
  assert.equal(completed.state, 'complete');
  assert.equal(fixture.counters.releaseCalls, 1);
});

test('interrupted worker result is a truthful terminal result and releases its pin', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({ requestId: 'worker-interrupted' }));
  fixture.worker.finish(operation.operationId, {
    state: 'interrupted',
    result: null,
    resultArtifact: null,
    error: { code: 'worker_interrupted', message: 'COSMO restarted', retryable: true },
    sourceEvidence: {},
  });
  const interrupted = await waitForState(fixture, operation.operationId, 'interrupted');
  assert.equal(interrupted.error.code, 'worker_interrupted');
  assert.equal(interrupted.error.retryable, true);
  await eventually(async () => {
    const reloaded = await fixture.store.get(operation.operationId);
    assert.equal(typeof reloaded.sourcePinReleasedAt, 'string');
  });
  assert.equal(fixture.counters.releaseCalls, 1);
});

test('graph artifact adopts before terminal visibility and invalid artifacts cannot expose handles', async (t) => {
  const fixture = makeFixture(t);
  const calls = [];
  const originalAdopt = fixture.store.adoptResultArtifact.bind(fixture.store);
  const originalTransition = fixture.store.transition.bind(fixture.store);
  fixture.store.adoptResultArtifact = async (...args) => {
    calls.push(['adopt', args[1].expectedVersion]);
    return originalAdopt(...args);
  };
  fixture.store.transition = async (...args) => {
    calls.push(['transition', args[1].expectedVersion, args[1].state]);
    return originalTransition(...args);
  };
  const operation = await fixture.coordinator.start(request({
    requestId: 'graph-export', operationType: 'graph_export', parameters: { format: 'jsonl' },
  }));
  calls.length = 0;
  const scratch = path.join(fixture.root, 'operations', operation.operationId, 'scratch');
  const artifactPath = path.join(scratch, 'graph.jsonl');
  const bytes = Buffer.from('{"node":1}\n');
  fs.writeFileSync(artifactPath, bytes);
  fixture.worker.finish(operation.operationId, {
    state: 'complete',
    result: null,
    resultArtifact: {
      scratchPath: artifactPath,
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
    error: null,
    sourceEvidence: {},
  });
  const completed = await waitForState(fixture, operation.operationId, 'complete');
  assert.equal(calls[0][0], 'adopt');
  assert.deepEqual(calls[1], ['transition', calls[0][1] + 1, 'complete']);
  assert.match(completed.resultHandle, /^brres_/);
  assert.equal(completed.result, null);
  assert.equal(Object.hasOwn(completed.resultArtifact, 'scratchPath'), false);

  const invalid = await fixture.coordinator.start(request({
    requestId: 'graph-invalid', operationType: 'graph_export', parameters: { format: 'jsonl' },
  }));
  fixture.worker.finish(invalid.operationId, {
    state: 'complete',
    result: null,
    resultArtifact: {
      scratchPath: path.join(fixture.root, 'outside.jsonl'),
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes: 1,
      sha256: '0'.repeat(64),
    },
    error: null,
    sourceEvidence: {},
  });
  const failed = await waitForState(fixture, invalid.operationId, 'failed');
  assert.equal(failed.error.code, 'worker_result_invalid');
  assert.equal(failed.resultHandle, null);
});

test('artifact envelope rejects result-plus-artifact, encoding mismatch, non-graph use, and symlinks', async (t) => {
  const cases = [
    {
      name: 'result-plus-artifact',
      operationType: 'graph_export',
      result: { answer: 'not allowed' },
      mutate: (descriptor) => descriptor,
    },
    {
      name: 'gzip',
      operationType: 'graph_export',
      result: null,
      mutate: (descriptor) => ({ ...descriptor, contentEncoding: 'gzip' }),
    },
    {
      name: 'non-graph',
      operationType: 'query',
      result: null,
      mutate: (descriptor) => descriptor,
    },
    {
      name: 'symlink',
      operationType: 'graph_export',
      result: null,
      symlink: true,
      mutate: (descriptor) => descriptor,
    },
  ];
  for (const entry of cases) {
    const fixture = makeFixture(t);
    const operation = await fixture.coordinator.start(request({
      requestId: `artifact-${entry.name}`,
      operationType: entry.operationType,
      parameters: entry.operationType === 'graph_export' ? { format: 'jsonl' } : { query: 'canary' },
    }));
    const scratch = path.join(fixture.root, 'operations', operation.operationId, 'scratch');
    const realPath = path.join(scratch, 'real.jsonl');
    const bytes = Buffer.from('{"node":1}\n');
    fs.writeFileSync(realPath, bytes);
    let scratchPath = realPath;
    if (entry.symlink) {
      scratchPath = path.join(scratch, 'link.jsonl');
      fs.symlinkSync(realPath, scratchPath);
    }
    const descriptor = entry.mutate({
      scratchPath,
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    fixture.worker.finish(operation.operationId, {
      state: 'complete',
      result: entry.result,
      resultArtifact: descriptor,
      error: null,
      sourceEvidence: {},
    });
    const failed = await waitForState(fixture, operation.operationId, 'failed');
    assert.equal(failed.error.code, 'worker_result_invalid', entry.name);
    assert.equal(failed.resultHandle, null, entry.name);
  }
});

test('reconciliation terminalizes an already adopted graph artifact without adopting twice', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'graph-recover', operationType: 'graph_export', parameters: { format: 'jsonl' },
  }));
  await fixture.coordinator.stop();
  let record = await fixture.store.get(operation.operationId);
  const scratch = path.join(fixture.root, 'operations', operation.operationId, 'scratch');
  const artifactPath = path.join(scratch, 'recover.jsonl');
  const bytes = Buffer.from('{"recovered":true}\n');
  fs.writeFileSync(artifactPath, bytes);
  const descriptor = {
    scratchPath: artifactPath,
    mediaType: 'application/x-ndjson',
    contentEncoding: 'identity',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  record = await fixture.store.adoptResultArtifact(operation.operationId, {
    expectedVersion: record.recordVersion,
    ...descriptor,
  });
  fixture.worker.finish(operation.operationId, {
    state: 'complete', result: null, resultArtifact: descriptor, error: null, sourceEvidence: {},
  }, { emit: false });

  let adoptionCalls = 0;
  const originalAdopt = fixture.store.adoptResultArtifact.bind(fixture.store);
  fixture.store.adoptResultArtifact = async (...args) => {
    adoptionCalls += 1;
    return originalAdopt(...args);
  };
  const resumed = makeFixture(t, {
    store: fixture.store,
    worker: fixture.worker,
    timers: fixture.timers,
  });
  await resumed.coordinator.reconcile();
  const completed = await waitForState(fixture, operation.operationId, 'complete');
  assert.equal(adoptionCalls, 0);
  assert.equal(completed.resultHandle, record.resultHandle);
});

test('every worker call receives a fresh capability token', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request());
  await fixture.coordinator.status(operation.operationId);
  await fixture.coordinator.cancel(operation.operationId);
  const tokens = fixture.counters.capabilities.map(({ token }) => token);
  assert.equal(tokens.length >= 3, true);
  assert.equal(new Set(tokens).size, tokens.length);
  assert.equal(fixture.counters.capabilities.some(({ purpose }) => purpose === 'start'), true);
  assert.equal(fixture.counters.capabilities.some(({ purpose }) => purpose === 'status'), true);
  assert.equal(fixture.counters.capabilities.some(({ purpose }) => purpose === 'cancel'), true);
});

test('terminal result reads receive distinct result and status-recovery capabilities', async (t) => {
  const fixture = makeFixture(t);
  const operation = await fixture.coordinator.start(request({
    requestId: 'result-recovery-capability',
  }));
  fixture.worker.finish(operation.operationId, {
    state: 'complete', result: { answer: 'done' }, resultArtifact: null,
    error: null, sourceEvidence: {},
  });
  await waitForState(fixture, operation.operationId, 'complete');

  assert.equal(fixture.worker.resultCalls.length, 1);
  const [call] = fixture.worker.resultCalls;
  assert.equal(typeof call.capability, 'string');
  assert.equal(typeof call.statusCapability, 'string');
  assert.notEqual(call.capability, call.statusCapability);
  const issued = fixture.counters.capabilities.filter(row =>
    [call.capability, call.statusCapability].includes(row.token));
  assert.deepEqual(issued.map(row => row.purpose).sort(), ['result', 'result_status']);
});

test('coordinator export rejects identity overrides and preserves its requester binding', async (t) => {
  const calls = [];
  const fixture = makeFixture(t, {
    exporter: {
      async exportResult(input) { calls.push(input); return { exportHandle: 'brexp_test' }; },
    },
  });
  const operation = await fixture.coordinator.start(request({
    requestId: 'export-binding',
    operationType: 'research_launch',
    parameters: { topic: 'canary' },
  }));
  await assert.rejects(
    () => fixture.coordinator.exportResult(operation.operationId, {
      requesterAgent: 'mallory',
      operationId: `brop_${'0'.repeat(32)}`,
      resultHandle: 'brres_test',
      format: 'json',
      fileName: 'result.json',
    }),
    typedCode('invalid_request'),
  );
  assert.equal(calls.length, 0);
  await fixture.coordinator.exportResult(operation.operationId, {
    resultHandle: 'brres_test', format: 'json', fileName: 'result.json',
  });
  assert.deepEqual(calls[0], {
    resultHandle: 'brres_test',
    format: 'json',
    fileName: 'result.json',
    requesterAgent: 'jerry',
    operationId: operation.operationId,
  });
});

test('worker adapter dispatches exact local executor, strips control metadata, and never falls back', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
    timers,
  });
  t.after(() => adapter.stop?.());
  let queryCalls = 0;
  let compileCalls = 0;
  let sourceReleases = 0;
  let received;
  adapter.registerLocalExecutor('query', async () => {
    queryCalls += 1;
    throw new Error('wrong executor');
  });
  adapter.registerLocalExecutor('research_compile', async (context) => {
    compileCalls += 1;
    received = context;
    context.reportEvent({
      type: 'provider_selected', providerCallId: 'research_compile', providerStallMs: 1_000,
    });
    context.reportEvent({ type: 'provider_call_terminal', providerCallId: 'research_compile' });
    return {
      state: 'complete', result: { compiled: true }, resultArtifact: null,
      error: null, sourceEvidence: { cutoffRevision: 1 },
    };
  });
  const operationId = 'brop_' + 'a'.repeat(32);
  const workerRecord = await adapter.start({
    operationId,
    operationType: 'research_compile',
    requesterAgent: 'jerry',
    target: {
      domain: 'brain', brainId: 'brain-jerry', canonicalRoot: '/brains/jerry',
      accessMode: 'own', ownerAgent: 'jerry', displayName: 'jerry', kind: 'resident',
      lifecycle: 'resident', catalogRevision: 'a'.repeat(64),
      route: '/api/brain/brain-jerry', mutationBoundaries: mutationBoundaries('/brains/jerry'),
    },
    parameters: {
      section: 'summary',
      operationControl: { hardDeadlineAt: new Date(timers.now + 1_000).toISOString() },
    },
    scratchDir: '/tmp/scratch',
    scratchQuota: null,
    sourcePin: { descriptor: validDescriptor(), async release() { sourceReleases += 1; } },
  }, 'cap-start');
  assert.equal(workerRecord.reference.workerType, 'local');
  assert.equal(workerRecord.operationType, 'research_compile');
  await eventually(async () => {
    const status = await adapter.status(operationId, 'cap-status');
    assert.equal(status.state, 'complete');
  });
  assert.equal(queryCalls, 0);
  assert.equal(compileCalls, 1);
  assert.deepEqual(received.parameters, { section: 'summary' });
  assert.equal(received.signal instanceof AbortSignal, true);
  assert.deepEqual((await adapter.result(operationId, 'cap-result')).result, { compiled: true });
  assert.equal(sourceReleases, 1);

  await assert.rejects(
    () => adapter.start({
      operationId: 'brop_' + 'b'.repeat(32),
      operationType: 'research_intelligence',
      requesterAgent: 'jerry',
      target: { domain: 'requester', requesterAgent: 'jerry' },
      parameters: { operationControl: { hardDeadlineAt: new Date(timers.now + 1_000).toISOString() } },
      scratchDir: '/tmp/scratch-2', scratchQuota: null, sourcePin: null,
    }, 'cap-missing'),
    typedCode('executor_unavailable'),
  );
});

test('worker adapter drops heavyweight local context immediately after terminal cleanup', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
  });
  t.after(() => adapter.stop?.());
  let sourceReleases = 0;
  let scratchCloses = 0;
  adapter.registerLocalExecutor('query', async () => ({
    state: 'complete', result: { answer: 'retained' }, resultArtifact: null,
    error: null, sourceEvidence: { cutoffRevision: 1 },
  }));
  const operationId = `brop_${'c'.repeat(32)}`;
  const context = {
    operationId,
    operationType: 'query',
    requesterAgent: 'jerry',
    target: {
      domain: 'brain', brainId: 'brain-jerry', canonicalRoot: '/brains/jerry',
      accessMode: 'own', ownerAgent: 'jerry', displayName: 'jerry', kind: 'resident',
      lifecycle: 'resident', catalogRevision: 'a'.repeat(64),
      route: '/api/brain/brain-jerry', mutationBoundaries: mutationBoundaries('/brains/jerry'),
    },
    parameters: {
      query: 'canary',
      operationControl: { hardDeadlineAt: new Date(timers.now + 1_000).toISOString() },
    },
    scratchDir: '/tmp/scratch-heavy-context',
    scratchQuota: { async close() { scratchCloses += 1; } },
    sourcePin: {
      descriptor: validDescriptor(),
      retainedProjection: Buffer.alloc(1024),
      async release() { sourceReleases += 1; },
    },
  };
  await adapter.start(context, 'cap-start');

  await eventually(async () => {
    assert.equal((await adapter.status(operationId, 'cap-status')).state, 'complete');
    assert.equal(sourceReleases, 1);
    assert.equal(scratchCloses, 1);
  });

  const local = adapter.localRecords.get(operationId);
  assert.equal(local.context, null);
  assert.deepEqual((await adapter.result(operationId, 'cap-result')).result, {
    answer: 'retained',
  });
  assert.equal(adapter.localRecords.has(operationId), true);
  assert.equal((await adapter.start(context, 'cap-replay')).state, 'complete');
  assert.equal(sourceReleases, 1);
  assert.equal(scratchCloses, 1);
});

test('worker adapter releases redundant and rejected local context resources exactly once', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
  });
  t.after(() => adapter.stop?.());
  adapter.registerLocalExecutor('research_launch', async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return {
      state: 'cancelled', result: null, resultArtifact: null,
      error: null, sourceEvidence: null,
    };
  });
  const operationId = `brop_${'d'.repeat(32)}`;
  const counts = new Map();
  const makeResources = (name) => {
    const count = { release: 0, close: 0 };
    counts.set(name, count);
    return {
      sourcePin: {
        descriptor: validDescriptor(),
        async release() { count.release += 1; },
      },
      scratchQuota: { async close() { count.close += 1; } },
    };
  };
  const context = (resources, parameters = { topic: 'canary' }) => ({
    operationId,
    operationType: 'research_launch',
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    parameters: {
      ...parameters,
      operationControl: { hardDeadlineAt: new Date(timers.now + 1_000).toISOString() },
    },
    scratchDir: '/tmp/scratch-resource-retry',
    ...resources,
  });

  const original = makeResources('original');
  await adapter.start(context(original), 'cap-original');
  const duplicate = makeResources('duplicate');
  await adapter.start(context(duplicate), 'cap-duplicate');
  assert.deepEqual(counts.get('duplicate'), { release: 1, close: 1 });
  assert.deepEqual(counts.get('original'), { release: 0, close: 0 });

  const conflicting = makeResources('conflicting');
  await assert.rejects(
    () => adapter.start(context(conflicting, { topic: 'different' }), 'cap-conflict'),
    typedCode('worker_operation_conflict'),
  );
  assert.deepEqual(counts.get('conflicting'), { release: 1, close: 1 });

  const unavailable = makeResources('unavailable');
  await assert.rejects(
    () => adapter.start({
      ...context(unavailable),
      operationId: `brop_${'e'.repeat(32)}`,
      operationType: 'research_watch',
    }, 'cap-unavailable'),
    typedCode('executor_unavailable'),
  );
  assert.deepEqual(counts.get('unavailable'), { release: 1, close: 1 });

  await adapter.cancel(operationId, 'cap-cancel');
  await eventually(async () => {
    assert.equal((await adapter.status(operationId, 'cap-status')).state, 'cancelled');
  });
  assert.deepEqual(counts.get('original'), { release: 1, close: 1 });
});

test('worker adapter remote start omits caller-supplied scratch paths and closes the local quota handle', async () => {
  let received;
  let closes = 0;
  const operationId = `brop_${'8'.repeat(32)}`;
  const adapter = new BrainOperationWorkerAdapter({
    remoteWorker: {
      async start(context) {
        received = context;
        return {
          reference: {
            version: 1, workerId: 'cosmo-worker-1', workerType: 'cosmo',
            operationType: 'research_watch',
          },
          operationId,
          operationType: 'research_watch',
          state: 'running',
          phase: 'watching',
          eventSequence: 0,
          activeProviderCalls: [],
        };
      },
    },
  });
  await adapter.start({
    operationId,
    operationType: 'research_watch',
    requesterAgent: 'jerry',
    target: { domain: 'owned-run', runId: 'run-1' },
    parameters: {
      operationControl: { hardDeadlineAt: new Date(INITIAL_NOW + 1_000).toISOString() },
    },
    scratchDir: '/tmp/untrusted-remote-scratch',
    scratchQuota: { async close() { closes += 1; } },
    sourcePin: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
  }, 'cap-remote-start');
  assert.equal(Object.hasOwn(received, 'scratchDir'), false);
  assert.equal(Object.hasOwn(received, 'scratchQuota'), false);
  assert.equal(Object.hasOwn(received, 'sourcePin'), false);
  assert.equal(closes, 1);
});

test('worker adapter rejects malformed remote events before yielding them', async () => {
  const operationId = `brop_${'6'.repeat(32)}`;
  const adapter = new BrainOperationWorkerAdapter({
    remoteWorker: {
      async *events() {
        yield {
          type: 'progress', operationId, eventSequence: 1,
          state: 'complete', requesterAgent: 'mallory',
        };
      },
    },
  });
  const controller = new AbortController();
  const events = adapter.events(operationId, {
    afterSequence: 0, signal: controller.signal,
  }, 'cap-events')[Symbol.asyncIterator]();
  await assert.rejects(() => events.next(), typedCode('worker_event_invalid'));
  controller.abort();
});

test('worker adapter accepts an interrupted remote result envelope', async () => {
  const operationId = `brop_${'7'.repeat(32)}`;
  let received;
  const adapter = new BrainOperationWorkerAdapter({
    remoteWorker: {
      async result(...args) {
        received = args;
        return {
          state: 'interrupted', result: null, resultArtifact: null,
          error: { code: 'worker_interrupted', message: 'restarted', retryable: true },
          sourceEvidence: null,
        };
      },
    },
  });
  assert.equal((await adapter.result(operationId, 'cap-result', 'cap-status')).state, 'interrupted');
  assert.deepEqual(received, [operationId, 'cap-result', 'cap-status']);
});

test('worker progress validation is operation-aware and rejects extra nested fields', () => {
  const operationId = `brop_${'v'.repeat(32)}`;
  const event = (raw, operationType, eventSequence = 1) => validateWorkerEvent({
    ...raw, operationId, eventSequence, at: '2026-07-13T12:00:00.000Z',
  }, { operationId, operationType, afterSequence: eventSequence - 1 });

  assert.equal(event({
    type: 'progress', phase: 'pgs_sweep', stage: 'sweep_batch_complete',
    selected: 4, completed: 2, successful: 1, failed: 1,
    reused: 0, pending: 2, retryable: 1, total: 4,
  }, 'pgs').stage, 'sweep_batch_complete');
  assert.equal(event({
    type: 'provider_activity', phase: 'pgs_synthesis', provider: 'fake', model: 'model',
    providerCallId: 'pgs:synthesis:reduce:2:0001', childEventType: 'token',
    providerEventAt: null,
  }, 'pgs').providerEventAt, null);
  assert.equal(event({
    type: 'provider_activity', phase: 'pgs_synthesis', provider: 'fake', model: 'model',
    providerCallId: 'pgs:synthesis:reduce:2:0001', childEventType: 'token',
    providerEventAt: 'provider-clock-opaque',
  }, 'pgs').providerEventAt, 'provider-clock-opaque');
  assert.equal(event({
    type: 'progress', phase: 'query', stage: 'projection_complete',
    selectedNodes: 12, selectedEdges: 10,
  }, 'query').stage, 'projection_complete');
  assert.equal(event({
    type: 'progress', phase: 'research_compile', stage: 'requester_artifact_published',
  }, 'research_compile').stage, 'requester_artifact_published');
  assert.equal(event({
    type: 'progress', phase: 'synthesis', stage: 'source_projection_complete',
    sourceRevision: 7, nodes: 12, edges: 10, clusters: 2,
  }, 'synthesis').stage, 'source_projection_complete');

  const pgsProgress = [
    { type: 'progress', phase: 'pgs_projection', stage: 'projection_started' },
    { type: 'progress', phase: 'pgs_projection', stage: 'projection_complete', nodeCount: 12, edgeCount: 10, workUnitCount: 6 },
    { type: 'progress', phase: 'pgs_sweep', stage: 'work_selected', selectedWorkUnits: 6, selectedWorkUnitsTotal: 6, candidateWorkUnits: 6, pendingWorkUnits: 6, batchIndex: 0 },
    { type: 'progress', phase: 'pgs_sweep', stage: 'sweep_batch_complete', selected: 6, completed: 2, successful: 2, failed: 0, reused: 0, pending: 4, retryable: 0, total: 6 },
    { type: 'progress', phase: 'pgs_sweep', stage: 'sweep_complete', successfulSweeps: 6, pendingWorkUnits: 0 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_started', sweepOutputs: 6 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_reduction_started', level: 1, inputItems: 6, batches: 2 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_reduction_truncated', level: 1, batch: 1, providerCallId: 'pgs:synthesis:reduce:1:0000', originalBytes: 200, retainedBytes: 100 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_batch_complete', level: 1, batch: 1, batches: 2 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_reduction_complete', level: 1, outputItems: 2 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_complete', answerBytes: 20, hierarchical: true, inputSweeps: 6, providerCalls: 3, levels: 2, providerCallCeiling: 8, intermediateEncodedBytes: 100, intermediateEncodedByteCeiling: 1_000, truncatedReductionOutputs: 1, truncatedReductionBytes: 100 },
  ];
  pgsProgress.forEach((row, index) => {
    assert.equal(event(row, 'pgs', index + 10).stage, row.stage);
  });

  const compatibilityRows = [
    ['query', { type: 'progress', completed: 1 }],
    ['query', { type: 'provider_selected', phase: 'query', provider: 'fake', model: 'model', providerCallId: 'query', providerStallMs: 5_000 }],
    ['query', { type: 'provider_activity', phase: 'query', provider: 'fake', model: 'model', providerCallId: 'query', providerEventType: 'token', providerEventAt: null }],
    ['query', { type: 'provider_call_terminal', phase: 'query', provider: 'fake', model: 'model', providerCallId: 'query', outcome: 'complete' }],
    ['search', { type: 'progress', phase: 'search', stage: 'source_pin_verified', sourceRevision: 7 }],
    ['status', { type: 'progress', phase: 'status', stage: 'source_operation_finished', sourceRevision: 7 }],
    ['graph_export', { type: 'progress', phase: 'graph_export', stage: 'source_pin_verified', sourceRevision: 7 }],
    ['graph_export', { type: 'progress', phase: 'graph_export', stage: 'source_operation_finished', sourceRevision: 7 }],
    ['graph_export', { type: 'progress', phase: 'graph_export', stage: 'graph_streaming', completedRecords: 20, completedBytes: 200 }],
    ['research_launch', { type: 'progress_update', phase: 'launch', completed: 1, total: 2 }],
    ['research_compile', { type: 'provider_selected', phase: 'research_compile', provider: 'fake', model: 'model', providerCallId: 'research_compile', providerStallMs: 5_000 }],
    ['research_compile', { type: 'provider_activity', phase: 'research_compile', provider: 'fake', model: 'model', providerCallId: 'research_compile', providerEventType: 'token', providerEventAt: null }],
    ['research_compile', { type: 'provider_call_terminal', phase: 'research_compile', provider: 'fake', model: 'model', providerCallId: 'research_compile', outcome: 'complete' }],
    ['synthesis', { type: 'provider_selected', phase: 'synthesis', provider: 'fake', model: 'model', providerCallId: 'synthesis', providerStallMs: 5_000, sourceRevision: 7 }],
    ['synthesis', { type: 'provider_activity', phase: 'synthesis', provider: 'fake', model: 'model', providerCallId: 'synthesis', childEventType: 'token', providerEventAt: null, sourceRevision: 7 }],
    ['synthesis', { type: 'provider_call_terminal', phase: 'synthesis', provider: 'fake', model: 'model', providerCallId: 'synthesis', outcome: 'complete' }],
    ['pgs', { type: 'provider_selected', phase: 'pgs_synthesis', provider: 'fake', model: 'model', providerCallId: 'pgs:synthesis:reduce:1:0000', providerStallMs: 5_000, providerInputBytes: 100, providerInputBudgetBytes: 1_000 }],
    ['pgs', { type: 'provider_activity', phase: 'pgs_synthesis', provider: 'fake', model: 'model', providerCallId: 'pgs:synthesis:reduce:1:0000', childEventType: 'token', providerEventAt: null }],
    ['pgs', { type: 'provider_call_terminal', phase: 'pgs_synthesis', provider: 'fake', model: 'model', providerCallId: 'pgs:synthesis:reduce:1:0000', outcome: 'complete' }],
    ['research_watch', { type: 'heartbeat' }],
    ['research_watch', { type: 'phase', phase: 'watching' }],
    ['research_watch', { type: 'token', payload: 'bounded token envelope' }],
    ['research_watch', { type: 'token_estimate', count: 12 }],
    ['research_watch', { type: 'terminal', state: 'complete' }],
  ];
  compatibilityRows.forEach(([operationType, row], index) => {
    assert.equal(event(row, operationType, index + 30).type, row.type);
  });

  const gapSequence = 60;
  assert.equal(event({
    type: 'event_gap', oldestSequence: 57, latestSequence: 59,
    currentStatus: {
      reference: { version: 1, workerId: 'worker-gap', workerType: 'local', operationType: 'query' },
      operationId, operationType: 'query', state: 'running', phase: 'query',
      eventSequence: 59, activeProviderCalls: [], pgsSession: null,
    },
  }, 'query', gapSequence).type, 'event_gap');

  assert.throws(() => event({
    type: 'progress', phase: 'pgs_projection', stage: 'projection_started',
    debug: { unbounded: true },
  }, 'pgs'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', completed: 1, payload: { unbounded: true },
  }, 'research_launch'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', phase: 'pgs_sweep', stage: 'sweep_batch_complete',
    selected: 4, completed: 2, successful: 1, failed: 1,
    reused: 0, pending: 2, retryable: 1,
  }, 'pgs'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', phase: 'pgs_sweep', stage: 'sweep_batch_complete',
    selected: 4, completed: 2, successful: 1, failed: 1,
    reused: 0, pending: 3, retryable: 1, total: 4,
  }, 'pgs'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', phase: 'query', stage: 'projection_complete',
    selectedNodes: 12, selectedEdges: 10,
  }, 'research_compile'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', phase: 'graph_export', stage: 'unknown_source_stage', sourceRevision: 7,
  }, 'graph_export'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', phase: 'graph_export', stage: 'source_pin_verified',
  }, 'graph_export'), typedCode('worker_event_invalid'));
  assert.throws(() => event({
    type: 'progress', phase: 'graph_export', stage: 'source_operation_finished',
  }, 'graph_export'), typedCode('worker_event_invalid'));
});

test('settled PGS progress survives worker validation, journal compaction, and terminal status', async (t) => {
  const fixture = makeFixture(t);
  fixture.store.eventMaxCount = 4;
  fixture.store.eventMaxBytes = 1024 * 1024;
  const operation = await fixture.coordinator.start(request({
    requestId: 'pgs-progress-compaction-roundtrip',
    operationType: 'pgs',
    parameters: { query: 'progress canary' },
  }));
  const progress = [
    { type: 'progress', phase: 'pgs_projection', stage: 'projection_started' },
    { type: 'progress', phase: 'pgs_projection', stage: 'projection_complete', nodeCount: 100, edgeCount: 200, workUnitCount: 4 },
    { type: 'progress', phase: 'pgs_sweep', stage: 'work_selected', selectedWorkUnits: 4, selectedWorkUnitsTotal: 4, candidateWorkUnits: 4, pendingWorkUnits: 99, batchIndex: 0 },
    { type: 'progress', phase: 'pgs_sweep', stage: 'sweep_batch_complete', selected: 4, completed: 2, successful: 1, failed: 1, reused: 0, pending: 2, retryable: 1, total: 4 },
    { type: 'progress', phase: 'pgs_sweep', stage: 'sweep_batch_complete', selected: 4, completed: 4, successful: 3, failed: 1, reused: 0, pending: 0, retryable: 1, total: 4 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_reduction_started', level: 1, inputItems: 3, batches: 1 },
    { type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_batch_complete', level: 1, batch: 1, batches: 1 },
  ];
  for (const event of progress) fixture.worker.emit(operation.operationId, event);
  for (let index = 0; index < 12; index += 1) {
    fixture.worker.emit(operation.operationId, {
      type: 'progress', phase: 'pgs_synthesis', stage: 'synthesis_batch_complete',
      level: 1, batch: 1, batches: 1,
    });
  }
  fixture.worker.finish(operation.operationId, {
    state: 'complete', result: { answer: 'durable progress' }, error: null, sourceEvidence: null,
  });
  const terminal = await waitForState(fixture, operation.operationId, 'complete');
  assert.deepEqual(terminal.progressSnapshot, {
    version: 1,
    stage: 'terminal',
    eventSequence: terminal.eventSequence,
    sourceNodes: 100,
    sourceEdges: 200,
    candidateWorkUnits: 4,
    selected: 4,
    completed: 4,
    successful: 3,
    failed: 1,
    reused: 0,
    pending: 0,
    retryable: 1,
    total: 4,
    synthesisLevel: 1,
    synthesisBatch: 1,
    synthesisBatches: 1,
    lastProgressAt: terminal.progressSnapshot.lastProgressAt,
  });
  assert.match(terminal.progressSnapshot.lastProgressAt, /^\d{4}-\d{2}-\d{2}T/);
  const compacted = await fixture.store.readEvents(operation.operationId, 0);
  assert.equal(compacted.some(event => event.type === 'event_gap'), true);
  assert.equal(compacted.length < progress.length + 12, true);
});

test('worker adapter cancellation aborts the exact local executor and event snapshots are monotonic', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
    timers,
  });
  t.after(() => adapter.stop?.());
  const observed = deferred();
  adapter.registerLocalExecutor('research_launch', async (context) => {
    context.reportEvent({ type: 'progress', completed: 1 });
    await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
    observed.resolve(context.signal.reason);
    return {
      state: 'cancelled', result: null, resultArtifact: null,
      error: null, sourceEvidence: null,
    };
  });
  const operationId = 'brop_' + 'c'.repeat(32);
  await adapter.start({
    operationId,
    operationType: 'research_launch',
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    parameters: {
      topic: 'canary',
      operationControl: { hardDeadlineAt: new Date(timers.now + 1_000).toISOString() },
    },
    scratchDir: '/tmp/scratch-3', scratchQuota: null, sourcePin: null,
  }, 'cap-start');
  const controller = new AbortController();
  const events = adapter.events(operationId, {
    afterSequence: 0, signal: controller.signal,
  }, 'cap-events')[Symbol.asyncIterator]();
  const first = await events.next();
  assert.equal(first.value.eventSequence, 1);
  await adapter.cancel(operationId, 'cap-cancel');
  assert.ok(await observed.promise);
  await eventually(async () => {
    const status = await adapter.status(operationId, 'cap-status');
    assert.equal(status.state, 'cancelled');
    assert.equal(status.eventSequence >= 2, true);
  });
  controller.abort();
});

test('worker adapter preserves a typed executor failure after its signal was aborted', async (t) => {
  const adapter = new BrainOperationWorkerAdapter();
  t.after(() => adapter.stop?.());
  const operationId = `brop_${'f'.repeat(32)}`;
  adapter.registerLocalExecutor('research_launch', async ({ signal }) => {
    const local = adapter.localRecords.get(operationId);
    local.controller.abort(Object.assign(new Error('late cancel'), {
      code: 'operation_cancelled',
    }));
    assert.equal(signal.aborted, true);
    throw Object.assign(new Error('commit readback failed'), {
      code: 'synthesis_commit_failed', retryable: false,
    });
  });
  await adapter.start({
    operationId,
    operationType: 'research_launch',
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    parameters: {
      operationControl: { hardDeadlineAt: new Date(INITIAL_NOW + 1_000).toISOString() },
    },
    scratchDir: '/tmp/typed-failure-after-abort',
    scratchQuota: null,
    sourcePin: null,
  }, 'cap-start');
  await eventually(async () => {
    assert.equal((await adapter.status(operationId, 'cap-status')).state, 'failed');
  });
  const result = await adapter.result(operationId, 'cap-result');
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'synthesis_commit_failed');
});

test('worker adapter GC bounds observed and unread terminal retention but never evicts live work', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
  });
  t.after(() => adapter.stop?.());
  let releases = 0;
  const liveGate = deferred();
  adapter.registerLocalExecutor('research_launch', async ({ parameters, signal }) => {
    if (parameters.live === true) {
      await Promise.race([
        liveGate.promise,
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return {
        state: signal.aborted ? 'cancelled' : 'complete',
        result: null, resultArtifact: null, error: null, sourceEvidence: null,
      };
    }
    return {
      state: 'complete', result: { done: true }, resultArtifact: null,
      error: null, sourceEvidence: null,
    };
  });
  const start = async (operationId, parameters = {}) => adapter.start({
    operationId,
    operationType: 'research_launch',
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    parameters: {
      ...parameters,
      operationControl: { hardDeadlineAt: new Date(timers.now + 48 * 60 * 60 * 1000).toISOString() },
    },
    scratchDir: `/tmp/${operationId}`,
    scratchQuota: null,
    sourcePin: { descriptor: validDescriptor(), async release() { releases += 1; } },
  }, `cap-${operationId}`);

  const observedId = `brop_${'5'.repeat(32)}`;
  await start(observedId);
  await eventually(async () => assert.equal((await adapter.status(observedId, 'cap')).state, 'complete'));
  await adapter.result(observedId, 'cap-result');
  await timers.advance(10 * 60 * 1000);
  await assert.rejects(() => adapter.status(observedId, 'cap'), typedCode('worker_not_found'));

  const unreadId = `brop_${'4'.repeat(32)}`;
  await start(unreadId);
  await eventually(async () => assert.equal((await adapter.status(unreadId, 'cap')).state, 'complete'));
  const liveId = `brop_${'3'.repeat(32)}`;
  await start(liveId, { live: true });
  await timers.advance(24 * 60 * 60 * 1000);
  await assert.rejects(() => adapter.status(unreadId, 'cap'), typedCode('worker_not_found'));
  assert.equal((await adapter.status(liveId, 'cap')).state, 'running');
  assert.equal(releases, 2);
  await adapter.cancel(liveId, 'cap-cancel');
});

test('worker adapter event streams surface an interior compacted sequence gap', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
  });
  t.after(() => adapter.stop?.());
  let reportEvent;
  adapter.registerLocalExecutor('research_launch', async (context) => {
    reportEvent = context.reportEvent;
    await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
    return {
      state: 'cancelled', result: null, resultArtifact: null,
      error: null, sourceEvidence: null,
    };
  });
  const operationId = `brop_${'9'.repeat(32)}`;
  await adapter.start({
    operationId,
    operationType: 'research_launch',
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    parameters: {
      topic: 'canary',
      operationControl: { hardDeadlineAt: new Date(timers.now + 1_000).toISOString() },
    },
    scratchDir: '/tmp/scratch-interior-gap',
    scratchQuota: null,
    sourcePin: null,
  }, 'cap-start');
  await eventually(() => assert.equal(typeof reportEvent, 'function'));
  reportEvent({ type: 'phase', phase: 'first' });
  reportEvent({ type: 'progress', completed: 1 });
  reportEvent({ type: 'phase', phase: 'third' });

  // This is the exact retained shape produced when bounded-ring compaction
  // preferentially drops a noisy middle event instead of the oldest event.
  adapter._removeEventAt(adapter.localRecords.get(operationId), 1);
  const controller = new AbortController();
  const events = adapter.events(operationId, {
    afterSequence: 0,
    signal: controller.signal,
  }, 'cap-events')[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.eventSequence, 1);
  const gap = (await events.next()).value;
  assert.equal(gap.type, 'event_gap');
  assert.equal(gap.oldestSequence, 2);
  assert.equal(gap.latestSequence, 2);
  assert.equal(gap.eventSequence, 2);
  const retained = await events.next();
  assert.equal(retained.value.eventSequence, 3);
  assert.equal(retained.value.phase, 'third');

  controller.abort();
  await adapter.cancel(operationId, 'cap-cancel');
});

test('worker adapter enforces real count and byte event limits while preserving current phase evidence', async (t) => {
  const timers = new FakeTimers();
  const adapter = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
  });
  t.after(() => adapter.stop?.());
  let reportEvent;
  adapter.registerLocalExecutor('research_launch', async (context) => {
    reportEvent = context.reportEvent;
    await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
    return {
      state: 'cancelled', result: null, resultArtifact: null,
      error: null, sourceEvidence: null,
    };
  });
  const operationId = `brop_${'7'.repeat(32)}`;
  await adapter.start({
    operationId,
    operationType: 'research_launch',
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    parameters: {
      topic: 'bounded-events',
      operationControl: { hardDeadlineAt: new Date(timers.now + 60_000).toISOString() },
    },
    scratchDir: '/tmp/scratch-real-event-limits',
    scratchQuota: null,
    sourcePin: null,
  }, 'cap-start');
  await eventually(() => assert.equal(typeof reportEvent, 'function'));
  reportEvent({ type: 'phase', phase: 'bulk-start' });
  for (let index = 0; index < OPERATION_EVENT_MAX_COUNT + 4; index += 1) {
    reportEvent({ type: 'progress', completed: index + 1 });
  }
  reportEvent({ type: 'phase', phase: 'bulk-finished' });
  reportEvent({ type: 'progress', payload: 'x'.repeat(OPERATION_EVENT_MAX_BYTES + 1_024) });

  const local = adapter.localRecords.get(operationId);
  assert.equal(local.events.length <= OPERATION_EVENT_MAX_COUNT, true);
  assert.equal(adapter._eventBytes(local.events) <= OPERATION_EVENT_MAX_BYTES, true);
  assert.equal(local.events.some((event) =>
    event.type === 'phase' && event.phase === 'bulk-finished'), true);
  assert.equal((await adapter.status(operationId, 'cap-status')).phase, 'bulk-finished');

  const controller = new AbortController();
  const events = adapter.events(operationId, {
    afterSequence: 0, signal: controller.signal,
  }, 'cap-events')[Symbol.asyncIterator]();
  const first = await events.next();
  assert.equal(first.value.type, 'phase');
  const gap = await events.next();
  assert.equal(gap.value.type, 'event_gap');
  assert.equal(gap.value.currentStatus.phase, 'bulk-finished');
  controller.abort();
  await adapter.cancel(operationId, 'cap-cancel');
});

test('real coordinator and local adapter complete a non-source operation through durable result truth', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'home23-real-local-operation-')));
  const timers = new FakeTimers();
  const store = new BrainOperationStore({
    root,
    requesterAgent: 'jerry',
    now: () => timers.now,
    lockTimeoutMs: 5_000,
  });
  const worker = new BrainOperationWorkerAdapter({
    clock: { now: () => timers.now, monotonicNow: () => timers.now },
  });
  worker.registerLocalExecutor('ad_hoc_export', async (context) => ({
    state: 'complete',
    result: { exported: context.parameters.answer },
    resultArtifact: null,
    error: null,
    sourceEvidence: null,
  }));
  const coordinator = new BrainOperationCoordinator({
    requesterAgent: 'jerry',
    store,
    buildCanonicalCatalog: async () => makeCatalog(),
    resolveCanonicalTarget: resolveBrain,
    resolveOwnedRunTarget: async () => ownedRunTarget(),
    operationAuthority: REAL_OPERATION_AUTHORITY,
    authorizeBrainOperation: authorizeRealBrainOperation,
    worker,
    sourcePins: null,
    scratchQuotaFactory: null,
    operationModelResolver: null,
    capabilityIssuer: ({ purpose }) => `real-local-${purpose}-${crypto.randomUUID()}`,
    clock: { now: () => timers.now },
    timers,
  });
  t.after(async () => {
    await coordinator.stop().catch(() => {});
    await worker.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  const started = await coordinator.start({
    requestId: 'real-local-export',
    operationType: 'ad_hoc_export',
    parameters: { query: 'q', answer: 'canonical local', format: 'json', metadata: {} },
  });
  const completed = await eventually(async () => {
    const record = await store.get(started.operationId);
    assert.equal(record.state, 'complete');
    return record;
  });
  assert.deepEqual(completed.result, { exported: 'canonical local' });
  assert.equal(completed.canonicalEvidence, false);
});
