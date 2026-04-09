/**
 * ClusterCoordinator
 *
 * Stage 4 Milestone A — review barrier orchestration.
 * Coordinates review readiness across instances, ensuring quorum
 * before meta-coordinator runs. Falls back gracefully on timeout.
 */

const crypto = require('crypto');
const { GovernanceMonitor } = require('./governance/governance-monitor');

class ClusterCoordinator {
  constructor(options) {
    this.stateStore = options.stateStore;
    this.logger = options.logger;
    this.instanceId = (options.instanceId || 'cosmo-1').toLowerCase();
    this.clusterSize = options.clusterSize || 1;

    const coordinatorConfig = options.config?.coordinator || {};

    this.enabled = coordinatorConfig.enabled !== false;
    this.settings = {
      quorumRatio: coordinatorConfig.quorumRatio || 0.67,
      minQuorum: coordinatorConfig.minQuorum || 2,
      timeoutMs: coordinatorConfig.timeoutMs || 60000,
      skipOnTimeout: coordinatorConfig.skipOnTimeout !== false,
      pollIntervalMs: coordinatorConfig.pollIntervalMs || 500,
      barrierTtlMs: coordinatorConfig.barrierTtlMs || 10 * 60 * 1000 // 10 minutes
    };

    this.clusterConfig = options.config?.cluster || {};
    const specializationSetup = this.prepareSpecializationRoster(
      this.clusterConfig,
      this.instanceId,
      this.clusterSize
    );

    this.specializationProfiles = specializationSetup.profiles;
   this.defaultProfile = specializationSetup.defaultProfile;
   this.instanceRoster = specializationSetup.instanceRoster;

    this.governanceMonitor = this.stateStore
      ? new GovernanceMonitor({
          stateStore: this.stateStore,
          logger: this.logger,
          instanceId: this.instanceId,
          config: options.config?.governance || {}
        })
      : null;
    this.lastGovernance = null;

    this.lastBarrier = null;
    this.lastPlanSummary = null;
  }

  isEnabled() {
    return this.enabled;
  }

  async initialize() {
    // No-op for now. Placeholder for future async setup.
    return true;
  }

  computeQuorum(clusterSize) {
    const ratioQuorum = Math.ceil(clusterSize * this.settings.quorumRatio);
    const minQuorum = Math.max(1, this.settings.minQuorum || 1);
    return Math.min(clusterSize, Math.max(minQuorum, ratioQuorum));
  }

  prepareSpecializationRoster(clusterConfig = {}, instanceId, clusterSize) {
    const specialization = clusterConfig.specialization || {};
    const profiles = {};
    let defaultProfile = null;

    const rawProfiles = specialization.profiles || {};
    for (const [key, value] of Object.entries(rawProfiles)) {
      const normalizedKey = String(key || '').toLowerCase();
      if (!normalizedKey || normalizedKey === 'defaults' || normalizedKey === 'default') {
        defaultProfile = this.cloneProfileForInstance('default', value || specialization.defaults || {});
        continue;
      }
      profiles[normalizedKey] = this.cloneProfileForInstance(normalizedKey, value);
    }

    if (!defaultProfile) {
      const defaults = specialization.defaults || {};
      defaultProfile = this.cloneProfileForInstance('default', defaults);
    }

    const roster = new Set();
    if (Object.keys(profiles).length > 0) {
      Object.keys(profiles).forEach((id) => roster.add(id));
    }

    const totalInstances = clusterConfig.instanceCount || clusterSize || 1;
    for (let idx = 1; idx <= totalInstances; idx += 1) {
      const derivedId = `cosmo-${idx}`.toLowerCase();
      roster.add(derivedId);
      if (!profiles[derivedId]) {
        profiles[derivedId] = this.cloneProfileForInstance(derivedId, defaultProfile);
      }
    }

    if (instanceId && !roster.has(instanceId)) {
      roster.add(instanceId);
      if (!profiles[instanceId]) {
        profiles[instanceId] = this.cloneProfileForInstance(instanceId, defaultProfile);
      }
    }

    return {
      profiles,
      defaultProfile,
      instanceRoster: Array.from(roster)
    };
  }

