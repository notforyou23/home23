import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compactActiveGoalsForSnapshot,
  getEmergencyCoordinatorWorkState,
  buildForceOutputMissionSpec,
  persistArchivedGoalsToState,
} = require('../../../engine/src/core/orchestrator.js');
const { StateCompression } = require('../../../engine/src/core/state-compression.js');

test('compactActiveGoalsForSnapshot writes bounded lightweight active goal summaries', () => {
  const goals = compactActiveGoalsForSnapshot([
    ['goal_old', {
      id: 'goal_old',
      description: 'Older goal',
      source: { label: 'meta' },
      priority: 0.4,
      progress: 0.1,
      createdAt: '2026-05-08T10:00:00.000Z',
    }],
    ['goal_new', {
      id: 'goal_new',
      description: 'Newer goal'.repeat(100),
      status: 'active',
      source: 'operator',
      priority: '0.9',
      progress: '0.25',
      createdAt: '2026-05-08T11:00:00.000Z',
    }],
    ['goal_done', {
      id: 'goal_done',
      description: 'Completed goal',
      status: 'completed',
      progress: 1,
      createdAt: '2026-05-08T12:00:00.000Z',
    }],
    ['goal_progress_done', {
      id: 'goal_progress_done',
      description: 'Progress-complete goal',
      status: 'active',
      progress: 1,
      createdAt: '2026-05-08T13:00:00.000Z',
    }],
  ]);

  assert.equal(goals.length, 2);
  assert.equal(goals[0].id, 'goal_new');
  assert.equal(goals[0].description.length, 500);
  assert.equal(goals[0].source, 'operator');
  assert.equal(goals[0].priority, 0.9);
  assert.equal(goals[0].progress, 0.25);
  assert.equal(goals[1].source, 'meta');
});

test('emergency coordinator work state ignores completed and archived goal history', () => {
  const workState = getEmergencyCoordinatorWorkState(
    {
      getGoals() {
        return [
          { id: 'done', status: 'completed' },
          { id: 'old', status: 'archived' },
          { id: 'resolved', status: 'resolved' },
        ];
      },
    },
    { registry: { getActiveCount: () => 0 } },
    6873,
    6800,
  );

  assert.equal(workState.activeGoalCount, 0);
  assert.equal(workState.totalGoalHistory, 3);
  assert.equal(workState.activeAgents, 0);
  assert.equal(workState.cyclesSinceLastReview, 73);
});

test('emergency coordinator work state counts active or blocked goals as live work', () => {
  const workState = getEmergencyCoordinatorWorkState(
    {
      getGoals() {
        return [
          { id: 'active', status: 'active' },
          { id: 'blocked', status: 'blocked' },
          { id: 'done', status: 'completed' },
        ];
      },
    },
    { registry: { getActiveCount: () => 2 } },
    50,
    48,
  );

  assert.equal(workState.activeGoalCount, 2);
  assert.equal(workState.totalGoalHistory, 3);
  assert.equal(workState.activeAgents, 2);
  assert.equal(workState.cyclesSinceLastReview, 2);
});

test('emergency coordinator work state separates force-output goals from general review work', () => {
  const workState = getEmergencyCoordinatorWorkState(
    {
      getGoals() {
        return [
          { id: 'force', status: 'active', source: { origin: 'force-output' } },
          { id: 'regular', status: 'active', source: 'operator' },
          { id: 'done-force', status: 'completed', source: { origin: 'force-output' } },
        ];
      },
    },
    { registry: { getActiveCount: () => 0 } },
    10,
    8,
  );

  assert.equal(workState.activeGoalCount, 2);
  assert.equal(workState.activeForceOutputGoalCount, 1);
  assert.equal(workState.activeGeneralGoalCount, 1);
});

test('buildForceOutputMissionSpec creates direct document mission for digest goal', () => {
  const mission = buildForceOutputMissionSpec({
    id: 'goal_force',
    description: 'Produce outputs/digest-1.md. Synthesize recent memory.',
    doneWhen: { criteria: [{ type: 'file_exists', path: 'digest-1.md' }] },
  }, 12);

  assert.equal(mission.goalId, 'goal_force');
  assert.equal(mission.agentType, 'document_creation');
  assert.equal(mission.triggerSource, 'force_output');
  assert.equal(mission.metadata.strategicPriority, true);
  assert.deepEqual(mission.deliverable, {
    location: '@outputs/',
    filename: 'digest-1.md',
    type: 'report',
    format: 'markdown',
  });
  assert.match(mission.description, /Produce outputs\/digest-1\.md/);
  assert.ok(mission.successCriteria.some((criterion) => criterion.includes('digest-1.md')));
});

test('persistArchivedGoalsToState patches goals without full orchestrator save', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-goal-state-patch-'));
  try {
    await StateCompression.saveCompressed(path.join(dir, 'state.json'), {
      cycleCount: 42,
      memory: { nodes: [], edges: [] },
      goals: {
        active: [
          ['goal_keep', { id: 'goal_keep', description: 'Keep this goal', status: 'active' }],
          ['goal_archive', { id: 'goal_archive', description: 'Archive this goal', status: 'active' }],
          ['goal_done_in_active', { id: 'goal_done_in_active', description: 'Done but still in active map', status: 'completed', progress: 1 }],
        ],
        completed: [{ id: 'goal_done' }],
        archived: [],
      },
    }, { compress: true, pretty: false });

    const result = await persistArchivedGoalsToState(dir, ['goal_archive'], 'test_archive');
    const state = await StateCompression.loadCompressed(path.join(dir, 'state.json'));
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'brain-snapshot.json'), 'utf8'));

    assert.equal(result.saved, true);
    assert.equal(state.goals.active.length, 2);
    assert.equal(state.goals.archived.length, 1);
    assert.equal(state.goals.archived[0].archiveReason, 'test_archive');
    assert.deepEqual(snapshot.goalCounts, { active: 1, completed: 1, archived: 1 });
    assert.equal(snapshot.activeGoalSummaries[0].id, 'goal_keep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
