/**
 * ClusterAwareMemory
 *
 * Wraps the NetworkMemory graph so COSMO can toggle between standalone
 * cognition and clustered operation without touching the orchestrator.
 * In solo mode the proxy simply delegates to the underlying memory while
 * instrumentation records mutations for future diff/merge flows.
 */

const crypto = require('crypto');
const { types: { isProxy } } = require('node:util');

function parseLegacyIdentitySegment(rawValue) {
  const value = String(rawValue);
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && String(numeric) === value) return numeric;
  }
  return value;
}

function cloneClusterSnapshotValue(value, seen = new Set(), arrayElement = false) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('cluster_snapshot_bigint_not_allowed');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return arrayElement ? null : undefined;
  }
  if (isProxy(value)) throw new TypeError('cluster_snapshot_proxy_not_allowed');
  if (value instanceof Date) {
    const timestamp = Date.prototype.getTime.call(value);
    if (!Number.isFinite(timestamp)) throw new TypeError('cluster_snapshot_plain_json_required');
    return new Date(timestamp).toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    if (!Number.isSafeInteger(value.length) || value.length < 0) {
      throw new TypeError('cluster_snapshot_plain_json_required');
    }
    const clone = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      clone[index] = cloneClusterSnapshotValue(value[index], seen, true);
    }
    return clone;
  }
  if (seen.has(value)) throw new TypeError('cluster_snapshot_cycle_not_allowed');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError('cluster_snapshot_plain_json_required');
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('cluster_snapshot_plain_json_required');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key === 'symbol') {
      if (descriptor.enumerable) throw new TypeError('cluster_snapshot_symbol_key_not_allowed');
      continue;
    }
    if (descriptor.enumerable && (descriptor.get || descriptor.set)) {
      throw new TypeError('cluster_snapshot_accessor_not_allowed');
    }
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) continue;
        clone[index] = cloneClusterSnapshotValue(descriptor.value, seen, true);
      }
      return clone;
    }

    const clone = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key === 'symbol') {
        continue;
      }
      if (!descriptor.enumerable) continue;
      const child = cloneClusterSnapshotValue(descriptor.value, seen, false);
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

function defineSnapshotField(record, key, value) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function snapshotDataProperty(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor ? descriptor.value : undefined;
}

