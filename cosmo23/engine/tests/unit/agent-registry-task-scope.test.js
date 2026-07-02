const { expect } = require('chai');

const { AgentRegistry } = require('../../src/agents/agent-registry');

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

function makeCompletedState(overrides = {}) {
  const agentId = overrides.agentId || 'agent_old';
  const mission = {
    taskId: 'task:phase1',
    planId: 'plan:main',
    ...overrides.mission
  };

  return {
    agent: {
      agentId,
      mission,
      accomplishment: overrides.accomplishment || { accomplished: false },
      results: []
    },
    mission,
    status: 'completed',
    registeredAt: overrides.registeredAt || new Date('2026-06-30T14:00:00.000Z'),
    startTime: overrides.startTime || new Date('2026-06-30T14:00:00.000Z'),
    endTime: overrides.endTime || new Date('2026-06-30T14:05:00.000Z')
  };
}

describe('AgentRegistry task generation scoping', () => {
  it('does not let an older completed agent satisfy a fresh task with the same task id', () => {
    const registry = new AgentRegistry(logger);
    registry.completedAgents.set(
      'agent_old',
      makeCompletedState({
        agentId: 'agent_old',
        registeredAt: new Date('2026-06-30T14:00:00.000Z')
      })
    );

    const unscoped = registry.getTaskAgentStatus('task:phase1');
    expect(unscoped.completedCount).to.equal(1);

    const scoped = registry.getTaskAgentStatus('task:phase1', {
      planId: 'plan:main',
      taskCreatedAt: new Date('2026-06-30T15:00:00.000Z')
    });

    expect(scoped.completedCount).to.equal(0);
    expect(scoped.hasCompletedWork).to.equal(false);
    expect(scoped.hasAccomplishedWork).to.equal(false);
  });

  it('keeps agents from the current task generation visible', () => {
    const registry = new AgentRegistry(logger);
    registry.completedAgents.set(
      'agent_current',
      makeCompletedState({
        agentId: 'agent_current',
        registeredAt: new Date('2026-06-30T15:02:00.000Z'),
        accomplishment: { accomplished: true }
      })
    );

    const scoped = registry.getTaskAgentStatus('task:phase1', {
      planId: 'plan:main',
      taskCreatedAt: new Date('2026-06-30T15:00:00.000Z')
    });

    expect(scoped.completedCount).to.equal(1);
    expect(scoped.accomplishedCount).to.equal(1);
    expect(scoped.hasAccomplishedWork).to.equal(true);
  });
});
