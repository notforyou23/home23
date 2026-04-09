/**
 * Evaluation Framework for Cosmo
 * Inspired by OpenAI AgentKit evaluation platform
 * Systematic measurement of agent performance, goal effectiveness, and system health
 */

const fs = require('fs').promises;
const path = require('path');

class EvaluationFramework {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Metrics storage
    this.metrics = {
      goals: {
        created: 0,
        pursued: 0,
        completed: 0,
        abandoned: 0,
        synthesized: 0,
        conversionRate: 0.0, // pursued/created
        completionRate: 0.0, // completed/pursued
        synthesisRate: 0.0, // synthesized/completed
        avgCyclesToCompletion: 0,
        avgValueScore: 0.0
      },
      agents: {
        byType: {}, // type -> { spawned, completed, failed, avgDuration, avgQAScore }
        totalSpawned: 0,
        totalCompleted: 0,
        totalFailed: 0,
        concurrencyUtilization: 0.0,
        coordinationScore: 0.0 // How well agents build on each other's work
      },
      memory: {
        totalNodes: 0,
        totalEdges: 0,
        avgClusterSize: 0,
        retrievalRelevance: 0.0, // How often retrieved memories are useful
        utilizationRate: 0.0, // % of memories accessed in last N cycles
        consolidationEfficiency: 0.0,
        protectedNodesCount: 0
      },
      campaigns: {
        created: 0,
        active: 0,
        completed: 0,
        synthesized: 0,
        avgDuration: 0,
        avgGoalsPerCampaign: 0,
        successRate: 0.0, // completed with synthesis / total completed
        coherenceScore: 0.0 // How well goals within campaigns relate
      },
      cognitive: {
        diversityScore: 0.0, // Theme distribution
        noveltyRate: 0.0, // % of thoughts producing new insights
        qaPassRate: 0.0,
        avgReasoningQuality: 0.0,
        coordinatorEffectiveness: 0.0
      },
      system: {
        cyclesRun: 0,
        totalThoughts: 0,
        avgCycleTime: 0,
        errorRate: 0.0,
        costPerCycle: 0.0,
        costPerInsight: 0.0
      },
      consistency: {
        reviewsTriggered: 0,
        avgDivergence: 0,
        lastReview: null
      }
    };
    
    // Time series data for trends
    this.timeSeries = {
      goalConversion: [], // [{cycle, rate}, ...]
      agentEffectiveness: [],
      diversityTrend: [],
      memoryGrowth: [],
      qaScores: []
    };
    
    // Detailed tracking
    this.goalTracking = new Map(); // goalId -> detailed metrics
    this.agentTracking = new Map(); // agentId -> detailed metrics
    this.campaignTracking = new Map(); // campaignId -> detailed metrics
    
    // Evaluation history
    this.evaluationHistory = [];
    
    this.metricsFile = path.join(
      config.logsDir || 'runtime',
      'evaluation-metrics.json'
    );
    
    this.timeSeriesFile = path.join(
      config.logsDir || 'runtime',
      'evaluation-timeseries.jsonl'
    );

