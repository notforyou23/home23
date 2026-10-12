const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STRATEGIC_SOURCE = 'meta_coordinator_strategic';

// Slash-separated phrases are alternatives within each closed topic family.
const DEFAULT_BLOCKED_GOAL_TOPICS = Object.freeze([
  'Substack canonical-pointer notes approval template scope / nine notes template / nine-note scope / canonical owner request / authorized pointer text',
  'approval request / decision record / byte-count threshold pending owner approval / duplicate request consolidation',
]);
const DEFAULT_STRATEGIC_GOAL_GATE = Object.freeze({
  enabled: true,
  dedupeEnabled: true,
  ownerClosedEnabled: true,
  blockedTopicsEnabled: true,
  metaLoopEnabled: true,
  rateLimitEnabled: true,
  similarityThreshold: 0.5,
  topicSimilarityThreshold: 0.5,
  lookbackDays: 14,
  maxPerReview: 2,
  maxPerHour: 4,
});
const STOP_WORDS = new Set(('a an and are as at be been being by do for from has have in into is it of on one or that the their them these this those to was were will with all both specific proposed relevant').split(' '));
const TOKEN_ALIASES = {
  ask: 'request', asking: 'request', requests: 'request', requesting: 'request',
  approve: 'approval', approving: 'approval', approved: 'approval', approvals: 'approval',
  notes: 'note', goals: 'goal', records: 'record', thresholds: 'threshold', bytes: 'byte',
  destinations: 'destination', duplicates: 'duplicate', nine: '9',
  consolidate: 'consolidation', consolidating: 'consolidation',
  merge: 'consolidation', merging: 'consolidation', merged: 'consolidation',
};