  sanitizeList(values) {
    if (values === undefined || values === null) return [];
    const array = Array.isArray(values) ? values : [values];
    return array
      .map((item) => {
        if (item === undefined || item === null) return null;
        return String(item).trim();
      })
      .filter((item) => item && item.length > 0);
  }

  cloneProfileForInstance(instanceId, baseProfile = {}) {
    const profileName =
      baseProfile.name ||
      baseProfile.profileName ||
      baseProfile.displayName ||
      instanceId ||
      'generalist';

    const displayName = baseProfile.displayName || profileName;

    const tags = this.sanitizeList(baseProfile.tags);
    const keywords = this.sanitizeList(baseProfile.keywords);
    const agentTypes = this.sanitizeList(baseProfile.agentTypes);
    const domains = this.sanitizeList(baseProfile.domains);

    const tagsLower = tags.map((value) => value.toLowerCase());
    const keywordsLower = keywords.map((value) => value.toLowerCase());
    const agentTypesLower = agentTypes.map((value) => value.toLowerCase());
    const domainsLower = domains.map((value) => value.toLowerCase());

    const profileInfo = {
      instanceId,
      profileName,
      displayName,
      tags,
      keywords,
      agentTypes,
      domains,
      tagsLower,
      keywordsLower,
      agentTypesLower,
      domainsLower
    };

    profileInfo.roleHint = baseProfile.roleHint || this.deriveRoleHint(profileInfo);
    profileInfo.roleHintReason =
      baseProfile.roleHintReason || this.buildRoleHintReason(profileInfo, profileInfo.roleHint);

    return profileInfo;
  }

  deriveRoleHint(profileInfo = {}) {
    const tokenSet = new Set();

    const register = (values) => {
      if (!values) return;
      const list = Array.isArray(values) ? values : [values];
      list.forEach((value) => {
        if (typeof value === 'string') {
          tokenSet.add(value.toLowerCase());
        }
      });
    };

    register(profileInfo.profileName);
    register(profileInfo.tags);
    register(profileInfo.tagsLower);
    register(profileInfo.agentTypes);
    register(profileInfo.agentTypesLower);
    register(profileInfo.keywords);
    register(profileInfo.keywordsLower);
    register(profileInfo.domains);
    register(profileInfo.domainsLower);

    const concatenated = Array.from(tokenSet).join(' ');

    const matches = (needle) => concatenated.includes(needle);

    if (matches('synth') || matches('integrat') || matches('merge') || matches('coordination')) {
      return 'synthesizer';
    }

    if (matches('analysis') || matches('aud') || matches('meta') || matches('strategy') || matches('plan')) {
      return 'author';
    }

    if (matches('research') || matches('explor') || matches('discover')) {
      return 'critic';
    }

    if (matches('qa') || matches('quality') || matches('consistency') || matches('review') || matches('critique')) {
      return 'critic';
    }

    return 'critic';
  }

  buildRoleHintReason(profileInfo = {}, roleHint = 'critic') {
    const pieces = [];
    if (profileInfo.profileName) {
      pieces.push(`specialization profile "${profileInfo.profileName}"`);
    }
    const tags = profileInfo.tags || [];
    if (tags.length > 0) {
      pieces.push(`tags: ${tags.slice(0, 3).join(', ')}`);
    }
    const agentTypes = profileInfo.agentTypes || [];
    if (agentTypes.length > 0) {
      pieces.push(`preferred agents: ${agentTypes.slice(0, 3).join(', ')}`);
    }
    const keywords = profileInfo.keywords || [];
    if (keywords.length > 0) {
      pieces.push(`keywords: ${keywords.slice(0, 3).join(', ')}`);
    }

    if (pieces.length === 0) {
      return `Assigned ${roleHint} based on cluster heuristics.`;
    }

    return `Assigned ${roleHint} via ${pieces.join('; ')}.`;
  }

