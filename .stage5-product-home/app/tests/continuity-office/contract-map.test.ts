import test from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';
import { mapContinuityWorkToCurrentContract } from '../../src/coordination-adapter/continuity-office/contract-map.js';

test('maps local waiting work onto current queued Work fields and work-result idempotency', () => {
  const continuity = createIsolatedContinuityOffice({
    now: () => new Date('2026-09-03T17:00:00.000Z'),
    owner: { token: 'owner-token', principalId: 'principal_owner', displayName: 'jtr' },
  });
  continuity.setOfficeHealth('headquarters', 'unavailable');
  continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });
  const waiting = continuity.admitWork({
    kind: 'local_only',
    channelId: 'channel_home',
    originMessageId: 'msg_origin',
    instruction: 'Touch household machinery.',
    requestId: 'request_map',
    correlationId: 'correlation_map',
    epoch: continuity.currentAuthority().epoch,
    fencingToken: continuity.currentAuthority().fencingToken,
  });

  const mapped = mapContinuityWorkToCurrentContract(continuity.work(waiting.workId)!);

  assert.equal(mapped.work.state, 'queued');
  assert.equal(mapped.work.originMessageId, 'msg_origin');
  assert.equal(mapped.work.channelId, 'channel_home');
  assert.equal(mapped.work.currentAttemptId, null);
  assert.equal(mapped.presentation, 'waiting for headquarters');
  assert.equal(mapped.resultIdempotencyKey, `work-result:${waiting.workId}`);
  assert.equal(mapped.work.nextFencingToken, 1);
  assert.equal(mapped.localOnlyFields.officeId, 'continuity-office');
  assert.equal(mapped.localOnlyFields.contextRevision, undefined);
});

test('maps nextFencingToken as the next token to issue, not the live attempt fence', () => {
  const continuity = createIsolatedContinuityOffice({
    now: () => new Date('2026-09-03T17:00:00.000Z'),
    owner: { token: 'owner-token', principalId: 'principal_owner', displayName: 'jtr' },
  });
  continuity.setOfficeHealth('headquarters', 'unavailable');
  const authority = continuity.takeoverCanonicalWrite({
    officeId: 'continuity-office',
    expectedEpoch: 1,
  });
  const running = continuity.admitWork({
    kind: 'continuity_capable',
    channelId: 'channel_home',
    originMessageId: 'msg_origin',
    instruction: 'Draft from recent conversation.',
    requestId: 'request_map_running',
    correlationId: 'correlation_map_running',
    epoch: authority.epoch,
    fencingToken: authority.fencingToken,
  });

  const mapped = mapContinuityWorkToCurrentContract(continuity.work(running.workId)!);

  assert.equal(running.fencingToken, 2);
  assert.equal(mapped.work.currentAttemptId, running.attemptId);
  assert.equal(mapped.work.nextFencingToken, 3);
  assert.notEqual(mapped.work.nextFencingToken, running.fencingToken);
});
