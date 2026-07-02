'use strict';

/**
 * Composter — extract patterns from discarded thoughts before clearing.
 *
 * Triggered by sweeper when discarded-thoughts.jsonl exceeds threshold.
 * Reads the file, extracts patterns, writes a summary observation,
 * then signals the sweeper to truncate.
 *
 * No LLM calls. Pure local pattern extraction.
 */

const fs = require('fs').promises;
const path = require('path');

const DISCARDED_THRESHOLD = 500;

class Composter {
  constructor(config = {}) {
    this.brainDir = config.brainDir;
    this.memory = config.memory; // brain memory graph
    this.logger = config.logger;
    this.totalComposted = 0;
  }

  /**
   * Check if composting is needed and run if so.
   */
  async tick(now = Date.now()) {
    if (!this.brainDir) return null;

    const filePath = path.join(this.brainDir, 'discarded-thoughts.jsonl');
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }

    const lines = content.split('\n').filter(Boolean);
    if (lines.length < DISCARDED_THRESHOLD) return null;

    // Parse and extract patterns
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }

    if (entries.length === 0) return null;

    const patterns = this._extractPatterns(entries);
    const summary = this._buildSummary(patterns, entries.length);

    // Write as brain observation node
    if (this.memory) {
      try {
        const node = await this.memory.addNode(summary, 'compost_receipt');
        this.logger?.info?.('[composter] wrote compost receipt', {
          nodeId: node?.id,
          sourceCount: entries.length
        });
      } catch (e) {
        this._warn('failed to write compost receipt to brain', e);
      }
    }

    // Truncate the file
    await fs.writeFile(filePath, '');
    this.totalComposted += entries.length;

    this.logger?.info?.('[composter] composting complete', {
      entriesProcessed: entries.length,
      summary,
    });

    return { entriesProcessed: entries.length, summary };
  }

  /**
   * Extract patterns from discarded thought entries.
   */
  _extractPatterns(entries) {
    const reasons = {};
    const signals = {};
    const hours = {};
    const models = {};

    for (const entry of entries) {
      // Discard reason
      const reason = entry.reason || 'unknown';
      reasons[reason] = (reasons[reason] || 0) + 1;

      // Signal type
      const signal = entry.candidate?.signal || 'unknown';
      signals[signal] = (signals[signal] || 0) + 1;

      // Time of day
      const ts = entry.ts || entry.temporalContext?.now;
      if (ts) {
        const hour = new Date(ts).getHours();
        hours[hour] = (hours[hour] || 0) + 1;
      }

      // Model
      const model = entry.finalVerdict?.model || entry.finalVerdict?.passes?.[0]?.model;
      if (model) {
        models[model] = (models[model] || 0) + 1;
      }
    }

    return { reasons, signals, hours, models };
  }

  /**
   * Build a human-readable summary from patterns.
   */
  _buildSummary(patterns, total) {
    const { reasons, signals, hours, models } = patterns;

    // Top reason
    const topReasons = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, c]) => `${r} (${c})`)
      .join(', ');

    // Top signal
    const topSignals = Object.entries(signals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, c]) => `${s} (${c})`)
      .join(', ');

    // Peak hour
    const peakHour = Object.entries(hours)
      .sort((a, b) => b[1] - a[1])[0];
    const peakHourStr = peakHour ? `peak hour ${peakHour[0]}:00 (${peakHour[1]} discards)` : 'no time pattern';

    return `Compost receipt: ${total} discarded thoughts processed. Top reasons: ${topReasons}. Top signals: ${topSignals}. ${peakHourStr}. Pattern: the thinking machine is discarding mostly low-signal candidates that should have been filtered earlier in the pipeline.`;
  }

  _warn(msg, err) {
    this.logger?.warn?.(`[composter] ${msg}`, { error: err?.message || String(err) });
  }

  getStats() {
    return { totalComposted: this.totalComposted };
  }
}

module.exports = { Composter };
