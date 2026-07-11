'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const { PGS_OPERATION_LIMITS } = require('../../lib/brain-operation-limits');
const {
  canonicalJson,
  sourceDescriptorDigest,
} = require('../../../shared/memory-source/contracts.cjs');
const {
  getOperationScratchQuotaCleanup,
} = require('../../../shared/memory-source/scratch-quota.cjs');

const SCHEMA_VERSION = 1;
const MAX_METADATA_VALUE_BYTES = 128 * 1024;
const MAX_LIST_SCALAR_BYTES = 4 * 1024;
const METADATA_KEYS = Object.freeze([
  'completeProjection',
  'descriptorDigest',
  'edgeCount',
  'limits',
  'nodeCount',
  'pgsSweepModel',
  'pgsSweepProvider',
  'schemaVersion',
  'sourceRevision',
]);

function typed(code, message, retryable = false, details = {}) {
  return Object.assign(new Error(message), { code, retryable, ...details });
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

function pathBoundaryError(message, cause) {
  const error = typed('invalid_request', message);
  if (cause) error.cause = cause;
  return error;
}

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(stat, expected) {
  return Boolean(stat && expected && stat.dev === expected.dev && stat.ino === expected.ino);
}

function assertNoFollowSupport() {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)
      || !Number.isInteger(fs.constants.O_DIRECTORY)) {
    throw pathBoundaryError('PGS requires no-follow filesystem operations');
  }
}

