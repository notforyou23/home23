/**
 * Template-Based Report Generation
 * Generates natural language reports from computed statistics
 * Zero API cost
 */

class TemplateReportGenerator {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Generate cognitive analysis from statistics
   */
  generateCognitiveAnalysis(data) {
    const {
      thoughtsByRole,
      rolePerformance,
      thoughtSample,
      themeFrequency,
      repetitiveThemes,
      cycleCount
    } = data;

    const totalThoughts = thoughtSample.length;
    const roleCount = Object.keys(thoughtsByRole).length;

    // Analyze quality indicators
    const avgThoughtLength = thoughtSample.reduce((sum, t) => sum + t.thought.length, 0) / totalThoughts;
    const qualityScore = this.assessQualityFromStats(avgThoughtLength, themeFrequency);
    const noveltyScore = this.assessNoveltyFromThemes(themeFrequency, repetitiveThemes);

    // Generate prose
    const analysis = `1) Quality Assessment (1–10)
- Depth: ${qualityScore.depth} — ${qualityScore.depthReason}
- Novelty: ${noveltyScore.score} — ${noveltyScore.reason}
- Coherence: ${qualityScore.coherence} — ${qualityScore.coherenceReason}

2) Dominant Themes
${this.formatDominantThemes(themeFrequency, totalThoughts)}

3) Intellectual Progress
${this.assessProgress(thoughtSample, thoughtsByRole)}

4) Gaps & Blind Spots
${this.identifyGaps(repetitiveThemes, thoughtSample)}

5) Standout Insights (breakthrough potential)
${this.identifyStandouts(thoughtSample)}`;

    return {
      content: analysis,
      stats: {
        totalThoughts,
        roleCount,
        avgLength: avgThoughtLength.toFixed(0),
        qualityScore: qualityScore.depth,
        noveltyScore: noveltyScore.score
      },
      timestamp: new Date(),
      failed: false,
      method: 'template'
    };
  }

  /**
   * Assess quality from statistical indicators
   */
  assessQualityFromStats(avgLength, themeFrequency) {
    // Depth: longer thoughts often indicate deeper reasoning
    let depth = 5;
    let depthReason = 'moderate depth';
    
    if (avgLength > 300) {
      depth = 8;
      depthReason = 'detailed reasoning and examples provided';
    } else if (avgLength > 200) {
      depth = 7;
      depthReason = 'solid reasoning with supporting details';
    } else if (avgLength < 100) {
      depth = 4;
      depthReason = 'brief responses, limited elaboration';
    }

    // Coherence: diverse themes suggest coherent exploration
    const themeCount = Object.values(themeFrequency).filter(count => count > 0).length;
    let coherence = 5;
    let coherenceReason = 'moderate thematic coherence';
    
    if (themeCount >= 5) {
      coherence = 8;
      coherenceReason = 'diverse themes with clear connections';
    } else if (themeCount <= 2) {
      coherence = 6;
      coherenceReason = 'focused but somewhat repetitive';
    }

    return { depth, depthReason, coherence, coherenceReason };
  }

  /**
   * Assess novelty from theme distribution
   */
  assessNoveltyFromThemes(themeFrequency, repetitiveThemes) {
    const totalMentions = Object.values(themeFrequency).reduce((sum, count) => sum + count, 0);
    
    if (totalMentions === 0) {
      return { score: 7, reason: 'exploring fresh territory beyond tracked themes' };
    }

    // High repetition = low novelty
    if (repetitiveThemes.length > 2) {
      return { score: 5, reason: `repetitive focus on: ${repetitiveThemes.slice(0, 2).join(', ')}` };
    } else if (repetitiveThemes.length > 0) {
      return { score: 6, reason: `some repetition in: ${repetitiveThemes[0]}` };
    }

    // Diverse themes = good novelty
    const activeThemes = Object.values(themeFrequency).filter(count => count > 0).length;
    if (activeThemes >= 6) {
      return { score: 8, reason: 'diverse exploration across multiple conceptual areas' };
    }

    return { score: 7, reason: 'balanced mix of familiar and new territory' };
  }

  /**
   * Format dominant themes
   */
  formatDominantThemes(themeFrequency, totalThoughts) {
    const themes = Object.entries(themeFrequency)
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (themes.length === 0) {
      return '- Exploring territory beyond standard tracked themes\n- No single dominant pattern detected';
    }

    return themes.map(([theme, count]) => {
      const pct = ((count / totalThoughts) * 100).toFixed(0);
      return `- ${theme}: ${count} mentions (${pct}% of thoughts)`;
    }).join('\n');
  }

  /**
   * Assess intellectual progress
   */
  assessProgress(thoughtSample, thoughtsByRole) {
    // Look for building patterns in thought content
    const recentThoughts = thoughtSample.slice(-10);
    const earlierThoughts = thoughtSample.slice(0, 10);

    // Check for cross-references or building on previous ideas
    const hasBuildingLanguage = recentThoughts.some(t => 
      /building on|following from|extends|refines|challenges|contradicts/i.test(t.thought)
    );

    // Check for increasing specificity
    const recentAvgLength = recentThoughts.reduce((sum, t) => sum + t.thought.length, 0) / recentThoughts.length;
    const earlierAvgLength = earlierThoughts.reduce((sum, t) => sum + t.thought.length, 0) / earlierThoughts.length;

    if (hasBuildingLanguage && recentAvgLength > earlierAvgLength * 1.2) {
      return `Strong evidence of progressive thinking. Recent thoughts show deeper elaboration (avg ${recentAvgLength.toFixed(0)} chars vs ${earlierAvgLength.toFixed(0)} earlier) and explicit building on previous ideas.`;
    } else if (hasBuildingLanguage) {
      return `Some evidence of iterative thinking with thoughts referencing and building on earlier concepts.`;
    } else if (Math.abs(recentAvgLength - earlierAvgLength) < 50) {
      return `Consistent depth maintained across the period, though limited explicit cross-referencing between ideas.`;
    } else {
      return `Thoughts remain largely independent. Opportunity to build more explicit connections between insights.`;
    }
  }

