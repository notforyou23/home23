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
  staleAfterMs: 14 * 24 * 60 * 60 * 1000,   // 14 days untouched → auto-stale
  decayReviewMs: 6 * 60 * 60 * 1000,        // run decay review every 6 hours
};

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
    const id = `ag-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record = {
      id,
      content: String(params.content || '').trim(),
      kind: params.kind || 'idea',
      topicTags: Array.isArray(params.topicTags) ? params.topicTags : [],
      sourceThoughtId: params.sourceThoughtId || null,
      sourceCycleSessionId: params.sourceCycleSessionId || null,
      referencedNodes: Array.isArray(params.referencedNodes) ? params.referencedNodes : [],
      temporalContext: params.temporalContext || null,
      createdAt: now,
      updatedAt: now,
      status: 'candidate',
      history: [{ status: 'candidate', at: now, note: null }],
    };
    if (!record.content) return null;

    this.items.set(id, record);
    this._appendEvent({ type: 'add', id, record });
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

    const now = new Date().toISOString();
    rec.status = newStatus;
    rec.updatedAt = now;
    rec.history.push({ status: newStatus, at: now, note: opts.note || null, actor: opts.actor || null });
    this._appendEvent({ type: 'status', id, status: newStatus, at: now, note: opts.note, actor: opts.actor });
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
    const sortBy = filter.sortBy || 'createdAt_desc';
    items.sort((a, b) => {
      if (sortBy === 'createdAt_asc') return a.createdAt.localeCompare(b.createdAt);
      if (sortBy === 'updatedAt_desc') return b.updatedAt.localeCompare(a.updatedAt);
      return b.createdAt.localeCompare(a.createdAt); // default desc
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
      if (now - updatedMs > this.config.staleAfterMs) {
        this.updateStatus(rec.id, 'stale', { actor: 'decay', note: 'auto-stale after inactivity window' });
        marked++;
      }
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
      this.items.set(evt.id, evt.record);
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
}

module.exports = { AgendaStore, VALID_STATUSES };
