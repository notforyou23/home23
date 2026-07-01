const { expect } = require('chai');

const { RunCommitmentGovernor } = require('../../src/core/run-commitment-governor');

describe('RunCommitmentGovernor', () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  it('opens provider circuit breaker after repeated 429 errors', () => {
    const governor = new RunCommitmentGovernor({
      rateLimitWindowCycles: 8,
      rateLimitThreshold: 3,
      rateLimitCooldownCycles: 5
    }, logger);

    const decision = governor.evaluate({
      cycleCount: 40,
      activeAgents: 0,
      goals: [{ id: 'goal_1', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true } }],
      providerErrors: [
        { cycle: 34, provider: 'anthropic', status: 429, type: 'rate_limit_error' },
        { cycle: 35, provider: 'anthropic', status: 429, type: 'rate_limit_error' },
        { cycle: 36, provider: 'anthropic', status: 429, type: 'rate_limit_error' }
      ],
      artifactAudit: { committedArtifacts: 0, neverReusedArtifacts: 3, unregisteredFiles: 2 },
      synthesisCommit: { applied: true, spine_count: 5, artifact_count: 9 }
    });

    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.rateLimited).to.equal(true);
    expect(decision.reasonCodes).to.include('provider_rate_limit_circuit_open');
    expect(decision.cooldownUntilCycle).to.equal(45);
  });

  it('requires artifact commitment when graph has outputs but no committed artifacts', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 24,
      activeAgents: 0,
      goals: [],
      providerErrors: [],
      artifactAudit: {
        outputFiles: 12,
        registeredArtifacts: 8,
        committedArtifacts: 0,
        neverReusedArtifacts: 8,
        unregisteredFiles: 4
      },
      synthesisCommit: { applied: true, spine_count: 5, artifact_count: 8 }
    });

    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.requiresArtifactCommitment).to.equal(true);
    expect(decision.nextActions).to.deep.include({
      type: 'commit_artifacts',
      reason: 'outputs_exist_without_committed_artifacts'
    });
  });

  it('caps strategic spawn budget and refuses bypass for non-repair guided work', () => {
    const governor = new RunCommitmentGovernor({
      maxStrategicSpawnsPerCycle: 1
    }, logger);

    const decision = governor.evaluate({
      cycleCount: 33,
      guidedRun: true,
      activeAgents: 0,
      goals: [
        { id: 'goal_1', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true, agentType: 'document_creation' } },
        { id: 'goal_2', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true, agentType: 'code_creation' } }
      ],
      providerErrors: [],
      artifactAudit: { committedArtifacts: 2, neverReusedArtifacts: 0, unregisteredFiles: 0 },
      synthesisCommit: { applied: true, spine_count: 4, artifact_count: 2 }
    });

    expect(decision.spawnAllowed).to.equal(true);
    expect(decision.strategicSpawnBudget).to.equal(1);
    expect(decision.allowStrategicBypass).to.equal(false);
    expect(decision.reasonCodes).to.include('guided_non_repair_work_must_not_bypass_limits');
  });

  it('allows completion when plan is done, commitments exist, and provider health is clean', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 40,
      guidedRun: true,
      activeAgents: 0,
      goals: [],
      providerErrors: [],
      plan: { status: 'DONE' },
      artifactAudit: { committedArtifacts: 3, neverReusedArtifacts: 0, unregisteredFiles: 0 },
      synthesisCommit: { applied: true, spine_count: 5, artifact_count: 1 }
    });

    expect(decision.shouldStopForCompletion).to.equal(true);
    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.reasonCodes).to.include('run_has_committed_answer');
  });

  it('allows completion when PlanExecutor uses COMPLETED status', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 41,
      guidedRun: true,
      activeAgents: 0,
      goals: [],
      providerErrors: [],
      plan: { status: 'COMPLETED' },
      artifactAudit: { committedArtifacts: 2, neverReusedArtifacts: 0, unregisteredFiles: 0 },
      synthesisCommit: { applied: true, spine_count: 3, artifact_count: 1 }
    });

    expect(decision.shouldStopForCompletion).to.equal(true);
    expect(decision.reasonCodes).to.include('run_has_committed_answer');
  });

  it('stops guided spawning and requests repair when the plan is blocked', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 50,
      guidedRun: true,
      activeAgents: 0,
      goals: [],
      providerErrors: [],
      plan: {
        status: 'BLOCKED',
        blockedReason: 'Research contract failed: missing_source_evidence'
      },
      artifactAudit: { committedArtifacts: 0, neverReusedArtifacts: 0, unregisteredFiles: 0 },
      synthesisCommit: null
    });

    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.shouldStopForBlockedRun).to.equal(true);
    expect(decision.reasonCodes).to.include('guided_plan_blocked');
    expect(decision.nextActions).to.deep.include({
      type: 'repair_blocked_research',
      reason: 'Research contract failed: missing_source_evidence'
    });
    expect(decision.nextActions).to.deep.include({
      type: 'stop_unproductive_run',
      reason: 'guided_plan_blocked'
    });
  });

  it('closes spawning and requests source-route repair when source backbone receipts are blocked', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 57,
      guidedRun: true,
      activeAgents: 0,
      goals: [{ id: 'goal_1', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true } }],
      providerErrors: [],
      plan: { status: 'ACTIVE' },
      artifactAudit: {
        committedArtifacts: 0,
        neverReusedArtifacts: 0,
        unregisteredFiles: 0,
        sourceBackboneBlockCount: 1,
        sourceBackboneBlocks: [{
          nextAllowedAction: 'attempt_missing_required_source_routes',
          missingRequiredRoutes: ['crossref.works'],
          failedRequiredRoutes: []
        }]
      },
      synthesisCommit: null
    });

    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.strategicSpawnBudget).to.equal(0);
    expect(decision.urgentSpawnBudget).to.equal(0);
    expect(decision.reasonCodes).to.include('source_backbone_route_blocked');
    expect(decision.nextActions).to.deep.include({
      type: 'repair_source_routes',
      reason: 'attempt_missing_required_source_routes',
      missingRequiredRoutes: ['crossref.works'],
      failedRequiredRoutes: [],
      sourceBackboneBlockCount: 1
    });
  });

  it('normalizes provider error objects into governor-compatible events', () => {
    const governor = new RunCommitmentGovernor({}, logger);
    const event = governor.normalizeProviderError({
      cycle: 12,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      error: new Error('429 {"type":"error","error":{"type":"rate_limit_error"}}')
    });

    expect(event.status).to.equal(429);
    expect(event.type).to.equal('rate_limit_error');
    expect(event.provider).to.equal('anthropic');
    expect(event.cycle).to.equal(12);
  });
});
