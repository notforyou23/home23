'use strict';

const { edgeKeyFor, normalizeId, memorySourceError, throwIfAborted } = require('./contracts.cjs');

function roughBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function createBoundedOverlayStore(options = {}) {
  const maxMemoryBytes = options.maxMemoryBytes ?? 8 * 1024 * 1024;
  const nodes = new Map();
  const edges = new Map();
  const removedNodes = new Set();
  const removedEdges = new Set();
  let retainedBytes = 0;
  const claim = async (bytes) => {
    retainedBytes += bytes;
    if (retainedBytes > maxMemoryBytes) {
      if (!options.operationRoot) {
        throw memorySourceError('source_operation_required', 'operation root required for large overlay');
      }
      throw memorySourceError('result_too_large', 'overlay spill is not available in this slice', {
        status: 413,
        retryable: false,
      });
    }
  };
  return {
    async apply(entry) {
      throwIfAborted(options.signal);
      if (entry?.op === 'upsert_node') {
        const id = normalizeId(entry.record?.id);
        if (!id) throw memorySourceError('source_unavailable', 'invalid node delta', { retryable: true });
        const record = Object.freeze({ ...entry.record, id });
        await claim(roughBytes(record));
        removedNodes.delete(id);
        nodes.set(id, record);
        return;
      }
      if (entry?.op === 'remove_node') {
        const id = normalizeId(entry.id);
        if (!id) throw memorySourceError('source_unavailable', 'invalid node tombstone', { retryable: true });
        removedNodes.add(id);
        nodes.delete(id);
        return;
      }
      if (entry?.op === 'upsert_edge') {
        const key = edgeKeyFor(entry.record);
        const record = Object.freeze({ ...entry.record });
        await claim(roughBytes(record));
        removedEdges.delete(key);
        edges.set(key, record);
        return;
      }
      if (entry?.op === 'remove_edge') {
        const key = edgeKeyFor(entry.record || entry);
        removedEdges.add(key);
        edges.delete(key);
        return;
      }
      throw memorySourceError('source_unavailable', 'unknown delta operation', { retryable: true });
    },
    node(id) { return nodes.get(normalizeId(id)); },
    edge(edge) { return edges.get(edgeKeyFor(edge)); },
    hasRemovedNode(id) { return removedNodes.has(normalizeId(id)); },
    hasRemovedEdge(edge) { return removedEdges.has(edgeKeyFor(edge)); },
    upsertedNodes() { return [...nodes.values()].sort((a, b) => normalizeId(a.id).localeCompare(normalizeId(b.id))); },
    upsertedEdges() { return [...edges.values()].sort((a, b) => edgeKeyFor(a).localeCompare(edgeKeyFor(b))); },
    get retainedBytes() { return retainedBytes; },
    async close() {
      nodes.clear();
      edges.clear();
      removedNodes.clear();
      removedEdges.clear();
      retainedBytes = 0;
    },
  };
}

async function createEmptyOverlayStore() {
  return createBoundedOverlayStore({ maxMemoryBytes: Number.MAX_SAFE_INTEGER });
}

module.exports = {
  createBoundedOverlayStore,
  createEmptyOverlayStore,
};
