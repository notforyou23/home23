/**
 * ClusterMetrics
 *
 * Collect and aggregate metrics across cluster instances.
 * Phase F: Observability
 */

class ClusterMetrics {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.metrics = {};
  }

  /**
   * Record metric
   */
  record(name, value, tags = {}) {
    if (!this.metrics[name]) {
      this.metrics[name] = { values: [], tags: {} };
    }
    this.metrics[name].values.push({ value, timestamp: Date.now(), tags });
    if (this.metrics[name].values.length > 1000) {
      this.metrics[name].values.shift();
    }
  }

  /**
   * Get metrics summary
   */
  getSummary() {
    const summary = {};
    for (const [name, metric] of Object.entries(this.metrics)) {
      const values = metric.values.map(v => v.value).sort((a, b) => a - b);
      const p95 = values[Math.floor(values.length * 0.95)] || 0;
      summary[name] = { count: values.length, p95, latest: values[values.length - 1] || 0 };
    }
    return summary;
  }
}

module.exports = { ClusterMetrics };

