import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { routeThoughtAction } = require('../../../engine/src/cognition/thought-action-parser.js');

test('quiet-state investigation tags do not spawn research agents', async () => {
  let spawned = 0;
  const result = await routeThoughtAction({
    hypothesis: 'INVESTIGATE: Current system state: cycle 6818, with 0 live problems, 0 stale alerts, last full cycle completed 5 days ago. No active blockers or fresh signals - the environment is stable and quiet. This suggests no immediate operational action is needed, but the sustained silence may warrant a routine surface check for any latent drift.',
    role: 'analyst',
    cycle: 6996,
    brainDir: '/tmp/home23-test-brain',
    agentExecutor: {
      async spawnAgent() {
        spawned += 1;
        return 'agent_should_not_spawn';
      },
    },
  });

  assert.equal(spawned, 0);
  assert.equal(result.action, 'investigate');
  assert.equal(result.routed, 'suppressed:low_value_investigation');
});

test('concrete investigation tags still spawn research agents', async () => {
  let mission = null;
  const result = await routeThoughtAction({
    hypothesis: 'INVESTIGATE: The transport sampler has failed five times; inspect the collector logs and compare the last successful timestamp.',
    role: 'analyst',
    cycle: 7000,
    brainDir: '/tmp/home23-test-brain',
    agentExecutor: {
      async spawnAgent(spec) {
        mission = spec;
        return 'agent_123';
      },
    },
  });

  assert.equal(result.routed, 'agent:agent_123');
  assert.equal(mission.agentType, 'research');
  assert.match(mission.description, /transport sampler has failed/);
});
