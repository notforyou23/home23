const { expect } = require('chai');

const { GoalAllocator } = require('../../src/cluster/goal-allocator');
const { IntrinsicGoalSystem } = require('../../src/goals/intrinsic-goals');
const ClusterStateStore = require('../../src/cluster/cluster-state-store');
const RedisStateStoreStub = require('../../src/cluster/backends/redis-state-store-stub');

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

const baseConfig = {
  goals: {
    intrinsicEnabled: true,
    maxGoals: 16,
    claimTtlMs: 1500,
    agingHalfLifeMs: 750,
    stealThresholdMs: 300
  },
  roleSystem: {}
};

function createClusterStateStore(instanceId, sharedGoalMap) {
  const backend = new RedisStateStoreStub({ instanceId });
  backend.goalStore = sharedGoalMap;

  const store = new ClusterStateStore(
    {
      instanceId,
      cluster: { enabled: true },
      goals: baseConfig.goals
    },
    backend
  );

  return { store, backend };
}

function createGoalSystem(instanceId, clusterStateStore) {
  const system = new IntrinsicGoalSystem(baseConfig, noopLogger);
  const allocator = new GoalAllocator(baseConfig, clusterStateStore, instanceId, noopLogger);

  system.setGoalAllocator(allocator);

  return { system, allocator };
}

describe('Cluster Goal Lifecycle Integration', () => {
  it('coordinates claims and completions across instances via shared state', async () => {
    const sharedGoalMap = new Map();

    const instanceA = createClusterStateStore('instA', sharedGoalMap);
    const instanceB = createClusterStateStore('instB', sharedGoalMap);

    await instanceA.store.connect();
    await instanceB.store.connect();

    const nodeA = createGoalSystem('instA', instanceA.store);
    const nodeB = createGoalSystem('instB', instanceB.store);

    // Each instance discovers the same pair of goals in its own local map
    const goalOneA = nodeA.system.addGoal({
      description: 'Stage 3: Coordinate allocator lifecycle audit',
      uncertainty: 0.8
    });
    const goalTwoA = nodeA.system.addGoal({
      description: 'Stage 3: Validate dashboard telemetry merge',
      uncertainty: 0.6
    });

    const goalOneB = nodeB.system.addGoal({
      description: 'Stage 3: Coordinate allocator lifecycle audit',
      uncertainty: 0.8
    });
    const goalTwoB = nodeB.system.addGoal({
      description: 'Stage 3: Validate dashboard telemetry merge',
      uncertainty: 0.6
    });

    expect(goalOneA.id).to.equal('goal_1');
    expect(goalOneB.id).to.equal('goal_1');

    const claimedByA = await nodeA.system.selectGoalToPursue();
    expect(claimedByA).to.exist;
    expect(claimedByA.claimed_by).to.equal('instA');

    const claimedByB = await nodeB.system.selectGoalToPursue();
    expect(claimedByB).to.exist;
    expect(claimedByB.claimed_by).to.equal('instB');
    expect(claimedByB.id).to.equal(goalTwoB.id);

    const goalOneState = sharedGoalMap.get('goal_1');
    const goalTwoState = sharedGoalMap.get('goal_2');

    expect(goalOneState.claimedBy).to.equal('instA');
    expect(goalTwoState.claimedBy).to.equal('instB');
    expect(goalOneState.completed).to.be.false;

    // Instance A completes its goal; instance B keeps working
    nodeA.system.completeGoal(claimedByA.id, 'Lifecycle audit documented');
    await new Promise(resolve => setTimeout(resolve, 10));

    const updatedGoalOne = sharedGoalMap.get('goal_1');
    expect(updatedGoalOne.completed).to.be.true;
    expect(updatedGoalOne.completedBy).to.equal('instA');
    expect(updatedGoalOne.claimedBy).to.be.null;

    // Instance B now completes its goal as well
    nodeB.system.completeGoal(claimedByB.id, 'Telemetry validation captured');
    await new Promise(resolve => setTimeout(resolve, 10));

    const allocatorStatsA = nodeA.allocator.getStats();
    const allocatorStatsB = nodeB.allocator.getStats();

    expect(allocatorStatsA.completions).to.equal(1);
    expect(allocatorStatsB.completions).to.equal(1);
    expect(allocatorStatsA.claimSuccesses).to.equal(1);
    expect(allocatorStatsB.claimSuccesses).to.equal(1);
    expect(allocatorStatsA.claimFailures).to.equal(0);
    expect(allocatorStatsB.claimFailures).to.equal(1); // First attempt hits claimed goal

    const finalGoalTwo = sharedGoalMap.get('goal_2');
    expect(finalGoalTwo.completed).to.be.true;
    expect(finalGoalTwo.completedBy).to.equal('instB');
    expect(finalGoalTwo.claimedBy).to.be.null;
  });
});
