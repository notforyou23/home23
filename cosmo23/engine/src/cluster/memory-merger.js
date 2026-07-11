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
const { types: { isProxy } } = require('node:util');

function cloneMemoryDiffValue(value, seen = new Set(), arrayElement = false) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('memory_diff_bigint_not_allowed');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return arrayElement ? null : undefined;
  }
  if (isProxy(value)) throw new TypeError('memory_diff_proxy_not_allowed');
  if (value instanceof Date) {
    const timestamp = Date.prototype.getTime.call(value);
    if (!Number.isFinite(timestamp)) throw new TypeError('memory_diff_plain_json_required');
    return new Date(timestamp).toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    if (!Number.isSafeInteger(value.length) || value.length < 0) {
      throw new TypeError('memory_diff_plain_json_required');
    }
    return Array.from(value, (entry) => cloneMemoryDiffValue(entry, seen, true));
  }
  if (seen.has(value)) throw new TypeError('memory_diff_cycle_not_allowed');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError('memory_diff_plain_json_required');
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('memory_diff_plain_json_required');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key === 'symbol') {
      if (descriptor.enumerable) throw new TypeError('memory_diff_symbol_key_not_allowed');
      continue;
    }
    if (descriptor.get || descriptor.set) {
      throw new TypeError('memory_diff_accessor_not_allowed');
    }
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) continue;
        clone[index] = cloneMemoryDiffValue(descriptor.value, seen, true);
      }
      return clone;
    }
    const clone = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key === 'symbol' || !descriptor.enumerable) continue;
      const child = cloneMemoryDiffValue(descriptor.value, seen, false);
      if (child !== undefined) {
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: child,
        });
      }
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

function parseLegacyGraphIdentity(rawValue) {
  const value = String(rawValue);
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && String(numeric) === value) return numeric;
  }
  return value;
}

function readOwnIdentity(record, key) {
  if (!record || typeof record !== 'object') return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, value: undefined };
  if (descriptor.get || descriptor.set) throw new TypeError('memory_diff_identity_invalid');
  return { present: true, value: descriptor.value };
}

function validateIdentity(value, kind) {
  if (typeof value === 'number') {
    if (kind === 'edge' || !Number.isSafeInteger(value)) {
      throw new TypeError('memory_diff_identity_invalid');
    }
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('memory_diff_identity_invalid');
  }
  return value;
}

function resolveOperationIdentity(operation, kind, explicitKey, rawSuffix) {
  const explicit = readOwnIdentity(operation, explicitKey);
  const operationValue = readOwnIdentity(operation, 'value');
  const valueIdentity = readOwnIdentity(operationValue.value, 'id');
  if (explicit.present) validateIdentity(explicit.value, kind);
  if (valueIdentity.present) validateIdentity(valueIdentity.value, kind);
  if (explicit.present && valueIdentity.present && !Object.is(explicit.value, valueIdentity.value)) {
    throw new Error('memory_diff_identity_mismatch');
  }
  const fallback = kind === 'edge' ? rawSuffix : parseLegacyGraphIdentity(rawSuffix);
  const identity = explicit.present
    ? explicit.value
    : (valueIdentity.present ? valueIdentity.value : fallback);
  validateIdentity(identity, kind);
  if ((explicit.present || valueIdentity.present) && String(identity) !== rawSuffix) {
    throw new Error('memory_diff_identity_mismatch');
  }
  return identity;
}

function validateEdgeRecordIdentity(value, edgeKey) {
  const source = readOwnIdentity(value, 'source');
  const target = readOwnIdentity(value, 'target');
  if (!source.present && !target.present) return;
  if (!source.present || !target.present) throw new TypeError('memory_diff_identity_invalid');
  validateIdentity(source.value, 'node');
  validateIdentity(target.value, 'node');
  if (`${String(source.value)}->${String(target.value)}` !== edgeKey) {
    throw new Error('memory_diff_identity_mismatch');
  }
}

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
    if (!diff) {
      return;
    }

    const safeDiff = cloneMemoryDiffValue(diff);
    const fieldsProperty = readOwnIdentity(safeDiff, 'fields');
    if (!fieldsProperty.present || !fieldsProperty.value || typeof fieldsProperty.value !== 'object') return;
    const fields = fieldsProperty.value;

    const diffTimestamp = readOwnIdentity(safeDiff, 'timestamp');
    const timestamp = diffTimestamp.value || Date.now();
    const diffIdProperty = readOwnIdentity(safeDiff, 'diff_id');
    const diffId = diffIdProperty.value || `${timestamp}_${instanceId}`;
    const diffVersionVector = readOwnIdentity(safeDiff, 'versionVector');

    for (const [field, operation] of Object.entries(fields)) {
      const operationType = readOwnIdentity(operation, 'op');
      if (!operation || !operationType.present || !operationType.value) {
        continue;
      }

      const operationValue = readOwnIdentity(operation, 'value');
      const operationVersionVector = readOwnIdentity(operation, 'versionVector');
      const operationTimestamp = readOwnIdentity(operation, 'timestamp');

      const entry = {
        op: operationType.value,
        value: operationValue.value || null,
        versionVector: operationVersionVector.value || diffVersionVector.value || {},
        timestamp: operationTimestamp.value || timestamp,
        instanceId,
        diffId
      };

      if (field.startsWith('memory.node.')) {
        const rawNodeId = field.slice('memory.node.'.length);
        if (!rawNodeId) continue;
        const nodeId = resolveOperationIdentity(
          operation,
          'node',
          'nodeId',
          rawNodeId,
        );
        this.applyEntry(this.nodeEntries, nodeId, entry);
      } else if (field.startsWith('memory.edge.')) {
        const rawEdgeKey = field.slice('memory.edge.'.length);
        if (!rawEdgeKey) continue;
        const edgeKey = resolveOperationIdentity(
          operation,
          'edge',
          'edgeKey',
          rawEdgeKey,
        );
        validateEdgeRecordIdentity(entry.value, edgeKey);
        this.applyEntry(this.edgeEntries, edgeKey, entry);
      } else if (field.startsWith('memory.cluster.')) {
        const rawClusterId = field.slice('memory.cluster.'.length);
        if (!rawClusterId) continue;
        const clusterId = resolveOperationIdentity(
          operation,
          'cluster',
          'clusterId',
          rawClusterId,
        );
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
        nodesToSet.push({
          ...entry.value,
          id: nodeId,
        });
      }
    }

    const edgesToSet = [];
    const edgesToDelete = [];
    for (const [edgeKey, entry] of this.edgeEntries.entries()) {
      if (entry.op === 'delete') {
        edgesToDelete.push(edgeKey);
      } else if (entry.op === 'set' && entry.value) {
        edgesToSet.push({
          ...entry.value,
          id: edgeKey,
        });
      }
    }

    const clustersToSet = [];
    const clustersToDelete = [];
    for (const [clusterId, entry] of this.clusterEntries.entries()) {
      if (entry.op === 'delete') {
        clustersToDelete.push(clusterId);
      } else if (entry.op === 'set' && entry.value) {
        clustersToSet.push({
          ...entry.value,
          id: clusterId,
        });
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
