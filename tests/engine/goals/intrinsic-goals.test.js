import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { IntrinsicGoalSystem } = require('../../../engine/src/goals/intrinsic-goals');

function makeGoals() {
  return new IntrinsicGoalSystem({
    goals: {
      maxGoals: 20,
      doneWhen: { autoSynthesizeLegacy: true },
    },
    roleSystem: {},
    cluster: {},
  }, {
    warn() {},
    info() {},
    debug() {},
    error() {},
  });
}

test('archived goal descriptions suppress rediscovery loops', () => {
  const goals = makeGoals();
  const first = goals.addGoal({
    description: 'Investigate why clusters exist without nodes.',
    source: 'meta_coordinator_strategic',
  });

  assert.ok(first);
  assert.equal(goals.archiveGoal(first.id, 'false premise'), true);

  const duplicate = goals.addGoal({
    description: 'Investigate why clusters exist without nodes.',
    source: 'meta_coordinator_strategic',
  });

  assert.equal(duplicate, null);
  assert.equal(goals.getGoals().length, 0);
  assert.equal(goals.archivedGoals.length, 1);
});

test('completed goal descriptions suppress rediscovery loops', () => {
  const goals = makeGoals();
  const first = goals.addGoal({
    description: 'Produce outputs/digest-6410.md.',
    source: 'orchestrator',
  });

  assert.ok(first);
  goals.completeGoal(first.id, 'done');

  const duplicate = goals.addGoal({
    description: 'Produce outputs/digest-6410.md.',
    source: 'orchestrator',
  });

  assert.equal(duplicate, null);
  assert.equal(goals.getGoals().length, 0);
  assert.equal(goals.completedGoals.length, 1);
});

test('external goal upsert reuses an active goal with the same description', () => {
  const goals = makeGoals();
  const first = goals.upsertExternalGoal(
    'synthesis_7004',
    'Consolidate and synthesize recent cognitive work into a comprehensive knowledge report.',
    { source: 'system_scheduler' },
  );

  const duplicate = goals.upsertExternalGoal(
    'synthesis_7014',
    'Consolidate and synthesize recent cognitive work into a comprehensive knowledge report.',
    { source: 'system_scheduler' },
  );

  assert.ok(first);
  assert.equal(duplicate.id, first.id);
  assert.equal(goals.getGoals().length, 1);
  assert.equal(goals.getGoal('synthesis_7014'), undefined);
});

test('observation-only dream, sleep, and notice outputs are not promoted to active goals', () => {
  const goals = makeGoals();

  assert.equal(goals.addGoal({
    description: 'Explore the motif of language as architecture.',
    source: 'dream_gpt5',
  }), null);

  assert.equal(goals.addGoal({
    description: 'Is the current inspection cadence still net-positive?',
    source: { label: 'sleep_analysis_gpt5' },
  }), null);

  assert.equal(goals.addGoal({
    description: 'NoticePass: Stale memory in active cluster 2.',
    source: 'notice_pass',
  }), null);

  assert.equal(goals.getGoals().length, 0);
});

test('explicit promotion can turn an observation into an active goal', () => {
  const goals = makeGoals();
  const goal = goals.addGoal({
    description: 'Review whether the sleep analysis points to a concrete operator task.',
    source: 'sleep_analysis_gpt5',
    metadata: { allowActiveGoal: true },
  });

  assert.ok(goal);
  assert.equal(goals.getGoals().length, 1);
});
