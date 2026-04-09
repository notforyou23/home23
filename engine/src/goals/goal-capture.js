const { getOpenAIClient } = require('../core/openai-client');
const { UnifiedClient } = require('../core/unified-client');

/**
 * Goal Capture System - GPT-5.2 Version
 * Uses GPT-5.2 with extended reasoning and web search for goal analysis
 */
class GoalCaptureSystem {
  constructor(config, logger, fullConfig = null) {
    this.logger = logger;
    this.config = config;
    // Use fullConfig if provided, otherwise assume config IS the full config
    this.fullConfig = fullConfig || config;
    this.gpt5 = new UnifiedClient(this.fullConfig, logger);
    
    // Patterns for goal detection
    this.goalPatterns = [
      /I wonder (how|why|what|when|where|if) (.+?)[\.\?]/gi,
      /I should (learn|understand|investigate|explore|figure out) (.+?)[\.\?]/gi,
      /I need to (research|study|examine|analyze) (.+?)[\.\?]/gi,
      /It would be interesting to (.+?)[\.\?]/gi,
      /I'm curious about (.+?)[\.\?]/gi,
      /I'll have to (.+?) later/gi,
      /TODO: (.+?)[\.\n]/gi,
      /GOAL: (.+?)[\.\n]/gi,
      /\?\?(.+?)\?\?/gi
    ];

    this.uncertaintyPatterns = [
      /I'm not sure (about|how|why|what|if) (.+?)[\.\?]/gi,
      /uncertain (about|how|why|what) (.+?)[\.\?]/gi,
      /don't (know|understand) (.+?)[\.\?]/gi,
      /remains to be (seen|determined|answered)/gi,
      /still unclear (.+?)[\.\?]/gi
    ];
  }

  /**
   * Capture goals from output (pattern-based + GPT-5.2 AI analysis)
   */
  async captureGoalsFromOutput(output) {
    const patternGoals = this.capturePatternGoals(output);
    
    // Use GPT-5.2 to analyze for implicit goals (only for substantial outputs)
    const aiGoals = output.length > 100 ? await this.captureGoalsWithGPT5(output) : [];
    
    const all = [...patternGoals, ...aiGoals];
    const unique = this.deduplicateGoals(all);

    if (unique.length > 0) {
      this.logger?.info('Goals captured (GPT-5.2)', {
        total: unique.length,
        pattern: patternGoals.length,
        aiDetected: aiGoals.length
      });
    }

    return unique;
  }

  /**
   * Capture goals using patterns
   */
  capturePatternGoals(output) {
    const captured = [];

    for (const pattern of this.goalPatterns) {
      const matches = [...output.matchAll(pattern)];
      
      for (const match of matches) {
        const goalText = this.extractGoalText(match);
        if (goalText && goalText.length > 10) {
          captured.push({
            text: goalText,
            source: 'explicit_pattern',
            priority: 'medium'
          });
        }
      }
    }

    for (const pattern of this.uncertaintyPatterns) {
      const matches = [...output.matchAll(pattern)];
      
      for (const match of matches) {
        const goalText = this.extractGoalText(match);
        if (goalText && goalText.length > 10) {
          captured.push({
            text: `Resolve uncertainty: ${goalText}`,
            source: 'uncertainty',
            priority: 'low'
          });
        }
      }
    }

    const questions = this.extractQuestions(output);
    for (const question of questions) {
      captured.push({
        text: question,
        source: 'question',
        priority: 'medium'
      });
    }

    return captured;
  }

  /**
   * Use GPT-5.2 to detect implicit goals
   */
  async captureGoalsWithGPT5(output) {
    try {
      const response = await this.gpt5.generateFast({
        model: 'gpt-5-mini',
        instructions: `Analyze this AI thought and identify any implicit curiosities or topics that warrant investigation. List only clear, specific goals. Be concise.`,
        messages: [{ role: 'user', content: output.substring(0, 1000) }],
        max_completion_tokens: 1024, // API minimum for gpt-5-mini (was 200 - too low!)
        reasoningEffort: 'low'
      });

      const goals = this.parseGoalsFromText(response.content);
      
      return goals.map(g => ({
        text: g,
        source: 'ai_detected',
        priority: 'low'
      }));
    } catch (error) {
      return [];
    }
  }

