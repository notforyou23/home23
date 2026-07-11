'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { promises: fsp } = fs;
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const {
  OPERATION_AUTHORITY,
} = require('../../shared/brain-operations/authority.cjs');
const {
  canonicalJson,
  canonicalSha256,
} = require('../../shared/brain-operations/canonical-json.cjs');
const {
  issueCapability,
} = require('../../shared/brain-operations/capability.cjs');
const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  coordinatorPinPath,
  discoverOperationPinFiles,
  projectLegacyResearchSnapshot,
  rewriteMemoryBase,
  sourceDescriptorDigest,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');
const {
  BrainOperationWorker,
  OBSERVED_TERMINAL_RETENTION_MS,
  UNREAD_TERMINAL_RETENTION_MS,
  WORKER_EVENT_MAX_BYTES,
  WORKER_EVENT_MAX_COUNT,
  createProcessPinIdentity,
  operationRootFromScratch,
} = require('../../cosmo23/server/lib/brain-operation-worker');
const {
  createBrainOperationRouteHandlers,
  createBrainOperationRoutes,
} = require('../../cosmo23/server/lib/brain-operation-routes');

const KEY = 'brain-operation-worker-test-key';
const INITIAL_NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const BOUNDARY_KINDS = ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency'];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function eventually(callback, attempts = 100) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await callback();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw last;
}

function operationId(character) {
  return `brop_${character.repeat(32)}`;
}

function boundaries(root) {
  return BOUNDARY_KINDS.map((kind) => ({
    kind,
    path: ['brain', 'run'].includes(kind) ? root : path.join(root, kind),
  }));
}

function brainTarget(root, overrides = {}) {
  const target = {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot: root,
    accessMode: 'own',
    ownerAgent: 'jerry',
    displayName: 'Jerry Brain',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: boundaries(root),
    ...overrides,
  };
  if (overrides.canonicalRoot && !overrides.mutationBoundaries) {
    target.mutationBoundaries = boundaries(overrides.canonicalRoot);
  }
  return target;
}

function completedTarget(root, overrides = {}) {
  return brainTarget(root, {
    brainId: 'brain-research-1',
    accessMode: 'read-only',
    ownerAgent: 'researcher',
    displayName: 'Completed Research',
    kind: 'research',
    lifecycle: 'completed',
    route: '/api/brain/brain-research-1',
    ...overrides,
  });
}

function runTarget(root, overrides = {}) {
  const target = {
    domain: 'owned-run',
    runId: 'run-owned-1',
    canonicalRoot: root,
    ownerAgent: 'jerry',
    runState: 'active',
    catalogRevision: 'catalog-run-1',
    route: '/api/runs/run-owned-1',
    mutationBoundaries: boundaries(root),
    ...overrides,
  };
  if (overrides.canonicalRoot && !overrides.mutationBoundaries) {
    target.mutationBoundaries = boundaries(overrides.canonicalRoot);
  }
  return target;
}

function requesterTarget(requesterAgent = 'jerry') {
  return { domain: 'requester', requesterAgent };
}

function validDescriptor(canonicalRoot, overrides = {}) {
  return {
    version: 1,
    canonicalRoot,
    generation: 'g1',
    baseRevision: 2,
    cutoffRevision: 2,
    activeBase: {
      nodes: { file: 'nodes-g1.jsonl.gz', count: 1, bytes: 32 },
      edges: { file: 'edges-g1.jsonl.gz', count: 0, bytes: 20 },
    },
    activeDelta: {
      epoch: 'e1',
      file: 'delta-g1.jsonl',
      fromRevision: 3,
      toRevision: 2,
      count: 0,
      committedBytes: 0,
    },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
    ...overrides,
  };
}

function requestFor({
  id = operationId('a'),
  type = 'query',
  target,
  parameters = { query: 'canary' },
  descriptor,
  digest,
  requesterAgent = 'jerry',
  now = INITIAL_NOW,
} = {}) {
  const sourceRequired = OPERATION_AUTHORITY[type]?.requiresSourcePin === true;
  const effectiveTarget = target || brainTarget('/brains/jerry');
  const sourceDescriptor = descriptor === undefined
    ? (sourceRequired ? validDescriptor(effectiveTarget.canonicalRoot) : null)
    : descriptor;
  const sourceDigest = digest === undefined
    ? (sourceDescriptor ? sourceDescriptorDigest(sourceDescriptor) : null)
    : digest;
  return {
    operationId: id,
    operationType: type,
    requesterAgent,
    target: effectiveTarget,
    parameters,
    operationControl: {
      hardDeadlineAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    },
    sourcePinDescriptor: sourceDescriptor,
    sourcePinDigest: sourceDigest,
  };
}

function capabilityClaims(request, nonce, overrides = {}, now = INITIAL_NOW) {
  const target = request.target;
  return {
    requesterAgent: request.requesterAgent,
    targetDomain: target.domain,
    targetBrainId: target.domain === 'brain' ? target.brainId : null,
    targetRunId: target.domain === 'owned-run' ? target.runId : null,
    targetRequesterAgent: target.domain === 'requester' ? target.requesterAgent : null,
    canonicalRoot: target.domain === 'requester' ? null : target.canonicalRoot,
    accessMode: target.domain === 'brain' ? target.accessMode : 'own',
    operationType: request.operationType,
    operationId: request.operationId,
    sourcePinDigest: request.sourcePinDigest,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce,
    ...overrides,
  };
}

function makeClock() {
  const clock = {
    wall: INITIAL_NOW,
    monotonic: 1_000,
    now: () => clock.wall,
    monotonicNow: () => clock.monotonic,
    advance(milliseconds) {
      clock.wall += milliseconds;
      clock.monotonic += milliseconds;
    },
  };
  return clock;
}

function makeTimers(clock) {
  let nextId = 0;
  const pending = new Map();
  const timers = {
    setTimeout(callback, delay) {
      const handle = {
        id: ++nextId,
        unref() {},
      };
      pending.set(handle.id, { callback, dueAt: clock.wall + delay });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle?.id);
    },
    advance(milliseconds) {
      clock.advance(milliseconds);
      while (true) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.dueAt <= clock.wall)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!due) break;
        pending.delete(due[0]);
        due[1].callback();
      }
    },
    get size() { return pending.size; },
  };
  return timers;
}

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function typed(code) {
  return (error) => error?.code === code;
}

