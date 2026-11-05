import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VerificationFlag,
  isVerifiedObservation,
  isZeroContext,
  isCollected,
} from '../../src/agent/verification.js';

test('VerificationFlag enum has the four required values', () => {
  assert.equal(VerificationFlag.COLLECTED, 'COLLECTED');
  assert.equal(VerificationFlag.UNCERTIFIED, 'UNCERTIFIED');
  assert.equal(VerificationFlag.ZERO_CONTEXT, 'ZERO_CONTEXT');
  assert.equal(VerificationFlag.UNKNOWN, 'UNKNOWN');
});

test('isVerifiedObservation recognizes a valid observation', () => {
  const obs = {
    channelId: 'build.git',
    sourceRef: 'commit:abc123',
    receivedAt: '2026-04-21T15:00:00Z',
    producedAt: '2026-04-21T15:00:00Z',
    flag: VerificationFlag.COLLECTED,
    confidence: 0.9,
    payload: { sha: 'abc123' },
  };
  assert.equal(isVerifiedObservation(obs), true);
});

test('isVerifiedObservation rejects a malformed observation', () => {
  assert.equal(isVerifiedObservation(null), false);
  assert.equal(isVerifiedObservation({}), false);
  assert.equal(isVerifiedObservation({ channelId: 'x', sourceRef: 'y' }), false);
});

test('isZeroContext distinguishes ZERO_CONTEXT from other flags', () => {
  assert.equal(isZeroContext({ flag: VerificationFlag.ZERO_CONTEXT } as any), true);
  assert.equal(isZeroContext({ flag: VerificationFlag.COLLECTED } as any), false);
});

test('isCollected only true for COLLECTED', () => {
  assert.equal(isCollected({ flag: VerificationFlag.COLLECTED } as any), true);
  assert.equal(isCollected({ flag: VerificationFlag.UNCERTIFIED } as any), false);
});
