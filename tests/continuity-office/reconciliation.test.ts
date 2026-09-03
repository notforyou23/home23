import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityOfficeError, createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';

function officeReadyToReconcile() {
  const continuity = createIsolatedContinuityOffice({
    now: () => new Date('2026-09-03T17:00:00.000Z'),
    owner: { token: 'owner-token', principalId: 'principal_owner', displayName: 'jtr' },
  });
  continuity.setOfficeHealth('headquarters', 'unavailable');
  continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });
  const capable = continuity.admitWork({
    kind: 'continuity_capable',
    channelId: 'channel_home',
    originMessageId: 'msg_origin',
    instruction: 'Draft the travel note.',
    requestId: 'request_capable',
    correlationId: 'correlation_capable',
  });
  continuity.completeContinuityWork({
    workId: capable.workId,
    resultText: 'Draft ready.',
    requestId: 'request_capable_done',
    correlationId: 'correlation_capable_done',
  });
  const waiting = continuity.admitWork({
    kind: 'local_only',
    channelId: 'channel_home',
    originMessageId: 'msg_wait',
    instruction: 'Use the Mini sauna tile.',
    requestId: 'request_wait',
    correlationId: 'correlation_wait',
  });
  return { continuity, capableWorkId: capable.workId, waitingWorkId: waiting.workId };
}

test('returns canonical write to headquarters without split-brain', () => {
  const { continuity } = officeReadyToReconcile();
  continuity.setOfficeHealth('headquarters', 'healthy');

  const reconciled = continuity.reconcileHeadquartersReturn();

  assert.equal(reconciled.authority.officeId, 'headquarters');
  assert.equal(reconciled.authority.epoch, 3);
  assert.equal(continuity.currentAuthority().officeId, 'headquarters');
  assert.throws(
    () => continuity.assertCanonicalWrite({
      officeId: 'continuity-office',
      epoch: 2,
      fencingToken: 2,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'stale_fence',
  );
  assert.throws(
    () => continuity.takeoverCanonicalWrite({
      officeId: 'continuity-office',
      expectedEpoch: 3,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'headquarters_available',
  );
});

test('delivers a continuity result once and ignores replay', () => {
  const { continuity, capableWorkId } = officeReadyToReconcile();
  continuity.setOfficeHealth('headquarters', 'healthy');

  const first = continuity.reconcileHeadquartersReturn();
  const second = continuity.reconcileHeadquartersReturn();

  assert.equal(first.deliveries.length, 1);
  assert.equal(first.deliveries[0]?.workId, capableWorkId);
  assert.equal(first.deliveries[0]?.kind, 'result');
  assert.equal(first.deliveries[0]?.idempotencyKey, `work-result:${capableWorkId}`);
  assert.equal(first.deliveries[0]?.replayed, false);
  assert.equal(second.deliveries.length, 1);
  assert.equal(second.deliveries[0]?.idempotencyKey, `work-result:${capableWorkId}`);
  assert.equal(second.deliveries[0]?.replayed, true);
  assert.equal(second.newlyDeliveredCount, 0);
  assert.equal(first.deliveries[0]?.resultDigest, second.deliveries[0]?.resultDigest);
});

test('keeps waiting local-only work waiting after headquarters returns', () => {
  const { continuity, waitingWorkId } = officeReadyToReconcile();
  continuity.setOfficeHealth('headquarters', 'healthy');

  const reconciled = continuity.reconcileHeadquartersReturn();
  const waiting = continuity.work(waitingWorkId);

  assert.equal(waiting?.presentation, 'waiting for headquarters');
  assert.equal(waiting?.state, 'queued');
  assert.equal(reconciled.waitingWorkIds.includes(waitingWorkId), true);
  assert.equal(reconciled.deliveries.some((delivery) => delivery.workId === waitingWorkId), false);
});
