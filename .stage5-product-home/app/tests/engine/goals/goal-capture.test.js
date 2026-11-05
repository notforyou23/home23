import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { GoalCaptureSystem } = require('../../../engine/src/goals/goal-capture');

function makeCapture() {
  return new GoalCaptureSystem({}, {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }, {});
}

test('goal capture does not promote dream output into active goals', async () => {
  const capture = makeCapture();
  const goals = await capture.captureGoalsFromOutput(
    'I should explore the blue bicycle as a motif in the dream.',
    { provenance: 'dream' }
  );

  assert.deepEqual(goals, []);
});

test('goal capture filters low-signal sleep analysis fragments', () => {
  const capture = makeCapture();
  const goals = [
    { text: '*Open question:**', source: 'journal_analysis' },
    { text: 'a conceptual organizing principle,', source: 'journal_analysis' },
    { text: 'Could one live signal per cycle replace multiple document checks?', source: 'journal_analysis' },
  ];

  assert.deepEqual(capture.filterCapturedGoals(goals, { provenance: 'sleep_analysis' }), [
    { text: 'Could one live signal per cycle replace multiple document checks?', source: 'journal_analysis' },
  ]);
});
