const { getOpenAIClient } = require('../core/openai-client');
const { ExtractiveSummarizer } = require('../utils/extractive-summarizer');
const { classifyContent } = require('../core/validation');

// Real-time event streaming - fallback singleton for CLI mode
let _singletonEvents = null;
function getSingletonEvents() {
  if (!_singletonEvents) {
    _singletonEvents = require('../realtime/event-emitter').cosmoEvents;
  }
  return _singletonEvents;
}

/**
 * Network Memory Graph
 * Implements spreading activation, Hebbian learning, and small-world topology
 * From: "Network Theory and Emergent Idea Graphs" section
 * 
 * TEMPORAL ENHANCEMENT: Semantic edge types for causal/relationship modeling
 */
class NetworkMemory {
  // TEMPORAL: Semantic edge type constants
  // Enables Graph-RAG (relationship-based) vs Vector-RAG (similarity-based)
  static EDGE_TYPES = {
    // Generic relationships
    ASSOCIATIVE: 'associative',      // Generic association (default)
    BRIDGE: 'bridge',                // Cross-cluster connection
    
    // Causal relationships (from feedback)
    TRIGGERED_BY: 'triggered_by',    // User prompt → tool call, Goal → agent spawn
    CAUSED_BY: 'caused_by',          // Effect → cause, Failure → root cause
    RESOLVED_BY: 'resolved_by',      // Failure → resolution
    
    // Semantic relationships
    CONTRADICTS: 'contradicts',      // Failed hypothesis → counter-evidence
    VALIDATES: 'validates',          // Evidence → claim
    REFINES: 'refines',              // Attempt N+1 → attempt N
    SYNTHESIZES: 'synthesizes',      // Synthesis → source materials
    
    // Temporal relationships
    SUPERSEDES: 'supersedes',        // New version → old version
    DEPENDS_ON: 'depends_on',        // Task → prerequisite task
    EXECUTED_BY: 'executed_by',      // Task → agent
    PRODUCED: 'produced'             // Agent → deliverable
  };
  
  constructor(config, logger, eventEmitter = null) {
    this.config = config;
    this.logger = logger;
    this.events = eventEmitter;  // Multi-tenant event emitter

    // Initialize extractive summarizer for memory compression
    this.extractiveSummarizer = new ExtractiveSummarizer(logger);
    
    // Network components
    this.nodes = new Map(); // id -> {concept, embedding, activation, cluster, created, accessed}
    this.edges = new Map(); // "nodeA->nodeB" -> {weight, type, created, accessed}
    this.clusters = new Map(); // clusterId -> Set of node IDs
    this.activations = new Map(); // Current activation levels
    
    this.nextNodeId = 1;
    this.nextClusterId = 1;
    this.nodeIdFormat = 'numeric'; // 'numeric' or 'string' - detected from loaded state
    this.nodeIdPrefix = null; // For string IDs (e.g., "fa7572")
    
    // Initialize tokenizer for token-aware truncation
    try {
      const { encoding_for_model } = require('tiktoken');
      this.tokenizer = encoding_for_model('text-embedding-3-small');
      this.logger?.info?.('Tokenizer initialized for text-embedding-3-small');
    } catch (error) {
      this.logger?.warn?.('Failed to initialize tokenizer, falling back to character-based truncation', {
        error: error.message
      });
      this.tokenizer = null;
    }
  }

  /**
   * Get the event emitter for this memory context.
   */
  _getEvents() {
    if (this.events) return this.events;
    return getSingletonEvents();
  }

