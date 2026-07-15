'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const { PGS_OPERATION_LIMITS } = require('../../lib/brain-operation-limits');
const { partitionIdForNode } = require('../../../shared/memory-source/pgs-partitions.cjs');
const {
  redactPrivatePaths,
  serializeProviderRecord,
} = require('../../lib/provider-record-sanitizer');
const {
  canonicalJson,
  createRetrievalAuthorityAccumulator,
  sourceDescriptorDigest,
} = require('../../../shared/memory-source/contracts.cjs');
const {
  projectMemoryAuthority,
} = require('../../../shared/memory-authority.cjs');
const {
  ATTESTATION_ENV,
} = require('../../../shared/memory-authority-attestation.cjs');
const {
  getOperationScratchQuotaCleanup,
} = require('../../../shared/memory-source/scratch-quota.cjs');

// Version 3 binds reusable sweeps to the exact query and scope policy, and
// gives every work unit a stable partition-stratified coverage ordinal.
const SCHEMA_VERSION = 3;
const AUTHORITY_PROJECTION_VERSION = 2;
const AUTHORITY_INTEGRITY_SCHEMA = 'home23.pgs-authority-projection-integrity.v1';
const QUERY_NORMALIZATION_VERSION = 1;
const SWEEP_PROMPT_CONTRACT_VERSION = 1;
const COVERAGE_SELECTION_POLICY_VERSION = 1;
const MAX_TARGET_PARTITIONS = 256;
const RETAINED_SCOPE_POLICY_ATTEMPT_ID = 'home23-retained-scope-policy-v1';
const COVERAGE_LEVELS = Object.freeze({
  skim: 0.1,
  sample: 0.25,
  deep: 0.5,
  full: 1,
});
const MAX_METADATA_VALUE_BYTES = 128 * 1024;
const MAX_LIST_SCALAR_BYTES = 4 * 1024;
const METADATA_KEYS = Object.freeze([
  'authorityProjectionVersion',
  'canonicalQuery',
  'completeProjection',
  'coverageSelectionPolicyVersion',
  'descriptorDigest',
  'edgeCount',
  'limits',
  'nodeCount',
  'pgsSweepModel',
  'pgsSweepProvider',
  'queryDigest',
  'queryNormalizationVersion',
  'schemaVersion',
  'sourceRevision',
  'sweepPromptContractVersion',
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
  return serializeProviderRecord(record, {
    maxBytes,
    label: `PGS ${kind} record`,
    redactPaths: true,
  });
}

function projectPinnedProviderAuthority(node) {
  const profile = projectMemoryAuthority(node, { limit: 2 });
  const sourceChain = profile.sourceChain.slice(0, 2).map((link) => {
    const kind = typeof link?.kind === 'string' ? link.kind : 'source';
    const ref = typeof link?.ref === 'string' ? link.ref : '';
    return { kind, ref: redactPrivatePaths(ref) };
  });
  return {
    retrievalDomain: profile.retrievalDomain,
    authorityClass: profile.authorityClass,
    semanticTime: profile.semanticTime,
    operationalAuthority: profile.authorityClass === 'verified_current_state',
    requiresFreshVerification: profile.requiresFreshVerification,
    sourceChain,
  };
}

function parsePinnedProviderAuthority(value) {
  let profile;
  try {
    profile = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (cause) {
    throw typed('pgs_projection_invalid', 'PGS node authority is invalid', false, { cause });
  }
  const keys = [
    'authorityClass', 'operationalAuthority', 'requiresFreshVerification',
    'retrievalDomain', 'semanticTime', 'sourceChain',
  ];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).sort().join('\0') !== keys.sort().join('\0')
      || !['current_ops', 'closed_incidents', 'project_history', 'external_intake']
        .includes(profile.retrievalDomain)
      || ![
        'verified_current_state', 'jtr_correction', 'artifact_log',
        'worker_receipt', 'generated_doctrine', 'narrative',
      ].includes(profile.authorityClass)
      || typeof profile.operationalAuthority !== 'boolean'
      || profile.operationalAuthority !== (profile.authorityClass === 'verified_current_state')
      || typeof profile.requiresFreshVerification !== 'boolean'
      || !(profile.semanticTime === null || (typeof profile.semanticTime === 'string'
        && Number.isFinite(Date.parse(profile.semanticTime))))
      || !Array.isArray(profile.sourceChain) || profile.sourceChain.length > 2) {
    throw typed('pgs_projection_invalid', 'PGS node authority is invalid');
  }
  for (const link of profile.sourceChain) {
    if (!link || typeof link !== 'object' || Array.isArray(link)
        || Object.keys(link).sort().join('\0') !== 'kind\0ref'
        || typeof link.kind !== 'string' || typeof link.ref !== 'string'
        || redactPrivatePaths(link.ref) !== link.ref) {
      throw typed('pgs_projection_invalid', 'PGS node authority is invalid');
    }
  }
  return profile;
}

function serializePinnedProviderAuthority(node) {
  const profile = projectPinnedProviderAuthority(node);
  parsePinnedProviderAuthority(profile);
  return JSON.stringify(profile);
}

function authorityIntegrityKey() {
  const key = process.env[ATTESTATION_ENV];
  return typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key) ? key : null;
}

function authorityIntegrityPayload({
  id,
  json,
  authorityJson,
  sourceRevision,
  descriptorDigest,
}) {
  return canonicalJson({
    schema: AUTHORITY_INTEGRITY_SCHEMA,
    authorityProjectionVersion: AUTHORITY_PROJECTION_VERSION,
    sourceRevision,
    descriptorDigest,
    nodeId: id,
    sanitizedNodeDigest: crypto.createHash('sha256').update(json).digest('hex'),
    authority: parsePinnedProviderAuthority(authorityJson),
  });
}

function signPinnedProviderAuthority(input) {
  const key = authorityIntegrityKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key)
    .update(authorityIntegrityPayload(input))
    .digest('base64url');
}

