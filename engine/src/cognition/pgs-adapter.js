/**
 * PGS Adapter — wraps cosmo23/pgs-engine for Home23 autonomous cognition
 *
 * Phase 3 of the thinking-machine-cycle rebuild. See
 * docs/superpowers/specs/2026-04-18-pgs-extraction.md.
 *
 * Responsibilities:
 *   - Wrap UnifiedClient as PGS's sweepProvider / synthesisProvider
 *   - Convert Home23 NetworkMemory graph shape → PGS-expected shape
 *   - Enforce token budget and 90s timeout
 *   - Availability detection (graceful unavailable if pgs-engine can't load)
 *   - NEVER throws — always returns { available, note, ... }
 */

'use strict';

const path = require('path');

const DEFAULT_BUDGET = {
  maxTokensIn: 10000,
  maxTokensOut: 3000,
  timeoutMs: 45000,         // tight — timeouts are death on big brains
  maxPartitions: 8,
  maxEdgeCandidates: 10,
};

const DEFAULT_GRAPH_CAP = 5000;  // above this, degrade to focused subgraph
const DEFAULT_FOCUS_HOPS = 2;

// Adaptive config picked per-call based on graph size + seed connectivity.
// Goal: PGS always completes fast OR skips cleanly. Never hangs.
function pickAdaptiveConfig(graphSize, seedEdgeCount) {
  // Very small graphs — full sweep is fine
  if (graphSize < 500) {
    return { maxSweepPartitions: 6, sweepMaxTokens: 1500, synthesisMaxTokens: 2500, hops: 2, hardGraphCap: 1000 };
  }
  // Medium graphs — moderate sweep
  if (graphSize < 5000) {
    return { maxSweepPartitions: 4, sweepMaxTokens: 1200, synthesisMaxTokens: 2000, hops: 2, hardGraphCap: 1500 };
  }
  // Large graphs — tight sweep, small focus
  if (graphSize < 15000) {
    return { maxSweepPartitions: 3, sweepMaxTokens: 1000, synthesisMaxTokens: 1500, hops: 1, hardGraphCap: 800 };
  }
  // Massive graphs (>15k) — bare-minimum sweep, tightest focus
  return { maxSweepPartitions: 2, sweepMaxTokens: 800, synthesisMaxTokens: 1200, hops: 1, hardGraphCap: 500 };
}

class PGSAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.unifiedClient - Home23 UnifiedClient instance
   * @param {object} opts.logger
   * @param {object} opts.memory - NetworkMemory instance
   * @param {object} [opts.config] - adapter config overrides
   */
  constructor(opts = {}) {
    if (!opts.unifiedClient) throw new Error('PGSAdapter requires unifiedClient');
    if (!opts.memory) throw new Error('PGSAdapter requires memory');
    this.unifiedClient = opts.unifiedClient;
    this.logger = opts.logger || console;
    this.memory = opts.memory;
    this.config = opts.config || {};

    this.available = false;
    this.PGSEngine = null;
    this.engine = null;
    this.stats = {
      callCount: 0,
      successCount: 0,
      timeoutCount: 0,
      budgetExceededCount: 0,
      unavailableCount: 0,
      totalDurationMs: 0,
      lastCallAt: null,
    };

    this._tryLoadPGS();
  }

  _tryLoadPGS() {
    try {
      // Vendored in this repo at cosmo23/pgs-engine. Use absolute resolution
      // so the module loads from its source dir regardless of engine CWD.
      const pgsModulePath = path.resolve(__dirname, '..', '..', '..', 'cosmo23', 'pgs-engine', 'src', 'index.js');
      const pgsModule = require(pgsModulePath);
      this.PGSEngine = pgsModule.PGSEngine;
      this.engine = new this.PGSEngine({
        sweepProvider: makeSweepProvider(this.unifiedClient),
        synthesisProvider: makeSynthesisProvider(this.unifiedClient),
        config: {
          minCommunitySize: 5,          // smaller communities OK for brain-sized graphs
          minNodesForPgs: 10,           // below this, not worth partitioning
          partitionRelevanceThreshold: 0.15,
          maxSweepPartitions: DEFAULT_BUDGET.maxPartitions,
          sweepMaxTokens: 2000,         // per-sweep cap (x ~3-5 sweeps per call)
          synthesisMaxTokens: 3000,     // synthesis cap
        },
      });
      this.available = true;
      this.logger.info?.('[pgs-adapter] available', { modulePath: pgsModulePath });
    } catch (err) {
      this.available = false;
      this.logger.warn?.('[pgs-adapter] unavailable', { reason: err?.message });
    }
  }

  /**
   * Run a PGS pass on behalf of the thinking-machine pipeline's Phase 3.
   *
   * @param {object} args
   * @param {string} args.thought - deep-dive output (becomes the query)
   * @param {string[]} [args.referencedNodes] - nodes the thought cited
   * @param {object} [args.temporalContext] - current temporal context (attached to metadata)
   * @param {object} [args.budget] - overrides DEFAULT_BUDGET
   * @returns {Promise<{available, perspectives, candidateEdges, connectionNotes, usage, note}>}
   */
  async connect(args = {}) {
    const budget = { ...DEFAULT_BUDGET, ...(args.budget || {}) };
    const started = Date.now();
    this.stats.callCount++;
    this.stats.lastCallAt = new Date().toISOString();

    const emptyResult = (note) => ({
      available: false,
      perspectives: [],
      candidateEdges: [],
      connectionNotes: [],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started, partitionsTouched: 0 },
      note,
    });

    if (!this.available || !this.engine) {
      this.stats.unavailableCount++;
      return emptyResult('unavailable');
    }

    // Pre-flight skip: isolated candidates have nothing for PGS to connect.
    // Running sweeps on them is pure waste — they'll just produce absence
    // reports that critique ignores. Save the LLM calls.
    const referenced = args.referencedNodes || [];
    const seedEdgeCount = this._countSeedEdges(referenced);
    if (referenced.length === 0 || seedEdgeCount < 2) {
      this.stats.skippedIsolatedCount = (this.stats.skippedIsolatedCount || 0) + 1;
      return emptyResult('skipped_isolated');
    }

    // Adaptive config sized to the current brain. Keeps small brains fast
    // and stops big brains from timing out mid-sweep.
    const graphSize = this.memory.nodes?.size || 0;
    const adaptive = pickAdaptiveConfig(graphSize, seedEdgeCount);

    // Convert graph using adaptive cap + hops
    let graph;
    try {
      graph = toPgsGraph(this.memory, referenced, {
        cap: adaptive.hardGraphCap,
        hops: adaptive.hops,
      });
    } catch (err) {
      this.logger.warn?.('[pgs-adapter] graph conversion failed', { error: err?.message });
      return emptyResult('no_graph');
    }

    if (!graph.nodes.length) {
      return emptyResult('no_graph');
    }

    // Apply adaptive config to the engine before calling. Adapter is
    // single-threaded per agent, so mutating .config is safe.
    const prevCfg = { ...this.engine.config };
    this.engine.config.maxSweepPartitions = adaptive.maxSweepPartitions;
    this.engine.config.sweepMaxTokens = adaptive.sweepMaxTokens;
    this.engine.config.synthesisMaxTokens = adaptive.synthesisMaxTokens;

    this.logger.info?.('[pgs-adapter] starting', {
      graphSize,
      seedEdgeCount,
      scopedNodes: graph.nodes.length,
      scopedEdges: graph.edges.length,
      maxSweepPartitions: adaptive.maxSweepPartitions,
      sweepMaxTokens: adaptive.sweepMaxTokens,
      timeoutMs: budget.timeoutMs,
    });

    // Build query from the thought. PGS takes natural-language queries.
    const query = this._buildQuery(args.thought, args.temporalContext);

    // Execute with timeout race
    try {
      const result = await Promise.race([
        this.engine.execute(query, graph, { mode: 'full' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('pgs_timeout')), budget.timeoutMs)),
      ]);

      // Extract candidate edges + perspectives + notes from the synthesized answer.
      // PGS returns a string answer; we parse it heuristically for downstream use.
      const extracted = extractConnections(result?.answer || '', graph, budget);

      this.stats.successCount++;
      this.stats.totalDurationMs += Date.now() - started;

      return {
        available: true,
        answer: result?.answer || '',
        perspectives: extracted.perspectives,
        candidateEdges: extracted.candidateEdges.slice(0, budget.maxEdgeCandidates),
        connectionNotes: extracted.connectionNotes,
        usage: {
          inputTokens: 0,              // PGS doesn't surface token usage directly; leave 0 for now
          outputTokens: 0,
          durationMs: Date.now() - started,
          partitionsTouched: result?.metadata?.pgs?.sweptPartitions || 0,
        },
        metadata: result?.metadata,
        note: null,
      };
    } catch (err) {
      if (err?.message === 'pgs_timeout') {
        this.stats.timeoutCount++;
        this.logger.warn?.('[pgs-adapter] timeout', { timeoutMs: budget.timeoutMs });
        return emptyResult('timeout');
      }
      this.logger.warn?.('[pgs-adapter] execute failed', { error: err?.message });
      return emptyResult('error');
    }
  }

  getStats() {
    return {
      ...this.stats,
      available: this.available,
      avgDurationMs: this.stats.successCount > 0
        ? Math.round(this.stats.totalDurationMs / this.stats.successCount)
        : null,
    };
  }

  /**
   * Count how many edges touch any of the seed nodes. Used to pre-flight
   * skip PGS on isolated candidates — if seeds have <2 edges between them
   * and the rest of the graph, PGS has no cross-partition signal to find.
   */
  _countSeedEdges(seedIds) {
    if (!Array.isArray(seedIds) || seedIds.length === 0) return 0;
    if (!this.memory?.edges) return 0;
    const seeds = new Set(seedIds.map(String));
    let count = 0;
    for (const edgeKey of this.memory.edges.keys()) {
      const [a, b] = edgeKey.split('->');
      if (seeds.has(a) || seeds.has(b)) {
        count++;
        if (count >= 10) return count;  // early-out — we only need to know if ≥ 2
      }
    }
    return count;
  }

  _buildQuery(thought, temporalContext) {
    // PGS takes a natural-language query. We frame the deep-dive output as
    // a mining prompt: "what perspectives / connections / absences surround
    // this thought, given the current moment."
    const temporal = temporalContext?.jtrTime
      ? ` [context: ${temporalContext.jtrTime.phase} ${temporalContext.jtrTime.dayType}, rhythms: ${(temporalContext.jtrTime.activeRhythms || []).join(', ') || 'none'}]`
      : '';
    return `${thought}\n\nGiven this thought${temporal}, what connections across the graph are worth surfacing? What's absent that should be present? What perspectives cut across partitions?`;
  }
}

