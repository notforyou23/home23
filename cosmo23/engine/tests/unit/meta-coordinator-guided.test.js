const { expect } = require('chai');

const { MetaCoordinator } = require('../../src/coordinator/meta-coordinator');

describe('MetaCoordinator guided tier handling', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  function createCoordinator(configOverrides = {}) {
    const coordinator = new MetaCoordinator(
      {
        coordinator: {},
        architecture: {
          roleSystem: {
            explorationMode: 'guided'
          }
        },
        models: {},
        ...configOverrides
      },
      logger
    );
    coordinator.getAgentTimeout = () => 1000;
    return coordinator;
  }

  it('suppresses autonomous mission creation while guided mode is active', async () => {
    const coordinator = createCoordinator();
    coordinator.phase2bSubsystems = {
      clusterStateStore: {
        get: async () => null
      },
      agentExecutor: {
        registry: { getActiveCount: () => 0 }
      }
    };

    const specs = await coordinator.createMissionSpecs(
      [{ id: 'goal-1', description: 'Autonomous follow-up', priority: 0.9 }],
      5,
      2
    );

    expect(specs).to.deep.equal([]);
  });

  it('honors maxConcurrent when spawning guided tiers and leaves overflow pending', async () => {
    const pendingState = {
      pending_agent_tiers: {
        tiers: [
          {
            tier: 1,
            missions: [
              { type: 'research', mission: 'Mission A', originalIndex: 0, priority: 'high' },
              { type: 'research', mission: 'Mission B', originalIndex: 1, priority: 'high' },
              { type: 'ide', mission: 'Mission C', originalIndex: 2, priority: 'medium' }
            ]
          }
        ],
        deliverableSpec: { type: 'markdown', filename: 'out.md' },
        missionGoalIds: [
          { missionIdx: 0, goalId: 'goal-0' },
          { missionIdx: 1, goalId: 'goal-1' },
          { missionIdx: 2, goalId: 'goal-2' }
        ],
        researchDigest: { topFindings: ['Finding A'] },
        currentTierToSpawn: 1
      }
    };

    const stateStore = {
      get: async (key) => pendingState[key] || null,
      set: async (key, value) => {
        pendingState[key] = value;
      },
      delete: async (key) => {
        delete pendingState[key];
      }
    };

    const spawned = [];
    const coordinator = createCoordinator();
    coordinator.phase2bSubsystems = {
      clusterStateStore: stateStore,
      memory: { nodes: new Map([['n1', { id: 'n1' }]]) },
      agentExecutor: {
        maxConcurrent: 2,
        registry: { getActiveCount: () => 0 },
        spawnAgent: async (spec) => {
          spawned.push(spec);
          return `agent-${spawned.length}`;
        }
      }
    };

    const result = await coordinator.spawnPendingTierIfReady();

    expect(result).to.equal(true);
    expect(spawned).to.have.length(2);
    expect(spawned[0].metadata.researchDigest.topFindings).to.deep.equal(['Finding A']);
    expect(pendingState.pending_agent_tiers.tiers[0].missions).to.have.length(1);
    expect(pendingState.pending_agent_tiers.currentTierToSpawn).to.equal(1);
  });

  it('binds pending tier spawns back to their persisted task and assignment state', async () => {
    const tasks = new Map([
      ['task:phase2', {
        id: 'task:phase2',
        title: 'Scrape Reddit threads',
        state: 'PENDING',
        assignedAgentId: null,
        metadata: {}
      }]
    ]);

    const pendingState = {
      pending_agent_tiers: {
        tiers: [
          {
            tier: 1,
            missions: [
              {
                type: 'dataacquisition',
                mission: 'Scrape Reddit fan recollection threads',
                originalIndex: 1,
                priority: 'high',
                expectedOutput: '@outputs/data/reddit.json'
              }
            ]
          }
        ],
        deliverableSpec: { type: 'json', filename: 'reddit.json' },
        missionGoalIds: [{ missionIdx: 1, goalId: 'goal-reddit' }],
        currentTierToSpawn: 1
      }
    };

    const stateStore = {
      get: async (key) => pendingState[key] || null,
      set: async (key, value) => {
        pendingState[key] = value;
      },
      delete: async (key) => {
        delete pendingState[key];
      },
      getTask: async (taskId) => tasks.get(taskId) || null,
      upsertTask: async (task) => {
        tasks.set(task.id, task);
      }
    };

    const spawned = [];
    const coordinator = createCoordinator();
    coordinator.phase2bSubsystems = {
      clusterStateStore: stateStore,
      memory: { nodes: new Map([['n1', { id: 'n1' }]]) },
      agentExecutor: {
        maxConcurrent: 1,
        registry: { getActiveCount: () => 0 },
        spawnAgent: async (spec) => {
          spawned.push(spec);
          return 'agent-reddit';
        }
      }
    };

    const result = await coordinator.spawnPendingTierIfReady();

    expect(result).to.equal(true);
    expect(spawned).to.have.length(1);
    expect(spawned[0].taskId).to.equal('task:phase2');
    expect(spawned[0].metadata.taskId).to.equal('task:phase2');
    expect(tasks.get('task:phase2').assignedAgentId).to.equal('agent-reddit');
  });
});
