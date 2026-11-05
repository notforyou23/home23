/**
 * CRDTMerger
 *
 * Conflict-Free Replicated Data Types merger for COSMO clustering.
 * Implements three CRDT types with mathematically proven convergence:
 * - LWW (Last-Writer-Wins) Registers: timestamp-based with instanceId tiebreaker
 * - OR-Sets (Add-Wins Sets): union of all adds, no deletion
 * - PN-Counters (Increment/Decrement Counters): separate increments and decrements
 *
 * Phase B-R: Redis State Store + CRDT Merge
 */

class CRDTMerger {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Merge LWW (Last-Writer-Wins) Register
   * Winner: highest timestamp; tiebreaker: lexicographically higher instanceId
   *
   * @param {object} local - { value, timestamp, instanceId, tombstone }
   * @param {object} remote - { value, timestamp, instanceId, tombstone }
   * @returns {object} - winning value
   */
  mergeLWW(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    // Check for tombstones (deletes)
    if (remote.tombstone && !local.tombstone) {
      // Remote is deleted; keep if newer
      if (remote.timestamp > local.timestamp) {
        return remote;
      }
      if (remote.timestamp === local.timestamp && remote.instanceId > local.instanceId) {
        return remote;
      }
      return local;
    }

    if (local.tombstone && !remote.tombstone) {
      // Local is deleted; keep if newer
      if (local.timestamp > remote.timestamp) {
        return local;
      }
      if (local.timestamp === remote.timestamp && local.instanceId > remote.instanceId) {
        return local;
      }
      return remote;
    }

    // Both tombstones or both values
    if (remote.timestamp > local.timestamp) {
      return remote;
    }
    if (remote.timestamp < local.timestamp) {
      return local;
    }

    // Timestamps equal: tiebreaker by instanceId (lexicographic)
    if (remote.instanceId > local.instanceId) {
      return remote;
    }
    return local;
  }

  /**
   * Merge OR-Set (Add-Wins Set)
   * Result: union of all adds
   * Note: No deletion in OR-Set (add-wins semantics)
   *
   * @param {Set|Array} localSet - local set
   * @param {Set|Array} remoteSet - remote set
   * @returns {Set} - merged set (union)
   */
  mergeORSet(localSet, remoteSet) {
    // Convert to Sets if arrays
    const local = localSet instanceof Set ? localSet : new Set(localSet || []);
    const remote = remoteSet instanceof Set ? remoteSet : new Set(remoteSet || []);

    // Union: add-wins
    const merged = new Set([...local, ...remote]);

    return merged;
  }

  /**
   * Merge PN-Counter (Positive-Negative Counter)
   * Separate increments and decrements; merge independently
   *
   * @param {object} local - { increments: Map, decrements: Map }
   * @param {object} remote - { increments: Map, decrements: Map }
   * @returns {object} - merged counter
   */
  mergeCounter(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    // Convert to Maps if plain objects
    const localInc = local.increments instanceof Map ? local.increments : new Map(Object.entries(local.increments || {}));
    const localDec = local.decrements instanceof Map ? local.decrements : new Map(Object.entries(local.decrements || {}));
    const remoteInc = remote.increments instanceof Map ? remote.increments : new Map(Object.entries(remote.increments || {}));
    const remoteDec = remote.decrements instanceof Map ? remote.decrements : new Map(Object.entries(remote.decrements || {}));

    // Merge increments: take max per instance
    const mergedIncrements = new Map(localInc);
    for (const [instanceId, count] of remoteInc) {
      const localCount = mergedIncrements.get(instanceId) || 0;
      mergedIncrements.set(instanceId, Math.max(localCount, count));
    }

    // Merge decrements: take max per instance
    const mergedDecrements = new Map(localDec);
    for (const [instanceId, count] of remoteDec) {
      const localCount = mergedDecrements.get(instanceId) || 0;
      mergedDecrements.set(instanceId, Math.max(localCount, count));
    }

    return {
      increments: mergedIncrements,
      decrements: mergedDecrements
    };
  }

  /**
   * Get counter value (sum of increments - sum of decrements)
   *
   * @param {object} counter - { increments: Map, decrements: Map }
   * @returns {number} - counter value
   */
  getCounterValue(counter) {
    if (!counter) return 0;

    const increments = counter.increments instanceof Map ? counter.increments : new Map(Object.entries(counter.increments || {}));
    const decrements = counter.decrements instanceof Map ? counter.decrements : new Map(Object.entries(counter.decrements || {}));

    let sum = 0;
    for (const count of increments.values()) {
      sum += count;
    }
    for (const count of decrements.values()) {
      sum -= count;
    }

    return sum;
  }

  /**
   * Merge version vectors (for CRDT metadata)
   * Result: component-wise max
   *
   * @param {object} local - { instanceId: clock }
   * @param {object} remote - { instanceId: clock }
   * @returns {object} - merged version vector
   */
  mergeVersionVector(local, remote) {
    const merged = { ...local };

    for (const [instanceId, clock] of Object.entries(remote || {})) {
      const localClock = merged[instanceId] || 0;
      merged[instanceId] = Math.max(localClock, clock);
    }

    return merged;
  }

  /**
   * Compare version vectors (for causality detection)
   * 
   * @param {object} v1 - version vector
   * @param {object} v2 - version vector
   * @returns {string} - 'equal', 'v1_newer', 'v2_newer', 'concurrent'
   */
  compareVersionVectors(v1, v2) {
    if (!v1 && !v2) return 'equal';
    if (!v1) return 'v2_newer';
    if (!v2) return 'v1_newer';

    let v1Newer = false;
    let v2Newer = false;

    // Get all instance IDs from both vectors
    const allInstances = new Set([...Object.keys(v1), ...Object.keys(v2)]);

    for (const instanceId of allInstances) {
      const clock1 = v1[instanceId] || 0;
      const clock2 = v2[instanceId] || 0;

      if (clock1 > clock2) v1Newer = true;
      if (clock2 > clock1) v2Newer = true;
    }

    if (v1Newer && v2Newer) return 'concurrent';
    if (v1Newer) return 'v1_newer';
    if (v2Newer) return 'v2_newer';
    return 'equal';
  }

  /**
   * Create tombstone for deletion
   *
   * @param {string} instanceId - instance that performed delete
   * @param {number} timestamp - deletion timestamp
   * @returns {object} - tombstone marker
   */
  createTombstone(instanceId, timestamp = Date.now()) {
    return {
      tombstone: true,
      deleted: true,
      deletedBy: instanceId,
      timestamp,
      value: null
    };
  }

  /**
   * Check if value is a tombstone
   *
   * @param {object} value - value to check
   * @returns {boolean} - true if tombstone
   */
  isTombstone(value) {
    return value && (value.tombstone === true || value.deleted === true);
  }

  /**
   * Merge two field values based on CRDT type
   *
   * @param {string} fieldType - 'register', 'set', or 'counter'
   * @param {*} localValue - local value
   * @param {*} remoteValue - remote value
   * @returns {*} - merged value
   */
  mergeField(fieldType, localValue, remoteValue) {
    switch (fieldType) {
      case 'register':
      case 'lww':
        return this.mergeLWW(localValue, remoteValue);
      
      case 'set':
      case 'orset':
        return this.mergeORSet(localValue, remoteValue);
      
      case 'counter':
      case 'pncounter':
        return this.mergeCounter(localValue, remoteValue);
      
      default:
        this.logger?.warn('[CRDTMerger] Unknown field type, using LWW', { fieldType });
        return this.mergeLWW(localValue, remoteValue);
    }
  }
}

module.exports = { CRDTMerger };

