// src/system/introspection-router.js
const path = require('path');

/**
 * IntrospectionRouter - Semantic routing for agent outputs
 * 
 * Purpose:
 * - Scores introspected files by importance
 * - Categorizes outputs for routing to appropriate agents
 * - Surfaces critical issues and opportunities
 * - Provides structured hints for coordinator
 * 
 * Design:
 * - Heuristic-based scoring (no GPT calls)
 * - Fast, bounded, predictable
 * - Provides actionable routing hints
 */
class IntrospectionRouter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = config.introspection?.routingEnabled || false;
    this.max = config.introspection?.maxRoutedItems || 5;
  }

  /**
   * Score items by importance using heuristics
   * @param {Array} items - Items from introspection scan
   * @returns {Array} Scored items sorted by importance
   */
  async score(items) {
    if (!this.enabled || !items || !items.length) return [];

    const scored = items.map(i => {
      let s = 0;
      
      // Agent type scoring
      if (i.agentType === 'code-creation') s += 2;
      if (i.agentType === 'document-analysis') s += 2;
      if (i.agentType === 'synthesis') s += 1.5;
      if (i.agentType === 'code-execution') s += 1;
      
      // Content-based scoring
      if (/error|fail|issue|bug/i.test(i.preview)) s += 1;
      if (/manifest|validation|drift/i.test(i.preview)) s += 1;
      if (/important|critical|key|urgent/i.test(i.preview)) s += 0.5;
      if (/conclusion|findings|results|summary/i.test(i.preview)) s += 0.5;
      if (/contradiction|conflict|inconsistent/i.test(i.preview)) s += 1;
      
      return { ...i, score: s };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.max);
  }

  /**
   * Build routing hints for coordinator and agents
   * @param {Array} scored - Scored items from score()
   * @returns {Object} Categorized hints
   */
  buildHints(scored) {
    const hints = {
      critic: [],
      synthesis: [],
      reuse: [],
      research: []
    };

    for (const s of scored) {
      const fileName = path.basename(s.filePath);
      
      // Route to critic if issues detected
      if (/contradiction|conflict|error|fail/i.test(s.preview)) {
        hints.critic.push({
          file: fileName,
          agentType: s.agentType,
          reason: 'Issue/contradiction detected',
          score: s.score
        });
      }
      
      // Route to synthesis if analysis complete
      if (s.agentType === 'document-analysis' || /conclusion|findings/i.test(s.preview)) {
        hints.synthesis.push({
          file: fileName,
          agentType: s.agentType,
          reason: 'Analysis ready for synthesis',
          score: s.score
        });
      }
      
      // Flag reusable code
      if (s.agentType === 'code-creation') {
        hints.reuse.push({
          file: fileName,
          agentType: s.agentType,
          reason: 'Code available for reuse',
          score: s.score
        });
      }
      
      // Flag research opportunities
      if (/open question|future work|next steps|research needed/i.test(s.preview)) {
        hints.research.push({
          file: fileName,
          agentType: s.agentType,
          reason: 'Research opportunity identified',
          score: s.score
        });
      }
    }

    return hints;
  }
}

module.exports = { IntrospectionRouter };

