const { getOpenAIClient } = require('../core/openai-client');
const fs = require('node:fs');
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

function clonePersistenceValue(value, seen = new Set(), arrayElement = false) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('persistence_record_bigint_not_allowed');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return arrayElement ? null : undefined;
  }
  if (value instanceof Date) return Date.prototype.toISOString.call(value);
  if (ArrayBuffer.isView(value)) {
    const clone = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      clone[index] = clonePersistenceValue(value[index], seen, true);
    }
    return clone;
  }
  if (seen.has(value)) throw new TypeError('persistence_record_cycle_not_allowed');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError('persistence_record_plain_json_required');
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('persistence_record_plain_json_required');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) continue;
        if (descriptor.get || descriptor.set) throw new TypeError('persistence_record_accessor_not_allowed');
        clone[index] = clonePersistenceValue(descriptor.value, seen, true);
      }
      return clone;
    }
    const clone = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable) throw new TypeError('persistence_record_symbol_key_not_allowed');
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (descriptor.get || descriptor.set) throw new TypeError('persistence_record_accessor_not_allowed');
      const child = clonePersistenceValue(descriptor.value, seen, false);
      if (child !== undefined) {
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: child,
        });
      }
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

function persistenceValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(clonePersistenceValue(left)) === JSON.stringify(clonePersistenceValue(right));
  } catch {
    return false;
  }
}

function isThenableWithoutInvocation(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let cursor = value;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'then');
    if (descriptor) return Boolean(descriptor.get || descriptor.set || typeof descriptor.value === 'function');
    cursor = Object.getPrototypeOf(cursor);
  }
  return false;
}

function nextSafeIntegerAfter(iterable, current) {
  let next = current;
  for (const value of iterable) {
    if (Number.isSafeInteger(value) && value >= next && value < Number.MAX_SAFE_INTEGER) {
      next = value + 1;
    }
  }
  return next;
}

function deepFreezePersistenceValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezePersistenceValue(child);
  return Object.freeze(value);
}

function serializeEdgePersistenceRecord(edgeKey, edge) {
  const clone = clonePersistenceValue(edge);
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) {
    throw new TypeError('persistence_edge_record_required');
  }
  let source = clone.source;
  let target = clone.target;
  if (source === undefined || target === undefined) {
    const parts = String(edgeKey).split('->');
    source = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
    target = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
  }
  Object.defineProperty(clone, 'source', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: source,
  });
  Object.defineProperty(clone, 'target', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: target,
  });
  return clone;
}

