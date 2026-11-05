/**
 * GoalAllocator
 *
 * Atomic goal claiming with work-stealing and aging priority.
 * Works with both Redis and Filesystem backends.
 *
 * Phase C: Goal Allocation
 *
 * Features:
 * - Atomic goal claiming (no duplicates)
 * - TTL-based work-stealing (reclaim expired claims)
 * - Aging priority (prevents starvation)
 * - Fair distribution across instances
 */

class GoalAllocator {
  constructor(config, stateStore, instanceId, logger) {
    this.config = config;
    this.stateStore = stateStore;
    this.instanceId = instanceId;
    this.logger = logger;

    // Configuration
    this.claimTtlMs = config.goals?.claimTtlMs || 600000; // 10 minutes default
    this.agingHalfLifeMs = config.goals?.agingHalfLifeMs || 900000; // 15 minutes
    this.stealThresholdMs = config.goals?.stealThresholdMs || 60000; // 1 minute before expiry
    
    // Stats
    this.claimAttempts = 0;
    this.claimSuccesses = 0;
    this.claimFailures = 0;
    this.workSteals = 0;
    this.completions = 0;
    this.claimReleases = 0;

    this.instanceIdLower = this.instanceId.toLowerCase();
    const specializationSetup = this.prepareSpecializationProfile(
      config.cluster?.specialization,
      this.instanceIdLower
    );
    this.specializationProfile = specializationSetup?.profile || null;
    this.specializationDefaults = specializationSetup?.defaults || null;
    this.initializeSpecializationStats();
  }

  initializeSpecializationStats() {
    this.specializationStats = {
      totalClaims: 0,
      annotatedClaims: 0,
      preferredMatches: 0,
      preferredMismatches: 0,
      unannotatedClaims: 0,
      weightBoostClaims: 0,
      weightNeutralClaims: 0,
      weightPenaltyClaims: 0,
      totalWeight: 0,
      lastWeight: null,
      claimsByPreferredInstance: new Map()
    };
  }

