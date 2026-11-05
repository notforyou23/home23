const assert = require('node:assert/strict');
const test = require('node:test');

const { Orchestrator } = require('../../../engine/src/core/orchestrator');

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function createOrchestrator(overrides = {}) {
  return new Orchestrator({}, {
    goals: { getGoals: () => [] },
    agentExecutor: {
      maxConcurrent: 2,
      registry: { getActiveCount: () => 0 },
      async spawnAgent() {
        return null;
      },
    },
    ...overrides,
  }, logger);
}

test('orchestrator attaches claim intake to document missions', () => {
  const orchestrator = createOrchestrator();
  const goal = {
    id: 'goal_doc',
    description: 'Create a filesystem-visible report explaining why the agent loop is stuck.',
    metadata: {
      rationale: 'Document agent needs concrete claim context.',
    },
  };
  const mission = {
    agentType: 'document_creation',
    goalId: goal.id,
    description: goal.description,
    metadata: {},
  };

  orchestrator.attachDocumentMissionIntake(mission, goal);

  assert.match(mission.intake.claimText, /filesystem-visible report/);
  assert.equal(mission.metadata.claimText, mission.intake.claimText);
  assert.equal(mission.metadata.intakeSource, 'goal_description');
});

test('strategic document agents are spawned with claim intake', async () => {
  let captured = null;
  const goal = {
    id: 'goal_doc',
    description: 'Create a filesystem-visible report identifying the agent precondition failure.',
    priority: 0.95,
    source: 'meta_coordinator_strategic',
    metadata: {
      agentType: 'document_creation',
      rationale: 'Repeated document agents are failing preconditions.',
      strategicPriority: true,
    },
  };
  const orchestrator = createOrchestrator({
    goals: { getGoals: () => [goal] },
    agentExecutor: {
      maxConcurrent: 2,
      registry: { getActiveCount: () => 0 },
      async spawnAgent(spec) {
        captured = spec;
        return 'agent-doc';
      },
    },
  });
  orchestrator.cycleCount = 42;

  await orchestrator.spawnStrategicGoals();

  assert.equal(captured.agentType, 'document_creation');
  assert.match(captured.intake.claimText, /precondition failure/);
  assert.equal(captured.metadata.claimText, captured.intake.claimText);
});
