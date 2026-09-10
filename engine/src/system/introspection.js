// src/system/introspection.js
/**
 * IntrospectionModule - COSMO's Self-Awareness Layer
 * 
 * Purpose:
 * - Scans agent outputs every N cycles
 * - Reads file content (preview)
 * - Integrates into memory for continuity
 * - Provides grounded context for next thoughts
 * 
 * Design:
 * - System module (not a cognitive agent)
 * - Fast, bounded, predictable
 * - Checkpoint-based (handles restarts)
 * - Deduplicates memory nodes
 * - Zero GPT calls (pure file I/O)
 * 
 * This closes COSMO's feedback loop:
 * Agents create → Introspection reads → Memory stores → Orchestrator knows
 */

const fs = require('fs').promises;
const path = require('path');

const MAX_LOCAL_DEDUP_NODES = 1000;
const MAX_LOCAL_EMBEDDING_DIMENSIONS = 8192;

class IntrospectionModule {
  constructor(config, logger, memory, pathResolver) {
    this.config = config;
    this.logger = logger;
    this.memory = memory;
    this.pathResolver = pathResolver;

    this.enabled = config.introspection?.enabled || false;
    this.maxPreviewLength = config.introspection?.maxPreviewLength || 400;
    this.maxFiles = config.introspection?.maxFilesPerCycle || 10;

    // Persistent checkpoint file
    this.checkpointFile = null;
    this.lastScanTimestamp = 0;
    this.runRoot = null;
    this.outputsRoot = null;
    this.integratedSourcePaths = new Set();
  }

