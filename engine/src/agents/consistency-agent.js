const { BaseAgent } = require('./base-agent');

/**
 * ConsistencyAgent
 *
 * Evaluates divergence among top branch hypotheses and produces
 * a concise summary plus recommendations. Designed to operate quickly
 * with low reasoning effort to avoid additional cost.
 */
class ConsistencyAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.branches = mission.metadata?.branches || [];
    this.divergence = mission.metadata?.divergenceScore || 0;
    this.cycle = mission.metadata?.cycle || null;
  }

  async execute() {
    if (!Array.isArray(this.branches) || this.branches.length === 0) {
      return {
        status: 'skipped',
        reason: 'No branch data provided'
      };
    }

    await this.reportProgress(10, 'Preparing branch comparison');

    const analysisPrompt = this.buildPrompt();

    const response = await this.gpt5.generateFast({
      model: 'gpt-5-mini',
      instructions: 'Assess agreement among branch hypotheses and highlight conflicts. Provide concise recommendations.',
      messages: [{ role: 'user', content: analysisPrompt }],
      maxTokens: 2000, // Increased from 800 - consistency checks need space for thorough analysis
      reasoningEffort: 'low'
    });

    const summary = response?.content?.trim() || 'No analysis generated.';

    await this.reportProgress(70, 'Recording findings to memory');
    await this.addFinding(`Cycle ${this.cycle || '?'} consistency review (divergence ${this.divergence.toFixed(2)}):\n${summary}`, 'consistency_review');

    await this.reportProgress(100, 'Consistency review complete');

    this.results.push({
      type: 'consistency_review',
      cycle: this.cycle,
      divergence: this.divergence,
      summary,
      tokenUsage: response?.usage || null,
      timestamp: new Date()
    });

    return {
      status: 'completed',
      cycle: this.cycle,
      divergence: this.divergence,
      summary
    };
  }

  buildPrompt() {
    const header = `Cycle: ${this.cycle || '?'}\nDivergence Score: ${this.divergence.toFixed(2)}\n\nAssess the following branch hypotheses:`;
    const branchLines = this.branches.map((branch, index) => {
      const label = `Branch ${index + 1}`;
      const hypothesis = branch.hypothesis?.substring(0, 500) || 'N/A';
      const reasoning = branch.reasoning ? `Reasoning: ${branch.reasoning.substring(0, 400)}` : '';
      return `${label}: ${hypothesis}\n${reasoning}`.trim();
    });

    return `${header}\n\n${branchLines.join('\n\n')}\n\nProvide:\n1. Areas of agreement\n2. Conflicting points\n3. Recommended synthesis or next action.`;
  }
}

module.exports = {
  ConsistencyAgent
};
