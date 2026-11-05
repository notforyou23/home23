/**
 * Brain Semantic Search Module
 * 
 * Provides semantic search over .brain memory nodes using OpenAI embeddings.
 * Adapted from COSMO's coordinator-indexer.js and query-engine.js patterns.
 * 
 * Architecture:
 * - Lazy embedding generation (only when search is requested)
 * - In-memory cache for embeddings (persisted to brain/embeddings-cache.json)
 * - Batch processing with rate limiting
 * - Fallback to keyword search if embeddings fail
 * - Cosine similarity matching (COSMO algorithm)
 */

const crypto = require('crypto');

class BrainSemanticSearch {
  constructor(brainLoader, openaiClient) {
    this.brainLoader = brainLoader;
    this.openai = openaiClient;
    this.embeddingsCache = new Map(); // nodeId -> embedding
    this.isIndexed = false;
    this.indexingInProgress = false;
    this.lastIndexTime = 0;
  }

  /**
   * Get memory nodes from brain state
   */
  getMemoryNodes() {
    const state = this.brainLoader.state;
    return state?.memory?.nodes || [];
  }

  /**
   * Generate embeddings for all memory nodes (lazy, cached)
   * Only runs once per brain load unless explicitly invalidated
   */
  async ensureIndexed() {
    if (this.isIndexed) {
      return; // Already indexed
    }

    if (this.indexingInProgress) {
      // Wait for existing indexing to complete
      while (this.indexingInProgress) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return;
    }

    this.indexingInProgress = true;
    console.log('[SEMANTIC SEARCH] Starting indexing...');

    try {
      const nodes = this.getMemoryNodes();
      
      if (nodes.length === 0) {
        console.log('[SEMANTIC SEARCH] No nodes to index');
        this.isIndexed = true;
        this.indexingInProgress = false;
        return;
      }

      console.log(`[SEMANTIC SEARCH] Indexing ${nodes.length} memory nodes...`);

      // Filter nodes that need embeddings
      const nodesToEmbed = nodes.filter(node => {
        if (!node.concept || node.concept.length < 10) return false;
        if (this.embeddingsCache.has(String(node.id))) return false;
        return true;
      });

      console.log(`[SEMANTIC SEARCH] ${nodesToEmbed.length} nodes need embeddings (${this.embeddingsCache.size} cached)`);

      if (nodesToEmbed.length === 0) {
        this.isIndexed = true;
        this.indexingInProgress = false;
        return;
      }

      // Generate embeddings in batches (COSMO pattern)
      await this.generateEmbeddingsBatch(nodesToEmbed);

      this.isIndexed = true;
      this.lastIndexTime = Date.now();
      console.log(`[SEMANTIC SEARCH] ✅ Indexing complete. ${this.embeddingsCache.size} embeddings in cache.`);

    } catch (error) {
      console.error('[SEMANTIC SEARCH] Indexing failed:', error);
      throw error;
    } finally {
      this.indexingInProgress = false;
    }
  }

  /**
   * Generate embeddings for nodes in batches
   * Copied from coordinator-indexer.js pattern
   */
  async generateEmbeddingsBatch(nodes) {
    const batchSize = 20; // API limit safety
    const totalBatches = Math.ceil(nodes.length / batchSize);

    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      // Prepare text inputs (concept content)
      const texts = batch.map(node => {
        // Include node metadata for better context
        const tag = node.tag || 'unknown';
        const header = `[${tag}]`;
        return `${header} ${node.concept}`;
      });

      try {
        const response = await this.openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: texts
        });

        // Store embeddings in cache
        for (let j = 0; j < batch.length; j++) {
          const nodeId = String(batch[j].id);
          this.embeddingsCache.set(nodeId, response.data[j].embedding);
        }