  /**
   * Generate embedding using OpenAI
   * @param {string} text - Text to embed
   * Note: All embeddings use same dimensions (512) for network consistency
   */
  async embed(text) {
    try {
      // Token-aware truncation (8191 token limit for text-embedding-3-small)
      // Use 8000 tokens for safety margin (API can be strict with boundaries)
      if (this.tokenizer) {
        const tokens = this.tokenizer.encode(text);
        const maxTokens = 8000; // Safety margin below 8191 limit
        
        if (tokens.length > maxTokens) {
          this.logger?.warn?.('Text exceeds token limit, truncating', {
            originalTokens: tokens.length,
            truncatedTo: maxTokens,
            textPreview: text.substring(0, 100) + '...'
          });
          
          // Decode truncated tokens back to text
          text = this.tokenizer.decode(tokens.slice(0, maxTokens));
        }
      } else {
        // Fallback to character-based truncation if tokenizer unavailable
        // Use 25000 chars (~6250 tokens avg) for safety
        if (text.length > 25000) {
          this.logger?.warn?.('Text exceeds character limit, truncating (tokenizer unavailable)', {
            originalLength: text.length,
            truncatedTo: 25000
          });
          text = text.substring(0, 25000);
        }
      }
      
      const client = getOpenAIClient();
      
      // Get dimension size from config (support both number and object format)
      let dims = this.config.embedding.dimensions;
      if (typeof dims === 'object') {
        // Legacy support for old multi-dimension config
        dims = dims.default || 512;
      }
      
      const response = await client.embeddings.create({
        model: this.config.embedding.model,
        input: text,
        encoding_format: 'float',
        dimensions: dims
      });

      if (!response?.data?.[0]?.embedding) {
        this.logger?.error?.('Embedding API returned invalid response', {
          hasResponse: Boolean(response),
          hasData: Boolean(response?.data),
          dataLength: response?.data?.length,
          hasEmbedding: Boolean(response?.data?.[0]?.embedding)
        });
        return null;
      }

      return response.data[0].embedding;
    } catch (error) {
      // If embedding fails even after truncation, try extractive summary as last resort
      if (text.length > 5000 && this.extractiveSummarizer) {
        this.logger?.warn?.('Embedding failed, trying extractive summary', { 
          error: error.message,
          textLength: text.length
        });
        
        try {
          const extracted = this.extractiveSummarizer.summarize(text);
          if (extracted.quality >= 0.5) {
            // Retry embedding with much shorter summary (recursive call with safety)
            const summaryText = extracted.summary;
            if (summaryText.length < text.length) {
              return await this.embed(summaryText);
            }
          }
        } catch (summaryError) {
          this.logger?.error?.('Extractive summarization also failed', { 
            error: summaryError.message 
          });
        }
      }
      
      this.logger?.error?.('Embedding API call failed', {
        error: error.message,
        textLength: text?.length
      });
      return null;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   * OpenAI allows up to 2048 inputs per call
   * @param {Array<string>} texts - Array of texts to embed
   * @returns {Array} Array of embeddings (same order as input)
   */
  async embedBatch(texts) {
    if (!texts || texts.length === 0) return [];
    
    const batchSize = 2048; // OpenAI's max batch size
    const allEmbeddings = [];
    
    // Get dimension size from config (support both number and object format)
    let dims = this.config.embedding.dimensions;
    if (typeof dims === 'object') {
      dims = dims.default || 512;
    }
    
    // Process in batches of 2048
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      
      // Token-aware truncation for each text in batch
      const processedBatch = batch.map(text => {
        if (this.tokenizer) {
          const tokens = this.tokenizer.encode(text);
          const maxTokens = 8191;
          if (tokens.length > maxTokens) {
            return this.tokenizer.decode(tokens.slice(0, maxTokens));
          }
        } else if (text.length > 30000) {
          return text.substring(0, 30000);
        }
        return text;
      });
      
      try {
        const client = getOpenAIClient();
        const response = await client.embeddings.create({
          model: this.config.embedding.model,
          input: processedBatch,  // Array of strings
          encoding_format: 'float',
          dimensions: dims
        });
        
        // Sort by index to ensure order matches input
        const embeddings = response.data
          .sort((a, b) => a.index - b.index)
          .map(d => d.embedding);
        
        allEmbeddings.push(...embeddings);
        
        this.logger?.debug?.('Batch embeddings generated', {
          batchSize: batch.length,
          totalSoFar: allEmbeddings.length,
          totalRequested: texts.length,
          precision
        });
        
      } catch (error) {
        this.logger?.error?.('Batch embedding failed, falling back to individual calls', {
          error: error.message,
          batchSize: batch.length
        });
        
        // Fallback to individual calls for this batch
        for (const text of batch) {
          const emb = await this.embed(text);
          allEmbeddings.push(emb);
        }
      }
    }
    
    return allEmbeddings;
  }

  /**
   * Regenerate missing embeddings for all nodes
   * Useful for fixing corrupted state or migrating to new dimensions
   */
  async regenerateMissingEmbeddings() {
    const nodes = Array.from(this.nodes.values());
    const nodesToEmbed = nodes.filter(n => !n.embedding);
    
    if (nodesToEmbed.length === 0) {
      this.logger?.info?.('All nodes have embeddings');
      return { regenerated: 0, total: nodes.length };
    }
    
    this.logger?.info?.('Regenerating missing embeddings in batch', {
      missing: nodesToEmbed.length,
      total: nodes.length
    });
    
    // Extract concepts
    const concepts = nodesToEmbed.map(n => n.concept);
    
    // Use batch generation (all same dimensions)
    const embeddings = await this.embedBatch(concepts);
    
    // Assign back to nodes
    let successCount = 0;
    nodesToEmbed.forEach((node, i) => {
      if (embeddings[i]) {
        node.embedding = embeddings[i];
        successCount++;
      }
    });
    
    this.logger?.info?.('Missing embeddings regenerated', {
      attempted: nodesToEmbed.length,
      successful: successCount,
      failed: nodesToEmbed.length - successCount
    });
    
    return { regenerated: successCount, total: nodes.length };
  }

  /**
   * Add new concept node
   */
  async addNode(concept, tag = 'general', embedding = null) {
    // Quality gate (defense-in-depth): filter before expensive embedding
    // Only check when no pre-computed embedding (pre-embedded = intentional)
    if (!embedding) {
      const classification = classifyContent(concept, tag);
      if (classification.category === 'operational' || classification.category === 'garbage') {
        this.logger?.debug?.('Node rejected by quality gate', {
          tag,
          category: classification.category,
          reason: classification.reason,
          preview: concept.substring(0, 80)
        });
        return null;
      }
    }

    // All nodes use same dimensions for network consistency
    const embed = embedding || await this.embed(concept);

    // Skip adding nodes with null embeddings
    if (!embed) {
      this.logger?.warn?.('Skipping node with null embedding', {
        concept: concept.substring(0, 100),
        tag
      });
      return null;
    }

    // Generate extractive summary if enabled
    let summary = null;
    let keyPhrase = null;
    
    if (this.config.coordinator?.useMemorySummaries && 
        this.config.coordinator?.extractiveSummarization) {
      try {
        const extracted = this.extractiveSummarizer.summarize(concept);
        if (extracted.quality >= 0.6) {
          summary = extracted.summary;
          keyPhrase = extracted.keyPhrase;
        }
      } catch (error) {
        this.logger?.debug?.('Extractive summarization failed, using full concept', {
          error: error.message
        });
      }
    }

    // CRITICAL FIX: Generate ID in same format as existing nodes (string vs numeric)
    let nodeId;
    if (this.nodeIdFormat === 'string' && this.nodeIdPrefix) {
      nodeId = `${this.nodeIdPrefix}_${this.nextNodeId++}`;
    } else {
      nodeId = this.nextNodeId++;
    }
    
    const node = {
      id: nodeId,
      concept,
      summary,      // Compressed version for prompts
      keyPhrase,    // Ultra-compressed for quick reference
      tag,
      embedding: embed,
      activation: 0,
      cluster: null,
      weight: 1.0,
      created: new Date(),
      accessed: new Date(),
      accessCount: 0
    };

    this.nodes.set(node.id, node);

    // Auto-form connections with similar nodes (Hebbian-like)
    await this.formInitialConnections(node.id);
    
    // Assign to cluster
    this.assignToCluster(node.id);
    
    this.logger?.debug('Node added to network', { 
      id: node.id, 
      concept: concept.substring(0, 50),
      cluster: node.cluster 
    });
    
    return node;
  }

  /**
   * Form initial connections based on similarity
   */
  async formInitialConnections(nodeId) {
    const node = this.nodes.get(nodeId);
    const similarities = [];
    
    // Find similar nodes
    for (const [id, otherNode] of this.nodes) {
      if (id === nodeId) continue;

      // Skip nodes with null embeddings
      if (!node.embedding || !otherNode.embedding) {
        this.logger?.debug?.('Skipping similarity check for node with null embedding', {
          nodeId: id,
          hasNodeEmbedding: Boolean(node.embedding),
          hasOtherEmbedding: Boolean(otherNode.embedding)
        });
        continue;
      }

      const similarity = this.cosineSimilarity(node.embedding, otherNode.embedding);
      if (similarity > 0.5) {
        similarities.push({ id, similarity });
      }
    }
    
    // Connect to top 3 most similar
    similarities.sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .forEach(({ id, similarity }) => {
        this.addEdge(nodeId, id, similarity * 0.5);
      });
  }

  /**
   * TEMPORAL: Infer semantic edge type from tags and context
   * Enables causal/relationship modeling instead of just "associative"
   * 
   * @param {Object} nodeA - First node object (with tag property)
   * @param {Object} nodeB - Second node object (with tag property)
   * @param {Object} context - Optional context { relationship, cause, temporal }
   * @returns {string} Semantic edge type
   */
  inferEdgeType(nodeA, nodeB, context = {}) {
    // Explicit relationship provided
    if (context.relationship) {
      return context.relationship;
    }
    
    const tagA = nodeA?.tag || '';
    const tagB = nodeB?.tag || '';
    
    // Causal relationships
    if (tagA === 'agent_failure' && tagB === 'root_cause') {
      return NetworkMemory.EDGE_TYPES.CAUSED_BY;
    }
    
    if (tagA === 'agent_success' && tagB.includes('failure')) {
      return NetworkMemory.EDGE_TYPES.RESOLVED_BY;
    }
    
    // Execution relationships
    if (tagA.includes('task') && tagB.includes('agent')) {
      return NetworkMemory.EDGE_TYPES.EXECUTED_BY;
    }
    
    if (tagA.includes('agent') && tagB.includes('deliverable')) {
      return NetworkMemory.EDGE_TYPES.PRODUCED;
    }
    
    // Synthesis relationships
    if (tagA === 'synthesis' || tagA === 'consolidated') {
      return NetworkMemory.EDGE_TYPES.SYNTHESIZES;
    }
    
    // Refinement relationships (temporal sequence)
    if (context.temporal && context.temporal === 'refinement') {
      return NetworkMemory.EDGE_TYPES.REFINES;
    }
    
    // Supersession (newer replaces older)
    if (context.temporal && context.temporal === 'supersedes') {
      return NetworkMemory.EDGE_TYPES.SUPERSEDES;
    }
    
    // Dependencies
    if (context.dependency) {
      return NetworkMemory.EDGE_TYPES.DEPENDS_ON;
    }
    
    // Default: associative
    return NetworkMemory.EDGE_TYPES.ASSOCIATIVE;
  }

  /**
   * Add/reinforce edge between nodes (Hebbian learning)
   * FIXED: Now handles both numeric and string IDs (for merged runs)
   * TEMPORAL: Accepts semantic edge types for causal/relationship modeling
   */
  addEdge(nodeA, nodeB, weight = 0.1, type = 'associative') {
    // CRITICAL FIX: Prevent self-loops (they cause exponential accumulation)
    if (nodeA === nodeB) {
      this.logger?.debug?.('Skipping self-loop edge', { nodeId: nodeA });
      return;
    }
    
    // CRITICAL FIX: Use string comparison for sorting (works with both numeric and string IDs)
    const sortedPair = [nodeA, nodeB].sort((a, b) => {
      const strA = String(a);
      const strB = String(b);
      return strA.localeCompare(strB);
    });
    const edgeKey = sortedPair.join('->');
    const existing = this.edges.get(edgeKey);
    
    if (existing) {
      // Reinforce: "neurons that fire together, wire together"
      existing.weight = Math.min(1.0, existing.weight + weight);
      existing.accessed = new Date();
      // Update type if explicitly specified and different
      if (type !== 'associative' && existing.type !== type) {
        existing.type = type;
      }
    } else {
      // CRITICAL FIX: Store explicit source/target (not just key)
      // Required for proper JSON serialization with string IDs
      this.edges.set(edgeKey, {
        source: sortedPair[0],
        target: sortedPair[1],
        weight,
        type,
        created: new Date(),
        accessed: new Date()
      });
    }
  }

  /**
   * Remove a node and all its edges from the graph.
   * Used by document feeder to replace stale chunks on re-ingestion.
   */
  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) return;

