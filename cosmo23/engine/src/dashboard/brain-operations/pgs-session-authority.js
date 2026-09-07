'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const {
  canonicalJson,
} = require('../../../../shared/brain-operations/canonical-json.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
const MAX_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_LEASE_MS = 8 * 60 * 60 * 1000;
const MAX_LEASE_MS = DAY_MS;
const DEFAULT_MAX_SESSION_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024 * 1024;
const DEFAULT_JANITOR_INTERVAL_MS = 60 * 60 * 1000;
const MAX_JANITOR_INTERVAL_MS = DAY_MS;
const DEFAULT_CLEANUP_BATCH_SIZE = 32;
const MAX_CLEANUP_BATCH_SIZE = 256;
const MAX_AUTHORITY_BYTES = 512 * 1024;
const SESSION_ID_PATTERN = /^pgss_[A-Za-z0-9_-]{32}$/;
const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTHORITY_SUFFIX = '.authority.json';
const DATABASE_NAME = 'session.sqlite';
const LEASE_NAME = 'lease.json';
const DATABASE_FILES = Object.freeze([
  DATABASE_NAME,
  `${DATABASE_NAME}-wal`,
  `${DATABASE_NAME}-shm`,
  `${DATABASE_NAME}-journal`,
]);
const DATABASE_FILE_SET = new Set(DATABASE_FILES);
const serviceQueues = new Map();

async function withServiceQueue(key, task) {
  const previous = serviceQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  serviceQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (serviceQueues.get(key) === current) serviceQueues.delete(key);
  }
}

function sessionError(code, message = code, retryable = false, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function safeJanitorErrorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)) return code;
  return 'janitor_cleanup_failed';
}

function exactKeys(value, allowed, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw sessionError(code);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) throw sessionError(code);
  }
}

function assertIdentifier(value, code = 'invalid_request') {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) throw sessionError(code);
  return value;
}

function assertOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw sessionError('invalid_request');
  }
  return value;
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw sessionError('invalid_request');
  }
  return value;
}

function boundedInteger(value, fallback, maximum) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw sessionError('invalid_request');
  }
  return selected;
}

function cloneBinding(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw sessionError('invalid_request');
  }
  let canonical;
  try {
    canonical = canonicalJson(value);
  } catch (error) {
    throw sessionError('invalid_request', 'invalid PGS session binding', false, error);
  }
  if (Buffer.byteLength(canonical, 'utf8') > 256 * 1024) {
    throw sessionError('invalid_request', 'PGS session binding is too large');
  }
  return Object.freeze({
    value: JSON.parse(canonical),
    canonical,
    digest: crypto.createHash('sha256').update(canonical).digest('hex'),
  });
}

function opaqueSessionId() {
  return `pgss_${crypto.randomBytes(24).toString('base64url')}`;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function parseIso(value, code = 'session_state_invalid') {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw sessionError(code);
  }
  return milliseconds;
}

function identity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function identityMatches(stat, expected) {
  return expected && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
}

function persistentIdentity(value) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Reflect.ownKeys(value).length === 2
    && typeof value.dev === 'string' && /^[0-9]+$/.test(value.dev)
    && typeof value.ino === 'string' && /^[0-9]+$/.test(value.ino);
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

async function lstatOptional(filePath) {
  return fsp.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertCanonicalDirectory(directory, code, expectedIdentity) {
  if (typeof directory !== 'string' || directory.includes('\0')
      || path.resolve(directory) !== directory) throw sessionError(code);
  let stat;
  let real;
  try {
    [stat, real] = await Promise.all([fsp.lstat(directory), fsp.realpath(directory)]);
  } catch (error) {
    throw sessionError(code, code, false, error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory
      || (expectedIdentity && !identityMatches(stat, expectedIdentity))) {
    throw sessionError(code);
  }
  return stat;
}

async function openExactRegular(filePath, flags, code, expectedIdentity) {
  const before = await lstatOptional(filePath);
  if (!before) throw sessionError(code);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (expectedIdentity && !identityMatches(before, expectedIdentity))) {
    throw sessionError(code);
  }
  let handle;
  try {
    handle = await fsp.open(filePath, flags | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !identityMatches(opened, identity(before))) {
      throw sessionError(code);
    }
    return { handle, stat: opened, identity: identity(opened) };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === code) throw error;
    throw sessionError(code, code, false, error);
  }
}

