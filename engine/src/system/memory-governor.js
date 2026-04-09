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
}

module.exports = { MemoryGovernor };

