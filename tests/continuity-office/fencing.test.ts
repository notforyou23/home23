import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityOfficeError, createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';

test('refuses continuity takeover while headquarters is healthy', () => {
  const continuity = createIsolatedContinuityOffice();
  assert.equal(continuity.currentAuthority().officeId, 'headquarters');
  assert.equal(continuity.currentAuthority().epoch, 1);

  assert.throws(
    () => continuity.takeoverCanonicalWrite({
      officeId: 'continuity-office',
      expectedEpoch: 1,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'headquarters_available',
  );
  assert.equal(continuity.currentAuthority().officeId, 'headquarters');
});

test('lets the continuity office take canonical write when headquarters is unavailable', () => {
  const continuity = createIsolatedContinuityOffice();
  continuity.setOfficeHealth('headquarters', 'unavailable');

  const taken = continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });

  assert.equal(taken.officeId, 'continuity-office');
  assert.equal(taken.epoch, 2);
  assert.equal(taken.fencingToken, 2);
  assert.equal(continuity.currentAuthority().officeId, 'continuity-office');
});

test('fences the previous writer after takeover', () => {
  const continuity = createIsolatedContinuityOffice();
  const prior = continuity.currentAuthority();
  continuity.setOfficeHealth('headquarters', 'unavailable');
  continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: prior.epoch,
  });

  assert.throws(
    () => continuity.assertCanonicalWrite({
      officeId: prior.officeId,
      epoch: prior.epoch,
      fencingToken: prior.fencingToken,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'stale_fence',
  );
  continuity.assertCanonicalWrite({
    officeId: 'continuity-office',
    epoch: 2,
    fencingToken: 2,
  });
});

test('rejects admit and complete that carry a stale fencing token', () => {
  const continuity = createIsolatedContinuityOffice();
  continuity.setOfficeHealth('headquarters', 'unavailable');
  const first = continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });
  const admitted = continuity.admitWork({
    kind: 'continuity_capable',
    channelId: 'channel_home',
    originMessageId: 'msg_fence',
    instruction: 'Draft under the first fence.',
    requestId: 'request_fence',
    correlationId: 'correlation_fence',
    epoch: first.epoch,
    fencingToken: first.fencingToken,
  });

  const second = continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: first.epoch,
  });

  assert.throws(
    () => continuity.admitWork({
      kind: 'continuity_capable',
      channelId: 'channel_home',
      originMessageId: 'msg_stale_admit',
      instruction: 'Admit after takeover.',
      requestId: 'request_stale_admit',
      correlationId: 'correlation_stale_admit',
      epoch: first.epoch,
      fencingToken: first.fencingToken,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'stale_fence',
  );
  assert.throws(
    () => continuity.completeContinuityWork({
      workId: admitted.workId,
      resultText: 'Late finish.',
      requestId: 'request_stale_complete',
      correlationId: 'correlation_stale_complete',
      epoch: first.epoch,
      fencingToken: first.fencingToken,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'stale_fence',
  );
  assert.throws(
    () => continuity.completeContinuityWork({
      workId: admitted.workId,
      resultText: 'Finish under the new fence.',
      requestId: 'request_fenced_generation',
      correlationId: 'correlation_fenced_generation',
      epoch: second.epoch,
      fencingToken: second.fencingToken,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'stale_fence',
  );
  assert.equal(continuity.work(admitted.workId)?.state, 'running');
});

test('lets only one of two takeovers win so both offices cannot hold the pen', () => {
  const continuity = createIsolatedContinuityOffice();
  continuity.setOfficeHealth('headquarters', 'unavailable');

  const first = continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });
  assert.throws(
    () => continuity.takeoverCanonicalWrite({
      officeId: 'headquarters',
      expectedEpoch: 1,
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'stale_fence',
  );

  assert.equal(first.officeId, 'continuity-office');
  assert.equal(continuity.currentAuthority().officeId, 'continuity-office');
  assert.notEqual(continuity.currentAuthority().officeId, 'headquarters');
});