async function readJsonRegular(filePath, maxBytes, code, expectedIdentity) {
  const opened = await openExactRegular(filePath, fs.constants.O_RDONLY, code, expectedIdentity);
  try {
    if (opened.stat.size > maxBytes) throw sessionError(code);
    const text = await opened.handle.readFile('utf8');
    const after = await opened.handle.stat();
    const namedAfter = await fsp.lstat(filePath);
    if (!identityMatches(after, opened.identity) || !identityMatches(namedAfter, opened.identity)
        || namedAfter.nlink !== 1 || namedAfter.isSymbolicLink()) throw sessionError(code);
    try {
      return { value: JSON.parse(text), identity: opened.identity, bytes: after.size };
    } catch (error) {
      throw sessionError(code, code, false, error);
    }
  } finally {
    await opened.handle.close();
  }
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonExclusive(filePath, value, code) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  let handle;
  try {
    handle = await fsp.open(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw sessionError(code);
    return identity(stat);
  } catch (error) {
    if (error?.code === code || error?.code === 'EEXIST') throw error;
    throw sessionError(code, code, false, error);
  } finally {
    await handle?.close();
  }
}

async function replaceJson(filePath, parent, value, code) {
  const temporary = path.join(parent, `.authority-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await writeJsonExclusive(temporary, value, code);
    await fsp.rename(temporary, filePath);
    await fsyncDirectory(parent);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateAnchor(raw, expected) {
  exactKeys(raw, [
    'version', 'sessionId', 'ownerAgent', 'createdAt', 'continuableUntil',
    'binding', 'bindingDigest', 'operationIds', 'directoryIdentity', 'databaseIdentity',
  ], 'session_state_invalid');
  if (raw.version !== 1 || raw.sessionId !== expected.sessionId
      || raw.ownerAgent !== expected.agentId || !SESSION_ID_PATTERN.test(raw.sessionId)
      || !/^[a-f0-9]{64}$/.test(raw.bindingDigest || '')
      || !Array.isArray(raw.operationIds) || raw.operationIds.length < 1
      || raw.operationIds.length > 4096 || new Set(raw.operationIds).size !== raw.operationIds.length
      || raw.operationIds.some((operationId) => !OPERATION_ID_PATTERN.test(operationId))
      || !persistentIdentity(raw.directoryIdentity)
      || !persistentIdentity(raw.databaseIdentity)) {
    throw sessionError('session_state_invalid');
  }
  parseIso(raw.createdAt);
  parseIso(raw.continuableUntil);
  const binding = cloneBinding(raw.binding);
  if (binding.digest !== raw.bindingDigest) throw sessionError('session_state_invalid');
  return { ...raw, bindingCanonical: binding.canonical };
}

function validateLease(raw, expected) {
  exactKeys(raw, [
    'version', 'sessionId', 'ownerAgent', 'operationId', 'leaseId', 'processId',
    'acquiredAt', 'expiresAt', 'quotaMaxBytes',
  ], 'session_state_invalid');
  if (raw.version !== 1 || raw.sessionId !== expected.sessionId
      || raw.ownerAgent !== expected.agentId || !OPERATION_ID_PATTERN.test(raw.operationId || '')
      || !/^[a-f0-9-]{36}$/.test(raw.leaseId || '')
      || !Number.isSafeInteger(raw.processId) || raw.processId <= 0
      || !Number.isSafeInteger(raw.quotaMaxBytes) || raw.quotaMaxBytes <= 0) {
    throw sessionError('session_state_invalid');
  }
  parseIso(raw.acquiredAt);
  parseIso(raw.expiresAt);
  return raw;
}

function workerHandleValue(raw, code = 'session_capability_invalid') {
  exactKeys(raw, [
    'version', 'sessionId', 'ownerAgent', 'operationId', 'sourceOperationId',
    'sessionRoot', 'databasePath', 'bindingDigest', 'continuableUntil', 'leaseId',
    'leaseExpiresAt', 'directoryIdentity', 'databaseIdentity', 'leaseIdentity',
    'maxSessionBytes', 'maxTotalBytes', 'quotaMaxBytes',
  ], code);
  if (raw.version !== 1 || !SESSION_ID_PATTERN.test(raw.sessionId || '')
      || !IDENTIFIER_PATTERN.test(raw.ownerAgent || '')
      || !OPERATION_ID_PATTERN.test(raw.operationId || '')
      || !(raw.sourceOperationId === null || OPERATION_ID_PATTERN.test(raw.sourceOperationId))
      || !/^[a-f0-9]{64}$/.test(raw.bindingDigest || '')
      || !/^[a-f0-9-]{36}$/.test(raw.leaseId || '')
      || !Number.isSafeInteger(raw.maxSessionBytes) || raw.maxSessionBytes <= 0
      || !Number.isSafeInteger(raw.maxTotalBytes) || raw.maxTotalBytes <= 0
      || !Number.isSafeInteger(raw.quotaMaxBytes) || raw.quotaMaxBytes <= 0
      || raw.quotaMaxBytes > raw.maxSessionBytes) {
    throw sessionError(code);
  }
  parseIso(raw.continuableUntil, code);
  parseIso(raw.leaseExpiresAt, code);
  return raw;
}

async function defaultIsProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return null;
  }
}

async function createPgsSessionAuthority(options) {
  exactKeys(options, [
    'agentRuntimeRoot', 'agentId', 'clock', 'retentionMs', 'leaseMs',
    'maxSessionBytes', 'maxTotalBytes', 'cleanupBatchSize', 'processId',
    'isProcessAlive', 'janitorIntervalMs', 'timers',
  ]);
  const agentRuntimeRoot = options.agentRuntimeRoot;
  const agentId = assertIdentifier(options.agentId);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw sessionError('invalid_request');
  const retentionMs = boundedInteger(options.retentionMs, DEFAULT_RETENTION_MS, MAX_RETENTION_MS);
  const leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, MAX_LEASE_MS);
  const maxSessionBytes = boundedInteger(
    options.maxSessionBytes,
    DEFAULT_MAX_SESSION_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  const cleanupBatchSize = boundedInteger(
    options.cleanupBatchSize,
    DEFAULT_CLEANUP_BATCH_SIZE,
    MAX_CLEANUP_BATCH_SIZE,
  );
  const janitorIntervalMs = boundedInteger(
    options.janitorIntervalMs,
    DEFAULT_JANITOR_INTERVAL_MS,
    MAX_JANITOR_INTERVAL_MS,
  );
  const processId = options.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) throw sessionError('invalid_request');
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const timers = options.timers ?? globalThis;
  if (typeof isProcessAlive !== 'function' || maxSessionBytes > maxTotalBytes
      || typeof timers.setInterval !== 'function'
      || typeof timers.clearInterval !== 'function') {
    throw sessionError('invalid_request');
  }

  const runtimeStat = await assertCanonicalDirectory(agentRuntimeRoot, 'session_root_invalid');
  const runtimeIdentity = identity(runtimeStat);
  const sessionsRoot = path.join(agentRuntimeRoot, 'pgs-sessions');
  try {
    await fsp.mkdir(sessionsRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw sessionError('session_root_invalid', undefined, false, error);
  }
  const sessionsStat = await assertCanonicalDirectory(sessionsRoot, 'session_root_invalid');
  const sessionsIdentity = identity(sessionsStat);
  const usableSessionIds = new Set();

  function now() {
    const value = clock();
    if (!Number.isFinite(value)) throw sessionError('session_clock_invalid');
    return value;
  }

  async function assertRoots() {
    await assertCanonicalDirectory(agentRuntimeRoot, 'session_root_invalid', runtimeIdentity);
    await assertCanonicalDirectory(sessionsRoot, 'session_root_invalid', sessionsIdentity);
  }

  function authorityPath(sessionId) {
    return path.join(sessionsRoot, `${sessionId}${AUTHORITY_SUFFIX}`);
  }

  function sessionPath(sessionId) {
    return path.join(sessionsRoot, sessionId);
  }

  async function readAnchor(sessionId) {
    await assertRoots();
    const anchorPath = authorityPath(sessionId);
    const anchorStat = await lstatOptional(anchorPath);
    if (!anchorStat) throw sessionError('session_not_found');
    const read = await readJsonRegular(anchorPath, MAX_AUTHORITY_BYTES, 'session_state_invalid');
    return {
      anchor: validateAnchor(read.value, { sessionId, agentId }),
      anchorPath,
      anchorIdentity: read.identity,
      anchorBytes: read.bytes,
    };
  }

  async function validateStorage(anchor) {
    await assertRoots();
    const sessionRoot = sessionPath(anchor.sessionId);
    await assertCanonicalDirectory(
      sessionRoot,
      'session_state_invalid',
      anchor.directoryIdentity,
    );
    const databasePath = path.join(sessionRoot, DATABASE_NAME);
    const database = await openExactRegular(
      databasePath,
      fs.constants.O_RDONLY,
      'session_state_invalid',
      anchor.databaseIdentity,
    );
    await database.handle.close();
    return { sessionRoot, databasePath };
  }

  async function listSessionIds() {
    await assertRoots();
    const entries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
    const sessionIds = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(AUTHORITY_SUFFIX)) continue;
      const sessionId = entry.name.slice(0, -AUTHORITY_SUFFIX.length);
      if (!SESSION_ID_PATTERN.test(sessionId)) throw sessionError('session_state_invalid');
      sessionIds.push(sessionId);
    }
    return sessionIds.sort();
  }

  async function reconcilePersistentDeviceIdentitiesUnsafe() {
    const repairs = [];
    let deviceMapping = null;
    for (const sessionId of await listSessionIds()) {
      const read = await readAnchor(sessionId);
      const sessionRoot = sessionPath(sessionId);
      const directoryStat = await assertCanonicalDirectory(sessionRoot, 'session_state_invalid');
      const currentDirectoryIdentity = identity(directoryStat);
      const databasePath = path.join(sessionRoot, DATABASE_NAME);
      const database = await openExactRegular(
        databasePath,
        fs.constants.O_RDONLY,
        'session_state_invalid',
      );
      await database.handle.close();
      const currentDatabaseIdentity = database.identity;
      const storedDirectoryIdentity = read.anchor.directoryIdentity;
      const storedDatabaseIdentity = read.anchor.databaseIdentity;
      if (sameIdentity(storedDirectoryIdentity, currentDirectoryIdentity)
          && sameIdentity(storedDatabaseIdentity, currentDatabaseIdentity)) continue;

      const consistentDeviceRenumbering = storedDirectoryIdentity.dev
          === storedDatabaseIdentity.dev
        && currentDirectoryIdentity.dev === currentDatabaseIdentity.dev
        && currentDirectoryIdentity.dev === sessionsIdentity.dev
        && storedDirectoryIdentity.dev !== currentDirectoryIdentity.dev
        && storedDirectoryIdentity.ino === currentDirectoryIdentity.ino
        && storedDatabaseIdentity.ino === currentDatabaseIdentity.ino;
      if (!consistentDeviceRenumbering) throw sessionError('session_state_invalid');
      const candidateMapping = `${storedDirectoryIdentity.dev}:${currentDirectoryIdentity.dev}`;
      if (deviceMapping !== null && deviceMapping !== candidateMapping) {
        throw sessionError('session_state_invalid');
      }
      deviceMapping = candidateMapping;
      repairs.push({
        read,
        sessionRoot,
        databasePath,
        currentDirectoryIdentity,
        currentDatabaseIdentity,
      });
    }

    for (const repair of repairs) {
      await assertCanonicalDirectory(
        repair.sessionRoot,
        'session_state_invalid',
        repair.currentDirectoryIdentity,
      );
      const database = await openExactRegular(
        repair.databasePath,
        fs.constants.O_RDONLY,
        'session_state_invalid',
        repair.currentDatabaseIdentity,
      );
      await database.handle.close();
      const anchorNamed = await fsp.lstat(repair.read.anchorPath);
      if (!anchorNamed.isFile() || anchorNamed.isSymbolicLink() || anchorNamed.nlink !== 1
          || !identityMatches(anchorNamed, repair.read.anchorIdentity)) {
        throw sessionError('session_state_invalid');
      }
      const { bindingCanonical, ...persistedAnchor } = repair.read.anchor;
      await replaceJson(repair.read.anchorPath, sessionsRoot, {
        ...persistedAnchor,
        directoryIdentity: repair.currentDirectoryIdentity,
        databaseIdentity: repair.currentDatabaseIdentity,
      }, 'session_state_invalid');
    }
    return repairs.length;
  }

  async function inspectDatabaseFiles(anchor) {
    const storage = await validateStorage(anchor);
    const entries = await fsp.readdir(storage.sessionRoot, { withFileTypes: true });
    const inspected = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!DATABASE_FILE_SET.has(entry.name) && entry.name !== LEASE_NAME) {
        throw sessionError('session_state_invalid');
      }
      const filePath = path.join(storage.sessionRoot, entry.name);
      const expectedIdentity = entry.name === DATABASE_NAME ? anchor.databaseIdentity : undefined;
      const opened = await openExactRegular(
        filePath,
        fs.constants.O_RDONLY,
        'session_state_invalid',
        expectedIdentity,
      );
      await opened.handle.close();
      inspected.push(Object.freeze({
        name: entry.name,
        path: filePath,
        identity: opened.identity,
        bytes: opened.stat.size,
      }));
      if (DATABASE_FILE_SET.has(entry.name)) bytes += opened.stat.size;
    }
    if (!inspected.some((entry) => entry.name === DATABASE_NAME)) {
      throw sessionError('session_state_invalid');
    }
    return Object.freeze({
      ...storage,
      bytes,
      files: Object.freeze(inspected),
    });
  }

  async function inspectHouseCapacity(excludedLeaseSessionId = null) {
    const sessions = [];
    let totalBytes = 0;
    let reservedGrowthBytes = 0;
    for (const sessionId of await listSessionIds()) {
      const { anchor } = await readAnchor(sessionId);
      const inspected = await inspectDatabaseFiles(anchor);
      totalBytes += inspected.bytes;
      let activeQuotaMaxBytes = null;
      const leaseFile = inspected.files.find((entry) => entry.name === LEASE_NAME);
      if (leaseFile) {
        const leaseRead = await readJsonRegular(
          leaseFile.path,
          MAX_AUTHORITY_BYTES,
          'session_state_invalid',
          leaseFile.identity,
        );
        const lease = validateLease(leaseRead.value, { sessionId, agentId });
        if (lease.quotaMaxBytes > maxSessionBytes) throw sessionError('session_state_invalid');
        const alive = await isProcessAlive(lease.processId);
        if (alive !== false) {
          activeQuotaMaxBytes = lease.quotaMaxBytes;
          if (sessionId !== excludedLeaseSessionId) {
            reservedGrowthBytes += Math.max(0, lease.quotaMaxBytes - inspected.bytes);
          }
        }
      }
      sessions.push(Object.freeze({
        sessionId,
        bytes: inspected.bytes,
        overQuota: inspected.bytes > maxSessionBytes,
        activeQuotaMaxBytes,
        continuableUntil: anchor.continuableUntil,
      }));
    }
    return Object.freeze({
      totalBytes,
      reservedGrowthBytes,
      sessions: Object.freeze(sessions),
    });
  }

  function quotaExceeded(snapshot, session) {
    const error = sessionError('session_quota_exceeded', undefined, false);
    error.sessionBytes = session?.bytes ?? null;
    error.totalBytes = snapshot.totalBytes;
    error.reservedGrowthBytes = snapshot.reservedGrowthBytes;
    error.maxSessionBytes = maxSessionBytes;
    error.maxTotalBytes = maxTotalBytes;
    return error;
  }

  async function reconcileQuotaUnsafe(input) {
    if (input !== undefined) throw sessionError('invalid_request');
    const snapshot = await inspectHouseCapacity();
    return Object.freeze({
      maxSessionBytes,
      maxTotalBytes,
      totalBytes: snapshot.totalBytes,
      sessions: Object.freeze(snapshot.sessions.map((session) => Object.freeze({
        sessionId: session.sessionId,
        bytes: session.bytes,
        overQuota: session.overQuota,
      }))),
    });
  }

  async function assertQuota(sessionId) {
    const quota = await reconcileQuotaUnsafe();
    const session = quota.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session || session.overQuota || quota.totalBytes > maxTotalBytes) {
      throw quotaExceeded({ totalBytes: quota.totalBytes, reservedGrowthBytes: 0 }, session);
    }
    return quota;
  }

  async function calculateWriterQuota(sessionId = null) {
    const snapshot = await inspectHouseCapacity(sessionId);
    const session = sessionId === null
      ? Object.freeze({ sessionId: null, bytes: 0, overQuota: false })
      : snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session || session.overQuota || snapshot.totalBytes > maxTotalBytes) {
      throw quotaExceeded(snapshot, session);
    }
    const availableGrowthBytes = maxTotalBytes
      - snapshot.totalBytes
      - snapshot.reservedGrowthBytes;
    const quotaMaxBytes = Math.min(
      maxSessionBytes,
      session.bytes + Math.max(0, availableGrowthBytes),
    );
    if (availableGrowthBytes <= 0 || quotaMaxBytes <= session.bytes) {
      throw quotaExceeded(snapshot, session);
    }
    return quotaMaxBytes;
  }

  async function assertActiveCapacity(handle) {
    const snapshot = await inspectHouseCapacity();
    const session = snapshot.sessions.find((candidate) => candidate.sessionId === handle.sessionId);
    if (!session || session.overQuota || session.bytes > handle.quotaMaxBytes
        || snapshot.totalBytes + snapshot.reservedGrowthBytes > maxTotalBytes
        || session.activeQuotaMaxBytes !== handle.quotaMaxBytes) {
      throw quotaExceeded(snapshot, session);
    }
    return Object.freeze({
      sessionId: session.sessionId,
      bytes: session.bytes,
      overQuota: session.overQuota,
    });
  }

  async function acquireLease(anchor, operationId, sourceOperationId, quotaMaxBytes) {
    const { sessionRoot, databasePath } = await validateStorage(anchor);
    const leasePath = path.join(sessionRoot, LEASE_NAME);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const timestamp = now();
      const lease = {
        version: 1,
        sessionId: anchor.sessionId,
        ownerAgent: agentId,
        operationId,
        leaseId: crypto.randomUUID(),
        processId,
        acquiredAt: iso(timestamp),
        expiresAt: iso(timestamp + leaseMs),
        quotaMaxBytes,
      };
      try {
        const leaseIdentity = await writeJsonExclusive(leasePath, lease, 'session_state_invalid');
        await fsyncDirectory(sessionRoot);
        return Object.freeze({
          version: 1,
          sessionId: anchor.sessionId,
          ownerAgent: agentId,
          operationId,
          sourceOperationId,
          sessionRoot,
          databasePath,
          bindingDigest: anchor.bindingDigest,
          continuableUntil: anchor.continuableUntil,
          leaseId: lease.leaseId,
          leaseExpiresAt: lease.expiresAt,
          directoryIdentity: Object.freeze({ ...anchor.directoryIdentity }),
          databaseIdentity: Object.freeze({ ...anchor.databaseIdentity }),
          leaseIdentity,
          maxSessionBytes,
          maxTotalBytes,
          quotaMaxBytes,
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const activeRead = await readJsonRegular(
          leasePath,
          MAX_AUTHORITY_BYTES,
          'session_state_invalid',
        );
        const active = validateLease(activeRead.value, { sessionId: anchor.sessionId, agentId });
        const alive = await isProcessAlive(active.processId);
        if (alive !== false) throw sessionError('session_conflict', undefined, true);
        const named = await fsp.lstat(leasePath);
        if (!identityMatches(named, activeRead.identity) || named.nlink !== 1
            || named.isSymbolicLink()) throw sessionError('session_state_invalid');
        await fsp.unlink(leasePath);
        await fsyncDirectory(sessionRoot);
      }
    }
    throw sessionError('session_conflict', undefined, true);
  }

  async function releaseLeaseUnsafe(workerHandle) {
    const handle = workerHandleValue(workerHandle);
    if (handle.ownerAgent !== agentId) throw sessionError('session_owner_mismatch');
    const { anchor } = await readAnchor(handle.sessionId);
    const storage = await validateStorage(anchor);
    if (handle.sessionRoot !== storage.sessionRoot || handle.databasePath !== storage.databasePath
        || handle.bindingDigest !== anchor.bindingDigest
        || !identityMatches({
          dev: handle.directoryIdentity.dev,
          ino: handle.directoryIdentity.ino,
        }, anchor.directoryIdentity)) throw sessionError('session_capability_invalid');
    const leasePath = path.join(storage.sessionRoot, LEASE_NAME);
    const leaseRead = await readJsonRegular(
      leasePath,
      MAX_AUTHORITY_BYTES,
      'session_lease_lost',
      handle.leaseIdentity,
    );
    const lease = validateLease(leaseRead.value, { sessionId: handle.sessionId, agentId });
    if (lease.leaseId !== handle.leaseId || lease.operationId !== handle.operationId
        || lease.quotaMaxBytes !== handle.quotaMaxBytes) {
      throw sessionError('session_lease_lost');
    }
    await fsp.unlink(leasePath);
    await fsyncDirectory(storage.sessionRoot);
    return Object.freeze({ released: true, sessionId: handle.sessionId });
  }

  async function removeExactSessionUnsafe(read, inspected) {
    await assertCanonicalDirectory(
      inspected.sessionRoot,
      'session_state_invalid',
      read.anchor.directoryIdentity,
    );
    for (const file of inspected.files) {
      const named = await fsp.lstat(file.path);
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
          || !identityMatches(named, file.identity)) {
        throw sessionError('session_state_invalid');
      }
    }
    const anchorNamed = await fsp.lstat(read.anchorPath);
    if (!anchorNamed.isFile() || anchorNamed.isSymbolicLink() || anchorNamed.nlink !== 1
        || !identityMatches(anchorNamed, read.anchorIdentity)) {
      throw sessionError('session_state_invalid');
    }

    for (const file of inspected.files) await fsp.unlink(file.path);
    await fsp.rmdir(inspected.sessionRoot);
    await fsp.unlink(read.anchorPath);
    await fsyncDirectory(sessionsRoot);
    return read.anchorBytes
      + inspected.files.reduce((total, file) => total + file.bytes, 0);
  }

  async function discardInitialSessionUnsafe(workerHandle) {
    const handle = workerHandleValue(workerHandle);
    if (handle.ownerAgent !== agentId) throw sessionError('session_owner_mismatch');
    if (handle.sourceOperationId !== null) throw sessionError('session_discard_denied');
    if (usableSessionIds.has(handle.sessionId)) throw sessionError('session_discard_denied');
    await validateWorkerHandle(handle, {
      ownerAgent: agentId,
      operationId: handle.operationId,
    });
    const read = await readAnchor(handle.sessionId);
    if (read.anchor.operationIds.length !== 1
        || read.anchor.operationIds[0] !== handle.operationId) {
      throw sessionError('session_discard_denied');
    }
    const inspected = await inspectDatabaseFiles(read.anchor);
    const reclaimedBytes = await removeExactSessionUnsafe(read, inspected);
    return Object.freeze({
      discarded: true,
      reclaimedBytes,
      sessionId: handle.sessionId,
    });
  }

  async function validateWorkerHandle(workerHandle, expected) {
    exactKeys(expected, ['ownerAgent', 'operationId'], 'session_capability_invalid');
    const handle = workerHandleValue(workerHandle);
    if (expected.ownerAgent !== agentId || handle.ownerAgent !== expected.ownerAgent) {
      throw sessionError('session_owner_mismatch');
    }
    assertOperationId(expected.operationId);
    if (handle.operationId !== expected.operationId) {
      throw sessionError('session_capability_invalid');
    }
    const { anchor } = await readAnchor(handle.sessionId);
    if (parseIso(anchor.continuableUntil) <= now()) throw sessionError('session_expired');
    const storage = await validateStorage(anchor);
    if (handle.sessionRoot !== storage.sessionRoot
        || handle.databasePath !== storage.databasePath
        || handle.bindingDigest !== anchor.bindingDigest
        || handle.continuableUntil !== anchor.continuableUntil
        || handle.maxSessionBytes !== maxSessionBytes
        || handle.maxTotalBytes !== maxTotalBytes
        || !sameIdentity(handle.directoryIdentity, anchor.directoryIdentity)
        || !sameIdentity(handle.databaseIdentity, anchor.databaseIdentity)
        || !anchor.operationIds.includes(handle.operationId)
        || (handle.sourceOperationId !== null
          && !anchor.operationIds.includes(handle.sourceOperationId))) {
      throw sessionError('session_capability_invalid');
    }
    const leasePath = path.join(storage.sessionRoot, LEASE_NAME);
    const leaseRead = await readJsonRegular(
      leasePath,
      MAX_AUTHORITY_BYTES,
      'session_lease_lost',
      handle.leaseIdentity,
    );
    const lease = validateLease(leaseRead.value, { sessionId: handle.sessionId, agentId });
    if (lease.leaseId !== handle.leaseId || lease.operationId !== handle.operationId
        || lease.expiresAt !== handle.leaseExpiresAt
        || lease.quotaMaxBytes !== handle.quotaMaxBytes
        || parseIso(lease.expiresAt) <= now()) {
      throw sessionError('session_lease_lost');
    }
    return Object.freeze({
      ...handle,
      directoryIdentity: Object.freeze({ ...handle.directoryIdentity }),
      databaseIdentity: Object.freeze({ ...handle.databaseIdentity }),
      leaseIdentity: Object.freeze({ ...handle.leaseIdentity }),
    });
  }

  async function openSessionStorage(workerHandle, expected) {
    const handle = await withServiceQueue(sessionsRoot, async () => {
      const validated = await validateWorkerHandle(workerHandle, expected);
      await assertActiveCapacity(validated);
      return validated;
    });
    let closed = false;
    let projectionUsable = handle.sourceOperationId !== null;
    function assertOpen() {
      if (closed) throw sessionError('session_capability_closed');
    }
    return Object.freeze({
      version: 1,
      sessionId: handle.sessionId,
      databasePath: handle.databasePath,
      quotaMaxBytes: handle.quotaMaxBytes,
      async verify() {
        assertOpen();
        return withServiceQueue(sessionsRoot, async () => {
          const validated = await validateWorkerHandle(handle, expected);
          await assertActiveCapacity(validated);
          return validated;
        });
      },
      async reconcileQuota() {
        assertOpen();
        return withServiceQueue(sessionsRoot, async () => {
          const validated = await validateWorkerHandle(handle, expected);
          return assertActiveCapacity(validated);
        });
      },
      async markProjectionUsable() {
        assertOpen();
        await withServiceQueue(sessionsRoot, async () => {
          const validated = await validateWorkerHandle(handle, expected);
          await assertActiveCapacity(validated);
          usableSessionIds.add(handle.sessionId);
        });
        projectionUsable = true;
        return Object.freeze({ marked: true, sessionId: handle.sessionId });
      },
      async close() {
        if (closed) return Object.freeze({ released: false, sessionId: handle.sessionId });
        const released = await withServiceQueue(sessionsRoot, () => (
          projectionUsable
            ? releaseLeaseUnsafe(handle)
            : discardInitialSessionUnsafe(handle)
        ));
        closed = true;
        return released;
      },
    });
  }

  async function rollbackNewSession(sessionRoot, anchorPath, expectedDirectoryIdentity) {
    const directoryStat = await lstatOptional(sessionRoot);
    if (directoryStat) {
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
          || !identityMatches(directoryStat, expectedDirectoryIdentity)) {
        throw sessionError('session_rollback_failed');
      }
      const entries = await fsp.readdir(sessionRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!DATABASE_FILE_SET.has(entry.name) && entry.name !== LEASE_NAME) {
          throw sessionError('session_rollback_failed');
        }
        const filePath = path.join(sessionRoot, entry.name);
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw sessionError('session_rollback_failed');
        }
      }
      for (const entry of entries) await fsp.unlink(path.join(sessionRoot, entry.name));
      await fsp.rmdir(sessionRoot);
    }
    const anchorStat = await lstatOptional(anchorPath);
    if (anchorStat) {
      if (!anchorStat.isFile() || anchorStat.isSymbolicLink() || anchorStat.nlink !== 1) {
        throw sessionError('session_rollback_failed');
      }
      await fsp.unlink(anchorPath);
    }
    await fsyncDirectory(sessionsRoot);
  }

  async function createSessionUnsafe(input) {
    exactKeys(input, ['ownerAgent', 'operationId', 'binding']);
    if (input.ownerAgent !== agentId) throw sessionError('session_owner_mismatch');
    assertOperationId(input.operationId);
    const normalizedBinding = cloneBinding(input.binding);
    await cleanupExpiredUnsafe();
    const timestamp = now();
    await assertRoots();
    const preCreationQuotaMaxBytes = await calculateWriterQuota();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sessionId = opaqueSessionId();
      const sessionRoot = sessionPath(sessionId);
      const anchorPath = authorityPath(sessionId);
      try {
        await fsp.mkdir(sessionRoot, { mode: 0o700 });
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw sessionError('session_create_failed', undefined, false, error);
      }
      let directoryIdentity = null;
      try {
        const directoryStat = await assertCanonicalDirectory(sessionRoot, 'session_create_failed');
        directoryIdentity = identity(directoryStat);
        const databasePath = path.join(sessionRoot, DATABASE_NAME);
        let database;
        try {
          database = await fsp.open(
            databasePath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
              | (fs.constants.O_NOFOLLOW || 0),
            0o600,
          );
          await database.sync();
          const databaseStat = await database.stat();
          if (!databaseStat.isFile() || databaseStat.nlink !== 1) {
            throw sessionError('session_create_failed');
          }
          const anchor = {
            version: 1,
            sessionId,
            ownerAgent: agentId,
            createdAt: iso(timestamp),
            continuableUntil: iso(timestamp + retentionMs),
            binding: normalizedBinding.value,
            bindingDigest: normalizedBinding.digest,
            operationIds: [input.operationId],
            directoryIdentity,
            databaseIdentity: identity(databaseStat),
          };
          await database.close();
          database = null;
          await writeJsonExclusive(anchorPath, anchor, 'session_create_failed');
          await fsyncDirectory(sessionsRoot);
          const quotaMaxBytes = Math.min(
            preCreationQuotaMaxBytes,
            await calculateWriterQuota(sessionId),
          );
          const workerHandle = await acquireLease(
            anchor,
            input.operationId,
            null,
            quotaMaxBytes,
          );
          return Object.freeze({
            sessionId,
            continuableUntil: anchor.continuableUntil,
            workerHandle,
          });
        } finally {
          await database?.close().catch(() => {});
        }
      } catch (error) {
        try {
          await rollbackNewSession(sessionRoot, anchorPath, directoryIdentity);
        } catch (rollbackError) {
          throw sessionError('session_rollback_failed', undefined, false, error || rollbackError);
        }
        throw error;
      }
    }
    throw sessionError('session_create_failed');
  }

  async function continueSessionUnsafe(input) {
    exactKeys(input, [
      'sessionId', 'ownerAgent', 'sourceOperationId', 'operationId', 'binding',
    ]);
    assertSessionId(input.sessionId);
    if (input.ownerAgent !== agentId) throw sessionError('session_owner_mismatch');
    assertOperationId(input.sourceOperationId);
    assertOperationId(input.operationId);
    const normalizedBinding = cloneBinding(input.binding);
    const { anchor, anchorPath } = await readAnchor(input.sessionId);
    if (parseIso(anchor.continuableUntil) <= now()) throw sessionError('session_expired');
    if (!anchor.operationIds.includes(input.sourceOperationId)) {
      throw sessionError('session_lineage_mismatch');
    }
    if (anchor.bindingDigest !== normalizedBinding.digest
        || anchor.bindingCanonical !== normalizedBinding.canonical) {
      throw sessionError('session_binding_mismatch');
    }
    if (anchor.operationIds.includes(input.operationId)) {
      throw sessionError('session_lineage_mismatch');
    }
    await cleanupExpiredUnsafe();
    const quotaMaxBytes = await calculateWriterQuota(anchor.sessionId);
    const workerHandle = await acquireLease(
      anchor,
      input.operationId,
      input.sourceOperationId,
      quotaMaxBytes,
    );
    const nextAnchor = {
      version: anchor.version,
      sessionId: anchor.sessionId,
      ownerAgent: anchor.ownerAgent,
      createdAt: anchor.createdAt,
      continuableUntil: anchor.continuableUntil,
      binding: anchor.binding,
      bindingDigest: anchor.bindingDigest,
      operationIds: [...anchor.operationIds, input.operationId],
      directoryIdentity: anchor.directoryIdentity,
      databaseIdentity: anchor.databaseIdentity,
    };
    try {
      await replaceJson(anchorPath, sessionsRoot, nextAnchor, 'session_state_invalid');
    } catch (error) {
      await releaseLeaseUnsafe(workerHandle).catch(() => {});
      throw error;
    }
    return Object.freeze({
      sessionId: anchor.sessionId,
      continuableUntil: anchor.continuableUntil,
      workerHandle,
    });
  }

  async function cleanupExpiredUnsafe(input) {
    if (input !== undefined) throw sessionError('invalid_request');
    const timestamp = now();
    const removedSessionIds = [];
    let reclaimedBytes = 0;
    let skippedActive = 0;
    for (const sessionId of await listSessionIds()) {
      if (removedSessionIds.length >= cleanupBatchSize) break;
      const read = await readAnchor(sessionId);
      if (parseIso(read.anchor.continuableUntil) > timestamp) continue;
      const inspected = await inspectDatabaseFiles(read.anchor);
      const leaseFile = inspected.files.find((entry) => entry.name === LEASE_NAME);
      if (leaseFile) {
        const leaseRead = await readJsonRegular(
          leaseFile.path,
          MAX_AUTHORITY_BYTES,
          'session_state_invalid',
          leaseFile.identity,
        );
        const lease = validateLease(leaseRead.value, { sessionId, agentId });
        const alive = await isProcessAlive(lease.processId);
        if (alive !== false) {
          skippedActive += 1;
          continue;
        }
      }

      const removedBytes = await removeExactSessionUnsafe(read, inspected);
      usableSessionIds.delete(sessionId);
      removedSessionIds.push(sessionId);
      reclaimedBytes += removedBytes;
    }
    return Object.freeze({
      removedSessions: removedSessionIds.length,
      removedSessionIds: Object.freeze(removedSessionIds),
      reclaimedBytes,
      skippedActive,
    });
  }

  const createSession = (input) => withServiceQueue(
    sessionsRoot,
    () => createSessionUnsafe(input),
  );
  const continueSession = (input) => withServiceQueue(
    sessionsRoot,
    () => continueSessionUnsafe(input),
  );
  const cleanupExpired = (input) => withServiceQueue(
    sessionsRoot,
    () => cleanupExpiredUnsafe(input),
  );
  const reconcileQuota = (input) => withServiceQueue(
    sessionsRoot,
    () => reconcileQuotaUnsafe(input),
  );
  const releaseLease = (workerHandle) => withServiceQueue(
    sessionsRoot,
    () => releaseLeaseUnsafe(workerHandle),
  );
  const discardUnusableSession = (workerHandle) => withServiceQueue(
    sessionsRoot,
    () => discardInitialSessionUnsafe(workerHandle),
  );

  let lastJanitorErrorCode = null;

  const storageStatus = (input) => withServiceQueue(sessionsRoot, async () => {
    if (input !== undefined) throw sessionError('invalid_request');
    const snapshot = await inspectHouseCapacity();
    const expiries = snapshot.sessions.map((session) => session.continuableUntil).sort();
    return Object.freeze({
      activeSessions: snapshot.sessions.filter(
        (session) => session.activeQuotaMaxBytes !== null,
      ).length,
      headroomBytes: Math.max(0, maxTotalBytes - snapshot.totalBytes),
      janitorHealthy: lastJanitorErrorCode === null,
      lastJanitorErrorCode,
      maxSessionBytes,
      maxTotalBytes,
      nextExpiry: expiries[0] ?? null,
      sessionCount: snapshot.sessions.length,
      totalBytes: snapshot.totalBytes,
    });
  });

  await reconcilePersistentDeviceIdentitiesUnsafe();
  await cleanupExpiredUnsafe();
  let janitorStopped = false;
  let janitorRun = Promise.resolve();
  const runJanitor = () => {
    if (janitorStopped) return janitorRun;
    janitorRun = janitorRun.then(
      () => cleanupExpired(),
      () => cleanupExpired(),
    ).then(
      (result) => {
        lastJanitorErrorCode = null;
        return result;
      },
      (error) => {
        lastJanitorErrorCode = safeJanitorErrorCode(error);
        return undefined;
      },
    );
    return janitorRun;
  };
  const janitorTimer = timers.setInterval(runJanitor, janitorIntervalMs);
  janitorTimer?.unref?.();

  const stop = async () => {
    if (!janitorStopped) {
      janitorStopped = true;
      timers.clearInterval(janitorTimer);
    }
    await janitorRun;
    if (lastJanitorErrorCode) throw sessionError(lastJanitorErrorCode);
    return Object.freeze({ stopped: true });
  };

  return Object.freeze({
    createSession,
    continueSession,
    cleanupExpired,
    openSessionStorage,
    reconcileQuota,
    releaseLease,
    discardUnusableSession,
    storageStatus,
    stop,
    validateWorkerHandle,
    cleanupBatchSize,
  });
}

module.exports = {
  DATABASE_NAME,
  LEASE_NAME,
  MAX_RETENTION_MS,
  SESSION_ID_PATTERN,
  createPgsSessionAuthority,
  sessionError,
};
