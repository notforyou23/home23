'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { DocumentConverter } = require('./document-converter');
const { DocumentChunker } = require('./document-chunker');
const { DocumentValidator } = require('./document-validator');
const { DocumentClassifier } = require('./document-classifier');
const { IngestionManifest } = require('./ingestion-manifest');
const { DocumentCompiler } = require('./document-compiler');

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
    this.compilerConfig = config.compiler || {};

    this._watchers = [];
    this._flushTimer = null;
    this._started = false;

    // Concurrency-limited compilation queue — prevents 429 rate-limit avalanche
    // when large folders are added and chokidar fires hundreds of file events at once
    this._compileQueue = [];
    this._compileActive = 0;
    this._compileMaxConcurrent = config.compiler?.maxConcurrent || 3;

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

    // Knowledge compiler — synthesizes documents before chunking
    this.compiler = new DocumentCompiler({
      workspacePath: this.config.workspacePath || path.join(runPath, '..', 'workspace'),
      config: this.compilerConfig,
      logger: this.logger,
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

    this.logger?.info?.('Document feeder started', {
      ingestDir,
      additionalPaths: additionalPaths.length,
      converterAvailable: this.converter.available
    });

    // Run initial scan in background so it doesn't block the cognitive loop
    (async () => {
      try {
        await this._scanDirectory(ingestDir, null);
        for (const wp of additionalPaths) {
          const watchPath = wp.path || wp;
          const label = wp.label || path.basename(watchPath);
          await this._scanDirectory(watchPath, label);
        }
        // Flush after scan completes
        this.manifest.flush('startup');
        this.logger?.info?.('Document feeder initial scan complete');
      } catch (err) {
        this.logger?.warn?.('Document feeder initial scan failed', { error: err.message });
      }
    })();
  }

  // ─── Runtime API ─────────────────────────────────────────────

  /**
   * Add a new watch path mid-run.
   */
  async addWatchPath(watchPath, label = null, glob = null) {
    if (!this._started) throw new Error('Feeder not started');
    label = label || path.basename(watchPath);
    this._startWatcher(watchPath, label);
    // Scan in background so it doesn't block the cognitive loop startup
    this._scanDirectory(watchPath, label).then(() => {
      this.logger?.info?.('Watch path scan complete', { watchPath, label });
    }).catch(err => {
      this.logger?.warn?.('Watch path scan failed', { watchPath, error: err.message });
    });
    this.logger?.info?.('Added watch path (scanning in background)', { watchPath, label });
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
   * Stop watching a path and drop it from the active watcher list.
   * Nodes already ingested from this path are NOT removed from the brain —
   * use removeFile for that. This just stops future file events.
   */
  async removeWatchPath(watchPath) {
    if (!this._started) throw new Error('Feeder not started');
    const normalized = path.resolve(watchPath);
    const idx = this._watchers.findIndex(w => path.resolve(w.path) === normalized);
    if (idx < 0) return false;
    const entry = this._watchers[idx];
    try {
      await entry.watcher.close();
    } catch (err) {
      this.logger?.warn?.('Error closing watcher', { path: watchPath, error: err.message });
    }
    this._watchers.splice(idx, 1);
    this.logger?.info?.('Removed watch path', { path: watchPath });
    return true;
  }

  /**
   * Force an immediate manifest flush. Useful after interactive uploads.
   */
  async forceFlush() {
    if (!this._started || !this.manifest) return { flushed: 0 };
    return this.manifest.flush('manual');
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

    // Build ignored matchers: always ignore dotfiles, plus any user-provided
    // exclude patterns from config.feeder.excludePatterns (array of glob strings)
    const userPatterns = Array.isArray(this.config.excludePatterns)
      ? this.config.excludePatterns.filter(p => typeof p === 'string' && p.trim())
      : [];
    const ignored = [
      /(^|[/\\])\../,  // dotfiles
      ...userPatterns,
    ];

    // ignoreInitial: false — fire 'add' for every pre-existing file on
    // startup so files that predate the watcher get a one-time scan. The
    // downstream _processFile() hash-staleness gate means already-manifested
    // files are a cheap no-op, so this does not re-compile the whole corpus.
    const watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      depth: 99,
      ignored
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
      if (this._isManagedArtifact(basename)) {
        await this._purgeManagedArtifact(filePath, basename);
        return;
      }

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

      if (!text || text.trim().length === 0) {
        this.logger?.debug?.('Skipping empty file', { filePath });
        return;
      }

      // Compile — LLM synthesizes the document in context of existing knowledge
      // Uses concurrency-limited queue to avoid 429 rate-limit avalanche on bulk ingestion
      let textForChunking = text;
      let usedCompiler = false;
      try {
        const compiled = await this._queueCompile(text, { filePath, format });
        if (compiled && compiled.synthesis) {
          textForChunking = compiled.synthesis;
          usedCompiler = true;
          this.logger?.info?.('Document compiled for ingestion', {
            filePath: path.basename(filePath),
            originalLength: text.length,
            synthesisLength: compiled.synthesis.length
          });
        }
      } catch (compileError) {
        this.logger?.warn?.('Compilation failed, using raw text', {
          filePath: path.basename(filePath),
          error: compileError.message
        });
      }

      // Chunk
      const { chunks, relationships } = usedCompiler
        ? this._chunkCompiledSynthesis(textForChunking, filePath)
        : this.chunker.chunk(textForChunking, { filePath, format });
      if (chunks.length === 0) return;

      // Validate — gate broken documents before they enter the index
      // Skip truncation checks on compiled syntheses (LLM output won't match raw-doc heuristics)
      const validation = this.validator.validate(textForChunking, chunks, { filePath, format });

      if (!usedCompiler && (validation.status === 'suspect_truncation' || validation.status === 'un_normalizable')) {
        this.logger?.warn?.('Document quarantined — validation failed', {
          filePath,
          status: validation.status,
          issues: validation.issues
        });
        await this.manifest.trackQuarantined(filePath, label, fullHash, validation);
        return;
      }

      // Classify — assign document family
      const classification = this.classifier.classify(textForChunking, chunks);

      // Enqueue with enriched metadata
      await this.manifest.enqueue(filePath, label, fullHash, chunks, relationships, {
        parseStatus: validation.status,
        structuralSignature: validation.structuralSignature,
        docFamily: classification.family,
        docFamilyConfidence: classification.confidence,
        compiled: usedCompiler
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

  _isManagedArtifact(basename) {
    return basename === 'BRAIN_INDEX.md' || basename === 'brain-state.json';
  }

  async _purgeManagedArtifact(filePath, basename) {
    if (!this.manifest) return;
    await this.manifest.removeFile(filePath);
    this.logger?.debug?.('Skipped managed brain artifact during ingestion', { filePath, basename });
  }

  /**
   * Queue a compilation request with concurrency limiting.
   * At most _compileMaxConcurrent LLM calls run in parallel.
   */
  _queueCompile(text, metadata) {
    return new Promise((resolve, reject) => {
      this._compileQueue.push({ text, metadata, resolve, reject });
      this._drainCompileQueue();
    });
  }

  async _drainCompileQueue() {
    while (this._compileQueue.length > 0 && this._compileActive < this._compileMaxConcurrent) {
      const job = this._compileQueue.shift();
      this._compileActive++;

      // Fire and forget — the promise resolution happens inside
      this.compiler.compile(job.text, job.metadata)
        .then(result => {
          job.resolve(result);
        })
        .catch(err => {
          job.reject(err);
        })
        .finally(() => {
          this._compileActive--;
          this._drainCompileQueue();
        });
    }

    if (this._compileQueue.length > 0 && this._compileQueue.length % 50 === 0) {
      this.logger?.info?.('Compile queue depth', {
        queued: this._compileQueue.length,
        active: this._compileActive,
        max: this._compileMaxConcurrent
      });
    }
  }

  _chunkCompiledSynthesis(text, filePath) {
    const cleanText = text.trim();
    if (!cleanText) return { chunks: [], relationships: [] };

    const pieces = cleanText.length <= this.chunker.maxChunkSize
      ? [{ text: cleanText, strategy: 'compiler' }]
      : this.chunker._mergeParagraphs(this.chunker._splitByParagraphs(cleanText))
          .map(piece => ({ ...piece, strategy: 'compiler' }));

    const heading = path.basename(filePath);
    const chunks = pieces.map((piece, index) => ({
      blockId: 'b_' + crypto.randomBytes(6).toString('hex'),
      type: 'compiled_synthesis',
      level: 0,
      path: [heading, 'Compiled Synthesis'],
      text: piece.text.trim(),
      index,
      totalBlocks: pieces.length,
      totalChunks: pieces.length,
      heading,
      depth: 0,
      strategy: piece.strategy || 'compiler'
    }));

    return {
      chunks,
      relationships: this.chunker._buildRelationships(chunks)
    };
  }
}

module.exports = { DocumentFeeder };