    this.branchesFile = path.join(
      config.logsDir || 'runtime',
      'evaluation-branches.jsonl'
    );
  }
  
  async initialize() {
    // Load existing metrics if available
    try {
      const data = await fs.readFile(this.metricsFile, 'utf-8');
      const loaded = JSON.parse(data);
      this.metrics = loaded.metrics || this.metrics;
      this.timeSeries = loaded.timeSeries || this.timeSeries;
      
      this.logger.info('Evaluation framework loaded existing metrics', {
        cycles: this.metrics.system.cyclesRun,
        goals: this.metrics.goals.created,
        agents: this.metrics.agents.totalSpawned
      });
    } catch (error) {
      this.logger.info('Evaluation framework starting fresh (no existing metrics)');
    }
  }
  
  /**
   * Track goal lifecycle events
   */
  trackGoalCreated(goalId, goal) {
    this.metrics.goals.created++;
    this.goalTracking.set(goalId, {
      id: goalId,
      created: Date.now(),
      cycleCreated: this.metrics.system.cyclesRun,
      description: goal.description,
      priority: goal.priority,
      pursuitCount: 0,
      agentsSpawned: [],
      qaScores: [],
      memoryNodesCreated: 0,
      valueAssessment: null,
      status: 'active'
    });
  }
  
  trackGoalPursued(goalId, agentType, agentId) {
    this.metrics.goals.pursued++;
    
    const tracking = this.goalTracking.get(goalId);
    if (tracking) {
      tracking.pursuitCount++;
      tracking.agentsSpawned.push({ agentType, agentId, timestamp: Date.now() });
      tracking.lastPursued = Date.now();
    }
    
    this._updateGoalConversionRate();
  }
  
  trackGoalCompleted(goalId, completionData = {}) {
    this.metrics.goals.completed++;
    
    const tracking = this.goalTracking.get(goalId);
    if (tracking) {
      tracking.status = 'completed';
      tracking.completed = Date.now();
      tracking.cycleCompleted = this.metrics.system.cyclesRun;
      tracking.cyclesToCompletion = tracking.cycleCompleted - tracking.cycleCreated;
      tracking.completionData = completionData;
      
      // Update averages
      this._updateGoalAverages();
    }
    
    this._updateGoalCompletionRate();
  }
  
  trackGoalSynthesized(goalId, synthesisData) {
    this.metrics.goals.synthesized++;
    
    const tracking = this.goalTracking.get(goalId);
    if (tracking) {
      tracking.status = 'synthesized';
      tracking.synthesized = Date.now();
      tracking.synthesisData = synthesisData;
    }
    
    this._updateGoalSynthesisRate();
  }

  async trackBranchMetadata(branchSnapshot) {
    if (!branchSnapshot || !Array.isArray(branchSnapshot.branches)) {
      return;
    }

    const payload = {
      cycle: branchSnapshot.cycle,
      timestamp: branchSnapshot.timestamp || new Date().toISOString(),
      selectedBranchId: branchSnapshot.selectedBranchId || null,
      reward: branchSnapshot.reward || 0,
      branches: branchSnapshot.branches
    };

    try {
      await fs.appendFile(this.branchesFile, JSON.stringify(payload) + '\n');
    } catch (error) {
      this.logger?.warn('Failed to append branch metadata', {
        error: error.message
      });
    }
  }

  trackConsistencyReview(entry = {}) {
    const { cycle = null, divergence = 0, branchesAnalyzed = 0, agentId = null } = entry;

    const metrics = this.metrics.consistency;
    metrics.reviewsTriggered += 1;
    const count = metrics.reviewsTriggered;
    metrics.avgDivergence = ((metrics.avgDivergence * (count - 1)) + divergence) / count;
    metrics.lastReview = {
      cycle,
      divergence,
      branchesAnalyzed,
      agentId,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Track agent performance
   */
  trackAgentSpawned(agentId, agentType, goalId) {
    this.metrics.agents.totalSpawned++;
    
    if (!this.metrics.agents.byType[agentType]) {
      this.metrics.agents.byType[agentType] = {
        spawned: 0,
        completed: 0,
        failed: 0,
        avgDuration: 0,
        avgQAScore: 0,
        totalDuration: 0,
        totalQAScore: 0,
        toolUsage: {}
      };
    }
    
    this.metrics.agents.byType[agentType].spawned++;
    
    this.agentTracking.set(agentId, {
      id: agentId,
      type: agentType,
      goalId,
      spawned: Date.now(),
      cycleSpawned: this.metrics.system.cyclesRun,
      toolsCalled: [],
      memoryAccess: [],
      qaScore: null,
      result: null,
      status: 'running'
    });
  }
  
  trackAgentToolUse(agentId, toolName) {
    const tracking = this.agentTracking.get(agentId);
    if (tracking) {
      tracking.toolsCalled.push({ tool: toolName, timestamp: Date.now() });
      
      // Update type-level tool usage
      const typeMetrics = this.metrics.agents.byType[tracking.type];
      if (typeMetrics) {
        typeMetrics.toolUsage[toolName] = (typeMetrics.toolUsage[toolName] || 0) + 1;
      }
    }
  }
  
  trackAgentMemoryAccess(agentId, accessType, relevance = null) {
    const tracking = this.agentTracking.get(agentId);
    if (tracking) {
      tracking.memoryAccess.push({
        type: accessType,
        relevance,
        timestamp: Date.now()
      });
    }
  }
  
  trackAgentCompleted(agentId, result, qaScore = null) {
    this.metrics.agents.totalCompleted++;
    
    const tracking = this.agentTracking.get(agentId);
    if (tracking) {
      tracking.status = 'completed';
      tracking.completed = Date.now();
      tracking.duration = tracking.completed - tracking.spawned;
      tracking.result = result;
      tracking.qaScore = qaScore;
      
      // Update type-level metrics
      const typeMetrics = this.metrics.agents.byType[tracking.type];
      if (typeMetrics) {
        typeMetrics.completed++;
        typeMetrics.totalDuration += tracking.duration;
        typeMetrics.avgDuration = typeMetrics.totalDuration / typeMetrics.completed;
        
        if (qaScore !== null) {
          typeMetrics.totalQAScore += qaScore;
          typeMetrics.avgQAScore = typeMetrics.totalQAScore / typeMetrics.completed;
        }
      }
    }
  }
  
  trackAgentFailed(agentId, error) {
    this.metrics.agents.totalFailed++;
    
    const tracking = this.agentTracking.get(agentId);
    if (tracking) {
      tracking.status = 'failed';
      tracking.error = error;
      tracking.completed = Date.now();
      
      const typeMetrics = this.metrics.agents.byType[tracking.type];
      if (typeMetrics) {
        typeMetrics.failed++;
      }
    }
  }
  
  /**
   * Track campaign metrics
   */
  trackCampaignCreated(campaignId, campaign) {
    this.metrics.campaigns.created++;
    this.metrics.campaigns.active++;
    
    this.campaignTracking.set(campaignId, {
      id: campaignId,
      name: campaign.name,
      created: Date.now(),
      cycleCreated: this.metrics.system.cyclesRun,
      goalIds: campaign.goals.map(g => g.id),
      goalsCompleted: 0,
      agentsSpawned: 0,
      synthesized: false,
      status: 'active'
    });
    
    this._updateCampaignAverages();
  }
  
  trackCampaignCompleted(campaignId, synthesized = false) {
    this.metrics.campaigns.active--;
    this.metrics.campaigns.completed++;
    if (synthesized) {
      this.metrics.campaigns.synthesized++;
    }
    
    const tracking = this.campaignTracking.get(campaignId);
    if (tracking) {
      tracking.status = 'completed';
      tracking.completed = Date.now();
      tracking.duration = tracking.completed - tracking.created;
      tracking.synthesized = synthesized;
    }
    
    this._updateCampaignSuccessRate();
  }
  
  /**
   * Track memory quality
   */
  trackMemoryState(memorySnapshot) {
    this.metrics.memory.totalNodes = memorySnapshot.nodes || 0;
    this.metrics.memory.totalEdges = memorySnapshot.edges || 0;
    this.metrics.memory.avgClusterSize = memorySnapshot.avgClusterSize || 0;
    this.metrics.memory.protectedNodesCount = memorySnapshot.protectedNodes || 0;
  }
  
  trackMemoryRetrieval(relevance) {
    // Update rolling average of retrieval relevance
    const alpha = 0.1; // Exponential moving average factor
    this.metrics.memory.retrievalRelevance = 
      alpha * relevance + (1 - alpha) * this.metrics.memory.retrievalRelevance;
  }
  
  /**
   * Track cognitive metrics
   */
  trackQAValidation(passed, score) {
    const total = this.metrics.system.cyclesRun;
    const alpha = 0.1;
    
    this.metrics.cognitive.qaPassRate = 
      alpha * (passed ? 1 : 0) + (1 - alpha) * this.metrics.cognitive.qaPassRate;
    
    this.timeSeries.qaScores.push({
      cycle: total,
      score,
      passed,
      timestamp: Date.now()
    });
  }
  
  trackDiversity(diversityScore) {
    this.metrics.cognitive.diversityScore = diversityScore;
    
    this.timeSeries.diversityTrend.push({
      cycle: this.metrics.system.cyclesRun,
      score: diversityScore,
      timestamp: Date.now()
    });
  }
  
  /**
   * Track system-level metrics
   */
  trackCycleComplete(cycleTime, thoughtCount, cost = 0) {
    this.metrics.system.cyclesRun++;
    this.metrics.system.totalThoughts += thoughtCount;
    
    // Update averages
    const alpha = 0.1;
    this.metrics.system.avgCycleTime = 
      alpha * cycleTime + (1 - alpha) * this.metrics.system.avgCycleTime;
    
    this.metrics.system.costPerCycle = 
      alpha * cost + (1 - alpha) * this.metrics.system.costPerCycle;
    
    // Update time series
    this._recordTimeSeriesSnapshot();
  }
  
  /**
   * Generate comprehensive evaluation report
   */
  async generateReport(cycle) {
    const report = {
      cycle,
      timestamp: Date.now(),
      summary: this._generateSummary(),
      metrics: { ...this.metrics },
      insights: this._generateInsights(),
      recommendations: this._generateRecommendations(),
      trends: this._analyzeTrends()
    };
    
    this.evaluationHistory.push({
      cycle,
      timestamp: report.timestamp,
      summary: report.summary
    });
    
    // Save report
    const reportPath = path.join(
      this.config.logsDir || 'runtime',
      'evaluation',
      `eval_report_cycle_${cycle}.json`
    );
    
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    return report;
  }
  
  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    return {
      ...this.metrics,
      lastUpdated: Date.now()
    };
  }
  
  /**
   * Get agent type effectiveness ranking
   */
  getAgentEffectivenessRanking() {
    const types = Object.entries(this.metrics.agents.byType)
      .map(([type, metrics]) => ({
        type,
        effectiveness: this._calculateAgentEffectiveness(metrics),
        ...metrics
      }))
      .sort((a, b) => b.effectiveness - a.effectiveness);
    
    return types;
  }
  
  /**
   * Get goals with low completion likelihood
   */
  getStuckGoals() {
    const stuck = [];
    const currentCycle = this.metrics.system.cyclesRun;
    
    for (const [goalId, tracking] of this.goalTracking.entries()) {
      if (tracking.status === 'active') {
        const age = currentCycle - tracking.cycleCreated;
        const pursuitCount = tracking.pursuitCount;
        
        // Heuristic: goal is stuck if old, pursued multiple times, but not completed
        if (age > 50 && pursuitCount >= 3) {
          stuck.push({
            goalId,
            age,
            pursuitCount,
            lastPursued: tracking.lastPursued,
            description: tracking.description
          });
        }
      }
    }
    
    return stuck.sort((a, b) => b.age - a.age);
  }
  
  /**
   * Private helper methods
   */
  _updateGoalConversionRate() {
    if (this.metrics.goals.created > 0) {
      this.metrics.goals.conversionRate = 
        this.metrics.goals.pursued / this.metrics.goals.created;
    }
  }
  
  _updateGoalCompletionRate() {
    if (this.metrics.goals.pursued > 0) {
      this.metrics.goals.completionRate = 
        this.metrics.goals.completed / this.metrics.goals.pursued;
    }
  }
  
  _updateGoalSynthesisRate() {
    if (this.metrics.goals.completed > 0) {
      this.metrics.goals.synthesisRate = 
        this.metrics.goals.synthesized / this.metrics.goals.completed;
    }
  }
  
  _updateGoalAverages() {
    let totalCycles = 0;
    let count = 0;
    
    for (const tracking of this.goalTracking.values()) {
      if (tracking.cyclesToCompletion) {
        totalCycles += tracking.cyclesToCompletion;
        count++;
      }
    }
    
    if (count > 0) {
      this.metrics.goals.avgCyclesToCompletion = totalCycles / count;
    }
  }
  
  _updateCampaignAverages() {
    if (this.metrics.campaigns.created > 0) {
      let totalGoals = 0;
      for (const tracking of this.campaignTracking.values()) {
        totalGoals += tracking.goalIds.length;
      }
      this.metrics.campaigns.avgGoalsPerCampaign = 
        totalGoals / this.metrics.campaigns.created;
    }
  }
  
  _updateCampaignSuccessRate() {
    if (this.metrics.campaigns.completed > 0) {
      this.metrics.campaigns.successRate = 
        this.metrics.campaigns.synthesized / this.metrics.campaigns.completed;
    }
  }
  
  _calculateAgentEffectiveness(metrics) {
    const completionRate = metrics.spawned > 0 ? metrics.completed / metrics.spawned : 0;
    const qaScore = metrics.avgQAScore || 0;
    const failureRate = metrics.spawned > 0 ? metrics.failed / metrics.spawned : 0;
    
    // Weighted effectiveness score
    return (completionRate * 0.4) + (qaScore * 0.4) - (failureRate * 0.2);
  }
  
  _generateSummary() {
    return {
      totalCycles: this.metrics.system.cyclesRun,
      goalConversionRate: (this.metrics.goals.conversionRate * 100).toFixed(1) + '%',
      agentSuccessRate: this.metrics.agents.totalSpawned > 0 
        ? ((this.metrics.agents.totalCompleted / this.metrics.agents.totalSpawned) * 100).toFixed(1) + '%'
        : 'N/A',
      memoryNodes: this.metrics.memory.totalNodes,
      activeCampaigns: this.metrics.campaigns.active,
      qaPassRate: (this.metrics.cognitive.qaPassRate * 100).toFixed(1) + '%',
      diversityScore: this.metrics.cognitive.diversityScore.toFixed(2)
    };
  }
  
  _generateInsights() {
    const insights = [];
    
    // Goal insights
    if (this.metrics.goals.conversionRate < 0.3) {
      insights.push({
        type: 'warning',
        category: 'goals',
        message: 'Low goal pursuit rate - many goals created but not pursued',
        metric: 'conversionRate',
        value: this.metrics.goals.conversionRate
      });
    }
    
    // Agent insights
    const ranking = this.getAgentEffectivenessRanking();
    if (ranking.length > 0) {
      const best = ranking[0];
      const worst = ranking[ranking.length - 1];
      
      insights.push({
        type: 'info',
        category: 'agents',
        message: `Most effective agent type: ${best.type}`,
        metric: 'effectiveness',
        value: best.effectiveness
      });
      
      if (worst.effectiveness < 0.5) {
        insights.push({
          type: 'warning',
          category: 'agents',
          message: `Low effectiveness for ${worst.type} agents`,
          metric: 'effectiveness',
          value: worst.effectiveness
        });
      }
    }
    
    // Diversity insights
    if (this.metrics.cognitive.diversityScore < 0.6) {
      insights.push({
        type: 'warning',
        category: 'cognitive',
        message: 'Low diversity - system may be in echo chamber',
        metric: 'diversityScore',
        value: this.metrics.cognitive.diversityScore
      });
    }
    
    // Campaign insights
    if (this.metrics.campaigns.successRate > 0 && this.metrics.campaigns.successRate < 0.5) {
      insights.push({
        type: 'warning',
        category: 'campaigns',
        message: 'Low campaign synthesis rate - campaigns completing without synthesis',
        metric: 'successRate',
        value: this.metrics.campaigns.successRate
      });
    }
    
    return insights;
  }
  
  _generateRecommendations() {
    const recommendations = [];
    
    // Based on goal conversion
    if (this.metrics.goals.conversionRate < 0.25) {
      recommendations.push({
        priority: 'high',
        category: 'goals',
        action: 'Increase agent spawning frequency or reduce goal creation rate',
        reason: 'Many goals being created but not pursued'
      });
    }
    
    // Based on agent performance
    const ranking = this.getAgentEffectivenessRanking();
    if (ranking.length > 0) {
      const underperforming = ranking.filter(a => a.effectiveness < 0.4);
      if (underperforming.length > 0) {
        recommendations.push({
          priority: 'medium',
          category: 'agents',
          action: `Review prompts/tools for: ${underperforming.map(a => a.type).join(', ')}`,
          reason: 'Low effectiveness scores for these agent types'
        });
      }
    }
    
    // Based on diversity
    if (this.metrics.cognitive.diversityScore < 0.5) {
      recommendations.push({
        priority: 'high',
        category: 'cognitive',
        action: 'Increase exploration mode frequency or mandate new domains',
        reason: 'Diversity score below healthy threshold'
      });
    }
    
    // Based on stuck goals
    const stuck = this.getStuckGoals();
    if (stuck.length > 5) {
      recommendations.push({
        priority: 'medium',
        category: 'goals',
        action: 'Archive or reframe stuck goals',
        reason: `${stuck.length} goals pursued multiple times without completion`
      });
    }
    
    return recommendations;
  }
  
  _analyzeTrends() {
    const trends = {
      goalConversion: this._calculateTrend(this.timeSeries.goalConversion, 'rate'),
      diversity: this._calculateTrend(this.timeSeries.diversityTrend, 'score'),
      qaPerformance: this._calculateTrend(this.timeSeries.qaScores, 'score')
    };
    
    return trends;
  }
  
  _calculateTrend(series, metric) {
    if (series.length < 2) return 'insufficient_data';
    
    // Simple linear regression on last 10 points
    const recent = series.slice(-10);
    const n = recent.length;
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    recent.forEach((point, i) => {
      const x = i;
      const y = point[metric];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    
    if (slope > 0.01) return 'improving';
    if (slope < -0.01) return 'declining';
    return 'stable';
  }
  
  _recordTimeSeriesSnapshot() {
    const snapshot = {
      cycle: this.metrics.system.cyclesRun,
      timestamp: Date.now(),
      goalConversion: this.metrics.goals.conversionRate,
      agentSuccess: this.metrics.agents.totalSpawned > 0 
        ? this.metrics.agents.totalCompleted / this.metrics.agents.totalSpawned 
        : 0,
      diversity: this.metrics.cognitive.diversityScore,
      memoryNodes: this.metrics.memory.totalNodes,
      qaPassRate: this.metrics.cognitive.qaPassRate
    };
    
    // Append to time series file (async, don't wait)
    this._appendTimeSeriesAsync(snapshot);
  }
  
  async _appendTimeSeriesAsync(snapshot) {
    try {
      await fs.appendFile(
        this.timeSeriesFile,
        JSON.stringify(snapshot) + '\n'
      );
    } catch (error) {
      // Silent fail - don't disrupt operation for logging
    }
  }
  
  /**
   * Persist metrics to disk
   */
  async save() {
    try {
      const data = {
        metrics: this.metrics,
        timeSeries: this.timeSeries,
        evaluationHistory: this.evaluationHistory.slice(-20), // Keep last 20
        lastSaved: Date.now()
      };
      
      await fs.writeFile(this.metricsFile, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.error('Failed to save evaluation metrics', { error: error.message });
    }
  }
}

module.exports = { EvaluationFramework };
