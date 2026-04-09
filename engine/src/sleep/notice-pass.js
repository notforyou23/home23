'use strict';

// Notice Pass: lightweight sleep-window scanner.
// Hard constraint: separate from chaotic engine; read-only scan of memory graph.

class NoticePass {
  constructor(memoryGraph, config, logger) {
    this.memory = memoryGraph;
    this.config = config || {};
    this.logger = logger;

    // Keep heuristics conservative.
    this.maxPerType = 2;
    this.maxTotal = 5;

    this.thresholds = {
      staleDays: 7,
      activeDays: 2,
      timeSensitiveDays: 14,
      weakEdge: 0.2,
      highNodeWeight: 0.7
    };
  }

  async run() {
    const noticings = [];
    try { noticings.push(...await this.scanGaps()); } catch (e) { this._warn('scanGaps failed', e); }
    try { noticings.push(...await this.scanStale()); } catch (e) { this._warn('scanStale failed', e); }
    try { noticings.push(...await this.scanTimeSensitive()); } catch (e) { this._warn('scanTimeSensitive failed', e); }
    try { noticings.push(...await this.scanConnections()); } catch (e) { this._warn('scanConnections failed', e); }
    try { noticings.push(...await this.scanEmotional()); } catch (e) { this._warn('scanEmotional failed', e); }

    // De-dupe by (type + subject)
    const seen = new Set();
    const uniq = [];
    for (const n of noticings) {
      const key = `${n.type}::${n.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(n);
      if (uniq.length >= this.maxTotal) break;
    }
    return uniq.slice(0, this.maxTotal);
  }

  // ---- Scanners ----

  async scanGaps() {
    // Heuristic: clusters with many nodes but very low cross-cluster connectivity.
    const { nodes, edges } = this._getGraph();
    const clusters = this._clusterIndex(nodes);
    if (clusters.size === 0 || edges.length === 0) return [];

    const crossByCluster = new Map();
    for (const { source, target, weight } of edges) {
      const a = nodes.get(source);
      const b = nodes.get(target);
      if (!a || !b) continue;
      const ca = this._getClusterId(a);
      const cb = this._getClusterId(b);
      if (ca == null || cb == null || ca === cb) continue;
      const cur = crossByCluster.get(ca) || { count: 0, totalWeight: 0 };
      cur.count += 1;
      cur.totalWeight += (typeof weight === 'number' ? weight : 0);
      crossByCluster.set(ca, cur);
    }

    const candidates = [];
    for (const [clusterId, nodeIds] of clusters) {
      if (nodeIds.length < 8) continue;
      const cross = crossByCluster.get(clusterId) || { count: 0, totalWeight: 0 };
      const crossDensity = cross.count / nodeIds.length;
      if (crossDensity > 0.15) continue;

      // Pick top 2 nodes by weight as evidence.
      const top = nodeIds
        .map(id => nodes.get(id))
        .filter(Boolean)
        .sort((x, y) => (this._num(y.weight) - this._num(x.weight)))
        .slice(0, 2);
      const evidence = top.map(n => this._snippet(n.concept)).join(' | ');
      const subject = `Sparse connections around cluster ${clusterId}`;

      const routed = this._routeByTopic(evidence, { type: 'gap' });
      candidates.push({
        type: 'gap',
        subject,
        evidence: `cluster=${clusterId} nodes=${nodeIds.length} crossEdges=${cross.count}; top=${evidence}`,
        implication: 'This looks like an island: a missing connective note/bridge could unlock reuse across projects.',
        routing: routed.routing,
        priority: routed.priority
      });
    }

    return this._take(candidates, this.maxPerType);
  }

  async scanStale() {
    // Heuristic: stale nodes (not accessed in N days) inside clusters that are currently active.
    const { nodes } = this._getGraph();
    const clusters = this._clusterIndex(nodes);
    if (clusters.size === 0) return [];

    const now = Date.now();
    const staleMs = this.thresholds.staleDays * 24 * 60 * 60 * 1000;
    const activeMs = this.thresholds.activeDays * 24 * 60 * 60 * 1000;

    const out = [];
    for (const [clusterId, nodeIds] of clusters) {
      if (nodeIds.length < 5) continue;

      const nodesIn = nodeIds.map(id => nodes.get(id)).filter(Boolean);
      const mostRecent = nodesIn
        .map(n => this._time(n.accessed || n.lastActivated || n.updatedAt || n.created))
        .filter(t => t)
        .sort((a, b) => b - a)[0] || 0;

      if (!mostRecent || (now - mostRecent) > activeMs) continue; // cluster not active

      const stale = nodesIn
        .filter(n => {
          const t = this._time(n.accessed || n.lastActivated || n.updatedAt || n.created);
          return t && (now - t) > staleMs;
        })
        .sort((a, b) => this._time(a.accessed) - this._time(b.accessed))
        .slice(0, 2);

      for (const n of stale) {
        const subject = `Stale memory in active cluster ${clusterId}: ${this._snippet(n.concept)}`;
        const evidence = `cluster=${clusterId} node=${n.id} lastAccess=${this._iso(n.accessed || n.lastActivated || n.updatedAt || n.created)}`;
        const routed = this._routeByTopic(n.concept, { type: 'stale' });
        out.push({
          type: 'stale',
          subject,
          evidence,
          implication: 'If this is still relevant, it may need a refresh or promotion into an active plan/goal.',
          routing: routed.routing,
          priority: routed.priority
        });
      }
    }

    return this._take(out, this.maxPerType);
  }

  async scanTimeSensitive() {
    // Heuristic: concepts containing explicit dates or time markers.
    const { nodes } = this._getGraph();
    const now = Date.now();
    const horizonMs = this.thresholds.timeSensitiveDays * 24 * 60 * 60 * 1000;

    const candidates = [];
    for (const node of nodes.values()) {
      const text = String(node.concept || '');
      if (!text) continue;

      const date = this._extractDate(text);
      if (!date) continue;

      const dt = date.getTime();
      if (dt < now - (2 * 24 * 60 * 60 * 1000)) continue; // ignore old
      if (dt > now + horizonMs) continue; // too far

      candidates.push({
        type: 'time-sensitive',
        subject: `Upcoming date mentioned: ${date.toISOString().slice(0, 10)}`,
        evidence: `node=${node.id} "${this._snippet(text)}"`,
        implication: 'Time-bound item detected in memory; consider turning it into a reminder or near-term plan.',
        routing: 'reminder',
        priority: 'high'
      });

      if (candidates.length >= this.maxPerType) break;
    }

    // If we found time-sensitive, keep them high and prefer bridge-chat/reminder.
    return this._take(candidates, this.maxPerType);
  }

  async scanConnections() {
    // Heuristic: weak edges between different clusters with strong endpoint nodes.
    const { nodes, edges } = this._getGraph();
    if (edges.length === 0) return [];

    const out = [];
    for (const e of edges) {
      const w = this._num(e.weight);
      if (w <= 0 || w > this.thresholds.weakEdge) continue;

      const a = nodes.get(e.source);
      const b = nodes.get(e.target);
      if (!a || !b) continue;

      const ca = this._getClusterId(a);
      const cb = this._getClusterId(b);
      if (ca == null || cb == null || ca === cb) continue;

      const wa = this._num(a.weight);
      const wb = this._num(b.weight);
      if (Math.max(wa, wb) < this.thresholds.highNodeWeight) continue;

      const evidence = `edge w=${w.toFixed(2)} between c${ca}(${a.id}) and c${cb}(${b.id}): ${this._snippet(a.concept)} ⇄ ${this._snippet(b.concept)}`;
      out.push({
        type: 'connection',
        subject: 'Weak cross-domain link detected',
        evidence,
        implication: 'This may be a useful bridge; a short synthesis note could connect two active areas and reduce context-switching cost.',
        routing: this._looksJerry(a.concept) || this._looksJerry(b.concept) ? 'newsletter' : 'morning-briefing',
        priority: 'medium'
      });

      if (out.length >= this.maxPerType) break;
    }

    return this._take(out, this.maxPerType);
  }

  async scanEmotional() {
    // Heuristic: nodes containing affective language + recent access.
    const { nodes } = this._getGraph();
    const now = Date.now();
    const recentMs = 3 * 24 * 60 * 60 * 1000;

    const hits = [];
    for (const node of nodes.values()) {
      const text = String(node.concept || '');
      if (!text) continue;
      if (!this._looksEmotional(text)) continue;

      const t = this._time(node.accessed || node.lastActivated || node.updatedAt || node.created) || 0;
      if (t && (now - t) > recentMs) continue;

      hits.push(node);
    }

    hits.sort((a, b) => this._num(b.weight) - this._num(a.weight));

    return hits.slice(0, this.maxPerType).map(n => ({
      type: 'emotional',
      subject: `Emotional/personal signal: ${this._snippet(n.concept)}`,
      evidence: `node=${n.id} weight=${this._num(n.weight).toFixed(2)} lastAccess=${this._iso(n.accessed || n.lastActivated || n.updatedAt || n.created)}`,
      implication: 'This looks like a recurring personal signal; worth a quick check-in or reframing before it drags focus.',
      routing: 'bridge-chat',
      priority: 'medium'
    }));
  }

  // ---- Helpers ----

  _getGraph() {
    const nodes = this.memory?.nodes;
    if (!nodes || typeof nodes.values !== 'function') {
      return { nodes: new Map(), edges: [] };
    }

    // Edges are stored as Map in NetworkMemory, but allow array fallback.
    const edgeMap = this.memory?.edges;
    const edges = [];
    if (edgeMap && typeof edgeMap.values === 'function') {
      for (const e of edgeMap.values()) {
        if (!e) continue;
        // Normalize shape.
        edges.push({
          source: e.source ?? e.nodeA ?? e.a,
          target: e.target ?? e.nodeB ?? e.b,
          weight: e.weight
        });
      }
    } else if (Array.isArray(edgeMap)) {
      for (const e of edgeMap) edges.push(e);
    }

    return { nodes, edges };
  }

  _clusterIndex(nodes) {
    const clusters = new Map(); // clusterId -> nodeIds[]
    for (const node of nodes.values()) {
      const clusterId = this._getClusterId(node);
      if (clusterId == null) continue;
      if (!clusters.has(clusterId)) clusters.set(clusterId, []);
      clusters.get(clusterId).push(node.id);
    }
    return clusters;
  }

  _getClusterId(node) {
    // Support node.cluster, node.clusterId, or metadata.cluster.
    return node?.cluster ?? node?.clusterId ?? node?.metadata?.cluster ?? null;
  }

  _take(arr, n) {
    return Array.isArray(arr) ? arr.slice(0, n) : [];
  }

  _warn(msg, err) {
    this.logger?.warn?.(`[NoticePass] ${msg}`, { error: err?.message || String(err) });
  }

  _num(x) {
    return (typeof x === 'number' && Number.isFinite(x)) ? x : 0;
  }

  _time(x) {
    if (!x) return null;
    if (typeof x === 'number') return x;
    const d = (x instanceof Date) ? x : new Date(x);
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }

  _iso(x) {
    const t = this._time(x);
    if (!t) return 'unknown';
    return new Date(t).toISOString();
  }

  _snippet(text, max = 80) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '—';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  _extractDate(text) {
    // Look for ISO-like dates first: YYYY-MM-DD
    const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) {
      const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
      if (Number.isFinite(d.getTime())) return d;
    }

    // US format: MM/DD/YYYY
    const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
    if (us) {
      const mm = String(us[1]).padStart(2, '0');
      const dd = String(us[2]).padStart(2, '0');
      const d = new Date(`${us[3]}-${mm}-${dd}T00:00:00Z`);
      if (Number.isFinite(d.getTime())) return d;
    }

    // Relative markers w/out date are too ambiguous; skip.
    return null;
  }

  _looksJerry(text) {
    const t = String(text || '').toLowerCase();
    return t.includes('jerry') || t.includes('garcia') || t.includes('grateful dead') || t.includes('deadhead');
  }

  _looksProject(text) {
    const t = String(text || '').toLowerCase();
    return t.includes('cosmo') || t.includes('engine') || t.includes('agent') || t.includes('orchestrator') || t.includes('mission');
  }

  _looksEmotional(text) {
    const t = String(text || '').toLowerCase();
    const words = ['anxious', 'anxiety', 'stressed', 'stress', 'frustrated', 'angry', 'sad', 'lonely', 'excited', 'overwhelmed', 'burned out', 'burnt out', 'tired', 'panic'];
    return words.some(w => t.includes(w));
  }

  _routeByTopic(text, { type }) {
    // Routing rules from brief.
    const lower = String(text || '').toLowerCase();

    if (type === 'gap') {
      if (this._looksJerry(lower)) return { routing: 'newsletter', priority: 'medium' };
      if (this._looksProject(lower)) return { routing: 'heartbeat', priority: 'medium' };
      return { routing: 'bridge-chat', priority: 'low' };
    }

    if (type === 'stale') {
      if (this._looksProject(lower)) return { routing: 'heartbeat', priority: 'low' };
      return { routing: 'bridge-chat', priority: 'low' };
    }

    // Default for other scans.
    return { routing: 'bridge-chat', priority: 'low' };
  }
}

module.exports = { NoticePass };
