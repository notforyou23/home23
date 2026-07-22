// src/system/memory-governor.js
/**
 * MemoryGovernor v1 - Advisory memory management
 * 
 * Purpose:
 * - Tracks memory node metadata
 * - Identifies candidates for pruning
 * - Applies decay to activations
 * - Advisory by default (logs only, doesn't prune)
 * 
 * Design:
 * - Non-destructive by default
 * - Configurable pruning (opt-in)
 * - Exponential decay model
 * - Bounded evaluation
 */
const {
  resolveResearchGcCriteria,
  resolveGovernorEnforcement,
  selectGcCandidates,
} = require('../memory/gc-policy');

class MemoryGovernor {
  constructor(config, logger, memory) {
    this.config = config;
    this.logger = logger;
    this.memory = memory;
    
    const cfg = config.memoryGovernance || {};
    this.enabled = cfg.enabled || false;
    this.decayHalfLifeCycles = cfg.decayHalfLifeCycles || 200;
    this.pruneThreshold = cfg.pruneThreshold || 0.1;
    this.maxNodesConsidered = cfg.maxNodesConsidered || 200;
    this.applyPruning = cfg.applyPruning || false; // Default: advisory only
    
    // Track nodes
    this.nodeIndex = new Map(); // id -> { createdAt, activation, tags, lastTouchedCycle }
  }

  /**
   * Register a newly created node
   * Called when introspection or agents add nodes
   */
  registerNode(nodeId, meta = {}) {
    if (!this.enabled) return;
    
    const now = Date.now();
    this.nodeIndex.set(nodeId, {
      createdAt: meta.createdAt || now,
      activation: meta.activation || 1.0,
      tags: meta.tags || [],
      lastTouchedCycle: meta.cycle || 0
    });
  }

  /**
   * Mark node as accessed (boosts activation)
   */
  touchNode(nodeId, cycle) {
    const entry = this.nodeIndex.get(nodeId);
    if (entry) {
      entry.lastTouchedCycle = cycle;
      entry.activation = Math.min(1.0, (entry.activation || 0.5) + 0.1);
    }
  }

  /**
   * Evaluate memory and propose pruning candidates
   * @param {number} cycle - Current cycle number
   * @returns {Object} { pruneCandidates: [...] }
   */
  evaluate(cycle) {
    if (!this.enabled || !this.nodeIndex.size) {
      return { pruneCandidates: [] };
    }

    const candidates = [];
    let count = 0;

    for (const [id, entry] of this.nodeIndex.entries()) {
      if (count++ > this.maxNodesConsidered) break;

      const ageCycles = Math.max(0, cycle - (entry.lastTouchedCycle || 0));
      
      // Exponential decay
      const halfLife = this.decayHalfLifeCycles;
      const decayFactor = Math.pow(0.5, ageCycles / halfLife);
      entry.activation = (entry.activation || 1.0) * decayFactor;

      // Identify pruning candidates
      if (entry.activation < this.pruneThreshold) {
        candidates.push({
          id,
          activation: entry.activation,
          ageCycles,
          tags: entry.tags
        });
      }
    }

    if (candidates.length > 0) {
      this.logger.info(`🧹 MemoryGovernor: identified ${candidates.length} prune candidates`, 3);
    }

    // Actually prune if enabled (DANGEROUS - off by default)
    if (this.applyPruning && this.memory && typeof this.memory.removeNode === 'function') {
      let pruned = 0;
      for (const c of candidates) {
        try {
          this.memory.removeNode(c.id);
          this.nodeIndex.delete(c.id);
          pruned++;
        } catch (err) {
          this.logger.warn('MemoryGovernor: failed to prune node', {
            id: c.id,
            error: err.message
          });
        }
      }
      
      if (pruned > 0) {
        this.logger.info(`🧹 MemoryGovernor: pruned ${pruned} nodes`, 3);
      }
    }

    return { pruneCandidates: candidates };
  }

  /**
   * ENFORCEMENT (Fix 3.2) — opt-in via memory.governor.applyPruning
   * (default FALSE; the orchestrator gates the call on the same flag).
   *
   * Unlike the legacy advisory path above — which reads this.nodeIndex, a
   * private registry nothing in the engine ever populates (registerNode /
   * touchNode have no callers), making it permanently inert — enforcement
   * selects candidates from the LIVE graph using the shared research-lifetime
   * GC criteria (weight < minWeight AND untouched > maxAgeDays), with the
   * full protected-tag set plus the run's decay.exemptTags exempt, and
   * removes at most maxPrunesPerEval nodes per evaluation through
   * NetworkMemory.removeNodes() — the exact same barrier-wrapped removal
   * path summarizer.garbageCollect uses, so edges and clusters stay
   * consistent and deletions land in the delta tombstone sets
   * (deletedNodeIds/deletedEdgeKeys) for the manifest writer.
   *
   * SYNCHRONOUS BY CONTRACT: this method must never await. The cycle loop
   * serializes phase 6 with the end-of-cycle save capture, and a synchronous
   * prune cannot interleave with the synchronous exportGraph()/
   * captureResearchState() snapshot. `options.saveInFlight` additionally
   * stands enforcement down while an out-of-band save's async write window
   * is open (shutdown joins an in-flight save, etc.).
   *
   * @param {number} cycle - Current cycle number
   * @param {Object} options - { saveInFlight?: boolean, now?: number }
   * @returns {Object} result — { applied, skipped?, removedNodes,
   *   removedEdges, candidateCount, batchLimit, criteria, nodeIds }
   */
  enforce(cycle, options = {}) {
    const enforcement = resolveGovernorEnforcement(this.config);
    const base = {
      applied: false,
      removedNodes: 0,
      removedEdges: 0,
      candidateCount: 0,
      batchLimit: enforcement.maxPrunesPerEval,
      criteria: null,
      nodeIds: [],
    };
    if (!enforcement.applyPruning) {
      return { ...base, skipped: 'not_armed' };
    }
    if (options.saveInFlight) {
      this.logger.info('🧹 MemoryGovernor: enforcement skipped — save in flight', 3);
      return { ...base, skipped: 'save_in_flight' };
    }
    if (!this.memory || typeof this.memory.removeNodes !== 'function') {
      this.logger.warn('MemoryGovernor: enforcement skipped — memory removeNodes API missing');
      return { ...base, skipped: 'memory_remove_api_missing' };
    }

    const criteria = resolveResearchGcCriteria(this.config);
    const exemptTags = this.config?.architecture?.memory?.decay?.exemptTags || null;
    const candidates = selectGcCandidates(this.memory, criteria, {
      limit: enforcement.maxPrunesPerEval,
      extraExemptTags: exemptTags,
      now: options.now,
    });
    if (candidates.length === 0) {
      return { ...base, applied: true, criteria };
    }

    const removal = this.memory.removeNodes(candidates);
    const removedNodes = removal?.removedNodes || 0;
    const removedEdges = removal?.removedEdges || 0;
    this.logger.info(
      `🧹 MemoryGovernor: enforced prune — ${removedNodes} nodes, ${removedEdges} edges `
      + `(batch limit ${enforcement.maxPrunesPerEval}, weight < ${criteria.minWeight}, `
      + `untouched > ${criteria.maxAgeDays}d, cycle ${cycle})`,
      3
    );
    return {
      ...base,
      applied: true,
      removedNodes,
      removedEdges,
      candidateCount: candidates.length,
      criteria,
      nodeIds: candidates.slice(0, 20),
    };
  }
}

module.exports = { MemoryGovernor };

