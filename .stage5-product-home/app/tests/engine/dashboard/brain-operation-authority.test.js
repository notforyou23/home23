import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  OPERATION_AUTHORITY,
  authorizeBrainOperation,
} = require('../../../shared/brain-operations/authority.cjs');

const EXPECTED_OPERATION_TYPES = [
  'ad_hoc_export',
  'graph',
  'graph_export',
  'pgs',
  'query',
  'research_compile',
  'research_continue',
  'research_intelligence',
  'research_launch',
  'research_stop',
  'research_watch',
  'search',
  'status',
  'synthesis',
];

const BOUNDARIES = Object.freeze([
  Object.freeze({ kind: 'brain', path: '/instances/jerry/brain' }),
  Object.freeze({ kind: 'run', path: '/instances/jerry/brain' }),
  Object.freeze({ kind: 'pgs', path: '/instances/jerry/brain/pgs-sessions' }),
  Object.freeze({ kind: 'session', path: '/instances/jerry/brain/sessions' }),
  Object.freeze({ kind: 'cache', path: '/instances/jerry/brain/cache' }),
  Object.freeze({ kind: 'export', path: '/instances/jerry/brain/exports' }),
  Object.freeze({ kind: 'agency', path: '/instances/jerry/brain/agency' }),
]);

function brainTarget(overrides = {}) {
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot: '/instances/jerry/brain',
    accessMode: 'own',
    ownerAgent: 'jerry',
    displayName: 'Jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: BOUNDARIES.map((entry) => ({ ...entry })),
    ...overrides,
  };
}

function runTarget(overrides = {}) {
  return {
    domain: 'owned-run',
    runId: 'run-1',
    canonicalRoot: '/instances/jerry/workspace/research/run-1',
    ownerAgent: 'jerry',
    runState: 'active',
    catalogRevision: 'catalog-1',
    route: '/api/research/runs/run-1',
    mutationBoundaries: BOUNDARIES.map((entry) => ({ ...entry })),
    ...overrides,
  };
}