  buildRosterEntries(readyInstances = []) {
    const readyRoster = [];
    const awaitingRoster = [];
    const seen = new Set();

    readyInstances.forEach((entry) => {
      if (!entry || !entry.instanceId) return;
      const instanceId = String(entry.instanceId).toLowerCase();
      seen.add(instanceId);
      const profile = this.specializationProfiles[instanceId] || this.cloneProfileForInstance(instanceId, this.defaultProfile);
      readyRoster.push(this.createRosterEntry(instanceId, profile, true, entry.timestamp || Date.now()));
    });

    const rosterSource = Array.isArray(this.instanceRoster) && this.instanceRoster.length > 0
      ? this.instanceRoster
      : readyRoster.map((entry) => entry.instanceId);

    rosterSource.forEach((instanceId) => {
      if (seen.has(instanceId)) return;
      const profile = this.specializationProfiles[instanceId] || this.cloneProfileForInstance(instanceId, this.defaultProfile);
      awaitingRoster.push(this.createRosterEntry(instanceId, profile, false, null));
      seen.add(instanceId);
    });

    return { readyRoster, awaitingRoster };
  }

  createRosterEntry(instanceId, profile, ready, timestamp) {
    const safeProfile = profile || this.cloneProfileForInstance(instanceId, this.defaultProfile);
    const roleHint = safeProfile.roleHint || this.deriveRoleHint(safeProfile);

    return {
      instanceId,
      displayName: safeProfile.displayName || instanceId,
      specialization: safeProfile.profileName || null,
      ready,
      readinessTimestamp: ready ? timestamp : null,
      roleHint,
      roleHintReason: safeProfile.roleHintReason || this.buildRoleHintReason(safeProfile, roleHint),
      profile: {
        tags: safeProfile.tags || [],
        agentTypes: safeProfile.agentTypes || [],
        keywords: safeProfile.keywords || [],
        domains: safeProfile.domains || []
      },
      role: null,
      confidence: null,
      selectionReason: null
    };
  }

  computeConfidence(entry, role) {
    if (!entry) return 0.5;

    switch (role) {
      case 'author':
        return entry.roleHint === 'author'
          ? (entry.ready ? 0.9 : 0.75)
          : (entry.ready ? 0.65 : 0.5);
      case 'critic':
        return entry.roleHint === 'critic'
          ? (entry.ready ? 0.88 : 0.72)
          : (entry.ready ? 0.62 : 0.5);
      case 'synthesizer':
        return entry.roleHint === 'synthesizer'
          ? (entry.ready ? 0.87 : 0.7)
          : (entry.ready ? 0.6 : 0.5);
      case 'author_synthesizer': {
        const authorScore = this.computeConfidence(entry, 'author');
        const synthScore = this.computeConfidence(entry, 'synthesizer');
        return Number(((authorScore + synthScore) / 2).toFixed(2));
      }
      default:
        return entry.ready ? 0.6 : 0.5;
    }
  }

  buildSelectionReason(entry, role) {
    if (!entry) return 'No assignment record available.';

    if (role === 'author_synthesizer') {
      const authorReason = this.buildSelectionReason(entry, 'author');
      const synthReason = this.buildSelectionReason(entry, 'synthesizer');
      if (authorReason === synthReason) {
        return authorReason;
      }
      return `${authorReason} Additionally covering synthesis: ${synthReason}`;
    }

    if (entry.roleHint === role) {
      return `Matches specialization hint — ${entry.roleHintReason}`;
    }

    return `Fallback assignment for ${role} (hint suggested ${entry.roleHint}).`;
  }

