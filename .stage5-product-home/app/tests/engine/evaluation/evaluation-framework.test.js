import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EvaluationFramework } = require('../../../engine/src/evaluation/evaluation-framework');

test('evaluation metrics reconcile pursued count from active goal state', () => {
  const evaluation = new EvaluationFramework({ logsDir: '/tmp/home23-eval-test' }, { info: () => {} });
  evaluation.metrics.goals.created = 37;
  evaluation.metrics.goals.pursued = 0;

  evaluation.reconcileGoalState({
    active: [
      ['goal_1', { pursuitCount: 3 }],
      ['goal_2', { pursuitCount: 2 }],
      ['goal_3', { pursuitCount: 0 }],
    ],
  });

  assert.equal(evaluation.metrics.goals.pursued, 5);
  assert.equal(evaluation.metrics.goals.conversionRate, 5 / 37);
});
