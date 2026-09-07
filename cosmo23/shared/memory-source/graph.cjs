'use strict';

const {
  normalizeId,
  parseBoundedInteger,
  throwIfAborted,
} = require('./contracts.cjs');

const NODE_BYTES_LIMIT = 128 * 1024;
const EDGE_BYTES_LIMIT = 32 * 1024;
const NODE_HEAP_BYTES_LIMIT = 16 * 1024 * 1024;
const EDGE_HEAP_BYTES_LIMIT = 8 * 1024 * 1024;
const CLUSTER_TOTALS_BYTES_LIMIT = 1024 * 1024;
const CLUSTER_TOTALS_KEY_LIMIT = 10000;
const GRAPH_RESPONSE_BYTES_LIMIT = 32 * 1024 * 1024;

function nodeRank(node) {
  const accessed = Date.parse(node.accessed || node.created || '') || 0;
  return Number(node.activation || 0) * 3
    + Number(node.weight || 0) * 2
    + Math.log1p(Number(node.accessCount || 0))
    + accessed / 1e15;
}

function resultTooLarge(subject) {
  return Object.assign(new Error(`${subject} exceeds the bounded graph budget`), {
    code: 'result_too_large',
    status: 413,
  });
}

function canonicalByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function invalidSource(field) {
  return Object.assign(new Error(`${field} is not a bounded graph scalar`), {
    code: 'source_invalid',
    status: 422,
    field,
  });
}

function normalizeOptionalTag(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value
      || Buffer.byteLength(value, 'utf8') > 1024) {
    throw Object.assign(new Error('tag must be a bounded exact string'), {
      code: 'invalid_request',
      status: 400,
      field: 'tag',
    });
  }
  return value;
}

function assertPlainJsonRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalidSource(field);
  }
}

function boundedIdentifier(value, maxBytes, field) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidSource(field);
  }
  return value;
}