  /**
   * Identify gaps and blind spots
   */
  identifyGaps(repetitiveThemes, thoughtSample) {
    if (repetitiveThemes.length === 0) {
      return `No major blind spots detected. Exploration appears well-distributed across multiple conceptual areas.`;
    }

    const overFocused = repetitiveThemes.map(t => t.split(' (')[0]);
    
    const suggestions = [
      'practical implementation challenges',
      'cross-domain applications',
      'failure modes and limitations',
      'measurement and validation approaches',
      'resource and scaling constraints'
    ];

    return `⚠️ Over-focus on: ${overFocused.join(', ')}

Under-explored areas likely include:
${suggestions.map(s => `- ${s}`).join('\n')}

Recommendation: Explicitly prompt for perspectives beyond current dominant themes.`;
  }

  /**
   * Identify standout insights
   */
  identifyStandouts(thoughtSample) {
    // Score thoughts by multiple criteria
    const scored = thoughtSample.map((t, idx) => {
      let score = 0;
      const thought = t.thought;

      // Length (detailed thoughts often more insightful)
      if (thought.length > 300) score += 2;
      else if (thought.length > 200) score += 1;

      // Concrete examples or specifics
      if (/e\.g\.|for example|specifically|such as|\d+%/i.test(thought)) score += 2;

      // Novel connections
      if (/however|unlike|instead|alternatively|combining/i.test(thought)) score += 1;

      // Actionable
      if (/should|must|can|require|implement|design|build/i.test(thought)) score += 1;

      // Recency bonus (recent insights more relevant)
      if (idx >= thoughtSample.length - 10) score += 1;

      return { ...t, score, index: idx };
    });

    // Get top 5
    const standouts = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return standouts.map((t, i) => {
      const preview = t.thought.substring(0, 200);
      return `- ${t.cycle || t.index}: ${t.role} — ${preview}${t.thought.length > 200 ? '...' : ''}`;
    }).join('\n');
  }

  /**
   * Generate memory analysis from statistics
   */
  generateMemoryAnalysis(data) {
    const { stats, topNodes, strongConnections } = data;

    const analysis = `1) Emerging knowledge domains
${this.identifyDomains(topNodes)}

2) Key concepts (central nodes)
${topNodes.slice(0, 5).map((n, i) => `${i + 1}. ${n.text} (activation: ${n.activation})`).join('\n')}

3) Connection patterns
- Network density: ${stats.avgDegree.toFixed(1)} connections per node
- Strong connections: ${strongConnections.count}
${strongConnections.count > 10 ? '- Highly interconnected knowledge base forming' : '- Connections still forming, early stage network'}

4) Gaps to bridge
${this.identifyMemoryGaps(topNodes, strongConnections)}

5) Consolidation opportunities
${this.identifyConsolidationOpportunities(stats, topNodes)}`;

    return {
      content: analysis,
      stats,
      timestamp: new Date(),
      failed: false,
      method: 'template'
    };
  }

  /**
   * Identify knowledge domains from top nodes
   */
  identifyDomains(topNodes) {
    // Simple keyword clustering
    const keywords = {};
    
    for (const node of topNodes) {
      const text = node.text.toLowerCase();
      
      // Extract domain indicators
      if (/\b(ai|model|learning|neural|algorithm)\b/.test(text)) {
        keywords['AI/ML'] = (keywords['AI/ML'] || 0) + 1;
      }
      if (/\b(data|quality|dataset|bias|training)\b/.test(text)) {
        keywords['Data Quality'] = (keywords['Data Quality'] || 0) + 1;
      }
      if (/\b(system|architecture|design|framework|infrastructure)\b/.test(text)) {
        keywords['Systems/Architecture'] = (keywords['Systems/Architecture'] || 0) + 1;
      }
      if (/\b(safety|alignment|risk|governance|oversight)\b/.test(text)) {
        keywords['Safety/Governance'] = (keywords['Safety/Governance'] || 0) + 1;
      }
      if (/\b(evaluation|benchmark|test|metric|measure)\b/.test(text)) {
        keywords['Evaluation/Testing'] = (keywords['Evaluation/Testing'] || 0) + 1;
      }
    }

    const domains = Object.entries(keywords)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([domain, count]) => `- ${domain} (${count} high-activation nodes)`)
      .join('\n');

    return domains || '- Diverse knowledge base forming across multiple domains';
  }

  /**
   * Identify memory gaps
   */
  identifyMemoryGaps(topNodes, strongConnections) {
    if (strongConnections.count < 5) {
      return `Limited connections detected. System still in early knowledge accumulation phase.
Recommendation: Continue exploration to build foundational knowledge base.`;
    }

    return `Network showing healthy growth. Potential gaps in cross-domain connections.
Recommendation: Encourage synthesis across disparate conceptual areas.`;
  }

  /**
   * Identify consolidation opportunities
   */
  identifyConsolidationOpportunities(stats, topNodes) {
    if (stats.nodes < 100) {
      return 'Network still growing. Consolidation not yet needed.';
    }

    if (stats.nodes > 1500) {
      return `Large network (${stats.nodes} nodes). Consider:
- Consolidating similar concepts to reduce redundancy
- Creating higher-level abstraction nodes
- Archiving low-activation peripheral nodes`;
    }

    return `Network size (${stats.nodes} nodes) manageable. Monitor for redundant clusters forming.`;
  }
}

module.exports = { TemplateReportGenerator };

