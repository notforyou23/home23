const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGoodLifeOperatorModel } = require('../../../engine/src/dashboard/good-life-operator');

test('Good Life operator brief explains autonomous remediation cooldowns', () => {
  const now = new Date('2026-05-10T10:40:00.000Z');
  const model = buildGoodLifeOperatorModel({
    now,
    state: {
      schema: 'home23.good-life.v1',
      evaluatedAt: now.toISOString(),
      policy: {
        mode: 'repair',
        reason: 'critical viability drift',
      },
      lanes: {
        viability: { status: 'critical', reasons: ['1 unresolved live problem(s)'] },
      },
      evidence: {
        liveProblems: { open: 1, chronic: 0, resolved: 0, unverifiable: 0, total: 1 },
      },
    },
    liveProblems: [{
      id: 'jerry_engine_cycle_timeouts_clear',
      state: 'open',
      claim: 'jerry engine has no cycle timeout exceeded events in the last 30 minutes',
      openedAt: '2026-05-10T10:32:00.000Z',
      lastResult: { detail: 'cycle timeout during emergency_coordinator_review' },
      stepIndex: 1,
      remediation: [
        { type: 'dispatch_to_worker', cooldownMin: 15 },
        { type: 'dispatch_to_agent', cooldownMin: 30 },
        { type: 'notify_jtr', cooldownMin: 120 },
      ],
      remediationLog: [{
        step: 1,
        type: 'dispatch_to_worker',
        outcome: 'dispatched',
        detail: 'worker checked the timeout',
        at: '2026-05-10T10:32:00.000Z',
      }],
    }],
  });

  assert.equal(model.operatorBrief.needsUser, false);
  assert.match(model.operatorBrief.next, /waiting 22m before dispatch_to_agent cooldown clears/);
  assert.match(model.operatorHandoff.repair, /latest attempt: dispatch_to_worker dispatched/);
  assert.match(model.operatorDigest.userAction, /No user action needed/);
});
