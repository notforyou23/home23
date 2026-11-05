import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  generationMarkerFromQuery,
  registerSynthesisCompatibilityRoutes,
} = require('../../../engine/src/dashboard/brain-operations/synthesis-compatibility-routes.js');

const DEFAULT_MARKER = 'generation-1-aaaaaaaaaaaaaaaaaaaaaaaa';

function committedState(operationId, overrides = {}) {
  return {
    operationId,
    generationMarker: DEFAULT_MARKER,
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceRevision: 1,
    provider: 'minimax',
    model: 'MiniMax-M3',
    brainStateSha256: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
}

function claimFromState(state) {
  return { version: 1, ...state };
}

function fixture(overrides = {}) {
  const routes = new Map();
  const starts = [];
  let stateReads = 0;
  let listReads = 0;
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
  const synthesisRuntime = overrides.synthesisRuntime === undefined ? {
    getReadiness: () => ({ ready: true, status: 'ready' }),
    async readState() {
      stateReads += 1;
      return overrides.committed === null
        ? null
        : overrides.committed;
    },
  } : overrides.synthesisRuntime;
  const store = overrides.store === undefined ? {
    async list() {
      listReads += 1;
      return overrides.operations || [];
    },
    async getSynthesisCompletionClaim(operationId) {
      return overrides.claims?.get(operationId) || null;
    },
  } : overrides.store;
  const coordinator = overrides.coordinator === undefined ? {
    async start(input) {
      starts.push(structuredClone(input));
      return { operationId: 'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', state: 'queued' };
    },
  } : overrides.coordinator;
  registerSynthesisCompatibilityRoutes({
    app,
    requesterAgent: 'jerry',
    synthesisRuntime,
    coordinator,
    store,
    now: () => 1234,
    randomBytes: () => Buffer.alloc(12, 7),
  });
  return {
    routes, starts,
    get stateReads() { return stateReads; },
    get listReads() { return listReads; },
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function invoke(fx, method, path, request) {
  const res = response();
  await fx.routes.get(`${method} ${path}`)(request, res);
  return res;
}

function operation(operationId, state, updatedAt, requesterAgent = 'jerry') {
  return {
    operationId,
    requestId: `request-${operationId}`,
    requesterAgent,
    operationType: 'synthesis',
    state,
    phase: state === 'running' ? 'synthesis' : 'terminal',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt,
    target: {
      domain: 'brain', accessMode: 'own', ownerAgent: requesterAgent,
    },
    result: null,
    sourcePinDescriptor: { secret: 'must not leak' },
  };
}

test('synthesis state reports authoritative generation status and bounded requester operations', async () => {
  const running = operation(
    'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdea',
    'running',
    '2026-07-10T00:00:01.000Z',
  );
  const complete = operation(
    'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdeb',
    'complete',
    '2026-07-10T00:00:02.000Z',
  );
  const state = committedState(complete.operationId);
  complete.result = { ...state };
  const fx = fixture({
    committed: state,
    claims: new Map([[complete.operationId, claimFromState(state)]]),
    operations: [
      operation('brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdec', 'running', '2026-07-10T00:00:03.000Z', 'cosmo'),
      complete,
      running,
      { ...complete, operationId: 'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcded', operationType: 'query' },
    ],
  });
  const marker = DEFAULT_MARKER;
  const matched = await invoke(fx, 'GET', '/api/synthesis/state', {
    query: { generationMarker: marker },
  });
  assert.equal(matched.statusCode, 200);
  assert.equal(matched.body.ready, true);
  assert.equal(matched.body.markerStatus, 'matched');
  assert.equal(matched.body.currentGenerationMarker, marker);
  assert.equal(matched.body.latestOperation.operationId, complete.operationId);
  assert.equal(matched.body.activeOperation.operationId, running.operationId);
  assert.equal(Object.hasOwn(matched.body.latestOperation, 'sourcePinDescriptor'), false);
  assert.equal(fx.stateReads, 1);
  assert.equal(fx.listReads, 1);
  assert.equal(fx.starts.length, 0);

  const changed = await invoke(fx, 'GET', '/api/synthesis/state', {
    query: { generationMarker: 'generation-0-bbbbbbbbbbbbbbbbbbbbbbbb' },
  });
  assert.equal(changed.body.markerStatus, 'changed');
  const unrequested = await invoke(fx, 'GET', '/api/synthesis/state', { query: {} });
  assert.equal(unrequested.body.markerStatus, 'unrequested');
  assert.equal(unrequested.body.requestedGenerationMarker, null);
});

test('absent committed state is distinct from an unrequested marker', async () => {
  const fx = fixture({ committed: null });
  const result = await invoke(fx, 'GET', '/api/synthesis/state', {
    query: { generationMarker: 'generation-1-aaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  assert.equal(result.body.currentGenerationMarker, null);
  assert.equal(result.body.markerStatus, 'absent');
  assert.equal(result.body.latestOperation, null);
  assert.equal(result.body.activeOperation, null);
});

test('state marker is exposed only for an exact complete or recoverable claimed operation', async () => {
  const operationId = 'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdee';
  const state = committedState(operationId);
  const exactClaim = claimFromState(state);
  const variants = [
    {
      label: 'failed',
      operations: [{ ...operation(operationId, 'failed', '2026-07-10T00:00:01.000Z'), result: { ...state } }],
      claims: new Map([[operationId, exactClaim]]),
    },
    {
      label: 'cancelled',
      operations: [{ ...operation(operationId, 'cancelled', '2026-07-10T00:00:01.000Z'), result: { ...state } }],
      claims: new Map([[operationId, exactClaim]]),
    },
    {
      label: 'interrupted',
      operations: [{ ...operation(operationId, 'interrupted', '2026-07-10T00:00:01.000Z'), result: { ...state } }],
      claims: new Map([[operationId, exactClaim]]),
    },
    {
      label: 'preclaim active',
      operations: [operation(operationId, 'running', '2026-07-10T00:00:01.000Z')],
      claims: new Map(),
    },
    {
      label: 'mismatched claim',
      operations: [operation(operationId, 'running', '2026-07-10T00:00:01.000Z')],
      claims: new Map([[operationId, { ...exactClaim, brainStateSha256: `sha256:${'c'.repeat(64)}` }]]),
    },
    {
      label: 'stale state',
      operations: [],
      claims: new Map(),
    },
  ];
  for (const variant of variants) {
    const fx = fixture({ committed: state, ...variant });
    const response = await invoke(fx, 'GET', '/api/synthesis/state', {
      query: { generationMarker: DEFAULT_MARKER },
    });
    assert.equal(response.body.currentGenerationMarker, null, variant.label);
    assert.equal(response.body.markerStatus, 'absent', variant.label);
  }

  const recoverable = fixture({
    committed: state,
    operations: [operation(operationId, 'running', '2026-07-10T00:00:01.000Z')],
    claims: new Map([[operationId, exactClaim]]),
  });
  const response = await invoke(recoverable, 'GET', '/api/synthesis/state', {
    query: { generationMarker: DEFAULT_MARKER },
  });
  assert.equal(response.body.currentGenerationMarker, DEFAULT_MARKER);
  assert.equal(response.body.markerStatus, 'matched');
});

test('state query rejects duplicate, unknown, blank, NUL, and oversized markers before reads', async () => {
  const fx = fixture();
  for (const query of [
    { generationMarker: ['g1', 'g2'] },
    { unknown: 'g1' },
    { generationMarker: '   ' },
    { generationMarker: 'g\0x' },
    { generationMarker: 'é'.repeat(129) },
  ]) {
    const result = await invoke(fx, 'GET', '/api/synthesis/state', { query });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'invalid_request');
  }
  assert.equal(fx.stateReads, 0);
  assert.equal(fx.listReads, 0);
  assert.equal(fx.starts.length, 0);
  assert.throws(() => generationMarkerFromQuery(Object.create(null, {
    generationMarker: { get() { throw new Error('accessor'); }, enumerable: true },
  })));
});

test('synthesis run starts one durable coordinator operation and returns 202', async () => {
  const fx = fixture();
  const result = await invoke(fx, 'POST', '/api/synthesis/run', {
    body: { trigger: 'manual', reason: 'operator request' },
  });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(result.body, {
    operationId: 'brop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
    state: 'queued',
  });
  assert.equal(fx.starts.length, 1);
  assert.equal(fx.starts[0].operationType, 'synthesis');
  assert.equal(fx.starts[0].target, undefined);
  assert.deepEqual(fx.starts[0].parameters, {
    trigger: 'manual', reason: 'operator request',
  });
  assert.match(fx.starts[0].requestId, /^synthesis-1234-/);
});

test('synthesis run rejects caller authority fields and unavailable runtimes without a start', async () => {
  const fx = fixture();
  for (const body of [
    { provider: 'alpha' },
    { model: 'shared' },
    { idempotencyKey: 'caller' },
    { sourcePinDescriptor: {} },
    { requesterAgent: 'cosmo' },
    { trigger: 'x'.repeat(257) },
  ]) {
    const result = await invoke(fx, 'POST', '/api/synthesis/run', { body });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'invalid_request');
  }
  assert.equal(fx.starts.length, 0);

  const unavailable = fixture({ synthesisRuntime: null });
  const result = await invoke(unavailable, 'POST', '/api/synthesis/run', { body: {} });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, 'synthesis_unavailable');
  assert.equal(unavailable.starts.length, 0);
});