async function makeFixture(t, overrides = {}) {
  const home23Root = overrides.home23Root || await tempDir('home23-protected-worker-');
  const clock = overrides.clock || makeClock();
  const counters = {
    resolve: 0,
    open: 0,
    release: 0,
    quota: 0,
    quotaClose: 0,
  };
  const sourcePins = overrides.sourcePins || {
    async openPinnedSource(descriptor, expectations) {
      counters.open += 1;
      overrides.onOpen?.(descriptor, expectations);
      return {
        descriptor,
        revision: descriptor.cutoffRevision,
        evidence: { sourceHealth: 'healthy' },
        getEvidence() { return this.evidence; },
        async release() { counters.release += 1; },
      };
    },
  };
  const scratchQuotaFactory = overrides.scratchQuotaFactory || (async ({ operationRoot }) => {
    counters.quota += 1;
    return {
      operationRoot: await fsp.realpath(operationRoot),
      async claim() {},
      async release() {},
      async reconcile() { return {}; },
      async assertOperationRoot() { return true; },
      async close() { counters.quotaClose += 1; },
    };
  });
  const resolveTarget = overrides.resolveTarget || (async ({ target }) => {
    counters.resolve += 1;
    return structuredClone(target);
  });
  const worker = new BrainOperationWorker({
    home23Root,
    capabilityKey: KEY,
    resolveTarget,
    sourcePins,
    scratchQuotaFactory,
    executors: overrides.executors || new Map(),
    clock,
    timers: overrides.timers,
    processStartIdentity: 'test-process-start',
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  let nonce = 0;
  const token = (request, claimOverrides = {}, tokenNow = clock.wall) => issueCapability(
    KEY,
    capabilityClaims(request, `nonce-${++nonce}`, claimOverrides, tokenNow),
  );
  if (t) {
    t.after(async () => {
      await worker.stop().catch(() => {});
      if (!overrides.keepRoot) await fsp.rm(home23Root, { recursive: true, force: true });
    });
  }
  return { worker, home23Root, clock, counters, token, sourcePins };
}

async function terminalStatus(fixture, request) {
  return eventually(async () => {
    const status = await fixture.worker.status(request.operationId, fixture.token(request));
    assert.equal(['complete', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status.state), true);
    return status;
  });
}

test('worker helpers derive stable trusted process and operation identities', () => {
  assert.match(createProcessPinIdentity({ pid: 123, processStartIdentity: 'boot-start' }),
    /^cosmo-123-[a-f0-9]{20}$/);
  assert.equal(
    createProcessPinIdentity({ pid: 123, processStartIdentity: 'boot-start' }),
    createProcessPinIdentity({ pid: 123, processStartIdentity: 'boot-start' }),
  );
  assert.throws(() => createProcessPinIdentity({ pid: 0, processStartIdentity: 'x' }), typed('source_unavailable'));
  assert.equal(operationRootFromScratch('/tmp/op/scratch'), '/tmp/op');
  assert.throws(() => operationRootFromScratch('/tmp/op/not-scratch'), typed('invalid_request'));
});

test('expired deadlines fail before target resolution, scratch, or source pinning', async (t) => {
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async () => {
      throw new Error('executor must not run');
    }]]),
  });
  const request = requestFor({ id: operationId('t') });
  request.operationControl.hardDeadlineAt = new Date(fixture.clock.wall - 1).toISOString();
  await assert.rejects(
    () => fixture.worker.start(request.operationId, fixture.token(request), request),
    typed('operation_timeout'),
  );
  assert.deepEqual(fixture.counters, {
    resolve: 0, open: 0, release: 0, quota: 0, quotaClose: 0,
  });
});

test('worker hard deadline aborts a live executor and reports a typed failed result', async (t) => {
  const clock = makeClock();
  const timers = makeTimers(clock);
  const fixture = await makeFixture(t, {
    clock,
    timers,
    executors: new Map([['query', async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw signal.reason;
    }]]),
  });
  const request = requestFor({ id: operationId('u'), now: clock.wall });
  request.operationControl.hardDeadlineAt = new Date(clock.wall + 1_000).toISOString();
  const started = await fixture.worker.start(request.operationId, fixture.token(request), request);
  assert.equal(started.state, 'running');
  assert.equal(timers.size, 1);

  timers.advance(1_001);
  const terminal = await terminalStatus(fixture, request);
  assert.equal(terminal.state, 'failed');
  const result = await fixture.worker.result(request.operationId, fixture.token(request));
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'operation_timeout');
  assert.equal(result.error.retryable, false);
  assert.equal(timers.size, 0);
  assert.equal(fixture.counters.release, 1);
  assert.equal(fixture.counters.quotaClose, 1);
});

test('32 equivalent starts create one worker, one process pin, and one executor', async (t) => {
  const gate = deferred();
  let calls = 0;
  let received;
  let openExpectations;
  const executors = new Map([['query', async (context) => {
    calls += 1;
    received = context;
    context.reportEvent({ type: 'phase', phase: 'querying' });
    await Promise.race([
      gate.promise,
      new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true })),
    ]);
    return {
      state: context.signal.aborted ? 'cancelled' : 'complete',
      result: context.signal.aborted ? null : { answer: 'ok' },
      resultArtifact: null,
      error: null,
      sourceEvidence: context.sourcePin.getEvidence(),
    };
  }]]);
  const fixture = await makeFixture(t, {
    executors,
    onOpen(_descriptor, expectations) { openExpectations = expectations; },
  });
  const request = requestFor();
  const records = await Promise.all(Array.from({ length: 32 }, () =>
    fixture.worker.start(request.operationId, fixture.token(request), structuredClone(request))));
  assert.equal(new Set(records.map((record) => record.reference.workerId)).size, 1);
  assert.equal(records.every((record) => record.reference.workerType === 'cosmo'), true);
  assert.equal(fixture.counters.open, 1);
  await eventually(() => assert.equal(calls, 1));
  assert.equal(received.requesterAgent, 'jerry');
  assert.equal(received.operationType, 'query');
  assert.equal(received.scratchDir, path.join(
    await fsp.realpath(fixture.home23Root), 'instances', 'jerry', 'runtime', 'brain-operations',
    request.operationId, 'scratch',
  ));
  assert.equal(received.signal instanceof AbortSignal, true);
  assert.equal(openExpectations.requesterAgent, 'jerry');
  assert.equal(openExpectations.operationId, request.operationId);
  assert.equal(openExpectations.expectedDigest, request.sourcePinDigest);
  assert.equal(openExpectations.expectedRevision, request.sourcePinDescriptor.cutoffRevision);
  assert.equal(openExpectations.lockRoot, path.join(
    await fsp.realpath(fixture.home23Root), 'runtime', 'brain-source-locks',
  ));
  assert.match(openExpectations.processIdentity, /^cosmo-\d+-[a-f0-9]{20}$/);

  const retry = await fixture.worker.start(request.operationId, fixture.token(request), structuredClone(request));
  assert.equal(retry.reference.workerId, records[0].reference.workerId);
  assert.equal(fixture.counters.open, 1);
  assert.equal(calls, 1);

  const reordered = structuredClone(request);
  reordered.parameters = { nested: { z: 1, a: 2 }, query: 'canary' };
  const reorderedFirst = requestFor({
    id: operationId('b'),
    parameters: { query: 'canary', nested: { a: 2, z: 1 } },
  });
  await fixture.worker.start(reorderedFirst.operationId, fixture.token(reorderedFirst), reorderedFirst);
  const equivalent = { ...reorderedFirst, parameters: reordered.parameters };
  const equivalentRecord = await fixture.worker.start(
    equivalent.operationId, fixture.token(equivalent), equivalent,
  );
  assert.equal(equivalentRecord.operationId, reorderedFirst.operationId);

  const conflictCases = [
    { ...request, parameters: { query: 'different' } },
    requestFor({ id: request.operationId, type: 'pgs', target: request.target }),
    requestFor({ id: request.operationId, target: completedTarget('/brains/completed') }),
    requestFor({
      id: request.operationId,
      descriptor: validDescriptor(request.target.canonicalRoot, { generation: 'g2' }),
    }),
  ];
  for (const conflicting of conflictCases) {
    await assert.rejects(
      () => fixture.worker.start(conflicting.operationId, fixture.token(conflicting), conflicting),
      typed('worker_operation_conflict'),
    );
  }
  assert.equal(fixture.counters.open, 2, 'only the separate reordered operation opens another pin');

  gate.resolve();
  const complete = await terminalStatus(fixture, request);
  const terminalRetry = await fixture.worker.start(
    request.operationId, fixture.token(request), structuredClone(request),
  );
  assert.equal(terminalRetry.reference.workerId, complete.reference.workerId);
  assert.equal(terminalRetry.state, 'complete');
  assert.equal(calls, 2, 'the separate reordered operation is the only other executor call');
});

