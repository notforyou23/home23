'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { DocumentConverter } = require('./document-converter');
const { DocumentChunker } = require('./document-chunker');
const { DocumentValidator } = require('./document-validator');
const { DocumentClassifier } = require('./document-classifier');
const { IngestionManifest } = require('./ingestion-manifest');

class DocumentFeeder {
  /**
   * @param {object} opts
   * @param {object} opts.memory - Live NetworkMemory instance
   * @param {object} opts.config - feeder config block from config.yaml
   * @param {object} opts.logger
   * @param {function} opts.embeddingFn - async (text) => float[] | null
   */
  constructor({ memory, config = {}, logger = null, embeddingFn = null }) {
    this.memory = memory;
    this.config = config;
    this.logger = logger;
    this.embeddingFn = embeddingFn || (text => memory.embed(text));

    this._watchers = [];
    this._flushTimer = null;
    this._started = false;

    // Subsystems — created in start()
    this.converter = null;
    this.chunker = null;
    this.validator = null;
    this.classifier = null;
    this.manifest = null;
    this.runPath = null;
  }

  /**
   * Start the feeder: create directories, init subsystems, start watchers.
   * @param {string} runPath - The run directory path (e.g., runs/<name>)
   */
  async start(runPath) {
    if (this._started) return;
    this.runPath = runPath;

    // Ensure ingestion directory exists
    const ingestDir = path.join(runPath, 'ingestion', 'documents');
    fs.mkdirSync(ingestDir, { recursive: true });

    // Initialize subsystems
    const converterConfig = this.config.converter || {};
    this.converter = new DocumentConverter({
      logger: this.logger,
      visionModel: converterConfig.visionModel || 'gpt-4o-mini',
      pythonPath: converterConfig.pythonPath || 'python3'
    });

    this.chunker = new DocumentChunker({
      maxChunkSize: this.config.chunking?.maxChunkSize || 3000,
      overlap: this.config.chunking?.overlap || 300,
      logger: this.logger
    });

    this.validator = new DocumentValidator({ logger: this.logger });
    this.classifier = new DocumentClassifier({ logger: this.logger });

    this.manifest = new IngestionManifest({
      runPath,
      memory: this.memory,
      embeddingFn: this.embeddingFn,
      config: {
        batchSize: this.config.flush?.batchSize || 20,
        intervalSeconds: this.config.flush?.intervalSeconds || 300
      },
      logger: this.logger
    });

    // Log converter status
    if (this.converter.available) {
      this.logger?.info?.('Document feeder: MarkItDown available — binary formats supported');
    } else {
      this.logger?.warn?.('Document feeder: MarkItDown not installed — only text formats will be ingested');
    }

    // Start default watcher on ingestion/documents/
    this._startWatcher(ingestDir, null);

    // Start additional configured watch paths
    const additionalPaths = this.config.additionalWatchPaths || [];
    for (const wp of additionalPaths) {
      const watchPath = wp.path || wp;
      const label = wp.label || path.basename(watchPath);
      this._startWatcher(watchPath, label);
    }

    // Start flush interval
    const intervalMs = (this.config.flush?.intervalSeconds || 300) * 1000;
    this._flushTimer = setInterval(() => {
      this.manifest.flush('interval');
    }, intervalMs);

    this._started = true;

    // Initial scan
    await this._scanDirectory(ingestDir, null);
    for (const wp of additionalPaths) {
      const watchPath = wp.path || wp;
      const label = wp.label || path.basename(watchPath);
      await this._scanDirectory(watchPath, label);
    }

    // Startup flush after 1s
    setTimeout(() => this.manifest.flush('startup'), 1000);

    this.logger?.info?.('Document feeder started', {
      ingestDir,
      additionalPaths: additionalPaths.length,
      converterAvailable: this.converter.available
    });
  }

  // ─── Runtime API ─────────────────────────────────────────────

  /**
   * Add a new watch path mid-run.
   */
  async addWatchPath(watchPath, label = null, glob = null) {
    if (!this._started) throw new Error('Feeder not started');
    label = label || path.basename(watchPath);
    this._startWatcher(watchPath, label);
    await this._scanDirectory(watchPath, label);
    this.logger?.info?.('Added watch path', { watchPath, label });
  }

  /**
   * One-shot: ingest a specific file immediately.
   */
  async ingestFile(filePath, label = null) {
    if (!this._started) throw new Error('Feeder not started');
    label = label || path.basename(path.dirname(filePath));
    await this._processFile(filePath, label);
    await this.manifest.flush('ingestFile');
  }

  /**
   * One-shot: ingest all files in a directory.
   */
  async ingestDirectory(dirPath, label = null, glob = null) {
    if (!this._started) throw new Error('Feeder not started');
    label = label || path.basename(dirPath);
    await this._scanDirectory(dirPath, label);
    await this.manifest.flush('ingestDirectory');
  }

  /**
   * Remove an ingested file's nodes from memory.
   */
  async removeFile(filePath) {
    if (!this._started) throw new Error('Feeder not started');
    await this.manifest.removeFile(filePath);
  }

  /**
   * Get feeder status and stats.
   */
  async getStatus() {
    const manifestStats = this.manifest ? this.manifest.getStats() : { fileCount: 0, nodeCount: 0, pendingCount: 0 };
    return {
      enabled: true,
      started: this._started,
      watching: this._watchers.map(w => w.path),
      manifest: manifestStats,
      converter: {
        available: this.converter?.available || false,
        visionModel: this.config.converter?.visionModel || 'gpt-4o-mini'
      }
    };
  }

