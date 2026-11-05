/**
 * Evidence Quality Analyzer
 * Provides metrics on answer quality, coverage, confidence, and gaps
 */

class EvidenceAnalyzer {
  constructor() {
    // Configuration for evidence quality thresholds
    this.thresholds = {
      coverage: {
        excellent: 0.7,
        good: 0.5,
        fair: 0.3
      },
      confidence: {
        high: 0.8,
        medium: 0.6,
        low: 0.4
      },
      consensus: {
        strong: 0.8,
        moderate: 0.6,
        weak: 0.4
      }
    };
  }

  /**
   * Analyze overall evidence quality for a query result
   */
  async analyzeEvidenceQuality(state, relevantMemory, relevantThoughts, allMemory, query) {
    const coverage = this.calculateCoverage(relevantMemory, allMemory);
    const confidence = this.calculateConfidence(relevantMemory, relevantThoughts);
    const temporal = this.analyzeTemporal(relevantThoughts);
    const gaps = this.identifyGaps(state, relevantMemory, relevantThoughts, query);
    
    // Calculate consensus if in cluster mode
    let consensus = null;
    if (state.isCluster) {
      consensus = this.calculateConsensus(state, relevantMemory);
    }

    return {
      coverage,
      confidence,
      consensus,
      temporal,
      gaps,
      summary: this.generateSummary(coverage, confidence, consensus, gaps)
    };
  }

  /**
   * Calculate coverage: what % of available knowledge was used
   */
  calculateCoverage(relevantMemory, allMemory) {
    const totalNodes = allMemory.length || 1;
    const usedNodes = relevantMemory.length;
    const percentage = Math.min(usedNodes / totalNodes, 1.0);

    return {
      percentage,
      used: usedNodes,
      total: totalNodes,
      rating: this.getCoverageRating(percentage)
    };
  }

  getCoverageRating(percentage) {
    if (percentage >= this.thresholds.coverage.excellent) return 'excellent';
    if (percentage >= this.thresholds.coverage.good) return 'good';
    if (percentage >= this.thresholds.coverage.fair) return 'fair';
    return 'limited';
  }

  /**
   * Calculate confidence based on memory activation and thought coherence
   */
  calculateConfidence(relevantMemory, relevantThoughts) {
    let totalScore = 0;
    let weightSum = 0;

    // Analyze memory nodes
    for (const node of relevantMemory) {
      const activation = node.activation || 0.5;
      const weight = node.weight || 0.5;
      const tags = node.tags || [];
      
      let nodeScore = activation * weight;
      
      // Boost for high-quality tags
      if (tags.some(t => t.includes('agent_insight'))) nodeScore *= 1.3;
      if (tags.some(t => t.includes('breakthrough'))) nodeScore *= 1.4;
      if (tags.some(t => t.includes('validated'))) nodeScore *= 1.2;
      
      totalScore += nodeScore;
      weightSum += 1;
    }

    // Analyze thoughts for coherence
    const thoughtScores = relevantThoughts.map(t => {
      const content = t.content || '';
      const hasReasoning = content.includes('because') || content.includes('therefore') || content.includes('thus');
      const hasEvidence = content.includes('observed') || content.includes('found') || content.includes('discovered');
      return hasReasoning && hasEvidence ? 1.0 : 0.7;
    });

    const thoughtAvg = thoughtScores.length > 0 
      ? thoughtScores.reduce((a, b) => a + b, 0) / thoughtScores.length 
      : 0.5;

    // Weighted average: 70% memory, 30% thought coherence
    const memoryConfidence = weightSum > 0 ? totalScore / weightSum : 0.5;
    const overallConfidence = (memoryConfidence * 0.7) + (thoughtAvg * 0.3);

    return {
      score: Math.min(overallConfidence, 1.0),
      rating: this.getConfidenceRating(overallConfidence),
      memoryStrength: memoryConfidence,
      thoughtCoherence: thoughtAvg
    };
  }

  getConfidenceRating(score) {
    if (score >= this.thresholds.confidence.high) return 'high';
    if (score >= this.thresholds.confidence.medium) return 'medium';
    if (score >= this.thresholds.confidence.low) return 'low';
    return 'very low';
  }

