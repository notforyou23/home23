'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DurableIngestionQueue,
  isIngestionQueueInternalFile,
} = require('../../../../shared/ingestion-durable-queue.cjs');

class IngestionManifest {
  /**
   * @param {object} opts
   * @param {string} opts.runPath - Run directory path
   * @param {object} opts.memory - Live NetworkMemory instance
   * @param {function} opts.embeddingFn - async (text) => float[] | null
   * @param {object} opts.config - { batchSize, intervalSeconds }
   * @param {object} opts.logger
   */
  constructor({ runPath, memory, embeddingFn, config = {}, logger = null }) {
    this.runPath = runPath;
    this.memory = memory;
    this.embeddingFn = embeddingFn;
    this.config = config;
    this.logger = logger;

    this._manifestPath = path.join(runPath, 'ingestion-manifest.json');
    // Patch 67: JSONL, not a single JSON array. The Home23 twin of this
    // queue hit V8's ~536MB string ceiling at 221MB of items ("Invalid
    // string length") — saves failed while the disk copy went stale. One
    // line per item has no single-string limit on either side.
    this._pendingPath = path.join(runPath, 'ingestion-pending.jsonl');
    this._legacyPendingPath = path.join(runPath, 'ingestion-pending.json');
    this._manifest = this._loadJson(this._manifestPath, {});
    this._migrateLegacyArrayIfPresent();
    this._queue = new DurableIngestionQueue({ runPath, logger });
    this._compatPending = null;

    this._flushInProgress = false;
    this._queueLock = Promise.resolve();
    this._failureCounts = new Map(); // filePath → consecutive failure count
    this._feederNodeIndex = null;
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Check if a file needs (re-)ingestion.
   */
  async isStale(filePath, contentHash) {
    const entry = this._manifest[filePath];
    if (!entry) return true;
    return entry.hash !== contentHash;
  }

  /**
   * Enqueue chunks for a file. Upserts — replaces existing entries for the same filePath.
   * @param {string} filePath
   * @param {string} label
   * @param {string} fullHash
   * @param {object[]} chunks - Block objects from DocumentChunker
   * @param {object[]} relationships
   * @param {object} enrichment - { parseStatus, structuralSignature, docFamily, docFamilyConfidence }
   */
  async enqueue(filePath, label, fullHash, chunks, relationships, enrichment = {}) {
    return this._withLock(async () => {
      const contentHash = fullHash.slice(0, 16);
      const items = chunks.map((chunk, i) => ({
        filePath,
        sourcePath: `${filePath}#chunk-${chunk.index}`,
        chunkIndex: chunk.index,
        totalChunks: chunk.totalChunks,
        label,
        tag: label,
        content: chunk.text,
        concept: chunk.text.slice(0, 200),
        heading: chunk.heading,
        depth: chunk.depth,
        // Block model fields
        blockType: chunk.type || null,
        blockPath: chunk.path || null,
        blockId: chunk.blockId || null,
        // Enrichment from validator/classifier
        docFamily: enrichment.docFamily || null,
        docFamilyConfidence: enrichment.docFamilyConfidence || null,
        parseStatus: enrichment.parseStatus || null,
        embedding: null,
        contentHash,
        hash: fullHash,
        ingestedAt: new Date().toISOString(),
        relationships
      }));

      for (const item of items) delete item.relationships;
      const generation = this._queue.upsert(filePath, items, { relationships });

      // Update manifest entry with enrichment metadata
      const existing = this._manifest[filePath] || {};
      this._manifest[filePath] = {
        ...existing,
        hash: fullHash,
        label,
        parseStatus: enrichment.parseStatus || null,
        docFamily: enrichment.docFamily || null,
        docFamilyConfidence: enrichment.docFamilyConfidence || null,
        structuralSignature: enrichment.structuralSignature || null,
        nodeIds: [],
        _pendingGeneration: generation,
        _pendingChunks: {},
        _pendingTotalChunks: chunks.length,
        _supersededNodeIds: uniqueNodeIds([
          ...(existing.nodeIds || []),
          ...Object.values(existing._pendingChunks || {}),
          ...(existing._supersededNodeIds || []),
        ]),
      };
    });
  }

  /**
   * Track a quarantined file in the manifest without enqueuing for memory ingestion.
   */
  async trackQuarantined(filePath, label, fullHash, validation) {
    return this._withLock(async () => {
      this._manifest[filePath] = {
        hash: fullHash,
        label,
        parseStatus: validation.status,
        issues: validation.issues,
        structuralSignature: validation.structuralSignature,
        quarantinedAt: new Date().toISOString(),
        nodeIds: []
      };
      this._saveManifest();
    });
  }

  /**
   * Flush pending items: embed, create nodes, create edges, update manifest.
   */
  async flush(reason = 'manual') {
    return this._withLock(async () => {
      this._adoptCompatPending();
      if (this._flushInProgress || this._queue.pendingCount === 0) return;
      this._flushInProgress = true;

      const batchSize = this.config.batchSize || 20;
      const queuedBatch = this._queue.peekBatch(batchSize);
      const batch = queuedBatch.items;
      const deliveryByItem = new Map(batch.map((item, index) => [item, queuedBatch.token.deliveries[index]]));

      try {
        // Phase 1: Generate embeddings for items that don't have them
        const readyItems = [];
        const remaining = [];

        // Track which files failed embedding in this batch (file-level, not chunk-level)
        const failedFiles = new Set();

        for (const item of batch) {
          if (item.embedding) {
            readyItems.push(item);
            continue;
          }

          // If another chunk of this file already failed in this batch, skip
          if (failedFiles.has(item.filePath)) {
            remaining.push(item);
            continue;
          }

          const embedding = await this._embedWithRetry(item.content);
          if (embedding) {
            item.embedding = embedding;
            readyItems.push(item);
          } else {
            failedFiles.add(item.filePath);
            remaining.push(item);
          }
        }

        // Increment failure counters once per file (not per chunk)
        for (const filePath of failedFiles) {
          const durableAttempts = remaining
            .filter((item) => item.filePath === filePath)
            .reduce((max, item) => Math.max(max, Number(item._ingestionAttempts) || 0), 0);
          const count = Math.max(this._failureCounts.get(filePath) || 0, durableAttempts) + 1;
          this._failureCounts.set(filePath, count);
          for (const item of remaining) {
            if (item.filePath === filePath) item._ingestionAttempts = count;
          }
          if (count >= 3) {
            this.logger?.warn?.('Dead-lettering file after 3 consecutive embedding failures', { filePath });
            this._failureCounts.delete(filePath);
            // Remove all chunks for this file from remaining
            const dead = remaining.filter(i => i.filePath === filePath);
            this._queue.deadLetter(
              dead,
              'embedding_failed_three_times',
              dead.map((item) => deliveryByItem.get(item))
            );
            abortPendingGeneration(this, filePath, dead[0]?._queueGeneration);
            remaining.splice(0, remaining.length, ...remaining.filter(i => i.filePath !== filePath));
          }
        }

        // Clear failure counters for files that succeeded
        for (const item of readyItems) {
          this._failureCounts.delete(item.filePath);
        }

        if (readyItems.length === 0) {
          if (remaining.length > 0) {
            this._queue.requeue(remaining, remaining.map((item) => deliveryByItem.get(item)));
          }
          this._queue.commit(queuedBatch.token);
          return;
        }

        // Phase 2: establish a durable file-generation accumulator. Old nodes
        // are removed once, never once per delivery batch.
        const filesInBatch = new Set(readyItems.map(i => i.filePath));
        for (const filePath of filesInBatch) {
          const representative = readyItems.find((item) => item.filePath === filePath);
          const entry = ensureGenerationState(this, filePath, representative);
          if (entry._supersededNodeIds?.length) {
            for (const nodeId of entry._supersededNodeIds) {
              forgetFeederNode(this, nodeId);
              this.memory.removeNode(nodeId);
            }
            this.logger?.debug?.('Removed stale nodes for re-ingestion', {
              filePath,
              removedNodeIds: entry._supersededNodeIds
            });
            entry._supersededNodeIds = [];
          }
        }

        // Phase 3: Create new nodes
        for (const item of readyItems) {
          const metadata = buildFeederMetadata(item);
          const existingNode = findMatchingFeederNode(this, item);
          const node = existingNode || await this.memory.addNode(
            this.memory?.nodes instanceof Map
              ? { concept: item.content, tag: item.tag, embedding: item.embedding, metadata }
              : item.content,
            item.tag,
            item.embedding
          );
          if (!node) {
            this.logger?.warn?.('Memory rejected node', { filePath: item.filePath, chunkIndex: item.chunkIndex });
            continue;
          }

          // Attach feeder metadata to the node
          if (typeof this.memory.patchNode !== 'function') {
            throw new Error('memory_node_patch_api_required');
          }
          const patchedNode = this.memory.patchNode(node.id, { metadata }, {
            expectedNode: node,
          });
          if (!patchedNode) {
            this.logger?.warn?.('Memory node changed before feeder metadata commit', {
              filePath: item.filePath,
              chunkIndex: item.chunkIndex,
              nodeId: node.id,
            });
            continue;
          }
          rememberFeederNode(this, item, patchedNode);

          const entry = ensureGenerationState(this, item.filePath, item);
          entry._pendingChunks[String(item.chunkIndex)] = patchedNode.id;
        }

        // Phase 4/5: finalize complete generations and apply each relationship once.
        for (const filePath of filesInBatch) {
          const representative = readyItems.find(i => i.filePath === filePath);
          const existing = ensureGenerationState(this, filePath, representative);
          const totalChunks = Number(representative.totalChunks) || existing._pendingTotalChunks || 0;
          const nodeIds = orderedGenerationNodeIds(existing._pendingChunks, totalChunks);
          if (!nodeIds) continue;
          applyGenerationRelationships(this.memory, existing._pendingChunks, representative.relationships);
          const completed = {
            ...existing,
            hash: representative.hash,
            label: representative.label,
            ingestedAt: representative.ingestedAt,
            nodeIds,
            totalChunks: representative.totalChunks,
            parseStatus: representative.parseStatus || existing.parseStatus || null,
            docFamily: representative.docFamily || existing.docFamily || null,
            docFamilyConfidence: representative.docFamilyConfidence || existing.docFamilyConfidence || null,
            structuralSignature: existing.structuralSignature || null
          };
          delete completed._pendingGeneration;
          delete completed._pendingChunks;
          delete completed._pendingTotalChunks;
          delete completed._supersededNodeIds;
          this._manifest[filePath] = completed;
        }

        // Phase 6: Persist and update queue
        this._saveManifest();
        if (remaining.length > 0) {
          this._queue.requeue(remaining, remaining.map((item) => deliveryByItem.get(item)));
        }
        this._queue.commit(queuedBatch.token);

        this.logger?.info?.(`Flushed ${readyItems.length} items (${reason})`, {
          filesProcessed: filesInBatch.size,
          nodesCreated: readyItems.length,
          remaining: this._queue.pendingCount
        });

        // Chain next flush if overflow
        if (this._queue.pendingCount > 0) {
          setTimeout(() => this.flush('drain'), 500);
        }
      } finally {
        this._flushInProgress = false;
      }
    });
  }

  /**
   * Remove all nodes for a file from memory and manifest.
   */
  async removeFile(filePath) {
    return this._withLock(async () => {
      const entry = this._manifest[filePath];
      const nodeIds = uniqueNodeIds([
        ...(entry?.nodeIds || []),
        ...Object.values(entry?._pendingChunks || {}),
        ...(entry?._supersededNodeIds || []),
      ]);
      if (nodeIds.length) {
        for (const nodeId of nodeIds) {
          this.memory.removeNode(nodeId);
        }
      }
      delete this._manifest[filePath];
      this._queue.removeFile(filePath);
      this._saveManifest();
    });
  }

  /**
   * Get manifest stats.
   */
  getStats() {
    const fileCount = Object.keys(this._manifest).length;
    const nodeCount = Object.values(this._manifest).reduce((sum, e) => sum + (e.nodeIds?.length || 0), 0);
    return { fileCount, nodeCount, pendingCount: this._queue.pendingCount };
  }

  /**
   * Persist and clean up.
   */
  async shutdown() {
    await this.flush('shutdown');
    this._saveManifest();
    this._adoptCompatPending();
  }

  // ─── Static Helpers ──────────────────────────────────────────

  /**
   * Hash file content with SHA256.
   */
  static hashContent(content) {
    const fullHash = crypto.createHash('sha256').update(content).digest('hex');
    return { fullHash, shortHash: fullHash.slice(0, 16) };
  }

  // ─── Private Helpers ─────────────────────────────────────────

  async _embedWithRetry(text) {
    const limits = [null, 7000, 3500, 2000]; // null = full text
    for (const limit of limits) {
      const input = limit && text.length > limit ? text.slice(0, limit) : text;
      try {
        const embedding = await this.embeddingFn(input);
        if (embedding) return embedding;
      } catch (err) {
        this.logger?.debug?.('Embedding attempt failed', { limit, error: err.message });
      }
      if (limit === null && text.length <= 2000) break; // no point retrying shorter
    }
    return null;
  }

  _withLock(task) {
    this._queueLock = this._queueLock.then(task, task);
    return this._queueLock;
  }

  _loadJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _normalizePending(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(Boolean);
  }

  get _pending() {
    return this._compatPending || this._queue?.readAll() || [];
  }

  set _pending(value) {
    this._compatPending = this._normalizePending(value);
  }

  _adoptCompatPending() {
    if (!this._compatPending) return;
    const grouped = new Map();
    for (const item of this._compatPending) {
      if (!grouped.has(item.filePath)) grouped.set(item.filePath, []);
      grouped.get(item.filePath).push(item);
    }
    for (const [filePath, rawItems] of grouped) {
      const relationships = rawItems[0]?.relationships || [];
      const items = rawItems.map((item) => {
        const compact = { ...item };
        delete compact.relationships;
        return compact;
      });
      this._queue.upsert(filePath, items, { relationships });
    }
    this._compatPending = null;
  }

  _saveManifest() {
    const tmpPath = `${this._manifestPath}.tmp`;
    try {
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this._manifest, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this._manifestPath);
      fsyncDirectory(this.runPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      this.logger?.error?.('Failed to save manifest', { error: err.message });
      throw err;
    }
  }

  _migrateLegacyArrayIfPresent() {
    if (fs.existsSync(this._pendingPath) || !fs.existsSync(this._legacyPendingPath)) return;
    const tmpPath = `${this._pendingPath}.migrating`;
    try {
      const items = this._normalizePending(JSON.parse(fs.readFileSync(this._legacyPendingPath, 'utf8')));
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        for (const item of items) fs.writeSync(fd, `${JSON.stringify(item)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this._pendingPath);
      fsyncDirectory(this.runPath);
      fs.unlinkSync(this._legacyPendingPath);
      fsyncDirectory(this.runPath);
      this.logger?.info?.('Migrated legacy pending array to durable JSONL source', { items: items.length });
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      // Never silently drop queued work — AND never let one corrupt legacy
      // file stop the engine from starting. Throwing here made an unreadable
      // ingestion-pending.json fatal at construction; the pre-journal
      // behaviour quarantined the bytes and started empty. Quarantine wins:
      // the queue is recoverable from the preserved file, a dead engine is not.
      const preserved = `${this._legacyPendingPath}.unreadable`;
      try { fs.renameSync(this._legacyPendingPath, preserved); } catch { /* keep original */ }
      this.logger?.error?.('Legacy pending queue unreadable — preserved for inspection, starting empty', {
        error: err.message, preserved,
      });
    }
  }

  _savePending() {
    this._adoptCompatPending();
  }

}

// The feeder must never ingest the pipeline's own state files — a renamed
// queue file becoming a "document" would feed the brain its own plumbing.
const INGESTION_INTERNAL_FILES = new Set([
  'ingestion-manifest.json',
  'ingestion-manifest.json.tmp',
  'ingestion-pending.json',
  'ingestion-pending.jsonl',
  'ingestion-pending.jsonl.migrating',
]);

function isIngestionInternalFile(basename) {
  return INGESTION_INTERNAL_FILES.has(basename) || isIngestionQueueInternalFile(basename);
}

function buildFeederMetadata(item) {
  return {
    source: 'document-feeder',
    sourcePath: item.sourcePath,
    chunkKey: item.sourcePath,
    chunkIndex: item.chunkIndex,
    totalChunks: item.totalChunks,
    label: item.label,
    heading: item.heading,
    ingestedAt: item.ingestedAt,
    contentHash: item.contentHash,
    blockType: item.blockType || null,
    blockPath: item.blockPath || null,
    blockId: item.blockId || null,
    docFamily: item.docFamily || null,
  };
}

function findMatchingFeederNode(manifest, item) {
  const memory = manifest.memory;
  if (!(memory?.nodes instanceof Map)) return null;
  if (!manifest._feederNodeIndex) manifest._feederNodeIndex = buildFeederNodeIndex(memory.nodes);
  const key = feederNodeKey(item.sourcePath, item.contentHash);
  const node = manifest._feederNodeIndex.get(key) || null;
  if (node && memory.nodes.get(node.id) === node) return node;
  manifest._feederNodeIndex.delete(key);
  return null;
}

function rememberFeederNode(manifest, item, node) {
  if (manifest._feederNodeIndex) manifest._feederNodeIndex.set(feederNodeKey(item.sourcePath, item.contentHash), node);
}

function forgetFeederNode(manifest, nodeId) {
  if (!manifest._feederNodeIndex) return;
  const metadata = manifest.memory?.nodes?.get(nodeId)?.metadata;
  if (metadata?.chunkKey && metadata.contentHash) {
    manifest._feederNodeIndex.delete(feederNodeKey(metadata.chunkKey, metadata.contentHash));
  }
}

function buildFeederNodeIndex(nodes) {
  const index = new Map();
  for (const node of nodes.values()) {
    const metadata = node?.metadata;
    if (metadata?.source === 'document-feeder' && metadata.chunkKey && metadata.contentHash) {
      index.set(feederNodeKey(metadata.chunkKey, metadata.contentHash), node);
    }
  }
  return index;
}

function feederNodeKey(sourcePath, contentHash) {
  return `${sourcePath}\u0000${contentHash}`;
}

function ensureGenerationState(manifest, filePath, item) {
  const generation = item?._queueGeneration || `legacy-unidentified:${filePath}`;
  let entry = manifest._manifest[filePath] || {};
  if (entry._pendingGeneration !== generation) {
    entry = {
      ...entry,
      nodeIds: [],
      _pendingGeneration: generation,
      _pendingChunks: {},
      _pendingTotalChunks: Number(item?.totalChunks) || 0,
      _supersededNodeIds: uniqueNodeIds([
        ...(entry.nodeIds || []),
        ...Object.values(entry._pendingChunks || {}),
        ...(entry._supersededNodeIds || []),
      ]),
    };
    manifest._manifest[filePath] = entry;
  }
  if (!entry._pendingChunks || typeof entry._pendingChunks !== 'object') entry._pendingChunks = {};
  return entry;
}

function orderedGenerationNodeIds(chunks, totalChunks) {
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 0) return null;
  const nodeIds = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const nodeId = chunks?.[String(index)];
    if (!nodeId) return null;
    nodeIds.push(nodeId);
  }
  return nodeIds;
}

function applyGenerationRelationships(memory, chunks, relationships) {
  for (const rel of Array.isArray(relationships) ? relationships : []) {
    const fromNodeId = chunks?.[String(rel.from)];
    const toNodeId = chunks?.[String(rel.to)];
    if (fromNodeId == null || toNodeId == null) continue;
    const edgeType = rel.type === 'FOLLOWS' ? 'depends_on' : 'associative';
    memory.addEdge(fromNodeId, toNodeId, 0.3, edgeType);
  }
}

function abortPendingGeneration(manifest, filePath, generation) {
  const entry = manifest._manifest[filePath];
  if (!entry || (generation && entry._pendingGeneration !== generation)) return;
  for (const nodeId of uniqueNodeIds(Object.values(entry._pendingChunks || {}))) {
    forgetFeederNode(manifest, nodeId);
    manifest.memory?.removeNode?.(nodeId);
  }
  entry.nodeIds = [];
  entry.deadLetteredAt = new Date().toISOString();
  delete entry._pendingGeneration;
  delete entry._pendingChunks;
  delete entry._pendingTotalChunks;
  delete entry._supersededNodeIds;
}

function uniqueNodeIds(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function fsyncDirectory(dirPath) {
  const fd = fs.openSync(dirPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

module.exports = { IngestionManifest, isIngestionInternalFile };
