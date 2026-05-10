import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const AcceptanceValidator = require('../../../engine/src/planning/acceptance-validator.js');

test('QA acceptance fallback honors high thresholds when async QA spawns', async () => {
  const validator = new AcceptanceValidator(
    {
      config: {},
      async spawnAgent() {
        return 'agent_qa';
      },
    },
    { debug() {}, info() {}, warn() {}, error() {} }
  );

  const passed = await validator.checkQA(
    {
      type: 'qa',
      rubric: 'Final deliverable exists and contains all required sections',
      threshold: 0.9,
    },
    [{ type: 'deliverable', content: 'Complete final report' }]
  );

  assert.equal(passed, true);
});
