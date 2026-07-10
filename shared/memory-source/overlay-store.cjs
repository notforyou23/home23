'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const {
  edgeKeyFor,
  normalizeId,
  memorySourceError,
  throwIfAborted,
  rethrowAbort,
} = require('./contracts.cjs');

const DEFAULT_MEMORY_BYTES = 8 * 1024 * 1024;
const DEFAULT_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_RECORD_BYTES = 16 * 1024 * 1024;
const ENTRY_OVERHEAD_BYTES = 32;
const SQLITE_MUTATION_HEADROOM = 128 * 1024;

function limitError(message) {
  return memorySourceError('result_too_large', message, {
    status: 413,
    retryable: false,
  });
}

function boundedLimit(value, fallback, { allowZero = false } = {}) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1)) {
    throw memorySourceError('invalid_request', 'invalid overlay limit');
  }
  return resolved;
}

function jsonBytes(value, label = 'overlay record') {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw memorySourceError('source_unavailable', `${label} is not serializable`, {
      retryable: true,
      cause: error,
    });
  }
  if (text === undefined) {
    throw memorySourceError('source_unavailable', `${label} is not serializable`, {
      retryable: true,
    });
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

function retainedEntryBytes(key, record) {
  const keyBytes = Buffer.byteLength(key, 'utf8');
  return keyBytes + (record === undefined ? 0 : jsonBytes(record).bytes) + ENTRY_OVERHEAD_BYTES;
}

function normalizeEdgeKey(value) {
  if (typeof value === 'string') {
    if (!value || Buffer.byteLength(value, 'utf8') > 16 * 1024) {
      throw memorySourceError('source_unavailable', 'invalid edge key', { retryable: true });
    }
    return value;
  }
  const source = normalizeId(value?.source ?? value?.from);
  const target = normalizeId(value?.target ?? value?.to);
  if (!source || !target) {
    throw memorySourceError('source_unavailable', 'invalid edge delta', { retryable: true });
  }
  return edgeKeyFor({ source, target });
}

function normalizeNodeRecord(record) {
  const id = normalizeId(record?.id);
  if (!id) throw memorySourceError('source_unavailable', 'invalid node delta', { retryable: true });
  return Object.freeze({ ...record, id });
}

function normalizeEdgeRecord(record) {
  const source = normalizeId(record?.source ?? record?.from);
  const target = normalizeId(record?.target ?? record?.to);
  if (!source || !target) {
    throw memorySourceError('source_unavailable', 'invalid edge delta', { retryable: true });
  }
  return Object.freeze({ ...record, source, target });
}

function sortedKeys(mapOrSet) {
  return [...mapOrSet.keys()].sort((left, right) => left.localeCompare(right));
}

async function createBoundedOverlayStore(options = {}) {
  const maxMemoryBytes = boundedLimit(options.maxMemoryBytes, DEFAULT_MEMORY_BYTES, { allowZero: true });
  const maxDiskBytes = boundedLimit(options.maxDiskBytes, DEFAULT_DISK_BYTES);
  const maxRecordBytes = boundedLimit(options.maxRecordBytes, DEFAULT_RECORD_BYTES);
  const nodes = new Map();
  const edges = new Map();
  const removedNodes = new Set();
  const removedEdges = new Set();
  let retainedBytes = 0;
  let closed = false;
  let spillStarted = false;
  let spilled = false;
  let db = null;
  let statements = null;
  let diskActualBytes = 0;
  let diskReservedBytes = 0;
  let operationRoot = null;
  let overlayRoot = null;
  let databasePath = null;
  let scratchQuota = options.scratchQuota || null;
  let ownsScratchQuota = false;
  const quotaKind = `memory_overlay_${randomUUID()}`;

  if (options.operationRoot) {
    if (scratchQuota) {
      if (await scratchQuota.assertOperationRoot(options.operationRoot) !== true) {
        throw memorySourceError('source_operation_required', 'exact operation scratch quota required');
      }
      operationRoot = scratchQuota.operationRoot;
    } else {
      scratchQuota = await createOperationScratchQuota({ operationRoot: options.operationRoot });
      ownsScratchQuota = true;
      operationRoot = scratchQuota.operationRoot;
    }
    overlayRoot = path.join(operationRoot, 'overlay');
    databasePath = path.join(overlayRoot, `memory-overlay-${process.pid}-${randomUUID()}.sqlite`);
  }

  function assertOpen(signal) {
    if (closed) throw memorySourceError('invalid_request', 'overlay store is closed');
    throwIfAborted(options.signal);
    throwIfAborted(signal);
  }

  function stateBytes(kind, key) {
    if (kind === 'node') {
      if (nodes.has(key)) return retainedEntryBytes(key, nodes.get(key));
      if (removedNodes.has(key)) return retainedEntryBytes(key);
      return 0;
    }
    if (edges.has(key)) return retainedEntryBytes(key, edges.get(key));
    if (removedEdges.has(key)) return retainedEntryBytes(key);
    return 0;
  }

  function applyMemory(normalized) {
    const priorBytes = stateBytes(normalized.kind, normalized.key);
    const nextBytes = retainedEntryBytes(normalized.key, normalized.record);
    const projectedBytes = retainedBytes - priorBytes + nextBytes;
    if (projectedBytes > maxMemoryBytes) return false;
    if (normalized.kind === 'node') {
      nodes.delete(normalized.key);
      removedNodes.delete(normalized.key);
      if (normalized.tombstone) removedNodes.add(normalized.key);
      else nodes.set(normalized.key, normalized.record);
    } else {
      edges.delete(normalized.key);
      removedEdges.delete(normalized.key);
      if (normalized.tombstone) removedEdges.add(normalized.key);
      else edges.set(normalized.key, normalized.record);
    }
    retainedBytes = projectedBytes;
    return true;
  }

  function normalizeEntry(entry) {
    const encoded = jsonBytes(entry, 'delta record');
    if (encoded.bytes > maxRecordBytes) throw limitError('overlay record limit exceeded');
    // Parse the bounded serialization so Maps/SQLite never retain caller-owned
    // nested objects or a raw delta record after this call returns.
    const detached = JSON.parse(encoded.text);
    if (detached?.op === 'upsert_node') {
      const record = normalizeNodeRecord(detached.record);
      return { kind: 'node', key: record.id, record, tombstone: false };
    }
    if (detached?.op === 'remove_node') {
      const key = normalizeId(detached.id);
      if (!key) {
        throw memorySourceError('source_unavailable', 'invalid node tombstone', { retryable: true });
      }
      return { kind: 'node', key, record: undefined, tombstone: true };
    }
    if (detached?.op === 'upsert_edge') {
      const record = normalizeEdgeRecord(detached.record);
      return { kind: 'edge', key: normalizeEdgeKey(record), record, tombstone: false };
    }
    if (detached?.op === 'remove_edge') {
      const candidate = detached.key ?? detached.record ?? detached;
      return { kind: 'edge', key: normalizeEdgeKey(candidate), record: undefined, tombstone: true };
    }
    throw memorySourceError('source_unavailable', 'unknown delta operation', { retryable: true });
  }

  function checkCancelled(signal) {
    assertOpen(signal);
  }

  async function diskArtifactBytes() {
    let total = 0;
    for (const filePath of [
      databasePath,
      `${databasePath}-journal`,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      const stat = await fsp.lstat(filePath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw memorySourceError('invalid_memory_source', 'overlay database artifact is not a regular file', {
          retryable: false,
        });
      }
      total += stat.size;
      if (!Number.isSafeInteger(total)) throw limitError('overlay disk accounting overflow');
    }
    return total;
  }

  async function reserveDiskMutation(logicalBytes, rollbackBytes = 0) {
    checkCancelled();
    const allowance = logicalBytes + rollbackBytes + SQLITE_MUTATION_HEADROOM;
    const required = diskActualBytes + allowance;
    if (!Number.isSafeInteger(required) || required > maxDiskBytes) {
      throw limitError('overlay disk limit exceeded');
    }
    if (required > diskReservedBytes) {
      const claimBytes = required - diskReservedBytes;
      await scratchQuota.claim(claimBytes, quotaKind);
      diskReservedBytes += claimBytes;
      checkCancelled();
    }
  }

  async function refreshDiskAccounting() {
    const actual = await diskArtifactBytes();
    if (actual > maxDiskBytes || actual > diskReservedBytes) {
      throw limitError('overlay database exceeded reserved disk bytes');
    }
    diskActualBytes = actual;
  }

  async function ensurePrivateOverlayDirectory() {
    let stat = await fsp.lstat(overlayRoot).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) {
      await fsp.mkdir(overlayRoot, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      stat = await fsp.lstat(overlayRoot);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw memorySourceError('invalid_memory_source', 'overlay root is not a private directory', {
        retryable: false,
      });
    }
    const canonical = await fsp.realpath(overlayRoot);
    if (canonical !== overlayRoot || path.dirname(canonical) !== operationRoot) {
      throw memorySourceError('invalid_memory_source', 'overlay root escapes operation scratch', {
        retryable: false,
      });
    }
  }

  function prepareStatements() {
    statements = Object.freeze({
      upsertNode: db.prepare(`
        INSERT INTO nodes (key, tombstone, record)
        VALUES (?, 0, ?)
        ON CONFLICT(key) DO UPDATE SET tombstone = 0, record = excluded.record
      `),
      removeNode: db.prepare(`
        INSERT INTO nodes (key, tombstone, record)
        VALUES (?, 1, NULL)
        ON CONFLICT(key) DO UPDATE SET tombstone = 1, record = NULL
      `),
      upsertEdge: db.prepare(`
        INSERT INTO edges (key, source, target, tombstone, record)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(key) DO UPDATE SET
          source = excluded.source,
          target = excluded.target,
          tombstone = 0,
          record = excluded.record
      `),
      removeEdge: db.prepare(`
        INSERT INTO edges (key, source, target, tombstone, record)
        VALUES (?, NULL, NULL, 1, NULL)
        ON CONFLICT(key) DO UPDATE SET
          source = NULL,
          target = NULL,
          tombstone = 1,
          record = NULL
      `),
      node: db.prepare('SELECT record FROM nodes WHERE key = ? AND tombstone = 0'),
      edge: db.prepare('SELECT source, target, record FROM edges WHERE key = ? AND tombstone = 0'),
      removedNode: db.prepare('SELECT 1 AS present FROM nodes WHERE key = ? AND tombstone = 1'),
      removedEdge: db.prepare('SELECT 1 AS present FROM edges WHERE key = ? AND tombstone = 1'),
      nodeUpsert: db.prepare('SELECT 1 AS present FROM nodes WHERE key = ? AND tombstone = 0'),
      edgeUpsert: db.prepare('SELECT 1 AS present FROM edges WHERE key = ? AND tombstone = 0'),
      nodeStoredBytes: db.prepare('SELECT length(CAST(record AS BLOB)) AS bytes FROM nodes WHERE key = ?'),
      edgeStoredBytes: db.prepare('SELECT length(CAST(record AS BLOB)) AS bytes FROM edges WHERE key = ?'),
      nodeUpserts: db.prepare('SELECT record FROM nodes WHERE tombstone = 0 ORDER BY key'),
      edgeUpserts: db.prepare('SELECT source, target, record FROM edges WHERE tombstone = 0 ORDER BY key'),
    });
  }

  async function writeDiskState(normalized) {
    checkCancelled();
    const recordJson = normalized.record === undefined ? null : jsonBytes(normalized.record).text;
    const logicalBytes = retainedEntryBytes(normalized.key, normalized.record);
    const prior = normalized.kind === 'node'
      ? statements.nodeStoredBytes.get(normalized.key)
      : statements.edgeStoredBytes.get(normalized.key);
    await reserveDiskMutation(logicalBytes, Number(prior?.bytes || 0));
    checkCancelled();
    if (normalized.kind === 'node') {
      if (normalized.tombstone) statements.removeNode.run(normalized.key);
      else statements.upsertNode.run(normalized.key, recordJson);
    } else if (normalized.tombstone) {
      statements.removeEdge.run(normalized.key);
    } else {
      statements.upsertEdge.run(
        normalized.key,
        normalized.record.source,
        normalized.record.target,
        recordJson,
      );
    }
    checkCancelled();
    await refreshDiskAccounting();
  }

  async function spillMemoryState() {
    if (spilled) return;
    spillStarted = true;
    await ensurePrivateOverlayDirectory();
    await reserveDiskMutation(0);
    checkCancelled();
    await ensurePrivateOverlayDirectory();
    checkCancelled();
    db = new Database(databasePath);
    const journalMode = db.pragma('journal_mode = DELETE', { simple: true });
    if (String(journalMode).toLowerCase() !== 'delete') {
      throw memorySourceError('source_unavailable', 'SQLite DELETE journal mode unavailable', {
        retryable: true,
      });
    }
    db.pragma('temp_store = MEMORY');
    if (Number(db.pragma('temp_store', { simple: true })) !== 2) {
      throw memorySourceError('source_unavailable', 'SQLite memory temp store unavailable', {
        retryable: true,
      });
    }
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE nodes (
        key TEXT PRIMARY KEY,
        tombstone INTEGER NOT NULL,
        record TEXT
      );
      CREATE TABLE edges (
        key TEXT PRIMARY KEY,
        source TEXT,
        target TEXT,
        tombstone INTEGER NOT NULL,
        record TEXT
      );
    `);
    prepareStatements();
    await refreshDiskAccounting();

    for (const key of sortedKeys(nodes)) {
      checkCancelled();
      await writeDiskState({ kind: 'node', key, record: nodes.get(key), tombstone: false });
    }
    for (const key of sortedKeys(removedNodes)) {
      checkCancelled();
      await writeDiskState({ kind: 'node', key, record: undefined, tombstone: true });
    }
    for (const key of sortedKeys(edges)) {
      checkCancelled();
      await writeDiskState({ kind: 'edge', key, record: edges.get(key), tombstone: false });
    }
    for (const key of sortedKeys(removedEdges)) {
      checkCancelled();
      await writeDiskState({ kind: 'edge', key, record: undefined, tombstone: true });
    }
    nodes.clear();
    edges.clear();
    removedNodes.clear();
    removedEdges.clear();
    retainedBytes = 0;
    spilled = true;
  }

  function memoryNode(id) {
    return nodes.get(normalizeId(id));
  }

  function memoryEdge(value) {
    const record = edges.get(normalizeEdgeKey(value));
    if (!record || removedNodes.has(record.source) || removedNodes.has(record.target)) return undefined;
    return record;
  }

  function parseStoredRecord(row) {
    return row?.record == null ? undefined : Object.freeze(JSON.parse(row.record));
  }

  function diskNode(id) {
    return parseStoredRecord(statements.node.get(normalizeId(id)));
  }

  function diskNodeRemoved(id) {
    return statements.removedNode.get(normalizeId(id)) !== undefined;
  }

  function diskEdge(value) {
    const row = statements.edge.get(normalizeEdgeKey(value));
    if (!row || diskNodeRemoved(row.source) || diskNodeRemoved(row.target)) return undefined;
    return parseStoredRecord(row);
  }

  function* iterateNodesSync(signal) {
    assertOpen(signal);
    if (spilled) {
      for (const row of statements.nodeUpserts.iterate()) {
        assertOpen(signal);
        yield parseStoredRecord(row);
      }
      return;
    }
    for (const key of sortedKeys(nodes)) {
      assertOpen(signal);
      yield nodes.get(key);
    }
  }

  function* iterateEdgesSync(signal) {
    assertOpen(signal);
    if (spilled) {
      for (const row of statements.edgeUpserts.iterate()) {
        assertOpen(signal);
        if (!diskNodeRemoved(row.source) && !diskNodeRemoved(row.target)) {
          yield parseStoredRecord(row);
        }
      }
      return;
    }
    for (const key of sortedKeys(edges)) {
      assertOpen(signal);
      const record = edges.get(key);
      if (!removedNodes.has(record.source) && !removedNodes.has(record.target)) yield record;
    }
  }

  let closePromise = null;
  function closeStore() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      let cleanupError = null;
      try {
        if (db?.open) db.close();
      } catch (error) {
        cleanupError = error;
      }
      db = null;
      statements = null;
      if (databasePath) {
        const overlayStat = await fsp.lstat(overlayRoot).catch((error) => {
          if (error.code === 'ENOENT') return null;
          cleanupError ||= error;
          return null;
        });
        if (overlayStat?.isSymbolicLink()) {
          // Removing the operation-private link itself is safe; never resolve
          // a database path through it during cleanup.
          await fsp.rm(overlayRoot, { force: true }).catch((error) => { cleanupError ||= error; });
        } else if (overlayStat?.isDirectory()) {
          for (const filePath of [
            databasePath,
            `${databasePath}-journal`,
            `${databasePath}-wal`,
            `${databasePath}-shm`,
          ]) {
            try {
              await fsp.rm(filePath, { force: true });
            } catch (error) {
              cleanupError ||= error;
            }
          }
          await fsp.rmdir(overlayRoot).catch((error) => {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') cleanupError ||= error;
          });
        }
      }
      if (diskReservedBytes > 0 && scratchQuota) {
        try {
          await scratchQuota.release(diskReservedBytes, quotaKind);
          diskReservedBytes = 0;
          diskActualBytes = 0;
        } catch (error) {
          cleanupError ||= error;
        }
      }
      if (ownsScratchQuota) scratchQuota.close();
      nodes.clear();
      edges.clear();
      removedNodes.clear();
      removedEdges.clear();
      retainedBytes = 0;
      if (cleanupError) throw cleanupError;
    })();
    return closePromise;
  }

  const api = {
    async apply(entry) {
      assertOpen();
      const normalized = normalizeEntry(entry);
      if (spilled) {
        try {
          await writeDiskState(normalized);
          return;
        } catch (error) {
          await closeStore().catch(() => {});
          rethrowAbort(error, options.signal);
          throw error;
        }
      }
      if (applyMemory(normalized)) return;
      if (!options.operationRoot) {
        throw memorySourceError('source_operation_required', 'operation root required for large overlay', {
          retryable: false,
        });
      }
      try {
        await spillMemoryState();
        await writeDiskState(normalized);
      } catch (error) {
        await closeStore().catch(() => {});
        rethrowAbort(error, options.signal);
        throw error;
      }
    },
    node(id) {
      assertOpen();
      return spilled ? diskNode(id) : memoryNode(id);
    },
    edge(value) {
      assertOpen();
      return spilled ? diskEdge(value) : memoryEdge(value);
    },
    hasRemovedNode(id) {
      assertOpen();
      return spilled ? diskNodeRemoved(id) : removedNodes.has(normalizeId(id));
    },
    hasRemovedEdge(value) {
      assertOpen();
      const key = normalizeEdgeKey(value);
      return spilled ? statements.removedEdge.get(key) !== undefined : removedEdges.has(key);
    },
    hasNodeUpsert(id) {
      assertOpen();
      const key = normalizeId(id);
      return spilled ? statements.nodeUpsert.get(key) !== undefined : nodes.has(key);
    },
    hasEdgeUpsert(value) {
      assertOpen();
      const key = normalizeEdgeKey(value);
      return spilled ? statements.edgeUpsert.get(key) !== undefined : edges.has(key);
    },
    upsertedNodes() { return iterateNodesSync(); },
    upsertedEdges() { return iterateEdgesSync(); },
    async *iterateNodeUpserts({ signal } = {}) {
      try {
        for (const record of iterateNodesSync(signal)) {
          assertOpen(signal);
          yield record;
        }
      } catch (error) {
        if (signal?.aborted || options.signal?.aborted
            || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          await closeStore().catch(() => {});
          rethrowAbort(error, signal);
          rethrowAbort(error, options.signal);
        }
        throw error;
      }
    },
    async *iterateEdgeUpserts({ signal } = {}) {
      try {
        for (const record of iterateEdgesSync(signal)) {
          assertOpen(signal);
          yield record;
        }
      } catch (error) {
        if (signal?.aborted || options.signal?.aborted
            || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          await closeStore().catch(() => {});
          rethrowAbort(error, signal);
          rethrowAbort(error, options.signal);
        }
        throw error;
      }
    },
    get retainedBytes() { return retainedBytes; },
    get spilled() { return spilled; },
    get diskBytes() { return diskActualBytes; },
    get maxDiskBytes() { return maxDiskBytes; },
    close: closeStore,
  };
  return api;
}

async function createEmptyOverlayStore() {
  return createBoundedOverlayStore({ maxMemoryBytes: Number.MAX_SAFE_INTEGER });
}

module.exports = {
  createBoundedOverlayStore,
  createEmptyOverlayStore,
};