async function lstatOptional(filePath) {
  return fsp.lstat(filePath, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function captureExactDirectory(directoryPath) {
  let fd = null;
  try {
    const [stat, canonical] = await Promise.all([
      fsp.lstat(directoryPath, { bigint: true }),
      fsp.realpath(directoryPath),
    ]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directoryPath) {
      throw pathBoundaryError('PGS scratch child is not an exact nonsymlink directory');
    }
    fd = fs.openSync(
      directoryPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameIdentity(opened, identityOf(stat))) {
      throw pathBoundaryError('PGS scratch child changed while opening');
    }
    return { path: directoryPath, identity: identityOf(stat), fd };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error?.code === 'invalid_request') throw error;
    throw pathBoundaryError('PGS scratch child cannot be opened safely', error);
  }
}

function verifyScratchBoundarySync(boundary) {
  for (const capture of boundary.directories) {
    let stat;
    let opened;
    let canonical;
    try {
      stat = fs.lstatSync(capture.path, { bigint: true });
      opened = fs.fstatSync(capture.fd, { bigint: true });
      canonical = fs.realpathSync(capture.path);
    } catch (error) {
      throw pathBoundaryError('PGS scratch directory identity changed', error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== capture.path
        || !opened.isDirectory() || !sameIdentity(stat, capture.identity)
        || !sameIdentity(opened, capture.identity)) {
      throw pathBoundaryError('PGS scratch directory identity changed');
    }
  }
}

async function verifyScratchBoundary(boundary, { cleanup = false } = {}) {
  const authority = cleanup ? boundary.cleanupQuota : boundary.scratchQuota;
  if (!authority || typeof authority.assertOperationRoot !== 'function') {
    throw pathBoundaryError('PGS cleanup scratch authority is unavailable');
  }
  await authority.assertOperationRoot(boundary.operationRoot);
  verifyScratchBoundarySync(boundary);
  await authority.assertOperationRoot(boundary.operationRoot);
}

function closeScratchBoundary(boundary) {
  if (!boundary || boundary.closed) return;
  boundary.closed = true;
  for (const capture of [...boundary.directories].reverse()) {
    if (capture.fd === null) continue;
    try { fs.closeSync(capture.fd); } catch {}
    capture.fd = null;
  }
}

async function captureOperationScratchBoundary(scratchDir, scratchQuota) {
  assertNoFollowSupport();
  if (!scratchQuota || typeof scratchQuota !== 'object'
      || typeof scratchQuota.reconcile !== 'function'
      || typeof scratchQuota.assertOperationRoot !== 'function'
      || typeof scratchQuota.operationRoot !== 'string') {
    throw typed('invalid_request', 'PGS requires the operation scratch quota');
  }
  let operationRoot;
  try {
    operationRoot = await fsp.realpath(scratchQuota.operationRoot);
  } catch (error) {
    throw pathBoundaryError('PGS operation root is unavailable', error);
  }
  await scratchQuota.assertOperationRoot(operationRoot);
  const expectedScratch = path.join(operationRoot, 'scratch');
  let canonicalScratch;
  try {
    canonicalScratch = await fsp.realpath(scratchDir);
  } catch (error) {
    throw pathBoundaryError('PGS scratch directory is unavailable', error);
  }
  if (canonicalScratch !== expectedScratch || path.normalize(scratchDir) !== scratchDir) {
    throw pathBoundaryError('PGS scratch directory must be the exact operation scratch root');
  }
  const boundary = {
    operationRoot,
    scratch: expectedScratch,
    scratchQuota,
    cleanupQuota: null,
    directories: [],
    closed: false,
  };
  try {
    try {
      boundary.cleanupQuota = getOperationScratchQuotaCleanup(scratchQuota);
    } catch {}
    boundary.directories.push(await captureExactDirectory(operationRoot));
    boundary.directories.push(await captureExactDirectory(expectedScratch));
    await verifyScratchBoundary(boundary);
    return boundary;
  } catch (error) {
    closeScratchBoundary(boundary);
    throw error;
  }
}

async function ensureExactScratchChild(boundary, parentCapture, basename, { create = true } = {}) {
  if (!boundary || !parentCapture || typeof basename !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(basename)) {
    throw pathBoundaryError('PGS scratch child name is invalid');
  }
  await verifyScratchBoundary(boundary);
  const childPath = path.join(parentCapture.path, basename);
  let stat = await lstatOptional(childPath);
  let created = false;
  if (stat === null) {
    if (!create) return null;
    try {
      await fsp.mkdir(childPath, { recursive: false, mode: 0o700 });
      fs.fsyncSync(parentCapture.fd);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw pathBoundaryError('PGS scratch child cannot be created safely', error);
      }
    }
    stat = await lstatOptional(childPath);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw pathBoundaryError('PGS scratch child is not an exact nonsymlink directory');
  }
  const capture = await captureExactDirectory(childPath);
  capture.created = created;
  boundary.directories.push(capture);
  await verifyScratchBoundary(boundary);
  return capture;
}

function captureExactRegularFileSync(filePath, { create = false } = {}) {
  let fd = null;
  try {
    const flags = create
      ? fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    fd = fs.openSync(filePath, flags, 0o600);
    const opened = fs.fstatSync(fd, { bigint: true });
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (!opened.isFile() || !stat.isFile() || stat.isSymbolicLink()
        || opened.nlink !== 1n || stat.nlink !== 1n
        || !sameIdentity(opened, identityOf(stat))
        || fs.realpathSync(filePath) !== filePath) {
      throw pathBoundaryError('PGS database is not an exact private regular file');
    }
    return { path: filePath, identity: identityOf(opened), fd };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error?.code === 'invalid_request') throw error;
    throw pathBoundaryError('PGS database cannot be opened safely', error);
  }
}

