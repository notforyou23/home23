/**
 * COSMO Merge V2 - Semantic Domain Embeddings
 * 
 * Generates embeddings for domain strings using the same model as node embeddings.
 * Provides fallback hash-based embeddings when API is unavailable.
 */

const crypto = require('crypto');
const { createSeededRng } = require('./deterministic');

/**
 * @typedef {Object} DomainEmbeddingConfig
 * @property {number} alpha - Weight of domain embedding (default 0.15)
 * @property {number} dimensions - Embedding dimensions (default 512)
 * @property {string} model - Embedding model name
 */

const DEFAULT_CONFIG = {
  alpha: 0.15,
  dimensions: 512,
  model: 'text-embedding-3-small'
};

class DomainEmbeddingProvider {
  /**
   * @param {DomainEmbeddingConfig} config 
   * @param {object} logger - Optional logger
   */
  constructor(config = {}, logger = null) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    
    /** @type {Map<string, number[]>} - Cache of domain -> embedding */
    this.cache = new Map();
    
    /** @type {boolean} - Whether API is available */
    this.apiAvailable = true;
    
    /** @type {function|null} - OpenAI client getter */
    this.getOpenAIClient = null;
    
    // Try to load OpenAI client
    try {
      const { getOpenAIClient } = require('../core/openai-client');
      this.getOpenAIClient = getOpenAIClient;
    } catch (err) {
      this.logger?.warn?.('OpenAI client not available, using hash-based embeddings');
      this.apiAvailable = false;
    }
  }
  
  /**
   * Get embedding for a domain string
   * Uses API if available, falls back to hash-based embedding
   * 
   * @param {string} domain - Domain string
   * @returns {Promise<number[]>} - Embedding vector
   */
  async getEmbedding(domain) {
    const normalized = (domain || 'unknown').toLowerCase().trim();
    
    // Check cache
    if (this.cache.has(normalized)) {
      return this.cache.get(normalized);
    }
    
    let embedding;
    
    if (this.apiAvailable && this.getOpenAIClient) {
      try {
        embedding = await this._getApiEmbedding(normalized);
      } catch (err) {
        this.logger?.warn?.(`API embedding failed for domain "${normalized}", using fallback: ${err.message}`);
        embedding = this._getHashEmbedding(normalized);
      }
    } else {
      embedding = this._getHashEmbedding(normalized);
    }
    
    // Cache result
    this.cache.set(normalized, embedding);
    
    return embedding;
  }
  
  /**
   * Get embedding via OpenAI API
   * @private
   */
  async _getApiEmbedding(domain) {
    const client = this.getOpenAIClient();
    
    const response = await client.embeddings.create({
      model: this.config.model,
      input: domain,
      encoding_format: 'float',
      dimensions: this.config.dimensions
    });
    
    if (!response?.data?.[0]?.embedding) {
      throw new Error('Invalid API response');
    }
    
    return response.data[0].embedding;
  }
  
  /**
   * Generate deterministic hash-based embedding (fallback)
   * 
   * Properties:
   * - Stable: same domain always produces same embedding
   * - Unit normalized: magnitude = 1
   * - Deterministic: no Math.random()
   * 
   * Note: Hash embeddings have no semantic meaning - they only provide
   * domain separation, not semantic similarity between domains.
   * 
   * @private
   * @param {string} domain 
   * @returns {number[]}
   */
  _getHashEmbedding(domain) {
    const seed = crypto.createHash('sha256')
      .update(`domain:${domain}`)
      .digest('hex');
    
    const rng = createSeededRng(seed);
    const dim = this.config.dimensions;
    
    // Generate random vector
    const vec = new Array(dim);
    for (let i = 0; i < dim; i++) {
      vec[i] = rng() * 2 - 1; // [-1, 1]
    }
    
    // Normalize to unit vector
    return normalize(vec);
  }
  
  /**
   * Get all cached embeddings (for persistence)
   * @returns {Object<string, number[]>}
   */
  getCachedEmbeddings() {
    const result = {};
    for (const [domain, embedding] of this.cache) {
      result[domain] = embedding;
    }
    return result;
  }
  
  /**
   * Load cached embeddings (from persistence)
   * @param {Object<string, number[]>} cached 
   */
  loadCachedEmbeddings(cached) {
    if (!cached) return;
    for (const [domain, embedding] of Object.entries(cached)) {
      this.cache.set(domain, embedding);
    }
  }
}

/**
 * Normalize a vector to unit length
 * 
 * @param {number[]} vec 
 * @returns {number[]}
 */
function normalize(vec) {
  let magnitude = 0;
  for (let i = 0; i < vec.length; i++) {
    magnitude += vec[i] * vec[i];
  }
  magnitude = Math.sqrt(magnitude);
  
  if (magnitude === 0) {
    return vec;
  }
  
  const result = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] / magnitude;
  }
  return result;
}

/**
 * Combine node embedding with domain embedding
 * 
 * Formula: normalize(nodeEmbedding + alpha * domainEmbedding)
 * 
 * @param {number[]} nodeEmbedding - Node's semantic embedding
 * @param {number[]} domainEmbedding - Domain's embedding
 * @param {number} alpha - Domain weight (default 0.15)
 * @returns {number[]} - Combined normalized embedding
 */
function combinedEmbedding(nodeEmbedding, domainEmbedding, alpha = 0.15) {
  if (!nodeEmbedding || !domainEmbedding) {
    return nodeEmbedding || domainEmbedding || null;
  }
  
  const dim = nodeEmbedding.length;
  const out = new Array(dim);
  
  for (let i = 0; i < dim; i++) {
    out[i] = nodeEmbedding[i] + alpha * (domainEmbedding[i] || 0);
  }
  
  return normalize(out);
}

module.exports = {
  DomainEmbeddingProvider,
  combinedEmbedding,
  normalize,
  DEFAULT_CONFIG
};

