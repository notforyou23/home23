'use strict';

/**
 * Drill coordinator — Principal-shaped, not a desk panel.
 *
 * The coordinator organizes the drill's goal chain: it composes a goal with
 * concrete phases, assigns open phases to workers (one bit per phase, in
 * parallel up to the concurrency cap), merges phase results when a goal
 * completes, and invents the next goal from what was learned. It never does
 * the research itself and its output never tells a worker to review what is
 * already here.
 */

const { FORBIDDEN_PLAN_PHRASES } = require('../agent/short-plan');
const { isFatalAuthError } = require('../../../lib/auth-error');

const MAX_PHASES_PER_GOAL = 4;

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function containsForbiddenPhrase(value) {
  const blob = JSON.stringify(value || '').toLowerCase();
  return FORBIDDEN_PLAN_PHRASES.some((phrase) => blob.includes(phrase.toLowerCase()));
}

class DrillCoordinator {
  constructor({ client, config, logger } = {}) {
    this.client = client || null;
    this.config = config || {};
    this.logger = logger || console;
  }

  model() {
    return this.config.models?.fast || this.config.models?.primary;
  }

  async callModel(system, user, { temperature = 0.5, maxTokens = 900 } = {}) {
    if (!this.client || typeof this.client.createCompletion !== 'function') return null;
    const response = await this.client.createCompletion({
      model: this.model(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature,
      maxTokens
    });
    if (isFatalAuthError(response)) {
      const err = new Error('Coordinator model call failed: authentication_error');
      err.type = 'authentication_error';
      throw err;
    }
    return response?.choices?.[0]?.message?.content || null;
  }

  /**
   * Assign open phases to the available worker slots. Deterministic: phases
   * run in their declared order, as many at once as the cap allows. Returns
   * the phases to launch now.
   */
  assignPhases(openPhases, slots) {
    if (!Array.isArray(openPhases) || slots <= 0) return [];
    return openPhases.slice(0, slots);
  }

  /**
   * Compose a goal spec: { title, why, phases: [{title, mission}] }.
   * Returns { spec, degraded } — degraded specs keep the drill drilling when
   * the planning call fails or produces forbidden phrasing.
   */
  async composeGoal({ question, questionContext, previousGoal, goalHistory = [], number, origin, mergedSummary = null }) {
    let spec = null;
    try {
      spec = await this.composeGoalViaModel({
        question, questionContext, previousGoal, goalHistory, number, origin, mergedSummary
      });
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      this.logger?.warn?.('Goal composition failed — using deterministic fallback', { error: err.message });
    }

    if (spec) {
      return { spec, degraded: false };
    }

    return {
      degraded: true,
      spec: {
        title: origin === 'seed'
          ? question
          : `Go deeper on ${question} (round ${number})`,
        why: origin === 'seed'
          ? 'Seed goal from the launch question.'
          : 'Continue the drill beyond completed rounds without repeating finished work.',
        phases: [{
          title: origin === 'seed' ? 'Research and write up' : `Deepen round ${number}`,
          mission: origin === 'seed'
            ? `${question}${questionContext ? ` — ${questionContext}` : ''}`
            : `Advance the research on "${question}" beyond what earlier goals covered. Do not repeat completed work. Find what is missing, verify what is weak, and write it up.`
        }]
      }
    };
  }

  async composeGoalViaModel({ question, questionContext, previousGoal, goalHistory, number, origin, mergedSummary }) {
    const completedSummaries = goalHistory
      .filter((goal) => goal.status === 'completed')
      .slice(-5)
      .map((goal) => `- Goal ${goal.number}: ${goal.title}`);
    const previousPhases = previousGoal
      ? previousGoal.phases.map((phase) => `- ${phase.title}: ${String(phase.summary || 'done').slice(0, 160)}`)
      : [];

    const system = [
      'You are the coordinator of an autonomous research drill. You define research GOALS with concrete PHASES.',
      'A goal is one round of the drill. Its phases are worked IN PARALLEL by separate tool-loop workers',
      '(searching, reading, verifying, writing artifacts), so phases must be independent lanes that do not',
      'depend on each other\'s output within the goal. Rules:',
      '- 1 to 4 phases, each a concrete executable mission, not a vague theme.',
      '- Phases must be parallelizable: no phase may wait on another phase of the same goal.',
      '- Never tell a worker to review or inventory what is already here.',
      '- Never repeat completed work; go deeper, wider, or into what is missing.',
      'Reply as JSON only: {"title":"...","why":"...","phases":[{"title":"...","mission":"..."}]}'
    ].join('\n');

    const user = [
      `Research question: ${question}`,
      questionContext ? `Context: ${questionContext}` : null,
      origin === 'seed'
        ? 'Define the FIRST goal of the drill.'
        : `Goal ${number - 1} is complete. Define goal ${number} — the NEXT goal that advances the research.`,
      mergedSummary ? `Merged result of the completed goal:\n${String(mergedSummary).slice(0, 900)}` : null,
      completedSummaries.length ? `Completed goals so far:\n${completedSummaries.join('\n')}` : null,
      previousPhases.length ? `Phases just completed:\n${previousPhases.join('\n')}` : null
    ].filter(Boolean).join('\n\n');

    const parsed = extractJson(await this.callModel(system, user));
    if (!parsed?.title || !Array.isArray(parsed.phases) || parsed.phases.length === 0) return null;
    if (containsForbiddenPhrase(parsed)) {
      this.logger?.warn?.('Goal spec contained a forbidden review-what-is-here phrase — rejected');
      return null;
    }
    const phases = parsed.phases.filter((phase) => phase?.title || phase?.mission);
    if (phases.length === 0) return null;
    return {
      title: String(parsed.title),
      why: parsed.why ? String(parsed.why) : null,
      phases: phases.slice(0, MAX_PHASES_PER_GOAL).map((phase) => ({
        title: String(phase.title || phase.mission),
        mission: String(phase.mission || phase.title)
      }))
    };
  }

  /**
   * Merge a completed goal's parallel phase results into one summary that
   * feeds the next goal. Degraded-honest: without a model, the merge is the
   * concatenated phase summaries — never a fabricated synthesis.
   */
  async mergeGoal(goal, { findings = [] } = {}) {
    const phaseLines = goal.phases.map((phase) =>
      `- Phase ${phase.number} (${phase.title}): ${String(phase.summary || 'done').slice(0, 200)}`);
    const fallback = phaseLines.join('\n');

    let merged = null;
    try {
      const system = [
        'You are the coordinator of an autonomous research drill. Several workers just finished',
        'the phases of one goal IN PARALLEL. Merge their results: what was established, what',
        'conflicts, and what is still missing. Be concrete and short. Reply as JSON only:',
        '{"summary":"...","gaps":["..."]}'
      ].join('\n');
      const user = [
        `Goal ${goal.number}: ${goal.title}`,
        'Phase results:',
        ...phaseLines,
        findings.length ? `Recent findings:\n${findings.slice(-12).map((finding) => `- ${String(finding).slice(0, 160)}`).join('\n')}` : null
      ].filter(Boolean).join('\n');
      const parsed = extractJson(await this.callModel(system, user, { temperature: 0.3, maxTokens: 700 }));
      if (parsed?.summary) {
        merged = {
          summary: String(parsed.summary),
          gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter(Boolean).map(String).slice(0, 6) : [],
          degraded: false
        };
      }
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      this.logger?.warn?.('Goal merge failed — using phase summaries verbatim', { error: err.message });
    }

    return merged || { summary: fallback, gaps: [], degraded: true };
  }
}

module.exports = { DrillCoordinator, MAX_PHASES_PER_GOAL };