class ClusterAwareMemory {
  constructor(localMemory, options = {}) {
    if (!localMemory) {
      throw new Error('ClusterAwareMemory requires a local memory instance');
    }

    this.localMemory = localMemory;
    this.logger = options.logger;
    this.config = options.config || {};
    this.instanceId = options.instanceId || 'cosmo-1';
    this.stateStore = options.stateStore || null;
    this.clusterEnabled = Boolean(options.clusterEnabled && this.stateStore);

    this.versionClock = 0;
    this.lastDiffTimestamp = 0;
    this.trackedNodes = new Set();
    this.deletedNodes = new Set();
    this.trackedEdges = new Set();
    this.deletedEdges = new Set();
    this.trackedClusters = new Set();
    this.deletedClusters = new Set();
    this.suppressTracking = false;

    // Instrumented object caches (weak to avoid leaks)
    this.nodeProxyToTarget = new WeakMap();
    this.nodeTargetToProxy = new WeakMap();
    this.edgeProxyToTarget = new WeakMap();
    this.edgeTargetToProxy = new WeakMap();

    this.instrumentStructures();

    this.proxy = new Proxy(this.localMemory, {
      get: (target, prop, receiver) => {
        if (prop === '__cluster') {
          return this;
        }
        if (typeof this[prop] === 'function') {
          return this[prop].bind(this);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  /**
   * Expose the instrumented memory surface to the orchestrator.
   */
  getInterface() {
    return this.proxy;
  }

  /**
   * Attach cluster backends once they are initialised.
   */
  attachStateStore(stateStore) {
    this.stateStore = stateStore || null;
    this.clusterEnabled = Boolean(this.config?.cluster?.enabled && this.stateStore);
    if (!this.clusterEnabled) {
      this.logger?.debug?.('[ClusterAwareMemory] State store connected but clustering remains disabled');
    } else {
      this.logger?.info?.('[ClusterAwareMemory] State store attached — cluster mode ready');
    }
  }

  setClusterEnabled(enabled) {
    const nextState = Boolean(enabled && this.stateStore);
    if (nextState && !this.stateStore) {
      this.logger?.warn?.('[ClusterAwareMemory] Cannot enable clustering without a state store');
      return;
    }
    this.clusterEnabled = nextState;
  }

  isClusterEnabled() {
    return this.clusterEnabled;
  }

  /**
   * Clear mutation tracking at the start of each cognitive cycle.
   */
  startCycleTracking() {
    this.trackedNodes.clear();
    this.deletedNodes.clear();
    this.trackedEdges.clear();
    this.deletedEdges.clear();
    this.trackedClusters.clear();
    this.deletedClusters.clear();
    this.lastDiffTimestamp = Date.now();
  }

  /**
   * Prevent instrumentation noise when we need to apply external state.
   */
  withSuppressedTracking(fn) {
    const previous = this.suppressTracking;
    this.suppressTracking = true;
    try {
      return fn();
    } finally {
      this.suppressTracking = previous;
    }
  }

  /**
   * Instrument the internal maps so we see every mutation.
   */
  instrumentStructures() {
    this.withSuppressedTracking(() => {
      this.instrumentNodesMap();
      this.instrumentEdgesMap();
      this.instrumentClustersMap();
    });
  }

  instrumentNodesMap() {
    const map = this.localMemory.nodes;
    if (!map || map.__clusterInstrumented) return;

    const originalSet = map.set.bind(map);
    const originalDelete = map.delete.bind(map);
    const originalClear = map.clear.bind(map);

    map.set = (key, value) => {
      const instrumented = this.instrumentNodeValue(key, value);
      const result = originalSet(key, instrumented);
      if (!this.suppressTracking) {
        this.recordNodeMutation(key);
      }
      return result;
    };

    map.delete = (key) => {
      const existed = map.has(key);
      const result = originalDelete(key);
      if (existed && !this.suppressTracking) {
        this.recordNodeDeletion(key);
      }
      return result;
    };

    map.clear = () => {
      const keys = Array.from(map.keys());
      const result = originalClear();
      if (!this.suppressTracking) {
        for (const key of keys) {
          this.recordNodeDeletion(key);
        }
      }
      return result;
    };

    map.__clusterInstrumented = true;

    for (const [key, value] of Array.from(map.entries())) {
      originalSet(key, this.instrumentNodeValue(key, value));
    }
  }

  instrumentEdgesMap() {
    const map = this.localMemory.edges;
    if (!map || map.__clusterInstrumented) return;

    const originalSet = map.set.bind(map);
    const originalDelete = map.delete.bind(map);
    const originalClear = map.clear.bind(map);

    map.set = (key, value) => {
      const instrumented = this.instrumentEdgeValue(key, value);
      const result = originalSet(key, instrumented);
      if (!this.suppressTracking) {
        this.recordEdgeMutation(key);
      }
      return result;
    };

    map.delete = (key) => {
      const existed = map.has(key);
      const result = originalDelete(key);
      if (existed && !this.suppressTracking) {
        this.recordEdgeDeletion(key);
      }
      return result;
    };

    map.clear = () => {
      const keys = Array.from(map.keys());
      const result = originalClear();
      if (!this.suppressTracking) {
        for (const key of keys) {
          this.recordEdgeDeletion(key);
        }
      }
      return result;
    };

    map.__clusterInstrumented = true;

    for (const [key, value] of Array.from(map.entries())) {
      originalSet(key, this.instrumentEdgeValue(key, value));
    }
  }

  instrumentClustersMap() {
    const map = this.localMemory.clusters;
    if (!map || map.__clusterInstrumented) return;

    const originalSet = map.set.bind(map);
    const originalDelete = map.delete.bind(map);
    const originalClear = map.clear.bind(map);

    map.set = (key, value) => {
      const instrumentedSet = this.instrumentClusterSet(key, value);
      const result = originalSet(key, instrumentedSet);
      if (!this.suppressTracking) {
        this.recordClusterMutation(key);
      }
      return result;
    };

    map.delete = (key) => {
      const existed = map.has(key);
      const result = originalDelete(key);
      if (existed && !this.suppressTracking) {
        this.recordClusterDeletion(key);
      }
      return result;
    };

    map.clear = () => {
      const ids = Array.from(map.keys());
      const result = originalClear();
      if (!this.suppressTracking) {
        for (const id of ids) {
          this.recordClusterDeletion(id);
        }
      }
      return result;
    };

    map.__clusterInstrumented = true;

    for (const [key, value] of Array.from(map.entries())) {
      originalSet(key, this.instrumentClusterSet(key, value));
    }
  }

  instrumentClusterSet(clusterId, clusterSet) {
    if (!(clusterSet instanceof Set)) {
      return clusterSet;
    }
    if (clusterSet.__clusterInstrumented) {
      return clusterSet;
    }

    const originalAdd = clusterSet.add.bind(clusterSet);
    const originalDelete = clusterSet.delete.bind(clusterSet);
    const originalClear = clusterSet.clear.bind(clusterSet);

    clusterSet.add = (value) => {
      const result = originalAdd(value);
      if (!this.suppressTracking) {
        this.recordClusterMutation(clusterId);
      }
      return result;
    };

    clusterSet.delete = (value) => {
      const existed = clusterSet.has(value);
      const result = originalDelete(value);
      if (existed && !this.suppressTracking) {
        this.recordClusterMutation(clusterId);
      }
      return result;
    };

    clusterSet.clear = () => {
      const result = originalClear();
      if (!this.suppressTracking) {
        this.recordClusterMutation(clusterId);
      }
      return result;
    };

    Object.defineProperty(clusterSet, '__clusterInstrumented', {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    });

    return clusterSet;
  }

  instrumentNodeValue(nodeId, value) {
    if (!value) return value;

    const target = this.nodeProxyToTarget.get(value) || value;
    if (this.nodeTargetToProxy.has(target)) {
      return this.nodeTargetToProxy.get(target);
    }

    const proxy = new Proxy(target, {
      set: (obj, prop, newValue) => {
        const result = Reflect.set(obj, prop, newValue);
        if (!this.suppressTracking) {
          this.recordNodeMutation(nodeId);
        }
        return result;
      },
      deleteProperty: (obj, prop) => {
        const result = Reflect.deleteProperty(obj, prop);
        if (!this.suppressTracking) {
          this.recordNodeMutation(nodeId);
        }
        return result;
      }
    });

    this.nodeProxyToTarget.set(proxy, target);
    this.nodeTargetToProxy.set(target, proxy);
    return proxy;
  }

  instrumentEdgeValue(edgeKey, value) {
    if (!value) return value;

    const target = this.edgeProxyToTarget.get(value) || value;
    if (this.edgeTargetToProxy.has(target)) {
      return this.edgeTargetToProxy.get(target);
    }

    const proxy = new Proxy(target, {
      set: (obj, prop, newValue) => {
        const result = Reflect.set(obj, prop, newValue);
        if (!this.suppressTracking) {
          this.recordEdgeMutation(edgeKey);
        }
        return result;
      },
      deleteProperty: (obj, prop) => {
        const result = Reflect.deleteProperty(obj, prop);
        if (!this.suppressTracking) {
          this.recordEdgeMutation(edgeKey);
        }
        return result;
      }
    });

    this.edgeProxyToTarget.set(proxy, target);
    this.edgeTargetToProxy.set(target, proxy);
    return proxy;
  }

  unwrapNode(value) {
    return this.nodeProxyToTarget.get(value) || value;
  }

  unwrapEdge(value) {
    return this.edgeProxyToTarget.get(value) || value;
  }

  normalizeTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return new Date(value).toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  recordNodeMutation(nodeId) {
    if (nodeId === undefined || nodeId === null || (typeof nodeId === 'number' && Number.isNaN(nodeId))) return;
    if (this.suppressTracking) return;
    this.trackedNodes.add(nodeId);
    this.deletedNodes.delete(nodeId);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  recordNodeDeletion(nodeId) {
    if (nodeId === undefined || nodeId === null || (typeof nodeId === 'number' && Number.isNaN(nodeId))) return;
    if (this.suppressTracking) return;
    this.trackedNodes.delete(nodeId);
    this.deletedNodes.add(nodeId);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  recordEdgeMutation(edgeKey) {
    if (this.suppressTracking) return;
    this.trackedEdges.add(edgeKey);
    this.deletedEdges.delete(edgeKey);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  recordEdgeDeletion(edgeKey) {
    if (this.suppressTracking) return;
    this.trackedEdges.delete(edgeKey);
    this.deletedEdges.add(edgeKey);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  recordClusterMutation(clusterId) {
    if (this.suppressTracking) return;
    if (!this.localMemory.clusters?.has(clusterId)) return;
    this.trackedClusters.add(clusterId);
    this.deletedClusters.delete(clusterId);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  recordClusterDeletion(clusterId) {
    if (this.suppressTracking) return;
    this.trackedClusters.delete(clusterId);
    this.deletedClusters.add(clusterId);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  getNodeSnapshot(nodeId) {
    const stored = this.localMemory.nodes?.get(nodeId);
    if (!stored) return null;
    const node = this.unwrapNode(stored);
    const snapshot = cloneClusterSnapshotValue(node);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('cluster_snapshot_node_record_required');
    }
    defineSnapshotField(snapshot, 'id', nodeId);
    return snapshot;
  }

  getEdgeSnapshot(edgeKey) {
    const stored = this.localMemory.edges?.get(edgeKey);
    if (!stored) return null;
    const edge = this.unwrapEdge(stored);
    const snapshot = cloneClusterSnapshotValue(edge);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('cluster_snapshot_edge_record_required');
    }
    let source = snapshotDataProperty(snapshot, 'source') ?? snapshotDataProperty(snapshot, 'from');
    let target = snapshotDataProperty(snapshot, 'target') ?? snapshotDataProperty(snapshot, 'to');
    if (source === undefined || target === undefined) {
      const parts = String(edgeKey).split('->');
      source = parseLegacyIdentitySegment(parts[0]);
      target = parseLegacyIdentitySegment(parts[1]);
    }
    defineSnapshotField(snapshot, 'id', edgeKey);
    defineSnapshotField(snapshot, 'source', source);
    defineSnapshotField(snapshot, 'target', target);
    return snapshot;
  }

  getClusterSnapshot(clusterId) {
    const clusterSet = this.localMemory.clusters?.get(clusterId);
    if (!clusterSet) return null;
    return {
      id: clusterId,
      nodes: Array.from(clusterSet)
    };
  }

  /**
   * Construct diff payload describing all tracked mutations.
   */
  async getCycleDiff(cycle) {
    if (!this.clusterEnabled || !this.stateStore) {
      return null;
    }

    const fields = {};
    const versionVector = { [this.instanceId]: this.versionClock };
    const timestamp = this.lastDiffTimestamp || Date.now();

    for (const nodeId of this.trackedNodes) {
      const snapshot = this.getNodeSnapshot(nodeId);
      if (snapshot) {
        fields[`memory.node.${nodeId}`] = {
          op: 'set',
          nodeId,
          value: snapshot,
          timestamp,
          versionVector
        };
      }
    }

    for (const nodeId of this.deletedNodes) {
      fields[`memory.node.${nodeId}`] = {
        op: 'delete',
        nodeId,
        timestamp,
        versionVector
      };
    }

    for (const edgeKey of this.trackedEdges) {
      if (this.deletedEdges.has(edgeKey)) continue;
      const snapshot = this.getEdgeSnapshot(edgeKey);
      if (snapshot) {
        fields[`memory.edge.${edgeKey}`] = {
          op: 'set',
          edgeKey,
          value: snapshot,
          timestamp,
          versionVector
        };
      }
    }

    for (const edgeKey of this.deletedEdges) {
      fields[`memory.edge.${edgeKey}`] = {
        op: 'delete',
        edgeKey,
        timestamp,
        versionVector
      };
    }

    for (const clusterId of this.trackedClusters) {
      const snapshot = this.getClusterSnapshot(clusterId);
      if (snapshot) {
        fields[`memory.cluster.${clusterId}`] = {
          op: 'set',
          clusterId,
          value: snapshot,
          timestamp,
          versionVector
        };
      }
    }

    for (const clusterId of this.deletedClusters) {
      fields[`memory.cluster.${clusterId}`] = {
        op: 'delete',
        clusterId,
        timestamp,
        versionVector
      };
    }

    if (Object.keys(fields).length === 0) {
      return null;
    }

    return {
      diff_id: `${Date.now()}_${cycle}_${this.instanceId}_${crypto.randomBytes(4).toString('hex')}`,
      versionVector,
      fields,
      cycle,
      instanceId: this.instanceId,
      timestamp
    };
  }

  async submitCycleDiff(cycle, diff) {
    if (!this.clusterEnabled || !this.stateStore || !diff) {
      return;
    }
    await this.stateStore.submitDiff(cycle, this.instanceId, diff);
  }

  async fetchMergedState(cycle) {
    if (!this.clusterEnabled || !this.stateStore) {
      return;
    }

    const mergedState = await this.stateStore.getMergedState(cycle);
    if (!mergedState?.memory) {
      return;
    }

    const sets = mergedState.memory.sets || mergedState.memory;
    const deletes = mergedState.memory.deletes || {};

    const nodeSets = Array.isArray(sets?.nodes) ? sets.nodes : [];
    const edgeSets = Array.isArray(sets?.edges) ? sets.edges : [];
    const clusterSets = Array.isArray(sets?.clusters) ? sets.clusters : [];

    const nodeDeletes = Array.isArray(deletes?.nodeIds) ? deletes.nodeIds : [];
    const edgeDeletes = Array.isArray(deletes?.edgeKeys) ? deletes.edgeKeys : [];
    const clusterDeletes = Array.isArray(deletes?.clusterIds) ? deletes.clusterIds : [];

    if (typeof this.localMemory.importGraphChanges !== 'function') {
      throw new Error('memory_graph_import_api_required');
    }
    return this.withSuppressedTracking(() => this.localMemory.importGraphChanges({
      nodes: nodeSets,
      edges: edgeSets,
      clusters: clusterSets,
      nodeDeletes,
      edgeDeletes,
      clusterDeletes,
    }));
  }

  applyNodeSnapshot(data) {
    if (!data || data.id === undefined || data.id === null) return;
    if (typeof this.localMemory.importGraphChanges !== 'function') {
      throw new Error('memory_graph_import_api_required');
    }
    return this.withSuppressedTracking(() => this.localMemory.importGraphChanges({ nodes: [data] }));
  }

  applyEdgeSnapshot(edgeKey, data) {
    if (!edgeKey) return;
    if (typeof this.localMemory.importGraphChanges !== 'function') {
      throw new Error('memory_graph_import_api_required');
    }
    return this.withSuppressedTracking(() => this.localMemory.importGraphChanges({
      edges: [[edgeKey, data]],
    }));
  }

  applyClusterSnapshot(data) {
    if (!data || data.id === undefined || data.id === null) return;
    if (typeof this.localMemory.importGraphChanges !== 'function') {
      throw new Error('memory_graph_import_api_required');
    }
    return this.withSuppressedTracking(() => this.localMemory.importGraphChanges({ clusters: [data] }));
  }

  async waitSyncGate() {
    if (!this.clusterEnabled || !this.stateStore) {
      return true;
    }
    return true;
  }

  getTraceContext() {
    return {
      instance: this.instanceId,
      versionClock: this.versionClock,
      clustered: this.clusterEnabled,
      pendingMutations: {
        nodes: this.trackedNodes.size + this.deletedNodes.size,
        edges: this.trackedEdges.size + this.deletedEdges.size,
        clusters: this.trackedClusters.size + this.deletedClusters.size
      }
    };
  }
}

module.exports = { ClusterAwareMemory };
