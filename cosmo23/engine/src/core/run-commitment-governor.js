/**
 * RunCommitmentGovernor
 *
 * Pure run-level decision unit for COSMO23. It does not spawn agents, mutate
 * tasks, or write files. It only turns current run state into a bounded
 * decision about whether the engine should keep spawning, cool down, commit
 * artifacts, or stop because the run already has a committed answer.
 */
class RunCommitmentGovernor {
  constructor(config = {}, logger = console) {
    this.config = {
      enabled: config.enabled !== false,
      rateLimitWindowCycles: toNumber(config.rateLimitWindowCycles ?? config.rate_limit_window_cycles, 8),
      rateLimitThreshold: toNumber(config.rateLimitThreshold ?? config.rate_limit_threshold, 3),
      rateLimitCooldownCycles: toNumber(config.rateLimitCooldownCycles ?? config.rate_limit_cooldown_cycles, 5),
      maxStrategicSpawnsPerCycle: toNumber(config.maxStrategicSpawnsPerCycle ?? config.max_strategic_spawns_per_cycle, 1),
      maxUrgentSpawnsPerCycle: toNumber(config.maxUrgentSpawnsPerCycle ?? config.max_urgent_spawns_per_cycle, 1),
      requireCommittedArtifacts: config.requireCommittedArtifacts !== false,
      preserveDifferentiatedRoles: config.preserveDifferentiatedRoles !== false
    };
    this.logger = logger;
  }

  normalizeProviderError(input = {}) {
    const error = input.error || {};
    const message = String(error.message || input.message || '');
    const status = toNullableNumber(input.status ?? error.status ?? error.statusCode) ||
      (message.includes('429') ? 429 : null);
    const type = input.type || error.type || error.error?.type ||
      (/rate[_ -]?limit/i.test(message) ? 'rate_limit_error' : 'provider_error');

    return {
      cycle: toNumber(input.cycle, 0),
      provider: input.provider || input.assignment?.provider || null,
      model: input.model || input.assignment?.model || null,
      status,
      type,
      message: message.slice(0, 500),
      timestamp: input.timestamp || new Date().toISOString()
    };
  }