function summarizePersistenceView(nodes, edges) {
  const clusters = new Set(
    nodes
      .map((node) => node.cluster)
      .filter((cluster) => cluster !== null && cluster !== undefined),
  );
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    clusterCount: clusters.size,
  };
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
    PRODUCED: 'produced',            // Agent → deliverable

    // Graph-native artifact loop
    TASK_CONSUMED: 'task_consumed',  // Task → artifact consumed as input
    TASK_PRODUCED: 'task_produced',  // Task → artifact produced as output
    AGENT_PRODUCED: 'agent_produced', // Agent → artifact produced as output
    ARTIFACT_DERIVED_FROM: 'artifact_derived_from',
    ARTIFACT_SUPPORTS: 'artifact_supports',
    ARTIFACT_SUPERSEDES: 'artifact_supersedes',
    ARTIFACT_INVALIDATES: 'artifact_invalidates',
    CLAIM_SUPPORTED_BY: 'claim_supported_by',
    CLAIM_SUPERSEDED_BY: 'claim_superseded_by'
  };
  
  constructor(config, logger, eventEmitter = null, deps = {}) {
    if (eventEmitter && typeof eventEmitter.getEmbeddingClient === 'function'
        && typeof eventEmitter.emit !== 'function' && Object.keys(deps).length === 0) {
      deps = eventEmitter;
      eventEmitter = null;
    }
    this.config = config;
    this.logger = logger;
    this.events = eventEmitter;  // Multi-tenant event emitter
    this.getEmbeddingClient = deps.getEmbeddingClient || getOpenAIClient;

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
    this.persistenceRevision = 0;
    this.persistenceGeneration = 0;
    this.persistenceBarrierActive = false;
    this.dirtyNodeIds = new Set();
    this.dirtyEdgeKeys = new Set();
    this.deletedNodeIds = new Set();
    this.deletedEdgeKeys = new Set();
    
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

  getEmbeddingModel() {
    return process.env.EMBEDDING_MODEL || this.config.embedding?.model || 'nomic-embed-text';
  }

  getEmbeddingDimensions() {
    const envDims = Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10);
    if (Number.isSafeInteger(envDims) && envDims > 0) return envDims;
    let dims = this.config.embedding?.dimensions;
    if (typeof dims === 'object') dims = dims.default || 512;
    return Number.isFinite(Number(dims)) ? Number(dims) : 512;
  }

  isOllamaEmbeddingEndpoint() {
    return (process.env.EMBEDDING_PROVIDER || '').includes('ollama')
      || (process.env.EMBEDDING_BASE_URL || '').includes('11434');
  }

  buildEmbeddingCreateParams(input) {
    const params = { model: this.getEmbeddingModel(), input };
    if (!this.isOllamaEmbeddingEndpoint()) {
      params.encoding_format = 'float';
      params.dimensions = this.getEmbeddingDimensions();
    }
    return params;
  }

  prepareEmbeddingText(text) {
    const value = String(text || '');
    if (this.tokenizer) {
      const tokens = this.tokenizer.encode(value);
      const maxTokens = this.isOllamaEmbeddingEndpoint() ? 512 : 8000;
      if (tokens.length > maxTokens) {
        const decoded = this.tokenizer.decode(tokens.slice(0, maxTokens));
        return typeof decoded === 'string' ? decoded : new TextDecoder().decode(decoded);
      }
    }
    const maxChars = this.isOllamaEmbeddingEndpoint() ? 2000 : 30000;
    return value.length > maxChars ? value.slice(0, maxChars) : value;
  }

  /**
   * Generate embedding using OpenAI
   * @param {string} text - Text to embed
   * Note: All embeddings use same dimensions (512) for network consistency
   */
  async embed(text) {
    const originalText = String(text || '');
    try {
      const preparedText = this.prepareEmbeddingText(originalText);
      const client = this.getEmbeddingClient();
      const response = await client.embeddings.create(this.buildEmbeddingCreateParams(preparedText));

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
      if (originalText.length > 5000 && this.extractiveSummarizer) {
        this.logger?.warn?.('Embedding failed, trying extractive summary', { 
          error: error.message,
          textLength: originalText.length
        });
        
        try {
          const extracted = this.extractiveSummarizer.summarize(originalText);
          if (extracted.quality >= 0.5) {
            // Retry embedding with much shorter summary (recursive call with safety)
            const summaryText = extracted.summary;
            if (summaryText.length < originalText.length) {
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
        textLength: originalText.length
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
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const output = new Array(texts.length).fill(null);
    const batchSize = 2048;
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const original = texts.slice(offset, offset + batchSize);
      const input = original.map(text => this.prepareEmbeddingText(text));
      const missing = new Set(input.map((_text, index) => index));
      try {
        const response = await this.getEmbeddingClient().embeddings.create(
          this.buildEmbeddingCreateParams(input),
        );
        for (const item of response?.data || []) {
          if (!Number.isInteger(item?.index)
              || item.index < 0
              || item.index >= input.length
              || !Array.isArray(item.embedding)
              || !missing.has(item.index)) continue;
          output[offset + item.index] = item.embedding;
          missing.delete(item.index);
        }
        this.logger?.debug?.('Batch embeddings generated', {
          batchSize: original.length,
          resolved: original.length - missing.size,
          totalRequested: texts.length,
        });
      } catch (error) {
        this.logger?.warn?.('Batch embedding failed; retrying inputs individually', {
          error: error.message,
          batchSize: input.length,
        });
      }
      for (const index of missing) {
        output[offset + index] = await this.embed(original[index]);
      }
    }
    return output;
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
    
    const accepted = nodesToEmbed
      .map((node, index) => ({ node, embedding: embeddings[index] || null }))
      .filter(({ embedding }) => Boolean(embedding));
    let successCount = 0;
    if (accepted.length > 0) {
      this.withPersistenceBarrier(() => {
        for (const { node, embedding } of accepted) {
          if (this.nodes.get(node.id) !== node || node.embedding) continue;
          node.embedding = embedding;
          node.embedding_status = 'embedded';
          this._markNodeDirtyUnsafe(node.id);
          successCount += 1;
        }
      });
    }
    
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
  async addNode(concept, tag = 'general', embedding = null, metadata = null) {
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

    const node = {
      id: null,
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
      accessCount: 0,
      metadata: metadata || null,
      type: metadata?.type || null
    };

    const initialConnections = this.findInitialConnections(node);
    const edgeTimestamp = new Date();
    let storedNode = null;
    this.withPersistenceBarrier(() => {
      if (this.nodeIdFormat === 'string' && this.nodeIdPrefix) {
        do {
          if (!Number.isSafeInteger(this.nextNodeId) || this.nextNodeId >= Number.MAX_SAFE_INTEGER) {
            throw new Error('node_id_space_exhausted');
          }
          node.id = `${this.nodeIdPrefix}_${this.nextNodeId++}`;
        } while (this.nodes.has(node.id));
      } else {
        do {
          if (!Number.isSafeInteger(this.nextNodeId) || this.nextNodeId >= Number.MAX_SAFE_INTEGER) {
            throw new Error('node_id_space_exhausted');
          }
          node.id = this.nextNodeId++;
        } while (this.nodes.has(node.id));
      }
      this.nodes.set(node.id, node);
      storedNode = this.nodes.get(node.id);
      this._markNodeDirtyUnsafe(node.id);
      for (const { id, similarity } of initialConnections) {
        this._upsertEdgeUnsafe(node.id, id, similarity * 0.5, 'associative', {
          enforceBridgeCap: false,
          timestamp: edgeTimestamp,
        });
      }
      this._assignToClusterUnsafe(node.id);
    });
    
    this.logger?.debug('Node added to network', { 
      id: storedNode.id,
      concept: concept.substring(0, 50),
      cluster: storedNode.cluster
    });
    
    return storedNode;
  }

  /**
   * Form initial connections based on similarity
   */
  async formInitialConnections(nodeId) {
    const node = this.nodes.get(nodeId);
    for (const { id, similarity } of this.findInitialConnections(node, nodeId)) {
      this.addEdge(nodeId, id, similarity * 0.5);
    }
  }

  findInitialConnections(node, excludedNodeId = null) {
    if (!node) return [];
    const similarities = [];
    
    // Find similar nodes
    for (const [id, otherNode] of this.nodes) {
      if (id === excludedNodeId) continue;

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
    
    return similarities.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
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
  addEdge(nodeA, nodeB, weight = 0.1, type = 'associative', options = {}) {
    // CRITICAL FIX: Prevent self-loops (they cause exponential accumulation)
    if (nodeA === nodeB) {
      this.logger?.debug?.('Skipping self-loop edge', { nodeId: nodeA });
      return;
    }
    const enforceBridgeCap = options?.enforceBridgeCap !== false;
    const bridgeCap = this.config.smallWorld?.maxBridgesPerNode ?? 40;
    const timestamp = new Date();
    const result = this.withPersistenceBarrier(() => this._upsertEdgeUnsafe(
      nodeA,
      nodeB,
      weight,
      type,
      { enforceBridgeCap, bridgeCap, timestamp },
    ));
    for (const eviction of result.evictions) {
      this.logger?.debug?.('Bridge cap enforced', eviction);
    }
    return result.edgeKey;
  }

  _prepareNodePatch(patch) {
    const prepared = clonePersistenceValue(patch);
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
      throw new TypeError('node_patch_plain_object_required');
    }
    for (const forbidden of ['id', 'cluster', '__proto__', 'prototype', 'constructor']) {
      if (Object.prototype.hasOwnProperty.call(prepared, forbidden)) {
        throw new TypeError(`node_patch_forbidden_key:${forbidden}`);
      }
    }
    for (const timestampField of ['created', 'accessed']) {
      if (!Object.prototype.hasOwnProperty.call(prepared, timestampField)) continue;
      const timestamp = new Date(prepared[timestampField]);
      if (Number.isNaN(timestamp.getTime())) {
        throw new TypeError(`node_patch_invalid_timestamp:${timestampField}`);
      }
      prepared[timestampField] = timestamp;
    }
    return prepared;
  }

  _dataPropertyValue(record, key) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return undefined;
    if (descriptor.get || descriptor.set) {
      throw new TypeError('persistence_record_accessor_not_allowed');
    }
    return descriptor.value;
  }

  patchNode(nodeId, patch, options = {}) {
    const stored = this.nodes.get(nodeId);
    if (!stored || (options.expectedNode && stored !== options.expectedNode)) return null;
    const expected = options.expected === undefined ? null : clonePersistenceValue(options.expected);
    if (expected && (typeof expected !== 'object' || Array.isArray(expected))) {
      throw new TypeError('node_patch_expected_plain_object_required');
    }
    for (const key of expected ? Reflect.ownKeys(expected) : []) {
      if (!persistenceValuesEqual(this._dataPropertyValue(stored, key), expected[key])) return null;
    }
    const preparedPatch = this._prepareNodePatch(patch);
    const isNoOp = Reflect.ownKeys(preparedPatch).every((key) => (
      persistenceValuesEqual(this._dataPropertyValue(stored, key), preparedPatch[key])
    ));
    if (isNoOp) return stored;
    const result = this.patchNodes([{ ...options, nodeId, patch }]);
    return result.nodes[0] || null;
  }

  patchNodes(entries) {
    const preparedEntries = [];
    for (const entry of Array.from(entries || [])) {
      if (!entry || entry.nodeId === undefined || entry.nodeId === null) continue;
      const stored = this.nodes.get(entry.nodeId);
      if (!stored || (entry.expectedNode && stored !== entry.expectedNode)) continue;
      const expected = entry.expected === undefined
        ? null
        : clonePersistenceValue(entry.expected);
      if (expected && (typeof expected !== 'object' || Array.isArray(expected))) {
        throw new TypeError('node_patch_expected_plain_object_required');
      }
      let expectedMatches = true;
      for (const key of expected ? Reflect.ownKeys(expected) : []) {
        if (!persistenceValuesEqual(this._dataPropertyValue(stored, key), expected[key])) {
          expectedMatches = false;
          break;
        }
      }
      if (!expectedMatches) continue;

      const patch = this._prepareNodePatch(entry.patch);
      const updates = [];
      for (const key of Reflect.ownKeys(patch)) {
        const value = patch[key];
        if (!persistenceValuesEqual(this._dataPropertyValue(stored, key), value)) {
          updates.push([key, value]);
        }
      }
      if (updates.length === 0) continue;
      preparedEntries.push({
        nodeId: entry.nodeId,
        stored,
        updates,
      });
    }

    if (preparedEntries.length === 0) return { updated: 0, nodes: [] };
    return this.withPersistenceBarrier(() => {
      const nodes = [];
      for (const entry of preparedEntries) {
        if (this.nodes.get(entry.nodeId) !== entry.stored) continue;
        for (const [key, value] of entry.updates) {
          entry.stored[key] = value;
        }
        this._markNodeDirtyUnsafe(entry.nodeId);
        nodes.push(this.nodes.get(entry.nodeId));
      }
      return { updated: nodes.length, nodes };
    });
  }

  withPersistenceBarrier(callback) {
    if (typeof callback !== 'function') throw new TypeError('persistence_barrier_callback_required');
    if (Object.prototype.toString.call(callback) === '[object AsyncFunction]') {
      throw new Error('persistence_barrier_async_callback');
    }
    if (this.persistenceBarrierActive) throw new Error('persistence_barrier_reentry');
    this.persistenceBarrierActive = true;
    try {
      const result = callback();
      if (isThenableWithoutInvocation(result)) throw new Error('persistence_barrier_async_callback');
      return result;
    } finally {
      this.persistenceBarrierActive = false;
    }
  }

  _requirePersistenceBarrierUnsafe() {
    if (!this.persistenceBarrierActive) throw new Error('persistence_barrier_required');
  }

  _advancePersistenceGenerationUnsafe() {
    this._requirePersistenceBarrierUnsafe();
    this.persistenceRevision += 1;
    this.persistenceGeneration += 1;
  }

  _markNodeDirtyUnsafe(nodeId) {
    this._requirePersistenceBarrierUnsafe();
    this.dirtyNodeIds.add(nodeId);
    this.deletedNodeIds.delete(nodeId);
    this._advancePersistenceGenerationUnsafe();
  }

  _markEdgeDirtyUnsafe(edgeKey) {
    this._requirePersistenceBarrierUnsafe();
    this.dirtyEdgeKeys.add(edgeKey);
    this.deletedEdgeKeys.delete(edgeKey);
    this._advancePersistenceGenerationUnsafe();
  }

  _deleteEdgeKeyUnsafe(edgeKey) {
    this._requirePersistenceBarrierUnsafe();
    if (!this.edges.delete(edgeKey)) return false;
    this.dirtyEdgeKeys.delete(edgeKey);
    this.deletedEdgeKeys.add(edgeKey);
    this._advancePersistenceGenerationUnsafe();
    return true;
  }

  _enforceBridgeCapUnsafe(nodeId, cap) {
    this._requirePersistenceBarrierUnsafe();
    if (!cap || cap <= 0) return null;
    const nodeText = String(nodeId);
    const bridges = [];
    for (const [edgeKey, edge] of this.edges) {
      if (edge?.type !== 'bridge') continue;
      if (String(edge.source) === nodeText || String(edge.target) === nodeText) {
        bridges.push([edgeKey, edge]);
      }
    }
    if (bridges.length < cap) return null;
    bridges.sort((left, right) => left[1].weight - right[1].weight);
    const removeCount = bridges.length - (cap - 1);
    let evicted = 0;
    for (let index = 0; index < removeCount; index += 1) {
      if (this._deleteEdgeKeyUnsafe(bridges[index][0])) evicted += 1;
    }
    return evicted > 0 ? { node: nodeId, evicted, cap } : null;
  }

  _upsertEdgeUnsafe(nodeA, nodeB, weight, type, options = {}) {
    this._requirePersistenceBarrierUnsafe();
    const sortedPair = [nodeA, nodeB].sort((a, b) => String(a).localeCompare(String(b)));
    const edgeKey = sortedPair.join('->');
    const existing = this.edges.get(edgeKey);
    const timestamp = options.timestamp || new Date();
    const evictions = [];
    if (existing) {
      existing.weight = Math.min(1, Number(existing.weight || 0) + weight);
      existing.accessed = timestamp;
      if (type !== 'associative' && existing.type !== type) existing.type = type;
      this._markEdgeDirtyUnsafe(edgeKey);
      return { edgeKey, evictions, inserted: false };
    }
    if (type === 'bridge' && options.enforceBridgeCap !== false) {
      for (const endpoint of sortedPair) {
        const eviction = this._enforceBridgeCapUnsafe(endpoint, options.bridgeCap);
        if (eviction) evictions.push(eviction);
      }
    }
    this.edges.set(edgeKey, {
      source: sortedPair[0],
      target: sortedPair[1],
      weight,
      type,
      created: timestamp,
      accessed: timestamp,
    });
    this._markEdgeDirtyUnsafe(edgeKey);
    return { edgeKey, evictions, inserted: true };
  }

  _removeNodeUnsafe(nodeId) {
    this._requirePersistenceBarrierUnsafe();
    if (!this.nodes.has(nodeId)) return null;
    this.nodes.delete(nodeId);
    this.dirtyNodeIds.delete(nodeId);
    this.deletedNodeIds.add(nodeId);
    this._advancePersistenceGenerationUnsafe();
    let removedEdges = 0;
    for (const [edgeKey, edge] of this.edges) {
      let source = edge?.source;
      let target = edge?.target;
      if (source === undefined || target === undefined) {
        const parts = String(edgeKey).split('->');
        source = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
        target = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
      }
      if (source == nodeId || target == nodeId) {
        if (this._deleteEdgeKeyUnsafe(edgeKey)) removedEdges += 1;
      }
    }
    for (const [clusterId, members] of this.clusters) {
      members.delete(nodeId);
      if (members.size === 0) this.clusters.delete(clusterId);
    }
    return { nodeId, removedEdges };
  }

  importGraphChanges(changes = {}) {
    const nodeRecords = new Map();
    for (const rawNode of Array.from(changes.nodes || [])) {
      const clonedInput = clonePersistenceValue(rawNode);
      const isTuple = Array.isArray(clonedInput) && clonedInput.length === 2;
      const node = isTuple ? clonedInput[1] : clonedInput;
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const nodeId = isTuple ? clonedInput[0] : node.id;
      if (nodeId === undefined || nodeId === null) continue;
      if (isTuple) {
        Object.defineProperty(node, 'id', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: nodeId,
        });
      }
      for (const timestampField of ['created', 'accessed']) {
        if (!Object.prototype.hasOwnProperty.call(node, timestampField) || !node[timestampField]) continue;
        const timestamp = new Date(node[timestampField]);
        if (!Number.isNaN(timestamp.getTime())) node[timestampField] = timestamp;
      }
      nodeRecords.set(nodeId, node);
    }
    const edgeRecords = new Map();
    for (const rawEdge of Array.from(changes.edges || [])) {
      const clonedInput = clonePersistenceValue(rawEdge);
      const isTuple = Array.isArray(clonedInput) && clonedInput.length === 2;
      let edgeKey = isTuple ? clonedInput[0] : clonedInput?.id;
      const edge = isTuple ? clonedInput[1] : clonedInput;
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) continue;
      for (const timestampField of ['created', 'accessed']) {
        if (!Object.prototype.hasOwnProperty.call(edge, timestampField) || !edge[timestampField]) continue;
        const timestamp = new Date(edge[timestampField]);
        if (!Number.isNaN(timestamp.getTime())) edge[timestampField] = timestamp;
      }
      let source = edge.source ?? edge.from;
      let target = edge.target ?? edge.to;
      if ((source === undefined || target === undefined) && edgeKey) {
        const parts = String(edgeKey).split('->');
        source = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
        target = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
      }
      if (source === undefined || target === undefined || source === target) continue;
      const sorted = [source, target].sort((a, b) => String(a).localeCompare(String(b)));
      edgeKey = sorted.join('->');
      edge.source = sorted[0];
      edge.target = sorted[1];
      delete edge.id;
      edgeRecords.set(edgeKey, edge);
    }
    const clusterRecords = new Map();
    for (const rawCluster of Array.from(changes.clusters || [])) {
      const clonedInput = clonePersistenceValue(rawCluster);
      const isTuple = Array.isArray(clonedInput) && clonedInput.length === 2;
      const clusterId = isTuple ? clonedInput[0] : clonedInput?.id;
      const members = isTuple ? clonedInput[1] : clonedInput?.nodes;
      if (clusterId === undefined || clusterId === null || !members) continue;
      clusterRecords.set(clusterId, new Set(Array.from(members)));
    }
    const nodeDeletes = Array.from(new Set(changes.nodeDeletes || []));
    const edgeDeletes = Array.from(new Set(changes.edgeDeletes || []));
    const clusterDeletes = Array.from(new Set(changes.clusterDeletes || []));
    const preparedNodes = Array.from(nodeRecords, ([nodeId, node]) => ({
      nodeId,
      node,
      existing: this.nodes.get(nodeId),
    })).filter(({ nodeId, node, existing }) => (
      !nodeDeletes.includes(nodeId) && (!existing || !persistenceValuesEqual(existing, node))
    ));
    const preparedEdges = Array.from(edgeRecords, ([edgeKey, edge]) => ({
      edgeKey,
      edge,
      existing: this.edges.get(edgeKey),
    })).filter(({ edgeKey, edge, existing }) => (
      !edgeDeletes.includes(edgeKey) && (!existing || !persistenceValuesEqual(existing, edge))
    ));
    const preparedClusters = Array.from(clusterRecords, ([clusterId, members]) => ({
      clusterId,
      members,
      existing: this.clusters.get(clusterId),
    })).filter(({ clusterId, members, existing }) => {
      if (clusterDeletes.includes(clusterId)) return false;
      return !(existing instanceof Set)
        || existing.size !== members.size
        || Array.from(members).some((nodeId) => (
          !existing.has(nodeId) || this.nodes.get(nodeId)?.cluster != clusterId
        ));
    });
    const hasDeletes = nodeDeletes.some((nodeId) => this.nodes.has(nodeId))
      || edgeDeletes.some((edgeKey) => this.edges.has(edgeKey))
      || clusterDeletes.some((clusterId) => this.clusters.has(clusterId));
    let derivedNextNodeId = nextSafeIntegerAfter(this.nodes.keys(), this.nextNodeId);
    derivedNextNodeId = nextSafeIntegerAfter(nodeRecords.keys(), derivedNextNodeId);
    let derivedNextClusterId = nextSafeIntegerAfter(this.clusters.keys(), this.nextClusterId);
    derivedNextClusterId = nextSafeIntegerAfter(clusterRecords.keys(), derivedNextClusterId);
    for (const node of nodeRecords.values()) {
      const clusterId = node.cluster;
      if (Number.isSafeInteger(clusterId)
          && clusterId >= derivedNextClusterId
          && clusterId < Number.MAX_SAFE_INTEGER) {
        derivedNextClusterId = clusterId + 1;
      }
    }
    const targetNextNodeId = Math.max(this.nextNodeId, derivedNextNodeId);
    const targetNextClusterId = Math.max(this.nextClusterId, derivedNextClusterId);
    if (!hasDeletes && preparedNodes.length === 0 && preparedEdges.length === 0
        && preparedClusters.length === 0) {
      return { importedNodes: 0, importedEdges: 0, importedClusters: 0, removedNodes: 0, removedEdges: 0, removedClusters: 0 };
    }

    return this.withPersistenceBarrier(() => {
      let importedNodes = 0;
      let importedEdges = 0;
      let importedClusters = 0;
      let removedNodes = 0;
      let removedEdges = 0;
      let removedClusters = 0;
      for (const nodeId of nodeDeletes) {
        const removed = this._removeNodeUnsafe(nodeId);
        if (!removed) continue;
        removedNodes += 1;
        removedEdges += removed.removedEdges;
      }
      for (const edgeKey of edgeDeletes) {
        if (this._deleteEdgeKeyUnsafe(edgeKey)) removedEdges += 1;
      }
      for (const clusterId of clusterDeletes) {
        const members = this.clusters.get(clusterId);
        if (!members || !this.clusters.delete(clusterId)) continue;
        removedClusters += 1;
        let marked = false;
        for (const nodeId of members) {
          const node = this.nodes.get(nodeId);
          if (!node || node.cluster != clusterId) continue;
          node.cluster = null;
          this._markNodeDirtyUnsafe(nodeId);
          marked = true;
        }
        if (!marked) this._advancePersistenceGenerationUnsafe();
      }
      for (const prepared of preparedNodes) {
        const current = this.nodes.get(prepared.nodeId);
        const previousCluster = current?.cluster;
        if (previousCluster !== null && previousCluster !== undefined && previousCluster !== prepared.node.cluster) {
          const previousMembers = this.clusters.get(previousCluster);
          previousMembers?.delete(prepared.nodeId);
          if (previousMembers?.size === 0) this.clusters.delete(previousCluster);
        }
        this.nodes.set(prepared.nodeId, prepared.node);
        this._markNodeDirtyUnsafe(prepared.nodeId);
        if (prepared.node.cluster !== null && prepared.node.cluster !== undefined) {
          if (!this.clusters.has(prepared.node.cluster)) this.clusters.set(prepared.node.cluster, new Set());
          this.clusters.get(prepared.node.cluster).add(prepared.nodeId);
        }
        importedNodes += 1;
      }
      for (const prepared of preparedEdges) {
        if (!this.nodes.has(prepared.edge.source) || !this.nodes.has(prepared.edge.target)) continue;
        this.edges.set(prepared.edgeKey, prepared.edge);
        this._markEdgeDirtyUnsafe(prepared.edgeKey);
        importedEdges += 1;
      }
      for (const prepared of preparedClusters) {
        const current = this.clusters.get(prepared.clusterId);
        const members = new Set(Array.from(prepared.members).filter((nodeId) => this.nodes.has(nodeId)));
        const removedMembers = current instanceof Set
          ? Array.from(current).filter((nodeId) => !members.has(nodeId))
          : [];
        this.clusters.set(prepared.clusterId, members);
        let marked = false;
        for (const nodeId of removedMembers) {
          const node = this.nodes.get(nodeId);
          if (!node || node.cluster != prepared.clusterId) continue;
          node.cluster = null;
          this._markNodeDirtyUnsafe(nodeId);
          marked = true;
        }
        for (const nodeId of members) {
          const node = this.nodes.get(nodeId);
          if (node.cluster == prepared.clusterId) continue;
          const previousCluster = node.cluster;
          if (previousCluster !== null && previousCluster !== undefined) {
            const previousMembers = this.clusters.get(previousCluster);
            previousMembers?.delete(nodeId);
            if (previousMembers?.size === 0) this.clusters.delete(previousCluster);
          }
          node.cluster = prepared.clusterId;
          this._markNodeDirtyUnsafe(nodeId);
          marked = true;
        }
        if (!marked) this._advancePersistenceGenerationUnsafe();
        importedClusters += 1;
      }
      if (preparedNodes.length > 0 && targetNextNodeId > this.nextNodeId) {
        this.nextNodeId = targetNextNodeId;
      }
      if ((preparedNodes.length > 0 || preparedClusters.length > 0)
          && targetNextClusterId > this.nextClusterId) {
        this.nextClusterId = targetNextClusterId;
      }
      return { importedNodes, importedEdges, importedClusters, removedNodes, removedEdges, removedClusters };
    });
  }

  applyReclusterPlan(plan) {
    if (!plan || typeof plan !== 'object') {
      return { assignedToExisting: 0, createdClusters: 0, assignedToNewClusters: 0 };
    }
    const existingAssignments = Array.from(plan.existingAssignments || [])
      .map((assignment) => ({
        nodeId: assignment?.nodeId,
        clusterId: assignment?.cluster,
      }))
      .filter(({ nodeId, clusterId }) => (
        nodeId !== undefined && nodeId !== null && clusterId !== undefined && clusterId !== null
      ));
    const newClusterGroups = Array.from(plan.newClusterGroups || [])
      .map((group) => Array.from(new Set(group || [])))
      .filter((group) => group.length > 0);
    const hasAcceptedNode = existingAssignments.some(({ nodeId, clusterId }) => {
      const node = this.nodes.get(nodeId);
      return node && node.cluster !== clusterId;
    }) || newClusterGroups.some((group) => group.some((nodeId) => {
      const node = this.nodes.get(nodeId);
      return node && (node.cluster === null || node.cluster === undefined);
    }));
    if (!hasAcceptedNode) {
      return { assignedToExisting: 0, createdClusters: 0, assignedToNewClusters: 0 };
    }

    return this.withPersistenceBarrier(() => {
      let assignedToExisting = 0;
      let createdClusters = 0;
      let assignedToNewClusters = 0;
      for (const { nodeId, clusterId } of existingAssignments) {
        const node = this.nodes.get(nodeId);
        if (!node || node.cluster === clusterId) continue;
        this._moveNodeToClusterUnsafe(nodeId, clusterId);
        assignedToExisting += 1;
      }
      for (const group of newClusterGroups) {
        const accepted = group.filter((nodeId) => {
          const node = this.nodes.get(nodeId);
          return node && (node.cluster === null || node.cluster === undefined);
        });
        if (accepted.length === 0) continue;
        const clusterId = this._allocateClusterIdUnsafe();
        this.clusters.set(clusterId, new Set());
        this._advancePersistenceGenerationUnsafe();
        createdClusters += 1;
        for (const nodeId of accepted) {
          this._moveNodeToClusterUnsafe(nodeId, clusterId);
          assignedToNewClusters += 1;
        }
      }
      return { assignedToExisting, createdClusters, assignedToNewClusters };
    });
  }

  _moveNodeToClusterUnsafe(nodeId, clusterId) {
    this._requirePersistenceBarrierUnsafe();
    const node = this.nodes.get(nodeId);
    if (!node || node.cluster === clusterId) return false;
    const previousCluster = node.cluster;
    if (previousCluster !== null && previousCluster !== undefined) {
      const members = this.clusters.get(previousCluster);
      members?.delete(nodeId);
      if (members?.size === 0) this.clusters.delete(previousCluster);
    }
    if (!this.clusters.has(clusterId)) this.clusters.set(clusterId, new Set());
    this.clusters.get(clusterId).add(nodeId);
    node.cluster = clusterId;
    this._markNodeDirtyUnsafe(nodeId);
    return true;
  }

  _allocateClusterIdUnsafe() {
    this._requirePersistenceBarrierUnsafe();
    let clusterId = this.nextClusterId;
    if (!Number.isSafeInteger(clusterId) || clusterId < 1 || clusterId >= Number.MAX_SAFE_INTEGER) {
      throw new Error('cluster_id_space_exhausted');
    }
    while (this.clusters.has(clusterId)) {
      clusterId += 1;
      if (!Number.isSafeInteger(clusterId) || clusterId >= Number.MAX_SAFE_INTEGER) {
        throw new Error('cluster_id_space_exhausted');
      }
    }
    this.nextClusterId = clusterId + 1;
    return clusterId;
  }

  capturePersistenceSnapshot() {
    return this.withPersistenceBarrier(() => {
      const nodes = Array.from(this.nodes.values())
        .map((node) => clonePersistenceValue(node));
      const edges = Array.from(this.edges.entries())
        .map(([edgeKey, edge]) => serializeEdgePersistenceRecord(edgeKey, edge));
      const changes = {
        nodes: Array.from(this.dirtyNodeIds)
          .map((nodeId) => this.nodes.get(nodeId))
          .filter(Boolean)
          .map((node) => clonePersistenceValue(node)),
        edges: Array.from(this.dirtyEdgeKeys)
          .map((edgeKey) => {
            const edge = this.edges.get(edgeKey);
            return edge ? serializeEdgePersistenceRecord(edgeKey, edge) : null;
          })
          .filter(Boolean),
        removedNodeIds: Array.from(this.deletedNodeIds),
        removedEdgeKeys: Array.from(this.deletedEdgeKeys),
        revision: this.persistenceRevision,
      };
      return deepFreezePersistenceValue({
        generation: this.persistenceGeneration,
        changes,
        fullView: { nodes, edges },
        summary: summarizePersistenceView(nodes, edges),
      });
    });
  }

  markPersistenceCleanIfGeneration(expectedGeneration) {
    return this.withPersistenceBarrier(() => {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.persistenceGeneration) return false;
      this.dirtyNodeIds.clear();
      this.dirtyEdgeKeys.clear();
      this.deletedNodeIds.clear();
      this.deletedEdgeKeys.clear();
      return true;
    });
  }

  /**
   * Remove a node and all its edges from the graph.
   * Used by document feeder to replace stale chunks on re-ingestion.
   */
  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) return false;
    return Boolean(this.withPersistenceBarrier(() => this._removeNodeUnsafe(nodeId)));
  }

  removeNodes(nodeIds) {
    const ids = Array.from(new Set(nodeIds || []));
    if (!ids.some((nodeId) => this.nodes.has(nodeId))) {
      return { removedNodes: 0, removedEdges: 0 };
    }
    return this.withPersistenceBarrier(() => {
      let removedNodes = 0;
      let removedEdges = 0;
      for (const nodeId of ids) {
        const result = this._removeNodeUnsafe(nodeId);
        if (!result) continue;
        removedNodes += 1;
        removedEdges += result.removedEdges;
      }
      return { removedNodes, removedEdges };
    });
  }

  /**
   * Spreading activation from seed node
   * From: "Spreading Activation and Associative Recall" section
   */
  async spreadActivation(seedNodeId, maxDepth = null, options = {}) {
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
    
    if (options.mutate !== false) {
      const updates = Array.from(activated.entries())
        .map(([nodeId, level]) => ({ nodeId, level, node: this.nodes.get(nodeId) }))
        .filter(({ node, level }) => node && !Object.is(node.activation, level));
      if (updates.length > 0) {
        this.withPersistenceBarrier(() => {
          for (const { nodeId, level, node } of updates) {
            if (this.nodes.get(nodeId) !== node || Object.is(node.activation, level)) continue;
            node.activation = level;
            this._markNodeDirtyUnsafe(nodeId);
          }
        });
      }
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
    if (!this.edges.has(edgeKey)) return false;
    return this.withPersistenceBarrier(() => this._deleteEdgeKeyUnsafe(edgeKey));
  }

  recordNodeAccess(nodeIds, { weightBoost = 0.05 } = {}) {
    const ids = Array.from(nodeIds || []);
    if (!ids.some((id) => this.nodes.has(id))) return;
    const accessedAt = new Date();
    this.withPersistenceBarrier(() => {
      for (const id of ids) {
        const stored = this.nodes.get(id);
        if (!stored) continue;
        stored.accessed = accessedAt;
        stored.accessCount = Number(stored.accessCount || 0) + 1;
        stored.weight = Math.min(1, Number(stored.weight || 0) + weightBoost);
        this._markNodeDirtyUnsafe(id);
      }
    });
  }

  markNodeDirty(nodeId) {
    if (!this.nodes.has(nodeId)) return false;
    return this.withPersistenceBarrier(() => {
      if (!this.nodes.has(nodeId)) return false;
      this._markNodeDirtyUnsafe(nodeId);
      return true;
    });
  }

  markEdgeDirty(edgeKey) {
    if (!this.edges.has(edgeKey)) return false;
    return this.withPersistenceBarrier(() => {
      if (!this.edges.has(edgeKey)) return false;
      this._markEdgeDirtyUnsafe(edgeKey);
      return true;
    });
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
    const mutableAccess = options.markAccess !== false && options.accessMode !== 'read-only';
    const activated = await this.spreadActivation(bestMatch, null, { mutate: mutableAccess });
    
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
    
    // Mark as accessed and boost weight only for own-brain reads. Explicit
    // read-only calls are used for cross-brain search and must not mutate the
    // target brain.
    if (mutableAccess) {
      this.recordNodeAccess(results.map(node => node.id), { weightBoost: 0.1 });
      for (const node of results) {
        const stored = this.nodes.get(node.id);
        if (!stored) continue;
        node.accessed = stored.accessed;
        node.accessCount = stored.accessCount;
        node.weight = stored.weight;
      }
    }
    
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
    if (!this.nodes.has(nodeId)) return null;
    const assignment = this.withPersistenceBarrier(() => {
      if (!this.nodes.has(nodeId)) return null;
      const result = this._assignToClusterUnsafe(nodeId);
      if (result?.changed || result?.indexChanged) this._markNodeDirtyUnsafe(nodeId);
      return result;
    });
    if (assignment?.createdMissingCluster) {
      this.logger?.warn?.('Creating missing cluster during assignment', {
        clusterId: assignment.clusterId,
      });
    }
    return assignment?.clusterId ?? null;
  }

  _assignToClusterUnsafe(nodeId) {
    this._requirePersistenceBarrierUnsafe();
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const clusterScores = new Map();
    const bridgeVote = this.config.spreading?.bridgeTraversalFactor ?? 0.2;
    for (const [edgeKey, edge] of this.edges) {
      let source = edge.source;
      let target = edge.target;
      if (source === undefined || target === undefined) {
        const parts = edgeKey.split('->');
        source = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
        target = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
      }
      let neighborId = null;
      if (source == nodeId) neighborId = target;
      else if (target == nodeId) neighborId = source;
      if (neighborId === null || !this.nodes.has(neighborId)) continue;
      const neighbor = this.nodes.get(neighborId);
      if (neighbor && neighbor.cluster !== null) {
        const vote = edge?.type === 'bridge' ? bridgeVote : 1.0;
        clusterScores.set(
          neighbor.cluster,
          (clusterScores.get(neighbor.cluster) || 0) + vote,
        );
      }
    }

    const previousCluster = node.cluster;
    let clusterId;
    let createdMissingCluster = false;
    let indexChanged = false;
    if (clusterScores.size > 0) {
      clusterId = Array.from(clusterScores.entries())
        .sort((a, b) => b[1] - a[1])[0][0];
      if (!this.clusters.has(clusterId)) {
        this.clusters.set(clusterId, new Set());
        createdMissingCluster = true;
        indexChanged = true;
      }
    } else {
      clusterId = this._allocateClusterIdUnsafe();
      this.clusters.set(clusterId, new Set());
      indexChanged = true;
    }
    if (previousCluster !== null && previousCluster !== undefined && previousCluster !== clusterId) {
      const previousMembers = this.clusters.get(previousCluster);
      previousMembers?.delete(nodeId);
      if (previousMembers?.size === 0) this.clusters.delete(previousCluster);
    }
    const changed = previousCluster !== clusterId;
    if (changed) node.cluster = clusterId;
    const members = this.clusters.get(clusterId);
    if (!members.has(nodeId)) {
      members.add(nodeId);
      indexChanged = true;
    }
    return {
      changed,
      indexChanged,
      clusterId,
      createdMissingCluster,
    };
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
        if (this._removeEdgeKey(edgeKey)) pruned++;
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

  _removeEdgeKey(edgeKey) {
    if (!this.edges.has(edgeKey)) return false;
    return this.withPersistenceBarrier(() => this._deleteEdgeKeyUnsafe(edgeKey));
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
      if (!edge || edge.type === 'bridge') continue;
      
      let nodeA = edge.source ?? edge.from;
      let nodeB = edge.target ?? edge.to;
      if (nodeA === undefined || nodeB === undefined) {
        const parts = String(edgeKey).split('->');
        nodeA = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
        nodeB = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
      }
      if (!this.nodes.has(nodeA) || !this.nodes.has(nodeB)) continue;
      
      // Skip if nodes are in different clusters (already a cross-cluster link)
      const clusterA = this.nodes.get(nodeA)?.cluster;
      const clusterB = this.nodes.get(nodeB)?.cluster;
      if (clusterA !== clusterB) continue;
      
      // Decide whether to rewire this edge
      if (Math.random() < p) {
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
          // Do not remove the original until a valid replacement is known.
          this.removeEdge(nodeA, nodeB);
          const newWeight = Math.min(0.3, edge.weight); // Moderate weight for new connections
          this.addEdge(nodeA, nodeC, newWeight, 'bridge');
          rewired++;
          
          this.logger?.debug?.('Edge rewired (Watts-Strogatz)', {
            from: `${nodeA}-${nodeB}`,
            to: `${nodeA}-${nodeC}`,
            oldCluster: clusterB,
            newCluster: this.nodes.get(nodeC)?.cluster
          });
        }
      }
    }
    
    return rewired;
  }

  /**
   * Apply decay to unused nodes
   */
  applyDecay() {
    const now = Date.now();
    const factor = this.config.decay.baseFactor;
    const minWeight = this.config.decay.minimumWeight;
    const decayInterval = this.config.decay.decayInterval || 300;
    const exemptTags = this.config.decay.exemptTags || [];
    
    const nodeUpdates = [];
    for (const [id, node] of this.nodes) {
      // Skip decay for protected tags
      if (exemptTags.includes(node.tag)) {
        continue;
      }
      
      const accessedAt = node.accessed instanceof Date
        ? node.accessed.getTime()
        : new Date(node.accessed).getTime();
      if (!Number.isFinite(accessedAt)) continue;
      const age = (now - accessedAt) / 1000; // seconds
      
      if (age > decayInterval) {
        const weight = node.weight * factor;
        if (!Object.is(weight, node.weight)) nodeUpdates.push({ id, node, weight });
      }
    }
    
    // Also decay edges
    const edgeUpdates = [];
    if (this.config.hebbian.enabled) {
      for (const [key, edge] of this.edges) {
        const accessedAt = edge.accessed instanceof Date
          ? edge.accessed.getTime()
          : new Date(edge.accessed).getTime();
        if (!Number.isFinite(accessedAt)) continue;
        const age = (now - accessedAt) / 1000;
        if (age > decayInterval * 2) { // Edges decay slower
          const weight = edge.weight * this.config.hebbian.weakenFactor;
          if (!Object.is(weight, edge.weight)) edgeUpdates.push({ key, edge, weight });
        }
      }
    }
    if (nodeUpdates.length === 0 && edgeUpdates.length === 0) return;
    this.withPersistenceBarrier(() => {
      for (const { id, node, weight } of nodeUpdates) {
        if (this.nodes.get(id) !== node) continue;
        node.weight = weight;
        this._markNodeDirtyUnsafe(id);
      }
      for (const { key, edge, weight } of edgeUpdates) {
        if (this.edges.get(key) !== edge) continue;
        edge.weight = weight;
        this._markEdgeDirtyUnsafe(key);
      }
    });
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
