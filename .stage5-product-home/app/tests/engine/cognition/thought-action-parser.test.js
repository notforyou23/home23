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

test('deduped investigations do not fall back to operator-attention notifications', async () => {
  const agentExecutor = {
    _agentSpawnsDedupedCount24h: 0,
    async spawnAgent() {
      this._agentSpawnsDedupedCount24h += 1;
      return null;
    },
  };
  const result = await routeThoughtAction({
    hypothesis: 'INVESTIGATE: The transport sampler has failed five times; inspect the collector logs and compare the last successful timestamp.',
    role: 'analyst',
    cycle: 7001,
    brainDir: '/tmp/home23-test-brain',
    agentExecutor,
  });

  assert.equal(result.action, 'investigate');
  assert.equal(result.routed, 'suppressed:deduped_investigation');
});

test('capacity-limited research questions do not become operator-attention notifications', async () => {
  const result = await routeThoughtAction({
    hypothesis: 'INVESTIGATE: The investigation should target: can a minimal `fsync()` call be injected into `write_to_recent()` without disrupting the harness scheduler?',
    role: 'curiosity',
    cycle: 7002,
    brainDir: '/tmp/home23-test-brain',
    agentExecutor: {
      async spawnAgent() {
        return null;
      },
    },
  });

  assert.equal(result.action, 'investigate');
  assert.equal(result.routed, 'suppressed:investigation_fallback_not_operator_attention');
});

test('cross-agent stale meta investigations do not become operator-attention notifications', async () => {
  const result = await routeThoughtAction({
    hypothesis: 'INVESTIGATE: The chronic notification delivery failures have been a known problem since May 17th (9,043 minutes old) — the HTTP ping works but RECENT.jsonl shows zero matching entries in the last 10 minutes. The two open jerry-related issues (port 5012 stale PID, provider scoring failures) suggest the jerry subsystem may be degraded.',
    role: 'analyst',
    cycle: 7003,
    brainDir: '/tmp/home23-test-brain',
    agentName: 'forrest',
    agentExecutor: {
      async spawnAgent() {
        return null;
      },
    },
  });

  assert.equal(result.action, 'investigate');
  assert.equal(result.routed, 'suppressed:investigation_fallback_not_operator_attention');
});
