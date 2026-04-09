/**
 * PGS Engine — Partitioned Graph Synthesis
 *
 * Coverage-optimized query architecture for large knowledge graphs.
 * Finds what standard RAG misses, reports what's absent, and discovers
 * cross-domain connections.
 *
 * Four phases:
 *   Phase 0: Partition — Community detection → clusters with metadata (cached)
 *   Phase 1: Route     — Rank partitions by cosine similarity to query
 *   Phase 2: Sweep     — Parallel LLM passes per partition (full fidelity)
 *   Phase 3: Synthesize — Single pass over all sweep outputs (cross-domain)
 *
 * @example
 * const { PGSEngine } = require('pgs-engine');
 * const engine = new PGSEngine({ sweepProvider, synthesisProvider });
 * const result = await engine.execute('What are the key findings?', graph);
 */

'use strict';

const { PGS_DEFAULTS } = require('./defaults');
const { runLouvain } = require('./louvain');
const { enrichPartitions } = require('./partitioner');
const { routeQuery, cosineSimilarity } = require('./router');
const { sweepPartitions, sweepPartition: sweepOne } = require('./sweeper');
const { synthesize: runSynthesis } = require('./synthesizer');
const { SessionManager, MemoryStorage } = require('./session');

class PGSEngine {
  /**
   * Create a PGS engine instance.
   *
   * @param {object} options
   * @param {object} options.sweepProvider - LLM provider for partition sweeps
   * @param {object} options.synthesisProvider - LLM provider for final synthesis
   * @param {object} [options.embeddingProvider] - Embedding provider for query routing
   * @param {object} [options.storage] - Storage provider for sessions/cache
   * @param {object} [options.config] - Override PGS_DEFAULTS
   * @param {Function} [options.onEvent] - Global event listener
   */
  constructor(options = {}) {
    if (!options.sweepProvider) {
      throw new Error('PGSEngine requires a sweepProvider. Provide an object with a generate() method.');
    }
    if (!options.synthesisProvider) {
      throw new Error('PGSEngine requires a synthesisProvider. Provide an object with a generate() method.');
    }

    this.sweepProvider = options.sweepProvider;
    this.synthesisProvider = options.synthesisProvider;
    this.embeddingProvider = options.embeddingProvider || null;
    this.config = { ...PGS_DEFAULTS, ...(options.config || {}) };
    this.globalOnEvent = options.onEvent || null;
    this.sessions = new SessionManager(options.storage);

    // Partition cache (in-memory, keyed by graph hash)
    this._partitionCache = new Map();
  }

  /**
   * Compute a content-based hash for a graph (for partition cache keying).
   *
   * @param {{nodes: Array, edges: Array}} graph
   * @returns {string}
   */
  static computeGraphHash(graph) {
    const nodeCount = graph.nodes.length;
    const edgeCount = graph.edges.length;
    let idSum = 0;
    for (const node of graph.nodes) {
      const id = typeof node.id === 'number' ? node.id : hashString(String(node.id));
      idSum = (idSum + id) | 0;
    }
    return `${nodeCount}:${edgeCount}:${idSum}`;
  }

  // ─── Full Pipeline ──────────────────────────────────────────────────

