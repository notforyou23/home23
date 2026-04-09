const { BaseAgent } = require('./base-agent');
const { parseWithFallback } = require('../core/json-repair');

/**
 * IntegrationAgent - Cross-agent pattern discovery and meta-insight specialist
 * 
 * Purpose:
 * - Finds patterns across disparate agent findings
 * - Identifies contradictions and inconsistencies
 * - Synthesizes meta-insights from multiple perspectives
 * - Maps the knowledge landscape
 * 
 * Use Cases:
 * - After multiple agents complete, find what connects their work
 * - Identify emergent patterns not visible to individual agents
 * - Detect contradictions requiring resolution
 * - Generate system-level insights about knowledge state
 * 
 * Different from SynthesisAgent:
 * - Synthesis: Creates reports from findings
 * - Integration: Finds CONNECTIONS and PATTERNS across findings
 */
class IntegrationAgent extends BaseAgent {
  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## IntegrationAgent Behavioral Specification

You find patterns and contradictions across recent agent work. Synthesize cross-agent insights.
Output: integration matrix showing agreements, contradictions, and novel connections.

### Operating Principles
- Patterns must span at least two agent types to qualify as cross-cutting
- Contradictions are high-value findings — flag severity and suggest resolution paths
- Use the full knowledge cluster landscape to identify blind spots between clusters
- Self-discover all agent types from memory rather than hardcoding a list
- Recent work (4-hour lookback window) gets priority but older patterns still matter
- Meta-insights should be about the SYSTEM'S knowledge state, not the topic itself
- Track which memory nodes contributed to each pattern for provenance
- Knowledge landscape summaries feed coordinators — be structured and quantitative
- Hot topic analysis reveals focus concentration — recommend broader exploration when warranted
- Don't duplicate what SynthesisAgent does: you find CONNECTIONS, not write reports`;
  }

  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.patterns = [];
    this.contradictions = [];
    this.metaInsights = [];
  }

  /**
   * Main execution logic - GENERIC integration across all memory
   */
  async execute() {
    this.logger.info('🔗 IntegrationAgent: Starting integration mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    }, 3);

    const preFlightData = await this.gatherPreFlightContext();

    await this.reportProgress(5, 'Scanning knowledge landscape');

    // STEP 1: Get complete knowledge landscape using clusters
    const clusters = await this.getKnowledgeClusters();
    this.logger.info('🗺️  Knowledge landscape mapped', {
      totalClusters: clusters.size,
      totalNodes: this.memory.nodes.size
    });

    // STEP 2: Aggregate recent work from ALL agent types (self-discovering)
    const agentWork = await this.aggregateAgentInsights(
      null, // Discovery all types
      14400000 // Last 4 hours
    );

    const totalInsights = Object.values(agentWork).reduce((sum, type) => sum + (type.count || 0), 0);
    this.logger.info('🤝 Recent agent activity aggregated', {
      typesFound: Object.keys(agentWork),
      total: totalInsights
    });

    if (totalInsights === 0) {
      this.logger.info('ℹ️  No recent agent work to integrate - system may be in initial state');
      return {
        success: true,
        patternsFound: 0,
        contradictions: 0,
        metaInsights: 0
      };
    }

    await this.reportProgress(20, `Analyzing ${totalInsights} agent insights`);

    // STEP 3: Identify cross-cutting patterns using spreading activation
    await this.reportProgress(30, 'Discovering patterns across findings');
    const patterns = await this.identifyPatterns(agentWork, clusters);
    this.patterns = patterns;

    await this.reportProgress(50, `Found ${patterns.length} patterns`);

    // STEP 4: Detect contradictions
    await this.reportProgress(60, 'Checking for contradictions');
    const contradictions = await this.detectContradictions(agentWork);
    this.contradictions = contradictions;

    await this.reportProgress(70, `Found ${contradictions.length} contradictions`);

    // STEP 5: Generate meta-insights
    await this.reportProgress(80, 'Generating meta-insights');
    const metaInsights = await this.generateMetaInsights(patterns, contradictions, clusters);
    this.metaInsights = metaInsights;

    await this.reportProgress(90, 'Storing integration results');

    // STEP 6: Store results in memory
    // Store each pattern
    for (const pattern of patterns) {
      await this.addFinding(
        JSON.stringify(pattern),
        'cross_agent_pattern'
      );
    }

    // Store contradictions (important to track!)
    for (const contradiction of contradictions) {
      await this.addInsight(
        `CONTRADICTION DETECTED: ${contradiction.description}`,
        'contradiction'
      );
    }

    // Store meta-insights
    for (const metaInsight of metaInsights) {
      await this.addInsight(metaInsight, 'meta_insight');
    }

    // Store knowledge landscape summary
    const landscapeSummary = this.createLandscapeSummary(clusters, agentWork);
    await this.addFinding(
      JSON.stringify(landscapeSummary),
      'knowledge_landscape'
    );

    await this.reportProgress(100, 'Integration complete');

    this.logger.info('✅ IntegrationAgent: Mission complete', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      patternsFound: patterns.length,
      contradictions: contradictions.length,
      metaInsights: metaInsights.length
    }, 3);

    return {
      success: true,
      patternsFound: patterns.length,
      contradictions: contradictions.length,
      metaInsights: metaInsights.length,
      clustersAnalyzed: clusters.size
    };
  }

  /**
   * Identify cross-cutting patterns across agent findings
   */
  async identifyPatterns(agentWork, clusters) {
    // Collect all insights from all agent types
    const allInsights = [];
    for (const [agentType, data] of Object.entries(agentWork)) {
      if (data.nodes) {
        allInsights.push(...data.nodes.map(n => ({
          agentType,
          concept: n.concept,
          tag: n.tag,
          cluster: n.cluster,
          accessCount: n.accessCount
        })));
      }
    }

    if (allInsights.length === 0) {
      return [];
    }

    // Use comprehensive context for pattern identification (matches query engine deep mode)
    const contextLimit = Math.min(allInsights.length, 400);

    // Use LLM to identify patterns across insights
    const insightsSummary = allInsights
      .slice(0, contextLimit)  // Increased from 30 to 400 (matches query engine deep mode)
      .map((ins, i) => `${i + 1}. [${ins.agentType}] ${ins.concept?.substring(0, 150)}`)
      .join('\n');

    const clusterSummary = Array.from(clusters.entries())
      .slice(0, 10)
      .map(([id, nodes]) => `Cluster ${id}: ${nodes.length} concepts`)
      .join('\n');

    const prompt = `You are analyzing findings from multiple AI agents to identify cross-cutting patterns.

MISSION: ${this.mission.description}

RECENT INSIGHTS FROM AGENTS (${allInsights.length} total):
${insightsSummary}

KNOWLEDGE CLUSTERS:
${clusterSummary}

Your task:
1. Identify 3-5 PATTERNS that appear across multiple agents' findings
2. Patterns should be:
   - Cross-cutting (span multiple agent types)
   - Non-obvious (not apparent from single agent)
   - Substantive (meaningful connections)
3. Note which agents contributed to each pattern
4. Explain why the pattern is significant

Respond in JSON format:
{
  "patterns": [
    {
      "id": "p_1",
      "description": "Pattern description...",
      "contributingAgents": ["research", "analysis"],
      "significance": "Why this matters...",
      "evidenceNodes": ["concept 1", "concept 2"]
    }
  ]
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel,
        instructions: this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()) + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Identify cross-cutting patterns.' }],
        maxTokens: 25000,
        reasoningEffort: 'high' // Pattern discovery needs deep reasoning
      }, 3);

      const parsed = parseWithFallback(response.content, 'object');
      
      if (parsed && parsed.patterns && Array.isArray(parsed.patterns)) {
        this.logger.info('✅ Patterns identified', {
          count: parsed.patterns.length
        });
        return parsed.patterns;
      }

      return [];
    } catch (error) {
      this.logger.error('Pattern identification failed', { error: error.message });
      return [];
    }
  }

  /**
   * Detect contradictions across agent findings
   */
  async detectContradictions(agentWork) {
    const allInsights = [];
    for (const [agentType, data] of Object.entries(agentWork)) {
      if (data.nodes) {
        allInsights.push(...data.nodes.map(n => ({
          agentType,
          concept: n.concept,
          tag: n.tag
        })));
      }
    }

    if (allInsights.length < 2) {
      return [];
    }

    // Use LLM to detect contradictions
    const insightsSummary = allInsights
      .slice(0, 20)
      .map((ins, i) => `${i + 1}. [${ins.agentType}] ${ins.concept?.substring(0, 150)}`)
      .join('\n');

    const prompt = `You are checking for contradictions across AI agent findings.

INSIGHTS TO CHECK (${allInsights.length} total):
${insightsSummary}

Your task:
1. Identify any CONTRADICTIONS where findings conflict
2. Contradictions might be:
   - Direct conflicts (A says X, B says not-X)
   - Incompatible assumptions
   - Inconsistent conclusions from same data
3. For each contradiction, explain the conflict
4. Suggest how to resolve it

Respond in JSON format:
{
  "contradictions": [
    {
      "description": "What contradicts what...",
      "conflictingAgents": ["research", "analysis"],
      "severity": "high",
      "resolution": "How to resolve..."
    }
  ]
}`;

    try {
      const response = await this.gpt5.generateFast({
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Detect contradictions.' }],
        maxTokens: 8000, // Increased from 3000 - pattern descriptions need thorough analysis
      });

      const parsed = parseWithFallback(response.content, 'object');
      
      if (parsed && parsed.contradictions) {
        this.logger.info('🔍 Contradictions detected', {
          count: parsed.contradictions.length
        });
        return parsed.contradictions;
      }

      return [];
    } catch (error) {
      this.logger.error('Contradiction detection failed', { error: error.message });
      return [];
    }
  }

  /**
   * Generate meta-insights about the knowledge state
   */
  async generateMetaInsights(patterns, contradictions, clusters) {
    const metaInsights = [];

    // Insight 1: Pattern density
    if (patterns.length > 0) {
      metaInsights.push(
        `Integration discovered ${patterns.length} cross-cutting patterns across agent findings. ` +
        `Key themes: ${patterns.map(p => p.description.substring(0, 40)).join('; ')}`
      );
    }

    // Insight 2: Contradiction analysis
    if (contradictions.length > 0) {
      metaInsights.push(
        `Detected ${contradictions.length} contradictions requiring resolution. ` +
        `High severity: ${contradictions.filter(c => c.severity === 'high').length}`
      );
    }

    // Insight 3: Knowledge landscape structure
    const avgClusterSize = clusters.size > 0
      ? Array.from(clusters.values()).reduce((sum, nodes) => sum + nodes.length, 0) / clusters.size
      : 0;

    metaInsights.push(
      `Knowledge landscape: ${clusters.size} clusters, avg size ${avgClusterSize.toFixed(1)} concepts. ` +
      `${clusters.size > 5 ? 'Well-structured' : 'Needs more integration'}.`
    );

    // Insight 4: Hot topics vs exploration balance
    const hotTopics = await this.getHotTopics(10);
    const hotConcepts = hotTopics.map(t => t.cluster).filter(c => c !== null);
    const uniqueHotClusters = new Set(hotConcepts).size;

    metaInsights.push(
      `Focus distribution: ${uniqueHotClusters} clusters are active (hot topics). ` +
      `${uniqueHotClusters < clusters.size * 0.3 ? 'Consider broader exploration' : 'Good coverage'}.`
    );

    return metaInsights;
  }

  /**
   * Create knowledge landscape summary
   */
  createLandscapeSummary(clusters, agentWork) {
    const clusterDetails = [];
    
    for (const [clusterId, nodes] of clusters.entries()) {
      // Get sample concepts from cluster
      const sampleConcepts = nodes
        .slice(0, 5)
        .map(n => n.concept?.substring(0, 80));

      // Count agent contributions to this cluster
      const agentContributions = {};
      for (const node of nodes) {
        if (node.concept?.includes('[AGENT')) {
          // Try to extract agent type from concept or tag
          for (const agentType of ['research', 'analysis', 'code_execution', 'synthesis', 'exploration']) {
            if (node.tag?.includes(agentType) || node.concept?.toLowerCase().includes(agentType)) {
              agentContributions[agentType] = (agentContributions[agentType] || 0) + 1;
              break;
            }
          }
        }
      }

      clusterDetails.push({
        clusterId,
        size: nodes.length,
        sampleConcepts,
        agentContributions,
        avgAccessCount: nodes.reduce((sum, n) => sum + (n.accessCount || 0), 0) / nodes.length
      });
    }

    // Sort by size
    clusterDetails.sort((a, b) => b.size - a.size);

    return {
      totalClusters: clusters.size,
      totalNodes: this.memory.nodes.size,
      clusterDetails: clusterDetails.slice(0, 10), // Top 10 clusters
      agentActivity: Object.entries(agentWork).map(([type, data]) => ({
        agentType: type,
        insightCount: data.count || 0
      })),
      createdAt: new Date()
    };
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('🎉 IntegrationAgent completed successfully', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      patternsFound: this.patterns.length,
      contradictions: this.contradictions.length
    }, 3);
  }
}

module.exports = { IntegrationAgent };

