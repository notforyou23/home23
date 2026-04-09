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
    const qualityScore = this.assessQualityFromStats(avgThoughtLength, themeFrequency, thoughtSample);
    const noveltyScore = this.assessNoveltyFromThemes(themeFrequency, repetitiveThemes, thoughtSample);

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
   * Calculate standard deviation
   */
  calculateStdDev(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  /**
   * Assess quality from statistical indicators
   */
  assessQualityFromStats(avgLength, themeFrequency, thoughtSample) {
    // --- DEPTH: reasoning density + length diversity, not just raw length ---
    const lengths = thoughtSample.map(t => t.thought.length);
    const stdDev = this.calculateStdDev(lengths);
    const lengthCV = avgLength > 0 ? stdDev / avgLength : 0; // coefficient of variation

    // Count reasoning indicators (multi-step argument markers)
    const reasoningPattern = /because|therefore|however|evidence|specifically|for example|this suggests|implies that|as a result|in contrast|consequently|furthermore/gi;
    const reasoningCount = thoughtSample.filter(t =>
      (t.thought.match(reasoningPattern) || []).length >= 2
    ).length;
    const reasoningRate = thoughtSample.length > 0 ? reasoningCount / thoughtSample.length : 0;

    // Length component (0-10, finer granularity)
    let lengthScore;
    if (avgLength > 500) lengthScore = 10;
    else if (avgLength > 400) lengthScore = 9;
    else if (avgLength > 300) lengthScore = 7;
    else if (avgLength > 200) lengthScore = 5;
    else if (avgLength > 100) lengthScore = 3;
    else lengthScore = 2;

    // Diversity factor: very uniform length suggests formulaic output
    let diversityPenalty = 0;
    if (lengthCV < 0.2) diversityPenalty = -1;
    else if (lengthCV > 0.6) diversityPenalty = 0; // high variance is fine

    // Reasoning density component (0-10)
    const reasoningScore = Math.min(10, Math.round(reasoningRate * 12));

    // Weighted combination
    let depth = Math.round(lengthScore * 0.4 + reasoningScore * 0.6) + diversityPenalty;
    depth = Math.max(1, Math.min(10, depth));

    let depthReason;
    if (depth >= 8) depthReason = `substantial analytical depth (${(reasoningRate * 100).toFixed(0)}% with reasoning chains, avg ${avgLength.toFixed(0)} chars)`;
    else if (depth >= 6) depthReason = `solid depth (${(reasoningRate * 100).toFixed(0)}% show explicit reasoning, avg ${avgLength.toFixed(0)} chars)`;
    else if (depth >= 4) depthReason = `moderate depth, limited elaboration (${(reasoningRate * 100).toFixed(0)}% reasoning, avg ${avgLength.toFixed(0)} chars)`;
    else depthReason = `surface-level, mostly assertions without reasoning chains`;

    // --- COHERENCE: building-language rate, not theme diversity ---
    const buildingPattern = /building on|following from|extends|refines|challenges|contradicts|earlier|previously|as mentioned|this relates|connects to|revisiting|returning to/gi;
    const buildingCount = thoughtSample.filter(t => buildingPattern.test(t.thought)).length;
    const buildingRate = thoughtSample.length > 0 ? buildingCount / thoughtSample.length : 0;

    const themeCount = Object.values(themeFrequency).filter(count => count > 0).length;

    let coherence;
    let coherenceReason;

    if (buildingRate > 0.3 && themeCount <= 4) {
      coherence = 9;
      coherenceReason = `highly coherent — ${(buildingRate * 100).toFixed(0)}% of thoughts build on prior ideas, focused on ${themeCount} themes`;
    } else if (buildingRate > 0.2) {
      coherence = 7;
      coherenceReason = `good coherence — ${(buildingRate * 100).toFixed(0)}% reference earlier work across ${themeCount} themes`;
    } else if (buildingRate > 0.1) {
      coherence = 6;
      coherenceReason = `moderate coherence — some cross-referencing (${(buildingRate * 100).toFixed(0)}%) but mostly independent thoughts`;
    } else if (themeCount <= 2) {
      coherence = 5;
      coherenceReason = `narrow focus (${themeCount} themes) but thoughts don't explicitly build on each other`;
    } else if (themeCount >= 5 && buildingRate < 0.05) {
      coherence = 3;
      coherenceReason = `scattered across ${themeCount} themes with minimal connection between ideas`;
    } else {
      coherence = 4;
      coherenceReason = `limited coherence — independent thoughts without clear progression`;
    }

    return { depth, depthReason, coherence, coherenceReason };
  }

  /**
   * Assess novelty from theme distribution and thought content
   */
  assessNoveltyFromThemes(themeFrequency, repetitiveThemes, thoughtSample) {
    const totalMentions = Object.values(themeFrequency).reduce((sum, count) => sum + count, 0);
    const activeThemes = Object.values(themeFrequency).filter(count => count > 0).length;

    // Theme concentration: how dominated by top theme
    const sortedCounts = Object.values(themeFrequency).filter(c => c > 0).sort((a, b) => b - a);
    const topThemeShare = totalMentions > 0 && sortedCounts.length > 0 ? sortedCounts[0] / totalMentions : 0;

    // Novel vocabulary signals in thought content
    const noveltyPattern = /novel|new approach|unexpected|surprising|unconventional|unlike|different from|alternative|emerging|counterintuitive|overlooked/gi;
    const noveltyCount = thoughtSample.filter(t => noveltyPattern.test(t.thought)).length;
    const noveltyRate = thoughtSample.length > 0 ? noveltyCount / thoughtSample.length : 0;

    // Unique concept density: ratio of unique multi-word phrases
    const allWords = thoughtSample.map(t => t.thought.toLowerCase()).join(' ');
    const wordCount = allWords.split(/\s+/).length;
    const uniqueWords = new Set(allWords.split(/\s+/)).size;
    const vocabularyRichness = wordCount > 0 ? uniqueWords / wordCount : 0;

    let score;
    let reason;

    // High concentration + repetition = low novelty
    if (topThemeShare > 0.6 && repetitiveThemes.length > 2) {
      score = 3;
      reason = `heavily concentrated on ${repetitiveThemes.slice(0, 2).join(', ')} (${(topThemeShare * 100).toFixed(0)}% of mentions)`;
    } else if (topThemeShare > 0.5 && repetitiveThemes.length > 0) {
      score = 5;
      reason = `significant repetition in ${repetitiveThemes[0]} (${(topThemeShare * 100).toFixed(0)}% concentration)`;
    }
    // High novelty signals
    else if (noveltyRate > 0.2 && activeThemes >= 4) {
      score = 9;
      reason = `high novelty — ${(noveltyRate * 100).toFixed(0)}% signal new concepts across ${activeThemes} themes`;
    } else if (noveltyRate > 0.15 || (activeThemes >= 6 && vocabularyRichness > 0.4)) {
      score = 8;
      reason = `strong novelty — diverse exploration (${activeThemes} themes, ${(vocabularyRichness * 100).toFixed(0)}% vocabulary richness)`;
    } else if (totalMentions === 0 && noveltyRate > 0.1) {
      score = 8;
      reason = `exploring territory beyond tracked themes with novel language`;
    }
    // Moderate cases
    else if (activeThemes >= 4 && noveltyRate > 0.05) {
      score = 7;
      reason = `moderate novelty — ${activeThemes} themes with some new concepts (${(noveltyRate * 100).toFixed(0)}%)`;
    } else if (noveltyRate < 0.03 && activeThemes <= 3) {
      score = 4;
      reason = `limited novelty — narrow focus (${activeThemes} themes), mostly familiar territory`;
    } else if (totalMentions === 0) {
      score = 6;
      reason = `exploring beyond tracked themes but limited novelty signals`;
    } else {
      score = 6;
      reason = `moderate exploration across ${activeThemes} themes`;
    }

    score = Math.max(1, Math.min(10, score));
    return { score, reason };
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

