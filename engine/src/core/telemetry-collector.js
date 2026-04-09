/**
 * TelemetryCollector
 *
 * Phase A: Comprehensive telemetry collection
 * - Structured JSON logs (timestamp, level, context)
 * - Metrics aggregation (cycle time, memory, goals, errors)
 * - Event stream (lifecycle, state changes)
 * - Telemetry stats
 * - Zero telemetry errors
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Generate correlation ID for trace joins
 */
function generateCorrelationId(context) {
  const parts = [];
  if (context.cycleCount) parts.push(`cycle_${context.cycleCount}`);
  if (context.agentId) parts.push(`agent_${context.agentId.slice(-8)}`);
  if (context.goalId) parts.push(`goal_${context.goalId.slice(-8)}`);
  return parts.length > 0 ? parts.join('_') : `event_${Date.now()}`;
}

class TelemetryCollector {
  constructor(config, logger, logsDir) {
    this.config = config;
    this.logger = logger;
    this.logsDir = logsDir || path.join(__dirname, '..', '..', 'runtime');

    // Telemetry settings
    this.structuredLogsEnabled = config.telemetry?.structuredLogs !== false; // Default true
    this.metricsEnabled = config.telemetry?.metrics !== false; // Default true
    this.eventsEnabled = config.telemetry?.events !== false; // Default true
    
    // Paths
    this.structuredLogPath = path.join(this.logsDir, 'telemetry.log');
    this.metricsPath = path.join(this.logsDir, 'metrics.json');
    this.eventsPath = path.join(this.logsDir, 'events.log');
    
    // In-memory buffers
    this.logBuffer = [];
    this.eventBuffer = [];
    this.metrics = {};
    
    // Stats
    this.logsEmitted = 0;
    this.metricsEmitted = 0;
    this.eventsEmitted = 0;
    this.telemetryErrors = 0;
    
    // Flush settings
    this.flushInterval = config.telemetry?.flushIntervalMs || 5000; // 5s
    this.maxBufferSize = config.telemetry?.maxBufferSize || 100;
    this.flushTimer = null;
  }

  /**
   * Initialize telemetry collector
   */
  async initialize() {
    // Start flush timer
    this.flushTimer = setInterval(() => {
      this.flush().catch(error => {
        this.logger.error('[Telemetry] Flush error', { error: error.message });
        this.telemetryErrors++;
      });
    }, this.flushInterval);

    this.logger.info('[Telemetry] Initialized', {
      structuredLogs: this.structuredLogsEnabled,
      metrics: this.metricsEnabled,
      events: this.eventsEnabled,
      flushIntervalMs: this.flushInterval
    });
  }

