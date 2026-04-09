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
const { contentDensityScore } = require('../core/validation');

class IntrospectionModule {
  constructor(config, logger, memory, pathResolver) {
    this.config = config;
    this.logger = logger;
    this.memory = memory;
    this.pathResolver = pathResolver;

    this.enabled = config.introspection?.enabled || false;
    this.maxPreviewLength = config.introspection?.maxPreviewLength || 1000;
    this.maxFiles = config.introspection?.maxFilesPerCycle || 10;

    // Only introspect actual content files (skip JSON metadata, logs, etc.)
    this.contentExtensions = new Set(['.md', '.txt', '.html', '.csv', '.py', '.js', '.ts', '.jsx', '.tsx']);
    this.structuredExtensions = new Set(['.json', '.jsonl']);

    // Persistent checkpoint file
    this.checkpointFile = null;
    this.lastScanTimestamp = 0;
    this.runRoot = null;
    this.outputsRoot = null;
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
          // Skip hidden and raw logs, but include structured agent outputs.
          if (
            entry.name.endsWith('.log') ||
            entry.name.startsWith('.') ||
            entry.name === 'manifest.json' ||
            entry.name === 'metadata.json'
          ) continue;

          const ext = path.extname(entry.name).toLowerCase();
          const isContentFile = this.contentExtensions.has(ext);
          const isStructuredFile = this.structuredExtensions.has(ext);
          if (!isContentFile && !isStructuredFile) continue;

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
        const ext = path.extname(filePath).toLowerCase();
        const preview = this.structuredExtensions.has(ext)
          ? this.createStructuredPreview(filePath, content)
          : content.slice(0, this.maxPreviewLength);

        results.push({
          filePath,
          preview,
          structured: this.structuredExtensions.has(ext),
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

  createStructuredPreview(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.jsonl') {
      const lines = content
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 5);
      const samples = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          samples.push(this.summarizeStructuredObject(parsed));
        } catch {
          samples.push(line.slice(0, 140));
        }
      }

      return samples.join('\n').slice(0, this.maxPreviewLength);
    }

    try {
      const parsed = JSON.parse(content);
      return this.summarizeStructuredObject(parsed).slice(0, this.maxPreviewLength);
    } catch {
      return content.slice(0, this.maxPreviewLength);
    }
  }

  summarizeStructuredObject(value) {
    if (Array.isArray(value)) {
      return value
        .slice(0, 5)
        .map(item => this.summarizeStructuredObject(item))
        .join(' | ');
    }

    if (value && typeof value === 'object') {
      return Object.entries(value)
        .slice(0, 8)
        .map(([key, entry]) => {
          if (entry && typeof entry === 'object') {
            return `${key}=${this.summarizeStructuredObject(entry)}`;
          }
          return `${key}=${String(entry).slice(0, 80)}`;
        })
        .join(', ');
    }

    return String(value || '');
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
        // Check for existing node with same file path (deduplication)
        // Use simple concept match - memory.query returns array of nodes with concept + similarity
        const existingNodes = await this.memory.query(
          path.basename(item.filePath),
          3
        );

        // Simple dedup: if concept already mentions this file, skip
        const alreadyExists = existingNodes.some(node => 
          node.concept && node.concept.includes(path.basename(item.filePath))
        );

        if (alreadyExists) {
          this.logger.debug('Skipping duplicate file', { file: path.basename(item.filePath) });
          continue;
        }

        // Check content density before saving (skip near-empty or junk previews)
        const density = contentDensityScore(item.preview);
        if (density < 0.3) {
          this.logger.debug('Skipping low-density introspection', {
            file: path.basename(item.filePath),
            density: density.toFixed(2)
          });
          continue;
        }

        // Add new memory node
        // NOTE: memory.addNode signature is (concept, tag, embedding)
        const concept = `[INTROSPECTION] ${path.basename(item.filePath)} from ${item.agentType} agent ${item.agentId}: ${item.preview}`;
        const tag = 'introspection';

        const node = await this.memory.addNode(concept, tag, null);
        
        if (node && node.id) {
          nodes.push(node.id);
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
