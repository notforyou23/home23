/**
 * cross-reference.js - Cross-Reference Density Tracking
 * 
 * Tracks bidirectional references between nodes and computes
 * connection density metrics for graph analysis.
 * 
 * @module core/cross-reference
 */

/**
 * CrossReference - Tracks connections between nodes
 * 
 * @class CrossReference
 * Maintains adjacency lists and computes density metrics
 */
class CrossReference {
  /**
   * Create cross-reference tracker
   */
  constructor() {
    // adjacency[nodeId] = { inbound: Set, outbound: Set }
    this.adjacency = new Map();
    // references[source] = { target: type }
    this.references = new Map();
    // Memoization cache
    this._densityCache = new Map();
  }

  /**
   * Add reference from source to target node.
   * Creates bidirectional tracking.
   * 
   * @param {string} sourceId - Source node ID
   * @param {string} targetId - Target node ID
   * @param {string} [type='link'] - Reference type
   * @returns {Object} Reference added: { sourceId, targetId, type }
   * @throws {TypeError} If IDs invalid
   */
  addReference(sourceId, targetId, type = 'link') {
    if (typeof sourceId !== 'string' || !sourceId) {
      throw new TypeError('sourceId must be a non-empty string');
    }

    if (typeof targetId !== 'string' || !targetId) {
      throw new TypeError('targetId must be a non-empty string');
    }

    if (typeof type !== 'string' || !type) {
      throw new TypeError('type must be a non-empty string');
    }

    // Initialize source if not exists
    if (!this.adjacency.has(sourceId)) {
      this.adjacency.set(sourceId, { inbound: new Set(), outbound: new Set() });
    }

    // Initialize target if not exists
    if (!this.adjacency.has(targetId)) {
      this.adjacency.set(targetId, { inbound: new Set(), outbound: new Set() });
    }

    // Add reference
    const sourceKey = `${sourceId}→${targetId}`;
    if (!this.references.has(sourceKey)) {
      this.references.set(sourceKey, type);

      // Update adjacency lists
      this.adjacency.get(sourceId).outbound.add(targetId);
      this.adjacency.get(targetId).inbound.add(sourceId);

      // Invalidate cache
      this._densityCache.delete(sourceId);
      this._densityCache.delete(targetId);
    }

    return { sourceId, targetId, type };
  }

  /**
   * Remove reference from source to target.
   * 
   * @param {string} sourceId - Source node ID
   * @param {string} targetId - Target node ID
   * @returns {boolean} True if reference was removed
   * @throws {TypeError} If IDs invalid
   */
  removeReference(sourceId, targetId) {
    if (typeof sourceId !== 'string' || !sourceId) {
      throw new TypeError('sourceId must be a non-empty string');
    }

    if (typeof targetId !== 'string' || !targetId) {
      throw new TypeError('targetId must be a non-empty string');
    }

    const sourceKey = `${sourceId}→${targetId}`;
    const existed = this.references.has(sourceKey);

    if (existed) {
      this.references.delete(sourceKey);

      const sourceAdj = this.adjacency.get(sourceId);
      const targetAdj = this.adjacency.get(targetId);

      sourceAdj.outbound.delete(targetId);
      targetAdj.inbound.delete(sourceId);

      // Invalidate cache
      this._densityCache.delete(sourceId);
      this._densityCache.delete(targetId);
    }

    return existed;
  }

  /**
   * Get all references for a node.
   * 
   * @param {string} nodeId - Node identifier
   * @returns {Object} References { inbound: Set, outbound: Set }
   */
  getReferences(nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (!this.adjacency.has(nodeId)) {
      return { inbound: new Set(), outbound: new Set() };
    }

    const { inbound, outbound } = this.adjacency.get(nodeId);
    return {
      inbound: new Set(inbound),
      outbound: new Set(outbound),
    };
  }

  /**
   * Get inbound references for a node.
   * 
   * @param {string} nodeId - Node identifier
   * @returns {Set} Set of node IDs with references to this node
   */
  getInboundReferences(nodeId) {
    if (!this.adjacency.has(nodeId)) {
      return new Set();
    }
    return new Set(this.adjacency.get(nodeId).inbound);
  }

  /**
   * Get outbound references from a node.
   * 
   * @param {string} nodeId - Node identifier
   * @returns {Set} Set of node IDs this node references
   */
  getOutboundReferences(nodeId) {
    if (!this.adjacency.has(nodeId)) {
      return new Set();
    }
    return new Set(this.adjacency.get(nodeId).outbound);
  }

  /**
   * Compute connection density for a node.
   * Density = (inbound + outbound) / (2 * (nodeCount - 1))
   * 
   * @param {string} nodeId - Node identifier
   * @param {number} [nodeCount] - Total nodes in graph (for density normalization)
   * @returns {Object} Density metrics { density, inboundCount, outboundCount, referenceCount }
   * @throws {TypeError} If parameters invalid
   */
  getDensity(nodeId, nodeCount) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    // Check cache
    const cacheKey = `${nodeId}:${nodeCount || 'null'}`;
    if (this._densityCache.has(cacheKey)) {
      return this._densityCache.get(cacheKey);
    }

    if (!this.adjacency.has(nodeId)) {
      const result = {
        nodeId,
        density: 0,
        inboundCount: 0,
        outboundCount: 0,
        referenceCount: 0,
        nodeCount: nodeCount || this.adjacency.size,
      };
      this._densityCache.set(cacheKey, result);
      return result;
    }

