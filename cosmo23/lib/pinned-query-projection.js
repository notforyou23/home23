'use strict';

const { QUERY_OPERATION_LIMITS } = require('./brain-operation-limits');
const { serializeProviderRecord } = require('./provider-record-sanitizer');

const COOPERATIVE_YIELD_EVERY = 1_000;

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

async function yieldForCancellation(count, signal) {
  if (count % COOPERATIVE_YIELD_EVERY !== 0) return;
  await new Promise((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

function boundedLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw typed('invalid_request', 'Projection limits must be an object');
  }
  const result = {};
  for (const [key, ceiling] of Object.entries(QUERY_OPERATION_LIMITS)) {
    const value = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : ceiling;
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw typed('invalid_request', `Invalid projection limit: ${key}`);
    }
    result[key] = value;
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(QUERY_OPERATION_LIMITS, key)) {
      throw typed('invalid_request', `Unknown projection limit: ${key}`);
    }
  }
  return Object.freeze(result);
}

function serializeRecord(record, maxRecordBytes, kind) {
  return serializeProviderRecord(record, {
    maxBytes: maxRecordBytes,
    label: `Pinned ${kind} record`,
  });
}

function nodeId(node) {
  const value = node?.id ?? node?.nodeId ?? node?.key;
  if ((typeof value !== 'string' && !Number.isSafeInteger(value))
      || String(value).length === 0 || String(value).length > 512) {
    return null;
  }
  return String(value);
}

function edgeEndpoint(edge, side) {
  const value = side === 'source'
    ? (edge?.source ?? edge?.from ?? edge?.sourceId)
    : (edge?.target ?? edge?.to ?? edge?.targetId);
  if ((typeof value !== 'string' && !Number.isSafeInteger(value))
      || String(value).length === 0 || String(value).length > 512) return null;
  return String(value);
}

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9_:-]+/)
    .filter(term => term.length >= 2))].slice(0, 128);
}

function nodeText(node) {
  const values = [
    node.content, node.concept, node.text, node.summary, node.title,
    node.type, node.tag, Array.isArray(node.tags) ? node.tags.join(' ') : '',
  ];
  if (node.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)) {
    for (const value of Object.values(node.metadata)) {
      if (typeof value === 'string') values.push(value);
    }
  }
  return values.filter(value => typeof value === 'string').join(' ').toLowerCase();
}

function scoreNode(node, terms) {
  const text = nodeText(node);
  let matched = 0;
  for (const term of terms) if (text.includes(term)) matched += 1;
  const coverage = terms.length ? matched / terms.length : 0;
  const salience = Number(node.salience ?? node.weight ?? node.activation ?? 0);
  const boundedSalience = Number.isFinite(salience) ? Math.max(0, Math.min(1, salience)) : 0;
  return coverage * 4 + matched * 0.25 + boundedSalience;
}

function compareCandidate(left, right) {
  if (left.score !== right.score) return left.score - right.score;
  return right.id.localeCompare(left.id);
}

class BoundedMinHeap {
  constructor(limit) {
    this.limit = limit;
    this.rows = [];
  }

  _swap(a, b) {
    [this.rows[a], this.rows[b]] = [this.rows[b], this.rows[a]];
  }

  _up(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidate(this.rows[parent], this.rows[index]) <= 0) break;
      this._swap(parent, index);
      index = parent;
    }
  }

  _down(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.rows.length
          && compareCandidate(this.rows[left], this.rows[smallest]) < 0) smallest = left;
      if (right < this.rows.length
          && compareCandidate(this.rows[right], this.rows[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      this._swap(index, smallest);
      index = smallest;
    }
  }

  add(candidate) {
    if (this.rows.length < this.limit) {
      this.rows.push(candidate);
      this._up(this.rows.length - 1);
      return { added: candidate, removed: null };
    }
    if (compareCandidate(candidate, this.rows[0]) <= 0) {
      return { added: null, removed: null };
    }
    const removed = this.rows[0];
    this.rows[0] = candidate;
    this._down(0);
    return { added: candidate, removed };
  }

  removeMinimum() {
    if (this.rows.length === 0) return null;
    const removed = this.rows[0];
    const last = this.rows.pop();
    if (this.rows.length > 0) {
      this.rows[0] = last;
      this._down(0);
    }
    return removed;
  }

  valuesBestFirst() {
    return [...this.rows].sort((left, right) => {
      const comparison = compareCandidate(right, left);
      return comparison || left.id.localeCompare(right.id);
    });
  }
}

