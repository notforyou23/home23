'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectAnnLabel } = require('../../shared/ann-label-contract.cjs');

test('ANN label carries only bounded retrieval authority summaries', () => {
  const label = projectAnnLabel({
    id: 'grounded',
    concept: 'current verified canary',
    retrievalDomain: 'current_ops',
    authorityClass: 'verified_current_state',
    semanticTime: '2026-07-14T12:00:00.000Z',
    status: 'current',
    sourceChain: ['must', 'not', 'be', 'copied'],
    evidencePresent: true,
  });
  assert.deepEqual({
    retrievalDomain: label.retrievalDomain,
    authorityClass: label.authorityClass,
    semanticTime: label.semanticTime,
    status: label.status,
    evidencePresent: label.evidencePresent,
    sourceChain: label.sourceChain,
  }, {
    retrievalDomain: 'current_ops',
    authorityClass: 'verified_current_state',
    semanticTime: '2026-07-14T12:00:00.000Z',
    status: 'current',
    evidencePresent: false,
    sourceChain: undefined,
  });
});

test('ANN authority summaries are byte bounded', () => {
  const label = projectAnnLabel({
    id: 'bounded',
    concept: 'bounded',
    retrievalDomain: 'x'.repeat(1000),
    authorityClass: 'y'.repeat(1000),
    semanticTime: 'z'.repeat(1000),
    status: 's'.repeat(1000),
    evidencePresent: 'not-a-boolean',
  });
  for (const field of ['retrievalDomain', 'authorityClass', 'semanticTime', 'status']) {
    assert.equal(Buffer.byteLength(label[field], 'utf8') <= 128, true);
  }
  assert.equal(label.evidencePresent, false);
});

test('ANN labels retain only bounded authority relation refs needed for closure and correction', () => {
  const label = projectAnnLabel({
    id: 'correction', concept: 'jtr corrected the active claim',
    authorityClass: 'jtr_correction',
    evidencePresent: true,
    authorityRelations: {
      refs: ['incident:brain-route'],
      supersedes: ['node:old-claim'],
    },
  }, { trustedProjection: true });
  assert.deepEqual(label.authorityRelations, {
    refs: ['node:correction', 'incident:brain-route'],
    supersedes: ['node:old-claim'],
  });
  assert.equal(Object.hasOwn(label, 'metadata'), false);
});

test('ANN labels retain at most two path-safe source-chain refs without treating them as proof', () => {
  const label = projectAnnLabel({
    id: 'source-chain', concept: 'bounded evidence refs',
    sourceChain: [
      { kind: 'source', ref: '/Volumes/Private Brain/current/source.json' },
      { kind: 'evidence', ref: 'file:///opt/home23/private/receipt.json' },
      { kind: 'trace', ref: `trace:${'x'.repeat(1000)}` },
    ],
    authorityClass: 'verified_current_state',
    evidencePresent: true,
  });

  assert.equal(label.sourceChain.length, 2);
  assert.ok(label.sourceChain.every((entry) => entry.ref.length <= 240));
  assert.ok(label.sourceChain.every((entry) => !entry.ref.includes('/Volumes/')));
  assert.ok(label.sourceChain.every((entry) => !entry.ref.includes('/opt/')));
  assert.equal(label.evidencePresent, false);
});

test('ANN source-chain redaction preserves URLs and typed refs', () => {
  const label = projectAnnLabel({
    id: 'typed-source-chain', concept: 'typed evidence refs',
    sourceChain: [
      { kind: 'source', ref: 'https://example.com/evidence/receipt.json' },
      { kind: 'closure', ref: 'incident:/brain-route' },
    ],
  });

  assert.deepEqual(label.sourceChain, [
    { kind: 'source', ref: 'https://example.com/evidence/receipt.json' },
    { kind: 'closure', ref: 'incident:/brain-route' },
  ]);
});

test('ANN source-chain redaction removes typed absolute local refs', () => {
  const label = projectAnnLabel({
    id: 'typed-local-source-chain', concept: 'typed local evidence refs',
    sourceChain: [
      { kind: 'artifact', ref: 'artifact:/Users/jtr/private/receipt.json' },
      { kind: 'source', ref: 'source:/Volumes/PrivateBrain/current/manifest.json' },
    ],
  });

  assert.deepEqual(label.sourceChain, [
    { kind: 'artifact', ref: 'artifact:[redacted-path]/receipt.json' },
    { kind: 'source', ref: 'source:[redacted-path]/manifest.json' },
  ]);
});