    // Remove all edges touching this node
    for (const [key] of this.edges) {
      const [src, tgt] = key.split('->');
      if (String(src) === String(nodeId) || String(tgt) === String(nodeId)) {
        this.edges.delete(key);
      }
    }

    // Remove from cluster membership (clusters are Map<id, Set<nodeId>>)
    for (const [, clusterSet] of this.clusters) {
      clusterSet.delete(nodeId);
    }

    this.nodes.delete(nodeId);
  }

  /**
   * Spreading activation from seed node
   * From: "Spreading Activation and Associative Recall" section
   */
  async spreadActivation(seedNodeId, maxDepth = null) {
    const depth = maxDepth || this.config.spreading.maxDepth;
    const threshold = this.config.spreading.activationThreshold;
    const decay = this.config.spreading.decayFactor;
    
    const activated = new Map();
    const queue = [{ nodeId: seedNodeId, activation: 1.0, depth: 0 }];
    
    while (queue.length > 0) {
      const { nodeId, activation, depth: currentDepth } = queue.shift();
      
      if (currentDepth > depth || activation < threshold) continue;
      
      // Mark as activated
      activated.set(nodeId, Math.max(activated.get(nodeId) || 0, activation));
      
      // Spread to neighbors
      for (const neighborId of this.getNeighbors(nodeId)) {
        const edge = this.getEdge(nodeId, neighborId);
        
        // Safety check: skip if edge not found (shouldn't happen with proper loading)
        if (!edge) {
          this.logger?.warn?.('Edge not found during spreading activation', {
            from: nodeId,
            to: neighborId
          });
          continue;
        }
        
        const newActivation = activation * edge.weight * decay;
        
        if (newActivation >= threshold) {
          queue.push({ 
            nodeId: neighborId, 
            activation: newActivation, 
            depth: currentDepth + 1 
          });
        }
      }
    }
    
    // Update activation levels
    for (const [nodeId, level] of activated) {
      const node = this.nodes.get(nodeId);
      if (node) node.activation = level;
    }
    
    this.logger?.debug('Spreading activation', {
      seed: seedNodeId,
      activated: activated.size,
      maxLevel: Math.max(...activated.values())
    });
    
    return activated;
  }

  /**
   * Get neighbors of a node
   * FIXED: Handles both numeric and string IDs
   */
  getNeighbors(nodeId) {
    const neighbors = [];
    
    for (const [edgeKey, edge] of this.edges) {
      // CRITICAL FIX: Use explicit source/target if available (for string IDs)
      // Fall back to parsing key for backward compatibility with old edges
      let a, b;
      if (edge.source !== undefined && edge.target !== undefined) {
        a = edge.source;
        b = edge.target;
      } else {
        // Legacy: parse from key (try to preserve type - numeric or string)
        const parts = edgeKey.split('->');
        a = isNaN(parts[0]) ? parts[0] : Number(parts[0]);
        b = isNaN(parts[1]) ? parts[1] : Number(parts[1]);
      }
      
      // Use loose equality to handle numeric vs string comparison
      if (a == nodeId) {
        // CRITICAL FIX: Only return neighbors that actually exist
        if (this.nodes.has(b)) {
          neighbors.push(b);
        }
      }
      if (b == nodeId) {
        // CRITICAL FIX: Only return neighbors that actually exist
        if (this.nodes.has(a)) {
          neighbors.push(a);
        }
      }
    }
    
    return neighbors;
  }

  /**
   * Get edge between two nodes
   * FIXED: Handles both numeric and string IDs
   */
  getEdge(nodeA, nodeB) {
    // CRITICAL FIX: Use string comparison for sorting (works with both types)
    const edgeKey = [nodeA, nodeB].sort((a, b) => {
      const strA = String(a);
      const strB = String(b);
      return strA.localeCompare(strB);
    }).join('->');
    return this.edges.get(edgeKey);
  }

  /**
   * Check if edge exists between two nodes
   * FIXED: Handles both numeric and string IDs
   */
  hasEdge(nodeA, nodeB) {
    // CRITICAL FIX: Use string comparison for sorting
    const edgeKey = [nodeA, nodeB].sort((a, b) => {
      const strA = String(a);
      const strB = String(b);
      return strA.localeCompare(strB);
    }).join('->');
    return this.edges.has(edgeKey);
  }

  /**
   * Remove edge between two nodes
   * FIXED: Handles both numeric and string IDs
   */
  removeEdge(nodeA, nodeB) {
    // CRITICAL FIX: Use string comparison for sorting
    const edgeKey = [nodeA, nodeB].sort((a, b) => {
      const strA = String(a);
      const strB = String(b);
      return strA.localeCompare(strB);
    }).join('->');
    const existed = this.edges.has(edgeKey);
    this.edges.delete(edgeKey);
    return existed;
  }

  /**
   * Query with spreading activation
   */
  async query(queryText, topK = 5, options = {}) {
    if (this.nodes.size === 0) return [];
    
    // Ensure queryText is a string
    if (!queryText || typeof queryText !== 'string') {
      this.logger?.warn?.('Invalid query text', {
        type: typeof queryText,
        value: queryText
      });
      return [];
    }
    
    const queryEmbedding = await this.embed(queryText);
    
    // If embedding failed, return empty results
    if (!queryEmbedding) {
      this.logger?.warn?.('Query embedding failed, returning empty results', {
        queryText: queryText?.substring(0, 100)
      });
      return [];
    }
    
    // TEMPORAL: Extract options
    const useTemporalWeighting = options.temporalWeighting !== false; // Default ON
    const halfLifeDays = options.halfLifeDays || 7; // 7-day default
    const temporalBlend = options.temporalBlend || 0.3; // 30% recency, 70% similarity
    
    // Find best matching node
    let bestMatch = null;
    let bestSimilarity = 0;
    
    for (const [id, node] of this.nodes) {
      // Skip nodes with null embeddings
      if (!node.embedding) {
        this.logger?.debug?.('Skipping node with null embedding during query', { nodeId: id });
        continue;
      }

      const similarity = this.cosineSimilarity(queryEmbedding, node.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = id;
      }
    }
    
    if (!bestMatch) return [];
    
    // Spread activation from best match
    const activated = await this.spreadActivation(bestMatch);
    
    // TEMPORAL: Apply temporal weighting to activated nodes
    const now = Date.now();
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    
    const results = Array.from(activated.entries())
      .map(([id, activation]) => {
        const node = this.nodes.get(id);
        
        // Calculate temporal weight (half-life decay)
        let temporalWeight = 1.0;
        if (useTemporalWeighting && node.created) {
          const createdTime = node.created instanceof Date ? node.created.getTime() : node.created;
          const age = now - createdTime;
          temporalWeight = Math.pow(0.5, age / halfLifeMs);
        }
        
        // Blend activation with temporal weight
        const effectiveActivation = useTemporalWeighting
          ? activation * (1 - temporalBlend) + activation * temporalWeight * temporalBlend
          : activation;
        
        return {
          ...node,
          similarity: id === bestMatch ? bestSimilarity : activation,
          activation,
          temporalWeight: useTemporalWeighting ? temporalWeight : null,
          effectiveActivation
        };
      })
      .sort((a, b) => b.effectiveActivation - a.effectiveActivation)
      .slice(0, topK);
    
    // Mark as accessed and boost weight
    results.forEach(node => {
      node.accessed = new Date();
      node.accessCount++;
      node.weight = Math.min(1.0, node.weight + 0.1);
    });
    
    return results;
  }

  /**
   * TEMPORAL: Query by graph traversal (Graph-RAG)
   * Finds nodes by relationship type, not just similarity
   * 
   * @param {string|number} startNodeId - Starting node ID
   * @param {string} edgeType - Edge type to traverse (from EDGE_TYPES)
   * @param {number} maxDepth - Maximum traversal depth
   * @returns {Array} Nodes connected by specified relationship
   */
  async queryByRelationship(startNodeId, edgeType, maxDepth = 3) {
    if (!this.nodes.has(startNodeId)) {
      return [];
    }
    
    const results = [];
    const visited = new Set();
    const queue = [{ nodeId: startNodeId, depth: 0 }];
    
    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift();
      
      if (depth >= maxDepth || visited.has(nodeId)) continue;
      visited.add(nodeId);
      
      // Find edges of specified type from this node
      for (const [edgeKey, edge] of this.edges) {
        if (edge.type !== edgeType) continue;
        
        // Check if edge involves current node
        const [sourceId, targetId] = edgeKey.split('->');
        let nextNodeId = null;
        
        if (String(sourceId) === String(nodeId)) {
          nextNodeId = targetId;
        } else if (String(targetId) === String(nodeId)) {
          nextNodeId = sourceId;
        }
        
        if (nextNodeId && !visited.has(nextNodeId)) {
          const nextNode = this.nodes.get(nextNodeId);
          if (nextNode) {
            results.push({
              ...nextNode,
              relationshipType: edgeType,
              distance: depth + 1,
              edgeWeight: edge.weight
            });
            
            if (depth + 1 < maxDepth) {
              queue.push({ nodeId: nextNodeId, depth: depth + 1 });
            }
          }
        }
      }
    }
    
    return results;
  }
  
  /**
   * TEMPORAL: Find isolated nodes ("islands" in the graph)
   * These are nodes with few or no connections
   * 
   * @param {number} maxConnections - Nodes with <= this many connections are "islands"
   * @returns {Array} Island nodes that could be connected to mainland
   */
  async findIslands(maxConnections = 2) {
    const islands = [];
    
    for (const [nodeId, node] of this.nodes) {
      const connections = this.getNeighbors(nodeId);
      
      if (connections.length <= maxConnections) {
        islands.push({
          ...node,
          connectionCount: connections.length,
          connections: connections.map(id => ({
            id,
            concept: this.nodes.get(id)?.concept?.substring(0, 50)
          }))
        });
      }
    }
    
    // Sort by age (older islands first - more fossilized)
    islands.sort((a, b) => {
      const ageA = Date.now() - (a.created?.getTime() || 0);
      const ageB = Date.now() - (b.created?.getTime() || 0);
      return ageB - ageA;
    });
    
    return islands;
  }
  
  /**
   * TEMPORAL: Trace causal chain from a node
   * Follows CAUSED_BY and TRIGGERED_BY edges backwards
   * 
   * @param {string|number} nodeId - Starting node (usually a failure or outcome)
   * @param {number} maxDepth - How far back to trace
   * @returns {Array} Causal chain from root causes to outcome
   */
  async traceCausalChain(nodeId, maxDepth = 5) {
    const NetworkMemory = require('./network-memory').NetworkMemory;
    const causalTypes = [
      NetworkMemory.EDGE_TYPES.CAUSED_BY,
      NetworkMemory.EDGE_TYPES.TRIGGERED_BY,
      NetworkMemory.EDGE_TYPES.DEPENDS_ON
    ];
    
    const chain = [];
    const visited = new Set();
    let currentNode = nodeId;
    let depth = 0;
    
    while (depth < maxDepth && !visited.has(currentNode)) {
      visited.add(currentNode);
      const node = this.nodes.get(currentNode);
      
      if (!node) break;
      
      chain.push({
        ...node,
        depthFromOutcome: depth
      });
      
      // Find causal edge leading to this node
      let foundCause = false;
      for (const [edgeKey, edge] of this.edges) {
        if (!causalTypes.includes(edge.type)) continue;
        
        const [sourceId, targetId] = edgeKey.split('->');
        
        // If this node is the target, source is the cause
        if (String(targetId) === String(currentNode)) {
          currentNode = sourceId;
          foundCause = true;
          break;
        }
      }
      
      if (!foundCause) break;
      depth++;
    }
    
    return chain.reverse(); // Return root cause first
  }

  /**
   * Query peripheral (less-activated) nodes for diversity
   */
  async queryPeripheral(queryText, topK = 3) {
    if (this.nodes.size === 0) return [];
    
    const queryEmbedding = await this.embed(queryText);
    if (!queryEmbedding) return [];
    
    // Get all nodes with similarity scores
    const allScored = [];
    for (const [id, node] of this.nodes) {
      if (!node.embedding) continue;
      
      const similarity = this.cosineSimilarity(queryEmbedding, node.embedding);
      allScored.push({
        ...node,
        similarity,
        activation: node.activation || 0
      });
    }
    
    // Sort by LOWEST activation (peripheral nodes)
    // But still somewhat relevant (similarity > 0.2)
    const peripheral = allScored
      .filter(n => n.similarity > 0.2 && n.activation < 0.3)
      .sort((a, b) => a.activation - b.activation) // Lowest activation first
      .slice(0, topK);
    
    // If no peripheral nodes found, fall back to random selection
    if (peripheral.length === 0) {
      const random = allScored
        .filter(n => n.similarity > 0.2)
        .sort(() => Math.random() - 0.5)
        .slice(0, topK);
      return random;
    }
    
    this.logger?.debug?.('Peripheral query executed', {
      found: peripheral.length,
      avgActivation: peripheral.length > 0 
        ? (peripheral.reduce((sum, n) => sum + n.activation, 0) / peripheral.length).toFixed(3)
        : 0
    });
    
    return peripheral;
  }

  /**
   * Hebbian reinforcement when concepts co-occur
   */
  reinforceCooccurrence(nodeIds) {
    if (nodeIds.length < 2) return;
    
    const strength = this.config.hebbian.reinforcementStrength;
    
    // Reinforce all pairwise connections
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        this.addEdge(nodeIds[i], nodeIds[j], strength);
      }
    }
  }

  /**
   * Assign node to cluster (small-world property)
   */
  assignToCluster(nodeId) {
    const node = this.nodes.get(nodeId);
    
    // Find most connected cluster
    const clusterScores = new Map();
    
    for (const neighborId of this.getNeighbors(nodeId)) {
      const neighbor = this.nodes.get(neighborId);
      if (neighbor && neighbor.cluster !== null) {
        clusterScores.set(
          neighbor.cluster,
          (clusterScores.get(neighbor.cluster) || 0) + 1
        );
      }
    }
    
    if (clusterScores.size > 0) {
      // Join most connected cluster
      const bestCluster = Array.from(clusterScores.entries())
        .sort((a, b) => b[1] - a[1])[0][0];

      node.cluster = bestCluster;

      // Ensure cluster exists in clusters Map (it might not if state was corrupted)
      if (!this.clusters.has(bestCluster)) {
        this.logger?.warn?.('Creating missing cluster during assignment', { clusterId: bestCluster });
        this.clusters.set(bestCluster, new Set());
      }

      this.clusters.get(bestCluster).add(nodeId);
    } else {
      // Create new cluster
      const clusterId = this.nextClusterId++;
      node.cluster = clusterId;
      this.clusters.set(clusterId, new Set([nodeId]));
    }
  }

  /**
   * Add random bridge between clusters (small-world)
   */
  addRandomBridge() {
    const clusterIds = Array.from(this.clusters.keys());
    if (clusterIds.length < 2) return;
    
    const clusterA = clusterIds[Math.floor(Math.random() * clusterIds.length)];
    const clusterB = clusterIds[Math.floor(Math.random() * clusterIds.length)];
    
    if (clusterA === clusterB) return;
    
    const nodesA = Array.from(this.clusters.get(clusterA));
    const nodesB = Array.from(this.clusters.get(clusterB));
    
    const nodeA = nodesA[Math.floor(Math.random() * nodesA.length)];
    const nodeB = nodesB[Math.floor(Math.random() * nodesB.length)];
    
    this.addEdge(nodeA, nodeB, 0.3, 'bridge');
    
    this.logger?.debug('Random bridge added', { 
      clusterA, 
      clusterB,
      nodeA,
      nodeB
    });
  }

  /**
   * Network rewiring (topology maintenance)
   */
  async rewire(p = null) {
    // Prune weak edges
    let pruned = 0;
    for (const [edgeKey, edge] of this.edges) {
      if (edge.weight < 0.1) {
        this.edges.delete(edgeKey);
        pruned++;
      }
    }
    
    // Add random bridges (or use Watts-Strogatz if p provided)
    if (p !== null && p !== undefined) {
      // Use Watts-Strogatz rewiring with specified probability
      const rewired = await this.rewireSmallWorld(p);
      this.logger?.info('Watts-Strogatz rewiring', {
        edgesPruned: pruned,
        edgesRewired: rewired,
        rewiringProbability: p,
        totalEdges: this.edges.size,
        totalNodes: this.nodes.size,
        clusters: this.clusters.size
      });

      // Emit dream rewiring event
      this._getEvents().emitDreamRewiring({
        bridgesCreated: rewired,
        edgesPruned: pruned,
        totalNodes: this.nodes.size,
        totalEdges: this.edges.size
      });
    } else {
      // Default: occasional random bridge
      const bridgeProb = this.config.smallWorld.bridgeProbability;
      if (Math.random() < bridgeProb) {
        this.addRandomBridge();
      }
      
      this.logger?.info('Network rewired', {
        edgesPruned: pruned,
        totalEdges: this.edges.size,
        totalNodes: this.nodes.size,
        clusters: this.clusters.size
      });
    }
  }

  /**
   * Watts-Strogatz Small-World Rewiring
   * Implements controllable chaos in memory network topology
   * 
   * @param {number} p - Rewiring probability (0.0 to 1.0)
   *                     Low p (~0.01) = stable network (wake state)
   *                     High p (~0.5+) = chaotic creativity (dream state)
   * @returns {number} Number of edges rewired
   * 
   * From research: "Watts–Strogatz Rewiring in Cosmo's Memory Graph"
   * - Maintains small-world properties (high clustering, short paths)
   * - Creates random long-range shortcuts between clusters
   * - Enables creative associations during dream states
   */
  async rewireSmallWorld(p) {
    if (p <= 0 || this.nodes.size < 3 || this.edges.size === 0) {
      return 0; // Nothing to rewire
    }

    const nodeArray = Array.from(this.nodes.keys());
    let rewired = 0;
    
    // Iterate over copy of edges to avoid concurrent modification
    const edgesToProcess = Array.from(this.edges.entries());
    
    for (const [edgeKey, edge] of edgesToProcess) {
      // Only rewire local/associative edges, skip existing bridges
      if (edge.type === 'bridge') continue;
      
      const [nodeA, nodeB] = edgeKey.split('->').map(Number);
      
      // Skip if nodes are in different clusters (already a cross-cluster link)
      const clusterA = this.nodes.get(nodeA)?.cluster;
      const clusterB = this.nodes.get(nodeB)?.cluster;
      if (clusterA !== clusterB) continue;
      
      // Decide whether to rewire this edge
      if (Math.random() < p) {
        // Remove the current edge
        this.removeEdge(nodeA, nodeB);
        
        // Find a new target node C for A to connect to
        // Requirements: C != A, no existing edge A-C, preferably different cluster
        let nodeC = null;
        let attempts = 0;
        const maxAttempts = Math.min(50, nodeArray.length * 2);
        
        while (attempts < maxAttempts) {
          const candidateC = nodeArray[Math.floor(Math.random() * nodeArray.length)];
          
          // Check validity
          if (candidateC === nodeA) {
            attempts++;
            continue;
          }
          
          if (this.hasEdge(nodeA, candidateC)) {
            attempts++;
            continue;
          }
          
          // Prefer different cluster (but allow same cluster if necessary)
          const clusterC = this.nodes.get(candidateC)?.cluster;
          if (clusterC !== clusterA || attempts > maxAttempts / 2) {
            nodeC = candidateC;
            break;
          }
          
          attempts++;
        }
        
        // If we found a valid target, create the new bridge
        if (nodeC !== null) {
          const newWeight = Math.min(0.3, edge.weight); // Moderate weight for new connections
          this.addEdge(nodeA, nodeC, newWeight, 'bridge');
          rewired++;
          
          this.logger?.debug?.('Edge rewired (Watts-Strogatz)', {
            from: `${nodeA}-${nodeB}`,
            to: `${nodeA}-${nodeC}`,
            oldCluster: clusterB,
            newCluster: this.nodes.get(nodeC)?.cluster
          });
        } else {
          // Couldn't find valid target, restore original edge
          this.addEdge(nodeA, nodeB, edge.weight, edge.type);
        }
      }
    }
    
    return rewired;
  }

  /**
   * Apply decay to unused nodes
   */
  applyDecay() {
    const now = new Date();
    const factor = this.config.decay.baseFactor;
    const minWeight = this.config.decay.minimumWeight;
    const decayInterval = this.config.decay.decayInterval || 300;
    const exemptTags = this.config.decay.exemptTags || [];
    
    for (const [id, node] of this.nodes) {
      // Skip decay for protected tags
      if (exemptTags.includes(node.tag)) {
        continue;
      }
      
      const age = (now - node.accessed) / 1000; // seconds
      
      if (age > decayInterval) {
        node.weight *= factor;
      }
    }
    
    // Also decay edges
    if (this.config.hebbian.enabled) {
      for (const [key, edge] of this.edges) {
        const age = (now - edge.accessed) / 1000;
        if (age > decayInterval * 2) { // Edges decay slower
          edge.weight *= this.config.hebbian.weakenFactor;
        }
      }
    }
  }

  /**
   * Cosine similarity helper
   */
  cosineSimilarity(a, b) {
    // Handle undefined inputs gracefully
    if (!a || !b || !Array.isArray(a) || !Array.isArray(b)) {
      this.logger?.warn?.('Cosine similarity called with invalid inputs', {
        a: typeof a,
        b: typeof b,
        aIsArray: Array.isArray(a),
        bIsArray: Array.isArray(b)
      });
      return 0;
    }

    if (a.length !== b.length) {
      this.logger?.warn?.('Cosine similarity: mismatched array lengths', {
        aLength: a.length,
        bLength: b.length
      });
      return 0;
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Get network statistics
   */
  getStats() {
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      clusters: this.clusters.size,
      averageWeight: Array.from(this.nodes.values())
        .reduce((sum, n) => sum + n.weight, 0) / this.nodes.size || 0,
      activeNodes: Array.from(this.nodes.values())
        .filter(n => n.weight >= this.config.decay.minimumWeight).length,
      averageDegree: (this.edges.size * 2) / this.nodes.size || 0
    };
  }

  /**
   * Export network for visualization
   * FIXED: Properly handles both numeric and string IDs
   */
  exportGraph() {
    return {
      nodes: Array.from(this.nodes.values()).map(n => ({
        id: n.id,
        concept: n.concept,
        tag: n.tag,
        embedding: n.embedding, // CRITICAL: Include embeddings for memory persistence
        weight: n.weight,
        activation: n.activation,
        cluster: n.cluster,
        accessCount: n.accessCount,
        created: n.created,
        accessed: n.accessed,
        consolidatedAt: n.consolidatedAt  // Track consolidation status for fork/merge optimization
      })),
      edges: Array.from(this.edges.entries()).map(([key, edge]) => {
        // CRITICAL FIX: Use explicit source/target from edge object (supports string IDs)
        // Fall back to parsing key for backward compatibility with old states
        let source, target;
        if (edge.source !== undefined && edge.target !== undefined) {
          source = edge.source;
          target = edge.target;
        } else {
          // Legacy: parse from key and preserve type (numeric or string)
          const parts = key.split('->');
          source = isNaN(parts[0]) ? parts[0] : Number(parts[0]);
          target = isNaN(parts[1]) ? parts[1] : Number(parts[1]);
        }
        return {
          source,
          target,
          weight: edge.weight,
          type: edge.type,
          created: edge.created,
          accessed: edge.accessed
        };
      }),
      clusters: Array.from(this.clusters.entries()).map(([id, nodes]) => ({
        id,
        size: nodes.size,
        nodes: Array.from(nodes)
      })),
      nextNodeId: this.nextNodeId,
      nextClusterId: this.nextClusterId
    };
  }

  /**
   * Save network state
   */
  async save(filepath) {
    const state = {
      nodes: Array.from(this.nodes.entries()),
      edges: Array.from(this.edges.entries()),
      clusters: Array.from(this.clusters.entries()).map(([id, nodes]) => [id, Array.from(nodes)]),
      nextNodeId: this.nextNodeId,
      nextClusterId: this.nextClusterId
    };
    
    await fs.promises.writeFile(filepath, JSON.stringify(state, null, 2));
    this.logger?.info('Network saved', { filepath, nodes: this.nodes.size });
  }

  /**
   * Load network state
   */
  async load(filepath) {
    try {
      const data = JSON.parse(await fs.promises.readFile(filepath, 'utf8'));
      
      this.nodes = new Map(data.nodes);
      this.edges = new Map(data.edges);
      this.clusters = new Map(data.clusters.map(([id, nodes]) => [id, new Set(nodes)]));
      this.nextNodeId = data.nextNodeId;
      this.nextClusterId = data.nextClusterId;
      
      this.logger?.info('Network loaded', { filepath, nodes: this.nodes.size });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.logger?.info('No existing network file, starting fresh');
    }
  }
}

module.exports = { NetworkMemory };

