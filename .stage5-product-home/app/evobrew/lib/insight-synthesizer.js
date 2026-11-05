/**
 * Insight Synthesizer
 * Pre-analyzes memory and thoughts to identify patterns, clusters, and breakthroughs
 */

class InsightSynthesizer {
  constructor() {
    this.config = {
      minClusterSize: 3,
      temporalWindowSize: 5,
      similarityThreshold: 0.6,
      breakthroughScoreThreshold: 0.75
    };
  }

  /**
   * Synthesize insights from query results
   */
  async synthesize(state, relevantMemory, relevantThoughts, query) {
    const patterns = await this.detectTemporalPatterns(relevantThoughts);
    const clusters = this.clusterConcepts(relevantMemory);
    const breakthroughs = this.identifyBreakthroughs(relevantMemory, relevantThoughts);
    const crossInstance = state.isCluster ? this.analyzeCrossInstance(state, relevantMemory) : null;

    return {
      patterns,
      clusters,
      breakthroughs,
      crossInstance,
      summary: this.generateInsightSummary(patterns, clusters, breakthroughs, crossInstance)
    };
  }

  /**
   * Detect temporal patterns in thoughts
   */
  async detectTemporalPatterns(thoughts) {
    if (!thoughts || thoughts.length < 3) {
      return [];
    }

    // Sort by cycle
    const sorted = thoughts
      .filter(t => t.cycle || t.cycleCount)
      .sort((a, b) => (a.cycle || a.cycleCount) - (b.cycle || b.cycleCount));

    if (sorted.length < 3) {
      return [];
    }

    const patterns = [];

    // Look for repeated themes
    const themes = this.extractThemes(sorted);
    for (const [theme, occurrences] of Object.entries(themes)) {
      if (occurrences.length >= 3) {
        // Calculate if trend is increasing, decreasing, or stable
        const trend = this.calculateTrend(occurrences);
        
        patterns.push({
          type: 'recurring_theme',
          theme,
          occurrences: occurrences.length,
          cycles: occurrences.map(o => o.cycle),
          trend,
          significance: occurrences.length / sorted.length
        });
      }
    }

    // Look for evolution patterns (concept changing over time)
    const evolutions = this.detectEvolutions(sorted);
    patterns.push(...evolutions);

    return patterns.sort((a, b) => b.significance - a.significance);
  }

  extractThemes(thoughts) {
    const themes = {};
    
    for (const thought of thoughts) {
      const content = (thought.content || '').toLowerCase();
      const words = content.split(/\s+/).filter(w => w.length > 4);
      
      // Extract potential themes (noun phrases, key concepts)
      for (const word of words) {
        if (!this.isStopWord(word)) {
          if (!themes[word]) {
            themes[word] = [];
          }
          themes[word].push({
            cycle: thought.cycle || thought.cycleCount,
            content: thought.content
          });
        }
      }
    }

    return themes;
  }

  isStopWord(word) {
    const stopWords = new Set([
      'this', 'that', 'these', 'those', 'what', 'which', 'who', 'when', 'where',
      'why', 'how', 'will', 'would', 'could', 'should', 'might', 'must',
      'have', 'been', 'being', 'there', 'their', 'about', 'after', 'before'
    ]);
    return stopWords.has(word);
  }

