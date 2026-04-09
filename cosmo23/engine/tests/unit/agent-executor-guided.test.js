const { expect } = require('chai');

const { AgentExecutor } = require('../../src/agents/agent-executor');

describe('AgentExecutor guided follow-up and source indexing', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('promotes guided follow-up goals to high priority and skips operational noise', async () => {
    const addedGoals = [];
    const executor = new AgentExecutor(
      {
        memory: null,
        goals: {
          addGoal: async (goal) => {
            addedGoals.push(goal);
            return `goal-${addedGoals.length}`;
          },
          getGoals: () => [],
          archiveGoal: () => true
        }
      },
      {
        logsDir: '.',
        architecture: {
          roleSystem: {
            explorationMode: 'guided'
          }
        }
      },
      logger
    );

    await executor.createFollowUpGoals(
      [
        {
          type: 'synthesis',
          followUp: [
            'Deepen the payer coverage analysis with corroborating source documents',
            'Investigate runtime error stack trace in the COSMO infrastructure'
          ]
        }
      ],
      'agent-1',
      {
        goalId: 'goal-parent',
        metadata: { guidedMission: true }
      }
    );

    expect(addedGoals).to.have.length(1);
    expect(addedGoals[0].priority).to.equal(0.8);
    expect(addedGoals[0].source).to.equal('guided_follow_up_from_agent-1');
  });

  it('indexes processed source urls from results, metadata, and handoffs', async () => {
    let storedValue = null;
    const store = {
      get: async () => ({ urls: ['https://existing.example'] }),
      set: async (key, value) => {
        storedValue = { key, value };
      }
    };

    const executor = new AgentExecutor(
      {
        memory: null,
        goals: {
          getGoals: () => [],
          archiveGoal: () => true
        }
      },
      { logsDir: '.' },
      logger
    );
    executor.setClusterReviewContext(store, 'instance-1');

    await executor.indexProcessedSourceUrls({
      agentId: 'agent-1',
      mission: { goalId: 'goal-1' },
      results: [{ sources: ['https://new.example'] }],
      handoffSpec: { sourceUrls: ['https://handoff.example'] },
      agentSpecificData: { sources: ['https://agent.example'] }
    });

    expect(storedValue.key).to.equal('research_source_index');
    expect(storedValue.value.urls).to.include('https://existing.example');
    expect(storedValue.value.urls).to.include('https://new.example');
    expect(storedValue.value.urls).to.include('https://handoff.example');
    expect(storedValue.value.urls).to.include('https://agent.example');
  });
});
