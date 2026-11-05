import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicState, type PublicStateDeps } from '../../src/agent/neighbor-state.js';
import { VerificationFlag } from '../../src/agent/verification.js';

test('buildPublicState returns a well-formed record', async () => {
  const deps: PublicStateDeps = {
    agent: 'jerry',
    getActiveGoals: () => [{ id: 'g1', title: 't', termination: { deliverable: 'x' }, ageMs: 10 }],
    getRecentObservations: (_n) => [{
      channelId: 'build.git', sourceRef: 'git:abc',
      receivedAt: '2026-04-21T00:00:00Z', producedAt: '2026-04-21T00:00:00Z',
      flag: VerificationFlag.COLLECTED, confidence: 0.9, payload: {},
    }],
    getCurrentFocus: () => 'health + build',
    getDispatchState: () => 'idle',
    getLastMemoryWrite: () => '2026-04-21T00:00:00Z',
  };
  const st = await buildPublicState(deps, { recentCount: 1 });
  assert.equal(st.agent, 'jerry');
  assert.deepEqual(st.origin, {
    agent: 'jerry',
    protocol: 'home23-neighbor-state',
    protocolVersion: 1,
  });
  assert.equal(st.activeGoals.length, 1);
  assert.equal(st.recentObservations.length, 1);
  assert.equal(st.dispatchState, 'idle');
  assert.ok(st.snapshotAt);
});
