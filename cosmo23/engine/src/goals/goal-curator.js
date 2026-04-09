const { UnifiedClient } = require('../core/unified-client');
const {
  CampaignDecisionSchema,
  SynthesisDecisionSchema,
  createStructuredOutputRequest,
  parseStructuredOutput
} = require('../schemas/structured-outputs');
const { getDomainAnchor, filterDomainRelevant } = require('../utils/domain-anchor');

/**
 * Goal Cultivation Substrate
 * 
 * Operates as a separate layer that receives goals from the main cognitive loop,
 * processes them into campaigns and narratives, and outputs curated goal suggestions.
 * 
 * Key responsibilities:
 * - Organize goals into campaigns (multi-cycle research programs)
 * - Track goal narratives (birth → development → completion)
 * - Synthesize mature goals into higher-level understanding
 * - Bridge goals to memory for contextual relevance
 * - Provide health monitoring and status to main loop
 */
class GoalCurator {
  constructor(goals, memory, logger, config = {}, evaluation = null) {
    this.goals = goals;
    this.memory = memory;
    this.logger = logger;
    this.config = config;
    this.evaluation = evaluation;

    // LLM client (supports both OpenAI and local LLMs)
    this.gpt5 = new UnifiedClient(config, logger);

    // Curator state
    this.campaigns = new Map();
    this.goalNarratives = new Map();
    this.completedNarratives = new Map();
    this.synthesisQueue = [];
    this.memoryBridges = new Map();
    this.guidanceQueue = [];
    
    // Tracking
    this.lastCuration = 0;
    this.nextCampaignId = 1;
    this.stats = {
      campaignsCreated: 0,
      goalsReorganized: 0,
      synthesisPerformed: 0,
      narrativesCompleted: 0
    };
  }

  /**
   * Main entry point: Handle goal events from main loop
   */
  async handleEvent(event) {
    try {
      switch(event.type) {
        case 'created':
          await this.onGoalCreated(event);
          break;
        case 'pursued':
          await this.onGoalPursued(event);
          break;
        case 'completed':
          await this.onGoalCompleted(event);
          break;
        case 'archived':
          await this.onGoalArchived(event);
          break;
        case 'deliverable':
          await this.onGoalDeliverable(event);
          break;
      }
    } catch (error) {
      this.logger?.error('Goal curator event handling failed', {
        event: event.type,
        goalId: event.goalId,
        error: error.message
      });
    }
  }

  /**
   * Periodic curation pass
   */
  async curate(cycle, journal) {
    const interval = this.config.curationInterval || 20;
    if (cycle - this.lastCuration < interval) return;
    
    this.logger?.info('🎨 Goal curation starting', { cycle });
    
    const health = this.analyzeGoalHealth();
    
    // 1. Create campaigns for stagnant goals
    if (health.stagnant.length >= 5) {
      await this.createCampaigns(health.stagnant, cycle);
    }
    
    // 2. Merge fragmented goals
    if (health.fragmented.length > 0) {
      await this.mergeFragmentedGoals(health.fragmented);
    }
    
    // 3. Synthesize mature goals
    if (health.mature.length >= 3) {
      await this.synthesizeMatureGoals(health.mature, cycle);
    }
    
    // 4. Bridge orphaned goals to memory
    if (health.orphaned.length > 0) {
      await this.bridgeGoalsToMemory(health.orphaned);
    }
    
    // 5. Update campaign status
    await this.updateAllCampaigns(cycle);
    
    // 6. Process any human guidance
    if (this.guidanceQueue.length > 0) {
      await this.processGuidance();
    }
    
    this.lastCuration = cycle;
    
    this.logger?.info('🎨 Goal curation complete', {
      campaigns: this.campaigns.size,
      synthesisQueue: this.synthesisQueue.length,
      health: health.summary
    });
  }

