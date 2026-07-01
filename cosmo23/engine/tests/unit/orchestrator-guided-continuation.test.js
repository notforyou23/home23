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
        logsDir: os.tmpdir(),
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
        eventEmitter: {
          emitEvent: () => {},
          emitRunStatus: () => {},
          emitResearchComplete: () => {}
        }
      },
      logger
    );
  }

  it('requests terminal closeout for strict guided plan completion by default', async () => {
    const orchestrator = createOrchestrator();
    orchestrator.running = true;
    let queued = false;

    orchestrator.getGuidedPlanner = () => ({
      queueContinuationPlan: async () => {
        queued = true;
      }
    });

    await orchestrator.handlePlanCompletion({
      id: 'plan:main',
      title: 'Completed Guided Plan',
      createdAt: Date.now() - 1000,
      completedAt: Date.now()
    });

    expect(queued).to.equal(false);
    expect(orchestrator.running).to.equal(false);
    expect(orchestrator.recursiveState.halted).to.equal(true);
    expect(orchestrator.recursiveState.haltReason).to.equal('guided_plan_completed');
    expect(orchestrator.runCompletionRequested).to.include({
      reason: 'guided_plan_completed',
      planId: 'plan:main'
    });
  });

  it('delegates guided plan completion to the planner continuation path when auto-continue is enabled', async () => {
    const orchestrator = createOrchestrator();
    let queued = false;
    let fallbackQueued = false;
    orchestrator.config.architecture.roleSystem.guidedFocus.autoContinue = true;

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
    expect(orchestrator.runCompletionRequested).to.equal(null);
  });

  it('does not fall back to template continuation when planner continuation fails', async () => {
    const orchestrator = createOrchestrator();
    let fallbackQueued = false;
    let emittedFailure = null;
    orchestrator.config.architecture.roleSystem.guidedFocus.autoContinue = true;

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
      },
      emitRunStatus: () => {},
      emitResearchComplete: () => {}
    });

    await orchestrator.handlePlanCompletion({
      id: 'plan:main',
      title: 'Completed Guided Plan',
      createdAt: Date.now() - 1000
    });

    expect(fallbackQueued).to.equal(false);
    expect(emittedFailure.event).to.equal('guided_planner_failed');
    expect(emittedFailure.payload.error).to.equal('planner failed');
    expect(orchestrator.runCompletionRequested.reason).to.equal('guided_continuation_planner_failed');
  });

  it('handles persisted completed guided plans that bypass PLAN_COMPLETED executor action', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-completed-plan-test-'));
    try {
      const orchestrator = createOrchestrator();
      orchestrator.config.logsDir = tmpDir;
      orchestrator.logsDir = tmpDir;
      orchestrator.running = true;
      orchestrator.clusterStateStore = {
        getPlan: async () => ({
          id: 'plan:main',
          title: 'Persisted Completed Plan',
          status: 'COMPLETED',
          createdAt: Date.now() - 1000,
          completedAt: Date.now()
        }),
        listTasks: async () => [
          { id: 'task:phase1', state: 'DONE' },
          { id: 'task:phase2', state: 'DONE' }
        ],
        listMilestones: async () => [
          { id: 'ms:phase1', status: 'COMPLETED' },
          { id: 'ms:phase2', status: 'COMPLETED' }
        ]
      };

      const handled = await orchestrator.handlePersistedCompletedPlanIfReady('unit_test');

      expect(handled).to.equal(true);
      expect(orchestrator.running).to.equal(false);
      expect(orchestrator.runCompletionRequested).to.include({
        reason: 'guided_plan_completed',
        trigger: 'unit_test',
        planId: 'plan:main'
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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

  it('services guided pending tiers outside commitment-gated review spawning', async () => {
    const orchestrator = createOrchestrator();
    let calls = 0;
    orchestrator.coordinator.spawnPendingTierIfReady = async () => {
      calls += 1;
      return true;
    };

    const spawned = await orchestrator.spawnGuidedPendingTierIfReady('unit_test');

    expect(spawned).to.equal(true);
    expect(calls).to.equal(1);
  });

  it('records unimplemented commit_artifacts action instead of silently applying it', async () => {
    const orchestrator = createOrchestrator();
    orchestrator.commitmentGovernor = {
      normalizeProviderError: event => event,
      evaluate: () => ({
        spawnAllowed: false,
        reasonCodes: ['outputs_exist_without_committed_artifacts'],
        nextActions: [{ type: 'commit_artifacts', reason: 'outputs_exist_without_committed_artifacts' }]
      })
    };
    orchestrator.collectCommitmentSnapshot = async () => ({
      cycleCount: 60,
      activeAgents: 0,
      goals: [],
      artifactAudit: {
        outputFiles: 2,
        committedArtifacts: 0
      }
    });

    await orchestrator.evaluateCommitmentGovernor();

    expect(orchestrator.lastCommitmentDecision.appliedActions).to.deep.include({
      type: 'commit_artifacts',
      applied: false,
      reason: 'commit_artifacts_executor_not_implemented',
      artifactAudit: {
        outputFiles: 2,
        committedArtifacts: 0
      }
    });
  });

  it('halts a guided run when the commitment governor requests stop for a blocked plan', async () => {
    const orchestrator = createOrchestrator();
    orchestrator.running = true;
    orchestrator.commitmentGovernor = {
      evaluate: () => ({
        spawnAllowed: false,
        shouldStopForBlockedRun: true,
        reasonCodes: ['guided_plan_blocked'],
        nextActions: [
          { type: 'repair_blocked_research', reason: 'Research contract failed: missing_source_evidence' },
          { type: 'stop_unproductive_run', reason: 'guided_plan_blocked' }
        ]
      })
    };
    orchestrator.collectCommitmentSnapshot = async () => ({
      cycleCount: 50,
      guidedRun: true,
      activeAgents: 0,
      goals: [],
      plan: { status: 'BLOCKED', blockedReason: 'Research contract failed: missing_source_evidence' }
    });

    const decision = await orchestrator.evaluateCommitmentGovernor();

    expect(decision.shouldStopForBlockedRun).to.equal(true);
    expect(orchestrator.running).to.equal(false);
    expect(orchestrator.recursiveState.halted).to.equal(true);
    expect(orchestrator.recursiveState.haltReason).to.equal('guided_plan_blocked');
    expect(orchestrator.lastCommitmentDecision.appliedActions).to.deep.include({
      type: 'stop_unproductive_run',
      applied: true,
      reason: 'guided_plan_blocked'
    });
  });
});
