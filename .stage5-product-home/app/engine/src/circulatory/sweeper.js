'use strict';

/**
 * Waste Sweeper — periodic cleanup of accumulated cruft.
 *
 * Runs every 30 minutes (checked via timestamp in orchestrator).
 * All local, no LLM calls, all bounded.
 *
 * Cleans:
 *   1. Empty agent directories (no real files, only .DS_Store or empty)
 *   2. Overgrown JSONL files (thoughts, dreams, discarded-thoughts)
 *   3. Old cron-decision archives (> 30 days)
 *
 * Safety:
 *   - Never deletes non-empty agent dirs
 *   - Archives before truncating
 *   - Logs every action with counts
 */

const fs = require('fs').promises;
const path = require('path');

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const AGENT_DIR_MIN_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const THOUGHTS_MAX_LINES = 1000;
const THOUGHTS_KEEP_LINES = 500;
const DREAMS_MAX_LINES = 2000;
const DREAMS_KEEP_LINES = 500;
const DISCARDED_MAX_LINES = 500;
const CRON_ARCHIVE_MAX_AGE_DAYS = 30;
// A sweep runs inline at the start of a cognitive cycle. Cap directory checks
// so historical agent-output buildup cannot stall the loop before it journals.
const AGENT_DIR_SCAN_LIMIT = 200;

class Sweeper {
  constructor(config = {}) {
    this.brainDir = config.brainDir;
    this.logsDir = config.logsDir;
    this.logger = config.logger;
    this.lastSweepAt = 0;
    this.totalSwept = {
      agentDirs: 0,
      thoughtsTruncated: 0,
      dreamsArchived: 0,
      discardedComposted: 0,
      cronArchivesRemoved: 0,
    };
  }

  /**
   * Check if a sweep is due and run if so.
   * Called from orchestrator cognitive cycle.
   */
  async tick(now = Date.now()) {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return null;

    this.lastSweepAt = now;
    const result = {
      sweptAt: new Date(now).toISOString(),
      agentDirsRemoved: 0,
      thoughtsTruncated: 0,
      dreamsArchived: 0,
      discardedTriggered: 0,
      cronArchivesRemoved: 0,
    };

    try { result.agentDirsRemoved = await this._sweepAgentDirs(now); } catch (e) { this._warn('agent dir sweep failed', e); }
    try { result.thoughtsTruncated = await this._sweepThoughts(); } catch (e) { this._warn('thoughts sweep failed', e); }
    try { result.dreamsArchived = await this._sweepDreams(); } catch (e) { this._warn('dreams sweep failed', e); }
    try { result.cronArchivesRemoved = await this._sweepCronArchives(now); } catch (e) { this._warn('cron archive sweep failed', e); }

    const totalActions = Object.values(result).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    if (totalActions > 0) {
      this.logger?.info?.('[sweeper] sweep complete', result);
    }

    return result;
  }

  /**
   * 1. Remove empty agent directories older than 6 hours.
   * Checks brain/agents/, brain/outputs/research/, brain/outputs/document-creation/
   */
  async _sweepAgentDirs(now) {
    if (!this.brainDir) return 0;
    const searchDirs = [
      path.join(this.brainDir, 'agents'),
      path.join(this.brainDir, 'outputs', 'research'),
      path.join(this.brainDir, 'outputs', 'document-creation'),
    ];

    let removed = 0;
    let scanned = 0;
    for (const agentsDir of searchDirs) {
      if (scanned >= AGENT_DIR_SCAN_LIMIT) break;
      let entries;
      try {
        entries = await fs.readdir(agentsDir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }

      for (const entry of entries) {
        if (scanned >= AGENT_DIR_SCAN_LIMIT) break;
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith('agent_')) continue;
        scanned++;

        const dirPath = path.join(agentsDir, entry.name);
        const stat = await fs.stat(dirPath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < AGENT_DIR_MIN_AGE_MS) continue;

        // Check if directory has real files
        const files = await fs.readdir(dirPath);
        const realFiles = files.filter(f => f !== '.DS_Store' && !f.startsWith('.'));
        if (realFiles.length > 0) continue; // Don't touch non-empty dirs

        // Safe to remove — empty and old
        await fs.rm(dirPath, { recursive: true });
        removed++;
      }
    }

    if (removed > 0) {
      this.totalSwept.agentDirs += removed;
    }

    return removed;
  }

  /**
   * 2. Truncate thoughts.jsonl if too large.
   */
  async _sweepThoughts() {
    if (!this.brainDir) return 0;
    const filePath = path.join(this.brainDir, 'thoughts.jsonl');
    return this._truncateJsonl(filePath, THOUGHTS_MAX_LINES, THOUGHTS_KEEP_LINES, 'thoughts');
  }

  /**
   * 3. Archive and truncate dreams.jsonl if too large.
   */
  async _sweepDreams() {
    if (!this.brainDir) return 0;
    const filePath = path.join(this.brainDir, 'dreams.jsonl');
    return this._archiveAndTruncateJsonl(filePath, DREAMS_MAX_LINES, DREAMS_KEEP_LINES, 'dreams');
  }

  /**
   * 4. Remove old cron-decision archives.
   */
  async _sweepCronArchives(now) {
    if (!this.logsDir) return 0;
    const cronDir = path.join(this.logsDir, 'cron-decisions');

    let entries;
    try {
      entries = await fs.readdir(cronDir);
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }

    const cutoff = now - (CRON_ARCHIVE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    let removed = 0;

    for (const file of entries) {
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
      const filePath = path.join(cronDir, file);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath);
        removed++;
      }
    }

    if (removed > 0) {
      this.totalSwept.cronArchivesRemoved += removed;
    }

    return removed;
  }

  /**
   * Helper: truncate a JSONL file to last N lines if it exceeds maxLines.
   */
  async _truncateJsonl(filePath, maxLines, keepLines, label) {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }

    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= maxLines) return 0;

    const kept = lines.slice(-keepLines);
    await fs.writeFile(filePath, kept.join('\n') + '\n');

    const truncated = lines.length - kept.length;
    this.totalSwept.thoughtsTruncated += truncated;
    this.logger?.info?.(`[sweeper] truncated ${label}`, {
      before: lines.length,
      after: kept.length,
      removed: truncated
    });

    return truncated;
  }

  /**
   * Helper: archive then truncate a JSONL file.
   */
  async _archiveAndTruncateJsonl(filePath, maxLines, keepLines, label) {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }

    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= maxLines) return 0;

    // Archive the full file
    const archivePath = filePath.replace('.jsonl', `-archive-${Date.now()}.jsonl`);
    await fs.writeFile(archivePath, content);

    // Keep only recent lines
    const kept = lines.slice(-keepLines);
    await fs.writeFile(filePath, kept.join('\n') + '\n');

    const archived = lines.length - kept.length;
    this.totalSwept.dreamsArchived += archived;
    this.logger?.info?.(`[sweeper] archived ${label}`, {
      archivePath,
      before: lines.length,
      after: kept.length,
      archived,
    });

    return archived;
  }

  _warn(msg, err) {
    this.logger?.warn?.(`[sweeper] ${msg}`, { error: err?.message || String(err) });
  }

  getStats() {
    return { ...this.totalSwept, lastSweepAt: this.lastSweepAt };
  }
}

module.exports = { Sweeper };