  /**
   * Goal Created Event Handler
   */
  async onGoalCreated(event) {
    const goal = event.goal;
    
    // Initialize narrative
    this.goalNarratives.set(goal.id, {
      goalId: goal.id,
      birth: {
        cycle: event.cycle,
        source: goal.source,
        initialDescription: goal.description,
        initialPriority: goal.priority
      },
      events: [],
      deliverables: [],
      status: 'nascent',
      created: Date.now()
    });
    
    // Check if it should join an existing campaign
    const matchingCampaign = this.findMatchingCampaign(goal);
    if (matchingCampaign) {
      this.addGoalToCampaign(goal.id, matchingCampaign.id);
      this.logger?.debug('Goal added to existing campaign', {
        goalId: goal.id,
        campaignId: matchingCampaign.id
      });
    }
  }

  /**
   * Goal Pursued Event Handler
   */
  async onGoalPursued(event) {
    const narrative = this.goalNarratives.get(event.goalId);
    if (!narrative) return;
    
    // Record pursuit event
    narrative.events.push({
      cycle: event.cycle,
      type: 'pursued',
      progress: event.goal.progress,
      pursuitCount: event.goal.pursuitCount,
      timestamp: Date.now()
    });
    
    // Update status based on progress
    if (event.goal.pursuitCount === 1) {
      narrative.status = 'active';
    } else if (event.goal.progress > 0.5) {
      narrative.status = 'maturing';
    }
    
    // Update campaign progress if applicable
    const campaign = this.getCampaignForGoal(event.goalId);
    if (campaign) {
      this.updateCampaignProgress(campaign.id, event.cycle);
    }
  }

  /**
   * Goal Completed Event Handler
   */
  async onGoalCompleted(event) {
    const narrative = this.goalNarratives.get(event.goalId);
    if (!narrative) return;
    
    // Record completion
    narrative.completion = {
      cycle: event.cycle,
      finalProgress: event.goal.progress,
      totalPursuits: event.goal.pursuitCount,
      completionNotes: event.goal.completionNotes,
      durationCycles: event.cycle - narrative.birth.cycle,
      timestamp: Date.now()
    };
    narrative.status = 'completed';
    
    // Generate completion summary
    const summary = await this.generateCompletionSummary(event.goalId);
    narrative.summary = summary;
    
    // Check if this completes a campaign
    const campaign = this.getCampaignForGoal(event.goalId);
    if (campaign) {
      await this.checkCampaignCompletion(campaign.id, event.cycle);
    }
    
    // Archive the narrative
    this.completedNarratives.set(event.goalId, narrative);
    this.goalNarratives.delete(event.goalId);
    this.stats.narrativesCompleted++;
    
    this.logger?.info('🎓 Goal narrative completed', {
      goalId: event.goalId,
      durationCycles: narrative.completion.durationCycles,
      pursuits: narrative.completion.totalPursuits,
      summary: summary?.slice(0, 80)
    });
  }

  /**
   * Goal Archived Event Handler
   */
  async onGoalArchived(event) {
    const narrative = this.goalNarratives.get(event.goalId);
    if (!narrative) return;
    
    narrative.archived = {
      cycle: event.cycle,
      reason: event.goal.archiveReason,
      timestamp: Date.now()
    };
    narrative.status = 'archived';
    
    // Remove from campaign if applicable
    const campaign = this.getCampaignForGoal(event.goalId);
    if (campaign) {
      this.removeGoalFromCampaign(event.goalId, campaign.id);
    }
    
    // Move to completed narratives (archived is a type of completion)
    this.completedNarratives.set(event.goalId, narrative);
    this.goalNarratives.delete(event.goalId);
  }

