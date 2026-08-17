'use strict';

/**
 * Question Ecology — durable unknowns, not tasks.
 *
 * A question is a durable unknown. A task is an executable action. A goal is
 * a desired state. A claim is an assertion. A worker's finish does not close
 * a question; only a validated Principal decision changes question lifecycle.
 *
 * Autonomy provenance (July 30 law): Adjacent or Wildcard work counts toward
 * autonomy only when the initiating Question was originated by specialist,
 * default-mode, or dream cognition and was not preauthored by the human or
 * Principal. Lane labels alone never establish autonomy.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const QUESTION_ORIGINS = [
  'human',
  'principal',
  'specialist',
  'default_mode',
  'dream',
  'evidence_gap',
  'contradiction'
];

const AUTONOMY_ORIGINS = new Set(['specialist', 'default_mode', 'dream']);

const QUESTION_STATUSES = [
  'new',
  'active',
  'partially_answered',
  'answered',
  'dormant',
  'revived',
  'incubating',
  'abandoned'
];

const LIFECYCLE_TRANSITIONS = {
  new: ['active', 'incubating', 'abandoned'],
  active: ['partially_answered', 'answered', 'dormant', 'incubating', 'abandoned'],
  partially_answered: ['answered', 'active', 'dormant', 'incubating'],
  answered: ['revived', 'dormant'],
  dormant: ['revived'],
  revived: ['active', 'partially_answered', 'answered', 'dormant', 'incubating'],
  incubating: ['active', 'dormant', 'abandoned'],
  abandoned: []
};

function newQuestionId() {
  return `q_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function countsTowardAutonomy(question) {
  if (!question) return false;
  if (question.provenance?.preauthored === true) return false;
  return AUTONOMY_ORIGINS.has(question.origin);
}

class QuestionEcology {
  constructor(runtimePath, logger = console) {
    this.file = path.join(runtimePath, 'ecology', 'questions.json');
    this.logger = logger;
    this.questions = new Map();
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const list = JSON.parse(raw);
      for (const question of Array.isArray(list) ? list : []) {
        if (question?.id) this.questions.set(question.id, question);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn?.('Question store unreadable — starting empty', { error: err.message });
      }
    }
    this._loaded = true;
  }

  async persist() {
    const dir = path.dirname(this.file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(Array.from(this.questions.values()), null, 2));
    await fsp.rename(tmp, this.file);
  }

  /**
   * Create a question. origin must be a known cognition source; provenance
   * records who originated the initiating prompt so lane labels alone can
   * never establish autonomy.
   */
  async create({ text, origin, lane = null, why = null, parents = [], provenance = {}, status = 'new' }) {
    await this.load();
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Question requires text');
    if (!QUESTION_ORIGINS.includes(origin)) {
      throw new Error(`Unknown question origin: ${origin}`);
    }
    if (!QUESTION_STATUSES.includes(status)) {
      throw new Error(`Unknown question status: ${status}`);
    }

    const question = {
      id: newQuestionId(),
      text: cleanText,
      origin,
      lane,
      why: why || null,
      parents: Array.isArray(parents) ? parents : [],
      provenance: {
        originatedBy: provenance.originatedBy || origin,
        preauthored: provenance.preauthored === true,
        expeditionId: provenance.expeditionId || null,
        fromCandidates: provenance.fromCandidates || []
      },
      status,
      createdAt: Date.now(),
      lastChangeAt: Date.now(),
      history: [{ at: Date.now(), status, by: 'ecology', reason: 'created' }]
    };
    this.questions.set(question.id, question);
    await this.persist();
    return question;
  }

  /**
   * Lifecycle transition. Only the ecology kernel applies these, and only
   * from a validated decision (Principal proposal or explicit human action).
   * A worker's finish is not a valid `by`.
   */
  async transition(questionId, newStatus, { by, reason, decisionId = null } = {}) {
    await this.load();
    const question = this.questions.get(questionId);
    if (!question) throw new Error(`Unknown question: ${questionId}`);
    if (!QUESTION_STATUSES.includes(newStatus)) {
      throw new Error(`Unknown question status: ${newStatus}`);
    }
    if (by === 'worker' || by === 'launch_loop') {
      throw new Error('A worker finish does not close a question');
    }
    const allowed = LIFECYCLE_TRANSITIONS[question.status] || [];
    if (!allowed.includes(newStatus)) {
      throw new Error(`Invalid question transition ${question.status} -> ${newStatus}`);
    }
    question.status = newStatus;
    question.lastChangeAt = Date.now();
    question.history.push({ at: Date.now(), status: newStatus, by: by || 'ecology', reason: reason || null, decisionId });
    await this.persist();
    return question;
  }

  async activate(questionId, meta = {}) {
    await this.load();
    const question = this.questions.get(questionId);
    if (!question) throw new Error(`Unknown question: ${questionId}`);
    if (question.status === 'new' || question.status === 'incubating' || question.status === 'revived') {
      return this.transition(questionId, 'active', { by: meta.by || 'ecology', reason: meta.reason || 'expedition_started' });
    }
    return question;
  }

  get(questionId) {
    return this.questions.get(questionId) || null;
  }

  list(filter = {}) {
    let list = Array.from(this.questions.values());
    if (filter.status) list = list.filter((question) => question.status === filter.status);
    if (filter.lane) list = list.filter((question) => question.lane === filter.lane);
    if (filter.autonomous === true) list = list.filter((question) => countsTowardAutonomy(question));
    return list;
  }

  summary() {
    const byStatus = {};
    const byOrigin = {};
    let autonomous = 0;
    for (const question of this.questions.values()) {
      byStatus[question.status] = (byStatus[question.status] || 0) + 1;
      byOrigin[question.origin] = (byOrigin[question.origin] || 0) + 1;
      if (countsTowardAutonomy(question)) autonomous += 1;
    }
    return { total: this.questions.size, byStatus, byOrigin, autonomous };
  }
}

module.exports = {
  QuestionEcology,
  QUESTION_ORIGINS,
  QUESTION_STATUSES,
  AUTONOMY_ORIGINS,
  countsTowardAutonomy
};