  assignRoles(readyRoster, awaitingRoster) {
    const warnings = [];
    const authors = readyRoster.filter((entry) => entry.roleHint === 'author');
    const selfEntry = readyRoster.find((entry) => entry.instanceId === this.instanceId);

    if (authors.length === 0 && selfEntry) {
      authors.push(selfEntry);
    }

    if (authors.length === 0 && readyRoster.length > 0) {
      authors.push(readyRoster[0]);
    }

    const authorSet = new Set();
    authors.forEach((entry) => {
      if (!entry) return;
      if (authorSet.has(entry.instanceId)) return;
      entry.role = entry.role || 'author';
      entry.confidence = this.computeConfidence(entry, entry.role);
      entry.selectionReason = this.buildSelectionReason(entry, entry.role);
      authorSet.add(entry.instanceId);
    });

    let synthesizer = readyRoster.find(
      (entry) => entry.roleHint === 'synthesizer' && !authorSet.has(entry.instanceId)
    );

    if (!synthesizer) {
      synthesizer = readyRoster.find((entry) => !authorSet.has(entry.instanceId));
    }

    if (!synthesizer && authors.length > 0) {
      synthesizer = authors[0];
      warnings.push('No dedicated synthesizer ready; author will also synthesize outputs.');
    }

    if (synthesizer) {
      synthesizer.role = authorSet.has(synthesizer.instanceId)
        ? 'author_synthesizer'
        : 'synthesizer';
      synthesizer.confidence = this.computeConfidence(synthesizer, synthesizer.role);
      synthesizer.selectionReason = this.buildSelectionReason(synthesizer, synthesizer.role);
    }

    const criticCandidates = readyRoster.filter(
      (entry) => entry.instanceId !== synthesizer?.instanceId && !authorSet.has(entry.instanceId)
    );

    const critics = criticCandidates.length > 0 ? criticCandidates : [];

    if (critics.length === 0 && readyRoster.length > 0) {
      const fallback = readyRoster.find((entry) => entry.instanceId !== synthesizer?.instanceId);
      if (fallback) {
        critics.push(fallback);
        warnings.push('No dedicated critic ready; reusing available instance for critique.');
      }
    }

    critics.forEach((entry) => {
      if (!entry.role || entry.role === 'observer') {
        entry.role = 'critic';
      }
      entry.confidence = this.computeConfidence(entry, 'critic');
      entry.selectionReason = this.buildSelectionReason(entry, 'critic');
    });

    readyRoster.forEach((entry) => {
      if (!entry.role) {
        entry.role = entry.roleHint || 'observer';
        entry.confidence = this.computeConfidence(entry, entry.role);
        entry.selectionReason = this.buildSelectionReason(entry, entry.role);
      }
    });

    awaitingRoster.forEach((entry) => {
      entry.role = entry.roleHint || 'observer';
      entry.confidence = this.computeConfidence(entry, entry.role);
      entry.selectionReason = 'Awaiting readiness signal.';
    });

    return {
      authors: Array.from(authorSet),
      critics: Array.from(new Set(critics.map((entry) => entry.instanceId))),
      synthesizer: synthesizer ? synthesizer.instanceId : null,
      warnings
    };
  }

  buildDefaultPipeline(assignments) {
    const authorLead = Array.isArray(assignments.authors) ? assignments.authors[0] || null : null;
    const criticLead = Array.isArray(assignments.critics) ? assignments.critics[0] || null : null;
    const synthLead = assignments.synthesizer || authorLead;

    return [
      {
        phase: 'draft',
        lead: authorLead,
        collaborators: Array.isArray(assignments.authors) ? assignments.authors.slice(1) : [],
        expectedArtifact: 'draft',
        dueAfterMs: 10 * 60 * 1000
      },
      {
        phase: 'critique',
        lead: criticLead,
        collaborators: Array.isArray(assignments.critics) ? assignments.critics.slice(1) : [],
        expectedArtifact: 'critique',
        dueAfterMs: 15 * 60 * 1000
      },
      {
        phase: 'synthesis',
        lead: synthLead,
        collaborators: synthLead && authorLead && synthLead !== authorLead ? [authorLead] : [],
        expectedArtifact: 'synthesis',
        dueAfterMs: 20 * 60 * 1000
      }
    ];
  }

  generatePlanId(cycle) {
    const random = crypto.randomBytes(3).toString('hex');
    return `review_plan_${cycle}_${random}`;
  }

