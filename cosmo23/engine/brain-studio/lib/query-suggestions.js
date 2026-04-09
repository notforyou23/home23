/**
 * Query Suggestions
 * Analyzes current state to suggest high-value queries
 */

class QuerySuggester {
  constructor() {
    this.suggestionTemplates = {
      temporal: [
        "How has {concept} evolved over time?",
        "What patterns emerged around cycle {cycle}?",
        "When did you first discover {concept}?"
      ],
      causal: [
        "What caused {concept}?",
        "How does {concept1} relate to {concept2}?",
        "Why did {concept} change?"
      ],
      breakthrough: [
        "What were your biggest breakthroughs?",
        "What insights surprised you the most?",
        "What did you discover about {concept}?"
      ],
      comparative: [
        "How does {instance1} compare to {instance2}?",
        "What's unique about {concept}?",
        "What are the differences between {concept1} and {concept2}?"
      ],
      meta: [
        "What did the coordinator recommend?",
        "What areas need more exploration?",
        "What are the current research priorities?"
      ]
    };
  }

  /**
   * Generate query suggestions based on current state
   */
  async generateSuggestions(state, memory, thoughts, coordinatorInsights) {
    const suggestions = [];

    // Analyze what's interesting in current state
    const topConcepts = this.extractTopConcepts(memory);
    const recentThemes = this.extractRecentThemes(thoughts);
    const breakthroughCandidates = this.findBreakthroughCandidates(memory);
    
    // Generate temporal suggestions
    if (state.cycleCount > 10) {
      suggestions.push(...this.generateTemporalSuggestions(topConcepts, state));
    }

    // Generate causal suggestions
    if (topConcepts.length >= 2) {
      suggestions.push(...this.generateCausalSuggestions(topConcepts));
    }

    // Generate breakthrough suggestions
    if (breakthroughCandidates.length > 0) {
      suggestions.push(...this.generateBreakthroughSuggestions(breakthroughCandidates));
    }

    // Generate comparative suggestions (cluster mode)
    if (state.isCluster && state.instances) {
      suggestions.push(...this.generateComparativeSuggestions(state));
    }

    // Generate meta suggestions from coordinator
    if (coordinatorInsights && coordinatorInsights.length > 0) {
      suggestions.push(...this.generateMetaSuggestions(coordinatorInsights));
    }

    // Rank and return top suggestions
    return this.rankSuggestions(suggestions).slice(0, 10);
  }

  /**
   * Extract top concepts from memory
   */
  extractTopConcepts(memory) {
    if (!memory || memory.length === 0) return [];

    // Score concepts by activation and weight
    const concepts = memory
      .map(node => ({
        content: this.extractKeyPhrase(node.content),
        score: (node.activation || 0.5) * (node.weight || 0.5),
        tags: node.tags || []
      }))
      .filter(c => c.content && c.content.length > 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return concepts;
  }

  extractKeyPhrase(content) {
    if (!content) return '';
    
    // Try to extract a meaningful phrase (first few words or key terms)
    const cleaned = content.trim().replace(/^[-*•]\s*/, '');
    const words = cleaned.split(/\s+/);
    
    if (words.length <= 5) return cleaned;
    return words.slice(0, 5).join(' ') + '...';
  }

  /**
   * Extract recent themes from thoughts
   */
  extractRecentThemes(thoughts) {
    if (!thoughts || thoughts.length === 0) return [];

    // Get recent thoughts (last 20%)
    const sorted = [...thoughts].sort((a, b) => 
      (b.cycle || b.cycleCount || 0) - (a.cycle || a.cycleCount || 0)
    );
    const recent = sorted.slice(0, Math.ceil(sorted.length * 0.2));

    // Extract common words/phrases
    const wordCounts = {};
    for (const thought of recent) {
      const words = (thought.content || '').toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length > 5) {
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
      }
    }

    return Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(e => e[0]);
  }

  /**
   * Find breakthrough candidates
   */
  findBreakthroughCandidates(memory) {
    if (!memory) return [];

    return memory.filter(node => {
      const tags = node.tags || [];
      return tags.some(t => 
        t.includes('breakthrough') || 
        t.includes('discovery') ||
        t.includes('insight')
      );
    }).slice(0, 5);
  }

