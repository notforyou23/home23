const { expect } = require('chai');

const { IntrinsicGoalSystem } = require('../../src/goals/intrinsic-goals');
const { GoalAllocator } = require('../../src/cluster/goal-allocator');

// Scope-patched stub doneWhen so legacy cluster tests pass the addGoal gate
// without threading the field through 18 call sites. The patch is scoped
// inside the describe() block below so it does not leak into other test files.
const STUB_DONE_WHEN = { version: 1, criteria: [{ type: 'file_exists', path: 'stub.md' }] };

const baseConfig = {
  goals: {
    intrinsicEnabled: true,
    maxGoals: 10,
    claimTtlMs: 2000,
    agingHalfLifeMs: 1000,
    stealThresholdMs: 500
  },
  roleSystem: {}
};

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

function createSharedStateStore(ttlMs = 2000) {
  const claims = new Map();

  return {
    claims,
    store: {
      claimGoal: async (goalId, instanceId) => {
        const claim = claims.get(goalId);
        if (claim && claim.expiry > Date.now() && claim.instanceId !== instanceId) {
          return false;
        }
        claims.set(goalId, {
          instanceId,
          expiry: Date.now() + ttlMs
        });
        return true;
      },
      completeGoal: async goalId => {
        claims.delete(goalId);
        return true;
      },
      releaseGoal: async (goalId, instanceId) => {
        const claim = claims.get(goalId);
        if (claim && claim.instanceId !== instanceId) {
          return false;
        }
        claims.delete(goalId);
        return true;
      },
      getClaimMetadata: goalId => claims.get(goalId)
    }
  };
}

function createGoalSystem(instanceId, sharedStore, configOverride = {}) {
  const config = JSON.parse(JSON.stringify(baseConfig));

  if (configOverride.goals) {
    config.goals = { ...config.goals, ...configOverride.goals };
  }

  if (configOverride.roleSystem) {
    config.roleSystem = { ...config.roleSystem, ...configOverride.roleSystem };
  }

  if (configOverride.cluster) {
    config.cluster = { ...(config.cluster || {}), ...configOverride.cluster };
  }

  const system = new IntrinsicGoalSystem(config, logger);
  const allocator = new GoalAllocator(config, sharedStore, instanceId, logger);
  system.setGoalAllocator(allocator);
  return { system, allocator, config };
}