  /**
   * Execute the full PGS pipeline: partition → route → sweep → synthesize.
   *
   * @param {string} query - The search query
   * @param {{nodes: Array, edges: Array}} graph - The knowledge graph
   * @param {object} [options]
   * @param {string} [options.mode='full'] - 'full', 'continue', or 'targeted'
   * @param {string} [options.sessionId='default'] - Session ID for resume tracking
   * @param {boolean} [options.fullSweep=false] - Bypass routing, sweep all partitions
   * @param {number} [options.sweepFraction] - Fraction of routed partitions to sweep (0.1-1.0)
   * @param {Function} [options.onEvent] - Per-query event listener
   * @returns {Promise<{answer: string, metadata: object}>}
   */
  async execute(query, graph, options = {}) {
    const {
      mode = 'full',
      sessionId = 'default',
      fullSweep = false,
      sweepFraction,
      onEvent
    } = options;

    const config = { ...this.config };
    if (sweepFraction !== undefined) {
      config.sweepFraction = sweepFraction;
    }

    const startTime = Date.now();
    const emit = (event) => {
      if (onEvent) onEvent(event);
      if (this.globalOnEvent) this.globalOnEvent(event);
    };

    const nodes = graph.nodes || [];
    const edges = graph.edges || [];

    // Guard: too small for PGS
    if (config.minNodesForPgs > 0 && nodes.length < config.minNodesForPgs) {
      throw new Error(`Graph has ${nodes.length} nodes, minimum for PGS is ${config.minNodesForPgs}.`);
    }

    emit({ type: 'partitioning', nodeCount: nodes.length, edgeCount: edges.length });

    // Phase 0: Partition (cached)
    const partitions = await this._getOrCreatePartitions(graph, config);
    emit({ type: 'partitioning', partitionCount: partitions.length });

    // Phase 1: Route query to relevant partitions
    emit({ type: 'routing', message: 'Routing query to relevant partitions...' });
    let queryEmbedding = null;
    if (this.embeddingProvider) {
      try {
        queryEmbedding = await this.embeddingProvider.embed(query);
      } catch {
        // Embedding failed — routing will degrade to all partitions
      }
    }
    const allRoutedPartitions = routeQuery(query, queryEmbedding, partitions, config);

    // Session tracking & mode handling
    const session = await this.sessions.load(sessionId);
    const searchedIds = new Set(session?.searchedPartitionIds || []);

    let partitionsToSweep;
    switch (mode) {
      case 'continue': {
        partitionsToSweep = partitions.filter(p => !searchedIds.has(p.id));
        if (partitionsToSweep.length === 0) {
          partitionsToSweep = partitions;
        }
        break;
      }
      case 'targeted': {
        const remainingPartitions = partitions.filter(p => !searchedIds.has(p.id));
        if (remainingPartitions.length === 0) {
          partitionsToSweep = partitions;
        } else {
          partitionsToSweep = routeQuery(query, queryEmbedding, remainingPartitions, config);
          if (partitionsToSweep.length === 0) {
            partitionsToSweep = remainingPartitions;
          }
        }
        break;
      }
      default: { // 'full'
        if (fullSweep) {
          partitionsToSweep = partitions;
        } else {
          const fraction = config.sweepFraction || null;
          let limit;
          if (fraction && fraction > 0 && fraction <= 1) {
            limit = Math.max(1, Math.ceil(allRoutedPartitions.length * fraction));
          } else {
            limit = config.maxSweepPartitions;
          }
          partitionsToSweep = allRoutedPartitions.slice(0, limit);
        }
      }
    }

    emit({
      type: 'routing',
      selectedCount: partitionsToSweep.length,
      totalCount: partitions.length,
      partitions: partitionsToSweep.map(p => ({
        id: p.id,
        summary: (p.summary || `Partition ${p.id}`).substring(0, 60),
        nodeCount: p.nodeCount,
        similarity: p.similarity ? p.similarity.toFixed(2) : null
      }))
    });

    emit({
      type: 'session',
      mode,
      sessionId,
      searched: searchedIds.size,
      remaining: partitions.length - searchedIds.size,
      total: partitions.length,
      sweeping: partitionsToSweep.length
    });

    // Phase 2: Sweep selected partitions
    emit({ type: 'sweeping', message: `Sweeping ${partitionsToSweep.length} partitions...` });

    const nodeMap = new Map();
    for (const node of nodes) {
      nodeMap.set(String(node.id), node);
    }

    const sweepResults = await sweepPartitions(
      query, partitionsToSweep, nodeMap, edges, partitions,
      this.sweepProvider, config, emit
    );

    const successfulSweeps = sweepResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    // Persist session
    const newSearchedIds = new Set([...searchedIds, ...partitionsToSweep.map(p => p.id)]);
    await this.sessions.save(sessionId, {
      query,
      mode,
      searchedPartitionIds: [...newSearchedIds],
      totalPartitions: partitions.length,
      timestamp: new Date().toISOString()
    });

    if (successfulSweeps.length === 0) {
      throw new Error('All sweeps failed. Check your LLM provider configuration.');
    }

    // Phase 3: Synthesize
    emit({ type: 'synthesizing', message: 'Synthesizing cross-domain insights...' });

    const synthesisResult = await runSynthesis(query, successfulSweeps, this.synthesisProvider, {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalPartitions: partitions.length,
      selectedPartitions: partitionsToSweep.length,
      onChunk: options.onChunk
    }, config);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    emit({ type: 'complete', elapsedMs: Date.now() - startTime });

    return {
      answer: synthesisResult,
      metadata: {
        mode: 'pgs',
        pgs: {
          totalNodes: nodes.length,
          totalEdges: edges.length,
          totalPartitions: partitions.length,
          sweptPartitions: partitionsToSweep.length,
          successfulSweeps: successfulSweeps.length,
          elapsed: `${elapsed}s`,
          sessionMode: mode,
          sessionId,
          searched: newSearchedIds.size,
          remaining: partitions.length - newSearchedIds.size
        },
        timestamp: new Date().toISOString()
      }
    };
  }