  /**
   * Goal Deliverable Event Handler
   */
  async onGoalDeliverable(event) {
    const narrative = this.goalNarratives.get(event.goalId);
    if (!narrative) return;

    const deliverable = {
      title: event.deliverable?.title || narrative.goalId,
      path: event.deliverable?.path || null,
      metadataPath: event.deliverable?.metadataPath || null,
      format: event.deliverable?.format || null,
      wordCount: event.deliverable?.wordCount || null,
      agentId: event.deliverable?.agentId || null,
      agentType: event.deliverable?.agentType || null,
      createdAt: event.deliverable?.createdAt || event.deliverable?.recordedAt || null,
      recordedAt: event.deliverable?.recordedAt || new Date().toISOString()
    };

    narrative.deliverables = Array.isArray(narrative.deliverables)
      ? narrative.deliverables
      : [];
    narrative.deliverables.push(deliverable);

    const deliverableCycle = deliverable.cycle ?? null;

    narrative.events.push({
      cycle: deliverableCycle,
      type: 'deliverable',
      deliverable,
      timestamp: Date.now()
    });

    const campaign = this.getCampaignForGoal(event.goalId);
    if (campaign) {
      campaign.deliverables = Array.isArray(campaign.deliverables)
        ? campaign.deliverables
        : [];
      campaign.deliverables.push({
        goalId: event.goalId,
        cycle: deliverableCycle,
        ...deliverable
      });
    }

    this.logger?.info('🗂️ Goal deliverable captured', {
      goalId: event.goalId,
      path: deliverable.path,
      campaignId: campaign?.id || null
    });
  }

  /**
   * Analyze goal health
   */
  analyzeGoalHealth() {
    const activeGoals = this.goals.getGoals();
    const now = Date.now();
    
    const stagnant = activeGoals.filter(g => 
      g.pursuitCount === 0 && 
      (now - g.created) > 5 * 60 * 1000 // 5 minutes old, never pursued
    );
    
    const fragmented = this.findSimilarGoals(activeGoals, 0.75);
    
    const mature = activeGoals.filter(g => 
      g.progress > 0.5 && 
      g.pursuitCount > 15
    );
    
    const orphaned = activeGoals.filter(g => 
      !this.hasMemoryConnections(g)
    );
    
    return {
      stagnant,
      fragmented,
      mature,
      orphaned,
      summary: {
        stagnant: stagnant.length,
        fragmented: fragmented.length,
        mature: mature.length,
        orphaned: orphaned.length
      }
    };
  }

  /**
   * Create campaigns from stagnant goals
   */
  async createCampaigns(stagnantGoals, cycle) {
    if (stagnantGoals.length === 0) return;
    
    // Cluster goals by theme using LLM
    const clusters = await this.clusterGoals(stagnantGoals);
    
    for (const cluster of clusters) {
      if (cluster.goalIds.length < 3) continue; // Need at least 3 goals for a campaign
      
      const campaign = {
        id: `campaign_${this.nextCampaignId++}`,
        name: cluster.theme,
        description: cluster.description,
        goals: cluster.goalIds,
        status: 'active',
        startCycle: cycle,
        duration: 30, // 30 cycles
        progress: 0,
        created: Date.now(),
        deliverables: []
      };
      
      this.campaigns.set(campaign.id, campaign);
      this.stats.campaignsCreated++;
      
      // Track campaign creation in evaluation framework
      if (this.evaluation) {
        this.evaluation.trackCampaignCreated(campaign.id, campaign);
      }
      
      // Boost priority of goals in campaign
      for (const goalId of cluster.goalIds) {
        const goal = this.goals.goals.get(goalId);
        if (goal) {
          goal.priority = Math.min(1.0, goal.priority * 1.3);
          goal.inCampaign = campaign.id;
        }
      }
      
      this.logger?.info('📋 Campaign created', {
        id: campaign.id,
        name: campaign.name,
        goals: campaign.goals.length
      });
    }
  }

  /**
   * Cluster goals by theme
   */
  async clusterGoals(goals) {
    if (goals.length < 3) return [];

    const goalList = goals.map((g, i) =>
      `${i+1}. [${g.id}] ${g.description}`
    ).join('\n');

    // DOMAIN ANCHOR: Cluster only domain-relevant goals
    const domainAnchorBlock = getDomainAnchor(this.config);

    const prompt = `
${domainAnchorBlock}

Analyze these goals and cluster them into research campaigns (groups of 3-5 related DOMAIN goals).

GOALS:
${goalList}

For each cluster, provide:
1. Theme (short name RELATED TO THE DOMAIN)
2. Description (what this campaign investigates IN THE DOMAIN)
3. Goal IDs to include (ONLY domain-relevant goals)

⚠️ SKIP goals about QA gates, probes, CLI tools, COSMO infrastructure - these are meta-pollution.

Format as JSON array:
[{
  "theme": "...",
  "description": "...",
  "goalIds": ["goal_X", "goal_Y", ...]
}]

Create 2-4 meaningful DOMAIN campaigns. Skip goals that don't fit the research domain.
    `.trim();

    try {
      const response = await this.gpt5.generateFast({
        component: 'goalCurator',
        purpose: 'clustering',
        instructions: 'You cluster research goals into coherent campaigns.',
        input: prompt,
        maxTokens: 2000
      });

      const content = this.gpt5.extractTextFromResponse(response);
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      this.logger?.error('Goal clustering failed', { error: error.message });
    }

    return [];
  }