// ─── Graph converter ─────────────────────────────────────────────────────

/**
 * Convert Home23 NetworkMemory graph → PGS-expected shape.
 * Full graph if under cap, otherwise focused N-hop subgraph around focusNodes.
 *
 * @param {NetworkMemory} memory
 * @param {string[]} focusNodes
 * @param {{cap: number, hops: number}} opts
 * @returns {{nodes: Array, edges: Array}}
 */
function toPgsGraph(memory, focusNodes, opts = {}) {
  const cap = opts.cap || DEFAULT_GRAPH_CAP;
  const hops = opts.hops || DEFAULT_FOCUS_HOPS;

  const totalNodes = memory.nodes?.size || 0;
  if (totalNodes === 0) return { nodes: [], edges: [] };

  let allowedNodeIds;
  if (totalNodes <= cap) {
    // Send everything
    allowedNodeIds = new Set(memory.nodes.keys());
  } else if (focusNodes && focusNodes.length > 0) {
    // Focused subgraph: N-hop traversal from focus nodes
    allowedNodeIds = traverseHops(memory, focusNodes, hops, cap);
  } else {
    // No focus — sample most-connected nodes up to cap
    allowedNodeIds = sampleByDegree(memory, cap);
  }

  const nodes = [];
  for (const [id, node] of memory.nodes.entries()) {
    if (!allowedNodeIds.has(id)) continue;
    nodes.push({
      id,
      concept: typeof node.concept === 'string' ? node.concept : String(node.concept || ''),
      embedding: Array.isArray(node.embedding) ? node.embedding : undefined,
      tag: node.tag || undefined,
    });
  }

  const edges = [];
  for (const [edgeKey, edge] of memory.edges.entries()) {
    const [src, tgt] = edgeKey.split('->');
    if (!allowedNodeIds.has(src) || !allowedNodeIds.has(tgt)) continue;
    edges.push({
      source: src,
      target: tgt,
      weight: typeof edge.weight === 'number' ? edge.weight : 0.5,
    });
  }

  return { nodes, edges };
}

function traverseHops(memory, seedIds, hops, cap) {
  const visited = new Set(seedIds.filter(id => memory.nodes.has(id)));
  let frontier = new Set(visited);
  for (let h = 0; h < hops; h++) {
    const next = new Set();
    for (const edgeKey of memory.edges.keys()) {
      const [src, tgt] = edgeKey.split('->');
      if (frontier.has(src) && !visited.has(tgt)) next.add(tgt);
      if (frontier.has(tgt) && !visited.has(src)) next.add(src);
    }
    for (const id of next) {
      if (visited.size >= cap) break;
      visited.add(id);
    }
    if (visited.size >= cap || next.size === 0) break;
    frontier = next;
  }
  return visited;
}