function boundedUtf8Text(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { value: text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return { value: text.slice(0, low), truncated: true };
}

function boundedOptionalText(value, maxBytes) {
  if (value === null || value === undefined) return null;
  const bounded = boundedUtf8Text(value, maxBytes);
  if (bounded.truncated) throw invalidSource('date');
  return bounded.value;
}

function finiteNumberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function finiteNonnegativeIntegerOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function projectGraphNode(node) {
  assertPlainJsonRecord(node, 'node');
  const id = boundedIdentifier(normalizeId(node.id), 4096, 'node.id');
  const concept = boundedUtf8Text(node.concept ?? '', 64 * 1024);
  const row = {
    id,
    concept: concept.value,
    conceptTruncated: concept.truncated,
    tag: boundedIdentifier(String(node.tag ?? 'general'), 1024, 'node.tag'),
    weight: finiteNumberOrZero(node.weight),
    activation: finiteNumberOrZero(node.activation),
    cluster: node.cluster == null ? null
      : boundedIdentifier(normalizeId(node.cluster), 4096, 'node.cluster'),
    created: boundedOptionalText(node.created, 128),
    accessed: boundedOptionalText(node.accessed, 128),
    accessCount: finiteNonnegativeIntegerOrZero(node.accessCount),
  };
  if (canonicalByteLength(row) > NODE_BYTES_LIMIT) throw resultTooLarge('projected graph node');
  return row;
}

function projectGraphEdge(edge, { sourceId, targetId }) {
  assertPlainJsonRecord(edge, 'edge');
  const row = {
    source: boundedIdentifier(sourceId, 4096, 'edge.source'),
    target: boundedIdentifier(targetId, 4096, 'edge.target'),
    weight: finiteNumberOrZero(edge.weight),
    type: boundedIdentifier(String(edge.type ?? 'associative'), 1024, 'edge.type'),
  };
  if (canonicalByteLength(row) > EDGE_BYTES_LIMIT) throw resultTooLarge('projected graph edge');
  return row;
}

function incrementClusterTotal(state, cluster) {
  const key = cluster == null ? 'unclustered' : String(cluster);
  const previous = state.totals[key] || 0;
  const next = previous + 1;
  const pairBytes = (count) => canonicalByteLength(key) + 1 + Buffer.byteLength(String(count), 'utf8');
  const nextBytes = state.bytes
    - (previous ? pairBytes(previous) : 0)
    + pairBytes(next)
    + (!previous && state.keys ? 1 : 0);
  if ((!previous && state.keys === CLUSTER_TOTALS_KEY_LIMIT)
      || nextBytes > CLUSTER_TOTALS_BYTES_LIMIT) {
    return false;
  }
  state.totals[key] = next;
  state.bytes = nextBytes;
  if (!previous) state.keys += 1;
  return true;
}

class BoundedTopK {
  constructor(limit, isBetter, { maxBytes, sizeOf }) {
    this.limit = limit;
    this.isBetter = isBetter;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.heap = [];
    this.retainedBytes = 0;
    this.maxRetainedBytes = 0;
    this.comparisons = 0;
    this.maxSize = 0;
  }

  worse(a, b) {
    this.comparisons += 1;
    return this.isBetter(b, a);
  }

  swap(a, b) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
  }

  siftUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.worse(this.heap[index], this.heap[parent])) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  siftDown(index) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.heap.length && this.worse(this.heap[left], this.heap[worst])) worst = left;
      if (right < this.heap.length && this.worse(this.heap[right], this.heap[worst])) worst = right;
      if (worst === index) return;
      this.swap(index, worst);
      index = worst;
    }
  }

  popWorst() {
    const worst = this.heap[0];
    const tail = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = tail;
      this.siftDown(0);
    }
    return worst;
  }

  push(value) {
    if (this.limit === 0) return;
    const bytes = this.sizeOf(value);
    if (bytes > this.maxBytes) throw resultTooLarge('projected graph record');
    const retained = { ...value, __retainedBytes: bytes };
    this.heap.push(retained);
    this.retainedBytes += bytes;
    this.siftUp(this.heap.length - 1);
    while (this.heap.length > this.limit || this.retainedBytes > this.maxBytes) {
      const removed = this.popWorst();
      this.retainedBytes -= removed.__retainedBytes;
    }
    this.maxSize = Math.max(this.maxSize, this.heap.length);
    this.maxRetainedBytes = Math.max(this.maxRetainedBytes, this.retainedBytes);
  }

  sorted() {
    return [...this.heap].sort((a, b) => {
      if (this.isBetter(a, b)) return -1;
      if (this.isBetter(b, a)) return 1;
      return 0;
    });
  }
}