  /**
   * Flush, persist, close watchers.
   */
  async shutdown() {
    if (!this._started) return;

    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._flushDebounce) {
      clearTimeout(this._flushDebounce);
      this._flushDebounce = null;
    }

    for (const w of this._watchers) {
      await w.watcher.close();
    }
    this._watchers = [];

    if (this.manifest) {
      await this.manifest.shutdown();
    }

    this._started = false;
    this.logger?.info?.('Document feeder shut down');
  }

  // ─── Internal ────────────────────────────────────────────────

  _startWatcher(watchPath, fixedLabel) {
    if (!fs.existsSync(watchPath)) {
      this.logger?.warn?.('Watch path does not exist, skipping', { watchPath });
      return;
    }

    const watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      depth: 99,
      ignored: /(^|[/\\])\../  // ignore dotfiles
    });

    watcher.on('add', (filePath) => this._onFileEvent(filePath, fixedLabel, watchPath));
    watcher.on('change', (filePath) => this._onFileEvent(filePath, fixedLabel, watchPath));
    watcher.on('error', (err) => {
      this.logger?.error?.('Watcher error', { watchPath, error: err.message });
    });

    this._watchers.push({ path: watchPath, label: fixedLabel, watcher });
  }

  async _onFileEvent(filePath, fixedLabel, watchRoot) {
    const label = fixedLabel || this._labelFromPath(filePath, watchRoot);
    await this._processFile(filePath, label);

    // Always trigger a flush shortly after any file event — don't wait for batch
    // threshold or the 5-min interval. This ensures interactive uploads get processed
    // quickly. The flush is debounced internally (flushInProgress guard).
    if (this._flushDebounce) clearTimeout(this._flushDebounce);
    this._flushDebounce = setTimeout(() => {
      this.manifest.flush('file-event');
    }, 500);
  }

  async _processFile(filePath, label) {
    try {
      // Skip dotfiles and our own manifest/pending files
      const basename = path.basename(filePath);
      if (basename.startsWith('.')) return;
      if (basename === 'ingestion-manifest.json' || basename === 'ingestion-pending.json') return;

      // Read file and check staleness
      let fileContent;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return;
        fileContent = fs.readFileSync(filePath);
      } catch {
        return; // File gone or unreadable
      }

      const { fullHash } = IngestionManifest.hashContent(fileContent);
      const isStale = await this.manifest.isStale(filePath, fullHash);
      if (!isStale) return;

      // Convert if needed
      let text, format;
      if (this.converter.isNativeText(filePath)) {
        text = fileContent.toString('utf8');
        format = path.extname(filePath).slice(1);
      } else if (this.converter.isConvertible(filePath)) {
        const result = await this.converter.convert(filePath);
        if (!result) return;
        text = result.text;
        format = result.format;
      } else {
        // Unknown — try as text
        const sample = fileContent.slice(0, 8192);
        if (sample.includes(0)) return; // binary
        text = fileContent.toString('utf8');
        format = path.extname(filePath).slice(1) || 'txt';
      }

      if (!text || text.trim().length === 0) return;

      // Chunk
      const { chunks, relationships } = this.chunker.chunk(text, { filePath, format });
      if (chunks.length === 0) return;

      // Validate — gate broken documents before they enter the index
      const validation = this.validator.validate(text, chunks, { filePath, format });

      if (validation.status === 'suspect_truncation' || validation.status === 'un_normalizable') {
        this.logger?.warn?.('Document quarantined — validation failed', {
          filePath,
          status: validation.status,
          issues: validation.issues
        });
        // Track in manifest with parseStatus but do not enqueue for memory
        await this.manifest.trackQuarantined(filePath, label, fullHash, validation);
        return;
      }

      // Classify — assign document family
      const classification = this.classifier.classify(text, chunks);

      // Enqueue with enriched metadata
      await this.manifest.enqueue(filePath, label, fullHash, chunks, relationships, {
        parseStatus: validation.status,
        structuralSignature: validation.structuralSignature,
        docFamily: classification.family,
        docFamilyConfidence: classification.confidence
      });

      this.logger?.debug?.('File enqueued for ingestion', {
        filePath,
        label,
        chunks: chunks.length,
        strategy: chunks[0]?.strategy,
        docFamily: classification.family,
        parseStatus: validation.status
      });
    } catch (err) {
      this.logger?.error?.('Failed to process file', { filePath, error: err.message });
    }
  }

  async _scanDirectory(dirPath, label) {
    if (!fs.existsSync(dirPath)) return;

    const walk = (dir) => {
      let files = [];
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files = files.concat(walk(full));
          } else if (entry.isFile()) {
            files.push(full);
          }
        }
      } catch {
        // Directory unreadable
      }
      return files;
    };

    const files = walk(dirPath);
    for (const filePath of files) {
      const fileLabel = label || this._labelFromPath(filePath, dirPath);
      await this._processFile(filePath, fileLabel);
    }

    this.logger?.debug?.('Directory scan complete', { dirPath, filesFound: files.length });
  }

  /**
   * Derive a label from the file's immediate parent directory relative to the watch root.
   */
  _labelFromPath(filePath, watchRoot) {
    const rel = path.relative(watchRoot, filePath);
    const parts = rel.split(path.sep);
    if (parts.length > 1) {
      return parts[0]; // First subdirectory name
    }
    return path.basename(watchRoot); // Root level → use watch dir name
  }
}

module.exports = { DocumentFeeder };