function sampleByDegree(memory, cap) {
  const degrees = new Map();
  for (const edgeKey of memory.edges.keys()) {
    const [a, b] = edgeKey.split('->');
    degrees.set(a, (degrees.get(a) || 0) + 1);
    degrees.set(b, (degrees.get(b) || 0) + 1);
  }
  const sorted = Array.from(memory.nodes.keys()).sort((a, b) =>
    (degrees.get(b) || 0) - (degrees.get(a) || 0));
  return new Set(sorted.slice(0, cap));
}

// ─── Provider wrappers ────────────────────────────────────────────────────

/**
 * PGS's sweepProvider contract: generate({instructions, input, maxTokens, reasoningEffort}) → {content}.
 * UnifiedClient already normalizes to {content, ...}; we just need to translate
 * the parameter shape.
 */
function makeSweepProvider(unifiedClient) {
  return {
    async generate(opts = {}) {
      const messages = [];
      if (opts.input) {
        messages.push({ role: 'user', content: String(opts.input) });
      }
      const response = await unifiedClient.generate({
        component: 'pgsSweep',
        purpose: 'partition',
        instructions: opts.instructions || '',
        messages,
        maxTokens: opts.maxTokens || 2000,
        temperature: 0.3,
      });
      return {
        content: response?.content || '',
        message: { content: response?.content || '' },  // PGS occasionally reads .message.content
      };
    },
  };
}

function makeSynthesisProvider(unifiedClient) {
  return {
    async generate(opts = {}) {
      const messages = [];
      if (opts.input) {
        messages.push({ role: 'user', content: String(opts.input) });
      }
      const response = await unifiedClient.generate({
        component: 'pgsSynthesis',
        purpose: 'synthesize',
        instructions: opts.instructions || '',
        messages,
        maxTokens: opts.maxTokens || 3000,
        temperature: 0.4,
      });
      return {
        content: response?.content || '',
        message: { content: response?.content || '' },
      };
    },
  };
}

// ─── Connection extraction ────────────────────────────────────────────────

/**
 * Heuristic extraction from PGS's synthesized answer text.
 * PGS returns a free-form markdown synthesis; we pull out node-id citations,
 * "connects X to Y" patterns, and partition/perspective summaries.
 *
 * Not a deep parser — first pass, will evolve as we see real PGS output shapes.
 */
function extractConnections(answer, graph, budget) {
  const perspectives = [];
  const candidateEdges = [];
  const connectionNotes = [];

  if (!answer || typeof answer !== 'string') {
    return { perspectives, candidateEdges, connectionNotes };
  }

  // Parse node-id citations of the form "Node 12345" or "node 12345"
  const nodeIdRegex = /\bNode[s]?\s+(\w+)/gi;
  const validNodeIds = new Set(graph.nodes.map(n => String(n.id)));
  const citedNodes = new Set();
  let m;
  while ((m = nodeIdRegex.exec(answer)) !== null) {
    if (validNodeIds.has(m[1])) citedNodes.add(m[1]);
  }

  // Connection-note regex: sentences explicitly linking two node IDs.
  const pairRegex = /Node[s]?\s+(\w+)[^.]*?(Node[s]?\s+(\w+))/gi;
  while ((m = pairRegex.exec(answer)) !== null) {
    const a = m[1], b = m[3];
    if (validNodeIds.has(a) && validNodeIds.has(b) && a !== b) {
      const sentenceStart = answer.lastIndexOf('.', m.index) + 1;
      const sentenceEnd = answer.indexOf('.', m.index);
      const text = answer.slice(sentenceStart, sentenceEnd > 0 ? sentenceEnd : m.index + 200).trim();
      candidateEdges.push({ from: a, to: b, rationale: text.slice(0, 200) });
      connectionNotes.push({ text: text.slice(0, 300), nodeIds: [a, b] });
      if (candidateEdges.length >= budget.maxEdgeCandidates * 2) break;
    }
  }

  // Perspectives: each "## Heading" block in the answer is a perspective.
  const headingRegex = /^##\s+(.+)$/gm;
  while ((m = headingRegex.exec(answer)) !== null) {
    perspectives.push({
      angle: m[1].trim(),
      searchResult: Array.from(citedNodes).slice(0, 20),
    });
  }

  return { perspectives, candidateEdges, connectionNotes };
}

module.exports = {
  PGSAdapter,
  toPgsGraph,
  makeSweepProvider,
  makeSynthesisProvider,
  extractConnections,
  DEFAULT_BUDGET,
};