  /**
   * Find similar goals for merging
   */
  findSimilarGoals(goals, threshold = 0.75) {
    const similar = [];
    
    for (let i = 0; i < goals.length; i++) {
      for (let j = i + 1; j < goals.length; j++) {
        const similarity = this.calculateSimilarity(
          goals[i].description,
          goals[j].description
        );
        
        if (similarity >= threshold) {
          similar.push({
            goal1: goals[i],
            goal2: goals[j],
            similarity
          });
        }
      }
    }
    
    return similar;
  }

  /**
   * Calculate text similarity (simple word overlap)
   */
  calculateSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const words2 = new Set(text2.toLowerCase().match(/\b\w{4,}\b/g) || []);
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Merge fragmented goals
   */
  async mergeFragmentedGoals(fragmentedPairs) {
    for (const pair of fragmentedPairs.slice(0, 5)) { // Limit merges per cycle
      const goal1 = pair.goal1;
      const goal2 = pair.goal2;
      
      // Merge goal2 into goal1
      goal1.priority = Math.max(goal1.priority, goal2.priority);
      goal1.progress = Math.max(goal1.progress, goal2.progress);
      goal1.mergedFrom = goal1.mergedFrom || [];
      goal1.mergedFrom.push(goal2.id);
      
      // Archive goal2
      this.goals.archiveGoal(goal2.id, `Merged into ${goal1.id} (${(pair.similarity * 100).toFixed(0)}% similar)`);
      
      this.stats.goalsReorganized++;
      
      this.logger?.info('🔀 Goals merged', {
        kept: goal1.id,
        merged: goal2.id,
        similarity: (pair.similarity * 100).toFixed(0) + '%'
      });
    }
  }

  /**
   * Synthesize mature goals
   */
  async synthesizeMatureGoals(matureGoals, cycle) {
    if (matureGoals.length < 3) return;
    
    // Find groups of related mature goals
    const groups = await this.groupRelatedGoals(matureGoals);
    
    for (const group of groups) {
      if (group.goalIds.length < 2) continue;
      
      // Create synthesis goal
      const synthesisGoal = {
        description: group.synthesisDescription,
        reason: `Synthesis of ${group.goalIds.length} mature goals: ${group.insights}`,
        uncertainty: 0.7,
        source: 'goal_synthesis',
        parentGoals: group.goalIds
      };
      
      const newGoal = this.goals.addGoal(synthesisGoal);
      
      if (newGoal) {
        // Archive the source goals
        for (const goalId of group.goalIds) {
          this.goals.archiveGoal(
            goalId,
            `Synthesized into ${newGoal.id}`
          );
        }
        
        this.stats.synthesisPerformed++;
        
        this.logger?.info('🧬 Goals synthesized', {
          newGoalId: newGoal.id,
          sourceGoals: group.goalIds.length,
          theme: group.theme
        });
      }
    }
  }