  /**
   * Attempt to claim a goal atomically
   * 
   * @param {string} goalId - goal identifier
   * @param {number} priority - base priority (higher = more important)
   * @param {number} createdAt - goal creation timestamp
   * @returns {boolean} - true if claim succeeded
   */
  async claimGoal(goalId, priority = 1.0, createdAt = Date.now()) {
    this.claimAttempts++;

    try {
      // Calculate effective priority with aging
      const effectivePriority = this.calculateAgingPriority(priority, createdAt);

      this.logger.debug('[GoalAllocator] Attempting to claim goal', {
        goalId,
        instanceId: this.instanceId,
        priority,
        effectivePriority,
        age: Date.now() - createdAt
      });

      // Delegate to backend (Redis Lua or Filesystem assignments)
      const claimed = await this.stateStore.claimGoal(
        goalId,
        this.instanceId,
        this.claimTtlMs
      );

      if (claimed) {
        this.claimSuccesses++;
        this.logger.info('[GoalAllocator] Goal claimed', {
          goalId,
          instanceId: this.instanceId,
          ttl: this.claimTtlMs
        });
        return true;
      }

      this.claimFailures++;
      this.logger.debug('[GoalAllocator] Goal claim failed (already claimed)', {
        goalId,
        instanceId: this.instanceId
      });
      return false;
    } catch (error) {
      this.claimFailures++;
      this.logger.error('[GoalAllocator] Claim error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Mark goal as completed
   * 
   * @param {string} goalId - goal identifier
   * @returns {boolean} - true if successfully marked complete
   */
  async completeGoal(goalId) {
    try {
      const completed = await this.stateStore.completeGoal(goalId);
      
      if (completed) {
        this.completions++;
        this.logger.info('[GoalAllocator] Goal completed', {
          goalId,
          instanceId: this.instanceId
        });
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('[GoalAllocator] Complete error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  async releaseGoal(goalId) {
    try {
      const released = await this.stateStore.releaseGoal(goalId, this.instanceId);

      if (released) {
        this.claimReleases++;
        this.logger.info('[GoalAllocator] Goal claim released', {
          goalId,
          instanceId: this.instanceId
        });
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('[GoalAllocator] Release error', {
        goalId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Scan for goals with expiring claims (work-stealing)
   * Idle instances can reclaim goals that are about to expire.
   * 
   * @param {array} allGoals - list of all goals
   * @returns {array} - goals that can be stolen
   */
  findStealableGoals(allGoals) {
    const now = Date.now();
    const stealable = [];

    for (const goal of allGoals) {
      if (goal.completed) continue;
      if (!goal.claimed_by) continue; // Already unclaimed

      if (this.specializationProfile && goal.metadata) {
        const weight = this.getSpecializationWeight(goal);
        if (weight <= this.specializationProfile.nonPreferredPenalty * 1.1) {
          continue;
        }
      }

      const claimExpires = goal.claim_expires || 0;
      const timeUntilExpiry = claimExpires - now;

      // If claim expires within threshold, it's stealable
      if (timeUntilExpiry > 0 && timeUntilExpiry <= this.stealThresholdMs) {
        stealable.push({
          ...goal,
          timeUntilExpiry,
          canStealAt: claimExpires
        });
      }

      // If claim already expired, definitely stealable
      if (claimExpires <= now) {
        stealable.push({
          ...goal,
          timeUntilExpiry: 0,
          canStealAt: now
        });
      }
    }

    // Sort by expiry (steal most expired first)
    stealable.sort((a, b) => a.canStealAt - b.canStealAt);

    return stealable;
  }

  /**
   * Attempt work-stealing on expiring/expired claims
   * 
   * @param {array} stealableGoals - goals that can be stolen
   * @returns {object} - { stolen: count, failed: count }
   */
  async attemptWorkStealing(stealableGoals) {
    let stolen = 0;
    let failed = 0;

    for (const goal of stealableGoals) {
      const now = Date.now();

      if (this.specializationProfile && goal.metadata) {
        const weight = this.getSpecializationWeight(goal);
        if (weight <= this.specializationProfile.nonPreferredPenalty * 1.1) {
          continue;
        }
      }

      // Wait if not yet expired
      if (goal.canStealAt > now) {
        const waitMs = goal.canStealAt - now;
        if (waitMs > 1000) continue; // Don't wait more than 1s
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      // Attempt to claim
      const claimed = await this.claimGoal(
        goal.id,
        goal.priority || 1.0,
        goal.created_at || Date.now()
      );

      if (claimed) {
        stolen++;
        this.workSteals++;
        this.logger.info('[GoalAllocator] Work stolen', {
          goalId: goal.id,
          previousOwner: goal.claimed_by,
          newOwner: this.instanceId
        });
      } else {
        failed++;
      }
    }

    return { stolen, failed };
  }

  /**
   * Calculate aging priority (prevents starvation)
   * Older unclaimed goals get higher effective priority
   * 
   * @param {number} basePriority - base priority value
   * @param {number} createdAt - goal creation timestamp
   * @returns {number} - effective priority with aging bonus
   */
  calculateAgingPriority(basePriority, createdAt) {
    const now = Date.now();
    const age = now - createdAt;

    // Aging bonus: age / halfLife
    // After halfLife, priority doubles; after 2×halfLife, triples, etc.
    const agingBonus = age / this.agingHalfLifeMs;

    const effectivePriority = basePriority + agingBonus;

    return effectivePriority;
  }

  /**
   * Select next goal to work on (highest effective priority, unclaimed)
   * 
   * @param {array} availableGoals - list of unclaimed or stealable goals
   * @returns {object|null} - goal to work on, or null if none available
   */
  selectNextGoal(availableGoals) {
    if (!availableGoals || availableGoals.length === 0) {
      return null;
    }

    const now = Date.now();

    // Filter to unclaimed or expired claims
    const workable = availableGoals.filter(goal => {
      if (goal.completed) return false;
      if (!goal.claimed_by) return true; // Unclaimed
      if (goal.claim_expires && goal.claim_expires <= now) return true; // Expired
      return false;
    });

    if (workable.length === 0) {
      return null;
    }

    // Calculate effective priorities
    const withPriorities = workable.map(goal => {
      const basePriority = this.calculateAgingPriority(
        goal.priority || 1.0,
        goal.created_at || Date.now()
      );

      const specializationWeight = this.getSpecializationWeight(goal);

      return {
        ...goal,
        basePriority,
        specializationWeight,
        effectivePriority: basePriority * specializationWeight
      };
    });

    // Sort by effective priority (descending)
    withPriorities.sort((a, b) => b.effectivePriority - a.effectivePriority);

    return withPriorities[0];
  }

  /**
   * Get allocation stats
   */
  getStats() {
    const successRate = this.claimAttempts > 0 
      ? (this.claimSuccesses / this.claimAttempts * 100).toFixed(1)
      : '0.0';

    const specializationStats = this.specializationStats || {};
    const claimsByPreferredInstance = {};
    if (specializationStats.claimsByPreferredInstance instanceof Map) {
      for (const [key, value] of specializationStats.claimsByPreferredInstance.entries()) {
        claimsByPreferredInstance[key] = value;
      }
    }

    const averageWeight = specializationStats.totalClaims > 0
      ? specializationStats.totalWeight / specializationStats.totalClaims
      : 1;

    return {
      instanceId: this.instanceId,
      claimAttempts: this.claimAttempts,
      claimSuccesses: this.claimSuccesses,
      claimFailures: this.claimFailures,
      successRate: successRate + '%',
      workSteals: this.workSteals,
      completions: this.completions,
      releases: this.claimReleases,
      claimTtlMs: this.claimTtlMs,
      agingHalfLifeMs: this.agingHalfLifeMs,
      stealThresholdMs: this.stealThresholdMs,
      specialization: this.specializationProfile
        ? {
            name: this.specializationProfile.name,
            boost: this.specializationProfile.boost,
            penalty: this.specializationProfile.penalty,
            unmatchedPenalty: this.specializationProfile.unmatchedPenalty,
            minMultiplier: this.specializationProfile.minMultiplier,
            maxMultiplier: this.specializationProfile.maxMultiplier,
            nonPreferredPenalty: this.specializationProfile.nonPreferredPenalty,
            agentTypes: Array.from(this.specializationProfile.agentTypes),
            avoidAgentTypes: Array.from(this.specializationProfile.avoidAgentTypes),
            domains: Array.from(this.specializationProfile.domains),
            avoidDomains: Array.from(this.specializationProfile.avoidDomains),
            tags: Array.from(this.specializationProfile.tags),
            avoidTags: Array.from(this.specializationProfile.avoidTags),
            keywords: this.specializationProfile.keywords,
            avoidKeywords: this.specializationProfile.avoidKeywords
          }
        : null,
      specializationStats: {
        totalClaims: specializationStats.totalClaims || 0,
        annotatedClaims: specializationStats.annotatedClaims || 0,
        preferredMatches: specializationStats.preferredMatches || 0,
        preferredMismatches: specializationStats.preferredMismatches || 0,
        unannotatedClaims: specializationStats.unannotatedClaims || 0,
        weightBoostClaims: specializationStats.weightBoostClaims || 0,
        weightNeutralClaims: specializationStats.weightNeutralClaims || 0,
        weightPenaltyClaims: specializationStats.weightPenaltyClaims || 0,
        avgWeight: Number.isFinite(averageWeight) ? averageWeight : 1,
        lastWeight: specializationStats.lastWeight,
        totalWeight: specializationStats.totalWeight || 0,
        claimsByPreferredInstance
      }
    };
  }

  /**
   * Reset stats (for testing)
   */
  resetStats() {
    this.claimAttempts = 0;
    this.claimSuccesses = 0;
    this.claimFailures = 0;
    this.workSteals = 0;
    this.completions = 0;
    this.claimReleases = 0;
    this.initializeSpecializationStats();
  }

  recordClaim(goal) {
    if (!goal) {
      return 1;
    }

    let weight = 1;
    try {
      weight = this.getSpecializationWeight(goal);
    } catch (error) {
      this.logger?.debug('[GoalAllocator] Specialization weight capture failed', {
        goalId: goal?.id,
        error: error.message
      });
      weight = 1;
    }

    if (!Number.isFinite(weight) || weight <= 0) {
      weight = 1;
    }

    const stats = this.specializationStats;
    stats.totalClaims += 1;
    stats.totalWeight += weight;
    stats.lastWeight = weight;

    const metadata = goal.metadata || {};
    const preferredList = this.normalizeToLowerArray(
      metadata.preferredInstance || metadata.preferredInstances
    );

    if (preferredList.length > 0) {
      stats.annotatedClaims += 1;
      const normalizedPreferred = preferredList[0];
      const preferredMap = stats.claimsByPreferredInstance;
      preferredList.forEach(pref => {
        preferredMap.set(pref, (preferredMap.get(pref) || 0) + 1);
      });

      if (preferredList.includes(this.instanceIdLower)) {
        stats.preferredMatches += 1;
      } else {
        stats.preferredMismatches += 1;
      }
    } else {
      stats.unannotatedClaims += 1;
    }

    if (weight > 1.05) {
      stats.weightBoostClaims += 1;
    } else if (weight < 0.95) {
      stats.weightPenaltyClaims += 1;
    } else {
      stats.weightNeutralClaims += 1;
    }

    return weight;
  }

  getSpecializationWeight(goal) {
    if (!this.specializationProfile) {
      return 1;
    }

    if (!goal || typeof goal !== 'object') {
      return 1;
    }

    const metadata = goal.metadata || {};

    const preferredList = this.normalizeToLowerArray(
      metadata.preferredInstance || metadata.preferredInstances
    );

    if (preferredList.length > 0 && !preferredList.includes(this.instanceIdLower)) {
      return this.specializationProfile.nonPreferredPenalty;
    }

    const excludedList = this.normalizeToLowerArray(
      metadata.excludedInstances || metadata.restrictedInstances
    );

    if (excludedList.length > 0 && excludedList.includes(this.instanceIdLower)) {
      return this.specializationProfile.nonPreferredPenalty;
    }

    let modifier = this.specializationProfile.baseline;
    let matched = false;

    const applyBoost = () => {
      modifier *= this.specializationProfile.boost;
      matched = true;
    };

    const applyPenalty = () => {
      modifier *= this.specializationProfile.penalty;
    };

    const agentHint = (metadata.agentTypeHint || metadata.agentType || metadata.preferredRole || '')
      .toString()
      .toLowerCase();

    if (agentHint) {
      if (this.specializationProfile.agentTypes.has(agentHint)) {
        applyBoost();
      } else if (this.specializationProfile.avoidAgentTypes.has(agentHint)) {
        applyPenalty();
      }
    }

    const domain = (metadata.guidedDomain || metadata.domain || '')
      .toString()
      .toLowerCase();

    if (domain) {
      if (this.specializationProfile.domains.has(domain)) {
        applyBoost();
      } else if (this.specializationProfile.avoidDomains.has(domain)) {
        applyPenalty();
      }
    }

    const tags = this.extractGoalTags(metadata, goal);
    if (tags.some(tag => this.specializationProfile.tags.has(tag))) {
      applyBoost();
    }

    if (tags.some(tag => this.specializationProfile.avoidTags.has(tag))) {
      applyPenalty();
    }

    const description = (goal.description || '')
      .toString()
      .toLowerCase();

    if (description && this.specializationProfile.keywords.length > 0) {
      if (this.specializationProfile.keywords.some(keyword => description.includes(keyword))) {
        applyBoost();
      }
    }

    if (description && this.specializationProfile.avoidKeywords.length > 0) {
      if (this.specializationProfile.avoidKeywords.some(keyword => description.includes(keyword))) {
        applyPenalty();
      }
    }

    if (!matched && this.specializationProfile.unmatchedPenalty !== 1) {
      modifier *= this.specializationProfile.unmatchedPenalty;
    }

    modifier = Math.max(this.specializationProfile.minMultiplier, modifier);
    modifier = Math.min(this.specializationProfile.maxMultiplier, modifier);

    return modifier;
  }

  prepareSpecializationProfile(specializationConfig, instanceIdLower) {
    if (!specializationConfig || specializationConfig.enabled === false) {
      return null;
    }

    const defaults = {
      baseline: specializationConfig.defaults?.baseline || 1,
      boost: specializationConfig.defaults?.boost || 1.5,
      penalty: specializationConfig.defaults?.penalty || 0.6,
      unmatchedPenalty: specializationConfig.defaults?.unmatchedPenalty || 1,
      minMultiplier: specializationConfig.defaults?.minMultiplier || 0.3,
      maxMultiplier: specializationConfig.defaults?.maxMultiplier || 3,
      nonPreferredPenalty: specializationConfig.defaults?.nonPreferredPenalty || 0.1
    };

    const profiles = specializationConfig.profiles || {};
    const profileConfig = profiles[instanceIdLower] || profiles.default;

    if (!profileConfig) {
      return { defaults };
    }

    const normalize = (values) => this.normalizeToLowerArray(values);

    const profile = {
      name: profileConfig.name || instanceIdLower,
      baseline: profileConfig.baseline || defaults.baseline,
      boost: profileConfig.boost || defaults.boost,
      penalty: profileConfig.penalty || defaults.penalty,
      unmatchedPenalty: profileConfig.unmatchedPenalty ?? defaults.unmatchedPenalty,
      minMultiplier: profileConfig.minMultiplier || defaults.minMultiplier,
      maxMultiplier: profileConfig.maxMultiplier || defaults.maxMultiplier,
      nonPreferredPenalty: profileConfig.nonPreferredPenalty || defaults.nonPreferredPenalty,
      agentTypes: new Set(normalize(profileConfig.agentTypes)),
      avoidAgentTypes: new Set(normalize(profileConfig.avoidAgentTypes)),
      domains: new Set(normalize(profileConfig.domains)),
      avoidDomains: new Set(normalize(profileConfig.avoidDomains)),
      keywords: normalize(profileConfig.keywords || []),
      avoidKeywords: normalize(profileConfig.avoidKeywords || []),
      tags: new Set(normalize(profileConfig.tags)),
      avoidTags: new Set(normalize(profileConfig.avoidTags))
    };

    return {
      profile,
      defaults
    };
  }

  normalizeToLowerArray(values) {
    if (!values) {
      return [];
    }

    const list = Array.isArray(values) ? values : [values];
    return list
      .map(value => (typeof value === 'string' ? value.trim().toLowerCase() : null))
      .filter(Boolean);
  }

  extractGoalTags(metadata, goal) {
    const tags = new Set();

    if (Array.isArray(metadata?.specializationTags)) {
      metadata.specializationTags.forEach(tag => {
        if (typeof tag === 'string' && tag.trim()) {
          tags.add(tag.trim().toLowerCase());
        }
      });
    }

    if (Array.isArray(metadata?.tags)) {
      metadata.tags.forEach(tag => {
        if (typeof tag === 'string' && tag.trim()) {
          tags.add(tag.trim().toLowerCase());
        }
      });
    }

    if (Array.isArray(goal?.tags)) {
      goal.tags.forEach(tag => {
        if (typeof tag === 'string' && tag.trim()) {
          tags.add(tag.trim().toLowerCase());
        }
      });
    }

    return Array.from(tags);
  }
}

module.exports = { GoalAllocator };
