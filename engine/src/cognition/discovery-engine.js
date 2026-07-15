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

const {
  classifyMemoryDomain,
  classifyClaimAuthority,
  scoreMemoryAuthority,
  createMemoryAuthorityResolver,
} = require('../../../shared/memory-authority.cjs');

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
  // Per-signal score multipliers applied at queue-rank time. Reality-grounded
  // fresh signals (observation-delta, novelty) get lift so they can compete
  // with orphan candidates that pin at importance 1.0 (max staleness × max
  // centrality). Without this, dense early-ingest identity material wins the
  // score race indefinitely and the cycle stays stuck on stale topics.
  scoring: {
    signalMultipliers: {
      'observation-delta': 1.5,
      'novelty':           1.2,
      'salience':          1.0,
      'anomaly':           1.0,
      'stagnation':        0.85,
      'orphan':            0.7,
    },
  },
  observationDedupe: {
    enabled: true,
    windowMs: 2 * 60 * 60 * 1000,
    channels: ['machine.cpu', 'machine.memory'],
  },
  // Phase 5: per-node decay applied on top of signal multipliers. Computed
  // on read from node timestamps — no schema change, no destructive
  // mutation. Permanence layered: high-access nodes, tagged-permanent
  // nodes, and any node accessed in the recent-access window all stay at
  // factor 1.0. Orphan signal is skipped (its probe already encodes age
  // via stalenessScore, double-dampening would erase the signal).
  decay: {
    enabled: true,
    halfLifeDays: 90,
    recentAccessResetDays: 14,
    highAccessThreshold: 20,
    permanentTagPatterns: ['identity', 'soul', 'doctrine', 'mission', 'permanent', 'invariant'],
    skipSignals: ['orphan'],
    floor: 0.05,
  },
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
    this.observationBuckets = new Map();

    // Probe state
    this.probeTimer = null;
    this.running = false;
    this.stats = {
      probeCount: 0,
      lastProbeAt: null,
      lastProbeDurationMs: null,
      candidatesByeSignal: {
        anomaly: 0, novelty: 0, orphan: 0, drift: 0, stagnation: 0, salience: 0,
        'observation-delta': 0, 'observation-suppressed': 0, 'good-life-regulated': 0,
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
      this._probeAuthorityContext = this._buildAuthorityContext();
      // Per-signal cap prevents one probe from dominating the queue.
      // Without this, a noisy signal (e.g., novelty with 3k+ fresh nodes)
      // crowds everything else out, or a cheap-but-overfiring signal
      // (drift on uniformly sparse real graphs) claims every heartbeat.
      const SIGNAL_CAP = this.config.perSignalCap || 8;
      const cap = (arr) => arr.sort((a, b) => b.score - a.score).slice(0, SIGNAL_CAP);

      const all = [
        ...cap(this._probeAnomaly()),
        ...cap(this._probeNovelty()),
        ...cap(this._probeOrphan()),
        ...cap(this._probeDrift()),
        ...cap(this._probeStagnation()),
        ...cap(this._probeSalience()),
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
    } finally {
      this._probeAuthorityContext = null;
    }
  }

  // ─── Shared helper: drop stale node IDs ─────────────────────────────

  _liveIds(nodeSet) {
    // Cluster memberships can reference nodes that have since been pruned
    // (high-water 33,968 → now 27,911 ≈ 6k pruned). Handing phantom IDs
    // to deep-dive causes empty-neighborhood thoughts about graph weirdness.
    // Filter at emission time.
    const live = [];
    for (const id of nodeSet) {
      if (this.memory.nodes.has(id)) live.push(id);
    }
    return live;
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

    const eligibleByCluster = new Map();
    const authorityResolver = this._authorityContext().resolver;
    for (const [clusterId, nodeSet] of clusters.entries()) {
      const ids = this._authorityEligibleIds(nodeSet, authorityResolver);
      if (ids.length > 0) eligibleByCluster.set(clusterId, ids);
    }
    if (eligibleByCluster.size < 2) return [];
    const sizes = Array.from(eligibleByCluster.values(), (ids) => ids.length);
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const upper = mean * this.config.anomaly.densityDeviationFactor;
    const lower = mean / this.config.anomaly.densityDeviationFactor;

    const out = [];
    for (const [clusterId, liveIds] of eligibleByCluster.entries()) {
      const size = liveIds.length;
      if (size > upper || size < lower) {
        const deviation = Math.abs(size - mean) / Math.max(mean, 1);
        out.push(this._makeCandidate({
          key: `anomaly:${clusterId}`,
          signal: 'anomaly',
          clusterId,
          nodeIds: liveIds.slice(0, 10),
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
    const authorityEligible = this._authorityContext().eligibleIds;
    const out = [];

    for (const [nodeId, node] of this.memory.nodes.entries()) {
      if (!authorityEligible.has(nodeId)) continue;
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
    const authorityEligible = this._authorityContext().eligibleIds;
    const out = [];

    for (const [nodeId, node] of this.memory.nodes.entries()) {
      if (!authorityEligible.has(nodeId)) continue;
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
    // DISABLED for real brain graphs pending temporal-baseline support.
    //
    // The v1 heuristic — "cluster with low internal edge density = drifting" —
    // was tuned against synthetic test graphs. Real brain graphs are uniformly
    // sparse (27k nodes / 17k edges / 5 clusters ≈ density 0.0002 everywhere),
    // so every cluster looked "thin" and drift claimed every heartbeat. The
    // signal needs a temporal baseline (density change over time, or growth-
    // without-new-edges detection) — neither of which exists yet.
    //
    // Re-enable when the engine records per-cluster density snapshots so we
    // can compare current to prior and emit genuine drift signal.
    this.stats.candidatesByeSignal.drift = 0;
    return [];
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
    const authorityEligible = this._authorityContext().eligibleIds;
    for (const [clusterId, touchCount] of touches.entries()) {
      if (touchCount < this.config.stagnation.minRepeatCount) continue;
      const newEdges = newEdgeCountByCluster.get(clusterId) || 0;
      if (newEdges > this.config.stagnation.maxNewEdgesAllowed) continue;

      const nodeSet = this.memory.clusters.get(clusterId);
      const liveIds = nodeSet
        ? this._liveIds(nodeSet).filter((id) => authorityEligible.has(id))
        : [];
      if (liveIds.length === 0) continue; // all stale — skip phantom

      const ratio = touchCount / Math.max(1, newEdges + 1); // higher = worse
      const importance = Math.min(1, 0.4 + ratio / 20);
      out.push(this._makeCandidate({
        key: `stagnation:${clusterId}`,
        signal: 'stagnation',
        clusterId,
        nodeIds: liveIds.slice(0, 10),
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
    const authorityEligible = this._authorityContext().eligibleIds;
    for (const hit of tops) {
      // Filter stale IDs — salience scorer reads cluster membership which
      // may reference pruned nodes.
      const liveIds = (hit.nodeIds || []).filter(id => (
        this.memory.nodes.has(id) && authorityEligible.has(id)
      ));
      if (liveIds.length === 0) continue;
      out.push(this._makeCandidate({
        key: `salience:${hit.clusterId}`,
        signal: 'salience',
        clusterId: hit.clusterId,
        nodeIds: liveIds,
        // Salience score is already [0,1]-ish via Jaccard. Scale slightly
        // so strong matches compete with novelty at the top of the queue.
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
    const decay = this._decayFactor(signal, nodeIds);
    const authority = this._authorityFactor(nodeIds);
    const score = this._score(importance, signal, tc) * decay * authority;
    return {
      key,
      signal,
      clusterId,
      nodeIds,
      importance,
      score,
      authorityFactor: authority,
      rationale,
      discoveredAt: new Date().toISOString(),
      temporalSnapshot: tc ? {
        phase: tc.jtrTime?.phase,
        dayType: tc.jtrTime?.dayType,
        activeRhythms: tc.jtrTime?.activeRhythms,
      } : null,
    };
  }

  _authorityFactor(nodeIds) {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) return 1;
    const factors = nodeIds
      .map((id) => this.memory?.nodes?.get?.(id))
      .filter(Boolean)
      .map((node) => scoreMemoryAuthority(node, 1, { intent: 'current_state' }));
    return factors.length ? factors.reduce((sum, value) => sum + value, 0) / factors.length : 1;
  }

  _authorityEligibleIds(nodeIds, resolver = null) {
    const liveNodes = this._liveIds(nodeIds)
      .map((id) => this.memory?.nodes?.get?.(id))
      .filter(Boolean);
    const authorityResolver = resolver || createMemoryAuthorityResolver({
      intent: 'current_state',
      authorityCandidates: this.memory?.nodes?.values?.() || [],
    });
    return authorityResolver.apply(liveNodes).filter((node) => {
      if (!node || classifyMemoryDomain(node) !== 'current_ops') return false;
      return ['verified_current_state', 'jtr_correction', 'artifact_log', 'worker_receipt']
        .includes(classifyClaimAuthority(node));
    }).map((node) => node.id);
  }

  _buildAuthorityContext() {
    const resolver = createMemoryAuthorityResolver({
      intent: 'current_state',
      authorityCandidates: this.memory?.nodes?.values?.() || [],
    });
    const eligibleIds = new Set();
    for (const node of this.memory?.nodes?.values?.() || []) {
      const resolved = resolver.apply([node])[0];
      if (!resolved || classifyMemoryDomain(resolved) !== 'current_ops') continue;
      if (['verified_current_state', 'jtr_correction', 'artifact_log', 'worker_receipt']
        .includes(classifyClaimAuthority(resolved))) eligibleIds.add(resolved.id);
    }
    return { resolver, eligibleIds };
  }

  _authorityContext() {
    return this._probeAuthorityContext || this._buildAuthorityContext();
  }

  /**
   * Phase 5 decay factor. Pure function of node timestamps + tags + access
   * count — never mutates node state. Returns a multiplier in [floor, 1].
   *
   * Permanence (always returns 1):
   *   - signal in skipSignals (orphan already encodes age)
   *   - decay disabled in config
   *   - node not found, or has no timestamps
   *   - accessCount >= highAccessThreshold (frequently-used = important)
   *   - tag matches a permanentTagPattern
   *   - accessed within recentAccessResetDays
   *
   * Otherwise: exponential half-life from last-access (or created) timestamp.
   */
  _decayFactor(signal, nodeIds) {
    const cfg = this.config.decay;
    if (!cfg?.enabled) return 1;
    if ((cfg.skipSignals || []).includes(signal)) return 1;
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) return 1;

    const node = this.memory?.nodes?.get?.(nodeIds[0]);
    if (!node) return 1;

    if (cfg.highAccessThreshold && (node.accessCount || 0) >= cfg.highAccessThreshold) return 1;

    if (Array.isArray(cfg.permanentTagPatterns) && node.tag) {
      const tagLower = String(node.tag).toLowerCase();
      for (const pat of cfg.permanentTagPatterns) {
        if (pat && tagLower.includes(String(pat).toLowerCase())) return 1;
      }
    }

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const accessedMs = node.accessed ? new Date(node.accessed).getTime() : 0;
    const createdMs = node.created ? new Date(node.created).getTime() : 0;

    if (!Number.isFinite(accessedMs) || accessedMs <= 0) {
      if (!Number.isFinite(createdMs) || createdMs <= 0) return 1;  // no timestamps — leave alone
    }

    const recentMs = (cfg.recentAccessResetDays || 0) * dayMs;
    if (accessedMs > 0 && (now - accessedMs) < recentMs) return 1;

    const referenceMs = accessedMs > 0 ? accessedMs : createdMs;
    const ageDays = (now - referenceMs) / dayMs;
    if (ageDays <= 0) return 1;

    const halfLife = cfg.halfLifeDays || 90;
    const factor = Math.pow(0.5, ageDays / halfLife);
    return Math.max(cfg.floor || 0.05, factor);
  }

  /**
   * Score = importance × per-signal multiplier.
   *
   * Each probe bakes signal-specific weighting (freshness for novelty,
   * staleness×centrality for orphan, etc.) into importance. The multiplier
   * here rebalances ACROSS signals so reality-grounded fresh candidates
   * (observation-delta, novelty) can outrank orphan candidates that pin at
   * importance 1.0. Tunable via config.scoring.signalMultipliers.
   */
  _score(importance, signal, _tc) {
    const mults = this.config.scoring?.signalMultipliers || {};
    const factor = mults[signal] != null ? mults[signal] : 1;
    return importance * factor;
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

  /**
   * Step 24 (Phase 6 external-candidate hook).
   *
   * Inject a verified observation from the OS-engine channel bus as a
   * discovery candidate. The cognitive cycle's DeepDive will pick it up
   * alongside internally-generated signals, so Discovery is no longer a
   * closed loop over its own thought graph — reality gets a seat at the
   * table.
   *
   * Only COLLECTED observations land in the queue. ZERO_CONTEXT is
   * recorded for audit via an observation-silence signal, counted in
   * stats but not enqueued.
   */
  injectObservation(obs) {
    if (!obs || !obs.channelId) return false;

    if (obs.channelId === 'domain.good-life') {
      // Good Life is an action/governance signal, not a free-association
      // thinking-machine topic. It is handled by GoodLifeRegulator, Agenda,
      // MotorCortex, ledger, trends, and the dashboard. Enqueuing it here
      // turns engine telemetry into narrative diagnosis.
      this.stats.candidatesByeSignal['good-life-regulated'] =
        (this.stats.candidatesByeSignal['good-life-regulated'] || 0) + 1;
      return false;
    }

    if (obs.flag !== 'COLLECTED' && obs.flag !== 'UNCERTIFIED') {
      // ZERO_CONTEXT / UNKNOWN — audit counter only, no candidate.
      this.stats.candidatesByeSignal['observation-silence'] =
        (this.stats.candidatesByeSignal['observation-silence'] || 0) + 1;
      return false;
    }

    const novelty = this._observationNovelty(obs);
    if (!novelty.accept) {
      this.stats.candidatesByeSignal['observation-suppressed'] =
        (this.stats.candidatesByeSignal['observation-suppressed'] || 0) + 1;
      // Batched logging: only log every 50th suppression to avoid spam
      const suppressed = this.stats.candidatesByeSignal['observation-suppressed'];
      if (suppressed % 50 === 0) {
        this.logger.debug?.('[discovery] suppressed observation batch', {
          totalSuppressed: suppressed,
          lastChannelId: obs.channelId,
          lastBucket: novelty.bucket,
          lastReason: novelty.reason,
        });
      }
      return false;
    }

    const importance = Math.max(0.1, Math.min(1, obs.confidence || 0.5));
    const signal = obs.channelId === 'domain.good-life' ? 'good-life' : 'observation-delta';
    const candidate = this._makeCandidate({
      key: novelty.key || `observation:${obs.channelId}:${obs.sourceRef}`,
      signal,
      clusterId: null,
      nodeIds: [],
      importance: Math.min(1, importance * (novelty.importanceMultiplier || 1)),
      rationale: novelty.rationale || `bus observation ${obs.channelId} (${obs.flag}, confidence ${importance.toFixed(2)})`,
    });
    // Attach the raw observation so DeepDive can access the payload.
    candidate.observation = obs;
    this._enqueue(candidate);
    this.stats.candidatesByeSignal[signal] =
      (this.stats.candidatesByeSignal[signal] || 0) + 1;
    this.stats.totalCandidatesProduced += 1;
    return true;
  }

  _observationNovelty(obs) {
    const cfg = this.config.observationDedupe || {};
    if (!cfg.enabled) {
      return { accept: true, key: `observation:${obs.channelId}:${obs.sourceRef}` };
    }

    const channels = new Set(cfg.channels || []);
    if (!channels.has(obs.channelId)) {
      return { accept: true, key: `observation:${obs.channelId}:${obs.sourceRef}` };
    }

    const bucket = semanticObservationBucket(obs);
    if (!bucket) {
      return { accept: true, key: `observation:${obs.channelId}:${obs.sourceRef}` };
    }

    const windowMs = Math.max(0, Number(cfg.windowMs) || 0);
    const nowMs = Date.parse(obs.producedAt || obs.receivedAt || '') || Date.now();
    const stateKey = obs.channelId;
    const prev = this.observationBuckets.get(stateKey);
    const sameBucket = prev?.bucket === bucket;
    const ageMs = prev ? nowMs - prev.atMs : Infinity;

    if (sameBucket && ageMs >= 0 && ageMs < windowMs) {
      return {
        accept: false,
        bucket,
        reason: `same semantic bucket within ${humanAge(windowMs)}`,
      };
    }

    this.observationBuckets.set(stateKey, { bucket, atMs: nowMs });
    return {
      accept: true,
      bucket,
      key: `observation:${obs.channelId}:${bucket}`,
      rationale: `bus observation ${obs.channelId} entered ${bucket} (${obs.flag})`,
      importanceMultiplier: prev && prev.bucket !== bucket ? 1.1 : 1,
    };
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

function semanticObservationBucket(obs) {
  const payload = obs?.payload || {};
  if (obs.channelId === 'machine.cpu') {
    const loadAvg = Array.isArray(payload.loadAvg) ? payload.loadAvg : [];
    const load1 = Number(loadAvg[0]);
    const cpuCount = Math.max(1, Number(payload.cpuCount) || 1);
    if (!Number.isFinite(load1)) return null;
    const ratio = load1 / cpuCount;
    if (ratio >= 1.05) return 'cpu:overcommitted';
    if (ratio >= 0.8) return 'cpu:saturated';
    if (ratio >= 0.5) return 'cpu:elevated';
    return 'cpu:normal';
  }

  if (obs.channelId === 'machine.memory') {
    const freePct = Number(payload.freePct);
    if (!Number.isFinite(freePct)) return null;
    if (freePct <= 2) return 'memory:critical';
    if (freePct <= 5) return 'memory:severe';
    if (freePct <= 10) return 'memory:low';
    if (freePct <= 15) return 'memory:tight';
    return 'memory:normal';
  }

  if (obs.channelId === 'domain.good-life') {
    const mode = payload?.policy?.mode || 'observe';
    const lanes = payload?.lanes || {};
    const critical = Object.entries(lanes).find(([, v]) => v?.status === 'critical');
    const strained = Object.entries(lanes).find(([, v]) => v?.status === 'strained');
    if (critical) return `good-life:${mode}:critical:${critical[0]}`;
    if (strained) return `good-life:${mode}:strained:${strained[0]}`;
    return `good-life:${mode}:steady`;
  }

  return null;
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
