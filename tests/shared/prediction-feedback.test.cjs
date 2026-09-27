'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { claimsRelated, getClaimFeedback, isExternalEvidenceRef } = require('../../shared/prediction-feedback.cjs');
const claim = 'Watcher process changes will increase contact tension within six hours';
function fixture() {
  return { predictions: [
    { predictionId: 'p1', claim, createdAt: '2026-09-25T00:00:00Z', resolvedAt: '2026-09-25T06:00:00Z', error: 0.9 },
    { predictionId: 'p2', claim: 'Contact tension will increase from watcher process changes during the next six hours', createdAt: '2026-09-25T07:00:00Z', resolvedAt: '2026-09-25T13:00:00Z', error: 0.95 },
  ], realityRefs: [{ refId: 'r1', head: 'A new measured watcher process failure followed the changed configuration.', observedAt: '2026-09-25T14:00:00Z', sourceRef: 'conversation.jtr:s', sourceAuthority: 'home23.event-ledger', flag: 'COLLECTED' }] };
}
const revision = { claim, evidenceRefs: ['r1'], revisesPredictionIds: ['p2'], revisionReason: 'A new measured process failure followed a changed configuration, unlike the earlier speculation.', createdAt: '2026-09-25T15:00:00Z' };
test('near repeats share feedback, but a common topic and unrelated creativity are not a family', () => {
  const cell = fixture();
  assert.equal(claimsRelated(claim, cell.predictions[1].claim), true);
  assert.equal(claimsRelated(claim, 'A watcher could inspire a musical character'), false);
  assert.equal(claimsRelated(claim, 'Contact tension sounds like a suspended chord'), false);
  assert.equal(getClaimFeedback(cell, claim).repeatedFailure, true);
  assert.equal(getClaimFeedback(cell, claim).failedHypothesis, true);
});
test('a revised failed hypothesis needs real newer external evidence, a latest-failure link and changed explanation', () => {
  assert.equal(getClaimFeedback(fixture(), revision).hasSupportedRevision, true);
  for (const patch of [{ evidenceRefs: ['invented'] }, { revisesPredictionIds: ['p1'] }, { revisionReason: '' }, { createdAt: '2026-09-25T12:00:00Z' }]) {
    assert.equal(getClaimFeedback(fixture(), { ...revision, ...patch }).hasSupportedRevision, false);
  }
  const stale = fixture(); stale.realityRefs[0].observedAt = '2026-09-25T12:00:00Z';
  assert.equal(getClaimFeedback(stale, revision).hasSupportedRevision, false);
});
test('self, peer, dream, engine thought, missing and unknown provenance cannot stand in for fresh evidence', () => {
  for (const sourceRef of ['conversation.self:s', 'conversation.jerry:s', 'conversation.coz:s', 'conversation.agent:s', 'conversation.peer:s', 'dream:d', 'thought:x', 'lobe:x', 'worker:x', 'unknown']) {
    const cell = fixture(); cell.realityRefs[0].sourceRef = sourceRef;
    assert.equal(getClaimFeedback(cell, revision).hasSupportedRevision, false, sourceRef);
  }
  for (const sourceAuthority of [undefined, 'unknown', 'seed.internal', 'home23.engine', 'home23.agent.loop']) {
    assert.equal(isExternalEvidenceRef({ ...fixture().realityRefs[0], sourceAuthority }), false);
  }
});
test('duplicated legacy rows do not manufacture repeated failure count', () => {
  const cell = fixture(); cell.predictions = [cell.predictions[0], { ...cell.predictions[0] }];
  assert.equal(getClaimFeedback(cell, claim).repeatedFailure, false);
});

test('new but unrelated owner contact is not evidence for reopening a failed hypothesis', () => {
  const cell = fixture(); cell.realityRefs[0].head = 'I played my guitar and found a lovely new chord progression.';
  assert.equal(getClaimFeedback(cell, revision).hasSupportedRevision, false);
  assert.deepEqual(getClaimFeedback(cell, revision).freshEvidenceRefs, []);
});

test('execution receipts are grounded contact without upgrading task verification or accepting dispatch as success', () => {
  const base = { ...fixture().realityRefs[0], sourceRef: 'action:receipt-1', executionOutcome: {
    schema: 'home23.execution-outcome.v1', executionKind: 'action', status: 'completed',
    verificationStatus: 'unknown', receiptEventId: 'ledger-event-1', evidenceRefs: ['action-receipt:1'],
  }};
  assert.equal(isExternalEvidenceRef(base), true, 'an actual execution is evidence of execution, with unverified scope still visible');
  assert.equal(isExternalEvidenceRef({ ...base, sourceRef: 'coordination.work:work-1', executionOutcome: { ...base.executionOutcome, executionKind: 'work' } }), true);
  for (const status of ['queued', 'dispatched', 'simulated', 'unknown', 'cancelled']) {
    assert.equal(isExternalEvidenceRef({ ...base, executionOutcome: { ...base.executionOutcome, status } }), false);
  }
  assert.equal(isExternalEvidenceRef({ ...base, executionOutcome: undefined }), false, 'prefix alone is not provenance');
  assert.equal(isExternalEvidenceRef({ ...base, sourceAuthority: 'home23.engine' }), false);
});
