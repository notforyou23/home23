'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const { PGS_OPERATION_LIMITS } = require('../../lib/brain-operation-limits');
const { sourceDescriptorDigest } = require('../../../shared/memory-source/contracts.cjs');
const {
  getOperationScratchQuotaCleanup,
} = require('../../../shared/memory-source/scratch-quota.cjs');

const SCHEMA_VERSION = 1;

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw typed('invalid_request', `${label} is invalid`);
  }
  return value;
}

function exactPair(value, label) {
  exactObject(value, ['provider', 'model'], label);
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model || provider.length > 256 || model.length > 256) {
    throw typed('provider_model_mismatch', `${label} requires provider and model`);
  }
  return Object.freeze({ provider, model });
}

function lowerLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw typed('invalid_request', 'PGS limits must be an object');
  }
  const result = {};
  for (const [key, ceiling] of Object.entries(PGS_OPERATION_LIMITS)) {
    const value = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : ceiling;
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw typed('invalid_request', `Invalid PGS limit: ${key}`);
    }
    result[key] = value;
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(PGS_OPERATION_LIMITS, key)) {
      throw typed('invalid_request', `Unknown PGS limit: ${key}`);
    }
  }
  return Object.freeze(result);
}

function safeScalar(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || Number.isSafeInteger(value);
}

function partitionIdForNode(node, id) {
  const candidate = node.clusterId ?? node.cluster ?? node.partitionId;
  if (safeScalar(candidate) && /^[A-Za-z0-9._-]+$/.test(String(candidate))) {
    return `c-${String(candidate)}`;
  }
  if (safeScalar(candidate)) {
    return `c-x${crypto.createHash('sha256').update(String(candidate)).digest('hex').slice(0, 16)}`;
  }
  const hash = crypto.createHash('sha256').update(String(id)).digest('hex');
  return `h-${Number(BigInt(`0x${hash.slice(0, 16)}`) % 256n)}`;
}

function recordId(record, kind) {
  const value = kind === 'node'
    ? (record.id ?? record.nodeId ?? record.key)
    : null;
  if (!safeScalar(value)) throw typed('source_invalid', `PGS ${kind} record has invalid identity`);
  return String(value);
}

function edgeEndpoint(record, side) {
  const value = side === 'source'
    ? (record.source ?? record.from ?? record.sourceId)
    : (record.target ?? record.to ?? record.targetId);
  if (!safeScalar(value)) throw typed('source_invalid', `PGS edge has invalid ${side}`);
  return String(value);
}

function serializeRecord(record, maxBytes, kind) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw typed('source_invalid', `PGS ${kind} record must be an object`);
  }
  let json;
  try { json = JSON.stringify(record); } catch { json = null; }
  if (typeof json !== 'string') throw typed('source_invalid', `PGS ${kind} record is not serializable`);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) {
    throw typed('result_too_large', `PGS ${kind} record exceeds the byte limit`);
  }
  return { json, bytes };
}

function requireDatabase() {
  try {
    return require('better-sqlite3');
  } catch (error) {
    throw typed('provider_unavailable', `PGS SQLite runtime is unavailable: ${error.message}`, false);
  }
}

async function assertConfinedScratch(scratchDir, scratchQuota) {
  if (!scratchQuota || typeof scratchQuota !== 'object'
      || typeof scratchQuota.reconcile !== 'function'
      || typeof scratchQuota.operationRoot !== 'string') {
    throw typed('invalid_request', 'PGS requires the operation scratch quota');
  }
  const operationRoot = await fsp.realpath(scratchQuota.operationRoot);
  await fsp.mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const scratch = await fsp.realpath(scratchDir);
  const relative = path.relative(operationRoot, scratch);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw typed('invalid_request', 'PGS scratch directory must be beneath the operation root');
  }
  let cursor = operationRoot;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw typed('invalid_request', 'PGS scratch path is not a stable directory');
    }
  }
  return { operationRoot, scratch };
}