    const { inbound, outbound } = this.adjacency.get(nodeId);
    const inboundCount = inbound.size;
    const outboundCount = outbound.size;
    const referenceCount = inboundCount + outboundCount;

    // Use provided nodeCount or count from adjacency
    const actualNodeCount = nodeCount || this.adjacency.size;
    
    // Density = references / (2 * (nodeCount - 1))
    // Max possible edges per node = 2 * (nodeCount - 1)
    const maxPossibleReferences = 2 * (actualNodeCount - 1);
    const density = maxPossibleReferences > 0 ? referenceCount / maxPossibleReferences : 0;

    const result = {
      nodeId,
      density: Math.max(0, Math.min(1, density)), // Clamp to [0, 1]
      inboundCount,
      outboundCount,
      referenceCount,
      nodeCount: actualNodeCount,
    };

    this._densityCache.set(cacheKey, result);
    return result;
  }

  /**
   * Get the graph as adjacency structure.
   * 
   * @returns {Object} Adjacency object { nodeId: { inbound: Set, outbound: Set }, ... }
   */
  getGraph() {
    const graph = {};

    for (const [nodeId, adj] of this.adjacency.entries()) {
      graph[nodeId] = {
        inbound: Array.from(adj.inbound),
        outbound: Array.from(adj.outbound),
      };
    }

    return graph;
  }

  /**
   * Get all references as edge list.
   * 
   * @returns {Array} Array of edges [{ source, target, type }, ...]
   */
  getEdgeList() {
    const edges = [];

    for (const [sourceKey, type] of this.references.entries()) {
      const [source, target] = sourceKey.split('→');
      edges.push({ source, target, type });
    }

    return edges;
  }

  /**
   * Check if reference exists between nodes.
   * 
   * @param {string} sourceId - Source node ID
   * @param {string} targetId - Target node ID
   * @returns {boolean} True if reference exists
   */
  hasReference(sourceId, targetId) {
    const sourceKey = `${sourceId}→${targetId}`;
    return this.references.has(sourceKey);
  }

  /**
   * Get reference type between nodes.
   * 
   * @param {string} sourceId - Source node ID
   * @param {string} targetId - Target node ID
   * @returns {string|null} Reference type or null if not found
   */
  getReferenceType(sourceId, targetId) {
    const sourceKey = `${sourceId}→${targetId}`;
    return this.references.get(sourceKey) || null;
  }

  /**
   * Get degree (hub) score for a node.
   * Score = (inbound + outbound) / (2 * maxPossibleDegree)
   * 
   * @param {string} nodeId - Node identifier
   * @param {number} [nodeCount] - Total nodes in graph
   * @returns {number} Degree score [0.0, 1.0]
   */
  getDegreeScore(nodeId, nodeCount) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    const density = this.getDensity(nodeId, nodeCount);
    return density.density;
  }

  /**
   * Get reference count for a node.
   * 
   * @param {string} nodeId - Node identifier
   * @returns {number} Total number of references (inbound + outbound)
   */
  getReferenceCount(nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    const { inbound, outbound } = this.getReferences(nodeId);
    return inbound.size + outbound.size;
  }

  /**
   * Get total number of nodes.
   * 
   * @returns {number} Node count
   */
  getNodeCount() {
    return this.adjacency.size;
  }

  /**
   * Get total number of references.
   * 
   * @returns {number} Reference count
   */
  getReferenceTotal() {
    return this.references.size;
  }

  /**
   * Clear all references and reset state.
   */
  clear() {
    this.adjacency.clear();
    this.references.clear();
    this._densityCache.clear();
  }

  /**
   * Serialize to plain object.
   * 
   * @returns {Object} Serialized state
   */
  toJSON() {
    return {
      nodeCount: this.adjacency.size,
      referenceCount: this.references.size,
      edges: this.getEdgeList(),
    };
  }
}

/**
 * Factory function to create cross-reference tracker.
 * 
 * @returns {CrossReference} New tracker instance
 */
function createCrossReference() {
  return new CrossReference();
}

/**
 * Compute density for arbitrary references.
 * 
 * @param {number} referenceCount - Number of references
 * @param {number} nodeCount - Total nodes in graph
 * @returns {number} Density value [0.0, 1.0]
 */
function computeDensity(referenceCount, nodeCount) {
  if (typeof referenceCount !== 'number' || referenceCount < 0) {
    throw new TypeError('referenceCount must be a non-negative number');
  }

  if (typeof nodeCount !== 'number' || nodeCount <= 1) {
    throw new TypeError('nodeCount must be a number > 1');
  }

  const maxPossible = 2 * (nodeCount - 1);
  const density = maxPossible > 0 ? referenceCount / maxPossible : 0;

  return Math.max(0, Math.min(1, density));
}

/**
 * Compute average density of a reference set.
 * 
 * @param {Array} references - Array of reference objects
 * @param {number} nodeCount - Total nodes in graph
 * @returns {number} Average density
 */
function computeAverageDensity(references, nodeCount) {
  if (!Array.isArray(references)) {
    throw new TypeError('references must be an array');
  }

  if (references.length === 0) {
    return 0;
  }

  let totalDensity = 0;

  for (const ref of references) {
    totalDensity += computeDensity(ref.count || 0, nodeCount);
  }

  return totalDensity / references.length;
}

// Export public API
module.exports = {
  CrossReference,
  createCrossReference,
  computeDensity,
  computeAverageDensity,
};
