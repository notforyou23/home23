'use strict';

/**
 * Principal Researcher — the durable organizer of the research ecology.
 *
 * The Principal proposes: agenda, expeditions, promotion, contest, dormancy,
 * revival, synthesis, and stopping. It may NOT mutate canonical state; every
 * proposal is a typed decision that the deterministic ecology kernel
 * validates before anything changes (Inv 14: the Principal organizes; it
 * does not own truth).
 *
 * Continuity is the journaled decision history, not one model session
 * (Inv 16: a long-running agent session is working consciousness, not
 * durable Brain memory).
 */

const crypto = require('crypto');
const { isFatalAuthError } = require('../../../lib/auth-error');

function decisionId() {
  return `dec_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

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

class Principal {
  constructor({ client, config, logger } = {}) {
    this.client = client || null;
    this.config = config || {};
    this.logger = logger || console;
  }

  decision(kind, payload = {}) {
    return {
      id: decisionId(),
      actor: 'principal',
      kind,
      at: Date.now(),
      ...payload
    };
  }

  model() {
    return this.config.models?.fast
      || this.config.models?.primary
      || this.config.modelAssignments?.default?.model;
  }

  async callModel(system, user, maxTokens = 1200) {
    if (!this.client || typeof this.client.createCompletion !== 'function') {
      return null;
    }
    const response = await this.client.createCompletion({
      model: this.model(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.3,
      maxTokens
    });
    if (isFatalAuthError(response)) {
      const err = new Error('Principal model call failed: authentication_error');
      err.type = 'authentication_error';
      throw err;
    }
    return response?.choices?.[0]?.message?.content || null;
  }

  /**
   * Wake review: given replayed candidates and the question ecology,
   * propose promotions, question lifecycle changes, and next questions.
   * Semantic judgment lives here; the kernel validates everything after.
   * Degraded-honest: if the model is unavailable, returns no proposals.
   */
  async wakeReview({ candidates = [], questions = [], seedQuestion = null } = {}) {
    const decisions = [];
    if (candidates.length === 0 && questions.length === 0) {
      return { decisions, degraded: false };
    }

    const candidateLines = candidates.slice(0, 40).map((candidate) =>
      `- id=${candidate.id} origin=${candidate.origin || 'worker'} lane=${candidate.lane || '-'} :: ${String(candidate.content || '').slice(0, 240)}`);
    const questionLines = questions.slice(0, 30).map((question) =>
      `- id=${question.id} status=${question.status} origin=${question.origin} lane=${question.lane || '-'} :: ${question.text.slice(0, 160)}`);

    const system = [
      'You are the Principal Researcher of an autonomous research mind.',
      'You organize; you do not own truth. Workers proposed the candidates below.',
      'Propose which candidates deserve promotion into the Brain, and question lifecycle changes.',
      'Rules:',
      '- A dream-origin candidate may only be proposed as a hypothesis or question, never a finding.',
      '- Do not close a question merely because a worker finished.',
      '- Preserve dissent: contested material stays contested.',
      'Reply as JSON only:',
      '{"promotions":[{"candidateId":"...","promoteAs":"finding|hypothesis|question|connection|contradiction","rationale":"..."}],',
      ' "questionChanges":[{"questionId":"...","newStatus":"active|partially_answered|answered|dormant|incubating|revived","rationale":"..."}]}'
    ].join('\n');

    const user = [
      seedQuestion ? `Seed question: ${seedQuestion.text}` : null,
      'Candidates (journaled, unpromoted):',
      candidateLines.join('\n') || '(none)',
      '',
      'Questions:',
      questionLines.join('\n') || '(none)'
    ].filter((line) => line !== null).join('\n');

    let parsed = null;
    try {
      parsed = extractJson(await this.callModel(system, user, 1600));
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      this.logger?.warn?.('Principal wake review failed — no proposals this wake', { error: err.message });
      return { decisions, degraded: true };
    }
    if (!parsed) {
      return { decisions, degraded: true };
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const promotion of Array.isArray(parsed.promotions) ? parsed.promotions : []) {
      if (!candidateIds.has(promotion.candidateId)) continue;
      decisions.push(this.decision('promotion_proposal', {
        candidateId: promotion.candidateId,
        promoteAs: promotion.promoteAs || 'finding',
        rationale: promotion.rationale || null
      }));
    }
    const questionIds = new Set(questions.map((question) => question.id));
    for (const change of Array.isArray(parsed.questionChanges) ? parsed.questionChanges : []) {
      if (!questionIds.has(change.questionId)) continue;
      decisions.push(this.decision('question_lifecycle_proposal', {
        questionId: change.questionId,
        newStatus: change.newStatus,
        rationale: change.rationale || null
      }));
    }
    return { decisions, degraded: false };
  }

  /**
   * Settle assessment at a program boundary. Proposes stopping only when the
   * remaining open work does not justify further budget. Degraded-honest:
   * with no model, defer to deterministic budget stopping.
   */
  async assessSettle({ seedQuestion, questions = [], budget = {} } = {}) {
    const system = [
      'You are the Principal Researcher. Decide whether this research run should settle.',
      'Settled means the Brain stays queryable and no research process keeps running;',
      'questions and incubations remain resumable. Do not settle merely because one',
      'worker finished a deliverable. Reply as JSON only:',
      '{"settle": true|false, "rationale": "..."}'
    ].join('\n');
    const user = [
      seedQuestion ? `Seed question: ${seedQuestion.text} (status: ${seedQuestion.status})` : null,
      `Budget: spent ${budget.spentTurns ?? '?'} of ${budget.totalTurns ?? '?'} worker turns.`,
      'Open questions:',
      ...questions.filter((question) => ['new', 'active', 'partially_answered', 'revived'].includes(question.status))
        .slice(0, 20)
        .map((question) => `- [${question.status}] ${question.text.slice(0, 160)}`)
    ].filter((line) => line !== null).join('\n');

    let parsed = null;
    try {
      parsed = extractJson(await this.callModel(system, user, 400));
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      return null;
    }
    if (!parsed || typeof parsed.settle !== 'boolean') return null;
    if (!parsed.settle) return null;
    return this.decision('settle_proposal', { rationale: parsed.rationale || null });
  }
}

module.exports = { Principal, extractJson };
