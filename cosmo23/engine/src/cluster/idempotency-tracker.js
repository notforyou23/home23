/**
 * IdempotencyTracker
 *
 * Track applied diffs to prevent duplicate application.
 * Uses ULID for globally unique, time-sortable diff IDs.
 *
 * Phase B-R: Redis State Store + CRDT Merge
 */

const crypto = require('crypto');

class IdempotencyTracker {
  constructor(logger) {
    this.logger = logger;
    this.appliedDiffs = new Set(); // In-memory tracking
    this.diffMetadata = new Map(); // diff_id -> { timestamp, instanceId, cycle }
    this.maxTrackedDiffs = 10000; // Keep last 10k
  }

  /**
   * Generate ULID-like diff_id
   * Format: timestamp (ms) + random + instanceId
   *
   * @param {string} instanceId - instance identifier
   * @param {number} cycle - cycle number
   * @returns {string} - unique diff ID
   */
  generateDiffId(instanceId, cycle) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const diffId = `${timestamp}_${cycle}_${instanceId}_${random}`;
    
    return diffId;
  }

  /**
   * Check if diff has already been applied
   *
   * @param {string} diffId - diff identifier
   * @returns {boolean} - true if already applied
   */
  isApplied(diffId) {
    return this.appliedDiffs.has(diffId);
  }

  /**
   * Mark diff as applied
   *
   * @param {string} diffId - diff identifier
   * @param {object} metadata - { timestamp, instanceId, cycle }
   */
  markApplied(diffId, metadata = {}) {
    this.appliedDiffs.add(diffId);
    this.diffMetadata.set(diffId, {
      appliedAt: Date.now(),
      ...metadata
    });

    // Cleanup old diffs (keep only last N)
    if (this.appliedDiffs.size > this.maxTrackedDiffs) {
      this.cleanup();
    }
  }

  /**
   * Cleanup old diffs (keep only recent)
   * Removes oldest 10% when limit exceeded
   */
  cleanup() {
    if (this.appliedDiffs.size <= this.maxTrackedDiffs) {
      return;
    }

    // Sort by application time
    const sortedDiffs = Array.from(this.diffMetadata.entries())
      .sort((a, b) => a[1].appliedAt - b[1].appliedAt);

    // Remove oldest 10%
    const toRemove = Math.floor(this.maxTrackedDiffs * 0.1);
    for (let i = 0; i < toRemove; i++) {
      const [diffId] = sortedDiffs[i];
      this.appliedDiffs.delete(diffId);
      this.diffMetadata.delete(diffId);
    }

    this.logger?.info('[IdempotencyTracker] Cleanup completed', {
      removed: toRemove,
      remaining: this.appliedDiffs.size
    });
  }

  /**
   * Get diff metadata
   *
   * @param {string} diffId - diff identifier
   * @returns {object|null} - metadata or null if not found
   */
  getMetadata(diffId) {
    return this.diffMetadata.get(diffId) || null;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      totalApplied: this.appliedDiffs.size,
      maxTracked: this.maxTrackedDiffs,
      utilizationPercent: (this.appliedDiffs.size / this.maxTrackedDiffs * 100).toFixed(1)
    };
  }

  /**
   * Export applied diff set (for persistence)
   */
  export() {
    return {
      appliedDiffs: Array.from(this.appliedDiffs),
      diffMetadata: Object.fromEntries(this.diffMetadata)
    };
  }

  /**
   * Import applied diff set (from persistence)
   *
   * @param {object} data - exported data
   */
  import(data) {
    if (data.appliedDiffs) {
      this.appliedDiffs = new Set(data.appliedDiffs);
    }
    if (data.diffMetadata) {
      this.diffMetadata = new Map(Object.entries(data.diffMetadata));
    }

    this.logger?.info('[IdempotencyTracker] Imported state', {
      diffsLoaded: this.appliedDiffs.size
    });
  }

  /**
   * Clear all tracked diffs (for testing)
   */
  clear() {
    this.appliedDiffs.clear();
    this.diffMetadata.clear();
  }
}

module.exports = { IdempotencyTracker };