async function projectPinnedQuery({
  sourcePin,
  query,
  signal,
  limits = {},
  sourceSummary,
  onNodeScanned = null,
  onEdgeScanned = null,
} = {}) {
  if (!sourcePin || typeof sourcePin.iterateNodes !== 'function'
      || typeof sourcePin.iterateEdges !== 'function') {
    throw typed('source_pin_required', 'Pinned source iterators are required');
  }
  if (typeof query !== 'string' || !query.trim()) {
    throw typed('invalid_request', 'Query is required');
  }
  const selectedLimits = boundedLimits(limits);
  const terms = queryTerms(query);
  const heap = new BoundedMinHeap(selectedLimits.maxNodes);
  let retainedNodeBytes = 0;
  let nodesScanned = 0;
  let maxRetainedNodes = 0;
  let maxRetainedBytes = 0;

  throwIfAborted(signal);
  for await (const rawNode of sourcePin.iterateNodes({ signal })) {
    throwIfAborted(signal);
    nodesScanned += 1;
    const serialized = serializeRecord(rawNode, selectedLimits.maxRecordBytes, 'node');
    const id = nodeId(serialized.value);
    if (id !== null) {
      const change = heap.add({
        id,
        score: scoreNode(serialized.value, terms),
        record: serialized.value,
        bytes: serialized.bytes,
      });
      if (change.added) retainedNodeBytes += change.added.bytes;
      if (change.removed) retainedNodeBytes -= change.removed.bytes;
      while (retainedNodeBytes > selectedLimits.maxProjectionBytes) {
        const removed = heap.removeMinimum();
        if (!removed) {
          throw typed('result_too_large', 'Pinned query record cannot fit the projection budget');
        }
        retainedNodeBytes -= removed.bytes;
      }
      maxRetainedNodes = Math.max(maxRetainedNodes, heap.rows.length);
      maxRetainedBytes = Math.max(maxRetainedBytes, retainedNodeBytes);
    }
    if (typeof onNodeScanned === 'function') onNodeScanned(nodesScanned);
    await yieldForCancellation(nodesScanned, signal);
  }

  const nodes = heap.valuesBestFirst().map(row => row.record);
  const retainedIds = new Set(nodes.map(nodeId).filter(Boolean));
  const edges = [];
  let edgeBytes = 0;
  let edgesScanned = 0;
  for await (const rawEdge of sourcePin.iterateEdges({ signal })) {
    throwIfAborted(signal);
    edgesScanned += 1;
    const serialized = serializeRecord(rawEdge, selectedLimits.maxRecordBytes, 'edge');
    const source = edgeEndpoint(serialized.value, 'source');
    const target = edgeEndpoint(serialized.value, 'target');
    if (edges.length < selectedLimits.maxEdges
        && source !== null && target !== null
        && retainedIds.has(source) && retainedIds.has(target)) {
      if (retainedNodeBytes + edgeBytes + serialized.bytes
          <= selectedLimits.maxProjectionBytes) {
        edges.push(serialized.value);
        edgeBytes += serialized.bytes;
        maxRetainedBytes = Math.max(maxRetainedBytes, retainedNodeBytes + edgeBytes);
      }
    }
    if (typeof onEdgeScanned === 'function') onEdgeScanned(edgesScanned);
    await yieldForCancellation(edgesScanned, signal);
  }
  throwIfAborted(signal);

  const summary = sourceSummary !== undefined
    ? sourceSummary
    : typeof sourcePin.summarize === 'function'
      ? await sourcePin.summarize({ signal })
      : sourcePin.descriptor?.summary || null;
  throwIfAborted(signal);
  const evidence = typeof sourcePin.getEvidence === 'function'
    ? sourcePin.getEvidence({
      operation: 'query_projection',
      returnedTotals: { nodes: nodes.length, edges: edges.length },
      completeCoverage: true,
      filteredTotal: 0,
    })
    : sourcePin.evidence || null;
  const sourceRevision = sourcePin.revision
    ?? sourcePin.descriptor?.cutoffRevision
    ?? evidence?.deltaWatermark?.revision
    ?? null;

  return Object.freeze({
    nodes,
    edges,
    summary,
    sourceRevision,
    sourceEvidence: evidence,
    stats: Object.freeze({
      nodesScanned,
      edgesScanned,
      nodesRetained: nodes.length,
      edgesRetained: edges.length,
      maxRetainedNodes,
      maxRetainedEdges: edges.length,
      maxRetainedBytes,
      retainedBytes: retainedNodeBytes + edgeBytes,
    }),
  });
}

module.exports = {
  COOPERATIVE_YIELD_EVERY,
  boundedLimits,
  projectPinnedQuery,
};
