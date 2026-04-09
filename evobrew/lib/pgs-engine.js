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

// ─── Configurable defaults (override via options.pgsConfig or env vars) ──────
const PGS_DEFAULTS = {
  maxConcurrentSweeps: parseInt(process.env.PGS_MAX_CONCURRENT_SWEEPS) || 5,
  minNodesForPgs: parseInt(process.env.PGS_MIN_NODES) || 0,
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
// Session state storage
const SESSION_DIR = 'pgs-sessions';
const DEFAULT_SESSION_ID = 'default';

class PGSEngine {
  constructor(queryEngine) {
    this.qe = queryEngine;
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
      model = 'claude-opus-4-5',
      mode: legacyMode = 'full',
      pgsMode,
      pgsSessionId = DEFAULT_SESSION_ID,
      pgsFullSweep = false,
      pgsSweepModel: sweepModelOverride = null,
      onChunk,
      enableSynthesis,
      includeCoordinatorInsights
    } = options;
    const mode = pgsMode || legacyMode || 'full';
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

    // Guard: too small for PGS - fall back to standard query (with enablePGS: false to prevent loop)
    if (config.minNodesForPgs > 0 && nodes.length < config.minNodesForPgs) {
      emit({ type: 'progress', message: `Brain has ${nodes.length} nodes (< ${config.minNodesForPgs}). Using standard query instead of PGS.` });
      return await this.qe.executeQuery(query, { ...options, enablePGS: false });
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
    const session = await this.loadSession(pgsSessionId);
    const searchedIds = new Set(session?.searchedPartitionIds || []);

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

    // Sweep model: per-query override > configured default > synthesis model
    const sweepModel = sweepModelOverride || this.qe.modelDefaults?.pgsSweepModel || model;
    if (model !== sweepModel) {
      emit({ type: 'progress', message: `Sweeping with ${sweepModel} (synthesis will use ${model})` });
    }
    const sweepResults = await this.sweepPartitions(query, partitionsToSweep, nodeMap, edges, partitions, onChunk, sweepModel, config);

    const successfulSweeps = sweepResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    emit({ type: 'progress', message: `${successfulSweeps.length}/${partitionsToSweep.length} sweeps completed` });

    // Persist session: merge newly swept partition IDs
    const newSearchedIds = new Set([...searchedIds, ...partitionsToSweep.map(p => p.id)]);
    await this.saveSession(pgsSessionId, {
      query,
      mode,
      searchedPartitionIds: [...newSearchedIds],
      totalPartitions: partitions.length,
      timestamp: new Date().toISOString()
    });

    // Emit updated session counts
    emit({
      type: 'pgs_session_updated',
      sessionId: pgsSessionId,
      searched: newSearchedIds.size,
      remaining: partitions.length - newSearchedIds.size,
      total: partitions.length
    });

    if (successfulSweeps.length === 0) {
      emit({ type: 'progress', message: 'All sweeps failed, falling back to standard query' });
      return await this.qe.executeQuery(query, { ...options, enablePGS: false });
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
      config
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    emit({ type: 'pgs_phase', phase: 'done', phaseIndex: 4, totalPhases: 4, message: `Complete in ${elapsed}s` });

    // Build result in standard format
    return {
      answer: synthesisResult,
      metadata: {
        model,
        mode: 'pgs',
        pgs: {
          totalNodes: nodes.length,
          totalEdges: edges.length,
          totalPartitions: partitions.length,
          sweptPartitions: partitionsToSweep.length,
          successfulSweeps: successfulSweeps.length,
          sweepModel: sweepModel,
          synthesisModel: model,
          elapsed: `${elapsed}s`,
          sessionMode: mode,
          sessionId: pgsSessionId,
          searched: newSearchedIds.size,
          remaining: partitions.length - newSearchedIds.size
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

  // ─── Phase 1: Partition (cached) ─────────────────────────────────────

  /**
   * Get cached partitions or create new ones via Louvain community detection
   */
  async getOrCreatePartitions(state, nodes, edges, onChunk, config) {
    const partitionsPath = path.join(this.qe.runtimeDir, PARTITIONS_FILE);
    const brainHash = this.computeBrainHash(state, nodes, edges);

    // Try loading cached partitions
    try {
      const cached = JSON.parse(await fs.readFile(partitionsPath, 'utf8'));
      if (cached.brainHash === brainHash && cached.partitions?.length > 0) {
        if (onChunk) onChunk({ type: 'progress', message: `PGS: Loaded ${cached.partitions.length} cached partitions` });
        return cached.partitions;
      }
      if (onChunk) onChunk({ type: 'progress', message: 'PGS: Partition cache stale, regenerating...' });
    } catch {
      if (onChunk) onChunk({ type: 'progress', message: 'PGS: No partition cache found, generating...' });
    }

    // Run Louvain community detection
    if (onChunk) onChunk({ type: 'progress', message: 'PGS: Running community detection (Louvain algorithm)...' });
    const communities = this.runLouvain(nodes, edges, config);

    // Enrich partitions with metadata
    if (onChunk) onChunk({ type: 'progress', message: `PGS: Enriching ${communities.length} partitions with metadata...` });
    const partitions = await this.enrichPartitions(communities, nodes, edges, onChunk);

    // Cache
    const cacheData = {
      version: 1,
      created: new Date().toISOString(),
      brainHash,
      partitions
    };

    try {
      await fs.writeFile(partitionsPath, JSON.stringify(cacheData), 'utf8');
      if (onChunk) onChunk({ type: 'progress', message: `PGS: Cached ${partitions.length} partitions to disk` });
    } catch (err) {
      console.error('[PGS] Failed to cache partitions:', err.message);
    }

    return partitions;
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

    return result;
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

    // Only enforce minimum if configured (default 0 = no forced minimum)
    if (minSweepPartitions > 0 && selected.length < minSweepPartitions) {
      selected = ranked.slice(0, minSweepPartitions);
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
  async sweepPartitions(query, selectedPartitions, nodeMap, edges, allPartitions, onChunk, model, config) {
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

          const result = await this.sweepPartition(query, partition, nodeMap, edges, allPartitions, model, config);
          completedCount++;

          emit({
            type: 'pgs_sweep_progress',
            partitionIndex: idx,
            total,
            partitionId: partition.id,
            status: 'complete',
            summary,
            completed: completedCount,
            message: `Complete (${completedCount}/${total}): ${summary}`
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
  async sweepPartition(query, partition, nodeMap, edges, allPartitions, model, config) {
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

    // Route to correct provider based on user's selected model
    const isClaudeModel = model.startsWith('claude');
    const client = isClaudeModel ? this.qe.anthropicClient : this.qe.gpt5Client;

    const response = await client.generate({
      model: model,
      instructions: sweepPrompt,
      input,
      maxTokens: sweepMaxTokens,
      max_output_tokens: sweepMaxTokens,
      reasoningEffort: 'medium'
    });

    const content = response.content || response.message?.content || '';

    return {
      partitionId: partition.id,
      partitionSummary: partition.summary,
      nodeCount: partition.nodeCount,
      nodesIncluded: partitionNodes.length,
      keywords: partition.keywords?.slice(0, 10) || [],
      adjacentPartitions: partition.adjacentPartitions || [],
      sweepOutput: content
    };
  }

  // ─── Phase 3: Synthesize ─────────────────────────────────────────────

  /**
   * Synthesize all sweep outputs into a unified answer
   */
  async synthesize(query, sweepResults, options = {}) {
    const { model = 'claude-opus-4-5', onChunk, totalNodes, totalEdges, totalPartitions, selectedPartitions, config: cfg } = options;
    const synthesisMaxTokens = cfg?.synthesisMaxTokens || PGS_DEFAULTS.synthesisMaxTokens;

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

    const synthesisPrompt = `You are the SYNTHESIS phase of Partitioned Graph Synthesis (PGS). You have received pre-analyzed outputs from ${sweepResults.length} partitions of a knowledge graph, where each partition was examined at full fidelity by a specialized sweep pass.

Your unique advantage: you see findings from ALL partitions simultaneously. No single sweep pass had this cross-domain view.

Your tasks:
1. **Cross-Domain Connection Discovery**: Chase the outbound flags from each partition. When Partition A flags a connection to Partition B's domain, evaluate whether the connection is genuine and substantive.
2. **Absence Detection**: Aggregate absence signals. When multiple partitions report "no findings" for an aspect, that's high-confidence evidence of a gap. When one partition flags an outbound connection but the target reports absence, that's a research opportunity.
3. **Convergence Identification**: Find findings that appear independently across multiple partitions. Independent convergence is strong evidence of a real pattern.
4. **Thesis Formation**: Do NOT just survey findings. Make claims. Commit to positions. Identify the most important insights and rank them. This should read as a thesis, not a literature review.

Structure your response clearly with sections. Cite partition IDs and node IDs where relevant.`;

    const isClaudeModel = model.startsWith('claude');
    const client = isClaudeModel ? this.qe.anthropicClient : this.qe.gpt5Client;

    const response = await client.generate({
      model,
      instructions: synthesisPrompt,
      input: `${synthesisContext}\n\nOriginal Query: ${query}`,
      maxTokens: synthesisMaxTokens,
      max_output_tokens: synthesisMaxTokens,
      reasoningEffort: 'high',
      onChunk
    });

    return response.content || response.message?.content || '';
  }
}

module.exports = { PGSEngine };
