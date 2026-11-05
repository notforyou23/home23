import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTrustExplanation,
  parseTrustValue,
} from '../../cli/lib/trust-commands.js';

test('formatTrustExplanation prints safe inheritance status and evidence', () => {
  const text = formatTrustExplanation({
    claimId: 'from-the-inside.issue.099.published',
    status: 'known_verified',
    safeToInherit: true,
    claim: {
      subject: 'from-the-inside/099',
      predicate: 'published',
      value: true,
      observedAt: '2026-05-08T12:00:00.000Z',
      verifier: 'verify-from-the-inside-publish',
      privacyClass: 'public_artifact',
      scope: 'public_artifact',
    },
    evidence: [{
      verified: true,
      receiptId: 'ev_099',
      path: '/tmp/099.evidence.json',
      result: 'pass',
    }],
    conflicts: [],
    reasons: [],
    freshness: { stale: false, ttlMs: null },
    recommendedAction: null,
  });

  assert.match(text, /Status: known_verified/);
  assert.match(text, /Safe to inherit: yes/);
  assert.match(text, /Claim: from-the-inside\/099 published=true/);
  assert.match(text, /\[pass\] ev_099/);
  assert.match(text, /Conflicts: none/);
});

test('parseTrustValue accepts JSON values and falls back to strings', () => {
  assert.equal(parseTrustValue('true'), true);
  assert.equal(parseTrustValue('0'), 0);
  assert.deepEqual(parseTrustValue('{"open":0}'), { open: 0 });
  assert.equal(parseTrustValue('repair'), 'repair');
});