  async coordinateReview(cycle, context = {}) {
    if (!this.enabled || !this.stateStore) {
      return { proceed: true, reason: 'disabled' };
    }

    const clusterSize = context.clusterSize || this.clusterSize || 1;
    const quorum = this.computeQuorum(clusterSize);
    const timeoutMs = context.timeoutMs || this.settings.timeoutMs;

    const readinessPayload = {
      instanceId: this.instanceId,
      timestamp: new Date().toISOString(),
      clusterSize,
      specialization: context.specialization || null,
      health: context.health || null
    };

    let forceProceed = false;
    let preGovernanceReason = null;
    let governanceStatus = null;

    if (this.governanceMonitor) {
      const preDecision = await this.governanceMonitor.evaluatePreBarrier(cycle, {
        readiness: readinessPayload
      });

      if (preDecision?.snapshot) {
        this.lastGovernance = preDecision.snapshot;
      }

      if (preDecision?.action === 'skip') {
        preGovernanceReason = preDecision.reason || 'governance_skip';
        this.lastBarrier = {
          cycle,
          status: 'governance_skip',
          decision: 'skip',
          quorum,
          readyCount: 0,
          readyInstances: [],
          durationMs: 0,
          timestamp: new Date().toISOString(),
          error: null,
          governance: preDecision.snapshot || null
        };

        return {
          proceed: false,
          reason: preGovernanceReason,
          skipReason: 'Governance directive',
          quorum,
          readyCount: 0,
          readyInstances: [],
          durationMs: 0,
          status: 'governance_skip',
          governance: preDecision.snapshot || null
        };
      }

      if (preDecision?.action === 'force_proceed') {
        forceProceed = true;
        preGovernanceReason = preDecision.reason || 'override_force_proceed';
      }
    }

    // Milestone gating check
    if (context.config?.gating?.enabled !== false) {
      const gateCheck = await this.checkMilestoneGate(cycle);
      
      if (gateCheck.blocked) {
        // Check for governance override
        const override = await this.governanceMonitor?.checkOverride('milestone_gate');
        
        if (!override) {
          this.logger.info('🚧 Milestone gate blocking review', {
            reason: gateCheck.reason,
            openTasks: gateCheck.openTasks
          });
          
          this.lastBarrier = {
            cycle,
            status: 'milestone_blocked',
            decision: 'skip',
            quorum,
            readyCount: 0,
            readyInstances: [],
            durationMs: 0,
            timestamp: new Date().toISOString(),
            gateCheck
          };
          
          return {
            proceed: false,
            reason: 'milestone_open',
            detail: gateCheck.reason,
            skipReason: 'Active milestone has uncompleted tasks',
            quorum,
            readyCount: 0,
            readyInstances: [],
            durationMs: 0,
            status: 'milestone_blocked',
            gateCheck
          };
        } else {
          this.logger.warn('⚠️  Governance override: bypassing milestone gate', {
            override: override
          });
        }
      }
    }

    try {
      await this.stateStore.recordReviewReadiness(
        cycle,
        this.instanceId,
        readinessPayload
      );
    } catch (error) {
      this.logger.error('[ClusterCoordinator] Failed to record review readiness', {
        cycle,
        error: error.message
      });
      // If we cannot record readiness, skip to avoid deadlock.
      this.lastBarrier = {
        cycle,
        status: 'error',
        decision: 'skip',
        error: error.message,
        timestamp: new Date().toISOString()
      };
      return { proceed: false, reason: 'record_error', error: error.message };
    }

    let barrierResult;
    if (forceProceed) {
      barrierResult = {
        status: 'override',
        readyCount: 1,
        readyInstances: [{ instanceId: this.instanceId, timestamp: Date.now() }],
        quorum,
        durationMs: 0
      };
      this.logger.warn('[ClusterCoordinator] Governance override forcing review proceed', {
        cycle,
        quorum
      });
    } else {
      try {
        barrierResult = await this.stateStore.awaitReviewBarrier(
          cycle,
          quorum,
          timeoutMs
        );
      } catch (error) {
        this.logger.error('[ClusterCoordinator] Error awaiting barrier', {
          cycle,
          error: error.message
        });
        barrierResult = {
          status: 'error',
          readyCount: 0,
          readyInstances: [],
          durationMs: timeoutMs,
          error: error.message
        };
      }
    }

    let proceed =
      barrierResult.status === 'proceed'
        ? true
        : barrierResult.status === 'timeout'
          ? !this.settings.skipOnTimeout
          : barrierResult.status === 'override'
            ? true
            : false;

    let reason =
      preGovernanceReason ||
      (barrierResult.status === 'proceed'
        ? 'quorum_reached'
        : barrierResult.status === 'timeout'
          ? (this.settings.skipOnTimeout ? 'timeout_skip' : 'timeout_force_proceed')
          : barrierResult.status || 'unknown');

    if (!proceed && barrierResult.status === 'timeout') {
      this.logger.warn('[ClusterCoordinator] Review quorum timeout', {
        cycle,
        readyCount: barrierResult.readyCount,
        quorum,
        decision: this.settings.skipOnTimeout ? 'skip' : 'proceed_anyway'
      });
    }

    if (this.governanceMonitor) {
      const postDecision = await this.governanceMonitor.evaluatePostBarrier(cycle, barrierResult, {
        readiness: readinessPayload
      });

      if (postDecision?.snapshot) {
        this.lastGovernance = postDecision.snapshot;
      }

      if (!postDecision?.proceed) {
        proceed = false;
        reason = postDecision.reason || postDecision.action || reason;
        governanceStatus = postDecision.action || 'governance_skip';
      }
    }

    let plan = null;
    if (proceed) {
      plan = await this.ensureReviewPlan(cycle, barrierResult, {
        context,
        readinessPayload
      });
    }

    const planSummary = this.summarizePlan(plan);

    const barrierStatus = governanceStatus ? 'governance_skip' : barrierResult.status;

    this.lastBarrier = {
      cycle,
      status: barrierStatus,
      decision: proceed ? 'proceed' : 'skip',
      quorum,
      readyCount: barrierResult.readyCount,
      readyInstances: barrierResult.readyInstances || [],
      durationMs: barrierResult.durationMs || 0,
      timestamp: new Date().toISOString(),
      error: barrierResult.error || null,
      planSummary,
      governance: this.lastGovernance || null
    };
    this.lastPlanSummary = planSummary;

    return {
      proceed,
      reason,
      quorum,
      readyCount: barrierResult.readyCount,
      readyInstances: barrierResult.readyInstances || [],
      durationMs: barrierResult.durationMs || 0,
      status: barrierStatus,
      error: barrierResult.error || null,
      plan,
      planSummary,
      governance: this.lastGovernance || null
    };
  }

