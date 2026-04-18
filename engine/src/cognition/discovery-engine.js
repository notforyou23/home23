/**
 * Discovery Engine — continuous graph-topology probing
 *
 * Phase 2 of the thinking-machine-cycle rebuild. See
 * docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md.
 *
 * Runs in the background (same Node process, async interval, non-blocking),
 * probing the brain's graph for mining candidates. All signals are pure graph
 * math — no LLM calls. Emits a ranked queue of candidates that later phases
 * (deep-dive → PGS → critique) will consume.
 *
 * Six signals:
 *   - anomaly:    clusters with unusual density relative to the mean
 *   - novelty:    recently-ingested nodes with few edges (unconnected material)
 *   - orphan:     high-centrality nodes not visited in a long time
 *   - drift:      new clusters with thin structure (thought diverging from established graph)
 *   - stagnation: clusters thought about repeatedly without producing new edges
 *   - salience:   conversation-proximal clusters (stub until Phase 7 wires the sidecar)
 *
 * Behind `architecture.cognitionMode` flag — daemon runs for observability
 * under `legacy_roles`, feeds the deep-thought pipeline under `thinking_machine`.
 */

'use strict';

const DEFAULT_CONFIG = {
  probeIntervalMs: 30 * 1000,     // 30s between probes
  queueCapacity: 100,              // max candidates in the ranked queue
  // Signal thresholds — tunable from config later
  novelty: {
    nodeAgeMaxMs: 24 * 60 * 60 * 1000,  // "recent" = within last 24h
    maxEdgeCount: 2,                     // unconnected = ≤2 edges
  },
  orphan: {
    accessedAgeMinMs: 7 * 24 * 60 * 60 * 1000, // "neglected" = not accessed in 7 days
    minEdgeCount: 5,                            // "high centrality" = ≥5 edges
  },
  anomaly: {
    densityDeviationFactor: 2.0,   // cluster density > 2× mean (or < 1/2) is anomalous
  },
  drift: {
    clusterAgeMaxMs: 3 * 24 * 60 * 60 * 1000, // new cluster = ≤3 days old
    maxInternalEdgeDensity: 0.1,               // thin structure = low internal connectivity
  },
  stagnation: {
    recentThoughtWindow: 30,       // look at last N thoughts
    minRepeatCount: 5,             // cluster touched 5+ times
    maxNewEdgesAllowed: 1,         // without producing more than 1 new edge
  },
  // Aging / weighting
  importanceEdgeWeight: 0.6,       // how much edge count contributes to importance
  importanceAccessWeight: 0.4,     // how much access count contributes
};

