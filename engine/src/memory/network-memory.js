const { getOpenAIClient, getEmbeddingClient } = require('../core/openai-client');
const fs = require('node:fs');
const { ExtractiveSummarizer } = require('../utils/extractive-summarizer');
const { cosmoEvents } = require('../realtime/event-emitter');
const {
  classifyMemoryProvenance,
  scoreMemorySalience,
} = require('./provenance-salience');

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function isVectorLike(value) {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && typeof value.length === 'number');
}

function deepCloneJsonRecord(value, seen = new Set(), arrayElement = false) {
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
      clone[index] = deepCloneJsonRecord(value[index], seen, true);
    }
    return clone;
  }
  if (seen.has(value)) throw new TypeError('persistence_record_cycle_not_allowed');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new TypeError('persistence_record_plain_json_required');
    }
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
        if (descriptor.get || descriptor.set) {
          throw new TypeError('persistence_record_accessor_not_allowed');
        }
        Object.defineProperty(clone, String(index), {
          configurable: true,
          enumerable: true,
          writable: true,
          value: deepCloneJsonRecord(descriptor.value, seen, true),
        });
      }
      return clone;
    }
    const clone = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        const symbolDescriptor = Object.getOwnPropertyDescriptor(value, key);
        if (symbolDescriptor?.enumerable) {
          throw new TypeError('persistence_record_symbol_key_not_allowed');
        }
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError('persistence_record_accessor_not_allowed');
      }
      const child = deepCloneJsonRecord(descriptor.value, seen, false);
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

function deepFreezeJson(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
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

function serializeNodePersistenceRecord(node) {
  return deepCloneJsonRecord(node);
}

function serializeEdgePersistenceRecord(key, edge) {
  const clone = deepCloneJsonRecord(edge);
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) {
    throw new TypeError('persistence_edge_record_required');
  }
  let source = clone.source;
  let target = clone.target;
  if (source === undefined || target === undefined) {
    const parts = key.split('->');
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

function jsonPersistenceValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(deepCloneJsonRecord(left)) === JSON.stringify(deepCloneJsonRecord(right));
  } catch {
    return false;
  }
}

function isThenableWithoutInvocation(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let cursor = value;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'then');
    if (descriptor) {
      return Boolean(descriptor.get || descriptor.set || typeof descriptor.value === 'function');
    }
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

function isLegacyGraphIdentity(value) {
  return (typeof value === 'string' && value.length > 0) || Number.isSafeInteger(value);
}

function requireLegacyGraphIdentity(value, code) {
  if (!isLegacyGraphIdentity(value)) throw new TypeError(code);
  return value;
}

function readOwnDataProperty(record, key, code) {
  if (!record || typeof record !== 'object') return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, value: undefined };
  if (descriptor.get || descriptor.set) throw new TypeError(code);
  return { present: true, value: descriptor.value };
}

function orderLegacyEdgeEndpoints(source, target) {
  return [source, target]
    .sort((left, right) => String(left).localeCompare(String(right)));
}

function resolveLegacyEdgeEndpoint(rawIdentity, nodes) {
  const hasStringIdentity = Map.prototype.has.call(nodes, rawIdentity);
  let numericIdentity;
  let hasNumericIdentity = false;
  if (/^-?(?:0|[1-9]\d*)$/.test(rawIdentity)) {
    const numeric = Number(rawIdentity);
    if (Number.isSafeInteger(numeric)
        && String(numeric) === rawIdentity
        && Map.prototype.has.call(nodes, numeric)) {
      numericIdentity = numeric;
      hasNumericIdentity = true;
    }
  }
  if (hasStringIdentity && hasNumericIdentity) return undefined;
  if (hasStringIdentity) return rawIdentity;
  if (hasNumericIdentity) return numericIdentity;
  return undefined;
}

function validateLegacyEdgeRecord(edgeKey, edge, nodes, scope) {
  const invalidCode = `${scope}_invalid_edge`;
  const mismatchCode = `${scope}_identity_mismatch`;
  if (typeof edgeKey !== 'string' || edgeKey.length === 0
      || !edge || typeof edge !== 'object' || Array.isArray(edge)) {
    throw new TypeError(invalidCode);
  }

  const sourceProperty = readOwnDataProperty(edge, 'source', invalidCode);
  const targetProperty = readOwnDataProperty(edge, 'target', invalidCode);
  const fromProperty = readOwnDataProperty(edge, 'from', invalidCode);
  const toProperty = readOwnDataProperty(edge, 'to', invalidCode);
  if (sourceProperty.present && fromProperty.present
      && !Object.is(sourceProperty.value, fromProperty.value)) {
    throw new Error(mismatchCode);
  }
  if (targetProperty.present && toProperty.present
      && !Object.is(targetProperty.value, toProperty.value)) {
    throw new Error(mismatchCode);
  }

  let source = sourceProperty.present ? sourceProperty.value : fromProperty.value;
  let target = targetProperty.present ? targetProperty.value : toProperty.value;
  const hasSource = sourceProperty.present || fromProperty.present;
  const hasTarget = targetProperty.present || toProperty.present;
  if (hasSource !== hasTarget) throw new TypeError(invalidCode);
  if (!hasSource) {
    const parts = edgeKey.split('->');
    if (parts.length !== 2) throw new TypeError(invalidCode);
    source = resolveLegacyEdgeEndpoint(parts[0], nodes);
    target = resolveLegacyEdgeEndpoint(parts[1], nodes);
  }

  requireLegacyGraphIdentity(source, invalidCode);
  requireLegacyGraphIdentity(target, invalidCode);
  if (!Map.prototype.has.call(nodes, source)
      || !Map.prototype.has.call(nodes, target)
      || Object.is(source, target)) {
    throw new TypeError(invalidCode);
  }
  const orderedEndpoints = orderLegacyEdgeEndpoints(source, target);
  const canonicalKey = orderedEndpoints.join('->');
  if (canonicalKey !== edgeKey) throw new Error(mismatchCode);
  const recordId = readOwnDataProperty(edge, 'id', invalidCode);
  if (recordId.present && !Object.is(recordId.value, edgeKey)) throw new Error(mismatchCode);
  return { source: orderedEndpoints[0], target: orderedEndpoints[1], canonicalKey };
}

function buildLegacyClusterMap(clusterTuples, nodes) {
  const clusters = new Map();
  const memberClusters = new Map();
  for (const tuple of clusterTuples) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || !Array.isArray(tuple[1])) {
      throw new TypeError('network_load_invalid_cluster');
    }
    const [clusterId, rawMembers] = tuple;
    requireLegacyGraphIdentity(clusterId, 'network_load_invalid_cluster');
    if (Map.prototype.has.call(clusters, clusterId)) {
      throw new Error('network_load_duplicate_cluster');
    }
    const members = new Set();
    for (const nodeId of rawMembers) {
      requireLegacyGraphIdentity(nodeId, 'network_load_invalid_cluster');
      if (Set.prototype.has.call(members, nodeId)
          || Map.prototype.has.call(memberClusters, nodeId)) {
        throw new Error('network_load_duplicate_cluster_member');
      }
      if (!Map.prototype.has.call(nodes, nodeId)) {
        throw new TypeError('network_load_invalid_cluster');
      }
      const node = Map.prototype.get.call(nodes, nodeId);
      const nodeCluster = readOwnDataProperty(node, 'cluster', 'network_load_invalid_cluster');
      if (!nodeCluster.present || !Object.is(nodeCluster.value, clusterId)) {
        throw new Error('network_load_identity_mismatch');
      }
      Set.prototype.add.call(members, nodeId);
      Map.prototype.set.call(memberClusters, nodeId, clusterId);
    }
    Map.prototype.set.call(clusters, clusterId, members);
  }

  for (const [nodeId, node] of Map.prototype.entries.call(nodes)) {
    const nodeCluster = readOwnDataProperty(node, 'cluster', 'network_load_invalid_cluster');
    if (!nodeCluster.present || nodeCluster.value === null || nodeCluster.value === undefined) {
      if (Map.prototype.has.call(memberClusters, nodeId)) {
        throw new Error('network_load_identity_mismatch');
      }
      continue;
    }
    requireLegacyGraphIdentity(nodeCluster.value, 'network_load_invalid_cluster');
    if (!Map.prototype.has.call(clusters, nodeCluster.value)
        || !Map.prototype.has.call(memberClusters, nodeId)
        || !Object.is(Map.prototype.get.call(memberClusters, nodeId), nodeCluster.value)) {
      throw new TypeError('network_load_invalid_cluster');
    }
  }
  return clusters;
}