  async checkMilestoneGate(cycle) {
    try {
      const activePlan = await this.stateStore?.getPlan('plan:main');
      if (!activePlan || !activePlan.activeMilestone) {
        return { blocked: false };
      }
      
      const tasks = await this.stateStore.listTasks(activePlan.id, {
        milestoneId: activePlan.activeMilestone
      });
      
      const openTasks = tasks.filter(t => t.state !== 'DONE');
      
      if (openTasks.length > 0) {
        return {
          blocked: true,
          reason: `Milestone ${activePlan.activeMilestone} has ${openTasks.length} open tasks`,
          openTasks: openTasks.map(t => ({ id: t.id, title: t.title, state: t.state }))
        };
      }
      
      return { blocked: false };
    } catch (error) {
      this.logger.error('[ClusterCoordinator] checkMilestoneGate error', {
        cycle,
        error: error.message
      });
      return { blocked: false };
    }
  }

  async clearReviewState(cycle) {
    if (!this.stateStore || !this.stateStore.clearReviewBarrier) return false;
    try {
      return await this.stateStore.clearReviewBarrier(cycle);
    } catch (error) {
      this.logger.warn('[ClusterCoordinator] Failed to clear review state', {
        cycle,
        error: error.message
      });
      return false;
    }
  }

  export() {
    return {
      enabled: this.enabled,
      lastBarrier: this.lastBarrier,
      lastPlan: this.lastPlanSummary,
      lastGovernance: this.lastGovernance
    };
  }

  import(snapshot = {}) {
    if (snapshot && snapshot.lastBarrier) {
      this.lastBarrier = snapshot.lastBarrier;
    }
    if (snapshot && snapshot.lastPlan) {
      this.lastPlanSummary = snapshot.lastPlan;
    }
    if (snapshot && snapshot.lastGovernance) {
      this.lastGovernance = snapshot.lastGovernance;
    }
  }

  getStats() {
    return {
      enabled: this.enabled,
      lastBarrier: this.lastBarrier,
      lastPlan: this.lastPlanSummary,
      lastGovernance: this.lastGovernance
    };
  }

