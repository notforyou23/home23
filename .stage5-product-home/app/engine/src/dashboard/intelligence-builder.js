/**
 * Intelligence Builder
 * Transforms raw COSMO data into actionable intelligence
 */

const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

class IntelligenceBuilder {
  constructor(runsDir, defaultRunDir) {
    this.runsDir = runsDir;
    this.defaultRunDir = defaultRunDir;
  }

  /**
   * Get run directory path
   */
  getRunDir(runName) {
    return (runName === 'runtime' || runName === 'current')
      ? this.defaultRunDir
      : path.join(this.runsDir, runName);
  }

  /**
   * Load state for a run
   */
  async loadState(runName) {
    const runDir = this.getRunDir(runName);
    const statePath = path.join(runDir, 'state.json.gz');
    
    const compressed = await fs.readFile(statePath);
    const decompressed = await gunzip(compressed);
    return JSON.parse(decompressed.toString());
  }

  /**
   * Load latest curated insight
   */
  async loadLatestInsight(runName) {
    const runDir = this.getRunDir(runName);
    const coordinatorDir = path.join(runDir, 'coordinator');
    
    try {
      const files = await fs.readdir(coordinatorDir);
      const insights = files
        .filter(f => f.startsWith('insights_curated_') && f.endsWith('.md'))
        .sort()
        .reverse();
      
      if (insights.length === 0) return null;
      
      const content = await fs.readFile(path.join(coordinatorDir, insights[0]), 'utf-8');
      return this.parseInsightFile(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse insight markdown file
   */
  parseInsightFile(content) {
    const insights = [];
    const sections = content.split(/^###\s+/m).filter(s => s.trim());
    
    for (const section of sections) {
      const lines = section.split('\n');
      if (lines.length < 2) continue;
      
      // First line is title (e.g., "1. Title of insight")
      const titleLine = lines[0].trim();
      const titleMatch = titleLine.match(/^\d+\.\s+(.+)/);
      if (!titleMatch) continue;
      
      const insight = {
        title: titleMatch[1],
        content: '',
        scores: {
          actionability: 0,
          strategic: 0,
          novelty: 0
        },
        source: ''
      };
      
      // Parse scores from line with all three scores (format: "**Actionability:** 9/10 | **Strategic Value:** 9/10 | **Novelty:** 6/10")
      const fullText = lines.slice(0, 10).join(' '); // Check first 10 lines
      
      const actionMatch = fullText.match(/\*\*Actionability:\*\*\s*(\d+)\/10/);
      if (actionMatch) insight.scores.actionability = parseInt(actionMatch[1]);
      
      const strategicMatch = fullText.match(/\*\*Strategic Value:\*\*\s*(\d+)\/10/);
      if (strategicMatch) insight.scores.strategic = parseInt(strategicMatch[1]);
      
      const noveltyMatch = fullText.match(/\*\*Novelty:\*\*\s*(\d+)\/10/);
      if (noveltyMatch) insight.scores.novelty = parseInt(noveltyMatch[1]);
      
      // Content is everything between scores line and source line
      let contentLines = [];
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip empty lines, separator lines, markdown headers, and bold text
        if (!line.trim() || 
            line.startsWith('---') || 
            line.startsWith('**') || 
            line.startsWith('##') ||
            line.startsWith('#')) {
          // Check if it's the source line
          if (line.includes('**Source:**')) {
            const sourceMatch = line.match(/\*\*Source:\*\*\s*(.+)/);
            if (sourceMatch) insight.source = sourceMatch[1].trim();
          }
          continue;
        }
        
        contentLines.push(line.trim());
      }
      
      // Clean the content - remove any remaining markdown artifacts
      let content = contentLines.join(' ')
        .replace(/##\s+\w+/g, '') // Remove any ## headers
        .replace(/\*\*/g, '')      // Remove bold markers
        .trim();
      
      insight.content = content.substring(0, 500);
      
      if (insight.content) {
        insights.push(insight);
      }
    }
    
    return { insights };
  }

  /**
   * Load latest coordinator review
   */
  async loadLatestReview(runName) {
    const runDir = this.getRunDir(runName);
    const coordinatorDir = path.join(runDir, 'coordinator');
    
    try {
      const files = await fs.readdir(coordinatorDir);
      const reviews = files
        .filter(f => f.startsWith('review_') && f.endsWith('.md'))
        .sort((a, b) => {
          const numA = parseInt(a.match(/review_(\d+)/)?.[1] || 0);
          const numB = parseInt(b.match(/review_(\d+)/)?.[1] || 0);
          return numB - numA;
        });
      
      if (reviews.length === 0) return null;
      
      const content = await fs.readFile(path.join(coordinatorDir, reviews[0]), 'utf-8');
      return this.parseReviewFile(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse review markdown file
   */
  parseReviewFile(content) {
    const directives = [];
    const lines = content.split('\n');
    
    let inDirectives = false;
    for (const line of lines) {
      if (line.includes('Strategic Directives') || line.includes('strategic recommendations')) {
        inDirectives = true;
        continue;
      }
      
      if (inDirectives && line.match(/^\d+\.\s+(.+)/)) {
        directives.push(line.replace(/^\d+\.\s+/, '').trim());
      }
      
      if (inDirectives && line.match(/^##\s+[^S]/)) {
        break;
      }
    }
    
    return { strategicDirectives: directives };
  }

  /**
   * Build complete intelligence summary
   */
  async buildIntelligenceSummary(runName) {
    try {
      const [state, latestInsight, latestReview] = await Promise.all([
        this.loadState(runName),
        this.loadLatestInsight(runName),
        this.loadLatestReview(runName)
      ]);

      // Find top discovery
      const topDiscovery = latestInsight?.insights?.[0] || {
        content: 'Research in progress...',
        scores: { actionability: 0, strategic: 0, novelty: 0 }
      };

      // Calculate average confidence
      const avgScore = latestInsight?.insights?.[0]?.scores ? 
        Math.round((
          (latestInsight.insights[0].scores.actionability || 0) +
          (latestInsight.insights[0].scores.strategic || 0) +
          (latestInsight.insights[0].scores.novelty || 0)
        ) / 3) : 0;

      // Count research status
      const activeGoals = state.goals?.active || [];
      const validated = activeGoals.filter(([id, g]) => g.status === 'completed').length;
      const investigating = activeGoals.filter(([id, g]) => g.status === 'active').length;

      // Get next direction
      const nextDirection = latestReview?.strategicDirectives?.[0] || 'Continue current research';

      return {
        topDiscovery: topDiscovery.content,
        confidence: avgScore > 7 ? 'HIGH' : avgScore > 4 ? 'MEDIUM' : 'LOW',
        confidenceScore: avgScore,
        validated,
        investigating,
        nextDirection,
        totalInsights: latestInsight?.insights?.length || 0,
        cycle: state.cycleCount || 0
      };
    } catch (error) {
      console.error('Failed to build intelligence summary:', error);
      return {
        topDiscovery: 'Unable to load intelligence data',
        confidence: 'UNKNOWN',
        validated: 0,
        investigating: 0,
        nextDirection: 'N/A',
        totalInsights: 0,
        cycle: 0
      };
    }
  }

  /**
   * Extract top discoveries
   */
  async extractTopDiscoveries(runName, count = 5) {
    try {
      const latestInsight = await this.loadLatestInsight(runName);
      if (!latestInsight || !latestInsight.insights) {
        return [];
      }

      return latestInsight.insights
        .slice(0, count)
        .map((insight, index) => ({
          rank: index + 1,
          title: insight.title || `Insight ${index + 1}`,
          content: insight.content,
          confidence: this.calculateConfidence(insight.scores),
          scores: insight.scores,
          source: insight.source || 'Coordinator synthesis'
        }));
    } catch (error) {
      console.error('Failed to extract top discoveries:', error);
      return [];
    }
  }

  /**
   * Calculate confidence level from scores
   */
  calculateConfidence(scores) {
    if (!scores) return 'LOW';
    const avg = (
      (scores.actionability || 0) +
      (scores.strategic || 0) +
      (scores.novelty || 0)
    ) / 3;
    
    if (avg > 7) return 'HIGH';
    if (avg > 4) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Build breakthrough timeline
   */
  async buildBreakthroughTimeline(runName) {
    try {
      const state = await this.loadState(runName);
      const completedGoals = (state.goals?.active || [])
        .filter(([id, g]) => g.status === 'completed')
        .map(([id, g]) => ({
          cycle: g.completedAt ? this.timestampToCycle(g.completedAt, state.cycleCount) : 0,
          description: g.description,
          timestamp: g.completedAt
        }))
        .sort((a, b) => a.cycle - b.cycle);

      return completedGoals.slice(0, 10); // Top 10 breakthroughs
    } catch (error) {
      console.error('Failed to build breakthrough timeline:', error);
      return [];
    }
  }

  /**
   * Convert timestamp to approximate cycle
   */
  timestampToCycle(timestamp, currentCycle) {
    // Rough estimate - in reality would need cycle timestamps
    return Math.max(1, Math.round(currentCycle * 0.8));
  }

  /**
   * Build research trajectory
   */
  async buildResearchTrajectory(runName) {
    try {
      const state = await this.loadState(runName);
      const cycleCount = state.cycleCount || 0;
      
      // Divide research into phases
      const phases = [];
      const phaseSize = Math.ceil(cycleCount / 4);
      
      for (let i = 0; i < 4; i++) {
        const startCycle = i * phaseSize + 1;
        const endCycle = Math.min((i + 1) * phaseSize, cycleCount);
        
        phases.push({
          phase: i + 1,
          name: this.getPhaseName(i),
          startCycle,
          endCycle,
          description: this.getPhaseDescription(i, state)
        });
      }
      
      return phases;
    } catch (error) {
      console.error('Failed to build research trajectory:', error);
      return [];
    }
  }

  getPhaseName(index) {
    const names = ['Exploration', 'Hypothesis Formation', 'Validation', 'Synthesis'];
    return names[index] || 'Phase';
  }

  getPhaseDescription(index, state) {
    const descriptions = [
      'Initial exploration and question generation',
      'Focus areas identified and hypotheses formed',
      'Cross-validation and evidence gathering',
      'Integration and strategic recommendations'
    ];
    return descriptions[index] || 'Research phase';
  }

  /**
   * Build agent impact analysis
   */
  async buildAgentImpactAnalysis(runName) {
    try {
      const runDir = this.getRunDir(runName);
      const resultsPath = path.join(runDir, 'coordinator', 'results_queue.jsonl');
      
      const fsSync = require('fs');
      if (!fsSync.existsSync(resultsPath)) {
        return { byType: {}, ranked: [] };
      }
      
      const content = await fs.readFile(resultsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l);
      const agents = lines.map(line => JSON.parse(line));
      
      // Group by type
      const byType = {};
      for (const agent of agents) {
        const type = agent.agentType || 'Unknown';
        if (!byType[type]) {
          byType[type] = {
            type,
            count: 0,
            successCount: 0,
            totalDuration: 0,
            findings: [],
            durations: []
          };
        }
        
        byType[type].count++;
        if (agent.status === 'completed') byType[type].successCount++;
        if (agent.duration) byType[type].durations.push(agent.duration);
        if (agent.results) byType[type].findings.push(...agent.results);
      }
      
      // Calculate metrics and rank
      const ranked = Object.values(byType).map(typeData => {
        const avgDuration = typeData.durations.length > 0
          ? typeData.durations.reduce((a, b) => a + b, 0) / typeData.durations.length
          : 0;
        
        const successRate = typeData.count > 0
          ? typeData.successCount / typeData.count
          : 0;
        
        const insightCount = typeData.findings.length;
        
        // Calculate impact score (insights per minute of compute)
        const impactScore = avgDuration > 0
          ? (insightCount / (avgDuration / 60000)) * 10
          : 0;
        
        return {
          type: typeData.type,
          count: typeData.count,
          successRate,
          avgDuration,
          insightCount,
          impactScore,
          bestUseCase: this.identifyBestUseCase(typeData.type)
        };
      });
      
      // Sort by impact score
      ranked.sort((a, b) => b.impactScore - a.impactScore);
      
      return { byType, ranked: ranked.slice(0, 5) };
    } catch (error) {
      console.error('Failed to build agent impact analysis:', error);
      return { byType: {}, ranked: [] };
    }
  }

  identifyBestUseCase(agentType) {
    const useCases = {
      'SynthesisAgent': 'Connecting disparate concepts',
      'ConsistencyAgent': 'Quality validation',
      'ResearchAgent': 'Deep investigation',
      'AnalysisAgent': 'Data analysis and patterns',
      'CodeExecutionAgent': 'Computational experiments',
      'ExplorationAgent': 'Novel direction finding'
    };
    return useCases[agentType] || 'General research';
  }
}

module.exports = { IntelligenceBuilder };