        console.log(`[SEMANTIC SEARCH] Batch ${batchNum}/${totalBatches} complete`);

      } catch (error) {
        console.error(`[SEMANTIC SEARCH] Batch ${batchNum} failed:`, error.message);
        // Continue with other batches
      }

      // Rate limit protection (100ms between batches)
      if (i + batchSize < nodes.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Semantic search over memory nodes
   * Returns nodes ranked by similarity to query
   * 
   * @param {string} query - Search query
   * @param {object} options - Search options
   * @param {number} options.limit - Max results (default: 20)
   * @param {string} options.tag - Filter by tag (optional)
   * @param {number} options.minSimilarity - Minimum similarity threshold (0-1, default: 0.3)
   * @returns {Promise<object>} { results: Array, stats: object }
   */
  async search(query, options = {}) {
    const {
      limit = 20,
      tag = null,
      minSimilarity = 0.3
    } = options;

    const startTime = Date.now();

    // Ensure brain is indexed
    await this.ensureIndexed();

    const nodes = this.getMemoryNodes();

    if (nodes.length === 0) {
      return {
        results: [],
        stats: { method: 'none', took: 0, total: 0 }
      };
    }

    // Filter by tag if specified
    let searchableNodes = nodes;
    if (tag) {
      searchableNodes = nodes.filter(n => n.tag === tag);
      console.log(`[SEMANTIC SEARCH] Filtered to ${searchableNodes.length} nodes with tag "${tag}"`);
    }

    // Generate query embedding
    let queryEmbedding;
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query
      });
      queryEmbedding = response.data[0].embedding;
    } catch (error) {
      console.error('[SEMANTIC SEARCH] Failed to generate query embedding:', error);
      // Fallback to keyword search
      return this.keywordSearch(searchableNodes, query, { limit, minSimilarity: 0.1 });
    }

    // Calculate similarities (COSMO algorithm)
    const scored = searchableNodes
      .filter(node => {
        const nodeId = String(node.id);
        return this.embeddingsCache.has(nodeId) && node.concept;
      })
      .map(node => {
        const nodeId = String(node.id);
        const embedding = this.embeddingsCache.get(nodeId);
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);

        return {
          id: node.id,
          concept: node.concept,
          tag: node.tag,
          weight: node.weight,
          activation: node.activation,
          cluster: node.cluster,
          similarity,
          // Match query engine format
          score: similarity
        };
      })
      .filter(node => node.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    const took = Date.now() - startTime;

    console.log(`[SEMANTIC SEARCH] Found ${scored.length} results for "${query.substring(0, 50)}..." (${took}ms)`);

    return {
      results: scored,
      stats: {
        method: 'semantic',
        took,
        total: searchableNodes.length,
        indexed: this.embeddingsCache.size,
        minSimilarity
      }
    };
  }

  /**
   * Fallback keyword search (exact COSMO algorithm)
   * Used when embeddings unavailable or API fails
   */
  keywordSearch(nodes, query, options = {}) {
    const { limit = 20, minSimilarity = 0.1 } = options;
    const startTime = Date.now();

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    if (queryWords.length === 0) {
      return {
        results: [],
        stats: { method: 'keyword', took: 0, total: 0 }
      };
    }

    const scored = nodes.map(node => {
      const text = (node.concept || '').toLowerCase();
      const tag = (node.tag || '').toLowerCase();
      
      let matches = 0;
      let exactMatch = false;

      // Check for exact phrase match (high score)
      if (text.includes(query.toLowerCase())) {
        exactMatch = true;
        matches = queryWords.length * 2;
      } else {
        // Count word matches
        for (const word of queryWords) {
          if (text.includes(word)) matches++;
          if (tag.includes(word)) matches += 0.5; // Tag match bonus
        }
      }

      const similarity = exactMatch ? 1.0 : matches / (queryWords.length * 2);

      return {
        id: node.id,
        concept: node.concept,
        tag: node.tag,
        weight: node.weight,
        activation: node.activation,
        cluster: node.cluster,
        similarity,
        score: similarity
      };
    })
    .filter(node => node.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

    const took = Date.now() - startTime;

    console.log(`[SEMANTIC SEARCH] Keyword search: ${scored.length} results (${took}ms)`);

    return {
      results: scored,
      stats: {
        method: 'keyword',
        took,
        total: nodes.length,
        indexed: 0,
        minSimilarity
      }
    };
  }

  /**
   * Cosine similarity (exact COSMO algorithm)
   * Used for comparing query embedding with node embeddings
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) {
      return 0;
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  /**
   * Get connected nodes for a given node (for RAG context expansion)
   * Returns nodes connected via edges, sorted by edge weight
   */
  getConnectedNodes(nodeId, limit = 30) {
    const state = this.brainLoader.state;
    const edges = state?.memory?.edges || [];
    const nodes = state?.memory?.nodes || [];

    // Find edges connected to this node
    const connectedEdges = edges.filter(edge => 
      String(edge.source) === String(nodeId) || String(edge.target) === String(nodeId)
    );

    // Get connected node IDs
    const connectedNodeIds = connectedEdges.map(edge => {
      const connectedId = String(edge.source) === String(nodeId) ? edge.target : edge.source;
      return {
        nodeId: connectedId,
        weight: edge.weight || 0.5
      };
    });

    // Sort by edge weight and get top N
    const topConnected = connectedNodeIds
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    // Fetch full node objects
    const connectedNodes = topConnected
      .map(({ nodeId, weight }) => {
        const node = nodes.find(n => String(n.id) === String(nodeId));
        if (!node) return null;
        return {
          ...node,
          connectionWeight: weight
        };
      })
      .filter(n => n !== null);

    return connectedNodes;
  }

  /**
   * Get index statistics
   */
  getStats() {
    const nodes = this.getMemoryNodes();
    return {
      totalNodes: nodes.length,
      indexed: this.embeddingsCache.size,
      percentIndexed: nodes.length > 0 ? Math.round((this.embeddingsCache.size / nodes.length) * 100) : 0,
      isIndexed: this.isIndexed,
      lastIndexTime: this.lastIndexTime,
      tags: this.getTagDistribution()
    };
  }

  /**
   * Get tag distribution for filtering UI
   */
  getTagDistribution() {
    const nodes = this.getMemoryNodes();
    const tagCounts = new Map();

    for (const node of nodes) {
      const tag = node.tag || 'unknown';
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }

    return Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Invalidate cache and force re-indexing
   * (useful if brain state changes)
   */
  invalidateIndex() {
    this.embeddingsCache.clear();
    this.isIndexed = false;
    this.lastIndexTime = 0;
    console.log('[SEMANTIC SEARCH] Index invalidated');
  }
}

module.exports = BrainSemanticSearch;