  /**
   * Generate temporal suggestions
   */
  generateTemporalSuggestions(concepts, state) {
    const suggestions = [];
    const templates = this.suggestionTemplates.temporal;

    if (concepts.length > 0) {
      const concept = concepts[0].content;
      suggestions.push({
        category: 'temporal',
        query: templates[0].replace('{concept}', concept),
        reason: 'Explore how key concepts evolved',
        priority: 0.8
      });
    }

    if (state.cycleCount > 20) {
      const midCycle = Math.floor(state.cycleCount / 2);
      suggestions.push({
        category: 'temporal',
        query: templates[1].replace('{cycle}', midCycle),
        reason: 'Investigate patterns from middle of research',
        priority: 0.6
      });
    }

    return suggestions;
  }

  /**
   * Generate causal suggestions
   */
  generateCausalSuggestions(concepts) {
    const suggestions = [];
    const templates = this.suggestionTemplates.causal;

    if (concepts.length >= 2) {
      suggestions.push({
        category: 'causal',
        query: templates[1]
          .replace('{concept1}', concepts[0].content)
          .replace('{concept2}', concepts[1].content),
        reason: 'Explore relationships between key concepts',
        priority: 0.9
      });
    }

    if (concepts.length >= 1) {
      suggestions.push({
        category: 'causal',
        query: templates[0].replace('{concept}', concepts[0].content),
        reason: 'Understand root causes',
        priority: 0.7
      });
    }

    return suggestions;
  }

  /**
   * Generate breakthrough suggestions
   */
  generateBreakthroughSuggestions(breakthroughs) {
    const suggestions = [];
    const templates = this.suggestionTemplates.breakthrough;

    suggestions.push({
      category: 'breakthrough',
      query: templates[0],
      reason: 'Review major discoveries',
      priority: 1.0
    });

    if (breakthroughs.length > 0) {
      const content = this.extractKeyPhrase(breakthroughs[0].content);
      suggestions.push({
        category: 'breakthrough',
        query: templates[2].replace('{concept}', content),
        reason: 'Deep dive into specific breakthrough',
        priority: 0.85
      });
    }

    return suggestions;
  }

  /**
   * Generate comparative suggestions (cluster mode)
   */
  generateComparativeSuggestions(state) {
    const suggestions = [];
    const templates = this.suggestionTemplates.comparative;

    if (state.instances && state.instances.length >= 2) {
      const inst1 = state.instances[0].name || 'instance-1';
      const inst2 = state.instances[1].name || 'instance-2';
      
      suggestions.push({
        category: 'comparative',
        query: templates[0]
          .replace('{instance1}', inst1)
          .replace('{instance2}', inst2),
        reason: 'Compare cluster instances',
        priority: 0.75
      });
    }

    return suggestions;
  }

  /**
   * Generate meta suggestions from coordinator
   */
  generateMetaSuggestions(coordinatorInsights) {
    const suggestions = [];
    const templates = this.suggestionTemplates.meta;

    suggestions.push({
      category: 'meta',
      query: templates[0],
      reason: 'Review coordinator recommendations',
      priority: 0.9
    });

    // Extract specific topics from coordinator insights
    if (coordinatorInsights.length > 0) {
      const firstInsight = coordinatorInsights[0];
      if (firstInsight.title) {
        suggestions.push({
          category: 'meta',
          query: `What did the coordinator say about ${firstInsight.title.toLowerCase()}?`,
          reason: 'Explore specific coordinator insight',
          priority: 0.7
        });
      }
    }

    return suggestions;
  }

  /**
   * Rank suggestions by priority and diversity
   */
  rankSuggestions(suggestions) {
    // Ensure diversity across categories
    const byCategory = {};
    for (const suggestion of suggestions) {
      const cat = suggestion.category;
      if (!byCategory[cat]) {
        byCategory[cat] = [];
      }
      byCategory[cat].push(suggestion);
    }

    // Take top suggestions from each category
    const ranked = [];
    const maxPerCategory = 3;

    for (const [category, items] of Object.entries(byCategory)) {
      const sorted = items.sort((a, b) => b.priority - a.priority);
      ranked.push(...sorted.slice(0, maxPerCategory));
    }

    // Sort by priority
    return ranked.sort((a, b) => b.priority - a.priority);
  }
}

module.exports = { QuerySuggester };