test('every endpoint consumes a fresh capability and rejects altered complete bindings', async (t) => {
  const gate = deferred();
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async ({ signal }) => {
      await Promise.race([
        gate.promise,
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return {
        state: signal.aborted ? 'cancelled' : 'complete',
        result: signal.aborted ? null : { answer: 'ok' },
        resultArtifact: null,
        error: null,
        sourceEvidence: {},
      };
    }]]),
  });
  const request = requestFor({ id: operationId('c') });
  const startToken = fixture.token(request);
  await fixture.worker.start(request.operationId, startToken, request);
  await assert.rejects(() => fixture.worker.status(request.operationId, startToken), typed('capability_replay'));

  const invalidSignature = fixture.token(request).replace(/.$/, 'A');
  await assert.rejects(() => fixture.worker.status(request.operationId, invalidSignature), typed('capability_invalid'));
  const expired = issueCapability(KEY, capabilityClaims(
    request, 'expired-nonce', { issuedAt: fixture.clock.wall - 61_000, expiresAt: fixture.clock.wall - 1 },
    fixture.clock.wall - 61_000,
  ));
  await assert.rejects(() => fixture.worker.status(request.operationId, expired), typed('capability_expired'));

  const mismatchCases = [
    { requesterAgent: 'forrest' },
    { targetBrainId: 'brain-other' },
    { canonicalRoot: '/brains/other' },
    { accessMode: 'read-only' },
    { operationType: 'pgs' },
    { operationId: operationId('d') },
    { sourcePinDigest: `sha256:${'f'.repeat(64)}` },
  ];
  const endpoints = {
    status: (token) => fixture.worker.status(request.operationId, token),
    events: async (token) => {
      const controller = new AbortController();
      controller.abort();
      return fixture.worker.events(request.operationId, token, {
        afterSequence: 0, signal: controller.signal,
      })[Symbol.asyncIterator]().next();
    },
    result: (token) => fixture.worker.result(request.operationId, token),
    cancel: (token) => fixture.worker.cancel(request.operationId, token),
  };
  for (const [endpoint, invoke] of Object.entries(endpoints)) {
    for (const overrides of mismatchCases) {
      const token = fixture.token(request, overrides);
      await assert.rejects(() => invoke(token), typed('capability_mismatch'), `${endpoint} ${canonicalJson(overrides)}`);
    }
  }

  const consumed = fixture.token(request);
  await fixture.worker.status(request.operationId, consumed);
  await assert.rejects(() => fixture.worker.result(request.operationId, consumed), typed('capability_replay'));

  const unknown = { ...request, operationId: operationId('l') };
  const unknownToken = fixture.token(unknown);
  const invalidUnknownToken = unknownToken.replace(/.$/, (character) => character === 'A' ? 'B' : 'A');
  await assert.rejects(
    () => fixture.worker.status(unknown.operationId, invalidUnknownToken),
    typed('capability_invalid'),
  );
  await assert.rejects(
    () => fixture.worker.status(unknown.operationId, unknownToken),
    typed('worker_not_found'),
  );
  await assert.rejects(
    () => fixture.worker.status(unknown.operationId, unknownToken),
    typed('capability_replay'),
  );
  await fixture.worker.cancel(request.operationId, fixture.token(request));
  gate.resolve();
  await terminalStatus(fixture, request);
});

test('start rejects body identity, root, lifecycle, policy, and write-scope overrides before work', async (t) => {
  let executions = 0;
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async () => {
      executions += 1;
      return { state: 'complete', result: {}, resultArtifact: null, error: null, sourceEvidence: {} };
    }]]),
  });
  const base = requestFor({ id: operationId('e') });
  for (const key of [
    'scratchDir', 'operationRoot', 'canonicalRoot', 'owner', 'lifecycle',
    'runOwner', 'policy', 'writeScope', 'provider', 'outputPath',
  ]) {
    const request = { ...base, operationId: operationId(String.fromCharCode(102 + key.length % 10)), [key]: 'forged' };
    const tokenRequest = { ...base, operationId: request.operationId };
    await assert.rejects(
      () => fixture.worker.start(request.operationId, fixture.token(tokenRequest), request),
      typed('invalid_request'),
      key,
    );
  }
  assert.equal(fixture.counters.open, 0);
  assert.equal(executions, 0);
});

test('scratch creation rejects a preplanted operation symlink before writing through it', async (t) => {
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async () => ({
      state: 'complete', result: {}, resultArtifact: null, error: null, sourceEvidence: {},
    })]]),
  });
  const outside = await tempDir('home23-worker-scratch-outside-');
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const request = requestFor({ id: operationId('p') });
  const operationsRoot = path.join(
    await fsp.realpath(fixture.home23Root),
    'instances', 'jerry', 'runtime', 'brain-operations',
  );
  await fsp.mkdir(operationsRoot, { recursive: true });
  await fsp.symlink(outside, path.join(operationsRoot, request.operationId));
  await assert.rejects(
    () => fixture.worker.start(request.operationId, fixture.token(request), request),
    typed('invalid_request'),
  );
  assert.equal(await fsp.access(path.join(outside, 'scratch')).then(() => true).catch(() => false), false);
  assert.equal(fixture.counters.open, 0);
});

test('source-none run and requester operations never open a source and preserve exact domains', async (t) => {
  const contexts = [];
  const result = (context) => {
    contexts.push(context);
    return { state: 'complete', result: { ok: true }, resultArtifact: null, error: null, sourceEvidence: null };
  };
  const fixture = await makeFixture(t, {
    executors: new Map([
      ['research_watch', result],
      ['research_launch', result],
    ]),
  });
  const watch = requestFor({
    id: operationId('f'), type: 'research_watch', target: runTarget('/runs/run-owned-1'),
    parameters: { after: 0, limit: 10, filter: 'all' },
  });
  await fixture.worker.start(watch.operationId, fixture.token(watch), watch);
  await terminalStatus(fixture, watch);
  const launch = requestFor({
    id: operationId('g'), type: 'research_launch', target: requesterTarget(),
    parameters: { topic: 'canary' },
  });
  await fixture.worker.start(launch.operationId, fixture.token(launch), launch);
  await terminalStatus(fixture, launch);
  assert.equal(fixture.counters.open, 0);
  assert.equal(contexts.every((context) => context.sourcePin === null), true);

  const forbiddenSource = { ...watch, operationId: operationId('h') };
  forbiddenSource.sourcePinDescriptor = validDescriptor(watch.target.canonicalRoot);
  forbiddenSource.sourcePinDigest = sourceDescriptorDigest(forbiddenSource.sourcePinDescriptor);
  await assert.rejects(
    () => fixture.worker.start(forbiddenSource.operationId, fixture.token(forbiddenSource), forbiddenSource),
    typed('invalid_request'),
  );
  const wrongOwner = requestFor({
    id: operationId('i'), type: 'research_watch',
    target: runTarget('/runs/run-owned-1', { ownerAgent: 'forrest' }),
  });
  await assert.rejects(
    () => fixture.worker.start(wrongOwner.operationId, fixture.token(wrongOwner), wrongOwner),
    typed('access_denied'),
  );
  const wrongRequester = requestFor({
    id: launch.operationId, type: 'research_launch', target: requesterTarget('forrest'),
    requesterAgent: 'forrest',
  });
  await assert.rejects(
    () => fixture.worker.start(launch.operationId, fixture.token(wrongRequester), launch),
    typed('capability_mismatch'),
  );
  assert.equal(fixture.counters.open, 0);
});