  async initialize(runRoot) {
    if (!this.enabled) {
      this.logger.debug('Introspection disabled');
      return;
    }

    this.runRoot = runRoot;
    this.outputsRoot = path.join(runRoot, 'outputs');
    this.checkpointFile = path.join(runRoot, 'metadata', 'introspection_checkpoint.json');

    // Load checkpoint
    try {
      const raw = await fs.readFile(this.checkpointFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.lastScanTimestamp = parsed.lastScanTimestamp || 0;
    } catch {
      this.lastScanTimestamp = 0; // Fresh run
    }

    this.logger.info('📘 Introspection initialized', {
      enabled: this.enabled,
      outputsRoot: this.outputsRoot,
      lastScan: this.lastScanTimestamp ? new Date(this.lastScanTimestamp).toISOString() : 'never'
    });
  }

  /**
   * Scan outputs directory for new/modified files
   * @returns {Array} Array of file items with previews
   */
  async scan() {
    if (!this.enabled) return [];

    try {
      // Find candidate files
      const candidates = await this.walkForCandidates(this.outputsRoot);

      // Filter to only new/modified files since last scan
      const newFiles = [];
      for (const file of candidates) {
        try {
          const stat = await fs.stat(file);
          if (stat.mtimeMs > this.lastScanTimestamp) {
            newFiles.push(file);
          }
        } catch (err) {
          // File disappeared or unreadable - skip
        }
      }

      // Limit to maxFiles per cycle
      const limited = newFiles.slice(0, this.maxFiles);

      // Read file contents
      const items = await this.readFiles(limited);

      // Update checkpoint
      this.lastScanTimestamp = Date.now();
      await this.writeCheckpoint();

      return items;
    } catch (error) {
      this.logger.warn('Introspection scan failed (non-fatal)', { error: error.message });
      return [];
    }
  }

  /**
   * Walk outputs directory for candidate files
   */
  async walkForCandidates(dir) {
    let list = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          list = list.concat(await this.walkForCandidates(full));
        } else {
          // SKIP non-content files
          if (
            entry.name.endsWith('.json') ||
            entry.name.endsWith('.jsonl') ||
            entry.name.endsWith('.log') ||
            entry.name.startsWith('.') ||
            entry.name === 'manifest.json' ||
            entry.name === 'metadata.json'
          ) continue;

          list.push(full);
        }
      }
    } catch {
      // Directory may not exist - ignore
    }

    return list;
  }

  /**
   * Read files and create preview items
   */
  async readFiles(files) {
    const results = [];

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const preview = content.slice(0, this.maxPreviewLength);

        results.push({
          filePath,
          preview,
          timestamp: Date.now(),
          agentType: this.extractAgentType(filePath),
          agentId: this.extractAgentId(filePath)
        });
      } catch (err) {
        this.logger.warn(`Introspection: failed to read ${filePath}`, { error: err.message });
      }
    }

    return results;
  }

  /**
   * Integrate file items into memory network
   * @param {Array} items - File items from scan()
   * @returns {Array} Array of created node IDs
   */
  async integrate(items) {
    if (!this.enabled || items.length === 0) return [];
    
    // Defensive: Check memory is available
    if (!this.memory) {
      this.logger.warn('No memory system available for introspection');
      return [];
    }

    const nodes = [];

    for (const item of items) {
      try {
        const sourcePath = this.normalizeSourcePath(item.filePath);
        const alreadyExists = this.integratedSourcePaths.has(sourcePath)
          || this.hasExistingSourcePath(sourcePath);

        if (alreadyExists) {
          this.logger.debug('Skipping duplicate file', { file: path.basename(item.filePath) });
          this.integratedSourcePaths.add(sourcePath);
          continue;
        }

        // Add new memory node
        const concept = `[INTROSPECTION] ${path.basename(item.filePath)} from ${item.agentType} agent ${item.agentId}: ${item.preview}`;
        const tag = 'introspection';

        // Supplying an explicit local placeholder prevents NetworkMemory.addNode
        // from requesting an embedding. Introspection nodes remain available to
        // the local keyword index without putting provider I/O in the cycle path.
        const node = await this.memory.addNode({
          concept,
          tag,
          embedding: this.createLocalPlaceholderEmbedding(),
          metadata: {
            introspectionSourcePath: sourcePath
          }
        });
        
        if (node && node.id) {
          nodes.push(node.id);
          this.integratedSourcePaths.add(sourcePath);
        }
      } catch (err) {
        this.logger.warn('Failed to integrate item into memory', {
          file: item.filePath,
          error: err.message
        });
      }
    }

    return nodes;
  }

  /**
   * Normalize the durable identity used for exact source-file deduplication.
   */
  normalizeSourcePath(filePath) {
    return path.normalize(path.resolve(String(filePath || '')));
  }

  /**
   * Check existing memory without calling the async semantic query path.
   * NetworkMemory.queryByKeyword is synchronous, bounded by its keyword-index
   * limits, and supports read-only access. The capped node scan preserves
   * compatibility with simpler memory implementations used by older installs.
   */
  hasExistingSourcePath(sourcePath) {
    const basename = path.basename(sourcePath);
    let candidates = [];

    if (typeof this.memory.queryByKeyword === 'function') {
      try {
        const result = this.memory.queryByKeyword(sourcePath, 25, {
          accessMode: 'read-only',
          markAccess: false
        });
        // Do not await or otherwise adopt a thenable from an unknown memory
        // implementation: introspection's dedup path must remain synchronous.
        if (Array.isArray(result)) candidates = result;
      } catch (err) {
        this.logger.debug('Local introspection dedup query failed; using bounded node scan', {
          error: err.message
        });
      }
    }

    if (candidates.length === 0 && this.memory.nodes instanceof Map) {
      candidates = [];
      let inspected = 0;
      for (const node of this.memory.nodes.values()) {
        candidates.push(node);
        inspected += 1;
        if (inspected >= MAX_LOCAL_DEDUP_NODES) break;
      }
    }

    return candidates.some((node) => this.isNodeForSourcePath(node, sourcePath, basename));
  }

  isNodeForSourcePath(node, sourcePath, basename) {
    if (!node || (node.tag !== 'introspection'
      && !String(node.concept || '').startsWith('[INTROSPECTION] '))) return false;

    const recordedPath = node.metadata?.introspectionSourcePath
      || node.metadata?.sourcePath
      || node.metadata?.filePath
      || node.sourcePath
      || node.filePath;
    if (recordedPath) {
      return this.normalizeSourcePath(recordedPath) === sourcePath;
    }

    // Legacy introspection nodes recorded only the basename in their concept.
    return String(node.concept || '').startsWith(`[INTROSPECTION] ${basename} from `);
  }

  /**
   * A zero vector is deliberately non-semantic: cosine similarity is zero, so
   * it cannot create arbitrary graph edges, while its presence tells addNode
   * not to contact an embedding provider. Keyword retrieval remains available.
   */
  createLocalPlaceholderEmbedding() {
    const configured = typeof this.config.embedding?.dimensions === 'object'
      ? this.config.embedding.dimensions.default
      : this.config.embedding?.dimensions;
    const environment = Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10);
    const requested = Number.isSafeInteger(environment) && environment > 0
      ? environment
      : Number(configured);
    const dimensions = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, MAX_LOCAL_EMBEDDING_DIMENSIONS)
      : 768;
    return new Float32Array(dimensions);
  }

  /**
   * Write checkpoint to disk
   */
  async writeCheckpoint() {
    if (!this.checkpointFile) return;

    try {
      await fs.mkdir(path.dirname(this.checkpointFile), { recursive: true });
      await fs.writeFile(
        this.checkpointFile,
        JSON.stringify({ lastScanTimestamp: this.lastScanTimestamp }),
        'utf8'
      );
    } catch (err) {
      this.logger.warn('Introspection: failed writing checkpoint', { error: err.message });
    }
  }

  /**
   * Extract agent type from file path
   */
  extractAgentType(p) {
    const parts = p.split(path.sep);
    const idx = parts.indexOf('outputs');
    return idx !== -1 && parts[idx + 1] ? parts[idx + 1] : 'unknown';
  }

  /**
   * Extract agent ID from file path
   */
  extractAgentId(p) {
    const m = p.match(/agent[0-9a-z_]+/i);
    return m ? m[0] : null;
  }
}

module.exports = { IntrospectionModule };
