/**
 * Agenda Store — the fruit layer
 *
 * Phase 6 of thinking-machine-cycle rebuild. Kept thoughts produce agenda
 * candidates (decisions, questions, ideas) that accumulate here, age, and
 * eventually surface to jtr. Without this the kept-thought stream is just
 * a bigger pile.
 *
 * Persistence: append-only JSONL at instances/<agent>/brain/agenda.jsonl
 * plus an in-memory index for fast queries. All status transitions append
 * a new event row, preserving history.
 *
 * See docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md Fruit Layer.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_STATUSES = new Set(['candidate', 'surfaced', 'acknowledged', 'acted_on', 'stale', 'discarded']);

const DEFAULT_CONFIG = {
  candidateStaleAfterMs: 48 * 60 * 60 * 1000, // unsurfaced candidates expire quickly
  surfacedStaleAfterMs: 14 * 24 * 60 * 60 * 1000, // surfaced items can stay active longer
  decayReviewMs: 6 * 60 * 60 * 1000,        // run decay review every 6 hours
  surfaceLimit: 12,                         // bounded working set visible to jtr
  mergeSimilarityThreshold: 0.9,           // only merge near-identical candidates
  surfaceSimilarityThreshold: 0.62,        // diversify surfaced set across active topics
};

const ACTIVE_STATUSES = new Set(['candidate', 'surfaced']);
const DEDUPE_STATUSES = new Set(['candidate', 'surfaced', 'acknowledged']);
const AGENDA_STOPWORDS = new Set([
  'about', 'across', 'actually', 'after', 'against', 'again', 'agent', 'agents', 'all', 'also', 'and',
  'any', 'appear', 'appears', 'around', 'being', 'between', 'blocked', 'build', 'building', 'built',
  'can', 'check', 'clarify', 'close', 'compare', 'concrete', 'consider', 'current', 'decide', 'decision',
  'define', 'determine', 'directly', 'does', 'each', 'else', 'explicit', 'explicitly', 'explore',
  'find', 'follow', 'from', 'gets', 'give', 'given', 'graph', 'have', 'having', 'home23', 'idea', 'identify',
  'if', 'implies', 'into', 'investigate', 'is', 'it', 'its', 'itself', 'jtr', 'layer', 'like', 'live',
  'look', 'make', 'mark', 'matter', 'means', 'more', 'most', 'need', 'next', 'node', 'nodes', 'not',
  'now', 'obvious', 'only', 'other', 'out', 'over', 'question', 'questions', 'really', 'recent', 'resolve',
  'should', 'signal', 'signals', 'something', 'specific', 'still', 'such', 'surface', 'surfaces', 'system',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'through',
  'trace', 'track', 'understand', 'use', 'uses', 'using', 'view', 'what', 'when', 'where', 'whether',
  'which', 'while', 'why', 'with', 'work', 'worth', 'would', 'your',
]);
const ABSTRACT_OPENERS = [
  'consider ',
  'explore ',
  'trace ',
  'map ',
  'locate ',
  'look for ',
  'corroborate ',
  'cross-reference ',
  're-examine ',
];

class AgendaStore {
  constructor(opts = {}) {
    if (!opts.brainDir) throw new Error('AgendaStore requires brainDir');
    this.brainDir = opts.brainDir;
    this.agendaPath = path.join(opts.brainDir, 'agenda.jsonl');
    this.logger = opts.logger || console;
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };

    // In-memory state: id → current record (latest status)
    this.items = new Map();
    this.loaded = false;
    this._decayTimer = null;

    try {
      fs.mkdirSync(opts.brainDir, { recursive: true });
    } catch {}

    this._loadFromDisk();
    this.applyStaleDecay(Date.now());
    this._reconcileSurfaced({ actor: 'bootstrap', note: 'initialize surfaced working set' });
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Add a new agenda candidate emerging from a kept thought.
   *
   * @param {object} params
   * @param {string} params.sourceThoughtId - the parent thought id
   * @param {string} params.sourceCycleSessionId - pipeline cycle session for audit trail
   * @param {string} params.content - the agenda candidate text (1-3 sentences)
   * @param {string} [params.kind] - 'decision' | 'question' | 'idea' | null
   * @param {string[]} [params.topicTags] - optional topic tags for grouping
   * @param {object} [params.temporalContext]
   * @param {string[]} [params.referencedNodes]
   * @returns {object} the created record
   */
  add(params) {
    const now = new Date().toISOString();
    const content = String(params.content || '').trim();
    if (!content) return null;

    const incoming = this._buildEnvelope({
      content,
      kind: params.kind || 'idea',
      topicTags: Array.isArray(params.topicTags) ? params.topicTags : [],
    });

    const mergeTarget = this._findMergeTarget(incoming);
    if (mergeTarget) {
      this._mergeIntoExisting(mergeTarget, params, incoming, now);
      this._reconcileSurfaced({ actor: 'system', note: 'refresh surfaced set after merge' });
      return mergeTarget;
    }

    const id = `ag-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      id,
      content,
      kind: incoming.kind,
      topicTags: incoming.topicTags,
      sourceThoughtId: params.sourceThoughtId || null,
      sourceCycleSessionId: params.sourceCycleSessionId || null,
      referencedNodes: Array.isArray(params.referencedNodes) ? params.referencedNodes : [],
      temporalContext: params.temporalContext || null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      seenCount: 1,
      status: 'candidate',
      history: [{ status: 'candidate', at: now, note: null }],
    };
    this._hydrateRecord(record);

    this.items.set(id, record);
    this._appendEvent({ type: 'add', id, record });
    this._reconcileSurfaced({ actor: 'system', note: 'refresh surfaced set after add' });
    return record;
  }

  /**
   * Transition an item to a new status. Appends a history entry.
   *
   * @param {string} id
   * @param {string} newStatus - one of VALID_STATUSES
   * @param {object} [opts] - { note, actor }
   * @returns {object|null} updated record, or null if not found / invalid transition
   */
  updateStatus(id, newStatus, opts = {}) {
    if (!VALID_STATUSES.has(newStatus)) {
      this.logger.warn?.('[agenda-store] invalid status', { id, newStatus });
      return null;
    }
    const rec = this.items.get(id);
    if (!rec) return null;
    if (rec.status === newStatus) return rec; // idempotent

    this._applyStatus(rec, newStatus, { ...opts, persist: true });
    if (!opts.skipReconcile) {
      this._reconcileSurfaced({ actor: 'system', note: 'refresh surfaced set after status change' });
    }
    return rec;
  }

  /**
   * List agenda items with optional filtering.
   *
   * @param {object} [filter]
   * @param {string|string[]} [filter.status]
   * @param {number} [filter.limit]
   * @param {string} [filter.sortBy='createdAt_desc']
   */
  list(filter = {}) {
    let items = Array.from(this.items.values());

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? new Set(filter.status) : new Set([filter.status]);
      items = items.filter(r => statuses.has(r.status));
    }

    // Sort: default newest first by createdAt
    const sortBy = filter.sortBy || 'updatedAt_desc';
    items.sort((a, b) => {
      if (sortBy === 'createdAt_asc') return a.createdAt.localeCompare(b.createdAt);
      if (sortBy === 'createdAt_desc') return b.createdAt.localeCompare(a.createdAt);
      if (sortBy === 'updatedAt_asc') return a.updatedAt.localeCompare(b.updatedAt);
      return b.updatedAt.localeCompare(a.updatedAt); // default desc
    });

    if (filter.limit && filter.limit > 0) items = items.slice(0, filter.limit);
    return items;
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /**
   * Group active items by topic-tag / referenced cluster for the dashboard surface.
   */
  groupedByTopic(filter = {}) {
    const items = this.list(filter);
    const groups = new Map();
    for (const rec of items) {
      const tags = rec.topicTags.length > 0 ? rec.topicTags : ['uncategorized'];
      for (const tag of tags) {
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag).push(rec);
      }
    }
    return Array.from(groups.entries()).map(([tag, records]) => ({
      topic: tag,
      count: records.length,
      records,
    }));
  }

  /**
   * Count by status.
   */
  counts() {
    const counts = { candidate: 0, surfaced: 0, acknowledged: 0, acted_on: 0, stale: 0, discarded: 0, total: 0 };
    for (const rec of this.items.values()) {
      counts[rec.status] = (counts[rec.status] || 0) + 1;
      counts.total++;
    }
    return counts;
  }

  /**
   * Mark untouched active items as 'stale' after configured window.
   * Returns number marked.
   */
  applyStaleDecay(now = Date.now()) {
    let marked = 0;
    for (const rec of this.items.values()) {
      if (rec.status !== 'candidate' && rec.status !== 'surfaced') continue;
      const updatedMs = new Date(rec.updatedAt).getTime();
      const threshold = rec.status === 'candidate'
        ? this.config.candidateStaleAfterMs
        : this.config.surfacedStaleAfterMs;
      if (now - updatedMs > threshold) {
        this.updateStatus(rec.id, 'stale', {
          actor: 'decay',
          note: rec.status === 'candidate'
            ? 'auto-stale after candidate inactivity window'
            : 'auto-stale after surfaced inactivity window',
          skipReconcile: true,
        });
        marked++;
      }
    }
    if (marked > 0) {
      this._reconcileSurfaced({ actor: 'decay', note: 'refresh surfaced set after stale decay' });
    }
    if (marked > 0) this.logger.info?.('[agenda-store] decay marked stale', { count: marked });
    return marked;
  }

  // Lifecycle — optional periodic decay review
  startDecayReview() {
    if (this._decayTimer) return;
    this._decayTimer = setInterval(() => this.applyStaleDecay(), this.config.decayReviewMs);
    if (this._decayTimer.unref) this._decayTimer.unref();
  }

  stopDecayReview() {
    if (this._decayTimer) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  _loadFromDisk() {
    if (!fs.existsSync(this.agendaPath)) {
      this.loaded = true;
      return;
    }
    try {
      const lines = fs.readFileSync(this.agendaPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        this._replayEvent(evt);
      }
      this.loaded = true;
      this.logger.info?.('[agenda-store] loaded', { count: this.items.size });
    } catch (err) {
      this.logger.warn?.('[agenda-store] load failed', { error: err?.message });
      this.loaded = true;
    }
  }

  _replayEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === 'add' && evt.record) {
      const rec = { ...evt.record };
      this._hydrateRecord(rec);
      this.items.set(evt.id, rec);
    } else if (evt.type === 'merge' && evt.id) {
      const rec = this.items.get(evt.id);
      if (!rec) return;
      rec.updatedAt = evt.at || rec.updatedAt;
      rec.lastSeenAt = evt.at || rec.lastSeenAt || rec.updatedAt;
      rec.seenCount = Math.max(rec.seenCount || 1, evt.seenCount || 1);
      if (evt.sourceThoughtId) rec.sourceThoughtId = evt.sourceThoughtId;
      if (evt.sourceCycleSessionId) rec.sourceCycleSessionId = evt.sourceCycleSessionId;
      if (Array.isArray(evt.referencedNodes) && evt.referencedNodes.length > 0) {
        rec.referencedNodes = Array.from(new Set([...(rec.referencedNodes || []), ...evt.referencedNodes]));
      }
      if (Array.isArray(evt.topicTags) && evt.topicTags.length > 0) {
        rec.topicTags = Array.from(new Set([...(rec.topicTags || []), ...evt.topicTags]));
      }
      this._hydrateRecord(rec);
    } else if (evt.type === 'status' && evt.id) {
      const rec = this.items.get(evt.id);
      if (!rec) return;
      rec.status = evt.status;
      rec.updatedAt = evt.at;
      rec.history.push({ status: evt.status, at: evt.at, note: evt.note || null, actor: evt.actor || null });
    }
  }

  _appendEvent(evt) {
    try {
      fs.appendFileSync(this.agendaPath, JSON.stringify(evt) + '\n', 'utf8');
    } catch (err) {
      this.logger.warn?.('[agenda-store] append failed', { error: err?.message });
    }
  }

  _hydrateRecord(record) {
    if (!record || typeof record !== 'object') return;
    record.kind = ['decision', 'question', 'idea'].includes(record.kind) ? record.kind : 'idea';
    record.topicTags = Array.isArray(record.topicTags) ? Array.from(new Set(record.topicTags.filter(Boolean))) : [];
    record.referencedNodes = Array.isArray(record.referencedNodes) ? Array.from(new Set(record.referencedNodes.filter(Boolean))) : [];
    record.createdAt = record.createdAt || new Date().toISOString();
    record.updatedAt = record.updatedAt || record.createdAt;
    record.lastSeenAt = record.lastSeenAt || record.updatedAt;
    record.seenCount = Math.max(1, parseInt(record.seenCount || 1, 10) || 1);
    record.history = Array.isArray(record.history) ? record.history : [];
    record._normContent = this._normalizeContent(record.content || '');
    record._tokenSet = this._tokenize(record.content || '');
    record._tagSet = new Set(record.topicTags.map(tag => this._normalizeTag(tag)));
    record._anchorSet = this._extractAnchors(record.content || '');
  }

  _buildEnvelope(params) {
    const kind = ['decision', 'question', 'idea'].includes(params.kind) ? params.kind : 'idea';
    const topicTags = Array.isArray(params.topicTags) ? Array.from(new Set(params.topicTags.filter(Boolean))) : [];
    return {
      content: String(params.content || '').trim(),
      kind,
      topicTags,
      normContent: this._normalizeContent(params.content || ''),
      tokenSet: this._tokenize(params.content || ''),
      tagSet: new Set(topicTags.map(tag => this._normalizeTag(tag))),
      anchorSet: this._extractAnchors(params.content || ''),
    };
  }

  _normalizeContent(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[`'".,!?()[\]{}:;]+/g, ' ')
      .replace(/[_/\\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _normalizeTag(tag) {
    return String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  _tokenize(text) {
    const raw = this._normalizeContent(text).split(' ').filter(Boolean);
    const tokens = new Set();
    for (let token of raw) {
      if (token.length < 4) continue;
      if (/^\d+$/.test(token)) continue;
      if (AGENDA_STOPWORDS.has(token)) continue;
      if (token.endsWith('ies') && token.length > 5) token = token.slice(0, -3) + 'y';
      else if (token.endsWith('s') && token.length > 4) token = token.slice(0, -1);
      if (AGENDA_STOPWORDS.has(token)) continue;
      tokens.add(token);
    }
    return tokens;
  }

  _extractAnchors(text) {
    const raw = String(text || '').toLowerCase();
    const anchors = new Set();
    const patterns = [
      ['ios-health-shortcut', /\bios health shortcut\b|\bhealth shortcut\b/],
      ['health-bridge', /\bhealth bridge\b|\bpi health bridge\b|~\/\.health_log\.jsonl/],
      ['correlation-view', /\bcorrelation view\b|\bcorrelation engine\b/],
      ['pressure-health-sauna', /\bpressure\b.*\bhealth\b.*\bsauna\b|\bhealth\b.*\bpressure\b.*\bsauna\b/],
      ['brain-housekeeping', /\bbrain-housekeeping\b/],
      ['run-intraday-review', /\brun-intraday-review\b|\bettimehm\b|\.\/lib\/time\.js\b/],
      ['forrest-boundary', /\bforrest\b|\bjerry\b/],
      ['recent-heartbeat', /\brecent\.md\b|\bheartbeat\.md\b/],
      ['pm2-cron', /\bpm2\b|\bcron\b/],
    ];
    for (const [label, pattern] of patterns) {
      if (pattern.test(raw)) anchors.add(label);
    }
    return anchors;
  }

  _findMergeTarget(envelope) {
    let best = null;
    let bestScore = 0;
    for (const rec of this.items.values()) {
      if (!DEDUPE_STATUSES.has(rec.status)) continue;
      const score = this._similarityScore(envelope, rec);
      if (score > bestScore) {
        bestScore = score;
        best = rec;
      }
    }
    return bestScore >= this.config.mergeSimilarityThreshold ? best : null;
  }

  _similarityScore(a, b) {
    const normA = a.normContent || a._normContent || '';
    const normB = b.normContent || b._normContent || '';
    if (!normA || !normB) return 0;
    if (normA === normB) return 1;
    if (normA.length > 36 && normB.length > 36 && (normA.includes(normB) || normB.includes(normA))) return 0.96;

    const tokenA = a.tokenSet || a._tokenSet || new Set();
    const tokenB = b.tokenSet || b._tokenSet || new Set();
    const tagA = a.tagSet || a._tagSet || new Set();
    const tagB = b.tagSet || b._tagSet || new Set();
    const anchorA = a.anchorSet || a._anchorSet || new Set();
    const anchorB = b.anchorSet || b._anchorSet || new Set();

    const tokenOverlap = this._setIntersectionSize(tokenA, tokenB);
    const tagOverlap = this._setIntersectionSize(tagA, tagB);
    const anchorOverlap = this._setIntersectionSize(anchorA, anchorB);
    const tokenUnion = Math.max(1, tokenA.size + tokenB.size - tokenOverlap);
    const tagUnion = Math.max(1, tagA.size + tagB.size - tagOverlap);
    const anchorUnion = Math.max(1, anchorA.size + anchorB.size - anchorOverlap);

    const tokenJaccard = tokenOverlap / tokenUnion;
    const tagJaccard = tagOverlap / tagUnion;
    const anchorJaccard = anchorOverlap / anchorUnion;
    const sameKind = a.kind && b.kind && a.kind === b.kind ? 0.08 : 0;
    const overlapBonus = tokenOverlap >= 4 ? 0.08 : 0;
    const anchorBonus = anchorOverlap > 0 ? 0.18 : 0;
    return Math.min(1, (tokenJaccard * 0.56) + (tagJaccard * 0.14) + (anchorJaccard * 0.24) + sameKind + overlapBonus + anchorBonus);
  }

  _setIntersectionSize(a, b) {
    if (!a || !b || a.size === 0 || b.size === 0) return 0;
    let count = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const value of small) {
      if (large.has(value)) count++;
    }
    return count;
  }

  _mergeIntoExisting(rec, params, envelope, now) {
    rec.updatedAt = now;
    rec.lastSeenAt = now;
    rec.seenCount = Math.max(1, rec.seenCount || 1) + 1;
    if (params.sourceThoughtId) rec.sourceThoughtId = params.sourceThoughtId;
    if (params.sourceCycleSessionId) rec.sourceCycleSessionId = params.sourceCycleSessionId;
    rec.topicTags = Array.from(new Set([...(rec.topicTags || []), ...envelope.topicTags]));
    rec.referencedNodes = Array.from(new Set([...(rec.referencedNodes || []), ...(Array.isArray(params.referencedNodes) ? params.referencedNodes : [])]));
    if (params.temporalContext) rec.temporalContext = params.temporalContext;
    this._hydrateRecord(rec);
    this._appendEvent({
      type: 'merge',
      id: rec.id,
      at: now,
      seenCount: rec.seenCount,
      topicTags: rec.topicTags,
      referencedNodes: rec.referencedNodes,
      sourceThoughtId: rec.sourceThoughtId,
      sourceCycleSessionId: rec.sourceCycleSessionId,
    });
  }

  _applyStatus(rec, newStatus, opts = {}) {
    const now = opts.at || new Date().toISOString();
    rec.status = newStatus;
    rec.updatedAt = now;
    rec.history.push({ status: newStatus, at: now, note: opts.note || null, actor: opts.actor || null });
    if (opts.persist !== false) {
      this._appendEvent({ type: 'status', id: rec.id, status: newStatus, at: now, note: opts.note, actor: opts.actor });
    }
  }

  _reconcileSurfaced(opts = {}) {
    const limit = Math.max(0, parseInt(this.config.surfaceLimit || 0, 10) || 0);
    if (limit <= 0) return;

    const active = Array.from(this.items.values())
      .filter(rec => ACTIVE_STATUSES.has(rec.status))
      .sort((a, b) => this._compareSurfacePriority(a, b));

    const surfaced = [];
    for (const rec of active) {
      if (surfaced.length >= limit) break;
      const tooSimilar = surfaced.some(existing =>
        this._similarityScore(
          { kind: rec.kind, normContent: rec._normContent, tokenSet: rec._tokenSet, tagSet: rec._tagSet, anchorSet: rec._anchorSet },
          existing
        ) >= this.config.surfaceSimilarityThreshold
      );
      if (tooSimilar) continue;
      surfaced.push(rec);
    }

    const surfacedIds = new Set(surfaced.map(rec => rec.id));
    for (const rec of active) {
      const desired = surfacedIds.has(rec.id) ? 'surfaced' : 'candidate';
      if (rec.status !== desired) {
        this._applyStatus(rec, desired, {
          actor: opts.actor || 'system',
          note: opts.note || (desired === 'surfaced' ? 'auto-surfaced into working set' : 'auto-demoted out of working set'),
          persist: true,
        });
      }
    }
  }

  _compareSurfacePriority(a, b) {
    const kindDelta = this._kindWeight(b.kind) - this._kindWeight(a.kind);
    if (kindDelta !== 0) return kindDelta;

    const specificityDelta = this._specificityScore(b) - this._specificityScore(a);
    if (specificityDelta !== 0) return specificityDelta;

    const abstractDelta = this._abstractPenalty(a) - this._abstractPenalty(b);
    if (abstractDelta !== 0) return abstractDelta;

    const seenDelta = (b.seenCount || 1) - (a.seenCount || 1);
    if (seenDelta !== 0) return seenDelta;

    const updatedDelta = b.updatedAt.localeCompare(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;

    return b.createdAt.localeCompare(a.createdAt);
  }

  _kindWeight(kind) {
    if (kind === 'decision') return 3;
    if (kind === 'question') return 2;
    return 1;
  }

  _abstractPenalty(rec) {
    const text = (rec.content || '').trim().toLowerCase();
    return ABSTRACT_OPENERS.some(prefix => text.startsWith(prefix)) ? 1 : 0;
  }

  _specificityScore(rec) {
    const text = String(rec.content || '');
    let score = 0;

    if (/\bnode\s+\d+\b/i.test(text)) score += 3;
    if (/\bgoal[_-]\d+\b/i.test(text)) score += 3;
    if (/(?:api\b|dashboard\b|shortcut\b|pm2\b|cron\b|log\b|config\b|workflow\b|recent\.md\b|heartbeat\.md\b|lib\/time\.js\b|ettimehm\b)/i.test(text)) score += 2;
    if (/(?:health\b|sauna\b|pressure\b|correlation\b|brain-housekeeping\b|forrest\b|jerry\b)/i.test(text)) score += 2;
    if (/^(build|fix|resolve|verify|investigate|audit|restore|re-enable|determine|check)\b/i.test(text.trim())) score += 1;

    return score;
  }
}

module.exports = { AgendaStore, VALID_STATUSES };