test('research intelligence is completed read-only only', async (t) => {
  let calls = 0;
  const fixture = await makeFixture(t, {
    executors: new Map([['research_intelligence', async () => {
      calls += 1;
      return { state: 'complete', result: { intelligence: true }, resultArtifact: null, error: null, sourceEvidence: {} };
    }]]),
  });
  const allowed = requestFor({
    id: operationId('k'), type: 'research_intelligence',
    target: completedTarget('/runs/completed-1'), parameters: { include: ['executive'] },
  });
  await fixture.worker.start(allowed.operationId, fixture.token(allowed), allowed);
  await terminalStatus(fixture, allowed);
  assert.equal(calls, 1);

  for (const target of [
    brainTarget('/brains/jerry'),
    completedTarget('/runs/active', { lifecycle: 'active' }),
    completedTarget('/runs/unavailable', { lifecycle: 'unavailable' }),
  ]) {
    const denied = requestFor({
      id: operationId(String.fromCharCode(108 + calls)),
      type: 'research_intelligence', target,
    });
    await assert.rejects(
      () => fixture.worker.start(denied.operationId, fixture.token(denied), denied),
      typed('access_denied'),
    );
  }
  assert.equal(calls, 1);
});

test('numeric-v1 digest-bound descriptors reject exposed or unsafe fields before open', async (t) => {
  let calls = 0;
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async () => {
      calls += 1;
      return { state: 'complete', result: {}, resultArtifact: null, error: null, sourceEvidence: {} };
    }]]),
  });
  const root = '/brains/jerry';
  const invalidDescriptors = [
    { ...validDescriptor(root), version: '1' },
    { ...validDescriptor(root), version: 0 },
    { ...validDescriptor(root), cutoffRevision: null },
    { ...validDescriptor(root), baseRevision: Number.MAX_SAFE_INTEGER },
    { ...validDescriptor(root), generation: '../private-generation' },
    {
      ...validDescriptor(root),
      activeDelta: { ...validDescriptor(root).activeDelta, epoch: '../private-epoch' },
    },
    { ...validDescriptor(root), projectionRoot: '/private/projection' },
    { ...validDescriptor(root), lockRoot: '/caller/lock' },
    { ...validDescriptor(root), canonicalRoot: '/brains/other' },
    {
      ...validDescriptor(root),
      activeBase: {
        ...validDescriptor(root).activeBase,
        nodes: { ...validDescriptor(root).activeBase.nodes, file: '../nodes.gz' },
      },
    },
  ];
  let index = 0;
  for (const descriptor of invalidDescriptors) {
    const digest = (() => {
      try { return sourceDescriptorDigest(descriptor); } catch { return `sha256:${'1'.repeat(64)}`; }
    })();
    const request = requestFor({
      id: operationId(String.fromCharCode(109 + index++)), descriptor, digest,
    });
    await assert.rejects(
      () => fixture.worker.start(request.operationId, fixture.token(request), request),
      (error) => ['invalid_request', 'source_pin_invalid'].includes(error?.code),
    );
  }
  const descriptor = validDescriptor(root);
  const digestMismatch = requestFor({
    id: operationId('u'), descriptor, digest: `sha256:${'2'.repeat(64)}`,
  });
  await assert.rejects(
    () => fixture.worker.start(digestMismatch.operationId, fixture.token(digestMismatch), digestMismatch),
    typed('source_pin_invalid'),
  );
  assert.equal(fixture.counters.open, 0);
  assert.equal(calls, 0);
});

test('executor lookup is exact and research compile never falls back to query', async (t) => {
  let queryCalls = 0;
  let compileCalls = 0;
  const fixture = await makeFixture(t, {
    executors: new Map([
      ['query', async () => {
        queryCalls += 1;
        throw new Error('wrong executor');
      }],
      ['research_compile', async (context) => {
        compileCalls += 1;
        return {
          state: 'complete', result: { compiled: context.parameters.section },
          resultArtifact: null, error: null, sourceEvidence: {},
        };
      }],
    ]),
  });
  const request = requestFor({
    id: operationId('v'), type: 'research_compile',
    target: completedTarget('/runs/completed-compile'),
    parameters: { kind: 'section', section: 'executive' },
  });
  const started = await fixture.worker.start(request.operationId, fixture.token(request), request);
  assert.equal(started.reference.operationType, 'research_compile');
  await terminalStatus(fixture, request);
  const envelope = await fixture.worker.result(request.operationId, fixture.token(request));
  assert.equal(fixture.worker.records.get(request.operationId).operationType, 'research_compile');
  assert.deepEqual(envelope.result, { compiled: 'executive' });
  assert.equal(queryCalls, 0);
  assert.equal(compileCalls, 1);

  const noCompile = await makeFixture(null, {
    keepRoot: true,
    executors: new Map([['query', async () => ({
      state: 'complete', result: {}, resultArtifact: null, error: null, sourceEvidence: {},
    })]]),
  });
  const missing = { ...request, operationId: operationId('w') };
  try {
    await assert.rejects(
      () => noCompile.worker.start(missing.operationId, noCompile.token(missing), missing),
      typed('executor_unavailable'),
    );
    assert.equal(noCompile.counters.open, 0);
  } finally {
    await noCompile.worker.stop();
    await fsp.rm(noCompile.home23Root, { recursive: true, force: true });
  }
});

test('the optional result artifact field normalizes to null', async (t) => {
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async () => ({
      state: 'complete',
      result: { answer: 'no artifact' },
      error: null,
      sourceEvidence: {},
    })]]),
  });
  const request = requestFor({ id: operationId('n') });
  await fixture.worker.start(request.operationId, fixture.token(request), request);
  const status = await terminalStatus(fixture, request);
  assert.equal(status.state, 'complete');
  assert.equal((await fixture.worker.result(request.operationId, fixture.token(request))).resultArtifact, null);
});

