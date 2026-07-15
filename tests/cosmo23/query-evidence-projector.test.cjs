'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectQueryEvidenceEdge,
  projectQueryEvidenceNode,
  projectionRecordLimits,
} = require('../../cosmo23/lib/query-evidence-projector');

test('query evidence node projection keeps only bounded answer evidence', () => {
  const projected = projectQueryEvidenceNode({
    id: 'node-1',
    title: 'Important finding',
    content: `brain evidence ${'🧠'.repeat(4_000)} /Users/jtr/private/brain.json`,
    type: 'finding',
    tags: ['alpha', 'beta'],
    salience: 0.95,
    timestamp: '2026-07-14T20:00:00.000Z',
    embedding: new Array(1_536).fill(0.25),
    metadata: {
      source: 'jerry',
      privatePath: '/Users/jtr/private/brain.json',
      blob: 'z'.repeat(64 * 1024),
    },
  }, projectionRecordLimits('dive'));
  const serialized = JSON.stringify(projected.value);

  assert.equal(projected.value.id, 'node-1');
  assert.equal(projected.value.type, 'finding');
  assert.deepEqual(projected.value.tags, ['alpha', 'beta']);
  assert.equal(projected.value.contentTruncated, true);
  assert.equal(serialized.includes('/Users/jtr/private'), false);
  assert.equal(serialized.includes('embedding'), false);
  assert.equal(serialized.includes('blob'), false);
  assert.equal(projected.bytes <= projectionRecordLimits('dive').maxRecordBytes, true);
  assert.doesNotThrow(() => Buffer.from(serialized, 'utf8').toString('utf8'));
});

test('unsigned Query evidence redacts arbitrary absolute POSIX paths without corrupting URLs or typed refs', () => {
  const projected = projectQueryEvidenceNode({
    id: 'portable-paths',
    content: [
      'receipt=/Volumes/PrivateBrain/runtime/secret.json',
      'log=/var/tmp/private.log',
      'url=https://example.com/evidence/receipt.json',
      'api=http://localhost:5002/api/state',
      'protocol=//example.com/a/b',
      'incident=incident:/var/outage',
      'goal=goal:/home/recovery',
      'node=node:/Users/incident/one',
      'source=source:/manifest-v1',
      'private-source=source:/data/private/secret.json',
      'file-one=file:/secret',
      'file-host=FILE://NAS/share/secret.json',
    ].join(' | '),
  }, projectionRecordLimits('full'));

  assert.doesNotMatch(projected.value.content, /\/Volumes\/PrivateBrain|\/var\/tmp/);
  assert.match(projected.value.content, /https:\/\/example\.com\/evidence\/receipt\.json/);
  assert.match(projected.value.content, /http:\/\/localhost:5002\/api\/state/);
  assert.match(projected.value.content, /protocol=\/\/example\.com\/a\/b/);
  assert.match(projected.value.content, /incident:\/var\/outage/);
  assert.match(projected.value.content, /goal:\/home\/recovery/);
  assert.match(projected.value.content, /node:\/Users\/incident\/one/);
  assert.match(projected.value.content, /source:\/manifest-v1/);
  assert.doesNotMatch(projected.value.content, /source:\/data\/private/);
  assert.doesNotMatch(projected.value.content, /file:|nas\/share/iu);
  assert.equal((projected.value.content.match(/\[redacted-path\]/g) || []).length, 5);
});

test('query evidence edge projection keeps endpoints and bounded relationship evidence', () => {
  const projected = projectQueryEvidenceEdge({
    source: 'node-1',
    target: 'node-2',
    type: 'supports',
    evidence: `linked evidence ${'x'.repeat(8 * 1024)}`,
    vector: [0.1, 0.2],
    metadata: { providerPayload: 'must not cross' },
  }, projectionRecordLimits('full'));

  assert.equal(projected.value.source, 'node-1');
  assert.equal(projected.value.target, 'node-2');
  assert.equal(projected.value.type, 'supports');
  assert.equal(projected.value.contentTruncated, true);
  assert.equal(JSON.stringify(projected.value).includes('providerPayload'), false);
  assert.equal(projected.bytes <= projectionRecordLimits('full').maxRecordBytes, true);
});

test('query evidence projection rejects accessors and cycles without invoking getters', () => {
  let getterCalls = 0;
  const accessor = { id: 'unsafe', content: 'evidence' };
  Object.defineProperty(accessor, 'metadata', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { source: 'unsafe' };
    },
  });
  assert.throws(
    () => projectQueryEvidenceNode(accessor, projectionRecordLimits('full')),
    error => error?.code === 'source_invalid',
  );
  assert.equal(getterCalls, 0);

  const cycle = { id: 'cycle', content: 'evidence', metadata: {} };
  cycle.metadata.self = cycle;
  assert.throws(
    () => projectQueryEvidenceNode(cycle, projectionRecordLimits('full')),
    error => error?.code === 'source_invalid',
  );
});

test('projection record limits are immutable and exact-mode only', () => {
  for (const mode of ['quick', 'full', 'expert', 'dive']) {
    const limits = projectionRecordLimits(mode);
    assert.equal(Object.isFrozen(limits), true);
    assert.equal(limits.maxContentBytes > 0, true);
    assert.equal(limits.maxRecordBytes > limits.maxContentBytes, true);
  }
  assert.throws(
    () => projectionRecordLimits('normal'),
    error => error?.code === 'invalid_request',
  );
});