  summarizePlan(plan) {
    if (!plan) return null;
    return {
      planId: plan.planId || null,
      createdAt: plan.createdAt || null,
      status: plan.status || 'assigned',
      cycle: plan.cycle || null,
      authors: Array.isArray(plan.assignments?.authors) ? plan.assignments.authors : [],
      critics: Array.isArray(plan.assignments?.critics) ? plan.assignments.critics : [],
      synthesizer: plan.assignments?.synthesizer || null,
      warnings: plan.warnings || [],
      readyCount: plan.readyCount || 0,
      rosterSize: Array.isArray(plan.roster) ? plan.roster.length : 0,
      pipeline: Array.isArray(plan.pipeline)
        ? plan.pipeline.map((stage) => ({
            phase: stage.phase,
            lead: stage.lead,
            expectedArtifact: stage.expectedArtifact || null,
            dueAfterMs: stage.dueAfterMs || null
          }))
        : [],
      governance: plan.governance || null
    };
  }

  async ensureReviewPlan(cycle, barrierResult, metadata = {}) {
    if (!this.stateStore || typeof this.stateStore.createReviewPlan !== 'function') {
      return null;
    }

    try {
      const existing = await this.stateStore.getReviewPlan(cycle);
      if (existing) {
        return existing;
      }

      const readyInstances = Array.isArray(barrierResult?.readyInstances)
        ? barrierResult.readyInstances
        : [];

      const { readyRoster, awaitingRoster } = this.buildRosterEntries(readyInstances);
      const assignments = this.assignRoles(readyRoster, awaitingRoster);

      const planPayload = {
        planId: this.generatePlanId(cycle),
        cycle,
        status: 'assigned',
        createdAt: new Date().toISOString(),
        createdBy: this.instanceId,
        quorum: barrierResult?.quorum || this.computeQuorum(metadata.context?.clusterSize || this.clusterSize || 1),
        readyCount: readyInstances.length,
        readyInstances,
        assignments,
        roster: readyRoster.map((entry) => ({
          instanceId: entry.instanceId,
          displayName: entry.displayName,
          specialization: entry.specialization,
          ready: entry.ready,
          readinessTimestamp: entry.readinessTimestamp,
          roleHint: entry.roleHint,
          roleHintReason: entry.roleHintReason,
          role: entry.role,
          confidence: entry.confidence,
          selectionReason: entry.selectionReason
        })),
        awaiting: awaitingRoster.map((entry) => ({
          instanceId: entry.instanceId,
          displayName: entry.displayName,
          specialization: entry.specialization,
          roleHint: entry.roleHint,
          roleHintReason: entry.roleHintReason,
          role: entry.role,
          confidence: entry.confidence,
          selectionReason: entry.selectionReason
        })),
        warnings: assignments.warnings,
        heuristics: {
          rosterSize: readyRoster.length,
          awaitingCount: awaitingRoster.length,
          createdBy: this.instanceId,
          generatedAt: new Date().toISOString()
        },
        pipeline: this.buildDefaultPipeline(assignments),
        governance: this.lastGovernance || null
      };

      const persisted = await this.stateStore.createReviewPlan(cycle, planPayload);

      await this.recordReviewEvent(cycle, {
        event: 'plan_created',
        planId: persisted?.planId || planPayload.planId,
        instanceId: this.instanceId,
        readyCount: readyInstances.length,
        awaitingCount: awaitingRoster.length,
        assignments
      });

      return persisted;
    } catch (error) {
      this.logger.error('[ClusterCoordinator] Failed to persist review plan', {
        cycle,
        error: error.message
      });
      return null;
    }
  }

  async recordReviewEvent(cycle, event) {
    if (!this.stateStore || typeof this.stateStore.appendReviewEvent !== 'function') {
      return false;
    }

    try {
      await this.stateStore.appendReviewEvent(cycle, {
        ...event,
        timestamp: new Date().toISOString()
      });
      return true;
    } catch (error) {
      this.logger.warn('[ClusterCoordinator] Failed to append review event', {
        cycle,
        error: error.message
      });
      return false;
    }
  }
}

module.exports = { ClusterCoordinator };