function readPinnedProviderAuthority({
  id,
  json,
  authorityJson,
  authorityMac,
  sourceRevision,
  descriptorDigest,
}) {
  const key = authorityIntegrityKey();
  if (!key || !authorityMac) {
    try {
      return projectPinnedProviderAuthority(JSON.parse(json));
    } catch (cause) {
      throw typed('pgs_projection_invalid', 'PGS node authority is invalid', false, { cause });
    }
  }
  const expected = signPinnedProviderAuthority({
    id, json, authorityJson, sourceRevision, descriptorDigest,
  });
  let suppliedBytes;
  let expectedBytes;
  try {
    suppliedBytes = Buffer.from(authorityMac || '', 'base64url');
    expectedBytes = Buffer.from(expected || '', 'base64url');
  } catch {}
  if (!authorityMac || !suppliedBytes || !expectedBytes
      || suppliedBytes.length !== 32 || expectedBytes.length !== suppliedBytes.length
      || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw typed('pgs_projection_invalid', 'PGS node authority integrity is invalid');
  }
  return parsePinnedProviderAuthority(authorityJson);
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
      json TEXT NOT NULL,
      authority_json TEXT NOT NULL,
      authority_mac TEXT
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
      partition_unit_index INTEGER NOT NULL CHECK(partition_unit_index >= 0),
      coverage_ordinal INTEGER UNIQUE,
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
    CREATE TABLE attempt_scopes (
      attempt_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('level','targeted')),
      coverage_level TEXT,
      coverage_fraction REAL,
      target_partition_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE attempt_scope_work_units (
      attempt_id TEXT NOT NULL,
      work_unit_id TEXT NOT NULL,
      PRIMARY KEY(attempt_id, work_unit_id),
      FOREIGN KEY(attempt_id) REFERENCES attempt_scopes(attempt_id),
      FOREIGN KEY(work_unit_id) REFERENCES work_units(work_unit_id)
    );
    CREATE INDEX attempt_scope_work_lookup
      ON attempt_scope_work_units(work_unit_id, attempt_id);
  `);
}

function compactAttemptScopes(db, { preserveAttemptIds = [] } = {}) {
  const rows = db.prepare(`
    SELECT attempt_id, scope_kind, coverage_level, coverage_fraction,
      target_partition_ids_json, created_at
    FROM attempt_scopes ORDER BY created_at, attempt_id
  `).iterate();
  const kinds = new Set();
  const targets = new Set();
  let coverageFraction = null;
  let createdAt = null;
  let rowCount = 0;
  for (const row of rows) {
    rowCount += 1;
    if (!['level', 'targeted'].includes(row.scope_kind)
        || !Object.hasOwn(COVERAGE_LEVELS, row.coverage_level)
        || COVERAGE_LEVELS[row.coverage_level] !== row.coverage_fraction
        || typeof row.created_at !== 'string' || !row.created_at) {
      throw typed('pgs_projection_invalid', 'PGS retained scope policy is invalid');
    }
    let rowTargets;
    try { rowTargets = JSON.parse(row.target_partition_ids_json); } catch { rowTargets = null; }
    if (!Array.isArray(rowTargets)
        || rowTargets.some(target => typeof target !== 'string' || !target)) {
      throw typed('pgs_projection_invalid', 'PGS retained target scope is invalid');
    }
    kinds.add(row.scope_kind);
    rowTargets.forEach(target => targets.add(target));
    coverageFraction = coverageFraction === null
      ? row.coverage_fraction
      : Math.max(coverageFraction, row.coverage_fraction);
    createdAt ||= row.created_at;
  }
  if (rowCount === 0) return;
  if (kinds.size !== 1 || targets.size > MAX_TARGET_PARTITIONS) {
    throw typed('pgs_projection_invalid', 'PGS retained scope policy is invalid');
  }
  const scopeKind = [...kinds][0];
  if ((scopeKind === 'level' && targets.size !== 0)
      || (scopeKind === 'targeted' && targets.size === 0)) {
    throw typed('pgs_projection_invalid', 'PGS retained scope policy is invalid');
  }
  const coverageLevel = Object.entries(COVERAGE_LEVELS)
    .find(([, fraction]) => fraction === coverageFraction)?.[0];
  if (!coverageLevel) {
    throw typed('pgs_projection_invalid', 'PGS retained coverage policy is invalid');
  }
  const retained = [...new Set(preserveAttemptIds)].filter(attemptId => (
    attemptId !== RETAINED_SCOPE_POLICY_ATTEMPT_ID
  ));
  const placeholders = retained.map(() => '?').join(',');
  const keepPredicate = placeholders
    ? `attempt_id = ? OR attempt_id IN (${placeholders})`
    : 'attempt_id = ?';
  const upsertPolicy = db.prepare(`
    INSERT INTO attempt_scopes(
      attempt_id, scope_kind, coverage_level, coverage_fraction,
      target_partition_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(attempt_id) DO UPDATE SET
      scope_kind = excluded.scope_kind,
      coverage_level = excluded.coverage_level,
      coverage_fraction = excluded.coverage_fraction,
      target_partition_ids_json = excluded.target_partition_ids_json
  `);
  db.transaction(() => {
    upsertPolicy.run(
      RETAINED_SCOPE_POLICY_ATTEMPT_ID,
      scopeKind,
      coverageLevel,
      coverageFraction,
      JSON.stringify([...targets].sort()),
      createdAt,
    );
    db.prepare(`
      INSERT OR IGNORE INTO attempt_scope_work_units(attempt_id, work_unit_id)
      SELECT ?, work_unit_id FROM attempt_scope_work_units
    `).run(RETAINED_SCOPE_POLICY_ATTEMPT_ID);
    db.prepare(`DELETE FROM attempt_scope_work_units WHERE NOT (${keepPredicate})`)
      .run(RETAINED_SCOPE_POLICY_ATTEMPT_ID, ...retained);
    db.prepare(`DELETE FROM attempt_scopes WHERE NOT (${keepPredicate})`)
      .run(RETAINED_SCOPE_POLICY_ATTEMPT_ID, ...retained);
  })();
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

function canonicalQueryBinding(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw typed('invalid_request', 'PGS query binding is required');
  }
  const bytes = Buffer.from(query, 'utf8');
  if (bytes.length > MAX_METADATA_VALUE_BYTES - 2) {
    throw typed('result_too_large', 'PGS query binding exceeds the metadata byte limit');
  }
  return Object.freeze({
    canonicalQuery: query,
    queryDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function bindingMetadata({
  sourceRevision,
  descriptorDigest,
  limits,
  sweepPair,
  query,
  queryNormalizationVersion,
  sweepPromptContractVersion,
  coverageSelectionPolicyVersion,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    authorityProjectionVersion: AUTHORITY_PROJECTION_VERSION,
    ...canonicalQueryBinding(query),
    queryNormalizationVersion,
    sweepPromptContractVersion,
    coverageSelectionPolicyVersion,
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
    'schemaVersion', 'authorityProjectionVersion',
    'sourceRevision', 'descriptorDigest', 'completeProjection',
    'pgsSweepProvider', 'pgsSweepModel', 'canonicalQuery', 'queryDigest',
    'queryNormalizationVersion', 'sweepPromptContractVersion',
    'coverageSelectionPolicyVersion',
  ]) {
    if (actual[key] !== expected[key]) return false;
  }
  if (!Number.isSafeInteger(actual.nodeCount) || actual.nodeCount < 0
      || !Number.isSafeInteger(actual.edgeCount) || actual.edgeCount < 0) return false;
  return JSON.stringify(actual.limits) === JSON.stringify(expected.limits);
}

async function migratePinnedAuthorityProjection(db, {
  signal,
  checkpoint,
  limits,
  sourceRevision,
  descriptorDigest,
}) {
  let version = null;
  const versionRow = db.prepare(
    "SELECT value FROM metadata WHERE key = 'authorityProjectionVersion'",
  ).get();
  if (versionRow) {
    try { version = JSON.parse(versionRow.value); } catch {}
    if (version !== AUTHORITY_PROJECTION_VERSION) {
      throw typed(
        'pgs_projection_invalid',
        `PGS authority projection v${String(version ?? 'unknown')} is unsupported`,
      );
    }
  }
  const columns = db.pragma('table_info(nodes)');
  const hasAuthorityColumn = columns.some(column => column.name === 'authority_json');
  const hasAuthorityMacColumn = columns.some(column => column.name === 'authority_mac');
  if (version === AUTHORITY_PROJECTION_VERSION) {
    if (!hasAuthorityColumn || !hasAuthorityMacColumn) {
      throw typed('pgs_projection_invalid', 'PGS authority projection columns are unavailable');
    }
    const missing = db.prepare(
      'SELECT COUNT(*) AS count FROM nodes WHERE authority_json IS NULL',
    ).get().count;
    if (missing !== 0) {
      throw typed('pgs_projection_invalid', 'PGS node authority projection is incomplete');
    }
    return;
  }
  try {
    db.transaction(() => {
      if (!hasAuthorityColumn) db.exec('ALTER TABLE nodes ADD COLUMN authority_json TEXT');
      if (!hasAuthorityMacColumn) db.exec('ALTER TABLE nodes ADD COLUMN authority_mac TEXT');
    })();
    await checkpoint();
    const update = db.prepare(
      'UPDATE nodes SET authority_json = ?, authority_mac = ? WHERE id = ?',
    );
    const scanLimit = Math.max(1, Math.min(
      limits.maxTransactionRecords,
      Math.floor(limits.maxTransactionBytes / limits.maxRecordBytes),
    ));
    let lastOrdinal = -1;
    while (true) {
      throwIfAborted(signal);
      const rows = db.prepare(
        'SELECT id, ordinal, json FROM nodes WHERE ordinal > ? ORDER BY ordinal LIMIT ?',
      ).all(lastOrdinal, scanLimit);
      if (!rows.length) break;
      db.transaction((page) => {
        for (const row of page) {
          const node = JSON.parse(row.json);
          // A v3 projection predating this column contains only provider-sanitized
          // records. Re-projecting those records deliberately fails closed to
          // narrative when sanitization invalidated an original attestation.
          const authorityJson = serializePinnedProviderAuthority(node);
          const authorityMac = signPinnedProviderAuthority({
            id: row.id,
            json: row.json,
            authorityJson,
            sourceRevision,
            descriptorDigest,
          });
          update.run(authorityJson, authorityMac, row.id);
        }
      })(rows);
      lastOrdinal = rows.at(-1).ordinal;
      await checkpoint();
    }
    db.prepare(
      'INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)',
    ).run('authorityProjectionVersion', JSON.stringify(AUTHORITY_PROJECTION_VERSION));
    await checkpoint();
  } catch (cause) {
    if (cause?.code === 'pgs_projection_invalid') throw cause;
    throw typed('pgs_projection_invalid', 'PGS authority projection migration failed', false, {
      cause,
    });
  }
}

async function openPinnedPGSStore({
  sourcePin,
  scratchDir,
  scratchQuota,
  sessionStorage,
  pgsSweep,
  query,
  queryNormalizationVersion = QUERY_NORMALIZATION_VERSION,
  sweepPromptContractVersion = SWEEP_PROMPT_CONTRACT_VERSION,
  coverageSelectionPolicyVersion = COVERAGE_SELECTION_POLICY_VERSION,
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
  if (!Number.isSafeInteger(queryNormalizationVersion) || queryNormalizationVersion <= 0
      || !Number.isSafeInteger(sweepPromptContractVersion) || sweepPromptContractVersion <= 0
      || !Number.isSafeInteger(coverageSelectionPolicyVersion)
      || coverageSelectionPolicyVersion <= 0) {
    throw typed('invalid_request', 'PGS binding contract version is invalid');
  }
  const limits = lowerLimits(limitOverrides);
  throwIfAborted(signal);
  const descriptorDigest = sourceDescriptorDigest(sourcePin.descriptor);
  const component = `${descriptorDigest}-r${sourceRevision}`;
  const usesSessionStorage = sessionStorage !== undefined;
  if (usesSessionStorage && (!sessionStorage || typeof sessionStorage !== 'object'
      || typeof sessionStorage.databasePath !== 'string'
      || path.resolve(sessionStorage.databasePath) !== sessionStorage.databasePath
      || !Number.isSafeInteger(sessionStorage.quotaMaxBytes)
      || sessionStorage.quotaMaxBytes <= 0
      || typeof sessionStorage.verify !== 'function'
      || typeof sessionStorage.reconcileQuota !== 'function'
      || typeof sessionStorage.markProjectionUsable !== 'function'
      || typeof sessionStorage.close !== 'function'
      || (sessionStorage.reuseOnly !== undefined
        && typeof sessionStorage.reuseOnly !== 'boolean'))) {
    throw typed('invalid_request', 'PGS session storage capability is invalid');
  }
  // HOME23 PATCH 62 — Continuations may reuse an exact complete projection,
  // but can never initialize or rebuild one from a later live source.
  const reuseOnly = usesSessionStorage && sessionStorage.reuseOnly === true;
  let boundary = null;
  let scratch;
  let scratchAnchor;
  let pgsAnchor;
  let projectionAnchor;
  let pgsRoot;
  let projectionRoot;
  let databasePath;
  // HOME23 PATCH 61 — A fresh durable session is not reusable until the full
  // pinned projection has passed every schema, binding, quota, and identity check.
  if (usesSessionStorage) {
    await sessionStorage.verify();
    await sessionStorage.reconcileQuota();
    databasePath = sessionStorage.databasePath;
    projectionRoot = path.dirname(databasePath);
    scratch = projectionRoot;
    await assertFreeSpace(projectionRoot, limits.minFreeScratchBytes, statfsImpl);
    await sessionStorage.verify();
  } else {
    boundary = await captureOperationScratchBoundary(scratchDir, scratchQuota);
    scratch = boundary.scratch;
    scratchAnchor = boundary.directories.at(-1);
    try {
      await assertFreeSpace(scratch, limits.minFreeScratchBytes, statfsImpl);
      throwIfAborted(signal);
      pgsAnchor = await ensureExactScratchChild(boundary, scratchAnchor, 'pgs');
      projectionAnchor = await ensureExactScratchChild(boundary, pgsAnchor, component);
    } catch (error) {
      closeScratchBoundary(boundary);
      throw error;
    }
    pgsRoot = pgsAnchor.path;
    projectionRoot = projectionAnchor.path;
    databasePath = path.join(projectionRoot, 'projection.sqlite');
  }
  const Database = requireDatabase();
  const expectedBinding = bindingMetadata({
    sourceRevision,
    descriptorDigest,
    limits,
    sweepPair,
    query,
    queryNormalizationVersion,
    sweepPromptContractVersion,
    coverageSelectionPolicyVersion,
  });
  const scratchQuotaCleanup = usesSessionStorage
    ? null
    : getOperationScratchQuotaCleanup(scratchQuota);
  let db = null;
  let databaseAnchor = null;
  let abortListener = null;
  let reused = false;
  let projectionMayClean = !usesSessionStorage && projectionAnchor.created === true;
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
    if (usesSessionStorage) {
      await sessionStorage.verify();
      await sessionStorage.reconcileQuota();
    } else {
      await verifyScratchBoundary(boundary, { cleanup });
    }
    verifyExactRegularFileSync(databaseAnchor);
    db.pragma('wal_checkpoint(PASSIVE)');
    const reconciled = usesSessionStorage
      ? await sessionStorage.reconcileQuota()
      : await (cleanup ? scratchQuotaCleanup.reconcile() : scratchQuota.reconcile());
    if (usesSessionStorage) await sessionStorage.verify();
    else await verifyScratchBoundary(boundary, { cleanup });
    verifyExactRegularFileSync(databaseAnchor);
    const bytes = usesSessionStorage ? reconciled?.bytes : reconciled;
    const quotaLimit = usesSessionStorage
      ? Math.min(limits.maxScratchBytes, sessionStorage.quotaMaxBytes)
      : limits.maxScratchBytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > quotaLimit) {
      throw typed(
        usesSessionStorage ? 'session_quota_exceeded' : 'result_too_large',
        usesSessionStorage ? 'PGS session quota exceeded' : 'PGS scratch quota exceeded',
      );
    }
    await assertFreeSpace(scratch, limits.minFreeScratchBytes, statfsImpl);
    if (!cleanup) throwIfAborted(signal);
  }

  async function openAnchoredDatabase() {
    if (usesSessionStorage) {
      await sessionStorage.verify();
      await sessionStorage.reconcileQuota();
    } else {
      await verifyScratchBoundary(boundary);
    }
    verifyExactRegularFileSync(databaseAnchor);
    db = new Database(databaseAnchor.path, { fileMustExist: true });
    verifyExactRegularFileSync(databaseAnchor);
    if (usesSessionStorage) {
      await sessionStorage.reconcileQuota();
      await sessionStorage.verify();
    } else {
      await verifyScratchBoundary(boundary);
    }
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
    if (usesSessionStorage && !existingStat) {
      throw typed('session_state_invalid', 'PGS session database is unavailable');
    }
    if (reuseOnly && existingStat.size === 0n) {
      throw typed('session_state_invalid', 'PGS continuation session projection is unavailable');
    }
    let freshSessionDatabase = false;
    if (existingStat) {
      databaseAnchor = captureExactRegularFileSync(databasePath);
      // An existing projection is durable caller state until validation proves
      // it must be replaced. Cancellation during validation or migration must
      // never delete completed sweep work.
      projectionMayClean = false;
      let bindingMatches = false;
      freshSessionDatabase = usesSessionStorage && existingStat.size === 0n;
      if (!freshSessionDatabase) {
        try {
          await openAnchoredDatabase();
          const schemaRow = db.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get();
          let storedSchemaVersion = null;
          try { storedSchemaVersion = JSON.parse(schemaRow?.value); } catch {}
          if (storedSchemaVersion !== SCHEMA_VERSION) {
            throw typed(
              'pgs_schema_unsupported',
              `PGS schema v${String(storedSchemaVersion ?? 'unknown')} is not reusable as v${SCHEMA_VERSION}`,
            );
          }
          await migratePinnedAuthorityProjection(db, {
            signal,
            checkpoint,
            limits,
            sourceRevision,
            descriptorDigest,
          });
          bindingMatches = sameBinding(metadataObject(db), expectedBinding);
          if (!bindingMatches) {
            throw typed('pgs_binding_mismatch', 'PGS session binding does not match this request');
          }
          compactAttemptScopes(db);
          await checkpoint();
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          if (usesSessionStorage) {
            if (['invalid_request', 'pgs_schema_unsupported', 'pgs_binding_mismatch']
              .includes(error?.code)) throw error;
            throw typed(
              'pgs_projection_invalid',
              'PGS session database is unreadable',
              false,
              { cause: error },
            );
          }
          if (['invalid_request', 'pgs_schema_unsupported', 'pgs_binding_mismatch']
            .includes(error?.code)) throw error;
        }
      }
      if (bindingMatches) {
        reused = true;
        projectionMayClean = false;
      } else if (!freshSessionDatabase) {
        await removeProjection({ recreate: true });
      }
    }

    if (reuseOnly && !reused) {
      throw typed('session_state_invalid', 'PGS continuation session projection is not reusable');
    }
    if (!reused) {
      if (usesSessionStorage) {
        projectionMayClean = false;
        if (!databaseAnchor) databaseAnchor = captureExactRegularFileSync(databasePath);
        await openAnchoredDatabase();
        configureDb();
      } else {
        projectionMayClean = true;
        const workingDatabasePath = path.join(
          projectionRoot,
          `.projection.sqlite.${process.pid}.${crypto.randomUUID()}.tmp`,
        );
        databaseAnchor = captureExactRegularFileSync(workingDatabasePath, { create: true });
        await openAnchoredDatabase();
        configureDb();
      }
      const pageSize = db.pragma('page_size', { simple: true });
      const databaseQuota = usesSessionStorage
        ? Math.min(limits.maxScratchBytes, sessionStorage.quotaMaxBytes)
        : limits.maxScratchBytes;
      db.pragma(`max_page_count = ${Math.max(1, Math.floor(databaseQuota / pageSize))}`);
      createSchema(db);

      const insertNode = db.prepare(
        `INSERT INTO nodes(
          id, partition_id, ordinal, json, authority_json, authority_mac
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertEdge = db.prepare(
        'INSERT INTO edges(ordinal, source, target, json) VALUES (?, ?, ?, ?)',
      );
      const nodeTransaction = db.transaction(rows => {
        for (const row of rows) insertNode.run(
          row.id, row.partitionId, row.ordinal, row.json, row.authorityJson,
          row.authorityMac,
        );
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
            ? (() => {
              const id = recordId(record, kind);
              const authorityJson = serializePinnedProviderAuthority(record);
              return {
                id,
                partitionId: partitionIdForNode(record, id),
                ordinal,
                json: serialized.json,
                authorityJson,
                authorityMac: signPinnedProviderAuthority({
                  id,
                  json: serialized.json,
                  authorityJson,
                  sourceRevision,
                  descriptorDigest,
                }),
              };
            })()
            : {
              ordinal,
              source: edgeEndpoint(record, 'source'),
              target: edgeEndpoint(record, 'target'),
              json: serialized.json,
            };
          const rowBytes = serialized.bytes
            + (kind === 'node' ? Buffer.byteLength(row.authorityJson, 'utf8') : 0)
            + (kind === 'node' && row.authorityMac
              ? Buffer.byteLength(row.authorityMac, 'utf8') : 0)
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
          work_unit_id, partition_id, partition_unit_index,
          first_ordinal, last_ordinal,
          node_count, context_chars, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `);
      const partitions = db.prepare(
        'SELECT DISTINCT partition_id FROM nodes ORDER BY partition_id',
      ).all();
      const workTransaction = db.transaction(rows => {
        for (const row of rows) insertWorkUnit.run(
          row.workUnitId, row.partitionId, row.partitionUnitIndex,
          row.firstOrdinal, row.lastOrdinal,
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
            SELECT id, ordinal, json, authority_json, authority_mac,
              length(CAST(json AS BLOB)) AS bytes,
              length(CAST(authority_json AS BLOB)) AS authority_bytes
            FROM nodes
            WHERE partition_id = ? AND ordinal > ?
            ORDER BY ordinal LIMIT ?
          `).all(partition.partition_id, lastOrdinal, limits.maxTransactionRecords);
          if (!page.length) break;
          for (const node of page) {
            readPinnedProviderAuthority({
              id: node.id,
              json: node.json,
              authorityJson: node.authority_json,
              authorityMac: node.authority_mac,
              sourceRevision,
              descriptorDigest,
            });
            const providerRecordBytes = node.bytes + node.authority_bytes;
            if (!Number.isSafeInteger(node.bytes) || node.bytes < 0
                || !Number.isSafeInteger(node.authority_bytes) || node.authority_bytes < 0
                || !Number.isSafeInteger(providerRecordBytes)
                || providerRecordBytes > limits.maxContextCharsPerWorkUnit) {
              throw typed(
                'result_too_large',
                'PGS source record cannot fit one work-unit context',
              );
            }
            const mustSplit = unit && (unit.nodeCount >= limits.maxNodesPerWorkUnit
              || unit.contextChars + providerRecordBytes > limits.maxContextCharsPerWorkUnit);
            if (mustSplit) {
              pendingRows.push(unit);
              unit = null;
            }
            if (!unit) {
              unit = {
                workUnitId: `p-${partition.partition_id}-u${String(unitIndex).padStart(4, '0')}`,
                partitionId: partition.partition_id,
                partitionUnitIndex: unitIndex,
                firstOrdinal: node.ordinal,
                lastOrdinal: node.ordinal,
                nodeCount: 0,
                contextChars: 0,
              };
              unitIndex += 1;
            }
            unit.lastOrdinal = node.ordinal;
            unit.nodeCount += 1;
            unit.contextChars += providerRecordBytes;
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

      const assignCoverageOrdinal = db.prepare(
        'UPDATE work_units SET coverage_ordinal = ? WHERE work_unit_id = ?',
      );
      const orderedWorkUnitPage = db.prepare(`
        SELECT work_unit_id, partition_id, partition_unit_index FROM work_units
        WHERE partition_unit_index > ?
          OR (partition_unit_index = ? AND partition_id > ?)
        ORDER BY partition_unit_index, partition_id
        LIMIT ?
      `);
      let coverageOrdinal = 0;
      let lastPartitionUnitIndex = -1;
      let lastPartitionId = '';
      while (true) {
        const rows = orderedWorkUnitPage.all(
          lastPartitionUnitIndex,
          lastPartitionUnitIndex,
          lastPartitionId,
          limits.maxTransactionRecords,
        );
        if (!rows.length) break;
        db.transaction((page) => {
          for (const row of page) {
            assignCoverageOrdinal.run(coverageOrdinal, row.work_unit_id);
            coverageOrdinal += 1;
          }
        })(rows);
        const last = rows.at(-1);
        lastPartitionUnitIndex = last.partition_unit_index;
        lastPartitionId = last.partition_id;
        await checkpoint();
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
      if (!usesSessionStorage) await publishNewDatabase();
    } else {
      configureDb();
      await checkpoint();
    }
  } catch (error) {
    const cancellation = signal?.aborted ? signal.reason : null;
    if (['pgs_schema_unsupported', 'pgs_binding_mismatch'].includes(error?.code)) {
      closeDb({ closeAnchor: true });
      closeScratchBoundary(boundary);
      throw error;
    }
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
    if (!usesSessionStorage) verifyScratchBoundarySync(boundary);
    verifyExactRegularFileSync(databaseAnchor);
  }

  function validateAttemptId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
      throw typed('invalid_request', 'PGS attempt ID is invalid');
    }
    if (value === RETAINED_SCOPE_POLICY_ATTEMPT_ID) {
      throw typed('invalid_request', 'PGS attempt ID is reserved');
    }
    return value;
  }

  function validateTargetPartitionIds(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGET_PARTITIONS) {
      throw typed('invalid_request', 'PGS target partition list is invalid');
    }
    const targets = value.map((partitionId) => {
      if (typeof partitionId !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(partitionId)) {
        throw typed('invalid_request', 'PGS target partition ID is invalid');
      }
      return partitionId;
    });
    if (new Set(targets).size !== targets.length) {
      throw typed('invalid_request', 'PGS target partition IDs must be unique');
    }
    targets.sort();
    const exists = db.prepare(
      'SELECT 1 AS present FROM work_units WHERE partition_id = ? LIMIT 1',
    );
    for (const partitionId of targets) {
      if (!exists.get(partitionId)) {
        throw typed('target_not_found', `PGS target partition does not exist: ${partitionId}`);
      }
    }
    return Object.freeze(targets);
  }

  function parseScopeRow(row) {
    if (!row) throw typed('pgs_scope_required', 'PGS attempt scope is not planned');
    let targetPartitionIds;
    try { targetPartitionIds = JSON.parse(row.target_partition_ids_json); } catch { targetPartitionIds = null; }
    if (!Array.isArray(targetPartitionIds)) {
      throw typed('pgs_projection_invalid', 'PGS attempt scope is invalid');
    }
    return {
      attemptId: row.attempt_id,
      scopeKind: row.scope_kind,
      coverageLevel: row.coverage_level,
      coverageFraction: row.coverage_fraction,
      targetPartitionIds,
    };
  }

  function scopeSummary(attemptId) {
    validateAttemptId(attemptId);
    const scope = parseScopeRow(
      db.prepare('SELECT * FROM attempt_scopes WHERE attempt_id = ?').get(attemptId),
    );
    const counts = db.prepare(`
      SELECT COUNT(*) AS scope_work_units,
        SUM(CASE WHEN w.state = 'complete' THEN 1 ELSE 0 END) AS scope_successful_work_units,
        SUM(CASE WHEN w.state = 'pending' THEN 1 ELSE 0 END) AS scope_pending_work_units
      FROM attempt_scope_work_units s
      JOIN work_units w ON w.work_unit_id = s.work_unit_id
      WHERE s.attempt_id = ?
    `).get(attemptId);
    const globalCoveredWorkUnits = db.prepare(
      "SELECT COUNT(*) AS count FROM work_units WHERE state = 'complete'",
    ).get().count;
    const globalPendingWorkUnits = db.prepare(
      "SELECT COUNT(*) AS count FROM work_units WHERE state = 'pending'",
    ).get().count;
    const scopeWorkUnits = counts.scope_work_units;
    const scopeSuccessfulWorkUnits = counts.scope_successful_work_units || 0;
    const scopePendingWorkUnits = counts.scope_pending_work_units || 0;
    return Object.freeze({
      ...scope,
      scopeWorkUnits,
      scopeSuccessfulWorkUnits,
      scopePendingWorkUnits,
      scopeComplete: scopeWorkUnits > 0 && scopePendingWorkUnits === 0,
      globalCoveredWorkUnits,
      globalPendingWorkUnits,
      fullCoverage: globalPendingWorkUnits === 0,
    });
  }

  function planScope({
    attemptId,
    coverageLevel,
    coverageFraction,
    targetPartitionIds,
  } = {}) {
    assertOpen();
    validateAttemptId(attemptId);
    const existing = db.prepare('SELECT * FROM attempt_scopes WHERE attempt_id = ?').get(attemptId);
    if (existing) return scopeSummary(attemptId);
    const targeted = targetPartitionIds !== undefined;
    let scopeKind;
    let normalizedLevel = null;
    let normalizedFraction = null;
    let targets = Object.freeze([]);
    if (targeted) {
      if (!Object.hasOwn(COVERAGE_LEVELS, coverageLevel)
          || COVERAGE_LEVELS[coverageLevel] !== coverageFraction) {
        throw typed('invalid_request', 'Targeted PGS coverage level and fraction do not match');
      }
      scopeKind = 'targeted';
      normalizedLevel = coverageLevel;
      normalizedFraction = coverageFraction;
      targets = validateTargetPartitionIds(targetPartitionIds);
    } else {
      if (!Object.hasOwn(COVERAGE_LEVELS, coverageLevel)
          || COVERAGE_LEVELS[coverageLevel] !== coverageFraction) {
        throw typed('invalid_request', 'PGS coverage level and fraction do not match');
      }
      scopeKind = 'level';
      normalizedLevel = coverageLevel;
      normalizedFraction = coverageFraction;
    }
    const priorKinds = db.prepare('SELECT DISTINCT scope_kind FROM attempt_scopes').all();
    if (priorKinds.some(row => row.scope_kind !== scopeKind)) {
      throw typed('pgs_scope_non_monotonic', 'PGS session scope kind cannot change');
    }
    if (scopeKind === 'level') {
      const prior = db.prepare(
        "SELECT MAX(coverage_fraction) AS fraction FROM attempt_scopes WHERE scope_kind = 'level'",
      ).get();
      if (typeof prior.fraction === 'number' && normalizedFraction < prior.fraction) {
        throw typed('pgs_scope_non_monotonic', 'PGS coverage level cannot shrink');
      }
    } else {
      const required = new Set();
      let priorFraction = null;
      for (const row of db.prepare(
        `SELECT target_partition_ids_json, coverage_fraction
         FROM attempt_scopes WHERE scope_kind = 'targeted'`,
      ).iterate()) {
        let prior;
        try { prior = JSON.parse(row.target_partition_ids_json); } catch { prior = null; }
        if (!Array.isArray(prior)) throw typed('pgs_projection_invalid', 'PGS target scope is invalid');
        prior.forEach(partitionId => required.add(partitionId));
        if (typeof row.coverage_fraction === 'number') {
          priorFraction = priorFraction === null
            ? row.coverage_fraction
            : Math.max(priorFraction, row.coverage_fraction);
        }
      }
      if ([...required].some(partitionId => !targets.includes(partitionId))) {
        throw typed('pgs_scope_non_monotonic', 'PGS target scope cannot remove prior targets');
      }
      if (priorFraction !== null && normalizedFraction < priorFraction) {
        throw typed('pgs_scope_non_monotonic', 'PGS targeted coverage level cannot shrink');
      }
    }
    const insertScope = db.prepare(`
      INSERT INTO attempt_scopes(
        attempt_id, scope_kind, coverage_level, coverage_fraction,
        target_partition_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const retainScopePolicy = db.prepare(`
      INSERT INTO attempt_scopes(
        attempt_id, scope_kind, coverage_level, coverage_fraction,
        target_partition_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        scope_kind = excluded.scope_kind,
        coverage_level = excluded.coverage_level,
        coverage_fraction = excluded.coverage_fraction,
        target_partition_ids_json = excluded.target_partition_ids_json
    `);
    db.transaction(() => {
      const createdAt = new Date(clock.now()).toISOString();
      insertScope.run(
        attemptId,
        scopeKind,
        normalizedLevel,
        normalizedFraction,
        JSON.stringify(targets),
        createdAt,
      );
      if (scopeKind === 'level') {
        const total = db.prepare('SELECT COUNT(*) AS count FROM work_units').get().count;
        const scopeCount = Math.ceil(total * normalizedFraction);
        db.prepare(`
          INSERT INTO attempt_scope_work_units(attempt_id, work_unit_id)
          SELECT ?, work_unit_id FROM work_units
          WHERE coverage_ordinal < ? ORDER BY coverage_ordinal
        `).run(attemptId, scopeCount);
      } else {
        const placeholders = targets.map(() => '?').join(',');
        const targetTotal = db.prepare(`
          SELECT COUNT(*) AS count FROM work_units
          WHERE partition_id IN (${placeholders})
        `).get(...targets).count;
        const scopeCount = Math.ceil(targetTotal * normalizedFraction);
        db.prepare(`
          INSERT INTO attempt_scope_work_units(attempt_id, work_unit_id)
          SELECT ?, work_unit_id FROM work_units
          WHERE partition_id IN (${placeholders}) ORDER BY coverage_ordinal LIMIT ?
        `).run(attemptId, ...targets, scopeCount);
        db.prepare(`
          INSERT OR IGNORE INTO attempt_scope_work_units(attempt_id, work_unit_id)
          SELECT ?, prior.work_unit_id
          FROM attempt_scope_work_units prior
          JOIN attempt_scopes attempts ON attempts.attempt_id = prior.attempt_id
          WHERE attempts.scope_kind = 'targeted' AND prior.attempt_id <> ?
        `).run(attemptId, attemptId);
      }
      retainScopePolicy.run(
        RETAINED_SCOPE_POLICY_ATTEMPT_ID,
        scopeKind,
        normalizedLevel,
        normalizedFraction,
        JSON.stringify(targets),
        createdAt,
      );
      db.prepare(`
        INSERT OR IGNORE INTO attempt_scope_work_units(attempt_id, work_unit_id)
        SELECT ?, work_unit_id FROM attempt_scope_work_units WHERE attempt_id = ?
      `).run(RETAINED_SCOPE_POLICY_ATTEMPT_ID, attemptId);
    })();
    return scopeSummary(attemptId);
  }

  function ensureAttemptScope(attemptId) {
    const row = db.prepare('SELECT 1 AS present FROM attempt_scopes WHERE attempt_id = ?').get(attemptId);
    if (!row) {
      planScope({ attemptId, coverageLevel: 'full', coverageFraction: 1 });
    }
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
    planScope,
    releaseAttemptScope(attemptId) {
      assertOpen();
      validateAttemptId(attemptId);
      const result = db.transaction(() => {
        db.prepare('DELETE FROM attempt_scope_work_units WHERE attempt_id = ?').run(attemptId);
        return db.prepare('DELETE FROM attempt_scopes WHERE attempt_id = ?').run(attemptId);
      })();
      attemptSnapshots.delete(attemptId);
      return result.changes === 1;
    },
    getScopeSummary(attemptId) {
      assertOpen();
      return scopeSummary(attemptId);
    },
    summarizeAuthority({ attemptId, signal: authoritySignal } = {}) {
      assertOpen();
      validateAttemptId(attemptId);
      ensureAttemptScope(attemptId);
      const accumulator = createRetrievalAuthorityAccumulator();
      try {
        const rows = db.prepare(`
          SELECT n.id, n.json, n.authority_json, n.authority_mac
          FROM attempt_scope_work_units scoped
          JOIN work_units work ON work.work_unit_id = scoped.work_unit_id
          JOIN nodes n ON n.partition_id = work.partition_id
            AND n.ordinal BETWEEN work.first_ordinal AND work.last_ordinal
          WHERE scoped.attempt_id = ?
          ORDER BY work.coverage_ordinal, n.ordinal
        `).iterate(attemptId);
        for (const row of rows) {
          throwIfAborted(authoritySignal);
          accumulator.add(readPinnedProviderAuthority({
            id: row.id,
            json: row.json,
            authorityJson: row.authority_json,
            authorityMac: row.authority_mac,
            sourceRevision,
            descriptorDigest,
          }));
        }
      } catch (cause) {
        if (authoritySignal?.aborted) throw authoritySignal.reason;
        if (cause?.code === 'pgs_projection_invalid') throw cause;
        throw typed('pgs_projection_invalid', 'PGS authority evidence is unreadable', false, {
          cause,
        });
      }
      return accumulator.snapshot();
    },
    summarizeScopeTotals({ attemptId, signal: totalsSignal } = {}) {
      assertOpen();
      validateAttemptId(attemptId);
      ensureAttemptScope(attemptId);
      throwIfAborted(totalsSignal);
      try {
        const nodes = db.prepare(`
          SELECT COALESCE(SUM(work.node_count), 0) AS count
          FROM attempt_scope_work_units scoped
          JOIN work_units work ON work.work_unit_id = scoped.work_unit_id
          WHERE scoped.attempt_id = ?
        `).get(attemptId).count;
        const edges = db.prepare(`
          WITH scoped_nodes AS (
            SELECT node.id
            FROM attempt_scope_work_units scoped
            JOIN work_units work ON work.work_unit_id = scoped.work_unit_id
            JOIN nodes node ON node.partition_id = work.partition_id
              AND node.ordinal BETWEEN work.first_ordinal AND work.last_ordinal
            WHERE scoped.attempt_id = ?
          )
          SELECT COUNT(*) AS count FROM (
            SELECT edge.ordinal
            FROM scoped_nodes node JOIN edges edge ON edge.source = node.id
            UNION
            SELECT edge.ordinal
            FROM scoped_nodes node JOIN edges edge ON edge.target = node.id
          )
        `).get(attemptId).count;
        throwIfAborted(totalsSignal);
        if (!Number.isSafeInteger(nodes) || nodes < 0
            || !Number.isSafeInteger(edges) || edges < 0) {
          throw typed('pgs_projection_invalid', 'PGS scoped totals are invalid');
        }
        return Object.freeze({ nodes, edges });
      } catch (cause) {
        if (totalsSignal?.aborted) throw totalsSignal.reason;
        if (cause?.code === 'pgs_projection_invalid') throw cause;
        throw typed('pgs_projection_invalid', 'PGS scoped totals are unreadable', false, {
          cause,
        });
      }
    },
    snapshotPendingWorkUnits({
      attemptId,
      limit = limits.maxSelectedWorkUnits,
      afterWorkUnitId,
    } = {}) {
      assertOpen();
      validateAttemptId(attemptId);
      ensureAttemptScope(attemptId);
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > limits.maxSelectedWorkUnits) {
        throw typed('invalid_request', 'PGS pending snapshot limit is invalid');
      }
      let afterCoverageOrdinal = -1;
      if (afterWorkUnitId !== undefined) {
        if (typeof afterWorkUnitId !== 'string' || !afterWorkUnitId) {
          throw typed('invalid_request', 'PGS pending snapshot cursor is invalid');
        }
        const cursor = db.prepare(
          'SELECT coverage_ordinal FROM work_units WHERE work_unit_id = ?',
        ).get(afterWorkUnitId);
        if (!cursor || !Number.isSafeInteger(cursor.coverage_ordinal)) {
          throw typed('invalid_request', 'PGS pending snapshot cursor is invalid');
        }
        afterCoverageOrdinal = cursor.coverage_ordinal;
      }
      if (attemptSnapshots.has(attemptId)) return [...attemptSnapshots.get(attemptId)];
      const ids = db.prepare(
        `SELECT w.work_unit_id FROM attempt_scope_work_units s
         JOIN work_units w ON w.work_unit_id = s.work_unit_id
         WHERE s.attempt_id = ? AND w.state = 'pending' AND w.coverage_ordinal > ?
         ORDER BY w.coverage_ordinal LIMIT ?`,
      ).all(attemptId, afterCoverageOrdinal, limit).map(row => row.work_unit_id);
      attemptSnapshots.set(attemptId, Object.freeze(ids));
      return [...ids];
    },
    loadWorkUnit(workUnitId, { signal: loadSignal } = {}) {
      assertOpen();
      throwIfAborted(loadSignal);
      const unit = db.prepare('SELECT * FROM work_units WHERE work_unit_id = ?').get(workUnitId);
      if (!unit) throw typed('target_not_found', 'PGS work unit does not exist');
      const rows = db.prepare(`
        SELECT id, json, authority_json, authority_mac FROM nodes
        WHERE partition_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal
      `).all(unit.partition_id, unit.first_ordinal, unit.last_ordinal);
      const nodes = rows.map(row => JSON.parse(row.json));
      const nodeAuthorities = rows.map(row => readPinnedProviderAuthority({
        id: row.id,
        json: row.json,
        authorityJson: row.authority_json,
        authorityMac: row.authority_mac,
        sourceRevision,
        descriptorDigest,
      }));
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
        nodeAuthorities,
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
    listSuccessfulSweeps({ attemptId } = {}) {
      assertOpen();
      if (attemptId !== undefined) {
        validateAttemptId(attemptId);
        ensureAttemptScope(attemptId);
      }
      const maximumOutputJsonBytes = (limits.maxSweepOutputBytes * 6)
        + Buffer.byteLength(JSON.stringify({ output: '' }), 'utf8');
      const rows = [];
      let totalOutputBytes = 0;
      let totalResultBytes = 2;
      const query = db.prepare(`
        SELECT
          substr(CAST(ss.work_unit_id AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS work_unit_id,
          length(CAST(ss.work_unit_id AS BLOB)) AS work_unit_id_bytes,
          substr(CAST(ss.partition_id AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS partition_id,
          length(CAST(ss.partition_id AS BLOB)) AS partition_id_bytes,
          substr(CAST(ss.provider AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS provider,
          length(CAST(ss.provider AS BLOB)) AS provider_bytes,
          substr(CAST(ss.model AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS model,
          length(CAST(ss.model AS BLOB)) AS model_bytes,
          substr(CAST(ss.output_json AS BLOB), 1, ?) AS output_json,
          length(CAST(ss.output_json AS BLOB)) AS output_json_bytes,
          substr(CAST(ss.completed_at AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS completed_at,
          length(CAST(ss.completed_at AS BLOB)) AS completed_at_bytes
        FROM successful_sweeps ss
        ${attemptId === undefined ? '' : `JOIN attempt_scope_work_units scope
          ON scope.work_unit_id = ss.work_unit_id AND scope.attempt_id = ?`}
        ORDER BY ss.work_unit_id
      `);
      const parameters = attemptId === undefined
        ? [maximumOutputJsonBytes + 1]
        : [maximumOutputJsonBytes + 1, attemptId];
      for (const row of query.iterate(...parameters)) {
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
    listRetryablePartitions({ attemptId } = {}) {
      assertOpen();
      if (attemptId !== undefined) {
        validateAttemptId(attemptId);
        ensureAttemptScope(attemptId);
      }
      const partitions = [];
      let totalResultBytes = 2;
      const query = db.prepare(`
        SELECT DISTINCT
          substr(CAST(w.partition_id AS BLOB), 1, ${MAX_LIST_SCALAR_BYTES + 1}) AS partition_id,
          length(CAST(w.partition_id AS BLOB)) AS partition_id_bytes
        FROM work_units w
        ${attemptId === undefined ? '' : `JOIN attempt_scope_work_units scope
          ON scope.work_unit_id = w.work_unit_id AND scope.attempt_id = ?`}
        WHERE w.state = 'pending' ORDER BY w.partition_id
      `);
      for (const row of query.iterate(...(attemptId === undefined ? [] : [attemptId]))) {
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
    countSuccessfulWorkUnits() {
      assertOpen();
      return db.prepare("SELECT COUNT(*) AS count FROM work_units WHERE state = 'complete'").get().count;
    },
    countScopeWorkUnits(attemptId) {
      assertOpen();
      return scopeSummary(attemptId).scopeWorkUnits;
    },
    countScopeSuccessfulWorkUnits(attemptId) {
      assertOpen();
      return scopeSummary(attemptId).scopeSuccessfulWorkUnits;
    },
    countScopePendingWorkUnits(attemptId) {
      assertOpen();
      return scopeSummary(attemptId).scopePendingWorkUnits;
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
      try {
        if (db?.open) {
          db.transaction(() => {
            db.prepare(
              'DELETE FROM attempt_scope_work_units WHERE attempt_id <> ?',
            ).run(RETAINED_SCOPE_POLICY_ATTEMPT_ID);
            db.prepare('DELETE FROM attempt_scopes WHERE attempt_id <> ?')
              .run(RETAINED_SCOPE_POLICY_ATTEMPT_ID);
          })();
          attemptSnapshots.clear();
          db.close();
        }
      } finally {
        db = null;
        try {
          closeRegularFileCapture(databaseAnchor);
        } finally {
          databaseAnchor = null;
          closeScratchBoundary(boundary);
        }
      }
    },
  };
  if (usesSessionStorage) {
    try {
      await sessionStorage.markProjectionUsable();
    } catch (error) {
      closeDb({ closeAnchor: true });
      throw error;
    }
  }
  return Object.freeze(api);
}

module.exports = {
  COVERAGE_LEVELS,
  COVERAGE_SELECTION_POLICY_VERSION,
  QUERY_NORMALIZATION_VERSION,
  SWEEP_PROMPT_CONTRACT_VERSION,
  captureOperationScratchBoundary,
  closeScratchBoundary,
  ensureExactScratchChild,
  lowerLimits,
  openPinnedPGSStore,
  partitionIdForNode,
  projectPinnedProviderAuthority,
  verifyScratchBoundary,
  verifyScratchBoundarySync,
};