function normalizeTokens(text) {
  return new Set((String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(token => !STOP_WORDS.has(token))
    .map(token => TOKEN_ALIASES[token] || token));
}

function similarity(left, right, minimumContainmentOverlap = 3) {
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter(token => right.has(token)).length;
  const jaccard = shared / (left.size + right.size - shared);
  // A single common word must not make unrelated short goals duplicates.
  const containment = shared >= minimumContainmentOverlap ? shared / Math.min(left.size, right.size) : 0;
  return Math.max(jaccard, containment);
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createdTime(goal) {
  return timestamp(goal.created) ?? timestamp(goal.createdAt) ?? timestamp(goal.created_at);
}

function goalHistory(goalsSystem) {
  const snapshot = typeof goalsSystem?.export === 'function' ? goalsSystem.export() : {
    active: goalsSystem?.getGoals?.() || [],
    completed: goalsSystem?.getCompletedGoals?.() || goalsSystem?.completedGoals || [],
    archived: goalsSystem?.archivedGoals || [],
  };
  const byId = new Map();
  for (const [collection, status] of [['active', 'active'], ['completed', 'completed'], ['archived', 'archived']]) {
    for (const entry of snapshot?.[collection] || []) {
      const goal = Array.isArray(entry) ? entry[1] : entry;
      if (goal?.id) byId.set(goal.id, { ...goal, status: goal.status || status });
    }
  }
  return [...byId.values()];
}

function isPendingOwnerRequest(item) {
  if (!item || item.status !== 'open' || item.audience !== 'operator') return false;
  // Authority-request receipts alone lack a reliable answered/resolved state.
  return item.kind === 'operator_question' && typeof item.questionId === 'string' && !!item.questionId;
}

function isMetaLoop(description) {
  const text = String(description || '').toLowerCase().replace(/[-_]/g, ' ');
  if (/\bdecision\s+records?\b|\bapproval\s+requests?\b/.test(text)) return true;
  if (/\bduplicates?\b/.test(text) && /\b(?:requests?|goals?)\b/.test(text)) return true;
  if (/\b(?:consolidat\w*|merg\w*)\b/.test(text) && /\b(?:requests?|goals?|decisions?)\b/.test(text)) return true;
  if (/\b(?:approval|authorization|permission)\b.{0,60}\bbefore\b.{0,60}\b(?:inspect\w*|investigat\w*|review\w*)\b/.test(text)) return true;
  const actor = '(?:owner|operator|jtr|decision\\s+maker)';
  const judgment = '(?:approv(?:al|e|ing)|authoriz(?:ation|e)|permission|decid(?:e|ing)|decision)';
  const seeking = '(?:ask\\w*|request\\w*|seek\\w*|obtain\\w*|await\\w*|pending|need\\w*|require\\w*)';
  const withinSentence = '[^.!?;\\n]{0,120}';
  // Request the owner's approval, or request approval from the owner. A past
  // owner-approved repair plus a request for evidence is substantive work.
  return new RegExp(`\\b${seeking}\\b${withinSentence}\\b${actor}\\b${withinSentence}\\b${judgment}\\b`).test(text)
    || new RegExp(`\\b${seeking}\\b${withinSentence}\\b${judgment}\\b${withinSentence}\\b${actor}\\b`).test(text)
    || new RegExp(`\\b${actor}\\b${withinSentence}\\b(?:need\\w*|require\\w*|must|should)\\b${withinSentence}\\b${judgment}\\b`).test(text)
    || new RegExp(`\\b${actor}\\b${withinSentence}\\b${judgment}\\b${withinSentence}\\b(?:pending|needed|required|awaited|outstanding|missing)\\b`).test(text);
}

function numberSetting(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
}

/** Admission only: never mutates goals or changes their persisted format. */
class StrategicGoalGate {
  constructor(coordinatorConfig = {}, logger, { now = () => Date.now() } = {}) {
    this.config = { ...DEFAULT_STRATEGIC_GOAL_GATE, ...coordinatorConfig.strategicGoalGate };
    for (const key of ['similarityThreshold', 'topicSimilarityThreshold']) {
      this.config[key] = numberSetting(this.config[key], DEFAULT_STRATEGIC_GOAL_GATE[key], 1);
    }
    for (const key of ['lookbackDays', 'maxPerReview', 'maxPerHour']) {
      this.config[key] = numberSetting(this.config[key], DEFAULT_STRATEGIC_GOAL_GATE[key]);
    }
    const topics = Array.isArray(coordinatorConfig.blockedGoalTopics)
      ? coordinatorConfig.blockedGoalTopics : DEFAULT_BLOCKED_GOAL_TOPICS;
    this.topics = topics.filter(topic => typeof topic === 'string').flatMap(topic => topic.split('/'))
      .map(topic => ({ text: topic.trim(), tokens: normalizeTokens(topic) })).filter(topic => topic.tokens.size > 0);
    this.logger = logger;
    this.now = now;
    // Retain successful admissions if normal goal cleanup removes them this hour.
    // Reconstruct the same allowance from existing goal timestamps after restart.
    this.createdById = new Map();
  }

  beginReview(reviewId) {
    return { reviewId, attempted: 0, created: 0, suppressed: 0, reasons: {} };
  }

  suppress(spec, review, reason, details = {}) {
    review.suppressed++;
    review.reasons[reason] = (review.reasons[reason] || 0) + 1;
    const suffix = reason === 'duplicate-of' ? ` ${details.goalId}/score=${details.score.toFixed(3)}`
      : reason === 'rate-limit' ? ` ${details.limit}` : '';
    this.logger?.info?.(`Strategic goal suppressed: ${reason}${suffix}`, {
      reviewId: review.reviewId, description: spec.description, reason, ...details,
    });
    return { allowed: false, reason, ...details };
  }

  evaluate(spec, goalsSystem, review, { pendingOwnerRequests = [] } = {}) {
    review.attempted++;
    if (this.config.enabled === false) return { allowed: true };
    const now = this.now();
    const tokens = normalizeTokens(spec.description);
    const history = goalHistory(goalsSystem);
    const ownerClosed = goal => goal.status === 'archived' && /^owner:/i.test(String(goal.archiveReason || ''));
    const recent = goal => {
      if (goal.status === 'active') return true;
      const at = timestamp(goal.archivedAt) ?? timestamp(goal.completedAt) ?? createdTime(goal);
      // Legacy missing timestamps cannot prove the closure is outside the window.
      return at === null || at >= now - this.config.lookbackDays * DAY_MS;
    };

    for (const goal of history) {
      const permanent = this.config.ownerClosedEnabled !== false && ownerClosed(goal);
      if (!(permanent || (this.config.dedupeEnabled !== false && recent(goal)))) continue;
      const score = similarity(tokens, normalizeTokens(goal.description));
      if (score > 0 && score >= this.config.similarityThreshold) {
        return this.suppress(spec, review, this.config.dedupeEnabled !== false ? 'duplicate-of' : 'blocked-topic', {
          goalId: goal.id, score, ...(permanent ? { ownerClosed: true } : {}),
        });
      }
    }

    if (this.config.blockedTopicsEnabled !== false) {
      for (const topic of this.topics) {
        const shared = [...topic.tokens].filter(token => tokens.has(token)).length;
        const score = similarity(tokens, topic.tokens, 2);
        // Multiword topic phrases require up to three shared keywords; single-word
        // operator-configured topics require that exact keyword.
        if (shared >= Math.min(3, topic.tokens.size) && score >= this.config.topicSimilarityThreshold) {
          return this.suppress(spec, review, 'blocked-topic', { topic: topic.text, score });
        }
      }
    }
    if (this.config.metaLoopEnabled !== false && isMetaLoop(spec.description)
      && !pendingOwnerRequests.some(isPendingOwnerRequest)) {
      return this.suppress(spec, review, 'meta-loop');
    }
    if (this.config.rateLimitEnabled !== false) {
      if (review.created >= this.config.maxPerReview) {
        return this.suppress(spec, review, 'rate-limit', { limit: 'per-review' });
      }
      const cutoff = now - HOUR_MS;
      for (const [id, at] of this.createdById) if (at <= cutoff) this.createdById.delete(id);
      const hourlyIds = new Set(this.createdById.keys());
      for (const goal of history) {
        const source = typeof goal.source === 'string' ? goal.source : goal.source?.label;
        const at = createdTime(goal);
        if (source === STRATEGIC_SOURCE && at !== null && at > cutoff && at <= now) hourlyIds.add(goal.id);
      }
      if (hourlyIds.size >= this.config.maxPerHour) {
        return this.suppress(spec, review, 'rate-limit', { limit: 'per-hour' });
      }
    }
    return { allowed: true };
  }

  recordCreated(goal, review) {
    review.created++;
    const now = this.now();
    for (const [id, at] of this.createdById) if (at <= now - HOUR_MS) this.createdById.delete(id);
    this.createdById.set(goal.id, now);
  }

  finishReview(review) {
    this.logger?.info?.('Strategic goal gate review summary', { ...review, enabled: this.config.enabled !== false });
  }
}

module.exports = { StrategicGoalGate, DEFAULT_BLOCKED_GOAL_TOPICS, DEFAULT_STRATEGIC_GOAL_GATE };
