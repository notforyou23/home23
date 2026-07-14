'use strict';

const { QUERY_OPERATION_LIMITS } = require('./brain-operation-limits');
const {
  projectQueryEvidenceEdge,
  projectQueryEvidenceNode,
  projectionRecordLimits,
} = require('./query-evidence-projector');

const COOPERATIVE_YIELD_EVERY = 1_000;
const CANDIDATE_OVERSAMPLE = 4;

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

function normalizedBucketPart(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-');
  return normalized ? normalized.slice(0, 96) : null;
}

function candidateBucket(record) {
  const type = normalizedBucketPart(record.type);
  const tag = normalizedBucketPart(record.tag)
    || (Array.isArray(record.tags) ? normalizedBucketPart(record.tags[0]) : null);
  if (type && tag) return `type:${type}|tag:${tag}`;
  if (type) return `type:${type}`;
  if (tag) return `tag:${tag}`;
  return 'untyped';
}

function diverseBestFirst(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const bucket = candidateBucket(candidate.record);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(candidate);
  }
  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const comparison = compareCandidate(right[1][0], left[1][0]);
    return comparison || left[0].localeCompare(right[0]);
  });
  const offsets = new Map(orderedGroups.map(([bucket]) => [bucket, 0]));
  const output = [];
  while (true) {
    let added = false;
    for (const [bucket, rows] of orderedGroups) {
      const offset = offsets.get(bucket);
      if (offset >= rows.length) continue;
      output.push(rows[offset]);
      offsets.set(bucket, offset + 1);
      added = true;
    }
    if (!added) break;
  }
  return output;
}

function effectiveRecordLimits(mode, selectedLimits) {
  const configured = projectionRecordLimits(mode);
  const maxRecordBytes = Math.min(configured.maxRecordBytes, selectedLimits.maxRecordBytes);
  if (maxRecordBytes <= 1) {
    throw typed('result_too_large', 'Query evidence record limit is too small');
  }
  return Object.freeze({
    maxRecordBytes,
    maxContentBytes: Math.min(configured.maxContentBytes, maxRecordBytes - 1),
  });
}

async function projectPinnedQuery({
  sourcePin,
  query,
  mode = 'full',
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
  const recordLimits = effectiveRecordLimits(mode, selectedLimits);
  const terms = queryTerms(query);
  const candidateLimit = Math.min(
    QUERY_OPERATION_LIMITS.maxNodes * CANDIDATE_OVERSAMPLE,
    selectedLimits.maxNodes * CANDIDATE_OVERSAMPLE,
  );
  const heap = new BoundedMinHeap(candidateLimit);
  let nodesScanned = 0;
  let nodesDroppedForByteBudget = 0;

  throwIfAborted(signal);
  for await (const rawNode of sourcePin.iterateNodes({ signal })) {
    throwIfAborted(signal);
    nodesScanned += 1;
    const projected = projectQueryEvidenceNode(rawNode, recordLimits);
    const id = nodeId(projected.value);
    heap.add({
      id,
      score: scoreNode(projected.value, terms),
      record: projected.value,
      bytes: projected.bytes,
    });
    if (typeof onNodeScanned === 'function') onNodeScanned(nodesScanned);
    await yieldForCancellation(nodesScanned, signal);
  }

  const selectedRows = [];
  let retainedNodeBytes = 0;
  for (const candidate of diverseBestFirst(heap.valuesBestFirst())) {
    if (selectedRows.length >= selectedLimits.maxNodes) break;
    if (retainedNodeBytes + candidate.bytes > selectedLimits.maxProjectionBytes) {
      nodesDroppedForByteBudget += 1;
      continue;
    }
    selectedRows.push(candidate);
    retainedNodeBytes += candidate.bytes;
  }
  selectedRows.sort((left, right) => compareCandidate(right, left));
  const nodes = selectedRows.map(row => row.record);
  if (nodes.length === 0 && heap.rows.length > 0) {
    throw typed('result_too_large', 'No pinned query candidate fits the projection byte limit');
  }
  const retainedIds = new Set(nodes.map(nodeId).filter(Boolean));
  const edges = [];
  let edgeBytes = 0;
  let edgesScanned = 0;
  let edgesDroppedForByteBudget = 0;
  for await (const rawEdge of sourcePin.iterateEdges({ signal })) {
    throwIfAborted(signal);
    edgesScanned += 1;
    const projected = projectQueryEvidenceEdge(rawEdge, recordLimits);
    const source = edgeEndpoint(projected.value, 'source');
    const target = edgeEndpoint(projected.value, 'target');
    if (edges.length < selectedLimits.maxEdges
        && source !== null && target !== null
        && retainedIds.has(source) && retainedIds.has(target)) {
      if (retainedNodeBytes + edgeBytes + projected.bytes
          > selectedLimits.maxProjectionBytes) {
        edgesDroppedForByteBudget += 1;
      } else {
        edges.push(projected.value);
        edgeBytes += projected.bytes;
      }
    }
    if (typeof onEdgeScanned === 'function') onEdgeScanned(edgesScanned);
    await yieldForCancellation(edgesScanned, signal);
  }
  throwIfAborted(signal);

  const droppedForByteBudget = nodesDroppedForByteBudget + edgesDroppedForByteBudget;
  const byteBudgetTruncated = droppedForByteBudget > 0;

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
      byteBudgetTruncated,
      droppedForByteBudget,
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
      maxRetainedNodes: nodes.length,
      maxRetainedEdges: edges.length,
      maxRetainedBytes: retainedNodeBytes + edgeBytes,
      retainedBytes: retainedNodeBytes + edgeBytes,
      byteBudgetTruncated,
      droppedForByteBudget,
      nodesDroppedForByteBudget,
      edgesDroppedForByteBudget,
    }),
  });
}

module.exports = {
  COOPERATIVE_YIELD_EVERY,
  boundedLimits,
  projectPinnedQuery,
};
