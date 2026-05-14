const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { Orchestrator } = require('../../src/core/orchestrator');

describe('Orchestrator guided continuation handling', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  function createOrchestrator() {
    return new Orchestrator(
      {
        logsDir: '.',
        architecture: {
          roleSystem: {
            explorationMode: 'guided',
            guidedFocus: {
              executionMode: 'strict',
              domain: 'Guided investigation'
            }
          },
          goals: {}
        },
        coordinator: {}
      },
      {
        memory: null,
        roles: null,
        quantum: null,
        stateModulator: null,
        thermodynamic: null,
        chaotic: { isPerturbationDue: () => false },
        goals: { getGoals: () => [] },
        reflection: null,
        environment: null,
        temporal: null,
        summarizer: null,
        goalCapture: null,
        oscillator: { isExecuting: () => false },
        coordinator: {
          auditDeliverables: async () => ({ totalFiles: 1, byAgentType: { research: 1 } })
        },
        actionCoordinator: null,
        agentExecutor: { registry: { getActiveCount: () => 0 } },
        forkSystem: null,
        topicQueue: null,
        eventEmitter: { emitEvent: () => {} }
      },
      logger
    );
  }

  it('delegates guided plan completion to the planner continuation path', async () => {
    const orchestrator = createOrchestrator();
    let queued = false;
    let fallbackQueued = false;

    orchestrator.getGuidedPlanner = () => ({
      queueContinuationPlan: async () => {
        queued = true;
      }
    });
    orchestrator.queueFallbackNextPlan = async () => {
      fallbackQueued = true;
    };

    await orchestrator.handlePlanCompletion({
      id: 'plan:main',
      title: 'Completed Guided Plan',
      createdAt: Date.now() - 1000
    });

    expect(queued).to.equal(true);
    expect(fallbackQueued).to.equal(false);
  });

  it('does not fall back to template continuation when planner continuation fails', async () => {
    const orchestrator = createOrchestrator();
    let fallbackQueued = false;
    let emittedFailure = null;

    orchestrator.getGuidedPlanner = () => ({
      queueContinuationPlan: async () => {
        throw new Error('planner failed');
      }
    });
    orchestrator.queueFallbackNextPlan = async () => {
      fallbackQueued = true;
    };
    orchestrator._getEvents = () => ({
      emitEvent: (event, payload) => {
        emittedFailure = { event, payload };
      }
    });

    await orchestrator.handlePlanCompletion({
      id: 'plan:main',
      title: 'Completed Guided Plan',
      createdAt: Date.now() - 1000
    });

    expect(fallbackQueued).to.equal(false);
    expect(emittedFailure.event).to.equal('guided_planner_failed');
    expect(emittedFailure.payload.error).to.equal('planner failed');
  });

  it('claims queued actions before running long action handlers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-action-queue-test-'));
    try {
      const queuePath = path.join(tmpDir, 'actions-queue.json');
      await fs.writeFile(queuePath, JSON.stringify({
        actions: [{
          actionId: 'action-test',
          type: 'inject_plan',
          status: 'pending',
          immediate: true
        }]
      }, null, 2));

      const orchestrator = createOrchestrator();
      orchestrator.config.logsDir = tmpDir;

      let statusSeenInsideHandler = null;
      orchestrator.processAction = async () => {
        const queued = JSON.parse(await fs.readFile(queuePath, 'utf8'));
        statusSeenInsideHandler = queued.actions[0].status;
      };

      await orchestrator.pollActionQueue(true);

      const finalQueue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
      expect(statusSeenInsideHandler).to.equal('processing');
      expect(finalQueue.actions[0].status).to.equal('completed');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not run strategic spawner when commitment governor closes spawn gate', async () => {
    const orchestrator = createOrchestrator();
    let strategicSpawnerCalled = false;

    orchestrator.commitmentGovernor = {
      evaluate: () => ({
        spawnAllowed: false,
        rateLimited: true,
        allowStrategicBypass: false,
        strategicSpawnBudget: 0,
        reasonCodes: ['provider_rate_limit_circuit_open'],
        nextActions: [{ type: 'cooldown', reason: 'provider_rate_limit_burst' }]
      })
    };
    orchestrator.collectCommitmentSnapshot = async () => ({
      cycleCount: 40,
      activeAgents: 0,
      goals: [{ id: 'goal_1', metadata: { strategicPriority: true } }],
      providerErrors: [{ cycle: 40, status: 429, type: 'rate_limit_error' }]
    });
    orchestrator.spawnStrategicGoals = async () => {
      strategicSpawnerCalled = true;
    };

    const decision = await orchestrator.evaluateCommitmentGovernor();

    expect(decision.spawnAllowed).to.equal(false);
    expect(strategicSpawnerCalled).to.equal(false);
  });
});
