const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRegistry } = require('../../../engine/src/agents/agent-registry');

function logger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('hydrated agent registry preserves recent activity ordering and agent types', () => {
  const registry = new AgentRegistry(logger());

  registry.importState({
    completedAgents: [
      {
        id: 'agent_old',
        agentType: 'AnalysisAgent',
        mission: { goalId: 'goal_old' },
        status: 'completed',
        startTime: '2026-05-10T09:00:00.000Z',
        endTime: '2026-05-10T09:01:00.000Z',
        duration: 60_000,
      },
      {
        id: 'agent_new',
        agentType: 'DocumentCreationAgent',
        mission: { goalId: 'goal_new' },
        status: 'completed',
        startTime: '2026-05-10T10:00:00.000Z',
        endTime: '2026-05-10T10:03:00.000Z',
        duration: 180_000,
      },
    ],
    failedAgents: [
      {
        id: 'agent_failed',
        agentType: 'SynthesisAgent',
        mission: { goalId: 'goal_failed' },
        status: 'failed',
        startTime: '2026-05-10T09:30:00.000Z',
        endTime: '2026-05-10T09:31:00.000Z',
      },
    ],
  });

  const recent = registry.getRecentActivity(3);
  assert.deepEqual(recent.map((entry) => entry.agentId), ['agent_new', 'agent_failed', 'agent_old']);
  assert.deepEqual(recent.map((entry) => entry.type), ['DocumentCreationAgent', 'SynthesisAgent', 'AnalysisAgent']);

  const stats = registry.getStats();
  assert.equal(stats.byType.DocumentCreationAgent, 1);
  assert.equal(stats.byType.SynthesisAgent, 1);
  assert.equal(stats.byType.AnalysisAgent, 1);
  assert.equal(stats.byType.Object, undefined);
});