  /**
   * Group related goals for synthesis
   */
  async groupRelatedGoals(goals) {
    const goalList = goals.map(g =>
      `[${g.id}] ${g.description} (progress: ${(g.progress * 100).toFixed(0)}%)`
    ).join('\n');

    // DOMAIN ANCHOR: Synthesize only domain-relevant goals
    const domainAnchorBlock = getDomainAnchor(this.config);

    const prompt = `
${domainAnchorBlock}

Analyze these mature goals and identify 1-2 synthesis opportunities FOR THE DOMAIN RESEARCH.

MATURE GOALS:
${goalList}

For each synthesis group, provide:
1. Theme (what connects them IN THE DOMAIN)
2. Goal IDs to synthesize (ONLY domain-relevant goals)
3. Synthesis description (higher-level DOMAIN goal)
4. Key insights gained FOR THE DOMAIN

⚠️ SKIP goals about QA gates, probes, CLI tools, COSMO infrastructure - these are meta-pollution.

Format as JSON array:
[{
  "theme": "...",
  "goalIds": ["goal_X", "goal_Y"],
  "synthesisDescription": "...",
  "insights": "..."
}]
    `.trim();

    try {
      const response = await this.gpt5.generateFast({
        component: 'goalCurator',
        purpose: 'synthesis',
        instructions: 'You identify synthesis opportunities in research goals.',
        input: prompt,
        maxTokens: 2000
      });

      const content = this.gpt5.extractTextFromResponse(response);
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      this.logger?.error('Goal synthesis grouping failed', { error: error.message });
    }

    return [];
  }

  /**
   * Bridge goals to memory
   */
  async bridgeGoalsToMemory(orphanedGoals) {
    for (const goal of orphanedGoals.slice(0, 10)) { // Process 10 per cycle
      // Find related memory nodes (simple text matching for now)
      const relatedNodes = this.findRelatedMemoryNodes(goal);
      
      if (relatedNodes.length > 0) {
        this.memoryBridges.set(goal.id, relatedNodes.map(n => n.id));
        
        this.logger?.debug('🌉 Goal bridged to memory', {
          goalId: goal.id,
          memoryNodes: relatedNodes.length
        });
      }
    }
  }

