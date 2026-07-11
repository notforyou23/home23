'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const {
  createOperationScratchQuota,
  getOperationScratchQuotaCleanup,
} = require('./scratch-quota.cjs');
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
const MAX_PENDING_ENTRIES = 1024;
const MAX_DISK_BATCH_ENTRIES = 256;
const DEFAULT_BATCH_BYTES = 1024 * 1024;
const exactEncodedEntries = new WeakMap();
const boundedOverlayStores = new WeakSet();

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

function deepFreezeJson(value) {
  if (value === null || typeof value !== 'object') return value;
  const seen = new Set();
  const stack = [];
  function* ownObjectValues(candidate) {
    for (const key in candidate) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) yield candidate[key];
    }
  }
  function descend(candidate) {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    Object.freeze(candidate);
    stack.push(Array.isArray(candidate)
      ? { array: candidate, index: 0 }
      : { iterator: ownObjectValues(candidate) });
  }
  descend(value);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    let nested;
    if (frame.array) {
      if (frame.index >= frame.array.length) {
        stack.pop();
        continue;
      }
      nested = frame.array[frame.index];
      frame.index += 1;
    } else {
      const next = frame.iterator.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      nested = next.value;
    }
    descend(nested);
  }
  return value;
}

function normalizeEdgeKey(value, maxKeyBytes = DEFAULT_RECORD_BYTES) {
  if (typeof value === 'string') {
    if (!value || Buffer.byteLength(value, 'utf8') > maxKeyBytes) {
      throw memorySourceError('source_unavailable', 'invalid edge key', { retryable: true });
    }
    return value;
  }
  const source = normalizeBoundedId(value?.source ?? value?.from, 'edge source', maxKeyBytes);
  const target = normalizeBoundedId(value?.target ?? value?.to, 'edge target', maxKeyBytes);
  if (!source || !target) {
    throw memorySourceError('source_unavailable', 'invalid edge delta', { retryable: true });
  }
  const key = edgeKeyFor({ source, target });
  if (Buffer.byteLength(key, 'utf8') > maxKeyBytes) {
    throw memorySourceError('source_unavailable', 'invalid edge key', { retryable: true });
  }
  return key;
}

function normalizeBoundedId(value, label, maxKeyBytes = DEFAULT_RECORD_BYTES) {
  const id = normalizeId(value);
  if (!id || Buffer.byteLength(id, 'utf8') > maxKeyBytes) {
    throw memorySourceError('source_unavailable', `invalid ${label}`, { retryable: true });
  }
  return id;
}

function normalizePrivateRecordObject(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw memorySourceError('source_unavailable', `invalid ${label}`, { retryable: true });
  }
  return record;
}

function normalizeNodeRecord(record, maxKeyBytes = DEFAULT_RECORD_BYTES) {
  const privateRecord = normalizePrivateRecordObject(record, 'node delta');
  privateRecord.id = normalizeBoundedId(privateRecord.id, 'node delta', maxKeyBytes);
  return deepFreezeJson(privateRecord);
}

function normalizeEdgeRecord(record, maxKeyBytes = DEFAULT_RECORD_BYTES) {
  const privateRecord = normalizePrivateRecordObject(record, 'edge delta');
  privateRecord.source = normalizeBoundedId(
    privateRecord.source ?? privateRecord.from,
    'edge source',
    maxKeyBytes,
  );
  privateRecord.target = normalizeBoundedId(
    privateRecord.target ?? privateRecord.to,
    'edge target',
    maxKeyBytes,
  );
  return deepFreezeJson(privateRecord);
}

function sortedKeys(mapOrSet) {
  // In-memory overlay retention is hard-capped (8 MiB by default), so this
  // compatibility array is bounded. Spill/import itself never allocates a
  // second sorted key array, and new readers use the async iterators below.
  return [...mapOrSet.keys()].sort((left, right) => left.localeCompare(right));
}

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(stat, identity) {
  return Boolean(stat && identity && stat.dev === identity.dev && stat.ino === identity.ino);
}