test('worker uses the shared authority matrix for every operation domain and source policy', async (t) => {
  const executors = new Map();
  for (const operationType of Object.keys(OPERATION_AUTHORITY)) {
    executors.set(operationType, async () => ({
      state: 'complete', result: { operationType }, resultArtifact: null,
      error: null, sourceEvidence: null,
    }));
  }
  const fixture = await makeFixture(t, { executors });
  assert.equal(fixture.worker.operationAuthority, OPERATION_AUTHORITY);
  let index = 0;
  for (const [type, policy] of Object.entries(OPERATION_AUTHORITY)) {
    let target;
    if (policy.domain === 'brain') {
      target = policy.modes.includes('own') && policy.lifecycles.includes('resident')
        ? brainTarget(`/brains/allowed-${index}`)
        : completedTarget(`/runs/allowed-${index}`);
    } else if (policy.domain === 'owned-run') {
      target = runTarget(`/runs/allowed-${index}`, { runState: policy.runStates[0] });
    } else {
      target = requesterTarget();
    }
    const request = requestFor({
      id: operationId(String.fromCharCode(65 + index++)), type, target,
      parameters: type === 'graph_export' ? { format: 'jsonl' } : {},
    });
    await fixture.worker.start(request.operationId, fixture.token(request), request);
    await terminalStatus(fixture, request);
  }
  const before = fixture.counters.open;
  const unknown = requestFor({ id: operationId('x'), type: 'unknown_operation' });
  await assert.rejects(
    () => fixture.worker.start(unknown.operationId, fixture.token(unknown), unknown),
    typed('invalid_request'),
  );
  const wrongDomain = requestFor({
    id: operationId('y'), type: 'query', target: runTarget('/runs/wrong-domain'),
  });
  await assert.rejects(
    () => fixture.worker.start(wrongDomain.operationId, fixture.token(wrongDomain), wrongDomain),
    typed('access_denied'),
  );
  assert.equal(fixture.counters.open, before);
});

test('graph export validates one scratch-local identity NDJSON artifact and exact parameters', async (t) => {
  const variants = new Map();
  const executor = async (context) => {
    const variant = variants.get(context.operationId) || {};
    const scratchPath = variant.scratchPath || path.join(context.scratchDir, 'graph.jsonl');
    await fsp.mkdir(path.dirname(scratchPath), { recursive: true });
    const body = Buffer.from('{"type":"meta"}\n');
    await fsp.writeFile(scratchPath, body);
    return {
      state: 'complete',
      result: variant.result ?? null,
      resultArtifact: {
        scratchPath,
        mediaType: variant.mediaType || 'application/x-ndjson',
        contentEncoding: variant.contentEncoding || 'identity',
        bytes: variant.bytes ?? body.length,
        sha256: variant.sha256 || crypto.createHash('sha256').update(body).digest('hex'),
      },
      error: null,
      sourceEvidence: {},
    };
  };
  const fixture = await makeFixture(t, { executors: new Map([['graph_export', executor]]) });
  const valid = requestFor({
    id: operationId('z'), type: 'graph_export', parameters: { format: 'jsonl' },
  });
  await fixture.worker.start(valid.operationId, fixture.token(valid), valid);
  await terminalStatus(fixture, valid);
  const result = await fixture.worker.result(valid.operationId, fixture.token(valid));
  assert.equal(result.result, null);
  assert.equal(result.resultArtifact.mediaType, 'application/x-ndjson');
  assert.equal(result.resultArtifact.contentEncoding, 'identity');

  const invalids = [
    { variant: { result: { also: true } }, code: 'worker_result_invalid' },
    { variant: { scratchPath: path.join(fixture.home23Root, 'outside.jsonl') }, code: 'worker_result_invalid' },
    { variant: { mediaType: 'application/json' }, code: 'worker_result_invalid' },
    { variant: { contentEncoding: 'gzip' }, code: 'worker_result_invalid' },
    { variant: { bytes: -1 }, code: 'worker_result_invalid' },
    { variant: { sha256: 'BAD' }, code: 'worker_result_invalid' },
  ];
  let index = 0;
  for (const { variant, code } of invalids) {
    const request = requestFor({
      id: operationId(String(index++ % 10)), type: 'graph_export', parameters: { format: 'jsonl' },
    });
    variants.set(request.operationId, variant);
    await fixture.worker.start(request.operationId, fixture.token(request), request);
    const status = await terminalStatus(fixture, request);
    assert.equal(status.state, 'failed');
    const envelope = await fixture.worker.result(request.operationId, fixture.token(request));
    assert.equal(envelope.error.code, code);
  }
  const wrongFormat = requestFor({
    id: operationId('1'), type: 'graph_export', parameters: { format: 'json' },
  });
  await assert.rejects(
    () => fixture.worker.start(wrongFormat.operationId, fixture.token(wrongFormat), wrongFormat),
    typed('invalid_request'),
  );
});

test('provider calls retain correlation and derive bounded idle snapshots from the worker clock', async (t) => {
  const gate = deferred();
  let report;
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async (context) => {
      report = context.reportEvent;
      report({ type: 'provider_selected', providerCallId: 'call-1', providerStallMs: 5_000, childAt: 999999 });
      report({ type: 'provider_selected', providerCallId: 'call-2', providerStallMs: 7_000 });
      await gate.promise;
      return { state: 'complete', result: { answer: 'ok' }, resultArtifact: null, error: null, sourceEvidence: {} };
    }]]),
  });
  const request = requestFor({ id: operationId('2') });
  await fixture.worker.start(request.operationId, fixture.token(request), request);
  await eventually(() => assert.equal(typeof report, 'function'));
  fixture.clock.advance(250);
  report({ type: 'provider_activity', providerCallId: 'call-1', childAt: -1 });
  const active = await fixture.worker.status(request.operationId, fixture.token(request));
  assert.deepEqual(active.activeProviderCalls, [
    { providerCallId: 'call-1', providerStallMs: 5_000, idleMs: 0 },
    { providerCallId: 'call-2', providerStallMs: 7_000, idleMs: 250 },
  ]);
  report({ type: 'heartbeat' });
  fixture.clock.advance(100);
  const heartbeatDoesNotRenew = await fixture.worker.status(request.operationId, fixture.token(request));
  assert.equal(heartbeatDoesNotRenew.activeProviderCalls[0].idleMs, 100);
  report({ type: 'provider_call_terminal', providerCallId: 'call-1' });
  assert.deepEqual((await fixture.worker.status(request.operationId, fixture.token(request))).activeProviderCalls,
    [{ providerCallId: 'call-2', providerStallMs: 7_000, idleMs: 350 }]);
  report({ type: 'provider_call_terminal', providerCallId: 'call-2' });
  gate.resolve();
  await terminalStatus(fixture, request);

  const controller = new AbortController();
  const types = [];
  for await (const event of fixture.worker.events(request.operationId, fixture.token(request), {
    afterSequence: 0, signal: controller.signal,
  })) types.push([event.type, event.providerCallId || null]);
  assert.deepEqual(types.filter(([type]) => type.startsWith('provider_')), [
    ['provider_selected', 'call-1'],
    ['provider_selected', 'call-2'],
    ['provider_activity', 'call-1'],
    ['provider_call_terminal', 'call-1'],
    ['provider_call_terminal', 'call-2'],
  ]);
});

test('invalid provider events fail closed and cannot become authenticated activity', async (t) => {
  const invalidEvents = [
    { type: 'provider_selected', providerCallId: 'call', providerStallMs: Number.NaN },
    { type: 'provider_selected', providerStallMs: 1_000 },
    { type: 'provider_activity', providerCallId: 'missing' },
    { type: 'provider_call_terminal', providerCallId: 'missing' },
  ];
  let index = 0;
  for (const invalidEvent of invalidEvents) {
    const fixture = await makeFixture(null, {
      keepRoot: true,
      executors: new Map([['query', async ({ reportEvent }) => {
        reportEvent(invalidEvent);
        return { state: 'complete', result: {}, resultArtifact: null, error: null, sourceEvidence: {} };
      }]]),
    });
    const request = requestFor({ id: operationId(String(3 + index++)) });
    try {
      await fixture.worker.start(request.operationId, fixture.token(request), request);
      const status = await terminalStatus(fixture, request);
      assert.equal(status.state, 'failed');
      const result = await fixture.worker.result(request.operationId, fixture.token(request));
      assert.equal(['worker_event_invalid', 'provider_contract_invalid'].includes(result.error.code), true);
      assert.deepEqual(status.activeProviderCalls, []);
    } finally {
      await fixture.worker.stop();
      await fsp.rm(fixture.home23Root, { recursive: true, force: true });
    }
  }
});