function serializeLegacyClusterEntries(clusterMap, nodes) {
  const entries = [];
  const memberClusters = new Map();
  for (const [clusterId, clusterMembers] of Map.prototype.entries.call(clusterMap)) {
    requireLegacyGraphIdentity(clusterId, 'network_save_invalid_cluster');
    if (!(clusterMembers instanceof Set)) throw new TypeError('network_save_invalid_cluster');
    const members = [];
    for (const nodeId of Set.prototype.values.call(clusterMembers)) {
      requireLegacyGraphIdentity(nodeId, 'network_save_invalid_cluster');
      if (Map.prototype.has.call(memberClusters, nodeId)) {
        throw new Error('network_save_duplicate_cluster_member');
      }
      if (!Map.prototype.has.call(nodes, nodeId)) throw new TypeError('network_save_invalid_cluster');
      const node = Map.prototype.get.call(nodes, nodeId);
      const nodeCluster = readOwnDataProperty(node, 'cluster', 'network_save_invalid_cluster');
      if (!nodeCluster.present || !Object.is(nodeCluster.value, clusterId)) {
        throw new Error('network_save_identity_mismatch');
      }
      members.push(nodeId);
      Map.prototype.set.call(memberClusters, nodeId, clusterId);
    }
    entries.push([clusterId, members]);
  }
  for (const [nodeId, node] of Map.prototype.entries.call(nodes)) {
    const nodeCluster = readOwnDataProperty(node, 'cluster', 'network_save_invalid_cluster');
    if (!nodeCluster.present || nodeCluster.value === null || nodeCluster.value === undefined) continue;
    requireLegacyGraphIdentity(nodeCluster.value, 'network_save_invalid_cluster');
    if (!Map.prototype.has.call(memberClusters, nodeId)
        || !Object.is(Map.prototype.get.call(memberClusters, nodeId), nodeCluster.value)) {
      throw new TypeError('network_save_invalid_cluster');
    }
  }
  return entries;
}

function hasActiveClusterWrapper(map) {
  const descriptor = Object.getOwnPropertyDescriptor(map, '__clusterInstrumented');
  return Boolean(descriptor && (descriptor.get || descriptor.set || descriptor.value));
}

/**
 * Network Memory Graph
 * Implements spreading activation, Hebbian learning, and small-world topology
 * From: "Network Theory and Emergent Idea Graphs" section
 */
class NetworkMemory {
  constructor(config, logger, deps = {}) {
    this.config = config;
    this.logger = logger;
    this.getEmbeddingClient = deps.getEmbeddingClient || getEmbeddingClient;
    
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

  normalizeEmbedding(embedding) {
    if (!isVectorLike(embedding)) return embedding;
    if (embedding instanceof Float32Array) return embedding;
    return Float32Array.from(embedding);
  }

  serializeEmbedding(embedding) {
    if (!isVectorLike(embedding)) return embedding;
    if (Array.isArray(embedding)) return embedding;
    return Array.from(embedding);
  }

  normalizeNodeRecord(node) {
    if (!node || typeof node !== 'object') return node;
    return {
      ...node,
      embedding: this.normalizeEmbedding(node.embedding),
    };
  }

  serializeNodeRecord(node) {
    return {
      ...node,
      embedding: this.serializeEmbedding(node?.embedding),
    };
  }

  getEmbeddingModel() {
    return process.env.EMBEDDING_MODEL || this.config.embedding?.model || 'nomic-embed-text';
  }

  getEmbeddingDimensions() {
    const envDims = Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10);
    if (Number.isFinite(envDims) && envDims > 0) return envDims;

    let dims = this.config.embedding?.dimensions;
    if (typeof dims === 'object') {
      dims = dims.default || 512;
    }
    return Number.isFinite(Number(dims)) ? Number(dims) : 512;
  }

  isOllamaEmbeddingEndpoint() {
    return (process.env.EMBEDDING_PROVIDER || '').includes('ollama')
      || (process.env.EMBEDDING_BASE_URL || '').includes('11434');
  }

