const { expect } = require('chai');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { MetaCoordinator } = require('../../src/coordinator/meta-coordinator');

describe('MetaCoordinator specialization routing', () => {
  let originalKey;
  let coordinator;
  let mockLogger;

  const buildConfig = () => ({
    coordinator: {
      enabled: true
    },
    architecture: {
      roleSystem: {
        explorationMode: 'autonomous'
      }
    },
    cluster: {
      enabled: true,
      specialization: {
        enabled: true,
        defaults: {
          boost: 2,
          penalty: 0.5,
          unmatchedPenalty: 1,
          minMultiplier: 0.3,
          maxMultiplier: 3,
          nonPreferredPenalty: 0.1
        },
        profiles: {
          'cosmo-1': {
            name: 'analysis-node',
            agentTypes: ['analysis'],
            tags: ['analysis', 'governance'],
            keywords: ['analysis', 'audit', 'assessment']
          },
          'cosmo-2': {
            name: 'research-node',
            agentTypes: ['research'],
            tags: ['research'],
            keywords: ['discover', 'explore']
          }
        }
      }
    }
  });

  before(() => {
    originalKey = process.env.OPENAI_API_KEY;
    if (!originalKey) {
      process.env.OPENAI_API_KEY = 'test-key';
    }
  });

  after(() => {
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    coordinator = new MetaCoordinator(buildConfig(), mockLogger);
  });

  it('prioritizes goals aligned with local specialization', () => {
    const matchingGoal = {
      id: 'goal_matching',
      description: 'Perform detailed analysis of compliance audit findings.',
      priority: 0.7,
      progress: 0.1,
      pursuitCount: 1,
      metadata: {
        preferredInstance: 'cosmo-1',
        specializationScore: 2.5,
        specializationTags: ['analysis', 'compliance']
      }
    };

    const mismatchedGoal = {
      id: 'goal_other',
      description: 'Explore new research directions in emergent systems.',
      priority: 0.8,
      progress: 0.2,
      pursuitCount: 1,
      metadata: {
        preferredInstance: 'cosmo-2',
        specializationScore: 2.2,
        specializationTags: ['research', 'exploration']
      }
    };

    const ordered = coordinator.applySpecializationRouting([mismatchedGoal, matchingGoal]);

    expect(ordered[0].id).to.equal('goal_matching');
    expect(ordered[1].id).to.equal('goal_other');
    expect(ordered[0].metadata.lastCoordinatorRouting.weight)
      .to.be.greaterThan(ordered[1].metadata.lastCoordinatorRouting.weight);
    expect(coordinator.lastSpecializationRouting.boosted).to.include('goal_matching');
    expect(coordinator.lastSpecializationRouting.penalized).to.include('goal_other');
  });

  it('annotates mission specs with specialization routing metadata', async () => {
    const goal = {
      id: 'goal_spec',
      description: 'Deliver an audit readiness assessment summary.',
      priority: 0.6,
      progress: 0.05,
      pursuitCount: 0,
      metadata: {
        preferredInstance: 'cosmo-1',
        agentTypeHint: 'analysis',
        specializationScore: 2.1,
        specializationTags: ['analysis']
      }
    };

    // Stub out LLM dependency
    coordinator.gpt5.generateWithRetry = async () => ({
      content: JSON.stringify({
        agentType: 'analysis',
        description: 'Compile audit readiness findings into a summarized assessment.',
        successCriteria: [
          'Summarize key audit findings',
          'Highlight compliance gaps',
          'Recommend remediation actions'
        ],
        maxDurationMinutes: 12,
        rationale: 'Analysis agent best suited for assessment synthesis'
      })
    });

    const missionSpec = await coordinator.createMissionSpec(goal, 42);

    expect(missionSpec).to.be.an('object');
    expect(missionSpec.specializationRouting).to.deep.include({
      instanceId: 'cosmo-1',
      preferredMatched: true
    });
    expect(missionSpec.specializationRouting.weight).to.be.greaterThan(1);
    expect(missionSpec.specializationRouting.reasons).to.be.an('array').that.is.not.empty;
  });

  it('persists specialization routing across context save/load', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'meta-coordinator-'));

    const goals = [
      {
        id: 'goal_a',
        description: 'Provide compliance analysis for audit regulators.',
        priority: 0.9,
        progress: 0.2,
        metadata: {
          preferredInstance: 'cosmo-1',
          specializationTags: ['analysis', 'audit']
        }
      },
      {
        id: 'goal_b',
        description: 'Launch broad research exploration for emerging behaviours.',
        priority: 0.6,
        progress: 0.1,
        metadata: {
          preferredInstance: 'cosmo-2',
          specializationTags: ['research']
        }
      }
    ];

    coordinator.coordinatorDir = tmpDir;
    const routedGoals = coordinator.applySpecializationRouting(goals);
    expect(routedGoals[0].metadata.lastCoordinatorRouting).to.exist;

    await coordinator.saveContext();

    const rehydrated = new MetaCoordinator(buildConfig(), mockLogger);
    rehydrated.coordinatorDir = tmpDir;
    await rehydrated.loadContext();

    expect(rehydrated.lastSpecializationRouting).to.deep.equal(coordinator.lastSpecializationRouting);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
