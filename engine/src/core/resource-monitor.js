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
  }
}

module.exports = { ResourceMonitor };