  /**
   * Log structured entry
   * @param {string} level - log level (info, warn, error, debug)
   * @param {string} message - log message
   * @param {object} context - additional context
   */
  logStructured(level, message, context = {}) {
    if (!this.structuredLogsEnabled) return;

    try {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        correlationId: generateCorrelationId(context),
        ...context
      };

      this.logBuffer.push(entry);
      this.logsEmitted++;

      // Auto-flush if buffer full
      if (this.logBuffer.length >= this.maxBufferSize) {
        this.flush().catch(error => {
          this.telemetryErrors++;
        });
      }
    } catch (error) {
      this.telemetryErrors++;
      // Don't throw - telemetry should never crash the app
    }
  }

  /**
   * Record metric
   * @param {string} name - metric name
   * @param {number} value - metric value
   * @param {object} tags - metric tags
   */
  recordMetric(name, value, tags = {}) {
    if (!this.metricsEnabled) return;

    try {
      const timestamp = new Date().toISOString();
      
      if (!this.metrics[name]) {
        this.metrics[name] = {
          values: [],
          tags: {},
          count: 0,
          sum: 0,
          min: value,
          max: value,
          avg: value
        };
      }

      const metric = this.metrics[name];
      metric.values.push({ value, timestamp, tags });
      metric.count++;
      metric.sum += value;
      metric.min = Math.min(metric.min, value);
      metric.max = Math.max(metric.max, value);
      metric.avg = metric.sum / metric.count;
      metric.tags = { ...metric.tags, ...tags };

      // Keep only last 1000 values
      if (metric.values.length > 1000) {
        metric.values.shift();
      }

      this.metricsEmitted++;
    } catch (error) {
      this.telemetryErrors++;
    }
  }

  /**
   * Emit event
   * @param {string} eventType - event type (lifecycle, state_change, etc)
   * @param {object} data - event data
   */
  emitEvent(eventType, data = {}) {
    if (!this.eventsEnabled) return;

    try {
      const event = {
        timestamp: new Date().toISOString(),
        eventType,
        ...data
      };

      this.eventBuffer.push(event);
      this.eventsEmitted++;

      // Auto-flush if buffer full
      if (this.eventBuffer.length >= this.maxBufferSize) {
        this.flush().catch(error => {
          this.telemetryErrors++;
        });
      }
    } catch (error) {
      this.telemetryErrors++;
    }
  }

  /**
   * Flush buffers to disk
   */
  async flush() {
    const errors = [];

    // Flush logs
    if (this.logBuffer.length > 0) {
      try {
        const logEntries = this.logBuffer.splice(0);
        const logLines = logEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        await fs.appendFile(this.structuredLogPath, logLines, 'utf8');
      } catch (error) {
        this.telemetryErrors++;
        errors.push({ type: 'logs', error: error.message });
      }
    }

    // Flush events
    if (this.eventBuffer.length > 0) {
      try {
        const eventEntries = this.eventBuffer.splice(0);
        const eventLines = eventEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        await fs.appendFile(this.eventsPath, eventLines, 'utf8');
      } catch (error) {
        this.telemetryErrors++;
        errors.push({ type: 'events', error: error.message });
      }
    }

    // Flush metrics
    if (Object.keys(this.metrics).length > 0) {
      try {
        const metricsSnapshot = {
          timestamp: new Date().toISOString(),
          metrics: this.metrics
        };
        await fs.writeFile(this.metricsPath, JSON.stringify(metricsSnapshot, null, 2), 'utf8');
      } catch (error) {
        this.telemetryErrors++;
        errors.push({ type: 'metrics', error: error.message });
      }
    }

    if (errors.length > 0) {
      this.logger.error('[Telemetry] Flush errors', { errors });
    }
  }

  /**
   * Get metric summary
   * @param {string} name - metric name
   * @returns {object} - { count, sum, min, max, avg, p50, p95, p99 }
   */
  getMetricSummary(name) {
    const metric = this.metrics[name];
    if (!metric) return null;

    // Calculate percentiles
    const values = metric.values.map(v => v.value).sort((a, b) => a - b);
    const p50 = this.percentile(values, 0.50);
    const p95 = this.percentile(values, 0.95);
    const p99 = this.percentile(values, 0.99);

    return {
      count: metric.count,
      sum: metric.sum,
      min: metric.min,
      max: metric.max,
      avg: metric.avg,
      p50,
      p95,
      p99,
      tags: metric.tags
    };
  }

  /**
   * Calculate percentile
   */
  percentile(values, p) {
    if (values.length === 0) return 0;
    const index = Math.ceil(values.length * p) - 1;
    return values[Math.max(0, index)];
  }

  /**
   * Get all metrics summaries
   */
  getAllMetrics() {
    const summaries = {};
    for (const name of Object.keys(this.metrics)) {
      summaries[name] = this.getMetricSummary(name);
    }
    return summaries;
  }

  /**
   * Get telemetry stats
   */
  getStats() {
    return {
      logsEmitted: this.logsEmitted,
      metricsEmitted: this.metricsEmitted,
      eventsEmitted: this.eventsEmitted,
      telemetryErrors: this.telemetryErrors,
      logBufferSize: this.logBuffer.length,
      eventBufferSize: this.eventBuffer.length,
      metricsCount: Object.keys(this.metrics).length,
      enabled: {
        structuredLogs: this.structuredLogsEnabled,
        metrics: this.metricsEnabled,
        events: this.eventsEnabled
      }
    };
  }

  /**
   * Get baseline metrics for Phase A
   */
  getBaselineMetrics() {
    return {
      telemetry: {
        logsEmitted: this.logsEmitted,
        metricsEmitted: this.metricsEmitted,
        eventsEmitted: this.eventsEmitted,
        telemetryErrors: this.telemetryErrors,
        errorRate: this.logsEmitted > 0 ? (this.telemetryErrors / this.logsEmitted) : 0
      },
      metrics: this.getAllMetrics()
    };
  }

  /**
   * Record cycle metrics
   * Convenience method for orchestrator
   */
  recordCycleMetrics(cycle, metrics) {
    this.recordMetric('cycle.time', metrics.cycleTimeMs, { cycle });
    this.recordMetric('cycle.memory', metrics.memoryMB, { cycle });
    this.recordMetric('cycle.goals', metrics.activeGoals, { cycle });
    if (metrics.errors) {
      this.recordMetric('cycle.errors', metrics.errors, { cycle });
    }
  }

  /**
   * Emit lifecycle event
   * Convenience method for orchestrator
   */
  emitLifecycleEvent(eventName, data = {}) {
    this.emitEvent('lifecycle', {
      event: eventName,
      ...data
    });
  }

  /**
   * Cleanup telemetry
   * Final flush and stop timer
   */
  async cleanup() {
    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    await this.flush();

    this.logger.info('[Telemetry] Cleanup complete', {
      logsEmitted: this.logsEmitted,
      metricsEmitted: this.metricsEmitted,
      eventsEmitted: this.eventsEmitted,
      errors: this.telemetryErrors
    });
  }

  /**
   * Reset telemetry (for testing)
   */
  reset() {
    this.logBuffer = [];
    this.eventBuffer = [];
    this.metrics = {};
    this.logsEmitted = 0;
    this.metricsEmitted = 0;
    this.eventsEmitted = 0;
    this.telemetryErrors = 0;
  }
}

module.exports = { TelemetryCollector };

