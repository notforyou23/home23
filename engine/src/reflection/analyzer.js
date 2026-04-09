const { UnifiedClient } = require('../core/unified-client');

/**
 * Reflection Analyzer - GPT-5.2 Version
 * Uses GPT-5.2 extended reasoning for deeper pattern analysis
 */
class ReflectionAnalyzer {
  constructor(config, logger, fullConfig = null) {
    this.config = config.reflection;
    this.logger = logger;
    // Use fullConfig if provided, otherwise assume config IS the full config  
    this.fullConfig = fullConfig || config;
    this.gpt5 = new UnifiedClient(this.fullConfig, logger);
    
    this.lastAnalysis = null;
    this.patterns = new Map();
    this.strategies = new Map();
    this.improvements = [];
  }

  /**
   * Analyze journal using GPT-5.2 with extended reasoning
   */
  async analyzeJournal(journal) {
    if (!this.config.enabled || !journal || journal.length < 10) {
      return null;
    }

    // Only analyze recent entries, keep it focused
    const recentEntries = journal.slice(-20); // Reduced from 50
    const thoughtText = recentEntries
      .map(e => (e.thought || e.output || '').substring(0, 100)) // Truncate each thought
      .join('\n')
      .substring(0, 1000); // Keep total input small

    const response = await this.gpt5.generate({
      model: 'gpt-5.2', // Meta-analysis benefits from reasoning
      instructions: `Brief meta-analysis: Identify ONE key pattern and ONE improvement area.`,
      messages: [{ role: 'user', content: `Recent thoughts:\n${thoughtText}\n\nProvide ONE pattern and ONE improvement (2-3 sentences each).` }],
      max_completion_tokens: 10000, // Meta-cognitive analysis needs space
      reasoningEffort: 'medium' // Meta-analysis needs reasoning
    });

    const analysis = this.parseAnalysis(response.content);
    
    this.lastAnalysis = {
      ...analysis,
      reasoning: response.reasoning,
      timestamp: new Date(),
      journalSize: journal.length,
      model: response.model
    };

    // Store patterns
    if (analysis.patterns) {
      for (const pattern of analysis.patterns) {
        this.recordPattern(pattern);
      }
    }

    // Store strategies
    if (analysis.strategies) {
      for (const strategy of analysis.strategies) {
        this.recordStrategy(strategy);
      }
    }

    // Store improvements
    if (analysis.improvements) {
      this.improvements.push(...analysis.improvements.map(imp => ({
        ...imp,
        timestamp: new Date(),
        applied: false
      })));
    }

    this.logger?.info('Journal analyzed (GPT-5.2)', {
      patterns: analysis.patterns?.length || 0,
      strategies: analysis.strategies?.length || 0,
      improvements: analysis.improvements?.length || 0,
      hasReasoning: Boolean(response.reasoning)
    });

    return this.lastAnalysis;
  }

  /**
   * Parse analysis from GPT-5.2 response
   */
  parseAnalysis(content) {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      // GPT-5.2 might provide structured text instead of JSON
      return this.parseStructuredText(content);
    }

