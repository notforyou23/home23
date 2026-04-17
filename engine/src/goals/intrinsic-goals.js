const { UnifiedClient } = require('../core/unified-client');
const { cosmoEvents } = require('../realtime/event-emitter');
const { validateDoneWhen } = require('./done-when-gate');
const { checkDoneWhen } = require('./done-when');

/**
 * Helper function to safely convert any date representation to epoch milliseconds
 * Handles Date objects, epoch numbers, ISO strings, and provides safe fallback
 * @param {Date|number|string} t - Date representation
 * @returns {number} Epoch milliseconds
 */
function toEpochMs(t) {
  // Already a number (epoch ms)
  if (typeof t === 'number') return t;
  
  // String (ISO date or similar)
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : Date.now();
  }
  
  // Date object
  if (t && typeof t.getTime === 'function') {
    return t.getTime();
  }
  
  // Fallback to current time
  return Date.now();
}

/**
 * Intrinsic Goal System
 * Self-discovered objectives based on curiosity and uncertainty
 * From: "Goal Discovery via Intrinsic Motivation" section
 */
class IntrinsicGoalSystem {
  constructor(config, logger) {
    this.config = config.goals;
    this.roleSystem = config.roleSystem; // Store roleSystem config for guided mode awareness
    this.logger = logger;
    this.clusterSpecialization = this.initializeSpecialization(config.cluster);

    // LLM client (supports both OpenAI and local LLMs)
    this.gpt5 = new UnifiedClient(config, logger);

    this.goals = new Map();
    this.nextGoalId = 1;
    this.completedGoals = [];
    this.archivedGoals = [];
    this.goalAllocator = null;
    this.goalAllocationInstance = null;
    
    // Curator callback (set by orchestrator)
    this.curatorCallback = null;
  }

  cloneMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') {
      return {};
    }

    if (metadata instanceof Date) {
      return new Date(metadata.getTime());
    }

    if (Array.isArray(metadata)) {
      return metadata.map(item => this.cloneMetadata(item));
    }

    const clone = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value instanceof Date) {
        clone[key] = new Date(value.getTime());
      } else if (value && typeof value === 'object') {
        clone[key] = this.cloneMetadata(value);
      } else {
        clone[key] = value;
      }
    }
    return clone;
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

  isDreamSeedGoal(goal) {
    return goal?.source === 'dream_gpt5' || goal?.source === 'dream';
  }

  initializeSpecialization(clusterConfig) {
    if (!clusterConfig || clusterConfig.enabled === false) {
      return null;
    }

    const specialization = clusterConfig.specialization;
    if (!specialization || specialization.enabled === false) {
      return null;
    }

    const defaults = {
      boost: specialization.defaults?.boost || 2,
      penalty: specialization.defaults?.penalty || 0.5,
      unmatchedPenalty: specialization.defaults?.unmatchedPenalty || 1,
      minMultiplier: specialization.defaults?.minMultiplier || 0.3,
      maxMultiplier: specialization.defaults?.maxMultiplier || 3,
      nonPreferredPenalty: specialization.defaults?.nonPreferredPenalty || 0.1
    };

    const profiles = specialization.profiles || {};
    const normalizedProfiles = {};

    Object.entries(profiles).forEach(([name, profile]) => {
      if (!profile || typeof profile !== 'object') return;

      normalizedProfiles[name.toLowerCase()] = {
        name,
        agentTypes: this.normalizeToLowerArray(profile.agentTypes),
        avoidAgentTypes: this.normalizeToLowerArray(profile.avoidAgentTypes),
        domains: this.normalizeToLowerArray(profile.domains),
        avoidDomains: this.normalizeToLowerArray(profile.avoidDomains),
        tags: this.normalizeToLowerArray(profile.tags),
        avoidTags: this.normalizeToLowerArray(profile.avoidTags),
        keywords: this.normalizeToLowerArray(profile.keywords),
        avoidKeywords: this.normalizeToLowerArray(profile.avoidKeywords),
        boosts: {
          agentTypes: profile.boosts?.agentTypes || defaults.boost,
          domains: profile.boosts?.domains || defaults.boost,
          keywords: profile.boosts?.keywords || defaults.boost
        },
        penalties: {
          agentTypes: profile.penalties?.agentTypes || defaults.penalty,
          domains: profile.penalties?.domains || defaults.penalty,
          keywords: profile.penalties?.keywords || defaults.penalty
        }
      };
    });

    if (Object.keys(normalizedProfiles).length === 0) {
      return null;
    }

    return {
      defaults,
      profiles: normalizedProfiles
    };
  }
  
  /**
   * Set curator callback for goal events
   */
  setCuratorCallback(callback) {
    this.curatorCallback = callback;
  }

  setGoalAllocator(goalAllocator) {
    this.goalAllocator = goalAllocator || null;
    this.goalAllocationInstance = goalAllocator?.instanceId || null;
  }

  /**
   * Discover goals from journal/memory analysis
   */
  async discoverGoals(journal, memory) {
    if (!this.config.intrinsicEnabled) return [];

    const method = this.config.discoveryMethod || 'reflection';
    
    switch (method) {
      case 'reflection':
        return await this.discoverViaReflection(journal);
      
      case 'surprise':
        return await this.discoverViaSurprise(journal, memory);
      
      case 'hybrid':
        const reflectionGoals = await this.discoverViaReflection(journal);
        const surpriseGoals = await this.discoverViaSurprise(journal, memory);
        return [...reflectionGoals, ...surpriseGoals];
      
      default:
        return [];
    }
  }

  /**
   * Discover goals through reflection on past thoughts
   */
  async discoverViaReflection(journal) {
    if (!journal || journal.length === 0) return [];

    const recentThoughts = journal.slice(-20).map(entry => entry.thought || entry.output).join('\n\n');

    // Check if we're in guided mode and add domain context
    const isGuided = this.roleSystem?.explorationMode === 'guided';
    const guidedDomain = this.roleSystem?.guidedFocus?.domain || '';
    const guidedContext = this.roleSystem?.guidedFocus?.context || '';

    const domainGuidance = isGuided
      ? `\n\nIMPORTANT CONTEXT: These thoughts are focused on "${guidedDomain}". ${guidedContext ? guidedContext + ' ' : ''}Generate goals that are relevant to this domain while still allowing for creative exploration and novel connections within it.`
      : '';

    const prompt = `
Analyze these recent thoughts and identify 2-3 intrinsic goals or questions that emerge as worth pursuing:

${recentThoughts}${domainGuidance}

For each goal, provide:
1. A clear description (one sentence)
2. Why it's interesting or important
3. Estimated uncertainty (0-1, where 1 is highly uncertain)

Format as JSON array: [{"description": "...", "reason": "...", "uncertainty": 0.8}]
    `.trim();

    try {
      const response = await this.gpt5.generateFast({
        component: 'intrinsicGoals',
        purpose: 'discovery',
        instructions: 'You are an expert at identifying interesting questions and goals from thought patterns.',
        input: prompt,
        maxTokens: 1500
      });

      const content = this.gpt5.extractTextFromResponse(response);
      const goals = this.parseGoalsResponse(content);

      this.logger?.info('Goals discovered via reflection', { count: goals.length });

      return goals;
    } catch (error) {
      this.logger?.error('Goal discovery failed', { error: error.message });
      return [];
    }
  }

  /**
   * Discover goals from surprising observations
   */
  async discoverViaSurprise(journal, memory) {
    // Look for high-surprise events in recent history
    const surprisingEvents = journal
      .slice(-50)
      .filter(entry => entry.surprise && entry.surprise > 0.5)
      .slice(-5);

    if (surprisingEvents.length === 0) return [];

    // Check if we're in guided mode to contextualize surprise-based goals
    const isGuided = this.roleSystem?.explorationMode === 'guided';
    const guidedDomain = this.roleSystem?.guidedFocus?.domain || '';

    const goals = surprisingEvents.map(event => ({
      description: isGuided 
        ? `Investigate surprising aspect of ${guidedDomain}: ${event.thought || event.output}`.substring(0, 200)
        : `Investigate why: ${event.thought || event.output}`.substring(0, 200),
      reason: 'High surprise detected - warrants investigation',
      uncertainty: event.surprise,
      source: 'surprise'
    }));

    this.logger?.info('Goals discovered via surprise', { count: goals.length });

    return goals;
  }

  /**
   * Parse goals from LLM response
   */
  parseGoalsResponse(content) {
    try {
      // Try to extract JSON
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.map(g => ({
          ...g,
          source: 'reflection'
        }));
      }
    } catch (error) {
      this.logger?.warn('Failed to parse goals JSON', { error: error.message });
    }

    return [];
  }

  /**
   * Validate goal data before adding
   */
  validateGoalData(goalData) {
    if (!goalData || typeof goalData !== 'object') {
      return false;
    }
    
    if (!goalData.description || typeof goalData.description !== 'string') {
      return false;
    }
    
    if (goalData.description.length < 10) {
      return false;
    }
    
    if (goalData.description.includes('Error:') || 
        goalData.description.includes('undefined')) {
      return false;
    }
    
    return true;
  }

  /**
   * Add a goal to the system
   */
  addGoal(goalData) {
    // Validate before adding
    if (!this.validateGoalData(goalData)) {
      this.logger?.warn('⚠️  Skipped invalid goal', {
        hasDescription: Boolean(goalData?.description),
        length: goalData?.description?.length || 0,
        type: typeof goalData?.description
      });
      return null;
    }

    // doneWhen gate: every goal must declare a concrete termination criterion.
    const dwCfg = this.config?.doneWhen || {};
    const dwResult = validateDoneWhen(goalData?.doneWhen, dwCfg);
    if (!dwResult.valid) {
      this.logger?.warn('⚠️  Rejected goal without valid doneWhen', {
        reason: dwResult.reason,
        description: (goalData?.description || '').slice(0, 80)
      });
      this._rejectedAtGateCount24h = (this._rejectedAtGateCount24h || 0) + 1;
      return null;
    }

    if (this.goals.size >= this.config.maxGoals) {
      // Prune lowest priority goal
      this.pruneLowPriorityGoal();
    }

    const goal = {
      id: `goal_${this.nextGoalId++}`,
      description: goalData.description,
      reason: goalData.reason || 'Self-discovered',
      uncertainty: goalData.uncertainty || 0.5,
      source: typeof goalData.source === 'object'
        ? { origin: goalData.source.origin || 'unknown', ...goalData.source }
        : { origin: 'unknown', label: goalData.source || 'manual' },
      priority: this.calculatePriority(goalData.uncertainty || 0.5),
      progress: 0,
      status: 'active',  // NEW: 'active', 'completed', 'archived'
      created: Date.now(), // Store as epoch ms to avoid serialization issues
      lastPursued: null,
      pursuitCount: 0,
      claimedBy: null,
      claimed_by: null,
      claimExpires: null,
      claim_expires: null,
      claimCount: 0,
      claim_count: 0,
      lastClaimedAt: null,
      doneWhen: goalData.doneWhen,

      // Context isolation: execution context for independent goal processing
      executionContext: goalData.executionContext || this.inferExecutionContext(goalData)
    };

    goal.createdAt = new Date(goal.created);
    goal.created_at = goal.created;
    goal.metadata = this.cloneMetadata(goalData.metadata || {});

    this.goals.set(goal.id, goal);

    this.logger?.info('Goal added', {
      id: goal.id,
      description: goal.description.substring(0, 50),
      priority: goal.priority.toFixed(3)
    });

    // Emit real-time goal created event
    cosmoEvents.emitGoalCreated({
      goalId: goal.id,
      description: goal.description,
      source: goal.source,
      priority: goal.priority
    });

    return goal;
  }

  /**
   * Upsert an externally provided goal ID (used when missions are spawned
   * with a predefined goalId so pursuit metrics stay accurate).
   * - If the goal already exists, return it.
   * - If missing, create a minimal active goal with the supplied ID.
   */
  upsertExternalGoal(goalId, description, metadata = {}) {
    if (!goalId) return null;

    const existing = this.goals.get(goalId);
    if (existing) {
      return existing;
    }

    const desc =
      (description && description.trim().length >= 10)
        ? description.trim().substring(0, 500)
        : `Auto-created goal ${goalId}`;

    const unc = metadata.uncertainty ?? 0.5;
    const goal = {
      id: goalId,
      description: desc,
      reason: metadata.reason || 'auto_inferred_from_spawn',
      uncertainty: unc,
      source: metadata.source || 'external',
      priority: this.calculatePriority(unc),
      progress: 0,
      status: 'active',
      created: Date.now(),
      lastPursued: null,
      pursuitCount: 0,
      claimedBy: null,
      claimed_by: null,
      claimExpires: null,
      claim_expires: null,
      claimCount: 0,
      claim_count: 0,
      lastClaimedAt: null,
      executionContext: metadata.executionContext || this.inferExecutionContext(metadata)
    };

    goal.createdAt = new Date(goal.created);
    goal.created_at = goal.created;
    goal.metadata = this.cloneMetadata(metadata.metadata || {});

    this.goals.set(goalId, goal);

    this.logger?.info('Goal upserted for external mission', {
      goalId,
      description: goal.description.substring(0, 60)
    });

    return goal;
  }

  /**
   * Infer execution context from goal metadata
   * Determines whether goal should use isolated or guided cognitive context
   * 
   * @param {Object} goalData - Goal data being added
   * @returns {string} - 'independent', 'guided', or 'autonomous'
   */
  inferExecutionContext(goalData) {
    // MCP-injected goals are independent by default
    if (goalData.source === 'mcp' || goalData.source === 'mcp_action_queue') {
      this.logger?.debug('Goal execution context: independent (MCP source)', {
        source: goalData.source,
        description: goalData.description?.substring(0, 60)
      });
      return 'independent';
    }
    
    // Guided plan task goals
    if (goalData.metadata?.isTaskGoal || goalData.metadata?.guidedDomain) {
      this.logger?.debug('Goal execution context: guided (task goal)', {
        isTaskGoal: goalData.metadata?.isTaskGoal,
        guidedDomain: goalData.metadata?.guidedDomain
      });
      return 'guided';
    }
    
    // Meta-coordinator strategic goals inherit guided context if present
    if (goalData.source === 'meta_coordinator_strategic' && 
        this.roleSystem?.explorationMode === 'guided') {
      this.logger?.debug('Goal execution context: guided (strategic goal in guided mode)');
      return 'guided';
    }
    
    // Recursive planner goals can be independent or guided based on flag
    if (goalData.source === 'recursive_planner' && goalData.metadata?.fromRecursivePlanning) {
      // Default to autonomous unless explicitly marked
      return goalData.metadata?.inheritGuidedContext ? 'guided' : 'autonomous';
    }
    
    // Everything else uses autonomous context (normal discovery)
    this.logger?.debug('Goal execution context: autonomous', {
      source: goalData.source
    });
    return 'autonomous';
  }

  /**
   * Calculate goal priority
   */
  calculatePriority(uncertainty) {
    const method = this.config.prioritization || 'uncertainty';

    switch (method) {
      case 'uncertainty':
        // Higher uncertainty = higher priority (curiosity-driven)
        return uncertainty;
      
      case 'progress':
        // Goals with some progress get priority
        return 0.5; // Will be adjusted as progress is made
      
      case 'hybrid':
        // Mix of uncertainty and other factors
        return uncertainty * 0.7 + 0.3;
      
      default:
        return 0.5;
    }
  }

  /**
   * Select next goal to pursue
   */
  async selectGoalToPursue(context = {}, options = {}) {
    if (this.goals.size === 0) return null;

    const { allowWorkStealing = true } = options;
    const prioritized = this.getPrioritizedGoals(context);

    for (const entry of prioritized) {
      const goal = entry.goal;
      this.refreshClaimState(goal);

      if (!this.goalAllocator) {
        return goal;
      }

      const claimed = await this.goalAllocator.claimGoal(
        this.formatGoalClaimKey(goal.id),
        entry.adjustedPriority,
        goal.created || goal.created_at || Date.now()
      );

      if (claimed) {
        this.applyClaimMetadata(goal);
        return goal;
      }
    }

    if (this.goalAllocator && allowWorkStealing) {
      const allocationRecords = prioritized.map(entry =>
        this.toAllocationRecord(entry.goal, entry.adjustedPriority)
      );

      const stealable = this.goalAllocator.findStealableGoals(allocationRecords);
      if (stealable.length > 0) {
        await this.goalAllocator.attemptWorkStealing(stealable);
        return this.selectGoalToPursue(context, { allowWorkStealing: false });
      }
    }

    return null;
  }

  /**
   * Adjust priority based on current context
   * NEW: Task goals from guided mode get massive priority boost
   * NEW: Strategic goals from Meta-Coordinator get top priority
   */
  adjustPriority(goal, context) {
    let priority = goal.priority;
    const isTaskGoal = Boolean(goal.metadata?.isTaskGoal);
    const executionMode = goal.metadata?.executionMode || 'mixed';
    
    // Strategic goals from Meta-Coordinator
    const isStrategicGoal = goal.source === 'meta_coordinator_strategic' || 
                           goal.metadata?.gapDriven === true ||
                           goal.metadata?.strategicPriority === true;
    
    // MODE-AWARE PRIORITY: Guided vs Autonomous
    // In guided mode: Plan tasks are PRIMARY, strategic goals are secondary
    // In autonomous mode: Strategic goals are PRIMARY (critical fixes)
    const isGuidedMode = this.roleSystem?.explorationMode === 'guided';
    
    if (isTaskGoal) {
      // TASK GOALS: Always highest in guided mode
      if (executionMode === 'strict') {
        priority *= 15.0; // Maximum focus
      } else if (executionMode === 'mixed') {
        priority *= 10.0; // High priority (was 3.0 - too low!)
      } else {
        priority *= 5.0; // Advisory mode
      }

      this.logger?.debug('Task goal priority boosted', {
        goalId: goal.id,
        phase: `${goal.metadata.phaseNumber}/${goal.metadata.totalPhases}`,
        mode: executionMode,
        basePriority: goal.priority,
        adjustedPriority: priority
      });
    } else if (isStrategicGoal) {
      // STRATEGIC GOALS: Mode-aware priority
      if (isGuidedMode) {
        // GUIDED MODE: Strategic goals are LOWER than task goals
        // Code fixes/tests are noise when trying to complete a research task
        priority *= 0.5; // REDUCED (was 15x!)
        
        this.logger?.debug('Strategic goal deprioritized in guided mode', {
          goalId: goal.id,
          source: goal.source,
          basePriority: goal.priority,
          adjustedPriority: priority,
          reason: 'Plan tasks take precedence'
        });
      } else {
        // AUTONOMOUS MODE: Strategic goals are critical system improvements
        priority *= 15.0;
        
        this.logger?.debug('Strategic goal priority boosted in autonomous mode', {
          goalId: goal.id,
          source: goal.source,
          urgency: goal.metadata?.urgency,
          basePriority: goal.priority,
          adjustedPriority: priority
        });
      }
    }

    if (context.cognitiveState?.curiosity > 0.7) {
      priority *= 1.2;
    }

    if (goal.lastPursued) {
      const lastPursuedTime = toEpochMs(goal.lastPursued);
      const timeSince = Date.now() - lastPursuedTime;
      if (timeSince < 600000) {
        priority *= 0.5;
      }
    }

    if (goal.progress > 0 && goal.progress < 0.8) {
      priority *= 1.3;
    }

    if (isTaskGoal && goal.metadata?.sequentialDependencies?.length > 0) {
      const dependenciesSatisfied = this.checkSequentialDependencies(goal, context);
      if (!dependenciesSatisfied) {
        this.logger?.debug('Goal dependencies not satisfied, reducing priority', {
          goalId: goal.id,
          dependencies: goal.metadata.sequentialDependencies
        });
        priority *= 0.1;
      }
    }

    const isGuided = this.roleSystem?.explorationMode === 'guided';
    const executionContext = goal.executionContext || 'autonomous';
    
    // Context isolation: Only apply guided domain bias for goals with 'guided' context
    // Independent goals get NO domain alignment bias (clean slate)
    if (isGuided && executionContext === 'guided') {
      const guidedDomain = this.roleSystem?.guidedFocus?.domain || '';
      if (guidedDomain) {
        const domainTerms = guidedDomain.toLowerCase().split(/\s+/).filter(t => t.length > 3);
        const goalText = (goal.description || '').toLowerCase();
        const matchCount = domainTerms.filter(term => goalText.includes(term)).length;
        if (matchCount > 0) {
          const alignmentBoost = Math.min(1.3, 1.0 + (matchCount * 0.1));
          priority *= alignmentBoost;
          
          this.logger?.debug('Applied guided domain alignment boost', {
            goalId: goal.id,
            matchCount,
            boost: alignmentBoost
          });
        }
      }
    } else if (executionContext === 'independent') {
      this.logger?.debug('Skipped domain bias for independent goal', {
        goalId: goal.id
      });
    }

    if (this.goalAllocator) {
      try {
        const specializationWeight = this.goalAllocator.getSpecializationWeight(goal);
        if (Number.isFinite(specializationWeight) && specializationWeight > 0) {
          priority *= specializationWeight;
          const metadata = goal.metadata ? this.cloneMetadata(goal.metadata) : {};
          metadata.lastSpecializationWeight = specializationWeight;
          goal.metadata = metadata;
        }
      } catch (error) {
        this.logger?.debug('Specialization weight calculation failed', {
          goalId: goal.id,
          error: error.message
        });
      }
    }

    return priority;
  }

  getPrioritizedGoals(context = {}) {
    const goals = Array.from(this.goals.values())
      .filter(g => g.status === 'active' || !g.status);
    const groundedGoals = goals.filter(goal => !this.isDreamSeedGoal(goal));
    const selectableGoals = groundedGoals.length > 0 ? groundedGoals : goals;

    return selectableGoals
      .map(goal => {
        const adjustedPriority = this.adjustPriority(goal, context);
        return { goal, adjustedPriority };
      })
      .sort((a, b) => b.adjustedPriority - a.adjustedPriority);
  }

  refreshClaimState(goal) {
    if (!goal || !goal.claim_expires) {
      return;
    }

    if (goal.claim_expires <= Date.now()) {
      this.clearClaimMetadata(goal);
    }
  }

  formatGoalClaimKey(goalId) {
    return String(goalId);
  }

  applyClaimMetadata(goal, options = {}) {
    if (!goal || !this.goalAllocator) {
      return;
    }

    const refresh = options.refresh === true;
    const now = Date.now();
    const ttl = this.goalAllocator.claimTtlMs || 0;

    goal.claimedBy = this.goalAllocator.instanceId;
    goal.claimed_by = this.goalAllocator.instanceId;
    goal.lastClaimedAt = now;

    if (!refresh) {
      goal.claimCount = (goal.claimCount || 0) + 1;
    }
    goal.claim_count = goal.claimCount || 0;

    if (ttl > 0) {
      goal.claimExpires = now + ttl;
      goal.claim_expires = goal.claimExpires;
    }

    if (!refresh && typeof this.goalAllocator?.recordClaim === 'function') {
      try {
        this.goalAllocator.recordClaim(goal);
      } catch (error) {
        this.logger?.warn('Goal claim telemetry update failed', {
          goalId: goal.id,
          error: error.message
        });
      }
    }
  }

  clearClaimMetadata(goal) {
    if (!goal) return;
    goal.claimedBy = null;
    goal.claimed_by = null;
    goal.claimExpires = null;
    goal.claim_expires = null;
  }

  releaseGoalClaim(goal, { force = false } = {}) {
    if (!goal) return;

    if (this.goalAllocator && goal.claimed_by) {
      const sameOwner = goal.claimed_by === this.goalAllocationInstance;
      if (sameOwner || force) {
        this.goalAllocator.releaseGoal(this.formatGoalClaimKey(goal.id)).catch(error => {
          this.logger?.warn('Goal claim release failed', {
            goalId: goal.id,
            error: error.message
          });
        });
      }
    }

    this.clearClaimMetadata(goal);
  }

  toAllocationRecord(goal, adjustedPriority) {
    return {
      id: this.formatGoalClaimKey(goal.id),
      goal_id: goal.id,
      priority: adjustedPriority ?? goal.priority,
      created_at: goal.created || goal.created_at || Date.now(),
      claimed_by: goal.claimed_by,
      claim_expires: goal.claim_expires,
      completed: goal.status === 'completed',
      metadata: goal.metadata ? this.cloneMetadata(goal.metadata) : null
    };
  }

  applySpecializationGuidance(goalRefs = []) {
    if (!this.clusterSpecialization) {
      return;
    }

    if (!Array.isArray(goalRefs) || goalRefs.length === 0) {
      return;
    }

    const profiles = this.clusterSpecialization.profiles;
    const defaults = this.clusterSpecialization.defaults;
    const processed = new Set();

    const resolveGoal = (ref) => {
      if (!ref) return null;
      if (typeof ref === 'string') {
        return this.goals.get(ref) || null;
      }
      if (ref && typeof ref === 'object') {
        if (ref.id && this.goals.has(ref.id)) {
          return this.goals.get(ref.id);
        }
        if (ref.goal_id && this.goals.has(ref.goal_id)) {
          return this.goals.get(ref.goal_id);
        }
      }
      return null;
    };

    for (const ref of goalRefs) {
      const goal = resolveGoal(ref);
      if (!goal || processed.has(goal.id)) {
        continue;
      }
      processed.add(goal.id);

      const recommendation = this.scoreSpecialization(goal, profiles, defaults);
      if (!recommendation) {
        continue;
      }

      goal.metadata = goal.metadata ? this.cloneMetadata(goal.metadata) : {};
      const previous = goal.metadata.preferredInstance || null;

      goal.metadata.preferredInstance = recommendation.profileName;
      goal.metadata.specializationHints = recommendation.reasons.slice(0, 3);
      goal.metadata.specializationScore = recommendation.score;

      if (!goal.metadata.specializationTags) {
        goal.metadata.specializationTags = recommendation.matchedTags;
      } else {
        const existing = new Set(goal.metadata.specializationTags.map(t => t.toLowerCase()));
        recommendation.matchedTags.forEach(tag => {
          if (!existing.has(tag)) {
            goal.metadata.specializationTags.push(tag);
          }
        });
      }

      if (previous !== recommendation.profileName) {
        this.logger?.info('📡 Goal specialization guidance updated', {
          goalId: goal.id,
          preferredInstance: recommendation.profileName,
          reasons: recommendation.reasons.slice(0, 3)
        });
      }
    }
  }

  scoreSpecialization(goal, profiles, defaults) {
    if (!goal || !profiles || Object.keys(profiles).length === 0) {
      return null;
    }

    const description = (goal.description || '').toLowerCase();
    const metadata = goal.metadata || {};
    const agentHint = (metadata.agentTypeHint || metadata.agentType || '').toString().toLowerCase();
    const specializationTags = this.normalizeToLowerArray(metadata.specializationTags);
    const guidedDomain = (metadata.guidedDomain || metadata.domain || '').toString().toLowerCase();

    let bestProfile = null;
    let bestScore = 0;
    let bestReasons = [];
    let bestTags = [];

    Object.entries(profiles).forEach(([profileKey, profile]) => {
      let score = defaults.unmatchedPenalty ? Math.log10(defaults.unmatchedPenalty + 1) : 0;
      const reasons = [];
      const matchedTags = new Set();

      if (profile.agentTypes.size > 0 && agentHint) {
        if (profile.agentTypes.has(agentHint)) {
          score += profile.boosts.agentTypes || defaults.boost;
          reasons.push(`agent:${agentHint}`);
        } else if (profile.avoidAgentTypes.has(agentHint)) {
          score *= profile.penalties.agentTypes || defaults.penalty;
          reasons.push(`avoid-agent:${agentHint}`);
        }
      }

      if (profile.domains.size > 0 && guidedDomain) {
        if (profile.domains.has(guidedDomain)) {
          score += profile.boosts.domains || defaults.boost;
          reasons.push(`domain:${guidedDomain}`);
        } else if (profile.avoidDomains.has(guidedDomain)) {
          score *= profile.penalties.domains || defaults.penalty;
          reasons.push(`avoid-domain:${guidedDomain}`);
        }
      }

      if (profile.tags.size > 0 && specializationTags.length > 0) {
        const tagMatches = specializationTags.filter(tag => profile.tags.has(tag));
        if (tagMatches.length > 0) {
          score += tagMatches.length * (profile.boosts.agentTypes || defaults.boost);
          tagMatches.forEach(tag => matchedTags.add(tag));
          reasons.push(`tags:${tagMatches.join(',')}`);
        }
      }

      if (description && profile.keywords.length > 0) {
        const matches = profile.keywords.filter(keyword => description.includes(keyword));
        if (matches.length > 0) {
          score += matches.length * (profile.boosts.keywords || defaults.boost);
          matches.forEach(match => matchedTags.add(match));
          reasons.push(`keywords:${matches.join(',')}`);
        }
      }

      if (description && profile.avoidKeywords.length > 0) {
        if (profile.avoidKeywords.some(keyword => description.includes(keyword))) {
          score *= profile.penalties.keywords || defaults.penalty;
          reasons.push('avoid-keyword');
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestProfile = profile;
        bestReasons = reasons;
        bestTags = Array.from(matchedTags);
      }
    });

    if (!bestProfile || bestScore <= 0) {
      return null;
    }

    return {
      profileName: bestProfile.name,
      score: Number(bestScore.toFixed(3)),
      reasons: bestReasons,
      matchedTags: bestTags
    };
  }

  /**
   * Check if sequential dependencies are satisfied for a task goal
   * @param {Object} goal - The goal to check
   * @param {Object} context - System context
   * @returns {boolean} True if dependencies are satisfied
   */
  checkSequentialDependencies(goal, context) {
    if (!goal.metadata?.sequentialDependencies?.length) {
      return true; // No dependencies
    }

    const dependencies = goal.metadata.sequentialDependencies;

    for (const dependency of dependencies) {
      if (!this.isDependencySatisfied(dependency, goal, context)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a specific dependency is satisfied
   */
  isDependencySatisfied(dependency, goal, context) {
    // Sequential phase dependencies
    if (dependency.startsWith('phase_')) {
      const phaseNumber = parseInt(dependency.replace('phase_', ''));
      return this.isPreviousPhaseComplete(phaseNumber, goal, context);
    }

    // Context availability dependencies
    if (dependency === 'context_available') {
      return this.isRequiredContextAvailable(goal, context);
    }

    // Research completion dependency
    if (dependency === 'research_complete') {
      return this.isResearchComplete(goal, context);
    }

    // Documentation availability dependency
    if (dependency === 'documentation_available') {
      return this.isDocumentationAvailable(goal, context);
    }

    return true; // Unknown dependency type assumed satisfied
  }

  /**
   * Check if a previous phase is complete
   */
  isPreviousPhaseComplete(phaseNumber, goal, context) {
    // Find the previous phase goal
    const previousPhaseGoal = this.getGoalByPhase(phaseNumber);

    if (!previousPhaseGoal) {
      return false; // Previous phase not found
    }

    // Check if previous phase is complete (progress >= 0.9)
    return previousPhaseGoal.progress >= 0.9;
  }

  /**
   * Check if required context is available in memory
   */
  isRequiredContextAvailable(goal, context) {
    const requiredContext = goal.metadata?.requiresContextFrom || [];

    if (requiredContext.length === 0) {
      return true; // No context required
    }

    // Check if relevant information exists in memory
    for (const contextType of requiredContext) {
      if (!this.hasContextInMemory(contextType, goal, context)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if research results are available
   */
  isResearchComplete(goal, context) {
    // Look for research-related findings in memory
    const researchFindings = context.memory?.query ?
      context.memory.query('research findings OR research results OR investigation', 5) : [];

    return researchFindings.length > 0;
  }

  /**
   * Check if documentation is available
   */
  isDocumentationAvailable(goal, context) {
    // Look for documentation in memory
    const documentation = context.memory?.query ?
      context.memory.query('documentation OR document OR guide', 3) : [];

    return documentation.length > 0;
  }

  /**
   * Check if specific context exists in memory
   */
  hasContextInMemory(contextType, goal, context) {
    if (!context.memory?.query) {
      return false;
    }

    // Query memory for the specific context type
    const results = context.memory.query(`${contextType} ${goal.description}`, 3);

    // Consider context available if we find relevant results
    return results.length > 0;
  }

  /**
   * Find a goal by its phase number
   */
  getGoalByPhase(phaseNumber) {
    // Search through all active goals for matching phase number
    const allGoals = this.getGoals();

    for (const goal of allGoals) {
      if (goal.metadata?.phaseNumber === phaseNumber) {
        return goal;
      }
    }

    // If not found, search by phase pattern in description
    for (const goal of allGoals) {
      if (goal.metadata?.isTaskGoal && goal.description.includes(`PHASE ${phaseNumber}`)) {
        return goal;
      }
    }

    return null; // Not found
  }

  /**
   * Update goal progress
   */
  updateGoalProgress(goalId, progressDelta, notes = '') {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    goal.progress = Math.max(0, Math.min(1, goal.progress + progressDelta));
    goal.lastPursued = Date.now(); // Store as epoch ms
    goal.pursuitCount++;

    if (this.goalAllocator && goal.claimed_by === this.goalAllocationInstance) {
      // Refresh local metadata so dashboards show active owner
      this.applyClaimMetadata(goal, { refresh: true });
    }

    this.logger?.debug('Goal progress updated', {
      goalId,
      progress: goal.progress.toFixed(2),
      delta: progressDelta
    });

    // Mark as complete if threshold reached
    if (goal.progress >= 0.9) {
      this.completeGoal(goalId, notes);
    }
  }

  /**
   * Record deliverable associated with a goal
   */
  recordGoalDeliverable(goalId, deliverable = {}) {
    const goal = this.goals.get(goalId);
    if (!goal) return false;

    const metadata = this.cloneMetadata(goal.metadata || {});
    const existing = Array.isArray(metadata.deliverables) ? [...metadata.deliverables] : [];

    const entry = {
      title: deliverable.title || deliverable.label || goal.description?.substring(0, 80) || 'Untitled Deliverable',
      path: deliverable.path || null,
      metadataPath: deliverable.metadataPath || null,
      format: deliverable.format || null,
      wordCount: deliverable.wordCount || null,
      createdAt: deliverable.createdAt || new Date().toISOString(),
      agentId: deliverable.agentId || null,
      agentType: deliverable.agentType || null,
      recordedAt: new Date().toISOString(),
      cycle: deliverable.cycle ?? null
    };

    if (entry.path && existing.some(item => item.path === entry.path)) {
      this.logger?.debug('Deliverable already recorded for goal', { goalId, path: entry.path });
      return false;
    }

    existing.push(entry);
    metadata.deliverables = existing;
    goal.metadata = metadata;

    this.logger?.info('Goal deliverable recorded', {
      goalId,
      path: entry.path,
      format: entry.format
    });

    if (this.curatorCallback) {
      this.curatorCallback({
        type: 'deliverable',
        goalId,
        goal,
        deliverable: entry
      }).catch(err => {
        this.logger?.error('Curator callback failed', { error: err.message });
      });
    }

    return true;
  }

  /**
   * Mark goal as complete
   * Note: Goal is marked completed but kept in map for grace period
   * This prevents issues with agents still working on the goal
   */
  completeGoal(goalId, notes = '') {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    if (goal.status === 'completed') return; // Already completed, avoid duplicate emit

    goal.status = 'completed';  // Mark as completed, don't delete yet
    goal.completedAt = Date.now(); // Store as epoch ms
    goal.completionNotes = notes;

    this.completedGoals.push(goal);
    // Don't delete immediately - will be cleaned up by rotation after grace period

    this.logger?.info('Goal completed (marked)', {
      goalId,
      description: goal.description.substring(0, 50),
      pursuitCount: goal.pursuitCount
    });

    // Emit real-time goal completed event
    cosmoEvents.emitGoalCompleted({
      goalId: goalId,
      description: goal.description,
      outcome: 'completed'
    });

    if (this.goalAllocator && goal.claimed_by) {
      const claimKey = this.formatGoalClaimKey(goal.id);
      if (goal.claimed_by === this.goalAllocationInstance) {
        this.goalAllocator.completeGoal(claimKey).catch(error => {
          this.logger?.warn('Goal allocator completion failed', {
            goalId,
            error: error.message
          });
        });
      } else {
        this.goalAllocator.releaseGoal(claimKey).catch(error => {
          this.logger?.warn('Goal allocator release failed', {
            goalId,
            error: error.message
          });
        });
      }
    }

    this.clearClaimMetadata(goal);
    
    // Notify curator of completion
    if (this.curatorCallback) {
      this.curatorCallback({
        type: 'completed',
        goalId: goalId,
        goal: goal
      }).catch(err => {
        this.logger?.error('Curator callback failed', { error: err.message });
      });
    }
  }

  /**
   * Prune lowest priority goal
   */
  pruneLowPriorityGoal() {
    const goals = Array.from(this.goals.values());
    if (goals.length === 0) return;

    goals.sort((a, b) => a.priority - b.priority);
    const toRemove = goals[0];

    this.releaseGoalClaim(toRemove);
    this.goals.delete(toRemove.id);

    this.logger?.info('Goal pruned', {
      goalId: toRemove.id,
      reason: 'low_priority'
    });
  }

  /**
   * Get all active goals (excludes completed/archived)
   */
  getGoals() {
    return Array.from(this.goals.values())
      .map(goal => {
        this.refreshClaimState(goal);
        return goal;
      })
      .filter(g => g.status === 'active' || !g.status)  // Include old goals without status
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get completed goals
   */
  getCompletedGoals() {
    return this.completedGoals;
  }

  /**
   * Get statistics
   */
  getStats() {
    const goals = Array.from(this.goals.values());

    return {
      activeGoals: goals.length,
      completedGoals: this.completedGoals.length,
      archivedGoals: (this.archivedGoals || []).length,
      averagePriority: goals.length > 0
        ? goals.reduce((sum, g) => sum + g.priority, 0) / goals.length
        : 0,
      averageProgress: goals.length > 0
        ? goals.reduce((sum, g) => sum + g.progress, 0) / goals.length
        : 0,
      sources: this.getSourceDistribution(goals),
      byCategory: this.getCategoryDistribution(goals),
      staleGoals: goals.filter(g => {
        const createdMs = toEpochMs(g.created);
        const daysSinceCreated = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
        return daysSinceCreated > 7 && g.pursuitCount === 0;
      }).length,
      overPursuedGoals: goals.filter(g => 
        g.pursuitCount > 10 && g.progress < 0.3
      ).length,
      dominantGoals: goals.filter(g => 
        g.pursuitCount > 5 && g.priority > 0.8
      ).length,
      satisfiedGoals: goals.filter(g => 
        g.progress >= 0.7
      ).length,
      claimSummary: this.getClaimSummary(goals)
    };
  }

  /**
   * Get source distribution
   */
  getSourceDistribution(goals) {
    const dist = {};
    
    for (const goal of goals) {
      dist[goal.source] = (dist[goal.source] || 0) + 1;
    }

    return dist;
  }

  /**
   * Get category distribution
   */
  getCategoryDistribution(goals) {
    const dist = {};
    
    for (const goal of goals) {
      const category = goal.category || 'uncategorized';
      dist[category] = (dist[category] || 0) + 1;
    }

    return dist;
  }

  getClaimSummary(goals) {
    const active = goals.filter(g => g.status === 'active' || !g.status);
    const summary = {
      total: active.length,
      claimed: 0,
      unclaimed: 0,
      byInstance: {}
    };

    for (const goal of active) {
      const owner = goal.claimed_by || goal.claimedBy || null;
      if (owner) {
        summary.claimed++;
        summary.byInstance[owner] = (summary.byInstance[owner] || 0) + 1;
      } else {
        summary.unclaimed++;
      }
    }

    return summary;
  }

  /**
   * Get goals by category
   */
  getGoalsByCategory(category) {
    return Array.from(this.goals.values())
      .filter(g => g.category === category)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get stale goals (old, never pursued)
   */
  getStaleGoals(minAgeDays = 7) {
    const cutoff = Date.now() - (minAgeDays * 24 * 60 * 60 * 1000);
    
    return Array.from(this.goals.values())
      .filter(g => {
        const createdMs = toEpochMs(g.created);
        return createdMs < cutoff && g.pursuitCount === 0;
      });
  }

  /**
   * Elevate priority of stale goals
   */
  elevateStalePriorities() {
    const stale = this.getStaleGoals();
    let elevated = 0;

    for (const goal of stale) {
      if (goal.priority < 0.7) {
        goal.priority = Math.min(1.0, goal.priority + 0.2);
        elevated++;
        
        this.logger?.debug('Elevated stale goal priority', {
          goalId: goal.id,
          newPriority: goal.priority.toFixed(2)
        });
      }
    }

    if (elevated > 0) {
      this.logger?.info('Elevated stale goal priorities', { count: elevated });
    }

    return elevated;
  }

  // ── doneWhen closer primitive ──

  setDoneWhenEnv(env) {
    this.doneWhenEnv = env;
  }

  getGoal(id) {
    return this.goals.get(id);
  }

  _applyRetrofit(goalId, doneWhen) {
    const g = this.goals.get(goalId);
    if (!g) return false;
    g.doneWhen = doneWhen;
    g.progress = 0;
    this.logger?.info?.('[migration] retrofit doneWhen', { id: goalId });
    return true;
  }

  async refreshProgressFromDoneWhen() {
    if (!this.doneWhenEnv) {
      this.logger?.debug?.('[closer] no doneWhen env, skipping refresh');
      return { refreshed: 0 };
    }
    let refreshed = 0;
    for (const goal of this.goals.values()) {
      if (goal.status === 'completed' || goal.status === 'archived') continue;
      if (!goal.doneWhen) continue;
      const r = await checkDoneWhen(goal, this.doneWhenEnv);
      const prev = goal.progress;
      goal.progress = r.total > 0 ? r.satisfied / r.total : 0;
      if (goal.progress === 1 && goal.status !== 'completed') {
        this.completeGoal(goal.id, 'doneWhen satisfied');
        this._completedViaDoneWhenCount24h = (this._completedViaDoneWhenCount24h || 0) + 1;
      }
      refreshed++;
      if (goal.progress !== prev) {
        this.logger?.info?.('[closer] goal progress updated', {
          id: goal.id, prev, next: goal.progress, satisfied: r.satisfied, total: r.total
        });
      }
    }
    return { refreshed };
  }

  /**
   * Archive a goal (remove from active, don't mark as completed)
   */
  archiveGoal(goalId, reason = 'archived') {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    
    goal.status = 'archived';  // Mark as archived
    goal.archivedAt = Date.now();
    goal.archiveReason = reason;

    this.releaseGoalClaim(goal);
    
    // Move to archived list
    if (!this.archivedGoals) this.archivedGoals = [];
    this.archivedGoals.push(goal);
    // Don't delete yet - will be cleaned up by rotation
    
    this.logger?.info('Goal archived (marked)', {
      goalId,
      reason,
      description: goal.description.substring(0, 50)
    });
    
    // Notify curator of archival
    if (this.curatorCallback) {
      this.curatorCallback({
        type: 'archived',
        goalId: goalId,
        goal: goal
      }).catch(err => {
        this.logger?.error('Curator callback failed', { error: err.message });
      });
    }
    
    return true;
  }

  /**
   * Archive multiple goals by ID
   */
  archiveGoalsByIds(goalIds, reason = 'coordinator_recommendation') {
    let archived = 0;
    for (const goalId of goalIds) {
      if (this.archiveGoal(goalId, reason)) {
        archived++;
      }
    }
    
    if (archived > 0) {
      this.logger?.info('Batch goals archived', {
        count: archived,
        reason
      });
    }
    
    return archived;
  }

  /**
   * Check goal satisfaction and rotation
   */
  performGoalRotation(rotationConfig) {
    if (!rotationConfig?.enabled) return { completed: 0, archived: 0, cleaned: 0 };
    
    const goals = Array.from(this.goals.values());
    let completed = 0;
    let archived = 0;
    let cleaned = 0;
    
    // FIRST: Clean up goals that have been completed/archived for grace period (5 min)
    const graceMs = 5 * 60 * 1000;  // 5 minutes
    const now = Date.now();
    
    for (const goal of goals) {
      if (goal.status === 'completed' || goal.status === 'archived') {
        const statusTime = goal.completedAt || goal.archivedAt || now;
        if (now - statusTime > graceMs) {
          this.releaseGoalClaim(goal);
          this.goals.delete(goal.id);
          cleaned++;
          this.logger?.debug('Cleaned up finished goal', {
            goalId: goal.id,
            status: goal.status,
            description: goal.description.substring(0, 50)
          });
        }
      }
    }
    
    // Get active goals only for rotation logic
    const activeGoals = goals.filter(g => g.status === 'active' || !g.status);
    
    const maxPursuits = rotationConfig.maxPursuitsPerGoal || 15;
    const satisfactionThreshold = rotationConfig.satisfactionThreshold || 0.7;
    const staleDays = rotationConfig.staleArchiveAfterDays || 7;
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const autoArchiveThreshold = rotationConfig.autoArchiveThreshold || 0.3;
    const minProgressPerPursuit = rotationConfig.minProgressPerPursuit || 0.05;
    
    // THEN: Apply rotation logic to active goals only
    for (const goal of activeGoals) {
      // 1. Auto-complete if progress threshold reached
      if (goal.progress >= satisfactionThreshold) {
        this.completeGoal(goal.id, 'Satisfaction threshold reached');
        completed++;
        continue;
      }
      
      // 2. Archive if pursued too many times without completion
      if (goal.pursuitCount >= maxPursuits) {
        this.archiveGoal(goal.id, `Exceeded max pursuits (${maxPursuits})`);
        archived++;
        continue;
      }
      
      // 3. Archive if stale (not pursued recently)
      const createdMs = toEpochMs(goal.created);
      const lastPursuedMs = goal.lastPursued ? toEpochMs(goal.lastPursued) : createdMs;
      const timeSinceLastPursuit = Date.now() - lastPursuedMs;
      
      if (goal.pursuitCount > 0 && timeSinceLastPursuit > staleMs) {
        this.archiveGoal(goal.id, `Stale (${staleDays}+ days inactive)`);
        archived++;
        continue;
      }
      
      // 4. NEW: Archive if priority dropped too low
      if (goal.priority < autoArchiveThreshold) {
        this.archiveGoal(goal.id, `Low priority (${(goal.priority * 100).toFixed(0)}% < ${(autoArchiveThreshold * 100).toFixed(0)}%)`);
        archived++;
        continue;
      }
      
      // 5. NEW: Archive if not making progress (pursued 5+ times but little progress)
      if (goal.pursuitCount >= 5) {
        const progressPerPursuit = goal.progress / goal.pursuitCount;
        if (progressPerPursuit < minProgressPerPursuit) {
          this.archiveGoal(goal.id, `Insufficient progress (${(progressPerPursuit * 100).toFixed(1)}% per pursuit < ${(minProgressPerPursuit * 100).toFixed(0)}%)`);
          archived++;
          continue;
        }
      }
    }
    
    this.logger?.info('Goal rotation performed', {
      completed,
      archived,
      cleaned,
      remaining: this.goals.size
    });
    
    return { completed, archived, cleaned };
  }

  /**
   * Detect goal monopolization
   */
  detectDominantGoal(recentJournal, threshold = 0.20) {
    if (!recentJournal || recentJournal.length < 20) return null;
    
    // Count goal pursuits in recent journal
    const goalCounts = {};
    let totalPursuits = 0;
    
    for (const entry of recentJournal.slice(-30)) {
      if (entry.goal) {
        goalCounts[entry.goal] = (goalCounts[entry.goal] || 0) + 1;
        totalPursuits++;
      }
    }
    
    if (totalPursuits === 0) return null;
    
    // Find dominant goal
    for (const [goalDescription, count] of Object.entries(goalCounts)) {
      const dominance = count / totalPursuits;
      if (dominance > threshold) {
        const goalEntry = Array.from(this.goals.entries()).find(([, goal]) =>
          goal && (goal.status === 'active' || !goal.status) && goal.description === goalDescription
        );

        if (!goalEntry) {
          continue;
        }

        return {
          goalId: goalEntry[0],
          goalDescription,
          pursuitCount: count,
          totalPursuits,
          dominance: dominance.toFixed(2),
          percentage: (dominance * 100).toFixed(0)
        };
      }
    }
    
    return null;
  }

  /**
   * Rotate dominant goal to allow others
   */
  rotateDominantGoal(dominantInfo) {
    const goal = this.goals.get(dominantInfo.goalId);
    if (!goal) return false;
    
    // Temporarily reduce priority to let others surface
    goal.priority = Math.max(0.2, goal.priority * 0.5);
    goal.rotationCount = (goal.rotationCount || 0) + 1;
    goal.lastRotated = Date.now();
    
    this.logger?.info('Goal rotated (deprioritized)', {
      goalId: dominantInfo.goalId,
      reason: `Dominated ${dominantInfo.percentage}% of recent pursuits`,
      newPriority: goal.priority.toFixed(2)
    });
    
    return true;
  }

  /**
   * Export goals for persistence
   */
  export() {
    return {
      active: Array.from(this.goals.entries()),
      completed: this.completedGoals,
      archived: this.archivedGoals || [],
      nextGoalId: this.nextGoalId
    };
  }

  /**
   * Import goals from persistence
   */
  import(data) {
    if (data.active) {
      const cleaned = [];
      const removed = [];
      const removedCompleted = [];
      const removedArchived = [];

      for (const entry of data.active) {
        const [goalId, goal] = entry || [];
        if (!goal) {
          removed.push(goalId || 'unknown');
          continue;
        }

        if (!goal.status || goal.status === 'active') {
          cleaned.push(entry);
        } else {
          removed.push(goalId);
          if (goal.status === 'completed') {
            removedCompleted.push(goal);
          } else if (goal.status === 'archived') {
            removedArchived.push(goal);
          }
        }
      }

      this.goals = new Map(cleaned);

      if (removed.length > 0) {
        this.logger?.info('Pruned non-active goals during import', {
          removedCount: removed.length,
          removedIds: removed.slice(0, 10)
        });
      }

      if (removedCompleted.length > 0) {
        if (!Array.isArray(data.completed)) {
          data.completed = [];
        }
        const existingIds = new Set(
          data.completed
            .map(goal => goal?.id)
            .filter(Boolean)
        );
        for (const goal of removedCompleted) {
          if (!existingIds.has(goal.id)) {
            data.completed.push(goal);
            existingIds.add(goal.id);
          }
        }
      }

      if (removedArchived.length > 0) {
        if (!Array.isArray(data.archived)) {
          data.archived = [];
        }
        const existingIds = new Set(
          data.archived
            .map(goal => goal?.id)
            .filter(Boolean)
        );
        for (const goal of removedArchived) {
          if (!existingIds.has(goal.id)) {
            data.archived.push(goal);
            existingIds.add(goal.id);
          }
        }
      }
    }
    if (data.completed) {
      this.completedGoals = data.completed;
    }
    if (data.archived) {
      this.archivedGoals = data.archived;
    }
    if (data.nextGoalId) {
      this.nextGoalId = data.nextGoalId;
    }

    this.logger?.info('Goals imported', {
      active: this.goals.size,
      completed: this.completedGoals.length,
      archived: (this.archivedGoals || []).length
    });
  }

  /**
   * Merge similar goals
   */
  mergeSimilarGoals(similarityThreshold = 0.8) {
    const goals = Array.from(this.goals.values());
    const merged = [];

    for (let i = 0; i < goals.length; i++) {
      for (let j = i + 1; j < goals.length; j++) {
        const similarity = this.goalSimilarity(goals[i].description, goals[j].description);
        
        if (similarity >= similarityThreshold) {
          // Merge j into i
          goals[i].priority = Math.max(goals[i].priority, goals[j].priority);
          goals[i].progress = Math.max(goals[i].progress, goals[j].progress);
          
          this.goals.delete(goals[j].id);
          merged.push(goals[j].id);
          
          this.logger?.info('Merged similar goals', {
            kept: goals[i].id,
            removed: goals[j].id,
            similarity: similarity.toFixed(2)
          });
        }
      }
    }

    return merged.length;
  }

  /**
   * Calculate similarity between goals (simple word overlap)
   */
  goalSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const words2 = new Set(text2.toLowerCase().match(/\b\w{4,}\b/g) || []);
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }
}

module.exports = { IntrinsicGoalSystem };