async function assertFreeSpace(directory, minimum, statfsImpl) {
  const stat = await statfsImpl(directory);
  const blockSize = Number(stat.bsize || stat.frsize || 0);
  const availableBlocks = Number(stat.bavail ?? stat.blocks ?? 0);
  const free = blockSize * availableBlocks;
  if (!Number.isSafeInteger(free) || free < minimum) {
    throw typed('result_too_large', 'PGS scratch free-space reserve is unavailable');
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      partition_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX nodes_partition ON nodes(partition_id, ordinal);
    CREATE TABLE edges (
      ordinal INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX edges_source ON edges(source);
    CREATE INDEX edges_target ON edges(target);
    CREATE TABLE work_units (
      work_unit_id TEXT PRIMARY KEY,
      partition_id TEXT NOT NULL,
      first_ordinal INTEGER NOT NULL,
      last_ordinal INTEGER NOT NULL,
      node_count INTEGER NOT NULL,
      context_chars INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','complete')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      last_attempt_id TEXT,
      last_attempt_at TEXT,
      last_error_json TEXT
    );
    CREATE TABLE successful_sweeps (
      work_unit_id TEXT PRIMARY KEY,
      partition_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      output_json TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
  `);
}

function metadataObject(db) {
  const result = {};
  for (const row of db.prepare('SELECT key, value FROM metadata').all()) {
    result[row.key] = JSON.parse(row.value);
  }
  return result;
}

function bindingMetadata({ sourceRevision, descriptorDigest, limits, sweepPair }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceRevision,
    descriptorDigest,
    completeProjection: true,
    limits,
    pgsSweepProvider: sweepPair.provider,
    pgsSweepModel: sweepPair.model,
  };
}

function sameBinding(actual, expected) {
  for (const key of [
    'schemaVersion', 'sourceRevision', 'descriptorDigest', 'completeProjection',
    'pgsSweepProvider', 'pgsSweepModel',
  ]) {
    if (actual[key] !== expected[key]) return false;
  }
  return JSON.stringify(actual.limits) === JSON.stringify(expected.limits);
}

async function treeBytes(root) {
  let total = 0;
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw typed('invalid_request', 'PGS scratch contains a symbolic link');
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) total += stat.size;
      else throw typed('invalid_request', 'PGS scratch contains an unsupported entry');
      if (!Number.isSafeInteger(total)) throw typed('result_too_large', 'PGS scratch size overflow');
    }
  }
  await visit(root);
  return total;
}

async function openPinnedPGSStore({
  sourcePin,
  scratchDir,
  scratchQuota,
  pgsSweep,
  signal,
  limits: limitOverrides = {},
  statfsImpl = fsp.statfs,
  clock = { now: () => Date.now() },
} = {}) {
  if (!sourcePin || typeof sourcePin.iterateNodes !== 'function'
      || typeof sourcePin.iterateEdges !== 'function'
      || !sourcePin.descriptor) {
    throw typed('source_pin_required', 'PGS requires a pinned memory source');
  }
  const sourceRevision = sourcePin.revision ?? sourcePin.descriptor.cutoffRevision;
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw typed('source_invalid', 'PGS source revision is invalid');
  }
  const sweepPair = exactPair(pgsSweep, 'pgsSweep');
  const limits = lowerLimits(limitOverrides);
  throwIfAborted(signal);
  const { scratch } = await assertConfinedScratch(scratchDir, scratchQuota);
  await assertFreeSpace(scratch, limits.minFreeScratchBytes, statfsImpl);
  throwIfAborted(signal);

  const descriptorDigest = sourceDescriptorDigest(sourcePin.descriptor);
  const component = `${descriptorDigest}-r${sourceRevision}`;
  const projectionRoot = path.join(scratch, 'pgs', component);
  const databasePath = path.join(projectionRoot, 'projection.sqlite');
  const Database = requireDatabase();
  const expectedBinding = bindingMetadata({ sourceRevision, descriptorDigest, limits, sweepPair });
  const scratchQuotaCleanup = getOperationScratchQuotaCleanup(scratchQuota);
  let db = null;
  let abortListener = null;
  let reused = false;
  let buildStats = { maxTransactionRecords: 0, maxTransactionBytes: 0, maxRetainedRecords: 0 };

  async function closeDb() {
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    abortListener = null;
    if (db?.open) db.close();
    db = null;
  }

  async function removeProjection() {
    await closeDb();
    await fsp.rm(projectionRoot, { recursive: true, force: true });
  }

  async function checkpoint({ cleanup = false } = {}) {
    if (!cleanup) throwIfAborted(signal);
    db.pragma('wal_checkpoint(PASSIVE)');
    await (cleanup ? scratchQuotaCleanup.reconcile() : scratchQuota.reconcile());
    const bytes = await treeBytes(scratch);
    if (bytes > limits.maxScratchBytes) {
      throw typed('result_too_large', 'PGS scratch quota exceeded');
    }
    await assertFreeSpace(scratch, limits.minFreeScratchBytes, statfsImpl);
    if (!cleanup) throwIfAborted(signal);
  }

  try {
    const existingStat = await fsp.lstat(databasePath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existingStat) {
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
        throw typed('invalid_request', 'PGS database is not a regular file');
      }
      db = new Database(databasePath, { fileMustExist: true });
      const actual = metadataObject(db);
      if (sameBinding(actual, expectedBinding)) {
        reused = true;
      } else {
        await removeProjection();
      }
    }

    if (!reused) {
      await fsp.mkdir(projectionRoot, { recursive: true, mode: 0o700 });
      db = new Database(databasePath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('temp_store = MEMORY');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      const pageSize = db.pragma('page_size', { simple: true });
      db.pragma(`max_page_count = ${Math.max(1, Math.floor(limits.maxScratchBytes / pageSize))}`);
      createSchema(db);
      abortListener = () => { try { db?.interrupt(); } catch {} };
      signal?.addEventListener('abort', abortListener, { once: true });

      const insertNode = db.prepare(
        'INSERT INTO nodes(id, partition_id, ordinal, json) VALUES (?, ?, ?, ?)',
      );
      const insertEdge = db.prepare(
        'INSERT INTO edges(ordinal, source, target, json) VALUES (?, ?, ?, ?)',
      );
      const nodeTransaction = db.transaction(rows => {
        for (const row of rows) insertNode.run(row.id, row.partitionId, row.ordinal, row.json);
      });
      const edgeTransaction = db.transaction(rows => {
        for (const row of rows) insertEdge.run(row.ordinal, row.source, row.target, row.json);
      });

      async function streamBatches(iterator, kind, persist) {
        let rows = [];
        let bytes = 0;
        let ordinal = 0;
        async function flush() {
          if (!rows.length) return;
          throwIfAborted(signal);
          persist(rows);
          buildStats.maxTransactionRecords = Math.max(buildStats.maxTransactionRecords, rows.length);
          buildStats.maxTransactionBytes = Math.max(buildStats.maxTransactionBytes, bytes);
          buildStats.maxRetainedRecords = Math.max(buildStats.maxRetainedRecords, rows.length);
          rows = [];
          bytes = 0;
          await checkpoint();
        }
        for await (const record of iterator) {
          throwIfAborted(signal);
          const serialized = serializeRecord(record, limits.maxRecordBytes, kind);
          const row = kind === 'node'
            ? {
              id: recordId(record, kind),
              partitionId: partitionIdForNode(record, recordId(record, kind)),
              ordinal,
              json: serialized.json,
            }
            : {
              ordinal,
              source: edgeEndpoint(record, 'source'),
              target: edgeEndpoint(record, 'target'),
              json: serialized.json,
            };
          const rowBytes = serialized.bytes
            + Buffer.byteLength(kind === 'node' ? row.id + row.partitionId : row.source + row.target);
          if (rows.length && (rows.length >= limits.maxTransactionRecords
              || bytes + rowBytes > limits.maxTransactionBytes)) await flush();
          rows.push(row);
          bytes += rowBytes;
          ordinal += 1;
          if (rows.length >= limits.maxTransactionRecords
              || bytes >= limits.maxTransactionBytes) await flush();
        }
        await flush();
        return ordinal;
      }

      const nodeCount = await streamBatches(
        sourcePin.iterateNodes({ signal }), 'node', rows => nodeTransaction(rows),
      );
      const edgeCount = await streamBatches(
        sourcePin.iterateEdges({ signal }), 'edge', rows => edgeTransaction(rows),
      );

      const insertWorkUnit = db.prepare(`
        INSERT INTO work_units(
          work_unit_id, partition_id, first_ordinal, last_ordinal,
          node_count, context_chars, state
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `);
      const partitions = db.prepare(
        'SELECT DISTINCT partition_id FROM nodes ORDER BY partition_id',
      ).all();
      const workTransaction = db.transaction(rows => {
        for (const row of rows) insertWorkUnit.run(
          row.workUnitId, row.partitionId, row.firstOrdinal, row.lastOrdinal,
          row.nodeCount, row.contextChars,
        );
      });
      for (const partition of partitions) {
        let unit = null;
        let unitIndex = 0;
        let pendingRows = [];
        let lastOrdinal = -1;
        while (true) {
          const page = db.prepare(`
            SELECT ordinal, length(json) AS chars FROM nodes
            WHERE partition_id = ? AND ordinal > ?
            ORDER BY ordinal LIMIT ?
          `).all(partition.partition_id, lastOrdinal, limits.maxTransactionRecords);
          if (!page.length) break;
          for (const node of page) {
            const mustSplit = unit && (unit.nodeCount >= limits.maxNodesPerWorkUnit
              || unit.contextChars + node.chars > limits.maxContextCharsPerWorkUnit);
            if (mustSplit) {
              pendingRows.push(unit);
              unit = null;
            }
            if (!unit) {
              unit = {
                workUnitId: `p-${partition.partition_id}-u${String(unitIndex).padStart(4, '0')}`,
                partitionId: partition.partition_id,
                firstOrdinal: node.ordinal,
                lastOrdinal: node.ordinal,
                nodeCount: 0,
                contextChars: 0,
              };
              unitIndex += 1;
            }
            unit.lastOrdinal = node.ordinal;
            unit.nodeCount += 1;
            unit.contextChars += node.chars;
            lastOrdinal = node.ordinal;
            buildStats.maxRetainedRecords = Math.max(buildStats.maxRetainedRecords, unit.nodeCount);
          }
          if (pendingRows.length) {
            workTransaction(pendingRows);
            pendingRows = [];
            await checkpoint();
          }
        }
        if (unit) pendingRows.push(unit);
        if (pendingRows.length) {
          workTransaction(pendingRows);
          await checkpoint();
        }
      }

      const metadata = {
        ...expectedBinding,
        completeProjection: false,
        nodeCount,
        edgeCount,
      };
      const upsertMetadata = db.prepare(
        'INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)',
      );
      db.transaction(() => {
        for (const [key, value] of Object.entries(metadata)) {
          upsertMetadata.run(key, JSON.stringify(value));
        }
        upsertMetadata.run('completeProjection', JSON.stringify(true));
      })();
      await checkpoint();
    } else {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('temp_store = MEMORY');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      abortListener = () => { try { db?.interrupt(); } catch {} };
      signal?.addEventListener('abort', abortListener, { once: true });
      await checkpoint();
    }
  } catch (error) {
    const cancellation = signal?.aborted ? signal.reason : null;
    await removeProjection().catch(() => {});
    if (cancellation) throw cancellation;
    throw error;
  }

  const attemptSnapshots = new Map();
  let closed = false;
  function assertOpen() {
    if (closed || !db?.open) throw typed('pgs_store_closed', 'PGS store is closed');
  }

  function validateAttemptId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
      throw typed('invalid_request', 'PGS attempt ID is invalid');
    }
    return value;
  }

  const api = {
    sourceRevision,
    descriptorDigest,
    databasePath,
    reused,
    stats: Object.freeze({
      ...buildStats,
      nodeCount: db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count,
      edgeCount: db.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
      workUnitCount: db.prepare('SELECT COUNT(*) AS count FROM work_units').get().count,
    }),
    snapshotPendingWorkUnits({ attemptId, limit = limits.maxSelectedWorkUnits } = {}) {
      assertOpen();
      validateAttemptId(attemptId);
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > limits.maxSelectedWorkUnits) {
        throw typed('invalid_request', 'PGS pending snapshot limit is invalid');
      }
      if (attemptSnapshots.has(attemptId)) return [...attemptSnapshots.get(attemptId)];
      const ids = db.prepare(
        "SELECT work_unit_id FROM work_units WHERE state = 'pending' ORDER BY work_unit_id LIMIT ?",
      ).all(limit).map(row => row.work_unit_id);
      attemptSnapshots.set(attemptId, Object.freeze(ids));
      return [...ids];
    },
    loadWorkUnit(workUnitId, { signal: loadSignal } = {}) {
      assertOpen();
      throwIfAborted(loadSignal);
      const unit = db.prepare('SELECT * FROM work_units WHERE work_unit_id = ?').get(workUnitId);
      if (!unit) throw typed('target_not_found', 'PGS work unit does not exist');
      const nodes = db.prepare(`
        SELECT id, json FROM nodes
        WHERE partition_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal
      `).all(unit.partition_id, unit.first_ordinal, unit.last_ordinal)
        .map(row => JSON.parse(row.json));
      if (nodes.length > limits.maxNodesPerWorkUnit) {
        throw typed('result_too_large', 'PGS work unit exceeds the node limit');
      }
      const nodeIds = new Set(nodes.map(node => String(node.id ?? node.nodeId ?? node.key)));
      const edges = [];
      const seen = new Set();
      const edgeQuery = db.prepare(`
        SELECT ordinal, json FROM edges WHERE source = ? OR target = ? ORDER BY ordinal LIMIT 1000
      `);
      for (const id of nodeIds) {
        throwIfAborted(loadSignal);
        for (const row of edgeQuery.all(id, id)) {
          if (seen.has(row.ordinal)) continue;
          seen.add(row.ordinal);
          edges.push(JSON.parse(row.json));
          if (edges.length >= 8_000) break;
        }
        if (edges.length >= 8_000) break;
      }
      throwIfAborted(loadSignal);
      return {
        workUnitId,
        partitionId: unit.partition_id,
        nodes,
        edges,
        stats: { retainedRecords: nodes.length, contextChars: unit.context_chars },
      };
    },
    beginWorkUnitAttempt(workUnitId, {
      attemptId, provider, model, startedAt = new Date(clock.now()).toISOString(),
    } = {}) {
      assertOpen();
      validateAttemptId(attemptId);
      const snapshot = attemptSnapshots.get(attemptId);
      if (!snapshot?.includes(workUnitId)) {
        throw typed('pgs_state_conflict', 'PGS work unit was not in the attempt snapshot');
      }
      if (provider !== sweepPair.provider || model !== sweepPair.model) {
        throw typed('provider_model_mismatch', 'PGS sweep pair changed');
      }
      const result = db.prepare(`
        UPDATE work_units SET attempt_count = attempt_count + 1,
          last_attempt_id = ?, last_attempt_at = ?
        WHERE work_unit_id = ? AND state = 'pending'
          AND (last_attempt_id IS NULL OR last_attempt_id <> ?)
      `).run(attemptId, startedAt, workUnitId, attemptId);
      if (result.changes !== 1) {
        throw typed('pgs_state_conflict', 'PGS work unit is already claimed or complete');
      }
      return db.prepare('SELECT * FROM work_units WHERE work_unit_id = ?').get(workUnitId);
    },
    async commitSuccessfulSweeps(outputs) {
      assertOpen();
      if (!Array.isArray(outputs)) throw typed('invalid_request', 'PGS sweep outputs must be an array');
      let totalBytes = 0;
      const normalized = outputs.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw typed('invalid_request', 'PGS sweep output is invalid');
        }
        const output = typeof row.output === 'string' ? row.output : '';
        const bytes = Buffer.byteLength(output, 'utf8');
        if (!output || bytes > limits.maxSweepOutputBytes) {
          throw typed('result_too_large', 'PGS sweep output exceeds the byte limit');
        }
        totalBytes += bytes;
        if (totalBytes > limits.maxTotalSweepOutputBytes) {
          throw typed('result_too_large', 'PGS sweep outputs exceed the aggregate byte limit');
        }
        return { ...row, output };
      });
      const getUnit = db.prepare('SELECT * FROM work_units WHERE work_unit_id = ?');
      const getSuccess = db.prepare('SELECT * FROM successful_sweeps WHERE work_unit_id = ?');
      const insert = db.prepare(`
        INSERT INTO successful_sweeps(
          work_unit_id, partition_id, provider, model, output_json, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const completeUnit = db.prepare(`
        UPDATE work_units SET state = 'complete', last_error_json = NULL
        WHERE work_unit_id = ? AND state = 'pending'
      `);
      db.transaction(() => {
        for (const row of normalized) {
          const unit = getUnit.get(row.workUnitId);
          if (!unit) throw typed('pgs_state_conflict', 'Unknown PGS work unit');
          const outputJson = JSON.stringify({ output: row.output });
          const prior = getSuccess.get(row.workUnitId);
          if (prior) {
            if (prior.provider !== sweepPair.provider || prior.model !== sweepPair.model
                || prior.output_json !== outputJson) {
              throw typed('pgs_state_conflict', 'PGS sweep output conflicts with durable state');
            }
            continue;
          }
          if (unit.state !== 'pending') {
            throw typed('pgs_state_conflict', 'PGS work unit is not pending');
          }
          insert.run(
            row.workUnitId, unit.partition_id, sweepPair.provider, sweepPair.model,
            outputJson, row.completedAt || new Date(clock.now()).toISOString(),
          );
          if (completeUnit.run(row.workUnitId).changes !== 1) {
            throw typed('pgs_state_conflict', 'PGS work unit completion raced');
          }
        }
      })();
      // This path is deliberately cleanup-capable: a sibling provider call may
      // have triggered cancellation after useful sweeps completed. Persist the
      // successful retry boundary and reconcile quota without consulting the
      // now-aborted execution signal.
      await checkpoint({ cleanup: true });
    },
    recordRetryableFailure(workUnitId, error) {
      assertOpen();
      const diagnostic = {
        code: String(error?.code || 'provider_failed').slice(0, 128),
        message: String(error?.message || 'PGS sweep failed').slice(0, 4096),
        retryable: true,
      };
      const result = db.prepare(`
        UPDATE work_units SET last_error_json = ?
        WHERE work_unit_id = ? AND state = 'pending'
      `).run(JSON.stringify(diagnostic), workUnitId);
      if (result.changes !== 1) throw typed('pgs_state_conflict', 'PGS work unit is not pending');
    },
    listSuccessfulSweeps() {
      assertOpen();
      return db.prepare(`
        SELECT work_unit_id, partition_id, provider, model, output_json, completed_at
        FROM successful_sweeps ORDER BY work_unit_id
      `).all().map(row => ({
        workUnitId: row.work_unit_id,
        partitionId: row.partition_id,
        provider: row.provider,
        model: row.model,
        output: JSON.parse(row.output_json).output,
        completedAt: row.completed_at,
      }));
    },
    listRetryablePartitions() {
      assertOpen();
      return db.prepare(`
        SELECT DISTINCT partition_id FROM work_units
        WHERE state = 'pending' ORDER BY partition_id
      `).all().map(row => row.partition_id);
    },
    countPendingWorkUnits() {
      assertOpen();
      return db.prepare("SELECT COUNT(*) AS count FROM work_units WHERE state = 'pending'").get().count;
    },
    async reconcile() {
      assertOpen();
      await checkpoint();
    },
    close() {
      if (closed) return;
      closed = true;
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      abortListener = null;
      if (db?.open) db.close();
      db = null;
    },
  };
  return Object.freeze(api);
}

module.exports = {
  lowerLimits,
  openPinnedPGSStore,
  partitionIdForNode,
};