    return {
      patterns: [],
      strategies: [],
      improvements: [],
      insights: []
    };
  }

  /**
   * Parse structured text output from GPT-5
   */
  parseStructuredText(content) {
    const result = {
      patterns: [],
      strategies: [],
      improvements: [],
      insights: []
    };

    const sections = content.split(/\n\n/);
    
    for (const section of sections) {
      if (section.toLowerCase().includes('pattern')) {
        const items = section.match(/[-•]\s*(.+)/g) || [];
        result.patterns.push(...items.map(i => ({ 
          pattern: i.replace(/^[-•]\s*/, '').trim(),
          frequency: 1,
          significance: 'detected'
        })));
      }
      if (section.toLowerCase().includes('strateg')) {
        const items = section.match(/[-•]\s*(.+)/g) || [];
        result.strategies.push(...items.map(i => ({
          strategy: i.replace(/^[-•]\s*/, '').trim(),
          effectiveness: 0.7,
          context: 'general'
        })));
      }
      if (section.toLowerCase().includes('improve')) {
        const items = section.match(/[-•]\s*(.+)/g) || [];
        result.improvements.push(...items.map(i => ({
          area: 'general',
          suggestion: i.replace(/^[-•]\s*/, '').trim()
        })));
      }
    }

    return result;
  }

  recordPattern(pattern) {
    const key = pattern.pattern;
    const existing = this.patterns.get(key);

    if (existing) {
      existing.occurrences++;
      existing.lastSeen = new Date();
    } else {
      this.patterns.set(key, {
        pattern: pattern.pattern,
        frequency: pattern.frequency || 1,
        significance: pattern.significance || 'unknown',
        occurrences: 1,
        firstSeen: new Date(),
        lastSeen: new Date()
      });
    }
  }

  recordStrategy(strategy) {
    const key = strategy.strategy;
    const existing = this.strategies.get(key);

    if (existing) {
      existing.uses++;
      existing.effectiveness = (existing.effectiveness + strategy.effectiveness) / 2;
    } else {
      this.strategies.set(key, {
        strategy: strategy.strategy,
        effectiveness: strategy.effectiveness || 0.5,
        context: strategy.context || 'general',
        uses: 1,
        discovered: new Date()
      });
    }
  }

  getImprovements() {
    return this.improvements.filter(imp => !imp.applied);
  }

  applyImprovement(improvementIndex) {
    if (improvementIndex >= 0 && improvementIndex < this.improvements.length) {
      this.improvements[improvementIndex].applied = true;
      this.improvements[improvementIndex].appliedAt = new Date();
    }
  }

  /**
   * Suggest prompt evolution using GPT-5.2 meta-reasoning
   */
  async suggestPromptEvolution(currentPrompt, role) {
    if (!this.config.promptEvolutionEnabled) return null;

    const topStrategies = Array.from(this.strategies.values())
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, 3)
      .map(s => s.strategy)
      .join('\n');

    const response = await this.gpt5.generate({
      model: 'gpt-5.2', // Meta-improvement of prompts needs reasoning
      instructions: `Improve this AI role prompt by incorporating effective strategies while maintaining core purpose.

Current prompt: "${currentPrompt}"
Effective strategies: ${topStrategies}

Provide only the improved prompt, no explanation.`,
      messages: [{ role: 'user', content: 'Improve this prompt.' }],
      maxTokens: 15000, // Meta-cognitive prompt improvement needs space
      reasoningEffort: 'high' // Improving system's own prompts is complex meta-cognition
    });

    this.logger?.info('Prompt evolution suggested (GPT-5.2)', {
      role,
      hasReasoning: Boolean(response.reasoning)
    });

    return response.content.trim();
  }

  detectFailurePatterns(journal) {
    const failures = journal.filter(entry => 
      entry.success === false || 
      (entry.thought && (
        entry.thought.includes('error') ||
        entry.thought.includes('failed') ||
        entry.thought.includes('stuck')
      ))
    );

    if (failures.length < this.config.patternDetectionThreshold) {
      return [];
    }

    const grouped = new Map();
    
    for (const failure of failures) {
      const key = this.extractKey(failure.thought || '');
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(failure);
    }

    const patterns = [];
    for (const [key, items] of grouped) {
      if (items.length >= this.config.patternDetectionThreshold) {
        patterns.push({
          pattern: key,
          occurrences: items.length,
          type: 'failure'
        });
      }
    }

    return patterns;
  }

  extractKey(text) {
    const words = text.toLowerCase().match(/\b\w{4,}\b/g) || [];
    return words.slice(0, 3).join(' ');
  }

  getMetaCognitiveInsights() {
    const insights = [];

    if (this.patterns.size < 3) {
      insights.push({
        type: 'low_diversity',
        message: 'Thinking patterns becoming repetitive',
        suggestion: 'Inject more exploration or try different perspectives'
      });
    }

    const strategies = Array.from(this.strategies.values());
    const avgEffectiveness = strategies.reduce((sum, s) => sum + s.effectiveness, 0) / strategies.length;
    
    if (avgEffectiveness < 0.5) {
      insights.push({
        type: 'low_effectiveness',
        message: 'Current strategies showing low effectiveness',
        suggestion: 'Consider trying new approaches'
      });
    }

    const pending = this.improvements.filter(i => !i.applied);
    if (pending.length > 5) {
      insights.push({
        type: 'improvements_pending',
        message: `${pending.length} improvements identified but not applied`,
        suggestion: 'Review and implement pending improvements'
      });
    }

    return insights;
  }

  getStats() {
    return {
      lastAnalysis: this.lastAnalysis?.timestamp || null,
      patternsDetected: this.patterns.size,
      strategiesLearned: this.strategies.size,
      improvementsPending: this.improvements.filter(i => !i.applied).length,
      improvementsApplied: this.improvements.filter(i => i.applied).length,
      usingGPT5: true,
      extendedReasoning: true,
      topPatterns: Array.from(this.patterns.values())
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 3),
      topStrategies: Array.from(this.strategies.values())
        .sort((a, b) => b.effectiveness - a.effectiveness)
        .slice(0, 3)
    };
  }

  export() {
    return {
      patterns: Array.from(this.patterns.entries()),
      strategies: Array.from(this.strategies.entries()),
      improvements: this.improvements,
      lastAnalysis: this.lastAnalysis
    };
  }

  import(data) {
    if (data.patterns) this.patterns = new Map(data.patterns);
    if (data.strategies) this.strategies = new Map(data.strategies);
    if (data.improvements) this.improvements = data.improvements;
    if (data.lastAnalysis) this.lastAnalysis = data.lastAnalysis;
  }
}

module.exports = { ReflectionAnalyzer };

