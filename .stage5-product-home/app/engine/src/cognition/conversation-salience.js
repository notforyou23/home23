/**
 * Conversation Salience — reads harness-written sidecar, scores graph clusters
 * by relevance to recent conversation.
 *
 * Phase 7 of thinking-machine-cycle rebuild. See
 * docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md Conversation Salience.
 *
 * Sidecar format (one JSONL entry per compiled session):
 *   { ts, chatId, messageCount, summary }
 *
 * Scoring: token-overlap (Jaccard) between recent summaries and cluster node
 * concepts, weighted by recency. No embeddings required for v1 — keeps this
 * fast and dependency-free. Can upgrade to embedding cosine later.
 *
 * Recency weighting:
 *   0-1h:   weight 1.0
 *   1-24h:  linear decay to 0.3
 *   24-72h: linear decay to 0.0
 *   >72h:   ignored
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  maxAgeMs: 72 * 60 * 60 * 1000,    // ignore entries older than 72h
  maxEntries: 50,                    // cap recent entries to prevent unbounded scan
  minTokenLength: 3,                 // token must be at least 3 chars (drop "the","and")
  reloadIntervalMs: 60 * 1000,       // re-read sidecar every 60s (cheap)
  minClusterScore: 0.05,             // below this, cluster isn't considered salient
};

// Very common English words we strip to reduce noise
const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','but','not','are','was','were','you','your',
  'have','has','had','can','will','would','should','could','about','into','they','them','their',
  'what','when','where','why','how','which','who','one','two','also','just','like','some','any',
  'all','out','get','got','than','then','there','here','over','under','into','onto','been','being',
  'its','use','used','using','make','made','new','now','way','say','said','see','seen','still',
]);

class ConversationSalience {
  constructor(opts = {}) {
    if (!opts.brainDir) throw new Error('ConversationSalience requires brainDir');
    this.brainDir = opts.brainDir;
    this.sidecarPath = path.join(opts.brainDir, 'conversation-salience.jsonl');
    this.logger = opts.logger || console;
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };

    // Cached recent entries (tail of sidecar). Refreshed on read if mtime changes.
    this.recentEntries = [];
    this.lastMtimeMs = 0;
    this.lastLoadAt = 0;

    // Cached cluster-score map. Invalidated when entries change.
    this._cachedScores = null;
    this._cachedMemoryRef = null;
  }

  /**
   * Compute per-cluster salience scores against the current graph.
   * Returns a Map<clusterId, score> for clusters above minClusterScore.
   *
   * @param {NetworkMemory} memory
   * @param {Date} [now=new Date()]
   */
  scoreClusters(memory, now = new Date()) {
    this._maybeReload();
    if (this.recentEntries.length === 0) return new Map();

    const nowMs = now.getTime();
    const summaryTokensWithWeight = [];

    for (const entry of this.recentEntries) {
      const tsMs = new Date(entry.ts).getTime();
      if (!Number.isFinite(tsMs)) continue;
      const ageMs = nowMs - tsMs;
      if (ageMs > this.config.maxAgeMs) continue;
      const weight = this._recencyWeight(ageMs);
      if (weight <= 0) continue;
      const tokens = this._tokenize(entry.summary || '');
      if (tokens.size === 0) continue;
      summaryTokensWithWeight.push({ tokens, weight });
    }

    if (summaryTokensWithWeight.length === 0) return new Map();

    // Score each cluster by weighted Jaccard-like overlap
    const scores = new Map();
    for (const [clusterId, nodeSet] of memory.clusters.entries()) {
      const clusterTokens = this._clusterTokens(memory, nodeSet);
      if (clusterTokens.size === 0) continue;

      let weightedOverlap = 0;
      let totalWeight = 0;
      for (const { tokens, weight } of summaryTokensWithWeight) {
        const inter = this._intersectSize(tokens, clusterTokens);
        const union = tokens.size + clusterTokens.size - inter;
        const jaccard = union === 0 ? 0 : inter / union;
        weightedOverlap += jaccard * weight;
        totalWeight += weight;
      }
      const avgScore = totalWeight > 0 ? weightedOverlap / totalWeight : 0;
      if (avgScore >= this.config.minClusterScore) {
        scores.set(clusterId, avgScore);
      }
    }

    return scores;
  }

  /**
   * Return just the top N most-salient clusters with rationale text.
   * Useful for the discovery probe.
   */
  topSalientClusters(memory, n = 5, now = new Date()) {
    const scores = this.scoreClusters(memory, now);
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
    return sorted.map(([clusterId, score]) => {
      const nodeSet = memory.clusters.get(clusterId) || new Set();
      return {
        clusterId,
        score,
        nodeIds: Array.from(nodeSet).slice(0, 10),
        rationale: `recent conversation (last ${this.recentEntries.length} sessions) proximal to cluster ${clusterId} — score ${score.toFixed(3)}`,
      };
    });
  }

  /**
   * Debug/observability: count recent entries and their ages.
   */
  stats(now = new Date()) {
    this._maybeReload();
    const nowMs = now.getTime();
    let active = 0;
    for (const e of this.recentEntries) {
      const ageMs = nowMs - new Date(e.ts).getTime();
      if (ageMs <= this.config.maxAgeMs) active++;
    }
    return {
      totalCached: this.recentEntries.length,
      active,
      lastMtimeMs: this.lastMtimeMs,
      sidecarExists: fs.existsSync(this.sidecarPath),
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  _maybeReload() {
    // Quick mtime check — avoids re-reading on every probe tick
    if (Date.now() - this.lastLoadAt < this.config.reloadIntervalMs) return;
    this.lastLoadAt = Date.now();

    let stat;
    try {
      stat = fs.statSync(this.sidecarPath);
    } catch {
      // Missing file — clear cache
      this.recentEntries = [];
      this.lastMtimeMs = 0;
      return;
    }

    if (stat.mtimeMs === this.lastMtimeMs) return;
    this.lastMtimeMs = stat.mtimeMs;

    try {
      const raw = fs.readFileSync(this.sidecarPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object' && obj.summary && obj.ts) parsed.push(obj);
        } catch { /* skip bad line */ }
      }
      // Keep only the tail (most-recent)
      this.recentEntries = parsed.slice(-this.config.maxEntries);
    } catch (err) {
      this.logger.warn?.('[conversation-salience] read failed', { error: err?.message });
      this.recentEntries = [];
    }
  }

  _recencyWeight(ageMs) {
    if (ageMs < 60 * 60 * 1000) return 1.0;
    if (ageMs < 24 * 60 * 60 * 1000) {
      // linear decay 1.0 → 0.3 between 1h and 24h
      const frac = (ageMs - 60 * 60 * 1000) / (23 * 60 * 60 * 1000);
      return 1.0 - frac * 0.7;
    }
    if (ageMs < 72 * 60 * 60 * 1000) {
      // linear decay 0.3 → 0 between 24h and 72h
      const frac = (ageMs - 24 * 60 * 60 * 1000) / (48 * 60 * 60 * 1000);
      return Math.max(0, 0.3 - frac * 0.3);
    }
    return 0;
  }

  _tokenize(text) {
    const lower = String(text || '').toLowerCase();
    const tokens = lower.match(/[a-z][a-z0-9]{2,}/g) || [];
    const out = new Set();
    for (const t of tokens) {
      if (t.length < this.config.minTokenLength) continue;
      if (STOPWORDS.has(t)) continue;
      out.add(t);
    }
    return out;
  }

  _clusterTokens(memory, nodeSet) {
    // Concatenate concept text for cluster's nodes (cap at 30 nodes for speed)
    const tokens = new Set();
    let processed = 0;
    for (const nodeId of nodeSet) {
      if (processed >= 30) break;
      const node = memory.nodes.get(nodeId);
      if (!node || !node.concept) continue;
      const nt = this._tokenize(node.concept);
      for (const t of nt) tokens.add(t);
      processed++;
    }
    return tokens;
  }

  _intersectSize(a, b) {
    // Iterate the smaller set for speed
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let count = 0;
    for (const t of small) if (big.has(t)) count++;
    return count;
  }
}

module.exports = { ConversationSalience };