async function lstatOptional(filePath) {
  return fsp.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function createBoundedOverlayStore(options = {}) {
  const maxMemoryBytes = boundedLimit(options.maxMemoryBytes, DEFAULT_MEMORY_BYTES, { allowZero: true });
  const maxDiskBytes = boundedLimit(options.maxDiskBytes, DEFAULT_DISK_BYTES);
  const maxRecordBytes = boundedLimit(options.maxRecordBytes, DEFAULT_RECORD_BYTES);
  const maxAggregateBatchBytes = Math.min(maxRecordBytes, DEFAULT_BATCH_BYTES);
  const maxDiskBatchEntries = Math.max(1, Math.min(
    MAX_DISK_BATCH_ENTRIES,
    Math.floor((maxDiskBytes - 1) / SQLITE_MUTATION_HEADROOM),
  ));
  const nodes = new Map();
  const edges = new Map();
  const removedNodes = new Set();
  const removedEdges = new Set();
  let retainedBytes = 0;
  let closed = false;
  let spilled = false;
  let db = null;
  let databaseAnchor = null;
  let statements = null;
  let diskActualBytes = 0;
  let diskReservedBytes = 0;
  let operationRoot = null;
  let operationRootIdentity = null;
  let overlayRoot = null;
  let overlayRootIdentity = null;
  let databasePath = null;
  let databaseIdentity = null;
  let cleanupFilesComplete = false;
  let cleanupComplete = false;
  let diskReservationSettlementStates = [];
  let mutationTail = Promise.resolve();
  let pendingAdmissionBytes = 0;
  let pendingAdmissionEntries = 0;
  let scratchQuota = options.scratchQuota || null;
  let scratchQuotaCleanup = null;
  let ownsScratchQuota = false;
  const quotaKind = `memory_overlay_${randomUUID()}`;
  const privateDirectoryName = `.memory-overlay-${process.pid}-${randomUUID()}`;
  const ownedArtifacts = new Map();
  const hooks = options._testHooks || {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || Object.values(hooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid overlay test hooks');
  }

  if (options.operationRoot) {
    if (scratchQuota) {
      if (await scratchQuota.assertOperationRoot(options.operationRoot) !== true) {
        throw memorySourceError('source_operation_required', 'exact operation scratch quota required');
      }
      operationRoot = scratchQuota.operationRoot;
    } else {
      scratchQuota = await createOperationScratchQuota({
        operationRoot: options.operationRoot,
        signal: options.signal,
      });
      ownsScratchQuota = true;
      operationRoot = scratchQuota.operationRoot;
    }
    scratchQuotaCleanup = getOperationScratchQuotaCleanup(scratchQuota);
    const rootStat = await fsp.lstat(operationRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw memorySourceError('invalid_memory_source', 'operation root is not a private directory', {
        retryable: false,
      });
    }
    operationRootIdentity = identityOf(rootStat);
    overlayRoot = path.join(operationRoot, privateDirectoryName);
    databasePath = path.join(overlayRoot, 'overlay.sqlite');
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

  function admitEntry(entry) {
    const encoded = jsonBytes(entry, 'delta record');
    if (encoded.bytes > maxRecordBytes) throw limitError('overlay record limit exceeded');
    if (pendingAdmissionEntries >= MAX_PENDING_ENTRIES) {
      throw limitError('overlay pending entry limit exceeded');
    }
    const projected = pendingAdmissionBytes + encoded.bytes;
    if (!Number.isSafeInteger(projected) || projected > maxRecordBytes) {
      throw limitError('overlay pending admission limit exceeded');
    }
    pendingAdmissionBytes = projected;
    pendingAdmissionEntries += 1;
    return encoded;
  }

  function normalizeEntry(encoded) {
    // Parse the bounded serialization so Maps/SQLite never retain caller-owned
    // nested objects. Parsing happens only after aggregate serialized admission
    // joins the mutation queue, so concurrent callers cannot retain an
    // unbounded number of detached graphs while an earlier mutation is slow.
    const detached = JSON.parse(encoded.text);
    if (detached?.op === 'upsert_node') {
      const record = normalizeNodeRecord(detached.record, maxRecordBytes);
      return { kind: 'node', key: record.id, record, tombstone: false };
    }
    if (detached?.op === 'remove_node') {
      const key = normalizeBoundedId(detached.id, 'node tombstone', maxRecordBytes);
      return { kind: 'node', key, record: undefined, tombstone: true };
    }
    if (detached?.op === 'upsert_edge') {
      const record = normalizeEdgeRecord(detached.record, maxRecordBytes);
      return {
        kind: 'edge',
        key: normalizeEdgeKey(record, maxRecordBytes),
        record,
        tombstone: false,
      };
    }
    if (detached?.op === 'remove_edge') {
      const candidate = detached.key ?? detached.record ?? detached;
      return {
        kind: 'edge',
        key: normalizeEdgeKey(candidate, maxRecordBytes),
        record: undefined,
        tombstone: true,
      };
    }
    throw memorySourceError('source_unavailable', 'unknown delta operation', { retryable: true });
  }

  function admitBatch(entries) {
    if (!Array.isArray(entries)) {
      throw memorySourceError('invalid_request', 'overlay batch must be an array');
    }
    if (entries.length === 0) {
      throw memorySourceError('invalid_request', 'overlay batch must not be empty');
    }
    if (entries.length > MAX_DISK_BATCH_ENTRIES) {
      throw limitError('overlay batch entry limit exceeded');
    }
    const encodedBatches = [];
    let encodedEntries = [];
    let batchBytes = 0;
    let serializedBytes = 0;
    function flushEncodedBatch() {
      if (encodedEntries.length === 0) return;
      encodedBatches.push(Object.freeze({
        encodedEntries: Object.freeze(encodedEntries),
        serializedBytes: batchBytes,
      }));
      encodedEntries = [];
      batchBytes = 0;
    }
    for (const entry of entries) {
      const exactEncoded = entry !== null
          && (typeof entry === 'object' || typeof entry === 'function')
        ? exactEncodedEntries.get(entry)
        : undefined;
      const encoded = exactEncoded || Object.freeze(jsonBytes(entry, 'delta record'));
      if (encoded.bytes > maxRecordBytes) throw limitError('overlay record limit exceeded');
      serializedBytes += encoded.bytes;
      if (!Number.isSafeInteger(serializedBytes) || serializedBytes > maxRecordBytes) {
        throw limitError('overlay batch admission limit exceeded');
      }
      if (encodedEntries.length > 0
          && (encodedEntries.length >= maxDiskBatchEntries
            || batchBytes + encoded.bytes > maxAggregateBatchBytes)) {
        flushEncodedBatch();
      }
      encodedEntries.push(encoded);
      batchBytes += encoded.bytes;
      if (encodedEntries.length >= maxDiskBatchEntries
          || batchBytes >= maxAggregateBatchBytes) {
        flushEncodedBatch();
      }
    }
    flushEncodedBatch();
    const projectedEntries = pendingAdmissionEntries + entries.length;
    const projectedBytes = pendingAdmissionBytes + serializedBytes;
    if (!Number.isSafeInteger(projectedEntries) || projectedEntries > MAX_PENDING_ENTRIES) {
      throw limitError('overlay pending entry limit exceeded');
    }
    if (!Number.isSafeInteger(projectedBytes) || projectedBytes > maxRecordBytes) {
      throw limitError('overlay pending admission limit exceeded');
    }
    pendingAdmissionEntries = projectedEntries;
    pendingAdmissionBytes = projectedBytes;
    return Object.freeze({
      encodedBatches: Object.freeze(encodedBatches),
      entryCount: entries.length,
      serializedBytes,
    });
  }

  function checkCancelled(signal) {
    assertOpen(signal);
  }

  function confinementError(message, cause) {
    return memorySourceError('invalid_memory_source', message, {
      retryable: false,
      ...(cause ? { cause } : {}),
    });
  }

  function artifactPaths() {
    return [
      databasePath,
      `${databasePath}-journal`,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ];
  }

  async function assertOperationRootStable({ cleanup = false } = {}) {
    if (!operationRoot) return;
    const quota = cleanup ? scratchQuotaCleanup : scratchQuota;
    await quota.assertOperationRoot(operationRoot);
    const stat = await fsp.lstat(operationRoot).catch((error) => {
      throw confinementError('operation root became unavailable', error);
    });
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || !sameIdentity(stat, operationRootIdentity)) {
      throw confinementError('operation root identity changed');
    }
  }

  async function assertOverlayRootStable({ cleanup = false } = {}) {
    await assertOperationRootStable({ cleanup });
    if (!overlayRootIdentity) throw confinementError('overlay directory is not owned');
    const stat = await fsp.lstat(overlayRoot).catch((error) => {
      throw confinementError('overlay directory became unavailable', error);
    });
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || !sameIdentity(stat, overlayRootIdentity)) {
      throw confinementError('overlay directory identity changed');
    }
    const canonical = await fsp.realpath(overlayRoot).catch((error) => {
      throw confinementError('overlay directory cannot be resolved', error);
    });
    if (canonical !== overlayRoot || path.dirname(canonical) !== operationRoot) {
      throw confinementError('overlay directory escapes operation scratch');
    }
    await assertOperationRootStable({ cleanup });
  }

  async function assertDatabaseStable() {
    await assertOverlayRootStable();
    if (!databaseIdentity || !databaseAnchor) {
      throw confinementError('overlay database is not owned');
    }
    const [pathStat, anchorStat] = await Promise.all([
      fsp.lstat(databasePath).catch((error) => {
        throw confinementError('overlay database became unavailable', error);
      }),
      databaseAnchor.stat().catch((error) => {
        throw confinementError('overlay database anchor became unavailable', error);
      }),
    ]);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !anchorStat.isFile()
        || !sameIdentity(pathStat, databaseIdentity)
        || !sameIdentity(anchorStat, databaseIdentity)) {
      throw confinementError('overlay database identity changed');
    }
    await assertOverlayRootStable();
  }

  async function inspectArtifacts({ adoptNew = false } = {}) {
    await assertDatabaseStable();
    let total = 0;
    for (const filePath of artifactPaths()) {
      const stat = await lstatOptional(filePath);
      if (stat === null) {
        if (filePath === databasePath) throw confinementError('overlay database disappeared');
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw confinementError('overlay database artifact is not a regular file');
      }
      const owned = ownedArtifacts.get(filePath);
      if (owned && !sameIdentity(stat, owned)) {
        throw confinementError('overlay database artifact identity changed');
      }
      if (!owned) {
        if (!adoptNew) throw confinementError('unexpected overlay database artifact');
        ownedArtifacts.set(filePath, identityOf(stat));
      }
      total += stat.size;
      if (!Number.isSafeInteger(total)) throw limitError('overlay disk accounting overflow');
    }
    await assertDatabaseStable();
    return total;
  }

  async function reserveDiskMutation(
    logicalBytes,
    rollbackBytes = 0,
    mutationHeadroomBytes = SQLITE_MUTATION_HEADROOM,
    signal,
  ) {
    checkCancelled(signal);
    const allowance = logicalBytes + rollbackBytes + mutationHeadroomBytes;
    const required = diskActualBytes + allowance;
    if (!Number.isSafeInteger(allowance) || !Number.isSafeInteger(required)
        || required > maxDiskBytes) {
      throw limitError('overlay disk limit exceeded');
    }
    const preflightBytes = allowance * 2;
    if (!Number.isSafeInteger(preflightBytes)) throw limitError('overlay reservation overflow');
    // A reservation and bytes that materialize under it are deliberately
    // additive in the aggregate ledger. Preflight twice the maximum growth,
    // then release half before mutation: at every point, including a crash
    // between SQLite growth and settlement, actual + outstanding reservation
    // remains below the already-proven peak.
    const priorReservedBytes = diskReservedBytes;
    const preflightReservedBytes = priorReservedBytes + preflightBytes;
    if (!Number.isSafeInteger(preflightReservedBytes)) {
      throw limitError('overlay reservation overflow');
    }
    // Record both possible durable states before each ledger transition. If a
    // publish succeeds and its later fsync/reporting step throws, cleanup can
    // remove only one of these exact store-owned values.
    diskReservationSettlementStates = [priorReservedBytes, preflightReservedBytes];
    diskReservedBytes = preflightReservedBytes;
    await scratchQuota.claim(preflightBytes, quotaKind);
    diskReservationSettlementStates = [preflightReservedBytes];
    const mutationReservedBytes = preflightReservedBytes - allowance;
    diskReservationSettlementStates = [preflightReservedBytes, mutationReservedBytes];
    await scratchQuota.release(allowance, quotaKind);
    diskReservedBytes = mutationReservedBytes;
    diskReservationSettlementStates = [mutationReservedBytes];
    checkCancelled(signal);
    return allowance;
  }

  async function settleDiskReservation(bytes) {
    if (bytes <= 0) return;
    const priorReservedBytes = diskReservedBytes;
    const settledReservedBytes = priorReservedBytes - bytes;
    if (!Number.isSafeInteger(settledReservedBytes) || settledReservedBytes < 0) {
      throw limitError('overlay reservation settlement overflow');
    }
    diskReservationSettlementStates = [priorReservedBytes, settledReservedBytes];
    await scratchQuota.release(bytes, quotaKind);
    diskReservedBytes = settledReservedBytes;
    diskReservationSettlementStates = settledReservedBytes > 0
      ? [settledReservedBytes]
      : [];
  }

  async function refreshDiskAccounting({ priorActual, allowance }) {
    const actual = await inspectArtifacts({ adoptNew: true });
    if (actual > maxDiskBytes || actual > priorActual + allowance) {
      throw limitError('overlay database exceeded reserved disk growth');
    }
    diskActualBytes = actual;
  }

  async function createPrivateOverlayDirectory() {
    await assertOperationRootStable();
    const existing = await lstatOptional(overlayRoot);
    if (existing !== null) throw confinementError('overlay private directory already exists');
    await fsp.mkdir(overlayRoot, { mode: 0o700 });
    await assertOperationRootStable();
    const stat = await fsp.lstat(overlayRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw confinementError('overlay root is not a private directory');
    }
    overlayRootIdentity = identityOf(stat);
    const canonical = await fsp.realpath(overlayRoot);
    if (canonical !== overlayRoot || path.dirname(canonical) !== operationRoot) {
      throw confinementError('overlay root escapes operation scratch');
    }
    await hooks.afterPrivateDirectoryCreate?.({ operationRoot, overlayRoot });
    await assertOverlayRootStable();
  }

  function prepareStatements() {
    const prepared = {
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
    };
    prepared.mutateBatch = db.transaction((normalizedEntries, signal) => {
      for (let index = 0; index < normalizedEntries.length; index += 1) {
        const normalized = normalizedEntries[index];
        checkCancelled(signal);
        const recordJson = normalized.record === undefined
          ? null
          : jsonBytes(normalized.record).text;
        if (normalized.kind === 'node') {
          if (normalized.tombstone) prepared.removeNode.run(normalized.key);
          else prepared.upsertNode.run(normalized.key, recordJson);
        } else if (normalized.tombstone) {
          prepared.removeEdge.run(normalized.key);
        } else {
          prepared.upsertEdge.run(
            normalized.key,
            normalized.record.source,
            normalized.record.target,
            recordJson,
          );
        }
        const hookResult = hooks.afterDiskStatement?.({ normalized, index });
        if (hookResult && typeof hookResult.then === 'function') {
          throw memorySourceError(
            'invalid_request',
            'afterDiskStatement test hook must be synchronous',
          );
        }
        checkCancelled(signal);
      }
    });
    statements = Object.freeze(prepared);
  }

  function diskBatchGrowth(normalizedEntries) {
    let logicalBytes = 0;
    let rollbackBytes = 0;
    const priorKeys = new Set();
    for (const normalized of normalizedEntries) {
      const entryBytes = retainedEntryBytes(normalized.key, normalized.record);
      logicalBytes += entryBytes;
      if (!Number.isSafeInteger(logicalBytes)) {
        throw limitError('overlay batch accounting overflow');
      }
      const priorKey = `${normalized.kind}\0${normalized.key}`;
      if (priorKeys.has(priorKey)) continue;
      priorKeys.add(priorKey);
      const prior = normalized.kind === 'node'
        ? statements.nodeStoredBytes.get(normalized.key)
        : statements.edgeStoredBytes.get(normalized.key);
      rollbackBytes += Number(prior?.bytes || 0);
      if (!Number.isSafeInteger(rollbackBytes)) {
        throw limitError('overlay batch accounting overflow');
      }
    }
    const mutationHeadroomBytes = priorKeys.size * SQLITE_MUTATION_HEADROOM;
    if (!Number.isSafeInteger(mutationHeadroomBytes)) {
      throw limitError('overlay batch reservation overflow');
    }
    return { logicalBytes, rollbackBytes, mutationHeadroomBytes };
  }

  function projectedDiskRequirement(normalizedEntries) {
    const growth = diskBatchGrowth(normalizedEntries);
    const allowance = growth.logicalBytes + growth.rollbackBytes + growth.mutationHeadroomBytes;
    const required = diskActualBytes + allowance;
    return {
      growth,
      allowance,
      required,
      fits: Number.isSafeInteger(allowance)
        && Number.isSafeInteger(required)
        && required <= maxDiskBytes,
    };
  }

  async function writeDiskBatch(normalizedEntries, { signal, serializedBytes } = {}) {
    if (normalizedEntries.length === 0) return;
    checkCancelled(signal);
    await inspectArtifacts();
    const projection = projectedDiskRequirement(normalizedEntries);
    if (!projection.fits && normalizedEntries.length > 1) {
      let low = 1;
      let high = normalizedEntries.length - 1;
      let fittingPrefix = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (projectedDiskRequirement(normalizedEntries.slice(0, middle)).fits) {
          fittingPrefix = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (fittingPrefix > 0) {
        await writeDiskBatch(normalizedEntries.slice(0, fittingPrefix), { signal });
        await writeDiskBatch(normalizedEntries.slice(fittingPrefix), { signal });
        return;
      }
    }
    const { growth } = projection;
    const priorActual = diskActualBytes;
    const allowance = await reserveDiskMutation(
      growth.logicalBytes,
      growth.rollbackBytes,
      growth.mutationHeadroomBytes,
      signal,
    );
    if (hooks.beforeDiskMutation) {
      for (const normalized of normalizedEntries) {
        checkCancelled(signal);
        await hooks.beforeDiskMutation({ overlayRoot, databasePath, normalized });
        await inspectArtifacts();
        checkCancelled(signal);
      }
    } else {
      for (const _normalized of normalizedEntries) checkCancelled(signal);
    }
    await inspectArtifacts();
    checkCancelled(signal);
    try {
      statements.mutateBatch(normalizedEntries, signal);
    } catch (error) {
      await hooks.afterDiskRollback?.({
        overlayRoot,
        databasePath,
        normalizedEntries,
        error,
      });
      await inspectArtifacts();
      throw error;
    }
    await hooks.afterDiskCommit?.({
      overlayRoot,
      databasePath,
      normalizedEntries,
      entryCount: normalizedEntries.length,
    });
    await inspectArtifacts();
    checkCancelled(signal);
    await refreshDiskAccounting({ priorActual, allowance });
    await settleDiskReservation(allowance);
    await assertDatabaseStable();
    await hooks.afterDiskTransaction?.({
      overlayRoot,
      databasePath,
      entryCount: normalizedEntries.length,
      serializedBytes: serializedBytes ?? growth.logicalBytes,
    });
    await assertDatabaseStable();
    checkCancelled(signal);
  }

  async function writeDiskState(normalized) {
    await writeDiskBatch([normalized]);
  }

  async function writeDiskSequence(normalizedEntries, { signal } = {}) {
    let batch = [];
    let batchBytes = 0;
    async function flush() {
      if (batch.length === 0) return;
      const current = batch;
      const currentBytes = batchBytes;
      batch = [];
      batchBytes = 0;
      await writeDiskBatch(current, { signal, serializedBytes: currentBytes });
    }
    for (const normalized of normalizedEntries) {
      checkCancelled(signal);
      const entryBytes = retainedEntryBytes(normalized.key, normalized.record);
      if (batch.length > 0 && batchBytes + entryBytes > maxAggregateBatchBytes) await flush();
      batch.push(normalized);
      batchBytes += entryBytes;
      if (!Number.isSafeInteger(batchBytes)) throw limitError('overlay batch accounting overflow');
      if (batch.length >= maxDiskBatchEntries || batchBytes >= maxAggregateBatchBytes) await flush();
    }
    await flush();
  }

  async function spillMemoryState({ signal } = {}) {
    if (spilled) return;
    checkCancelled(signal);
    await createPrivateOverlayDirectory();
    checkCancelled(signal);
    const priorActual = diskActualBytes;
    const allowance = await reserveDiskMutation(
      0,
      0,
      SQLITE_MUTATION_HEADROOM,
      signal,
    );
    await hooks.beforeDatabaseCreate?.({ operationRoot, overlayRoot, databasePath });
    await assertOverlayRootStable();
    checkCancelled(signal);
    try {
      databaseAnchor = await fsp.open(
        databasePath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ELOOP') {
        throw confinementError('overlay database basename is already occupied', error);
      }
      throw error;
    }
    const opened = await databaseAnchor.stat();
    if (!opened.isFile()) throw confinementError('overlay database is not a regular file');
    databaseIdentity = identityOf(opened);
    ownedArtifacts.set(databasePath, databaseIdentity);
    await databaseAnchor.sync();
    await hooks.beforeDatabaseOpen?.({ operationRoot, overlayRoot, databasePath });
    await assertDatabaseStable();
    checkCancelled(signal);
    db = new Database(databasePath, { fileMustExist: true });
    await assertDatabaseStable();
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
    await refreshDiskAccounting({ priorActual, allowance });
    await settleDiskReservation(allowance);
    await assertDatabaseStable();

    function* retainedEntries() {
      for (const [key, record] of nodes) {
        yield { kind: 'node', key, record, tombstone: false };
      }
      for (const key of removedNodes) {
        yield { kind: 'node', key, record: undefined, tombstone: true };
      }
      for (const [key, record] of edges) {
        yield { kind: 'edge', key, record, tombstone: false };
      }
      for (const key of removedEdges) {
        yield { kind: 'edge', key, record: undefined, tombstone: true };
      }
    }
    await writeDiskSequence(retainedEntries(), { signal });
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
    const record = edges.get(normalizeEdgeKey(value, maxRecordBytes));
    if (!record || removedNodes.has(record.source) || removedNodes.has(record.target)) return undefined;
    return record;
  }

  function parseStoredRecord(row) {
    return row?.record == null ? undefined : deepFreezeJson(JSON.parse(row.record));
  }

  function diskNode(id) {
    return parseStoredRecord(statements.node.get(normalizeId(id)));
  }

  function diskNodeRemoved(id) {
    return statements.removedNode.get(normalizeId(id)) !== undefined;
  }

  function diskEdge(value) {
    const row = statements.edge.get(normalizeEdgeKey(value, maxRecordBytes));
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

  async function removeExactOwnedArtifacts() {
    if (cleanupFilesComplete) return;
    if (!overlayRootIdentity) {
      cleanupFilesComplete = true;
      return;
    }
    await assertOverlayRootStable({ cleanup: true });
    const expectedNames = new Set(artifactPaths().map((filePath) => path.basename(filePath)));
    const entries = await fsp.readdir(overlayRoot);
    await assertOverlayRootStable({ cleanup: true });
    for (const name of entries.sort((left, right) => left.localeCompare(right))) {
      if (!expectedNames.has(name)) {
        throw confinementError('overlay directory contains an unowned artifact');
      }
      const filePath = path.join(overlayRoot, name);
      const identity = ownedArtifacts.get(filePath);
      const stat = await fsp.lstat(filePath);
      if (!identity || stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(stat, identity)) {
        throw confinementError('overlay cleanup artifact identity changed');
      }
      await hooks.beforeArtifactRemove?.({ operationRoot, overlayRoot, filePath });
      await assertOverlayRootStable({ cleanup: true });
      const latest = await fsp.lstat(filePath);
      if (latest.isSymbolicLink() || !latest.isFile() || !sameIdentity(latest, identity)) {
        throw confinementError('overlay cleanup artifact changed before removal');
      }
      await fsp.unlink(filePath);
      ownedArtifacts.delete(filePath);
      await assertOverlayRootStable({ cleanup: true });
    }
    if ((await fsp.readdir(overlayRoot)).length !== 0) {
      throw confinementError('overlay directory changed during cleanup');
    }
    await assertOverlayRootStable({ cleanup: true });
    await fsp.rmdir(overlayRoot);
    await assertOperationRootStable({ cleanup: true });
    cleanupFilesComplete = true;
  }

  async function cleanupStore() {
    if (cleanupComplete) return;
    if (db?.open) db.close();
    db = null;
    statements = null;
    if (databaseAnchor) await databaseAnchor.close();
    databaseAnchor = null;

    await removeExactOwnedArtifacts();
    if (scratchQuota) {
      const settlementStates = [...new Set([
        ...diskReservationSettlementStates,
        diskReservedBytes,
      ])];
      if (settlementStates.some((bytes) => bytes > 0)) {
        await scratchQuotaCleanup.settleExpected(settlementStates, quotaKind);
        diskReservedBytes = 0;
        diskReservationSettlementStates = [];
      } else {
        await scratchQuotaCleanup.reconcile();
      }
    }
    diskActualBytes = 0;
    nodes.clear();
    edges.clear();
    removedNodes.clear();
    removedEdges.clear();
    retainedBytes = 0;
    if (ownsScratchQuota) scratchQuota.close();
    cleanupComplete = true;
  }

  let closePromise = null;
  function closeStore() {
    closed = true;
    if (cleanupComplete) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        await mutationTail;
        await cleanupStore();
      } finally {
        closePromise = null;
      }
    })();
    return closePromise;
  }

  function enqueueMutation(work) {
    const result = mutationTail.then(work);
    mutationTail = result.catch(() => {});
    return result;
  }

  async function failMutation(error, signal) {
    closed = true;
    if (db && databaseAnchor) {
      await inspectArtifacts({ adoptNew: true }).catch(() => {});
    }
    await cleanupStore().catch(() => {});
    rethrowAbort(error, signal);
    rethrowAbort(error, options.signal);
    throw error;
  }

  async function applyNormalizedBatch(normalizedEntries, { signal, serializedBytes } = {}) {
    checkCancelled(signal);
    if (spilled) {
      await writeDiskBatch(normalizedEntries, { signal, serializedBytes });
      return;
    }
    let diskStart = normalizedEntries.length;
    for (let index = 0; index < normalizedEntries.length; index += 1) {
      checkCancelled(signal);
      if (!applyMemory(normalizedEntries[index])) {
        diskStart = index;
        break;
      }
    }
    if (diskStart === normalizedEntries.length) return;
    if (!options.operationRoot) {
      throw memorySourceError('source_operation_required', 'operation root required for large overlay', {
        retryable: false,
      });
    }
    await spillMemoryState({ signal });
    await writeDiskBatch(normalizedEntries.slice(diskStart), { signal });
  }

  async function applyAdmitted(encoded) {
    try {
      return await enqueueMutation(async () => {
        assertOpen();
        const normalized = normalizeEntry(encoded);
        if (spilled) {
          try {
            await writeDiskState(normalized);
            return;
          } catch (error) {
            return failMutation(error);
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
          return failMutation(error);
        }
      });
    } finally {
      pendingAdmissionBytes -= encoded.bytes;
      pendingAdmissionEntries -= 1;
    }
  }

  function applyEntry(entry) {
    try {
      assertOpen();
      // The caller-owned graph is not captured by an async frame or mutation
      // closure. Only its bounded serialized form crosses this synchronous
      // admission boundary.
      return applyAdmitted(admitEntry(entry));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function applyAdmittedBatch(admitted, signal) {
    try {
      return await enqueueMutation(async () => {
        try {
          assertOpen(signal);
        } catch (error) {
          return failMutation(error, signal);
        }
        let appliedBatches = 0;
        for (const encodedBatch of admitted.encodedBatches) {
          let normalizedEntries;
          try {
            normalizedEntries = encodedBatch.encodedEntries.map(normalizeEntry);
          } catch (error) {
            if (appliedBatches === 0) throw error;
            return failMutation(error, signal);
          }
          try {
            await applyNormalizedBatch(normalizedEntries, {
              signal,
              serializedBytes: encodedBatch.serializedBytes,
            });
            appliedBatches += 1;
          } catch (error) {
            return failMutation(error, signal);
          }
        }
      });
    } finally {
      pendingAdmissionEntries -= admitted.entryCount;
      pendingAdmissionBytes -= admitted.serializedBytes;
    }
  }

  function applyBatch(entries, { signal } = {}) {
    try {
      assertOpen(signal);
      // Detach the complete bounded array before it can be retained by the
      // mutation queue. Caller mutation after this synchronous boundary cannot
      // alter queued work or expand its admitted memory.
      return applyAdmittedBatch(admitBatch(entries), signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const api = {
    apply: applyEntry,
    applyBatch,
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
      const key = normalizeEdgeKey(value, maxRecordBytes);
      return spilled ? statements.removedEdge.get(key) !== undefined : removedEdges.has(key);
    },
    hasNodeUpsert(id) {
      assertOpen();
      const key = normalizeId(id);
      return spilled ? statements.nodeUpsert.get(key) !== undefined : nodes.has(key);
    },
    hasEdgeUpsert(value) {
      assertOpen();
      const key = normalizeEdgeKey(value, maxRecordBytes);
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
  Object.defineProperties(api, {
    maxBatchEntries: {
      enumerable: true,
      configurable: false,
      get() { return maxDiskBatchEntries; },
    },
    maxBatchBytes: {
      enumerable: true,
      configurable: false,
      get() { return maxAggregateBatchBytes; },
    },
    maxRecordBytes: {
      enumerable: true,
      configurable: false,
      get() { return maxRecordBytes; },
    },
  });
  boundedOverlayStores.add(api);
  return api;
}

async function createEmptyOverlayStore() {
  return createBoundedOverlayStore({ maxMemoryBytes: Number.MAX_SAFE_INTEGER });
}

async function applyOverlayEntriesInBatches(overlay, entries, { signal } = {}) {
  const isAsyncIterable = typeof entries?.[Symbol.asyncIterator] === 'function';
  const maxRecordBytes = Number.isSafeInteger(overlay?.maxRecordBytes)
    ? overlay.maxRecordBytes
    : overlay?.maxBatchBytes;
  if (!overlay || typeof overlay.applyBatch !== 'function'
      || !Number.isSafeInteger(overlay.maxBatchEntries) || overlay.maxBatchEntries < 1
      || !Number.isSafeInteger(overlay.maxBatchBytes) || overlay.maxBatchBytes < 1
      || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < overlay.maxBatchBytes
      || !isAsyncIterable) {
    throw memorySourceError('invalid_request', 'bounded async overlay batch stream required');
  }
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    batchBytes = 0;
    await overlay.applyBatch(current, { signal });
  };
  for await (const entry of entries) {
    throwIfAborted(signal);
    const encoded = jsonBytes(entry, 'delta record');
    const entryBytes = encoded.bytes;
    if (entryBytes > maxRecordBytes) {
      throw limitError('overlay record limit exceeded');
    }
    const projectedBytes = batchBytes + entryBytes;
    if (!Number.isSafeInteger(projectedBytes)) {
      throw limitError('overlay batch accounting overflow');
    }
    if (batch.length > 0
        && (batch.length >= overlay.maxBatchEntries
          || projectedBytes > overlay.maxBatchBytes)) {
      await flush();
    }
    // Keep only the exact bounded JSON measured above. This prevents hidden
    // caller-owned graphs or stateful toJSON/getters from crossing the async
    // batch boundary or changing between measurement and admission.
    if (boundedOverlayStores.has(overlay)) {
      const wrapper = Object.freeze({});
      exactEncodedEntries.set(wrapper, Object.freeze(encoded));
      batch.push(wrapper);
    } else {
      batch.push(JSON.parse(encoded.text));
    }
    batchBytes += entryBytes;
    if (batch.length >= overlay.maxBatchEntries || batchBytes >= overlay.maxBatchBytes) {
      await flush();
    }
  }
  await flush();
}

module.exports = {
  applyOverlayEntriesInBatches,
  createBoundedOverlayStore,
  createEmptyOverlayStore,
};
