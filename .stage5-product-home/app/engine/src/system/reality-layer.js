// src/system/reality-layer.js
const fs = require('fs').promises;
const path = require('path');

/**
 * RealityLayer - Structured evidence layer for COSMO
 * 
 * Purpose:
 * - Provides snapshot of current system state
 * - Tracks recent agent outputs from introspection
 * - Loads validation and drift reports
 * - Generates alerts for critical issues
 * - Grounds COSMO's cognition in objective reality
 * 
 * Design:
 * - No GPT dependency (pure data layer)
 * - Integrated with introspection module
 * - Provides structured context for thought generation
 * - Optional validation/drift tracking
 */
class RealityLayer {
  constructor(config, logger, memory, runRoot) {
    this.config = config;
    this.logger = logger;
    this.memory = memory;
    this.runRoot = runRoot;
    
    this.state = {
      lastSnapshotAt: 0,
      lastValidationReport: null,
      lastDriftReport: null
    };
    
    this.paths = {
      manifestsDir: path.join(runRoot, 'outputs', 'manifests'),
      reportsDir: path.join(runRoot, 'outputs', 'reports')
    };
    
    this._recentOutputs = [];
  }

  /**
   * Update with latest introspection results
   * Called by orchestrator after introspection scan
   */
  async updateFromIntrospection(items) {
    if (!items || items.length === 0) return;
    this._recentOutputs = items;
    this.state.lastSnapshotAt = Date.now();
  }

  /**
   * Load validation report if exists (optional)
   */
  async loadValidationReport() {
    const fp = path.join(this.paths.reportsDir, 'validation_report.json');
    try {
      const raw = await fs.readFile(fp, 'utf8');
      this.state.lastValidationReport = JSON.parse(raw);
    } catch {
      // File doesn't exist - that's fine
    }
  }

  /**
   * Load drift report if exists (optional)
   */
  async loadDriftReport() {
    const fp = path.join(this.paths.reportsDir, 'drift_report.json');
    try {
      const raw = await fs.readFile(fp, 'utf8');
      this.state.lastDriftReport = JSON.parse(raw);
    } catch {
      // File doesn't exist - that's fine
    }
  }

  /**
   * Build complete reality snapshot
   * Returns structured object for context injection
   */
  async buildSnapshot() {
    await this.loadValidationReport();
    await this.loadDriftReport();

    const snapshot = {
      timestamp: Date.now(),
      recentOutputs: (this._recentOutputs || []).map(o => ({
        filePath: o.filePath || 'unknown',
        agentType: o.agentType || 'unknown',
        agentId: o.agentId || 'unknown',
        preview: (o.preview || '').slice(0, 200),
        timestamp: o.timestamp || Date.now()
      })),
      validation: this.state.lastValidationReport,
      drift: this.state.lastDriftReport,
      alerts: this.buildAlerts()
    };

    return snapshot;
  }

  /**
   * Generate alerts based on validation/drift status
   */
  buildAlerts() {
    const alerts = [];
    const v = this.state.lastValidationReport;
    const d = this.state.lastDriftReport;

    if (v && v.status === 'fail') {
      alerts.push({
        type: 'validation_fail',
        message: 'Validation failed - outputs may be inconsistent',
        severity: 'high'
      });
    }

    if (d && (d.percentartifactschanged || 0) > 5) {
      alerts.push({
        type: 'drift_high',
        message: `Artifact drift at ${(d.percentartifactschanged || 0).toFixed(2)}%`,
        severity: 'medium'
      });
    }

    return alerts;
  }
}

module.exports = { RealityLayer };