test('provider activity is coalesced without evicting its selected and terminal evidence', async (t) => {
  const gate = deferred();
  let report;
  const fixture = await makeFixture(t, {
    executors: new Map([['query', async (context) => {
      report = context.reportEvent;
      await gate.promise;
      return { state: 'complete', result: { answer: 'ok' }, resultArtifact: null, error: null, sourceEvidence: {} };
    }]]),
  });
  const request = requestFor({ id: operationId('p') });
  await fixture.worker.start(request.operationId, fixture.token(request), request);
  await eventually(() => assert.equal(typeof report, 'function'));
  try {
    report({ type: 'provider_selected', providerCallId: 'long-call', providerStallMs: 10_000 });
    for (let index = 0; index < WORKER_EVENT_MAX_COUNT + 128; index += 1) {
      report({ type: 'provider_activity', providerCallId: 'long-call', providerChunk: index });
    }
    report({ type: 'provider_call_terminal', providerCallId: 'long-call', outcome: 'complete' });
    const providerEvents = fixture.worker.records.get(request.operationId).events
      .filter((event) => event.providerCallId === 'long-call');
    assert.deepEqual(providerEvents.map((event) => event.type), [
      'provider_selected', 'provider_activity', 'provider_call_terminal',
    ]);
    assert.equal(providerEvents[1].providerChunk, WORKER_EVENT_MAX_COUNT + 127);
  } finally {
    gate.resolve();
    await terminalStatus(fixture, request);
  }
});

