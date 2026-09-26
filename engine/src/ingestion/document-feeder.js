'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { DocumentConverter, isConverterFaultQuarantine } = require('./document-converter');
const { DocumentChunker } = require('./document-chunker');
const { DocumentValidator } = require('./document-validator');
const { DocumentClassifier } = require('./document-classifier');
const { IngestionManifest, isIngestionInternalFile } = require('./ingestion-manifest');
const { DocumentCompiler } = require('./document-compiler');
const { normalizeTranscript } = require('./transcript-normalizer');
const { expandOwnerPath } = require('../../../shared/owner-home.cjs');

class DocumentFeeder {
  /**
   * @param {object} opts
   * @param {object} opts.memory - Live NetworkMemory instance
   * @param {object} opts.config - feeder config block from config.yaml
   * @param {object} opts.logger
   * @param {function} opts.embeddingFn - async (text) => float[] | null
   * @param {function} [opts.onCommitted] - ({ reason, flushed }) after items
   *   reach live memory; search sees them only once the brain saves
   */
  constructor({ memory, config = {}, logger = null, embeddingFn = null, onCommitted = null }) {
    this.memory = memory;
    this.config = config;
    this.logger = logger;
    this.embeddingFn = embeddingFn || (text => memory.embed(text));
    this.onCommitted = onCommitted;
    this._lastFlush = null;
    this.compilerConfig = config.compiler || {};
    this.maxFileBytes = Number.isFinite(Number(config.maxFileBytes))
      ? Number(config.maxFileBytes)
      : 5 * 1024 * 1024;

    this._watchers = [];
    // Every watch root the feeder was asked to cover, attached or not. A
    // configured folder that does not exist yet (a fresh resident's
    // workspace/projects) used to be skipped for the life of the engine;
    // now it stays registered as missing and attaches when it appears.
    this._watchTargets = new Map();
    this._retryTimer = null;
    this._retryIntervalMs = this._positiveInt(config.missingPathRetrySeconds, 30) * 1000;
    this._flushTimer = null;
    this._started = false;
    this._stopping = false;
    this._processingFiles = new Set();
    // Convertible files the converter could not handle yet (not installed,
    // missing extras, turned off). They are not quarantined; the retry tick
    // re-processes them once the converter reports it can.
    this._awaitingConversion = new Map();
    this._retryingConversions = false;

    // Concurrency-limited compilation queue — prevents 429 rate-limit avalanche
    // when large folders are added and chokidar fires hundreds of file events at once
    this._compileQueue = [];
    this._compileActive = 0;
    this._compileMaxConcurrent = this._positiveInt(config.compiler?.maxConcurrent, 3);
    this._compileMaxQueued = this._positiveInt(config.compiler?.maxQueue, 200);
    this._compileFailureCount = 0;
    this._compileCircuitFailures = this._positiveInt(config.compiler?.circuitFailures, 5);
    this._compileCircuitCooldownMs = this._positiveInt(config.compiler?.circuitCooldownMs, 60_000);
    this._compileCircuitOpenUntil = 0;

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
      pythonPath: converterConfig.pythonPath || 'python3',
      // Persisted and offered in both settings UIs, but never read before.
      enabled: converterConfig.enabled !== false,
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
      logger: this.logger,
      onGenerationLost: (filePath, label) => this._reingestLostGeneration(filePath, label),
      onFlushed: (flush) => {
        this._lastFlush = { at: new Date().toISOString(), nodes: flush.flushed, reason: flush.reason };
        this.onCommitted?.(flush);
      },
    });

    if (this.config.maintenanceMode === true) {
      this._started = true;
      this.logger?.info?.('Document feeder initialized in maintenance mode; watchers, scans, and flushes are disabled');
      return;
    }

    // Knowledge compiler — synthesizes documents before chunking
    this.compiler = new DocumentCompiler({
      workspacePath: this.config.workspacePath || path.join(runPath, '..', 'workspace'),
      config: this.compilerConfig,
      logger: this.logger,
    });

    // Log converter health once the async probe answers; start() never
    // waits on a python subprocess.
    this.converter.checkHealth().then((health) => {
      const log = health.state === 'ready' ? this.logger?.info : this.logger?.warn;
      log?.call(this.logger, `Document feeder: converter ${health.state}`, {
        reason: health.reason,
        remedy: health.remedy,
        runtime: health.runtime?.path,
      });
    }).catch(() => {});

    // Start default watcher on ingestion/documents/
    this._startWatcher(ingestDir, null, 'ingest');

    // Start additional configured watch paths. Settings -> Feeder saves a
    // folder as typed; '~' is the owner's home, never Home23's runtime HOME.
    const additionalPaths = (this.config.additionalWatchPaths || []).map((wp) => {
      const watchPath = expandOwnerPath(wp.path || wp);
      return { path: watchPath, label: wp.label || path.basename(watchPath) };
    });
    for (const { path: watchPath, label } of additionalPaths) {
      this._startWatcher(watchPath, label, 'configured');
    }

    // Start flush interval
    const intervalMs = (this.config.flush?.intervalSeconds || 300) * 1000;
    this._flushTimer = setInterval(() => {
      this.manifest.flush('interval');
    }, intervalMs);

    this._started = true;
    this._ensureRetryTimer();

    this.logger?.info?.('Document feeder started', {
      ingestDir,
      additionalPaths: additionalPaths.length,
      missingPaths: [...this._watchTargets.values()].filter(t => t.state !== 'attached').length,
    });

    // Run initial scan in background so it doesn't block the cognitive loop
    (async () => {
      try {
        // Files the old converter quarantined for its own faults (an image
        // sent to OpenAI with another provider's model, no API key, a
        // missing module, a format it never read) were pinned until their
        // bytes changed. Release them so this scan re-evaluates them; a
        // provider that still fails now leaves them waiting, not failed.
        const released = await this.manifest.releaseQuarantined(isConverterFaultQuarantine);
        if (released.length) {
          this.logger?.info?.('Released converter-fault quarantines for re-evaluation', { count: released.length });
        }
        await this._scanDirectory(ingestDir, null);
        for (const { path: watchPath, label } of additionalPaths) {
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
    watchPath = expandOwnerPath(watchPath);
    this._retryMissingWatchPaths();
    label = label || path.basename(watchPath);
    const existing = this._watchTargets.get(path.resolve(watchPath));
    // A second watcher on the same root doubled every file event.
    if (existing?.state === 'attached') {
      return { path: watchPath, label: existing.label, state: 'attached', duplicate: true };
    }
    const target = this._startWatcher(watchPath, label, existing?.source || 'runtime');
    if (target.state === 'attached') {
      // Scan in background so it doesn't block the cognitive loop startup
      this._scanDirectory(watchPath, target.label).then(() => {
        this.logger?.info?.('Watch path scan complete', { watchPath, label: target.label });
      }).catch(err => {
        this.logger?.warn?.('Watch path scan failed', { watchPath, error: err.message });
      });
      this.logger?.info?.('Added watch path (scanning in background)', { watchPath, label: target.label });
    }
    return { path: watchPath, label: target.label, state: target.state };
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
   * Resolve the label a file would receive from the active watcher that
   * covers it (deepest watch root wins). Falls back to the parent directory
   * name — the same default ingestFile uses.
   */
  labelForPath(filePath) {
    const resolved = path.resolve(filePath);
    let best = null;
    for (const w of this._watchers) {
      const root = path.resolve(w.path);
      if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
        if (!best || root.length > best.root.length) best = { root, label: w.label };
      }
    }
    return best ? best.label : path.basename(path.dirname(resolved));
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
    const hadTarget = this._watchTargets.delete(normalized);
    const idx = this._watchers.findIndex(w => path.resolve(w.path) === normalized);
    if (idx < 0 && !hadTarget) return false;
    if (idx >= 0) {
      const entry = this._watchers[idx];
      this._watchers.splice(idx, 1);
      try {
        await entry.watcher?.close();
      } catch (err) {
        this.logger?.warn?.('Error closing watcher', { path: watchPath, error: err.message });
      }
    }
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

  /** When the feeder last put items into live memory, for the freshness view. */
  flushFreshness() {
    return { lastFlushAt: this._lastFlush?.at || null, lastFlushNodes: this._lastFlush?.nodes ?? null };
  }

  /**
   * Get feeder status and stats.
   */
  async getStatus() {
    this._retryMissingWatchPaths();
    const manifestStats = this.manifest ? this.manifest.getStats() : { fileCount: 0, nodeCount: 0, pendingCount: 0 };
    const watchPaths = [...this._watchTargets.values()].map(t => ({
      path: t.path,
      label: t.label,
      source: t.source,
      state: t.state,
      configuredAt: t.configuredAt,
      attachedAt: t.attachedAt,
      missingSince: t.missingSince,
      lastCheckedAt: t.lastCheckedAt,
      lastError: t.lastError,
    }));
    const countState = state => watchPaths.filter(t => t.state === state).length;
    return {
      enabled: true,
      started: this._started,
      maintenanceMode: this.config.maintenanceMode === true,
      // Attached roots only; watchPaths carries configured-but-missing ones.
      watching: this._watchers.map(w => w.path),
      watchPaths,
      watchSummary: {
        configured: watchPaths.length,
        attached: countState('attached'),
        missing: countState('missing'),
        error: countState('error'),
      },
      manifest: manifestStats,
      converter: this._converterStatus(),
      compiler: {
        enabled: this.compilerConfig.enabled !== false,
        model: this.compilerConfig.model || null,
        queue: {
          queued: this._compileQueue.length,
          active: this._compileActive,
          maxConcurrent: this._compileMaxConcurrent,
          maxQueued: this._compileMaxQueued
        },
        circuit: {
          open: this._isCompileCircuitOpen(),
          failureCount: this._compileFailureCount,
          openUntil: this._compileCircuitOpenUntil || null,
          cooldownMs: this._compileCircuitCooldownMs
        }
      }
    };
  }

  /**
   * Flush, persist, close watchers.
   */
  async shutdown() {
    if (!this._started) return;
    this._stopping = true;
    this._clearRetryTimer();
    // Cancel an in-flight conversion instead of waiting up to 300 s for it.
    this.converter?.close?.();

    if (this.config.maintenanceMode === true) {
      this._started = false;
      this._stopping = false;
      this.logger?.info?.('Document feeder maintenance mode shut down without flushing');
      return;
    }

    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._flushDebounce) {
      clearTimeout(this._flushDebounce);
      this._flushDebounce = null;
    }

    const watchers = this._watchers;
    this._watchers = [];
    for (const w of watchers) {
      await w.watcher.close();
    }

    if (this.manifest) {
      await this.manifest.shutdown();
    }

    this._clearRetryTimer();
    this._started = false;
    this._stopping = false;
    this.logger?.info?.('Document feeder shut down');
  }

  // ─── Internal ────────────────────────────────────────────────

  /**
   * Register a watch root and attach it if it exists. Returns the target;
   * a missing root stays registered and the retry timer attaches it later.
   */
  _startWatcher(watchPath, fixedLabel, source = 'runtime') {
    const key = path.resolve(watchPath);
    let target = this._watchTargets.get(key);
    if (target?.state === 'attached') return target;
    if (!target) {
      target = {
        key,
        path: watchPath,
        label: fixedLabel,
        source,
        state: 'pending',
        configuredAt: new Date().toISOString(),
        attachedAt: null,
        missingSince: null,
        lastCheckedAt: null,
        lastError: null,
      };
      this._watchTargets.set(key, target);
    }
    if (!this._attachWatchTarget(target) && target.state === 'missing') {
      this.logger?.warn?.('Watch path does not exist yet; will attach when it appears', { watchPath });
    }
    this._ensureRetryTimer();
    return target;
  }

  _attachWatchTarget(target) {
    const now = new Date().toISOString();
    target.lastCheckedAt = now;
    if (!fs.existsSync(target.path)) {
      if (target.state !== 'missing') {
        target.state = 'missing';
        target.missingSince = now;
        target.attachedAt = null;
      }
      return false;
    }

    let watcher;
    try {
      watcher = chokidar.watch(target.path, this._watcherOptions());
    } catch (err) {
      target.state = 'error';
      target.lastError = err.message;
      this.logger?.error?.('Watcher attach failed', { watchPath: target.path, error: err.message });
      return false;
    }
    const watchPath = target.path;
    watcher.on('add', (filePath) => this._onFileEvent(filePath, target.label, watchPath));
    watcher.on('change', (filePath) => this._onFileEvent(filePath, target.label, watchPath));
    // chokidar 4 goes silent for good once its root is deleted, even if the
    // folder comes back; drop the watcher and let the retry reattach it. It
    // reports no unlinkDir for an empty root, so the retry tick also checks.
    watcher.on('unlinkDir', (dirPath) => {
      if (path.resolve(dirPath) === target.key) this._detachWatchTarget(target);
    });
    watcher.on('error', (err) => {
      target.lastError = err.message;
      this.logger?.error?.('Watcher error', { watchPath, error: err.message });
    });

    this._watchers.push({ path: watchPath, label: target.label, watcher });
    target.state = 'attached';
    target.attachedAt = now;
    target.missingSince = null;
    target.lastError = null;
    return true;
  }

  _detachWatchTarget(target) {
    const idx = this._watchers.findIndex(w => path.resolve(w.path) === target.key);
    if (idx >= 0) {
      const [entry] = this._watchers.splice(idx, 1);
      entry.watcher?.close().catch(err => {
        this.logger?.warn?.('Error closing watcher', { path: target.path, error: err.message });
      });
    }
    if (this._watchTargets.get(target.key) !== target) return;
    target.state = 'missing';
    target.attachedAt = null;
    target.missingSince = new Date().toISOString();
    this.logger?.warn?.('Watch path removed; will reattach when it reappears', { watchPath: target.path });
    this._ensureRetryTimer();
  }

  /**
   * Detach roots that disappeared, attach every registered root that has
   * appeared since the last check and scan it in the background
   * (ignoreInitial means chokidar reports nothing that already exists).
   * Manifest hashes dedupe files seen twice.
   */
  _retryMissingWatchPaths() {
    if (!this._started || this._stopping || this.config.maintenanceMode === true) return 0;
    let attached = 0;
    for (const target of [...this._watchTargets.values()]) {
      if (target.state === 'attached') {
        target.lastCheckedAt = new Date().toISOString();
        if (fs.existsSync(target.path)) continue;
        this._detachWatchTarget(target);
      }
      if (!this._attachWatchTarget(target)) continue;
      attached += 1;
      this.logger?.info?.('Watch path appeared; attached and scanning', { watchPath: target.path, label: target.label });
      this._scanDirectory(target.path, target.label)
        .then(() => this.manifest?.flush('watch-attach'))
        .catch(err => {
          this.logger?.warn?.('Watch path scan failed', { watchPath: target.path, error: err.message });
        });
    }
    return attached;
  }

  // One stat per watch root per tick (missingPathRetrySeconds, default 30 s),
  // unref'd so it never holds the process open. Never in maintenance mode.
  _ensureRetryTimer() {
    if (this._retryTimer || !this._started || this._stopping || this.config.maintenanceMode === true) return;
    this._retryTimer = setInterval(() => this._retryTick(), this._retryIntervalMs);
    this._retryTimer.unref?.();
  }

  _clearRetryTimer() {
    if (!this._retryTimer) return;
    clearInterval(this._retryTimer);
    this._retryTimer = null;
  }

  _retryTick() {
    try {
      this._retryMissingWatchPaths();
    } catch (err) {
      this.logger?.warn?.('Watch path retry failed', { error: err.message });
    }
    this._retryAwaitingConversions().catch(err => {
      this.logger?.warn?.('Awaiting-conversion retry failed', { error: err.message });
    });
  }

  _trackAwaitingConversion(key, filePath, label, result) {
    const previous = this._awaitingConversion.get(key);
    this._awaitingConversion.set(key, {
      filePath,
      label,
      status: result.status || 'converter_unavailable',
      reason: result.error || null,
      needs: result.needs || null,
      since: previous?.since || new Date().toISOString(),
    });
  }

  /**
   * Re-process files that were waiting on the converter once it reports it
   * can handle them (health is re-probed on its own TTL, not per file).
   */
  async _retryAwaitingConversions() {
    if (!this._awaitingConversion.size || !this.converter || this._retryingConversions) return 0;
    this._retryingConversions = true;
    let retried = 0;
    try {
      await this.converter.checkHealth?.();
      for (const [key, entry] of [...this._awaitingConversion]) {
        if (!this._started || this._stopping) break;
        if (!fs.existsSync(entry.filePath)) {
          this._awaitingConversion.delete(key);
          continue;
        }
        if (!this.converter.canConvertNow?.(entry.filePath, entry.needs)) continue;
        // _processFile puts it back if the converter still cannot.
        this._awaitingConversion.delete(key);
        await this._processFile(entry.filePath, entry.label);
        retried += 1;
      }
      if (retried) await this.manifest?.flush('awaiting-converter');
    } finally {
      this._retryingConversions = false;
    }
    return retried;
  }

  _converterStatus() {
    const maintenance = this.config.maintenanceMode === true;
    const health = typeof this.converter?.healthSnapshot === 'function'
      ? this.converter.healthSnapshot({ refresh: !maintenance })
      : { available: this.converter?.available || false };
    const pending = [...this._awaitingConversion.values()];
    return {
      ...health,
      // Compatibility: older web and Apple clients read these two fields.
      available: health.available === true,
      visionModel: this.config.converter?.visionModel || 'gpt-4o-mini',
      pendingConversionCount: pending.length,
      pendingConversion: pending.slice(0, 20).map(({ filePath, status, reason, needs, since }) => ({
        path: filePath, status, reason, needs, since,
      })),
    };
  }

  _watcherOptions() {
    return {
      persistent: true,
      // Startup is handled by _scanDirectory below. Letting chokidar emit
      // "add" for every existing file duplicates expensive conversion and
      // compilation work during engine boot.
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      depth: 99,
      ignored: (candidatePath) => this._shouldIgnorePath(candidatePath)
    };
  }

  // The manifest reset a generation whose chunk nodes a restart lost before
  // the brain saved them. Read the file again now rather than at the next
  // restart's scan or the next edit.
  async _reingestLostGeneration(filePath, label) {
    if (!this._started || this._stopping || this.config.maintenanceMode === true) return;
    await this._processFile(filePath, label);
    await this.manifest.flush('lost-generation');
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
    const processingKey = path.resolve(filePath);
    if (this._processingFiles.has(processingKey)) {
      this.logger?.debug?.('Skipping duplicate in-flight feeder processing', { filePath });
      return;
    }
    this._processingFiles.add(processingKey);
    try {
      // Skip dotfiles and our own manifest/pending files
      const basename = path.basename(filePath);
      if (basename.startsWith('.')) return;
      if (isIngestionInternalFile(basename)) return;
      if (this._shouldIgnorePath(filePath)) return;
      if (this._isManagedArtifact(basename)) {
        await this._purgeManagedArtifact(filePath, basename);
        return;
      }

      // Read file and check staleness
      let fileContent;
      let semanticEventAt = null;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return;
        if (this.maxFileBytes > 0 && stat.size > this.maxFileBytes) {
          this.logger?.info?.('Skipping file above feeder maxFileBytes', {
            filePath,
            size: stat.size,
            maxFileBytes: this.maxFileBytes
          });
          return;
        }
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
        const result = typeof this.converter.convertDetailed === 'function'
          ? await this.converter.convertDetailed(filePath)
          : await this.converter.convert(filePath);
        if (!result || result.ok === false) {
          if (result && result.retryable === false) {
            this._awaitingConversion.delete(processingKey);
            await this.manifest.trackQuarantined(filePath, label, fullHash, {
              status: result.status || 'conversion_failed',
              issues: [result.error || result.status || 'conversion failed'],
              structuralSignature: null
            });
          } else if (result) {
            this._trackAwaitingConversion(processingKey, filePath, label, result);
          }
          return;
        }
        this._awaitingConversion.delete(processingKey);
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
      semanticEventAt = deriveDocumentSemanticTime(text, filePath);

      // Session transcripts: keep dialogue (or a cron run's outcome), drop
      // operational events and tool chatter; skip chats another export covers.
      const transcript = normalizeTranscript(filePath, text);
      if (transcript.action === 'skip') {
        // Purge only a previously ingested file: removeFile rewrites the whole
        // manifest, and a startup scan revisits thousands of skipped files.
        if (this.manifest.getEntry(filePath)) {
          await this.manifest.removeFile(filePath);
          this.logger?.info?.('Purged skipped session transcript', { filePath, reason: transcript.reason });
        }
        return;
      }
      if (transcript.action === 'ingest') text = transcript.text;

      // Compile — LLM synthesizes the document in context of existing knowledge
      // Uses concurrency-limited queue to avoid 429 rate-limit avalanche on bulk ingestion
      let textForChunking = text;
      let usedCompiler = false;
      let compilerProvenance = null;
      try {
        // A normalized transcript is already clean dialogue; an LLM synthesis
        // per chat is not worth one model call per session file.
        const compiled = this.compilerConfig.enabled === false || transcript.action === 'ingest'
          ? null
          : await this._queueCompile(text, {
              filePath,
              format,
              contentHash: fullHash,
              semanticTime: semanticEventAt,
            });
        if (compiled && compiled.synthesis) {
          textForChunking = compiled.synthesis;
          usedCompiler = true;
          compilerProvenance = compiled.provenance || null;
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
      const provenance = buildDocumentNodeProvenance({
        filePath,
        fullHash,
        semanticTime: semanticEventAt,
        label,
        docFamily: classification.family,
        usedCompiler,
        compilerProvenance,
        sourceText: text,
      });

      // Enqueue with enriched metadata
      await this.manifest.enqueue(filePath, label, fullHash, chunks, relationships, {
        parseStatus: validation.status,
        structuralSignature: validation.structuralSignature,
        docFamily: classification.family,
        docFamilyConfidence: classification.confidence,
        compiled: usedCompiler,
        provenance,
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
    } finally {
      this._processingFiles.delete(processingKey);
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
          if (this._shouldIgnorePath(full)) continue;
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

  _shouldIgnorePath(candidatePath) {
    const basename = path.basename(candidatePath);
    if (basename.startsWith('.')) return true;
    if (isIngestionInternalFile(basename)) return true;
    if (this._isVolatileOperationalArtifact(candidatePath)) return true;

    const normalized = String(candidatePath).replace(/\\/g, '/');
    const patterns = Array.isArray(this.config.excludePatterns)
      ? this.config.excludePatterns.filter(p => typeof p === 'string' && p.trim())
      : [];
    return patterns.some(pattern => this._matchesGlob(normalized, pattern));
  }

  _isVolatileOperationalArtifact(candidatePath) {
    const normalized = String(candidatePath).replace(/\\/g, '/');
    const basename = path.basename(normalized);
    if (normalized.includes('/workspace/sessions/')) {
      return /^active-.+\.md$/i.test(basename);
    }

    if (!normalized.includes('/workspace/cron/')) return false;
    return new Set([
      'catalog.json',
      'status.md',
      'monitor-perf.jsonl',
      'cron-list.txt',
    ]).has(basename);
  }

  _matchesGlob(normalizedPath, pattern) {
    const raw = String(pattern || '').trim().replace(/\\/g, '/');
    if (!raw) return false;

    const escaped = raw
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*');

    return new RegExp(`^${escaped}$`).test(normalizedPath);
  }

  _positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
      if (this._isCompileCircuitOpen()) {
        const err = new Error('Document compiler circuit is open');
        err.code = 'FEEDER_COMPILER_CIRCUIT_OPEN';
        reject(err);
        return;
      }
      if (this._compileQueue.length >= this._compileMaxQueued) {
        const err = new Error('Document compiler queue is full');
        err.code = 'FEEDER_COMPILE_QUEUE_FULL';
        this.logger?.warn?.('Document compiler queue full, falling back to raw text', {
          queued: this._compileQueue.length,
          active: this._compileActive,
          maxQueued: this._compileMaxQueued
        });
        reject(err);
        return;
      }
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
          this._recordCompileSuccess();
          job.resolve(result);
        })
        .catch(err => {
          this._recordCompileFailure(err);
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

  _isCompileCircuitOpen(now = Date.now()) {
    if (!this._compileCircuitOpenUntil) return false;
    if (now < this._compileCircuitOpenUntil) return true;
    this._compileCircuitOpenUntil = 0;
    this._compileFailureCount = 0;
    return false;
  }

  _recordCompileSuccess() {
    this._compileFailureCount = 0;
    this._compileCircuitOpenUntil = 0;
  }

  _recordCompileFailure(err) {
    this._compileFailureCount++;
    if (this._compileFailureCount < this._compileCircuitFailures) return;

    this._compileCircuitOpenUntil = Date.now() + this._compileCircuitCooldownMs;
    this.logger?.warn?.('Document compiler circuit opened after repeated failures', {
      failureCount: this._compileFailureCount,
      cooldownMs: this._compileCircuitCooldownMs,
      error: err?.message || String(err)
    });
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

function buildDocumentNodeProvenance({
  filePath,
  fullHash,
  semanticTime,
  label,
  docFamily,
  usedCompiler,
  compilerProvenance,
  sourceText,
}) {
  const generated = usedCompiler === true;
  const generationMethod = generated
    ? 'document_compiler_synthesis'
    : 'document_raw_ingestion';
  const profile = {
    schema: 'home23.node-provenance.v1',
    authorityClass: generated ? 'narrative' : 'artifact_log',
    retrievalDomain: deriveDocumentRetrievalDomain({ filePath, label, docFamily, sourceText }),
    semanticTime: semanticTime || null,
    sourceRefs: boundedStrings([filePath]),
    evidenceRefs: boundedStrings([`sha256:${fullHash}`]),
    generationMethod,
    sourcePath: boundedString(filePath, 2048),
    contentHash: boundedString(fullHash, 128),
    scope: boundedStrings([label, docFamily]),
    expiresAt: null,
    operationalAuthority: false,
    requiresFreshVerification: true,
    derivedNodeIds: [],
  };
  if (generated && compilerProvenance?.model) {
    profile.generationModel = boundedString(compilerProvenance.model, 240);
  }
  return Object.freeze(profile);
}

function deriveDocumentSemanticTime(text, filePath) {
  const boundedText = String(text || '').slice(0, 64 * 1024);
  const structured = boundedText.match(
    /^(?:source_event_at|event_at|asserted_at|published_at|reported_at|date)\s*:\s*["']?([^\n"']+)/im,
  );
  const filenameDate = path.basename(filePath || '').match(/(?:^|[^0-9])(20\d{2}-\d{2}-\d{2})(?:[^0-9]|$)/)?.[1];
  return normalizeSemanticTime(structured?.[1]?.trim() || filenameDate || null);
}

function normalizeSemanticTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const dateOnly = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  const candidate = dateOnly ? `${value}T00:00:00.000Z` : value;
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function deriveDocumentRetrievalDomain({ filePath, label, docFamily, sourceText }) {
  const routingText = [filePath, label, docFamily]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const contentHeader = String(sourceText || '').slice(0, 1024).toLowerCase();
  const structuredClosedStatus = /["']?(?:status|state|resolution_status)["']?\s*[:=]\s*["']?(?:resolved|closed|fixed|completed|archived)\b/i
    .test(contentHeader);
  if (structuredClosedStatus) return 'closed_incidents';
  if (/\b(?:x[-_ ]?digest|twitter|timeline|news|rss|market|ticker|cron|telemetry|external)[-_ ]?\b/.test(
    `${routingText} ${contentHeader}`,
  )) return 'external_intake';
  if (/\b(?:closed|resolved|fixed|archived|resolution)[-_ ]?\b/.test(routingText)) {
    return 'closed_incidents';
  }
  if (/\b(?:current|live|runtime|operations?|status|health)[-_ ]?\b/.test(routingText)) {
    return 'current_ops';
  }
  return 'project_history';
}

function boundedStrings(values, limit = 8, maxBytes = 240) {
  const result = [];
  for (const value of values || []) {
    const bounded = boundedString(value, maxBytes);
    if (!bounded || result.includes(bounded)) continue;
    result.push(bounded);
    if (result.length >= limit) break;
  }
  return result;
}

function boundedString(value, maxBytes) {
  if (typeof value !== 'string' || !value) return null;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bounded = value.slice(0, maxBytes);
  while (bounded && Buffer.byteLength(bounded, 'utf8') > maxBytes) bounded = bounded.slice(0, -1);
  return bounded || null;
}

module.exports = { DocumentFeeder };
