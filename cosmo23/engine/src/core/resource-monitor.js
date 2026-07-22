/**
 * ResourceMonitor
 *
 * Phase A: Resource limits and monitoring
 * - Track memory usage (avg, peak)
 * - Track CPU usage
 * - Enforce resource limits
 * - Detect resource exhaustion before OOM
 * - Provide telemetry for baseline metrics
 */

const v8 = require('v8');

class ResourceMonitor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Resource limits (from config or defaults)
    this.memoryLimitMB = config.resources?.memoryLimitMB || 512; // 512MB default
    this.memoryWarningThreshold = config.resources?.memoryWarningThreshold || 0.8; // 80%
    this.cpuWarningThreshold = config.resources?.cpuWarningThreshold || 0.9; // 90%
    
    // Tracking
    this.memorySnapshots = [];
    this.cpuSnapshots = [];
    this.startTime = Date.now();
    this.lastCheck = Date.now();
    
    // Stats
    this.peakMemoryMB = 0;
    this.avgMemoryMB = 0;
    this.avgCPUPercent = 0;
    this.warningCount = 0;
    this.limitExceededCount = 0;

    // GC stats tracking
    this.lastGCTime = Date.now();
    this.gcCount = 0;

    // H4 backpressure: single-source-of-truth object. Producers (this monitor)
    // WRITE it in place; consumers (AgentExecutor spawn gate) hold a reference
    // and READ it. NEVER reassign this.backpressure — the orchestrator and the
    // agent executor alias the same object instance.
    const bp = config.resources?.backpressure || {};
    this.rssBudgetMb = config.resources?.rssBudgetMb
      ?? 4096; // engine child runs with default V8 heap (~4GB old space)
    this.bpIntervalMs = bp.intervalMs ?? 10000;
    this.bpThresholds = {
      elevatedEnterPct: bp.elevatedEnterPct ?? 0.70,
      elevatedExitPct: bp.elevatedExitPct ?? 0.60,
      criticalEnterPct: bp.criticalEnterPct ?? 0.85,
      criticalExitPct: bp.criticalExitPct ?? 0.75
    };
    // Heap leg floor: a live set below this cannot meaningfully threaten the
    // ~multi-GB heap_size_limit, so below it the heap term contributes 0
    // (keeps tiny heaps from flapping). RSS-vs-budget always counts.
    this.bpHeapMinTotalMb = bp.heapMinTotalMb ?? 512;
    // Injectable for tests (never monkey-patch the v8 module globally);
    // readings may also carry heapSizeLimit directly.
    this._heapStatsProvider = () => v8.getHeapStatistics();
    this.backpressure = { level: 'none', reasons: [] };
    this._bpElevatedActive = false;
    this._bpCriticalActive = false;
    this._bpTimer = null;
  }

  /**
   * Take a resource snapshot
   * Call this at cycle boundaries
   */
  snapshot() {
    const memUsage = process.memoryUsage();
    const memUsedMB = memUsage.heapUsed / 1024 / 1024;
    const memTotalMB = memUsage.heapTotal / 1024 / 1024;
    const rss = memUsage.rss / 1024 / 1024;

    // CPU usage (approximate via process.cpuUsage)
    const cpuUsage = process.cpuUsage();
    const cpuPercent = this.calculateCPUPercent(cpuUsage);

    // Track snapshot
    const snapshot = {
      timestamp: Date.now(),
      memUsedMB,
      memTotalMB,
      rss,
      cpuPercent,
      external: memUsage.external / 1024 / 1024,
      arrayBuffers: memUsage.arrayBuffers / 1024 / 1024
    };

    this.memorySnapshots.push(snapshot);
    this.cpuSnapshots.push(cpuPercent);

    // Keep only last 100 snapshots
    if (this.memorySnapshots.length > 100) {
      this.memorySnapshots.shift();
    }
    if (this.cpuSnapshots.length > 100) {
      this.cpuSnapshots.shift();
    }

    // Update peak
    if (memUsedMB > this.peakMemoryMB) {
      this.peakMemoryMB = memUsedMB;
    }

    // Calculate averages
    this.avgMemoryMB = this.memorySnapshots.reduce((sum, s) => sum + s.memUsedMB, 0) / this.memorySnapshots.length;
    this.avgCPUPercent = this.cpuSnapshots.reduce((sum, c) => sum + c, 0) / this.cpuSnapshots.length;

    // Check limits
    this.checkLimits(snapshot);

    // H4: refresh backpressure at cycle boundaries too (interval timer covers
    // long gaps between cycles; this covers fast cycles between ticks)
    this.evaluateBackpressure({
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss
    });

    this.lastCheck = Date.now();

    return snapshot;
  }

  /**
   * Calculate CPU percent (approximate)
   */
  calculateCPUPercent(cpuUsage) {
    const now = Date.now();
    const elapsedMs = now - this.lastCheck;
    
    if (elapsedMs === 0) return 0;

    // Total CPU time in microseconds
    const totalCPU = (cpuUsage.user + cpuUsage.system) / 1000; // Convert to ms
    
    // CPU percentage (very rough approximation)
    const cpuPercent = Math.min(100, (totalCPU / elapsedMs) * 100);
    
    return cpuPercent;
  }

  /**
   * Check if limits are exceeded
   */
  checkLimits(snapshot) {
    const memUsedPercent = snapshot.memUsedMB / this.memoryLimitMB;

    // Memory warning threshold
    if (memUsedPercent >= this.memoryWarningThreshold && memUsedPercent < 1.0) {
      this.warningCount++;
      this.logger.warn('[ResourceMonitor] Memory warning', {
        memUsedMB: snapshot.memUsedMB.toFixed(2),
        limitMB: this.memoryLimitMB,
        percent: (memUsedPercent * 100).toFixed(1)
      });
    }

    // Memory limit exceeded
    if (snapshot.memUsedMB >= this.memoryLimitMB) {
      this.limitExceededCount++;
      this.logger.error('[ResourceMonitor] Memory limit exceeded', {
        memUsedMB: snapshot.memUsedMB.toFixed(2),
        limitMB: this.memoryLimitMB,
        peakMB: this.peakMemoryMB.toFixed(2)
      });
      
      // Trigger GC if available
      if (global.gc) {
        this.logger.info('[ResourceMonitor] Forcing garbage collection');
        global.gc();
        this.gcCount++;
        this.lastGCTime = Date.now();
      } else {
        this.logger.warn('[ResourceMonitor] global.gc not available (run with --expose-gc)');
      }
    }

    // CPU warning
    if (snapshot.cpuPercent >= this.cpuWarningThreshold * 100) {
      this.logger.warn('[ResourceMonitor] High CPU usage', {
        cpuPercent: snapshot.cpuPercent.toFixed(1),
        threshold: (this.cpuWarningThreshold * 100).toFixed(1)
      });
    }
  }

  /**
   * H4 backpressure evaluation with hysteresis.
   *
   * Pressure = max(heapUsed / v8 heap_size_limit [only when heapUsed >= heapMinTotalMb],
   *                rss / rssBudgetMb).
   * heapUsed/heapTotal deliberately NOT used: V8 keeps heapTotal ~1.1-1.5x the
   * live set, so that ratio measures GC slack and chronically false-flags
   * healthy large heaps. heap_size_limit is the actual OOM boundary and
   * self-adapts to any --max-old-space-size.
   * Two-flag hysteresis: enter elevated at 70%, exit at 60%; enter critical at
   * 85%, exit at 75%. Exiting critical drops into the elevated band unless
   * pressure also cleared the elevated exit threshold. Logs on level CHANGE only.
   *
   * Writes this.backpressure IN PLACE (same object identity) so consumers
   * holding the reference observe updates. Saves are never gated on this —
   * enforcement is spawn-side only (AgentExecutor).
   *
   * @param {Object|null} reading - optional injected {heapUsed, heapTotal, rss[, heapSizeLimit]} in BYTES (tests)
   * @returns {string} the new level: 'none' | 'elevated' | 'critical'
   */
  evaluateBackpressure(reading = null) {
    const mem = reading || process.memoryUsage();
    const heapLimitBytes = mem.heapSizeLimit ?? this._heapStatsProvider().heap_size_limit;
    const heapLimitMb = heapLimitBytes / 1024 / 1024;
    const heapUsedMb = mem.heapUsed / 1024 / 1024;
    const rawHeapFraction = heapLimitBytes > 0 ? mem.heapUsed / heapLimitBytes : 0;
    // Floor gates on heapUsed: heap_size_limit is a fixed multi-GB boundary,
    // so heapTotal no longer identifies tiny heaps — a live set under the
    // floor cannot meaningfully threaten the limit.
    // Effective floor = min(configured floor, 50% of the actual limit): with
    // a small --max-old-space-size (e.g. 256MB) the raw 512MB floor would sit
    // ABOVE the whole heap and permanently disarm the heap leg. Unchanged at
    // the default ~4.3GB limit, where min() returns the configured floor.
    const effectiveHeapFloorMb = Math.min(this.bpHeapMinTotalMb, 0.5 * heapLimitMb);
    const heapFraction = heapUsedMb >= effectiveHeapFloorMb ? rawHeapFraction : 0;
    const rssMb = mem.rss / 1024 / 1024;
    const rssFraction = this.rssBudgetMb > 0 ? rssMb / this.rssBudgetMb : 0;
    const pressure = Math.max(heapFraction, rssFraction);
    const t = this.bpThresholds;

    // Two-flag hysteresis; critical implies elevated
    this._bpCriticalActive = this._bpCriticalActive
      ? pressure >= t.criticalExitPct
      : pressure >= t.criticalEnterPct;
    this._bpElevatedActive = (this._bpElevatedActive || this._bpCriticalActive)
      ? pressure >= t.elevatedExitPct
      : pressure >= t.elevatedEnterPct;
    if (this._bpCriticalActive) this._bpElevatedActive = true;

    const level = this._bpCriticalActive ? 'critical'
      : (this._bpElevatedActive ? 'elevated' : 'none');
    const reasons = [];
    if (level !== 'none') {
      const driver = heapFraction >= rssFraction ? 'heap' : 'rss';
      reasons.push(`pressure=${(pressure * 100).toFixed(1)}% driver=${driver}`);
      reasons.push(`heap ${heapUsedMb.toFixed(0)}MB / ${heapLimitMb.toFixed(0)}MB heap_size_limit (${(rawHeapFraction * 100).toFixed(1)}%)${heapUsedMb < effectiveHeapFloorMb ? ' (below floor, ignored)' : ''}`);
      reasons.push(`rss ${rssMb.toFixed(0)}MB / ${this.rssBudgetMb}MB budget (${(rssFraction * 100).toFixed(1)}%)`);
    }

    const previousLevel = this.backpressure.level;
    // Mutate in place — consumers hold this object reference (H4)
    this.backpressure.level = level;
    this.backpressure.reasons = reasons;

    if (level !== previousLevel) {
      const line = '[ResourceMonitor] Backpressure level change';
      const detail = {
        from: previousLevel,
        to: level,
        pressurePct: (pressure * 100).toFixed(1),
        heapPct: (rawHeapFraction * 100).toFixed(1),
        heapUsedMb: heapUsedMb.toFixed(0),
        heapLimitMb: heapLimitMb.toFixed(0),
        rssMb: rssMb.toFixed(0),
        rssBudgetMb: this.rssBudgetMb,
        reasons
      };
      if (level === 'none') {
        this.logger.info(line, detail);
      } else {
        this.logger.warn(line, detail);
      }
    }

    return level;
  }

  /**
   * Start the periodic backpressure evaluator (unref'd — never holds the
   * process open). Idempotent. Cycle boundaries also refresh via snapshot().
   */
  startBackpressureMonitor() {
    if (this._bpTimer) return;
    this._bpTimer = setInterval(() => {
      try {
        this.evaluateBackpressure();
      } catch (err) {
        this.logger.warn('[ResourceMonitor] Backpressure evaluation failed', { error: err.message });
      }
    }, this.bpIntervalMs);
    if (typeof this._bpTimer.unref === 'function') this._bpTimer.unref();
    this.logger.info('[ResourceMonitor] Backpressure monitor started', {
      intervalMs: this.bpIntervalMs,
      rssBudgetMb: this.rssBudgetMb,
      thresholds: this.bpThresholds
    });
  }

  /**
   * Stop the periodic backpressure evaluator. Level/reasons are left as-is.
   */
  stopBackpressureMonitor() {
    if (this._bpTimer) {
      clearInterval(this._bpTimer);
      this._bpTimer = null;
    }
  }

  /**
   * Check if resources are healthy
   */
  isHealthy() {
    const latestSnapshot = this.memorySnapshots[this.memorySnapshots.length - 1];
    if (!latestSnapshot) return true;

    const memUsedPercent = latestSnapshot.memUsedMB / this.memoryLimitMB;
    return memUsedPercent < 1.0; // Not exceeded limit
  }

  /**
   * Get current stats
   */
  getStats() {
    const uptimeMs = Date.now() - this.startTime;
    const latestSnapshot = this.memorySnapshots[this.memorySnapshots.length - 1];

    return {
      uptimeMs,
      uptimeHuman: this.formatUptime(uptimeMs),
      memory: {
        currentMB: latestSnapshot ? latestSnapshot.memUsedMB.toFixed(2) : 0,
        avgMB: this.avgMemoryMB.toFixed(2),
        peakMB: this.peakMemoryMB.toFixed(2),
        limitMB: this.memoryLimitMB,
        percentUsed: latestSnapshot ? ((latestSnapshot.memUsedMB / this.memoryLimitMB) * 100).toFixed(1) : 0,
        rss: latestSnapshot ? latestSnapshot.rss.toFixed(2) : 0
      },
      cpu: {
        currentPercent: latestSnapshot ? latestSnapshot.cpuPercent.toFixed(1) : 0,
        avgPercent: this.avgCPUPercent.toFixed(1)
      },
      warnings: {
        memoryWarnings: this.warningCount,
        limitExceeded: this.limitExceededCount,
        gcForced: this.gcCount
      },
      backpressure: {
        level: this.backpressure.level,
        reasons: this.backpressure.reasons.slice()
      },
      healthy: this.isHealthy(),
      snapshotCount: this.memorySnapshots.length
    };
  }

  /**
   * Get metrics for baseline capture
   */
  getBaselineMetrics() {
    const stats = this.getStats();
    return {
      memory: {
        avg: parseFloat(stats.memory.avgMB),
        peak: parseFloat(stats.memory.peakMB),
        limit: this.memoryLimitMB
      },
      cpu: {
        avg: parseFloat(stats.cpu.avgPercent)
      },
      uptime: {
        ms: Date.now() - this.startTime,
        seconds: Math.floor((Date.now() - this.startTime) / 1000)
      }
    };
  }

  /**
   * Format uptime to human readable
   */
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Reset stats (for testing)
   */
  reset() {
    this.memorySnapshots = [];
    this.cpuSnapshots = [];
    this.peakMemoryMB = 0;
    this.avgMemoryMB = 0;
    this.avgCPUPercent = 0;
    this.warningCount = 0;
    this.limitExceededCount = 0;
    this.gcCount = 0;
    this.startTime = Date.now();
    this._bpElevatedActive = false;
    this._bpCriticalActive = false;
    // In place — never reassign (H4 shared object identity)
    this.backpressure.level = 'none';
    this.backpressure.reasons = [];
  }
}

module.exports = { ResourceMonitor };

