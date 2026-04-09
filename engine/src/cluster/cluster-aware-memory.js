/**
 * ClusterAwareMemory
 *
 * Wraps the NetworkMemory graph so COSMO can toggle between standalone
 * cognition and clustered operation without touching the orchestrator.
 * In solo mode the proxy simply delegates to the underlying memory while
 * instrumentation records mutations for future diff/merge flows.
 */

const crypto = require('crypto');

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
      const numericKey = Number(key);
      const instrumented = this.instrumentNodeValue(numericKey, value);
      const result = originalSet(key, instrumented);
      if (!this.suppressTracking) {
        this.recordNodeMutation(numericKey);
      }
      return result;
    };

    map.delete = (key) => {
      const numericKey = Number(key);
      const existed = map.has(key);
      const result = originalDelete(key);
      if (existed && !this.suppressTracking) {
        this.recordNodeDeletion(numericKey);
      }
      return result;
    };

    map.clear = () => {
      const keys = Array.from(map.keys()).map(Number);
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
      originalSet(key, this.instrumentNodeValue(Number(key), value));
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
      const clusterId = Number(key);
      const instrumentedSet = this.instrumentClusterSet(clusterId, value);
      const result = originalSet(key, instrumentedSet);
      if (!this.suppressTracking) {
        this.recordClusterMutation(clusterId);
      }
      return result;
    };

    map.delete = (key) => {
      const clusterId = Number(key);
      const existed = map.has(key);
      const result = originalDelete(key);
      if (existed && !this.suppressTracking) {
        this.recordClusterDeletion(clusterId);
      }
      return result;
    };

    map.clear = () => {
      const ids = Array.from(map.keys()).map(Number);
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
      originalSet(key, this.instrumentClusterSet(Number(key), value));
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
    if (Number.isNaN(nodeId)) return;
    if (this.suppressTracking) return;
    const numericId = Number(nodeId);
    this.trackedNodes.add(numericId);
    this.deletedNodes.delete(numericId);
    this.versionClock += 1;
    this.lastDiffTimestamp = Date.now();
  }

  recordNodeDeletion(nodeId) {
    if (Number.isNaN(nodeId)) return;
    if (this.suppressTracking) return;
    const numericId = Number(nodeId);
    this.trackedNodes.delete(numericId);
    this.deletedNodes.add(numericId);
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
    const key = Number.isNaN(Number(clusterId)) ? clusterId : Number(clusterId);
    this.trackedClusters.add(key);
    this.lastDiffTimestamp = Date.now();
  }

  recordClusterDeletion(clusterId) {
    if (this.suppressTracking) return;
    const key = Number.isNaN(Number(clusterId)) ? clusterId : Number(clusterId);
    this.trackedClusters.add(key);
    this.lastDiffTimestamp = Date.now();
  }

  getNodeSnapshot(nodeId) {
    const stored = this.localMemory.nodes?.get(nodeId);
    if (!stored) return null;
    const node = this.unwrapNode(stored);
    return {
      id: node.id,
      concept: node.concept,
      summary: node.summary,
      keyPhrase: node.keyPhrase,
      tag: node.tag,
      embedding: node.embedding ? Array.from(node.embedding) : null,
      weight: node.weight,
      activation: node.activation,
      cluster: node.cluster,
      accessCount: node.accessCount,
      created: this.normalizeTimestamp(node.created),
      accessed: this.normalizeTimestamp(node.accessed)
    };
  }

  getEdgeSnapshot(edgeKey) {
    const stored = this.localMemory.edges?.get(edgeKey);
    if (!stored) return null;
    const edge = this.unwrapEdge(stored);
    const [source, target] = edgeKey.split('->').map(Number);
    return {
      id: edgeKey,
      source,
      target,
      weight: edge.weight,
      type: edge.type,
      created: this.normalizeTimestamp(edge.created),
      accessed: this.normalizeTimestamp(edge.accessed)
    };
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
          value: snapshot,
          timestamp,
          versionVector
        };
      }
    }

    for (const nodeId of this.deletedNodes) {
      fields[`memory.node.${nodeId}`] = {
        op: 'delete',
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
          value: snapshot,
          timestamp,
          versionVector
        };
      }
    }

    for (const edgeKey of this.deletedEdges) {
      fields[`memory.edge.${edgeKey}`] = {
        op: 'delete',
        timestamp,
        versionVector
      };
    }

    for (const clusterId of this.trackedClusters) {
      const snapshot = this.getClusterSnapshot(clusterId);
      if (snapshot) {
        fields[`memory.cluster.${clusterId}`] = {
          op: 'set',
          value: snapshot,
          timestamp,
          versionVector
        };
      }
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

    this.withSuppressedTracking(() => {
      for (const nodeData of nodeSets) {
        this.applyNodeSnapshot(nodeData);
      }

      for (const edgeData of edgeSets) {
        // CRITICAL FIX: Use string-safe sort for merged runs with string IDs
        const edgeKey = edgeData.id || [edgeData.source, edgeData.target].sort((a, b) => {
          const strA = String(a);
          const strB = String(b);
          return strA.localeCompare(strB);
        }).join('->');
        this.applyEdgeSnapshot(edgeKey, edgeData);
      }

      for (const clusterData of clusterSets) {
        this.applyClusterSnapshot(clusterData);
      }

      for (const nodeId of nodeDeletes) {
        // CRITICAL FIX: Don't convert to Number (breaks string IDs from merged runs)
        // Use nodeId as-is (works with both numeric and string)
        Map.prototype.delete.call(this.localMemory.nodes, nodeId);
        for (const clusterSet of this.localMemory.clusters.values()) {
          clusterSet.delete(nodeId);
        }
      }

      for (const edgeKey of edgeDeletes) {
        Map.prototype.delete.call(this.localMemory.edges, edgeKey);
      }

      for (const clusterId of clusterDeletes) {
        // CRITICAL FIX: Don't convert to Number (preserve type)
        Map.prototype.delete.call(this.localMemory.clusters, clusterId);
      }
    });
  }

  applyNodeSnapshot(data) {
    if (!data || data.id === undefined || data.id === null) return;

    const nodeId = Number(data.id);
    const node = {
      id: nodeId,
      concept: data.concept,
      summary: data.summary,
      keyPhrase: data.keyPhrase,
      tag: data.tag,
      embedding: data.embedding ? Array.from(data.embedding) : null,
      weight: data.weight ?? 1.0,
      activation: data.activation ?? 0,
      cluster: data.cluster ?? null,
      accessCount: data.accessCount ?? 0,
      created: data.created ? new Date(data.created) : new Date(),
      accessed: data.accessed ? new Date(data.accessed) : new Date()
    };

    Map.prototype.set.call(this.localMemory.nodes, nodeId, this.instrumentNodeValue(nodeId, node));

    if (typeof this.localMemory.nextNodeId === 'number' && nodeId >= this.localMemory.nextNodeId) {
      this.localMemory.nextNodeId = nodeId + 1;
    }
  }

  applyEdgeSnapshot(edgeKey, data) {
    if (!edgeKey) return;
    const edge = {
      weight: data.weight ?? 0.1,
      type: data.type || 'associative',
      created: data.created ? new Date(data.created) : new Date(),
      accessed: data.accessed ? new Date(data.accessed) : new Date()
    };

    Map.prototype.set.call(this.localMemory.edges, edgeKey, this.instrumentEdgeValue(edgeKey, edge));
  }

  applyClusterSnapshot(data) {
    if (!data || data.id === undefined || data.id === null) return;
    const clusterId = Number(data.id);
    const nodeIds = Array.isArray(data.nodes) ? data.nodes : [];
    const set = this.instrumentClusterSet(clusterId, new Set(nodeIds));
    Map.prototype.set.call(this.localMemory.clusters, clusterId, set);

    if (typeof this.localMemory.nextClusterId === 'number' && clusterId >= this.localMemory.nextClusterId) {
      this.localMemory.nextClusterId = clusterId + 1;
    }
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
        clusters: this.trackedClusters.size
      }
    };
  }
}

module.exports = { ClusterAwareMemory };
