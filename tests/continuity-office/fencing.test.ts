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
