'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildResearchRunTarget,
} = require('../../shared/brain-operations/research-run-target.cjs');
const {
  authorizeBrainOperation,
} = require('../../shared/brain-operations/authority.cjs');
const {
  validateTargetSnapshot,
} = require('../../engine/src/dashboard/brain-operations/operation-contract.js');

const ROOT = '/instances/jerry/workspace/research-runs/research-brop_0123456789abcdef0123456789abcdef';

function metadata(overrides = {}) {
  return {
    version: 1,
    runId: 'research-brop_0123456789abcdef0123456789abcdef',
    ownerAgent: 'jerry',
    operationId: 'brop_0123456789abcdef0123456789abcdef',
    canonicalRoot: ROOT,
    topic: 'Verify the exact evidence chain.',
    parameters: { topic: 'Verify the exact evidence chain.', cycles: 8 },
    state: 'active',
    createdAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-10T12:01:00.000Z',
    ...overrides,
  };
}

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test('builds the exact deeply frozen coordinator owned-run target and seven boundaries', () => {
  const target = buildResearchRunTarget(metadata());

  assert.deepEqual(Object.keys(target), [
    'domain',
    'runId',
    'canonicalRoot',
    'ownerAgent',
    'runState',
    'catalogRevision',
    'route',
    'mutationBoundaries',
  ]);
  assert.deepEqual(target, {
    domain: 'owned-run',
    runId: 'research-brop_0123456789abcdef0123456789abcdef',
    canonicalRoot: ROOT,
    ownerAgent: 'jerry',
    runState: 'active',
    catalogRevision: target.catalogRevision,
    route: '/api/research/runs/research-brop_0123456789abcdef0123456789abcdef',
    mutationBoundaries: [
      { kind: 'brain', path: ROOT },
      { kind: 'run', path: ROOT },
      { kind: 'pgs', path: path.join(ROOT, 'pgs-sessions') },
      { kind: 'session', path: path.join(ROOT, 'sessions') },
      { kind: 'cache', path: path.join(ROOT, 'cache') },
      { kind: 'export', path: path.join(ROOT, 'exports') },
      { kind: 'agency', path: path.join(ROOT, 'agency') },
    ],
  });
  assert.match(target.catalogRevision, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.mutationBoundaries), true);
  assert.equal(target.mutationBoundaries.every(Object.isFrozen), true);
});

test('target passes the coordinator contract and shared owned-run authority unchanged', () => {
  const target = buildResearchRunTarget(metadata());
  assert.deepEqual(validateTargetSnapshot(target, 'jerry'), structuredClone(target));
  assert.equal(
    authorizeBrainOperation({
      requesterAgent: 'jerry',
      operationType: 'research_watch',
      target,
    }).domain,
    'owned-run',
  );
});

test('catalog revision is canonical across key order and changes with canonical run state', () => {
  const first = metadata();
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  const firstTarget = buildResearchRunTarget(first);
  const reorderedTarget = buildResearchRunTarget(reordered);
  assert.equal(reorderedTarget.catalogRevision, firstTarget.catalogRevision);

  const stopped = buildResearchRunTarget(metadata({
    state: 'stopped',
    stoppedAt: '2026-07-10T12:10:00.000Z',
    updatedAt: '2026-07-10T12:10:00.000Z',
  }));
  assert.equal(stopped.runState, 'stopped');
  assert.notEqual(stopped.catalogRevision, firstTarget.catalogRevision);
});

test('derives route and boundaries server-side instead of accepting spoofed metadata projections', () => {
  const target = buildResearchRunTarget(metadata({
    domain: 'brain',
    route: '/outside',
    catalogRevision: 'caller-controlled',
    mutationBoundaries: [{ kind: 'run', path: '/outside' }],
    runState: 'failed',
  }));

  assert.equal(target.domain, 'owned-run');
  assert.equal(target.route.startsWith('/api/research/runs/'), true);
  assert.notEqual(target.catalogRevision, 'caller-controlled');
  assert.equal(target.runState, 'active');
  assert.equal(target.mutationBoundaries.length, 7);
  assert.equal(target.mutationBoundaries.every((entry) =>
    entry.path === ROOT || entry.path.startsWith(`${ROOT}${path.sep}`)), true);
});

test('rejects malformed identity, state, canonical root, unsafe objects, and oversized metadata', () => {
  for (const input of [
    null,
    [],
    metadata({ runId: '*' }),
    metadata({ ownerAgent: '../forrest' }),
    metadata({ state: 'running' }),
    metadata({ canonicalRoot: 'relative/run' }),
    metadata({ canonicalRoot: '/different/basename' }),
    metadata({ canonicalRoot: `${ROOT}/../${path.basename(ROOT)}` }),
    metadata({ topic: 'x'.repeat(256 * 1024) }),
  ]) {
    assert.throws(() => buildResearchRunTarget(input), hasCode('run_metadata_invalid'));
  }

  const accessor = metadata();
  Object.defineProperty(accessor, 'ownerAgent', {
    enumerable: true,
    get() { throw new Error('must not invoke metadata getters'); },
  });
  assert.throws(() => buildResearchRunTarget(accessor), hasCode('run_metadata_invalid'));
});