  /**
   * Find related memory nodes
   */
  findRelatedMemoryNodes(goal) {
    const allNodes = Array.from(this.memory.nodes.values());
    const goalWords = new Set(goal.description.toLowerCase().match(/\b\w{4,}\b/g) || []);
    
    return allNodes
      .map(node => ({
        node,
        relevance: this.calculateRelevance(node.concept || '', goalWords)  // Fixed: use 'concept', not 'content'
      }))
      .filter(r => r.relevance > 0.3)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3)
      .map(r => r.node);
  }

  /**
   * Calculate relevance score
   */
  calculateRelevance(content, goalWords) {
    // Handle undefined/null content gracefully
    if (!content) return 0;
    
    const contentWords = new Set(content.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const intersection = new Set([...goalWords].filter(x => contentWords.has(x)));
    return intersection.size / Math.max(goalWords.size, 1);
  }

  /**
   * Check if goal has memory connections
   */
  hasMemoryConnections(goal) {
    return this.memoryBridges.has(goal.id);
  }

  /**
   * Update all active campaigns
   */
  async updateAllCampaigns(cycle) {
    for (const campaign of this.campaigns.values()) {
      if (campaign.status === 'active') {
        this.updateCampaignProgress(campaign.id, cycle);
      }
    }
  }

  /**
   * Update campaign progress
   */
  updateCampaignProgress(campaignId, cycle) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;
    
    // Calculate progress based on goal completion
    let totalProgress = 0;
    let validGoals = 0;
    
    for (const goalId of campaign.goals) {
      const goal = this.goals.goals.get(goalId);
      if (goal) {
        totalProgress += goal.progress;
        validGoals++;
      }
    }
    
    campaign.progress = validGoals > 0 ? totalProgress / validGoals : 0;
    
    // Check if campaign should end
    const cyclesElapsed = cycle - campaign.startCycle;
    if (cyclesElapsed >= campaign.duration || campaign.progress >= 0.9) {
      campaign.status = 'completed';
      campaign.endCycle = cycle;
      
      // Track campaign completion in evaluation framework
      if (this.evaluation) {
        this.evaluation.trackCampaignCompleted(campaign.id, false);
      }
      
      this.logger?.info('🎯 Campaign completed', {
        id: campaign.id,
        name: campaign.name,
        progress: (campaign.progress * 100).toFixed(0) + '%',
        duration: cyclesElapsed
      });
    }
  }

  /**
   * Check if campaign is complete
   */
  async checkCampaignCompletion(campaignId, cycle) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign || campaign.status !== 'active') return;
    
    // Count completed goals
    let completedCount = 0;
    for (const goalId of campaign.goals) {
      const goal = this.goals.goals.get(goalId);
      if (!goal || goal.status === 'completed') {
        completedCount++;
      }
    }
    
    // Campaign completes when 80% of goals are done
    if (completedCount / campaign.goals.length >= 0.8) {
      campaign.status = 'completed';
      campaign.endCycle = cycle;
      campaign.completionReason = `${completedCount}/${campaign.goals.length} goals completed`;
      
      // Track campaign completion in evaluation framework
      if (this.evaluation) {
        this.evaluation.trackCampaignCompleted(campaign.id, true); // synthesized = true
      }
      
      this.logger?.info('🏆 Campaign fully completed', {
        id: campaign.id,
        name: campaign.name,
        goalsCompleted: completedCount
      });
    }
  }

  /**
   * Generate completion summary for a goal
   */
  async generateCompletionSummary(goalId) {
    const narrative = this.goalNarratives.get(goalId);
    if (!narrative || !narrative.completion) return "Goal completed";

    const eventsText = narrative.events
      .slice(0, 5)
      .map(e => `Cycle ${e.cycle}: ${e.type} (progress: ${(e.progress * 100).toFixed(0)}%)`)
      .join('\n');

    const prompt = `
Summarize this goal's journey in 2-3 sentences:

Goal: ${narrative.birth.initialDescription}
Duration: ${narrative.completion.durationCycles} cycles
Pursuits: ${narrative.completion.totalPursuits}

Events:
${eventsText}

Focus on what was accomplished and learned.
    `.trim();

    try {
      const response = await this.gpt5.generateFast({
        component: 'goalCurator',
        purpose: 'summary',
        instructions: 'You summarize research goal completions concisely.',
        input: prompt,
        maxTokens: 1500
      });

      return this.gpt5.extractTextFromResponse(response);
    } catch (error) {
      this.logger?.error('Summary generation failed', { error: error.message });
      return `Goal completed after ${narrative.completion.durationCycles} cycles and ${narrative.completion.totalPursuits} pursuits.`;
    }
  }

  /**
   * Suggest next goal for main loop to pursue
   */
  async suggestNextGoal(context) {
    // Priority 1: Campaign goals
    for (const campaign of this.campaigns.values()) {
      if (campaign.status === 'active') {
        // Find unpursued or low-pursuit goals in this campaign
        for (const goalId of campaign.goals) {
          const goal = this.goals.goals.get(goalId);
          if (goal && goal.pursuitCount < 5) {
            return {
              goalId: goal.id,
              reason: `Campaign: ${campaign.name}`,
              priority: 'campaign'
            };
          }
        }
      }
    }
    
    // Priority 2: Memory-bridged goals
    for (const [goalId, memoryNodes] of this.memoryBridges.entries()) {
      const goal = this.goals.goals.get(goalId);
      if (goal && goal.pursuitCount === 0) {
        return {
          goalId: goal.id,
          reason: 'Connected to active memory',
          priority: 'memory_bridged'
        };
      }
    }
    
    // Priority 3: Let main loop decide
    return null;
  }

  /**
   * Find matching campaign for a new goal
   */
  findMatchingCampaign(goal) {
    for (const campaign of this.campaigns.values()) {
      if (campaign.status !== 'active') continue;
      
      // Check if goal description matches campaign theme
      const campaignWords = new Set(campaign.name.toLowerCase().match(/\b\w{4,}\b/g) || []);
      const goalWords = new Set(goal.description.toLowerCase().match(/\b\w{4,}\b/g) || []);
      const overlap = new Set([...campaignWords].filter(x => goalWords.has(x)));
      
      if (overlap.size >= 2) {
        return campaign;
      }
    }
    
    return null;
  }

  /**
   * Add goal to campaign
   */
  addGoalToCampaign(goalId, campaignId) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;
    
    if (!campaign.goals.includes(goalId)) {
      campaign.goals.push(goalId);
    }
    
    const goal = this.goals.goals.get(goalId);
    if (goal) {
      goal.inCampaign = campaignId;
    }
  }

  /**
   * Remove goal from campaign
   */
  removeGoalFromCampaign(goalId, campaignId) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;
    
    campaign.goals = campaign.goals.filter(id => id !== goalId);
  }

  /**
   * Get campaign for goal
   */
  getCampaignForGoal(goalId) {
    for (const campaign of this.campaigns.values()) {
      if (campaign.goals.includes(goalId)) {
        return campaign;
      }
    }
    return null;
  }

  /**
   * Get active campaigns
   */
  getActiveCampaigns() {
    return Array.from(this.campaigns.values())
      .filter(c => c.status === 'active');
  }

  /**
   * Get status for monitoring
   */
  getStatus() {
    const activeGoals = this.goals.getGoals();
    const unpursuedGoals = activeGoals.filter(g => g.pursuitCount === 0).length;
    
    // Determine health
    let health = 'healthy';
    const issues = [];
    
    if (unpursuedGoals > 100) {
      health = 'attention_needed';
      issues.push(`${unpursuedGoals} unpursued goals`);
    }
    
    if (this.campaigns.size === 0 && activeGoals.length > 50) {
      health = 'attention_needed';
      issues.push('No campaigns but many goals');
    }
    
    return {
      health,
      issues,
      activeCampaigns: this.getActiveCampaigns(),
      synthesisQueue: this.synthesisQueue,
      unpursuedGoals,
      totalNarratives: this.goalNarratives.size,
      completedNarratives: this.completedNarratives.size,
      stats: this.stats
    };
  }

  /**
   * Get narrative for a specific goal
   */
  getNarrative(goalId) {
    return this.goalNarratives.get(goalId) || 
           this.completedNarratives.get(goalId);
  }

  /**
   * Receive guidance from external source (e.g., MCP)
   */
  async receiveGuidance(guidance) {
    this.guidanceQueue.push(guidance);
    
    this.logger?.info('📥 Guidance received', {
      source: guidance.source,
      targetCampaign: guidance.targetCampaign
    });
  }

  /**
   * Process guidance queue
   */
  async processGuidance() {
    while (this.guidanceQueue.length > 0) {
      const guidance = this.guidanceQueue.shift();
      
      // Apply guidance based on type
      if (guidance.targetCampaign) {
        const campaign = this.campaigns.get(guidance.targetCampaign);
        if (campaign) {
          campaign.humanGuidance = guidance.guidance;
          campaign.priority = 'high';
        }
      }
      
      this.logger?.info('✅ Guidance processed', {
        source: guidance.source
      });
    }
  }

  /**
   * Export state
   */
  export() {
    return {
      campaigns: Array.from(this.campaigns.entries()),
      narratives: Array.from(this.goalNarratives.entries()),
      completedNarratives: Array.from(this.completedNarratives.entries()).slice(-100), // Last 100
      memoryBridges: Array.from(this.memoryBridges.entries()),
      stats: this.stats,
      nextCampaignId: this.nextCampaignId
    };
  }

  /**
   * Import state
   */
  import(data) {
    if (data.campaigns) {
      this.campaigns = new Map(data.campaigns);
    }
    if (data.narratives) {
      this.goalNarratives = new Map(data.narratives);
    }
    if (data.completedNarratives) {
      this.completedNarratives = new Map(data.completedNarratives);
    }
    if (data.memoryBridges) {
      this.memoryBridges = new Map(data.memoryBridges);
    }
    if (data.stats) {
      this.stats = data.stats;
    }
    if (data.nextCampaignId) {
      this.nextCampaignId = data.nextCampaignId;
    }
    
    this.logger?.info('Goal curator state imported', {
      campaigns: this.campaigns.size,
      narratives: this.goalNarratives.size,
      completedNarratives: this.completedNarratives.size
    });
  }
}

module.exports = { GoalCurator };
