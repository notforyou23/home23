import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityOfficeError, createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';

test('registers headquarters and the continuity office with health and capabilities', () => {
  const continuity = createIsolatedContinuityOffice();
  const offices = continuity.listOffices();

  assert.deepEqual(offices.map((entry) => entry.officeId).sort(), [
    'continuity-office',
    'headquarters',
  ]);
  assert.equal(continuity.office('headquarters')?.health, 'healthy');
  assert.equal(continuity.office('headquarters')?.role, 'headquarters');
  assert.ok(continuity.office('headquarters')?.capabilities.includes('local_only_work'));
  assert.equal(continuity.office('continuity-office')?.health, 'healthy');
  assert.equal(continuity.office('continuity-office')?.role, 'continuity');
  assert.ok(continuity.office('continuity-office')?.capabilities.includes('conversation'));
  assert.ok(continuity.office('continuity-office')?.capabilities.includes('continuity_work'));
  assert.equal(continuity.office('continuity-office')?.capabilities.includes('local_only_work'), false);
});

test('refuses continuity-office private-brain or household-credential capabilities', () => {
  const continuity = createIsolatedContinuityOffice();

  assert.throws(
    () => continuity.declareCapabilities('continuity-office', [
      'conversation',
      'private_brain',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof ContinuityOfficeError);
      assert.equal(error.code, 'illegal_capability');
      return true;
    },
  );
  assert.throws(
    () => continuity.declareCapabilities('continuity-office', [
      'conversation',
      'household_credentials',
    ]),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'illegal_capability',
  );
  assert.ok(!continuity.office('continuity-office')?.capabilities.includes('private_brain'));
});

test('reports office health changes without inventing a second resident', () => {
  const continuity = createIsolatedContinuityOffice();

  const unavailable = continuity.setOfficeHealth('headquarters', 'unavailable');
  assert.equal(unavailable.health, 'unavailable');
  assert.equal(continuity.office('continuity-office')?.role, 'continuity');
  assert.notEqual(continuity.office('continuity-office')?.role, 'headquarters');
});