  calculateTrend(occurrences) {
    if (occurrences.length < 2) return 'stable';
    
    const cycles = occurrences.map(o => o.cycle);
    const intervals = [];
    for (let i = 1; i < cycles.length; i++) {
      intervals.push(cycles[i] - cycles[i - 1]);
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    
    // Decreasing intervals = increasing frequency
    const lastHalf = intervals.slice(Math.floor(intervals.length / 2));
    const lastAvg = lastHalf.reduce((a, b) => a + b, 0) / lastHalf.length;

    if (lastAvg < avgInterval * 0.7) return 'increasing';
    if (lastAvg > avgInterval * 1.3) return 'decreasing';
    return 'stable';
  }

  detectEvolutions(thoughts) {
    const evolutions = [];
    
    // Look for patterns like "initially X, but now Y"
    for (let i = 0; i < thoughts.length - 2; i++) {
      const early = thoughts.slice(i, i + 3);
      const late = thoughts.slice(Math.max(i + 5, thoughts.length - 3));
      
      if (late.length < 2) continue;

      const earlyText = early.map(t => t.content).join(' ').toLowerCase();
      const lateText = late.map(t => t.content).join(' ').toLowerCase();

      // Detect shift markers
      if (this.hasEvolutionaryLanguage(earlyText, lateText)) {
        evolutions.push({
          type: 'evolution',
          fromCycle: early[0].cycle || early[0].cycleCount,
          toCycle: late[late.length - 1].cycle || late[late.length - 1].cycleCount,
          description: `Concept evolution detected between cycles ${early[0].cycle} and ${late[late.length - 1].cycle}`,
          significance: 0.7
        });
      }
    }

    return evolutions;
  }

  hasEvolutionaryLanguage(earlyText, lateText) {
    const evolutionMarkers = [
      'initially', 'originally', 'first', 'began',
      'now', 'currently', 'evolved', 'changed',
      'realized', 'discovered', 'found', 'learned'
    ];

    const earlyMarkers = evolutionMarkers.filter(m => earlyText.includes(m)).length;
    const lateMarkers = evolutionMarkers.filter(m => lateText.includes(m)).length;

    return earlyMarkers > 0 || lateMarkers > 1;
  }

  /**
   * Cluster related concepts
   */
  clusterConcepts(memory) {
    if (!memory || memory.length < this.config.minClusterSize) {
      return [];
    }

    const clusters = [];
    const used = new Set();

    for (let i = 0; i < memory.length; i++) {
      if (used.has(i)) continue;

      const cluster = [memory[i]];
      used.add(i);

      // Find similar nodes
      for (let j = i + 1; j < memory.length; j++) {
        if (used.has(j)) continue;

        if (this.areSimilar(memory[i], memory[j])) {
          cluster.push(memory[j]);
          used.add(j);
        }
      }

      if (cluster.length >= this.config.minClusterSize) {
        clusters.push({
          size: cluster.length,
          centralConcept: this.extractCentralConcept(cluster),
          members: cluster.map(n => ({
            id: n.id,
            content: (n.content || '').substring(0, 100),
            activation: n.activation
          })),
          avgActivation: cluster.reduce((sum, n) => sum + (n.activation || 0.5), 0) / cluster.length
        });
      }
    }

    return clusters.sort((a, b) => b.avgActivation - a.avgActivation);
  }

  areSimilar(node1, node2) {
    const tags1 = new Set(node1.tags || []);
    const tags2 = new Set(node2.tags || []);
    
    // Check tag overlap
    const tagOverlap = [...tags1].filter(t => tags2.has(t)).length;
    const tagSimilarity = tagOverlap / Math.max(tags1.size, tags2.size, 1);

    // Check content similarity (simple word overlap)
    const words1 = new Set((node1.content || '').toLowerCase().split(/\s+/));
    const words2 = new Set((node2.content || '').toLowerCase().split(/\s+/));
    const wordOverlap = [...words1].filter(w => words2.has(w)).length;
    const wordSimilarity = wordOverlap / Math.max(words1.size, words2.size, 1);

    const overallSimilarity = (tagSimilarity * 0.6) + (wordSimilarity * 0.4);
    return overallSimilarity >= this.config.similarityThreshold;
  }

  extractCentralConcept(cluster) {
    // Find most common words across cluster
    const wordCounts = {};
    
    for (const node of cluster) {
      const words = (node.content || '').toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length > 4 && !this.isStopWord(word)) {
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
      }
    }

    const topWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);

