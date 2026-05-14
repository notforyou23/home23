const { expect } = require('chai');
const EventEmitter = require('events');

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

  it('does not bypass concurrency for strategic work unless governor approves bypass', async () => {
    const executor = new AgentExecutor(
      {
        memory: null,
        goals: {
          getGoals: () => [],
          archiveGoal: () => true
        }
      },
      { logsDir: '.', coordinator: { maxConcurrent: 1 } },
      logger
    );
    executor.initialized = true;
    executor.registry.getActiveCount = () => 1;
    executor.registry.canSpawnMore = () => false;
    executor.registry.isGoalBeingPursued = () => false;
    executor.spawnGate = { evaluate: async () => ({ allowed: true, action: 'proceed' }) };
    executor.enrichMissionWithArtifacts = async () => {};
    executor.executeAgentAsync = async () => {};
    class DummyAnalysisAgent extends EventEmitter {
      constructor(mission) {
        super();
        this.agentId = 'agent_dummy';
        this.agentType = 'analysis';
        this.mission = mission;
        this.status = 'initialized';
        this.startTime = new Date();
      }
    }
    executor.agentTypes.set('analysis', DummyAnalysisAgent);

    expect(executor.isApprovedStrategicBypass({
      triggerSource: 'strategic_goal',
      metadata: { strategicPriority: true }
    })).to.equal(false);

    const agentId = await executor.spawnAgent({
      missionId: 'strategic-test',
      agentType: 'analysis',
      goalId: 'goal_critical',
      description: 'Strategic but not system repair',
      metadata: { strategicPriority: true }
    });

    expect(agentId).to.equal(null);
  });

  it('preserves synthesis and document roles when commitment governor requires differentiated work', async () => {
    const executor = new AgentExecutor(
      {
        memory: null,
        goals: { getGoals: () => [], archiveGoal: () => true }
      },
      {
        logsDir: '.',
        ideFirst: { enabled: true },
        commitmentGovernor: { preserveDifferentiatedRoles: true }
      },
      logger
    );

    expect(executor.getEffectiveAgentType({
      agentType: 'synthesis',
      metadata: { commitmentRole: 'synthesis' }
    })).to.equal('synthesis');

    expect(executor.getEffectiveAgentType({
      agentType: 'document_creation',
      metadata: { expectedOutput: '@outputs/report.md' }
    })).to.equal('document_creation');
  });
});
