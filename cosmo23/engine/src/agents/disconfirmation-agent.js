/**
 * DisconfirmationAgent — Adversarial hypothesis testing
 *
 * Spawned after consistency-review synthesis cycles.
 * Generates:
 *   1. The most efficient empirical test that could overturn the current best conclusion
 *   2. The assumption whose removal would most destabilize the conclusion
 *   3. A steel-man of the strongest competing hypothesis
 *
 * This agent exists to counter confirmation bias. Multiple branches can converge
 * on the same wrong answer if they share unexamined assumptions. The
 * DisconfirmationAgent is the architectural defense against this.
 */

const { BaseAgent } = require('./base-agent');

class DisconfirmationAgent extends BaseAgent {
  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Preserves the existing adversarial reasoning identity.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## DisconfirmationAgent Behavioral Specification

You are an adversarial reasoning system. Your purpose is to find what could be WRONG.
You are NOT trying to be helpful or agreeable. You counter confirmation bias.

Disconfirmation protocol:
1. Identify the load-bearing assumptions in the current conclusion.
2. Design the most efficient empirical test that could overturn it.
3. Find the single assumption whose removal causes the most cascade damage.
4. Construct the strongest possible alternative hypothesis (steel-man, not straw-man).

Output: exactly three structured outputs — falsification test, critical assumption,
steel-man competing hypothesis. Be rigorous and specific. Do not hedge. Commit to claims.
Multiple branches can converge on the same wrong answer if they share unexamined assumptions.
You are the architectural defense against this.`;
  }

  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.maxDuration = mission.maxDuration || 180000; // 3 minutes
  }

  async execute() {
    const preFlightData = await this.gatherPreFlightContext();

    const conclusion = this.mission.metadata?.conclusion || this.mission.description;
    const supportingEvidence = this.mission.metadata?.supportingEvidence || [];
    const assumptions = this.mission.metadata?.assumptions || [];
    const domain = this.config?.domain || 'general research';

    // Gather context from memory
    let memoryContext = '';
    if (this.memory) {
      try {
        const related = await this.memory.query(conclusion, 15);
        if (related.length > 0) {
          memoryContext = related.map((n, i) =>
            `[Node ${n.id}] (${n.tag}, w=${n.weight?.toFixed(2)}) ${n.concept}`
          ).join('\n\n');
        }
      } catch (err) {
        this.logger.warn('DisconfirmationAgent: memory query failed', { error: err.message });
      }
    }

    // Build the disconfirmation prompt
    const taskPrompt = `You are COSMO's Disconfirmation Module — an adversarial reasoning system.
Your purpose is to find the weakest points in the current best conclusion. You are NOT trying to
be helpful or agreeable. You are trying to find what could be WRONG.

Domain: ${domain}

You must produce exactly three outputs:

## 1. FALSIFICATION TEST
Design the single most efficient empirical test, computation, or experiment that — if it
produced a specific result — would OVERTURN or seriously weaken the conclusion. Be specific:
what would you measure, what result would be damaging, and why?

## 2. CRITICAL ASSUMPTION
Identify the assumption whose removal would most destabilize the conclusion. This is the
load-bearing assumption — the one that, if false, causes the most cascade damage. Explain
WHY this assumption is load-bearing and what would happen if it were wrong.

## 3. STEEL-MAN COMPETING HYPOTHESIS
Construct the strongest possible alternative hypothesis that explains the same evidence
but reaches a different conclusion. This should be the best version of the opposing view,
not a strawman. Explain what evidence it accounts for better than the current conclusion.

Be rigorous and specific. Do not hedge. Commit to claims.`;

    const systemPrompt = this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()) + '\n\n' + taskPrompt;

    const userMessage = `CONCLUSION TO CHALLENGE:
${conclusion}

${assumptions.length > 0 ? `STATED ASSUMPTIONS:\n${assumptions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n` : ''}
${supportingEvidence.length > 0 ? `SUPPORTING EVIDENCE:\n${supportingEvidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n` : ''}
${memoryContext ? `RELATED KNOWLEDGE FROM MEMORY:\n${memoryContext}\n` : ''}
Produce your three outputs now.`;

    await this.reportProgress(20, 'Analyzing conclusion for vulnerabilities');

    const response = await this.gpt5.generate({
      component: 'disconfirmation',
      purpose: 'adversarial_analysis',
      instructions: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 4000,
      reasoningEffort: 'high'
    });

    const content = response.content || '';
    if (!content || content.length < 100) {
      this.logger.warn('DisconfirmationAgent: insufficient response', { length: content.length });
      return { content: '', findings: [] };
    }

    await this.reportProgress(70, 'Extracting disconfirmation targets');

    // Parse sections
    const sections = this._parseSections(content);

    // Record findings
    if (sections.falsificationTest) {
      await this.addFinding(
        `[FALSIFICATION TARGET] ${sections.falsificationTest}`,
        'disconfirmation'
      );
    }

    if (sections.criticalAssumption) {
      await this.addFinding(
        `[CRITICAL ASSUMPTION] ${sections.criticalAssumption}`,
        'disconfirmation'
      );
    }

    if (sections.competingHypothesis) {
      await this.addInsight(
        `[STEEL-MAN ALTERNATIVE] ${sections.competingHypothesis}`,
        'disconfirmation'
      );
    }

    await this.reportProgress(90, 'Disconfirmation analysis complete');

    return {
      content,
      findings: this.results,
      sections
    };
  }

  /**
   * Parse the three-section response into structured parts.
   */
  _parseSections(content) {
    const sections = {
      falsificationTest: null,
      criticalAssumption: null,
      competingHypothesis: null
    };

    // Try section headers
    const falsMatch = content.match(/##?\s*1\.?\s*(?:FALSIFICATION|Falsification)[^\n]*\n([\s\S]*?)(?=##?\s*2\.?\s*(?:CRITICAL|Critical)|$)/i);
    const assumMatch = content.match(/##?\s*2\.?\s*(?:CRITICAL|Critical)[^\n]*\n([\s\S]*?)(?=##?\s*3\.?\s*(?:STEEL|Steel)|$)/i);
    const steelMatch = content.match(/##?\s*3\.?\s*(?:STEEL|Steel)[^\n]*\n([\s\S]*?)$/i);

    if (falsMatch) sections.falsificationTest = falsMatch[1].trim();
    if (assumMatch) sections.criticalAssumption = assumMatch[1].trim();
    if (steelMatch) sections.competingHypothesis = steelMatch[1].trim();

    // Fallback: if no sections parsed, use full content as single finding
    if (!sections.falsificationTest && !sections.criticalAssumption && !sections.competingHypothesis) {
      sections.falsificationTest = content.trim();
    }

    return sections;
  }

  /**
   * Override accomplishment assessment — disconfirmation is always productive
   * if it produces any non-trivial output.
   */
  assessAccomplishment(executeResult, results) {
    const hasFindings = results.some(r => r.type === 'finding' || r.type === 'insight');
    const hasContent = executeResult?.content?.length > 200;
    return {
      accomplished: hasFindings || hasContent,
      reason: hasFindings ? null : 'No disconfirmation targets generated',
      metrics: {
        findings: results.filter(r => r.type === 'finding').length,
        insights: results.filter(r => r.type === 'insight').length,
        sectionsFound: Object.values(executeResult?.sections || {}).filter(Boolean).length
      }
    };
  }
}

module.exports = { DisconfirmationAgent };