  // ─── Composable API ─────────────────────────────────────────────────

  /**
   * Partition a graph using Louvain community detection.
   * Returns enriched partitions with centroids, keywords, adjacency.
   *
   * @param {{nodes: Array, edges: Array}} graph
   * @returns {Array} Enriched partitions
   */
  partition(graph) {
    const communities = runLouvain(graph.nodes, graph.edges, {
      minCommunitySize: this.config.minCommunitySize,
      targetPartitionMax: this.config.targetPartitionMax
    });
    return enrichPartitions(communities, graph.nodes, graph.edges);
  }

  /**
   * Route a query to relevant partitions.
   *
   * @param {string} query - The search query
   * @param {{nodes: Array, edges: Array}} graph - The knowledge graph (for embedding dimension validation)
   * @param {Array} partitions - Enriched partitions
   * @returns {Promise<Array>} Ranked relevant partitions
   */
  async route(query, graph, partitions) {
    let queryEmbedding = null;
    if (this.embeddingProvider) {
      queryEmbedding = await this.embeddingProvider.embed(query);
    }
    return routeQuery(query, queryEmbedding, partitions, this.config);
  }

  /**
   * Sweep a single partition at full fidelity.
   *
   * @param {string} query - The search query
   * @param {object} partition - An enriched partition
   * @param {{nodes: Array, edges: Array}} graph - The full knowledge graph
   * @param {Array} allPartitions - All enriched partitions (for adjacent context)
   * @returns {Promise<object>} Sweep result
   */
  async sweepPartition(query, partition, graph, allPartitions) {
    const nodeMap = new Map();
    for (const node of graph.nodes) {
      nodeMap.set(String(node.id), node);
    }
    return sweepOne(query, partition, nodeMap, graph.edges, allPartitions, this.sweepProvider, this.config);
  }

  /**
   * Synthesize sweep results into a unified answer.
   *
   * @param {string} query - The original query
   * @param {Array} sweepResults - Successful sweep outputs
   * @param {object} [context] - Graph context {totalNodes, totalEdges, totalPartitions, selectedPartitions, onChunk}
   * @returns {Promise<string>} Synthesis result
   */
  async synthesize(query, sweepResults, context = {}) {
    return runSynthesis(query, sweepResults, this.synthesisProvider, context, this.config);
  }

  // ─── Layered Search ─────────────────────────────────────────────────

