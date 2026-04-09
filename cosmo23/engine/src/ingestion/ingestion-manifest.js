'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
    this._pendingPath = path.join(runPath, 'ingestion-pending.json');
    this._manifest = this._loadJson(this._manifestPath, {});
    this._pending = this._normalizePending(this._loadJson(this._pendingPath, []));

    this._flushInProgress = false;
    this._queueLock = Promise.resolve();
    this._pendingSaveTimer = null;
    this._failureCounts = new Map(); // filePath → consecutive failure count
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

      // Upsert: remove existing entries for this file
      this._pending = this._pending.filter(p => p.filePath !== filePath);
      this._pending.push(...items);
      this._debouncedSavePending();

      // Update manifest entry with enrichment metadata
      if (enrichment.parseStatus || enrichment.docFamily) {
        const existing = this._manifest[filePath] || {};
        this._manifest[filePath] = {
          ...existing,
          hash: fullHash,
          label,
          parseStatus: enrichment.parseStatus || null,
          docFamily: enrichment.docFamily || null,
          docFamilyConfidence: enrichment.docFamilyConfidence || null,
          structuralSignature: enrichment.structuralSignature || null
        };
      }
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
      if (this._flushInProgress || this._pending.length === 0) return;
      this._flushInProgress = true;

      const batchSize = this.config.batchSize || 20;
      const batch = this._pending.slice(0, batchSize);
      const overflow = this._pending.slice(batchSize);

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
          const count = (this._failureCounts.get(filePath) || 0) + 1;
          this._failureCounts.set(filePath, count);
          if (count >= 3) {
            this.logger?.warn?.('Dead-lettering file after 3 consecutive embedding failures', { filePath });
            this._failureCounts.delete(filePath);
            // Remove all chunks for this file from remaining
            remaining.splice(0, remaining.length, ...remaining.filter(i => i.filePath !== filePath));
          }
        }

        // Clear failure counters for files that succeeded
        for (const item of readyItems) {
          this._failureCounts.delete(item.filePath);
        }

        if (readyItems.length === 0) {
          this._pending = [...remaining, ...overflow];
          this._savePending();
          return;
        }

        // Phase 2: Remove stale nodes for re-ingested files
        const filesInBatch = new Set(readyItems.map(i => i.filePath));
        for (const filePath of filesInBatch) {
          const oldEntry = this._manifest[filePath];
          if (oldEntry?.nodeIds?.length) {
            for (const nodeId of oldEntry.nodeIds) {
              this.memory.removeNode(nodeId);
            }
            this.logger?.debug?.('Removed stale nodes for re-ingestion', {
              filePath,
              removedNodeIds: oldEntry.nodeIds
            });
          }
        }

        // Phase 3: Create new nodes
        const nodeIdMap = new Map(); // `${filePath}:${chunkIndex}` → nodeId
        const fileNodeIds = new Map(); // filePath → [nodeIds]

        for (const item of readyItems) {
          const node = await this.memory.addNode(item.content, item.tag, item.embedding);
          if (!node) {
            this.logger?.warn?.('Memory rejected node', { filePath: item.filePath, chunkIndex: item.chunkIndex });
            continue;
          }

          // Attach feeder metadata to the node
          node.metadata = {
            source: 'document-feeder',
            sourcePath: item.sourcePath,
            chunkKey: item.sourcePath,
            chunkIndex: item.chunkIndex,
            totalChunks: item.totalChunks,
            label: item.label,
            heading: item.heading,
            ingestedAt: item.ingestedAt,
            contentHash: item.contentHash,
            // Block model fields
            blockType: item.blockType || null,
            blockPath: item.blockPath || null,
            blockId: item.blockId || null,
            // Classification
            docFamily: item.docFamily || null
          };

          const key = `${item.filePath}:${item.chunkIndex}`;
          nodeIdMap.set(key, node.id);

          if (!fileNodeIds.has(item.filePath)) {
            fileNodeIds.set(item.filePath, []);
          }
          fileNodeIds.get(item.filePath).push(node.id);
        }

        // Phase 4: Create structural edges from relationships
        for (const item of readyItems) {
          if (!item.relationships) continue;
          for (const rel of item.relationships) {
            const fromKey = `${item.filePath}:${rel.from}`;
            const toKey = `${item.filePath}:${rel.to}`;
            const fromNodeId = nodeIdMap.get(fromKey);
            const toNodeId = nodeIdMap.get(toKey);
            if (fromNodeId != null && toNodeId != null) {
              const edgeType = rel.type === 'FOLLOWS' ? 'depends_on' : 'associative';
              this.memory.addEdge(fromNodeId, toNodeId, 0.3, edgeType);
            }
          }
        }

        // Phase 5: Update manifest
        for (const [filePath, nodeIds] of fileNodeIds) {
          const representative = readyItems.find(i => i.filePath === filePath);
          const existing = this._manifest[filePath] || {};
          this._manifest[filePath] = {
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
        }

        // Phase 6: Persist and update queue
        this._pending = [...remaining, ...overflow];
        this._saveManifest();
        this._savePending();

        this.logger?.info?.(`Flushed ${readyItems.length} items (${reason})`, {
          filesProcessed: filesInBatch.size,
          nodesCreated: nodeIdMap.size,
          remaining: this._pending.length
        });

        // Chain next flush if overflow
        if (this._pending.length > 0) {
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
      if (entry?.nodeIds) {
        for (const nodeId of entry.nodeIds) {
          this.memory.removeNode(nodeId);
        }
      }
      delete this._manifest[filePath];
      this._pending = this._pending.filter(p => p.filePath !== filePath);
      this._saveManifest();
      this._savePending();
    });
  }

  /**
   * Get manifest stats.
   */
  getStats() {
    const fileCount = Object.keys(this._manifest).length;
    const nodeCount = Object.values(this._manifest).reduce((sum, e) => sum + (e.nodeIds?.length || 0), 0);
    return { fileCount, nodeCount, pendingCount: this._pending.length };
  }

  /**
   * Persist and clean up.
   */
  async shutdown() {
    if (this._pendingSaveTimer) {
      clearTimeout(this._pendingSaveTimer);
      this._pendingSaveTimer = null;
    }
    await this.flush('shutdown');
    this._saveManifest();
    this._savePending();
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

  _saveManifest() {
    try {
      fs.writeFileSync(this._manifestPath, JSON.stringify(this._manifest, null, 2));
    } catch (err) {
      this.logger?.error?.('Failed to save manifest', { error: err.message });
    }
  }

  _savePending() {
    try {
      fs.writeFileSync(this._pendingPath, JSON.stringify(this._pending, null, 2));
    } catch (err) {
      this.logger?.error?.('Failed to save pending queue', { error: err.message });
    }
  }

  _debouncedSavePending() {
    if (this._pendingSaveTimer) clearTimeout(this._pendingSaveTimer);
    this._pendingSaveTimer = setTimeout(() => this._savePending(), 100);
  }
}

module.exports = { IngestionManifest };