async function sampleMemoryGraph(source, options = {}) {
  throwIfAborted(options.signal);
  if (options.full === true || options.full === '1' || options.full === 'true') {
    throw resultTooLarge('full graph');
  }
  const rawNodeLimit = Object.prototype.hasOwnProperty.call(options, 'nodeLimit')
    ? options.nodeLimit
    : options.limit;
  const nodeLimit = parseBoundedInteger(rawNodeLimit, {
    name: 'nodeLimit',
    defaultValue: 250,
    min: 1,
    max: 2000,
  });
  const edgeLimit = parseBoundedInteger(options.edgeLimit, {
    name: 'edgeLimit',
    defaultValue: 1000,
    min: 0,
    max: 8000,
  });
  const clusterId = options.clusterId === null || options.clusterId === undefined
    ? null
    : normalizeId(options.clusterId);
  const tag = normalizeOptionalTag(options.tag);
  const minWeight = Number(options.minWeight ?? 0);
  if (!Number.isFinite(minWeight)) {
    throw Object.assign(new Error('minWeight must be finite'), {
      code: 'invalid_request',
      status: 400,
      field: 'minWeight',
      value: options.minWeight,
    });
  }
  const selected = new BoundedTopK(nodeLimit, (a, b) => a.rank > b.rank
    || (a.rank === b.rank && normalizeId(a.node.id).localeCompare(normalizeId(b.node.id)) < 0), {
    maxBytes: NODE_HEAP_BYTES_LIMIT,
    sizeOf: (item) => canonicalByteLength(item.node),
  });
  let clusterState = { totals: Object.create(null), bytes: 2, keys: 0 };
  let clusterTotalsOmitted = false;
  for await (const node of source.iterateNodes({ signal: options.signal })) {
    throwIfAborted(options.signal);
    assertPlainJsonRecord(node, 'node');
    const projectedCluster = node.cluster == null ? null
      : boundedIdentifier(normalizeId(node.cluster), 4096, 'node.cluster');
    if (!clusterTotalsOmitted && !incrementClusterTotal(clusterState, projectedCluster)) {
      clusterState = null;
      clusterTotalsOmitted = true;
    }
    if (clusterId !== null && normalizeId(node.cluster) !== clusterId) continue;
    if (tag !== null && String(node.tag ?? 'general') !== tag) continue;
    const projected = projectGraphNode(node);
    selected.push({ node: projected, rank: nodeRank(projected) });
  }
  const nodes = selected.sorted().map((item) => item.node);
  const ids = new Set(nodes.map((node) => normalizeId(node.id)));
  const edges = new BoundedTopK(edgeLimit, (a, b) => Number(a.weight || 0) > Number(b.weight || 0)
    || (Number(a.weight || 0) === Number(b.weight || 0)
      && `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`) < 0), {
    maxBytes: EDGE_HEAP_BYTES_LIMIT,
    sizeOf: canonicalByteLength,
  });
  for await (const edge of source.iterateEdges({ signal: options.signal })) {
    throwIfAborted(options.signal);
    assertPlainJsonRecord(edge, 'edge');
    const sourceId = normalizeId(edge.source ?? edge.from);
    const targetId = normalizeId(edge.target ?? edge.to);
    if (!ids.has(sourceId) || !ids.has(targetId) || Number(edge.weight || 0) < minWeight) continue;
    edges.push(projectGraphEdge(edge, { sourceId, targetId }));
  }
  const edgeRows = edges.sorted().map(({ __retainedBytes, ...edge }) => edge);
  const summary = await source.summarize({ signal: options.signal });
  const response = {
    success: true,
    nodes,
    edges: edgeRows,
    clusters: clusterState?.totals || null,
    meta: {
      revision: source.revision,
      authoritativeNodeCount: summary.nodes,
      authoritativeEdgeCount: summary.edges,
      returnedNodeCount: nodes.length,
      returnedEdgeCount: edgeRows.length,
      nodeCount: summary.nodes,
      edgeCount: summary.edges,
      displayedNodeCount: nodes.length,
      displayedEdgeCount: edgeRows.length,
      clusterCount: summary.clusters,
      limited: nodes.length < summary.nodes || edgeRows.length < summary.edges,
      maxNodeHeapSize: selected.maxSize,
      maxEdgeHeapSize: edges.maxSize,
      maxNodeRetainedBytes: selected.maxRetainedBytes,
      maxEdgeRetainedBytes: edges.maxRetainedBytes,
      clusterTotalsOmitted,
      heapComparisons: selected.comparisons + edges.comparisons,
    },
    evidence: source.getEvidence({
      completeCoverage: true,
      filters: { clusterId, tag, minWeight },
      limits: { nodeLimit, edgeLimit },
      authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
      returnedTotals: { nodes: nodes.length, edges: edgeRows.length },
      matchOutcome: nodes.length ? 'matches' : undefined,
    }),
  };
  if (canonicalByteLength(response) > GRAPH_RESPONSE_BYTES_LIMIT) {
    throw resultTooLarge('graph response');
  }
  return response;
}

module.exports = {
  BoundedTopK,
  EDGE_HEAP_BYTES_LIMIT,
  GRAPH_RESPONSE_BYTES_LIMIT,
  NODE_HEAP_BYTES_LIMIT,
  canonicalByteLength,
  nodeRank,
  projectGraphEdge,
  projectGraphNode,
  sampleMemoryGraph,
};