function verifyExactRegularFileSync(capture) {
  let stat;
  let opened;
  let canonical;
  try {
    stat = fs.lstatSync(capture.path, { bigint: true });
    opened = fs.fstatSync(capture.fd, { bigint: true });
    canonical = fs.realpathSync(capture.path);
  } catch (error) {
    throw pathBoundaryError('PGS database identity changed', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || !opened.isFile() || opened.nlink !== 1n || canonical !== capture.path
      || !sameIdentity(stat, capture.identity) || !sameIdentity(opened, capture.identity)) {
    throw pathBoundaryError('PGS database identity changed');
  }
  return stat;
}

function closeRegularFileCapture(capture) {
  if (!capture || capture.fd === null) return;
  try { fs.closeSync(capture.fd); } catch {}
  capture.fd = null;
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
  let rows;
  try {
    rows = db.prepare(`
      SELECT
        substr(CAST(key AS BLOB), 1, 257) AS key_prefix,
        length(CAST(key AS BLOB)) AS key_bytes,
        substr(CAST(value AS BLOB), 1, ?) AS value_prefix,
        length(CAST(value AS BLOB)) AS value_bytes
      FROM metadata LIMIT ?
    `).all(MAX_METADATA_VALUE_BYTES + 1, METADATA_KEYS.length + 1);
  } catch (cause) {
    throw typed('pgs_projection_invalid', 'PGS projection metadata is unreadable', false, { cause });
  }
  if (rows.length !== METADATA_KEYS.length) {
    throw typed('pgs_projection_invalid', 'PGS projection metadata shape is invalid');
  }
  const result = {};
  try {
    for (const row of rows) {
      if (!Number.isSafeInteger(row.key_bytes) || row.key_bytes < 1 || row.key_bytes > 256
          || !Number.isSafeInteger(row.value_bytes) || row.value_bytes < 1
          || row.value_bytes > MAX_METADATA_VALUE_BYTES
          || !Buffer.isBuffer(row.key_prefix) || !Buffer.isBuffer(row.value_prefix)) {
        throw new Error('metadata field exceeds its bound');
      }
      const key = row.key_prefix.toString('utf8');
      if (Object.hasOwn(result, key)) throw new Error('duplicate metadata key');
      result[key] = JSON.parse(row.value_prefix.toString('utf8'));
    }
  } catch (cause) {
    throw typed('pgs_projection_invalid', 'PGS projection metadata is invalid', false, { cause });
  }
  if (Object.keys(result).sort().join('\0') !== METADATA_KEYS.join('\0')) {
    throw typed('pgs_projection_invalid', 'PGS projection metadata keys are invalid');
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
  if (!Number.isSafeInteger(actual.nodeCount) || actual.nodeCount < 0
      || !Number.isSafeInteger(actual.edgeCount) || actual.edgeCount < 0) return false;
  return JSON.stringify(actual.limits) === JSON.stringify(expected.limits);
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
  const descriptorDigest = sourceDescriptorDigest(sourcePin.descriptor);
  const component = `${descriptorDigest}-r${sourceRevision}`;
  const boundary = await captureOperationScratchBoundary(scratchDir, scratchQuota);
  const { scratch } = boundary;
  const scratchAnchor = boundary.directories.at(-1);
  let pgsAnchor;
  let projectionAnchor;
  try {
    await assertFreeSpace(scratch, limits.minFreeScratchBytes, statfsImpl);
    throwIfAborted(signal);
    pgsAnchor = await ensureExactScratchChild(boundary, scratchAnchor, 'pgs');
    projectionAnchor = await ensureExactScratchChild(boundary, pgsAnchor, component);
  } catch (error) {
    closeScratchBoundary(boundary);
    throw error;
  }
  const pgsRoot = pgsAnchor.path;
  const projectionRoot = projectionAnchor.path;
  const databasePath = path.join(projectionRoot, 'projection.sqlite');
  const Database = requireDatabase();
  const expectedBinding = bindingMetadata({ sourceRevision, descriptorDigest, limits, sweepPair });
  const scratchQuotaCleanup = getOperationScratchQuotaCleanup(scratchQuota);
  let db = null;
  let databaseAnchor = null;
  let abortListener = null;
  let reused = false;
  let projectionMayClean = projectionAnchor.created === true;
  let buildStats = { maxTransactionRecords: 0, maxTransactionBytes: 0, maxRetainedRecords: 0 };

  function closeDb({ closeAnchor = false } = {}) {
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    abortListener = null;
    if (db?.open) db.close();
    db = null;
    if (closeAnchor) {
      closeRegularFileCapture(databaseAnchor);
      databaseAnchor = null;
    }
  }

  function configureDb() {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('temp_store = MEMORY');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    abortListener = () => { try { db?.interrupt(); } catch {} };
    signal?.addEventListener('abort', abortListener, { once: true });
  }

  async function removeExactCapturedDirectory(capture, parentCapture) {
    await verifyScratchBoundary(boundary, { cleanup: true });
    const entries = await fsp.readdir(capture.path);
    for (const name of entries.sort()) {
      const target = path.join(capture.path, name);
      let fd = null;
      try {
        const before = await fsp.lstat(target, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
          throw pathBoundaryError('PGS cleanup found an unowned projection entry');
        }
        fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n
            || !sameIdentity(opened, identityOf(before))) {
          throw pathBoundaryError('PGS cleanup projection entry changed while opening');
        }
        const latest = await fsp.lstat(target, { bigint: true });
        if (!latest.isFile() || latest.isSymbolicLink() || latest.nlink !== 1n
            || !sameIdentity(latest, identityOf(before))) {
          throw pathBoundaryError('PGS cleanup projection entry identity changed');
        }
        await fsp.unlink(target);
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch {}
        }
      }
    }
    fs.fsyncSync(capture.fd);
    await verifyScratchBoundary(boundary, { cleanup: true });
    const index = boundary.directories.indexOf(capture);
    await fsp.rmdir(capture.path);
    closeRegularFileCapture(capture);
    if (index >= 0) boundary.directories.splice(index, 1);
    fs.fsyncSync(parentCapture.fd);
    await verifyScratchBoundary(boundary, { cleanup: true });
  }

  async function removeProjection({ recreate = false } = {}) {
    closeDb({ closeAnchor: true });
    await verifyScratchBoundary(boundary, { cleanup: true });
    if (projectionAnchor && !projectionAnchor.removed) {
      const quarantine = path.join(pgsRoot, `.remove-${component}-${crypto.randomUUID()}`);
      if (await lstatOptional(quarantine) !== null) {
        throw pathBoundaryError('PGS cleanup quarantine already exists');
      }
      await fsp.rename(projectionAnchor.path, quarantine);
      projectionAnchor.path = quarantine;
      await verifyScratchBoundary(boundary, { cleanup: true });
      await removeExactCapturedDirectory(projectionAnchor, pgsAnchor);
      projectionAnchor.removed = true;
    }
    if (recreate) {
      projectionAnchor = await ensureExactScratchChild(boundary, pgsAnchor, component);
      projectionMayClean = true;
    }
  }

  async function checkpoint({ cleanup = false } = {}) {
    if (!cleanup) throwIfAborted(signal);
    await verifyScratchBoundary(boundary, { cleanup });
    verifyExactRegularFileSync(databaseAnchor);
    db.pragma('wal_checkpoint(PASSIVE)');
    const bytes = await (cleanup ? scratchQuotaCleanup.reconcile() : scratchQuota.reconcile());
    await verifyScratchBoundary(boundary, { cleanup });
    verifyExactRegularFileSync(databaseAnchor);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxScratchBytes) {
      throw typed('result_too_large', 'PGS scratch quota exceeded');
    }
    await assertFreeSpace(scratch, limits.minFreeScratchBytes, statfsImpl);
    if (!cleanup) throwIfAborted(signal);
  }

  async function openAnchoredDatabase() {
    await verifyScratchBoundary(boundary);
    verifyExactRegularFileSync(databaseAnchor);
    db = new Database(databaseAnchor.path, { fileMustExist: true });
    verifyExactRegularFileSync(databaseAnchor);
    await verifyScratchBoundary(boundary);
  }

  async function publishNewDatabase() {
    db.pragma('wal_checkpoint(TRUNCATE)');
    closeDb();
    await verifyScratchBoundary(boundary);
    verifyExactRegularFileSync(databaseAnchor);
    if (await lstatOptional(databasePath) !== null) {
      throw pathBoundaryError('PGS database appeared before publication');
    }
    await fsp.rename(databaseAnchor.path, databasePath);
    databaseAnchor.path = databasePath;
    verifyExactRegularFileSync(databaseAnchor);
    fs.fsyncSync(projectionAnchor.fd);
    const readback = captureExactRegularFileSync(databasePath);
    try {
      if (!sameIdentity(
        { dev: readback.identity.dev, ino: readback.identity.ino },
        databaseAnchor.identity,
      )) {
        throw pathBoundaryError('PGS database readback identity changed');
      }
      verifyExactRegularFileSync(readback);
    } finally {
      closeRegularFileCapture(readback);
    }
    await openAnchoredDatabase();
    configureDb();
    await checkpoint();
  }

  try {
    const existingStat = await lstatOptional(databasePath);
    if (existingStat) {
      databaseAnchor = captureExactRegularFileSync(databasePath);
      projectionMayClean = true;
      let bindingMatches = false;
      try {
        await openAnchoredDatabase();
        bindingMatches = sameBinding(metadataObject(db), expectedBinding);
      } catch (error) {
        if (error?.code === 'invalid_request') throw error;
      }
      if (bindingMatches) {
        reused = true;
        projectionMayClean = false;
      } else {
        await removeProjection({ recreate: true });
      }
    }

    if (!reused) {
      projectionMayClean = true;
      const workingDatabasePath = path.join(
        projectionRoot,
        `.projection.sqlite.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      databaseAnchor = captureExactRegularFileSync(workingDatabasePath, { create: true });
      await openAnchoredDatabase();
      configureDb();
      const pageSize = db.pragma('page_size', { simple: true });
      db.pragma(`max_page_count = ${Math.max(1, Math.floor(limits.maxScratchBytes / pageSize))}`);
      createSchema(db);

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
      await publishNewDatabase();
    } else {
      configureDb();
      await checkpoint();
    }
  } catch (error) {
    const cancellation = signal?.aborted ? signal.reason : null;
    if (projectionMayClean) await removeProjection().catch(() => {});
    else closeDb({ closeAnchor: true });
    closeScratchBoundary(boundary);
    if (cancellation) throw cancellation;
    throw error;
  }

  const attemptSnapshots = new Map();
  let closed = false;
  function assertOpen() {
    if (closed || !db?.open) throw typed('pgs_store_closed', 'PGS store is closed');
    verifyScratchBoundarySync(boundary);
    verifyExactRegularFileSync(databaseAnchor);
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
      if (outputs.length > limits.maxSelectedWorkUnits) {
        throw typed('result_too_large', 'PGS sweep commit exceeds the selected-work limit');
      }
      const normalizedByWorkUnit = new Map();
      for (const row of outputs) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw typed('invalid_request', 'PGS sweep output is invalid');
        }
        const output = typeof row.output === 'string' ? row.output : '';
        const bytes = Buffer.byteLength(output, 'utf8');
        if (!output || bytes > limits.maxSweepOutputBytes) {
          throw typed('result_too_large', 'PGS sweep output exceeds the byte limit');
        }
        const prior = normalizedByWorkUnit.get(row.workUnitId);
        if (prior && prior.output !== output) {
          throw typed('pgs_state_conflict', 'PGS sweep output conflicts within the commit');
        }
        if (!prior) {
          const outputJson = canonicalJson({ output });
          normalizedByWorkUnit.set(row.workUnitId, {
            ...row,
            output,
            outputJson,
            outputJsonBytes: Buffer.byteLength(outputJson, 'utf8'),
          });
        }
      }
      const normalized = [...normalizedByWorkUnit.values()];
      const maximumOutputJsonBytes = (limits.maxSweepOutputBytes * 6)
        + Buffer.byteLength(JSON.stringify({ output: '' }), 'utf8');
      const getUnit = db.prepare('SELECT * FROM work_units WHERE work_unit_id = ?');
      const getSuccess = db.prepare(`
        SELECT provider, model,
          substr(CAST(output_json AS BLOB), 1, ?) AS output_json,
          length(CAST(output_json AS BLOB)) AS output_json_bytes
        FROM successful_sweeps WHERE work_unit_id = ?
      `);
      const existingOutputs = db.prepare(`
        SELECT substr(CAST(output_json AS BLOB), 1, ?) AS output_json,
          length(CAST(output_json AS BLOB)) AS output_json_bytes
        FROM successful_sweeps ORDER BY work_unit_id
      `);
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
        let durableOutputBytes = 0;
        for (const existing of existingOutputs.iterate(maximumOutputJsonBytes + 1)) {
          if (!Number.isSafeInteger(existing.output_json_bytes)
              || existing.output_json_bytes < 1
              || existing.output_json_bytes > maximumOutputJsonBytes
              || !Buffer.isBuffer(existing.output_json)) {
            throw typed('pgs_projection_invalid', 'Stored PGS sweep output exceeds its byte limit');
          }
          let parsed;
          try { parsed = JSON.parse(existing.output_json.toString('utf8')); } catch (cause) {
            throw typed('pgs_projection_invalid', 'Stored PGS sweep output is invalid', false, { cause });
          }
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
              || Object.keys(parsed).join('\0') !== 'output'
              || typeof parsed.output !== 'string' || !parsed.output) {
            throw typed('pgs_projection_invalid', 'Stored PGS sweep output is invalid');
          }
          const outputBytes = Buffer.byteLength(parsed.output, 'utf8');
          if (outputBytes > limits.maxSweepOutputBytes) {
            throw typed('pgs_projection_invalid', 'Stored PGS sweep output exceeds its byte limit');
          }
          durableOutputBytes += existing.output_json_bytes;
          if (durableOutputBytes > limits.maxTotalSweepOutputBytes) {
            throw typed('result_too_large', 'PGS sweep outputs exceed the aggregate byte limit');
          }
        }
        for (const row of normalized) {
          const unit = getUnit.get(row.workUnitId);
          if (!unit) throw typed('pgs_state_conflict', 'Unknown PGS work unit');
          const prior = getSuccess.get(maximumOutputJsonBytes + 1, row.workUnitId);
          if (prior) {
            if (!Number.isSafeInteger(prior.output_json_bytes)
                || prior.output_json_bytes < 1
                || prior.output_json_bytes > maximumOutputJsonBytes
                || !Buffer.isBuffer(prior.output_json)) {
              throw typed('pgs_projection_invalid', 'Stored PGS sweep output is invalid');
            }
            if (prior.provider !== sweepPair.provider || prior.model !== sweepPair.model
                || prior.output_json.toString('utf8') !== row.outputJson) {
              throw typed('pgs_state_conflict', 'PGS sweep output conflicts with durable state');
            }
            continue;
          }
          if (unit.state !== 'pending') {
            throw typed('pgs_state_conflict', 'PGS work unit is not pending');
          }
          durableOutputBytes += row.outputJsonBytes;
          if (durableOutputBytes > limits.maxTotalSweepOutputBytes) {
            throw typed('result_too_large', 'PGS sweep outputs exceed the aggregate byte limit');
          }
          insert.run(
            row.workUnitId, unit.partition_id, sweepPair.provider, sweepPair.model,
            row.outputJson, row.completedAt || new Date(clock.now()).toISOString(),
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
      const maximumOutputJsonBytes = (limits.maxSweepOutputBytes * 6)
        + Buffer.byteLength(JSON.stringify({ output: '' }), 'utf8');
      const rows = [];
      let totalOutputBytes = 0;
      let totalResultBytes = 2;
      const query = db.prepare(`
        SELECT
          substr(CAST(work_unit_id AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS work_unit_id,
          length(CAST(work_unit_id AS BLOB)) AS work_unit_id_bytes,
          substr(CAST(partition_id AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS partition_id,
          length(CAST(partition_id AS BLOB)) AS partition_id_bytes,
          substr(CAST(provider AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS provider,
          length(CAST(provider AS BLOB)) AS provider_bytes,
          substr(CAST(model AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS model,
          length(CAST(model AS BLOB)) AS model_bytes,
          substr(CAST(output_json AS BLOB), 1, ?) AS output_json,
          length(CAST(output_json AS BLOB)) AS output_json_bytes,
          substr(CAST(completed_at AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS completed_at,
          length(CAST(completed_at AS BLOB)) AS completed_at_bytes
        FROM successful_sweeps ORDER BY work_unit_id
      `);
      for (const row of query.iterate(maximumOutputJsonBytes + 1)) {
        for (const field of ['work_unit_id', 'partition_id', 'provider', 'model', 'completed_at']) {
          if (!Number.isSafeInteger(row[`${field}_bytes`]) || row[`${field}_bytes`] < 1
              || row[`${field}_bytes`] > MAX_LIST_SCALAR_BYTES
              || !Buffer.isBuffer(row[field])) {
            throw typed('pgs_projection_invalid', 'PGS sweep listing identity is invalid');
          }
        }
        if (!Number.isSafeInteger(row.output_json_bytes) || row.output_json_bytes < 1
            || row.output_json_bytes > maximumOutputJsonBytes
            || !Buffer.isBuffer(row.output_json)) {
          throw typed('result_too_large', 'PGS sweep output exceeds the byte limit');
        }
        let parsed;
        try { parsed = JSON.parse(row.output_json.toString('utf8')); } catch (cause) {
          throw typed('pgs_projection_invalid', 'PGS sweep output is invalid', false, { cause });
        }
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
            || Object.keys(parsed).join('\0') !== 'output'
            || typeof parsed.output !== 'string' || !parsed.output
            || Buffer.byteLength(parsed.output, 'utf8') > limits.maxSweepOutputBytes) {
          throw typed('pgs_projection_invalid', 'PGS sweep output is invalid');
        }
        totalOutputBytes += row.output_json_bytes;
        if (totalOutputBytes > limits.maxTotalSweepOutputBytes) {
          throw typed('result_too_large', 'PGS sweep outputs exceed the aggregate byte limit');
        }
        const normalized = {
          workUnitId: row.work_unit_id.toString('utf8'),
          partitionId: row.partition_id.toString('utf8'),
          provider: row.provider.toString('utf8'),
          model: row.model.toString('utf8'),
          output: parsed.output,
          completedAt: row.completed_at.toString('utf8'),
        };
        totalResultBytes += Buffer.byteLength(JSON.stringify(normalized), 'utf8') + 1;
        if (totalResultBytes > limits.maxResultBytes) {
          throw typed('result_too_large', 'PGS sweep listing exceeds the result byte limit');
        }
        rows.push(normalized);
      }
      return rows;
    },
    listRetryablePartitions() {
      assertOpen();
      const partitions = [];
      let totalResultBytes = 2;
      const query = db.prepare(`
        SELECT DISTINCT
          substr(CAST(partition_id AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS partition_id,
          length(CAST(partition_id AS BLOB)) AS partition_id_bytes
        FROM work_units
        WHERE state = 'pending' ORDER BY partition_id
      `);
      for (const row of query.iterate()) {
        if (!Number.isSafeInteger(row.partition_id_bytes) || row.partition_id_bytes < 1
            || row.partition_id_bytes > MAX_LIST_SCALAR_BYTES
            || !Buffer.isBuffer(row.partition_id)) {
          throw typed('pgs_projection_invalid', 'PGS retry partition identity is invalid');
        }
        const partitionId = row.partition_id.toString('utf8');
        totalResultBytes += Buffer.byteLength(JSON.stringify(partitionId), 'utf8') + 1;
        if (totalResultBytes > limits.maxResultBytes) {
          throw typed('result_too_large', 'PGS retry partitions exceed the result byte limit');
        }
        partitions.push(partitionId);
      }
      return partitions;
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
      closeRegularFileCapture(databaseAnchor);
      databaseAnchor = null;
      closeScratchBoundary(boundary);
    },
  };
  return Object.freeze(api);
}

module.exports = {
  captureOperationScratchBoundary,
  closeScratchBoundary,
  ensureExactScratchChild,
  lowerLimits,
  openPinnedPGSStore,
  partitionIdForNode,
  verifyScratchBoundary,
  verifyScratchBoundarySync,
};
