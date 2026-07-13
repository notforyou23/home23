/**
 * Partitioned Graph Synthesis (PGS) Engine
 *
 * Coverage-optimized query architecture for large knowledge graphs.
 * Decomposes a single large-graph query into multiple context-window-sized
 * passes (sweeps), then synthesizes across their outputs.
 *
 * Four phases:
 *   Phase 0: Route   - Rank partitions by cosine similarity to query (<1s)
 *   Phase 1: Partition - Community detection → clusters with metadata (one-time, cached)
 *   Phase 2: Sweep   - Parallel LLM passes per partition (Sonnet, full fidelity)
 *   Phase 3: Synthesize - Single pass over all sweep outputs (user-selected model)
 *
 * Modes:
 *   full     - Sweep all routed partitions (default)
 *   continue - Resume session, sweep only remaining (unsearched) routed partitions
 *   targeted - Re-route among unsearched partitions only (smart remaining)
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const {
  buildSynthesisCommitBlock,
  parseSynthesisCommitReceipt,
  resolveSynthesisCommitConfig,
  writeSynthesisCommitReceipt
} = require('./synthesis-commit');
const {
  assertProviderResultIdentity,
  requireCompleteProviderResult,
} = require('./provider-completion');
const { PGS_OPERATION_LIMITS } = require('./brain-operation-limits');

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── Configurable defaults (override via options.pgsConfig or env vars) ──────
const PGS_DEFAULTS = {
  maxConcurrentSweeps: parseInt(process.env.PGS_MAX_CONCURRENT_SWEEPS) || 5,
  minNodesForPgs: parseInt(process.env.PGS_MIN_NODES) || 0,
  directQueryMaxNodes: readIntEnv('PGS_DIRECT_QUERY_MAX_NODES', 200),
  skipSynthesisForSinglePartition: process.env.PGS_SKIP_SINGLE_PARTITION_SYNTHESIS !== '0',
  targetPartitionMin: parseInt(process.env.PGS_TARGET_PARTITION_MIN) || 200,
  targetPartitionMax: parseInt(process.env.PGS_TARGET_PARTITION_MAX) || 1800,
  minCommunitySize: parseInt(process.env.PGS_MIN_COMMUNITY_SIZE) || 30,
  maxSweepPartitions: parseInt(process.env.PGS_MAX_SWEEP_PARTITIONS) || 15,
  // No default minimum — if PGS is ON, route by relevance only, no trap to N partitions
  minSweepPartitions: parseInt(process.env.PGS_MIN_SWEEP_PARTITIONS) || 0,
  partitionRelevanceThreshold: parseFloat(process.env.PGS_RELEVANCE_THRESHOLD) || 0.25,
  sweepMaxTokens: parseInt(process.env.PGS_SWEEP_MAX_TOKENS) || 6000,
  synthesisMaxTokens: parseInt(process.env.PGS_SYNTHESIS_MAX_TOKENS) || 16000,
};

// Partition cache filename
const PARTITIONS_FILE = 'partitions.json';
const PARTITIONS_META_FILE = 'partitions.meta.json';
// Session state storage
const SESSION_DIR = 'pgs-sessions';
const DEFAULT_SESSION_ID = 'default';

class PGSEngine {
  constructor(queryEngine) {
    this.qe = queryEngine;
  }

  /**
   * Resolve a provider only from explicit input or an exact persisted role
   * assignment. Model-name inference is intentionally forbidden.
   */
  resolveExactProvider(model, explicitProvider, assignmentKey) {
    const selected = typeof explicitProvider === 'string' ? explicitProvider.trim() : '';
    if (selected) return selected;

    const assignment = this.qe?.runConfig?.modelAssignments?.[assignmentKey];
    const assignedProvider = typeof assignment?.provider === 'string'
      ? assignment.provider.trim()
      : '';
    const assignedModel = typeof assignment?.model === 'string'
      ? assignment.model.trim()
      : '';
    return assignedProvider && assignedModel === model ? assignedProvider : null;
  }

  /**
   * Resolve config: PGS_DEFAULTS ← options.pgsConfig overrides
   */
  resolveConfig(options = {}) {
    return { ...PGS_DEFAULTS, ...(options.pgsConfig || {}) };
  }

  // ─── Session persistence ──────────────────────────────────────────────

  async loadSession(sessionId = DEFAULT_SESSION_ID) {
    try {
      const sessionPath = path.join(this.qe.runtimeDir, SESSION_DIR, `${sessionId}.json`);
      return JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async saveSession(sessionId = DEFAULT_SESSION_ID, data) {
    try {
      const sessionsDir = path.join(this.qe.runtimeDir, SESSION_DIR);
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
      await fs.writeFile(sessionPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[PGS] Failed to save session:', err.message);
    }
  }

  /**
   * Main entry point - execute a PGS query
   */
  async execute(query, options = {}) {
    const {
      model: requestedModel = null,
      explicitProvider = null,
      pgsSweepProvider: sweepProviderOverride = null,
      mode: legacyMode = 'full',
      pgsMode,
      pgsSessionId = DEFAULT_SESSION_ID,
      pgsFullSweep = false,
      pgsSweepModel: sweepModelOverride = null,
      onChunk,
      enableSynthesis,
      includeCoordinatorInsights
    } = options;
    const synthesisAssignment = this.qe?.runConfig?.modelAssignments?.synthesis;
    const model = requestedModel
      || (typeof synthesisAssignment?.model === 'string'
        ? synthesisAssignment.model.trim()
        : '')
      || null;
    const mode = pgsMode || legacyMode || 'full';
    const synthesisProvider = this.resolveExactProvider(
      model,
      explicitProvider || options.provider || options.modelSelection?.provider,
      'synthesis'
    );
    const config = this.resolveConfig(options);
    const startTime = Date.now();
    const emit = (event) => { if (onChunk) onChunk(event); };

    // Load brain state
    emit({ type: 'progress', message: 'Loading brain state...' });
    const state = await this.qe.loadBrainState();
    const nodes = state.memory?.nodes || [];
    const edges = state.memory?.edges || [];

    // Send init event for UI to build progress panel
    emit({ type: 'pgs_init', totalNodes: nodes.length, totalEdges: edges.length });
    emit({ type: 'progress', message: `Brain loaded: ${nodes.length.toLocaleString()} nodes, ${edges.length.toLocaleString()} edges` });

    // PGS is a large-graph coverage tool. For small COSMO runs, the direct
    // Query path is both faster and more complete because it includes run
    // outputs/deliverables in addition to memory nodes.
    if (config.directQueryMaxNodes > 0 && nodes.length > 0 && nodes.length <= config.directQueryMaxNodes) {
      return await this.executeDirectQueryFallback(
        query,
        options,
        emit,
        `Brain has ${nodes.length} nodes (<= ${config.directQueryMaxNodes})`
      );
    }

    // Guard: too small for PGS - fall back to standard query (with enablePGS: false to prevent loop)
    if (config.minNodesForPgs > 0 && nodes.length < config.minNodesForPgs) {
      return await this.executeDirectQueryFallback(
        query,
        options,
        emit,
        `Brain has ${nodes.length} nodes (< ${config.minNodesForPgs})`
      );
    }

    // Phase 0: Partition (cached)
    emit({ type: 'pgs_phase', phase: 'partitioning', phaseIndex: 0, totalPhases: 4, message: 'Checking partition cache...' });
    const partitions = await this.getOrCreatePartitions(state, nodes, edges, onChunk, config);
    emit({ type: 'progress', message: `${partitions.length} partitions ready` });

    // Phase 1: Route query to relevant partitions
    emit({ type: 'pgs_phase', phase: 'routing', phaseIndex: 1, totalPhases: 4, message: 'Routing query to relevant partitions...' });
    const queryEmbedding = await this.qe.getEmbedding(query);
    const allRoutedPartitions = this.routeQuery(query, queryEmbedding, partitions, config);

    // ─── Session tracking & mode handling ────────────────────────────────
    const session = mode === 'full' ? null : await this.loadSession(pgsSessionId);
    // HOME23 PATCH — old zero-node PGS runs can leave session files with
    // impossible searched counts (for example 1155/1). Clamp session state to
    // the current partition set so progress math and continue/targeted modes
    // do not inherit stale partition IDs from a different graph.
    const validPartitionIds = new Set(partitions.map(p => String(p.id)));
    const searchedIds = new Set(
      (session?.searchedPartitionIds || []).filter(id => validPartitionIds.has(String(id)))
    );

    let partitionsToSweep;
    switch (mode) {
      case 'continue': {
        partitionsToSweep = partitions.filter(p => !searchedIds.has(p.id));
        if (partitionsToSweep.length === 0) {
          emit({ type: 'progress', message: 'All partitions already searched. Falling back to full sweep.' });
          partitionsToSweep = partitions;
        }
        break;
      }
      case 'targeted': {
        const remainingPartitions = partitions.filter(p => !searchedIds.has(p.id));
        if (remainingPartitions.length === 0) {
          emit({ type: 'progress', message: 'All partitions already searched. Falling back to full sweep.' });
          partitionsToSweep = partitions;
        } else {
          partitionsToSweep = this.routeQuery(query, queryEmbedding, remainingPartitions, config);
          if (partitionsToSweep.length === 0) {
            emit({ type: 'progress', message: 'No relevant remaining partitions. Falling back to full sweep.' });
            partitionsToSweep = remainingPartitions;
          }
        }
        break;
      }
      default: // 'full'
        if (pgsFullSweep) {
          partitionsToSweep = partitions;
        } else {
          // sweepFraction: fraction of routed partitions (0.1-1.0), overrides maxSweepPartitions
          const fraction = config.sweepFraction || null;
          let limit;
          if (fraction && fraction > 0 && fraction <= 1) {
            limit = Math.max(1, Math.ceil(allRoutedPartitions.length * fraction));
          } else {
            limit = config.maxSweepPartitions;
          }
          partitionsToSweep = allRoutedPartitions.slice(0, limit);
          emit({ type: 'progress', message: `Sweeping ${partitionsToSweep.length} of ${allRoutedPartitions.length} routed partitions (${fraction ? Math.round(fraction * 100) + '% coverage' : limit + ' max'})` });
        }
    }

    // Emit session state for UI
    emit({
      type: 'pgs_session',
      mode,
      sessionId: pgsSessionId,
      searched: searchedIds.size,
      remaining: partitions.length - searchedIds.size,
      total: partitions.length,
      sweeping: partitionsToSweep.length
    });

    // Send routed event with partition details for sweep tracker
    emit({
      type: 'pgs_routed',
      partitions: partitionsToSweep.map(p => ({
        id: p.id,
        summary: (p.summary || `Partition ${p.id}`).substring(0, 60),
        nodeCount: p.nodeCount,
        similarity: p.similarity ? p.similarity.toFixed(2) : null
      })),
      totalPartitions: partitions.length
    });
    emit({ type: 'progress', message: `Sweeping ${partitionsToSweep.length}/${partitions.length} partitions (mode: ${mode})` });

    // Phase 2: Sweep selected partitions in parallel
    emit({ type: 'pgs_phase', phase: 'sweeping', phaseIndex: 2, totalPhases: 4, message: `Sweeping ${partitionsToSweep.length} partitions...` });

    // Build node lookup for fast access
    const nodeMap = new Map();
    for (const node of nodes) {
      nodeMap.set(String(node.id), node);
    }

    // Sweep model: per-query override > catalog default > synthesis model
    const sweepModel = sweepModelOverride || this.qe.modelDefaults?.pgsSweepModel || model;
    const configuredSweepProvider = this.resolveExactProvider(
      sweepModel,
      null,
      'coordinator'
    );
    const sweepProvider = this.resolveExactProvider(
      sweepModel,
      sweepProviderOverride || configuredSweepProvider
        || (sweepModel === model ? synthesisProvider : null),
      'coordinator'
    );
    if (model !== sweepModel) {
      emit({ type: 'progress', message: `Sweeping with ${sweepModel} (synthesis will use ${model})` });
    }
    const sweepResults = await this.sweepPartitions(
      query,
      partitionsToSweep,
      nodeMap,
      edges,
      partitions,
      onChunk,
      sweepModel,
      config,
      sweepProvider
    );

    const successfulSweeps = sweepResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    const failedSweeps = partitionsToSweep.length - successfulSweeps.length;
    emit({ type: 'progress', message: `${successfulSweeps.length}/${partitionsToSweep.length} sweeps completed (${failedSweeps} failed or empty)` });

    // Persist session: merge newly swept partition IDs
    const newSearchedIds = new Set([...searchedIds, ...partitionsToSweep.map(p => p.id)]);
    if (mode !== 'full') {
      await this.saveSession(pgsSessionId, {
        query,
        mode,
        searchedPartitionIds: [...newSearchedIds],
        totalPartitions: partitions.length,
        timestamp: new Date().toISOString()
      });
    }

    const updatedSearched = mode === 'full' ? partitionsToSweep.length : newSearchedIds.size;
    const updatedRemaining = mode === 'full'
      ? Math.max(partitions.length - partitionsToSweep.length, 0)
      : partitions.length - newSearchedIds.size;

    // Emit updated session counts
    emit({
      type: 'pgs_session_updated',
      sessionId: pgsSessionId,
      searched: updatedSearched,
      remaining: updatedRemaining,
      total: partitions.length
    });

    if (successfulSweeps.length === 0) {
      emit({ type: 'progress', message: 'All sweeps failed, falling back to standard query' });
      return await this.qe.executeQuery(query, { ...options, enablePGS: false });
    }

    if (partitions.length <= 1 && config.skipSynthesisForSinglePartition) {
      emit({ type: 'progress', message: 'PGS: Single partition covered; skipping cross-partition synthesis.' });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      emit({ type: 'pgs_phase', phase: 'done', phaseIndex: 4, totalPhases: 4, message: `Complete in ${elapsed}s` });
      return {
        answer: successfulSweeps[0].sweepOutput,
        metadata: {
          model: sweepModel,
          mode: 'pgs',
          pgs: {
            totalNodes: nodes.length,
            totalEdges: edges.length,
            totalPartitions: partitions.length,
            sweptPartitions: partitionsToSweep.length,
            successfulSweeps: successfulSweeps.length,
            failedSweeps,
            sweepProvider,
            sweepModel,
            synthesisProvider: null,
            synthesisModel: null,
            synthesisSkipped: true,
            singlePartition: true,
            elapsed: `${elapsed}s`,
            sessionMode: mode,
            sessionId: pgsSessionId,
            searched: updatedSearched,
            remaining: updatedRemaining
          },
          sources: {
            memoryNodes: nodes.length,
            thoughts: 0,
            edges: edges.length,
            liveJournalNodes: 0
          },
          timestamp: new Date().toISOString()
        }
      };
    }

    // Phase 3: Synthesize
    emit({ type: 'pgs_phase', phase: 'synthesizing', phaseIndex: 3, totalPhases: 4, message: 'Synthesizing cross-domain insights...' });
    const synthesisResult = await this.synthesize(query, successfulSweeps, {
      model,
      onChunk,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalPartitions: partitions.length,
      selectedPartitions: partitionsToSweep.length,
      config,
      provider: synthesisProvider,
      synthesis: options.synthesis
    });
    const synthesisAnswer = typeof synthesisResult === 'string' ? synthesisResult : synthesisResult.answer;
    const synthesisCommit = typeof synthesisResult === 'string' ? null : synthesisResult.synthesisCommit;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    emit({ type: 'pgs_phase', phase: 'done', phaseIndex: 4, totalPhases: 4, message: `Complete in ${elapsed}s` });

    // Build result in standard format
    return {
      answer: synthesisAnswer,
      metadata: {
        model,
        mode: 'pgs',
        ...(synthesisCommit ? { synthesis_commit: synthesisCommit } : {}),
        pgs: {
          totalNodes: nodes.length,
          totalEdges: edges.length,
          totalPartitions: partitions.length,
          sweptPartitions: partitionsToSweep.length,
          successfulSweeps: successfulSweeps.length,
          failedSweeps,
          sweepProvider,
          sweepModel,
          synthesisProvider,
          synthesisModel: model,
          elapsed: `${elapsed}s`,
          sessionMode: mode,
          sessionId: pgsSessionId,
          searched: updatedSearched,
          remaining: updatedRemaining
        },
        sources: {
          memoryNodes: nodes.length,
          thoughts: 0,
          edges: edges.length,
          liveJournalNodes: 0
        },
        timestamp: new Date().toISOString()
      }
    };
  }

  async executeDirectQueryFallback(query, options, emit, reason) {
    emit({ type: 'progress', message: `PGS: ${reason}. Using direct query path for complete small-run context.` });
    return await this.qe.executeEnhancedQuery(query, { ...options, enablePGS: false });
  }

  // ─── Phase 1: Partition (cached) ─────────────────────────────────────

  /**
   * Get cached partitions or create new ones via Louvain community detection
   */
  async getOrCreatePartitions(state, nodes, edges, onChunk, config) {
    const partitionsPath = path.join(this.qe.runtimeDir, PARTITIONS_FILE);
    const metaPath = path.join(this.qe.runtimeDir, PARTITIONS_META_FILE);
    const brainHash = this.computeBrainHash(state, nodes, edges);
    const nodeCount = nodes.length;
    const edgeCount = edges.length;

    // Try loading cached partitions
    try {
      const stat = fsSync.existsSync(partitionsPath) ? fsSync.statSync(partitionsPath) : null;
      let meta = null;
      if (fsSync.existsSync(metaPath)) {
        meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      } else if (stat && stat.size > 50 * 1024 * 1024) {
        // HOME23 PATCH — old caches can be 100MB+ and stale. Without a small
        // metadata sidecar, parsing the giant JSON just to discover staleness
        // stalls the dashboard at "Checking partition cache..." for minutes.
        if (onChunk) onChunk({ type: 'progress', message: 'PGS: Legacy partition cache has no metadata, regenerating...' });
        throw new Error('legacy-large-cache-without-meta');
      }

      if (meta && !this.isPartitionCacheCompatible(meta, { brainHash, nodeCount, edgeCount })) {
        if (onChunk) onChunk({ type: 'progress', message: 'PGS: Partition cache stale, regenerating...' });
        throw new Error('stale-partition-cache');
      }

      const cached = JSON.parse(await fs.readFile(partitionsPath, 'utf8'));
      if (cached.partitions?.length > 0 && this.isPartitionCacheCompatible(cached, { brainHash, nodeCount, edgeCount })) {
        if (onChunk) onChunk({ type: 'progress', message: `PGS: Loaded ${cached.partitions.length} cached partitions` });
        return cached.partitions;
      }
      if (onChunk) onChunk({ type: 'progress', message: 'PGS: Partition cache stale, regenerating...' });
    } catch (err) {
      if (err.message !== 'stale-partition-cache' && err.message !== 'legacy-large-cache-without-meta') {
        if (onChunk) onChunk({ type: 'progress', message: 'PGS: No partition cache found, generating...' });
      }
    }

    if (onChunk) {
      await new Promise(resolve => setImmediate(resolve));
    }

    // Run Louvain community detection
    if (onChunk) onChunk({ type: 'progress', message: 'PGS: Running community detection (Louvain algorithm)...' });
    const communities = this.runLouvain(nodes, edges, config);

    if (onChunk) {
      await new Promise(resolve => setImmediate(resolve));
    }

    // Enrich partitions with metadata
    if (onChunk) onChunk({ type: 'progress', message: `PGS: Enriching ${communities.length} partitions with metadata...` });
    const partitions = await this.enrichPartitions(communities, nodes, edges, onChunk);

    // Cache
    const cacheData = {
      version: 2,
      created: new Date().toISOString(),
      brainHash,
      nodeCount,
      edgeCount,
      partitions
    };

    const metaData = {
      version: cacheData.version,
      created: cacheData.created,
      brainHash,
      nodeCount,
      edgeCount,
      partitionCount: partitions.length
    };

    try {
      await fs.writeFile(partitionsPath, JSON.stringify(cacheData), 'utf8');
      await fs.writeFile(metaPath, JSON.stringify(metaData, null, 2), 'utf8');
      if (onChunk) onChunk({ type: 'progress', message: `PGS: Cached ${partitions.length} partitions to disk` });
    } catch (err) {
      console.error('[PGS] Failed to cache partitions:', err.message);
    }

    return partitions;
  }

  isPartitionCacheCompatible(cacheInfo, current) {
    if (!cacheInfo) return false;
    if (cacheInfo.brainHash === current.brainHash) return true;

    const cachedNodes = Number(cacheInfo.nodeCount || 0);
    const cachedEdges = Number(cacheInfo.edgeCount || 0);
    if (!cachedNodes || !cachedEdges) return false;

    const nodeDrift = Math.abs(current.nodeCount - cachedNodes) / Math.max(current.nodeCount, cachedNodes, 1);
    const edgeDrift = Math.abs(current.edgeCount - cachedEdges) / Math.max(current.edgeCount, cachedEdges, 1);

    // Partition topology does not need to be regenerated for every handful of
    // newly ingested nodes. Reuse near-current caches to keep dashboard PGS
    // interactive instead of reparsing/regenerating on every engine cycle.
    return nodeDrift <= 0.02 && edgeDrift <= 0.02;
  }

  /**
   * Compute brain hash for cache validation
   */
  computeBrainHash(state, nodes, edges) {
    const nodeCount = nodes.length;
    const edgeCount = edges.length;
    const cycleCount = state.cycleCount || 0;
    const timestamp = state.timestamp || '';
    return `${nodeCount}:${edgeCount}:${cycleCount}:${timestamp}`;
  }

  /**
   * Louvain community detection algorithm (pure JS)
   * Returns array of { id, nodeIds }
   */
  runLouvain(nodes, edges, config) {
    const { minCommunitySize, targetPartitionMax } = config;

    // Build adjacency list with weights
    const adj = new Map(); // nodeId -> Map<neighborId, totalWeight>
    const nodeIds = nodes.map(n => String(n.id));
    const nodeIdSet = new Set(nodeIds);

    for (const nid of nodeIds) {
      adj.set(nid, new Map());
    }

    // Total graph weight (sum of all edge weights)
    let totalWeight = 0;
    for (const edge of edges) {
      const src = String(edge.source);
      const tgt = String(edge.target);
      if (!nodeIdSet.has(src) || !nodeIdSet.has(tgt)) continue;
      const w = edge.weight || 0.5;
      totalWeight += w;

      // Undirected: add both directions
      if (!adj.has(src)) adj.set(src, new Map());
      if (!adj.has(tgt)) adj.set(tgt, new Map());
      adj.get(src).set(tgt, (adj.get(src).get(tgt) || 0) + w);
      adj.get(tgt).set(src, (adj.get(tgt).get(src) || 0) + w);
    }

    if (totalWeight === 0) {
      // No edges: every node in one big community (or return single partition)
      return [{ id: 0, nodeIds }];
    }

    const m2 = 2 * totalWeight; // 2m in Louvain notation

    // Initialize: each node in its own community
    const community = new Map(); // nodeId -> communityId
    const communityNodes = new Map(); // communityId -> Set<nodeId>

    for (let i = 0; i < nodeIds.length; i++) {
      community.set(nodeIds[i], i);
      communityNodes.set(i, new Set([nodeIds[i]]));
    }

    // Precompute node strengths (sum of edge weights for each node)
    const strength = new Map();
    for (const nid of nodeIds) {
      let s = 0;
      const neighbors = adj.get(nid);
      if (neighbors) {
        for (const w of neighbors.values()) s += w;
      }
      strength.set(nid, s);
    }

    // Community total strength (sum of strengths of all nodes in community)
    const communityStrength = new Map();
    for (const [cid, members] of communityNodes) {
      let total = 0;
      for (const nid of members) total += strength.get(nid) || 0;
      communityStrength.set(cid, total);
    }

    // Iterative optimization
    const MAX_ITERATIONS = 20;
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let moved = false;

      // Shuffle nodes for better convergence
      const shuffled = [...nodeIds];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      for (const nid of shuffled) {
        const currentComm = community.get(nid);
        const neighbors = adj.get(nid);
        if (!neighbors || neighbors.size === 0) continue;

        const ki = strength.get(nid) || 0;

        // Compute weight to each neighbor community
        const commWeights = new Map(); // communityId -> sum of edge weights to that community
        for (const [neighbor, w] of neighbors) {
          const neighborComm = community.get(neighbor);
          commWeights.set(neighborComm, (commWeights.get(neighborComm) || 0) + w);
        }

        // Modularity gain for removing node from current community
        const wCurrent = commWeights.get(currentComm) || 0;
        const sigmaCurrent = communityStrength.get(currentComm) || 0;
        const removeGain = wCurrent - (ki * (sigmaCurrent - ki)) / m2;

        // Find best community to move to
        let bestComm = currentComm;
        let bestGain = 0;

        for (const [targetComm, wTarget] of commWeights) {
          if (targetComm === currentComm) continue;
          const sigmaTarget = communityStrength.get(targetComm) || 0;
          const gain = wTarget - (ki * sigmaTarget) / m2;
          const netGain = gain - removeGain;
          if (netGain > bestGain) {
            bestGain = netGain;
            bestComm = targetComm;
          }
        }

        // Move node if beneficial
        if (bestComm !== currentComm && bestGain > 1e-10) {
          // Remove from current
          communityNodes.get(currentComm).delete(nid);
          communityStrength.set(currentComm, (communityStrength.get(currentComm) || 0) - ki);

          // Clean up empty communities
          if (communityNodes.get(currentComm).size === 0) {
            communityNodes.delete(currentComm);
            communityStrength.delete(currentComm);
          }

          // Add to new
          community.set(nid, bestComm);
          if (!communityNodes.has(bestComm)) {
            communityNodes.set(bestComm, new Set());
          }
          communityNodes.get(bestComm).add(nid);
          communityStrength.set(bestComm, (communityStrength.get(bestComm) || 0) + ki);

          moved = true;
        }
      }

      if (!moved) break; // Converged
    }

    // Post-process: merge small communities into their most-connected neighbor
    this.mergeSmallCommunities(communityNodes, community, adj, minCommunitySize);

    // Post-process: split oversized communities
    this.splitLargeCommunities(communityNodes, community, adj, nodes, targetPartitionMax);

    // Convert to partition format
    const result = [];
    let partitionId = 0;
    for (const [, members] of communityNodes) {
      if (members.size === 0) continue;
      result.push({
        id: partitionId++,
        nodeIds: [...members]
      });
    }

    return this.coalesceSmallPartitions(result, nodes, {
      minSize: config.targetPartitionMin || 200,
      maxSize: config.targetPartitionMax || 1800
    });
  }

  coalesceSmallPartitions(partitions, nodes, options = {}) {
    const minSize = options.minSize || 200;
    const maxSize = options.maxSize || 1800;
    const nodeMap = new Map(nodes.map(node => [String(node.id), node]));
    const large = [];
    const smallByTag = new Map();

    for (const partition of partitions) {
      const size = partition.nodeIds?.length || 0;
      if (size >= minSize) {
        large.push(partition);
        continue;
      }

      const tag = this.getPartitionGroupKey(partition, nodeMap);
      if (!smallByTag.has(tag)) smallByTag.set(tag, []);
      smallByTag.get(tag).push(...(partition.nodeIds || []));
    }

    const combined = [...large.map(p => ({ nodeIds: [...p.nodeIds] }))];
    for (const [, nodeIds] of smallByTag) {
      for (let i = 0; i < nodeIds.length; i += maxSize) {
        combined.push({ nodeIds: nodeIds.slice(i, i + maxSize) });
      }
    }

    return combined
      .filter(p => p.nodeIds.length > 0)
      .map((p, id) => ({ id, nodeIds: p.nodeIds }));
  }

  getPartitionGroupKey(partition, nodeMap) {
    const counts = new Map();
    for (const nodeId of partition.nodeIds || []) {
      const node = nodeMap.get(String(nodeId));
      const rawTag = Array.isArray(node?.tag) ? node.tag[0] : node?.tag;
      const tag = rawTag ? String(rawTag).toLowerCase() : 'untagged';
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'untagged';
  }

  /**
   * Merge communities smaller than minSize into their most-connected neighbor
   */
  mergeSmallCommunities(communityNodes, community, adj, minSize) {
    let merged = true;
    while (merged) {
      merged = false;
      for (const [cid, members] of communityNodes) {
        if (members.size >= minSize || members.size === 0) continue;

        // Find most-connected neighboring community
        const neighborCommWeights = new Map();
        for (const nid of members) {
          const neighbors = adj.get(nid);
          if (!neighbors) continue;
          for (const [neighbor, w] of neighbors) {
            const nComm = community.get(neighbor);
            if (nComm !== cid) {
              neighborCommWeights.set(nComm, (neighborCommWeights.get(nComm) || 0) + w);
            }
          }
        }

        if (neighborCommWeights.size === 0) continue;

        // Find best target
        let bestTarget = null;
        let bestWeight = -1;
        for (const [targetComm, w] of neighborCommWeights) {
          if (w > bestWeight) {
            bestWeight = w;
            bestTarget = targetComm;
          }
        }

        if (bestTarget === null) continue;

        // Merge: move all nodes to target community
        for (const nid of members) {
          community.set(nid, bestTarget);
          communityNodes.get(bestTarget).add(nid);
        }
        members.clear();
        communityNodes.delete(cid);
        merged = true;
        break; // Restart after merge
      }
    }
  }

  /**
   * Split communities larger than maxSize using recursive bisection
   */
  splitLargeCommunities(communityNodes, community, adj, allNodes, maxSize) {
    const toSplit = [];
    for (const [cid, members] of communityNodes) {
      if (members.size > maxSize) toSplit.push(cid);
    }

    for (const cid of toSplit) {
      const members = [...communityNodes.get(cid)];
      if (members.length <= maxSize) continue;

      // Simple bisection: split into two halves based on internal connectivity
      // Assign first node to group A, then greedily assign each node to the group
      // it has more connections to, trying to keep sizes balanced
      const groupA = new Set();
      const groupB = new Set();

      // Seed: use the two nodes with the weakest connection between them
      groupA.add(members[0]);
      groupB.add(members[Math.floor(members.length / 2)]);

      for (let i = 1; i < members.length; i++) {
        const nid = members[i];
        if (groupA.has(nid) || groupB.has(nid)) continue;

        let wA = 0, wB = 0;
        const neighbors = adj.get(nid);
        if (neighbors) {
          for (const [neighbor, w] of neighbors) {
            if (groupA.has(neighbor)) wA += w;
            if (groupB.has(neighbor)) wB += w;
          }
        }

        // Balance factor: prefer the smaller group
        const balanceFactor = 0.1;
        const scoreA = wA - balanceFactor * groupA.size;
        const scoreB = wB - balanceFactor * groupB.size;

        if (scoreA >= scoreB) {
          groupA.add(nid);
        } else {
          groupB.add(nid);
        }
      }

      // Replace original community with group A, create new community for group B
      const existingKeys = [...communityNodes.keys()];
      const newCid = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 0;

      communityNodes.get(cid).clear();
      for (const nid of groupA) {
        communityNodes.get(cid).add(nid);
        community.set(nid, cid);
      }

      communityNodes.set(newCid, new Set());
      for (const nid of groupB) {
        communityNodes.get(newCid).add(nid);
        community.set(nid, newCid);
      }
    }
  }

  /**
   * Enrich partitions with metadata: centroid, keywords, summary, adjacency
   */
  async enrichPartitions(communities, nodes, edges, onChunk) {
    const nodeMap = new Map();
    for (const node of nodes) {
      nodeMap.set(String(node.id), node);
    }

    const partitions = [];

    for (const comm of communities) {
      // Compute centroid embedding
      const centroid = this.computeCentroid(comm.nodeIds, nodeMap);

      // Extract keywords via simple TF scoring
      const keywords = this.extractKeywords(comm.nodeIds, nodeMap, 50);

      // Find adjacent partitions
      const adjacentPartitions = this.findAdjacentPartitions(comm, communities, edges);

      // Generate summary from top nodes
      const summary = this.generateQuickSummary(comm.nodeIds, nodeMap, keywords);

      partitions.push({
        id: comm.id,
        nodeIds: comm.nodeIds,
        nodeCount: comm.nodeIds.length,
        summary,
        keywords: keywords.slice(0, 20),
        centroidEmbedding: centroid,
        adjacentPartitions
      });
    }

    return partitions;
  }

  /**
   * Compute centroid embedding (element-wise mean of node embeddings)
   */
  computeCentroid(nodeIds, nodeMap) {
    let count = 0;
    let centroid = null;

    for (const nid of nodeIds) {
      const node = nodeMap.get(nid);
      if (!node?.embedding || !Array.isArray(node.embedding)) continue;

      if (!centroid) {
        centroid = new Array(node.embedding.length).fill(0);
      }

      for (let i = 0; i < node.embedding.length; i++) {
        centroid[i] += node.embedding[i];
      }
      count++;
    }

    if (!centroid || count === 0) return null;

    for (let i = 0; i < centroid.length; i++) {
      centroid[i] /= count;
    }

    return centroid;
  }

  /**
   * Extract top keywords from partition nodes using term frequency
   */
  extractKeywords(nodeIds, nodeMap, topK = 50) {
    const termFreq = new Map();
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
      'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
      'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
      'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
      'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
      'just', 'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this',
      'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our',
      'you', 'your', 'he', 'she', 'his', 'her', 'what', 'which', 'who',
      'also', 'about', 'up', 'down', 'new', 'one', 'two', 'three', 'first'
    ]);

    for (const nid of nodeIds) {
      const node = nodeMap.get(nid);
      if (!node?.concept) continue;

      const words = node.concept.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

      const seen = new Set(); // Count each term once per node (document frequency)
      for (const word of words) {
        if (!seen.has(word)) {
          termFreq.set(word, (termFreq.get(word) || 0) + 1);
          seen.add(word);
        }
      }
    }

    // Sort by frequency, return top K
    return [...termFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([term]) => term);
  }

  /**
   * Find partitions adjacent to this one (connected by cross-partition edges)
   */
  findAdjacentPartitions(partition, allPartitions, edges) {
    const nodeIdSet = new Set(partition.nodeIds);
    const adjacentWeights = new Map(); // partitionId -> sharedEdgeCount

    // Build a reverse lookup: nodeId -> partitionId
    const nodeToPartition = new Map();
    for (const p of allPartitions) {
      for (const nid of p.nodeIds) {
        nodeToPartition.set(nid, p.id);
      }
    }

    for (const edge of edges) {
      const src = String(edge.source);
      const tgt = String(edge.target);

      if (nodeIdSet.has(src) && !nodeIdSet.has(tgt)) {
        const targetPartition = nodeToPartition.get(tgt);
        if (targetPartition !== undefined && targetPartition !== partition.id) {
          adjacentWeights.set(targetPartition, (adjacentWeights.get(targetPartition) || 0) + 1);
        }
      } else if (nodeIdSet.has(tgt) && !nodeIdSet.has(src)) {
        const targetPartition = nodeToPartition.get(src);
        if (targetPartition !== undefined && targetPartition !== partition.id) {
          adjacentWeights.set(targetPartition, (adjacentWeights.get(targetPartition) || 0) + 1);
        }
      }
    }

    return [...adjacentWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5) // Top 5 adjacent
      .map(([pid, count]) => ({ id: pid, sharedEdges: count }));
  }

  /**
   * Generate a quick summary from top nodes and keywords (no LLM call)
   */
  generateQuickSummary(nodeIds, nodeMap, keywords) {
    // Get top nodes by weight
    const nodesWithWeight = nodeIds
      .map(nid => nodeMap.get(nid))
      .filter(n => n && n.concept)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));

    const topNode = nodesWithWeight[0];
    const topKeywords = keywords.slice(0, 8).join(', ');

    if (topNode) {
      const snippet = topNode.concept.substring(0, 120).replace(/\n/g, ' ');
      return `${topKeywords}. Top finding: ${snippet}...`;
    }

    return topKeywords || `Partition with ${nodeIds.length} nodes`;
  }

  // ─── Phase 0: Route ──────────────────────────────────────────────────

  /**
   * Route query to relevant partitions using cosine similarity
   */
  routeQuery(query, queryEmbedding, partitions, config) {
    const { maxSweepPartitions, minSweepPartitions, partitionRelevanceThreshold } = config;

    if (!queryEmbedding) {
      // No embedding available, return all partitions (limited by max)
      return partitions.slice(0, maxSweepPartitions);
    }

    // Check if this is a broad/open-ended query
    const broadPatterns = [
      /what.*(surpris|miss|gap|absence|unknown)/i,
      /what.*don.*t.*know/i,
      /full.*sweep/i,
      /everything/i,
      /comprehensive.*overview/i,
      /all.*partition/i
    ];
    const isBroadQuery = broadPatterns.some(p => p.test(query));

    if (isBroadQuery) {
      // Full sweep for broad queries
      return partitions.slice(0, maxSweepPartitions);
    }

    // Rank by cosine similarity to partition centroid
    const ranked = partitions
      .map(p => ({
        ...p,
        similarity: p.centroidEmbedding
          ? this.qe.cosineSimilarity(queryEmbedding, p.centroidEmbedding)
          : 0
      }))
      .sort((a, b) => b.similarity - a.similarity);

    // Select: all above threshold, respecting min/max bounds
    let selected = ranked.filter(p => p.similarity >= partitionRelevanceThreshold);

    if (selected.length < maxSweepPartitions) {
      const selectedIds = new Set(selected.map(p => p.id));
      for (const partition of ranked) {
        if (selected.length >= maxSweepPartitions) break;
        if (!selectedIds.has(partition.id)) {
          selected.push(partition);
          selectedIds.add(partition.id);
        }
      }
    }

    // Only enforce minimum if configured (default 0 = no forced minimum)
    if (minSweepPartitions > 0 && selected.length < minSweepPartitions) {
      selected = ranked.slice(0, minSweepPartitions);
    }

    // HOME23 PATCH — PGS should never route to zero partitions when a graph is
    // present. Live Home23 brains can have partitions without centroid
    // embeddings, making every similarity 0 and causing "0/0 sweeps completed".
    if (selected.length === 0 && ranked.length > 0) {
      selected = ranked.slice(0, 1);
    }

    if (selected.length > maxSweepPartitions) {
      selected = selected.slice(0, maxSweepPartitions);
    }

    return selected;
  }

  // ─── Phase 2: Sweep ──────────────────────────────────────────────────

  /**
   * Sweep all selected partitions with concurrency control
   */
  async sweepPartitions(query, selectedPartitions, nodeMap, edges, allPartitions, onChunk, model, config, provider = null) {
    const { maxConcurrentSweeps } = config;
    const results = [];
    const batches = [];
    const total = selectedPartitions.length;
    const emit = (event) => { if (onChunk) onChunk(event); };

    // Build partition index map for structured events
    const partitionIndexMap = new Map();
    selectedPartitions.forEach((p, i) => partitionIndexMap.set(p.id, i));

    // Split into batches of maxConcurrentSweeps
    for (let i = 0; i < selectedPartitions.length; i += maxConcurrentSweeps) {
      batches.push(selectedPartitions.slice(i, i + maxConcurrentSweeps));
    }

    let completedCount = 0;

    for (const batch of batches) {
      const batchPromises = batch.map(async (partition) => {
        const idx = partitionIndexMap.get(partition.id);
        const summary = (partition.summary || `Partition ${partition.id}`).substring(0, 60);

        try {
          emit({
            type: 'pgs_sweep_progress',
            partitionIndex: idx,
            total,
            partitionId: partition.id,
            status: 'started',
            summary,
            nodeCount: partition.nodeCount,
            message: `Sweeping: ${summary} (${partition.nodeCount} nodes)`
          });

          const result = await this.sweepPartition(
            query,
            partition,
            nodeMap,
            edges,
            allPartitions,
            model,
            config,
            provider
          );
          completedCount++;

          emit({
            type: 'pgs_sweep_progress',
            partitionIndex: idx,
            total,
            partitionId: partition.id,
            status: result ? 'complete' : 'failed',
            summary,
            completed: completedCount,
            message: result
              ? `Complete (${completedCount}/${total}): ${summary}`
              : `Failed (${completedCount}/${total}): ${summary}`
          });

          return result;
        } catch (error) {
          console.error(`[PGS] Sweep failed for partition ${partition.id}:`, error.message);
          completedCount++;

          emit({
            type: 'pgs_sweep_progress',
            partitionIndex: idx,
            total,
            partitionId: partition.id,
            status: 'failed',
            summary,
            error: error.message,
            completed: completedCount,
            message: `Failed (${completedCount}/${total}): ${summary}`
          });

          return null;
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Sweep a single partition at full fidelity
   */
  async sweepPartition(query, partition, nodeMap, edges, allPartitions, model, config, provider = null) {
    const { sweepMaxTokens } = config;

    // Build full-fidelity context for this partition
    const partitionNodes = partition.nodeIds
      .map(nid => nodeMap.get(nid))
      .filter(n => n && n.concept);

    // Sort by weight for best information ordering
    partitionNodes.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    // Build node context at full fidelity (no tier compression!)
    let nodeContext = '';
    let tokenEstimate = 0;
    const MAX_CONTEXT_CHARS = 500000; // ~125K tokens, leaving room for prompt + response

    for (const node of partitionNodes) {
      const nodeText = `[Node ${node.id}] (${node.tag || 'general'}, weight: ${(node.weight || 0).toFixed(2)})\n${node.concept}\n\n`;
      if (tokenEstimate + nodeText.length > MAX_CONTEXT_CHARS) break;
      nodeContext += nodeText;
      tokenEstimate += nodeText.length;
    }

    // Build adjacent partition summaries for peripheral vision
    let adjacentContext = '';
    if (partition.adjacentPartitions?.length > 0) {
      adjacentContext = '\n--- ADJACENT PARTITIONS (for cross-domain awareness) ---\n';
      for (const adj of partition.adjacentPartitions) {
        const adjPartition = allPartitions.find(p => p.id === adj.id);
        if (adjPartition) {
          adjacentContext += `Partition P-${adj.id} (${adj.sharedEdges} shared edges): ${adjPartition.summary || 'No summary'}\n`;
          if (adjPartition.keywords?.length > 0) {
            adjacentContext += `  Keywords: ${adjPartition.keywords.slice(0, 10).join(', ')}\n`;
          }
        }
      }
    }

    const sweepPrompt = `You are analyzing ONE partition of a larger knowledge graph as part of Partitioned Graph Synthesis (PGS).
This partition contains ${partitionNodes.length} nodes. The full graph has many more partitions being analyzed in parallel.

Your job is to extract ALL information relevant to the query from THIS partition. Be thorough - the synthesis phase will combine your output with outputs from other partitions.

Respond with EXACTLY this structure:

## Domain State
A brief (2-3 sentence) summary of what this partition covers and its current research state relative to the query.

## Findings
List the key discoveries, quantitative results, and connections WITHIN this partition that are relevant to the query. For each finding, cite the Node ID(s) that support it.

## Outbound Flags
List specific, characterized connections you see to content that likely exists in OTHER partitions (see adjacent partition summaries below). Be specific: "Node X's discussion of [topic] has structural parallels to [adjacent partition topic]" -- not just "might relate."

## Absences
Explicitly state what was searched for and NOT found in this partition. "This partition contains no findings relevant to [aspect]" is valuable information for the synthesizer.`;

    const input = `${nodeContext}\n${adjacentContext}\n\nQuery: ${query}`;

    // Route to correct provider based on model
    const runtime = this.qe.resolveQueryRuntime(model, provider);

    const response = await runtime.client.generate({
      provider: runtime.providerId,
      model: runtime.effectiveModel,
      instructions: sweepPrompt,
      input,
      maxTokens: sweepMaxTokens,
      max_output_tokens: sweepMaxTokens,
      maxOutputTokens: Math.min(sweepMaxTokens, runtime.capabilities.maxOutputTokens),
      maxOutputBytes: PGS_OPERATION_LIMITS.maxSweepOutputBytes,
      reasoningEffort: 'medium'
    });

    const complete = requireCompleteProviderResult(response);
    assertProviderResultIdentity(complete, runtime.providerId, runtime.effectiveModel);
    const content = complete.content;
    const trimmedContent = String(content || '').trim();
    const modelHadError = response.hadError || /^\[Error:/i.test(trimmedContent);
    if (modelHadError || trimmedContent.length === 0) {
      const reason = response.errorType || trimmedContent.slice(0, 160) || 'empty sweep output';
      throw new Error(`partition sweep produced no usable content: ${reason}`);
    }

    return {
      partitionId: partition.id,
      partitionSummary: partition.summary,
      nodeCount: partition.nodeCount,
      nodesIncluded: partitionNodes.length,
      keywords: partition.keywords?.slice(0, 10) || [],
      adjacentPartitions: partition.adjacentPartitions || [],
      sweepOutput: trimmedContent
    };
  }

  // ─── Phase 3: Synthesize ─────────────────────────────────────────────

  /**
   * Synthesize all sweep outputs into a unified answer
   */
  async synthesize(query, sweepResults, options = {}) {
    const {
      model: requestedModel = null,
      provider = null,
      onChunk,
      totalNodes,
      totalEdges,
      totalPartitions,
      selectedPartitions,
      config: cfg
    } = options;
    const synthesisAssignment = this.qe?.runConfig?.modelAssignments?.synthesis;
    const model = requestedModel
      || (typeof synthesisAssignment?.model === 'string'
        ? synthesisAssignment.model.trim()
        : '')
      || null;
    const synthesisMaxTokens = cfg?.synthesisMaxTokens || PGS_DEFAULTS.synthesisMaxTokens;
    const synthesisConfig = resolveSynthesisCommitConfig(
      options.synthesis || cfg?.synthesis || this.qe.runConfig?.synthesis || this.qe.runMetadata?.synthesis,
      'pgs'
    );

    // Build synthesis context from sweep outputs
    let synthesisContext = `# Partitioned Graph Synthesis\n`;
    synthesisContext += `Full graph: ${totalNodes?.toLocaleString() || '?'} nodes, ${totalEdges?.toLocaleString() || '?'} edges across ${totalPartitions} partitions.\n`;
    synthesisContext += `Swept ${selectedPartitions} partitions (${sweepResults.length} successful). Each partition was analyzed at full fidelity.\n\n`;

    for (const sweep of sweepResults) {
      synthesisContext += `---\n\n`;
      synthesisContext += `## Partition P-${sweep.partitionId}: ${sweep.partitionSummary || 'Unknown domain'}\n`;
      synthesisContext += `(${sweep.nodesIncluded} nodes analyzed, keywords: ${sweep.keywords.join(', ')})\n\n`;
      synthesisContext += sweep.sweepOutput;
      synthesisContext += `\n\n`;
    }

    let synthesisPrompt = `You are the SYNTHESIS phase of Partitioned Graph Synthesis (PGS). You have received pre-analyzed outputs from ${sweepResults.length} successful partitions of a knowledge graph, where each partition was examined at full fidelity by a specialized sweep pass.

Your unique advantage: you see findings from ALL partitions simultaneously. No single sweep pass had this cross-domain view.

Reliability rule: only the partition outputs in the context below are evidence. Do not infer anything from failed, missing, empty, or unreachable partitions; those partitions are not included here. Do not describe model/API failures as graph findings.

Your tasks:
1. **Cross-Domain Connection Discovery**: Chase the outbound flags from each partition. When Partition A flags a connection to Partition B's domain, evaluate whether the connection is genuine and substantive.
2. **Absence Detection**: Aggregate absence signals. When multiple partitions report "no findings" for an aspect, that's high-confidence evidence of a gap. When one partition flags an outbound connection but the target reports absence, that's a research opportunity.
3. **Convergence Identification**: Find findings that appear independently across multiple partitions. Independent convergence is strong evidence of a real pattern.
4. **Thesis Formation**: Do NOT just survey findings. Make claims. Commit to positions. Identify the most important insights and rank them. This should read as a thesis, not a literature review.

Structure your response clearly with sections. Cite partition IDs and node IDs where relevant.`;
    const commitBlock = buildSynthesisCommitBlock(synthesisConfig);
    if (commitBlock) synthesisPrompt += `\n\n${commitBlock}`;

    const runtime = this.qe.resolveQueryRuntime(model, provider);

    const response = await runtime.client.generate({
      provider: runtime.providerId,
      model: runtime.effectiveModel,
      instructions: synthesisPrompt,
      input: `${synthesisContext}\n\nOriginal Query: ${query}`,
      maxTokens: synthesisMaxTokens,
      max_output_tokens: synthesisMaxTokens,
      maxOutputTokens: Math.min(synthesisMaxTokens, runtime.capabilities.maxOutputTokens),
      maxOutputBytes: PGS_OPERATION_LIMITS.maxSynthesisOutputBytes,
      reasoningEffort: 'high',
      onChunk
    });

    const complete = requireCompleteProviderResult(response);
    assertProviderResultIdentity(complete, runtime.providerId, runtime.effectiveModel);
    const answer = complete.content;
    const synthesisCommit = parseSynthesisCommitReceipt(answer, synthesisConfig);
    await writeSynthesisCommitReceipt(this.qe.runtimeDir, {
      query,
      mode: 'pgs',
      model,
      answer,
      synthesisCommit
    });

    return { answer, synthesisCommit };
  }
}

module.exports = { PGSEngine };
