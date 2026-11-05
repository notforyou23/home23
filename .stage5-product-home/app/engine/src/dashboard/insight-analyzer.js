const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const path = require('path');
const { StateCompression } = require('../core/state-compression');

/**
 * Intelligent Log Analyzer
 * 
 * Surfaces the most interesting cognitive moments from Cosmo's logs:
 * - High-novelty thoughts
 * - Creative breakthroughs
 * - Agent discoveries
 * - Strategic insights
 * - Cross-domain connections
 */
class InsightAnalyzer {
  constructor(logsDir, logger) {
    this.logsDir = logsDir;
    this.logger = logger;
  }

  /**
   * Main analysis - find the most interesting content
   */
  async analyze(options = {}) {
    const {
      limit = 20,
      includeThoughts = true,
      includeAgents = true,
      includeCoordinator = true,
      includeMemory = true,
      minSurprise = 0.5,
      minActivation = 0.7
    } = options;

    this.logger?.info('Starting intelligent log analysis...');

    const insights = {
      highSurpriseThoughts: [],
      webEnhancedThoughts: [],
      reasoningTraces: [],
      agentBreakthroughs: [],
      strategicInsights: [],
      highActivationNodes: [],
      crossDomainConcepts: [],
      novelGoals: [],
      timestamp: new Date()
    };

    try {
      // Analyze thoughts
      if (includeThoughts) {
        const thoughts = await this.loadAllThoughts();
        insights.highSurpriseThoughts = this.findHighSurpriseThoughts(thoughts, minSurprise, limit);
        insights.webEnhancedThoughts = this.findWebEnhancedThoughts(thoughts, limit);
        insights.reasoningTraces = this.findDeepReasoningThoughts(thoughts, limit);
        insights.novelGoals = this.findGoalGenesisThoughts(thoughts, limit);
      }

      // Analyze memory network
      if (includeMemory) {
        const state = await this.loadState();
        if (state.memory) {
          insights.highActivationNodes = this.findHighActivationNodes(state.memory, minActivation, limit);
          insights.crossDomainConcepts = this.findCrossDomainConnections(state.memory, limit);
        }
      }

      // Analyze agent findings
      if (includeAgents) {
        insights.agentBreakthroughs = await this.findAgentBreakthroughs(limit);
      }

      // Analyze coordinator insights
      if (includeCoordinator) {
        insights.strategicInsights = await this.findStrategicInsights(limit);
      }

      // Calculate overall statistics
      insights.stats = this.calculateStats(insights);

      this.logger?.info('Analysis complete', {
        highSurprise: insights.highSurpriseThoughts.length,
        webEnhanced: insights.webEnhancedThoughts.length,
        agentFindings: insights.agentBreakthroughs.length,
        strategicInsights: insights.strategicInsights.length
      });

      return insights;
    } catch (error) {
      this.logger?.error('Analysis failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Load all thoughts from JSONL
   */
  async loadAllThoughts() {
    const thoughtsPath = path.join(this.logsDir, 'thoughts.jsonl');
    const thoughts = [];

    try {
      const fileStream = createReadStream(thoughtsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            thoughts.push(JSON.parse(line));
          } catch (e) {
            // Skip malformed lines
          }
        }
      }
    } catch (error) {
      this.logger?.warn('Could not load thoughts', { error: error.message });
    }

    return thoughts;
  }

  /**
   * Load system state
   */
  async loadState() {
    const statePath = path.join(this.logsDir, 'state.json');
    try {
      return await StateCompression.loadCompressed(statePath);
    } catch (error) {
      this.logger?.warn('Could not load state', { error: error.message });
      return {};
    }
  }

  /**
   * Find thoughts with high surprise values
   */
  findHighSurpriseThoughts(thoughts, minSurprise, limit) {
    return thoughts
      .filter(t => t.surprise && t.surprise >= minSurprise)
      .sort((a, b) => (b.surprise || 0) - (a.surprise || 0))
      .slice(0, limit)
      .map(t => ({
        cycle: t.cycle,
        role: t.role,
        thought: t.thought,
        surprise: t.surprise,
        reasoning: t.reasoning?.substring(0, 300),
        timestamp: t.timestamp,
        score: t.surprise * 100,
        category: 'High Surprise'
      }));
  }

  /**
   * Find thoughts that used web search
   */
  findWebEnhancedThoughts(thoughts, limit) {
    return thoughts
      .filter(t => t.usedWebSearch)
      .sort((a, b) => (b.surprise || 0) - (a.surprise || 0))
      .slice(0, limit)
      .map(t => ({
        cycle: t.cycle,
        role: t.role,
        thought: t.thought,
        surprise: t.surprise,
        reasoning: t.reasoning?.substring(0, 300),
        timestamp: t.timestamp,
        score: (t.surprise || 0.5) * 100,
        category: 'Web-Enhanced'
      }));
  }

  /**
   * Find thoughts with deep reasoning traces
   */
  findDeepReasoningThoughts(thoughts, limit) {
    return thoughts
      .filter(t => t.reasoning && t.reasoning.length > 500)
      .sort((a, b) => (b.reasoning?.length || 0) - (a.reasoning?.length || 0))
      .slice(0, limit)
      .map(t => ({
        cycle: t.cycle,
        role: t.role,
        thought: t.thought,
        reasoning: t.reasoning?.substring(0, 300),
        reasoningLength: t.reasoning?.length,
        timestamp: t.timestamp,
        score: Math.min(100, (t.reasoning?.length || 0) / 50),
        category: 'Deep Reasoning'
      }));
  }

  /**
   * Find thoughts that generated new goals
   */
  findGoalGenesisThoughts(thoughts, limit) {
    return thoughts
      .filter(t => t.goalsAutoCaptured && t.goalsAutoCaptured > 0)
      .sort((a, b) => (b.goalsAutoCaptured || 0) - (a.goalsAutoCaptured || 0))
      .slice(0, limit)
      .map(t => ({
        cycle: t.cycle,
        role: t.role,
        thought: t.thought,
        goalsGenerated: t.goalsAutoCaptured,
        timestamp: t.timestamp,
        score: t.goalsAutoCaptured * 20,
        category: 'Goal Genesis'
      }));
  }

  /**
   * Find memory nodes with high activation
   */
  findHighActivationNodes(memory, minActivation, limit) {
    if (!memory.nodes) return [];

    return memory.nodes
      .filter(n => n.activation && n.activation >= minActivation)
      .sort((a, b) => (b.activation || 0) - (a.activation || 0))
      .slice(0, limit)
      .map(n => ({
        id: n.id,
        concept: n.concept,
        activation: n.activation,
        accessCount: n.accessCount,
        cluster: n.cluster,
        tag: n.tag,
        created: n.created,
        score: n.activation * 100,
        category: 'High Activation Memory'
      }));
  }

  /**
   * Find concepts that bridge multiple clusters (cross-domain)
   */
  findCrossDomainConnections(memory, limit) {
    if (!memory.nodes || !memory.edges) return [];

    // For each node, count how many different clusters it connects to
    const nodeToClusters = new Map();

    memory.edges.forEach(edge => {
      const sourceNode = memory.nodes.find(n => n.id === edge.source);
      const targetNode = memory.nodes.find(n => n.id === edge.target);

      if (sourceNode && targetNode && sourceNode.cluster !== targetNode.cluster) {
        // Source node bridges to target cluster
        if (!nodeToClusters.has(sourceNode.id)) {
          nodeToClusters.set(sourceNode.id, { node: sourceNode, clusters: new Set() });
        }
        nodeToClusters.get(sourceNode.id).clusters.add(targetNode.cluster);

        // Target node bridges to source cluster
        if (!nodeToClusters.has(targetNode.id)) {
          nodeToClusters.set(targetNode.id, { node: targetNode, clusters: new Set() });
        }
        nodeToClusters.get(targetNode.id).clusters.add(sourceNode.cluster);
      }
    });

    // Sort by number of clusters connected
    return Array.from(nodeToClusters.values())
      .filter(item => item.clusters.size > 1)
      .sort((a, b) => b.clusters.size - a.clusters.size)
      .slice(0, limit)
      .map(item => ({
        id: item.node.id,
        concept: item.node.concept,
        activation: item.node.activation,
        clustersConnected: item.clusters.size,
        ownCluster: item.node.cluster,
        tag: item.node.tag,
        score: item.clusters.size * 30 + (item.node.activation || 0) * 20,
        category: 'Cross-Domain Connector'
      }));
  }

  /**
   * Find breakthrough agent findings
   */
  async findAgentBreakthroughs(limit) {
    const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
    const breakthroughs = [];

    try {
      // Get current run start time to filter old agents
      const state = await this.loadState();
      const currentCycle = state.cycleCount || 0;
      // Estimate run start: current time - (cycle * ~4 minutes)
      const runStartTime = state.timestamp ? new Date(state.timestamp).getTime() - (currentCycle * 240000) : 0;
      
      const fileStream = createReadStream(resultsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const result = JSON.parse(line);
            
            // FILTER: Only agents from current run
            if (runStartTime > 0 && result.endTime) {
              const agentTime = new Date(result.endTime).getTime();
              if (agentTime < runStartTime) {
                continue; // Skip old run agents
              }
            }
            
            if (result.agentType && result.results) {
              const findings = result.results.filter(r => r.type === 'finding');
              const insights = result.results.filter(r => r.type === 'insight');

              if (findings.length > 0 || insights.length > 0) {
                breakthroughs.push({
                  agentId: result.agentId,
                  agentType: result.agentType,
                  goal: result.mission?.description,
                  findings: findings, // Include ALL findings, not just first 3
                  insights: insights, // Include ALL insights, not just first 3
                  totalFindings: findings.length,
                  totalInsights: insights.length,
                  duration: result.durationFormatted,
                  timestamp: result.endTime,
                  score: findings.length * 10 + insights.length * 15,
                  category: 'Agent Breakthrough'
                });
              }
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      }
    } catch (error) {
      this.logger?.warn('Could not load agent results', { error: error.message });
    }

    return breakthroughs
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Find strategic insights from coordinator
   */
  async findStrategicInsights(limit) {
    const coordinatorDir = path.join(this.logsDir, 'coordinator');
    const insights = [];

    try {
      // Get current cycle to filter old reports
      const state = await this.loadState();
      const currentCycle = state.cycleCount || 0;
      
      const files = await fs.readdir(coordinatorDir);
      const reviewFiles = files.filter(f => f.startsWith('review_') && f.endsWith('.md'));

      // Read recent review files - ONLY from current run
      for (const file of reviewFiles) {
        try {
          const cycle = parseInt(file.match(/review_(\d+)/)?.[1]);
          
          // FILTER: Only reviews from current run (cycle <= currentCycle)
          if (cycle > currentCycle) {
            continue; // Skip reviews from previous/future runs
          }
          
          const content = await fs.readFile(path.join(coordinatorDir, file), 'utf8');

          // Extract key sections
          const keyInsights = this.extractSection(content, 'KEY INSIGHTS');
          const directives = this.extractSection(content, 'STRATEGIC DIRECTIVES');
          const priorities = this.extractSection(content, 'TOP.*GOALS.*TO PRIORITIZE');

          insights.push({
            cycle: cycle,
            file: file,
            keyInsights: keyInsights, // Include ALL key insights
            directives: directives, // Include ALL directives
            priorities: priorities, // Include ALL priorities
            score: keyInsights.length * 10 + directives.length * 8,
            category: 'Strategic Insight'
          });
        } catch (e) {
          // Skip unreadable files
        }
      }
      
      // Sort by cycle and take most recent
      insights.sort((a, b) => b.cycle - a.cycle);
    } catch (error) {
      this.logger?.warn('Could not load coordinator insights', { error: error.message });
    }

    return insights.slice(0, limit)
      .sort((a, b) => b.cycle - a.cycle)
      .slice(0, limit);
  }

  /**
   * Extract a section from markdown
   */
  extractSection(content, sectionRegex) {
    const regex = new RegExp(`## ${sectionRegex}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
    const match = content.match(regex);
    if (!match) return [];

    // Extract bullet points or numbered lists
    const items = match[1]
      .split('\n')
      .filter(line => line.trim().match(/^[-*\d.]/))
      .map(line => line.replace(/^[-*\d.]\s*/, '').trim())
      .filter(line => line.length > 10);

    return items;
  }

  /**
   * Calculate overall statistics
   */
  calculateStats(insights) {
    return {
      totalInsights: Object.values(insights)
        .filter(v => Array.isArray(v))
        .reduce((sum, arr) => sum + arr.length, 0),
      categories: {
        highSurprise: insights.highSurpriseThoughts.length,
        webEnhanced: insights.webEnhancedThoughts.length,
        deepReasoning: insights.reasoningTraces.length,
        goalGenesis: insights.novelGoals.length,
        highActivation: insights.highActivationNodes.length,
        crossDomain: insights.crossDomainConcepts.length,
        agentBreakthroughs: insights.agentBreakthroughs.length,
        strategicInsights: insights.strategicInsights.length
      },
      topScores: this.getTopScores(insights)
    };
  }

  /**
   * Get items with highest scores across all categories
   */
  getTopScores(insights) {
    const allItems = [
      ...insights.highSurpriseThoughts,
      ...insights.webEnhancedThoughts,
      ...insights.reasoningTraces,
      ...insights.novelGoals,
      ...insights.highActivationNodes,
      ...insights.crossDomainConcepts,
      ...insights.agentBreakthroughs,
      ...insights.strategicInsights
    ];

    return allItems
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 10);
  }
}

module.exports = { InsightAnalyzer };

