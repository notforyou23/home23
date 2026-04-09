const { expect } = require('chai');

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
});