    return topWords.join(', ');
  }

  /**
   * Identify breakthrough moments
   */
  identifyBreakthroughs(memory, thoughts) {
    const breakthroughs = [];

    // Look in memory for breakthrough tags
    for (const node of memory) {
      const tags = node.tags || [];
      const isBreakthrough = tags.some(t => 
        t.includes('breakthrough') || 
        t.includes('discovery') || 
        t.includes('insight')
      );

      if (isBreakthrough) {
        const score = (node.activation || 0.5) * (node.weight || 0.5);
        if (score >= this.config.breakthroughScoreThreshold) {
          breakthroughs.push({
            type: 'memory',
            id: node.id,
            content: (node.content || '').substring(0, 150),
            score,
            cycle: node.cycle || node.cycleCount,
            tags
          });
        }
      }
    }

    // Look in thoughts for breakthrough language
    for (const thought of thoughts) {
      const content = thought.content || '';
      const hasBreakthroughLanguage = 
        /\b(breakthrough|discovered|realized|found|aha|eureka|insight)\b/i.test(content);

      if (hasBreakthroughLanguage) {
        breakthroughs.push({
          type: 'thought',
          content: content.substring(0, 150),
          cycle: thought.cycle || thought.cycleCount
        });
      }
    }

    return breakthroughs.sort((a, b) => (b.score || 0.5) - (a.score || 0.5));
  }

  /**
   * Analyze cross-instance patterns (hive mode)
   */
  analyzeCrossInstance(state, memory) {
    if (!state.isCluster || !state.instances) {
      return null;
    }

    const byInstance = {};
    for (const node of memory) {
      const inst = node.instanceId || 'unknown';
      if (!byInstance[inst]) {
        byInstance[inst] = [];
      }
      byInstance[inst].push(node);
    }

    const comparisons = [];
    const instances = Object.keys(byInstance);

    // Compare each pair of instances
    for (let i = 0; i < instances.length; i++) {
      for (let j = i + 1; j < instances.length; j++) {
        const inst1 = instances[i];
        const inst2 = instances[j];
        
        const similarity = this.calculateInstanceSimilarity(byInstance[inst1], byInstance[inst2]);
        
        comparisons.push({
          instances: [inst1, inst2],
          similarity,
          uniqueToFirst: byInstance[inst1].length - similarity.overlap,
          uniqueToSecond: byInstance[inst2].length - similarity.overlap,
          sharedConcepts: similarity.sharedConcepts
        });
      }
    }

    return {
      instanceCount: instances.length,
      comparisons,
      summary: this.summarizeCrossInstance(comparisons)
    };
  }

  calculateInstanceSimilarity(nodes1, nodes2) {
    const tags1 = new Set(nodes1.flatMap(n => n.tags || []));
    const tags2 = new Set(nodes2.flatMap(n => n.tags || []));
    
    const sharedTags = [...tags1].filter(t => tags2.has(t));
    const similarity = sharedTags.length / Math.max(tags1.size, tags2.size, 1);

    return {
      score: similarity,
      overlap: sharedTags.length,
      sharedConcepts: sharedTags.slice(0, 5)
    };
  }

  summarizeCrossInstance(comparisons) {
    if (comparisons.length === 0) return 'No cross-instance data';

    const avgSimilarity = comparisons.reduce((sum, c) => sum + c.similarity.score, 0) / comparisons.length;
    
    if (avgSimilarity > 0.7) return 'High consensus across instances';
    if (avgSimilarity > 0.4) return 'Moderate agreement with some divergence';
    return 'Significant divergence between instances';
  }

  /**
   * Generate summary of all insights
   */
  generateInsightSummary(patterns, clusters, breakthroughs, crossInstance) {
    const parts = [];

    if (patterns.length > 0) {
      parts.push(`${patterns.length} temporal pattern(s)`);
    }

    if (clusters.length > 0) {
      parts.push(`${clusters.length} concept cluster(s)`);
    }

    if (breakthroughs.length > 0) {
      parts.push(`${breakthroughs.length} breakthrough(s)`);
    }

    if (crossInstance) {
      parts.push(crossInstance.summary);
    }

    return parts.length > 0 ? parts.join(' • ') : 'Limited synthesis data available';
  }
}

module.exports = { InsightSynthesizer };

