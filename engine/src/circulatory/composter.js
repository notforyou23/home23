'use strict';

/**
 * Composter — extract patterns from discarded thoughts before clearing.
 *
 * Residence-Time Admission (From The Inside — Unit 4): a composting pass is
 * admitted when EITHER a valid-entry count threshold is met OR the oldest
 * valid (timestamped) entry has resided longer than an age threshold. The
 * age arm keeps small-but-stale piles from lingering indefinitely between the
 * rare occasions the count arm fires.
 *
 * Reads the file, computes operational evidence (valid count, oldest residence
 * age, observed arrival rate), extracts patterns, logs a summary, then
 * truncates the file. This is LOG-ONLY: it does NOT write anything into the
 * brain -- the composter is a janitor for discarded thoughts, not a source of
 * new brain nodes, and it must never file a receipt into the thing it cleans.
 *
 * Malformed input is handled explicitly: lines that fail JSON parsing are
 * skipped; entries whose timestamp is missing or malformed still count toward
 * the count arm but are excluded from age/rate math. Missing, empty, or
 * entirely malformed input is a safe no-op that never truncates.
 *
 * No LLM calls. Pure local pattern extraction.
 */

const fs = require('fs').promises;
const path = require('path');

// Count arm: admit once this many VALID (JSON-parseable) entries accumulate.
const DEFAULT_COUNT_THRESHOLD = 500;
// Age arm: admit once the oldest valid timestamped entry has resided this long.
// Bounded at 7 days -- long enough that a healthy count-triggered cadence
// normally wins first, short enough that a stalled small pile can never reside
// indefinitely. Overridable via config for deterministic tests.
const DEFAULT_OLDEST_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MS_PER_HOUR = 60 * 60 * 1000;

class Composter {
  constructor(config = {}) {
    this.brainDir = config.brainDir;
    // Compatibility-only: retained so existing wiring that passes a memory
    // graph keeps working. The composter is log-only and never calls into it.
    this.memory = config.memory;
    this.logger = config.logger;
    this.countThreshold = Number.isFinite(config.countThreshold)
      ? config.countThreshold
      : DEFAULT_COUNT_THRESHOLD;
    this.oldestAgeThresholdMs = Number.isFinite(config.oldestAgeThresholdMs)
      ? config.oldestAgeThresholdMs
      : DEFAULT_OLDEST_AGE_MS;
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

    // Parse. Malformed JSON lines are skipped explicitly; only successfully
    // parsed entries are "valid" and eligible to trigger or be truncated.
    const entries = [];
    let malformedLines = 0;
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { malformedLines += 1; }
    }

    // Missing / empty / entirely malformed input is a safe no-op. Never
    // truncate here -- there is nothing valid to compost and truncating would
    // destroy lines we could not read.
    if (entries.length === 0) return null;

    // Collect valid timestamps for the age arm and arrival-rate estimate.
    const timestamps = [];
    for (const entry of entries) {
      const ts = this._entryTimestamp(entry);
      if (ts !== null) timestamps.push(ts);
    }

    const validEntryCount = entries.length;
    const oldestTs = timestamps.length ? Math.min(...timestamps) : null;
    // Residence age of the oldest valid timestamped entry. Null when no entry
    // carries a usable timestamp; clamped at 0 so future-dated ts never yields
    // a negative "age".
    const oldestValidEntryAgeMs = oldestTs === null ? null : Math.max(0, now - oldestTs);

    const evidence = {
      validEntryCount,
      malformedLines,
      timestampedCount: timestamps.length,
      oldestValidEntryAgeMs,
      arrivalRatePerHour: this._arrivalRatePerHour(timestamps),
      trigger: null,
    };

    const countTriggered = validEntryCount >= this.countThreshold;
    const ageTriggered = oldestValidEntryAgeMs !== null
      && oldestValidEntryAgeMs >= this.oldestAgeThresholdMs;

    if (!countTriggered && !ageTriggered) return null;

    evidence.trigger = countTriggered && ageTriggered
      ? 'count+age'
      : (countTriggered ? 'count' : 'age');

    const patterns = this._extractPatterns(entries);
    const summary = this._buildSummary(patterns, validEntryCount);

    // NOTE (jtr, 2026-07-15): the composter used to write `summary` into the
    // brain as a 'compost_receipt' node. Removed deliberately -- the
    // composter is the janitor for discarded-thoughts.jsonl; it must not
    // file a receipt into the thing it cleans. Composting itself (pattern
    // extraction + truncation) is unaffected. Operational logging below is
    // kept so composting activity is still visible in logs.

    // Truncate the file (post-compost).
    await fs.writeFile(filePath, '');
    this.totalComposted += validEntryCount;

    this.logger?.info?.('[composter] composting complete', {
      entriesProcessed: validEntryCount,
      evidence,
      summary,
    });

    return { entriesProcessed: validEntryCount, evidence, summary };
  }

  /**
   * Resolve an entry's timestamp to epoch-ms, or null when missing/malformed.
   * Accepts a numeric epoch or a Date-parseable string.
   */
  _entryTimestamp(entry) {
    const raw = entry?.ts ?? entry?.temporalContext?.now;
    if (raw === null || raw === undefined) return null;
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }

  /**
   * Observed arrival rate in entries/hour, estimated from valid timestamps.
   * Returns null (rather than a fabricated number) when there is too little
   * data to be meaningful: fewer than two timestamps, or a zero-length span.
   * This avoids both divide-by-zero and false precision.
   */
  _arrivalRatePerHour(timestamps) {
    if (timestamps.length < 2) return null;
    const spanMs = Math.max(...timestamps) - Math.min(...timestamps);
    if (spanMs <= 0) return null;
    const perHour = (timestamps.length - 1) / (spanMs / MS_PER_HOUR);
    return Math.round(perHour * 100) / 100;
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
