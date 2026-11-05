/**
 * COSMO Merge V2 - ANN Index Abstraction
 * 
 * Provides approximate nearest neighbor search with fallback to exact search.
 * Primary: hnswlib-node (when available)
 * Fallback: Exact O(n²) cosine similarity search
 */

/**
 * @typedef {Object} AnnConfig
 * @property {number} M - HNSW connections per layer (default 32)
 * @property {number} efConstruction - Build-time search depth (default 200)
 * @property {number} efSearch - Query-time search depth (default 100)
 */

const DEFAULT_CONFIG = {
  M: 100,
  efConstruction: 200,
  efSearch: 100
};

/**
 * Abstract ANN Index interface
 */
class AnnIndex {
  constructor(dimensions, config = {}) {
    this.dimensions = dimensions;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.vectors = [];
    this.ids = [];
    this.idToIndex = new Map();
  }
  
  /**
   * Add a vector to the index
   * @param {number[]} vector - Embedding vector (must be normalized)
   * @param {string|number} id - Node ID
   */
  addPoint(vector, id) {
    const idx = this.vectors.length;
    this.vectors.push(vector);
    this.ids.push(id);
    this.idToIndex.set(String(id), idx);
  }
  
  /**
   * Build the index (no-op for exact search, required for HNSW)
   */
  build() {
    // No-op for exact search fallback
  }
  
  /**
   * Search for k nearest neighbors
   * @param {number[]} vector - Query vector
   * @param {number} k - Number of neighbors
   * @returns {{ids: (string|number)[], distances: number[]}}
   */
  searchKnn(vector, k) {
    // Exact search implementation
    const similarities = [];
    
    for (let i = 0; i < this.vectors.length; i++) {
      const sim = cosineSimilarity(vector, this.vectors[i]);
      similarities.push({ idx: i, sim });
    }
    
    // Sort by similarity descending (higher = more similar)
    similarities.sort((a, b) => b.sim - a.sim);
    
    // Take top k
    const topK = similarities.slice(0, k);
    
    return {
      ids: topK.map(s => this.ids[s.idx]),
      distances: topK.map(s => 1 - s.sim) // Convert similarity to distance
    };
  }
  
  /**
   * Get vector count
   * @returns {number}
   */
  get size() {
    return this.vectors.length;
  }
  
  /**
   * Check if index contains an ID
   * @param {string|number} id 
   * @returns {boolean}
   */
  hasId(id) {
    return this.idToIndex.has(String(id));
  }
  
  /**
   * Get vector by ID
   * @param {string|number} id 
   * @returns {number[]|null}
   */
  getVector(id) {
    const idx = this.idToIndex.get(String(id));
    if (idx === undefined) return null;
    return this.vectors[idx];
  }
  
  /**
   * Serialize index state
   * @returns {object}
   */
  serialize() {
    return {
      dimensions: this.dimensions,
      config: this.config,
      vectors: this.vectors,
      ids: this.ids
    };
  }
  
  /**
   * Create index from serialized state
   * @param {object} state 
   * @returns {AnnIndex}
   */
  static deserialize(state) {
    const index = new AnnIndex(state.dimensions, state.config);
    index.vectors = state.vectors || [];
    index.ids = state.ids || [];
    
    // Rebuild id map
    for (let i = 0; i < index.ids.length; i++) {
      index.idToIndex.set(String(index.ids[i]), i);
    }
    
    return index;
  }
}

/**
 * Calculate cosine similarity between two vectors
 * Assumes vectors are normalized (or normalizes them)
 * 
 * @param {number[]} a 
 * @param {number[]} b 
 * @returns {number} - Similarity in [-1, 1], typically [0, 1] for normalized vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }
  
  let dot = 0;
  let magA = 0;
  let magB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  
  if (magA === 0 || magB === 0) {
    return 0;
  }
  
  return dot / (magA * magB);
}

/**
 * Try to create an HNSW index, fall back to exact search
 * 
 * @param {number} dimensions 
 * @param {AnnConfig} config 
 * @param {object} logger 
 * @returns {AnnIndex}
 */
function createAnnIndex(dimensions, config = {}, logger = null) {
  // Try to load hnswlib-node
  try {
    const HnswIndex = tryLoadHnsw();
    if (HnswIndex) {
      logger?.info?.('Using hnswlib-node for ANN index');
      return new HnswIndex(dimensions, config);
    }
  } catch (err) {
    // Fall through to exact search
  }
  
  // Fallback warning
  logger?.warn?.(
    'ANN library unavailable. Falling back to O(n²) exact search. ' +
    'Expected runtime will be significantly higher for large brains. ' +
    'Install hnswlib-node for better performance.'
  );
  
  return new AnnIndex(dimensions, config);
}

/**
 * Try to load hnswlib-node
 * @returns {class|null}
 */
function tryLoadHnsw() {
  try {
    // This will fail if hnswlib-node is not installed
    const hnswlib = require('hnswlib-node');
    
    // Return a wrapper class that implements our interface
    return class HnswAnnIndex extends AnnIndex {
      constructor(dimensions, config = {}) {
        super(dimensions, config);
        this.hnsw = new hnswlib.HierarchicalNSW('cosine', dimensions);
        this.initialized = false;
      }
      
      addPoint(vector, id) {
        super.addPoint(vector, id);
        
        if (!this.initialized) {
          // Initialize with expected size (can grow)
          this.hnsw.initIndex(this.config.maxElements || 50000, this.config.M, this.config.efConstruction);
          this.initialized = true;
        }
        
        this.hnsw.addPoint(vector, this.vectors.length - 1);
      }
      
      build() {
        // HNSW builds incrementally, nothing to do
      }
      
      searchKnn(vector, k) {
        if (!this.initialized || this.vectors.length === 0) {
          return { ids: [], distances: [] };
        }
        
        this.hnsw.setEf(this.config.efSearch);
        const result = this.hnsw.searchKnn(vector, Math.min(k, this.vectors.length));
        
        return {
          ids: result.neighbors.map(idx => this.ids[idx]),
          distances: result.distances
        };
      }
    };
  } catch (err) {
    return null;
  }
}

module.exports = {
  AnnIndex,
  createAnnIndex,
  cosineSimilarity,
  DEFAULT_CONFIG
};

