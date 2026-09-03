import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityOfficeError, createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';

function isolatedWithContinuityWrite() {
  const continuity = createIsolatedContinuityOffice({
    now: () => new Date('2026-09-03T17:00:00.000Z'),
    owner: { token: 'owner-token', principalId: 'principal_owner', displayName: 'jtr' },
  });
  continuity.setOfficeHealth('headquarters', 'unavailable');
  continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });
  return continuity;
}

test('labels local-only work waiting for headquarters while headquarters is unavailable', () => {
  const continuity = isolatedWithContinuityWrite();
  const admitted = continuity.admitWork({
    kind: 'local_only',
    channelId: 'channel_home',
    originMessageId: 'msg_origin',
    instruction: 'Toggle the sauna from the Mini.',
    requestId: 'request_1',
    correlationId: 'correlation_1',
  });

  assert.equal(admitted.state, 'queued');
  assert.equal(admitted.presentation, 'waiting for headquarters');
  assert.equal(admitted.officeId, 'continuity-office');
  assert.equal(admitted.attemptId, null);
  assert.notEqual(admitted.presentation, 'succeeded');
  assert.notEqual(admitted.presentation, 'completed');
});

test('never presents waiting local-only work as completed', () => {
  const continuity = isolatedWithContinuityWrite();
  const admitted = continuity.admitWork({
    kind: 'local_only',
    channelId: 'channel_home',
    originMessageId: 'msg_origin',
    instruction: 'Read the private brain and summarize sleep.',
    requestId: 'request_2',
    correlationId: 'correlation_2',
  });

  assert.throws(
    () => continuity.completeContinuityWork({
      workId: admitted.workId,
      resultText: 'Done.',
      requestId: 'request_2b',
      correlationId: 'correlation_2b',
    }),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'illegal_state',
  );
  assert.equal(continuity.work(admitted.workId)?.presentation, 'waiting for headquarters');
  assert.equal(continuity.work(admitted.workId)?.state, 'queued');
});

test('allows continuity-capable work to finish at the continuity office', () => {
  const continuity = isolatedWithContinuityWrite();
  const admitted = continuity.admitWork({
    kind: 'continuity_capable',
    channelId: 'channel_home',
    originMessageId: 'msg_origin',
    instruction: 'Draft the travel note from recent conversation.',
    requestId: 'request_3',
    correlationId: 'correlation_3',
  });

  assert.equal(admitted.state, 'running');
  assert.equal(admitted.presentation, 'accepted by a continuity office');
  assert.ok(admitted.attemptId);
  assert.ok(admitted.leaseId);
  assert.ok(admitted.fencingToken >= 1);

  const completed = continuity.completeContinuityWork({
    workId: admitted.workId,
    resultText: 'Draft ready.',
    requestId: 'request_3b',
    correlationId: 'correlation_3b',
  });

  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.presentation, 'succeeded');
  assert.ok(completed.resultDigest);
  assert.equal(completed.officeId, 'continuity-office');
});