describe('IntrinsicGoalSystem (cluster coordination)', () => {
  let _origAddGoal;
  before(() => {
    _origAddGoal = IntrinsicGoalSystem.prototype.addGoal;
    IntrinsicGoalSystem.prototype.addGoal = function (goalData) {
      if (goalData && !goalData.doneWhen) {
        goalData = { ...goalData, doneWhen: STUB_DONE_WHEN };
      }
      return _origAddGoal.call(this, goalData);
    };
  });
  after(() => {
    if (_origAddGoal) IntrinsicGoalSystem.prototype.addGoal = _origAddGoal;
  });

  it('allocates distinct goals across instances', async () => {
    const shared = createSharedStateStore();

    const { system: systemA } = createGoalSystem('instA', shared.store);
    const { system: systemB } = createGoalSystem('instB', shared.store);

    systemA.addGoal({ description: 'Study quantum resonance patterns', uncertainty: 0.6 });
    systemA.addGoal({ description: 'Synthesize multi-agent hypotheses', uncertainty: 0.5 });

    systemB.addGoal({ description: 'Study quantum resonance patterns', uncertainty: 0.6 });
    systemB.addGoal({ description: 'Synthesize multi-agent hypotheses', uncertainty: 0.5 });

    const goalA = await systemA.selectGoalToPursue();
    expect(goalA).to.exist;
    expect(goalA.claimed_by).to.equal('instA');

    const goalB = await systemB.selectGoalToPursue();
    expect(goalB).to.exist;
    expect(goalB.id).to.not.equal(goalA.id);
    expect(goalB.claimed_by).to.equal('instB');
  });

  it('releases claims when goals complete', async () => {
    const shared = createSharedStateStore();
    const { system: systemA } = createGoalSystem('instA', shared.store);

    systemA.addGoal({ description: 'Map cooperative claim lifecycle', uncertainty: 0.7 });
    const goal = await systemA.selectGoalToPursue();
    expect(goal.claimed_by).to.equal('instA');
    expect(shared.claims.has(goal.id)).to.be.true;

    systemA.completeGoal(goal.id);

    expect(shared.claims.has(goal.id)).to.be.false;
  });

  it('prevents duplicate claims until release', async () => {
    const shared = createSharedStateStore();
    const { system: systemA, allocator: allocatorA } = createGoalSystem('instA', shared.store);
    const { system: systemB } = createGoalSystem('instB', shared.store);

    const goalA = systemA.addGoal({ description: 'Coordinated synthesis pipeline', uncertainty: 0.6 });
    systemB.goals.set(goalA.id, JSON.parse(JSON.stringify(goalA)));

    const selectedA = await systemA.selectGoalToPursue();
    expect(selectedA).to.exist;
    expect(selectedA.claimed_by).to.equal('instA');

    const blocked = await systemB.selectGoalToPursue();
    expect(blocked).to.be.null;

    const released = await allocatorA.releaseGoal(goalA.id);
    expect(released).to.be.true;

    const claimedAfterRelease = await systemB.selectGoalToPursue();
    expect(claimedAfterRelease).to.exist;
    expect(claimedAfterRelease.claimed_by).to.equal('instB');
  });

  it('prioritizes guided-mode tasks without collisions', async () => {
    const shared = createSharedStateStore();
    const guidedConfig = {
      goals: {
        claimTtlMs: 2000,
        agingHalfLifeMs: 800,
        stealThresholdMs: 400
      },
      roleSystem: {
        explorationMode: 'guided',
        guidedFocus: {
          domain: 'higher-dimensional collaboration',
          context: 'Ensure specialization harmonizes across the cluster'
        }
      }
    };

    const { system: systemA } = createGoalSystem('instA', shared.store, guidedConfig);
    const { system: systemB } = createGoalSystem('instB', shared.store, guidedConfig);

    const taskOne = systemA.addGoal({
      description: 'Guided Stage 3: Orchestrate allocator telemetry merge',
      uncertainty: 0.4
    });
    taskOne.metadata = {
      isTaskGoal: true,
      executionMode: 'strict',
      phaseNumber: 1,
      totalPhases: 2,
      phaseName: 'Allocator Telemetry'
    };

    const taskTwo = systemA.addGoal({
      description: 'Guided Stage 3: Validate cluster claim dashboards',
      uncertainty: 0.45
    });
    taskTwo.metadata = {
      isTaskGoal: true,
      executionMode: 'strict',
      phaseNumber: 2,
      totalPhases: 2,
      phaseName: 'Claim Visualization'
    };

    systemB.goals.set(taskOne.id, JSON.parse(JSON.stringify(taskOne)));
    systemB.goals.set(taskTwo.id, JSON.parse(JSON.stringify(taskTwo)));

    const guidedSelectionA = await systemA.selectGoalToPursue();
    expect(guidedSelectionA).to.exist;
    expect(guidedSelectionA.metadata?.isTaskGoal).to.be.true;
    expect(guidedSelectionA.claimed_by).to.equal('instA');

    const guidedSelectionB = await systemB.selectGoalToPursue();
    expect(guidedSelectionB).to.exist;
    expect(guidedSelectionB.metadata?.isTaskGoal).to.be.true;
    expect(guidedSelectionB.id).to.not.equal(guidedSelectionA.id);
    expect(guidedSelectionB.claimed_by).to.equal('instB');

    expect(shared.claims.size).to.equal(2);
  });

  it('supports work stealing after claim expiry', async function() {
    this.timeout(5000);

    const shared = createSharedStateStore(400);
    const goalConfig = { goals: { claimTtlMs: 400, stealThresholdMs: 450 } };

    const { system: systemA } = createGoalSystem('instA', shared.store, goalConfig);
    const { system: systemB, allocator: allocatorB } = createGoalSystem('instB', shared.store, goalConfig);

    const goalA = systemA.addGoal({ description: 'Cross-instance peer review loop', uncertainty: 0.55 });
    systemB.goals.set(goalA.id, JSON.parse(JSON.stringify(goalA)));

    const claimed = await systemA.selectGoalToPursue();
    expect(claimed).to.exist;

    const claimMeta = shared.store.getClaimMetadata(goalA.id);
    expect(claimMeta).to.exist;

    const mirroredGoal = systemB.goals.get(goalA.id);
    mirroredGoal.claimed_by = claimMeta.instanceId;
    mirroredGoal.claim_expires = claimMeta.expiry;

    const stolen = await systemB.selectGoalToPursue();
    expect(stolen).to.exist;
    expect(stolen.claimed_by).to.equal('instB');
    expect(allocatorB.workSteals).to.be.at.least(1);

    const updatedMeta = shared.store.getClaimMetadata(goalA.id);
    expect(updatedMeta.instanceId).to.equal('instB');
  });

  it('routes goals to specialized instances based on metadata', async () => {
    const shared = createSharedStateStore();

    const specializationOverride = {
      cluster: {
        specialization: {
          enabled: true,
          defaults: {
            boost: 2,
            penalty: 0.5,
            unmatchedPenalty: 0.9,
            nonPreferredPenalty: 0.05
          },
          profiles: {
            insta: {
              agentTypes: ['analysis'],
              domains: ['governance']
            },
            instb: {
              agentTypes: ['synthesis'],
              keywords: ['synthesize']
            }
          }
        }
      }
    };

    const { system: systemA } = createGoalSystem('insta', shared.store, specializationOverride);
    const { system: systemB } = createGoalSystem('instb', shared.store, specializationOverride);

    systemA.addGoal({
      description: 'Conduct detailed compliance audit for governance framework',
      uncertainty: 0.6,
      metadata: {
        agentTypeHint: 'analysis',
        guidedDomain: 'governance'
      }
    });

    systemA.addGoal({
      description: 'Synthesize research findings into final governance blueprint',
      uncertainty: 0.6,
      metadata: {
        agentTypeHint: 'synthesis',
        guidedDomain: 'governance'
      }
    });

    systemB.addGoal({
      description: 'Conduct detailed compliance audit for governance framework',
      uncertainty: 0.6,
      metadata: {
        agentTypeHint: 'analysis',
        guidedDomain: 'governance'
      }
    });

    systemB.addGoal({
      description: 'Synthesize research findings into final governance blueprint',
      uncertainty: 0.6,
      metadata: {
        agentTypeHint: 'synthesis',
        guidedDomain: 'governance'
      }
    });

    const goalForA = await systemA.selectGoalToPursue();
    expect(goalForA).to.exist;
    expect(goalForA.metadata?.agentTypeHint).to.equal('analysis');
    expect(goalForA.claimed_by).to.equal('insta');

    const goalForB = await systemB.selectGoalToPursue();
    expect(goalForB).to.exist;
    expect(goalForB.metadata?.agentTypeHint).to.equal('synthesis');
    expect(goalForB.claimed_by).to.equal('instb');

    expect(goalForA.id).to.not.equal(goalForB.id);
  });

  it('tracks specialization-aligned claims in allocator stats', async () => {
    const shared = createSharedStateStore();
    const specializationOverride = {
      cluster: {
        specialization: {
          enabled: true,
          defaults: {
            boost: 2,
            penalty: 0.5,
            unmatchedPenalty: 0.9,
            minMultiplier: 0.3,
            maxMultiplier: 3,
            nonPreferredPenalty: 0.1
          },
          profiles: {
            insta: {
              agentTypes: ['analysis'],
              keywords: ['analysis']
            },
            instb: {
              agentTypes: ['synthesis'],
              keywords: ['synthesis']
            }
          }
        }
      }
    };

    const { system: systemA } = createGoalSystem('insta', shared.store, specializationOverride);

    const preferred = systemA.addGoal({
      description: 'Deep analysis alignment task',
      uncertainty: 0.5,
      metadata: {
        preferredInstance: 'insta'
      }
    });

    systemA.addGoal({
      description: 'Synthesis backlog item',
      uncertainty: 0.5,
      metadata: {
        preferredInstance: 'instb'
      }
    });

    const claimed = await systemA.selectGoalToPursue();
    expect(claimed).to.exist;
    expect(claimed.id).to.equal(preferred.id);
    expect(claimed.claimed_by).to.equal('insta');

    const stats = systemA.goalAllocator.getStats().specializationStats;
    expect(stats.preferredMatches).to.equal(1);
    expect(stats.totalClaims).to.equal(1);
    expect(stats.claimsByPreferredInstance['insta']).to.equal(1);
  });

  it('annotates prioritized goals with preferredInstance guidance', () => {
    const shared = createSharedStateStore();
    const specializationOverride = {
      cluster: {
        specialization: {
          enabled: true,
          defaults: {
            boost: 2,
            penalty: 0.5,
            unmatchedPenalty: 0.9
          },
          profiles: {
            instprimary: {
              agentTypes: ['analysis'],
              keywords: ['audit']
            },
            instsecondary: {
              agentTypes: ['synthesis']
            }
          }
        }
      }
    };

    const { system } = createGoalSystem('instprimary', shared.store, specializationOverride);

  const goal = system.addGoal({
      description: 'Perform compliance audit for governance process',
      uncertainty: 0.7,
      metadata: {
        agentTypeHint: 'analysis'
      }
    });

    system.applySpecializationGuidance([goal]);

    expect(goal.metadata?.preferredInstance).to.equal('instprimary');
    expect(goal.metadata?.specializationHints).to.be.an('array');
    expect(goal.metadata.specializationHints.length).to.be.greaterThan(0);
  });

  it('maintains specialization compliance under load', async function() {
    this.timeout(15000);

    const shared = createSharedStateStore(1200);
    const totalGoals = 60;
    const specializationOverride = {
      goals: {
        maxGoals: totalGoals + 10,
        claimTtlMs: 1200,
        agingHalfLifeMs: 900,
        stealThresholdMs: 450
      },
      cluster: {
        specialization: {
          enabled: true,
          defaults: {
            baseline: 1,
            boost: 2.4,
            penalty: 0.45,
            unmatchedPenalty: 0.85,
            minMultiplier: 0.25,
            maxMultiplier: 3.2,
            nonPreferredPenalty: 0.15
          },
          profiles: {
            alpha: {
              name: 'analysis-node',
              agentTypes: ['analysis'],
              tags: ['analysis', 'governance'],
              keywords: ['analysis', 'audit', 'assess']
            },
            beta: {
              name: 'research-node',
              agentTypes: ['research'],
              tags: ['research', 'exploration'],
              keywords: ['research', 'explore', 'discover']
            },
            gamma: {
              name: 'synthesis-node',
              agentTypes: ['synthesis'],
              tags: ['synthesis', 'integration'],
              keywords: ['synthesis', 'integrate', 'blueprint']
            }
          }
        }
      }
    };

    const rotation = ['alpha', 'beta', 'gamma'];
    const hints = {
      alpha: 'analysis',
      beta: 'research',
      gamma: 'synthesis'
    };

    const systems = rotation.map((instanceId) => {
      const { system, allocator } = createGoalSystem(instanceId, shared.store, specializationOverride);
      return { name: instanceId, system, allocator };
    });

    const preferredTotals = { alpha: 0, beta: 0, gamma: 0 };
    const matchesByPreference = { alpha: 0, beta: 0, gamma: 0 };
    const mismatchesByPreference = { alpha: 0, beta: 0, gamma: 0 };
    const matchesByInstance = { alpha: 0, beta: 0, gamma: 0 };
    const mismatchesByInstance = { alpha: 0, beta: 0, gamma: 0 };

    for (let i = 0; i < totalGoals; i++) {
      const preferredInstance = rotation[i % rotation.length];
      preferredTotals[preferredInstance] += 1;

      const description = `Load regression goal ${i} for ${preferredInstance} specialization`;
      const goal = systems[0].system.addGoal({
        description,
        uncertainty: 0.52 + (i % 5) * 0.03,
        metadata: {
          preferredInstance,
          agentTypeHint: hints[preferredInstance],
          specializationHints: [`${preferredInstance}-focus`, 'regression-check'],
          specializationTags: [preferredInstance, hints[preferredInstance], 'cluster']
        }
      });

      systems.slice(1).forEach(({ system }) => {
        const clone = JSON.parse(JSON.stringify(goal));
        system.goals.set(clone.id, clone);
      });
    }

    const claimCounts = { alpha: 0, beta: 0, gamma: 0 };
    let totalClaims = 0;
    let guard = 0;
    const maxIterations = totalGoals * 6;

    while (guard < maxIterations) {
      guard += 1;
      let claimedThisRound = false;

      for (const node of systems) {
        if (claimCounts[node.name] >= preferredTotals[node.name]) {
          continue;
        }

        const goal = await node.system.selectGoalToPursue();
        if (!goal) continue;

        claimedThisRound = true;
        totalClaims += 1;
        claimCounts[node.name] += 1;

        const preferred = (goal.metadata?.preferredInstance || '').toLowerCase();
        if (preferred) {
          if (preferred === node.name) {
            matchesByPreference[preferred] += 1;
            matchesByInstance[node.name] += 1;
          } else {
            mismatchesByPreference[preferred] += 1;
            mismatchesByInstance[node.name] += 1;
          }
        }

        node.system.completeGoal(goal.id, 'specialization-load-regression');

        systems.forEach((peer) => {
          if (peer.name === node.name) return;
          const mirror = peer.system.goals.get(goal.id);
          if (mirror) {
            mirror.status = 'completed';
            mirror.claimed_by = null;
            mirror.claim_expires = null;
          }
        });
      }

      if (!claimedThisRound) {
        break;
      }

      const allTargetsMet = rotation.every((instanceId) => claimCounts[instanceId] >= preferredTotals[instanceId]);
      if (allTargetsMet) {
        break;
      }
    }

    rotation.forEach((instanceId) => {
      expect(claimCounts[instanceId], `Did not reach target claims for ${instanceId}`).to.equal(preferredTotals[instanceId]);
    });

    rotation.forEach((instanceId) => {
      const totalPreferred = preferredTotals[instanceId];
      expect(totalPreferred, `No preferred goals recorded for ${instanceId}`).to.be.greaterThan(0);

      const matched = matchesByPreference[instanceId];
      const ratio = matched / totalPreferred;
      expect(ratio, `Specialization compliance ratio too low for ${instanceId}`).to.be.at.least(0.85);
      expect(matched + mismatchesByPreference[instanceId]).to.equal(totalPreferred);
    });

    systems.forEach((node) => {
      const stats = node.allocator.getStats().specializationStats;
      expect(stats.preferredMatches).to.equal(matchesByInstance[node.name]);
      expect(stats.preferredMismatches).to.equal(mismatchesByInstance[node.name]);

      const claimsByPreferred = stats.claimsByPreferredInstance || {};
      const matched = claimsByPreferred[node.name] || 0;
      expect(matched).to.equal(matchesByInstance[node.name]);

      const averageWeight = stats.avgWeight;
      expect(averageWeight).to.be.greaterThan(1);
    });
  });
});