  evaluate(snapshot = {}) {
    if (!this.config.enabled) {
      return this.buildDecision({
        spawnAllowed: true,
        reasonCodes: ['commitment_governor_disabled']
      });
    }

    const reasonCodes = [];
    const nextActions = [];
    const cycleCount = toNumber(snapshot.cycleCount, 0);
    const activeAgents = toNumber(snapshot.activeAgents, 0);
    const goals = normalizeArray(snapshot.goals);
    const artifactAudit = snapshot.artifactAudit || {};
    const synthesisCommit = snapshot.synthesisCommit || null;
    const providerErrors = normalizeArray(snapshot.providerErrors).map(event => this.normalizeProviderError(event));
    const planStatus = String(snapshot.plan?.status || '').toUpperCase();

    const guidedPlanBlocked = Boolean(snapshot.guidedRun) && planStatus === 'BLOCKED';
    if (guidedPlanBlocked) {
      reasonCodes.push('guided_plan_blocked');
      nextActions.push({
        type: 'repair_blocked_research',
        reason: snapshot.plan?.blockedReason || 'guided_plan_blocked'
      });
      nextActions.push({ type: 'stop_unproductive_run', reason: 'guided_plan_blocked' });
    }

    const recentRateLimits = providerErrors.filter(error => {
      const isRateLimit = error.status === 429 ||
        error.type === 'rate_limit_error' ||
        /rate[_ -]?limit/i.test(error.message || '');
      const inWindow = cycleCount - toNumber(error.cycle, cycleCount) <= this.config.rateLimitWindowCycles;
      return isRateLimit && inWindow;
    });

    const rateLimited = recentRateLimits.length >= this.config.rateLimitThreshold;
    if (rateLimited) {
      reasonCodes.push('provider_rate_limit_circuit_open');
      nextActions.push({ type: 'cooldown', reason: 'provider_rate_limit_burst' });
    }

    const outputFiles = toNumber(artifactAudit.outputFiles, 0);
    const registeredArtifacts = toNumber(artifactAudit.registeredArtifacts, 0);
    const committedArtifacts = toNumber(artifactAudit.committedArtifacts, 0);
    const neverReusedArtifacts = toNumber(artifactAudit.neverReusedArtifacts, 0);
    const unregisteredFiles = toNumber(artifactAudit.unregisteredFiles, 0);
    const sourceBackboneBlocks = normalizeArray(artifactAudit.sourceBackboneBlocks);
    const sourceBackboneBlockCount = toNumber(
      artifactAudit.sourceBackboneBlockCount,
      sourceBackboneBlocks.length
    );
    const sourceBackboneBlocked = sourceBackboneBlockCount > 0;
    if (sourceBackboneBlocked) {
      const firstBlock = sourceBackboneBlocks[0] || {};
      reasonCodes.push('source_backbone_route_blocked');
      nextActions.push({
        type: 'repair_source_routes',
        reason: firstBlock.nextAllowedAction || 'source_backbone_route_blocked',
        missingRequiredRoutes: firstBlock.missingRequiredRoutes || [],
        failedRequiredRoutes: firstBlock.failedRequiredRoutes || [],
        sourceBackboneBlockCount
      });
    }
    const hasArtifactWork = outputFiles > 0 ||
      registeredArtifacts > 0 ||
      neverReusedArtifacts > 0 ||
      unregisteredFiles > 0;
    const requiresArtifactCommitment = this.config.requireCommittedArtifacts &&
      hasArtifactWork &&
      committedArtifacts === 0;

    if (requiresArtifactCommitment) {
      reasonCodes.push('outputs_exist_without_committed_artifacts');
      nextActions.push({ type: 'commit_artifacts', reason: 'outputs_exist_without_committed_artifacts' });
    }

    const strategicGoals = goals.filter(goal => isStrategicGoal(goal));
    const guidedNonRepair = Boolean(snapshot.guidedRun) &&
      strategicGoals.some(goal => !isSystemRepairGoal(goal));

    if (guidedNonRepair) {
      reasonCodes.push('guided_non_repair_work_must_not_bypass_limits');
    }

    const hasSynthesisCommit = Boolean(synthesisCommit?.applied) &&
      toNumber(synthesisCommit?.spine_count ?? synthesisCommit?.spineCount, 0) > 0;
    const noOpenGaps = unregisteredFiles === 0 && neverReusedArtifacts === 0;
    const planComplete = planStatus === 'DONE' || planStatus === 'COMPLETED';
    const shouldStopForCompletion = activeAgents === 0 &&
      goals.length === 0 &&
      planComplete &&
      hasSynthesisCommit &&
      committedArtifacts > 0 &&
      noOpenGaps &&
      !rateLimited;

    if (shouldStopForCompletion) {
      reasonCodes.push('run_has_committed_answer');
    }

    const spawnAllowed = !rateLimited &&
      !requiresArtifactCommitment &&
      !shouldStopForCompletion &&
      !guidedPlanBlocked &&
      !sourceBackboneBlocked;

    return this.buildDecision({
      spawnAllowed,
      rateLimited,
      cooldownUntilCycle: rateLimited ? cycleCount + this.config.rateLimitCooldownCycles : null,
      requiresArtifactCommitment,
      shouldStopForCompletion,
      shouldStopForBlockedRun: guidedPlanBlocked,
      allowStrategicBypass: !guidedNonRepair && !rateLimited && !sourceBackboneBlocked,
      strategicSpawnBudget: (rateLimited || sourceBackboneBlocked) ? 0 : Math.min(this.config.maxStrategicSpawnsPerCycle, strategicGoals.length),
      urgentSpawnBudget: (rateLimited || sourceBackboneBlocked) ? 0 : this.config.maxUrgentSpawnsPerCycle,
      reasonCodes,
      nextActions,
      summary: {
        cycleCount,
        activeAgents,
        goals: goals.length,
        strategicGoals: strategicGoals.length,
        recentRateLimits: recentRateLimits.length,
        committedArtifacts,
        unregisteredFiles,
        neverReusedArtifacts,
        sourceBackboneBlockCount
      }
    });
  }

  buildDecision(overrides = {}) {
    return {
      spawnAllowed: false,
      rateLimited: false,
      cooldownUntilCycle: null,
      requiresArtifactCommitment: false,
      shouldStopForCompletion: false,
      shouldStopForBlockedRun: false,
      allowStrategicBypass: false,
      strategicSpawnBudget: 0,
      urgentSpawnBudget: 0,
      reasonCodes: [],
      nextActions: [],
      summary: {},
      ...overrides
    };
  }
}

function isStrategicGoal(goal = {}) {
  return goal.source === 'meta_coordinator_strategic' ||
    goal.metadata?.strategicPriority === true ||
    goal.metadata?.gapDriven === true ||
    goal.metadata?.escalated === true;
}

function isSystemRepairGoal(goal = {}) {
  return goal.metadata?.systemRepair === true ||
    goal.metadata?.commitmentBypassApproved === true ||
    goal.triggerSource === 'system_repair';
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { RunCommitmentGovernor };