function authorize(operationType, target) {
  return authorizeBrainOperation({ requesterAgent: 'jerry', operationType, target });
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test('authority matrix is the exact deeply frozen 14-row server policy', () => {
  assert.deepEqual(Object.keys(OPERATION_AUTHORITY).sort(), EXPECTED_OPERATION_TYPES);
  assert.equal(Object.isFrozen(OPERATION_AUTHORITY), true);
  for (const [operationType, policy] of Object.entries(OPERATION_AUTHORITY)) {
    assert.equal(Object.isFrozen(policy), true, operationType);
    assert.equal(typeof policy.requiresSourcePin, 'boolean', operationType);
    assert.equal(Object.isFrozen(policy.modes), true, operationType);
    if (policy.lifecycles) assert.equal(Object.isFrozen(policy.lifecycles), true, operationType);
    if (policy.runStates) assert.equal(Object.isFrozen(policy.runStates), true, operationType);
  }
  assert.deepEqual(OPERATION_AUTHORITY.ad_hoc_export, {
    domain: 'requester',
    requiresSourcePin: false,
    modes: ['own'],
    lifecycles: [],
    writes: 'requester-workspace-noncanonical',
    canonicalEvidence: false,
  });
});

test('ordinary brain rows authorize own, sibling resident, and completed read-only targets', () => {
  const ordinary = ['search', 'graph', 'status', 'query', 'pgs', 'graph_export', 'research_compile'];
  const variants = [
    brainTarget(),
    brainTarget({
      brainId: 'brain-forrest', canonicalRoot: '/instances/forrest/brain',
      ownerAgent: 'forrest', displayName: 'Forrest', accessMode: 'read-only',
    }),
    brainTarget({
      brainId: 'brain-research', canonicalRoot: '/runs/research-1', ownerAgent: 'jerry',
      displayName: 'Research', kind: 'research', lifecycle: 'completed', accessMode: 'read-only',
    }),
  ];
  for (const operationType of ordinary) {
    for (const target of variants) {
      assert.equal(authorize(operationType, target), OPERATION_AUTHORITY[operationType]);
    }
  }
});

test('brain authority derives access mode and fails closed on lifecycle or mode spoofing', () => {
  const denied = [
    brainTarget({ accessMode: 'read-only' }),
    brainTarget({ ownerAgent: 'forrest', accessMode: 'own' }),
    brainTarget({ kind: 'research', lifecycle: 'completed', accessMode: 'own' }),
    brainTarget({ kind: 'research', lifecycle: 'active', accessMode: 'read-only' }),
    brainTarget({ lifecycle: 'unavailable' }),
    brainTarget({ kind: 'research', lifecycle: 'resident' }),
    brainTarget({ kind: 'resident', lifecycle: 'completed', accessMode: 'read-only' }),
    brainTarget({ ownerAgent: null, accessMode: 'read-only' }),
    brainTarget({ mutationBoundaries: BOUNDARIES.slice(0, 6).map((entry) => ({ ...entry })) }),
    brainTarget({
      mutationBoundaries: BOUNDARIES.map((entry, index) => index === 6
        ? { kind: 'brain', path: entry.path }
        : { ...entry }),
    }),
  ];
  for (const target of denied) {
    assert.throws(() => authorize('query', target), hasCode('access_denied'));
  }
});

test('synthesis is own-resident only and research intelligence is completed-read-only only', () => {
  assert.equal(authorize('synthesis', brainTarget()), OPERATION_AUTHORITY.synthesis);
  assert.throws(() => authorize('synthesis', brainTarget({
    brainId: 'brain-forrest', ownerAgent: 'forrest', accessMode: 'read-only',
  })), hasCode('access_denied'));
  assert.throws(() => authorize('research_intelligence', brainTarget()), hasCode('access_denied'));
  const completed = brainTarget({
    brainId: 'brain-research', canonicalRoot: '/runs/research-1',
    kind: 'research', lifecycle: 'completed', accessMode: 'read-only',
  });
  assert.equal(authorize('research_intelligence', completed), OPERATION_AUTHORITY.research_intelligence);
});

test('owned-run authority enforces requester ownership and exact declared states', () => {
  const allowed = {
    research_continue: ['paused', 'failed', 'completed'],
    research_stop: ['starting', 'active', 'stopping'],
    research_watch: ['starting', 'active', 'paused', 'failed', 'completed', 'stopped'],
  };
  const allStates = ['starting', 'active', 'stopping', 'paused', 'failed', 'completed', 'stopped'];
  for (const [operationType, states] of Object.entries(allowed)) {
    for (const state of allStates) {
      const attempt = () => authorize(operationType, runTarget({ runState: state }));
      if (states.includes(state)) assert.equal(attempt(), OPERATION_AUTHORITY[operationType]);
      else assert.throws(attempt, hasCode('access_denied'));
    }
    assert.throws(
      () => authorize(operationType, runTarget({ ownerAgent: 'forrest' })),
      hasCode('access_denied'),
    );
  }
});

test('requester operations require the exact bound requester target', () => {
  const target = { domain: 'requester', requesterAgent: 'jerry' };
  assert.equal(authorize('research_launch', target), OPERATION_AUTHORITY.research_launch);
  assert.equal(authorize('ad_hoc_export', target), OPERATION_AUTHORITY.ad_hoc_export);
  for (const invalid of [
    { domain: 'requester', requesterAgent: 'forrest' },
    { domain: 'requester', requesterAgent: 'jerry', ownerAgent: 'jerry' },
    { domain: 'requester', requesterAgent: 'jerry', path: '/tmp/output' },
  ]) {
    assert.throws(() => authorize('ad_hoc_export', invalid), hasCode('access_denied'));
  }
});

test('malformed authority inputs and caller policy fields are rejected before authorization', () => {
  for (const input of [
    null,
    {},
    { requesterAgent: 'jerry', operationType: 'unknown', target: brainTarget() },
    { requesterAgent: '', operationType: 'query', target: brainTarget() },
    { requesterAgent: 'jerry', operationType: 'query', target: null },
    { requesterAgent: 'jerry', operationType: 'query', target: brainTarget(), policy: {} },
    { requesterAgent: 'jerry', operationType: 'query', target: brainTarget(), run: runTarget() },
  ]) {
    assert.throws(() => authorizeBrainOperation(input), hasCode('invalid_request'));
  }
  for (const field of ['writes', 'modes', 'requiresSourcePin', 'canonicalEvidence']) {
    assert.throws(
      () => authorize('query', { ...brainTarget(), [field]: field === 'modes' ? ['own'] : true }),
      hasCode('access_denied'),
    );
  }
});

test('authorization returns immutable server policy without request-derived fields', () => {
  const target = brainTarget();
  const policy = authorize('query', target);
  assert.equal(policy, OPERATION_AUTHORITY.query);
  assert.equal(Object.hasOwn(policy, 'target'), false);
  assert.equal(Object.hasOwn(policy, 'requesterAgent'), false);
  assert.throws(() => { policy.writes = 'target'; }, TypeError);
});