  /**
   * Calculate consensus across cluster instances (if applicable)
   */
  calculateConsensus(state, relevantMemory) {
    if (!state.isCluster || !state.instances) {
      return null;
    }

    // Analyze cross-instance agreement
    const instanceCounts = {};
    for (const node of relevantMemory) {
      const source = node.instanceId || 'unknown';
      instanceCounts[source] = (instanceCounts[source] || 0) + 1;
    }

    const instances = Object.keys(instanceCounts);
    const totalInstances = state.instances.length || 1;
    const participationRate = instances.length / totalInstances;

    // Calculate distribution variance (low = good consensus)
    const counts = Object.values(instanceCounts);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length;
    const normalizedVariance = Math.min(variance / avg, 1.0);
    
    const consensusScore = participationRate * (1 - normalizedVariance * 0.5);

    return {
      score: consensusScore,
      rating: this.getConsensusRating(consensusScore),
      instances: instances.length,
      total: totalInstances,
      distribution: instanceCounts
    };
  }

  getConsensusRating(score) {
    if (score >= this.thresholds.consensus.strong) return 'strong';
    if (score >= this.thresholds.consensus.moderate) return 'moderate';
    if (score >= this.thresholds.consensus.weak) return 'weak';
    return 'divergent';
  }

  /**
   * Analyze temporal coverage of evidence
   */
  analyzeTemporal(relevantThoughts) {
    if (!relevantThoughts || relevantThoughts.length === 0) {
      return {
        span: 0,
        distribution: 'none',
        recentBias: 0
      };
    }

    const cycles = relevantThoughts
      .map(t => t.cycle || t.cycleCount || 0)
      .filter(c => c > 0)
      .sort((a, b) => a - b);

    if (cycles.length === 0) {
      return {
        span: 0,
        distribution: 'unknown',
        recentBias: 0
      };
    }

    const minCycle = cycles[0];
    const maxCycle = cycles[cycles.length - 1];
    const span = maxCycle - minCycle + 1;

    // Calculate recency bias (what % from recent 20% of time)
    const recentThreshold = maxCycle - (span * 0.2);
    const recentCount = cycles.filter(c => c >= recentThreshold).length;
    const recentBias = recentCount / cycles.length;

    // Determine distribution
    let distribution = 'even';
    if (recentBias > 0.6) distribution = 'recent-heavy';
    else if (recentBias < 0.3) distribution = 'historical-heavy';

    return {
      span,
      minCycle,
      maxCycle,
      distribution,
      recentBias,
      dataPoints: cycles.length
    };
  }

  /**
   * Identify gaps or weaknesses in evidence
   */
  identifyGaps(state, relevantMemory, relevantThoughts, query) {
    const gaps = [];

    // Check for temporal gaps
    const temporal = this.analyzeTemporal(relevantThoughts);
    if (temporal.span > 10 && temporal.dataPoints < 5) {
      gaps.push({
        type: 'temporal',
        severity: 'medium',
        description: 'Limited evidence across time period'
      });
    }

    // Check for low memory coverage
    const allMemory = state.memory?.nodes || [];
    const coverage = relevantMemory.length / (allMemory.length || 1);
    if (coverage < 0.05) {
      gaps.push({
        type: 'coverage',
        severity: 'high',
        description: 'Very limited memory coverage - may be missing important context'
      });
    }

    // Check for missing thought evidence
    if (relevantThoughts.length < 3) {
      gaps.push({
        type: 'thoughts',
        severity: 'medium',
        description: 'Few relevant thoughts found - limited reasoning evidence'
      });
    }

    // Check query complexity vs evidence
    const queryWords = query.split(/\s+/).length;
    const complexQuery = queryWords > 15;
    if (complexQuery && relevantMemory.length < 10) {
      gaps.push({
        type: 'complexity',
        severity: 'medium',
        description: 'Complex query but limited evidence base'
      });
    }

    return gaps;
  }

  /**
   * Generate human-readable summary
   */
  generateSummary(coverage, confidence, consensus, gaps) {
    const parts = [];

    // Coverage summary
    parts.push(`Coverage: ${coverage.rating} (${Math.round(coverage.percentage * 100)}% of knowledge base)`);

    // Confidence summary
    parts.push(`Confidence: ${confidence.rating} (${Math.round(confidence.score * 100)}%)`);

    // Consensus summary (if applicable)
    if (consensus) {
      parts.push(`Consensus: ${consensus.rating} across ${consensus.instances}/${consensus.total} instances`);
    }

    // Gaps summary
    if (gaps.length > 0) {
      const highSeverity = gaps.filter(g => g.severity === 'high').length;
      if (highSeverity > 0) {
        parts.push(`⚠️ ${highSeverity} high-severity gap(s) identified`);
      }
    } else {
      parts.push('✓ No significant gaps identified');
    }

    return parts.join(' • ');
  }
}

module.exports = { EvidenceAnalyzer };

