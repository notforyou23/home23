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

function normalizedGoalTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:goal|round)\s*#?\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isInvalidChainGoalTitle(title, question) {
  const normalized = normalizedGoalTitle(title);
  if (!normalized) return true;
  if (/\bgo deeper\b/.test(normalized)) return true;
  return normalized === normalizedGoalTitle(question);
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

  async callModel(system, user, {
    temperature = 0.5,
    maxTokens = 900,
    deadlineAt = null
  } = {}) {
    if (!this.client || typeof this.client.createCompletion !== 'function') return null;
    const configuredTimeoutMs = Number(this.config.drill?.workerCallTimeoutMs)
        || Number(this.config.timeouts?.operationTimeoutMs)
        || 120000;
    const deadlineRemaining = Number(deadlineAt) > 0 ? Number(deadlineAt) - Date.now() : null;
    if (deadlineRemaining !== null && deadlineRemaining <= 0) {
      const error = new Error('Research drill time budget exhausted before coordinator call');
      error.code = 'DRILL_TIME_EXHAUSTED';
      throw error;
    }
    const timeoutMs = Math.max(
      1,
      deadlineRemaining === null
        ? configuredTimeoutMs
        : Math.min(configuredTimeoutMs, deadlineRemaining)
    );
    let timer = null;
    const request = this.client.createCompletion({
      model: this.model(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature,
      maxTokens
    });
    let response;
    try {
      response = await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Drill coordinator call timed out after ${timeoutMs}ms`);
            error.code = 'DRILL_COORDINATOR_TIMEOUT';
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
   * Compose either a goal spec or a terminal result.
   * Returns { spec, degraded, done, doneReason }. A seed call can degrade to
   * the launch question; a chain call fails closed rather than inventing work.
   */
  async composeGoal({
    question,
    questionContext,
    previousGoal,
    goalHistory = [],
    number,
    origin,
    mergedSummary = null,
    deadlineAt = null
  }) {
    let result = null;
    try {
      result = await this.composeGoalViaModel({
        question, questionContext, previousGoal, goalHistory, number, origin, mergedSummary, deadlineAt
      });
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      this.logger?.warn?.('Goal composition failed — using deterministic fallback', { error: err.message });
    }

    if (result?.done) {
      return {
        spec: null,
        degraded: false,
        done: true,
        doneReason: 'research_complete'
      };
    }

    if (result) {
      return { spec: result, degraded: false, done: false, doneReason: null };
    }

    if (origin !== 'seed') {
      return {
        spec: null,
        degraded: true,
        done: false,
        doneReason: 'goal_generation_failed'
      };
    }

    return {
      degraded: true,
      done: false,
      doneReason: null,
      spec: {
        title: question,
        why: 'Seed goal from the launch question.',
        phases: [{
          title: 'Research and write up',
          mission: `${question}${questionContext ? ` — ${questionContext}` : ''}`
        }]
      }
    };
  }

  async composeGoalViaModel({
    question,
    questionContext,
    previousGoal,
    goalHistory,
    number,
    origin,
    mergedSummary,
    deadlineAt
  }) {
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
      '- A next goal must name a specific unanswered hole: for example a missing source class, conflict, person, or year.',
      '- "Go deeper" is not a goal title. Never restate the launch question as a next goal.',
      '- If completed goals already answer the question and no concrete new hole remains, finish the hunt.',
      'Reply as JSON only with one of:',
      '{"title":"...","why":"...","phases":[{"title":"...","mission":"..."}]}',
      '{"done":true,"reason":"why no distinct research goal remains"}'
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

    const parsed = extractJson(await this.callModel(system, user, { deadlineAt }));
    if (parsed?.done === true) {
      return origin === 'chain' ? { done: true } : null;
    }
    if (!parsed?.title || !Array.isArray(parsed.phases) || parsed.phases.length === 0) return null;
    if (containsForbiddenPhrase(parsed)) {
      this.logger?.warn?.('Goal spec contained a forbidden review-what-is-here phrase — rejected');
      return null;
    }
    if (origin === 'chain' && isInvalidChainGoalTitle(parsed.title, question)) {
      this.logger?.warn?.('Next goal did not name a distinct research hole — rejected');
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
  async mergeGoal(goal, { findings = [], deadlineAt = null } = {}) {
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
      const parsed = extractJson(await this.callModel(system, user, {
        temperature: 0.3,
        maxTokens: 700,
        deadlineAt
      }));
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
