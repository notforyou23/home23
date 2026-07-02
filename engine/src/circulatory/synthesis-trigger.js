'use strict';

/**
 * Synthesis Trigger — time-based guarantee that the brain oxygenates itself.
 *
 * The meta-coordinator has a probabilistic synthesis trigger (60-90% chance
 * every 3-4 review cycles). That's not reliable enough. The brain went 28K
 * cycles without auto-synthesis.
 *
 * This module guarantees: if brain-state.json hasn't been regenerated in
 * the last 6 hours, trigger synthesis on the next cognitive cycle.
 *
 * Rate limited: maximum 1 synthesis per 4 hours.
 */

const fs = require('fs').promises;
const path = require('path');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const RATE_LIMIT_MS = 4 * 60 * 60 * 1000; // Min 4 hours between triggers

class SynthesisTrigger {
  constructor(config = {}) {
    this.brainDir = config.brainDir;
    this.logger = config.logger;
    this.synthesisAgent = config.synthesisAgent; // injected
    this.lastCheckAt = 0;
    this.lastTriggerAt = 0;
    this.triggerCount = 0;
  }

  /**
   * Check if synthesis is due and trigger if so.
   * Called from orchestrator cognitive cycle.
   */
  async tick(now = Date.now()) {
    if (now - this.lastCheckAt < CHECK_INTERVAL_MS) return null;
    this.lastCheckAt = now;

    if (!this.brainDir) return null;

    // Read brain-state.json timestamp
    const statePath = path.join(this.brainDir, 'brain-state.json');
    let stateStat;
    try {
      stateStat = await fs.stat(statePath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        // No brain-state.json at all — definitely trigger
        return this._trigger(now, 'no_brain_state');
      }
      this._warn('failed to stat brain-state.json', e);
      return null;
    }

    const ageMs = now - stateStat.mtimeMs;

    // Check rate limit
    if (now - this.lastTriggerAt < RATE_LIMIT_MS) {
      return null;
    }

    // Check staleness
    if (ageMs < STALE_THRESHOLD_MS) {
      return null;
    }

    return this._trigger(now, `stale_brain_state_${Math.round(ageMs / (60 * 60 * 1000))}h`);
  }

  /**
   * Trigger synthesis agent.
   */
  async _trigger(now, reason) {
    this.lastTriggerAt = now;
    this.triggerCount++;

    this.logger?.info?.('[synthesis-trigger] triggering auto-synthesis', {
      reason,
      triggerNumber: this.triggerCount
    });

    if (!this.synthesisAgent) {
      this._warn('no synthesis agent available', null);
      return { triggered: false, reason: 'no_agent' };
    }

    try {
      const result = await this.synthesisAgent.run('auto_scheduled');
      this.logger?.info?.('[synthesis-trigger] synthesis complete', {
        reason,
        insights: result?.consolidatedInsights?.length || 0,
        durationMs: result?.durationMs,
      });
      return { triggered: true, reason, result };
    } catch (e) {
      this._warn('synthesis trigger failed', e);
      return { triggered: false, reason: 'error', error: e.message };
    }
  }

  _warn(msg, err) {
    this.logger?.warn?.(`[synthesis-trigger] ${msg}`, { error: err?.message || String(err) });
  }

  getStats() {
    return {
      triggerCount: this.triggerCount,
      lastTriggerAt: this.lastTriggerAt,
      lastCheckAt: this.lastCheckAt,
    };
  }
}

module.exports = { SynthesisTrigger };