class DiscoveryEngine {
  /**
   * @param {object} opts
   * @param {object} opts.memory          - NetworkMemory instance
   * @param {object} opts.logger
   * @param {object} [opts.config]        - override DEFAULT_CONFIG
   * @param {Function} [opts.getThoughtsHistory] - returns recent thoughts array for stagnation detection
   * @param {Function} [opts.getTemporalContext] - returns current temporal context (age weighting)
   * @param {Function} [opts.getConversationSalience] - stubbed for Phase 7
   */
  constructor(opts = {}) {
    if (!opts.memory) throw new Error('DiscoveryEngine requires memory (NetworkMemory instance)');
    this.memory = opts.memory;
    this.logger = opts.logger || console;
    this.config = deepMerge(DEFAULT_CONFIG, opts.config || {});
    this.getThoughtsHistory = opts.getThoughtsHistory || (() => []);
    this.getTemporalContext = opts.getTemporalContext || (() => null);
    this.getConversationSalience = opts.getConversationSalience || (() => null);

    // Ranked queue — map keyed by candidate.key for dedup, sorted on pop
    this.queue = new Map();

    // Probe state
    this.probeTimer = null;
    this.running = false;
    this.stats = {
      probeCount: 0,
      lastProbeAt: null,
      lastProbeDurationMs: null,
      candidatesByeSignal: {
        anomaly: 0, novelty: 0, orphan: 0, drift: 0, stagnation: 0, salience: 0,
      },
      queueDepth: 0,
      totalCandidatesProduced: 0,
      errors: 0,
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info?.('[discovery] started', {
      intervalMs: this.config.probeIntervalMs,
      queueCapacity: this.config.queueCapacity,
    });
    // Fire first probe immediately so the queue has something to inspect
    this._runProbe().catch(err => this._onProbeError(err));
    this.probeTimer = setInterval(() => {
      this._runProbe().catch(err => this._onProbeError(err));
    }, this.config.probeIntervalMs);
    // Don't keep the Node event loop alive just for probing
    if (this.probeTimer.unref) this.probeTimer.unref();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    this.logger.info?.('[discovery] stopped');
  }

  // ─── Probe orchestration ─────────────────────────────────────────────

  async _runProbe() {
    const start = Date.now();
    try {
      const all = [
        ...this._probeAnomaly(),
        ...this._probeNovelty(),
        ...this._probeOrphan(),
        ...this._probeDrift(),
        ...this._probeStagnation(),
        ...this._probeSalience(),
      ];

      for (const cand of all) {
        this._enqueue(cand);
      }
      this._trimQueue();

      this.stats.probeCount++;
      this.stats.lastProbeAt = new Date().toISOString();
      this.stats.lastProbeDurationMs = Date.now() - start;
      this.stats.queueDepth = this.queue.size;
      this.stats.totalCandidatesProduced += all.length;
    } catch (err) {
      this._onProbeError(err);
    }
  }

  _onProbeError(err) {
    this.stats.errors++;
    this.logger.warn?.('[discovery] probe failed', { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
  }

  // ─── Public queue API ─────────────────────────────────────────────────

  /**
   * Drain top N candidates, removing them from the queue.
   * Returns [] if queue empty.
   */
  pop(n = 1) {
    const ranked = Array.from(this.queue.values()).sort((a, b) => b.score - a.score);
    const out = ranked.slice(0, n);
    for (const c of out) this.queue.delete(c.key);
    this.stats.queueDepth = this.queue.size;
    return out;
  }

  /**
   * Peek without draining. For observability.
   */
  peek(n = 10) {
    return Array.from(this.queue.values()).sort((a, b) => b.score - a.score).slice(0, n);
  }

  getStats() {
    return { ...this.stats, queueDepth: this.queue.size, running: this.running };
  }

  // ─── Signal probes ────────────────────────────────────────────────────

  _probeAnomaly() {
    const clusters = this.memory.clusters;
    if (!clusters || clusters.size < 2) return [];

    const sizes = [];
    for (const nodeSet of clusters.values()) {
      sizes.push(nodeSet.size || 0);
    }
    if (sizes.length === 0) return [];
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const upper = mean * this.config.anomaly.densityDeviationFactor;
    const lower = mean / this.config.anomaly.densityDeviationFactor;

    const out = [];
    for (const [clusterId, nodeSet] of clusters.entries()) {
      const size = nodeSet.size || 0;
      if (size > upper || size < lower) {
        const deviation = Math.abs(size - mean) / Math.max(mean, 1);
        out.push(this._makeCandidate({
          key: `anomaly:${clusterId}`,
          signal: 'anomaly',
          clusterId,
          nodeIds: Array.from(nodeSet).slice(0, 10),
          importance: Math.min(1, deviation / 3), // deviation of 3× or more = max importance
          rationale: `cluster ${clusterId} size=${size} vs mean=${mean.toFixed(1)} (deviation ${deviation.toFixed(2)}×)`,
        }));
      }
    }
    this.stats.candidatesByeSignal.anomaly = out.length;
    return out;
  }

  _probeNovelty() {
    const now = Date.now();
    const maxAge = this.config.novelty.nodeAgeMaxMs;
    const maxEdges = this.config.novelty.maxEdgeCount;

    const edgeCountByNode = this._buildEdgeCountIndex();
    const out = [];

    for (const [nodeId, node] of this.memory.nodes.entries()) {
      const createdMs = node.created ? new Date(node.created).getTime() : 0;
      if (!createdMs) continue;
      const ageMs = now - createdMs;
      if (ageMs > maxAge) continue;

      const edgeCount = edgeCountByNode.get(nodeId) || 0;
      if (edgeCount > maxEdges) continue;

      // Freshness decays sharply within the window
      const freshness = 1 - (ageMs / maxAge);
      const importance = Math.max(0.2, freshness);

      out.push(this._makeCandidate({
        key: `novelty:${nodeId}`,
        signal: 'novelty',
        clusterId: node.cluster ?? null,
        nodeIds: [nodeId],
        importance,
        rationale: `node ${nodeId} created ${humanAge(ageMs)} ago, ${edgeCount} edges (unconnected material)`,
      }));
    }
    this.stats.candidatesByeSignal.novelty = out.length;
    return out;
  }

  _probeOrphan() {
    const now = Date.now();
    const minAccessAge = this.config.orphan.accessedAgeMinMs;
    const minEdges = this.config.orphan.minEdgeCount;

    const edgeCountByNode = this._buildEdgeCountIndex();
    const out = [];

    for (const [nodeId, node] of this.memory.nodes.entries()) {
      const edgeCount = edgeCountByNode.get(nodeId) || 0;
      if (edgeCount < minEdges) continue;

      const accessedMs = node.accessed ? new Date(node.accessed).getTime() : (node.created ? new Date(node.created).getTime() : 0);
      if (!accessedMs) continue;
      const sinceAccessMs = now - accessedMs;
      if (sinceAccessMs < minAccessAge) continue;

      // Orphan importance rises with staleness AND centrality
      const stalenessScore = Math.min(1, sinceAccessMs / (minAccessAge * 4));
      const centralityScore = Math.min(1, edgeCount / 50);
      const importance = 0.5 * stalenessScore + 0.5 * centralityScore;

      out.push(this._makeCandidate({
        key: `orphan:${nodeId}`,
        signal: 'orphan',
        clusterId: node.cluster ?? null,
        nodeIds: [nodeId],
        importance,
        rationale: `node ${nodeId} (${edgeCount} edges) not accessed in ${humanAge(sinceAccessMs)} — high-centrality but neglected`,
      }));
    }
    this.stats.candidatesByeSignal.orphan = out.length;
    return out;
  }

  _probeDrift() {
    // v1 heuristic: new clusters with thin internal edge density.
    // A new cluster with few internal edges relative to its size suggests
    // thoughts diverging from established structure.
    const now = Date.now();
    const maxAge = this.config.drift.clusterAgeMaxMs;
    const maxDensity = this.config.drift.maxInternalEdgeDensity;

    const out = [];
    for (const [clusterId, nodeSet] of this.memory.clusters.entries()) {
      if (nodeSet.size < 3) continue; // too small to judge density

      // Cluster age ≈ max(node.created) in the cluster. Cheap approximation.
      let newest = 0;
      for (const nodeId of nodeSet) {
        const node = this.memory.nodes.get(nodeId);
        const created = node?.created ? new Date(node.created).getTime() : 0;
        if (created > newest) newest = created;
      }
      if (!newest || (now - newest) > maxAge) continue;

      // Internal edge density = internal edges / max possible (n*(n-1)/2)
      const internalEdges = this._countInternalEdges(nodeSet);
      const maxPossible = (nodeSet.size * (nodeSet.size - 1)) / 2;
      const density = maxPossible > 0 ? internalEdges / maxPossible : 0;
      if (density > maxDensity) continue;

      const importance = Math.min(1, 0.5 + (maxDensity - density) * 5);
      out.push(this._makeCandidate({
        key: `drift:${clusterId}`,
        signal: 'drift',
        clusterId,
        nodeIds: Array.from(nodeSet).slice(0, 10),
        importance,
        rationale: `cluster ${clusterId} newest node ${humanAge(now - newest)} ago, internal density ${density.toFixed(3)} (thin structure)`,
      }));
    }
    this.stats.candidatesByeSignal.drift = out.length;
    return out;
  }

  _probeStagnation() {
    // Look at recent thoughts. Count how often each cluster is "touched" by a
    // thought (via role tags, node references, or cluster metadata on the
    // thought). If a cluster is touched ≥minRepeatCount times but has produced
    // ≤maxNewEdgesAllowed new edges in that window, it's stagnating.
    const thoughts = this.getThoughtsHistory() || [];
    const window = thoughts.slice(-this.config.stagnation.recentThoughtWindow);
    if (window.length < 5) return [];

    // Count cluster touches per thought. A thought "touches" a cluster if the
    // thought's referencedNodeIds fall into that cluster. For v1 without
    // explicit reference tracking on thoughts, fall back to cluster field if
    // present, else skip.
    const touches = new Map(); // clusterId -> count
    const windowStart = window[0]?.timestamp ? new Date(window[0].timestamp).getTime() : 0;
    for (const t of window) {
      const cid = t.clusterId ?? t.cluster ?? null;
      if (cid == null) continue;
      touches.set(cid, (touches.get(cid) || 0) + 1);
    }
    if (touches.size === 0) return [];

    // Count new edges per cluster since windowStart
    const newEdgeCountByCluster = new Map();
    if (windowStart > 0) {
      for (const [edgeKey, edge] of this.memory.edges.entries()) {
        const created = edge.created ? new Date(edge.created).getTime() : 0;
        if (created < windowStart) continue;
        // Figure out which cluster(s) this edge belongs to by looking at its endpoints
        const [a, b] = edgeKey.split('->');
        const clusterA = this.memory.nodes.get(a)?.cluster;
        const clusterB = this.memory.nodes.get(b)?.cluster;
        if (clusterA != null) newEdgeCountByCluster.set(clusterA, (newEdgeCountByCluster.get(clusterA) || 0) + 1);
        if (clusterB != null && clusterB !== clusterA) newEdgeCountByCluster.set(clusterB, (newEdgeCountByCluster.get(clusterB) || 0) + 1);
      }
    }

    const out = [];
    for (const [clusterId, touchCount] of touches.entries()) {
      if (touchCount < this.config.stagnation.minRepeatCount) continue;
      const newEdges = newEdgeCountByCluster.get(clusterId) || 0;
      if (newEdges > this.config.stagnation.maxNewEdgesAllowed) continue;

      const ratio = touchCount / Math.max(1, newEdges + 1); // higher = worse
      const importance = Math.min(1, 0.4 + ratio / 20);
      const nodeSet = this.memory.clusters.get(clusterId);
      out.push(this._makeCandidate({
        key: `stagnation:${clusterId}`,
        signal: 'stagnation',
        clusterId,
        nodeIds: nodeSet ? Array.from(nodeSet).slice(0, 10) : [],
        importance,
        rationale: `cluster ${clusterId} touched ${touchCount}× in last ${window.length} thoughts, only ${newEdges} new edges — stagnating`,
      }));
    }
    this.stats.candidatesByeSignal.stagnation = out.length;
    return out;
  }

  _probeSalience() {
    // Phase 7: read ConversationSalience scorer injected by the orchestrator.
    // Scorer is expected to be a { topSalientClusters(memory, n) } interface
    // returning [{ clusterId, score, nodeIds, rationale }].
    const scorer = this.getConversationSalience?.();
    this.stats.candidatesByeSignal.salience = 0;
    if (!scorer || typeof scorer.topSalientClusters !== 'function') return [];

    let tops;
    try {
      tops = scorer.topSalientClusters(this.memory, 5);
    } catch (err) {
      this.logger?.warn?.('[discovery] salience probe failed', { error: err?.message });
      return [];
    }
    if (!Array.isArray(tops) || tops.length === 0) return [];

    const out = [];
    for (const hit of tops) {
      out.push(this._makeCandidate({
        key: `salience:${hit.clusterId}`,
        signal: 'salience',
        clusterId: hit.clusterId,
        nodeIds: hit.nodeIds || [],
        // Salience score is already [0,1]-ish via Jaccard. Scale slightly
        // so strong matches compete with novelty/drift at the top of the queue.
        importance: Math.min(1, 0.4 + hit.score * 3),
        rationale: hit.rationale || `conversation-salience for cluster ${hit.clusterId}`,
      }));
    }
    this.stats.candidatesByeSignal.salience = out.length;
    return out;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _makeCandidate({ key, signal, clusterId, nodeIds, importance, rationale }) {
    const tc = this.getTemporalContext?.();
    const score = this._score(importance, signal, tc);
    return {
      key,
      signal,
      clusterId,
      nodeIds,
      importance,
      score,
      rationale,
      discoveredAt: new Date().toISOString(),
      temporalSnapshot: tc ? {
        phase: tc.jtrTime?.phase,
        dayType: tc.jtrTime?.dayType,
        activeRhythms: tc.jtrTime?.activeRhythms,
      } : null,
    };
  }

  /**
   * Score = importance × signal-specific recency factor × global salience
   * Temporal awareness informs recency differently per signal:
   *   orphan — ages HOT (aging problems escalate)
   *   stagnation — ages COLD (stagnant topics deprioritize with time)
   *   novelty — freshness matters most when new (already applied in probe)
   *   others — flat
   */
  _score(importance, signal) {
    // importance already bakes in signal-specific weighting in each probe
    // Keep scoring transparent: score = importance × 1 for now.
    // Ranking tuning happens via importance values in each probe, not here.
    return importance;
  }

  _enqueue(candidate) {
    const existing = this.queue.get(candidate.key);
    if (existing) {
      // Re-discovered — refresh timestamp, keep higher score
      if (candidate.score > existing.score) {
        this.queue.set(candidate.key, candidate);
      } else {
        existing.discoveredAt = candidate.discoveredAt;
      }
    } else {
      this.queue.set(candidate.key, candidate);
    }
  }

  _trimQueue() {
    if (this.queue.size <= this.config.queueCapacity) return;
    // Drop lowest-scoring first
    const sorted = Array.from(this.queue.values()).sort((a, b) => b.score - a.score);
    const keep = sorted.slice(0, this.config.queueCapacity);
    this.queue = new Map(keep.map(c => [c.key, c]));
  }

  _buildEdgeCountIndex() {
    const counts = new Map();
    for (const edgeKey of this.memory.edges.keys()) {
      const [a, b] = edgeKey.split('->');
      counts.set(a, (counts.get(a) || 0) + 1);
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    return counts;
  }

  _countInternalEdges(nodeSet) {
    let count = 0;
    for (const edgeKey of this.memory.edges.keys()) {
      const [a, b] = edgeKey.split('->');
      if (nodeSet.has(a) && nodeSet.has(b)) count++;
    }
    return count;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────

function humanAge(ms) {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

module.exports = { DiscoveryEngine };