  /**
   * Analyze journal using GPT-5.2 with extended reasoning
   */
  async analyzeJournalForGoals(journal) {
    if (!journal || journal.length < 5) {
      return [];
    }

    const recentThoughts = journal.slice(-30)
      .map(e => e.thought || e.output || '')
      .join('\n\n');

    const response = await this.gpt5.generate({
      model: 'gpt-5-mini', // Use mini - more reliable, less prone to incomplete responses
      instructions: `Analyze these AI thoughts and identify unresolved questions, incomplete explorations, or topics that warrant deeper investigation.`,
      messages: [{ role: 'user', content: recentThoughts }],
      maxTokens: 1000, // Reasonable limit for goal identification
      reasoningEffort: 'low' // Goal capture is efficient with low reasoning
    });

    const goals = this.parseGoalsFromText(response.content);

    this.logger?.info('Journal analyzed for goals (GPT-5.2)', {
      found: goals.length,
      hasReasoning: Boolean(response.reasoning),
      entriesAnalyzed: Math.min(30, journal.length)
    });

    return goals.map(text => ({
      text,
      source: 'journal_analysis',
      priority: 'medium',
      reason: 'Identified through GPT-5.2 extended reasoning'
    }));
  }

  /**
   * Prioritize goal using GPT-5
   */
  async prioritizeGoal(goalText, context = {}) {
    const response = await this.gpt5.generateFast({
      model: 'gpt-5-mini',
      instructions: 'Rate this goal priority (high/medium/low). Respond with ONLY: high, medium, or low',
      messages: [{ role: 'user', content: `Goal: "${goalText}"` }],
      max_completion_tokens: 1024, // API minimum for gpt-5-mini (was 50 - too low!)
      reasoningEffort: 'low'
    });

    const priority = response.content.trim().toLowerCase();
    return ['high', 'medium', 'low'].includes(priority) ? priority : 'medium';
  }

  extractGoalText(match) {
    const parts = match.slice(1).filter(p => p !== undefined);
    return parts.join(' ').trim();
  }

  extractQuestions(text) {
    const sentences = text.split(/[\.!]\s+/);
    const questions = [];

    for (const sentence of sentences) {
      if (sentence.includes('?') && sentence.length > 20 && sentence.length < 300) {
        const cleaned = sentence.replace(/\?+$/, '').trim();
        if (cleaned.length > 10) {
          questions.push(cleaned);
        }
      }
    }

    return questions;
  }

  parseGoalsFromText(text) {
    const lines = text.split('\n').filter(l => l.trim().length > 10);
    const goals = [];

    for (const line of lines) {
      if (/^[\d\-\*•]\s*\.?\s*(.+)/.test(line)) {
        const cleaned = line.replace(/^[\d\-\*•]\s*\.?\s*/, '').trim();
        if (cleaned.length > 15 && cleaned.length < 300) {
          goals.push(cleaned);
        }
      }
    }

    return goals.slice(0, 5);
  }

  deduplicateGoals(goals) {
    if (goals.length === 0) return [];

    const unique = [];
    const seen = new Set();

    for (const goal of goals) {
      const normalized = goal.text.toLowerCase().replace(/[^\w\s]/g, '');
      const key = normalized.split(/\s+/).slice(0, 5).join(' ');

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(goal);
      }
    }

    return unique;
  }

  detectSurprise(output) {
    const surpriseIndicators = [
      /surprising/gi, /unexpected/gi, /never thought/gi, /didn't realize/gi,
      /fascinating/gi, /wow/gi, /amazing/gi, /remarkable/gi, /!+/g
    ];

    let surpriseScore = 0;
    for (const pattern of surpriseIndicators) {
      const matches = output.match(pattern);
      if (matches) surpriseScore += matches.length;
    }

    return Math.min(1.0, surpriseScore / 5);
  }
}

module.exports = { GoalCaptureSystem };

