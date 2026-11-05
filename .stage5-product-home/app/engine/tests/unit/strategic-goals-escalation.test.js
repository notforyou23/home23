const { expect } = require('chai');
const { StrategicGoalsTracker } = require('../../src/coordinator/strategic-goals-tracker');

function mkTracker(opts = {}) {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const tracker = new StrategicGoalsTracker({
    escalationThreshold: 3,
    maxAge: 100,
    ...opts,
    logger,
  });
  tracker.getCurrentCycle = () => opts.currentCycle || 10;
  return tracker;
}

function mkGoalsSystem(goals) {
  return {
    getGoals() { return goals; }
  };
}

describe('strategic escalation — progress-gated', () => {
  it('escalates a goal with progress > 0 (signal present)', () => {
    const tracker = mkTracker();
    tracker.strategicGoals.set('goal_1', {
      status: 'active',
      cyclesIgnored: 0,
      reviewCycle: 0,
      spec: { rationale: 'x', agentType: 'research' },
    });
    const goals = [{ id: 'goal_1', progress: 0.3, pursuitCount: 0 }];
    // First pass: cyclesIgnored goes from 0 -> 1 (under threshold)
    let u = tracker.checkProgress(3, mkGoalsSystem(goals), []);
    u = tracker.checkProgress(4, mkGoalsSystem(goals), []);
    u = tracker.checkProgress(5, mkGoalsSystem(goals), []);
    // After 3 passes, cyclesIgnored >= threshold AND progress > 0 → escalate
    expect(u.needsEscalation).to.have.length(1);
    expect(u.needsEscalation[0].goalId).to.equal('goal_1');
  });

  it('does NOT escalate a goal with zero progress, zero pursuit, no dedup breadcrumb', () => {
    const tracker = mkTracker();
    tracker.strategicGoals.set('goal_2', {
      status: 'active',
      cyclesIgnored: 0,
      reviewCycle: 0,
      spec: { rationale: 'x', agentType: 'research' },
    });
    const goals = [{ id: 'goal_2', progress: 0, pursuitCount: 0 }];
    tracker.checkProgress(3, mkGoalsSystem(goals), []);
    tracker.checkProgress(4, mkGoalsSystem(goals), []);
    const u = tracker.checkProgress(5, mkGoalsSystem(goals), []);
    expect(u.needsEscalation).to.have.length(0);
    const stalled = u.stalled.find(s => s.goalId === 'goal_2');
    expect(stalled).to.exist;
    expect(stalled.suppressedEscalation).to.equal(true);
    expect(stalled.reason).to.equal('no-progress-signal');
  });

  it('escalates if goal has a dedupedTo breadcrumb (known-answer redirect)', () => {
    const tracker = mkTracker();
    tracker.strategicGoals.set('goal_3', {
      status: 'active',
      cyclesIgnored: 0,
      reviewCycle: 0,
      spec: { rationale: 'x', agentType: 'research' },
    });
    const goals = [{ id: 'goal_3', progress: 0, pursuitCount: 0, dedupedTo: { memoryId: 42, similarity: 0.9 } }];
    tracker.checkProgress(3, mkGoalsSystem(goals), []);
    tracker.checkProgress(4, mkGoalsSystem(goals), []);
    const u = tracker.checkProgress(5, mkGoalsSystem(goals), []);
    expect(u.needsEscalation).to.have.length(1);
  });
});