  buildEmbeddingCreateParams(input) {
    const createParams = {
      model: this.getEmbeddingModel(),
      input,
    };
    if (!this.isOllamaEmbeddingEndpoint()) {
      createParams.encoding_format = 'float';
      createParams.dimensions = this.getEmbeddingDimensions();
    }
    return createParams;
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
    
    // Normalize provider data before entering the synchronous mutation barrier.
    const accepted = nodesToEmbed
      .map((node, index) => ({
        node,
        embedding: embeddings[index]
          ? this.normalizeEmbedding(embeddings[index])
          : null,
      }))
      .filter(({ embedding }) => Boolean(embedding));

    if (accepted.length > 0) {
      this.withPersistenceBarrier(() => {
        for (const { node, embedding } of accepted) {
          if (this.nodes.get(node.id) !== node) continue;
          node.embedding = embedding;
          node.embedding_status = 'embedded';
          this._markNodeDirtyUnsafe(node.id);
        }
      });
    }
    const successCount = accepted.filter(({ node }) => this.nodes.get(node.id) === node).length;
    
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
    const inputNode = concept && typeof concept === 'object' && !Array.isArray(concept)
      ? concept
      : null;
    const conceptText = inputNode
      ? String(inputNode.concept || inputNode.content || inputNode.summary || inputNode.title || '')
      : String(concept || '');
    const nodeTag = inputNode
      ? (inputNode.tag || inputNode.type || (Array.isArray(inputNode.tags) ? inputNode.tags[0] : null) || tag || 'general')
      : (tag || 'general');
    const nodeEmbedding = inputNode?.embedding || embedding;

    if (!conceptText.trim()) {
      this.logger?.warn?.('Skipping node with empty concept', { tag: nodeTag });
      return null;
    }

    // All nodes use same dimensions for network consistency when embeddings are
    // available. Memory Lite keeps the text node even when vectors are offline.
    const embed = this.normalizeEmbedding(nodeEmbedding || await this.embed(conceptText));

    if (!embed) {
      this.logger?.warn?.('Embedding unavailable; storing node in Memory Lite mode', {
        concept: conceptText.substring(0, 100),
        tag: nodeTag
      });
    }

    // Generate extractive summary if enabled
    let summary = null;
    let keyPhrase = null;
    
    if (this.config.coordinator?.useMemorySummaries && 
        this.config.coordinator?.extractiveSummarization) {
      try {
        const extracted = this.extractiveSummarizer.summarize(conceptText);
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

    const requestedNodeId = inputNode?.id;
    
    const provenance = classifyMemoryProvenance({
      ...inputNode,
      concept: conceptText,
      tag: nodeTag,
    });
    const metadata = inputNode?.metadata && typeof inputNode.metadata === 'object' ? { ...inputNode.metadata } : {};
    const storedProvenance = inputNode?.provenance && typeof inputNode.provenance === 'object'
      ? { ...inputNode.provenance }
      : {
          sourceClass: provenance.sourceClass,
          reason: provenance.reason,
          retention: provenance.retention,
        };

    const node = {
      id: null,
      concept: conceptText,
      summary,      // Compressed version for prompts
      keyPhrase,    // Ultra-compressed for quick reference
      tag: nodeTag,
      embedding: embed || null,
      embedding_status: embed ? 'embedded' : 'missing',
      activation: inputNode?.activation ?? 0,
      cluster: inputNode?.cluster ?? null,
      weight: inputNode?.weight ?? 1.0,
      created: inputNode?.created ? new Date(inputNode.created) : new Date(),
      accessed: inputNode?.accessed ? new Date(inputNode.accessed) : new Date(),
      accessCount: inputNode?.accessCount ?? 0,
      type: inputNode?.type || null,
      tags: Array.isArray(inputNode?.tags) ? inputNode.tags : [],
      metadata,
      source_class: inputNode?.source_class || inputNode?.sourceClass || metadata.source_class || provenance.sourceClass,
      salienceWeight: inputNode?.salienceWeight ?? metadata.salienceWeight ?? provenance.salienceWeight,
      provenance: storedProvenance,
      asserted_at: inputNode?.asserted_at || inputNode?.metadata?.asserted_at || null,
      asserted_cycle: inputNode?.asserted_cycle ?? inputNode?.metadata?.asserted_cycle ?? null,
      superseded_by: inputNode?.superseded_by || inputNode?.metadata?.superseded_by || null,
      confidence_decay: inputNode?.confidence_decay ?? inputNode?.metadata?.confidence_decay ?? null,
      status: inputNode?.status || inputNode?.metadata?.status || null
    };

    // Similarity and provenance work may call provider/logger code, so prepare
    // it before the no-yield mutation boundary. The graph is then published as
    // one synchronous accepted mutation: node, initial edges, cluster indexes,
    // dirty/tombstone state, and every corresponding generation advance.
    const initialConnections = this.findInitialConnections(node);
    const edgeTimestamp = new Date();
    let storedNode = null;
    this.withPersistenceBarrier(() => {
      if (requestedNodeId !== undefined && requestedNodeId !== null && !this.nodes.has(requestedNodeId)) {
        node.id = requestedNodeId;
        if (
          Number.isSafeInteger(requestedNodeId)
          && requestedNodeId >= this.nextNodeId
          && requestedNodeId < Number.MAX_SAFE_INTEGER
        ) {
          this.nextNodeId = requestedNodeId + 1;
        } else if (
          typeof requestedNodeId === 'string'
          && this.nodeIdFormat === 'string'
          && this.nodeIdPrefix
          && requestedNodeId.startsWith(`${this.nodeIdPrefix}_`)
        ) {
          const suffix = Number(requestedNodeId.slice(this.nodeIdPrefix.length + 1));
          if (Number.isSafeInteger(suffix) && suffix >= this.nextNodeId && suffix < Number.MAX_SAFE_INTEGER) {
            this.nextNodeId = suffix + 1;
          }
        }
      } else if (this.nodeIdFormat === 'string' && this.nodeIdPrefix) {
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
      concept: conceptText.substring(0, 50),
      cluster: storedNode.cluster
    });
    return storedNode;
  }

  /**
   * Remove a node and its edges from the network.
   * Used by the document feeder to remove stale chunks on re-ingestion.
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
   * Form initial connections based on similarity
   */
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

  async formInitialConnections(nodeId) {
    const node = this.nodes.get(nodeId);
    for (const { id, similarity } of this.findInitialConnections(node, nodeId)) {
      this.addEdge(nodeId, id, similarity * 0.5);
    }
  }

  /**
   * Add/reinforce edge between nodes (Hebbian learning)
   * FIXED: Now handles both numeric and string IDs (for merged runs)
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
  }

  _prepareNodePatch(patch) {
    const prepared = deepCloneJsonRecord(patch);
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
      throw new TypeError('node_patch_plain_object_required');
    }
    for (const forbidden of ['id', 'cluster', '__proto__', 'prototype', 'constructor']) {
      if (Object.prototype.hasOwnProperty.call(prepared, forbidden)) {
        throw new TypeError(`node_patch_forbidden_key:${forbidden}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(prepared, 'embedding')) {
      prepared.embedding = this.normalizeEmbedding(prepared.embedding);
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
    const expected = options.expected === undefined ? null : deepCloneJsonRecord(options.expected);
    for (const key of expected ? Reflect.ownKeys(expected) : []) {
      if (!jsonPersistenceValuesEqual(this._dataPropertyValue(stored, key), expected[key])) return null;
    }
    const preparedPatch = this._prepareNodePatch(patch);
    const isNoOp = Reflect.ownKeys(preparedPatch).every((key) => (
      jsonPersistenceValuesEqual(this._dataPropertyValue(stored, key), preparedPatch[key])
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
        : deepCloneJsonRecord(entry.expected);
      if (expected && (typeof expected !== 'object' || Array.isArray(expected))) {
        throw new TypeError('node_patch_expected_plain_object_required');
      }
      let expectedMatches = true;
      for (const key of expected ? Reflect.ownKeys(expected) : []) {
        if (!jsonPersistenceValuesEqual(this._dataPropertyValue(stored, key), expected[key])) {
          expectedMatches = false;
          break;
        }
      }
      if (!expectedMatches) continue;

      const patch = this._prepareNodePatch(entry.patch);
      const updates = [];
      for (const key of Reflect.ownKeys(patch)) {
        const value = patch[key];
        if (!jsonPersistenceValuesEqual(this._dataPropertyValue(stored, key), value)) {
          updates.push([key, value]);
        }
      }
      if (updates.length === 0) continue;
      preparedEntries.push({
        nodeId: entry.nodeId,
        stored,
        expected,
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

  importGraphChanges(changes = {}) {
    const nodeRecords = new Map();
    for (const rawNode of Array.from(changes.nodes || [])) {
      const clonedInput = deepCloneJsonRecord(rawNode);
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
      if (Object.prototype.hasOwnProperty.call(node, 'embedding')) {
        node.embedding = this.normalizeEmbedding(node.embedding);
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
      const clonedInput = deepCloneJsonRecord(rawEdge);
      const isTuple = Array.isArray(clonedInput) && clonedInput.length === 2;
      let edgeKey = isTuple ? clonedInput[0] : clonedInput?.id;
      const edge = isTuple ? clonedInput[1] : clonedInput;
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) continue;
      for (const timestampField of ['created', 'accessed']) {
        if (!Object.prototype.hasOwnProperty.call(edge, timestampField) || !edge[timestampField]) continue;
        const timestamp = new Date(edge[timestampField]);
        if (!Number.isNaN(timestamp.getTime())) edge[timestampField] = timestamp;
      }
      let endpointA = edge.source ?? edge.from;
      let endpointB = edge.target ?? edge.to;
      if ((endpointA === undefined || endpointB === undefined) && edgeKey) {
        const parts = String(edgeKey).split('->');
        endpointA = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
        endpointB = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
      }
      if (endpointA === undefined || endpointB === undefined || endpointA === endpointB) continue;
      const sorted = [endpointA, endpointB].sort((a, b) => String(a).localeCompare(String(b)));
      edgeKey = sorted.join('->');
      edge.source = sorted[0];
      edge.target = sorted[1];
      delete edge.id;
      edgeRecords.set(edgeKey, edge);
    }

    const clusterRecords = new Map();
    for (const rawCluster of Array.from(changes.clusters || [])) {
      const clonedInput = deepCloneJsonRecord(rawCluster);
      const isTuple = Array.isArray(clonedInput) && clonedInput.length === 2;
      const clusterId = isTuple ? clonedInput[0] : clonedInput?.id;
      const members = isTuple ? clonedInput[1] : clonedInput?.nodes;
      if (clusterId === undefined || clusterId === null || !members) continue;
      clusterRecords.set(clusterId, new Set(Array.from(members)));
    }

    const nodeDeletes = Array.from(new Set(changes.nodeDeletes || changes.removedNodeIds || []));
    const edgeDeletes = Array.from(new Set(changes.edgeDeletes || changes.removedEdgeKeys || []));
    const clusterDeletes = Array.from(new Set(changes.clusterDeletes || changes.removedClusterIds || []));

    const preparedNodes = Array.from(nodeRecords, ([nodeId, node]) => ({
      nodeId,
      node,
      existing: this.nodes.get(nodeId),
    })).filter(({ nodeId, node, existing }) => (
      !nodeDeletes.includes(nodeId) && (!existing || !jsonPersistenceValuesEqual(existing, node))
    ));
    const preparedEdges = Array.from(edgeRecords, ([edgeKey, edge]) => ({
      edgeKey,
      edge,
      existing: this.edges.get(edgeKey),
    })).filter(({ edgeKey, edge, existing }) => (
      !edgeDeletes.includes(edgeKey) && (!existing || !jsonPersistenceValuesEqual(existing, edge))
    ));
    const preparedClusters = Array.from(clusterRecords, ([clusterId, members]) => ({
      clusterId,
      members,
      existing: this.clusters.get(clusterId),
    })).filter(({ clusterId, members, existing }) => {
      if (clusterDeletes.includes(clusterId)) return false;
      if (!(existing instanceof Set) || existing.size !== members.size) return true;
      return Array.from(members).some((nodeId) => (
        !existing.has(nodeId) || this.nodes.get(nodeId)?.cluster != clusterId
      ));
    });

    const hasRequestedDeletes = nodeDeletes.some((nodeId) => (
      this.nodes.has(nodeId) || !this.deletedNodeIds.has(nodeId)
    ))
      || edgeDeletes.some((edgeKey) => (
        this.edges.has(edgeKey) || !this.deletedEdgeKeys.has(edgeKey)
      ))
      || clusterDeletes.some((clusterId) => this.clusters.has(clusterId));
    if (
      preparedNodes.length === 0
      && preparedEdges.length === 0
      && preparedClusters.length === 0
      && !hasRequestedDeletes
    ) {
      return {
        importedNodes: 0,
        importedEdges: 0,
        importedClusters: 0,
        removedNodes: 0,
        removedEdges: 0,
        removedClusters: 0,
      };
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
        if (removed) {
          removedNodes += 1;
          removedEdges += removed.removedEdges;
        } else if (!this.deletedNodeIds.has(nodeId)) {
          this.dirtyNodeIds.delete(nodeId);
          this.deletedNodeIds.add(nodeId);
          this._advancePersistenceGenerationUnsafe();
        }
      }
      for (const edgeKey of edgeDeletes) {
        if (this._deleteEdgeKeyUnsafe(edgeKey)) {
          removedEdges += 1;
        } else if (!this.deletedEdgeKeys.has(edgeKey)) {
          this.dirtyEdgeKeys.delete(edgeKey);
          this.deletedEdgeKeys.add(edgeKey);
          this._advancePersistenceGenerationUnsafe();
        }
      }
      for (const clusterId of clusterDeletes) {
        const members = this.clusters.get(clusterId);
        if (!members || !this.clusters.delete(clusterId)) continue;
        removedClusters += 1;
        for (const nodeId of members) {
          const node = this.nodes.get(nodeId);
          if (!node || node.cluster != clusterId) continue;
          node.cluster = null;
          this._markNodeDirtyUnsafe(nodeId);
        }
      }

      for (const prepared of preparedNodes) {
        const current = this.nodes.get(prepared.nodeId);
        const previousCluster = current?.cluster;
        if (
          previousCluster !== null
          && previousCluster !== undefined
          && previousCluster !== prepared.node.cluster
        ) {
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
        const validMembers = new Set(
          Array.from(prepared.members).filter((nodeId) => this.nodes.has(nodeId)),
        );
        const removedMembers = current instanceof Set
          ? Array.from(current).filter((nodeId) => !validMembers.has(nodeId))
          : [];
        this.clusters.set(prepared.clusterId, validMembers);
        for (const nodeId of removedMembers) {
          const node = this.nodes.get(nodeId);
          if (!node || node.cluster != prepared.clusterId) continue;
          node.cluster = null;
          this._markNodeDirtyUnsafe(nodeId);
        }
        for (const nodeId of validMembers) {
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
        }
        importedClusters += 1;
      }

      // Allocator positions are derived cache, not independent durable
      // mutations. Advance them only from state represented by accepted nodes
      // or node tombstones, and do not manufacture another persistence
      // generation for the derived assignment itself. In particular, an
      // absent cluster deletion has no durable tombstone and cannot reserve an
      // otherwise-free cluster identity.
      let targetNextNodeId = nextSafeIntegerAfter(this.nodes.keys(), this.nextNodeId);
      targetNextNodeId = nextSafeIntegerAfter(this.deletedNodeIds, targetNextNodeId);
      if (targetNextNodeId > this.nextNodeId) this.nextNodeId = targetNextNodeId;

      let targetNextClusterId = this.nextClusterId;
      for (const node of this.nodes.values()) {
        const clusterId = node?.cluster;
        if (Number.isSafeInteger(clusterId)
            && clusterId >= targetNextClusterId
            && clusterId < Number.MAX_SAFE_INTEGER) {
          targetNextClusterId = clusterId + 1;
        }
      }
      if (targetNextClusterId > this.nextClusterId) this.nextClusterId = targetNextClusterId;

      return {
        importedNodes,
        importedEdges,
        importedClusters,
        removedNodes,
        removedEdges,
        removedClusters,
      };
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

  markNodeDirty(nodeId) {
    if (!this.nodes.has(nodeId)) return false;
    return this.withPersistenceBarrier(() => {
      if (!this.nodes.has(nodeId)) return false;
      this._markNodeDirtyUnsafe(nodeId);
      return true;
    });
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

  markEdgeDirty(edgeKey) {
    if (!this.edges.has(edgeKey)) return false;
    return this.withPersistenceBarrier(() => {
      if (!this.edges.has(edgeKey)) return false;
      this._markEdgeDirtyUnsafe(edgeKey);
      return true;
    });
  }

  _requirePersistenceBarrierUnsafe() {
    if (!this.persistenceBarrierActive) {
      throw new Error('persistence_barrier_required');
    }
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

  _removeNodeUnsafe(nodeId) {
    this._requirePersistenceBarrierUnsafe();
    if (!this.nodes.has(nodeId)) return null;
    this.nodes.delete(nodeId);
    this.dirtyNodeIds.delete(nodeId);
    this.deletedNodeIds.add(nodeId);
    this._advancePersistenceGenerationUnsafe();

    let removedEdges = 0;
    for (const [key, edge] of this.edges) {
      let source = edge?.source ?? edge?.from;
      let target = edge?.target ?? edge?.to;
      if (source === undefined || target === undefined) {
        const parts = String(key).split('->');
        source = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
        target = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
      }
      if (source == nodeId || target == nodeId) {
        if (this._deleteEdgeKeyUnsafe(key)) removedEdges += 1;
      }
    }
    for (const [clusterId, members] of this.clusters) {
      members.delete(nodeId);
      if (members.size === 0) this.clusters.delete(clusterId);
    }
    return { nodeId, removedEdges };
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
    const nodeStr = String(nodeId);
    const bridges = [];
    for (const [key, edge] of this.edges) {
      if (edge.type !== 'bridge') continue;
      if (String(edge.source) === nodeStr || String(edge.target) === nodeStr) {
        bridges.push([key, edge]);
      }
    }
    if (bridges.length < cap) return null;
    bridges.sort((a, b) => a[1].weight - b[1].weight);
    const toEvict = bridges.length - (cap - 1);
    let evicted = 0;
    for (let index = 0; index < toEvict; index += 1) {
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
      existing.weight = Math.min(1.0, existing.weight + weight);
      existing.accessed = timestamp;
      if (type !== 'associative' && existing.type !== type) existing.type = type;
      this._markEdgeDirtyUnsafe(edgeKey);
      return { edgeKey, evictions, inserted: false };
    }

    // Fan-out cap eviction is part of the same atomic mutation as the bridge
    // insertion, including tombstones and one generation per deleted edge.
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

  withPersistenceBarrier(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('persistence_barrier_callback_required');
    }
    if (Object.prototype.toString.call(callback) === '[object AsyncFunction]') {
      throw new Error('persistence_barrier_async_callback');
    }
    return this._runPersistenceBarrier(callback);
  }

  _runPersistenceBarrier(callback) {
    if (this.persistenceBarrierActive) {
      throw new Error('persistence_barrier_reentry');
    }
    this.persistenceBarrierActive = true;
    try {
      const result = callback();
      if (isThenableWithoutInvocation(result)) {
        throw new Error('persistence_barrier_async_callback');
      }
      return result;
    } finally {
      this.persistenceBarrierActive = false;
    }
  }

  hasPersistenceChanges() {
    return this.dirtyNodeIds.size > 0 ||
      this.dirtyEdgeKeys.size > 0 ||
      this.deletedNodeIds.size > 0 ||
      this.deletedEdgeKeys.size > 0;
  }

  getPersistenceChanges() {
    return this._getPersistenceChangesUnsafe();
  }

  _getPersistenceChangesUnsafe() {
    const nodes = Array.from(this.dirtyNodeIds)
      .map((id) => this.nodes.get(id))
      .filter(Boolean)
      .map((node) => serializeNodePersistenceRecord(node));
    const edges = Array.from(this.dirtyEdgeKeys)
      .map((key) => {
        const edge = this.edges.get(key);
        return edge ? serializeEdgePersistenceRecord(key, edge) : null;
      })
      .filter(Boolean);
    const changes = {
      nodes,
      edges,
      removedNodeIds: Array.from(this.deletedNodeIds),
      removedEdgeKeys: Array.from(this.deletedEdgeKeys),
      revision: this.persistenceRevision,
    };
    return changes;
  }

  consumePersistenceChanges() {
    return this.withPersistenceBarrier(() => {
      const changes = this._getPersistenceChangesUnsafe();
      this._markPersistenceCleanUnsafe();
      return changes;
    });
  }

  markPersistenceClean() {
    return this.withPersistenceBarrier(() => this._markPersistenceCleanUnsafe());
  }

  _markPersistenceCleanUnsafe() {
    this._requirePersistenceBarrierUnsafe();
    this.dirtyNodeIds.clear();
    this.dirtyEdgeKeys.clear();
    this.deletedNodeIds.clear();
    this.deletedEdgeKeys.clear();
  }

  capturePersistenceSnapshot() {
    return this.withPersistenceBarrier(() => {
      const nodes = Array.from(this.nodes.values())
        .map((node) => serializeNodePersistenceRecord(node));
      const edges = Array.from(this.edges.entries())
        .map(([key, edge]) => serializeEdgePersistenceRecord(key, edge));
      const changes = deepCloneJsonRecord(this._getPersistenceChangesUnsafe());
      return deepFreezeJson({
        generation: this.persistenceGeneration,
        changes,
        fullView: { nodes, edges },
        summary: summarizePersistenceView(nodes, edges),
      });
    });
  }

  capturePersistenceChangesSnapshot() {
    return this.withPersistenceBarrier(() => {
      const changes = deepCloneJsonRecord(this._getPersistenceChangesUnsafe());
      const clusterCount = new Set(
        Array.from(this.nodes.values())
          .map((node) => node.cluster)
          .filter((cluster) => cluster !== null && cluster !== undefined),
      ).size;
      return deepFreezeJson({
        generation: this.persistenceGeneration,
        changes: {
          nodes: changes.nodes || [],
          edges: changes.edges || [],
          removedNodeIds: changes.removedNodeIds || [],
          removedEdgeKeys: changes.removedEdgeKeys || [],
        },
        summary: {
          nodeCount: this.nodes?.size || 0,
          edgeCount: this.edges?.size || 0,
          clusterCount,
        },
      });
    });
  }

  markPersistenceCleanIfGeneration(expectedGeneration) {
    return this.withPersistenceBarrier(() => {
      if (!Number.isSafeInteger(expectedGeneration) || this.persistenceGeneration !== expectedGeneration) {
        return false;
      }
      this._markPersistenceCleanUnsafe();
      return true;
    });
  }

  /**
   * If `nodeId` already holds `cap` or more bridge edges, evict the weakest
   * one(s) to make room. O(E) per call; called only when inserting bridges,
   * which happens during sleep/dream — not on the hot path.
   */
  enforceBridgeCap(nodeId, cap) {
    if (!cap || cap <= 0) return 0;
    const result = this.withPersistenceBarrier(() => this._enforceBridgeCapUnsafe(nodeId, cap));
    if (!result) return 0;
    this.logger?.debug?.('Bridge cap enforced', result);
    return result.evicted;
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
        
        // Bridge edges are Watts-Strogatz dream shortcuts (random cross-cluster
        // rewires), not semantic associations. Damp their pull on wake-state
        // retrieval so traversals stay on-topic. Bridges still participate in
        // dream cycles at full weight — this only affects spreadActivation.
        const typeFactor = edge.type === 'bridge'
          ? (this.config.spreading.bridgeTraversalFactor ?? 0.2)
          : 1.0;
        const newActivation = activation * edge.weight * decay * typeFactor;

        if (newActivation >= threshold) {
          queue.push({
            nodeId: neighborId,
            activation: newActivation,
            depth: currentDepth + 1
          });
        }
      }
    }
    
    // Cross-brain/read-only queries consume the returned activation map and
    // never mutate the source graph. Mutable own-brain callers retain the
    // historical live activation update, now covered by the persistence CAS.
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
    
    if (!queryEmbedding) {
      this.logger?.warn?.('Query embedding failed, using Memory Lite keyword retrieval', {
        queryText: queryText?.substring(0, 100)
      });
      return this.queryByKeyword(queryText, topK, options);
    }
    
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
    
    if (!bestMatch) return this.queryByKeyword(queryText, topK, options);
    
    // Spread activation from best match
    const mutableAccess = options.markAccess !== false && options.accessMode !== 'read-only';
    const activated = await this.spreadActivation(bestMatch, null, { mutate: mutableAccess });
    
    const queryWords = this.extractQueryWords(queryText);
    const snapshotCandidates = this.findRelevantStateSnapshots(queryEmbedding, queryWords, bestSimilarity);
    const scored = Array.from(activated.entries())
      .map(([id, activation]) => ({
        ...this.nodes.get(id),
        similarity: id === bestMatch ? bestSimilarity : activation,
        activation,
        retrievalScore: this.scoreTemporalRetrieval(this.nodes.get(id), activation, {
          isBestMatch: id === bestMatch,
          baseSimilarity: id === bestMatch ? bestSimilarity : activation,
        })
      }));

    for (const candidate of snapshotCandidates) {
      if (!scored.some(n => n.id === candidate.id)) {
        scored.push(candidate);
      }
    }

    for (const candidate of this.queryByKeyword(queryText, topK, { markAccess: false, retrievalMode: 'keyword-supplement' })) {
      if (!scored.some(n => n.id === candidate.id)) {
        scored.push(candidate);
      }
    }

    // Return top K nodes by relevance plus temporal validity. State snapshots
    // are allowed to beat older cue-matched nodes so the brain orients to now.
    const results = scored
      .sort((a, b) => (b.retrievalScore ?? b.activation) - (a.retrievalScore ?? a.activation))
      .slice(0, topK);
    
    // Mark as accessed and boost weight
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

  extractQueryWords(queryText) {
    return String(queryText || '')
      .toLowerCase()
      .split(/[^a-z0-9_:-]+/)
      .filter(word => word.length >= 3);
  }

  keywordScoreNode(node, queryText, queryWords = null) {
    if (!node) return 0;
    const words = queryWords || this.extractQueryWords(queryText);
    if (words.length === 0) return 0;

    const concept = String(node.concept || '').toLowerCase();
    const tag = String(node.tag || '').toLowerCase();
    const tags = Array.isArray(node.tags) ? node.tags.join(' ').toLowerCase() : '';
    const metadata = node.metadata && typeof node.metadata === 'object'
      ? Object.values(node.metadata).filter(value => typeof value === 'string').join(' ').toLowerCase()
      : '';
    const haystack = `${concept} ${tag} ${tags} ${metadata}`;
    const phrase = String(queryText || '').trim().toLowerCase();

    let score = phrase && concept.includes(phrase) ? 0.45 : 0;
    let matched = 0;
    for (const word of words) {
      if (haystack.includes(word)) {
        matched += 1;
        score += concept.includes(word) ? 0.16 : 0.08;
      }
    }
    if (matched === 0) return 0;
    score += Math.min(0.2, matched / words.length * 0.2);
    return Math.min(1, score);
  }

  queryByKeyword(queryText, topK = 5, options = {}) {
    const queryWords = this.extractQueryWords(queryText);
    if (queryWords.length === 0) return [];

    const results = Array.from(this.nodes.values())
      .map((node) => {
        const keywordScore = this.keywordScoreNode(node, queryText, queryWords);
        if (keywordScore <= 0) return null;
        return {
          ...node,
          similarity: keywordScore,
          activation: keywordScore,
          retrievalMode: options.retrievalMode || 'keyword',
          retrievalScore: this.scoreTemporalRetrieval(node, keywordScore, { baseSimilarity: keywordScore }) + Math.min(0.15, keywordScore * 0.1),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const scoreDelta = (b.retrievalScore || 0) - (a.retrievalScore || 0);
        if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
        return this.nodeTimeMs(b) - this.nodeTimeMs(a);
      })
      .slice(0, topK);

    if (options.markAccess !== false && options.accessMode !== 'read-only') {
      this.recordNodeAccess(results.map(node => node.id), { weightBoost: 0.05 });
    }

    return results;
  }

  isStateSnapshotNode(node) {
    if (!node) return false;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    return node.tag === 'state_snapshot' ||
      node.type === 'state_snapshot' ||
      tags.includes('state_snapshot') ||
      node.metadata?.kind === 'state_snapshot';
  }

  nodeTimeMs(node) {
    const value = node?.asserted_at || node?.metadata?.asserted_at || node?.created;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  temporalFreshness(node, now = Date.now()) {
    const ms = this.nodeTimeMs(node);
    if (!ms) return 0.55;
    const ageDays = Math.max(0, (now - ms) / 86400000);
    const halfLifeDays = Number(this.config?.retrieval?.temporalHalfLifeDays) || 14;
    return Math.max(0.2, Math.exp(-ageDays / halfLifeDays));
  }

  statusMultiplier(node) {
    if (node?.superseded_by || node?.metadata?.superseded_by) return 0.25;
    const status = String(node?.status || node?.metadata?.status || '').toLowerCase();
    if (['resolved', 'completed', 'archived', 'superseded', 'stale'].includes(status)) return 0.35;
    return 1;
  }

  scoreTemporalRetrieval(node, baseScore, opts = {}) {
    const freshness = this.temporalFreshness(node, opts.nowMs);
    const status = this.statusMultiplier(node);
    const snapshotBoost = this.isStateSnapshotNode(node) ? 0.75 : 0;
    const bestMatchBoost = opts.isBestMatch ? 0.05 : 0;
    const decay = typeof node?.confidence_decay === 'number'
      ? Math.max(0.1, Math.min(1, node.confidence_decay))
      : 1;
    const temporalScore = (baseScore * (0.65 + 0.35 * freshness) * status * decay) + bestMatchBoost;
    return scoreMemorySalience(node, temporalScore, opts) + snapshotBoost;
  }

  findRelevantStateSnapshots(queryEmbedding, queryWords, bestSimilarity) {
    const candidates = [];
    for (const node of this.nodes.values()) {
      if (!this.isStateSnapshotNode(node) || !node.embedding) continue;
      const conceptLower = String(node.concept || '').toLowerCase();
      const overlap = queryWords.reduce((sum, word) => sum + (conceptLower.includes(word) ? 1 : 0), 0);
      const similarity = this.cosineSimilarity(queryEmbedding, node.embedding);
      const relevant = overlap > 0 || similarity >= Math.max(0.2, bestSimilarity * 0.65);
      if (!relevant) continue;
      candidates.push({
        ...node,
        similarity,
        activation: similarity,
        retrievalScore: this.scoreTemporalRetrieval(node, similarity, { baseSimilarity: similarity }) + Math.min(0.25, overlap * 0.05),
      });
    }
    return candidates.sort((a, b) => {
      const scoreDelta = (b.retrievalScore || 0) - (a.retrievalScore || 0);
      if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
      return this.nodeTimeMs(b) - this.nodeTimeMs(a);
    }).slice(0, 3);
  }

  /**
   * Query peripheral (less-activated) nodes for diversity
   */
  async queryPeripheral(queryText, topK = 3) {
    if (this.nodes.size === 0) return [];
    
    const queryEmbedding = await this.embed(queryText);
    if (!queryEmbedding) return this.queryByKeyword(queryText, topK, { retrievalMode: 'keyword-peripheral' });
    
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
    const bridgeVote = this.config.spreading.bridgeTraversalFactor ?? 0.2;
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
        // Associative edges are full-weight evidence of cluster belonging.
        // Bridges are random long-range shortcuts — count them fractionally
        // so they don't overpower semantic signal in cluster assignment.
        const vote = edge?.type === 'bridge' ? bridgeVote : 1.0;
        clusterScores.set(
          neighbor.cluster,
          (clusterScores.get(neighbor.cluster) || 0) + vote
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
        createdMissingCluster = true;
        this.clusters.set(clusterId, new Set());
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
    let scanned = 0;
    const yieldEvery = Number(this.config.smallWorld?.rewireYieldEvery) || 1000;
    for (const [edgeKey, edge] of this.edges) {
      if (edge.weight < 0.1) {
        if (this._removeEdgeKey(edgeKey)) pruned++;
      }
      scanned++;
      if (yieldEvery > 0 && scanned % yieldEvery === 0) {
        await yieldToEventLoop();
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
      cosmoEvents.emitDreamRewiring({
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
    let processed = 0;
    const maxEdgesPerRun = Number(this.config.smallWorld?.maxRewireEdgesPerRun) || 5000;
    const yieldEvery = Number(this.config.smallWorld?.rewireYieldEvery) || 500;
    const bridgeCap = Number(this.config.smallWorld?.maxBridgesPerNode ?? 40);
    const bridgeCounts = new Map();
    if (bridgeCap > 0) {
      for (const edge of this.edges.values()) {
        if (edge?.type !== 'bridge') continue;
        bridgeCounts.set(String(edge.source), (bridgeCounts.get(String(edge.source)) || 0) + 1);
        bridgeCounts.set(String(edge.target), (bridgeCounts.get(String(edge.target)) || 0) + 1);
      }
    }
    const canAddBridge = (nodeA, nodeB) => {
      if (!bridgeCap || bridgeCap <= 0) return true;
      return (bridgeCounts.get(String(nodeA)) || 0) < bridgeCap
        && (bridgeCounts.get(String(nodeB)) || 0) < bridgeCap;
    };
    const noteBridge = (nodeA, nodeB) => {
      if (!bridgeCap || bridgeCap <= 0) return;
      bridgeCounts.set(String(nodeA), (bridgeCounts.get(String(nodeA)) || 0) + 1);
      bridgeCounts.set(String(nodeB), (bridgeCounts.get(String(nodeB)) || 0) + 1);
    };
    
    // Iterate over copy of edges to avoid concurrent modification
    const edgesToProcess = Array.from(this.edges.entries());
    
    for (const [edgeKey, edge] of edgesToProcess) {
      if (maxEdgesPerRun > 0 && processed >= maxEdgesPerRun) break;
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

      processed++;
      if (yieldEvery > 0 && processed % yieldEvery === 0) {
        await yieldToEventLoop();
      }
      
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
        if (nodeC !== null && canAddBridge(nodeA, nodeC)) {
          // Remove the current edge only after the replacement is known valid.
          this.removeEdge(nodeA, nodeB);

          const newWeight = Math.min(0.3, edge.weight); // Moderate weight for new connections
          this.addEdge(nodeA, nodeC, newWeight, 'bridge', { enforceBridgeCap: false });
          noteBridge(nodeA, nodeC);
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

    if (maxEdgesPerRun > 0 && processed >= maxEdgesPerRun && edgesToProcess.length > processed) {
      this.logger?.info?.('Watts-Strogatz rewiring capped for engine responsiveness', {
        processedEdges: processed,
        totalCandidateEdges: edgesToProcess.length,
        maxEdgesPerRun,
        rewired,
      });
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
    
    const nodeUpdates = [];
    for (const [id, node] of this.nodes) {
      // Skip decay for protected tags
      if (exemptTags.includes(node.tag)) {
        continue;
      }
      
      const age = (now - node.accessed) / 1000; // seconds
      
      if (age > decayInterval) {
        const weight = node.weight * factor;
        if (!Object.is(weight, node.weight)) nodeUpdates.push({ id, node, weight });
      }
    }
    
    // Also decay edges. Bridges (Watts-Strogatz dream shortcuts) age on a
    // shorter window than semantic/associative edges so they drain naturally
    // instead of accumulating indefinitely. Associative edges keep the
    // original slower decay so real semantic structure survives.
    const edgeUpdates = [];
    if (this.config.hebbian.enabled) {
      const assocAgeThreshold = decayInterval * 2;
      const bridgeAgeThreshold = this.config.decay.bridgeDecayInterval ?? decayInterval;
      for (const [key, edge] of this.edges) {
        const age = (now - edge.accessed) / 1000;
        const threshold = edge.type === 'bridge' ? bridgeAgeThreshold : assocAgeThreshold;
        if (age > threshold) {
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
    if (!a || !b || !isVectorLike(a) || !isVectorLike(b)) {
      this.logger?.warn?.('Cosine similarity called with invalid inputs', {
        a: typeof a,
        b: typeof b,
        aIsVector: isVectorLike(a),
        bIsVector: isVectorLike(b)
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
        embedding: this.serializeEmbedding(n.embedding), // CRITICAL: Include embeddings for memory persistence
        embedding_status: n.embedding_status,
        weight: n.weight,
        activation: n.activation,
        cluster: n.cluster,
        accessCount: n.accessCount,
        created: n.created,
        accessed: n.accessed,
        type: n.type,
        tags: n.tags,
        metadata: n.metadata,
        source_class: n.source_class,
        salienceWeight: n.salienceWeight,
        provenance: n.provenance,
        asserted_at: n.asserted_at,
        asserted_cycle: n.asserted_cycle,
        superseded_by: n.superseded_by,
        confidence_decay: n.confidence_decay,
        status: n.status,
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

  exportPersistenceShell() {
    return {
      nodes: [],
      edges: [],
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
    const state = this.withPersistenceBarrier(() => {
      const nodes = new Map();
      const nodeEntries = [];
      for (const [nodeId, rawNode] of Map.prototype.entries.call(this.nodes)) {
        requireLegacyGraphIdentity(nodeId, 'network_save_invalid_node');
        const node = serializeNodePersistenceRecord(rawNode);
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
          throw new TypeError('network_save_invalid_node');
        }
        const recordId = readOwnDataProperty(node, 'id', 'network_save_invalid_node');
        if (recordId.present && !Object.is(recordId.value, nodeId)) {
          throw new Error('network_save_identity_mismatch');
        }
        Object.defineProperty(node, 'id', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: nodeId,
        });
        Map.prototype.set.call(nodes, nodeId, node);
        nodeEntries.push([nodeId, node]);
      }

      const edgeEntries = [];
      for (const [edgeKey, rawEdge] of Map.prototype.entries.call(this.edges)) {
        const edge = deepCloneJsonRecord(rawEdge);
        const identity = validateLegacyEdgeRecord(edgeKey, edge, nodes, 'network_save');
        edge.source = identity.source;
        edge.target = identity.target;
        delete edge.id;
        edgeEntries.push([edgeKey, edge]);
      }

      return deepFreezeJson({
        nodes: nodeEntries,
        edges: edgeEntries,
        clusters: serializeLegacyClusterEntries(this.clusters, nodes),
        nextNodeId: this.nextNodeId,
        nextClusterId: this.nextClusterId,
        nodeIdFormat: this.nodeIdFormat,
        nodeIdPrefix: this.nodeIdPrefix,
      });
    });
    const encoded = JSON.stringify(state, null, 2);
    
    await fs.promises.writeFile(filepath, encoded);
    this.logger?.info('Network saved', { filepath, nodes: state.nodes.length });
    return { saved: true, nodes: state.nodes.length, edges: state.edges.length };
  }

  _prepareLegacyLoadedState(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
        || !Array.isArray(data.clusters)) {
      throw new TypeError('network_load_invalid_state');
    }
    const nodes = new Map();
    for (const tuple of data.nodes) {
      if (!Array.isArray(tuple) || tuple.length !== 2) throw new TypeError('network_load_invalid_node');
      const [nodeId, rawNode] = tuple;
      requireLegacyGraphIdentity(nodeId, 'network_load_invalid_node');
      if (Map.prototype.has.call(nodes, nodeId)) throw new Error('network_load_duplicate_node');
      const node = deepCloneJsonRecord(rawNode);
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new TypeError('network_load_invalid_node');
      }
      const recordId = readOwnDataProperty(node, 'id', 'network_load_invalid_node');
      if (recordId.present && !Object.is(recordId.value, nodeId)) {
        throw new Error('network_load_identity_mismatch');
      }
      Object.defineProperty(node, 'id', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: nodeId,
      });
      if (Object.prototype.hasOwnProperty.call(node, 'embedding')) {
        node.embedding = this.normalizeEmbedding(node.embedding);
      }
      for (const field of ['created', 'accessed']) {
        if (node[field] === null || node[field] === undefined) continue;
        const timestamp = new Date(node[field]);
        if (Number.isNaN(timestamp.getTime())) throw new TypeError('network_load_invalid_timestamp');
        node[field] = timestamp;
      }
      Map.prototype.set.call(nodes, nodeId, node);
    }

    const edges = new Map();
    for (const tuple of data.edges) {
      if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || !tuple[0]) {
        throw new TypeError('network_load_invalid_edge');
      }
      const edgeKey = tuple[0];
      if (Map.prototype.has.call(edges, edgeKey)) throw new Error('network_load_duplicate_edge');
      const edge = deepCloneJsonRecord(tuple[1]);
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
        throw new TypeError('network_load_invalid_edge');
      }
      const identity = validateLegacyEdgeRecord(edgeKey, edge, nodes, 'network_load');
      edge.source = identity.source;
      edge.target = identity.target;
      delete edge.id;
      for (const field of ['created', 'accessed']) {
        if (edge[field] === null || edge[field] === undefined) continue;
        const timestamp = new Date(edge[field]);
        if (Number.isNaN(timestamp.getTime())) throw new TypeError('network_load_invalid_timestamp');
        edge[field] = timestamp;
      }
      Map.prototype.set.call(edges, edgeKey, edge);
    }

    const clusters = buildLegacyClusterMap(data.clusters, nodes);

    let nodeIdFormat = data.nodeIdFormat === 'string' ? 'string' : 'numeric';
    let nodeIdPrefix = typeof data.nodeIdPrefix === 'string' && data.nodeIdPrefix
      ? data.nodeIdPrefix
      : null;
    if (nodeIdFormat === 'string' && !nodeIdPrefix) nodeIdFormat = 'numeric';
    let derivedNextNodeId = nextSafeIntegerAfter(nodes.keys(), 1);
    if (nodeIdFormat === 'string' && nodeIdPrefix) {
      for (const nodeId of nodes.keys()) {
        if (typeof nodeId !== 'string' || !nodeId.startsWith(`${nodeIdPrefix}_`)) continue;
        const suffix = Number(nodeId.slice(nodeIdPrefix.length + 1));
        if (Number.isSafeInteger(suffix) && suffix >= derivedNextNodeId
            && suffix < Number.MAX_SAFE_INTEGER) derivedNextNodeId = suffix + 1;
      }
    }
    const derivedNextClusterId = nextSafeIntegerAfter(clusters.keys(), 1);
    const nextNodeId = Number.isSafeInteger(data.nextNodeId) && data.nextNodeId >= derivedNextNodeId
      ? data.nextNodeId
      : derivedNextNodeId;
    const nextClusterId = Number.isSafeInteger(data.nextClusterId)
      && data.nextClusterId >= derivedNextClusterId
      ? data.nextClusterId
      : derivedNextClusterId;
    return { nodes, edges, clusters, nextNodeId, nextClusterId, nodeIdFormat, nodeIdPrefix };
  }

  _legacyLoadedStateMatchesUnsafe(prepared) {
    this._requirePersistenceBarrierUnsafe();
    if (this.nodes.size !== prepared.nodes.size || this.edges.size !== prepared.edges.size
        || this.clusters.size !== prepared.clusters.size
        || this.nextNodeId !== prepared.nextNodeId || this.nextClusterId !== prepared.nextClusterId
        || this.nodeIdFormat !== prepared.nodeIdFormat || this.nodeIdPrefix !== prepared.nodeIdPrefix) {
      return false;
    }
    for (const [id, node] of prepared.nodes) {
      if (!this.nodes.has(id) || !jsonPersistenceValuesEqual(this.nodes.get(id), node)) return false;
    }
    for (const [key, edge] of prepared.edges) {
      if (!this.edges.has(key) || !jsonPersistenceValuesEqual(this.edges.get(key), edge)) return false;
    }
    for (const [clusterId, members] of prepared.clusters) {
      const current = this.clusters.get(clusterId);
      if (!(current instanceof Set) || current.size !== members.size) return false;
      for (const nodeId of members) if (!current.has(nodeId)) return false;
    }
    return true;
  }

  /**
   * Load network state
   */
  async load(filepath, options = {}) {
    if (hasActiveClusterWrapper(this.nodes)
        || hasActiveClusterWrapper(this.edges)
        || hasActiveClusterWrapper(this.clusters)) {
      throw new Error('network_load_cluster_wrapper_active');
    }
    try {
      const data = JSON.parse(await fs.promises.readFile(filepath, 'utf8'));
      const prepared = this._prepareLegacyLoadedState(data);
      const allowDirtyReplacement = options?.allowDirtyReplacement === true;
      const result = this.withPersistenceBarrier(() => {
        if (hasActiveClusterWrapper(this.nodes)
            || hasActiveClusterWrapper(this.edges)
            || hasActiveClusterWrapper(this.clusters)) {
          throw new Error('network_load_cluster_wrapper_active');
        }
        if (this._legacyLoadedStateMatchesUnsafe(prepared)) {
          return { loaded: false, reason: 'unchanged', generation: this.persistenceGeneration };
        }
        const hasPending = this.dirtyNodeIds.size > 0 || this.dirtyEdgeKeys.size > 0
          || this.deletedNodeIds.size > 0 || this.deletedEdgeKeys.size > 0;
        if (hasPending && !allowDirtyReplacement) {
          throw new Error('network_load_dirty_state');
        }
        Map.prototype.clear.call(this.nodes);
        Map.prototype.clear.call(this.edges);
        Map.prototype.clear.call(this.clusters);
        for (const [id, node] of prepared.nodes) Map.prototype.set.call(this.nodes, id, node);
        for (const [key, edge] of prepared.edges) Map.prototype.set.call(this.edges, key, edge);
        for (const [id, members] of prepared.clusters) {
          Map.prototype.set.call(this.clusters, id, new Set(members));
        }
        this.activations.clear();
        this.nextNodeId = prepared.nextNodeId;
        this.nextClusterId = prepared.nextClusterId;
        this.nodeIdFormat = prepared.nodeIdFormat;
        this.nodeIdPrefix = prepared.nodeIdPrefix;
        this._advancePersistenceGenerationUnsafe();
        this._markPersistenceCleanUnsafe();
        return { loaded: true, generation: this.persistenceGeneration };
      });
      this.logger?.info('Network loaded', { filepath, nodes: prepared.nodes.size, loaded: result.loaded });
      return result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.logger?.info('No existing network file, starting fresh');
      return { loaded: false, reason: 'not_found', generation: this.persistenceGeneration };
    }
  }
}

module.exports = { NetworkMemory };