test('event storage is count/byte bounded and exposes an authenticated resumable gap', async (t) => {
  const gate = deferred();
  let report;
  const fixture = await makeFixture(t, {
    executors: new Map([['research_launch', async (context) => {
      report = context.reportEvent;
      await Promise.race([
        gate.promise,
        new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return {
        state: context.signal.aborted ? 'cancelled' : 'complete',
        result: null, resultArtifact: null, error: null, sourceEvidence: null,
      };
    }]]),
  });
  const request = requestFor({
    id: operationId('7'), type: 'research_launch', target: requesterTarget(), parameters: { topic: 'events' },
  });
  await fixture.worker.start(request.operationId, fixture.token(request), request);
  await eventually(() => assert.equal(typeof report, 'function'));
  report({ type: 'phase', phase: 'bulk-start' });
  for (let index = 0; index < WORKER_EVENT_MAX_COUNT + 16; index += 1) {
    report({ type: 'progress', completed: index });
  }
  report({ type: 'phase', phase: 'bulk-finished' });
  report({ type: 'token_estimate', payload: 'x'.repeat(WORKER_EVENT_MAX_BYTES + 1_024) });
  const internal = fixture.worker.records.get(request.operationId);
  assert.equal(internal.events.length <= WORKER_EVENT_MAX_COUNT, true);
  assert.equal(internal.eventBytes <= WORKER_EVENT_MAX_BYTES, true);
  assert.equal(internal.events.some((event) => event.type === 'phase' && event.phase === 'bulk-finished'), true);
  const status = await fixture.worker.status(request.operationId, fixture.token(request));
  assert.equal(status.phase, 'bulk-finished');

  const controller = new AbortController();
  const iterator = fixture.worker.events(request.operationId, fixture.token(request), {
    afterSequence: 0, signal: controller.signal,
  })[Symbol.asyncIterator]();
  let gap = null;
  for (let index = 0; index < 4 && !gap; index += 1) {
    const next = await iterator.next();
    gap = next.value?.type === 'event_gap' ? next.value : null;
  }
  assert.ok(gap);
  assert.equal(gap.operationId, request.operationId);
  assert.equal(gap.oldestSequence > 0, true);
  assert.equal(gap.latestSequence, status.eventSequence);
  assert.equal(gap.currentStatus.eventSequence >= gap.latestSequence, true);
  assert.equal(gap.currentStatus.phase, 'bulk-finished');
  controller.abort();
  await fixture.worker.cancel(request.operationId, fixture.token(request));
  gate.resolve();
});

test('GC protects live work and enforces observed and unread terminal retention without sleeps', async (t) => {
  const liveGate = deferred();
  const fixture = await makeFixture(t, {
    executors: new Map([['research_launch', async ({ parameters, signal }) => {
      if (parameters.live) {
        await Promise.race([
          liveGate.promise,
          new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
        ]);
      }
      return {
        state: signal.aborted ? 'cancelled' : 'complete',
        result: signal.aborted ? null : { ok: true },
        resultArtifact: null, error: null, sourceEvidence: null,
      };
    }]]),
  });
  const observed = requestFor({
    id: operationId('8'), type: 'research_launch', target: requesterTarget(), parameters: {},
  });
  await fixture.worker.start(observed.operationId, fixture.token(observed), observed);
  await terminalStatus(fixture, observed);
  await fixture.worker.result(observed.operationId, fixture.token(observed));
  fixture.clock.advance(OBSERVED_TERMINAL_RETENTION_MS);
  await assert.rejects(
    () => fixture.worker.status(observed.operationId, fixture.token(observed)),
    typed('worker_not_found'),
  );

  const unread = requestFor({
    id: operationId('9'), type: 'research_launch', target: requesterTarget(), parameters: {}, now: fixture.clock.wall,
  });
  await fixture.worker.start(unread.operationId, fixture.token(unread), unread);
  await terminalStatus(fixture, unread);
  const live = requestFor({
    id: operationId('0'), type: 'research_launch', target: requesterTarget(),
    parameters: { live: true }, now: fixture.clock.wall,
  });
  await fixture.worker.start(live.operationId, fixture.token(live), live);
  fixture.clock.advance(UNREAD_TERMINAL_RETENTION_MS);
  await assert.rejects(
    () => fixture.worker.result(unread.operationId, fixture.token(unread)),
    typed('worker_not_found'),
  );
  assert.equal((await fixture.worker.status(live.operationId, fixture.token(live))).state, 'running');
  assert.equal(fixture.worker.records.has(unread.operationId), false);
  await fixture.worker.cancel(live.operationId, fixture.token(live));
  liveGate.resolve();
});

test('stop wins against an in-flight source open and cannot publish a later worker', async (t) => {
  const openStarted = deferred();
  const allowOpen = deferred();
  let releases = 0;
  let executions = 0;
  const sourcePins = {
    async openPinnedSource(descriptor) {
      openStarted.resolve();
      await allowOpen.promise;
      return {
        descriptor,
        revision: descriptor.cutoffRevision,
        async release() { releases += 1; },
      };
    },
  };
  const fixture = await makeFixture(t, {
    sourcePins,
    executors: new Map([['query', async () => {
      executions += 1;
      return { state: 'complete', result: {}, resultArtifact: null, error: null, sourceEvidence: {} };
    }]]),
  });
  const request = requestFor({ id: operationId('o') });
  const starting = fixture.worker.start(request.operationId, fixture.token(request), request);
  await openStarted.promise;
  const stopping = fixture.worker.stop();
  allowOpen.resolve();
  await stopping;
  await assert.rejects(() => starting, typed('worker_stopped'));
  assert.equal(fixture.worker.records.has(request.operationId), false);
  assert.equal(executions, 0);
  assert.equal(releases, 1);
});

test('all terminal paths share one cached process-pin release promise', async (t) => {
  const releases = new Map();
  const sourcePins = {
    async openPinnedSource(descriptor, expectations) {
      releases.set(expectations.operationId, 0);
      return {
        descriptor,
        revision: descriptor.cutoffRevision,
        getEvidence() { return {}; },
        async release() {
          releases.set(expectations.operationId, releases.get(expectations.operationId) + 1);
        },
      };
    },
  };
  const executors = new Map([['query', async ({ parameters }) => {
    if (parameters.throw === true) throw Object.assign(new Error('boom'), { code: 'executor_boom' });
    return {
      state: parameters.state,
      result: parameters.state === 'complete' ? { ok: true } : null,
      resultArtifact: null,
      error: parameters.state === 'failed' ? { code: 'expected', message: 'failed', retryable: false } : null,
      sourceEvidence: {},
    };
  }]]);
  const fixture = await makeFixture(t, { sourcePins, executors });
  let index = 0;
  for (const state of ['complete', 'partial', 'failed', 'cancelled', 'interrupted']) {
    const request = requestFor({
      id: operationId(String.fromCharCode(97 + index++)), parameters: { state },
    });
    await fixture.worker.start(request.operationId, fixture.token(request), request);
    await terminalStatus(fixture, request);
    await Promise.all(Array.from({ length: 32 }, (_, call) => call % 2 === 0
      ? fixture.worker.result(request.operationId, fixture.token(request)).catch(() => null)
      : fixture.worker.cancel(request.operationId, fixture.token(request))));
    assert.equal(releases.get(request.operationId), 1, state);
  }
  const thrown = requestFor({ id: operationId('q'), parameters: { throw: true } });
  await fixture.worker.start(thrown.operationId, fixture.token(thrown), thrown);
  const thrownStatus = await terminalStatus(fixture, thrown);
  assert.equal(thrownStatus.state, 'failed');
  assert.equal(releases.get(thrown.operationId), 1);

  const missing = requestFor({ id: operationId('r'), type: 'pgs' });
  await assert.rejects(
    () => fixture.worker.start(missing.operationId, fixture.token(missing), missing),
    typed('executor_unavailable'),
  );
  assert.equal(releases.has(missing.operationId), false);
});

async function writeLegacyResident(root) {
  await fsp.mkdir(root, { recursive: true });
  await writeJsonlGzAtomic(path.join(root, 'memory-nodes.jsonl.gz'), [
    { id: 'n1', concept: 'legacy canary' },
  ]);
  await writeJsonlGzAtomic(path.join(root, 'memory-edges.jsonl.gz'), []);
  await fsp.writeFile(path.join(root, 'memory-delta.jsonl'), '');
}

async function prepareLegacyResearchPin({ home23Root, targetRoot, operationId: id }) {
  await fsp.mkdir(targetRoot, { recursive: true });
  await fsp.writeFile(path.join(targetRoot, 'state.json'), JSON.stringify({
    memory: {
      nodes: [{ id: 'n1', concept: 'legacy research canary' }],
      edges: [],
    },
  }));
  const canonicalHome = await fsp.realpath(home23Root);
  const canonicalTarget = await fsp.realpath(targetRoot);
  const operationRoot = path.join(
    canonicalHome, 'instances', 'jerry', 'runtime', 'brain-operations', id,
  );
  const quota = await createOperationScratchQuota({ operationRoot });
  const projected = await projectLegacyResearchSnapshot({
    canonicalRoot: canonicalTarget,
    stateFile: path.join(canonicalTarget, 'state.json'),
    operationRoot,
    operationId: id,
    requesterAgent: 'jerry',
    scratchQuota: quota,
  });
  await quota.close();
  const digest = sourceDescriptorDigest(projected.descriptor);
  const physical = await fsp.lstat(projected.projectionRoot, { bigint: true });
  await fsp.writeFile(coordinatorPinPath(operationRoot), `${JSON.stringify({
    version: 1,
    operationId: id,
    requesterAgent: 'jerry',
    canonicalRoot: canonicalTarget,
    descriptor: projected.descriptor,
    digest,
    protectedFiles: [
      projected.manifest.activeBase.nodes.file,
      projected.manifest.activeBase.edges.file,
      projected.manifest.activeDelta.file,
    ],
    committedBytes: projected.manifest.activeDelta.committedBytes,
    physicalRoot: projected.projectionRoot,
    physicalRootIdentity: { dev: String(physical.dev), ino: String(physical.ino) },
    projectionRoot: projected.projectionRoot,
    sourceFingerprint: projected.sourceFingerprint,
  }, null, 2)}\n`);
  return { descriptor: projected.descriptor, digest };
}

async function hashTree(root) {
  const rows = [];
  async function walk(directory) {
    for (const name of (await fsp.readdir(directory)).sort()) {
      const full = path.join(directory, name);
      const stat = await fsp.lstat(full);
      const relative = path.relative(root, full);
      if (stat.isDirectory()) {
        rows.push(`dir:${relative}:${stat.mode}`);
        await walk(full);
      } else if (stat.isSymbolicLink()) {
        rows.push(`link:${relative}:${await fsp.readlink(full)}`);
      } else {
        const digest = crypto.createHash('sha256').update(await fsp.readFile(full)).digest('hex');
        rows.push(`file:${relative}:${stat.mode}:${stat.size}:${digest}`);
      }
    }
  }
  await walk(root);
  return rows.join('\n');
}

test('real native, legacy-resident, and legacy-research sources expose only numeric-v1 target descriptors and external pins', async (t) => {
  const home23Root = await tempDir('home23-worker-real-source-home-');
  const nativeRoot = path.join(home23Root, 'targets', 'native');
  const legacyRoot = path.join(home23Root, 'targets', 'legacy');
  const legacyResearchRoot = path.join(home23Root, 'targets', 'legacy-research');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(nativeRoot, { recursive: true });
  await Promise.all([
    rewriteMemoryBase(nativeRoot, {
      nodes: [{ id: 'n1', concept: 'native canary' }],
      edges: [],
      summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
    }, { lockRoot }),
    writeLegacyResident(legacyRoot),
  ]);
  const clock = makeClock();
  let nonce = 0;
  const gates = new Map();
  const worker = new BrainOperationWorker({
    home23Root,
    capabilityKey: KEY,
    resolveTarget: async ({ target }) => structuredClone(target),
    sourcePins: {
      async openPinnedSource(descriptor, expectations) {
        const provider = createMemorySourcePinProvider({
          home23Root,
          requesterAgent: expectations.requesterAgent,
        });
        return provider.openPinnedSource(descriptor, expectations);
      },
    },
    scratchQuotaFactory: createOperationScratchQuota,
    executors: new Map([['query', async (context) => {
      const nodes = [];
      for await (const node of context.sourcePin.iterateNodes()) nodes.push(node);
      await gates.get(context.operationId).promise;
      return {
        state: 'complete', result: { nodes: nodes.map((node) => node.concept) },
        resultArtifact: null, error: null, sourceEvidence: context.sourcePin.getEvidence(),
      };
    }]]),
    clock,
    processStartIdentity: 'real-provider-fixture',
  });
  t.after(async () => {
    await worker.stop().catch(() => {});
    await fsp.rm(home23Root, { recursive: true, force: true });
  });
  for (const [index, targetRoot] of [nativeRoot, legacyRoot, legacyResearchRoot].entries()) {
    const id = operationId(['s', 't', 'u'][index]);
    const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
    if (index === 2) {
      await fsp.mkdir(targetRoot, { recursive: true });
      await fsp.writeFile(path.join(targetRoot, 'state.json'), JSON.stringify({
        memory: {
          nodes: [{ id: 'n1', concept: 'legacy research canary' }],
          edges: [],
        },
      }));
    }
    const targetHashBefore = await hashTree(targetRoot);
    const pinned = index < 2
      ? await provider.pin(targetRoot, id)
      : await prepareLegacyResearchPin({ home23Root, targetRoot, operationId: id });
    const target = brainTarget(await fsp.realpath(targetRoot), {
      brainId: `brain-${index}`,
      route: `/api/brain/brain-${index}`,
    });
    const request = requestFor({
      id, target, descriptor: pinned.descriptor, digest: pinned.digest, now: clock.wall,
    });
    gates.set(id, deferred());
    const token = () => issueCapability(KEY, capabilityClaims(
      request, `real-${index}-${++nonce}`, {}, clock.wall,
    ));
    await worker.start(id, token(), request);
    await eventually(async () => {
      const discovered = await discoverOperationPinFiles(home23Root);
      assert.equal(discovered.some((entry) => entry.kind === 'process' && entry.operationId === id), true);
    });
    assert.equal(pinned.descriptor.version, 1);
    assert.equal(Number.isSafeInteger(pinned.descriptor.baseRevision), true);
    assert.equal(Number.isSafeInteger(pinned.descriptor.cutoffRevision), true);
    assert.equal(pinned.descriptor.canonicalRoot, await fsp.realpath(targetRoot));
    assert.equal(Object.hasOwn(pinned.descriptor, 'projectionRoot'), false);
    assert.equal(Object.hasOwn(pinned.descriptor, 'operationRoot'), false);
    assert.equal(Object.hasOwn(pinned.descriptor, 'lockRoot'), false);
    for (const file of [
      pinned.descriptor.activeBase.nodes.file,
      pinned.descriptor.activeBase.edges.file,
      pinned.descriptor.activeDelta.file,
    ]) assert.equal(path.basename(file), file);
    assert.equal(await fsp.access(path.join(targetRoot, '.memory-source.lock'))
      .then(() => true).catch(() => false), false);
    gates.get(id).resolve();
    await eventually(async () => {
      const status = await worker.status(id, token());
      assert.equal(status.state, 'complete');
    });
    const discovered = await discoverOperationPinFiles(home23Root);
    assert.equal(discovered.some((entry) => entry.kind === 'process' && entry.operationId === id), false);
    assert.equal(await hashTree(targetRoot), targetHashBefore);
  }
});

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(value) { this.body = value; this.ended = true; return this; },
    write(value) { this.chunks.push(String(value)); return true; },
    end(value = '') { if (value) this.chunks.push(String(value)); this.ended = true; },
  };
}

