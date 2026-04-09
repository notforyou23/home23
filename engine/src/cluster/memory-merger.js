/**
 * MemoryDiffMerger
 *
 * Aggregates per-instance memory diffs into a consolidated state update
 * that can be safely applied to every COSMO instance.
 *
 * - Handles set/delete conflicts with vector clocks + timestamp + instanceId tiebreakers
 * - Produces deterministic merged output for nodes, edges, and clusters
 * - Tracks counts for observability (diffCount, setCount, deleteCount)
 *
 * Stage 2: Shared Memory Broadcast
 */

const { CRDTMerger } = require('./backends/crdt-merger');

class MemoryDiffMerger {
  constructor(logger) {
    this.logger = logger;
    this.crdt = new CRDTMerger(logger);

    this.nodeEntries = new Map(); // nodeId -> entry
    this.edgeEntries = new Map(); // edgeKey -> entry
    this.clusterEntries = new Map(); // clusterId -> entry

    this.diffCount = 0;
  }

  /**
   * Apply diff (single instance submission)
   *
   * @param {object} diff - diff payload from ClusterAwareMemory
   * @param {string} instanceId - originating instance
   */
  applyDiff(diff, instanceId) {
    if (!diff || !diff.fields) {
      return;
    }

    const timestamp = diff.timestamp || Date.now();
    const diffId = diff.diff_id || `${timestamp}_${instanceId}`;

    for (const [field, operation] of Object.entries(diff.fields)) {
      if (!operation || !operation.op) {
        continue;
      }

      const entry = {
        op: operation.op,
        value: operation.value || null,
        versionVector: operation.versionVector || diff.versionVector || {},
        timestamp: operation.timestamp || timestamp,
        instanceId,
        diffId
      };

      if (field.startsWith('memory.node.')) {
        const nodeId = Number(field.replace('memory.node.', ''));
        if (Number.isNaN(nodeId)) continue;
        this.applyEntry(this.nodeEntries, nodeId, entry);
      } else if (field.startsWith('memory.edge.')) {
        const edgeKey = field.replace('memory.edge.', '');
        this.applyEntry(this.edgeEntries, edgeKey, entry);
      } else if (field.startsWith('memory.cluster.')) {
        const clusterId = Number(field.replace('memory.cluster.', ''));
        if (Number.isNaN(clusterId)) continue;
        this.applyEntry(this.clusterEntries, clusterId, entry);
      }
    }

    this.diffCount++;
  }

  /**
   * Merge entries with conflict resolution
   *
   * @param {Map} map - target map
   * @param {string|number} key - entry key
   * @param {object} incoming - new entry
   */
  applyEntry(map, key, incoming) {
    const existing = map.get(key);
    if (!existing) {
      map.set(key, incoming);
      return;
    }

    if (this.shouldReplace(existing, incoming)) {
      map.set(key, incoming);
    }
  }

  /**
   * Determine whether incoming entry should replace existing.
   * Uses CRDT version vector comparison, timestamp, and instanceId tie-breakers.
   */
  shouldReplace(existing, incoming) {
    const relation = this.crdt.compareVersionVectors(
      existing.versionVector || {},
      incoming.versionVector || {}
    );

    if (relation === 'v2_newer') {
      return true;
    }
    if (relation === 'v1_newer') {
      return false;
    }

    const existingTs = existing.timestamp || 0;
    const incomingTs = incoming.timestamp || 0;

    if (incomingTs > existingTs) {
      return true;
    }
    if (incomingTs < existingTs) {
      return false;
    }

    const existingInstance = existing.instanceId || '';
    const incomingInstance = incoming.instanceId || '';
    if (incomingInstance > existingInstance) {
      return true;
    }
    if (incomingInstance < existingInstance) {
      return false;
    }

    const existingDiff = existing.diffId || '';
    const incomingDiff = incoming.diffId || '';
    return incomingDiff > existingDiff;
  }

  /**
   * Build merged state payload for distribution.
   *
   * @param {number} cycle - cycle number
   * @returns {object} merged state payload
   */
  build(cycle) {
    const nodesToSet = [];
    const nodesToDelete = [];

    for (const [nodeId, entry] of this.nodeEntries.entries()) {
      if (entry.op === 'delete') {
        nodesToDelete.push(nodeId);
      } else if (entry.op === 'set' && entry.value) {
        nodesToSet.push(entry.value);
      }
    }

    const edgesToSet = [];
    const edgesToDelete = [];
    for (const [edgeKey, entry] of this.edgeEntries.entries()) {
      if (entry.op === 'delete') {
        edgesToDelete.push(edgeKey);
      } else if (entry.op === 'set' && entry.value) {
        edgesToSet.push({
          id: edgeKey,
          ...entry.value
        });
      }
    }

    const clustersToSet = [];
    const clustersToDelete = [];
    for (const [clusterId, entry] of this.clusterEntries.entries()) {
      if (entry.op === 'delete') {
        clustersToDelete.push(clusterId);
      } else if (entry.op === 'set' && entry.value) {
        clustersToSet.push(entry.value);
      }
    }

    return {
      cycle,
      generatedAt: Date.now(),
      diffCount: this.diffCount,
      memory: {
        sets: {
          nodes: nodesToSet,
          edges: edgesToSet,
          clusters: clustersToSet
        },
        deletes: {
          nodeIds: nodesToDelete,
          edgeKeys: edgesToDelete,
          clusterIds: clustersToDelete
        }
      },
      metadata: {
        nodesSet: nodesToSet.length,
        nodesDeleted: nodesToDelete.length,
        edgesSet: edgesToSet.length,
        edgesDeleted: edgesToDelete.length,
        clustersSet: clustersToSet.length,
        clustersDeleted: clustersToDelete.length
      }
    };
  }
}

module.exports = { MemoryDiffMerger };
