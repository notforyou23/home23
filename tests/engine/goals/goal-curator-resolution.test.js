import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoalCurator } = require('../../../engine/src/goals/goal-curator.js');

function makeCurator() {
  const writes = [];
  const memory = { async addNode(value) { writes.push(value); return { ...value, id: `receipt-${writes.length}` }; } };
  const goals = { goals: new Map() };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  return { curator: new GoalCurator(goals, memory, logger, {}), writes };
}

test('completion emits a bounded resolution receipt even when narrative summary generation has no output', async () => {
  const { curator, writes } = makeCurator();
  const goal = {
    id: 'g1', description: 'Repair brain endpoint', progress: 1, pursuitCount: 3, completionNotes: '',
    incidentId: 'brain-fetch', sourceRefs: ['probe:brain-fetch'],
  };
  curator.goalNarratives.set(goal.id, {
    goalId: goal.id, birth: { cycle: 2, initialDescription: goal.description }, events: [], deliverables: [], status: 'active',
  });
  curator.generateCompletionSummary = async () => '';

  await curator.onGoalCompleted({ type: 'completed', goalId: goal.id, goal, cycle: 8 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, 'goal_resolution');
  assert.equal(writes[0].status, 'completed');
  assert.equal(writes[0].metadata.goalId, goal.id);
  assert.equal(writes[0].metadata.supersedes_goal_id, goal.id);
  assert.equal(writes[0].metadata.incidentId, 'brain-fetch');
  assert.deepEqual(writes[0].metadata.source_refs, ['probe:brain-fetch']);
  assert.equal(writes[0].metadata.provenance.authorityClass, 'worker_receipt');
  assert.equal(writes[0].metadata.provenance.retrievalDomain, 'closed_incidents');
  assert.ok(writes[0].asserted_at);
  assert.equal(goal.resolutionNodeId, 'receipt-1');
});

test('archive emits a resolution receipt without requiring a completion narrative', async () => {
  const { curator, writes } = makeCurator();
  const goal = { id: 'g2', description: 'Retire stale incident', archiveReason: 'superseded by live proof', progress: 0.5, pursuitCount: 1 };
  curator.goalNarratives.set(goal.id, {
    goalId: goal.id, birth: { cycle: 1, initialDescription: goal.description }, events: [], deliverables: [], status: 'active',
  });

  await curator.onGoalArchived({ type: 'archived', goalId: goal.id, goal, cycle: 9 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'archived');
  assert.match(writes[0].concept, /superseded by live proof/);
});

test('completion and archive still emit receipts when the curator has no narrative record', async () => {
  const completed = makeCurator();
  const completedGoal = { id: 'g3', description: 'Close untracked goal', progress: 1, pursuitCount: 1 };
  await completed.curator.onGoalCompleted({
    type: 'completed', goalId: completedGoal.id, goal: completedGoal, cycle: 10,
  });
  assert.equal(completed.writes.length, 1);
  assert.equal(completed.writes[0].status, 'completed');

  const archived = makeCurator();
  const archivedGoal = { id: 'g4', description: 'Archive untracked goal', archiveReason: 'obsolete' };
  await archived.curator.onGoalArchived({
    type: 'archived', goalId: archivedGoal.id, goal: archivedGoal, cycle: 11,
  });
  assert.equal(archived.writes.length, 1);
  assert.equal(archived.writes[0].status, 'archived');
});