test('internal route handlers require bearer capabilities on start/status/events/result/cancel', async () => {
  const calls = [];
  const worker = {
    async start(id, capability, body) { calls.push(['start', id, capability, body]); return { ok: 'start' }; },
    async status(id, capability) { calls.push(['status', id, capability]); return { ok: 'status' }; },
    async *events(id, capability, input) {
      calls.push(['events', id, capability, input.afterSequence]);
      yield { type: 'progress', operationId: id, eventSequence: 1 };
    },
    async result(id, capability) { calls.push(['result', id, capability]); return { ok: 'result' }; },
    async cancel(id, capability) { calls.push(['cancel', id, capability]); return { ok: 'cancel' }; },
  };
  const handlers = createBrainOperationRouteHandlers({ worker });
  const id = operationId('m');
  const baseRequest = {
    params: { id },
    headers: { authorization: 'Bearer cap-1' },
    socket: { remoteAddress: '127.0.0.1' },
    get(name) { return this.headers[name.toLowerCase()]; },
    on() {},
  };
  for (const [name, request] of Object.entries({
    start: { ...baseRequest, body: { operationId: id } },
    status: { ...baseRequest },
    events: { ...baseRequest, query: { afterSequence: '0' } },
    result: { ...baseRequest },
    cancel: { ...baseRequest, body: {} },
  })) {
    const response = fakeResponse();
    await handlers[name](request, response);
    assert.equal(response.statusCode, 200, name);
  }
  assert.deepEqual(calls.map(([name]) => name), ['start', 'status', 'events', 'result', 'cancel']);
  assert.equal(calls.every((call) => call[2] === 'cap-1'), true);
  assert.match(fakeResponse().statusCode.toString(), /^200$/);

  const missing = fakeResponse();
  await handlers.status({ ...baseRequest, headers: {}, get() { return undefined; } }, missing);
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.error.code, 'capability_invalid');

  const remote = fakeResponse();
  await handlers.status({
    ...baseRequest,
    socket: { remoteAddress: '192.0.2.40' },
  }, remote);
  assert.equal(remote.statusCode, 403);
  assert.equal(remote.body.error.code, 'access_denied');

  const router = createBrainOperationRoutes({ worker });
  assert.equal(router instanceof express.Router().constructor, true);
  const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods),
  }));
  assert.deepEqual(routes, [
    { path: '/api/internal/brain-operations/:id/start', methods: ['post'] },
    { path: '/api/internal/brain-operations/:id/status', methods: ['get'] },
    { path: '/api/internal/brain-operations/:id/events', methods: ['get'] },
    { path: '/api/internal/brain-operations/:id/result', methods: ['get'] },
    { path: '/api/internal/brain-operations/:id/cancel', methods: ['post'] },
  ]);
});

test('internal events route honors response backpressure before pulling another event', async () => {
  let pulls = 0;
  const worker = {
    async start() {},
    async status() {},
    async *events(id) {
      pulls += 1;
      yield { type: 'progress', operationId: id, eventSequence: 1 };
      pulls += 1;
      yield { type: 'progress', operationId: id, eventSequence: 2 };
    },
    async result() {},
    async cancel() {},
  };
  const handlers = createBrainOperationRouteHandlers({ worker });
  const id = operationId('n');
  const request = new EventEmitter();
  Object.assign(request, {
    params: { id },
    query: { afterSequence: '0' },
    headers: { authorization: 'Bearer cap-backpressure' },
    socket: { remoteAddress: '::1' },
    get(name) { return this.headers[name.toLowerCase()]; },
  });
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    write(value) {
      this.chunks.push(String(value));
      return this.chunks.length !== 1;
    },
    end(value = '') {
      if (value) this.chunks.push(String(value));
      this.ended = true;
    },
  });

  const streaming = handlers.events(request, response);
  try {
    await eventually(() => assert.equal(response.chunks.length >= 1, true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.chunks.length, 1);
    assert.equal(pulls, 1);
    assert.equal(response.ended, false);
  } finally {
    response.emit('drain');
    await streaming;
  }
  assert.equal(response.chunks.length, 2);
  assert.equal(pulls, 2);
  assert.equal(response.ended, true);
});