  /**
   * Layered search: standard retrieval → contextual PGS pass.
   *
   * The gold pattern. Runs a fast standard query first to establish what's
   * already known, then runs a full PGS pass with that context injected
   * into each sweep prompt, finding what standard retrieval missed.
   *
   * @param {string} query - The search query
   * @param {{nodes: Array, edges: Array}} graph
   * @param {object} [options]
   * @param {object} [options.standardProvider] - LLM for standard query (defaults to synthesisProvider)
   * @param {number} [options.topK=20] - Standard query retrieves top-K nodes
   * @param {Function} [options.onEvent] - Event listener
   * @param {string} [options.mode] - PGS mode
   * @param {string} [options.sessionId] - Session ID
   * @returns {Promise<{answer: string, standardAnswer: string, metadata: object}>}
   */
  async layeredSearch(query, graph, options = {}) {
    const {
      standardProvider,
      topK = 20,
      onEvent,
      ...pgsOptions
    } = options;

    const emit = (event) => {
      if (onEvent) onEvent(event);
      if (this.globalOnEvent) this.globalOnEvent(event);
    };

    const nodes = graph.nodes || [];
    const provider = standardProvider || this.synthesisProvider;

    // Step 1: Standard retrieval — top-K by cosine similarity
    emit({ type: 'layered_standard', message: `Standard query: retrieving top ${topK} nodes...` });

    let standardAnswer = '';
    let topNodes = [];

    if (this.embeddingProvider) {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      if (queryEmbedding) {
        // Score all nodes by cosine similarity
        const scored = nodes
          .filter(n => n.embedding && Array.isArray(n.embedding))
          .map(n => ({
            ...n,
            similarity: cosineSimilarity(queryEmbedding, n.embedding)
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, topK);

        topNodes = scored;

        // Build standard context
        let standardContext = scored
          .map(n => `[Node ${n.id}] (${n.tag || 'general'}, sim: ${n.similarity.toFixed(3)})\n${n.concept}`)
          .join('\n\n');

        const standardResult = await provider.generate({
          instructions: `Answer this query using the provided knowledge graph nodes. Be thorough and cite Node IDs.`,
          input: `${standardContext}\n\nQuery: ${query}`,
          maxTokens: 8000,
          reasoningEffort: 'medium'
        });

        standardAnswer = standardResult.content || standardResult.message?.content || '';
      }
    }

    emit({ type: 'layered_standard_complete', nodesUsed: topNodes.length, answerLength: standardAnswer.length });

    // Step 2: PGS pass with standard context injected
    // Store original sweep provider, wrap it with context injection
    const originalSweep = this.sweepProvider;
    this.sweepProvider = {
      generate: async (params) => {
        // Inject standard query results as prior context
        const contextPrefix = standardAnswer
          ? `\n--- PRIOR STANDARD QUERY RESULTS ---\nA standard top-${topK} retrieval query has already found the following. Your job is to find what it MISSED — deeper connections, contradictions, absences, and novelty that surface-level retrieval cannot capture.\n\nStandard query answer:\n${standardAnswer.substring(0, 3000)}\n--- END PRIOR CONTEXT ---\n\n`
          : '';

        return originalSweep.generate({
          ...params,
          input: contextPrefix + params.input
        });
      }
    };

    try {
      const pgsResult = await this.execute(query, graph, { ...pgsOptions, onEvent });

      return {
        answer: pgsResult.answer,
        standardAnswer,
        metadata: {
          ...pgsResult.metadata,
          layered: {
            standardNodesUsed: topNodes.length,
            standardAnswerLength: standardAnswer.length,
            pgsFoundAdditional: true
          }
        }
      };
    } finally {
      // Restore original sweep provider
      this.sweepProvider = originalSweep;
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Get or create partitions with caching.
   * @private
   */
  async _getOrCreatePartitions(graph, config) {
    const hash = PGSEngine.computeGraphHash(graph);

    // Check in-memory cache
    if (this._partitionCache.has(hash)) {
      return this._partitionCache.get(hash);
    }

    // Check storage cache
    try {
      const cached = await this.sessions.storage.read(`partitions:${hash}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.partitions) {
          this._partitionCache.set(hash, parsed.partitions);
          return parsed.partitions;
        }
      }
    } catch {
      // Cache miss — will recompute
    }

    // Compute partitions
    const partitions = this.partition(graph);

    // Cache
    this._partitionCache.set(hash, partitions);
    try {
      await this.sessions.storage.write(`partitions:${hash}`, JSON.stringify({
        version: 1,
        created: new Date().toISOString(),
        graphHash: hash,
        partitions
      }));
    } catch {
      // Cache write failure is non-fatal
    }

    return partitions;
  }
}

/**
 * Simple string hash for cache keying (djb2).
 * @private
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash | 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  PGSEngine,
  PGS_DEFAULTS,
  cosineSimilarity,
  runLouvain,
  MemoryStorage
};
