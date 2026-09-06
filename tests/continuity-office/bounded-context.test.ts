import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityOfficeError, createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';

const FRESHNESS = {
  contextRevision: 1,
  capturedAt: '2026-09-03T17:00:00.000Z',
  sourceCursor: 'evt:12',
} as const;

test('stores a bounded continuity context with required surfaces and freshness', () => {
  const continuity = createIsolatedContinuityOffice({
    now: () => new Date('2026-09-03T17:00:00.000Z'),
  });

  const snapshot = continuity.seedContext({
    charterSummary: 'Jerry is the Regina household resident.',
    relationshipSummary: 'jtr is the owner; speak plainly.',
    recentConversation: [
      { messageId: 'msg_1', role: 'owner', text: 'Start the long assignment.', at: '2026-09-03T16:59:00.000Z' },
    ],
    activeWork: [
      { workId: 'work_1', kind: 'continuity_capable', state: 'running', originMessageId: 'msg_1' },
    ],
    authorityLimits: {
      canWriteCanonical: false,
      allowedWorkKinds: ['continuity_capable'],
      forbiddenExports: ['private_brain', 'household_credentials'],
    },
    freshness: FRESHNESS,
  });

  assert.equal(snapshot.charterSummary, 'Jerry is the Regina household resident.');
  assert.equal(snapshot.relationshipSummary, 'jtr is the owner; speak plainly.');
  assert.equal(snapshot.recentConversation.length, 1);
  assert.equal(snapshot.activeWork[0]?.workId, 'work_1');
  assert.deepEqual(snapshot.authorityLimits.forbiddenExports, [
    'private_brain',
    'household_credentials',
  ]);
  assert.deepEqual(snapshot.freshness, FRESHNESS);
  assert.equal(continuity.context()?.freshness.contextRevision, 1);
});

test('refuses private brain or household credential export in the snapshot', () => {
  const continuity = createIsolatedContinuityOffice();

  assert.throws(
    () => continuity.seedContext({
      charterSummary: 'Jerry.',
      relationshipSummary: 'Owner.',
      recentConversation: [],
      activeWork: [],
      authorityLimits: {
        canWriteCanonical: false,
        allowedWorkKinds: ['continuity_capable'],
        forbiddenExports: ['private_brain', 'household_credentials'],
      },
      freshness: FRESHNESS,
      privateBrain: { nodes: 65000 },
    } as never),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'private_export_forbidden',
  );
  assert.throws(
    () => continuity.seedContext({
      charterSummary: 'Jerry.',
      relationshipSummary: 'Owner.',
      recentConversation: [],
      activeWork: [],
      authorityLimits: {
        canWriteCanonical: false,
        allowedWorkKinds: ['continuity_capable'],
        forbiddenExports: ['private_brain', 'household_credentials'],
      },
      freshness: FRESHNESS,
      householdCredentials: { token: 'secret' },
    } as never),
    (error: unknown) => error instanceof ContinuityOfficeError && error.code === 'private_export_forbidden',
  );
  assert.equal(continuity.context(), undefined);
});

test('caps recent conversation instead of shipping the full history', () => {
  const continuity = createIsolatedContinuityOffice();
  const recentConversation = Array.from({ length: 40 }, (_, index) => ({
    messageId: `msg_${index + 1}`,
    role: index % 2 === 0 ? 'owner' as const : 'resident' as const,
    text: `line ${index + 1}`,
    at: '2026-09-03T16:00:00.000Z',
  }));

  const snapshot = continuity.seedContext({
    charterSummary: 'Jerry.',
    relationshipSummary: 'Owner.',
    recentConversation,
    activeWork: [],
    authorityLimits: {
      canWriteCanonical: false,
      allowedWorkKinds: ['continuity_capable'],
      forbiddenExports: ['private_brain', 'household_credentials'],
    },
    freshness: FRESHNESS,
  });

  assert.equal(snapshot.recentConversation.length, 16);
  assert.equal(snapshot.recentConversation[0]?.messageId, 'msg_25');
  assert.equal(snapshot.recentConversation.at(-1)?.messageId, 'msg_40');
});
