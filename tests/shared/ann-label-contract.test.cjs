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
    evidencePresent: true,
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
  assert.equal(label.evidencePresent, undefined);
});
